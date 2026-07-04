import { db, appId, appCheckInitPromise, refreshAppCheckTokenBeforeFirestore, callableFunctions } from './firebase.js';
import {
    doc,
    setDoc,
    increment,
    serverTimestamp,
    waitForPendingWrites
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getExcludedAnalyticsUidSet } from './excluded-analytics-uids.js';

function localDateKeyYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getUsageMetricSourcePayload() {
    let capAppId = '';
    let isNative = false;
    try {
        const cap = typeof window !== 'undefined' ? window.Capacitor : null;
        // Capacitor 는 window.Capacitor.config 를 주입하지 않아 보통 비어 있음(폴백용으로만 유지)
        if (cap?.config?.appId) capAppId = String(cap.config.appId).trim();
        if (cap && typeof cap.isNativePlatform === 'function') isNative = cap.isNativePlatform();
    } catch (_) {
        /* ignore */
    }
    const webHost =
        typeof window !== 'undefined' && window.location?.hostname
            ? String(window.location.hostname).toLowerCase()
            : '';
    // 네이티브 번들 앱은 config.appId·호스트로 운영 판별이 불가하므로 빌드 확정 APP_ENV 를 함께 전송
    const appEnv =
        typeof window !== 'undefined' ? String(window.APP_ENV || '').toLowerCase() : '';
    return { capAppId, webHost, appEnv, isNative };
}

async function prepareUsageMetricWrite() {
    await appCheckInitPromise;
    const u = window.currentUser;
    if (u && typeof u.getIdToken === 'function') {
        await u.getIdToken(false);
    }
    await refreshAppCheckTokenBeforeFirestore();
}

async function logUsageMetricDirect(key) {
    const ref = doc(db, 'artifacts', appId, 'usageDaily', localDateKeyYmd());
    const payload = { [key]: increment(1), updatedAt: serverTimestamp() };
    await setDoc(ref, payload, { merge: true });
    await waitForPendingWrites(db);
}

async function logUsageMetricCallable(key) {
    await prepareUsageMetricWrite();
    const source = getUsageMetricSourcePayload();
    await callableFunctions.logUsageMetric({ key, ...source });
}

/**
 * 관리자 대시보드「페이지별」집계용. 하루 1문서(usageDaily/{YYYY-MM-DD})에 필드별 increment.
 * 운영 앱(com.mealog.app)·운영 웹(www.mealog.net / mealog.net)만 기록. 제외 UID·익명·스테이징·로컬은 제외.
 * 서버 반영은 Callable(Admin SDK) 우선 — Firestore 직접 쓰기는 로컬 캐시만 성공하는 경우가 있어 폴백으로만 사용.
 */
export async function logUsageMetric(key) {
    try {
        if (
            typeof window === 'undefined' ||
            typeof window.isProductionUsageEnvironment !== 'function' ||
            !window.isProductionUsageEnvironment()
        ) {
            return;
        }
        const u = window.currentUser;
        if (!u || u.isAnonymous) return;
        if ((await getExcludedAnalyticsUidSet()).has(u.uid)) return;

        try {
            await logUsageMetricCallable(key);
            return;
        } catch (callableErr) {
            try {
                await prepareUsageMetricWrite();
                await logUsageMetricDirect(key);
                return;
            } catch (directErr) {
                const code = callableErr?.code || directErr?.code || '';
                if (code === 'permission-denied' || code === 'unauthenticated') {
                    console.warn(
                        'usageDaily 기록 거부(권한):',
                        callableErr?.message || directErr?.message || callableErr
                    );
                } else {
                    console.warn(
                        'usageDaily 기록 실패:',
                        callableErr?.message || directErr?.message || callableErr
                    );
                }
            }
        }
    } catch (e) {
        console.debug('usage metric skip:', e?.message || e);
    }
}
