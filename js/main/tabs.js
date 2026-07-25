/**
 * 메인 하단 탭 전환 (window.switchMainTab)
 */
import { appState } from '../state.js';
import { loadSharedPhotosPage, loadSharedPhotosPageReliable, loadMyShares } from '../db.js';
import { showToast, showLoading, hideLoading } from '../ui.js';
import {
    renderTimeline,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    renderGallery,
    renderBoard,
    syncBoardFeedComposerVisibility,
    syncBoardSearchPanelVisibility
} from '../render/index.js';
import { ensureAnalytics } from '../analytics/ensure.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';
import { isDemoUser } from '../demo-account.js';
import {
    markMomentFeedNavSeen,
    markBoardNavSeen,
    markBoardFeedSubtabSeen,
    markBoardBoardSubtabSeen,
    markBoardNoticeSubtabSeen,
    refreshNavFeedUpdateDots
} from './nav-feed-update-dots.js';
import { logUsageMetric } from '../usage-metrics.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
import { syncEntryQuickInputFabVisibility } from '../modals/entry-quick-open.js';

const HEADER_TITLE_BY_TAB = {
    dashboard: 'meal-dang',
    timeline: 'mealog',
    gallery: 'moment',
    board: 'lounge',
    settings: 'my'
};

let _tabSwitchNavDotsTimer = null;
const TAB_SWITCH_NAV_DOTS_DEBOUNCE_MS = 380;
/** 네비 active/뷰 토글이 먼저 그려진 뒤 무거운 탭 작업을 실행 */
function runAfterNavPaint(fn) {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            try {
                fn();
            } catch (e) {
                console.error('[탭전환] 지연 작업 오류:', e);
            }
        });
    });
}
function scheduleNavDotsAfterTabSwitch(prevTab, tab) {
    if (prevTab === tab) return;
    clearTimeout(_tabSwitchNavDotsTimer);
    _tabSwitchNavDotsTimer = setTimeout(() => {
        _tabSwitchNavDotsTimer = null;
        if (!window.currentUser) return;
        refreshNavFeedUpdateDots().catch(() => {});
    }, TAB_SWITCH_NAV_DOTS_DEBOUNCE_MS);
}

function updateHeaderTitle(tab) {
    const el = document.getElementById('headerAppTitle');
    if (!el) return;
    el.textContent = HEADER_TITLE_BY_TAB[tab] ?? 'mealog';
}

export function registerMainTabSwitch() {
    /** @param {string} tab @param {{ logTabVisit?: boolean }} [opts] — 로그인 직후 등 동일 탭 재호출이어도 방문 1회 기록 */
    window.switchMainTab = (tab, opts = {}) => {
        try {
            console.log('[탭전환] 시작:', { 이전탭: appState.currentTab, 새탭: tab });
            const prevTab = appState.currentTab;
            appState.currentTab = tab;
            document.body.dataset.mainTab = tab;
            if (prevTab !== tab) {
                window._contentPopupDismissedVisit = new Set();
            }
            const shouldLogTabVisit = prevTab !== tab || opts.logTabVisit === true;
            if (shouldLogTabVisit && window.currentUser && !window.currentUser.isAnonymous) {
                if (tab === 'dashboard') logUsageMetric('tab_mealdang').catch(() => {});
                else if (tab === 'gallery') logUsageMetric('tab_moment').catch(() => {});
                else if (tab === 'timeline') logUsageMetric('tab_mealog').catch(() => {});
                else if (tab === 'board') {
                    if (appState.boardListSubTab === 'board') logUsageMetric('lounge_board').catch(() => {});
                    else if (appState.boardListSubTab === 'notice') logUsageMetric('lounge_notice').catch(() => {});
                    else logUsageMetric('lounge_mealtalk').catch(() => {});
                }
            }
            if (prevTab !== tab) {
                if (prevTab === 'timeline' && typeof window.closeSearch === 'function') window.closeSearch();
                if (prevTab === 'gallery' && typeof window.clearGallerySearch === 'function') {
                    appState.gallerySearchActive = false;
                    appState.gallerySearchKeyword = '';
                    appState.gallerySearchDateRange = null;
                    appState.galleryTraceFilter = null;
                }
                if (prevTab === 'board') {
                    appState.boardSearchActive = false;
                    appState.boardSearchKeyword = '';
                    appState.boardSearchDateRange = null;
                    appState.boardTraceFilter = null;
                    if (typeof window.closeBoardSearchModal === 'function') window.closeBoardSearchModal();
                }
                if ((prevTab === 'gallery' || prevTab === 'board') && tab !== 'gallery' && tab !== 'board') {
                    const tracePanel = document.getElementById('galleryTraceFilterPanel');
                    if (tracePanel) {
                        tracePanel.classList.remove('expanded');
                    }
                }
            }
            if (tab !== 'gallery') {
                appState.boardDetailOpenedFromGallery = false;
                const mainHeader = document.querySelector('#mainApp > header');
                if (mainHeader) mainHeader.classList.remove('hidden');
            }
            updateHeaderTitle(tab);
            const mealdangTabs = document.getElementById('mealdangHeaderTabs');
            if (mealdangTabs) {
                mealdangTabs.classList.toggle('hidden', tab !== 'dashboard');
            }
            document.getElementById('timelineView').classList.toggle('hidden', tab !== 'timeline');
            document.getElementById('galleryView').classList.toggle('hidden', tab !== 'gallery');
            document.getElementById('dashboardView').classList.toggle('hidden', tab !== 'dashboard');
            const settingsView = document.getElementById('settingsView');
            if (settingsView) settingsView.classList.toggle('hidden', tab !== 'settings');

            const boardListView = document.getElementById('boardListView');
            const boardDetailView = document.getElementById('boardDetailView');
            const boardWriteView = document.getElementById('boardWriteView');

            if (tab === 'board') {
                markBoardNavSeen();
                if (appState.boardListSubTab === 'feed') {
                    markBoardFeedSubtabSeen();
                } else if (appState.boardListSubTab === 'board') {
                    markBoardBoardSubtabSeen();
                } else if (appState.boardListSubTab === 'notice') {
                    markBoardNoticeSubtabSeen();
                }
                if (boardListView) boardListView.classList.remove('hidden');
                if (boardDetailView) boardDetailView.classList.add('hidden');
                if (boardWriteView) boardWriteView.classList.add('hidden');

                if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
                const category = window.currentBoardCategory || 'all';
                runAfterNavPaint(() => {
                    renderBoard(category);
                    if (typeof window.__resetBoardPanelScrollNav === 'function') window.__resetBoardPanelScrollNav();
                    setTimeout(() => {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }, 100);
                });
            } else {
                if (boardListView) boardListView.classList.add('hidden');
                if (boardDetailView) boardDetailView.classList.add('hidden');
                if (boardWriteView) boardWriteView.classList.add('hidden');
                if (prevTab === 'board' && typeof window.__resetBoardPanelScrollNav === 'function') {
                    window.__resetBoardPanelScrollNav();
                }
            }

            document.getElementById('trackerSection').classList.toggle('hidden', tab !== 'timeline');
            const setNavActive = (id, active) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.classList.toggle('active', !!active);
            };
            // 밀로그(중앙)가 홈피드 — timeline 활성
            setNavActive('nav-timeline', tab === 'timeline');
            setNavActive('nav-dashboard', tab === 'dashboard');
            setNavActive('nav-gallery', tab === 'gallery');
            setNavActive('nav-board', tab === 'board');
            setNavActive('nav-settings', tab === 'settings');

            if (tab === 'gallery' && appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
                setNavActive('nav-gallery', false);
                setNavActive('nav-board', true);
            }

            const searchBtn = document.getElementById('searchTriggerBtn');
            const gallerySearchBtn = document.getElementById('gallerySearchTriggerBtn');
            const boardSearchBtn = document.getElementById('boardSearchTriggerBtn');
            const gallerySearchPanel = document.getElementById('gallerySearchPanel');
            const boardSearchPanel = document.getElementById('boardSearchPanel');
            const tracePanel = document.getElementById('galleryTraceFilterPanel');
            const timelineSearchPanel = document.getElementById('timelineSearchPanel');
            const notificationWrap = document.getElementById('notificationWrap');
            const demoLoginWrap = document.getElementById('headerDemoLoginWrap');
            const isDemo = window.currentUser && isDemoUser(window.currentUser);

            if (isDemo) {
                if (demoLoginWrap) demoLoginWrap.classList.remove('hidden');
                if (timelineSearchPanel) {
                    timelineSearchPanel.classList.add('hidden');
                }
                if (gallerySearchPanel) gallerySearchPanel.classList.add('hidden');
                if (boardSearchPanel) boardSearchPanel.classList.add('hidden');
                if (tracePanel) {
                    tracePanel.classList.add('hidden');
                    tracePanel.classList.remove('expanded');
                }
                if (notificationWrap) {
                    notificationWrap.classList.add('hidden');
                    if (typeof window.closeNotificationPopup === 'function') window.closeNotificationPopup();
                }
                if (searchBtn) searchBtn.style.display = 'none';
                if (typeof window.closeSearch === 'function') window.closeSearch();
            } else {
                if (demoLoginWrap) demoLoginWrap.classList.add('hidden');
                const showNotification = window.currentUser && !window.currentUser.isAnonymous;
                if (notificationWrap) {
                    if (showNotification) {
                        notificationWrap.classList.remove('hidden');
                        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
                        const modal = document.getElementById('notificationModal');
                        if (modal && !modal.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
                    } else {
                        notificationWrap.classList.add('hidden');
                        if (typeof window.closeNotificationPopup === 'function') window.closeNotificationPopup();
                    }
                }
                if (searchBtn) searchBtn.style.display = (tab === 'timeline') ? 'flex' : 'none';
                if (gallerySearchBtn) gallerySearchBtn.style.display = (tab === 'gallery') ? 'flex' : 'none';
                if (timelineSearchPanel) {
                    if (tab === 'timeline') {
                        timelineSearchPanel.classList.remove('hidden');
                    } else {
                        timelineSearchPanel.classList.add('hidden');
                    }
                }
                if (gallerySearchPanel) {
                    if (tab === 'gallery') {
                        gallerySearchPanel.classList.remove('hidden');
                    } else {
                        gallerySearchPanel.classList.add('hidden');
                    }
                }
                if (boardSearchPanel) {
                    if (tab === 'board') {
                        syncBoardSearchPanelVisibility();
                    } else {
                        boardSearchPanel.classList.add('hidden');
                    }
                }
                if (tracePanel) {
                    tracePanel.classList.add('hidden');
                    tracePanel.classList.remove('expanded');
                }
            }

            if ((tab === 'timeline' || tab === 'dashboard') && window.currentUser && !window.currentUser.isAnonymous) {
                const PREFETCH_DELAY_MS = 1500;
                const CACHE_VALID_MS = 30000;
                if ((Date.now() - (appState.sharedPhotosFeedPrefetchedAt || 0)) > CACHE_VALID_MS) {
                    setTimeout(() => {
                        if (appState.currentTab !== 'gallery' && window.currentUser) {
                            loadSharedPhotosPage(10).then(({ docs, lastDoc, hasMore }) => {
                                window.sharedPhotosFeed = docs;
                                appState.sharedPhotosFeedLastDoc = lastDoc;
                                appState.sharedPhotosFeedHasMore = hasMore;
                                appState.sharedPhotosFeedPrefetchedAt = Date.now();
                            }).catch(() => {});
                        }
                    }, PREFETCH_DELAY_MS);
                }
            }
            if (prevTab === 'timeline' && tab !== 'timeline') {
                window.__pendingDailySwipeHint = false;
                window.__dailySwipeHintPlayed = false;
                window.__dailySwipeHintScheduled = false;
                if (typeof window.cancelDailySwipeHint === 'function') window.cancelDailySwipeHint();
            }
            if (tab === 'dashboard') {
                runAfterNavPaint(() => {
                    void ensureAnalytics()
                        .then((mod) => {
                            if (typeof mod.setMealdangView === 'function') {
                                mod.setMealdangView(appState.mealdangView || 'analysis');
                            }
                            mod.updateDashboard();
                        })
                        .catch((e) => console.error('[탭전환] 밀당 모듈 로드 실패:', e));
                });
            } else if (tab === 'settings') {
                // 설정 탭 전환 시 폼 채우기는 nav-settings 클릭 시 openSettings()에서 수행
            } else if (tab === 'gallery') {
                document.body.classList.remove('bottom-nav-scroll-hidden');
                document.getElementById('mainAppHeader')?.classList.remove('header-scroll-hidden');
                document.getElementById('trackerSection')?.classList.remove('tracker-header-hidden');
                /* 모먼트 헤더: 검색+알림만 — 인라인 흔적 필터 패널은 숨김 */
                const galleryTracePanel = document.getElementById('galleryTraceFilterPanel');
                if (galleryTracePanel) {
                    galleryTracePanel.classList.add('hidden');
                    galleryTracePanel.classList.remove('expanded');
                }
                // 모먼트 네비 점: 새 글을 스크롤해 볼 필요 없이, 탭(아이콘)으로 들어오면 제거
                markMomentFeedNavSeen();
                runAfterNavPaint(() => {
                    if (appState.currentTab !== 'gallery') return;
                    if (!appState.galleryFilterUserId) {
                        const CACHE_VALID_MS = 30000;
                        const hasValidCache = (window.sharedPhotosFeed?.length ?? 0) > 0 &&
                            (Date.now() - (appState.sharedPhotosFeedPrefetchedAt || 0)) < CACHE_VALID_MS;
                        if (hasValidCache) {
                            renderGallery();
                        } else {
                            window.sharedPhotosFeed = [];
                            appState.sharedPhotosFeedLastDoc = null;
                            appState.sharedPhotosFeedHasMore = false;
                            appState.galleryFeedNetworkError = false;
                            showLoading('모먼트 불러오는 중...', { dimBackground: false, recordsFab: true });
                            // 반쯤 끊긴 채널에서 무한 대기하지 않도록 타임아웃·재시도가 있는 reliable 버전 사용
                            loadSharedPhotosPageReliable(10, null, { maxAttempts: 2, timeoutMs: 8000 })
                                .then(({ docs, lastDoc, hasMore }) => {
                                    appState.galleryFeedNetworkError = false;
                                    window.sharedPhotosFeed = docs;
                                    appState.sharedPhotosFeedLastDoc = lastDoc;
                                    appState.sharedPhotosFeedHasMore = hasMore;
                                    appState.sharedPhotosFeedPrefetchedAt = Date.now();
                                    renderGallery();
                                })
                                .catch(e => {
                                    console.error('공유 사진 로드 실패:', e);
                                    appState.galleryFeedNetworkError = true;
                                    renderGallery();
                                })
                                .finally(() => {
                                    hideLoading();
                                });
                        }
                        syncOrphanedSharesToMoment().catch(() => {});
                    } else {
                        renderGallery();
                    }
                    setTimeout(() => {
                        if (appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
                            document.getElementById('nav-gallery')?.classList.remove('active');
                            document.getElementById('nav-board')?.classList.add('active');
                        }
                        setTimeout(() => {
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                        }, 100);
                    }, 200);
                });
            } else if (tab === 'timeline') {
                // 다른 탭→밀로그 진입 시에만 힌트 리셋. logTabVisit(로그인 직후 중복 호출)로
                // played를 다시 false로 풀면 스와이프 힌트가 두 번 재생된다.
                const enteringFromOtherTab = prevTab !== 'timeline';
                const shouldPlaySwipeHint =
                    enteringFromOtherTab ||
                    (opts.logTabVisit === true && !window.__dailySwipeHintPlayed);
                if (enteringFromOtherTab) {
                    window.__dailySwipeHintPlayed = false;
                    window.__dailySwipeHintScheduled = false;
                }
                window.__pendingDailySwipeHint = !!shouldPlaySwipeHint;
                if (appState.viewMode === 'list') {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    appState.pageDate = today;
                }
                window.loadedDates = [];
                window.hasScrolledToToday = false;
                const c = document.getElementById('timelineContainer');
                if (c) c.innerHTML = '';
                if (typeof window.cancelDailySwipeHint === 'function') window.cancelDailySwipeHint();
                renderTimeline();
                renderMiniCalendar();
                // 기록 데이터가 이미 있으면 즉시 재생. 아직이면 initial 재렌더 경로에서 재생.
                if (
                    shouldPlaySwipeHint &&
                    !window.__dailySwipeHintPlayed &&
                    window.loadedMealsDateRange &&
                    typeof window.scheduleDailySwipeHint === 'function'
                ) {
                    window.scheduleDailySwipeHint(0);
                }
                loadMyShares().then((myShares) => {
                    window.sharedPhotos = myShares;
                    if (appState.currentTab !== 'timeline') return;
                    updateTimelineShareIndicators();
                    syncOrphanedSharesToMoment().then(() => {
                        if (appState.currentTab !== 'timeline') return;
                        updateTimelineShareIndicators();
                    }).catch(() => {});
                }).catch(e => {
                    console.error('본인 공유 로드 실패:', e);
                    window.sharedPhotos = [];
                    if (appState.currentTab === 'timeline') updateTimelineShareIndicators();
                });
            }
            if (typeof window.checkAndShowContentPopup === 'function') {
                setTimeout(() => window.checkAndShowContentPopup(tab), 200);
            }
            syncBoardFeedComposerVisibility();
            syncEntryQuickInputFabVisibility();
            refreshMealSyncResendNavButton();
            scheduleNavDotsAfterTabSwitch(prevTab, tab);
            console.log('[탭전환] 완료:', { 현재탭: appState.currentTab });
        } catch (error) {
            console.error('[탭전환] 오류 발생:', error);
            console.error('[탭전환] 스택:', error.stack);
            showToast('탭 전환 중 오류가 발생했습니다.', 'error');
        }
    };
    syncBoardFeedComposerVisibility();
    syncEntryQuickInputFabVisibility();
    refreshMealSyncResendNavButton();
}
