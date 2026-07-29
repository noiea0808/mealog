/**
 * 라운지 게시판·공지 검색 — 기간 + 흔적(좋아요/댓글/북마크) + 키워드 팝업
 */
import { appState } from './state.js';
import { addDaysToYmd } from './demo-date-shift.js';
import { localTodayYmd } from './render/timeline.js';
import { addCompositionAwareInput } from './utils.js';
import { showToast } from './ui.js';
import { scheduleLucideIcons } from './icons.js';
import { getBoardSearchModalTitle } from './board-search-filter.js';

const PERIOD_PRESETS = {
    '7d': { days: 7 },
    '14d': { days: 14 },
    '30d': { days: 30 }
};

let searchPeriod = '7d';
let searchTrace = null;
let searchRunning = false;

function getPresetDateRange(preset) {
    const today = localTodayYmd();
    const cfg = PERIOD_PRESETS[preset];
    if (!cfg) return { start: today, end: today };
    return { start: addDaysToYmd(today, -(cfg.days - 1)), end: today };
}

function readDateRangeFromInputs() {
    const start = document.getElementById('boardSearchStartDate')?.value?.trim() || '';
    const end = document.getElementById('boardSearchEndDate')?.value?.trim() || '';
    if (!start || !end) return null;
    if (start > end) return { error: '시작일이 종료일보다 늦을 수 없습니다.' };
    return { start, end };
}

function syncDateInputsFromPeriod() {
    const startInput = document.getElementById('boardSearchStartDate');
    const endInput = document.getElementById('boardSearchEndDate');
    if (!startInput || !endInput) return;

    const isCustom = searchPeriod === 'custom';
    startInput.disabled = !isCustom;
    endInput.disabled = !isCustom;

    if (isCustom) {
        const today = localTodayYmd();
        if (!startInput.value) startInput.value = addDaysToYmd(today, -6);
        if (!endInput.value) endInput.value = today;
        return;
    }

    const range = getPresetDateRange(searchPeriod);
    startInput.value = range.start;
    endInput.value = range.end;
}

function updatePeriodButtonUI() {
    document.querySelectorAll('[data-board-search-period]').forEach((btn) => {
        const active = btn.getAttribute('data-board-search-period') === searchPeriod;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncDateInputsFromPeriod();
}

function updateTraceButtonUI() {
    document.querySelectorAll('[data-board-search-trace]').forEach((btn) => {
        const trace = btn.getAttribute('data-board-search-trace');
        const active = searchTrace === trace;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const keywordWrap = document.getElementById('boardSearchKeywordWrap');
    const showKeyword = searchTrace === 'keyword';
    if (keywordWrap) keywordWrap.classList.toggle('hidden', !showKeyword);
    if (showKeyword) {
        requestAnimationFrame(() => document.getElementById('boardSearchKeyword')?.focus());
    }
}

function setSearchPeriod(period) {
    searchPeriod = period;
    updatePeriodButtonUI();
}

function setSearchTrace(trace) {
    const needsLogin = trace === 'like' || trace === 'comment' || trace === 'bookmark';
    if (needsLogin && (!window.currentUser || window.currentUser.isAnonymous)) {
        showToast('로그인이 필요합니다.', 'error');
        if (typeof window.requestLogin === 'function') window.requestLogin();
        return;
    }
    searchTrace = searchTrace === trace ? null : trace;
    updateTraceButtonUI();
}

function resolveSearchDateRange() {
    syncDateInputsFromPeriod();
    if (searchPeriod !== 'custom') {
        return getPresetDateRange(searchPeriod);
    }
    const custom = readDateRangeFromInputs();
    if (!custom) return { error: '시작일과 종료일을 모두 선택해주세요.' };
    if (custom.error) return custom;
    return custom;
}

export function openBoardSearchModal() {
    const modal = document.getElementById('boardSearchModal');
    if (!modal) return;

    const titleEl = document.getElementById('boardSearchModalTitle');
    if (titleEl) titleEl.textContent = getBoardSearchModalTitle();

    searchPeriod = appState.boardSearchDateRange ? 'custom' : '7d';
    if ((appState.boardSearchKeyword || '').trim()) {
        searchTrace = 'keyword';
    } else {
        searchTrace = appState.boardTraceFilter || null;
    }

    if (appState.boardSearchDateRange) {
        const { start, end } = appState.boardSearchDateRange;
        const startInput = document.getElementById('boardSearchStartDate');
        const endInput = document.getElementById('boardSearchEndDate');
        if (startInput) startInput.value = start;
        if (endInput) endInput.value = end;
        searchPeriod = 'custom';
    }

    const keywordInput = document.getElementById('boardSearchKeyword');
    if (keywordInput) keywordInput.value = appState.boardSearchKeyword || '';

    modal.classList.remove('hidden');
    updatePeriodButtonUI();
    updateTraceButtonUI();
    scheduleLucideIcons(modal);
    if (searchTrace !== 'keyword') {
        requestAnimationFrame(() => document.getElementById('boardSearchSubmitBtn')?.focus());
    }
}

export function closeBoardSearchModal() {
    document.getElementById('boardSearchModal')?.classList.add('hidden');
}

export async function clearBoardSearch() {
    appState.boardSearchActive = false;
    appState.boardSearchKeyword = '';
    appState.boardSearchDateRange = null;
    appState.boardTraceFilter = null;
    closeBoardSearchModal();
    if (typeof window.renderBoard === 'function') {
        await window.renderBoard(window.currentBoardCategory || 'all');
    }
}

export async function executeBoardSearch() {
    if (searchRunning) return;

    const range = resolveSearchDateRange();
    if (range?.error) {
        showToast(range.error, 'error');
        return;
    }

    let keyword = '';
    if (searchTrace === 'keyword') {
        keyword = (document.getElementById('boardSearchKeyword')?.value || '').trim();
        if (!keyword) {
            showToast('검색어를 입력해주세요.', 'error');
            document.getElementById('boardSearchKeyword')?.focus();
            return;
        }
    }

    const traceFilter =
        searchTrace && searchTrace !== 'keyword' ? searchTrace : null;
    if (traceFilter && (!window.currentUser || window.currentUser.isAnonymous)) {
        showToast('좋아요·댓글·북마크 검색은 로그인이 필요합니다.', 'error');
        return;
    }

    const submitBtn = document.getElementById('boardSearchSubmitBtn');
    searchRunning = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '검색 중…';
    }

    try {
        appState.boardSearchActive = true;
        appState.boardSearchKeyword = keyword;
        appState.boardSearchDateRange = { start: range.start, end: range.end };
        appState.boardTraceFilter = traceFilter;

        closeBoardSearchModal();
        if (typeof window.renderBoard === 'function') {
            await window.renderBoard(window.currentBoardCategory || 'all');
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
        searchRunning = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '검색';
        }
    }
}

export function initBoardSearchModal() {
    document.getElementById('boardSearchBackdrop')?.addEventListener('click', closeBoardSearchModal);
    document.getElementById('boardSearchCancelBtn')?.addEventListener('click', closeBoardSearchModal);
    document.getElementById('boardSearchSubmitBtn')?.addEventListener('click', () => {
        executeBoardSearch();
    });

    document.getElementById('boardSearchExitBtn')?.addEventListener('click', () => {
        clearBoardSearch();
    });

    document.querySelectorAll('[data-board-search-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSearchPeriod(btn.getAttribute('data-board-search-period') || '7d');
        });
    });

    document.querySelectorAll('[data-board-search-trace]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSearchTrace(btn.getAttribute('data-board-search-trace'));
        });
    });

    const keywordInput = document.getElementById('boardSearchKeyword');
    if (keywordInput && !keywordInput._searchCompositionInit) {
        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                executeBoardSearch();
            }
        });
        addCompositionAwareInput(keywordInput, () => {});
        keywordInput._searchCompositionInit = true;
    }

    updatePeriodButtonUI();
    updateTraceButtonUI();
}

window.openBoardSearchModal = openBoardSearchModal;
window.closeBoardSearchModal = closeBoardSearchModal;
window.executeBoardSearch = executeBoardSearch;
window.clearBoardSearch = clearBoardSearch;
