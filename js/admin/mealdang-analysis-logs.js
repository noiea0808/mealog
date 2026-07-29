/**
 * 관리자 > AI > AI 응답 (밀당 Gemini 분석 로그)
 */
import { db, appId } from '../firebase.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const PAGE_SIZE = 50;
let listLastDoc = null;
let listHasMore = false;
let selectedLogId = null;

function formatLogTimestamp(value) {
    if (!value) return '—';
    try {
        const d = value.toDate ? value.toDate() : new Date(value);
        if (Number.isNaN(d.getTime())) return '—';
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${y}-${m}-${day} ${hh}:${mm}`;
    } catch (_) {
        return '—';
    }
}

function statusBadge(status) {
    if (status === 'error') {
        return '<span class="px-2 py-0.5 rounded bg-red-100 text-red-700 text-xs font-bold">실패</span>';
    }
    return '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs font-bold">성공</span>';
}

function renderDetailEmpty() {
    const el = document.getElementById('mealdangAnalysisLogsDetail');
    if (!el) return;
    el.innerHTML = `
        <div class="h-full min-h-[280px] flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-6">
            <i data-lucide="bot" class="text-3xl mb-3 opacity-40" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">목록에서 항목을 선택하세요</p>
            <p class="text-xs mt-1 text-center">밀당 COMMENT(Gemini) 분석 요청·응답 상세가 표시됩니다.</p>
        </div>`;
}

function renderDetailPanel(data, id) {
    const el = document.getElementById('mealdangAnalysisLogsDetail');
    if (!el || !data) return;
    const token = data.tokenUsage || {};
    const tokenLines = [
        token.promptTokenCount != null ? `입력 ${token.promptTokenCount}` : '',
        token.candidatesTokenCount != null ? `출력 ${token.candidatesTokenCount}` : '',
        token.thoughtsTokenCount != null ? `thinking ${token.thoughtsTokenCount}` : '',
        token.totalTokenCount != null ? `합계 ${token.totalTokenCount}` : ''
    ].filter(Boolean).join(' · ');

    const recordSummary = `전체 ${Number(data.mealRecordCount) || 0}건 · 본식 ${Number(data.mainMealCount) || 0}회 (${Number(data.mealRecordPercent) || 0}%)${data.hasMealdangMemo ? ' · 밀당 메모 참고' : ''}`;
    const responseBody = data.responseText
        || (data.status === 'error' && data.errorMessage ? data.errorMessage : '')
        || (data.status === 'error' ? '(응답 없음)' : '(없음)');

    el.innerHTML = `
        <div class="border border-slate-200 rounded-xl overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <h4 class="text-sm font-black text-slate-800">분석 상세</h4>
            </div>
            <div class="p-4 space-y-3 text-sm">
                <dl class="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-3 items-start">
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">기록 요약</dt>
                    <dd class="text-slate-800 min-w-0">${escapeHtml(recordSummary)}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">모델</dt>
                    <dd class="text-slate-800 font-mono text-xs min-w-0 break-all">${escapeHtml(data.model || '—')}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">토큰</dt>
                    <dd class="text-slate-700 text-xs min-w-0">${escapeHtml(tokenLines || '—')}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">식사 데이터</dt>
                    <dd class="min-w-0">
                        <pre class="whitespace-pre-wrap break-words text-xs text-slate-800 bg-slate-50 border border-slate-200 rounded-lg p-3 font-sans leading-relaxed m-0">${escapeHtml(data.mealDataSummary || '(없음)')}</pre>
                    </dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">수신한 답변</dt>
                    <dd class="min-w-0">
                        <pre class="whitespace-pre-wrap break-words text-sm text-slate-900 bg-emerald-50/60 border border-emerald-100 rounded-lg p-3 font-sans leading-relaxed m-0">${escapeHtml(responseBody)}</pre>
                    </dd>
                </dl>
            </div>
        </div>`;
}

function paintListTable(rows) {
    const container = document.getElementById('mealdangAnalysisLogsList');
    if (!container) return;

    if (!rows.length) {
        container.innerHTML = `
            <div class="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                <i data-lucide="inbox" class="text-2xl mb-2 opacity-40" aria-hidden="true"></i>
                <p class="text-sm font-bold">기록이 없습니다</p>
                <p class="text-xs mt-1">Functions 배포 후 사용자가 밀당 COMMENT를 실행하면 여기에 쌓입니다.</p>
            </div>`;
        renderDetailEmpty();
        return;
    }

    const body = rows.map(({ id, data }) => {
        const active = id === selectedLogId;
        const safeId = String(id).replace(/'/g, "\\'");
        return `<tr class="border-b border-slate-100 cursor-pointer hover:bg-slate-50/90 ${active ? 'bg-emerald-50/80' : ''}" onclick="window.selectMealdangAnalysisLog('${safeId}')" data-log-id="${escapeHtml(String(id))}">
            <td class="px-3 py-2.5 text-sm text-slate-600 tabular-nums whitespace-nowrap align-top leading-snug">${escapeHtml(formatLogTimestamp(data.requestedAt))}</td>
            <td class="px-3 py-2.5 text-sm text-slate-800 min-w-[6rem] align-top">${escapeHtml(data.userNickname || '익명')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-700 min-w-[7rem] align-top">${escapeHtml(data.dateRangeText || '—')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-700 whitespace-nowrap align-top">${escapeHtml(data.characterName || '—')}</td>
            <td class="px-3 py-2.5 align-top whitespace-nowrap">${statusBadge(data.status)}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="overflow-x-auto border border-slate-200 rounded-xl">
            <table class="w-full text-left border-collapse min-w-[560px]">
                <thead>
                    <tr class="bg-slate-100 text-slate-700 text-xs font-black">
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">요청 일시</th>
                        <th class="px-3 py-2.5 font-bold">사용자</th>
                        <th class="px-3 py-2.5 font-bold">분석 기간</th>
                        <th class="px-3 py-2.5 font-bold">캐릭터</th>
                        <th class="px-3 py-2.5 font-bold">상태</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>
        <p class="text-xs text-slate-400 mt-2">행을 클릭하면 오른쪽에 상세 내용이 표시됩니다.</p>`;
}

function renderPagination() {
    const el = document.getElementById('mealdangAnalysisLogsPagination');
    if (!el) return;
    if (!listHasMore) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <button type="button" onclick="window.loadMoreMealdangAnalysisLogs()" class="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors">
            더 보기
        </button>`;
}

export async function renderMealdangAnalysisLogs({ append = false } = {}) {
    const listEl = document.getElementById('mealdangAnalysisLogsList');
    if (!listEl) return;

    if (!append) {
        listEl.innerHTML = '<div class="text-center py-10 text-slate-400"><i data-lucide="loader-circle" class="text-xl mb-2 lucide-spin"></i><p class="text-sm">불러오는 중…</p></div>';
    }

    try {
        const coll = collection(db, 'artifacts', appId, 'mealdangAnalysisLogs');
        let q = query(coll, orderBy('requestedAt', 'desc'), limit(PAGE_SIZE));
        if (append && listLastDoc) {
            q = query(coll, orderBy('requestedAt', 'desc'), startAfter(listLastDoc), limit(PAGE_SIZE));
        }

        const snap = await getDocs(q);
        const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        listHasMore = snap.docs.length >= PAGE_SIZE;
        listLastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : listLastDoc;

        if (append) {
            const prevRows = window._mealdangAnalysisLogRows || [];
            window._mealdangAnalysisLogRows = prevRows.concat(rows);
        } else {
            window._mealdangAnalysisLogRows = rows;
            if (selectedLogId && !rows.find((r) => r.id === selectedLogId)) {
                selectedLogId = null;
                renderDetailEmpty();
            }
        }

        paintListTable(window._mealdangAnalysisLogRows || []);
        renderPagination();

        if (selectedLogId) {
            const hit = (window._mealdangAnalysisLogRows || []).find((r) => r.id === selectedLogId);
            if (hit) renderDetailPanel(hit.data, hit.id);
        }
    } catch (e) {
        console.error('mealdangAnalysisLogs load failed', e);
        listEl.innerHTML = `<div class="text-center py-10 text-red-500 text-sm">목록을 불러오지 못했습니다.<br><span class="text-xs text-slate-500">${escapeHtml(e.message || String(e))}</span></div>`;
        renderDetailEmpty();
    }
}

window.selectMealdangAnalysisLog = async function (logId) {
    if (!logId) return;
    selectedLogId = logId;
    const cached = (window._mealdangAnalysisLogRows || []).find((r) => r.id === logId);
    if (cached) {
        paintListTable(window._mealdangAnalysisLogRows || []);
        renderDetailPanel(cached.data, cached.id);
        return;
    }
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'mealdangAnalysisLogs', logId));
        if (!snap.exists()) return;
        renderDetailPanel(snap.data(), logId);
    } catch (e) {
        console.error('selectMealdangAnalysisLog', e);
    }
};

window.refreshMealdangAnalysisLogs = async function (buttonEl) {
    await runAdminRefreshAction(buttonEl || null, async () => {
        listLastDoc = null;
        listHasMore = false;
        selectedLogId = null;
        window._mealdangAnalysisLogRows = [];
        renderDetailEmpty();
        await renderMealdangAnalysisLogs({ append: false });
    });
};

window.loadMoreMealdangAnalysisLogs = async function () {
    await renderMealdangAnalysisLogs({ append: true });
};

renderDetailEmpty();
