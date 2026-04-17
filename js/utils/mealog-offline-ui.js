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

/** 네트워크 단절이 감지될 때 — FAB만 갱신(오프라인 안내 토스트는 FAB 탭 시·뱃지 없을 때만 meal-sync-resend-header에서 표시) */
export function notifyTransportOfflineUi() {
    void import('../main/meal-sync-resend-header.js').then((m) => {
        try {
            if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
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
