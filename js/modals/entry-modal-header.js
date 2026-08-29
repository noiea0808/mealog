/**

 * 기록 모달 헤더 — 날짜·슬롯 인라인 편집, 식사/간식 탭

 */

import { SLOTS } from '../constants.js';

import { resolveRecordSlotView, userSlotsForDate } from '../utils/slot-view.js';

import { appState } from '../state.js';

import { sortSnackSlotRecordsChronological } from '../render/timeline.js';

import { getEntryModeFromSlot } from './entry-form-config.js';

import {

    applyEntryModeLabels,

    setEntryExtrasVisibility,

} from './entry-form-state.js';

import { renderEntryChips } from '../render/index.js';

import {

    applyEntryQuickInputUi,

    syncEntryFieldQuickInputToggles,

} from './entry-quick-input.js';

import { applyEntryDetailRecordUi } from './entry-detail-record.js';



let headerBound = false;

/** @type {{ year: number, month: number } | null} */

let datePickerView = null;



/** @param {object|null|undefined} record @param {{ type?: string }|null|undefined} slot */

export function inferEntryFormModeFromRecord(record, slot) {

    if (record) {

        if (record.snackType || record.snackPlaceMain) return 'snack';

        if (record.mealType) return 'meal';

    }

    return getEntryModeFromSlot(slot);

}



/**
 * 슬롯 표시 라벨 (동일 슬롯 다건이면 점심2 형식)
 *
 * 라벨·서수 모두 **사용자 슬롯** 기준이다(docs/user-slot-plan.md §3).
 * 같은 base('야식'·'2차' 둘 다 dinner)라도 slotKey 가 다르면 다른 슬롯이므로
 * 서수를 섞어 세지 않는다 — 그룹 판정은 resolveRecordSlotView 의 slotKey 로 한다.
 * plan 없는 사용자는 slotKey 가 전부 null 이라 현행(slotId 단위)과 동일.
 */
export function getEntrySlotTitleLabel(date, slotId, entryId = null) {

    if (!SLOTS.some((s) => s.id === slotId)) return '';

    const self = entryId ? window.mealHistory?.find((m) => m.id === entryId) ?? null : null;

    // 새 기록: 피커에서 고른 사용자 슬롯(appState.currentEditingSlotKey)으로 라벨 결정
    const targetView = resolveRecordSlotView(
        self || { date, slotId, slotKey: appState.currentEditingSlotKey || undefined }
    );

    const sameGroup = (m) => {
        if (!m || m.date !== date || m.slotId !== slotId) return false;
        return resolveRecordSlotView(m).slotKey === targetView.slotKey;
    };

    const inSlot = (window.mealHistory || []).filter(sameGroup);

    if (entryId) {

        const all = self && !inSlot.some((m) => m.id === entryId) ? [...inSlot, self] : [...inSlot];

        const sorted = sortSnackSlotRecordsChronological(all);

        const ord = sorted.findIndex((m) => m.id === entryId) + 1;

        return sorted.length > 1 ? `${targetView.label}${ord}` : targetView.label;

    }

    const nextOrd = inSlot.length + 1;

    return inSlot.length > 0 ? `${targetView.label}${nextOrd}` : targetView.label;

}



export function formatEntryModalHeaderTitle(date, slotId, entryId = null) {

    const slotLabel = getEntrySlotTitleLabel(date, slotId, entryId);

    return slotLabel;

}



function formatEntryHeaderDateButtonLabel(iso) {

    if (!iso) return '날짜';

    const [y, m, d] = iso.split('-');

    if (!y || !m || !d) return '날짜';

    return `${y}.${m}.${d}`;

}



function localTodayIso() {

    const t = new Date();

    const y = t.getFullYear();

    const m = String(t.getMonth() + 1).padStart(2, '0');

    const d = String(t.getDate()).padStart(2, '0');

    return `${y}-${m}-${d}`;

}



function isFutureEntryHeaderDateIso(iso) {

    const todayIso = localTodayIso();

    return Boolean(iso && iso > todayIso);

}



function isMonthAfterCurrentCalendarMonth(year, month) {

    const now = new Date();

    const ty = now.getFullYear();

    const tm = now.getMonth();

    return year > ty || (year === ty && month > tm);

}



function syncEntryHeaderDatePickerNav() {

    const nextBtn = document.getElementById('entryHeaderDatePickerNext');

    if (!nextBtn || !datePickerView) return;

    const { year, month } = datePickerView;

    const atCurrentMonth = !isMonthAfterCurrentCalendarMonth(year, month);

    nextBtn.disabled = atCurrentMonth;

    nextBtn.setAttribute('aria-disabled', atCurrentMonth ? 'true' : 'false');

    nextBtn.classList.toggle('entry-header-date-picker__nav-btn--disabled', atCurrentMonth);

}



function syncEntryHeaderDateButtonLabel() {

    const btn = document.getElementById('entryHeaderDateBtn');

    const iso = document.getElementById('entryHeaderDate')?.value?.trim();

    if (btn) btn.textContent = formatEntryHeaderDateButtonLabel(iso || '');

}



/**
 * 헤더 슬롯 select 의 option value 인코딩 — 사용자 슬롯은 `k:<key>`,
 * key 없는 기본 슬롯은 base id 그대로. plan 없는 사용자는 현행과 완전히 같다.
 */
function headerSlotOptionValue(slot) {
    return slot.key != null ? `k:${slot.key}` : slot.base;
}

function parseHeaderSlotOptionValue(value, slots) {
    const v = String(value || '');
    if (v.startsWith('k:')) {
        const key = v.slice(2);
        const hit = slots.find((s) => s.key === key);
        return hit ? { base: hit.base, key } : null;
    }
    return v ? { base: v, key: null } : null;
}

function currentHeaderSlotList() {
    const date = appState.currentEditingDate || '';
    const slots = userSlotsForDate(date).filter((s) => s.enabled);
    /**
     * 수정 중인 기록의 슬롯이 꺼져 있어도(enabled:false·삭제) 목록에 넣는다 —
     * 없으면 select 가 임의 슬롯으로 튀어 기록이 소리 없이 이사간다 (불변식 4).
     */
    const cur = { base: appState.currentEditingSlotId, key: appState.currentEditingSlotKey || null };
    if (cur.base && !slots.some((s) => s.base === cur.base && (s.key || null) === cur.key)) {
        const view = resolveRecordSlotView({ date, slotId: cur.base, slotKey: cur.key || undefined });
        slots.push({ key: view.slotKey, base: view.base, label: view.label, enabled: false });
    }
    return slots;
}

function populateEntryHeaderSlotOptions() {

    const slotSelect = document.getElementById('entryHeaderSlotSelect');

    if (!slotSelect) return;

    const slots = currentHeaderSlotList();

    slotSelect.innerHTML = slots.map(
        (slot) => `<option value="${headerSlotOptionValue(slot)}">${slot.label}</option>`
    ).join('');

    const cur = slots.find(
        (s) => s.base === appState.currentEditingSlotId && (s.key || null) === (appState.currentEditingSlotKey || null)
    ) || slots.find((s) => s.base === appState.currentEditingSlotId);

    if (cur) slotSelect.value = headerSlotOptionValue(cur);

}



const ENTRY_HEADER_TINTED_SLOTS = new Set(['morning', 'lunch', 'dinner']);



/** 아침·점심·저녁 슬롯에 맞춰 헤더 날짜·시간대 입력창 배경 틴트 */
export function syncEntryHeaderSlotTheme() {
    const controls = document.querySelector('#entryModal .entry-header-controls');
    if (!controls) return;
    const rawSelectValue = document.getElementById('entryHeaderSlotSelect')?.value || '';
    const slotId =
        appState.currentEditingSlotId ||
        // 'k:<key>' 형식(사용자 슬롯)은 base 를 모르니 테마 판정에 쓰지 않는다
        (rawSelectValue.startsWith('k:') ? '' : rawSelectValue);
    const theme = ENTRY_HEADER_TINTED_SLOTS.has(slotId) ? slotId : 'default';
    controls.setAttribute('data-entry-slot-theme', theme);
}



export function refreshEntryModalHeader() {

    const dateInput = document.getElementById('entryHeaderDate');

    const slotSelect = document.getElementById('entryHeaderSlotSelect');

    const date = appState.currentEditingDate;

    const slotId = appState.currentEditingSlotId;



    populateEntryHeaderSlotOptions();



    if (dateInput) {

        dateInput.value = date || '';

    }

    syncEntryHeaderDateButtonLabel();

    // 선택값 동기화는 populateEntryHeaderSlotOptions 가 slotKey 까지 맞춰서 했다

    syncEntryHeaderSlotTheme();

    refreshEntryFormModeTabs();

}



export function refreshEntryFormModeTabs() {

    const mode = appState.entryFormMode === 'snack' ? 'snack' : 'meal';

    const mealBtn = document.getElementById('entryFormModeBtnMeal');

    const snackBtn = document.getElementById('entryFormModeBtnSnack');

    mealBtn?.classList.toggle('entry-form-mode-btn--active', mode === 'meal');

    snackBtn?.classList.toggle('entry-form-mode-btn--active', mode === 'snack');

    mealBtn?.setAttribute('aria-pressed', mode === 'meal' ? 'true' : 'false');

    snackBtn?.setAttribute('aria-pressed', mode === 'snack' ? 'true' : 'false');

}



/** 식사/간식 탭에 따른 폼 영역 표시 */

export function applyEntryFormModeToModalUI(mode) {

    applyEntryModeLabels(mode);

    setEntryExtrasVisibility(mode);

    refreshEntryFormModeTabs();

    syncEntryFieldQuickInputToggles();

    applyEntryQuickInputUi();

    applyEntryDetailRecordUi();

}



/**

 * 식사/간식 탭 전환 (슬롯은 유지)

 * @param {'meal'|'snack'} mode

 */

export function switchEntryFormMode(mode) {

    const next = mode === 'snack' ? 'snack' : 'meal';

    if (appState.entryFormMode === next) return;

    appState.entryFormMode = next;

    applyEntryFormModeToModalUI(next);

    if (next === 'snack') {

        appState.selectedSnackPlaceMainTag = appState.selectedSnackPlaceMainTag || null;

    }

    renderEntryChips();

    applyEntryQuickInputUi();

    applyEntryDetailRecordUi();

}



function applyEntrySlotAndDate(date, slotId) {

    const slot = SLOTS.find((s) => s.id === slotId);

    if (!slot || !date) return false;

    appState.currentEditingDate = date;

    appState.currentEditingSlotId = slotId;

    refreshEntryModalHeader();

    return true;

}



function onHeaderDateChange() {

    const dateInput = document.getElementById('entryHeaderDate');

    const date = dateInput?.value?.trim();

    if (!date) return;

    appState.currentEditingDate = date;

    syncEntryHeaderDateButtonLabel();

    refreshEntryModalHeader();

}



function onHeaderSlotChange() {

    const slotSelect = document.getElementById('entryHeaderSlotSelect');

    const picked = parseHeaderSlotOptionValue(slotSelect?.value, currentHeaderSlotList());

    const date = appState.currentEditingDate || document.getElementById('entryHeaderDate')?.value?.trim();

    if (!picked || !date) return;

    appState.currentEditingSlotKey = picked.key;

    if (!applyEntrySlotAndDate(date, picked.base)) return;

    const slot = SLOTS.find((s) => s.id === picked.base);

    const modeFromSlot = getEntryModeFromSlot(slot);

    if (appState.entryFormMode !== modeFromSlot) {

        switchEntryFormMode(modeFromSlot);

    } else {

        renderEntryChips();

    }

}



function ensureDatePickerView() {

    const iso =

        document.getElementById('entryHeaderDate')?.value?.trim() ||

        appState.currentEditingDate ||

        localTodayIso();

    const base = new Date(`${iso}T12:00:00`);

    if (Number.isNaN(base.getTime())) {

        const now = new Date();

        datePickerView = { year: now.getFullYear(), month: now.getMonth() };

        return;

    }

    datePickerView = { year: base.getFullYear(), month: base.getMonth() };

}



function renderEntryHeaderDatePicker() {

    if (!datePickerView) return;

    const { year, month } = datePickerView;

    const label = document.getElementById('entryHeaderDatePickerMonthLabel');

    const grid = document.getElementById('entryHeaderDatePickerGrid');

    if (!label || !grid) return;



    label.textContent = `${year}년 ${month + 1}월`;



    const selected = document.getElementById('entryHeaderDate')?.value?.trim() || '';

    const todayIso = localTodayIso();

    const first = new Date(year, month, 1);

    const startPad = first.getDay();

    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const totalCells = Math.ceil((startPad + daysInMonth) / 7) * 7;



    const parts = [];

    for (let i = 0; i < totalCells; i++) {

        const dayNum = i - startPad + 1;

        if (dayNum < 1 || dayNum > daysInMonth) {

            parts.push('<span class="entry-header-date-picker__day entry-header-date-picker__day--empty" aria-hidden="true"></span>');

            continue;

        }

        const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;

        const classes = ['entry-header-date-picker__day'];

        if (iso === selected) classes.push('is-selected');

        if (iso === todayIso) classes.push('is-today');

        const isFuture = iso > todayIso;

        if (isFuture) classes.push('is-disabled');

        const disabledAttr = isFuture ? ' disabled aria-disabled="true"' : '';

        parts.push(

            `<button type="button" class="${classes.join(' ')}" data-date="${iso}"${disabledAttr}>${dayNum}</button>`

        );

    }

    grid.innerHTML = parts.join('');

    syncEntryHeaderDatePickerNav();

}



export function openEntryHeaderDatePicker() {

    ensureDatePickerView();

    renderEntryHeaderDatePicker();

    const picker = document.getElementById('entryHeaderDatePicker');

    picker?.classList.remove('hidden');

    document.getElementById('entryHeaderDatePickerPrev')?.focus();

}



export function closeEntryHeaderDatePicker() {

    document.getElementById('entryHeaderDatePicker')?.classList.add('hidden');

}



function selectEntryHeaderDate(iso) {

    if (isFutureEntryHeaderDateIso(iso)) return;

    const input = document.getElementById('entryHeaderDate');

    if (input) input.value = iso;

    closeEntryHeaderDatePicker();

    onHeaderDateChange();

}



function shiftDatePickerMonth(delta) {

    if (!datePickerView) ensureDatePickerView();

    if (!datePickerView) return;

    let { year, month } = datePickerView;

    month += delta;

    if (month < 0) {

        month = 11;

        year -= 1;

    } else if (month > 11) {

        month = 0;

        year += 1;

    }

    if (delta > 0 && isMonthAfterCurrentCalendarMonth(year, month)) return;

    datePickerView = { year, month };

    renderEntryHeaderDatePicker();

}



export function bindEntryModalHeaderOnce() {

    if (headerBound) return;

    headerBound = true;



    document.getElementById('entryFormModeBtnMeal')?.addEventListener('click', () => {

        switchEntryFormMode('meal');

    });

    document.getElementById('entryFormModeBtnSnack')?.addEventListener('click', () => {

        switchEntryFormMode('snack');

    });

    document.getElementById('entryHeaderDateBtn')?.addEventListener('click', () => {

        openEntryHeaderDatePicker();

    });

    document.getElementById('entryHeaderSlotSelect')?.addEventListener('change', onHeaderSlotChange);



    document.getElementById('entryHeaderDatePickerPrev')?.addEventListener('click', () => {

        shiftDatePickerMonth(-1);

    });

    document.getElementById('entryHeaderDatePickerNext')?.addEventListener('click', () => {

        shiftDatePickerMonth(1);

    });

    document.querySelector('.entry-header-date-picker__backdrop')?.addEventListener('click', () => {

        closeEntryHeaderDatePicker();

    });

    document.getElementById('entryHeaderDatePickerGrid')?.addEventListener('click', (e) => {

        const btn = e.target.closest('[data-date]');

        if (!btn || btn.disabled || btn.classList.contains('is-disabled')) return;

        const iso = btn.getAttribute('data-date');

        if (iso) selectEntryHeaderDate(iso);

    });



    document.addEventListener('keydown', (e) => {

        const picker = document.getElementById('entryHeaderDatePicker');

        if (!picker || picker.classList.contains('hidden')) return;

        if (e.key === 'Escape') {

            e.preventDefault();

            closeEntryHeaderDatePicker();

        }

    });

}



