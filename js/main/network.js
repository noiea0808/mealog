/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이) + 온라인/포그라운드 복구
 */
import { showNetworkErrorOverlay, hideNetworkErrorOverlay } from '../ui.js';
import { auth, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';

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
        try {
            const u = auth.currentUser;
            if (u && typeof u.getIdToken === 'function') {
                await u.getIdToken(forceAuthRefresh);
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
        scheduleMealogNetworkRecovery(250, { forceAuthRefresh: true });
    });
    registerForegroundRecovery();
}
