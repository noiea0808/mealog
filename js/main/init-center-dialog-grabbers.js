/**
 * Soft Mint Center Dialog — 공통 grabber pull-to-close 일괄 연결
 */
import { bindCenterDialogGrabbers } from '../utils/dialog-grabber.js';

let _bound = false;

function hideById(id) {
    document.getElementById(id)?.classList.add('hidden');
}

export function initCenterDialogGrabbers() {
    if (_bound) return;
    _bound = true;

    bindCenterDialogGrabbers([
        {
            rootId: 'momentSearchModal',
            panelSelector: '.search-filter-modal__panel',
            onClose: () => window.closeMomentSearchModal?.()
        },
        {
            rootId: 'boardSearchModal',
            panelSelector: '.search-filter-modal__panel',
            onClose: () => window.closeBoardSearchModal?.()
        },
        {
            rootId: 'timelineSearchModal',
            panelSelector: '.search-filter-modal__panel',
            onClose: () => window.closeTimelineSearchModal?.()
        },
        {
            rootId: 'notificationModal',
            panelSelector: '.notification-modal',
            onClose: () => window.closeNotificationPopup?.()
        },
        {
            rootId: 'dietReportModal',
            panelSelector: '.diet-report-modal',
            onClose: () => window.closeDietReportModal?.()
        },
        {
            rootId: 'entrySlotPickerModal',
            panelSelector: '.entry-slot-picker',
            onClose: () => window.closeEntrySlotPicker?.()
        },
        {
            rootId: 'trackerMonthCalendarModal',
            panelSelector: '.tracker-month-calendar-panel',
            onClose: () => {
                if (typeof window.closeTrackerMonthCalendar === 'function') {
                    window.closeTrackerMonthCalendar();
                } else {
                    hideById('trackerMonthCalendarModal');
                }
            }
        },
        {
            rootId: 'logoutConfirmModal',
            onClose: () => {
                if (typeof window.closeLogoutConfirmModal === 'function') window.closeLogoutConfirmModal();
                else hideById('logoutConfirmModal');
            }
        },
        {
            rootId: 'deleteAccountConfirmModal',
            onClose: () => {
                if (typeof window.cancelDeleteAccount === 'function') window.cancelDeleteAccount();
                else hideById('deleteAccountConfirmModal');
            }
        },
        {
            rootId: 'passwordResetConfirmModal',
            onClose: () => {
                if (typeof window.closePasswordResetConfirmModal === 'function') {
                    window.closePasswordResetConfirmModal();
                } else {
                    hideById('passwordResetConfirmModal');
                }
            }
        },
        {
            rootId: 'passwordResetSuccessModal',
            onClose: () => {
                if (typeof window.closePasswordResetSuccessModal === 'function') {
                    window.closePasswordResetSuccessModal();
                } else {
                    hideById('passwordResetSuccessModal');
                }
            }
        },
        {
            rootId: 'demoIntroModal',
            onClose: () => {
                if (typeof window.dismissDemoIntroModal === 'function') window.dismissDemoIntroModal();
                else hideById('demoIntroModal');
            }
        },
        {
            rootId: 'emailAuthModal',
            onClose: () => {
                if (typeof window.closeEmailModal === 'function') window.closeEmailModal();
                else hideById('emailAuthModal');
            }
        },
        {
            rootId: 'domainErrorModal',
            onClose: () => {
                if (typeof window.closeDomainModal === 'function') window.closeDomainModal();
                else hideById('domainErrorModal');
            }
        },
        {
            rootId: 'profileSetupModal',
            onClose: () => {
                if (typeof window.closeProfileSetupModal === 'function') window.closeProfileSetupModal();
                else hideById('profileSetupModal');
            }
        },
        {
            rootId: 'contentPopupModal',
            panelSelector: '#contentPopupModalInner',
            onClose: () => {
                if (typeof window.closeContentPopupModal === 'function') window.closeContentPopupModal(false);
                else hideById('contentPopupModal');
            }
        },
        {
            rootId: 'detailModal',
            onClose: () => window.closeDetailModal?.()
        },
        {
            rootId: 'characterSelectPopup',
            onClose: () => {
                if (typeof window.closeCharacterSelectModal === 'function') window.closeCharacterSelectModal();
                else hideById('characterSelectPopup');
            }
        },
        {
            rootId: 'bestShareModal',
            onClose: () => window.closeShareBestModal?.()
        },
        {
            rootId: 'insightShareModal',
            onClose: () => window.closeShareInsightModal?.()
        },
        {
            rootId: 'bestSharePeriodNoticeModal',
            onClose: () => window.closeBestSharePeriodNotice?.()
        },
        {
            rootId: 'photoEditModal',
            onClose: () => {
                if (typeof window.closePhotoEditModal === 'function') window.closePhotoEditModal();
                else hideById('photoEditModal');
            }
        }
    ]);
}
