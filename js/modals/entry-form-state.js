/**
 * 기록 시트 FormState — DOM 읽기·검증·Firestore 저장 필드 해석
 */
import { ENTRY_DOM, getEntryModeConfig } from './entry-form-config.js';

/** @param {string} chipContainerId */
export function getActiveChipLabel(chipContainerId) {
    const root = document.getElementById(chipContainerId);
    if (!root) return '';
    const active = root.querySelector('button.chip.active');
    return active ? active.innerText.trim() : '';
}

/** @param {string} containerId */
export function collectActiveSubChipLabels(containerId) {
    const root = document.getElementById(containerId);
    if (!root) return [];
    return [...root.querySelectorAll('button.sub-chip.active')].map((el) =>
        el.textContent.replace(/\s*★\s*$/, '').trim()
    ).filter(Boolean);
}

/** @typedef {{ mode: 'meal'|'snack', axis1Chip: string, placeInput: string, axis2Chip: string, whatInput: string, withChip: string, withInput: string, deliveryVendor: string }} EntryFormValues */

/** @returns {EntryFormValues} */
export function readEntryFormFromDom(mode) {
    const d = ENTRY_DOM;
    return {
        mode,
        axis1Chip: getActiveChipLabel(d.whereChips),
        placeInput: (document.getElementById(d.whereInput)?.value || '').trim(),
        axis2Chip: getActiveChipLabel(d.whatChips),
        whatInput: (document.getElementById(d.whatInput)?.value || '').trim(),
        withChip: getActiveChipLabel(d.withChips),
        withInput: (document.getElementById(d.withInput)?.value || '').trim(),
        deliveryVendor: (document.getElementById('deliveryVendorInput')?.value || '').trim(),
    };
}

/**
 * 입력 시트 전체(칩·텍스트·사진·만족도·포만감·시간·코멘트) 중 하나라도 있으면 저장 가능
 * @returns {boolean} true = 저장 가능
 */
export function validateEntryForm(form, ctx = {}) {
    if (ctx.isSkip) return true;

    const d = ENTRY_DOM;
    const isSnack = form.mode === 'snack';

    const hasAxisFields =
        Boolean((form.axis1Chip || '').trim()) ||
        Boolean((form.axis2Chip || '').trim()) ||
        Boolean((form.withChip || '').trim()) ||
        Boolean((form.placeInput || '').trim()) ||
        Boolean((form.whatInput || '').trim()) ||
        Boolean((form.withInput || '').trim()) ||
        Boolean((form.deliveryVendor || '').trim()) ||
        collectActiveSubChipLabels(d.whereSuggestions).length > 0 ||
        collectActiveSubChipLabels(d.whatSuggestions).length > 0 ||
        collectActiveSubChipLabels(d.withSuggestions).length > 0 ||
        Boolean((ctx.selectedSnackPlaceMainTag || '').trim());

    const commentEl = document.getElementById(isSnack ? 'snackCommentInput' : 'generalCommentInput');
    const hasComment = Boolean((commentEl?.value || '').trim());

    const hasPhotos = Array.isArray(ctx.photos) && ctx.photos.some(Boolean);

    const hasRating = ctx.ratingOn === true;
    const hasSatiety = ctx.satietyOn === true;
    const hasTime = ctx.timeOn === true && Boolean((ctx.mealClock24 || '').trim());

    return hasAxisFields || hasComment || hasPhotos || hasRating || hasSatiety || hasTime;
}

/**
 * @param {EntryFormValues} form
 * @param {{ selectedSnackPlaceMainTag?: string|null }} ctx
 */
export function resolveEntrySaveFields(form, ctx = {}) {
    const cfg = getEntryModeConfig(form.mode);
    const d = ENTRY_DOM;
    const isMeal = form.mode === 'meal';
    const isSnack = form.mode === 'snack';

    const mealType = isMeal ? form.axis1Chip : '';
    const isSkip = isMeal && (mealType === 'Skip' || mealType === '건너뜀');

    const hasMenuSub = collectActiveSubChipLabels(d.whatSuggestions).length > 0;
    const hasPeopleSub = collectActiveSubChipLabels(d.withSuggestions).length > 0;
    const hasRestaurantSub = isMeal ? collectActiveSubChipLabels(d.whereSuggestions).length > 0 : 0;
    const hasSnackPlaceSub = isSnack ? collectActiveSubChipLabels(d.whereSuggestions).length > 0 : 0;

    let mealTypeResolved = mealType;
    if (isMeal && !isSkip && !(mealType || '').trim()) {
        const hasAnyHowAxis =
            (form.placeInput || '').trim() ||
            hasRestaurantSub ||
            (form.whatInput || '').trim() ||
            hasMenuSub ||
            (form.withInput || '').trim() ||
            hasPeopleSub;
        if (hasAnyHowAxis) mealTypeResolved = '기타';
    }

    /**
     * 카테고리 '기타' 조용한 폴백 제거 (docs/food-category-auto-classification.md §2).
     * 칩 미선택 = 빈 값 = "아직 분류 안 됨" — 자동 분류(categoryAuto)와 서버 backfill이
     * 채울 자리다. 표시 계층의 기타 처리는 meal-analytics-tags.js가 담당한다.
     */
    const categoryResolved = isMeal ? form.axis2Chip : '';

    let withWhomResolved = form.withChip;
    if (!isSkip && !(withWhomResolved || '').trim() && (((form.withInput || '').trim()) || hasPeopleSub)) {
        withWhomResolved = '기타';
    }

    /**
     * 간식도 끼니와 같은 규칙 — '기타' 조용한 폴백 없음.
     *
     * 폴백이 남아 있으면 buildEntrySaveRecord의 userPicked 판정이 항상 참이 되어,
     * 자동 분류는 물론 **사용자가 직접 탭한 제안 확정까지** '기타'에 먹힌다.
     * 빈 값 = "아직 분류 안 됨" = categoryAuto·서버 backfill이 채울 자리다.
     */
    const snackTypeResolved = isSnack ? form.axis2Chip : '';

    const selectedSnackPlaceMain = ctx.selectedSnackPlaceMainTag || null;
    let snackPlaceMainResolved = '';
    if (isSnack && !isSkip) {
        const hasPlaceBody = (form.placeInput || '').trim() || hasSnackPlaceSub;
        snackPlaceMainResolved = selectedSnackPlaceMain || (hasPlaceBody ? '기타' : '');
    }

    return {
        isSkip,
        mealTypeResolved,
        categoryResolved,
        withWhomResolved,
        snackTypeResolved,
        snackPlaceMainResolved,
        hasRestaurantSub,
        hasSnackPlaceSub,
        hasMenuSub,
        hasPeopleSub,
        subTagPlaceParent: isMeal ? mealTypeResolved : snackPlaceMainResolved || form.placeInput,
    };
}

/** 입력란이 비어 있을 때 활성 서브칩을 쉼표로 합침 */
export function mergeEntrySubChipsIntoInputs() {
    const d = ENTRY_DOM;
    const merge = (containerId, inputId) => {
        const input = document.getElementById(inputId);
        if (!input || input.value.trim()) return;
        const labels = collectActiveSubChipLabels(containerId);
        if (labels.length) input.value = labels.join(', ');
    };
    merge(d.whatSuggestions, d.whatInput);
    merge(d.withSuggestions, d.withInput);
    merge(d.whereSuggestions, d.whereInput);
}

/** @param {EntryFormMode} mode */
export function applyEntryModeLabels(mode) {
    const cfg = getEntryModeConfig(mode);
    const labelEl = document.getElementById(ENTRY_DOM.whereLabel);
    const whatInput = document.getElementById(ENTRY_DOM.whatInput);
    if (labelEl) labelEl.textContent = cfg.whereLabel;
    if (whatInput) whatInput.placeholder = cfg.whatPlaceholder;

    // 끼니: 칩 라벨 '어떻게'(utensils) + 장소 입력 위 보조 라벨 '어디서' 노출.
    // 간식: 칩도 장소이므로 본 라벨 '어디서'(map-pin) 하나로 충분 — 보조 라벨 숨김.
    const isMeal = mode !== 'snack';
    document.getElementById('entryWhereLabelIconPlace')?.classList.toggle('hidden', isMeal);
    document.getElementById('entryWhereLabelIconHow')?.classList.toggle('hidden', !isMeal);
    document.getElementById('entryWhereInputLabel')?.classList.toggle('hidden', !isMeal);
}

/** @param {EntryFormMode} mode */
export function setEntryExtrasVisibility(mode) {
    const isSnack = mode === 'snack';
    const d = ENTRY_DOM;
    const mealPhoto = document.getElementById(d.mealPhoto);
    const snackPhoto = document.getElementById(d.snackPhoto);
    mealPhoto?.classList.toggle('hidden', isSnack);
    document.getElementById(d.mealExtras)?.classList.toggle('hidden', isSnack);
    snackPhoto?.classList.toggle('hidden', !isSnack);
    document.getElementById(d.snackExtras)?.classList.toggle('hidden', !isSnack);
    document.getElementById('entryCommentSectionMeal')?.classList.toggle('hidden', isSnack);
    document.getElementById('entryCommentSectionSnack')?.classList.toggle('hidden', !isSnack);
    /* 비활성 사진 영역의 has-photos가 display:flex로 .hidden을 덮지 않도록 정리 */
    (isSnack ? mealPhoto : snackPhoto)?.classList.remove('entry-photo-section--has-photos');
}
