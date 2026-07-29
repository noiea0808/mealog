/**
 * 밀로그 타임라인 당겨서 새로고침 (터치·마우스)
 * — 세로 pull만 처리. 가로 일자 스와이프와 축 분리.
 */
import { appState } from '../state.js';
import { ensureMealsLoadedAroundDate } from '../db/loading.js';
import { recoverFirestoreAfterWatchAssertion } from '../firebase.js';
import { toLocalDateString } from '../utils.js';
import { showToast } from '../ui.js';
import { applyLoadingFoodIconDurationSeconds } from '../loading-spinner-config.js';
import { retryMealsListenerIfDegraded } from '../utils/meals-listener-degraded.js';
import { prepareFirestoreNetworkForManualReload } from './network.js';
import {
    invalidateTimelineDateSection,
    renderTimeline,
    renderTimelineDateSections,
    refreshMiniCalendarDots,
    updateTimelineShareIndicators,
    updateTimelineMealEntryPendingIndicators
} from '../render/index.js';

function pageYmd() {
    const d = appState.pageDate instanceof Date && !Number.isNaN(+appState.pageDate) ? appState.pageDate : new Date();
    return toLocalDateString(d);
}

export function setupTimelinePullToRefresh() {
    const wrap = document.getElementById('timelinePullWrap');
    const indicator = document.getElementById('timelinePullIndicator');
    if (!wrap || !indicator) return;

    const PULL_THRESHOLD = 60;
    const RESISTANCE = 0.5;
    const AXIS_LOCK_PX = 12;
    let startX = 0;
    let startY = 0;
    let currentY = 0;
    let isPulling = false;
    let axisLocked = null; // null | 'v' | 'h'
    let isRefreshing = false;

    const REFRESH_WATCHDOG_MS = 20000;
    let refreshWatchdogTimer = 0;

    const labelEl = () => indicator.querySelector('span');

    const hideRefreshFab = () => {
        const fab = document.getElementById('timelineRefreshFab');
        if (fab) {
            fab.classList.add('hidden');
            fab.setAttribute('aria-hidden', 'true');
        }
    };

    const showRefreshFab = () => {
        const fab = document.getElementById('timelineRefreshFab');
        if (fab) {
            fab.classList.remove('hidden');
            fab.setAttribute('aria-hidden', 'false');
        }
    };

    const canStartPull = () => {
        if (appState.currentTab !== 'timeline' || isRefreshing) return false;
        const timelineView = document.getElementById('timelineView');
        if (!timelineView || timelineView.classList.contains('hidden')) return false;
        if (document.getElementById('mainAppHeader')?.classList.contains('timeline-search-expanded')) {
            return false;
        }
        return window.scrollY <= 10;
    };

    const resetPullUi = () => {
        isPulling = false;
        axisLocked = null;
        indicator.classList.remove('pulling');
        const span = labelEl();
        if (span) span.textContent = '당겨서 새로고침';
    };

    const doRefresh = async () => {
        if (isRefreshing) return;
        isRefreshing = true;
        indicator.classList.remove('pulling');
        showRefreshFab();
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

        const ymd = pageYmd();
        try {
            try {
                await prepareFirestoreNetworkForManualReload('timeline-pull-refresh', {
                    rebindListeners: true
                });
            } catch (_) {
                /* ignore */
            }
            try {
                retryMealsListenerIfDegraded();
            } catch (_) {
                /* ignore */
            }
            try {
                await ensureMealsLoadedAroundDate(ymd, 3, { force: true });
            } catch (firstErr) {
                console.warn('밀로그 새로고침: 첫 로드 실패, Firestore 복구 후 재시도:', firstErr?.message || firstErr);
                try {
                    await recoverFirestoreAfterWatchAssertion('timelinePullRefresh', { force: true });
                } catch (recoverErr) {
                    console.warn('밀로그 새로고침: Firestore 복구 실패:', recoverErr?.message || recoverErr);
                }
                await ensureMealsLoadedAroundDate(ymd, 3, { force: true });
            }

            if (appState.viewMode === 'page') {
                invalidateTimelineDateSection(ymd);
                renderTimelineDateSections([ymd]);
            } else {
                const container = document.getElementById('timelineContainer');
                if (container) {
                    container.querySelectorAll(':scope > [id^="date-"]').forEach((el) => el.remove());
                    document.getElementById('loadMoreMealsBtn')?.remove();
                }
                window.loadedDates = [];
                renderTimeline();
            }
            try {
                refreshMiniCalendarDots();
            } catch (_) {
                /* ignore */
            }
            try {
                updateTimelineShareIndicators();
                updateTimelineMealEntryPendingIndicators();
            } catch (_) {
                /* ignore */
            }
        } catch (e) {
            console.error('밀로그 새로고침 실패:', e);
            if (typeof showToast === 'function') showToast('새로고침에 실패했습니다.', 'error');
        } finally {
            if (refreshWatchdogTimer) {
                clearTimeout(refreshWatchdogTimer);
                refreshWatchdogTimer = 0;
            }
            isRefreshing = false;
            hideRefreshFab();
            const span = labelEl();
            if (span) span.textContent = '당겨서 새로고침';
        }
    };

    wrap.addEventListener(
        'touchstart',
        (e) => {
            if (!canStartPull()) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            currentY = startY;
            isPulling = true;
            axisLocked = null;
        },
        { passive: true }
    );

    wrap.addEventListener(
        'touchmove',
        (e) => {
            if (!isPulling || isRefreshing) return;
            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;
            currentY = y;
            if (axisLocked == null) {
                const dx = Math.abs(x - startX);
                const dy = Math.abs(y - startY);
                if (dx < AXIS_LOCK_PX && dy < AXIS_LOCK_PX) return;
                axisLocked = dx > dy ? 'h' : 'v';
                if (axisLocked === 'h') {
                    resetPullUi();
                    return;
                }
            }
            if (axisLocked !== 'v') return;
            const pullDistance = (currentY - startY) * RESISTANCE;
            if (pullDistance > 0) {
                indicator.classList.add('pulling');
                const span = labelEl();
                if (span) span.textContent = pullDistance > PULL_THRESHOLD ? '놓으면 새로고침' : '당겨서 새로고침';
            } else {
                indicator.classList.remove('pulling');
            }
        },
        { passive: true }
    );

    wrap.addEventListener(
        'touchend',
        () => {
            if (!isPulling || isRefreshing) return;
            const pullDistance = axisLocked === 'v' ? (currentY - startY) * RESISTANCE : 0;
            resetPullUi();
            if (pullDistance >= PULL_THRESHOLD) {
                void doRefresh();
            }
        },
        { passive: true }
    );

    wrap.addEventListener(
        'touchcancel',
        () => {
            if (isPulling && !isRefreshing) resetPullUi();
        },
        { passive: true }
    );

    wrap.addEventListener('mousedown', (e) => {
        if (!canStartPull()) return;
        if (e.button !== 0) return;
        startX = e.clientX;
        startY = e.clientY;
        currentY = startY;
        isPulling = true;
        axisLocked = null;
    });
    wrap.addEventListener('mousemove', (e) => {
        if (!isPulling || isRefreshing) return;
        currentY = e.clientY;
        if (axisLocked == null) {
            const dx = Math.abs(e.clientX - startX);
            const dy = Math.abs(e.clientY - startY);
            if (dx < AXIS_LOCK_PX && dy < AXIS_LOCK_PX) return;
            axisLocked = dx > dy ? 'h' : 'v';
            if (axisLocked === 'h') {
                resetPullUi();
                return;
            }
        }
        if (axisLocked !== 'v') return;
        const pullDistance = (currentY - startY) * RESISTANCE;
        if (pullDistance > 0) {
            indicator.classList.add('pulling');
            const span = labelEl();
            if (span) span.textContent = pullDistance > PULL_THRESHOLD ? '놓으면 새로고침' : '당겨서 새로고침';
        }
    });
    wrap.addEventListener('mouseup', () => {
        if (!isPulling || isRefreshing) return;
        const pullDistance = axisLocked === 'v' ? (currentY - startY) * RESISTANCE : 0;
        resetPullUi();
        if (pullDistance >= PULL_THRESHOLD) {
            void doRefresh();
        }
    });
    wrap.addEventListener('mouseleave', () => {
        if (isPulling && !isRefreshing) resetPullUi();
    });
}
