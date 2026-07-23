/**
 * 타임라인 퀵입력 — 슬롯 피커를 연 뒤 본식·간식·하루 기록 선택
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { openEntrySlotPicker } from './entry-slot-picker.js';

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

const QUICK_MAIN_SLOT_IDS = ['morning', 'lunch', 'dinner'];

function isSlotOccupiedOnDate(dateIso, slotId, history) {
    return history.some((m) => m?.date === dateIso && m?.slotId === slotId);
}

/**
 * 시간대 기본 슬롯부터 순서대로 비어 있는 첫 본식 슬롯.
 * (슬롯 피커 하이라이트용 — 피커가 최종 선택)
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
    // 하단 중앙은 밀로그 탭 — 기록 추가는 플로팅 + FAB(슬롯 피커)
    const show =
        appState.currentTab === 'timeline' &&
        window.currentUser &&
        !window.currentUser.isAnonymous;
    fab.classList.toggle('hidden', !show);
    fab.setAttribute('aria-hidden', show ? 'false' : 'true');
}

/** 밀로그·라운지 CTA FAB 공통 — 배경 고정, + 아이콘만 360° */
export const CTA_FAB_SPIN_CLASS = 'cta-fab--spin';
export const CTA_FAB_SPIN_MS = 280;

/**
 * @param {HTMLElement} fab
 * @param {{ spinClass?: string, durationMs?: number }} [opts]
 */
export function playFabIconSpin(fab, opts = {}) {
    const spinClass = opts.spinClass || CTA_FAB_SPIN_CLASS;
    const durationMs = opts.durationMs ?? CTA_FAB_SPIN_MS;
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            fab.removeEventListener('animationend', onEnd);
            resolve();
        };
        const onEnd = (e) => {
            if (e.animationName !== 'cta-fab-icon-spin') return;
            if (!fab.contains(e.target)) return;
            done();
        };
        fab.classList.add(spinClass);
        fab.addEventListener('animationend', onEnd);
        window.setTimeout(done, durationMs + 80);
    });
}

let quickFabOpening = false;

function resolvePickerDateIso() {
    const d = appState.pageDate instanceof Date ? appState.pageDate : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** FAB 탭 — 회전 피드백 후 슬롯 피커 */
export async function triggerQuickEntryFromFab(fab) {
    if (quickFabOpening || !fab || fab.classList.contains('hidden')) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    quickFabOpening = true;
    try {
        await playFabIconSpin(fab);
        await openEntrySlotPicker(resolvePickerDateIso());
    } finally {
        fab.classList.remove(CTA_FAB_SPIN_CLASS);
        quickFabOpening = false;
    }
}

export async function openQuickEntryModal() {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    await openEntrySlotPicker(resolvePickerDateIso());
}
