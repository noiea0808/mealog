/**
 * 하단 네비: 모먼트(신규 공유)·라운지(신규) 아이콘 우상단 빨간 점
 * — 서버 최신 1건 시각 vs localStorage의 「해당 메뉴(탭)에 들어간 시각」
 * — 점 제거: 새 글을 읽을 필요 없음. 모먼트/밀톡 하단 아이콘으로 그 메뉴에 들어가면 제거.
 *
 * Firestore reads: peek(모먼트 1 + 밀톡 1 + 게시판 1)는 로그인 직후·앱 포그라운드 복귀·메인 탭 전환(디바운스)·밀톡 목록/게시판 목록 새로고침 직후에 실행.
 * 실시간 리스너는 없음.
 */
import { peekLatestSharedPhotoTimestampMs } from '../db/listeners.js';
import { db, appId } from '../firebase.js';
import {
    collection,
    query,
    orderBy,
    limit,
    getDocsFromServer
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const LS_MOMENT = 'mealog_nav_moment_seen_ms_';
const LS_BOARD = 'mealog_nav_board_seen_ms_';
const LS_BOARD_FEED = 'mealog_nav_board_feed_seen_ms_';
const LS_BOARD_BOARD = 'mealog_nav_board_board_seen_ms_';
/** visibility + pageshow가 연달아 올 때 한 번만 합치기 */
const FOREGROUND_DEBOUNCE_MS = 280;

let foregroundDebounceTimer = null;
let _lastPeek = { moment: 0, feed: 0, board: 0 };

function storageUidKey() {
    const u = window.currentUser;
    if (!u?.uid) return null;
    return u.isAnonymous ? `anon_${u.uid}` : u.uid;
}

function readSeen(fullKey) {
    try {
        const v = localStorage.getItem(fullKey);
        if (v == null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    } catch (_) {
        return null;
    }
}

function writeSeen(fullKey, ms) {
    try {
        localStorage.setItem(fullKey, String(ms));
    } catch (_) {}
}

function getBoardPostTsMs(post) {
    if (!post?.timestamp) return 0;
    if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
        return post.timestamp.toDate().getTime();
    }
    if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
    if (post.timestamp instanceof Date) return post.timestamp.getTime();
    return new Date(post.timestamp || 0).getTime();
}

async function peekLatestBoardPostTimestampMs() {
    if (!window.boardOperations?.getPosts) return 0;
    try {
        const posts = await window.boardOperations.getPosts('all', 'latest', 1);
        if (!posts?.length) return 0;
        return getBoardPostTsMs(posts[0]);
    } catch (e) {
        console.warn('peekLatestBoardPostTimestampMs:', e?.message || e);
        return 0;
    }
}

function getFeedPostTsMs(post) {
    if (!post?.timestamp) return 0;
    if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') return post.timestamp.toDate().getTime();
    if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
    if (post.timestamp instanceof Date) return post.timestamp.getTime();
    return new Date(post.timestamp || 0).getTime();
}

async function peekLatestFeedPostTimestampMs() {
    if (!window.currentUser) return 0;
    try {
        const postsColl = collection(db, 'artifacts', appId, 'feedPosts');
        const q = query(postsColl, orderBy('timestamp', 'desc'), limit(1));
        const snap = await getDocsFromServer(q);
        if (!snap.docs.length) return 0;
        const post = { id: snap.docs[0].id, ...snap.docs[0].data() };
        return getFeedPostTsMs(post);
    } catch (e) {
        console.warn('peekLatestFeedPostTimestampMs:', e?.message || e);
        return 0;
    }
}

function setDotVisible(tab, visible) {
    const id = tab === 'gallery' ? 'nav-gallery' : 'nav-board';
    const btn = document.getElementById(id);
    const dot = btn?.querySelector('.nav-feed-update-dot');
    if (!dot) return;
    dot.classList.toggle('hidden', !visible);
}

function setBoardSubtabDotVisible(subtab, visible) {
    const id = subtab === 'board' ? 'boardSubtabBoard' : 'boardSubtabFeed';
    const btn = document.getElementById(id);
    const dot = btn?.querySelector('.board-subtab-update-dot');
    if (!dot) return;
    dot.classList.toggle('hidden', !visible);
}

export function clearNavFeedUpdateDots() {
    setDotVisible('gallery', false);
    setDotVisible('board', false);
    setBoardSubtabDotVisible('feed', false);
    setBoardSubtabDotVisible('board', false);
}

function applyBaselineAndCompare(uidKey, peekMoment, peekFeed, peekBoardPosts, peekBoardAny) {
    const mk = LS_MOMENT + uidKey;
    const bk = LS_BOARD + uidKey;
    const fk = LS_BOARD_FEED + uidKey;
    const pk = LS_BOARD_BOARD + uidKey;
    let mSeen = readSeen(mk);
    let bSeen = readSeen(bk);
    let fSeen = readSeen(fk);
    let pSeen = readSeen(pk);

    if (mSeen === null) {
        if (peekMoment > 0) {
            writeSeen(mk, peekMoment);
            mSeen = peekMoment;
        } else {
            const now = Date.now();
            writeSeen(mk, now);
            mSeen = now;
        }
    }
    if (bSeen === null) {
        if (peekBoardAny > 0) {
            writeSeen(bk, peekBoardAny);
            bSeen = peekBoardAny;
        } else {
            const now = Date.now();
            writeSeen(bk, now);
            bSeen = now;
        }
    }
    if (fSeen === null) {
        if (peekFeed > 0) {
            writeSeen(fk, peekFeed);
            fSeen = peekFeed;
        } else {
            const now = Date.now();
            writeSeen(fk, now);
            fSeen = now;
        }
    }
    if (pSeen === null) {
        if (peekBoardPosts > 0) {
            writeSeen(pk, peekBoardPosts);
            pSeen = peekBoardPosts;
        } else {
            const now = Date.now();
            writeSeen(pk, now);
            pSeen = now;
        }
    }

    const momentHasNew = peekMoment > mSeen;
    const boardHasNew = peekBoardAny > bSeen;
    const feedHasNew = peekFeed > fSeen;
    const boardPostsHasNew = peekBoardPosts > pSeen;
    setDotVisible('gallery', momentHasNew);
    setDotVisible('board', boardHasNew);
    setBoardSubtabDotVisible('feed', feedHasNew);
    setBoardSubtabDotVisible('board', boardPostsHasNew);
}

export async function refreshNavFeedUpdateDots() {
    const uk = storageUidKey();
    if (!uk || !window.currentUser) {
        clearNavFeedUpdateDots();
        return;
    }
    const [peekMoment, peekFeed, peekBoardPosts] = await Promise.all([
        peekLatestSharedPhotoTimestampMs(),
        peekLatestFeedPostTimestampMs(),
        peekLatestBoardPostTimestampMs()
    ]);
    const peekBoardAny = Math.max(Number(peekFeed) || 0, Number(peekBoardPosts) || 0);
    _lastPeek = { moment: Number(peekMoment) || 0, feed: Number(peekFeed) || 0, board: Number(peekBoardPosts) || 0 };
    applyBaselineAndCompare(uk, _lastPeek.moment, _lastPeek.feed, _lastPeek.board, peekBoardAny);
}

function scheduleForegroundPeekRefresh() {
    clearTimeout(foregroundDebounceTimer);
    foregroundDebounceTimer = setTimeout(() => {
        foregroundDebounceTimer = null;
        refreshNavFeedUpdateDots().catch(() => {});
    }, FOREGROUND_DEBOUNCE_MS);
}

/**
 * @deprecated 과거 호환용. 추가 Firestore 읽기를 하지 않음(포그라운드에서만 갱신).
 */
export function scheduleRefreshNavFeedUpdateDots() {}

/** 모먼트 탭(하단 아이콘)으로 진입했을 때 호출 — 메인/프로필 화면 무관 */
export function markMomentFeedNavSeen() {
    const uk = storageUidKey();
    if (!uk) return;
    writeSeen(LS_MOMENT + uk, Date.now());
    setDotVisible('gallery', false);
}

/** 밀톡 탭(하단 아이콘) 진입 시 호출 */
export function markBoardNavSeen() {
    const uk = storageUidKey();
    if (!uk) return;
    writeSeen(LS_BOARD + uk, Date.now());
    setDotVisible('board', false);
}

/** 밀톡-피드(서브탭) 진입 시 호출 */
export function markBoardFeedSubtabSeen() {
    const uk = storageUidKey();
    if (!uk) return;
    writeSeen(LS_BOARD_FEED + uk, Date.now());
    setBoardSubtabDotVisible('feed', false);
    // 전체 점은 "게시판쪽 새 글"이 남아있을 수 있으니 여기서 강제 제거하지 않음
}

/** 밀톡-게시판(서브탭) 진입 시 호출 */
export function markBoardBoardSubtabSeen() {
    const uk = storageUidKey();
    if (!uk) return;
    writeSeen(LS_BOARD_BOARD + uk, Date.now());
    setBoardSubtabDotVisible('board', false);
}

window.markMomentFeedNavSeen = markMomentFeedNavSeen;
window.markBoardNavSeen = markBoardNavSeen;
window.markBoardFeedSubtabSeen = markBoardFeedSubtabSeen;
window.markBoardBoardSubtabSeen = markBoardBoardSubtabSeen;
window.scheduleRefreshNavFeedUpdateDots = scheduleRefreshNavFeedUpdateDots;
window.refreshNavFeedUpdateDots = refreshNavFeedUpdateDots;
window.clearNavFeedUpdateDots = clearNavFeedUpdateDots;

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.currentUser) {
        scheduleForegroundPeekRefresh();
    }
});

window.addEventListener('pageshow', (e) => {
    if (window.currentUser && e.persisted) {
        scheduleForegroundPeekRefresh();
    }
});
