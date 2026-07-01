/**
 * 밀로그 날짜별 AI 식단분석 리포트 팝업
 */
import { db, appId, callableFunctions } from '../firebase.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { formatMealogDateLabel } from '../utils/date-label.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
import { toLocalDateString } from '../utils.js';
import { SLOTS } from '../constants.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

let _currentDate = '';
let _loading = false;

export function isAiDietReportDateVisible(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return false;
    }
    const todayStr = toLocalDateString(new Date());
    if (dateStr >= todayStr) return false;
    return true;
}

export function countAnalyzableMealsForDate(dateStr) {
    const slotIds = new Set(SLOTS.map((s) => s.id));
    return (window.mealHistory || []).filter(
        (m) =>
            m &&
            m.date === dateStr &&
            !isDailyJournalMealRecord(m) &&
            slotIds.has(m.slotId)
    ).length;
}

export function getAiDietReportButtonHtml(dateStr) {
    if (!window.currentUser || window.currentUser.isAnonymous) return '';
    if (!isAiDietReportDateVisible(dateStr)) return '';
    return `<button type="button" data-mealog-diet-report="1" data-mealog-date="${dateStr}" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors rounded-lg text-emerald-700 bg-emerald-50 border border-emerald-200/80 whitespace-nowrap">
        <i class="fa-solid fa-clipboard-check text-[12px] mr-1" aria-hidden="true"></i>AI 리포트
    </button>`;
}

function reportDocId(uid, dateStr) {
    return `${uid}_${dateStr}`;
}

function formatReportGeneratedAt(value) {
    if (!value) return '';
    try {
        const d = value.toDate ? value.toDate() : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) {
        return '';
    }
}

function setModalVisible(visible) {
    const modal = document.getElementById('dietReportModal');
    if (!modal) return;
    modal.classList.toggle('hidden', !visible);
    document.body.classList.toggle('diet-report-modal-open', visible);
}

function renderLoading() {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-14 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-3" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">리포트 불러오는 중…</p>
        </div>`;
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) regenBtn.classList.add('hidden');
}

function renderEmpty(dateStr, mealCount) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    if (mealCount < 2) {
        body.innerHTML = `
            <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
                <p class="text-sm font-bold text-slate-700">분석 조건 미충족</p>
                <p class="text-xs text-slate-500 mt-2 leading-relaxed">해당 날짜에 식사·간식 기록이 <strong class="text-slate-700">2건 이상</strong> 있어야 AI 분석을 받을 수 있어요.<br>현재 ${mealCount}건</p>
            </div>`;
        const regenBtn = document.getElementById('dietReportRegenerateBtn');
        if (regenBtn) regenBtn.classList.add('hidden');
        return;
    }
    body.innerHTML = `
        <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center">
            <i class="fa-solid fa-wand-magic-sparkles text-2xl text-emerald-500 mb-3" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-700">아직 AI 리포트가 없어요</p>
            <p class="text-xs text-slate-500 mt-2 leading-relaxed">아래 버튼으로 지금 바로 분석할 수 있어요.</p>
            <button type="button" id="dietReportAnalyzeNowBtn" class="mt-4 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl transition-colors">
                지금 분석하기
            </button>
        </div>`;
    document.getElementById('dietReportAnalyzeNowBtn')?.addEventListener('click', () => {
        void runRegenerate(dateStr);
    });
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) regenBtn.classList.add('hidden');
}

function renderError(message) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    body.innerHTML = `
        <div class="rounded-xl border border-red-200 bg-red-50 p-5 text-center">
            <p class="text-sm font-bold text-red-700">분석에 실패했어요</p>
            <p class="text-xs text-red-600/90 mt-2 leading-relaxed">${escapeHtml(message || '잠시 후 다시 시도해 주세요.')}</p>
        </div>`;
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) {
        regenBtn.classList.remove('hidden');
        regenBtn.disabled = false;
        regenBtn.textContent = '다시 분석하기';
    }
}

function renderReport(data) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    const score = Number(data.score);
    const scoreDisplay = Number.isFinite(score) ? `${Math.round(score)}<span class="text-lg font-bold text-slate-400">/100</span>` : '—';
    const generatedLabel = formatReportGeneratedAt(data.generatedAt);
    body.innerHTML = `
        <div class="space-y-4">
            <div class="flex items-end justify-between gap-3 rounded-xl bg-gradient-to-br from-emerald-50 to-white border border-emerald-100 p-5">
                <div>
                    <p class="text-xs font-bold text-emerald-700/80 mb-1">식단 점수</p>
                    <p class="text-4xl font-black text-emerald-600 tabular-nums leading-none">${scoreDisplay}</p>
                </div>
                <p class="text-sm font-bold text-slate-700 text-right leading-snug min-w-0 flex-1">${escapeHtml(data.summary || '')}</p>
            </div>
            ${
                data.goodPoint
                    ? `<div class="rounded-xl border border-slate-200 bg-white p-4">
                <p class="text-xs font-bold text-slate-500 mb-1">좋았던 점</p>
                <p class="text-sm text-slate-800 leading-relaxed">${escapeHtml(data.goodPoint)}</p>
            </div>`
                    : ''
            }
            ${
                data.improvePoint
                    ? `<div class="rounded-xl border border-slate-200 bg-white p-4">
                <p class="text-xs font-bold text-slate-500 mb-1">아쉬운 점</p>
                <p class="text-sm text-slate-800 leading-relaxed">${escapeHtml(data.improvePoint)}</p>
            </div>`
                    : ''
            }
            <div class="text-center space-y-1">
                ${generatedLabel ? `<p class="text-[11px] font-bold text-slate-500">생성 ${escapeHtml(generatedLabel)}</p>` : ''}
                <p class="text-[11px] text-slate-400">AI가 기록·사진을 바탕으로 생성한 참고용 분석입니다.</p>
            </div>
        </div>`;
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) {
        regenBtn.classList.remove('hidden');
        regenBtn.disabled = false;
        regenBtn.textContent = '다시 분석하기';
    }
}

async function fetchReportDoc(dateStr) {
    const uid = window.currentUser?.uid;
    if (!uid) return null;
    const snap = await getDoc(doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr)));
    return snap.exists() ? snap.data() : null;
}

async function runRegenerate(dateStr) {
    if (_loading || !dateStr) return;
    if (countAnalyzableMealsForDate(dateStr) < 2) {
        showToast('식사·간식 기록이 2건 이상 있어야 분석할 수 있어요.', 'info');
        renderEmpty(dateStr, countAnalyzableMealsForDate(dateStr));
        return;
    }
    _loading = true;
    renderLoading();
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) {
        regenBtn.disabled = true;
        regenBtn.textContent = '분석 중…';
    }
    try {
        const res = await callableFunctions.regenerateDietReport({ date: dateStr });
        const report = res?.data?.report;
        if (report?.status === 'ready') {
            const saved = await fetchReportDoc(dateStr);
            renderReport(saved || report);
            showToast('AI 식단 분석이 완료되었어요.', 'success');
        } else {
            const saved = await fetchReportDoc(dateStr);
            if (saved?.status === 'ready') renderReport(saved);
            else if (saved?.status === 'error') renderError(saved.errorMessage);
            else renderError('분석 결과를 받지 못했습니다.');
        }
    } catch (e) {
        console.error('regenerateDietReport failed', e);
        const msg = e?.message || String(e);
        if (msg.includes('resource-exhausted')) {
            showToast('방금 분석했어요. 잠시 후 다시 시도해 주세요.', 'info');
        } else if (msg.includes('failed-precondition')) {
            showToast('분석 조건을 확인해 주세요.', 'info');
        } else {
            showToast('AI 분석에 실패했습니다.', 'error');
        }
        const saved = await fetchReportDoc(dateStr).catch(() => null);
        if (saved?.status === 'ready') renderReport(saved);
        else renderError(msg);
    } finally {
        _loading = false;
    }
}

export async function openDietReportModal(dateStr) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (!isAiDietReportDateVisible(dateStr)) return;

    _currentDate = dateStr;
    const title = document.getElementById('dietReportModalTitle');
    if (title) title.textContent = `AI 식단분석 · ${formatMealogDateLabel(dateStr)}`;

    setModalVisible(true);
    renderLoading();

    const mealCount = countAnalyzableMealsForDate(dateStr);
    try {
        const data = await fetchReportDoc(dateStr);
        if (data?.status === 'ready') {
            renderReport(data);
        } else if (data?.status === 'error') {
            renderError(data.errorMessage);
        } else {
            renderEmpty(dateStr, mealCount);
        }
    } catch (e) {
        console.error('openDietReportModal load failed', e);
        renderError(e?.message || String(e));
    }
}

export function closeDietReportModal() {
    _currentDate = '';
    _loading = false;
    setModalVisible(false);
}

window.openDietReportModal = openDietReportModal;
window.closeDietReportModal = closeDietReportModal;

document.getElementById('dietReportRegenerateBtn')?.addEventListener('click', () => {
    if (_currentDate) void runRegenerate(_currentDate);
});

const _dietReportTimelineBound = new WeakMap();
function bindDietReportTimelineDelegation() {
    const root = document.getElementById('timelineContainer');
    if (!root || _dietReportTimelineBound.has(root)) return;
    _dietReportTimelineBound.set(root, true);
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mealog-diet-report]');
        if (!btn || !root.contains(btn)) return;
        const dateStr = btn.getAttribute('data-mealog-date') || '';
        if (!dateStr) return;
        e.preventDefault();
        e.stopPropagation();
        void openDietReportModal(dateStr);
    });
}

bindDietReportTimelineDelegation();
window.bindDietReportTimelineDelegation = bindDietReportTimelineDelegation;
