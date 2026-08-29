// 관리자 users 로컬 미러 — 순수 계산부 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRootTimestampField,
    parseSettingsDate,
    coalesceSignupDate,
    computeSignupToLastLoginMs,
    deriveLoginMethod,
    buildUserAnalyticsRow,
    buildUserMirrorRow,
    USERS_MIRROR_ROW_SCHEMA,
    reviveUserRow,
    computeUsersSyncStart,
    decideUsersSyncMode
} from '../js/admin/users-mirror-model.js';

const ts = (iso) => ({ toDate: () => new Date(iso) });

test('parseRootTimestampField: Timestamp·Date·ms·{seconds}·ISO 를 모두 받는다', () => {
    assert.equal(parseRootTimestampField(ts('2026-08-01T00:00:00Z')).toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(parseRootTimestampField(new Date('2026-08-01T00:00:00Z')).toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(parseRootTimestampField(1754006400000).toISOString(), new Date(1754006400000).toISOString());
    assert.equal(parseRootTimestampField({ seconds: 1754006400, nanoseconds: 0 }).getTime(), 1754006400000);
    assert.equal(parseRootTimestampField('2026-08-01T00:00:00Z').toISOString(), '2026-08-01T00:00:00.000Z');
});

test('parseRootTimestampField: 빈 값·깨진 값은 null', () => {
    assert.equal(parseRootTimestampField(null), null);
    assert.equal(parseRootTimestampField(''), null);
    assert.equal(parseRootTimestampField('말도 안 되는 값'), null);
});

test('parseSettingsDate: ISO·Timestamp·빈 값', () => {
    assert.equal(parseSettingsDate('2026-08-01T00:00:00Z').toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(parseSettingsDate(ts('2026-08-02T00:00:00Z')).toISOString(), '2026-08-02T00:00:00.000Z');
    assert.equal(parseSettingsDate(null), null);
    assert.equal(parseSettingsDate('쓰레기'), null);
});

test('coalesceSignupDate: 루트 createdAt 이 있으면 그대로, 없으면 둘 중 이른 쪽', () => {
    const root = new Date('2026-01-01T00:00:00Z');
    assert.equal(coalesceSignupDate(root, new Date('2026-05-01'), new Date('2026-03-01')).getTime(), root.getTime());

    const picked = coalesceSignupDate(null, new Date('2026-05-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    assert.equal(picked.toISOString(), '2026-03-01T00:00:00.000Z');

    assert.equal(coalesceSignupDate(null, null, null), null);
});

test('computeSignupToLastLoginMs: 역전이면 null', () => {
    const a = new Date('2026-01-01T00:00:00Z');
    const b = new Date('2026-01-03T00:00:00Z');
    assert.equal(computeSignupToLastLoginMs(a, b), 2 * 86400000);
    assert.equal(computeSignupToLastLoginMs(b, a), null);
    assert.equal(computeSignupToLastLoginMs(null, b), null);
});

test('deriveLoginMethod: providerId → email → kakao_ UID → 게스트', () => {
    assert.equal(deriveLoginMethod('google.com', null, 'u1'), '구글');
    assert.equal(deriveLoginMethod('kakao.com', null, 'u1'), '카카오');
    assert.equal(deriveLoginMethod(null, 'a@b.com', 'u1'), '이메일');
    assert.equal(deriveLoginMethod(null, null, 'kakao_123'), '카카오');
    assert.equal(deriveLoginMethod(null, null, 'KAKAO_123'), '카카오');
    assert.equal(deriveLoginMethod(null, null, 'u1'), '게스트');
});

test('buildUserAnalyticsRow: 루트+settings 를 분석 행으로', () => {
    const row = buildUserAnalyticsRow(
        'u1',
        {
            createdAt: ts('2026-01-01T00:00:00Z'),
            lastLoginAt: ts('2026-01-11T00:00:00Z'),
            providerId: 'google.com'
        },
        { profile: { birthdate: ' 19900101 ', lifestyle: ' 직장인 ', gender: 'female' } }
    );
    assert.equal(row.userId, 'u1');
    assert.equal(row.birthdate, '19900101');
    assert.equal(row.lifestyle, '직장인');
    assert.equal(row.gender, 'female');
    assert.equal(row.loginMethod, '구글');
    assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(row.lastLoginAt, '2026-01-11T00:00:00.000Z');
    assert.equal(row.signupToLastLoginMs, 10 * 86400000);
});

test('buildUserAnalyticsRow: settings 없는 고아 문서는 null (목록과 같은 규칙)', () => {
    assert.equal(buildUserAnalyticsRow('u1', { createdAt: ts('2026-01-01T00:00:00Z') }, null), null);
    assert.equal(buildUserAnalyticsRow('', {}, {}), null);
});

test('buildUserAnalyticsRow: 게스트는 가입~로그인 간격을 재지 않는다', () => {
    const row = buildUserAnalyticsRow(
        'u1',
        { createdAt: ts('2026-01-01T00:00:00Z'), lastLoginAt: ts('2026-01-11T00:00:00Z') },
        {}
    );
    assert.equal(row.loginMethod, '게스트');
    assert.equal(row.signupToLastLoginMs, null);
});

test('buildUserAnalyticsRow: 루트 createdAt 없으면 settings 시각으로 가입일을 메운다', () => {
    const row = buildUserAnalyticsRow(
        'u1',
        { lastLoginAt: ts('2026-01-11T00:00:00Z'), providerId: 'kakao.com' },
        { profileCompletedAt: '2026-01-05T00:00:00Z', termsAgreedAt: '2026-01-03T00:00:00Z' }
    );
    // createdAt(루트)은 여전히 null 이지만, 간격은 보정된 가입일(1/3)로 잰다
    assert.equal(row.createdAt, null);
    assert.equal(row.signupToLastLoginMs, 8 * 86400000);
});

test('buildUserAnalyticsRow: settings 의 email·providerId 가 루트보다 우선', () => {
    const row = buildUserAnalyticsRow('u1', { providerId: null, email: null }, { providerId: 'google.com' });
    assert.equal(row.loginMethod, '구글');
});

test('reviveUserRow: ISO 를 Date 로 되살린다', () => {
    const revived = reviveUserRow({ userId: 'u1', createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null });
    assert.ok(revived.createdAt instanceof Date);
    assert.equal(revived.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(revived.lastLoginAt, null);
    assert.equal(reviveUserRow(null), null);
});

test('computeUsersSyncStart: 겹침 창만큼 물러난 Date, 북마크 없으면 null', () => {
    const d = computeUsersSyncStart('2026-08-28T12:00:00.000Z', 48 * 3600 * 1000);
    assert.equal(d.toISOString(), '2026-08-26T12:00:00.000Z');
    assert.equal(computeUsersSyncStart(''), null);
    assert.equal(computeUsersSyncStart('깨진 값'), null);
});

test('decideUsersSyncMode: 미러가 없거나 북마크가 깨졌으면 전체', () => {
    assert.equal(decideUsersSyncMode(null, 10).mode, 'full');
    assert.equal(decideUsersSyncMode({ bootstrapDone: false }, 10).mode, 'full');
    assert.equal(decideUsersSyncMode({ bootstrapDone: true, lastSyncedAt: 'x' }, 10).reason, 'bad-bookmark');
});

test('decideUsersSyncMode: 주기가 지나면 전체', () => {
    const now = Date.parse('2026-08-28T00:00:00Z');
    const meta = { bootstrapDone: true, lastSyncedAt: '2026-08-20T00:00:00Z', rootDocCount: 10, rowSchema: USERS_MIRROR_ROW_SCHEMA };
    assert.equal(decideUsersSyncMode(meta, 10, 7 * 86400000, now).reason, 'stale');
    assert.equal(decideUsersSyncMode(meta, 10, 30 * 86400000, now).mode, 'delta');
});

test('decideUsersSyncMode: 서버 문서 수가 줄면 삭제로 보고 전체', () => {
    const now = Date.parse('2026-08-28T00:00:00Z');
    const meta = { bootstrapDone: true, lastSyncedAt: '2026-08-27T00:00:00Z', rootDocCount: 10, rowSchema: USERS_MIRROR_ROW_SCHEMA };
    assert.equal(decideUsersSyncMode(meta, 9, 7 * 86400000, now).reason, 'deletion-detected');
    // 늘어난 건 신규 가입 — 델타가 채우므로 전체가 필요 없다
    assert.equal(decideUsersSyncMode(meta, 11, 7 * 86400000, now).mode, 'delta');
    // 카운트를 못 셌으면 감지를 건너뛰고 델타로 간다
    assert.equal(decideUsersSyncMode(meta, null, 7 * 86400000, now).mode, 'delta');
});

test('decideUsersSyncMode: 행 모양이 바뀌면 전체 재구축', () => {
    const now = Date.parse('2026-08-28T00:00:00Z');
    const fresh = { bootstrapDone: true, lastSyncedAt: '2026-08-27T00:00:00Z', rootDocCount: 10 };
    // rowSchema 가 없는(옛 모양) 미러는 아무리 최신이어도 다시 빚는다
    assert.equal(decideUsersSyncMode(fresh, 10, 7 * 86400000, now).reason, 'schema-changed');
    assert.equal(
        decideUsersSyncMode({ ...fresh, rowSchema: USERS_MIRROR_ROW_SCHEMA }, 10, 7 * 86400000, now).mode,
        'delta'
    );
});

test('buildUserMirrorRow: settings 없는 고아도 행을 만든다 (대시보드 신규 사용자용)', () => {
    const row = buildUserMirrorRow('u1', { createdAt: ts('2026-01-01T00:00:00Z') }, null);
    assert.equal(row.userId, 'u1');
    assert.equal(row.hasSettings, false);
    assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(row.journal, []);
    // 「사용자 분석」쪽 규칙은 그대로 — 고아는 여전히 null
    assert.equal(buildUserAnalyticsRow('u1', { createdAt: ts('2026-01-01T00:00:00Z') }, null), null);
});

test('buildUserMirrorRow: 하루 소감 자국은 날짜순으로, 깨진 날짜키는 버린다', () => {
    const row = buildUserMirrorRow('u1', {}, { profile: {} }, [
        { d: '2026-03-02', r: '2026-03-02T10:00:00.000Z' },
        { d: '나쁜키', r: '' },
        { d: '2026-03-01' }
    ]);
    assert.deepEqual(row.journal, [
        { d: '2026-03-01', r: '' },
        { d: '2026-03-02', r: '2026-03-02T10:00:00.000Z' }
    ]);
    assert.equal(row.hasSettings, true);
});
