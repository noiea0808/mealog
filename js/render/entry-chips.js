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
import { frequentSubTagValues } from '../utils/frequent-subtags.js';

/** 서브 칩 상한 */
const SUBTAG_CHIP_LIMIT = 10;

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
    // 이미 같은 뷰면 클래스·높이 잠금을 다시 돌리지 않음 (입력 중 깜빡임 방지)
    if (stage.classList.contains('entry-tag-stage--sub') === toSub) {
        const back = stage.querySelector('[data-entry-tag-back]');
        if (back) back.setAttribute('aria-hidden', toSub ? 'false' : 'true');
        return;
    }
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

    /**
     * 서브 칩 축별 표본 정의 — 어느 기록 필드를 어느 부모로 좁혀 세는가.
     * (js/utils/frequent-subtags.js)
     */
    const SUBTAG_SOURCE = {
        place: { field: 'place', splitCommas: false },
        people: { field: 'withWhomDetail', parentField: 'withWhom', splitCommas: true },
        menu: { field: 'menuDetail', parentField: 'category', splitCommas: true },
        snack: { field: 'menuDetail', parentField: 'snackType', splitCommas: true },
    };

    /**
     * 부모 칩 하나에 딸린 서브 칩 목록.
     *
     * **나만의 태그는 없다** (2026-08-18). 사용자가 마이 > 태그에 미리 등록해 두던 '사용자'
     * 블록을 걷어내고, 그 자리를 내 이력의 빈도 추천으로 갈음했다 — 목록을 손으로 관리하지
     * 않아도 자주 쓰는 값은 이력이 안다 (docs/entry-axes-and-tags-direction.md §4).
     *
     * 그래서 이 함수는 이제 `userSettings.subTags` 를 읽지 않는다. 표본은 `mealHistory`
     * 하나뿐이라 추가 저장도 네트워크도 0이다.
     */
    window.renderSecondary = (id, inputId, parentFilter = null, subTagKey = null, opts = {}) => {
        const el = document.getElementById(id);
        if (!el) return;
        const preserveStage = opts?.preserveStage === true;

        if (!parentFilter) {
            if (preserveStage) return;
            el.innerHTML = '';
            setEntryTagStageView(id, 'main');
            if (typeof window.syncEntrySheetHeightLock === 'function') {
                window.syncEntrySheetHeightLock();
            }
            return;
        }

        const source = SUBTAG_SOURCE[subTagKey];
        /**
         * '어디서'의 부모는 모드에 따라 다르다 — 끼니는 조달 형태(어떻게), 간식은 장소
         * 대분류다. 간식은 `snackPlaceMain` 이 비고 `place` 에만 값이 남은 옛 기록이 있어
         * 그쪽도 함께 본다.
         */
        const placeParent =
            mode === 'snack'
                ? { parentField: 'snackPlaceMain', parentFallbackFields: ['place'] }
                : { parentField: 'mealType' };
        const query =
            source && subTagKey === 'place' ? { ...source, ...placeParent } : source;

        const chipValues = query
            ? frequentSubTagValues(window.mealHistory, {
                  ...query,
                  parent: parentFilter,
                  limit: SUBTAG_CHIP_LIMIT,
              })
            : [];

        const currentInputVal = document.getElementById(inputId)?.value || '';
        const isMultiSelect = id === d.whatSuggestions || id === d.withSuggestions;
        const currentValues = isMultiSelect
            ? currentInputVal.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
            : [currentInputVal];

        const renderChip = (text) => {
            const active = currentValues.includes(text);
            return `<button type="button" class="sub-chip${active ? ' active' : ''}" onclick="window.selectTag('${inputId}', ${valueExprForOnclick(text)}, this, false, '${subTagKey}', '${id}')">${text}</button>`;
        };

        el.innerHTML = `
            <div class="entry-subtag-block entry-subtag-block--recent">
                <span class="entry-subtag-label">자주</span>
                <div class="entry-subtag-chips-shell${chipValues.length ? '' : ' entry-subtag-chips-shell--empty'}">
                    <div class="entry-subtag-chips${chipValues.length ? '' : ' entry-subtag-chips--empty'}">${
                        chipValues.length
                            ? chipValues.map(renderChip).join('')
                            : `<p class="entry-subtag-empty entry-subtag-empty--muted">기록이 쌓이면 자주 쓰는 항목을 여기 올려드려요.</p>`
                    }</div>
                    <span class="entry-subtag-scroll-hint" hidden aria-hidden="true" title="옆으로 밀어 더 보기">
                        <i data-lucide="chevrons-right" aria-hidden="true"></i>
                    </span>
                </div>
            </div>
        `;
        if (chipValues.length) refreshLucideIcons(el);
        syncEntrySubtagScrollHints(el);
        if (!preserveStage) {
            setEntryTagStageView(id, 'sub');
        }
        const stage = el.closest('.entry-tag-stage');
        if (stage) refreshLucideIcons(stage);
        if (!preserveStage && typeof window.syncEntrySheetHeightLock === 'function') {
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

    window.renderSecondary(d.whereSuggestions, d.whereInput, null, cfg.axis1SubTagKey);
    window.renderSecondary(d.whatSuggestions, d.whatInput, null, cfg.axis2SubTagKey);
    window.renderSecondary(d.withSuggestions, d.withInput, null, ENTRY_MODE_CONFIG.withSubTagKey);
}
