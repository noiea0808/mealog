/** 기록 시트 통합 — DOM id·entryMode별 메타 (Firestore 스키마는 저장 어댑터에서 분기) */

export const ENTRY_DOM = {
    whereSection: 'entryWhereSection',
    whereLabel: 'entryWhereLabel',
    whereChips: 'entryWhereChips',
    whereInput: 'entryWhereInput',
    whereSuggestions: 'entryWhereSuggestions',
    whereKakaoBtn: 'entryWhereKakaoBtn',
    whatSection: 'entryWhatSection',
    whatChips: 'entryWhatChips',
    whatInput: 'entryWhatInput',
    whatSuggestions: 'entryWhatSuggestions',
    withSection: 'entryWithSection',
    withChips: 'entryWithChips',
    withInput: 'entryWithInput',
    withSuggestions: 'entryWithSuggestions',
    optionalFields: 'optionalFields',
    mealPhoto: 'entryMealPhoto',
    snackPhoto: 'entrySnackPhoto',
    mealExtras: 'entryMealExtras',
    snackExtras: 'entrySnackExtras',
};

/** 기록 사진 비율 선택지 (히어로 프레임·모먼트 카드 공통) */
export const PHOTO_ASPECT_OPTIONS = ['1:1', '3:4', '4:3'];

/** @typedef {'meal'|'snack'} EntryFormMode */

/** @param {{ type?: string }|null|undefined} slot */
export function getEntryModeFromSlot(slot) {
    return slot?.type === 'snack' ? 'snack' : 'meal';
}

export const ENTRY_MODE_CONFIG = {
    meal: {
        // 끼니 1축(mealType)은 장소가 아니라 조달 형태다 — 라벨이 축의 실제 의미를 말하게 한다.
        // 실제 장소는 아래 자유입력(entryWhereInput)이 담당하고 보조 라벨 '어디서'가 붙는다.
        whereLabel: '어떻게',
        axis1TagsKey: 'mealType',
        axis1FavoriteKey: 'mealType',
        axis1SubTagKey: 'place',
        axis2TagsKey: 'category',
        axis2FavoriteKey: 'category',
        axis2SubTagsKey: 'menu',
        axis2SubTagKey: 'menu',
        whatPlaceholderHead: '무엇을 드셨나요?',
        supportsSkip: true,
        supportsDeliveryVendor: true,
    },
    snack: {
        whereLabel: '어디서',
        axis1TagsKey: 'snackPlaceMain',
        axis1FavoriteKey: 'snackPlace',
        axis1SubTagKey: 'place',
        axis2TagsKey: 'snackType',
        axis2FavoriteKey: 'snackType',
        axis2SubTagsKey: 'snack',
        axis2SubTagKey: 'snack',
        whatPlaceholderHead: '무엇을 드셨나요?',
        supportsSkip: false,
        supportsDeliveryVendor: false,
    },
    withTagsKey: 'withWhom',
    withSubTagKey: 'people',
};

/** @param {EntryFormMode} mode */
export function getEntryModeConfig(mode) {
    return ENTRY_MODE_CONFIG[mode === 'snack' ? 'snack' : 'meal'];
}

/** @param {EntryFormMode} mode @param {object} tags */
export function getAxis1TagList(mode, tags) {
    const cfg = getEntryModeConfig(mode);
    const list = tags?.[cfg.axis1TagsKey];
    if (mode === 'snack') {
        return Array.isArray(list) && list.length ? list : ['집', '사무실', '카페'];
    }
    return Array.isArray(list) ? list : [];
}

/** @param {EntryFormMode} mode @param {object} tags */
export function getAxis2TagList(mode, tags) {
    const cfg = getEntryModeConfig(mode);
    const list = tags?.[cfg.axis2TagsKey];
    if (mode === 'snack') {
        return Array.isArray(list) && list.length
            ? list
            : ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
    }
    return Array.isArray(list) ? list : [];
}

/** @param {string} containerId */
export function getInputIdForSuggestionsContainer(containerId) {
    const d = ENTRY_DOM;
    if (containerId === d.whereSuggestions) return d.whereInput;
    if (containerId === d.whatSuggestions) return d.whatInput;
    if (containerId === d.withSuggestions) return d.withInput;
    return null;
}
