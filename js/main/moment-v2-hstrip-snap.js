/**
 * 타임라인 휠 사진 팝업 `mealPhotoHstripScrollSettled`와 동일 규칙.
 * snap-x 캐러셀은 스냅 지점 **근처에 멈췄을 때만** 인덱스·하단 휠·배지를 갱신 — 중간에 뒤집히지 않게 함.
 */
export function isMomentV2HstripAtSnapPoint(hstrip, w) {
    if (!hstrip || w <= 0) return true;
    const sl = hstrip.scrollLeft;
    const nearest = Math.round(sl / w);
    const tol = Math.max(8, Math.min(28, Math.floor(w * 0.035)));
    return Math.abs(sl - nearest * w) <= tol;
}
