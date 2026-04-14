/**
 * 서버 스냅샷 행 + 로컬 전용(orphan) 행을 합치고 본식 슬롯 중복을 제거한다.
 * 최우선: serverRows(서버 확정 스냅샷) — orphan은 서버에 아직 없는 id만 유지.
 */
import { getMealSyncManager } from './meal-sync-manager.js';

const MAIN_MEAL_SLOTS = new Set(['morning', 'lunch', 'dinner']);

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
    return false;
}

function dedupeMainSlotTemps(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    const mgr = getMealSyncManager();
    return mealsArr.filter((m, _, arr) => {
        if (!m?.id || !String(m.id).startsWith('temp_')) return true;
        if (!MAIN_MEAL_SLOTS.has(m.slotId)) return true;
        const hasReal = arr.some(
            (o) =>
                o &&
                o !== m &&
                !String(o.id).startsWith('temp_') &&
                o.date === m.date &&
                o.slotId === m.slotId
        );
        if (hasReal) {
            mgr.removeTempRowSideEffects(m);
            return false;
        }
        return true;
    });
}

function dedupeMainSlotRealIds(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    const mgr = getMealSyncManager();
    const seen = new Set();
    return mealsArr.filter((m) => {
        if (!m?.id) return true;
        const id = String(m.id);
        if (id.startsWith('temp_')) return true;
        if (!m.date || !MAIN_MEAL_SLOTS.has(m.slotId)) return true;
        const key = `${m.date}__${m.slotId}`;
        if (seen.has(key)) {
            mgr.clearDuplicateRealIdSideEffects(id);
            return false;
        }
        seen.add(key);
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
    return dedupeMainSlotRealIds(dedupeMainSlotTemps(merged));
}

/** 증분 병합 직후 mealHistory 배열만 본식 중복 제거 */
export function dedupeMealListOnly(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    return dedupeMainSlotRealIds(dedupeMainSlotTemps(mealsArr));
}
