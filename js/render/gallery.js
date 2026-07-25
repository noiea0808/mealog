/**
 * 모먼트 갤러리(공유 피드) 렌더링·필터·더보기
 */
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { getThumbImageUrl, imgFallbackAttrs } from '../utils/image-variants.js';
import { normalizeUrl, getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import {
    loadSharedPhotosByUserUpToPostCount,
    getMomentsFeedView,
    loadSharedPhotosForMomentNotification
} from '../db.js';
import {
    getPostIdFromPhotoGroup,
    photoGroupMatchesTracePostIds,
    preloadAdjacentGalleryImages
} from './post-group-utils.js';
import { fetchUserProfiles, getUserSettings } from './user-profiles.js';
import { renderBoardPostList } from './board-notice.js';
import { sortSharedPhotosByTimestampDesc } from '../utils/shared-photo-timestamp.js';
import {
    getPhotoGroupDateYmd,
    photoGroupMatchesKeyword,
    formatGallerySearchSummary
} from '../moment-search-filter.js';
import { docsToSortedPhotoGroups, isMomentPostV2, collapseDocsToFeedPage, countMomentPostsFromDocs } from '../utils/moment-post-v2.js';
import { renderPostGroupHtml } from './post-group-html.js';
import { fetchMissingSharedComments } from './shared-entry-comments.js';
import {
    processPostLoadQueue,
    enqueuePostInteractionLoad,
    clearMomentPostInteractionQueue
} from './moment-post-interactions.js';
import { ensureMomentFeedPinchDelegate } from '../main/moment-feed-pinch.js';
import { applyCollapsedCaptionToElement } from './comment-caption-layout.js';
import { setupMomentFeedV2WheelLayout } from '../main/moment-feed-v2-wheel-layout.js';
import {
    buildMomentFeedSkeletonCardsHtml,
    replaceMomentSkeletonWithBatch,
    removeRemainingMomentSkeletons
} from './moment-feed-skeleton.js';
import { scheduleLucideIcons } from '../icons.js';

ensureMomentFeedPinchDelegate();

// 모먼트 네트워크 오류 화면「다시 연결하기」— innerHTML onclick 대신 위임(동적 삽입·WebView 호환)
if (typeof document !== 'undefined' && !window._galleryMomentRetryDelegateBound) {
    window._galleryMomentRetryDelegateBound = true;
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-moment-network-retry], #galleryMomentRetryLoadBtn, #feedRetryLoadBtn');
        if (!btn) return;
        if (typeof window.reloadMomentFeed !== 'function') return;
        e.preventDefault();
        void window.reloadMomentFeed();
    });
}

// 모먼트 사진: 로드 완료 전 슬롯만 보이고, `loaded` 후 이미지 노출.
// 한 번 로드된 사진은 재디코드 시에도 다시 숨기지 않음.
// load/error 이벤트는 버블되지 않으므로 캡처 단계로 위임.
// 세션 동안 한 번이라도 로드 완료된 URL을 기억해, 전체 재렌더로 <img>가 새로 생겨도
// 캐시된 사진은 처음부터 `loaded`로 노출한다(재렌더마다 숨김→재노출 깜빡임 제거).
const momentLoadedPhotoUrls =
    (typeof window !== 'undefined' && (window._momentLoadedPhotoUrls = window._momentLoadedPhotoUrls || new Set())) ||
    new Set();
if (typeof document !== 'undefined' && !window._momentPhotoLoadedTrackerBound) {
    window._momentPhotoLoadedTrackerBound = true;
    const markLoaded = (img) => {
        if (img?.tagName === 'IMG' && img.classList?.contains('moment-feed-photo')) {
            img.classList.add('loaded');
            const src = img.currentSrc || img.src;
            if (src) momentLoadedPhotoUrls.add(src);
        }
    };
    document.addEventListener('load', (e) => markLoaded(e.target), true);
    document.addEventListener('error', (e) => markLoaded(e.target), true);
}

/** 캐시·즉시 완료된 이미지에 `loaded` 부여 (동적 삽입 직후 호출) */
export function markMomentFeedPhotosLoadedIn(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('img.moment-feed-photo').forEach((img) => {
        if (img.classList.contains('loaded')) return;
        const src = img.currentSrc || img.src;
        // 디코드 성공(naturalHeight>0) 또는 이번 세션에서 이미 로드된 URL이면 즉시 노출.
        if ((img.complete && img.naturalHeight > 0) || (src && momentLoadedPhotoUrls.has(src))) {
            img.classList.add('loaded');
        }
    });
}

/** `momentsFeedView === 2` — renderGallery 완료 시점 기준 (appendGalleryPosts 등에서 재사용) */
let galleryMomentLayoutV2 = false;

/** 사용자 프로필 모먼트 그리드: 3열 × 5행 = 15게시물 단위 */
const USER_PROFILE_MOMENT_GRID_PAGE_SIZE = 15;

/** 사용자 프로필 모먼트 탭: 게시물당 첫 장만 3열 그리드(인스타 스타일) */
function buildUserProfileMomentGridHtml(sortedGroups) {
    const cells = sortedGroups.map((photoGroup) => {
        const postId = getPostIdFromPhotoGroup(photoGroup);
        const first = photoGroup[0];
        const originalUrl = first?.photoUrl || '';
        // 작은 그리드 셀: 200px thumb 우선(없으면 display→원본), 로딩 실패 시 원본 폴백.
        const thumbUrl = getThumbImageUrl(first, 0, 'gallery.profile-grid') || originalUrl;
        const n = photoGroup.length;
        const multi = n > 1;
        const encId = encodeURIComponent(postId || '');
        const safeSrc = escapeHtml(thumbUrl);
        const thumbFallback = imgFallbackAttrs(originalUrl, thumbUrl, escapeHtml, 'gallery.profile-grid');
        const imgOrPlaceholder = originalUrl
            ? `<img src="${safeSrc}"${thumbFallback} alt="" class="absolute inset-0 h-full w-full object-cover" loading="lazy" draggable="false">`
            : `<div class="absolute inset-0 flex items-center justify-center text-slate-400"><i data-lucide="image" class="text-2xl" aria-hidden="true"></i></div>`;
        const badge = multi
            ? `<span class="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-black leading-none text-white shadow-sm" title="사진 ${n}장" aria-hidden="true">
                    <i data-lucide="images" class="text-[9px] opacity-95" aria-hidden="true"></i>
                    <span>${n}</span>
                </span>`
            : '';
        return `
            <button type="button" class="gallery-profile-grid-cell relative aspect-square w-full min-h-0 overflow-hidden bg-slate-200 border border-slate-100 p-0 cursor-pointer active:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-inset" data-post-id="${encId}" aria-label="게시물 열기${multi ? `, 사진 ${n}장` : ''}">
                ${imgOrPlaceholder}
                ${badge}
            </button>`;
    }).join('');
    return `<div class="gallery-profile-moment-grid grid grid-cols-3 gap-px bg-slate-200 p-px" role="list">${cells}</div>`;
}

function bindUserProfileMomentGridClicks(container) {
    const grid = container.querySelector('.gallery-profile-moment-grid');
    if (!grid) return;
    grid.addEventListener('click', (e) => {
        const btn = e.target.closest('.gallery-profile-grid-cell[data-post-id]');
        if (!btn) return;
        const raw = btn.getAttribute('data-post-id');
        if (!raw || !appState.galleryFilterUserId) return;
        try {
            appState.galleryFilterPostId = decodeURIComponent(raw);
        } catch (_) {
            appState.galleryFilterPostId = raw;
        }
        renderGallery();
    });
}

/**
 * 모먼트 네트워크 단절 안내 — 밀로그 빈 날 empty와 같은 친근한 톤 + 재연결 CTA
 * @param {{ buttonId?: string }} [opts]
 */
export function buildMomentNetworkReconnectHtml(opts = {}) {
    const buttonId = opts.buttonId || 'galleryMomentRetryLoadBtn';
    return `<div class="moment-network-empty" role="status">
        <div class="moment-network-empty__visual" aria-hidden="true">
            <span class="moment-network-empty__ring"></span>
            <i data-lucide="wifi-off" class="moment-network-empty__icon"></i>
        </div>
        <p class="moment-network-empty__title">잠깐, 연결이 끊겼어요</p>
        <p class="moment-network-empty__desc">네트워크를 확인한 뒤 다시 연결해 주세요.<br>곧 모먼트를 다시 보여드릴게요.</p>
        <button type="button" id="${buttonId}" data-moment-network-retry class="moment-network-empty__btn">
            <i data-lucide="refresh-cw" aria-hidden="true"></i>
            <span>다시 연결하기</span>
        </button>
    </div>`;
}

/** 모먼트 피드가 비었을 때: 진짜 없음 vs 네트워크·로드 실패 구분 */
function buildGalleryEmptyMomentBlock(networkError, filterUserId) {
    if (networkError) {
        return buildMomentNetworkReconnectHtml({ buttonId: 'galleryMomentRetryLoadBtn' });
    }
    return `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i data-lucide="images" class="text-6xl text-slate-200 mb-4" aria-hidden="true"></i>
                <p class="text-sm font-bold text-slate-400">${filterUserId ? '이 사용자의 공유된 사진이 없습니다' : '공유된 사진이 없습니다'}</p>
                ${!filterUserId ? '<p class="text-xs text-slate-300 mt-2">타임라인에서 사진을 공유해보세요!</p>' : ''}
            </div>`;
}

let isRenderingGallery = false;
/** 진행 중인 renderGallery가 무효화되면 증가. 오래 걸리는 await 이후 DOM 갱신·finally에서 뮤텍스 오남용 방지 */
let galleryRenderSession = 0;
/** isRenderingGallery 동안 들어온 renderGallery 요청: 한 번 더 돌려 UI가 빠지지 않게 함 */
let galleryRenderPending = false;
let galleryScrollListeners = new Map();
let intersectionObserver = null;
let placeholderObserver = null;
let galleryAbortController = null;
let previousGalleryPostIds = new Set();
let previousGalleryTraceFilter = null;

function dedupeGalleryPhotos(photos) {
    const seen = new Set();
    return (photos || []).filter((photo) => {
        const key = isMomentPostV2(photo)
            ? `v2_${photo.postId || photo.id}`
            : `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function expandFeedForGallerySearch(mySession, maxPages = 12) {
    const base = [...(window.sharedPhotosFeed || [])];
    if (appState.galleryFilterUserId) return base;

    const { loadSharedPhotosPage } = await import('../db.js');
    let docs = base;
    let cursor = appState.sharedPhotosFeedLastDoc;
    let hasMore = appState.sharedPhotosFeedHasMore;

    for (let page = 0; page < maxPages; page++) {
        if (!hasMore && !cursor) break;
        const { docs: newDocs, lastDoc, hasMore: nextHasMore } = await loadSharedPhotosPage(10, cursor);
        if (isGallerySessionStale(mySession)) return docs;
        if (!newDocs?.length) break;
        docs = collapseDocsToFeedPage(
            sortSharedPhotosByTimestampDesc([...docs, ...newDocs]),
            999
        ).feedDocs;
        cursor = lastDoc;
        hasMore = nextHasMore;
    }
    return docs;
}

/**
 * 흔적 필터용 피드 확장 검색 — sharedPhotosFeed는 건드리지 않음(필터 해제 시 원래 피드 유지).
 * @returns {Promise<object[]>} 필터 매칭 탐색에 쓸 문서 목록
 */
async function expandFeedForTraceFilter(tracePostIds, mySession) {
    const base = [...(window.sharedPhotosFeed || [])];
    if (!tracePostIds?.size || appState.galleryFilterUserId) return base;

    const hasMatch = (docs) =>
        docsToSortedPhotoGroups(dedupeGalleryPhotos(docs)).some((g) =>
            photoGroupMatchesTracePostIds(g, tracePostIds)
        );

    let docs = base;
    if (hasMatch(docs)) return docs;

    const MAX_PAGES = 12;
    const { loadSharedPhotosPage } = await import('../db.js');
    let cursor = appState.sharedPhotosFeedLastDoc;
    let hasMore = appState.sharedPhotosFeedHasMore;

    for (let page = 0; page < MAX_PAGES; page++) {
        if (!hasMore && !cursor) break;
        const { docs: newDocs, lastDoc, hasMore: nextHasMore } = await loadSharedPhotosPage(10, cursor);
        if (isGallerySessionStale(mySession)) return docs;
        if (!newDocs?.length) break;
        docs = collapseDocsToFeedPage(
            sortSharedPhotosByTimestampDesc([...docs, ...newDocs]),
            999
        ).feedDocs;
        cursor = lastDoc;
        hasMore = nextHasMore;
        if (hasMatch(docs)) break;
    }
    return docs;
}

function isGallerySessionStale(sessionAtStart) {
    return sessionAtStart !== galleryRenderSession;
}

/**
 * 모먼트 다시 불러오기 등: 이전 렌더의 Abort·뮤텍스를 정리해, 대기 중이던 renderGallery가 영구히 스킵되지 않게 함.
 */
export function invalidateGalleryRenderSession() {
    galleryRenderSession += 1;
    try {
        galleryAbortController?.abort();
    } catch (_) {
        /* ignore */
    }
    isRenderingGallery = false;
    galleryRenderPending = false;
}

/** 본문 코멘트: 본문+더보기 합쳐 3줄 레이아웃 적용 */
function applyMomentCaptionLayoutForRange(startInclusive, endExclusive) {
    requestAnimationFrame(() => {
        for (let idx = startInclusive; idx < endExclusive; idx++) {
            const collapsedEl = document.getElementById(`post-caption-collapsed-${idx}`);
            if (collapsedEl && collapsedEl.querySelector('[data-comment-collapsed-mount]')) {
                applyCollapsedCaptionToElement(collapsedEl);
            }
        }
    });
}

function setupGalleryEventListeners(container, sortedGroups, opts = null) {
    const exitSearchBtn = document.getElementById('gallerySearchExitBtn');
    if (exitSearchBtn && !exitSearchBtn._gallerySearchBound) {
        exitSearchBtn._gallerySearchBound = true;
        exitSearchBtn.addEventListener('click', () => {
            if (typeof window.clearGallerySearch === 'function') window.clearGallerySearch();
        });
    }
    const abortSignal = opts && typeof opts === 'object' && opts.abortSignal !== undefined ? opts.abortSignal : (opts && typeof opts.addEventListener === 'function' ? opts : null);
    const startIndex = opts && typeof opts === 'object' && typeof opts.startIndex === 'number' ? opts.startIndex : 0;
    const scrollContainers = container.querySelectorAll('.gallery-photo-scroll');
    scrollContainers.forEach((scrollContainer, idx) => {
        if (idx < startIndex) return;
        const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
        const photos = Array.from(scrollContainer.children);
        const photoCount = sortedGroups[idx]?.length || 0;
        const isVertical = scrollContainer.getAttribute('data-moment-carousel') === 'vertical';
        if (photoCount > 1) {
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            let startScrollLeft = 0;
            let startScrollTop = 0;
            scrollContainer.style.cursor = 'grab';
            const onMouseMove = (e) => {
                if (!isDragging) return;
                e.preventDefault();
                if (isVertical) {
                    const dy = e.pageY - startY;
                    scrollContainer.scrollTop = Math.max(0, Math.min(scrollContainer.scrollHeight - scrollContainer.clientHeight, startScrollTop - dy));
                } else {
                    const dx = e.pageX - startX;
                    scrollContainer.scrollLeft = Math.max(0, Math.min(scrollContainer.scrollWidth - scrollContainer.clientWidth, startScrollLeft - dx));
                }
            };
            const endDrag = () => {
                if (!isDragging) return;
                isDragging = false;
                scrollContainer.style.cursor = 'grab';
                scrollContainer.style.userSelect = '';
                document.removeEventListener('mousemove', onMouseMove, { capture: true });
                document.removeEventListener('mouseup', endDrag, { capture: true });
            };
            scrollContainer.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                isDragging = true;
                startX = e.pageX;
                startY = e.pageY;
                startScrollLeft = scrollContainer.scrollLeft;
                startScrollTop = scrollContainer.scrollTop;
                scrollContainer.style.cursor = 'grabbing';
                scrollContainer.style.userSelect = 'none';
                document.addEventListener('mousemove', onMouseMove, { capture: true, passive: false });
                document.addEventListener('mouseup', endDrag, { capture: true });
            }, { passive: false });
            const snapToNearest = () => {
                if (isVertical) {
                    const sl = scrollContainer.scrollTop;
                    const ch = scrollContainer.clientHeight;
                    let nearest = 0;
                    let minDist = Infinity;
                    photos.forEach((p, i) => {
                        const pos = p.offsetTop + p.offsetHeight / 2;
                        const d = Math.abs(sl + ch / 2 - pos);
                        if (d < minDist) { minDist = d; nearest = i; }
                    });
                    const target = photos[nearest]?.offsetTop ?? 0;
                    if (Math.abs(sl - target) > 2) scrollContainer.scrollTo({ top: target, behavior: 'smooth' });
                } else {
                    const sl = scrollContainer.scrollLeft;
                    const cw = scrollContainer.clientWidth;
                    let nearest = 0;
                    let minDist = Infinity;
                    photos.forEach((p, i) => {
                        const pos = p.offsetLeft + p.offsetWidth / 2;
                        const d = Math.abs(sl + cw / 2 - pos);
                        if (d < minDist) { minDist = d; nearest = i; }
                    });
                    const target = photos[nearest]?.offsetLeft ?? 0;
                    if (Math.abs(sl - target) > 2) scrollContainer.scrollTo({ left: target, behavior: 'smooth' });
                }
                preloadAdjacentGalleryImages(scrollContainer);
            };
            let snapTimeout = null;
            const onScrollEnd = () => { clearTimeout(snapTimeout); snapTimeout = setTimeout(snapToNearest, 80); };
            let preloadThrottle = null;
            const onScrollPreload = () => {
                if (preloadThrottle) return;
                preloadThrottle = setTimeout(() => { preloadThrottle = null; preloadAdjacentGalleryImages(scrollContainer); }, 50);
            };
            scrollContainer.addEventListener('scroll', onScrollEnd, { passive: true });
            scrollContainer.addEventListener('scroll', onScrollPreload, { passive: true });
            if ('onscrollend' in scrollContainer) scrollContainer.addEventListener('scrollend', snapToNearest);
            if (abortSignal) abortSignal.addEventListener('abort', () => {
                clearTimeout(snapTimeout);
                clearTimeout(preloadThrottle);
                scrollContainer.removeEventListener('scroll', onScrollEnd);
                scrollContainer.removeEventListener('scroll', onScrollPreload);
                scrollContainer.removeEventListener('scrollend', snapToNearest);
            });
            preloadAdjacentGalleryImages(scrollContainer);
        }
        if (counter && photoCount > 1) {
            const updateCounter = () => {
                let currentIndex = 1;
                if (isVertical) {
                    const containerHeight = scrollContainer.clientHeight;
                    const scrollTop = scrollContainer.scrollTop;
                    photos.forEach((photo, photoIdx) => {
                        const c = photo.offsetTop + photo.offsetHeight / 2;
                        if (c >= scrollTop && c <= scrollTop + containerHeight) currentIndex = photoIdx + 1;
                    });
                } else {
                    const containerWidth = scrollContainer.clientWidth;
                    const scrollLeft = scrollContainer.scrollLeft;
                    photos.forEach((photo, photoIdx) => {
                        const photoCenter = photo.offsetLeft + photo.offsetWidth / 2;
                        if (photoCenter >= scrollLeft && photoCenter <= scrollLeft + containerWidth) currentIndex = photoIdx + 1;
                    });
                }
                counter.textContent = currentIndex;
            };
            const abortController = new AbortController();
            scrollContainer.addEventListener('scroll', updateCounter, { signal: abortController.signal });
            galleryScrollListeners.set(scrollContainer, abortController);
            updateCounter();
        }
    });
    if (window.showFeedOptions && !container._galleryFeedOptionsDelegate) {
        const delegateHandler = (e) => {
            const btn = e.target.closest('.feed-options-btn');
            if (!btn) return;
            e.stopPropagation();
            e.preventDefault();
            const entryId = btn.getAttribute('data-entry-id') || '';
            const photoUrls = btn.getAttribute('data-photo-urls') || '';
            const isBestShare = btn.getAttribute('data-is-best') === 'true';
            const photoDate = btn.getAttribute('data-photo-date') || '';
            const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
            const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
            const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
            const dateRangeText = btn.getAttribute('data-date-range-text') || '';
            const postId = btn.getAttribute('data-post-id') || '';
            const authorUserId = btn.getAttribute('data-author-user-id') || '';
            const caption = btn.getAttribute('data-caption') || '';
            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
        };
        container._galleryFeedOptionsDelegate = delegateHandler;
        container.addEventListener('click', delegateHandler);
    }
    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
    container.querySelectorAll('[data-requires-login="true"]').forEach(btn => {
        if (!isLoggedIn) { btn.classList.add('opacity-50', 'cursor-not-allowed'); btn.title = '로그인이 필요합니다'; if (btn.tagName === 'INPUT') { btn.disabled = true; btn.placeholder = '로그인 후 댓글을 달아보세요'; } }
        else { btn.classList.remove('opacity-50', 'cursor-not-allowed'); btn.title = ''; if (btn.tagName === 'INPUT') { btn.disabled = false; btn.placeholder = '댓글 달기...'; } }
    });
    markMomentFeedPhotosLoadedIn(container);
    if (container.classList.contains('moment-feed-layout-v2') || container.getAttribute('data-moment-feed-layout') === '2') {
        setupMomentFeedV2WheelLayout(container);
    }
}

/**
 * 모먼트 휠 오버레이·더보기 공용: 다음 공유 페이지를 불러와 갤러리에 삽입.
 * @param {{ syncFeed?: boolean }} opts — 피드 탭 DOM과 맞출 때 `syncFeed: true` (갤러리만 쓰는 경우 생략)
 * @returns {Promise<{ ok: boolean, reason?: string, appended?: number }>}
 */
export async function appendMomentFeedNextPage(opts = {}) {
    const syncFeed = opts.syncFeed === true;
    const hasMore = appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc;
    if (!hasMore) return { ok: false, reason: 'no-more' };
    try {
        const { loadSharedPhotosPageReliable } = await import('../db.js');
        const { docs, lastDoc, hasMore: nextHasMore } = await loadSharedPhotosPageReliable(10, appState.sharedPhotosFeedLastDoc, { maxAttempts: 2, timeoutMs: 8000 });
        appState.galleryFeedNetworkError = false;
        window.sharedPhotosFeed = collapseDocsToFeedPage(
            sortSharedPhotosByTimestampDesc([...(window.sharedPhotosFeed || []), ...docs]),
            999
        ).feedDocs;
        appState.sharedPhotosFeedLastDoc = lastDoc;
        appState.sharedPhotosFeedHasMore = nextHasMore;

        // 전체 재렌더(forceReload) 대신 새 게시물만 DOM 끝에 추가한다.
        // → 기존 게시물·이미지·스크롤 위치가 그대로 유지되어, 더보기 시 스크롤이 위아래로 튀지 않는다.
        const loadMoreWrap = document.getElementById('galleryLoadMoreWrap');
        const postsInsertPoint = document.getElementById('galleryPostsInsertPoint');
        let appended = 0;
        if (
            loadMoreWrap &&
            postsInsertPoint &&
            !appState.galleryFilterUserId &&
            !appState.galleryTraceFilter &&
            !appState.gallerySearchActive
        ) {
            appended = (await appendGalleryPosts(docs, loadMoreWrap)) || 0;
        } else {
            // 갤러리 구조가 없거나(필터/그리드 모드 등) 부분 추가가 불가능하면 안전하게 전체 렌더로 폴백
            await renderGallery({ skipScrollToTop: true, forceReload: true });
        }

        if (syncFeed) {
            const { renderFeed } = await import('./feed.js');
            await renderFeed();
        }
        return { ok: true, appended: appended || docs.length };
    } catch (e) {
        console.error('공유 사진 더보기 실패:', e);
        appState.galleryFeedNetworkError = true;
        return { ok: false, reason: 'error', error: e };
    }
}

/** 더보기 시 새 포스트만 DOM에 추가 (전체 재렌더 없이 깜박임 방지) */
async function appendGalleryPosts(docs, loadMoreWrap) {
    if (!docs || docs.length === 0 || !loadMoreWrap || !loadMoreWrap.parentNode) return 0;
    const container = document.getElementById('galleryContainer');
    if (!container) return 0;
    let newGroups = docsToSortedPhotoGroups(docs);
    if (newGroups.length === 0) return 0;
    // 이미 DOM에 렌더된 게시물은 제외 (페이지 경계에서 같은 게시물이 두 번 들어가는 것 방지)
    const existingPostIds = new Set(
        Array.from(container.querySelectorAll('.instagram-post[data-post-id]'))
            .map((el) => el.getAttribute('data-post-id'))
            .filter(Boolean)
    );
    newGroups = newGroups.filter((g) => {
        const pid = getPostIdFromPhotoGroup(g);
        return pid != null && !existingPostIds.has(String(pid));
    });
    if (newGroups.length === 0) return 0;
    // 새로 추가되는 작성자들의 프로필을 먼저 로드해 두어 닉네임이 '익명'으로 나오지 않도록 함
    await fetchUserProfiles([...new Set(docs.map(p => p.userId).filter(Boolean))]);
    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => { if (meal.id) mealHistoryMap.set(String(meal.id), meal); });
    }
    const existingCount = container.querySelectorAll('.instagram-post').length;
    const newPostsHtml = newGroups
        .map((photoGroup, i) =>
            renderPostGroupHtml(photoGroup, existingCount + i, mealHistoryMap, {
                layoutV2: galleryMomentLayoutV2,
                useGalleryPostGap: galleryMomentLayoutV2
            })
        )
        .join('');
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = newPostsHtml;
    while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);
    // 게시물은 `#galleryPostsInsertPoint` 안에만 추가(화면2는 열 `gap`으로 간격 일관)
    const insert = document.getElementById('galleryPostsInsertPoint');
    if (insert) {
        insert.appendChild(fragment);
    } else {
        loadMoreWrap.parentNode.insertBefore(fragment, loadMoreWrap);
    }
    // 삽입 직후 즉시(50ms 대기 없이) 캐시된 사진을 노출해 더보기 시 깜빡임 제거
    markMomentFeedPhotosLoadedIn(container);
    const fullSortedGroups = docsToSortedPhotoGroups(window.sharedPhotosFeed || []);
    const appendedEnd = existingCount + newGroups.length;
    setTimeout(() => {
        setupGalleryEventListeners(container, fullSortedGroups, { startIndex: existingCount });
        fetchMissingSharedComments(container).catch(() => {});
        applyMomentCaptionLayoutForRange(existingCount, appendedEnd);
        if (window.postInteractions && intersectionObserver) {
            container.querySelectorAll('.instagram-post').forEach((post, i) => {
                if (i >= existingCount && document.contains(post)) intersectionObserver.observe(post);
            });
        }
    }, 50);
    return newGroups.length;
}


export async function renderGallery(options = {}) {
    const skipScrollToTop = options.skipScrollToTop === true; // 더보기 시 스크롤 위치 유지
    const forceReload = options.forceReload === true; // 다시 불러오기: 뮤텍스 조기 반환으로 UI가 안 갱신되는 것 방지
    const savedScrollY = skipScrollToTop ? window.scrollY : 0; // 더보기 시 복원용
    // 중복 실행 방지 (완료 후 pending이 있으면 한 번 더 실행)
    if (!forceReload && isRenderingGallery) {
        galleryRenderPending = true;
        console.log('[renderGallery] 이미 실행 중 — 완료 후 재실행 예약');
        return;
    }

    const mySession = galleryRenderSession;
    try {
        isRenderingGallery = true;
        console.log('[renderGallery] 시작, window.sharedPhotos:', window.sharedPhotos?.length || 0);
        
        const container = document.getElementById('galleryContainer');
        if (!container) {
            console.warn('[renderGallery] galleryContainer를 찾을 수 없습니다');
            return;
        }

        try {
            galleryMomentLayoutV2 = (await getMomentsFeedView()) === '2';
        } catch (_) {
            galleryMomentLayoutV2 = false;
        }
        container.classList.toggle('moment-feed-layout-v2', galleryMomentLayoutV2);
        container.setAttribute('data-moment-feed-layout', galleryMomentLayoutV2 ? '2' : '1');

        // ===== STRICT CLEANUP: 모든 Observer와 비동기 작업을 먼저 정리 =====
        
        // 1. 이전 AbortController로 모든 비동기 작업 취소
        if (galleryAbortController) {
            galleryAbortController.abort();
        }
        galleryAbortController = new AbortController();
        const abortSignal = galleryAbortController.signal;
        
        // 2. 이전 스크롤 이벤트 리스너 정리
        galleryScrollListeners.forEach((abortController, scrollContainer) => {
            abortController.abort();
        });
        galleryScrollListeners.clear();
        
        // 3. 이전 Intersection Observer 정리
        if (intersectionObserver) {
            intersectionObserver.disconnect();
            intersectionObserver = null;
        }
        
        // 4. 이전 Placeholder Observer 정리
        if (placeholderObserver) {
            placeholderObserver.disconnect();
            placeholderObserver = null;
        }
        
        // 5–6. 포스트 로드 큐·캐시 초기화
        clearMomentPostInteractionQueue();
        
        // 7. 갤러리 피드 옵션 위임 리스너 제거 (재설정 시 중복 방지)
        if (container._galleryFeedOptionsDelegate) {
            container.removeEventListener('click', container._galleryFeedOptionsDelegate);
            delete container._galleryFeedOptionsDelegate;
        }
        
        // 사용자 필터링 적용
    const filterUserId = appState.galleryFilterUserId;
    const galleryFilterTab = appState.galleryFilterTab || 'moment';
    let photosToRender;
    if (filterUserId) {
        try {
            if (appState.galleryUserProfileSharedForUserId !== filterUserId) {
                appState.galleryUserProfileSharedDocs = null;
                appState.galleryUserProfileSharedLastSnap = null;
                appState.galleryUserProfileSharedHasMore = true;
                appState.galleryUserProfileSharedForUserId = filterUserId;
                appState.galleryUserProfileSharedDocSnaps = new Map();
            }
            if (!appState.galleryUserProfileSharedDocSnaps) {
                appState.galleryUserProfileSharedDocSnaps = new Map();
            }
            if (appState.galleryUserProfileSharedDocs === null) {
                const { docs, lastDocSnap, hasMore } = await loadSharedPhotosByUserUpToPostCount(
                    filterUserId,
                    null,
                    USER_PROFILE_MOMENT_GRID_PAGE_SIZE,
                    [],
                    appState.galleryUserProfileSharedDocSnaps
                );
                if (isGallerySessionStale(mySession)) return;
                appState.galleryUserProfileSharedDocs = docs;
                appState.galleryUserProfileSharedLastSnap = lastDocSnap;
                appState.galleryUserProfileSharedHasMore = hasMore;
            }
            photosToRender = appState.galleryUserProfileSharedDocs || [];
            appState.galleryFeedNetworkError = false;
        } catch (e) {
            console.error('모먼트(사용자) 로드 실패:', e);
            appState.galleryFeedNetworkError = true;
            photosToRender = [];
        }
    } else if (appState.galleryFilterPostId && !filterUserId) {
        // 알림 「댓글 달린 게시물」: 전역 피드 첫 페이지에 없어도 내 공유에서 직접 로드
        const filterPid = String(appState.galleryFilterPostId || '').trim();
        let notifPhotos = Array.isArray(appState.galleryNotificationFilterPhotos)
            ? appState.galleryNotificationFilterPhotos
            : null;
        if (!notifPhotos?.length && window.currentUser?.uid) {
            try {
                notifPhotos = await loadSharedPhotosForMomentNotification(filterPid, window.currentUser.uid);
            } catch (_) {
                notifPhotos = [];
            }
        }
        if (isGallerySessionStale(mySession)) return;
        if (notifPhotos?.length) {
            appState.galleryNotificationFilterPhotos = notifPhotos;
            photosToRender = sortSharedPhotosByTimestampDesc(notifPhotos);
            appState.galleryFeedNetworkError = false;
        } else {
            photosToRender = sortSharedPhotosByTimestampDesc(window.sharedPhotosFeed || []);
            appState.galleryFeedNetworkError = false;
        }
    } else if (appState.gallerySearchActive && !filterUserId) {
        const expanded = await expandFeedForGallerySearch(mySession);
        if (isGallerySessionStale(mySession)) return;
        photosToRender = sortSharedPhotosByTimestampDesc(expanded);
        appState.galleryFeedNetworkError = false;
    } else {
        photosToRender = sortSharedPhotosByTimestampDesc(window.sharedPhotosFeed || []);
    }
    
    // 사용자 프로필 뷰일 때 최상단 앱 헤더 숨김
    const mainHeader = document.querySelector('#mainApp > header');
    if (mainHeader) {
        if (filterUserId) mainHeader.classList.add('hidden');
        else mainHeader.classList.remove('hidden');
    }
    
    // 디버깅: 일간보기 공유 확인
    const dailyShares = photosToRender.filter(p => p.type === 'daily');
    console.log('renderGallery - 일간보기 공유 개수:', dailyShares.length, dailyShares);
    
    // 필터링된 사용자 정보 표시 (상단) — 프로필·소개글·모먼트/게시판 탭
    let userProfileHeader = '';
    if (filterUserId) {
        await fetchUserProfiles([filterUserId]);
        if (isGallerySessionStale(mySession)) return;
        const filteredUserPhoto = photosToRender[0] || null;
        const initialDisplay = filteredUserPhoto
            ? getDisplayProfile(filteredUserPhoto.userId, { nickname: filteredUserPhoto.userNickname, icon: filteredUserPhoto.userIcon, photoUrl: filteredUserPhoto.userPhotoUrl })
            : getDisplayProfile(filterUserId, { nickname: '로딩...', icon: null, photoUrl: null });
        const initialAvatar = getProfileAvatarDisplay(initialDisplay);
        (async () => {
            if (abortSignal && abortSignal.aborted) return;
            try {
                const userSettings = await getUserSettings(filterUserId);
                const { db, appId } = await import('../firebase.js');
                const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js");
                const userDocSnap = await getDoc(doc(db, 'artifacts', appId, 'users', filterUserId));
                const existingHeader = container.querySelector('.gallery-user-profile-header');
                if (!existingHeader) return;
                const bio = (userSettings?.profile?.bio && String(userSettings.profile.bio).trim()) || '';
                const bioEl = existingHeader.querySelector('.gallery-filter-bio');
                if (bioEl) {
                    if (bio) {
                        bioEl.textContent = bio;
                        bioEl.classList.remove('text-slate-400', 'italic');
                        bioEl.classList.add('text-slate-600');
                    } else {
                        bioEl.textContent = '아직 소개가 없습니다.';
                        bioEl.classList.add('text-slate-400', 'italic');
                        bioEl.classList.remove('text-slate-600');
                    }
                }
                let joinedStr = '';
                if (userDocSnap.exists()) {
                    const data = userDocSnap.data();
                    const createdAt = data.createdAt;
                    if (createdAt) {
                        try {
                            const d = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
                            if (!isNaN(d.getTime())) joinedStr = '가입일 ' + d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
                        } catch (_) {}
                    }
                }
                const joinedEl = existingHeader.querySelector('.gallery-filter-joined');
                if (joinedEl) joinedEl.textContent = joinedStr;
                if (!filteredUserPhoto && userSettings?.profile) {
                    const nickEl = existingHeader.querySelector('.gallery-filter-nickname');
                    const iconEl = existingHeader.querySelector('.gallery-filter-icon');
                    const photoEl = existingHeader.querySelector('.gallery-filter-photo');
                    const disp = getDisplayProfile(filterUserId, { nickname: userSettings.profile.nickname, icon: userSettings.profile.icon, photoUrl: userSettings.profile.photoUrl });
                    if (nickEl) nickEl.textContent = disp.nickname || '익명';
                    if (iconEl) {
                        const avatar = getProfileAvatarDisplay(disp);
                        if (avatar.type === 'photo') {
                            iconEl.textContent = '';
                            iconEl.style.backgroundImage = `url(${avatar.value})`;
                            iconEl.className = 'gallery-filter-icon gallery-user-profile-avatar';
                        } else {
                            iconEl.textContent = avatar.value;
                            iconEl.style.backgroundImage = '';
                            iconEl.className = `gallery-filter-icon gallery-user-profile-avatar gallery-user-profile-avatar--fallback${avatar.type === 'emoji' ? ' gallery-user-profile-avatar--emoji' : ''}`;
                        }
                    }
                    if (photoEl && disp.photoUrl) {
                        photoEl.style.backgroundImage = `url(${disp.photoUrl})`;
                        photoEl.classList.add('bg-cover', 'bg-center');
                    }
                }
            } catch (_) {
                const hdr = container.querySelector('.gallery-user-profile-header');
                if (!hdr) return;
                const bioEl = hdr.querySelector('.gallery-filter-bio');
                if (bioEl) {
                    bioEl.textContent = '아직 소개가 없습니다.';
                    bioEl.classList.add('text-slate-400', 'italic');
                    bioEl.classList.remove('text-slate-600');
                }
            }
        })();
        
        const isFilteredUserGuest = window.currentUser && window.currentUser.isAnonymous && filterUserId === window.currentUser.uid;
        userProfileHeader = `
            <div class="gallery-user-profile-header">
                <div class="gallery-user-profile-scrollable">
                    <div class="gallery-user-profile-top">
                        <button type="button" onclick="window.clearGalleryFilter()" class="gallery-user-profile-back" aria-label="뒤로가기">
                            <svg class="gallery-user-profile-back__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M19 12H5"></path>
                                <path d="m12 19-7-7 7-7"></path>
                            </svg>
                        </button>
                        <div class="gallery-user-profile-identity">
                            ${initialAvatar.type === 'photo' ? `
                                <div class="gallery-filter-photo gallery-user-profile-avatar" style="background-image: url(${initialAvatar.value});"></div>
                            ` : `
                                <div class="gallery-filter-icon gallery-user-profile-avatar gallery-user-profile-avatar--fallback ${initialAvatar.type === 'emoji' ? 'gallery-user-profile-avatar--emoji' : ''}">${escapeHtml(initialAvatar.value)}</div>
                            `}
                            <div class="gallery-user-profile-meta min-w-0">
                                <div class="gallery-filter-nickname">${initialDisplay.nickname || '익명'}</div>
                                <div class="gallery-filter-joined"></div>
                            </div>
                        </div>
                    </div>
                    <div class="gallery-user-profile-bio-wrap">
                        <div class="gallery-filter-bio text-slate-400 italic">불러오는 중…</div>
                    </div>
                </div>
                <div class="gallery-filter-tabs sticky top-0 z-30" role="tablist" aria-label="내 게시물 유형">
                    <button type="button" role="tab" aria-selected="${galleryFilterTab === 'moment' ? 'true' : 'false'}" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('moment')" class="gallery-filter-tab-btn ${galleryFilterTab === 'moment' ? 'is-active' : ''}">모먼트</button>
                    <button type="button" role="tab" aria-selected="${galleryFilterTab === 'board' ? 'true' : 'false'}" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('board')" class="gallery-filter-tab-btn ${galleryFilterTab === 'board' ? 'is-active' : ''}">게시판</button>
                </div>
            </div>
        `;
    }
    
    // 사용자 프로필 뷰 + 밀톡 탭: 밀톡 탭과 동일한 목록 렌더링 (renderBoardPostList)
    if (filterUserId && galleryFilterTab === 'board') {
        container.innerHTML = userProfileHeader + `
            <div id="galleryFilterBoardList" class="pt-1 pb-4">
                <div class="flex justify-center py-8"><i data-lucide="loader-circle" class="text-2xl text-slate-300 lucide-spin"></i></div>
            </div>
        `;
        (async () => {
            try {
                const { boardOperations } = await import('../db.js');
                const [posts, liked, bookmarked, commented] = await Promise.all([
                    boardOperations.getPostsByAuthor(filterUserId, 50),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
                ]);
                const listEl = document.getElementById('galleryFilterBoardList');
                if (!listEl || (abortSignal && abortSignal.aborted)) return;
                const likedPostIds = new Set(liked || []);
                const bookmarkedPostIds = new Set(bookmarked || []);
                const postIdsCommentedByUser = new Set(commented || []);
                if (posts.length === 0) {
                    listEl.innerHTML = `
                        <div class="flex flex-col items-center justify-center py-12 text-center">
                            <i data-lucide="message-circle" class="text-4xl text-slate-200 mb-3"></i>
                            <p class="text-sm font-bold text-slate-400">작성한 글이 없습니다</p>
                            <p class="text-xs text-slate-300 mt-2">첫 번째 게시글을 작성해보세요!</p>
                        </div>
                    `;
                } else {
                    await renderBoardPostList(listEl, posts, likedPostIds, bookmarkedPostIds, null, postIdsCommentedByUser);
                }
            } catch (e) {
                console.warn('getPostsByAuthor 실패:', e);
                const listEl = document.getElementById('galleryFilterBoardList');
                if (listEl && !(abortSignal && abortSignal.aborted)) {
                    listEl.innerHTML = `<div class="flex flex-col items-center justify-center py-8 text-center">
                        <p class="text-slate-400 text-sm mb-3">글 목록을 불러오지 못했습니다.</p>
                        <button type="button" onclick="window.renderGallery && window.renderGallery()" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold rounded-lg inline-flex items-center gap-1.5">
                            <i data-lucide="rotate-cw"></i>다시 불러오기
                        </button>
                    </div>`;
                }
            } finally {
                isRenderingGallery = false;
            }
        })();
        scheduleLucideIcons(container);
        if (window.syncBottomNavForGalleryFilter) window.syncBottomNavForGalleryFilter();
        return;
    }
    
    if (photosToRender.length === 0) {
        container.innerHTML = userProfileHeader + buildGalleryEmptyMomentBlock(!!appState.galleryFeedNetworkError, filterUserId);
        // 이전 포스트 ID 목록 초기화
        previousGalleryPostIds.clear();
        scheduleLucideIcons(container);
        if (window.syncBottomNavForGalleryFilter) window.syncBottomNavForGalleryFilter();
        // 빈 갤러리일 때도 맨 위로 스크롤
        setTimeout(() => {
            if (!abortSignal || !abortSignal.aborted) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }, 100);
        isRenderingGallery = false;
        return;
    }
    
    // v2 게시물 + legacy v1 사진 → 그룹화·최신순
    const uniquePhotos = dedupeGalleryPhotos(photosToRender);

    const galleryUserIds = [...new Set(uniquePhotos.map(p => p.userId).filter(Boolean))];
    await fetchUserProfiles(galleryUserIds);
    if (isGallerySessionStale(mySession)) return;

    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => {
            if (meal.id) mealHistoryMap.set(String(meal.id), meal);
        });
    }
    const renderPostGroup = (photoGroup, groupIdx) =>
        renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap, {
            layoutV2: galleryMomentLayoutV2,
            useGalleryPostGap: galleryMomentLayoutV2
        });

    let sortedGroups = docsToSortedPhotoGroups(uniquePhotos);
    
    // 앨범 흔적 필터: 본인이 좋아요/댓글/북마크한 게시물 (피드에 로드된 범위 + 필요 시 추가 로드)
    let tracePostIds = null;
    let traceListCount = 0;
    if (appState.galleryTraceFilter && !appState.galleryFilterPostId && window.currentUser && !window.currentUser.isAnonymous && window.postInteractions) {
        if (appState.galleryTraceFilter !== previousGalleryTraceFilter) {
            previousGalleryPostIds.clear();
            previousGalleryTraceFilter = appState.galleryTraceFilter;
        }
        let list = [];
        if (appState.galleryTraceFilter === 'like') {
            list = await window.postInteractions.getPostIdsLikedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'comment') {
            list = await window.postInteractions.getPostIdsCommentedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'bookmark') {
            list = await window.postInteractions.getPostIdsBookmarkedByUser(window.currentUser.uid);
        }
        if (isGallerySessionStale(mySession)) return;
        traceListCount = list.length;
        tracePostIds = new Set(list);
        if (traceListCount > 0 && !filterUserId) {
            const traceFeedDocs = await expandFeedForTraceFilter(tracePostIds, mySession);
            if (isGallerySessionStale(mySession)) return;
            const expandedUnique = dedupeGalleryPhotos(
                sortSharedPhotosByTimestampDesc(traceFeedDocs)
            );
            sortedGroups = docsToSortedPhotoGroups(expandedUnique);
        }
        sortedGroups = sortedGroups.filter((g) => photoGroupMatchesTracePostIds(g, tracePostIds));
    } else if (appState.galleryTraceFilter !== previousGalleryTraceFilter) {
        previousGalleryPostIds.clear();
        previousGalleryTraceFilter = appState.galleryTraceFilter;
    }

    if (appState.gallerySearchActive && appState.gallerySearchDateRange) {
        const { start, end } = appState.gallerySearchDateRange;
        sortedGroups = sortedGroups.filter((g) => {
            const ymd = getPhotoGroupDateYmd(g);
            return ymd && ymd >= start && ymd <= end;
        });
    }

    const searchKeyword = (appState.gallerySearchKeyword || '').trim();
    if (appState.gallerySearchActive && searchKeyword) {
        sortedGroups = sortedGroups.filter((g) => photoGroupMatchesKeyword(g, searchKeyword, mealHistoryMap));
    }
    
    // 알림에서 클릭 시 해당 게시물만 필터 (legacy·entryId_uid·그룹키 후보 매칭)
    const filterPostId = appState.galleryFilterPostId;
    if (filterPostId) {
        const filterSet = new Set([String(filterPostId)]);
        sortedGroups = sortedGroups.filter((g) => photoGroupMatchesTracePostIds(g, filterSet));
    }
    
    // 코멘트가 비어 있을 수 있는 글은 렌더와 동시에 미리 요청 (체감 지연 감소)
    let sharedCommentsPromise = null;
    const needCommentItems = [];
    for (const g of sortedGroups) {
        const photo = g[0];
        if (!photo || photo.type === 'best' || photo.type === 'daily' || photo.type === 'insight') continue;
        const eid = photo.entryId;
        const uid = photo.userId;
        if (!eid || !uid || (window.currentUser && uid === window.currentUser.uid)) continue;
        const hasComment = photo.comment || (mealHistoryMap.get(eid) && mealHistoryMap.get(eid).comment);
        if (hasComment) continue;
        needCommentItems.push({ entryId: eid, ownerUserId: uid });
    }
    if (needCommentItems.length > 0) {
        sharedCommentsPromise = import('../firebase.js').then(mod => {
            const fn = mod.callableFunctions?.getSharedEntryComments;
            return fn ? fn({ items: needCommentItems }) : { data: { comments: [] } };
        }).catch(() => ({ data: { comments: [] } }));
    }
    
    const traceEmptyLabels = { like: '좋아요한', comment: '댓글 단', bookmark: '북마크한' };
    const searchEmptyMsg =
        appState.gallerySearchActive && sortedGroups.length === 0
            ? '검색 조건에 맞는 게시물이 없습니다'
            : null;
    const traceEmptyMsg =
        !searchEmptyMsg && tracePostIds && sortedGroups.length === 0
            ? traceListCount === 0
                ? `${traceEmptyLabels[appState.galleryTraceFilter] || ''} 게시물이 없습니다`
                : `${traceEmptyLabels[appState.galleryTraceFilter] || ''} 게시물을 피드에서 찾지 못했어요`
            : null;
    
    const traceEmptyIcon = appState.galleryTraceFilter === 'like' ? 'fa-heart' : (appState.galleryTraceFilter === 'comment' ? 'fa-comment' : 'fa-bookmark');
    
    // 알림 필터 시 빈 메시지 (해당 게시물이 없을 때)
    const filterPostEmptyMsg = filterPostId && sortedGroups.length === 0 ? '해당 게시물을 찾을 수 없습니다' : null;
    
    // 네트워크 단절 등으로 피드 로드 실패 (흔적/알림 필터 적용 후에도 그룹이 비었을 때)
    const showNetworkErrorEmpty = sortedGroups.length === 0 && appState.galleryFeedNetworkError;

    const isUserProfileMomentGrid =
        filterUserId &&
        galleryFilterTab === 'moment' &&
        !appState.galleryFilterPostId;

    if (isUserProfileMomentGrid) {
        if (abortSignal.aborted) {
            isRenderingGallery = false;
            return;
        }
        const gridEmptyMsg = showNetworkErrorEmpty ? null : traceEmptyMsg;
        const gridEmptyIcon = traceEmptyIcon;
        let gridBody = '';
        if (showNetworkErrorEmpty) {
            gridBody = buildGalleryEmptyMomentBlock(true, filterUserId);
        } else if (sortedGroups.length === 0) {
            gridBody = gridEmptyMsg
                ? `<div class="flex flex-col items-center justify-center py-20 text-center px-4">
                <i class="fa-regular ${gridEmptyIcon} text-6xl text-slate-200 mb-4" aria-hidden="true"></i>
                <p class="text-sm font-bold text-slate-400">${gridEmptyMsg}</p>
            </div>`
                : buildGalleryEmptyMomentBlock(false, filterUserId);
        } else {
            let vis = appState.galleryUserProfileMomentVisiblePostCount;
            if (typeof vis !== 'number' || vis < USER_PROFILE_MOMENT_GRID_PAGE_SIZE) {
                vis = USER_PROFILE_MOMENT_GRID_PAGE_SIZE;
                appState.galleryUserProfileMomentVisiblePostCount = vis;
            }
            if (sortedGroups.length > 0) {
                vis = Math.min(vis, sortedGroups.length);
                appState.galleryUserProfileMomentVisiblePostCount = vis;
            }
            const gridSlice = sortedGroups.slice(0, vis);
            gridBody = buildUserProfileMomentGridHtml(gridSlice);
            const remainLocal = sortedGroups.length - gridSlice.length;
            const hasMoreServer = appState.galleryUserProfileSharedHasMore === true;
            if (remainLocal > 0 || hasMoreServer) {
                gridBody += `
            <div class="flex justify-center py-5 px-4 bg-white border-t border-slate-100">
                <button type="button" id="galleryUserMomentGridLoadMoreBtn" class="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors disabled:opacity-60">
                    <i data-lucide="chevron-down" class="mr-1.5" aria-hidden="true"></i>더보기
                </button>
            </div>`;
            }
        }
        container.innerHTML = userProfileHeader + gridBody;
        if (sortedGroups.length > 0 && !showNetworkErrorEmpty) {
            bindUserProfileMomentGridClicks(container);
            const lm = document.getElementById('galleryUserMomentGridLoadMoreBtn');
            if (lm) {
                lm.addEventListener('click', async () => {
                    if (sortedGroups.length > appState.galleryUserProfileMomentVisiblePostCount) {
                        appState.galleryUserProfileMomentVisiblePostCount = Math.min(
                            appState.galleryUserProfileMomentVisiblePostCount + USER_PROFILE_MOMENT_GRID_PAGE_SIZE,
                            sortedGroups.length
                        );
                        renderGallery();
                        return;
                    }
                    if (!appState.galleryUserProfileSharedHasMore) return;
                    const lastSnap = appState.galleryUserProfileSharedLastSnap;
                    if (!lastSnap) {
                        appState.galleryUserProfileSharedHasMore = false;
                        renderGallery();
                        return;
                    }
                    lm.disabled = true;
                    const prev = lm.innerHTML;
                    lm.innerHTML = '<i data-lucide="loader-circle" class="mr-1.5 lucide-spin" aria-hidden="true"></i><span class="text-slate-500">불러오는 중…</span>';
                    try {
                        const acc = appState.galleryUserProfileSharedDocs || [];
                        const currentGridGroups = countMomentPostsFromDocs(acc);
                        const targetPosts = currentGridGroups + USER_PROFILE_MOMENT_GRID_PAGE_SIZE;
                        if (!appState.galleryUserProfileSharedDocSnaps) {
                            appState.galleryUserProfileSharedDocSnaps = new Map();
                        }
                        const { docs: merged, lastDocSnap, hasMore } = await loadSharedPhotosByUserUpToPostCount(
                            filterUserId,
                            lastSnap,
                            targetPosts,
                            acc,
                            appState.galleryUserProfileSharedDocSnaps
                        );
                        appState.galleryUserProfileSharedDocs = merged;
                        appState.galleryUserProfileSharedLastSnap = lastDocSnap;
                        appState.galleryUserProfileSharedHasMore = hasMore;
                        const mergedGroups = countMomentPostsFromDocs(merged);
                        appState.galleryUserProfileMomentVisiblePostCount = Math.min(
                            appState.galleryUserProfileMomentVisiblePostCount + USER_PROFILE_MOMENT_GRID_PAGE_SIZE,
                            mergedGroups
                        );
                        appState.galleryFeedNetworkError = false;
                    } catch (err) {
                        console.error('모먼트(사용자) 추가 로드 실패:', err);
                        appState.galleryFeedNetworkError = true;
                        if (typeof showToast === 'function') showToast('더 불러오지 못했습니다. 연결을 확인해 주세요.', 'error');
                        lm.innerHTML = prev;
                        lm.disabled = false;
                        return;
                    }
                    await renderGallery();
                });
            }
        }
        previousGalleryPostIds.clear();
        isRenderingGallery = false;
        return;
    }
    
    // ===== DIFFING: 변경사항이 작으면 차등 업데이트, 크면 전체 재렌더링 =====
    const currentPostIds = new Set(sortedGroups.map(g => getPostIdFromPhotoGroup(g)));
    // 삭제(공유해제·차단·순서 재정렬 가능성)는 부분 갱신으로 안전히 반영하기 어려우므로 전체 재렌더로 폴백.
    // 추가만 있는 경우(그것도 소량)만 차등(맨 위 prepend) 경로로 처리해 기존 사진·스크롤을 보존한다.
    const removedPostIds = Array.from(previousGalleryPostIds).filter((id) => !currentPostIds.has(id));
    const addedPostIds = Array.from(currentPostIds).filter((id) => !previousGalleryPostIds.has(id));
    const hasSignificantChanges =
        !!appState.gallerySearchActive ||
        !!appState.galleryTraceFilter ||
        previousGalleryPostIds.size === 0 || // 초기 로드
        currentPostIds.size === 0 || // 모든 포스트 삭제
        removedPostIds.length > 0 || // 삭제·재정렬 → 전체 재렌더로 정합성 보장
        addedPostIds.length > 5; // 대량 추가 → 전체 재렌더
    
    const emptyMsg = showNetworkErrorEmpty ? null : (searchEmptyMsg || filterPostEmptyMsg || traceEmptyMsg);
    const emptyIcon = searchEmptyMsg ? 'fa-magnifying-glass' : (filterPostEmptyMsg ? 'fa-comment' : traceEmptyIcon);

    const gallerySearchBanner = appState.gallerySearchActive && !filterUserId
        ? `<div class="px-4 py-2.5 mb-1 flex items-start justify-between gap-2 border-b border-slate-100 bg-white sticky top-0 z-20">
            <div class="min-w-0">
                <div class="text-sm font-bold text-slate-700">검색 결과 ${sortedGroups.length}건</div>
                <div class="text-xs text-slate-500 mt-0.5 truncate">${escapeHtml(formatGallerySearchSummary())}</div>
            </div>
            <button type="button" id="gallerySearchExitBtn" class="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 transition-colors">검색 종료</button>
        </div>`
        : '';
    
    // AbortSignal 체크: 취소되었으면 중단
    if (abortSignal.aborted) {
        console.log('[renderGallery] AbortSignal 감지 - 렌더링 중단');
        isRenderingGallery = false;
        return;
    }
    
    // 헤더와 빈 메시지만 먼저 렌더링 (네트워크 오류 > 알림/흔적 필터 빈 메시지)
    const headerHtml = gallerySearchBanner + userProfileHeader + (showNetworkErrorEmpty
        ? buildGalleryEmptyMomentBlock(true, filterUserId)
        : (emptyMsg ? `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-regular ${emptyIcon} text-6xl text-slate-200 mb-4"></i>
                <p class="text-sm font-bold text-slate-400">${emptyMsg}</p>
            </div>
        ` : ''));
    
    // 더보기 표시 여부 (타임라인처럼 초기 구조에 포함하여 누락 방지)
    const canLoadMore =
        !appState.gallerySearchActive &&
        !filterUserId &&
        !appState.galleryFilterPostId &&
        !appState.galleryTraceFilter &&
        (appState.sharedPhotosFeedHasMore || (sortedGroups.length >= 10 && appState.sharedPhotosFeedLastDoc));
    const loadMoreHtml = canLoadMore ? `
        <div id="galleryLoadMoreWrap" class="flex justify-center py-6">
            <button id="galleryLoadMoreBtn" type="button" class="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors">
                <i data-lucide="chevron-down" class="mr-1.5"></i>더보기
            </button>
        </div>
    ` : '';

    // 변경사항이 크거나 초기 로드면 전체 재렌더링
    if (hasSignificantChanges) {
        container.innerHTML = headerHtml + '<div id="galleryPostsInsertPoint"></div>' + loadMoreHtml;
    } else {
        // 차등 업데이트: 새로 추가된 포스트만 prepend
        const newPostIds = Array.from(currentPostIds).filter(id => !previousGalleryPostIds.has(id));
        if (newPostIds.length > 0) {
            const newGroups = sortedGroups.filter(g => {
                const postId = getPostIdFromPhotoGroup(g);
                return newPostIds.includes(postId);
            });
            
            if (newGroups.length > 0) {
                // 헤더가 없으면 추가
                const existingHeader = container.querySelector('.bg-white.border-b.border-slate-200.sticky');
                if (!existingHeader && userProfileHeader) {
                    const headerDiv = document.createElement('div');
                    headerDiv.innerHTML = userProfileHeader;
                    container.insertBefore(headerDiv.firstChild, container.firstChild);
                }
                
                // 새 포스트를 맨 위에 추가
                const newPostsHtml = newGroups.map((photoGroup, idx) => {
                    const postId = getPostIdFromPhotoGroup(photoGroup);
                    const existingIdx = Array.from(currentPostIds).indexOf(postId);
                    return renderPostGroup(photoGroup, existingIdx);
                }).join('');
                
                const fragment = document.createDocumentFragment();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = newPostsHtml;
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
                
                // 게시물은 #galleryPostsInsertPoint 안에만 삽입 (전체 렌더·더보기와 동일)
                const postsInsertPoint = document.getElementById('galleryPostsInsertPoint');
                let diffInserted = false;
                if (postsInsertPoint && document.contains(postsInsertPoint) && !isGallerySessionStale(mySession)) {
                    const firstPost = postsInsertPoint.querySelector('.instagram-post');
                    if (firstPost && firstPost.parentNode === postsInsertPoint) {
                        postsInsertPoint.insertBefore(fragment, firstPost);
                        diffInserted = true;
                    } else {
                        postsInsertPoint.insertBefore(fragment, postsInsertPoint.firstChild);
                        diffInserted = true;
                    }
                }
                if (!diffInserted) {
                    // insert point 없음·세션 만료·DOM 경합 → 전체 재렌더로 폴백
                    container.innerHTML = headerHtml + '<div id="galleryPostsInsertPoint"></div>' + loadMoreHtml;
                } else {
                    // 삽입 직후 즉시 캐시된 사진 노출 (재렌더 깜빡임 제거)
                    markMomentFeedPhotosLoadedIn(container);

                    // 이전 포스트 ID 목록 업데이트
                    previousGalleryPostIds = new Set(currentPostIds);

                    // 이벤트 리스너만 다시 설정 (전체 재렌더링 없이)
                    setTimeout(() => {
                        if (abortSignal.aborted || isGallerySessionStale(mySession)) return;
                        setupGalleryEventListeners(container, sortedGroups, { abortSignal });
                        fetchMissingSharedComments(container).catch(() => {});
                        setupIntersectionObserver(container, abortSignal);
                    }, 50);

                    isRenderingGallery = false;
                    return; // 차등 업데이트 완료
                }
            }
        }
        
        // 차등 업데이트 실패 시 전체 재렌더링으로 폴백
        container.innerHTML = headerHtml + '<div id="galleryPostsInsertPoint"></div>' + loadMoreHtml;
    }

    // 더보기 이벤트 리스너 (초기 구조에 포함했으므로 여기서 바인딩)
    const postsInsertPoint = document.getElementById('galleryPostsInsertPoint') || container;
    if (canLoadMore) {
        const loadMoreWrap = document.getElementById('galleryLoadMoreWrap');
        const loadMoreBtn = document.getElementById('galleryLoadMoreBtn');
        const doLoadMore = async () => {
            if (!loadMoreBtn || loadMoreBtn.disabled) return;
            const hasMore = appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc;
            if (!hasMore) return;
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = '<i data-lucide="loader-circle" class="mr-1.5 lucide-spin"></i>로딩 중...';
            try {
                const res = await appendMomentFeedNextPage();
                loadMoreBtn.disabled = false;
                if (res?.ok) {
                    loadMoreBtn.innerHTML = '<i data-lucide="chevron-down" class="mr-1.5"></i>더보기';
                    if (!appState.sharedPhotosFeedHasMore) {
                        document.getElementById('galleryLoadMoreWrap')?.remove();
                    }
                } else if (res?.reason === 'error') {
                    if (typeof showToast === 'function') showToast('네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
                    loadMoreBtn.innerHTML = '<i data-lucide="chevron-down" class="mr-1.5"></i>다시 시도';
                } else {
                    loadMoreBtn.innerHTML = '<i data-lucide="chevron-down" class="mr-1.5"></i>더보기';
                }
            } catch (e) {
                console.error('공유 사진 더보기 실패:', e);
                appState.galleryFeedNetworkError = true;
                if (typeof showToast === 'function') showToast('네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i data-lucide="chevron-down" class="mr-1.5"></i>다시 시도';
            }
        };
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', doLoadMore);
            if (loadMoreWrap && typeof IntersectionObserver !== 'undefined') {
                const loadMoreObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting && (appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc) && !loadMoreBtn.disabled) {
                            doLoadMore();
                        }
                    });
                }, { rootMargin: '200px', threshold: 0.1 });
                loadMoreObserver.observe(loadMoreWrap);
            }
        }
    }

    // 초기 렌더링: 최대 10건 먼저 표시, 나머지는 더보기/스크롤로 로드
    const estimatedPostHeight = 600; // 각 포스트의 예상 높이
    const INITIAL_POSTS_COUNT = Math.min(10, Math.max(1, sortedGroups.length)); // 10건씩 끊어서 표시
    if (sortedGroups.length > 0) {
        postsInsertPoint.insertAdjacentHTML(
            'beforeend',
            buildMomentFeedSkeletonCardsHtml(
                INITIAL_POSTS_COUNT,
                galleryMomentLayoutV2,
                galleryMomentLayoutV2
            )
        );
    }

    // 초기 포스트만 먼저 렌더링 (비동기 배치 처리로 브라우저 블로킹 방지)
    const initialPosts = sortedGroups.slice(0, INITIAL_POSTS_COUNT);
    
    // 렌더링을 배치로 나누어 실행 (브라우저 프리즈 방지)
    let renderedIndex = 0;
    const POSTS_PER_BATCH = 2; // 한 번에 렌더링할 포스트 수 (작게 설정하여 블로킹 방지)
    
    function renderNextBatch() {
        // AbortSignal·세션 만료 체크 (탭 전환·재렌더 경합 시 중간 상태 고착 방지)
        if (abortSignal.aborted || isGallerySessionStale(mySession)) {
            console.log('[renderGallery] AbortSignal/세션 만료 — 배치 렌더링 중단');
            isRenderingGallery = false;
            return;
        }
        
        if (renderedIndex >= initialPosts.length) {
            removeRemainingMomentSkeletons(postsInsertPoint);
            // 모든 초기 포스트 렌더링 완료
            // 나머지 포스트는 placeholder로 렌더링 (스크롤 시 실제 포스트로 교체)
            if (sortedGroups.length > INITIAL_POSTS_COUNT) {
                const remainingCount = sortedGroups.length - INITIAL_POSTS_COUNT;
                const placeholderHtml = `<div id="gallery-placeholder" data-remaining="${remainingCount}" data-start-index="${INITIAL_POSTS_COUNT}" style="height: ${remainingCount * estimatedPostHeight}px;"></div>`;
                const placeholderDiv = document.createElement('div');
                placeholderDiv.innerHTML = placeholderHtml;
                postsInsertPoint.appendChild(placeholderDiv.firstChild);
            }
            // 더보기는 초기 구조에 이미 포함됨 (배치 완료 대기 없이 표시)

            // 이전 포스트 ID 목록 업데이트 (전체 재렌더링인 경우)
            previousGalleryPostIds = new Set(currentPostIds);
            // 코멘트 채우기는 50ms 대기 없이 곧바로 실행 (체감: 텍스트가 사진보다 늦게 뜨는 현상 완화)
            (() => {
                if (abortSignal.aborted) return;
                setupGalleryEventListeners(container, sortedGroups, { abortSignal });
                fetchMissingSharedComments(container, sharedCommentsPromise).catch(() => {});
            })();
            setTimeout(() => {
                if (abortSignal.aborted) {
                    console.log('[renderGallery] AbortSignal 감지 - 이벤트 리스너 설정 중단');
                    isRenderingGallery = false;
                    return;
                }
                // IntersectionObserver 설정 (포스트 렌더링 및 상호작용 로드용)
                setTimeout(() => {
                    if (abortSignal.aborted) {
                        console.log('[renderGallery] AbortSignal 감지 - Observer 설정 중단');
                        isRenderingGallery = false;
                        return;
                    }
                    setupIntersectionObserver(container, abortSignal);
                    setupLazyPostRenderer(container, sortedGroups, INITIAL_POSTS_COUNT, abortSignal);
                }, 200);
                
                // Comment 「더 보기」: 3줄 초과 시 본문 뒤 인라인으로만 표시
                setTimeout(() => {
                    if (abortSignal.aborted) return;
                    applyMomentCaptionLayoutForRange(0, initialPosts.length);
                }, 100);
                
                // 갤러리 렌더링 완료 후: 초기 진입은 맨 위로, 더보기 시에는 스크롤 위치 복원
                if (!abortSignal.aborted) {
                    if (skipScrollToTop && savedScrollY > 0) {
                        requestAnimationFrame(() => {
                            window.scrollTo({ top: savedScrollY, behavior: 'auto' });
                        });
                    } else if (!skipScrollToTop) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                }
            }, 50);
            
            return;
        }
        
        // 다음 배치 렌더링
        const batch = initialPosts.slice(renderedIndex, renderedIndex + POSTS_PER_BATCH);
        const batchHtml = batch.map((photoGroup, batchIdx) => {
            const groupIdx = renderedIndex + batchIdx;
            return renderPostGroup(photoGroup, groupIdx);
        }).join('');
        
        // DocumentFragment 사용하여 DOM 조작 최적화
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = batchHtml;
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }
        replaceMomentSkeletonWithBatch(postsInsertPoint, fragment, batch.length);
        markMomentFeedPhotosLoadedIn(postsInsertPoint);
        if (galleryMomentLayoutV2) {
            setupMomentFeedV2WheelLayout(postsInsertPoint);
        }
        const batchSize = batch.length;
        renderedIndex += batchSize;
        applyMomentCaptionLayoutForRange(renderedIndex - batchSize, renderedIndex);
        
        // 다음 배치를 다음 프레임에서 실행 (브라우저가 렌더링할 시간을 줌)
        requestAnimationFrame(() => {
            setTimeout(renderNextBatch, 0);
        });
    }
    
    // 첫 배치 렌더링 시작
    renderNextBatch();
    
    // Lazy Post Renderer 설정 함수 (스크롤 시 포스트 렌더링)
    function setupLazyPostRenderer(container, sortedGroups, initialCount, abortSignal = null) {
        const placeholder = document.getElementById('gallery-placeholder');
        if (!placeholder || sortedGroups.length <= initialCount) return;
        
        // AbortSignal 체크
        if (abortSignal && abortSignal.aborted) {
            return;
        }
        
        let renderedCount = initialCount;
        let isRendering = false;
        const POSTS_PER_BATCH = 3; // 한 번에 렌더링할 포스트 수
        const estimatedPostHeight = 600;
        
        // Placeholder를 관찰하는 Observer (전역 변수에 저장하여 나중에 정리 가능)
        placeholderObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // AbortSignal 체크 (새 렌더 시작 시 placeholderObserver가 null일 수 있음)
                if (abortSignal && abortSignal.aborted) {
                    if (placeholderObserver) {
                        placeholderObserver.disconnect();
                        placeholderObserver = null;
                    }
                    return;
                }
                
                if (entry.isIntersecting && !isRendering && renderedCount < sortedGroups.length) {
                    isRendering = true;
                    
                    // 배치로 포스트 렌더링
                    function renderNextLazyBatch() {
                        // AbortSignal 체크 (새 렌더 시작 시 placeholderObserver가 null일 수 있음)
                        if (abortSignal && abortSignal.aborted) {
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        if (renderedCount >= sortedGroups.length) {
                            // 모든 포스트 렌더링 완료
                            if (placeholder && placeholder.parentNode) {
                                placeholder.remove();
                            }
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        // DOM 존재 확인 (새 렌더로 placeholder가 제거되었을 수 있음)
                        if (!document.contains(placeholder)) {
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        const batch = sortedGroups.slice(renderedCount, renderedCount + POSTS_PER_BATCH);
                        const batchHtml = batch.map((photoGroup, batchIdx) => {
                            const groupIdx = renderedCount + batchIdx;
                            return renderPostGroup(photoGroup, groupIdx);
                        }).join('');
                        
                        // Placeholder 앞에 포스트 삽입 (삽입된 노드를 모아 실제 높이 측정)
                        const fragment = document.createDocumentFragment();
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = batchHtml;
                        const insertedNodes = [];
                        while (tempDiv.firstChild) {
                            insertedNodes.push(tempDiv.firstChild);
                            fragment.appendChild(tempDiv.firstChild);
                        }
                        
                        if (placeholder && placeholder.parentNode) {
                            placeholder.parentNode.insertBefore(fragment, placeholder);
                        }
                        insertedNodes.forEach((node) => {
                            if (node.nodeType === 1) markMomentFeedPhotosLoadedIn(node);
                        });

                        const batchSize = batch.length;
                        renderedCount += batchSize;
                        applyMomentCaptionLayoutForRange(renderedCount - batchSize, renderedCount);
                        // 초기 10건 이후 삽입분에도 공유 기록 코멘트 플레이스홀더 일괄 조회 (최초 1회 fetch에는 아직 DOM에 없었음)
                        fetchMissingSharedComments(container).catch(() => {});
                        
                        // Placeholder 높이 조정 — 추정(600px)이 아니라 "실제 삽입된 높이"만큼만 차감해
                        // 문서 전체 높이를 보존한다. (추정-실제 오차로 스크롤이 위아래로 튀던 진동 제거)
                        const remaining = sortedGroups.length - renderedCount;
                        if (remaining > 0 && placeholder && document.contains(placeholder)) {
                            let insertedHeight = 0;
                            for (const node of insertedNodes) {
                                if (node.nodeType === 1 && document.contains(node)) {
                                    insertedHeight += node.getBoundingClientRect().height;
                                }
                            }
                            const currentHeight = parseFloat(placeholder.style.height) || ((remaining + batchSize) * estimatedPostHeight);
                            // 측정 실패(0) 시에만 추정치로 폴백
                            const nextHeight = insertedHeight > 0
                                ? Math.max(0, currentHeight - insertedHeight)
                                : remaining * estimatedPostHeight;
                            placeholder.style.height = `${nextHeight}px`;
                        } else {
                            if (placeholder && placeholder.parentNode) {
                                placeholder.remove();
                            }
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                        }
                        
                        // 다음 배치 렌더링 (다음 프레임)
                        if (renderedCount < sortedGroups.length && (!abortSignal || !abortSignal.aborted)) {
                            requestAnimationFrame(() => {
                                if (!abortSignal || !abortSignal.aborted) {
                                    setTimeout(renderNextLazyBatch, 50);
                                }
                            });
                        } else {
                            isRendering = false;
                        }
                    }
                    
                    renderNextLazyBatch();
                }
            });
        }, {
            rootMargin: '200px' // 화면 밖 200px 전에 미리 렌더링
        });
        
        placeholderObserver.observe(placeholder);
    }
    
    // Intersection Observer 설정 함수
    function setupIntersectionObserver(container, abortSignal = null) {
        if (!window.postInteractions) return;
        
        // AbortSignal 체크
        if (abortSignal && abortSignal.aborted) {
            return;
        }
        
        // 이전 Observer 정리
        if (intersectionObserver) {
            intersectionObserver.disconnect();
        }
        
        // 새 Observer 생성: 화면에 보이는 포스트만 로드 (배치 처리)
        intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // AbortSignal 체크
                if (abortSignal && abortSignal.aborted) {
                    return;
                }
                
                if (entry.isIntersecting) {
                    const postEl = entry.target;
                    
                    // DOM 존재 확인
                    if (!document.contains(postEl)) {
                        return;
                    }
                    
                    const postId = postEl.getAttribute('data-post-id');
                    
                    if (!postId) return;
                    enqueuePostInteractionLoad(postEl, postId, abortSignal);
                }
            });
        }, {
            rootMargin: '100px' // 화면 밖 100px 전에 미리 로드 (50px에서 증가 - 너무 작으면 스크롤 시 깜빡임 발생)
        });
        
        // 모든 포스트에 Observer 연결 (렌더링 완료 후 지연 연결)
        setTimeout(() => {
            // AbortSignal 체크
            if (abortSignal && abortSignal.aborted) {
                return;
            }
            
            const posts = container.querySelectorAll('.instagram-post');
            posts.forEach(post => {
                if (abortSignal && abortSignal.aborted) {
                    return;
                }
                if (document.contains(post)) {
                    intersectionObserver.observe(post);
                    // 알림 단일 게시물·화면 내 카드는 IO 대기 없이 바로 소셜 카운트 로드
                    if (appState.galleryFilterPostId || posts.length <= 3) {
                        const pid = post.getAttribute('data-post-id');
                        if (pid) enqueuePostInteractionLoad(post, pid, abortSignal);
                    }
                }
            });
        }, 300); // 100ms에서 300ms로 증가 (초기 렌더링 완료 후 연결)
    }
    
    console.log('[renderGallery] 완료, 렌더링된 그룹 수:', sortedGroups.length, '전체 sharedPhotos:', window.sharedPhotos?.length || 0);
    scheduleLucideIcons(container);
    if (filterUserId && window.syncBottomNavForGalleryFilter) window.syncBottomNavForGalleryFilter();
    } catch (error) {
        console.error('[renderGallery] 오류 발생:', error);
        console.error('[renderGallery] 스택:', error.stack);
    } finally {
        if (!isGallerySessionStale(mySession)) {
            isRenderingGallery = false;
            if (galleryRenderPending) {
                galleryRenderPending = false;
                queueMicrotask(() => {
                    renderGallery().catch((err) => console.error('[renderGallery] pending 재실행 실패:', err));
                });
            }
        }
        // AbortController는 다음 renderGallery 호출 시 새로운 것으로 교체되므로 여기서는 null로 설정하지 않음
    }
}

// 갤러리 사용자 필터링 함수
export function filterGalleryByUser(userId, userNickname) {
    // 모먼트 피드에서 사용자 클릭 시 진입 → 뒤로가기 시 모먼트로 복귀. openUserProfileFromBoard에서 'board'로 덮어씀
    if (appState.galleryFilterEntryTab === undefined || appState.galleryFilterEntryTab === null) {
        appState.galleryFilterEntryTab = 'gallery';
    }
    appState.galleryFilterUserId = userId;
    appState.galleryUserProfileMomentVisiblePostCount = USER_PROFILE_MOMENT_GRID_PAGE_SIZE;
    appState.galleryUserProfileSharedDocs = null;
    appState.galleryUserProfileSharedLastSnap = null;
    appState.galleryUserProfileSharedHasMore = true;
    appState.galleryUserProfileSharedForUserId = userId;
    appState.galleryUserProfileSharedDocSnaps = new Map();
    renderGallery();
}

/** 사용자 프로필(내 게시물) 필터 상태만 해제 — 하단 네비로 이탈할 때 사용 (복귀 탭 이동 없음) */
export function resetGalleryUserFilterState() {
    appState.galleryFilterUserId = null;
    appState.galleryFilterTab = 'moment';
    appState.galleryFilterEntryTab = null;
    appState.galleryFilterPostId = null;
    appState.galleryNotificationFilterPhotos = null;
    appState.galleryUserProfileMomentVisiblePostCount = USER_PROFILE_MOMENT_GRID_PAGE_SIZE;
    appState.galleryUserProfileSharedDocs = null;
    appState.galleryUserProfileSharedLastSnap = null;
    appState.galleryUserProfileSharedHasMore = false;
    appState.galleryUserProfileSharedForUserId = null;
    appState.galleryUserProfileSharedDocSnaps = null;
    const mainHeader = document.querySelector('#mainApp > header');
    if (mainHeader) mainHeader.classList.remove('hidden');
    document.body.removeAttribute('data-gallery-filter-nav');
}

// 갤러리 필터링 해제 함수 (뒤로가기 시 진입했던 탭으로 복귀)
export async function clearGalleryFilter() {
    const returnTab = appState.galleryFilterEntryTab;
    resetGalleryUserFilterState();
    if (returnTab === 'board') {
        if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
        return;
    }
    if (returnTab === 'settings') {
        if (typeof window.switchMainTab === 'function') window.switchMainTab('settings');
        if (typeof window.openSettings === 'function') window.openSettings();
        return;
    }
    if (typeof window.markMomentFeedNavSeen === 'function') window.markMomentFeedNavSeen();
    // 전체 피드로 복귀 시 첫 페이지 로드 (sharedPhotosFeed 초기화)
    if (window.sharedPhotosFeed.length === 0) {
        try {
            const { loadSharedPhotosPageReliable } = await import('../db.js');
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPageReliable(10, null, { maxAttempts: 2, timeoutMs: 8000 });
            appState.galleryFeedNetworkError = false;
            window.sharedPhotosFeed = docs;
            appState.sharedPhotosFeedLastDoc = lastDoc;
            appState.sharedPhotosFeedHasMore = hasMore;
        } catch (e) {
            console.error('모먼트 피드 로드 실패:', e);
            appState.galleryFeedNetworkError = true;
            window.sharedPhotosFeed = [];
        }
    }
    renderGallery();
}

// 사용자 프로필 뷰에서 모먼트/밀톡 탭 전환
export function switchGalleryFilterTab(tab) {
    if (tab !== 'moment' && tab !== 'board') return;
    appState.galleryFilterTab = tab;
    if (appState.galleryFilterUserId) appState.galleryFilterPostId = null;
    renderGallery();
    if (window.syncBottomNavForGalleryFilter) window.syncBottomNavForGalleryFilter();
}
