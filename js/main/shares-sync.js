/**
 * 본인 모먼트 공유 목록 캐시 갱신 (canonical: sharedPhotos 컬렉션)
 */
import { refreshMySharesCache, getSharedPhotos } from '../utils/moment-share-state.js';
import { pokeNetworkLoop } from '../utils/network-loop.js';

/**
 * @returns {Promise<object[]>} 갱신된 getSharedPhotos()
 *
 * 실패해도 캐시를 비우지 않는다. 조회 실패는 「공유가 없다」가 아니라 「모른다」인데,
 * 빈 배열로 확정하면 타임라인의 공유 표시가 통째로 사라진다(실측: 시작 직후 서버 조회 실패).
 * 직전 값을 그대로 두고 다음 갱신 기회를 기다린다.
 */
export async function refreshMyMomentShares() {
    try {
        return await refreshMySharesCache();
    } catch (e) {
        console.warn('본인 공유 캐시 갱신 실패(직전 캐시 유지):', e?.message || e);
        pokeNetworkLoop('shares-refresh-failed');
        return getSharedPhotos();
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
