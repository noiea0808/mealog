/**
 * 서버 스냅샷 행 + 로컬 전용(orphan) 행을 합친다.
 * 본식·간식 모두 동일 (date, slotId)에 여러 건 허용 — 실 id 중복 제거는 하지 않음.
 * temp_* 는 동일 슬롯에 서버 id가 생긴 뒤에만 제거(1슬롯 1건 시대 유산; 다건에서는 낙관 temp id 치환 경로 우선).
 */
import { getMealSyncManager } from './meal-sync-manager.js';

function sortMealsDesc(a, b) {
    return (
        (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
    );
}

function isOrphanCandidate(m, serverIds) {
    if (!m?.id) return false;
    const id = String(m.id);
    if (serverIds.has(id)) return false;
    const mgr = getMealSyncManager();
    if (id.startsWith('temp_')) return true;
    if (m._localSaveFailed === true || m.is_sync_error === true) return true;
    if (mgr.hasErrorId(id)) return true;
    if (mgr.hasAbandonedId(id)) return true;
    if (mgr.hasPendingPhotoEntry(id)) return true;
    if (mgr.hasOptimisticTemp(id)) return true;
    if (mgr.isDeleting(m) || mgr.isDeleteInFlight(m) || mgr.isDeleteFailed(m)) return true;
    return false;
}

/** 동일 date+slot의 temp_* 중 서버에 대응 id가 이미 있으면 temp 제거(낙관 저장 치환 후 잔여 temp 정리) */
function dedupeStaleSlotTemps(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    const mgr = getMealSyncManager();
    return mealsArr.filter((m, _, arr) => {
        if (!m?.id || !String(m.id).startsWith('temp_')) return true;
        if (!m.date || !m.slotId) return true;
        const tid = String(m.id);
        if (!mgr.hasOptimisticTemp(tid)) return true;
        const hasRealSameSlot = arr.some(
            (o) =>
                o &&
                o !== m &&
                !String(o.id).startsWith('temp_') &&
                o.date === m.date &&
                o.slotId === m.slotId
        );
        if (hasRealSameSlot) {
            mgr.removeTempRowSideEffects(m);
            return false;
        }
        return true;
    });
}

/**
 * @param {Array<object>} serverRows — 리스너 스냅샷에서 온 행(서버 우선)
 * @param {Array<object>|null|undefined} prevHist — 병합 전 mealHistory
 * @returns {Array<object>}
 */
export function findUniqueMeals(serverRows, prevHist) {
    const serverIds = new Set((serverRows || []).map((m) => String(m?.id)));
    const prev = Array.isArray(prevHist) ? prevHist : [];
    const orphans = prev.filter((m) => isOrphanCandidate(m, serverIds));
    const merged = [...(serverRows || []), ...orphans].sort(sortMealsDesc);
    return dedupeStaleSlotTemps(merged);
}

/** 증분 병합 직후 mealHistory 배열 정리 */
export function dedupeMealListOnly(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    return dedupeStaleSlotTemps(mealsArr);
}
