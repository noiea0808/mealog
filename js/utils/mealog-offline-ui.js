/**
 * 전송 계층 오프라인 UX — 전면「연결할 수 없습니다」팝업 대신 FAB·토스트만 사용.
 */
import { appState } from '../state.js';

/**
 * 전송 계층이 끊긴 상태인지 — 앱 전체의 단일 판정.
 *
 * 값의 주인은 network-loop 이다. 루프가 복구에 성공하면 false, 전송 실패가 확인되거나 복구 시도가
 * 실패하면 true 가 된다. navigator.onLine 은 보지 않는다 — Android WebView 에서 재연결 후에도
 * false 로 고착돼, 이 값을 읽으면 살아 있는 채널을 오프라인으로 오판한다.
 */
export function isMealogTransportOffline() {
    return appState.localNetworkForcedOffline === true;
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
