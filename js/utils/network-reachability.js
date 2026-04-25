/**
 * navigator.onLine 과 불일치할 때를 대비한 앱 로컬 네트워크 상태.
 * fetch / Firestore 쓰기 등이 끊김 계열로 실패하면 즉시 offline 으로 본다.
 */
import { appState } from '../state.js';
import { isLikelyNetworkTransportFailure } from '../ui.js';
import { notifyTransportOfflineUi } from './mealog-offline-ui.js';
import { applyMealSyncAbandonOnOffline } from './meal-entry-pending.js';
import { refreshMealSyncResendNavButton } from '../main/meal-sync-resend-header.js';

let fetchBridgeInstalled = false;

function mealogMainAppVisible() {
    try {
        const main = document.getElementById('mainApp');
        return !!(main && !main.classList.contains('hidden'));
    } catch (_) {
        return false;
    }
}

/**
 * @param {unknown} err
 * @returns {boolean} 앱을 로컬 오프라인으로 맞췄는지
 */
export function tryMarkAppOfflineFromNetworkFailure(err) {
    if (!isLikelyNetworkTransportFailure(err)) return false;
    const alreadyForced = appState.localNetworkForcedOffline === true;
    appState.localNetworkForcedOffline = true;
    // Firestore·fetch 등이 동시에 여러 번 실패하면 오버레이·abandon·타임라인 갱신이 연속 호출되어
    // 팝업이 반복되고 UI가 멈춘 것처럼 보임 → 최초 1회만 무거운 처리 수행
    if (alreadyForced) {
        void import('../main/meal-sync-resend-header.js').then((m) => {
            try {
                if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
            } catch (_) {
                /* ignore */
            }
        });
        return true;
    }
    try {
        applyMealSyncAbandonOnOffline();
    } catch (_) {
        /* ignore */
    }
    if (mealogMainAppVisible() && window.currentUser) {
        try {
            notifyTransportOfflineUi();
        } catch (_) {
            /* ignore */
        }
    }
    void import('../render/timeline.js').then((m) => {
        try {
            m.updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
    });
    try {
        refreshMealSyncResendNavButton();
    } catch (_) {
        /* ignore */
    }
    return true;
}

export function clearLocalNetworkForcedOffline() {
    appState.localNetworkForcedOffline = false;
}

/** window.fetch 실패 시 로컬 오프라인 플래그 (한 번만 설치) */
export function installFetchFailureAppOfflineBridge() {
    if (typeof window === 'undefined' || fetchBridgeInstalled) return;
    const w = window;
    const orig = w.fetch;
    if (typeof orig !== 'function') return;
    fetchBridgeInstalled = true;
    w.fetch = function fetchWithOfflineBridge() {
        return orig.apply(this, arguments).then(
            (res) => {
                // 전송이 한 번이라도 성공하면(HTTP 응답 수신) 로컬 강제 오프라인 해제.
                // 불안정 망에서 offline/online 이벤트 없이 끊겼다가 복구되는 경우가 많아 이 경로가 필수.
                clearLocalNetworkForcedOffline();
                return res;
            },
            (err) => {
                tryMarkAppOfflineFromNetworkFailure(err);
                throw err;
            }
        );
    };
}
