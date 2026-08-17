/**
 * '무엇을' 회상 색인 — 순수 로직 (DOM·Firebase 의존 없음, 단위 테스트 대상).
 * UI 는 js/modals/entry-what-recall.js 가 담당한다.
 *
 * 핵심 판단은 **항목 단위**로 센다는 것이다. 원문 전체("김치찌개, 계란말이, 밥")가 통째로
 * 반복될 일은 없지만 '김치찌개'는 반복된다. 저장 쪽도 이미 같은 단위로 기억한다
 * (entry-save-subtags.js rememberCommaSeparatedSubTags).
 */

export const SPLIT_RE = /[,，]/;

/** 이보다 긴 항목은 음식 이름이 아니라 문장이다 — 칩에 안 맞고 재사용도 안 된다 */
export const MAX_ITEM_LEN = 20;
/**
 * '자주'는 지금의 습관이어야 하므로 최근 기록만 본다.
 * 스캔은 O(n)이라 싸지만(entry-axes-and-tags-direction.md §5 실측 10,000건 72ms)
 * 5년 전 어휘가 올라오는 것이 문제다.
 */
export const HISTORY_SCAN_LIMIT = 500;
/** frequent 칩을 '자주'라 부를 수 있는 최소 개수 — 못 채우면 1회성으로 메운다(콜드 스타트) */
export const STRONG_MIN = 3;

/** 표기 흔들림을 흡수하는 비교 키 — 공백·대소문자 차이는 같은 항목으로 본다 */
export function normKey(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 마지막 쉼표를 기준으로 "이미 확정된 앞부분"과 "지금 적고 있는 항목"을 가른다.
 * '무엇을'은 쉼표 다중값이라 자동완성의 대상은 언제나 마지막 항목뿐이다.
 * @returns {{head:string, active:string}} head 는 쉼표까지 포함한다
 */
export function splitActive(value) {
    const s = String(value || '');
    const m = /[,，][^,，]*$/.exec(s);
    if (!m) return { head: '', active: s };
    return { head: s.slice(0, m.index + 1), active: s.slice(m.index + 1) };
}

/** 입력란에 이미 들어 있는 항목 — 같은 걸 다시 권하지 않는다 */
export function usedKeys(value) {
    const set = new Set();
    for (const raw of String(value || '').split(SPLIT_RE)) {
        const k = normKey(raw);
        if (k) set.add(k);
    }
    return set;
}

/** 같은 항목의 여러 표기 중 사용자가 가장 많이 쓴 원문 (습관 어휘 보존 — recentPlaceChips 와 같은 규칙) */
function topVariant(variants) {
    let best = '';
    let bestN = -1;
    for (const [text, n] of variants) {
        if (n > bestN) {
            best = text;
            bestN = n;
        }
    }
    return best;
}

/**
 * 이력에서 항목 단위 색인을 만든다.
 *
 * 끼니/간식은 섞지 않는다 — 간식 칸에 '삼겹살'이 뜨면 소음이다. 맥락 예측이 슬롯 표본을
 * 같은 종류로 좁힌 것과 같은 이유(entry-axes-and-tags-direction.md §5).
 *
 * 슬롯 판정·건너뜀 판정은 주입받는다. 이 둘은 entry-context-predict.js 가 이미 정의하고
 * 있어서, 여기서 다시 쓰면 세 번째 사본이 된다(SNACK_SLOT_IDS 는 charts.js 와도 동기화 대상).
 *
 * @param {any[]} records window.mealHistory
 * @param {{slotId:string, isSnackSlot:(s:string)=>boolean, isSkipRecord:(r:any)=>boolean}} deps
 * @returns {Array<{key:string,text:string,total:number,slotHits:number,lastDate:string}>}
 */
export function buildRecallIndex(records, { slotId, isSnackSlot, isSkipRecord }) {
    const targetSlot = String(slotId || '');
    const wantSnack = isSnackSlot(targetSlot);
    const recent = [...(Array.isArray(records) ? records : [])]
        .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))
        .slice(0, HISTORY_SCAN_LIMIT);

    /** @type {Map<string, {key:string,variants:Map<string,number>,total:number,slotHits:number,lastDate:string}>} */
    const map = new Map();
    for (const r of recent) {
        if (!r || isSkipRecord(r)) continue;
        if (isSnackSlot(String(r.slotId || '')) !== wantSnack) continue;
        const detail = typeof r.menuDetail === 'string' ? r.menuDetail : '';
        if (!detail.trim()) continue;
        const date = String(r.date || '');
        const sameSlot = String(r.slotId || '') === targetSlot;
        // 한 기록 안에서 같은 항목이 두 번 나와도 1회로 센다
        const seen = new Set();
        for (const raw of detail.split(SPLIT_RE)) {
            const text = raw.trim();
            if (!text || text.length > MAX_ITEM_LEN) continue;
            const key = normKey(text);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            let e = map.get(key);
            if (!e) {
                e = { key, variants: new Map(), total: 0, slotHits: 0, lastDate: '' };
                map.set(key, e);
            }
            e.variants.set(text, (e.variants.get(text) || 0) + 1);
            e.total += 1;
            if (sameSlot) e.slotHits += 1;
            if (date > e.lastDate) e.lastDate = date;
        }
    }
    return [...map.values()].map((e) => ({
        key: e.key,
        text: topVariant(e.variants),
        total: e.total,
        slotHits: e.slotHits,
        lastDate: e.lastDate,
    }));
}

function byRecent(a, b) {
    return b.lastDate.localeCompare(a.lastDate);
}

function byTotal(a, b) {
    return b.total - a.total || byRecent(a, b);
}

/** 슬롯 우선 + 빈도 — "이 시간에 내가 자주 적은 것"이 먼저다 */
function bySlotThenTotal(a, b) {
    return b.slotHits - a.slotHits || byTotal(a, b);
}

/**
 * 빈 항목에 포커스했을 때의 칩.
 * @param {ReturnType<typeof buildRecallIndex>} index
 */
export function pickFrequent(index, currentValue, limit) {
    const used = usedKeys(currentValue);
    const pool = index.filter((e) => !used.has(e.key));
    const strong = [
        ...pool.filter((e) => e.slotHits >= 2).sort(bySlotThenTotal),
        ...pool.filter((e) => e.slotHits < 2 && e.total >= 2).sort(byTotal),
    ];
    // 반복된 항목이 몇 개 안 되는 초기 사용자에게는 1회성이라도 보여준다 (없는 것보단 낫다)
    const filled = strong.length >= STRONG_MIN
        ? strong
        : [...strong, ...pool.filter((e) => e.slotHits < 2 && e.total < 2).sort(byRecent)];
    return filled.slice(0, limit);
}

/**
 * 적는 중일 때의 칩. query 는 normKey 를 통과한 값이어야 한다.
 * @param {ReturnType<typeof buildRecallIndex>} index
 */
export function pickTypeahead(index, query, currentValue, limit) {
    if (!query) return [];
    const used = usedKeys(currentValue);
    const pool = index.filter((e) => !used.has(e.key) && e.key.includes(query));
    pool.sort((a, b) => {
        // 앞에서부터 맞는 쪽이 먼저 — '김'을 쳤으면 '김치찌개'가 '어묵김밥'보다 위
        const ap = a.key.startsWith(query) ? 0 : 1;
        const bp = b.key.startsWith(query) ? 0 : 1;
        return ap - bp || bySlotThenTotal(a, b);
    });
    return pool.slice(0, limit);
}
