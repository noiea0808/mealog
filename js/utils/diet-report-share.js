/** AI 식단분석 → 모먼트(insight 타입) 공유 식별·조회 */

export const DIET_REPORT_MOMENT_SLOT_LABEL = 'AI식단분석';

export function getDietReportShareDateRangeText(dateStr) {
    return `${DIET_REPORT_MOMENT_SLOT_LABEL}·${dateStr}`;
}

export function isDietReportInsightShare(photo) {
    if (!photo || photo.type !== 'insight') return false;
    const r = String(photo.dateRangeText || '');
    return r.startsWith(DIET_REPORT_MOMENT_SLOT_LABEL) || r.startsWith('AI 식단분석');
}

export function findDietReportMomentShare(dateStr, uid, sharedPhotos) {
    if (!dateStr || !uid) return null;
    const key = getDietReportShareDateRangeText(dateStr);
    const list = Array.isArray(sharedPhotos) ? sharedPhotos : [];
    return (
        list.find((p) => {
            if (!p || p.type !== 'insight' || p.userId !== uid) return false;
            if (p.dateRangeText === key) return true;
            if (p.date === dateStr && isDietReportInsightShare(p)) return true;
            const r = String(p.dateRangeText || '');
            return r.startsWith('AI 식단분석') && r.includes(dateStr);
        }) || null
    );
}
