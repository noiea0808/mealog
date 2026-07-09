/**
 * 메인 앱 DOM 이벤트 바인딩 (랜딩·설정·탭·밀톡·키보드 등)
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { addCompositionAwareInput, setupBirthdateInputFormatting } from '../utils.js';
import {
    handleGoogleLogin,
    handleKakaoLogin,
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
import { registerEscapeCloseModals } from './escape-close-modals.js';
import { bindMealSyncResendNavButtonOnce } from './meal-sync-resend-header.js';
import { triggerQuickEntryFromFab } from '../modals/entry-quick-open.js';
import { openRecordCameraPicker, openRecordGalleryPicker } from '../modals/entry-and-core.js';
import { openDailyJournalCameraPicker, openDailyJournalGalleryPicker } from '../modals/daily-journal.js';
import { kakaoTalkLogoSvgHtml } from '../utils/kakao-brand.js';
import {
    registerDemoNavGuideHandlers,
    handleDemoAwareNavClick,
    showPendingDemoGuide,
    tryCloseDemoNavGuideFromBack
} from '../demo-nav-guide.js';
import { setupGalleryPullToRefresh } from './gallery-pull-refresh.js';
import { ensureMomentImageLightbox } from './moment-image-lightbox.js';
import {
    openSettings,
    switchSettingsTab,
    saveProfileSettings,
    initPushPreferencesControlsOnce,
    saveProfileSingleField,
    cancelInlineProfileFieldEdit
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

    const kakaoLoginBtn = document.getElementById('kakaoLoginBtn');
    if (kakaoLoginBtn) {
        if (!kakaoLoginBtn.querySelector('[data-kakao-brand-logo]')) {
            kakaoLoginBtn.insertAdjacentHTML(
                'afterbegin',
                kakaoTalkLogoSvgHtml({ className: 'w-[22px] h-[22px]' })
            );
        }
        kakaoLoginBtn.addEventListener('click', handleKakaoLogin);
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
        const PRESS_CLASS = 'btn-is-pressed';
        let lastRun = 0;
        const runOnce = (fn) => {
            const now = Date.now();
            if (now - lastRun < SUBMIT_DEBOUNCE_MS) return;
            lastRun = now;
            fn();
        };
        const bindPressFeedback = (el) => {
            if (!el || el.dataset.pressFeedbackBound === '1') return null;
            el.dataset.pressFeedbackBound = '1';
            const MIN_PRESS_MS = 90;
            let pressStartedAt = 0;
            let pressReleaseTimer = null;
            const pressOn = () => {
                if (!el.disabled) {
                    clearTimeout(pressReleaseTimer);
                    pressStartedAt = Date.now();
                    el.classList.add(PRESS_CLASS);
                }
            };
            const pressOff = () => {
                const elapsed = Date.now() - pressStartedAt;
                const delay = Math.max(0, MIN_PRESS_MS - elapsed);
                clearTimeout(pressReleaseTimer);
                pressReleaseTimer = setTimeout(() => {
                    el.classList.remove(PRESS_CLASS);
                }, delay);
            };
            el.addEventListener('mousedown', pressOn);
            el.addEventListener('mouseup', pressOff);
            el.addEventListener('mouseleave', pressOff);
            el.addEventListener('touchstart', pressOn, { passive: true });
            el.addEventListener('touchend', pressOff, { passive: true });
            el.addEventListener('touchcancel', pressOff, { passive: true });
            return { pressOn, pressOff };
        };
        const addSubmitHandlers = (el, fn) => {
            if (!el) return;
            const press = bindPressFeedback(el);
            const pressOn = press?.pressOn || (() => {
                if (!el.disabled) el.classList.add(PRESS_CLASS);
            });
            const pressOff = press?.pressOff || (() => el.classList.remove(PRESS_CLASS));
            el.addEventListener('touchstart', (e) => {
                pressOn();
                e.preventDefault();
            }, { passive: false });
            el.addEventListener('touchend', (e) => {
                pressOff();
                e.preventDefault();
                runOnce(fn);
            }, { passive: false });
            el.addEventListener('touchcancel', pressOff);
            el.addEventListener('click', (e) => {
                e.preventDefault();
                pressOff();
                runOnce(fn);
            });
        };
        addSubmitHandlers(document.getElementById('btnSave'), () => window.saveEntry());
        addSubmitHandlers(document.getElementById('sharePhotoIndicator'), () => window.toggleSharePhoto());
        addSubmitHandlers(document.getElementById('photoEditSaveBtn'), () => window.savePhotoEdit());
        bindPressFeedback(document.getElementById('btnDelete'));
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
    ensureMomentImageLightbox();

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

    const accountEditBioBtn = document.getElementById('accountEditBioBtn');
    if (accountEditBioBtn) {
        accountEditBioBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof window.activateAccountFieldEdit === 'function') window.activateAccountFieldEdit('bio');
        });
    }
    document.getElementById('accountBioSaveBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        void saveProfileSingleField('bio');
    });
    document.getElementById('accountBioCancelBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        cancelInlineProfileFieldEdit();
    });
    const accountEditLifestyleBtn = document.getElementById('accountEditLifestyleBtn');
    if (accountEditLifestyleBtn) {
        accountEditLifestyleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (typeof window.activateAccountFieldEdit === 'function') window.activateAccountFieldEdit('lifestyle');
        });
    }
    document.getElementById('accountLifestyleSaveBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        void saveProfileSingleField('lifestyle');
    });
    document.getElementById('accountLifestyleCancelBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        cancelInlineProfileFieldEdit();
    });

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
            if (!appState.isProfileEditing || appState.profileEditScope !== 'full') {
                showToast('프로필 사진은 계정 영역에서 사진을 눌러 전체 편집으로 변경할 수 있습니다.', 'info');
                return;
            }
            document.getElementById('photoInput')?.click();
        });
    }

    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = appState.profileEditScope;
            if (!appState.isProfileEditing || (s !== 'full' && s !== 'lifestyle')) {
                showToast('라이프 스타일 연필을 눌러 수정한 뒤 선택할 수 있습니다.', 'info');
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
            const s = appState.profileEditScope;
            if (!appState.isProfileEditing || (s !== 'full' && s !== 'birthdate')) {
                showToast('생년월일 연필을 눌러 수정한 뒤 선택할 수 있습니다.', 'info');
                return;
            }
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('settingGender');
            if (hidden) hidden.value = v;
            if (typeof window.syncSettingsGenderButtonsUI === 'function') {
                window.syncSettingsGenderButtonsUI();
            }
            if (typeof window.syncAccountCardFromProfileFields === 'function') {
                window.syncAccountCardFromProfileFields();
            }
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
                if ((e.target.files || []).length > canAdd && canAdd === 0) showToast('사진은 최대 5장까지 추가할 수 있습니다.', 'error');
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

    ['best', 'main', 'snack', 'health'].forEach(type => {
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

    bindRecordPhotoSourcePickersOnce();
    bindMealSyncResendNavButtonOnce();

    const entryQuickInputFab = document.getElementById('entryQuickInputFab');
    if (entryQuickInputFab) {
        entryQuickInputFab.addEventListener('click', (e) => {
            e.preventDefault();
            void triggerQuickEntryFromFab(entryQuickInputFab);
        });
    }

    registerEscapeCloseModals();
}

function bindRecordPhotoSourcePickersOnce() {
    if (document.documentElement.dataset.recordPhotoSourcePickersBound === '1') return;
    document.documentElement.dataset.recordPhotoSourcePickersBound = '1';

    const bindPair = (cameraId, albumId, onCamera, onAlbum) => {
        const cameraBtn = document.getElementById(cameraId);
        const albumBtn = document.getElementById(albumId);
        if (cameraBtn) {
            cameraBtn.addEventListener('click', () => {
                if (cameraBtn.disabled) return;
                onCamera();
            });
        }
        if (albumBtn) {
            albumBtn.addEventListener('click', () => {
                if (albumBtn.disabled) return;
                onAlbum();
            });
        }
    };

    bindPair('imageCameraBtn', 'imageAlbumBtn', () => openRecordCameraPicker(false), () =>
        openRecordGalleryPicker(false)
    );
    bindPair('snackImageCameraBtn', 'snackImageAlbumBtn', () => openRecordCameraPicker(true), () =>
        openRecordGalleryPicker(true)
    );
    bindPair('dailyJournalCameraBtn', 'dailyJournalAlbumBtn', openDailyJournalCameraPicker, openDailyJournalGalleryPicker);
}
