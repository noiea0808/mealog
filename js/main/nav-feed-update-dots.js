/**
 * 하단 네비: 모먼트(신규 공유)·밀톡(신규 글) 우상단 빨간 점
 * — 서버 최신 1건 시각 vs localStorage의 「해당 메뉴(탭)에 들어간 시각」
 * — 점 제거: 새 글을 읽을 필요 없음. 모먼트/밀톡 하단 아이콘으로 그 메뉴에 들어가면 제거.
 *
 * Firestore reads 최소화: peek(모먼트 1 + 밀톡 1)는 로그인 직후·앱이 다시 포그라운드로 올 때만 실행.
 * (탭 전환·피드 로드마다 호출하지 않음)
 */
import { peekLatestSharedPhotoTimestampMs } from '../db/listeners.js';

const LS_MOMENT = 'mealog_nav_moment_seen_ms_';
const LS_BOARD = 'mealog_nav_board_seen_ms_';
/** visibility + pageshow가 연달아 올 때 한 번만 합치기 */
const FOREGROUND_DEBOUNCE_MS = 280;

let foregroundDebounceTimer = null;

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

function setDotVisible(tab, visible) {
    const id = tab === 'gallery' ? 'nav-gallery' : 'nav-board';
    const btn = document.getElementById(id);
    const dot = btn?.querySelector('.nav-feed-update-dot');
    if (!dot) return;
    dot.classList.toggle('hidden', !visible);
}

export function clearNavFeedUpdateDots() {
    setDotVisible('gallery', false);
    setDotVisible('board', false);
}

function applyBaselineAndCompare(uidKey, peekMoment, peekBoard) {
    const mk = LS_MOMENT + uidKey;
    const bk = LS_BOARD + uidKey;
    let mSeen = readSeen(mk);
    let bSeen = readSeen(bk);

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
        if (peekBoard > 0) {
            writeSeen(bk, peekBoard);
            bSeen = peekBoard;
        } else {
            const now = Date.now();
            writeSeen(bk, now);
            bSeen = now;
        }
    }

    const momentHasNew = peekMoment > mSeen;
    const boardHasNew = peekBoard > bSeen;
    setDotVisible('gallery', momentHasNew);
    setDotVisible('board', boardHasNew);
}

export async function refreshNavFeedUpdateDots() {
    const uk = storageUidKey();
    if (!uk || !window.currentUser) {
        clearNavFeedUpdateDots();
        return;
    }
    const [peekMoment, peekBoard] = await Promise.all([
        peekLatestSharedPhotoTimestampMs(),
        peekLatestBoardPostTimestampMs()
    ]);
    applyBaselineAndCompare(uk, peekMoment, peekBoard);
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

window.markMomentFeedNavSeen = markMomentFeedNavSeen;
window.markBoardNavSeen = markBoardNavSeen;
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
