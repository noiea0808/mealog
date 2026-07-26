/**
 * 기록 시트 — 기본 / 추가 / 상세 탭
 */
const TAB_IDS = /** @type {const} */ (['basic', 'more', 'detail']);

/** @typedef {'basic'|'more'|'detail'} EntrySheetTabId */

let tabsBound = false;
/** @type {EntrySheetTabId} */
let activeTab = 'basic';
/** 사진 없을 때 기본 탭 기준 패널 높이(px) — height/min-height 동시 잠금 */
let entrySheetBaseMinHeightPx = 0;

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

function applyEntrySheetHeightLock() {
    const panel = getEntryModalPanel();
    if (!panel) return;
    if (entrySheetBaseMinHeightPx > 0 && !entrySheetHasPhotos()) {
        const px = `${entrySheetBaseMinHeightPx}px`;
        panel.style.setProperty('--entry-sheet-min-h', px);
        panel.style.setProperty('--entry-sheet-h', px);
    } else if (entrySheetBaseMinHeightPx > 0 && entrySheetHasPhotos()) {
        // 사진 있으면 콘텐츠만큼 성장 허용, 최소만 유지
        panel.style.setProperty('--entry-sheet-min-h', `${entrySheetBaseMinHeightPx}px`);
        panel.style.setProperty('--entry-sheet-h', 'auto');
    } else {
        panel.style.removeProperty('--entry-sheet-min-h');
        panel.style.removeProperty('--entry-sheet-h');
    }
}

/** 모달 열 때 기준 높이 초기화 */
export function resetEntrySheetBaseHeight() {
    entrySheetBaseMinHeightPx = 0;
    applyEntrySheetHeightLock();
}

/**
 * 사진 없는 기본 탭의 자연 높이를 잠가 탭 전환·메모 확장 시 팝업 크기가 흔들리지 않게 함.
 * @param {{ force?: boolean }} [opts]
 */
export function captureEntrySheetBaseHeight(opts = {}) {
    const modal = document.getElementById('entryModal');
    const panel = getEntryModalPanel();
    if (!modal || !panel || modal.classList.contains('hidden')) return;
    if (entrySheetHasPhotos()) {
        applyEntrySheetHeightLock();
        return;
    }
    if (entrySheetBaseMinHeightPx > 0 && !opts.force) {
        applyEntrySheetHeightLock();
        return;
    }

    const prevTab = activeTab;
    const scroll = document.getElementById('modalScrollArea');
    const prevScroll = scroll?.scrollTop ?? 0;
    const prevScrollFlex = scroll?.style.flex ?? '';

    panel.style.removeProperty('--entry-sheet-min-h');
    panel.style.removeProperty('--entry-sheet-h');
    // 측정 시 flex-grow로 불필요하게 늘어난 높이가 잡히지 않도록
    if (scroll) scroll.style.flex = '0 0 auto';
    if (prevTab !== 'basic') {
        setEntrySheetTab('basic');
    }

    const h = Math.ceil(panel.getBoundingClientRect().height);
    if (h > 0) {
        entrySheetBaseMinHeightPx = h;
    }
    if (scroll) scroll.style.flex = prevScrollFlex;
    applyEntrySheetHeightLock();

    if (prevTab !== 'basic') {
        setEntrySheetTab(prevTab);
    }
    if (scroll) scroll.scrollTop = prevScroll;
}

/** @param {EntrySheetTabId|string} tabId */
export function setEntrySheetTab(tabId) {
    const next = TAB_IDS.includes(/** @type {EntrySheetTabId} */ (tabId))
        ? /** @type {EntrySheetTabId} */ (tabId)
        : 'basic';
    activeTab = next;

    const root = document.getElementById('entryModal');
    if (!root) return;

    root.querySelectorAll('[data-entry-sheet-tab]').forEach((btn) => {
        const on = btn.getAttribute('data-entry-sheet-tab') === next;
        btn.classList.toggle('entry-sheet-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
    });

    root.querySelectorAll('[data-entry-sheet-panel]').forEach((panel) => {
        const on = panel.getAttribute('data-entry-sheet-panel') === next;
        panel.classList.toggle('hidden', !on);
        panel.toggleAttribute('hidden', !on);
        if (on) panel.removeAttribute('inert');
        else panel.setAttribute('inert', '');
    });

    applyEntrySheetHeightLock();

    const scroll = document.getElementById('modalScrollArea');
    if (scroll) scroll.scrollTop = 0;
}

export function resetEntrySheetTab() {
    setEntrySheetTab('basic');
}

/** Skip 시 상세(어땠지?) 탭 비활성 */
export function setEntrySheetTabsForSkip(isSkip) {
    const skip = !!isSkip;
    const btn = document.querySelector('#entrySheetTabs [data-entry-sheet-tab="detail"]');
    if (btn) {
        btn.toggleAttribute('disabled', skip);
        btn.classList.toggle('entry-sheet-tab--disabled', skip);
        btn.setAttribute('aria-disabled', skip ? 'true' : 'false');
    }
    if (skip && activeTab === 'detail') {
        setEntrySheetTab('basic');
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
        if (tab) setEntrySheetTab(tab);
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
            setEntrySheetTab(tab);
            next.focus();
        }
    });

    setEntrySheetTab(activeTab);
}
