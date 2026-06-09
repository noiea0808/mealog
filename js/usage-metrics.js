import { db, appId, appCheckInitPromise, refreshAppCheckTokenBeforeFirestore } from './firebase.js';
import { doc, setDoc, increment, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { getExcludedAnalyticsUidSet } from './excluded-analytics-uids.js';

function localDateKeyYmd() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * 관리자 대시보드「페이지별」집계용. 하루 1문서(usageDaily/{YYYY-MM-DD})에 필드별 increment.
 * 운영 앱(com.mealog.app)·운영 웹(www.mealog.net / mealog.net)만 기록. 제외 UID·익명·스테이징·로컬은 제외.
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

        await appCheckInitPromise;
        if (typeof u.getIdToken === 'function') {
            await u.getIdToken(false);
        }
        await refreshAppCheckTokenBeforeFirestore();

        const ref = doc(db, 'artifacts', appId, 'usageDaily', localDateKeyYmd());
        const payload = { [key]: increment(1), updatedAt: serverTimestamp() };

        const writeOnce = () => setDoc(ref, payload, { merge: true });
        try {
            await writeOnce();
        } catch (e) {
            if (e?.code === 'permission-denied') {
                await refreshAppCheckTokenBeforeFirestore({ force: true });
                await writeOnce();
            } else {
                throw e;
            }
        }
    } catch (e) {
        const code = e?.code || '';
        if (code === 'permission-denied') {
            console.warn('usageDaily 기록 거부(권한):', e?.message || e);
        } else {
            console.debug('usage metric skip:', e?.message || e);
        }
    }
}
