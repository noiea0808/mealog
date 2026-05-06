import { db, appId } from './firebase.js';
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
 * 제외 계정·익명은 기록하지 않음.
 */
export async function logUsageMetric(key) {
    try {
        const u = typeof window !== 'undefined' ? window.currentUser : null;
        if (!u || u.isAnonymous) return;
        if ((await getExcludedAnalyticsUidSet()).has(u.uid)) return;
        const ref = doc(db, 'artifacts', appId, 'usageDaily', localDateKeyYmd());
        await setDoc(ref, { [key]: increment(1), updatedAt: serverTimestamp() }, { merge: true });
    } catch (e) {
        const code = e?.code || '';
        if (code === 'permission-denied') {
            console.warn('usageDaily 기록 거부(권한):', e?.message || e);
        } else {
            console.debug('usage metric skip:', e?.message || e);
        }
    }
}
