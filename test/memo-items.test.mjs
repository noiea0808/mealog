/**
 * 사용자 메모 항목의 계약 (docs/user-memo-items.md).
 *
 * 여기서 못박는 것:
 * 1. 메모가 섞여도 슬롯 쪽 계산이 흔들리지 않는다 — base 가 없는 항목이
 *    원본 판정·폴백 귀속에 끼어들면 슬롯 이름이 엉킨다.
 * 2. 정화는 슬롯 앞·메모 뒤로 안정 정렬하고, 아이콘을 화이트리스트로 자른다.
 * 3. 메모 이름도 절대 잃지 않는다 — 전 개정판 탐색 + retired 폴백.
 * 4. **메모는 묶이지 않는다** — 같은 항목의 다건이 각자의 자리를 갖는다(§3.2).
 * 5. 자리 계산(§3.3)은 "대표 시각 ≤ 메모 시각인 마지막 그룹 뒤" 한 문장이다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    sanitizeSlots,
    isMemoItem,
    memoIconOrDefault,
    slotItemsOnly,
    memoItemsOnly,
    countEnabledSlots,
    countMemos,
    originalSlotSet,
    oldestSlotForBase,
    resolveSlotView,
    findSlotByKey,
    withRevisionOn,
    renameSlotEverywhere,
    normalizeTimeKey,
    memoUnitsForDate,
    mergeMemoUnits,
    dayTimelineUnits,
    defaultSlotKey,
    withDefaultMemos,
    effectiveSlots,
    defaultMemoKey,
    defaultMemoItems,
    isDefaultMemoKey,
    defaultMemoItemByKey,
    MEMO_SLOT_ID,
    MEMO_LABEL_MAX_CHARS,
    DEFAULT_MEMO_ICON,
    MEMO_ICONS
} from '../js/utils/slot-plan.js';

const TODAY = '2026-09-10';

const memo = (key, label, icon = 'scale', enabled = true) => ({ key, kind: 'memo', icon, label, enabled });
const slot = (key, base, label, enabled = true) => ({ key, base, label, enabled });

function planWith(dateIso, slots) {
    return { schema: 1, revisions: { [dateIso]: { createdAt: 1, slots } } };
}

describe('정화 — 슬롯 앞, 메모 뒤', () => {
    it('메모를 살리고 슬롯 뒤로 안정 정렬한다', () => {
        const out = sanitizeSlots([
            memo('m1', '체중'),
            slot('s1', 'morning', '아침'),
            memo('m2', '혈당', 'droplet'),
            slot('s2', 'lunch', '점심')
        ]);
        assert.deepEqual(
            out.map((s) => s.label),
            ['아침', '점심', '체중', '혈당']
        );
        assert.equal(isMemoItem(out[2]), true);
        assert.equal(out[2].base, undefined, '메모에는 base 가 없다');
    });

    it('구버전이 쓴 임의 아이콘은 읽는 시점에 기본값으로 정화된다', () => {
        const out = sanitizeSlots([memo('m1', '체중', '"><script>')]);
        assert.equal(out[0].icon, DEFAULT_MEMO_ICON);
        assert.equal(memoIconOrDefault('scale'), 'scale');
        assert.equal(memoIconOrDefault(undefined), DEFAULT_MEMO_ICON);
        assert.ok(MEMO_ICONS.includes(DEFAULT_MEMO_ICON));
    });

    it('메모 이름은 8자에서 잘린다 — 슬롯의 12자와 다르다', () => {
        const out = sanitizeSlots([
            memo('m1', '아주아주아주아주긴이름'),
            slot('s1', 'morning', '열두자를넘기는아주긴이름입니다')
        ]);
        const m = out.find(isMemoItem);
        assert.equal(m.label.length, MEMO_LABEL_MAX_CHARS);
        assert.equal(out.find((s) => !isMemoItem(s)).label.length, 12);
    });

    it('key 중복은 종류를 가리지 않고 하나만 남는다', () => {
        const out = sanitizeSlots([slot('dup', 'morning', '아침'), memo('dup', '체중')]);
        assert.equal(out.length, 1);
    });
});

describe('메모는 슬롯 계산에 끼어들지 않는다', () => {
    const items = sanitizeSlots([
        slot(defaultSlotKey('dinner'), 'dinner', '저녁'),
        slot('zzz9', 'dinner', '야식'),
        memo('m1', '체중'),
        memo('m2', '혈당', 'droplet')
    ]);

    it('originalSlotSet 은 메모를 담지 않는다', () => {
        const originals = originalSlotSet(items);
        assert.equal(originals.size, 1);
        assert.equal([...originals][0].label, '저녁');
    });

    it('oldestSlotForBase 는 base 없는 항목을 집지 않는다', () => {
        assert.equal(oldestSlotForBase(items, undefined), null);
        assert.equal(oldestSlotForBase(items, 'dinner').label, '저녁');
    });

    it('상한은 따로 센다 — 메모가 슬롯 예산을 먹지 않는다', () => {
        assert.equal(countEnabledSlots(items), 2);
        assert.equal(countMemos(items), 2);
        assert.equal(slotItemsOnly(items).length, 2);
        assert.equal(memoItemsOnly(items).length, 2);
    });
});

describe('메모 이름도 절대 잃지 않는다', () => {
    const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), memo('m1', '체중')]) };

    it('key 로 찾으면 사용자가 지은 이름과 아이콘이 온다', () => {
        const v = resolveSlotView({ date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1' }, settings, TODAY);
        assert.equal(v.label, '체중');
        assert.equal(v.icon, 'scale');
        assert.equal(v.kind, 'memo');
        assert.equal(v.base, MEMO_SLOT_ID);
        assert.equal(v.matchedBy, 'key');
    });

    it('개정판에 없는 날짜의 기록도 같은 이름이다 — 날짜로 좁히지 않는다', () => {
        const v = resolveSlotView({ date: '2026-08-01', slotId: MEMO_SLOT_ID, slotKey: 'm1' }, settings, TODAY);
        assert.equal(v.label, '체중');
    });

    it('만든 날 지워도 retired 가 이름을 지킨다 — 개정판이 통째로 덮이는 경우', () => {
        // 다른 날짜에 지우면 앞 개정판에 key 가 살아 있어 retired 가 안 생긴다.
        // 위험한 것은 **같은 날짜 개정판을 덮어써서** key 가 증발하는 경로다 (§3.2).
        const next = withRevisionOn(
            settings.slotPlan,
            '2026-09-01',
            [slot(defaultSlotKey('lunch'), 'lunch', '점심')],
            2,
            () => 0.5,
            TODAY
        );
        assert.ok(next.retired && next.retired.m1, '폐기 이름이 남아야 한다');
        const found = findSlotByKey(next, 'm1', TODAY);
        assert.equal(found.label, '체중');
        assert.equal(found.icon, 'scale');
        const v = resolveSlotView({ date: '2026-09-06', slotId: MEMO_SLOT_ID, slotKey: 'm1' }, { slotPlan: next }, TODAY);
        assert.equal(v.label, '체중');
    });

    it('이름을 고치면 과거 기록에도 소급된다 (8자 상한으로 잘려서)', () => {
        const renamed = renameSlotEverywhere(settings.slotPlan, 'm1', '아침몸무게측정');
        const v = resolveSlotView({ date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1' }, { slotPlan: renamed }, TODAY);
        assert.equal(v.label, '아침몸무게측정');
        const long = renameSlotEverywhere(settings.slotPlan, 'm1', '아홉자가넘는이름이다');
        const v2 = resolveSlotView({ date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1' }, { slotPlan: long }, TODAY);
        assert.equal(v2.label.length, MEMO_LABEL_MAX_CHARS);
    });

    it('어디서도 못 찾아도 폴백은 성공한다', () => {
        const v = resolveSlotView({ date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'unknown' }, settings, TODAY);
        assert.equal(v.label, '메모');
        assert.equal(v.icon, DEFAULT_MEMO_ICON);
        assert.equal(v.matchedBy, 'default');
    });

    it('아이콘만 바꿔도 개정판이 새로 생긴다', () => {
        const next = withRevisionOn(
            settings.slotPlan,
            '2026-09-05',
            [slot(defaultSlotKey('lunch'), 'lunch', '점심'), memo('m1', '체중', 'droplet')],
            2,
            () => 0.5,
            TODAY
        );
        assert.notEqual(next, settings.slotPlan);
        assert.equal(next.revisions['2026-09-05'].slots.find(isMemoItem).icon, 'droplet');
    });

    it('안 바꾸면 개정판을 만들지 않는다 — 성장 억제는 메모에도 적용된다', () => {
        const same = withRevisionOn(
            settings.slotPlan,
            '2026-09-01',
            withDefaultMemos([slot(defaultSlotKey('lunch'), 'lunch', '점심'), memo('m1', '체중')]),
            2,
            () => 0.5,
            TODAY
        );
        assert.equal(same, settings.slotPlan);
    });
});

describe('메모는 묶이지 않는다 (§3.2)', () => {
    const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('morning'), 'morning', '아침'), memo('m1', '체중')]) };
    const history = [
        { id: 'a', date: '2026-09-05', slotId: 'morning', slotKey: defaultSlotKey('morning'), time: '07:00:00' },
        { id: 'w1', date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1', time: '07:30:00' },
        { id: 'w2', date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1', time: '21:10:00' }
    ];

    it('같은 항목 두 건이 두 단위로 나온다 — 한 그룹으로 접히지 않는다', () => {
        const units = memoUnitsForDate('2026-09-05', history, settings, TODAY);
        assert.equal(units.length, 2);
        assert.equal(units[0].record.id, 'w1');
        assert.equal(units[1].record.id, 'w2', '시간순으로 온다');
        assert.equal(units[0].slot.label, '체중');
        assert.equal(units[1].slot.label, '체중');
    });

    it('다른 날짜·다른 슬롯은 섞이지 않는다', () => {
        const units = memoUnitsForDate('2026-09-06', history, settings, TODAY);
        assert.equal(units.length, 0);
    });

    it('시각이 없는 메모는 하루의 끝으로 간다', () => {
        const units = memoUnitsForDate(
            '2026-09-05',
            [{ id: 'x', date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1' }],
            settings,
            TODAY
        );
        assert.equal(units[0].timeKey, '23:59:59');
    });
});

describe('자리 계산 (§3.3)', () => {
    /**
     * 사용자가 적은 시각은 `mealClock` 이다. `time` 은 시각을 안 적으면
     * 저장 순간이 들어가는 정렬용 필드라 자리 계산에 쓰지 않는다.
     */
    const g = (label, clocks, baseId = 'x') => ({
        slot: { id: baseId, type: 'main', label, key: `k-${label}` },
        records: clocks.map((c) => ({ mealClock: c, time: '14:22:00' }))
    });
    const groups = [g('아침', ['07:00']), g('오전 간식', ['10:20']), g('점심', ['12:00', '13:30']), g('저녁', ['19:00'])];
    const u = (label, timeKey) => ({ slot: { id: MEMO_SLOT_ID, type: 'memo', label, key: 'm1', icon: 'scale' }, record: { time: timeKey }, timeKey });

    const labels = (units) => units.map((x) => (x.type === 'memo' ? `[${x.slot.label}]` : x.slot.label));

    it('대표 시각 ≤ 메모 시각인 마지막 그룹 뒤', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('체중', '07:30:00')])), [
            '아침', '[체중]', '오전 간식', '점심', '저녁'
        ]);
    });

    it('가장 이른 기록보다 앞서면 맨 앞', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('체중', '06:40:00')])), [
            '[체중]', '아침', '오전 간식', '점심', '저녁'
        ]);
    });

    it('맨 뒤 그룹보다 늦으면 맨 뒤', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('운동', '21:00:00')])), [
            '아침', '오전 간식', '점심', '저녁', '[운동]'
        ]);
    });

    it('그룹 안은 가르지 않는다 — 점심 두 건 사이의 시각도 그룹 전체 뒤', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('혈당', '13:00:00')])), [
            '아침', '오전 간식', '점심', '저녁'
        ].flatMap((l) => (l === '점심' ? ['점심', '[혈당]'] : [l])));
    });

    it('같은 항목 두 건이 서로 다른 자리에 놓인다 — 이 기능의 핵심', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('체중', '07:30:00'), u('체중', '21:00:00')])), [
            '아침', '[체중]', '오전 간식', '점심', '저녁', '[체중]'
        ]);
    });

    it('같은 앵커에 여러 건이면 시간순으로 나란히', () => {
        assert.deepEqual(labels(mergeMemoUnits(groups, [u('체중', '07:10:00'), u('혈당', '07:50:00')])), [
            '아침', '[체중]', '[혈당]', '오전 간식', '점심', '저녁'
        ]);
    });

    it('그 날 슬롯 기록이 없으면 메모끼리 시간순', () => {
        assert.deepEqual(labels(mergeMemoUnits([], [u('체중', '07:30:00'), u('혈당', '09:00:00')])), [
            '[체중]', '[혈당]'
        ]);
    });

    it('시각도 슬롯도 못 읽는 그룹은 가장 이른 것으로 취급한다 — 메모가 그 뒤로 간다', () => {
        const broken = [{ slot: { id: 'x', type: 'main', label: '기록', key: 'k' }, records: [{ mealClock: null }] }];
        assert.deepEqual(labels(mergeMemoUnits(broken, [u('체중', '00:05:00')])), ['기록', '[체중]']);
    });

    /**
     * 실제로 물린 자리 — 시각을 안 적은 아침·점심을 오후 두 시에 몰아 적으면
     * 그 `time` 이 14시대가 된다. 그걸 대표 시각으로 쓰면 낮 한 시 반 운동이
     * 아침 **앞**에 서고, 화면에는 시각이 없으니 이유도 안 보인다.
     */
    it('저장 시각(time)은 자리를 정하지 않는다 — 오후에 몰아 적은 아침이 오후 끼니가 되면 안 된다', () => {
        const noClock = (label, baseId) => ({
            slot: { id: baseId, type: 'main', label, key: `k-${label}` },
            // 저장 순간이 들어간 time 만 있고 사용자가 고른 시각은 없다
            records: [{ mealClock: null, time: '14:22:00' }]
        });
        const day = [noClock('아침', 'morning'), noClock('점심', 'lunch')];
        assert.deepEqual(labels(mergeMemoUnits(day, [u('운동', '13:30:00')])), [
            '아침', '점심', '[운동]'
        ]);
    });

    it('시각을 안 적은 그룹은 그 슬롯이 뜻하는 시각으로 선다', () => {
        const day = [g('아침', [], 'morning'), g('점심', [], 'lunch'), g('저녁', [], 'dinner')];
        // 아침(08:00) 보다 이른 메모는 맨 앞
        assert.deepEqual(labels(mergeMemoUnits(day, [u('체중', '07:00:00')])), [
            '[체중]', '아침', '점심', '저녁'
        ]);
        // 점심(12:30)과 저녁(18:30) 사이
        assert.deepEqual(labels(mergeMemoUnits(day, [u('운동', '13:30:00')])), [
            '아침', '점심', '[운동]', '저녁'
        ]);
    });

    it('한 사람이 적은 시각이 있으면 그 시각이 이름값보다 우선한다', () => {
        // '점심'을 09:30 에 먹었다고 적었으면 10:00 메모는 그 뒤다
        const day = [g('아침', [], 'morning'), g('점심', ['09:30'], 'lunch')];
        assert.deepEqual(labels(mergeMemoUnits(day, [u('체중', '10:00:00')])), [
            '아침', '점심', '[체중]'
        ]);
    });

    it('normalizeTimeKey 는 자릿수와 초 유무를 흡수한다', () => {
        assert.equal(normalizeTimeKey('7:05'), '07:05:00');
        assert.equal(normalizeTimeKey('07:05:09'), '07:05:09');
        assert.equal(normalizeTimeKey('25:00'), '');
        assert.equal(normalizeTimeKey(undefined, '23:59:59'), '23:59:59');
    });
});

describe('dayTimelineUnits — 타임라인이 실제로 쓰는 순회', () => {
    const settings = {
        slotPlan: planWith('2026-09-01', [
            slot(defaultSlotKey('morning'), 'morning', '아침'),
            slot(defaultSlotKey('dinner'), 'dinner', '저녁'),
            memo('m1', '체중')
        ])
    };
    const history = [
        { id: 'a', date: '2026-09-05', slotId: 'morning', slotKey: defaultSlotKey('morning'), mealClock: '07:00', time: '07:00:00' },
        { id: 'd', date: '2026-09-05', slotId: 'dinner', slotKey: defaultSlotKey('dinner'), mealClock: '19:00', time: '19:00:00' },
        { id: 'w1', date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1', time: '07:30:00' },
        { id: 'w2', date: '2026-09-05', slotId: MEMO_SLOT_ID, slotKey: 'm1', time: '21:10:00' }
    ];

    it('슬롯 그룹과 메모 낱건이 한 줄로 섞인다', () => {
        const units = dayTimelineUnits('2026-09-05', history, settings, TODAY);
        assert.deepEqual(
            units.map((u) => `${u.type}:${u.slot.label}`),
            ['slot:아침', 'memo:체중', 'slot:저녁', 'memo:체중']
        );
    });

    it('메모가 없으면 슬롯 그룹만 나온다 — 기존 화면과 같다', () => {
        const units = dayTimelineUnits('2026-09-05', history.slice(0, 2), settings, TODAY);
        assert.deepEqual(units.map((u) => u.type), ['slot', 'slot']);
    });
});

describe('기본 메모 항목 (§2.6)', () => {
    it('개정판이 없어도 체중·운동·화장실·하루 소감이 켜진 채 순서대로 딸려 온다', () => {
        const items = effectiveSlots({}, '2026-09-05', TODAY);
        const memos = memoItemsOnly(items);
        const on = memos.filter((m) => m.enabled !== false);
        assert.deepEqual(on.map((m) => m.label), ['체중', '운동', '화장실', '하루 소감']);
        assert.equal(on[0].key, defaultMemoKey('weight'));
        assert.equal(on[0].unit, 'kg');
        // 체중만 숫자 메모다 — 나머지는 단위 필드 자체가 없다
        assert.equal('unit' in on[1], false);
        assert.equal('unit' in on[2], false);
        assert.equal('unit' in on[3], false, '하루 소감은 숫자 메모가 아니다');
    });

    /**
     * 혈당은 기본에서 내렸지만(§2.6) 정의는 남아 있어야 한다. 개정판을 한 번도
     * 저장하지 않은 채 혈당을 기록해 둔 사용자의 값이 '메모'로 떨어지고 단위가
     * 사라지면, 이미 적어 둔 숫자를 고칠 수 없게 된다.
     */
    /**
     * 혈당은 목록에 남되 꺼진 채로 깔린다. 빼버리면 (1) 피커에서 안 보이는 건
     * 같지만 메모 설정에서 켤 길이 없어지고, (2) 직접 만든 '혈당'은 새 key 라
     * 분석 차트에 영영 안 잡힌다.
     */
    it('혈당은 꺼진 채로 깔린다 — 피커에는 없지만 설정에서 켤 수 있다', () => {
        const memos = memoItemsOnly(effectiveSlots({}, '2026-09-05', TODAY));
        const bs = memos.find((m) => m.key === defaultMemoKey('bloodSugar'));
        assert.ok(bs, '목록에는 있어야 한다 — 켜는 길이 여기다');
        assert.equal(bs.enabled, false);
        assert.equal(bs.unit, 'mg/dL');
        // 피커는 enabled 로 거른다 (불변식 4)
        assert.equal(memos.filter((m) => m.enabled !== false).some((m) => m.label === '혈당'), false);

        const found = defaultMemoItemByKey(defaultMemoKey('bloodSugar'));
        assert.equal(found.label, '혈당');
        assert.equal(found.unit, 'mg/dL');

        const view = resolveSlotView(
            { slotId: MEMO_SLOT_ID, slotKey: defaultMemoKey('bloodSugar') },
            {},
            TODAY
        );
        assert.equal(view.label, '혈당');
        assert.equal(view.unit, 'mg/dL');
    });

    it('이미 개정판에 있는 혈당은 그대로 남는다 — 쓰던 사람에게서 사라지지 않는다', () => {
        const bs = { key: defaultMemoKey('bloodSugar'), kind: 'memo', icon: 'droplet', label: '혈당', unit: 'mg/dL', decimals: 0, enabled: true };
        const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), bs]) };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        assert.equal(memos.some((m) => m.label === '혈당'), true);
    });

    it('메모 없는 옛 개정판에도 덧붙는다 — 마이그레이션 없이', () => {
        const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심')]) };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        assert.equal(memos.length, 5);
        assert.equal(slotItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY)).length, 1);
    });

    it('빠진 기본 항목은 메모 구간 **맨 앞**에 들어간다 — 체중이 위에 보여야 한다', () => {
        const mine = memo('mine', '수면', 'moon');
        const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), mine]) };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        assert.deepEqual(memos.map((m) => m.label), ['체중', '운동', '화장실', '혈당', '하루 소감', '수면']);
    });

    it('이미 있는 기본 항목의 자리는 건드리지 않는다 — 사용자가 끌어 정한 순서다', () => {
        const all = defaultMemoItems();
        const mine = memo('mine', '수면', 'moon');
        const settings = {
            slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), mine, ...all])
        };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        assert.deepEqual(memos.map((m) => m.label), ['수면', '체중', '운동', '화장실', '혈당', '하루 소감']);
    });

    it('꺼진 기본 메모를 사용자가 켜 두면 그대로 켜져 있다 — 읽을 때마다 끄지 않는다', () => {
        const bsOn = { ...defaultMemoItems().find((m) => m.key === defaultMemoKey('bloodSugar')), enabled: true };
        const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), bsOn]) };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        assert.equal(memos.find((m) => m.key === defaultMemoKey('bloodSugar')).enabled, true);
    });

    it('해제해 둔 기본 메모는 다시 켜지지 않는다 — key 가 개정판에 살아 있다', () => {
        const off = { ...defaultMemoItems()[0], enabled: false };
        const settings = { slotPlan: planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심'), off]) };
        const memos = memoItemsOnly(effectiveSlots(settings, '2026-09-05', TODAY));
        const weight = memos.find((m) => m.key === defaultMemoKey('weight'));
        assert.equal(weight.enabled, false, '해제 상태가 유지돼야 한다');
    });

    it('기본 메모는 key 로 알아본다 — 지우기와 해제를 가르는 기준', () => {
        assert.equal(isDefaultMemoKey(defaultMemoKey('weight')), true);
        assert.equal(isDefaultMemoKey('0mtek3x9'), false);
    });

    it('덧붙임만으로는 개정판이 생기지 않는다 (§5.6 과 충돌하지 않는다)', () => {
        const plan = planWith('2026-09-01', [slot(defaultSlotKey('lunch'), 'lunch', '점심')]);
        const draft = effectiveSlots({ slotPlan: plan }, '2026-09-01', TODAY);
        assert.equal(withRevisionOn(plan, '2026-09-01', draft, 2, () => 0.5, TODAY), plan);
    });
});

describe('숫자 메모 (§2.7)', () => {
    it('단위가 있으면 숫자 메모 — 소수 자릿수는 0 또는 1', () => {
        const out = sanitizeSlots([{ key: 'n1', kind: 'memo', icon: 'scale', label: '혈압', unit: 'mmHg', decimals: 3 }]);
        assert.equal(out[0].unit, 'mmHg');
        assert.equal(out[0].decimals, 0, '0·1 밖의 값은 0 으로');
    });

    it('단위가 없으면 필드 자체를 두지 않는다 — 텍스트 메모', () => {
        const out = sanitizeSlots([memo('t1', '배변')]);
        assert.equal('unit' in out[0], false);
        assert.equal('decimals' in out[0], false);
    });

    it('단위만 바꿔도 개정판이 생긴다', () => {
        const items = withDefaultMemos([slot(defaultSlotKey('lunch'), 'lunch', '점심')]);
        const plan = withRevisionOn(null, '2026-09-01', items, 1, () => 0.5, TODAY);
        const changed = items.map((s) => (s.key === defaultMemoKey('weight') ? { ...s, unit: 'lb' } : s));
        assert.notEqual(withRevisionOn(plan, '2026-09-01', changed, 2, () => 0.5, TODAY), plan);
    });
});
