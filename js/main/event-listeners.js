/**
 * 메인 앱 DOM 이벤트 바인딩 (랜딩·설정·탭·밀톡·키보드 등)
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { addCompositionAwareInput, setupBirthdateInputFormatting } from '../utils.js';
import {
    handleGoogleLogin,
    startGuest,
    openEmailModal,
    closeEmailModal,
    handleEmailAuth,
    requestPasswordReset,
    sendPasswordResetAfterConfirm,
    closePasswordResetConfirmModal,
    closePasswordResetSuccessModal,
    toggleEmailAuthMode,
    copyDomain,
    closeDomainModal,
    showTermsDetail,
    cancelTermsAgreement,
    confirmTermsAgreement,
    setProfileType,
    handleSetupPhotoUpload,
    handleEmailSignupWithProfile,
    confirmProfileSetup,
    continueAsGuestFromProfileSetup,
    cancelDeleteAccount,
    confirmDeleteAccountAction,
    confirmLogoutAction
} from '../auth.js';
import { registerDemoIntroModalHandlers } from '../demo-account.js';
import {
    registerDemoNavGuideHandlers,
    handleDemoAwareNavClick,
    showPendingDemoGuide,
    tryCloseDemoNavGuideFromBack
} from '../demo-nav-guide.js';
import { setupGalleryPullToRefresh } from './gallery-pull-refresh.js';
import {
    openSettings,
    switchSettingsTab,
    saveProfileSettings,
    initPushPreferencesControlsOnce
} from '../modals.js';

/** 앱 전체: 키보드 열림 시 하단 네비 숨김 + 닫힘 시 복귀 (viewport 기반 keyboard-closed) */
function initMainAppKeyboardHandling() {
    const mainApp = document.getElementById('mainApp');
    if (!mainApp) return;

    const setKeyboardClosed = (closed) => {
        document.body.classList.toggle('keyboard-closed', closed);
    };

    const checkViewport = () => {
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const threshold = window.innerHeight * 0.85;
        setKeyboardClosed(vh >= threshold);
    };

    const isInputLike = (el) =>
        el &&
        (el.matches?.('input:not(.push-pref-toggle), textarea') || el.getAttribute?.('contenteditable') === 'true');

    if (window.visualViewport) {
        const run = () => {
            [0, 100, 250, 400, 600, 1000].forEach(ms => setTimeout(checkViewport, ms));
        };
        window.visualViewport.addEventListener('resize', run);
        window.visualViewport.addEventListener('scroll', run);
    }
    window.addEventListener('resize', checkViewport);
    checkViewport();

    let keyboardCheckInterval = null;
    document.addEventListener('focusin', (e) => {
        if (!isInputLike(e.target)) return;
        if (keyboardCheckInterval) clearInterval(keyboardCheckInterval);
        const start = Date.now();
        keyboardCheckInterval = setInterval(() => {
            checkViewport();
            const vh = window.visualViewport?.height ?? window.innerHeight;
            if (vh >= window.innerHeight * 0.85 || Date.now() - start > 10000) {
                clearInterval(keyboardCheckInterval);
                keyboardCheckInterval = null;
            }
        }, 150);
    });
    document.addEventListener('focusout', (e) => {
        if (!isInputLike(e.target)) return;
        if (keyboardCheckInterval) { clearInterval(keyboardCheckInterval); keyboardCheckInterval = null; }
        [100, 300, 500, 800].forEach(ms => setTimeout(checkViewport, ms));
    });

    if (window.Capacitor?.isNativePlatform?.()) {
        const App = window.Capacitor?.Plugins?.App;
        if (App && typeof App.addListener === 'function') {
            App.addListener('backButton', ({ canGoBack }) => {
                if (tryCloseDemoNavGuideFromBack()) return;
                const entryModal = document.getElementById('entryModal');
                if (entryModal && !entryModal.classList.contains('hidden')) {
                    if (typeof window.closeModal === 'function') window.closeModal();
                    return;
                }
                const boardDetailView = document.getElementById('boardDetailView');
                if (appState.currentTab === 'board' && boardDetailView && !boardDetailView.classList.contains('hidden')) {
                    if (typeof window.backToBoardList === 'function') window.backToBoardList();
                    return;
                }
                const active = document.activeElement;
                if (isInputLike(active)) {
                    active.blur();
                    setKeyboardClosed(true);
                } else if (canGoBack) {
                    window.history.back();
                } else if (typeof App.exitApp === 'function') {
                    App.exitApp();
                }
            });
        }
    }
}

export function initEventListeners() {
    registerDemoIntroModalHandlers();
    registerDemoNavGuideHandlers();

    const apkDownloadSection = document.getElementById('apkDownloadSection');
    if (apkDownloadSection && window.Capacitor?.isNativePlatform?.()) {
        apkDownloadSection.style.display = 'none';
    }

    const googleLoginBtn = document.getElementById('googleLoginBtn');
    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', handleGoogleLogin);
    }

    const emailLoginBtn = document.getElementById('emailLoginBtn');
    if (emailLoginBtn) {
        emailLoginBtn.addEventListener('click', () => openEmailModal());
    }
    const emailSignupLink = document.getElementById('emailSignupLink');
    if (emailSignupLink) {
        emailSignupLink.addEventListener('click', () => openEmailModal('signup'));
    }

    const guestLoginBtn = document.getElementById('guestLoginBtn');
    if (guestLoginBtn) {
        guestLoginBtn.addEventListener('click', startGuest);
    }
    const emailAuthCloseBtn = document.getElementById('emailAuthCloseBtn');
    if (emailAuthCloseBtn) {
        emailAuthCloseBtn.addEventListener('click', closeEmailModal);
    }

    const emailAuthBtn = document.getElementById('emailAuthBtn');
    if (emailAuthBtn) {
        const runEmailAuth = (e) => {
            e.preventDefault();
            handleEmailAuth();
        };
        emailAuthBtn.addEventListener('click', runEmailAuth);
        emailAuthBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                runEmailAuth(e);
            }
        });
    }
    const emailPasswordResetLink = document.getElementById('emailPasswordResetLink');
    if (emailPasswordResetLink) {
        emailPasswordResetLink.addEventListener('click', requestPasswordReset);
    }
    const passwordResetConfirmCancelBtn = document.getElementById('passwordResetConfirmCancelBtn');
    if (passwordResetConfirmCancelBtn) {
        passwordResetConfirmCancelBtn.addEventListener('click', closePasswordResetConfirmModal);
    }
    const passwordResetConfirmSendBtn = document.getElementById('passwordResetConfirmSendBtn');
    if (passwordResetConfirmSendBtn) {
        passwordResetConfirmSendBtn.addEventListener('click', () => {
            sendPasswordResetAfterConfirm();
        });
    }
    const passwordResetSuccessOkBtn = document.getElementById('passwordResetSuccessOkBtn');
    if (passwordResetSuccessOkBtn) {
        passwordResetSuccessOkBtn.addEventListener('click', closePasswordResetSuccessModal);
    }

    const emailAuthToggleBtn = document.getElementById('emailAuthToggleBtn');
    if (emailAuthToggleBtn) {
        emailAuthToggleBtn.addEventListener('click', toggleEmailAuthMode);
    }

    const domainCopyBtn = document.getElementById('domainCopyBtn');
    if (domainCopyBtn) {
        domainCopyBtn.addEventListener('click', copyDomain);
    }

    const domainModalGuestBtn = document.getElementById('domainModalGuestBtn');
    if (domainModalGuestBtn) {
        domainModalGuestBtn.addEventListener('click', () => {
            closeDomainModal();
            startGuest();
        });
    }

    const domainModalCloseBtn = document.getElementById('domainModalCloseBtn');
    if (domainModalCloseBtn) {
        domainModalCloseBtn.addEventListener('click', closeDomainModal);
    }

    const termsDetailBtn = document.getElementById('termsDetailBtn');
    if (termsDetailBtn) {
        termsDetailBtn.addEventListener('click', () => showTermsDetail('terms'));
    }

    const privacyDetailBtn = document.getElementById('privacyDetailBtn');
    if (privacyDetailBtn) {
        privacyDetailBtn.addEventListener('click', () => showTermsDetail('privacy'));
    }

    const termsCancelBtn = document.getElementById('termsCancelBtn');
    if (termsCancelBtn) {
        termsCancelBtn.addEventListener('click', cancelTermsAgreement);
    }

    const termsAgreeBtn = document.getElementById('termsAgreeBtn');
    if (termsAgreeBtn) {
        termsAgreeBtn.addEventListener('click', confirmTermsAgreement);
    }

    const setupBirthdate = document.getElementById('setupBirthdate');
    if (setupBirthdate) setupBirthdateInputFormatting(setupBirthdate);
    const settingBirthdate = document.getElementById('settingBirthdate');
    if (settingBirthdate) setupBirthdateInputFormatting(settingBirthdate);

    const setupProfileTypeEmoji = document.getElementById('setupProfileTypeEmoji');
    if (setupProfileTypeEmoji) {
        setupProfileTypeEmoji.addEventListener('click', () => setProfileType('emoji'));
    }

    const setupProfileTypePhoto = document.getElementById('setupProfileTypePhoto');
    if (setupProfileTypePhoto) {
        setupProfileTypePhoto.addEventListener('click', () => setProfileType('photo'));
    }

    const setupPhotoSelectBtn = document.getElementById('setupPhotoSelectBtn');
    if (setupPhotoSelectBtn) {
        setupPhotoSelectBtn.addEventListener('click', () => {
            document.getElementById('setupPhotoInput')?.click();
        });
    }

    const setupPhotoInput = document.getElementById('setupPhotoInput');
    if (setupPhotoInput) {
        setupPhotoInput.addEventListener('change', (e) => handleSetupPhotoUpload(e));
    }

    const profileSetupBtn = document.getElementById('profileSetupBtn');
    if (profileSetupBtn) {
        profileSetupBtn.addEventListener('click', () => {
            if (window._profileModalMode === 'emailSignup') {
                handleEmailSignupWithProfile();
            } else {
                confirmProfileSetup();
            }
        });
    }
    const profileSetupGuestBtn = document.getElementById('profileSetupGuestBtn');
    if (profileSetupGuestBtn) {
        profileSetupGuestBtn.addEventListener('click', continueAsGuestFromProfileSetup);
    }

    document.querySelectorAll('.setup-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('setupLifestyle');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.setup-lifestyle-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-emerald-600', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('border-emerald-600', active);
                b.classList.toggle('bg-slate-50', !active);
                b.classList.toggle('text-slate-600', !active);
                b.classList.toggle('border-slate-200', !active);
            });
        });
    });

    document.querySelectorAll('.setup-gender-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('setupGender');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.setup-gender-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-emerald-600', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('bg-slate-50', !active);
                b.classList.toggle('text-slate-600', !active);
            });
        });
    });

    const searchTriggerBtn = document.getElementById('searchTriggerBtn');
    if (searchTriggerBtn) {
        searchTriggerBtn.addEventListener('click', window.toggleSearch);
    }
    const searchInput = document.getElementById('searchInput');
    if (searchInput && !searchInput._searchCompositionInit) {
        addCompositionAwareInput(searchInput, () => {
            window.handleSearch(searchInput.value);
        });
        searchInput._searchCompositionInit = true;
    }

    const notificationTriggerBtn = document.getElementById('notificationTriggerBtn');
    if (notificationTriggerBtn) {
        notificationTriggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.toggleNotificationPopup();
        });
    }

    const headerDemoLoginBtn = document.getElementById('headerDemoLoginBtn');
    if (headerDemoLoginBtn) {
        headerDemoLoginBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                if (typeof window.switchToLogin === 'function') {
                    await window.switchToLogin();
                } else {
                    showToast('로그인 기능을 사용할 수 없습니다.', 'error');
                }
            } catch (err) {
                console.error('headerDemoLoginBtn:', err);
                showToast('로그인 화면으로 이동하지 못했습니다.', 'error');
            }
        });
    }
    document.addEventListener('click', () => {
        if (typeof window.closeNotificationPopup === 'function') window.closeNotificationPopup();
    });
    const notificationPopup = document.getElementById('notificationPopup');
    if (notificationPopup) {
        notificationPopup.addEventListener('click', (e) => e.stopPropagation());
    }

    const galleryTraceFilterPanel = document.getElementById('galleryTraceFilterPanel');
    if (galleryTraceFilterPanel) {
        galleryTraceFilterPanel.addEventListener('click', (e) => {
            const btn = e.target.closest('.gallery-trace-btn');
            if (!btn) return;
            const v = btn.getAttribute('data-trace');
            if (v === 'collapse') {
                window.toggleGalleryTracePanel();
                return;
            }
            window.setGalleryTraceFilter(v);
        });
    }

    const btnViewList = document.getElementById('btn-view-list');
    if (btnViewList) {
        btnViewList.addEventListener('click', () => window.setViewMode('list'));
    }

    const btnViewPage = document.getElementById('btn-view-page');
    if (btnViewPage) {
        btnViewPage.addEventListener('click', () => window.setViewMode('page'));
    }

    initMainAppKeyboardHandling();

    (function initSubmitButtonFirstTap() {
        const SUBMIT_DEBOUNCE_MS = 500;
        let lastRun = 0;
        const runOnce = (fn) => {
            const now = Date.now();
            if (now - lastRun < SUBMIT_DEBOUNCE_MS) return;
            lastRun = now;
            fn();
        };
        const addSubmitHandlers = (el, fn) => {
            if (!el) return;
            el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
            el.addEventListener('touchend', (e) => { e.preventDefault(); runOnce(fn); }, { passive: false });
            el.addEventListener('click', (e) => { e.preventDefault(); runOnce(fn); });
        };
        addSubmitHandlers(document.getElementById('btnSave'), () => window.saveEntry());
        addSubmitHandlers(document.getElementById('boardWriteSubmitBtn') || document.querySelector('#boardWriteView button[id="boardWriteSubmitBtn"]'), () => window.submitBoardPost());
    })();

    const navDashboard = document.getElementById('nav-dashboard');
    if (navDashboard) {
        navDashboard.addEventListener('click', () => {
            handleDemoAwareNavClick('dashboard');
            window.switchMainTab('dashboard');
            showPendingDemoGuide();
        });
    }

    const navTimeline = document.getElementById('nav-timeline');
    if (navTimeline) {
        navTimeline.addEventListener('click', () => {
            handleDemoAwareNavClick('timeline');
            window.switchMainTab('timeline');
            showPendingDemoGuide();
        });
    }

    const navGallery = document.getElementById('nav-gallery');
    if (navGallery) {
        navGallery.addEventListener('click', () => {
            handleDemoAwareNavClick('gallery');
            window.switchMainTab('gallery');
            showPendingDemoGuide();
        });
    }
    setupGalleryPullToRefresh();

    const navBoard = document.getElementById('nav-board');
    if (navBoard) {
        navBoard.addEventListener('click', () => {
            handleDemoAwareNavClick('board');
            window.switchMainTab('board');
            showPendingDemoGuide();
        });
    }

    const navSettings = document.getElementById('nav-settings');
    if (navSettings) {
        navSettings.addEventListener('click', () => {
            handleDemoAwareNavClick('settings');
            if (typeof openSettings === 'function') openSettings();
            else if (typeof window.switchMainTab === 'function') window.switchMainTab('settings');
            showPendingDemoGuide();
        });
    }

    const settingsTabProfile = document.getElementById('settingsTabProfile');
    if (settingsTabProfile) {
        settingsTabProfile.addEventListener('click', () => window.switchSettingsTab('profile'));
    }

    const settingsTabTags = document.getElementById('settingsTabTags');
    if (settingsTabTags) {
        settingsTabTags.addEventListener('click', () => window.switchSettingsTab('tags'));
    }

    const settingsTabShortcuts = document.getElementById('settingsTabShortcuts');
    if (settingsTabShortcuts) {
        settingsTabShortcuts.addEventListener('click', () => window.switchSettingsTab('shortcuts'));
    }

    const settingsTabNotifications = document.getElementById('settingsTabNotifications');
    if (settingsTabNotifications) {
        settingsTabNotifications.addEventListener('click', () => window.switchSettingsTab('notifications'));
    }

    initPushPreferencesControlsOnce();

    const saveProfileSettingsBtn = document.getElementById('saveProfileSettingsBtn');
    if (saveProfileSettingsBtn) {
        saveProfileSettingsBtn.addEventListener('click', saveProfileSettings);
    }

    const openMyPostsFromSettingsBtn = document.getElementById('openMyPostsFromSettingsBtn');
    if (openMyPostsFromSettingsBtn) {
        openMyPostsFromSettingsBtn.addEventListener('click', () => {
            if (typeof window.openMyPostsFromSettings === 'function') window.openMyPostsFromSettings();
        });
    }

    const editProfileSettingsBtn = document.getElementById('editProfileSettingsBtn');
    if (editProfileSettingsBtn) {
        editProfileSettingsBtn.addEventListener('click', () => window.startProfileSettingsEdit?.());
    }

    const cancelProfileSettingsBtn = document.getElementById('cancelProfileSettingsBtn');
    if (cancelProfileSettingsBtn) {
        cancelProfileSettingsBtn.addEventListener('click', () => window.cancelProfileSettingsEdit?.());
    }

    const profileTypeEmoji = document.getElementById('profileTypeEmoji');
    if (profileTypeEmoji) {
        profileTypeEmoji.addEventListener('click', () => window.setSettingsProfileType('emoji'));
    }

    const profileTypePhoto = document.getElementById('profileTypePhoto');
    if (profileTypePhoto) {
        profileTypePhoto.addEventListener('click', () => window.setSettingsProfileType('photo'));
    }

    const profileTypeText = document.getElementById('profileTypeText');
    if (profileTypeText) {
        profileTypeText.addEventListener('click', () => window.setSettingsProfileType('text'));
    }

    const photoSelectBtn = document.getElementById('photoSelectBtn');
    if (photoSelectBtn) {
        photoSelectBtn.addEventListener('click', () => {
            if (!appState.isProfileEditing) {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
                return;
            }
            document.getElementById('photoInput')?.click();
        });
    }

    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!appState.isProfileEditing) {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
                return;
            }
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('settingLifestyle');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.settings-lifestyle-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-emerald-600', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('border-emerald-600', active);
                b.classList.toggle('bg-white', !active);
                b.classList.toggle('text-slate-600', !active);
                b.classList.toggle('border-slate-200', !active);
            });
        });
    });
    document.querySelectorAll('.setting-gender-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!appState.isProfileEditing) {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
                return;
            }
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('settingGender');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.setting-gender-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-black', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('bg-slate-50', !active);
                b.classList.toggle('text-slate-600', !active);
            });
        });
    });

    const boardWriteBtn = document.getElementById('boardWriteBtn');
    if (boardWriteBtn) {
        boardWriteBtn.addEventListener('click', window.openBoardWrite);
    }
    document.querySelectorAll('#boardWriteView .format-toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const contentEl = document.getElementById('boardWriteContent');
            if (!contentEl) return;
            contentEl.focus();
            const cmd = btn.getAttribute('data-format');
            if (cmd) document.execCommand(cmd, false, null);
        });
    });
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    if (boardWriteContentEl) {
        const syncPlaceholder = () => {
            const isEmpty = !(boardWriteContentEl.innerText || '').trim();
            boardWriteContentEl.classList.toggle('format-editor-empty', isEmpty);
        };
        addCompositionAwareInput(boardWriteContentEl, syncPlaceholder);
        boardWriteContentEl.addEventListener('blur', syncPlaceholder);
        boardWriteContentEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
        });
    }
    const boardWriteImagesInput = document.getElementById('boardWriteImages');
    const boardWriteAddPhotosBtn = document.getElementById('boardWriteAddPhotosBtn');
    if (boardWriteAddPhotosBtn && boardWriteImagesInput) {
        boardWriteAddPhotosBtn.addEventListener('click', () => boardWriteImagesInput.click());
    }
    if (boardWriteImagesInput) {
        boardWriteImagesInput.addEventListener('change', (e) => {
            const existing = (window.boardWriteExistingUrls || []).length;
            const filesCount = (window.boardWriteFiles || []).length;
            const total = existing + filesCount;
            const canAdd = Math.max(0, 5 - total);
            const files = Array.from(e.target.files || []).slice(0, canAdd);
            if (files.length === 0) {
                if ((e.target.files || []).length > canAdd && canAdd === 0) showToast('사진은 최대 5장까지 추가할 수 있습니다.', 'info');
                e.target.value = '';
                return;
            }
            if (!window.boardWriteFiles) window.boardWriteFiles = [];
            if (!window.boardWriteObjectUrls) window.boardWriteObjectUrls = [];
            files.forEach(f => {
                if (!f.type.startsWith('image/')) return;
                window.boardWriteFiles.push(f);
                window.boardWriteObjectUrls.push(URL.createObjectURL(f));
            });
            if (typeof window.renderBoardWritePreviews === 'function') window.renderBoardWritePreviews();
            e.target.value = '';
        });
    }

    ['all', 'serious', 'chat', 'food', 'admin'].forEach(category => {
        const btn = document.getElementById(`board-category-${category}`);
        if (btn) {
            btn.addEventListener('click', () => window.setBoardCategory(category));
        }
    });

    ['7d', 'week', 'month', 'year', 'custom'].forEach(mode => {
        const btn = document.getElementById(`btn-dash-${mode}`);
        if (btn) {
            btn.addEventListener('click', () => window.setDashboardMode(mode));
        }
    });

    ['best', 'main', 'snack'].forEach(type => {
        const btn = document.getElementById(`btn-analysis-${type}`);
        if (btn) {
            btn.addEventListener('click', () => window.setAnalysisType(type));
        }
    });

    const logoutConfirmCancelBtn = document.getElementById('logoutConfirmCancelBtn');
    if (logoutConfirmCancelBtn) {
        logoutConfirmCancelBtn.addEventListener('click', () => {
            document.getElementById('logoutConfirmModal')?.classList.add('hidden');
        });
    }

    const logoutConfirmActionBtn = document.getElementById('logoutConfirmActionBtn');
    if (logoutConfirmActionBtn) {
        logoutConfirmActionBtn.addEventListener('click', () => {
            console.log('🔐 로그아웃 확인 버튼 클릭됨');
            confirmLogoutAction();
        });
    } else {
        console.error('❌ logoutConfirmActionBtn 요소를 찾을 수 없습니다!');
    }

    const contentPopupDismissTodayBtn = document.getElementById('contentPopupDismissTodayBtn');
    if (contentPopupDismissTodayBtn) {
        contentPopupDismissTodayBtn.addEventListener('click', () => {
            if (typeof window.closeContentPopupModal === 'function') window.closeContentPopupModal(true);
        });
    }
    const contentPopupCloseBtn = document.getElementById('contentPopupCloseBtn');
    if (contentPopupCloseBtn) {
        contentPopupCloseBtn.addEventListener('click', () => {
            if (typeof window.closeContentPopupModal === 'function') window.closeContentPopupModal(false);
        });
    }

    const deleteAccountConfirmCancelBtn = document.getElementById('deleteAccountConfirmCancelBtn');
    if (deleteAccountConfirmCancelBtn) {
        deleteAccountConfirmCancelBtn.addEventListener('click', cancelDeleteAccount);
    }

    const deleteAccountConfirmActionBtn = document.getElementById('deleteAccountConfirmActionBtn');
    if (deleteAccountConfirmActionBtn) {
        deleteAccountConfirmActionBtn.addEventListener('click', confirmDeleteAccountAction);
    }
}
