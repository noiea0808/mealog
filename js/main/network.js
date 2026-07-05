/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이) + 온라인/포그라운드 복구
 */
import { hideNetworkErrorOverlay } from '../ui.js';
import {
    notifyTransportOfflineUi,
    clearOfflineDraftFlagsOnMeals,
    isMealogTransportOffline
} from '../utils/mealog-offline-ui.js';
import { auth, db, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { applyMealSyncAbandonOnOffline } from '../utils/meal-entry-pending.js';
import { installFetchFailureAppOfflineBridge, clearLocalNetworkForcedOffline } from '../utils/network-reachability.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
import { probeMealogRemoteReachable } from '../utils/network-probe.js';
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
 * App Check·Auth 토큰 갱신.
 * 주의: 앱에서 disableNetwork를 쓰지 않으므로 enableNetwork는 호출하지 않는다.
 * (매 visibility/복귀마다 enableNetwork → Watch 재구독 → Firestore ca9/b815 assertion 폭주)
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

/** 화면 복귀 시: 브라우저가 온라인으로 보이면 강제 오프라인·오버레이를 풀고 동기화 UI를 재맞춤 */
function runForegroundMealSyncAndOverlayRecovery() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
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
    scheduleMealogNetworkRecovery(400, { forceAuthRefresh: false });
    void (async () => {
        await new Promise((r) => setTimeout(r, 200));
        await flushMealWriteQueueAndRefreshSyncUi();
        maybeReloadMomentFeedAfterRecovery();
    })();
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
        clearLocalNetworkForcedOffline();
        try {
            clearOfflineDraftFlagsOnMeals();
        } catch (_) {
            /* ignore */
        }
        hideNetworkErrorOverlay();
        scheduleMealogNetworkRecovery(250, { forceAuthRefresh: true });
        void (async () => {
            await flushMealWriteQueueAndRefreshSyncUi();
            maybeReloadMomentFeedAfterRecovery();
        })();
    });
    registerForegroundRecovery();
    registerConnectionChangeRecovery();
    startMealogReachabilityHeartbeat();
}

/**
 * online 이벤트가 오지 않는 WebView 대비: 앱이 오프라인으로 판단 중이고 화면이 보일 때만
 * 실제 HTTP 왕복으로 연결을 확인하고, 복구되면 online 이벤트 없이도 강제 오프라인을 풀고
 * 동기화 UI·모먼트 피드를 자동 복구한다. (연결되면 isMealogTransportOffline()가 false가 되어 자동 중단)
 */
const REACHABILITY_HEARTBEAT_MS = 6000;
let reachabilityHeartbeatTimer = null;
let reachabilityProbeInFlight = false;

function reachabilityHeartbeatTick() {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (reachabilityProbeInFlight) return;
    if (!isMealogTransportOffline()) return;
    reachabilityProbeInFlight = true;
    void (async () => {
        let reachable = false;
        try {
            reachable = await probeMealogRemoteReachable(5000);
        } catch (_) {
            reachable = false;
        } finally {
            reachabilityProbeInFlight = false;
        }
        if (!reachable) return;
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
        scheduleMealogNetworkRecovery(0, { forceAuthRefresh: true });
        await flushMealWriteQueueAndRefreshSyncUi();
        maybeReloadMomentFeedAfterRecovery();
    })();
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
                    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
                    const now = Date.now();
                    if (now - lastConnectionRecoverAt < CONNECTION_RECOVER_MIN_MS) return;
                    lastConnectionRecoverAt = now;
                    clearLocalNetworkForcedOffline();
                    scheduleMealogNetworkRecovery(250, { forceAuthRefresh: true });
                    void flushMealWriteQueueAndRefreshSyncUi();
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
