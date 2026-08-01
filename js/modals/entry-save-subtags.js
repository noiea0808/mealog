/**
 * 기록 저장 시 최근 서브태그 학습 + 설정 디바운스 저장
 * 저장한 입력을 다음 기록 시트의 서브칩 후보로 기억한다.
 */
import { DEFAULT_SUB_TAGS } from '../constants.js';
import { dbOps } from '../db.js';

// 설정 저장 디바운싱을 위한 타이머
let settingsSaveTimeout = null;

/**
 * 입력란의 쉼표(, / ，) 구분 항목을 최근 서브태그로 각각 기억.
 * 이미 있으면 맨 뒤로 옮겨 최근 순서를 갱신한다.
 * @param {any[]} list
 * @param {string} rawValue
 * @param {string|null|undefined} parent
 * @returns {boolean} 변경 여부
 */
function rememberCommaSeparatedSubTags(list, rawValue, parent) {
    if (!Array.isArray(list)) return false;
    const parts = String(rawValue || '')
        .split(/[,，]/)
        .map((v) => v.trim())
        .filter(Boolean);
    if (!parts.length) return false;
    let changed = false;
    for (const val of parts) {
        const existingIdx = list.findIndex((t) => (t.text || t) === val);
        if (existingIdx >= 0) {
            list.splice(existingIdx, 1);
        }
        list.push({ text: val, parent: parent || null });
        changed = true;
    }
    return changed;
}

/**
 * 이번 입력을 최근 서브태그에 반영한 새 설정 객체를 만든다. 원본은 변경하지 않는다.
 * changed가 false면 호출부는 설정을 덮어쓰지 않아야 한다(불필요한 저장 방지).
 *
 * @param {object} currentSettings window.userSettings
 * @param {import('./entry-form-state.js').EntryFormValues} form
 * @param {ReturnType<import('./entry-form-state.js').resolveEntrySaveFields>} resolved
 * @param {'meal'|'snack'} entryMode
 * @returns {{ settings: object, changed: boolean }}
 */
export function buildSettingsWithRememberedSubTags(currentSettings, form, resolved, entryMode) {
    const isS = entryMode === 'snack';
    const {
        mealTypeResolved,
        categoryResolved,
        withWhomResolved,
        snackTypeResolved,
        snackPlaceMainResolved,
    } = resolved;

    const placeInputVal = form.placeInput;
    const whatInputVal = form.whatInput;
    const withInputVal = form.withInput;

    const settings = JSON.parse(JSON.stringify(currentSettings));
    if (!settings.subTags) settings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));

    // subTags의 각 배열이 정의되어 있는지 확인
    if (!settings.subTags.place) settings.subTags.place = [];
    if (!settings.subTags.menu) settings.subTags.menu = [];
    if (!settings.subTags.people) settings.subTags.people = [];
    if (!settings.subTags.snack) settings.subTags.snack = [];

    let changed = false;
    // 장소·메뉴·누구와·간식: 쉼표로 구분된 항목을 최근 태그에 각각 기억
    if (!isS && placeInputVal) {
        if (rememberCommaSeparatedSubTags(settings.subTags.place, placeInputVal, mealTypeResolved)) {
            changed = true;
        }
    }
    if (isS && placeInputVal) {
        if (rememberCommaSeparatedSubTags(
            settings.subTags.place,
            placeInputVal,
            snackPlaceMainResolved || placeInputVal
        )) {
            changed = true;
        }
    }
    if (whatInputVal) {
        if (rememberCommaSeparatedSubTags(settings.subTags.menu, whatInputVal, categoryResolved)) {
            changed = true;
        }
    }
    if (withInputVal) {
        if (rememberCommaSeparatedSubTags(settings.subTags.people, withInputVal, withWhomResolved)) {
            changed = true;
        }
    }
    if (isS && whatInputVal) {
        if (rememberCommaSeparatedSubTags(settings.subTags.snack, whatInputVal, snackTypeResolved)) {
            changed = true;
        }
    }

    return { settings, changed };
}

/**
 * 1초 디바운스로 설정 저장 — 연속 저장 시 여러 태그 변경을 한 번으로 묶는다.
 * 발화 시점의 window.userSettings를 다시 읽으므로(캡처값 아님) 묶인 변경 중 최신이 나간다.
 */
export function scheduleEntrySettingsSave() {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = setTimeout(async () => {
        try {
            await dbOps.saveSettings(window.userSettings);
            console.log('디바운싱된 설정 저장 완료');
        } catch (e) {
            console.error('설정 저장 실패:', e);
            // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 로그만
        }
    }, 1000);
}
