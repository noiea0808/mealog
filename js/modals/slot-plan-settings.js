/**
 * 슬롯 설정 시트 (docs/user-slot-plan.md §4.2)
 *
 * 편집은 draft(작업 사본)에서만 일어나고, 저장 버튼에서 한 번에:
 *   1. 이름 소급(renameSlotEverywhere) — key 유지 편집, 과거 기록도 바뀐다
 *   2. 구성 개정판(withTodayRevision) — 추가·삭제·토글·순서, 오늘부터
 * 변화가 없으면(참조 동일) 아무것도 저장하지 않는다 (§5.6 성장 억제).
 *
 * 저장은 dbOps.saveSettings 전체 경로를 그대로 탄다 — 아웃박스 내구화·병합
 * 규칙(§5.2)이 이미 거기 있다. slotPlan 만의 새 기계장치를 만들지 않는다.
 */
import { SLOT_STYLES, getSlotLucideIcon } from '../constants.js';
import {
    effectiveSlots,
    materializeSlotKeys,
    originalSlotSet,
    generateSlotKey,
    withTodayRevision,
    renameSlotEverywhere,
    revisionCount,
    countEnabledSlots,
    MAX_ENABLED_SLOTS,
    MAX_SLOTS_PER_REVISION,
    SLOT_LABEL_MAX_CHARS,
    REVISION_COUNT_DIAG_THRESHOLD
} from '../utils/slot-plan.js';
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { diag } from '../utils/diagnostics.js';

let bound = false;
/** @type {Array<{key:string|null, base:string, label:string, enabled:boolean}>|null} */
let draft = null;
/** 열 때의 원본 라벨 (key → label) — 이름 소급 판정용 */
let openedLabels = new Map();
let reopenPickerOnClose = false;

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

/* ── 렌더 ─────────────────────────────────────────────────── */

function rowHtml(slot, idx, isOriginal) {
    const style = SLOT_STYLES[slot.base] || SLOT_STYLES.default;
    const off = !slot.enabled;
    /**
     * 원본은 지울 수 없다(복제할 씨앗이자 폴백 귀속처) → 사용/해제.
     * 복제로 늘린 슬롯은 되돌릴 수단이 삭제뿐이다 → 삭제.
     * 한 자리에 하나만 둔다 — 둘을 나란히 뒀다가 구분이 안 된다는 지적을 받았다.
     */
    const tailBtn = isOriginal
        ? `<button type="button" class="slot-plan-row__toggle" data-action="toggle" aria-pressed="${slot.enabled ? 'true' : 'false'}" aria-label="${slot.enabled ? '사용 중' : '사용 안 함'}">${slot.enabled ? '사용' : '해제'}</button>`
        : `<button type="button" class="slot-plan-row__del" data-action="del" aria-label="이 슬롯 삭제">삭제</button>`;
    return `<div class="slot-plan-row${off ? ' slot-plan-row--off' : ''}" data-idx="${idx}">
        <span class="slot-plan-row__drag" data-action="drag" role="button" aria-label="순서 이동" title="끌어서 순서 변경">
            <i data-lucide="grip-vertical" aria-hidden="true"></i>
        </span>
        <span class="slot-plan-row__icon ${style.iconBg} ${style.iconText}" aria-hidden="true">
            <i data-lucide="${getSlotLucideIcon(slot.base)}" aria-hidden="true"></i>
        </span>
        <span class="slot-plan-row__main">
            <input type="text" class="slot-plan-row__label-input" data-action="label" value="${escapeHtml(slot.label)}" maxlength="${SLOT_LABEL_MAX_CHARS}" size="${Math.max(4, slot.label.length + 2)}" aria-label="슬롯 이름" />
            <button type="button" class="slot-plan-row__pencil" data-action="edit" aria-label="이름 편집">
                <i data-lucide="pencil" aria-hidden="true"></i>
            </button>
        </span>
        ${tailBtn}
        <button type="button" class="slot-plan-row__dup" data-action="dup" aria-label="이 슬롯 복제">
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
    list.innerHTML = draft.map((s, i) => rowHtml(s, i, originals.has(s))).join('');
    // 세는 건 '사용 중'인 수 — 해제한 슬롯은 피커에 안 나오므로 상한과 무관하다
    if (countEl) countEl.textContent = `사용 중 ${countEnabledSlots(draft)} / ${MAX_ENABLED_SLOTS}`;
    if (notice) {
        notice.textContent = `사용 여부·순서 변경은 ${formatNoticeDate(localTodayIso())} 기록부터 적용됩니다. 지난 기록은 그대로 남습니다.`;
    }
    scheduleLucideIcons(list);
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

export function openSlotPlanSettings(opts = {}) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    reopenPickerOnClose = opts.fromPicker === true;

    /**
     * 오늘의 유효 구성이 편집 대상 — enabled:false 도 제자리에 회색으로 (§4.2).
     *
     * key 를 **여기서** 구체화한다. 저장 때 하면 그 사이 만든 복제본의 key 가
     * 원본보다 오래돼 원본/확장 판정이 뒤집힌다. 구체화만으로는 개정판이 생기지
     * 않는다 — withTodayRevision 의 비교가 null key 를 무시한다.
     */
    draft = materializeSlotKeys(
        effectiveSlots(window.userSettings, localTodayIso(), localTodayIso()).map((s) => ({ ...s }))
    );
    openedLabels = new Map(
        (window.userSettings?.slotPlan ? draft : []).map((s) => [s.key, s.label])
    );

    render();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('slotPlanSettings');
}

export function closeSlotPlanSettings() {
    const modal = document.getElementById('slotPlanSettingsModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    draft = null;
    unlockBodyScroll('slotPlanSettings');
    if (reopenPickerOnClose && typeof window.openEntrySlotPicker === 'function') {
        reopenPickerOnClose = false;
        window.openEntrySlotPicker();
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
            const v = String(input.value || '').trim().slice(0, SLOT_LABEL_MAX_CHARS);
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
        return `사용 중인 슬롯은 ${MAX_ENABLED_SLOTS}개까지예요. 안 쓰는 슬롯을 해제해 주세요.`;
    }
    if (draft.length >= MAX_SLOTS_PER_REVISION) {
        return '슬롯 목록이 가득 찼어요. 해제해 둔 슬롯의 이름을 고쳐서 쓰세요.';
    }
    return '';
}

/**
 * 복제 — 슬롯을 늘리는 **유일한** 길이다(§4.2).
 * base 를 상속하므로 집계 축 질문을 사용자에게 하지 않아도 되고, 원본 7개가
 * 항상 남아 있으므로(삭제 불가) 어떤 시간대든 복제로 도달할 수 있다.
 * key 는 지금 붙인다 — 원본보다 반드시 나중이어야 한다.
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
        const to = Math.max(0, Math.min(draft.length - 1, dragIdx + delta));
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
        showToast('슬롯을 하나 이상 사용해 주세요.', 'error');
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

    // 2. 구성 개정판 — 오늘부터 (§2.1). 변화 없으면 참조 그대로
    const nextPlan = withTodayRevision(plan, localTodayIso(), draft);

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
        showToast('슬롯 설정을 저장했습니다.', 'success');
    } catch (e) {
        // 아웃박스가 내구화를 맡는다 — 여기 실패는 즉시 전송 실패일 뿐
        console.warn('슬롯 설정 저장(즉시 전송) 실패 — 아웃박스 재시도 예정:', e?.message || e);
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
