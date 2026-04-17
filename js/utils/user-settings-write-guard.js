/**
 * 식사·모먼트 공유·밀톡·게시판 등 서버에 반영되는 사용자 콘텐츠 쓰기 전 검증.
 * (온보딩 위저드와 동일: 약관 불리언 + termsVersion 문자열 + profileCompleted + 유효 닉)
 *
 * @param {unknown} userSettings — 보통 window.userSettings
 * @returns {boolean}
 */
export function isUserSettingsReadyForContentWrites(userSettings) {
    const ws = userSettings;
    if (!ws || typeof ws !== 'object') return false;
    if (ws.termsAgreed !== true) return false;
    const ver = ws.termsVersion;
    if (ver == null || String(ver).trim() === '') return false;
    if (ws.profileCompleted !== true) return false;
    const nick =
        ws.profile && typeof ws.profile.nickname === 'string' ? ws.profile.nickname.trim() : '';
    if (!nick || nick === '게스트') return false;
    return true;
}
