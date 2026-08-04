/**
 * 모먼트 공유 상태 — canonical: artifacts/{appId}/sharedPhotos 컬렉션
 * window.sharedPhotos = loadMyShares() 캐시. meals.sharedPhotos 는 서버가 미러링.
 */

/** entryId가 모먼트(sharedPhotos 컬렉션)에 공유 중인지 */
export function isEntrySharedInMoment(entryId) {
    if (!entryId || !window.sharedPhotos || !Array.isArray(window.sharedPhotos)) return false;
    return window.sharedPhotos.some((p) => p && p.entryId === entryId);
}

/** 컬렉션 캐시에서 해당 entry의 공유 사진 URL 목록 (v2 photos[] 포함) */
export function getSharedPhotoUrlsForEntry(entryId) {
    if (!entryId || !window.sharedPhotos || !Array.isArray(window.sharedPhotos)) return [];
    const urls = [];
    for (const p of window.sharedPhotos) {
        if (!p || p.entryId !== entryId) continue;
        if (p.schemaVersion === 2 && Array.isArray(p.photos) && p.photos.length > 0) {
            for (const ph of p.photos) {
                const u = ph?.url || ph?.photoUrl;
                if (typeof u === 'string' && u.length > 0) urls.push(u);
            }
            continue;
        }
        const u = p.photoUrl || p.url;
        if (typeof u === 'string' && u.length > 0) urls.push(u);
    }
    return urls;
}

/**
 * 공유 취소 공통 흐름: sharedPhotos에서 낙관적 제거 → 서버 반영 → 실패 시 롤백.
 *
 * 이전에는 이 흐름이 best/insight/daily/식단리포트/피드 5곳에 복붙돼 있었고
 * 롤백 범위와 실패 토스트가 제각각이었다. 한 곳에서만 관리한다.
 *
 * 실패 토스트는 dbOps.unsharePhotos가 이미 띄우므로 여기서 중복 표시하지 않는다.
 *
 * @param {object} p
 * @param {string[]} p.photos 해제할 photoUrl 목록
 * @param {(photo: object) => boolean} p.matches sharedPhotos에서 제거할 항목 판별
 * @param {string|null} [p.entryId]
 * @param {'best'|'daily'|'insight'|null} [p.shareType] 실제 문서 type과 일치해야 함
 * @param {object|null} [p.mealSync]
 * @param {(phase: 'applied'|'rolledback') => void} [p.onChange]
 *   낙관적 반영/롤백 직후 UI 갱신. 두 경우 모두 호출되며, 반영 시에만 쓰는
 *   부분 갱신(카드 1개 제거 등)이 있으면 phase로 구분한다.
 * @param {() => void} [p.rollbackExtra] sharedPhotos 외에 되돌릴 상태가 있을 때
 * @returns {Promise<boolean>} 서버 반영 성공 여부
 */
export async function unshareWithOptimisticUpdate({
    photos,
    matches,
    entryId = null,
    shareType = null,
    mealSync = null,
    onChange = null,
    rollbackExtra = null
}) {
    const prevShared = Array.isArray(window.sharedPhotos) ? [...window.sharedPhotos] : null;
    if (prevShared) {
        window.sharedPhotos = prevShared.filter((p) => !matches(p));
    }
    onChange?.('applied');

    try {
        const { dbOps } = await import('../db/ops.js');
        await dbOps.unsharePhotos(photos, { entryId, shareType, mealSync });
        return true;
    } catch (e) {
        console.error('unshareWithOptimisticUpdate 실패:', e);
        if (prevShared) window.sharedPhotos = prevShared;
        rollbackExtra?.();
        onChange?.('rolledback');
        return false;
    }
}

/** loadMyShares로 window.sharedPhotos 갱신 */
export async function refreshMySharesCache() {
    const { loadMyShares } = await import('../db.js');
    const myShares = await loadMyShares();
    window.sharedPhotos = myShares || [];
    return window.sharedPhotos;
}
