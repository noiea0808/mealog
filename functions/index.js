const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

// Firebase Admin 초기화
initializeApp();
const db = getFirestore();

const APP_ID = 'mealog-r0';

// Functions 리전 설정 (us-central1로 변경 - 배포된 리전과 일치)
const REGION = 'us-central1';

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

  const { title, content, category } = data;
  
  if (!title || !content || !title.trim() || !content.trim()) {
    throw new HttpsError('invalid-argument', '제목과 내용을 입력해주세요.');
  }

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

  const { postId, title, content, category } = data;
  
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

  // 댓글 생성
  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('boardComments');
  const newComment = {
    postId: String(postId),
    content: content.trim(),
    authorId: auth.uid,
    authorNickname,
    authorPhotoUrl,
    authorIcon,
    timestamp: FieldValue.serverTimestamp()
  };

  const docRef = await commentsRef.add(newComment);

  // 게시글의 댓글 수 증가
  const postRef = db.collection('artifacts').doc(APP_ID).collection('boardPosts').doc(postId);
  const postDoc = await postRef.get();
  if (postDoc.exists) {
    await postRef.update({
      comments: FieldValue.increment(1)
    });
  }

  return { id: docRef.id, ...newComment, timestamp: new Date().toISOString() };
}));

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

  const { postId, commentText } = data;
  
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

  // 사용자 프로필 정보 가져오기
  const userSettingsRef = db.collection('artifacts').doc(APP_ID)
    .collection('users').doc(auth.uid)
    .collection('config').doc('settings');
  const userSettingsDoc = await userSettingsRef.get();
  
  const profile = userSettingsDoc.exists ? (userSettingsDoc.data().profile || {}) : {};
  const userNickname = profile.nickname || '익명';
  const userIcon = profile.icon || '🐻';

  // 댓글 생성
  const commentsRef = db.collection('artifacts').doc(APP_ID).collection('postComments');
  const commentData = {
    postId,
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

      // record.sharedPhotos 필드 업데이트 (mealData.id가 있는 경우에만)
      if (mealData && mealData.id) {
        try {
          const mealDoc = db.collection('artifacts').doc(APP_ID)
            .collection('users').doc(auth.uid)
            .collection('meals').doc(mealData.id);
          await mealDoc.set({ sharedPhotos: [] }, { merge: true });
        } catch (e) {
          logger.warn('record.sharedPhotos 필드 업데이트 실패:', e);
        }
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

    // 새로운 사진들을 추가
    photosToShare.forEach(photoUrl => {
      const docRef = sharedColl.doc();
      batch.set(docRef, {
        photoUrl,
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

    // record.sharedPhotos 필드 업데이트 (mealData.id가 있는 경우에만)
    if (mealData && mealData.id) {
      try {
        const mealDoc = db.collection('artifacts').doc(APP_ID)
          .collection('users').doc(auth.uid)
          .collection('meals').doc(mealData.id);
        await mealDoc.set({ sharedPhotos: photosToShare }, { merge: true });
      } catch (e) {
        logger.warn('record.sharedPhotos 필드 업데이트 실패:', e);
      }
    }

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

  // 레이트 리밋 체크
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

  // 레이트 리밋 체크
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

  // 레이트 리밋 체크
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
  const query = await sharedColl.where('userId', '==', auth.uid).get();
  
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
