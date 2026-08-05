/**
 * 모먼트 갤러리 당겨서 새로고침 (터치·마우스)
 */
import { appState } from '../state.js';
import { loadSharedPhotosPageReliable } from '../db.js';
import { prepareMomentFeedNetworkForReload } from './network.js';
import { showToast } from '../ui.js';
import { applyLoadingFoodIconDurationSeconds } from '../loading-spinner-config.js';
import { renderGallery, invalidateGalleryRenderSession } from '../render/index.js';
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

    const REFRESH_WATCHDOG_MS = 20000;
    let refreshWatchdogTimer = 0;
    const hideRefreshFab = () => {
        const fab = document.getElementById('galleryMomentsRefreshFab');
        if (fab) {
            fab.classList.add('hidden');
            fab.setAttribute('aria-hidden', 'true');
        }
    };

    const doRefresh = async () => {
        if (isRefreshing) return;
        isRefreshing = true;
        indicator.classList.remove('pulling');
        const refreshFab = document.getElementById('galleryMomentsRefreshFab');
        if (refreshFab) {
            refreshFab.classList.remove('hidden');
            refreshFab.setAttribute('aria-hidden', 'false');
        }
        // 어떤 로드/복구 경로가 멈춰도 새로고침 FAB가 영원히 남지 않도록 하는 안전장치
        if (refreshWatchdogTimer) clearTimeout(refreshWatchdogTimer);
        refreshWatchdogTimer = setTimeout(() => {
            refreshWatchdogTimer = 0;
            isRefreshing = false;
            hideRefreshFab();
        }, REFRESH_WATCHDOG_MS);
        try {
            applyLoadingFoodIconDurationSeconds();
        } catch (_) {
            /* ignore */
        }

        try {
            invalidateGalleryRenderSession();
            try {
                await prepareMomentFeedNetworkForReload();
            } catch (_) {
                /* ignore */
            }
            if (appState.galleryFilterUserId) {
                appState.galleryUserProfileSharedDocs = null;
                appState.galleryUserProfileSharedLastSnap = null;
                appState.galleryUserProfileSharedHasMore = true;
                appState.galleryUserProfileSharedDocSnaps = new Map();
                invalidateGalleryRenderSession();
                try {
                    await renderGallery({ forceReload: true });
                } catch (e) {
                    console.warn('갤러리 새로고침(프로필) 첫 로드 실패, Firestore 복구 후 재시도:', e?.message || e);
                    try {
                        // 읽기 실패에 인스턴스를 재생성하지 않는다 — terminate 는 밀로그 기록
                        // 리스너까지 죽여서, 새로고침 한 번이 앱 전체 데이터를 날린다.
                        await prepareMomentFeedNetworkForReload();
                    } catch (recoverErr) {
                        console.warn('갤러리 새로고침: 네트워크 복구 실패:', recoverErr?.message || recoverErr);
                    }
                    invalidateGalleryRenderSession();
                    await renderGallery({ forceReload: true });
                }
            } else {
                await syncOrphanedSharesToMoment();
                let loadResult;
                try {
                    loadResult = await loadSharedPhotosPageReliable(10);
                } catch (firstErr) {
                    console.warn('갤러리 새로고침: 첫 로드 실패, Firestore 복구 후 재시도:', firstErr?.message || firstErr);
                    try {
                        // 읽기 실패에 인스턴스를 재생성하지 않는다 — terminate 는 밀로그 기록
                        // 리스너까지 죽여서, 새로고침 한 번이 앱 전체 데이터를 날린다.
                        await prepareMomentFeedNetworkForReload();
                    } catch (recoverErr) {
                        console.warn('갤러리 새로고침: 네트워크 복구 실패:', recoverErr?.message || recoverErr);
                    }
                    loadResult = await loadSharedPhotosPageReliable(10, null, { maxAttempts: 2 });
                }
                const { docs, lastDoc, hasMore } = loadResult;
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
            if (refreshWatchdogTimer) {
                clearTimeout(refreshWatchdogTimer);
                refreshWatchdogTimer = 0;
            }
            isRefreshing = false;
            if (refreshFab) {
                refreshFab.classList.add('hidden');
                refreshFab.setAttribute('aria-hidden', 'true');
            }
            const spanEl2 = indicator.querySelector('span');
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
