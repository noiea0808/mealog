/**
 * 기록 시트 — '무엇을' 형태 축의 표시자 겸 자동 분류 제안 줄 (docs/entry-sheet-redesign.md §2 1층)
 *
 * **이 줄은 「지금 이 기록의 형태 값」을 보여주는 단일 창구다.** 값이 정해지는 경로는 둘이고
 * (✨제안 칩 탭 / 아래 형태 칩 그리드에서 직접 선택) 어느 쪽이든 결과는 여기 한 줄에 모인다.
 * 예전에는 그리드에서 고른 값이 여기 반영되지 않아, 저장은 그 값으로 되는데 화면은
 * "그냥 저장해도 자동으로 붙어요"라고 말하는 어긋남이 있었다.
 *
 * - 제안 칩 탭 / 그리드 선택 → 확정 (저장 시 category, source='user'). 확정되면 나머지
 *   추천 칩은 치운다 — 고른 뒤에도 틀린 후보가 옆에 남아 있을 이유가 없다.
 * - 무시하고 저장 → categoryAuto, source='local'
 * - ✕ → 거부 (분류 없이 저장, 서버 backfill도 건너뜀)
 * - '다른 구분' → 추천에 없는 값을 고르러 형태 칩 그리드를 펼친다. 그리드가 기본 접힘이라
 *   제안이 틀렸을 때 교정 입구가 화면에 없던 문제를 메운다.
 *
 * 분류는 순수 동기(food-classifier)라 저장 경로와 상호작용이 없다.
 * 이 모듈의 어떤 실패도 저장을 막아선 안 된다 — 렌더는 전부 best-effort.
 */
import { classifyFoodDetail } from '../utils/food-classifier.js';
import { refreshLucideIcons } from '../icons.js';
import { logUsageMetric } from '../usage-metrics.js';
import { updateEntryContextFoodCategory, keepEntryContextPredictVisible } from './entry-context-predict.js';
import { ENTRY_DOM } from './entry-form-config.js';
import {
    isEntryFieldQuickInputOn,
    setEntryFieldQuickInputEnabled,
    setEntryWhatGridOpenedHook,
} from './entry-quick-input.js';

const CONTAINER_ID = 'entryCategorySuggest';
const INPUT_ID = 'entryWhatInput';
const DEBOUNCE_MS = 300;

const state = {
    suggestions: /** @type {string[]} */ ([]),
    confirmed: /** @type {string|null} */ (null),
    /**
     * 확정값이 어디서 왔는지. 텍스트가 바뀌어 추천이 갈릴 때 'suggest' 확정은 근거를 잃지만
     * 'chips' 확정은 사용자가 전체 목록에서 직접 고른 것이라 살려 둔다.
     * @type {'suggest'|'chips'|null}
     */
    confirmedSource: null,
    /** 텍스트에서 도출한 요리 종류 (한식·중식…) — 자동 저장 전용, UI에 안 나온다 */
    cuisine: /** @type {string|null} */ (null),
    dismissed: false,
    /** 이번 시트 세션에서 노출 집계를 이미 보냈는지 (키 입력마다 부풀지 않게) */
    shownLogged: false,
};

/** 줄 → 그리드 반영 중에 그리드 → 줄 훅이 되돌아오는 것을 막는다 */
let syncingChips = false;

let debounceTimer = null;

/** 사전에서 온 값이지만 innerHTML 로 들어가므로 이스케이프한다 */
function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
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
    state.confirmedSource = null;
    state.cuisine = null;
    state.dismissed = false;
    state.shownLogged = false;
    render();
}

/** 형태 칩 그리드의 현재 선택 (그리드가 접혀 있으면 null — 읽을 DOM 자체가 없다) */
function getWhatChipButtons() {
    const chips = document.getElementById(ENTRY_DOM.whatChips);
    return chips ? [...chips.querySelectorAll('button.chip')] : [];
}

/**
 * 확정값을 형태 칩 그리드에 반영한다.
 * 클래스를 직접 만지지 않고 클릭을 태우는 이유는 selectTag 의 기존 동작(서브태그 렌더·
 * 단일 선택 해제)을 그대로 얻기 위해서다 — 맥락 줄의 '쓰기 경로'와 같은 규칙.
 */
function applyConfirmedToChips(value) {
    const buttons = getWhatChipButtons();
    if (buttons.length === 0) return;
    syncingChips = true;
    try {
        const target = value ? buttons.find((b) => b.textContent.trim() === value) : null;
        if (target) {
            if (!target.classList.contains('active')) target.click();
            return;
        }
        const active = buttons.find((b) => b.classList.contains('active'));
        if (active) active.click();
    } finally {
        syncingChips = false;
    }
}

/**
 * 지금 제안 중인 값을 그리드에서도 알아보게 표시한다.
 *
 * '다른 구분'으로 그리드를 펼쳤을 때 "위에 뜬 게 이 목록 어디쯤인지"가 안 보이면
 * 14개를 훑어야 한다. 생김새는 위 제안 칩과 같다(녹색 점선 테두리 + 녹색 글자).
 *
 * 다만 **`.active` 를 쓰면 안 된다** — active 는 사용자가 골랐다는 뜻이고 저장 시
 * `categorySource='user'` 가 된다. 제안은 아직 선택이 아니므로 표시만 한다.
 */
function applySuggestionHintToChips() {
    const buttons = getWhatChipButtons();
    if (buttons.length === 0) return;
    const hinted = !state.confirmed && !state.dismissed && state.suggestions.length > 0
        ? state.suggestions[0]
        : null;
    buttons.forEach((b) => {
        b.classList.toggle('chip--suggested', hinted != null && b.textContent.trim() === hinted);
    });
}

/**
 * 형태 칩 그리드에서 고른 값을 줄에 반영한다 (entry-and-core.js selectTag 가 호출).
 * 그리드가 접혀 있으면 읽을 칩이 없으므로 아무것도 하지 않는다.
 */
export function syncEntryCategorySuggestFromChips() {
    if (syncingChips) return;
    const buttons = getWhatChipButtons();
    if (buttons.length === 0) return;
    const active = buttons.find((b) => b.classList.contains('active'));
    const picked = active ? active.textContent.trim() : '';
    state.confirmed = picked || null;
    state.confirmedSource = picked ? 'chips' : null;
    if (picked) state.dismissed = false;
    render();
    pushFormToContext();
}

/**
 * 저장된 기록을 열 때 — 이미 정해진 형태 값을 줄에 그대로 세운다.
 * 그리드가 접혀 있어도 값은 있으므로 DOM 대신 기록에서 받는다.
 */
export function setEntryCategorySuggestConfirmed(value) {
    const v = typeof value === 'string' ? value.trim() : '';
    state.confirmed = v || null;
    state.confirmedSource = v ? 'chips' : null;
    if (v) state.dismissed = false;
    render();
    pushFormToContext();
}

/**
 * 맥락 줄의 어떻게 추론('집 + 밥류 → 집밥')에 형태 값을 공급한다.
 * 사용자가 교정했으면 추천 1순위가 아니라 **교정된 값**이 근거여야 한다.
 */
function pushFormToContext() {
    try {
        const form = state.confirmed || (state.suggestions.length > 0 ? state.suggestions[0] : null);
        updateEntryContextFoodCategory(form, state.cuisine);
    } catch (_) {
        /* 추론 실패가 제안 렌더를 막으면 안 된다 */
    }
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
            /**
             * 끼니·간식이 같은 분류를 쓴다 — 슬롯이 끼니/간식을 가르고, '무엇을'은 한 축이다
             * (docs/food-category-auto-classification.md §6.2).
             * 요리종류는 UI에 안 나오고 저장만 된다.
             */
            const detail = classifyFoodDetail(text);
            next = detail.forms;
            state.cuisine = detail.cuisine;
        }
        // 제안이 그대로면 확정·거부 상태 유지, 바뀌면 리셋 (텍스트가 바뀌어 근거가 달라짐)
        const changed =
            next.length !== state.suggestions.length ||
            next.some((c, i) => c !== state.suggestions[i]);
        state.suggestions = next;
        if (changed) {
            /**
             * 추천에서 확정한 값은 근거(그 추천)가 사라지면 함께 사라진다.
             * 반면 그리드에서 직접 고른 값은 사용자가 전체 목록을 보고 정한 것이라
             * 텍스트를 고쳤다고 지우면 안 된다 — 지우는 순간 교정이 무효가 된다.
             */
            if (state.confirmedSource === 'suggest' && state.confirmed && !next.includes(state.confirmed)) {
                state.confirmed = null;
                state.confirmedSource = null;
            }
            if (next.length > 0) state.dismissed = false;
        }
        if (next.length > 0 && !state.shownLogged) {
            state.shownLogged = true;
            logUsageMetric('category_suggest_shown').catch(() => {});
        }
        render();
        pushFormToContext();
    } catch (_) {
        /* 제안 실패는 무시 — 입력·저장에 영향 금지 */
    }
}

function render() {
    // 그리드 표시는 줄이 있든 없든(비어 있든) 항상 현재 상태를 따라가야 한다
    applySuggestionHintToChips();
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
        // 시트가 상한에 걸리면 늘어난 분이 스크롤로 흐른다 — 맥락 줄을 다시 보이게 되돌린다
        keepEntryContextPredictVisible();
    };

    /**
     * 사용자가 정한 상태(확정 / 분류 안 함)가 있으면 추천이 없어도 줄은 남는다 — 그 값의
     * 표시자니까. 회상 줄이 떠 있어도 숨지 않는다(간결 모드로만 바뀐다).
     */
    const hasUserState = Boolean(state.confirmed) || state.dismissed;
    if (!hasUserState && state.suggestions.length === 0) {
        el.innerHTML = '';
        el.classList.add('entry-suggest-row--empty');
        return;
    }
    /**
     * '분류 안 함'은 결정이지 화면 정리가 아니다 — 그 사실과 되돌릴 길을 남긴다.
     * 예전에는 줄이 통째로 사라져서 무엇을 골랐는지도, 어떻게 취소하는지도 알 수 없었다.
     */
    if (state.dismissed) {
        el.classList.remove('entry-suggest-row--empty', 'hidden');
        el.innerHTML = `
            <span class="entry-suggest-hint entry-suggest-hint--off">
                <i data-lucide="ban" aria-hidden="true"></i>구분 없이 저장
            </span>
            <span class="entry-suggest-actions">
                <button type="button" class="entry-suggest-action" data-suggest-undismiss>되돌리기</button>
            </span>`;
        refreshLucideIcons(el);
        notifyGrowth();
        return;
    }
    el.classList.remove('entry-suggest-row--empty');
    // 구버전 캐시 HTML(hidden 클래스 시절)과 섞여도 제안이 숨은 채 남지 않게
    el.classList.remove('hidden');

    /**
     * 확정된 뒤에는 그 값 하나만 남긴다. 고르고 나서도 탈락한 후보가 옆에 붙어 있으면
     * "지금 뭐로 기록되는가"가 두 개로 보인다 — 개별 삭제 버튼이 필요해 보였던 이유가 이것이다.
     */
    const shownChips = state.confirmed ? [state.confirmed] : state.suggestions;
    const chips = shownChips
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

    /**
     * 미확정 상태의 안내 문구("그냥 저장해도 자동으로 붙어요")는 뺐다 — 행동 버튼 둘이
     * 우측에 자리를 잡으면서 좁은 폰에서 줄이 접혔고, 점선 ✨칩 자체가 이미 "제안"을 말한다.
     */
    const hint = state.confirmed ? '<span class="entry-suggest-hint">확정됨</span>' : '';

    /**
     * 추천에 없는 값을 고르러 가는 입구. 그리드가 이미 펼쳐져 있으면 필요 없다.
     * 이게 없으면 교정 경로가 '무엇을' 라벨 옆 셰브론뿐인데, 그건 교정 수단으로 읽히지 않는다.
     */
    const openGridBtn = isEntryFieldQuickInputOn('what')
        ? ''
        : '<button type="button" class="entry-suggest-action" data-suggest-open-grid>다른 구분</button>';
    /**
     * 확정된 값을 '거부'하는 건 말이 안 된다 — 되돌리려면 칩을 다시 탭하면 된다.
     *
     * 예전에는 ✕ 아이콘이었는데, ✕는 "이 줄 치워줘"로 읽히는 반면 실제 효과는
     * **구분을 비워 저장하고 서버 backfill 까지 막는** 데이터 결정이다. 바로 옆 힌트가
     * "자동으로 붙어요"라고 말하고 있어 어긋남이 더 컸다. 결과를 그대로 라벨로 적는다.
     */
    const dismissBtn = state.confirmed
        ? ''
        : '<button type="button" class="entry-suggest-action" data-suggest-dismiss>분류 안 함</button>';

    // 행동 버튼은 한 덩어리로 묶어 오른쪽 끝에 붙인다 — 값(칩)과 조작이 섞이지 않게
    const actions = openGridBtn || dismissBtn
        ? `<span class="entry-suggest-actions">${openGridBtn}${dismissBtn}</span>`
        : '';
    el.innerHTML = `${chips}${cuisineTag}${hint}${actions}`;
    refreshLucideIcons(el);
    notifyGrowth();
}

function setConfirmed(value, source) {
    state.confirmed = value || null;
    state.confirmedSource = value ? source : null;
    if (value) state.dismissed = false;
    applyConfirmedToChips(state.confirmed);
    render();
    pushFormToContext();
}

function onContainerClick(e) {
    if (e.target.closest('[data-suggest-open-grid]')) {
        logUsageMetric('category_suggest_grid_opened').catch(() => {});
        // 확정값 되붙이기·시트 높이는 onWhatGridOpened 훅이 처리한다 (셰브론으로 열 때와 같은 길)
        setEntryFieldQuickInputEnabled('what', true);
        return;
    }
    if (e.target.closest('[data-suggest-undismiss]')) {
        state.dismissed = false;
        logUsageMetric('category_suggest_undismissed').catch(() => {});
        // 텍스트는 그대로이므로 추천을 다시 계산해 원래 상태로 돌린다
        runClassify();
        return;
    }
    const dismissBtn = e.target.closest('[data-suggest-dismiss]');
    if (dismissBtn) {
        state.dismissed = true;
        setConfirmed(null, null);
        logUsageMetric('category_suggest_dismissed').catch(() => {});
        return;
    }
    const chip = e.target.closest('[data-suggest-category]');
    if (chip) {
        const category = chip.getAttribute('data-suggest-category') || '';
        const next = state.confirmed === category ? null : category;
        setConfirmed(next, 'suggest');
        if (next) logUsageMetric('category_suggest_confirmed').catch(() => {});
    }
}

/**
 * 그리드가 펼쳐진 직후 — 새로 그려진 칩에 확정값을 되붙이고 줄을 다시 그린다.
 * ('다른 구분' 버튼이 사라지고 그리드 안 제안 표시가 살아나야 하므로 render 도 함께)
 */
function onWhatGridOpened() {
    applyConfirmedToChips(state.confirmed);
    render();
    if (typeof window.syncEntrySheetHeightLock === 'function') window.syncEntrySheetHeightLock();
}

/** 시트 초기화 시 1회 호출 — input 리스너와 클릭 위임을 바인딩 */
export function initEntryCategorySuggest() {
    setEntryWhatGridOpenedHook(onWhatGridOpened);
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
