const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');
const { getFunctions: getAdminFunctions } = require('firebase-admin/functions');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { onDocumentCreated, onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onTaskDispatched } = require('firebase-functions/v2/tasks');
const { getMealDelta, mergeDeltaIntoDay, sanitizeDayEntry, computeStatsFromMeals, isMainSlot } = require('./mealStats.js');
const { checkSpam } = require('./spam-filter.js');
const momentPostV2 = require('./momentPostV2.js');
const mealPhotoVariantsBackfill = require('./mealPhotoVariantsBackfill.js');
const { logger } = require('firebase-functions');
const crypto = require('crypto');
const {
  shuffleIds,
  drawFromDeck,
  insertIntoDeckRemaining,
  rotationSlotDocId
} = require('./pushRotationDeck');
const sharp = require('sharp');

// Firebase Admin 초기화
initializeApp();
const db = getFirestore();
const auth = getAuth();

const APP_ID = 'mealog-r0';

/** 밀당 AI 코멘트(Gemini) — js/constants.js GEMINI_MEALDANG_MODEL 과 동기화 */
const GEMINI_MEALDANG_MODEL = 'gemini-2.5-flash';

/** settings 문서의 날짜 필드(Timestamp·ISO 문자열 등) → Date */
function adminSettingsValueToDate(value) {
  if (value == null || value === '') return null;
  try {
    if (value instanceof Timestamp) return value.toDate();
    if (typeof value.toDate === 'function') return value.toDate();
  } catch (_) {
    /* ignore */
  }
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 앱 공용 샘플 계정 — 클라이언트·Firestore 규칙과 동일 이메일 */
const READ_ONLY_DEMO_EMAIL = 'dummy@mealog.net';

function assertNotReadOnlyDemoAuth(auth) {
  const email =
    auth && auth.token && auth.token.email
      ? String(auth.token.email).toLowerCase().trim()
      : '';
  if (email === READ_ONLY_DEMO_EMAIL) {
    throw new HttpsError('permission-denied', '샘플 계정에서는 댓글을 작성할 수 없습니다.');
  }
}

// Functions 리전 설정 (us-central1로 변경 - 배포된 리전과 일치)
const REGION = 'us-central1';

/**
 * 카카오 장소 검색 전용 리전 — 서울.
 *
 * 이 함수는 한국 사용자가 부르고, 한국의 카카오 API 를 호출하고, 서울에 있는 Firestore 로
 * rate limit 을 확인한다. 그런데 함수만 미국에 있어서 **한 번 검색에 태평양을 다섯 번**
 * 건넜다(사용자→함수, 함수→Firestore 읽기·쓰기, 함수→카카오, 함수→사용자).
 * 실측 p50 이 1.3초, p95 가 2.7초였다.
 *
 * 나머지 함수는 아직 us-central1 에 있다. 여기서 효과를 확인하고 무거운 것부터 옮긴다.
 */
const REGION_SEOUL = 'asia-northeast3';

/**
 * 예약 푸시 태스크 — Cloud Tasks 로 「그 시각에 한 번」을 걸어 둔다.
 *
 * 태스크가 예정 시각보다 살짝 이르게 도착하는 것은 정상이라, 이만큼은 「지금」으로 친다.
 * 너무 크게 잡으면 방금 미뤄 둔 예약을 앞당겨 쏘게 되므로 좁게 둔다.
 */
const ADMIN_PUSH_TASK_EARLY_TOLERANCE_MS = 30 * 1000;

/** Cloud Tasks 가 받아 주는 예약 상한(30일)보다 안쪽. 이보다 먼 예약은 안전망 폴링에 맡긴다 */
const ADMIN_PUSH_TASK_MAX_LEAD_MS = 29 * 24 * 60 * 60 * 1000;

/**
 * 예약 한 건을 그 시각에 발송하도록 태스크를 건다.
 *
 * 실패해도 예약 자체는 pending 으로 남아 있고 안전망 폴링이 주워 가므로, 던지지 않고 로그만 남긴다.
 * 발송이 최대 10분 늦어질 뿐 유실되지는 않는다.
 *
 * @returns {Promise<boolean>} 태스크를 실제로 걸었는지
 */
async function enqueueAdminPushTask(docId, whenMs) {
  const id = String(docId || '').trim();
  if (!id || typeof whenMs !== 'number' || !Number.isFinite(whenMs)) return false;
  const leadMs = whenMs - Date.now();
  if (leadMs > ADMIN_PUSH_TASK_MAX_LEAD_MS) {
    logger.info('enqueueAdminPushTask: 너무 먼 예약이라 안전망에 맡깁니다', { docId: id, whenMs });
    return false;
  }
  try {
    const queue = getAdminFunctions().taskQueue(`locations/${REGION}/functions/deliverScheduledAdminPush`);
    await queue.enqueue(
      { docId: id },
      { scheduleTime: new Date(Math.max(whenMs, Date.now() + 1000)) }
    );
    return true;
  } catch (e) {
    logger.warn('enqueueAdminPushTask: 태스크 예약 실패 — 안전망 폴링이 처리합니다', {
      docId: id,
      whenMs,
      message: e?.message || String(e)
    });
    return false;
  }
}

/** 여러 건을 한꺼번에 건다. 실패한 건은 안전망이 맡으므로 개수만 돌려준다 */
async function enqueueAdminPushTasks(entries) {
  const results = await Promise.all(entries.map(({ docId, whenMs }) => enqueueAdminPushTask(docId, whenMs)));
  return results.filter(Boolean).length;
}

// API 키 (params: .env 또는 배포 시 입력)
const geminiApiKey = defineString('GEMINI_API_KEY');
const kakaoRestApiKey = defineString('KAKAO_REST_API_KEY');

// 레이트 리밋 설정 (사용자당)
const RATE_LIMITS = {
  post: { perMinute: 3, perHour: 20 },        // 게시글: 분당 3개, 시간당 20개
  feedPost: { perMinute: 8, perHour: 60 },    // 밀톡 피드(전용 컬렉션): 분당 8, 시간당 60
  comment: { perMinute: 10, perHour: 50 },    // 댓글: 분당 10개, 시간당 50개
  share: { perMinute: 5, perHour: 30 },       // 공유: 분당 5개, 시간당 30개
  report: { perMinute: 2, perHour: 10 },      // 신고: 분당 2개, 시간당 10개
  like: { perMinute: 30, perHour: 200 },      // 좋아요: 분당 30개, 시간당 200개
  interaction: { perMinute: 20, perHour: 100 }, // 상호작용: 분당 20개, 시간당 100개
  gemini: { perMinute: 5, perHour: 30 },      // 밀당 AI(Gemini) 프록시: 분당 5개, 시간당 30개
  kakaoSearch: { perMinute: 15, perHour: 100 } // 카카오 장소 검색 프록시: 분당 15개, 시간당 100개
};

// callGemini에서 허용하는 모델 (js/constants.js GEMINI_MEALDANG_MODEL과 동기화)
const GEMINI_ALLOWED_MODELS = ['gemini-2.5-flash'];
const GEMINI_ALLOWED_API_VERSION = 'v1beta';
const GEMINI_MAX_REQUEST_BODY_BYTES = 32 * 1024; // 32KB — 프롬프트+페르소나 여유 포함
const GEMINI_MAX_OUTPUT_TOKENS_CEILING = 1024; // 클라이언트 기본값(768)보다 여유만 둔 서버 상한

/**
 * 에러 리포팅 헬퍼 (Functions용)
 */
async function logErrorToFirestore(errorInfo, functionName) {
  try {
    const errorLogsColl = db.collection('artifacts').doc(APP_ID).collection('errorLogs');
    const sanitizedError = {
      message: errorInfo.message?.substring(0, 500) || 'Unknown error',
      type: 'cloud_function_error',
      functionName: functionName || 'unknown',
      errorCode: errorInfo.code || null,
      stack: errorInfo.stack?.substring(0, 2000) || null,
      userId: errorInfo.userId || null,
      timestamp: FieldValue.serverTimestamp()
    };
    await errorLogsColl.add(sanitizedError);
  } catch (e) {
    // 에러 로그 저장 실패는 무시 (무한 루프 방지)
    logger.error('에러 로그 저장 실패:', e);
  }
}

/**
 * 에러 핸들링 래퍼 (Functions용)
 */
function wrapFunction(functionName, handler) {
  return async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      // HttpsError는 그대로 전달 (이미 적절히 처리됨)
      if (error instanceof HttpsError) {
        throw error;
      }
      
      // 예상치 못한 에러는 로깅
      logger.error(`${functionName} 에러:`, {
        message: error.message,
        stack: error.stack,
        userId: request.auth?.uid || null
      });
      
      // 에러 리포팅
      await logErrorToFirestore({
        message: error.message,
        stack: error.stack,
        code: error.code,
        userId: request.auth?.uid || null
      }, functionName);
      
      // 사용자에게는 일반적인 에러 메시지 반환
      throw new HttpsError('internal', '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    }
  };
}

/**
 * 사용자 제재(금지) 여부 조회
 */
async function getUserBan(userId) {
  const banRef = db.collection('artifacts').doc(APP_ID).collection('userBans').doc(userId);
  const banSnap = await banRef.get();
  if (!banSnap.exists) return { bannedShare: false, bannedWrite: false };
  const d = banSnap.data();
  return {
    bannedShare: d.bannedShare === true,
    bannedWrite: d.bannedWrite === true
  };
}

/**
 * UID가 관리자인지 확인 (Firestore admins 컬렉션)
 */
async function isAdminByUid(uid) {
  if (!uid) return false;
  const adminRef = db.collection('artifacts').doc(APP_ID).collection('admins').doc(uid);
  const adminSnap = await adminRef.get();
  return adminSnap.exists && adminSnap.data().isAdmin === true;
}

/** FCM data 페이로드: Android는 모든 값이 문자열이어야 함 */
function fcmDataStrings(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out[String(k)] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

/** 사용자 설정 artifacts/.../config/settings 의 pushPreferences (클라이언트와 동일 키) */
const DEFAULT_PUSH_PREFS = {
  master: true,
  momentComment: true,
  boardComment: true,
  mealTalk: true,
  adminDefault: true
};

async function getUserPushPreferences(userId) {
  if (!userId) return { ...DEFAULT_PUSH_PREFS };
  try {
    const ref = db
      .collection('artifacts')
      .doc(APP_ID)
      .collection('users')
      .doc(userId)
      .collection('config')
      .doc('settings');
    const snap = await ref.get();
    const raw =
      snap.exists && snap.data().pushPreferences && typeof snap.data().pushPreferences === 'object'
        ? snap.data().pushPreferences
        : {};
    return {
      master: raw.master !== false,
      momentComment: raw.momentComment !== false,
      boardComment: raw.boardComment !== false,
      mealTalk: raw.mealTalk !== false,
      adminDefault: raw.adminDefault !== false
    };
  } catch (e) {
    logger.warn('getUserPushPreferences failed', { userId, message: e.message });
    return { ...DEFAULT_PUSH_PREFS };
  }
}

/**
 * @param {'momentComment'|'boardComment'|'mealTalk'|'adminDefault'} category
 */
function isPushCategoryAllowedByPrefs(prefs, category) {
  if (!prefs || prefs.master === false) return false;
  switch (category) {
    case 'momentComment':
      return prefs.momentComment !== false;
    case 'boardComment':
      return prefs.boardComment !== false;
    case 'mealTalk':
      return prefs.mealTalk !== false;
    case 'adminDefault':
      return prefs.adminDefault !== false;
    default:
      return true;
  }
}

/** fcmTokens 메타의 updatedAt → 밀리초 (없으면 0) */
function fcmTokenMetaUpdatedMs(meta) {
  if (!meta || typeof meta !== 'object') return 0;
  const u = meta.updatedAt;
  if (u && typeof u.toMillis === 'function') return u.toMillis();
  if (u && typeof u._seconds === 'number') {
    return u._seconds * 1000 + Math.floor((u._nanoseconds || 0) / 1e6);
  }
  if (u && typeof u.seconds === 'number') return u.seconds * 1000;
  return 0;
}

/** 토큰 등록 시 env별 최신 1개(+legacy)만 유지 — 재설치·재등록 잔여 토큰 누적 방지 */
function pruneUserFcmTokens(tokensMap, activeToken, activeEntry) {
  const merged = { ...(tokensMap && typeof tokensMap === 'object' ? tokensMap : {}), [activeToken]: activeEntry };
  const byEnvBest = new Map();
  for (const [tok, meta] of Object.entries(merged)) {
    const norm = String(tok || '').trim();
    if (!norm) continue;
    const env =
      meta?.env === 'staging' ? 'staging' : meta?.env === 'production' ? 'production' : 'legacy';
    const ms = fcmTokenMetaUpdatedMs(meta);
    const prev = byEnvBest.get(env);
    if (!prev || ms > prev.ms || (ms === prev.ms && tok === activeToken)) {
      byEnvBest.set(env, { tok, meta });
    }
  }
  const out = {};
  for (const { tok, meta } of byEnvBest.values()) {
    out[tok] = meta;
  }
  if (activeToken && !out[activeToken]) {
    out[activeToken] = activeEntry;
  }
  return out;
}

/**
 * 사용자당 FCM 1회만 — 가장 최근 등록 토큰 1개.
 * - staging+production 토큰 동시 보유, 재설치·재등록 잔여 토큰, 키 공백 차이 등으로 N통 나가던 문제 방지
 */
function pickSingleFcmToken(tokensMap, tokenStrings) {
  const bestByNorm = new Map();
  for (const token of tokenStrings) {
    const norm = String(token || '').trim();
    if (!norm) continue;
    const meta = tokensMap[token];
    const ms = fcmTokenMetaUpdatedMs(meta);
    const prev = bestByNorm.get(norm);
    if (!prev || ms >= prev.ms) {
      bestByNorm.set(norm, { token: norm, ms });
    }
  }
  let best = null;
  let bestMs = -1;
  for (const { token, ms } of bestByNorm.values()) {
    if (ms > bestMs) {
      bestMs = ms;
      best = token;
    } else if (ms === bestMs && best != null && token.localeCompare(best) < 0) {
      best = token;
    }
  }
  return best ? [best] : [];
}

/** 동일 알림이 Android/iOS에서 여러 줄로 쌓이지 않게 collapse 키 생성 */
function makePushCollapseId(payload, options = {}) {
  if (typeof options.collapseId === 'string' && options.collapseId.length > 0) {
    return options.collapseId.slice(0, 64);
  }
  if (typeof options.adminCollapseId === 'string' && options.adminCollapseId.length > 0) {
    return options.adminCollapseId.slice(0, 64);
  }
  if (options.adminBroadcast) {
    const envResolved =
      options.targetEnv === 'production' || options.targetEnv === 'staging' ? options.targetEnv : 'all';
    return makeAdminBroadcastCollapseId(payload, envResolved);
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const parts = [
    String(data.type || options.pushCategory || 'push'),
    data.postId,
    data.feedPostId,
    data.noticeId,
    data.landingTab,
    payload?.title,
    String(payload?.body || '').slice(0, 120)
  ]
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
}

const PUSH_SEND_DEDUPE_MS = 45 * 1000;

/** Callable 재시도·이중 트리거로 동일 수신자에게 같은 푸시가 짧은 시간에 2번 나가는 것 방지 */
async function pushSendDedupeShouldSkip(userId, dedupeKey) {
  if (!userId || !dedupeKey) return false;
  const docId = crypto.createHash('sha256').update(`${userId}|${dedupeKey}`).digest('hex').slice(0, 48);
  const ref = db.collection('artifacts').doc(APP_ID).collection('_pushSendDedupe').doc(docId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists) {
      const at = snap.data().at;
      const ms = at && typeof at.toMillis === 'function' ? at.toMillis() : 0;
      if (ms && now - ms < PUSH_SEND_DEDUPE_MS) return true;
    }
    tx.set(ref, { at: FieldValue.serverTimestamp(), userId }, { merge: true });
    return false;
  });
}

/**
 * 특정 사용자의 FCM 토큰들에 푸시 알림 전송 (실패 시 로그만, 호출자 대기 안 함)
 * @param {string} userId - 수신자 uid
 * @param {{ title: string, body: string, data?: object }} payload
 * @param {{ adminBroadcast?: boolean, pushCategory?: 'momentComment'|'boardComment'|'mealTalk'|'adminDefault', dedupeKey?: string }} options
 * @returns {Promise<boolean>} 최소 1건 FCM 전송 성공 시 true
 */
async function sendPushToUser(userId, payload, options = {}) {
  if (!userId || !payload?.title) return false;
  const pushCategory = options.pushCategory;
  if (pushCategory) {
    const prefs = await getUserPushPreferences(userId);
    if (!isPushCategoryAllowedByPrefs(prefs, pushCategory)) {
      logger.info('sendPushToUser: skipped by pushPreferences', { userId, pushCategory });
      return false;
    }
  }
  if (options.dedupeKey) {
    try {
      const skip = await pushSendDedupeShouldSkip(userId, options.dedupeKey);
      if (skip) {
        logger.info('sendPushToUser: dedupe skip', { userId, dedupeKey: options.dedupeKey });
        return false;
      }
    } catch (e) {
      logger.warn('sendPushToUser: dedupe check failed (proceeding)', { userId, message: e?.message });
    }
  }
  try {
    const ref = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('config').doc('fcmTokens');
    const snap = await ref.get();
    const tokensMap = (snap.exists && snap.data().tokens) || {};
    const allTokens = Object.keys(tokensMap);
    const envFilter = options.targetEnv === 'production' || options.targetEnv === 'staging'
      ? options.targetEnv
      : null;
    let tokens = envFilter
      ? allTokens.filter((token) => {
        const meta = tokensMap[token];
        if (!meta || typeof meta !== 'object') {
          return envFilter === 'production';
        }
        const tokenEnv = meta.env === 'staging' ? 'staging' : (meta.env === 'production' ? 'production' : null);
        // 하위 호환: env 미기록 기존 토큰은 운영으로 간주
        if (!tokenEnv) return envFilter === 'production';
        return tokenEnv === envFilter;
      })
      : allTokens;
    if (tokens.length > 0) {
      const before = tokens.length;
      tokens = pickSingleFcmToken(tokensMap, tokens);
      if (before > 1) {
        logger.info('sendPushToUser: single token selected', {
          userId,
          before,
          after: tokens.length,
          targetEnv: envFilter || 'all',
          adminBroadcast: !!options.adminBroadcast
        });
      }
    }
    if (tokens.length === 0) {
      logger.info('sendPushToUser: no FCM tokens for user', { userId, targetEnv: envFilter || 'all' });
      return false;
    }
    const messaging = getMessaging();
    const dataObj = { ...(payload.data && typeof payload.data === 'object' ? payload.data : {}) };
    if (options.adminBroadcast) {
      dataObj.suppressNumericBadge = '1';
    }
    const collapseId = makePushCollapseId(payload, options);
    const tagPrefix = options.adminBroadcast ? 'mealog_adm_' : 'mealog_';
    // Android 8+ 채널: 미지정 시 기기/OS별로 트레이 미표시 이슈가 있을 수 있어 FCM 기본 채널 명시
    const androidNotificationBase = {
      title: payload.title,
      body: payload.body || '',
      channelId: 'fcm_fallback_notification_channel',
      sound: 'default',
      // 상태바용 흰 실루엣 drawable (런처 컬러 아이콘 대신)
      icon: 'ic_stat_mealog',
      color: '#3CB889'
    };
    const androidNotification = {
      ...androidNotificationBase,
      tag: `${tagPrefix}${collapseId}`
    };
    if (options.adminBroadcast) {
      androidNotification.notificationCount = 0;
    }
    const message = {
      notification: { title: payload.title, body: payload.body || '' },
      data: fcmDataStrings(dataObj),
      android: {
        priority: 'high',
        notification: androidNotification
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-collapse-id': collapseId
        },
        payload: {
          aps: {
            sound: 'default'
          }
        }
      }
    };
    const results = await Promise.allSettled(
      tokens.map((token) => messaging.send({ ...message, token }))
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected');
    if (fulfilled === 0) {
      const firstReason = failed[0]?.reason?.message || String(failed[0]?.reason);
      logger.warn('sendPushToUser: all sends failed', {
        userId,
        total: tokens.length,
        firstReason
      });
      return false;
    }
    if (failed.length > 0) {
      const firstReason = failed[0]?.reason?.message || String(failed[0]?.reason);
      logger.warn('sendPushToUser: some sends failed', {
        userId,
        failed: failed.length,
        total: tokens.length,
        firstReason
      });
    } else {
      logger.info('sendPushToUser: ok', { userId, tokenCount: tokens.length, targetEnv: envFilter || 'all' });
    }
    return true;
  } catch (e) {
    logger.warn('sendPushToUser failed', { userId, message: e?.message });
    return false;
  }
}

/**
 * 레이트 리밋 체크
 */
async function checkRateLimit(userId, actionType, context) {
  const limits = RATE_LIMITS[actionType];
  if (!limits) {
    logger.warn(`Unknown action type: ${actionType}`);
    return; // 알 수 없는 타입은 통과
  }

  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const rateLimitRef = db.collection('artifacts').doc(APP_ID)
    .collection('rateLimits').doc(userId);

  const rateLimitDoc = await rateLimitRef.get();
  const rateLimitData = rateLimitDoc.exists ? rateLimitDoc.data() : {};

  const actionKey = `${actionType}_actions`;
  const actions = rateLimitData[actionKey] || [];

  // 오래된 기록 제거
  const recentActions = actions.filter(timestamp => {
    const ts = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return ts > oneHourAgo;
  });

  // 분당 제한 체크
  const minuteActions = recentActions.filter(timestamp => {
    const ts = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return ts > oneMinuteAgo;
  });

  if (minuteActions.length >= limits.perMinute) {
    throw new HttpsError(
      'resource-exhausted',
      `너무 빠르게 요청했습니다. ${limits.perMinute}분당 ${limits.perMinute}개까지만 가능합니다.`
    );
  }

  // 시간당 제한 체크
  if (recentActions.length >= limits.perHour) {
    throw new HttpsError(
      'resource-exhausted',
      `시간당 제한을 초과했습니다. ${limits.perHour}시간당 ${limits.perHour}개까지만 가능합니다.`
    );
  }

  // 새 액션 추가
  recentActions.push(now);
  await rateLimitRef.set({
    [actionKey]: recentActions,
    lastUpdated: FieldValue.serverTimestamp()
  }, { merge: true });
}

/**
 * 사용자 신고 중복 체크
 */
async function checkDuplicateReport(userId, targetGroupKey) {
  const userReportedRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(userId)
    .collection('config').doc('reportedPosts');

  const userReportedDoc = await userReportedRef.get();
  if (userReportedDoc.exists) {
    const data = userReportedDoc.data();
    if (data[targetGroupKey] && data[targetGroupKey].reportId) {
      throw new HttpsError(
        'already-exists',
        '이미 신고한 게시물입니다.'
      );
    }
  }
}

/**
 * 게시글 작성 (Callable)
 */
exports.createBoardPost = onCall({ region: REGION }, wrapFunction('createBoardPost', async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const ban = await getUserBan(auth.uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '글쓰기가 제한된 계정입니다.');
  }

  const { title, content, category, imageUrls } = data;
  const contentTrim = typeof content === 'string' ? content.trim() : '';
  if (!contentTrim) {
    throw new HttpsError('invalid-argument', '내용을 입력해주세요.');
  }
  const titleTrim = typeof title === 'string' ? title.trim() : '';

  const sanitizedImageUrls = Array.isArray(imageUrls) ? imageUrls.slice(0, 5).filter(u => typeof u === 'string' && u) : [];

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'post', request);

  // 스팸 필터링
  const spamCheck = checkSpam(`${titleTrim} ${contentTrim}`);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  // 사용자 프로필 정보 가져오기
  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const userSettingsDoc = await userSettingsRef.get();
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const authorNickname = profile.nickname || '익명';
  const authorPhotoUrl = profile.photoUrl || null;
  const authorIcon = profile.icon || null;

  // 게시글 생성
  const postsRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts');
  const newPost = {
    title: titleTrim,
    content: contentTrim,
    category: category || 'serious',
    imageUrls: sanitizedImageUrls,
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    likes: 0,
    dislikes: 0,
    views: 0,
    comments: 0,
    isHidden: false,
    timestamp: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  const docRef = await postsRef.add(newPost);
  
  return { id: docRef.id, ...newPost, timestamp: new Date().toISOString() };
}));

function feedOneLinePreview(text, maxLen = 80) {
  const s = String(text ?? '')
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** 게시판 푸시·알림용: 레거시 제목 우선, 없으면 본문 HTML 첫 줄(평문)을 한 줄로 */
function clipBoardNotificationLine(str, maxLen = 52) {
  const t = String(str ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 3))}...`;
}

function boardPostPushTitlePreview(postData, maxLen = 52) {
  const title = typeof postData?.title === 'string' ? postData.title.trim() : '';
  if (title) return clipBoardNotificationLine(title, maxLen) || '밀톡';
  const rawHtml = postData?.content != null ? String(postData.content) : '';
  if (!String(rawHtml).trim()) return '밀톡';
  const stripped = String(rawHtml)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  let firstLine = '';
  const lines = stripped.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].replace(/\s+/g, ' ').trim();
    if (s) {
      firstLine = s;
      break;
    }
  }
  if (!firstLine) firstLine = stripped.replace(/\s+/g, ' ').trim();
  return clipBoardNotificationLine(firstLine, maxLen) || '밀톡';
}

function extractFeedMentionNicknames(text) {
  const s = String(text ?? '');
  const re = /(^|[\s\n])@([^\s@]+)/g;
  const nicks = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    nicks.push(m[2]);
  }
  return [...new Set(nicks)];
}

function normalizeNicknameForClaim(nickname) {
  if (!nickname || typeof nickname !== 'string') return null;
  const t = nickname.trim();
  if (!t || t === '게스트') return null;
  try {
    return t.normalize('NFKC').toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

function nicknameClaimDocId(normalized) {
  if (!normalized) return '';
  const clipped = normalized.length > 200 ? normalized.slice(0, 200) : normalized;
  return encodeURIComponent(clipped);
}

async function resolveNicknameToUid(nickname) {
  const norm = normalizeNicknameForClaim(nickname);
  if (!norm) return null;
  const docId = nicknameClaimDocId(norm);
  const snap = await db.collection('artifacts').doc(APP_ID).collection('nicknameClaims').doc(docId).get();
  if (!snap.exists) return null;
  const uid = snap.data().userId;
  return uid && typeof uid === 'string' ? uid : null;
}

/**
 * 답장 대상·@언급 대상에게 알림 문서 + FCM (본인·중복 수신자는 한 번만)
 */
async function deliverFeedNotifications({ newPostId, senderId, authorNickname, plainText, parentAuthorId }) {
  const recipients = new Map();

  if (parentAuthorId && parentAuthorId !== senderId) {
    recipients.set(parentAuthorId, { reply: true, mention: false });
  }

  if (plainText) {
    const nicks = extractFeedMentionNicknames(plainText);
    const resolved = await Promise.all(nicks.map((nick) => resolveNicknameToUid(nick)));
    nicks.forEach((_, i) => {
      const uid = resolved[i];
      if (!uid || uid === senderId) return;
      const prev = recipients.get(uid) || { reply: false, mention: false };
      prev.mention = true;
      recipients.set(uid, prev);
    });
  }

  if (recipients.size === 0) return;

  const previewText =
    feedOneLinePreview(plainText, 80) || (plainText ? '' : '(사진)');
  const usersRoot = db.collection('artifacts').doc(APP_ID).collection('users');

  for (const [recipientId, flags] of recipients) {
    const kind =
      flags.reply && flags.mention ? 'reply_mention' : flags.reply ? 'reply' : 'mention';
    let body = '';
    if (kind === 'reply_mention') {
      body = `${authorNickname}님이 답장에서 당신을 언급했어요`;
    } else if (kind === 'reply') {
      body = `${authorNickname}님이 답장을 보냈어요`;
    } else {
      body = `${authorNickname}님이 당신을 언급했어요`;
    }

    try {
      await usersRoot.doc(recipientId).collection('feedNotifications').doc(newPostId).set({
        feedPostId: newPostId,
        kind,
        actorId: senderId,
        actorNickname: authorNickname,
        previewText,
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (e) {
      logger.warn('deliverFeedNotifications: firestore write failed', {
        recipientId,
        message: e.message
      });
    }

    try {
      await sendPushToUser(
        recipientId,
        {
          title: '밀톡',
          body,
          data: {
            type: 'feedActivity',
            feedPostId: newPostId,
            landingTab: 'board'
          }
        },
        {
          pushCategory: 'mealTalk',
          dedupeKey: `feedActivity:${recipientId}:${newPostId}:${kind}`
        }
      );
    } catch (e) {
      logger.warn('deliverFeedNotifications: push failed', { recipientId, message: e.message });
    }
  }
}

/**
 * 밀톡 피드 전용 메시지 (boardPosts와 분리 — 게시판 목록에 나오지 않음)
 */
exports.createFeedPost = onCall({ region: REGION }, wrapFunction('createFeedPost', async (request) => {
  const { auth, data } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const ban = await getUserBan(auth.uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '글쓰기가 제한된 계정입니다.');
  }

  const { text, imageUrls, replyToPostId } = data || {};
  const plain = typeof text === 'string' ? text.trim() : '';
  const sanitizedImageUrls = Array.isArray(imageUrls)
    ? imageUrls.slice(0, 5).filter((u) => typeof u === 'string' && u)
    : [];

  if (!plain && sanitizedImageUrls.length === 0) {
    throw new HttpsError('invalid-argument', '메시지 또는 사진을 입력해주세요.');
  }
  if (plain.length > 280) {
    throw new HttpsError('invalid-argument', '메시지는 280자 이하여야 합니다.');
  }

  await checkRateLimit(auth.uid, 'feedPost', request);

  if (plain) {
    const spamCheck = checkSpam(plain);
    if (spamCheck.isSpam) {
      throw new HttpsError('invalid-argument', spamCheck.reason);
    }
  }

  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const userSettingsDoc = await userSettingsRef.get();

  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const authorNickname = profile.nickname || '익명';
  const authorPhotoUrl = profile.photoUrl || null;
  const authorIcon = profile.icon || null;

  const postsRef = db.collection('artifacts').doc(APP_ID).collection('feedPosts');

  const rid = typeof replyToPostId === 'string' ? replyToPostId.trim() : '';
  let replyTo = null;
  let parentAuthorId = null;
  if (rid) {
    const parentSnap = await postsRef.doc(rid).get();
    if (parentSnap.exists) {
      const p = parentSnap.data() || {};
      if (p.isHidden !== true) {
        parentAuthorId = p.authorId || null;
        const pText = String(p.text || p.content || '').trim();
        const pHasImg = Array.isArray(p.imageUrls) && p.imageUrls.length > 0;
        let textPreview = feedOneLinePreview(pText, 80);
        if (!textPreview && pHasImg) textPreview = '(사진)';
        if (!textPreview) textPreview = '내용 없음';
        /* authorId 를 함께 남겨야 인용 박스도 작성자의 최신 닉네임으로 표시할 수 있다 */
        replyTo = {
          postId: rid,
          authorId: p.authorId || null,
          authorNickname: p.authorNickname || '익명',
          textPreview
        };
      }
    }
  }

  const newPost = {
    text: plain,
    content: plain,
    imageUrls: sanitizedImageUrls,
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    isHidden: false,
    timestamp: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  if (replyTo) {
    newPost.replyTo = replyTo;
  }

  const docRef = await postsRef.add(newPost);

  void deliverFeedNotifications({
    newPostId: docRef.id,
    senderId: auth.uid,
    authorNickname,
    plainText: plain,
    parentAuthorId
  }).catch((e) => logger.warn('deliverFeedNotifications', e));

  const nowIso = new Date().toISOString();
  const out = {
    id: docRef.id,
    text: plain,
    content: plain,
    imageUrls: sanitizedImageUrls,
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    isHidden: false,
    timestamp: nowIso,
    updatedAt: nowIso
  };
  if (replyTo) out.replyTo = replyTo;
  return out;
}));

/**
 * 게시글 수정 (Callable)
 */
exports.updateBoardPost = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { postId, title, content, category, imageUrls } = data;
  const contentTrim = typeof content === 'string' ? content.trim() : '';
  if (!postId || !contentTrim) {
    throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
  }
  const titleTrim = typeof title === 'string' ? title.trim() : '';

  // 게시글 존재 및 권한 확인
  const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
  const postDoc = await postRef.get();
  
  if (!postDoc.exists) {
    throw new HttpsError('not-found', '게시글을 찾을 수 없습니다.');
  }

  const postData = postDoc.data();
  if (postData.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 게시글만 수정할 수 있습니다.');
  }

  const sanitizedImageUrls = Array.isArray(imageUrls) ? imageUrls.slice(0, 5).filter(u => typeof u === 'string' && u) : (postData.imageUrls || []);

  // 스팸 필터링
  const spamCheck = checkSpam(`${titleTrim} ${contentTrim}`);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  // 게시글 업데이트
  await postRef.update({
    title: titleTrim,
    content: contentTrim,
    category: category || postData.category,
    imageUrls: sanitizedImageUrls,
    updatedAt: FieldValue.serverTimestamp()
  });

  return { success: true };
});

/**
 * 게시글 삭제 시 하위 데이터 정리 (댓글·좋아요·북마크 참조)
 * — 남겨두면 흔적 필터(getPostIdsCommentedByUser 등)에 삭제된 글 ID가 계속 잡힘
 */
async function deleteBoardPostRelatedDocuments(postId) {
  const pid = String(postId);
  const base = db.collection('artifacts').doc(APP_ID);
  const subcollections = [
    ['boardComments', 'postId'],
    ['boardInteractions', 'postId'],
    ['boardBookmarks', 'postId']
  ];
  for (const [collName, field] of subcollections) {
    const ref = base.collection(collName);
    const snap = await ref.where(field, '==', pid).get();
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
      const batch = db.batch();
      docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
}

/**
 * 게시글 삭제 (Callable)
 */
exports.deleteBoardPost = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { postId } = data;
  
  if (!postId) {
    throw new HttpsError('invalid-argument', '게시글 ID가 필요합니다.');
  }

  // 게시글 존재 및 권한 확인
  const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
  const postDoc = await postRef.get();
  
  if (!postDoc.exists) {
    throw new HttpsError('not-found', '게시글을 찾을 수 없습니다.');
  }

  const postData = postDoc.data();
  if (postData.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 게시글만 삭제할 수 있습니다.');
  }

  await deleteBoardPostRelatedDocuments(postId);
  await postRef.delete();
  
  return { success: true };
});

/**
 * 게시글 댓글 작성 (Callable)
 */
exports.addBoardComment = onCall({ region: REGION }, wrapFunction('addBoardComment', async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(auth);

  const ban = await getUserBan(auth.uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '댓글 작성이 제한된 계정입니다.');
  }

  const { postId, content, imageUrls } = data;
  const text = content != null ? String(content) : '';
  const imgs = Array.isArray(imageUrls) ? imageUrls.map((u) => String(u || '').trim()).filter(Boolean) : [];
  
  if (!postId || (!text.trim() && imgs.length === 0)) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }
  if (imgs.length > 3) {
    throw new HttpsError('invalid-argument', '댓글 이미지는 최대 3장까지 첨부할 수 있습니다.');
  }

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'comment', request);

  // 스팸 필터링 (텍스트가 있을 때만)
  if (text.trim()) {
    const spamCheck = checkSpam(text);
    if (spamCheck.isSpam) {
      throw new HttpsError('invalid-argument', spamCheck.reason);
    }
  }

  // 사용자 프로필 정보 가져오기
  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const userSettingsDoc = await userSettingsRef.get();
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const authorNickname = profile.nickname || '익명';
  const authorPhotoUrl = profile.photoUrl || null;
  const authorIcon = profile.icon || null;

  // 게시글 조회 (댓글 수 증가 + 알림용 postAuthorId)
  const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
  const postDoc = await postRef.get();
  const postData = postDoc.exists ? postDoc.data() : {};
  const postAuthorId = (postData.authorId && String(postData.authorId).trim())
    || (postData.userId && String(postData.userId).trim())
    || '';

  if (!postAuthorId && postDoc.exists) {
    logger.warn('addBoardComment: 게시글에 authorId/userId 없음 → 푸시 생략 가능', { postId: String(postId) });
  }

  // 댓글 생성 (postAuthorId: 알림에서 "내 글에 달린 댓글"만 쿼리할 때 사용)
  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('boardComments');
  const newComment = {
    postId: String(postId),
    postAuthorId: postAuthorId || null,
    content: text.trim(),
    imageUrls: imgs,
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    timestamp: FieldValue.serverTimestamp()
  };

  const docRef = await commentsRef.add(newComment);

  if (postDoc.exists) {
    await postRef.update({
      comments: FieldValue.increment(1)
    });
  }

  if (postAuthorId && postAuthorId !== auth.uid) {
    const previewTitle = boardPostPushTitlePreview(postData, 52);
    // 반드시 await: onCall 반환 후 인스턴스가 멈추면 미완료 Promise가 끊겨 푸시가 안 갈 수 있음
    await sendPushToUser(
      postAuthorId,
      {
        title: previewTitle,
        body: `${authorNickname}님이 댓글을 남겼습니다.`,
        data: {
          type: 'boardComment',
          postId: String(postId),
          postPreview: previewTitle.slice(0, 200)
        }
      },
      {
        pushCategory: 'boardComment',
        dedupeKey: `boardComment:${postAuthorId}:${auth.uid}:${postId}:${text.trim().slice(0, 200)}`
      }
    );
  }

  return { id: docRef.id, ...newComment, timestamp: new Date().toISOString() };
}));

/**
 * 관리자 게시글 댓글 작성 (Callable) - 관리자 표시 이름 사용
 */
exports.addBoardCommentAsAdmin = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const isAdmin = await isAdminByUid(auth.uid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
  }

  const { postId, content, imageUrls, displayName: clientDisplayName } = data;
  const text = content != null ? String(content) : '';
  const imgs = Array.isArray(imageUrls) ? imageUrls.map((u) => String(u || '').trim()).filter(Boolean) : [];

  if (!postId || (!text.trim() && imgs.length === 0)) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }
  if (imgs.length > 3) {
    throw new HttpsError('invalid-argument', '댓글 이미지는 최대 3장까지 첨부할 수 있습니다.');
  }

  // 클라이언트에서 보낸 표시 이름 우선 사용 (관리자 설정에서 저장한 값이 즉시 반영되도록)
  let authorNickname = '관리자';
  if (clientDisplayName != null && String(clientDisplayName).trim()) {
    authorNickname = String(clientDisplayName).trim();
  } else {
    const adminSettingsRef = db.collection('artifacts').doc(APP_ID).collection('adminSettings').doc('config');
    const adminSettingsSnap = await adminSettingsRef.get();
    if (adminSettingsSnap.exists && adminSettingsSnap.data().displayName) {
      authorNickname = String(adminSettingsSnap.data().displayName).trim() || '관리자';
    }
  }

  const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
  const postDoc = await postRef.get();
  const postData = postDoc.exists ? postDoc.data() : {};
  const postAuthorId = (postData.authorId && String(postData.authorId).trim())
    || (postData.userId && String(postData.userId).trim())
    || '';

  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('boardComments');
  const newComment = {
    postId: String(postId),
    postAuthorId: postAuthorId || null,
    content: text.trim(),
    imageUrls: imgs,
    authorId: auth.uid,
    authorNickname: authorNickname || '관리자',
    authorPhotoUrl: null,
    authorIcon: null,
    isAdminComment: true,
    timestamp: FieldValue.serverTimestamp()
  };

  const docRef = await commentsRef.add(newComment);

  if (postDoc.exists) {
    await postRef.update({
      comments: FieldValue.increment(1)
    });
  }

  if (postAuthorId && postAuthorId !== auth.uid) {
    const previewTitle = boardPostPushTitlePreview(postData, 52);
    await sendPushToUser(
      postAuthorId,
      {
        title: previewTitle,
        body: `${authorNickname}님이 댓글을 남겼습니다.`,
        data: {
          type: 'boardComment',
          postId: String(postId),
          postPreview: previewTitle.slice(0, 200)
        }
      },
      {
        pushCategory: 'boardComment',
        dedupeKey: `boardComment:${postAuthorId}:${auth.uid}:${postId}:${text.trim().slice(0, 200)}`
      }
    );
  }

  return { id: docRef.id, ...newComment, timestamp: new Date().toISOString() };
});

/**
 * 게시글 댓글 삭제 (Callable)
 */
exports.deleteBoardComment = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { commentId, postId } = data;
  
  if (!commentId) {
    throw new HttpsError('invalid-argument', '댓글 ID가 필요합니다.');
  }

  // 댓글 존재 및 권한 확인
  const commentRef = db.collection('artifacts').doc(APP_ID).collection('boardComments').doc(commentId);
  const commentDoc = await commentRef.get();
  
  if (!commentDoc.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }

  const commentData = commentDoc.data();
  if (commentData.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 댓글만 삭제할 수 있습니다.');
  }

  await commentRef.delete();

  // 게시글의 댓글 수 감소
  if (postId) {
    const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
    const postDoc = await postRef.get();
    if (postDoc.exists) {
      await postRef.update({
        comments: FieldValue.increment(-1)
      });
    }
  }

  return { success: true };
});

/**
 * 관리자 게시판 댓글 삭제 (Callable) — isAdminComment 인 댓글만, 호출자는 관리자
 */
exports.deleteBoardCommentAsAdmin = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(auth.uid))) {
    throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
  }

  const { commentId, postId } = data || {};
  if (!commentId) {
    throw new HttpsError('invalid-argument', '댓글 ID가 필요합니다.');
  }

  const commentRef = db.collection('artifacts').doc(APP_ID).collection('boardComments').doc(String(commentId));
  const commentDoc = await commentRef.get();
  if (!commentDoc.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }

  const commentData = commentDoc.data() || {};
  if (commentData.isAdminComment !== true) {
    throw new HttpsError('permission-denied', '운영 관리창으로 등록된 댓글만 삭제할 수 있습니다.');
  }

  const commentPostId = String(commentData.postId || '').trim();
  if (postId != null && String(postId).trim() && commentPostId && String(postId).trim() !== commentPostId) {
    throw new HttpsError('invalid-argument', '게시글 정보가 일치하지 않습니다.');
  }

  await commentRef.delete();

  const pid = (postId != null && String(postId).trim()) || commentPostId;
  if (pid) {
    const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(String(pid));
    const postSnap = await postRef.get();
    if (postSnap.exists) {
      await postRef.update({
        comments: FieldValue.increment(-1)
      });
    }
  }

  return { success: true };
});

/**
 * 게시글 댓글 편집 (Callable)
 */
exports.updateBoardComment = onCall({ region: REGION }, wrapFunction('updateBoardComment', async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(auth);

  const { commentId, postId, content } = data || {};
  const text = content != null ? String(content) : '';

  if (!commentId || !postId) {
    throw new HttpsError('invalid-argument', '필수 값이 누락되었습니다.');
  }
  if (!text.trim()) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }

  // 레이트 리밋 체크 (편집도 댓글 카테고리로 제한)
  await checkRateLimit(auth.uid, 'comment', request);

  // 스팸 필터링
  const spamCheck = checkSpam(text);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  const commentRef = db.collection('artifacts').doc(APP_ID).collection('boardComments').doc(String(commentId));
  const snap = await commentRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }
  const d = snap.data() || {};
  if (String(d.postId || '') !== String(postId)) {
    throw new HttpsError('invalid-argument', '댓글/게시글 정보가 일치하지 않습니다.');
  }
  if (d.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 댓글만 편집할 수 있습니다.');
  }

  await commentRef.update({
    content: text.trim(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return { success: true, id: String(commentId), content: text.trim(), updatedAt: new Date().toISOString() };
}));

/**
 * 공지 댓글 작성 (Callable)
 */
exports.addNoticeComment = onCall({ region: REGION }, wrapFunction('addNoticeComment', async (request) => {
  const { auth, data } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(auth);

  const ban = await getUserBan(auth.uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '댓글 작성이 제한된 계정입니다.');
  }

  const { noticeId, content, imageUrls } = data;
  const text = content != null ? String(content) : '';
  const imgs = Array.isArray(imageUrls) ? imageUrls.map((u) => String(u || '').trim()).filter(Boolean) : [];

  if (!noticeId || (!text.trim() && imgs.length === 0)) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }
  if (imgs.length > 3) {
    throw new HttpsError('invalid-argument', '댓글 이미지는 최대 3장까지 첨부할 수 있습니다.');
  }

  await checkRateLimit(auth.uid, 'comment', request);

  if (text.trim()) {
    const spamCheck = checkSpam(text);
    if (spamCheck.isSpam) {
      throw new HttpsError('invalid-argument', spamCheck.reason);
    }
  }

  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const userSettingsDoc = await userSettingsRef.get();

  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const authorNickname = profile.nickname || '익명';
  const authorPhotoUrl = profile.photoUrl || null;
  const authorIcon = profile.icon || null;

  const noticeRef = db.collection('artifacts').doc(APP_ID).collection('notices').doc(String(noticeId));
  const noticeDoc = await noticeRef.get();
  if (!noticeDoc.exists) {
    throw new HttpsError('not-found', '공지를 찾을 수 없습니다.');
  }
  const nd = noticeDoc.data() || {};
  if (nd.deleted === true || nd.hidden === true) {
    throw new HttpsError('not-found', '공지를 찾을 수 없습니다.');
  }

  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('noticeComments');
  const newComment = {
    noticeId: String(noticeId),
    content: text.trim(),
    imageUrls: imgs,
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    timestamp: FieldValue.serverTimestamp()
  };

  const docRef = await commentsRef.add(newComment);

  await noticeRef.update({
    comments: FieldValue.increment(1)
  });

  return { id: docRef.id, ...newComment, timestamp: new Date().toISOString() };
}));

/**
 * 공지 댓글 삭제 (Callable)
 */
exports.deleteNoticeComment = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { commentId, noticeId } = data;

  if (!commentId) {
    throw new HttpsError('invalid-argument', '댓글 ID가 필요합니다.');
  }

  const commentRef = db.collection('artifacts').doc(APP_ID).collection('noticeComments').doc(commentId);
  const commentDoc = await commentRef.get();

  if (!commentDoc.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }

  const commentData = commentDoc.data();
  if (commentData.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 댓글만 삭제할 수 있습니다.');
  }

  if (noticeId && String(commentData.noticeId || '') !== String(noticeId)) {
    throw new HttpsError('invalid-argument', '공지와 댓글이 일치하지 않습니다.');
  }

  await commentRef.delete();

  const nid = String(noticeId || commentData.noticeId || '');
  if (nid) {
    const noticeRef = db.collection('artifacts').doc(APP_ID).collection('notices').doc(nid);
    const noticeSnap = await noticeRef.get();
    if (noticeSnap.exists) {
      await noticeRef.update({
        comments: FieldValue.increment(-1)
      });
    }
  }

  return { success: true };
});

/**
 * 공지 댓글 편집 (Callable)
 */
exports.updateNoticeComment = onCall({ region: REGION }, wrapFunction('updateNoticeComment', async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(auth);

  const { commentId, noticeId, content } = data || {};
  const text = content != null ? String(content) : '';
  if (!commentId || !noticeId) {
    throw new HttpsError('invalid-argument', '필수 값이 누락되었습니다.');
  }
  if (!text.trim()) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }

  await checkRateLimit(auth.uid, 'comment', request);

  const spamCheck = checkSpam(text);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  const commentRef = db.collection('artifacts').doc(APP_ID).collection('noticeComments').doc(String(commentId));
  const snap = await commentRef.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }
  const d = snap.data() || {};
  if (String(d.noticeId || '') !== String(noticeId)) {
    throw new HttpsError('invalid-argument', '댓글/공지 정보가 일치하지 않습니다.');
  }
  if (d.authorId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 댓글만 편집할 수 있습니다.');
  }

  await commentRef.update({
    content: text.trim(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return { success: true, id: String(commentId), content: text.trim(), updatedAt: new Date().toISOString() };
}));

/**
 * 피드 댓글 작성 (Callable)
 */
exports.addPostComment = onCall({ region: REGION }, wrapFunction('addPostComment', async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(auth);

  const ban = await getUserBan(auth.uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '댓글 작성이 제한된 계정입니다.');
  }

  const { postId, commentText, userNickname: clientNickname, userIcon: clientIcon } = data;
  
  if (!postId || !commentText || !commentText.trim()) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'comment', request);

  // 스팸 필터링
  const spamCheck = checkSpam(commentText);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  // 클라이언트에서 닉네임/아이콘을 보냈으면 사용(Firestore 조회 생략), 없으면 Firestore에서 조회
  let userNickname = '익명';
  let userIcon = '🐻';
  if (typeof clientNickname === 'string' && clientNickname.trim()) {
    userNickname = clientNickname.trim();
    userIcon = (typeof clientIcon === 'string' && clientIcon) ? clientIcon : '🐻';
  } else {
    const userSettingsRef = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(auth.uid)
      .collection('config').doc('settings');
    const userSettingsDoc = await userSettingsRef.get();
    const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
    userNickname = profile.nickname || '익명';
    userIcon = profile.icon || '🐻';
  }

  // 알림용: 이 댓글이 달린 글의 작성자 ID (postOwnerId) 저장 → 클라이언트가 "내 글에 달린 댓글"만 쿼리 가능
  let postOwnerId = '';
  if (typeof postId === 'string' && postId.includes('_')) {
    postOwnerId = postId.slice(postId.lastIndexOf('_') + 1).trim();
  } else {
    const sharedRef = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos').doc(String(postId));
    const sharedSnap = await sharedRef.get();
    if (sharedSnap.exists && sharedSnap.data().userId) {
      postOwnerId = String(sharedSnap.data().userId).trim();
    }
  }

  if (!postOwnerId) {
    logger.warn('addPostComment: postOwnerId 없음 → 글 주인에게 푸시 생략', {
      postIdSample: String(postId).slice(0, 100),
      commenter: auth.uid
    });
  }

  // 댓글 생성
  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('postComments');
  const commentData = {
    postId,
    postOwnerId: postOwnerId || null,
    userId: auth.uid,
    userNickname,
    userIcon,
    comment: commentText.trim(),
    timestamp: FieldValue.serverTimestamp()
  };

  const docRef = await commentsRef.add(commentData);

  try {
    await bumpMomentPostV2CommentCount(String(postId), 1);
  } catch (e) {
    logger.warn('addPostComment: commentCount bump skip', { postId: String(postId).slice(0, 80), err: e?.message });
  }

  if (postOwnerId && postOwnerId !== auth.uid) {
    await sendPushToUser(
      postOwnerId,
      {
        title: '새 댓글',
        body: `${userNickname}님이 댓글을 남겼습니다.`,
        data: { type: 'postComment', postId: String(postId) }
      },
      {
        pushCategory: 'momentComment',
        dedupeKey: `momentComment:${postOwnerId}:${auth.uid}:${postId}:${commentText.trim().slice(0, 200)}`
      }
    );
  }

  return { id: docRef.id, ...commentData, timestamp: new Date().toISOString() };
}));

/**
 * 피드 댓글 삭제 (Callable)
 */
exports.deletePostComment = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { commentId } = data;
  
  if (!commentId) {
    throw new HttpsError('invalid-argument', '댓글 ID가 필요합니다.');
  }

  // 댓글 존재 및 권한 확인
  const commentRef = db.collection('artifacts').doc(APP_ID).collection('postComments').doc(commentId);
  const commentDoc = await commentRef.get();
  
  if (!commentDoc.exists) {
    throw new HttpsError('not-found', '댓글을 찾을 수 없습니다.');
  }

  const commentData = commentDoc.data();
  if (commentData.userId !== auth.uid) {
    throw new HttpsError('permission-denied', '본인의 댓글만 삭제할 수 있습니다.');
  }

  const commentPostId = commentData.postId ? String(commentData.postId) : '';

  await commentRef.delete();

  if (commentPostId) {
    try {
      await bumpMomentPostV2CommentCount(commentPostId, -1);
    } catch (e) {
      logger.warn('deletePostComment: commentCount bump skip', { postId: commentPostId.slice(0, 80), err: e?.message });
    }
  }

  return { success: true };
});

/**
 * 게시물 신고 (Callable)
 */
exports.submitPostReport = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { targetGroupKey, reason, reasonOther } = data;
  
  if (!targetGroupKey || !reason) {
    throw new HttpsError('invalid-argument', '신고 대상과 사유가 필요합니다.');
  }

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'report', request);

  // 중복 신고 체크
  await checkDuplicateReport(auth.uid, targetGroupKey);

  // 신고 생성
  const reportsRef = db.collection('artifacts').doc(APP_ID).collection('postReports');
  const reportData = {
    targetGroupKey,
    reason,
    reportedBy: auth.uid,
    reportedAt: FieldValue.serverTimestamp()
  };

  if (reason === 'other' && reasonOther && reasonOther.trim()) {
    reportData.reasonOther = reasonOther.trim();
  }

  const reportRef = await reportsRef.add(reportData);

  // 사용자 config/reportedPosts에 기록
  const userReportedRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('reportedPosts');
  
  await userReportedRef.set({
    [targetGroupKey]: {
      reportId: reportRef.id,
      reason,
      reasonOther: (reason === 'other' && reasonOther) ? reasonOther.trim() : null
    }
  }, { merge: true });

  return { reportId: reportRef.id };
});

async function bumpMomentPostV2CommentCount(postId, delta) {
  if (!postId || !delta) return;
  const docId = momentPostV2.sanitizeMomentPostDocId(String(postId));
  const ref = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos').doc(docId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().schemaVersion !== 2) return;
  const current = Number(snap.data().commentCount) || 0;
  if (delta < 0 && current <= 0) return;
  await ref.update({ commentCount: FieldValue.increment(delta) });
}

async function bumpMomentPostV2LikeCount(postId, delta) {
  if (!postId || !delta) return;
  const docId = momentPostV2.sanitizeMomentPostDocId(String(postId));
  const ref = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos').doc(docId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().schemaVersion !== 2) return;
  const current = Number(snap.data().likeCount) || 0;
  if (delta < 0 && current <= 0) return;
  await ref.update({ likeCount: FieldValue.increment(delta) });
}

/** postId → 글 작성자 uid (댓글 알림과 동일한 방식: canonical postId의 `_uid` 접미사, 없으면 sharedPhotos 조회) */
async function resolvePostOwnerId(postId) {
  if (typeof postId === 'string' && postId.includes('_')) {
    return postId.slice(postId.lastIndexOf('_') + 1).trim();
  }
  const sharedRef = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos').doc(String(postId));
  const sharedSnap = await sharedRef.get();
  if (sharedSnap.exists && sharedSnap.data().userId) {
    return String(sharedSnap.data().userId).trim();
  }
  return '';
}

async function getUserNickname(uid) {
  const settingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(uid)
    .collection('config').doc('settings');
  const snap = await settingsRef.get();
  const profile = snap.exists ? (snap.data().profile || {}) : {};
  return profile.nickname || '익명';
}

/**
 * 좋아요 알림(글 주인 기준, postId당 1건 집계): 최근 누른 사람 닉네임 + 총 개수만 저장.
 * "누가 좋아요를 눌렀는지" 전체 명단은 노출하지 않는다는 정책에 따라 대표 1명만 기록.
 */
async function upsertLikeNotification(postId, likerUid) {
  const postOwnerId = await resolvePostOwnerId(postId);
  if (!postOwnerId || postOwnerId === likerUid) return;
  const likerNickname = await getUserNickname(likerUid);
  const docId = momentPostV2.sanitizeMomentPostDocId(String(postId));
  const ref = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(postOwnerId)
    .collection('likeNotifications').doc(docId);
  await ref.set({
    postId,
    lastLikerUid: likerUid,
    lastLikerNickname: likerNickname,
    lastLikeAt: FieldValue.serverTimestamp(),
    likeCount: FieldValue.increment(1)
  }, { merge: true });
}

async function decrementLikeNotification(postId, likerUid) {
  const postOwnerId = await resolvePostOwnerId(postId);
  if (!postOwnerId || postOwnerId === likerUid) return;
  const docId = momentPostV2.sanitizeMomentPostDocId(String(postId));
  const ref = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(postOwnerId)
    .collection('likeNotifications').doc(docId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const current = Number(snap.data().likeCount) || 0;
  if (current <= 1) {
    await ref.delete();
  } else {
    await ref.update({ likeCount: FieldValue.increment(-1) });
  }
}

/** postLikes 생성 → 모먼트 v2 likeCount +1, 좋아요 알림 집계 갱신 */
exports.onPostLikeCreated = onDocumentCreated(
  {
    document: `artifacts/${APP_ID}/postLikes/{likeId}`,
    region: REGION
  },
  async (event) => {
    const data = event.data?.data();
    const postId = data?.postId ? String(data.postId) : '';
    const likerUid = data?.userId ? String(data.userId) : '';
    if (!postId) return;
    try {
      await bumpMomentPostV2LikeCount(postId, 1);
    } catch (e) {
      logger.warn('onPostLikeCreated: likeCount bump skip', { postId: postId.slice(0, 80), err: e?.message });
    }
    if (!likerUid) return;
    try {
      await upsertLikeNotification(postId, likerUid);
    } catch (e) {
      logger.warn('onPostLikeCreated: likeNotification skip', { postId: postId.slice(0, 80), err: e?.message });
    }
  }
);

/** postLikes 삭제 → 모먼트 v2 likeCount -1, 좋아요 알림 집계 갱신 */
exports.onPostLikeDeleted = onDocumentDeleted(
  {
    document: `artifacts/${APP_ID}/postLikes/{likeId}`,
    region: REGION
  },
  async (event) => {
    const data = event.data?.data();
    const postId = data?.postId ? String(data.postId) : '';
    const likerUid = data?.userId ? String(data.userId) : '';
    if (!postId) return;
    try {
      await bumpMomentPostV2LikeCount(postId, -1);
    } catch (e) {
      logger.warn('onPostLikeDeleted: likeCount bump skip', { postId: postId.slice(0, 80), err: e?.message });
    }
    if (!likerUid) return;
    try {
      await decrementLikeNotification(postId, likerUid);
    } catch (e) {
      logger.warn('onPostLikeDeleted: likeNotification skip', { postId: postId.slice(0, 80), err: e?.message });
    }
  }
);

/**
 * 공유 사진 추가 (Callable)
 * photosToShare가 빈 배열이면 공유 해제로 처리
 */
exports.sharePhotos = onCall({ region: REGION }, async (request) => {
  try {
    const { auth, data } = request;
    
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }

    const ban = await getUserBan(auth.uid);
    if (ban.bannedShare) {
      throw new HttpsError('permission-denied', '밀로그 공유가 제한된 계정입니다.');
    }

    const { photosToShare, mealData } = data;
    
    // photosToShare가 배열이 아니면 오류
    if (!photosToShare || !Array.isArray(photosToShare)) {
      logger.error('sharePhotos: invalid photosToShare', { photosToShare, mealData });
      throw new HttpsError('invalid-argument', '잘못된 요청입니다.');
    }

    // 빈 배열이면 공유 해제 (레이트 리밋 체크 없이 바로 처리)
    if (photosToShare.length === 0) {
      const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
      const batch = db.batch();
      let hasDeletions = false;

      // entryId가 있는 경우: 같은 entryId의 기존 문서를 모두 삭제
      if (mealData && mealData.id) {
        const postId = momentPostV2.mealSharePostId(mealData, auth.uid);
        momentPostV2.deleteMomentPostV2ByPostId(batch, sharedColl, postId);
        hasDeletions = true;
        const existingQuery = await sharedColl
          .where('userId', '==', auth.uid)
          .where('entryId', '==', mealData.id)
          .get();
        
        momentPostV2.deleteLegacyPhotoDocsForQuery(batch, sharedColl, existingQuery);
        if (existingQuery.docs.length > 0) hasDeletions = true;
      } else {
        // entryId가 null인 경우: userId로만 필터링 후 entryId null인 것만 삭제
        const existingQuery = await sharedColl
          .where('userId', '==', auth.uid)
          .get();
        
        existingQuery.docs.forEach(docSnap => {
          const data = docSnap.data();
          if (data.schemaVersion === 2) return;
          if (!data.entryId || data.entryId === null) {
            batch.delete(docSnap.ref);
            hasDeletions = true;
          }
        });
      }

      // 삭제할 문서가 있을 때만 commit
      if (hasDeletions) {
        await batch.commit();
      }

      if (mealData && mealData.id) {
        await momentPostV2.syncMealSharedPhotosMirror(db, APP_ID, auth.uid, mealData.id, []);
      }

      return { success: true, action: 'unshare' };
    }

    // 공유 설정인 경우 레이트 리밋 체크
    await checkRateLimit(auth.uid, 'share', request);

    // 사용자 프로필 정보 가져오기
    const userSettingsRef = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(auth.uid)
      .collection('config').doc('settings');
    const userSettingsDoc = await userSettingsRef.get();
    
    const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
    const userNickname = profile.nickname || '익명';
    const userIcon = profile.icon || '🐻';
    const userPhotoUrl = profile.photoUrl || null;

    const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
    const batch = db.batch();
    const postId = momentPostV2.mealSharePostId(mealData, auth.uid);
    const docId = momentPostV2.sanitizeMomentPostDocId(postId);

    // legacy v1 + 기존 v2 삭제 후 재작성
    if (mealData && mealData.id) {
      const existingQuery = await sharedColl
        .where('userId', '==', auth.uid)
        .where('entryId', '==', mealData.id)
        .get();
      momentPostV2.deleteLegacyPhotoDocsForQuery(batch, sharedColl, existingQuery);
    } else {
      const existingQuery = await sharedColl
        .where('userId', '==', auth.uid)
        .get();
      existingQuery.docs.forEach(docSnap => {
        const data = docSnap.data();
        if (data.schemaVersion === 2) return;
        if (!data.entryId || data.entryId === null) {
          batch.delete(docSnap.ref);
        }
      });
    }
    batch.delete(sharedColl.doc(docId));

    const existingV2Snap = await sharedColl.doc(docId).get();
    const existingV2Data =
      existingV2Snap.exists && existingV2Snap.data().schemaVersion === 2 ? existingV2Snap.data() : null;
    const preservedCounts = existingV2Data
      ? {
          likeCount: Number(existingV2Data.likeCount) || 0,
          commentCount: Number(existingV2Data.commentCount) || 0
        }
      : { likeCount: 0, commentCount: 0 };

    // 기존 게시물의 사진 목록과 이번 공유 목록을 비교 (추가/삭제/순서 변경 감지)
    const existingPhotoUrls =
      existingV2Data && Array.isArray(existingV2Data.photos)
        ? existingV2Data.photos.map((p) => (p && p.url) || '')
        : [];
    const photosChanged =
      existingPhotoUrls.length !== photosToShare.length ||
      existingPhotoUrls.some((u, i) => u !== photosToShare[i]);

    const v2Fields = momentPostV2.buildMealMomentPostV2Fields({
      photosToShare,
      mealData,
      userId: auth.uid,
      profile: { nickname: userNickname, icon: userIcon, photoUrl: userPhotoUrl },
      postId,
      FieldValue
    });

    // 정책(b): 사진이 추가/변경되면 "새 활동"으로 보고 sharedAt을 갱신해 피드 최상단으로 올린다.
    // 사진 목록에 변화가 없으면(코멘트·메뉴 등만 수정) 기존 sharedAt을 보존해 피드 순서가 뒤섞이지 않게 한다.
    const preservedTimestamps =
      existingV2Data && !photosChanged && existingV2Data.sharedAt
        ? {
            sharedAt: existingV2Data.sharedAt,
            timestamp: existingV2Data.timestamp || existingV2Data.sharedAt
          }
        : {};

    batch.set(sharedColl.doc(docId), {
      ...v2Fields,
      ...preservedCounts,
      ...preservedTimestamps,
      updatedAt: FieldValue.serverTimestamp()
    });

    await batch.commit();

    if (mealData && mealData.id) {
      await momentPostV2.syncMealSharedPhotosMirror(db, APP_ID, auth.uid, mealData.id, photosToShare);
    }

    return { success: true, action: 'share', postId, id: docId };
  } catch (error) {
    logger.error('sharePhotos error:', error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError('internal', '공유 처리 중 오류가 발생했습니다.');
  }
});

/**
 * 관리자: legacy sharedPhotos → v2 게시물 문서 백필
 * data: { dryRun?: boolean, internalKey?: string }
 */
exports.adminMigrateMomentPostsV2 = onCall({ region: REGION, timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  const { auth, data } = request;
  const internalOk = data && data.internalKey === 'mealog-moment-v2-migrate-internal';
  if (!internalOk) {
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(auth.uid))) {
      throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
    }
  }
  const dryRun = !!(data && data.dryRun);
  const chunkSize = data && data.chunkSize != null ? Number(data.chunkSize) : 40;
  const cursor = data && data.cursor ? String(data.cursor) : '';
  const result = await momentPostV2.migrateLegacySharedPhotosToV2(db, APP_ID, { dryRun, chunkSize, cursor });
  logger.info('adminMigrateMomentPostsV2', { uid: auth && auth.uid, ...result });
  return result;
});

/**
 * 관리자: meals photoDisplayUrls / photoThumbUrls 선택 백필 (최근 N일)
 * data: { dryRun?, daysBack?, scanLimit?, maxProcess?, cursorDocPath?, concurrency?, syncSharedPhotos? }
 */
exports.adminBackfillMealPhotoVariants = onCall(
  { region: REGION, timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    const { auth, data } = request;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(auth.uid))) {
      throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
    }
    const bucket = getStorage().bucket(mealPhotoVariantsBackfill.STORAGE_BUCKET);
    const result = await mealPhotoVariantsBackfill.runMealPhotoVariantsBackfillBatch(db, APP_ID, bucket, {
      dryRun: !!(data && data.dryRun),
      daysBack: data && data.daysBack != null ? Number(data.daysBack) : 60,
      scanLimit: data && data.scanLimit != null ? Number(data.scanLimit) : 80,
      maxProcess: data && data.maxProcess != null ? Number(data.maxProcess) : 15,
      cursorDocPath: data && data.cursorDocPath ? String(data.cursorDocPath) : undefined,
      concurrency: data && data.concurrency != null ? Number(data.concurrency) : 5,
      syncSharedPhotos: data && data.syncSharedPhotos === false ? false : true
    });
    logger.info('adminBackfillMealPhotoVariants', { uid: auth.uid, ...result });
    if (result.aborted) {
      throw new HttpsError('resource-exhausted', '실패율이 임계치를 초과해 배치를 중단했습니다.', result);
    }
    return result;
  }
);

/**
 * 일간보기 공유 (Callable)
 */
exports.createDailyShare = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { photoUrl, date, comment } = data;
  
  if (!photoUrl || !date) {
    throw new HttpsError('invalid-argument', '사진 URL과 날짜가 필요합니다.');
  }

  // 레이트 리밋 체크와 프로필 조회 병렬 수행
  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const [_, userSettingsDoc] = await Promise.all([
    checkRateLimit(auth.uid, 'share', request),
    userSettingsRef.get()
  ]);
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const userNickname = profile.nickname || '익명';
  const userIcon = profile.icon || '🐻';
  const userPhotoUrl = profile.photoUrl || null;

  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  
  // 같은 날짜의 기존 일간보기 공유 삭제
  const existingQuery = await sharedColl
    .where('userId', '==', auth.uid)
    .where('type', '==', 'daily')
    .where('date', '==', date)
    .get();
  
  const batch = db.batch();
  momentPostV2.deleteLegacyPhotoDocsForQuery(batch, sharedColl, existingQuery);
  const postId = momentPostV2.dailySharePostId(date, auth.uid);
  const docId = momentPostV2.sanitizeMomentPostDocId(postId);
  batch.delete(sharedColl.doc(docId));

  const v2Fields = momentPostV2.buildSpecialMomentPostV2Fields({
    type: 'daily',
    userId: auth.uid,
    profile: { nickname: userNickname, icon: userIcon, photoUrl: userPhotoUrl },
    postId,
    photoUrl,
    FieldValue,
    extra: { date, comment: comment || '' }
  });
  batch.set(sharedColl.doc(docId), v2Fields);

  await batch.commit();

  return { 
    id: docId,
    postId,
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'daily',
    date,
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    sharedAt: new Date().toISOString(),
    entryId: null,
    comment: comment || ''
  };
});

/**
 * 베스트 공유 (Callable)
 */
exports.createBestShare = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { photoUrl, periodType, periodText, comment } = data;
  
  if (!photoUrl || !periodType || !periodText) {
    throw new HttpsError('invalid-argument', '사진 URL, 기간 타입, 기간 텍스트가 필요합니다.');
  }

  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const [_, userSettingsDoc] = await Promise.all([
    checkRateLimit(auth.uid, 'share', request),
    userSettingsRef.get()
  ]);
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const userNickname = profile.nickname || '익명';
  const userIcon = profile.icon || '🐻';
  const userPhotoUrl = profile.photoUrl || null;

  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  
  // 같은 기간의 기존 베스트 공유 삭제
  const existingQuery = await sharedColl
    .where('userId', '==', auth.uid)
    .where('type', '==', 'best')
    .where('periodType', '==', periodType)
    .where('periodText', '==', periodText)
    .get();
  
  const batch = db.batch();
  momentPostV2.deleteLegacyPhotoDocsForQuery(batch, sharedColl, existingQuery);
  const postId = momentPostV2.bestSharePostId(periodType, periodText, auth.uid);
  const docId = momentPostV2.sanitizeMomentPostDocId(postId);
  batch.delete(sharedColl.doc(docId));

  const v2Fields = momentPostV2.buildSpecialMomentPostV2Fields({
    type: 'best',
    userId: auth.uid,
    profile: { nickname: userNickname, icon: userIcon, photoUrl: userPhotoUrl },
    postId,
    photoUrl,
    FieldValue,
    extra: { periodType, periodText, comment: comment || '' }
  });
  batch.set(sharedColl.doc(docId), v2Fields);

  await batch.commit();

  return { 
    id: docId,
    postId,
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'best',
    periodType,
    periodText,
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    sharedAt: new Date().toISOString(),
    entryId: null,
    comment: comment || ''
  };
});

/**
 * 인사이트 공유 (Callable)
 */
exports.createInsightShare = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { photoUrl, dateRangeText, comment, date } = data;
  
  if (!photoUrl || !dateRangeText) {
    throw new HttpsError('invalid-argument', '사진 URL과 날짜 범위 텍스트가 필요합니다.');
  }

  const dietReportDate =
    date && /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim()) ? String(date).trim() : null;

  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const [_, userSettingsDoc] = await Promise.all([
    checkRateLimit(auth.uid, 'share', request),
    userSettingsRef.get()
  ]);
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const userNickname = profile.nickname || '익명';
  const userIcon = profile.icon || '🐻';
  const userPhotoUrl = profile.photoUrl || null;

  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  
  // 같은 날짜 범위의 기존 인사이트 공유 삭제
  const existingQuery = await sharedColl
    .where('userId', '==', auth.uid)
    .where('type', '==', 'insight')
    .where('dateRangeText', '==', dateRangeText)
    .get();
  
  const batch = db.batch();
  momentPostV2.deleteLegacyPhotoDocsForQuery(batch, sharedColl, existingQuery);
  const postId = momentPostV2.insightSharePostId(dateRangeText, auth.uid);
  const docId = momentPostV2.sanitizeMomentPostDocId(postId);
  batch.delete(sharedColl.doc(docId));

  const v2Fields = momentPostV2.buildSpecialMomentPostV2Fields({
    type: 'insight',
    userId: auth.uid,
    profile: { nickname: userNickname, icon: userIcon, photoUrl: userPhotoUrl },
    postId,
    photoUrl,
    FieldValue,
    extra: { dateRangeText, comment: comment || '', ...(dietReportDate ? { date: dietReportDate } : {}) }
  });
  batch.set(sharedColl.doc(docId), v2Fields);

  await batch.commit();

  return { 
    id: docId,
    postId,
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'insight',
    dateRangeText,
    ...(dietReportDate ? { date: dietReportDate } : {}),
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    sharedAt: new Date().toISOString(),
    entryId: null,
    comment: comment || ''
  };
});

/**
 * Firebase Storage 이미지를 base64로 변환 (CORS 우회용)
 * 밀당 공유 캡처 시 캐릭터 이미지가 포함되도록 서버에서 다운로드
 */
exports.getStorageImageAsBase64 = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { imageUrl } = data;
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new HttpsError('invalid-argument', 'imageUrl이 필요합니다.');
  }

  // Firebase Storage URL에서 경로 추출
  // 형식: https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodedPath}?alt=media&token=...
  if (!imageUrl.includes('firebasestorage.googleapis.com')) {
    throw new HttpsError('invalid-argument', 'Firebase Storage URL만 지원합니다.');
  }

  let storagePath;
  try {
    const url = new URL(imageUrl);
    const pathMatch = url.pathname.match(/\/o\/(.+)$/);
    if (!pathMatch) throw new Error('Invalid path');
    storagePath = decodeURIComponent(pathMatch[1]);
  } catch (e) {
    throw new HttpsError('invalid-argument', '유효하지 않은 Storage URL입니다.');
  }

  // 본인 또는 공개 경로만 허용 (users/{uid}/... 형태)
  const pathParts = storagePath.split('/');
  if (pathParts[0] === 'users' && pathParts[1] !== auth.uid) {
    throw new HttpsError('permission-denied', '다른 사용자의 이미지에 접근할 수 없습니다.');
  }

  try {
    const storage = getStorage();
    const bucket = storage.bucket('mealog-r0.firebasestorage.app');
    const file = bucket.file(storagePath);
    const [contents] = await file.download();
    const ext = storagePath.split('.').pop()?.toLowerCase() || 'png';
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const base64 = contents.toString('base64');
    return { dataUrl: `data:${mime};base64,${base64}` };
  } catch (e) {
    logger.error('getStorageImageAsBase64 실패:', e);
    throw new HttpsError('internal', '이미지 다운로드에 실패했습니다.');
  }
});

/**
 * 공유 사진 해제 (Callable)
 */
exports.unsharePhotos = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { photos, entryId, isBestShare, isDailyShare, isInsightShare } = data;
  
  if (!photos || !Array.isArray(photos) || photos.length === 0) {
    throw new HttpsError('invalid-argument', '공유 해제할 사진이 필요합니다.');
  }

  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  let querySnap;
  if (isBestShare) {
    querySnap = await sharedColl.where('userId', '==', auth.uid).where('type', '==', 'best').get();
  } else if (isDailyShare) {
    querySnap = await sharedColl.where('userId', '==', auth.uid).where('type', '==', 'daily').get();
  } else if (isInsightShare) {
    querySnap = await sharedColl.where('userId', '==', auth.uid).where('type', '==', 'insight').get();
  } else {
    querySnap = await sharedColl.where('userId', '==', auth.uid).get();
  }
  const query = querySnap;

  const photosToDelete = [];

  query.docs.forEach((docSnap) => {
    let docData;
    try {
      docData = docSnap.data() || {};
    } catch (e) {
      logger.warn('unsharePhotos: doc read skip', { id: docSnap.id, err: e?.message });
      return;
    }
    /** photoUrl 누락·비문자열이면 .split에서 TypeError → 전체 Callable 500 방지 */
    const storedPhotoUrl = typeof docData.photoUrl === 'string' ? docData.photoUrl : '';
    const photoUrlMatch = photos.some((photoUrl) => {
      if (typeof photoUrl !== 'string' || !photoUrl) return false;
      if (!storedPhotoUrl) return false;
      if (photoUrl === storedPhotoUrl) return true;
      const photoUrlBase = photoUrl.split('?')[0];
      const dataUrlBase = storedPhotoUrl.split('?')[0];
      if (photoUrlBase === dataUrlBase) return true;
      const photoFileName = photoUrlBase.split('/').pop();
      const dataFileName = dataUrlBase.split('/').pop();
      return photoFileName === dataFileName && photoFileName !== '';
    });

    /** URL 필드 누락 문서: 동일 entryId면 삭제 대상 (스토리지 URL 불일치로 매칭 실패 방지) */
    let matched = photoUrlMatch;
    if (
      !matched &&
      !isBestShare &&
      !isDailyShare &&
      !isInsightShare &&
      entryId &&
      docData.entryId === entryId &&
      !storedPhotoUrl
    ) {
      matched = true;
    }

    if (matched) {
      if (isBestShare && docData.type === 'best') {
        photosToDelete.push(docSnap.id);
      } else if (isDailyShare && docData.type === 'daily') {
        photosToDelete.push(docSnap.id);
      } else if (isInsightShare && docData.type === 'insight') {
        photosToDelete.push(docSnap.id);
      } else if (!isBestShare && !isDailyShare && !isInsightShare) {
        let shouldDelete = false;
        if (entryId) {
          if (docData.entryId === entryId || !docData.entryId || docData.entryId === null) {
            shouldDelete = true;
          }
        } else {
          shouldDelete = true;
        }
        if (shouldDelete) {
          photosToDelete.push(docSnap.id);
        }
      }
    }
  });

  if (photosToDelete.length > 0) {
    const batch = db.batch();
    photosToDelete.forEach(docId => {
      const docRef = sharedColl.doc(docId);
      batch.delete(docRef);
    });
    await batch.commit();
  }

  /** meals.sharedPhotos 미러 — canonical은 sharedPhotos 컬렉션 */
  const mealEntryIdRaw = data && data.mealEntryId;
  const mealEntryIdFromPayload = typeof mealEntryIdRaw === 'string' ? mealEntryIdRaw.trim() : '';
  const entryIdStr = typeof entryId === 'string' ? entryId.trim() : '';
  const mealIdToMirror = mealEntryIdFromPayload || entryIdStr;
  const msp = data && data.mealSharedPhotos;
  if (
    mealIdToMirror &&
    !mealIdToMirror.startsWith('dailyJournal_') &&
    !isBestShare &&
    !isDailyShare &&
    !isInsightShare
  ) {
    const mirrorUrls = Array.isArray(msp) ? msp : [];
    await momentPostV2.syncMealSharedPhotosMirror(db, APP_ID, auth.uid, mealIdToMirror, mirrorUrls);
  }

  return { success: true, deletedCount: photosToDelete.length };
});

/**
 * 공유된 게시물(entry)의 코멘트 조회 — sharedPhotos에 있는 글만 허용 (다른 사용자에게 코멘트가 안 보이는 기존 문서 대응)
 * 인자: { entryId: string, ownerUserId: string }
 * 반환: { comment: string }
 */
exports.getSharedEntryComment = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const { entryId, ownerUserId } = data || {};
  if (!entryId || !ownerUserId) {
    throw new HttpsError('invalid-argument', 'entryId와 ownerUserId가 필요합니다.');
  }
  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const sharedSnap = await sharedColl
    .where('entryId', '==', entryId)
    .where('userId', '==', ownerUserId)
    .limit(1)
    .get();
  if (sharedSnap.empty) {
    return { comment: '' };
  }
  const mealRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(ownerUserId).collection('meals').doc(entryId);
  const mealSnap = await mealRef.get();
  const comment = mealSnap.exists ? (mealSnap.data().comment || '') : '';
  return { comment: String(comment || '').trim() };
});

const GET_SHARED_COMMENTS_BATCH_MAX = 30;

/**
 * 공유된 게시물 코멘트 일괄 조회 — 한 번의 호출로 여러 글의 코멘트 반환 (모먼트 로딩 지연 방지)
 * 인자: { items: Array<{ entryId: string, ownerUserId: string }> } (최대 30건)
 * 반환: { comments: Array<{ entryId: string, ownerUserId: string, comment: string }> }
 */
exports.getSharedEntryComments = onCall({ region: REGION }, async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const items = data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { comments: [] };
  }
  const limited = items.slice(0, GET_SHARED_COMMENTS_BATCH_MAX);
  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const results = await Promise.all(limited.map(async ({ entryId, ownerUserId }) => {
    if (!entryId || !ownerUserId) return { entryId: entryId || '', ownerUserId: ownerUserId || '', comment: '' };
    const sharedSnap = await sharedColl
      .where('entryId', '==', entryId)
      .where('userId', '==', ownerUserId)
      .limit(1)
      .get();
    if (sharedSnap.empty) return { entryId, ownerUserId, comment: '' };
    const sharedData = sharedSnap.docs[0].data();
    const existingComment = sharedData.comment != null && String(sharedData.comment).trim() !== '' ? String(sharedData.comment).trim() : null;
    if (existingComment !== null) return { entryId, ownerUserId, comment: existingComment };
    const mealRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(ownerUserId).collection('meals').doc(entryId);
    const mealSnap = await mealRef.get();
    const comment = mealSnap.exists ? (mealSnap.data().comment || '') : '';
    return { entryId, ownerUserId, comment: String(comment || '').trim() };
  }));
  return { comments: results };
});

/**
 * 기존 sharedPhotos 문서에 meal의 comment 보정 (관리자 전용, 한 번 실행 권장)
 */
exports.backfillSharedPhotosComments = onCall({ region: REGION }, async (request) => {
  const { auth } = request;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const isAdmin = await isAdminByUid(auth.uid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
  }
  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const snap = await sharedColl.get();
  let updated = 0;
  let batch = db.batch();
  let batchCount = 0;
  const BATCH_MAX = 500;
  for (const docSnap of snap.docs) {
    const d = docSnap.data();
    const entryId = d.entryId;
    const userId = d.userId;
    const hasComment = d.comment != null && String(d.comment).trim() !== '';
    if (!entryId || !userId || hasComment) continue;
    const mealRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId).collection('meals').doc(entryId);
    const mealSnap = await mealRef.get();
    if (!mealSnap.exists) continue;
    const comment = mealSnap.data().comment;
    if (comment == null || String(comment).trim() === '') continue;
    batch.update(docSnap.ref, { comment: String(comment).trim() });
    updated++;
    batchCount++;
    if (batchCount >= BATCH_MAX) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }
  if (batchCount > 0) await batch.commit();
  logger.info('backfillSharedPhotosComments', { updated, total: snap.size });
  return { success: true, updated, total: snap.size };
});

/**
 * 식사 기록(meals) 변경 시 stats 집계 문서 업데이트 (연도별 서브컬렉션)
 * config/stats/years/{year} - 1년 단위로 분리하여 문서 크기 제한(1MB) 회피
 */
exports.onMealWritten = onDocumentWritten(
  {
    document: 'artifacts/' + APP_ID + '/users/{userId}/meals/{mealId}',
    region: REGION
  },
  async (event) => {
    const change = event.data;
    if (!change) return;
    const before = change.before;
    const after = change.after;
    const userId = event.params.userId;
    if (!userId) return;

    /**
     * 삭제 툼스톤 — 관리자 로컬 미러(docs/admin-local-mirror.md)의 삭제 전파용.
     * 하드 딜리트는 클라이언트 쿼리로 알 수 없으므로 여기서 흔적을 남긴다.
     * date 없는 문서의 삭제도 미러에서는 지워야 하니, 아래 early-return 보다 먼저 쓴다.
     * 실패해도 stats 집계를 막지 않는다(다음 전량 재다운로드가 안전망).
     */
    if (before && before.exists && !(after && after.exists)) {
      const mealId = event.params.mealId;
      try {
        await db.collection('artifacts').doc(APP_ID)
          .collection('adminMealTombstones').doc(`${userId}_${mealId}`)
          .set({ userId, mealId, deletedAt: new Date().toISOString() });
      } catch (err) {
        logger.error('onMealWritten: tombstone write failed', { userId, mealId, err: err.message });
      }
    }

    const datesToUpdate = new Set();

    // 삭제/수정: 이전 데이터에서 -1 delta 적용
    if (before && before.exists) {
      const oldData = before.data();
      const d = getMealDelta(oldData, -1);
      if (d) datesToUpdate.add(d.date);
    }

    // 생성/수정: 새 데이터에서 +1 delta 적용
    if (after && after.exists) {
      const newData = after.data();
      const d = getMealDelta(newData, +1);
      if (d) datesToUpdate.add(d.date);
    }

    if (datesToUpdate.size === 0) return;

    // 날짜별 연도 그룹화
    const datesByYear = new Map();
    datesToUpdate.forEach((dateStr) => {
      const year = dateStr.split('-')[0];
      if (!datesByYear.has(year)) datesByYear.set(year, new Set());
      datesByYear.get(year).add(dateStr);
    });

    const basePath = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(userId)
      .collection('config').doc('stats')
      .collection('years');

    const emptyDayTemplate = { count: 0, mainCount: 0, snackCount: 0, main: { mealType: {}, category: {}, withWhom: {}, rating: {}, satiety: {} }, snack: { place: {}, snackType: {}, rating: {}, satiety: {} } };

    try {
      await db.runTransaction(async (tx) => {
        for (const [year, dates] of datesByYear) {
          const yearRef = basePath.doc(year);
          const yearSnap = await tx.get(yearRef);
          const daily = yearSnap.exists ? { ...(yearSnap.data().daily || {}) } : {};

          const applyDelta = (mealData, increment) => {
            if (!mealData || !mealData.date) return;
            const delta = getMealDelta(mealData, increment);
            if (!delta) return;
            const dateStr = mealData.date;
            const day = daily[dateStr] ? JSON.parse(JSON.stringify(daily[dateStr])) : JSON.parse(JSON.stringify(emptyDayTemplate));
            if (!day.main) day.main = emptyDayTemplate.main;
            if (!day.snack) day.snack = emptyDayTemplate.snack;
            mergeDeltaIntoDay(day, delta);
            const sanitized = sanitizeDayEntry(day);
            if (sanitized) daily[dateStr] = sanitized;
            else delete daily[dateStr];
          };

          if (before && before.exists) {
            const d = before.data().date;
            if (d && year === d.split('-')[0]) applyDelta(before.data(), -1);
          }
          if (after && after.exists) {
            const d = after.data().date;
            if (d && year === d.split('-')[0]) applyDelta(after.data(), +1);
          }

          tx.set(yearRef, { daily, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
      });
      logger.info('onMealWritten: stats updated', { userId, dates: Array.from(datesToUpdate), years: Array.from(datesByYear.keys()) });
    } catch (err) {
      logger.error('onMealWritten: stats update failed', { userId, err: err.message });
      throw err;
    }
  }
);

/**
 * artifacts/{APP_ID}/users/{uid} 문서 및 모든 하위 컬렉션(meals, config/settings, …) 삭제
 * 부모 문서만 delete() 하면 하위는 고아로 남아 재가입 시 온보딩이 건너뛰어질 수 있음
 */
async function recursiveDeleteArtifactUser(userId) {
  const uid = String(userId);
  const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(uid);
  try {
    await db.recursiveDelete(userRef);
    logger.info('recursiveDeleteArtifactUser: subtree removed', { userId: uid });
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === 5 || /not found/i.test(msg)) {
      logger.info('recursiveDeleteArtifactUser: no user doc to delete', { userId: uid });
      return;
    }
    logger.error('recursiveDeleteArtifactUser failed', { userId: uid, err: msg });
    throw e;
  }
}

/**
 * 관리자 사용자 삭제 요청 처리 (Firestore 문서 생성 시 트리거)
 * deleteUserRequests/{requestId} 문서가 생성되면 requestedBy가 관리자인지 확인 후
 * Firestore users/{uid} 전체(하위 포함) 삭제 → Firebase Auth 삭제
 */
exports.onDeleteUserRequest = onDocumentCreated(
  {
    document: 'artifacts/' + APP_ID + '/deleteUserRequests/{requestId}',
    region: REGION
  },
  async (event) => {
    const snap = event.data;
    if (!snap || !snap.exists) return;
    const { userId, requestedBy } = snap.data();
    if (!userId || !requestedBy) {
      logger.warn('onDeleteUserRequest: missing userId or requestedBy', snap.data());
      await snap.ref.delete();
      return;
    }
    const isAdmin = await isAdminByUid(requestedBy);
    if (!isAdmin) {
      logger.warn('onDeleteUserRequest: requestedBy is not admin', { requestedBy, userId });
      await snap.ref.delete();
      return;
    }
    try {
      await recursiveDeleteArtifactUser(userId);
    } catch (e) {
      logger.error('onDeleteUserRequest: Firestore subtree delete failed', { userId, err: e?.message });
      return;
    }
    try {
      await auth.deleteUser(String(userId));
      logger.info('onDeleteUserRequest: Auth user deleted', { userId, requestedBy });
    } catch (err) {
      if (err.code !== 'auth/user-not-found') {
        logger.error('onDeleteUserRequest: deleteUser failed', { userId, err: err.message });
        return;
      }
      logger.info('onDeleteUserRequest: user already gone in Auth', { userId });
    }
    await snap.ref.delete();
  }
);

/**
 * 특정 사용자의 meals 전체를 읽어 daily stats 재집계 (연도별 문서)
 * @param {string} userId
 */
async function rebuildUserStatsForUserId(userId) {
  const mealsRef = db
    .collection('artifacts')
    .doc(APP_ID)
    .collection('users')
    .doc(userId)
    .collection('meals');
  const statsYearsRef = db
    .collection('artifacts')
    .doc(APP_ID)
    .collection('users')
    .doc(userId)
    .collection('config')
    .doc('stats')
    .collection('years');

  const snapshot = await mealsRef.get();
  const meals = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  const daily = computeStatsFromMeals(meals);

  const dailyByYear = {};
  Object.entries(daily).forEach(([dateStr, dayData]) => {
    const year = dateStr.split('-')[0];
    if (!dailyByYear[year]) dailyByYear[year] = {};
    dailyByYear[year][dateStr] = dayData;
  });

  const batch = db.batch();
  Object.entries(dailyByYear).forEach(([year, yearDaily]) => {
    const yearRef = statsYearsRef.doc(year);
    batch.set(yearRef, { daily: yearDaily, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  await batch.commit();

  const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(userId);
  await userRef.set(
    { mealCount: meals.length },
    { merge: true }
  );

  const totalDays = Object.keys(daily).length;
  logger.info('rebuildUserStatsForUserId: completed', {
    userId,
    mealCount: meals.length,
    dayCount: totalDays,
    years: Object.keys(dailyByYear)
  });
  return {
    success: true,
    mealCount: meals.length,
    dayCount: totalDays,
    years: Object.keys(dailyByYear)
  };
}

/**
 * 기존 meals 데이터로 stats 집계 문서 생성/갱신 (Callable) - 연도별 서브컬렉션
 * config/stats/years/{year} 에 연도별로 저장
 */
exports.backfillUserStats = onCall(
  { region: REGION },
  wrapFunction('backfillUserStats', async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    return await rebuildUserStatsForUserId(auth.uid);
  })
);

/**
 * 관리자 전용: 지정 UID의 daily stats 백필 (meals 기준 전체 재집계)
 */
exports.adminBackfillUserStats = onCall(
  { region: REGION },
  wrapFunction('adminBackfillUserStats', async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const isAdmin = await isAdminByUid(auth.uid);
    if (!isAdmin) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }
    const raw = request.data && request.data.targetUserId;
    const targetUserId = typeof raw === 'string' ? raw.trim() : '';
    if (!targetUserId || targetUserId.length < 20) {
      throw new HttpsError('invalid-argument', '유효한 targetUserId(Firebase UID)를 입력해주세요.');
    }
    return await rebuildUserStatsForUserId(targetUserId);
  })
);

/**
 * 루트 문서 createdAt 이 Firestore Timestamp 로 **유효한 날짜**인 경우만 true (깨진 필드·빈 값은 백필 대상)
 */
function hasUsableRootCreatedAt(data) {
  const v = data && data.createdAt;
  if (v == null || v === '') return false;
  try {
    if (typeof v.toDate === 'function') {
      const d = v.toDate();
      return d != null && !Number.isNaN(d.getTime());
    }
    if (v instanceof Timestamp) {
      const d = v.toDate();
      return d != null && !Number.isNaN(d.getTime());
    }
  } catch (_) {
    return false;
  }
  return false;
}

async function resolveAuthUserRecordForUid(uid) {
  try {
    return await auth.getUser(uid);
  } catch (e) {
    if (e && e.code === 'auth/user-not-found') return null;
    throw e;
  }
}

function createdAtTimestampFromAuthUserRecord(ur) {
  const ct = ur && ur.metadata && ur.metadata.creationTime;
  if (!ct) return null;
  const dateObj = new Date(ct);
  if (Number.isNaN(dateObj.getTime())) return null;
  return Timestamp.fromDate(dateObj);
}

/**
 * users 루트 문서 스냅샷 배열에 대해 createdAt 백필 적용 (공통 로직)
 * @returns {{ updated: number, skippedHasDate: number, skippedNoAuth: number, errors: number, writeCount: number }}
 */
async function applyCreatedAtBackfillToUserDocs(docs, dryRun, overwrite) {
  let updated = 0;
  let skippedHasDate = 0;
  let skippedNoAuth = 0;
  let errors = 0;

  const writeBatch = dryRun ? null : db.batch();
  let writeCount = 0;

  for (let offset = 0; offset < docs.length; offset += 100) {
    const slice = docs.slice(offset, offset + 100);
    const identifiers = slice.map((d) => ({ uid: d.id }));
    let getRes;
    try {
      getRes = await auth.getUsers(identifiers);
    } catch (e) {
      logger.error('applyCreatedAtBackfillToUserDocs getUsers', e);
      errors += slice.length;
      continue;
    }
    const byUid = new Map(getRes.users.map((u) => [u.uid, u]));

    for (const d of slice) {
      const uid = d.id;
      const rootData = d.data() || {};

      if (hasUsableRootCreatedAt(rootData) && !overwrite) {
        skippedHasDate++;
        continue;
      }

      let ur = byUid.get(uid);
      if (!ur) {
        try {
          ur = await resolveAuthUserRecordForUid(uid);
        } catch (e) {
          logger.warn('applyCreatedAtBackfillToUserDocs getUser fallback', uid, e.message);
          errors++;
          continue;
        }
      }
      if (!ur) {
        skippedNoAuth++;
        continue;
      }

      const ts = createdAtTimestampFromAuthUserRecord(ur);
      if (!ts) {
        errors++;
        continue;
      }

      updated++;
      if (writeBatch) {
        writeBatch.set(d.ref, { createdAt: ts, uid }, { merge: true });
        writeCount++;
      }
    }
  }

  if (writeBatch && writeCount > 0) {
    await writeBatch.commit();
  }

  return { updated, skippedHasDate, skippedNoAuth, errors, writeCount };
}

/**
 * 관리자 전용: 단일 UID — users/{uid} 루트 createdAt 을 Auth 생성 시각으로 설정 (진단·수동 보정용)
 */
exports.adminBackfillUserRootCreatedAtForUid = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '256MiB' },
  wrapFunction('adminBackfillUserRootCreatedAtForUid', async (request) => {
    const authCtx = request.auth;
    if (!authCtx || !authCtx.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(authCtx.uid))) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }
    const body = request.data || {};
    const dryRun = body.dryRun === true;
    const overwrite = body.overwrite === true;
    const raw = typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
    if (!raw || raw.length < 6) {
      throw new HttpsError('invalid-argument', 'targetUserId(Firebase UID)를 입력해주세요.');
    }

    const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(raw);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return {
        ok: false,
        reason: 'no_firestore_root',
        message: 'users 루트 문서가 없습니다. (Firestore에 해당 UID 문서 없음)',
        targetUserId: raw
      };
    }

    const rootData = userSnap.data() || {};
    if (hasUsableRootCreatedAt(rootData) && !overwrite) {
      return {
        ok: true,
        skipped: true,
        reason: 'already_has_createdAt',
        targetUserId: raw,
        dryRun
      };
    }

    const ur = await resolveAuthUserRecordForUid(raw);
    if (!ur) {
      return {
        ok: false,
        reason: 'auth_user_not_found',
        message: 'Firebase Auth에 해당 UID가 없습니다.',
        targetUserId: raw
      };
    }

    const ts = createdAtTimestampFromAuthUserRecord(ur);
    if (!ts) {
      return {
        ok: false,
        reason: 'auth_no_creation_time',
        message: 'Auth metadata.creationTime 이 없습니다.',
        targetUserId: raw
      };
    }

    if (!dryRun) {
      await userRef.set({ createdAt: ts, uid: raw }, { merge: true });
    }

    return {
      ok: true,
      skipped: false,
      written: !dryRun,
      targetUserId: raw,
      dryRun,
      createdAtIso: ts.toDate().toISOString()
    };
  })
);

/**
 * 관리자 전용: users/{uid} 루트 createdAt 을 Auth UID 최초 생성 시각으로 백필 (페이지 단위)
 * — 한 번에 전체 스캔하지 않고 batchSize(기본 100)씩; 클라이언트가 done 될 때까지 반복 호출
 */
exports.adminBackfillUserRootCreatedAtFromAuth = onCall(
  { region: REGION, timeoutSeconds: 300, memory: '512MiB' },
  wrapFunction('adminBackfillUserRootCreatedAtFromAuth', async (request) => {
    const authCtx = request.auth;
    if (!authCtx || !authCtx.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(authCtx.uid))) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }

    const body = request.data || {};
    const dryRun = body.dryRun === true;
    const overwrite = body.overwrite === true;
    let batchSize = Number(body.batchSize);
    if (!Number.isFinite(batchSize) || batchSize < 1) batchSize = 100;
    if (batchSize > 300) batchSize = 300;

    const startAfterUid =
      typeof body.startAfterUid === 'string' && body.startAfterUid.trim().length > 0
        ? body.startAfterUid.trim()
        : null;

    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    let q = usersRef.orderBy(FieldPath.documentId()).limit(batchSize);
    if (startAfterUid) {
      const cursorSnap = await usersRef.doc(startAfterUid).get();
      if (!cursorSnap.exists) {
        throw new HttpsError(
          'invalid-argument',
          '백필 커서(UID)가 유효하지 않습니다.「전체 백필(서버)」로 처음부터 다시 실행해 주세요.'
        );
      }
      q = usersRef.orderBy(FieldPath.documentId()).startAfter(cursorSnap).limit(batchSize);
    }
    const snap = await q.get();
    if (snap.empty) {
      return {
        done: true,
        nextCursor: null,
        dryRun,
        overwrite,
        batch: {
          scanned: 0,
          updated: 0,
          skippedHasDate: 0,
          skippedNoAuth: 0,
          errors: 0
        }
      };
    }

    const docs = snap.docs;
    const stats = await applyCreatedAtBackfillToUserDocs(docs, dryRun, overwrite);

    const lastId = docs[docs.length - 1].id;
    const done = docs.length < batchSize;

    return {
      done,
      nextCursor: done ? null : lastId,
      dryRun,
      overwrite,
      batch: {
        scanned: docs.length,
        updated: stats.updated,
        skippedHasDate: stats.skippedHasDate,
        skippedNoAuth: stats.skippedNoAuth,
        errors: stats.errors
      }
    };
  })
);

/**
 * 관리자 전용: 서버에서 users 루트 전체를 순회해 createdAt 백필 (클라이언트 다중 호출 불필요)
 */
exports.adminBackfillUserRootCreatedAtFromAuthRunAll = onCall(
  { region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  wrapFunction('adminBackfillUserRootCreatedAtFromAuthRunAll', async (request) => {
    const authCtx = request.auth;
    if (!authCtx || !authCtx.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(authCtx.uid))) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }

    const body = request.data || {};
    const dryRun = body.dryRun === true;
    const overwrite = body.overwrite === true;
    const batchSize = 100;

    const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
    const totals = {
      scanned: 0,
      updated: 0,
      skippedHasDate: 0,
      skippedNoAuth: 0,
      errors: 0
    };
    let rounds = 0;
    let afterDoc = null;
    let lastBatchFull = false;
    const MAX_ROUNDS = 2000;

    while (rounds < MAX_ROUNDS) {
      let q = usersRef.orderBy(FieldPath.documentId()).limit(batchSize);
      if (afterDoc) {
        q = usersRef.orderBy(FieldPath.documentId()).startAfter(afterDoc).limit(batchSize);
      }
      const snap = await q.get();
      if (snap.empty) {
        break;
      }

      const docs = snap.docs;
      rounds++;
      const stats = await applyCreatedAtBackfillToUserDocs(docs, dryRun, overwrite);
      totals.scanned += docs.length;
      totals.updated += stats.updated;
      totals.skippedHasDate += stats.skippedHasDate;
      totals.skippedNoAuth += stats.skippedNoAuth;
      totals.errors += stats.errors;

      afterDoc = docs[docs.length - 1];
      lastBatchFull = docs.length >= batchSize;
      if (docs.length < batchSize) {
        break;
      }
    }

    return {
      ok: true,
      dryRun,
      overwrite,
      rounds,
      totals,
      truncated: rounds >= MAX_ROUNDS && lastBatchFull
    };
  })
);

/**
 * @deprecated 본식 슬롯 다건 허용 — 중복 삭제하지 않음 (하위 호환용 no-op)
 */
exports.removeDuplicateMeals = onCall(
  { region: REGION },
  wrapFunction('removeDuplicateMeals', async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    return { success: true, deletedCount: 0 };
  })
);

/**
 * 둘러보기: 데모 계정(dummy@mealog.net) 커스텀 토큰 발급
 * 비로그인 호출 허용 — 클라이언트의 signInWithPassword(reCAPTCHA Enterprise) 실패·config 비번 불일치 회피
 */
exports.signInAsDemo = onCall({ region: REGION }, wrapFunction('signInAsDemo', async () => {
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(READ_ONLY_DEMO_EMAIL);
  } catch (e) {
    if (e.code === 'auth/user-not-found') {
      throw new HttpsError(
        'failed-precondition',
        `Firebase Auth에 ${READ_ONLY_DEMO_EMAIL} 사용자가 없습니다.`
      );
    }
    logger.error('signInAsDemo getUserByEmail', e);
    throw new HttpsError('internal', '데모 계정 조회에 실패했습니다.');
  }
  const customToken = await auth.createCustomToken(userRecord.uid, { demoBrowse: true });
  return { customToken };
}));

/** 카카오 OIDC id_token(JWT) 페이로드에서 email (openid 스코프·콘솔 OIDC 설정 시) */
function parseKakaoIdTokenEmail(jwt) {
  if (!jwt || typeof jwt !== 'string') return '';
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return '';
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const pl = JSON.parse(json);
    const em = typeof pl.email === 'string' ? pl.email.trim().toLowerCase() : '';
    if (em && em.includes('@')) return em.slice(0, 254);
  } catch (e) {
    logger.warn('parseKakaoIdTokenEmail', { err: e?.message });
  }
  return '';
}

/**
 * Capacitor 앱용 카카오 인가 URL (REST API 키는 서버에서만 사용)
 * redirectUri는 Kakao 콘솔에 등록된 값과 동일해야 하며, signInWithKakao 토큰 교환 시에도 동일 문자열 필요
 */
exports.getKakaoOAuthAuthorizeUrl = onCall(
  { region: REGION },
  wrapFunction('getKakaoOAuthAuthorizeUrl', async (request) => {
    const data = request.data || {};
    const redirectUri = typeof data.redirectUri === 'string' ? data.redirectUri.trim() : '';
    if (!redirectUri || redirectUri.length > 2048) {
      throw new HttpsError('invalid-argument', 'redirectUri가 필요합니다.');
    }
    if (!/^https:\/\//i.test(redirectUri) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(redirectUri)) {
      throw new HttpsError('invalid-argument', 'redirectUri 형식이 올바르지 않습니다.');
    }
    const stateRaw = data.state;
    const state =
      typeof stateRaw === 'string' && stateRaw.length > 0 && stateRaw.length <= 512 ? stateRaw.trim() : '';
    const clientId = kakaoRestApiKey.value();
    if (!clientId) {
      throw new HttpsError(
        'failed-precondition',
        'KAKAO_REST_API_KEY가 설정되지 않았습니다. functions/.env에 설정 후 재배포하세요.'
      );
    }
    const u = new URL('https://kauth.kakao.com/oauth/authorize');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set(
      'scope',
      'profile_nickname profile_image account_email openid'
    );
    if (state) {
      u.searchParams.set('state', state);
    }
    return { authorizeUrl: u.toString() };
  })
);

/**
 * 카카오 로그인: (1) 인가 코드 → kauth 토큰 교환 또는 (2) 액세스 토큰 직접 검증 후 Firebase 커스텀 토큰
 * UID 형식 kakao_{카카오회원번호} — 비로그인 호출 허용
 * 토큰 교환에는 REST API 키(client_id) 사용. 앱에서 클라이언트 시크릿을 켠 경우 functions/.env KAKAO_CLIENT_SECRET
 */
exports.signInWithKakao = onCall({ region: REGION }, wrapFunction('signInWithKakao', async (request) => {
  const data = request.data || {};
  let accessToken = typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
  let idTokenFromKauth = '';
  const code = typeof data.code === 'string' ? data.code.trim() : '';
  const redirectUri = typeof data.redirectUri === 'string' ? data.redirectUri.trim() : '';

  if (code) {
    if (!redirectUri || redirectUri.length > 2048) {
      throw new HttpsError('invalid-argument', 'redirectUri가 필요합니다.');
    }
    if (!/^https:\/\//i.test(redirectUri) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(redirectUri)) {
      throw new HttpsError('invalid-argument', 'redirectUri 형식이 올바르지 않습니다.');
    }
    const clientId = kakaoRestApiKey.value();
    if (!clientId) {
      throw new HttpsError(
        'failed-precondition',
        'KAKAO_REST_API_KEY가 설정되지 않았습니다. functions/.env에 설정 후 재배포하세요.'
      );
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code
    });
    const clientSecret = process.env.KAKAO_CLIENT_SECRET;
    if (clientSecret) {
      body.append('client_secret', clientSecret);
    }
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      logger.warn('signInWithKakao: token exchange failed', {
        status: tokenRes.status,
        err: tokenJson?.error,
        desc: tokenJson?.error_description
      });
      const kakaoErr = tokenJson?.error;
      const kakaoDesc = String(tokenJson?.error_description || '');
      let clientMsg =
        tokenJson?.error_description || tokenJson?.error || '카카오 토큰 발급에 실패했습니다.';
      if (kakaoErr === 'invalid_client' || /bad client credentials/i.test(kakaoDesc)) {
        clientMsg =
          '카카오 서버 인증 실패: Firebase Functions의 KAKAO_REST_API_KEY는 반드시 같은 앱의 REST API 키여야 합니다. ' +
          '카카오 개발자 콘솔에서 클라이언트 시크릿을 사용 중이면 KAKAO_CLIENT_SECRET도 설정·재배포하세요.';
      }
      throw new HttpsError('unauthenticated', clientMsg);
    }
    accessToken = tokenJson.access_token || '';
    idTokenFromKauth = typeof tokenJson.id_token === 'string' ? tokenJson.id_token.trim() : '';
    logger.info('signInWithKakao token meta', {
      scope: typeof tokenJson.scope === 'string' ? tokenJson.scope.slice(0, 160) : '',
      hasIdToken: !!idTokenFromKauth
    });
  }

  if (!accessToken || accessToken.length > 4096) {
    throw new HttpsError('invalid-argument', '유효한 로그인 정보가 없습니다. 다시 시도해 주세요.');
  }

  // 이메일: POST(property_keys) → 실패 시 GET. 동의·앱 설정에 따라 한쪽만 값이 오는 경우가 있음
  const propertyKeys = JSON.stringify(['kakao_account.profile', 'kakao_account.email']);
  let meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
    },
    body: new URLSearchParams({ property_keys: propertyKeys }).toString()
  });
  if (!meRes.ok) {
    meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
  }
  if (!meRes.ok) {
    const body = await meRes.text().catch(() => '');
    logger.warn('signInWithKakao: kapi user/me failed', { status: meRes.status, body: body.slice(0, 200) });
    throw new HttpsError('unauthenticated', '카카오 로그인이 만료되었거나 유효하지 않습니다.');
  }
  let me = await meRes.json();
  const kaProbe = me?.kakao_account || {};
  if (typeof kaProbe.email !== 'string' || !String(kaProbe.email).includes('@')) {
    const getRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (getRes.ok) {
      const meGet = await getRes.json().catch(() => ({}));
      const kaG = meGet?.kakao_account || {};
      if (typeof kaG.email === 'string' && String(kaG.email).includes('@')) {
        me = meGet;
      }
    }
  }
  const kakaoId = me?.id;
  if (kakaoId == null || (typeof kakaoId !== 'number' && typeof kakaoId !== 'string')) {
    throw new HttpsError('internal', '카카오 사용자 정보를 확인할 수 없습니다.');
  }
  const uid = `kakao_${kakaoId}`;
  const ka = me?.kakao_account || {};
  logger.info('signInWithKakao kakao_account', {
    has_email: ka.has_email === true,
    email_needs_agreement: ka.email_needs_agreement === true,
    is_email_valid: ka.is_email_valid,
    hasEmailString: typeof ka.email === 'string' && ka.email.includes('@')
  });
  const profile = ka.profile;
  const nickname =
    profile && typeof profile.nickname === 'string' ? profile.nickname.trim().slice(0, 64) : '';
  let photoURL;
  if (profile && typeof profile.thumbnail_image_url === 'string' && profile.thumbnail_image_url.length < 2048) {
    photoURL = profile.thumbnail_image_url;
  } else if (profile && typeof profile.profile_image_url === 'string' && profile.profile_image_url.length < 2048) {
    photoURL = profile.profile_image_url;
  }

  let email = '';
  if (typeof ka.email === 'string') {
    const t = ka.email.trim().toLowerCase();
    if (t && t.includes('@') && ka.is_email_valid !== false) {
      email = t.slice(0, 254);
    }
  }
  if (!email && idTokenFromKauth) {
    email = parseKakaoIdTokenEmail(idTokenFromKauth);
    if (email) {
      logger.info('signInWithKakao: email from id_token');
    }
  }
  // openid 스코프 시 /v2/user/me에 없어도 OIDC userinfo에 email이 올 수 있음 (콘솔에서 OIDC 활성화 필요)
  if (!email) {
    const oiRes = await fetch('https://kapi.kakao.com/v1/oidc/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (oiRes.ok) {
      const oi = await oiRes.json().catch(() => ({}));
      const em = typeof oi.email === 'string' ? oi.email.trim().toLowerCase() : '';
      if (em && em.includes('@')) {
        email = em.slice(0, 254);
        logger.info('signInWithKakao: email from OIDC userinfo');
      } else if (oi && typeof oi === 'object') {
        logger.info('signInWithKakao oidc userinfo keys', { keys: Object.keys(oi).join(',') });
      }
    } else {
      const ob = await oiRes.text().catch(() => '');
      logger.warn('signInWithKakao: oidc userinfo failed', {
        status: oiRes.status,
        body: ob.slice(0, 180)
      });
    }
  }

  let existing;
  try {
    existing = await auth.getUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') {
      logger.error('signInWithKakao getUser', e);
      throw new HttpsError('internal', '사용자 조회에 실패했습니다.');
    }
    existing = null;
  }

  const createPayload = { uid, disabled: false };
  if (nickname) createPayload.displayName = nickname;
  if (photoURL) createPayload.photoURL = photoURL;
  if (email) {
    createPayload.email = email;
    if (ka.is_email_verified === true) {
      createPayload.emailVerified = true;
    }
  }

  if (!existing) {
    try {
      await auth.createUser(createPayload);
    } catch (ce) {
      if (ce.code === 'auth/email-already-exists' && createPayload.email) {
        delete createPayload.email;
        delete createPayload.emailVerified;
        try {
          await auth.createUser(createPayload);
        } catch (ce2) {
          logger.error('signInWithKakao createUser', ce2);
          throw new HttpsError('internal', '계정 생성에 실패했습니다.');
        }
      } else {
        logger.error('signInWithKakao createUser', ce);
        throw new HttpsError('internal', '계정 생성에 실패했습니다.');
      }
    }
  } else {
    const patch = {};
    if (nickname && nickname !== (existing.displayName || '')) {
      patch.displayName = nickname;
    }
    if (photoURL && photoURL !== (existing.photoURL || '')) {
      patch.photoURL = photoURL;
    }
    const prevEmail = (existing.email || '').toLowerCase();
    if (email && email !== prevEmail) {
      patch.email = email;
      patch.emailVerified = ka.is_email_verified === true;
    }
    if (Object.keys(patch).length) {
      try {
        await auth.updateUser(uid, patch);
      } catch (ue) {
        if (ue.code === 'auth/email-already-exists' && patch.email) {
          delete patch.email;
          delete patch.emailVerified;
          if (Object.keys(patch).length) {
            try {
              await auth.updateUser(uid, patch);
            } catch (ue2) {
              logger.warn('signInWithKakao updateUser', ue2);
            }
          }
        } else {
          logger.warn('signInWithKakao updateUser', ue);
        }
      }
    }
  }

  const customToken = await auth.createCustomToken(uid, { kakao: true });
  return {
    customToken,
    kakaoEmail: email || null,
    kakaoEmailNeedsAgreement: ka.email_needs_agreement === true,
    kakaoNickname: nickname || null
  };
}));

function normalizeNicknameForClaimServer(nickname) {
  if (!nickname || typeof nickname !== 'string') return null;
  const t = nickname.trim();
  if (!t || t === '게스트') return null;
  try {
    return t.normalize('NFKC').toLowerCase();
  } catch {
    return t.toLowerCase();
  }
}

function nicknameClaimDocIdServer(normalized) {
  if (!normalized) return '';
  const clipped = normalized.length > 200 ? normalized.slice(0, 200) : normalized;
  return encodeURIComponent(clipped);
}

/**
 * artifacts/{APP_ID}/users/{uid} 루트 문서 병합 (Admin) — 클라이언트 setDoc이 permission-denied일 때 폴백
 */
exports.patchArtifactUserRoot = onCall({ region: REGION }, wrapFunction('patchArtifactUserRoot', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const tokenEmail = request.auth.token?.email;
  if (tokenEmail && String(tokenEmail).toLowerCase().trim() === READ_ONLY_DEMO_EMAIL) {
    throw new HttpsError('permission-denied', '샘플 계정에서는 사용할 수 없습니다.');
  }
  const uid = request.auth.uid;
  const body = request.data || {};
  const ref = db.doc(`artifacts/${APP_ID}/users/${uid}`);
  const patch = {
    lastLoginAt: FieldValue.serverTimestamp()
  };
  if (body.setCreatedAt === true) {
    const ms =
      typeof body.createdAtMillis === 'number' && Number.isFinite(body.createdAtMillis)
        ? Math.floor(body.createdAtMillis)
        : null;
    const now = Date.now();
    // 클라이언트가 Auth UID 생성 시각(ms)을 넘기면 그대로 기록(구버전·누락 시 serverTimestamp)
    if (ms != null && ms >= 946684800000 && ms <= now + 7 * 86400000) {
      patch.createdAt = Timestamp.fromMillis(ms);
    } else {
      patch.createdAt = FieldValue.serverTimestamp();
    }
  }
  if (typeof body.providerId === 'string' && body.providerId.trim()) {
    patch.providerId = body.providerId.trim();
  }
  if (typeof body.email === 'string' && body.email.includes('@')) {
    patch.email = String(body.email).trim().toLowerCase().slice(0, 254);
  }
  await ref.set(patch, { merge: true });
  return { ok: true };
}));

/**
 * 사용자 설정 + 닉네임 클레임을 Admin으로 저장 (클라이언트 Firestore/App Check permission-denied 시 폴백)
 */
exports.saveArtifactUserSettings = onCall({ region: REGION }, wrapFunction('saveArtifactUserSettings', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const tokenEmail = request.auth.token?.email;
  if (tokenEmail && String(tokenEmail).toLowerCase().trim() === READ_ONLY_DEMO_EMAIL) {
    throw new HttpsError('permission-denied', '샘플 계정에서는 설정을 변경할 수 없습니다.');
  }
  const uid = request.auth.uid;
  const settings = request.data?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new HttpsError('invalid-argument', 'settings 객체가 필요합니다.');
  }
  let payloadSize = 0;
  try {
    payloadSize = JSON.stringify(settings).length;
  } catch {
    throw new HttpsError('invalid-argument', 'settings를 직렬화할 수 없습니다.');
  }
  if (payloadSize > 400000) {
    throw new HttpsError('invalid-argument', 'settings 크기가 너무 큽니다.');
  }

  const settingsRef = db.doc(`artifacts/${APP_ID}/users/${uid}/config/settings`);
  const oldSnap = await settingsRef.get();
  const oldData = oldSnap.exists ? oldSnap.data() : {};
  const normOld = normalizeNicknameForClaimServer(oldData.profile?.nickname);
  const normNew = normalizeNicknameForClaimServer(settings.profile?.nickname);

  const newClaimRefTx = normNew
    ? db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normNew)}`)
    : null;
  const oldClaimRefTx =
    normOld && normOld !== normNew
      ? db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normOld)}`)
      : null;

  await db.runTransaction(async (transaction) => {
    /** Firestore: 트랜잭션 내 모든 read(get)은 write(set/delete)보다 먼저 실행되어야 함 */
    const newClaimSnap = newClaimRefTx ? await transaction.get(newClaimRefTx) : null;
    const oldClaimSnap = oldClaimRefTx ? await transaction.get(oldClaimRefTx) : null;
    let ownerSettingsSnap = null;
    if (newClaimSnap && newClaimSnap.exists) {
      const owner = newClaimSnap.data()?.userId;
      if (owner && owner !== uid) {
        const ownerSettingsRef = db.doc(`artifacts/${APP_ID}/users/${owner}/config/settings`);
        ownerSettingsSnap = await transaction.get(ownerSettingsRef);
      }
    }

    if (normNew && newClaimSnap && newClaimSnap.exists) {
      const owner = newClaimSnap.data()?.userId;
      if (owner && owner !== uid) {
        const ownerNorm = normalizeNicknameForClaimServer(
          ownerSettingsSnap && ownerSettingsSnap.exists
            ? ownerSettingsSnap.data()?.profile?.nickname
            : null
        );
        if (ownerNorm === normNew) {
          throw new HttpsError('already-exists', '이미 사용 중인 닉네임입니다.');
        }
        transaction.delete(newClaimRefTx);
      }
    }
    if (
      normOld &&
      normOld !== normNew &&
      oldClaimSnap &&
      oldClaimSnap.exists &&
      oldClaimSnap.data()?.userId === uid
    ) {
      transaction.delete(oldClaimRefTx);
    }
    transaction.set(settingsRef, settings, { merge: true });
    if (normNew && newClaimRefTx) {
      const displayNickname = String(settings.profile?.nickname || '').trim();
      transaction.set(newClaimRefTx, {
        userId: uid,
        normalizedNickname: normNew,
        displayNickname: displayNickname || normNew,
        updatedAt: new Date().toISOString()
      });
    }
  });

  /** 약관 메타만 있고 termsAgreed 가 빠진 문서 보정 + 루트 createdAt 없으면 백필 (클라이언트 전용 쓰기 성공 시에도 루트만 누락되는 경우 대비) */
  try {
    let mSnap = await settingsRef.get();
    let m = mSnap.exists ? mSnap.data() : {};
    const hasTermsMeta =
      m.termsAgreedAt != null || (m.termsVersion != null && String(m.termsVersion).trim() !== '');
    const termsAgreedNorm =
      m.termsAgreed === true || m.termsAgreed === 'true' || m.termsAgreed === 1;
    if (hasTermsMeta && !termsAgreedNorm) {
      await settingsRef.set({ termsAgreed: true }, { merge: true });
      mSnap = await settingsRef.get();
      m = mSnap.exists ? mSnap.data() : {};
    }

    const rootRef = db.doc(`artifacts/${APP_ID}/users/${uid}`);
    const rootSnap = await rootRef.get();
    const rootCreated = rootSnap.exists && rootSnap.data().createdAt;
    const hasTermsMeta2 =
      m.termsAgreedAt != null || (m.termsVersion != null && String(m.termsVersion).trim() !== '');
    const termsOk =
      m.termsAgreed === true || m.termsAgreed === 'true' || m.termsAgreed === 1;
    const shouldBackfillCreated =
      !rootCreated && (m.profileCompleted === true || hasTermsMeta2 || termsOk);
    if (shouldBackfillCreated) {
      const pc = adminSettingsValueToDate(m.profileCompletedAt);
      const ta = adminSettingsValueToDate(m.termsAgreedAt);
      const cand = [pc, ta].filter((d) => d instanceof Date && !Number.isNaN(d.getTime()));
      const earliest =
        cand.length > 0 ? new Date(Math.min(...cand.map((d) => d.getTime()))) : null;
      await rootRef.set(
        {
          uid,
          createdAt: earliest ? Timestamp.fromDate(earliest) : FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    } else {
      await rootRef.set({ uid }, { merge: true });
    }
  } catch (e) {
    logger.warn('saveArtifactUserSettings: post-save normalize / user root', { uid, err: e?.message });
    try {
      await db.doc(`artifacts/${APP_ID}/users/${uid}`).set({ uid }, { merge: true });
    } catch (e2) {
      logger.warn('saveArtifactUserSettings: user root set skipped', { uid, err: e2?.message });
    }
  }

  return { ok: true };
}));

/**
 * 관리자: 특정 사용자의 닉네임 변경 (Firestore rules상 타인 설정 직접 쓰기 불가 → Admin SDK)
 */
exports.adminSetUserNickname = onCall({ region: REGION }, wrapFunction('adminSetUserNickname', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const callerUid = request.auth.uid;
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', '관리자만 변경할 수 있습니다.');
  }

  const targetUid = typeof request.data?.userId === 'string' ? request.data.userId.trim() : '';
  const rawNick = request.data?.nickname;
  const nickname =
    typeof rawNick === 'string'
      ? rawNick.trim()
      : rawNick != null && typeof rawNick !== 'object'
        ? String(rawNick).trim()
        : '';

  if (!targetUid) {
    throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
  }
  if (!nickname) {
    throw new HttpsError('invalid-argument', '닉네임을 입력해 주세요.');
  }
  if (nickname === '게스트') {
    throw new HttpsError('invalid-argument', '사용할 수 없는 닉네임입니다.');
  }
  if (nickname.length > 20) {
    throw new HttpsError('invalid-argument', '닉네임은 20자 이하입니다.');
  }

  const settingsRef = db.doc(`artifacts/${APP_ID}/users/${targetUid}/config/settings`);
  const oldSnap = await settingsRef.get();
  const oldData = oldSnap.exists ? oldSnap.data() : {};
  const prevProfile =
    oldData.profile && typeof oldData.profile === 'object' && !Array.isArray(oldData.profile)
      ? { ...oldData.profile }
      : {};
  if (!prevProfile.icon) {
    prevProfile.icon = '🐻';
  }
  prevProfile.nickname = nickname;

  const mergedSettings = {
    ...oldData,
    profile: prevProfile
  };

  const normOld = normalizeNicknameForClaimServer(oldData.profile?.nickname);
  const normNew = normalizeNicknameForClaimServer(nickname);

  const newClaimRefAdmin = normNew
    ? db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normNew)}`)
    : null;
  const oldClaimRefAdmin =
    normOld && normOld !== normNew
      ? db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normOld)}`)
      : null;

  await db.runTransaction(async (transaction) => {
    /** Firestore: 트랜잭션 내 모든 read(get)은 write(set/delete)보다 먼저 실행되어야 함 */
    const newClaimSnap = newClaimRefAdmin ? await transaction.get(newClaimRefAdmin) : null;
    const oldClaimSnap = oldClaimRefAdmin ? await transaction.get(oldClaimRefAdmin) : null;
    let ownerSettingsSnap = null;
    if (newClaimSnap && newClaimSnap.exists) {
      const owner = newClaimSnap.data()?.userId;
      if (owner && owner !== targetUid) {
        const ownerSettingsRef = db.doc(`artifacts/${APP_ID}/users/${owner}/config/settings`);
        ownerSettingsSnap = await transaction.get(ownerSettingsRef);
      }
    }

    if (normNew && newClaimSnap && newClaimSnap.exists) {
      const owner = newClaimSnap.data()?.userId;
      if (owner && owner !== targetUid) {
        const ownerNorm = normalizeNicknameForClaimServer(
          ownerSettingsSnap && ownerSettingsSnap.exists
            ? ownerSettingsSnap.data()?.profile?.nickname
            : null
        );
        if (ownerNorm === normNew) {
          throw new HttpsError('already-exists', '이미 사용 중인 닉네임입니다.');
        }
        transaction.delete(newClaimRefAdmin);
      }
    }
    if (
      normOld &&
      normOld !== normNew &&
      oldClaimSnap &&
      oldClaimSnap.exists &&
      oldClaimSnap.data()?.userId === targetUid
    ) {
      transaction.delete(oldClaimRefAdmin);
    }
    transaction.set(settingsRef, mergedSettings, { merge: true });
    if (normNew && newClaimRefAdmin) {
      transaction.set(newClaimRefAdmin, {
        userId: targetUid,
        normalizedNickname: normNew,
        displayNickname: nickname,
        updatedAt: new Date().toISOString()
      });
    }
  });

  try {
    await db.doc(`artifacts/${APP_ID}/users/${targetUid}`).set({ uid: targetUid }, { merge: true });
  } catch (e) {
    logger.warn('adminSetUserNickname: user root set', { targetUid, err: e?.message });
  }

  logger.info('adminSetUserNickname', { callerUid, targetUid, nicknameLen: nickname.length });
  return { ok: true };
}));

/** Callable meal 페이로드: undefined 제거 (Admin 쓰기용) */
function stripUndefinedDeepMealPayload(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeepMealPayload).filter((v) => v !== undefined);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const next = stripUndefinedDeepMealPayload(v);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

function sanitizeMealPhotosForServer(meal) {
  const m = meal && typeof meal === 'object' ? { ...meal } : {};
  const san = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => typeof p === 'string' && p && !p.startsWith('data:image'));
  };
  if (Object.prototype.hasOwnProperty.call(m, 'photos')) m.photos = san(m.photos);
  if (Object.prototype.hasOwnProperty.call(m, 'sharedPhotos')) m.sharedPhotos = san(m.sharedPhotos);
  return m;
}

/**
 * 식사 기록 저장 (Callable) — 클라이언트 Firestore permission-denied 시 Admin 폴백
 */
exports.saveArtifactUserMeal = onCall({ region: REGION }, wrapFunction('saveArtifactUserMeal', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(request.auth);
  const uid = request.auth.uid;
  const ban = await getUserBan(uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '기록 작성이 제한된 계정입니다.');
  }
  await checkRateLimit(uid, 'interaction', request);

  const rawMeal = request.data?.meal;
  if (!rawMeal || typeof rawMeal !== 'object' || Array.isArray(rawMeal)) {
    throw new HttpsError('invalid-argument', 'meal 객체가 필요합니다.');
  }
  let payloadSize = 0;
  try {
    payloadSize = JSON.stringify(rawMeal).length;
  } catch {
    throw new HttpsError('invalid-argument', 'meal을 직렬화할 수 없습니다.');
  }
  if (payloadSize > 900000) {
    throw new HttpsError('invalid-argument', 'meal 데이터가 너무 큽니다.');
  }

  const mealIdRaw = request.data?.mealId;
  const mealIdStr =
    typeof mealIdRaw === 'string' && mealIdRaw.trim()
      ? mealIdRaw.trim()
      : null;

  let cleaned = sanitizeMealPhotosForServer(stripUndefinedDeepMealPayload(rawMeal));
  if (Object.prototype.hasOwnProperty.call(cleaned, 'id')) {
    delete cleaned.id;
  }
  delete cleaned.recordedAt;

  const coll = db.collection('artifacts').doc(APP_ID).collection('users').doc(uid).collection('meals');
  const mealRef = mealIdStr ? coll.doc(mealIdStr) : coll.doc();
  const existingSnap = mealIdStr ? await mealRef.get() : null;
  const existedBefore = existingSnap && existingSnap.exists;

  if (existedBefore && existingSnap.data()?.recordedAt != null) {
    cleaned.recordedAt = existingSnap.data().recordedAt;
  } else {
    // 신규 문서이거나 recordedAt 누락: 슬롯 날짜로 추론하지 않고 이번 저장 시각(ISO)으로 둔다
    cleaned.recordedAt = new Date().toISOString();
  }

  // sharedPhotos는 sharedPhotos 컬렉션이 canonical — meal 저장 시 기존 미러만 보존
  if (existedBefore && existingSnap.data()?.sharedPhotos != null) {
    cleaned.sharedPhotos = existingSnap.data().sharedPhotos;
  } else {
    delete cleaned.sharedPhotos;
  }

  await mealRef.set(cleaned, { merge: false });

  if (!mealIdStr || !existedBefore) {
    try {
      await db.doc(`artifacts/${APP_ID}/users/${uid}`).set(
        { mealCount: FieldValue.increment(1) },
        { merge: true }
      );
    } catch (e) {
      logger.warn('saveArtifactUserMeal: mealCount increment skipped', { uid, err: e?.message });
    }
  }

  return { mealId: mealRef.id };
}));

/**
 * 식사 기록 삭제 (Callable) — 클라이언트 Firestore permission-denied 시 Admin 폴백
 */
exports.deleteArtifactUserMeal = onCall({ region: REGION }, wrapFunction('deleteArtifactUserMeal', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(request.auth);
  const uid = request.auth.uid;
  const ban = await getUserBan(uid);
  if (ban.bannedWrite) {
    throw new HttpsError('permission-denied', '기록 삭제가 제한된 계정입니다.');
  }

  const mealId = typeof request.data?.mealId === 'string' ? request.data.mealId.trim() : '';
  if (!mealId) {
    throw new HttpsError('invalid-argument', 'mealId가 필요합니다.');
  }

  const mealRef = db.doc(`artifacts/${APP_ID}/users/${uid}/meals/${mealId}`);
  const mealSnap = await mealRef.get();
  if (!mealSnap.exists) {
    return { deleted: false };
  }

  await mealRef.delete();

  try {
    await db.doc(`artifacts/${APP_ID}/users/${uid}`).set(
      { mealCount: FieldValue.increment(-1) },
      { merge: true }
    );
  } catch (e) {
    logger.warn('deleteArtifactUserMeal: mealCount decrement skipped', { uid, err: e?.message });
  }

  try {
    const sharedQ = await db
      .collection('artifacts')
      .doc(APP_ID)
      .collection('sharedPhotos')
      .where('entryId', '==', mealId)
      .where('userId', '==', uid)
      .get();
    if (!sharedQ.empty) {
      const batch = db.batch();
      sharedQ.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (e) {
    logger.warn('deleteArtifactUserMeal: sharedPhotos cleanup failed', { uid, mealId, err: e?.message });
  }

  return { deleted: true };
}));

/**
 * usageDaily 에 받아 줄 필드 — js/admin/dashboard.js 의
 * PAGE_VIEW_METRIC_DEFS · RECORD_USAGE_METRIC_DEFS 와 **양쪽 다** 동기화한다.
 *
 * 여기 없는 키는 invalid-argument 로 거절된다. 클라이언트는 Firestore 직접 쓰기로
 * 폴백하지만 그 경로는 로컬 캐시에만 앉는 경우가 있어(js/usage-metrics.js) 서버에는
 * 아무것도 남지 않는다. 즉 **키를 빠뜨리면 조용히 유실된다** — 대시보드에 행은
 * 보이는데 값만 0 으로 남아서, 기능이 안 쓰이는 것과 구분되지 않는다.
 * 실제로 기록 시트 개편 계측 21종이 그렇게 통째로 날아갔다 (2026-08-12~26).
 *
 * 행을 추가할 때는 dashboard.js 와 이 목록을 한 커밋에서 같이 고칠 것.
 */
const USAGE_DAILY_METRIC_KEYS = new Set([
  // --- 페이지 방문·조작 (PAGE_VIEW_METRIC_DEFS) ---
  'tab_mealdang',
  'mealdang_comment_click',
  'mealdang_analysis_detail_click',
  'mealdang_analysis_cuisine_axis',
  'tab_moment',
  'tab_mealog',
  'lounge_mealtalk',
  'lounge_board',
  'lounge_notice',
  'settings_profile',
  // 나만의 태그 제거로 호출부는 없어졌지만 과거 이력이 남아 있어 목록에 둔다
  'settings_tags',
  'settings_mealdang_memo',
  'settings_push',
  // 밀로그 타임라인 「같이 먹자」 앱 소개 배너 탭 (js/render/promo-banner.js)
  'promo_eat_together_click',

  // --- 기록 시트 안에서 벌어지는 일 (RECORD_USAGE_METRIC_DEFS) ---
  'entry_sheet_opened',
  'entry_sheet_saved',
  'entry_sheet_abandoned',
  'entry_sheet_discarded',
  'what_recall_shown',
  'what_recall_picked',
  'what_typeahead_shown',
  'what_typeahead_picked',
  'category_suggest_shown',
  'category_suggest_confirmed',
  'category_suggest_auto_saved',
  'category_suggest_grid_opened',
  'category_suggest_dismissed',
  'category_suggest_undismissed',
  'context_predict_shown',
  'context_predict_applied',
  'context_predict_dismissed',
  'context_predict_auto_saved',
  'context_place_typed',
  // 어디서 인라인 검색 — 내 이력에서 찾았나, 지도까지 갔나 (js/modals/entry-context-predict.js)
  'context_place_found_recent',
  'context_place_picked_recent',
  'context_place_found_kakao',
  'context_place_picked_kakao',
  'context_sub_picked',
  'context_sub_added',
  'context_sub_deleted',
  'photo_gps_present',
  'photo_gps_absent'
]);

/** firestore.rules · js/excluded-analytics-uids.js DEFAULT 과 동기화 */
const DEFAULT_EXCLUDED_USAGE_ANALYTICS_UIDS = new Set([
  'kakao_4833862234',
  'IYRL3bfBhKUrwJM6tb8h4BVX8DF3',
  '4UDeI0Bts0gkwnnrt1WNRgjOQ5x2'
]);

function isProductionUsageSource(data) {
  const capAppId = typeof data?.capAppId === 'string' ? data.capAppId.trim() : '';
  if (capAppId === 'com.mealog.app.staging') return false;
  if (capAppId === 'com.mealog.app') return true;
  // 네이티브(설치형)는 Capacitor 가 config.appId 를 주입하지 않아 capAppId 가 비고, 번들 앱은
  // WebView 호스트가 localhost 라 호스트 판별도 불가하다. 빌드시 확정되는 APP_ENV 로 판별.
  const isNative = data?.isNative === true;
  const appEnv = typeof data?.appEnv === 'string' ? data.appEnv.toLowerCase().trim() : '';
  if (isNative) {
    if (appEnv === 'staging') return false;
    if (appEnv === 'production') return true;
  }
  const webHost = typeof data?.webHost === 'string' ? data.webHost.toLowerCase().trim() : '';
  return webHost === 'www.mealog.net' || webHost === 'mealog.net';
}

async function isUidExcludedFromUsageAnalytics(uid) {
  if (!uid) return true;
  try {
    const snap = await db.doc(`artifacts/${APP_ID}/adminSettings/excludedAnalyticsUids`).get();
    if (!snap.exists) return DEFAULT_EXCLUDED_USAGE_ANALYTICS_UIDS.has(uid);
    const map = snap.data()?.excludedUidMap;
    if (map && typeof map === 'object') return map[uid] === true;
    const uids = snap.data()?.uids;
    if (Array.isArray(uids)) return uids.includes(uid);
    return false;
  } catch (e) {
    logger.warn('isUidExcludedFromUsageAnalytics read failed', { uid, err: e?.message });
    return DEFAULT_EXCLUDED_USAGE_ANALYTICS_UIDS.has(uid);
  }
}

/**
 * 페이지별 usageDaily increment (클라이언트 Firestore/App Check 실패 시 폴백, Admin SDK)
 */
exports.logUsageMetric = onCall({ region: REGION }, wrapFunction('logUsageMetric', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(request.auth);
  const uid = request.auth.uid;
  if (!isProductionUsageSource(request.data || {})) {
    return { ok: true, skipped: true, reason: 'not_production' };
  }
  if (await isUidExcludedFromUsageAnalytics(uid)) {
    return { ok: true, skipped: true, reason: 'excluded_uid' };
  }
  const key = typeof request.data?.key === 'string' ? request.data.key.trim() : '';
  if (!key || !USAGE_DAILY_METRIC_KEYS.has(key)) {
    throw new HttpsError('invalid-argument', '유효한 usage metric key가 필요합니다.');
  }
  const dateKey = kstYmdFromMillis(Date.now());
  if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) {
    throw new HttpsError('internal', 'usageDaily dateKey 생성 실패');
  }
  const ref = db.doc(`artifacts/${APP_ID}/usageDaily/${dateKey}`);
  await ref.set(
    {
      [key]: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return { ok: true, dateKey, key };
}));

/**
 * FCM 토큰 등록 (클라이언트 Firestore/App Check permission-denied 시 폴백, Admin 병합)
 */
exports.registerFcmToken = onCall({ region: REGION }, wrapFunction('registerFcmToken', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(request.auth);
  const uid = request.auth.uid;
  const token = typeof request.data?.token === 'string' ? request.data.token.trim() : '';
  const envRaw = request.data?.env;
  const env =
    typeof envRaw === 'string' && envRaw.trim()
      ? envRaw.trim().slice(0, 32)
      : '';
  if (!token || token.length < 20 || token.length > 4096) {
    throw new HttpsError('invalid-argument', '유효한 FCM 토큰이 필요합니다.');
  }
  const ref = db.doc(`artifacts/${APP_ID}/users/${uid}/config/fcmTokens`);
  const snap = await ref.get();
  const prev = (snap.exists && snap.data().tokens && typeof snap.data().tokens === 'object') ? snap.data().tokens : {};
  const entry = { updatedAt: FieldValue.serverTimestamp() };
  if (env) entry.env = env;
  const tokens = pruneUserFcmTokens(prev, token, entry);
  await ref.set({ tokens }, { merge: true });
  return { ok: true };
}));

/**
 * Gemini API 프록시 (WebView 차단 우회)
 * 클라이언트에서 직접 호출 대신 서버에서 Gemini API 호출
 */
async function recordGeminiModelUsage(model) {
  if (!model || typeof model !== 'string') return;
  const safeModel = model.trim().slice(0, 120);
  if (!safeModel) return;
  try {
    const dateKey = kstYmdFromMillis(Date.now());
    if (!/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(dateKey)) return;
    const ref = db.doc(`artifacts/${APP_ID}/geminiUsageDaily/${dateKey}`);
    await ref.set(
      {
        byModel: { [safeModel]: FieldValue.increment(1) },
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  } catch (e) {
    logger.warn('recordGeminiModelUsage failed', { model: safeModel, err: e?.message });
  }
}

function truncateAuditText(value, maxLen) {
  if (value == null) return '';
  const s = String(value);
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function extractGeminiResponseText(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) return '';
  const parts = candidate?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const answerParts = parts.filter((p) => p && typeof p.text === 'string' && p.text.trim() && p.thought !== true);
    if (answerParts.length) return answerParts.map((p) => p.text.trim()).join('\n').trim();
    const anyText = parts.map((p) => (p && typeof p.text === 'string' ? p.text.trim() : '')).filter(Boolean);
    if (anyText.length) return anyText.join('\n').trim();
  }
  if (typeof candidate.text === 'string') return candidate.text.trim();
  return '';
}

async function recordMealdangAnalysisLog(uid, auditLog, payload = {}) {
  if (!uid || !auditLog || auditLog.type !== 'mealdang') return;
  try {
    const responseText = payload.responseText != null ? String(payload.responseText) : '';
    const preview = truncateAuditText(responseText, 240);
    const ref = db.collection('artifacts').doc(APP_ID).collection('mealdangAnalysisLogs').doc();
    await ref.set({
      userId: uid,
      userNickname: truncateAuditText(auditLog.userNickname, 80),
      dateRangeText: truncateAuditText(auditLog.dateRangeText, 160),
      characterId: truncateAuditText(auditLog.characterId, 64),
      characterName: truncateAuditText(auditLog.characterName, 80),
      mealDataSummary: truncateAuditText(auditLog.mealDataSummary, 12000),
      mealRecordCount: Number(auditLog.mealRecordCount) || 0,
      mainMealCount: Number(auditLog.mainMealCount) || 0,
      mealRecordPercent: Number(auditLog.mealRecordPercent) || 0,
      hasMealdangMemo: auditLog.hasMealdangMemo === true,
      model: truncateAuditText(payload.model, 120),
      finishReason: truncateAuditText(payload.finishReason, 64),
      status: payload.status === 'error' ? 'error' : 'success',
      responseText: truncateAuditText(responseText, 20000),
      responsePreview: preview,
      errorMessage: truncateAuditText(payload.errorMessage, 500),
      tokenUsage: payload.tokenUsage || null,
      requestedAt: FieldValue.serverTimestamp()
    });
  } catch (e) {
    logger.warn('recordMealdangAnalysisLog failed', { uid, err: e?.message });
  }
}

exports.logMealdangAnalysis = onCall({ region: REGION }, wrapFunction('logMealdangAnalysis', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const { auditLog, model, finishReason, responseText, tokenUsage, status, errorMessage } = request.data || {};
  if (!auditLog || auditLog.type !== 'mealdang') {
    throw new HttpsError('invalid-argument', 'auditLog(type=mealdang)가 필요합니다.');
  }
  await recordMealdangAnalysisLog(request.auth.uid, auditLog, {
    status: status === 'error' ? 'error' : 'success',
    model,
    finishReason,
    responseText,
    tokenUsage: tokenUsage || null,
    errorMessage
  });
  return { ok: true };
}));

exports.callGemini = onCall({ region: REGION }, wrapFunction('callGemini', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  assertNotReadOnlyDemoAuth(request.auth);
  const { requestBody, model } = request.data || {};
  if (!requestBody || !model) {
    throw new HttpsError('invalid-argument', 'requestBody와 model이 필요합니다.');
  }
  if (!GEMINI_ALLOWED_MODELS.includes(model)) {
    throw new HttpsError('invalid-argument', '지원하지 않는 모델입니다.');
  }
  if (Buffer.byteLength(JSON.stringify(requestBody), 'utf8') > GEMINI_MAX_REQUEST_BODY_BYTES) {
    throw new HttpsError('invalid-argument', '요청 본문이 너무 큽니다.');
  }
  const maxOutputTokens = requestBody?.generationConfig?.maxOutputTokens;
  if (typeof maxOutputTokens === 'number' && maxOutputTokens > GEMINI_MAX_OUTPUT_TOKENS_CEILING) {
    throw new HttpsError('invalid-argument', 'maxOutputTokens가 허용 범위를 초과했습니다.');
  }
  await checkRateLimit(request.auth.uid, 'gemini', request);
  const apiKey = geminiApiKey.value();
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY가 설정되지 않았습니다. functions/.env 파일에 GEMINI_API_KEY를 추가하거나, 배포 시 입력 후 재배포하세요.');
  }
  const url = `https://generativelanguage.googleapis.com/${GEMINI_ALLOWED_API_VERSION}/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // 서버 요청은 Referer가 비어 있어 HTTP referrer 제한이 있는 API 키에서 403 발생
      // API 키에 "애플리케이션 제한사항" 없음 또는 IP 주소 제한 사용 권장
      'Referer': 'https://mealog-r0.web.app/'
    },
    body: JSON.stringify(requestBody)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || await res.text();
    throw new HttpsError('internal', `Gemini API 오류: ${res.status} - ${msg}`);
  }
  await recordGeminiModelUsage(model);
  // Callable의 result.data로 전달되므로 Gemini 응답을 그대로 반환
  return data;
}));

/**
 * 카카오 장소 검색 프록시 (WebView 차단 우회)
 * Kakao Local REST API 사용
 */
/**
 * 두 리전에 함께 둔다. 새 클라이언트는 서울을 부르지만, **이미 배포된 앱은 www 를 번들로
 * 들고 있어** us-central1 을 계속 부른다 — 그쪽을 지우면 스토어의 기존 앱에서 검색이 깨진다.
 * 앱이 새 버전으로 갈린 뒤 us-central1 을 뺀다.
 */
/**
 * 카카오 장소 검색 결과를 상호명 일치 순으로 세운다.
 *
 * 카카오 로컬 API 는 상호명뿐 아니라 **업종·메뉴 분류까지** 매칭한다. 「돈까스」로 찾으면
 * 카테고리가 `돈까스,우동` 인 가게가 전부 걸려서, 실측 15건 중 상호명이 맞는 건 3건뿐이었다.
 * API 에 「상호명만」 옵션이 없어 받아온 뒤 순서를 바로잡는다. **거르지는 않는다** —
 * 가게 이름을 모른 채 업종으로 찾는 경우도 있다.
 *
 * js/utils/place-type.js 의 같은 이름 함수들과 규칙을 맞출 것 (ESM/CJS 라 코드를 공유할 수 없다).
 */
const CHOSEONG_TENSE_TO_PLAIN = { 1: 0, 4: 3, 8: 7, 10: 9, 13: 12 };

function softenKoreanTenseConsonants(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const idx = code - 0xac00;
      const plain = CHOSEONG_TENSE_TO_PLAIN[Math.floor(idx / 588)];
      if (plain !== undefined) {
        out += String.fromCharCode(0xac00 + plain * 588 + (idx % 588));
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function normalizePlaceSearchText(value) {
  return softenKoreanTenseConsonants(String(value || '').toLowerCase()).replace(
    /[\s·・()[\]{}\-_,./'"]/g,
    ''
  );
}

function kakaoPlaceNameMatchScore(placeName, keyword) {
  const name = normalizePlaceSearchText(placeName);
  const query = normalizePlaceSearchText(keyword);
  if (!name || !query) return 0;
  if (name.includes(query)) return 2;
  const tokens = String(keyword || '')
    .split(/\s+/)
    .map(normalizePlaceSearchText)
    .filter((t) => t.length >= 2);
  return tokens.some((t) => name.includes(t)) ? 1 : 0;
}

function sortKakaoPlacesByNameMatch(places, keyword) {
  return (places || [])
    .map((place, index) => ({ place, index, score: kakaoPlaceNameMatchScore(place?.place_name, keyword) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.place);
}

exports.searchKakaoPlaces = onCall({ region: [REGION_SEOUL, REGION] }, wrapFunction('searchKakaoPlaces', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const { keyword } = request.data || {};
  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    throw new HttpsError('invalid-argument', '검색어를 입력해주세요.');
  }
  const trimmedKw = keyword.trim();
  if (trimmedKw.length < 2) {
    throw new HttpsError('invalid-argument', '검색어는 2글자 이상 입력해주세요.');
  }
  await checkRateLimit(request.auth.uid, 'kakaoSearch', request);
  const apiKey = kakaoRestApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'KAKAO_REST_API_KEY가 설정되지 않았습니다. functions/.env 파일에 KAKAO_REST_API_KEY를 추가하거나, 배포 시 입력 후 재배포하세요.');
  }
  const query = encodeURIComponent(trimmedKw);
  // category_group_code 필터 제거: FD6 고정이면 카페(CE7)·편의점(CS2)이 API 단계에서 잘려
  // 어디서 축 통합(placeType 파생)이 막힌다. 식음 관련 판정은 아래 후처리 필터가 담당.
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${query}&size=15`;
  // 카카오 로컬 API: Authorization 헤더만 필수 (공식 문서 기준, KA 헤더 생략)
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `KakaoAK ${apiKey}`
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.errorType || data?.msg || JSON.stringify(data) || String(res.status);
    logger.error('searchKakaoPlaces 카카오 API 오류', { status: res.status, msg, keyword });
    if (res.status === 401) {
      throw new HttpsError('failed-precondition', '카카오 API 인증 실패. REST API 키와 호출 허용 IP 설정을 확인하세요.');
    }
    throw new HttpsError('internal', `카카오 API 오류: ${res.status} - ${msg}`);
  }
  // REST API 응답 구조: documents, meta. documents를 그대로 반환 (클라이언트와 호환)
  const documents = data?.documents || [];
  // 클라이언트 SDK 경로(js/utils/place-type.js isFoodRelatedKakaoPlace)와 같은 기준 유지
  const restaurants = documents.filter((place) => {
    const cat = (place.category_name || '').toLowerCase();
    const code = place.category_group_code || '';
    if (code === 'FD6' || code === 'CE7' || code === 'CS2') return true;
    return cat.includes('음식점') || cat.includes('식당') || cat.includes('카페') ||
      cat.includes('레스토랑') || cat.includes('맛집') || cat.includes('요리') ||
      cat.includes('식음료') || cat.includes('제과') || cat.includes('베이커리') ||
      cat.includes('술집') || cat.includes('바') || cat.includes('편의점');
  });
  // 상호명이 맞는 가게를 위로 올린 뒤 자른다 — 자르고 정렬하면 뒤쪽의 일치가 잘려 나간다
  return { documents: sortKakaoPlacesByNameMatch(restaurants, trimmedKw).slice(0, 10) };
}));

/**
 * APK 업로드용 서명 URL 발급 (관리자 전용)
 */
exports.getApkUploadUrl = onCall({ region: REGION }, wrapFunction('getApkUploadUrl', async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const isAdmin = await isAdminByUid(callerUid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', '관리자만 APK를 업로드할 수 있습니다.');
  }
  const { fileName, version } = request.data || {};
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    throw new HttpsError('invalid-argument', 'fileName이 필요합니다.');
  }
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeName.endsWith('.apk')) {
    throw new HttpsError('invalid-argument', 'APK 파일만 업로드할 수 있습니다.');
  }
  const storage = getStorage();
  const bucket = storage.bucket('mealog-r0.firebasestorage.app');
  const path = `artifacts/${APP_ID}/apk/${safeName}`;
  const file = bucket.file(path);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + 15 * 60 * 1000,
    contentType: 'application/vnd.android.package-archive'
  });
  return { uploadUrl: url, fileName: safeName, path };
}));

/**
 * APK 업로드 완료 후 Firestore 메타데이터 저장 (관리자 전용)
 */
exports.confirmApkUpload = onCall({ region: REGION }, wrapFunction('confirmApkUpload', async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const isAdmin = await isAdminByUid(callerUid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', '관리자만 APK를 등록할 수 있습니다.');
  }
  const { fileName, version, fileSize } = request.data || {};
  if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
    throw new HttpsError('invalid-argument', 'fileName이 필요합니다.');
  }
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storage = getStorage();
  const bucket = storage.bucket('mealog-r0.firebasestorage.app');
  const path = `artifacts/${APP_ID}/apk/${safeName}`;
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) {
    throw new HttpsError('failed-precondition', '파일이 아직 업로드되지 않았습니다. 먼저 APK 파일을 업로드해주세요.');
  }
  const encodedPath = encodeURIComponent(path);
  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/mealog-r0.firebasestorage.app/o/${encodedPath}?alt=media`;
  const apkRef = db.collection('artifacts').doc(APP_ID).collection('content').doc('apk');
  await apkRef.set({
    downloadUrl,
    fileName: safeName,
    version: version || '',
    fileSize: fileSize || 0,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: callerUid
  }, { merge: true });
  return { success: true, downloadUrl };
}));

/**
 * 대기 중인 삭제 요청 수동 처리 (Callable)
 * 트리거가 동작하지 않을 때 관리자가 호출해 남아 있는 deleteUserRequests 문서를 처리
 */
exports.processDeleteUserRequests = onCall(
  { region: REGION },
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const isAdmin = await isAdminByUid(callerUid);
    if (!isAdmin) {
      throw new HttpsError('permission-denied', '관리자만 호출할 수 있습니다.');
    }
    const requestsRef = db.collection('artifacts').doc(APP_ID).collection('deleteUserRequests');
    const snapshot = await requestsRef.get();
    let processed = 0;
    let failed = 0;
    const errors = [];
    for (const docSnap of snapshot.docs) {
      const { userId, requestedBy } = docSnap.data();
      if (!userId || !requestedBy) {
        await docSnap.ref.delete();
        continue;
      }
      const requesterIsAdmin = await isAdminByUid(requestedBy);
      if (!requesterIsAdmin) {
        await docSnap.ref.delete();
        continue;
      }
      try {
        await recursiveDeleteArtifactUser(userId);
      } catch (e) {
        failed++;
        errors.push(`${userId}: Firestore ${e.message || e}`);
        logger.error('processDeleteUserRequests: recursive delete failed', { userId, err: e?.message });
        continue;
      }
      try {
        await auth.deleteUser(String(userId));
        logger.info('processDeleteUserRequests: Auth user deleted', { userId, requestedBy });
      } catch (err) {
        if (err.code === 'auth/user-not-found') {
          logger.info('processDeleteUserRequests: user already gone in Auth', { userId });
        } else {
          failed++;
          errors.push(`${userId}: ${err.message || err}`);
          logger.error('processDeleteUserRequests: deleteUser failed', { userId, err: err.message });
          continue;
        }
      }
      processed++;
      await docSnap.ref.delete();
    }
    return { processed, failed, total: snapshot.size, errors: errors.length ? errors : undefined };
  }
);

/**
 * sharedPhotos timestamp 마이그레이션 (Callable) - 관리자 전용
 * 문자열/누락 timestamp → Firestore Timestamp 정규화
 */
exports.migrateSharedPhotosTimestamp = onCall({ region: REGION }, async (request) => {
  const { auth } = request;

  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const isAdmin = await isAdminByUid(auth.uid);
  if (!isAdmin) {
    throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
  }

  const sharedColl = db.collection('artifacts').doc(APP_ID).collection('sharedPhotos');
  const snapshot = await sharedColl.get();
  const toMigrate = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const ts = data.timestamp;

    // Firestore Timestamp 객체(toDate 메서드 있음)만 스킵. plain object {seconds, nanoseconds}는 Map으로 저장되어 orderBy 문제 유발 → 변환 필요
    if (ts && typeof ts.toDate === 'function') {
      continue;
    }

    let newTimestamp = null;
    if (ts && ts.seconds != null && typeof ts.seconds === 'number') {
      newTimestamp = new Timestamp(ts.seconds, ts.nanoseconds || 0);
    }
    if (!newTimestamp && typeof ts === 'string') {
      const ms = new Date(ts).getTime();
      if (!isNaN(ms)) newTimestamp = Timestamp.fromDate(new Date(ms));
    }
    if (!newTimestamp && typeof ts === 'number' && !isNaN(ts)) {
      newTimestamp = Timestamp.fromDate(new Date(ts));
    }
    if (!newTimestamp && (data.date || data.time)) {
      const dStr = String(data.date || '').trim();
      let tStr = String(data.time || '12:00:00').trim();
      if (tStr && tStr.split(':').length === 2) tStr += ':00';
      const ms = new Date(dStr + 'T' + tStr).getTime();
      if (!isNaN(ms)) newTimestamp = Timestamp.fromDate(new Date(ms));
    }
    if (!newTimestamp) {
      newTimestamp = Timestamp.now();
    }
    if (newTimestamp) toMigrate.push({ ref: docSnap.ref, timestamp: newTimestamp });
  }

  const BATCH_SIZE = 500;
  let updated = 0;
  for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = toMigrate.slice(i, i + BATCH_SIZE);
    for (const { ref, timestamp } of chunk) {
      batch.update(ref, { timestamp });
      updated++;
    }
    await batch.commit();
  }

  return { updated, total: snapshot.size };
});

/** 공지 HTML → 푸시 본문용 짧은 텍스트 */
function noticePlainTextForPush(content, maxLen = 180) {
  if (!content || typeof content !== 'string') return '새 공지가 등록되었습니다.';
  const stripped = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return '새 공지가 등록되었습니다.';
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

/**
 * 로그인 사용자(users 문서 존재)에게 동일 푸시 발송 (FCM 토큰 있는 계정만 실제 수신)
 */
async function broadcastNoticePushToAllUsers(payload) {
  const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
  let lastDoc = null;
  let totalUsers = 0;
  const pageSize = 200;
  const concurrency = 25;
  for (;;) {
    let q = usersRef.orderBy(FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    const uids = snap.docs.map((d) => d.id);
    totalUsers += uids.length;
    for (let i = 0; i < uids.length; i += concurrency) {
      const batch = uids.slice(i, i + concurrency);
      await Promise.all(batch.map((uid) => sendPushToUser(uid, payload, { pushCategory: 'adminDefault' })));
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  logger.info('broadcastNoticePushToAllUsers done', { totalUsers });
}

/**
 * 동일 제목·본문·대상env 알림이 Android에서 여러 줄로 쌓이지 않게 tag, iOS는 apns-collapse-id로 합침.
 */
function makeAdminBroadcastCollapseId(payload, targetEnvResolved) {
  const t = String(payload?.title || '');
  const b = String(payload?.body || '');
  const land = payload?.data && typeof payload.data.landingTab === 'string' ? payload.data.landingTab : '';
  const e = String(targetEnvResolved || 'all');
  return crypto.createHash('sha256').update(`${t}\n${b}\n${land}\n${e}`).digest('hex').slice(0, 32);
}

/** 관리자 푸시메시지: 상단 알림만, 탭 시 앱 내 탭 이동(data.type=adminBroadcast), 배지/빨간점 갱신 생략 */
/** @returns {Promise<{ totalUsers: number, recipientCount: number }>} recipientCount: FCM 1건 이상 성공한 사용자 수 */
async function broadcastAdminPushToAllUsers(payload) {
  const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
  const targetEnv = payload?.targetEnv === 'production' || payload?.targetEnv === 'staging'
    ? payload.targetEnv
    : 'all';
  const adminCollapseId = makeAdminBroadcastCollapseId(payload, targetEnv);
  let lastDoc = null;
  let totalUsers = 0;
  let recipientCount = 0;
  const pageSize = 200;
  const concurrency = 25;
  for (;;) {
    let q = usersRef.orderBy(FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    const uids = snap.docs.map((d) => d.id);
    totalUsers += uids.length;
    for (let i = 0; i < uids.length; i += concurrency) {
      const batch = uids.slice(i, i + concurrency);
      const outcomes = await Promise.all(
        batch.map((uid) =>
          sendPushToUser(uid, payload, {
            adminBroadcast: true,
            targetEnv,
            pushCategory: 'adminDefault',
            adminCollapseId
          })
        )
      );
      for (const ok of outcomes) {
        if (ok) recipientCount += 1;
      }
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  logger.info('broadcastAdminPushToAllUsers done', { totalUsers, recipientCount, targetEnv });
  return { totalUsers, recipientCount };
}

const ADMIN_PUSH_LANDING_TABS = new Set(['dashboard', 'timeline', 'gallery', 'board', 'settings']);

const ADMIN_RECURRING_INTERVALS = new Set(['daily', 'weekly', 'monthly']);
const ADMIN_PUSH_TARGET_ENVS = new Set(['all', 'production', 'staging']);
/** 관리자 브로드캐스트 제목·본문 (FCM 표시·Firestore, 즉시/예약/요일별 공통) */
const ADMIN_BROADCAST_TITLE_MAX = 120;
const ADMIN_BROADCAST_BODY_MAX = 240;

/** 다음 주기 발송 시각(ms). monthly: 해당 월에 일이 없으면 말일로 보정 */
function addRecurringNextMillis(fromMs, interval) {
  const d = new Date(fromMs);
  if (interval === 'weekly') {
    d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  if (interval === 'monthly') {
    const y = d.getFullYear();
    const m = d.getMonth();
    const day = d.getDate();
    const h = d.getHours();
    const mi = d.getMinutes();
    const s = d.getSeconds();
    const ms = d.getMilliseconds();
    const lastDayTarget = new Date(y, m + 2, 0).getDate();
    const useDay = Math.min(day, lastDayTarget);
    return new Date(y, m + 1, useDay, h, mi, s, ms).getTime();
  }
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** KST 기준 YYYY-MM-DD */
function kstYmdFromMillis(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function addOneKstYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
  return dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

/** 월=1 … 일=7 (JS getUTCDay: 일=0) */
function kstWeekdayMon1Sun7FromYmd(ymd) {
  const [Y, M, D] = ymd.split('-').map(Number);
  const noonUtc = Date.UTC(Y, M - 1, D, 3, 0, 0);
  const dowSun0 = new Date(noonUtc).getUTCDay();
  return dowSun0 === 0 ? 7 : dowSun0;
}

function kstWeekdayMon1Sun7FromMillis(ms) {
  return kstWeekdayMon1Sun7FromYmd(kstYmdFromMillis(ms));
}

function kstMillisForYmdHm(ymd, hm) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const parts = String(hm || '').trim().split(':');
  const h = parseInt(parts[0], 10);
  const mi = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(mi)) return NaN;
  return Date.UTC(y, mo - 1, d, h - 9, mi, 0, 0);
}

function kstEndOfDayMillisFromYmd(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, 23 - 9, 59, 59, 999);
}

function kstHmFromMillis(ms) {
  return new Date(ms).toLocaleTimeString('sv-SE', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function normalizeHm(hm) {
  const p = String(hm || '').split(':');
  const h = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return String(hm || '');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function normalizeWeeklyScheduleEntries(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const weekday = Number(row.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    const time = normalizeHm(row.time);
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    const title = String(row.title || '').trim().slice(0, ADMIN_BROADCAST_TITLE_MAX);
    const body = String(row.body || '').trim().slice(0, ADMIN_BROADCAST_BODY_MAX);
    if (!title || !body) continue;
    const tab = String(row.landingTab || 'dashboard').trim();
    const landingTab = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
    const envRaw = String(row.targetEnv || 'all').trim();
    const targetEnv = ADMIN_PUSH_TARGET_ENVS.has(envRaw) ? envRaw : 'all';
    out.push({ weekday, time, landingTab, targetEnv, title, body });
  }
  return out;
}

/**
 * 기간 [rangeStartMs, rangeEndMs] 안에서 fromMs 이후 가장 이른 발송 시각 (KST 요일·시각 일치)
 */
function computeNextWeeklySlotMillis(weeklySchedule, rangeStartMs, rangeEndMs, fromMs) {
  const slots = normalizeWeeklyScheduleEntries(weeklySchedule);
  if (slots.length === 0) return null;
  const from = Math.max(fromMs, rangeStartMs);
  if (from > rangeEndMs) return null;
  const endYmd = kstYmdFromMillis(rangeEndMs);
  let best = null;
  let ymd = kstYmdFromMillis(from);
  for (;;) {
    if (ymd > endYmd) break;
    const wd = kstWeekdayMon1Sun7FromYmd(ymd);
    for (const slot of slots) {
      if (slot.weekday !== wd) continue;
      const ts = kstMillisForYmdHm(ymd, slot.time);
      if (Number.isNaN(ts)) continue;
      if (ts >= from && ts <= rangeEndMs) {
        if (best === null || ts < best) best = ts;
      }
    }
    if (ymd >= endYmd) break;
    ymd = addOneKstYmd(ymd);
  }
  return best;
}

/**
 * 기간·요일별 슬롯을 모두 펼쳐 (minFromMs 이후) 발송 시각 목록 — 각각 별도 예약 문서로 등록할 때 사용
 * @returns {{ ms: number, slot: object }[]}
 */
function enumerateWeeklyOccurrences(weeklySchedule, rangeStartMs, rangeEndMs, minFromMs) {
  const slots = normalizeWeeklyScheduleEntries(weeklySchedule);
  if (slots.length === 0) return [];
  const from = Math.max(rangeStartMs, minFromMs);
  if (from > rangeEndMs) return [];
  const endYmd = kstYmdFromMillis(rangeEndMs);
  let ymd = kstYmdFromMillis(from);
  const out = [];
  for (let guard = 0; guard < 800 && ymd <= endYmd; guard++) {
    const wd = kstWeekdayMon1Sun7FromYmd(ymd);
    for (const slot of slots) {
      if (slot.weekday !== wd) continue;
      const ts = kstMillisForYmdHm(ymd, slot.time);
      if (Number.isNaN(ts)) continue;
      if (ts >= from && ts <= rangeEndMs) {
        out.push({ ms: ts, slot });
      }
    }
    if (ymd >= endYmd) break;
    ymd = addOneKstYmd(ymd);
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

function findWeeklySlotForScheduledAt(weeklySchedule, scheduledAtTs) {
  const ms = scheduledAtTs && typeof scheduledAtTs.toMillis === 'function' ? scheduledAtTs.toMillis() : 0;
  if (!ms) return null;
  const wd = kstWeekdayMon1Sun7FromMillis(ms);
  const hm = normalizeHm(kstHmFromMillis(ms));
  const slots = normalizeWeeklyScheduleEntries(weeklySchedule);
  return slots.find((s) => s.weekday === wd && s.time === hm) || null;
}

function normalizeAdminBroadcastPayload(raw) {
  const title = String(raw?.title || '').trim();
  const body = String(raw?.body || '').trim();
  const tab = String(raw?.landingTab || 'dashboard').trim();
  const landingTab = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
  const envRaw = String(raw?.targetEnv || 'all').trim();
  const targetEnv = ADMIN_PUSH_TARGET_ENVS.has(envRaw) ? envRaw : 'all';
  return { title, body, landingTab, targetEnv };
}

async function appendAdminBroadcastHistory({
  scheduleType = 'now',
  title,
  body,
  landingTab,
  targetEnv = 'all',
  status = 'sent',
  createdByUid = null,
  recipientCount = null
}) {
  const coll = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
  const row = {
    scheduleType,
    title: String(title || '').slice(0, ADMIN_BROADCAST_TITLE_MAX),
    body: String(body || '').slice(0, ADMIN_BROADCAST_BODY_MAX),
    landingTab: ADMIN_PUSH_LANDING_TABS.has(String(landingTab || '').trim()) ? String(landingTab).trim() : 'dashboard',
    targetEnv: ADMIN_PUSH_TARGET_ENVS.has(String(targetEnv || '').trim()) ? String(targetEnv).trim() : 'all',
    status: String(status || 'sent'),
    scheduledAt: FieldValue.serverTimestamp(),
    sentAt: FieldValue.serverTimestamp(),
    createdByUid: createdByUid || null,
    createdAt: FieldValue.serverTimestamp()
  };
  if (typeof recipientCount === 'number' && !Number.isNaN(recipientCount) && recipientCount >= 0) {
    row.recipientCount = recipientCount;
  }
  await coll.add(row);
}

const ADMIN_PUSH_NOW_DEDUPE_MS = 55 * 1000;

/** Callable 중복 호출·클라이언트 재시도로 동일 내용이 짧은 시간에 여러 번 나가는 것 방지 */
async function adminPushNowDedupeShouldSkip({ callerUid, title, body, landingTab, targetEnv }) {
  const raw = `${callerUid}|${title}|${body}|${landingTab}|${targetEnv}`;
  const docId = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 48);
  const ref = db.collection('artifacts').doc(APP_ID).collection('_adminPushDedupe').doc(docId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    if (snap.exists) {
      const at = snap.data().at;
      const ms = at && typeof at.toMillis === 'function' ? at.toMillis() : 0;
      if (ms && now - ms < ADMIN_PUSH_NOW_DEDUPE_MS) return true;
    }
    tx.set(ref, { at: FieldValue.serverTimestamp(), callerUid }, { merge: true });
    return false;
  });
}

/** 관리자: 전체 사용자에게 푸시 즉시 발송 */
exports.adminBroadcastPushNow = onCall(
  { region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(callerUid))) {
      throw new HttpsError('permission-denied', '관리자만 발송할 수 있습니다.');
    }
    const { title, body, landingTab, targetEnv } = normalizeAdminBroadcastPayload(request.data || {});
    if (!title || title.length === 0) {
      throw new HttpsError('invalid-argument', '제목을 입력해 주세요.');
    }
    if (title.length > ADMIN_BROADCAST_TITLE_MAX) {
      throw new HttpsError(
        'invalid-argument',
        `제목은 ${ADMIN_BROADCAST_TITLE_MAX}자 이하로 입력해 주세요.`
      );
    }
    if (!body || body.length === 0) {
      throw new HttpsError('invalid-argument', '내용을 입력해 주세요.');
    }
    if (body.length > ADMIN_BROADCAST_BODY_MAX) {
      throw new HttpsError(
        'invalid-argument',
        `내용은 ${ADMIN_BROADCAST_BODY_MAX}자 이하로 입력해 주세요.`
      );
    }
    const skip = await adminPushNowDedupeShouldSkip({ callerUid, title, body, landingTab, targetEnv });
    if (skip) {
      logger.info('adminBroadcastPushNow: dedupe skip (same payload within window)');
      return { ok: true, deduped: true };
    }
    const { recipientCount } = await broadcastAdminPushToAllUsers({
      title,
      body,
      targetEnv,
      data: { type: 'adminBroadcast', landingTab }
    });
    try {
      await appendAdminBroadcastHistory({
        scheduleType: 'now',
        title,
        body,
        landingTab,
        targetEnv,
        status: 'sent',
        createdByUid: callerUid,
        recipientCount
      });
    } catch (historyErr) {
      logger.warn('adminBroadcastPushNow: history write failed', { message: historyErr?.message });
    }
    return { ok: true };
  }
);

/**
 * 관리자: 예약 푸시 문서 생성 (Admin SDK — 클라이언트 규칙·시계 오차 이슈 회피)
 */
exports.scheduleAdminBroadcastPush = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', '관리자만 등록할 수 있습니다.');
  }
  const data = request.data || {};
  const { title, body, landingTab, targetEnv } = data;
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  const tab = String(landingTab || 'dashboard').trim();
  const land = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
  const envRaw = String(targetEnv || 'all').trim();
  const target = ADMIN_PUSH_TARGET_ENVS.has(envRaw) ? envRaw : 'all';
  const serverNow = Date.now();
  const minLead = serverNow + 25 * 1000;
  const scheduleType = data.scheduleType === 'recurring' ? 'recurring' : 'once';

  if (scheduleType === 'recurring') {
    const weeklyRows = data.weeklySchedule;
    if (Array.isArray(weeklyRows) && weeklyRows.length > 0) {
      const startDate = String(data.recurringStartDate || '').trim();
      const endDate = String(data.recurringEndDate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        throw new HttpsError('invalid-argument', '요일별 발송: 시작일·종료일(YYYY-MM-DD)이 필요합니다.');
      }
      const weeklySchedule = normalizeWeeklyScheduleEntries(weeklyRows);
      if (weeklySchedule.length === 0) {
        throw new HttpsError('invalid-argument', '요일별 발송: 최소 1개 요일에 제목·내용·시각을 입력해 주세요.');
      }
      if (endDate < startDate) {
        throw new HttpsError('invalid-argument', '종료일은 시작일 이후여야 합니다.');
      }
      const rangeStartMs = kstMillisForYmdHm(startDate, '00:00');
      const rangeEndMs = kstEndOfDayMillisFromYmd(endDate);
      if (Number.isNaN(rangeStartMs) || Number.isNaN(rangeEndMs)) {
        throw new HttpsError('invalid-argument', '시작일·종료일이 올바르지 않습니다.');
      }
      if (rangeEndMs < rangeStartMs) {
        throw new HttpsError('invalid-argument', '기간이 올바르지 않습니다.');
      }
      const occurrences = enumerateWeeklyOccurrences(weeklySchedule, rangeStartMs, rangeEndMs, minLead);
      if (occurrences.length === 0) {
        throw new HttpsError(
          'invalid-argument',
          '선택한 기간·시각 안에 발송할 수 있는 일정이 없습니다. 기간을 넓히거나 시각을 확인해 주세요.'
        );
      }
      const MAX_WEEKLY_EXPANDED = 500;
      if (occurrences.length > MAX_WEEKLY_EXPANDED) {
        throw new HttpsError(
          'invalid-argument',
          `요일별 예약은 한 번에 최대 ${MAX_WEEKLY_EXPANDED}건까지 등록할 수 있습니다. 기간을 줄이거나 요일을 나눠 주세요. (현재 ${occurrences.length}건)`
        );
      }
      const batchGroupId = crypto.randomBytes(12).toString('hex');
      const coll = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
      const ids = [];
      const taskEntries = [];
      let batch = db.batch();
      let ops = 0;
      for (const { ms, slot } of occurrences) {
        const ref = coll.doc();
        batch.set(ref, {
          scheduleType: 'once',
          scheduleSource: 'weeklyByDayExpanded',
          weeklyBatchGroupId: batchGroupId,
          title: slot.title,
          body: slot.body,
          landingTab: slot.landingTab,
          targetEnv: slot.targetEnv,
          scheduledAt: Timestamp.fromMillis(ms),
          status: 'pending',
          createdByUid: callerUid,
          createdAt: FieldValue.serverTimestamp()
        });
        ids.push(ref.id);
        taskEntries.push({ docId: ref.id, whenMs: ms });
        ops++;
        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
      if (ops > 0) {
        await batch.commit();
      }
      // 문서가 다 저장된 뒤에 건다 — 태스크가 먼저 도착해 빈 문서를 읽는 일이 없도록
      await enqueueAdminPushTasks(taskEntries);
      return { ok: true, count: ids.length, batchGroupId, ids };
    }

    const recurringStartMs =
      typeof data.recurringStartMs === 'number' && !Number.isNaN(data.recurringStartMs)
        ? data.recurringStartMs
        : null;
    const recurringEndMs =
      typeof data.recurringEndMs === 'number' && !Number.isNaN(data.recurringEndMs)
        ? data.recurringEndMs
        : null;
    const recurringInterval = ADMIN_RECURRING_INTERVALS.has(String(data.recurringInterval || '').trim())
      ? String(data.recurringInterval).trim()
      : 'daily';
    if (recurringStartMs == null || recurringEndMs == null) {
      throw new HttpsError('invalid-argument', '주기 발송: 시작·종료 시각이 올바르지 않습니다.');
    }
    if (recurringEndMs < recurringStartMs) {
      throw new HttpsError('invalid-argument', '종료 시각은 시작 시각 이후여야 합니다.');
    }
    if (recurringStartMs < minLead) {
      throw new HttpsError('invalid-argument', '시작 시각은 서버 기준 약 30초 이후로 설정해 주세요.');
    }
    if (!t || t.length === 0) {
      throw new HttpsError('invalid-argument', '주기 발송: 제목을 입력해 주세요.');
    }
    if (t.length > ADMIN_BROADCAST_TITLE_MAX) {
      throw new HttpsError(
        'invalid-argument',
        `제목은 ${ADMIN_BROADCAST_TITLE_MAX}자 이하로 입력해 주세요.`
      );
    }
    if (!b || b.length === 0) {
      throw new HttpsError('invalid-argument', '주기 발송: 내용을 입력해 주세요.');
    }
    if (b.length > ADMIN_BROADCAST_BODY_MAX) {
      throw new HttpsError(
        'invalid-argument',
        `내용은 ${ADMIN_BROADCAST_BODY_MAX}자 이하로 입력해 주세요.`
      );
    }
    const ref = await db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').add({
      scheduleType: 'recurring',
      recurringInterval,
      recurringEndAt: Timestamp.fromMillis(recurringEndMs),
      title: t.slice(0, ADMIN_BROADCAST_TITLE_MAX),
      body: b.slice(0, ADMIN_BROADCAST_BODY_MAX),
      landingTab: land,
      targetEnv: target,
      scheduledAt: Timestamp.fromMillis(recurringStartMs),
      occurrenceCount: 0,
      status: 'pending',
      createdByUid: callerUid,
      createdAt: FieldValue.serverTimestamp()
    });
    await enqueueAdminPushTask(ref.id, recurringStartMs);
    return { ok: true, id: ref.id };
  }

  if (!t || t.length === 0) {
    throw new HttpsError('invalid-argument', '예약 발송: 제목을 입력해 주세요.');
  }
  if (t.length > ADMIN_BROADCAST_TITLE_MAX) {
    throw new HttpsError(
      'invalid-argument',
      `제목은 ${ADMIN_BROADCAST_TITLE_MAX}자 이하로 입력해 주세요.`
    );
  }
  if (!b || b.length === 0) {
    throw new HttpsError('invalid-argument', '예약 발송: 내용을 입력해 주세요.');
  }
  if (b.length > ADMIN_BROADCAST_BODY_MAX) {
    throw new HttpsError(
      'invalid-argument',
      `내용은 ${ADMIN_BROADCAST_BODY_MAX}자 이하로 입력해 주세요.`
    );
  }

  const ms = typeof data.scheduledAtMs === 'number' && !Number.isNaN(data.scheduledAtMs) ? data.scheduledAtMs : null;
  if (ms == null) {
    throw new HttpsError('invalid-argument', '예약 시각(scheduledAtMs)이 올바르지 않습니다.');
  }
  if (ms < minLead) {
    throw new HttpsError('invalid-argument', '예약 시각은 서버 기준 약 30초 이후로 설정해 주세요.');
  }
  // 풀에서 만든 예약이면 출처를 남긴다 (발송 성공 시 사용 횟수 집계)
  const sourceMessageId = String(data.messageId || '').trim();
  const ref = await db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').add({
    scheduleType: 'once',
    title: t.slice(0, ADMIN_BROADCAST_TITLE_MAX),
    body: b.slice(0, ADMIN_BROADCAST_BODY_MAX),
    landingTab: land,
    targetEnv: target,
    scheduledAt: Timestamp.fromMillis(ms),
    status: 'pending',
    ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
    createdByUid: callerUid,
    createdAt: FieldValue.serverTimestamp()
  });
  await enqueueAdminPushTask(ref.id, ms);
  return { ok: true, id: ref.id };
});

/** 관리자: 예약 푸시 취소 */
exports.cancelAdminScheduledPush = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', '관리자만 취소할 수 있습니다.');
  }
  const jobId = String(request.data?.jobId || '').trim();
  if (!jobId) {
    throw new HttpsError('invalid-argument', '예약 ID(jobId)가 필요합니다.');
  }
  const ref = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', '예약을 찾을 수 없습니다.');
  }
  const status = String(snap.data()?.status || 'pending');
  if (status !== 'pending') {
    throw new HttpsError('failed-precondition', 'pending 상태의 예약만 취소할 수 있습니다.');
  }
  await ref.update({
    status: 'cancelled',
    cancelledAt: FieldValue.serverTimestamp(),
    cancelledByUid: callerUid
  });
  return { ok: true, id: jobId };
});

/** 관리자: 예약 푸시 수정 (pending·단일 예약만) */
exports.updateAdminScheduledPush = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', '관리자만 수정할 수 있습니다.');
  }
  const data = request.data || {};
  const jobId = String(data.jobId || '').trim();
  if (!jobId) {
    throw new HttpsError('invalid-argument', '예약 ID(jobId)가 필요합니다.');
  }
  const ref = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', '예약을 찾을 수 없습니다.');
  }
  const cur = snap.data() || {};
  if (String(cur.status || 'pending') !== 'pending') {
    throw new HttpsError('failed-precondition', 'pending 상태의 예약만 수정할 수 있습니다.');
  }
  if (String(cur.scheduleType || 'once') !== 'once') {
    throw new HttpsError('failed-precondition', '단일/요일별(개별) 예약만 수정할 수 있습니다.');
  }
  const updates = {};
  if (data.title !== undefined) {
    const t = String(data.title || '').trim();
    if (!t) {
      throw new HttpsError('invalid-argument', '제목을 입력해 주세요.');
    }
    if (t.length > ADMIN_BROADCAST_TITLE_MAX) {
      throw new HttpsError('invalid-argument', `제목은 ${ADMIN_BROADCAST_TITLE_MAX}자 이하로 입력해 주세요.`);
    }
    updates.title = t.slice(0, ADMIN_BROADCAST_TITLE_MAX);
  }
  if (data.body !== undefined) {
    const b = String(data.body || '').trim();
    if (!b) {
      throw new HttpsError('invalid-argument', '내용을 입력해 주세요.');
    }
    if (b.length > ADMIN_BROADCAST_BODY_MAX) {
      throw new HttpsError('invalid-argument', `내용은 ${ADMIN_BROADCAST_BODY_MAX}자 이하로 입력해 주세요.`);
    }
    updates.body = b.slice(0, ADMIN_BROADCAST_BODY_MAX);
  }
  if (data.landingTab !== undefined) {
    const tab = String(data.landingTab || '').trim();
    updates.landingTab = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
  }
  if (data.targetEnv !== undefined) {
    const envRaw = String(data.targetEnv || '').trim();
    updates.targetEnv = ADMIN_PUSH_TARGET_ENVS.has(envRaw) ? envRaw : 'all';
  }
  if (data.scheduledAtMs !== undefined) {
    const ms = typeof data.scheduledAtMs === 'number' && !Number.isNaN(data.scheduledAtMs) ? data.scheduledAtMs : null;
    if (ms == null) {
      throw new HttpsError('invalid-argument', '예약 시각(scheduledAtMs)이 올바르지 않습니다.');
    }
    const minLead = Date.now() + 25 * 1000;
    if (ms < minLead) {
      throw new HttpsError('invalid-argument', '예약 시각은 서버 기준 약 30초 이후로 설정해 주세요.');
    }
    updates.scheduledAt = Timestamp.fromMillis(ms);
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpsError('invalid-argument', '수정할 내용이 없습니다.');
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  updates.updatedByUid = callerUid;
  await ref.update(updates);
  if (updates.scheduledAt) {
    // 옛 태스크는 그대로 둔다 — 그 시각에 와도 예약이 이미 옮겨져 있어 스스로 물러난다
    await enqueueAdminPushTask(jobId, updates.scheduledAt.toMillis());
  }
  return { ok: true, id: jobId };
});

/** 관리자: 발송 기록 삭제 (pending 제외) */
exports.deleteAdminBroadcastHistory = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', '관리자만 삭제할 수 있습니다.');
  }
  const jobId = String(request.data?.jobId || '').trim();
  if (!jobId) {
    throw new HttpsError('invalid-argument', '기록 ID(jobId)가 필요합니다.');
  }
  const ref = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').doc(jobId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', '기록을 찾을 수 없습니다.');
  }
  const status = String(snap.data()?.status || 'pending');
  if (status === 'pending') {
    throw new HttpsError('failed-precondition', '대기 중(pending) 기록은 삭제할 수 없습니다. 먼저 취소해 주세요.');
  }
  await ref.delete();
  return { ok: true, id: jobId };
});

// ============================================
// 푸시 메시지 풀 (adminPushMessages)
// ============================================

const ADMIN_PUSH_MESSAGE_MAX = 2000;

function adminPushMessagesColl() {
  return db.collection('artifacts').doc(APP_ID).collection('adminPushMessages');
}

/** 제목+내용이 같으면 같은 메시지로 본다 (중복 담기 방지) */
function adminPushMessageDedupeKey(title, body) {
  const raw = `${String(title || '').trim()}\n${String(body || '').trim()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

/** 풀에 저장할 형태로 정규화 — 유효하지 않으면 null */
function normalizeAdminPushMessageInput(raw) {
  const title = String(raw?.title || '').trim().slice(0, ADMIN_BROADCAST_TITLE_MAX);
  const body = String(raw?.body || '').trim().slice(0, ADMIN_BROADCAST_BODY_MAX);
  if (!title || !body) return null;
  const tab = String(raw?.landingTab || '').trim();
  const landingTab = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
  return { title, body, landingTab, dedupeKey: adminPushMessageDedupeKey(title, body) };
}

/** 관리자 확인 + 풀 크기 상한 안내를 공유 */
async function assertAdminForPushPool(request, action) {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(callerUid))) {
    throw new HttpsError('permission-denied', `관리자만 ${action} 수 있습니다.`);
  }
  return callerUid;
}

/** 관리자: 풀 메시지 생성·수정 */
exports.upsertAdminPushMessage = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  const callerUid = await assertAdminForPushPool(request, '등록할');
  const data = request.data || {};
  const normalized = normalizeAdminPushMessageInput(data);
  if (!normalized) {
    throw new HttpsError('invalid-argument', '제목과 내용을 모두 입력해 주세요.');
  }
  const active = data.active === false ? false : true;
  const messageId = String(data.messageId || '').trim();

  if (messageId) {
    const ref = adminPushMessagesColl().doc(messageId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new HttpsError('not-found', '메시지를 찾을 수 없습니다.');
    }
    const wasActive = snap.data()?.active !== false;
    await ref.update({
      ...normalized,
      active,
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: callerUid
    });
    if (wasActive && !active) {
      // 순환에서 뺐으면 이미 깔린 미래 배정도 비워 다른 메시지로 다시 채운다
      await replanRotationsForMessages([messageId]).catch((e) =>
        logger.warn('upsertAdminPushMessage: replan failed', { message: e?.message })
      );
    } else if (!wasActive && active) {
      await insertMessageIntoRotationDecks(messageId).catch((e) =>
        logger.warn('upsertAdminPushMessage: deck insert failed', { message: e?.message })
      );
    }
    return { ok: true, id: messageId, created: false };
  }

  // 같은 제목·내용이 이미 있으면 새로 만들지 않는다
  const dup = await adminPushMessagesColl().where('dedupeKey', '==', normalized.dedupeKey).limit(1).get();
  if (!dup.empty) {
    return { ok: true, id: dup.docs[0].id, created: false, duplicated: true };
  }
  const total = await adminPushMessagesColl().count().get();
  if ((total.data().count || 0) >= ADMIN_PUSH_MESSAGE_MAX) {
    throw new HttpsError('resource-exhausted', `메시지 풀은 최대 ${ADMIN_PUSH_MESSAGE_MAX}개까지 등록할 수 있습니다.`);
  }
  const ref = await adminPushMessagesColl().add({
    ...normalized,
    active,
    useCount: 0,
    lastUsedAt: null,
    createdByUid: callerUid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
  if (active) {
    // 다음 바퀴까지 기다리지 않고 이번 바퀴 안에서 나가도록
    await insertMessageIntoRotationDecks(ref.id).catch((e) =>
      logger.warn('upsertAdminPushMessage: deck insert failed', { message: e?.message })
    );
  }
  return { ok: true, id: ref.id, created: true };
});

/** 관리자: 풀 메시지 삭제 */
exports.deleteAdminPushMessage = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  await assertAdminForPushPool(request, '삭제할');
  const ids = Array.isArray(request.data?.messageIds)
    ? request.data.messageIds
    : [request.data?.messageId];
  const targets = [...new Set(ids.map((v) => String(v || '').trim()).filter(Boolean))];
  if (targets.length === 0) {
    throw new HttpsError('invalid-argument', '삭제할 메시지 ID가 필요합니다.');
  }
  let batch = db.batch();
  let ops = 0;
  for (const id of targets) {
    batch.delete(adminPushMessagesColl().doc(id));
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  await replanRotationsForMessages(targets).catch((e) =>
    logger.warn('deleteAdminPushMessage: replan failed', { message: e?.message })
  );
  return { ok: true, deleted: targets.length };
});

/**
 * 관리자: 발송예정·발송완료 기록에서 선택한 건을 풀에 담기
 * 제목+내용이 같은 메시지는 건너뛴다.
 */
exports.importAdminPushMessagesFromHistory = onCall({ region: REGION }, async (request) => {
  const callerUid = await assertAdminForPushPool(request, '가져올');
  const rawIds = Array.isArray(request.data?.jobIds) ? request.data.jobIds : [];
  const jobIds = [...new Set(rawIds.map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 350);
  if (jobIds.length === 0) {
    throw new HttpsError('invalid-argument', '가져올 기록을 선택해 주세요.');
  }

  const historyColl = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
  const snaps = await db.getAll(...jobIds.map((id) => historyColl.doc(id)));

  // 이미 풀에 있는 제목+내용 (풀은 최대 2000건이라 전량 조회해도 부담이 적다)
  const poolSnap = await adminPushMessagesColl().select('dedupeKey').get();
  const seen = new Set(poolSnap.docs.map((d) => String(d.data().dedupeKey || '')).filter(Boolean));

  const toCreate = [];
  let skippedDuplicate = 0;
  let skippedInvalid = 0;
  for (const snap of snaps) {
    if (!snap.exists) {
      skippedInvalid++;
      continue;
    }
    const normalized = normalizeAdminPushMessageInput(snap.data());
    if (!normalized) {
      skippedInvalid++;
      continue;
    }
    if (seen.has(normalized.dedupeKey)) {
      // 선택 목록 안의 중복도 여기서 걸러진다
      skippedDuplicate++;
      continue;
    }
    seen.add(normalized.dedupeKey);
    toCreate.push(normalized);
  }

  if (toCreate.length > 0) {
    const room = ADMIN_PUSH_MESSAGE_MAX - (poolSnap.size || 0);
    if (toCreate.length > room) {
      throw new HttpsError(
        'resource-exhausted',
        `메시지 풀은 최대 ${ADMIN_PUSH_MESSAGE_MAX}개까지 등록할 수 있습니다. (현재 ${poolSnap.size}개, 담으려는 ${toCreate.length}개)`
      );
    }
    let batch = db.batch();
    let ops = 0;
    for (const item of toCreate) {
      batch.set(adminPushMessagesColl().doc(), {
        ...item,
        active: true,
        useCount: 0,
        lastUsedAt: null,
        importedFrom: 'history',
        createdByUid: callerUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();
  }

  return {
    ok: true,
    imported: toCreate.length,
    skippedDuplicate,
    skippedInvalid,
    requested: jobIds.length
  };
});

// ============================================
// 푸시 메시지 순환 발송 (adminPushRotations)
// ============================================

const ADMIN_PUSH_ROTATION_MAX_HORIZON_DAYS = 60;
const ADMIN_PUSH_ROTATION_MAX_SLOTS = 28;
/** 한 번의 배정에서 만들 수 있는 최대 예약 — 슬롯 설정 실수로 폭주하는 것을 막는다 */
const ADMIN_PUSH_ROTATION_MAX_CREATE = 200;
const ADMIN_PUSH_ROTATION_MAX_OCCURRENCES = 400;

function adminPushRotationsColl() {
  return db.collection('artifacts').doc(APP_ID).collection('adminPushRotations');
}

function adminScheduledPushesColl() {
  return db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
}

/** 순환 슬롯 [{weekday:1~7, time:'HH:mm'}] — 중복 제거 후 요일·시각 순 */
function normalizeRotationSlots(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const weekday = Number(row?.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    const time = normalizeHm(row?.time);
    if (!/^\d{2}:\d{2}$/.test(time)) continue;
    const key = `${weekday}_${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ weekday, time });
  }
  out.sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time));
  return out.slice(0, ADMIN_PUSH_ROTATION_MAX_SLOTS);
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function normalizeRotationDoc(d) {
  return {
    name: String(d?.name || '기본 순환').slice(0, 60),
    enabled: d?.enabled === true,
    targetEnv: ADMIN_PUSH_TARGET_ENVS.has(String(d?.targetEnv || '')) ? String(d.targetEnv) : 'all',
    slots: normalizeRotationSlots(d?.slots),
    horizonDays: clampInt(d?.horizonDays, 1, ADMIN_PUSH_ROTATION_MAX_HORIZON_DAYS, 14),
    cycleNo: clampInt(d?.cycleNo, 0, 1e9, 0),
    deckRemaining: Array.isArray(d?.deckRemaining) ? d.deckRemaining.map(String) : [],
    deckServed: Array.isArray(d?.deckServed) ? d.deckServed.map(String) : [],
    lastAssignedMessageId: d?.lastAssignedMessageId ? String(d.lastAssignedMessageId) : null,
    newMessagePriority: d?.newMessagePriority !== false,
    priorityWindow: clampInt(d?.priorityWindow, 1, 100, 10),
    plannedUntilYmd: String(d?.plannedUntilYmd || '')
  };
}

/** 오늘부터 horizonDays 뒤까지, 슬롯 요일·시각에 걸리는 발송 시각 (KST) */
function enumerateRotationOccurrences(slots, horizonDays, minFromMs) {
  if (!slots.length) return [];
  const out = [];
  let ymd = kstYmdFromMillis(minFromMs);
  for (let day = 0; day <= horizonDays && out.length < ADMIN_PUSH_ROTATION_MAX_OCCURRENCES; day++) {
    const wd = kstWeekdayMon1Sun7FromYmd(ymd);
    for (const slot of slots) {
      if (slot.weekday !== wd) continue;
      const ms = kstMillisForYmdHm(ymd, slot.time);
      if (Number.isNaN(ms) || ms < minFromMs) continue;
      out.push({ ms, ymd, time: slot.time });
    }
    ymd = addOneKstYmd(ymd);
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/** 활성 메시지 전량 — 덱 보충과 내용 스냅샷에 모두 쓴다 */
async function fetchActiveAdminPushMessages() {
  const snap = await adminPushMessagesColl().where('active', '==', true).limit(ADMIN_PUSH_MESSAGE_MAX).get();
  return snap.docs.map((d) => {
    const data = d.data();
    const tab = String(data.landingTab || '').trim();
    return {
      id: d.id,
      title: String(data.title || ''),
      body: String(data.body || ''),
      landingTab: ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard'
    };
  });
}

/**
 * 호라이즌 안의 빈 슬롯을 덱에서 뽑아 채운다.
 * 슬롯 나열 → 문서 생성 → 덱 갱신을 한 트랜잭션으로 묶어, 실패해도 덱만 앞서나가지 않게 한다.
 * 이미 문서가 있는 슬롯은 건너뛴다 — 취소된 슬롯도 문서가 남아 다시 채워지지 않는다.
 */
async function planAdminPushRotationCore(rotationId) {
  const res = await planAdminPushRotationTransaction(rotationId);
  const { taskEntries, ...rest } = res;
  if (Array.isArray(taskEntries) && taskEntries.length > 0) {
    const enqueued = await enqueueAdminPushTasks(taskEntries);
    return { ...rest, enqueued };
  }
  return rest;
}

/**
 * 덱에서 뽑아 예약 문서를 깔기까지. 태스크는 커밋 뒤에 planAdminPushRotationCore 가 건다 —
 * 트랜잭션은 충돌하면 통째로 재시도되므로, 안에서 걸면 같은 태스크가 여러 번 쌓인다.
 */
async function planAdminPushRotationTransaction(rotationId) {
  const rotRef = adminPushRotationsColl().doc(rotationId);
  // 풀 스냅샷은 트랜잭션 밖에서 — 자주 바뀌지 않고, 재시도마다 다시 읽을 이유가 없다
  const messages = await fetchActiveAdminPushMessages();
  const byId = new Map(messages.map((m) => [m.id, m]));
  const activeIds = messages.map((m) => m.id);

  return db.runTransaction(async (tx) => {
    const rotSnap = await tx.get(rotRef);
    if (!rotSnap.exists) return { created: 0, reason: 'not-found' };
    const rot = normalizeRotationDoc(rotSnap.data());
    if (!rot.enabled) return { created: 0, reason: 'disabled' };
    if (rot.slots.length === 0) return { created: 0, reason: 'no-slots' };
    if (activeIds.length === 0) return { created: 0, reason: 'empty-pool' };

    const minFromMs = Date.now() + 60 * 1000;
    const occurrences = enumerateRotationOccurrences(rot.slots, rot.horizonDays, minFromMs);
    if (occurrences.length === 0) return { created: 0, reason: 'no-occurrence' };

    const refs = occurrences.map((o) =>
      adminScheduledPushesColl().doc(rotationSlotDocId(rotationId, o.ymd, o.time))
    );
    const snaps = await tx.getAll(...refs);

    const deck = {
      remaining: [...rot.deckRemaining],
      served: [...rot.deckServed],
      cycleNo: rot.cycleNo,
      lastAssignedMessageId: rot.lastAssignedMessageId
    };

    let created = 0;
    const taskEntries = [];
    for (let i = 0; i < occurrences.length; i++) {
      if (created >= ADMIN_PUSH_ROTATION_MAX_CREATE) break;
      if (snaps[i].exists) continue;
      const messageId = drawFromDeck(deck, activeIds);
      if (!messageId) break;
      const msg = byId.get(messageId);
      if (!msg) continue;
      tx.set(refs[i], {
        scheduleType: 'once',
        scheduleSource: 'rotation',
        rotationId,
        messageId,
        cycleNo: deck.cycleNo,
        deckIndex: deck.served.length,
        deckSize: activeIds.length,
        title: msg.title,
        body: msg.body,
        landingTab: msg.landingTab,
        targetEnv: rot.targetEnv,
        scheduledAt: Timestamp.fromMillis(occurrences[i].ms),
        status: 'pending',
        createdByUid: null,
        createdAt: FieldValue.serverTimestamp()
      });
      taskEntries.push({ docId: refs[i].id, whenMs: occurrences[i].ms });
      created++;
    }

    tx.update(rotRef, {
      deckRemaining: deck.remaining,
      deckServed: deck.served,
      cycleNo: deck.cycleNo,
      lastAssignedMessageId: deck.lastAssignedMessageId,
      plannedUntilYmd: occurrences[occurrences.length - 1].ymd,
      lastPlannedAt: FieldValue.serverTimestamp()
    });
    return {
      created,
      cycleNo: deck.cycleNo,
      remaining: deck.remaining.length,
      poolSize: activeIds.length,
      taskEntries
    };
  });
}

/**
 * 미래 pending 순환 예약을 되돌린다 — 문서를 지우고 쓰였던 메시지를 덱 앞쪽으로 돌려놓는다.
 * 지운 슬롯은 문서가 사라지므로 다음 배정에서 다시 채워진다.
 * @param {(data:object)=>boolean} [filterFn] 되돌릴 대상 (기본: 전부)
 */
async function rewindRotationAssignments(rotationId, filterFn) {
  const nowMs = Date.now();
  const snap = await adminScheduledPushesColl()
    .where('rotationId', '==', rotationId)
    .where('status', '==', 'pending')
    .limit(500)
    .get();
  const targets = snap.docs
    .filter((d) => {
      const data = d.data();
      const ms =
        data.scheduledAt && typeof data.scheduledAt.toMillis === 'function' ? data.scheduledAt.toMillis() : 0;
      if (!ms || ms <= nowMs) return false;
      return filterFn ? filterFn(data) : true;
    })
    // 원래 배정 순서대로 되돌려야 다시 채울 때 같은 순서가 나온다
    .sort((a, b) => a.data().scheduledAt.toMillis() - b.data().scheduledAt.toMillis());
  if (targets.length === 0) return { rewound: 0 };

  const returnedIds = targets.map((d) => String(d.data().messageId || '')).filter(Boolean);
  const rotRef = adminPushRotationsColl().doc(rotationId);
  await db.runTransaction(async (tx) => {
    const rotSnap = await tx.get(rotRef);
    if (rotSnap.exists) {
      const rot = normalizeRotationDoc(rotSnap.data());
      const returned = new Set(returnedIds);
      tx.update(rotRef, {
        deckRemaining: [...returnedIds, ...rot.deckRemaining.filter((id) => !returned.has(id))],
        deckServed: rot.deckServed.filter((id) => !returned.has(id))
      });
    }
    for (const d of targets) tx.delete(d.ref);
  });
  return { rewound: targets.length };
}

/** 풀이 바뀌어 영향을 받는 미래 배정을 되돌리고 다시 채운다 (비활성·삭제 시) */
async function replanRotationsForMessages(messageIds) {
  const ids = new Set(messageIds.map(String).filter(Boolean));
  if (ids.size === 0) return;
  const snap = await adminPushRotationsColl().limit(10).get();
  for (const d of snap.docs) {
    try {
      await rewindRotationAssignments(d.id, (data) => ids.has(String(data.messageId || '')));
      await planAdminPushRotationCore(d.id);
    } catch (e) {
      logger.warn('replanRotationsForMessages: failed', { rotationId: d.id, message: e?.message });
    }
  }
}

/** 새로 담은 메시지를 이번 바퀴 잔여 구간에 끼워 넣는다 (우선 배정이 켜져 있으면 앞쪽에) */
async function insertMessageIntoRotationDecks(messageId) {
  const snap = await adminPushRotationsColl().where('enabled', '==', true).limit(10).get();
  for (const docSnap of snap.docs) {
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(docSnap.ref);
        if (!s.exists) return;
        const rot = normalizeRotationDoc(s.data());
        if (rot.deckServed.includes(messageId)) return;
        const next = insertIntoDeckRemaining(rot.deckRemaining, messageId, {
          newMessagePriority: rot.newMessagePriority,
          priorityWindow: rot.priorityWindow
        });
        if (next.length === rot.deckRemaining.length) return;
        tx.update(docSnap.ref, { deckRemaining: next });
      });
    } catch (e) {
      logger.warn('insertMessageIntoRotationDecks: failed', { rotationId: docSnap.id, message: e?.message });
    }
  }
}

/** 관리자: 순환 설정 저장 — 슬롯·환경이 바뀌면 미래 배정을 다시 깐다 */
exports.saveAdminPushRotation = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  const callerUid = await assertAdminForPushPool(request, '저장할');
  const data = request.data || {};
  const rotationId = String(data.rotationId || 'default').trim() || 'default';
  const slots = normalizeRotationSlots(data.slots);
  const enabled = data.enabled === true;
  if (enabled && slots.length === 0) {
    throw new HttpsError('invalid-argument', '순환을 켜려면 발송 요일·시각을 하나 이상 지정해 주세요.');
  }
  const targetEnv = ADMIN_PUSH_TARGET_ENVS.has(String(data.targetEnv || '')) ? String(data.targetEnv) : 'all';
  const ref = adminPushRotationsColl().doc(rotationId);
  const before = await ref.get();
  const prev = before.exists ? normalizeRotationDoc(before.data()) : null;

  await ref.set(
    {
      name: String(data.name || '기본 순환').slice(0, 60),
      enabled,
      targetEnv,
      slots,
      horizonDays: clampInt(data.horizonDays, 1, ADMIN_PUSH_ROTATION_MAX_HORIZON_DAYS, 14),
      newMessagePriority: data.newMessagePriority !== false,
      priorityWindow: clampInt(data.priorityWindow, 1, 100, 10),
      updatedAt: FieldValue.serverTimestamp(),
      updatedByUid: callerUid
    },
    { merge: true }
  );

  // 발송 조건이 달라졌으면 이미 깔린 미래 배정은 지금 설정과 맞지 않는다
  const scheduleChanged =
    !prev || prev.targetEnv !== targetEnv || JSON.stringify(prev.slots) !== JSON.stringify(slots);
  if (scheduleChanged) {
    await rewindRotationAssignments(rotationId);
  }
  const planned = enabled ? await planAdminPushRotationCore(rotationId) : { created: 0, reason: 'disabled' };
  return { ok: true, id: rotationId, planned };
});

/** 관리자: 지금 다시 채우기 */
exports.planAdminPushRotationNow = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  await assertAdminForPushPool(request, '배정할');
  const rotationId = String(request.data?.rotationId || 'default').trim() || 'default';
  const planned = await planAdminPushRotationCore(rotationId);
  return { ok: true, planned };
});

/** 관리자: 남은 바퀴 다시 섞기 — 미래 배정을 되돌리고 잔여 덱을 재셔플한 뒤 다시 깐다 */
exports.reshuffleAdminPushRotation = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  await assertAdminForPushPool(request, '재배정할');
  const rotationId = String(request.data?.rotationId || 'default').trim() || 'default';
  const rewound = await rewindRotationAssignments(rotationId);
  const rotRef = adminPushRotationsColl().doc(rotationId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(rotRef);
    if (!s.exists) return;
    const rot = normalizeRotationDoc(s.data());
    tx.update(rotRef, { deckRemaining: shuffleIds(rot.deckRemaining) });
  });
  const planned = await planAdminPushRotationCore(rotationId);
  return { ok: true, rewound: rewound.rewound, planned };
});

/** 관리자: 예약 1건만 다른 메시지로 재추첨 */
exports.rerollAdminScheduledPush = onCall({ region: REGION }, async (request) => {
  await assertAdminForPushPool(request, '재추첨할');
  const jobId = String(request.data?.jobId || '').trim();
  if (!jobId) {
    throw new HttpsError('invalid-argument', '예약 ID(jobId)가 필요합니다.');
  }
  const jobRef = adminScheduledPushesColl().doc(jobId);
  const jobSnap = await jobRef.get();
  if (!jobSnap.exists) {
    throw new HttpsError('not-found', '예약을 찾을 수 없습니다.');
  }
  const job = jobSnap.data();
  if (String(job.scheduleSource || '') !== 'rotation') {
    throw new HttpsError('failed-precondition', '순환에서 만든 예약만 재추첨할 수 있습니다.');
  }
  if (String(job.status || '') !== 'pending') {
    throw new HttpsError('failed-precondition', '대기 중인 예약만 재추첨할 수 있습니다.');
  }
  const rotationId = String(job.rotationId || 'default');
  const messages = await fetchActiveAdminPushMessages();
  if (messages.length === 0) {
    throw new HttpsError('failed-precondition', '풀에 활성 메시지가 없습니다.');
  }
  const byId = new Map(messages.map((m) => [m.id, m]));
  const activeIds = messages.map((m) => m.id);
  const oldId = String(job.messageId || '');

  const rotRef = adminPushRotationsColl().doc(rotationId);
  const picked = await db.runTransaction(async (tx) => {
    const rotSnap = await tx.get(rotRef);
    if (!rotSnap.exists) throw new HttpsError('not-found', '순환 설정을 찾을 수 없습니다.');
    const rot = normalizeRotationDoc(rotSnap.data());
    const deck = {
      // 쓰던 메시지는 잔여 덱 맨 뒤로 — 바로 다시 뽑히지 않게
      remaining: [...rot.deckRemaining.filter((id) => id !== oldId), ...(oldId ? [oldId] : [])],
      served: rot.deckServed.filter((id) => id !== oldId),
      cycleNo: rot.cycleNo,
      lastAssignedMessageId: rot.lastAssignedMessageId
    };
    const messageId = drawFromDeck(deck, activeIds);
    if (!messageId) throw new HttpsError('failed-precondition', '뽑을 메시지가 없습니다.');
    const msg = byId.get(messageId);
    tx.update(rotRef, {
      deckRemaining: deck.remaining,
      deckServed: deck.served,
      cycleNo: deck.cycleNo,
      lastAssignedMessageId: deck.lastAssignedMessageId
    });
    tx.update(jobRef, {
      messageId,
      title: msg.title,
      body: msg.body,
      landingTab: msg.landingTab,
      cycleNo: deck.cycleNo,
      deckIndex: deck.served.length,
      rerolledAt: FieldValue.serverTimestamp()
    });
    return { messageId, title: msg.title };
  });
  return { ok: true, ...picked };
});

/**
 * 순환 배정: 매일 호라이즌을 한 칸씩 민다
 */
exports.planAdminPushRotations = onSchedule(
  {
    schedule: '10 3 * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const snap = await adminPushRotationsColl().where('enabled', '==', true).limit(10).get();
    for (const d of snap.docs) {
      try {
        const res = await planAdminPushRotationCore(d.id);
        logger.info('planAdminPushRotations: planned', { rotationId: d.id, ...res });
      } catch (e) {
        logger.error('planAdminPushRotations: failed', { rotationId: d.id, message: e?.message });
      }
    }
  }
);

/**
 * 예약 한 건을 실제로 보낸다. Cloud Tasks 태스크와 안전망 폴링이 이 경로를 함께 쓴다.
 *
 * @param {string} docId 예약 문서 ID
 * @param {FirebaseFirestore.DocumentReference} ref
 * @param {number} nowMs 이 시각까지 예정된 건만 집는다.
 *   태스크는 예정 시각보다 조금 일찍 도착할 수 있어 여유를 얹어 넘긴다.
 * @returns {Promise<'sent'|'skipped'|'failed'>}
 */
async function deliverAdminScheduledPushDoc(docId, ref, nowMs) {
  try {
    const acquired = await db.runTransaction(async (transaction) => {
      const s = await transaction.get(ref);
      if (!s.exists) return false;
      const d = s.data();
      if (d.status !== 'pending') return false;
      const sa = d.scheduledAt;
      const ms = sa && typeof sa.toMillis === 'function' ? sa.toMillis() : 0;
      if (!ms || ms > nowMs) return false;
      transaction.update(ref, { status: 'sending', lockedAt: FieldValue.serverTimestamp() });
      return true;
    });

    // 취소됐거나, 다른 경로가 이미 집어갔거나, 시각이 미뤄진 건 — 조용히 넘긴다
    if (!acquired) return 'skipped';

    const after = await ref.get();
    const d = after.data();
    if (!after.exists || d.status !== 'sending') return 'skipped';

    const isWeeklyByDay = d.recurringMode === 'weeklyByDay' && Array.isArray(d.weeklySchedule);
    let title = String(d.title || '').trim();
    let body = String(d.body || '').trim();
    let landingTab = ADMIN_PUSH_LANDING_TABS.has(String(d.landingTab || '').trim())
      ? String(d.landingTab).trim()
      : 'dashboard';
    let pushTargetEnv = d.targetEnv === 'production' || d.targetEnv === 'staging' ? d.targetEnv : 'all';

    if (isWeeklyByDay) {
      const slot = findWeeklySlotForScheduledAt(d.weeklySchedule, d.scheduledAt);
      if (!slot) {
        await ref.update({
          status: 'failed',
          errorMessage: '요일별 슬롯 매칭 실패',
          failedAt: FieldValue.serverTimestamp()
        });
        return 'failed';
      }
      title = slot.title;
      body = slot.body;
      landingTab = slot.landingTab;
      pushTargetEnv = slot.targetEnv;
    }

    if (!title || !body) {
      await ref.update({
        status: 'failed',
        errorMessage: '제목/내용 누락',
        failedAt: FieldValue.serverTimestamp()
      });
      return 'failed';
    }

    const { recipientCount } = await broadcastAdminPushToAllUsers({
      title,
      body,
      targetEnv: pushTargetEnv,
      data: { type: 'adminBroadcast', landingTab }
    });

    const scheduleType = d.scheduleType || 'once';
    if (scheduleType === 'recurring') {
      if (isWeeklyByDay) {
        const rangeStartMs =
          d.recurringStartAt && typeof d.recurringStartAt.toMillis === 'function'
            ? d.recurringStartAt.toMillis()
            : 0;
        const rangeEndMs =
          d.recurringEndAt && typeof d.recurringEndAt.toMillis === 'function'
            ? d.recurringEndAt.toMillis()
            : 0;
        const thisRunMs = d.scheduledAt && typeof d.scheduledAt.toMillis === 'function' ? d.scheduledAt.toMillis() : nowMs;
        const nextMs = computeNextWeeklySlotMillis(
          d.weeklySchedule,
          rangeStartMs,
          rangeEndMs,
          thisRunMs + 60 * 1000
        );
        if (nextMs == null || !rangeEndMs || nextMs > rangeEndMs) {
          await ref.update({
            status: 'completed',
            sentAt: FieldValue.serverTimestamp(),
            lastSentAt: FieldValue.serverTimestamp(),
            occurrenceCount: FieldValue.increment(1),
            recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
          });
          logger.info('deliverAdminScheduledPush: weeklyByDay completed', { id: docId });
        } else {
          await ref.update({
            status: 'pending',
            scheduledAt: Timestamp.fromMillis(nextMs),
            lastSentAt: FieldValue.serverTimestamp(),
            occurrenceCount: FieldValue.increment(1),
            recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
          });
          await enqueueAdminPushTask(docId, nextMs);
          logger.info('deliverAdminScheduledPush: weeklyByDay next', { id: docId, nextMs });
        }
      } else {
        const endMs = d.recurringEndAt && typeof d.recurringEndAt.toMillis === 'function' ? d.recurringEndAt.toMillis() : 0;
        const intervalRaw = String(d.recurringInterval || 'daily').trim();
        const interval = ADMIN_RECURRING_INTERVALS.has(intervalRaw) ? intervalRaw : 'daily';
        const thisRunMs = d.scheduledAt && typeof d.scheduledAt.toMillis === 'function' ? d.scheduledAt.toMillis() : nowMs;
        const nextMs = addRecurringNextMillis(thisRunMs, interval);
        if (!endMs || nextMs > endMs) {
          await ref.update({
            status: 'completed',
            sentAt: FieldValue.serverTimestamp(),
            lastSentAt: FieldValue.serverTimestamp(),
            occurrenceCount: FieldValue.increment(1),
            recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
          });
          logger.info('deliverAdminScheduledPush: recurring completed', { id: docId });
        } else {
          await ref.update({
            status: 'pending',
            scheduledAt: Timestamp.fromMillis(nextMs),
            lastSentAt: FieldValue.serverTimestamp(),
            occurrenceCount: FieldValue.increment(1),
            recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
          });
          await enqueueAdminPushTask(docId, nextMs);
          logger.info('deliverAdminScheduledPush: recurring next scheduled', { id: docId, nextMs });
        }
      }
    } else {
      await ref.update({
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
        recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
      });
      logger.info('deliverAdminScheduledPush: sent', { id: docId });
    }

    // 풀에서 온 메시지면 사용 횟수 집계 (실패해도 발송에는 영향 없음)
    const sourceMessageId = String(d.messageId || '').trim();
    if (sourceMessageId) {
      try {
        await adminPushMessagesColl().doc(sourceMessageId).update({
          useCount: FieldValue.increment(1),
          lastUsedAt: FieldValue.serverTimestamp()
        });
      } catch (useErr) {
        logger.warn('deliverAdminScheduledPush: useCount update failed', {
          messageId: sourceMessageId,
          message: useErr?.message
        });
      }
    }
    return 'sent';
  } catch (e) {
    logger.error('deliverAdminScheduledPush: error', { id: docId, message: e?.message });
    try {
      await ref.update({
        status: 'failed',
        errorMessage: String(e?.message || e).slice(0, 500),
        failedAt: FieldValue.serverTimestamp()
      });
    } catch (_) {}
    return 'failed';
  }
}

/**
 * 예약 푸시 발송 — 예약을 만들 때 걸어 둔 Cloud Tasks 태스크가 예정 시각에 이걸 부른다.
 *
 * 태스크는 취소·수정을 모른다. 그래서 태스크를 지우는 대신 여기서 문서를 보고 판단한다:
 * 취소됐으면 status 가 pending 이 아니고, 시각이 미뤄졌으면 scheduledAt 이 아직 미래다.
 * 둘 다 조용히 넘어가고, 미뤄진 건은 그때 새로 걸어 둔 태스크가 처리한다.
 */
exports.deliverScheduledAdminPush = onTaskDispatched(
  {
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB',
    retryConfig: { maxAttempts: 3, minBackoffSeconds: 30 },
    rateLimits: { maxConcurrentDispatches: 5 }
  },
  async (request) => {
    const docId = String(request.data?.docId || '').trim();
    if (!docId) {
      logger.warn('deliverScheduledAdminPush: docId 없음');
      return;
    }
    const ref = adminScheduledPushesColl().doc(docId);
    // 태스크는 예정 시각보다 살짝 이르게 도착할 수 있다 — 그 정도는 「지금」으로 친다
    await deliverAdminScheduledPushDoc(docId, ref, Date.now() + ADMIN_PUSH_TASK_EARLY_TOLERANCE_MS);
  }
);

/**
 * 예약 푸시 안전망 — 태스크가 유실됐거나(enqueue 실패, 큐 오류),
 * 너무 먼 미래라 태스크를 걸지 못한 예약을 주워 담는다.
 *
 * 예전에는 이게 매분 돌면서 유일한 발송 경로였다. 발송 시각은 문서에 이미 적혀 있는데
 * 1분마다 "지금 보낼 게 있나"를 다시 묻는 구조라, 월 43,200번 깨어나 대부분 빈손으로 돌아갔다.
 * 이제 정상 경로는 태스크이고 이쪽은 그물이라, 주기를 늘려도 발송이 늦어지지 않는다.
 */
exports.processScheduledAdminPushes = onSchedule(
  {
    schedule: '*/10 * * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const nowMs = Date.now();
    const snap = await adminScheduledPushesColl()
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', Timestamp.fromMillis(nowMs))
      .limit(25)
      .get();

    let sent = 0;
    for (const docSnap of snap.docs) {
      const r = await deliverAdminScheduledPushDoc(docSnap.id, docSnap.ref, nowMs);
      if (r === 'sent') sent++;
    }
    // 태스크가 제 몫을 하면 여기 걸릴 게 없다 — 잡혔다면 그물이 일한 것이니 남긴다
    if (sent > 0) {
      logger.warn('processScheduledAdminPushes: 태스크가 놓친 예약을 안전망이 발송했습니다', {
        picked: snap.size,
        sent
      });
    }

    await reenqueueUpcomingAdminPushTasks(nowMs);
  }
);

/** 태스크를 다시 걸어 줄 범위. 스윕이 매시간이라 넉넉히 앞을 본다 */
const ADMIN_PUSH_TASK_SWEEP_AHEAD_MS = 2 * 60 * 60 * 1000;

/**
 * 태스크를 못 받은 임박 예약에 다시 태스크를 건다 — 이 구조 이전에 만들어진 예약,
 * enqueue 가 실패했던 예약이 대상이다.
 *
 * 어느 예약에 태스크가 걸려 있는지는 따로 적어 두지 않는다. 중복으로 걸려도
 * 발송은 트랜잭션 락으로 한 번뿐이라(뒤에 온 태스크는 status 가 pending 이 아니라 물러난다),
 * 태스크 유무를 추적하느라 문서에 쓰기를 더하는 것보다 그냥 다시 거는 쪽이 싸다.
 *
 * 매 폴링마다 하면 읽기가 늘어나므로 정시 실행분에서만 돈다(= 시간당 1회).
 */
async function reenqueueUpcomingAdminPushTasks(nowMs) {
  if (new Date(nowMs).getMinutes() >= 10) return;
  try {
    const snap = await adminScheduledPushesColl()
      .where('status', '==', 'pending')
      .where('scheduledAt', '<=', Timestamp.fromMillis(nowMs + ADMIN_PUSH_TASK_SWEEP_AHEAD_MS))
      .limit(100)
      .get();
    if (snap.empty) return;
    const entries = [];
    for (const docSnap of snap.docs) {
      const ms = docSnap.data()?.scheduledAt?.toMillis?.();
      // 이미 지난 건은 위 루프가 방금 처리했다
      if (typeof ms === 'number' && ms > nowMs) entries.push({ docId: docSnap.id, whenMs: ms });
    }
    if (entries.length === 0) return;
    const enqueued = await enqueueAdminPushTasks(entries);
    logger.info('processScheduledAdminPushes: 임박 예약에 태스크를 다시 걸었습니다', {
      candidates: entries.length,
      enqueued
    });
  } catch (e) {
    logger.warn('processScheduledAdminPushes: 태스크 재예약 스윕 실패', { message: e?.message || String(e) });
  }
}

/**
 * 공지: pushFrequency === once 이고 아직 pushSentAt 없으면 전체 푸시 1회 후 pushSentAt 기록
 */
exports.onNoticePushOnce = onDocumentWritten(
  {
    document: `artifacts/${APP_ID}/notices/{noticeId}`,
    region: REGION
  },
  async (event) => {
    const noticeId = event.params.noticeId;
    const afterSnap = event.data.after;
    if (!afterSnap.exists) return;
    const after = afterSnap.data();
    if (!after || after.hidden === true || after.deleted === true) return;
    if ((after.pushFrequency || 'none') !== 'once') return;

    const noticeRef = afterSnap.ref;
    const shouldSend = await db.runTransaction(async (tx) => {
      const snap = await tx.get(noticeRef);
      if (!snap.exists) return false;
      const cur = snap.data();
      if (!cur || cur.hidden === true || cur.deleted === true) return false;
      if ((cur.pushFrequency || 'none') !== 'once') return false;
      if (cur.pushSentAt) return false;
      tx.set(noticeRef, { pushSentAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
    if (!shouldSend) return;

    const title = (after.title || '공지').trim();
    const body = noticePlainTextForPush(after.content || '');
    const payload = {
      title: `📢 ${title}`,
      body,
      data: { type: 'notice', noticeId: String(noticeId) }
    };

    try {
      await broadcastNoticePushToAllUsers(payload);
      logger.info('onNoticePushOnce: ok', { noticeId });
    } catch (e) {
      logger.error('onNoticePushOnce failed', { noticeId, message: e?.message });
    }
  }
);

/**
 * 공지: pushFrequency === daily 인 문서마다 서울 기준 당일 미발송이면 전체 푸시 (매일 09:00)
 */
exports.scheduledNoticeDailyPush = onSchedule(
  {
    schedule: '0 9 * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const noticesRef = db.collection('artifacts').doc(APP_ID).collection('notices');
    const snap = await noticesRef.where('pushFrequency', '==', 'daily').get();
    const todaySeoul = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());

    for (const docSnap of snap.docs) {
      const n = docSnap.data();
      if (n.hidden === true || n.deleted === true) continue;

      const noticeRef = docSnap.ref;
      const shouldSend = await db.runTransaction(async (tx) => {
        const curSnap = await tx.get(noticeRef);
        if (!curSnap.exists) return false;
        const cur = curSnap.data();
        if (cur.hidden === true || cur.deleted === true) return false;
        if (cur.lastDailyPushDate === todaySeoul) return false;
        tx.set(noticeRef, { lastDailyPushDate: todaySeoul }, { merge: true });
        return true;
      });
      if (!shouldSend) continue;

      const title = (n.title || '공지').trim();
      const body = noticePlainTextForPush(n.content || '');
      const payload = {
        title: `📢 ${title}`,
        body,
        data: { type: 'notice', noticeId: docSnap.id }
      };

      try {
        await broadcastNoticePushToAllUsers(payload);
        logger.info('scheduledNoticeDailyPush: ok', { noticeId: docSnap.id, todaySeoul });
      } catch (e) {
        logger.error('scheduledNoticeDailyPush failed', { noticeId: docSnap.id, message: e?.message });
      }
    }
  }
);

// --- 웰컴 API: 전일(서울) 기준 연속 기록 N일 사용자 (관리자 전용) ---

function adminSeoulYmdFromDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function adminYmdAddDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d, 12, 0, 0) + delta * 86400000;
  return adminSeoulYmdFromDate(new Date(ms));
}

function adminBuildRecordedDateSetFromDaily(daily) {
  const set = new Set();
  if (!daily || typeof daily !== 'object') return set;
  for (const [iso, day] of Object.entries(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const c = day && typeof day === 'object' ? Number(day.count) || 0 : 0;
    if (c > 0) set.add(iso);
  }
  return set;
}

/** 앱 출석 팝업(attendance-check)과 동일: 오늘(서울) 기준 어제부터 역순 연속 일수 */
function adminComputeStreakFromYesterday(dateSet, todaySeoulYmd) {
  const yesterday = adminYmdAddDays(todaySeoulYmd, -1);
  if (!dateSet.has(yesterday)) return 0;
  let streak = 0;
  let cursor = yesterday;
  while (dateSet.has(cursor)) {
    streak++;
    cursor = adminYmdAddDays(cursor, -1);
  }
  return streak;
}

async function adminLoadMergedDaily(uid) {
  const yearsSnap = await db
    .collection('artifacts')
    .doc(APP_ID)
    .collection('users')
    .doc(uid)
    .collection('config')
    .doc('stats')
    .collection('years')
    .get();
  const merged = {};
  yearsSnap.docs.forEach((doc) => {
    const daily = doc.data().daily;
    if (daily && typeof daily === 'object') Object.assign(merged, daily);
  });
  return merged;
}

async function adminListAllUserIds() {
  const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
  const ids = [];
  const pageSize = 800;
  let lastDoc = null;
  for (;;) {
    let q = usersRef.orderBy(FieldPath.documentId()).limit(pageSize);
    if (lastDoc) q = q.startAfter(lastDoc);
    const snap = await q.get();
    if (snap.empty) break;
    snap.docs.forEach((d) => ids.push(d.id));
    if (snap.size < pageSize) break;
    lastDoc = snap.docs[snap.docs.length - 1];
  }
  return ids;
}

/** 전일(서울) 기준 최근 3개 일자: 3일 전 ~ 전일 */
function adminThreeSeoulDatesEndingYesterday(todaySeoulYmd) {
  const y1 = adminYmdAddDays(todaySeoulYmd, -1);
  const y2 = adminYmdAddDays(todaySeoulYmd, -2);
  const y3 = adminYmdAddDays(todaySeoulYmd, -3);
  return [y3, y2, y1];
}

function adminSlotLabelKr(slotId) {
  const m = {
    morning: '아침',
    lunch: '점심',
    dinner: '저녁',
    pre_morning: '새참',
    snack1: '간식',
    snack2: '간식',
    night: '저녁 후 간식'
  };
  return m[slotId] || (slotId ? String(slotId) : '');
}

function adminTruncateText(s, max) {
  const t = (s == null ? '' : String(s)).trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 무엇을(메뉴/상세): 모니터링(feed-moderation)과 동일하게 menuDetail 우선, 없으면 snackDetail.
 * 구버전·간식 기록은 snackDetail만 있는 경우가 많음.
 */
function adminMealMenuDetailText(d) {
  const fromMenu = (d.menuDetail != null ? String(d.menuDetail) : '').trim();
  if (fromMenu) return fromMenu;
  return (d.snackDetail != null ? String(d.snackDetail) : '').trim();
}

/** 어디서: place 우선, 간식은 snackPlace */
function adminMealPlaceText(d) {
  const p = (d.place != null ? String(d.place) : '').trim();
  if (p) return p;
  return (d.snackPlace != null ? String(d.snackPlace) : '').trim();
}

const ADMIN_SATIETY_LABELS = {
  1: '한입만',
  2: '가볍게',
  3: '적당히',
  4: '든든하게',
  5: '과식'
};

function adminMealTimeText(d) {
  const mc = (d.mealClock != null ? String(d.mealClock) : '').trim();
  if (mc && /^\d{1,2}:\d{2}/.test(mc)) {
    const hm = mc.match(/^(\d{1,2}):(\d{2})/);
    if (hm) return `${String(hm[1]).padStart(2, '0')}:${hm[2]}`;
  }
  const t = (d.time != null ? String(d.time) : '').trim();
  if (!t) return '';
  const hm = t.match(/^(\d{1,2}):(\d{2})/);
  return hm ? `${String(hm[1]).padStart(2, '0')}:${hm[2]}` : '';
}

function adminMealRatingText(d) {
  const n = Number(d.rating);
  if (!Number.isFinite(n) || n < 1 || n > 5) return '';
  return `만족도 ${Math.round(n)}/5`;
}

function adminMealSatietyText(d) {
  const n = Number(d.satiety);
  if (!Number.isFinite(n) || n < 1 || n > 5) return '';
  const label = ADMIN_SATIETY_LABELS[Math.round(n)] || '';
  return label ? `포만감 ${Math.round(n)}/5 (${label})` : `포만감 ${Math.round(n)}/5`;
}

/** 간식 슬롯 — js/constants.js SLOTS 의 type: 'snack' 과 같아야 한다 */
const ADMIN_SNACK_SLOT_IDS = new Set(['pre_morning', 'snack1', 'snack2', 'night']);

/**
 * 확정 분류가 비었을 때 대신 쓸 자동 분류값. 채워져 있으면 ''(그대로 두라는 뜻).
 *
 * 사용자가 칩을 확정하면 category(끼니)·snackType(간식)에 들어가지만, **제안을 그대로 두고
 * 저장하면 categoryAuto 에만** 들어간다(js/modals/entry-save-record.js 자동 분류 블록).
 * 2026-08 기록 시트 개편 뒤로는 후자가 기본 동선이라, 확정 필드만 읽으면 분류가 붙은
 * 기록의 대부분이 빈 값으로 보인다 — 8/23 주 기준 확정 10% / 자동만 55%.
 *
 * 그래서 식단분석에 보내는 슬롯 상세에서 '무엇을'이 통째로 빠지고 있었다. 클라이언트는
 * 이미 확정값 우선·없으면 자동값으로 읽는다(js/analytics/meal-analytics-tags.js
 * effectiveCategoryForAnalytics) — 서버도 같은 규칙으로 맞춘다.
 *
 * 두 확정 필드가 동시에 채워지는 문서는 없다(2026-08-26 전수 확인: 0건). 그래서 슬롯을
 * 보지 않고 「둘 중 채워진 쪽」으로 판단해도 안전하며, 슬롯과 필드가 어긋난 옛 문서 7건도
 * 함께 살릴 수 있다. 슬롯은 '간식:' 라벨을 붙일지에만 쓴다.
 *
 * @param {boolean} [labeled] 간식 슬롯이면 '간식:' 을 붙인다 (슬롯 상세용)
 */
function adminMealAutoFormText(d, labeled = false) {
  if (String(d?.category || '').trim() || String(d?.snackType || '').trim()) return '';
  const auto = String(d?.categoryAuto || '').trim();
  if (!auto) return '';
  return labeled && ADMIN_SNACK_SLOT_IDS.has(String(d?.slotId || '')) ? `간식:${auto}` : auto;
}

/** 한 줄 요약(웰컴 API 표시용): 입력창 메뉴·메모 등 포함 */
function adminMealShortLine(d) {
  const mt = (d.mealType || '').trim();
  if (mt === 'Skip' || mt === '건너뜀') return '건너뜀';
  const bits = [mt];
  if (d.category) bits.push(String(d.category).trim());
  const st = (d.snackType || '').trim();
  if (st) bits.push(st);
  const autoForm = adminMealAutoFormText(d);
  if (autoForm) bits.push(autoForm);
  const md = adminTruncateText(adminMealMenuDetailText(d), 56);
  if (md) bits.push(`메뉴:${md}`);
  const whom = (d.withWhomDetail || d.withWhom || '').trim();
  if (whom) {
    bits.push(adminTruncateText(whom, 24));
  }
  const pl = adminMealPlaceText(d);
  if (pl) bits.push(pl);
  const dv = (d.deliveryVendor || '').trim();
  if (dv) bits.push(`배달:${adminTruncateText(dv, 20)}`);
  const cm = adminTruncateText(d.comment, 40);
  if (cm) bits.push(`코멘트:${cm}`);
  return bits.filter(Boolean).slice(0, 9).join('·');
}

/** 제미나이용: 슬롯별 상세(메뉴 입력·메모 등 전부 활용) */
function adminMealSlotDetailForGemini(d) {
  const mt = (d.mealType || '').trim();
  if (mt === 'Skip' || mt === '건너뜀') return '건너뜀';
  const lines = [];
  const top = [];
  if (mt) top.push(mt);
  if (d.category) top.push(String(d.category).trim());
  const st = (d.snackType || '').trim();
  if (st) top.push(`간식:${st}`);
  const autoForm = adminMealAutoFormText(d, true);
  if (autoForm) top.push(autoForm);
  if (top.length) lines.push(top.join(' · '));
  const menuFull = adminMealMenuDetailText(d);
  if (menuFull) lines.push(`메뉴: ${menuFull}`);
  const pl = adminMealPlaceText(d);
  if (pl) lines.push(`장소: ${pl}`);
  const placeSub = (d.placeDetail || d.placeMemo || '').trim();
  if (placeSub) lines.push(`장소 상세: ${placeSub.length > 80 ? `${placeSub.slice(0, 78)}…` : placeSub}`);
  const whom = (d.withWhomDetail || d.withWhom || '').trim();
  if (whom) lines.push(`함께: ${whom}`);
  const dv = (d.deliveryVendor || '').trim();
  if (dv) lines.push(`배달/업체: ${dv}`);
  const cm = (d.comment != null ? String(d.comment) : '').trim();
  if (cm) lines.push(`코멘트: ${cm.length > 200 ? `${cm.slice(0, 198)}…` : cm}`);
  const timeTxt = adminMealTimeText(d);
  if (timeTxt) lines.push(`시간: ${timeTxt}`);
  const ratingTxt = adminMealRatingText(d);
  if (ratingTxt) lines.push(ratingTxt);
  const satietyTxt = adminMealSatietyText(d);
  if (satietyTxt) lines.push(satietyTxt);
  return lines.join('\n    ');
}

async function adminFetchMealsForDates(uid, datesYmd) {
  if (!datesYmd || datesYmd.length === 0) return [];
  const mealsRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(uid).collection('meals');
  const snap = await mealsRef.where('date', 'in', datesYmd).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function adminNormalizeDailyJournalEntry(raw) {
  const empty = { comment: '' };
  if (raw == null || raw === '') return { ...empty };
  if (typeof raw === 'string') return { comment: String(raw).trim() };
  if (typeof raw === 'object') {
    return { comment: String(raw.comment || '').trim() };
  }
  return { ...empty };
}

/** userSettings.dailyComments[date] — 없으면 meals 미러(dailyJournal_*) 폴백 */
async function adminFetchDailyJournalForDate(uid, dateStr) {
  const dk = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return adminNormalizeDailyJournalEntry(null);
  try {
    const settingsRef = db.doc(`artifacts/${APP_ID}/users/${uid}/config/settings`);
    const snap = await settingsRef.get();
    const dailyComments = snap.exists ? snap.data().dailyComments : null;
    if (dailyComments && dailyComments[dk] != null) {
      return adminNormalizeDailyJournalEntry(dailyComments[dk]);
    }
  } catch (e) {
    logger.warn('adminFetchDailyJournalForDate settings failed', { uid, dateStr: dk, errMsg: e?.message });
  }
  try {
    const mealSnap = await db.doc(`artifacts/${APP_ID}/users/${uid}/meals/dailyJournal_${dk}`).get();
    if (mealSnap.exists) {
      return adminNormalizeDailyJournalEntry(mealSnap.data());
    }
  } catch (e) {
    logger.warn('adminFetchDailyJournalForDate meal mirror failed', { uid, dateStr: dk, errMsg: e?.message });
  }
  return adminNormalizeDailyJournalEntry(null);
}

function formatDailyJournalBlockForDiet(dateStr, entry) {
  const comment = adminNormalizeDailyJournalEntry(entry).comment;
  if (!comment) return '';
  const clipped = comment.length > 800 ? `${comment.slice(0, 798)}…` : comment;
  return `\n\n[하루소감 · ${dateStr}]\n${clipped}`;
}

function adminMealCommentText(d) {
  return (d.comment != null ? String(d.comment) : '').trim();
}

function adminFormatMealsSummary(meals, datesChronologicalAsc) {
  const byDate = {};
  datesChronologicalAsc.forEach((d) => {
    byDate[d] = [];
  });
  for (const m of meals) {
    const dt = m.date;
    if (dt && byDate[dt]) byDate[dt].push(m);
  }
  const lines = [];
  for (const dt of datesChronologicalAsc) {
    const arr = byDate[dt];
    if (!arr.length) {
      lines.push(`${dt}: 기록 없음`);
      continue;
    }
    arr.sort((a, b) => String(a.slotId || '').localeCompare(String(b.slotId || '')));
    const parts = arr.map((x) => {
      const sl = adminSlotLabelKr(x.slotId);
      const line = adminMealShortLine(x);
      return sl ? `${sl} ${line}`.trim() : line;
    });
    lines.push(`${dt}: ${parts.join(' / ')}`);
  }
  return lines.join('\n');
}

/** 제미나이 프롬프트용: 일자·슬롯 구분, 요약 통계 포함(연속 일수 등은 본문에 넣지 않음) */
function adminFormatMealsForGemini(meals, datesChronologicalAsc, analysisAnchorSeoul) {
  const dayLabels = ['그전 날', '전전일', '전일'];
  const byDate = {};
  datesChronologicalAsc.forEach((d) => {
    byDate[d] = [];
  });
  for (const m of meals) {
    const dt = m.date;
    if (dt && byDate[dt]) byDate[dt].push(m);
  }
  let totalSlots = 0;
  let skipSlots = 0;
  let daysWithRecord = 0;
  const blocks = [];
  for (let i = 0; i < datesChronologicalAsc.length; i++) {
    const dt = datesChronologicalAsc[i];
    const tag = dayLabels[i] || '';
    const arr = byDate[dt];
    if (!arr.length) {
      blocks.push(`■ ${dt}${tag ? ` (${tag})` : ''}\n  · 기록 없음`);
      continue;
    }
    daysWithRecord += 1;
    arr.sort((a, b) => String(a.slotId || '').localeCompare(String(b.slotId || '')));
    const slotLines = [];
    for (const x of arr) {
      const sl = adminSlotLabelKr(x.slotId) || '슬롯';
      const detail = adminMealSlotDetailForGemini(x);
      totalSlots += 1;
      if (detail === '건너뜀') skipSlots += 1;
      slotLines.push(`  · ${sl}:\n    ${detail}`);
    }
    blocks.push(`■ ${dt}${tag ? ` (${tag})` : ''}\n${slotLines.join('\n')}`);
  }
  const stat = `【3일 요약】 기록이 있는 날 ${daysWithRecord}/3일 · 슬롯 ${totalSlots}건(건너뜀 ${skipSlots}건)`;
  return [
    '【제미나이 입력용 · 최근 3일 식사】',
    `기준일(서울, 전일): ${analysisAnchorSeoul}`,
    '',
    ...blocks,
    '',
    stat
  ].join('\n');
}

async function adminBuildRecentThreeDaysSummary(uid, todaySeoulYmd) {
  const dates = adminThreeSeoulDatesEndingYesterday(todaySeoulYmd);
  const meals = await adminFetchMealsForDates(uid, dates);
  return adminFormatMealsSummary(meals, dates);
}

async function adminBuildRecentThreeDaysForGemini(uid, todaySeoulYmd, streakDays) {
  void streakDays;
  const dates = adminThreeSeoulDatesEndingYesterday(todaySeoulYmd);
  const meals = await adminFetchMealsForDates(uid, dates);
  const analysisAnchorSeoul = adminYmdAddDays(todaySeoulYmd, -1);
  return adminFormatMealsForGemini(meals, dates, analysisAnchorSeoul);
}

/** 웰컴 제미나이 코멘트 저장 (관리자 화면 재조회 시 재사용) */
const WELCOME_GEMINI_COMMENT_COLL = 'adminWelcomeGeminiComments';
/** 웰컴 한 줄: 메뉴·동행 연상 + 오늘 응원 (공백 포함 글자 수 상한) */
const WELCOME_GEMINI_COMMENT_MAX_CHARS = 50;

function adminWelcomeGeminiCommentDocRef(uid) {
  return db.collection('artifacts').doc(APP_ID).collection(WELCOME_GEMINI_COMMENT_COLL).doc(uid);
}

async function adminSaveWelcomeGeminiComment(uid, comment, analysisAnchorSeoul) {
  const c = typeof comment === 'string' ? comment.trim() : '';
  if (!uid || !c) return;
  await adminWelcomeGeminiCommentDocRef(uid).set(
    {
      comment: c,
      analysisAnchorSeoul: analysisAnchorSeoul || '',
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

/**
 * @param {string[]} uids
 * @param {string} analysisAnchorSeoul 전일(서울) — 다르면 저장분 무시
 * @returns {Record<string, string>}
 */
async function adminLoadWelcomeGeminiCommentsForUids(uids, analysisAnchorSeoul) {
  const out = {};
  if (!uids || !uids.length || !analysisAnchorSeoul) return out;
  const CHUNK = 100;
  for (let i = 0; i < uids.length; i += CHUNK) {
    const slice = uids.slice(i, i + CHUNK);
    const refs = slice.map((uid) => adminWelcomeGeminiCommentDocRef(uid));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, j) => {
      if (!snap.exists) return;
      const d = snap.data();
      const c = typeof d.comment === 'string' ? d.comment.trim() : '';
      const anchor = typeof d.analysisAnchorSeoul === 'string' ? d.analysisAnchorSeoul.trim() : '';
      if (!c) return;
      if (anchor !== analysisAnchorSeoul) return;
      out[slice[j]] = c;
    });
  }
  return out;
}

/** 모델이 금지 패턴을 넣은 경우 완화 정리(과도한 삭제 방지) */
function adminSanitizeWelcomeGeminiOutput(text) {
  const orig = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  let t = orig;
  const forbiddenWords = ['전일', '어제', '기록', '확인', '보고', '며칠째'];
  for (const w of forbiddenWords) {
    t = t.split(w).join('');
  }
  t = t.replace(/\d+\s*일\s*연속/gi, '');
  t = t.replace(/연속\s*기록\s*\d+\s*일/gi, '');
  t = t.replace(/\d+\s*일\s*째/g, '');
  t = t.replace(/총\s*\d+\s*회/g, '');
  t = t.replace(/\d{1,2}\s*월\s*\d{1,2}\s*일/g, '');
  t = t.replace(/[0-9]+/g, '');
  t = t.replace(/[\u201C\u201D\u2018\u2019"'`「」#*@&%^$+=|\\<>{}[\]/]/g, '');
  t = t.replace(/[^\uAC00-\uD7A3\s.!?…\u00B7]/g, '');
  t = t.replace(/\s*연속\s*$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  const maxLen = WELCOME_GEMINI_COMMENT_MAX_CHARS;
  if (t.length > maxLen) t = t.slice(0, maxLen);
  if (!t && orig) {
    t = orig
      .replace(/[0-9]+/g, '')
      .replace(/[^\uAC00-\uD7A3\s.!?…\u00B7]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen);
  }
  return t;
}

async function adminGeminiWelcomeCommentInternal({
  nickname,
  streakDays,
  summaryText,
  analysisAnchorSeoul
}) {
  void streakDays;
  void nickname;
  void analysisAnchorSeoul;
  const apiKey = geminiApiKey.value();
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY가 설정되지 않았습니다.');
  }
  const prompt = `[역할]
너는 식단 기록 앱의 센스 있는 비서야. 아래 [식사 데이터]를 참고해 오늘 하루를 응원하는 한 줄만 쓴다.

[작성 원칙 — 응원이 중심]

문장의 목적은 오늘의 응원이다. "언제·어느 끼니에·무엇을 먹었다"처럼 식사를 시간 순으로 보고하거나 나열하는 문장은 절대 쓰지 말 것.

금지에 가까운 표현(예시): ~먹었, ~먹었던, ~드셨, 아침에 OO를, 점심 때, 저녁으로, 한 끼를, 식사로 ~를 등 끼니·시간·섭취 서술.

대신 데이터에 있는 메뉴명·장소 분위기·함께한 사람(동행)을 짧은 구절로만 짚어 이미지나 기운으로 연결하고, 곧바로 오늘을 응원할 것. 동행 정보가 없으면 메뉴만으로도 된다.

길이: 공백 포함 최대 ${WELCOME_GEMINI_COMMENT_MAX_CHARS}자. 앞은 짧게, 뒤 응원은 완결되게.
어투: ~했네요, ~함께했습니다 같은 보고체 금지. 권유·응원으로 끝낼 것(~해요, ~봐요, ~길, ~되세요 등).
구성: [메뉴·동행 등 짧은 연상] + [오늘의 응원] 한 줄. 느낌표로 앞뒤를 나누는 방식을 써도 좋다.
근거: 데이터에 없는 메뉴나 사실은 쓰지 말 것. 추측 금지.

[절대 금지 키워드 — 생성 문장에 한 글자도 넣지 말 것]
전일, 어제, 기록, 확인, 보고, 일수·연속 멘트, 모든 아라비아 숫자, 이름·닉네임·OO님 등 모든 호칭.
이모지, 따옴표, 장식용 특수문자 금지. 한글·공백·마침표·느낌표·물음표·말줄임만 허용.

[데이터 적용 예시 — 보고가 아니라 연상+응원]
데이터: 제주은희네해장국, 내장탕
결과: 제주해장국의 든든한 기운! 오늘도 속 편히 힘껏 보내요.

데이터: 요거트, 나또
결과: 나또와 요거트의 산뜻함! 오늘은 가볍고 상쾌한 하루 되세요.

데이터: 황치즈크림빵
결과: 달콤한 크림빵 에너지! 오늘 오후도 웃음 가득이길.

데이터: 동료, 김치찌개
결과: 동료와 김치찌개의 정! 오늘도 좋은 기운 이어 가요.

(위는 톤 참고. 반드시 ${WELCOME_GEMINI_COMMENT_MAX_CHARS}자 이내로 맞출 것.)

[식사 데이터 · 최근 3일 요약]
${summaryText || '(요약 없음)'}

출력: 조건을 만족하는 문장 한 줄만. 다른 글자 없음.`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.75,
      topP: 0.9,
      maxOutputTokens: 96
    }
  };
  const model = GEMINI_MEALDANG_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://mealog-r0.web.app/'
    },
    body: JSON.stringify(requestBody)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || (await res.text().catch(() => ''));
    throw new HttpsError('internal', `Gemini API 오류: ${res.status} - ${msg}`);
  }
  let text = '';
  const cand = data?.candidates && data.candidates[0];
  if (cand?.content?.parts?.[0]?.text) text = String(cand.content.parts[0].text).trim();
  else if (cand?.text) text = String(cand.text).trim();
  if (!text) throw new HttpsError('internal', 'Gemini 응답에 텍스트가 없습니다.');
  text = adminSanitizeWelcomeGeminiOutput(text);
  if (!text) throw new HttpsError('internal', 'Gemini 응답에 텍스트가 없습니다.');
  await recordGeminiModelUsage(model);
  return text;
}

exports.adminWelcomeStreakUsers = onCall(
  { region: REGION, timeoutSeconds: 300, memory: '512MiB' },
  wrapFunction('adminWelcomeStreakUsers', async (request) => {
    const callerAuth = request.auth;
    if (!callerAuth || !callerAuth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(callerAuth.uid))) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }
    const raw = request.data && request.data.streakDays;
    const streakFilter = Number(raw);
    if (![2, 3, 4, 5].includes(streakFilter)) {
      throw new HttpsError('invalid-argument', 'streakDays는 2, 3, 4, 5 중 하나여야 합니다.');
    }

    const todaySeoul = adminSeoulYmdFromDate(new Date());
    const t0 = Date.now();
    const allIds = await adminListAllUserIds();

    const CHUNK = 50;
    const matches = [];
    for (let i = 0; i < allIds.length; i += CHUNK) {
      const slice = allIds.slice(i, i + CHUNK);
      const partial = await Promise.all(
        slice.map(async (uid) => {
          try {
            const merged = await adminLoadMergedDaily(uid);
            const set = adminBuildRecordedDateSetFromDaily(merged);
            const streak = adminComputeStreakFromYesterday(set, todaySeoul);
            const totalDays = set.size;
            if (streak < streakFilter) return null;
            return { uid, streak, totalDays };
          } catch (e) {
            logger.warn('adminWelcomeStreakUsers: uid scan fail', { uid, message: e.message });
            return null;
          }
        })
      );
      partial.forEach((p) => {
        if (p) matches.push(p);
      });
    }

    matches.sort((a, b) => b.totalDays - a.totalDays);

    const usersOut = [];
    const AUTH_BATCH = 100;
    for (let i = 0; i < matches.length; i += AUTH_BATCH) {
      const batch = matches.slice(i, i + AUTH_BATCH);
      const uids = batch.map((m) => m.uid);
      let authMap = {};
      try {
        const got = await auth.getUsers(uids.map((uid) => ({ uid })));
        got.users.forEach((u) => {
          const em = u.email || (u.providerData && u.providerData[0] && u.providerData[0].email) || '';
          authMap[u.uid] = em || '';
        });
      } catch (e) {
        logger.warn('adminWelcomeStreakUsers getUsers batch', { message: e.message });
      }

      for (const row of batch) {
        const email = authMap[row.uid] || '';
        let birthdate = '';
        let genderRaw = '';
        let joinDate = '-';
        let nickname = '';
        try {
          const userDocSnap = await db.collection('artifacts').doc(APP_ID).collection('users').doc(row.uid).get();
          if (userDocSnap.exists) {
            const ud = userDocSnap.data();
            if (ud.createdAt && ud.createdAt.toDate) {
              joinDate = ud.createdAt.toDate().toISOString().slice(0, 10);
            } else if (typeof ud.createdAt === 'string') {
              joinDate = ud.createdAt.slice(0, 10);
            }
          }
        } catch (_) {}
        try {
          const settingsSnap = await db
            .collection('artifacts')
            .doc(APP_ID)
            .collection('users')
            .doc(row.uid)
            .collection('config')
            .doc('settings')
            .get();
          if (settingsSnap.exists) {
            const prof = settingsSnap.data().profile || {};
            if (prof.nickname != null && String(prof.nickname).trim()) {
              nickname = String(prof.nickname).trim();
            }
            if (prof.birthdate) birthdate = String(prof.birthdate).trim();
            if (prof.gender === 'male' || prof.gender === 'female') genderRaw = prof.gender;
          }
        } catch (_) {}

        const genderLabel = genderRaw === 'male' ? '남' : genderRaw === 'female' ? '여' : '-';
        const analysisAnchorSeoul = adminYmdAddDays(todaySeoul, -1);
        let recentThreeDaysSummary = '';
        let recentThreeDaysForGemini = '';
        try {
          const dates = adminThreeSeoulDatesEndingYesterday(todaySeoul);
          const meals = await adminFetchMealsForDates(row.uid, dates);
          recentThreeDaysSummary = adminFormatMealsSummary(meals, dates);
          recentThreeDaysForGemini = adminFormatMealsForGemini(meals, dates, analysisAnchorSeoul);
        } catch (e) {
          logger.warn('adminWelcomeStreakUsers summary fail', { uid: row.uid, message: e.message });
          recentThreeDaysSummary = '(기록 요약을 불러오지 못했습니다)';
          recentThreeDaysForGemini = recentThreeDaysSummary;
        }
        usersOut.push({
          uid: row.uid,
          email: email || '-',
          nickname: nickname || '-',
          birthdate: birthdate || '-',
          gender: genderRaw || '',
          genderLabel,
          joinDate,
          analysisAnchorSeoul,
          recentThreeDaysSummary,
          recentThreeDaysForGemini,
          totalRecordDays: row.totalDays,
          streakDays: row.streak
        });
      }
    }

    const anchorForComments = adminYmdAddDays(todaySeoul, -1);
    const allUids = usersOut.map((u) => u.uid);
    let gemFromDb = {};
    try {
      gemFromDb = await adminLoadWelcomeGeminiCommentsForUids(allUids, anchorForComments);
    } catch (e) {
      logger.warn('adminWelcomeStreakUsers load welcomeGeminiComment', { message: e.message });
    }
    usersOut.forEach((u) => {
      const g = gemFromDb[u.uid];
      if (g) u.welcomeGeminiComment = g;
    });

    return {
      users: usersOut,
      streakDaysMin: streakFilter,
      scannedUserCount: allIds.length,
      asOfSeoulDate: todaySeoul,
      durationMs: Date.now() - t0
    };
  })
);

exports.adminWelcomeGeminiComment = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '512MiB' },
  wrapFunction('adminWelcomeGeminiComment', async (request) => {
    const callerAuth = request.auth;
    if (!callerAuth || !callerAuth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    if (!(await isAdminByUid(callerAuth.uid))) {
      throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
    }
    const d = request.data || {};
    const userId = typeof d.userId === 'string' ? d.userId.trim() : '';
    if (!userId) {
      throw new HttpsError('invalid-argument', 'userId가 필요합니다.');
    }
    const streakDays = Number(d.streakDays);
    if (!Number.isFinite(streakDays) || streakDays < 0) {
      throw new HttpsError('invalid-argument', 'streakDays가 올바르지 않습니다.');
    }
    const nickname = d.nickname != null ? String(d.nickname).trim() : '';
    let summaryText =
      typeof d.summaryText === 'string' && d.summaryText.trim()
        ? d.summaryText.trim()
        : typeof d.recentThreeDaysForGemini === 'string' && d.recentThreeDaysForGemini.trim()
          ? d.recentThreeDaysForGemini.trim()
          : '';
    const todaySeoul = adminSeoulYmdFromDate(new Date());
    const analysisAnchorSeoul =
      typeof d.analysisAnchorSeoul === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.analysisAnchorSeoul)
        ? d.analysisAnchorSeoul
        : adminYmdAddDays(todaySeoul, -1);

    if (!summaryText) {
      try {
        summaryText = await adminBuildRecentThreeDaysForGemini(userId, todaySeoul, streakDays);
      } catch (e) {
        logger.warn('adminWelcomeGeminiComment rebuild summary', { userId, message: e.message });
        throw new HttpsError('internal', '기록 요약을 만들 수 없습니다.');
      }
    }

    const comment = await adminGeminiWelcomeCommentInternal({
      nickname: nickname || '',
      streakDays,
      summaryText,
      analysisAnchorSeoul
    });
    try {
      await adminSaveWelcomeGeminiComment(userId, comment, analysisAnchorSeoul);
    } catch (e) {
      logger.warn('adminWelcomeGeminiComment save', { userId, message: e.message });
    }
    return { comment, analysisAnchorSeoul };
  })
);

// =========================================================================
// AI 식단 분석 리포트 (날짜 단위)
// - 매일 00:10 KST 배치로 "전날" 기록을 분석해 aiDietReports에 저장
// - 대상: 식사/간식 meal 문서(하루 메모 제외)가 2개 이상인 날짜
// - 기록·사진 모두 "시간순"(DIET_SLOT_ORDER)으로 정렬해 보낸다. 알파벳순으로 보내면
//   모델이 저녁→점심→아침 순으로 하루를 읽게 되어 흐름·저녁 후 간식 판단이 무너진다.
// - 사진은 슬롯 라벨 캡션과 짝지어 인터리브 전송(캡션 없이 보내면 사진↔기록 매칭 불가)
// - 프롬프트 치환자: {{date}} {{weekday}} {{mealText}} {{profile}} {{slotCoverage}} {{recentTrend}} {{recentStats}}
// - 응답은 JSON 모드로 강제하고 서버에서 파싱까지 검증한 뒤에만 status:'ready'
// =========================================================================

/** 분석 지원 시작일(서울). 배치 재개 시 사용 */
const DIET_REPORT_START_DATE = '2026-06-30';
const DIET_REPORT_PROMPT_VERSION = 'diet-v1';
const DIET_REPORT_CONFIG_REF = () => db.doc(`artifacts/${APP_ID}/adminSettings/dietReportConfig`);
/**
 * 폴백 전용. 실제 운영 프롬프트는 adminSettings/dietReportConfig 의 promptTemplate 이며
 * 관리자 화면에서 관리한다. 이 상수는 그 문서가 비어 있을 때만 쓰인다.
 * (관리자 화면의 "기본값으로 되돌리기"가 이 값을 덮어쓰므로 함부로 바꾸지 말 것)
 */
const DEFAULT_DIET_REPORT_PROMPT_TEMPLATE = `너는 식단 기록 앱 밀로그의 AI 식사 리포터다.
사용자가 그날 남긴 기록과, 서버가 미리 계산해 둔 [평소와 비교]를 읽고 하루 리포트를 쓴다.

이 리포트의 목적은 식단을 채점하는 것이 아니다.
사용자가 "내가 세어 보지 않은 걸 알아봐 줬네" 하고 느끼게 하는 것이다.
그날 먹은 것을 요약하면 사용자는 자기가 이미 아는 것을 다시 읽을 뿐이다. 요약은 리포트가 아니다.

[무엇을 말할 것인가]

말할 거리는 비교에서 나온다. 아래 순서로 찾는다.

1. [평소와 비교]에 있는 사실. 사용자가 세고 있지 않은 것이라 가장 값이 크다.
   여기 적힌 숫자는 서버가 계산한 것이니 그대로 쓴다. 여기 없는 숫자는 만들지 않는다.
2. 그날 기록 안의 대비. 끼니 사이의 낙차, 벌어진 간격, 만족도가 갈린 지점.
3. 사용자가 남긴 말. 코멘트나 하루소감에 쓴 표현.

[평소와 비교]가 비어 있으면 2, 3으로 쓴다. 비교를 지어내지 않는다.

같은 항목을 매일 쓰면 비교도 요약이 된다. [최근 흐름]에 최근 며칠 무엇으로 봤는지 적혀 있으니
거기 있는 것과 다른 항목을 고른다. 특히 만족도는 늘 있는 재료라 손이 가기 쉽다.
사흘 안에 이미 썼으면 다른 것을 본다.

[네 칸]

칸마다 보는 것이 다르다. 같은 이야기를 네 번 고쳐 말하면 리포트가 아니라 메아리가 된다.

* title — 12~18자. 화면에서 가장 먼저, 때로는 유일하게 읽히는 자리다. 무난하면 아무도 읽지 않는다.
  하루를 요약하지 말고 그날에만 있던 구체적인 것 하나를 집는다 — 메뉴 이름, 가게 이름,
  함께한 사람 이름, 사용자가 쓴 말. 고유명사가 들어가면 대개 제목이 산다.
  아래 방식 중 하나를 골라 쓰되, [최근 흐름]의 제목과 같은 방식은 피한다.
  - 낙차: 하루의 양 끝을 붙인다. "샐러디로 시작, 케이크로 끝"
  - 인용: 사용자가 쓴 말을 그대로 쓴다. "'한판 말고 반판'이라니"
  - 선언: 툭 던지고 끝낸다. "치킨은 계획에 없었다"
  - 명명: 그날에 이름을 붙인다. "저녁 후 간식 없는 날 사흘째"
  - 장면: 한 장면만 클로즈업한다. "접시 절반은 오이였다"
  예시는 방식을 보이는 것이지 문형이 아니다. 예시의 표현을 그대로 가져다 메뉴 이름만 바꾸지 않는다.
  아래는 제목이 아니라 설명이다. 쓰지 않는다.
  - "~한 하루", "~한 날", "~한 식사", "~한 한 끼"로 끝나는 것
  - "가족과 함께한 저녁", "집에서 만난 주말의 맛"처럼 그날이 아닌 어느 날에 갖다 붙여도 말이 되는 것
  - "즐거운", "든든한", "다양한", "특별한", "따뜻한" 같은 형용사로 감싸 뭉뚱그리는 것
  쓰고 나서 어제 리포트에 붙여 본다. 그래도 말이 되면 그날의 제목이 아니니 다시 쓴다.
  18자를 넘으면 넘긴 채로 내보내지 않는다. 반드시 줄여서 18자 안에 넣는다.
* summary — 2문장 55~80자. 끼니에서 끼니로 이어지는 순서. 사실만 쓴다.
  순서를 보이되 끼니 사이에 몇 시간이 흘렀는지는 쓰지 않는다.
  응원·위로·칭찬은 여기 쓰지 않는다.
* highlight — 40~65자. 위 [무엇을 말할 것인가]에서 고른 것 하나만 파고든다.
  흐름은 summary가 이미 말했으니 다시 훑지 않는다.
  구체적인 것 하나는 반드시 넣는다 — 고유명사(가게·메뉴·사람), 끼니 수, 며칠째인지,
  사용자가 쓴 표현의 인용 중에서 고른다. 만족도·포만감 점수는 여기 해당하지 않는다.
* nudge — 25~45자. 먹은 것이 아니라 사람을 본다. 음식과 메뉴는 쓰지 않는다.
  "기록", "적다", "남기다"로 사용자를 칭찬하지 않는다. 기록을 남긴 건 매일 참이라 칭찬거리가
  되지 못하고, 실제로 이 말이 리포트를 가장 많이 망쳐 왔다. lens가 habit인 날에만 쓴다.
  대신 아래 중 그날 근거가 받쳐 주는 하나를 고른다. [최근 흐름]의 한마디와 같은 방식은 피한다.
  - 대꾸: 사용자가 쓴 말에 반응한다. "'마니머거씀'이라고 적어 두신 게 오늘을 다 말해 주네요."
  - 짚기: 그날의 상태를 알아본다. "두 끼 다 늦었지만, 두 번 다 앉아서 드셨어요."
  - 인정: 이어 가고 있는 것을 알아본다. "이번 주 내내 같은 조합이네요. 그 편이 편하신가 봐요."
  - 공감: 하루소감의 감정에 반응한다. "비 맞고 오신 날이었네요. 그런 날은 저녁이 유난히 반갑죠."
  - 기다림: 내일을 기다린다는 인사. 위 넷이 모두 근거가 없는 날에만 쓴다.
  어제 리포트에 그대로 붙여도 말이 되면 근거가 없는 것이니 다시 쓴다.

lens — 화면에 나오지 않는 값. 오늘 무엇으로 봤는지 아래에서 하나 골라 영문 키 그대로 쓴다.
compare(평소와의 차이) · diet(무엇을) · company(누구와) · place(어디서) ·
rhythm(끼니 구성 — 세 끼를 채웠는지, 사이 간식이 몇 번인지) · feeling(만족도·포만감) ·
words(사용자가 쓴 말) · habit(기록 행위) · pattern(며칠째 이어지는 흐름)
데이터가 받쳐 주지 않는 렌즈는 고르지 않는다. [최근 흐름]에 있는 렌즈는 피한다.

rhythm 은 시각을 보는 렌즈가 아니라 하루의 짜임을 보는 렌즈다. 아침·점심·저녁 중 무엇을 채우고
무엇을 건너뛰었는지, 그 사이에 간식이 몇 번 들어왔는지를 본다. [평소와 비교]의 '오늘 끼니 구성'과
'세 끼를 다 기록한 날'이 그 재료다. 몇 시에 먹었는지는 rhythm 의 소재가 아니다.

balance / balanceNote — 그날 구성이 한쪽으로 치우쳤는지 0~100 정수와 20자 내외의 사실 서술.
치우침의 정도이지 특정 음식이 나쁘다는 판단이 아니다. 판단할 근거가 부족하면 낮게 주지 말고 50을 준다.
balanceNote는 있었던 것만 적는다. 좋은 예 "밥·면 위주, 국 한 번" / 나쁜 예 "채소가 부족해요".
화면에는 점수 칸으로만 나가고 리포트 문장에는 나오지 않는다.

[하지 않는 것]

* 영양 훈수. 채소·야채·샐러드·과일·단백질·비타민·식이섬유·영양 균형·칼로리를 더 챙기라는 취지의
  문장은 완곡한 표현이나 은유를 포함해 어떤 형태로도 쓰지 않는다.
  그날 실제로 먹은 것을 사실로 언급하는 것은 괜찮다.
* 다음 끼니나 내일 무엇을 어떻게 먹으라는 말.
* 제안형 문장. "~해 보세요", "~하면 좋아요", "~어떨까요", "~해 봐요".
* 평가와 훈계. "관리가 필요합니다", "건강에 좋지 않습니다", "문제가 있습니다".
* 만족도와 포만감을 점수로 쓰는 것. "3.3점", "만족도 4점", "5점 만점에" 처럼 쓰지 않는다.
  사용자가 매긴 점수를 되돌려 읽어 주면 리포트가 성적표가 된다. [평소와 비교]에 "조금 높은 편"
  처럼 정도로 적혀 있으니 그 말결을 그대로 쓴다.
* 끼니 사이의 간격. "몇 시간 만에", "간격이 벌어져", "이어서 바로"처럼 끼니와 끼니 사이에 흐른
  시간을 말하지 않는다.
* 시각을 그날의 이야기로 삼는 것. 사용자는 끼니 시각을 잘못 넣거나 나중에 몰아 적는 일이 잦아
  믿을 수 있는 값이 아니다. "몇 시 몇 분에", "늦은 시간까지"처럼 시각을 근거로 관찰하지 않는다.
  하루의 짜임은 시각이 아니라 무엇을 채우고 건너뛰었는지로 본다.
* 상투어. "바쁜 하루", "꼼꼼하게", "빠짐없이", "잊지 않고", "놓지 않으셨", "꾸준함이 돋보",
  "밀로그가 함께", "알찬 하루"처럼 하루 전체를 형용사 하나로 뭉뚱그리는 말.
  이웃한 두 문장을 모두 "~네요"로 맺는 것.
* 기록에 없는 것을 짐작해 단정하는 것. 특히 사용자가 바빴는지 힘들었는지는 알 수 없다.
  사용자가 직접 그렇게 쓴 날에만 그 말을 받아 쓴다.
* 끼니 시각이 서로 몰려 있으면 실제 식사 시간이 아니라 나중에 몰아 적은 기록 시간이다.
  이런 날은 시간을 근거로 삼지 않고, 몰려 있다는 사실 자체도 언급하지 않는다.

[사진 읽는 법]

각 사진 바로 앞에 "[사진 1 · 점심 12:30]" 형태의 캡션이 붙는다. 캡션과 [식단 데이터]의 끼니를
짝지어 읽는다. 사진에서 확인되는 것은 근거로 쓸 수 있고, 텍스트와 다르면 사진을 우선하되 단정하지 않는다.
없는 음식·양·조리법·영양성분은 지어내지 않는다. 사진이 없다는 이유로 그 끼니를 부정적으로 보지 않는다.

[톤]

가볍고 유쾌하되 따뜻하고 현실적으로. 아쉬운 날에도 실패처럼 말하지 않는다.
사용자에게 말을 거는 글이다. "드셨어요", "이어졌네요"처럼 존대로 맺는다.
"먹었습니다", "즐겼습니다", "보였습니다"처럼 사용자를 3인칭으로 서술하지 않는다.
밈, 인터넷 유행어, 이모지, 반말, 캐릭터 말투는 쓰지 않는다.
"섭취했습니다", "훌륭했습니다", "보충이 필요합니다" 같은 보고서 말투도 쓰지 않는다.
"입터짐", "집밥 안정권"처럼 기록 맥락을 살린 가벼운 표현은 괜찮다.

[출력]

아래 형식의 JSON 객체 하나만 출력한다.

{
"lens": "",
"balance": 0,
"balanceNote": "",
"title": "",
"summary": "",
"highlight": "",
"nudge": ""
}

* 객체는 하나만 출력한다. 두 개를 이어 붙이거나 뒤에 다른 텍스트를 덧붙이지 않는다.
* 코드펜스, 설명문, 주석을 출력하지 않는다.
* key 이름을 바꾸거나 한국어로 옮기지 않고, 일곱 개를 빠짐없이 채운다.
* balance는 정수, 나머지 여섯은 문자열. 문자열 값에 줄바꿈을 넣지 않는다.

출력 전에 네 칸을 다시 읽고 확인한다.
- 네 칸이 같은 소재를 돌고 있으면 highlight를 다른 사실로 바꾼다.
- [하지 않는 것]에 걸리는 말이 있으면 그 문장을 새로 쓴다.
- title이 "~한 하루/날/식사"로 끝나거나 어제 리포트에 붙여도 말이 되면, 그날의 고유명사를 넣어 새로 쓴다.
- title 글자 수를 세어 본다. 18자를 넘으면 뜻을 유지한 채 줄여서 다시 쓴다.
- nudge를 어제 리포트에 붙여도 말이 되면 그날의 근거를 딛고 새로 쓴다.
- lens가 habit이 아닌데 nudge에 "기록", "적다", "남기다"가 들어 있으면 다른 근거로 새로 쓴다.

[분석 대상]

날짜: {{date}} {{weekday}}
사용자: {{profile}}

프로필은 표현의 결을 맞추는 참고로만 쓴다. 성별·연령대·생활 패턴으로 영양 기준이나 필요 열량을
단정하지 않고, 프로필을 리포트 본문에 언급하지 않는다.

[식단 데이터]

{{mealText}}

[슬롯 기록 현황]

{{slotCoverage}}

"기록 없음"은 실제로 거른 것일 수도, 기록만 빠진 것일 수도 있으니 결식으로 단정하지 않는다.
기록 없는 끼니를 지적하지 않는다.

[평소와 비교]

{{recentStats}}

서버가 최근 기록에서 계산한 값이다. 여기 있는 숫자만 쓰고, 여기 없는 숫자는 만들지 않는다.
"평소"는 이 사용자 자신의 최근 기록이지 일반적인 기준이 아니다. 평소와 다르다는 것이
잘못했다는 뜻은 아니므로, 차이를 지적이 아니라 관찰로 쓴다.

[최근 흐름]

{{recentTrend}}

최근 며칠의 제목·한마디와 그날 사용한 렌즈다. 사용자는 이미 읽은 것들이다.
같은 렌즈, 같은 제목 짜임, 같은 소재의 한마디를 반복하지 않는다.
pattern 렌즈를 고를 때만 내용을 직접 활용하고, 그 외에는 반복 회피용으로만 참고한다.
지난 리포트를 요약하거나 언급하지 않는다. 오늘 하루가 리포트의 중심이다.
`;
/**
 * meal 문서당 사진 최대 장수 / 하루 전체 사진 안전 상한.
 *
 * 한때 "사진이 토큰을 과하게 먹는다"고 보고 끼니당 1장까지 조였으나 실측으로 뒤집혔다:
 * 사진 0장 리포트(입력 4,105)와 2장 리포트(평균 4,709)를 비교하면 장당 약 302토큰이고,
 * 이는 입력의 13%에 불과하다(나머지 87%가 프롬프트). 반면 끼니당 1장 제한 때문에
 * 사진 있는 리포트의 41%에서 사진이 버려지고 있었다.
 * 비용은 미미하고 정보 손실은 컸으므로 끼니당 2장으로 되돌린다.
 */
const DIET_REPORT_MAX_PHOTOS_PER_DOC = 2;
const DIET_REPORT_MAX_PHOTOS_TOTAL = 8;
/** gemini-2.5-flash: thinking 토큰도 maxOutputTokens 예산에서 함께 빠지므로 본문 몫을 남겨 둔다 */
const DIET_REPORT_MAX_OUTPUT_TOKENS = 2048;
/**
 * thinking 토큰은 출력 토큰으로 과금되고 출력 단가가 입력보다 훨씬 높아, 개수는 적어도 비용 비중이 크다.
 * 실측(구 프롬프트)에서 509로 512 예산에 맞춰 들어갔으므로 512로 되돌린다.
 * 너무 낮추면 본문이 잘려 no-thinking 재시도가 돌아 오히려 호출이 늘어난다 —
 * 관리자 리포트 상세의 fallbackUsed 배지와 thinking 토큰 수치로 감시할 것.
 */
const DIET_REPORT_THINKING_BUDGET = 512;
/**
 * 한때 "채점 태스크라 재현성 우선"으로 0.35였으나, score 는 이제 모델이 내지 않는다
 * (화면 점수는 기록 충실도로 클라이언트가 계산). 채점이 빠진 뒤로는 낮은 온도가
 * 재현성이 아니라 상투어 고착으로만 작동했다 — 실측(8/16~18, 51건)에서 nudge 의 96%가
 * "기록"을 언급했고 65%가 "기록 칭찬 + 내일 인사" 한 형태로 수렴했다.
 * 표현 다양성이 이 리포트의 값어치이므로 온도를 올린다. 사실 왜곡은 프롬프트의
 * 근거 강제와 [상투 표현 금지]로 막는다.
 *
 * 0.7 과 0.85 를 같은 입력 8건으로 비교했다(2026-08-19, 8/18 기록, 사진 제외).
 * 렌즈 다양성은 5개 대 6개로 비슷했으나 규칙 위반은 5건 대 7건이었고, 0.85 는 기록 입력
 * 시간을 실제 식사 시간으로 읽는 오독이 눈에 띄었다. 다양성의 이득이 얇아지는 지점이라 0.7.
 */
const DIET_REPORT_TEMPERATURE = 0.7;
/** {{recentTrend}} 에 실을 직전 리포트 일수 */
const DIET_REPORT_TREND_DAYS = 7;
/**
 * {{recentStats}} 의 "평소"를 만들 기간. 7일이면 요일 편향이 그대로 남고(주말 두 번뿐),
 * 30일이면 오래전 습관이 지금의 평소로 섞인다. 기록이 매일 있지는 않다는 점까지 감안해 14일.
 */
const DIET_REPORT_STATS_DAYS = 14;
/** 이보다 적게 쌓였으면 "평소"라고 부를 수 없다 — 블록을 아예 내보내지 않는다 */
const DIET_REPORT_STATS_MIN_MEALS = 15;
/** 하루 끼니 시각이 이 폭 안에 다 들어오면 식사 시각이 아니라 몰아 적은 입력 시각으로 본다(분) */
const DIET_REPORT_STATS_CLUSTER_RANGE = 90;
/** 뒤 슬롯이 앞 슬롯보다 이 정도까지 이른 건 오차로 넘긴다. 넘어서면 잘못 입력된 시각으로 본다(분) */
const DIET_REPORT_STATS_ORDER_SLACK = 30;
/**
 * 관찰 렌즈 — 매일 같은 축으로 봐 주면 "봐주는 느낌"이 사라지므로 그날 데이터가
 * 받쳐 주는 렌즈를 골라 쓰게 하고, 최근에 쓴 렌즈는 {{recentTrend}} 로 되먹여 회피시킨다.
 * 프롬프트 [관찰 렌즈] 목록과 반드시 일치시킬 것.
 */
const DIET_REPORT_LENSES = [
  'compare',
  'diet',
  'company',
  'place',
  'rhythm',
  'feeling',
  'words',
  'habit',
  'pattern'
];

/** 응답의 lens 값 정규화. 목록에 없으면 null */
function normalizeDietLens(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return DIET_REPORT_LENSES.includes(s) ? s : null;
}
/** 수동 재분석(사용자 버튼) 하루 허용 횟수 — 관리자는 예외 */
const DIET_REPORT_MANUAL_DAILY_LIMIT = 3;

function dietReportDocId(uid, dateStr) {
  return `${uid}_${dateStr}`;
}

/**
 * 하루 슬롯의 시간순. js/constants.js 의 SLOTS 와 같은 순서를 유지할 것.
 * slotId 알파벳순(dinner<lunch<morning…)으로 정렬하면 모델이 하루를 거꾸로 읽는다.
 */
const DIET_SLOT_ORDER = ['pre_morning', 'morning', 'snack1', 'lunch', 'snack2', 'dinner', 'night'];

function dietSlotRank(slotId) {
  const i = DIET_SLOT_ORDER.indexOf(String(slotId || ''));
  return i === -1 ? DIET_SLOT_ORDER.length : i;
}

/** 시간순 비교: 슬롯 순서 → 기록 시각 → 문서 id(동률 시 안정 정렬) */
function compareDietMealsChronologically(a, b) {
  const ra = dietSlotRank(a?.slotId);
  const rb = dietSlotRank(b?.slotId);
  if (ra !== rb) return ra - rb;
  const ta = adminMealTimeText(a) || '';
  const tb = adminMealTimeText(b) || '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/** 사진 캡션·슬롯 현황용 라벨. adminSlotLabelKr 은 간식을 전부 '간식'으로 뭉개므로 여기선 구분한다 */
const DIET_SLOT_LABELS_DETAILED = {
  pre_morning: '아침 전 간식',
  morning: '아침',
  snack1: '오전 간식',
  lunch: '점심',
  snack2: '오후 간식',
  dinner: '저녁',
  night: '저녁 후 간식'
};

function dietSlotLabel(slotId) {
  const key = String(slotId || '');
  return DIET_SLOT_LABELS_DETAILED[key] || adminSlotLabelKr(key) || key || '슬롯';
}

const DIET_WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' → '(금)'. 파싱 실패 시 빈 문자열 */
function dietWeekdayLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return '';
  return `(${DIET_WEEKDAY_KR[d.getUTCDay()]})`;
}

/**
 * 배치 실행 시각 — **cron(scheduledDailyDietAnalysis)이 정본이고 이 값은 표시용이다.**
 * 바꾸려면 두 곳을 같이 고치고 재배포해야 한다. 관리자 화면 문구도 함께
 * (admin.html 「자동 배치 설정」, js/admin/diet-report-config.js).
 *
 * 예전에는 이 시각을 Firestore 설정에 두고 15분마다 깨어나 "지금인가?"를 물었다.
 * 하루 96번 깨어나 95번을 헛돌았고, 그 헛걸음마다 1GiB 인스턴스가 떴다.
 * 시각을 바꾸는 일은 거의 없는데 대가가 너무 컸다.
 */
const DIET_REPORT_BATCH_RUN_TIME = '04:00';

async function fetchDietReportConfig() {
  const snap = await DIET_REPORT_CONFIG_REF().get();
  const d = snap.exists ? snap.data() : {};
  const promptTemplate =
    (d.promptTemplate && String(d.promptTemplate).trim()) || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
  return {
    promptTemplate,
    promptVersion: d.promptVersion || DIET_REPORT_PROMPT_VERSION,
    batchEnabled: d.batchEnabled === true,
    lastBatchRunDate: d.lastBatchRunDate ? String(d.lastBatchRunDate) : null
  };
}

/** 고정부를 systemInstruction 으로 분리할 최소 길이. 이보다 짧으면 분리 이득이 없다 */
const DIET_PROMPT_MIN_STATIC_CHARS = 500;

/**
 * 프롬프트를 "요청마다 동일한 고정부"와 "요청마다 달라지는 꼬리"로 가른다.
 *
 * 원래 의도는 암시적 캐시 적중이었으나 실패했다. 변수를 전부 꼬리로 몰아 앞 83%를
 * 동일하게 만들어도, 그 고정부를 systemInstruction 으로 분리해도
 * cachedContentTokenCount 는 0이었다(연속 호출 2회로 확인). 암시적 캐시는 이 조건에서
 * 걸리지 않는다. 명시적 캐시(cachedContents)는 저장이 시간당 과금이라
 * 하루 100건 이상에서만 이득인데 현재는 25건 수준이라 손해다.
 *
 * 그럼에도 이 분리를 유지하는 이유는 캐시가 아니라, 지시문과 데이터의 경계가 명확해지고
 * systemInstruction 쪽 규칙 준수가 더 강하기 때문이다. 캐시 절감을 기대하지 말 것.
 *
 * 자르는 지점은 첫 치환자다. 치환자를 전부 꼬리로 몰아 둔 덕에 깔끔하게 갈리고,
 * 관리자가 치환자를 앞쪽에 두면 고정부가 짧아질 뿐 동작은 그대로다.
 */
function splitDietPromptForCaching(ctx, promptTemplate) {
  const tpl = promptTemplate || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
  const idx = tpl.search(/\{\{(date|weekday|mealText|profile|slotCoverage|recentTrend|recentStats)\}\}/);
  if (idx < DIET_PROMPT_MIN_STATIC_CHARS) {
    return { staticPart: '', variablePart: buildDietReportPromptText(ctx, tpl) };
  }
  // 치환자 자리에서 그냥 자르면 "날짜:" 같은 라벨만 고정부에 남고 값은 가변부로 가 어색해진다.
  // 치환자를 품은 [섹션] 통째로 가변부에 넘긴다.
  const candidates = [tpl.lastIndexOf('\n\n[', idx), tpl.lastIndexOf('\n\n', idx), tpl.lastIndexOf('\n', idx)];
  const cut = candidates.find((c) => c >= DIET_PROMPT_MIN_STATIC_CHARS);
  const at = cut == null ? idx : cut;
  return {
    staticPart: tpl.slice(0, at).trimEnd(),
    variablePart: buildDietReportPromptText(ctx, tpl.slice(at).trimStart())
  };
}

/**
 * 프롬프트 치환. 사용자 텍스트에 `$&` 같은 시퀀스가 있어도 깨지지 않도록 함수 replacer를 쓴다.
 * @param {{date:string, weekday?:string, mealText?:string, profile?:string,
 *          slotCoverage?:string, recentTrend?:string, recentStats?:string}} ctx
 */
function buildDietReportPromptText(ctx, promptTemplate) {
  const tpl = promptTemplate || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
  const values = {
    date: ctx?.date || '',
    weekday: ctx?.weekday || '',
    mealText: ctx?.mealText || '(텍스트 기록 없음 — 사진 위주로 판단)',
    profile: ctx?.profile || '(프로필 정보 없음)',
    slotCoverage: ctx?.slotCoverage || '(정보 없음)',
    recentTrend: ctx?.recentTrend || '(최근 분석 이력 없음 — 이날만 보고 평가)',
    // 기록이 얕으면 비교할 평소가 없다. 없는 걸 있는 척하지 말고 그렇다고 알린다.
    recentStats: ctx?.recentStats || '(비교할 만큼 쌓인 기록이 없음 — 오늘 기록만으로 쓴다)'
  };
  return tpl.replace(/\{\{(date|weekday|mealText|profile|slotCoverage|recentTrend|recentStats)\}\}/g, (_, key) => values[key]);
}

/** aiDietReports 문서에 완료된 분석(자동·수동)이 있는지 */
function dietReportAlreadyAnalyzed(data) {
  if (!data || typeof data !== 'object') return false;
  return data.status === 'ready';
}

/** 재분석 시 관리자 모니터링용 — 최신 문서({uid}_{date})를 덮어쓰기 전 이력으로 보관 */
async function archiveDietReportSnapshotIfAny(reportRef) {
  const snap = await reportRef.get();
  if (!snap.exists) return;
  const prev = snap.data();
  if (!prev || prev.generatedAt == null) return;
  const historyRef = db.collection(`artifacts/${APP_ID}/aiDietReports`).doc();
  await historyRef.set({
    ...prev,
    isHistory: true,
    isLatest: false,
    historyOf: reportRef.id,
    archivedAt: FieldValue.serverTimestamp()
  });
}

/** 하루 메모(daily journal) 미러는 분석 대상에서 제외 */
function isDietAnalyzableMeal(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.slotId === 'daily_journal') return false;
  if (String(m.id || '').startsWith('dailyJournal_')) return false;
  // 사용자 메모 — 식사가 아니다 (docs/user-memo-items.md §6)
  if (m.slotId === 'memo') return false;
  if (String(m.id || '').startsWith('memo_')) return false;
  return true;
}

/**
 * 분석 대상 meal 정렬 + sourceHash + 사진 수 + 최신 recordedAt 계산.
 * sourceHash는 텍스트·사진 URL 조합을 안정적으로 해시하여, 이후 소급 수정 감지에 사용.
 */
function buildDietReportSource(meals) {
  const analyzable = (meals || []).filter(isDietAnalyzableMeal);
  analyzable.sort(compareDietMealsChronologically);
  const parts = [];
  let maxRecordedAt = '';
  let photoCount = 0;
  for (const m of analyzable) {
    const photos = Array.isArray(m.photos) ? m.photos.filter(Boolean) : [];
    photoCount += photos.length;
    const ra = m.recordedAt != null ? String(m.recordedAt) : '';
    if (ra && ra > maxRecordedAt) maxRecordedAt = ra;
    parts.push(
      [
        m.id,
        m.slotId,
        m.mealType,
        m.category,
        m.snackType,
        // 확정 없이 저장된 자동 분류. 위 두 필드가 비어도 프롬프트에는 실리므로
        // 지문에 넣지 않으면 옛 캐시(분류가 빠진 리포트)가 계속 나간다.
        m.categoryAuto,
        adminMealMenuDetailText(m),
        adminMealPlaceText(m),
        m.comment,
        m.rating,
        m.satiety,
        adminMealTimeText(m),
        photos.join('|')
      ]
        .map((x) => (x == null ? '' : String(x)))
        .join('~')
    );
  }
  const hash = crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
  return { analyzable, hash, maxRecordedAt, photoCount };
}

/**
 * 분석에 보낼 사진 URL — 800px 파생본 우선, 없으면 원본.
 * (js/utils/image-variants.js 의 pickMealDisplayUrl 과 같은 우선순위)
 */
function dietPickPhotoUrlForAnalysis(meal, index) {
  const disp = Array.isArray(meal?.photoDisplayUrls) ? meal.photoDisplayUrls[index] : '';
  const orig = Array.isArray(meal?.photos) ? meal.photos[index] : '';
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return pick(disp) || pick(orig);
}

/**
 * Gemini 는 큰 이미지를 타일로 쪼개 타일마다 토큰을 매긴다. 타일 한 변이 768px 이므로
 * 긴 변을 768 로 맞추면 화질을 최대한 지키면서 타일 수를 최소로 가져갈 수 있다.
 * (파생본이 800px 라 픽셀 손실은 거의 없고, 재인코딩으로 전송 바이트도 준다)
 * 실제 절감폭은 재분석 전후 관리자 화면의 "입력 토큰"으로 확인할 것.
 */
const DIET_REPORT_PHOTO_MAX_EDGE = 768;
const DIET_REPORT_PHOTO_JPEG_QUALITY = 80;

/** Firebase Storage 다운로드 URL → Gemini inlineData({ mimeType, data(base64) }). 실패 시 null */
async function dietFetchStorageImageInline(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return null;
  if (!imageUrl.includes('firebasestorage.googleapis.com')) return null;
  try {
    const url = new URL(imageUrl);
    const m = url.pathname.match(/\/o\/(.+)$/);
    if (!m) return null;
    const storagePath = decodeURIComponent(m[1]);
    const bucket = getStorage().bucket('mealog-r0.firebasestorage.app');
    const file = bucket.file(storagePath);
    const [contents] = await file.download();

    try {
      const resized = await sharp(contents)
        .rotate() // EXIF 방향 반영 — 안 하면 눕거나 뒤집힌 채로 전달된다
        .resize({
          width: DIET_REPORT_PHOTO_MAX_EDGE,
          height: DIET_REPORT_PHOTO_MAX_EDGE,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: DIET_REPORT_PHOTO_JPEG_QUALITY })
        .toBuffer();
      return { mimeType: 'image/jpeg', data: resized.toString('base64') };
    } catch (resizeErr) {
      // 리사이즈 실패는 분석을 막을 이유가 못 된다. 원본 그대로 보낸다.
      logger.warn('dietFetchStorageImageInline: 리사이즈 실패, 원본 전송', {
        storagePath,
        message: resizeErr?.message
      });
      const ext = (storagePath.split('.').pop() || 'jpg').toLowerCase();
      const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return { mimeType, data: contents.toString('base64') };
    }
  } catch (e) {
    logger.warn('dietFetchStorageImageInline failed', { message: e?.message });
    return null;
  }
}

/** 분석 대상 meal → Gemini 텍스트 블록(시간순 슬롯별) */
function formatMealsForDietPrompt(analyzable) {
  const sorted = [...analyzable].sort(compareDietMealsChronologically);
  const lines = [];
  for (const m of sorted) {
    const sl = dietSlotLabel(m.slotId);
    const detail = adminMealSlotDetailForGemini(m);
    lines.push(`· ${sl}:\n    ${detail}`);
  }
  return lines.join('\n');
}

/** 기록된 슬롯 / 기록 없는 슬롯 — "안 먹은 것"과 "기록 안 한 것"을 모델이 구분하도록 분모를 준다 */
function formatDietSlotCoverage(analyzable) {
  const present = new Map();
  for (const m of analyzable || []) {
    const key = String(m?.slotId || '');
    if (!present.has(key)) present.set(key, []);
    present.get(key).push(m);
  }
  const recorded = [];
  const missing = [];
  for (const slotId of DIET_SLOT_ORDER) {
    const label = dietSlotLabel(slotId);
    const rows = present.get(slotId);
    if (!rows || rows.length === 0) {
      missing.push(label);
      continue;
    }
    const times = rows.map((m) => adminMealTimeText(m)).filter(Boolean);
    recorded.push(times.length ? `${label}(${times.join(', ')})` : label);
  }
  const lines = [`기록됨: ${recorded.length ? recorded.join(' · ') : '없음'}`];
  lines.push(`기록 없음: ${missing.length ? missing.join(' · ') : '없음'}`);
  lines.push('※ "기록 없음"은 실제로 거르셨을 수도, 기록만 빠졌을 수도 있다. 단정하지 말 것.');
  return lines.join('\n');
}

/** 사용자 프로필(성별·연령대·라이프스타일) — 없으면 빈 문자열 */
async function buildDietProfileBlock(uid) {
  try {
    const snap = await db.doc(`artifacts/${APP_ID}/users/${uid}/config/settings`).get();
    const profile = (snap.exists ? snap.data()?.profile : null) || {};
    const bits = [];
    const gender = String(profile.gender || '').trim();
    if (gender) bits.push(`성별: ${gender}`);
    const birthdate = String(profile.birthdate || '').trim();
    const by = /^(\d{4})/.exec(birthdate);
    if (by) {
      const age = new Date().getFullYear() - Number(by[1]);
      if (age > 0 && age < 120) bits.push(`연령대: ${Math.floor(age / 10) * 10}대`);
    }
    const lifestyle = String(profile.lifestyle || '').trim();
    if (lifestyle) bits.push(`생활 패턴: ${lifestyle}`);
    return bits.length ? bits.join(' · ') : '';
  } catch (e) {
    logger.warn('buildDietProfileBlock failed', { uid, errMsg: e?.message });
    return '';
  }
}

/** responseText → 파싱된 JSON 객체(코드펜스 허용). 객체가 아니거나 파싱 실패 시 null */
function parseDietReportResponseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

/**
 * 직전 DIET_REPORT_STATS_DAYS일의 리포트 문서를 한 번에 읽어 두 가지를 만든다.
 * - trendBlock: 최근 DIET_REPORT_TREND_DAYS일의 제목·한마디·렌즈 (반복 회피용)
 * - pastMeals:  최근 전체 기간의 끼니 스냅샷 (평소를 계산할 재료)
 *
 * 문서 id가 {uid}_{date}라 getAll로 바로 집는다(색인·쿼리 불필요, 없는 날짜는 빠진다).
 * 두 블록이 같은 문서를 보므로 읽기는 한 번으로 끝낸다 — 따로 읽으면 21건이 된다.
 */
async function buildDietRecentContext(uid, dateStr) {
  try {
    const refs = [];
    for (let i = 1; i <= DIET_REPORT_STATS_DAYS; i += 1) {
      const d = adminYmdAddDays(dateStr, -i);
      refs.push(db.doc(`artifacts/${APP_ID}/aiDietReports/${dietReportDocId(uid, d)}`));
    }
    const snaps = await db.getAll(...refs);
    const lines = [];
    const pastMeals = [];
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      if (data.status !== 'ready') continue;
      const day = String(data.date || snap.id.split('_').pop() || '');
      for (const m of Array.isArray(data.inputMeals) ? data.inputMeals : []) {
        pastMeals.push({ ...m, date: day });
      }
      // 제목·한마디는 최근 며칠만 되먹인다. 그보다 오래된 건 사용자도 기억하지 않는다.
      if (lines.length >= DIET_REPORT_TREND_DAYS) continue;
      const parsed = parseDietReportResponseJson(data.responseText);
      if (!parsed) continue;
      const gist = String(parsed.title || parsed.summary || '').replace(/\s+/g, ' ').trim();
      // 렌즈를 함께 실어야 모델이 "최근에 쓴 축"을 피할 수 있다. 이게 회전의 실질 장치다.
      const lens = normalizeDietLens(data.lens) || normalizeDietLens(parsed.lens);
      const lensTxt = lens ? ` · 렌즈: ${lens}` : '';
      // nudge 원문까지 실어야 한마디의 반복을 모델이 볼 수 있다. 렌즈만 되먹이면 highlight 만
      // 회전하고 nudge 는 "기록 칭찬 + 내일 인사"로 고착된다(8/16~18 실측 96%).
      const nudge = String(parsed.nudge || '').replace(/\s+/g, ' ').trim();
      const nudgeTxt = nudge ? ` · 한마디: "${nudge.slice(0, 50)}"` : '';
      lines.push(
        `- ${day} ${dietWeekdayLabel(day)}${lensTxt}${gist ? ` · ${gist.slice(0, 60)}` : ''}${nudgeTxt}`
      );
    }
    // 오래된 날짜가 위로 오도록(문서 순서는 최근 → 과거)
    lines.reverse();
    return { trendBlock: lines.join('\n'), pastMeals };
  } catch (e) {
    logger.warn('buildDietRecentContext failed', { uid, dateStr, errMsg: e?.message });
    return { trendBlock: '', pastMeals: [] };
  }
}

/**
 * detailText 한 덩이에서 집계에 쓸 값만 뽑는다.
 * (formatMealsForDietPrompt 가 만든 형식이라 라벨이 고정이다)
 */
function parseDietMealDetail(detailText) {
  const s = String(detailText || '');
  const pick = (label) => {
    const m = s.match(new RegExp(`${label}: *(.+)`));
    return m ? m[1].trim() : '';
  };
  return { menu: pick('메뉴'), place: pick('장소'), withWho: pick('함께') };
}

/** "HH:MM" → 분. 실패하면 null */
function dietTimeToMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 세 끼로 치는 슬롯. 나머지(아침 전·오전·오후·저녁 후 간식)는 전부 간식으로 센다 */
const DIET_MAIN_SLOTS = ['morning', 'lunch', 'dinner'];
const DIET_MAIN_SLOT_LABELS = ['아침', '점심', '저녁'];

/**
 * 끼니인지 간식인지. slotId 가 있으면 그걸 쓰고, 없으면 라벨로 폴백한다
 * (inputMeals 에 slotId 를 담기 전에 만들어진 문서가 최근 흐름에 섞여 들어온다).
 */
function dietSlotKind(meal) {
  const id = String(meal?.slotId || '');
  if (id) return DIET_MAIN_SLOTS.includes(id) ? 'main' : 'snack';
  return DIET_MAIN_SLOT_LABELS.includes(String(meal?.slotLabel || '')) ? 'main' : 'snack';
}

/**
 * 5점 척도 평균의 차이를 정도 말로 바꾼다. 말할 만한 차이가 아니면 null.
 *
 * 만족도·포만감을 "3.3점 · 평소 3.1점"처럼 내보내면 리포트가 성적표가 된다. 사용자가 매긴
 * 점수를 되돌려 말하는 것이기도 해서, 숫자 대신 정도로만 준다.
 */
function dietGapWord(diff) {
  const d = Math.abs(diff);
  if (d < 0.3) return null;
  const degree = d < 0.6 ? '조금' : d < 1.2 ? '뚜렷하게' : '많이';
  return `${degree} ${diff > 0 ? '높은' : '낮은'}`;
}

/** 메뉴 문자열에서 비교용 토큰. 2글자 미만은 버린다(조각 매칭 방지) */
function dietMenuTokens(menu) {
  return String(menu || '')
    .split(/[,·/]/)
    .map((s) => s.trim())
    // 사용자는 메뉴 칸에 수량과 메모를 함께 적는다("반숙란2개", "물만두5", "맘모스 사진에서1").
    // 그대로 토큰으로 쓰면 매일 새 토큰이 생겨 "오늘 처음 나온 것"이 늘 참이 된다 —
    // 신호가 아니라 노이즈다. 괄호와 수량을 떼고, 한글이 남은 짧은 덩이만 인정한다.
    // (한글 조건이 없으면 몸무게 "43.9kg" 이 ". kg" 라는 토큰으로 살아남는다)
    .map((s) =>
      s
        .replace(/[()[\]{}]/g, ' ')
        .replace(/[0-9]+(\.[0-9]+)?\s*(개|봉|쪽|잔|병|인분|kg|g|ml|cc)?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((s) => s.length <= 8 && (s.match(/ /g) || []).length <= 1 && /[가-힣]{2,}/.test(s));
}

/**
 * 오늘 기록의 시각을 근거로 써도 되는지. 못 쓰면 이유를 돌려준다.
 *
 * - clustered: 서로 다른 슬롯이 한 덩이 시각에 모여 있다. 식사 시각이 아니라 몰아 적은 입력 시각이다.
 * - inverted: 슬롯 순서와 시각 순서가 어긋난다. 실측에서 "아침 10:22 · 점심 08:32 · 저녁 20:29"
 *   같은 날이 드물지 않았고(잘못 넣었다가 나중에 고치는 흔적), 그대로 두면 모델은 데이터를 정확히
 *   읽은 결과로 "아침보다 이른 점심" 같은 제목을 낸다. 사람이 보면 틀린 문장인데 모델 잘못이 아니다.
 *
 * night(저녁 후 간식)은 자정을 넘겨 적히는 게 정상이라 순서 검사에서 뺀다.
 * 같은 슬롯에 여러 기록이 있을 수 있으므로 슬롯별 평균끼리 비교한다.
 */
function detectDietTimeUnreliable(todayMeals) {
  const timed = (todayMeals || []).filter((m) => dietTimeToMinutes(m.time) != null);
  if (timed.length < 2) return null;

  const times = timed.map((m) => dietTimeToMinutes(m.time));
  if (
    timed.length >= 3 &&
    new Set(timed.map((m) => m.slotLabel)).size >= 2 &&
    Math.max(...times) - Math.min(...times) <= DIET_REPORT_STATS_CLUSTER_RANGE
  ) {
    return 'clustered';
  }

  const bySlot = new Map();
  for (const m of timed) {
    if (String(m.slotId || '') === 'night') continue;
    const rank = dietSlotRank(m.slotId);
    if (!bySlot.has(rank)) bySlot.set(rank, []);
    bySlot.get(rank).push(dietTimeToMinutes(m.time));
  }
  const ranks = [...bySlot.keys()].sort((a, b) => a - b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  for (let i = 1; i < ranks.length; i += 1) {
    if (mean(bySlot.get(ranks[i])) < mean(bySlot.get(ranks[i - 1])) - DIET_REPORT_STATS_ORDER_SLACK) {
      return 'inverted';
    }
  }
  return null;
}

/**
 * "평소와 오늘" 비교 블록.
 *
 * 하루치만 보면 모델은 사용자가 이미 아는 것을 요약하는 수밖에 없다 — 그날 안에는 비교 대상이
 * 없기 때문이다. 실측 기준선(2026-08-19)에서 네 칸이 전부 같은 축을 돌던 것도 이 때문이었다.
 * 그래서 비교 가능한 사실을 서버가 미리 계산해 넣는다. 모델은 문장만 만들고 숫자는 만들지 않는다.
 *
 * 재료 편중도 여기서 교정된다: 실측 652끼니에서 만족도·포만감·시간은 기록률 100%인데
 * feeling 렌즈는 2%만 뽑혔고, 기록률 5%인 코멘트를 쓰는 words 렌즈가 12% 뽑혔다.
 */
function formatDietRecentStatsBlock(pastMeals, todayMeals) {
  const past = Array.isArray(pastMeals) ? pastMeals : [];
  const today = Array.isArray(todayMeals) ? todayMeals : [];

  // 이 판정은 오늘 기록만 있으면 되므로 "평소"가 없는 사용자에게도 내보낸다.
  const unreliable = detectDietTimeUnreliable(today);
  const lines = unreliable
    ? [
        unreliable === 'clustered'
          ? '* 오늘은 끼니 시각이 한 덩이로 몰려 있다. 실제 식사 시각이 아니라 나중에 몰아서 적은 입력 시각이다.'
          : '* 오늘은 끼니 시각이 슬롯 순서와 어긋나 있다(예: 점심이 아침보다 이르다). 잘못 입력된 시각이다.',
        '  시간을 근거로 삼지 말고, 시각이 이상하다는 사실 자체도 리포트에 쓰지 않는다.',
        '  시각을 뺀 나머지(무엇을, 누구와, 어디서, 만족도)로 그날을 본다.'
      ]
    : [];
  if (past.length < DIET_REPORT_STATS_MIN_MEALS) return lines.join('\n');

  const pastDays = new Set(past.map((m) => m.date).filter(Boolean)).size;
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);
  /**
   * 점수 필드 추출. null 을 Number() 에 넣으면 0 이 되고 Number.isFinite(0) 은 true 라,
   * 미기록 끼니가 0점으로 평균에 섞인다. 검증에서 "만족도 평소 0.0점"이 나온 원인이었다.
   */
  const scores = (arr, key) =>
    arr.map((m) => (m?.[key] == null ? NaN : Number(m[key]))).filter((v) => Number.isFinite(v) && v > 0);

  lines.push(`* 최근 ${pastDays}일 ${past.length}끼가 쌓여 있고, 오늘은 ${today.length}끼다.`);
  const perDay = past.length / Math.max(1, pastDays);
  if (Math.abs(today.length - perDay) >= 1.5) {
    lines.push(`* 끼니 수: 오늘 ${today.length}끼 — 최근 ${pastDays}일 하루 평균 ${fmt(perDay)}끼`);
  }

  // 만족도·포만감 — 기록률 100%인 유일한 비교 재료지만, 점수로 내보내면 리포트가 성적표처럼 읽힌다.
  // 그래서 숫자를 주지 않고 정도로 바꿔 넣는다. 모델에게 없는 숫자는 모델도 쓸 수 없다.
  const pr = scores(past, 'rating');
  const tr = scores(today, 'rating');
  if (pr.length >= 5 && tr.length) {
    const word = dietGapWord(avg(tr) - avg(pr));
    if (word) lines.push(`* 만족도: 오늘은 최근 ${pastDays}일보다 ${word} 편이다`);
  }
  const ps = scores(past, 'satiety');
  const ts = scores(today, 'satiety');
  if (ps.length >= 5 && ts.length) {
    const word = dietGapWord(avg(ts) - avg(ps));
    if (word) lines.push(`* 포만감: 오늘은 최근 ${pastDays}일보다 ${word} 편이다`);
  }

  // 끼니 구성 — rhythm 이 볼 자리다. 시각은 이 앱에서 신뢰할 수 있는 값이 아니다(잘못 넣거나
  // 몰아 적는다). 반면 "무엇을 채웠나"는 기록 자체라 언제나 정확하다.
  const todayMainSet = new Set(
    today.filter((m) => dietSlotKind(m) === 'main').map((m) => String(m.slotLabel || ''))
  );
  const todaySnacks = today.filter((m) => dietSlotKind(m) === 'snack').length;
  const had = DIET_MAIN_SLOT_LABELS.filter((s) => todayMainSet.has(s));
  const missed = DIET_MAIN_SLOT_LABELS.filter((s) => !todayMainSet.has(s));
  lines.push(
    `* 오늘 끼니 구성: ${
      missed.length ? `${had.join('·') || '세 끼 모두'} 기록, ${missed.join('·')} 기록 없음` : '아침·점심·저녁 모두 기록'
    } · 간식 ${todaySnacks}회`
  );

  const byDate = new Map();
  for (const m of past) {
    if (!m.date) continue;
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  if (byDate.size >= 3) {
    const fullDays = [...byDate.values()].filter((ms) => {
      const s = new Set(ms.filter((m) => dietSlotKind(m) === 'main').map((m) => String(m.slotLabel || '')));
      return DIET_MAIN_SLOT_LABELS.every((x) => s.has(x));
    }).length;
    const snackPerDay = past.filter((m) => dietSlotKind(m) === 'snack').length / byDate.size;
    lines.push(
      `* 최근 ${byDate.size}일 중 세 끼를 다 기록한 날 ${fullDays}일 · 하루 간식 평균 ${fmt(snackPerDay)}회`
    );
  }

  // 혼자 / 함께 — 기록률이 낮아(실측 13%) 양쪽이 다 모일 때만 말이 된다
  const withRating = past.filter((m) => m.rating != null && Number(m.rating) > 0 && parseDietMealDetail(m.detailText).withWho);
  const alone = withRating.filter((m) => parseDietMealDetail(m.detailText).withWho === '혼자').map((m) => Number(m.rating));
  const together = withRating.filter((m) => parseDietMealDetail(m.detailText).withWho !== '혼자').map((m) => Number(m.rating));
  if (alone.length >= 5 && together.length >= 5) {
    const gap = avg(together) - avg(alone);
    const word = dietGapWord(gap);
    if (word) {
      lines.push(
        `* 최근 ${pastDays}일 만족도: 누군가와 함께 드신 끼니가 혼자 드신 끼니보다 ${word} 편이다`
      );
    }
  }

  // 반복 메뉴와 오늘 처음 보는 메뉴 — "몇 번째인지"는 사용자가 세고 있지 않은 사실이다
  const pastTokens = new Map();
  past.forEach((m) => {
    dietMenuTokens(parseDietMealDetail(m.detailText).menu).forEach((t) => pastTokens.set(t, (pastTokens.get(t) || 0) + 1));
  });
  const todayTokens = [...new Set(today.flatMap((m) => dietMenuTokens(parseDietMealDetail(m.detailText).menu)))];
  const repeated = todayTokens
    .map((t) => [t, pastTokens.get(t) || 0])
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (repeated.length) {
    lines.push(
      `* 오늘 메뉴 중 최근 ${pastDays}일에도 나온 것: ${repeated.map(([t, c]) => `${t} ${c}회`).join(' · ')}`
    );
  }
  // "오늘 처음 나온 것"은 뺐다. 메뉴 칸은 자유 입력이라 같은 음식이 날마다 다르게 적힌다 —
  // 과거에 "캡슐커피"·"빽다방 IA"로 적힌 사용자가 오늘 "커피"라고 적으면 처음 보는 메뉴가 된다.
  // 실제로 "평소 기록에 없던 '커피'가 처음 등장했어요"가 나갔다. 정확 일치로는 판단할 수 없는 값이고,
  // 반복(3회 이상 같은 토큰)은 그 자체로 참이라 그것만 남긴다.

  return lines.join('\n');
}

// -------------------------------------------------------------------------
// 금지 주제 가드 — "야채·과일 얘기 하지 마라"는 프롬프트만으로는 새어 나온다.
// 프롬프트가 막는 건 표현이고, 모델은 완곡하게 바꿔서 같은 말을 한다.
// 여기서 잡아 1회 재생성시키고, 그래도 새면 policyViolation 으로 남긴다.
// -------------------------------------------------------------------------

/** 검사 대상 필드 — 사용자에게 문장으로 보이는 것만 */
const DIET_POLICY_FIELDS = ['title', 'summary', 'highlight', 'nudge'];

/**
 * balanceNote 는 점수 내역의 근거 칸이라 영양 소재를 사실로 적을 수 있는 유일한 필드다
 * ("고기와 채소가 반반"). 다만 "부족/보충/늘리/챙기" 같은 권유·결핍 표현이 들어오면
 * 결국 훈수가 되므로 소재 유무와 무관하게 그 신호만 잡는다.
 * 새 필드를 무방비로 두면 프롬프트가 막은 말이 그대로 이리로 샌다.
 */
const DIET_POLICY_BALANCE_NOTE_RE = /부족|보충|늘리|늘려|채워|신경\s*써|보완|곁들|더하|더해|추가|챙기|챙겨|아쉬|필요/;

/** 영양소 소재. 이 자체는 위반이 아니다(먹은 걸 사실로 말할 수 있어야 한다) */
const DIET_POLICY_NUTRIENT_RE = /채소|야채|샐러드|과일|단백질|비타민|식이섬유|영양소|영양\s*균형|칼로리/;

/**
 * "더 먹어라" 신호. 소재 + 이 신호가 같은 필드에 있을 때만 위반으로 본다.
 * (먹은 것을 서술하는 "샐러드로 점심을 챙긴 건 좋았어요"를 오탐하지 않기 위함)
 */
const DIET_POLICY_STRONG_RE = /부족|보충|늘리|늘려|채워|섭취|신경\s*써|의식적|보완/;
/** nudge는 조언 필드라 제안형 어미까지 넓게 잡는다 */
const DIET_POLICY_NUDGE_RE = /곁들|더하|더해|추가|챙기|챙겨|드셔|먹어\s*보|넣어\s*보/;

/**
 * nudge 전용 — nudge는 조언 필드가 아니라 "알아봐 주는 한마디"다.
 * 영양소와 무관하더라도 제안형 문장이면 위반이다.
 * "내일 기록도 기다릴게요" 같은 관계적 표현은 걸리지 않도록 어미를 좁게 잡는다.
 */
const DIET_POLICY_ADVICE_RE =
  /보세요|보시는 것도|보셔도|보아요|봐요|어떨까요|어때요|하면 좋|해도 좋|가져가도|가져가|추천|권해|드셔 ?보|챙겨 ?보/;

/**
 * nudge 에서 기록 행위를 칭찬하는 말.
 *
 * "기록을 남기셨네요"는 매일 참이라 매일 같은 한마디가 된다. 실측(8/16~18)에서 nudge 의 96%가
 * 여기 걸렸다. 프롬프트로 세 번 막아 봤지만(축 5종 제시 → 한 줄 금지 → 예시 복원) 매번 새어
 * 나왔고, 재작성 지시를 붙인 재생성은 실제로 들었다. 그래서 프롬프트가 아니라 여기서 막는다.
 * lens 가 habit 인 날은 기록 행위가 그날의 관찰 축이므로 예외다.
 */
const DIET_NUDGE_RECORD_RE = /기록|적어|적으|남기|남겨/;

/**
 * 제목을 요약으로 끝내는 말.
 *
 * title 은 화면에서 가장 먼저, 때로는 유일하게 읽히는 자리다. "~한 하루"로 맺으면 그날의 제목이
 * 아니라 아무 날에나 붙는 설명이 된다. 프롬프트에서 방식·예시·점검 항목으로 네 번 막았지만
 * 검증에서 12건 중 4건이 그대로 나왔다(막을수록 다른 자리로 옮겨 갈 뿐이었다).
 * 판정이 단순하고 예외가 거의 없으므로 가드로 잡아 다시 쓰게 한다.
 */
const DIET_TITLE_BLAND_RE = /(하루|날|식사|한 끼|시간)$/;

/** 위반 필드명 배열. 없으면 빈 배열 */
function detectDietPolicyViolation(responseText) {
  const parsed = parseDietReportResponseJson(responseText);
  if (!parsed) return [];
  const hits = [];
  const balanceNote = typeof parsed.balanceNote === 'string' ? parsed.balanceNote : '';
  if (balanceNote && DIET_POLICY_BALANCE_NOTE_RE.test(balanceNote)) hits.push('balanceNote');
  for (const field of DIET_POLICY_FIELDS) {
    const v = typeof parsed[field] === 'string' ? parsed[field] : '';
    if (!v) continue;
    // 제목이 "~한 하루"로 끝나면 그날의 제목이 아니라 아무 날에나 붙는 설명이다.
    if (field === 'title' && DIET_TITLE_BLAND_RE.test(v.trim())) {
      hits.push(field);
      continue;
    }
    // nudge 는 조언 자체가 금지라 영양소 소재 없이도 제안형이면 걸린다.
    if (field === 'nudge' && DIET_POLICY_ADVICE_RE.test(v)) {
      hits.push(field);
      continue;
    }
    // habit 인 날 말고는 기록 칭찬도 위반이다 — 매일 참인 말이라 한마디가 매일 같아진다.
    if (field === 'nudge' && normalizeDietLens(parsed.lens) !== 'habit' && DIET_NUDGE_RECORD_RE.test(v)) {
      hits.push(field);
      continue;
    }
    if (!DIET_POLICY_NUTRIENT_RE.test(v)) continue;
    const suggestive =
      DIET_POLICY_STRONG_RE.test(v) || (field === 'nudge' && DIET_POLICY_NUDGE_RE.test(v));
    if (suggestive) hits.push(field);
  }
  return hits;
}

/**
 * 상투 표현 — 프롬프트 [상투 표현 금지] 가 실제로 먹히는지 보는 눈이다.
 * 금지 주제와 달리 재생성시키지 않는다: 위험한 게 아니라 지루한 것이고,
 * 개정 직전 실측(8/16~18, 51건)에서 "바쁜 하루" 39% · "꼼꼼하게" 33% 였으므로
 * 전부 재호출하면 호출이 1.4배가 된다. 문서에 남겨 추이를 보고, 온도 인상과
 * 프롬프트로도 줄지 않는 항목만 나중에 재생성 가드로 승격한다.
 */
const DIET_CLICHE_RES = [
  ['바쁜하루', /바쁜 (하루|날|와중|아침|저녁|월요일|한 주)/],
  ['기록칭찬', /꼼꼼|빠짐없이|잊지 않|놓지 않|꾸준함이 돋보|성실함/],
  ['앱이름', /밀로그/],
  ['하루뭉뚱', /(특별한|알찬|든든한|다채로운|즐거운|소중한) 하루/]
];

/** 걸린 라벨 배열. 없으면 빈 배열 */
function detectDietClicheHits(responseText) {
  const parsed = parseDietReportResponseJson(responseText);
  if (!parsed) return [];
  const text = DIET_POLICY_FIELDS.map((f) => (typeof parsed[f] === 'string' ? parsed[f] : '')).join(' ');
  return DIET_CLICHE_RES.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/** 재생성 시 프롬프트 뒤에 덧붙일 교정 지시 */
function buildDietPolicyCorrection(violatedFields) {
  const lines = [
    '[재작성 지시]',
    `방금 생성한 응답의 ${violatedFields.join(', ')} 필드가 [금지 주제]를 위반했다.`,
    '채소·야채·샐러드·과일·단백질·비타민·식이섬유·영양소·영양 균형·칼로리를 더 챙기라는 취지의 문장은',
    '완곡한 표현이나 은유를 포함해 어떤 형태로도 쓸 수 없다.'
  ];
  if (violatedFields.includes('balanceNote')) {
    lines.push(
      'balanceNote 는 무엇이 있었는지만 적는 칸이다. 부족·보충·아쉬움·권유를 뜻하는 표현은 쓸 수 없다.',
      '"밥·면 위주, 국 한 번", "고기와 채소가 반반"처럼 그날 구성을 사실로만 서술한다.'
    );
  }
  if (violatedFields.includes('title')) {
    lines.push(
      'title 이 "하루", "날", "식사", "한 끼"로 끝났다. 그렇게 맺으면 그날의 제목이 아니라',
      '아무 날에나 붙는 설명이 된다. 그날에만 있던 구체적인 것(메뉴 이름, 가게 이름, 함께한 사람,',
      '사용자가 쓴 말) 하나를 집어 12~18자로 다시 쓴다. 어제 리포트에 붙여도 말이 되면 또 다시 쓴다.'
    );
  }
  if (violatedFields.includes('nudge')) {
    lines.push(
      'nudge 는 조언 필드가 아니다. "~해 보세요", "~하면 좋아요", "~어떨까요" 같은 제안형 문장과',
      '다음 끼니·내일의 식사를 어떻게 하라는 말은 어떤 형태로도 쓸 수 없다.',
      '"기록", "적다", "남기다"로 사용자를 칭찬하는 문장도 쓸 수 없다. 기록을 남긴 것은 어느 날에나',
      '참이라 그 말을 쓰는 순간 오늘의 한마디가 아니게 된다.',
      'nudge 는 그날에만 있는 근거를 딛고 쓴다 — 사용자가 남긴 말에 대한 대꾸, 그날 상태를 짚어 주는 말,',
      '며칠째 이어 가고 있는 것에 대한 인정, 하루소감의 감정에 대한 공감 중 하나를 고른다.'
    );
  }
  lines.push(
    '해당 필드를 그날 기록에 실제로 있는 다른 사실(코멘트, 하루소감, 메뉴 이름, 장소, 함께 먹은 사람,',
    '만족도 점수, 포만감 점수, 끼니 사이 간격, 외식·배달·집밥 비중)을 근거로 완전히 새로 써라.',
    '나머지 필드는 유지해도 된다. 동일한 JSON 형식으로 전체를 다시 출력한다.'
  );
  return lines.join('\n');
}

/**
 * Gemini 응답 텍스트 정규화 + 검증.
 * 클라이언트(js/utils/ai-meal-report.js)가 렌더할 수 있는 형태인지 여기서 확인한다.
 * 통과 못 하면 던져서 재시도/에러 경로로 보낸다 — 깨진 JSON을 status:'ready'로 저장하면
 * 사용자 화면에 원문이 그대로 노출된다.
 */
function normalizeDietReportResponseText(text) {
  let s = (text || '').trim();
  if (!s) throw new Error('빈 응답');
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  s = s.slice(0, 16000);

  const parsed = parseDietReportResponseJson(s);
  if (!parsed) throw new Error('응답 JSON 파싱 실패');

  // score 는 더 이상 모델이 내지 않는다(화면 점수는 기록 충실도로, 클라이언트가 직접 계산).
  // 따라서 표시 가능 여부는 문장 필드만으로 판단한다.
  const hasText = ['summary', 'title', 'highlight', 'nudge', 'goodPoint', 'improvePoint'].some(
    (k) => typeof parsed[k] === 'string' && parsed[k].trim()
  );
  if (!hasText) throw new Error('응답에 표시할 필드가 없음');

  return s;
}

/**
 * Gemini 멀티모달 호출.
 * @param {{date:string, weekday?:string, mealText?:string, profile?:string,
 *          slotCoverage?:string, recentTrend?:string, recentStats?:string}} ctx 프롬프트 치환 컨텍스트
 * @param {Array<{inlineData:{mimeType:string,data:string}, caption:string}>} imageParts
 * @returns {Promise<{responseText:string, tokenUsage:object|null, model:string,
 *                    sentImageCount:number, fallbackUsed:string|null,
 *                    policyViolation:string[]|null, policyRetried:boolean}>}
 */
async function callGeminiDietReport(ctx, imageParts, promptTemplate) {
  const apiKey = geminiApiKey.value();
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  }
  const { staticPart, variablePart } = splitDietPromptForCaching(ctx, promptTemplate);
  const dateStr = ctx?.date || '';

  const model = GEMINI_MEALDANG_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const invoke = async (images, thinkingBudget, extraInstruction) => {
    const generationConfig = {
      temperature: DIET_REPORT_TEMPERATURE,
      topP: 0.9,
      maxOutputTokens: DIET_REPORT_MAX_OUTPUT_TOKENS,
      // 스키마는 고정하지 않는다 — 운영 프롬프트가 관리자에서 자유롭게 바뀌므로
      // responseSchema로 필드를 못 박으면 새 필드가 조용히 잘려 나간다. JSON 유효성만 강제.
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget }
    };
    // 사진마다 바로 앞에 슬롯 캡션을 둔다. 캡션 없이 뒤에 몰아 붙이면
    // 모델이 어느 사진이 어느 끼니인지 알 수 없어 사진을 사실상 무시한다.
    const parts = [{ text: variablePart }];
    for (const img of images) {
      if (img.caption) parts.push({ text: img.caption });
      parts.push({ inlineData: img.inlineData });
    }
    // 교정 지시는 맨 뒤에 — 가장 최근 지시가 가장 강하게 먹는다.
    if (extraInstruction) parts.push({ text: extraInstruction });
    const body = { contents: [{ parts }], generationConfig };
    // 고정 지시문은 systemInstruction 으로 — 캐시 경계를 명확히 하고 규칙 준수도 강해진다.
    if (staticPart) body.systemInstruction = { parts: [{ text: staticPart }] };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://mealog-r0.web.app/' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || (await res.text().catch(() => ''));
      throw new Error(`Gemini API 오류: ${res.status} - ${msg}`);
    }
    await recordGeminiModelUsage(model);
    const finishReason = data?.candidates?.[0]?.finishReason || '';
    const text = extractGeminiResponseText(data);
    if (!text) {
      throw new Error(`Gemini 응답 텍스트 없음 (finishReason=${finishReason || 'unknown'})`);
    }
    const responseText = normalizeDietReportResponseText(text);
    return { responseText, tokenUsage: data?.usageMetadata || null, model };
  };

  /**
   * invoke + 금지 주제 가드. 걸리면 교정 지시를 붙여 1회만 다시 부른다.
   * 재시도가 실패하거나 또 걸리면 첫 응답을 쓰되 policyViolation 으로 남겨 관리자가 보게 한다.
   */
  const invokeGuarded = async (images, thinkingBudget) => {
    const first = await invoke(images, thinkingBudget);
    const violated = detectDietPolicyViolation(first.responseText);
    if (violated.length === 0) return { ...first, policyViolation: null, policyRetried: false };

    logger.warn('callGeminiDietReport: 금지 주제 위반, 재생성', { dateStr, fields: violated });
    try {
      const second = await invoke(images, thinkingBudget, buildDietPolicyCorrection(violated));
      const stillViolated = detectDietPolicyViolation(second.responseText);
      if (stillViolated.length) {
        logger.warn('callGeminiDietReport: 재생성 후에도 위반', { dateStr, fields: stillViolated });
      }
      return {
        ...second,
        policyViolation: stillViolated.length ? stillViolated : null,
        policyRetried: true
      };
    } catch (e) {
      logger.warn('callGeminiDietReport: 교정 재생성 실패, 첫 응답 사용', { dateStr, errMsg: e?.message });
      return { ...first, policyViolation: violated, policyRetried: true };
    }
  };

  const images = Array.isArray(imageParts) ? imageParts : [];
  // 사진을 버리는 건 마지막 수단이므로, 이미지 관련 오류로만 text-only 강등을 허용한다.
  const isImageError = (msg) => /Unable to process input image|inlineData|image/i.test(msg);
  const isRetriable = (msg) =>
    /Gemini 응답 텍스트 없음|MAX_TOKENS|응답 JSON 파싱 실패|응답에 표시할 필드가 없음/i.test(msg) ||
    isImageError(msg);

  // thinking이 출력 예산을 잠식해 본문이 잘린 경우가 먼저이므로, 사진을 버리기 전에 thinking부터 끈다.
  const fallbacks = [];
  if (DIET_REPORT_THINKING_BUDGET > 0) fallbacks.push({ images, thinkingBudget: 0, label: 'no-thinking' });
  if (images.length > 0) fallbacks.push({ images: [], thinkingBudget: 0, label: 'text-only', imageOnly: true });

  let lastError;
  try {
    const r = await invokeGuarded(images, DIET_REPORT_THINKING_BUDGET);
    return { ...r, sentImageCount: images.length, fallbackUsed: null };
  } catch (e) {
    lastError = e;
  }
  for (const fb of fallbacks) {
    const msg = String(lastError?.message || lastError);
    if (!isRetriable(msg)) break;
    if (fb.imageOnly && !isImageError(msg)) break;
    logger.warn(`callGeminiDietReport: retry ${fb.label}`, {
      dateStr,
      imageCount: fb.images.length,
      errMsg: msg
    });
    try {
      const r = await invokeGuarded(fb.images, fb.thinkingBudget);
      return { ...r, sentImageCount: fb.images.length, fallbackUsed: fb.label };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * 한 사용자·날짜의 리포트를 생성해 저장. 성공 시 status:'ready', 실패 시 status:'error'.
 * @param {'batch'|'manual'} trigger
 * @param {object} [dietConfig] fetchDietReportConfig() 결과(배치 루프에서 재사용)
 */
async function generateAndSaveDietReport(uid, dateStr, meals, trigger, dietConfig) {
  const config = dietConfig || (await fetchDietReportConfig());
  const { analyzable, hash: mealHash, maxRecordedAt, photoCount } = buildDietReportSource(meals);
  if (analyzable.length < 2) {
    throw new Error('해당 날짜에 식사/간식 기록이 2개 이상 있어야 분석할 수 있습니다.');
  }
  const dailyJournalEntry = await adminFetchDailyJournalForDate(uid, dateStr);
  const dailyJournalBlock = formatDailyJournalBlockForDiet(dateStr, dailyJournalEntry);
  const hash = crypto
    .createHash('sha1')
    .update(`${mealHash}\n${dailyJournalBlock}`)
    .digest('hex');
  const reportRef = db.doc(`artifacts/${APP_ID}/aiDietReports/${dietReportDocId(uid, dateStr)}`);

  await archiveDietReportSnapshotIfAny(reportRef);

  // 사진 수집(시간순): meal 문서당 DIET_REPORT_MAX_PHOTOS_PER_DOC 장, 하루 전체 DIET_REPORT_MAX_PHOTOS_TOTAL 장.
  // 각 사진에는 "몇 번째 사진 · 어느 슬롯 · 몇 시"인지 캡션을 붙여 프롬프트와 짝지어 보낸다.
  const imageParts = [];
  const inputMealsForAnalysis = [];
  for (const m of analyzable) {
    const photos = Array.isArray(m.photos) ? m.photos.filter(Boolean) : [];
    const slotLabel = dietSlotLabel(m.slotId);
    const timeTxt = adminMealTimeText(m);
    const analyzedPhotoUrls = [];
    let usedForDoc = 0;
    for (let i = 0; i < photos.length; i += 1) {
      if (usedForDoc >= DIET_REPORT_MAX_PHOTOS_PER_DOC || imageParts.length >= DIET_REPORT_MAX_PHOTOS_TOTAL) break;
      // 원본 대신 800px 파생본을 보낸다 — Gemini가 어차피 다운샘플하므로 화질 손해 없이
      // 다운로드·입력 토큰만 줄어든다. 파생본이 없는 구버전 기록은 원본으로 폴백.
      const sourceUrl = dietPickPhotoUrlForAnalysis(m, i);
      const inline = await dietFetchStorageImageInline(sourceUrl);
      if (inline) {
        const caption = `[사진 ${imageParts.length + 1} · ${slotLabel}${timeTxt ? ` ${timeTxt}` : ''}]`;
        imageParts.push({ inlineData: inline, caption });
        analyzedPhotoUrls.push(sourceUrl);
        usedForDoc += 1;
      }
    }
    inputMealsForAnalysis.push({
      slotId: String(m.slotId || ''),
      slotLabel,
      mealId: String(m.id || ''),
      detailText: adminMealSlotDetailForGemini(m),
      comment: adminMealCommentText(m) || null,
      time: timeTxt || null,
      rating: Number.isFinite(Number(m.rating)) ? Math.round(Number(m.rating)) : null,
      satiety: Number.isFinite(Number(m.satiety)) ? Math.round(Number(m.satiety)) : null,
      photoCount: photos.length,
      analyzedPhotoUrls
    });
  }

  const mealText = formatMealsForDietPrompt(analyzable) + dailyJournalBlock;
  const [profileBlock, recentContext] = await Promise.all([
    buildDietProfileBlock(uid),
    buildDietRecentContext(uid, dateStr)
  ]);
  const recentTrendBlock = recentContext.trendBlock;
  const recentStatsBlock = formatDietRecentStatsBlock(recentContext.pastMeals, inputMealsForAnalysis);
  const slotCoverageBlock = formatDietSlotCoverage(analyzable);
  const promptCtx = {
    date: dateStr,
    weekday: dietWeekdayLabel(dateStr),
    mealText,
    profile: profileBlock,
    slotCoverage: slotCoverageBlock,
    recentTrend: recentTrendBlock,
    recentStats: recentStatsBlock
  };
  const inputSnapshot = {
    inputMealText: String(mealText || '').slice(0, 12000),
    inputMeals: inputMealsForAnalysis,
    inputDailyJournalComment: adminNormalizeDailyJournalEntry(dailyJournalEntry).comment.slice(0, 4000) || null,
    // 이상한 문장이 나왔을 때 모델 탓인지 계산 탓인지는 이 블록을 봐야 갈린다.
    // ("평소 기록에 없던 '커피'" 가 왜 나왔는지 추적하려다 이게 없어 다시 계산해 봐야 했다)
    inputRecentStats: String(recentStatsBlock || '').slice(0, 2000) || null
  };
  const base = {
    userId: uid,
    date: dateStr,
    mealCount: analyzable.length,
    photoCount,
    // 실제로 모델에 보낸 장수는 폴백 결과를 안 뒤에 덮어쓴다(아래). 여기 값은 에러 경로용 상한.
    preparedPhotoCount: imageParts.length,
    analyzedPhotoCount: imageParts.length,
    sourceHash: hash,
    sourceUpdatedAtMax: maxRecordedAt || null,
    promptVersion: config.promptVersion,
    hasProfileContext: !!profileBlock,
    hasRecentTrendContext: !!recentTrendBlock,
    hasRecentStatsContext: !!recentStatsBlock,
    trigger,
    generatedAt: FieldValue.serverTimestamp(),
    ...inputSnapshot
  };

  try {
    const { responseText, tokenUsage, model, sentImageCount, fallbackUsed, policyViolation, policyRetried } =
      await callGeminiDietReport(promptCtx, imageParts, config.promptTemplate);
    // text-only 폴백으로 성공했다면 "분석된 사진"도 없는 게 맞다 — 관리자 카드가
    // 실제로 안 쓰인 사진을 분석 사진으로 보여 주면 안 된다.
    const inputMealsFinal =
      sentImageCount === 0 && imageParts.length > 0
        ? inputMealsForAnalysis.map((m) => ({ ...m, analyzedPhotoUrls: [] }))
        : inputMealsForAnalysis;
    await reportRef.set(
      {
        ...base,
        inputMeals: inputMealsFinal,
        status: 'ready',
        isLatest: true,
        isHistory: false,
        responseText,
        modelVersion: model,
        tokensUsed: tokenUsage,
        // 사진을 버린 폴백으로 성공했다면 그 사실을 그대로 남긴다.
        // (예전에는 준비 장수를 그대로 저장해 "사진 3장 분석"으로 보였다)
        analyzedPhotoCount: sentImageCount,
        // 다음 날 {{recentTrend}} 가 읽어 렌즈 회전에 쓴다. responseText 안에도 있지만
        // 매번 파싱하지 않도록 최상위로 승격해 둔다.
        lens: normalizeDietLens(parseDietReportResponseJson(responseText)?.lens) || FieldValue.delete(),
        fallbackUsed: fallbackUsed || FieldValue.delete(),
        // 재생성으로도 못 막은 금지 주제 — 프롬프트를 손봐야 한다는 신호
        policyViolation: policyViolation && policyViolation.length ? policyViolation : FieldValue.delete(),
        policyRetried: policyRetried === true ? true : FieldValue.delete(),
        // 재생성은 시키지 않고 계측만 한다. 이 값이 안 줄면 프롬프트가 아니라 가드로 막아야 한다.
        clicheHits: (() => {
          const h = detectDietClicheHits(responseText);
          return h.length ? h : FieldValue.delete();
        })(),
        score: FieldValue.delete(),
        summary: FieldValue.delete(),
        goodPoint: FieldValue.delete(),
        improvePoint: FieldValue.delete(),
        errorMessage: FieldValue.delete(),
        historyOf: FieldValue.delete(),
        archivedAt: FieldValue.delete()
      },
      { merge: true }
    );
    return { status: 'ready' };
  } catch (e) {
    logger.warn('generateAndSaveDietReport failed', { uid, dateStr, errMsg: e?.message });
    await reportRef.set(
      {
        ...base,
        status: 'error',
        isLatest: true,
        isHistory: false,
        analyzedPhotoCount: 0,
        lens: FieldValue.delete(),
        fallbackUsed: FieldValue.delete(),
        policyViolation: FieldValue.delete(),
        policyRetried: FieldValue.delete(),
        clicheHits: FieldValue.delete(),
        modelVersion: GEMINI_MEALDANG_MODEL,
        errorMessage: String(e?.message || e).slice(0, 500),
        historyOf: FieldValue.delete(),
        archivedAt: FieldValue.delete()
      },
      { merge: true }
    );
    return { status: 'error', error: e };
  }
}

/**
 * 하루 1회 실행(DIET_REPORT_BATCH_RUN_TIME). adminSettings/dietReportConfig 의 batchEnabled 로만 켜고 끈다.
 * 대상: 최근 7일(배치 실행일 제외) 기록이 있는 사용자 → 각 사용자의 가장 최근 기록일 분석.
 * 해당 날짜에 분석 이력(자동·수동)이 있으면 skip.
 */
exports.scheduledDailyDietAnalysis = onSchedule(
  {
    // DIET_REPORT_BATCH_RUN_TIME 과 같은 시각이어야 한다 — 상수는 표시용, 이 cron 이 정본이다
    schedule: '0 4 * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 540,
    memory: '1GiB'
  },
  async () => {
    const config = await fetchDietReportConfig();
    if (!config.batchEnabled) {
      logger.info('scheduledDailyDietAnalysis: batch disabled in adminSettings, skip');
      return;
    }
    const now = new Date();
    const todaySeoul = adminSeoulYmdFromDate(now);
    if (config.lastBatchRunDate === todaySeoul) {
      logger.info('scheduledDailyDietAnalysis: already ran today', { todaySeoul });
      return;
    }

    const windowStart = adminYmdAddDays(todaySeoul, -7);
    const snap = await db
      .collectionGroup('meals')
      .where('date', '>=', windowStart)
      .where('date', '<', todaySeoul)
      .get();

    const byUser = new Map();
    snap.forEach((docSnap) => {
      const segs = docSnap.ref.path.split('/');
      const uid = segs[3];
      if (!uid) return;
      const date = String(docSnap.data()?.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      if (!byUser.has(uid)) {
        byUser.set(uid, { maxDate: date, mealsByDate: new Map() });
      }
      const row = byUser.get(uid);
      if (date > row.maxDate) row.maxDate = date;
      if (!row.mealsByDate.has(date)) row.mealsByDate.set(date, []);
      row.mealsByDate.get(date).push({ id: docSnap.id, ...docSnap.data() });
    });

    const candidates = [];
    for (const [uid, row] of byUser) {
      const meals = row.mealsByDate.get(row.maxDate) || [];
      const analyzableCount = meals.filter(isDietAnalyzableMeal).length;
      if (analyzableCount >= 2) candidates.push({ uid, targetDate: row.maxDate, meals });
    }
    logger.info('scheduledDailyDietAnalysis: 후보', {
      todaySeoul,
      windowStart,
      candidates: candidates.length,
      batchRunTime: DIET_REPORT_BATCH_RUN_TIME
    });

    let ok = 0;
    let err = 0;
    let skip = 0;
    for (const { uid, targetDate, meals } of candidates) {
      if (targetDate < DIET_REPORT_START_DATE) {
        skip += 1;
        continue;
      }
      const reportRef = db.doc(`artifacts/${APP_ID}/aiDietReports/${dietReportDocId(uid, targetDate)}`);
      const existing = await reportRef.get();
      if (existing.exists && dietReportAlreadyAnalyzed(existing.data())) {
        skip += 1;
        continue;
      }
      const r = await generateAndSaveDietReport(uid, targetDate, meals, 'batch', config);
      if (r.status === 'ready') ok += 1;
      else err += 1;
    }

    await DIET_REPORT_CONFIG_REF().set(
      {
        lastBatchRunDate: todaySeoul,
        lastBatchRunAt: FieldValue.serverTimestamp(),
        lastBatchStats: { ok, err, skip, candidates: candidates.length }
      },
      { merge: true }
    );
    logger.info('scheduledDailyDietAnalysis: 완료', { todaySeoul, ok, err, skip });
  }
);

/**
 * 수동 재분석 일일 한도. rateLimits/{uid} 의 dietReportRegenerate 카운터를 서울 날짜 기준으로 증가시킨다.
 * 한도를 넘으면 HttpsError('resource-exhausted')를 던지고 카운터는 올리지 않는다.
 */
async function consumeDietReportManualQuota(uid, todaySeoul) {
  const ref = db.collection('artifacts').doc(APP_ID).collection('rateLimits').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? snap.data()?.dietReportRegenerate : null;
    const count = prev && String(prev.date || '') === todaySeoul ? Number(prev.count) || 0 : 0;
    if (count >= DIET_REPORT_MANUAL_DAILY_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `AI 분석은 하루 ${DIET_REPORT_MANUAL_DAILY_LIMIT}번까지 요청할 수 있어요. 내일 다시 시도해 주세요.`
      );
    }
    tx.set(
      ref,
      {
        dietReportRegenerate: { date: todaySeoul, count: count + 1 },
        lastUpdated: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });
}

/**
 * 수동 재분석(사용자 AI 리포트 버튼 / 관리자). 배치 on/off 와 무관하게 항상 동작.
 * 요청: { date: 'YYYY-MM-DD', userId?: string }
 */
exports.regenerateDietReport = onCall(
  { region: REGION, timeoutSeconds: 120, memory: '1GiB' },
  wrapFunction('regenerateDietReport', async (request) => {
    const callerAuth = request.auth;
    if (!callerAuth || !callerAuth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const d = request.data || {};
    const dateStr = String(d.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new HttpsError('invalid-argument', 'date(YYYY-MM-DD)가 필요합니다.');
    }
    const todaySeoul = adminSeoulYmdFromDate(new Date());
    if (dateStr >= todaySeoul) {
      throw new HttpsError('failed-precondition', '오늘·미래 날짜는 분석할 수 없습니다.');
    }

    const callerIsAdmin = await isAdminByUid(callerAuth.uid);
    let targetUid = callerAuth.uid;
    if (d.userId && String(d.userId) !== callerAuth.uid) {
      if (!callerIsAdmin) {
        throw new HttpsError('permission-denied', '다른 사용자의 리포트는 관리자만 재생성할 수 있습니다.');
      }
      targetUid = String(d.userId);
    }

    const reportRef = db.doc(`artifacts/${APP_ID}/aiDietReports/${dietReportDocId(targetUid, dateStr)}`);
    const existing = await reportRef.get();
    if (existing.exists) {
      const g = existing.data().generatedAt;
      const gms = g && typeof g.toMillis === 'function' ? g.toMillis() : 0;
      if (gms && Date.now() - gms < 30000) {
        throw new HttpsError('resource-exhausted', '방금 생성했습니다. 잠시 후 다시 시도해 주세요.');
      }
    }

    const meals = await adminFetchMealsForDates(targetUid, [dateStr]);
    const analyzable = meals.filter(isDietAnalyzableMeal);
    if (analyzable.length < 2) {
      throw new HttpsError('failed-precondition', '해당 날짜에 식사/간식 기록이 2개 이상 있어야 분석할 수 있습니다.');
    }

    // 조건 검증을 통과한 요청만 한도를 소모한다.
    if (!callerIsAdmin) {
      await consumeDietReportManualQuota(callerAuth.uid, todaySeoul);
    }

    const r = await generateAndSaveDietReport(targetUid, dateStr, meals, 'manual');
    if (r.status !== 'ready') {
      const saved = (await reportRef.get()).data() || {};
      const detail = saved.errorMessage || 'AI 분석에 실패했습니다. 잠시 후 다시 시도해 주세요.';
      throw new HttpsError('internal', detail);
    }
    const saved = (await reportRef.get()).data() || {};
    return {
      ok: true,
      report: {
        date: dateStr,
        status: saved.status,
        responseText: saved.responseText || '',
        mealCount: saved.mealCount,
        photoCount: saved.photoCount,
        analyzedPhotoCount: saved.analyzedPhotoCount
      }
    };
  })
);

// ═══════════════════════════════════════════════════════════════
// 미분류 식사 기록 카테고리 backfill (docs/food-category-auto-classification.md §6)
// ═══════════════════════════════════════════════════════════════
const classifyMoments = require('./classifyMoments.js');

/** 6시간마다: 최근 7일 미분류 기록을 최대 100건 배치 분류 */
/**
 * 하루 소감 meals 미러 백필 — 관리자 전용, 수동 1회성.
 *
 * 관리자 화면에서는 이 일을 할 수 없다. 규칙상 `users/{uid}/meals` 는 **본인만** 쓸 수 있어서
 * 클라이언트 백필은 늘 permission-denied 로 끝났다. 규칙을 열어 관리자 쓰기를 허용하는 대신
 * admin SDK 로 처리한다.
 *
 * 미러가 생기기 시작한 것은 2026-06-10 이고, 그 이전 소감은 dailyComments 에만 있다.
 * 모먼트 관리 목록이 미러를 정본으로 삼게 되면서 옛 소감이 목록에서 빠지므로 한 번 메워 준다.
 */
exports.adminBackfillDailyJournalMirrors = onCall(
  { region: REGION, timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    if (!(await isAdminByUid(callerUid))) throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');

    const dryRun = request.data?.dryRun === true;
    const maxWrites = Math.min(Number(request.data?.maxWrites) || 500, 2000);

    /** 이미 미러가 있는 `uid|date` — 한 번에 모아 두면 건마다 확인하지 않아도 된다 */
    const existing = new Set();
    const mirrorSnap = await db.collectionGroup('meals').where('slotId', '==', 'daily_journal').get();
    mirrorSnap.forEach((d) => {
      const segs = d.ref.path.split('/');
      const ui = segs.indexOf('users');
      const uid = ui >= 0 ? segs[ui + 1] : '';
      const date = String(d.data()?.date || '').trim();
      if (uid && date) existing.add(`${uid}|${date}`);
    });

    const normalizeIso = (raw) => {
      if (raw == null) return '';
      if (typeof raw === 'string') {
        const t = Date.parse(raw.trim());
        return Number.isFinite(t) ? new Date(t).toISOString() : '';
      }
      if (typeof raw.toDate === 'function') {
        const d = raw.toDate();
        return d && Number.isFinite(d.getTime()) ? d.toISOString() : '';
      }
      if (typeof raw.seconds === 'number') return new Date(raw.seconds * 1000).toISOString();
      return '';
    };

    /** js/utils/daily-journal-data.js 의 normalize·hasContent 와 같은 기준 */
    const toEntry = (raw) => {
      if (raw == null || raw === '') return null;
      // 구형 소감은 문자열 하나로만 저장돼 있다 — 나머지 필드를 비워 두면 set() 이 undefined 로 거부한다
      if (typeof raw === 'string') {
        if (!raw.trim()) return null;
        return {
          comment: raw,
          photos: [],
          sharedPhotos: [],
          photoAspectRatio: '1:1',
          weightEnabled: false,
          bloodSugarEnabled: false,
          weightRecords: [],
          bloodSugarRecords: [],
          recordedAt: ''
        };
      }
      if (typeof raw !== 'object') return null;
      return {
        comment: String(raw.comment || ''),
        photos: Array.isArray(raw.photos) ? raw.photos.filter(Boolean) : [],
        sharedPhotos: Array.isArray(raw.sharedPhotos) ? raw.sharedPhotos.filter(Boolean) : [],
        photoAspectRatio: raw.photoAspectRatio || '1:1',
        weightEnabled: raw.weightEnabled === true,
        bloodSugarEnabled: raw.bloodSugarEnabled === true,
        weightRecords: Array.isArray(raw.weightRecords) ? raw.weightRecords : [],
        bloodSugarRecords: Array.isArray(raw.bloodSugarRecords) ? raw.bloodSugarRecords : [],
        recordedAt: normalizeIso(raw.recordedAt)
      };
    };
    const hasContent = (e) =>
      !!e &&
      (String(e.comment || '').trim() !== '' ||
        (e.photos && e.photos.length > 0) ||
        (e.weightEnabled && (e.weightRecords || []).length > 0) ||
        (e.bloodSugarEnabled && (e.bloodSugarRecords || []).length > 0));

    /** recordedAt 이 없으면 시각을 모른다 — 23:59 로 밀어 넣지 않고 자정으로 둔다 */
    const mealTimeOf = (iso) => {
      if (!iso) return '00:00';
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return '00:00';
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    let scanned = 0;
    let candidates = 0;
    let written = 0;
    const configSnap = await db.collectionGroup('config').get();
    for (const docSnap of configSnap.docs) {
      if (docSnap.id !== 'settings') continue;
      const segs = docSnap.ref.path.split('/');
      const ui = segs.indexOf('users');
      const uid = ui >= 0 ? segs[ui + 1] : '';
      if (!uid) continue;
      const dc = docSnap.data()?.dailyComments;
      if (!dc || typeof dc !== 'object') continue;
      for (const [dateStr, raw] of Object.entries(dc)) {
        const dk = String(dateStr || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) continue;
        scanned++;
        if (existing.has(`${uid}|${dk}`)) continue;
        const entry = toEntry(raw);
        if (!hasContent(entry)) continue;
        candidates++;
        if (dryRun || written >= maxWrites) continue;
        const ref = db.doc(`artifacts/${APP_ID}/users/${uid}/meals/dailyJournal_${dk}`);
        // 옛 문서에는 어떤 모양이 섞여 있을지 모른다 — undefined 가 하나라도 있으면 set 이 통째로 거부된다
        const payload = {
          date: dk,
          time: mealTimeOf(entry.recordedAt),
          slotId: 'daily_journal',
          comment: entry.comment,
          photos: entry.photos,
          sharedPhotos: entry.sharedPhotos,
          photoAspectRatio: entry.photoAspectRatio,
          weightEnabled: entry.weightEnabled,
          bloodSugarEnabled: entry.bloodSugarEnabled,
          weightRecords: entry.weightRecords,
          bloodSugarRecords: entry.bloodSugarRecords,
          // 시각을 모르는 옛 기록은 그 날짜 자정으로 둔다 — 없는 값을 지어내지 않는다
          recordedAt: entry.recordedAt || `${dk}T00:00:00.000Z`,
          mirrorBackfilledAt: FieldValue.serverTimestamp()
        };
        for (const k of Object.keys(payload)) {
          if (payload[k] === undefined) delete payload[k];
        }
        await ref.set(payload);
        written++;
      }
    }

    logger.info('adminBackfillDailyJournalMirrors', { scanned, candidates, written, dryRun, existing: existing.size });
    return { ok: true, scanned, candidates, written, alreadyMirrored: existing.size, dryRun };
  }
);

exports.classifyUncategorizedMeals = onSchedule(
  {
    schedule: '0 */6 * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 300,
    memory: '512MiB'
  },
  async () => {
    const apiKey = geminiApiKey.value();
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
      logger.warn('classifyUncategorizedMeals: GEMINI_API_KEY 미설정, skip');
      return;
    }
    const today = adminSeoulYmdFromDate(new Date());
    try {
      await classifyMoments.runClassifyUncategorizedMeals({
        db,
        logger,
        apiKey,
        model: GEMINI_MEALDANG_MODEL,
        startDate: adminYmdAddDays(today, -7),
        endDate: today,
        maxDocs: 100
      });
    } catch (e) {
      // best-effort — 실패한 건은 다음 배치가 다시 집는다
      logger.error('classifyUncategorizedMeals 실패', { errMsg: String(e?.message || e) });
    }
  }
);

/**
 * 과거 데이터 1회성 마이그레이션 (관리자 전용) — 기간을 지정해 레거시 '기타' 기록을 분류.
 * 예: { startDate: '2026-07-01', endDate: '2026-08-12', maxDocs: 100 }
 * 100건씩 나눠 호출한다 (Gemini 배치 1회 = 호출 1회).
 */
exports.adminClassifyLegacyMeals = onCall({ region: REGION }, wrapFunction('adminClassifyLegacyMeals', async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (!(await isAdminByUid(request.auth.uid))) {
    throw new HttpsError('permission-denied', '관리자만 실행할 수 있습니다.');
  }
  const { startDate, endDate, maxDocs } = request.data || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''))) {
    throw new HttpsError('invalid-argument', 'startDate/endDate는 YYYY-MM-DD 형식이어야 합니다.');
  }
  const apiKey = geminiApiKey.value();
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY가 설정되지 않았습니다.');
  }
  const result = await classifyMoments.runClassifyUncategorizedMeals({
    db,
    logger,
    apiKey,
    model: GEMINI_MEALDANG_MODEL,
    startDate: String(startDate),
    endDate: String(endDate),
    maxDocs: Math.min(Number(maxDocs) || 100, 100)
  });
  return { ok: true, ...result };
}));
