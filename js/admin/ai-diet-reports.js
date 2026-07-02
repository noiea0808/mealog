/**
 * 관리자 > AI > AI 식단분석
 * aiDietReports(날짜 단위 리포트) 목록·상세. 생성은 Functions(배치/수동)만.
 */
import { db, appId } from '../firebase.js';
import { escapeHtml, runAdminRefreshAction, fetchAdminEmailsForUserIds } from './utils.js';
import {
    parseAiMealReport,
    extractAiMealReportSource,
    renderAiMealReportCardHtml,
    extractAnalyzedPhotoUrlsForDisplay,
    aiMealReportPreviewLine
} from '../utils/ai-meal-report.js';
import {
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter,
    where,
    Timestamp
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

function parseTokensUsed(tokensUsed) {
    const t = tokensUsed && typeof tokensUsed === 'object' ? tokensUsed : {};
    return {
        prompt: Number(t.promptTokenCount) || 0,
        candidates: Number(t.candidatesTokenCount) || 0,
        thoughts: Number(t.thoughtsTokenCount) || 0,
        total: Number(t.totalTokenCount) || 0
    };
}

function resolveTokenTotal(tokensUsed) {
    const t = parseTokensUsed(tokensUsed);
    return t.total || t.prompt + t.candidates + t.thoughts;
}

function formatTokensCompact(tokensUsed) {
    const total = resolveTokenTotal(tokensUsed);
    if (!total) return '—';
    return total.toLocaleString('ko-KR');
}

function formatTokensDetail(tokensUsed) {
    const t = parseTokensUsed(tokensUsed);
    const total = resolveTokenTotal(tokensUsed);
    if (!total) return '—';
    const parts = [];
    if (t.prompt) parts.push(`입력 ${t.prompt.toLocaleString('ko-KR')}`);
    if (t.candidates) parts.push(`출력 ${t.candidates.toLocaleString('ko-KR')}`);
    if (t.thoughts) parts.push(`thinking ${t.thoughts.toLocaleString('ko-KR')}`);
    if (t.total) parts.push(`합계 ${t.total.toLocaleString('ko-KR')}`);
    else parts.push(`합계 ${total.toLocaleString('ko-KR')}`);
    return parts.join(' · ');
}

function aggregateUsageRows(rows) {
    const totals = { prompt: 0, candidates: 0, thoughts: 0, total: 0, reports: 0, withTokens: 0 };
    const modelMap = new Map();

    for (const row of rows) {
        const data = row?.data || row;
        totals.reports += 1;
        const model = String(data?.modelVersion || '').trim() || '(미기록)';
        const t = parseTokensUsed(data?.tokensUsed);
        const rowTotal = resolveTokenTotal(data?.tokensUsed);

        if (rowTotal > 0) {
            totals.withTokens += 1;
            totals.prompt += t.prompt;
            totals.candidates += t.candidates;
            totals.thoughts += t.thoughts;
            totals.total += t.total || rowTotal;
        }

        if (!modelMap.has(model)) {
            modelMap.set(model, { count: 0, tokens: 0 });
        }
        const entry = modelMap.get(model);
        entry.count += 1;
        if (rowTotal > 0) entry.tokens += rowTotal;
    }

    const models = [...modelMap.entries()]
        .sort((a, b) => b[1].tokens - a[1].tokens || b[1].count - a[1].count)
        .map(([name, stats]) => ({ name, ...stats }));

    return { totals, models };
}

async function fetchSevenDayUsageStats() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    cutoff.setHours(0, 0, 0, 0);

    const coll = collection(db, 'artifacts', appId, 'aiDietReports');
    const q = query(coll, where('generatedAt', '>=', Timestamp.fromDate(cutoff)));
    const snap = await getDocs(q);
    const rows = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    return aggregateUsageRows(rows);
}

function renderUsageStatsPanel(stats) {
    const el = document.getElementById('aiDietReportsUsageStats');
    if (!el) return;

    if (!stats || stats.totals.reports === 0) {
        el.innerHTML = `
            <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-500">
                최근 7일간 생성된 리포트가 없습니다.
            </div>`;
        el.classList.remove('hidden');
        return;
    }

    const { totals, models } = stats;
    const modelChips = models
        .map((m) => {
            const tokenPart = m.tokens
                ? `<span class="text-emerald-700 font-sans tabular-nums">${m.tokens.toLocaleString('ko-KR')} tok</span>`
                : '';
            return `<span class="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-xs font-mono text-slate-700">
                ${escapeHtml(m.name)}
                <span class="text-slate-400 font-sans font-bold">${m.count}건</span>
                ${tokenPart}
            </span>`;
        })
        .join('');

    el.innerHTML = `
        <div class="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
                <p class="text-xs font-black text-slate-700">최근 7일 Gemini 사용량</p>
                <p class="text-[11px] text-slate-500 tabular-nums">${totals.reports}건 분석 · 토큰 기록 ${totals.withTokens}건</p>
            </div>
            <div class="flex flex-wrap gap-2">${modelChips || '<span class="text-xs text-slate-500">모델 정보 없음</span>'}</div>
            <p class="text-xs text-slate-600 tabular-nums leading-relaxed">
                <span class="font-bold text-slate-700">토큰 합계</span>
                · 입력 ${totals.prompt.toLocaleString('ko-KR')}
                · 출력 ${totals.candidates.toLocaleString('ko-KR')}${
                    totals.thoughts ? ` · thinking ${totals.thoughts.toLocaleString('ko-KR')}` : ''
                }
                · <strong class="text-emerald-700">총 ${totals.total.toLocaleString('ko-KR')}</strong>
            </p>
        </div>`;
    el.classList.remove('hidden');
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

function reportKindBadge(data) {
    if (data?.isHistory === true) {
        return '<span class="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 text-[11px] font-bold">이력</span>';
    }
    return '<span class="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 text-[11px] font-bold">최신</span>';
}

function renderInputMealsSection(data) {
    const meals = Array.isArray(data?.inputMeals) ? data.inputMeals : [];
    const mealText = typeof data?.inputMealText === 'string' ? data.inputMealText.trim() : '';
    const dailyJournalComment =
        typeof data?.inputDailyJournalComment === 'string' ? data.inputDailyJournalComment.trim() : '';

    if (!meals.length && !mealText && !dailyJournalComment) {
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
            const metaBits = [];
            if (m.time) metaBits.push(String(m.time));
            if (m.rating != null && m.rating !== '') metaBits.push(`만족 ${m.rating}`);
            if (m.satiety != null && m.satiety !== '') metaBits.push(`포만 ${m.satiety}`);
            const metaLine = metaBits.length ? `<p class="text-[11px] text-slate-500 mt-1">${escapeHtml(metaBits.join(' · '))}</p>` : '';
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
                ${metaLine}
                <pre class="whitespace-pre-wrap break-words text-xs text-slate-700 leading-relaxed m-0 font-sans">${escapeHtml(m.detailText || '(내용 없음)')}</pre>
                ${thumbs}
            </div>`;
        })
        .join('');

    const dailyJournalBlock = dailyJournalComment
        ? `<div class="rounded-lg border border-violet-200 bg-violet-50/60 p-3">
                <p class="text-xs font-black text-violet-800 mb-1.5">하루소감</p>
                <p class="whitespace-pre-wrap break-words text-xs text-slate-700 leading-relaxed m-0">${escapeHtml(dailyJournalComment)}</p>
           </div>`
        : '';

    const promptBlock = mealText
        ? `<details class="mt-3 rounded-lg border border-slate-200 bg-slate-50/80">
                <summary class="cursor-pointer select-none px-3 py-2 text-xs font-bold text-slate-600">Gemini 전송 텍스트 블록</summary>
                <pre class="whitespace-pre-wrap break-words text-xs text-slate-700 leading-relaxed m-0 px-3 pb-3 pt-1 font-sans max-h-64 overflow-y-auto">${escapeHtml(mealText)}</pre>
           </details>`
        : '';

    return `<div class="space-y-2">${mealCards}${dailyJournalBlock}${promptBlock}</div>`;
}

function renderDetailEmpty() {
    const el = document.getElementById('aiDietReportsDetail');
    if (!el) return;
    el.innerHTML = `
        <div class="h-full min-h-[280px] flex flex-col items-center justify-center text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-6">
            <i class="fa-solid fa-clipboard-check text-3xl mb-3 opacity-40" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">목록에서 리포트를 선택하세요</p>
            <p class="text-xs mt-1 text-center">날짜별 AI 응답·분석 입력·상세가 표시됩니다.</p>
        </div>`;
}

function renderDetailPanel(data, id) {
    const el = document.getElementById('aiDietReportsDetail');
    if (!el || !data) return;
    const tokenLines = formatTokensDetail(data.tokensUsed);

    const rawResponse = typeof data.responseText === 'string' ? data.responseText.trim() : '';
    const reportSource = extractAiMealReportSource(data);
    const parsedReport = data.status === 'error' ? null : parseAiMealReport(reportSource);
    const previewLine = parsedReport ? aiMealReportPreviewLine(parsedReport) : '—';

    const responseBlock =
        data.status === 'error'
            ? `<pre class="whitespace-pre-wrap break-words text-sm text-red-800 bg-red-50/60 border border-red-100 rounded-lg p-3 font-sans leading-relaxed m-0">${escapeHtml(data.errorMessage || '(오류 메시지 없음)')}</pre>`
            : `${renderAiMealReportCardHtml(parsedReport, escapeHtml, {
                  photoUrls: extractAnalyzedPhotoUrlsForDisplay(data)
              })}${
                  rawResponse
                      ? `<details class="mt-2 rounded-lg border border-slate-200 bg-slate-50/80">
                            <summary class="cursor-pointer select-none px-3 py-2 text-xs font-bold text-slate-500">AI 응답 원문</summary>
                            <pre class="whitespace-pre-wrap break-words text-xs text-slate-600 leading-relaxed m-0 px-3 pb-3 pt-1 font-mono max-h-48 overflow-y-auto">${escapeHtml(rawResponse)}</pre>
                         </details>`
                      : ''
              }`;

    el.innerHTML = `
        <div class="border border-slate-200 rounded-xl overflow-hidden">
            <div class="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between gap-2">
                <h4 class="text-sm font-black text-slate-800">${escapeHtml(data.date || '')} 리포트</h4>
                <span class="text-xs text-slate-500 truncate max-w-[12rem]" title="${escapeHtml(previewLine)}">${escapeHtml(previewLine)}</span>
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
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">AI 응답</dt>
                    <dd class="min-w-0">${responseBlock}</dd>
                    <dt class="text-xs font-bold text-slate-500 shrink-0 pt-0.5">분석 입력</dt>
                    <dd class="min-w-0">${renderInputMealsSection(data)}</dd>
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
        const tokenCompact = formatTokensCompact(data.tokensUsed);
        const tokenTitle = formatTokensDetail(data.tokensUsed);
        return `<tr class="border-b border-slate-100 cursor-pointer hover:bg-slate-50/90 ${active ? 'bg-emerald-50/80' : ''}" onclick="window.selectAiDietReport('${safeId}')" data-report-id="${escapeHtml(String(id))}">
            <td class="px-3 py-2.5 text-sm text-slate-700 tabular-nums whitespace-nowrap align-top leading-snug">${escapeHtml(data.date || '—')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-500 tabular-nums whitespace-nowrap align-top leading-snug">${escapeHtml(formatTimestamp(data.generatedAt))}</td>
            <td class="px-3 py-2.5 text-sm text-slate-800 min-w-[8rem] align-top break-all">${escapeHtml(data._email || data.userId || '—')}</td>
            <td class="px-3 py-2.5 text-sm text-slate-500 tabular-nums whitespace-nowrap align-top">${Number(data.photoCount) || 0}</td>
            <td class="px-3 py-2.5 text-xs text-slate-600 tabular-nums whitespace-nowrap align-top" title="${escapeHtml(tokenTitle)}">${escapeHtml(tokenCompact)}</td>
            <td class="px-3 py-2.5 align-top whitespace-nowrap">${statusBadge(data.status)} ${triggerBadge(data.trigger)} ${reportKindBadge(data)}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="overflow-x-auto border border-slate-200 rounded-xl">
            <table class="w-full text-left border-collapse min-w-[600px]">
                <thead>
                    <tr class="bg-slate-100 text-slate-700 text-xs font-black">
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">식단 날짜</th>
                        <th class="px-3 py-2.5 whitespace-nowrap font-bold">생성 시각</th>
                        <th class="px-3 py-2.5 font-bold">사용자</th>
                        <th class="px-3 py-2.5 font-bold">사진</th>
                        <th class="px-3 py-2.5 font-bold">토큰</th>
                        <th class="px-3 py-2.5 font-bold">상태</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>
        <p class="text-xs text-slate-400 mt-2">행을 클릭하면 오른쪽에 상세 내용이 표시됩니다. 토큰 열에 마우스를 올리면 입력·출력 상세를 볼 수 있습니다.</p>`;
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
        const statsEl = document.getElementById('aiDietReportsUsageStats');
        if (statsEl) {
            statsEl.innerHTML = '<div class="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-400"><i class="fa-solid fa-spinner fa-spin mr-1.5"></i>최근 7일 사용량 집계 중…</div>';
            statsEl.classList.remove('hidden');
        }
    }

    try {
        const coll = collection(db, 'artifacts', appId, 'aiDietReports');
        let q = query(coll, orderBy('generatedAt', 'desc'), limit(PAGE_SIZE));
        if (append && listLastDoc) {
            q = query(coll, orderBy('generatedAt', 'desc'), startAfter(listLastDoc), limit(PAGE_SIZE));
        }

        const statsPromise = append
            ? Promise.resolve(null)
            : fetchSevenDayUsageStats().catch((e) => {
                  console.error('aiDietReports 7d stats failed', e);
                  return null;
              });

        const [snap, stats] = await Promise.all([getDocs(q), statsPromise]);
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

        if (!append) {
            if (stats) {
                renderUsageStatsPanel(stats);
            } else {
                const statsEl = document.getElementById('aiDietReportsUsageStats');
                if (statsEl) {
                    statsEl.innerHTML = `
                        <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-500">
                            최근 7일 사용량을 불러오지 못했습니다.
                        </div>`;
                    statsEl.classList.remove('hidden');
                }
            }
        }

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
