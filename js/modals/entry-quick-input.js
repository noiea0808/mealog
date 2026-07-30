/**
 * 기록 모달 — 항목별 빠른 입력(메인 태그 칩) on/off
 */
import { appState } from '../state.js';
import { ENTRY_DOM } from './entry-form-config.js';
import { renderEntryChips } from '../render/index.js';
import { dbOps } from '../db.js';
import { isDemoUser } from '../demo-account.js';

/** @typedef {'where'|'what'|'with'} EntryQuickField */

const QUICK_FIELDS = /** @type {const} */ (['where', 'what', 'with']);

const FIELD_DOM = {
    where: {
        chips: ENTRY_DOM.whereChips,
        section: ENTRY_DOM.whereSection,
        suggestions: ENTRY_DOM.whereSuggestions,
    },
    what: {
        chips: ENTRY_DOM.whatChips,
        section: ENTRY_DOM.whatSection,
        suggestions: ENTRY_DOM.whatSuggestions,
    },
    with: {
        chips: ENTRY_DOM.withChips,
        section: ENTRY_DOM.withSection,
        suggestions: ENTRY_DOM.withSuggestions,
    },
};

const DEFAULT_FIELD_PREFS = { where: true, what: true, with: true };

let quickInputSaveTimeout = null;

function getEntryFormModeKey() {
    return appState.entryFormMode === 'snack' ? 'snack' : 'meal';
}

function migrateQuickInputPrefs(cur) {
    let out;
    if (!cur || typeof cur !== 'object') {
        out = {
            meal: { ...DEFAULT_FIELD_PREFS },
            snack: { ...DEFAULT_FIELD_PREFS },
        };
    } else if (cur?.meal?.where !== undefined || cur?.snack?.where !== undefined) {
        out = {
            meal: { ...DEFAULT_FIELD_PREFS, ...cur?.meal },
            snack: { ...DEFAULT_FIELD_PREFS, ...cur?.snack },
        };
    } else {
        const mainOn = cur?.main === true;
        const snackOn = cur?.snack === true;
        out = {
            meal: { where: mainOn, what: mainOn, with: mainOn },
            snack: { where: snackOn, what: snackOn, with: snackOn },
        };
    }
    // 레거시 기본(전부 접힘) → 열림 기본으로 한 번 승격
    const legacyAllOff = (p) => p?.where === false && p?.what === false && p?.with === false;
    if (!cur?.openedByDefaultV2 && legacyAllOff(out.meal) && legacyAllOff(out.snack)) {
        out.meal = { ...DEFAULT_FIELD_PREFS };
        out.snack = { ...DEFAULT_FIELD_PREFS };
        out.openedByDefaultV2 = true;
        out._didOpenByDefaultUpgrade = true;
    } else if (cur?.openedByDefaultV2) {
        out.openedByDefaultV2 = true;
    }
    return out;
}

export function ensureEntryModalQuickInputOnUserSettings() {
    if (!window.userSettings) return;
    const prev = window.userSettings.entryModalQuickInput;
    const next = migrateQuickInputPrefs(prev);
    const upgraded = !!next._didOpenByDefaultUpgrade;
    delete next._didOpenByDefaultUpgrade;
    window.userSettings.entryModalQuickInput = next;
    if (upgraded) schedulePersistEntryQuickInputPrefs();
}

function getFieldPrefs(modeKey) {
    ensureEntryModalQuickInputOnUserSettings();
    return window.userSettings?.entryModalQuickInput?.[modeKey] ?? DEFAULT_FIELD_PREFS;
}

/** @param {EntryQuickField} field @param {'meal'|'snack'} [mode] */
export function isEntryFieldQuickInputOn(field, mode) {
    const modeKey = mode ?? getEntryFormModeKey();
    const prefs = getFieldPrefs(modeKey);
    return prefs[field] !== false;
}

/** @param {'meal'|'snack'} [mode] — 하나라도 켜져 있으면 true (하위 호환) */
export function isEntryQuickInputOn(mode) {
    return QUICK_FIELDS.some((field) => isEntryFieldQuickInputOn(field, mode));
}

export function syncEntryFieldQuickInputToggles() {
    const modeKey = getEntryFormModeKey();
    const prefs = getFieldPrefs(modeKey);
    QUICK_FIELDS.forEach((field) => {
        const btn = document.querySelector(`.entry-field-quick-toggle[data-entry-quick-field="${field}"]`);
        if (!btn) return;
        const on = prefs[field] !== false;
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        btn.classList.toggle('entry-field-quick-toggle--open', on);
    });
}

/** @deprecated alias */
export function syncEntryQuickInputToggle() {
    syncEntryFieldQuickInputToggles();
}

export function clearFieldChipSelection(field) {
    const chipsId = FIELD_DOM[field]?.chips;
    if (!chipsId) return;
    document.getElementById(chipsId)?.querySelectorAll('button.chip.active').forEach((btn) => {
        btn.classList.remove('active');
    });
    if (field === 'where' && appState.entryFormMode === 'snack') {
        appState.selectedSnackPlaceMainTag = null;
    }
}

export function clearPrimaryChipSelection() {
    QUICK_FIELDS.forEach((field) => clearFieldChipSelection(field));
}

/** 메인 태그 칩 행·행 높이 표시 */
export function applyEntryQuickInputUi() {
    QUICK_FIELDS.forEach((field) => {
        const on = isEntryFieldQuickInputOn(field);
        const { chips, section, suggestions } = FIELD_DOM[field];
        const chipsEl = document.getElementById(chips);
        if (chipsEl) {
            chipsEl.classList.toggle('hidden', !on);
            chipsEl.setAttribute('aria-hidden', on ? 'false' : 'true');
        }
        document.getElementById(section)?.classList.toggle('entry-field-quick-off', !on);
        const stage = chipsEl?.closest?.('.entry-tag-stage');
        if (stage) {
            stage.classList.toggle('hidden', !on);
            if (!on && typeof window.setEntryTagStageView === 'function' && suggestions) {
                window.setEntryTagStageView(suggestions, 'main');
            }
        }
    });
    syncEntryFieldQuickInputToggles();
    // 무엇을 textarea: 태그 행 on/off 후 placeholder 세로 중앙 유지
    document.getElementById('entryWhatInput')?.dispatchEvent(new Event('input', { bubbles: false }));
}

export function schedulePersistEntryQuickInputPrefs() {
    ensureEntryModalQuickInputOnUserSettings();
    if (window.currentUser && isDemoUser(window.currentUser)) return;
    clearTimeout(quickInputSaveTimeout);
    quickInputSaveTimeout = setTimeout(async () => {
        try {
            await dbOps.saveSettings(window.userSettings);
        } catch (_) {
            /* ignore */
        }
    }, 500);
}

export function finalizeEntryModalQuickInput() {
    ensureEntryModalQuickInputOnUserSettings();
    applyEntryQuickInputUi();
}

/** @param {EntryQuickField} field @param {boolean} enabled */
export function setEntryFieldQuickInputEnabled(field, enabled) {
    const on = enabled !== false;
    if (!QUICK_FIELDS.includes(field)) return;
    if (!on && isEntryFieldQuickInputOn(field)) {
        clearFieldChipSelection(field);
    }
    ensureEntryModalQuickInputOnUserSettings();
    const modeKey = getEntryFormModeKey();
    window.userSettings.entryModalQuickInput[modeKey][field] = on;
    applyEntryQuickInputUi();
    renderEntryChips();
    schedulePersistEntryQuickInputPrefs();
}

export function setEntryQuickInputEnabled(enabled) {
    QUICK_FIELDS.forEach((field) => setEntryFieldQuickInputEnabled(field, enabled));
}

let quickInputBound = false;

export function bindEntryQuickInputOnce() {
    if (quickInputBound) return;
    quickInputBound = true;
    const root = document.getElementById('entryModal');
    if (!root) return;
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('.entry-field-quick-toggle[data-entry-quick-field]');
        if (!btn || !root.contains(btn)) return;
        const field = btn.getAttribute('data-entry-quick-field');
        if (!field || !QUICK_FIELDS.includes(/** @type {EntryQuickField} */ (field))) return;
        const nextOn = btn.getAttribute('aria-expanded') !== 'true';
        setEntryFieldQuickInputEnabled(/** @type {EntryQuickField} */ (field), nextOn);
    });
}
