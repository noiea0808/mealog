/**
 * 밀톡 게시판 목록·상세, 공지 목록·상세
 */
import { appState } from '../state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './utils.js';
import { getDisplayProfile, getProfileAvatarDisplay, SEOUL_LOCALE_OPTIONS } from '../utils.js';
import { getAdminDisplayName } from '../db.js';
import { fetchUserProfiles } from './user-profiles.js';
import { isDemoUser } from '../demo-account.js';
import {
    timestampToYmd,
    isYmdInRange,
    boardPostMatchesKeyword,
    noticeMatchesKeyword,
    formatBoardSearchSummary
} from '../board-search-filter.js';
import { scheduleLucideIcons } from '../icons.js';

/** 상세 본문: Soft Mint 타이포 + 목록과 동일 서식·줄바꿈 */
const BOARD_DETAIL_BODY_CLASS =
    'board-detail-body [&_b]:font-bold [&_strong]:font-bold [&_u]:underline [&_s]:line-through [&_strike]:line-through';

/** 게시판 카테고리 키 → 해시태그용 한글(# 제외) */
const BOARD_CATEGORY_TAG_LABELS = {
    serious: '무거운',
    chat: '가벼운',
    food: '먹는',
    admin: '치프에게'
};

/** 목록·상세: `#무거운` 등 (스타일은 `.lounge-tag` / `.board-category-hashtag`) */
function buildBoardCategoryTagsRow(category, opts = {}) {
    const { withPhotoTag = false } = opts;
    const key = category != null && category in BOARD_CATEGORY_TAG_LABELS ? category : 'serious';
    const label = BOARD_CATEGORY_TAG_LABELS[key];
    const parts = [`<span class="lounge-tag board-category-hashtag">${escapeHtml(`#${label}`)}</span>`];
    if (withPhotoTag) {
        parts.push('<span class="lounge-tag lounge-tag--muted board-category-hashtag">#사진있음</span>');
    }
    return `<div class="lounge-post-tags flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">${parts.join('')}</div>`;
}

function buildLoungeAuthorAvatarHtml(authorAvatar, profileOpen) {
    const hit = profileOpen
        ? ` class="lounge-avatar-hit shrink-0 cursor-pointer hover:opacity-90 active:opacity-80" onclick="${profileOpen}" role="button" tabindex="0"`
        : ' class="lounge-avatar-hit shrink-0" role="presentation" tabindex="-1"';
    if (authorAvatar.type === 'photo') {
        return `<div${hit}><div class="lounge-avatar" style="background-image:url('${escapeHtml(String(authorAvatar.value || ''))}')" role="img"></div></div>`;
    }
    return `<div${hit}><div class="lounge-avatar lounge-avatar--fallback">${escapeHtml(authorAvatar.value || '?')}</div></div>`;
}
// showToast는 onclick 문자열(인라인)에서 window.showToast를 사용 (main.js에서 전역 바인딩됨)

/** 구 데이터 `title` 필드 — 새 글은 빈 문자열, 기존 글은 본문 위에 따로 표시 */
function getLegacyBoardTitle(post) {
    const t = post?.title;
    if (t == null || t === '') return '';
    return String(t).trim();
}

function buildBoardListBodySection(post, shouldHideContent) {
    if (shouldHideContent) {
        return '<div class="lounge-post-body"><strong>비공개 게시물</strong><br>이 게시물은 작성자만 볼 수 있습니다.</div>';
    }
    const legacy = getLegacyBoardTitle(post);
    const formatted = renderFormattedContent(post.content || '');
    const legacyLead = legacy
        ? `<strong>${escapeHtml(legacy)}</strong>${formatted.trim() ? '<br>' : ''}`
        : '';
    return `<div class="lounge-post-body board-list-body-preview">${legacyLead}${formatted}</div>`;
}

/** 피드 인라인 입력창: 밀톡·피드 목록일 때만 표시 (글쓰기/상세/다른 탭에서는 숨김) */
export function syncBoardFeedComposerVisibility() {
    const inlineComposer = document.getElementById('boardInlineComposer');
    if (!inlineComposer) return;
    const writeView = document.getElementById('boardWriteView');
    const detailView = document.getElementById('boardDetailView');
    const overlayBoardUi =
        (writeView && !writeView.classList.contains('hidden')) ||
        (detailView && !detailView.classList.contains('hidden'));
    const show =
        appState.currentTab === 'board' &&
        appState.boardListSubTab === 'feed' &&
        !overlayBoardUi;
    inlineComposer.classList.toggle('board-feed-composer-visible', show);
    inlineComposer.classList.toggle('hidden', !show);
    if (!show) {
        document.getElementById('boardInlineComposerInput')?.blur();
    }
}

/** 라운지 헤더 검색 버튼: 게시판·공지 서브탭에서만 표시 */
export function syncBoardSearchPanelVisibility() {
    const panel = document.getElementById('boardSearchPanel');
    if (!panel || appState.currentTab !== 'board') return;
    const sub = appState.boardListSubTab;
    const show = sub === 'board' || sub === 'notice';
    panel.classList.toggle('hidden', !show);
}

/** @deprecated syncBoardSearchPanelVisibility 사용 */
export function syncBoardTracePanelVisibility() {
    syncBoardSearchPanelVisibility();
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    if (tracePanel) tracePanel.classList.add('hidden');
}

function updateBoardSearchBanner(resultCount) {
    const banner = document.getElementById('boardSearchBanner');
    const countEl = document.getElementById('boardSearchBannerCount');
    const summaryEl = document.getElementById('boardSearchBannerSummary');
    if (!banner || !countEl || !summaryEl) return;
    if (!appState.boardSearchActive) {
        banner.classList.add('hidden');
        countEl.textContent = '';
        summaryEl.textContent = '';
        return;
    }
    banner.classList.remove('hidden');
    countEl.textContent = `검색 결과 ${resultCount}건`;
    summaryEl.textContent = formatBoardSearchSummary();
}

function applyBoardSearchToPosts(posts) {
    if (!appState.boardSearchActive || !Array.isArray(posts)) return posts;
    const range = appState.boardSearchDateRange;
    const keyword = (appState.boardSearchKeyword || '').trim();
    return posts.filter((post) => {
        const ymd = timestampToYmd(post?.timestamp);
        if (range?.start && range?.end && !isYmdInRange(ymd, range.start, range.end)) return false;
        if (keyword && !boardPostMatchesKeyword(post, keyword)) return false;
        return true;
    });
}

function applyBoardSearchToNotices(notices, { likedIds, commentedIds, bookmarkedIds }) {
    if (!appState.boardSearchActive || !Array.isArray(notices)) return notices;
    const range = appState.boardSearchDateRange;
    const keyword = (appState.boardSearchKeyword || '').trim();
    const trace = appState.boardTraceFilter;
    return notices.filter((notice) => {
        const ymd = timestampToYmd(notice?.timestamp);
        if (range?.start && range?.end && !isYmdInRange(ymd, range.start, range.end)) return false;
        if (trace === 'like' && !likedIds.has(notice.id)) return false;
        if (trace === 'comment' && !commentedIds.has(notice.id)) return false;
        if (trace === 'bookmark' && !bookmarkedIds.has(notice.id)) return false;
        if (keyword && !noticeMatchesKeyword(notice, keyword)) return false;
        return true;
    });
}

async function getNotices() {
    try {
        const { collection, getDocs, query, orderBy, where } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js");
        const { db, appId } = await import('../firebase.js');
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const q = query(noticesColl, orderBy('timestamp', 'desc'));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (e) {
        console.error("Get notices error:", e);
        return [];
    }
}

// 공지 렌더링
async function renderNotices() {
    const noticesContainer = document.getElementById('noticesContainer');
    if (!noticesContainer) return;
    
    try {
        const demo = isDemoUser(window.currentUser);
        const notices = await getNotices();
        const activeNotices = notices.filter(n => n && !n.deleted && !n.hidden); // 삭제·숨김 아닌 공지만 표시 (밀로그·밀톡용)
        
        if (activeNotices.length === 0) {
            updateBoardSearchBanner(0);
            noticesContainer.innerHTML = appState.boardSearchActive
                ? `<div class="flex flex-col items-center justify-center py-12 text-center"><i data-lucide="search" class="text-4xl text-slate-200 mb-3"></i><p class="text-sm font-bold text-slate-400">검색 결과가 없습니다</p></div>`
                : '';
            noticesContainer.classList.toggle('hidden', !appState.boardSearchActive);
            if (appState.boardSearchActive) scheduleLucideIcons(noticesContainer);
            return;
        }
        
        // 상단 고정 공지와 일반 공지 분리 (isPinned === true만 고정)
        const pinnedNotices = activeNotices.filter(n => n.isPinned === true);
        const normalNotices = activeNotices.filter(n => n.isPinned !== true);
        const sortedNotices = [...pinnedNotices, ...normalNotices];
        
        const noticeTypeLabels = {
            'important': '중요',
            'notice': '알림',
            'light': '가벼운'
        };
        
        const noticeAccentClass = {
            important: 'notice-accent-important',
            notice: 'notice-accent-notice',
            light: 'notice-accent-light'
        };

        const noticeIds = sortedNotices.map((n) => n.id);

        // 조회 수: 문서 필드가 아니라 notices/{id}/views 서브컬렉션(로그인 사용자별 1회) 집계
        const viewCountMap =
            window.noticeOperations?.getNoticeViewCountsForNoticeIds
                ? await window.noticeOperations.getNoticeViewCountsForNoticeIds(noticeIds)
                : new Map();

        // 로그인 사용자의 공지 하트/북마크·댓글 여부
        let likedNoticeIds = new Set();
        let bookmarkedNoticeIds = new Set();
        let commentedNoticeIds = new Set();
        if (window.currentUser && !window.currentUser.isAnonymous && window.noticeOperations) {
            const [liked, bookmarkResults, commented] = await Promise.all([
                window.noticeOperations.getNoticeIdsLikedByUser ? window.noticeOperations.getNoticeIdsLikedByUser(window.currentUser.uid) : [],
                window.noticeOperations.isNoticeBookmarked ? Promise.all(sortedNotices.map(n => window.noticeOperations.isNoticeBookmarked(n.id, window.currentUser.uid))) : Promise.resolve([]),
                window.noticeOperations.getNoticeIdsCommentedByUser ? window.noticeOperations.getNoticeIdsCommentedByUser(window.currentUser.uid) : []
            ]);
            likedNoticeIds = new Set(liked || []);
            bookmarkedNoticeIds = new Set(Array.isArray(bookmarkResults) ? sortedNotices.map((n, i) => bookmarkResults[i] ? n.id : null).filter(Boolean) : []);
            commentedNoticeIds = new Set(Array.isArray(commented) ? commented : []);
        }

        // 공지별 하트(좋아요) 카운트 - noticeInteractions에서 isLike=true만 계산
        const reactionCounts = await Promise.all(sortedNotices.map(async (n) => {
            try {
                if (window.noticeOperations?.getNoticeReactionCounts) {
                    const c = await window.noticeOperations.getNoticeReactionCounts(n.id);
                    return { noticeId: n.id, likes: c?.likes ?? 0, dislikes: c?.dislikes ?? 0 };
                }
            } catch (e) {
                console.warn('공지 반응 카운트 로드 실패(무시):', n?.id, e);
            }
            return { noticeId: n.id, likes: 0, dislikes: 0 };
        }));
        const reactionMap = new Map(reactionCounts.map(r => [r.noticeId, r]));

        const displayNotices = applyBoardSearchToNotices(sortedNotices, {
            likedIds: likedNoticeIds,
            commentedIds: commentedNoticeIds,
            bookmarkedIds: bookmarkedNoticeIds
        });
        updateBoardSearchBanner(displayNotices.length);

        if (displayNotices.length === 0 && appState.boardSearchActive) {
            noticesContainer.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i data-lucide="search" class="text-4xl text-slate-200 mb-3"></i>
                    <p class="text-sm font-bold text-slate-400">검색 결과가 없습니다</p>
                </div>`;
            noticesContainer.classList.remove('hidden');
            scheduleLucideIcons(noticesContainer);
            return;
        }
        
        noticesContainer.innerHTML = displayNotices.map((notice, index) => {
            let date = notice.timestamp ? (() => {
                // timestamp 안전하게 변환
                if (notice.timestamp.toDate && typeof notice.timestamp.toDate === 'function') {
                    return notice.timestamp.toDate();
                } else if (typeof notice.timestamp === 'string') {
                    return new Date(notice.timestamp);
                } else if (notice.timestamp instanceof Date) {
                    return notice.timestamp;
                } else {
                    return new Date(notice.timestamp);
                }
            })() : new Date();
            
            // 유효하지 않은 날짜인지 확인
            if (isNaN(date.getTime())) {
                console.warn('Invalid timestamp for notice:', notice.id, notice.timestamp);
                date = new Date();
            }
            
            const dateStr = date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
            const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
            const noticeContent = notice.content || '';
            const formattedPreview = escapeHtml(getPlainTextPreview(noticeContent));
            const noticeType = notice.type || notice.noticeType || 'notice';
            const typeLabel = noticeTypeLabels[noticeType] || '알림';
            const typeAccent = noticeAccentClass[noticeType] || noticeAccentClass.notice;

            const reactions = reactionMap.get(notice.id) || { likes: 0, dislikes: 0 };
            const likeCount = reactions.likes || 0;
            const viewCount = viewCountMap.get(notice.id) ?? viewCountMap.get(String(notice.id)) ?? 0;
            const commentCount = Number(notice.comments ?? 0) || 0;
            const isLiked = likedNoticeIds.has(notice.id);
            const isBookmarked = bookmarkedNoticeIds.has(notice.id);
            const userCommentedNotice = commentedNoticeIds.has(notice.id);

            return `
                <article onclick="window.openNoticeDetail('${notice.id}')" class="lounge-post lounge-post--notice notice cursor-pointer active:scale-[0.99] transition-transform ${typeAccent}">
                    <div class="lounge-author-row">
                        <div class="lounge-avatar lounge-avatar--fallback" aria-hidden="true">공</div>
                        <div class="lounge-author-meta min-w-0 flex-1">
                            <div class="lounge-author-name">밀로그</div>
                            <div class="lounge-author-sub">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                        </div>
                        <div class="lounge-notice-chip"><i data-lucide="megaphone" aria-hidden="true"></i><span>${escapeHtml(typeLabel)}${notice.isPinned === true ? ' · 고정' : ''}</span></div>
                    </div>
                    <div class="lounge-post-main">
                        <div class="min-w-0">
                            <div class="lounge-post-body"><strong>${escapeHtml(notice.title || '제목 없음')}</strong>${formattedPreview ? `<br>${formattedPreview}` : ''}</div>
                        </div>
                        ${Array.isArray(notice.imageUrls) && notice.imageUrls[0]
                            ? `<img class="lounge-thumb" src="${escapeHtml(String(notice.imageUrls[0]))}" alt="" loading="lazy" />`
                            : ''}
                    </div>
                    <div class="lounge-post-foot">
                        <span class="lounge-tag">#${escapeHtml(typeLabel)}</span>
                        <div class="lounge-social">
                            <button type="button" class="lounge-social-btn" tabindex="-1" aria-hidden="true"><i data-lucide="message-circle"></i> ${commentCount}</button>
                            ${demo ? '' : `
                            <button type="button" onclick="event.stopPropagation(); window.toggleNoticeLike('${notice.id}', true)" class="board-post-like-btn lounge-social-btn ${isLiked ? 'liked' : ''} ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="heart"></i> ${likeCount}
                            </button>
                            <button type="button" onclick="event.stopPropagation(); window.toggleNoticeBookmark('${notice.id}')" class="board-post-bookmark-btn lounge-social-btn ${isBookmarked ? 'bookmarked' : ''} ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="bookmark"></i>
                            </button>
                            `}
                        </div>
                    </div>
                </article>
            `;
        }).join('');
        
        noticesContainer.classList.remove('hidden');
        scheduleLucideIcons(noticesContainer);
    } catch (e) {
        console.error("공지 렌더링 오류:", e);
        noticesContainer.innerHTML = '';
        noticesContainer.classList.add('hidden');
    }
}

// 게시판 렌더링 함수 (optimisticPost: 새 글 등록 시 즉시 표시, options.excludePostId: 삭제 시 캐시에서 제외)
export async function renderBoard(category = 'all', optimisticPost = null, options = null) {
    const container = document.getElementById('boardContainer');
    if (!container) return;

    const sub = appState.boardListSubTab;
    const isFeed = sub === 'feed';
    const isNotice = sub === 'notice';
    const isUserBoard = sub === 'board';

    const feedPanel = document.getElementById('boardFeedPanel');
    const listPanel = document.getElementById('boardListPanel');
    const categoryRow = document.getElementById('boardCategoryRow');
    if (feedPanel && listPanel) {
        feedPanel.classList.toggle('hidden', !isFeed);
        listPanel.classList.toggle('hidden', isFeed);
    }
    if (categoryRow) {
        categoryRow.classList.toggle('hidden', !isUserBoard);
    }
    syncBoardFeedComposerVisibility();
    const boardWriteFab = document.getElementById('boardWriteBtn');
    if (boardWriteFab) {
        boardWriteFab.classList.toggle('hidden', !isUserBoard);
    }
    if (typeof window.syncBoardInlineComposerAvatar === 'function') {
        window.syncBoardInlineComposerAvatar();
    }
    syncBoardSearchPanelVisibility();

    const subFeed = document.getElementById('boardSubtabFeed');
    const subBoard = document.getElementById('boardSubtabBoard');
    const subNotice = document.getElementById('boardSubtabNotice');
    const setSubtabActive = (btn, on) => {
        if (!btn) return;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    };
    setSubtabActive(subFeed, isFeed);
    setSubtabActive(subBoard, isUserBoard);
    setSubtabActive(subNotice, isNotice);

    if (isFeed) {
        updateBoardSearchBanner(0);
        const { renderBoardFeedTab } = await import('./board-feed.js');
        await renderBoardFeedTab();
        return;
    }

    const noticesEl = document.getElementById('noticesContainer');
    const boardEl = document.getElementById('boardContainer');
    if (noticesEl && boardEl) {
        if (isNotice) {
            noticesEl.classList.remove('hidden');
            boardEl.classList.add('hidden');
        } else {
            noticesEl.classList.add('hidden');
            boardEl.classList.remove('hidden');
        }
    }

    if (isNotice) {
        await renderNotices();
        return;
    }

    if (!window.boardOperations) return;
    
    const excludePostId = options?.excludePostId ?? null;
    const hasFilter =
        appState.boardSearchActive &&
        appState.boardTraceFilter &&
        window.currentUser &&
        !window.currentUser.isAnonymous;
    const tracePromise = hasFilter ? (() => {
        const f = appState.boardTraceFilter;
        if (f === 'like') return window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid);
        if (f === 'comment') return window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid);
        if (f === 'bookmark') return window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid);
        return Promise.resolve([]);
    })() : Promise.resolve(null);
    
    // 낙관적: 새 글만 즉시 표시
    if (optimisticPost?.id && (category === 'all' || optimisticPost.category === category)) {
        const optWithTimestamp = { ...optimisticPost, timestamp: optimisticPost.timestamp || new Date().toISOString() };
        const likedPostIds = new Set();
        const bookmarkedPostIds = new Set();
        let filteredPosts = [optWithTimestamp];
        const tracePostIds = null;
        await renderBoardPostList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds);
        Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]).then(async ([traceList, posts, liked, bookmarked, commented]) => {
            const tracePostIds2 = traceList ? new Set(traceList) : null;
            const likedPostIds2 = new Set(liked || []);
            const bookmarkedPostIds2 = new Set(bookmarked || []);
            const postIdsCommentedByUser = new Set(commented || []);
            let merged = [optWithTimestamp, ...(posts || []).filter(p => p.id !== optimisticPost.id)];
            merged = tracePostIds2 ? merged.filter(p => tracePostIds2.has(p.id)) : merged;
            merged = applyBoardSearchToPosts(merged);
            updateBoardSearchBanner(merged.length);
            merged.sort((a, b) => (new Date(b.timestamp || 0).getTime()) - (new Date(a.timestamp || 0).getTime()));
            window._boardPostsCache = merged;
            await renderBoardPostList(container, merged, likedPostIds2, bookmarkedPostIds2, tracePostIds2, postIdsCommentedByUser);
            window.refreshNavFeedUpdateDots?.().catch(() => {});
        }).catch(() => {});
        return;
    }
    
    // 낙관적: 삭제 시 캐시에서 제외하고 즉시 표시
    if (excludePostId && window._boardPostsCache && Array.isArray(window._boardPostsCache)) {
        let filteredPosts = window._boardPostsCache.filter(p => p.id !== excludePostId);
        const likedPostIds = new Set();
        const bookmarkedPostIds = new Set();
        const tracePostIds = null;
        await renderBoardPostList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds);
        Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]).then(async ([traceList, posts, liked, bookmarked, commented]) => {
            const tracePostIds2 = traceList ? new Set(traceList) : null;
            const likedPostIds2 = new Set(liked || []);
            const bookmarkedPostIds2 = new Set(bookmarked || []);
            const postIdsCommentedByUser = new Set(commented || []);
            let merged = tracePostIds2 ? (posts || []).filter(p => tracePostIds2.has(p.id)) : (posts || []);
            merged = merged.filter(p => p.isHidden !== true);
            merged = merged.filter(p => p.id !== excludePostId);
            merged = applyBoardSearchToPosts(merged);
            updateBoardSearchBanner(merged.length);
            window._boardPostsCache = merged;
            await renderBoardPostList(container, merged, likedPostIds2, bookmarkedPostIds2, tracePostIds2, postIdsCommentedByUser);
            window.refreshNavFeedUpdateDots?.().catch(() => {});
        }).catch(() => {});
        return;
    }
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i data-lucide="loader-circle" class="text-4xl text-slate-300 mb-3 lucide-spin"></i>
                <p class="text-sm text-slate-400">게시글을 불러오는 중...</p>
            </div>
        </div>
    `;
    
    try {
        const [traceList, posts, liked, bookmarked, commented] = await Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]);
        
        const tracePostIds = traceList ? new Set(traceList) : null;
        const likedPostIds = new Set(liked || []);
        const bookmarkedPostIds = new Set(bookmarked || []);
        const postIdsCommentedByUser = new Set(commented || []);
        
        let filteredPosts = tracePostIds ? posts.filter(p => tracePostIds.has(p.id)) : posts;
        if (excludePostId) filteredPosts = filteredPosts.filter(p => p.id !== excludePostId);
        filteredPosts = applyBoardSearchToPosts(filteredPosts);
        updateBoardSearchBanner(filteredPosts.length);
        
        filteredPosts.sort((a, b) => {
            const getTimestamp = (post) => {
                if (!post.timestamp) return 0;
                if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') return post.timestamp.toDate().getTime();
                if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
                if (post.timestamp instanceof Date) return post.timestamp.getTime();
                return new Date(post.timestamp || 0).getTime();
            };
            return getTimestamp(b) - getTimestamp(a);
        });
        window._boardPostsCache = filteredPosts;
        await renderBoardPostList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds, postIdsCommentedByUser);
        window.refreshNavFeedUpdateDots?.().catch(() => {});
    } catch (error) {
        console.error("게시판 로드 오류:", error);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i data-lucide="triangle-alert" class="text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">게시글을 불러올 수 없습니다</p>
                <p class="text-xs text-slate-300 mt-2">잠시 후 다시 시도해주세요</p>
            </div>
        `;
        scheduleLucideIcons(container);
    }
}

/** 게시글 카드 목록 HTML (밀톡 목록·프로필 뷰 밀톡 탭 공용) */
export async function renderBoardPostList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds, postIdsCommentedByUser = new Set()) {
    if (!container) return;
    // 다른 사용자들의 최신 프로필 미리 로드 (프로필 변경 시 다른 사용자도 최신 설정으로 표시)
    const authorIds = [...new Set((filteredPosts || []).map(p => p.authorId).filter(Boolean))];
    await fetchUserProfiles(authorIds);
    const demo = isDemoUser(window.currentUser);
    if (filteredPosts.length === 0) {
        if (appState.boardSearchActive) {
            container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i data-lucide="search" class="text-4xl text-slate-200 mb-3"></i>
                <p class="text-sm font-bold text-slate-400">검색 결과가 없습니다</p>
            </div>`;
            return;
        }
        const traceEmptyLabels = { like: '좋아요한', comment: '댓글 단', bookmark: '북마크한' };
        const traceEmptyMsg = tracePostIds
            ? (traceEmptyLabels[appState.boardTraceFilter] || '') + ' 게시글이 없습니다'
            : '게시글이 없습니다';
        const traceEmptySub = tracePostIds ? '다른 게시글에 좋아요, 댓글, 북마크를 남겨보세요!' : '첫 번째 게시글을 작성해보세요!';
        const traceEmptyIcon = appState.boardTraceFilter === 'like' ? 'heart' : (appState.boardTraceFilter === 'comment' ? 'message-circle' : 'bookmark');
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i data-lucide="${tracePostIds ? traceEmptyIcon : 'message-circle'}" class="text-4xl text-slate-200 mb-3"></i>
                <p class="text-sm font-bold text-slate-400">${traceEmptyMsg}</p>
                <p class="text-xs text-slate-300 mt-2">${traceEmptySub}</p>
            </div>
        `;
        return;
    }
    const postTimestampToDate = (post) => {
        let postDate;
        if (!post.timestamp) {
            postDate = new Date();
        } else if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
            postDate = post.timestamp.toDate();
        } else if (typeof post.timestamp === 'string') {
            postDate = new Date(post.timestamp);
        } else if (post.timestamp instanceof Date) {
            postDate = post.timestamp;
        } else {
            postDate = new Date(post.timestamp);
        }
        if (isNaN(postDate.getTime())) {
            console.warn('Invalid timestamp for post:', post.id, post.timestamp);
            postDate = new Date();
        }
        return postDate;
    };

    const chunks = [];
    for (const post of filteredPosts) {
        const postDate = postTimestampToDate(post);

        const dateStr = postDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
        const timeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });

        // "치프에게" 카테고리 특별 처리: 작성자 이외에는 제목/내용 미리보기 숨김
        const isAuthor = window.currentUser && post.authorId === window.currentUser.uid;
        const isAdminCategory = post.category === 'admin';
        const shouldHideContent = isAdminCategory && !isAuthor;
        const isLiked = likedPostIds.has(post.id);
        const isBookmarked = bookmarkedPostIds.has(post.id);
        const authorDisplay = getDisplayProfile(post.authorId, { nickname: post.authorNickname, icon: post.authorIcon, photoUrl: post.authorPhotoUrl });
        const authorAvatar = getProfileAvatarDisplay(authorDisplay);

        const hasImages = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;
        const thumbUrl = hasImages ? String(post.imageUrls[0] || '').trim() : '';
        const isPendingPost = post.id && String(post.id).startsWith('pending-');
        const onClick =
            isPendingPost
                ? ''
                : shouldHideContent
                  ? `event.preventDefault(); event.stopPropagation(); window.showToast ? window.showToast('이 게시물은 작성자만 볼 수 있습니다', 'error') : null`
                  : `window.openBoardDetail('${post.id}')`;
        const safeAuthorId = String(post.authorId || '').replace(/'/g, "\\'");
        const profileOpen = shouldHideContent || isPendingPost
            ? ''
            : `event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${safeAuthorId}')`;
        const pendingCls = isPendingPost ? ' lounge-post--pending' : '';
        chunks.push(`
                    <article onclick="${onClick}" class="lounge-post${pendingCls} ${isPendingPost || shouldHideContent ? 'cursor-default' : 'cursor-pointer'} active:scale-[0.99] transition-transform">
                        <div class="lounge-author-row">
                            ${buildLoungeAuthorAvatarHtml(authorAvatar, profileOpen)}
                            <div class="lounge-author-meta min-w-0 flex-1">
                                <div class="lounge-author-name ${profileOpen ? 'cursor-pointer hover:opacity-90' : ''}" ${profileOpen ? `onclick="${profileOpen}" role="button" tabindex="0"` : ''}>${escapeHtml(authorDisplay.nickname)}${isPendingPost ? ' <span class="lounge-pending-badge">등록 중</span>' : ''}</div>
                                <div class="lounge-author-sub">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                            </div>
                        </div>
                        <div class="lounge-post-main">
                            <div class="min-w-0">
                                ${buildBoardListBodySection(post, shouldHideContent)}
                            </div>
                            ${thumbUrl && !shouldHideContent
                                ? `<img class="lounge-thumb" src="${escapeHtml(thumbUrl)}" alt="" loading="lazy" />`
                                : ''}
                        </div>
                        <div class="lounge-post-foot">
                                ${buildBoardCategoryTagsRow(post.category, { withPhotoTag: false })}
                                <div class="lounge-social">
                                <button type="button" class="lounge-social-btn" tabindex="-1" aria-hidden="true"><i data-lucide="message-circle"></i> ${post.comments ?? 0}</button>
                                ${demo ? '' : `
                                <button type="button" onclick="event.stopPropagation(); window.toggleBoardLike('${post.id}', true)" class="board-post-like-btn lounge-social-btn ${isLiked ? 'liked' : ''} ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i data-lucide="heart"></i> ${post.likes || 0}
                                </button>
                                <button type="button" onclick="event.stopPropagation(); window.toggleBoardBookmark('${post.id}')" class="board-post-bookmark-btn lounge-social-btn ${isBookmarked ? 'bookmarked' : ''} ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i data-lucide="bookmark"></i>
                                </button>
                                `}
                                </div>
                        </div>
                </article>
            `);
    }
    container.innerHTML = chunks.join('');
    scheduleLucideIcons(container);
}

// 게시판 상세 렌더링
export async function renderBoardDetail(postId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.boardOperations) return;
    
    container.innerHTML = `
        <div class="board-detail-state">
            <i data-lucide="loader-circle" class="board-detail-state__icon lucide-spin" aria-hidden="true"></i>
            <p class="board-detail-state__text">게시글을 불러오는 중…</p>
        </div>
    `;
    scheduleLucideIcons(container);
    try {
        const post = await window.boardOperations.getPost(postId);
        if (!post) {
            container.innerHTML = `
                <div class="board-detail-state">
                    <i data-lucide="triangle-alert" class="board-detail-state__icon board-detail-state__icon--warn" aria-hidden="true"></i>
                    <p class="board-detail-state__text">게시글을 찾을 수 없습니다</p>
                </div>
            `;
            scheduleLucideIcons(container);
            return;
        }
        
        // timestamp 안전하게 변환 (Firestore Timestamp 객체 또는 문자열 지원)
        let postDate;
        if (!post.timestamp) {
            postDate = new Date();
        } else if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
            // Firestore Timestamp 객체
            postDate = post.timestamp.toDate();
        } else if (typeof post.timestamp === 'string') {
            // ISO 문자열
            postDate = new Date(post.timestamp);
        } else if (post.timestamp instanceof Date) {
            // 이미 Date 객체
            postDate = post.timestamp;
        } else {
            // 기타 경우 (숫자 등)
            postDate = new Date(post.timestamp);
        }
        
        // 유효하지 않은 날짜인지 확인
        if (isNaN(postDate.getTime())) {
            console.warn('Invalid timestamp for post:', post.id, post.timestamp);
            postDate = new Date(); // 기본값으로 현재 시간 사용
        }
        
        // "치프에게" 카테고리 특별 처리: 작성자 이외에는 접근 불가
        const isAuthor = window.currentUser && post.authorId === window.currentUser.uid;
        const isAdminCategory = post.category === 'admin';
        
        if (isAdminCategory && !isAuthor) {
            container.innerHTML = `
                <div class="board-detail-state">
                    <i data-lucide="lock" class="board-detail-state__icon" aria-hidden="true"></i>
                    <p class="board-detail-state__text">이 게시물은 작성자만 볼 수 있습니다</p>
                </div>
            `;
            scheduleLucideIcons(container);
            return;
        }
        
        // 사용자의 반응(좋아요), 북마크 확인과 댓글 목록을 병렬로 가져오기 (관리자 댓글 표시명 포함)
        const [userReaction, isBookmarked, comments, adminDisplayName] = await Promise.all([
            window.currentUser ? window.boardOperations.getUserReaction(postId, window.currentUser.uid) : Promise.resolve(null),
            window.currentUser && window.boardOperations.isBookmarked ? window.boardOperations.isBookmarked(postId, window.currentUser.uid) : Promise.resolve(false),
            window.boardOperations.getComments(postId),
            getAdminDisplayName()
        ]);
        const demo = isDemoUser(window.currentUser);
        
        // 게시글·댓글 작성자들의 최신 프로필 로드
        const detailAuthorIds = [post.authorId, ...(comments || []).map(c => c.authorId).filter(Boolean)];
        await fetchUserProfiles(detailAuthorIds);

        const listDateStr = postDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
        const listTimeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
        const userCommentedDetail = window.currentUser && (comments || []).some((c) => c.authorId === window.currentUser.uid);
        const hasPostImages = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;

        const authorDisplay = getDisplayProfile(post.authorId, {
            nickname: post.authorNickname,
            icon: post.authorIcon,
            photoUrl: post.authorPhotoUrl
        });
        const authorAvatar = getProfileAvatarDisplay(authorDisplay);
        const safeAuthorId = String(post.authorId || '').replace(/'/g, "\\'");
        const avatarHtml =
            authorAvatar.type === 'photo'
                ? `<div class="lounge-avatar" style="background-image: url(${authorAvatar.value})" role="img" aria-hidden="true"></div>`
                : `<div class="lounge-avatar lounge-avatar--fallback${authorAvatar.type === 'emoji' ? ' lounge-avatar--emoji' : ''}" aria-hidden="true">${escapeHtml(authorAvatar.value)}</div>`;
        const legacy = getLegacyBoardTitle(post);
        const legacyBlock = legacy
            ? `<h2 class="board-detail-title">${escapeHtml(legacy)}</h2>`
            : '';
        const imgs = hasPostImages
            ? `<div class="board-detail-images">${post.imageUrls
                  .map((url) => `<img src="${escapeHtml(url)}" alt="게시글 사진" loading="lazy">`)
                  .join('')}</div>`
            : '';
        const commentsHtml =
            comments.length > 0
                ? comments
                      .map((comment) => {
                          let commentDate;
                          if (!comment.timestamp) commentDate = new Date();
                          else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function')
                              commentDate = comment.timestamp.toDate();
                          else if (typeof comment.timestamp === 'string') commentDate = new Date(comment.timestamp);
                          else if (comment.timestamp instanceof Date) commentDate = comment.timestamp;
                          else commentDate = new Date(comment.timestamp);
                          if (isNaN(commentDate.getTime())) commentDate = new Date();
                          const commentDateStr = commentDate.toLocaleDateString('ko-KR', {
                              month: 'numeric',
                              day: 'numeric',
                              ...SEOUL_LOCALE_OPTIONS
                          });
                          const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                              ...SEOUL_LOCALE_OPTIONS
                          });
                          const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                          const commentNickname =
                              comment.isAdminComment === true
                                  ? adminDisplayName
                                  : getDisplayProfile(
                                        comment.authorId,
                                        {
                                            nickname: comment.authorNickname || comment.anonymousId,
                                            icon: comment.authorIcon,
                                            photoUrl: comment.authorPhotoUrl
                                        },
                                        { preferStoredNickname: true }
                                    ).nickname;
                          const commentBody = comment.content ?? comment.text ?? '';
                          return `
                            <div class="board-detail-comment" data-comment-id="${escapeHtml(String(comment.id))}">
                                <div class="board-detail-comment__head">
                                    <div class="board-detail-comment__meta">
                                        <span class="board-detail-comment__nick">${escapeHtml(commentNickname)}</span>
                                        <time class="board-detail-comment__time">${commentDateStr} ${commentTimeStr}</time>
                                    </div>
                                    ${
                                        isCommentAuthor
                                            ? `<button type="button" onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="board-detail-comment__delete">삭제</button>`
                                            : ''
                                    }
                                </div>
                                ${
                                    commentBody
                                        ? `<p class="board-detail-comment__body" data-board-comment-body="1">${escapeHtml(commentBody)}</p>`
                                        : ''
                                }
                                ${
                                    Array.isArray(comment.imageUrls) && comment.imageUrls.length > 0
                                        ? `<div class="board-detail-comment-images">
                                            ${comment.imageUrls
                                                .slice(0, 3)
                                                .map(
                                                    (url) => `
                                                <button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="board" data-src="${escapeHtml(url)}" aria-label="댓글 이미지 확대">
                                                    <img src="${escapeHtml(url)}" alt="" loading="lazy" />
                                                </button>`
                                                )
                                                .join('')}
                                        </div>`
                                        : ''
                                }
                            </div>`;
                      })
                      .join('')
                : `<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>`;

        container.innerHTML = `
            <div class="board-detail-page">
                <article class="lounge-post board-detail-card">
                    <header class="board-detail-toolbar">
                        <button type="button" onclick="window.backToBoardList()" class="board-detail-icon-btn" aria-label="목록으로">
                            <i data-lucide="arrow-left" aria-hidden="true"></i>
                        </button>
                        <div class="board-detail-author">
                            <button type="button" class="board-detail-author__avatar" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${safeAuthorId}')" aria-label="작성자 프로필">
                                ${avatarHtml}
                            </button>
                            <div class="board-detail-author__text min-w-0">
                                <button type="button" class="board-detail-author__name" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${safeAuthorId}')">${escapeHtml(authorDisplay.nickname)}</button>
                                <div class="board-detail-author__sub">${listDateStr} ${listTimeStr} · 조회 ${post.views || 0}</div>
                            </div>
                        </div>
                        ${isAuthor ? '<span class="board-detail-mine-badge">내글</span>' : ''}
                        <button type="button" onclick="window.showBoardPostOptions && window.showBoardPostOptions('${postId}', ${isAuthor})" class="board-detail-icon-btn" aria-label="더보기">
                            <i data-lucide="ellipsis-vertical" aria-hidden="true"></i>
                        </button>
                    </header>
                    <div class="board-detail-content-block">
                        ${legacyBlock}
                        ${imgs}
                        <div class="${BOARD_DETAIL_BODY_CLASS}">${renderFormattedContent(post.content)}</div>
                    </div>
                    <footer class="board-detail-foot">
                        ${buildBoardCategoryTagsRow(post.category, { withPhotoTag: hasPostImages })}
                        <div class="board-detail-actions-row">
                            <span class="board-detail-stat"><i data-lucide="message-circle" class="social-action-icon-stroke" aria-hidden="true"></i><span>${post.comments ?? comments.length}</span></span>
                            ${
                                demo
                                    ? ''
                                    : `
                            <button type="button" onclick="window.toggleBoardLike('${postId}', true)" class="board-post-like-btn board-detail-stat${userReaction === 'like' ? ' liked' : ''}" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="heart" class="social-action-icon-stroke${userReaction === 'like' ? ' is-liked' : ''}" aria-hidden="true"></i>
                                <span>${post.likes || 0}</span>
                            </button>
                            <button type="button" onclick="window.toggleBoardBookmark('${postId}')" class="board-post-bookmark-btn board-detail-stat${isBookmarked ? ' bookmarked' : ''}" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="bookmark" class="social-action-icon-stroke" aria-hidden="true"></i>
                            </button>`
                            }
                        </div>
                    </footer>
                </article>

                <section class="lounge-post board-detail-comments-card">
                    <div class="board-detail-comments-head">
                        <h3 class="board-detail-comments-title">댓글 <span id="boardCommentsCount" class="board-detail-comments-count">${comments.length}</span></h3>
                    </div>
                    <div id="boardCommentsList" class="board-detail-comments-list${comments.length > 0 ? ' has-items' : ''}">
                        ${commentsHtml}
                    </div>
                    <div class="board-detail-composer">
                        <div class="board-detail-composer__row">
                            <label class="sr-only" for="boardCommentInput">댓글 입력</label>
                            <input type="file" id="boardCommentPhotoInput" class="hidden" accept="image/*" multiple>
                            <input type="text" id="boardCommentInput" placeholder="${demo ? '샘플 계정은 읽기 전용입니다' : window.currentUser ? '댓글을 입력하세요…' : '로그인 후 댓글을 작성할 수 있습니다'}"
                                   class="board-detail-comment-input"
                                   ${!window.currentUser || demo ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey && !(${demo})) { event.preventDefault(); window.addBoardComment('${postId}'); }">
                            ${demo ? '' : `<button type="button" class="board-detail-comment-attach" data-board-comment-attach="1" aria-label="사진 첨부"><i data-lucide="image" aria-hidden="true"></i></button>`}
                            ${
                                demo
                                    ? `<span class="board-detail-composer__readonly">읽기</span>`
                                    : `<button type="button" class="board-detail-comment-send" data-board-comment-send="1" aria-label="입력" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addBoardComment('${postId}')" onclick="if(window.currentUser) window.addBoardComment('${postId}')"><i data-lucide="arrow-up" aria-hidden="true"></i></button>`
                            }
                        </div>
                        <div id="boardCommentPhotoPreview" class="board-detail-comment-photo-preview hidden"></div>
                    </div>
                </section>
            </div>
        `;
        scheduleLucideIcons(container);
        try {
            requestAnimationFrame(() => window.syncBoardDetailCommentComposer?.());
        } catch (_) {}
    } catch (error) {
        console.error('게시글 상세 로드 오류:', error);
        container.innerHTML = `
            <div class="board-detail-state">
                <i data-lucide="triangle-alert" class="board-detail-state__icon board-detail-state__icon--warn" aria-hidden="true"></i>
                <p class="board-detail-state__text">게시글을 불러올 수 없습니다</p>
            </div>
        `;
        scheduleLucideIcons(container);
    }
}

// 공지 상세 렌더링 (본문, 조회·좋아요·북마크, 댓글)
export async function renderNoticeDetail(noticeId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.noticeOperations) return;

    container.innerHTML = `
        <div class="board-detail-state">
            <i data-lucide="loader-circle" class="board-detail-state__icon lucide-spin" aria-hidden="true"></i>
            <p class="board-detail-state__text">공지를 불러오는 중…</p>
        </div>
    `;
    scheduleLucideIcons(container);

    try {
        const [notice, counts, userReaction, isBookmarked, comments] = await Promise.all([
            window.noticeOperations.getNotice(noticeId),
            window.noticeOperations.getNoticeReactionCounts(noticeId),
            window.currentUser ? window.noticeOperations.getNoticeUserReaction(noticeId, window.currentUser.uid) : Promise.resolve(null),
            window.currentUser && window.noticeOperations.isNoticeBookmarked ? window.noticeOperations.isNoticeBookmarked(noticeId, window.currentUser.uid) : Promise.resolve(false),
            window.noticeOperations.getNoticeComments ? window.noticeOperations.getNoticeComments(noticeId) : Promise.resolve([])
        ]);

        if (!notice) {
            container.innerHTML = `
                <div class="board-detail-state">
                    <i data-lucide="triangle-alert" class="board-detail-state__icon board-detail-state__icon--warn" aria-hidden="true"></i>
                    <p class="board-detail-state__text">공지를 찾을 수 없습니다</p>
                </div>
            `;
            scheduleLucideIcons(container);
            return;
        }

        const detailAuthorIds = [...new Set((comments || []).map((c) => c.authorId).filter(Boolean))];
        await fetchUserProfiles(detailAuthorIds);

        if (window.noticeOperations?.recordNoticeView) {
            await window.noticeOperations.recordNoticeView(noticeId).catch(() => {});
        }
        const viewCount =
            window.noticeOperations.getNoticeViewCount
                ? await window.noticeOperations.getNoticeViewCount(noticeId)
                : 0;

        let date = notice.timestamp ? (() => {
            if (notice.timestamp.toDate && typeof notice.timestamp.toDate === 'function') {
                return notice.timestamp.toDate();
            } else if (typeof notice.timestamp === 'string') {
                return new Date(notice.timestamp);
            } else if (notice.timestamp instanceof Date) {
                return notice.timestamp;
            } else {
                return new Date(notice.timestamp);
            }
        })() : new Date();

        if (isNaN(date.getTime())) {
            console.warn('Invalid timestamp for notice:', notice.id, notice.timestamp);
            date = new Date();
        }

        const dateStr = date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', ...SEOUL_LOCALE_OPTIONS });
        const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });

        const noticeTypeLabels = { important: '중요', notice: '알림', light: '가벼운' };
        const noticeType = notice.type || notice.noticeType || 'notice';
        const typeLabel = noticeTypeLabels[noticeType] || '알림';

        const likes = counts?.likes ?? 0;
        const isLiked = userReaction === 'like';
        const demo = isDemoUser(window.currentUser);
        const userCommentedDetail = window.currentUser && (comments || []).some((c) => c.authorId === window.currentUser.uid);
        const commentList = comments || [];
        const commentCountShown = commentList.length;

        const safeNoticeId = String(noticeId).replace(/'/g, "\\'");
        const commentsListHtml =
            commentList.length > 0
                ? commentList
                      .map((comment) => {
                          let commentDate;
                          if (!comment.timestamp) commentDate = new Date();
                          else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function')
                              commentDate = comment.timestamp.toDate();
                          else if (typeof comment.timestamp === 'string') commentDate = new Date(comment.timestamp);
                          else if (comment.timestamp instanceof Date) commentDate = comment.timestamp;
                          else commentDate = new Date(comment.timestamp);
                          if (isNaN(commentDate.getTime())) commentDate = new Date();
                          const commentDateStr = commentDate.toLocaleDateString('ko-KR', {
                              month: 'numeric',
                              day: 'numeric',
                              ...SEOUL_LOCALE_OPTIONS
                          });
                          const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false,
                              ...SEOUL_LOCALE_OPTIONS
                          });
                          const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                          const commentNickname = getDisplayProfile(
                              comment.authorId,
                              {
                                  nickname: comment.authorNickname || comment.anonymousId,
                                  icon: comment.authorIcon,
                                  photoUrl: comment.authorPhotoUrl
                              },
                              { preferStoredNickname: true }
                          ).nickname;
                          const commentBody = comment.content ?? comment.text ?? '';
                          const safeCid = String(comment.id || '').replace(/'/g, "\\'");
                          return `
                            <div class="board-detail-comment" data-comment-id="${escapeHtml(String(comment.id))}">
                                <div class="board-detail-comment__head">
                                    <div class="board-detail-comment__meta">
                                        <span class="board-detail-comment__nick">${escapeHtml(commentNickname)}</span>
                                        <time class="board-detail-comment__time">${commentDateStr} ${commentTimeStr}</time>
                                    </div>
                                    ${
                                        isCommentAuthor
                                            ? `<button type="button" onclick="window.deleteNoticeComment('${safeCid}', '${safeNoticeId}')" class="board-detail-comment__delete">삭제</button>`
                                            : ''
                                    }
                                </div>
                                ${
                                    commentBody
                                        ? `<p class="board-detail-comment__body" data-notice-comment-body="1">${escapeHtml(commentBody)}</p>`
                                        : ''
                                }
                                ${
                                    Array.isArray(comment.imageUrls) && comment.imageUrls.length > 0
                                        ? `<div class="board-detail-comment-images">
                                            ${comment.imageUrls
                                                .slice(0, 3)
                                                .map(
                                                    (url) => `
                                                <button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="notice" data-src="${escapeHtml(url)}" aria-label="댓글 이미지 확대">
                                                    <img src="${escapeHtml(url)}" alt="" loading="lazy" />
                                                </button>`
                                                )
                                                .join('')}
                                        </div>`
                                        : ''
                                }
                            </div>`;
                      })
                      .join('')
                : `<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>`;

        const noticeImages =
            Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0
                ? `<div class="board-detail-images">${notice.imageUrls
                      .map((url) => `<img src="${escapeHtml(url)}" alt="공지 사진" loading="lazy">`)
                      .join('')}</div>`
                : '';

        container.innerHTML = `
            <div class="board-detail-page">
                <article class="lounge-post board-detail-card board-detail-card--notice">
                    <header class="board-detail-toolbar">
                        <button type="button" onclick="window.backToBoardList()" class="board-detail-icon-btn" aria-label="목록으로">
                            <i data-lucide="arrow-left" aria-hidden="true"></i>
                        </button>
                        <div class="board-detail-notice-head min-w-0 flex-1">
                            <div class="board-detail-author__sub">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                            <h2 class="board-detail-title board-detail-title--notice">${escapeHtml(notice.title || '공지')}</h2>
                        </div>
                    </header>
                    <div class="board-detail-content-block">
                        ${noticeImages}
                        <div class="${BOARD_DETAIL_BODY_CLASS}">${renderFormattedContent(notice.content || '')}</div>
                    </div>
                    <footer class="board-detail-foot">
                        <div class="board-detail-notice-tags">
                            ${notice.isPinned === true ? `<span class="lounge-notice-chip"><i data-lucide="pin" aria-hidden="true"></i>고정</span>` : ''}
                            <span class="lounge-tag board-category-hashtag">${escapeHtml(`#${typeLabel}`)}</span>
                        </div>
                        <div class="board-detail-actions-row">
                            <span class="board-detail-stat"><i data-lucide="message-circle" class="social-action-icon-stroke" aria-hidden="true"></i><span>${commentCountShown}</span></span>
                            ${
                                demo
                                    ? ''
                                    : `
                            <button type="button" onclick="window.toggleNoticeLike('${safeNoticeId}', true)" class="board-post-like-btn board-detail-stat${isLiked ? ' liked' : ''}" data-notice-id="${safeNoticeId}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="heart" class="social-action-icon-stroke${isLiked ? ' is-liked' : ''}" aria-hidden="true"></i>
                                <span>${likes}</span>
                            </button>
                            <button type="button" onclick="window.toggleNoticeBookmark('${safeNoticeId}')" class="board-post-bookmark-btn board-detail-stat${isBookmarked ? ' bookmarked' : ''}" data-notice-id="${safeNoticeId}" ${!window.currentUser ? 'disabled' : ''}>
                                <i data-lucide="bookmark" class="social-action-icon-stroke" aria-hidden="true"></i>
                            </button>`
                            }
                        </div>
                    </footer>
                </article>

                <section class="lounge-post board-detail-comments-card">
                    <div class="board-detail-comments-head">
                        <h3 class="board-detail-comments-title">댓글 <span id="noticeCommentsCount" class="board-detail-comments-count">${commentCountShown}</span></h3>
                    </div>
                    <div id="noticeCommentsList" class="board-detail-comments-list${commentList.length > 0 ? ' has-items' : ''}">
                        ${commentsListHtml}
                    </div>
                    <div class="board-detail-composer">
                        <div class="board-detail-composer__row">
                            <label class="sr-only" for="noticeCommentInput">댓글 입력</label>
                            <input type="file" id="noticeCommentPhotoInput" class="hidden" accept="image/*" multiple>
                            <input type="text" id="noticeCommentInput" placeholder="${demo ? '샘플 계정은 읽기 전용입니다' : window.currentUser ? '댓글을 입력하세요…' : '로그인 후 댓글을 작성할 수 있습니다'}"
                                   class="board-detail-comment-input"
                                   ${!window.currentUser || demo ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey && !(${demo})) { event.preventDefault(); window.addNoticeComment('${safeNoticeId}'); }">
                            ${demo ? '' : `<button type="button" class="board-detail-comment-attach" data-notice-comment-attach="1" aria-label="사진 첨부"><i data-lucide="image" aria-hidden="true"></i></button>`}
                            ${
                                demo
                                    ? `<span class="board-detail-composer__readonly">읽기</span>`
                                    : `<button type="button" class="board-detail-comment-send" data-notice-comment-send="1" aria-label="입력" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addNoticeComment('${safeNoticeId}')" onclick="if(window.currentUser) window.addNoticeComment('${safeNoticeId}')"><i data-lucide="arrow-up" aria-hidden="true"></i></button>`
                            }
                        </div>
                        <div id="noticeCommentPhotoPreview" class="board-detail-comment-photo-preview hidden"></div>
                    </div>
                </section>
            </div>
        `;
        scheduleLucideIcons(container);
        try {
            requestAnimationFrame(() => window.syncBoardDetailCommentComposer?.());
        } catch (_) {}
    } catch (e) {
        console.error('공지 상세 로드 오류:', e);
        container.innerHTML = `
            <div class="board-detail-state">
                <i data-lucide="triangle-alert" class="board-detail-state__icon board-detail-state__icon--warn" aria-hidden="true"></i>
                <p class="board-detail-state__text">공지를 불러올 수 없습니다</p>
            </div>
        `;
        scheduleLucideIcons(container);
    }
}
