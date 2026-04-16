/**
 * 전송 계층 오프라인 UX — 전면「연결할 수 없습니다」팝업 대신 FAB·토스트만 사용.
 */
import { appState } from '../state.js';

export function isMealogTransportOffline() {
    if (appState.localNetworkForcedOffline === true) return true;
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    } catch (_) {
        /* ignore */
    }
    return false;
}

let lastOfflineToastAt = 0;
const OFFLINE_TOAST_COOLDOWN_MS = 6500;

/** 네트워크 단절이 감지될 때 — FAB 갱신 후 토스트(쿨다운) */
export function notifyTransportOfflineUi() {
    void import('../main/meal-sync-resend-header.js').then((m) => {
        try {
            if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
        const now = Date.now();
        if (now - lastOfflineToastAt < OFFLINE_TOAST_COOLDOWN_MS) return;
        lastOfflineToastAt = now;
        void import('../ui.js').then(({ showToast }) => {
            try {
                showToast('잠시 오프라인 상태에요.', 'info');
            } catch (_) {
                /* ignore */
            }
        });
    });
}

export function countOfflineDraftMeals() {
    if (!Array.isArray(window.mealHistory)) return 0;
    let n = 0;
    for (const m of window.mealHistory) {
        if (m && m._mealogOfflineDraft === true) n++;
    }
    return n;
}

export function markMealOfflineDraftForRecord(mealId) {
    if (!isMealogTransportOffline()) return;
    const mid = mealId != null ? String(mealId) : '';
    if (!mid || mid.startsWith('temp_')) return;
    const hist = window.mealHistory;
    if (!Array.isArray(hist)) return;
    const i = hist.findIndex((m) => m && String(m.id) === mid);
    if (i < 0) return;
    hist[i] = { ...hist[i], _mealogOfflineDraft: true };
}

export function clearOfflineDraftFlagsOnMeals() {
    if (!Array.isArray(window.mealHistory)) return;
    for (let i = 0; i < window.mealHistory.length; i++) {
        const m = window.mealHistory[i];
        if (m && m._mealogOfflineDraft === true) {
            const next = { ...m };
            delete next._mealogOfflineDraft;
            window.mealHistory[i] = next;
        }
    }
}
