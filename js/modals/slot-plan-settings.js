/**
 * 기록 항목 설정 시트 (docs/user-slot-plan.md §4.2)
 * — 화면 이름은 '기록 항목', 코드·문서의 내부 용어는 그대로 '슬롯'이다.
 *
 * 편집은 draft(작업 사본)에서만 일어나고, 저장 버튼에서 한 번에:
 *   1. 이름 소급(renameSlotEverywhere) — key 유지 편집, 과거 기록도 바뀐다
 *   2. 구성 개정판(withRevisionOn) — 추가·삭제·토글·순서, **오늘부터**
 * 변화가 없으면(참조 동일) 아무것도 저장하지 않는다 (§5.6 성장 억제).
 *
 * 적용 시작일은 **묻지 않는다.** 기록 항목 설정은 "이 날짜의 화면을 이렇게
 * 그려라"가 아니라 "앞으로 이렇게 기록하겠다"는 선언이다 (§4.2.3). 저장은 늘
 * 오늘 개정판이고, 피커·헤더가 보는 목록도 늘 지금 것이다.
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
    renameSlotEverywhere,
    revisionCount,
    countEnabledSlots,
    isMemoItem,
    MAX_ENABLED_SLOTS,
    MAX_SLOTS_PER_REVISION,
    SLOT_LABEL_MAX_CHARS,
    MEMO_LABEL_MAX_CHARS,
    REVISION_COUNT_DIAG_THRESHOLD
} from '../utils/slot-plan.js';
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { bindListDragReorder } from '../utils/list-drag-reorder.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { diag } from '../utils/diagnostics.js';

let bound = false;
/** @type {Array<{key:string|null, base:string, label:string, enabled:boolean}>|null} */
let draft = null;
/** 열 때의 원본 라벨 (key → label) — 이름 소급 판정용 */
let openedLabels = new Map();
let reopenPickerOnClose = false;
/** 피커로 돌아갈 때 되돌려 줄 날짜 — 없으면 피커가 pageDate 로 연다 */
let pickerReturnDateIso = '';

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 안내문은 한 줄이다 — 날짜를 묻지 않으니 "며칠부터 며칠까지"가 없다 (§4.2.3).
 * 이미 남긴 기록이 안전하다는 것만 말한다. 그게 여기서 유일하게 불안한 대목이다.
 */
const NOTICE_TEXT = '지금부터 이렇게 기록해요. 이미 남긴 기록은 그대로 있어요.';

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
        <span class="slot-plan-row__drag" data-action="drag" role="button" tabindex="0" aria-label="순서 이동" title="끌어서 순서 변경 (위아래 화살표 키로도 이동)">
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

function render() {
    const list = document.getElementById('slotPlanSettingsList');
    const countEl = document.getElementById('slotPlanSettingsCount');
    const notice = document.getElementById('slotPlanSettingsNotice');
    if (!list || !draft) return;

    const originals = originalSlotSet(draft);
    /**
     * **식사 항목만 그린다.** 메모는 메모 설정 팝업이 다룬다
     * (user-memo-items §4.3) — 개념이 다른 둘이 한 화면을 나눠 쓰면
     * 어느 쪽을 고치는 화면인지 매번 읽어야 한다.
     *
     * ⚠ 그러나 **draft 에는 메모가 그대로 들어 있다.** 저장은 draft 를
     * 통째로 개정판에 쓰므로, 안 그린다고 빼버리면 이 시트를 저장할 때마다
     * 메모가 사라진다. `sanitizeSlots` 가 메모를 항상 뒤로 몰아 주므로
     * (§2.1) 앞쪽만 그려도 data-idx 가 draft 인덱스와 그대로 맞는다.
     */
    const cut = draft.findIndex(isMemoItem);
    const slotCount = cut < 0 ? draft.length : cut;
    list.innerHTML = draft.slice(0, slotCount).map((s, i) => rowHtml(s, i, originals.has(s))).join('');
    if (countEl) countEl.textContent = `사용 중 ${countEnabledSlots(draft)} / ${MAX_ENABLED_SLOTS}`;
    if (notice) notice.textContent = NOTICE_TEXT;
    scheduleLucideIcons(list);
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

/** 지금 쓰는 구성을 draft 로 적재한다 — 편집 대상은 늘 현재 목록이다 (§4.2.3) */
function loadDraft() {
    const today = localTodayIso();
    draft = effectiveSlots(window.userSettings, today, today).map((s) => ({ ...s }));
    openedLabels = new Map(draft.map((s) => [s.key, s.label]));
}

export function openSlotPlanSettings(opts = {}) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    reopenPickerOnClose = opts.fromPicker === true;
    // 날짜는 피커로 돌아갈 때만 쓴다 — 편집 대상 구성을 고르는 값이 아니다
    pickerReturnDateIso = typeof opts.dateIso === 'string' ? opts.dateIso : '';

    setHelpOpen(false);
    loadDraft();
    render();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('slotPlanSettings');
}

export function closeSlotPlanSettings() {
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    setHelpOpen(false); // 시트가 닫히면 그 위의 도움말·메모 편집도 같이 걷는다
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

/**
 * 순서 바꾸기 — 공용 헬퍼에 얹는다 (js/utils/list-drag-reorder.js).
 *
 * 목록에 그려지는 것은 draft 의 **슬롯 구간뿐**이다(메모는 안 그린다). 그래서
 * DOM 인덱스가 곧 draft 인덱스이고, 헬퍼가 목록 밖으로 못 나가게 막아 주는 것이
 * 곧 "메모 구간으로 넘어가지 않는다"(§2.1)가 된다.
 */
function bindDrag(list) {
    bindListDragReorder({
        list,
        rowSelector: '.slot-plan-row',
        handleSelector: '[data-action="drag"]',
        draggingClass: 'slot-plan-row--dragging',
        isEnabled: () => !!draft,
        // 고치던 이름을 먼저 draft 에 넣는다 — 옮기고 나면 그 입력칸은 없다
        onStart: () => syncDraftLabelsFromInputs(),
        onMove: (from, to) => {
            if (!draft || !draft[from]) return;
            const [moved] = draft.splice(from, 1);
            draft.splice(to, 0, moved);
            render();
        }
    });
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

    // 2. 구성 개정판 — 늘 오늘부터 (§4.2.3). 변화 없으면 참조 그대로
    const today = localTodayIso();
    const nextPlan = withRevisionOn(plan, today, draft, Date.now(), Math.random, today);

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

