/**
 * 모먼트 갤러리(공유 피드) 렌더링·필터·더보기
 */
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { normalizeUrl, getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { loadSharedPhotosByUserUpToPostCount, getMomentsFeedView } from '../db.js';
import {
    getPostIdFromPhotoGroup,
    preloadAdjacentGalleryImages
} from './post-group-utils.js';
import { fetchUserProfiles, getUserSettings } from './user-profiles.js';
import { renderBoardPostList } from './board-notice.js';
import { sortSharedPhotosByTimestampDesc } from '../utils/shared-photo-timestamp.js';
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

ensureMomentFeedPinchDelegate();

/** `momentsFeedView === 2` — renderGallery 완료 시점 기준 (appendGalleryPosts 등에서 재사용) */
let galleryMomentLayoutV2 = false;

/** 사용자 프로필 모먼트 그리드: 3열 × 5행 = 15게시물 단위 */
const USER_PROFILE_MOMENT_GRID_PAGE_SIZE = 15;

/** 사용자 프로필 모먼트 탭: 게시물당 첫 장만 3열 그리드(인스타 스타일) */
function buildUserProfileMomentGridHtml(sortedGroups) {
    const cells = sortedGroups.map((photoGroup) => {
        const postId = getPostIdFromPhotoGroup(photoGroup);
        const first = photoGroup[0];
        const url = first?.photoUrl || '';
        const n = photoGroup.length;
        const multi = n > 1;
        const encId = encodeURIComponent(postId || '');
        const safeSrc = escapeHtml(url);
        const imgOrPlaceholder = url
            ? `<img src="${safeSrc}" alt="" class="absolute inset-0 h-full w-full object-cover" loading="lazy" draggable="false">`
            : `<div class="absolute inset-0 flex items-center justify-center text-slate-400"><i class="fa-solid fa-image text-2xl" aria-hidden="true"></i></div>`;
        const badge = multi
            ? `<span class="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-black leading-none text-white shadow-sm" title="사진 ${n}장" aria-hidden="true">
                    <i class="fa-solid fa-images text-[9px] opacity-95" aria-hidden="true"></i>
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

/** 모먼트 피드가 비었을 때: 진짜 없음 vs 네트워크·로드 실패 구분 */
function buildGalleryEmptyMomentBlock(networkError, filterUserId) {
    if (networkError) {
        return `
            <div class="flex flex-col items-center justify-center py-20 text-center px-4">
                <i class="fa-regular fa-wifi text-6xl text-slate-200 mb-4" aria-hidden="true"></i>
                <p class="text-sm font-bold text-slate-600">모먼트를 불러오지 못했습니다</p>
                <p class="text-xs text-slate-400 mt-2 max-w-xs leading-relaxed">네트워크가 끊겼거나 불안정할 때 이 화면이 나올 수 있습니다. 연결을 확인한 뒤 다시 시도해 주세요.</p>
                <button type="button" onclick="window.reloadMomentFeed && window.reloadMomentFeed()" class="mt-5 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold rounded-xl transition-colors inline-flex items-center gap-1.5">
                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>다시 불러오기
                </button>
            </div>`;
    }
    return `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-solid fa-images text-6xl text-slate-200 mb-4" aria-hidden="true"></i>
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
        const { loadSharedPhotosPage } = await import('../db.js');
        const { docs, lastDoc, hasMore: nextHasMore } = await loadSharedPhotosPage(10, appState.sharedPhotosFeedLastDoc);
        appState.galleryFeedNetworkError = false;
        window.sharedPhotosFeed = collapseDocsToFeedPage(
            sortSharedPhotosByTimestampDesc([...(window.sharedPhotosFeed || []), ...docs]),
            999
        ).feedDocs;
        appState.sharedPhotosFeedLastDoc = lastDoc;
        appState.sharedPhotosFeedHasMore = nextHasMore;

        await renderGallery({ skipScrollToTop: true, forceReload: true });

        if (syncFeed) {
            const { renderFeed } = await import('./feed.js');
            await renderFeed();
        }
        return { ok: true, appended: docs.length };
    } catch (e) {
        console.error('공유 사진 더보기 실패:', e);
        appState.galleryFeedNetworkError = true;
        return { ok: false, reason: 'error', error: e };
    }
}

/** 더보기 시 새 포스트만 DOM에 추가 (전체 재렌더 없이 깜박임 방지) */
async function appendGalleryPosts(docs, loadMoreWrap) {
    if (!docs || docs.length === 0 || !loadMoreWrap || !loadMoreWrap.parentNode) return;
    const container = document.getElementById('galleryContainer');
    if (!container) return;
    const newGroups = docsToSortedPhotoGroups(docs);
    if (newGroups.length === 0) return;
    // 새로 추가되는 작성자들의 프로필을 먼저 로드해 두어 닉네임이 '익명'으로 나오지 않도록 함
    await fetchUserProfiles([...new Set(docs.map(p => p.userId).filter(Boolean))]);
    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => { if (meal.id) mealHistoryMap.set(meal.id, meal); });
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
                            iconEl.classList.add('bg-cover', 'bg-center');
                            iconEl.classList.remove('bg-slate-200', 'bg-indigo-100');
                        } else {
                            if (avatar.type === 'default') {
                                iconEl.innerHTML = '<i class="fa-solid fa-user text-sm text-slate-500"></i>';
                            } else {
                                iconEl.textContent = avatar.value;
                            }
                            iconEl.style.backgroundImage = '';
                            iconEl.className = `gallery-filter-icon w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border border-slate-300 ${avatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}`;
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
            <div class="gallery-user-profile-header bg-white">
                <div class="gallery-user-profile-scrollable">
                    <div class="px-4 py-3 flex items-center gap-2 border-b border-slate-200">
                        <button onclick="window.clearGalleryFilter()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                            <i class="fa-solid fa-arrow-left text-lg"></i>
                        </button>
                        ${initialAvatar.type === 'photo' ? `
                            <div class="gallery-filter-photo w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border border-slate-300 bg-slate-100" style="background-image: url(${initialAvatar.value}); background-size: cover; background-position: center;"></div>
                        ` : `
                            <div class="gallery-filter-icon w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border border-slate-300 ${initialAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">${initialAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(initialAvatar.value)}</div>
                        `}
                        <div class="flex-1 min-w-0">
                            <div class="gallery-filter-nickname text-sm font-bold text-slate-800">${initialDisplay.nickname || '익명'}</div>
                            <div class="gallery-filter-joined text-xs text-slate-400"></div>
                        </div>
                    </div>
                    <div class="px-4 py-3 border-b-2 border-slate-200 bg-slate-50/50">
                        <div class="gallery-filter-bio text-sm whitespace-pre-wrap min-h-[1.25rem] text-slate-400 italic">불러오는 중…</div>
                    </div>
                </div>
                <div class="gallery-filter-tabs sticky top-0 z-30 flex w-full min-w-0 bg-white border-t-2 border-slate-200">
                    <button type="button" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('moment')" class="gallery-filter-tab-btn flex-1 min-w-0 py-3 text-sm font-bold transition-colors border-b-2 ${galleryFilterTab === 'moment' ? 'text-emerald-600 border-emerald-600' : 'text-slate-600 border-transparent'}">모먼트</button>
                    <button type="button" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('board')" class="gallery-filter-tab-btn flex-1 min-w-0 py-3 text-sm font-bold transition-colors border-b-2 ${galleryFilterTab === 'board' ? 'text-emerald-600 border-emerald-600' : 'text-slate-600 border-transparent'}">게시판</button>
                </div>
            </div>
        `;
    }
    
    // 알림에서 클릭 시 해당 게시물만 보기: 상단에 전체보기 버튼
    if (appState.galleryFilterPostId && !filterUserId) {
        userProfileHeader = `
            <div class="gallery-post-filter-header bg-white border-b border-slate-200 sticky top-0 z-30">
                <div class="px-4 py-3 flex items-center gap-2">
                    <button type="button" onclick="window.clearGalleryFilterPostId && window.clearGalleryFilterPostId()" class="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="text-sm font-bold text-slate-800">댓글 달린 게시물</span>
                </div>
            </div>
        `;
    }
    
    // 사용자 프로필 뷰 + 밀톡 탭: 밀톡 탭과 동일한 목록 렌더링 (renderBoardPostList)
    if (filterUserId && galleryFilterTab === 'board') {
        container.innerHTML = userProfileHeader + `
            <div id="galleryFilterBoardList" class="pt-1 pb-4">
                <div class="flex justify-center py-8"><i class="fa-solid fa-spinner fa-spin text-2xl text-slate-300"></i></div>
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
                            <i class="fa-regular fa-comments text-4xl text-slate-200 mb-3"></i>
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
                            <i class="fa-solid fa-rotate-right"></i>다시 불러오기
                        </button>
                    </div>`;
                }
            } finally {
                isRenderingGallery = false;
            }
        })();
        return;
    }
    
    if (photosToRender.length === 0) {
        container.innerHTML = userProfileHeader + buildGalleryEmptyMomentBlock(!!appState.galleryFeedNetworkError, filterUserId);
        // 이전 포스트 ID 목록 초기화
        previousGalleryPostIds.clear();
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
    const seen = new Set();
    const uniquePhotos = photosToRender.filter((photo) => {
        const key = isMomentPostV2(photo)
            ? `v2_${photo.postId || photo.id}`
            : `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const galleryUserIds = [...new Set(uniquePhotos.map(p => p.userId).filter(Boolean))];
    await fetchUserProfiles(galleryUserIds);
    if (isGallerySessionStale(mySession)) return;

    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => {
            if (meal.id) mealHistoryMap.set(meal.id, meal);
        });
    }
    const renderPostGroup = (photoGroup, groupIdx) =>
        renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap, {
            layoutV2: galleryMomentLayoutV2,
            useGalleryPostGap: galleryMomentLayoutV2
        });

    let sortedGroups = docsToSortedPhotoGroups(uniquePhotos);
    
    // 앨범 흔적 필터: 본인이 좋아요/댓글/북마크한 게시물만 표시 (알림에서 한 게시물만 볼 때는 생략해 로딩 단축)
    let tracePostIds = null;
    if (appState.galleryTraceFilter && !appState.galleryFilterPostId && window.currentUser && !window.currentUser.isAnonymous && window.postInteractions) {
        let list = [];
        if (appState.galleryTraceFilter === 'like') {
            list = await window.postInteractions.getPostIdsLikedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'comment') {
            list = await window.postInteractions.getPostIdsCommentedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'bookmark') {
            list = await window.postInteractions.getPostIdsBookmarkedByUser(window.currentUser.uid);
        }
        if (isGallerySessionStale(mySession)) return;
        tracePostIds = new Set(list);
        sortedGroups = sortedGroups.filter(g => tracePostIds.has(getPostIdFromPhotoGroup(g)));
    }
    
    // 알림에서 클릭 시 해당 게시물만 필터
    const filterPostId = appState.galleryFilterPostId;
    if (filterPostId) {
        sortedGroups = sortedGroups.filter(g =>
            getPostIdFromPhotoGroup(g) === filterPostId
            || (Array.isArray(g) && (g.some(p => p.id === filterPostId) || g.some(p => p.entryId === filterPostId)))
        );
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
    const traceEmptyMsg = tracePostIds && sortedGroups.length === 0
        ? (traceEmptyLabels[appState.galleryTraceFilter] || '') + ' 게시물이 없습니다'
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
                    <i class="fa-solid fa-chevron-down mr-1.5" aria-hidden="true"></i>더보기
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
                    lm.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5" aria-hidden="true"></i><span class="text-slate-500">불러오는 중…</span>';
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
    const hasSignificantChanges = 
        previousGalleryPostIds.size === 0 || // 초기 로드
        currentPostIds.size === 0 || // 모든 포스트 삭제
        Math.abs(currentPostIds.size - previousGalleryPostIds.size) > 5 || // 5개 이상 차이
        Array.from(currentPostIds).slice(0, 10).some(id => !previousGalleryPostIds.has(id)); // 상위 10개 중 새 포스트 있음
    
    // AbortSignal 체크: 취소되었으면 중단
    if (abortSignal.aborted) {
        console.log('[renderGallery] AbortSignal 감지 - 렌더링 중단');
        isRenderingGallery = false;
        return;
    }
    
    // 헤더와 빈 메시지만 먼저 렌더링 (네트워크 오류 > 알림/흔적 필터 빈 메시지)
    const emptyMsg = showNetworkErrorEmpty ? null : (filterPostEmptyMsg || traceEmptyMsg);
    const emptyIcon = filterPostEmptyMsg ? 'fa-comment' : traceEmptyIcon;
    const headerHtml = userProfileHeader + (showNetworkErrorEmpty
        ? buildGalleryEmptyMomentBlock(true, filterUserId)
        : (emptyMsg ? `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-regular ${emptyIcon} text-6xl text-slate-200 mb-4"></i>
                <p class="text-sm font-bold text-slate-400">${emptyMsg}</p>
            </div>
        ` : ''));
    
    // 더보기 표시 여부 (타임라인처럼 초기 구조에 포함하여 누락 방지)
    const canLoadMore = !filterUserId && !appState.galleryFilterPostId &&
        (appState.sharedPhotosFeedHasMore || (sortedGroups.length >= 10 && appState.sharedPhotosFeedLastDoc));
    const loadMoreHtml = canLoadMore ? `
        <div id="galleryLoadMoreWrap" class="flex justify-center py-6">
            <button id="galleryLoadMoreBtn" type="button" class="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors">
                <i class="fa-solid fa-chevron-down mr-1.5"></i>더보기
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
                
                // 헤더 다음에 삽입
                const firstPost = container.querySelector('.instagram-post');
                if (firstPost) {
                    container.insertBefore(fragment, firstPost);
                } else {
                    container.appendChild(fragment);
                }
                
                // 이전 포스트 ID 목록 업데이트
                previousGalleryPostIds = new Set(currentPostIds);
                
                // 이벤트 리스너만 다시 설정 (전체 재렌더링 없이)
                setTimeout(() => {
                    if (abortSignal.aborted) return;
                    setupGalleryEventListeners(container, sortedGroups, { abortSignal });
                    fetchMissingSharedComments(container).catch(() => {});
                    setupIntersectionObserver(container, abortSignal);
                }, 50);
                
                isRenderingGallery = false;
                return; // 차등 업데이트 완료
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
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>로딩 중...';
            try {
                const res = await appendMomentFeedNextPage();
                loadMoreBtn.disabled = false;
                if (res?.ok) {
                    loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>더보기';
                    if (!appState.sharedPhotosFeedHasMore) {
                        document.getElementById('galleryLoadMoreWrap')?.remove();
                    }
                } else if (res?.reason === 'error') {
                    if (typeof showToast === 'function') showToast('네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
                    loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>다시 시도';
                } else {
                    loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>더보기';
                }
            } catch (e) {
                console.error('공유 사진 더보기 실패:', e);
                appState.galleryFeedNetworkError = true;
                if (typeof showToast === 'function') showToast('네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>다시 시도';
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
        // AbortSignal 체크
        if (abortSignal.aborted) {
            console.log('[renderGallery] AbortSignal 감지 - 배치 렌더링 중단');
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
                        
                        // Placeholder 앞에 포스트 삽입
                        const fragment = document.createDocumentFragment();
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = batchHtml;
                        while (tempDiv.firstChild) {
                            fragment.appendChild(tempDiv.firstChild);
                        }
                        
                        if (placeholder && placeholder.parentNode) {
                            placeholder.parentNode.insertBefore(fragment, placeholder);
                        }
                        
                        const batchSize = batch.length;
                        renderedCount += batchSize;
                        applyMomentCaptionLayoutForRange(renderedCount - batchSize, renderedCount);
                        // 초기 10건 이후 삽입분에도 공유 기록 코멘트 플레이스홀더 일괄 조회 (최초 1회 fetch에는 아직 DOM에 없었음)
                        fetchMissingSharedComments(container).catch(() => {});
                        
                        // Placeholder 높이 조정
                        const remaining = sortedGroups.length - renderedCount;
                        if (remaining > 0 && placeholder) {
                            placeholder.style.height = `${remaining * estimatedPostHeight}px`;
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
                }
            });
        }, 300); // 100ms에서 300ms로 증가 (초기 렌더링 완료 후 연결)
    }
    
    console.log('[renderGallery] 완료, 렌더링된 그룹 수:', sortedGroups.length, '전체 sharedPhotos:', window.sharedPhotos?.length || 0);
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

// 갤러리 필터링 해제 함수 (뒤로가기 시 진입했던 탭으로 복귀)
export async function clearGalleryFilter() {
    const returnTab = appState.galleryFilterEntryTab;
    appState.galleryFilterUserId = null;
    appState.galleryFilterTab = 'moment';
    appState.galleryFilterEntryTab = null;
    appState.galleryFilterPostId = null;
    appState.galleryUserProfileMomentVisiblePostCount = USER_PROFILE_MOMENT_GRID_PAGE_SIZE;
    appState.galleryUserProfileSharedDocs = null;
    appState.galleryUserProfileSharedLastSnap = null;
    appState.galleryUserProfileSharedHasMore = false;
    appState.galleryUserProfileSharedForUserId = null;
    appState.galleryUserProfileSharedDocSnaps = null;
    const mainHeader = document.querySelector('#mainApp > header');
    if (mainHeader) mainHeader.classList.remove('hidden');
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
            const { loadSharedPhotosPage } = await import('../db.js');
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
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
