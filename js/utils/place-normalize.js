/**
 * 어디서(place) 어휘 정규화 — 분석·예측 전용
 *
 * 배경: 같은 장소가 여러 표기로 쪼개져 집계된다 (7~8월 실데이터:
 * 끼니 '우리집' 651 vs 간식 '집' 204 — 같은 곳인데 차트에서 두 줄).
 * 원인은 입력 어휘가 모드별로 갈렸던 것: 간식은 snackPlaceMain 칩(집·사무실·카페),
 * 끼니는 자유 텍스트 + 서브태그 기본값('우리집').
 *
 * 원칙: **저장된 원문은 절대 바꾸지 않는다.** 사용자가 쓴 표기는 사실이다.
 * 정규화는 집계(차트·랭킹)와 예측(최빈값 투표)이 읽을 때만 적용한다.
 *
 * 변형 테이블은 실데이터에 나타난 표기만 보수적으로 담는다 —
 * '본가'(부모님 집)처럼 의미가 다른 말을 '집'으로 뭉개면 데이터 오염이다.
 */

/** 변형 → 정규 라벨. 실관측 표기만, 의미가 확실한 것만 담는다 */
const PLACE_VARIANTS = new Map([
    ['우리집', '집'],
    ['자택', '집'],
    ['홈', '집'],
    ['home', '집'],
    ['회사', '사무실'],
    ['오피스', '사무실'],
    ['회사 사무실', '사무실'],
]);

/**
 * 장소 표기를 정규화한다. 매칭 실패 시 조사만 정리한 원문을 돌려준다.
 * @param {string} raw
 * @returns {string}
 */
export function normalizePlace(raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    // 조사 '에서' 제거: '집에서'→'집', '샵에서'→'샵' (2글자 이상 남을 때만 — '에서' 단독 방지)
    const stripped = t.endsWith('에서') && t.length > 2 ? t.slice(0, -2).trim() : t;
    const lower = stripped.toLowerCase();
    return PLACE_VARIANTS.get(stripped) || PLACE_VARIANTS.get(lower) || stripped;
}

/**
 * 값 목록을 정규화 그룹으로 투표해 최빈 그룹을 찾고,
 * 그 그룹 안에서 **가장 흔한 원문 표기**를 대표로 돌려준다.
 * (예측이 사용자의 습관 어휘를 보존하게 — '우리집'파에게는 '우리집'을 제안)
 *
 * @param {string[]} values 원문 표기 목록
 * @returns {{ canonical: string, representative: string, count: number, total: number } | null}
 */
export function dominantPlaceGroup(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    /** canonical → { count, rawCounts: Map<raw, n> } */
    const groups = new Map();
    let total = 0;
    for (const v of values) {
        const raw = String(v || '').trim();
        if (!raw) continue;
        total += 1;
        const canonical = normalizePlace(raw);
        if (!groups.has(canonical)) groups.set(canonical, { count: 0, rawCounts: new Map() });
        const g = groups.get(canonical);
        g.count += 1;
        g.rawCounts.set(raw, (g.rawCounts.get(raw) || 0) + 1);
    }
    if (total === 0) return null;
    let topCanonical = null;
    let topGroup = null;
    for (const [canonical, g] of groups) {
        if (!topGroup || g.count > topGroup.count) {
            topCanonical = canonical;
            topGroup = g;
        }
    }
    let representative = topCanonical;
    let repN = 0;
    for (const [raw, n] of topGroup.rawCounts) {
        if (n > repN) {
            representative = raw;
            repN = n;
        }
    }
    return { canonical: topCanonical, representative, count: topGroup.count, total };
}
