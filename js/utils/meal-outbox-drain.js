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
import {
    countMealPendingSyncAndDeleteQueue,
    countMealCloudFabManualRetryEntries,
    isMealEntryServerSynced
} from './meal-entry-pending.js';
import { countOfflineDraftMeals } from './mealog-offline-ui.js';
import { refreshMealSyncResendNavButton } from '../main/meal-sync-resend-header.js';

/** 남은 일이 있을 때의 재시도 간격 — 마지막 값에서 고정 */
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
/** 드레인 조건을 점검하는 주기 */
const TICK_MS = 5000;
/** waitForPendingWrites 등 쓰기 큐 flush 상한 */
const WRITE_QUEUE_FLUSH_TIMEOUT_MS = 8000;

let tickTimer = 0;
let backoffIndex = 0;
let nextAttemptAt = 0;
let drainInFlight = false;

/** half-open 연결에서 멈춘 Promise 가 드레인을 마비시키지 않도록 하는 상한 */
function withTimeout(promise, timeoutMs, fallbackValue = undefined) {
    let timer = 0;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise).catch(() => fallbackValue), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/** 서버로 올라가지 않은 것이 남아 있는지 — 로컬 판정, 서버 읽기 없음 */
export function hasOutstandingMealWork() {
    try {
        return (
            countMealPendingSyncAndDeleteQueue() > 0 ||
            countMealCloudFabManualRetryEntries() > 0 ||
            countOfflineDraftMeals() > 0
        );
    } catch (_) {
        return false;
    }
}

/**
 * 서버 반영이 확인된 기록의 「오프라인 저장」 표시를 지운다 (재전송 FAB 배지 해제).
 *
 * 예전에는 복구 시점에 전부 일괄 해제했는데, 그 시점을 놓치면 배지가 영구히 남았다.
 * 기록별로 서버 반영 여부를 보고 지우므로 아무 때나 불러도 안전하다.
 */
function clearSettledOfflineDraftFlags() {
    const hist = window.mealHistory;
    if (!Array.isArray(hist)) return;
    for (let i = 0; i < hist.length; i++) {
        const m = hist[i];
        if (!m || m._mealogOfflineDraft !== true) continue;
        if (!isMealEntryServerSynced(m)) continue;
        const next = { ...m };
        delete next._mealogOfflineDraft;
        hist[i] = next;
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
    await withTimeout(waitForPendingWrites(db), WRITE_QUEUE_FLUSH_TIMEOUT_MS);
    try {
        const m = await import('./meal-entry-pending.js');
        if (typeof m.reconcileMealSyncUiAfterWriteQueueFlush === 'function') {
            await m.reconcileMealSyncUiAfterWriteQueueFlush();
        }
        if (typeof m.reconcilePendingMealDeletesWithServer === 'function') {
            await m.reconcilePendingMealDeletesWithServer();
        }
        if (typeof m.reconcileStaleMealSyncDotsAgainstServer === 'function') {
            await m.reconcileStaleMealSyncDotsAgainstServer();
        }
        if (typeof m.clearStuckMealPendingFlags === 'function') {
            m.clearStuckMealPendingFlags();
        }
    } catch (_) {
        /* ignore */
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
            await mod.retryPendingMealEntriesOnAppReady();
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
    if (drainInFlight) return;
    if (!hasOutstandingMealWork()) return;
    drainInFlight = true;
    try {
        retryDegradedMealsListener();
        await reconcileSyncUiAgainstServer();
        await retryPendingMealEntries();
        clearSettledOfflineDraftFlags();
    } catch (e) {
        console.warn('[meal-outbox] 드레인 실패:', reason, e?.message || e);
    } finally {
        drainInFlight = false;
    }
    if (hasOutstandingMealWork()) {
        const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
        backoffIndex += 1;
        nextAttemptAt = Date.now() + delay;
    } else {
        backoffIndex = 0;
        nextAttemptAt = 0;
    }
}

function tick() {
    if (!hasOutstandingMealWork()) {
        backoffIndex = 0;
        nextAttemptAt = 0;
        return;
    }
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
