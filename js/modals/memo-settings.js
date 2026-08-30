/**
 * 메모 설정 팝업 (docs/user-memo-items.md §4.3)
 *
 * **메모 항목의 유일한 관리 자리다** — 목록·만들기·이름/아이콘 고치기·빼기가
 * 전부 여기 있다. 기록 항목 설정 시트는 **식사 항목만** 다룬다.
 *
 * 처음에는 메모를 기록 항목 설정 시트에 함께 뒀다가 두 번 고쳤다.
 *   1) 만들기만 피커로 옮겼더니 "만들기는 여기, 빼기는 저기"가 됐다.
 *   2) 그래서 통째로 옮긴다. 개념이 다른 둘(식사/메모)이 한 화면을 나눠 쓰면
 *      어느 쪽을 고치는 화면인지 매번 읽어야 한다.
 *
 * 덤으로 위험 하나가 사라진다. 두 화면이 같은 날짜 개정판을 각자 쓰면
 * "같은 날짜는 마지막 편집이 이긴다"(user-slot-plan §5.3)로 서로를 덮는다.
 * 이제 메모를 쓰는 화면은 하나다.
 *
 * 저장은 **즉시**다. 이 팝업에는 저장 버튼이 없다 — 적용 시작일은 부른 쪽이
 * 보고 있던 날짜이고, 미래는 오늘로 자른다(user-slot-plan §5.5).
 */
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import {
    effectiveSlots,
    memoItemsOnly,
    generateSlotKey,
    withRevisionOn,
    memoIconOrDefault,
    countMemos,
    isMemoItem,
    MEMO_ICONS,
    MEMO_PRESETS,
    MEMO_LABEL_MAX_CHARS,
    MAX_ENABLED_MEMOS,
    MAX_SLOTS_PER_REVISION
} from '../utils/slot-plan.js';

let bound = false;
/** 열려 있는 동안만 유효 */
let session = null;

function el(id) {
    return document.getElementById(id);
}

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** 지금 유효한 전체 항목(식사+메모) — 개정판을 쓸 때 통째로 넘겨야 한다 */
function currentItems() {
    return effectiveSlots(window.userSettings, session.effectiveFrom, localTodayIso());
}

/* ── 목록 ─────────────────────────────────────────────────── */

function rowHtml(item, idx) {
    return `<div class="memo-settings__row" data-idx="${idx}">
        <button type="button" class="memo-settings__row-main" data-action="edit">
            <span class="memo-settings__icon" aria-hidden="true">
                <i data-lucide="${escapeHtml(memoIconOrDefault(item.icon))}" aria-hidden="true"></i>
            </span>
            <span class="memo-settings__label">${escapeHtml(item.label)}</span>
            <span class="memo-settings__edit-hint" aria-hidden="true">
                <i data-lucide="pencil" aria-hidden="true"></i>
            </span>
        </button>
        <button type="button" class="slot-plan-row__del" data-action="del" aria-label="${escapeHtml(item.label)} 항목 빼기">빼기</button>
    </div>`;
}

function renderList() {
    const wrap = el('memoSettingsList');
    if (!wrap || !session) return;
    const memos = memoItemsOnly(currentItems());
    wrap.innerHTML = memos.length
        ? memos.map(rowHtml).join('')
        : `<p class="memo-settings__empty">아직 메모 항목이 없어요. 체중·혈당·운동처럼 밥이 아닌 것도 남길 수 있습니다.</p>`;
    scheduleLucideIcons(wrap);
}

function showList() {
    if (!session) return;
    session.editIdx = null;
    el('memoSettingsListView')?.classList.remove('hidden');
    el('memoSettingsEditView')?.classList.add('hidden');
    el('memoSettingsFoot')?.classList.add('hidden');
    el('memoSettingsBackBtn')?.classList.add('hidden');
    const title = el('memoSettingsTitle');
    if (title) title.textContent = '메모 설정';
    renderList();
}

/* ── 만들기·고치기 ────────────────────────────────────────── */

function setError(msg) {
    const e = el('slotMemoEditError');
    if (e) e.textContent = msg || '';
}

function renderIconGrid() {
    const grid = el('slotMemoIconGrid');
    if (!grid || !session) return;
    grid.innerHTML = MEMO_ICONS.map(
        (name) =>
            `<button type="button" class="slot-memo-edit__icon${name === session.icon ? ' slot-memo-edit__icon--on' : ''}" role="radio" aria-checked="${name === session.icon ? 'true' : 'false'}" data-icon="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">
                <i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>
            </button>`
    ).join('');
    scheduleLucideIcons(grid);
}

/**
 * 프리셋 칩은 **이름칸 아래**에 둔다 — 폼과 나란한 선택지가 아니라 폼을 채우는
 * 도구이기 때문이다. 고른 칩은 상태가 남는다(기록 시트 '무엇을' 축의 제안 줄과
 * 같은 관용구). 이름을 직접 고치면 상태가 풀린다.
 */
function renderPresets() {
    const row = el('slotMemoPresetRow');
    if (!row || !session) return;
    row.innerHTML = MEMO_PRESETS.map(
        (p) =>
            `<button type="button" class="slot-memo-edit__preset${p.label === session.presetLabel ? ' slot-memo-edit__preset--on' : ''}" data-preset-label="${escapeHtml(p.label)}" data-preset-icon="${escapeHtml(p.icon)}">${escapeHtml(p.label)}</button>`
    ).join('');
}

function addBlockedReason(items) {
    if (countMemos(items) >= MAX_ENABLED_MEMOS) {
        return `메모 항목은 ${MAX_ENABLED_MEMOS}개까지 만들 수 있어요. 안 쓰는 항목을 빼 주세요.`;
    }
    if (items.length >= MAX_SLOTS_PER_REVISION) return '항목 목록이 가득 찼어요.';
    return '';
}

function showEdit(idx) {
    if (!session) return;
    const memos = memoItemsOnly(currentItems());
    const editing = idx != null && !!memos[idx];
    if (!editing) {
        const blocked = addBlockedReason(currentItems());
        if (blocked) {
            showToast(blocked, 'error');
            return;
        }
    }
    session.editIdx = editing ? idx : null;
    session.icon = editing ? memoIconOrDefault(memos[idx].icon) : MEMO_ICONS[0];
    session.presetLabel = '';

    el('memoSettingsListView')?.classList.add('hidden');
    el('memoSettingsEditView')?.classList.remove('hidden');
    el('memoSettingsFoot')?.classList.remove('hidden');
    el('memoSettingsBackBtn')?.classList.remove('hidden');
    const title = el('memoSettingsTitle');
    if (title) title.textContent = editing ? '메모 항목 고치기' : '새 메모 항목';
    const saveBtn = el('slotMemoEditSaveBtn');
    if (saveBtn) saveBtn.textContent = editing ? '적용' : '만들기';
    const nameInput = el('slotMemoNameInput');
    if (nameInput) nameInput.value = editing ? String(memos[idx].label || '') : '';
    // 프리셋은 처음 만들 때만 — 고치는 중에 이름을 덮어쓰면 놀란다
    el('slotMemoPresetRow')?.classList.toggle('hidden', editing);
    setError('');
    renderPresets();
    renderIconGrid();
    nameInput?.focus();
}

/* ── 저장 (즉시) ──────────────────────────────────────────── */

/**
 * 메모 목록을 통째로 갈아 끼운 개정판을 쓴다. 식사 슬롯은 손대지 않는다 —
 * `sanitizeSlots` 가 슬롯 앞·메모 뒤로 정렬해 주므로 이어 붙이기만 하면 된다.
 */
async function commitMemos(nextMemos) {
    if (!session) return;
    const settings = window.userSettings || {};
    const items = currentItems();
    const slots = items.filter((s) => !isMemoItem(s));
    const next = withRevisionOn(
        settings.slotPlan || null,
        session.effectiveFrom,
        [...slots, ...nextMemos],
        Date.now(),
        Math.random,
        localTodayIso()
    );
    if (next === (settings.slotPlan || null)) return;

    settings.slotPlan = next;
    window.userSettings = settings;
    // 저장을 기다리지 않고 먼저 그린다 — 아웃박스가 내구화를 맡는다
    renderList();
    session.onChanged?.();
    try {
        await dbOps.saveSettings(settings);
    } catch (e) {
        console.warn('메모 설정 저장(즉시 전송) 실패 — 아웃박스 재시도 예정:', e?.message || e);
    }
}

function commitEdit() {
    if (!session) return;
    const nameInput = el('slotMemoNameInput');
    const label = String(nameInput?.value || '').trim().slice(0, MEMO_LABEL_MAX_CHARS);
    if (!label) {
        setError('이름을 적어 주세요.');
        nameInput?.focus();
        return;
    }
    const memos = memoItemsOnly(currentItems());
    const idx = session.editIdx;
    let nextMemos;
    if (idx != null && memos[idx]) {
        nextMemos = memos.map((m, i) => (i === idx ? { ...m, label, icon: session.icon } : m));
    } else {
        const blocked = addBlockedReason(currentItems());
        if (blocked) {
            setError(blocked);
            return;
        }
        // 새 key 는 지금 붙인다 — 슬롯과 같은 이름공간, 재사용 없음
        nextMemos = [...memos, { key: generateSlotKey(), kind: 'memo', icon: session.icon, label, enabled: true }];
    }
    showList();
    void commitMemos(nextMemos);
}

/**
 * 빼기 — 확인 창을 띄우지 않는다. 되돌릴 수 없는 일이 아니기 때문이다:
 * 그 항목으로 남긴 **기록은 그대로 있고 이름도 유지된다**(§2.3 `retired`).
 * 다시 만들면 새 key 라 과거 기록이 옛 항목에 묶인 채 남을 뿐이다.
 */
function removeAt(idx) {
    const memos = memoItemsOnly(currentItems());
    if (!memos[idx]) return;
    void commitMemos(memos.filter((_, i) => i !== idx));
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

/**
 * @param {{ dateIso?: string, onChanged?: () => void }} [opts]
 *        dateIso — 적용 시작일(부른 화면이 보고 있던 날짜). 미래는 오늘로 자른다
 */
export function openMemoSettings(opts = {}) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = el('memoSettingsModal');
    if (!modal) return;
    const today = localTodayIso();
    const asked = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.dateIso || '')) ? opts.dateIso : today;
    session = {
        effectiveFrom: asked > today ? today : asked,
        onChanged: typeof opts.onChanged === 'function' ? opts.onChanged : null,
        editIdx: null,
        icon: MEMO_ICONS[0],
        presetLabel: ''
    };
    showList();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
}

/** ESC·바깥 클릭에서 부르는 닫기 (escape-close-modals 등록용) */
export function closeMemoSettings() {
    const modal = el('memoSettingsModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    session = null;
}

/* ── 바인딩 ───────────────────────────────────────────────── */

function bindOnce() {
    if (bound) return;
    bound = true;
    const modal = el('memoSettingsModal');
    if (!modal) return;

    modal.querySelector('#memoSettingsBackdrop')?.addEventListener('click', closeMemoSettings);
    modal.querySelector('#memoSettingsCloseBtn')?.addEventListener('click', closeMemoSettings);
    modal.querySelector('#memoSettingsBackBtn')?.addEventListener('click', showList);
    modal.querySelector('#memoSettingsAddBtn')?.addEventListener('click', () => showEdit(null));
    modal.querySelector('#slotMemoEditCancelBtn')?.addEventListener('click', showList);
    modal.querySelector('#slotMemoEditSaveBtn')?.addEventListener('click', commitEdit);

    modal.querySelector('#memoSettingsList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn || !session) return;
        const idx = Number(btn.closest('.memo-settings__row')?.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        if (btn.getAttribute('data-action') === 'del') removeAt(idx);
        else showEdit(idx);
    });

    modal.querySelector('#slotMemoNameInput')?.addEventListener('input', () => {
        if (!session) return;
        session.presetLabel = '';
        renderPresets();
        setError('');
    });
    modal.querySelector('#slotMemoNameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitEdit();
        }
    });
    modal.querySelector('#slotMemoPresetRow')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-preset-label]');
        if (!chip || !session) return;
        const label = chip.getAttribute('data-preset-label') || '';
        const nameInput = el('slotMemoNameInput');
        if (nameInput) nameInput.value = label;
        session.presetLabel = label;
        session.icon = memoIconOrDefault(chip.getAttribute('data-preset-icon'));
        setError('');
        renderPresets();
        renderIconGrid();
    });
    modal.querySelector('#slotMemoIconGrid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-icon]');
        if (!btn || !session) return;
        session.icon = memoIconOrDefault(btn.getAttribute('data-icon'));
        renderIconGrid();
    });
}

export function initMemoSettings() {
    bindOnce();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMemoSettings, { once: true });
    } else {
        initMemoSettings();
    }
}

window.openMemoSettings = openMemoSettings;
window.closeMemoSettings = closeMemoSettings;
