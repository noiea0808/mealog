import { db, appId, appCheckInitPromise, refreshAppCheckTokenBeforeFirestore, callableFunctions } from './firebase.js';
import { doc, setDoc, increment, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
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
    try {
        const cap = typeof window !== 'undefined' ? window.Capacitor : null;
        if (cap?.config?.appId) capAppId = String(cap.config.appId).trim();
    } catch (_) {
        /* ignore */
    }
    const webHost =
        typeof window !== 'undefined' && window.location?.hostname
            ? String(window.location.hostname).toLowerCase()
            : '';
    return { capAppId, webHost };
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
}

async function logUsageMetricCallable(key) {
    await prepareUsageMetricWrite();
    const source = getUsageMetricSourcePayload();
    await callableFunctions.logUsageMetric({ key, ...source });
}

/**
 * 관리자 대시보드「페이지별」집계용. 하루 1문서(usageDaily/{YYYY-MM-DD})에 필드별 increment.
 * 운영 앱(com.mealog.app)·운영 웹(www.mealog.net / mealog.net)만 기록. 제외 UID·익명·스테이징·로컬은 제외.
 * Firestore 직접 쓰기 실패 시 logUsageMetric Callable(Admin SDK)로 폴백.
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

        let directErr = null;
        try {
            await prepareUsageMetricWrite();
            await logUsageMetricDirect(key);
            return;
        } catch (e) {
            directErr = e;
            if (e?.code === 'permission-denied') {
                try {
                    await refreshAppCheckTokenBeforeFirestore({ force: true });
                    await logUsageMetricDirect(key);
                    return;
                } catch (retryErr) {
                    directErr = retryErr;
                }
            }
        }

        try {
            await logUsageMetricCallable(key);
        } catch (callableErr) {
            const code = callableErr?.code || directErr?.code || '';
            if (code === 'permission-denied' || code === 'unauthenticated') {
                console.warn('usageDaily 기록 거부(권한):', callableErr?.message || directErr?.message || callableErr);
            } else {
                console.warn('usageDaily 기록 실패:', callableErr?.message || directErr?.message || callableErr);
            }
        }
    } catch (e) {
        console.debug('usage metric skip:', e?.message || e);
    }
}
