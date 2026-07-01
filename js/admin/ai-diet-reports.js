/**
 * 관리자 > 모니터링 > AI 식단분석
 * aiDietReports(날짜 단위 리포트) 목록·상세. 생성은 Functions(배치/수동)만.
 */
import { db, appId } from '../firebase.js';
import { escapeHtml, runAdminRefreshAction, fetchAdminEmailsForUserIds } from './utils.js';
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
let selectedReportId = null;

function formatTimestamp(value) {
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
    if (status === 'ready') {
        return '<span class="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-xs font-bold">완료</span>';
    }
    return `<span class="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-xs font-bold">${escapeHtml(status || '—')}</span>`;
}

function triggerBadge(trigger) {
    if (trigger === 'manual') {
        return '<span class="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 text-[11px] font-bold">수동</span>';
    }
    return '<span class="px-1.5 py-0.5 rounded bg-slate-50 text-slate-500 text-[11px] font-bold">배치</span>';
}

function scoreText(score) {
    if (score == null || Number.isNaN(Number(score))) return '—';
    return `${Number(score)}점`;
}

function reportKindBadge(data) {
    if (data?.isHistory === true) {
        return '<span class="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-bold">이력</span>';
    }
    return '<span class="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-[11px] font-bold">최신</span>';
}

function renderInputMealsSection(data) {
    const meals = Array.isArray(data?.inputMeals) ? data.inputMeals : [];
    const mealText = typeof data?.inputMealText === 'string' ? data.inputMealText.trim() : '';

    if (!meals.length && !mealText) {
        return `
            <div class="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 p-3 text-xs text-slate-500 leading-relaxed">
                이 리포트 생성 시점에 저장된 입력 데이터가 없습니다. (배포 이전 리포트이거나 분석 전 실패)
            </div>`;
    }

    const mealCards = meals
        .map((m) => {
            const urls = Array.isArray(m.analyzedPhotoUrls) ? m.analyzedPhotoUrls.filter(Boolean) : [];
            const photoMeta =
                Number(m.photoCount) > 0
                    ? `사진 ${Number(m.photoCount) || 0}장 · 분석 ${urls.length}장`
                    : '사진 없음';
            const thumbs = urls.length
                ? `<div class="mt-2 flex flex-wrap gap-2">${urls
                      .map(
                          (url, i) =>
                              `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="block w-16 h-16 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 shrink-0" title="분석 사진 ${i + 1}">
                                  <img src="${escapeHtml(url)}" alt="" class="w-full h-full object-cover" loading="lazy">
                              </a>`
                      )
                      .join('')}</div>`
                : '';
            return `<div class="rounded-lg border border-slate-200 bg-white p-3">
                <div class="flex items-center justify-between gap-2 mb-1.5">
                    <p class="text-xs font-black text-slate-800">${escapeHtml(m.slotLabel || m.slotId || '슬롯')}</p>
                    <span class="text-[11px] text-slate-500 shrink-0">${escapeHtml(photoMeta)}</span>
                </div>
                <pre class="whitespace-pre-wrap break-words text-xs text-slate-700 leading-relaxed m-0 font-sans">${escapeHtml(m.detailText || '(내용 없음)')}</pre>
                ${thumbs}
            </div>`;
        })
        .join('');

    const promptBlock = mealText
        ? `<details class="mt-3 rounded-lg border border-slate-200 bg-slate-50/80">
                <summary class="cursor-pointer select-none px-3 py-2 text-xs font-bold text-slate-600">Gemini 전송 텍스트 블록</summary>
                <pre class="whitespace-pre-wrap break-words text-xs text-slate-700 leading-relaxed m-0 px-3 pb-3 pt-1 font-sans max-h-64 overflow-y-auto">${escapeHtml(mealText)}</pre>
           </details>`
        : '';

    return `<div class="space-y-2">${mealCards}${promptBlock}</div>`;
}

function renderDetailEmpty() {
    const el = document.getElementById('aiDietReportsDetail');
    if (!el) return;
    el.innerHTML = `
        <div class="h-full min-h-[280px] flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-6">
            <i class="fa-solid fa-clipboard-check text-3xl mb-3 opacity-40" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">목록에서 리포트를 선택하세요</p>
            <p class="text-xs mt-1 text-center">날짜별 식단 점수·한줄평·분석 상세가 표시됩니다.</p>
        </div>`;
}

function renderDetailPanel(data, id) {
    const el = document.getElementById('aiDietReportsDetail');
    if (!el || !data) return;
    const token = data.tokensUsed || {};
    const tokenLines = [
        token.promptTokenCount != null ? `입력 ${token.promptTokenCount}` : '',
        token.candidatesTokenCount != null ? `출력 ${token.candidatesTokenCount}` : '',
        token.totalTokenCount != null ? `합계 ${token.totalTokenCount}` : ''
    ].filter(Boolean).join(' · ');

    const bodyText = data.status === 'error'
        ? (data.errorMessage || '(오류 메시지 없음)')
        : [
            data.summary ? `한줄평: ${data.summary}` : '',
            data.goodPoint ? `좋았던 점: ${data.goodPoint}` : '',
            data.improvePoint ? `아쉬운 점: ${data.improvePoint}` : ''
        ].filter(Boolean).join('\n\n') || '(내용 없음)';

    el.innerHTML = `
        <div class="border border-slate-200 rounded-xl overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h4 class="text-sm font-black text-slate-800">${escapeHtml(data.date || '')} 리포트</h4>
                <span class="text-lg font-black ${data.status === 'error' ? 'text-red-500' : 'text-emerald-600'}">${escapeHtml(scoreText(data.score))}</span>
            </div>
            <div class="p-4 space-y-3 text-sm">
                <dl class="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-3 items-start">
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">상태</dt>
                    <dd class="min-w-0">${statusBadge(data.status)} ${triggerBadge(data.trigger)} ${reportKindBadge(data)}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">사용자</dt>
                    <dd class="text-slate-800 font-mono text-xs min-w-0 break-all">${escapeHtml(data._email || data.userId || '—')}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">기록</dt>
                    <dd class="text-slate-800 min-w-0">식사/간식 ${Number(data.mealCount) || 0}건 · 사진 ${Number(data.photoCount) || 0}장(분석 ${Number(data.analyzedPhotoCount) || 0}장)</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">모델</dt>
                    <dd class="text-slate-800 font-mono text-xs min-w-0 break-all">${escapeHtml(data.modelVersion || '—')} · ${escapeHtml(data.promptVersion || '—')}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">토큰</dt>
                    <dd class="text-slate-700 text-xs min-w-0">${escapeHtml(tokenLines || '—')}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">생성</dt>
                    <dd class="text-slate-700 text-xs min-w-0">${escapeHtml(formatTimestamp(data.generatedAt))}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">분석 입력</dt>
                    <dd class="min-w-0">${renderInputMealsSection(data)}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">분석 결과</dt>
                    <dd class="min-w-0">
                        <pre class="whitespace-pre-wrap break-words text-sm text-slate-900 ${data.status === 'error' ? 'bg-red-50/60 border-red-100' : 'bg-emerald-50/60 border-emerald-100'} border rounded-lg p-3 font-sans leading-relaxed m-0">${escapeHtml(bodyText)}</pre>
                    </dd>
                </dl>
            </div>
        </div>`;
}

function paintListTable(rows) {
    const container = document.getElementById('aiDietReportsList');
    if (!container) return;

    if (!rows.length) {
        container.innerHTML = `
            <div class="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                <i class="fa-solid fa-inbox text-2xl mb-2 opacity-40" aria-hidden="true"></i>
                <p class="text-sm font-bold">리포트가 없습니다</p>
                <p class="text-xs mt-1">분석 요청마다 생성 시각 기준으로 쌓입니다. 같은 날짜 재분석도 이력으로 남습니다.</p>
            </div>`;
        renderDetailEmpty();
        return;
    }

    const body = rows.map(({ id, data }) => {
        const active = id === selectedReportId;
        const safeId = String(id).replace(/'/g, "\\'");
        return `<tr class="border-b border-slate-100 cursor-pointer hover:bg-slate-50/90 ${active ? 'bg-emerald-50/80' : ''}" onclick="window.selectAiDietReport('${safeId}')" data-report-id="${escapeHtml(String(id))}">
            <td class="px-3 py-2.5 text-sm text-slate-700 tabular-nums whitespace-nowrap align-top leading-snug">${escapeHtml(data.date || '—')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-500 tabular-nums whitespace-nowrap align-top leading-snug">${escapeHtml(formatTimestamp(data.generatedAt))}</td>
            <td class="px-3 py-2.5 text-sm text-slate-800 min-w-[8rem] align-top break-all">${escapeHtml(data._email || data.userId || '—')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-500 tabular-nums whitespace-nowrap align-top">${Number(data.photoCount) || 0}</td>
            <td class="px-3 py-2.5 align-top whitespace-nowrap">${statusBadge(data.status)} ${triggerBadge(data.trigger)} ${reportKindBadge(data)}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="overflow-x-auto border border-slate-200 rounded-xl">
            <table class="w-full text-left border-collapse min-w-[520px]">
                <thead>
                    <tr class="bg-slate-100 text-slate-700 text-xs font-black">
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">식단 날짜</th>
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">생성 시각</th>
                        <th class="px-3 py-2.5 font-bold">사용자</th>
                        <th class="px-3 py-2.5 font-bold">사진</th>
                        <th class="px-3 py-2.5 font-bold">상태</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>
        <p class="text-xs text-slate-400 mt-2">행을 클릭하면 오른쪽에 상세 내용이 표시됩니다.</p>`;
}

function renderPagination() {
    const el = document.getElementById('aiDietReportsPagination');
    if (!el) return;
    if (!listHasMore) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
        <button type="button" onclick="window.loadMoreAiDietReports()" class="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors">
            더 보기
        </button>`;
}

async function decorateRowsWithEmail(rows) {
    const uids = rows.map((r) => r.data && r.data.userId).filter(Boolean);
    if (!uids.length) return;
    try {
        const emailMap = await fetchAdminEmailsForUserIds(uids);
        rows.forEach((r) => {
            if (r.data && r.data.userId) {
                const email = emailMap.get(r.data.userId);
                if (email) r.data._email = email;
            }
        });
    } catch (_) {
        /* 이메일 보강 실패는 무시 (userId로 표시) */
    }
}

export async function renderAiDietReports({ append = false } = {}) {
    const listEl = document.getElementById('aiDietReportsList');
    if (!listEl) return;

    if (!append) {
        listEl.innerHTML = '<div class="text-center py-10 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-sm">불러오는 중…</p></div>';
    }

    try {
        const coll = collection(db, 'artifacts', appId, 'aiDietReports');
        let q = query(coll, orderBy('generatedAt', 'desc'), limit(PAGE_SIZE));
        if (append && listLastDoc) {
            q = query(coll, orderBy('generatedAt', 'desc'), startAfter(listLastDoc), limit(PAGE_SIZE));
        }

        const snap = await getDocs(q);
        const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
        listHasMore = snap.docs.length >= PAGE_SIZE;
        listLastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : listLastDoc;

        await decorateRowsWithEmail(rows);

        if (append) {
            const prevRows = window._aiDietReportRows || [];
            window._aiDietReportRows = prevRows.concat(rows);
        } else {
            window._aiDietReportRows = rows;
            if (selectedReportId && !rows.find((r) => r.id === selectedReportId)) {
                selectedReportId = null;
                renderDetailEmpty();
            }
        }

        paintListTable(window._aiDietReportRows || []);
        renderPagination();

        if (selectedReportId) {
            const hit = (window._aiDietReportRows || []).find((r) => r.id === selectedReportId);
            if (hit) renderDetailPanel(hit.data, hit.id);
        }
    } catch (e) {
        console.error('aiDietReports load failed', e);
        listEl.innerHTML = `<div class="text-center py-10 text-red-500 text-sm">목록을 불러오지 못했습니다.<br><span class="text-xs text-slate-500">${escapeHtml(e.message || String(e))}</span></div>`;
        renderDetailEmpty();
    }
}

window.selectAiDietReport = async function (reportId) {
    if (!reportId) return;
    selectedReportId = reportId;
    const cached = (window._aiDietReportRows || []).find((r) => r.id === reportId);
    if (cached) {
        paintListTable(window._aiDietReportRows || []);
        renderDetailPanel(cached.data, cached.id);
        return;
    }
    try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'aiDietReports', reportId));
        if (!snap.exists()) return;
        renderDetailPanel(snap.data(), reportId);
    } catch (e) {
        console.error('selectAiDietReport', e);
    }
};

window.refreshAiDietReports = async function (buttonEl) {
    await runAdminRefreshAction(buttonEl || null, async () => {
        listLastDoc = null;
        listHasMore = false;
        selectedReportId = null;
        window._aiDietReportRows = [];
        renderDetailEmpty();
        await renderAiDietReports({ append: false });
    });
};

window.loadMoreAiDietReports = async function () {
    await renderAiDietReports({ append: true });
};

renderDetailEmpty();
