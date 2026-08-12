// ADMIN 웰컴메시지 > 요일별 화면 — 팝업이 열릴 때 요일별로 처음 보여줄 탭/페이지
import { db, appId } from '../firebase.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
    DEFAULT_WELCOME_WEEKDAY_DEFAULTS,
    WELCOME_KIND_LABELS,
    WELCOME_SLIDE_LABELS,
    WELCOME_WEEKDAY_LABELS,
    clampWelcomeSlideIdx,
    normalizeWelcomeWeekdayDefaults,
    pickWelcomeKind
} from '../welcome-weekday-config.js';

const KIND_ORDER = ['report', 'meal', 'snack'];

function slideSelectHtml(day, kind, slideIdx) {
    const labels = WELCOME_SLIDE_LABELS[kind] || [];
    const options = labels
        .map(
            (label, i) =>
                `<option value="${i}"${i === slideIdx ? ' selected' : ''}>${i + 1}. ${label}</option>`
        )
        .join('');
    const only = labels.length <= 1;
    return `<select class="admin-welcome-weekday-slide w-full max-w-[16rem] px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none focus:border-emerald-500 disabled:bg-slate-50 disabled:text-slate-400"
            data-weekday="${day}" aria-label="${WELCOME_WEEKDAY_LABELS[day]}요일 페이지"${only ? ' disabled' : ''}>${options}</select>`;
}

function kindSelectHtml(day, kind) {
    const options = KIND_ORDER.map(
        (k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${WELCOME_KIND_LABELS[k]}</option>`
    ).join('');
    return `<select class="admin-welcome-weekday-kind w-full max-w-[10rem] px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white outline-none focus:border-emerald-500"
            data-weekday="${day}" aria-label="${WELCOME_WEEKDAY_LABELS[day]}요일 탭">${options}</select>`;
}

function rowHtml(day, entry) {
    const isWeekend = day === 0 || day === 6;
    const dayCls = day === 0 ? 'text-red-600' : day === 6 ? 'text-blue-600' : 'text-slate-800';
    return `<tr data-weekday-row="${day}"${isWeekend ? ' class="bg-slate-50/40"' : ''}>
    <td class="px-3 py-3 align-middle font-bold ${dayCls}">${WELCOME_WEEKDAY_LABELS[day]}</td>
    <td class="px-3 py-2 align-middle">${kindSelectHtml(day, entry.kind)}</td>
    <td class="px-3 py-2 align-middle">${slideSelectHtml(day, entry.kind, entry.slideIdx)}</td>
</tr>`;
}

/**
 * adminSettings/config.welcomeWeekdayDefaults → 표 렌더 (loadAdminSettings에서 호출)
 * @param {unknown} raw
 */
export function fillWelcomeWeekdayForm(raw) {
    const tbody = document.getElementById('adminWelcomeWeekdayTableBody');
    if (!tbody) return;
    const cfg = normalizeWelcomeWeekdayDefaults(raw);
    tbody.innerHTML = [0, 1, 2, 3, 4, 5, 6].map((day) => rowHtml(day, cfg[day])).join('');
    bindWelcomeWeekdayTableOnce();
}

let welcomeWeekdayBound = false;
function bindWelcomeWeekdayTableOnce() {
    if (welcomeWeekdayBound) return;
    const tbody = document.getElementById('adminWelcomeWeekdayTableBody');
    if (!tbody) return;
    welcomeWeekdayBound = true;
    // 탭을 바꾸면 페이지 목록도 그 탭의 슬라이드로 다시 채운다
    tbody.addEventListener('change', (e) => {
        const kindSel = e.target.closest('.admin-welcome-weekday-kind');
        if (!kindSel) return;
        const day = Number(kindSel.dataset.weekday);
        const kind = pickWelcomeKind(kindSel.value) || 'meal';
        const cell = tbody.querySelector(`tr[data-weekday-row="${day}"] td:last-child`);
        if (!cell) return;
        cell.innerHTML = slideSelectHtml(day, kind, 0);
    });
}

function readWelcomeWeekdayForm() {
    /** @type {Record<number, { kind: string, slideIdx: number }>} */
    const out = {};
    for (let day = 0; day <= 6; day++) {
        const kindSel = document.querySelector(`.admin-welcome-weekday-kind[data-weekday="${day}"]`);
        const slideSel = document.querySelector(`.admin-welcome-weekday-slide[data-weekday="${day}"]`);
        const fallback = DEFAULT_WELCOME_WEEKDAY_DEFAULTS[day];
        const kind = pickWelcomeKind(kindSel?.value) || fallback.kind;
        const idx = slideSel ? Number(slideSel.value) : fallback.slideIdx;
        out[day] = { kind, slideIdx: clampWelcomeSlideIdx(kind, idx) };
    }
    return out;
}

/** 저장하지 않고 표만 코드 기본값으로 되돌림 */
window.resetWelcomeWeekdayDefaultsForm = function () {
    fillWelcomeWeekdayForm(DEFAULT_WELCOME_WEEKDAY_DEFAULTS);
};

window.saveWelcomeWeekdayDefaults = async function () {
    try {
        const payload = readWelcomeWeekdayForm();
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        await setDoc(configRef, { welcomeWeekdayDefaults: payload }, { merge: true });
        alert('요일별 화면 설정이 저장되었습니다.');
    } catch (e) {
        console.error('요일별 화면 설정 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
};
