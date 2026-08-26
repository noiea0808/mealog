/**
 * '무엇을' 회상 색인 — 순위와 경계 규칙.
 *
 * 설계: `docs/entry-axes-and-tags-direction.md` §4(태그 역할② 입력 가속),
 * `docs/entry-sheet-redesign.md` §4(음식 텍스트 재사용률 14%).
 *
 * 여기서 지키려는 것은 「좋은 추천인가」가 아니라 **「소음을 안 내는가」** 다.
 * 간식 칸에 삼겹살이 뜨거나, 이미 적은 걸 또 권하거나, 아침 칸이 저녁 습관으로 채워지는
 * 것은 기능이 없느니만 못하다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildRecallIndex,
    normKey,
    pickFrequent,
    pickTypeahead,
    splitActive,
    usedKeys,
} from '../js/utils/what-recall-index.js';

/** 실제 구현(entry-context-predict.js)과 같은 판정 — 주입 의존성의 대역 */
const SNACK_SLOTS = new Set(['pre_morning', 'snack1', 'snack2', 'night']);
const deps = (slotId) => ({
    slotId,
    isSnackSlot: (s) => SNACK_SLOTS.has(String(s || '')),
    isSkipRecord: (r) => r?.mealType === '건너뜀' || r?.mealType === 'Skip',
});

const rec = (date, slotId, menuDetail, extra = {}) => ({ date, slotId, menuDetail, ...extra });

const texts = (list) => list.map((e) => e.text);

describe('splitActive — 쉼표 다중값에서 「지금 적는 항목」', () => {
    it('쉼표가 없으면 전체가 적는 중인 항목이다', () => {
        assert.deepEqual(splitActive('김치'), { head: '', active: '김치' });
    });

    it('마지막 쉼표 뒤만 활성 항목이다', () => {
        assert.deepEqual(splitActive('김치찌개, 계란'), { head: '김치찌개,', active: ' 계란' });
    });

    it('쉼표로 끝나면 활성 항목은 비어 있다 — 다시 frequent 로 돌아가는 신호', () => {
        assert.equal(splitActive('김치찌개, ').active.trim(), '');
    });

    it('전각 쉼표도 같은 구분자다', () => {
        assert.deepEqual(splitActive('밥，김'), { head: '밥，', active: '김' });
    });
});

describe('normKey / usedKeys — 표기 흔들림 흡수', () => {
    it('공백과 대소문자를 무시한다', () => {
        assert.equal(normKey('아이스 아메리카노'), normKey('아이스아메리카노'));
        assert.equal(normKey('Latte'), normKey('latte'));
    });

    it('입력란에 든 항목을 전부 키로 모은다', () => {
        const used = usedKeys('김치찌개, 계란말이');
        assert.ok(used.has('김치찌개'));
        assert.ok(used.has('계란말이'));
    });
});

describe('buildRecallIndex — 무엇을 세는가', () => {
    it('원문 전체가 아니라 쉼표로 쪼갠 항목을 센다', () => {
        const index = buildRecallIndex(
            [
                rec('2026-08-01', 'lunch', '김치찌개, 계란말이'),
                rec('2026-08-02', 'lunch', '김치찌개, 김'),
            ],
            deps('lunch')
        );
        const kimchi = index.find((e) => e.key === '김치찌개');
        assert.equal(kimchi.total, 2, '항목 단위로 세야 반복이 잡힌다');
        assert.equal(index.find((e) => e.key === '계란말이').total, 1);
    });

    it('끼니와 간식을 섞지 않는다 — 간식 칸에 삼겹살이 뜨면 안 된다', () => {
        const index = buildRecallIndex(
            [
                rec('2026-08-01', 'dinner', '삼겹살'),
                rec('2026-08-01', 'snack1', '아메리카노'),
            ],
            deps('snack2')
        );
        assert.deepEqual(texts(index), ['아메리카노']);
    });

    it('건너뜀 기록은 표본이 아니다', () => {
        const index = buildRecallIndex(
            [rec('2026-08-01', 'lunch', '무언가', { mealType: '건너뜀' })],
            deps('lunch')
        );
        assert.deepEqual(index, []);
    });

    it('한 기록 안의 중복은 1회로 센다', () => {
        const index = buildRecallIndex([rec('2026-08-01', 'lunch', '밥, 밥')], deps('lunch'));
        assert.equal(index.find((e) => e.key === '밥').total, 1);
    });

    it('문장 길이의 항목은 버린다 — 칩이 아니라 메모다', () => {
        const long = '오늘은 회사 근처 새로 생긴 집에서 먹었다';
        const index = buildRecallIndex([rec('2026-08-01', 'lunch', long)], deps('lunch'));
        assert.deepEqual(index, []);
    });

    it('대표 표기는 최다 원문이다 — 사용자 어휘를 보존한다', () => {
        const index = buildRecallIndex(
            [
                rec('2026-08-01', 'snack1', '아이스 아메리카노'),
                rec('2026-08-02', 'snack1', '아이스 아메리카노'),
                rec('2026-08-03', 'snack1', '아이스아메리카노'),
            ],
            deps('snack1')
        );
        assert.equal(index.length, 1, '표기가 갈려도 한 항목이다');
        assert.equal(index[0].text, '아이스 아메리카노');
        assert.equal(index[0].total, 3);
    });

    it('현재 슬롯의 출현만 slotHits 로 따로 센다', () => {
        const index = buildRecallIndex(
            [
                rec('2026-08-01', 'breakfast', '토스트'),
                rec('2026-08-02', 'breakfast', '토스트'),
                rec('2026-08-03', 'lunch', '토스트'),
            ],
            deps('breakfast')
        );
        const toast = index[0];
        assert.equal(toast.total, 3);
        assert.equal(toast.slotHits, 2);
        assert.equal(toast.lastDate, '2026-08-03');
    });
});

describe('pickFrequent — 슬롯 우선 + 빈도', () => {
    const history = [
        // 아침에 두 번 이상 — 1순위
        rec('2026-08-01', 'breakfast', '토스트'),
        rec('2026-08-02', 'breakfast', '토스트'),
        // 전체로는 더 많지만 아침엔 한 번도 없다 — 2순위
        rec('2026-08-03', 'lunch', '김치찌개'),
        rec('2026-08-04', 'lunch', '김치찌개'),
        rec('2026-08-05', 'dinner', '김치찌개'),
        // 딱 한 번 — 마지막
        rec('2026-08-06', 'lunch', '돈까스'),
    ];

    it('그 시간대에 반복한 것이 전체 최빈값보다 먼저다', () => {
        const index = buildRecallIndex(history, deps('breakfast'));
        assert.deepEqual(texts(pickFrequent(index, '', 6)), ['토스트', '김치찌개', '돈까스']);
    });

    it('이미 입력란에 있는 항목은 다시 권하지 않는다', () => {
        const index = buildRecallIndex(history, deps('breakfast'));
        assert.deepEqual(texts(pickFrequent(index, '토스트, ', 6)), ['김치찌개', '돈까스']);
    });

    it('limit 을 넘지 않는다', () => {
        const index = buildRecallIndex(history, deps('breakfast'));
        assert.equal(pickFrequent(index, '', 2).length, 2);
    });

    it('반복이 3개 미만이면 1회성으로 메운다 — 콜드 스타트에서 빈 줄을 피한다', () => {
        const index = buildRecallIndex(
            [
                rec('2026-08-01', 'lunch', '초밥'),
                rec('2026-08-02', 'lunch', '냉면'),
            ],
            deps('lunch')
        );
        assert.deepEqual(texts(pickFrequent(index, '', 6)), ['냉면', '초밥'], '최근순으로 메운다');
    });
});

describe('pickTypeahead — 적는 중일 때', () => {
    const index = buildRecallIndex(
        [
            rec('2026-08-01', 'lunch', '김치찌개'),
            rec('2026-08-02', 'lunch', '김치찌개'),
            rec('2026-08-03', 'lunch', '어묵김밥'),
            rec('2026-08-04', 'lunch', '돈까스'),
        ],
        deps('lunch')
    );

    it('앞에서부터 맞는 후보가 가운데 걸린 후보보다 먼저다', () => {
        assert.deepEqual(texts(pickTypeahead(index, '김', '김', 6)), ['김치찌개', '어묵김밥']);
    });

    it('안 맞는 후보는 빠진다', () => {
        assert.deepEqual(texts(pickTypeahead(index, '돈', '돈', 6)), ['돈까스']);
    });

    it('공백을 무시하고 맞춘다 — 표기 흔들림을 이 단계에서 흡수한다', () => {
        const spaced = buildRecallIndex([rec('2026-08-01', 'snack1', '아이스 아메리카노')], deps('snack1'));
        assert.equal(pickTypeahead(spaced, normKey('아이스아'), '아이스아', 6).length, 1);
    });

    it('이미 확정된 앞 항목은 후보에서 빠진다', () => {
        const picked = pickTypeahead(index, '김', '김치찌개, 김', 6);
        assert.deepEqual(texts(picked), ['어묵김밥']);
    });

    it('빈 질의에는 아무것도 내놓지 않는다 — 그 자리는 frequent 의 것이다', () => {
        assert.deepEqual(pickTypeahead(index, '', '', 6), []);
    });
});
