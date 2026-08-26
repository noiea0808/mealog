/**
 * '무엇을' 텍스트 → 어떻게(조달 방식) 힌트
 * (docs/entry-axes-and-tags-direction.md §5)
 *
 * 음식 **카테고리**(밥/한상·면…)는 조달 방식을 거의 알려주지 않는다 — 면은 집에서도
 * 끓이고 배달로도 오고 식당에서도 먹는다. 반면 사용자가 적은 **원문 텍스트**에는
 * 조달 정보가 직접 들어 있는 경우가 있다("배민 치킨", "구내식당 백반", "회식").
 * 카테고리 대신 이 원문을 보는 것이 훨씬 강한 신호다.
 *
 * 정밀도 우선 사전이다 — 재현율을 포기하더라도 오탐을 만들지 않는다.
 * 추측은 점선으로 표시되고 토글이 꺼져 있으면 저장되지도 않지만, 틀린 추측은
 * "대충 만든 앱" 인상을 주므로 애매한 말('포장'·'맛집' 등)은 넣지 않는다.
 *   - '포장' 제외: "포장김치"·"포장마차"에 걸린다
 *   - '맥주'·'소주' 제외: 집에서 마시는 경우가 흔하다
 */

/** 조달 방식 → 고정밀 키워드. 값은 mealType 축의 표기와 같아야 한다 */
const PROCUREMENT_KEYWORDS = {
    '배달/포장': ['배달', '배민', '쿠팡이츠', '요기요', '땡겨요', '테이크아웃'],
    '구내식당': ['구내식당', '사내식당', '급식', '학식'],
    '회식/술자리': ['회식', '술자리'],
};

/**
 * 텍스트에서 조달 방식을 읽는다. 근거가 없으면 빈 문자열.
 *
 * @param {string} text 무엇을_상세 원문
 * @param {string[]|null} [allowedTypes] 사용자 mealType 태그 목록 —
 *   관리자가 축을 손댔을 때 목록 밖 값을 제안하는 사고를 막는다
 * @returns {string} mealType 값 또는 ''
 */
export function procurementHintFromText(text, allowedTypes = null) {
    try {
        const t = String(text || '').trim();
        if (!t) return '';
        const allowed = Array.isArray(allowedTypes) && allowedTypes.length ? new Set(allowedTypes) : null;
        for (const [mealType, keywords] of Object.entries(PROCUREMENT_KEYWORDS)) {
            if (allowed && !allowed.has(mealType)) continue;
            if (keywords.some((k) => t.includes(k))) return mealType;
        }
        return '';
    } catch (_) {
        return '';
    }
}

/** 관리자 분류사전 열람용 (읽기 전용) */
export { PROCUREMENT_KEYWORDS };
