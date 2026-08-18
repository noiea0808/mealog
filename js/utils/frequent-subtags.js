/**
 * 하위 값 빈도 추천 — 부모 축으로 좁힌 내 이력에서 자주 쓴 값을 앞에 세운다.
 * (docs/entry-axes-and-tags-direction.md §4 역할② 입력 가속)
 *
 * ## 왜 이력에서 세나
 *
 * 이 자리는 원래 **나만의 태그**(`favoriteSubTags`)가 채우던 곳이다. 사용자가 마이 > 태그에서
 * 미리 등록해 두면 서브 패널 '사용자' 블록에 뜨는 구조였는데, §4가 이미 답을 내놓았다 —
 * 태그가 작동하는 곳(어디서 재사용률 79%, 누구와 90%, 고유값 3~5개)은 정확히 **예측이
 * 상위 호환인 곳**이다. 매번 같은 3개 중 하나를 고르는 일은 목록을 손으로 관리하지 않아도
 * 이력이 대신 안다.
 *
 * 그래서 수동 등록을 걷어내고 이 모듈로 갈음했다 (2026-08-18).
 *
 * ## 규칙
 *
 * - **상위 축이 하위 선택지를 좁힌다** (§5). 집밥을 골랐는데 식당 이름이 뜨지 않게, 부모
 *   값이 같은 기록만 표본으로 삼는다. 하드코딩된 분류표가 아니라 사용자 자신의 이력이다.
 * - **최근 것만 본다** (`SCAN_LIMIT`). 스캔은 O(n)이라 싸지만 5년 전 어휘가 올라오는 것이
 *   문제다 — '자주'는 지금의 습관이어야 한다 (what-recall-index.js 와 같은 판단).
 * - **표기는 사용자 어휘를 보존한다.** 흔들리는 표기('아아'/'아이스 아메리카노')는 한 항목으로
 *   묶어 세되, 화면에 세우는 것은 **그가 가장 많이 쓴 원문**이다.
 * - **자동으로 채워진 값은 표본에서 뺀다** (`autoContext`). 추측이 추측을 강화하는 루프를
 *   막는다 — entry-context-predict.js `usableRecords` 와 같은 규칙이다.
 */

/** '자주'를 지금의 습관으로 유지하는 스캔 상한 */
export const SCAN_LIMIT = 500;

/** 건너뜀 기록은 어떤 축의 표본도 아니다 */
const SKIP_VALUES = new Set(['건너뜀', 'Skip']);

/** 표기 흔들림을 흡수하는 비교 키 — 공백·대소문자 차이는 같은 항목으로 본다 */
export function normSubTagKey(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** @param {any} r */
function isSkip(r) {
    return SKIP_VALUES.has(String(r?.mealType || '').trim());
}

/** 쉼표 다중값 필드(menuDetail·withWhomDetail)를 항목 단위로 편다 */
function valuesOf(raw, splitCommas) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return [];
    if (!splitCommas) return [text];
    return text.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
}

/**
 * 부모로 좁힌 이력에서 값을 빈도순으로 뽑는다 — 순수 함수.
 *
 * @param {any[]} history window.mealHistory
 * @param {object} opts
 * @param {string} opts.field 값 필드 (place · withWhomDetail · menuDetail)
 * @param {string} [opts.parentField] 부모 필드 (mealType · snackPlaceMain · withWhom · category)
 * @param {string} [opts.parent] 부모 값. 없으면 전체 이력에서 뽑는다
 * @param {string[]} [opts.parentFallbackFields] 부모 값이 다른 필드에 들어 있을 수 있을 때
 *   (간식 장소는 `snackPlaceMain` 이 비고 `place` 에만 있는 옛 기록이 있다)
 * @param {boolean} [opts.splitCommas] 쉼표 다중값 필드인가
 * @param {number} [opts.limit]
 * @param {(v: string) => string} [opts.normalize] 그룹핑 키 (기본: 공백·대소문자 무시)
 * @returns {string[]} 빈도 내림차순, 동률이면 최근 것 우선
 */
export function frequentSubTagValues(history, opts) {
    const {
        field,
        parentField,
        parent,
        parentFallbackFields,
        splitCommas = false,
        limit = 10,
        normalize = normSubTagKey,
    } = opts || {};
    if (!Array.isArray(history) || !field) return [];

    const wantedParent = String(parent || '').trim();
    const parentFields = [parentField, ...(parentFallbackFields || [])].filter(Boolean);

    const matchesParent = (r) => {
        if (!wantedParent || parentFields.length === 0) return true;
        return parentFields.some((f) => String(r?.[f] || '').trim() === wantedParent);
    };

    /** @type {Map<string, {total: number, recency: number, variants: Map<string, number>}>} */
    const groups = new Map();
    let scanned = 0;

    for (const r of history) {
        if (scanned >= SCAN_LIMIT) break;
        if (!r || isSkip(r)) continue;
        // 자동으로 채운 값은 사용자가 쓴 어휘가 아니다
        if (Array.isArray(r.autoContext) && r.autoContext.includes(field)) continue;
        if (!matchesParent(r)) continue;

        const values = valuesOf(r[field], splitCommas);
        if (values.length === 0) continue;
        scanned += 1;

        // history 는 최신이 앞 — 먼저 만난 것이 더 최근이다
        const recency = SCAN_LIMIT - scanned;
        for (const value of values) {
            const key = normalize(value) || value;
            let g = groups.get(key);
            if (!g) {
                g = { total: 0, recency, variants: new Map() };
                groups.set(key, g);
            }
            g.total += 1;
            g.variants.set(value, (g.variants.get(value) || 0) + 1);
        }
    }

    return [...groups.values()]
        .sort((a, b) => b.total - a.total || b.recency - a.recency)
        .slice(0, limit)
        .map((g) => {
            // 같은 항목의 여러 표기 중 사용자가 가장 많이 쓴 원문 (어휘 보존)
            let rep = '';
            let best = -1;
            for (const [text, n] of g.variants) {
                if (n > best) {
                    best = n;
                    rep = text;
                }
            }
            return rep;
        })
        .filter(Boolean);
}
