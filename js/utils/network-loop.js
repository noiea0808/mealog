/**
 * 전송 채널 넛지.
 *
 * 이 파일은 「지금 온라인인가」를 판정하지 않는다. 판정 값도, 그 값을 읽는 API 도 없다.
 * 모바일에서 그 지식은 원리적으로 정확할 수 없다 — navigator.onLine 은 재연결 후에도 false 로
 * 고착되고, 실패로 세운 플래그는 조용히 half-open 된 경우 아예 서지 않는다. 7~8월 네트워크
 * 버그는 전부 「틀린 지식을 게이트로 썼다」는 같은 뿌리였고, 지식을 더 정확하게 만들려는 시도가
 * 계속 실패했으므로 지식 자체를 쓰지 않는 쪽으로 뒤집었다.
 *
 * 남은 사실은 하나다 — Firestore 가 서버 응답을 마지막으로 전달한 시각(network-activity).
 * 채널이 오래 조용하고 보낼 것이 남아 있으면 한 번 찔러본다. 찌른 결과가 성공인지는 판정하지
 * 않는다. 살아났으면 다음 서버 응답이 그 시각을 갱신할 것이고, 아니면 다음 넛지가 또 찌른다.
 * 판정이 없으므로 판정이 틀려서 복구가 막히는 일도 없다.
 *
 * 「내 기록이 서버에 올라갔는가」는 여기가 답하지 않는다. 그건 추측이 아니라 기록별 서버 ack
 * 으로 알 수 있는 사실이고, meal-sync-manager 가 그것만 본다.
 */
import { getMealogFirestoreActivityAgeMs } from './network-activity.js';
import {
    auth,
    kickFirestoreTransportReconnect,
    preflightFirestoreAuth,
    rebindFirestoreListenersIfRegistered
} from '../firebase.js';
import { withDeadlineOr, Lease } from './with-deadline.js';

/** 이만큼 조용하면 토큰 갱신·리스너 재부착까지 함께 한다. 가벼운 kick 으로 안 풀린 상황. */
const DEEP_NUDGE_MS = 60000;
/** 각 단계의 상한 — half-open 에서 영원히 resolve 되지 않는 Promise 가 넛지를 마비시키지 않게. */
const STEP_TIMEOUT_MS = 8000;

/**
 * 넛지 점유. 불린이 아니라 **만료 있는 리스**다.
 *
 * 불린이면 안쪽에서 한 번이라도 매달릴 때 영구히 잠기고, 그러면 네트워크가 돌아와도 채널을
 * 다시 찌를 방법이 사라진다 — 복구 수단 자체가 죽는 것이다. 리스는 시간으로 풀린다.
 * 만료가 실제로 발생하면 `lease.expired` 이벤트로 계측에 남아 원인을 추적할 수 있다.
 */
const nudgeLease = new Lease('network-nudge', STEP_TIMEOUT_MS * 3);
let lastNudgeAt = 0;

/**
 * 넛지 최소 간격. 조용한 시간이 길수록 뜸하게 — 백오프를 별도 카운터·사다리로 들고 있지 않고
 * 「얼마나 조용했나」에서 파생한다. 상태가 없으니 리셋을 놓쳐 어긋날 일도 없다.
 */
function minIntervalForQuiet(quietMs) {
    if (quietMs < 60000) return 5000;
    if (quietMs < 300000) return 20000;
    return 60000;
}

/**
 * 토큰 갱신은 firebase.js 의 preflightFirestoreAuth 가 상한까지 포함해 담당한다.
 * 예전에는 여기에 자체 withTimeout 복붙본이 있었는데, 같은 헬퍼가 meal-outbox-drain.js 에도
 * 한 벌 더 있으면서 정작 필요한 호출부에는 안 걸려 있었다 — 관문이 없다는 증거였다.
 */

/**
 * 채널을 한 번 찌른다. 얼마나 세게 찌를지는 조용한 시간에서 파생한다 — 사다리도 실패 카운터도 없다.
 *
 * 인스턴스 재생성(terminate)은 여기서 하지 않는다. 붙어 있는 리스너를 전부 죽이므로, 아직
 * 핸드셰이크 중인 채널에 걸리면 스스로 만든 연결을 스스로 끊는다. SDK 가 실제로 깨진 경우는
 * firebase.js 의 전역 assertion 핸들러가 관측해서 따로 복구한다.
 */
async function nudge(reason, deep) {
    const ran = await nudgeLease.run(async () => {
        lastNudgeAt = Date.now();
        try {
            const hard = deep === true || getMealogFirestoreActivityAgeMs() >= DEEP_NUDGE_MS;
            if (hard) {
                await withDeadlineOr(
                    preflightFirestoreAuth(auth.currentUser, { force: true }),
                    STEP_TIMEOUT_MS,
                    undefined,
                    'nudge-auth'
                );
            }
            await withDeadlineOr(
                kickFirestoreTransportReconnect(reason || 'nudge', { force: true }),
                STEP_TIMEOUT_MS,
                false,
                'nudge-kick'
            );
            if (hard) rebindFirestoreListenersIfRegistered();
        } catch (e) {
            console.warn('[network] 넛지 실패:', reason, e?.message || e);
        }
        return true;
    });
    return ran === true;
}

/**
 * 채널을 찔러 달라는 힌트. OS·플러그인 이벤트, 전송 실패, 남은 작업이 안 나가는 상황 등이
 * 전부 이 함수 하나로 들어온다. 무엇이 왔는지 구분하지 않고, 시도를 막는 조건으로도 쓰지 않는다.
 */
export function pokeNetworkLoop(reason = '') {
    const quiet = getMealogFirestoreActivityAgeMs();
    if (Date.now() - lastNudgeAt < minIntervalForQuiet(quiet)) return;
    void nudge(reason, false);
}

/**
 * 사용자가 결과를 기다리는 경로(당겨서 새로고침·재전송 버튼) — 간격을 무시하고 세게 찌른다.
 * 성공 여부는 돌려주지 않는다. 이 함수가 boolean 을 돌려주면 호출부가 그걸 다시 게이트로 쓰게 되고,
 * 그것이 없애려는 구조 그 자체다.
 */
export async function runNetworkRecoveryNow(reason = '') {
    await nudge(reason, true);
}
