/**
 * 네트워크 복구 단일 루프.
 *
 * 설계 원칙:
 *  1. 진실은 하나 — 「Firestore가 실제로 서버 응답을 전달했는가」(markMealogFirestoreActivity).
 *     navigator.onLine 은 이 파일을 포함해 어디서도 읽지 않는다. Android WebView에서 재연결 후에도
 *     false 로 고착돼, 값을 게이트로 쓰면 복구가 통째로 막힌다.
 *  2. OS·플러그인 이벤트(online / connection change / resume / Capacitor Network)는 아무것도 판단하지
 *     않는다. 백오프를 0으로 되돌리고 루프를 깨우는 힌트일 뿐이다. 시도를 막는 조건으로는 쓰지 않는다.
 *  3. 복구는 사다리다. kick → 토큰 갱신+리스너 재부착 → 인스턴스 재생성. 연속 실패마다 한 칸 오르고,
 *     성공하면 사다리와 백오프가 함께 리셋된다.
 *
 * 복구 성공 판정에 별도 읽기 비용은 들지 않는다. meals 리스너가 includeMetadataChanges 로 붙어 있어
 * 채널이 살아나면 fromCache=false 스냅샷이 발화하고, 그 시점이 곧 활동 시각으로 기록되기 때문이다.
 * 리스너가 없는 상태(로그아웃·게스트)에서만 원격 프로브로 대신 판정한다.
 */
import { appState } from '../state.js';
import {
    getMealogFirestoreActivityAgeMs,
    getMealogFirestoreLastActivityAt,
    isMealogFirestoreActivityStale
} from './network-activity.js';
import {
    auth,
    hasFirestoreListenersRegistered,
    kickFirestoreTransportReconnect,
    rebindFirestoreListenersIfRegistered,
    recoverFirestoreAfterWatchAssertion,
    refreshAppCheckTokenBeforeFirestore
} from '../firebase.js';
import { probeMealogRemoteReachable } from './network-probe.js';

/** 재시도 간격 — 마지막 값에서 고정된다. 각 값에 ±25% 지터를 준다. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000, 60000];
/** 이 시간 안에 서버 응답이 있었다면 채널이 살아 있는 것으로 보고 시도를 건너뛴다. */
const ACTIVITY_FRESH_MS = 20000;
/** 유휴 중 이만큼 서버 응답이 없으면 채널을 의심한다. */
const ACTIVITY_STALE_MS = 90000;
/** 복구 시도 후 서버 응답이 돌아오기를 기다리는 시간. */
const ACTIVITY_RESUME_WAIT_MS = 3000;
/** 사다리 각 단계의 상한 — 초과하면 그 단계는 실패로 보고 다음 칸으로 올라간다. */
const LADDER_STEP_TIMEOUT_MS = 8000;
/** 루프가 멈춰 있을 때 채널을 점검하는 주기. */
const WATCHDOG_MS = 30000;
const LADDER_TOP = 2;
/**
 * 끊긴 것을 화면에 표시하기까지의 유예. 사다리 0단(kick)은 대개 1초 안에, 자연 회복은
 * ACTIVITY_RESUME_WAIT_MS(3초) 안에 끝난다 — 그 안에 풀리는 끊김까지 사용자에게 보이면
 * 금방 없어질 걱정을 만들 뿐이다. 복구 시도 자체는 지금처럼 즉시 시작한다. 이건 표시만 늦춘다.
 * 복구(healthy 전환)는 지연 없이 바로 반영한다 — 비대칭.
 */
const UI_OFFLINE_GRACE_MS = 3000;

let attemptTimer = 0;
let attemptInFlight = false;
let watchdogTimer = 0;
let ladderStep = 0;
let backoffIndex = 0;
let downSince = 0;
let uiGraceTimer = 0;

function jitter(ms) {
    return Math.round(ms * (0.75 + Math.random() * 0.5));
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * half-open 연결에서 영원히 resolve되지 않는 Promise가 루프를 마비시키는 것을 막는 상한.
 * 복구는 best-effort이므로 타임아웃 시 reject하지 않고 조용히 넘어간다.
 */
function withTimeout(promise, timeoutMs, fallbackValue = undefined) {
    let timer = 0;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise).catch(() => fallbackValue), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function documentVisible() {
    try {
        return typeof document === 'undefined' || document.visibilityState === 'visible';
    } catch (_) {
        return true;
    }
}

/** 채널이 죽은 것으로 확인된 상태인지 — 즉시값. 정합성이 걸린 판정(예: 스냅샷 removed 보류)에 쓴다. */
export function isNetworkChannelDown() {
    return appState.localNetworkForcedOffline === true;
}

/**
 * 화면에 표시할 때 쓰는 값 — 끊긴 지 UI_OFFLINE_GRACE_MS 가 지나야 true 가 된다.
 * FAB·토스트 등 사용자에게 보이는 판정은 전부 이걸 쓴다.
 */
export function isNetworkChannelDownForDisplay() {
    if (appState.localNetworkForcedOffline !== true) return false;
    return downSince > 0 && Date.now() - downSince >= UI_OFFLINE_GRACE_MS;
}

/** 채널이 down 으로 확인된 지점 공통 처리 — 최초 진입 시에만 유예 타이머를 세운다 */
function noteChannelDown() {
    appState.localNetworkForcedOffline = true;
    if (downSince) return; // 이미 down — 타이머 중복 예약 방지
    downSince = Date.now();
    uiGraceTimer = setTimeout(() => {
        uiGraceTimer = 0;
        // 유예가 지났는데도 여전히 끊겨 있으면 그때 FAB를 갱신한다. 그 사이 회복됐다면
        // isNetworkChannelDownForDisplay 가 이미 false 를 주므로 별도 처리가 필요 없다.
        if (appState.localNetworkForcedOffline === true) {
            void import('../main/meal-sync-resend-header.js').then((m) => {
                try {
                    if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
                } catch (_) {
                    /* ignore */
                }
            });
        }
    }, UI_OFFLINE_GRACE_MS);
}

function clearAttemptTimer() {
    if (attemptTimer) {
        clearTimeout(attemptTimer);
        attemptTimer = 0;
    }
}

function scheduleAttempt(delayMs, reason) {
    clearAttemptTimer();
    attemptTimer = setTimeout(() => {
        attemptTimer = 0;
        void runRecoveryAttempt(reason);
    }, delayMs);
}

/**
 * 채널이 살아났을 때 — 사다리·백오프를 리셋하고 오프라인 표시를 내린다.
 *
 * 복구 후속 작업(기록 재전송·모먼트 재로드)은 여기서 하지 않는다. 예전에는 down → healthy
 * '전환'일 때만 훅을 돌렸는데, 조용히 half-open 된 경우에는 오프라인으로 표시된 적이 없어
 * 전환이 성립하지 않았다. 그래서 복구가 1회 시도로 성공할수록 후속 작업이 누락되는
 * 역설이 있었다. 두 작업은 각자 남은 일을 보고 스스로 재시도한다.
 */
function markHealthy() {
    ladderStep = 0;
    backoffIndex = 0;
    appState.localNetworkForcedOffline = false;
    downSince = 0;
    if (uiGraceTimer) {
        clearTimeout(uiGraceTimer);
        uiGraceTimer = 0;
    }
    clearAttemptTimer();
}

function markAttemptFailed(reason) {
    noteChannelDown();
    ladderStep = Math.min(ladderStep + 1, LADDER_TOP);
    const delay = jitter(BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)]);
    backoffIndex += 1;
    scheduleAttempt(delay, reason);
}

/** 서버 응답이 돌아왔는지 기다린다 — 돌아왔으면 true */
async function waitForActivityAfter(activityBefore, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (getMealogFirestoreLastActivityAt() > activityBefore) return true;
        await sleepMs(200);
    }
    return getMealogFirestoreLastActivityAt() > activityBefore;
}

async function refreshAuthTokens() {
    try {
        await refreshAppCheckTokenBeforeFirestore({ force: true });
    } catch (_) {
        /* ignore */
    }
    try {
        const u = auth.currentUser;
        if (u && typeof u.getIdToken === 'function') await u.getIdToken(true);
    } catch (_) {
        /* ignore */
    }
}

/**
 * 사다리 한 칸 실행.
 * 0: transport kick — 전환 직후 죽은 WebChannel은 대개 이것만으로 살아난다.
 * 1: 토큰 갱신 + kick + 리스너 재부착 — 만료된 토큰·고착된 리스너를 함께 턴다.
 * 2: 인스턴스 재생성 — Watch 내부 오류로 SDK가 깨진 경우.
 */
async function climbLadder(reason) {
    if (ladderStep >= LADDER_TOP) {
        await withTimeout(
            recoverFirestoreAfterWatchAssertion(reason, { force: true }),
            LADDER_STEP_TIMEOUT_MS,
            false
        );
        return;
    }
    if (ladderStep >= 1) {
        await withTimeout(refreshAuthTokens(), LADDER_STEP_TIMEOUT_MS);
    }
    await withTimeout(
        kickFirestoreTransportReconnect(reason || 'network-loop', { force: true }),
        LADDER_STEP_TIMEOUT_MS,
        false
    );
    if (ladderStep >= 1) rebindFirestoreListenersIfRegistered();
}

/**
 * 복구 1회 시도. 이미 채널이 살아 있으면 아무것도 하지 않는다.
 * @param {string} [reason]
 * @param {{ forceRebind?: boolean }} [options] forceRebind: 채널이 멀쩡해도 리스너를 새로 붙인다
 *   (사용자가 당겨서 새로고침한 경우 — 최신 데이터를 기대하므로)
 * @returns {Promise<boolean>} 시도 후 채널이 살아 있으면 true
 */
async function runRecoveryAttempt(reason = '', options = {}) {
    if (attemptInFlight) return !isNetworkChannelDown();
    attemptInFlight = true;
    try {
        // 최근에 서버 응답이 있었다면 채널은 살아 있다 — 비용 0의 빠른 경로
        if (getMealogFirestoreActivityAgeMs() < ACTIVITY_FRESH_MS) {
            if (options.forceRebind === true) rebindFirestoreListenersIfRegistered();
            markHealthy();
            return true;
        }

        const activityBefore = getMealogFirestoreLastActivityAt();
        await climbLadder(reason);
        if (options.forceRebind === true && ladderStep < 1) rebindFirestoreListenersIfRegistered();

        if (await waitForActivityAfter(activityBefore, ACTIVITY_RESUME_WAIT_MS)) {
            markHealthy();
            return true;
        }

        // 관찰할 리스너가 없으면(로그아웃·게스트) 응답을 기다릴 수 없으므로 원격 프로브로 대신 판정한다.
        if (!hasFirestoreListenersRegistered()) {
            if (await probeMealogRemoteReachable(4000)) {
                markHealthy();
                return true;
            }
        }

        markAttemptFailed(reason);
        return false;
    } catch (e) {
        console.warn('[network-loop] 복구 시도 실패:', e?.message || e);
        markAttemptFailed(reason);
        return false;
    } finally {
        attemptInFlight = false;
    }
}

/**
 * 루프를 깨운다 — 백오프를 0으로 되돌리고 즉시 한 번 시도한다.
 * OS·플러그인 이벤트는 전부 이 함수 하나로 들어온다. 무엇이 왔는지 구분하지 않는다.
 */
export function pokeNetworkLoop(reason = '') {
    backoffIndex = 0;
    if (attemptInFlight) return;
    scheduleAttempt(0, reason);
}

/**
 * 전송 실패가 확인됐을 때 — 즉시 오프라인으로 표시하고 루프를 깨운다.
 * 사다리는 유지한다(연속 실패 중이면 계속 위 칸부터).
 */
export function markNetworkChannelDown(reason = '') {
    noteChannelDown();
    pokeNetworkLoop(reason);
}

/**
 * 즉시 복구를 시도하고 결과를 기다린다 — 당겨서 새로고침 등 사용자가 기다리는 경로용.
 * @param {string} [reason]
 * @param {{ forceRebind?: boolean }} [options]
 * @returns {Promise<boolean>} 채널이 살아 있으면 true
 */
export async function runNetworkRecoveryNow(reason = '', options = {}) {
    backoffIndex = 0;
    clearAttemptTimer();
    return runRecoveryAttempt(reason, options);
}

function watchdogTick() {
    if (!documentVisible()) return;
    if (attemptInFlight || attemptTimer) return; // 루프가 이미 돌고 있으면 관여하지 않는다
    if (isNetworkChannelDown() || isMealogFirestoreActivityStale(ACTIVITY_STALE_MS)) {
        pokeNetworkLoop('watchdog');
    }
}

/** main.js 초기화 시 1회 — 루프가 멈춰 있을 때만 동작하는 감시 타이머를 건다. */
export function startNetworkLoop() {
    if (watchdogTimer) return;
    try {
        watchdogTimer = setInterval(watchdogTick, WATCHDOG_MS);
    } catch (_) {
        /* ignore */
    }
}
