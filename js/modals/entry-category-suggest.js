/**
 * 기록 시트 — 카테고리 자동 분류 제안 칩 (docs/entry-sheet-redesign.md §2 1층)
 *
 * 텍스트 입력을 debounce로 분류해 ✨점선 칩을 띄운다.
 * - 탭 → 확정 (저장 시 category, source='user')
 * - 무시하고 저장 → categoryAuto, source='local'
 * - ✕ → 거부 (분류 없이 저장, 서버 backfill도 건너뜀)
 *
 * 분류는 순수 동기(food-classifier)라 저장 경로와 상호작용이 없다.
 * 이 모듈의 어떤 실패도 저장을 막아선 안 된다 — 렌더는 전부 best-effort.
 */
import { appState } from '../state.js';
import { classifyFoodText } from '../utils/food-classifier.js';
import { refreshLucideIcons } from '../icons.js';

const CONTAINER_ID = 'entryCategorySuggest';
const INPUT_ID = 'entryWhatInput';
const DEBOUNCE_MS = 300;

const state = {
    suggestions: /** @type {string[]} */ ([]),
    confirmed: /** @type {string|null} */ (null),
    dismissed: false,
};

let debounceTimer = null;

function isMealMode() {
    return appState.entryFormMode !== 'snack';
}

/**
 * 저장 어댑터가 읽는 결과.
 * @returns {{ confirmed: string|null, top: string|null, dismissed: boolean }}
 */
export function getEntryCategorySuggestResult() {
    return {
        confirmed: state.confirmed,
        top: state.suggestions.length > 0 ? state.suggestions[0] : null,
        dismissed: state.dismissed,
    };
}

/** 시트 열기·기록 로드·저장 완료 시 호출 — 상태와 UI를 초기화 */
export function resetEntryCategorySuggest() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    state.suggestions = [];
    state.confirmed = null;
    state.dismissed = false;
    render();
}

/** 기록 로드 등 프로그램적 입력 변경 후 제안을 다시 계산 (input 이벤트가 안 도니까) */
export function recomputeEntryCategorySuggest() {
    runClassify();
}

function runClassify() {
    try {
        if (!isMealMode()) {
            state.suggestions = [];
            render();
            return;
        }
        const input = document.getElementById(INPUT_ID);
        const text = (input?.value || '').trim();
        const next = text ? classifyFoodText(text) : [];
        // 제안이 그대로면 확정·거부 상태 유지, 바뀌면 리셋 (텍스트가 바뀌어 근거가 달라짐)
        const changed =
            next.length !== state.suggestions.length ||
            next.some((c, i) => c !== state.suggestions[i]);
        state.suggestions = next;
        if (changed) {
            if (state.confirmed && !next.includes(state.confirmed)) state.confirmed = null;
            if (next.length > 0) state.dismissed = false;
        }
        render();
    } catch (_) {
        /* 제안 실패는 무시 — 입력·저장에 영향 금지 */
    }
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;

    if (!isMealMode() || state.dismissed || state.suggestions.length === 0) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }

    const chips = state.suggestions
        .map((category) => {
            const isConfirmed = state.confirmed === category;
            return `<button type="button"
                class="entry-suggest-chip${isConfirmed ? ' entry-suggest-chip--confirmed' : ''}"
                data-suggest-category="${category.replace(/"/g, '&quot;')}"
                aria-pressed="${isConfirmed}">
                <i data-lucide="${isConfirmed ? 'check' : 'sparkles'}" aria-hidden="true"></i>${category}
            </button>`;
        })
        .join('');

    const hint = state.confirmed
        ? '<span class="entry-suggest-hint">확정됨</span>'
        : '<span class="entry-suggest-hint">그냥 저장해도 자동으로 붙어요</span>';

    el.innerHTML = `${chips}${hint}
        <button type="button" class="entry-suggest-dismiss" data-suggest-dismiss aria-label="자동 분류 제안 닫기">
            <i data-lucide="x" aria-hidden="true"></i>
        </button>`;
    el.classList.remove('hidden');
    refreshLucideIcons(el);
}

function onContainerClick(e) {
    const dismissBtn = e.target.closest('[data-suggest-dismiss]');
    if (dismissBtn) {
        state.dismissed = true;
        state.confirmed = null;
        render();
        return;
    }
    const chip = e.target.closest('[data-suggest-category]');
    if (chip) {
        const category = chip.getAttribute('data-suggest-category') || '';
        state.confirmed = state.confirmed === category ? null : category;
        render();
    }
}

/** 시트 초기화 시 1회 호출 — input 리스너와 클릭 위임을 바인딩 */
export function initEntryCategorySuggest() {
    const input = document.getElementById(INPUT_ID);
    if (input && !input._categorySuggestBound) {
        input._categorySuggestBound = true;
        input.addEventListener('input', () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(runClassify, DEBOUNCE_MS);
        });
    }
    const container = document.getElementById(CONTAINER_ID);
    if (container && !container._categorySuggestBound) {
        container._categorySuggestBound = true;
        container.addEventListener('click', onContainerClick);
    }
}
