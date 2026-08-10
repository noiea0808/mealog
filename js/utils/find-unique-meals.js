/**
 * 서버 스냅샷 행 + 로컬 전용(orphan) 행을 합친다.
 * 본식·간식 모두 동일 (date, slotId)에 여러 건 허용 — 실 id 중복 제거는 하지 않음.
 * temp_* 는 동일 슬롯에 서버 id가 생긴 뒤에만 제거(1슬롯 1건 시대 유산; 다건에서는 낙관 temp id 치환 경로 우선).
 */
import { getMealSyncManager } from './meal-sync-manager.js';
import { isPendingSync as isOutboxPendingSync } from './outbox-store.js';

function sortMealsDesc(a, b) {
    return (
        (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
    );
}

/**
 * 스냅샷에 없는 로컬 행을 **유지**해야 하는가.
 *
 * 지워도 되는 경우는 하나뿐이다 — 서버에 있었는데 빠진 것(다른 기기에서 삭제).
 * 아직 못 올린 내 기록은 「지워진 기록」이 아니다.
 *
 * 예전에는 여덟 개의 플래그를 나열해 보호했는데, 그 표식들이 재시도·정합 과정에서 서로
 * 옮겨 다녀서(칩 → markInFlight 가 칩을 지움 → ack 나 실패로 다시 표식) **표식이 하나도
 * 없는 찰나**가 존재했고, 거기에 리스너 재구독 병합이 겹치면 기록이 조용히 사라졌다.
 * 조건을 아홉 번째로 추가해도 못 막는 종류의 레이스였다.
 *
 * 이제 기준은 하나다 — 아웃박스에 있으면 아직 내 것이다. 아웃박스에서 빠지는 시점은
 * 「서버 존재가 확인됐을 때」뿐이므로, 보호가 끊기는 찰나가 원리적으로 없다.
 */
function isOrphanCandidate(m, serverIds) {
    if (!m?.id) return false;
    const id = String(m.id);
    if (serverIds.has(id)) return false;
    if (id.startsWith('temp_')) return true; // 아웃박스 이전 낙관 행 — 보호 유지
    return isOutboxPendingSync('meal', id);
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

function mealDateYmd(m) {
    const d = m?.date;
    if (typeof d !== 'string') return '';
    const ymd = d.trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd : '';
}

/**
 * @param {Array<object>} serverRows — 리스너 스냅샷에서 온 행(서버 우선)
 * @param {Array<object>|null|undefined} prevHist — 병합 전 mealHistory
 * @param {{ preserveBeforeDate?: string|null }} [opts]
 *   preserveBeforeDate: 이 날짜(미포함)보다 과거인 기존 기록은 부분 윈도우 스냅샷이 지우지 않도록 유지
 * @returns {Array<object>}
 */
export function findUniqueMeals(serverRows, prevHist, opts = {}) {
    const serverIds = new Set((serverRows || []).map((m) => String(m?.id)));
    const prev = Array.isArray(prevHist) ? prevHist : [];
    const preserveBefore =
        typeof opts?.preserveBeforeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.preserveBeforeDate)
            ? opts.preserveBeforeDate
            : null;

    const keep = [];
    const keepIds = new Set();
    for (const m of prev) {
        if (!m?.id) continue;
        const id = String(m.id);
        if (serverIds.has(id) || keepIds.has(id)) continue;
        if (isOrphanCandidate(m, serverIds)) {
            keep.push(m);
            keepIds.add(id);
            continue;
        }
        // 실시간 구독 범위 밖(과거 on-demand 캐시) — initial 스냅샷이 통째로 대체하지 않음
        if (preserveBefore) {
            const ymd = mealDateYmd(m);
            if (ymd && ymd < preserveBefore) {
                keep.push(m);
                keepIds.add(id);
            }
        }
    }
    const merged = [...(serverRows || []), ...keep].sort(sortMealsDesc);
    return dedupeStaleSlotTemps(merged);
}

/** 증분 병합 직후 mealHistory 배열 정리 */
export function dedupeMealListOnly(mealsArr) {
    if (!Array.isArray(mealsArr)) return mealsArr;
    return dedupeStaleSlotTemps(mealsArr);
}
