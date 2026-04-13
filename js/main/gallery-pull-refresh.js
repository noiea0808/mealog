/**
 * 모먼트 갤러리 당겨서 새로고침 (터치·마우스)
 */
import { appState } from '../state.js';
import { loadSharedPhotosPageReliable } from '../db.js';
import { runMealogNetworkRecovery } from './network.js';
import { showToast } from '../ui.js';
import { renderGallery, invalidateGalleryRenderSession, updateTimelineShareIndicators } from '../render/index.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';

export function setupGalleryPullToRefresh() {
    const wrap = document.getElementById('galleryPullWrap');
    const indicator = document.getElementById('galleryPullIndicator');
    if (!wrap || !indicator) return;

    const PULL_THRESHOLD = 60;
    const RESISTANCE = 0.5;
    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    let isRefreshing = false;

    const doRefresh = async () => {
        if (isRefreshing) return;
        isRefreshing = true;
        indicator.classList.remove('pulling');
        indicator.classList.add('refreshing');
        const iconEl = indicator.querySelector('i');
        const spanEl = indicator.querySelector('span');
        if (iconEl) iconEl.classList.add('fa-spin');
        if (spanEl) spanEl.textContent = '새로고침 중...';

        try {
            invalidateGalleryRenderSession();
            try {
                await runMealogNetworkRecovery();
            } catch (_) {
                /* ignore */
            }
            if (appState.galleryFilterUserId) {
                appState.galleryUserProfileSharedDocs = null;
                appState.galleryUserProfileSharedLastSnap = null;
                appState.galleryUserProfileSharedHasMore = true;
                appState.galleryUserProfileSharedDocSnaps = new Map();
                invalidateGalleryRenderSession();
                await renderGallery({ forceReload: true });
            } else {
                const synced = await syncOrphanedSharesToMoment();
                if (synced > 0) {
                    updateTimelineShareIndicators();
                    showToast('모먼트에 반영되었습니다.', 'success');
                }
                const { docs, lastDoc, hasMore } = await loadSharedPhotosPageReliable(10);
                appState.galleryFeedNetworkError = false;
                window.sharedPhotosFeed = docs;
                appState.sharedPhotosFeedLastDoc = lastDoc;
                appState.sharedPhotosFeedHasMore = hasMore;
                appState.sharedPhotosFeedPrefetchedAt = Date.now();
                invalidateGalleryRenderSession();
                await renderGallery({ forceReload: true });
            }
        } catch (e) {
            console.error('갤러리 새로고침 실패:', e);
            if (!appState.galleryFilterUserId) {
                appState.galleryFeedNetworkError = true;
                try {
                    invalidateGalleryRenderSession();
                    await renderGallery({ forceReload: true });
                } catch (_) {
                    /* ignore */
                }
            }
            if (typeof showToast === 'function') showToast('새로고침에 실패했습니다.', 'error');
        } finally {
            isRefreshing = false;
            indicator.classList.remove('refreshing');
            const iconEl2 = indicator.querySelector('i');
            const spanEl2 = indicator.querySelector('span');
            if (iconEl2) iconEl2.classList.remove('fa-spin');
            if (spanEl2) spanEl2.textContent = '당겨서 새로고침';
        }
    };

    wrap.addEventListener('touchstart', (e) => {
        if (appState.currentTab !== 'gallery' || isRefreshing) return;
        const galleryView = document.getElementById('galleryView');
        if (!galleryView || galleryView.classList.contains('hidden')) return;
        if (window.scrollY <= 10) {
            startY = e.touches[0].clientY;
            isPulling = true;
        }
    }, { passive: true });

    wrap.addEventListener('touchmove', (e) => {
        if (!isPulling || isRefreshing) return;
        currentY = e.touches[0].clientY;
        const pullDistance = (currentY - startY) * RESISTANCE;
        if (pullDistance > 0) {
            indicator.classList.add('pulling');
            indicator.querySelector('span').textContent = pullDistance > PULL_THRESHOLD ? '놓으면 새로고침' : '당겨서 새로고침';
        } else {
            indicator.classList.remove('pulling');
        }
    }, { passive: true });

    wrap.addEventListener('touchend', () => {
        if (!isPulling || isRefreshing) return;
        isPulling = false;
        const pullDistance = (currentY - startY) * RESISTANCE;
        indicator.classList.remove('pulling');
        if (pullDistance >= PULL_THRESHOLD) {
            doRefresh();
        }
    }, { passive: true });

    // 데스크톱: 마우스 드래그로 당겨서 새로고침
    wrap.addEventListener('mousedown', (e) => {
        if (appState.currentTab !== 'gallery' || isRefreshing) return;
        const galleryView = document.getElementById('galleryView');
        if (!galleryView || galleryView.classList.contains('hidden')) return;
        if (window.scrollY <= 10) {
            startY = e.clientY;
            isPulling = true;
        }
    });
    wrap.addEventListener('mousemove', (e) => {
        if (!isPulling || isRefreshing) return;
        currentY = e.clientY;
        const pullDistance = (currentY - startY) * RESISTANCE;
        if (pullDistance > 0) {
            indicator.classList.add('pulling');
            indicator.querySelector('span').textContent = pullDistance > PULL_THRESHOLD ? '놓으면 새로고침' : '당겨서 새로고침';
        }
    });
    wrap.addEventListener('mouseup', () => {
        if (!isPulling || isRefreshing) return;
        isPulling = false;
        const pullDistance = (currentY - startY) * RESISTANCE;
        indicator.classList.remove('pulling');
        if (pullDistance >= PULL_THRESHOLD) {
            doRefresh();
        }
    });
    wrap.addEventListener('mouseleave', () => {
        if (isPulling && !isRefreshing) {
            isPulling = false;
            indicator.classList.remove('pulling');
        }
    });
}
