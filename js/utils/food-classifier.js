/**
 * 음식 텍스트 → 형태·요리종류 분류기 (docs/entry-axes-and-tags-direction.md §5)
 *
 * 순수 동기 함수만 제공한다. 네트워크·DOM·전역 상태에 의존하지 않으며,
 * 실패는 빈 결과일 뿐 예외를 던지지 않는다 — 저장 경로에 영향을 줄 수 없다.
 *
 * 사전은 js/utils/food-dictionary.js 의 `음식 → { form, cuisine }` 단일 항목 구조다.
 * 매칭은 **최장 일치** — '탕수육' 이 '수육' 보다 길므로 먼저 잡힌다(부분문자열 오탐 차단).
 *
 * 형태(form)는 사용자가 고르는 주 축, 요리종류(cuisine)는 이름에서 도출되는 사실이라
 * 묻지 않고 자동으로 붙인다.
 */
import {
    FORM_CATEGORIES,
    CUISINE_CATEGORIES,
    MIXED_CUISINE,
    CUISINE_DOMINANCE_THRESHOLD,
    FOOD_ENTRIES_BY_LENGTH,
    ONE_CHAR_FOODS,
    DICTIONARY_SOURCE,
    CUISINE_EXEMPT_FORMS,
    formUsesCuisine,
} from './food-dictionary.js';

export {
    FORM_CATEGORIES,
    CUISINE_CATEGORIES,
    MIXED_CUISINE,
    ONE_CHAR_FOODS,
    DICTIONARY_SOURCE,
    CUISINE_EXEMPT_FORMS,
    formUsesCuisine,
};
export {
    setFoodDictionaryOverrides,
    getFoodDictionaryOverrides,
    isBaseFoodEntry,
    getBaseFoodEntry,
    FOOD_ENTRIES,
} from './food-dictionary.js';

/**
 * @deprecated 형태 축의 옛 이름. 차트 화이트리스트 등 기존 호출부 호환용 별칭이다.
 * 새 코드는 FORM_CATEGORIES 를 쓴다.
 */
export const AUTO_CATEGORIES = FORM_CATEGORIES;

/** 수량·단위 접미 제거: "닭다리살100", "계란 2알", "밥1/2공기" → 음식명만 남긴다 */
const QUANTITY_SUFFIX_RE = /[\d./~]+(?:개|알|봉|장|조각|숟|스푼|공기|그람|그램|인분|쪽|모|통|번|잔|병|캔|g|kg|ml|cc|l)?$/i;

/**
 * 무엇을_상세 텍스트를 음식 토큰으로 분해.
 * 실데이터 구분자: "+", ",", "，", 공백, 줄바꿈, "·"
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeFoodText(text) {
    if (!text || typeof text !== 'string') return [];
    return text
        .split(/[+,，·\s\n]+/)
        .map((raw) => raw.replace(QUANTITY_SUFFIX_RE, '').trim())
        .filter((t) => t.length >= 2 || ONE_CHAR_FOODS.has(t));
}

/**
 * 토큰 하나를 사전에서 찾는다. **최장 일치** — 토큰이 품은 사전 항목 중 가장 긴 것.
 * @param {string} token
 * @returns {{ form: string, cuisine: string } | null}
 */
function lookupToken(token) {
    const oneChar = ONE_CHAR_FOODS.get(token);
    if (oneChar) return oneChar;
    // FOOD_ENTRIES_BY_LENGTH 는 길이 내림차순이라 첫 일치가 곧 최장 일치다
    for (const entry of FOOD_ENTRIES_BY_LENGTH) {
        if (token.includes(entry.word)) return { form: entry.form, cuisine: entry.cuisine };
    }
    return null;
}

/**
 * 텍스트에서 형태·요리종류를 함께 추론한다.
 *
 * 집계: 토큰마다 최장 일치 1건씩만 투표한다(예전처럼 한 토큰이 여러 카테고리에
 * 표를 뿌리지 않는다). 형태는 최다 득표를 채택하고, 2위가 1위의 절반 이상이면
 * 복수 제안(최대 2개). 요리종류는 최다 득표 하나만, '기타' 는 다른 후보가 있으면 양보한다.
 *
 * @param {string} text 무엇을_상세 입력값
 * @param {Record<string, string[]>|null} [personalKeywords] 사용자 교정 학습 사전 (형태 축, 미연결)
 * @returns {{ forms: string[], cuisine: string|null }}
 */
export function classifyFoodDetail(text, personalKeywords = null) {
    try {
        const tokens = tokenizeFoodText(text);
        if (tokens.length === 0) return { forms: [], cuisine: null };

        const formVotes = {};
        const cuisineVotes = {};
        for (const token of tokens) {
            // 개인 사전이 전역 사전보다 우선 (형태 축에만 적용)
            let personalForm = null;
            if (personalKeywords) {
                for (const [form, keywords] of Object.entries(personalKeywords)) {
                    if (Array.isArray(keywords) && keywords.some((k) => k && token.includes(k))) {
                        personalForm = form;
                        break;
                    }
                }
            }
            if (personalForm) {
                formVotes[personalForm] = (formVotes[personalForm] || 0) + 1;
                continue;
            }
            const hit = lookupToken(token);
            if (!hit) continue;
            formVotes[hit.form] = (formVotes[hit.form] || 0) + 1;
            // 요리 종류를 묻지 않는 형태(과일·음료·채소)는 투표에 참여하지 않는다 —
            // "사과 + 짜장면"에서 사과가 중식의 지배율을 끌어내리면 안 된다
            if (hit.cuisine) cuisineVotes[hit.cuisine] = (cuisineVotes[hit.cuisine] || 0) + 1;
        }

        const rankedForms = Object.entries(formVotes).sort((a, b) => b[1] - a[1]);
        const forms = [];
        if (rankedForms.length > 0) {
            forms.push(rankedForms[0][0]);
            if (rankedForms[1] && rankedForms[1][1] >= rankedForms[0][1] / 2) forms.push(rankedForms[1][0]);
        }

        /**
         * 요리 종류: 지배적인 것 하나, 없으면 '혼합'.
         *
         * '기타'는 정보량이 없으므로 **분모에서 뺀다** — "탕수육 + 계란"에서 계란(기타)이
         * 중식의 지배율을 끌어내리면 안 된다. 구체적 종류가 하나도 없을 때만 '기타'다.
         *
         * 동점(김밥+떡볶이 = 한식1·분식1)을 먼저 등장한 토큰으로 찍던 임의 규칙을 없앤다.
         * 문턱을 못 넘으면 '혼합' — 억지로 하나를 고르지 않는 것이 정직하다.
         */
        const specific = Object.entries(cuisineVotes)
            .filter(([c]) => c !== '기타')
            .sort((a, b) => b[1] - a[1]);
        let cuisine = null;
        if (specific.length === 0) {
            cuisine = cuisineVotes['기타'] ? '기타' : null;
        } else {
            const specificTotal = specific.reduce((n, [, v]) => n + v, 0);
            cuisine = specific[0][1] / specificTotal > CUISINE_DOMINANCE_THRESHOLD
                ? specific[0][0]
                : MIXED_CUISINE;
        }

        return { forms, cuisine };
    } catch (_) {
        // 분류 실패는 "제안 없음"일 뿐이다 — 어떤 경우에도 호출부(입력·저장)로 전파하지 않는다
        return { forms: [], cuisine: null };
    }
}

/**
 * 텍스트 → 형태 카테고리 제안 (0~2개, 득표순).
 * @param {string} text
 * @param {Record<string, string[]>|null} [personalKeywords]
 * @returns {string[]}
 */
export function classifyFoodText(text, personalKeywords = null) {
    return classifyFoodDetail(text, personalKeywords).forms;
}

/**
 * 텍스트 → 요리 종류 (한식·중식·…). 자동 파생 전용이라 사용자에게 묻지 않는다.
 * @param {string} text
 * @returns {string|null}
 */
export function classifyCuisineText(text) {
    return classifyFoodDetail(text).cuisine;
}

/*
 * 간식 전용 분류 함수(classifySnackText)는 없다.
 * 끼니/간식은 기록 슬롯이 가르고 '무엇을' 축은 하나다 — 간식도 classifyFoodText 를 쓴다
 * (docs/food-category-auto-classification.md §6.2).
 */
