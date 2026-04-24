/**
 * CSS scroll-snap을 끈 뒤에도 `wheel-layout` / 인라인 크롬이 동일 조건을 쓰도록 유지.
 * (구) 스냅 근처에서만 true → **항상 true** (스크롤 중에도 뱃지·휠 인덱스 갱신).
 */
export function isMomentV2HstripAtSnapPoint(hstrip, w) {
    void hstrip;
    void w;
    return true;
}
