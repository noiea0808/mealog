/**
 * 식단분석이 읽는 '무엇을' 분류 — 확정값이 없으면 자동값.
 *
 * 배경: 2026-08 기록 시트 개편으로 「제안을 그대로 두고 저장」이 기본 동선이 됐다.
 * 그러면 category·snackType 은 비고 categoryAuto 에만 값이 들어간다. 그런데 서버는
 * 확정 필드만 읽고 있어서, 8/23 주 기준 **분류가 붙은 기록의 55%가 프롬프트에서
 * 통째로 빠졌다** (확정 10% / 자동만 55%). 화면에는 분류가 멀쩡히 보이니 눈에 안 띈다.
 *
 * 여기서 지키는 것 두 가지.
 *  1. 서버가 쓰는 간식 슬롯 목록이 js/constants.js 의 SLOTS 와 어긋나지 않는다.
 *  2. 서버 폴백 규칙이 클라이언트(effectiveCategoryForAnalytics)와 같은 답을 낸다.
 *
 * functions/index.js 는 Firebase 초기화를 끼고 있어 통째로 import 할 수 없다. 그래서
 * 소스에서 해당 조각만 떼어내 평가한다 — 함수가 사라지거나 이름이 바뀌면 여기서 걸린다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLOTS } from '../js/constants.js';

const fnSrc = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');

/** functions/index.js 에서 조각을 떼어 실제로 실행 가능한 함수로 만든다 */
function loadServerHelper() {
    const setDecl = /const ADMIN_SNACK_SLOT_IDS = new Set\(\[[^\]]*\]\);/.exec(fnSrc);
    assert.ok(setDecl, 'functions/index.js 에서 ADMIN_SNACK_SLOT_IDS 를 찾지 못했습니다');
    const fnDecl = /function adminMealAutoFormText\(d, labeled = false\) \{[\s\S]*?\n\}/.exec(fnSrc);
    assert.ok(fnDecl, 'functions/index.js 에서 adminMealAutoFormText 를 찾지 못했습니다');
    const factory = new Function(`${setDecl[0]}\n${fnDecl[0]}\nreturn { ADMIN_SNACK_SLOT_IDS, adminMealAutoFormText };`);
    return factory();
}

const { ADMIN_SNACK_SLOT_IDS, adminMealAutoFormText } = loadServerHelper();

describe('식단분석 분류 폴백 (2026-08-26)', () => {
    it('서버의 간식 슬롯 목록이 SLOTS 와 일치한다', () => {
        const fromConstants = SLOTS.filter((s) => s.type === 'snack').map((s) => s.id).sort();
        assert.deepEqual([...ADMIN_SNACK_SLOT_IDS].sort(), fromConstants);
    });

    it('확정값(category)이 있으면 자동값을 쓰지 않는다', () => {
        assert.equal(adminMealAutoFormText({ slotId: 'lunch', category: '밥류', categoryAuto: '고기·생선' }), '');
    });

    it('확정값(snackType)이 있으면 자동값을 쓰지 않는다', () => {
        assert.equal(adminMealAutoFormText({ slotId: 'snack1', snackType: '커피', categoryAuto: '베이커리/떡' }), '');
    });

    it('확정값이 비면 자동값을 쓴다 — 개편 이후의 기본 동선', () => {
        assert.equal(adminMealAutoFormText({ slotId: 'lunch', category: '', categoryAuto: '밥류' }), '밥류');
    });

    it('간식 슬롯의 자동값은 슬롯 상세에서 간식으로 표시된다', () => {
        const m = { slotId: 'snack2', categoryAuto: '커피' };
        assert.equal(adminMealAutoFormText(m, true), '간식:커피');
        // 한 줄 요약(labeled=false)은 라벨 없이 값만
        assert.equal(adminMealAutoFormText(m), '커피');
    });

    it('끼니 슬롯의 자동값에는 간식 라벨을 붙이지 않는다', () => {
        assert.equal(adminMealAutoFormText({ slotId: 'dinner', categoryAuto: '고기·생선' }, true), '고기·생선');
    });

    it('아무것도 없으면 빈 값', () => {
        assert.equal(adminMealAutoFormText({ slotId: 'lunch' }), '');
        assert.equal(adminMealAutoFormText({ slotId: 'lunch', categoryAuto: '   ' }), '');
        assert.equal(adminMealAutoFormText(null), '');
        assert.equal(adminMealAutoFormText(undefined, true), '');
    });

    it('캐시 지문에 categoryAuto 가 들어간다 — 안 넣으면 옛 리포트가 계속 나간다', () => {
        const src = /function buildDietReportSource\(meals\) \{[\s\S]*?\n\}/.exec(fnSrc);
        assert.ok(src, 'buildDietReportSource 를 찾지 못했습니다');
        assert.match(src[0], /m\.categoryAuto/, 'buildDietReportSource 의 지문에 categoryAuto 가 없습니다');
    });
});

/**
 * 함수 본문 정규식은 **리터럴로 둔다.** 템플릿 리터럴 안에서 조립하면 백슬래시가 한 번
 * 풀려 `\(` 가 `(` 로, `[\s\S]` 가 `[sS]` 로 바뀌면서 조용히 다른 패턴이 된다 — 한 번 당했다.
 */
const BODY_PATTERNS = [
    ['adminMealShortLine', /function adminMealShortLine\(d\) \{[\s\S]*?\n\}/],
    ['adminMealSlotDetailForGemini', /function adminMealSlotDetailForGemini\(d\) \{[\s\S]*?\n\}/]
];

describe('식단분석 분류 폴백 — 프롬프트 조립부가 실제로 폴백을 쓴다', () => {
    for (const [name, pattern] of BODY_PATTERNS) {
        it(`${name} 이 adminMealAutoFormText 를 호출한다`, () => {
            const body = pattern.exec(fnSrc);
            assert.ok(body, `${name} 을 찾지 못했습니다`);
            assert.match(body[0], /adminMealAutoFormText\(/, `${name} 이 자동 분류 폴백을 쓰지 않습니다`);
        });
    }
});
