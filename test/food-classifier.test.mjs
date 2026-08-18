/**
 * 음식 분류 — 사전이 커질 때 조용히 무너지는 자리를 지킨다.
 *
 * 설계: `docs/entry-axes-and-tags-direction.md` §5, `js/utils/food-dictionary.js` 머리주석.
 *
 * 분류기는 **최장 일치**라, 사전에 재료 이름을 하나 넣으면 그 재료로 시작하는 기존
 * 조합어의 판정이 통째로 바뀔 수 있다. '오징어'(3글자)를 넣는 순간 '오징어덮밥'이
 * 밥류에서 고기·생선으로 넘어가는 식이다 — 사전만 보고는 안 보이고, 쓰다가 발견된다.
 *
 * 그래서 여기서 지키는 것은 개별 음식의 라벨이 아니라 **누가 이겨야 하는가**다:
 *   - 요리형(덮밥·죽·김밥·전골·튀김·국)이 붙으면 재료가 아니라 요리형이 이긴다
 *   - 한 글자 항목('전'·'배'·'떡')은 그것을 품은 두 글자 이상 항목에게 진다
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFoodDetail, classifyFoodText } from '../js/utils/food-classifier.js';
import { FOOD_ENTRIES, DICTIONARY_SOURCE } from '../js/utils/food-dictionary.js';

/** @param {string} text */
const formOf = (text) => classifyFoodText(text)[0] ?? null;

describe('사전 자체의 건강성', () => {
    it('같은 음식이 두 칸에 적혀 있지 않다', () => {
        const seen = new Map();
        const dups = [];
        for (const [form, byCuisine] of Object.entries(DICTIONARY_SOURCE)) {
            for (const [cuisine, list] of Object.entries(byCuisine)) {
                for (const word of list) {
                    if (seen.has(word)) dups.push(`${word} (${seen.get(word)} · ${form}/${cuisine})`);
                    else seen.set(word, `${form}/${cuisine}`);
                }
            }
        }
        assert.deepEqual(dups, []);
    });

    /**
     * 한 글자 항목은 부분문자열로 아무 데나 붙는다 — '배'가 '배추'를, '전'이 '호박전'을
     * 가로채는 식이다. 이미 들어와 있는 것들은 최장 일치로 막고 있으니 **늘리지만 않으면** 된다.
     */
    it('한 글자 항목이 늘지 않았다', () => {
        const oneChar = [...FOOD_ENTRIES.keys()].filter((w) => w.length === 1).sort();
        assert.deepEqual(oneChar, ['감', '귤', '난', '떡', '배', '전', '죽', '회']);
    });
});

describe('요리형이 재료를 이긴다', () => {
    const CASES = [
        // [입력, 기대 형태] — 재료 이름이 요리형보다 길어도 요리형이 이겨야 하는 자리
        ['오징어덮밥', '밥류'],
        ['낙지덮밥', '밥류'],
        ['오징어김밥', '밥류'],
        ['소시지김밥', '밥류'],
        ['버섯죽', '밥류'],
        ['새우죽', '밥류'],
        ['계란밥', '밥류'],
        ['간장계란밥', '밥류'],
        ['오징어전골', '국물요리'],
        ['낙지전골', '국물요리'],
        ['계란국', '국물요리'],
        ['소고기무국', '국물요리'],
        ['배춧국', '국물요리'],
        ['홍합탕', '국물요리'],
        ['연근튀김', '튀김·분식'],
        ['버섯튀김', '튀김·분식'],
        ['새우튀김', '튀김·분식'],
        ['김치말이국수', '면류'],
    ];
    for (const [text, expected] of CASES) {
        it(`${text} → ${expected}`, () => assert.equal(formOf(text), expected));
    }
});

describe('한 글자 항목보다 긴 이름이 이긴다', () => {
    const CASES = [
        ['배추', '채소·샐러드'], // '배'(과일)에 지면 안 된다
        ['배추김치', '반찬류'],
        ['떡갈비', '고기·생선'], // '떡'(베이커리)에 지면 안 된다
        ['빈대떡', '반찬류'], // 같은 이유 — 부침개는 떡이 아니다
        ['탕수육', '고기·생선'], // 사전 머리주석이 드는 원래 사례 — '수육'에 지면 안 된다
    ];
    for (const [text, expected] of CASES) {
        it(`${text} → ${expected}`, () => assert.equal(formOf(text), expected));
    }
});

/**
 * 부식 강등 — 반찬을 제 칸으로 뺀 대가로 생기는 유일한 위험이 "밥상이 반찬으로 분류되는 것"이라,
 * 여기가 이 개편의 핵심 방어선이다. 강등이 과하면 양식·일식 끼니가 망가지고,
 * 모자라면 한식 밥상이 반찬류로 넘어간다.
 */
describe('부식 강등 — 몸통이 있으면 반찬은 대표가 아니다', () => {
    it('반찬 표가 더 많아도 밥상의 대표는 밥류다', () => {
        // 반찬 3표(김치·나물·계란말이) vs 밥류 1표 — 강등이 없으면 반찬류가 이긴다
        assert.equal(formOf('잡곡밥 + 김치 + 나물 + 계란말이'), '밥류');
    });

    it('국물요리도 몸통이라 반찬을 강등한다', () => {
        assert.equal(formOf('김치찌개 + 김치 + 계란말이'), '국물요리');
    });

    it('고기가 주인공인 상에서도 반찬은 물러난다', () => {
        assert.equal(classifyFoodText('삼겹살 + 김치 + 상추')[0], '고기·생선');
    });

    it('몸통이 없으면 반찬류가 그대로 대표다 — 강등은 조건부다', () => {
        assert.equal(formOf('김치 + 나물'), '반찬류');
        assert.equal(formOf('계란말이'), '반찬류');
    });

    /** 강등은 "한 상의 주인공"을 가리는 규칙이지, 아무 음식이나 반찬을 이기는 규칙이 아니다 */
    it('간식·기호품은 몸통이 아니라 반찬을 강등하지 못한다', () => {
        assert.deepEqual(classifyFoodText('김치 + 커피'), ['반찬류', '커피']);
    });

    it('강등돼도 요리 종류 투표에는 남는다 — 밥 한 공기가 상의 종류를 정하면 안 된다', () => {
        const r = classifyFoodDetail('잡곡밥 + 김치 + 나물 + 계란말이');
        assert.equal(r.forms[0], '밥류');
        assert.equal(r.cuisine, '한식');
    });
});

/** 조리법 기반 표준은 국적을 묻지 않는다 — 반찬류 신설이 양식·일식에 중립인지 */
describe('반찬류 신설이 비한식 끼니를 건드리지 않는다', () => {
    const CASES = [
        ['파스타', '면류', '양식'],
        ['초밥', '밥류', '일식'],
        ['라멘', '면류', '일식'],
        ['탕수육', '고기·생선', '중식'],
        ['햄버거', '빵류', '패스트푸드'],
    ];
    for (const [text, form, cuisine] of CASES) {
        it(`${text} → ${form} · ${cuisine}`, () => {
            const r = classifyFoodDetail(text);
            assert.equal(r.forms[0], form);
            assert.equal(r.cuisine, cuisine);
        });
    }

    it('주식이 없는 양식 한 상도 그대로다', () => {
        assert.deepEqual(classifyFoodText('스테이크 + 샐러드'), ['고기·생선', '채소·샐러드']);
    });
});

describe('요리 종류는 사실이라 자동으로 붙는다', () => {
    it('간식·기호품은 요리 종류를 묻지 않는다 — 빈 값', () => {
        assert.equal(classifyFoodDetail('아이스티').cuisine, null);
        assert.equal(classifyFoodDetail('초코파이').cuisine, null);
    });

    it('한 끼를 통째로 적어도 지배적인 종류를 집는다', () => {
        const r = classifyFoodDetail('잡곡밥 + 김치찌개 + 계란말이 + 김치');
        assert.equal(r.forms[0], '밥류');
        assert.equal(r.cuisine, '한식');
    });

    /** 과일·음료가 끼어도 요리 종류의 지배율을 끌어내리면 안 된다 (분류기 주석의 규칙) */
    it('요리 종류가 없는 음식은 지배율 분모에서 빠진다', () => {
        assert.equal(classifyFoodDetail('탕수육 + 사과').cuisine, '중식');
    });
});

describe('분류 실패는 조용하다', () => {
    it('빈 값·모르는 말에도 예외를 던지지 않는다', () => {
        for (const bad of ['', '   ', null, undefined, 42, {}]) {
            assert.deepEqual(classifyFoodDetail(/** @type {any} */ (bad)), { forms: [], cuisine: null });
        }
    });
});
