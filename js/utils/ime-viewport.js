/**
 * 앱 전역 IME(키보드) 감지·오버레이 핀·입력란 가시 스크롤.
 * Android adjustResize에서 innerHeight와 VV가 같이 줄어드는 경우를 baseline으로 처리한다.
 */

let baselineLayoutH = 0;
let imeOpen = false;
let initialized = false;
let syncRaf = null;
let burstTimers = [];
let pollTimer = null;

/** @type {Set<(open: boolean) => void>} */
const listeners = new Set();

export function isImeInputLike(el) {
    return !!(
        el &&
        (el.matches?.(
            'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not(.push-pref-toggle), textarea'
        ) || el.getAttribute?.('contenteditable') === 'true')
    );
}

export function captureImeBaseline() {
    const layoutH = window.innerHeight || 0;
    const vvH = window.visualViewport?.height ?? layoutH;
    baselineLayoutH = Math.max(layoutH, vvH, baselineLayoutH || 0);
}

export function clearImeBaseline() {
    baselineLayoutH = 0;
}

/**
 * @returns {{
 *   open: boolean,
 *   layoutH: number,
 *   vvH: number,
 *   vvTop: number,
 *   baseline: number,
 *   pinTop: number,
 *   pinHeight: number,
 *   pinWidth: number,
 *   adjustResizeLikely: boolean
 * }}
 */
export function getImeMetrics() {
    const layoutH = window.innerHeight || 0;
    const vv = window.visualViewport;
    const vvH = vv ? Number(vv.height) || layoutH : layoutH;
    const vvTop = vv ? Number(vv.offsetTop) || 0 : 0;
    const vvLeft = vv ? Number(vv.offsetLeft) || 0 : 0;
    const vvW = vv ? Number(vv.width) || window.innerWidth || 0 : window.innerWidth || 0;
    const baseline = baselineLayoutH > 0 ? baselineLayoutH : layoutH;
    const open =
        layoutH > 0 &&
        (vvH < layoutH * 0.92 || layoutH < baseline * 0.92 || vvTop > 8);
    // adjustResize: 레이아웃이 이미 키보드 제외 → 오버레이를 VV로 줄이면 offsetTop>0일 때 하단 빈 띠
    const adjustResizeLikely = baseline > 0 && layoutH < baseline * 0.92 && vvTop <= 8;
    const pinTop = adjustResizeLikely ? 0 : Math.max(0, vvTop);
    const pinHeight = adjustResizeLikely
        ? Math.max(120, Math.round(layoutH))
        : Math.max(120, Math.round(Math.min(vvH, Math.max(0, layoutH - pinTop))));
    const pinWidth = Math.max(120, Math.round(vvW));
    return {
        open,
        layoutH,
        vvH,
        vvTop,
        baseline,
        pinTop,
        pinHeight,
        pinWidth,
        pinLeft: adjustResizeLikely ? 0 : Math.max(0, vvLeft),
        adjustResizeLikely
    };
}

export function isAppImeOpen() {
    return imeOpen;
}

export function onAppImeChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
}

export function setAppImeOpen(open) {
    const next = !!open;
    if (imeOpen === next) {
        document.body.classList.toggle('ime-open', next);
        // keyboard-closed = 키보드 없음 (레거시 CSS 호환). IME 중에는 절대 복원 규칙이 이기면 안 됨.
        document.body.classList.toggle('keyboard-closed', !next);
        return;
    }
    imeOpen = next;
    document.body.classList.toggle('ime-open', next);
    document.body.classList.toggle('keyboard-closed', !next);
    listeners.forEach((fn) => {
        try {
            fn(next);
        } catch (_) { /* ignore */ }
    });
}

export function syncAppImeState() {
    const focused = isImeInputLike(document.activeElement);
    if (!focused) {
        setAppImeOpen(false);
        clearImeBaseline();
        return false;
    }
    const { open } = getImeMetrics();
    setAppImeOpen(open);
    return open;
}

/**
 * 스크롤 부모 안에서 포커스된 입력란이 보이도록 맞춤 (지연 버스트 포함).
 * @param {Element|null} [el]
 * @param {{ align?: 'nearest'|'end'|'center', pad?: number, delays?: number[], scrollParent?: Element|null }} [opts]
 */
export function ensureFocusedInputVisible(el, opts = {}) {
    const target = el && isImeInputLike(el) ? el : document.activeElement;
    if (!isImeInputLike(target)) return;

    const align = opts.align || 'nearest';
    const pad = Number.isFinite(opts.pad) ? opts.pad : 16;
    const delays = opts.delays || [0, 50, 150, 320, 500];

    const findScrollParent = (node) => {
        if (opts.scrollParent) return opts.scrollParent;
        let n = node?.parentElement;
        while (n && n !== document.body) {
            const st = getComputedStyle(n);
            const oy = st.overflowY;
            if (
                (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                n.scrollHeight > n.clientHeight + 1
            ) {
                return n;
            }
            n = n.parentElement;
        }
        return null;
    };

    const run = () => {
        if (!document.contains(target) || document.activeElement !== target) return;
        const scrollParent = findScrollParent(target);
        if (!scrollParent) {
            try {
                target.scrollIntoView({
                    block: align === 'end' ? 'end' : align === 'center' ? 'center' : 'nearest',
                    inline: 'nearest',
                    behavior: 'auto'
                });
            } catch (_) { /* ignore */ }
            return;
        }
        try {
            const tRect = target.getBoundingClientRect();
            const sRect = scrollParent.getBoundingClientRect();
            if (align === 'end' || tRect.bottom > sRect.bottom - pad) {
                scrollParent.scrollTop += tRect.bottom - sRect.bottom + pad;
            } else if (align === 'center') {
                const tMid = (tRect.top + tRect.bottom) / 2;
                const sMid = (sRect.top + sRect.bottom) / 2;
                scrollParent.scrollTop += tMid - sMid;
            } else if (tRect.top < sRect.top + pad) {
                scrollParent.scrollTop -= sRect.top - tRect.top + pad;
            }
        } catch (_) { /* ignore */ }
    };

    delays.forEach((ms) => {
        if (ms <= 0) requestAnimationFrame(run);
        else setTimeout(run, ms);
    });
}

export function applyOverlayImePin(root) {
    if (!root) return false;
    const m = getImeMetrics();
    if (!m.open) return false;
    root.classList.add('is-ime-open');
    root.style.top = `${Math.round(m.pinTop)}px`;
    root.style.left = `${Math.round(m.pinLeft)}px`;
    root.style.width = `${Math.round(m.pinWidth)}px`;
    root.style.height = `${Math.round(m.pinHeight)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = '';
    return true;
}

export function clearOverlayImePinStyles(root) {
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

function clearBurstTimers() {
    burstTimers.forEach((id) => clearTimeout(id));
    burstTimers = [];
}

function scheduleSyncBurst() {
    clearBurstTimers();
    [0, 50, 120, 250, 400, 700].forEach((ms) => {
        burstTimers.push(
            setTimeout(() => {
                scheduleSync();
                if (isImeInputLike(document.activeElement)) {
                    ensureFocusedInputVisible(document.activeElement, { align: 'nearest' });
                }
            }, ms)
        );
    });
}

function scheduleSync() {
    if (syncRaf != null) return;
    syncRaf = requestAnimationFrame(() => {
        syncRaf = null;
        syncAppImeState();
    });
}

/**
 * body.ime-open / keyboard-closed 동기화 + 포커스 입력 가시화.
 * overlay-keyboard-pin과 함께 사용.
 */
export function initAppImeViewport() {
    if (initialized || typeof document === 'undefined') return;
    initialized = true;

    // 초기: 키보드 없음
    setAppImeOpen(false);

    document.addEventListener(
        'focusin',
        (e) => {
            if (!isImeInputLike(e.target)) return;
            captureImeBaseline();
            scheduleSyncBurst();
            ensureFocusedInputVisible(e.target, { align: 'nearest' });
            if (pollTimer) clearInterval(pollTimer);
            const start = Date.now();
            pollTimer = setInterval(() => {
                syncAppImeState();
                if (isImeInputLike(document.activeElement)) {
                    ensureFocusedInputVisible(document.activeElement, {
                        align: 'nearest',
                        delays: [0]
                    });
                }
                const m = getImeMetrics();
                if ((!m.open && Date.now() - start > 800) || Date.now() - start > 10000) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            }, 150);
        },
        true
    );

    document.addEventListener(
        'focusout',
        (e) => {
            if (!isImeInputLike(e.target)) return;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            clearBurstTimers();
            [80, 200, 400, 700].forEach((ms) => {
                burstTimers.push(
                    setTimeout(() => {
                        scheduleSync();
                    }, ms)
                );
            });
        },
        true
    );

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleSyncBurst, { passive: true });
        window.visualViewport.addEventListener('scroll', scheduleSync, { passive: true });
    }
    window.addEventListener('resize', scheduleSyncBurst, { passive: true });
}
