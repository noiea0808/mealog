/**
 * 리포트 점수 계약.
 *
 * 배경: 원래 0~100 점수는 AI가 매겼고 근거의 상당 부분이 영양 판단이었는데, 그 영양 판단은
 * 프롬프트 [금지 주제]로 본문에 쓰는 것이 금지되어 있어 설명할 수 없는 숫자였다.
 * 지금은 네 항목이 모두 내역으로 펼쳐지고, 균형 한 칸만 AI 판단이며 balanceNote 라는
 * 사실 서술을 근거로 달고 나온다.
 *
 * 여기서 검증하는 계약:
 * 1. 기록 세 항목은 결정론적 — 같은 기록이면 항상 같은 값
 * 2. 근거를 못 구하는 구버전 문서는 0점이 아니라 null — 모르는 것과 없는 것은 다르다
 * 3. balance 가 없는 구버전 리포트는 균형 칸을 빼고 나머지로 100점 환산 — 없는 칸이
 *    0점으로 잡혀 과거 점수가 통째로 깎이면 안 된다
 * 4. "건너뜀"도 남긴 기록이다. 안 먹은 것을 적은 행위에 벌을 주지 않는다
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeDietRecordScore } from '../js/utils/diet-record-score.js';

/** 다섯 칸(사진·만족도·코멘트·장소·함께)을 전부 채운 끼니 */
function fullMeal(slotId) {
    return {
        slotId,
        detailText: ['집밥', '    장소: 집', '    함께: 가족'].join('\n'),
        photoCount: 2,
        rating: 5,
        satiety: 3,
        comment: '맛있었다'
    };
}

/** 슬롯만 남기고 아무것도 안 채운 끼니 */
function bareMeal(slotId) {
    return { slotId, detailText: '외식', photoCount: 0, rating: null, satiety: null, comment: null };
}

const sectionGot = (result, key) => result.sections.find((s) => s.key === key)?.got;
const sectionKeys = (result) => result.sections.map((s) => s.key);

describe('computeDietRecordScore', () => {
    it('근거가 없는 구버전 문서는 null (0점으로 깎지 않는다)', () => {
        assert.equal(computeDietRecordScore(null), null);
        assert.equal(computeDietRecordScore({}), null);
        assert.equal(computeDietRecordScore({ inputMeals: '배열 아님' }), null);
    });

    it('balance 가 없으면 균형 칸을 만들지 않고 나머지로 100점 환산한다', () => {
        const result = computeDietRecordScore({
            inputMeals: [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '잘 챙겨 먹었다'
        });
        assert.deepEqual(sectionKeys(result), ['main', 'depth', 'journal']);
        assert.equal(result.total, 100);
    });

    it('balance 가 있으면 균형 칸이 맨 앞에 붙고 가장 큰 배점을 갖는다', () => {
        const doc = {
            inputMeals: [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '기록함'
        };
        const result = computeDietRecordScore(doc, { balance: 100, balanceNote: '고기와 채소가 반반' });
        assert.deepEqual(sectionKeys(result), ['balance', 'main', 'depth', 'journal']);
        const balance = result.sections[0];
        assert.equal(balance.got, 40);
        assert.equal(balance.max, 40);
        assert.ok(balance.max > result.sections[1].max, '균형이 가장 큰 배점이어야 한다');
        assert.equal(balance.detail, '고기와 채소가 반반');
        assert.equal(result.total, 100);
    });

    it('균형이 절반이면 그만큼만 깎인다', () => {
        const doc = {
            inputMeals: [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '기록함'
        };
        const result = computeDietRecordScore(doc, { balance: 50, balanceNote: '밥·면 위주' });
        assert.equal(sectionGot(result, 'balance'), 20);
        assert.equal(result.total, 80);
    });

    it('balanceNote 가 비어 있어도 균형 칸은 설명을 갖는다', () => {
        const result = computeDietRecordScore(
            { inputMeals: [fullMeal('lunch')], inputDailyJournalComment: '' },
            { balance: 70, balanceNote: '' }
        );
        assert.ok(result.sections[0].detail.trim().length > 0);
    });

    it('기록이 하나도 없으면 0점', () => {
        const result = computeDietRecordScore({ inputMeals: [], inputDailyJournalComment: '' });
        assert.equal(result.total, 0);
    });

    it('장소와 함께도 기록 깊이에 들어간다', () => {
        const base = { slotId: 'lunch', photoCount: 1, rating: 4, satiety: null, comment: '괜찮음' };
        const withoutContext = computeDietRecordScore({
            inputMeals: [{ ...base, detailText: '외식' }],
            inputDailyJournalComment: ''
        });
        const withContext = computeDietRecordScore({
            inputMeals: [{ ...base, detailText: ['외식', '    장소: 회사 근처', '    함께: 동료'].join('\n') }],
            inputDailyJournalComment: ''
        });
        assert.ok(
            sectionGot(withContext, 'depth') > sectionGot(withoutContext, 'depth'),
            '장소·함께를 적으면 깊이 점수가 올라야 한다'
        );
        assert.equal(sectionGot(withContext, 'depth'), 25);
    });

    it('간식은 본식 점수에 영향을 주지 않는다 (감점도 가점도 없음)', () => {
        const mains = [fullMeal('morning'), fullMeal('lunch'), fullMeal('dinner')];
        assert.equal(sectionGot(computeDietRecordScore({ inputMeals: mains }), 'main'), 25);
        assert.equal(
            sectionGot(computeDietRecordScore({ inputMeals: [...mains, fullMeal('snack1')] }), 'main'),
            25
        );
    });

    it('"건너뜀"은 본식 기록으로 인정되고, 깊이 분모에서는 빠진다', () => {
        const skipped = { slotId: 'morning', detailText: '건너뜀', photoCount: 0, rating: null, comment: null };
        const result = computeDietRecordScore({
            inputMeals: [skipped, fullMeal('lunch'), fullMeal('dinner')],
            inputDailyJournalComment: '바빴다'
        });
        assert.equal(sectionGot(result, 'main'), 25);
        assert.equal(sectionGot(result, 'depth'), 25);
        assert.equal(result.total, 100);
    });

    it('본식 슬롯만 있고 내용을 안 채우면 본식 점수만 얻는다', () => {
        const result = computeDietRecordScore({
            inputMeals: [bareMeal('morning'), bareMeal('lunch'), bareMeal('dinner')],
            inputDailyJournalComment: ''
        });
        assert.equal(sectionGot(result, 'main'), 25);
        assert.equal(sectionGot(result, 'depth'), 0);
        assert.equal(result.total, Math.round((25 / 60) * 100));
    });

    it('같은 입력이면 항상 같은 점수', () => {
        const doc = {
            inputMeals: [fullMeal('morning'), bareMeal('lunch')],
            inputDailyJournalComment: '음'
        };
        assert.deepEqual(computeDietRecordScore(doc), computeDietRecordScore(doc));
    });

    it('점수는 0~100을 벗어나지 않고 각 항목은 배점을 넘지 않는다', () => {
        const result = computeDietRecordScore(
            {
                inputMeals: ['morning', 'lunch', 'dinner', 'snack1', 'snack2', 'night', 'pre_morning'].map(fullMeal),
                inputDailyJournalComment: '전부 기록'
            },
            { balance: 1000, balanceNote: '범위를 벗어난 값' }
        );
        assert.ok(result.total >= 0 && result.total <= 100);
        for (const s of result.sections) assert.ok(s.got <= s.max, `${s.key} 초과`);
    });

    it('하루소감만 있고 끼니 기록이 없으면 소감 배점만 얻는다', () => {
        const result = computeDietRecordScore({ inputMeals: [], inputDailyJournalComment: '오늘은 못 먹었다' });
        assert.equal(sectionGot(result, 'journal'), 10);
        assert.equal(result.total, Math.round((10 / 60) * 100));
    });
});
