/**
 * Soft Mint Center Dialog — 상단 핸들 아래로 스와이프(드래그)해 닫기
 * @param {{
 *   root?: HTMLElement|null,
 *   panel: HTMLElement|null,
 *   grabber?: HTMLElement|null,
 *   onClose: () => void,
 *   isDisabled?: () => boolean,
 *   threshold?: number
 * }} opts
 * @returns {{ reset: () => void }|null}
 */
export function bindDialogGrabberPullClose(opts) {
    const panel = opts?.panel;
    const onClose = opts?.onClose;
    if (!panel || typeof onClose !== 'function') return null;

    const grabber =
        opts.grabber ||
        panel.querySelector('.mealog-dialog-grabber, .entry-modal-grabber') ||
        opts.root?.querySelector?.('.mealog-dialog-grabber, .entry-modal-grabber');
    if (!grabber) return null;

    const root = opts.root || panel.closest('[id$="Modal"], [id$="Popup"]') || panel.parentElement;
    if (grabber.dataset.mealogGrabberBound === '1') {
        return {
            reset: () => {
                panel.style.transform = '';
                panel.style.transition = '';
            }
        };
    }
    grabber.dataset.mealogGrabberBound = '1';

    const threshold = Number(opts.threshold) > 0 ? Number(opts.threshold) : 80;
    const isDisabled = typeof opts.isDisabled === 'function' ? opts.isDisabled : () => false;

    let startY = 0;
    let dragY = 0;
    let tracking = false;
    let pointerId = null;

    const reset = () => {
        panel.style.transform = '';
        panel.style.transition = '';
    };

    const onPointerDown = (e) => {
        if (root?.classList?.contains('hidden') || isDisabled()) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        tracking = true;
        pointerId = e.pointerId;
        startY = e.clientY;
        dragY = 0;
        try {
            grabber.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    };

    const onPointerMove = (e) => {
        if (!tracking || e.pointerId !== pointerId) return;
        dragY = Math.max(0, e.clientY - startY);
        panel.style.transition = 'none';
        panel.style.transform = `translate3d(0, ${dragY}px, 0)`;
        if (dragY > 0) e.preventDefault();
    };

    const onPointerEnd = (e) => {
        if (!tracking || (e && e.pointerId !== pointerId)) return;
        tracking = false;
        pointerId = null;
        if (dragY >= threshold) {
            reset();
            onClose();
            return;
        }
        panel.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
        panel.style.transform = 'translate3d(0, 0, 0)';
        const clear = () => {
            panel.removeEventListener('transitionend', clear);
            reset();
        };
        panel.addEventListener('transitionend', clear, { once: true });
        setTimeout(clear, 280);
    };

    grabber.addEventListener('pointerdown', onPointerDown);
    grabber.addEventListener('pointermove', onPointerMove, { passive: false });
    grabber.addEventListener('pointerup', onPointerEnd);
    grabber.addEventListener('pointercancel', onPointerEnd);
    grabber.addEventListener('keydown', (e) => {
        if (root?.classList?.contains('hidden') || isDisabled()) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onClose();
    });

    if (root) {
        root.resetGrabberPullTransform = reset;
    }
    panel.resetGrabberPullTransform = reset;

    return { reset };
}

/**
 * 여러 센터 팝업에 grabber를 한 번에 연결
 * @param {Array<{ rootId: string, panelSelector?: string, onClose: () => void, isDisabled?: () => boolean }>} specs
 */
export function bindCenterDialogGrabbers(specs) {
    if (!Array.isArray(specs)) return;
    specs.forEach((spec) => {
        const root = document.getElementById(spec.rootId);
        if (!root) return;
        const panel =
            (spec.panelSelector ? root.querySelector(spec.panelSelector) : null) ||
            root.querySelector(
                '.mealog-dialog-panel, .search-filter-modal__panel, .notification-modal, .diet-report-modal, .entry-modal-panel, .entry-slot-picker, .tracker-month-calendar-panel, [data-mealog-dialog-panel]'
            ) ||
            root.querySelector(':scope > div:not(.absolute)');
        bindDialogGrabberPullClose({
            root,
            panel,
            onClose: spec.onClose,
            isDisabled: spec.isDisabled
        });
    });
}
