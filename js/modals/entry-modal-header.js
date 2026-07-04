/**
 * 기록 모달 헤더 — 날짜·슬롯 인라인 편집, 식사/간식 탭
 */
import { SLOTS } from '../constants.js';
import { appState } from '../state.js';
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

/** @param {object|null|undefined} record @param {{ type?: string }|null|undefined} slot */
export function inferEntryFormModeFromRecord(record, slot) {
    if (record) {
        if (record.snackType || record.snackPlaceMain) return 'snack';
        if (record.mealType) return 'meal';
    }
    return getEntryModeFromSlot(slot);
}

/** 슬롯 표시 라벨 (동일 슬롯 다건이면 점심2 형식) */
export function getEntrySlotTitleLabel(date, slotId, entryId = null) {
    const slot = SLOTS.find((s) => s.id === slotId);
    if (!slot) return '';
    const siblings = (window.mealHistory || []).filter(
        (m) => m?.date === date && m?.slotId === slotId && m.id !== entryId
    );
    if (entryId) {
        const self = window.mealHistory?.find((m) => m.id === entryId);
        const all = self ? [...siblings, self] : [...siblings];
        all.sort(
            (a, b) =>
                (a.time || '').localeCompare(b.time || '') ||
                String(a.id || '').localeCompare(String(b.id || ''))
        );
        const ord = all.findIndex((m) => m.id === entryId) + 1;
        return all.length > 1 ? `${slot.label}${ord}` : slot.label;
    }
    const nextOrd = siblings.length + 1;
    return siblings.length > 0 ? `${slot.label}${nextOrd}` : slot.label;
}

export function formatEntryModalHeaderTitle(date, slotId, entryId = null) {
    const slotLabel = getEntrySlotTitleLabel(date, slotId, entryId);
    return slotLabel;
}

function populateEntryHeaderSlotOptions() {
    const slotSelect = document.getElementById('entryHeaderSlotSelect');
    if (!slotSelect) return;
    const current = appState.currentEditingSlotId;
    slotSelect.innerHTML = SLOTS.map(
        (slot) =>
            `<option value="${slot.id}">${slot.label}${slot.type === 'snack' ? ' · 간식' : ''}</option>`
    ).join('');
    if (current) slotSelect.value = current;
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
    if (slotSelect && slotId) {
        slotSelect.value = slotId;
    }
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
    refreshEntryModalHeader();
}

function onHeaderSlotChange() {
    const slotSelect = document.getElementById('entryHeaderSlotSelect');
    const slotId = slotSelect?.value;
    const date = appState.currentEditingDate || document.getElementById('entryHeaderDate')?.value?.trim();
    if (!slotId || !date) return;
    if (!applyEntrySlotAndDate(date, slotId)) return;
    const slot = SLOTS.find((s) => s.id === slotId);
    const modeFromSlot = getEntryModeFromSlot(slot);
    if (appState.entryFormMode !== modeFromSlot) {
        switchEntryFormMode(modeFromSlot);
    } else {
        renderEntryChips();
    }
}

/** @deprecated 슬롯 피커 제거 — no-op */
export function openEntrySlotPicker() {}

/** @deprecated 슬롯 피커 제거 — no-op */
export function closeEntrySlotPicker() {}

export function bindEntryModalHeaderOnce() {
    if (headerBound) return;
    headerBound = true;

    document.getElementById('entryFormModeBtnMeal')?.addEventListener('click', () => {
        switchEntryFormMode('meal');
    });
    document.getElementById('entryFormModeBtnSnack')?.addEventListener('click', () => {
        switchEntryFormMode('snack');
    });
    document.getElementById('entryHeaderDate')?.addEventListener('change', onHeaderDateChange);
    document.getElementById('entryHeaderSlotSelect')?.addEventListener('change', onHeaderSlotChange);
}
