/**
 * 기록 충실도 점수 계약.
 *
 * 배경: 리포트에 0~100 점수가 화면에서 가장 크게 붙어 있었는데, 그 점수는 AI가 매겼고
 * 근거의 상당 부분이 영양 판단이었다. 그런데 영양 판단은 프롬프트 [금지 주제]로 본문에
 * 쓰는 것이 금지되어 있어서, 근거를 밝힐 수 없는 숫자가 되어 있었다.
 * 채점 대상을 식단에서 기록으로 옮겨 근거를 화면에 펼칠 수 있게 만든 것이 이 산식이다.
 *
 * 여기서 검증하는 계약:
 * 1. 같은 기록이면 항상 같은 점수 (AI가 개입하지 않는다)
 * 2. 근거를 못 구하는 구버전 문서는 0점이 아니라 null — 모르는 것과 없는 것은 다르다
 * 3. "건너뜀"도 남긴 기록이다. 안 먹은 것을 적은 행위에 벌을 주지 않는다
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeDietRecordScore } from '../js/utils/diet-record-score.js';

/** 완전히 채운 끼니 하나 */
function fullMeal(slotId) {
    return { slotId, detailText: '집밥', photoCount: 2, rating: 5, satiety: 3, comment: '맛있었다' };
}

/** 슬롯만 남기고 아무것도 안 채운 끼니 */
function bareMeal(slotId) {
    return { slotId, detailText: '외식', photoCount: 0, rating: null, satiety: null, comment: null };
}

describe('computeDietRecordScore', () => {
    it('근거가 없는 구버전 문서는 null (0점으로 깎지 않는다)', () => {
        assert.equal(computeDietRecordScore(null), null);
        assert.equal(computeDietRecordScore({}), null);
        assert.equal(computeDietRecordScore({ inputMeals: '배열 아님' }), null);
    });

    it('본식 세 끼를 전부 채우고 하루소감까지 남기면 100점', () => {
        const result = computeDietRecordScore({
            inputMeals: [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '오늘은 잘 챙겨 먹었다'
        });
        assert.equal(result.total, 100);
        assert.deepEqual(
            result.sections.map((s) => s.got),
            [60, 30, 10]
        );
    });

    it('기록이 하나도 없으면 0점', () => {
        const result = computeDietRecordScore({ inputMeals: [], inputDailyJournalComment: '' });
        assert.equal(result.total, 0);
    });

    it('본식 슬롯만 있고 내용을 안 채우면 본식 점수만 얻는다', () => {
        const result = computeDietRecordScore({
            inputMeals: [bareMeal('morning'), bareMeal('lunch'), bareMeal('dinner')],
            inputDailyJournalComment: ''
        });
        assert.equal(result.total, 60);
    });

    it('간식은 본식 점수에 영향을 주지 않는다 (감점도 가점도 없음)', () => {
        const base = { inputMeals: [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')] };
        const withSnack = {
            inputMeals: [...base.inputMeals, fullMeal('snack1')]
        };
        const mainOf = (r) => r.sections.find((s) => s.key === 'main').got;
        assert.equal(mainOf(computeDietRecordScore(base)), 60);
        assert.equal(mainOf(computeDietRecordScore(withSnack)), 60);
    });

    it('"건너뜀"은 본식 기록으로 인정되고, 깊이 분모에서는 빠진다', () => {
        const skipped = { slotId: 'morning', detailText: '건너뜀', photoCount: 0, rating: null, comment: null };
        const result = computeDietRecordScore({
            inputMeals: [skipped, fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '바빴다'
        });
        // 본식 3칸을 다 남겼으므로 60점, 건너뜀은 채울 것이 없으니 깊이는 나머지 두 끼로만 100%
        assert.equal(result.sections.find((s) => s.key === 'main').got, 60);
        assert.equal(result.sections.find((s) => s.key === 'depth').got, 30);
        assert.equal(result.total, 100);
    });

    it('같은 입력이면 항상 같은 점수', () => {
        const doc = {
            inputMeals: [fullMeal('morning'), bareMeal('lunch')],
            inputDailyJournalComment: '음'
        };
        const a = computeDietRecordScore(doc);
        const b = computeDietRecordScore(doc);
        assert.deepEqual(a, b);
    });

    it('점수는 0~100을 벗어나지 않고 각 항목은 배점을 넘지 않는다', () => {
        const result = computeDietRecordScore({
            inputMeals: ['morning', 'lunch', 'dinner', 'snack1', 'snack2', 'night', 'pre_morning'].map(fullMeal),
            inputDailyJournalComment: '전부 기록'
        });
        assert.ok(result.total >= 0 && result.total <= 100);
        for (const s of result.sections) assert.ok(s.got <= s.max, `${s.key} 초과`);
    });

    it('하루소감만 있고 끼니 기록이 없으면 10점', () => {
        const result = computeDietRecordScore({ inputMeals: [], inputDailyJournalComment: '오늘은 못 먹었다' });
        assert.equal(result.total, 10);
    });
});
