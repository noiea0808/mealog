const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getMealDelta, mergeDeltaIntoDay, sanitizeDayEntry, computeStatsFromMeals, isMainSlot } = require('./mealStats.js');
const { logger } = require('firebase-functions');
const crypto = require('crypto');

// Firebase Admin 초기화
initializeApp();
const db = getFirestore();
const auth = getAuth();

const APP_ID = 'mealog-r0';

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
  interaction: { perMinute: 20, perHour: 100 } // 상호작용: 분당 20개, 시간당 100개
};

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

/**
 * 관리자 브로드캐스트: 사용자당 FCM은 1회만(가장 최근 등록 토큰 1개).
 * - 동일 env에 토큰 여러 개 / targetEnv all일 때 staging+production 각 1통씩이면 기기에서 2번까지 갈 수 있었음 → 1개로 고정.
 * - 키 문자열이 미세하게 다른 중복 저장(공백 등)도 정규화 후 하나로 합침.
 */
function pickSingleFcmTokenForAdminBroadcast(tokensMap, tokenStrings) {
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

/**
 * 특정 사용자의 FCM 토큰들에 푸시 알림 전송 (실패 시 로그만, 호출자 대기 안 함)
 * @param {string} userId - 수신자 uid
 * @param {{ title: string, body: string, data?: object }} payload
 */
/**
 * @param {{ adminBroadcast?: boolean, pushCategory?: 'momentComment'|'boardComment'|'mealTalk'|'adminDefault' }} options - pushCategory 있으면 사용자 pushPreferences로 필터
 */
async function sendPushToUser(userId, payload, options = {}) {
  if (!userId || !payload?.title) return;
  const pushCategory = options.pushCategory;
  if (pushCategory) {
    const prefs = await getUserPushPreferences(userId);
    if (!isPushCategoryAllowedByPrefs(prefs, pushCategory)) {
      logger.info('sendPushToUser: skipped by pushPreferences', { userId, pushCategory });
      return;
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
    if (options.adminBroadcast && tokens.length > 0) {
      const before = tokens.length;
      tokens = pickSingleFcmTokenForAdminBroadcast(tokensMap, tokens);
      if (tokens.length !== before || before > 1) {
        logger.info('sendPushToUser: adminBroadcast single token', {
          userId,
          before,
          after: tokens.length
        });
      }
    }
    if (tokens.length === 0) {
      logger.info('sendPushToUser: no FCM tokens for user', { userId, targetEnv: envFilter || 'all' });
      return;
    }
    const messaging = getMessaging();
    const dataObj = { ...(payload.data && typeof payload.data === 'object' ? payload.data : {}) };
    if (options.adminBroadcast) {
      dataObj.suppressNumericBadge = '1';
    }
    // Android 8+ 채널: 미지정 시 기기/OS별로 트레이 미표시 이슈가 있을 수 있어 FCM 기본 채널 명시
    const androidNotificationBase = {
      title: payload.title,
      body: payload.body || '',
      channelId: 'fcm_fallback_notification_channel',
      sound: 'default'
    };
    const message = {
      notification: { title: payload.title, body: payload.body || '' },
      data: fcmDataStrings(dataObj),
      android: {
        priority: 'high',
        notification: { ...androidNotificationBase }
      }
    };
    if (options.adminBroadcast) {
      const collapseId =
        typeof options.adminCollapseId === 'string' && options.adminCollapseId.length > 0
          ? options.adminCollapseId.slice(0, 64)
          : makeAdminBroadcastCollapseId(
            payload,
            envFilter || (options.targetEnv === 'staging' || options.targetEnv === 'production' ? options.targetEnv : 'all')
          );
      // Android: 동일 tag면 새 알림이 이전 줄을 대체(Callable 중복·재시도로 N줄 쌓임 방지)
      // iOS: apns-collapse-id로 동일 키 알림 병합
      message.android = {
        priority: 'high',
        notification: {
          ...androidNotificationBase,
          notificationCount: 0,
          tag: `mealog_adm_${collapseId}`
        }
      };
      message.apns = {
        headers: {
          'apns-priority': '10',
          'apns-collapse-id': collapseId
        },
        payload: {
          aps: {
            sound: 'default'
            // badge 생략 → 기존 배지 숫자를 이 푸시가 덮어쓰지 않도록
          }
        }
      };
    }
    const results = await Promise.allSettled(
      tokens.map((token) => messaging.send({ ...message, token }))
    );
    const failed = results.filter((r) => r.status === 'rejected');
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
  } catch (e) {
    logger.warn('sendPushToUser failed', { userId, message: e?.message });
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

  // 반복 문자 체크 (예: "aaaaaa", "111111")
  if (/(.)\1{10,}/.test(text)) {
    return { isSpam: true, reason: '반복된 문자가 과도합니다.' };
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
  
  if (!title || !content || !title.trim() || !content.trim()) {
    throw new HttpsError('invalid-argument', '제목과 내용을 입력해주세요.');
  }

  const sanitizedImageUrls = Array.isArray(imageUrls) ? imageUrls.slice(0, 5).filter(u => typeof u === 'string' && u) : [];

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'post', request);

  // 스팸 필터링
  const spamCheck = checkSpam(title + ' ' + content);
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
    title: title.trim(),
    content: content.trim(),
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
        { pushCategory: 'mealTalk' }
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
        replyTo = {
          postId: rid,
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
  
  if (!postId || !title || !content) {
    throw new HttpsError('invalid-argument', '필수 정보가 누락되었습니다.');
  }

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
  const spamCheck = checkSpam(title + ' ' + content);
  if (spamCheck.isSpam) {
    throw new HttpsError('invalid-argument', spamCheck.reason);
  }

  // 게시글 업데이트
  await postRef.update({
    title: title.trim(),
    content: content.trim(),
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

  const { postId, content } = data;
  
  if (!postId || !content || !content.trim()) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
  }

  // 레이트 리밋 체크
  await checkRateLimit(auth.uid, 'comment', request);

  // 스팸 필터링
  const spamCheck = checkSpam(content);
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
    content: content.trim(),
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
    // 반드시 await: onCall 반환 후 인스턴스가 멈추면 미완료 Promise가 끊겨 푸시가 안 갈 수 있음
    await sendPushToUser(
      postAuthorId,
      {
        title: '새 댓글',
        body: `${authorNickname}님이 댓글을 남겼습니다.`,
        data: { type: 'boardComment', postId: String(postId) }
      },
      { pushCategory: 'boardComment' }
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

  const { postId, content, displayName: clientDisplayName } = data;

  if (!postId || !content || !content.trim()) {
    throw new HttpsError('invalid-argument', '댓글 내용을 입력해주세요.');
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
    content: content.trim(),
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
    await sendPushToUser(
      postAuthorId,
      {
        title: '새 댓글',
        body: `${authorNickname}님이 댓글을 남겼습니다.`,
        data: { type: 'boardComment', postId: String(postId) }
      },
      { pushCategory: 'boardComment' }
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

  if (postOwnerId && postOwnerId !== auth.uid) {
    await sendPushToUser(
      postOwnerId,
      {
        title: '새 댓글',
        body: `${userNickname}님이 댓글을 남겼습니다.`,
        data: { type: 'postComment', postId: String(postId) }
      },
      { pushCategory: 'momentComment' }
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

  await commentRef.delete();

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
        const existingQuery = await sharedColl
          .where('userId', '==', auth.uid)
          .where('entryId', '==', mealData.id)
          .get();
        
        existingQuery.docs.forEach(docSnap => {
          batch.delete(docSnap.ref);
          hasDeletions = true;
        });
      } else {
        // entryId가 null인 경우: userId로만 필터링 후 entryId null인 것만 삭제
        const existingQuery = await sharedColl
          .where('userId', '==', auth.uid)
          .get();
        
        existingQuery.docs.forEach(docSnap => {
          const data = docSnap.data();
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

      // meal 문서의 sharedPhotos 필드는 호출 전에 클라이언트 save(record)에서 이미 반영됨.
      // 여기서 mealDoc.set을 하면 meals 리스너가 한 번 더 떨어져 onDataUpdate가 이중 호출되고,
      // 타임라인 전체 재렌더가 연속 두 번 발생해 공유 시 브라우저 프리징/CPU 급증의 원인이 됨.

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

    // entryId가 있는 경우: 같은 entryId의 기존 문서를 모두 삭제
    if (mealData && mealData.id) {
      const existingQuery = await sharedColl
        .where('userId', '==', auth.uid)
        .where('entryId', '==', mealData.id)
        .get();
      
      existingQuery.docs.forEach(docSnap => {
        batch.delete(docSnap.ref);
      });
    } else {
      // entryId가 null인 경우: userId로만 필터링 후 entryId null인 것만 삭제
      const existingQuery = await sharedColl
        .where('userId', '==', auth.uid)
        .get();
      
      existingQuery.docs.forEach(docSnap => {
        const data = docSnap.data();
        if (!data.entryId || data.entryId === null) {
          batch.delete(docSnap.ref);
        }
      });
    }

    // 사진 비율: 모먼트에서 모든 사용자에게 동일하게 표시되도록 문서에 저장 (업로더 mealHistory에만 있으면 다른 사용자는 1:1로 보이는 문제 해결)
    const aspectRatio = (mealData && mealData.photoAspectRatio === '3:4') ? '3:4'
      : (mealData && mealData.photoAspectRatio === '4:3') ? '4:3' : '1:1';

    // 새로운 사진들을 추가 (photoIndex로 업로드 순서 저장 → 모든 사용자에게 동일한 사진 순서 보장)
    photosToShare.forEach((photoUrl, index) => {
      const docRef = sharedColl.doc();
      batch.set(docRef, {
        photoUrl,
        photoIndex: index,
        userId: auth.uid,
        userNickname,
        userIcon,
        userPhotoUrl,
        mealType: (mealData && mealData.mealType) || '',
        place: (mealData && mealData.place) || '',
        menuDetail: (mealData && mealData.menuDetail) || '',
        deliveryVendor: (mealData && mealData.deliveryVendor) || '',
        deliveryPlaceId: (mealData && mealData.deliveryPlaceId) || '',
        deliveryPlaceAddress: (mealData && mealData.deliveryPlaceAddress) || '',
        deliveryPlaceData: (mealData && mealData.deliveryPlaceData && typeof mealData.deliveryPlaceData === 'object')
          ? mealData.deliveryPlaceData
          : null,
        deliveryKakaoPlace: !!(mealData && mealData.deliveryKakaoPlace),
        snackType: (mealData && mealData.snackType) || '',
        date: (mealData && mealData.date) || '',
        slotId: (mealData && mealData.slotId) || '',
        time: (mealData && mealData.time) || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        timestamp: FieldValue.serverTimestamp(),
        entryId: (mealData && mealData.id) || null,
        comment: (mealData && mealData.comment) || '',
        photoAspectRatio: aspectRatio
      });
    });

    await batch.commit();

    // meal 문서의 sharedPhotos 필드는 호출 전에 클라이언트 save(record)에서 이미 반영됨.
    // 여기서 mealDoc.set을 하면 meals 리스너가 한 번 더 떨어져 onDataUpdate가 이중 호출되고,
    // 타임라인 전체 재렌더가 연속 두 번 발생해 공유 시 브라우저 프리징/CPU 급증의 원인이 됨.

    return { success: true, action: 'share' };
  } catch (error) {
    logger.error('sharePhotos error:', error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError('internal', '공유 처리 중 오류가 발생했습니다.');
  }
});

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
  existingQuery.docs.forEach(docSnap => {
    batch.delete(docSnap.ref);
  });

  // 새로운 일간보기 공유 추가
  const docRef = sharedColl.doc();
  batch.set(docRef, {
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'daily',
    date,
    timestamp: FieldValue.serverTimestamp(),
    entryId: null,
    comment: comment || ''
  });

  await batch.commit();

  return { 
    id: docRef.id, 
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'daily',
    date,
    timestamp: new Date().toISOString(),
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
  existingQuery.docs.forEach(docSnap => {
    batch.delete(docSnap.ref);
  });

  // 새로운 베스트 공유 추가
  const docRef = sharedColl.doc();
  batch.set(docRef, {
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'best',
    periodType,
    periodText,
    timestamp: FieldValue.serverTimestamp(),
    entryId: null,
    comment: comment || ''
  });

  await batch.commit();

  return { 
    id: docRef.id, 
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'best',
    periodType,
    periodText,
    timestamp: new Date().toISOString(),
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

  const { photoUrl, dateRangeText, comment } = data;
  
  if (!photoUrl || !dateRangeText) {
    throw new HttpsError('invalid-argument', '사진 URL과 날짜 범위 텍스트가 필요합니다.');
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
  
  // 같은 날짜 범위의 기존 인사이트 공유 삭제
  const existingQuery = await sharedColl
    .where('userId', '==', auth.uid)
    .where('type', '==', 'insight')
    .where('dateRangeText', '==', dateRangeText)
    .get();
  
  const batch = db.batch();
  existingQuery.docs.forEach(docSnap => {
    batch.delete(docSnap.ref);
  });

  // 새로운 인사이트 공유 추가
  const docRef = sharedColl.doc();
  batch.set(docRef, {
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'insight',
    dateRangeText,
    timestamp: FieldValue.serverTimestamp(),
    entryId: null,
    comment: comment || ''
  });

  await batch.commit();

  return { 
    id: docRef.id, 
    photoUrl,
    userId: auth.uid,
    userNickname,
    userIcon,
    userPhotoUrl,
    type: 'insight',
    dateRangeText,
    timestamp: new Date().toISOString(),
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
    const data = docSnap.data();
    const photoUrlMatch = photos.some(photoUrl => {
      if (photoUrl === data.photoUrl) return true;
      const photoUrlBase = photoUrl.split('?')[0];
      const dataUrlBase = data.photoUrl.split('?')[0];
      if (photoUrlBase === dataUrlBase) return true;
      const photoFileName = photoUrlBase.split('/').pop();
      const dataFileName = dataUrlBase.split('/').pop();
      return photoFileName === dataFileName && photoFileName !== '';
    });
    
    if (photoUrlMatch) {
      if (isBestShare && data.type === 'best') {
        photosToDelete.push(docSnap.id);
      } else if (isDailyShare && data.type === 'daily') {
        photosToDelete.push(docSnap.id);
      } else if (isInsightShare && data.type === 'insight') {
        photosToDelete.push(docSnap.id);
      } else if (!isBestShare && !isDailyShare && !isInsightShare) {
        let shouldDelete = false;
        if (entryId) {
          if (data.entryId === entryId || !data.entryId || data.entryId === null) {
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
 * main 끼니(아침/점심/저녁) 중복 문서 정리 - 동일 (date, slotId)당 1개만 유지
 * 삭제 시 onMealWritten 트리거로 stats 자동 보정
 */
exports.removeDuplicateMeals = onCall(
  { region: REGION },
  wrapFunction('removeDuplicateMeals', async (request) => {
    const auth = request.auth;
    if (!auth || !auth.uid) {
      throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    }
    const userId = auth.uid;
    const mealsRef = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(userId)
      .collection('meals');

    const snapshot = await mealsRef.get();
    const byKey = {};
    snapshot.docs.forEach((doc) => {
      const d = doc.data();
      if (!d?.date || !d?.slotId || !isMainSlot(d.slotId)) return;
      const key = `${d.date}|${d.slotId}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push({ ref: doc.ref, id: doc.id });
    });

    const toDelete = [];
    Object.values(byKey).forEach((arr) => {
      if (arr.length <= 1) return;
      arr.sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 1; i < arr.length; i++) toDelete.push(arr[i].ref);
    });

    const BATCH_SIZE = 500;
    let deletedCount = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const chunk = toDelete.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach((ref) => batch.delete(ref));
      if (chunk.length > 0) {
        await batch.commit();
        deletedCount += chunk.length;
      }
    }

    if (deletedCount > 0) {
      logger.info('removeDuplicateMeals: completed', { userId, deletedCount });
    }
    return { success: true, deletedCount };
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
    kakaoEmailNeedsAgreement: ka.email_needs_agreement === true
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
    patch.createdAt = FieldValue.serverTimestamp();
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

  await db.runTransaction(async (transaction) => {
    if (normNew) {
      const newClaimRef = db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normNew)}`);
      const claimSnap = await transaction.get(newClaimRef);
      if (claimSnap.exists) {
        const owner = claimSnap.data()?.userId;
        if (owner && owner !== uid) {
          throw new HttpsError('already-exists', '이미 사용 중인 닉네임입니다.');
        }
      }
    }
    if (normOld && normOld !== normNew) {
      const oldClaimRef = db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normOld)}`);
      const oldClaimSnap = await transaction.get(oldClaimRef);
      if (oldClaimSnap.exists && oldClaimSnap.data()?.userId === uid) {
        transaction.delete(oldClaimRef);
      }
    }
    transaction.set(settingsRef, settings, { merge: true });
    if (normNew) {
      const newClaimRef = db.doc(`artifacts/${APP_ID}/nicknameClaims/${nicknameClaimDocIdServer(normNew)}`);
      const displayNickname = String(settings.profile?.nickname || '').trim();
      transaction.set(newClaimRef, {
        userId: uid,
        normalizedNickname: normNew,
        displayNickname: displayNickname || normNew,
        updatedAt: new Date().toISOString()
      });
    }
  });

  try {
    await db.doc(`artifacts/${APP_ID}/users/${uid}`).set({ uid }, { merge: true });
  } catch (e) {
    logger.warn('saveArtifactUserSettings: user root set skipped', { uid, err: e?.message });
  }

  return { ok: true };
}));

/**
 * Gemini API 프록시 (WebView 차단 우회)
 * 클라이언트에서 직접 호출 대신 서버에서 Gemini API 호출
 */
exports.callGemini = onCall({ region: REGION }, wrapFunction('callGemini', async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  const { requestBody, model, apiVersion } = request.data || {};
  if (!requestBody || !model) {
    throw new HttpsError('invalid-argument', 'requestBody와 model이 필요합니다.');
  }
  const apiKey = geminiApiKey.value();
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new HttpsError('failed-precondition', 'GEMINI_API_KEY가 설정되지 않았습니다. functions/.env 파일에 GEMINI_API_KEY를 추가하거나, 배포 시 입력 후 재배포하세요.');
  }
  const version = apiVersion || 'v1beta';
  const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`;
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
async function broadcastAdminPushToAllUsers(payload) {
  const usersRef = db.collection('artifacts').doc(APP_ID).collection('users');
  const targetEnv = payload?.targetEnv === 'production' || payload?.targetEnv === 'staging'
    ? payload.targetEnv
    : 'all';
  const adminCollapseId = makeAdminBroadcastCollapseId(payload, targetEnv);
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
      await Promise.all(
        batch.map((uid) =>
          sendPushToUser(uid, payload, {
            adminBroadcast: true,
            targetEnv,
            pushCategory: 'adminDefault',
            adminCollapseId
          })
        )
      );
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }
  logger.info('broadcastAdminPushToAllUsers done', { totalUsers, targetEnv });
}

const ADMIN_PUSH_LANDING_TABS = new Set(['dashboard', 'timeline', 'gallery', 'board', 'settings']);

const ADMIN_RECURRING_INTERVALS = new Set(['daily', 'weekly', 'monthly']);
const ADMIN_PUSH_TARGET_ENVS = new Set(['all', 'production', 'staging']);

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
  createdByUid = null
}) {
  const coll = db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes');
  await coll.add({
    scheduleType,
    title: String(title || '').slice(0, 80),
    body: String(body || '').slice(0, 240),
    landingTab: ADMIN_PUSH_LANDING_TABS.has(String(landingTab || '').trim()) ? String(landingTab).trim() : 'dashboard',
    targetEnv: ADMIN_PUSH_TARGET_ENVS.has(String(targetEnv || '').trim()) ? String(targetEnv).trim() : 'all',
    status: String(status || 'sent'),
    scheduledAt: FieldValue.serverTimestamp(),
    sentAt: FieldValue.serverTimestamp(),
    createdByUid: createdByUid || null,
    createdAt: FieldValue.serverTimestamp()
  });
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
    if (!title || title.length > 80) {
      throw new HttpsError('invalid-argument', '제목은 1~80자로 입력해 주세요.');
    }
    if (!body || body.length > 240) {
      throw new HttpsError('invalid-argument', '내용은 1~240자로 입력해 주세요.');
    }
    const skip = await adminPushNowDedupeShouldSkip({ callerUid, title, body, landingTab, targetEnv });
    if (skip) {
      logger.info('adminBroadcastPushNow: dedupe skip (same payload within window)');
      return { ok: true, deduped: true };
    }
    await broadcastAdminPushToAllUsers({
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
        createdByUid: callerUid
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
  if (!t || t.length > 80) {
    throw new HttpsError('invalid-argument', '제목은 1~80자로 입력해 주세요.');
  }
  if (!b || b.length > 240) {
    throw new HttpsError('invalid-argument', '내용은 1~240자로 입력해 주세요.');
  }
  const serverNow = Date.now();
  const minLead = serverNow + 25 * 1000;
  const scheduleType = data.scheduleType === 'recurring' ? 'recurring' : 'once';

  if (scheduleType === 'recurring') {
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
    const ref = await db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').add({
      scheduleType: 'recurring',
      recurringInterval,
      recurringEndAt: Timestamp.fromMillis(recurringEndMs),
      title: t.slice(0, 80),
      body: b.slice(0, 240),
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

  const ms = typeof data.scheduledAtMs === 'number' && !Number.isNaN(data.scheduledAtMs) ? data.scheduledAtMs : null;
  if (ms == null) {
    throw new HttpsError('invalid-argument', '예약 시각(scheduledAtMs)이 올바르지 않습니다.');
  }
  if (ms < minLead) {
    throw new HttpsError('invalid-argument', '예약 시각은 서버 기준 약 30초 이후로 설정해 주세요.');
  }
  const ref = await db.collection('artifacts').doc(APP_ID).collection('adminScheduledPushes').add({
    scheduleType: 'once',
    title: t.slice(0, 80),
    body: b.slice(0, 240),
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
        await db.runTransaction(async (transaction) => {
          const s = await transaction.get(ref);
          if (!s.exists) return;
          const d = s.data();
          if (d.status !== 'pending') return;
          const sa = d.scheduledAt;
          const ms = sa && typeof sa.toMillis === 'function' ? sa.toMillis() : 0;
          if (!ms || ms > nowMs) return;
          transaction.update(ref, { status: 'sending', lockedAt: FieldValue.serverTimestamp() });
        });

        const after = await ref.get();
        const d = after.data();
        if (!after.exists || d.status !== 'sending') continue;

        const title = String(d.title || '').trim();
        const body = String(d.body || '').trim();
        const tab = String(d.landingTab || 'dashboard').trim();
        const landingTab = ADMIN_PUSH_LANDING_TABS.has(tab) ? tab : 'dashboard';
        if (!title || !body) {
          await ref.update({
            status: 'failed',
            errorMessage: '제목/내용 누락',
            failedAt: FieldValue.serverTimestamp()
          });
          continue;
        }

        await broadcastAdminPushToAllUsers({
          title,
          body,
          targetEnv: d.targetEnv === 'production' || d.targetEnv === 'staging' ? d.targetEnv : 'all',
          data: { type: 'adminBroadcast', landingTab }
        });

        const scheduleType = d.scheduleType || 'once';
        if (scheduleType === 'recurring') {
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
              occurrenceCount: FieldValue.increment(1)
            });
            logger.info('processScheduledAdminPushes: recurring completed', { id: docSnap.id });
          } else {
            await ref.update({
              status: 'pending',
              scheduledAt: Timestamp.fromMillis(nextMs),
              lastSentAt: FieldValue.serverTimestamp(),
              occurrenceCount: FieldValue.increment(1)
            });
            logger.info('processScheduledAdminPushes: recurring next scheduled', { id: docSnap.id, nextMs });
          }
        } else {
          await ref.update({
            status: 'sent',
            sentAt: FieldValue.serverTimestamp()
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
    if (after.pushSentAt) return;

    const title = (after.title || '공지').trim();
    const body = noticePlainTextForPush(after.content || '');
    const payload = {
      title: `📢 ${title}`,
      body,
      data: { type: 'notice', noticeId: String(noticeId) }
    };

    try {
      await broadcastNoticePushToAllUsers(payload);
      await afterSnap.ref.set({ pushSentAt: FieldValue.serverTimestamp() }, { merge: true });
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
      if (n.lastDailyPushDate === todaySeoul) continue;

      const title = (n.title || '공지').trim();
      const body = noticePlainTextForPush(n.content || '');
      const payload = {
        title: `📢 ${title}`,
        body,
        data: { type: 'notice', noticeId: docSnap.id }
      };

      try {
        await broadcastNoticePushToAllUsers(payload);
        await docSnap.ref.set({ lastDailyPushDate: todaySeoul }, { merge: true });
        logger.info('scheduledNoticeDailyPush: ok', { noticeId: docSnap.id, todaySeoul });
      } catch (e) {
        logger.error('scheduledNoticeDailyPush failed', { noticeId: docSnap.id, message: e?.message });
      }
    }
  }
);
