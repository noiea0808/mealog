/**
 * 카카오 장소 → placeType(장소 카테고리) 파생 (docs/entry-axes-and-tags-direction.md §5)
 *
 * 사용자가 직접 고른 장소의 객관 속성이므로 사실-유도다 — categoryAuto처럼
 * 확인 없이 자동 저장한다. 추측(습관-추측)이 아니라서 원칙 2와 충돌하지 않는다.
 *
 * 어디서 통계의 집계 축이 상호명 파편이 아니라 이 카테고리가 되는 것이 목적.
 * 값은 place-normalize의 정규 라벨과 같은 층위: 식당 · 카페 · 편의점 · 술집.
 */

/**
 * @param {string|null|undefined} categoryGroupCode 카카오 category_group_code (FD6·CE7·CS2…)
 * @param {string|null|undefined} categoryName 카카오 category_name ("음식점 > 한식 > 냉면")
 * @returns {''|'식당'|'카페'|'편의점'|'술집'} 판정 불가는 빈 문자열 — 저장 경로에 영향 금지
 */
export function placeTypeFromKakaoCategory(categoryGroupCode, categoryName) {
    try {
        const name = String(categoryName || '');
        // 술집은 FD6(음식점) 하위로 오므로 코드보다 먼저 본다
        if (name.includes('술집') || name.includes('호프') || name.includes('요리주점')) return '술집';
        const code = String(categoryGroupCode || '');
        if (code === 'CE7') return '카페';
        if (code === 'CS2') return '편의점';
        if (code === 'FD6') return '식당';
        // 코드가 없는 데이터(구버전 placeData·SDK 변형)는 이름으로 추정
        if (name.includes('카페') || name.includes('제과') || name.includes('베이커리') || name.includes('디저트')) return '카페';
        if (name.includes('편의점')) return '편의점';
        if (name.includes('음식점') || name.includes('식당') || name.includes('레스토랑')) return '식당';
        return '';
    } catch (_) {
        return '';
    }
}

/**
 * 검색 결과에 남길 장소 종류인지 판정 (검색 필터).
 * 기존에는 FD6(음식점)만 통과했는데, 어디서 축 통합으로 카페·편의점이 1급 장소가 되어
 * 식음 관련 카테고리 전체로 넓힌다. 역·병원 같은 무관 장소는 계속 거른다.
 * functions/index.js searchKakaoPlaces의 서버 필터와 같은 기준을 유지할 것.
 * @param {{ category_group_code?: string, category_name?: string }} place
 */
export function isFoodRelatedKakaoPlace(place) {
    const code = String(place?.category_group_code || '');
    if (code === 'FD6' || code === 'CE7' || code === 'CS2') return true;
    const cat = String(place?.category_name || '').toLowerCase();
    return (
        cat.includes('음식점') || cat.includes('식당') || cat.includes('카페') ||
        cat.includes('레스토랑') || cat.includes('맛집') || cat.includes('요리') ||
        cat.includes('식음료') || cat.includes('제과') || cat.includes('베이커리') ||
        cat.includes('술집') || cat.includes('바') || cat.includes('편의점')
    );
}

/**
 * 된소리를 예사소리로 눕힌 초성 매핑 (ㄲ→ㄱ, ㄸ→ㄷ, ㅃ→ㅂ, ㅆ→ㅅ, ㅉ→ㅈ).
 * 「돈까스」와 「돈가스」처럼 같은 가게를 두 표기로 적는 일이 흔하다.
 */
const CHOSEONG_TENSE_TO_PLAIN = { 1: 0, 4: 3, 8: 7, 10: 9, 13: 12 };

/** 한글 음절의 초성만 예사소리로 바꾼다 (중성·종성은 그대로) */
function softenKoreanTenseConsonants(text) {
    let out = '';
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code >= 0xac00 && code <= 0xd7a3) {
            const idx = code - 0xac00;
            const cho = Math.floor(idx / 588);
            const plain = CHOSEONG_TENSE_TO_PLAIN[cho];
            if (plain !== undefined) {
                out += String.fromCharCode(0xac00 + plain * 588 + (idx % 588));
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/** 상호명·검색어 비교용 정규화 — 띄어쓰기·구분기호·된소리 차이를 없앤다 */
export function normalizePlaceSearchText(value) {
    return softenKoreanTenseConsonants(String(value || '').toLowerCase()).replace(
        /[\s·・()[\]{}\-_,./'"]/g,
        ''
    );
}

/**
 * 상호명이 검색어와 얼마나 맞는지. 2=통째로 들어감, 1=낱말 하나가 들어감, 0=안 맞음.
 *
 * 카카오 로컬 API 는 상호명뿐 아니라 **업종·메뉴 분류까지** 매칭한다. 「돈까스」로 찾으면
 * 카테고리가 `돈까스,우동` 인 가게가 전부 걸려서, 실측 15건 중 상호명이 맞는 건 3건뿐이었다.
 * API 에 「상호명만」 옵션이 없어 받아온 뒤 순서를 바로잡는다.
 */
export function kakaoPlaceNameMatchScore(placeName, keyword) {
    const name = normalizePlaceSearchText(placeName);
    const query = normalizePlaceSearchText(keyword);
    if (!name || !query) return 0;
    if (name.includes(query)) return 2;
    // 「강남 돈까스」처럼 여러 낱말이면 하나라도 상호명에 있으면 건진다.
    // 한 글자짜리는 아무 데나 걸려서 뺀다.
    const tokens = String(keyword || '')
        .split(/\s+/)
        .map(normalizePlaceSearchText)
        .filter((t) => t.length >= 2);
    return tokens.some((t) => name.includes(t)) ? 1 : 0;
}

/**
 * 상호명이 맞는 가게를 위로 올린다. **거르지는 않는다** —
 * 가게 이름을 모른 채 업종으로 찾는 경우도 있어서, 순서만 바로잡고 남겨 둔다.
 * 같은 점수끼리는 카카오가 준 순서(거리·인기도)를 지킨다.
 */
export function sortKakaoPlacesByNameMatch(places, keyword) {
    return (places || [])
        .map((place, index) => ({ place, index, score: kakaoPlaceNameMatchScore(place?.place_name, keyword) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((x) => x.place);
}
