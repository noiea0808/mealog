/** 분석 상단 식사 기록 N/M — 본식 다건 허용 집계 */

export const MAIN_MEAL_SLOT_IDS = ['morning', 'lunch', 'dinner'];

export function isSkipMealType(mealType) {
    const mt = (mealType || '').trim();
    return mt === 'Skip' || mt === '건너뜀';
}

/** Skip 제외 본식 슬롯 기록인지 */
export function isMainMealKpiRecord(m) {
    if (!m?.date || !m?.slotId) return false;
    if (!MAIN_MEAL_SLOT_IDS.includes(m.slotId)) return false;
    return !isSkipMealType(m.mealType);
}

/**
 * 본식 KPI: 분자 = 전체 건수, 추가본식 = 건수 − 유니크(date, slotId)
 * @param {Array<object>} records
 * @returns {{ recCount: number, extraMain: number, uniqueSlotCount: number }}
 */
export function computeMainMealKpiFromRecords(records) {
    const mains = (records || []).filter(isMainMealKpiRecord);
    const recCount = mains.length;
    const seen = new Set();
    mains.forEach((m) => seen.add(`${m.date}|${m.slotId}`));
    const uniqueSlotCount = seen.size;
    const extraMain = Math.max(0, recCount - uniqueSlotCount);
    return { recCount, extraMain, uniqueSlotCount };
}

/** 분모 = 일수×3 + 추가본식 건수 */
export function computeMainMealKpiDenominator(targetDays, extraMain) {
    const base = Math.max(0, targetDays * 3);
    return base + Math.max(0, extraMain || 0);
}
