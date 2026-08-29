/**
 * 사용자 슬롯 계획의 계약 (docs/user-slot-plan.md).
 *
 * 여기서 못박는 것:
 * 1. plan 없는 사용자의 effectiveSlots 는 현행 SLOTS 와 **정확히 같다** —
 *    1단계에서 읽기 경로를 갈아끼워도 화면이 1픽셀도 안 바뀌는 근거.
 * 2. resolveSlotView 는 어떤 입력에도 실패하지 않는다 (불변식 4의 토대).
 * 3. slotKey 는 날짜로 좁히지 않고 전 개정판에서 찾는다 — 슬롯을 지워도
 *    이미 붙은 이름은 유지된다.
 * 4. base 폴백은 "가장 오래된 key" — 순서를 끌어도 옛 기록 귀속이 안 흔들린다.
 * 5. 변화 없는 저장은 개정판을 만들지 않는다 (성장 억제).
 * 6. 시계 방어 — 미래 개정판은 무시하되 지우지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SLOTS } from '../js/constants.js';
import {
    generateSlotKey,
    compareSlotKeys,
    defaultUserSlots,
    sanitizeSlots,
    listRevisionDates,
    revisionSlotsForDate,
    effectiveSlots,
    findSlotByKey,
    oldestSlotForBase,
    resolveSlotView,
    withRevisionOn,
    renameSlotEverywhere,
    revisionCount,
    countEnabledSlots,
    originalSlotSet,
    materializeSlotKeys,
    nextRevisionDateAfter,
    adoptExistingKeys,
    addDaysIso,
    groupMealsByUserSlotForDate,
    MAX_ENABLED_SLOTS,
    MAX_SLOTS_PER_REVISION
} from '../js/utils/slot-plan.js';

const TODAY = '2026-08-29';

/** 고정 rng — 테스트 결정론 */
const rngOf = (v) => () => v;

function planWith(revisions) {
    return { schema: 1, revisions };
}

/** 야식(=dinner 복제)·2차(=night 복제)가 있는 대표 구성 */
function richPlan() {
    return planWith({
        '2026-08-01': {
            createdAt: 1,
            slots: [
                { key: 'k-morning', base: 'morning', label: '아침', enabled: true },
                { key: 'k-lunch', base: 'lunch', label: '점심', enabled: true },
                { key: 'k-dinner', base: 'dinner', label: '저녁', enabled: true },
                { key: 'k-night1', base: 'night', label: '밤 간식', enabled: true },
                { key: 'k-yasik', base: 'dinner', label: '야식', enabled: true }
            ]
        }
    });
}

describe('기본값 동치 — 1단계 무변화 배포의 근거', () => {
    it('plan 없는 사용자의 effectiveSlots 는 SLOTS 와 id·라벨·순서가 같다', () => {
        const slots = effectiveSlots({}, TODAY, TODAY);
        assert.equal(slots.length, SLOTS.length);
        slots.forEach((s, i) => {
            assert.equal(s.base, SLOTS[i].id);
            assert.equal(s.label, SLOTS[i].label);
            assert.equal(s.enabled, true);
            assert.equal(s.key, null);
        });
    });

    it('userSettings 가 null·undefined 여도 기본값이 나온다', () => {
        assert.equal(effectiveSlots(null, TODAY, TODAY).length, SLOTS.length);
        assert.equal(effectiveSlots(undefined, TODAY, TODAY).length, SLOTS.length);
    });

    it('plan 없는 기록의 resolveSlotView 는 현행 SLOTS 라벨과 같다', () => {
        for (const s of SLOTS) {
            const v = resolveSlotView({ slotId: s.id, date: TODAY }, {}, TODAY);
            assert.equal(v.label, s.label);
            assert.equal(v.base, s.id);
            assert.equal(v.matchedBy, 'default');
        }
    });
});

describe('resolveSlotView 는 절대 실패하지 않는다', () => {
    it('slotId 가 모르는 값·null 이어도 객체가 나온다', () => {
        for (const record of [{}, null, { slotId: 'zzz' }, { slotId: null, slotKey: 'x' }]) {
            const v = resolveSlotView(record, {}, TODAY);
            assert.equal(typeof v.label, 'string');
            assert.ok(v.label.length > 0);
            assert.ok(SLOTS.some((s) => s.id === v.base));
        }
    });

    it('plan 이 손상돼 있어도(배열·문자열) 기본값으로 내려간다', () => {
        for (const broken of [{ slotPlan: [] }, { slotPlan: 'x' }, { slotPlan: { revisions: [1, 2] } }]) {
            const v = resolveSlotView({ slotId: 'lunch', date: TODAY }, broken, TODAY);
            assert.equal(v.label, '점심');
        }
    });
});

describe('slotKey 해석 — 이름은 절대 잃지 않는다 (§3)', () => {
    it('slotKey 는 기록 날짜의 개정판에 없어도 전 개정판에서 찾는다', () => {
        // 8/15 개정판에서 야식이 삭제됐지만, 8/10 기록의 이름은 유지돼야 한다
        const plan = richPlan();
        plan.revisions['2026-08-15'] = {
            createdAt: 2,
            slots: plan.revisions['2026-08-01'].slots.filter((s) => s.key !== 'k-yasik')
        };
        const settings = { slotPlan: plan };
        const v = resolveSlotView(
            { slotId: 'dinner', slotKey: 'k-yasik', date: '2026-08-20' },
            settings,
            TODAY
        );
        assert.equal(v.label, '야식');
        assert.equal(v.matchedBy, 'key');
    });

    it('여러 개정판에 라벨이 다르면 최신 개정판의 라벨을 쓴다', () => {
        const plan = richPlan();
        plan.revisions['2026-08-15'] = {
            createdAt: 2,
            slots: [{ key: 'k-yasik', base: 'dinner', label: '심야식', enabled: true }]
        };
        assert.equal(findSlotByKey(plan, 'k-yasik', TODAY).label, '심야식');
    });
});

describe('base 폴백 = 가장 오래된 key (§3)', () => {
    it('같은 base 가 둘이면 key 가 오래된 쪽이 폴백을 받는다 — 배열 순서와 무관', () => {
        // 야식(k-yasik)이 저녁(k-dinner)보다 나중 key. 순서상 야식이 앞이어도
        // slotKey 없는 dinner 기록은 '저녁'이다.
        const slots = [
            { key: 'k-yasik', base: 'dinner', label: '야식', enabled: true },
            { key: 'k-dinner', base: 'dinner', label: '저녁', enabled: true }
        ];
        assert.equal(oldestSlotForBase(slots, 'dinner').label, '저녁');
    });

    it('key:null(기본 슬롯)은 항상 원본으로 이긴다', () => {
        const slots = [
            { key: 'aaa', base: 'lunch', label: '새점심', enabled: true },
            { key: null, base: 'lunch', label: '점심', enabled: true }
        ];
        assert.equal(oldestSlotForBase(slots, 'lunch').label, '점심');
    });

    it('resolveSlotView: slotKey 없는 기록이 개정판의 원본 라벨을 받는다', () => {
        const v = resolveSlotView(
            { slotId: 'dinner', date: '2026-08-20' },
            { slotPlan: richPlan() },
            TODAY
        );
        assert.equal(v.label, '저녁'); // 야식이 아니라
        assert.equal(v.matchedBy, 'base');
    });

    it('enabled:false 슬롯도 해석에는 그대로 쓰인다 — 렌더 필터 아님 (불변식 4)', () => {
        const plan = richPlan();
        plan.revisions['2026-08-01'].slots.find((s) => s.key === 'k-dinner').enabled = false;
        const v = resolveSlotView(
            { slotId: 'dinner', date: '2026-08-20' },
            { slotPlan: plan },
            TODAY
        );
        assert.equal(v.label, '저녁');
    });
});

describe('날짜별 유효 개정판 (§2.1)', () => {
    it('effectiveFrom <= date 인 마지막 개정판을 쓴다', () => {
        const plan = planWith({
            '2026-08-01': { createdAt: 1, slots: [{ key: 'a', base: 'lunch', label: '1차구성', enabled: true }] },
            '2026-08-20': { createdAt: 2, slots: [{ key: 'b', base: 'lunch', label: '2차구성', enabled: true }] }
        });
        assert.equal(revisionSlotsForDate(plan, '2026-08-10', TODAY)[0].label, '1차구성');
        assert.equal(revisionSlotsForDate(plan, '2026-08-20', TODAY)[0].label, '2차구성');
        assert.equal(revisionSlotsForDate(plan, '2026-08-25', TODAY)[0].label, '2차구성');
    });

    it('첫 개정판보다 앞 날짜는 기본값 — 과거 기록은 예전 모습 그대로', () => {
        const settings = { slotPlan: richPlan() };
        const slots = effectiveSlots(settings, '2026-07-01', TODAY);
        assert.equal(slots.length, SLOTS.length);
        assert.equal(slots[0].key, null);
    });
});

describe('시계 방어 (§5.5)', () => {
    it('오늘+1일보다 미래인 개정판은 무시된다', () => {
        const plan = planWith({
            '2030-01-01': { createdAt: 9, slots: [{ key: 'z', base: 'lunch', label: '미래', enabled: true }] }
        });
        assert.deepEqual(listRevisionDates(plan, TODAY), []);
        assert.equal(effectiveSlots({ slotPlan: plan }, TODAY, TODAY)[0].key, null);
    });

    it('내일(=오늘+1)까지는 유효 — 자정 걸친 기기 시차 허용', () => {
        const plan = planWith({
            '2026-08-30': { createdAt: 9, slots: [{ key: 'z', base: 'lunch', label: '내일', enabled: true }] }
        });
        assert.deepEqual(listRevisionDates(plan, TODAY), ['2026-08-30']);
    });
});

describe('sanitizeSlots — 남의 기기·구버전을 신뢰하지 않는다', () => {
    it('모르는 base·빈 라벨·중복 key 를 버린다', () => {
        const out = sanitizeSlots([
            { key: 'a', base: 'lunch', label: '점심', enabled: true },
            { key: 'b', base: 'brunch', label: '브런치', enabled: true },
            { key: 'c', base: 'dinner', label: '   ', enabled: true },
            { key: 'a', base: 'lunch', label: '중복', enabled: true },
            null,
            'x'
        ]);
        assert.equal(out.length, 1);
        assert.equal(out[0].key, 'a');
    });

    it('저장 배열 총 상한으로 자른다', () => {
        const many = Array.from({ length: MAX_SLOTS_PER_REVISION + 8 }, (_, i) => ({
            key: `k${String(i).padStart(2, '0')}`,
            base: 'lunch',
            label: `슬롯${i}`,
            enabled: true
        }));
        assert.equal(sanitizeSlots(many).length, MAX_SLOTS_PER_REVISION);
    });

    it('13자 라벨은 12자로 잘린다', () => {
        const out = sanitizeSlots([{ key: 'a', base: 'lunch', label: '가나다라마바사아자차카타파', enabled: true }]);
        assert.equal(out[0].label.length, 12);
    });

    it('전부 무효면 null — 기본값 폴백 신호', () => {
        assert.equal(sanitizeSlots([{ base: 'nope', label: 'x' }]), null);
        assert.equal(sanitizeSlots('x'), null);
    });
});

describe('withRevisionOn — 성장 억제와 key 구체화 (§5.6)', () => {
    it('변화 없으면 원본 plan 참조를 그대로 돌려준다 (기본값 사용자)', () => {
        // 설정을 열고 그냥 닫은 경우: plan 없음 + 기본 목록 그대로 저장 시도
        const result = withRevisionOn(null, TODAY, defaultUserSlots(), 1000, rngOf(0));
        assert.equal(result, null);
    });

    it('변화 없으면 원본 plan 참조를 그대로 돌려준다 (개정판 사용자)', () => {
        const plan = richPlan();
        const current = revisionSlotsForDate(plan, TODAY, TODAY);
        assert.equal(withRevisionOn(plan, TODAY, current, 1000, rngOf(0)), plan);
    });

    it('라벨 하나만 바꿔도 오늘 날짜 개정판이 생긴다', () => {
        const plan = richPlan();
        const edited = revisionSlotsForDate(plan, TODAY, TODAY).map((s) =>
            s.key === 'k-yasik' ? { ...s, enabled: false } : s
        );
        const next = withRevisionOn(plan, TODAY, edited, 1000, rngOf(0));
        assert.notEqual(next, plan);
        assert.ok(next.revisions[TODAY]);
        // 기존 개정판은 그대로
        assert.equal(next.revisions['2026-08-01'], plan.revisions['2026-08-01']);
    });

    it('기본값 사용자가 처음 수정하면 null key 가 실제 key 로 구체화된다', () => {
        const edited = defaultUserSlots().map((s) =>
            s.base === 'lunch' ? { ...s, label: '런치' } : s
        );
        const next = withRevisionOn(null, TODAY, edited, 1000, rngOf(0.5));
        const saved = next.revisions[TODAY].slots;
        assert.ok(saved.every((s) => typeof s.key === 'string' && s.key.length > 0));
        // 구체화 순서 = 목록 순서 → 가장 오래된 key 는 목록 앞쪽 (원본 판정 유지)
        const keys = saved.map((s) => s.key);
        assert.deepEqual([...keys].sort(), keys);
    });
});

describe('renameSlotEverywhere — 이름 소급 (§3.1)', () => {
    it('모든 개정판의 같은 key 라벨이 바뀐다', () => {
        const plan = richPlan();
        plan.revisions['2026-08-15'] = {
            createdAt: 2,
            slots: [{ key: 'k-yasik', base: 'dinner', label: '야식', enabled: true }]
        };
        const next = renameSlotEverywhere(plan, 'k-yasik', '심야식');
        assert.equal(next.revisions['2026-08-01'].slots.find((s) => s.key === 'k-yasik').label, '심야식');
        assert.equal(next.revisions['2026-08-15'].slots[0].label, '심야식');
        // 다른 슬롯·다른 개정판 객체는 건드리지 않는다
        assert.equal(next.revisions['2026-08-01'].slots.find((s) => s.key === 'k-dinner').label, '저녁');
    });

    it('key 가 어디에도 없으면 원본 참조 그대로', () => {
        const plan = richPlan();
        assert.equal(renameSlotEverywhere(plan, 'no-such', '이름'), plan);
    });

    it('빈 라벨로는 못 바꾼다', () => {
        const plan = richPlan();
        assert.equal(renameSlotEverywhere(plan, 'k-yasik', '   '), plan);
    });
});

describe('key 생성·비교', () => {
    it('시간이 뒤일수록 문자열 비교도 뒤다 — 고정폭 계약', () => {
        const a = generateSlotKey(1700000000000, rngOf(0));
        const b = generateSlotKey(1700000000001, rngOf(0.9));
        assert.ok(compareSlotKeys(a, b) < 0);
    });

    it('null 은 어떤 실제 key 보다도 오래됐다', () => {
        assert.ok(compareSlotKeys(null, generateSlotKey()) < 0);
    });
});

describe('groupMealsByUserSlotForDate — 타임라인 순회 (§3)', () => {
    it('plan 없는 사용자: 그룹 순서·라벨이 SLOTS 순회와 정확히 같다', () => {
        const history = [
            { id: '1', date: TODAY, slotId: 'dinner' },
            { id: '2', date: TODAY, slotId: 'morning' },
            { id: '3', date: TODAY, slotId: 'morning' },
            { id: '4', date: '2026-08-28', slotId: 'lunch' }, // 다른 날짜 — 제외
            { id: '5', date: TODAY, slotId: 'zzz' } // 모르는 slotId — 현행처럼 버림
        ];
        const groups = groupMealsByUserSlotForDate(TODAY, history, {}, TODAY);
        assert.deepEqual(
            groups.map((g) => [g.slot.id, g.slot.label, g.records.length]),
            [['morning', '아침', 2], ['dinner', '저녁', 1]]
        );
        assert.equal(groups[0].slot.type, 'main');
    });

    it('slotKey 기록과 slotKey 없는 기록이 같은 원본 슬롯 그룹으로 합쳐진다', () => {
        const history = [
            { id: 'a', date: TODAY, slotId: 'dinner', slotKey: 'k-dinner' },
            { id: 'b', date: TODAY, slotId: 'dinner' } // 폴백 → 원본(k-dinner)
        ];
        const groups = groupMealsByUserSlotForDate(TODAY, history, { slotPlan: richPlan() }, TODAY);
        assert.equal(groups.length, 1);
        assert.equal(groups[0].records.length, 2);
        assert.equal(groups[0].slot.label, '저녁');
    });

    it('같은 base 라도 slotKey 가 다르면 다른 그룹 — 순서는 개정판 배열 순서', () => {
        const history = [
            { id: 'a', date: TODAY, slotId: 'dinner', slotKey: 'k-yasik' },
            { id: 'b', date: TODAY, slotId: 'dinner', slotKey: 'k-dinner' },
            { id: 'c', date: TODAY, slotId: 'night', slotKey: 'k-night1' }
        ];
        const groups = groupMealsByUserSlotForDate(TODAY, history, { slotPlan: richPlan() }, TODAY);
        // richPlan 배열 순서: …저녁(k-dinner) → 밤 간식(k-night1) → 야식(k-yasik)
        assert.deepEqual(
            groups.map((g) => g.slot.label),
            ['저녁', '밤 간식', '야식']
        );
        // 야식은 base 가 dinner 이므로 본식 카드로 렌더된다
        assert.equal(groups[2].slot.type, 'main');
    });

    it('개정판에서 삭제된 슬롯의 기록: 이름은 유지, 위치는 원본 자리', () => {
        const plan = richPlan();
        plan.revisions['2026-08-25'] = {
            createdAt: 2,
            slots: plan.revisions['2026-08-01'].slots.filter((s) => s.key !== 'k-yasik')
        };
        const history = [
            { id: 'a', date: TODAY, slotId: 'dinner', slotKey: 'k-yasik' },
            { id: 'b', date: TODAY, slotId: 'night', slotKey: 'k-night1' }
        ];
        const groups = groupMealsByUserSlotForDate(TODAY, history, { slotPlan: plan }, TODAY);
        // 야식 그룹은 원본 저녁(k-dinner) 자리 = 밤 간식보다 앞
        assert.deepEqual(
            groups.map((g) => g.slot.label),
            ['야식', '밤 간식']
        );
    });
});

describe('원본 vs 확장 — 삭제 가능 여부를 가른다 (§4.2.1)', () => {
    it('base 마다 가장 오래된 key 하나씩이 원본', () => {
        const slots = [
            { key: 'k-dinner', base: 'dinner', label: '저녁', enabled: true },
            { key: 'k-yasik', base: 'dinner', label: '야식', enabled: true },
            { key: 'k-lunch', base: 'lunch', label: '점심', enabled: true }
        ];
        const originals = originalSlotSet(slots);
        assert.equal(originals.size, 2);
        assert.ok(originals.has(slots[0]));
        assert.ok(!originals.has(slots[1])); // 야식 = 확장 → 삭제 가능
        assert.ok(originals.has(slots[2]));
    });

    it('배열 순서를 바꿔도 원본은 그대로 — key 기준이다', () => {
        const slots = [
            { key: 'k-yasik', base: 'dinner', label: '야식', enabled: true },
            { key: 'k-dinner', base: 'dinner', label: '저녁', enabled: true }
        ];
        assert.ok(originalSlotSet(slots).has(slots[1]));
    });

    it('기본 7슬롯은 전부 원본 — 아무도 못 지운다', () => {
        const originals = originalSlotSet(defaultUserSlots());
        assert.equal(originals.size, SLOTS.length);
    });

    it('복제는 원본보다 나중 key 를 받아야 한다 (열 때 구체화 → 복제 순서)', () => {
        const opened = materializeSlotKeys(defaultUserSlots(), 1000, rngOf(0));
        const dup = { key: generateSlotKey(2000, rngOf(0)), base: 'dinner', label: '야식', enabled: true };
        const dinner = opened.find((s) => s.base === 'dinner');
        assert.ok(compareSlotKeys(dinner.key, dup.key) < 0);
        assert.ok(originalSlotSet([...opened, dup]).has(dinner));
    });
});

describe('materializeSlotKeys — 구체화만으로 개정판이 생기면 안 된다', () => {
    it('열 때 key 를 붙여도 내용이 같으면 저장 없음 (§5.6)', () => {
        const opened = materializeSlotKeys(defaultUserSlots(), 1000, rngOf(0));
        assert.ok(opened.every((s) => typeof s.key === 'string'));
        // 사용자가 아무것도 안 건드리고 저장 → plan 참조 그대로
        assert.equal(withRevisionOn(null, TODAY, opened, 5000, rngOf(0)), null);
    });

    it('구체화 후 라벨을 바꾸면 개정판이 생긴다', () => {
        const opened = materializeSlotKeys(defaultUserSlots(), 1000, rngOf(0));
        const edited = opened.map((s) => (s.base === 'lunch' ? { ...s, label: '런치' } : s));
        const next = withRevisionOn(null, TODAY, edited, 5000, rngOf(0));
        assert.ok(next?.revisions?.[TODAY]);
        assert.equal(next.revisions[TODAY].slots.find((s) => s.base === 'lunch').label, '런치');
    });

    it('이미 key 가 있으면 건드리지 않는다', () => {
        const slots = [{ key: 'keep', base: 'lunch', label: '점심', enabled: true }];
        assert.equal(materializeSlotKeys(slots, 1000, rngOf(0))[0].key, 'keep');
    });
});

describe('고른 날짜부터 적용 (§4.2.3)', () => {
    const slotsNamed = (label) => [{ key: 'k1', base: 'lunch', label, enabled: true }];

    it('27일에 저장하고 29일에 또 저장하면 27·28은 앞 구성, 29부터는 뒷 구성', () => {
        let plan = withRevisionOn(null, '2026-08-27', slotsNamed('27일구성'), 1000, rngOf(0), TODAY);
        plan = withRevisionOn(plan, '2026-08-29', slotsNamed('29일구성'), 2000, rngOf(0), TODAY);

        assert.deepEqual(Object.keys(plan.revisions).sort(), ['2026-08-27', '2026-08-29']);
        const labelOn = (d) => revisionSlotsForDate(plan, d, TODAY)[0].label;
        assert.equal(labelOn('2026-08-27'), '27일구성');
        assert.equal(labelOn('2026-08-28'), '27일구성');
        assert.equal(labelOn('2026-08-29'), '29일구성');
        assert.equal(labelOn('2026-09-05'), '29일구성');
    });

    it('26일 이전은 두 개정판 어느 쪽도 아니다 — 기본값', () => {
        const plan = withRevisionOn(null, '2026-08-27', slotsNamed('27일구성'), 1000, rngOf(0), TODAY);
        assert.equal(revisionSlotsForDate(plan, '2026-08-26', TODAY), null);
        assert.equal(effectiveSlots({ slotPlan: plan }, '2026-08-26', TODAY).length, SLOTS.length);
    });

    it('과거 날짜를 나중에 끼워 넣어도 뒤 개정판을 안 지운다 (맵이라서)', () => {
        let plan = withRevisionOn(null, '2026-08-29', slotsNamed('29일구성'), 2000, rngOf(0), TODAY);
        plan = withRevisionOn(plan, '2026-08-27', slotsNamed('27일구성'), 3000, rngOf(0), TODAY);
        assert.equal(revisionSlotsForDate(plan, '2026-08-28', TODAY)[0].label, '27일구성');
        assert.equal(revisionSlotsForDate(plan, '2026-08-29', TODAY)[0].label, '29일구성');
    });

    it('같은 날짜에 다시 저장하면 덮어쓴다 — "마지막 편집이 이긴다" (§5.3)', () => {
        let plan = withRevisionOn(null, '2026-08-27', slotsNamed('첫판'), 1000, rngOf(0), TODAY);
        plan = withRevisionOn(plan, '2026-08-27', slotsNamed('둘째판'), 2000, rngOf(0), TODAY);
        assert.equal(Object.keys(plan.revisions).length, 1);
        assert.equal(revisionSlotsForDate(plan, '2026-08-27', TODAY)[0].label, '둘째판');
    });

    it('nextRevisionDateAfter: 안내문이 "며칠까지"를 계산하는 근거', () => {
        let plan = withRevisionOn(null, '2026-08-27', slotsNamed('a'), 1000, rngOf(0), TODAY);
        plan = withRevisionOn(plan, '2026-08-29', slotsNamed('b'), 2000, rngOf(0), TODAY);
        assert.equal(nextRevisionDateAfter(plan, '2026-08-27', TODAY), '2026-08-29');
        assert.equal(addDaysIso('2026-08-29', -1), '2026-08-28');
        assert.equal(nextRevisionDateAfter(plan, '2026-08-29', TODAY), null);
    });
});

describe('adoptExistingKeys — 과거 날짜 편집이 슬롯 정체성을 쪼개지 않는다', () => {
    it('29일 개정판만 있을 때 27일 기본값이 같은 key 를 물려받는다', () => {
        // 기본값 그대로면 개정판이 안 생긴다(성장 억제) — 실제 변경을 담아 저장한다
        const edited29 = defaultUserSlots().map((s) =>
            s.base === 'lunch' ? { ...s, label: '런치' } : s
        );
        const plan = withRevisionOn(null, '2026-08-29', edited29, 1000, rngOf(0), TODAY);
        const keys29 = plan.revisions['2026-08-29'].slots.map((s) => s.key);

        // 27일에는 개정판이 없어 기본값(key:null)이 온다
        const raw27 = effectiveSlots({ slotPlan: plan }, '2026-08-27', TODAY);
        assert.ok(raw27.every((s) => s.key === null));

        const adopted = adoptExistingKeys(raw27, plan, TODAY);
        assert.deepEqual(adopted.map((s) => s.key), keys29);
    });

    it('개정판이 없으면 그대로 둔다', () => {
        const slots = defaultUserSlots();
        assert.equal(adoptExistingKeys(slots, null, TODAY), slots);
    });
});

describe('상한 두 개 — 세는 대상이 다르다', () => {
    it('피커 상한은 사용 중인 수만 센다 — 해제분은 자리를 안 먹는다', () => {
        const slots = [
            ...Array.from({ length: MAX_ENABLED_SLOTS }, (_, i) => ({
                key: `on${i}`, base: 'lunch', label: `쓰는${i}`, enabled: true
            })),
            { key: 'off1', base: 'lunch', label: '안쓰는', enabled: false }
        ];
        assert.equal(countEnabledSlots(slots), MAX_ENABLED_SLOTS);
        // 해제분까지 13개지만 저장 상한(24)에는 여유가 있다 — 잘리지 않는다
        assert.equal(sanitizeSlots(slots).length, 13);
    });

    it('저장 상한이 피커 상한보다 커야 해제분을 담을 수 있다', () => {
        assert.ok(MAX_SLOTS_PER_REVISION > MAX_ENABLED_SLOTS);
    });

    it('countEnabledSlots: enabled 생략은 사용 중으로 본다 (기본값 호환)', () => {
        assert.equal(countEnabledSlots([{ base: 'lunch', label: 'a' }, { base: 'lunch', label: 'b', enabled: false }]), 1);
        assert.equal(countEnabledSlots(null), 0);
    });
});

describe('revisionCount', () => {
    it('맵 크기를 센다 — 손상 plan 은 0', () => {
        assert.equal(revisionCount(richPlan()), 1);
        assert.equal(revisionCount(null), 0);
        assert.equal(revisionCount({ revisions: 'x' }), 0);
    });
});
