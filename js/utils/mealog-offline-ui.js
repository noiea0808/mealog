/**
 * 전송 계층 오프라인 UX — 전면「연결할 수 없습니다」팝업 대신 FAB·토스트만 사용.
 */
import { isNetworkChannelDownForDisplay } from './network-loop.js';

/**
 * 전송 계층이 끊긴 상태인지 — 화면 표시용 단일 판정.
 *
 * 값의 주인은 network-loop 이다. 여기서는 표시용(3초 유예 적용) 값만 돌려준다 — 사다리 0단이나
 * 자연 회복으로 금방 풀리는 끊김까지 사용자에게 보이면 없어질 걱정을 만들 뿐이다. 스냅샷 removed
 * 보류처럼 정합성이 걸린 판정은 이 함수를 쓰지 말고 network-loop.js 의 isNetworkChannelDown()을
 * 직접 써야 한다(즉시값, 유예 없음).
 */
export function isMealogTransportOffline() {
    return isNetworkChannelDownForDisplay();
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
