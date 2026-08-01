/**
 * 앱 전역 IME(키보드) 감지·오버레이 핀·입력란 가시 스크롤.
 *
 * 모드:
 * - resize: Capacitor body resize — layoutH가 키보드만큼 줄어듦 → fixed bottom ≈ 0
 * - overlay: 모바일 웹 등 — layoutH 유지, visualViewport만 축소 → fixed bottom = imeOverlap
 */

let baselineLayoutH = 0;
let imeOpen = false;
let initialized = false;
let syncRaf = null;
let burstTimers = [];
let pollTimer = null;
/** Capacitor Keyboard 플러그인이 보고한 키보드 높이(px). 0이면 미보고/닫힘 */
let nativeImeHeight = 0;
/** 포커스 직후 VV open 전이 폴링 종료 시각 (ms) */
let focusPollUntil = 0;

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

/** Capacitor 앱이 아닌 터치 모바일 웹(Chrome/Safari) */
export function isMobileWebTouchUi() {
    if (typeof window === 'undefined') return false;
    if (window.Capacitor?.isNativePlatform?.()) return false;
    try {
        if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true;
    } catch (_) { /* ignore */ }
    const touch = (navigator.maxTouchPoints || 0) > 0;
    const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    return touch && shortSide > 0 && shortSide < 900;
}

function isNativePlatform() {
    try {
        return !!window.Capacitor?.isNativePlatform?.();
    } catch (_) {
        return false;
    }
}

/**
 * @param {{ adjustResizeLikely: boolean }} partial
 * @returns {'resize'|'overlay'}
 */
function resolveImeMode(partial) {
    if (isNativePlatform() && partial.adjustResizeLikely) return 'resize';
    if (isMobileWebTouchUi()) return 'overlay';
    // native인데 리사이즈가 안 잡히면 overlay로 VV 보정
    if (isNativePlatform()) return partial.adjustResizeLikely ? 'resize' : 'overlay';
    return 'overlay';
}

/**
 * VV/네이티브 기준 실제 키보드 열림 (포커스만으로는 true 아님).
 */
function computeImeOpenSignal(layoutH, vvH, vvTop, vvBottom, baseline) {
    if (nativeImeHeight > 80) return true;
    if (!(layoutH > 0)) return false;
    const overlap = Math.max(0, layoutH - vvBottom);
    return (
        vvH < layoutH * 0.92 ||
        layoutH < baseline * 0.92 ||
        vvTop > 8 ||
        overlap > 80
    );
}

/**
 * 키보드가 올라온 것으로 보고 UI(ime-open·오버레이 핀)를 적용할지.
 * 네이티브·모바일 웹 모두 실제 VV/Keyboard 신호 기준 (포커스-only 금지).
 */
export function shouldTreatImeOpen() {
    if (nativeImeHeight > 80) return true;
    if (!isImeInputLike(document.activeElement)) return false;
    return getImeMetrics().open;
}

export function captureImeBaseline() {
    const layoutH = window.innerHeight || 0;
    const vvH = window.visualViewport?.height ?? layoutH;
    // 키보드가 이미 올라온 뒤의 작은 높이로 baseline이 덮이지 않게 상승만 허용
    baselineLayoutH = Math.max(layoutH, vvH, baselineLayoutH || 0);
}

/** 플러그인 키보드 높이로 baseline을 보정 (리사이즈 이후 첫 캡처 오판 방지) */
function ensureBaselineWithKeyboard(keyboardH) {
    const layoutH = window.innerHeight || 0;
    const kh = Math.max(0, Number(keyboardH) || 0);
    if (kh > 80) {
        baselineLayoutH = Math.max(baselineLayoutH || 0, layoutH + kh);
    } else {
        captureImeBaseline();
    }
}

export function clearImeBaseline() {
    baselineLayoutH = 0;
}

export function setNativeImeHeight(px) {
    const n = Math.max(0, Math.round(Number(px) || 0));
    if (nativeImeHeight === n) return;
    nativeImeHeight = n;
    scheduleSyncBurst();
}

export function getNativeImeHeight() {
    return nativeImeHeight;
}

/**
 * @returns {{
 *   open: boolean,
 *   mode: 'resize'|'overlay',
 *   layoutH: number,
 *   vvH: number,
 *   vvTop: number,
 *   vvBottom: number,
 *   baseline: number,
 *   pinTop: number,
 *   pinHeight: number,
 *   pinWidth: number,
 *   pinLeft: number,
 *   imeOverlap: number,
 *   fixedBottom: number,
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
    const vvBottom = vvTop + vvH;
    const baseline = baselineLayoutH > 0 ? baselineLayoutH : layoutH;
    // adjustResize/body resize: 레이아웃이 이미 키보드 제외 → fixed bottom은 0에 두면 됨
    const adjustResizeLikely = baseline > 0 && layoutH < baseline * 0.92 && vvTop <= 8;
    const mode = resolveImeMode({ adjustResizeLikely });
    const open = computeImeOpenSignal(layoutH, vvH, vvTop, vvBottom, baseline);

    const overlapFromVv = Math.max(0, layoutH - vvBottom);
    let imeOverlap = 0;
    if (mode === 'resize') {
        // 리사이즈된 레이아웃: VV overlap을 또 더하면 이중 상승
        imeOverlap = 0;
        if (!adjustResizeLikely && nativeImeHeight > 80) {
            imeOverlap = nativeImeHeight;
        }
    } else {
        imeOverlap = overlapFromVv > 8 ? overlapFromVv : 0;
        if (imeOverlap < 8 && nativeImeHeight > 80) {
            imeOverlap = nativeImeHeight;
        }
    }

    const fixedBottom = mode === 'resize' ? 0 : Math.round(imeOverlap);
    const pinTop = mode === 'resize' ? 0 : Math.max(0, vvTop);
    const pinHeight =
        mode === 'resize'
            ? Math.max(120, Math.round(layoutH))
            : Math.max(
                  120,
                  Math.round(
                      vv
                          ? Math.min(vvH, Math.max(0, layoutH - pinTop - imeOverlap))
                          : Math.max(0, layoutH - imeOverlap)
                  )
              );
    const pinWidth = Math.max(120, Math.round(vvW));
    return {
        open,
        mode,
        layoutH,
        vvH,
        vvTop,
        vvBottom,
        baseline,
        pinTop,
        pinHeight,
        pinWidth,
        pinLeft: mode === 'resize' ? 0 : Math.max(0, vvLeft),
        imeOverlap,
        fixedBottom,
        adjustResizeLikely
    };
}

function publishImeCssVars(m) {
    const root = document.documentElement;
    const body = document.body;
    if (!root) return;
    const open = !!m?.open;
    const mode = m?.mode || 'overlay';
    const overlap = open ? Math.round(m.imeOverlap || 0) : 0;
    const fixedBottom = open ? Math.round(m.fixedBottom ?? (mode === 'resize' ? 0 : overlap)) : 0;
    const vvH = open
        ? Math.round(mode === 'resize' ? (m.layoutH || window.innerHeight || 0) : (m.vvH || window.innerHeight || 0))
        : Math.round(window.innerHeight || 0);
    const vvTop = open && mode === 'overlay' ? Math.round(m.vvTop || 0) : 0;

    root.style.setProperty('--ime-overlap', `${overlap}px`);
    root.style.setProperty('--ime-inset', `${overlap}px`);
    root.style.setProperty('--ime-fixed-bottom', `${fixedBottom}px`);
    root.style.setProperty('--ime-vv-height', `${vvH}px`);
    root.style.setProperty('--ime-vv-top', `${vvTop}px`);
    root.setAttribute('data-ime-mode', mode);
    if (body) body.setAttribute('data-ime-mode', mode);
}

export function isAppImeOpen() {
    return imeOpen;
}

/** @returns {'resize'|'overlay'} */
export function getImeMode() {
    return getImeMetrics().mode;
}

export function onAppImeChange(fn) {
    if (typeof fn === 'function') listeners.add(fn);
    return () => listeners.delete(fn);
}

export function setAppImeOpen(open) {
    const next = !!open;
    const m = getImeMetrics();
    if (next) {
        publishImeCssVars({ ...m, open: true });
    } else {
        publishImeCssVars({
            open: false,
            mode: m.mode,
            imeOverlap: 0,
            fixedBottom: 0,
            vvH: window.innerHeight || 0,
            vvTop: 0,
            layoutH: window.innerHeight || 0
        });
    }
    if (imeOpen === next) {
        document.body.classList.toggle('ime-open', next);
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
        focusPollUntil = 0;
        setAppImeOpen(false);
        if (nativeImeHeight <= 80) {
            baselineLayoutH = Math.max(
                window.innerHeight || 0,
                window.visualViewport?.height || 0
            );
        }
        return false;
    }
    setAppImeOpen(shouldTreatImeOpen());
    return imeOpen;
}

/**
 * 보이는 영역(visualViewport − 패드) 안에서 포커스 입력이 가려지지 않게 스크롤.
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
        return document.scrollingElement || document.documentElement;
    };

    const visibleBand = () => {
        const vv = window.visualViewport;
        const m = getImeMetrics();
        if (vv) {
            const top = (Number(vv.offsetTop) || 0) + pad;
            const bottom =
                (Number(vv.offsetTop) || 0) +
                (Number(vv.height) || window.innerHeight) -
                pad -
                (m.mode === 'resize' ? 0 : Math.max(0, m.imeOverlap));
            return { top, bottom: Math.max(top + 40, bottom) };
        }
        const top = pad;
        const bottom = (window.innerHeight || 0) - pad - Math.max(0, m.imeOverlap);
        return { top, bottom: Math.max(top + 40, bottom) };
    };

    const run = () => {
        if (!document.contains(target) || document.activeElement !== target) return;
        const band = visibleBand();
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
            const clipTop = Math.max(sRect.top, band.top);
            const clipBottom = Math.min(sRect.bottom, band.bottom);

            if (align === 'center') {
                const tMid = (tRect.top + tRect.bottom) / 2;
                const cMid = (clipTop + clipBottom) / 2;
                scrollParent.scrollTop += tMid - cMid;
                return;
            }

            if (align === 'end' || tRect.bottom > clipBottom) {
                scrollParent.scrollTop += tRect.bottom - clipBottom;
            } else if (tRect.top < clipTop) {
                scrollParent.scrollTop -= clipTop - tRect.top;
            }

            const after = target.getBoundingClientRect();
            const band2 = visibleBand();
            if (after.bottom > band2.bottom || after.top < band2.top) {
                target.scrollIntoView({
                    block: after.bottom > band2.bottom ? 'end' : 'center',
                    inline: 'nearest',
                    behavior: 'auto'
                });
            }
        } catch (_) { /* ignore */ }
    };

    delays.forEach((ms) => {
        if (ms <= 0) requestAnimationFrame(run);
        else setTimeout(run, ms);
    });
}

/**
 * overlay 모드에서만 VV 박스 핀. resize 모드에서는 no-op(레이아웃이 이미 줄어듦).
 */
export function applyOverlayImePin(root) {
    if (!root) return false;
    const m = getImeMetrics();
    if (m.mode === 'resize') return false;
    // overlay: open 전이라도 포커스+폴링 중이면 현재 VV에 핀
    const focusPending = isMobileWebTouchUi() && isImeInputLike(document.activeElement) && Date.now() < focusPollUntil;
    if (!m.open && !focusPending) {
        return false;
    }
    const vv = window.visualViewport;
    const layoutH = m.layoutH || window.innerHeight || 0;
    let pinTop = Math.max(0, Number(vv?.offsetTop) || m.pinTop || 0);
    let pinLeft = Math.max(0, Number(vv?.offsetLeft) || m.pinLeft || 0);
    let pinHeight = Math.max(120, Math.round(Number(vv?.height) || m.vvH || layoutH));
    let pinWidth = Math.max(120, Math.round(Number(vv?.width) || m.pinWidth || window.innerWidth || 0));
    root.classList.add('is-ime-open');
    root.style.top = `${Math.round(pinTop)}px`;
    root.style.left = `${Math.round(pinLeft)}px`;
    root.style.width = `${Math.round(pinWidth)}px`;
    root.style.height = `${Math.round(pinHeight)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = '';
    publishImeCssVars({ ...m, open: true, pinHeight, vvH: pinHeight, vvTop: pinTop });
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
                if (isImeInputLike(document.activeElement) && imeOpen) {
                    ensureFocusedInputVisible(document.activeElement, {
                        align: 'nearest',
                        delays: [0]
                    });
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

function bindCapacitorKeyboard() {
    try {
        if (!isNativePlatform()) return;
        const Keyboard = window.Capacitor?.Plugins?.Keyboard;
        if (!Keyboard) return;

        if (typeof Keyboard.setResizeMode === 'function') {
            try {
                Keyboard.setResizeMode({ mode: 'body' });
            } catch (_) { /* ignore */ }
        }

        const onShow = (info) => {
            const h = Number(info?.keyboardHeight) || 0;
            ensureBaselineWithKeyboard(h);
            setNativeImeHeight(h);
            setAppImeOpen(true);
            if (isImeInputLike(document.activeElement)) {
                ensureFocusedInputVisible(document.activeElement, {
                    align: 'nearest',
                    delays: [0, 80, 200, 400]
                });
            }
        };
        const onHide = () => {
            setNativeImeHeight(0);
            setAppImeOpen(false);
            baselineLayoutH = Math.max(
                window.innerHeight || 0,
                window.visualViewport?.height || 0,
                baselineLayoutH || 0
            );
            try {
                const mealtalk = document.getElementById('boardInlineComposerInput');
                if (mealtalk && document.activeElement === mealtalk) {
                    mealtalk.blur();
                }
            } catch (_) { /* ignore */ }
        };

        if (typeof Keyboard.addListener === 'function') {
            Keyboard.addListener('keyboardWillShow', onShow);
            Keyboard.addListener('keyboardDidShow', onShow);
            Keyboard.addListener('keyboardWillHide', onHide);
            Keyboard.addListener('keyboardDidHide', onHide);
        }
    } catch (_) { /* ignore */ }
}

/**
 * body.ime-open / keyboard-closed 동기화 + 포커스 입력 가시화.
 * overlay-keyboard-pin과 함께 사용.
 */
export function initAppImeViewport() {
    if (initialized || typeof document === 'undefined') return;
    initialized = true;

    baselineLayoutH = Math.max(
        window.innerHeight || 0,
        window.visualViewport?.height || 0
    );
    setAppImeOpen(false);
    bindCapacitorKeyboard();

    document.addEventListener(
        'focusin',
        (e) => {
            if (!isImeInputLike(e.target)) return;
            captureImeBaseline();
            // 웹: Keyboard 플러그인 대체 — 포커스 직후 VV open 전이만 폴링 (포커스-only ime-open 금지)
            focusPollUntil = Date.now() + 500;
            scheduleSyncBurst();
            if (pollTimer) clearInterval(pollTimer);
            const start = Date.now();
            pollTimer = setInterval(() => {
                syncAppImeState();
                const m = getImeMetrics();
                if (m.open && isImeInputLike(document.activeElement)) {
                    ensureFocusedInputVisible(document.activeElement, {
                        align: 'nearest',
                        delays: [0]
                    });
                }
                const pastFocusWindow = Date.now() > focusPollUntil;
                if (
                    (pastFocusWindow && !m.open && nativeImeHeight <= 80 && Date.now() - start > 800) ||
                    Date.now() - start > 12000
                ) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            }, 100);
        },
        true
    );

    document.addEventListener(
        'focusout',
        (e) => {
            if (!isImeInputLike(e.target)) return;
            focusPollUntil = 0;
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
