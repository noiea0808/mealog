// 게시판 및 공지 관련 함수들
import { db, appId, callableFunctions } from '../firebase.js';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, query, orderBy, limit, where, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from '../ui.js';

// 게시판 관련 함수들
export const boardOperations = {
    // 게시글 작성 (Cloud Functions 사용 - 레이트 리밋 및 스팸 필터 적용)
    async createPost(postData) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            console.log('[boardOperations.createPost] 시작:', { title: postData.title, category: postData.category });
            const result = await callableFunctions.createBoardPost({
                title: postData.title,
                content: postData.content,
                category: postData.category || 'serious'
            });
            console.log('[boardOperations.createPost] 성공:', result.data);
            showToast("게시글이 등록되었습니다.", 'success');
            return result.data;
        } catch (e) {
            console.error("[boardOperations.createPost] 에러:", e);
            console.error("[boardOperations.createPost] 에러 상세:", {
                code: e.code,
                message: e.message,
                details: e.details,
                stack: e.stack
            });
            const errorMessage = e.message || e.details || e.code || "게시글 등록에 실패했습니다.";
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    
    // 익명 ID 가져오기 또는 생성 (사용자별 고정)
    async getAnonymousId(userId) {
        try {
            const userDoc = doc(db, 'artifacts', appId, 'boardUsers', userId);
            const userSnap = await getDoc(userDoc);
            
            // 사용자가 이미 익명 ID를 가지고 있는지 확인
            if (userSnap.exists()) {
                const userData = userSnap.data();
                if (userData && userData.anonymousId) {
                    return userData.anonymousId;
                }
            }
            
            // 새로운 익명 ID 생성
            const randomNum = Math.floor(Math.random() * 9999) + 1;
            const anonymousId = `익명${randomNum.toString().padStart(4, '0')}`;
            
            // 사용자 문서에 익명 ID 저장
            await setDoc(userDoc, {
                userId: userId,
                anonymousId: anonymousId,
                createdAt: new Date().toISOString()
            }, { merge: true });
            
            return anonymousId;
        } catch (e) {
            console.error("Get Anonymous ID Error:", e);
            // 에러 발생 시 임시 익명 ID 반환
            const randomNum = Math.floor(Math.random() * 9999) + 1;
            return `익명${randomNum.toString().padStart(4, '0')}`;
        }
    },
    
    // 게시글 목록 가져오기 (가려진 글 isHidden===true 제외, 클라이언트에서 필터)
    async getPosts(category = 'all', sortBy = 'latest', limitCount = 50) {
        try {
            const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
            const fetchLimit = Math.min(limitCount * 2, 100);
            let q;
            
            if (category === 'all') {
                q = query(postsColl, orderBy('timestamp', 'desc'), limit(fetchLimit));
            } else {
                q = query(
                    postsColl,
                    where('category', '==', category),
                    orderBy('timestamp', 'desc'),
                    limit(fetchLimit)
                );
            }
            
            const snapshot = await getDocs(q);
            let posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
                .filter(p => p.isHidden !== true);
            
            // timestamp 안전하게 변환하는 헬퍼 함수
            const getTimestamp = (post) => {
                if (!post.timestamp) return 0;
                if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
                    return post.timestamp.toDate().getTime();
                }
                if (typeof post.timestamp === 'string') {
                    return new Date(post.timestamp).getTime();
                }
                if (post.timestamp instanceof Date) {
                    return post.timestamp.getTime();
                }
                return new Date(post.timestamp || 0).getTime();
            };
            
            // 최신순 정렬 보장 (timestamp 기준 내림차순)
            posts.sort((a, b) => {
                const timeA = getTimestamp(a);
                const timeB = getTimestamp(b);
                return timeB - timeA; // 최신이 위로
            });
            
            posts = posts.slice(0, limitCount);
            
            // 인기순 정렬 (좋아요 - 비추천 수 기준)
            if (sortBy === 'popular') {
                posts.sort((a, b) => {
                    const scoreA = (a.likes || 0) - (a.dislikes || 0);
                    const scoreB = (b.likes || 0) - (b.dislikes || 0);
                    if (scoreB !== scoreA) return scoreB - scoreA;
                    // 점수가 같으면 최신순
                    const timeA = getTimestamp(a);
                    const timeB = getTimestamp(b);
                    return timeB - timeA;
                });
            }
            
            return posts;
        } catch (e) {
            console.error("Get Posts Error:", e);
            // 인덱스가 없을 경우 fallback: 전체 가져와서 클라이언트 측에서 필터링
            if (e.code === 'failed-precondition' || e.message?.includes('index')) {
                console.warn("Firestore 인덱스가 없어 fallback 모드로 작동합니다. 전체 게시글을 가져와 필터링합니다.");
                try {
                    const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
                    const fallbackQuery = query(postsColl, orderBy('timestamp', 'desc'), limit(limitCount * 2)); // 더 많이 가져와서 필터링
                    const snapshot = await getDocs(fallbackQuery);
                    let allPosts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    
                    // timestamp 안전하게 변환하는 헬퍼 함수
                    const getTimestamp = (post) => {
                        if (!post.timestamp) return 0;
                        if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
                            return post.timestamp.toDate().getTime();
                        }
                        if (typeof post.timestamp === 'string') {
                            return new Date(post.timestamp).getTime();
                        }
                        if (post.timestamp instanceof Date) {
                            return post.timestamp.getTime();
                        }
                        return new Date(post.timestamp || 0).getTime();
                    };
                    
                    // 카테고리 필터링
                    if (category !== 'all') {
                        allPosts = allPosts.filter(post => post.category === category);
                    }
                    
                    // 최신순 정렬 보장 (timestamp 기준 내림차순)
                    allPosts.sort((a, b) => {
                        const timeA = getTimestamp(a);
                        const timeB = getTimestamp(b);
                        return timeB - timeA; // 최신이 위로
                    });
                    
                    // limit 적용
                    allPosts = allPosts.slice(0, limitCount);
                    
                    // 인기순 정렬
                    if (sortBy === 'popular') {
                        allPosts.sort((a, b) => {
                            const scoreA = (a.likes || 0) - (a.dislikes || 0);
                            const scoreB = (b.likes || 0) - (b.dislikes || 0);
                            if (scoreB !== scoreA) return scoreB - scoreA;
                            const timeA = getTimestamp(a);
                            const timeB = getTimestamp(b);
                            return timeB - timeA;
                        });
                    }
                    
                    return allPosts;
                } catch (fallbackError) {
                    console.error("Fallback Get Posts Error:", fallbackError);
                    return [];
                }
            }
            return [];
        }
    },
    
    // 게시글 상세 가져오기
    async getPost(postId) {
        try {
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            
            if (!postSnap.exists()) {
                return null;
            }
            
            const postData = { id: postSnap.id, ...postSnap.data() };
            if (postData.isHidden === true) {
                return null;
            }
            const newViews = (postData.views || 0) + 1;
            
            // 조회수 증가
            await setDoc(postDoc, {
                views: newViews
            }, { merge: true });
            
            return { ...postData, views: newViews };
        } catch (e) {
            console.error("Get Post Error:", e);
            // 조회수 업데이트 실패해도 게시글은 반환
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            if (postSnap.exists()) {
                const data = { id: postSnap.id, ...postSnap.data() };
                if (data.isHidden === true) return null;
                return data;
            }
            return null;
        }
    },
    
    // 게시글 수정 (Cloud Functions 사용 - 스팸 필터 적용)
    async updatePost(postId, postData) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const result = await callableFunctions.updateBoardPost({
                postId,
                title: postData.title,
                content: postData.content,
                category: postData.category
            });
            showToast("게시글이 수정되었습니다.", 'success');
            return result.data.success;
        } catch (e) {
            console.error("Update Post Error:", e);
            const errorMessage = e.message || e.details || "게시글 수정에 실패했습니다.";
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    
    // 게시글 삭제 (Cloud Functions 사용)
    async deletePost(postId) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const result = await callableFunctions.deleteBoardPost({ postId });
            showToast("게시글이 삭제되었습니다.", 'success');
            return result.data.success;
        } catch (e) {
            console.error("Delete Post Error:", e);
            const errorMessage = e.message || e.details || "게시글 삭제에 실패했습니다.";
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    
    // 게시글 좋아요/비추천
    async toggleLike(postId, isLike = true) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const interactionsColl = collection(db, 'artifacts', appId, 'boardInteractions');
            const q = query(
                interactionsColl,
                where('postId', '==', postId),
                where('userId', '==', window.currentUser.uid)
            );
            const snapshot = await getDocs(q);
            
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            const postData = postSnap.exists() ? postSnap.data() : null;
            
            if (snapshot.empty) {
                // 새로 좋아요/비추천 추가
                await addDoc(interactionsColl, {
                    postId: postId,
                    userId: window.currentUser.uid,
                    isLike: isLike,
                    timestamp: new Date().toISOString()
                });
                
                // 게시글의 좋아요/비추천 수 업데이트
                if (isLike) {
                    await setDoc(postDoc, {
                        likes: (postData?.likes || 0) + 1
                    }, { merge: true });
                } else {
                    await setDoc(postDoc, {
                        dislikes: (postData?.dislikes || 0) + 1
                    }, { merge: true });
                }
            } else {
                const existingInteraction = snapshot.docs[0];
                const existingData = existingInteraction.data();
                
                if (existingData.isLike === isLike) {
                    // 같은 반응이면 제거
                    await deleteDoc(doc(db, 'artifacts', appId, 'boardInteractions', existingInteraction.id));
                    
                    if (isLike) {
                        await setDoc(postDoc, {
                            likes: Math.max(0, (postData?.likes || 0) - 1)
                        }, { merge: true });
                    } else {
                        await setDoc(postDoc, {
                            dislikes: Math.max(0, (postData?.dislikes || 0) - 1)
                        }, { merge: true });
                    }
                } else {
                    // 다른 반응이면 변경
                    await setDoc(doc(db, 'artifacts', appId, 'boardInteractions', existingInteraction.id), {
                        isLike: isLike,
                        timestamp: new Date().toISOString()
                    }, { merge: true });
                    
                    // 게시글의 좋아요/비추천 수 업데이트
                    if (isLike) {
                        await setDoc(postDoc, {
                            likes: (postData?.likes || 0) + 1,
                            dislikes: Math.max(0, (postData?.dislikes || 0) - 1)
                        }, { merge: true });
                    } else {
                        await setDoc(postDoc, {
                            likes: Math.max(0, (postData?.likes || 0) - 1),
                            dislikes: (postData?.dislikes || 0) + 1
                        }, { merge: true });
                    }
                }
            }
            
            return true;
        } catch (e) {
            console.error("Toggle Like Error:", e);
            throw e;
        }
    },
    
    // 사용자의 게시글 반응 확인
    async getUserReaction(postId, userId) {
        if (!userId) return null;
        try {
            const interactionsColl = collection(db, 'artifacts', appId, 'boardInteractions');
            const q = query(
                interactionsColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) return null;
            return snapshot.docs[0].data().isLike ? 'like' : 'dislike';
        } catch (e) {
            console.error("Get User Reaction Error:", e);
            return null;
        }
    },
    
    // 게시글 북마크 토글
    async toggleBookmark(postId) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'boardBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', window.currentUser.uid)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                await addDoc(bookmarksColl, {
                    postId,
                    userId: window.currentUser.uid,
                    timestamp: new Date().toISOString()
                });
                return { bookmarked: true };
            } else {
                await deleteDoc(doc(db, 'artifacts', appId, 'boardBookmarks', snapshot.docs[0].id));
                return { bookmarked: false };
            }
        } catch (e) {
            console.error("Toggle Board Bookmark Error:", e);
            throw e;
        }
    },
    
    // 본인이 좋아요한 게시글 ID 목록 (밀톡 흔적 필터용)
    async getPostIdsLikedByUser(userId) {
        if (!userId) return [];
        try {
            const interactionsColl = collection(db, 'artifacts', appId, 'boardInteractions');
            const q = query(
                interactionsColl,
                where('userId', '==', userId),
                where('isLike', '==', true)
            );
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get Board PostIds Liked By User Error:", e);
            return [];
        }
    },
    
    // 본인이 댓글 단 게시글 ID 목록 (밀톡 흔적 필터용)
    async getPostIdsCommentedByUser(userId) {
        if (!userId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'boardComments');
            const q = query(commentsColl, where('authorId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get Board PostIds Commented By User Error:", e);
            return [];
        }
    },
    
    // 본인이 북마크한 게시글 ID 목록 (밀톡 흔적 필터용)
    async getPostIdsBookmarkedByUser(userId) {
        if (!userId) return [];
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'boardBookmarks');
            const q = query(bookmarksColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get Board PostIds Bookmarked By User Error:", e);
            return [];
        }
    },
    
    // 사용자 북마크 여부 확인
    async isBookmarked(postId, userId) {
        if (!postId || !userId) return false;
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'boardBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Board Bookmarked Error:", e);
            return false;
        }
    },
    
    // 게시글 댓글 가져오기 (orderBy 제거 → 복합 인덱스 불필요, 클라이언트에서 정렬)
    async getComments(postId) {
        if (!postId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'boardComments');
            const q = query(commentsColl, where('postId', '==', String(postId)));
            const snapshot = await getDocs(q);
            const comments = snapshot.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    ...data,
                    content: data.content ?? data.text ?? ''
                };
            });
            
            // timestamp 안전하게 변환하는 헬퍼 함수
            const getCommentTimestamp = (comment) => {
                if (!comment.timestamp) return 0;
                if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') {
                    return comment.timestamp.toDate().getTime();
                }
                if (typeof comment.timestamp === 'string') {
                    return new Date(comment.timestamp).getTime();
                }
                if (comment.timestamp instanceof Date) {
                    return comment.timestamp.getTime();
                }
                return new Date(comment.timestamp || 0).getTime();
            };
            
            comments.sort((a, b) => {
                const tA = getCommentTimestamp(a);
                const tB = getCommentTimestamp(b);
                return tA - tB;
            });
            return comments;
        } catch (e) {
            console.error("Get Comments Error (boardComments):", e);
            return [];
        }
    },
    
    // 댓글 작성 (Cloud Functions 사용 - 레이트 리밋 및 스팸 필터 적용)
    async addComment(postId, content) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            console.log('[boardOperations.addComment] 시작:', { postId, contentLength: content?.length });
            const result = await callableFunctions.addBoardComment({
                postId,
                content
            });
            console.log('[boardOperations.addComment] 성공:', result.data);
            return result.data;
        } catch (e) {
            console.error("[boardOperations.addComment] 에러:", e);
            console.error("[boardOperations.addComment] 에러 상세:", {
                code: e.code,
                message: e.message,
                details: e.details,
                stack: e.stack
            });
            const errorMessage = e.message || e.details || e.code || "댓글 작성에 실패했습니다.";
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    
    // 댓글 삭제 (Cloud Functions 사용)
    async deleteComment(commentId, postId) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const result = await callableFunctions.deleteBoardComment({
                commentId,
                postId
            });
            return result.data.success;
        } catch (e) {
            console.error("Delete Comment Error:", e);
            const errorMessage = e.message || e.details || "댓글 삭제에 실패했습니다.";
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    
    // 게시판 리스너 설정 (실시간 업데이트)
    setupBoardListener(callback) {
        const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
        const q = query(postsColl, orderBy('timestamp', 'desc'), limit(50));
        
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            if (callback) callback(posts);
        }, (error) => {
            console.error("Board Listener Error:", error);
        });
        
        return unsubscribe;
    }
};

// 공지 관련 함수 (본문 조회, 좋아요/싫어요 - noticeInteractions 사용, notice 문서는 관리자만 쓰기 가능)
export const noticeOperations = {
    async getNotice(noticeId) {
        try {
            const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
            const snap = await getDoc(noticeDoc);
            if (!snap.exists()) return null;
            const d = snap.data();
            if (d.deleted === true) return null;
            return { id: snap.id, ...d };
        } catch (e) {
            console.error("Get Notice Error:", e);
            return null;
        }
    },
    async getNoticeReactionCounts(noticeId) {
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId));
            const snapshot = await getDocs(q);
            let likes = 0, dislikes = 0;
            snapshot.docs.forEach(d => {
                if (d.data().isLike === true) likes++;
                else dislikes++;
            });
            return { likes, dislikes };
        } catch (e) {
            console.error("Get Notice Reaction Counts Error:", e);
            return { likes: 0, dislikes: 0 };
        }
    },
    async getNoticeUserReaction(noticeId, userId) {
        if (!userId) return null;
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', userId));
            const snapshot = await getDocs(q);
            if (snapshot.empty) return null;
            return snapshot.docs[0].data().isLike ? 'like' : 'dislike';
        } catch (e) {
            console.error("Get Notice User Reaction Error:", e);
            return null;
        }
    },
    async toggleNoticeLike(noticeId, isLike = true) {
        if (!window.currentUser) throw new Error("로그인이 필요합니다.");
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', window.currentUser.uid));
            const snapshot = await getDocs(q);
            if (snapshot.empty) {
                await addDoc(coll, {
                    noticeId,
                    userId: window.currentUser.uid,
                    isLike: !!isLike,
                    timestamp: new Date().toISOString()
                });
            } else {
                const ref = snapshot.docs[0].ref;
                const data = snapshot.docs[0].data();
                if (data.isLike === isLike) {
                    await deleteDoc(ref);
                } else {
                    await setDoc(ref, { isLike: !!isLike, timestamp: new Date().toISOString() }, { merge: true });
                }
            }
            return true;
        } catch (e) {
            console.error("Toggle Notice Like Error:", e);
            throw e;
        }
    },
    
    async toggleNoticeBookmark(noticeId) {
        if (!window.currentUser) throw new Error("로그인이 필요합니다.");
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeBookmarks');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', window.currentUser.uid));
            const snapshot = await getDocs(q);
            if (snapshot.empty) {
                await addDoc(coll, {
                    noticeId,
                    userId: window.currentUser.uid,
                    timestamp: new Date().toISOString()
                });
                return { bookmarked: true };
            } else {
                await deleteDoc(snapshot.docs[0].ref);
                return { bookmarked: false };
            }
        } catch (e) {
            console.error("Toggle Notice Bookmark Error:", e);
            throw e;
        }
    },
    
    async isNoticeBookmarked(noticeId, userId) {
        if (!noticeId || !userId) return false;
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeBookmarks');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Notice Bookmarked Error:", e);
            return false;
        }
    },
    
    async getNoticeIdsLikedByUser(userId) {
        if (!userId) return [];
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('userId', '==', userId), where('isLike', '==', true));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().noticeId).filter(Boolean))];
        } catch (e) {
            console.error("Get Notice Ids Liked By User Error:", e);
            return [];
        }
    }
};

// 관리자: MEAL TALK 게시글 삭제 (Firestore 규칙에서 isAdmin 체크)
export async function deleteBoardPostByAdmin(postId) {
    if (!postId) throw new Error("게시글 ID가 필요합니다.");
    const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
    const postSnap = await getDoc(postDoc);
    if (!postSnap.exists()) throw new Error("게시글을 찾을 수 없습니다.");
    await deleteDoc(postDoc);
}

// 관리자: MEAL TALK 게시글 가리기/가리기 해제 (Firestore 규칙에서 isAdmin 체크)
export async function setBoardPostHidden(postId, hidden) {
    if (!postId) throw new Error("게시글 ID가 필요합니다.");
    const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
    const postSnap = await getDoc(postDoc);
    if (!postSnap.exists()) throw new Error("게시글을 찾을 수 없습니다.");
    await updateDoc(postDoc, { isHidden: !!hidden });
}
