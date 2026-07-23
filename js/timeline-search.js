/**
 * 밀로그(타임라인) 기록 검색 — 기간 + 키워드 팝업
 */
import { SATIETY_DATA } from './constants.js';
import { loadMealsForDateRange } from './db.js';
import { addDaysToYmd } from './demo-date-shift.js';
import { renderTimeline, localTodayYmd } from './render/timeline.js';
import { escapeHtml } from './render/utils.js';
import { addCompositionAwareInput } from './utils.js';
import { showToast } from './ui.js';

const PERIOD_PRESETS = {
    '7d': { label: '최근 1주', days: 7 },
    '14d': { label: '2주', days: 14 },
    '30d': { label: '한 달', days: 30 }
};

let searchPeriod = '7d';
let searchRunning = false;

function highlightKeyword(text, keyword) {
    if (!keyword || !text) return escapeHtml(String(text ?? ''));
    const k = keyword.toLowerCase();
    const t = String(text);
    const idx = t.toLowerCase().indexOf(k);
    if (idx < 0) return escapeHtml(t);
    const before = t.slice(0, idx);
    const match = t.slice(idx, idx + k.length);
    const after = t.slice(idx + k.length);
    return escapeHtml(before) + `<span class="text-red-600 font-bold">${escapeHtml(match)}</span>` + highlightKeyword(after, keyword);
}

function mealMatchesKeyword(meal, kw) {
    if (!kw) return true;
    const q = kw.toLowerCase();
    return (
        meal.menuDetail?.toLowerCase().includes(q) ||
        meal.deliveryVendor?.toLowerCase().includes(q) ||
        meal.place?.toLowerCase().includes(q) ||
        meal.category?.toLowerCase().includes(q) ||
        (meal.withWhomDetail || meal.withWhom || '')?.toLowerCase().includes(q) ||
        meal.snackDetail?.toLowerCase().includes(q) ||
        meal.snackType?.toLowerCase().includes(q)
    );
}

function formatYmdDisplay(ymd) {
    if (!ymd) return '-';
    const [y, m, d] = String(ymd).split('-');
    if (!m || !d) return ymd;
    return `${y}.${parseInt(m, 10)}.${parseInt(d, 10)}`;
}

function getPresetDateRange(preset) {
    const today = localTodayYmd();
    const cfg = PERIOD_PRESETS[preset];
    if (!cfg) return { start: today, end: today };
    return { start: addDaysToYmd(today, -(cfg.days - 1)), end: today };
}

function readCustomDateRange() {
    const startInput = document.getElementById('timelineSearchStartDate');
    const endInput = document.getElementById('timelineSearchEndDate');
    const start = startInput?.value?.trim() || '';
    const end = endInput?.value?.trim() || '';
    if (!start || !end) return null;
    if (start > end) return { error: '시작일이 종료일보다 늦을 수 없습니다.' };
    return { start, end };
}

function resolveSearchDateRange() {
    syncDateInputsFromPeriod();
    const custom = readCustomDateRange();
    if (!custom) return { error: '시작일과 종료일을 모두 선택해주세요.' };
    if (custom.error) return custom;
    return custom;
}

function syncDateInputsFromPeriod() {
    const startInput = document.getElementById('timelineSearchStartDate');
    const endInput = document.getElementById('timelineSearchEndDate');
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
    document.querySelectorAll('[data-timeline-search-period]').forEach((btn) => {
        const active = btn.getAttribute('data-timeline-search-period') === searchPeriod;
        btn.classList.toggle('bg-emerald-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-emerald-600', active);
        btn.classList.toggle('bg-white', !active);
        btn.classList.toggle('text-slate-700', !active);
        btn.classList.toggle('border-slate-200', !active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    syncDateInputsFromPeriod();
}

function setSearchPeriod(period) {
    searchPeriod = period;
    updatePeriodButtonUI();
}

function renderSearchResults(results, keyword, range) {
    const c = document.getElementById('timelineContainer');
    if (!c) return;

    const q = keyword.trim();
    window.currentSearchQuery = q;
    window.currentSearchDateRange = range ? { ...range } : null;

    if (!q) {
        window.currentSearchQuery = '';
        window.currentSearchDateRange = null;
        window.loadedDates = [];
        c.innerHTML = '';
        renderTimeline();
        return;
    }

    const fmt = (v) => (v == null || v === '' || v === undefined) ? '-' : String(v);
    const fmtDate = (d) => {
        if (!d) return '-';
        const [, m, n] = String(d).split('-');
        return m && n ? `${parseInt(m, 10)}월 ${parseInt(n, 10)}일` : d;
    };
    const satietyData = (v) => SATIETY_DATA?.find((d) => d.val === parseInt(v, 10));
    const ratingStarsHtml = (rating) => {
        const n = rating ? parseInt(rating, 10) : 0;
        if (n < 1 || n > 5) return '';
        return `<span class="timeline-search-rating inline-flex items-center gap-0.5" title="만족도 ${n}점">${'<i data-lucide="star" class="text-sm"></i>'.repeat(n)}</span>`;
    };
    const satietyIconHtml = (v) => {
        const s = satietyData(v);
        if (!s) return '';
        return `<span class="inline-flex items-center ${s.color}" title="${escapeHtml(s.label)}"><i class="fa-solid ${s.icon} text-sm"></i></span>`;
    };
    const isSnack = (r) => r.slotId === 'snack' || (r.slotId && String(r.slotId).toLowerCase().includes('snack'));
    const safe = (x) => escapeHtml(String(x ?? ''));
    const hl = (text) => highlightKeyword(text, q);

    const rangeLabel = range?.start && range?.end
        ? `${formatYmdDisplay(range.start)} ~ ${formatYmdDisplay(range.end)}`
        : '';

    c.innerHTML = `<div class="px-2 py-2 mb-1 flex items-start justify-between gap-2">
            <div class="min-w-0">
                <div class="text-sm font-bold text-slate-700">검색 결과 ${results.length}건</div>
                ${rangeLabel ? `<div class="text-xs text-slate-500 mt-0.5 truncate">${escapeHtml(rangeLabel)} · 「${escapeHtml(q)}」</div>` : ''}
            </div>
            <button type="button" id="timelineSearchExitBtn" class="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 transition-colors">검색 종료</button>
        </div>` +
        results.map((r) => {
            const how = isSnack(r) ? (r.mealType || r.snackType || '-') : (r.mealType || '-');
            const where = isSnack(r) ? (r.snackPlace || r.place || '-') : (r.place || '-');
            const what = isSnack(r) ? (r.snackDetail || r.snackType || '-') : (r.menuDetail || r.category || '-');
            const whom = r.withWhomDetail || r.withWhom || '-';
            const rating = isSnack(r) ? (r.snackRating ?? r.rating) : r.rating;
            const ratingHtml = ratingStarsHtml(rating);
            const satietyHtml = satietyIconHtml(r.satiety);
            const textItems = [how, what, whom].map((v) => (v === '-' ? '' : hl(v))).filter(Boolean);
            const iconItems = [ratingHtml, satietyHtml].filter(Boolean);
            const textPart = textItems.length > 0 ? textItems.join('<span class="text-slate-300 mx-1">·</span>') : '';
            const iconPart = iconItems.length > 0
                ? iconItems.map((h) => `<span class="inline-flex items-center">${h}</span>`).join('<span class="text-slate-300 mx-1">·</span>')
                : '';
            const tagsHtml = [textPart, iconPart].filter(Boolean).join('<span class="text-slate-300 mx-1">·</span>');
            return `<div class="search-result-item px-3 py-3 mb-3 border border-slate-200 rounded-xl active:bg-slate-50 transition-colors cursor-pointer" data-date="${safe(r.date)}" data-slot-id="${safe(r.slotId)}" data-entry-id="${safe(r.id)}">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-sm font-bold text-slate-800">${hl(fmtDate(r.date))}</span>
                    ${where !== '-' ? `<span class="text-slate-400">|</span><span class="text-sm text-slate-600">${hl(where)}</span>` : ''}
                </div>
                <div class="mt-2 flex flex-wrap items-center gap-1 text-sm text-slate-600">${tagsHtml}</div>
            </div>`;
        }).join('');

    document.getElementById('timelineSearchExitBtn')?.addEventListener('click', () => {
        if (typeof window.closeSearch === 'function') window.closeSearch();
    });

    c.querySelectorAll('.search-result-item').forEach((el) => {
        el.addEventListener('click', () => {
            const date = el.dataset.date;
            const slotId = el.dataset.slotId;
            if (slotId === 'daily_journal' && date && typeof window.openDailyJournalModal === 'function') {
                window.openDailyJournalModal(date);
                return;
            }
            window.openModal(date, slotId, el.dataset.entryId);
        });
    });
}

export function openTimelineSearchModal() {
    const modal = document.getElementById('timelineSearchModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    updatePeriodButtonUI();
    requestAnimationFrame(() => {
        document.getElementById('timelineSearchKeyword')?.focus();
    });
}

export function closeTimelineSearchModal() {
    document.getElementById('timelineSearchModal')?.classList.add('hidden');
}

export function clearTimelineSearchResults() {
    window.currentSearchQuery = '';
    window.currentSearchDateRange = null;
    window.loadedDates = [];
    const inp = document.getElementById('timelineSearchKeyword');
    if (inp) inp.value = '';
    closeTimelineSearchModal();
}

export async function executeTimelineSearch() {
    if (searchRunning) return;

    const keywordInput = document.getElementById('timelineSearchKeyword');
    const keyword = (keywordInput?.value || '').trim();
    if (!keyword) {
        showToast('검색어를 입력해주세요.', 'error');
        keywordInput?.focus();
        return;
    }

    const range = resolveSearchDateRange();
    if (range?.error) {
        showToast(range.error, 'error');
        return;
    }

    const submitBtn = document.getElementById('timelineSearchSubmitBtn');
    searchRunning = true;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '검색 중…';
    }

    try {
        await loadMealsForDateRange(range.start, range.end);
    } catch (e) {
        console.error('검색 기간 데이터 로드 실패:', e);
        showToast('기록을 불러오지 못했습니다. 다시 시도해주세요.', 'error');
        searchRunning = false;
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '검색';
        }
        return;
    }

    const kw = keyword.toLowerCase();
    const results = (window.mealHistory || [])
        .filter((m) => m.date >= range.start && m.date <= range.end)
        .filter((m) => mealMatchesKeyword(m, kw))
        .sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || ''));

    renderSearchResults(results, keyword, range);
    closeTimelineSearchModal();

    if (results.length === 0) {
        showToast('검색 결과가 없습니다.', 'info');
    }

    searchRunning = false;
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '검색';
    }
}

/** @deprecated 실시간 입력 검색 — 팝업 검색으로 대체. 빈 검색어 시 타임라인 복원용 */
export function handleSearch(k) {
    const q = (k || '').trim();
    if (!q && typeof window.closeSearch === 'function') {
        window.closeSearch();
    }
}

export function initTimelineSearchModal() {
    document.getElementById('timelineSearchBackdrop')?.addEventListener('click', closeTimelineSearchModal);
    document.getElementById('timelineSearchCloseBtn')?.addEventListener('click', closeTimelineSearchModal);
    document.getElementById('timelineSearchCancelBtn')?.addEventListener('click', closeTimelineSearchModal);
    document.getElementById('timelineSearchSubmitBtn')?.addEventListener('click', () => {
        executeTimelineSearch();
    });

    document.querySelectorAll('[data-timeline-search-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            setSearchPeriod(btn.getAttribute('data-timeline-search-period') || '7d');
        });
    });

    const keywordInput = document.getElementById('timelineSearchKeyword');
    if (keywordInput && !keywordInput._searchCompositionInit) {
        keywordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                executeTimelineSearch();
            }
        });
        addCompositionAwareInput(keywordInput, () => {});
        keywordInput._searchCompositionInit = true;
    }

    updatePeriodButtonUI();
}

window.openTimelineSearchModal = openTimelineSearchModal;
window.closeTimelineSearchModal = closeTimelineSearchModal;
window.executeTimelineSearch = executeTimelineSearch;
window.handleSearch = handleSearch;
