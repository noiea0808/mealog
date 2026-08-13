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
import { classifyFoodDetail, classifySnackText, classifyCuisineText } from '../utils/food-classifier.js';
import { refreshLucideIcons } from '../icons.js';
import { logUsageMetric } from '../usage-metrics.js';
import { updateEntryContextFoodCategory } from './entry-context-predict.js';

const CONTAINER_ID = 'entryCategorySuggest';
const INPUT_ID = 'entryWhatInput';
const DEBOUNCE_MS = 300;

const state = {
    suggestions: /** @type {string[]} */ ([]),
    confirmed: /** @type {string|null} */ (null),
    /** 텍스트에서 도출한 요리 종류 (한식·중식…) — 자동 저장 전용, UI에 안 나온다 */
    cuisine: /** @type {string|null} */ (null),
    dismissed: false,
    /** 이번 시트 세션에서 노출 집계를 이미 보냈는지 (키 입력마다 부풀지 않게) */
    shownLogged: false,
};

let debounceTimer = null;

/** 사전에서 온 값이지만 innerHTML 로 들어가므로 이스케이프한다 */
function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function isMealMode() {
    return appState.entryFormMode !== 'snack';
}

/**
 * 저장 어댑터가 읽는 결과.
 * cuisine(요리 종류)은 사용자에게 묻지 않고 텍스트에서 도출되는 사실이라
 * 확정·거부와 무관하게 항상 값이 있다 (placeType 과 같은 사실-유도 패턴).
 * @returns {{ confirmed: string|null, top: string|null, dismissed: boolean, cuisine: string|null }}
 */
export function getEntryCategorySuggestResult() {
    return {
        confirmed: state.confirmed,
        top: state.suggestions.length > 0 ? state.suggestions[0] : null,
        dismissed: state.dismissed,
        cuisine: state.cuisine,
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
    state.cuisine = null;
    state.dismissed = false;
    state.shownLogged = false;
    render();
}

/** 기록 로드 등 프로그램적 입력 변경 후 제안을 다시 계산 (input 이벤트가 안 도니까) */
export function recomputeEntryCategorySuggest() {
    runClassify();
}

function runClassify() {
    try {
        const input = document.getElementById(INPUT_ID);
        const text = (input?.value || '').trim();
        let next = [];
        state.cuisine = null;
        if (text) {
            if (isMealMode()) {
                // 형태·요리종류를 한 번에 — 요리종류는 UI에 안 나오고 저장만 된다
                const detail = classifyFoodDetail(text);
                next = detail.forms;
                state.cuisine = detail.cuisine;
            } else {
                next = classifySnackText(text, window.userSettings?.tags?.snackType || null);
                state.cuisine = classifyCuisineText(text);
            }
        }
        // 제안이 그대로면 확정·거부 상태 유지, 바뀌면 리셋 (텍스트가 바뀌어 근거가 달라짐)
        const changed =
            next.length !== state.suggestions.length ||
            next.some((c, i) => c !== state.suggestions[i]);
        state.suggestions = next;
        if (changed) {
            if (state.confirmed && !next.includes(state.confirmed)) state.confirmed = null;
            if (next.length > 0) state.dismissed = false;
        }
        if (next.length > 0 && !state.shownLogged) {
            state.shownLogged = true;
            logUsageMetric('category_suggest_shown').catch(() => {});
        }
        render();
        // 맥락 줄의 어떻게 추론('집+밥/한상→집밥')에 분류 1순위를 공급 — best-effort
        try {
            updateEntryContextFoodCategory(next.length > 0 ? next[0] : null, state.cuisine);
        } catch (_) { /* 추론 실패가 제안 렌더를 막으면 안 된다 */ }
    } catch (_) {
        /* 제안 실패는 무시 — 입력·저장에 영향 금지 */
    }
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;

    /**
     * 빈 상태는 높이 0 — 텍스트를 넣어 제안이 뜰 때 그만큼 펼쳐진다.
     *
     * 시트 높이는 열릴 때 한 번 재는데 입력 중에는 키보드가 열려 있어 재측정이 막혀 있다
     * (entry-sheet-tabs.js syncEntrySheetHeightLock의 keyboard-open 가드). 그래서 늘어난
     * 높이를 growthPx로 직접 통지해, 키보드가 열린 상태에서도 시트가 칩만큼 커지게 한다.
     * (예전에는 이 문제를 빈 자리 예약으로 피했지만 늘 빈 띠가 보였다.)
     */
    const heightBefore = el.offsetHeight;
    const notifyGrowth = () => {
        const grew = el.offsetHeight - heightBefore;
        if (grew > 0 && typeof window.syncEntrySheetHeightLock === 'function') {
            window.syncEntrySheetHeightLock({ growthPx: grew });
        }
    };

    if (state.dismissed || state.suggestions.length === 0) {
        el.innerHTML = '';
        el.classList.add('entry-suggest-row--empty');
        return;
    }
    el.classList.remove('entry-suggest-row--empty');
    // 구버전 캐시 HTML(hidden 클래스 시절)과 섞여도 제안이 숨은 채 남지 않게
    el.classList.remove('hidden');

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

    /**
     * 요리 종류는 **읽기 전용 꼬리표**다 — 사용자가 고르는 값이 아니라 붙는 값이라
     * 버튼이 아니라 라벨로 둔다. 축을 하나 더 묻지 않으면서 "이렇게 기록됩니다"만 보여준다.
     * (교정 수요가 확인되면 그때 '세부' 영역에 넣는다)
     */
    // '기타'는 정보량이 없어 화면에는 띄우지 않는다 (저장은 그대로 — 집계에서 구분이 필요)
    const cuisineTag = state.cuisine && state.cuisine !== '기타'
        ? `<span class="entry-suggest-cuisine">${escapeAttr(state.cuisine)}</span>`
        : '';

    const hint = state.confirmed
        ? '<span class="entry-suggest-hint">확정됨</span>'
        : '<span class="entry-suggest-hint">그냥 저장해도 자동으로 붙어요</span>';

    el.innerHTML = `${chips}${cuisineTag}${hint}
        <button type="button" class="entry-suggest-dismiss" data-suggest-dismiss aria-label="자동 분류 제안 닫기">
            <i data-lucide="x" aria-hidden="true"></i>
        </button>`;
    refreshLucideIcons(el);
    notifyGrowth();
}

function onContainerClick(e) {
    const dismissBtn = e.target.closest('[data-suggest-dismiss]');
    if (dismissBtn) {
        state.dismissed = true;
        state.confirmed = null;
        logUsageMetric('category_suggest_dismissed').catch(() => {});
        render();
        return;
    }
    const chip = e.target.closest('[data-suggest-category]');
    if (chip) {
        const category = chip.getAttribute('data-suggest-category') || '';
        state.confirmed = state.confirmed === category ? null : category;
        if (state.confirmed) logUsageMetric('category_suggest_confirmed').catch(() => {});
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
