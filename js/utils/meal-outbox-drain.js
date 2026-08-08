/**
 * 미전송 식사 기록 드레인 (아웃박스).
 *
 * Firestore 로컬 큐에 들어간 쓰기는 SDK 가 알아서 재전송한다. 문제는 큐 밖으로 나간 것들이다 —
 * 저장 실패로 확정됐거나, Callable 폴백을 탔거나, 사진 업로드가 남은 기록. 이들은 명시적으로
 * 다시 밀어주지 않으면 영원히 올라가지 않는다.
 *
 * 설계 원칙: 이 모듈은 네트워크 상태를 알지 못한다.
 *   예전에는 「복구에 성공했을 때」 훅으로 이 일을 했는데, 그 훅은 끊김이 관측됐을 때만 돌았다.
 *   Wi-Fi↔LTE 전환처럼 조용히 끊긴 경우에는 훅이 아예 실행되지 않아 기록이 방치됐다.
 *   그래서 「복구 시점을 알아낸다」를 포기하고, 남은 일이 있으면 백오프로 계속 시도한다.
 *
 * 반복 호출이 비용이 되지 않도록, 남은 일이 있는지는 로컬 배열만 훑어서 판정한다(서버 읽기 없음).
 * 실제 서버 대조가 필요한 정합 작업은 남은 일이 있을 때만 뒤이어 실행된다.
 */
import { db } from '../firebase.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { countUnsentMealWork } from './meal-entry-pending.js';
import { diag } from './diagnostics.js';
import { withDeadlineOr, Lease, DEADLINE } from './with-deadline.js';
import { getMealogFirestoreActivityAgeMs } from './network-activity.js';
import { pokeNetworkLoop } from './network-loop.js';
import { refreshMealSyncResendNavButton } from '../main/meal-sync-resend-header.js';

/** 남은 일이 있을 때의 재시도 간격 — 마지막 값에서 고정 */
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
/** 드레인 조건을 점검하는 주기 */
const TICK_MS = 5000;
/** waitForPendingWrites 등 쓰기 큐 flush 상한 */
const WRITE_QUEUE_FLUSH_TIMEOUT_MS = 8000;
/** 미전송 기록 N건 순차 재시도 단계의 상한 — 건당 10초 + 여유 */
const DRAIN_RETRY_PHASE_TIMEOUT_MS = 90000;

let tickTimer = 0;
let backoffIndex = 0;
let nextAttemptAt = 0;
/**
 * 드레인 점유. 불린 가드가 아니라 **만료 있는 리스**다.
 *
 * 예전 `drainInFlight` 불린은 finally 로만 풀렸는데, try 안에 상한 없는 await 가 셋 있었다
 * (reconcile 의 getDocFromServer, retryMealEntrySync 의 getDocFromServer,
 * scheduleServerAckAfterPendingWrites 의 waitForPendingWrites). 하나라도 매달리면
 * **세션이 끝날 때까지 아웃박스 드레인이 통째로 죽었다** — 사용자에게는 재전송 버튼을 눌러도
 * 아무 일도 일어나지 않는 것으로 보였다.
 *
 * 위 셋에는 이제 개별 상한도 걸었지만, 리스는 「다음에 추가될 await」까지 막아 준다.
 * 상한들의 합보다 넉넉하게 잡되 유한해야 한다.
 */
const drainLease = new Lease('meal-outbox-drain', 180000);
/** 계측: 드레인이 얼마나 오래 잠겨 있는지 — 영구 교착 판정용 */
let drainStartedAt = 0;

/**
 * 서버로 올라가지 않은 것이 남아 있는지 — 로컬 판정, 서버 읽기 없음.
 * FAB 배지와 반드시 같은 기준을 써야 한다. 다르면 배지에 N 이 뜬 채로 눌러도 여기서
 * 즉시 반환해 아무 일도 일어나지 않는 버튼이 된다.
 */
export function hasOutstandingMealWork() {
    try {
        return countUnsentMealWork() > 0;
    } catch (_) {
        return false;
    }
}

function retryDegradedMealsListener() {
    void import('./meals-listener-degraded.js').then((dg) => {
        try {
            if (typeof dg.retryMealsListenerIfDegraded === 'function') dg.retryMealsListenerIfDegraded();
        } catch (_) {
            /* ignore */
        }
    });
}

/** Firestore 큐가 비면 동기화 표시를 서버 기준으로 맞춘다 */
async function reconcileSyncUiAgainstServer() {
    // flush 가 상한 안에 확인됐는지를 그대로 넘긴다 — 타임아웃으로 빠져나온 경우까지
    // 「큐가 비었다」로 취급하면 아직 보내는 중인 쓰기의 inFlight 를 지우게 된다.
    const flushed = await withDeadlineOr(
        waitForPendingWrites(db).then(() => true),
        WRITE_QUEUE_FLUSH_TIMEOUT_MS,
        false,
        'drain-waitForPendingWrites'
    );
    try {
        const m = await import('./meal-entry-pending.js');
        // 정합 자체도 상한 안에서 — 내부의 서버 읽기들이 매달려도 드레인이 다음으로 넘어가게
        await withDeadlineOr(
            m.reconcileMealSyncAgainstServer({ writeQueueFlushed: flushed === true }),
            DEADLINE.UPLOAD,
            undefined,
            'drain-reconcile'
        );
        m.clearStuckMealPendingFlags();
    } catch (e) {
        console.warn('[meal-outbox] 서버 정합 실패:', e?.message || e);
    }
    void import('../render/timeline.js').then((tl) => {
        try {
            tl.updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
    });
    try {
        refreshMealSyncResendNavButton();
    } catch (_) {
        /* ignore */
    }
}

/** Firestore 큐 밖에 있는 기록(실패·폴백·사진 대기)을 다시 밀어 올린다 */
async function retryPendingMealEntries() {
    if (!window.currentUser || window.currentUser.isAnonymous) return;
    try {
        const mod = await import('../modals/entry-and-core.js');
        if (typeof mod.retryPendingMealEntriesOnAppReady === 'function') {
            // 기록 N건을 순차 재시도하므로 넉넉하되, 상한은 반드시 있어야 한다 —
            // 이것이 드레인의 finally 를 막던 세 경로 중 하나였다.
            await withDeadlineOr(
                mod.retryPendingMealEntriesOnAppReady(),
                DRAIN_RETRY_PHASE_TIMEOUT_MS,
                undefined,
                'drain-retryPending'
            );
        }
    } catch (_) {
        /* ignore */
    }
}

/**
 * 아웃박스를 1회 비운다. 남은 일이 없으면 즉시 반환하므로 자주 불러도 비용이 없다.
 * @param {string} [reason]
 */
export async function drainMealOutbox(reason = '') {
    if (!hasOutstandingMealWork()) return;
    if (drainLease.held) {
        diag('drain.blocked', { reason, heldMs: drainStartedAt ? Date.now() - drainStartedAt : 0 });
        return;
    }
    const startedAt = Date.now();
    drainStartedAt = startedAt;
    diag('drain.begin', { reason, outstanding: countUnsentMealWork() });
    await drainLease.run(async () => {
        try {
            retryDegradedMealsListener();
            await reconcileSyncUiAgainstServer();
            await retryPendingMealEntries();
            diag('drain.done', { reason, ms: Date.now() - startedAt, remaining: countUnsentMealWork() });
        } catch (e) {
            diag('drain.error', {
                reason,
                ms: Date.now() - startedAt,
                message: String(e?.message || e).slice(0, 120)
            });
            console.warn('[meal-outbox] 드레인 실패:', reason, e?.message || e);
        }
    });
    drainStartedAt = 0;
    if (hasOutstandingMealWork()) {
        const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
        backoffIndex += 1;
        nextAttemptAt = Date.now() + delay;
    } else {
        backoffIndex = 0;
        nextAttemptAt = 0;
    }
}

/** 보낼 게 남았는데 채널이 이만큼 조용하면 찔러본다 */
const CHANNEL_QUIET_MS = 20000;

function tick() {
    if (!hasOutstandingMealWork()) {
        backoffIndex = 0;
        nextAttemptAt = 0;
        return;
    }
    // 네트워크 워치독을 따로 두지 않는 이유가 여기 있다. 보낼 것이 없으면 채널이 살았는지 알 필요가
    // 없고(그때 찌르면 멀쩡한 연결을 공회전시킬 뿐이다), 보낼 것이 있는데 조용하면 그 자체가 찔러야
    // 할 이유다. 「상태를 감시」하는 대신 「남은 일」이 복구를 끌고 간다.
    if (getMealogFirestoreActivityAgeMs() >= CHANNEL_QUIET_MS) pokeNetworkLoop('outbox-quiet');
    if (Date.now() < nextAttemptAt) return;
    void drainMealOutbox('tick');
}

/** 백오프를 0으로 되돌리고 즉시 한 번 시도 — 포그라운드 복귀·사용자 조작 등 */
export function pokeMealOutboxDrain(reason = '') {
    backoffIndex = 0;
    nextAttemptAt = 0;
    void drainMealOutbox(reason);
}

/** main.js 초기화 시 1회 */
export function registerMealOutboxDrain() {
    if (tickTimer) return;
    try {
        tickTimer = setInterval(tick, TICK_MS);
    } catch (_) {
        return;
    }
    try {
        document.addEventListener(
            'visibilitychange',
            () => {
                if (document.visibilityState !== 'visible') return;
                pokeMealOutboxDrain('foreground');
            },
            { passive: true }
        );
    } catch (_) {
        /* ignore */
    }
}
