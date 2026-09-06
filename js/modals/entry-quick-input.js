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
    /**
     * V3 시절 여기서 끼니 what 을 1회 접었지만(docs/entry-sheet-redesign.md §2 1층),
     * 이제 what 의 열림 상태는 저장하지 않고 시트 세션마다 접힘에서 시작한다
     * (whatOpenThisSession). 저장된 what 값은 읽지 않으므로 마이그레이션도 두지 않는다.
     * 이미 찍힌 플래그만 그대로 옮긴다 — 지웠다 다시 쓰는 왕복이 설정 쓰기를 부른다.
     */
    if (cur?.whatSuggestDefaultV3) out.whatSuggestDefaultV3 = true;
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

/**
 * '무엇을' 그리드의 열림 상태는 **저장하지 않는다** — 시트를 열 때마다 접힌 채로 시작하고,
 * 이 시트 세션 안에서 사용자가 직접 펼쳤을 때만 열린다.
 *
 * 예전에는 어디서·누구와와 같은 저장 설정이라, '다른 구분'으로 한 번 펼치면 그 뒤 모든
 * 기록이 그리드가 펼쳐진 채로 열렸다. 1층은 사진 + 텍스트 + 자동 분류 제안 한 줄이 전부라는
 * 설계(docs/entry-sheet-redesign.md §2 1층)와 어긋나고, 사진까지 붙으면 시트가 상한에 걸려
 * 분류 제안 줄이 화면 밖으로 밀렸다.
 * @type {Record<'meal'|'snack', boolean>}
 */
let whatOpenThisSession = { meal: false, snack: false };

/** 시트를 열 때 호출 — '무엇을' 그리드를 접힌 상태로 되돌린다 */
export function resetEntryWhatQuickInputSession() {
    whatOpenThisSession = { meal: false, snack: false };
}

/** @param {EntryQuickField} field @param {'meal'|'snack'} [mode] */
export function isEntryFieldQuickInputOn(field, mode) {
    const modeKey = mode ?? getEntryFormModeKey();
    if (field === 'what') return whatOpenThisSession[modeKey] === true;
    const prefs = getFieldPrefs(modeKey);
    return prefs[field] !== false;
}

/** @param {'meal'|'snack'} [mode] — 하나라도 켜져 있으면 true (하위 호환) */
export function isEntryQuickInputOn(mode) {
    return QUICK_FIELDS.some((field) => isEntryFieldQuickInputOn(field, mode));
}

export function syncEntryFieldQuickInputToggles() {
    QUICK_FIELDS.forEach((field) => {
        const btn = document.querySelector(`.entry-field-quick-toggle[data-entry-quick-field="${field}"]`);
        if (!btn) return;
        const on = isEntryFieldQuickInputOn(field);
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

/**
 * 그리드를 펼친 직후, '무엇을' 한 덩어리(입력 + 분류 제안 + 그리드)를 화면 안으로 되감는다.
 *
 * 시트가 상한(80vh)에 걸리면 늘어난 분은 스크롤로 흐르는데 스크롤 위치는 그대로라,
 * 사진이 붙어 있을수록 새로 열린 그리드도 그 위의 분류 제안 줄도 화면 밖에 남았다.
 * 위쪽 사진부는 이미 지나온 자리이므로 그쪽을 걷어 올린다 — 단 '무엇을' 라벨 위로는
 * 올리지 않는다.
 *
 * `entryUserScrolling` 가드를 두지 않는 이유: 셰브론 탭 자체가 스크롤 영역의 touchstart라
 * 그 플래그를 켠다. 여기서는 사용자가 방금 누른 것이 곧 의도다.
 */
function revealEntryWhatSection() {
    const area = document.getElementById('modalScrollArea');
    const section = document.getElementById(ENTRY_DOM.whatSection);
    if (!area || !section || !area.contains(section)) return;
    // 시트 높이 잠금이 rAF로 반영된 뒤에 재야 늘어난 높이가 계산에 들어온다
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!document.contains(section)) return;
        const pad = 8;
        const areaRect = area.getBoundingClientRect();
        const rect = section.getBoundingClientRect();
        const need = rect.bottom + pad - areaRect.bottom;
        if (need <= 1) return;
        const room = rect.top - (areaRect.top + pad);
        const delta = Math.min(need, Math.max(0, room));
        if (delta > 1) area.scrollTop += delta;
    }));
}

/**
 * '무엇을' 그리드가 펼쳐진 직후 불린다 — 분류 제안 줄이 확정값을 새 칩에 되붙이는 자리.
 *
 * 그리드는 접혀 있는 동안 칩 DOM 자체가 비어 있어서(render/entry-chips.js), 펼치면 항상
 * active 없는 새 칩이 그려진다. 훅으로 뒤집은 이유는 import 방향 때문 —
 * entry-category-suggest 가 이 모듈을 가져다 쓰므로 반대로는 못 가져온다.
 * @type {null | (() => void)}
 */
let whatGridOpenedHook = null;

/** @param {(() => void)|null} fn */
export function setEntryWhatGridOpenedHook(fn) {
    whatGridOpenedHook = typeof fn === 'function' ? fn : null;
}

/** @param {EntryQuickField} field @param {boolean} enabled */
export function setEntryFieldQuickInputEnabled(field, enabled) {
    const on = enabled !== false;
    if (!QUICK_FIELDS.includes(field)) return;
    if (!on && isEntryFieldQuickInputOn(field)) {
        clearFieldChipSelection(field);
    }
    const modeKey = getEntryFormModeKey();
    // '무엇을'은 세션 한정 — 설정에 쓰지 않는다 (whatOpenThisSession 주석)
    if (field === 'what') {
        whatOpenThisSession[modeKey] = on;
        applyEntryQuickInputUi();
        renderEntryChips();
        if (on) {
            try {
                whatGridOpenedHook?.();
            } catch (_) {
                /* 되붙이기 실패가 펼치기를 막아선 안 된다 */
            }
            revealEntryWhatSection();
        }
        return;
    }
    ensureEntryModalQuickInputOnUserSettings();
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
