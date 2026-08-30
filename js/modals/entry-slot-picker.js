/**
 * 타임라인 기록 추가 — 슬롯 선택 센터 팝업
 * 식사·간식을 시간순으로 한 목록에 표시하고, 하루 소감은 하단에 둔다.
 * 이미 입력된 슬롯도 표시하며 추가 입력 가능.
 */
import { SLOT_STYLES, getSlotLucideIcon } from '../constants.js';
import { userSlotGroupsForDate, currentMemoItems, currentMealSlots, memoRecordCountsForDate } from '../utils/slot-view.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { openModal } from './entry-and-core.js';
import { openDailyJournalModal } from './daily-journal.js';
import { openSlotPlanSettings } from './slot-plan-settings.js';
import { openMemoRecordModal } from './memo-record.js';
import { openMemoSettings } from './memo-settings.js';
import { memoIconOrDefault, isJournalMemoKey, MEMO_SLOT_ID } from '../utils/slot-plan.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';

let pickerBound = false;
let pendingDateIso = '';

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function pageDateIso() {
    const d = appState.pageDate instanceof Date ? appState.pageDate : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * 사용자 슬롯별 건수 — 타임라인과 같은 그룹 규칙(user-slot-plan §3).
 * slotKey 없는 옛 기록은 base 원본 슬롯의 건수로 잡힌다.
 * @returns {Map<string, number>} 그룹 식별자(`key` 또는 `b:base`) → 건수
 */
function countMealsByUserSlot(dateIso) {
    const counts = new Map();
    for (const { slot, records } of userSlotGroupsForDate(dateIso)) {
        counts.set(slot.key != null ? slot.key : `b:${slot.id}`, records.length);
    }
    return counts;
}

function userSlotCountId(slot) {
    return slot.key != null ? slot.key : `b:${slot.base}`;
}

function formatPickerDateLabel(dateIso) {
    const [y, mo, d] = String(dateIso).split('-').map(Number);
    if (!y || !mo || !d) return dateIso;
    const dt = new Date(y, mo - 1, d);
    const week = ['일', '월', '화', '수', '목', '금', '토'][dt.getDay()];
    return `${mo}월 ${d}일 (${week})`;
}

function countBadgeHtml(count) {
    return count > 0
        ? `<span class="entry-slot-picker__count">${count}건</span>`
        : `<span class="entry-slot-picker__count entry-slot-picker__count--empty">아직 없음</span>`;
}

/**
 * 카드 속: 아이콘 | (이름 / 건수)
 *
 * 아이콘을 이름과 같은 행에 두지 않고 **카드 전체 높이의 중앙**에 세운다.
 * 이름이 12자라 두 줄로 접히면 카드가 세 줄이 되는데, 아이콘이 첫 줄에
 * 매달려 있으면 위로 쏠려 보인다.
 */
function slotCardInnerHtml(style, iconName, label, count) {
    return `<span class="entry-slot-picker__icon ${style.iconBg} ${style.iconText}" aria-hidden="true">
            <i data-lucide="${iconName}" aria-hidden="true"></i>
        </span>
        <span class="entry-slot-picker__body">
            <span class="entry-slot-picker__label">${escapeHtml(label)}</span>
            ${countBadgeHtml(count)}
        </span>`;
}

/**
 * 사용자 슬롯 카드 (두 열 격자의 한 칸).
 * 아이콘·색은 base 의 것 — 사용자 슬롯이 뭐라 불리든 시간대의 낯은 유지된다.
 */
function buildUserSlotCardHtml(slot, count) {
    const style = SLOT_STYLES[slot.base] || SLOT_STYLES.default;
    return `<button type="button" class="entry-slot-picker__item" data-slot-id="${escapeHtml(slot.base)}" data-slot-key="${escapeHtml(slot.key || '')}" data-slot-type="meal">
        ${slotCardInnerHtml(style, getSlotLucideIcon(slot.base), slot.label, count)}
    </button>`;
}

/**
 * 메모 카드 — 3열, 중성 색, 점선 (user-memo-items §4.1).
 *
 * 줄당 개수와 색을 식사 슬롯과 다르게 둔다. 두 구역이 한눈에 갈라져야
 * "이건 밥, 이건 메모"가 소제목 없이 전달된다.
 */
function buildMemoCardHtml(item, count) {
    return `<button type="button" class="entry-slot-picker__memo" data-slot-id="${MEMO_SLOT_ID}" data-slot-key="${escapeHtml(item.key || '')}" data-slot-type="memo">
        <span class="entry-slot-picker__memo-icon" aria-hidden="true">
            <i data-lucide="${escapeHtml(memoIconOrDefault(item.icon))}" aria-hidden="true"></i>
        </span>
        <span class="entry-slot-picker__memo-label">${escapeHtml(item.label)}</span>
        <span class="entry-slot-picker__memo-count">${count > 0 ? `${count}건` : ''}</span>
    </button>`;
}

function renderPickerList(dateIso) {
    const list = document.getElementById('entrySlotPickerList');
    const dateEl = document.getElementById('entrySlotPickerDateLabel');
    if (!list) return;

    if (dateEl) dateEl.textContent = formatPickerDateLabel(dateIso);

    /**
     * **지금** 쓰는 enabled 슬롯만 — 여기가 enabled 를 볼 수 있는 유일한 곳이다
     * (불변식 4: 렌더 필터 아님, 피커 필터). 보고 있는 날짜가 과거여도 목록은
     * 지금 것이다 — 기록 항목 설정은 "앞으로 이렇게 기록한다"는 선언이므로
     * (user-slot-plan §4.2.3). 기록 **수**는 그 날짜 것을 센다.
     */
    // 메모를 배제한 식사 슬롯만 — 메모는 아래 구역이 따로 맡는다
    const slots = currentMealSlots().filter((s) => s.enabled);
    const counts = countMealsByUserSlot(dateIso);

    const memos = currentMemoItems().filter((m) => m.enabled);
    const memoCounts = memoRecordCountsForDate(dateIso);
    const memoGroup = memos.length
        ? `<div class="entry-slot-picker__memo-group">
            ${memos.map((m) => buildMemoCardHtml(m, memoCounts.get(String(m.key || '')) || 0)).join('')}
        </div>`
        : '';

    const html = `<div class="entry-slot-picker__group">
        ${slots.map((s) => buildUserSlotCardHtml(s, counts.get(userSlotCountId(s)) || 0)).join('')}
    </div>${memoGroup}`;

    list.innerHTML = html;
    scheduleLucideIcons(list);
}

export function closeEntrySlotPicker() {
    const modal = document.getElementById('entrySlotPickerModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) {
        active.blur();
    }
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    pendingDateIso = '';
    unlockBodyScroll('entrySlotPicker');
}

/**
 * @param {string} [dateIso] YYYY-MM-DD — 기본은 일간 pageDate, 없으면 오늘
 */
export async function openEntrySlotPicker(dateIso) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = document.getElementById('entrySlotPickerModal');
    if (!modal) {
        console.error('entrySlotPickerModal 없음');
        return;
    }
    pendingDateIso =
        typeof dateIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateIso)
            ? dateIso
            : pageDateIso() || localTodayIso();
    renderPickerList(pendingDateIso);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('entrySlotPicker');
}

/**
 * 메모 설정 — 기록 추가 시트 머리의 메모 아이콘 (user-memo-items §4.3).
 *
 * 항목을 만들·고치·빼는 일이 전부 그 팝업에 있다. 기록 항목 설정 시트는
 * 식사 항목만 다룬다 — 개념이 다른 둘이 한 화면을 나눠 쓰면 어느 쪽을
 * 고치는 화면인지 매번 읽어야 한다.
 */
function onOpenMemoSettings() {
    const dateIso = pendingDateIso || pageDateIso() || localTodayIso();
    // 겹치는 팝업이 아니라 **전환**이다 — 기록 항목 설정과 같은 결
    closeEntrySlotPicker();
    openMemoSettings({ dateIso, fromPicker: true });
}

async function onPickSlot(slotId, slotType, slotKey) {
    const dateIso = pendingDateIso || pageDateIso() || localTodayIso();
    closeEntrySlotPicker();
    /**
     * 메모는 누를 때마다 **늘 새 기록**이다 (user-memo-items §4.4).
     * 아침에 재고 저녁에 또 재는 것이 기본 쓰임이라,
     * '고칠까 새로 쓸까'를 되묻는 화면은 매번 나오는 방해가 된다.
     */
    if (slotType === 'memo' || slotId === MEMO_SLOT_ID) {
        /**
         * 하루 소감도 메모 항목이지만 기록은 dailyComments 에 산다(§7.3) —
         * 목록에서의 자리만 메모 규칙을 따르고, 시트는 그쪽 것이 열린다.
         */
        if (isJournalMemoKey(slotKey)) {
            if (typeof openDailyJournalModal === 'function') openDailyJournalModal(dateIso);
            else window.openDailyJournalModal?.(dateIso);
            return;
        }
        openMemoRecordModal(dateIso, slotKey || '');
        return;
    }
    if (slotType === 'daily' || slotId === 'daily_journal') {
        if (typeof openDailyJournalModal === 'function') {
            openDailyJournalModal(dateIso);
        } else if (typeof window.openDailyJournalModal === 'function') {
            window.openDailyJournalModal(dateIso);
        }
        return;
    }
    await openModal(dateIso, slotId, null, { slotKey: slotKey || null });
}

function bindPickerOnce() {
    if (pickerBound) return;
    pickerBound = true;
    const modal = document.getElementById('entrySlotPickerModal');
    if (!modal) return;

    modal.querySelector('#entrySlotPickerBackdrop')?.addEventListener('click', closeEntrySlotPicker);
    modal.querySelector('#entrySlotPickerSettingsBtn')?.addEventListener('click', () => {
        // 보고 있던 날짜를 적용 시작일 기본값으로 넘긴다 (§4.2.3)
        const dateIso = pendingDateIso || pageDateIso() || localTodayIso();
        closeEntrySlotPicker();
        openSlotPlanSettings({ fromPicker: true, dateIso });
    });
    modal.querySelector('#entrySlotPickerMemoAddBtn')?.addEventListener('click', onOpenMemoSettings);
    modal.querySelector('#entrySlotPickerList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-slot-id]');
        if (!btn || !modal.contains(btn)) return;
        const slotId = btn.getAttribute('data-slot-id');
        const slotType = btn.getAttribute('data-slot-type') || '';
        const slotKey = btn.getAttribute('data-slot-key') || '';
        if (!slotId) return;
        void onPickSlot(slotId, slotType, slotKey);
    });
}

/** DOM 준비 후 호출 */
export function initEntrySlotPicker() {
    bindPickerOnce();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEntrySlotPicker, { once: true });
    } else {
        initEntrySlotPicker();
    }
}

window.openEntrySlotPicker = openEntrySlotPicker;
window.closeEntrySlotPicker = closeEntrySlotPicker;
