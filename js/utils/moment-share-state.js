/**
 * 모먼트 공유 상태 — canonical: artifacts/{appId}/sharedPhotos 컬렉션
 * loadMyShares() 캐시를 여기서만 소유한다. meals.sharedPhotos 는 서버가 미러링.
 *
 * 저장소는 appState._data.sharedPhotos 이며 접근은 아래 접근자로만 한다.
 * (이전에는 window.sharedPhotos 전역을 17개 파일이 직접 대입했다.)
 */
import { appState } from '../state.js';

/**
 * 공유 캐시. 항상 배열이다.
 *
 * 이전에는 null(미로드) / undefined / [] 세 상태를 오갔지만, 읽는 쪽이
 * 모두 "없으면 못 찾은 것"으로 동일하게 처리하고 있어 배열로 통일했다.
 */
export function getSharedPhotos() {
    return appState._data.sharedPhotos;
}

/** 배열이 아닌 값은 빈 배열로 정규화한다. @returns 저장된 배열 */
export function setSharedPhotos(next) {
    appState._data.sharedPhotos = Array.isArray(next) ? next : [];
    return appState._data.sharedPhotos;
}

/**
 * 낙관적 추가: 같은 대상의 기존 항목을 걷어내고 새 항목을 넣은 뒤 최신순 정렬.
 * @param {object} item 새로 추가할 공유 문서
 * @param {(photo: object) => boolean} isSameTarget 중복으로 볼 기존 항목 판별
 */
export function upsertSharedPhoto(item, isSameTarget) {
    const next = getSharedPhotos().filter((p) => !isSameTarget(p));
    next.push(item);
    next.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return setSharedPhotos(next);
}

/** entryId가 모먼트(sharedPhotos 컬렉션)에 공유 중인지 */
export function isEntrySharedInMoment(entryId) {
    if (!entryId) return false;
    return getSharedPhotos().some((p) => p && p.entryId === entryId);
}

/** 컬렉션 캐시에서 해당 entry의 공유 사진 URL 목록 (v2 photos[] 포함) */
export function getSharedPhotoUrlsForEntry(entryId) {
    if (!entryId) return [];
    const urls = [];
    for (const p of getSharedPhotos()) {
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
    const prevShared = [...getSharedPhotos()];
    setSharedPhotos(prevShared.filter((p) => !matches(p)));
    onChange?.('applied');

    try {
        const { dbOps } = await import('../db/ops.js');
        await dbOps.unsharePhotos(photos, { entryId, shareType, mealSync });
        return true;
    } catch (e) {
        console.error('unshareWithOptimisticUpdate 실패:', e);
        setSharedPhotos(prevShared);
        rollbackExtra?.();
        onChange?.('rolledback');
        return false;
    }
}

/** loadMyShares로 공유 캐시 갱신 */
export async function refreshMySharesCache() {
    const { loadMyShares } = await import('../db.js');
    const myShares = await loadMyShares();
    return setSharedPhotos(myShares);
}
