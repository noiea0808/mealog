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
    summarizeMatrix
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

test('정렬: 지속 → 중단(최근에 끊긴 순) → 기록 없음', () => {
    const periods = [P('w1', ['keep', 'gap1', 'gap2']), P('w2', ['keep', 'gap2']), P('w3', ['keep'])];
    const rows = ['keep', 'gap1', 'gap2', 'never'].map((u) =>
        buildMatrixRow(u, periods, null, '2026-08-01', false)
    );
    assert.deepEqual(
        sortMatrixRows(rows).map((r) => r.uid),
        ['keep', 'gap2', 'gap1', 'never'],
        'gap2(1주째 없음)가 gap1(2주째 없음)보다 위 — 최근 이탈을 먼저 보여 준다'
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

test('빈 구간 목록에서도 터지지 않는다', () => {
    assert.deepEqual(unionOfPeriods(null), { active: new Set(), fresh: new Set() });
    const r = buildMatrixRow('a', [], null, '', false);
    assert.equal(r.status, 'none');
    assert.deepEqual(r.marks, []);
    assert.deepEqual(summarizeMatrix([]), { kept: 0, gap: 0, none: 0, total: 0 });
});
