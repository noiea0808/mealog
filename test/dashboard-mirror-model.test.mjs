/**
 * 대시보드 로컬 미러 어댑터 — 미러 행이 Firestore 스냅숏 자리에 그대로 들어가는지.
 *
 * 이 어댑터가 하는 일은 「서버가 쿼리로 걸러 주던 것을 로컬에서 똑같이 거르는 것」이다.
 * 그래서 테스트도 대부분 **경계**를 본다 — 서버 쿼리의 범위와 한 칸이라도 어긋나면
 * 표의 합계가 조용히 달라진다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mealRowToDocLike,
    snapshotFromDocs,
    filterMealRowsByDate,
    countSlotAllFromRows,
    countMealRows,
    distinctMealUserIds,
    userRowsToDocLike,
    journalMarksFromUserRows,
    indexDocsById,
    docOrMissing,
    filterDocsByIdRange
} from '../js/admin/dashboard-mirror-model.js';

const meal = (userId, id, date, slotId) => ({ userId, id, date, slotId });

test('mealRowToDocLike: 경로가 컬렉션그룹 스냅숏과 같은 모양이라 uid 추출이 그대로 먹는다', () => {
    const d = mealRowToDocLike(meal('u1', 'm1', '2026-03-08', 'breakfast'), 'app-x');
    assert.equal(d.id, 'm1');
    assert.equal(d.ref.path, 'artifacts/app-x/users/u1/meals/m1');
    assert.equal(d.data().date, '2026-03-08');

    // dashboard.js 의 userIdFromMealDocRef 와 같은 규칙
    const parts = d.ref.path.split('/');
    assert.equal(parts[parts.indexOf('users') + 1], 'u1');
});

test('snapshotFromDocs: forEach 와 size 만 있으면 스캔부가 만족한다', () => {
    const snap = snapshotFromDocs([1, 2, 3]);
    assert.equal(snap.size, 3);
    const seen = [];
    snap.forEach((x) => seen.push(x));
    assert.deepEqual(seen, [1, 2, 3]);
    assert.equal(snapshotFromDocs(null).size, 0);
});

test('filterMealRowsByDate: 양쪽 경계를 포함하고, 위쪽 밖(미래 날짜)은 뺀다', () => {
    const rows = [
        meal('u1', 'a', '2026-03-07'),
        meal('u1', 'b', '2026-03-08'),
        meal('u1', 'c', '2026-03-10'),
        meal('u1', 'd', '2026-03-11'),
        meal('u1', 'e', undefined)
    ];
    const got = filterMealRowsByDate(rows, '2026-03-08', '2026-03-10').map((r) => r.id);
    assert.deepEqual(got, ['b', 'c']);
});

test('filterMealRowsByDate: 날짜 꺼내는 법을 넘기면 스냅숏 흉내 객체에도 쓴다', () => {
    const docs = [
        mealRowToDocLike(meal('u1', 'a', '2026-03-08'), 'x'),
        mealRowToDocLike(meal('u1', 'b', '2026-03-20'), 'x')
    ];
    const got = filterMealRowsByDate(docs, '2026-03-01', '2026-03-10', (d) => d.data().date);
    assert.deepEqual(
        got.map((d) => d.id),
        ['a']
    );
});

test('countSlotAllFromRows: 슬롯별 「전체」 — 제외 UID 는 애초에 세지 않는다', () => {
    const rows = [
        meal('u1', 'a', '2026-03-08', 'breakfast'),
        meal('u1', 'b', '2026-03-08', 'lunch'),
        meal('u2', 'c', '2026-03-08', 'breakfast'),
        meal('bad', 'd', '2026-03-08', 'breakfast'),
        meal('u1', 'e', '2026-03-08', 'daily_journal'),
        meal('u1', 'f', '2026-03-08', '없는슬롯')
    ];
    const got = countSlotAllFromRows(rows, ['breakfast', 'lunch', 'daily_journal'], new Set(['bad']));
    assert.deepEqual(got, [2, 1, 1]);
});

test('countMealRows: 전체 건수도 제외 UID 를 뺀 값', () => {
    const rows = [meal('u1', 'a', '2026-03-08'), meal('bad', 'b', '2026-03-08')];
    assert.equal(countMealRows(rows, new Set(['bad'])), 1);
    assert.equal(countMealRows(rows, new Set()), 2);
});

test('distinctMealUserIds: 사용자마다 던지던 count 쿼리를 대신한다', () => {
    const rows = [
        meal('u1', 'a', '2026-03-08'),
        meal('u1', 'b', '2026-03-09'),
        meal('u2', 'c', '2026-03-09'),
        meal('bad', 'd', '2026-03-09')
    ];
    const got = distinctMealUserIds(rows, new Set(['bad']));
    assert.deepEqual([...got].sort(), ['u1', 'u2']);
});

test('userRowsToDocLike: 대시보드가 보는 건 id 와 createdAt 뿐', () => {
    const d = new Date('2026-03-08T00:00:00Z');
    const docs = userRowsToDocLike([{ userId: 'u1', createdAt: d }, { userId: '' }, null]);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].id, 'u1');
    assert.equal(docs[0].data().createdAt, d);
});

test('journalMarksFromUserRows: 사용자별 자국을 평평하게 펴고 제외 UID 를 거른다', () => {
    const rows = [
        { userId: 'u1', journal: [{ d: '2026-03-08', r: '2026-03-08T10:00:00.000Z' }, { d: '2026-03-09', r: '' }] },
        { userId: 'bad', journal: [{ d: '2026-03-08', r: '' }] },
        { userId: 'u2', journal: [{ d: '깨진값', r: '' }] },
        { userId: 'u3' }
    ];
    const got = journalMarksFromUserRows(rows, new Set(['bad']));
    assert.deepEqual(got, [
        { uid: 'u1', dateStr: '2026-03-08', recordedAt: '2026-03-08T10:00:00.000Z' },
        { uid: 'u1', dateStr: '2026-03-09', recordedAt: '' }
    ]);
});

const usageDoc = (id, data) => ({ id, exists: () => true, data: () => data });

test('indexDocsById / docOrMissing: 없는 날짜는 「빈 문서」로 — 서버의 exists() false 자리', () => {
    const map = indexDocsById([usageDoc('2026-03-08', { tab_a: 3 }), null, { id: '' }]);
    assert.equal(map.size, 1);
    assert.equal(docOrMissing(map, '2026-03-08').data().tab_a, 3);

    const missing = docOrMissing(map, '2026-03-09');
    assert.equal(missing.exists(), false);
    assert.deepEqual(missing.data(), {});
});

test('filterDocsByIdRange: usageDaily 는 문서 id 가 날짜라 id 로 자른다 (경계 포함)', () => {
    const docs = ['2026-03-07', '2026-03-08', '2026-08-28', '2026-08-29'].map((id) => usageDoc(id, {}));
    const got = filterDocsByIdRange(docs, '2026-03-08', '2026-08-28').map((d) => d.id);
    assert.deepEqual(got, ['2026-03-08', '2026-08-28']);
    // 오늘보다 뒤(기기 시계가 앞선 기록)는 서버 쿼리와 마찬가지로 뺀다
    assert.equal(filterDocsByIdRange(docs, '2026-03-08', '2026-08-28').length, 2);
});
