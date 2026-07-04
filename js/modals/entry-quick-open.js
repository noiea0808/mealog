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

const FAB_SPIN_CLASS = 'entry-quick-input-fab--spin';
const FAB_SPIN_MS = 380;

let quickFabOpening = false;

/** @param {HTMLElement} fab */
function playEntryQuickInputFabSpin(fab) {
    return new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            fab.removeEventListener('animationend', onEnd);
            resolve();
        };
        const onEnd = (e) => {
            if (e.target !== fab || e.animationName !== 'entry-quick-input-fab-spin') return;
            done();
        };
        fab.classList.add(FAB_SPIN_CLASS);
        fab.addEventListener('animationend', onEnd);
        window.setTimeout(done, FAB_SPIN_MS + 80);
    });
}

/** FAB 탭 — 180° 회전 피드백 후 기록 시트 */
export async function triggerQuickEntryFromFab(fab) {
    if (quickFabOpening || !fab || fab.classList.contains('hidden')) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    quickFabOpening = true;
    try {
        await playEntryQuickInputFabSpin(fab);
        const date = localTodayIso();
        const slotId = resolveQuickEntrySlotId(date);
        await openModal(date, slotId, null);
    } finally {
        fab.classList.remove(FAB_SPIN_CLASS);
        quickFabOpening = false;
    }
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
