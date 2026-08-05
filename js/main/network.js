/**
 * 네트워크 이벤트 배선.
 *
 * 재연결 판단·재시도는 utils/network-loop.js 의 단일 루프가 한다. 이 파일은 OS·플러그인 이벤트를
 * 루프를 깨우는 호출 하나로 연결하고, 단절이 확인됐을 때의 UI 전환만 담당한다.
 *
 * 복구 후속 작업은 여기에 없다. 「복구에 성공한 시점」에 훅을 걸던 방식은 끊김이 관측됐을 때만
 * 동작해서, 조용히 half-open 된 경우 기록 재전송·모먼트 재로드가 통째로 누락됐다. 두 작업은
 * 각자 남은 일이 있으면 스스로 재시도하는 구조로 옮겼다.
 *   - 미전송 기록: utils/meal-outbox-drain.js
 *   - 모먼트 피드: main/moment-feed-auto-retry.js
 */
import { notifyTransportOfflineUi } from '../utils/mealog-offline-ui.js';
import { applyMealSyncAbandonOnOffline } from '../utils/meal-entry-pending.js';
import { installFetchFailureAppOfflineBridge } from '../utils/network-reachability.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
import {
    startNetworkLoop,
    pokeNetworkLoop,
    markNetworkChannelDown,
    runNetworkRecoveryNow
} from '../utils/network-loop.js';

function mealogMainAppVisible() {
    try {
        const main = document.getElementById('mainApp');
        return !!(main && !main.classList.contains('hidden'));
    } catch (_) {
        return false;
    }
}

/**
 * App Check·Auth 토큰 갱신 후 즉시 복구 시도.
 * @deprecated 이벤트 경로는 pokeNetworkLoop 를 쓴다. window.Mealog.runNetworkRecovery 호환용.
 */
export async function runMealogNetworkRecovery() {
    await runNetworkRecoveryNow('manual');
}

/**
 * 수동 새로고침·다시 불러오기 직전: 복구 루프를 즉시 1회 돌려 채널을 확인한다.
 * @param {string} [reason]
 * @param {{ rebindListeners?: boolean }} [options]
 * @returns {Promise<boolean>} 채널이 살아 있으면 true
 */
export async function prepareFirestoreNetworkForManualReload(reason = 'manual-reload', options = {}) {
    return runNetworkRecoveryNow(reason, { forceRebind: options.rebindListeners === true });
}

/**
 * 모먼트「다시 불러오기」·당겨서 새로고침 직전 네트워크 준비.
 * @returns {Promise<boolean>} 채널이 살아 있으면 true
 */
export async function prepareMomentFeedNetworkForReload() {
    return runNetworkRecoveryNow('moment-reload');
}

/** 오프라인 진입 시 공통 UI 처리 */
function applyOfflineUiTransition() {
    try {
        applyMealSyncAbandonOnOffline();
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
    } catch (_) {
        /* ignore */
    }
    if (mealogMainAppVisible() && window.currentUser) {
        notifyTransportOfflineUi();
    }
}

/**
 * 단절 통지 — 이벤트가 왔다는 것 자체는 신뢰하되(고착된 boolean 을 읽는 것과 다르다),
 * 복구 여부 판단은 루프에 맡긴다.
 */
function handleOfflineSignal(reason) {
    markNetworkChannelDown(reason);
    applyOfflineUiTransition();
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    installFetchFailureAppOfflineBridge();

    window.addEventListener('offline', () => handleOfflineSignal('offline-event'));
    window.addEventListener('online', () => pokeNetworkLoop('online-event'));

    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'visible') return;
            pokeNetworkLoop('foreground');
        },
        { passive: true }
    );

    // bare import('@capacitor/app')는 WebView에서 pending 되는 경우가 있어 window.Capacitor.Plugins 사용
    try {
        const App = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
        if (App?.addListener) {
            App.addListener('resume', () => pokeNetworkLoop('app-resume'));
        }
    } catch (_) {
        /* 웹 전용 빌드 등 */
    }

    // Capacitor Network: Wi-Fi↔LTE 전환·단절을 네이티브에서 통지 (WebView online 이벤트 누락 보완)
    try {
        const Network = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.Network : null;
        if (Network?.addListener) {
            Network.addListener('networkStatusChange', (status) => {
                if (status && status.connected === false) {
                    handleOfflineSignal('cap-network-disconnected');
                    return;
                }
                pokeNetworkLoop('cap-network');
            });
        }
    } catch (_) {
        /* 플러그인 미탑재(웹 등) */
    }

    // Network Information API: online 이벤트가 안 올 때도 연결 전환 시 복구
    try {
        const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
        if (conn && typeof conn.addEventListener === 'function') {
            conn.addEventListener('change', () => pokeNetworkLoop('connection-change'), { passive: true });
        }
    } catch (_) {
        /* ignore */
    }

    startNetworkLoop();
}
