/**
 * 트래커·웰컴·연속일 계산 공통: 일자별 실질 기록 건수.
 * dailyStats(Firestore 집계) ∪ mealHistory(최근 쿼리) — 둘 다 0일 때만 무기록.
 *
 * 삭제 직후 onMealWritten 집계가 한 박자 늦으면 stats.count만 남는 경우가 있어,
 * 최근 구간에서 meal 쿼리 결과가 50건 미만(전체가 스냅샷에 다 올라온 경우)이면
 * 해당 일의 history 건수 0을 우선한다.
 */
function isValidYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * @param {string} iso YYYY-MM-DD
 * @returns {number}
 */
export function getRecordCountForIso(iso) {
    if (!isValidYmd(iso)) return 0;
    const statsCount = (window.dailyStats && window.dailyStats[iso]?.count) ?? 0;
    const historyCount =
        window.mealHistory && Array.isArray(window.mealHistory)
            ? window.mealHistory.filter((m) => m && m.date === iso).length
            : 0;

    if (statsCount > 0 && historyCount === 0) {
        const range = window.loadedMealsDateRange;
        const n = window.mealHistory?.length ?? 0;
        if (
            range &&
            typeof range.start === 'string' &&
            typeof range.end === 'string' &&
            iso >= range.start &&
            iso <= range.end &&
            n < 50
        ) {
            return 0;
        }
    }

    return Math.max(statsCount, historyCount);
}
