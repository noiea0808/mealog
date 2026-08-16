/**
 * 게이트 필드 되돌림 방지 계약.
 *
 * 배경: 2026-08-13, 완료 상태였던 계정이 `profileCompleted:false` · `termsAgreed:false` ·
 * `profile.nickname:'게스트'` 로 되돌아가 기존 사용자에게 닉네임 설정 모달이 떴다.
 * hydration 전 기본값 스냅샷이 저장으로 나가면, 선행 읽기가 성공했더라도
 * `{ ...existingSettings, ...newSettings }` 에서 기본값이 뒤에 펼쳐져 실제 값을 이긴다.
 *
 * 여기서 검증하는 계약: **완료 → 미완료 방향의 값은 payload 에서 빠진다.**
 * 설정 쓰기가 merge 이므로 빠진 필드는 서버 값이 그대로 남는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stripGateRegressions, GATE_KEYS } from '../js/utils/settings-gate-guard.js';

/** 사고 당시의 기본값 스냅샷 (constants.js DEFAULT_USER_SETTINGS 의 게이트 부분) */
const defaultSnapshot = () => ({
    profileCompleted: false,
    profileCompletedAt: null,
    termsAgreed: false,
    termsAgreedAt: null,
    termsVersion: null,
    onboardingCompleted: false,
    isFirstLogin: true,
    profile: { nickname: '게스트', gender: '남성' }
});

/** 서버에 있던 정상 계정 */
const completedServerSettings = () => ({
    profileCompleted: true,
    profileCompletedAt: '2026-01-02T00:00:00.000Z',
    termsAgreed: true,
    termsAgreedAt: '2026-01-02T00:00:00.000Z',
    termsVersion: '1.3',
    onboardingCompleted: true,
    isFirstLogin: false,
    profile: { nickname: '밀로그_치프' }
});

describe('stripGateRegressions', () => {
    it('기본값 스냅샷이 완료 상태를 덮지 못한다 — 사고 재현', () => {
        const payload = defaultSnapshot();
        const stripped = stripGateRegressions(payload, completedServerSettings(), false);

        for (const key of GATE_KEYS) {
            assert.ok(!(key in payload), `${key} 가 payload 에 남아 있으면 서버 값을 덮는다`);
        }
        assert.ok(!('nickname' in payload.profile), '닉네임도 빠져야 서버의 진짜 닉네임이 남는다');
        assert.ok(stripped.includes('profile.nickname'));
        assert.equal(stripped.length, GATE_KEYS.length + 1);
    });

    it('선행 읽기가 실패하면 비교 기준이 없으므로 되돌림으로 본다', () => {
        const payload = defaultSnapshot();
        stripGateRegressions(payload, {}, true);

        for (const key of GATE_KEYS) {
            assert.ok(!(key in payload), `${key} 는 읽기 실패 시에도 빠져야 한다`);
        }
        assert.ok(!('nickname' in payload.profile));
    });

    it('진행 방향(미완료 → 완료)은 언제나 통과시킨다', () => {
        const payload = {
            profileCompleted: true,
            profileCompletedAt: '2026-08-13T00:00:00.000Z',
            termsAgreed: true,
            termsAgreedAt: '2026-08-13T00:00:00.000Z',
            termsVersion: '1.3',
            onboardingCompleted: true,
            isFirstLogin: false,
            profile: { nickname: '밀로그_치프' }
        };
        const before = JSON.parse(JSON.stringify(payload));
        const stripped = stripGateRegressions(payload, { profileCompleted: false }, false);

        assert.deepEqual(payload, before, '완료 방향 값은 하나도 빠지면 안 된다');
        assert.deepEqual(stripped, []);
    });

    it('게이트가 아닌 필드는 건드리지 않는다', () => {
        const payload = { bestMeals: { a: 1 }, tags: {}, profileCompleted: false, dailyComments: null };
        stripGateRegressions(payload, completedServerSettings(), false);

        assert.deepEqual(payload.bestMeals, { a: 1 });
        assert.deepEqual(payload.tags, {});
        assert.equal('dailyComments' in payload, true, 'null 이어도 게이트 밖이면 그대로 둔다');
        assert.equal('profileCompleted' in payload, false);
    });

    it('기존도 미완료면 되돌림이 아니다 — 신규 가입 경로를 막지 않는다', () => {
        const payload = { profileCompleted: false, termsAgreed: false, isFirstLogin: true };
        const stripped = stripGateRegressions(payload, { profileCompleted: false }, false);

        assert.deepEqual(stripped, []);
        assert.equal(payload.profileCompleted, false, '신규 사용자에겐 false 를 쓸 수 있어야 한다');
    });

    it('기존 닉네임이 게스트면 새 게스트 값을 막지 않는다', () => {
        const payload = { profile: { nickname: '게스트' } };
        const stripped = stripGateRegressions(payload, { profile: { nickname: '게스트' } }, false);

        assert.deepEqual(stripped, []);
        assert.equal(payload.profile.nickname, '게스트');
    });

    it('payload 에 없는 키는 만들어 내지 않는다', () => {
        const payload = { profileCompleted: false };
        stripGateRegressions(payload, completedServerSettings(), false);

        assert.deepEqual(Object.keys(payload), [], '있던 것만 지우고 새로 추가하지 않는다');
    });

    it('빈 입력에도 안전하다', () => {
        assert.deepEqual(stripGateRegressions(null, {}, false), []);
        assert.deepEqual(stripGateRegressions(undefined, {}, true), []);
        assert.deepEqual(stripGateRegressions({}, null, true), []);
    });
});
