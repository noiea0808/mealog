// 소셜 기능 (좋아요, 댓글, 북마크, 신고)
import { db, appId, auth } from '../firebase.js';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, collection, addDoc, query, orderBy, where, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// 좋아요, 댓글, 북마크 관련 함수들
export const postInteractions = {
    // 좋아요 추가/제거
    async toggleLike(postId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(
                likesColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                // 좋아요 추가
                await addDoc(likesColl, {
                    postId,
                    userId,
                    timestamp: new Date().toISOString()
                });
                return { liked: true };
            } else {
                // 좋아요 제거
                const docId = snapshot.docs[0].id;
                await deleteDoc(doc(db, 'artifacts', appId, 'postLikes', docId));
                return { liked: false };
            }
        } catch (e) {
            console.error("Toggle Like Error:", e);
            throw e;
        }
    },
    
    // 좋아요 목록 가져오기 (특정 포스트)
    async getLikes(postId) {
        if (!postId) return [];
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            // 인덱스 요구를 피하기 위해 orderBy 없이 조회 후 클라이언트 정렬
            const q = query(likesColl, where('postId', '==', postId));
            const snapshot = await getDocs(q);
            const likes = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            likes.sort((a, b) => {
                const timeA = new Date(a.timestamp || 0).getTime();
                const timeB = new Date(b.timestamp || 0).getTime();
                return timeB - timeA;
            });
            return likes;
        } catch (e) {
            console.error("Get Likes Error:", e);
            return [];
        }
    },
    
    // 사용자가 좋아요 했는지 확인
    async isLiked(postId, userId) {
        if (!postId || !userId) return false;
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(
                likesColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Liked Error:", e);
            return false;
        }
    },
    
    // 북마크 추가/제거
    async toggleBookmark(postId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                // 북마크 추가
                await addDoc(bookmarksColl, {
                    postId,
                    userId,
                    timestamp: new Date().toISOString()
                });
                return { bookmarked: true };
            } else {
                // 북마크 제거
                const docId = snapshot.docs[0].id;
                await deleteDoc(doc(db, 'artifacts', appId, 'postBookmarks', docId));
                return { bookmarked: false };
            }
        } catch (e) {
            console.error("Toggle Bookmark Error:", e);
            throw e;
        }
    },
    
    // 사용자가 북마크 했는지 확인
    async isBookmarked(postId, userId) {
        if (!postId || !userId) return false;
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Bookmarked Error:", e);
            return false;
        }
    },
    
    // 본인이 좋아요한 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsLikedByUser(userId) {
        if (!userId) return [];
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(likesColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Liked By User Error:", e);
            return [];
        }
    },
    
    // 본인이 북마크한 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsBookmarkedByUser(userId) {
        if (!userId) return [];
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(bookmarksColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Bookmarked By User Error:", e);
            return [];
        }
    },
    
    // 본인이 댓글 단 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsCommentedByUser(userId) {
        if (!userId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const q = query(commentsColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Commented By User Error:", e);
            return [];
        }
    },
    
    // 댓글 추가
    async addComment(postId, userId, commentText, userProfile) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId || !commentText?.trim()) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const commentData = {
                postId,
                userId,
                userNickname: userProfile?.nickname || '익명',
                userIcon: userProfile?.icon || '🐻',
                comment: commentText.trim(),
                timestamp: new Date().toISOString()
            };
            const docRef = await addDoc(commentsColl, commentData);
            return { id: docRef.id, ...commentData };
        } catch (e) {
            console.error("Add Comment Error:", e);
            throw e;
        }
    },
    
    // 댓글 목록 가져오기
    async getComments(postId) {
        if (!postId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            // 인덱스 요구를 피하기 위해 orderBy 없이 조회 후 클라이언트 정렬
            const q = query(commentsColl, where('postId', '==', postId));
            const snapshot = await getDocs(q);
            const comments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            comments.sort((a, b) => {
                const timeA = new Date(a.timestamp || 0).getTime();
                const timeB = new Date(b.timestamp || 0).getTime();
                return timeA - timeB;
            });
            return comments;
        } catch (e) {
            console.error("Get Comments Error:", e);
            return [];
        }
    },
    
    // 댓글 삭제
    async deleteComment(commentId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !commentId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            // 본인 댓글인지 확인
            const commentRef = doc(db, 'artifacts', appId, 'postComments', commentId);
            const commentSnap = await getDocs(query(
                collection(db, 'artifacts', appId, 'postComments'),
                where('userId', '==', userId)
            ));
            
            // 해당 commentId를 가진 댓글이 있는지 확인
            const targetComment = commentSnap.docs.find(d => d.id === commentId);
            if (targetComment) {
                await deleteDoc(commentRef);
                return true;
            }
            return false;
        } catch (e) {
            console.error("Delete Comment Error:", e);
            // 직접 삭제 시도 (권한 체크는 Firestore 규칙에서 처리)
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'postComments', commentId));
                return true;
            } catch (deleteError) {
                console.error("직접 삭제 실패:", deleteError);
                throw e;
            }
        }
    }
};

// 현재 사용자가 해당 게시물을 이미 신고했는지 조회 (있으면 { id, reason, reasonOther } 반환)
// postReports read 권한 이슈 회피: 사용자 자신의 config/reportedPosts 문서에서 조회
export async function getUserReportForPost(targetGroupKey, userId) {
    if (!targetGroupKey || !userId) return null;
    const ref = doc(db, 'artifacts', appId, 'users', userId, 'config', 'reportedPosts');
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const entry = snap.data()[targetGroupKey];
    if (!entry || !entry.reportId) return null;
    return { id: entry.reportId, reason: entry.reason, reasonOther: entry.reasonOther };
}

// 게시물 신고 (이미 신고한 경우 throw)
export async function submitReport(payload) {
    const currentUser = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : window.currentUser;
    if (!currentUser || currentUser.isAnonymous) {
        throw new Error("로그인이 필요합니다.");
    }
    const { targetGroupKey, reason, reasonOther } = payload;
    if (!targetGroupKey || !reason) {
        throw new Error("신고 대상과 사유가 필요합니다.");
    }
    const existing = await getUserReportForPost(targetGroupKey, currentUser.uid);
    if (existing) {
        throw new Error("이미 신고한 게시물입니다.");
    }
    const reportsColl = collection(db, 'artifacts', appId, 'postReports');
    const reasonOtherVal = (reason === 'other' && reasonOther && String(reasonOther).trim()) ? String(reasonOther).trim() : undefined;
    const data = {
        targetGroupKey,
        reason,
        reportedBy: currentUser.uid,
        reportedAt: new Date().toISOString()
    };
    if (reasonOtherVal) data.reasonOther = reasonOtherVal;
    const reportRef = await addDoc(reportsColl, data);
    // 본인 config/reportedPosts에 기록 (getUserReportForPost에서 조회, postReports read 권한 불필요)
    const userReportedRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'reportedPosts');
    await setDoc(userReportedRef, { [targetGroupKey]: { reportId: reportRef.id, reason, reasonOther: reasonOtherVal || null } }, { merge: true });
    return reportRef.id;
}

// 신고 취소 (본인이 신고한 문서만 삭제 가능, 규칙에서 검증. targetGroupKey로 config/reportedPosts에서도 제거)
export async function withdrawReport(reportId, targetGroupKey) {
    const currentUser = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : window.currentUser;
    if (!currentUser || currentUser.isAnonymous) {
        throw new Error("로그인이 필요합니다.");
    }
    if (!reportId) throw new Error("취소할 신고가 없습니다.");
    const reportRef = doc(db, 'artifacts', appId, 'postReports', reportId);
    await deleteDoc(reportRef);
    if (targetGroupKey) {
        const userReportedRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'reportedPosts');
        await updateDoc(userReportedRef, { [targetGroupKey]: deleteField() });
    }
}

// 관리자: targetGroupKey별 신고 집계 (전체 조회 후 메모리에서 집계)
export async function getReportsAggregateByGroupKeys() {
    const reportsColl = collection(db, 'artifacts', appId, 'postReports');
    const snapshot = await getDocs(reportsColl);
    const byKey = {};
    snapshot.docs.forEach(d => {
        const { targetGroupKey, reason, reasonOther } = d.data();
        if (!targetGroupKey) return;
        if (!byKey[targetGroupKey]) {
            byKey[targetGroupKey] = { count: 0, byReason: {} };
        }
        byKey[targetGroupKey].count += 1;
        const reasonLabel = reason === 'other' && reasonOther ? `기타: ${reasonOther}` : reason;
        byKey[targetGroupKey].byReason[reasonLabel] = (byKey[targetGroupKey].byReason[reasonLabel] || 0) + 1;
    });
    return byKey;
}
