/**
 * 서버 스냅샷 행 + 로컬 전용(orphan) 행을 합치고 **본식 슬롯** 중복만 제거한다.
 * 간식 슬롯(pre_morning·snack1·snack2·night)은 동일 시간대에 여러 건이 올 수 있음 — dedupe 대상에서 제외.
 * 최우선: serverRows(서버 확정 스냅샷) — orphan은 서버에 아직 없는 id만 유지.
 */
import { SLOTS } from '../constants.js';
import { getMealSyncManager } from './meal-sync-manager.js';

const SNACK_SLOT_IDS = new Set(SLOTS.filter((s) => s.type === 'snack').map((s) => s.id));

function allowsMultipleMealsPerDateSlot(slotId) {
    return SNACK_SLOT_IDS.has(String(slotId || ''));
}

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

/** 동일 date+slot에 이미 서버 id 행이 있으면 temp_* 행 제거(본식·간식 공통) — 오프라인 큐 동기화 후 중복 방지 */
function dedupeMainSlotTemps(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    const mgr = getMealSyncManager();
    return mealsArr.filter((m, _, arr) => {
        if (!m?.id || !String(m.id).startsWith('temp_')) return true;
        if (!m.date || !m.slotId) return true;
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

/** 동일 date+slot에 실제 id가 두 개면 하나만 유지 — 본식(morning·lunch·dinner)만 (간식은 복수 허용) */
function dedupeMainSlotRealIds(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    const mgr = getMealSyncManager();
    const seen = new Set();
    return mealsArr.filter((m) => {
        if (!m?.id) return true;
        const id = String(m.id);
        if (id.startsWith('temp_')) return true;
        if (!m.date || !m.slotId) return true;
        if (allowsMultipleMealsPerDateSlot(m.slotId)) return true;
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
