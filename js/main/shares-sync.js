/**
 * 본인 모먼트 공유 목록 캐시 갱신 (canonical: sharedPhotos 컬렉션)
 */
import { refreshMySharesCache } from '../utils/moment-share-state.js';

/**
 * @returns {Promise<object[]>} 갱신된 window.sharedPhotos
 */
export async function refreshMyMomentShares() {
    try {
        return await refreshMySharesCache();
    } catch (e) {
        console.warn('본인 공유 캐시 갱신 실패:', e);
        window.sharedPhotos = [];
        return [];
    }
}

/**
 * @deprecated syncOrphanedSharesToMoment 대체 — 고아 보정 없이 캐시만 갱신
 * @returns {Promise<number>} 항상 0 (하위 호환)
 */
export async function syncOrphanedSharesToMoment() {
    await refreshMyMomentShares();
    return 0;
}
