// 관리자 대시보드 증분 집계: 얼린 과거 + 소급 delta + 다시 센 최근 구간
//
// 이 병합이 틀리면 표는 조용히 틀린 숫자를 보여준다. 특히 위험한 둘을 노린다:
// (1) 다시 세는 구간에 소급분을 또 더해 이중으로 세는 것,
// (2) 다시 세는 구간을 좁게 잡아 「최근 7일」이나 이번 주 칸이 캐시에 갇히는 것.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addDaysToDateKey,
    rescanStartDateKey,
    rescanFromWeekIndex,
    mergeWeeklyArray,
    mergeWeeklyMap,
    isRetroactive,
    canUseIncremental,
    mergeUniqueArray,
    totalWithOutsideWeeks,
    needsWeeklyFullRefresh
} from '../js/admin/dashboard-incremental.js';

const WEEKS = [
    { sundayKey: '2026-08-02' },
    { sundayKey: '2026-08-09' },
    { sundayKey: '2026-08-16' },
    { sundayKey: '2026-08-23' }
];

test('날짜 키에 일수를 더한다 (월 경계 포함)', () => {
    assert.equal(addDaysToDateKey('2026-08-26', -6), '2026-08-20');
    assert.equal(addDaysToDateKey('2026-09-02', -6), '2026-08-27');
    assert.equal(addDaysToDateKey('2026-03-01', -1), '2026-02-28');
    assert.equal(addDaysToDateKey('bad', -1), '');
});

test('다시 세는 구간은 이번 주와 최근 7일 중 이른 쪽부터다', () => {
    // 수요일: 최근 7일이 지난 주 목요일까지 뻗는다 → 최근 7일이 이르다
    assert.equal(rescanStartDateKey('2026-08-26', '2026-08-23'), '2026-08-20');
    // 일요일: 이번 주는 하루뿐이라 최근 7일이 훨씬 넓다
    assert.equal(rescanStartDateKey('2026-08-23', '2026-08-23'), '2026-08-17');
    // 토요일: 이번 주 일요일이 정확히 6일 전 → 둘이 같은 날
    assert.equal(rescanStartDateKey('2026-08-29', '2026-08-23'), '2026-08-23');
});

test('다시 세는 구간이 속한 주차 인덱스를 찾는다', () => {
    assert.equal(rescanFromWeekIndex(WEEKS, '2026-08-20'), 2); // 08-16 주
    assert.equal(rescanFromWeekIndex(WEEKS, '2026-08-23'), 3);
    assert.equal(rescanFromWeekIndex(WEEKS, '2026-08-02'), 0);
    assert.equal(rescanFromWeekIndex(WEEKS, '2026-08-29'), 3); // 마지막 주 이후도 마지막 주로
});

test('구간을 못 찾으면 전 구간을 다시 센다 (틀린 숫자보다 낫다)', () => {
    assert.equal(rescanFromWeekIndex(WEEKS, '2026-07-01'), 0);
    assert.equal(rescanFromWeekIndex([], '2026-08-20'), 0);
    assert.equal(rescanFromWeekIndex(WEEKS, ''), 0);
});

test('경계 앞은 캐시+소급, 경계부터는 다시 센 값으로 덮는다', () => {
    const cached = [10, 20, 30, 40];
    const rescanned = [0, 0, 33, 44];
    const retro = [1, 2, 99, 99]; // 경계 이후의 소급값은 무시돼야 한다
    assert.deepEqual(mergeWeeklyArray(cached, rescanned, retro, 2, 4), [11, 22, 33, 44]);
});

test('다시 세는 구간에는 소급분을 더하지 않는다 — 이중 계산 방지', () => {
    // 오늘 적고 오늘 먹은 기록은 rescanned 에 이미 들어 있다
    const merged = mergeWeeklyArray([0, 0], [0, 7], [0, 7], 1, 2);
    assert.equal(merged[1], 7, '다시 센 값에 소급분이 또 더해졌다');
});

test('캐시가 비어도 소급분만으로 과거 칸을 채운다', () => {
    assert.deepEqual(mergeWeeklyArray(null, [0, 0, 5], [3, 0, 0], 2, 3), [3, 0, 5]);
});

test('캐시가 이번 주차보다 짧아도 길이를 맞춘다 (주가 하나 늘어난 날)', () => {
    // 캐시는 3주치인데 이번엔 4주 — 마지막 칸은 다시 센 값으로 채워진다
    assert.deepEqual(mergeWeeklyArray([1, 2, 3], [0, 0, 0, 9], [0, 0, 0, 0], 3, 4), [1, 2, 3, 9]);
});

test('슬롯·시간대 맵을 통째로 병합하고, 캐시에 없던 키도 자리를 만든다', () => {
    const out = mergeWeeklyMap(
        ['morning', 'lunch', 'h12'],
        { morning: [1, 1], lunch: [2, 2] },
        { morning: [0, 5], lunch: [0, 6], h12: [0, 7] },
        { morning: [3, 0], lunch: [0, 0], h12: [0, 0] },
        1,
        2
    );
    assert.deepEqual(out.morning, [4, 5]);
    assert.deepEqual(out.lunch, [2, 6]);
    assert.deepEqual(out.h12, [0, 7], '캐시에 없던 시간대 키가 0으로 시작하지 않았다');
});

test('소급 판정은 다시 세는 구간 밖일 때만 참', () => {
    assert.equal(isRetroactive('2026-07-29', '2026-08-20'), true);
    assert.equal(isRetroactive('2026-08-20', '2026-08-20'), false, '경계 당일은 다시 세는 구간이다');
    assert.equal(isRetroactive('2026-08-26', '2026-08-20'), false);
    assert.equal(isRetroactive('', '2026-08-20'), false);
    assert.equal(isRetroactive('2026-07-29', ''), false);
});

test('증분을 쓸 수 없는 상태를 가려낸다', () => {
    const good = { lastAggregatedAt: '2026-08-26T01:00:00.000Z', weeklyBreakdown: { weeks: WEEKS.slice(0, 3) } };
    assert.equal(canUseIncremental(good, WEEKS).ok, true);

    assert.equal(canUseIncremental(null, WEEKS).reason, 'no-cache');
    assert.equal(canUseIncremental({ weeklyBreakdown: { weeks: WEEKS } }, WEEKS).reason, 'no-last-aggregated-at');
    assert.equal(
        canUseIncremental({ lastAggregatedAt: 'nope', weeklyBreakdown: { weeks: WEEKS } }, WEEKS).reason,
        'bad-last-aggregated-at'
    );
    assert.equal(
        canUseIncremental({ lastAggregatedAt: '2026-08-26T01:00:00.000Z' }, WEEKS).reason,
        'no-cached-weeks'
    );
});

test('주차 구성이 어긋나면 증분을 포기한다 (운영 시작일이 바뀐 경우 등)', () => {
    const shifted = {
        lastAggregatedAt: '2026-08-26T01:00:00.000Z',
        weeklyBreakdown: { weeks: [{ sundayKey: '2026-07-26' }, { sundayKey: '2026-08-02' }] }
    };
    assert.equal(canUseIncremental(shifted, WEEKS).reason, 'week-mismatch');

    const longer = {
        lastAggregatedAt: '2026-08-26T01:00:00.000Z',
        weeklyBreakdown: { weeks: [...WEEKS, { sundayKey: '2026-08-30' }] }
    };
    assert.equal(canUseIncremental(longer, WEEKS).reason, 'cached-weeks-longer');
});

test('유니크 값은 더하지 않고 구간만 갈아 끼운다', () => {
    // 활성 사용자·공유 게시물처럼 「사람 수」인 값은 캐시에 더하면 같은 사람을 두 번 센다
    assert.deepEqual(mergeUniqueArray([5, 6, 7], [0, 0, 9], 2, 3), [5, 6, 9]);
    assert.deepEqual(mergeUniqueArray(null, [1, 2], 0, 2), [1, 2], '전 구간 재계산이면 계산값만 쓴다');
});

test('유니크 병합은 캐시가 짧아도 길이를 맞춘다', () => {
    assert.deepEqual(mergeUniqueArray([3], [0, 0, 4], 2, 3), [3, 0, 4]);
});

test('「전체」는 주차 밖 몫을 캐시에서 되찾아 더한다', () => {
    // 캐시: 전체 500명, 주차 합 480명 → 주차 밖(운영 시작 전 가입) 20명
    assert.equal(totalWithOutsideWeeks(485, 500, 480), 505);
});

test('캐시가 주차 합보다 작으면 음수를 더하지 않는다', () => {
    // 캐시가 어그러져 있어도 「전체」가 주차 합보다 작아지지는 않게 한다
    assert.equal(totalWithOutsideWeeks(100, 10, 480), 100);
    assert.equal(totalWithOutsideWeeks(100, undefined, undefined), 100);
});

test('주간 정기 재집계는 주가 바뀌었을 때만 돈다', () => {
    const iso = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).toISOString();
    // 이번 주 일요일이 08-23 일 때
    assert.equal(needsWeeklyFullRefresh(iso(2026, 8, 24), '2026-08-23'), false, '이번 주에 이미 돌았다');
    assert.equal(needsWeeklyFullRefresh(iso(2026, 8, 23), '2026-08-23'), false, '주 첫날도 이번 주다');
    assert.equal(needsWeeklyFullRefresh(iso(2026, 8, 22), '2026-08-23'), true, '지난 주면 다시 돈다');
});

test('한 번도 안 돌았거나 값이 깨졌으면 재집계한다', () => {
    assert.equal(needsWeeklyFullRefresh(null, '2026-08-23'), true);
    assert.equal(needsWeeklyFullRefresh('', '2026-08-23'), true);
    assert.equal(needsWeeklyFullRefresh('nope', '2026-08-23'), true);
});

test('이번 주 일요일을 모르면 함부로 돌리지 않는다', () => {
    // 기준이 없는데 12,800 읽기를 시작하는 편보다, 아무것도 안 하는 편이 안전하다
    assert.equal(needsWeeklyFullRefresh(null, ''), false);
});
