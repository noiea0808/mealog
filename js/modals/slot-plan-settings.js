/**
 * 기록 항목 설정 시트 (docs/user-slot-plan.md §4.2)
 * — 화면 이름은 '기록 항목', 코드·문서의 내부 용어는 그대로 '슬롯'이다.
 *
 * 편집은 draft(작업 사본)에서만 일어나고, 저장 버튼에서 한 번에:
 *   1. 이름 소급(renameSlotEverywhere) — key 유지 편집, 과거 기록도 바뀐다
 *   2. 구성 개정판(withRevisionOn) — 추가·삭제·토글·순서, **고른 날짜부터**
 * 변화가 없으면(참조 동일) 아무것도 저장하지 않는다 (§5.6 성장 억제).
 *
 * 저장은 dbOps.saveSettings 전체 경로를 그대로 탄다 — 아웃박스 내구화·병합
 * 규칙(§5.2)이 이미 거기 있다. slotPlan 만의 새 기계장치를 만들지 않는다.
 */
import { SLOT_STYLES, getSlotLucideIcon } from '../constants.js';
import {
    effectiveSlots,
    originalSlotSet,
    generateSlotKey,
    withRevisionOn,
    nextDifferentRevisionAfter,
    addDaysIso,
    renameSlotEverywhere,
    revisionCount,
    countEnabledSlots,
    countMemos,
    isMemoItem,
    memoIconOrDefault,
    MAX_ENABLED_SLOTS,
    MAX_ENABLED_MEMOS,
    MAX_SLOTS_PER_REVISION,
    SLOT_LABEL_MAX_CHARS,
    MEMO_LABEL_MAX_CHARS,
    REVISION_COUNT_DIAG_THRESHOLD
} from '../utils/slot-plan.js';
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { diag } from '../utils/diagnostics.js';
import { openMemoItemEdit, closeMemoItemEdit } from './memo-item-edit.js';

let bound = false;
/** @type {Array<{key:string|null, base:string, label:string, enabled:boolean}>|null} */
let draft = null;
/** 열 때의 원본 라벨 (key → label) — 이름 소급 판정용 */
let openedLabels = new Map();
let reopenPickerOnClose = false;
/** 피커로 돌아갈 때 되돌려 줄 날짜 — 없으면 피커가 pageDate 로 연다 */
let pickerReturnDateIso = '';
/** 이 구성이 적용될 시작일 (YYYY-MM-DD) — 사용자가 고른다 (§4.2.3) */
let effectiveFromIso = '';
/** 날짜를 바꿀 때 "편집분이 날아갔다"를 알리기 위한 기준 스냅샷 */
let baselineJson = '';

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatNoticeDate(iso) {
    const [, mo, d] = String(iso).split('-').map(Number);
    return mo && d ? `${mo}월 ${d}일` : iso;
}

/**
 * 이 구성이 **며칠까지** 적용되는지 알려준다.
 * 뒤에 다른 개정판이 있으면 거기서 끊긴다 — 27일에 저장하고 29일에 또 저장하면
 * 27일 구성은 28일까지다(§4.2.3).
 */
function noticeText() {
    const from = formatNoticeDate(effectiveFromIso);
    const next = nextDifferentRevisionAfter(
        window.userSettings?.slotPlan || null,
        effectiveFromIso,
        localTodayIso(),
        draft || []
    );
    if (next) {
        return `${from}부터 ${formatNoticeDate(addDaysIso(next, -1))}까지의 기록에 적용됩니다. ${formatNoticeDate(next)}부터는 그날 저장한 구성이 따로 있어요.`;
    }
    return `${from} 기록부터 적용됩니다. 그 이전 기록은 그대로 남습니다.`;
}

/**
 * "뒤 개정판도 이걸로 통일" 체크박스 — 뒤에 개정판이 **있을 때만** 뜬다 (§4.2.4).
 *
 * 28일을 편집한 뒤 26일을 편집하면 26일 편집이 26~27일짜리 섬이 된다. 대개는
 * "사실 26일부터였어"라는 뜻이므로 통일하고 싶겠지만, 28일을 일부러 다르게
 * 둔 경우도 있다. 추측하지 않고 묻는다. 기본은 꺼짐 — 켜면 되돌릴 수 없다.
 */
function syncCascadeRow() {
    const row = document.getElementById('slotPlanCascadeRow');
    const label = document.getElementById('slotPlanCascadeLabel');
    if (!row) return;
    // 내용이 이미 같은 뒤 개정판은 통일할 게 없다 — 세지 않는다 (§4.2.5)
    const next = nextDifferentRevisionAfter(
        window.userSettings?.slotPlan || null,
        effectiveFromIso,
        localTodayIso(),
        draft || []
    );
    row.classList.toggle('hidden', !next);
    if (next && label) {
        label.textContent = `${formatNoticeDate(next)} 이후 구성도 이걸로 통일하기 — 그날 저장해 둔 구성은 덮어써집니다.`;
    }
    if (!next) setCascadeChecked(false);
}

/**
 * 도움말 팝업 — 우상단 물음표. 설정 시트 위에 겹친다.
 *
 * 시트 안에 접었다 펴는 안내로 두었더니 짧은 화면에서 목록을 밀어내, 정작
 * 설명대로 해 볼 대상이 안 보였다. 겹쳐 띄우고 읽고 닫으면 바로 그 자리다.
 * 몸통 스크롤 잠금은 시트가 이미 잡고 있으므로 여기서 또 잡지 않는다.
 * ESC 는 escape-close-modals 의 z-index 규칙이 알아서 이쪽을 먼저 닫는다.
 */
function setHelpOpen(open) {
    const modal = document.getElementById('slotPlanHelpModal');
    const btn = document.getElementById('slotPlanSettingsHelpBtn');
    if (modal) {
        const active = document.activeElement;
        if (!open && active instanceof HTMLElement && modal.contains(active)) active.blur();
        modal.classList.toggle('hidden', !open);
        modal.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) modal.querySelector('#slotPlanHelpCloseBtn')?.focus();
    }
    if (btn) btn.classList.toggle('entry-slot-picker__settings-btn--on', open);
}

/** ESC·바깥 클릭에서 부르는 닫기 (escape-close-modals 등록용) */
export function closeSlotPlanHelp() {
    setHelpOpen(false);
}

function setCascadeChecked(v) {
    const cb = document.getElementById('slotPlanCascade');
    if (cb) cb.checked = !!v;
}

function isCascadeChecked() {
    return !!document.getElementById('slotPlanCascade')?.checked;
}

/* ── 렌더 ─────────────────────────────────────────────────── */

function rowHtml(slot, idx, isOriginal) {
    const style = SLOT_STYLES[slot.base] || SLOT_STYLES.default;
    const off = !slot.enabled;
    /**
     * 원본은 지울 수 없다(복제할 씨앗이자 폴백 귀속처) → 사용 중/사용 안 함.
     * 복제로 늘린 슬롯은 되돌릴 수단이 삭제뿐이다 → 삭제.
     * 한 자리에 하나만 둔다 — 둘을 나란히 뒀다가 구분이 안 된다는 지적을 받았다.
     *
     * 라벨은 **현재 상태**를 적는다. '사용'이라고만 쓰니 지금 켜졌다는 뜻인지
     * 누르면 켜진다는 뜻인지 모르겠다는 지적을 받았다 — 상태로 읽히는 쪽이
     * 목록에서 훑기 좋다(꺼진 행은 회색이라는 신호와도 어긋나지 않는다).
     */
    const tailBtn = isOriginal
        ? `<button type="button" class="slot-plan-row__toggle" data-action="toggle" aria-pressed="${slot.enabled ? 'true' : 'false'}" aria-label="이 항목 사용">${slot.enabled ? '사용 중' : '사용 안 함'}</button>`
        : `<button type="button" class="slot-plan-row__del" data-action="del" aria-label="이 항목 삭제">삭제</button>`;
    return `<div class="slot-plan-row${off ? ' slot-plan-row--off' : ''}" data-idx="${idx}">
        <span class="slot-plan-row__drag" data-action="drag" role="button" aria-label="순서 이동" title="끌어서 순서 변경">
            <i data-lucide="grip-vertical" aria-hidden="true"></i>
        </span>
        <span class="slot-plan-row__icon ${style.iconBg} ${style.iconText}" aria-hidden="true">
            <i data-lucide="${getSlotLucideIcon(slot.base)}" aria-hidden="true"></i>
        </span>
        <span class="slot-plan-row__main">
            <input type="text" class="slot-plan-row__label-input" data-action="label" value="${escapeHtml(slot.label)}" maxlength="${SLOT_LABEL_MAX_CHARS}" size="${Math.max(4, slot.label.length + 2)}" aria-label="항목 이름" />
            <button type="button" class="slot-plan-row__pencil" data-action="edit" aria-label="이름 편집">
                <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
        </span>
        ${tailBtn}
        <button type="button" class="slot-plan-row__dup" data-action="dup" aria-label="이 항목 복제">
            <i data-lucide="copy-plus" aria-hidden="true"></i>
        </button>
    </div>`;
}

/**
 * 메모 행 — 손잡이가 없다. 순서를 고를 수 있게 하면 "체중을 아침과
 * 점심 사이에 둘까"라는, 사용자가 답할 수 없는 질문이 돌아온다
 * (user-memo-items §1). 자리는 기록의 시각이 정한다.
 */
function memoRowHtml(item, idx) {
    return `<div class="slot-plan-row slot-plan-row--memo" data-idx="${idx}">
        <button type="button" class="slot-plan-row__icon slot-plan-row__icon--memo" data-action="icon" aria-label="아이콘 고르기">
            <i data-lucide="${escapeHtml(memoIconOrDefault(item.icon))}" aria-hidden="true"></i>
        </button>
        <span class="slot-plan-row__main">
            <input type="text" class="slot-plan-row__label-input" data-action="label" value="${escapeHtml(item.label)}" maxlength="${MEMO_LABEL_MAX_CHARS}" size="${Math.max(4, item.label.length + 2)}" aria-label="항목 이름" />
            <button type="button" class="slot-plan-row__pencil" data-action="edit" aria-label="이름 편집">
                <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
        </span>
        <button type="button" class="slot-plan-row__del" data-action="del" aria-label="이 메모 항목 삭제">삭제</button>
        <span class="slot-plan-row__dup-spacer" aria-hidden="true"></span>
    </div>`;
}

function sectionHeadHtml(title, countText) {
    return `<div class="slot-plan-settings__section">
        <span>${escapeHtml(title)}</span>
        <span class="slot-plan-settings__section-count">${escapeHtml(countText)}</span>
    </div>`;
}

function render() {
    const list = document.getElementById('slotPlanSettingsList');
    const countEl = document.getElementById('slotPlanSettingsCount');
    const notice = document.getElementById('slotPlanSettingsNotice');
    if (!list || !draft) return;

    const originals = originalSlotSet(draft);
    /**
     * draft 는 sanitizeSlots 가 슬롯 앞·메모 뒤로 넣어 준 순서 그대로다
     * (user-memo-items §2.1). 그래서 구역을 나누는 데 정렬이 필요 없고,
     * data-idx 는 둘 다 draft 의 인덱스라 편집 코드가 한 종류만 안다.
     */
    const cut = draft.findIndex(isMemoItem);
    const firstMemo = cut < 0 ? draft.length : cut;
    const slotRows = draft.slice(0, firstMemo).map((s, i) => rowHtml(s, i, originals.has(s))).join('');
    const memoRows = draft.slice(firstMemo).map((s, i) => memoRowHtml(s, firstMemo + i)).join('');
    list.innerHTML =
        sectionHeadHtml('식사 항목', `사용 중 ${countEnabledSlots(draft)} / ${MAX_ENABLED_SLOTS}`) +
        slotRows +
        sectionHeadHtml('메모 항목', `${countMemos(draft)} / ${MAX_ENABLED_MEMOS}`) +
        (memoRows ||
            // 만들기는 피커 머리에 있다 — 빈 구역이 그 자리를 알려 준다
            '<p class="slot-plan-settings__memo-empty">체중·혈당·운동처럼 밥이 아닌 것도 남길 수 있어요. 기록 추가 화면 오른쪽 위 <b>메모 아이콘</b>으로 만듭니다.</p>');
    // 구역마다 제 수를 달고 있으므로 머리의 수는 비운다 — 둘이 같은 말을 했다
    if (countEl) countEl.textContent = '';
    if (notice) notice.textContent = noticeText();
    syncCascadeRow();
    scheduleLucideIcons(list);
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

/**
 * `effectiveFromIso` 날짜에 유효하던 구성을 draft 로 적재한다.
 * 기본 슬롯의 key 가 결정적이라(§2.4) 날짜가 달라도 같은 슬롯은 같은 key 다 —
 * 여기서 따로 손볼 게 없다.
 */
function loadDraftForDate(dateIso) {
    draft = effectiveSlots(window.userSettings, dateIso, localTodayIso()).map((s) => ({ ...s }));
    openedLabels = new Map(draft.map((s) => [s.key, s.label]));
    baselineJson = JSON.stringify(draft);
}

/** 편집분이 남아 있는지 — 날짜를 바꿀 때 소리 없이 버리지 않으려고 */
function draftHasEdits() {
    return !!draft && JSON.stringify(draft) !== baselineJson;
}

export function openSlotPlanSettings(opts = {}) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    reopenPickerOnClose = opts.fromPicker === true;
    pickerReturnDateIso = typeof opts.dateIso === 'string' ? opts.dateIso : '';

    /**
     * 기본 시작일 = 피커가 보고 있던 날짜(없으면 오늘). 미래는 받지 않는다(§5.5).
     * 편집 대상은 그 날짜에 유효하던 구성 — enabled:false 도 제자리에 회색으로.
     */
    const today = localTodayIso();
    const asked = typeof opts.dateIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.dateIso)
        ? opts.dateIso
        : today;
    effectiveFromIso = asked > today ? today : asked;

    setCascadeChecked(false);
    setHelpOpen(false);
    closeMemoItemEdit();
    loadDraftForDate(effectiveFromIso);
    syncDateInput();
    render();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('slotPlanSettings');
}

function syncDateInput() {
    const input = document.getElementById('slotPlanEffectiveFrom');
    if (!input) return;
    input.max = localTodayIso();
    input.value = effectiveFromIso;
}

function onEffectiveFromChange() {
    const input = document.getElementById('slotPlanEffectiveFrom');
    const today = localTodayIso();
    let v = String(input?.value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        syncDateInput();
        return;
    }
    if (v > today) {
        v = today;
        showToast('앞으로의 날짜는 고를 수 없어요.', 'error');
    }
    if (v === effectiveFromIso) return;
    const hadEdits = draftHasEdits();
    effectiveFromIso = v;
    setCascadeChecked(false);
    loadDraftForDate(v);
    syncDateInput();
    render();
    if (hadEdits) showToast('날짜를 바꿔서 편집하던 내용은 되돌렸어요.', 'error');
}

export function closeSlotPlanSettings() {
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    setHelpOpen(false); // 시트가 닫히면 그 위의 도움말·메모 편집도 같이 걷는다
    closeMemoItemEdit();
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    draft = null;
    unlockBodyScroll('slotPlanSettings');
    if (reopenPickerOnClose && typeof window.openEntrySlotPicker === 'function') {
        reopenPickerOnClose = false;
        window.openEntrySlotPicker(pickerReturnDateIso || undefined);
    }
}

/* ── 메모 항목 고치기 ── */

/**
 * 메모 행의 아이콘을 누를 때 — 이름·아이콘 팝업을 draft 모드로 열고
 * 결과를 draft 에만 반영한다. 저장은 이 시트의 저장 버튼이 한 번에 한다.
 *
 * **만들기는 여기 없다.** 기록 추가 시트(피커) 머리로 옮겼다 — 항목을
 * 만드는 일과 기록하는 일이 같은 자리에 있어야 발견된다 (user-memo-items §4.3).
 */
function onEditMemoItem(idx) {
    if (!draft || !isMemoItem(draft[idx])) return;
    syncDraftLabelsFromInputs();
    openMemoItemEdit({
        item: draft[idx],
        onCommit: ({ label, icon }) => {
            if (!draft || !isMemoItem(draft[idx])) return;
            draft[idx] = { ...draft[idx], label, icon };
            render();
        }
    });
}


/* ── 편집 동작 ────────────────────────────────────────────── */

function syncDraftLabelsFromInputs() {
    const list = document.getElementById('slotPlanSettingsList');
    if (!list || !draft) return;
    list.querySelectorAll('.slot-plan-row').forEach((row) => {
        const idx = Number(row.getAttribute('data-idx'));
        const input = row.querySelector('[data-action="label"]');
        if (draft[idx] && input) {
            const max = isMemoItem(draft[idx]) ? MEMO_LABEL_MAX_CHARS : SLOT_LABEL_MAX_CHARS;
            const v = String(input.value || '').trim().slice(0, max);
            if (v) draft[idx].label = v;
        }
    });
}

function onToggle(idx) {
    if (!draft?.[idx]) return;
    syncDraftLabelsFromInputs();
    draft[idx].enabled = !draft[idx].enabled;
    render();
}

/**
 * 새 슬롯을 넣을 수 있는지 — 두 상한을 함께 본다.
 * 슬롯 삭제가 없으므로(해제만) 해제분이 피커 상한을 먹지 않게 나눠 센다.
 */
function addBlockedReason() {
    if (!draft) return '';
    if (countEnabledSlots(draft) >= MAX_ENABLED_SLOTS) {
        return `사용 중인 항목은 ${MAX_ENABLED_SLOTS}개까지예요. 안 쓰는 항목을 '사용 안 함'으로 바꿔 주세요.`;
    }
    if (draft.length >= MAX_SLOTS_PER_REVISION) {
        return '항목 목록이 가득 찼어요. 사용 안 함으로 둔 항목의 이름을 고쳐서 쓰세요.';
    }
    return '';
}

/**
 * 복제 — 슬롯을 늘리는 **유일한** 길이다(§4.2).
 * base 를 상속하므로 집계 축 질문을 사용자에게 하지 않아도 되고, 원본 7개가
 * 항상 남아 있으므로(삭제 불가) 어떤 시간대든 복제로 도달할 수 있다.
 * key 는 지금 붙인다 — 원본(결정적 key)보다 반드시 나중이 된다.
 */
function onDuplicate(idx) {
    if (!draft?.[idx]) return;
    syncDraftLabelsFromInputs();
    const blocked = addBlockedReason();
    if (blocked) {
        showToast(blocked, 'error');
        return;
    }
    const src = draft[idx];
    draft.splice(idx + 1, 0, {
        key: generateSlotKey(),
        base: src.base,
        label: `${src.label}2`.slice(0, SLOT_LABEL_MAX_CHARS),
        enabled: true
    });
    render();
    const rows = document.querySelectorAll('#slotPlanSettingsList .slot-plan-row');
    rows[idx + 1]?.querySelector('[data-action="label"]')?.select?.();
}

/**
 * 삭제 — 복제로 늘린 슬롯만. 원본은 이 버튼 자리에 사용/해제가 온다.
 * 지워도 그 슬롯으로 남긴 과거 기록의 이름은 유지된다(§3, key 를 전 개정판에서
 * 찾으므로). 그래서 확인 창을 띄우지 않는다 — 되돌릴 수 없는 일이 아니다.
 */
function onDelete(idx) {
    if (!draft?.[idx]) return;
    syncDraftLabelsFromInputs();
    draft.splice(idx, 1);
    render();
}

/* ── 드래그 순서 (pointer 기반 — 터치 포함) ────────────────── */

function bindDrag(list) {
    let dragIdx = -1;
    let startY = 0;
    let rowH = 0;

    list.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-action="drag"]');
        if (!handle) return;
        const row = handle.closest('.slot-plan-row');
        if (!row || !draft) return;
        syncDraftLabelsFromInputs();
        dragIdx = Number(row.getAttribute('data-idx'));
        startY = e.clientY;
        rowH = row.offsetHeight || 48;
        row.classList.add('slot-plan-row--dragging');
        handle.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    });

    list.addEventListener('pointermove', (e) => {
        if (dragIdx < 0 || !draft) return;
        const delta = Math.round((e.clientY - startY) / rowH);
        if (delta === 0) return;
        /**
         * 슬롯 구간 밖으로 나가지 않는다. 메모가 섮이면 sanitizeSlots 가
         * 저장 때 다시 뒤로 보내버려(§2.1), 끌어다 놓은 결과가 사라진다.
         */
        const lastSlot = draft.findIndex(isMemoItem);
        const upper = (lastSlot < 0 ? draft.length : lastSlot) - 1;
        const to = Math.max(0, Math.min(upper, dragIdx + delta));
        if (to === dragIdx) return;
        const [moved] = draft.splice(dragIdx, 1);
        draft.splice(to, 0, moved);
        dragIdx = to;
        startY = e.clientY;
        render();
        const rows = list.querySelectorAll('.slot-plan-row');
        rows[to]?.classList.add('slot-plan-row--dragging');
    });

    const endDrag = () => {
        if (dragIdx < 0) return;
        dragIdx = -1;
        list.querySelectorAll('.slot-plan-row--dragging').forEach((el) =>
            el.classList.remove('slot-plan-row--dragging')
        );
    };
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);
}

/* ── 저장 ─────────────────────────────────────────────────── */

async function onSave() {
    if (!draft) return;
    syncDraftLabelsFromInputs();

    // 전부 해제하면 피커에 고를 게 없어진다 — 되돌릴 수는 있지만 막는 편이 친절하다
    if (countEnabledSlots(draft) === 0) {
        showToast('항목을 하나 이상 사용해 주세요.', 'error');
        return;
    }

    const settings = window.userSettings || {};
    let plan = settings.slotPlan || null;

    // 1. 이름 소급 — key 유지 편집 (§3.1)
    for (const s of draft) {
        if (s.key != null && openedLabels.has(s.key) && openedLabels.get(s.key) !== s.label) {
            plan = renameSlotEverywhere(plan, s.key, s.label);
        }
    }

    // 2. 구성 개정판 — 사용자가 고른 날짜부터 (§4.2.3). 변화 없으면 참조 그대로
    const nextPlan = withRevisionOn(plan, effectiveFromIso, draft, Date.now(), Math.random, localTodayIso(), {
        overwriteLater: isCascadeChecked()
    });

    if (nextPlan === (settings.slotPlan || null)) {
        closeSlotPlanSettings();
        return;
    }

    const prevPlan = settings.slotPlan;
    settings.slotPlan = nextPlan;
    window.userSettings = settings;

    const n = revisionCount(nextPlan);
    if (n > REVISION_COUNT_DIAG_THRESHOLD) {
        diag('slotPlan.revisionCountHigh', { count: n });
    }

    closeSlotPlanSettings();
    try {
        await dbOps.saveSettings(settings);
        showToast('기록 항목 설정을 저장했습니다.', 'success');
    } catch (e) {
        // 아웃박스가 내구화를 맡는다 — 여기 실패는 즉시 전송 실패일 뿐
        console.warn('기록 항목 설정 저장(즉시 전송) 실패 — 아웃박스 재시도 예정:', e?.message || e);
    }
    if (prevPlan !== nextPlan && typeof window.renderTimeline === 'function') {
        // 전체 다시 그리기 — 탭 전환(main/tabs.js)과 같은 패턴, 뷰 모드 무관
        try {
            window.loadedDates = [];
            const c = document.getElementById('timelineContainer');
            if (c) c.innerHTML = '';
            window.renderTimeline();
        } catch (_) { /* 렌더 실패는 다음 갱신에서 복구 */ }
    }
}

/* ── 바인딩 ───────────────────────────────────────────────── */

function bindOnce() {
    if (bound) return;
    bound = true;
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    const list = document.getElementById('slotPlanSettingsList');

    modal.querySelector('#slotPlanSettingsBackdrop')?.addEventListener('click', closeSlotPlanSettings);
    modal.querySelector('#slotPlanCancelBtn')?.addEventListener('click', closeSlotPlanSettings);
    modal.querySelector('#slotPlanEffectiveFrom')?.addEventListener('change', onEffectiveFromChange);
    modal.querySelector('#slotPlanSettingsHelpBtn')?.addEventListener('click', () => setHelpOpen(true));

    const help = document.getElementById('slotPlanHelpModal');
    help?.querySelector('#slotPlanHelpBackdrop')?.addEventListener('click', closeSlotPlanHelp);
    help?.querySelector('#slotPlanHelpCloseBtn')?.addEventListener('click', closeSlotPlanHelp);
    modal.querySelector('#slotPlanSaveBtn')?.addEventListener('click', () => void onSave());

    list?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const row = btn.closest('.slot-plan-row');
        const idx = row ? Number(row.getAttribute('data-idx')) : -1;
        const action = btn.getAttribute('data-action');
        if (action === 'toggle') onToggle(idx);
        else if (action === 'dup') onDuplicate(idx);
        else if (action === 'del') onDelete(idx);
        else if (action === 'icon') onEditMemoItem(idx);
        else if (action === 'edit') {
            const input = row?.querySelector('[data-action="label"]');
            input?.focus();
            input?.select();
        }
    });

    if (list) bindDrag(list);
}

export function initSlotPlanSettings() {
    bindOnce();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSlotPlanSettings, { once: true });
    } else {
        initSlotPlanSettings();
    }
}

window.openSlotPlanSettings = openSlotPlanSettings;
window.closeSlotPlanSettings = closeSlotPlanSettings;
window.closeSlotPlanHelp = closeSlotPlanHelp;

