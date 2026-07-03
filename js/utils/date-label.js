const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** YYYY-MM-DD가 토·일(주말)인지 */
export function isWeekendIsoDate(dateStr) {
    const dObj = new Date(String(dateStr) + 'T00:00:00');
    if (Number.isNaN(dObj.getTime())) return false;
    const dow = dObj.getDay();
    return dow === 0 || dow === 6;
}

/** YYYY-MM-DD → `2026년 7월 1일 (수)` */
export function formatMealogDateLabel(dateStr) {
    const dObj = new Date(String(dateStr) + 'T00:00:00');
    if (Number.isNaN(dObj.getTime())) return String(dateStr || '');
    const y = dObj.getFullYear();
    const m = dObj.getMonth() + 1;
    const day = dObj.getDate();
    const wd = WEEKDAY_KO[dObj.getDay()] || '';
    return `${y}년 ${m}월 ${day}일 (${wd})`;
}
