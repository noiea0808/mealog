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
} from './food-dictionary.js';

export { FORM_CATEGORIES, CUISINE_CATEGORIES, MIXED_CUISINE, ONE_CHAR_FOODS, DICTIONARY_SOURCE };
export {
    setFoodDictionaryOverrides,
    getFoodDictionaryOverrides,
    isBaseFoodEntry,
    FOOD_ENTRIES,
} from './food-dictionary.js';

/**
 * @deprecated 형태 축의 옛 이름. 차트 화이트리스트 등 기존 호출부 호환용 별칭이다.
 * 새 코드는 FORM_CATEGORIES 를 쓴다.
 */
export const AUTO_CATEGORIES = FORM_CATEGORIES;

/**
 * 간식 사전은 기존 snackType 축(커피·차/음료·술/주류·베이커리·과자/스낵·아이스크림·과일/견과)을
 * 그대로 쓴다. 형태 축으로의 통합은 categoryAuto 실데이터 검증 뒤로 미뤄둔 3단계 과제다
 * (docs/entry-axes-and-tags-direction.md §3).
 */
export const SNACK_KEYWORDS = {
    '커피': ['아메리카노', '카페라떼', '라떼', '커피', '에스프레소', '콜드브루', '카페모카', '카푸치노'],
    '차/음료': [
        '녹차', '홍차', '보리차', '허브티', '캐모마일', '주스', '스무디', '에이드', '우유', '두유',
        '요거트', '요구르트', '식혜', '착즙', '탄산수', '콜라', '사이다', '이온음료', '레모네이드',
    ],
    '술/주류': ['맥주', '소주', '와인', '막걸리', '하이볼', '위스키', '사케', '칵테일', '샴페인'],
    '베이커리': [
        '소금빵', '식빵', '단팥빵', '크림빵', '바게트', '베이글', '크루아상', '치아바타', '스콘',
        '머핀', '마들렌', '휘낭시에', '케이크', '케익', '도넛', '크로플', '와플', '마카롱', '파이', '빵',
    ],
    '과자/스낵': [
        '쿠키', '비스킷', '크래커', '과자', '스낵', '감자칩', '도리토스', '꼬북칩', '새우깡', '팝콘',
        '젤리', '사탕', '초코', '초콜릿', '프레첼', '누룽지', '시리얼', '그래놀라', '에너지바',
    ],
    '아이스크림': ['아이스크림', '젤라또', '빙수', '소프트콘', '하드바', '샤베트'],
    '과일/견과': [
        '사과', '수박', '복숭아', '자두', '포도', '바나나', '딸기', '블루베리', '참외', '멜론',
        '키위', '오렌지', '망고', '파인애플', '체리', '과일', '견과', '아몬드', '호두', '캐슈넛',
    ],
};

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
            cuisineVotes[hit.cuisine] = (cuisineVotes[hit.cuisine] || 0) + 1;
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

/**
 * 간식 텍스트 → snackType 카테고리 추론.
 * 끼니와 달리 기존 축을 그대로 쓰므로, 사용자 태그 목록에 없는 값은 제안하지 않는다
 * (관리자가 축을 손댔을 때 분석 화이트리스트 밖 값을 제안하는 사고 방지).
 *
 * @param {string} text
 * @param {string[]|null} [allowedTags] userSettings.tags.snackType
 * @returns {string[]} 제안 카테고리 0~2개
 */
export function classifySnackText(text, allowedTags = null) {
    try {
        const tokens = tokenizeFoodText(text);
        if (tokens.length === 0) return [];
        const votes = {};
        for (const token of tokens) {
            for (const [category, keywords] of Object.entries(SNACK_KEYWORDS)) {
                if (keywords.some((k) => token.includes(k))) {
                    votes[category] = (votes[category] || 0) + 1;
                }
            }
        }
        const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
        if (ranked.length === 0) return [];
        const result = [ranked[0][0]];
        if (ranked[1] && ranked[1][1] >= ranked[0][1] / 2) result.push(ranked[1][0]);
        if (!Array.isArray(allowedTags) || allowedTags.length === 0) return result;
        const allowed = new Set(allowedTags);
        return result.filter((c) => allowed.has(c));
    } catch (_) {
        return [];
    }
}
