/**
 * Escape 키로 최상단 오버레이(모달·팝업)를 닫는다.
 * z-index가 같으면 DOM 순서상 나중 요소를 위로 본다.
 * 약관 동의(termsModal)는 「취소=로그아웃」과 혼동될 수 있어 ESC로 닫지 않는다.
 */
import { appState } from '../state.js';
import { hideNetworkErrorOverlay, dismissSuccessPopup, closeAttendancePopup } from '../ui.js';
import {
    closeEmailModal,
    closePasswordResetConfirmModal,
    closePasswordResetSuccessModal,
    closeDomainModal,
    closeProfileSetupModal,
    cancelDeleteAccount
} from '../auth.js';
import { closeModal } from '../modals/entry-and-core.js';
import { closeSettings } from '../modals/settings.js';
import { closeDetailModal } from '../analytics/charts.js';
import { closeCharacterSelectModal, closeShareInsightModal } from '../analytics/insight.js';
import { closeShareBestModal, closeBestSharePeriodNotice } from '../analytics/best-share.js';
import { closeSignupWizard } from '../signup-wizard.js';
import { dismissDemoIntroModal } from '../demo-account.js';
import { tryCloseDemoNavGuideFromBack } from '../demo-nav-guide.js';

/** termsModal 제외 — 동적 생성 kakaoPlaceSearchModal 포함 */
const ESCAPE_OVERLAY_IDS = [
    'networkErrorOverlay',
    'successPopup',
    'attendancePopup',
    'signupWizard',
    'domainErrorModal',
    'profileSetupModal',
    'demoIntroModal',
    'trackerMonthCalendarModal',
    'contentPopupModal',
    'bestSharePeriodNoticeModal',
    'passwordResetSuccessModal',
    'passwordResetConfirmModal',
    'kakaoPlaceSearchModal',
    'characterSelectModal',
    'bestShareModal',
    'insightShareModal',
    'photoEditModal',
    'emailAuthModal',
    'logoutConfirmModal',
    'deleteAccountConfirmModal',
    'detailModal',
    'entryModal'
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
        case 'networkErrorOverlay':
            hideNetworkErrorOverlay();
            break;
        case 'successPopup':
            dismissSuccessPopup();
            break;
        case 'attendancePopup':
            closeAttendancePopup();
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
        case 'trackerMonthCalendarModal':
            document.getElementById('trackerMonthCalendarModal')?.classList.add('hidden');
            break;
        case 'contentPopupModal':
            if (typeof window.closeContentPopupModal === 'function') window.closeContentPopupModal(false);
            break;
        case 'bestSharePeriodNoticeModal':
            closeBestSharePeriodNotice();
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
        case 'characterSelectModal':
            closeCharacterSelectModal();
            break;
        case 'bestShareModal':
            closeShareBestModal();
            break;
        case 'insightShareModal':
            closeShareInsightModal();
            break;
        case 'photoEditModal':
            if (typeof window.closePhotoEditModal === 'function') window.closePhotoEditModal();
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
            closeDetailModal();
            break;
        case 'entryModal':
            closeModal();
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
