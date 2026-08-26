/**
 * 기록 시트 — '무엇을' placeholder 힌트 로테이션
 *
 * placeholder 는 두 줄이다. 첫 줄("무엇을 드셨나요?")은 입력란의 정체라 고정하고,
 * 둘째 줄만 힌트로 돌린다. 앱의 기능은 기록 시트 밖에 흩어져 있는데(하루 소감의
 * 체중·혈당 → 밀당>건강, 마이>밀당 메모 …) 사용자가 가장 자주 머무는 화면은 이 시트다.
 * 빈 입력란의 둘째 줄은 그 사실을 알릴 수 있는 유일하게 공짜인 자리다 — 아무것도
 * 가리지 않고, 글자를 치는 순간 알아서 사라진다.
 *
 * 회전 단위는 **시트 1회 열기**다. 열려 있는 동안 문구가 바뀌면 정작 입력하려는
 * 순간 시선을 빼앗는다. 커서는 localStorage 에 남겨 다음 기록에서 이어간다 —
 * 매번 무작위로 뽑으면 같은 힌트만 반복해 보게 되는 사용자가 생긴다.
 *
 * 문구 규칙: 둘째 줄은 **한 줄 안에** 들어가야 한다. rows=2 짜리 입력란이라 두 줄로
 * 접히는 순간 뒤가 잘린다. 375px 기기의 가용 폭이 275px(15px Pretendard)이고 더 좁은
 * 기기가 있으니 250px 안쪽 — 한글 약 17자 — 을 상한으로 본다. 문구를 고칠 때는
 * canvas measureText 로 재보고 넣는다.
 */

/**
 * @typedef {{ id: string, text: string, scope?: 'all'|'meal'|'snack' }} EntryWhatHint
 */

/** @type {EntryWhatHint[]} */
export const ENTRY_WHAT_HINTS = [
    { id: 'auto-category', text: '적으면 구분을 자동으로 붙여드려요.' },
    { id: 'health-record', text: '하루 소감엔 체중·혈당도 적을 수 있어요.' },
    { id: 'frequent', text: '톡 누르면 자주 먹은 것부터 보여드려요.' },
    { id: 'pick-category', text: '구분도 고르면 내 패턴을 알 수 있어요.' },
    { id: 'typeahead', text: '적으면 예전에 적은 이름이 떠올라요.' },
    { id: 'health-view', text: '체중·혈당 흐름은 밀당>건강에서 봐요.' },
    { id: 'multi-menu', text: '밥 + 국처럼 한 줄에 이어 적어도 돼요.' },
    { id: 'mealdang-memo', text: '줄임말은 마이>밀당 메모에 적어두세요.' },
    { id: 'context-line', text: '아래 줄에서 어떻게·어디서를 고쳐요.' },
    { id: 'share-moment', text: '사진을 넣으면 모먼트에 공유돼요.' },
    { id: 'skip', text: '거른 끼니도 건너뜀으로 남겨보세요.', scope: 'meal' },
];

const CURSOR_KEY = 'mealog_entry_what_hint_cursor';

/** 힌트가 하나도 못 뽑히는 일이 없도록 — 이 줄이 비면 placeholder 가 한 줄로 쪼그라든다 */
const FALLBACK_TEXT = ENTRY_WHAT_HINTS[0].text;

let cursor = null;

function loadCursor() {
    if (cursor !== null) return cursor;
    let saved = 0;
    try {
        const raw = window.localStorage?.getItem(CURSOR_KEY);
        const n = Number.parseInt(raw ?? '', 10);
        if (Number.isFinite(n) && n >= 0) saved = n;
    } catch (_) { /* 시크릿 모드·저장소 차단 — 세션 안에서만 돌린다 */ }
    cursor = saved % ENTRY_WHAT_HINTS.length;
    return cursor;
}

function saveCursor(next) {
    cursor = next;
    try {
        window.localStorage?.setItem(CURSOR_KEY, String(next));
    } catch (_) { /* best-effort */ }
}

/** @param {EntryWhatHint} hint @param {'meal'|'snack'} mode */
function matchesMode(hint, mode) {
    const scope = hint.scope || 'all';
    return scope === 'all' || scope === mode;
}

/**
 * 시트를 열 때 한 번 — 다음 힌트로 넘긴다.
 * 텍스트를 여기서 정하지 않는 이유: 이 시점엔 끼니/간식 모드가 아직 확정 전이라
 * scope 판정을 할 수 없다. 커서만 옮기고 고르기는 getEntryWhatHintText 가 한다.
 */
export function advanceEntryWhatHint() {
    saveCursor((loadCursor() + 1) % ENTRY_WHAT_HINTS.length);
}

/**
 * 지금 커서가 가리키는 힌트. 커서가 고정이라 모드를 오가도 문구는 그대로다.
 * @param {'meal'|'snack'} mode
 */
export function getEntryWhatHintText(mode) {
    const start = loadCursor();
    const m = mode === 'snack' ? 'snack' : 'meal';
    for (let i = 0; i < ENTRY_WHAT_HINTS.length; i += 1) {
        const hint = ENTRY_WHAT_HINTS[(start + i) % ENTRY_WHAT_HINTS.length];
        if (matchesMode(hint, m)) return hint.text;
    }
    return FALLBACK_TEXT;
}

/**
 * '무엇을' placeholder 전문 (첫 줄 고정 + 둘째 줄 힌트)
 * @param {'meal'|'snack'} mode
 * @param {string} head
 */
export function buildEntryWhatPlaceholder(mode, head) {
    return `${head}\n${getEntryWhatHintText(mode)}`;
}
