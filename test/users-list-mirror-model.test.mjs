/**
 * 사용자 목록을 미러로 세울 때의 셈법 — 서버 집계 쿼리가 돌려주던 값과 같아야 한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countByField, firstValueByField } from '../js/admin/users-list-mirror-model.js';
import { deriveUserListDisplay, buildUserListRow } from '../js/admin/users-mirror-model.js';

test('countByField: 사용자마다 던지던 count 쿼리를 한 번 훑기로', () => {
    const rows = [{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }, { userId: '' }, {}];
    const got = countByField(rows, (r) => r.userId);
    assert.equal(got.get('u1'), 2);
    assert.equal(got.get('u2'), 1);
    assert.equal(got.size, 2);
});

test('countByField: 키를 꺼내다 던져도 그 항목만 건너뛴다', () => {
    const got = countByField([{ a: 1 }, null, { a: 2 }], (r) => r.a.toString());
    assert.equal(got.get('1'), 1);
    assert.equal(got.get('2'), 1);
});

test('firstValueByField: 먼저 만난 값만 — 빈 값은 건너뛰고 다음을 본다', () => {
    const docs = [
        { uid: 'u1', icon: null },
        { uid: 'u1', icon: '🐱' },
        { uid: 'u1', icon: '🐶' },
        { uid: 'u2', icon: '' }
    ];
    const got = firstValueByField(
        docs,
        (d) => d.uid,
        (d) => d.icon
    );
    assert.equal(got.get('u1'), '🐱');
    assert.equal(got.has('u2'), false);
});

test('deriveUserListDisplay: 프로필 미완료·빈값·「게스트」는 전부 「미설정」', () => {
    assert.equal(deriveUserListDisplay({ profile: { nickname: '가나' } }).nickname, '미설정');
    assert.equal(deriveUserListDisplay({ profileCompleted: true, profile: { nickname: '  ' } }).nickname, '미설정');
    assert.equal(deriveUserListDisplay({ profileCompleted: true, profile: { nickname: '게스트' } }).nickname, '미설정');
    assert.equal(deriveUserListDisplay({ profileCompleted: true, profile: { nickname: '가나' } }).nickname, '가나');
    assert.equal(deriveUserListDisplay(null).nickname, '미설정');
});

test('deriveUserListDisplay: 아이콘만 폴백이 있다 — 프로필 > 공유 게시물 > 기본', () => {
    assert.equal(deriveUserListDisplay({ profile: { icon: '🦊' } }, { fallbackIcon: '🐱' }).icon, '🦊');
    assert.equal(deriveUserListDisplay({ profile: {} }, { fallbackIcon: '🐱' }).icon, '🐱');
    assert.equal(deriveUserListDisplay({ profile: {} }).icon, '🐻');
    // 프로필 자체가 없어도 공유 게시물 아이콘은 살아남는다 (예전 서버 목록과 같은 규칙)
    assert.equal(deriveUserListDisplay({}, { fallbackIcon: '🐱' }).icon, '🐱');
});

test('buildUserListRow: 미러 행 + 다른 미러가 센 값 → 목록 한 줄', () => {
    const row = {
        userId: 'u1',
        nickname: '가나',
        profileIcon: '🦊',
        birthdate: '1990-01-01',
        lifestyle: '주간',
        gender: 'female',
        email: 'a@b.c',
        loginMethod: '구글',
        termsAgreed: true,
        termsAgreedAt: '2026-01-02T00:00:00.000Z',
        termsVersion: 'v3',
        profileCompleted: true,
        profileCompletedAt: '2026-01-03T00:00:00.000Z',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastLoginAt: new Date('2026-02-01T00:00:00Z'),
        signupToLastLoginMs: 123,
        mealCountField: 9
    };
    const out = buildUserListRow(row, {
        timelineCount: 42,
        albumShareCount: 3,
        talkCount: 1,
        bannedWrite: true,
        deleteRequested: true,
        pageFetchIndex: 7
    });
    assert.equal(out.userId, 'u1');
    assert.equal(out.icon, '🦊');
    assert.equal(out.timelineCount, 42);
    assert.equal(out.albumShareCount, 3);
    assert.equal(out.talkCount, 1);
    assert.equal(out.activityBanLevel, 1);
    assert.equal(out.deleteRequested, true);
    assert.equal(out.pageFetchIndex, 7);
    assert.equal(out.createdAtResolved.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('buildUserListRow: meals 미러가 못 세면 루트의 mealCount 로 물러난다', () => {
    const row = { userId: 'u1', loginMethod: '게스트', mealCountField: 9 };
    assert.equal(buildUserListRow(row, {}).timelineCount, 9);
    assert.equal(buildUserListRow(row, { timelineCount: 0 }).timelineCount, 0);
    assert.equal(buildUserListRow({ userId: 'u1' }, {}).timelineCount, 0);
});

test('buildUserListRow: 루트 createdAt 이 없으면 프로필·약관 시각 중 이른 쪽이 가입일', () => {
    const out = buildUserListRow(
        {
            userId: 'u1',
            createdAt: null,
            profileCompletedAt: '2026-03-05T00:00:00.000Z',
            termsAgreedAt: '2026-03-01T00:00:00.000Z'
        },
        {}
    );
    assert.equal(out.createdAtResolved.toISOString(), '2026-03-01T00:00:00.000Z');
});
