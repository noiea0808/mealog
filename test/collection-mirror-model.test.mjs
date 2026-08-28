// 관리자 범용 컬렉션 미러 — 순수 계산부 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    flattenForIdb,
    reviveForConsumers,
    toSortMs,
    toMirrorRow,
    rowToDocLike,
    computeCollectionSyncStart,
    decideCollectionSyncMode,
    sortRowsDesc
} from '../js/admin/collection-mirror-model.js';

/** Firestore Timestamp 흉내 */
const ts = (ms) => ({
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toDate: () => new Date(ms)
});

test('flattenForIdb: Timestamp 를 표식으로 눕히고 되살린다', () => {
    const ms = Date.parse('2026-08-01T00:00:00Z');
    const flat = flattenForIdb({ timestamp: ts(ms), title: '점심' });
    assert.deepEqual(flat.timestamp, { __fsts: ms });
    assert.equal(flat.title, '점심');

    const revived = reviveForConsumers(flat);
    assert.equal(typeof revived.timestamp.toDate, 'function');
    assert.equal(revived.timestamp.toDate().toISOString(), '2026-08-01T00:00:00.000Z');
    assert.equal(revived.timestamp.seconds, Math.floor(ms / 1000));
});

test('flattenForIdb: 중첩 객체·배열 안의 Timestamp 도 처리한다', () => {
    const ms = Date.parse('2026-08-02T00:00:00Z');
    const flat = flattenForIdb({ comments: [{ at: ts(ms), text: 'ㅎㅇ' }], meta: { deep: { at: ts(ms) } } });
    assert.deepEqual(flat.comments[0].at, { __fsts: ms });
    assert.deepEqual(flat.meta.deep.at, { __fsts: ms });

    const revived = reviveForConsumers(flat);
    assert.equal(revived.comments[0].at.toDate().getTime(), ms);
    assert.equal(revived.comments[0].text, 'ㅎㅇ');
});

test('flattenForIdb: Date 도 눕히고, 함수는 버린다', () => {
    const ms = Date.parse('2026-08-03T00:00:00Z');
    const flat = flattenForIdb({ when: new Date(ms), fn: () => 1, ok: true });
    assert.deepEqual(flat.when, { __fsts: ms });
    assert.equal(flat.fn, undefined);
    assert.equal(flat.ok, true);
});

test('flattenForIdb: DocumentReference 는 경로 문자열로 남는다', () => {
    const flat = flattenForIdb({ ref: { id: 'm1', path: 'artifacts/app/users/u1/meals/m1' } });
    assert.deepEqual(flat.ref, { __ref: 'artifacts/app/users/u1/meals/m1' });
});

test('flattenForIdb: null·undefined 를 안전하게 넘긴다', () => {
    const flat = flattenForIdb({ a: null, b: undefined });
    assert.equal(flat.a, null);
    assert.equal(flat.b, null);
});

test('toSortMs: Timestamp·ISO·숫자·눕힌 표식·없음', () => {
    const ms = Date.parse('2026-08-01T00:00:00Z');
    assert.equal(toSortMs(ts(ms)), ms);
    assert.equal(toSortMs({ __fsts: ms }), ms);
    assert.equal(toSortMs('2026-08-01T00:00:00Z'), ms);
    assert.equal(toSortMs(ms), ms);
    assert.equal(toSortMs(new Date(ms)), ms);
    assert.equal(toSortMs(null), 0);
    assert.equal(toSortMs('쓰레기'), 0);
});

test('toMirrorRow: id·정렬키·눕힌 본문', () => {
    const ms = Date.parse('2026-08-01T00:00:00Z');
    const row = toMirrorRow({ id: 'p1', data: { timestamp: ts(ms), userId: 'u1' } }, 'timestamp');
    assert.equal(row.id, 'p1');
    assert.equal(row._sortMs, ms);
    assert.equal(row.d.userId, 'u1');
    assert.equal(toMirrorRow(null, 'timestamp'), null);
});

test('rowToDocLike: 스냅숏 문서처럼 쓴다', () => {
    const ms = Date.parse('2026-08-01T00:00:00Z');
    const row = toMirrorRow({ id: 'p1', data: { timestamp: ts(ms), userId: 'u1' } }, 'timestamp');
    const d = rowToDocLike(row, 'artifacts/app/sharedPhotos');
    assert.equal(d.id, 'p1');
    assert.equal(d.exists(), true);
    assert.equal(d.ref.path, 'artifacts/app/sharedPhotos/p1');
    assert.equal(d.data().userId, 'u1');
    assert.equal(d.data().timestamp.toDate().getTime(), ms);
    // data() 는 같은 객체를 돌려준다(되살리기 반복 방지)
    assert.equal(d.data(), d.data());
});

test('computeCollectionSyncStart: 겹침 창만큼 물러난다', () => {
    const d = computeCollectionSyncStart('2026-08-28T12:00:00.000Z', 6 * 3600 * 1000);
    assert.equal(d.toISOString(), '2026-08-28T06:00:00.000Z');
    assert.equal(computeCollectionSyncStart(''), null);
    assert.equal(computeCollectionSyncStart('깨짐'), null);
});

test('decideCollectionSyncMode: 미러 없음·북마크 깨짐·주기 경과', () => {
    const now = Date.parse('2026-08-28T00:00:00Z');
    assert.equal(decideCollectionSyncMode(null, 5).reason, 'no-mirror');
    assert.equal(decideCollectionSyncMode({ bootstrapDone: true, lastSyncedAt: 'x' }, 5).reason, 'bad-bookmark');
    const meta = { bootstrapDone: true, lastSyncedAt: '2026-08-20T00:00:00Z', serverCount: 5 };
    assert.equal(decideCollectionSyncMode(meta, 5, 7 * 86400000, now).reason, 'stale');
    assert.equal(decideCollectionSyncMode(meta, 5, 30 * 86400000, now).mode, 'delta');
});

test('decideCollectionSyncMode: 문서 수가 줄면 삭제로 보고 전체', () => {
    const now = Date.parse('2026-08-28T00:00:00Z');
    const meta = { bootstrapDone: true, lastSyncedAt: '2026-08-27T00:00:00Z', serverCount: 10 };
    assert.equal(decideCollectionSyncMode(meta, 9, 7 * 86400000, now).reason, 'deletion-detected');
    assert.equal(decideCollectionSyncMode(meta, 11, 7 * 86400000, now).mode, 'delta');
    assert.equal(decideCollectionSyncMode(meta, null, 7 * 86400000, now).mode, 'delta');
});

test('sortRowsDesc: 최신순 + 상한, 정렬키 없는 행은 뒤로', () => {
    const rows = [{ id: 'a', _sortMs: 100 }, { id: 'b', _sortMs: 0 }, { id: 'c', _sortMs: 300 }];
    assert.deepEqual(sortRowsDesc(rows).map((r) => r.id), ['c', 'a', 'b']);
    assert.deepEqual(sortRowsDesc(rows, 2).map((r) => r.id), ['c', 'a']);
    assert.deepEqual(sortRowsDesc(null), []);
});
