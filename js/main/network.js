/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이) + 온라인/포그라운드 복구
 */
import { showNetworkErrorOverlay, hideNetworkErrorOverlay } from '../ui.js';
import { auth, db, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { applyMealSyncAbandonOnOffline } from '../utils/meal-entry-pending.js';
import { installFetchFailureAppOfflineBridge, clearLocalNetworkForcedOffline } from '../utils/network-reachability.js';
import { refreshMealSyncResendNavButton } from './meal-sync-resend-header.js';
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

function registerForegroundRecovery() {
    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'visible') return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            scheduleMealogNetworkRecovery(500, { forceAuthRefresh: false });
        },
        { passive: true }
    );
    void (async () => {
        try {
            const { App } = await import('@capacitor/app');
            if (App?.addListener) {
                await App.addListener('resume', () => {
                    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
                    scheduleMealogNetworkRecovery(400, { forceAuthRefresh: false });
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
            showNetworkErrorOverlay({
                message:
                    '인터넷 연결이 끊어졌습니다. Wi-Fi 또는 데이터 연결을 확인한 뒤 다시 불러오기를 눌러 주세요.'
            });
        }
    });
    window.addEventListener('online', () => {
        clearLocalNetworkForcedOffline();
        hideNetworkErrorOverlay();
        scheduleMealogNetworkRecovery(250, { forceAuthRefresh: true });
        void (async () => {
            try {
                await waitForPendingWrites(db);
            } catch (_) {
                /* ignore */
            }
            try {
                const m = await import('../utils/meal-entry-pending.js');
                if (typeof m.reconcileMealSyncUiAfterWriteQueueFlush === 'function') {
                    m.reconcileMealSyncUiAfterWriteQueueFlush();
                }
                if (typeof m.clearStuckMealPendingFlags === 'function' && m.clearStuckMealPendingFlags()) {
                    /* clearStuck만으로도 bump됨 — 아래에서 도트 재패치 */
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
        })();
        try {
            refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
    });
    registerForegroundRecovery();
    registerConnectionChangeRecovery();
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
