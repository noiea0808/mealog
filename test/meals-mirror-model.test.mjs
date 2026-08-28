// 관리자 meals 로컬 미러 — 순수 계산부 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeSyncStartIso,
    mirrorKey,
    userIdFromMealPath,
    toMirrorRecords,
    tombstonesToKeys,
    nextBookmark,
    isYmdInRange
} from '../js/admin/meals-mirror-model.js';

test('computeSyncStartIso: 북마크에서 겹침 창만큼 물러난다', () => {
    const iso = computeSyncStartIso('2026-08-28T12:00:00.000Z', 48 * 3600 * 1000);
    assert.equal(iso, '2026-08-26T12:00:00.000Z');
});

test('computeSyncStartIso: 북마크가 없거나 깨졌으면 빈 문자열(부트스트랩 신호)', () => {
    assert.equal(computeSyncStartIso(''), '');
    assert.equal(computeSyncStartIso(undefined), '');
    assert.equal(computeSyncStartIso('not-a-date'), '');
});

test('mirrorKey / userIdFromMealPath: 경로에서 uid를 뽑아 키를 만든다', () => {
    const path = 'artifacts/mealog-r0/users/uid123/meals/m1';
    assert.equal(userIdFromMealPath(path), 'uid123');
    assert.equal(mirrorKey('uid123', 'm1'), 'uid123/m1');
});

test('userIdFromMealPath: users 세그먼트가 없으면 빈 문자열', () => {
    assert.equal(userIdFromMealPath('artifacts/mealog-r0/sharedPhotos/x'), '');
    assert.equal(userIdFromMealPath(''), '');
});

test('toMirrorRecords: 정상 문서는 {k, id, userId, ...data} 로 평탄화한다', () => {
    const recs = toMirrorRecords([
        {
            id: 'm1',
            path: 'artifacts/mealog-r0/users/u1/meals/m1',
            data: { date: '2026-08-01', slotId: 'lunch', updatedAt: '2026-08-01T03:00:00.000Z' }
        }
    ]);
    assert.equal(recs.length, 1);
    assert.deepEqual(recs[0], {
        k: 'u1/m1',
        id: 'm1',
        userId: 'u1',
        date: '2026-08-01',
        slotId: 'lunch',
        updatedAt: '2026-08-01T03:00:00.000Z'
    });
});

test('toMirrorRecords: date 없는 문서와 uid를 못 뽑는 문서는 버린다', () => {
    const recs = toMirrorRecords([
        { id: 'a', path: 'artifacts/mealog-r0/users/u1/meals/a', data: { slotId: 'lunch' } },
        { id: 'b', path: 'artifacts/mealog-r0/users/u1/meals/b', data: { date: 42 } },
        { id: 'c', path: 'weird/path', data: { date: '2026-08-01' } },
        { id: 'd', path: 'artifacts/mealog-r0/users/u2/meals/d', data: { date: '2026-08-02' } }
    ]);
    assert.deepEqual(recs.map((r) => r.k), ['u2/d']);
});

test('tombstonesToKeys: userId·mealId 가 모두 있어야 키가 된다', () => {
    const keys = tombstonesToKeys([
        { userId: 'u1', mealId: 'm1', deletedAt: '2026-08-28T00:00:00.000Z' },
        { userId: 'u2' },
        { mealId: 'm3' },
        null
    ]);
    assert.deepEqual(keys, ['u1/m1']);
});

test('nextBookmark: 앞으로만 간다', () => {
    assert.equal(nextBookmark('', '2026-08-28T00:00:00.000Z'), '2026-08-28T00:00:00.000Z');
    assert.equal(
        nextBookmark('2026-08-27T00:00:00.000Z', '2026-08-28T00:00:00.000Z'),
        '2026-08-28T00:00:00.000Z'
    );
    // 시계가 뒤로 간 기기에서도 북마크는 후퇴하지 않는다
    assert.equal(
        nextBookmark('2026-08-28T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
        '2026-08-28T00:00:00.000Z'
    );
    // 이번 시각이 깨졌으면 이전 북마크 유지
    assert.equal(nextBookmark('2026-08-28T00:00:00.000Z', ''), '2026-08-28T00:00:00.000Z');
});

test('isYmdInRange: 경계 포함 문자열 비교', () => {
    assert.equal(isYmdInRange('2026-08-01', '2026-08-01', '2026-08-31'), true);
    assert.equal(isYmdInRange('2026-08-31', '2026-08-01', '2026-08-31'), true);
    assert.equal(isYmdInRange('2026-07-31', '2026-08-01', '2026-08-31'), false);
    assert.equal(isYmdInRange(undefined, '2026-08-01', '2026-08-31'), false);
});
