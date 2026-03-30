/**
 * 메인 하단 탭 전환 (window.switchMainTab)
 */
import { appState } from '../state.js';
import { loadSharedPhotosPage, loadMyShares } from '../db.js';
import { showToast, showLoading, hideLoading } from '../ui.js';
import {
    renderTimeline,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    renderGallery,
    renderBoard,
    syncBoardFeedComposerVisibility
} from '../render/index.js';
import { updateDashboard } from '../analytics.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';
import { isDemoUser } from '../demo-account.js';
import { markMomentFeedNavSeen, markBoardNavSeen } from './nav-feed-update-dots.js';

const HEADER_SECTION_BY_TAB = { dashboard: '밀당', timeline: '밀로그', gallery: '모먼트', board: '밀톡', settings: '사용자' };

function updateHeaderSectionLabel(tab) {
    const el = document.getElementById('headerSectionLabel');
    if (!el) return;
    el.textContent = HEADER_SECTION_BY_TAB[tab] ?? '밀로그';
}

export function registerMainTabSwitch() {
    window.switchMainTab = (tab) => {
        try {
            console.log('[탭전환] 시작:', { 이전탭: appState.currentTab, 새탭: tab });
            const prevTab = appState.currentTab;
            appState.currentTab = tab;
            if (prevTab !== tab) {
                window._contentPopupDismissedVisit = new Set();
            }
            if (prevTab !== tab) {
                if (prevTab === 'timeline' && typeof window.closeSearch === 'function') window.closeSearch();
                if ((prevTab === 'gallery' || prevTab === 'board') && tab !== 'gallery' && tab !== 'board') {
                    const tracePanel = document.getElementById('galleryTraceFilterPanel');
                    if (tracePanel) {
                        tracePanel.classList.remove('expanded');
                    }
                }
            }
            if (tab !== 'gallery') {
                const mainHeader = document.querySelector('#mainApp > header');
                if (mainHeader) mainHeader.classList.remove('hidden');
            }
            updateHeaderSectionLabel(tab);
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
                if (boardListView) boardListView.classList.remove('hidden');
                if (boardDetailView) boardDetailView.classList.add('hidden');
                if (boardWriteView) boardWriteView.classList.add('hidden');

                if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
                const category = window.currentBoardCategory || 'all';
                renderBoard(category);
                document.body.classList.remove('bottom-nav-scroll-hidden');
                setTimeout(() => {
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }, 100);
            } else {
                if (boardListView) boardListView.classList.add('hidden');
                if (boardDetailView) boardDetailView.classList.add('hidden');
                if (boardWriteView) boardWriteView.classList.add('hidden');
            }

            document.getElementById('trackerSection').classList.toggle('hidden', tab !== 'timeline');
            document.getElementById('nav-timeline').className = tab === 'timeline'
                ? 'text-slate-600 flex justify-center items-center py-1 flex-1'
                : 'text-slate-300 flex justify-center items-center py-1 flex-1';
            document.getElementById('nav-gallery').className = tab === 'gallery'
                ? 'text-slate-600 flex justify-center items-center py-1 flex-1'
                : 'text-slate-300 flex justify-center items-center py-1 flex-1';
            document.getElementById('nav-dashboard').className = tab === 'dashboard'
                ? 'text-slate-600 flex justify-center items-center py-1 flex-1'
                : 'text-slate-300 flex justify-center items-center py-1 flex-1';
            document.getElementById('nav-board').className = tab === 'board'
                ? 'text-slate-600 flex justify-center items-center py-1 flex-1'
                : 'text-slate-300 flex justify-center items-center py-1 flex-1';
            const navSettings = document.getElementById('nav-settings');
            if (navSettings) navSettings.className = tab === 'settings'
                ? 'text-slate-600 flex justify-center items-center py-1 flex-1 rounded-full overflow-hidden'
                : 'text-slate-300 flex justify-center items-center py-1 flex-1 rounded-full overflow-hidden';

            if (tab === 'gallery' && appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
                const navGallery = document.getElementById('nav-gallery');
                const navBoard = document.getElementById('nav-board');
                if (navGallery) navGallery.className = 'text-slate-300 flex justify-center items-center py-1';
                if (navBoard) navBoard.className = 'text-slate-600 flex justify-center items-center py-1';
            }

            const searchBtn = document.getElementById('searchTriggerBtn');
            const tracePanel = document.getElementById('galleryTraceFilterPanel');
            const timelineSearchPanel = document.getElementById('timelineSearchPanel');
            const notificationWrap = document.getElementById('notificationWrap');
            const demoLoginWrap = document.getElementById('headerDemoLoginWrap');
            const isDemo = window.currentUser && isDemoUser(window.currentUser);

            if (isDemo) {
                if (demoLoginWrap) demoLoginWrap.classList.remove('hidden');
                if (timelineSearchPanel) {
                    timelineSearchPanel.classList.add('hidden');
                    timelineSearchPanel.classList.remove('expanded');
                }
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
                        const popup = document.getElementById('notificationPopup');
                        if (popup && !popup.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
                    } else {
                        notificationWrap.classList.add('hidden');
                        if (typeof window.closeNotificationPopup === 'function') window.closeNotificationPopup();
                    }
                }
                if (searchBtn) searchBtn.style.display = (tab === 'timeline') ? 'flex' : 'none';
                if (timelineSearchPanel) {
                    if (tab === 'timeline') {
                        timelineSearchPanel.classList.remove('hidden');
                    } else {
                        timelineSearchPanel.classList.add('hidden');
                        timelineSearchPanel.classList.remove('expanded');
                    }
                }
                if (tracePanel) {
                    if (tab === 'gallery' || tab === 'board') {
                        tracePanel.classList.remove('hidden');
                    } else {
                        tracePanel.classList.add('hidden');
                        tracePanel.classList.remove('expanded');
                    }
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
            if (tab === 'dashboard') {
                updateDashboard();
            } else if (tab === 'settings') {
                // 설정 탭 전환 시 폼 채우기는 nav-settings 클릭 시 openSettings()에서 수행
            } else if (tab === 'gallery') {
                document.body.classList.remove('bottom-nav-scroll-hidden');
                // 모먼트 네비 점: 새 글을 스크롤해 볼 필요 없이, 탭(아이콘)으로 들어오면 제거
                markMomentFeedNavSeen();
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
                        showLoading('모먼트 불러오는 중...');
                        loadSharedPhotosPage(10)
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
                    syncOrphanedSharesToMoment().then((synced) => {
                        if (synced > 0) {
                            updateTimelineShareIndicators();
                            showToast('모먼트에 반영되었습니다.', 'success');
                            loadSharedPhotosPage(10).then(({ docs, lastDoc, hasMore }) => {
                                window.sharedPhotosFeed = docs;
                                appState.sharedPhotosFeedLastDoc = lastDoc;
                                appState.sharedPhotosFeedHasMore = hasMore;
                                if (appState.currentTab === 'gallery') renderGallery();
                            });
                        }
                    });
                } else {
                    renderGallery();
                }
                setTimeout(() => {
                    if (appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
                        const navGallery = document.getElementById('nav-gallery');
                        const navBoard = document.getElementById('nav-board');
                        if (navGallery) navGallery.className = 'text-slate-300 flex justify-center items-center py-1';
                        if (navBoard) navBoard.className = 'text-slate-600 flex justify-center items-center py-1';
                    }
                    setTimeout(() => {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }, 100);
                }, 200);
            } else if (tab === 'timeline') {
                if (appState.viewMode === 'list') {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    appState.pageDate = today;
                }
                window.loadedDates = [];
                window.hasScrolledToToday = false;
                const c = document.getElementById('timelineContainer');
                if (c) c.innerHTML = "";
                renderTimeline();
                renderMiniCalendar();
                loadMyShares().then((myShares) => {
                    window.sharedPhotos = myShares;
                    if (appState.currentTab !== 'timeline') return;
                    updateTimelineShareIndicators();
                    syncOrphanedSharesToMoment(myShares).then((synced) => {
                        if (synced > 0 && appState.currentTab === 'timeline') {
                            updateTimelineShareIndicators();
                            showToast('모먼트에 반영되었습니다.', 'success');
                        }
                    });
                }).catch(e => {
                    console.error('본인 공유 로드 실패:', e);
                    window.sharedPhotos = [];
                    if (appState.currentTab === 'timeline') updateTimelineShareIndicators();
                });
            } else if (tab !== 'board') {
                if (appState.viewMode === 'list') {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    appState.pageDate = today;
                }
                window.loadedDates = [];
                window.hasScrolledToToday = false;
                const c = document.getElementById('timelineContainer');
                if (c) c.innerHTML = "";
                renderTimeline();
                renderMiniCalendar();
            }
            if (typeof window.checkAndShowContentPopup === 'function') {
                setTimeout(() => window.checkAndShowContentPopup(tab), 200);
            }
            syncBoardFeedComposerVisibility();
            console.log('[탭전환] 완료:', { 현재탭: appState.currentTab });
        } catch (error) {
            console.error('[탭전환] 오류 발생:', error);
            console.error('[탭전환] 스택:', error.stack);
            showToast('탭 전환 중 오류가 발생했습니다.', 'error');
        }
    };
    syncBoardFeedComposerVisibility();
}
