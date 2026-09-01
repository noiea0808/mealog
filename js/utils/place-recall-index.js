/**
 * '어디서' 회상 색인 — 순수 로직 (DOM·네트워크 의존 없음, 단위 테스트 대상).
 * UI 는 맥락 줄의 어디서 피커(js/modals/entry-context-predict.js)가 담당한다.
 *
 * **이 색인이 카카오 호출을 막는 자리다.** 어디서 칸에 적히는 값의 상당수는
 * `우리집`·`사무실`·`구내식당`처럼 지도에서 찾을 것이 아니고, 식당 이름이라 해도
 * 한 번 간 곳을 또 가는 쪽이 흔하다. 친 글자로 **내 이력부터** 맞춰 보고 거기서
 * 나오면 네트워크를 아예 타지 않는다 (카카오 프록시는 사용자당 분당 15회·시간당
 * 100회 제한이 걸려 있다 — functions/index.js RATE_LIMITS.kakaoSearch).
 *
 * 표본은 window.mealHistory 하나뿐이라 추가 저장·네트워크가 0이다
 * ('무엇을' 회상과 같은 원천 — js/utils/what-recall-index.js).
 *
 * 순위는 **앞에서 시작하는 것 먼저, 그다음 많이 간 곳**이다. '스'를 쳤을 때
 * '스타벅스'가 '이삭토스트'보다 먼저 와야 한다 — 사람은 이름의 머리부터 친다.
 */

import { normalizePlace } from './place-normalize.js';
import { normalizePlaceSearchText } from './place-type.js';

/**
 * '자주 가는 곳'은 지금의 습관이어야 한다. 스캔은 싸지만 몇 년 전에 한 번 간 가게가
 * 올라오는 것이 문제다 (어디서 칩과 같은 상한 — entry-context-predict.js recentPlaceChips).
 */
export const HISTORY_SCAN_LIMIT = 200;
/** 칩 줄에 올릴 최대 개수 */
export const PLACE_SUGGEST_LIMIT = 6;
/**
 * 이 길이 미만은 후보를 못 좁힌다 — 카카오 검색의 최소 길이와 같게 둔다
 * (kakao-place.js KAKAO_SEARCH_MIN_LENGTH). 두 경로의 문턱이 다르면 로컬에만
 * 걸리는 구간이 생겨, 같은 글자를 쳤는데 어떤 날은 뜨고 어떤 날은 안 뜬다.
 */
export const PLACE_QUERY_MIN_LENGTH = 2;

/** 비교용 키 — 띄어쓰기·대소문자·가운뎃점 차이를 지운다 */
export function placeSearchKey(value) {
    return normalizePlaceSearchText(value);
}

/**
 * 검색어가 아직 안 여물었는가 — 마지막 글자가 **자모 단독**이면 참.
 *
 * 한글 IME 는 마지막 음절의 조합을 계속 열어 둔다. '한신포차'를 다 치고 손을 떼도
 * '차'는 여전히 조합 중이고, `compositionend` 는 **스페이스나 다음 글자를 칠 때에야**
 * 온다. 그래서 「조합 중이면 검색하지 않는다」로 막으면, 사용자가 보기에 *스페이스를
 * 쳐야 결과가 나오는* 물건이 된다 (2026-09-01 치프 지적, 실제로 그랬다).
 *
 * 정말 막아야 하는 것은 'ㅊ' 처럼 **자모만 남은 중간 상태**뿐이다. 그 글자로 검색해도
 * 나올 것이 없고 쿼터만 깎인다. 완성된 음절로 끝나면 조합이 열려 있어도 검색할 만하다.
 *
 * 범위는 호환 자모 영역(U+3131–U+318E, ㄱ … ㆎ) — IME 가 조합 중에 내놓는 그 값이다.
 */
export function hasTrailingJamo(query) {
    const last = String(query || '').trim().slice(-1);
    return /[ㄱ-ㆎ]/.test(last);
}

/**
 * 이력 → 장소 후보 목록. 표기 흔들림('우리집'/'우리 집')은 한 그룹으로 묶고
 * **그 사람이 가장 자주 쓴 표기**를 대표로 삼는다 (어휘 보존 — 추천 칩과 같은 규칙).
 *
 * @param {any[]} history window.mealHistory
 * @returns {Array<{text: string, count: number, key: string}>} 많이 간 곳부터
 */
export function buildPlaceIndex(history) {
    try {
        const rows = Array.isArray(history) ? history : [];
        const values = rows
            .filter((r) => r && typeof r.place === 'string' && r.place.trim())
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
            .slice(0, HISTORY_SCAN_LIMIT)
            .map((r) => r.place.trim());

        /** @type {Map<string, Map<string, number>>} 정규화키 → 원문별 횟수 */
        const groups = new Map();
        for (const v of values) {
            const key = normalizePlace(v) || v;
            if (!groups.has(key)) groups.set(key, new Map());
            const inner = groups.get(key);
            inner.set(v, (inner.get(v) || 0) + 1);
        }

        return [...groups.values()]
            .map((inner) => {
                let text = '';
                let count = 0;
                let best = 0;
                for (const [raw, n] of inner) {
                    count += n;
                    if (n > best) {
                        best = n;
                        text = raw;
                    }
                }
                return { text, count, key: placeSearchKey(text) };
            })
            .filter((it) => it.text)
            .sort((a, b) => b.count - a.count);
    } catch (_) {
        return [];
    }
}

/**
 * 친 글자로 이력을 좁힌다. 못 찾으면 빈 배열 — 호출부가 그때만 카카오를 부른다.
 *
 * @param {Array<{text:string,count:number,key:string}>} index buildPlaceIndex 결과
 * @param {string} query 사용자가 지금 친 글자
 * @param {number} limit
 * @returns {string[]} 대표 표기들
 */
export function pickPlaceSuggestions(index, query, limit = PLACE_SUGGEST_LIMIT) {
    const q = placeSearchKey(query);
    if (!q || q.length < PLACE_QUERY_MIN_LENGTH) return [];
    const rows = Array.isArray(index) ? index : [];

    const scored = [];
    for (const it of rows) {
        if (!it || !it.key) continue;
        const at = it.key.indexOf(q);
        if (at < 0) continue;
        /**
         * 친 글자와 **완전히 같은** 후보는 뺀다. 그 값은 이미 입력칸에 적혀 있어
         * 칩으로 다시 내밀 것이 없고, 자리만 차지해 다른 후보를 밀어낸다.
         */
        if (it.key === q) continue;
        scored.push({ text: it.text, head: at === 0 ? 0 : 1, count: it.count });
    }

    return scored
        .sort((a, b) => a.head - b.head || b.count - a.count)
        .slice(0, Math.max(0, limit))
        .map((it) => it.text);
}
