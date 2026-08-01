/**
 * 앱 전역 IME(키보드) 감지·오버레이 핀·입력란 가시 스크롤.
 *
 * - 네이티브: @capacitor/keyboard(resizeOnFullScreen) + visualViewport
 * - 모바일 웹: Keyboard 플러그인 없음 → 포커스 시 VV 박스로 핀·본문 스크롤 (브라우저 팬을 되돌리지 않음)
 */

let baselineLayoutH = 0;
let imeOpen = false;
let initialized = false;
let syncRaf = null;
let burstTimers = [];
let pollTimer = null;
/** Capacitor Keyboard 플러그인이 보고한 키보드 높이(px). 0이면 미보고/닫힘 */
let nativeImeHeight = 0;

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

/**
 * 키보드가 올라온 것으로 보고 UI(ime-open·오버레이 핀)를 적용할지.
 * 모바일 웹은 VV 축소 전이라도 입력 포커스면 true (앱의 Keyboard 이벤트를 대체).
 */
export function shouldTreatImeOpen() {
    if (nativeImeHeight > 80) return true;
    if (!isImeInputLike(document.activeElement)) return false;
    if (getImeMetrics().open) return true;
    return isMobileWebTouchUi();
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
    const open =
        layoutH > 0 &&
        (vvH < layoutH * 0.92 ||
            layoutH < baseline * 0.92 ||
            vvTop > 8 ||
            nativeImeHeight > 80);
    // adjustResize/body resize: 레이아웃이 이미 키보드 제외 → fixed bottom은 0에 두면 됨
    const adjustResizeLikely = baseline > 0 && layoutH < baseline * 0.92 && vvTop <= 8;
    const overlapFromVv = Math.max(0, layoutH - vvBottom);
    // VV가 알려주는 실제 가림량 우선. 리사이즈된 뒤에 native 높이를 또 더하면 이중 상승됨.
    let imeOverlap = overlapFromVv > 8 ? overlapFromVv : 0;
    if (!adjustResizeLikely && imeOverlap < 8 && nativeImeHeight > 80) {
        imeOverlap = nativeImeHeight;
    }
    const pinTop = adjustResizeLikely ? 0 : Math.max(0, vvTop);
    const pinHeight = adjustResizeLikely
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
        layoutH,
        vvH,
        vvTop,
        vvBottom,
        baseline,
        pinTop,
        pinHeight,
        pinWidth,
        pinLeft: adjustResizeLikely ? 0 : Math.max(0, vvLeft),
        imeOverlap,
        adjustResizeLikely
    };
}

function publishImeCssVars(m) {
    const root = document.documentElement;
    if (!root) return;
    const overlap = m?.open ? Math.round(m.imeOverlap || 0) : 0;
    root.style.setProperty('--ime-overlap', `${overlap}px`);
    root.style.setProperty('--ime-inset', `${overlap}px`);
    root.style.setProperty('--ime-vv-height', `${Math.round(m?.vvH || window.innerHeight || 0)}px`);
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
    const m = getImeMetrics();
    publishImeCssVars(next ? m : { open: false, imeOverlap: 0, vvH: window.innerHeight || 0 });
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
        // 포커스 없으면 닫힘. baseline은 현재 레이아웃으로 갱신(다음 오픈 비교용)
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
 * 스크롤 부모 bounds만 보면 키보드에 덮인 채 “이미 보임”으로 오판하므로 VV bottom을 함께 쓴다.
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
            // 레이아웃이 안 줄어든 경우 imeOverlap만큼 하단을 추가로 비움
            const bottom =
                (Number(vv.offsetTop) || 0) +
                (Number(vv.height) || window.innerHeight) -
                pad -
                (m.adjustResizeLikely ? 0 : Math.max(0, m.imeOverlap));
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
            // 스크롤 부모 ∩ 실제 보이는 밴드
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

            // 한 번 더: 스크롤 후에도 VV 밖으로 나가면 scrollIntoView로 보정
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

export function applyOverlayImePin(root) {
    if (!root) return false;
    const m = getImeMetrics();
    // 모바일 웹: open 판정 전에도 포커스면 현재 VV에 핀 (키보드 애니·iOS 팬 대응)
    if (!m.open && !(isMobileWebTouchUi() && isImeInputLike(document.activeElement))) {
        return false;
    }
    const vv = window.visualViewport;
    const layoutH = m.layoutH || window.innerHeight || 0;
    // 웹/비-resize: 항상 보이는 VV 박스. adjustResize: 레이아웃 높이.
    let pinTop = m.pinTop;
    let pinLeft = m.pinLeft;
    let pinHeight = m.pinHeight;
    let pinWidth = m.pinWidth;
    if (!m.adjustResizeLikely && vv) {
        pinTop = Math.max(0, Number(vv.offsetTop) || 0);
        pinLeft = Math.max(0, Number(vv.offsetLeft) || 0);
        pinHeight = Math.max(120, Math.round(Number(vv.height) || layoutH));
        pinWidth = Math.max(120, Math.round(Number(vv.width) || window.innerWidth || 0));
    }
    root.classList.add('is-ime-open');
    root.style.top = `${Math.round(pinTop)}px`;
    root.style.left = `${Math.round(pinLeft)}px`;
    root.style.width = `${Math.round(pinWidth)}px`;
    root.style.height = `${Math.round(pinHeight)}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = '';
    publishImeCssVars({ ...m, open: true, pinHeight, vvH: pinHeight });
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
        if (!window.Capacitor?.isNativePlatform?.()) return;
        // 정적 ES 모듈 앱: 네이티브 브릿지 Plugins.Keyboard 사용 (번들 import 없음)
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

    // 앱 기동 시 전체 높이 저장 — 이후 키보드 리사이즈와 비교
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
                if ((!m.open && nativeImeHeight <= 80 && Date.now() - start > 800) || Date.now() - start > 12000) {
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
