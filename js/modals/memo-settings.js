/**
 * 메모 설정 팝업 (docs/user-memo-items.md §4.3)
 *
 * **메모 항목의 유일한 관리 자리다** — 목록·만들기·이름/아이콘 고치기·빼기가
 * 전부 여기 있다. 기록 항목 설정 시트는 **식사 항목만** 다룬다.
 *
 * 세 판을 거쳐 이 모양이 됐다.
 *   1) 기록 항목 설정 시트에 '식사/메모' 두 구역 → 개념이 다른 둘이 한 화면.
 *   2) 만들기만 피커로 옮김 → "만들기는 여기, 빼기는 저기".
 *   3) 메모를 통째로 이리로. 목록과 새 항목을 **한 화면에** 둔다 —
 *      항목이 두어 개뿐인데 목록을 보고 다시 눌러 폼으로 들어가는 건 헛걸음이다.
 *   4) 겹치는 팝업이 아니라 **시트 전환**으로 — 기록 항목 설정과 같은 결이다.
 *      피커를 닫고 열며, 닫으면 피커로 돌아간다.
 *
 * 저장은 **즉시**다. 저장 버튼이 없다 — 적용 시작일은 부른 화면이 보고 있던
 * 날짜이고, 미래는 오늘로 자른다(user-slot-plan §5.5).
 */
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { bindListDragReorder } from '../utils/list-drag-reorder.js';
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
    isDefaultMemoKey,
    MEMO_ICONS,
    DEFAULT_MEMO_ICON,
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

/**
 * 지금 유효한 전체 항목(식사+메모) — 개정판을 쓸 때 통째로 넘겨야 한다.
 * 기준은 늘 **오늘**이다. 메모 항목 설정도 "앞으로 이렇게 기록한다"는 선언이라
 * 부른 화면이 며칠을 보고 있었는지와 무관하다 (user-slot-plan §4.2.3).
 */
function currentItems() {
    const today = localTodayIso();
    return effectiveSlots(window.userSettings, today, today);
}

function currentMemos() {
    return memoItemsOnly(currentItems());
}

function setError(msg) {
    const e = el('memoSettingsError');
    if (e) e.textContent = msg || '';
}

/* ── 렌더 ─────────────────────────────────────────────────── */

/**
 * 아이콘 격자 — **한 번에 하나만** 펼친다. 목록 행의 아이콘을 누르면 그 행
 * 바로 아래, 새 항목의 아이콘을 누르면 새 항목 아래. 어느 대상의 격자인지
 * 자리로 드러나므로 "지금 무엇을 고르는 중인가"를 따로 적을 필요가 없다.
 */
function iconGridHtml(selected) {
    return `<div class="slot-memo-edit__icons memo-settings__grid" role="radiogroup" aria-label="아이콘">
        ${MEMO_ICONS.map(
            (name) =>
                `<button type="button" class="slot-memo-edit__icon${name === selected ? ' slot-memo-edit__icon--on' : ''}" role="radio" aria-checked="${name === selected ? 'true' : 'false'}" data-icon="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">
                    <i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>
                </button>`
        ).join('')}
    </div>`;
}

/**
 * 메모는 **목록 순서**를 끌어 바꿀 수 있다 (§4.3). 이건 피커 격자에
 * 보이는 순서일 뿐, **타임라인의 자리는 여전히 기록의 시각이 정한다**(§1).
 * 둘을 혼동하면 "체중을 아침과 점심 사이에 둘까"가 다시 생긴다.
 *
 * 기본 메모는 **토글**, 사용자가 만든 것은 **빼기**다 (§2.6).
 * 기록 항목 설정의 '원본은 해제, 확장은 삭제'와 같은 규칙이다 — 기본은
 * 지워도 다음 읽기에서 덩붙어 되살아나므로 삭제 버튼이 거짓말이 된다.
 */
function rowHtml(item, idx) {
    const open = session.gridFor === idx;
    const isDefault = isDefaultMemoKey(item.key);
    const off = item.enabled === false;
    const unit = item.unit ? `<span class="memo-settings__unit">${escapeHtml(item.unit)}</span>` : '';
    const tail = isDefault
        ? `<button type="button" class="slot-plan-row__toggle" data-action="toggle" aria-pressed="${off ? 'false' : 'true'}" aria-label="${escapeHtml(item.label)} 사용">${off ? '사용 안 함' : '사용 중'}</button>`
        : `<button type="button" class="slot-plan-row__del" data-action="del" aria-label="${escapeHtml(item.label)} 항목 빼기">빼기</button>`;
    return `<div class="memo-settings__row-wrap${off ? ' memo-settings__row-wrap--off' : ''}" data-idx="${idx}">
        <div class="memo-settings__row">
            <span class="slot-plan-row__drag memo-settings__drag" data-action="drag" role="button" tabindex="0" aria-label="순서 이동" title="끌어서 순서 변경 (위아래 화살표 키로도 이동)">
                <i data-lucide="grip-vertical" aria-hidden="true"></i>
            </span>
            <button type="button" class="memo-settings__icon${open ? ' memo-settings__icon--on' : ''}" data-action="icon" aria-label="${escapeHtml(item.label)} 아이콘 고르기" aria-expanded="${open ? 'true' : 'false'}">
                <i data-lucide="${escapeHtml(memoIconOrDefault(item.icon))}" aria-hidden="true"></i>
            </button>
            <input type="text" class="memo-settings__name" data-action="name" value="${escapeHtml(item.label)}" maxlength="${MEMO_LABEL_MAX_CHARS}" aria-label="항목 이름" />
            ${unit}
            ${tail}
        </div>
        ${open ? iconGridHtml(memoIconOrDefault(item.icon)) : ''}
    </div>`;
}

function renderList() {
    renderListFrom(currentMemos());
}

/** 목록을 인자로 받는다 — 저장 직전의 사본을 그려야 하는 자리가 있다 */
function renderListFrom(memos) {
    const wrap = el('memoSettingsList');
    if (!wrap || !session) return;
    const countEl = el('memoSettingsCount');
    if (countEl) countEl.textContent = `사용 중 ${memos.filter((m) => m.enabled !== false).length} / ${MAX_ENABLED_MEMOS}`;
    wrap.innerHTML = memos.length
        ? memos.map(rowHtml).join('')
        : `<p class="memo-settings__empty">아직 메모 항목이 없어요. 체중·혈당·운동처럼 밥이 아닌 것도 남길 수 있습니다.</p>`;
    scheduleLucideIcons(wrap);
}

function renderNew() {
    if (!session) return;
    const iconBtn = el('memoNewIconBtn');
    const open = session.gridFor === 'new';
    if (iconBtn) {
        iconBtn.innerHTML = `<i data-lucide="${escapeHtml(session.newIcon)}" aria-hidden="true"></i>`;
        iconBtn.classList.toggle('memo-settings__icon--on', open);
        iconBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        scheduleLucideIcons(iconBtn);
    }
    // 아이콘 판이 열리면 안내는 제 할 일을 끝냈다 — 자리만 차지한다
    el('memoNewIconHint')?.classList.toggle('hidden', open);
    const grid = el('memoNewIconGrid');
    if (grid) {
        grid.classList.toggle('hidden', !open);
        if (open) {
            grid.innerHTML = MEMO_ICONS.map(
                (name) =>
                    `<button type="button" class="slot-memo-edit__icon${name === session.newIcon ? ' slot-memo-edit__icon--on' : ''}" role="radio" aria-checked="${name === session.newIcon ? 'true' : 'false'}" data-icon="${escapeHtml(name)}" aria-label="${escapeHtml(name)}">
                        <i data-lucide="${escapeHtml(name)}" aria-hidden="true"></i>
                    </button>`
            ).join('');
            scheduleLucideIcons(grid);
        } else {
            grid.innerHTML = '';
        }
    }
}

function render() {
    renderList();
    renderNew();
}

/* ── 저장 (즉시) ──────────────────────────────────────────── */

function addBlockedReason(items) {
    if (countMemos(items) >= MAX_ENABLED_MEMOS) {
        return `메모 항목은 ${MAX_ENABLED_MEMOS}개까지 쓸 수 있어요. 안 쓰는 항목을 빼 주세요.`;
    }
    if (items.length >= MAX_SLOTS_PER_REVISION) return '항목 목록이 가득 찼어요.';
    return '';
}

/**
 * 메모 목록을 통째로 갈아 끼운 개정판을 쓴다. 식사 슬롯은 손대지 않는다 —
 * `sanitizeSlots` 가 슬롯 앞·메모 뒤로 정렬해 주므로 이어 붙이기만 하면 된다.
 */
async function commitMemos(nextMemos) {
    if (!session) return;
    const settings = window.userSettings || {};
    const slots = currentItems().filter((s) => !isMemoItem(s));
    const today = localTodayIso();
    const next = withRevisionOn(
        settings.slotPlan || null,
        today,
        [...slots, ...nextMemos],
        Date.now(),
        Math.random,
        today
    );
    if (next === (settings.slotPlan || null)) return;

    settings.slotPlan = next;
    window.userSettings = settings;
    // 저장을 기다리지 않고 먼저 그린다 — 아웃박스가 내구화를 맡는다
    render();
    try {
        await dbOps.saveSettings(settings);
    } catch (e) {
        console.warn('메모 설정 저장(즉시 전송) 실패 — 아웃박스 재시도 예정:', e?.message || e);
    }
}

function renameAt(idx, raw) {
    const memos = currentMemos();
    if (!memos[idx]) return;
    const label = String(raw || '').trim().slice(0, MEMO_LABEL_MAX_CHARS);
    // 빈 이름으로 지우는 길은 두지 않는다 — 빼기가 그 일을 한다
    if (!label || label === memos[idx].label) {
        render();
        return;
    }
    void commitMemos(memos.map((m, i) => (i === idx ? { ...m, label } : m)));
}

function setIconAt(idx, icon) {
    const memos = currentMemos();
    if (!memos[idx]) return;
    session.gridFor = null;
    void commitMemos(memos.map((m, i) => (i === idx ? { ...m, icon: memoIconOrDefault(icon) } : m)));
}

/**
 * 빼기 — 확인 창을 띄우지 않는다. 되돌릴 수 없는 일이 아니기 때문이다:
 * 그 항목으로 남긴 **기록은 그대로 있고 이름도 유지된다**(§2.3 `retired`).
 */
function removeAt(idx) {
    const memos = currentMemos();
    if (!memos[idx] || isDefaultMemoKey(memos[idx].key)) return;
    if (session.gridFor === idx) session.gridFor = null;
    void commitMemos(memos.filter((_, i) => i !== idx));
}

/** 기본 메모 사용/해제 — 끄면 피커에서만 사라진다. 기록은 그대로다(불변식 4) */
function toggleAt(idx) {
    const memos = currentMemos();
    if (!memos[idx]) return;
    void commitMemos(memos.map((m, i) => (i === idx ? { ...m, enabled: m.enabled === false } : m)));
}

function addNew() {
    if (!session) return;
    const input = el('memoNewNameInput');
    const label = String(input?.value || '').trim().slice(0, MEMO_LABEL_MAX_CHARS);
    if (!label) {
        setError('이름을 적어 주세요.');
        input?.focus();
        return;
    }
    const blocked = addBlockedReason(currentItems());
    if (blocked) {
        setError(blocked);
        return;
    }
    setError('');
    // 새 key 는 지금 붙인다 — 슬롯과 같은 이름공간, 재사용 없음
    const next = [...currentMemos(), { key: generateSlotKey(), kind: 'memo', icon: session.newIcon, label, enabled: true }];
    if (input) input.value = '';
    session.newIcon = DEFAULT_MEMO_ICON;
    session.gridFor = null;
    void commitMemos(next);
}

/* ── 순서 바꾸기 (pointer 기반 — 터치 포함) ────── */

/**
 * 기록 항목 설정의 드래그와 같은 수다. 다른 점은 **놓는 순간 저장**한다는
 * 것 — 이 시트에는 저장 버튼이 없다. 끌기 중에는 draft 로만 움직이고
 * 떼는 순간 한 번 쓴다 — 한 칸 움직일 때마다 저장하면 개정판이 쌓는다.
 */
/**
 * 순서 바꾸기 — 공용 헬퍼에 얹는다 (js/utils/list-drag-reorder.js).
 * 끄는 동안 여기서 하는 일은 없다. 손을 뗀 뒤 한 번만 불린다.
 */
function bindDrag(list) {
    bindListDragReorder({
        list,
        rowSelector: '.memo-settings__row-wrap',
        handleSelector: '[data-action="drag"]',
        draggingClass: 'memo-settings__row-wrap--dragging',
        isEnabled: () => !!session,
        onStart: () => {
            // 펼친 아이콘 판을 접는다 — 그 행만 키가 크면 자리 계산이 어긋난다
            if (session && session.gridFor !== null) {
                session.gridFor = null;
                render();
            }
        },
        onMove: (from, to) => {
            const next = currentMemos();
            if (!next[from]) return;
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            void commitMemos(next);
        }
    });
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

/**
 * @param {{ dateIso?: string, fromPicker?: boolean }} [opts]
 *        dateIso — 닫을 때 피커를 되돌릴 날짜. 편집 대상 구성과는 무관하다
 *        fromPicker — 닫을 때 피커로 돌아간다 (기록 항목 설정과 같은 결)
 */
export function openMemoSettings(opts = {}) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = el('memoSettingsModal');
    if (!modal) return;
    session = {
        reopenPicker: opts.fromPicker === true,
        pickerDateIso: typeof opts.dateIso === 'string' ? opts.dateIso : '',
        gridFor: null,
        newIcon: DEFAULT_MEMO_ICON,
    };
    const input = el('memoNewNameInput');
    if (input) input.value = '';
    setError('');
    render();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('memoSettings');
}

/** ESC·바깥 클릭에서 부르는 닫기 (escape-close-modals 등록용) */
export function closeMemoSettings() {
    const modal = el('memoSettingsModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    const back = session?.reopenPicker === true;
    const dateIso = session?.pickerDateIso || '';
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    session = null;
    unlockBodyScroll('memoSettings');
    // 겹치는 팝업이 아니라 전환이다 — 온 자리로 돌려놓는다
    if (back && typeof window.openEntrySlotPicker === 'function') {
        window.openEntrySlotPicker(dateIso || undefined);
    }
}

/* ── 바인딩 ───────────────────────────────────────────────── */

function bindOnce() {
    if (bound) return;
    bound = true;
    const modal = el('memoSettingsModal');
    if (!modal) return;

    modal.querySelector('#memoSettingsBackdrop')?.addEventListener('click', closeMemoSettings);
    modal.querySelector('#memoSettingsCloseBtn')?.addEventListener('click', closeMemoSettings);

    const list = modal.querySelector('#memoSettingsList');
    list?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action], [data-icon]');
        if (!btn || !session) return;
        const idx = Number(btn.closest('.memo-settings__row-wrap')?.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        if (btn.hasAttribute('data-icon')) {
            setIconAt(idx, btn.getAttribute('data-icon'));
            return;
        }
        const action = btn.getAttribute('data-action');
        if (action === 'drag') return; // 순서 끌기는 pointer 핸들러가 맡는다
        if (action === 'del') removeAt(idx);
        else if (action === 'toggle') toggleAt(idx);
        else if (action === 'icon') {
            session.gridFor = session.gridFor === idx ? null : idx;
            render();
        }
    });
    /** 이름은 **입력을 마칠 때** 저장한다 — 글자마다 저장하면 개정판이 쌓인다 */
    list?.addEventListener('change', (e) => {
        const input = e.target.closest('[data-action="name"]');
        if (!input || !session) return;
        const idx = Number(input.closest('.memo-settings__row-wrap')?.getAttribute('data-idx'));
        if (Number.isFinite(idx)) renameAt(idx, input.value);
    });
    list?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest('[data-action="name"]')) {
            e.preventDefault();
            e.target.blur();
        }
    });
    if (list) bindDrag(list);

    modal.querySelector('#memoNewAddBtn')?.addEventListener('click', addNew);
    modal.querySelector('#memoNewIconBtn')?.addEventListener('click', () => {
        if (!session) return;
        session.gridFor = session.gridFor === 'new' ? null : 'new';
        render();
    });
    modal.querySelector('#memoNewNameInput')?.addEventListener('input', () => setError(''));
    modal.querySelector('#memoNewNameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addNew();
        }
    });
    modal.querySelector('#memoNewIconGrid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-icon]');
        if (!btn || !session) return;
        session.newIcon = memoIconOrDefault(btn.getAttribute('data-icon'));
        session.gridFor = null;
        renderNew();
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
