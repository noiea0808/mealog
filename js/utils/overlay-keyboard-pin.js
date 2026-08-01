/**
 * 검색·알림·프로필·신고·밀톡 수정·모먼트 댓글 시트:
 * IME 중 포커스 스크롤 + (필요 시) 개별 VV 핀.
 *
 * resize(APP): 모달 핀 생략.
 * overlay 웹 + 루트 VV 시프트: 모달 핀 생략(이중 핀 금지), 스크롤만.
 * overlay이지만 루트 시프트 전: 임시 모달 핀 허용.
 */

import {
    isImeInputLike,
    applyOverlayImePin,
    clearOverlayImePinStyles,
    ensureFocusedInputVisible,
    captureImeBaseline,
    shouldTreatImeOpen,
    getImeMetrics,
    isMobileWebTouchUi,
    isWebImeRootShifted,
    onAppImeChange
} from './ime-viewport.js';

const OVERLAY_ROOT_SELECTORS = [
    '#timelineSearchModal',
    '#momentSearchModal',
    '#boardSearchModal',
    '#notificationModal',
    '#profileFieldEditModal',
    '#feedBubbleEditOverlay',
    '#reportModal',
    '#dailyJournalModal',
    '#emailAuthModal',
    '#signupWizard',
    '.moment-v2-social-comments-panel--sheet-in-body'
];

let activeRoot = null;
let syncRaf = null;
let pinTimers = [];
let initialized = false;

function findOverlayRoot(el) {
    if (!el?.closest) return null;
    for (const sel of OVERLAY_ROOT_SELECTORS) {
        const root = el.closest(sel);
        if (root && !root.classList.contains('hidden')) return root;
    }
    return null;
}

function pinLayoutScroll() {
    // 모바일 웹·데스크톱 웹: 브라우저/OS가 입력란으로 팬한 scrollY를 원위치하면 키보드에 가림
    if (!window.Capacitor?.isNativePlatform?.()) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    const de = document.documentElement;
    const body = document.body;
    if (de?.scrollTop) de.scrollTop = 0;
    if (body?.scrollTop) body.scrollTop = 0;
}

/**
 * 프로필 필드 시트: CTA를 스크롤 body로 이동
 * @param {HTMLElement} root
 * @param {boolean} intoBody
 */
function placeProfileFieldEditActions(root, intoBody) {
    if (root?.id !== 'profileFieldEditModal') return;
    const panel = root.querySelector('.profile-field-edit-panel');
    const body = root.querySelector('.profile-field-edit-body');
    const actions = panel?.querySelector('.mealog-dialog-actions');
    if (!panel || !body || !actions) return;
    if (intoBody) {
        if (actions.parentElement !== body) body.appendChild(actions);
        return;
    }
    if (actions.parentElement === body) panel.appendChild(actions);
}

function isSearchFilterModal(root) {
    return !!root?.classList?.contains('search-filter-modal') && root.id !== 'notificationModal';
}

function clearOverlayVvPin(root) {
    if (!root) return;
    placeProfileFieldEditActions(root, false);
    clearOverlayImePinStyles(root);
}

function scrollFocusedInOverlay(root) {
    if (!root) return;
    const ae = document.activeElement;
    if (!isImeInputLike(ae) || !root.contains(ae)) return;
    if (isSearchFilterModal(root)) {
        ensureFocusedInputVisible(ae, {
            align: 'nearest',
            scrollParent: root.querySelector('.search-filter-modal__body'),
            delays: [0, 80, 200, 400]
        });
        return;
    }
    ensureFocusedInputVisible(ae, { align: 'nearest', delays: [0, 80, 200, 400] });
}

function applyOverlayVvPin(root) {
    if (!root) return;
    const m = getImeMetrics();
    const focused =
        isImeInputLike(document.activeElement) && root.contains(document.activeElement);

    // resize 또는 웹 루트 VV 시프트: 개별 모달 핀 생략 — 스크롤·chrome만
    if (m.mode === 'resize' || isWebImeRootShifted() || (m.mode === 'overlay' && document.body?.classList?.contains('ime-open'))) {
        clearOverlayVvPin(root);
        if (focused && (shouldTreatImeOpen() || m.mode === 'overlay')) {
            placeProfileFieldEditActions(root, true);
            requestAnimationFrame(() => scrollFocusedInOverlay(root));
        }
        return;
    }

    pinLayoutScroll();
    const shouldPin = shouldTreatImeOpen() && focused;
    if (!shouldPin) {
        // 루트 시프트 전 전이: 포커스만으로 임시 모달 핀
        if (isMobileWebTouchUi() && focused) {
            placeProfileFieldEditActions(root, true);
            if (applyOverlayImePin(root)) {
                requestAnimationFrame(() => scrollFocusedInOverlay(root));
                return;
            }
        }
        clearOverlayVvPin(root);
        return;
    }
    placeProfileFieldEditActions(root, true);
    applyOverlayImePin(root);
    requestAnimationFrame(() => scrollFocusedInOverlay(root));
}

function clearPinTimers() {
    pinTimers.forEach((id) => clearTimeout(id));
    pinTimers = [];
}

function scheduleSyncBurst() {
    clearPinTimers();
    [0, 50, 120, 250, 400, 700].forEach((ms) => {
        pinTimers.push(
            setTimeout(() => {
                scheduleSync();
                if (activeRoot) scrollFocusedInOverlay(activeRoot);
            }, ms)
        );
    });
}

function scheduleSync() {
    if (syncRaf != null) return;
    syncRaf = requestAnimationFrame(() => {
        syncRaf = null;
        syncOverlayKeyboardPin();
    });
}

function syncOverlayKeyboardPin() {
    const ae = document.activeElement;
    const root = isImeInputLike(ae) ? findOverlayRoot(ae) : null;
    if (!root) {
        if (activeRoot) {
            if (document.contains(activeRoot)) {
                clearOverlayVvPin(activeRoot);
            } else {
                activeRoot.classList?.remove?.('is-ime-open');
            }
            activeRoot = null;
        }
        return;
    }
    if (activeRoot && activeRoot !== root) clearOverlayVvPin(activeRoot);
    activeRoot = root;
    applyOverlayVvPin(root);
}

export function initOverlayKeyboardPin() {
    if (initialized || typeof document === 'undefined') return;
    initialized = true;

    document.addEventListener(
        'focusin',
        (e) => {
            if (!isImeInputLike(e.target) || !findOverlayRoot(e.target)) return;
            captureImeBaseline();
            // overlay(모바일 웹): VV resize 전에도 즉시 동기화
            if (isMobileWebTouchUi() || getImeMetrics().mode === 'overlay') {
                scheduleSync();
            }
            scheduleSyncBurst();
            const root = findOverlayRoot(e.target);
            if (isSearchFilterModal(root)) {
                [50, 150, 320, 500].forEach((ms) => {
                    pinTimers.push(
                        setTimeout(() => {
                            ensureFocusedInputVisible(e.target, {
                                align: 'nearest',
                                scrollParent: root.querySelector('.search-filter-modal__body'),
                                delays: [0]
                            });
                        }, ms)
                    );
                });
            }
        },
        true
    );
    document.addEventListener(
        'focusout',
        (e) => {
            if (!isImeInputLike(e.target)) return;
            clearPinTimers();
            pinTimers.push(setTimeout(() => scheduleSync(), 80));
            pinTimers.push(setTimeout(() => scheduleSync(), 320));
        },
        true
    );

    onAppImeChange(() => {
        scheduleSync();
    });

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSyncBurst, { passive: true });
        window.visualViewport.addEventListener('scroll', scheduleSyncBurst, { passive: true });
    }
    window.addEventListener('resize', scheduleSyncBurst, { passive: true });
}
