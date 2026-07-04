/**
 * 기록 모달 — 상세기록 (누구와·만족도·포만감·시간)
 * 하단 칩으로 각 항목 on/off → 해당 입력란 표시 + 게이지/시간 활성화
 */
import { appState } from '../state.js';
import { dbOps } from '../db.js';
import { isDemoUser } from '../demo-account.js';

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

let detailSaveTimeout = null;
let detailBound = false;

function getModeKey() {
    return appState.entryFormMode === 'snack' ? 'snack' : 'meal';
}

export function ensureEntryModalDetailRecordOnUserSettings() {
    if (!window.userSettings) return;
    const defaults = { with: false, rating: false, satiety: false, time: false };
    const cur = window.userSettings.entryModalDetailRecord;
    if (!cur || typeof cur !== 'object') {
        window.userSettings.entryModalDetailRecord = { main: { ...defaults }, snack: { ...defaults } };
        return;
    }
    ['main', 'snack'].forEach((key) => {
        const slot = cur[key] && typeof cur[key] === 'object' ? cur[key] : {};
        cur[key] = {
            with: !!slot.with,
            rating: !!slot.rating,
            satiety: !!slot.satiety,
            time: !!slot.time,
        };
    });
}

/** @param {'meal'|'snack'} [mode] */
export function getEntryDetailRecordPrefs(mode) {
    const m = mode ?? getModeKey();
    ensureEntryModalDetailRecordOnUserSettings();
    const prefs = window.userSettings?.entryModalDetailRecord;
    const slot = m === 'snack' ? prefs?.snack : prefs?.main;
    return slot || { with: false, rating: false, satiety: false, time: false };
}

function getSections(mode) {
    return FIELD_SECTIONS[mode === 'snack' ? 'snack' : 'meal'];
}

function syncChipButtons(prefs) {
    document.querySelectorAll('#entryDetailRecordChips .entry-detail-record-chip').forEach((btn) => {
        const field = btn.getAttribute('data-field');
        const on = !!prefs[field];
        btn.classList.toggle('entry-detail-record-chip--active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function syncFieldSections(mode, prefs) {
    const sections = getSections(mode);
    /** @type {DetailRecordField[]} */
    const fields = ['with', 'rating', 'satiety', 'time'];
    fields.forEach((field) => {
        const el = document.getElementById(sections[field]);
        if (!el) return;
        el.classList.toggle('hidden', !prefs[field]);
    });

    const reviewWrap = document.getElementById(sections.reviewWrap);
    if (reviewWrap) {
        const showReview = !!prefs.rating || !!prefs.satiety;
        reviewWrap.classList.toggle('hidden', !showReview);
    }
}

export function applyEntryDetailRecordUi() {
    const mode = getModeKey();
    const prefs = getEntryDetailRecordPrefs(mode);
    syncChipButtons(prefs);
    syncFieldSections(mode, prefs);
    document.getElementById('entryModal')?.dispatchEvent(
        new CustomEvent('entrydetailprefs', { detail: { prefs, mode } })
    );
}

function schedulePersistDetailRecordPrefs() {
    ensureEntryModalDetailRecordOnUserSettings();
    if (window.currentUser && isDemoUser(window.currentUser)) return;
    clearTimeout(detailSaveTimeout);
    detailSaveTimeout = setTimeout(async () => {
        try {
            await dbOps.saveSettings(window.userSettings);
        } catch (_) {
            /* ignore */
        }
    }, 500);
}

function writePrefsToSettings(prefs) {
    ensureEntryModalDetailRecordOnUserSettings();
    const mode = getModeKey();
    if (mode === 'snack') {
        window.userSettings.entryModalDetailRecord.snack = { ...prefs };
    } else {
        window.userSettings.entryModalDetailRecord.main = { ...prefs };
    }
    schedulePersistDetailRecordPrefs();
}

/** @param {DetailRecordField} field @param {boolean} enabled */
export function setEntryDetailRecordField(field, enabled) {
    const prefs = { ...getEntryDetailRecordPrefs(), [field]: !!enabled };
    writePrefsToSettings(prefs);
    applyEntryDetailRecordUi();
}

export function toggleEntryDetailRecordField(field) {
    const prefs = getEntryDetailRecordPrefs();
    setEntryDetailRecordField(field, !prefs[field]);
}

/**
 * 수정 모드: 저장된 값이 있으면 해당 항목 칩 자동 on
 * @param {object|null|undefined} record
 */
export function seedEntryDetailRecordFromRecord(record) {
    if (!record) return;
    const prefs = { ...getEntryDetailRecordPrefs() };
    let changed = false;

    const withDetail = (record.withWhomDetail || '').trim();
    const withMain = (record.withWhom || '').trim();
    if (withDetail || (withMain && withMain !== '기타')) {
        if (!prefs.with) {
            prefs.with = true;
            changed = true;
        }
    }

    const rating = record.rating;
    if (rating != null && rating !== '' && Number(rating) > 0) {
        if (!prefs.rating) {
            prefs.rating = true;
            changed = true;
        }
    }

    const satiety = record.satiety;
    if (satiety != null && satiety !== '' && Number(satiety) > 0) {
        if (!prefs.satiety) {
            prefs.satiety = true;
            changed = true;
        }
    }

    const hasCustomTime = typeof record.mealClock === 'string' && record.mealClock.trim();
    if (hasCustomTime) {
        if (!prefs.time) {
            prefs.time = true;
            changed = true;
        }
    }

    if (changed) {
        writePrefsToSettings(prefs);
    }
}

export function setEntryDetailRecordPanelHidden(hidden) {
    document.getElementById('entryDetailRecordPanel')?.classList.toggle('hidden', !!hidden);
}

export function finalizeEntryModalDetailRecord(record) {
    ensureEntryModalDetailRecordOnUserSettings();
    if (record) {
        seedEntryDetailRecordFromRecord(record);
    }
    applyEntryDetailRecordUi();
}

export function bindEntryDetailRecordOnce() {
    if (detailBound) return;
    detailBound = true;

    document.getElementById('entryDetailRecordChips')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.entry-detail-record-chip');
        if (!btn) return;
        const field = btn.getAttribute('data-field');
        if (!field) return;
        toggleEntryDetailRecordField(/** @type {DetailRecordField} */ (field));
    });
}
