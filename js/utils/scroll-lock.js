/** 배경 스크롤·터치 차단 (중첩 팝업은 ref-count) */
let lockCount = 0;
let savedScrollY = 0;

const SCROLL_ALLOW_SELECTOR =
    '[data-scroll-lock-allow], .attendance-welcome-report-content, .attendance-welcome-chart-viewport';

function isScrollAllowedTarget(target) {
    if (!(target instanceof Element)) return false;
    return !!target.closest(SCROLL_ALLOW_SELECTOR);
}

function onTouchMove(e) {
    if (isScrollAllowedTarget(e.target)) return;
    e.preventDefault();
}

export function lockBodyScroll() {
    lockCount += 1;
    if (lockCount > 1) return;

    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add('mealog-scroll-locked');
    document.body.classList.add('mealog-scroll-locked');
    document.body.style.top = `-${savedScrollY}px`;
    document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
}

export function unlockBodyScroll() {
    if (lockCount <= 0) return;
    lockCount -= 1;
    if (lockCount > 0) return;

    document.documentElement.classList.remove('mealog-scroll-locked');
    document.body.classList.remove('mealog-scroll-locked');
    document.body.style.top = '';
    document.removeEventListener('touchmove', onTouchMove, { capture: true });
    window.scrollTo(0, savedScrollY);
}
