// 대시보드 드릴다운: 구간별 출석 → 지속/이탈 판정
//
// 이 계산이 틀리면 표는 아무 경고 없이 그럴듯하게 그려진다. 이탈자가 지속 사용자로
// 둔갑하는 오프바이원을 잡는 것이 목적이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    unionOfPeriods,
    buildMatrixRow,
    sortMatrixRows,
    sortListRows,
    summarizeMatrix,
    decodeProfileStore,
    encodeProfileStore
} from '../js/admin/dashboard-drilldown-model.js';

/** @param {string} key @param {string[]} active @param {string[]} fresh */
const P = (key, active, fresh = []) => ({
    key,
    label: key,
    active: new Set(active),
    new: new Set(fresh)
});

test('unionOfPeriods 는 구간을 가로질러 유니크로 합친다 (주간 합이 아니다)', () => {
    const periods = [P('w1', ['a', 'b'], ['a']), P('w2', ['b', 'c'], ['c'])];
    const { active, fresh } = unionOfPeriods(periods);
    assert.deepEqual([...active].sort(), ['a', 'b', 'c']);
    assert.equal(active.size, 3, '주간 합 4가 아니라 유니크 3이어야 한다');
    assert.deepEqual([...fresh].sort(), ['a', 'c']);
});

test('마지막 구간에 활동이 있으면 지속(kept), gap 은 0', () => {
    const periods = [P('w1', ['a']), P('w2', []), P('w3', ['a'])];
    const r = buildMatrixRow('a', periods, { nickname: '가' }, '2026-08-01', false);
    assert.equal(r.status, 'kept');
    assert.equal(r.gap, 0);
    assert.equal(r.activeCount, 2, '중간에 쉬어도 활동 횟수는 2');
});

test('마지막 구간부터 연속으로 비면 그 칸 수가 gap 이다', () => {
    const periods = [P('w1', ['a']), P('w2', ['a']), P('w3', []), P('w4', [])];
    const r = buildMatrixRow('a', periods, null, '', false);
    assert.equal(r.status, 'gap');
    assert.equal(r.gap, 2);
    assert.equal(r.activeCount, 2);
});

test('마지막 한 칸만 비어도 이탈 신호로 잡는다 (오프바이원)', () => {
    const periods = [P('w1', ['a']), P('w2', ['a']), P('w3', [])];
    const r = buildMatrixRow('a', periods, null, '', false);
    assert.equal(r.status, 'gap');
    assert.equal(r.gap, 1);
});

test('한 번도 활동이 없으면 「끊겼다」가 아니라 「시작을 안 했다」(none, gap 0)', () => {
    const periods = [P('w1', [], ['a']), P('w2', []), P('w3', [])];
    const r = buildMatrixRow('a', periods, null, '2026-08-02', true);
    assert.equal(r.status, 'none');
    assert.equal(r.activeCount, 0);
    assert.equal(r.gap, 0, 'gap 을 3으로 두면 「3주째 없음」이라는 오해를 부른다');
    assert.equal(r.isNew, true);
});

test('가입 구간은 marks.joined 로 표시된다', () => {
    const periods = [P('w1', [], []), P('w2', ['a'], ['a']), P('w3', ['a'])];
    const r = buildMatrixRow('a', periods, null, '2026-08-09', true);
    assert.deepEqual(
        r.marks.map((m) => [m.active, m.joined]),
        [
            [false, false],
            [true, true],
            [true, false]
        ]
    );
});

test('정렬: 가입이 오래된 사람부터 (상태와 무관)', () => {
    const periods = [P('w1', ['old', 'mid']), P('w2', ['new'])];
    const rows = [
        buildMatrixRow('new', periods, null, '2026-08-09', true),
        buildMatrixRow('old', periods, null, '2026-03-10', false),
        buildMatrixRow('mid', periods, null, '2026-06-01', false)
    ];
    assert.deepEqual(
        sortMatrixRows(rows).map((r) => r.uid),
        ['old', 'mid', 'new'],
        '「계속」인 new 가 위로 올라오면 안 된다 — 정렬 기준은 가입일뿐이다'
    );
});

test('정렬: 가입일이 없는 사용자는 맨 아래 (빈 문자열이 최고참 행세를 못하게)', () => {
    const periods = [P('w1', ['a', 'b'])];
    const rows = [
        buildMatrixRow('nojoin', periods, null, '', false),
        buildMatrixRow('a', periods, null, '2026-05-01', false),
        buildMatrixRow('b', periods, null, '2026-04-01', false)
    ];
    assert.deepEqual(
        sortMatrixRows(rows).map((r) => r.uid),
        ['b', 'a', 'nojoin']
    );
});

test('정렬: 같은 날 가입은 닉네임순으로 안정되게', () => {
    const periods = [P('w1', ['x', 'y'])];
    const rows = [
        buildMatrixRow('y', periods, { nickname: '나' }, '2026-08-01', false),
        buildMatrixRow('x', periods, { nickname: '가' }, '2026-08-01', false)
    ];
    assert.deepEqual(
        sortMatrixRows(rows).map((r) => r.uid),
        ['x', 'y']
    );
});

test('summarizeMatrix 는 상태별 인원과 합계를 센다', () => {
    const periods = [P('w1', ['keep', 'gone']), P('w2', ['keep'])];
    const rows = ['keep', 'gone', 'never'].map((u) => buildMatrixRow(u, periods, null, '', false));
    assert.deepEqual(summarizeMatrix(rows), { kept: 1, gap: 1, none: 1, total: 3 });
});

test('명단 정렬: 신규 먼저, 그다음 가입일 최신순', () => {
    const rows = [
        { uid: 'old', isNew: false, joinKey: '2026-05-01' },
        { uid: 'new-old', isNew: true, joinKey: '2026-08-01' },
        { uid: 'old-recent', isNew: false, joinKey: '2026-07-01' },
        { uid: 'new-recent', isNew: true, joinKey: '2026-08-09' }
    ];
    assert.deepEqual(
        sortListRows(rows).map((r) => r.uid),
        ['new-recent', 'new-old', 'old-recent', 'old']
    );
});

// ------------------------------------------------------------
// 닉네임 캐시 직렬화
// ------------------------------------------------------------

const NOW = 1_800_000_000_000;
const TTL = 3 * 24 * 60 * 60 * 1000;

test('decodeProfileStore: 만료 안 된 항목만 되살린다', () => {
    const raw = JSON.stringify({
        fresh: { n: '최근', i: '🐻', t: NOW - 1000 },
        stale: { n: '오래됨', i: '🐰', t: NOW - TTL - 1 }
    });
    const m = decodeProfileStore(raw, NOW, TTL);
    assert.deepEqual([...m.keys()], ['fresh']);
    assert.equal(m.get('fresh').nickname, '최근');
});

test('decodeProfileStore: 경계값(정확히 TTL)은 살린다', () => {
    const raw = JSON.stringify({ edge: { n: '경계', i: '🐻', t: NOW - TTL } });
    assert.equal(decodeProfileStore(raw, NOW, TTL).size, 1);
});

test('decodeProfileStore: 미래 시각 항목은 버린다 (시계가 되감긴 기기)', () => {
    const raw = JSON.stringify({ future: { n: '미래', i: '🐻', t: NOW + 60_000 } });
    assert.equal(decodeProfileStore(raw, NOW, TTL).size, 0);
});

test('decodeProfileStore: 깨진 입력에도 빈 Map 을 준다', () => {
    for (const raw of [null, '', '{', '[]', 'null', '"x"']) {
        assert.equal(decodeProfileStore(raw, NOW, TTL).size, 0, `입력: ${raw}`);
    }
    const junk = JSON.stringify({ a: null, b: 3, c: { n: '', t: NOW }, d: { n: '이름' } });
    assert.equal(decodeProfileStore(junk, NOW, TTL).size, 0);
});

test('decodeProfileStore: 아이콘이 없으면 기본값으로 채운다', () => {
    const raw = JSON.stringify({ u: { n: '이름', t: NOW } });
    assert.equal(decodeProfileStore(raw, NOW, TTL).get('u').icon, '🐻');
});

test('encodeProfileStore: 최근 것부터 cap 개까지만 남긴다', () => {
    const cache = new Map([
        ['old', { nickname: 'A', icon: '🐻', t: 1 }],
        ['mid', { nickname: 'B', icon: '🐰', t: 2 }],
        ['new', { nickname: 'C', icon: '🐱', t: 3 }]
    ]);
    assert.deepEqual(Object.keys(encodeProfileStore(cache, 2)).sort(), ['mid', 'new']);
    assert.deepEqual(encodeProfileStore(cache, 0), {});
});

test('encodeProfileStore: t 가 없는 항목(조회 실패 등)은 저장하지 않는다', () => {
    const cache = new Map([
        ['ok', { nickname: 'A', icon: '🐻', t: 5 }],
        ['nots', { nickname: '조회 실패', icon: '👤' }]
    ]);
    assert.deepEqual(Object.keys(encodeProfileStore(cache, 10)), ['ok']);
});

test('encode → decode 왕복에서 값이 보존된다', () => {
    const cache = new Map([['u1', { nickname: '홍길동', icon: '🐰', t: NOW }]]);
    const back = decodeProfileStore(JSON.stringify(encodeProfileStore(cache, 10)), NOW, TTL);
    assert.deepEqual(back.get('u1'), { nickname: '홍길동', icon: '🐰', t: NOW });
});

test('빈 구간 목록에서도 터지지 않는다', () => {
    assert.deepEqual(unionOfPeriods(null), { active: new Set(), fresh: new Set() });
    const r = buildMatrixRow('a', [], null, '', false);
    assert.equal(r.status, 'none');
    assert.deepEqual(r.marks, []);
    assert.deepEqual(summarizeMatrix([]), { kept: 0, gap: 0, none: 0, total: 0 });
});
