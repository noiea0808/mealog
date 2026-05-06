/**
 * 밀톡 게시판 목록·상세, 공지 목록·상세
 */
import { appState } from '../state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './utils.js';
import { getDisplayProfile, getProfileAvatarDisplay, SEOUL_LOCALE_OPTIONS } from '../utils.js';
import { getAdminDisplayName } from '../db.js';
import { fetchUserProfiles } from './user-profiles.js';
import { isDemoUser } from '../demo-account.js';

/** 목록 카드 본문 미리보기: 서식·줄바꿈 유지, 최대 3줄 */
const BOARD_LIST_PREVIEW_CLASS =
    'board-list-body-preview text-sm text-slate-600 line-clamp-3 leading-relaxed break-words [&_b]:font-bold [&_strong]:font-bold [&_u]:underline [&_s]:line-through [&_strike]:line-through';

/** 상세 본문: 목록과 동일 서식·줄바꿈, 전체 표시 */
const BOARD_DETAIL_BODY_CLASS =
    'board-detail-body text-sm text-slate-700 whitespace-pre-wrap leading-relaxed break-words [&_b]:font-bold [&_strong]:font-bold [&_u]:underline [&_s]:line-through [&_strike]:line-through';

/** 게시판 카테고리 키 → 해시태그용 한글(# 제외) */
const BOARD_CATEGORY_TAG_LABELS = {
    serious: '무거운',
    chat: '가벼운',
    food: '먹는',
    admin: '치프에게'
};

/** 목록·상세: `#무거운` 등 + 선택 `#사진있음` (스타일은 `.board-category-hashtag`) */
function buildBoardCategoryTagsRow(category, opts = {}) {
    const { withPhotoTag = false } = opts;
    const key = category != null && category in BOARD_CATEGORY_TAG_LABELS ? category : 'serious';
    const label = BOARD_CATEGORY_TAG_LABELS[key];
    const parts = [`<span class="board-category-hashtag">${escapeHtml(`#${label}`)}</span>`];
    if (withPhotoTag) {
        parts.push('<span class="board-category-hashtag">#사진있음</span>');
    }
    return `<div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 min-w-0 self-center">${parts.join('')}</div>`;
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
        return '<h3 class="text-base font-bold text-slate-400 line-clamp-2 leading-snug">비공개 게시물</h3><p class="text-sm text-slate-400 line-clamp-3 mt-1.5 leading-relaxed">이 게시물은 작성자만 볼 수 있습니다.</p>';
    }
    const legacy = getLegacyBoardTitle(post);
    const formatted = renderFormattedContent(post.content || '');
    const legacyLead = legacy
        ? `<span class="font-bold text-slate-800">${escapeHtml(legacy)}</span>${formatted.trim() ? '<br>' : ''}`
        : '';
    const inner = `${legacyLead}${formatted}`;
    return `<div class="${BOARD_LIST_PREVIEW_CLASS}">${inner}</div>`;
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
            noticesContainer.innerHTML = '';
            noticesContainer.classList.add('hidden');
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
        
        noticesContainer.innerHTML = sortedNotices.map((notice, index) => {
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
                <div onclick="window.openNoticeDetail('${notice.id}')" class="board-list-card pt-4 px-5 pb-1.5 cursor-pointer active:scale-[0.98] transition-all mb-2 ${typeAccent}">
                    <div class="flex items-start gap-2 mb-1.5">
                        <div class="flex-1 min-w-0">
                            <div class="text-xs text-slate-400 mb-1.5">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                            <div class="flex items-start gap-2 mb-2">
                                <h3 class="text-base font-bold text-slate-800 line-clamp-2 flex-1 min-w-0 leading-tight">${escapeHtml(notice.title || '제목 없음')}</h3>
                                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? '<span class="text-slate-400 shrink-0 pt-0.5" title="사진 포함"><i class="fa-solid fa-image text-sm"></i></span>' : ''}
                            </div>
                            <p class="text-sm text-slate-600 line-clamp-2 mb-1.5 leading-relaxed">${formattedPreview}</p>
                        </div>
                    </div>
                    <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                        <div class="flex items-center gap-2 min-w-0">
                            ${notice.isPinned === true ? `<i class="fa-solid fa-thumbtack text-slate-600 text-xs shrink-0" title="고정"></i>` : ''}
                            <span class="board-category-hashtag">${escapeHtml(`#${typeLabel}`)}</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <div class="flex items-center gap-1.5 text-slate-800 mr-1">
                                <i class="fa-${userCommentedNotice ? 'solid' : 'regular'} fa-comment text-xl social-action-icon-stroke"></i>
                                <span class="text-xs font-bold tabular-nums">${commentCount}</span>
                            </div>
                            ${demo ? '' : `
                            <button onclick="event.stopPropagation(); window.toggleNoticeLike('${notice.id}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'} social-action-icon-stroke"></i>
                                <span class="text-xs font-bold text-slate-800">${likeCount}</span>
                            </button>
                            <button onclick="event.stopPropagation(); window.toggleNoticeBookmark('${notice.id}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800 social-action-icon-stroke"></i>
                            </button>
                            `}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        noticesContainer.classList.remove('hidden');
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
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    if (tracePanel && appState.currentTab === 'board') {
        tracePanel.classList.toggle('hidden', !isUserBoard);
    }

    const subFeed = document.getElementById('boardSubtabFeed');
    const subBoard = document.getElementById('boardSubtabBoard');
    const subNotice = document.getElementById('boardSubtabNotice');
    const setSubtabActive = (btn, on) => {
        if (!btn) return;
        btn.classList.toggle('text-emerald-600', on);
        btn.classList.toggle('border-emerald-600', on);
        btn.classList.toggle('text-slate-500', !on);
        btn.classList.toggle('border-transparent', !on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    };
    setSubtabActive(subFeed, isFeed);
    setSubtabActive(subBoard, isUserBoard);
    setSubtabActive(subNotice, isNotice);

    if (isFeed) {
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
    const hasFilter = appState.boardTraceFilter && window.currentUser && !window.currentUser.isAnonymous;
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
            window._boardPostsCache = merged;
            await renderBoardPostList(container, merged, likedPostIds2, bookmarkedPostIds2, tracePostIds2, postIdsCommentedByUser);
            window.refreshNavFeedUpdateDots?.().catch(() => {});
        }).catch(() => {});
        return;
    }
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
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
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">게시글을 불러올 수 없습니다</p>
                <p class="text-xs text-slate-300 mt-2">잠시 후 다시 시도해주세요</p>
            </div>
        `;
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
        const traceEmptyLabels = { like: '좋아요한', comment: '댓글 단', bookmark: '북마크한' };
        const traceEmptyMsg = tracePostIds
            ? (traceEmptyLabels[appState.boardTraceFilter] || '') + ' 게시글이 없습니다'
            : '게시글이 없습니다';
        const traceEmptySub = tracePostIds ? '다른 게시글에 좋아요, 댓글, 북마크를 남겨보세요!' : '첫 번째 게시글을 작성해보세요!';
        const traceEmptyIcon = appState.boardTraceFilter === 'like' ? 'fa-heart' : (appState.boardTraceFilter === 'comment' ? 'fa-comment' : 'fa-bookmark');
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-regular ${tracePostIds ? traceEmptyIcon : 'fa-comments'} text-4xl text-slate-200 mb-3"></i>
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
        chunks.push(`
                    <div onclick="${onClick}" class="board-list-card pt-4 px-5 pb-3 ${isPendingPost || shouldHideContent ? 'cursor-default' : 'cursor-pointer'} active:scale-[0.98] transition-all mb-2 ${isPendingPost ? 'ring-2 ring-amber-200 bg-amber-50/50' : ''}">
                        <div class="flex items-start gap-2.5 mb-2.5">
                            <div class="flex-shrink-0 rounded-full ${shouldHideContent || isPendingPost ? '' : 'cursor-pointer hover:opacity-90 active:opacity-80'}" ${profileOpen ? `onclick="${profileOpen}"` : ''} role="${profileOpen ? 'button' : 'presentation'}" tabindex="${profileOpen ? '0' : '-1'}">
                            ${authorAvatar.type === 'photo' ? `
                                <div class="w-9 h-9 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                            ` : `
                                <div class="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                    ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                                </div>
                            `}
                            </div>
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2 flex-wrap min-w-0">
                                    <span class="text-sm font-bold text-slate-800 ${shouldHideContent || isPendingPost ? '' : 'cursor-pointer hover:opacity-90 rounded px-0.5 -mx-0.5'}" ${profileOpen ? `onclick="${profileOpen}"` : ''} role="${profileOpen ? 'button' : 'presentation'}" tabindex="${profileOpen ? '0' : '-1'}">${escapeHtml(authorDisplay.nickname)}</span>
                                    ${isPendingPost ? '<span class="text-xs font-bold px-2 py-0.5 rounded-lg bg-amber-200 text-amber-800 whitespace-nowrap shrink-0"><i class="fa-solid fa-spinner fa-spin mr-1"></i>등록 중...</span>' : ''}
                                </div>
                                <div class="text-xs text-slate-400 mt-0.5">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                            </div>
                        </div>
                        <div class="mb-1 min-w-0">
                            ${buildBoardListBodySection(post, shouldHideContent)}
                        </div>
                        <div class="flex items-center justify-between gap-3 pt-2.5 mt-1 border-t border-slate-200">
                                ${buildBoardCategoryTagsRow(post.category, { withPhotoTag: hasImages })}
                                <div class="flex items-center gap-3 shrink-0">
                                <div class="flex items-center gap-1.5 text-slate-800">
                                    <i class="fa-${postIdsCommentedByUser.has(post.id) ? 'solid' : 'regular'} fa-comment text-xl social-action-icon-stroke"></i>
                                    <span class="text-xs font-bold">${post.comments ?? 0}</span>
                                </div>
                                ${demo ? '' : `
                                <button onclick="event.stopPropagation(); window.toggleBoardLike('${post.id}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'} social-action-icon-stroke"></i>
                                    <span class="text-xs font-bold text-slate-800">${post.likes || 0}</span>
                                </button>
                                <button onclick="event.stopPropagation(); window.toggleBoardBookmark('${post.id}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800 social-action-icon-stroke"></i>
                                </button>
                                `}
                                </div>
                        </div>
                </div>
            `);
    }
    container.innerHTML = chunks.join('');
}

// 게시판 상세 렌더링
export async function renderBoardDetail(postId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.boardOperations) return;
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
                <p class="text-sm text-slate-400">게시글을 불러오는 중...</p>
            </div>
        </div>
    `;
    try {
        const post = await window.boardOperations.getPost(postId);
        if (!post) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                    <p class="text-sm font-bold text-red-400">게시글을 찾을 수 없습니다</p>
                </div>
            `;
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
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-lock text-4xl text-slate-300 mb-3"></i>
                    <p class="text-sm font-bold text-slate-400">이 게시물은 작성자만 볼 수 있습니다</p>
                </div>
            `;
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

        container.innerHTML = `
            <div class="board-detail-page-root w-full">
                <article class="board-list-card board-detail-post-card pt-4 px-5 pb-3 mb-2">
                ${(() => {
                    const authorDisplay = getDisplayProfile(post.authorId, { nickname: post.authorNickname, icon: post.authorIcon, photoUrl: post.authorPhotoUrl });
                    const authorAvatar = getProfileAvatarDisplay(authorDisplay);
                    const safeAuthorId = String(post.authorId || '').replace(/'/g, "\\'");
                    return `
                <div class="flex items-center gap-2 mb-2.5">
                    <button type="button" onclick="window.backToBoardList()" class="w-9 h-9 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0" aria-label="목록으로">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <div class="flex items-start gap-2.5 flex-1 min-w-0">
                        <div class="flex-shrink-0 cursor-pointer rounded-full hover:opacity-90 active:opacity-80" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${safeAuthorId}')" role="button" tabindex="0" aria-label="작성자 프로필">
                        ${authorAvatar.type === 'photo' ? `
                            <div class="w-9 h-9 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                        ` : `
                            <div class="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                            </div>
                        `}
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2 flex-wrap min-w-0">
                                <span class="text-sm font-bold text-slate-800 cursor-pointer hover:opacity-90 rounded px-0.5 -mx-0.5" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${safeAuthorId}')" role="button" tabindex="0">${escapeHtml(authorDisplay.nickname)}</span>
                            </div>
                            <div class="text-xs text-slate-400 mt-0.5">${listDateStr} ${listTimeStr} · 조회 ${post.views || 0}</div>
                        </div>
                    </div>
                    ${isAuthor ? '<span class="shrink-0 text-xs text-emerald-600 font-bold self-start pt-1">내글</span>' : ''}
                    <button type="button" onclick="window.showBoardPostOptions && window.showBoardPostOptions('${postId}', ${isAuthor})" class="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors flex-shrink-0 self-start" aria-label="더보기">
                        <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                    </button>
                </div>
                `;
                })()}
                
                ${(() => {
                    const legacy = getLegacyBoardTitle(post);
                    const legacyBlock = legacy
                        ? `<div class="text-base font-bold text-slate-900 leading-snug mb-2">${escapeHtml(legacy)}</div>`
                        : '';
                    const imgs =
                        hasPostImages
                            ? `<div class="flex flex-col gap-0 mb-3 -mx-5">${post.imageUrls.map((url) => `<img src="${url}" alt="게시글 사진" class="w-full h-auto object-contain bg-slate-50" loading="lazy">`).join('')}</div>`
                            : '';
                    return `<div class="mb-1 min-w-0">${legacyBlock}${imgs}<div class="${BOARD_DETAIL_BODY_CLASS}">${renderFormattedContent(post.content)}</div></div>`;
                })()}
                
                <div class="flex items-center justify-between gap-3 pt-2.5 mt-1 border-t border-slate-200">
                    ${buildBoardCategoryTagsRow(post.category, { withPhotoTag: hasPostImages })}
                    <div class="flex items-center gap-3 shrink-0">
                        <div class="flex items-center gap-1.5 text-slate-800">
                            <i class="fa-${userCommentedDetail ? 'solid' : 'regular'} fa-comment text-xl social-action-icon-stroke"></i>
                            <span class="text-xs font-bold">${post.comments ?? comments.length}</span>
                        </div>
                        ${demo ? '' : `
                        <button onclick="window.toggleBoardLike('${postId}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${userReaction === 'like' ? 'solid' : 'regular'} fa-heart text-xl ${userReaction === 'like' ? 'text-red-500' : 'text-slate-800'} social-action-icon-stroke"></i>
                            <span class="text-xs font-bold text-slate-800">${post.likes || 0}</span>
                        </button>
                        <button onclick="window.toggleBoardBookmark('${postId}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800 social-action-icon-stroke"></i>
                        </button>
                        `}
                    </div>
                </div>
                </article>

                <section class="board-detail-comments-section mt-2 pb-[calc(5.25rem+var(--safe-bottom,0px))]">
                <article class="board-list-card board-detail-comments-card pt-4 px-5 pb-4">
                    <div class="flex items-baseline justify-between gap-2 mb-3 pb-2 border-b border-slate-200">
                        <h3 class="text-sm font-bold text-slate-800 tracking-tight">댓글 <span id="boardCommentsCount" class="text-emerald-600 font-bold tabular-nums">${comments.length}</span></h3>
                    </div>
                    <div id="boardCommentsList" class="board-detail-comments-list ${comments.length > 0 ? 'divide-y divide-slate-100' : ''}">
                        ${comments.length > 0 ? comments.map(comment => {
                            // timestamp 안전하게 변환 (Firestore Timestamp 객체 또는 문자열 지원)
                            let commentDate;
                            if (!comment.timestamp) {
                                commentDate = new Date();
                            } else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') {
                                // Firestore Timestamp 객체
                                commentDate = comment.timestamp.toDate();
                            } else if (typeof comment.timestamp === 'string') {
                                // ISO 문자열
                                commentDate = new Date(comment.timestamp);
                            } else if (comment.timestamp instanceof Date) {
                                // 이미 Date 객체
                                commentDate = comment.timestamp;
                            } else {
                                // 기타 경우 (숫자 등)
                                commentDate = new Date(comment.timestamp);
                            }
                            
                            // 유효하지 않은 날짜인지 확인
                            if (isNaN(commentDate.getTime())) {
                                console.warn('Invalid timestamp for comment:', comment.id, comment.timestamp);
                                commentDate = new Date(); // 기본값으로 현재 시간 사용
                            }
                            
                            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
                            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
                            const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                            const commentNickname = comment.isAdminComment === true
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
                                <div class="py-3 first:pt-0 last:pb-0 text-sm" data-comment-id="${comment.id}">
                                    <div class="flex items-start justify-between gap-2">
                                        <div class="min-w-0 flex items-baseline gap-2">
                                            <span class="font-bold text-slate-800 shrink-0">${escapeHtml(commentNickname)}</span>
                                            ${commentDateStr && commentTimeStr ? `<time class="text-xs text-slate-500 tabular-nums">${commentDateStr} ${commentTimeStr}</time>` : ''}
                                        </div>
                                        ${(commentDateStr && commentTimeStr) || isCommentAuthor ? `
                                            <div class="flex items-center justify-end gap-3 shrink-0">
                                                ${isCommentAuthor ? `
                                                    <button type="button" onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="text-xs font-semibold text-slate-400 hover:text-red-500 transition-colors">삭제</button>
                                                ` : ''}
                                            </div>
                                        ` : ''}
                                    </div>
                                    ${commentBody ? `<p class="text-sm text-slate-700 leading-relaxed mt-1.5 whitespace-pre-wrap break-words" data-board-comment-body="1">${escapeHtml(commentBody)}</p>` : ''}
                                    ${Array.isArray(comment.imageUrls) && comment.imageUrls.length > 0 ? `
                                        <div class="board-detail-comment-images mt-2 flex flex-wrap gap-2">
                                            ${comment.imageUrls.slice(0, 3).map((url) => `
                                                <button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="board" data-src="${escapeHtml(url)}" aria-label="댓글 이미지 확대">
                                                    <img src="${escapeHtml(url)}" alt="" loading="lazy" />
                                                </button>
                                            `).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                        }).join('') : `<p class="board-detail-comments-empty py-6 text-center text-sm text-slate-400">아직 댓글이 없습니다</p>`}
                    </div>
                    <div class="mt-4 pt-3 border-t border-slate-200 -mx-2 px-2">
                        <div class="relative flex-1">
                            <label class="sr-only" for="boardCommentInput">댓글 입력</label>
                            <input type="file" id="boardCommentPhotoInput" class="hidden" accept="image/*" multiple>
                            <input type="text" id="boardCommentInput" placeholder="${demo ? '샘플 계정은 읽기 전용입니다' : (window.currentUser ? '댓글을 입력하세요…' : '로그인 후 댓글을 작성할 수 있습니다')}" 
                                   class="board-detail-comment-input w-full pl-3.5 pr-[6.25rem] py-2.5 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 bg-slate-50/80 focus:outline-none focus:bg-white focus:border-slate-300 focus:ring-2 focus:ring-emerald-500/15 transition-shadow"
                                   ${(!window.currentUser || demo) ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey && !(${demo})) { event.preventDefault(); window.addBoardComment('${postId}'); }">
                            ${demo ? '' : `<button type="button" class="board-detail-comment-attach" data-board-comment-attach="1" aria-label="사진 첨부"><i class="fa-regular fa-image" aria-hidden="true"></i></button>`}
                            ${demo ? `<span class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">읽기</span>` : `<button type="button" class="board-detail-comment-send" data-board-comment-send="1" aria-label="입력" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addBoardComment('${postId}')" onclick="if(window.currentUser) window.addBoardComment('${postId}')"><i class="fa-solid fa-arrow-up text-sm" aria-hidden="true"></i></button>`}
                        </div>
                        <div id="boardCommentPhotoPreview" class="board-detail-comment-photo-preview hidden mt-2"></div>
                    </div>
                </article>
                </section>
            </div>
        `;
        try {
            requestAnimationFrame(() => window.syncBoardDetailCommentComposer?.());
        } catch (_) {}
    } catch (error) {
        console.error("게시글 상세 로드 오류:", error);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">게시글을 불러올 수 없습니다</p>
            </div>
        `;
    }
}

// 공지 상세 렌더링 (본문, 조회·좋아요·북마크, 댓글)
export async function renderNoticeDetail(noticeId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.noticeOperations) return;

    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
                <p class="text-sm text-slate-400">공지를 불러오는 중...</p>
            </div>
        </div>
    `;

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
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                    <p class="text-sm font-bold text-red-400">공지를 찾을 수 없습니다</p>
                </div>
            `;
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
        const commentsListHtml = commentList.length > 0
            ? commentList.map((comment) => {
                let commentDate;
                if (!comment.timestamp) {
                    commentDate = new Date();
                } else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') {
                    commentDate = comment.timestamp.toDate();
                } else if (typeof comment.timestamp === 'string') {
                    commentDate = new Date(comment.timestamp);
                } else if (comment.timestamp instanceof Date) {
                    commentDate = comment.timestamp;
                } else {
                    commentDate = new Date(comment.timestamp);
                }
                if (isNaN(commentDate.getTime())) commentDate = new Date();
                const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
                const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
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
                                <div class="py-3 first:pt-0 last:pb-0 text-sm" data-comment-id="${String(comment.id)}">
                                    <div class="flex items-start justify-between gap-2">
                                        <div class="min-w-0 flex items-baseline gap-2">
                                            <span class="font-bold text-slate-800 shrink-0">${escapeHtml(commentNickname)}</span>
                                            ${commentDateStr && commentTimeStr ? `<time class="text-xs text-slate-500 tabular-nums">${commentDateStr} ${commentTimeStr}</time>` : ''}
                                        </div>
                                        ${(commentDateStr && commentTimeStr) || isCommentAuthor ? `
                                            <div class="flex items-center justify-end gap-3 shrink-0">
                                                ${isCommentAuthor ? `
                                                    <button type="button" onclick="window.deleteNoticeComment('${safeCid}', '${safeNoticeId}')" class="text-xs font-semibold text-slate-400 hover:text-red-500 transition-colors">삭제</button>
                                                ` : ''}
                                            </div>
                                        ` : ''}
                                    </div>
                                    ${commentBody ? `<p class="text-sm text-slate-700 leading-relaxed mt-1.5 whitespace-pre-wrap break-words" data-notice-comment-body="1">${escapeHtml(commentBody)}</p>` : ''}
                                    ${Array.isArray(comment.imageUrls) && comment.imageUrls.length > 0 ? `
                                        <div class="board-detail-comment-images mt-2 flex flex-wrap gap-2">
                                            ${comment.imageUrls.slice(0, 3).map((url) => `
                                                <button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="notice" data-src="${escapeHtml(url)}" aria-label="댓글 이미지 확대">
                                                    <img src="${escapeHtml(url)}" alt="" loading="lazy" />
                                                </button>
                                            `).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            `;
            }).join('')
            : `<p class="board-detail-comments-empty py-6 text-center text-sm text-slate-400">아직 댓글이 없습니다</p>`;

        container.innerHTML = `
            <div class="board-detail-page-root w-full">
            <div class="board-post-card space-y-4">
                <div class="flex items-start gap-2 pb-3 border-b border-slate-200">
                    <button onclick="window.backToBoardList()" class="w-8 h-8 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0 mt-0.5">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs text-slate-400 mb-1.5">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                        <h2 class="sub-title text-base text-slate-800 tracking-tight line-clamp-3">${escapeHtml(notice.title || '공지')}</h2>
                    </div>
                </div>

                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? `
                <div class="flex flex-col gap-2 mb-4 -mx-4 px-2">
                    ${notice.imageUrls.map(url => `<img src="${url}" alt="공지 사진" class="w-full h-auto rounded-xl border border-slate-200 object-contain" loading="lazy">`).join('')}
                </div>
                ` : ''}

                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4 -mx-2 px-2">${renderFormattedContent(notice.content || '')}</div>

                <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                    <div class="flex items-center gap-2 min-w-0">
                        ${notice.isPinned === true ? `<i class="fa-solid fa-thumbtack text-slate-600 text-xs shrink-0" title="고정"></i>` : ''}
                        <span class="board-category-hashtag">${escapeHtml(`#${typeLabel}`)}</span>
                    </div>
                    <div class="flex items-center gap-3 shrink-0">
                        <div class="flex items-center gap-1.5 text-slate-800">
                            <i class="fa-${userCommentedDetail ? 'solid' : 'regular'} fa-comment text-xl social-action-icon-stroke"></i>
                            <span class="text-xs font-bold">${commentCountShown}</span>
                        </div>
                        ${demo ? '' : `
                        <button onclick="window.toggleNoticeLike('${safeNoticeId}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${safeNoticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'} social-action-icon-stroke"></i>
                            <span class="text-xs font-bold text-slate-800">${likes}</span>
                        </button>
                        <button onclick="window.toggleNoticeBookmark('${safeNoticeId}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${safeNoticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800 social-action-icon-stroke"></i>
                        </button>
                        `}
                    </div>
                </div>
            </div>

            <section class="board-detail-comments-section mt-2 pb-[calc(5.25rem+var(--safe-bottom,0px))]">
                <article class="board-list-card board-detail-comments-card pt-4 px-5 pb-4">
                    <div class="flex items-baseline justify-between gap-2 mb-3 pb-2 border-b border-slate-200">
                        <h3 class="text-sm font-bold text-slate-800 tracking-tight">댓글 <span id="noticeCommentsCount" class="text-emerald-600 font-bold tabular-nums">${commentCountShown}</span></h3>
                    </div>
                    <div id="noticeCommentsList" class="board-detail-comments-list ${commentList.length > 0 ? 'divide-y divide-slate-100' : ''}">
                        ${commentsListHtml}
                    </div>
                    <div class="mt-4 pt-3 border-t border-slate-200 -mx-2 px-2">
                        <div class="relative flex-1">
                            <label class="sr-only" for="noticeCommentInput">댓글 입력</label>
                            <input type="file" id="noticeCommentPhotoInput" class="hidden" accept="image/*" multiple>
                            <input type="text" id="noticeCommentInput" placeholder="${demo ? '샘플 계정은 읽기 전용입니다' : (window.currentUser ? '댓글을 입력하세요…' : '로그인 후 댓글을 작성할 수 있습니다')}"
                                   class="board-detail-comment-input w-full pl-3.5 pr-[6.25rem] py-2.5 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 bg-slate-50/80 focus:outline-none focus:bg-white focus:border-slate-300 focus:ring-2 focus:ring-emerald-500/15 transition-shadow"
                                   ${(!window.currentUser || demo) ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey && !(${demo})) { event.preventDefault(); window.addNoticeComment('${safeNoticeId}'); }">
                            ${demo ? '' : `<button type="button" class="board-detail-comment-attach" data-notice-comment-attach="1" aria-label="사진 첨부"><i class="fa-regular fa-image" aria-hidden="true"></i></button>`}
                            ${demo ? `<span class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">읽기</span>` : `<button type="button" class="board-detail-comment-send" data-notice-comment-send="1" aria-label="입력" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addNoticeComment('${safeNoticeId}')" onclick="if(window.currentUser) window.addNoticeComment('${safeNoticeId}')"><i class="fa-solid fa-arrow-up text-sm" aria-hidden="true"></i></button>`}
                        </div>
                        <div id="noticeCommentPhotoPreview" class="board-detail-comment-photo-preview hidden mt-2"></div>
                    </div>
                </article>
            </section>
            </div>
        `;
        try {
            requestAnimationFrame(() => window.syncBoardDetailCommentComposer?.());
        } catch (_) {}
    } catch (e) {
        console.error("공지 상세 로드 오류:", e);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">공지를 불러올 수 없습니다</p>
            </div>
        `;
    }
}
