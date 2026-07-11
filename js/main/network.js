/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이) + 온라인/포그라운드 복구
 */
import { hideNetworkErrorOverlay } from '../ui.js';
import {
    notifyTransportOfflineUi,
    clearOfflineDraftFlagsOnMeals,
    isMealogTransportOffline
} from '../utils/mealog-offline-ui.js';
import { auth, db, refreshAppCheckTokenBeforeFirestore, kickFirestoreTransportReconnect, rebindFirestoreListenersIfRegistered } from '../firebase.js';
import { applyMealSyncAbandonOnOffline } from '../utils/meal-entry-pending.js';
import { installFetchFailureAppOfflineBridge, clearLocalNetworkForcedOffline } from '../utils/network-reachability.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
import { probeMealogRemoteReachable } from '../utils/network-probe.js';
import {
    markMealogFirestoreActivity,
    markMealogRemoteProbeSuccess,
    isMealogFirestoreActivityStale,
    shouldProbeMealogNetworkConnectivity
} from '../utils/network-activity.js';
import { appState } from '../state.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

function mealogMainAppVisible() {
    try {
        const main = document.getElementById('mainApp');
        return !!(main && !main.classList.contains('hidden'));
    } catch (_) {
        return false;
    }
}

/**
 * 반쯤 끊긴(half-open) 연결에서 영원히 resolve되지 않는 Promise가 복구 체인을 마비시키는 것을 막는 상한.
 * 타임아웃 시 reject하지 않고 조용히 넘어간다(복구는 best-effort).
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {T} [fallbackValue]
 * @returns {Promise<T>}
 * @template T
 */
function withMealogRecoveryTimeout(promise, timeoutMs, fallbackValue = undefined) {
    let timer = 0;
    const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise).catch(() => fallbackValue), timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

let recoveryTimer = null;
let recoveryInFlight = null;

/**
 * App Check·Auth 토큰 갱신. Firestore 전송 재연결은 `runMealogConnectivityRecovery`에서 조건부로 수행.
 */
export async function runMealogNetworkRecovery(options = {}) {
    const forceAuthRefresh = options.forceAuthRefresh === true;
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = (async () => {
        try {
            await refreshAppCheckTokenBeforeFirestore();
        } catch (_) {
            /* ignore */
        }
        let idTokenOk = false;
        try {
            const u = auth.currentUser;
            if (u && typeof u.getIdToken === 'function') {
                await u.getIdToken(forceAuthRefresh);
                idTokenOk = true;
            } else {
                idTokenOk = true;
            }
        } catch (_) {
            /* ignore */
        }
        // 강제 갱신으로 Google에 실제로 닿았다면 로컬 강제 오프라인 해제(위 fetch 성공과 별개로 보강)
        if (forceAuthRefresh && idTokenOk) {
            clearLocalNetworkForcedOffline();
        }
    })();
    try {
        await recoveryInFlight;
    } finally {
        recoveryInFlight = null;
    }
}

export function scheduleMealogNetworkRecovery(delayMs = 0, options = {}) {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        void runMealogNetworkRecovery(options);
    }, delayMs);
}

/**
 * 모먼트「다시 불러오기」·당겨서 새로고침 직전: 원격 핑으로 연결을 확인하고
 * 로컬 강제 오프라인·Auth/App Check 를 갱신한다.
 * @returns {Promise<boolean>} 원격 서버 도달 가능 여부
 */
export async function prepareMomentFeedNetworkForReload() {
    let reachable = false;
    try {
        reachable = await probeMealogRemoteReachable(5000);
    } catch (_) {
        reachable = false;
    }
    if (reachable) {
        markMealogRemoteProbeSuccess();
        clearLocalNetworkForcedOffline();
        try {
            clearOfflineDraftFlagsOnMeals();
        } catch (_) {
            /* ignore */
        }
        try {
            hideNetworkErrorOverlay();
        } catch (_) {
            /* ignore */
        }
    }
    // 토큰 갱신이 half-open에서 멈춰 「당겨서 새로고침」 FAB가 영원히 남는 것을 막기 위해 상한을 둔다.
    await withMealogRecoveryTimeout(
        runMealogNetworkRecovery({ forceAuthRefresh: reachable }),
        WRITE_QUEUE_FLUSH_TIMEOUT_MS
    );
    return reachable;
}

/**
 * Firestore 로컬 쓰기 큐가 비면 식사 동기화 UI(초록 도트)·삭제 완료 처리를 `reconcile`로 맞춤.
 * `online` 이벤트가 안 오는 모바일·웹뷰에서도 `visibilitychange` / resume 경로에서 동일 호출.
 */
async function flushMealWriteQueueAndRefreshSyncUi() {
    // meals 실시간 리스너가 강등(1회 조회 폴백) 상태였다면 온라인 복구 시 자동 재부착
    void import('../utils/meals-listener-degraded.js').then((dg) => {
        try {
            if (typeof dg.retryMealsListenerIfDegraded === 'function') dg.retryMealsListenerIfDegraded();
        } catch (_) {
            /* ignore */
        }
    });
    // half-open 채널에서 waitForPendingWrites가 영원히 대기하면 복구 체인 전체가 멈추므로 상한을 둔다.
    await withMealogRecoveryTimeout(waitForPendingWrites(db), WRITE_QUEUE_FLUSH_TIMEOUT_MS);
    try {
        const m = await import('../utils/meal-entry-pending.js');
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

let momentFeedReloadInFlight = false;
const FIRESTORE_STALE_ACTIVITY_MS = 45000;
/** waitForPendingWrites 등 쓰기 큐 flush 상한 */
const WRITE_QUEUE_FLUSH_TIMEOUT_MS = 8000;
/** 복구 1회 전체 상한 — 내부 await가 무한 대기해도 in-flight 플래그가 반드시 풀리도록 보장 */
const CONNECTIVITY_RECOVERY_TIMEOUT_MS = 20000;
let connectivityRecoveryInFlight = null;
let pendingRetryAfterRecoveryInFlight = false;

/**
 * 연결 복구 직후 서버 미등록(실패·abandon·register_scheduled) 식사 기록을 자동 재전송.
 * entry-and-core 는 무겁고 순환 의존 가능성이 있어 동적 import. 내부에 항목별 in-flight 가드가 있어 중복 안전.
 */
async function retryPendingMealEntriesAfterRecovery() {
    if (pendingRetryAfterRecoveryInFlight) return;
    if (!window.currentUser || window.currentUser.isAnonymous) return;
    pendingRetryAfterRecoveryInFlight = true;
    try {
        const mod = await import('../modals/entry-and-core.js');
        if (typeof mod.retryPendingMealEntriesOnAppReady === 'function') {
            await mod.retryPendingMealEntriesOnAppReady();
        }
    } catch (_) {
        /* ignore */
    } finally {
        pendingRetryAfterRecoveryInFlight = false;
    }
}

/**
 * 원격 프로브 성공 시 토큰 갱신 + (필요 시) Firestore transport kick + 리스너 재부착.
 * @param {{ reason?: string, forceTransportKick?: boolean, skipProbe?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export function runMealogConnectivityRecovery(options = {}) {
    const reason = options.reason || '';
    const forceTransportKick = options.forceTransportKick === true;
    const skipProbe = options.skipProbe === true;
    if (connectivityRecoveryInFlight) return connectivityRecoveryInFlight;

    const work = (async () => {
        let reachable = true;
        if (!skipProbe) {
            try {
                reachable = await probeMealogRemoteReachable(5000);
            } catch (_) {
                reachable = false;
            }
        }
        if (!reachable) return false;

        const wasForcedOffline = isMealogTransportOffline();
        const stale = isMealogFirestoreActivityStale(FIRESTORE_STALE_ACTIVITY_MS);

        markMealogRemoteProbeSuccess();
        clearLocalNetworkForcedOffline();
        try {
            clearOfflineDraftFlagsOnMeals();
        } catch (_) {
            /* ignore */
        }
        try {
            hideNetworkErrorOverlay();
        } catch (_) {
            /* ignore */
        }

        // 토큰 갱신도 half-open에서 멈출 수 있어 상한을 둔다.
        await withMealogRecoveryTimeout(
            runMealogNetworkRecovery({ forceAuthRefresh: true }),
            WRITE_QUEUE_FLUSH_TIMEOUT_MS
        );

        const needTransportKick = forceTransportKick || stale || wasForcedOffline;
        if (needTransportKick) {
            const kicked = await withMealogRecoveryTimeout(
                kickFirestoreTransportReconnect(reason || 'connectivity-recovery', {
                    force: forceTransportKick
                }),
                WRITE_QUEUE_FLUSH_TIMEOUT_MS,
                false
            );
            if (kicked) {
                markMealogFirestoreActivity();
            }
            rebindFirestoreListenersIfRegistered();
        } else {
            void import('../utils/meals-listener-degraded.js').then((dg) => {
                try {
                    if (typeof dg.retryMealsListenerIfDegraded === 'function') dg.retryMealsListenerIfDegraded();
                } catch (_) {
                    /* ignore */
                }
            });
        }

        await flushMealWriteQueueAndRefreshSyncUi();
        // 실제로 나쁜 상태(오프라인/stale/강제 kick)에서 복구된 경우에만 서버 미등록 기록을 자동 재전송.
        // Firestore 로컬 큐에 없는 항목(실패 처리·Callable 폴백·register_scheduled)은 waitForPendingWrites
        // 만으로는 다시 올라가지 않으므로, online/포그라운드/connection-change/heartbeat 복구 시 함께 밀어준다.
        if (needTransportKick) {
            await retryPendingMealEntriesAfterRecovery();
        }
        maybeReloadMomentFeedAfterRecovery();
        return true;
    })();

    // 내부 body가 어떤 이유로든 settle되지 않아도 상한 뒤 플래그를 풀어 다음 트리거가 재시도할 수 있게 한다.
    connectivityRecoveryInFlight = withMealogRecoveryTimeout(
        work,
        CONNECTIVITY_RECOVERY_TIMEOUT_MS,
        false
    ).finally(() => {
        connectivityRecoveryInFlight = null;
    });
    return connectivityRecoveryInFlight;
}

/**
 * 재연결 직후, 모먼트 피드가 네트워크 오류 상태로 멈춰 있고 사용자가 모먼트/앨범 탭을 보고 있으면
 * '다시 불러오기' 버튼을 누르지 않아도 자동으로 다시 로드한다.
 * (online/포그라운드 복구에서는 모먼트가 자동 갱신되지 않아 수동 버튼·앱 재시작을 유발하던 문제 보완)
 */
function maybeReloadMomentFeedAfterRecovery() {
    try {
        if (appState.galleryFeedNetworkError !== true) return;
        const tab = appState.currentTab;
        if (tab !== 'feed' && tab !== 'gallery') return;
        if (typeof window.reloadMomentFeed !== 'function') return;
        if (momentFeedReloadInFlight) return;
        momentFeedReloadInFlight = true;
        void Promise.resolve(window.reloadMomentFeed()).finally(() => {
            momentFeedReloadInFlight = false;
        });
    } catch (_) {
        momentFeedReloadInFlight = false;
    }
}

/** 화면 복귀 시: 원격 연결 확인 후 transport kick·동기화 UI 재맞춤 */
function runForegroundMealSyncAndOverlayRecovery() {
    void runMealogConnectivityRecovery({ reason: 'foreground' });
}

/** 오프라인 진입 시 공통 UI 처리 (window 'offline' 이벤트·Capacitor Network 단절 공용) */
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

function registerForegroundRecovery() {
    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'visible') return;
            runForegroundMealSyncAndOverlayRecovery();
        },
        { passive: true }
    );
    // bare import('@capacitor/app')는 WebView에서 pending 되는 경우가 있어 스크립트로 등록된 window.Capacitor.Plugins.App 사용
    try {
        const App = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.App : null;
        if (App?.addListener) {
            App.addListener('resume', () => {
                runForegroundMealSyncAndOverlayRecovery();
            });
        }
    } catch (_) {
        /* 웹 전용 빌드 등 */
    }
}

/**
 * Capacitor Network 플러그인: Wi-Fi↔LTE 전환·단절을 네이티브에서 신뢰성 있게 통지.
 * WebView의 online/offline 이벤트가 안 오거나 늦는 문제를 보완한다.
 */
function registerCapacitorNetworkRecovery() {
    try {
        const Network = typeof window !== 'undefined' ? window.Capacitor?.Plugins?.Network : null;
        if (!Network?.addListener) return;
        Network.addListener('networkStatusChange', (status) => {
            try {
                if (status && status.connected === false) {
                    // 실패 확인 전이라도 네이티브가 단절을 알려주면 즉시 오프라인 UI로
                    appState.localNetworkForcedOffline = true;
                    applyOfflineUiTransition();
                    return;
                }
                // connected === true 또는 연결타입 변경(wifi↔cellular) — 죽은 채널 재연결 + 미전송 재전송
                void runMealogConnectivityRecovery({
                    reason: 'cap-network',
                    forceTransportKick: true
                });
            } catch (_) {
                /* ignore */
            }
        });
    } catch (_) {
        /* 플러그인 미탑재(웹 등) */
    }
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    installFetchFailureAppOfflineBridge();
    window.addEventListener('offline', () => {
        applyOfflineUiTransition();
    });
    window.addEventListener('online', () => {
        void runMealogConnectivityRecovery({ reason: 'online', forceTransportKick: true });
    });
    registerForegroundRecovery();
    registerConnectionChangeRecovery();
    registerCapacitorNetworkRecovery();
    startMealogReachabilityHeartbeat();
}

/**
 * online 이벤트가 오지 않는 WebView 대비: 로컬 오프라인 또는 Firestore 활동 정체 시
 * 원격 프로브 → transport kick → 리스너·모먼트 자동 복구.
 */
const REACHABILITY_HEARTBEAT_MS = 6000;
let reachabilityHeartbeatTimer = null;
let reachabilityProbeInFlight = false;

function reachabilityHeartbeatTick() {
    if (!shouldProbeMealogNetworkConnectivity(FIRESTORE_STALE_ACTIVITY_MS)) return;
    if (reachabilityProbeInFlight) return;
    reachabilityProbeInFlight = true;
    void runMealogConnectivityRecovery({ reason: 'heartbeat' }).finally(() => {
        reachabilityProbeInFlight = false;
    });
}

function startMealogReachabilityHeartbeat() {
    if (reachabilityHeartbeatTimer) return;
    try {
        reachabilityHeartbeatTimer = setInterval(reachabilityHeartbeatTick, REACHABILITY_HEARTBEAT_MS);
    } catch (_) {
        /* ignore */
    }
}

/** Network Information API: online 이벤트가 안 올 때도 연결 전환 시 복구 */
let lastConnectionRecoverAt = 0;
const CONNECTION_RECOVER_MIN_MS = 4000;

function registerConnectionChangeRecovery() {
    try {
        const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
        if (!conn || typeof conn.addEventListener !== 'function') return;
        conn.addEventListener(
            'change',
            () => {
                try {
                    const now = Date.now();
                    if (now - lastConnectionRecoverAt < CONNECTION_RECOVER_MIN_MS) return;
                    lastConnectionRecoverAt = now;
                    void runMealogConnectivityRecovery({
                        reason: 'connection-change',
                        forceTransportKick: true
                    });
                } catch (_) {
                    /* ignore */
                }
            },
            { passive: true }
        );
    } catch (_) {
        /* ignore */
    }
}
