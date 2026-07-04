/**
 * 기록 화면 태그 칩(끼니·카테고리·함께·간식 등) 렌더링.
 * window.renderSecondary 는 여기서 등록합니다.
 */
import { appState } from '../state.js';
import {
    ENTRY_DOM,
    ENTRY_MODE_CONFIG,
    getEntryModeConfig,
    getAxis1TagList,
    getAxis2TagList,
} from '../modals/entry-form-config.js';
import { isEntryFieldQuickInputOn } from '../modals/entry-quick-input.js';

/** 기록 모달 서브태그 중 '최근 사용'으로 보여 줄 최대 개수 (식사·간식 공통) */
const RECENT_SUBTAG_CHIP_LIMIT = 5;

/**
 * onclick="..." 안에 삽입할 때 JSON.stringify는 큰따옴표로 속성이 끊겨 SyntaxError 남.
 * 단일따옴표 리터럴 + decodeURIComponent로 안전히 전달.
 */
function valueExprForOnclick(str) {
    return `decodeURIComponent('${encodeURIComponent(str ?? '')}')`;
}

function getSubTagItemText(item) {
    if (item == null) return '';
    return typeof item === 'string' ? String(item) : (item.text != null ? String(item.text) : '');
}

/**
 * subTags 항목에 쉼표로 묶인 문자열이 있으면(예: "맥주,새우깡") 최근 태그 칩을 나누기 위한 배열로 펼침.
 * parent는 유지, 펼친 항목에만 `_sourceFull`로 원문을 남겨 × 삭제 시 갱신에 사용.
 */
function expandCommaSeparatedSubTagItem(item) {
    if (item == null) return [];
    const parent = typeof item === 'string' ? null : item.parent;
    const full = getSubTagItemText(item).trim();
    if (!full) return [];
    if (!full.includes(',')) {
        return [typeof item === 'string' ? { text: full, parent } : { ...item, text: full }];
    }
    const parts = full.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) {
        return [typeof item === 'string' ? { text: full, parent } : { ...item, text: full }];
    }
    return parts.map((text) => ({ text, parent, _sourceFull: full }));
}

function getEntryFormMode() {
    return appState.entryFormMode === 'snack' ? 'snack' : 'meal';
}

export function renderEntryChips() {
    const tags = window.userSettings?.tags;
    const subTags = window.userSettings?.subTags;
    const mode = getEntryFormMode();
    const cfg = getEntryModeConfig(mode);
    const d = ENTRY_DOM;

    if (!tags) {
        console.warn('userSettings.tags가 없습니다. 기본값을 사용합니다.');
        return;
    }

    if (tags.mealType) {
        const index = tags.mealType.indexOf('???');
        if (index > -1) tags.mealType.splice(index, 1);
    }

    const renderPrimary = (id, list, inputId, subTagKey, subContainerId) => {
        const el = document.getElementById(id);
        if (!el || !list || list.length === 0) {
            if (el) el.innerHTML = '';
            return;
        }
        el.innerHTML = list
            .map(
                (t) =>
                    `<button onclick="window.selectTag('${inputId}', ${valueExprForOnclick(t)}, this, true, '${subTagKey}', '${subContainerId}')" class="chip">${t}</button>`
            )
            .join('');
    };

    window.renderSecondary = (id, list, inputId, parentFilter = null, subTagKey = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        let filteredList = list || [];
        if (parentFilter) {
            filteredList = filteredList.filter((item) => {
                const parent = typeof item === 'string' ? null : item.parent;
                return parent === parentFilter;
            });
        }

        const currentInputVal = document.getElementById(inputId)?.value || '';
        const isMultiSelect = id === d.whatSuggestions || id === d.withSuggestions;
        const currentValues = isMultiSelect
            ? currentInputVal.split(',').map((v) => v.trim()).filter(Boolean)
            : [currentInputVal];

        if (!parentFilter) {
            el.innerHTML = '';
            return;
        }

        const mainTagKeyMap = {
            place: 'mealType',
            menu: 'category',
            people: 'withWhom',
            snack: 'snackType',
        };
        let mainTagKey = mainTagKeyMap[subTagKey] || cfg.axis2FavoriteKey;
        if (subTagKey === 'place' && id === d.whereSuggestions) {
            mainTagKey = cfg.axis1FavoriteKey;
        }
        const favoriteSubTags = window.userSettings?.favoriteSubTags?.[mainTagKey] || {};
        const myTags = favoriteSubTags[parentFilter] || [];

        const myTagsSet = new Set(myTags);
        const myTagsList = [];
        const myTagPartSeen = new Set();

        filteredList.forEach((item) => {
            for (const part of expandCommaSeparatedSubTagItem(item)) {
                const text = getSubTagItemText(part);
                if (!text) continue;
                if (myTagsSet.has(text) && !myTagPartSeen.has(text)) {
                    myTagPartSeen.add(text);
                    myTagsList.push(part);
                }
            }
        });
        myTags.forEach((text) => {
            const alreadyIn = filteredList.some((item) =>
                expandCommaSeparatedSubTagItem(item).some((p) => getSubTagItemText(p) === text)
            );
            if (!alreadyIn) myTagsList.push({ text });
        });

        myTagsList.sort((a, b) => {
            const textA = getSubTagItemText(a);
            const textB = getSubTagItemText(b);
            return myTags.indexOf(textA) - myTags.indexOf(textB);
        });

        const recentByText = new Map();
        filteredList.forEach((item, idx) => {
            for (const part of expandCommaSeparatedSubTagItem(item)) {
                const text = getSubTagItemText(part);
                if (!text) continue;
                if (myTagsSet.has(text)) continue;
                const prev = recentByText.get(text);
                if (!prev || idx > prev.idx) recentByText.set(text, { part, idx });
            }
        });
        const recentList = [...recentByText.values()]
            .sort((a, b) => b.idx - a.idx)
            .slice(0, RECENT_SUBTAG_CHIP_LIMIT)
            .map((x) => x.part);

        const renderChip = (item, isFavorite) => {
            const text = getSubTagItemText(item);
            if (!text) return '';
            const active = currentValues.includes(text);
            const star = isFavorite ? ' ★' : '';
            const sourceFull = item._sourceFull ? String(item._sourceFull) : '';
            const sourceAttr = sourceFull
                ? ` data-source-full="${sourceFull.replace(/"/g, '&quot;')}"`
                : '';
            return `<button type="button" class="sub-chip${active ? ' active' : ''}"${sourceAttr} onclick="window.selectTag('${inputId}', ${valueExprForOnclick(text)}, this, false, '${subTagKey}', '${id}')">${text}${star}</button>`;
        };

        let html = '';
        if (myTagsList.length) {
            html += myTagsList.map((item) => renderChip(item, true)).join('');
        }
        if (recentList.length) {
            if (html) html += '<span class="sub-chip-divider" aria-hidden="true"></span>';
            html += recentList.map((item) => renderChip(item, false)).join('');
        }
        el.innerHTML = html;
    };

    const axis1List = getAxis1TagList(mode, tags);
    const axis2List = getAxis2TagList(mode, tags);
    const withList = tags.withWhom || [];

    if (isEntryFieldQuickInputOn('where', mode)) {
        renderPrimary(d.whereChips, axis1List, 'null', cfg.axis1SubTagKey, d.whereSuggestions);
    } else {
        const el = document.getElementById(d.whereChips);
        if (el) el.innerHTML = '';
    }
    if (isEntryFieldQuickInputOn('what', mode)) {
        renderPrimary(d.whatChips, axis2List, 'null', cfg.axis2SubTagKey, d.whatSuggestions);
    } else {
        const el = document.getElementById(d.whatChips);
        if (el) el.innerHTML = '';
    }
    if (isEntryFieldQuickInputOn('with', mode)) {
        renderPrimary(d.withChips, withList, 'null', ENTRY_MODE_CONFIG.withSubTagKey, d.withSuggestions);
    } else {
        const el = document.getElementById(d.withChips);
        if (el) el.innerHTML = '';
    }

    window.renderSecondary(d.whereSuggestions, subTags?.place || [], d.whereInput, null, cfg.axis1SubTagKey);

    window.renderSecondary(
        d.whatSuggestions,
        subTags?.[cfg.axis2SubTagsKey] || [],
        d.whatInput,
        null,
        cfg.axis2SubTagKey
    );

    window.renderSecondary(
        d.withSuggestions,
        subTags?.people || [],
        d.withInput,
        null,
        ENTRY_MODE_CONFIG.withSubTagKey
    );
}
