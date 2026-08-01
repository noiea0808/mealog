/**
 * 검색·알림 센터 다이얼로그 / 모먼트 댓글 시트:
 * 키보드로 visualViewport가 밀릴 때 fixed 오버레이·입력란이 함께 올라가는 현상 완화.
 * 오버레이를 visualViewport 박스에 맞추고 레이아웃 스크롤을 원위치한다.
 */

const OVERLAY_ROOT_SELECTORS = [
    '#timelineSearchModal',
    '#momentSearchModal',
    '#boardSearchModal',
    '#notificationModal',
    '.moment-v2-social-comments-panel--sheet-in-body'
];

let activeRoot = null;
let syncRaf = null;
let pinTimers = [];
let initialized = false;

function isInputLike(el) {
    return !!(
        el &&
        (el.matches?.('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(.push-pref-toggle), textarea') ||
            el.getAttribute?.('contenteditable') === 'true')
    );
}

function findOverlayRoot(el) {
    if (!el?.closest) return null;
    for (const sel of OVERLAY_ROOT_SELECTORS) {
        const root = el.closest(sel);
        if (root && !root.classList.contains('hidden')) return root;
    }
    return null;
}

function pinLayoutScroll() {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
    const de = document.documentElement;
    const body = document.body;
    if (de?.scrollTop) de.scrollTop = 0;
    if (body?.scrollTop) body.scrollTop = 0;
}

function clearOverlayVvPin(root) {
    if (!root) return;
    root.classList.remove('is-ime-open');
    root.style.top = '';
    root.style.left = '';
    root.style.right = '';
    root.style.bottom = '';
    root.style.height = '';
    root.style.width = '';
    root.style.transform = '';
}

function isKeyboardLikelyOpen() {
    const vv = window.visualViewport;
    if (!vv) return false;
    const layoutH = window.innerHeight || 0;
    if (!(layoutH > 0)) return false;
    // 레이아웃 대비 보이는 높이가 크게 줄었거나, 뷰포트가 위로 밀린 경우
    return vv.height < layoutH * 0.85 || (Number(vv.offsetTop) || 0) > 8;
}

function applyOverlayVvPin(root) {
    const vv = window.visualViewport;
    if (!root) return;
    pinLayoutScroll();
    if (!vv || !isKeyboardLikelyOpen()) {
        // 포커스만 있고 키보드가 없으면 인라인 핀·상단 정렬을 걸지 않음 (웹 데스크톱)
        clearOverlayVvPin(root);
        return;
    }
    root.classList.add('is-ime-open');

    const top = Math.max(0, Number(vv.offsetTop) || 0);
    const left = Math.max(0, Number(vv.offsetLeft) || 0);
    const h = Math.max(120, Math.round(Number(vv.height) || window.innerHeight || 0));
    const w = Math.max(120, Math.round(Number(vv.width) || window.innerWidth || 0));

    // fixed inset-0 오버레이를 보이는 visualViewport에 맞춤 (키보드 위로 통째로 밀림 방지)
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = '';
}

function clearPinTimers() {
    pinTimers.forEach((id) => clearTimeout(id));
    pinTimers = [];
}

function scheduleSyncBurst() {
    clearPinTimers();
    [0, 50, 120, 250, 400, 700].forEach((ms) => {
        pinTimers.push(setTimeout(() => scheduleSync(), ms));
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
    const root = isInputLike(ae) ? findOverlayRoot(ae) : null;
    if (!root) {
        if (activeRoot) {
            clearOverlayVvPin(activeRoot);
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
            if (!isInputLike(e.target) || !findOverlayRoot(e.target)) return;
            scheduleSyncBurst();
        },
        true
    );
    document.addEventListener(
        'focusout',
        (e) => {
            if (!isInputLike(e.target)) return;
            clearPinTimers();
            pinTimers.push(
                setTimeout(() => {
                    scheduleSync();
                }, 80)
            );
            pinTimers.push(
                setTimeout(() => {
                    scheduleSync();
                }, 320)
            );
        },
        true
    );

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSync, { passive: true });
        window.visualViewport.addEventListener('scroll', scheduleSync, { passive: true });
    }
    window.addEventListener('resize', scheduleSync, { passive: true });
}
