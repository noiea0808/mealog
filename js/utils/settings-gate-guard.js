/**
 * userSettings 게이트 필드 되돌림 방지.
 *
 * 2026-08-13, 완료 상태였던 계정이 `profileCompleted:false` · `termsAgreed:false` ·
 * `profile.nickname:'게스트'` 로 되돌아가 기존 사용자에게 닉네임 설정 모달이 떴다.
 * 원인은 읽기 실패가 아니라 **hydration 전 기본값 스냅샷이 저장으로 나간 것**이다.
 * `dbOps.saveSettings` 의 `{ ...existingSettings, ...newSettings }` 는 newSettings 를 뒤에
 * 펼치므로, 선행 읽기가 성공했어도 기본값이 실제 값을 이긴다.
 *
 * 그래서 「완료 → 미완료」 방향의 값은 payload 에서 **뺀다**. 설정 쓰기가 merge 이므로
 * (`setDoc(..., { merge: true })`) 필드를 빼면 서버 값이 그대로 남는다. 진행 방향은 통과시킨다.
 *
 * 설계: docs/sync-outbox-design.md §4.1.1 (userSettings 는 단일 큰 문서 — 덮어쓰지 말고 병합)
 */
import { hasValidMealogNickname } from '../profile-readiness.js';

/** 각 게이트 필드에서 「완료」로 치는 값 */
const IS_COMPLETED = {
    profileCompleted: (v) => v === true,
    onboardingCompleted: (v) => v === true,
    termsAgreed: (v) => v === true,
    isFirstLogin: (v) => v === false, // 완료 방향이 false 인 유일한 필드
    profileCompletedAt: (v) => v != null && String(v).trim() !== '',
    termsAgreedAt: (v) => v != null && String(v).trim() !== '',
    termsVersion: (v) => v != null && String(v).trim() !== ''
};

export const GATE_KEYS = Object.keys(IS_COMPLETED);

/**
 * 되돌림에 해당하는 게이트 필드를 payload 에서 제거한다. **인자를 직접 수정한다.**
 *
 * 되돌림 판정:
 *   - 값이 완료 방향이면            → 통과 (미완료 → 완료는 언제나 허용)
 *   - 기존 값이 완료였는데 미완료면 → 제거
 *   - 기존을 못 읽었으면            → 제거 (비교 기준이 없으므로 되돌림으로 본다)
 *
 * 되돌림을 의도한 경로는 현재 없다 — `profileCompleted:false` 를 쓰는 곳은 기본값
 * (constants.js)과 레거시 백필(db/listeners.js)뿐이고, 둘 다 빠져도 서버 값이 유지될 뿐이다.
 *
 * @param {Record<string, unknown>} settingsToSave 저장 직전 payload (수정됨)
 * @param {Record<string, unknown>} existingSettings 서버에서 읽은 기존 설정 (못 읽었으면 {})
 * @param {boolean} existingReadFailed 선행 읽기가 실패했는가
 * @returns {string[]} 제거한 키 목록 (없으면 빈 배열)
 */
export function stripGateRegressions(settingsToSave, existingSettings, existingReadFailed) {
    const stripped = [];
    if (!settingsToSave || typeof settingsToSave !== 'object') return stripped;
    const existing = existingSettings && typeof existingSettings === 'object' ? existingSettings : {};

    for (const key of GATE_KEYS) {
        if (!(key in settingsToSave)) continue;
        if (IS_COMPLETED[key](settingsToSave[key])) continue;
        const hadCompleted = key in existing && IS_COMPLETED[key](existing[key]);
        if (hadCompleted || existingReadFailed) {
            delete settingsToSave[key];
            stripped.push(key);
        }
    }

    /**
     * 닉네임도 같은 부류다. saveSettings 의 병합 분기는 기존 닉네임을 못 읽으면 '게스트'로
     * 떨어지는데, merge 쓰기에서 profile.nickname 을 빼면 서버의 진짜 닉네임이 남는다.
     */
    const profile = settingsToSave.profile;
    if (profile && typeof profile === 'object' && String(profile.nickname ?? '').trim() === '게스트') {
        if (existingReadFailed || hasValidMealogNickname(existing)) {
            delete profile.nickname;
            stripped.push('profile.nickname');
        }
    }

    return stripped;
}
