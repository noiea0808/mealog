/**
 * 앱 전역 IME(키보드) 감지·오버레이 핀·입력란 가시 스크롤.
 *
 * 모드:
 * - resize: Capacitor body resize — layoutH가 키보드만큼 줄어듦 → fixed bottom ≈ 0
 * - overlay: 모바일 웹 — --ime-fixed-bottom = VV overlap, 기록시트 등은 요소 단위 VV 핀
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
/** overlay 웹 루트 VV 시프트 활성 */
let webRootShifted = false;

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
    // 레이아웃 뷰포트가 키보드만큼 줄어든 경우 resize:
    // - APP: Capacitor Keyboard resize:'body'가 WebView를 축소
    // - 모바일 웹: meta interactive-widget=resizes-content (Chromium)
    // 데스크톱은 창 리사이즈를 키보드로 오판하지 않도록 제외.
    if (partial.adjustResizeLikely && (isNativePlatform() || isMobileWebTouchUi())) return 'resize';
    // 리사이즈가 안 잡히면(iOS Safari 등) overlay로 VV 보정
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

    // resize: 레이아웃이 이미 줄어듦 → 0
    // overlay: VV overlap (루트 시프트가 실제로 켜진 뒤에만 publish에서 0으로 덮음)
    const fixedBottom = mode === 'resize' ? 0 : Math.round(imeOverlap);
    const pinTop = mode === 'resize' ? 0 : Math.max(0, vvTop);
    const pinHeight =
        mode === 'resize'
            ? Math.max(120, Math.round(layoutH))
            : Math.max(120, Math.round(vvH));
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

/**
 * overlay 웹 루트 VV 시프트.
 * 실기기에서 fixed 밀톡/팝업과 충돌·가림 회귀가 나와 비활성.
 * 웹은 --ime-fixed-bottom=overlap + 기록시트 직접 핀으로 대응.
 */
export function applyWebImeRootShift() {
    clearWebImeRootShift();
    return false;
}

export function clearWebImeRootShift() {
    const root = document.documentElement;
    const body = document.body;
    if (root) {
        root.classList.remove('ime-root-shifted');
        root.style.position = '';
        root.style.top = '';
        root.style.left = '';
        root.style.width = '';
        root.style.height = '';
        root.style.right = '';
        root.style.bottom = '';
        root.style.transform = '';
        root.style.overflow = '';
        root.style.boxSizing = '';
    }
    if (body) {
        body.classList.remove('ime-root-shifted');
        body.style.position = '';
        body.style.width = '';
        body.style.height = '';
        body.style.minHeight = '';
        body.style.maxHeight = '';
        body.style.overflow = '';
        body.style.boxSizing = '';
    }
    webRootShifted = false;
}

/** overlay 웹 루트 VV 시프트가 켜져 있으면 true (개별 모달 핀 스킵용) */
export function isWebImeRootShifted() {
    return webRootShifted || !!document.documentElement?.classList?.contains('ime-root-shifted');
}

function resolveFixedBottomPx(m, open) {
    if (!open) return 0;
    const mode = m?.mode || 'overlay';
    if (mode === 'resize') return 0;
    // 루트 VV 시프트가 실제로 켜진 경우에만 0 (아니면 overlap으로 밀톡 등 fixed UI 상승)
    if (isWebImeRootShifted()) return 0;
    if (Number.isFinite(m?.fixedBottom)) return Math.max(0, Math.round(m.fixedBottom));
    return Math.max(0, Math.round(m?.imeOverlap || 0));
}

function publishImeCssVars(m) {
    const root = document.documentElement;
    const body = document.body;
    if (!root) return;
    const open = !!m?.open;
    const mode = m?.mode || 'overlay';
    const overlap = open ? Math.round(m.imeOverlap || 0) : 0;
    const fixedBottom = resolveFixedBottomPx(m, open);
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
        // 시프트를 먼저 시도한 뒤 fixed-bottom 토큰 결정 (시프트 실패 시 overlap 유지)
        if (m.mode === 'overlay') applyWebImeRootShift();
        else clearWebImeRootShift();
        const m2 = getImeMetrics();
        publishImeCssVars({ ...m2, open: true });
    } else {
        clearWebImeRootShift();
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
        if (next && m.mode === 'overlay') {
            applyWebImeRootShift();
            publishImeCssVars({ ...getImeMetrics(), open: true });
        }
        syncWebMealtalkComposerLift();
        return;
    }
    imeOpen = next;
    document.body.classList.toggle('ime-open', next);
    document.body.classList.toggle('keyboard-closed', !next);
    syncWebMealtalkComposerLift();
    listeners.forEach((fn) => {
        try {
            fn(next);
        } catch (_) { /* ignore */ }
    });
}

/** 웹 밀톡: ime-open 전이라도 VV overlap으로 --ime-fixed-bottom을 갱신 (APP resize는 건드리지 않음) */
function syncWebMealtalkComposerLift() {
    if (!isMobileWebTouchUi()) return;
    const m = getImeMetrics();
    if (m.mode === 'resize') return;
    const input = document.getElementById('boardInlineComposerInput');
    const mealtalkFocused = !!(input && document.activeElement === input);
    if (!mealtalkFocused && !imeOpen) return;

    const layoutH = m.layoutH || window.innerHeight || 0;
    let lift = Math.max(0, Math.round(layoutH - (m.vvBottom || 0)));
    if (lift < 40 && baselineLayoutH > 0) {
        const byH = Math.max(0, Math.round(baselineLayoutH - (m.vvH || layoutH)));
        if (byH > 80) lift = byH;
    }
    if (mealtalkFocused && lift < 40 && m.fixedBottom > 40) {
        lift = Math.round(m.fixedBottom);
    }
    const root = document.documentElement;
    if (!root) return;
    root.style.setProperty('--ime-fixed-bottom', `${lift}px`);
    root.style.setProperty('--ime-overlap', `${lift}px`);
    root.style.setProperty('--ime-inset', `${lift}px`);
    root.style.setProperty(
        '--ime-vv-height',
        `${Math.round(m.vvH || Math.max(0, layoutH - lift) || layoutH)}px`
    );
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
    syncWebMealtalkComposerLift();
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

    const entryRoot = target.closest?.('#entryModal');
    // 기록시트: 사용자가 스크롤 중이면 포커스 필드로 되감지 않음 (CTA 도달 방해 방지)
    if (entryRoot) {
        const area = entryRoot.querySelector('#modalScrollArea');
        if (area?.dataset?.entryUserScrolling === '1') return;
    }
    const suppressDocumentScroll =
        opts.suppressDocumentScroll === true || !!entryRoot;

    const findScrollParent = (node) => {
        if (opts.scrollParent) return opts.scrollParent;
        // 기록시트: 페이지 scrollIntoView 대신 #modalScrollArea만 사용
        if (entryRoot) {
            const area = entryRoot.querySelector('#modalScrollArea');
            if (area) return area;
        }
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
        // visualViewport가 있으면 이미 키보드를 제외한 보이는 영역이다.
        // overlay에서 imeOverlap을 또 빼면 clipBottom이 거의 0이 되어
        // 기록시트 메모 등이 키보드 뒤로 남는 스크롤 실패가 난다.
        if (vv) {
            const top = (Number(vv.offsetTop) || 0) + pad;
            const bottom =
                (Number(vv.offsetTop) || 0) +
                (Number(vv.height) || window.innerHeight || 0) -
                pad;
            return { top, bottom: Math.max(top + 40, bottom) };
        }
        const top = pad;
        const bottom =
            (window.innerHeight || 0) - pad - (m.mode === 'overlay' ? Math.max(0, m.imeOverlap) : 0);
        return { top, bottom: Math.max(top + 40, bottom) };
    };

    const run = () => {
        if (!document.contains(target) || document.activeElement !== target) return;
        const band = visibleBand();
        const scrollParent = findScrollParent(target);
        if (!scrollParent) {
            if (suppressDocumentScroll) return;
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
            // 핀된 시트 안에서는 스크롤 부모 clip을 우선 (VV 밴드와 이중 좌표계 충돌 방지)
            const clipTop = suppressDocumentScroll
                ? sRect.top + pad
                : Math.max(sRect.top, band.top);
            const clipBottom = suppressDocumentScroll
                ? Math.max(clipTop + 40, sRect.bottom - pad)
                : Math.min(sRect.bottom, band.bottom);

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

            if (suppressDocumentScroll) return;

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
 * 요소를 visualViewport 박스에 핀 (기록시트 등 강제 핀용).
 * - 루트 시프트 중: 이미 VV 프레임이므로 top/left=0, 크기는 루트 client
 * - 그 외: layout 좌표의 vv.offsetTop/height
 * @param {HTMLElement|null} el
 * @param {{ force?: boolean }} [opts] force면 open 전이라도 현재 VV에 핀
 */
export function pinElementToVisualViewport(el, opts = {}) {
    if (!el) return false;
    const m = getImeMetrics();
    if (m.mode === 'resize') return false;
    const focusPending =
        isMobileWebTouchUi() &&
        isImeInputLike(document.activeElement) &&
        Date.now() < focusPollUntil;
    if (!opts.force && !m.open && !focusPending) return false;

    const vv = window.visualViewport;
    const rootShifted = isWebImeRootShifted();
    let pinTop;
    let pinLeft;
    let pinHeight;
    let pinWidth;
    if (rootShifted) {
        const de = document.documentElement;
        pinTop = 0;
        pinLeft = 0;
        pinHeight = Math.max(
            120,
            Math.round(de?.clientHeight || m.vvH || Number(vv?.height) || window.innerHeight || 0)
        );
        pinWidth = Math.max(
            120,
            Math.round(de?.clientWidth || m.pinWidth || Number(vv?.width) || window.innerWidth || 0)
        );
    } else {
        pinTop = Math.max(0, Math.round(Number(vv?.offsetTop) || m.vvTop || 0));
        pinLeft = Math.max(0, Math.round(Number(vv?.offsetLeft) || m.pinLeft || 0));
        pinHeight = Math.max(
            120,
            Math.round(Number(vv?.height) || m.vvH || window.innerHeight || 0)
        );
        pinWidth = Math.max(
            120,
            Math.round(Number(vv?.width) || m.pinWidth || window.innerWidth || 0)
        );
    }

    el.classList.add('is-ime-open');
    el.style.top = `${pinTop}px`;
    el.style.left = `${pinLeft}px`;
    el.style.width = `${pinWidth}px`;
    el.style.height = `${pinHeight}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = '';
    return true;
}

/**
 * overlay 모드에서만 VV 박스 핀. resize·웹 루트 시프트 중에는 no-op(이중 핀 금지).
 * 기록시트는 pinElementToVisualViewport(..., { force: true })를 사용.
 */
export function applyOverlayImePin(root) {
    if (!root) return false;
    const m = getImeMetrics();
    if (m.mode === 'resize') return false;
    // 웹 전체 시프트가 켜져 있으면 일반 오버레이 개별 핀 불필요
    if (isWebImeRootShifted() || (m.mode === 'overlay' && imeOpen)) {
        return false;
    }
    return pinElementToVisualViewport(root, { force: false });
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
        window.visualViewport.addEventListener(
            'scroll',
            () => {
                if (imeOpen && getImeMetrics().mode === 'overlay') applyWebImeRootShift();
                scheduleSync();
            },
            { passive: true }
        );
    }
    window.addEventListener('resize', scheduleSyncBurst, { passive: true });
}
