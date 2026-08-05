// 메인 애플리케이션 로직
console.log('📦 main.js 모듈 로드 시작');

// 모듈 로드 시작 플래그 설정 (index.html의 체크가 감지할 수 있도록)
window.moduleLoading = true;

import { initLucideIcons } from './icons.js';
import { appState, getState } from './state.js';
import {
    auth,
    db,
    appId,
    refreshAppCheckTokenBeforeFirestore,
    registerFirestoreListenersRebind
} from './firebase.js';
import { signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { dbOps, setupListeners, loadSharedPhotosPage, loadSharedPhotosPageReliable, loadMyShares, loadMoreMeals, loadMealsForDateRange, ensureMealsLoadedAroundDate, needsMealsLoadedAroundDate, postInteractions, subscribeToMyPostComments, boardOperations, feedOperations, noticeOperations, submitReport, getUserReportForPost, withdrawReport } from './db.js';
import { callableFunctions } from './firebase.js';
import { doc, getDoc, setDoc, updateDoc, collection, query, where, limit, orderBy, getDocs, getDocsFromServer } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { initTimelineSearchModal, openTimelineSearchModal, clearTimelineSearchResults } from './timeline-search.js';
import { initMomentSearchModal, openMomentSearchModal } from './moment-search.js';
import { openBoardSearchModal } from './board-search.js';
import { initAppUpdate } from './app-update.js';
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
import { scheduleAttendanceCheckIfNeeded, updateTrackerStreakLabel } from './attendance-check.js';
window.scheduleAttendanceCheckIfNeeded = scheduleAttendanceCheckIfNeeded;
import { isDemoUser, markUserHasRealLogin } from './demo-account.js';
import { clearMealsWindowStatsReconcileMeta, clearStreakEmptyDayTrustAll } from './meal-record-count.js';
import { clearLoadedMealsRanges } from './utils/loaded-meals-range.js';
import { isUserSettingsReadyForContentWrites } from './utils/user-settings-write-guard.js';
import { getAuthAccountCreatedTimestamp, getAuthAccountCreatedMillis } from './auth-created-at.js';
import { syncDemoNavGuideDots } from './demo-nav-guide.js';
import { showLandingAppPromo } from './pwa-install.js';
import { maybeStartLandingServiceGuide } from './onboarding.js';
import { initPushNotifications, syncPushRegistrationFromOs } from './push-notifications.js';
import { renderTimeline, renderMiniCalendar, refreshMiniCalendarDots, resetTrackerMiniCalendarRange, updateTimelineShareIndicators, updateTimelineMealEntryPendingIndicators, invalidateTimelineDateSection, renderTimelineDateSections, getOldestPendingPastTimelineDate, localTodayYmd, renderGallery, invalidateGalleryRenderSession, renderFeed, renderEntryChips, toggleComment, toggleFeedComment, createDailyShareCard, renderBoard, renderBoardDetail, renderNoticeDetail, escapeHtml, sanitizeFormattedText, stripDangerousTagsOnly, filterGalleryByUser, resetGalleryUserFilterState, clearGalleryFilter, switchGalleryFilterTab, fetchUserProfiles } from './render/index.js';
import './render/timeline-meal-photos-popup.js';
import { ensureAnalytics, installAnalyticsLazyStubs } from './analytics/ensure.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, retryMealEntrySync, retryMealEntryDeleteSync, retryPendingMealEntriesOnAppReady, setRating, resetRating, setSatiety, resetSatiety, selectTag,
    handleMultipleImages, removePhoto, movePhotoOrder, selectRecordPhotoPreview, navigateRecordPhotoPreview, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, switchSettingsTab, saveSettings, saveProfileSettings, selectIcon, setSettingsProfileType, handlePhotoUpload, addTag, removeTag, deleteSubTag, addFavoriteTag, removeFavoriteTag, selectFavoriteMainTag,
    fillProfileActivityStats,
    syncPushPreferencesFormFromUserSettings,
    setRecordPhotoAspectRatio,
    openKakaoPlaceSearch, searchKakaoPlaces, selectKakaoPlace, applyKakaoSearchText, applyKakaoPlaceManualText,
    openDailyJournalModal, closeDailyJournalModal, saveDailyJournal, deleteDailyJournal,
    updateDailyJournalShareIndicator, toggleDailyJournalSharePhoto,
    handleDailyJournalImages, removeDailyJournalPhoto, moveDailyJournalPhotoOrder, setDailyJournalPhotoAspectRatio,
    editDailyJournalPhoto,
    addDailyJournalMetricRecord, removeDailyJournalMetricRecord,
    openDailyCommentModal, closeDailyCommentModal,
    openEntrySlotPicker, closeEntrySlotPicker
} from './modals.js';
import { openQuickEntryModal } from './modals/entry-quick-open.js';
import { DEFAULT_SUB_TAGS, REPORT_REASONS, SATIETY_DATA } from './constants.js';
import { registerMainNetworkListeners, runMealogNetworkRecovery, prepareMomentFeedNetworkForReload } from './main/network.js';
import { registerMainCleanup } from './main/cleanup.js';
import { syncOrphanedSharesToMoment } from './main/shares-sync.js';
import { startNotificationListeners, stopNotificationListeners } from './main/notifications.js';
import { registerMainTabSwitch } from './main/tabs.js';
import { registerMomentFeedAutoRetry } from './main/moment-feed-auto-retry.js';
import { registerMealOutboxDrain } from './utils/meal-outbox-drain.js';
import { clearNavFeedUpdateDots, refreshNavFeedUpdateDots } from './main/nav-feed-update-dots.js';
import { registerContentPopup, recordBannerView, recordBannerClick } from './main/content-popup.js';
import { initEventListeners } from './main/event-listeners.js';
import { registerEventListenerManager } from './main/event-listener-manager.js';
import { registerMomentSyncDevTools } from './main/moment-sync-dev.js';
import { initImageLoadingDebug } from './utils/image-loading-debug.js';

import { registerMainPostInteractions } from './main/post-interactions-daily.js';
import './modals/diet-report.js';
import { registerMainFeedOptionsReport } from './main/feed-options-report.js';
import { registerMainBoardHandlers } from './main/board-handlers.js';
import { setSharedPhotos } from './utils/moment-share-state.js';
registerMainNetworkListeners();
registerMainCleanup();
registerMainTabSwitch();
registerMomentFeedAutoRetry();
registerMealOutboxDrain();
initLucideIcons();
registerContentPopup();
registerEventListenerManager();
registerMomentSyncDevTools();
initImageLoadingDebug();
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
window.renderTimelineDateSections = renderTimelineDateSections;
window.Mealog.renderTimeline = renderTimeline;
window.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.Mealog.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.renderGallery = renderGallery;
window.Mealog.renderGallery = renderGallery;
window.filterGalleryByUser = filterGalleryByUser;
window.Mealog.filterGalleryByUser = filterGalleryByUser;
window.clearGalleryFilter = clearGalleryFilter;
window.Mealog.clearGalleryFilter = clearGalleryFilter;
window.resetGalleryUserFilterState = resetGalleryUserFilterState;
window.Mealog.resetGalleryUserFilterState = resetGalleryUserFilterState;
window.switchGalleryFilterTab = switchGalleryFilterTab;
window.Mealog.switchGalleryFilterTab = switchGalleryFilterTab;
let reloadMomentFeedInFlight = false;

/**
 * 네트워크 오류 등으로 모먼트 피드 로드가 실패했을 때 '다시 불러오기'로 호출. 전체 피드/사용자 필터 모드 모두 처리.
 * @param {{ quiet?: boolean }} [options] quiet: 로딩 오버레이 없이 조용히 재시도 (자동 재시도용 — 오버레이가 깜빡이면 안 된다)
 */
window.reloadMomentFeed = async function reloadMomentFeed(options = {}) {
    if (reloadMomentFeedInFlight) return;
    reloadMomentFeedInFlight = true;
    const quiet = options && options.quiet === true;
    invalidateGalleryRenderSession();
    if (!quiet) showLoading('모먼트 불러오는 중...', { dimBackground: false, recordsFab: true });
    try {
        await prepareMomentFeedNetworkForReload();
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
                console.warn('모먼트(프로필) 첫 로드 실패, Firestore 복구 후 재시도:', e?.message || e);
                try {
                    // 읽기 실패에 인스턴스를 재생성하지 않는다 — terminate 는 밀로그 기록 리스너까지
                    // 죽이므로, 자동 재시도가 실패할 때마다 앱 전체의 데이터가 함께 사라진다.
                    await prepareMomentFeedNetworkForReload();
                } catch (recoverErr) {
                    console.warn('모먼트: 네트워크 복구 실패:', recoverErr?.message || recoverErr);
                }
                try {
                    invalidateGalleryRenderSession();
                    await renderGallery({ forceReload: true });
                } catch (retryErr) {
                    console.error('모먼트(프로필) 다시 불러오기 렌더 실패:', retryErr);
                    appState.galleryFeedNetworkError = true;
                    invalidateGalleryRenderSession();
                    await renderGallery({ forceReload: true });
                }
            }
            if (typeof renderFeed === 'function') renderFeed();
            return;
        }
        window.sharedPhotosFeed = [];
        appState.sharedPhotosFeedLastDoc = null;
        appState.sharedPhotosFeedHasMore = false;
        try {
            let loadResult;
            try {
                loadResult = await loadSharedPhotosPageReliable(10);
            } catch (firstErr) {
                console.warn('모먼트: 첫 로드 실패, Firestore 복구 후 재시도:', firstErr?.message || firstErr);
                try {
                    // 읽기 실패에 인스턴스를 재생성하지 않는다 — terminate 는 밀로그 기록 리스너까지
                    // 죽이므로, 자동 재시도가 실패할 때마다 앱 전체의 데이터가 함께 사라진다.
                    await prepareMomentFeedNetworkForReload();
                } catch (recoverErr) {
                    console.warn('모먼트: 네트워크 복구 실패:', recoverErr?.message || recoverErr);
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
        } catch (e) {
            console.error('공유 사진 로드 실패:', e);
            appState.galleryFeedNetworkError = true;
            invalidateGalleryRenderSession();
            await renderGallery({ forceReload: true });
        }
        if (typeof renderFeed === 'function') renderFeed();
    } finally {
        reloadMomentFeedInFlight = false;
        if (!quiet) hideLoading();
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

// 사용자 프로필 뷰 내 모먼트/게시판 탭 전환 시 하단 탭 표시 동기화 (render.js에서 호출)
window.syncBottomNavForGalleryFilter = () => {
    const navGallery = document.getElementById('nav-gallery');
    const navBoard = document.getElementById('nav-board');
    if (!navGallery || !navBoard) return;
    if (appState.galleryFilterUserId && appState.galleryFilterTab === 'board') {
        document.body.dataset.galleryFilterNav = 'board';
        if (appState.currentTab === 'gallery') {
            navGallery.classList.remove('active');
            navBoard.classList.add('active');
        }
    } else if (appState.galleryFilterUserId) {
        document.body.dataset.galleryFilterNav = 'moment';
        if (appState.currentTab === 'gallery') {
            navGallery.classList.add('active');
            navBoard.classList.remove('active');
        }
    } else {
        document.body.removeAttribute('data-gallery-filter-nav');
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
window.openQuickEntryModal = openQuickEntryModal;
window.Mealog.openQuickEntryModal = openQuickEntryModal;
window.openEntrySlotPicker = openEntrySlotPicker;
window.Mealog.openEntrySlotPicker = openEntrySlotPicker;
window.closeEntrySlotPicker = closeEntrySlotPicker;
window.Mealog.closeEntrySlotPicker = closeEntrySlotPicker;
window.closeModal = closeModal;
window.Mealog.closeModal = closeModal;
window.openDailyJournalModal = openDailyJournalModal;
window.Mealog.openDailyJournalModal = openDailyJournalModal;
window.closeDailyJournalModal = closeDailyJournalModal;
window.Mealog.closeDailyJournalModal = closeDailyJournalModal;
window.saveDailyJournal = saveDailyJournal;
window.deleteDailyJournal = deleteDailyJournal;
window.Mealog.saveDailyJournal = saveDailyJournal;
window.Mealog.deleteDailyJournal = deleteDailyJournal;
window.updateDailyJournalShareIndicator = updateDailyJournalShareIndicator;
window.Mealog.updateDailyJournalShareIndicator = updateDailyJournalShareIndicator;
window.toggleDailyJournalSharePhoto = toggleDailyJournalSharePhoto;
window.Mealog.toggleDailyJournalSharePhoto = toggleDailyJournalSharePhoto;
window.handleDailyJournalImages = handleDailyJournalImages;
window.Mealog.handleDailyJournalImages = handleDailyJournalImages;
window.removeDailyJournalPhoto = removeDailyJournalPhoto;
window.Mealog.removeDailyJournalPhoto = removeDailyJournalPhoto;
window.moveDailyJournalPhotoOrder = moveDailyJournalPhotoOrder;
window.Mealog.moveDailyJournalPhotoOrder = moveDailyJournalPhotoOrder;
window.setDailyJournalPhotoAspectRatio = setDailyJournalPhotoAspectRatio;
window.Mealog.setDailyJournalPhotoAspectRatio = setDailyJournalPhotoAspectRatio;
window.editDailyJournalPhoto = editDailyJournalPhoto;
window.Mealog.editDailyJournalPhoto = editDailyJournalPhoto;
window.addDailyJournalMetricRecord = addDailyJournalMetricRecord;
window.Mealog.addDailyJournalMetricRecord = addDailyJournalMetricRecord;
window.removeDailyJournalMetricRecord = removeDailyJournalMetricRecord;
window.Mealog.removeDailyJournalMetricRecord = removeDailyJournalMetricRecord;
window.openDailyCommentModal = openDailyCommentModal;
window.Mealog.openDailyCommentModal = openDailyCommentModal;
window.closeDailyCommentModal = closeDailyCommentModal;
window.Mealog.closeDailyCommentModal = closeDailyCommentModal;
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
window.resetRating = resetRating;
window.Mealog.resetRating = resetRating;
window.setSatiety = setSatiety;
window.Mealog.setSatiety = setSatiety;
window.resetSatiety = resetSatiety;
window.Mealog.resetSatiety = resetSatiety;
window.selectTag = selectTag;
window.Mealog.selectTag = selectTag;
window.handleMultipleImages = handleMultipleImages;
window.Mealog.handleMultipleImages = handleMultipleImages;
window.removePhoto = removePhoto;
window.Mealog.removePhoto = removePhoto;
window.movePhotoOrder = movePhotoOrder;
window.Mealog.movePhotoOrder = movePhotoOrder;
window.selectRecordPhotoPreview = selectRecordPhotoPreview;
window.Mealog.selectRecordPhotoPreview = selectRecordPhotoPreview;
window.navigateRecordPhotoPreview = navigateRecordPhotoPreview;
window.Mealog.navigateRecordPhotoPreview = navigateRecordPhotoPreview;
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
/* 밀당(analytics): 첫 진입·onclick 시 ensureAnalytics로 지연 로드 */
installAnalyticsLazyStubs();
window.Mealog.ensureAnalytics = ensureAnalytics;
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
window.applyKakaoSearchText = applyKakaoSearchText;
window.Mealog.applyKakaoSearchText = applyKakaoSearchText;
window.applyKakaoPlaceManualText = applyKakaoPlaceManualText;
window.Mealog.applyKakaoPlaceManualText = applyKakaoPlaceManualText;
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
    // 일간(page)만 지원 — list 요청도 page로 고정
    appState.viewMode = 'page';
    document.getElementById('timelineView')?.classList.add('timeline-view-mode-page');
    if (m === 'list') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        appState.pageDate = today;
    }
    window.loadedDates = [];
    window.hasScrolledToToday = false;
    const c = document.getElementById('timelineContainer');
    if (c) c.innerHTML = '';
    renderTimeline();
    renderMiniCalendar();
};

/**
 * 타임라인 날짜 이동.
 * - 기본: 해당 날짜 섹션을 화면 상단 오프셋에 맞춰 스크롤
 * - 저장 직후/리스너 재렌더 등에서 중복 스크롤을 막기 위해 옵션 지원
 * @param {string} iso YYYY-MM-DD
 * @param {{scroll?: boolean, behavior?: ScrollBehavior, onceKey?: string, anchorAfterRenderMs?: number}} [opts]
 */
window.jumpToDate = async (iso, opts = {}) => {
    const {
        scroll = true,
        behavior = 'smooth',
        onceKey = '',
        anchorAfterRenderMs = 900
    } = opts || {};

    // 동일한 "1회성 이동"은 짧은 시간 내 재실행 방지
    if (onceKey) {
        const now = Date.now();
        if (!window._jumpToDateOnce) window._jumpToDateOnce = Object.create(null);
        const prev = window._jumpToDateOnce[onceKey] || 0;
        if (now - prev < 2500) {
            // 렌더는 필요할 수 있으니 아래 로직은 진행하되, 스크롤만 억제
            opts = { ...opts, scroll: false };
        } else {
            window._jumpToDateOnce[onceKey] = now;
        }
    }

    // 빠른 연속 이동 시 이전 ensure 완료가 최신 화면을 덮지 않도록 세대 토큰
    window._jumpToDateGen = (window._jumpToDateGen || 0) + 1;
    const jumpGen = window._jumpToDateGen;

    // 날짜를 명확하게 설정 (시간대 문제 방지)
    const targetDate = new Date(iso + 'T00:00:00');
    appState.pageDate = targetDate;
    
    // 트래커/날짜 이동: 해당일 ±3일을 미리 로드 (좌우 넘김 대비)
    if (needsMealsLoadedAroundDate(iso, 3)) {
        const loadingOverlay = document.getElementById('loadingOverlay');
        try {
            if (loadingOverlay) loadingOverlay.classList.remove('hidden');
            await ensureMealsLoadedAroundDate(iso, 3);
        } catch (e) {
            console.warn('날짜 이동 시 데이터 로드 실패:', e);
            showToast('기록을 불러오는 중 오류가 발생했습니다.', 'error');
        } finally {
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
        }
    }

    // 더 최근 jumpToDate가 있으면 렌더/스크롤 생략
    if (jumpGen !== window._jumpToDateGen) return;
    
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
        
        const shouldScroll = !!(opts && opts.scroll !== false && scroll !== false);
        if (shouldScroll) {
            const b = (opts && typeof opts.behavior === 'string') ? opts.behavior : behavior;
            // 리스너 재렌더가 직후에 들어와도 "해당 날짜 섹션 앵커"를 잠깐만 허용
            window._timelineAnchorScrollUntil = Date.now() + Math.max(0, Number(anchorAfterRenderMs) || 0);
            setTimeout(() => {
                if (jumpGen !== window._jumpToDateGen) return;
                const el = document.getElementById(`date-${targetStr}`);
                if (el) {
                    const trackerSection = document.getElementById('trackerSection');
                    const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                    const headerHeight = 73;
                    const totalOffset = headerHeight + trackerHeight;
                    const elementTop = el.getBoundingClientRect().top + window.pageYOffset;
                    const offsetPosition = elementTop - totalOffset - 16;
                    window.scrollTo({ top: Math.max(0, offsetPosition), behavior: b });
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

window.toggleSearch = () => {
    if (appState.currentTab === 'board') {
        const sub = appState.boardListSubTab;
        if (sub === 'board' || sub === 'notice') {
            openBoardSearchModal();
        }
        return;
    }
    if (appState.currentTab === 'gallery') {
        openMomentSearchModal();
        return;
    }
    if (appState.currentTab !== 'timeline') return;
    openTimelineSearchModal();
};

window.closeSearch = () => {
    clearTimelineSearchResults();
    const tc = document.getElementById('timelineContainer');
    if (tc) tc.innerHTML = '';
    renderTimeline();
};

window.clearGalleryFilterPostId = () => {
    appState.galleryFilterPostId = null;
    appState.galleryNotificationFilterPhotos = null;
    renderGallery();
};

window.updateGalleryTraceFilterBarUI = () => {
    const panel = document.getElementById('galleryTraceFilterPanel');
    if (!panel) return;
    const f = appState.currentTab === 'board' ? appState.boardTraceFilter : appState.galleryTraceFilter;
    ['like', 'comment', 'bookmark'].forEach((trace) => {
        const btn = panel.querySelector(`[data-trace="${trace}"]`);
        if (!btn) return;
        const icon = btn.querySelector('i');
        const isActive = f === trace;
        btn.classList.toggle('gallery-trace-btn--active', isActive);
        btn.classList.remove('bg-slate-100', 'text-slate-700', 'text-red-500');
        if (trace === 'like') {
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

/** 스크롤·더보기 공통: 다음 5일을 그리기 전에 필요한 만큼 1주 단위로 fetch */
async function ensureMealsLoadedForNextTimelineDays(dayCount = 5) {
    let totalNew = 0;
    for (let i = 0; i < 8; i++) {
        const range = window.loadedMealsDateRange;
        if (!range?.start) break;
        const oldestNeeded = getOldestPendingPastTimelineDate({
            todayStr: localTodayYmd(),
            count: dayCount,
            loadedDates: window.loadedDates
        });
        if (!oldestNeeded || oldestNeeded >= range.start) break;
        const prevStart = range.start;
        const { count } = await loadMoreMeals(1, 'week');
        totalNew += count;
        // 범위가 안 움직이면 무한 루프 방지
        if (window.loadedMealsDateRange?.start === prevStart) break;
    }
    return totalNew;
}

// 더보기 함수 (타임라인용) — 스크롤과 동일: 1주 fetch + 연속 5일 렌더
window.loadMoreMealsTimeline = async () => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        window.hasScrolledToToday = true;
        const scrollY = window.scrollY;
        const pendingBefore = getOldestPendingPastTimelineDate({
            todayStr: localTodayYmd(),
            count: 5,
            loadedDates: window.loadedDates
        });
        const count = await ensureMealsLoadedForNextTimelineDays(5);
        renderTimeline();
        requestAnimationFrame(() => {
            window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
        });
        syncOrphanedSharesToMoment().then(() => {
            updateTimelineShareIndicators();
        }).catch(() => {});
        renderMiniCalendar();
        if (count > 0) {
            showToast(`${count}개의 기록을 불러왔습니다.`, 'success');
        } else if (!pendingBefore) {
            showToast('더 이상 불러올 기록이 없습니다.', 'info');
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

// 로그인 상태 확인 중에는 스피너 표시하지 않음 (스피너는 로그인→메인 전환 시 기록 로드할 때만 표시)

/**
 * 자동 둘러보기(데모 로그인) 여부.
 * 의도: 첫 실행은 서비스 가이드 → 로그인 화면. 둘러보기는 로그인 화면「둘러보기」버튼으로만.
 */
function shouldTryAutoDemoSignIn(_wasExplicitLogout, _wasDemoUserLogout) {
    return false;
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
            clearStreakEmptyDayTrustAll();
            clearMealsWindowStatsReconcileMeta();
            clearLoadedMealsRanges();
            resetTrackerMiniCalendarRange();
            window.dailyStats = null;
            setSharedPhotos(null);
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
        
        // 중복 기록 자동 정리 — 본식 다건 허용으로 비활성화 (removeDuplicateMeals는 서버에서 2건째 본식 삭제함)
        
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

            setSharedPhotos([]);
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
                // setupListeners는 settings/data만 해제하므로 stats는 여기서 해제 — 재구독마다 누적되는 리스너 누수 방지
                if (appState.statsUnsubscribe) {
                    try {
                        appState.statsUnsubscribe();
                    } catch (_) {
                        /* ignore */
                    }
                    appState.statsUnsubscribe = null;
                }
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
                onDataUpdate: (update = { source: 'meals', mode: 'initial' }) => {
                    scheduleAttendanceCheckIfNeeded();
                    const tab = appState.currentTab;
                    if (tab === 'dashboard') {
                        void ensureAnalytics()
                            .then((m) => m.updateDashboard())
                            .catch((e) => console.warn('[dashboard] updateDashboard 실패:', e));
                        if (window._recordsLoadHidePending && window.loadedMealsDateRange) {
                            window._recordsLoadHidePending = false;
                            hideLoading();
                        }
                        return;
                    }
                    if (tab === 'timeline') {
                        updateTrackerStreakLabel();
                    }
                    // 타임라인 탭이 보일 때만 재렌더. 다른 탭(앨범/분석/피드)에서는 스킵해 프리즈·고CPU 방지.
                    if (tab !== 'timeline') return;
                    // 밀로그 메인 화면에서 기록(meals) 첫 수신 시에만 로딩 오버레이 숨김 (loadedMealsDateRange는 meals 리스너에서만 설정됨)
                    if (window._recordsLoadHidePending && window.loadedMealsDateRange) {
                        window._recordsLoadHidePending = false;
                        hideLoading();
                    }
                    const mode = update?.mode || 'initial';
                    // 저장 직후 freeze 구간: 전체/부분 재렌더 스킵 (metadataOnly·statsOnly는 경량 패치만 허용)
                    const frozen =
                        window._timelineRerenderFreezeUntil &&
                        Date.now() < window._timelineRerenderFreezeUntil;
                    if (frozen && mode !== 'metadataOnly' && mode !== 'statsOnly') return;

                    const runTimelinePatch = () => {
                        if (appState.currentTab !== 'timeline') return;
                        if (mode === 'none') return;
                        if (mode === 'metadataOnly') {
                            updateTimelineMealEntryPendingIndicators();
                            updateTimelineShareIndicators();
                            refreshMiniCalendarDots();
                            return;
                        }
                        if (mode === 'statsOnly') {
                            refreshMiniCalendarDots();
                            return;
                        }
                        if (mode === 'mealData') {
                            const dates = Array.isArray(update.changedDates) ? update.changedDates : [];
                            dates.forEach((d) => invalidateTimelineDateSection(d));
                            if (dates.length) {
                                renderTimelineDateSections(dates);
                            } else {
                                renderTimeline();
                            }
                            refreshMiniCalendarDots();
                            return;
                        }
                        // initial: 첫 로드·fallback — 전체 재구성
                        const preserveTimelineScroll = window.hasScrolledToToday === true;
                        const savedScrollY = window.scrollY;
                        window.loadedDates = [];
                        if (!preserveTimelineScroll) {
                            window.hasScrolledToToday = false;
                        }
                        const container = document.getElementById('timelineContainer');
                        if (typeof window.cancelDailySwipeHint === 'function') window.cancelDailySwipeHint();
                        if (container) container.innerHTML = '';
                        renderTimeline();
                        renderMiniCalendar();
                        // 밀로그 진입 직후 첫 로드로 화면이 다시 그려지면 스와이프 힌트 재예약(미재생분만)
                        if (
                            window.__pendingDailySwipeHint &&
                            !window.__dailySwipeHintPlayed &&
                            typeof window.scheduleDailySwipeHint === 'function'
                        ) {
                            window.scheduleDailySwipeHint(0);
                        }
                        // 리스너 initial 재렌더 직후: 선택일이 로드 구간 밖이면 on-demand로 보강
                        if (appState.viewMode === 'page' && appState.pageDate instanceof Date && !isNaN(+appState.pageDate)) {
                            const py = appState.pageDate.getFullYear();
                            const pm = String(appState.pageDate.getMonth() + 1).padStart(2, '0');
                            const pd = String(appState.pageDate.getDate()).padStart(2, '0');
                            const pageIso = `${py}-${pm}-${pd}`;
                            if (needsMealsLoadedAroundDate(pageIso, 3)) {
                                void ensureMealsLoadedAroundDate(pageIso, 3)
                                    .then(() => {
                                        if (appState.currentTab !== 'timeline') return;
                                        invalidateTimelineDateSection(pageIso);
                                        renderTimelineDateSections([pageIso]);
                                        refreshMiniCalendarDots();
                                    })
                                    .catch(() => {});
                            }
                        }
                        if (preserveTimelineScroll) {
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    const allowAnchor =
                                        window._timelineAnchorScrollUntil &&
                                        Date.now() < window._timelineAnchorScrollUntil;
                                    if (allowAnchor) {
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
                                                window.__suppressChromeScrollHideUntil = Date.now() + 500;
                                                window.scrollTo({
                                                    top: Math.max(0, offsetPosition),
                                                    behavior: 'instant'
                                                });
                                                window.__revealAppChromeAfterProgrammaticScroll?.();
                                                return;
                                            }
                                        }
                                    }
                                    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
                                });
                            });
                        }
                    };

                    if (mode === 'metadataOnly' || mode === 'statsOnly') {
                        runTimelinePatch();
                        return;
                    }

                    if (dataUpdateTimer) clearTimeout(dataUpdateTimer);
                    dataUpdateTimer = setTimeout(() => {
                        dataUpdateTimer = null;
                        runTimelinePatch();
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
            setSharedPhotos([]);
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

            async function resolveLegacyLoginBanner(currentEnv) {
                const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
                const data = bannerDoc.exists() ? bannerDoc.data() : null;
                if (!data || !data.enabled) return null;
                const targetEnv = data.targetEnv || 'all';
                if (targetEnv !== 'all' && targetEnv !== currentEnv) return null;
                let imageUrl = '';
                let landingNoticeId = '';
                if (Array.isArray(data.slides) && data.slides.length > 0) {
                    const s = data.slides[0];
                    if (s && typeof s === 'object') {
                        imageUrl = (s.imageUrl && String(s.imageUrl).trim()) || '';
                        landingNoticeId = (s.landingNoticeId && String(s.landingNoticeId).trim()) || '';
                    }
                }
                if (!imageUrl) imageUrl = (data.imageUrl && String(data.imageUrl).trim()) || '';
                if (!landingNoticeId) landingNoticeId = (data.landingNoticeId && String(data.landingNoticeId).trim()) || '';
                if (!imageUrl && !landingNoticeId) return null;
                return { campaignId: null, imageUrl, landingNoticeId };
            }

            try {
                const today = new Date().toISOString().slice(0, 10);
                const currentEnv = getMealogClientEnv();
                let campaignId = null;
                let imageUrl = '';
                let landingNoticeId = '';

                const coll = collection(db, 'artifacts', appId, 'loginBanners');
                const q = query(coll, orderBy('timestamp', 'desc'), limit(50));
                const snap = await getDocs(q);
                for (const docSnap of snap.docs) {
                    const d = docSnap.data();
                    const targetEnv = d.targetEnv || 'all';
                    if (targetEnv !== 'all' && targetEnv !== currentEnv) continue;
                    const start = d.startDate || '';
                    const end = d.endDate || '';
                    if (!start || !end || today < start || today > end) continue;
                    const img = (d.imageUrl && String(d.imageUrl).trim()) || '';
                    const lid = (d.landingNoticeId && String(d.landingNoticeId).trim()) || '';
                    if (!img && !lid) continue;
                    campaignId = docSnap.id;
                    imageUrl = img;
                    landingNoticeId = lid;
                    break;
                }

                if (!imageUrl && !landingNoticeId) {
                    const leg = await resolveLegacyLoginBanner(currentEnv);
                    if (leg) {
                        campaignId = leg.campaignId;
                        imageUrl = leg.imageUrl;
                        landingNoticeId = leg.landingNoticeId;
                    }
                }

                if (!imageUrl && !landingNoticeId) {
                    section.classList.add('hidden');
                    if (landingPage) landingPage.classList.remove('landing-banner-visible');
                    return;
                }

                section.classList.remove('hidden');
                if (landingPage) landingPage.classList.add('landing-banner-visible');
                section.classList.add('bg-white');
                if (imgEl) {
                    if (imageUrl) {
                        section.classList.remove('bg-white');
                        imgEl.setAttribute('src', imageUrl);
                        imgEl.setAttribute('alt', '');
                        imgEl.classList.remove('hidden');
                    } else {
                        imgEl.classList.add('hidden');
                        imgEl.removeAttribute('src');
                        section.classList.add('bg-white');
                    }
                }
                recordBannerView(campaignId);
                section.removeAttribute('role');
                section.style.cursor = '';
                section.onclick = null;
                if (landingNoticeId) {
                    section.setAttribute('role', 'button');
                    section.style.cursor = 'pointer';
                    section.onclick = () => {
                        recordBannerClick(campaignId);
                        try {
                            sessionStorage.setItem('loginBannerLandingNoticeId', landingNoticeId);
                        } catch (_) {}
                        if (typeof window.startGuest === 'function') window.startGuest();
                    };
                }
            } catch (e) {
                console.warn('로그인 배너 설정 로드 실패:', e);
                section.classList.add('hidden');
                const lp = document.getElementById('landingPage');
                if (lp) lp.classList.remove('landing-banner-visible');
            }
        }

        // 로그인 필요 시: 아이콘 페이드 → 가운데 mealog 표시 → 같은 자리에서 위로 이동 → 상단 레이아웃·버튼
        const showLoginScreen = () => {
            if (typeof window.dismissMealogBootSplash === 'function') {
                window.dismissMealogBootSplash();
            }
            const landingPage = document.getElementById('landingPage');
            const landingLoginOptions = document.getElementById('landingLoginOptions');
            if (landingPage) landingPage.classList.add('landing-show-login');
            document.documentElement.classList.add('mealog-landing-login');

            const LANDING_ICON_FADE_MS = 400;
            const LANDING_PAUSE_BEFORE_RISE_MS = 280;
            const LANDING_RISE_MS = 1050;

            const showLoginButtons = () => {
                if (landingLoginOptions) {
                    landingLoginOptions.classList.remove('hidden');
                    requestAnimationFrame(() => {
                        landingLoginOptions.classList.add('landing-options-visible');
                    });
                }
                showLandingAppPromo();
                loadAndShowLoginBanner();
            };

            const runLandingTitleRise = () => {
                const titleEl = document.getElementById('landingSplashTitleAndTagline');
                if (!landingPage || !titleEl) {
                    landingPage?.classList.add('landing-buttons-visible');
                    showLoginButtons();
                    return;
                }

                const applyFinalLandingLayout = () => {
                    titleEl.style.transition = 'none';
                    landingPage.classList.add('landing-buttons-visible');
                    landingPage.classList.remove('landing-rising');
                    titleEl.classList.remove('landing-title-rising');
                    titleEl.style.transform = '';
                    titleEl.style.willChange = '';
                };

                requestAnimationFrame(() => {
                    const fromTop = titleEl.getBoundingClientRect().top;
                    landingPage.classList.add('landing-buttons-visible');
                    const targetTop = titleEl.getBoundingClientRect().top;
                    landingPage.classList.remove('landing-buttons-visible');
                    void titleEl.offsetHeight;

                    let shiftY = targetTop - fromTop;
                    if (shiftY > 0) shiftY = 0;

                    if (!Number.isFinite(shiftY) || Math.abs(shiftY) < 2) {
                        applyFinalLandingLayout();
                        showLoginButtons();
                        return;
                    }

                    landingPage.classList.add('landing-rising');
                    titleEl.classList.add('landing-title-rising');
                    titleEl.style.transition = 'none';
                    titleEl.style.transform = 'translate3d(0, 0, 0)';

                    requestAnimationFrame(() => {
                        titleEl.style.transition = `transform ${LANDING_RISE_MS}ms cubic-bezier(0.25, 0.85, 0.35, 1)`;
                        titleEl.style.transform = `translate3d(0, ${shiftY}px, 0)`;

                        let done = false;
                        const finish = () => {
                            if (done) return;
                            done = true;
                            titleEl.removeEventListener('transitionend', onTransitionEnd);
                            applyFinalLandingLayout();
                            showLoginButtons();
                        };
                        const onTransitionEnd = (e) => {
                            if (e.target !== titleEl || e.propertyName !== 'transform') return;
                            finish();
                        };
                        titleEl.addEventListener('transitionend', onTransitionEnd);
                        setTimeout(finish, LANDING_RISE_MS + 120);
                    });
                });
            };

            setTimeout(runLandingTitleRise, LANDING_ICON_FADE_MS + LANDING_PAUSE_BEFORE_RISE_MS);
        };

        // 자동 둘러보기 비활성: auth null 확정 즉시 가이드 → 로그인 (400ms 대기 제거)
        // 명시적 로그아웃(둘러보기·체험 모드에서「로그인하기」등)은 가이드를 건너뛰고 바로 로그인 화면으로 이동
        const presentLandingOrGuide = async () => {
            if (wasExplicitLogout) {
                showLoginScreen();
                return;
            }
            try {
                const shown = await maybeStartLandingServiceGuide({
                    onComplete: () => showLoginScreen(),
                });
                if (!shown) showLoginScreen();
            } catch (e) {
                console.warn('랜딩 서비스 가이드 표시 실패:', e);
                showLoginScreen();
            }
        };
        void presentLandingOrGuide();
        
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
            if (typeof window.dismissMealogBootSplash === 'function') {
                window.dismissMealogBootSplash();
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
// 헤더 숨김/표시 토글 직후 쿨다운: 토글로 문서 높이가 바뀌며 발생하는 합성 scroll 이벤트가
// 곧바로 반대 토글을 일으켜 헤더가 덜덜 떨리는 현상(oscillation)을 방지한다.
let _chromeToggleLockUntil = 0;

function syncAppChromeScrollBaseline() {
    _lastScrollY = window.scrollY;
}

function revealAppChromeAfterProgrammaticScroll() {
    document.getElementById('mainAppHeader')?.classList.remove('header-scroll-hidden');
    document.getElementById('trackerSection')?.classList.remove('tracker-header-hidden');
    document.body.classList.remove('bottom-nav-scroll-hidden');
    syncAppChromeScrollBaseline();
    _chromeToggleLockUntil = Date.now() + 320;
}

window.__syncAppChromeScrollLast = syncAppChromeScrollBaseline;
window.__revealAppChromeAfterProgrammaticScroll = revealAppChromeAfterProgrammaticScroll;
window.__suppressChromeScrollHideUntil = 0;

window.addEventListener('mealog:mainScreenShown', () => {
    revealAppChromeAfterProgrammaticScroll();
});

window.addEventListener('scroll', () => {
    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) return;
    const header = document.getElementById('mainAppHeader');
    if (!header) return;
    const tracker = document.getElementById('trackerSection');
    const y = window.scrollY;
    if (_headerScrollRaf) cancelAnimationFrame(_headerScrollRaf);
    _headerScrollRaf = requestAnimationFrame(() => {
        _headerScrollRaf = null;
        // 쿨다운 중에는 기준값만 따라가고 토글하지 않음 (떨림 차단)
        if (Date.now() < _chromeToggleLockUntil) {
            _lastScrollY = y;
            return;
        }
        const suppressUntil = Number(window.__suppressChromeScrollHideUntil || 0) || 0;
        if (suppressUntil && Date.now() < suppressUntil) {
            _lastScrollY = y;
            return;
        }
        const delta = y - _lastScrollY;
        const scrollThreshold = 8;
        const topThreshold = 24;
        const isScrollingDown = delta > scrollThreshold;
        const isScrollingUp = delta < -scrollThreshold;
        const atTop = y <= topThreshold;
        const isGallery = appState.currentTab === 'gallery';
        const galleryV2 = isGallery && document.getElementById('galleryContainer')?.classList?.contains('moment-feed-layout-v2');
        const wasHidden = header.classList.contains('header-scroll-hidden');
        if (isScrollingDown && !atTop) {
            if (!isGallery || galleryV2) {
                header.classList.add('header-scroll-hidden');
                if (tracker) tracker.classList.add('tracker-header-hidden');
            }
            document.body.classList.add('bottom-nav-scroll-hidden');
        } else if (isScrollingUp || atTop) {
            header.classList.remove('header-scroll-hidden');
            if (tracker) tracker.classList.remove('tracker-header-hidden');
            document.body.classList.remove('bottom-nav-scroll-hidden');
        }
        // 숨김 상태가 실제로 바뀐 경우에만 쿨다운 — 레이아웃 변동(문서 높이) 되먹임 차단
        if (header.classList.contains('header-scroll-hidden') !== wasHidden) {
            _chromeToggleLockUntil = Date.now() + 320;
        }
        _lastScrollY = y;
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
// 더보기 버튼과 동일: 필요 시 1주 단위 fetch → 연속 5일 렌더
let scrollTimeout;
window.addEventListener('scroll', () => { 
    const state = appState;
    if (state.currentTab !== 'timeline' || state.viewMode !== 'list' || !window.currentUser) return;
    // 사용자가 아래로 스크롤했으면 초기 '오늘로 이동' 비활성화
    if (window.scrollY > 120) {
        window.hasScrolledToToday = true;
    }
    if ((window.innerHeight + window.scrollY) < document.body.offsetHeight - 400) return;
    // 디바운싱: 연속 호출 방지
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(async () => {
        if (appState.currentTab !== 'timeline') return;
        const scrollY = window.scrollY;
        window.hasScrolledToToday = true;
        try {
            await ensureMealsLoadedForNextTimelineDays(5);
        } catch (e) {
            console.warn('스크롤 시 추가 로드 실패:', e);
        }
        renderTimeline();
        requestAnimationFrame(() => {
            window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
        });
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
        let delta = 0;
        if (e.key === 'ArrowLeft') delta = -1;
        else if (e.key === 'ArrowRight') delta = 1;
        if (!delta) return;
        e.preventDefault();
        void ensureAnalytics()
            .then((m) => {
                if (state.dashboardMode === 'week' && typeof m.changeWeek === 'function') m.changeWeek(delta);
                else if (state.dashboardMode === 'month' && typeof m.changeMonth === 'function') m.changeMonth(delta);
                else if (state.dashboardMode === 'year' && typeof m.navigatePeriod === 'function') m.navigatePeriod(delta);
            })
            .catch((err) => console.warn('[dashboard] 키보드 기간 이동 실패:', err));
    }
});

// 터치 제스처 초기화 (일간 스와이프: 현재·다음 날짜가 함께 이동)
function initDailySwipeGesture() {
    if (window.__dailySwipeGestureInitialized) return;
    const tv = document.getElementById('timelineView');
    if (!tv) return;
    /** 카드 아래 page-deep 빈 영역은 #timelineView 밖(body/main)일 수 있어 문서 단위로 수신 */
    const swipeListenRoot = document;

    const getTimelineContainer = () => document.getElementById('timelineContainer');
    /** 일간 스와이프: 버튼·입력 등 실제 조작 요소만 제외(카드 본문은 스와이프 허용) */
    const isInteractiveSwipeTarget = (node) => {
        if (!node || node.nodeType !== 1) return false;
        return !!node.closest(
            'button, a, input, textarea, select, label, [contenteditable="true"], [data-mealog-daily="share"], .snack-tag, .meal-sync-retry-btn, .timeline-meal-photo-tap, .timeline-meal-photo-nav, .timeline-meal-photo-aspect-toggle'
        );
    };
    /** 밀로그 일간 + 빈 배경(카드 사이·아래)까지 스와이프 허용. 상단 크롬·다른 탭·모달은 제외 */
    const canStartDailySwipe = (node) => {
        if (!node || node.nodeType !== 1) return false;
        if (document.body?.dataset?.mainTab !== 'timeline') return false;
        if (tv.classList.contains('hidden')) return false;
        if (isInteractiveSwipeTarget(node)) return false;
        if (
            node.closest(
                '#appTopChrome, #mainAppHeader, #trackerSection, .bottom-nav, #entryQuickInputFab, #mealSyncResendBtn, #initialRecordsLoadFab, #galleryMomentsRefreshFab, #timelineRefreshFab, #boardWriteBtn, #statusBarOverlay, #navigationBarOverlay'
            )
        ) {
            return false;
        }
        const otherView = node.closest('#galleryView, #boardListView, #dashboardView, #settingsView');
        if (otherView && !otherView.classList.contains('hidden')) return false;
        if (node.closest('#entryModal, [role="dialog"], .mealog-center-popup, .mealog-update-banner')) {
            return false;
        }
        return true;
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
    let isSwipeHintPlaying = false;
    let swipeHintTimer = null;
    let swipeHintToken = 0;
    let swipeHintFallbackTimer = null;
    /**
     * fingerLeft: 손가락이 왼쪽으로 움직임(다음날, 새 화면은 오른쪽에서)
     * fingerLeft === false: 손가락이 오른쪽으로 움직임(전날, 새 화면은 왼쪽에서)
     * @type {null | { viewport: HTMLElement, currentPanel: HTMLElement, incomingPanel: HTMLElement, fingerLeft: boolean, vw: number }}
     */
    let scaffold = null;

    const prefersReducedMotion = () => {
        try {
            return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        } catch (_) {
            return false;
        }
    };

    const clearSwipeHintAnimation = () => {
        const tc = getTimelineContainer();
        if (!tc) return;
        tc.classList.remove('timeline-container--swipe-hint');
        tc.style.transition = '';
        tc.style.transform = 'translate3d(0, 0, 0)';
        tc.style.willChange = '';
    };

    const cancelDailySwipeHint = () => {
        swipeHintToken += 1;
        if (swipeHintTimer) {
            clearTimeout(swipeHintTimer);
            swipeHintTimer = null;
        }
        if (swipeHintFallbackTimer) {
            clearTimeout(swipeHintFallbackTimer);
            swipeHintFallbackTimer = null;
        }
        if (isSwipeHintPlaying) {
            isSwipeHintPlaying = false;
            clearSwipeHintAnimation();
        }
        // 아직 재생 전이면 schedule 예약만 풀어 initial 재시도 가능하게
        if (!window.__dailySwipeHintPlayed && window.__dailySwipeHintScheduled) {
            window.__dailySwipeHintScheduled = false;
            window.__pendingDailySwipeHint = true;
        }
    };

    const playDailySwipeHintNow = () => {
        if (prefersReducedMotion()) {
            window.__pendingDailySwipeHint = false;
            window.__dailySwipeHintPlayed = true;
            return;
        }
        if (document.body?.dataset?.mainTab !== 'timeline') return false;
        if (tv.classList.contains('hidden')) return false;
        if (appState.viewMode !== 'page') return false;
        if (isAnimating || tracking) return false;
        const tc = getTimelineContainer();
        if (!tc || tc.childElementCount === 0) return false;

        isSwipeHintPlaying = true;
        tc.style.transition = 'none';
        tc.style.transform = '';
        tc.style.willChange = 'transform';
        // 재시작을 위해 클래스 토글
        tc.classList.remove('timeline-container--swipe-hint');
        void tc.offsetWidth;
        tc.classList.add('timeline-container--swipe-hint');

        const finish = () => {
            if (!isSwipeHintPlaying) return;
            isSwipeHintPlaying = false;
            window.__pendingDailySwipeHint = false;
            if (swipeHintFallbackTimer) {
                clearTimeout(swipeHintFallbackTimer);
                swipeHintFallbackTimer = null;
            }
            clearSwipeHintAnimation();
        };
        const onEnd = (ev) => {
            if (ev.target !== tc) return;
            if (ev.animationName && ev.animationName !== 'mealog-timeline-swipe-hint') return;
            tc.removeEventListener('animationend', onEnd);
            finish();
        };
        tc.addEventListener('animationend', onEnd);
        if (swipeHintFallbackTimer) clearTimeout(swipeHintFallbackTimer);
        swipeHintFallbackTimer = setTimeout(finish, 900);
        return true;
    };

    /** 밀로그 진입 직후 좌우 스와이프 힌트 재생 (방문당 1회) */
    const scheduleDailySwipeHint = (delayMs = 0) => {
        if (prefersReducedMotion()) {
            window.__pendingDailySwipeHint = false;
            window.__dailySwipeHintPlayed = true;
            return;
        }
        // schedule 예약 시점에 소진 — 탭/initial 중복 호출이 동시에 와도 1회만
        if (window.__dailySwipeHintPlayed || window.__dailySwipeHintScheduled) {
            window.__pendingDailySwipeHint = false;
            return;
        }
        window.__dailySwipeHintScheduled = true;
        window.__pendingDailySwipeHint = false;

        const token = ++swipeHintToken;
        if (swipeHintTimer) clearTimeout(swipeHintTimer);
        if (isSwipeHintPlaying) {
            isSwipeHintPlaying = false;
            clearSwipeHintAnimation();
        }
        const start = () => {
            if (token !== swipeHintToken) {
                if (!window.__dailySwipeHintPlayed) {
                    window.__dailySwipeHintScheduled = false;
                    window.__pendingDailySwipeHint = true;
                }
                return;
            }
            const started = playDailySwipeHintNow();
            if (started) {
                window.__dailySwipeHintPlayed = true;
                window.__dailySwipeHintScheduled = false;
                return;
            }
            // 컨테이너 비어 있으면 initial 재시도 허용
            window.__dailySwipeHintScheduled = false;
            window.__pendingDailySwipeHint = true;
        };
        if (delayMs > 0) {
            swipeHintTimer = setTimeout(() => {
                swipeHintTimer = null;
                start();
            }, delayMs);
        } else {
            swipeHintTimer = null;
            start();
        }
    };

    window.scheduleDailySwipeHint = scheduleDailySwipeHint;
    window.cancelDailySwipeHint = cancelDailySwipeHint;

    const getVw = () => {
        if (scaffold?.viewport?.clientWidth) return Math.max(1, scaffold.viewport.clientWidth);
        const style = window.getComputedStyle(tv);
        const pl = parseFloat(style.paddingLeft) || 0;
        const pr = parseFloat(style.paddingRight) || 0;
        return Math.max(1, (tv.clientWidth || window.innerWidth || 360) - pl - pr);
    };

    const waitForTransformEnd = (el, fallbackMs) => new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            el.removeEventListener('transitionend', onEnd);
            clearTimeout(timer);
            resolve();
        };
        const onEnd = (ev) => {
            if (ev.target !== el || (ev.propertyName && ev.propertyName !== 'transform')) return;
            finish();
        };
        const timer = setTimeout(finish, fallbackMs);
        el.addEventListener('transitionend', onEnd);
    });

    const clearSwipeInlineStyles = (el) => {
        if (!el) return;
        el.style.transform = '';
        el.style.transition = '';
        el.style.willChange = '';
    };

    const teardownScaffold = (keepEl) => {
        if (!scaffold) return;
        const { viewport } = scaffold;
        // #timelineContainer 는 #timelineView 직속이 아니라 #timelinePullWrap 안일 수 있음
        const host = viewport.parentNode;
        if (keepEl && host) {
            clearSwipeInlineStyles(keepEl);
            if (keepEl.parentNode !== host) {
                host.insertBefore(keepEl, viewport);
            }
        }
        viewport.remove();
        scaffold = null;
    };

    /**
     * 손가락 deltaX에 맞춰 두 패널을 동시에 이동.
     * - 손가락→왼쪽: 현재는 왼쪽으로, 새 화면은 오른쪽(+vw)에서 따라옴
     * - 손가락→오른쪽: 현재는 오른쪽으로, 새 화면은 왼쪽(-vw)에서 따라옴
     */
    const applyPanelDrag = (dragX, withTransition = false) => {
        if (!scaffold) return;
        const { currentPanel, incomingPanel, fingerLeft, vw } = scaffold;
        const transition = withTransition
            ? 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)'
            : 'none';
        const incomingBase = fingerLeft ? vw : -vw;
        currentPanel.style.transition = transition;
        incomingPanel.style.transition = transition;
        currentPanel.style.willChange = 'transform';
        incomingPanel.style.willChange = 'transform';
        currentPanel.style.transform = `translate3d(${dragX}px, 0, 0)`;
        incomingPanel.style.transform = `translate3d(${dragX + incomingBase}px, 0, 0)`;
    };

    const syncViewportHeight = () => {
        if (!scaffold) return;
        const h = Math.max(
            scaffold.currentPanel.scrollHeight || 0,
            scaffold.incomingPanel.scrollHeight || 0,
            240
        );
        scaffold.viewport.style.minHeight = `${h}px`;
    };

    const ensureScaffold = (fingerLeft, dragX) => {
        const tc = getTimelineContainer();
        // 실제 부모(#timelinePullWrap)에 삽입 — #timelineView 직속이라고 가정하면 insertBefore 실패
        const host = tc?.parentNode;
        if (!tc || !host) return null;
        if (scaffold && scaffold.fingerLeft === fingerLeft) {
            scaffold.vw = getVw();
            applyPanelDrag(dragX);
            return scaffold;
        }
        if (scaffold) {
            const keep =
                scaffold.currentPanel.querySelector('#timelineContainer') ||
                scaffold.currentPanel.querySelector('#timelineContainerOutgoing') ||
                getTimelineContainer();
            if (keep?.id === 'timelineContainerOutgoing') keep.id = 'timelineContainer';
            teardownScaffold(keep);
        }

        // teardown 후 DOM이 바뀌었을 수 있어 다시 조회
        const liveTc = getTimelineContainer();
        const liveHost = liveTc?.parentNode;
        if (!liveTc || !liveHost) return null;

        clearSwipeInlineStyles(liveTc);
        const vw = getVw();
        const viewport = document.createElement('div');
        viewport.className = 'timeline-daily-swipe-viewport';
        const currentPanel = document.createElement('div');
        currentPanel.className = 'timeline-daily-swipe-panel timeline-daily-swipe-panel--current';
        const incomingPanel = document.createElement('div');
        incomingPanel.className = 'timeline-daily-swipe-panel timeline-daily-swipe-panel--incoming';

        liveHost.insertBefore(viewport, liveTc);
        currentPanel.appendChild(liveTc);
        viewport.append(currentPanel, incomingPanel);
        const measured = Math.max(1, viewport.clientWidth || vw);

        scaffold = { viewport, currentPanel, incomingPanel, fingerLeft, vw: measured };
        applyPanelDrag(dragX);
        syncViewportHeight();
        return scaffold;
    };

    const resetTransform = () => {
        if (scaffold) {
            const { currentPanel } = scaffold;
            const keep =
                currentPanel.querySelector('#timelineContainer') ||
                currentPanel.querySelector('#timelineContainerOutgoing') ||
                getTimelineContainer();
            if (keep?.id === 'timelineContainerOutgoing') keep.id = 'timelineContainer';
            applyPanelDrag(0, true);
            waitForTransformEnd(currentPanel, 280).then(() => {
                teardownScaffold(keep);
            });
            return;
        }
        const tc = getTimelineContainer();
        if (!tc) return;
        tc.style.transition = 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)';
        tc.style.transform = 'translate3d(0, 0, 0)';
        tc.style.willChange = '';
    };

    const preloadDateRangeIfNeeded = async (targetIso) => {
        if (!needsMealsLoadedAroundDate(targetIso, 3)) return;
        try {
            await ensureMealsLoadedAroundDate(targetIso, 3);
        } catch (error) {
            console.warn('스와이프 날짜 프리로드 실패:', error);
        }
    };

    const animateToDate = async (dayDelta, releaseX = 0) => {
        if (isAnimating) return;
        cancelDailySwipeHint();
        isAnimating = true;
        // 손가락 왼쪽(releaseX<0) → 다음날, 오른쪽 → 전날. 패널 위치는 손가락 방향만 따름.
        const fingerLeft = releaseX < 0;
        try {
            const sc = ensureScaffold(fingerLeft, releaseX);
            if (!sc) {
                isAnimating = false;
                return;
            }
            sc.vw = getVw();
            applyPanelDrag(releaseX);

            const targetDate = new Date(appState.pageDate);
            targetDate.setDate(targetDate.getDate() + dayDelta);
            const year = targetDate.getFullYear();
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const day = String(targetDate.getDate()).padStart(2, '0');
            const targetIso = `${year}-${month}-${day}`;

            await preloadDateRangeIfNeeded(targetIso);

            const oldTc =
                sc.currentPanel.querySelector('#timelineContainer') ||
                sc.currentPanel.querySelector('#timelineContainerOutgoing');
            if (oldTc) oldTc.id = 'timelineContainerOutgoing';
            const newTc = document.createElement('div');
            newTc.id = 'timelineContainer';
            newTc.className = oldTc?.className || 'ui-stack-lg';
            sc.incomingPanel.innerHTML = '';
            sc.incomingPanel.appendChild(newTc);

            try {
                await window.jumpToDate(targetIso, { scroll: false });
            } catch (error) {
                console.warn('스와이프 날짜 이동 실패:', error);
                if (oldTc) oldTc.id = 'timelineContainer';
                newTc.remove();
                applyPanelDrag(0, true);
                await waitForTransformEnd(sc.currentPanel, 280);
                teardownScaffold(oldTc || getTimelineContainer());
                return;
            }

            syncViewportHeight();
            const vw = getVw();
            sc.vw = vw;
            // 손가락이 왼쪽으로 갔으면 최종 -vw(오른쪽 패널이 화면 중앙), 오른쪽이면 +vw
            const settledX = fingerLeft ? -vw : vw;
            applyPanelDrag(settledX, true);
            sc.currentPanel.style.transition = 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)';
            sc.incomingPanel.style.transition = 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)';
            await waitForTransformEnd(sc.incomingPanel, 300);

            const live = document.getElementById('timelineContainer') || newTc;
            teardownScaffold(live);
            clearSwipeInlineStyles(live);
        } finally {
            isAnimating = false;
        }
    };

    const beginSwipe = (clientX, clientY) => {
        if (appState.viewMode !== 'page' || isAnimating) return false;
        if (isSwipeHintPlaying) cancelDailySwipeHint();
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

        currentDragX = deltaX;
        if (shouldPreventDefault && rawEvent) rawEvent.preventDefault();
        if (deltaX === 0 && !scaffold) return;

        const fingerLeft = deltaX < 0;
        if (fingerLeft) {
            const pageDate = new Date(appState.pageDate);
            pageDate.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (pageDate >= today) {
                const tc = getTimelineContainer();
                if (tc && !scaffold) {
                    tc.style.transition = 'none';
                    tc.style.transform = `translate3d(${Math.round(deltaX * 0.25)}px, 0, 0)`;
                }
                return;
            }
        }
        ensureScaffold(fingerLeft, deltaX);
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

        // 손가락 왼쪽 → 다음날(+1), 오른쪽 → 전날(-1)
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

    swipeListenRoot.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        if (!canStartDailySwipe(e.target)) return;
        beginSwipe(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    swipeListenRoot.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        moveSwipe(e.touches[0].clientX, e.touches[0].clientY, true, e);
    }, { passive: false });

    swipeListenRoot.addEventListener('touchend', () => {
        endSwipe();
    }, { passive: true });

    swipeListenRoot.addEventListener('touchcancel', () => {
        cancelSwipe();
    }, { passive: true });

    // 웹(데스크톱) 테스트용: 마우스 드래그로 스와이프 제스처 시뮬레이션
    // pointerdown 직후 setPointerCapture 하면 카드 클릭이 막히므로, 가로 축 확정 후에만 캡처
    let mouseSwipeCaptureActive = false;
    let mouseSwipePointerId = null;
    let mouseSwipeCaptureEl = null;

    swipeListenRoot.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (!canStartDailySwipe(e.target)) return;
        mouseSwipeCaptureActive = false;
        mouseSwipePointerId = null;
        mouseSwipeCaptureEl = null;
        if (!beginSwipe(e.clientX, e.clientY)) return;
        mouseSwipePointerId = e.pointerId;
    });

    swipeListenRoot.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        if (mouseSwipePointerId != null && e.pointerId !== mouseSwipePointerId) return;
        moveSwipe(e.clientX, e.clientY, true, e);
        if (
            tracking &&
            horizontalLocked === true &&
            !mouseSwipeCaptureActive &&
            mouseSwipePointerId != null
        ) {
            mouseSwipeCaptureActive = true;
            mouseSwipeCaptureEl = tv;
            try {
                tv.setPointerCapture?.(mouseSwipePointerId);
            } catch (_) {}
        }
    });

    swipeListenRoot.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'mouse') return;
        if (mouseSwipeCaptureActive && mouseSwipeCaptureEl) {
            try {
                mouseSwipeCaptureEl.releasePointerCapture?.(e.pointerId);
            } catch (_) {}
        }
        mouseSwipeCaptureActive = false;
        mouseSwipePointerId = null;
        mouseSwipeCaptureEl = null;
        endSwipe();
    });

    swipeListenRoot.addEventListener('pointercancel', (e) => {
        if (e.pointerType !== 'mouse') return;
        if (mouseSwipeCaptureActive && mouseSwipeCaptureEl) {
            try {
                mouseSwipeCaptureEl.releasePointerCapture?.(e.pointerId);
            } catch (_) {}
        }
        mouseSwipeCaptureActive = false;
        mouseSwipePointerId = null;
        mouseSwipeCaptureEl = null;
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

// Google Play 인앱 업데이트 확인 (Android 네이티브 전용)
try {
    initAppUpdate();
} catch (e) {
    console.debug('인앱 업데이트 초기화 실패(무시):', e);
}

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
