/**
 * 모먼트(갤러리) 검색 — 기간 + 흔적(좋아요/댓글/북마크) + 키워드 팝업
 */
import { appState } from './state.js';
import { addDaysToYmd } from './demo-date-shift.js';
import { localTodayYmd } from './render/timeline.js';
import { addCompositionAwareInput } from './utils.js';
import { showToast } from './ui.js';
import { scheduleLucideIcons } from './icons.js';
import { lockBodyScroll, unlockBodyScroll } from './utils/scroll-lock.js';

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
    const start = document.getElementById('momentSearchStartDate')?.value?.trim() || '';
    const end = document.getElementById('momentSearchEndDate')?.value?.trim() || '';
    if (!start || !end) return null;
    if (start > end) return { error: '시작일이 종료일보다 늦을 수 없습니다.' };
    return { start, end };
}

function syncDateInputsFromPeriod() {
    const startInput = document.getElementById('momentSearchStartDate');
    const endInput = document.getElementById('momentSearchEndDate');
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
    document.querySelectorAll('[data-moment-search-period]').forEach((btn) => {
        const active = btn.getAttribute('data-moment-search-period') === searchPeriod;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncDateInputsFromPeriod();
}

function updateTraceButtonUI() {
    document.querySelectorAll('[data-moment-search-trace]').forEach((btn) => {
        const trace = btn.getAttribute('data-moment-search-trace');
        const active = searchTrace === trace;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const keywordWrap = document.getElementById('momentSearchKeywordWrap');
    const showKeyword = searchTrace === 'keyword';
    if (keywordWrap) keywordWrap.classList.toggle('hidden', !showKeyword);
    if (showKeyword) {
        requestAnimationFrame(() => document.getElementById('momentSearchKeyword')?.focus());
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

export function openMomentSearchModal() {
    const modal = document.getElementById('momentSearchModal');
    if (!modal) return;

    searchPeriod = appState.gallerySearchDateRange ? 'custom' : '7d';
    if ((appState.gallerySearchKeyword || '').trim()) {
        searchTrace = 'keyword';
    } else {
        searchTrace = appState.galleryTraceFilter || null;
    }

    if (appState.gallerySearchDateRange) {
        const { start, end } = appState.gallerySearchDateRange;
        const startInput = document.getElementById('momentSearchStartDate');
        const endInput = document.getElementById('momentSearchEndDate');
        if (startInput) startInput.value = start;
        if (endInput) endInput.value = end;
        searchPeriod = 'custom';
    }

    const keywordInput = document.getElementById('momentSearchKeyword');
    if (keywordInput) keywordInput.value = appState.gallerySearchKeyword || '';

    modal.classList.remove('hidden');
    lockBodyScroll('momentSearchModal');
    updatePeriodButtonUI();
    updateTraceButtonUI();
    scheduleLucideIcons(modal);
    if (searchTrace !== 'keyword') {
        requestAnimationFrame(() => document.getElementById('momentSearchSubmitBtn')?.focus());
    }
}

export function closeMomentSearchModal() {
    document.getElementById('momentSearchModal')?.classList.add('hidden');
    unlockBodyScroll('momentSearchModal');
}

export async function clearGallerySearch() {
    appState.gallerySearchActive = false;
    appState.gallerySearchKeyword = '';
    appState.gallerySearchDateRange = null;
    appState.galleryTraceFilter = null;
    closeMomentSearchModal();
    const { renderGallery } = await import('./render/gallery.js');
    await renderGallery({ forceReload: true });
}

export async function executeMomentSearch() {
    if (searchRunning) return;

    const range = resolveSearchDateRange();
    if (range?.error) {
        showToast(range.error, 'error');
        return;
    }

    let keyword = '';
    if (searchTrace === 'keyword') {
        keyword = (document.getElementById('momentSearchKeyword')?.value || '').trim();
        if (!keyword) {
            showToast('검색어를 입력해주세요.', 'error');
            document.getElementById('momentSearchKeyword')?.focus();
            return;
        }
    }

    const traceFilter =
        searchTrace && searchTrace !== 'keyword' ? searchTrace : null;
    if (traceFilter && (!window.currentUser || window.currentUser.isAnonymous)) {
        showToast('좋아요·댓글·북마크 검색은 로그인이 필요합니다.', 'error');
        return;
    }

    const submitBtn = document.getElementById('momentSearchSubmitBtn');
    searchRunning = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '검색 중…';
    }

    try {
        appState.gallerySearchActive = true;
        appState.gallerySearchKeyword = keyword;
        appState.gallerySearchDateRange = { start: range.start, end: range.end };
        appState.galleryTraceFilter = traceFilter;

        closeMomentSearchModal();
        const { renderGallery } = await import('./render/gallery.js');
        await renderGallery({ forceReload: true, skipScrollToTop: false });
    } finally {
        searchRunning = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '검색';
        }
    }
}

export function initMomentSearchModal() {
    document.getElementById('momentSearchBackdrop')?.addEventListener('click', closeMomentSearchModal);
    document.getElementById('momentSearchCancelBtn')?.addEventListener('click', closeMomentSearchModal);
    document.getElementById('momentSearchSubmitBtn')?.addEventListener('click', () => {
        executeMomentSearch();
    });

    document.querySelectorAll('[data-moment-search-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSearchPeriod(btn.getAttribute('data-moment-search-period') || '7d');
        });
    });

    document.querySelectorAll('[data-moment-search-trace]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSearchTrace(btn.getAttribute('data-moment-search-trace'));
        });
    });

    const keywordInput = document.getElementById('momentSearchKeyword');
    if (keywordInput && !keywordInput._searchCompositionInit) {
        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                executeMomentSearch();
            }
        });
        addCompositionAwareInput(keywordInput, () => {});
        keywordInput._searchCompositionInit = true;
    }

    updatePeriodButtonUI();
    updateTraceButtonUI();
}

window.openMomentSearchModal = openMomentSearchModal;
window.closeMomentSearchModal = closeMomentSearchModal;
window.executeMomentSearch = executeMomentSearch;
window.clearGallerySearch = clearGallerySearch;
