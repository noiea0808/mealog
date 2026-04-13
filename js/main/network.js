/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이) + 온라인/포그라운드 복구
 */
import { showNetworkErrorOverlay, hideNetworkErrorOverlay } from '../ui.js';
import { db, auth, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { enableNetwork } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

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
 * Firestore 재연결 + App Check·Auth 토큰 갱신.
 * 불안정한 연결 후 복귀 시 앱 재시작 없이 동작하도록 한다.
 */
export async function runMealogNetworkRecovery() {
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = (async () => {
        try {
            await enableNetwork(db);
        } catch (e) {
            console.warn('[mealog] enableNetwork:', e?.message || e);
        }
        try {
            await refreshAppCheckTokenBeforeFirestore();
        } catch (_) {
            /* ignore */
        }
        try {
            const u = auth.currentUser;
            if (u && typeof u.getIdToken === 'function') {
                await u.getIdToken(true);
            }
        } catch (_) {
            /* ignore */
        }
    })();
    try {
        await recoveryInFlight;
    } finally {
        recoveryInFlight = null;
    }
}

export function scheduleMealogNetworkRecovery(delayMs = 0) {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        void runMealogNetworkRecovery();
    }, delayMs);
}

function registerForegroundRecovery() {
    document.addEventListener(
        'visibilitychange',
        () => {
            if (document.visibilityState !== 'visible') return;
            if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
            scheduleMealogNetworkRecovery(350);
        },
        { passive: true }
    );
    void (async () => {
        try {
            const { App } = await import('@capacitor/app');
            if (App?.addListener) {
                await App.addListener('resume', () => {
                    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
                    scheduleMealogNetworkRecovery(300);
                });
            }
        } catch (_) {
            /* 웹 전용 빌드 등 */
        }
    })();
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    window.addEventListener('offline', () => {
        if (mealogMainAppVisible() && window.currentUser) {
            showNetworkErrorOverlay({
                message:
                    '인터넷 연결이 끊어졌습니다. Wi-Fi 또는 데이터 연결을 확인한 뒤 다시 불러오기를 눌러 주세요.'
            });
        }
    });
    window.addEventListener('online', () => {
        hideNetworkErrorOverlay();
        scheduleMealogNetworkRecovery(200);
    });
    registerForegroundRecovery();
}
