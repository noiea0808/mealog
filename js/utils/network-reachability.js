/**
 * navigator.onLine 과 불일치할 때를 대비한 앱 로컬 네트워크 상태.
 * fetch / Firestore 쓰기 등이 끊김 계열로 실패하면 즉시 offline 으로 본다.
 */
import { isLikelyNetworkTransportFailure } from '../ui.js';
import { markNetworkChannelDown, pokeNetworkLoop, isNetworkChannelDown } from './network-loop.js';
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
    const alreadyForced = isNetworkChannelDown();
    // 오프라인 표시 + 복구 루프 기동 — 이후 재연결 판단은 전적으로 루프가 한다.
    markNetworkChannelDown('transport-failure');
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

/**
 * 원격 호스트로 나간 요청인지. Capacitor 앱은 자산을 localhost 에서 서빙하고 Service Worker 캐시 응답도
 * 성공으로 잡히므로, 자기 origin 요청의 성공은 인터넷 연결의 증거가 되지 못한다.
 */
function isRemoteRequestUrl(input) {
    try {
        const raw = typeof input === 'string' ? input : input?.url || String(input || '');
        if (!raw) return false;
        const url = new URL(raw, window.location.href);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        return url.origin !== window.location.origin;
    } catch (_) {
        return false;
    }
}

/** window.fetch 결과를 복구 루프에 전달 (한 번만 설치) */
export function installFetchFailureAppOfflineBridge() {
    if (typeof window === 'undefined' || fetchBridgeInstalled) return;
    const w = window;
    const orig = w.fetch;
    if (typeof orig !== 'function') return;
    fetchBridgeInstalled = true;
    w.fetch = function fetchWithOfflineBridge(input) {
        const remote = isRemoteRequestUrl(input);
        return orig.apply(this, arguments).then(
            (res) => {
                // 원격 요청 성공은 「무선이 살아났다」는 힌트일 뿐 Firestore 채널 생존의 증거가 아니다.
                // 오프라인 표시를 직접 내리지 않고, 루프를 깨워 채널을 실제로 확인하게 한다.
                if (remote && isNetworkChannelDown()) pokeNetworkLoop('remote-fetch-ok');
                return res;
            },
            (err) => {
                tryMarkAppOfflineFromNetworkFailure(err);
                throw err;
            }
        );
    };
}
