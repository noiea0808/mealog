// 메인 애플리케이션 로직
console.log('📦 main.js 모듈 로드 시작');

// 모듈 로드 시작 플래그 설정 (index.html의 체크가 감지할 수 있도록)
window.moduleLoading = true;

import { appState, getState } from './state.js';
import {
    auth,
    db,
    appId,
    refreshAppCheckTokenBeforeFirestore,
    registerFirestoreListenersRebind,
    recoverFirestoreAfterWatchAssertion
} from './firebase.js';
import { signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { dbOps, setupListeners, loadSharedPhotosPage, loadSharedPhotosPageReliable, loadMyShares, loadMoreMeals, loadMealsForDateRange, postInteractions, subscribeToMyPostComments, boardOperations, feedOperations, noticeOperations, submitReport, getUserReportForPost, withdrawReport } from './db.js';
import { callableFunctions } from './firebase.js';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, limit, orderBy, getDocs, getDocsFromServer } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
    switchScreen,
    showToast,
    updateHeaderUI,
    showLoading,
    hideLoading
} from './ui.js';
import {
    getDisplayProfile,
    uploadBoardImages,
    captureWithGhostStrategy,
    addCompositionAwareInput,
    warmUpIME,
    sharePhotosToExternal,
    setupBirthdateInputFormatting,
    normalizeUrl,
    getMealogClientEnv
} from './utils.js';
import { 
    initAuth, handleGoogleLogin, handleKakaoLogin, startGuest, openEmailModal, closeEmailModal,
    setEmailAuthMode, toggleEmailAuthMode, handleEmailAuth, requestPasswordReset, confirmLogout, confirmLogoutAction,
    copyDomain, closeDomainModal, switchToLogin, showTermsModal, closeTermsModal, cancelTermsAgreement, confirmTermsAgreement,
    showTermsDetail, updateTermsAgreeButton, selectSetupIcon, confirmProfileSetup, handleEmailSignupWithProfile, continueAsGuestFromProfileSetup, setProfileType, handleSetupPhotoUpload,
    confirmDeleteAccount, cancelDeleteAccount, confirmDeleteAccountAction
} from './auth.js';
import { authFlowManager } from './auth-flow.js';
import { scheduleAttendanceCheckIfNeeded } from './attendance-check.js';
window.scheduleAttendanceCheckIfNeeded = scheduleAttendanceCheckIfNeeded;
import { isDemoUser, markUserHasRealLogin } from './demo-account.js';
import { isUserSettingsReadyForContentWrites } from './utils/user-settings-write-guard.js';
import { getAuthAccountCreatedTimestamp, getAuthAccountCreatedMillis } from './auth-created-at.js';
import { syncDemoNavGuideDots } from './demo-nav-guide.js';
import { initPushNotifications, syncPushRegistrationFromOs } from './push-notifications.js';
import { renderTimeline, renderMiniCalendar, updateTimelineShareIndicators, renderGallery, invalidateGalleryRenderSession, renderFeed, renderEntryChips, toggleComment, toggleFeedComment, createDailyShareCard, renderBoard, renderBoardDetail, renderNoticeDetail, escapeHtml, sanitizeFormattedText, stripDangerousTagsOnly, filterGalleryByUser, clearGalleryFilter, switchGalleryFilterTab, fetchUserProfiles } from './render/index.js';
import './render/timeline-meal-photos-popup.js';
import { updateDashboard, setDashboardMode, updateCustomDates, syncCustomDatePlaceholder, updateSelectedMonth, updateSelectedWeek, changeWeek, changeMonth, navigatePeriod, openDetailModal, closeDetailModal, setAnalysisType, openShareBestModal, closeShareBestModal, shareBestToFeed, closeBestSharePeriodNotice, openCharacterSelectModal, closeCharacterSelectModal, selectInsightCharacter, generateInsightComment, openShareInsightModal, closeShareInsightModal, shareInsightToFeed, openEditInsightShareModal } from './analytics.js';
import { openEditBestShareModal } from './analytics/best-share.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, retryMealEntrySync, retryMealEntryDeleteSync, retryPendingMealEntriesOnAppReady, setRating, setSatiety, selectTag,
    handleMultipleImages, removePhoto, movePhotoOrder, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, switchSettingsTab, saveSettings, saveProfileSettings, selectIcon, setSettingsProfileType, handlePhotoUpload, addTag, removeTag, deleteSubTag, addFavoriteTag, removeFavoriteTag, selectFavoriteMainTag,
    fillProfileActivityStats,
    syncPushPreferencesFormFromUserSettings,
    setRecordPhotoAspectRatio,
    openKakaoPlaceSearch, searchKakaoPlaces, selectKakaoPlace
} from './modals.js';
import { DEFAULT_SUB_TAGS, REPORT_REASONS, SATIETY_DATA } from './constants.js';
import { registerMainNetworkListeners, runMealogNetworkRecovery } from './main/network.js';
import { registerMainCleanup } from './main/cleanup.js';
import { syncOrphanedSharesToMoment } from './main/shares-sync.js';
import { startNotificationListeners, stopNotificationListeners } from './main/notifications.js';
import { registerMainTabSwitch } from './main/tabs.js';
import { clearNavFeedUpdateDots, refreshNavFeedUpdateDots } from './main/nav-feed-update-dots.js';
import { registerContentPopup, recordBannerView, recordBannerClick } from './main/content-popup.js';
import { initEventListeners } from './main/event-listeners.js';
import { registerEventListenerManager } from './main/event-listener-manager.js';
import { registerMomentSyncDevTools } from './main/moment-sync-dev.js';

import { registerMainPostInteractions } from './main/post-interactions-daily.js';
import { registerMainFeedOptionsReport } from './main/feed-options-report.js';
import { registerMainBoardHandlers } from './main/board-handlers.js';
registerMainNetworkListeners();
registerMainCleanup();
registerMainTabSwitch();
registerContentPopup();
registerEventListenerManager();
registerMomentSyncDevTools();
try {
    registerMainPostInteractions();
} catch (e) {
    console.error('❌ registerMainPostInteractions 실패:', e);
}
registerMainFeedOptionsReport();
registerMainBoardHandlers();

// 전역 네임스페이스 객체 생성 (하위 호환성 유지)
window.Mealog = window.Mealog || {};

// 전역 객체에 함수들 할당 (HTML에서 접근 가능하도록)
// 하위 호환성을 위해 window.*에도 유지하고, window.Mealog에도 할당
window.dbOps = dbOps;
window.Mealog.dbOps = dbOps;
window.postInteractions = postInteractions;
window.Mealog.postInteractions = postInteractions;
window.removeDuplicateMeals = () => dbOps.removeDuplicateMeals();
window.Mealog.removeDuplicateMeals = window.removeDuplicateMeals;
window.showToast = showToast;
window.Mealog.showToast = showToast;
window.renderTimeline = renderTimeline;
window.Mealog.renderTimeline = renderTimeline;
window.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.Mealog.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.renderGallery = renderGallery;
window.Mealog.renderGallery = renderGallery;
window.filterGalleryByUser = filterGalleryByUser;
window.Mealog.filterGalleryByUser = filterGalleryByUser;
window.clearGalleryFilter = clearGalleryFilter;
window.Mealog.clearGalleryFilter = clearGalleryFilter;
window.switchGalleryFilterTab = switchGalleryFilterTab;
window.Mealog.switchGalleryFilterTab = switchGalleryFilterTab;
/** 네트워크 오류 등으로 모먼트 피드 로드가 실패했을 때 '다시 불러오기'로 호출. 전체 피드/사용자 필터 모드 모두 처리 */
window.reloadMomentFeed = async function reloadMomentFeed() {
    invalidateGalleryRenderSession();
    try {
        await recoverFirestoreAfterWatchAssertion('reloadMomentFeed', { force: true });
    } catch (e) {
        console.warn('모먼트: Firestore 인스턴스 복구 실패(이어서 로드 시도):', e?.message || e);
    }
    try {
        await runMealogNetworkRecovery();
    } catch (_) {
        /* 오프라인 복귀 시도만 하고 실패해도 getDocsFromServer로 재시도 */
    }
    appState.galleryFeedNetworkError = false;
    if (appState.galleryFilterUserId) {
        appState.galleryUserProfileSharedDocs = null;
        appState.galleryUserProfileSharedLastSnap = null;
        appState.galleryUserProfileSharedHasMore = true;
        appState.galleryUserProfileSharedDocSnaps = new Map();
        try {
            invalidateGalleryRenderSession();
            await renderGallery({ forceReload: true });
        } catch (e) {
            console.error('모먼트(프로필) 다시 불러오기 렌더 실패:', e);
        }
        if (typeof renderFeed === 'function') renderFeed();
        return;
    }
    window.sharedPhotosFeed = [];
    appState.sharedPhotosFeedLastDoc = null;
    appState.sharedPhotosFeedHasMore = false;
    showLoading('모먼트 불러오는 중...', { dimBackground: false, recordsFab: true });
    try {
        const { docs, lastDoc, hasMore } = await loadSharedPhotosPageReliable(10);
        appState.galleryFeedNetworkError = false;
        window.sharedPhotosFeed = docs;
        appState.sharedPhotosFeedLastDoc = lastDoc;
        appState.sharedPhotosFeedHasMore = hasMore;
        appState.sharedPhotosFeedPrefetchedAt = Date.now();
        invalidateGalleryRenderSession();
        await renderGallery({ forceReload: true });
    } catch (e) {
        console.error('공유 사진 로드 실패:', e);
        appState.galleryFeedNetworkError = true;
        invalidateGalleryRenderSession();
        await renderGallery({ forceReload: true });
    } finally {
        hideLoading();
        if (typeof renderFeed === 'function') renderFeed();
    }
};
window.Mealog.reloadMomentFeed = window.reloadMomentFeed;
window.Mealog.runNetworkRecovery = runMealogNetworkRecovery;
// 밀톡에서 작성자 클릭 시 사용자 프로필 화면(모먼트와 동일)으로 이동, 밀톡 탭 선택 상태로 표시. 뒤로가기 시 밀톡으로 복귀하기 위해 진입 탭 저장
window.openUserProfileFromBoard = (userId) => {
    if (!userId) return;
    appState.galleryFilterEntryTab = 'board'; // 뒤로가기 시 밀톡 탭으로 나가기 위함
    appState.galleryFilterTab = 'board';
    filterGalleryByUser(userId, '사용자');
    if (typeof window.switchMainTab === 'function') window.switchMainTab('gallery');
};
window.Mealog.openUserProfileFromBoard = window.openUserProfileFromBoard;

/** 설정 → 내 게시물: 모먼트 탭에서 본인 프로필(공유·게시판)로 이동 */
window.openMyPostsFromSettings = () => {
    const u = window.currentUser;
    if (!u || u.isAnonymous) {
        showToast('로그인 후 이용할 수 있습니다.', 'error');
        return;
    }
    appState.galleryFilterEntryTab = 'settings';
    appState.galleryFilterTab = 'moment';
    filterGalleryByUser(u.uid, '');
    if (typeof window.switchMainTab === 'function') window.switchMainTab('gallery');
    if (typeof closeSettings === 'function') closeSettings();
};
window.Mealog.openMyPostsFromSettings = window.openMyPostsFromSettings;

// 사용자 프로필 뷰 내 모먼트/밀톡 탭 전환 시 하단 탭 표시 동기화 (render.js에서 호출)
window.syncBottomNavForGalleryFilter = () => {
    const navGallery = document.getElementById('nav-gallery');
    const navBoard = document.getElementById('nav-board');
    if (!navGallery || !navBoard) return;
    if (appState.currentTab === 'gallery' && appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
        navGallery.className = 'text-slate-300 flex justify-center items-center py-1';
        navBoard.className = 'text-slate-600 flex justify-center items-center py-1';
    } else if (appState.currentTab === 'gallery') {
        navGallery.className = 'text-slate-600 flex justify-center items-center py-1';
        navBoard.className = 'text-slate-300 flex justify-center items-center py-1';
    }
};
window.Mealog.syncBottomNavForGalleryFilter = window.syncBottomNavForGalleryFilter;
window.updateHeaderUI = updateHeaderUI;
window.Mealog.updateHeaderUI = updateHeaderUI;
window.copyDomain = copyDomain;
window.Mealog.copyDomain = copyDomain;
window.closeDomainModal = closeDomainModal;
window.Mealog.closeDomainModal = closeDomainModal;
window.handleGoogleLogin = handleGoogleLogin;
window.Mealog.handleGoogleLogin = handleGoogleLogin;
window.handleKakaoLogin = handleKakaoLogin;
window.Mealog.handleKakaoLogin = handleKakaoLogin;
window.startGuest = startGuest;
window.Mealog.startGuest = startGuest;
window.openEmailModal = openEmailModal;
window.Mealog.openEmailModal = openEmailModal;
window.closeEmailModal = closeEmailModal;
window.Mealog.closeEmailModal = closeEmailModal;
window.setEmailAuthMode = setEmailAuthMode;
window.Mealog.setEmailAuthMode = setEmailAuthMode;
window.toggleEmailAuthMode = toggleEmailAuthMode;
window.Mealog.toggleEmailAuthMode = toggleEmailAuthMode;
window.handleEmailAuth = handleEmailAuth;
window.Mealog.handleEmailAuth = handleEmailAuth;
window.requestPasswordReset = requestPasswordReset;
window.Mealog.requestPasswordReset = requestPasswordReset;
window.confirmLogout = confirmLogout;
window.Mealog.confirmLogout = confirmLogout;
window.confirmLogoutAction = confirmLogoutAction;
window.Mealog.confirmLogoutAction = confirmLogoutAction;
window.confirmDeleteAccount = confirmDeleteAccount;
window.Mealog.confirmDeleteAccount = confirmDeleteAccount;
window.switchToLogin = switchToLogin;
window.Mealog.switchToLogin = switchToLogin;
window.showTermsModal = showTermsModal;
window.Mealog.showTermsModal = showTermsModal;
window.closeTermsModal = closeTermsModal;
window.Mealog.closeTermsModal = closeTermsModal;
window.cancelTermsAgreement = cancelTermsAgreement;
window.Mealog.cancelTermsAgreement = cancelTermsAgreement;
window.confirmTermsAgreement = confirmTermsAgreement;
window.Mealog.confirmTermsAgreement = confirmTermsAgreement;
window.showTermsDetail = showTermsDetail;
window.Mealog.showTermsDetail = showTermsDetail;
window.updateTermsAgreeButton = updateTermsAgreeButton;
window.Mealog.updateTermsAgreeButton = updateTermsAgreeButton;
window.selectSetupIcon = selectSetupIcon;
window.Mealog.selectSetupIcon = selectSetupIcon;
window.confirmProfileSetup = confirmProfileSetup;
window.Mealog.confirmProfileSetup = confirmProfileSetup;
window.setProfileType = setProfileType;
window.Mealog.setProfileType = setProfileType;
window.handleSetupPhotoUpload = handleSetupPhotoUpload;
window.Mealog.handleSetupPhotoUpload = handleSetupPhotoUpload;
window.openModal = openModal;
window.Mealog.openModal = openModal;
window.closeModal = closeModal;
window.Mealog.closeModal = closeModal;
window.saveEntry = saveEntry;
window.Mealog.saveEntry = saveEntry;
window.deleteEntry = deleteEntry;
window.Mealog.deleteEntry = deleteEntry;
window.retryMealEntrySync = retryMealEntrySync;
window.Mealog.retryMealEntrySync = retryMealEntrySync;
window.retryMealEntryDeleteSync = retryMealEntryDeleteSync;
window.Mealog.retryMealEntryDeleteSync = retryMealEntryDeleteSync;
window.setRating = setRating;
window.Mealog.setRating = setRating;
window.setSatiety = setSatiety;
window.Mealog.setSatiety = setSatiety;
window.selectTag = selectTag;
window.Mealog.selectTag = selectTag;
window.handleMultipleImages = handleMultipleImages;
window.Mealog.handleMultipleImages = handleMultipleImages;
window.removePhoto = removePhoto;
window.Mealog.removePhoto = removePhoto;
window.movePhotoOrder = movePhotoOrder;
window.Mealog.movePhotoOrder = movePhotoOrder;
window.updateShareIndicator = updateShareIndicator;
window.Mealog.updateShareIndicator = updateShareIndicator;
window.toggleSharePhoto = toggleSharePhoto;
window.Mealog.toggleSharePhoto = toggleSharePhoto;
window.setRecordPhotoAspectRatio = setRecordPhotoAspectRatio;
window.Mealog.setRecordPhotoAspectRatio = setRecordPhotoAspectRatio;
window.openSettings = openSettings;
window.Mealog.openSettings = openSettings;
window.fillProfileActivityStats = fillProfileActivityStats;
window.Mealog.fillProfileActivityStats = fillProfileActivityStats;
window.closeSettings = closeSettings;
window.Mealog.closeSettings = closeSettings;
window.switchSettingsTab = switchSettingsTab;
window.Mealog.switchSettingsTab = switchSettingsTab;
window.saveSettings = saveSettings;
window.Mealog.saveSettings = saveSettings;
window.saveProfileSettings = saveProfileSettings;
window.Mealog.saveProfileSettings = saveProfileSettings;
window.selectIcon = selectIcon;
window.Mealog.selectIcon = selectIcon;
window.setSettingsProfileType = setSettingsProfileType;
window.Mealog.setSettingsProfileType = setSettingsProfileType;
window.handlePhotoUpload = handlePhotoUpload;
window.Mealog.handlePhotoUpload = handlePhotoUpload;
window.addTag = addTag;
window.Mealog.addTag = addTag;
window.removeTag = removeTag;
window.Mealog.removeTag = removeTag;
window.deleteSubTag = deleteSubTag;
window.Mealog.deleteSubTag = deleteSubTag;
window.addFavoriteTag = addFavoriteTag;
window.Mealog.addFavoriteTag = addFavoriteTag;
window.removeFavoriteTag = removeFavoriteTag;
window.Mealog.removeFavoriteTag = removeFavoriteTag;
window.selectFavoriteMainTag = selectFavoriteMainTag;
window.Mealog.selectFavoriteMainTag = selectFavoriteMainTag;
window.setDashboardMode = setDashboardMode;
window.Mealog.setDashboardMode = setDashboardMode;
window.updateCustomDates = updateCustomDates;
window.syncCustomDatePlaceholder = syncCustomDatePlaceholder;
window.Mealog.updateCustomDates = updateCustomDates;
window.updateSelectedMonth = updateSelectedMonth;
window.Mealog.updateSelectedMonth = updateSelectedMonth;
window.updateSelectedWeek = updateSelectedWeek;
window.Mealog.updateSelectedWeek = updateSelectedWeek;
window.navigatePeriod = navigatePeriod;
window.Mealog.navigatePeriod = navigatePeriod;
window.openDetailModal = openDetailModal;
window.Mealog.openDetailModal = openDetailModal;
window.openCharacterSelectModal = openCharacterSelectModal;
window.Mealog.openCharacterSelectModal = openCharacterSelectModal;
window.closeCharacterSelectModal = closeCharacterSelectModal;
window.Mealog.closeCharacterSelectModal = closeCharacterSelectModal;
window.selectInsightCharacter = selectInsightCharacter;
window.Mealog.selectInsightCharacter = selectInsightCharacter;
window.generateInsightComment = generateInsightComment;
window.Mealog.generateInsightComment = generateInsightComment;
window.openShareInsightModal = openShareInsightModal;
window.Mealog.openShareInsightModal = openShareInsightModal;
window.closeShareInsightModal = closeShareInsightModal;
window.Mealog.closeShareInsightModal = closeShareInsightModal;
window.shareInsightToFeed = shareInsightToFeed;
window.Mealog.shareInsightToFeed = shareInsightToFeed;
window.closeDetailModal = closeDetailModal;
window.Mealog.closeDetailModal = closeDetailModal;
window.setAnalysisType = setAnalysisType;
window.Mealog.setAnalysisType = setAnalysisType;
window.openShareBestModal = openShareBestModal;
window.Mealog.openShareBestModal = openShareBestModal;
window.closeShareBestModal = closeShareBestModal;
window.Mealog.closeShareBestModal = closeShareBestModal;
window.closeBestSharePeriodNotice = closeBestSharePeriodNotice;
window.shareBestToFeed = shareBestToFeed;
window.Mealog.shareBestToFeed = shareBestToFeed;
window.editBestShare = openEditBestShareModal;
window.Mealog.editBestShare = openEditBestShareModal;
window.editInsightShare = openEditInsightShareModal;
window.Mealog.editInsightShare = openEditInsightShareModal;
window.toggleComment = toggleComment;
window.Mealog.toggleComment = toggleComment;
window.toggleFeedComment = toggleFeedComment;
window.Mealog.toggleFeedComment = toggleFeedComment;
window.openKakaoPlaceSearch = openKakaoPlaceSearch;
window.Mealog.openKakaoPlaceSearch = openKakaoPlaceSearch;
window.searchKakaoPlaces = searchKakaoPlaces;
window.Mealog.searchKakaoPlaces = searchKakaoPlaces;
window.selectKakaoPlace = selectKakaoPlace;
window.Mealog.selectKakaoPlace = selectKakaoPlace;
window.boardOperations = boardOperations;
window.Mealog.boardOperations = boardOperations;
window.feedOperations = feedOperations;
window.Mealog.feedOperations = feedOperations;
window.noticeOperations = noticeOperations;
window.Mealog.noticeOperations = noticeOperations;
window.renderBoard = renderBoard;
window.Mealog.renderBoard = renderBoard;
window.renderBoardDetail = renderBoardDetail;
window.Mealog.renderBoardDetail = renderBoardDetail;
window.renderNoticeDetail = renderNoticeDetail;
window.Mealog.renderNoticeDetail = renderNoticeDetail;

// 피드 관련 함수들은 아래에서 정의되지만, 여기서도 확인
// (함수들이 정의되기 전에 renderFeed가 호출될 수 있으므로)
// 탭 전환: main/tabs.js → registerMainTabSwitch()
// 콘텐츠 팝업: main/content-popup.js → registerContentPopup()

window.setViewMode = (m) => {
    appState.viewMode = m;
    document.getElementById('btn-view-list').className = `view-tab ${m === 'list' ? 'active' : 'inactive'}`;
    document.getElementById('btn-view-page').className = `view-tab ${m === 'page' ? 'active' : 'inactive'}`;
    if (m === 'list') {
        // 오늘 날짜로 설정
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        appState.pageDate = today;
    }
    window.loadedDates = [];
    window.hasScrolledToToday = false; // 스크롤 플래그 리셋
    const c = document.getElementById('timelineContainer');
    if (c) c.innerHTML = "";
    renderTimeline();
    renderMiniCalendar();
};

window.jumpToDate = async (iso) => {
    // 날짜를 명확하게 설정 (시간대 문제 방지)
    const targetDate = new Date(iso + 'T00:00:00');
    appState.pageDate = targetDate;
    
    // 선택한 날짜가 로드된 범위 밖이면 먼저 데이터 로드
    const range = window.loadedMealsDateRange;
    if (range && iso < range.start) {
        try {
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) loadingOverlay.classList.remove('hidden');
            await loadMealsForDateRange(iso, range.start);
        } catch (e) {
            console.warn('날짜 이동 시 데이터 로드 실패:', e);
            showToast('기록을 불러오는 중 오류가 발생했습니다.', 'error');
        } finally {
            const loadingOverlay = document.getElementById('loadingOverlay');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
        }
    }
    
    if (appState.viewMode === 'list') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // 로컬 날짜로 변환하여 시간대 문제 방지
        const todayYear = today.getFullYear();
        const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
        const todayDay = String(today.getDate()).padStart(2, '0');
        const todayStr = `${todayYear}-${todayMonth}-${todayDay}`;
        const targetStr = iso;
        
        // 오늘부터 선택한 날짜까지의 날짜 차이 계산 (날짜만 비교)
        const [todayY, todayM, todayD] = todayStr.split('-').map(Number);
        const [targetY, targetM, targetD] = targetStr.split('-').map(Number);
        const todayDateOnly = new Date(todayY, todayM - 1, todayD);
        const targetDateOnly = new Date(targetY, targetM - 1, targetD);
        const diffDays = Math.ceil((todayDateOnly - targetDateOnly) / (1000 * 60 * 60 * 24));
        
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        
        // 선택한 날짜가 포함될 때까지 렌더링
        renderTimeline();
        while (!window.loadedDates.includes(targetStr) && window.loadedDates.length < Math.max(diffDays + 5, 10)) {
            renderTimeline();
        }
        
        renderMiniCalendar();
        
        // 저장 후 자동 스크롤이 아니면 기본 스크롤 동작 실행
        if (!window.isScrolling) {
            setTimeout(() => {
                const el = document.getElementById(`date-${targetStr}`);
                if (el) {
                    // 트래커 섹션 높이를 고려하여 스크롤
                    const trackerSection = document.getElementById('trackerSection');
                    const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                    const headerHeight = 73;
                    const totalOffset = headerHeight + trackerHeight;
                    const elementTop = el.getBoundingClientRect().top + window.pageYOffset;
                    const offsetPosition = elementTop - totalOffset - 16;
                    window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                }
            }, 200);
        }
    } else {
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        renderTimeline();
        renderMiniCalendar();
    }
};

window.toggleGalleryTracePanel = () => {
    const panel = document.getElementById('galleryTraceFilterPanel');
    if (panel) panel.classList.toggle('expanded');
    if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
};

/** 타임라인 검색 확장 너비: timeline-search-expanded 시 flex로 처리, 그 외 폴백 */
function updateTimelineSearchExpandWidth() {
    const wrapper = document.getElementById('timelineSearchPanel');
    const panel = wrapper?.querySelector('.timeline-search-panel');
    const header = document.getElementById('mainAppHeader');
    if (!wrapper || !panel || !header) return;
    if (!wrapper.classList.contains('expanded')) {
        panel.style.width = '';
        wrapper.style.width = '';
        return;
    }
    /* timeline-search-expanded 클래스가 있으면 flex로 sub-title까지 확장 (CSS에서 처리) */
    if (header.classList.contains('timeline-search-expanded')) {
        wrapper.style.width = '';
        return;
    }
    /* 폴백: JS로 너비 계산 */
    const leftBlock = document.querySelector('header .mealog-title')?.parentElement;
    if (!leftBlock) return;
    const leftBlockRight = leftBlock.getBoundingClientRect().right;
    const headerRect = header.getBoundingClientRect();
    const headerRight = headerRect.right - 24; /* px-6 */
    const notificationWrap = document.getElementById('notificationWrap');
    const notificationWidth = (notificationWrap && !notificationWrap.classList.contains('hidden'))
        ? notificationWrap.getBoundingClientRect().width : 0;
    const gap = 8; /* gap-2 */
    let w = headerRight - leftBlockRight - 8 - notificationWidth - gap;
    w = Math.max(96, w);
    wrapper.style.width = `${w}px`;
}

window.toggleSearch = () => {
    if (appState.currentTab === 'gallery' || appState.currentTab === 'board') {
        window.toggleGalleryTracePanel();
        return;
    }
    const panel = document.getElementById('timelineSearchPanel');
    if (!panel) return;
    if (panel.classList.contains('expanded')) {
        window.closeSearch();
    } else {
        panel.classList.add('expanded');
        document.getElementById('mainAppHeader')?.classList.add('timeline-search-expanded');
        requestAnimationFrame(updateTimelineSearchExpandWidth);
        document.getElementById('searchInput')?.focus();
    }
};

window.closeSearch = () => {
    const wrapper = document.getElementById('timelineSearchPanel');
    const header = document.getElementById('mainAppHeader');
    if (header) header.classList.remove('timeline-search-expanded');
    if (wrapper) {
        wrapper.classList.remove('expanded');
        const panel = wrapper.querySelector('.timeline-search-panel');
        if (panel) panel.style.width = '';
        wrapper.style.width = '';
    }
    document.getElementById('searchInput')?.blur();
    const inp = document.getElementById('searchInput');
    if (inp) inp.value = '';
    window.currentSearchQuery = '';
    window.loadedDates = [];
    const tc = document.getElementById('timelineContainer');
    if (tc) tc.innerHTML = '';
    renderTimeline();
};

window.clearGalleryFilterPostId = () => {
    appState.galleryFilterPostId = null;
    renderGallery();
};

window.addEventListener('resize', updateTimelineSearchExpandWidth);

// 앨범/밀톡 흔적 필터 패널 버튼 상태 갱신
window.updateGalleryTraceFilterBarUI = () => {
    const panel = document.getElementById('galleryTraceFilterPanel');
    if (!panel) return;
    const f = appState.currentTab === 'board' ? appState.boardTraceFilter : appState.galleryTraceFilter;
    ['like', 'comment', 'bookmark'].forEach((trace) => {
        const btn = panel.querySelector(`[data-trace="${trace}"]`);
        if (!btn) return;
        const icon = btn.querySelector('i');
        const isActive = f === trace;
        btn.classList.toggle('bg-slate-100', isActive);
        btn.classList.toggle('text-slate-700', isActive && trace !== 'like');
        btn.classList.remove('text-red-500');
        if (trace === 'like') {
            if (isActive) { btn.classList.add('text-red-500'); }
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid', 'fa-heart');
                icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-heart');
            }
        } else if (trace === 'comment' && icon) {
            icon.classList.remove('fa-regular', 'fa-solid');
            icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-comment');
        } else if (trace === 'bookmark' && icon) {
            icon.classList.remove('fa-regular', 'fa-solid');
            icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-bookmark');
        }
    });
};

// 앨범/밀톡 흔적 필터 설정 및 다시 렌더 (같은 필터 재클릭 시 해제)
window.setGalleryTraceFilter = (value) => {
    if (!value || value === 'collapse') return;
    const v = value === '' || value == null ? null : value;
    if (v && (!window.currentUser || window.currentUser.isAnonymous)) {
        showToast('로그인이 필요합니다.', 'error');
        window.requestLogin();
        return;
    }
    if (appState.currentTab === 'board') {
        appState.boardTraceFilter = (appState.boardTraceFilter === v) ? null : v;
    } else {
        appState.galleryTraceFilter = (appState.galleryTraceFilter === v) ? null : v;
    }
    if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
    
    if (appState.currentTab === 'gallery') {
        renderGallery();
    } else if (appState.currentTab === 'board') {
        if (appState.boardTraceFilter && appState.boardListSubTab === 'feed' && typeof window.switchBoardListSubTab === 'function') {
            window.switchBoardListSubTab('board');
            return;
        }
        const category = window.currentBoardCategory || 'all';
        renderBoard(category);
    }
};

/** 검색어를 붉은색으로 강조한 HTML 반환 */
function highlightKeyword(text, keyword) {
    if (!keyword || !text) return escapeHtml(String(text ?? ''));
    const k = keyword.toLowerCase();
    const t = String(text);
    const idx = t.toLowerCase().indexOf(k);
    if (idx < 0) return escapeHtml(t);
    const before = t.slice(0, idx);
    const match = t.slice(idx, idx + k.length);
    const after = t.slice(idx + k.length);
    return escapeHtml(before) + `<span class="text-red-600 font-bold">${escapeHtml(match)}</span>` + highlightKeyword(after, keyword);
}
window.handleSearch = (k) => {
    const c = document.getElementById('timelineContainer');
    if (!c) return;
    const q = (k || '').trim();
    window.currentSearchQuery = q;
    if (!q) {
        window.loadedDates = [];
        c.innerHTML = "";
        renderTimeline();
        return;
    }
    const kw = q.toLowerCase();
    const res = (window.mealHistory || []).filter(m =>
        (m.menuDetail?.toLowerCase().includes(kw) ||
         m.deliveryVendor?.toLowerCase().includes(kw) ||
         m.place?.toLowerCase().includes(kw) ||
         m.category?.toLowerCase().includes(kw) ||
         (m.withWhomDetail || m.withWhom || '')?.toLowerCase().includes(kw) ||
         m.snackDetail?.toLowerCase().includes(kw) ||
         m.snackType?.toLowerCase().includes(kw))
    );
    const fmt = (v) => (v == null || v === '' || v === undefined) ? '-' : String(v);
    const fmtDate = (d) => {
        if (!d) return '-';
        const [y, m, n] = String(d).split('-');
        return m && n ? `${parseInt(m, 10)}월 ${parseInt(n, 10)}일` : d;
    };
    const satietyData = (v) => SATIETY_DATA?.find(d => d.val === parseInt(v, 10));
    const ratingStarsHtml = (rating) => {
        const n = rating ? parseInt(rating, 10) : 0;
        if (n < 1 || n > 5) return '';
        return `<span class="inline-flex items-center gap-0.5 text-yellow-500" title="만족도 ${n}점">${'<i class="fa-solid fa-star text-sm"></i>'.repeat(n)}</span>`;
    };
    const satietyIconHtml = (v) => {
        const s = satietyData(v);
        if (!s) return '';
        return `<span class="inline-flex items-center ${s.color}" title="${escapeHtml(s.label)}"><i class="fa-solid ${s.icon} text-sm"></i></span>`;
    };
    const isSnack = (r) => r.slotId === 'snack' || (r.slotId && String(r.slotId).toLowerCase().includes('snack'));
    const safe = (x) => escapeHtml(String(x ?? ''));
    const hl = (text) => highlightKeyword(text, q);
    c.innerHTML = `<div class="px-2 py-3 text-sm font-bold text-slate-500">결과 ${res.length}건</div>` +
        res.map(r => {
            const how = isSnack(r) ? (r.mealType || r.snackType || '-') : (r.mealType || '-');
            const where = isSnack(r) ? (r.snackPlace || r.place || '-') : (r.place || '-');
            const what = isSnack(r) ? (r.snackDetail || r.snackType || '-') : (r.menuDetail || r.category || '-');
            const whom = r.withWhomDetail || r.withWhom || '-';
            const rating = isSnack(r) ? (r.snackRating ?? r.rating) : r.rating;
            const ratingHtml = ratingStarsHtml(rating);
            const satietyHtml = satietyIconHtml(r.satiety);
            const textItems = [how, what, whom].map(v => v === '-' ? '' : hl(v)).filter(Boolean);
            const iconItems = [ratingHtml, satietyHtml].filter(Boolean);
            const textPart = textItems.length > 0 ? textItems.join('<span class="text-slate-300 mx-1">·</span>') : '';
            const iconPart = iconItems.length > 0 ? iconItems.map(h => `<span class="inline-flex items-center">${h}</span>`).join('<span class="text-slate-300 mx-1">·</span>') : '';
            const tagsHtml = [textPart, iconPart].filter(Boolean).join('<span class="text-slate-300 mx-1">·</span>');
            return `<div class="search-result-item px-3 py-3 mb-3 border border-slate-200 rounded-xl active:bg-slate-50 transition-colors cursor-pointer" data-date="${safe(r.date)}" data-slot-id="${safe(r.slotId)}" data-entry-id="${safe(r.id)}">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-bold text-slate-800">${hl(fmtDate(r.date))}</span>
                    ${where !== '-' ? `<span class="text-slate-400">|</span><span class="text-sm text-slate-600">${hl(where)}</span>` : ''}
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-1 text-sm text-slate-600">${tagsHtml}</div>
            </div>`;
        }).join('');
    c.querySelectorAll('.search-result-item').forEach(el => {
        el.addEventListener('click', () => {
            window.openModal(el.dataset.date, el.dataset.slotId, el.dataset.entryId);
        });
    });
};

// 더보기 함수 (타임라인용)
window.loadMoreMealsTimeline = async () => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        const count = await loadMoreMeals(1); // 1개월 더 로드
        if (count > 0) {
            window.loadedDates = [];
            const container = document.getElementById('timelineContainer');
            if (container) container.innerHTML = "";
            renderTimeline();
            // 새로 로드된 meal에 공유 표시만 있고 모먼트에 없으면 동기화
            syncOrphanedSharesToMoment().then((synced) => {
                if (synced > 0) {
                    updateTimelineShareIndicators();
                    showToast('모먼트에 반영되었습니다.', 'success');
                }
            }).catch(() => {});
            renderMiniCalendar();
            showToast(`${count}개의 기록을 불러왔습니다.`, 'success');
        } else {
            showToast("더 이상 불러올 기록이 없습니다.", 'info');
            // 더보기 버튼 제거
            const loadMoreBtn = document.getElementById('loadMoreMealsBtn');
            if (loadMoreBtn) loadMoreBtn.remove();
        }
    } catch (e) {
        console.error("더보기 로드 실패:", e);
        showToast("기록을 불러오는 중 오류가 발생했습니다.", 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

/** users 루트 createdAt — Auth UID 최초 생성 시각(없을 때만 serverTimestamp) */
function resolveUserRootCreatedAt(user) {
    const t = getAuthAccountCreatedTimestamp(user);
    if (t) return t;
    console.warn('⚠️ Auth metadata.creationTime 없음 → 가입일에 serverTimestamp 사용');
    return serverTimestamp();
}

/**
 * 사용자 문서 업데이트 (가입일, 마지막 로그인 날짜)
 */
async function updateUserDocument(user) {
    if (!user || user.isAnonymous) return;
    if (isDemoUser(user)) return;

    try {
        await refreshAppCheckTokenBeforeFirestore();
        const userDocRef = doc(db, 'artifacts', appId, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        
        const updateData = {
            lastLoginAt: serverTimestamp()
        };
        
        const canBackfillJoinDate = () => {
            const s = window.userSettings;
            if (!s) return false;
            return isUserSettingsReadyForContentWrites(s);
        };

        if (!userDocSnap.exists()) {
            // 신규 사용자: 기본은 프로필 완료 후 ensureUserRegistered에서 createdAt 기록.
            // 이미 프로필 완료 상태로 첫 저장이면(레이스) 같은 틱에 가입일을 넣는다.
            {
                let providerId = user.providerData?.[0]?.providerId;
                if (!providerId && typeof user.uid === 'string' && user.uid.startsWith('kakao_')) {
                    providerId = 'kakao.com';
                }
                if (providerId) {
                    updateData.providerId = providerId;
                }
            }
            if (user.email) {
                updateData.email = user.email;
            }
            if (canBackfillJoinDate()) {
                updateData.createdAt = resolveUserRootCreatedAt(user);
                console.log('✅ 신규 사용자 문서 + 가입일(Auth UID 생성 시각) 동시 기록:', user.uid);
            } else {
                console.log('✅ 신규 사용자 문서 생성 (가입일은 프로필/약관 충족 후 등록):', { userId: user.uid });
            }
        } else {
            const existingData = userDocSnap.data();
            // 가입일 누락 백필: 유효 닉 + (프로필 완료 또는 약관 동의)
            if (!existingData.createdAt && canBackfillJoinDate()) {
                updateData.createdAt = resolveUserRootCreatedAt(user);
                console.log('✅ 가입일 백필(Auth UID 생성 시각·닉·약관/프로필 기준):', user.uid);
            }
            if (!existingData.providerId) {
                let pid = user.providerData?.[0]?.providerId;
                if (!pid && typeof user.uid === 'string' && user.uid.startsWith('kakao_')) {
                    pid = 'kakao.com';
                }
                if (pid) {
                    updateData.providerId = pid;
                }
            }
            if (!existingData.email && user.email) {
                updateData.email = user.email;
            }
            if (!existingData.createdAt && !updateData.createdAt) {
                console.log('✅ 사용자 문서 업데이트 (마지막 로그인):', { userId: user.uid });
            }
        }
        
        try {
            await setDoc(userDocRef, updateData, { merge: true });
        } catch (writeErr) {
            const wcode = writeErr?.code || '';
            if (wcode === 'permission-denied' && callableFunctions?.patchArtifactUserRoot) {
                try {
                    await callableFunctions.patchArtifactUserRoot({
                        setCreatedAt: !!updateData.createdAt,
                        createdAtMillis: updateData.createdAt ? getAuthAccountCreatedMillis(user) : null,
                        providerId: updateData.providerId ?? null,
                        email: updateData.email ?? null
                    });
                    console.log('✅ 사용자 문서 서버 폴백 저장:', user.uid);
                } catch (fe) {
                    console.error('❌ 사용자 문서 서버 폴백 실패:', fe?.code || fe?.message || fe);
                }
            } else {
                throw writeErr;
            }
        }
    } catch (e) {
        console.error('❌ 사용자 문서 업데이트 실패:', e);
        // 에러가 발생해도 계속 진행 (비중요한 정보이므로)
    }
}

/** 게스트(둘러보기) 방문 기록 — 관리자 대시보드 '둘러보기' 통계용 */
async function recordGuestVisit(uid) {
    if (!uid || !db || !appId) return;
    try {
        const guestVisitsRef = doc(db, 'artifacts', appId, 'guestVisits', uid);
        const snap = await getDoc(guestVisitsRef);
        const data = { userId: uid, lastVisitedAt: serverTimestamp() };
        if (!snap.exists()) data.firstVisitedAt = serverTimestamp();
        await setDoc(guestVisitsRef, data, { merge: true });
        console.log('✅ 둘러보기 방문 기록됨 (관리자 대시보드 통계):', uid);
    } catch (e) {
        console.warn('게스트 방문 기록 실패 (관리자 대시보드 둘러보기 카운트에 반영 안 됨):', e?.message || e);
    }
}
window.recordGuestVisit = recordGuestVisit;

/** users 루트 createdAt → ms (탈퇴 후 동일 UID 재가입 시 Auth보다 이른 값 구분용) */
function rootCreatedAtToMillis(v) {
    if (v == null) return null;
    if (typeof v.toMillis === 'function') {
        const m = v.toMillis();
        return Number.isFinite(m) ? m : null;
    }
    if (v instanceof Date) {
        const t = v.getTime();
        return Number.isFinite(t) ? t : null;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'object' && typeof v.seconds === 'number') {
        return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
    return null;
}

/** 프로필 설정 완료 시 가입 완료(createdAt) 등록. signup-wizard / auth에서 호출 */
window.ensureUserRegistered = async function () {
    const user = auth.currentUser;
    if (!user || user.isAnonymous) return;
    const s = window.userSettings;
    if (!s || !isUserSettingsReadyForContentWrites(s)) return;
    try {
        await refreshAppCheckTokenBeforeFirestore();
        const userDocRef = doc(db, 'artifacts', appId, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        const data = userDocSnap.exists() ? userDocSnap.data() : {};
        const authMs = getAuthAccountCreatedMillis(user);
        const existingMs = rootCreatedAtToMillis(data.createdAt);
        const staleCreatedAt =
            existingMs != null &&
            authMs != null &&
            existingMs < authMs - 5000;
        if (data.createdAt && !staleCreatedAt) return;

        let providerId = user.providerData?.[0]?.providerId;
        if (!providerId && typeof user.uid === 'string' && user.uid.startsWith('kakao_')) {
            providerId = 'kakao.com';
        }
        const payload = { createdAt: resolveUserRootCreatedAt(user) };
        if (!userDocSnap.exists() || !data.uid) {
            payload.uid = user.uid;
        }
        if (providerId && (!userDocSnap.exists() || !data.providerId)) {
            payload.providerId = providerId;
        }
        if (user.email && (!userDocSnap.exists() || !data.email)) {
            payload.email = user.email;
        }

        try {
            await setDoc(userDocRef, payload, { merge: true });
            console.log(
                staleCreatedAt
                    ? '✅ 가입 완료(동일 UID 재가입 — 가입일 Auth 기준으로 갱신):'
                    : '✅ 가입 완료(프로필 설정 후) 사용자 등록:',
                user.uid
            );
        } catch (writeErr) {
            const wcode = writeErr?.code || '';
            if (wcode === 'permission-denied' && callableFunctions?.patchArtifactUserRoot) {
                await callableFunctions.patchArtifactUserRoot({
                    setCreatedAt: true,
                    createdAtMillis: getAuthAccountCreatedMillis(user),
                    providerId: providerId || null,
                    email: user.email || null
                });
                console.log('✅ 가입일 서버 폴백 저장:', user.uid);
            } else {
                throw writeErr;
            }
        }
    } catch (e) {
        console.warn('ensureUserRegistered 실패:', e);
    }
};

// 인증 상태 변경 리스너 - 단순화된 버전
let lastProcessedUserId = null; // 마지막으로 처리한 사용자 ID
let authCheckShowOptionsTimeout = null; // 로그인 옵션 표시 지연 타이머 (자동 로그인 시 타이틀만 보이도록)

// 로그인 상태 확인 중에는 스피너 표시하지 않음 (스피너는 로그인→메인 전환 시 기록 로드할 때만 표시)

function shouldTryAutoDemoSignIn(wasExplicitLogout, wasDemoUserLogout) {
    // ⚠️ 중요: localStorage를 먼저 확인 (페이지 리로드 후에도 유지)
    // ⚠️ 중요: 동기적으로 즉시 확인 (비동기 작업 전에)
    const localStorageExplicitLogout = localStorage.getItem('explicitLogout') === 'true';
    const localStorageDemoLogout = localStorage.getItem('wasDemoUserLogout') === 'true';
    const sessionStorageExplicitLogout = sessionStorage.getItem('explicitLogout') === 'true';
    const sessionStorageDemoLogout = sessionStorage.getItem('wasDemoUserLogout') === 'true';
    
    // ⚠️ 중요: 모든 저장소에서 플래그 확인 (하나라도 true이면 차단)
    const hasExplicitLogout = wasExplicitLogout || localStorageExplicitLogout || sessionStorageExplicitLogout;
    const hasDemoLogout = wasDemoUserLogout || localStorageDemoLogout || sessionStorageDemoLogout;

    // 명시적 로그아웃이면 절대 자동 로그인하지 않음
    if (hasExplicitLogout) {
        console.log('🚫 자동 데모 로그인 스킵: 명시적 로그아웃', {
            wasExplicitLogout,
            localStorageExplicitLogout,
            sessionStorageExplicitLogout,
            hasExplicitLogout
        });
        return false;
    }
    // 더미 계정에서 명시적으로 로그아웃한 경우 자동 로그인하지 않음
    if (hasDemoLogout) {
        console.log('🚫 자동 데모 로그인 스킵: 더미 계정 로그아웃', {
            wasDemoUserLogout,
            localStorageDemoLogout,
            sessionStorageDemoLogout,
            hasDemoLogout
        });
        return false;
    }
    // 추가 안전장치
    try {
        if (localStorage.getItem('mealog_seen_real_login') === '1') {
            console.log('🚫 자동 데모 로그인 스킵: 실제 로그인 경험 있음');
            return false;
        }
        if (localStorage.getItem('mealog_auto_demo_off') === '1') {
            console.log('🚫 자동 데모 로그인 스킵: 자동 데모 비활성화');
            return false;
        }
    } catch (_) {}
    console.log('✅ 자동 데모 로그인 시도');
    return true;
}

initAuth(async (user) => {
    // ⚠️ 중요: onAuthStateChanged가 호출되는 즉시 플래그를 확인해야 함 (자동 로그인 전에)
    // 로그아웃 시 로그인 옵션 즉시 표시 여부 (명시적 로그아웃이면 true). 아래에서 제거하므로 먼저 저장
    // ⚠️ localStorage를 먼저 확인 (페이지 리로드 후에도 유지되도록)
    // ⚠️ 중요: localStorage.getItem은 동기적으로 실행되므로 즉시 확인 가능
    const localStorageExplicit = localStorage.getItem('explicitLogout');
    const localStorageDemo = localStorage.getItem('wasDemoUserLogout');
    const sessionStorageExplicit = sessionStorage.getItem('explicitLogout');
    const sessionStorageDemo = sessionStorage.getItem('wasDemoUserLogout');
    
    const wasExplicitLogout = localStorageExplicit === 'true' || sessionStorageExplicit === 'true';
    // 로그아웃 전에 더미 계정이었는지 확인 (로그아웃 후에는 window.currentUser가 사라지므로)
    const wasDemoUserLogout = localStorageDemo === 'true' || sessionStorageDemo === 'true';
    
    console.log('🔐 onAuthStateChanged 호출:', {
        user: user ? { uid: user.uid, email: user.email } : null,
        wasExplicitLogout,
        wasDemoUserLogout,
        sessionStorageExplicit,
        sessionStorageDemo,
        localStorageExplicit,
        localStorageDemo
    });
    
    // ⚠️ 중요: 플래그가 설정되어 있으면 즉시 자동 로그인을 막아야 함
    // ⚠️ 중요: 이 체크는 모든 다른 로직보다 먼저 실행되어야 함
    if (wasDemoUserLogout) {
        console.log('🔐 더미 계정 로그아웃 감지 (wasDemoUserLogout:', wasDemoUserLogout, ') - 자동 로그인 차단');
    }
    if (wasExplicitLogout) {
        console.log('🔐 명시적 로그아웃 감지 (wasExplicitLogout:', wasExplicitLogout, ') - 자동 로그인 차단');
    }
    
    // ⚠️ 중요: user가 null이고 플래그가 설정되어 있으면, 자동 로그인을 막기 위해 early return
    // 하지만 이건 나중에 shouldTryAutoDemoSignIn에서 처리하므로 여기서는 early return하지 않음
    
    // 1. 관리자 페이지가 열려있는지 확인 (현재 탭이 관리자 페이지인 경우)
    if (window.location.pathname.includes('admin.html') || window.location.href.includes('admin.html')) {
        console.log('⚠️ 관리자 페이지에서 인증 상태 변경 무시');
        return;
    }
    
    // 1.5. 프로필 설정에서 "게스트로 둘러보기" 선택 시: user=null이면 아무것도 하지 않고 익명 로그인 콜백 대기
    if (!user && sessionStorage.getItem('guestFromProfileSetup') === 'true') {
        return;
    }
    
    // 2. 갑작스러운 게스트 전환 방지: 이전에 로그인된 사용자가 있었는데 갑자기 게스트로 전환되는 경우
    // 단, 프로필 설정에서 "게스트로 둘러보기"를 선택한 경우는 허용 (메인 화면으로 이동)
    // 더미 계정의 경우 명시적 로그아웃 시 항상 처리되어야 함
    const isGuestFromProfileSetup = sessionStorage.getItem('guestFromProfileSetup') === 'true';
    // 명시적 로그아웃(데모 안내에서「가입으로」등)은 여기서 막지 않음 — null + 이전 실계정으로 오인하면 랜딩이 안 뜸
    if (!wasExplicitLogout && !isGuestFromProfileSetup && !wasDemoUserLogout && (!user || user.isAnonymous) && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous) {
        // 실제 auth.currentUser를 확인하여 관리자 페이지 영향인지 확인
        const actualCurrentUser = auth.currentUser;
        
        // 실제 인증 상태가 게스트이거나 null이고, 이전에 로그인된 사용자가 있었으면
        // 관리자 페이지 영향일 가능성이 높지만, Firestore 규칙이 작동하려면 실제 인증 상태가 필요함
        // 따라서 이 경우는 무시하지 않고, 실제 인증 상태를 확인하여 처리
        if ((!actualCurrentUser || actualCurrentUser.isAnonymous) && actualCurrentUser?.uid !== lastProcessedUserId) {
            console.log('⚠️ 로그인된 사용자가 게스트로 전환 감지 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email,
                currentUser: user?.uid || 'null',
                actualAuthUser: actualCurrentUser?.uid || 'null'
            });
            // 실제 인증 상태가 게스트이면 Firestore 규칙이 작동하지 않으므로
            // 이전 사용자 정보를 유지하되, 실제 인증 상태가 복원될 때까지 대기
            // 하지만 이 경우는 실제로 인증 상태가 변경되었으므로, 무시하지 않고 처리해야 함
            // 대신 이전 사용자 정보를 유지하고, 실제 인증 상태가 복원되면 다시 처리
            return;
        }
    }
    
    // 3. 로그아웃 시에도 이전 사용자가 있었으면 무시 (관리자 페이지 영향 가능)
    // 단, 명시적 로그아웃(또는 게스트로 둘러보기)인 경우는 허용
    // 더미 계정의 경우 명시적 로그아웃 시 항상 처리되어야 함
    const isExplicitLogout = sessionStorage.getItem('explicitLogout') === 'true';
    if (!user && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous && !isExplicitLogout && !isGuestFromProfileSetup && !wasDemoUserLogout) {
        // 실제 auth.currentUser를 확인
        const actualCurrentUser = auth.currentUser;
        
        // 실제 인증 상태가 null이고, 이전에 로그인된 사용자가 있었으면 무시
        if (!actualCurrentUser || actualCurrentUser.isAnonymous) {
            console.log('⚠️ 로그인된 사용자가 로그아웃 시도 - 무시 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email,
                actualAuthUser: actualCurrentUser?.uid || 'null'
            });
            // 현재 사용자 상태 유지 - 인증 상태 변경 무시
            return;
        }
    }
    
    // 명시적 로그아웃 플래그는 나중에 제거 (shouldTryAutoDemoSignIn에서 사용)
    // 더미 계정 로그아웃 플래그도 나중에 제거 (shouldTryAutoDemoSignIn에서 사용)
    
    if (user) {
        // 자동 로그인으로 전환될 때 로그인 옵션 표시 타이머 취소 (타이틀만 보다가 메인으로 이동)
        if (authCheckShowOptionsTimeout) {
            clearTimeout(authCheckShowOptionsTimeout);
            authCheckShowOptionsTimeout = null;
        }
        // 사용자 변경 감지: 다른 사용자로 로그인한 경우 이전 리스너 완전히 해제
        if (lastProcessedUserId && lastProcessedUserId !== user.uid) {
            console.log('⚠️ 사용자 변경 감지:', { 
                previousUserId: lastProcessedUserId, 
                newUserId: user.uid,
                previousEmail: window.currentUser?.email,
                newEmail: user.email
            });
            
            // 모든 리스너 해제
            if (appState.settingsUnsubscribe) {
                appState.settingsUnsubscribe();
                appState.settingsUnsubscribe = null;
            }
            if (appState.dataUnsubscribe) {
                appState.dataUnsubscribe();
                appState.dataUnsubscribe = null;
            }
            if (appState.statsUnsubscribe) {
                appState.statsUnsubscribe();
                appState.statsUnsubscribe = null;
            }
            
            // 전역 상태 초기화
            window.userSettings = null;
            window.mealHistory = null;
            window.dailyStats = null;
            window.sharedPhotos = null;
            window.sharedPhotosFeed = [];
            window._duplicateCleanupDone = false;
            authFlowManager.hasCompleted = false;
            authFlowManager.lastProcessedUserId = null;
            
            console.log('✅ 이전 사용자 리스너 및 상태 초기화 완료');
        }
        
        window.currentUser = user;
        lastProcessedUserId = user.uid;
        syncDemoNavGuideDots();
        refreshNavFeedUpdateDots();

        if (!user.isAnonymous && !isDemoUser(user)) {
            markUserHasRealLogin();
        }

        if (user && !user.isAnonymous && !isDemoUser(user)) {
          // FCM 토큰 저장 실패는 콘솔·푸시 디버그로 충분 — 별도 토스트 생략
          // 네이티브 앱만: FCM 등록·토큰 Firestore 저장 (설정 토글 제거 이후 이 경로가 유일함)
          if (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform?.()) {
            const puid = user.uid;
            if (window.__pushInitInFlight) {
              /* 동시 중복 호출 생략 */
            } else if (window.__pushInitUid !== puid) {
              window.__pushInitInFlight = true;
              const pushInitSafety = setTimeout(() => {
                window.__pushInitInFlight = false;
                console.warn('푸시: 초기화 안전 타임아웃(18s) — 구버전 JS 캐시 가능. 앱 재설치 또는 main.js?v 갱신 확인');
              }, 18000);
              void initPushNotifications(puid)
                .then((ok) => {
                  if (ok) window.__pushInitUid = puid;
                })
                .finally(() => {
                  clearTimeout(pushInitSafety);
                  window.__pushInitInFlight = false;
                });
            } else {
              void syncPushRegistrationFromOs();
            }
          }
        } else if (user) {
          try {
            delete window.__onPushTokenSavedError;
          } catch (_) {}
        }
        
        console.log('🔐 인증 상태 변경:', {
            uid: user.uid,
            email: user.email,
            providerId: user.providerData?.[0]?.providerId,
            isAnonymous: user.isAnonymous
        });
        
        // 사용자 문서 업데이트 (가입일, 마지막 로그인 날짜)
        // 로그인 플로우를 지연시키지 않기 위해 비동기로 나중에 실행
        updateUserDocument(user).catch(e => {
            console.warn('사용자 문서 업데이트 실패 (무시):', e);
        });
        
        // 이미 메인 화면이 표시되어 있으면 보통은 추가 처리 없이 리턴.
        // 단, 게스트 → 이메일/구글 로그인처럼 "메인 화면 위에서" 인증이 바뀌는 경우,
        // 약관/프로필 플로우 및 리스너 설정이 반드시 필요하므로 여기서 종료하면 안 됨.
        const mainApp = document.getElementById('mainApp');
        const landingPage = document.getElementById('landingPage');
        if (mainApp && !mainApp.classList.contains('hidden') && landingPage && landingPage.style.display === 'none') {
            const sameUser = lastProcessedUserId === user.uid;
            const readyToSkip =
                sameUser &&
                !user.isAnonymous &&
                !!window.userSettings &&
                authFlowManager.hasCompleted;
            if (readyToSkip) {
                return;
            }
        }
        
                // 중요: providerId와 email은 처음 로그인 시 약관 동의 또는 프로필 설정 시에만 설정됩니다.
                // 로그인 직후 자동 저장은 하지 않습니다. (중복 저장 방지)
        
        // 중복 기록 자동 정리 (한 번만 실행)
        if (!window._duplicateCleanupDone && window.mealHistory && window.mealHistory.length > 0) {
            window._duplicateCleanupDone = true;
            setTimeout(async () => {
                await dbOps.removeDuplicateMeals();
            }, 2000);
        }
        
        // ✅ 게스트(익명) 모드: meals/settings/stats 리스너 없음(기록·설정 제한).
        // 모먼트 피드는 탭 진입 시 loadSharedPhotosPage, 타임라인 공유 표시는 loadMyShares 등 getDocs로 로드.
        if (user.isAnonymous) {
            registerFirestoreListenersRebind(null);
            if (appState.settingsUnsubscribe) {
                appState.settingsUnsubscribe();
                appState.settingsUnsubscribe = null;
            }
            if (appState.dataUnsubscribe) {
                appState.dataUnsubscribe();
                appState.dataUnsubscribe = null;
            }
            if (appState.statsUnsubscribe) {
                appState.statsUnsubscribe();
                appState.statsUnsubscribe = null;
            }

            window.sharedPhotos = [];
            window.sharedPhotosFeed = [];
            stopNotificationListeners();

            // 게스트 모드일 때 헤더 UI 업데이트
            updateHeaderUI();
            // 둘러보기(게스트) 방문 기록 — 관리자 대시보드 통계용
            recordGuestVisit(user.uid).catch(() => {});
        } else {
            // 리스너 설정 (이전 리스너는 setupListeners 내부에서 해제됨)
            let dataUpdateTimer = null; // 공유 시 meals 이중 리스너 방지용 디바운스
            const attachMealDataListeners = () => {
                const cur = auth.currentUser;
                if (!cur || cur.isAnonymous) return;
                stopNotificationListeners();
                const { settingsUnsubscribe, dataUnsubscribe, statsUnsubscribe } = setupListeners(cur.uid, {
                onSettingsUpdate: () => {
                    // 헤더 UI 업데이트 (디바운싱됨)
                    updateHeaderUI();
                    if (typeof syncPushPreferencesFormFromUserSettings === 'function') {
                        syncPushPreferencesFormFromUserSettings();
                    }
                    const entryModal = document.getElementById('entryModal');
                    if (!entryModal || entryModal.classList.contains('hidden')) {
                        renderEntryChips();
                    }
                    
                    // 설정이 완전히 로드된 후 인증 플로우 실행
                    // 단, 이미 완료되었거나 처리 중인 경우는 건너뛰기
                    if (!authFlowManager.hasCompleted && !authFlowManager.isProcessing && window.userSettings) {
                        console.log('✅ 설정 업데이트 완료. 인증 플로우 실행...');
                        const u = auth.currentUser;
                        if (u) {
                            authFlowManager.handleAuthState(u).catch(e => {
                                console.error('❌ 인증 플로우 처리 실패:', e);
                                hideLoading();
                            });
                        }
                    }
                    // 약관 모달은 auth-flow.js에서만 관리하므로 여기서는 닫지 않음
                    // onSettingsUpdate에서 약관 모달을 닫으면 타이밍 이슈로 인해 모달이 잠깐 표시되었다가 사라질 수 있음
                },
                onDataUpdate: () => {
                    scheduleAttendanceCheckIfNeeded();
                    const tab = appState.currentTab;
                    if (tab === 'dashboard') {
                        updateDashboard();
                        if (window._recordsLoadHidePending && window.loadedMealsDateRange) {
                            window._recordsLoadHidePending = false;
                            hideLoading();
                        }
                        return;
                    }
                    // 타임라인 탭이 보일 때만 재렌더. 다른 탭(앨범/분석/피드)에서는 스킵해 프리즈·고CPU 방지.
                    if (tab !== 'timeline') return;
                    // 밀로그 메인 화면에서 기록(meals) 첫 수신 시에만 로딩 오버레이 숨김 (loadedMealsDateRange는 meals 리스너에서만 설정됨)
                    if (window._recordsLoadHidePending && window.loadedMealsDateRange) {
                        window._recordsLoadHidePending = false;
                        hideLoading();
                    }
                    // 저장 직후 800ms 동안은 재렌더 스킵 (낙관 반영 + jumpToDate·스크롤이 리스너 재렌더에 덮이지 않게)
                    if (window._timelineRerenderFreezeUntil && Date.now() < window._timelineRerenderFreezeUntil) return;
                    if (dataUpdateTimer) clearTimeout(dataUpdateTimer);
                    dataUpdateTimer = setTimeout(() => {
                        dataUpdateTimer = null;
                        if (appState.currentTab !== 'timeline') return; // 대기 중 탭 바뀌면 스킵
                        // 리스트 모드에서도 pageDate는 jumpToDate·미니캘 선택값을 유지 (매 동기화마다 오늘로 덮으면
                        // 다른 날짜를 보는 중에 헤더/스크롤이 엇나감)
                        // 데이터 동기화(낙관→서버) 시 전체 재렌더해도, 이미 타임라인 초기 스크롤을 마친 뒤면
                        // hasScrolledToToday를 리셋하지 않고 스크롤 Y만 복원 → 오늘로 재스크롤·화면 흔들림 방지
                        const preserveTimelineScroll = window.hasScrolledToToday === true;
                        const savedScrollY = window.scrollY;
                        window.loadedDates = [];
                        if (!preserveTimelineScroll) {
                            window.hasScrolledToToday = false;
                        }
                        const container = document.getElementById('timelineContainer');
                        if (container) container.innerHTML = "";
                        renderTimeline();
                        renderMiniCalendar();
                        if (preserveTimelineScroll) {
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    let anchored = false;
                                    const pd = appState.pageDate;
                                    if (pd instanceof Date && !isNaN(+pd)) {
                                        const y = pd.getFullYear();
                                        const mo = String(pd.getMonth() + 1).padStart(2, '0');
                                        const d = String(pd.getDate()).padStart(2, '0');
                                        const iso = `${y}-${mo}-${d}`;
                                        const el = document.getElementById(`date-${iso}`);
                                        if (el) {
                                            const trackerSection = document.getElementById('trackerSection');
                                            const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                                            const headerHeight = 73;
                                            const totalOffset = headerHeight + trackerHeight;
                                            const elementTop = el.getBoundingClientRect().top + window.pageYOffset;
                                            const offsetPosition = elementTop - totalOffset - 16;
                                            window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'instant' });
                                            anchored = true;
                                        }
                                    }
                                    if (!anchored) {
                                        window.scrollTo({ top: savedScrollY, behavior: 'instant' });
                                    }
                                });
                            });
                        }
                    }, 120);
                },
                settingsUnsubscribe: appState.settingsUnsubscribe,
                dataUnsubscribe: appState.dataUnsubscribe
            });
            appState.settingsUnsubscribe = settingsUnsubscribe;
            appState.dataUnsubscribe = dataUnsubscribe;
            appState.statsUnsubscribe = statsUnsubscribe;
            if (document.visibilityState === 'visible') startNotificationListeners();

            setTimeout(() => {
                retryPendingMealEntriesOnAppReady().catch(() => {});
            }, 4000);
            };
            attachMealDataListeners();
            registerFirestoreListenersRebind(attachMealDataListeners);

            // 공유 피드: sharedPhotos 실시간 리스너 없음 — loadSharedPhotosPage / loadMyShares로 필요 시 로드
            window.sharedPhotos = [];
            window.sharedPhotosFeed = [];
            appState.sharedPhotosFeedLastDoc = null;
            appState.sharedPhotosFeedHasMore = false;
            appState.sharedPhotosFeedPrefetchedAt = 0;
        }
        
        // 초기 로드 시 오늘 날짜로 설정
        if (appState.viewMode === 'list') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            appState.pageDate = today;
        }
        
        // Phase 1-1: 인증 플로우를 한 곳에서만 호출 (단일 진입점)
        // 게스트는 즉시 처리, 일반 사용자는 onSettingsUpdate에서 처리
        if (user.isAnonymous) {
            sessionStorage.removeItem('guestFromProfileSetup');
            // 게스트는 설정 없이 즉시 처리
            authFlowManager.handleAuthState(user).catch(e => {
                console.error('❌ 게스트 인증 플로우 처리 실패:', e);
                hideLoading();
            });
        } else {
            // 일반 사용자: onSettingsUpdate에서 설정 로드 완료 후 인증 플로우 실행
            // 설정이 이미 로드되어 있으면 즉시 실행, 아니면 onSettingsUpdate에서 처리
            if (window.userSettings && !authFlowManager.hasCompleted) {
                console.log('✅ 설정이 이미 로드됨. 인증 플로우 시작...');
                authFlowManager.handleAuthState(user).catch(e => {
                    console.error('❌ 인증 플로우 처리 실패:', e);
                    hideLoading();
                });
            }
            // 설정 대기 중에는 스피너 표시하지 않음 (스피너는 메인 전환 후 기록 로드할 때만 표시)
            // 설정이 없으면 onSettingsUpdate 콜백에서 처리됨
        }
    } else {
        // 로그아웃 상태
        // 추가 안전장치: 이전에 로그인된 사용자가 있었는데 갑자기 로그아웃되는 경우 무시
        // 단, 명시적 로그아웃(게스트→로그인 이동 포함)은 반드시 처리해야 함
        // 더미 계정의 경우 명시적 로그아웃 시 항상 처리되어야 함
        // wasExplicitLogout: 콜백 상단에서 캡처한 값 (2771행에서 explicitLogout 키를 지우기 전에 읽힘)
        if (!wasExplicitLogout && !wasDemoUserLogout && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous) {
            console.log('⚠️ 로그아웃 처리 중 이전 사용자 감지 - 무시 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email
            });
            return;
        }

        const presentLoginLanding = () => {
        const mainApp = document.getElementById('mainApp');
        const landingPage = document.getElementById('landingPage');
        // 이미 랜딩 화면이면 화면 전환만 스킵 (위에서 상태는 이미 초기화됨)
        if (landingPage && landingPage.style.display === 'flex' && mainApp && mainApp.classList.contains('hidden')) {
            hideLoading();
            return;
        }
        
        // 로그인 배너 설정 로드 후 표시 (설정 없음 → 영역 숨김, 사용 켜고 이미지 없음 → 흰색 영역, 이미지 있음 → 이미지 표시)
        // 표시 환경: 프로덕션만/스테이징만 선택 시 해당 환경에서만 표시. 스테이징 = 로컬(localhost 등) 포함
        async function loadAndShowLoginBanner() {
            const section = document.getElementById('loginBannerSection');
            const imgEl = document.getElementById('loginBannerImage');
            const landingPage = document.getElementById('landingPage');
            if (!section) return;
            try {
                const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
                const data = bannerDoc.exists() ? bannerDoc.data() : null;
                if (!data || !data.enabled) {
                    section.classList.add('hidden');
                    if (landingPage) landingPage.classList.remove('landing-banner-visible');
                    return;
                }
                const currentEnv = getMealogClientEnv();
                const targetEnv = data.targetEnv || 'all';
                if (targetEnv !== 'all' && targetEnv !== currentEnv) {
                    section.classList.add('hidden');
                    if (landingPage) landingPage.classList.remove('landing-banner-visible');
                    return;
                }
                section.classList.remove('hidden');
                if (landingPage) landingPage.classList.add('landing-banner-visible');
                section.classList.add('bg-white');
                if (imgEl) {
                    imgEl.classList.add('hidden');
                    imgEl.removeAttribute('src');
                }
                if (data.imageUrl && typeof data.imageUrl === 'string' && data.imageUrl.trim()) {
                    section.classList.remove('bg-white');
                    if (imgEl) {
                        imgEl.setAttribute('src', data.imageUrl.trim());
                        imgEl.setAttribute('alt', '');
                        imgEl.classList.remove('hidden');
                    }
                }
                recordBannerView();
                const landingNoticeId = (data.landingNoticeId && typeof data.landingNoticeId === 'string') ? data.landingNoticeId.trim() : '';
                section.removeAttribute('role');
                section.style.cursor = '';
                section.onclick = null;
                if (landingNoticeId) {
                    section.setAttribute('role', 'button');
                    section.style.cursor = 'pointer';
                    section.onclick = () => {
                        recordBannerClick();
                        try {
                            sessionStorage.setItem('loginBannerLandingNoticeId', landingNoticeId);
                        } catch (_) {}
                        if (typeof window.startGuest === 'function') window.startGuest();
                    };
                }
            } catch (e) {
                console.warn('로그인 배너 설정 로드 실패:', e);
                section.classList.add('hidden');
                const landingPage = document.getElementById('landingPage');
                if (landingPage) landingPage.classList.remove('landing-banner-visible');
            }
        }

        // 로그인 필요 시: 아이콘 페이드아웃 → 타이틀 표시 → 타이틀 중앙에서 위로 올라감 → 올라가는 애니메이션 완료 후 버튼 페이드인
        const showLoginScreen = () => {
            const landingPage = document.getElementById('landingPage');
            const landingLoginOptions = document.getElementById('landingLoginOptions');
            const apkSection = document.getElementById('apkDownloadSection');
            if (landingPage) landingPage.classList.add('landing-show-login');
            // 아이콘↔타이틀 페이드 이후 타이틀 위로 올라가는 애니메이션 시작
            setTimeout(() => {
                if (!landingPage) return;
                landingPage.classList.add('landing-buttons-visible');
                const titleEl = document.getElementById('landingSplashTitleAndTagline');
                let buttonsShown = false;
                const showButtons = () => {
                    if (buttonsShown) return;
                    buttonsShown = true;
                    if (landingLoginOptions) {
                        landingLoginOptions.classList.remove('hidden');
                        requestAnimationFrame(() => {
                            landingLoginOptions.classList.add('landing-options-visible');
                        });
                    }
                    if (apkSection) apkSection.classList.remove('hidden');
                    loadAndShowLoginBanner();
                };
                // transitionend로 애니메이션 완료 후에만 버튼 표시 (점프 방지)
                if (titleEl) {
                    const onEnd = (e) => {
                        if (e.propertyName === 'transform') {
                            titleEl.removeEventListener('transitionend', onEnd);
                            requestAnimationFrame(() => requestAnimationFrame(showButtons)); // 2프레임 대기 후 표시
                        }
                    };
                    titleEl.addEventListener('transitionend', onEnd);
                    setTimeout(showButtons, 950); // 폴백: 0.8s + 여유
                } else {
                    setTimeout(showButtons, 800);
                }
            }, 520);
        };
        const showOptionsNow = wasExplicitLogout;
        if (showOptionsNow) {
            showLoginScreen();
        } else {
            authCheckShowOptionsTimeout = setTimeout(() => {
                if (auth.currentUser === null) showLoginScreen();
                authCheckShowOptionsTimeout = null;
            }, 400);
        }
        
        switchScreen(false);
        if (appState.settingsUnsubscribe) {
            appState.settingsUnsubscribe();
            appState.settingsUnsubscribe = null;
        }
        if (appState.dataUnsubscribe) {
            appState.dataUnsubscribe();
            appState.dataUnsubscribe = null;
        }
        if (appState.statsUnsubscribe) {
            appState.statsUnsubscribe();
            appState.statsUnsubscribe = null;
        }
        // ⚠️ 중요: 알림 리스너도 해제 (로그아웃 시 permission-denied 에러 방지)
        stopNotificationListeners();
        registerFirestoreListenersRebind(null);
        hideLoading();
        };

        lastProcessedUserId = null;
        authFlowManager.hasCompleted = false;
        authFlowManager.lastProcessedUserId = null;
        window.userSettings = null;
        window.currentUser = null;
        window.__pushInitUid = null;
        window.__pushInitInFlight = false;
        try {
          delete window.__onPushTokenSavedError;
        } catch (_) {}
        syncDemoNavGuideDots();
        clearNavFeedUpdateDots();

        // ⚠️ 중요: 플래그를 다시 한 번 확인 (onAuthStateChanged 호출 시점과 시간차가 있을 수 있음)
        // ⚠️ 중요: localStorage를 먼저 확인 (페이지 리로드 후에도 유지)
        // ⚠️ 중요: 동기적으로 즉시 확인 (비동기 작업 전에)
        const currentExplicitLogout = localStorage.getItem('explicitLogout') === 'true' || sessionStorage.getItem('explicitLogout') === 'true';
        const currentDemoLogout = localStorage.getItem('wasDemoUserLogout') === 'true' || sessionStorage.getItem('wasDemoUserLogout') === 'true';
        const finalWasExplicitLogout = wasExplicitLogout || currentExplicitLogout;
        const finalWasDemoUserLogout = wasDemoUserLogout || currentDemoLogout;
        
        // ⚠️ 중요: 플래그가 설정되어 있으면 즉시 자동 로그인을 막아야 함
        if (finalWasExplicitLogout || finalWasDemoUserLogout) {
            console.log('🚫 플래그 감지 - 자동 로그인 차단:', {
                finalWasExplicitLogout,
                finalWasDemoUserLogout,
                localStorageExplicit: localStorage.getItem('explicitLogout'),
                localStorageDemo: localStorage.getItem('wasDemoUserLogout'),
                sessionStorageExplicit: sessionStorage.getItem('explicitLogout'),
                sessionStorageDemo: sessionStorage.getItem('wasDemoUserLogout')
            });
        }
        
        const shouldAutoDemo = shouldTryAutoDemoSignIn(finalWasExplicitLogout, finalWasDemoUserLogout);
        console.log('🔐 자동 데모 로그인 판단:', {
            shouldAutoDemo,
            wasExplicitLogout: finalWasExplicitLogout,
            wasDemoUserLogout: finalWasDemoUserLogout,
            originalWasExplicitLogout: wasExplicitLogout,
            originalWasDemoUserLogout: wasDemoUserLogout,
            currentExplicitLogout,
            currentDemoLogout,
            sessionStorageExplicit: sessionStorage.getItem('explicitLogout'),
            sessionStorageDemo: sessionStorage.getItem('wasDemoUserLogout'),
            localStorageExplicit: localStorage.getItem('explicitLogout'),
            localStorageDemo: localStorage.getItem('wasDemoUserLogout')
        });
        
        if (shouldAutoDemo) {
            console.log('✅ 자동 데모 로그인 시작');
            if (appState.settingsUnsubscribe) {
                appState.settingsUnsubscribe();
                appState.settingsUnsubscribe = null;
            }
            if (appState.dataUnsubscribe) {
                appState.dataUnsubscribe();
                appState.dataUnsubscribe = null;
            }
            if (appState.statsUnsubscribe) {
                appState.statsUnsubscribe();
                appState.statsUnsubscribe = null;
            }
            showLoading('샘플 타임라인을 불러오는 중...', { dimBackground: false, skipOnLoginScreen: false });
            void import('./demo-account.js').then(async (mod) => {
                if (!(await mod.isDemoCredentialsConfigured())) {
                    hideLoading();
                    presentLoginLanding();
                    return;
                }
                try {
                    await mod.signInAsDemoAccount();
                } catch (e) {
                    console.warn('데모 자동 로그인 실패:', e?.message || e);
                    hideLoading();
                    presentLoginLanding();
                }
            });
            return;
        }

        console.log('🚫 자동 데모 로그인 스킵, 로그인 화면 표시');
        presentLoginLanding();
        
        // 명시적 로그아웃 플래그 초기화 (사용 후 제거)
        // ⚠️ 중요: 이미 계산된 finalWasExplicitLogout과 finalWasDemoUserLogout 변수 재사용
        if (finalWasExplicitLogout) {
            sessionStorage.removeItem('explicitLogout');
            localStorage.removeItem('explicitLogout');
            console.log('🔐 explicitLogout 플래그 제거 완료');
        }
        // 더미 계정 로그아웃 플래그 초기화 (사용 후 제거)
        if (finalWasDemoUserLogout) {
            sessionStorage.removeItem('wasDemoUserLogout');
            localStorage.removeItem('wasDemoUserLogout');
            console.log('🔐 wasDemoUserLogout 플래그 제거 완료');
        }
    }
});

// 로그인 배너에서 공지로 랜딩: 배너 클릭 시 저장된 공지 ID가 있으면 메인 화면 진입 후 밀톡 탭으로 전환하고 해당 공지 열기
function applyLoginBannerLandingNotice() {
    try {
        const noticeId = sessionStorage.getItem('loginBannerLandingNoticeId');
        if (!noticeId || typeof window.openNoticeDetail !== 'function') return;
        sessionStorage.removeItem('loginBannerLandingNoticeId');
        if (typeof window.switchMainTab === 'function') {
            window.switchMainTab('board');
        }
        setTimeout(() => {
            if (typeof window.openNoticeDetail === 'function') window.openNoticeDetail(noticeId);
        }, 500);
    } catch (_) {}
}
window.addEventListener('mealog:mainScreenShown', applyLoginBannerLandingNotice);
window.addEventListener('mealog:mainScreenShown', () => scheduleAttendanceCheckIfNeeded());
window.__onMainScreenShown = applyLoginBannerLandingNotice;
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleAttendanceCheckIfNeeded();
});

// 스크롤 방향에 따른 헤더·하단 네비 숨김·표시 (트위터/인스타 스타일)
// 아래로 스크롤 시 헤더·하단 네비 숨김, 위로 스크롤 시 다시 표시
let _lastScrollY = 0;
let _headerScrollRaf = null;
window.addEventListener('scroll', () => {
    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) return;
    const header = document.getElementById('mainAppHeader');
    const tracker = document.getElementById('trackerSection');
    if (!header || !tracker) return;
    const y = window.scrollY;
    if (_headerScrollRaf) cancelAnimationFrame(_headerScrollRaf);
    _headerScrollRaf = requestAnimationFrame(() => {
        const delta = y - _lastScrollY;
        const scrollThreshold = 8;
        const topThreshold = 24;
        const isScrollingDown = delta > scrollThreshold;
        const isScrollingUp = delta < -scrollThreshold;
        const atTop = y <= topThreshold;
        if (isScrollingDown && !atTop) {
            header.classList.add('header-scroll-hidden');
            tracker.classList.add('tracker-header-hidden');
            document.body.classList.add('bottom-nav-scroll-hidden');
        } else if (isScrollingUp || atTop) {
            header.classList.remove('header-scroll-hidden');
            tracker.classList.remove('tracker-header-hidden');
            document.body.classList.remove('bottom-nav-scroll-hidden');
        }
        _lastScrollY = y;
        _headerScrollRaf = null;
    });
}, { passive: true });

/** 밀톡 피드/게시판: 통합 스크롤(#boardLoungeScrollArea) — 동일 네비·헤더 숨김 규칙 적용 */
const _boardPanelScrollLast = { boardLoungeScrollArea: 0 };
let _boardPanelScrollRaf = null;
function applyBoardPanelScrollHideNav(el) {
    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) return;
    const header = document.getElementById('mainAppHeader');
    if (!header) return;
    if (appState.currentTab !== 'board') return;
    const id = el.id;
    if (id !== 'boardLoungeScrollArea') return;

    // 초기 자동 스크롤(맨 아래 정렬 등) 동안에는 네비/헤더 숨김 토글을 막아
    // padding/bottom 클래스 변경 → scrollHeight 변화 → 연쇄 스크롤 흔들림을 방지.
    const suppressUntil = Number(window.__suppressBoardPanelScrollHideNavUntil || 0) || 0;
    if (suppressUntil && Date.now() < suppressUntil) {
        _boardPanelScrollLast[id] = el.scrollTop;
        return;
    }

    const y = el.scrollTop;
    if (_boardPanelScrollRaf) cancelAnimationFrame(_boardPanelScrollRaf);
    _boardPanelScrollRaf = requestAnimationFrame(() => {
        const last = _boardPanelScrollLast[id] ?? 0;
        const delta = y - last;
        const scrollDownThreshold = 10;
        const scrollUpThreshold = 3;
        // 피드 상단·이전 메시지 로드 구역 근처면 헤더·서브탭 복구(24px만 쓰면 위로 조금만 올려도 복구 안 되는 경우가 많음)
        const topShowThreshold = 96;
        const isScrollingDown = delta > scrollDownThreshold;
        const isScrollingUp = delta < -scrollUpThreshold;
        const atNearTop = y <= topShowThreshold;
        const hidden = header.classList.contains('header-scroll-hidden');
        // 숨김 상태에서 아주 조금만 위로 움직여도 복구(임계 8px 대칭이면 한 번에 안 올라가면 영원히 숨김 유지됨)
        const nudgeReveal = hidden && delta < -1;
        const tracker = document.getElementById('trackerSection');
        if (isScrollingDown && !atNearTop) {
            header.classList.add('header-scroll-hidden');
            if (tracker) tracker.classList.add('tracker-header-hidden');
            document.body.classList.add('bottom-nav-scroll-hidden');
        } else if (isScrollingUp || atNearTop || nudgeReveal) {
            header.classList.remove('header-scroll-hidden');
            if (tracker) tracker.classList.remove('tracker-header-hidden');
            document.body.classList.remove('bottom-nav-scroll-hidden');
        }
        _boardPanelScrollLast[id] = y;
        _boardPanelScrollRaf = null;
    });
}
function bindBoardPanelsScrollHideNav() {
    const lounge = document.getElementById('boardLoungeScrollArea');
    const onScroll = (e) => applyBoardPanelScrollHideNav(e.currentTarget);
    if (lounge) lounge.addEventListener('scroll', onScroll, { passive: true });
}
window.__resetBoardPanelScrollNav = () => {
    document.body.classList.remove('bottom-nav-scroll-hidden');
    document.getElementById('mainAppHeader')?.classList.remove('header-scroll-hidden');
    document.getElementById('trackerSection')?.classList.remove('tracker-header-hidden');
    const lounge = document.getElementById('boardLoungeScrollArea');
    if (lounge) _boardPanelScrollLast.boardLoungeScrollArea = lounge.scrollTop;
};
/** prepend 후 programatic scrollTop 직전·직후: delta 폭주로 헤더가 숨겨지지 않게 마지막 스크롤 값만 동기화 */
window.__syncBoardPanelScrollNavLast = () => {
    const lounge = document.getElementById('boardLoungeScrollArea');
    if (lounge) _boardPanelScrollLast.boardLoungeScrollArea = lounge.scrollTop;
};
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindBoardPanelsScrollHideNav, { once: true });
} else {
    bindBoardPanelsScrollHideNav();
}

// 스크롤 이벤트 리스너 (타임라인 하단 근처에서 더 오래된 기록 자동 로드)
let scrollTimeout;
window.addEventListener('scroll', () => { 
    const state = appState;
    if (state.currentTab !== 'timeline' || state.viewMode !== 'list' || !window.currentUser) return;
    if ((window.innerHeight + window.scrollY) < document.body.offsetHeight - 400) return;
    // 디바운싱: 연속 호출 방지
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(async () => {
        if (appState.currentTab !== 'timeline') return;
        const range = window.loadedMealsDateRange;
        if (range) {
            const today = new Date();
            const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
            const pastLoadedCount = (window.loadedDates || []).filter(d => d < todayStr).length;
            const nextOldest = new Date(today);
            nextOldest.setDate(nextOldest.getDate() - (pastLoadedCount + 5));
            const nextOldestStr = `${nextOldest.getFullYear()}-${String(nextOldest.getMonth() + 1).padStart(2, '0')}-${String(nextOldest.getDate()).padStart(2, '0')}`;
            if (nextOldestStr < range.start) {
                try {
                    await loadMoreMeals(1, 'week'); // 스크롤 시 1주일씩 로드
                } catch (e) {
                    console.warn('스크롤 시 추가 로드 실패:', e);
                }
            }
        }
        renderTimeline();
        renderMiniCalendar();
    }, 100);
});

// 키보드 이벤트 리스너 (주간/월간 모드에서 좌우 방향키로 이동)
window.addEventListener('keydown', (e) => {
    // input, textarea, select 등이 포커스되어 있으면 키보드 이벤트 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }
    
    const state = appState;
    
    // 대시보드 탭이 활성화되어 있고 주간/월간 모드일 때만 동작
    if (state.currentTab === 'dashboard') {
        if (state.dashboardMode === 'week') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                changeWeek(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                changeWeek(1);
            }
        } else if (state.dashboardMode === 'month') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                changeMonth(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                changeMonth(1);
            }
        } else if (state.dashboardMode === 'year') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                navigatePeriod(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                navigatePeriod(1);
            }
        }
    }
});

// 터치 제스처 초기화 (일간 스와이프: 좌<->우 전환 방향 고정)
function initDailySwipeGesture() {
    if (window.__dailySwipeGestureInitialized) return;
    const tv = document.getElementById('timelineView');
    if (!tv) return;

    const getTimelineContainer = () => document.getElementById('timelineContainer');
    /** 일간 스와이프는 버튼/입력 위에서 시작하지 않음 — pointermove preventDefault가 클릭을 삼켜 공유·저장이 무반응이 되는 문제 방지 */
    const isInteractiveSwipeTarget = (node) => {
        if (!node || node.nodeType !== 1) return false;
        return !!node.closest(
            'button, a, input, textarea, select, label, [contenteditable="true"], [data-mealog-daily]'
        );
    };
    const SWIPE_TRIGGER_PX = 28;
    const AXIS_LOCK_PX = 10;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let tracking = false;
    let currentDragX = 0;
    let horizontalLocked = null; // null: 미결정, true: 가로, false: 세로
    let isAnimating = false;

    const resetTransform = () => {
        const tc = getTimelineContainer();
        if (!tc) return;
        tc.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
        tc.style.transform = 'translate3d(0, 0, 0)';
        tc.style.willChange = '';
    };

    const animateToDate = async (dayDelta, releaseX = 0) => {
        if (isAnimating) return;
        const tc = getTimelineContainer();
        if (!tc) return;

        isAnimating = true;
        const viewportWidth = tv.clientWidth || window.innerWidth || 360;
        // 카드 사이 공백을 줄이기 위해 기본 전환 거리를 더 짧게 유지한다.
        const slideDistance = Math.max(72, Math.round(viewportWidth * 0.24));
        // 손을 뗀 위치에서 같은 방향으로 자연스럽게 이어서 밀려나가도록 거리 계산
        const releaseDistance = Math.abs(releaseX);
        const minCarry = Math.max(12, Math.round(viewportWidth * 0.04));
        const maxOutgoingDistance = Math.max(slideDistance, Math.round(viewportWidth * 0.5));
        const outgoingDistance = Math.min(maxOutgoingDistance, Math.max(slideDistance, releaseDistance + minCarry));
        const outgoingX = dayDelta > 0 ? -outgoingDistance : outgoingDistance;
        const incomingStartX = dayDelta > 0 ? slideDistance : -slideDistance;

        const targetDate = new Date(appState.pageDate);
        targetDate.setDate(targetDate.getDate() + dayDelta);
        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        const targetIso = `${year}-${month}-${day}`;

        tc.style.willChange = 'transform';
        tc.style.transition = 'transform 150ms cubic-bezier(0.22, 0.61, 0.36, 1)';
        tc.style.transform = `translate3d(${outgoingX}px, 0, 0)`;

        const onSlideOutEnd = async (ev) => {
            if (ev.target !== tc || (ev.propertyName && ev.propertyName !== 'transform')) return;
            tc.removeEventListener('transitionend', onSlideOutEnd);

            try {
                await window.jumpToDate(targetIso);
            } catch (error) {
                console.warn('스와이프 날짜 이동 실패:', error);
            }

            requestAnimationFrame(() => {
                const newTc = getTimelineContainer();
                if (!newTc) {
                    isAnimating = false;
                    return;
                }
                // 새 날짜 콘텐츠를 먼저 반대편에 배치한 뒤 중앙으로 슬라이드 인시켜
                // 좌/우 스와이프별 진입 방향이 확실히 보이도록 한다.
                newTc.style.transition = 'none';
                newTc.style.transform = `translate3d(${incomingStartX}px, 0, 0)`;
                newTc.style.willChange = 'transform';
                requestAnimationFrame(() => {
                    newTc.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
                    newTc.style.transform = 'translate3d(0, 0, 0)';
                });

                const onSlideInEnd = (slideInEv) => {
                    if (slideInEv.target !== newTc || (slideInEv.propertyName && slideInEv.propertyName !== 'transform')) return;
                    newTc.removeEventListener('transitionend', onSlideInEnd);
                    newTc.style.willChange = '';
                    isAnimating = false;
                };
                newTc.addEventListener('transitionend', onSlideInEnd);
            });
        };
        tc.addEventListener('transitionend', onSlideOutEnd);
    };

    const beginSwipe = (clientX, clientY) => {
        if (appState.viewMode !== 'page' || isAnimating) return false;
        startX = clientX;
        startY = clientY;
        lastX = clientX;
        currentDragX = 0;
        tracking = true;
        horizontalLocked = null;
        return true;
    };

    const moveSwipe = (clientX, clientY, shouldPreventDefault = false, rawEvent = null) => {
        if (!tracking || appState.viewMode !== 'page' || isAnimating) return;

        const deltaX = clientX - startX;
        const deltaY = clientY - startY;
        lastX = clientX;

        if (horizontalLocked === null) {
            if (Math.abs(deltaX) < AXIS_LOCK_PX && Math.abs(deltaY) < AXIS_LOCK_PX) return;
            horizontalLocked = Math.abs(deltaX) > Math.abs(deltaY);
            if (!horizontalLocked) {
                tracking = false;
                return;
            }
        }

        if (!horizontalLocked) return;

        const tc = getTimelineContainer();
        if (!tc) return;
        currentDragX = deltaX;
        if (shouldPreventDefault && rawEvent) rawEvent.preventDefault();
        tc.style.willChange = 'transform';
        tc.style.transition = 'none';
        tc.style.transform = `translate3d(${deltaX}px, 0, 0)`;
    };

    const endSwipe = () => {
        if (!tracking || appState.viewMode !== 'page' || isAnimating) return;
        tracking = false;

        const deltaX = currentDragX || (lastX - startX);
        if (horizontalLocked !== true) return;

        if (Math.abs(deltaX) < SWIPE_TRIGGER_PX) {
            resetTransform();
            return;
        }

        // 왼쪽 스와이프(deltaX<0): 다음날(dayDelta=+1)이 오른쪽에서 진입
        // 오른쪽 스와이프(deltaX>0): 전날(dayDelta=-1)이 왼쪽에서 진입
        const dayDelta = deltaX < 0 ? 1 : -1;
        if (dayDelta > 0) {
            const pageDate = new Date(appState.pageDate);
            pageDate.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (pageDate >= today) {
                resetTransform();
                return;
            }
        }
        animateToDate(dayDelta, deltaX);
    };

    const cancelSwipe = () => {
        if (!tracking || isAnimating) return;
        tracking = false;
        resetTransform();
    };

    tv.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        if (isInteractiveSwipeTarget(e.target)) return;
        beginSwipe(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    tv.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        moveSwipe(e.touches[0].clientX, e.touches[0].clientY, true, e);
    }, { passive: false });

    tv.addEventListener('touchend', () => {
        endSwipe();
    }, { passive: true });

    tv.addEventListener('touchcancel', () => {
        cancelSwipe();
    }, { passive: true });

    // 웹(데스크톱) 테스트용: 마우스 드래그로 스와이프 제스처 시뮬레이션
    tv.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (isInteractiveSwipeTarget(e.target)) return;
        if (!beginSwipe(e.clientX, e.clientY)) return;
        tv.setPointerCapture?.(e.pointerId);
    });

    tv.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        moveSwipe(e.clientX, e.clientY, true, e);
    });

    tv.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'mouse') return;
        tv.releasePointerCapture?.(e.pointerId);
        endSwipe();
    });

    tv.addEventListener('pointercancel', (e) => {
        if (e.pointerType !== 'mouse') return;
        tv.releasePointerCapture?.(e.pointerId);
        cancelSwipe();
    });

    window.__dailySwipeGestureInitialized = true;
}

if (document.readyState === 'loading') {
    window.addEventListener('load', initDailySwipeGesture, { once: true });
} else {
    initDailySwipeGesture();
}

// DOM이 준비되면 이벤트 리스너 초기화
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEventListeners);
} else {
    // DOM이 이미 로드된 경우
    initEventListeners();
}

// 모듈 로드 완료 표시
window.moduleLoaded = true;
console.log('✅ main.js 모듈 로드 완료');
console.log('✅ window.renderTimeline 함수 확인:', typeof window.renderTimeline);

// 앱 첫 기동 시 한글 IME 워밍업 (Capacitor 네이티브만): 첫 입력 시 텍스트 미표시 현상 완화
setTimeout(() => {
    warmUpIME();
}, 500);

// 에러 핸들링
window.addEventListener('error', (e) => {
    const em = String(e.message || e.error?.message || '');
    if (em.includes('FIRESTORE') && em.includes('INTERNAL ASSERTION FAILED')) {
        return;
    }
    console.error('JavaScript 에러:', e);
    console.error('에러 파일:', e.filename);
    console.error('에러 메시지:', e.message);
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
});
