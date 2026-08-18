/**
 * 하위 값 빈도 추천 — 나만의 태그(수동 등록)를 대신하는 규칙.
 *
 * 설계: `docs/entry-axes-and-tags-direction.md` §4(역할② 입력 가속)·§5(상위 축이 하위를 좁힌다).
 *
 * 여기서 지키려는 것은 「좋은 추천인가」가 아니라 **「엉뚱한 걸 올리지 않는가」** 다.
 * 집밥 칸에 식당 이름이 뜨거나, 자동으로 채워진 값이 다시 추천으로 돌아오거나,
 * 사용자가 쓰지 않는 표기가 대표로 서는 것은 기능이 없느니만 못하다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { frequentSubTagValues, normSubTagKey } from '../js/utils/frequent-subtags.js';

/** 최신이 앞 — window.mealHistory 와 같은 순서 */
const HISTORY = [
    { mealType: '집밥', place: '우리집' },
    { mealType: '집밥', place: '우리집' },
    { mealType: '집밥', place: '본가' },
    { mealType: '외식', place: '김밥천국' },
    { mealType: '외식', place: '김밥천국' },
    { mealType: '외식', place: '스시로' },
];

describe('frequentSubTagValues — 부모로 좁히기', () => {
    it('그 조달 방식으로 기록한 장소만 올린다', () => {
        assert.deepEqual(
            frequentSubTagValues(HISTORY, { field: 'place', parentField: 'mealType', parent: '집밥' }),
            ['우리집', '본가']
        );
        assert.deepEqual(
            frequentSubTagValues(HISTORY, { field: 'place', parentField: 'mealType', parent: '외식' }),
            ['김밥천국', '스시로']
        );
    });

    it('부모를 주지 않으면 전체 이력에서 뽑는다', () => {
        const all = frequentSubTagValues(HISTORY, { field: 'place' });
        assert.equal(all[0], '우리집'); // 2회로 최다
        assert.equal(all.length, 4);
    });

    it('이력에 없는 부모면 빈 배열 — 시드는 부르는 쪽이 정한다', () => {
        assert.deepEqual(
            frequentSubTagValues(HISTORY, { field: 'place', parentField: 'mealType', parent: '편의점' }),
            []
        );
    });

    it('부모 값이 다른 필드에 있는 옛 기록도 잡는다', () => {
        const history = [
            { mealType: '', snackPlaceMain: '', place: '사무실', withWhom: '' },
            { mealType: '', snackPlaceMain: '사무실', place: '탕비실' },
        ];
        const got = frequentSubTagValues(history, {
            field: 'place',
            parentField: 'snackPlaceMain',
            parentFallbackFields: ['place'],
            parent: '사무실',
        });
        assert.deepEqual(got, ['사무실', '탕비실']);
    });
});

describe('frequentSubTagValues — 표본에서 빼는 것', () => {
    it('건너뜀 기록은 세지 않는다', () => {
        const history = [
            { mealType: '건너뜀', place: '우리집' },
            { mealType: 'Skip', place: '우리집' },
            { mealType: '집밥', place: '본가' },
        ];
        assert.deepEqual(frequentSubTagValues(history, { field: 'place' }), ['본가']);
    });

    it('자동으로 채운 값은 세지 않는다 — 추측이 추측을 강화하면 안 된다', () => {
        const history = [
            { mealType: '집밥', place: '우리집', autoContext: ['place'] },
            { mealType: '집밥', place: '우리집', autoContext: ['place'] },
            { mealType: '집밥', place: '본가' },
        ];
        assert.deepEqual(
            frequentSubTagValues(history, { field: 'place', parentField: 'mealType', parent: '집밥' }),
            ['본가']
        );
    });

    it('빈 값·공백만 있는 값은 무시한다', () => {
        const history = [{ mealType: '집밥', place: '   ' }, { mealType: '집밥' }, { mealType: '집밥', place: '본가' }];
        assert.deepEqual(frequentSubTagValues(history, { field: 'place' }), ['본가']);
    });
});

describe('frequentSubTagValues — 다중값과 표기', () => {
    it('쉼표 다중값은 항목 단위로 센다', () => {
        const history = [
            { mealType: '외식', withWhom: '가족', withWhomDetail: '엄마, 아빠' },
            { mealType: '외식', withWhom: '가족', withWhomDetail: '엄마' },
        ];
        assert.deepEqual(
            frequentSubTagValues(history, {
                field: 'withWhomDetail',
                parentField: 'withWhom',
                parent: '가족',
                splitCommas: true,
            }),
            ['엄마', '아빠']
        );
    });

    it('흔들리는 표기는 한 항목으로 묶고, 많이 쓴 원문을 대표로 세운다', () => {
        const history = [
            { mealType: '외식', place: '스타벅스 역삼' },
            { mealType: '외식', place: '스타벅스역삼' },
            { mealType: '외식', place: '스타벅스역삼' },
        ];
        assert.deepEqual(frequentSubTagValues(history, { field: 'place' }), ['스타벅스역삼']);
    });

    it('동률이면 최근 쪽이 앞', () => {
        const history = [
            { mealType: '집밥', place: '본가' },
            { mealType: '집밥', place: '우리집' },
        ];
        assert.deepEqual(frequentSubTagValues(history, { field: 'place' }), ['본가', '우리집']);
    });

    it('limit 을 넘지 않는다', () => {
        const history = Array.from({ length: 20 }, (_, i) => ({ mealType: '외식', place: `가게${i}` }));
        assert.equal(frequentSubTagValues(history, { field: 'place', limit: 5 }).length, 5);
    });
});

describe('normSubTagKey', () => {
    it('공백과 대소문자를 무시한다', () => {
        assert.equal(normSubTagKey(' Cafe  Latte '), 'cafelatte');
        assert.equal(normSubTagKey(null), '');
    });
});
