/**
 * 타임라인 기록 추가 — 슬롯 선택 센터 팝업
 * 식사·간식을 시간순으로 한 목록에 표시하고, 하루 소감은 하단에 둔다.
 * 이미 입력된 슬롯도 표시하며 추가 입력 가능.
 */
import { DAILY_JOURNAL_SLOT, SLOT_STYLES, getSlotLucideIcon } from '../constants.js';
import { userSlotsForDate, userSlotGroupsForDate } from '../utils/slot-view.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { openModal } from './entry-and-core.js';
import { openDailyJournalModal } from './daily-journal.js';
import { openSlotPlanSettings } from './slot-plan-settings.js';
import {
    dailyJournalHasContent,
    getDailyJournalFromSettings
} from '../utils/daily-journal-data.js';
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

function dailyJournalCount(dateIso) {
    try {
        if (window.dbOps && typeof window.dbOps.getDailyJournal === 'function') {
            return dailyJournalHasContent(window.dbOps.getDailyJournal(dateIso)) ? 1 : 0;
        }
    } catch (_) {}
    return dailyJournalHasContent(getDailyJournalFromSettings(window.userSettings, dateIso))
        ? 1
        : 0;
}

function formatPickerDateLabel(dateIso) {
    const [y, mo, d] = String(dateIso).split('-').map(Number);
    if (!y || !mo || !d) return dateIso;
    const dt = new Date(y, mo - 1, d);
    const week = ['일', '월', '화', '수', '목', '금', '토'][dt.getDay()];
    return `${mo}월 ${d}일 (${week})`;
}

/** 피커에서 하루 소감 아이콘 — 보라 계열로 본식 슬롯처럼 강조 */
const PICKER_DAILY_ICON_STYLE = {
    iconBg: 'bg-violet-50',
    iconText: 'text-violet-600'
};

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

/** 하루 소감 — 슬롯이 아니므로 전체 폭 한 줄 (설정 대상도 아니다) */
function buildDailyJournalRowHtml(count) {
    return `<button type="button" class="entry-slot-picker__item entry-slot-picker__item--daily" data-slot-id="${escapeHtml(DAILY_JOURNAL_SLOT.id)}" data-slot-type="daily">
        ${slotCardInnerHtml(PICKER_DAILY_ICON_STYLE, getSlotLucideIcon(DAILY_JOURNAL_SLOT.id), DAILY_JOURNAL_SLOT.label, count)}
    </button>`;
}

function renderPickerList(dateIso) {
    const list = document.getElementById('entrySlotPickerList');
    const dateEl = document.getElementById('entrySlotPickerDateLabel');
    if (!list) return;

    if (dateEl) dateEl.textContent = formatPickerDateLabel(dateIso);

    /**
     * 그 날짜 유효 개정판의 enabled 슬롯만 — 여기가 enabled 를 볼 수 있는
     * 유일한 곳이다(불변식 4: 렌더 필터 아님, 피커 필터).
     */
    const slots = userSlotsForDate(dateIso).filter((s) => s.enabled);
    const counts = countMealsByUserSlot(dateIso);

    const html = `<div class="entry-slot-picker__group">
        ${slots.map((s) => buildUserSlotCardHtml(s, counts.get(userSlotCountId(s)) || 0)).join('')}
        ${buildDailyJournalRowHtml(dailyJournalCount(dateIso))}
    </div>`;

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

async function onPickSlot(slotId, slotType, slotKey) {
    const dateIso = pendingDateIso || pageDateIso() || localTodayIso();
    closeEntrySlotPicker();
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
        closeEntrySlotPicker();
        openSlotPlanSettings({ fromPicker: true });
    });
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
