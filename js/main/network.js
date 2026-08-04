/**
 * 네트워크 이벤트 배선 + 복구 후속 작업.
 *
 * 재연결 판단·재시도는 전부 utils/network-loop.js 의 단일 루프가 한다. 이 파일은 두 가지만 한다.
 *  1. OS·플러그인 이벤트를 루프를 깨우는 호출 하나로 연결한다 (무엇이 왔는지 구분하지 않는다).
 *  2. 루프가 복구에 성공했을 때 실행할 후속 작업(기록 동기화 재맞춤·모먼트 재로드)을 등록한다.
 */
import { hideNetworkErrorOverlay } from '../ui.js';
import { notifyTransportOfflineUi, clearOfflineDraftFlagsOnMeals } from '../utils/mealog-offline-ui.js';
import { db } from '../firebase.js';
import { applyMealSyncAbandonOnOffline } from '../utils/meal-entry-pending.js';
import { installFetchFailureAppOfflineBridge } from '../utils/network-reachability.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
import {
    startNetworkLoop,
    pokeNetworkLoop,
    markNetworkChannelDown,
    runNetworkRecoveryNow,
    onNetworkRecovered
} from '../utils/network-loop.js';
import { appState } from '../state.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

/** waitForPendingWrites 등 쓰기 큐 flush 상한 */
const WRITE_QUEUE_FLUSH_TIMEOUT_MS = 8000;

function mealogMainAppVisible() {
    try {
        const main = document.getElementById('mainApp');
        return !!(main && !main.classList.contains('hidden'));
    } catch (_) {
        return false;
    }
}

/** half-open 연결에서 멈춘 Promise가 후속 작업을 마비시키지 않도록 하는 상한 */
function withTimeout(promise, timeoutMs, fallbackValue = undefined) {
    let timer = 0;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise).catch(() => fallbackValue), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
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

/**
 * Firestore 로컬 쓰기 큐가 비면 식사 동기화 UI(초록 도트)·삭제 완료 처리를 `reconcile`로 맞춤.
 */
async function flushMealWriteQueueAndRefreshSyncUi() {
    // meals 실시간 리스너가 강등(1회 조회 폴백) 상태였다면 자동 재부착
    retryDegradedMealsListener();
    await withTimeout(waitForPendingWrites(db), WRITE_QUEUE_FLUSH_TIMEOUT_MS);
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

function retryDegradedMealsListener() {
    void import('../utils/meals-listener-degraded.js').then((dg) => {
        try {
            if (typeof dg.retryMealsListenerIfDegraded === 'function') dg.retryMealsListenerIfDegraded();
        } catch (_) {
            /* ignore */
        }
    });
}

let momentFeedReloadInFlight = false;
let pendingRetryAfterRecoveryInFlight = false;

/**
 * 연결 복구 직후 서버 미등록(실패·abandon·register_scheduled) 식사 기록을 자동 재전송.
 * Firestore 로컬 큐에 없는 항목은 waitForPendingWrites 만으로는 올라가지 않으므로 여기서 함께 밀어준다.
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
 * 재연결 직후, 모먼트 피드가 네트워크 오류 상태로 멈춰 있고 사용자가 모먼트/앨범 탭을 보고 있으면
 * '다시 불러오기'를 누르지 않아도 자동으로 다시 로드한다.
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

/** 루프가 채널 복구에 성공했을 때 1회 실행 */
async function handleNetworkRecovered() {
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
    retryDegradedMealsListener();
    await flushMealWriteQueueAndRefreshSyncUi();
    await retryPendingMealEntriesAfterRecovery();
    maybeReloadMomentFeedAfterRecovery();
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
    onNetworkRecovered(handleNetworkRecovered);

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
