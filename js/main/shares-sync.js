/**
 * meal 문서에는 sharedPhotos가 있는데 sharedPhotos 컬렉션에 없으면 동기화 (모먼트 피드 반영)
 * 14일: 진입 속도 개선. 과거 고아는 당겨서 새로고침 시 동기화
 */
import { dbOps, loadMealsForDateRange, loadMyShares } from '../db.js';
import { showToast } from '../ui.js';

/**
 * @param {unknown[] | null} [mySharesFromCaller] 이미 로드된 본인 공유 목록이 있으면 전달 (중복 로드 생략)
 * @returns {Promise<number>} 새로 동기화된 건수
 */
export async function syncOrphanedSharesToMoment(mySharesFromCaller = null) {
    if (!window.currentUser || window.currentUser.isAnonymous) return 0;
    const today = new Date();
    const fourteenDaysAgo = new Date(today);
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const endStr = today.toISOString().split('T')[0];
    const startStr = fourteenDaysAgo.toISOString().split('T')[0];
    try {
        await loadMealsForDateRange(startStr, endStr); // 14일 범위
    } catch (e) {
        console.warn('동기화 전 meal 로드 실패 (계속 진행):', e);
    }
    const myShares = mySharesFromCaller ?? await loadMyShares();
    if (!mySharesFromCaller) window.sharedPhotos = myShares;
    const mealsToSync = (window.mealHistory || []).filter(m =>
        m.id && m.sharedPhotos && Array.isArray(m.sharedPhotos) && m.sharedPhotos.length > 0 &&
        !m.shareBanned && !myShares.some(p => p.entryId === m.id)
    );
    const validUrls = (url) => typeof url === 'string' && url && !url.startsWith('data:image');
    let synced = 0;
    // 한 번에 최대 30건 동기화 (기존 5건 제한으로 많은 고아 게시물이 누락되던 문제 해결)
    for (const m of mealsToSync.slice(0, 30)) {
        const urls = m.sharedPhotos.filter(validUrls);
        if (urls.length === 0) continue;
        try {
            await dbOps.sharePhotos(urls, m);
            if (!window.sharedPhotos) window.sharedPhotos = [];
            const newEntries = urls.map(url => ({ entryId: m.id, photoUrl: url, userId: window.currentUser?.uid }));
            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== m.id).concat(newEntries);
            synced++;
        } catch (e) {
            console.warn('모먼트 동기화 실패:', m.id, e);
            const msg = e?.message || e?.details || '';
            if (synced === 0) showToast(msg ? `모먼트 동기화 실패: ${msg}` : '모먼트 동기화에 실패했습니다.', 'error');
        }
    }
    return synced;
}
