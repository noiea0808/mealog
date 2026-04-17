/**
 * 프로필·온보딩 판별 공통 (닉네임이 비어 있거나 기본값이면 미완료로 본다)
 */

/**
 * @param {{ profile?: { nickname?: string } } | null | undefined} settings
 * @returns {boolean}
 */
export function hasValidMealogNickname(settings) {
    const n = (settings?.profile?.nickname != null ? String(settings.profile.nickname) : '').trim();
    return n.length > 0 && n !== '게스트';
}

/**
 * 가입 위저드 기준 프로필 단계 완료(관리자 '미설정'과 정합)
 * — profileCompleted 불리언 true + 유효 닉네임 (닉만 있고 플래그 없음은 미완료)
 * @param {{ profile?: { nickname?: string }; profileCompleted?: boolean } | null | undefined} settings
 */
export function isProfileWizardCompleted(settings) {
    if (!settings || settings.profileCompleted !== true) return false;
    return hasValidMealogNickname(settings);
}
