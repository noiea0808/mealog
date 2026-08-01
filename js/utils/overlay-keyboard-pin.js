/**
 * 검색·알림 센터 다이얼로그 / 모먼트 댓글 시트 / 프로필·신고·밀톡 수정:
 * 키보드로 visualViewport가 밀릴 때 fixed 오버레이·입력란이 함께 올라가는 현상 완화.
 * 오버레이를 visualViewport 박스에 맞추고 레이아웃 스크롤을 원위치한다.
 */

const OVERLAY_ROOT_SELECTORS = [
    '#timelineSearchModal',
    '#momentSearchModal',
    '#boardSearchModal',
    '#notificationModal',
    '#profileFieldEditModal',
    '#feedBubbleEditOverlay',
    '#reportModal',
    '.moment-v2-social-comments-panel--sheet-in-body'
];

let activeRoot = null;
let syncRaf = null;
let pinTimers = [];
let initialized = false;
/** 포커스 직전 레이아웃 높이 — adjustResize로 innerHeight만 줄어드는 기기 감지용 */
let focusBaselineLayoutH = 0;

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

function clearOverlayVvPin(root) {
    if (!root) return;
    placeProfileFieldEditActions(root, false);
    root.classList.remove('is-ime-open');
    root.style.top = '';
    root.style.left = '';
    root.style.right = '';
    root.style.bottom = '';
    root.style.height = '';
    root.style.width = '';
    root.style.transform = '';
}

function isSearchFilterModal(root) {
    return !!root?.classList?.contains('search-filter-modal')
        && root.id !== 'notificationModal';
}

function isKeyboardLikelyOpen() {
    const layoutH = window.innerHeight || 0;
    if (!(layoutH > 0)) return false;
    const vv = window.visualViewport;
    const vvH = vv ? Number(vv.height) || layoutH : layoutH;
    const vvTop = vv ? Number(vv.offsetTop) || 0 : 0;
    const baseline = focusBaselineLayoutH > 0 ? focusBaselineLayoutH : layoutH;
    // 1) VV가 레이아웃보다 작음  2) adjustResize로 innerHeight 자체 축소  3) VV가 위로 밀림
    return (
        vvH < layoutH * 0.92
        || layoutH < baseline * 0.92
        || vvTop > 8
    );
}

function scrollActiveIntoSearchBody(root) {
    if (!isSearchFilterModal(root)) return;
    const ae = document.activeElement;
    const body = root.querySelector('.search-filter-modal__body');
    if (!ae || !body || !body.contains(ae)) return;
    try {
        ae.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch (_) { /* ignore */ }
}

function applyOverlayVvPin(root) {
    const vv = window.visualViewport;
    if (!root) return;
    pinLayoutScroll();
    if (!isKeyboardLikelyOpen()) {
        // 포커스만 있고 키보드가 없으면 인라인 핀·상단 정렬을 걸지 않음 (웹 데스크톱)
        // 검색 모달은 CSS :has(input:focus)로 상단 도킹·본문 스크롤이 이미 적용됨
        clearOverlayVvPin(root);
        return;
    }
    root.classList.add('is-ime-open');
    placeProfileFieldEditActions(root, true);

    const layoutH = window.innerHeight || 0;
    const top = vv ? Math.max(0, Number(vv.offsetTop) || 0) : 0;
    const left = vv ? Math.max(0, Number(vv.offsetLeft) || 0) : 0;
    // adjustResize: VV≈innerHeight → 레이아웃 박스 그대로. VV 축소(iOS 등): VV 박스에 핀.
    const h = Math.max(
        120,
        Math.round(vv ? Math.min(Number(vv.height) || layoutH, layoutH) : layoutH)
    );
    const w = Math.max(
        120,
        Math.round(vv ? Number(vv.width) || window.innerWidth || 0 : window.innerWidth || 0)
    );

    // fixed inset-0 오버레이를 보이는 영역에 맞춤 (키보드 위로 통째로 밀림 방지)
    root.style.top = `${Math.round(top)}px`;
    root.style.left = `${Math.round(left)}px`;
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = '';

    requestAnimationFrame(() => scrollActiveIntoSearchBody(root));
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
            // 동적으로 제거된 오버레이(신고·밀톡 수정)도 안전하게 정리
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
            if (!isInputLike(e.target) || !findOverlayRoot(e.target)) return;
            const layoutH = window.innerHeight || 0;
            const vvH = window.visualViewport?.height ?? layoutH;
            focusBaselineLayoutH = Math.max(layoutH, vvH, focusBaselineLayoutH || 0);
            scheduleSyncBurst();
            // 검색: 키보드 애니 후에도 입력란이 본문 스크롤 안에 보이도록
            const root = findOverlayRoot(e.target);
            if (isSearchFilterModal(root)) {
                [50, 150, 320, 500].forEach((ms) => {
                    pinTimers.push(setTimeout(() => scrollActiveIntoSearchBody(root), ms));
                });
            }
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
                    if (!isInputLike(document.activeElement)) {
                        focusBaselineLayoutH = 0;
                    }
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
