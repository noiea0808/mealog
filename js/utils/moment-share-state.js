/**
 * 모먼트 공유 상태 — canonical: artifacts/{appId}/sharedPhotos 컬렉션
 * window.sharedPhotos = loadMyShares() 캐시. meals.sharedPhotos 는 서버가 미러링.
 */

/** entryId가 모먼트(sharedPhotos 컬렉션)에 공유 중인지 */
export function isEntrySharedInMoment(entryId) {
    if (!entryId || !window.sharedPhotos || !Array.isArray(window.sharedPhotos)) return false;
    return window.sharedPhotos.some((p) => p && p.entryId === entryId);
}

/** 컬렉션 캐시에서 해당 entry의 공유 사진 URL 목록 */
export function getSharedPhotoUrlsForEntry(entryId) {
    if (!entryId || !window.sharedPhotos || !Array.isArray(window.sharedPhotos)) return [];
    return window.sharedPhotos
        .filter((p) => p && p.entryId === entryId)
        .map((p) => p.photoUrl || p.url)
        .filter((u) => typeof u === 'string' && u.length > 0);
}

/** loadMyShares로 window.sharedPhotos 갱신 */
export async function refreshMySharesCache() {
    const { loadMyShares } = await import('../db.js');
    const myShares = await loadMyShares();
    window.sharedPhotos = myShares || [];
    return window.sharedPhotos;
}
