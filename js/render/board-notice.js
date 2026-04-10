/**
 * 밀톡 게시판 목록·상세, 공지 목록·상세
 */
import { appState } from '../state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './utils.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { getAdminDisplayName } from '../db.js';
import { fetchUserProfiles } from './user-profiles.js';
import { isDemoUser } from '../demo-account.js';
// showToast는 onclick 문자열(인라인)에서 window.showToast를 사용 (main.js에서 전역 바인딩됨)

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
        const { collection, getDocs, query, orderBy, where } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
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
        
        const noticeTypeColors = {
            'important': 'bg-red-100 text-red-700',
            'notice': 'bg-blue-100 text-blue-700',
            'light': 'bg-slate-100 text-slate-700'
        };
        const noticeAccentClass = {
            important: 'notice-accent-important',
            notice: 'notice-accent-notice',
            light: 'notice-accent-light'
        };

        // 로그인 사용자의 공지 하트/북마크 상태
        let likedNoticeIds = new Set();
        let bookmarkedNoticeIds = new Set();
        if (window.currentUser && !window.currentUser.isAnonymous && window.noticeOperations) {
            const [liked, bookmarkResults] = await Promise.all([
                window.noticeOperations.getNoticeIdsLikedByUser ? window.noticeOperations.getNoticeIdsLikedByUser(window.currentUser.uid) : [],
                window.noticeOperations.isNoticeBookmarked ? Promise.all(sortedNotices.map(n => window.noticeOperations.isNoticeBookmarked(n.id, window.currentUser.uid))) : Promise.resolve([])
            ]);
            likedNoticeIds = new Set(liked || []);
            bookmarkedNoticeIds = new Set(Array.isArray(bookmarkResults) ? sortedNotices.map((n, i) => bookmarkResults[i] ? n.id : null).filter(Boolean) : []);
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
        const adminDisplayName = await getAdminDisplayName();
        
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
            
            const dateStr = date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
            const noticeContent = notice.content || '';
            const formattedPreview = escapeHtml(getPlainTextPreview(noticeContent));
            const noticeType = notice.type || notice.noticeType || 'notice';
            const typeLabel = noticeTypeLabels[noticeType] || '알림';
            const typeColor = noticeTypeColors[noticeType] || noticeTypeColors.notice;
            const typeAccent = noticeAccentClass[noticeType] || noticeAccentClass.notice;

            const reactions = reactionMap.get(notice.id) || { likes: 0, dislikes: 0 };
            const likeCount = reactions.likes || 0;
            const viewCount = Number(notice.views || notice.viewCount || notice.viewsCount || notice.viewCounts || 0) || 0;
            const isLiked = likedNoticeIds.has(notice.id);
            const isBookmarked = bookmarkedNoticeIds.has(notice.id);
            
            return `
                <div onclick="window.openNoticeDetail('${notice.id}')" class="board-list-card pt-4 px-5 pb-1.5 cursor-pointer active:scale-[0.98] transition-all mb-2 ${typeAccent}">
                    <div class="flex items-start gap-3 mb-1.5">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-3 flex-wrap">
                                ${notice.isPinned === true ? `<i class="fa-solid fa-thumbtack text-black text-xs"></i>` : ''}
                                <span class="text-[10px] font-bold px-2.5 py-1 rounded-lg ${typeColor} whitespace-nowrap shrink-0">${typeLabel}</span>
                                <h3 class="text-base font-bold text-slate-800 line-clamp-2 flex-1 min-w-0 leading-tight">${escapeHtml(notice.title || '제목 없음')}</h3>
                                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? '<span class="text-slate-400 shrink-0" title="사진 포함"><i class="fa-solid fa-image text-sm"></i></span>' : ''}
                            </div>
                            <p class="text-sm text-slate-600 line-clamp-2 mb-1.5 leading-relaxed">${formattedPreview}</p>
                        </div>
                    </div>
                    <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-sm flex-shrink-0 border-2 border-slate-300">
                                <i class="fa-solid fa-bullhorn text-slate-500 text-xs"></i>
                            </div>
                            <div>
                                <div class="text-xs font-bold text-slate-800">${escapeHtml(adminDisplayName)}</div>
                                <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
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

    const feedPanel = document.getElementById('boardFeedPanel');
    const listPanel = document.getElementById('boardListPanel');
    const categoryRow = document.getElementById('boardCategoryRow');
    if (feedPanel && listPanel) {
        const isFeed = appState.boardListSubTab === 'feed';
        feedPanel.classList.toggle('hidden', !isFeed);
        listPanel.classList.toggle('hidden', isFeed);
    }
    if (categoryRow) {
        categoryRow.classList.toggle('hidden', appState.boardListSubTab === 'feed');
    }
    syncBoardFeedComposerVisibility();
    const boardWriteFab = document.getElementById('boardWriteBtn');
    if (boardWriteFab) {
        boardWriteFab.classList.toggle('hidden', appState.boardListSubTab === 'feed');
    }
    if (typeof window.syncBoardInlineComposerAvatar === 'function') {
        window.syncBoardInlineComposerAvatar();
    }
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    if (tracePanel && appState.currentTab === 'board') {
        tracePanel.classList.toggle('hidden', appState.boardListSubTab === 'feed');
    }

    const subFeed = document.getElementById('boardSubtabFeed');
    const subBoard = document.getElementById('boardSubtabBoard');
    if (subFeed && subBoard) {
        const isFeed = appState.boardListSubTab === 'feed';
        subFeed.classList.toggle('text-emerald-600', isFeed);
        subFeed.classList.toggle('border-emerald-600', isFeed);
        subFeed.classList.toggle('text-slate-500', !isFeed);
        subFeed.classList.toggle('border-transparent', !isFeed);
        subBoard.classList.toggle('text-emerald-600', !isFeed);
        subBoard.classList.toggle('border-emerald-600', !isFeed);
        subBoard.classList.toggle('text-slate-500', isFeed);
        subBoard.classList.toggle('border-transparent', isFeed);
        subFeed.setAttribute('aria-selected', isFeed ? 'true' : 'false');
        subBoard.setAttribute('aria-selected', isFeed ? 'false' : 'true');
    }

    if (appState.boardListSubTab === 'feed') {
        const { renderBoardFeedTab } = await import('./board-feed.js');
        await renderBoardFeedTab();
        return;
    }

    renderNotices();
    
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
    const localDayKey = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const categoryLabels = {
        'serious': '무거운',
        'chat': '가벼운',
        'food': '먹는',
        'admin': '치프에게'
    };
    const categoryColors = {
        'serious': 'bg-slate-100 text-slate-700',
        'chat': 'bg-blue-100 text-blue-700',
        'food': 'bg-emerald-100 text-emerald-700',
        'admin': 'bg-orange-100 text-orange-700'
    };

    const chunks = [];
    let prevDayKey = null;
    for (const post of filteredPosts) {
        const postDate = postTimestampToDate(post);
        const dayKey = localDayKey(postDate);
        if (prevDayKey !== dayKey) {
            prevDayKey = dayKey;
            const dayBannerLabel = postDate.toLocaleDateString('ko-KR', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long'
            });
            chunks.push(`
                <div class="flex justify-center py-2.5 px-3" role="separator" aria-label="${escapeHtml(dayBannerLabel)}">
                    <span class="text-[11px] font-medium text-slate-500 bg-slate-100/95 px-3.5 py-1 rounded-full shadow-sm">${escapeHtml(dayBannerLabel)}</span>
                </div>
            `);
        }

        const dateStr = postDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
        const timeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

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
        chunks.push(`
                    <div onclick="${onClick}" class="board-list-card pt-4 px-5 pb-1.5 ${isPendingPost || shouldHideContent ? 'cursor-default' : 'cursor-pointer'} active:scale-[0.98] transition-all mb-2 ${isPendingPost ? 'ring-2 ring-amber-200 bg-amber-50/50' : ''}">
                        <div class="flex items-start gap-3 mb-1.5">
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 mb-3 min-w-0 flex-wrap">
                                    <span class="text-[10px] font-bold px-2.5 py-1 rounded-lg ${categoryColors[post.category] || categoryColors.serious} whitespace-nowrap shrink-0">${categoryLabels[post.category] || '무거운'}</span>
                                    ${isPendingPost ? '<span class="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-amber-200 text-amber-800 whitespace-nowrap shrink-0"><i class="fa-solid fa-spinner fa-spin mr-1"></i>등록 중...</span>' : ''}
                                    ${shouldHideContent ? '<h3 class="text-base font-bold text-slate-400 line-clamp-2 flex-1 min-w-0 leading-tight">비공개 게시물</h3>' : `<h3 class="text-base font-bold text-slate-800 line-clamp-2 flex-1 min-w-0 leading-tight">${escapeHtml(post.title)}</h3>`}
                                    ${hasImages ? '<span class="text-slate-400 shrink-0" title="사진 포함"><i class="fa-solid fa-image text-sm"></i></span>' : ''}
                                </div>
                                ${shouldHideContent ? '<p class="text-sm text-slate-400 line-clamp-2 mb-1.5 leading-relaxed">이 게시물은 작성자만 볼 수 있습니다.</p>' : `<p class="text-sm text-slate-600 line-clamp-2 mb-1.5 leading-relaxed">${escapeHtml(getPlainTextPreview(post.content))}</p>`}
                            </div>
                        </div>
                        <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                            <div class="flex items-center gap-3 cursor-pointer hover:opacity-80 active:opacity-70 transition-opacity rounded-lg -m-1 p-1" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${post.authorId}')" role="button" tabindex="0">
                                ${authorAvatar.type === 'photo' ? `
                                    <div class="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                                ` : `
                                    <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                        ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                                    </div>
                                `}
                                <div>
                                    <div class="text-xs font-bold text-slate-800">${escapeHtml(authorDisplay.nickname)}</div>
                                    <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
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
        
        const dateStr = postDate.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const categoryLabels = {
            'serious': '무거운',
            'chat': '가벼운',
            'food': '먹는',
            'admin': '치프에게'
        };
        
        const categoryColors = {
            'serious': 'bg-slate-100 text-slate-700',
            'chat': 'bg-blue-100 text-blue-700',
            'food': 'bg-emerald-100 text-emerald-700',
            'admin': 'bg-orange-100 text-orange-700'
        };
        
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
        
        container.innerHTML = `
            <div class="board-post-card space-y-4">
                <!-- 상단: 뒤로가기 / 카테고리·제목 / 내글 / 점3개 -->
                <div class="flex items-center gap-2 pb-3 border-b border-slate-200">
                    <button onclick="window.backToBoardList()" class="w-8 h-8 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${categoryColors[post.category] || categoryColors.serious}">${categoryLabels[post.category] || '무거운'}</span>
                    <h2 class="sub-title text-base text-slate-800 tracking-tight flex-1 line-clamp-2 min-w-0">${escapeHtml(post.title || '게시글')}</h2>
                    ${isAuthor ? '<span class="shrink-0 text-[10px] text-emerald-600 font-bold">내글</span>' : ''}
                    <button type="button" onclick="window.showBoardPostOptions && window.showBoardPostOptions('${postId}', ${isAuthor})" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                    </button>
                </div>
                
                <!-- 사진 (본문 상단, 좌우 폭 꽉 차게 표시, 전체 비율 유지·잘림 없음) -->
                ${Array.isArray(post.imageUrls) && post.imageUrls.length > 0 ? `
                <div class="flex flex-col gap-2 mb-4 -mx-4 px-2">
                    ${post.imageUrls.map(url => `<img src="${url}" alt="게시글 사진" class="w-full h-auto rounded-xl border border-slate-200 object-contain" loading="lazy">`).join('')}
                </div>
                ` : ''}
                
                <!-- 게시글 내용 -->
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4 -mx-2 px-2">${renderFormattedContent(post.content)}</div>
                
                <!-- 하단: 작성자/일자/조회수(왼쪽) | 좋아요·북마크(오른쪽) -->
                ${(() => {
                    const authorDisplay = getDisplayProfile(post.authorId, { nickname: post.authorNickname, icon: post.authorIcon, photoUrl: post.authorPhotoUrl });
                    const authorAvatar = getProfileAvatarDisplay(authorDisplay);
                    return `
                <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                    <div class="flex items-center gap-3">
                        ${authorAvatar.type === 'photo' ? `
                            <div class="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                        ` : `
                            <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                            </div>
                        `}
                        <div>
                            <div class="text-xs font-bold text-slate-800">${escapeHtml(authorDisplay.nickname)}</div>
                            <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
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
                `;
                })()}
                
                <!-- 댓글 섹션 -->
                <div class="pt-4 border-t border-slate-200">
                    <h3 class="text-sm font-black text-slate-800 mb-4">댓글 <span id="boardCommentsCount" class="text-emerald-600">${comments.length}</span></h3>
                    <div id="boardCommentsList" class="space-y-3 mb-4">
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
                            
                            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                            const commentNickname = comment.isAdminComment === true ? adminDisplayName : getDisplayProfile(comment.authorId, { nickname: comment.authorNickname || comment.anonymousId }).nickname;
                            const commentBody = comment.content ?? comment.text ?? '';
                            
                            return `
                                <div class="mb-1 text-sm" data-comment-id="${comment.id}">
                                    <span class="font-bold text-slate-800">${escapeHtml(commentNickname)}</span>
                                    <span class="text-slate-800 ml-2">${escapeHtml(commentBody)}</span>
                                    ${commentDateStr && commentTimeStr ? `<span class="text-xs text-slate-400 ml-2">${commentDateStr} ${commentTimeStr}</span>` : ''}
                                    ${isCommentAuthor ? `<button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                                </div>
                            `;
                        }).join('') : ''}
                    </div>
                    
                    <!-- 댓글 입력 -->
                    <div class="flex gap-2 py-3 px-3 -mx-3 -mb-3">
                        <div class="relative flex-1">
                            <input type="text" id="boardCommentInput" placeholder="${demo ? '샘플 계정은 읽기 전용입니다' : (window.currentUser ? '댓글을 입력하세요...' : '로그인 후 댓글을 작성할 수 있습니다')}" 
                                   class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100"
                                   ${(!window.currentUser || demo) ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey && !(${demo})) { event.preventDefault(); window.addBoardComment('${postId}'); }">
                            ${demo ? `<span class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm font-bold">읽기</span>` : `<span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addBoardComment('${postId}')" onclick="if(window.currentUser) window.addBoardComment('${postId}')">게시</span>`}
                        </div>
                    </div>
                </div>
            </div>
        `;
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

// 공지 상세 렌더링 (본문 페이지, 좋아요/싫어요만 표시, 신고/댓글 없음)
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
        const [notice, counts, userReaction, isBookmarked, adminDisplayName] = await Promise.all([
            window.noticeOperations.getNotice(noticeId),
            window.noticeOperations.getNoticeReactionCounts(noticeId),
            window.currentUser ? window.noticeOperations.getNoticeUserReaction(noticeId, window.currentUser.uid) : Promise.resolve(null),
            window.currentUser && window.noticeOperations.isNoticeBookmarked ? window.noticeOperations.isNoticeBookmarked(noticeId, window.currentUser.uid) : Promise.resolve(false),
            getAdminDisplayName()
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
        if (window.noticeOperations?.recordNoticeView) {
            window.noticeOperations.recordNoticeView(noticeId).catch(() => {});
        }
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
        
        const dateStr = date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const noticeTypeLabels = { important: '중요', notice: '알림', light: '가벼운' };
        const noticeTypeColors = { important: 'bg-red-100 text-red-700', notice: 'bg-blue-100 text-blue-700', light: 'bg-slate-100 text-slate-700' };
        const noticeType = notice.type || notice.noticeType || 'notice';
        const typeLabel = noticeTypeLabels[noticeType] || '알림';
        const typeColor = noticeTypeColors[noticeType] || noticeTypeColors.notice;
        
        const likes = counts?.likes ?? 0;
        const viewCount = Number(notice.views || notice.viewCount || notice.viewsCount || notice.viewCounts || 0) || 0;
        const isLiked = userReaction === 'like';
        
        container.innerHTML = `
            <div class="board-post-card space-y-4">
                <!-- 상단: 뒤로가기 / 타입·제목 -->
                <div class="flex items-center gap-2 pb-3 border-b border-slate-200">
                    <button onclick="window.backToBoardList()" class="w-8 h-8 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${typeColor}">${typeLabel}</span>
                    <h2 class="sub-title text-base text-slate-800 tracking-tight flex-1 line-clamp-2 min-w-0">${escapeHtml(notice.title || '공지')}</h2>
                    ${notice.isPinned === true ? '<span class="shrink-0 text-[10px] text-emerald-600 font-bold">고정</span>' : ''}
                </div>
                
                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? `
                <div class="flex flex-col gap-2 mb-4 -mx-4 px-2">
                    ${notice.imageUrls.map(url => `<img src="${url}" alt="공지 사진" class="w-full h-auto rounded-xl border border-slate-200 object-contain" loading="lazy">`).join('')}
                </div>
                ` : ''}
                
                <!-- 게시글 내용 -->
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4 -mx-2 px-2">${renderFormattedContent(notice.content || '')}</div>
                
                <!-- 하단: 작성자/일자/조회수(왼쪽) | 하트·북마크(오른쪽) -->
                <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-sm flex-shrink-0 border-2 border-slate-300">
                            <i class="fa-solid fa-bullhorn text-slate-500 text-xs"></i>
                        </div>
                        <div>
                            <div class="text-xs font-bold text-slate-800">${escapeHtml(adminDisplayName)}</div>
                            <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="window.toggleNoticeLike('${noticeId}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${noticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'} social-action-icon-stroke"></i>
                            <span class="text-xs font-bold text-slate-800">${likes}</span>
                        </button>
                        <button onclick="window.toggleNoticeBookmark('${noticeId}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${noticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800 social-action-icon-stroke"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
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
