/**
 * 하단 네비: 모먼트(신규 공유)·라운지(신규) 아이콘 우상단 빨간 점
 * — 서버 최신 글 시각 vs localStorage의 「해당 메뉴(탭)에 들어간 시각」
 * — 점 제거: 새 글을 읽을 필요 없음. 모먼트/밀톡 하단 아이콘으로 그 메뉴에 들어가면 제거.
 *
 * **내 글은 새 글이 아니다.** seen 은 탭 진입 시각에만 찍히므로, 진입 이후 내가 올린
 * 글(공유·게시글·공지)은 항상 seen 보다 새 글로 판정돼 내 기기에 점이 켜졌다. 그래서
 * 모든 peek 은 현재 사용자의 글을 제외하고 「남의 최신 글」만 본다.
 *
 * Firestore reads: peek(모먼트 1 + 밀톡 1 + 게시판 ~20 + 공지 ~20)는 로그인 직후·앱 포그라운드 복귀·메인 탭 전환(디바운스)·밀톡 목록/게시판 목록 새로고침 직후에 실행.
 * 모먼트·밀톡은 최신 1건이 내 글일 때만 창을 6건으로 한 번 더 넓힌다(내가 방금 올린 직후에만 발생).
 * 실시간 리스너는 없음.
 */
import { peekLatestSharedPhotoTimestampMs } from '../db/listeners.js';
import { pokeNetworkLoop } from '../utils/network-loop.js';
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
const LS_BOARD_NOTICE = 'mealog_nav_board_notice_seen_ms_';
/** visibility + pageshow가 연달아 올 때 한 번만 합치기 */
const FOREGROUND_DEBOUNCE_MS = 280;

/**
 * 조회 실패 후 재시도. 「지금 온라인인가」를 판정하지 않는다 — network-loop.js 와 같은 이유로,
 * 그 지식은 모바일에서 정확할 수 없고 게이트로 쓰면 복구가 막힌다. 몇 번 더 찔러보고 그만둔다.
 * 포그라운드 복귀 때 어차피 다시 도므로 여기서 무한히 매달릴 이유가 없다.
 */
const PEEK_RETRY_MAX = 3;
const PEEK_RETRY_BASE_MS = 1500;

let foregroundDebounceTimer = null;
let peekRetryTimer = null;
let peekRetryCount = 0;
let _lastPeek = { moment: 0, feed: 0, board: 0, notice: 0 };

function clearFailureRetry() {
    if (peekRetryTimer) {
        clearTimeout(peekRetryTimer);
        peekRetryTimer = null;
    }
    peekRetryCount = 0;
}

function scheduleFailureRetry() {
    if (peekRetryTimer || peekRetryCount >= PEEK_RETRY_MAX) return;
    const delay = PEEK_RETRY_BASE_MS * Math.pow(2, peekRetryCount);
    peekRetryCount += 1;
    // 채널이 죽어 있을 수 있다는 힌트만 준다. 결과는 묻지 않는다.
    pokeNetworkLoop('nav-peek-failed');
    peekRetryTimer = setTimeout(() => {
        peekRetryTimer = null;
        refreshNavFeedUpdateDots().catch(() => {});
    }, delay);
}

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

/**
 * 공지 컬렉션은 작고(현재 5건) `timestamp` 가 전부 문자열이다. 여기에 Timestamp 타입
 * 공지가 하나라도 섞이면 `orderBy` 만으로는 **새 공지를 영영 못 본다** — 아래 참조.
 */
const NOTICE_PEEK_LIMIT = 20;

/**
 * 타임스탬프 타입이 섞인 컬렉션에서 진짜 최신 시각.
 *
 * Firestore 는 값을 비교하기 전에 **타입으로 먼저** 정렬한다 (… < Timestamp < String < …).
 * 그래서 한 컬렉션에 두 타입이 섞이면 `orderBy('timestamp','desc').limit(1)` 은 「가장 최근」이
 * 아니라 「문자열 중 가장 큰 것」을 돌려준다. 실측(2026-08-21) 결과 boardPosts 25건 중
 * 문자열 1건이 섞여 있었고, desc 첫 문서가 **다섯 중 가장 오래된 2026-01-24 글**이었다.
 *
 * 그래서 창을 넓게 받아 **클라이언트에서** 최댓값을 고른다. 목록 로더(loadSharedPhotosPage,
 * boardOperations.getPosts)가 이미 같은 이유로 클라이언트 정렬을 하고 있는데, peek 만
 * 그 보호 밖에 있었다.
 */
function maxTimestampMs(docs, toMs) {
    let best = 0;
    for (const d of docs) {
        const ms = toMs(d);
        if (Number.isFinite(ms) && ms > best) best = ms;
    }
    return best;
}

/** @returns {Promise<number|null>} 0 = 없음, null = 조회 실패(모름) */
async function peekLatestNoticeTimestampMs() {
    try {
        const uid = window.currentUser?.uid;
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const q = query(noticesColl, orderBy('timestamp', 'desc'), limit(NOTICE_PEEK_LIMIT));
        const snap = await getDocsFromServer(q);
        if (!snap.docs.length) return 0;
        /**
         * authorId 가 있는 공지는 작성한 관리자 본인에게는 새 글이 아니다.
         * 옛 공지에는 authorId 가 없어서(undefined) 필터에 걸리지 않는다 — 남의 글 취급이
         * 맞다(작성자 판별 불가면 점을 띄우는 쪽이 안전하고, 이미 본 글이면 seen 이 거른다).
         */
        const docs = snap.docs.filter((d) => !uid || d.data()?.authorId !== uid);
        return maxTimestampMs(docs, (d) => {
            const ts = d.data()?.timestamp;
            if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
            if (typeof ts === 'string') return new Date(ts).getTime();
            if (ts instanceof Date) return ts.getTime();
            return new Date(ts || 0).getTime();
        });
    } catch (e) {
        console.warn('peekLatestNoticeTimestampMs:', e?.message || e);
        return null;
    }
}

/** @returns {Promise<number|null>} 0 = 없음, null = 조회 실패(모름) */
async function peekLatestBoardPostTimestampMs() {
    if (!window.boardOperations?.getPosts) return 0;
    try {
        /**
         * 1건이 아니라 10건을 받는다. `getPosts` 는 `limitCount * 2` 만큼 서버에서 받아
         * 클라이언트 정렬을 하는데, 1건을 요청하면 그 창이 **2건**이라 문자열 타임스탬프
         * 문서가 두 개만 돼도 진짜 최신 글이 창 밖으로 밀려난다 (위 maxTimestampMs 참조).
         * 게시판은 25건짜리 컬렉션이라 창을 넓혀도 비용이 무의미하다.
         */
        const posts = await window.boardOperations.getPosts('all', 'latest', 10);
        if (!posts?.length) return 0;
        // 내 글 제외 — 방금 내가 쓴 글이 내 점을 켜지 않게
        const uid = window.currentUser?.uid;
        const others = uid ? posts.filter((p) => p?.authorId !== uid) : posts;
        if (!others.length) return 0;
        return maxTimestampMs(others, getBoardPostTsMs);
    } catch (e) {
        console.warn('peekLatestBoardPostTimestampMs:', e?.message || e);
        return null;
    }
}

function getFeedPostTsMs(post) {
    if (!post?.timestamp) return 0;
    if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') return post.timestamp.toDate().getTime();
    if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
    if (post.timestamp instanceof Date) return post.timestamp.getTime();
    return new Date(post.timestamp || 0).getTime();
}

/**
 * 최신 문서가 내 것일 때 남의 최신 글을 찾기 위해 넓히는 창 (listeners.js 모먼트 peek 과 동일한 발상).
 * 창 전부가 내 글이면 「남의 새 글 징후 없음」(0)으로 본다.
 */
const SELF_PEEK_WIDEN_LIMIT = 6;

/** @returns {Promise<number|null>} 0 = 남의 글 없음, null = 조회 실패(모름) */
async function peekLatestFeedPostTimestampMs() {
    if (!window.currentUser) return 0;
    try {
        const uid = window.currentUser.uid;
        const postsColl = collection(db, 'artifacts', appId, 'feedPosts');
        const snap = await getDocsFromServer(query(postsColl, orderBy('timestamp', 'desc'), limit(1)));
        if (!snap.docs.length) return 0;
        let docs = snap.docs;
        // 최신이 내 글이면(내가 방금 보낸 직후) 한 번만 창을 넓혀 남의 최신 글을 찾는다
        if (docs[0].data()?.authorId === uid) {
            const wide = await getDocsFromServer(
                query(postsColl, orderBy('timestamp', 'desc'), limit(SELF_PEEK_WIDEN_LIMIT))
            );
            docs = wide.docs;
        }
        const others = docs.filter((d) => d.data()?.authorId !== uid);
        if (!others.length) return 0;
        return maxTimestampMs(others, (d) => getFeedPostTsMs({ id: d.id, ...d.data() }));
    } catch (e) {
        console.warn('peekLatestFeedPostTimestampMs:', e?.message || e);
        return null;
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
    const id =
        subtab === 'board' ? 'boardSubtabBoard' : subtab === 'notice' ? 'boardSubtabNotice' : 'boardSubtabFeed';
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
    setBoardSubtabDotVisible('notice', false);
}

/** peek 결과 해석 — null/undefined 는 「조회 실패(모름)」, 숫자만 사실 */
function isKnownPeek(v) {
    return v !== null && v !== undefined && Number.isFinite(Number(v));
}

/**
 * 기준선이 아직 없을 때만 세운다.
 *
 * peek 이 「모름」이면 세우지 않는다. 실패한 순간의 Date.now() 를 기준선으로 박으면 그보다
 * 앞선 글은 전부 「이미 본 것」이 되어 점이 **영영** 안 뜬다 — 신규 사용자의 첫 실행이 앱 시작
 * 직후의 서버 조회 실패와 겹치면 그대로 굳었다(실측: App Check 토큰 직후 peek 3개 동시 실패).
 * 기준선은 한 번 쓰면 되돌릴 근거가 없으므로, 확실할 때만 쓴다.
 *
 * @returns {number|null} 확정된 기준선. null 이면 이번 회차는 비교하지 않는다.
 */
function ensureBaseline(key, seen, peek) {
    if (seen !== null) return seen;
    if (!isKnownPeek(peek)) return null;
    const base = Number(peek) > 0 ? Number(peek) : Date.now();
    writeSeen(key, base);
    return base;
}

/** @returns {boolean|null} null 이면 판단 불가 — 점 상태를 그대로 둔다 */
function compareDot(peek, seen) {
    if (!isKnownPeek(peek) || seen === null) return null;
    return Number(peek) > seen;
}

function applyDot(tab, hasNew) {
    if (hasNew === null) return;
    setDotVisible(tab, hasNew);
}

function applySubtabDot(subtab, hasNew) {
    if (hasNew === null) return;
    setBoardSubtabDotVisible(subtab, hasNew);
}

function applyBaselineAndCompare(uidKey, peekMoment, peekFeed, peekBoardPosts, peekNotice, peekBoardAny) {
    const mk = LS_MOMENT + uidKey;
    const bk = LS_BOARD + uidKey;
    const fk = LS_BOARD_FEED + uidKey;
    const pk = LS_BOARD_BOARD + uidKey;
    const nk = LS_BOARD_NOTICE + uidKey;

    const mSeen = ensureBaseline(mk, readSeen(mk), peekMoment);
    const bSeen = ensureBaseline(bk, readSeen(bk), peekBoardAny);
    const fSeen = ensureBaseline(fk, readSeen(fk), peekFeed);
    const pSeen = ensureBaseline(pk, readSeen(pk), peekBoardPosts);
    const nSeen = ensureBaseline(nk, readSeen(nk), peekNotice);

    applyDot('gallery', compareDot(peekMoment, mSeen));
    applyDot('board', compareDot(peekBoardAny, bSeen));
    applySubtabDot('feed', compareDot(peekFeed, fSeen));
    applySubtabDot('board', compareDot(peekBoardPosts, pSeen));
    applySubtabDot('notice', compareDot(peekNotice, nSeen));
}

export async function refreshNavFeedUpdateDots() {
    const uk = storageUidKey();
    if (!uk || !window.currentUser) {
        clearNavFeedUpdateDots();
        return;
    }
    const [peekMoment, peekFeed, peekBoardPosts, peekNotice] = await Promise.all([
        peekLatestSharedPhotoTimestampMs(),
        peekLatestFeedPostTimestampMs(),
        peekLatestBoardPostTimestampMs(),
        peekLatestNoticeTimestampMs()
    ]);
    // 셋 중 하나라도 모르면 라운지 전체 점은 판단하지 않는다 — 아는 것만으로 최댓값을 잡으면
    // 실제보다 낮은 기준선이 굳어 나중에 헛 점이 뜬다.
    const boardAllKnown = isKnownPeek(peekFeed) && isKnownPeek(peekBoardPosts) && isKnownPeek(peekNotice);
    const peekBoardAny = boardAllKnown
        ? Math.max(Number(peekFeed) || 0, Number(peekBoardPosts) || 0, Number(peekNotice) || 0)
        : null;

    // 직전에 알아낸 값은 유지한다 (실패를 0으로 덮어쓰지 않음)
    _lastPeek = {
        moment: isKnownPeek(peekMoment) ? Number(peekMoment) : _lastPeek.moment,
        feed: isKnownPeek(peekFeed) ? Number(peekFeed) : _lastPeek.feed,
        board: isKnownPeek(peekBoardPosts) ? Number(peekBoardPosts) : _lastPeek.board,
        notice: isKnownPeek(peekNotice) ? Number(peekNotice) : _lastPeek.notice
    };

    applyBaselineAndCompare(uk, peekMoment, peekFeed, peekBoardPosts, peekNotice, peekBoardAny);

    const anyFailed =
        !isKnownPeek(peekMoment) || !isKnownPeek(peekFeed) || !isKnownPeek(peekBoardPosts) || !isKnownPeek(peekNotice);
    if (anyFailed) scheduleFailureRetry();
    else peekRetryCount = 0;
}

function scheduleForegroundPeekRefresh() {
    clearTimeout(foregroundDebounceTimer);
    // 포그라운드 복귀는 새 기회다 — 지난 실패로 소진된 재시도 횟수를 되돌린다
    clearFailureRetry();
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

/** 밀톡-공지(서브탭) 진입 시 호출 */
export function markBoardNoticeSubtabSeen() {
    const uk = storageUidKey();
    if (!uk) return;
    writeSeen(LS_BOARD_NOTICE + uk, Date.now());
    setBoardSubtabDotVisible('notice', false);
}

window.markMomentFeedNavSeen = markMomentFeedNavSeen;
window.markBoardNavSeen = markBoardNavSeen;
window.markBoardFeedSubtabSeen = markBoardFeedSubtabSeen;
window.markBoardBoardSubtabSeen = markBoardBoardSubtabSeen;
window.markBoardNoticeSubtabSeen = markBoardNoticeSubtabSeen;
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
