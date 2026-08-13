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
