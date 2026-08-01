/** 배경 스크롤·휠·터치 차단 (중첩 팝업은 owner Set으로 관리) */
/** @type {Set<string>} */
const lockOwners = new Set();
let savedScrollY = 0;

const SCROLL_ALLOW_SELECTOR =
    '[data-scroll-lock-allow], .attendance-welcome-report-content, .attendance-welcome-chart-viewport';

/** 열린 오버레이 내부 — 팝업 안 터치·제스처는 허용, 배경만 차단 */
const OPEN_OVERLAY_ROOT_SELECTOR = [
    '#successPopup:not(.hidden)',
    '#attendancePopup:not(.hidden)',
    '#timelineMealPhotosOverlay:not(.hidden)',
    '#momentImageLightbox:not(.hidden)',
    '[id$="Modal"]:not(.hidden)',
    '[id$="Popup"]:not(.hidden)'
].join(', ');

function ownerKey(owner) {
    if (owner == null || owner === '') return 'default';
    return String(owner);
}

function isInsideOpenOverlay(target) {
    if (!(target instanceof Element)) return false;
    return !!target.closest(OPEN_OVERLAY_ROOT_SELECTOR);
}

function findScrollLockAllowEl(target) {
    if (!(target instanceof Element)) return null;
    return target.closest(SCROLL_ALLOW_SELECTOR);
}

function findScrollableInOverlay(target) {
    if (!(target instanceof Element)) return null;
    let node = target;
    while (node && node !== document.body) {
        if (!(node instanceof Element)) break;
        if (!isInsideOpenOverlay(node)) return null;
        const style = getComputedStyle(node);
        const oy = style.overflowY;
        const ox = style.overflowX;
        const yScroll =
            (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
            node.scrollHeight > node.clientHeight + 1;
        const xScroll =
            (ox === 'auto' || ox === 'scroll' || ox === 'overlay') &&
            node.scrollWidth > node.clientWidth + 1;
        if (yScroll || xScroll) return node;
        node = node.parentElement;
    }
    return null;
}

function canScrollEl(el, deltaX, deltaY) {
    if (!el) return false;
    const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = el;
    if (deltaY !== 0 && scrollHeight > clientHeight + 1) {
        if (deltaY < 0 && scrollTop > 0) return true;
        if (deltaY > 0 && scrollTop + clientHeight < scrollHeight - 1) return true;
    }
    if (deltaX !== 0 && scrollWidth > clientWidth + 1) {
        if (deltaX < 0 && scrollLeft > 0) return true;
        if (deltaX > 0 && scrollLeft + clientWidth < scrollWidth - 1) return true;
    }
    return false;
}

let touchStartY = 0;
let touchStartX = 0;

function onTouchStart(e) {
    if (lockOwners.size <= 0) return;
    const t = e.touches?.[0];
    if (!t) return;
    touchStartX = t.clientX;
    touchStartY = t.clientY;
}

function onTouchMove(e) {
    if (lockOwners.size <= 0) return;
    if (findScrollLockAllowEl(e.target)) return;
    if (!isInsideOpenOverlay(e.target)) {
        e.preventDefault();
        return;
    }
    // 팝업 안이어도 스크롤 가능한 영역이 없거나 끝에 닿으면 배경으로 제스처가 새지 않게 차단
    const t = e.touches?.[0];
    if (!t) return;
    const deltaX = touchStartX - t.clientX;
    const deltaY = touchStartY - t.clientY;
    const scrollable = findScrollableInOverlay(e.target);
    if (scrollable && canScrollEl(scrollable, deltaX, deltaY)) return;
    e.preventDefault();
}

function onWheel(e) {
    if (lockOwners.size <= 0) return;
    const scrollable = findScrollLockAllowEl(e.target) || findScrollableInOverlay(e.target);
    if (scrollable && canScrollEl(scrollable, e.deltaX, e.deltaY)) return;
    e.preventDefault();
}

const SCROLL_BLOCK_KEYS = new Set([' ', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown']);

function onKeyDown(e) {
    if (lockOwners.size <= 0) return;
    if (!SCROLL_BLOCK_KEYS.has(e.key)) return;
    const t = e.target;
    if (
        t instanceof Element &&
        t.closest('input, textarea, select, [contenteditable="true"], [data-scroll-lock-allow]')
    ) {
        return;
    }
    if (isInsideOpenOverlay(t)) return;
    e.preventDefault();
}

function attachScrollBlockListeners() {
    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    document.addEventListener('keydown', onKeyDown, { capture: true });
}

function detachScrollBlockListeners() {
    document.removeEventListener('touchstart', onTouchStart, { capture: true });
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    document.removeEventListener('wheel', onWheel, { capture: true });
    document.removeEventListener('keydown', onKeyDown, { capture: true });
}

function applyDomScrollLock() {
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add('mealog-scroll-locked');
    document.body.classList.add('mealog-scroll-locked');
    document.body.style.top = `-${savedScrollY}px`;
    attachScrollBlockListeners();
}

function clearDomScrollLock() {
    document.documentElement.classList.remove('mealog-scroll-locked');
    document.body.classList.remove('mealog-scroll-locked');
    document.body.style.top = '';
    detachScrollBlockListeners();
    window.scrollTo(0, savedScrollY);
}

/**
 * @param {string} [owner] 같은 owner로 중복 lock해도 한 번만 잡힘. 다른 팝업은 다른 owner 사용.
 */
export function lockBodyScroll(owner = 'default') {
    const key = ownerKey(owner);
    if (lockOwners.has(key)) return;
    const first = lockOwners.size === 0;
    lockOwners.add(key);
    if (first) applyDomScrollLock();
}

/**
 * @param {string} [owner] lock 때 쓴 owner와 동일해야 함.
 */
export function unlockBodyScroll(owner = 'default') {
    const key = ownerKey(owner);
    if (!lockOwners.has(key)) return;
    lockOwners.delete(key);
    if (lockOwners.size > 0) return;
    clearDomScrollLock();
}
