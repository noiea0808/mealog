/**
 * 메모 항목 만들기·고치기 팝업 (docs/user-memo-items.md §4.3)
 *
 * 두 곳에서 부른다. 만들기는 **기록 추가 시트**(피커) 머리에서 — 항목을
 * 만드는 것과 기록하는 것이 같은 자리에 있어야 발견된다. 고치기는 기록 항목
 * 설정 시트의 메모 행에서.
 *
 * 그래서 이 모듈은 **저장을 모른다.** 값만 받아 `onCommit` 으로 넘기고,
 * 부르는 쪽이 draft 를 고칠지 개정판을 쓸지 정한다 — 두 호출부의 저장 시점이
 * 다르기 때문이다(설정 시트는 저장 버튼에서 한 번에, 피커는 즉시).
 */
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { memoIconOrDefault, MEMO_ICONS, MEMO_PRESETS, MEMO_LABEL_MAX_CHARS } from '../utils/slot-plan.js';

let bound = false;
/** 열려 있는 동안만 유효 */
let session = null;

function el(id) {
    return document.getElementById(id);
}

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

function renderPresets() {
    const row = el('slotMemoPresetRow');
    if (!row) return;
    row.innerHTML = MEMO_PRESETS.map(
        (p) =>
            `<button type="button" class="slot-memo-edit__preset" data-preset-label="${escapeHtml(p.label)}" data-preset-icon="${escapeHtml(p.icon)}">${escapeHtml(p.label)}</button>`
    ).join('');
}

/**
 * @param {{
 *   item?: {label?: string, icon?: string} | null,   생략하면 새로 만들기
 *   blockedReason?: string,                          만들 수 없을 때의 사유
 *   onCommit: (value: {label: string, icon: string}) => void
 * }} opts
 */
export function openMemoItemEdit(opts = {}) {
    const modal = el('slotMemoEditModal');
    if (!modal || typeof opts.onCommit !== 'function') return;
    const editing = !!opts.item;

    session = {
        editing,
        icon: editing ? memoIconOrDefault(opts.item.icon) : MEMO_ICONS[0],
        blockedReason: editing ? '' : String(opts.blockedReason || ''),
        onCommit: opts.onCommit
    };

    const title = el('slotMemoEditTitle');
    if (title) title.textContent = editing ? '메모 항목 고치기' : '새 메모 항목';
    const saveBtn = el('slotMemoEditSaveBtn');
    if (saveBtn) saveBtn.textContent = editing ? '적용' : '만들기';
    const nameInput = el('slotMemoNameInput');
    if (nameInput) nameInput.value = editing ? String(opts.item.label || '') : '';
    // 프리셋은 처음 만들 때만 — 고치는 중에 이름을 덮어쓰면 놀란다
    el('slotMemoPresetRow')?.classList.toggle('hidden', editing);
    setError(session.blockedReason);
    renderPresets();
    renderIconGrid();

    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    nameInput?.focus();
}

/** ESC·바깥 클릭에서 부르는 닫기 (escape-close-modals 등록용) */
export function closeMemoItemEdit() {
    const modal = el('slotMemoEditModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    session = null;
}

function commit() {
    if (!session) return;
    if (session.blockedReason) {
        setError(session.blockedReason);
        return;
    }
    const nameInput = el('slotMemoNameInput');
    const label = String(nameInput?.value || '').trim().slice(0, MEMO_LABEL_MAX_CHARS);
    if (!label) {
        setError('이름을 적어 주세요.');
        nameInput?.focus();
        return;
    }
    const { onCommit } = session;
    const value = { label, icon: session.icon };
    closeMemoItemEdit();
    onCommit(value);
}

function bindOnce() {
    if (bound) return;
    bound = true;
    const modal = el('slotMemoEditModal');
    if (!modal) return;
    modal.querySelector('#slotMemoEditBackdrop')?.addEventListener('click', closeMemoItemEdit);
    modal.querySelector('#slotMemoEditCloseBtn')?.addEventListener('click', closeMemoItemEdit);
    modal.querySelector('#slotMemoEditCancelBtn')?.addEventListener('click', closeMemoItemEdit);
    modal.querySelector('#slotMemoEditSaveBtn')?.addEventListener('click', commit);
    modal.querySelector('#slotMemoNameInput')?.addEventListener('input', () => {
        if (session && !session.blockedReason) setError('');
    });
    modal.querySelector('#slotMemoNameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        }
    });
    modal.querySelector('#slotMemoPresetRow')?.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-preset-label]');
        if (!chip || !session) return;
        const nameInput = el('slotMemoNameInput');
        if (nameInput) nameInput.value = chip.getAttribute('data-preset-label') || '';
        session.icon = memoIconOrDefault(chip.getAttribute('data-preset-icon'));
        if (!session.blockedReason) setError('');
        renderIconGrid();
    });
    modal.querySelector('#slotMemoIconGrid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-icon]');
        if (!btn || !session) return;
        session.icon = memoIconOrDefault(btn.getAttribute('data-icon'));
        renderIconGrid();
    });
}

export function initMemoItemEdit() {
    bindOnce();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMemoItemEdit, { once: true });
    } else {
        initMemoItemEdit();
    }
}

window.closeSlotMemoEdit = closeMemoItemEdit;
