const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { getMealDelta, mergeDeltaIntoDay, sanitizeDayEntry, computeStatsFromMeals } = require('./mealStats.js');
const { logger } = require('firebase-functions');

// Firebase Admin 초기화
initializeApp();
const db = getFirestore();
const auth = getAuth();

const APP_ID = 'mealog-r0';

// Functions 리전 설정 (us-central1로 변경 - 배포된 리전과 일치)
const REGION = 'us-central1';

// API 키 (params: .env 또는 배포 시 입력)
const geminiApiKey = defineString('GEMINI_API_KEY');
const kakaoRestApiKey = defineString('KAKAO_REST_API_KEY');

// 레이트 리밋 설정 (사용자당)
const RATE_LIMITS = {
  post: { perMinute: 3, perHour: 20 },        // 게시글: 분당 3개, 시간당 20개
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
  const postAuthorId = postDoc.exists && postDoc.data().authorId ? String(postDoc.data().authorId).trim() : '';

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
  const postAuthorId = postDoc.exists && postDoc.data().authorId ? String(postDoc.data().authorId).trim() : '';

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
        snackType: (mealData && mealData.snackType) || '',
        date: (mealData && mealData.date) || '',
        slotId: (mealData && mealData.slotId) || '',
        time: (mealData && mealData.time) || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
        timestamp: FieldValue.serverTimestamp(),
        entryId: (mealData && mealData.id) || null
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

    const emptyDayTemplate = { count: 0, mainCount: 0, snackCount: 0, main: { mealType: {}, category: {}, withWhom: {}, rating: {}, satiety: {} }, snack: { place: {}, snackType: {}, rating: {} } };

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
 * 관리자 사용자 삭제 요청 처리 (Firestore 문서 생성 시 트리거)
 * deleteUserRequests/{requestId} 문서가 생성되면 requestedBy가 관리자인지 확인 후 Auth 사용자 삭제
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
    const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(String(userId));
    try {
      await auth.deleteUser(String(userId));
      logger.info('onDeleteUserRequest: user deleted', { userId, requestedBy });
    } catch (err) {
      if (err.code !== 'auth/user-not-found') {
        logger.error('onDeleteUserRequest: deleteUser failed', { userId, err: err.message });
        return;
      }
      logger.info('onDeleteUserRequest: user already gone in Auth', { userId });
    }
    try {
      await userRef.delete();
      logger.info('onDeleteUserRequest: Firestore user doc deleted', { userId });
    } catch (e) {
      logger.warn('onDeleteUserRequest: Firestore user doc delete failed (may not exist)', { userId, err: e.message });
    }
    await snap.ref.delete();
  }
);

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
    const userId = auth.uid;
    const mealsRef = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(userId)
      .collection('meals');
    const statsYearsRef = db.collection('artifacts').doc(APP_ID)
      .collection('users').doc(userId)
      .collection('config').doc('stats')
      .collection('years');

    const snapshot = await mealsRef.get();
    const meals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    const daily = computeStatsFromMeals(meals);

    // 연도별로 그룹화
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

    const totalDays = Object.keys(daily).length;
    logger.info('backfillUserStats: completed', { userId, mealCount: meals.length, dayCount: totalDays, years: Object.keys(dailyByYear) });
    return { success: true, mealCount: meals.length, dayCount: totalDays, years: Object.keys(dailyByYear) };
  })
);

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
  const apiKey = kakaoRestApiKey.value();
  if (!apiKey) {
    throw new HttpsError('failed-precondition', 'KAKAO_REST_API_KEY가 설정되지 않았습니다. functions/.env 파일에 KAKAO_REST_API_KEY를 추가하거나, 배포 시 입력 후 재배포하세요.');
  }
  const query = encodeURIComponent(keyword.trim());
  const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${query}&category_group_code=FD6&size=15`;
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
      const userRef = db.collection('artifacts').doc(APP_ID).collection('users').doc(String(userId));
      try {
        await auth.deleteUser(String(userId));
        logger.info('processDeleteUserRequests: user deleted from Auth', { userId, requestedBy });
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
      try {
        await userRef.delete();
        logger.info('processDeleteUserRequests: Firestore user doc deleted', { userId });
      } catch (e) {
        logger.warn('processDeleteUserRequests: Firestore user doc delete failed', { userId, err: e.message });
      }
      processed++;
      await docSnap.ref.delete();
    }
    return { processed, failed, total: snapshot.size, errors: errors.length ? errors : undefined };
  }
);
