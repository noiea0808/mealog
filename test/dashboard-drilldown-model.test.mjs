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
    heatLevel,
    maxMarkCount,
    buildCohortTable,
    decodeProfileStore,
    encodeProfileStore
} from '../js/admin/dashboard-drilldown-model.js';

/** counts 없는 구간 (이 기능 이전에 저장된 문서) */
const P = (key, active, fresh = []) => ({
    key,
    label: key,
    active: new Set(active),
    new: new Set(fresh),
    counts: null
});

/** counts 있는 구간 — counts 로 active 를 유도한다 */
const PC = (key, counts, fresh = []) => ({
    key,
    label: key,
    active: new Set(Object.keys(counts).filter((u) => counts[u] > 0)),
    new: new Set(fresh),
    counts
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
// 칸 수치와 농도
// ------------------------------------------------------------

test('marks.count 는 그 구간의 기록 수를 담는다', () => {
    const periods = [PC('w1', { a: 5, b: 1 }), PC('w2', { a: 7 })];
    const r = buildMatrixRow('a', periods, null, '2026-08-01', false);
    assert.deepEqual(
        r.marks.map((m) => m.count),
        [5, 7]
    );
    assert.equal(r.activeCount, 2);
});

test('그 구간에 기록이 없으면 count 는 0', () => {
    const periods = [PC('w1', { a: 3 }), PC('w2', { b: 2 })];
    const r = buildMatrixRow('a', periods, null, '', false);
    assert.deepEqual(
        r.marks.map((m) => m.count),
        [3, 0]
    );
    assert.equal(r.status, 'gap');
});

test('예전 문서(counts 없음)는 count 가 null — 0 으로 채우면 활성자가 결번처럼 보인다', () => {
    const periods = [P('w1', ['a']), P('w2', ['a'])];
    const r = buildMatrixRow('a', periods, null, '', false);
    assert.deepEqual(
        r.marks.map((m) => m.count),
        [null, null]
    );
    assert.equal(r.activeCount, 2, 'count 가 없어도 활성 여부와 지속 판정은 그대로다');
    assert.equal(r.status, 'kept');
});

test('counts 가 있어도 숫자가 깨졌으면 0 으로 (null 과 구분)', () => {
    const periods = [{ key: 'w', label: 'w', active: new Set(['a']), new: new Set(), counts: { a: 'x' } }];
    assert.equal(buildMatrixRow('a', periods, null, '', false).marks[0].count, 0);
});

test('heatLevel: 표 최대값 대비 비율로 4단계 (주차 7일·일자 건수 공용)', () => {
    assert.equal(heatLevel(7, 7), 4);
    assert.equal(heatLevel(6, 7), 4, '6/7 = 0.86 — 상위 구간');
    assert.equal(heatLevel(4, 7), 3, '4/7 = 0.57');
    assert.equal(heatLevel(3, 7), 2, '3/7 = 0.43');
    assert.equal(heatLevel(1, 7), 1, '1/7 = 0.14 — 하한도 0 이 아니라 1');
    assert.equal(heatLevel(0, 7), 0, '0 은 칠하지 않는다');
    assert.equal(heatLevel(null, 7), 0);
    assert.equal(heatLevel(2, 2), 4, '최대값이 작아도 최상위 단계가 나온다');
    assert.equal(heatLevel(3, 0), 1, '최대값이 0이면(있을 수 없지만) 최하위로 안전하게');
});

test('maxMarkCount 는 표 전체의 최대 칸 값 (null 은 무시)', () => {
    const periods = [PC('w1', { a: 2, b: 9 }), PC('w2', { a: 4 })];
    const rows = ['a', 'b'].map((u) => buildMatrixRow(u, periods, null, '', false));
    assert.equal(maxMarkCount(rows), 9);
    assert.equal(maxMarkCount([buildMatrixRow('a', [P('w', ['a'])], null, '', false)]), 0);
    assert.equal(maxMarkCount([]), 0);
});

// ------------------------------------------------------------
// 코호트 리텐션
// ------------------------------------------------------------

const WK = ['2026-03-08', '2026-03-15', '2026-03-22'];

test('코호트: 가입 주차별 행, 경과 주차별 열로 삼각형이 된다', () => {
    const t = buildCohortTable({
        weekKeys: WK,
        joinKeyByUid: { a: '2026-03-10', b: '2026-03-12', c: '2026-03-17' },
        activeSetsByWeek: [new Set(['a', 'b']), new Set(['a', 'c']), new Set(['a'])]
    });
    assert.equal(t.rows.length, 2, '가입자가 없는 3/22 주는 행이 안 생긴다');
    assert.equal(t.maxSpan, 3);

    const [c1, c2] = t.rows;
    assert.equal(c1.weekKey, '2026-03-08');
    assert.equal(c1.size, 2, 'a·b 가 첫 주 코호트');
    assert.deepEqual(
        c1.cells.map((c) => c.active),
        [2, 1, 1],
        'W0=a,b / W1=a / W2=a'
    );
    assert.equal(c1.cells[0].rate, 1);
    assert.equal(c1.cells[1].rate, 0.5);

    assert.equal(c2.size, 1, 'c 만 둘째 주 코호트');
    assert.equal(c2.cells.length, 2, '둘째 주 가입은 열이 2개까지만 (아직 안 온 주는 없다)');
    assert.deepEqual(
        c2.cells.map((c) => c.active),
        [1, 0]
    );
});

test('코호트: 가입일이 정확히 주 시작일이면 그 주 코호트', () => {
    const t = buildCohortTable({
        weekKeys: WK,
        joinKeyByUid: { edge: '2026-03-15' },
        activeSetsByWeek: [new Set(), new Set(['edge']), new Set()]
    });
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].weekKey, '2026-03-15');
    assert.equal(t.rows[0].cells[0].rate, 1, '가입 주에 활동 → W0 100%');
});

test('코호트: 집계 시작 이전 가입자와 가입일 없는 사용자는 따로 센다', () => {
    const t = buildCohortTable({
        weekKeys: WK,
        joinKeyByUid: { before: '2026-01-01', nojoin: '', ok: '2026-03-09' },
        activeSetsByWeek: [new Set(['before', 'ok']), new Set(), new Set()]
    });
    assert.equal(t.excludedBefore, 1);
    assert.equal(t.excludedNoJoin, 1);
    assert.equal(t.rows.length, 1);
    assert.equal(t.rows[0].size, 1, '코호트 인원에 범위 밖 사용자가 섞이면 잔존율이 왜곡된다');
});

test('코호트: 열별 가중 평균과 참여 코호트 수', () => {
    const t = buildCohortTable({
        weekKeys: WK,
        joinKeyByUid: { a: '2026-03-09', b: '2026-03-09', c: '2026-03-16' },
        activeSetsByWeek: [new Set(['a', 'b']), new Set(['a', 'c']), new Set()]
    });
    // W0: (a,b 중 2) + (c 중 1) = 3 / 3
    assert.equal(t.totals[0].rate, 1);
    assert.equal(t.totals[0].cohorts, 2);
    // W1: a 만 = 1 / (2 + 1) — 두 코호트 모두 W1 을 가진다
    assert.equal(t.totals[1].active, 1);
    assert.equal(t.totals[1].size, 3);
    assert.equal(t.totals[1].cohorts, 2);
    // W2: 첫 코호트만 참여
    assert.equal(t.totals[2].cohorts, 1);
});

test('코호트: 주차 목록이 비면 빈 결과', () => {
    const t = buildCohortTable({ weekKeys: [], joinKeyByUid: { a: '2026-03-09' }, activeSetsByWeek: [] });
    assert.deepEqual(t.rows, []);
    assert.equal(t.maxSpan, 0);
});

test('코호트: activeSets 가 모자라도 터지지 않는다 (0으로 본다)', () => {
    const t = buildCohortTable({
        weekKeys: WK,
        joinKeyByUid: { a: '2026-03-09' },
        activeSetsByWeek: [new Set(['a'])]
    });
    assert.deepEqual(
        t.rows[0].cells.map((c) => c.active),
        [1, 0, 0]
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
