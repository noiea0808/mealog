// 트렌드 표 시간대 행: 기록의 시각 → 3시간 버킷
//
// 이 계산이 틀려도 표는 아무 경고 없이 그럴듯하게 그려진다. 경계에서 한 칸 밀리거나
// 시각 없는 기록이 특정 구간으로 쓸려 들어가는 것을 잡는 것이 목적이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    HOUR_BUCKETS,
    hourBucketIdFromHour,
    hourBucketIdFromMealTime,
    hourSlotForMealDoc,
    hourSlotForJournalEntry
} from '../js/admin/dashboard-hour-buckets.js';

test('24시간이 미상을 뺀 8구간에 빠짐없이, 한 번씩만 들어간다', () => {
    const counts = new Map(HOUR_BUCKETS.map((b) => [b.id, 0]));
    for (let h = 0; h < 24; h++) {
        const id = hourBucketIdFromHour(h);
        assert.notEqual(id, null, `${h}시가 어느 버킷에도 안 들어간다`);
        counts.set(id, counts.get(id) + 1);
    }
    assert.equal(counts.get('unknown'), 0);
    for (const b of HOUR_BUCKETS) {
        if (b.id === 'unknown') continue;
        assert.equal(counts.get(b.id), 3, `${b.label}에 ${counts.get(b.id)}시간이 들어갔다`);
    }
});

test('구간 경계는 시작 시각을 포함하고 끝 시각은 다음 구간으로 넘긴다', () => {
    assert.equal(hourBucketIdFromHour(0), 'h00');
    assert.equal(hourBucketIdFromHour(2), 'h00');
    assert.equal(hourBucketIdFromHour(3), 'h03');
    assert.equal(hourBucketIdFromHour(23), 'h21');
});

test('범위 밖·정수 아닌 시각은 버킷이 없다', () => {
    for (const bad of [-1, 24, 1.5, NaN, null, undefined, '3']) {
        assert.equal(hourBucketIdFromHour(bad), null, `${String(bad)}가 버킷을 받았다`);
    }
});

test('meals.time을 앞자리 시각으로 읽는다 (한 자리 시각 포함)', () => {
    assert.equal(hourBucketIdFromMealTime('00:00:00'), 'h00');
    assert.equal(hourBucketIdFromMealTime('09:30:12'), 'h09');
    assert.equal(hourBucketIdFromMealTime('9:30'), 'h09');
    assert.equal(hourBucketIdFromMealTime(' 23:59:59 '), 'h21');
});

test('시각이 없거나 형식이 깨진 기록은 밤으로 쓸리지 않고 미상으로 남는다', () => {
    for (const bad of ['', '   ', 'abc', '::', null, undefined, 123, {}]) {
        assert.equal(hourBucketIdFromMealTime(bad), 'unknown', `${String(bad)}가 미상이 아니다`);
    }
    // 24시·99시 같은 값도 임의 구간에 밀어 넣지 않는다
    assert.equal(hourBucketIdFromMealTime('24:00:00'), 'unknown');
    assert.equal(hourBucketIdFromMealTime('99:00:00'), 'unknown');
});

/** 로컬 시각으로 ISO 생성 — 테스트가 실행 환경 타임존에 흔들리지 않게 */
const iso = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0).toISOString();

test('기록 시각은 recordedAt에서 날짜와 시각을 함께 뽑는다', () => {
    const slot = hourSlotForMealDoc({ date: '2026-08-25', time: '08:00:00', recordedAt: iso(2026, 8, 26, 14, 5) });
    assert.deepEqual(slot, { dateKey: '2026-08-26', bucketId: 'h12' });
});

test('어제 끼니를 오늘 밤에 적으면 시간대 축은 오늘 칸으로 간다', () => {
    // 이 어긋남이 「기록 시각별」합계와 끼니 행 합계를 벌리는 원인이다
    const slot = hourSlotForMealDoc({ date: '2026-08-25', time: '19:30:00', recordedAt: iso(2026, 8, 26, 23, 10) });
    assert.equal(slot.dateKey, '2026-08-26');
    assert.equal(slot.bucketId, 'h21');
});

test('recordedAt이 없는 옛 문서는 식사 날짜 + time으로 근사한다', () => {
    const slot = hourSlotForMealDoc({ date: '2026-08-25', time: '07:45:00' });
    assert.deepEqual(slot, { dateKey: '2026-08-25', bucketId: 'h06' });
});

test('하루 소감 미러는 time의 23:59 폴백을 쓰지 않는다', () => {
    // recordedAt 없는 미러의 time 은 '23:59' 로 박혀 있어, 그대로 쓰면 밤이 부푼다
    const slot = hourSlotForMealDoc({ date: '2026-08-25', time: '23:59', slotId: 'daily_journal' });
    assert.deepEqual(slot, { dateKey: '2026-08-25', bucketId: 'unknown' });
});

test('날짜조차 못 정하면 어느 칸에도 넣지 않는다', () => {
    for (const bad of [null, undefined, {}, { date: '' }, { date: '2026-8-5' }, { recordedAt: 'nope' }]) {
        assert.equal(hourSlotForMealDoc(bad), null, `${JSON.stringify(bad)}가 칸을 받았다`);
    }
});

test('깨진 recordedAt은 무시하고 식사 날짜로 폴백한다', () => {
    const slot = hourSlotForMealDoc({ date: '2026-08-25', time: '12:10:00', recordedAt: 'not-a-date' });
    assert.deepEqual(slot, { dateKey: '2026-08-25', bucketId: 'h12' });
});

test('하루 소감은 recordedAt이 있으면 그 시각, 없으면 소감 날짜 + 미상', () => {
    assert.deepEqual(
        hourSlotForJournalEntry('2026-08-25', { recordedAt: iso(2026, 8, 26, 1, 20) }),
        { dateKey: '2026-08-26', bucketId: 'h00' }
    );
    assert.deepEqual(
        hourSlotForJournalEntry('2026-08-25', { recordedAt: '' }),
        { dateKey: '2026-08-25', bucketId: 'unknown' }
    );
    assert.equal(hourSlotForJournalEntry('', {}), null);
});
