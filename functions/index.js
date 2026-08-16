const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { onDocumentCreated, onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getMealDelta, mergeDeltaIntoDay, sanitizeDayEntry, computeStatsFromMeals, isMainSlot } = require('./mealStats.js');
const momentPostV2 = require('./momentPostV2.js');
const mealPhotoVariantsBackfill = require('./mealPhotoVariantsBackfill.js');
const { logger } = require('firebase-functions');
const crypto = require('crypto');
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

// 금칙어 목록 (간단한 예시, 필요시 확장)
const BANNED_WORDS = [
  // 스팸 관련
  /(광고|홍보|무료|이벤트|할인|쿠폰|추천인|링크|http|www\.|\.com)/gi,
  // 부적절한 내용 (예시)
  /(욕설|비방|혐오)/gi
];

// 링크 패턴 감지
const LINK_PATTERNS = [
  /https?:\/\/[^\s]+/gi,
  /www\.[^\s]+/gi,
  /[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*/gi
];

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
 * 스팸 필터링
 */
function checkSpam(content) {
  if (!content || typeof content !== 'string') {
    return { isSpam: false };
  }

  const text = content.toLowerCase().trim();

  // 금칙어 체크
  for (const pattern of BANNED_WORDS) {
    if (pattern.test(text)) {
      return { isSpam: true, reason: '금칙어가 포함되어 있습니다.' };
    }
  }

  // 링크 체크 (게시글/댓글에 링크가 많으면 스팸 의심)
  const links = text.match(LINK_PATTERNS[0]) || [];
  if (links.length > 2) {
    return { isSpam: true, reason: '과도한 링크가 포함되어 있습니다.' };
  }

  return { isSpam: false };
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

/** 관리자 대시보드「페이지별」usageDaily 필드 — js/admin/dashboard.js PAGE_USAGE_METRIC_DEFS 와 동기화 */
const USAGE_DAILY_METRIC_KEYS = new Set([
  'tab_mealdang',
  'mealdang_comment_click',
  'mealdang_analysis_detail_click',
  'tab_moment',
  'tab_mealog',
  'lounge_mealtalk',
  'lounge_board',
  'lounge_notice',
  'settings_profile',
  'settings_tags',
  'settings_mealdang_memo',
  'settings_push'
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
exports.searchKakaoPlaces = onCall({ region: REGION }, wrapFunction('searchKakaoPlaces', async (request) => {
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
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${query}&category_group_code=FD6&size=10`;
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
  const restaurants = documents.filter((place) => {
    const cat = (place.category_name || '').toLowerCase();
    const code = place.category_group_code || '';
    if (code === 'FD6') return true;
    return cat.includes('음식점') || cat.includes('식당') || cat.includes('카페') ||
      cat.includes('레스토랑') || cat.includes('맛집') || cat.includes('요리') ||
      cat.includes('식음료') || cat.includes('제과') || cat.includes('베이커리') ||
      cat.includes('술집') || cat.includes('바');
  });
  return { documents: restaurants.slice(0, 10) };
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
  const ref = await db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').add({
    scheduleType: 'once',
    title: t.slice(0, ADMIN_BROADCAST_TITLE_MAX),
    body: b.slice(0, ADMIN_BROADCAST_BODY_MAX),
    landingTab: land,
    targetEnv: target,
    scheduledAt: Timestamp.fromMillis(ms),
    status: 'pending',
    createdByUid: callerUid,
    createdAt: FieldValue.serverTimestamp()
  });
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

/**
 * 예약 푸시: 매분 pending 중 예정 시각 도래 건 처리
 */
exports.processScheduledAdminPushes = onSchedule(
  {
    schedule: '* * * * *',
    timeZone: 'Asia/Seoul',
    region: REGION,
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const nowMs = Date.now();
    const coll = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
    const snap = await coll.where('status', '==', 'pending').where('scheduledAt', '<=', Timestamp.fromMillis(nowMs)).limit(25).get();

    for (const docSnap of snap.docs) {
      const ref = docSnap.ref;
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

        if (!acquired) continue;

        const after = await ref.get();
        const d = after.data();
        if (!after.exists || d.status !== 'sending') continue;

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
            continue;
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
          continue;
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
              logger.info('processScheduledAdminPushes: weeklyByDay completed', { id: docSnap.id });
            } else {
              await ref.update({
                status: 'pending',
                scheduledAt: Timestamp.fromMillis(nextMs),
                lastSentAt: FieldValue.serverTimestamp(),
                occurrenceCount: FieldValue.increment(1),
                recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
              });
              logger.info('processScheduledAdminPushes: weeklyByDay next', { id: docSnap.id, nextMs });
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
              logger.info('processScheduledAdminPushes: recurring completed', { id: docSnap.id });
            } else {
              await ref.update({
                status: 'pending',
                scheduledAt: Timestamp.fromMillis(nextMs),
                lastSentAt: FieldValue.serverTimestamp(),
                occurrenceCount: FieldValue.increment(1),
                recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
              });
              logger.info('processScheduledAdminPushes: recurring next scheduled', { id: docSnap.id, nextMs });
            }
          }
        } else {
          await ref.update({
            status: 'sent',
            sentAt: FieldValue.serverTimestamp(),
            recipientCount: typeof recipientCount === 'number' ? recipientCount : 0
          });
          logger.info('processScheduledAdminPushes: sent', { id: docSnap.id });
        }
      } catch (e) {
        logger.error('processScheduledAdminPushes: error', { id: docSnap.id, message: e?.message });
        try {
          await ref.update({
            status: 'failed',
            errorMessage: String(e?.message || e).slice(0, 500),
            failedAt: FieldValue.serverTimestamp()
          });
        } catch (_) {}
      }
    }
  }
);

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
    night: '야식'
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

/** 한 줄 요약(웰컴 API 표시용): 입력창 메뉴·메모 등 포함 */
function adminMealShortLine(d) {
  const mt = (d.mealType || '').trim();
  if (mt === 'Skip' || mt === '건너뜀') return '건너뜀';
  const bits = [mt];
  if (d.category) bits.push(String(d.category).trim());
  const st = (d.snackType || '').trim();
  if (st) bits.push(st);
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
//   모델이 저녁→점심→아침 순으로 하루를 읽게 되어 흐름·야식 판단이 무너진다.
// - 사진은 슬롯 라벨 캡션과 짝지어 인터리브 전송(캡션 없이 보내면 사진↔기록 매칭 불가)
// - 프롬프트 치환자: {{date}} {{weekday}} {{mealText}} {{profile}} {{slotCoverage}} {{recentTrend}}
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
const DEFAULT_DIET_REPORT_PROMPT_TEMPLATE = `너는 식단 기록 앱 밀로그의 AI 식사 리포터야.
아래 [식단 데이터]와 함께 제공되는 사진, 만족도, 포만감, 코멘트, 하루소감을 종합해 그날 하루의 식사 기록을 읽는다.
분석 대상 날짜와 사용자 정보는 이 지시문 뒤쪽 [분석 대상] 절에 있다.

이 리포트의 목적은 식단을 채점하는 것이 아니다.
사용자가 "누군가 내 하루를 봐주고 있구나" 하고 느끼게 하는 것, 그래서 내일도 기록할 마음이 들게 하는 것이다.
무엇을 먹었는지만 보지 말고, 어떤 하루를 보냈는지를 본다.

[사용자 정보 사용 규칙]

* 프로필 정보가 있으면 표현의 결을 맞추는 참고로만 쓴다.
* 성별, 연령대, 생활 패턴을 근거로 영양 기준이나 필요 열량을 단정하지 않는다.
* 프로필을 리포트 본문에서 직접 언급하지 않는다.

[관찰 렌즈]

매일 같은 것을 봐 주면 봐주는 느낌이 사라진다.
아래 렌즈 중 그날 데이터가 실제로 받쳐 주는 것 하나를 골라 highlight를 쓴다.

* diet — 무엇을 먹었나. 메뉴 구성, 사진에 보이는 음식
* company — 누구와 먹었나. 혼밥, 동료, 가족, 오랜만의 사람
* place — 어디서 먹었나. 집밥, 외식, 배달, 카페, 회사
* rhythm — 언제 먹었나. 끼니 간격, 이른 저녁, 늦은 점심, 거른 끼니
* feeling — 만족도와 포만감. 높은 만족, 애매한 한 끼, 과한 포만
* words — 사용자가 남긴 코멘트와 하루소감
* habit — 기록 자체. 사진을 남긴 것, 빠짐없이 적은 것
* pattern — 며칠째 이어지는 흐름. [최근 흐름]이 있을 때만

렌즈 선택 규칙

* [최근 흐름]에 최근 사용한 렌즈가 적혀 있다. 그중에 있는 렌즈는 피한다.
* 피할 수 없으면(그날 데이터가 그 렌즈밖에 받쳐 주지 않으면) 같은 렌즈를 써도 되지만, 지난번과 다른 각도로 쓴다.
* 데이터가 없는 렌즈는 고르지 않는다. 함께 먹은 사람 기록이 없으면 company를 고르지 않는다.
* diet는 가장 무난한 선택이라 자칫 매일 고르게 된다. 다른 렌즈가 조금이라도 받쳐 주면 그쪽을 먼저 본다.

[점수 기준]

score는 그날 기록 전반의 인상이다. 벌점표가 아니다.

* 90~100점: 식사 구성, 리듬, 만족도, 기록이 모두 매우 좋은 날
* 80~89점: 전반적으로 좋은 하루이며 아쉬운 점이 가벼운 날
* 70~79점: 무난하지만 한두 끼의 균형이나 간식 흐름이 아쉬운 날
* 60~69점: 일부 식사는 괜찮지만 하루 전체 흐름이 다소 아쉬운 날
* 50~59점: 식사 구성, 리듬, 기록 중 여러 부분이 부족한 날
* 49점 이하: 기록이 매우 부족하거나 하루 식사 판단이 어려운 날

간식이나 야식이 있다고 해서 과도하게 낮게 주지 않는다.
채소·과일·단백질의 균형은 score를 계산할 때만 고려한다.
score 계산에 쓴 영양 판단은 다른 어떤 필드에도 옮기지 않는다.

[사진 읽는 법]

사진은 각 사진 바로 앞에 "[사진 1 · 점심 12:30]" 형태의 캡션이 붙어 있으며, 캡션은 그 사진이 어느 끼니의 것인지 알려 준다.
반드시 캡션과 [식단 데이터]의 해당 끼니를 짝지어 읽는다.
사진과 텍스트가 다르면 사진에서 확인 가능한 내용을 우선하되, 단정하지 않는다.
데이터에 없는 음식, 양, 조리법, 영양성분은 지어내지 않는다.
사진이 없는 끼니는 텍스트만으로 판단하고, 사진이 없다는 이유로 그 끼니를 부정적으로 보지 않는다.

시간 데이터가 부자연스럽거나 모든 끼니 시간이 비슷하면 실제 식사 시간이 아니라 기록 입력 시간일 수 있으므로, 시간보다 끼니 구분을 우선한다.

[톤]

* 가볍고 유쾌하되, 따뜻하고 현실적으로 작성한다.
* 사용자가 읽고 "맞아, 오늘 그랬지" 하고 웃을 수 있는 정도의 표현을 사용한다.
* 아쉬운 날에도 실패처럼 말하지 않는다.
* 사용자를 놀리거나 비난하지 않는다.
* 과한 밈, 인터넷 유행어, 이모지, 반말, 캐릭터 말투는 사용하지 않는다.
* "입터짐", "빵의 유혹", "분식 엔딩", "집밥 안정권", "회식 생존기"처럼 기록 맥락을 살린 가벼운 표현은 사용할 수 있다.
* "훌륭했습니다", "섭취했습니다", "보충이 필요합니다"처럼 딱딱한 리포트 표현은 피한다.

[필드 작성 기준]

lens:

* 위 [관찰 렌즈]에서 고른 렌즈 하나의 영문 키를 그대로 쓴다.
* diet, company, place, rhythm, feeling, words, habit, pattern 중 하나여야 한다.
* 화면에 보이지 않는 필드다. 설명이나 한국어를 넣지 않는다.

score:

* 0~100 사이의 정수로 작성한다.

mood:

* 오늘의 식사 무드를 10자 내외로 작성한다.
* 공유 카드의 작은 뱃지처럼 사용할 수 있어야 한다.
* 예: "입터짐 주의보", "혼밥의 평화", "빵의 유혹", "분식 엔딩", "집밥 안정권", "외식 원정대", "변수 많은 하루"

title:

* 공유 카드용 짧은 제목으로 작성한다.
* 18~25자 내외로 작성한다.
* 음식 이름 1~2개나 그날의 인상적인 장면을 포함한다.
* 설명문이 아니라 공유하고 싶은 제목처럼 쓴다.
* 예: "샐러디는 선방, 아티제 케이크는 기습", "펑크는 났지만 점심 한 끼는 살렸다"

summary:

* 하루 식사 흐름을 한 문장으로 요약하고, 그 뒤에 사용자를 따뜻하게 바라보는 문장을 더해 2문장으로 구성한다.
* 기본은 70~100자 내외로 작성한다.
* 메뉴뿐 아니라 하루소감, 만족도, 식사 흐름 중 의미 있는 내용을 자연스럽게 반영한다.
* 한 문장에 정보를 너무 많이 넣지 않는다.
* 기록이 부족하거나 하루 흐름을 판단하기 어려운 경우, 사용자가 만족스럽지 않은 하루로 남긴 경우에는 억지로 응원하지 않는다.
* score가 낮은 날에는 "잘했다"는 식의 칭찬보다 담백한 표현만 사용한다.

highlight:

* 고른 lens로 그날을 본 관찰을 쓴다. 잘한 점을 칭찬하는 칸이 아니다.
* 50~80자 내외로 작성한다.
* 그날 기록에 실제로 있는 구체적 사실을 최소 하나 담는다. 메뉴 이름, 사람, 장소, 시각, 점수, 사용자가 쓴 표현, 사진에서 확인되는 것 중 하나가 문장에 드러나야 한다.
* 사진에 눈에 띄는 것이 있으면 그것을 근거로 삼아도 좋다. 다만 사진 이야기를 매번 넣을 필요는 없고, 볼 것이 없는 날에는 넣지 않는다.
* 좋은 관찰은 사용자가 "이걸 봤네" 하고 느끼는 것이다. 평가하지 말고 알아본다.
* 렌즈별 예시
  - company: "오랜만에 아버지와 점심을 드셨네요. 국밥집에서 두 시간 가까이 앉아 계셨어요."
  - rhythm: "점심이 두 시 반, 저녁이 아홉 시였어요. 오늘은 하루가 통째로 밀린 날이었네요."
  - words: "'입맛이 없다'고 적어 두셨는데, 그래도 저녁은 챙겨 드셨어요."
  - habit: "다섯 끼를 하나도 빠뜨리지 않고 사진까지 남기셨어요."
  - place: "세 끼 모두 집에서 드신 하루였어요. 요즘 보기 드문 날이네요."
  - pattern: "사흘째 아침을 거르고 계세요. 점심이 그만큼 든든해지고 있고요."
  - feeling: "만족도 5점을 준 건 오늘 저녁 하나였어요. 그 한 끼가 하루를 붙잡아 준 셈이네요."
  - diet: "김밥 한 줄로 시작해 파스타로 마무리한 하루였어요. 면과 밥이 번갈아 등장했네요."
  - diet(사진 근거): "점심 사진에 김밥 옆으로 튀김이 한 접시 같이 놓여 있었네요. 메뉴에는 안 적으셨던 것이고요."

nudge:

* 조언이 아니다. 어떤 종류의 제안, 힌트, 권유도 쓰지 않는다.
* 사용자를 알아봐 주는 짧은 한마디를 쓴다. 45~70자 내외.
* 쓸 수 있는 것
  - 오늘의 수고나 상황을 알아주는 말
  - 사용자가 남긴 코멘트나 하루소감에 대한 반응
  - 내일도 기록을 기다린다는 뉘앙스
  - 꾸준히 적고 있다는 사실을 짚어 주는 말
* 쓰면 안 되는 것
  - "~해 보세요", "~하면 좋아요", "~어떨까요" 같은 제안형 문장
  - 다음 끼니나 내일의 식사를 어떻게 하라는 모든 말
  - 영양, 균형, 양, 시간에 대한 훈수
* 예
  - "바쁜 날이었을 텐데 세 끼를 다 남기셨네요. 내일 기록도 기다릴게요."
  - "입맛 없는 날에도 기록은 놓지 않으셨어요. 그거면 충분한 하루입니다."
  - "혼자 드신 날이 이어지네요. 그래도 매번 적어 두시는 게 대단해요."

[금지 주제]

mood, title, summary, highlight, nudge에서 아래 주제는 어떤 표현으로도 다루지 않는다.
완곡하게 바꾸거나 돌려 말하는 것, 은유로 감싸는 것도 모두 금지한다.

* 채소, 야채, 샐러드를 더 먹으라는 취지의 모든 문장
* 과일을 곁들이라는 취지의 모든 문장
* 단백질을 챙기라는 취지의 모든 문장
* 비타민, 식이섬유, 영양소, 영양 균형, 칼로리를 언급하는 모든 문장
* 다음 끼니나 내일 무엇을 어떻게 먹으라는 모든 문장

아래는 전부 금지에 해당한다. 이런 식의 변형도 쓰지 않는다.

* "단백질과 채소가 부족합니다"
* "채소와 과일 섭취를 늘리세요"
* "채소가 조금 아쉬웠어요"
* "샐러드 한 접시 곁들이면 좋겠어요"
* "과일 한 조각 어떠세요"
* "다음 끼니엔 초록색을 조금 더해 보세요"
* "영양 균형을 조금만 신경 써 보세요"
* "내일은 조금 담백하게 가져가도 좋아요"
* "다음 끼니는 조금 이르게 드셔 보세요"

다만 사용자가 그날 실제로 먹은 채소·과일 메뉴를 사실로 언급하는 것은 허용한다.
예: 기록에 샐러디가 있을 때 "샐러디로 점심을 챙기셨네요"는 괜찮다.
허용되는 것은 먹은 것에 대한 서술이며, 더 먹으라는 제안은 어떤 형태로도 허용되지 않는다.

[피해야 할 표현]

* "식단 관리가 필요합니다"
* "건강에 좋지 않습니다"
* "문제가 있습니다"
* "실패한 식단입니다"
* "나쁜 선택입니다"
* "반드시 줄여야 합니다"

[좋은 출력 예시]

{
"lens": "company",
"score": 76,
"mood": "오랜만의 겸상",
"title": "국밥 한 그릇에 두 시간, 아버지와 점심",
"summary": "혼자 먹는 날이 이어지다 오늘은 아버지와 점심을 함께하셨어요. 저녁까지 무리 없이 이어진 하루였습니다.",
"highlight": "국밥집에서 두 시간 가까이 앉아 계셨네요. 만족도 5점은 오늘 그 한 끼뿐이었어요.",
"nudge": "이런 날은 메뉴보다 함께 앉은 시간이 오래 남죠. 내일 기록도 기다릴게요."
}

[분석 대상]

날짜: {{date}} {{weekday}}
사용자: {{profile}}

[식단 데이터]

{{mealText}}

[슬롯 기록 현황]

{{slotCoverage}}

* "기록 없음"은 실제로 그 끼니를 거른 것일 수도, 기록만 빠진 것일 수도 있으므로 결식으로 단정하지 않는다.
* 하루 전체에서 기록 없는 끼니가 많으면 흐름을 무리하게 해석하지 말고 score도 신중하게 매긴다.
* 기록 없는 끼니를 지적하지 않는다.

[최근 흐름]

{{recentTrend}}

* 최근 며칠의 점수, 한줄평, 그리고 그날 사용한 렌즈다.
* 여기 적힌 렌즈는 이번에 피한다. 매일 같은 것을 봐 주지 않기 위함이다.
* pattern 렌즈를 고를 때만 최근 흐름의 내용을 직접 활용한다. 그 외에는 렌즈 회피용으로만 참고한다.
* 최근 흐름을 요약하거나 지난 점수를 언급하지 않는다. 오늘 하루가 리포트의 중심이다.
* 최근 분석 이력이 없으면 이날 기록만 보고 작성한다.

[출력 규칙]

반드시 아래 key를 가진 유효한 JSON 객체 하나만 출력한다.

{
"lens": "",
"score": 0,
"mood": "",
"title": "",
"summary": "",
"highlight": "",
"nudge": ""
}

* JSON 객체 외의 텍스트는 절대 출력하지 않는다.
* markdown, 코드펜스, 설명문, 주석을 출력하지 않는다.
* key 이름은 반드시 lens, score, mood, title, summary, highlight, nudge만 사용한다.
* key 이름을 한국어로 바꾸지 않는다.
* 누락되는 key 없이 7개 key를 모두 출력한다.
* score는 숫자 정수로 출력한다.
* lens, mood, title, summary, highlight, nudge는 모두 문자열로 출력한다.
* 모든 문자열 값에는 줄바꿈을 넣지 않는다.
* 출력하기 전에 mood, title, summary, highlight, nudge를 다시 읽고 [금지 주제]에 걸리는 문장이 있는지 확인한다. 특히 nudge에 제안형 문장이 섞이지 않았는지 본다. 있으면 그날 기록의 다른 사실을 근거로 새로 써서 바꾼 뒤 출력한다.`;
/**
 * meal 문서당 사진 최대 장수 / 하루 전체 사진 안전 상한.
 * 사진은 입력 토큰의 지배적 비중이라 끼니당 1장으로 제한한다. 같은 끼니의 두 번째 사진은
 * 대개 같은 상을 다른 각도로 찍은 것이라 얻는 정보에 비해 비싸다.
 */
const DIET_REPORT_MAX_PHOTOS_PER_DOC = 1;
const DIET_REPORT_MAX_PHOTOS_TOTAL = 5;
/** gemini-2.5-flash: thinking 토큰도 maxOutputTokens 예산에서 함께 빠지므로 본문 몫을 남겨 둔다 */
const DIET_REPORT_MAX_OUTPUT_TOKENS = 2048;
/**
 * thinking 토큰은 출력 토큰으로 과금되고 출력 단가가 입력보다 훨씬 높아, 개수는 적어도 비용 비중이 크다.
 * 실측(구 프롬프트)에서 509로 512 예산에 맞춰 들어갔으므로 512로 되돌린다.
 * 너무 낮추면 본문이 잘려 no-thinking 재시도가 돌아 오히려 호출이 늘어난다 —
 * 관리자 리포트 상세의 fallbackUsed 배지와 thinking 토큰 수치로 감시할 것.
 */
const DIET_REPORT_THINKING_BUDGET = 512;
/** 채점 태스크라 재현성 우선. 표현 다양성은 프롬프트(title·mood 지시)로 확보한다 */
const DIET_REPORT_TEMPERATURE = 0.35;
/** {{recentTrend}} 에 실을 직전 리포트 일수 */
const DIET_REPORT_TREND_DAYS = 7;
/**
 * 관찰 렌즈 — 매일 같은 축으로 봐 주면 "봐주는 느낌"이 사라지므로 그날 데이터가
 * 받쳐 주는 렌즈를 골라 쓰게 하고, 최근에 쓴 렌즈는 {{recentTrend}} 로 되먹여 회피시킨다.
 * 프롬프트 [관찰 렌즈] 목록과 반드시 일치시킬 것.
 */
const DIET_REPORT_LENSES = ['diet', 'company', 'place', 'rhythm', 'feeling', 'words', 'habit', 'pattern'];

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
  night: '야식'
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

function normalizeDietBatchRunTime(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return '00:10';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function adminSeoulHmFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour}:${minute}`;
}

function parseHmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 15분 주기 스케줄에서 설정 시각(HH:mm) 구간에 들어왔는지 */
function isWithinDietBatchRunWindow(now, runTimeHm, windowMinutes = 15) {
  const runMins = parseHmToMinutes(runTimeHm);
  const nowMins = parseHmToMinutes(adminSeoulHmFromDate(now));
  if (runMins == null || nowMins == null) return false;
  return nowMins >= runMins && nowMins < runMins + windowMinutes;
}

async function fetchDietReportConfig() {
  const snap = await DIET_REPORT_CONFIG_REF().get();
  const d = snap.exists ? snap.data() : {};
  const promptTemplate =
    (d.promptTemplate && String(d.promptTemplate).trim()) || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
  return {
    promptTemplate,
    promptVersion: d.promptVersion || DIET_REPORT_PROMPT_VERSION,
    batchEnabled: d.batchEnabled === true,
    batchRunTime: normalizeDietBatchRunTime(d.batchRunTime),
    lastBatchRunDate: d.lastBatchRunDate ? String(d.lastBatchRunDate) : null
  };
}

/**
 * 프롬프트 치환. 사용자 텍스트에 `$&` 같은 시퀀스가 있어도 깨지지 않도록 함수 replacer를 쓴다.
 * @param {{date:string, weekday?:string, mealText?:string, profile?:string,
 *          slotCoverage?:string, recentTrend?:string}} ctx
 */
function buildDietReportPromptText(ctx, promptTemplate) {
  const tpl = promptTemplate || DEFAULT_DIET_REPORT_PROMPT_TEMPLATE;
  const values = {
    date: ctx?.date || '',
    weekday: ctx?.weekday || '',
    mealText: ctx?.mealText || '(텍스트 기록 없음 — 사진 위주로 판단)',
    profile: ctx?.profile || '(프로필 정보 없음)',
    slotCoverage: ctx?.slotCoverage || '(정보 없음)',
    recentTrend: ctx?.recentTrend || '(최근 분석 이력 없음 — 이날만 보고 평가)'
  };
  return tpl.replace(/\{\{(date|weekday|mealText|profile|slotCoverage|recentTrend)\}\}/g, (_, key) => values[key]);
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
 * 직전 DIET_REPORT_TREND_DAYS일의 리포트 요약 — 문서 id가 {uid}_{date}라 getAll로 바로 집는다.
 * (색인·쿼리 불필요. 없는 날짜는 그냥 빠진다)
 */
async function buildDietRecentTrendBlock(uid, dateStr) {
  try {
    const refs = [];
    for (let i = 1; i <= DIET_REPORT_TREND_DAYS; i += 1) {
      const d = adminYmdAddDays(dateStr, -i);
      refs.push(db.doc(`artifacts/${APP_ID}/aiDietReports/${dietReportDocId(uid, d)}`));
    }
    const snaps = await db.getAll(...refs);
    const lines = [];
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      if (data.status !== 'ready') continue;
      const parsed = parseDietReportResponseJson(data.responseText);
      if (!parsed) continue;
      const score = Number(parsed.score);
      const scoreTxt = Number.isFinite(score) ? `${Math.round(score)}점` : '점수 없음';
      const gist = String(parsed.title || parsed.summary || '').replace(/\s+/g, ' ').trim();
      const day = String(data.date || snap.id.split('_').pop() || '');
      // 렌즈를 함께 실어야 모델이 "최근에 쓴 축"을 피할 수 있다. 이게 회전의 실질 장치다.
      const lens = normalizeDietLens(data.lens) || normalizeDietLens(parsed.lens);
      const lensTxt = lens ? ` · 렌즈: ${lens}` : '';
      lines.push(`- ${day} ${dietWeekdayLabel(day)} ${scoreTxt}${lensTxt}${gist ? ` · ${gist.slice(0, 60)}` : ''}`);
    }
    // 오래된 날짜가 위로 오도록(문서 순서는 최근 → 과거)
    lines.reverse();
    return lines.join('\n');
  } catch (e) {
    logger.warn('buildDietRecentTrendBlock failed', { uid, dateStr, errMsg: e?.message });
    return '';
  }
}

// -------------------------------------------------------------------------
// 금지 주제 가드 — "야채·과일 얘기 하지 마라"는 프롬프트만으로는 새어 나온다.
// 프롬프트가 막는 건 표현이고, 모델은 완곡하게 바꿔서 같은 말을 한다.
// 여기서 잡아 1회 재생성시키고, 그래도 새면 policyViolation 으로 남긴다.
// -------------------------------------------------------------------------

/** 검사 대상 필드 — 사용자에게 문장으로 보이는 것만 */
const DIET_POLICY_FIELDS = ['mood', 'title', 'summary', 'highlight', 'nudge'];

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
  /보세요|보시는 것도|보셔도|어떨까요|어때요|하면 좋|해도 좋|가져가도|가져가|추천|권해|드셔 ?보|챙겨 ?보/;

/** 위반 필드명 배열. 없으면 빈 배열 */
function detectDietPolicyViolation(responseText) {
  const parsed = parseDietReportResponseJson(responseText);
  if (!parsed) return [];
  const hits = [];
  for (const field of DIET_POLICY_FIELDS) {
    const v = typeof parsed[field] === 'string' ? parsed[field] : '';
    if (!v) continue;
    // nudge 는 조언 자체가 금지라 영양소 소재 없이도 제안형이면 걸린다.
    if (field === 'nudge' && DIET_POLICY_ADVICE_RE.test(v)) {
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

/** 재생성 시 프롬프트 뒤에 덧붙일 교정 지시 */
function buildDietPolicyCorrection(violatedFields) {
  const lines = [
    '[재작성 지시]',
    `방금 생성한 응답의 ${violatedFields.join(', ')} 필드가 [금지 주제]를 위반했다.`,
    '채소·야채·샐러드·과일·단백질·비타민·식이섬유·영양소·영양 균형·칼로리를 더 챙기라는 취지의 문장은',
    '완곡한 표현이나 은유를 포함해 어떤 형태로도 쓸 수 없다.'
  ];
  if (violatedFields.includes('nudge')) {
    lines.push(
      'nudge 는 조언 필드가 아니다. "~해 보세요", "~하면 좋아요", "~어떨까요" 같은 제안형 문장과',
      '다음 끼니·내일의 식사를 어떻게 하라는 말은 어떤 형태로도 쓸 수 없다.',
      'nudge 는 사용자를 알아봐 주는 한마디로만 쓴다 — 오늘의 수고를 알아주는 말, 남긴 코멘트에 대한 반응,',
      '꾸준히 적고 있다는 사실을 짚어 주는 말, 내일 기록을 기다린다는 뉘앙스.'
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

  const hasText = ['summary', 'title', 'highlight', 'nudge', 'goodPoint', 'improvePoint'].some(
    (k) => typeof parsed[k] === 'string' && parsed[k].trim()
  );
  const hasScore = Number.isFinite(Number(parsed.score));
  if (!hasText && !hasScore) throw new Error('응답에 표시할 필드가 없음');

  return s;
}

/**
 * Gemini 멀티모달 호출.
 * @param {{date:string, weekday?:string, mealText?:string, profile?:string,
 *          slotCoverage?:string, recentTrend?:string}} ctx 프롬프트 치환 컨텍스트
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
  const prompt = buildDietReportPromptText(ctx, promptTemplate);
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
    const parts = [{ text: prompt }];
    for (const img of images) {
      if (img.caption) parts.push({ text: img.caption });
      parts.push({ inlineData: img.inlineData });
    }
    // 교정 지시는 맨 뒤에 — 가장 최근 지시가 가장 강하게 먹는다.
    if (extraInstruction) parts.push({ text: extraInstruction });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://mealog-r0.web.app/' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig })
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
  const [profileBlock, recentTrendBlock] = await Promise.all([
    buildDietProfileBlock(uid),
    buildDietRecentTrendBlock(uid, dateStr)
  ]);
  const slotCoverageBlock = formatDietSlotCoverage(analyzable);
  const promptCtx = {
    date: dateStr,
    weekday: dietWeekdayLabel(dateStr),
    mealText,
    profile: profileBlock,
    slotCoverage: slotCoverageBlock,
    recentTrend: recentTrendBlock
  };
  const inputSnapshot = {
    inputMealText: String(mealText || '').slice(0, 12000),
    inputMeals: inputMealsForAnalysis,
    inputDailyJournalComment: adminNormalizeDailyJournalEntry(dailyJournalEntry).comment.slice(0, 4000) || null
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
 * 15분마다 실행 — adminSettings/dietReportConfig 의 batchEnabled·batchRunTime 에 맞춰 하루 1회 배치.
 * 대상: 최근 7일(배치 실행일 제외) 기록이 있는 사용자 → 각 사용자의 가장 최근 기록일 분석.
 * 해당 날짜에 분석 이력(자동·수동)이 있으면 skip.
 */
exports.scheduledDailyDietAnalysis = onSchedule(
  {
    schedule: '*/15 * * * *',
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
    if (!isWithinDietBatchRunWindow(now, config.batchRunTime, 15)) {
      return;
    }
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
      batchRunTime: config.batchRunTime
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
