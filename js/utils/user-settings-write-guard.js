/**
 * 식사·모먼트 공유·밀톡·게시판 등 서버에 반영되는 사용자 콘텐츠 쓰기 전 검증.
 * 약관: termsAgreed + termsVersion 필드 존재(로그인 시 `maybeBackfillTermsVersionFromAgreement`로 채움).
 * **현재 버전과의 일치·재동의**는 auth-flow 에서만 판단한다(비동기 버전 소스와 동기 가드 정합).
 */
/**
 * @param {unknown} userSettings — 보통 window.userSettings
 * @returns {boolean}
 */
export function isUserSettingsReadyForContentWrites(userSettings) {
    const ws = userSettings;
    if (!ws || typeof ws !== 'object') return false;
    if (ws.termsAgreed !== true) return false;
    const verStr = ws.termsVersion == null ? '' : String(ws.termsVersion).trim();
    if (verStr === '') return false;
    if (ws.profileCompleted !== true) return false;
    const nick =
        ws.profile && typeof ws.profile.nickname === 'string' ? ws.profile.nickname.trim() : '';
    if (!nick || nick === '게스트') return false;
    return true;
}
