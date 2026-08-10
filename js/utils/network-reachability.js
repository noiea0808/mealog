/**
 * fetch·Firestore 실패를 전송 채널 넛지로 연결하는 브리지.
 *
 * 실패를 「오프라인」이라는 앱 상태로 승격하지 않는다. 실패는 「지금 채널이 의심스럽다」는 힌트일
 * 뿐이고, 힌트는 찔러보는 데만 쓴다. 상태로 만들면 그 값이 틀렸을 때(특히 재연결 후에도 안 풀릴 때)
 * 앱 전체가 그 오판을 따라간다 — 그게 없애려는 구조다.
 */
import { isLikelyNetworkTransportFailure } from '../ui.js';
import { pokeNetworkLoop } from './network-loop.js';
import { isMealogFirestoreActivityStale } from './network-activity.js';

let fetchBridgeInstalled = false;

/** 성공한 원격 요청으로 넛지를 깨울 때 요구하는 「채널이 조용한」 시간 (outbox-worker 와 동일 기준) */
const CHANNEL_QUIET_MS = 20000;

/**
 * 끊김 계열 실패였다면 채널을 찔러 달라고 알린다.
 * @param {unknown} err
 * @returns {boolean} 끊김 계열로 보고 넛지했는지
 */
export function noteNetworkTransportFailure(err) {
    if (!isLikelyNetworkTransportFailure(err)) return false;
    pokeNetworkLoop('transport-failure');
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

/** window.fetch 결과를 넛지로 전달 (한 번만 설치) */
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
                /**
                 * 원격 요청 성공은 「무선이 살아났다」는 힌트일 뿐 Firestore 채널 생존의 증거가 아니다.
                 * 그래서 무엇을 해제하지 않고, 채널을 찔러보게만 한다(넛지 간격 안이면 무시된다).
                 *
                 * 단, **채널이 조용할 때만** 찌른다. 넛지는 disableNetwork→enableNetwork 이므로
                 * 멀쩡하거나 아직 핸드셰이크 중인 채널에 걸면 스스로 만든 연결을 스스로 끊는다.
                 * 실측: 부팅 중 Analytics 의 fetchDynamicConfig 성공이 이 경로로 넛지를 깨웠고,
                 * 그 disable 창에 걸린 첫 조회들이 한꺼번에 "client is offline" 로 실패했다.
                 * 성공한 요청은 「고칠 것이 있다」는 증거가 아니므로 조용함을 조건으로 둔다.
                 * (outbox-worker 의 `outbox-worker-quiet` 넛지가 쓰는 것과 같은 기준)
                 */
                if (remote && isMealogFirestoreActivityStale(CHANNEL_QUIET_MS)) {
                    pokeNetworkLoop('remote-fetch-ok');
                }
                return res;
            },
            (err) => {
                noteNetworkTransportFailure(err);
                throw err;
            }
        );
    };
}
