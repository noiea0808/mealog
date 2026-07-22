/**
 * 타임라인 기록 추가 — 슬롯 선택 바텀시트
 * 본식·간식·하루 기록을 모두 포함. 이미 입력된 슬롯도 표시하며 추가 입력 가능.
 */
import { SLOTS, DAILY_JOURNAL_SLOT, SLOT_STYLES, DAILY_JOURNAL_SLOT_STYLE } from '../constants.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { openModal } from './entry-and-core.js';
import { openDailyJournalModal } from './daily-journal.js';
import {
    dailyJournalHasContent,
    getDailyJournalFromSettings
} from '../utils/daily-journal-data.js';
import { escapeHtml } from '../render/utils.js';

let pickerBound = false;
let pendingDateIso = '';

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getTimeBasedMainSlotId(refDate = new Date()) {
    const hour = refDate.getHours();
    if (hour < 11) return 'morning';
    if (hour < 17) return 'lunch';
    return 'dinner';
}

function pageDateIso() {
    const d = appState.pageDate instanceof Date ? appState.pageDate : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function countMealsOnSlot(dateIso, slotId) {
    const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    return history.filter((m) => m?.date === dateIso && m?.slotId === slotId).length;
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

function slotIconClass(slot) {
    if (slot.type === 'daily') return 'fa-book-open';
    if (slot.type === 'snack') return 'fa-mug-saucer';
    if (slot.id === 'morning') return 'fa-sun';
    if (slot.id === 'lunch') return 'fa-utensils';
    if (slot.id === 'dinner') return 'fa-moon';
    return 'fa-plate-wheat';
}

function slotTint(slot) {
    if (slot.type === 'daily') return DAILY_JOURNAL_SLOT_STYLE;
    return SLOT_STYLES[slot.id] || SLOT_STYLES.default;
}

function buildSlotRowHtml(slot, count, preferred) {
    const style = slotTint(slot);
    const countBadge =
        count > 0
            ? `<span class="entry-slot-picker__count">${count}건 · 추가 가능</span>`
            : `<span class="entry-slot-picker__count entry-slot-picker__count--empty">아직 없음</span>`;
    const preferredCls = preferred ? ' entry-slot-picker__item--preferred' : '';
    return `<button type="button" class="entry-slot-picker__item${preferredCls}" data-slot-id="${escapeHtml(slot.id)}" data-slot-type="${escapeHtml(slot.type)}">
        <span class="entry-slot-picker__icon ${style.iconBg} ${style.iconText}" aria-hidden="true">
            <i class="fa-solid ${slotIconClass(slot)}"></i>
        </span>
        <span class="entry-slot-picker__meta">
            <span class="entry-slot-picker__label">${escapeHtml(slot.label)}</span>
            ${countBadge}
        </span>
        <i data-lucide="chevron-right" class="entry-slot-picker__chevron" aria-hidden="true"></i>
    </button>`;
}

function renderPickerList(dateIso) {
    const list = document.getElementById('entrySlotPickerList');
    const dateEl = document.getElementById('entrySlotPickerDateLabel');
    if (!list) return;

    if (dateEl) dateEl.textContent = formatPickerDateLabel(dateIso);

    const preferredMain = getTimeBasedMainSlotId(new Date());
    const mains = SLOTS.filter((s) => s.type === 'main');
    const snacks = SLOTS.filter((s) => s.type === 'snack');

    let html = `<div class="entry-slot-picker__group">
        <p class="entry-slot-picker__group-title">식사</p>
        ${mains.map((s) => buildSlotRowHtml(s, countMealsOnSlot(dateIso, s.id), s.id === preferredMain)).join('')}
    </div>`;
    html += `<div class="entry-slot-picker__group">
        <p class="entry-slot-picker__group-title">간식</p>
        ${snacks.map((s) => buildSlotRowHtml(s, countMealsOnSlot(dateIso, s.id), false)).join('')}
    </div>`;
    html += `<div class="entry-slot-picker__group">
        <p class="entry-slot-picker__group-title">하루</p>
        ${buildSlotRowHtml(DAILY_JOURNAL_SLOT, dailyJournalCount(dateIso), false)}
    </div>`;

    list.innerHTML = html;
}

export function closeEntrySlotPicker() {
    const modal = document.getElementById('entrySlotPickerModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    pendingDateIso = '';
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
}

async function onPickSlot(slotId, slotType) {
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
    await openModal(dateIso, slotId, null);
}

function bindPickerOnce() {
    if (pickerBound) return;
    pickerBound = true;
    const modal = document.getElementById('entrySlotPickerModal');
    if (!modal) return;

    modal.querySelector('#entrySlotPickerBackdrop')?.addEventListener('click', closeEntrySlotPicker);
    modal.querySelector('#entrySlotPickerCloseBtn')?.addEventListener('click', closeEntrySlotPicker);

    modal.querySelector('#entrySlotPickerList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-slot-id]');
        if (!btn || !modal.contains(btn)) return;
        const slotId = btn.getAttribute('data-slot-id');
        const slotType = btn.getAttribute('data-slot-type') || '';
        if (!slotId) return;
        void onPickSlot(slotId, slotType);
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
