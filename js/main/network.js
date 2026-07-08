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
    try {
        await runMealogNetworkRecovery({ forceAuthRefresh: reachable });
    } catch (_) {
        /* ignore */
    }
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
    try {
        await waitForPendingWrites(db);
    } catch (_) {
        /* ignore */
    }
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
let connectivityRecoveryInFlight = null;

/**
 * 원격 프로브 성공 시 토큰 갱신 + (필요 시) Firestore transport kick + 리스너 재부착.
 * @param {{ reason?: string, forceTransportKick?: boolean, skipProbe?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function runMealogConnectivityRecovery(options = {}) {
    const reason = options.reason || '';
    const forceTransportKick = options.forceTransportKick === true;
    const skipProbe = options.skipProbe === true;
    if (connectivityRecoveryInFlight) return connectivityRecoveryInFlight;
    connectivityRecoveryInFlight = (async () => {
        try {
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

            await runMealogNetworkRecovery({ forceAuthRefresh: true });

            const needTransportKick = forceTransportKick || stale || wasForcedOffline;
            if (needTransportKick) {
                const kicked = await kickFirestoreTransportReconnect(reason || 'connectivity-recovery', {
                    force: forceTransportKick
                });
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
            maybeReloadMomentFeedAfterRecovery();
            return true;
        } finally {
            connectivityRecoveryInFlight = null;
        }
    })();
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

function registerForegroundRecovery() {
    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'visible') return;
            runForegroundMealSyncAndOverlayRecovery();
        },
        { passive: true }
    );
    void (async () => {
        try {
            const { App } = await import('@capacitor/app');
            if (App?.addListener) {
                await App.addListener('resume', () => {
                    runForegroundMealSyncAndOverlayRecovery();
                });
            }
        } catch (_) {
            /* 웹 전용 빌드 등 */
        }
    })();
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    installFetchFailureAppOfflineBridge();
    window.addEventListener('offline', () => {
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
    });
    window.addEventListener('online', () => {
        void runMealogConnectivityRecovery({ reason: 'online', forceTransportKick: true });
    });
    registerForegroundRecovery();
    registerConnectionChangeRecovery();
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
