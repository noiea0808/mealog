/**
 * 기록 시트 — 기본 / 추가 / 상세 탭
 */
/**
 * 2단계 구성. 어디서·누구와 전용 페이지('more')는 제거했다 —
 * 맥락 한 줄이 1페이지에서 세 축을 모두 처리하고, 전체 축 섹션은 같은 페이지의
 * '자세히' 접힘으로 내려갔다 (docs/entry-axes-and-tags-direction.md §5).
 */
const TAB_IDS = /** @type {const} */ (['basic', 'detail']);

/** @typedef {'basic'|'detail'} EntrySheetTabId */

const TAB_LABELS = /** @type {Record<EntrySheetTabId, string>} */ ({
    basic: '뭘 먹었어요?',
    detail: '어땠어요?',
});

let tabsBound = false;
/** @type {EntrySheetTabId} */
let activeTab = 'basic';
/** 사진 없을 때 기본 탭 기준 패널 높이(px) */
let entrySheetBaseMinHeightPx = 0;
/** 이번 모달 세션에서 한번이라도 커진 최대 패널 높이 — 탭 전환 시 축소·재중앙정렬 방지 */
let entrySheetPeakHeightPx = 0;
/** 현재 적용 중인 패널 top(px). 작을수록 헤더가 위. 세션 중 증가(헤더 하강) 금지 */
let entrySheetTopPx = null;
/** 탭 슬라이드 전환 중이면 true */
let tabAnimating = false;
/** 진행 중 전환 취소/교체용 토큰 */
let tabAnimToken = 0;

const TAB_ANIM_MS = 300;
const TAB_ANIM_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

/** @returns {EntrySheetTabId} */
export function getEntrySheetTab() {
    return activeTab;
}

function getEntryModalPanel() {
    return document.querySelector('#entryModal .entry-modal-panel');
}

function entrySheetHasPhotos() {
    return !!document.querySelector('#entryModal .entry-photo-section--has-photos');
}

function prefersReducedMotion() {
    try {
        return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    } catch (_) {
        return false;
    }
}

function getEntrySheetMaxHeightPx() {
    const modal = document.getElementById('entryModal');
    const vh = modal?.clientHeight || window.innerHeight || 0;
    if (!(vh > 0)) return 0;
    const top = entrySheetTopPx != null ? entrySheetTopPx : 16;
    const bottomPad = 16;
    const byLayout = Math.max(0, vh - top - bottomPad);
    const byVh = Math.floor(vh * 0.8);
    return Math.max(0, Math.min(byLayout, byVh));
}

function applyEntrySheetHeightLock() {
    const panel = getEntryModalPanel();
    const modal = document.getElementById('entryModal');
    if (!panel) return;
    const maxH = getEntrySheetMaxHeightPx();
    let lockH = Math.max(entrySheetBaseMinHeightPx, entrySheetPeakHeightPx);
    if (maxH > 0 && lockH > maxH) lockH = maxH;
    if (lockH > 0) {
        const px = `${lockH}px`;
        panel.style.setProperty('--entry-sheet-min-h', px);
        panel.style.setProperty('--entry-sheet-h', px);
        panel.style.height = px;
        panel.style.minHeight = px;
        // CSS max-height(80vh)가 먹도록 인라인 maxHeight는 비움
        panel.style.maxHeight = '';
    } else {
        panel.style.removeProperty('--entry-sheet-min-h');
        panel.style.removeProperty('--entry-sheet-h');
        panel.style.height = '';
        panel.style.minHeight = '';
    }
    // top은 세션 중 한 번 잡히면 내려가지 않음(헤더↓ 금지). 인라인으로 강제.
    panel.style.position = 'absolute';
    panel.style.bottom = 'auto';
    panel.style.marginTop = '0';
    panel.style.marginBottom = '0';
    if (entrySheetTopPx != null && modal) {
        modal.style.setProperty('--entry-sheet-top', `${entrySheetTopPx}px`);
        panel.style.top = `${entrySheetTopPx}px`;
    }
}

/**
 * 패널 높이에 맞는 이상적 top. 헤더는 위로만 이동 가능(top 값 감소만 허용).
 * @param {number} panelHeightPx
 */
function ratchetEntrySheetTopForHeight(panelHeightPx) {
    const modal = document.getElementById('entryModal');
    const panel = getEntryModalPanel();
    if (!modal || !(panelHeightPx > 0)) return;
    const vh = modal.clientHeight || window.innerHeight || 0;
    if (!(vh > 0)) return;
    const bottomPad = 16;
    const ideal = Math.floor((vh - panelHeightPx) / 2);
    const maxTop = Math.max(16, vh - panelHeightPx - bottomPad);
    const next = Math.max(16, Math.min(ideal, maxTop));
    if (entrySheetTopPx == null || next < entrySheetTopPx) {
        entrySheetTopPx = next;
        modal.style.setProperty('--entry-sheet-top', `${next}px`);
        if (panel) {
            panel.style.position = 'absolute';
            panel.style.top = `${next}px`;
            panel.style.bottom = 'auto';
            panel.style.marginTop = '0';
            panel.style.marginBottom = '0';
        }
    }
}

/** 연속 sync(태그 렌더 등) 합치기 */
let entrySheetSyncHeightRaf = 0;

/**
 * 자연 높이로 잠깐 측정해 피크·top을 갱신한 뒤, 피크 높이로 다시 잠근다.
 * 사진/서브태그/메모 확장으로 커질 때는 헤더가 올라갈 수 있고, 이후 탭 전환에서는 축소되지 않는다.
 * @param {{ growthPx?: number }} [opts] growthPx: 키보드 열린 동안 내용이 늘어난 만큼 peak만 반영
 */
export function syncEntrySheetHeightLock(opts = {}) {
    const modal = document.getElementById('entryModal');
    const panel = getEntryModalPanel();
    if (!modal || !panel || modal.classList.contains('hidden')) return;
    // 키보드 열린 동안 peak/top 재측정·rachet 금지 (시트가 흔들리거나 위로 붙는 원인)
    // 단, 메모 확장 등으로 늘어난 분은 peak에만 쌓아 키보드 닫힌 뒤 시트 높이에 반영
    if (modal.classList.contains('keyboard-open')) {
        const growth = Number(opts?.growthPx) || 0;
        if (growth > 0) {
            entrySheetPeakHeightPx = Math.max(
                entrySheetBaseMinHeightPx,
                entrySheetPeakHeightPx + growth
            );
            /**
             * 늘어난 만큼을 **그 자리에서** 잠금 높이에 반영한다.
             * peak 에만 쌓아 두고 키보드가 닫힐 때까지 미뤘더니, 포커스로 회상 줄·분류
             * 제안이 뜨는 동안 그 아래 맥락 줄이 패널 밖으로 밀려 아래가 잘렸다.
             * 위 가드가 막으려는 건 자연 높이 **재측정**과 top ratchet 이고, 여기서는
             * 이미 아는 증가분으로 잠금 높이만 키우므로 그 둘은 일어나지 않는다.
             */
            applyEntrySheetHeightLock();
        }
        return;
    }

    const floor = Math.max(entrySheetBaseMinHeightPx, entrySheetPeakHeightPx);
    panel.style.setProperty('--entry-sheet-min-h', floor > 0 ? `${floor}px` : '0px');
    panel.style.setProperty('--entry-sheet-h', 'auto');
    // 인라인 height가 남아 있으면 피크가 안 올라가 탭 전환 시 다시 줄어든 것처럼 보임
    panel.style.height = 'auto';
    panel.style.minHeight = floor > 0 ? `${floor}px` : '';

    if (entrySheetSyncHeightRaf) cancelAnimationFrame(entrySheetSyncHeightRaf);
    entrySheetSyncHeightRaf = requestAnimationFrame(() => {
        entrySheetSyncHeightRaf = 0;
        if (modal.classList.contains('hidden') || modal.classList.contains('keyboard-open')) return;
        const h = Math.ceil(panel.getBoundingClientRect().height);
        if (h > entrySheetPeakHeightPx) {
            entrySheetPeakHeightPx = h;
            ratchetEntrySheetTopForHeight(h);
        }
        applyEntrySheetHeightLock();
    });
}

if (typeof window !== 'undefined') {
    window.syncEntrySheetHeightLock = syncEntrySheetHeightLock;
}

/** 모달 열 때 기준 높이 초기화 */
export function resetEntrySheetBaseHeight() {
    entrySheetBaseMinHeightPx = 0;
    entrySheetPeakHeightPx = 0;
    entrySheetTopPx = null;
    const modal = document.getElementById('entryModal');
    const panel = getEntryModalPanel();
    modal?.style.removeProperty('--entry-sheet-top');
    if (panel) {
        panel.style.top = '';
        panel.style.height = '';
        panel.style.minHeight = '';
        panel.style.removeProperty('--entry-sheet-min-h');
        panel.style.removeProperty('--entry-sheet-h');
    }
    applyEntrySheetHeightLock();
}

/**
 * 기준 높이 측정 시 인라인 높이를 잠시 비워 CSS 프로브(메모 1줄 등)가 먹게 함.
 * @returns {() => void} restore
 */
function beginEntrySheetHeightProbe(modal) {
    modal.classList.add('entry-sheet-height-probe');
    /** @type {{ el: HTMLElement, height: string, minHeight: string, maxHeight: string }[]} */
    const commentSnaps = [];
    ['generalCommentInput', 'snackCommentInput'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        commentSnaps.push({
            el,
            height: el.style.height,
            minHeight: el.style.minHeight,
            maxHeight: el.style.maxHeight,
        });
        el.style.height = '';
        el.style.minHeight = '';
        el.style.maxHeight = '';
    });
    return () => {
        modal.classList.remove('entry-sheet-height-probe');
        commentSnaps.forEach(({ el, height, minHeight, maxHeight }) => {
            el.style.height = height;
            el.style.minHeight = minHeight;
            el.style.maxHeight = maxHeight;
        });
    };
}

/**
 * 사진 없는 기본 탭 기준 높이를 잠근다.
 * 측정 가정: 무엇을 메인 태그·사용자 태그 행이 보이고, 메모는 접힌 1줄.
 * @param {{ force?: boolean }} [opts]
 */
export function captureEntrySheetBaseHeight(opts = {}) {
    const modal = document.getElementById('entryModal');
    const panel = getEntryModalPanel();
    if (!modal || !panel || modal.classList.contains('hidden')) return;
    if (entrySheetHasPhotos()) {
        // 사진 포함 상태로 열림: 자연 높이로 피크·top 갱신
        syncEntrySheetHeightLock();
        return;
    }
    if (entrySheetBaseMinHeightPx > 0 && !opts.force) {
        applyEntrySheetHeightLock();
        if (entrySheetTopPx == null && entrySheetBaseMinHeightPx > 0) {
            ratchetEntrySheetTopForHeight(entrySheetBaseMinHeightPx);
        }
        return;
    }

    const prevTab = activeTab;
    const scroll = document.getElementById('modalScrollArea');
    const prevScroll = scroll?.scrollTop ?? 0;
    const prevScrollFlex = scroll?.style.flex ?? '';
    const endProbe = beginEntrySheetHeightProbe(modal);

    panel.style.removeProperty('--entry-sheet-min-h');
    panel.style.removeProperty('--entry-sheet-h');
    // 측정 시 flex-grow로 불필요하게 늘어난 높이가 잡히지 않도록
    if (scroll) scroll.style.flex = '0 0 auto';
    if (prevTab !== 'basic') {
        setEntrySheetTab('basic');
    }

    // 프로브 레이아웃 반영 후 측정
    const h = Math.ceil(panel.getBoundingClientRect().height);
    if (h > 0) {
        entrySheetBaseMinHeightPx = h;
        if (h > entrySheetPeakHeightPx) entrySheetPeakHeightPx = h;
    }

    endProbe();
    if (scroll) scroll.style.flex = prevScrollFlex;
    applyEntrySheetHeightLock();
    if (entrySheetBaseMinHeightPx > 0) {
        ratchetEntrySheetTopForHeight(entrySheetBaseMinHeightPx);
    }

    if (prevTab !== 'basic') {
        setEntrySheetTab(prevTab);
    }
    if (scroll) scroll.scrollTop = prevScroll;
}

function getEntrySheetPanel(tabId) {
    return document.querySelector(`#entryModal [data-entry-sheet-panel="${tabId}"]`);
}

function clearPanelMotionStyles(panel) {
    if (!panel) return;
    panel.style.transition = '';
    panel.style.transform = '';
    panel.style.opacity = '';
    panel.style.position = '';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.width = '';
    panel.style.zIndex = '';
    panel.style.pointerEvents = '';
    panel.style.willChange = '';
    panel.classList.remove(
        'entry-sheet-tabpanel--dragging',
        'entry-sheet-tabpanel--leaving',
        'entry-sheet-tabpanel--entering'
    );
}

function clearSwipeViewportStyles() {
    const scroll = document.getElementById('modalScrollArea');
    if (!scroll) return;
    scroll.classList.remove('entry-sheet-animating', 'entry-sheet-dragging');
    scroll.style.minHeight = '';
}

function updateEntrySheetTabButtons(tabId) {
    const root = document.getElementById('entryModal');
    if (!root) return;
    root.querySelectorAll('[data-entry-sheet-tab]').forEach((btn) => {
        const on = btn.getAttribute('data-entry-sheet-tab') === tabId;
        btn.classList.toggle('entry-sheet-tab--active', on);
        btn.classList.toggle('entry-sheet-step-dot--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
    });
    syncEntrySheetStepChrome(tabId);
}

/** 상단 현재 단계 라벨 + 하단 이전/다음 유도 버튼 */
function syncEntrySheetStepChrome(tabId) {
    const labelEl = document.getElementById('entrySheetStepLabel');
    if (labelEl) labelEl.textContent = TAB_LABELS[tabId] || '';

    const navBar = document.getElementById('entrySheetNavBar');
    const prevBtn = document.getElementById('entrySheetPrevBtn');
    const nextBtn = document.getElementById('entrySheetNextBtn');
    const prevLabel = document.getElementById('entrySheetPrevLabel');
    const nextLabel = document.getElementById('entrySheetNextLabel');
    const enabled = getEnabledEntrySheetTabIds();
    const idx = enabled.indexOf(tabId);
    const prevId = idx > 0 ? enabled[idx - 1] : null;
    const nextId = idx >= 0 ? enabled[idx + 1] : null;
    const showPrev = !!prevId;
    const showNext = !!nextId;

    if (navBar) {
        const showBar = showPrev || showNext;
        navBar.classList.toggle('hidden', !showBar);
        navBar.classList.toggle('entry-sheet-nav-bar--single', showPrev !== showNext);
        navBar.setAttribute('aria-hidden', showBar ? 'false' : 'true');
    }

    if (prevBtn) {
        prevBtn.classList.toggle('hidden', !showPrev);
        prevBtn.disabled = !showPrev;
        if (showPrev) {
            prevBtn.setAttribute('aria-label', `이전: ${TAB_LABELS[prevId]}`);
            prevBtn.dataset.prevTab = prevId;
        } else {
            prevBtn.removeAttribute('aria-label');
            delete prevBtn.dataset.prevTab;
        }
    }
    if (prevLabel && showPrev) prevLabel.textContent = TAB_LABELS[prevId];

    if (nextBtn) {
        nextBtn.classList.toggle('hidden', !showNext);
        nextBtn.disabled = !showNext;
        if (showNext) {
            nextBtn.setAttribute('aria-label', `다음: ${TAB_LABELS[nextId]}`);
            nextBtn.dataset.nextTab = nextId;
        } else {
            nextBtn.removeAttribute('aria-label');
            delete nextBtn.dataset.nextTab;
        }
    }
    if (nextLabel && showNext) nextLabel.textContent = TAB_LABELS[nextId];
}

/** 패널 show/hide·inert·스크롤 리셋 (애니메이션 없음) */
function applyEntrySheetTabState(tabId, { resetScroll = true } = {}) {
    activeTab = tabId;
    const root = document.getElementById('entryModal');
    if (!root) return;

    updateEntrySheetTabButtons(tabId);

    root.querySelectorAll('[data-entry-sheet-panel]').forEach((panel) => {
        const on = panel.getAttribute('data-entry-sheet-panel') === tabId;
        clearPanelMotionStyles(panel);
        panel.classList.toggle('hidden', !on);
        panel.toggleAttribute('hidden', !on);
        if (on) panel.removeAttribute('inert');
        else panel.setAttribute('inert', '');
    });

    clearSwipeViewportStyles();
    applyEntrySheetHeightLock();

    const scroll = document.getElementById('modalScrollArea');
    if (scroll && resetScroll) scroll.scrollTop = 0;
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** 드래그 저항이 반영된 실제 translateX */
function getRubberBandOffset(offsetX) {
    const enabled = getEnabledEntrySheetTabIds();
    const idx = enabled.indexOf(activeTab);
    const canPrev = idx > 0;
    const canNext = idx >= 0 && idx < enabled.length - 1;
    let tx = offsetX;
    if ((tx > 0 && !canPrev) || (tx < 0 && !canNext)) {
        tx *= 0.28;
    }
    return tx;
}

/**
 * from → to 슬라이드 전환.
 * @param {EntrySheetTabId} fromId
 * @param {EntrySheetTabId} toId
 * @param {1|-1} direction +1=다음(왼쪽으로), -1=이전(오른쪽으로)
 * @param {number} [startOffsetPx] 드래그 중 이어서 커밋할 때 현재 translateX(저항 미적용 raw)
 */
async function animateEntrySheetTabChange(fromId, toId, direction, startOffsetPx = 0) {
    if (prefersReducedMotion()) {
        applyEntrySheetTabState(toId);
        return;
    }

    const root = document.getElementById('entryModal');
    const scroll = document.getElementById('modalScrollArea');
    const fromPanel = getEntrySheetPanel(fromId);
    const toPanel = getEntrySheetPanel(toId);
    if (!root || !scroll || !fromPanel || !toPanel) {
        applyEntrySheetTabState(toId);
        return;
    }

    const token = ++tabAnimToken;
    tabAnimating = true;
    updateEntrySheetTabButtons(toId);
    // 탭 전환 시작 전 피크 높이·top 재고정 (축소·재중앙정렬 방지)
    applyEntrySheetHeightLock();

    const width = Math.max(scroll.clientWidth, 1);
    const outX = direction > 0 ? -width : width;
    const inFrom = direction > 0 ? width : -width;
    const dragX = getRubberBandOffset(startOffsetPx);

    // 전환 중 높이 출렁임 방지
    scroll.style.minHeight = `${Math.ceil(scroll.getBoundingClientRect().height)}px`;
    scroll.classList.add('entry-sheet-animating');
    scroll.classList.remove('entry-sheet-dragging');

    // 끼어든 전환 대비: from/to 외 패널은 즉시 숨김
    root.querySelectorAll('[data-entry-sheet-panel]').forEach((panel) => {
        if (panel === fromPanel || panel === toPanel) return;
        clearPanelMotionStyles(panel);
        panel.classList.add('hidden');
        panel.setAttribute('hidden', '');
        panel.setAttribute('inert', '');
    });

    toPanel.classList.remove('hidden');
    toPanel.removeAttribute('hidden');
    toPanel.setAttribute('inert', '');
    clearPanelMotionStyles(toPanel);
    clearPanelMotionStyles(fromPanel);
    fromPanel.classList.remove('hidden');
    fromPanel.removeAttribute('hidden');

    fromPanel.classList.add('entry-sheet-tabpanel--leaving');
    toPanel.classList.add('entry-sheet-tabpanel--entering');
    fromPanel.style.willChange = 'transform, opacity';
    toPanel.style.willChange = 'transform, opacity';
    toPanel.style.position = 'absolute';
    toPanel.style.left = '0';
    toPanel.style.top = `${scroll.scrollTop}px`;
    toPanel.style.width = '100%';
    toPanel.style.zIndex = '2';
    toPanel.style.pointerEvents = 'none';

    const progress = Math.min(1, Math.abs(dragX) / width);
    const startTo = inFrom + dragX;
    const startOpacityFrom = 1 - progress * 0.2;
    const startOpacityTo = 0.88 + progress * 0.12;

    fromPanel.style.transition = 'none';
    toPanel.style.transition = 'none';
    fromPanel.style.transform = `translate3d(${dragX}px,0,0)`;
    fromPanel.style.opacity = String(startOpacityFrom);
    toPanel.style.transform = `translate3d(${startTo}px,0,0)`;
    toPanel.style.opacity = String(startOpacityTo);

    await nextFrame();
    await nextFrame();
    if (token !== tabAnimToken) return;

    const transition = `transform ${TAB_ANIM_MS}ms ${TAB_ANIM_EASE}, opacity ${TAB_ANIM_MS}ms ${TAB_ANIM_EASE}`;
    fromPanel.style.transition = transition;
    toPanel.style.transition = transition;
    fromPanel.style.transform = `translate3d(${outX}px,0,0)`;
    fromPanel.style.opacity = '0';
    toPanel.style.transform = 'translate3d(0,0,0)';
    toPanel.style.opacity = '1';

    await waitMs(TAB_ANIM_MS + 20);
    if (token !== tabAnimToken) return;

    applyEntrySheetTabState(toId);
    tabAnimating = false;
}

/**
 * @param {EntrySheetTabId|string} tabId
 * @param {{ animate?: boolean }} [opts]
 */
export function setEntrySheetTab(tabId, opts = {}) {
    const next = TAB_IDS.includes(/** @type {EntrySheetTabId} */ (tabId))
        ? /** @type {EntrySheetTabId} */ (tabId)
        : 'basic';
    const prev = activeTab;

    if (next === prev) {
        applyEntrySheetTabState(next, { resetScroll: false });
        return;
    }

    // 진행 중 애니메이션 무효화 후 새 전환
    tabAnimToken += 1;
    tabAnimating = false;

    const animate = !!opts.animate && !prefersReducedMotion();
    if (!animate) {
        applyEntrySheetTabState(next);
        return;
    }

    const fromIdx = TAB_IDS.indexOf(prev);
    const toIdx = TAB_IDS.indexOf(next);
    const direction = /** @type {1|-1} */ (toIdx >= fromIdx ? 1 : -1);
    void animateEntrySheetTabChange(prev, next, direction, 0);
}

export function resetEntrySheetTab() {
    tabAnimToken += 1;
    tabAnimating = false;
    applyEntrySheetTabState('basic');
}

/** Skip 시 상세(어땠지?) 탭 비활성 */
export function setEntrySheetTabsForSkip(isSkip) {
    const skip = !!isSkip;
    const btn = document.querySelector('#entrySheetTabs [data-entry-sheet-tab="detail"]');
    if (btn) {
        btn.toggleAttribute('disabled', skip);
        btn.classList.toggle('entry-sheet-tab--disabled', skip);
        btn.classList.toggle('entry-sheet-step-dot--disabled', skip);
        btn.setAttribute('aria-disabled', skip ? 'true' : 'false');
    }
    if (skip && activeTab === 'detail') {
        setEntrySheetTab('basic');
    } else {
        syncEntrySheetStepChrome(activeTab);
    }
}

/** 스와이프를 가로 스크롤·입력과 구분하기 위한 제외 영역 */
const TAB_SWIPE_IGNORE_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable="true"]',
    '.overflow-x-auto',
    '.entry-photo-preview-row',
    '.entry-subtag-suggestions',
    '.entry-subtag-chips',
    '.entry-detail-record-chips',
    '.entry-hscroll-strip',
].join(', ');

function getEnabledEntrySheetTabIds() {
    return TAB_IDS.filter((id) => {
        const btn = document.querySelector(`#entrySheetTabs [data-entry-sheet-tab="${id}"]`);
        return !!btn && !btn.hasAttribute('disabled');
    });
}

/** @param {number} delta -1=이전, +1=다음 */
function goToAdjacentEntrySheetTab(delta, startOffsetPx = 0) {
    const enabled = getEnabledEntrySheetTabIds();
    const idx = enabled.indexOf(activeTab);
    if (idx < 0) return false;
    const next = enabled[idx + delta];
    if (!next) return false;
    const prev = activeTab;
    tabAnimToken += 1;
    tabAnimating = false;
    void animateEntrySheetTabChange(prev, next, /** @type {1|-1} */ (delta), startOffsetPx);
    return true;
}

function setDragVisual(offsetX) {
    const scroll = document.getElementById('modalScrollArea');
    const panel = getEntrySheetPanel(activeTab);
    if (!scroll || !panel) return;
    const width = Math.max(scroll.clientWidth, 1);
    const tx = getRubberBandOffset(offsetX);
    const progress = Math.min(1, Math.abs(tx) / width);
    scroll.classList.add('entry-sheet-dragging');
    panel.classList.add('entry-sheet-tabpanel--dragging');
    panel.style.willChange = 'transform, opacity';
    panel.style.transition = 'none';
    panel.style.transform = `translate3d(${tx}px,0,0)`;
    panel.style.opacity = String(1 - progress * 0.18);
}

function snapBackDrag(fromOffsetX) {
    const scroll = document.getElementById('modalScrollArea');
    const panel = getEntrySheetPanel(activeTab);
    if (!panel) {
        clearSwipeViewportStyles();
        return;
    }
    if (prefersReducedMotion() || Math.abs(fromOffsetX) < 1) {
        clearPanelMotionStyles(panel);
        clearSwipeViewportStyles();
        return;
    }
    panel.style.transition = `transform ${TAB_ANIM_MS}ms ${TAB_ANIM_EASE}, opacity ${TAB_ANIM_MS}ms ${TAB_ANIM_EASE}`;
    panel.style.transform = 'translate3d(0,0,0)';
    panel.style.opacity = '1';
    const token = ++tabAnimToken;
    window.setTimeout(() => {
        if (token !== tabAnimToken) return;
        clearPanelMotionStyles(panel);
        clearSwipeViewportStyles();
    }, TAB_ANIM_MS + 20);
    scroll?.classList.remove('entry-sheet-dragging');
}

/**
 * 기록시트 본문·탭바 가로 스와이프로 탭 전환.
 * 세로 스크롤·가로 칩/사진 스트립·입력란과는 방향·대상으로 구분.
 */
function bindEntrySheetTabSwipeOnce() {
    const areas = [
        document.getElementById('modalScrollArea'),
        document.getElementById('entrySheetTabs'),
    ].filter(Boolean);
    if (!areas.length) return;

    const AXIS_LOCK_PX = 12;
    const SWIPE_THRESHOLD_PX = 56;
    const HORIZ_RATIO = 1.25;

    /** @type {null | { pointerId: number, startX: number, startY: number, area: HTMLElement, locked: 'pending'|'horiz'|'vert'|'ignore', captured: boolean }} */
    let state = null;

    const endSwipe = (e) => {
        if (!state || e.pointerId !== state.pointerId) return;
        const { area, startX, locked, captured } = state;
        const dx = e.clientX - startX;
        if (locked === 'horiz') {
            const visualX = getRubberBandOffset(dx);
            if (Math.abs(dx) >= SWIPE_THRESHOLD_PX) {
                const moved = goToAdjacentEntrySheetTab(dx < 0 ? 1 : -1, dx);
                if (!moved) snapBackDrag(visualX);
            } else {
                snapBackDrag(visualX);
            }
        }
        if (captured) {
            try {
                area.releasePointerCapture(e.pointerId);
            } catch (_) { /* ignore */ }
        }
        state = null;
    };

    for (const area of areas) {
        if (area._entryTabSwipeBound) continue;
        area._entryTabSwipeBound = true;

        area.addEventListener(
            'pointerdown',
            (e) => {
                if (e.button !== 0) return;
                if (state || tabAnimating) return;
                if (e.target.closest?.(TAB_SWIPE_IGNORE_SELECTOR)) return;
                state = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    area,
                    locked: 'pending',
                    captured: false,
                };
            },
            { passive: true }
        );

        area.addEventListener(
            'pointermove',
            (e) => {
                if (!state || e.pointerId !== state.pointerId || state.area !== area) return;
                const dx = e.clientX - state.startX;
                const dy = e.clientY - state.startY;
                const adx = Math.abs(dx);
                const ady = Math.abs(dy);

                if (state.locked === 'pending') {
                    if (adx < AXIS_LOCK_PX && ady < AXIS_LOCK_PX) return;
                    if (adx >= ady * HORIZ_RATIO && adx >= AXIS_LOCK_PX) {
                        state.locked = 'horiz';
                        try {
                            area.setPointerCapture(e.pointerId);
                            state.captured = true;
                        } catch (_) { /* ignore */ }
                    } else {
                        // 세로 스크롤·모호한 제스처는 탭 전환에 쓰지 않음
                        state.locked = ady > adx ? 'vert' : 'ignore';
                        return;
                    }
                }

                if (state.locked === 'horiz') {
                    setDragVisual(dx);
                    e.preventDefault();
                }
            },
            { passive: false }
        );

        area.addEventListener('pointerup', endSwipe);
        area.addEventListener('pointercancel', endSwipe);
    }
}

export function bindEntrySheetTabsOnce() {
    if (tabsBound) return;
    tabsBound = true;
    const tabs = document.getElementById('entrySheetTabs');
    if (!tabs) return;

    tabs.addEventListener('click', (e) => {
        const btn = e.target.closest?.('[data-entry-sheet-tab]');
        if (!btn || !tabs.contains(btn) || btn.hasAttribute('disabled')) return;
        const tab = btn.getAttribute('data-entry-sheet-tab');
        if (tab) setEntrySheetTab(tab, { animate: true });
    });

    tabs.addEventListener('keydown', (e) => {
        const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
        if (!keys.includes(e.key)) return;
        const buttons = [...tabs.querySelectorAll('[data-entry-sheet-tab]:not([disabled])')];
        if (!buttons.length) return;
        const current = document.activeElement?.closest?.('[data-entry-sheet-tab]');
        let idx = Math.max(0, buttons.indexOf(current));
        if (e.key === 'ArrowLeft') idx = (idx - 1 + buttons.length) % buttons.length;
        else if (e.key === 'ArrowRight') idx = (idx + 1) % buttons.length;
        else if (e.key === 'Home') idx = 0;
        else if (e.key === 'End') idx = buttons.length - 1;
        e.preventDefault();
        const next = buttons[idx];
        const tab = next?.getAttribute('data-entry-sheet-tab');
        if (tab) {
            setEntrySheetTab(tab, { animate: true });
            next.focus();
        }
    });

    const prevBtn = document.getElementById('entrySheetPrevBtn');
    prevBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        const prevId = prevBtn.dataset.prevTab;
        if (prevId) setEntrySheetTab(prevId, { animate: true });
        else goToAdjacentEntrySheetTab(-1);
    });

    const nextBtn = document.getElementById('entrySheetNextBtn');
    nextBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        const nextId = nextBtn.dataset.nextTab;
        if (nextId) setEntrySheetTab(nextId, { animate: true });
        else goToAdjacentEntrySheetTab(1);
    });

    bindEntrySheetTabSwipeOnce();
    applyEntrySheetTabState(activeTab, { resetScroll: false });
}
