/**
 * 타임라인 퀵입력 — 오늘 날짜·시간대별 기본 슬롯으로 입력 시트 열기
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { openModal } from './entry-and-core.js';

const QUICK_MAIN_SLOT_IDS = ['morning', 'lunch', 'dinner'];

export function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** @param {Date} [refDate] */
export function getTimeBasedMainSlotId(refDate = new Date()) {
    const hour = refDate.getHours();
    if (hour < 11) return 'morning';
    if (hour < 17) return 'lunch';
    return 'dinner';
}

function isSlotOccupiedOnDate(dateIso, slotId, history) {
    return history.some((m) => m?.date === dateIso && m?.slotId === slotId);
}

/**
 * 시간대 기본 슬롯부터 순서대로 비어 있는 첫 본식 슬롯.
 * 모두 차 있으면 시간대 기본 슬롯(동일 슬롯 추가 기록).
 * @param {string} dateIso
 * @param {Date} [refDate]
 */
export function resolveQuickEntrySlotId(dateIso, refDate = new Date()) {
    const preferred = getTimeBasedMainSlotId(refDate);
    const startIdx = QUICK_MAIN_SLOT_IDS.indexOf(preferred);
    const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];

    for (let i = startIdx; i < QUICK_MAIN_SLOT_IDS.length; i++) {
        const slotId = QUICK_MAIN_SLOT_IDS[i];
        if (!isSlotOccupiedOnDate(dateIso, slotId, history)) return slotId;
    }
    return preferred;
}

export function syncEntryQuickInputFabVisibility() {
    const fab = document.getElementById('entryQuickInputFab');
    if (!fab) return;
    const show =
        appState.currentTab === 'timeline' &&
        window.currentUser &&
        !window.currentUser.isAnonymous;
    fab.classList.toggle('hidden', !show);
    fab.setAttribute('aria-hidden', show ? 'false' : 'true');
}

export async function openQuickEntryModal() {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const date = localTodayIso();
    const slotId = resolveQuickEntrySlotId(date);
    await openModal(date, slotId, null);
}
