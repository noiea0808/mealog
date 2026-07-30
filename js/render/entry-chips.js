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
import { refreshLucideIcons } from '../icons.js';

/** 최근 서브태그 칩 상한 */
const RECENT_SUBTAG_CHIP_LIMIT = 10;

/**
 * 메인 칩 ↔ 사용자/최근 패널 전환.
 * @param {string} suggestionsId
 * @param {'main'|'sub'} view
 */
export function setEntryTagStageView(suggestionsId, view) {
    const suggestions = document.getElementById(suggestionsId);
    const stage = suggestions?.closest?.('.entry-tag-stage');
    if (!stage) return;
    const toSub = view === 'sub';
    stage.classList.toggle('entry-tag-stage--sub', toSub);
    const back = stage.querySelector('[data-entry-tag-back]');
    if (back) back.setAttribute('aria-hidden', toSub ? 'false' : 'true');
    if (typeof window.syncEntrySheetHeightLock === 'function') {
        window.syncEntrySheetHeightLock();
    }
}

if (typeof window !== 'undefined') {
    window.setEntryTagStageView = setEntryTagStageView;
}

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
    if (!/[,，]/.test(full)) {
        return [typeof item === 'string' ? { text: full, parent } : { ...item, text: full }];
    }
    const parts = full.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1) {
        return [typeof item === 'string' ? { text: full, parent } : { ...item, text: full }];
    }
    return parts.map((text) => ({ text, parent, _sourceFull: full }));
}

function getEntryFormMode() {
    return appState.entryFormMode === 'snack' ? 'snack' : 'meal';
}

/** 최근 태그 가로 넘침 시 스크롤 힌트(셰브론) 표시 */
function syncEntrySubtagScrollHints(root) {
    const shells = (root || document).querySelectorAll?.('.entry-subtag-chips-shell') || [];
    shells.forEach((shell) => {
        const chips = shell.querySelector('.entry-subtag-chips');
        const hint = shell.querySelector('.entry-subtag-scroll-hint');
        if (!chips || !hint) return;
        const update = () => {
            const overflow = chips.scrollWidth > chips.clientWidth + 2;
            const atEnd = chips.scrollLeft + chips.clientWidth >= chips.scrollWidth - 2;
            const show = overflow && !atEnd;
            shell.classList.toggle('entry-subtag-chips-shell--scrollable', overflow);
            hint.hidden = !show;
            hint.setAttribute('aria-hidden', show ? 'false' : 'true');
        };
        if (!chips._subtagScrollHintBound) {
            chips._subtagScrollHintBound = true;
            chips.addEventListener('scroll', update, { passive: true });
        }
        requestAnimationFrame(update);
    });
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
            ? currentInputVal.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
            : [currentInputVal];

        if (!parentFilter) {
            el.innerHTML = '';
            setEntryTagStageView(id, 'main');
            if (typeof window.syncEntrySheetHeightLock === 'function') {
                window.syncEntrySheetHeightLock();
            }
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
            const star = isFavorite
                ? ' <i data-lucide="star" class="sub-chip-favorite-star" aria-hidden="true"></i>'
                : '';
            const sourceFull = item._sourceFull ? String(item._sourceFull) : '';
            const sourceAttr = sourceFull
                ? ` data-source-full="${sourceFull.replace(/"/g, '&quot;')}"`
                : '';
            return `<button type="button" class="sub-chip${active ? ' active' : ''}"${sourceAttr} onclick="window.selectTag('${inputId}', ${valueExprForOnclick(text)}, this, false, '${subTagKey}', '${id}')">${text}${star}</button>`;
        };

        const userChipsHtml = myTagsList.length
            ? myTagsList.map((item) => renderChip(item, true)).join('')
            : `<p class="entry-subtag-empty">마이 → 태그에 등록하면 바로 고를 수 있어요.</p>`;
        const recentChipsHtml = recentList.length
            ? recentList.map((item) => renderChip(item, false)).join('')
            : `<p class="entry-subtag-empty entry-subtag-empty--muted">최근 사용한 항목이 아직 없어요.</p>`;

        el.innerHTML = `
            <div class="entry-subtag-block entry-subtag-block--user">
                <span class="entry-subtag-label">사용자</span>
                <div class="entry-subtag-chips${myTagsList.length ? '' : ' entry-subtag-chips--empty'}">${userChipsHtml}</div>
            </div>
            <div class="entry-subtag-block entry-subtag-block--recent">
                <span class="entry-subtag-label">최근</span>
                <div class="entry-subtag-chips-shell${recentList.length ? '' : ' entry-subtag-chips-shell--empty'}">
                    <div class="entry-subtag-chips${recentList.length ? '' : ' entry-subtag-chips--empty'}">${recentChipsHtml}</div>
                    <span class="entry-subtag-scroll-hint" hidden aria-hidden="true" title="옆으로 밀어 더 보기">
                        <i data-lucide="chevrons-right" aria-hidden="true"></i>
                    </span>
                </div>
            </div>
        `;
        if (myTagsList.length || recentList.length) refreshLucideIcons(el);
        syncEntrySubtagScrollHints(el);
        setEntryTagStageView(id, 'sub');
        const stage = el.closest('.entry-tag-stage');
        if (stage) refreshLucideIcons(stage);
        if (typeof window.syncEntrySheetHeightLock === 'function') {
            window.syncEntrySheetHeightLock();
        }
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
