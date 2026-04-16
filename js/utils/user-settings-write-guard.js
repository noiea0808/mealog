/**
 * 식사·모먼트 공유·밀톡·게시판 등 서버에 반영되는 사용자 콘텐츠 쓰기 전 검증.
 * (온보딩이 잘못 스킵된 세션에서 빈/기본 설정으로 기록·공유되는 것을 막음)
 *
 * @param {unknown} userSettings — 보통 window.userSettings
 * @returns {boolean}
 */
export function isUserSettingsReadyForContentWrites(userSettings) {
    const ws = userSettings;
    if (!ws || typeof ws !== 'object') return false;
    if (ws.termsAgreed !== true) return false;
    const nick =
        ws.profile && typeof ws.profile.nickname === 'string' ? ws.profile.nickname.trim() : '';
    if (!nick || nick === '게스트') return false;
    if (ws.profileCompleted === true) return true;
    if (ws.profileCompleted === false) return false;
    // 레거시: profileCompleted 필드 없음 — 약관 + 유효 닉네임이면 허용
    return true;
}
