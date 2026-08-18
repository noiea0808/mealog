/**
 * 분석 '무엇을' 차트의 두 번째 절단면 — 요리 종류(한식·중식…).
 *
 * 사용자가 고르는 값이 아니라 붙는 값이라, 무엇을 근거로 붙였는지가 전부다:
 * 저장된 cuisineAuto → 사용자가 직접 골랐던 옛 요리 종류 축 → 상세 텍스트 재분류.
 * 근거가 없으면 지어내지 않고 빈 값을 돌려준다(호출부가 '미입력'으로 접는다).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveCuisineForAnalytics, effectiveChartTag } from '../js/analytics/meal-analytics-tags.js';

/** 브라우저 전역 대역 — 파일럿 게이트·사용자 태그를 읽는 경로가 있다 */
beforeEach(() => {
    globalThis.window = { userSettings: { tags: {} } };
});

const meal = (extra) => ({ id: 'r1', date: '2026-08-18', slotId: 'lunch', ...extra });

describe('effectiveCuisineForAnalytics', () => {
    it('저장된 cuisineAuto 를 그대로 쓴다', () => {
        assert.equal(effectiveCuisineForAnalytics(meal({ cuisineAuto: '중식', menuDetail: '김치찌개' })), '중식');
    });

    it('cuisineAuto 가 없으면 상세 텍스트에서 파생한다 (옛 기록 마이그레이션 없이)', () => {
        assert.equal(effectiveCuisineForAnalytics(meal({ menuDetail: '짜장면' })), '중식');
    });

    /** 축 재편 전 사용자가 '무엇을'에서 직접 고른 값이라 재분류보다 신뢰도가 높다 */
    it('옛 무엇을 값이 요리 종류 축이면 그 값을 인정한다', () => {
        assert.equal(effectiveCuisineForAnalytics(meal({ category: '일식' })), '일식');
    });

    /** '카페'는 옛 기본 태그에만 있던 값 — 요리 종류 어휘에 없어 범례에 칸이 없다 */
    it("'카페'는 종류로 인정하지 않는다", () => {
        assert.notEqual(effectiveCuisineForAnalytics(meal({ category: '카페' })), '카페');
    });

    /** 새 형태 축 값은 종류가 아니다 — 여기서 걸러지지 않으면 범례에 '밥류'가 섞인다 */
    it('형태 축 값은 종류로 새어 나오지 않는다', () => {
        assert.equal(effectiveCuisineForAnalytics(meal({ category: '밥류' })), '');
    });

    it('근거가 없으면 빈 값 — 지어내지 않는다', () => {
        assert.equal(effectiveCuisineForAnalytics(meal({})), '');
        assert.equal(effectiveCuisineForAnalytics(null), '');
    });

    /**
     * 긴 기간의 차트는 기록 원문 대신 dailyStats 를 펼친 가상 레코드를 쓴다
     * (js/analytics/dashboard.js statsToFilteredData). 상세 텍스트가 없으므로 셀 수 없다.
     */
    it('집계에서 펼친 가상 레코드는 계산 대상이 아니다', () => {
        assert.equal(effectiveCuisineForAnalytics({ slotId: 'morning', category: '밥류' }), '');
    });

    it("차트 키 'cuisine' 으로도 같은 값이 나온다", () => {
        assert.equal(effectiveChartTag(meal({ menuDetail: '초밥' }), 'cuisine'), '일식');
    });
});
