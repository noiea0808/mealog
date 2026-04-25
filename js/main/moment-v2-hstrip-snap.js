/**
 * 가로 hstrip: CSS `scroll-snap-type: x mandatory` 일 때 스냅 지점 근처에서만
 * 뱃지·휠·배경 블러 URL 갱신(스크롤 중간에 인덱스가 흔들리지 않게).
 */
export function isMomentV2HstripAtSnapPoint(hstrip, w) {
    if (!hstrip || w <= 0) return true;
    const sl = hstrip.scrollLeft;
    const nearest = Math.round(sl / w);
    const tol = Math.max(6, Math.min(32, Math.floor(w * 0.04)));
    return Math.abs(sl - nearest * w) <= tol;
}
