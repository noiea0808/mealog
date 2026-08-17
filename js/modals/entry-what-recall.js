/**
 * 기록 시트 — '무엇을' 회상 줄 (docs/entry-axes-and-tags-direction.md §4 역할② 입력 가속)
 *
 * 한 줄을 두 모드가 나눠 쓴다:
 *  - frequent  : 입력란에 포커스했는데 지금 적을 항목이 비었을 때 → 내가 자주 적은 음식 칩
 *  - typeahead : 뭔가 적는 중일 때 → 그 글자를 포함하는 내 과거 표기 칩
 *
 * 왜 typeahead 가 핵심인가: 음식 텍스트 재사용률은 14%뿐이라(entry-sheet-redesign.md §4)
 * 아무 단서 없이 칩을 들이미는 frequent 단독으로는 적중률이 구조적으로 낮다. 반면 사용자가
 * 이미 몇 글자를 친 상태는 후보가 좁혀진 상태라 적중률이 다르다. 덤으로 표기 흔들림
 * ('아아'/'아이스 아메리카노')이 과거 표기로 수렴하면서 재사용률 자체가 올라간다.
 *
 * 표본은 window.mealHistory 하나뿐이라 추가 저장·네트워크가 0이다
 * (맥락 예측과 같은 원천 — entry-axes-and-tags-direction.md §5 '개인화 비용').
 *
 * **이 줄은 ✨분류행 아래에 뜬다.** 위에 두면 뜰 때마다 분류행을 밀어내 "지금 무슨 구분이
 * 붙는가"가 눈에서 달아났다. 분류행은 값의 표시자라 자리가 고정돼야 하고, 이 줄은 입력
 * 중에만 잠깐 나타났다 사라지는 쪽이다.
 *
 * 닫히는 시점은 포커스가 아니라 **타이핑이 멎는 순간**이다(IDLE_CLOSE_MS). 포커스로만
 * 판정하면 '치킨'을 치는 내내 치킨까스·치킨너겟이 붙어 있는다.
 *
 * 순위·색인 로직은 js/utils/what-recall-index.js (순수, 단위 테스트 대상).
 * 이 모듈의 어떤 실패도 입력·저장을 막아선 안 된다 — 전부 best-effort.
 */
import { refreshLucideIcons } from '../icons.js';
import { logUsageMetric } from '../usage-metrics.js';
import { isSnackSlot, isSkipRecord } from './entry-context-predict.js';
import {
    buildRecallIndex,
    normKey,
    pickFrequent,
    pickTypeahead,
    splitActive,
} from '../utils/what-recall-index.js';

const CONTAINER_ID = 'entryWhatRecall';
const INPUT_ID = 'entryWhatInput';
const EMPTY_CLASS = 'entry-recall-row--empty';

/** 타이핑 중 칩이 매 글자 깜빡이지 않게 — 한글 조합 중간 상태를 대부분 건너뛴다 */
const DEBOUNCE_MS = 120;
/** blur 직후 칩을 탭하는 경우가 있어 곧바로 지우지 않는다 (탭하면 pointerdown 이 취소) */
const HIDE_DELAY_MS = 180;
/**
 * 타이핑이 멎으면 자동완성을 닫는다.
 *
 * 포커스로만 판정하면 "입력이 끝났다"를 영영 알 수 없다 — '치킨'을 치는 동안 계속
 * 치킨까스·치킨너겟이 붙어 있게 된다. 손이 멈춘 것이 곧 "이 이름으로 정했다"는 신호다.
 * 다시 타이핑하면 즉시 되살아나므로 일찍 닫혀도 손해가 없고, 줄이 분류행 **아래**에
 * 있어 늦게 닫혀도 가리는 것이 없다 — 그래서 넉넉한 쪽으로 잡았다.
 */
const IDLE_CLOSE_MS = 5000;
const FREQUENT_LIMIT = 6;
const TYPEAHEAD_LIMIT = 6;

const state = {
    slotId: '',
    /** @type {ReturnType<typeof buildRecallIndex>} */
    index: [],
    /** @type {'frequent'|'typeahead'|null} */
    mode: null,
    /** @type {Array<{key:string,text:string}>} */
    items: [],
    focused: false,
    /** 타이핑이 멎어 자동완성을 닫은 상태 — 다시 치면 풀린다 */
    idleClosed: false,
    shown: { frequent: false, typeahead: false },
};

let debounceTimer = null;
let hideTimer = null;
let idleTimer = null;

/** 사용자가 적은 원문이 innerHTML·속성으로 들어가므로 반드시 이스케이프 */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/**
 * 키보드가 열려 있는 동안에는 시트 높이 재측정이 막혀 있다(entry-sheet-tabs.js).
 * 회상 줄은 정확히 그 상태(포커스=키보드)에서 생기므로, 늘어난 만큼을 직접 통지하지 않으면
 * 칩이 키보드 뒤에 숨는다. ✨분류 제안이 쓰는 우회와 같은 것.
 */
function notifyGrowth(el, heightBefore) {
    const grew = el.offsetHeight - heightBefore;
    if (grew > 0 && typeof window.syncEntrySheetHeightLock === 'function') {
        window.syncEntrySheetHeightLock({ growthPx: grew });
    }
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;
    const heightBefore = el.offsetHeight;

    if (!state.mode || state.items.length === 0) {
        el.innerHTML = '';
        el.classList.add(EMPTY_CLASS);
        return;
    }
    el.classList.remove(EMPTY_CLASS);

    const chips = state.items
        .map((it) => {
            const safe = escapeHtml(it.text);
            return `<button type="button" class="entry-recall-chip" data-recall-text="${safe}">${safe}</button>`;
        })
        .join('');
    /**
     * 라벨은 frequent 에만, 그리고 **아이콘만** 둔다 — 시계 아이콘이 '자주'라는 뜻을 이미
     * 전하고, 글자까지 두면 한 줄 폭을 그만큼 잡아먹는다.
     * typeahead 는 방금 친 글자가 맥락이라 라벨 자체가 필요 없다.
     */
    const label = state.mode === 'frequent'
        ? `<span class="entry-recall-label" role="img" aria-label="자주 먹는 것" title="자주 먹는 것">
                <i data-lucide="history" aria-hidden="true"></i>
            </span>`
        : '';

    /**
     * 칩은 줄바꿈하지 않고 가로로 흐른다 — 이 줄은 입력 중에 잠깐 뜨는 것이라 두 줄이 되면
     * 시트가 그만큼 출렁인다. 넘치는 칩은 잘려 보이는 것이 곧 "옆으로 더 있다"는 신호다.
     *
     * 닫기(✕)는 두지 않는다. 이 줄은 스스로 사라진다 — 타이핑이 멎으면(유휴), 입력란을
     * 벗어나면(blur), 칩을 고르면. 닫기 버튼은 그 위에 얹는 네 번째 방법일 뿐이고
     * 좁은 한 줄에서 칩 자리만 빼앗는다.
     */
    el.innerHTML = `${label}<div class="entry-recall-scroll">${chips}</div>`;
    refreshLucideIcons(el);
    notifyGrowth(el, heightBefore);
}

function logShown(mode) {
    if (!mode || state.shown[mode]) return;
    state.shown[mode] = true;
    logUsageMetric(mode === 'typeahead' ? 'what_typeahead_shown' : 'what_recall_shown').catch(() => {});
}

/**
 * 자동완성일 때만 유휴 타이머를 건다.
 * frequent(빈 항목에 포커스)는 사용자가 고민하는 중이라 가만히 있다고 닫으면 안 된다 —
 * 그 줄은 애초에 "아직 안 정했다"는 상태에서 내미는 것이다.
 */
function scheduleIdleClose() {
    clearTimeout(idleTimer);
    if (state.mode !== 'typeahead') return;
    idleTimer = setTimeout(() => {
        state.idleClosed = true;
        update();
    }, IDLE_CLOSE_MS);
}

function update() {
    try {
        const input = document.getElementById(INPUT_ID);
        let mode = null;
        let items = [];
        if (input && state.focused && state.index.length > 0) {
            const value = input.value || '';
            const query = normKey(splitActive(value).active);
            if (query) {
                // 손이 멎어 닫힌 뒤에는 다시 칠 때까지 조용히 있는다
                if (!state.idleClosed) {
                    mode = 'typeahead';
                    items = pickTypeahead(state.index, query, value, TYPEAHEAD_LIMIT);
                }
            } else {
                // 항목을 비웠거나 쉼표를 찍었다 = 다음 항목의 시작. 닫힘을 푼다
                state.idleClosed = false;
                mode = 'frequent';
                items = pickFrequent(state.index, value, FREQUENT_LIMIT);
            }
        }
        if (items.length === 0) mode = null;
        state.mode = mode;
        state.items = items;
        render();
        scheduleIdleClose();
        logShown(mode);
    } catch (_) {
        /* 회상 실패가 입력을 막으면 안 된다 */
    }
}

/** 칩 탭 — 지금 적고 있던 항목을 고른 값으로 바꾼다 (앞의 확정 항목은 그대로) */
function applyPick(text) {
    const input = document.getElementById(INPUT_ID);
    if (!input) return;
    const { head } = splitActive(input.value || '');
    input.value = head ? `${head} ${text}` : text;
    state.focused = true;
    try {
        input.focus({ preventScroll: true });
    } catch (_) {
        input.focus();
    }
    try {
        const end = input.value.length;
        input.setSelectionRange(end, end);
    } catch (_) {
        /* 커서 위치는 부수적이다 — 실패해도 값은 들어갔다 */
    }
    /**
     * 기존 input 리스너를 그대로 태운다: ✨분류 재계산, textarea 자동 높이, 맥락 줄 갱신.
     * 값을 코드로 넣었으니 이벤트도 우리가 쏴 줘야 한다.
     */
    input.dispatchEvent(new Event('input', { bubbles: true }));
    update();
}

function onContainerClick(e) {
    clearTimeout(hideTimer);
    const chip = e.target.closest('[data-recall-text]');
    if (!chip) return;
    const text = chip.getAttribute('data-recall-text') || '';
    if (!text) return;
    logUsageMetric(state.mode === 'typeahead' ? 'what_typeahead_picked' : 'what_recall_picked').catch(() => {});
    applyPick(text);
}

/** 시트를 열 때 1회 — 이 기록의 슬롯으로 색인을 만든다 */
export function setupEntryWhatRecall({ slotId } = {}) {
    state.slotId = String(slotId || '');
    state.mode = null;
    state.items = [];
    state.focused = false;
    state.idleClosed = false;
    state.shown = { frequent: false, typeahead: false };
    try {
        const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        state.index = buildRecallIndex(history, {
            slotId: state.slotId,
            isSnackSlot,
            isSkipRecord,
        });
    } catch (_) {
        state.index = [];
    }
    render();
}

export function resetEntryWhatRecall() {
    clearTimeout(debounceTimer);
    clearTimeout(hideTimer);
    clearTimeout(idleTimer);
    state.mode = null;
    state.items = [];
    state.focused = false;
    state.idleClosed = false;
    render();
}

export function initEntryWhatRecall() {
    const input = document.getElementById(INPUT_ID);
    if (input && !input._whatRecallBound) {
        input._whatRecallBound = true;
        input.addEventListener('focus', () => {
            clearTimeout(hideTimer);
            state.focused = true;
            state.idleClosed = false;
            update();
        });
        input.addEventListener('blur', () => {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                state.focused = false;
                update();
            }, HIDE_DELAY_MS);
        });
        /**
         * 조합 중(compositionend 대기)에도 갱신한다 — '김'까지만 쳤을 때 후보가 떠야 의미가 있다.
         * 대신 짧은 디바운스로 자모 중간 상태('ㄱ')가 만드는 깜빡임을 줄인다.
         */
        input.addEventListener('input', () => {
            // 다시 치기 시작했다 = 아직 안 끝났다. 유휴로 닫힌 상태를 즉시 푼다
            state.idleClosed = false;
            clearTimeout(idleTimer);
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(update, DEBOUNCE_MS);
        });
    }
    const el = document.getElementById(CONTAINER_ID);
    if (el && !el._whatRecallBound) {
        el._whatRecallBound = true;
        // 칩을 누르면 입력란이 blur 되는데, 그 사이 줄이 사라지면 클릭이 허공을 친다
        el.addEventListener('pointerdown', () => clearTimeout(hideTimer));
        el.addEventListener('click', onContainerClick);
    }
}
