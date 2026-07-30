/**
 * Escape 키로 최상단 오버레이(모달·팝업)를 닫는다.
 * z-index가 같으면 DOM 순서상 나중 요소를 위로 본다.
 * 약관 동의(termsModal)는 「취소=로그아웃」과 혼동될 수 있어 ESC로 닫지 않는다.
 */
import { appState } from '../state.js';
import { dismissSuccessPopup, closeAttendancePopup } from '../ui.js';
import {
    closeEmailModal,
    closePasswordResetConfirmModal,
    closePasswordResetSuccessModal,
    closeDomainModal,
    closeProfileSetupModal,
    cancelDeleteAccount
} from '../auth.js';
import { closeModal } from '../modals/entry-and-core.js';
import { closeEntrySlotPicker } from '../modals/entry-slot-picker.js';
import { closeDailyJournalModal } from '../modals/daily-journal.js';
import { closeSettings } from '../modals/settings.js';
import { closeDietReportModal } from '../modals/diet-report.js';
import { closeSignupWizard } from '../signup-wizard.js';
import { dismissDemoIntroModal } from '../demo-account.js';
import { closePwaInstallGuideModal, closeDesktopShortcutGuideModal } from '../pwa-install.js';
import { tryCloseDemoNavGuideFromBack } from '../demo-nav-guide.js';
import { closeMomentImageLightbox } from './moment-image-lightbox.js';

/** termsModal 제외 — 동적 생성 kakaoPlaceSearchModal·dailySharePreviewModal 등 포함 */
const ESCAPE_OVERLAY_IDS = [
    'successPopup',
    'attendancePopup',
    'serviceGuideOverlay',
    'signupWizard',
    'domainErrorModal',
    'profileSetupModal',
    'demoIntroModal',
    'pwaInstallGuideModal',
    'desktopShortcutGuideModal',
    'trackerMonthCalendarModal',
    'timelineSearchModal',
    'momentSearchModal',
    'boardSearchModal',
    'notificationModal',
    'contentPopupModal',
    'bestSharePeriodNoticeModal',
    'passwordResetSuccessModal',
    'passwordResetConfirmModal',
    'kakaoPlaceSearchModal',
    'characterSelectPopup',
    'characterSelectModal',
    'dailySharePreviewModal',
    'dailyCommentModal',
    'bestShareModal',
    'insightShareModal',
    'dietReportModal',
    'profileFieldEditModal',
    'accountAvatarModal',
    'photoEditModal',
    'momentImageLightbox',
    'emailAuthModal',
    'logoutConfirmModal',
    'deleteAccountConfirmModal',
    'detailModal',
    'entryModal',
    'entrySlotPickerModal',
    'dailyJournalModal'
];

function parseZIndex(el) {
    const z = parseInt(getComputedStyle(el).zIndex, 10);
    return Number.isFinite(z) ? z : 0;
}

function isOverlayVisible(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    if (el.classList.contains('hidden')) return false;
    return true;
}

function compareStackOrder(a, b) {
    if (b.z !== a.z) return b.z - a.z;
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return -1;
    return 0;
}

function closeOverlayById(id) {
    switch (id) {
        case 'successPopup':
            dismissSuccessPopup();
            break;
        case 'attendancePopup':
            closeAttendancePopup();
            break;
        case 'serviceGuideOverlay':
            // ESC = 건너뛰기와 동일하게 완료 처리하지 않고 닫기만 하면 플래그가 안 남을 수 있음
            // 건너뛰기와 동일하게 finish는 onboardingSkip 경로를 쓰도록 클릭 트리거
            document.getElementById('serviceGuideSkipBtn')?.click();
            break;
        case 'signupWizard':
            closeSignupWizard();
            break;
        case 'domainErrorModal':
            closeDomainModal();
            break;
        case 'profileSetupModal':
            closeProfileSetupModal();
            break;
        case 'demoIntroModal':
            dismissDemoIntroModal();
            break;
        case 'pwaInstallGuideModal':
            closePwaInstallGuideModal();
            break;
        case 'desktopShortcutGuideModal':
            closeDesktopShortcutGuideModal();
            break;
        case 'trackerMonthCalendarModal':
            document.getElementById('trackerMonthCalendarModal')?.classList.add('hidden');
            break;
        case 'timelineSearchModal':
            if (typeof window.closeTimelineSearchModal === 'function') window.closeTimelineSearchModal();
            break;
        case 'momentSearchModal':
            if (typeof window.closeMomentSearchModal === 'function') window.closeMomentSearchModal();
            break;
        case 'boardSearchModal':
            if (typeof window.closeBoardSearchModal === 'function') window.closeBoardSearchModal();
            break;
        case 'notificationModal':
            if (typeof window.closeNotificationPopup === 'function') window.closeNotificationPopup();
            break;
        case 'contentPopupModal':
            if (typeof window.closeContentPopupModal === 'function') window.closeContentPopupModal(false);
            break;
        case 'bestSharePeriodNoticeModal':
            if (typeof window.closeBestSharePeriodNotice === 'function') {
                void window.closeBestSharePeriodNotice();
            } else {
                document.getElementById('bestSharePeriodNoticeModal')?.classList.add('hidden');
            }
            break;
        case 'passwordResetSuccessModal':
            closePasswordResetSuccessModal();
            break;
        case 'passwordResetConfirmModal':
            closePasswordResetConfirmModal();
            break;
        case 'kakaoPlaceSearchModal':
            document.getElementById('kakaoPlaceSearchModal')?.remove();
            break;
        case 'characterSelectPopup':
        case 'characterSelectModal':
            if (typeof window.closeCharacterSelectModal === 'function') {
                void window.closeCharacterSelectModal();
            } else {
                document.getElementById(id)?.classList.add('hidden');
            }
            break;
        case 'dailySharePreviewModal':
            if (typeof window.closeDailySharePreviewModal === 'function') {
                window.closeDailySharePreviewModal();
            } else {
                document.getElementById('dailySharePreviewModal')?.remove();
            }
            break;
        case 'dailyCommentModal':
            if (typeof window.closeDailyCommentModal === 'function') {
                window.closeDailyCommentModal();
            } else {
                document.getElementById('dailyCommentModal')?.remove();
            }
            break;
        case 'bestShareModal':
            if (typeof window.closeShareBestModal === 'function') {
                void window.closeShareBestModal();
            } else {
                document.getElementById('bestShareModal')?.classList.add('hidden');
            }
            break;
        case 'insightShareModal':
            if (typeof window.closeShareInsightModal === 'function') {
                void window.closeShareInsightModal();
            } else {
                document.getElementById('insightShareModal')?.classList.add('hidden');
            }
            break;
        case 'dietReportModal':
            closeDietReportModal();
            break;
        case 'profileFieldEditModal':
            if (typeof window.closeProfileFieldEditModal === 'function') {
                window.closeProfileFieldEditModal();
            } else {
                document.getElementById('profileFieldEditModal')?.classList.add('hidden');
            }
            break;
        case 'accountAvatarModal':
            if (typeof window.tryCloseAccountAvatarModalOrCancelInlineEdit === 'function') {
                window.tryCloseAccountAvatarModalOrCancelInlineEdit();
            }
            break;
        case 'photoEditModal':
            if (typeof window.closePhotoEditModal === 'function') window.closePhotoEditModal();
            break;
        case 'momentImageLightbox':
            closeMomentImageLightbox();
            break;
        case 'emailAuthModal':
            closeEmailModal();
            break;
        case 'logoutConfirmModal':
            document.getElementById('logoutConfirmModal')?.classList.add('hidden');
            break;
        case 'deleteAccountConfirmModal':
            cancelDeleteAccount();
            break;
        case 'detailModal':
            if (typeof window.closeDetailModal === 'function') {
                void window.closeDetailModal();
            } else {
                document.getElementById('detailModal')?.classList.add('hidden');
            }
            break;
        case 'entryModal':
            closeModal();
            break;
        case 'entrySlotPickerModal':
            closeEntrySlotPicker();
            break;
        case 'dailyJournalModal':
            closeDailyJournalModal();
            break;
        default:
            break;
    }
}

function onDocumentEscape(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;

    const open = ESCAPE_OVERLAY_IDS.filter(isOverlayVisible).map((id) => ({
        id,
        el: document.getElementById(id),
        z: parseZIndex(document.getElementById(id))
    }));

    if (open.length) {
        open.sort(compareStackOrder);
        e.preventDefault();
        e.stopPropagation();
        closeOverlayById(open[0].id);
        return;
    }

    if (tryCloseDemoNavGuideFromBack()) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    if (typeof appState !== 'undefined' && appState.currentTab === 'settings') {
        e.preventDefault();
        e.stopPropagation();
        closeSettings();
    }
}

let registered = false;

export function registerEscapeCloseModals() {
    if (registered) return;
    registered = true;
    document.addEventListener('keydown', onDocumentEscape, true);
}
