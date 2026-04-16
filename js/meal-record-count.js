/**
 * 트래커·웰컴·연속일 계산 공통: 일자별 실질 기록 건수.
 * dailyStats(Firestore 연도별 집계) ∪ mealHistory(최근 meals 스냅샷) 중 큰 값.
 *
 * 예전에는 삭제 직후 stats만 남는 경우를 막기 위해 stats>0·history=0 이면 0으로 덮었는데,
 * 초기 meals 쿼리가 최대 50건만 가져와서(같은 달 안에서도 일부 날짜가 스냅샷에 없음)
 * 스테이징·운영·세션마다 meal 개수가 달라 **캘린더 점·연속일이 환경마다 다르게** 보이는 버그가 있었다.
 * 삭제는 meal-delete-optimistic 등으로 로컬 dailyStats를 이미 줄이므로, 여기서는 max만 쓴다.
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

    return Math.max(statsCount, historyCount);
}
