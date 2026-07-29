/**
 * 기록 모달 — 누구와·만족도·포만감·시간 섹션 표시
 * (상세보기 칩 UI 제거 후 항상 표시, 게이지/시간 활성은 prefs 이벤트로 동기화)
 */
import { appState } from '../state.js';

/** @typedef {'with'|'rating'|'satiety'|'time'} DetailRecordField */

const FIELD_SECTIONS = {
    meal: {
        with: 'entryWithSection',
        rating: 'ratingSection',
        satiety: 'satietySection',
        time: 'entryMealTimeSectionMain',
        reviewWrap: 'reviewSection',
    },
    snack: {
        with: 'entryWithSection',
        rating: 'snackRatingSection',
        satiety: 'snackSatietySection',
        time: 'entryMealTimeSectionSnack',
        reviewWrap: 'snackReviewSection',
    },
};

const ALWAYS_ON = { with: true, rating: true, satiety: true, time: true };

function getModeKey() {
    return appState.entryFormMode === 'snack' ? 'snack' : 'meal';
}

/** 하위 호환 — 항상 on */
export function ensureEntryModalDetailRecordOnUserSettings() {
    if (!window.userSettings) return;
    window.userSettings.entryModalDetailRecord = {
        main: { ...ALWAYS_ON },
        snack: { ...ALWAYS_ON },
    };
}

/** @param {'meal'|'snack'} [mode] */
export function getEntryDetailRecordPrefs(mode) {
    void mode;
    return { ...ALWAYS_ON };
}

function getSections(mode) {
    return FIELD_SECTIONS[mode === 'snack' ? 'snack' : 'meal'];
}

/** @param {boolean} [forceHide] Skip 등에서 메트릭 숨김 */
function syncFieldSections(mode, prefs, forceHide = false) {
    const sections = getSections(mode);
    /** @type {DetailRecordField[]} */
    const fields = ['with', 'rating', 'satiety', 'time'];
    fields.forEach((field) => {
        const el = document.getElementById(sections[field]);
        if (!el) return;
        if (field === 'with') {
            // 누구와는 Skip일 때만 숨김
            el.classList.toggle('hidden', forceHide);
            return;
        }
        el.classList.toggle('hidden', forceHide || !prefs[field]);
    });

    const reviewWrap = document.getElementById(sections.reviewWrap);
    if (reviewWrap) {
        const showReview = !forceHide && (!!prefs.rating || !!prefs.satiety);
        reviewWrap.classList.toggle('hidden', !showReview);
    }
}

export function applyEntryDetailRecordUi(opts = {}) {
    const mode = getModeKey();
    const prefs = getEntryDetailRecordPrefs(mode);
    const forceHide = !!opts.forceHide;
    syncFieldSections(mode, prefs, forceHide);
    // with는 more 탭에 있어 meal/snack 섹션 맵과 별도로 Skip만 처리
    if (!forceHide) {
        document.getElementById('entryWithSection')?.classList.remove('hidden');
    }
    document.getElementById('entryModal')?.dispatchEvent(
        new CustomEvent('entrydetailprefs', { detail: { prefs: forceHide ? { with: false, rating: false, satiety: false, time: false } : prefs, mode } })
    );
}

/** @deprecated 칩 UI 제거 — no-op 유지 */
export function setEntryDetailRecordField() {}

/** @deprecated */
export function toggleEntryDetailRecordField() {}

/** @deprecated */
export function seedEntryDetailRecordFromRecord() {}

export function setEntryDetailRecordPanelHidden(hidden) {
    applyEntryDetailRecordUi({ forceHide: !!hidden });
    // Skip 시 무엇을·누구와 개별 숨김은 toggleFieldsForSkip에서 처리
    if (hidden) {
        document.getElementById('entryWithSection')?.classList.add('hidden');
    }
}

export function finalizeEntryModalDetailRecord() {
    ensureEntryModalDetailRecordOnUserSettings();
    applyEntryDetailRecordUi();
}

export function bindEntryDetailRecordOnce() {
    /* 칩 UI 없음 */
}
