const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** YYYY-MM-DD → `2026. 5.25 (월)` */
export function formatMealogDateLabel(dateStr) {
    const dObj = new Date(String(dateStr) + 'T00:00:00');
    if (Number.isNaN(dObj.getTime())) return String(dateStr || '');
    const y = dObj.getFullYear();
    const m = dObj.getMonth() + 1;
    const day = dObj.getDate();
    const wd = WEEKDAY_KO[dObj.getDay()] || '';
    return `${y}. ${m}.${day} (${wd})`;
}
