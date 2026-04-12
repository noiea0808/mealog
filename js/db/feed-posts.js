// 밀톡 피드 전용 — boardPosts와 분리 (게시판 목록·상세와 데이터 공유 안 함)
import { db, appId, callableFunctions, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collection,
    query,
    orderBy,
    limit,
    startAfter,
    getDocs,
    getDocsFromServer,
    doc,
    getDoc,
    updateDoc,
    deleteDoc,
    setDoc,
    serverTimestamp,
    writeBatch
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { showToast } from '../ui.js';
import { isDemoUser } from '../demo-account.js';

/** 라운지 밀톡 탭에서 한 번에 불러오는 메시지 수 (Firestore 문서 읽기·반응 서브조회 배수에 직결) */
export const FEED_TIMELINE_BATCH_SIZE = 20;

const EMPTY_REACTION_COUNTS = { like: 0, thumbs: 0, check: 0 };

export async function attachReactionCountsToPosts(posts) {
    const list = Array.isArray(posts) ? posts : [];
    return Promise.all(
        list.map(async (p) => {
            if (!p || !p.id) return { ...p, reactionCounts: { ...EMPTY_REACTION_COUNTS } };
            try {
                const rcol = collection(db, 'artifacts', appId, 'feedPosts', p.id, 'reactions');
                const rsnap = await getDocs(rcol);
                const counts = { ...EMPTY_REACTION_COUNTS };
                rsnap.forEach((docSnap) => {
                    const t = docSnap.data()?.type;
                    if (t === 'like' || t === 'love') counts.like += 1;
                    else if (t === 'thumbs') counts.thumbs += 1;
                    else if (t === 'check') counts.check += 1;
                });
                return { ...p, reactionCounts: counts };
            } catch {
                return { ...p, reactionCounts: { ...EMPTY_REACTION_COUNTS } };
            }
        })
    );
}

function feedPostTimestampMs(post) {
    if (!post?.timestamp) return 0;
    if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
        return post.timestamp.toDate().getTime();
    }
    if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
    if (post.timestamp instanceof Date) return post.timestamp.getTime();
    return new Date(post.timestamp || 0).getTime();
}

function showFeedLoadErrorToast(code) {
    if (code === 'permission-denied') {
        showToast('밀톡을 불러올 권한이 없습니다. 다시 로그인해 주세요.', 'error');
    } else if (code === 'failed-precondition') {
        showToast('밀톡 목록을 불러오는 데 문제가 있습니다. 잠시 후 다시 시도해 주세요.', 'error');
    } else if (code === 'unavailable' || code === 'deadline-exceeded') {
        showToast('밀톡을 불러오지 못했습니다. 네트워크를 확인해 주세요.', 'error');
    }
}

export const feedOperations = {
    /** 최신순 페이지 조회. `cursorSnap`은 이 배치에서 가장 오래된 문서 스냅샷(다음 `startAfter`에 사용). */
    async getMessagesPage({ limitCount = FEED_TIMELINE_BATCH_SIZE, startAfterSnapshot = null } = {}) {
        try {
            const postsColl = collection(db, 'artifacts', appId, 'feedPosts');
            const lim = Math.min(limitCount, 100);
            const q = startAfterSnapshot
                ? query(postsColl, orderBy('timestamp', 'desc'), startAfter(startAfterSnapshot), limit(lim))
                : query(postsColl, orderBy('timestamp', 'desc'), limit(lim));
            let snapshot;
            try {
                snapshot = await getDocsFromServer(q);
            } catch (e) {
                if (e?.code === 'unavailable') {
                    snapshot = await getDocs(q);
                } else {
                    throw e;
                }
            }
            const list = snapshot.docs
                .map((d) => ({ id: d.id, ...d.data() }))
                .filter((p) => p && p.isHidden !== true);
            list.sort((a, b) => feedPostTimestampMs(b) - feedPostTimestampMs(a));
            const sliced = list.slice(0, limitCount);
            const posts = await attachReactionCountsToPosts(sliced);
            const cursorSnap = snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : null;
            const hasMore = snapshot.docs.length === lim;
            return { posts, cursorSnap, hasMore };
        } catch (e) {
            console.error('[feedOperations.getMessagesPage]', e);
            const code = e?.code || '';
            showFeedLoadErrorToast(code);
            return { posts: [], cursorSnap: null, hasMore: false };
        }
    },

    async getMessages(limitCount = FEED_TIMELINE_BATCH_SIZE) {
        const { posts } = await feedOperations.getMessagesPage({
            limitCount,
            startAfterSnapshot: null
        });
        return posts;
    },

    async createMessage({ text, imageUrls = [], replyToPostId = null }) {
        if (!window.currentUser) {
            throw new Error('로그인이 필요합니다.');
        }
        if (isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 메시지를 보낼 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        try {
            const rid =
                replyToPostId != null && String(replyToPostId).trim()
                    ? String(replyToPostId).trim()
                    : undefined;
            const payload = {
                text: typeof text === 'string' ? text : '',
                imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
                ...(rid ? { replyToPostId: rid } : {})
            };
            await refreshAppCheckTokenBeforeFirestore();
            let result;
            try {
                result = await callableFunctions.createFeedPost(payload);
            } catch (e1) {
                const m = String(e1?.message || e1?.details || '');
                if (
                    e1?.code === 'permission-denied' ||
                    e1?.code === 'functions/permission-denied' ||
                    /permission|app check|forbidden/i.test(m)
                ) {
                    await refreshAppCheckTokenBeforeFirestore();
                    await new Promise((r) => setTimeout(r, 400));
                    result = await callableFunctions.createFeedPost(payload);
                } else {
                    throw e1;
                }
            }
            showToast('메시지를 보냈어요.', 'success');
            return result.data;
        } catch (e) {
            console.error('[feedOperations.createMessage]', e);
            const errorMessage = e.message || e.details || e.code || '전송에 실패했습니다.';
            showToast(errorMessage, 'error');
            throw e;
        }
    },

    async updateMessageText(postId, text) {
        if (!window.currentUser) {
            showToast('로그인이 필요합니다.', 'error');
            throw new Error('auth');
        }
        if (isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 수정할 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        const id = String(postId || '').trim();
        if (!id) throw new Error('id');
        const plain = typeof text === 'string' ? text.trim() : '';
        if (plain.length > 280) {
            showToast('메시지는 280자 이하여야 합니다.', 'error');
            throw new Error('length');
        }
        try {
            const postRef = doc(db, 'artifacts', appId, 'feedPosts', id);
            const snap = await getDoc(postRef);
            if (!snap.exists()) {
                showToast('메시지를 찾을 수 없습니다.', 'error');
                throw new Error('missing');
            }
            const data = snap.data();
            if (data.authorId !== window.currentUser.uid) {
                showToast('본인 메시지만 수정할 수 있습니다.', 'error');
                throw new Error('denied');
            }
            const hasImgs = Array.isArray(data.imageUrls) && data.imageUrls.length > 0;
            if (!plain && !hasImgs) {
                showToast('내용을 입력해 주세요.', 'error');
                throw new Error('empty');
            }
            await updateDoc(postRef, {
                text: plain,
                content: plain,
                updatedAt: serverTimestamp()
            });
            showToast('수정했어요.', 'success');
        } catch (e) {
            if (e?.code === 'permission-denied') {
                showToast('수정할 권한이 없습니다.', 'error');
            } else if (e?.message && !['auth', 'length', 'missing', 'denied', 'empty'].includes(e.message)) {
                console.error('[feedOperations.updateMessageText]', e);
                showToast('수정에 실패했습니다.', 'error');
            }
            throw e;
        }
    },

    async deleteMessage(postId) {
        if (!window.currentUser) {
            showToast('로그인이 필요합니다.', 'error');
            throw new Error('auth');
        }
        if (isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 삭제할 수 없습니다.', 'error');
            throw new Error('read-only-demo');
        }
        const id = String(postId || '').trim();
        if (!id) throw new Error('id');
        try {
            const postRef = doc(db, 'artifacts', appId, 'feedPosts', id);
            const snap = await getDoc(postRef);
            if (!snap.exists()) {
                showToast('메시지를 찾을 수 없습니다.', 'error');
                throw new Error('missing');
            }
            if (snap.data().authorId !== window.currentUser.uid) {
                showToast('본인 메시지만 삭제할 수 있습니다.', 'error');
                throw new Error('denied');
            }
            await deleteDoc(postRef);
            showToast('삭제했어요.', 'success');
        } catch (e) {
            if (e?.code === 'permission-denied') {
                showToast('삭제할 권한이 없습니다.', 'error');
            } else if (e?.message && !['auth', 'missing', 'denied'].includes(e.message)) {
                console.error('[feedOperations.deleteMessage]', e);
                showToast('삭제에 실패했습니다.', 'error');
            }
            throw e;
        }
    },

    /** 좋아요 / 따봉 / 체크 — 사용자당 1개 (덮어쓰기) */
    async setFeedReaction(postId, type) {
        if (!window.currentUser || window.currentUser.isAnonymous) {
            showToast('로그인이 필요합니다.', 'error');
            throw new Error('auth');
        }
        if (isDemoUser(window.currentUser)) {
            showToast("샘플 계정에서는 반응을 보낼 수 없습니다.", 'error');
            throw new Error('read-only-demo');
        }
        const allowed = ['like', 'thumbs', 'check'];
        if (!allowed.includes(type)) throw new Error('type');
        const id = String(postId || '').trim();
        if (!id) throw new Error('id');
        try {
            const uid = window.currentUser.uid;
            const rRef = doc(db, 'artifacts', appId, 'feedPosts', id, 'reactions', uid);
            await setDoc(rRef, { type, updatedAt: serverTimestamp() }, { merge: true });
            showToast('반응을 보냈어요.', 'success');
        } catch (e) {
            console.error('[feedOperations.setFeedReaction]', e);
            if (e?.code === 'permission-denied') {
                showToast('반응을 보낼 수 없습니다.', 'error');
            } else {
                showToast('반응 전송에 실패했습니다.', 'error');
            }
            throw e;
        }
    }
};

async function deleteFeedPostReactionsClient(postId) {
    const pid = String(postId || '').trim();
    if (!pid) return;
    const rcol = collection(db, 'artifacts', appId, 'feedPosts', pid, 'reactions');
    const snap = await getDocs(rcol);
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 450) {
        const batch = writeBatch(db);
        docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
}

/** 관리자: 밀톡 대화 숨김/해제 (Firestore rules: isAdmin) */
export async function setFeedPostHiddenByAdmin(postId, hidden) {
    const id = String(postId || '').trim();
    if (!id) throw new Error('ID가 필요합니다.');
    const postRef = doc(db, 'artifacts', appId, 'feedPosts', id);
    const postSnap = await getDoc(postRef);
    if (!postSnap.exists()) throw new Error('메시지를 찾을 수 없습니다.');
    await updateDoc(postRef, { isHidden: !!hidden, updatedAt: serverTimestamp() });
}

/** 관리자: 밀톡 대화 삭제 (반응 하위 컬렉션 정리 후 본문 삭제) */
export async function deleteFeedPostByAdmin(postId) {
    const id = String(postId || '').trim();
    if (!id) throw new Error('ID가 필요합니다.');
    const postRef = doc(db, 'artifacts', appId, 'feedPosts', id);
    const postSnap = await getDoc(postRef);
    if (!postSnap.exists()) throw new Error('메시지를 찾을 수 없습니다.');
    await deleteFeedPostReactionsClient(id);
    await deleteDoc(postRef);
}
