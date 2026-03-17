// 소셜 기능 (좋아요, 댓글, 북마크, 신고)
import { db, appId, auth, callableFunctions } from '../firebase.js';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, collection, addDoc, query, orderBy, where, getDocs, getDocsFromServer, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

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
    
    // 댓글 추가 (Cloud Functions 사용 - 레이트 리밋 및 스팸 필터 적용)
    async addComment(postId, userId, commentText, userProfile) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId || !commentText?.trim()) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            console.log('[postInteractions.addComment] 시작:', { postId, commentLength: commentText?.length });
            const result = await callableFunctions.addPostComment({
                postId,
                commentText,
                userNickname: userProfile?.nickname ?? undefined,
                userIcon: userProfile?.icon ?? undefined
            });
            console.log('[postInteractions.addComment] 성공:', result.data);
            return result.data;
        } catch (e) {
            console.error("[postInteractions.addComment] 에러:", e);
            console.error("[postInteractions.addComment] 에러 상세:", {
                code: e.code,
                message: e.message,
                details: e.details,
                stack: e.stack
            });
            const errorMessage = e.message || e.details || e.code || "댓글 작성에 실패했습니다.";
            throw new Error(errorMessage);
        }
    },
    
    // 댓글 목록 가져오기 (postId: canonical id, alternatePostIds: 예전에 문서 id로 저장된 댓글도 함께 조회)
    async getComments(postId, alternatePostIds = []) {
        if (!postId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const ids = [postId, ...(Array.isArray(alternatePostIds) ? alternatePostIds : [])].filter(Boolean);
            const uniqueIds = [...new Set(ids)].slice(0, 10); // Firestore 'in' 최대 10개
            const q = uniqueIds.length <= 1
                ? query(commentsColl, where('postId', '==', postId))
                : query(commentsColl, where('postId', 'in', uniqueIds));
            const snapshot = await getDocs(q);
            const byId = new Map();
            snapshot.docs.forEach(d => {
                const data = { id: d.id, ...d.data() };
                if (!byId.has(data.id)) byId.set(data.id, data);
            });
            const comments = [...byId.values()];
            const getCommentTimestamp = (c) => {
                if (!c.timestamp) return 0;
                if (c.timestamp.toDate && typeof c.timestamp.toDate === 'function') return c.timestamp.toDate().getTime();
                if (typeof c.timestamp === 'string') return new Date(c.timestamp).getTime();
                if (c.timestamp instanceof Date) return c.timestamp.getTime();
                return new Date(c.timestamp || 0).getTime();
            };
            comments.sort((a, b) => {
                const tA = getCommentTimestamp(a);
                const tB = getCommentTimestamp(b);
                return tA - tB || (String(a.id || '')).localeCompare(String(b.id || ''));
            });
            return comments;
        } catch (e) {
            console.error("Get Comments Error:", e);
            return [];
        }
    },
    
    // 댓글 삭제 (Cloud Functions 사용)
    async deleteComment(commentId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !commentId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const result = await callableFunctions.deletePostComment({
                commentId
            });
            return result.data.success;
        } catch (e) {
            console.error("Delete Comment Error:", e);
            const errorMessage = e.message || e.details || "댓글 삭제에 실패했습니다.";
            throw new Error(errorMessage);
        }
    },

    /** 내가 작성한 글(모먼트/갤러리)에 달린 댓글 목록: postId별 최신 댓글 시각·개수·썸네일 (알림용) */
    async getPostsWithCommentsForUser(ownerId) {
        const uid = String(ownerId || '').trim();
        if (!uid) return [];
        try {
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            const sharedQ = query(sharedColl, where('userId', '==', uid));
            let sharedSnap;
            try {
                sharedSnap = await getDocsFromServer(sharedQ);
            } catch (_) {
                sharedSnap = await getDocs(sharedQ);
            }
            const mySharedDocIds = new Set(sharedSnap.docs.map(d => d.id));
            const myEntryIds = new Set(sharedSnap.docs.map(d => String(d.data().entryId || '').trim()).filter(Boolean));
            const byEntryUserId = {};
            const byDocId = {};
            const byEntryId = {};
            const byGroupKey = {}; // 캡처 3종세트: postId가 groupKey 형식일 때 (daily_*, best_*, insight_*)
            const momentLabel = (data) => {
                // 캡처 3종세트: 공유 게시물 내 제목(기간포함)으로 표시
                const shareType = (data.type || '').trim();
                if (shareType === 'daily' && data.date) {
                    const d = new Date(data.date + 'T00:00:00');
                    const y = d.getFullYear();
                    const m = d.getMonth() + 1;
                    const day = d.getDate();
                    return `${y}년 ${m}월 ${day}일 하루소감`;
                }
                if (shareType === 'best' && data.periodText) {
                    const pt = (data.periodType || '주간').trim();
                    return `${data.periodText} ${pt} Best`;
                }
                if (shareType === 'insight' && data.dateRangeText) {
                    return `${data.dateRangeText} 밀당 참견`;
                }
                // 일반 식사 게시물
                const place = (data.place || '').trim();
                const menuDetail = (data.menuDetail || '').trim();
                if (menuDetail && place) return `${menuDetail} @ ${place}`;
                if (place) return place;
                if (menuDetail) return menuDetail;
                const mealType = (data.mealType || '').trim();
                if (mealType) return mealType;
                return '해당 게시물';
            };
            for (const d of sharedSnap.docs) {
                const data = d.data();
                const docId = d.id;
                const entryId = data.entryId;
                const docUserId = String(data.userId || '').trim();
                const photoUrl = data.photoUrl || null;
                const photoIndex = typeof data.photoIndex === 'number' ? data.photoIndex : 999;
                const label = momentLabel(data);
                byDocId[docId] = { photoUrl, label };
                if (entryId) {
                    const eid = String(entryId).trim();
                    if (!byEntryId[eid] || (typeof byEntryId[eid].photoIndex === 'number' && photoIndex < byEntryId[eid].photoIndex))
                        byEntryId[eid] = { photoUrl, photoIndex, label };
                }
                if (entryId && docUserId) {
                    const key = `${entryId}_${docUserId}`;
                    if (!byEntryUserId[key] || (typeof byEntryUserId[key].photoIndex === 'number' && photoIndex < byEntryUserId[key].photoIndex))
                        byEntryUserId[key] = { photoUrl, photoIndex, label };
                }
                // 캡처 3종세트: groupKey 형식으로도 저장 (알림 postId와 매칭)
                const shareType = (data.type || '').trim();
                if (shareType === 'daily' && data.date) {
                    const gk = `daily_${data.date}_${docUserId}`;
                    byGroupKey[gk] = { photoUrl, label };
                } else if (shareType === 'best') {
                    const gk = `best_${docId}_${docUserId}`;
                    byGroupKey[gk] = { photoUrl, label };
                } else if (shareType === 'insight' && data.dateRangeText) {
                    const gk = `insight_${String(data.dateRangeText).replace(/\s/g, '_')}_${docUserId}`;
                    byGroupKey[gk] = { photoUrl, label };
                }
            }

            // 알림용: 서버에 저장된 postOwnerId로 "내 글에 달린 댓글"만 쿼리 (구조 변경으로 확실히 동작)
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const commentsQ = query(commentsColl, where('postOwnerId', '==', uid));
            let snapshot;
            try {
                snapshot = await getDocsFromServer(commentsQ);
            } catch (_) {
                try {
                    snapshot = await getDocs(commentsQ);
                } catch (__) {
                    snapshot = { docs: [] };
                }
            }
            const byPost = {};
            for (const d of snapshot.docs) {
                const data = d.data();
                const postId = String(data.postId ?? '').trim();
                if (!postId) continue;
                let ts = 0;
                try {
                    const t = data.timestamp;
                    ts = t && (t.toDate ? t.toDate() : new Date(t)).getTime();
                    if (Number.isNaN(ts)) ts = 0;
                } catch (_) { ts = 0; }
                if (!byPost[postId]) byPost[postId] = { postId, lastCommentAt: 0, commentCount: 0, type: 'moment' };
                byPost[postId].commentCount += 1;
                if (ts > byPost[postId].lastCommentAt) byPost[postId].lastCommentAt = ts;
            }
            const list = Object.values(byPost);
            list.forEach(item => {
                const entry = byEntryUserId[item.postId];
                const docEntry = byDocId[item.postId];
                const entryOnly = byEntryId[item.postId];
                const groupEntry = byGroupKey[item.postId];
                item.thumbnailUrl = (entry && entry.photoUrl) || (docEntry && docEntry.photoUrl) || (groupEntry && groupEntry.photoUrl) || (entryOnly && entryOnly.photoUrl) || null;
                item.momentLabel = (entry && entry.label) || (docEntry && docEntry.label) || (groupEntry && groupEntry.label) || (entryOnly && entryOnly.label) || '해당 게시물';
            });
            return list.sort((a, b) => b.lastCommentAt - a.lastCommentAt);
        } catch (e) {
            console.error("Get Posts With Comments For User Error:", e);
            return [];
        }
    }
};

/**
 * 내 글(피드)에 달린 댓글 실시간 구독 — 변경 시에만 callback 호출 (알림 빨간점 갱신용)
 * @param {string} uid - 현재 사용자 uid
 * @param {() => void} callback - 댓글 추가/변경 시 호출 (디바운스는 호출 측에서 처리)
 * @returns {() => void} unsubscribe
 */
export function subscribeToMyPostComments(uid, callback) {
    const id = String(uid || '').trim();
    if (!id || !callback) return () => {};
    const commentsColl = collection(db, 'artifacts', appId, 'postComments');
    const q = query(commentsColl, where('postOwnerId', '==', id));
    return onSnapshot(q, (snap) => {
        if (snap.docChanges().length > 0) callback();
    });
}

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

// 게시물 신고 (Cloud Functions 사용 - 레이트 리밋 및 중복 신고 방지)
export async function submitReport(payload) {
    const currentUser = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : window.currentUser;
    if (!currentUser || currentUser.isAnonymous) {
        throw new Error("로그인이 필요합니다.");
    }
    const { targetGroupKey, reason, reasonOther } = payload;
    if (!targetGroupKey || !reason) {
        throw new Error("신고 대상과 사유가 필요합니다.");
    }
    try {
        const result = await callableFunctions.submitPostReport({
            targetGroupKey,
            reason,
            reasonOther
        });
        return result.data.reportId;
    } catch (e) {
        console.error("Submit Report Error:", e);
        const errorMessage = e.message || e.details || "신고에 실패했습니다.";
        throw new Error(errorMessage);
    }
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
