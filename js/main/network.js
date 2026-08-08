/**
 * 네트워크 이벤트 배선.
 *
 * OS·플러그인 이벤트는 아무것도 판단하지 않는다. 「offline 이 왔으니 오프라인이다」로 취급하지
 * 않고, 전부 채널을 한 번 찔러 보라는 힌트로만 쓴다 — 이벤트가 사실인지 아닌지를 앱이 알 방법이
 * 없기 때문이다(WebView 는 재연결 후에도 offline 을 남기고, 전환 시 online 을 안 주기도 한다).
 *
 * 오프라인 「전환 시」 UI 처리도 여기 없다. 사용자에게 필요한 정보는 무선 상태가 아니라
 * 「내 기록이 서버에 올라갔는가」이고, 그건 기록별 ack 이 답한다(meal-sync-manager → 재전송 FAB).
 */
import { installFetchFailureAppOfflineBridge } from '../utils/network-reachability.js';
import { pokeNetworkLoop, runNetworkRecoveryNow } from '../utils/network-loop.js';

/**
 * App Check·Auth 토큰 갱신 후 즉시 넛지.
 * @deprecated 이벤트 경로는 pokeNetworkLoop 를 쓴다. window.Mealog.runNetworkRecovery 호환용.
 */
export async function runMealogNetworkRecovery() {
    await runNetworkRecoveryNow('manual');
}

/**
 * 수동 새로고침·다시 불러오기 직전: 채널을 세게 한 번 찌른다.
 * 성공 여부는 돌려주지 않는다 — 호출부가 그걸 게이트로 쓰면 다시 같은 문제가 생긴다.
 * @param {string} [reason]
 */
export async function prepareFirestoreNetworkForManualReload(reason = 'manual-reload') {
    await runNetworkRecoveryNow(reason);
}

/** 모먼트「다시 불러오기」·당겨서 새로고침 직전 네트워크 준비. */
export async function prepareMomentFeedNetworkForReload() {
    await runNetworkRecoveryNow('moment-reload');
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    installFetchFailureAppOfflineBridge();

    window.addEventListener('offline', () => pokeNetworkLoop('offline-event'));
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
            Network.addListener('networkStatusChange', () => pokeNetworkLoop('cap-network'));
        }
    } catch (_) {
        /* 플러그인 미탑재(웹 등) */
    }

    // Network Information API: online 이벤트가 안 올 때도 연결 전환 시 넛지
    try {
        const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
        if (conn && typeof conn.addEventListener === 'function') {
            conn.addEventListener('change', () => pokeNetworkLoop('connection-change'), { passive: true });
        }
    } catch (_) {
        /* ignore */
    }
}
