/**
 * 관리자 모니터링: 모먼트 분석 — 항목별 입력률
 *
 * 모먼트 「관리」가 개별 기록을 다룬다면, 여기서는 그 기록들이 **얼마나 채워지는지**만 본다.
 * 어떻게·어디서·무엇을·누구와·만족도·포만감·사진·코멘트가 각각 몇 %나 입력되는지,
 * 그리고 그 비율이 기간에 따라 어떻게 움직이는지가 이 화면의 전부다.
 *
 * 읽기 비용: 로컬 미러(meals-mirror.js)에서 집계한다 — 실행 시 미러 증분 동기화
 * (변경분만 Firestore 읽기)를 거친 뒤 IndexedDB에서 기간을 자른다. 탭 진입만으로는
 * 아무것도 조회하지 않고, 「분석 실행」을 눌렀을 때만 움직인다(다른 관리자 화면과 같은 규칙).
 * 미러가 실패하면 예전 방식(기간 내 meals 전량 서버 스캔)으로 물러난다.
 *
 * 계산은 moment-analytics-model.js가 한다 — 여기는 조회와 그리기만.
 */
import { db, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    startAfter,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { ensureMealsMirrorSynced, getMealsInRange } from './meals-mirror.js';
import { getExcludedAnalyticsUidSet } from '../excluded-analytics-uids.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
import { refreshLucideIcons } from '../icons.js';
import {
    MOMENT_FIELD_SPECS,
    CORE_FIELD_SPECS,
    FOOD_PATH_SPECS,
    analyzeMomentRows,
    shiftYmd,
    pct
} from './moment-analytics-model.js';

/** 한 번의 분석이 읽을 수 있는 meals 문서 상한 — 넘으면 기간을 좁히라고 알린다 */
const MOMENT_ANALYTICS_DOC_CAP = 20000;
/** Firestore 배치 크기 */
const MOMENT_ANALYTICS_BATCH = 1000;
/**
 * 같은 기간 재조회 방지 —— 이 화면의 한 번 실행은 기간 안의 meals 를 전부 읽는다.
 * 모먼트 관리 목록과는 쿼리가 달라 그쪽 캐시를 나눠 쓸 수 없으므로 여기서 따로 붙든다.
 * 만료 전이라도 「새로 읽기」로 언제든 다시 칠 수 있다.
 */
const MOMENT_ANALYTICS_CACHE_TTL_MS = 10 * 60 * 1000;
const momentAnalyticsCache = new Map();

/** 마지막 분석 결과 — 엑셀 내보내기용 */
let momentAnalyticsLastResult = null;

function kstTodayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

/** 프리셋 선택 → 날짜 입력칸 동기화(직접 지정일 때만 열어 둔다) */
function syncMomentAnalyticsRangeInputs() {
    const preset = document.getElementById('momentAnalyticsPreset')?.value || '30';
    const startEl = document.getElementById('momentAnalyticsStartDate');
    const endEl = document.getElementById('momentAnalyticsEndDate');
    const wrap = document.getElementById('momentAnalyticsCustomRange');
    if (!startEl || !endEl || !wrap) return;
    const custom = preset === 'custom';
    wrap.classList.toggle('opacity-50', !custom);
    wrap.classList.toggle('pointer-events-none', !custom);
    if (!custom) {
        const today = kstTodayYmd();
        endEl.value = today;
        startEl.value = shiftYmd(today, -(parseInt(preset, 10) - 1));
    }
}

function readMomentAnalyticsRange() {
    const preset = document.getElementById('momentAnalyticsPreset')?.value || '30';
    const today = kstTodayYmd();
    if (preset !== 'custom') {
        const span = parseInt(preset, 10);
        return { startYmd: shiftYmd(today, -(span - 1)), endYmd: today };
    }
    const startYmd = document.getElementById('momentAnalyticsStartDate')?.value || '';
    const endYmd = document.getElementById('momentAnalyticsEndDate')?.value || '';
    if (!startYmd || !endYmd) {
        alert('시작일과 종료일을 모두 선택하세요.');
        return null;
    }
    if (startYmd > endYmd) {
        alert('시작일이 종료일보다 늦을 수 없습니다.');
        return null;
    }
    return { startYmd, endYmd };
}

/**
 * 기간 안의 meals 를 가져온다 — 1차: 로컬 미러, 실패 시: 서버 전량 스캔.
 *
 * 축은 **슬롯 날짜(date)** 다 — 관리자 트렌드의 「기록한 날짜(recordedAt)」와는 일부러 다르다.
 * 입력률은 "언제 눌렀나"가 아니라 "어느 끼니 칸이 채워졌나"를 묻는 값이라서다.
 *
 * @returns {{rows: object[], truncated: boolean, source: 'mirror'|'server', serverReads: number}}
 */
async function loadRowsForRange(startYmd, endYmd, onProgress) {
    try {
        const sync = await ensureMealsMirrorSynced((p) => {
            if (typeof onProgress !== 'function') return;
            onProgress(
                p.stage === 'bootstrap'
                    ? `미러 첫 구축 중(최초 1회)… ${p.fetched.toLocaleString()}건 다운로드`
                    : `미러 동기화 중… 변경분 ${p.fetched.toLocaleString()}건`
            );
        });
        const rows = await getMealsInRange(startYmd, endYmd);
        return { rows, truncated: false, source: 'mirror', serverReads: sync.fetched + sync.removed };
    } catch (e) {
        console.warn('[모먼트 분석] 미러 실패 — 서버 전량 스캔으로 대체:', e);
        const { rows, truncated } = await fetchMealsInRange(startYmd, endYmd, (n) => {
            if (typeof onProgress === 'function') onProgress(`서버에서 읽는 중… ${n.toLocaleString()}건`);
        });
        return { rows, truncated, source: 'server', serverReads: rows.length };
    }
}

/** 예전 방식(폴백 전용): 기간 안의 meals 문서를 배치로 모두 읽는다. */
async function fetchMealsInRange(startYmd, endYmd, onProgress) {
    const rows = [];
    let cursor = null;
    let truncated = false;
    await refreshAppCheckTokenBeforeFirestore();
    for (;;) {
        const parts = [where('date', '>=', startYmd), where('date', '<=', endYmd), orderBy('date', 'desc')];
        const q = cursor
            ? query(collectionGroup(db, 'meals'), ...parts, startAfter(cursor), limit(MOMENT_ANALYTICS_BATCH))
            : query(collectionGroup(db, 'meals'), ...parts, limit(MOMENT_ANALYTICS_BATCH));
        const snap = await getDocs(q);
        if (snap.empty) break;
        snap.docs.forEach((d) => {
            const pathParts = d.ref.path.split('/');
            const uidx = pathParts.indexOf('users');
            const userId = uidx >= 0 && pathParts.length > uidx + 1 ? pathParts[uidx + 1] : '';
            rows.push({ id: d.id, userId, ...d.data() });
        });
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress(rows.length);
        if (snap.size < MOMENT_ANALYTICS_BATCH) break;
        if (rows.length >= MOMENT_ANALYTICS_DOC_CAP) {
            truncated = true;
            break;
        }
    }
    return { rows, truncated };
}

const fmtPct = (v) => `${v.toFixed(1)}%`;

/** 입력률에 따른 셀 배경 — 낮을수록 붉고 높을수록 푸르다 */
function rateCellClass(rate) {
    if (rate >= 90) return 'bg-emerald-100 text-emerald-800';
    if (rate >= 70) return 'bg-emerald-50 text-emerald-700';
    if (rate >= 40) return 'bg-amber-50 text-amber-700';
    if (rate > 0) return 'bg-red-50 text-red-600';
    return 'text-slate-300';
}

function renderSummaryCards(result, meta) {
    const cards = [
        { label: '분석 대상 기록', value: result.overall.total.toLocaleString(), sub: '끼니·간식 기록(하루기록 제외)' },
        { label: '참여 사용자', value: result.userCount.toLocaleString(), sub: '기간 내 1건 이상 기록' },
        {
            label: '평균 입력 완성도',
            value: fmtPct(result.avgCompleteness * 100),
            sub: `핵심 ${CORE_FIELD_SPECS.length}항목 기준`
        },
        {
            label: meta.source === 'mirror' ? 'Firestore 읽기' : '읽은 문서(서버 스캔)',
            value: (meta.source === 'mirror' ? meta.serverReads : meta.readCount).toLocaleString(),
            sub:
                meta.source === 'mirror'
                    ? `미러 집계 ${meta.readCount.toLocaleString()}건 · 제외 ${meta.skippedCount.toLocaleString()}건`
                    : `제외 ${meta.skippedCount.toLocaleString()}건(하루기록·통계제외 UID)`
        }
    ];
    return `
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
            ${cards
                .map(
                    (c) => `
                <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p class="text-xs font-bold text-slate-500">${escapeHtml(c.label)}</p>
                    <p class="text-2xl font-black text-slate-800 mt-1">${escapeHtml(c.value)}</p>
                    <p class="text-[11px] text-slate-400 mt-1">${escapeHtml(c.sub)}</p>
                </div>`
                )
                .join('')}
        </div>`;
}

function renderFieldTable(result) {
    const total = result.overall.total;
    const rows = MOMENT_FIELD_SPECS.map((spec) => {
        const filled = result.overall.counts[spec.key];
        const rate = pct(filled, total);
        const barColor = spec.aux
            ? 'bg-slate-300'
            : rate >= 70
                ? 'bg-emerald-500'
                : rate >= 40
                    ? 'bg-amber-400'
                    : 'bg-red-400';
        const labelClass = spec.core ? 'font-bold text-slate-800' : 'text-slate-500';
        return `
            <tr class="border-b border-slate-100 ${spec.aux ? 'bg-slate-50/60' : ''}">
                <td class="px-3 py-2 ${labelClass} whitespace-nowrap">${escapeHtml(spec.label)}${
                    spec.gated ? '<span class="ml-1 text-[10px] text-amber-600 font-bold">설정</span>' : ''
                }</td>
                <td class="px-3 py-2 text-right tabular-nums text-slate-700">${filled.toLocaleString()}</td>
                <td class="px-3 py-2 text-right tabular-nums text-slate-400">${(total - filled).toLocaleString()}</td>
                <td class="px-3 py-2 w-[40%] min-w-[10rem]">
                    <div class="flex items-center gap-2">
                        <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                            <div class="h-full ${barColor} rounded-full" style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></div>
                        </div>
                        <span class="text-xs font-bold tabular-nums text-slate-600 w-14 text-right">${fmtPct(rate)}</span>
                    </div>
                </td>
                <td class="px-3 py-2 text-[11px] text-slate-400 whitespace-nowrap hidden lg:table-cell">${escapeHtml(spec.note || '')}</td>
            </tr>`;
    }).join('');

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">항목별 입력률</h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">항목</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">입력</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">미입력</th>
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">입력률</th>
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase hidden lg:table-cell">비고</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

/**
 * 「무엇을」만 따로 뜯어 보는 표.
 *
 * 이 축은 값이 들어오는 길이 넷이라(직접 선택·로컬 분류기·서버 AI·아무도 못 메움)
 * 「무엇을 입력률」 한 줄로는 시트를 바꿨을 때 무엇이 움직였는지 답할 수 없다.
 * 사용자가 덜 고르게 된 것과 분류 자체가 안 되는 것은 손댈 곳이 전혀 다르다.
 */
function renderFoodPathTable(result) {
    const total = result.overall.total;
    const toneClass = {
        good: 'bg-emerald-500',
        weak: 'bg-emerald-300',
        auto: 'bg-sky-400',
        pending: 'bg-amber-400',
        bad: 'bg-red-400'
    };
    const rows = FOOD_PATH_SPECS.map((spec) => {
        const n = result.overall.counts[spec.key];
        const rate = pct(n, total);
        return `
            <tr class="border-b border-slate-100">
                <td class="px-3 py-2 text-slate-700 whitespace-nowrap">${escapeHtml(spec.label)}</td>
                <td class="px-3 py-2 text-right tabular-nums text-slate-700">${n.toLocaleString()}</td>
                <td class="px-3 py-2 w-[45%] min-w-[10rem]">
                    <div class="flex items-center gap-2">
                        <div class="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                            <div class="h-full ${toneClass[spec.tone] || 'bg-slate-400'} rounded-full" style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></div>
                        </div>
                        <span class="text-xs font-bold tabular-nums text-slate-600 w-14 text-right">${fmtPct(rate)}</span>
                    </div>
                </td>
            </tr>`;
    }).join('');

    const userRate = pct(result.overall.counts.pathUser + result.overall.counts.pathUserEtc, total);
    const finalRate = pct(result.overall.counts.whatFinal, total);

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">「무엇을」이 채워진 경로</h4>
            <div class="grid grid-cols-2 gap-3 mb-3">
                <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <p class="text-xs font-bold text-slate-500">사용자가 고른 비율</p>
                    <p class="text-2xl font-black text-slate-800 mt-1">${fmtPct(userRate)}</p>
                    <p class="text-[11px] text-slate-400 mt-1">시트 개편에 직접 반응하는 값</p>
                </div>
                <div class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                    <p class="text-xs font-bold text-emerald-700">최종 분류 도달률</p>
                    <p class="text-2xl font-black text-emerald-800 mt-1">${fmtPct(finalRate)}</p>
                    <p class="text-[11px] text-emerald-600 mt-1">자동 분류까지 합쳐 값이 남은 비율</p>
                </div>
            </div>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">경로</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">건수</th>
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">비율</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-slate-400">
                · 서버 AI 분류는 <b>배치로 나중에</b> 돕니다. 최근 며칠은 아직 안 돌았을 수 있어
                「서버 분류 대기」가 부풀고 「서버 AI가 채움」이 낮게 보입니다 — 추이 맨 오른쪽 구간은 그만큼 감해서 보세요.<br>
                · 「기타」는 서버가 미분류로 보고 다시 집는 값이라 직접 선택과 갈라 두었습니다.<br>
                · 「제안을 거부함」은 서버 backfill도 건너뛰어 영구히 빈 칸으로 남습니다.
            </p>
        </div>`;
}

function renderTrendTable(result) {
    if (!result.trend.length) return '';
    // 최신 구간이 위로 오게 뒤집어 보여 준다
    const rows = [...result.trend].reverse();
    /**
     * 핵심 8열 + 「무엇을(최종)」. 사용자가 고른 값만 담은 「무엇을」 옆에 자동 분류까지
     * 합친 열을 세워야, 떨어진 것이 입력인지 분류인지가 한 줄 안에서 갈린다.
     */
    const trendSpecs = [...CORE_FIELD_SPECS, MOMENT_FIELD_SPECS.find((f) => f.key === 'whatFinal')].filter(Boolean);
    const head = trendSpecs
        .map(
            (f) =>
                `<th class="px-2 py-2 text-center text-xs font-bold text-slate-600 whitespace-nowrap">${escapeHtml(
                    f.key === 'whatFinal' ? '무엇을(최종)' : f.label
                )}</th>`
        )
        .join('');
    const body = rows
        .map((b) => {
            const cells = trendSpecs.map((f) => {
                const rate = pct(b.counts[f.key], b.total);
                return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${rateCellClass(rate)}">${
                    b.total ? rate.toFixed(0) : '-'
                }</td>`;
            }).join('');
            return `
                <tr class="border-b border-slate-100">
                    <td class="px-3 py-2 text-xs font-bold text-slate-700 whitespace-pre-line sticky left-0 bg-white">${escapeHtml(b.label)}</td>
                    <td class="px-3 py-2 text-right text-xs tabular-nums text-slate-500">${b.total.toLocaleString()}</td>
                    ${cells}
                </tr>`;
        })
        .join('');

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">
                기간 추이 <span class="text-xs font-normal text-slate-400">(${result.byWeek ? '주별' : '일별'} · 단위 %)</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm border-separate border-spacing-0">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase sticky left-0 bg-slate-50">${
                                result.byWeek ? '주차' : '날짜'
                            }</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase whitespace-nowrap">기록</th>
                            ${head}
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        </div>`;
}

function renderCompletenessTable(result) {
    const total = result.overall.total;
    const max = Math.max(...result.completeness, 1);
    const bars = result.completeness
        .map((count, filledCount) => {
            const rate = pct(count, total);
            return `
                <div class="flex items-center gap-2">
                    <span class="w-14 shrink-0 text-xs font-bold text-slate-600 tabular-nums">${filledCount}개</span>
                    <div class="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
                        <div class="h-full bg-indigo-400 rounded" style="width:${((count / max) * 100).toFixed(1)}%"></div>
                    </div>
                    <span class="w-28 shrink-0 text-xs tabular-nums text-slate-500 text-right">${count.toLocaleString()}건 · ${fmtPct(rate)}</span>
                </div>`;
        })
        .join('');
    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">
                기록 하나가 채운 항목 수 <span class="text-xs font-normal text-slate-400">(핵심 ${CORE_FIELD_SPECS.length}항목 중)</span>
            </h4>
            <div class="rounded-xl border border-slate-200 p-4 space-y-1.5">${bars}</div>
        </div>`;
}

function renderMomentAnalyticsResult(result, meta) {
    const container = document.getElementById('momentAnalyticsContainer');
    if (!container) return;

    if (!result.overall.total) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-400">
                <i data-lucide="chart-column" class="text-2xl mb-2"></i>
                <p class="text-sm">${escapeHtml(result.startYmd)} ~ ${escapeHtml(result.endYmd)} 구간에 분석할 기록이 없습니다.</p>
            </div>`;
        refreshLucideIcons(container);
        return;
    }

    const warn = meta.truncated
        ? `<div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
               읽기 상한(${MOMENT_ANALYTICS_DOC_CAP.toLocaleString()}건)에 걸려 <b>가장 최근 날짜부터</b> 그만큼만 집계했습니다. 기간을 좁혀 다시 실행하세요.
           </div>`
        : '';

    // 캐시로 그린 화면은 「읽기 없이 다시 그린 것」임을 밝히고, 새로 읽을 길을 같이 준다
    const cachedNote = meta.fromCache
        ? `<span class="inline-flex items-center gap-2 text-xs text-slate-500">
               <span class="px-2 py-0.5 rounded-full bg-slate-100 font-bold">${Math.max(1, Math.round(meta.cacheAgeMs / 60000))}분 전 결과 · 읽기 없음</span>
               <button type="button" onclick="window.runMomentAnalytics(true)" class="underline hover:text-slate-700 font-bold">새로 읽기</button>
           </span>`
        : '';

    container.innerHTML = `
        ${warn}
        <div class="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-sm font-black text-slate-800">${escapeHtml(result.startYmd)} ~ ${escapeHtml(result.endYmd)}</span>
            <span class="text-xs text-slate-400">${result.spanDays}일 · 슬롯 날짜(date) 기준</span>
            ${cachedNote}
        </div>
        ${renderSummaryCards(result, meta)}
        ${renderFieldTable(result)}
        ${renderFoodPathTable(result)}
        ${renderTrendTable(result)}
        ${renderCompletenessTable(result)}
        <p class="mt-4 text-[11px] leading-relaxed text-slate-400">
            · 분모는 기간 안의 끼니·간식 기록입니다. 하루기록(소감)과 캡처 공유는 이 항목들을 갖지 않아 제외했습니다.<br>
            · <b>만족도·포만감</b>은 사용자가 설정에서 끌 수 있는 항목이라, 미입력에는 「꺼 둔 사용자」가 섞여 있습니다.<br>
            · <b>무엇을</b>은 사용자가 확정한 값만 셉니다 — 자동 분류는 이 필드를 건드리지 않습니다. 자동까지 합친 값은 아래 「채워진 경로」 표에 있습니다.<br>
            · 통계 제외 UID(대시보드 설정)의 기록은 빼고 셉니다.
        </p>`;
    refreshLucideIcons(container);
}

async function runMomentAnalytics(force = false) {
    const range = readMomentAnalyticsRange();
    if (!range) return;

    const cacheKey = `${range.startYmd}_${range.endYmd}`;
    if (!force) {
        const hit = momentAnalyticsCache.get(cacheKey);
        const age = hit ? Date.now() - hit.ts : Infinity;
        if (hit && age < MOMENT_ANALYTICS_CACHE_TTL_MS) {
            momentAnalyticsLastResult = hit.result;
            renderMomentAnalyticsResult(hit.result, { ...hit.meta, fromCache: true, cacheAgeMs: age });
            console.log(`[모먼트 분석] ${cacheKey}: 캐시 사용 — Firestore 읽기 없음`);
            return;
        }
    }

    const container = document.getElementById('momentAnalyticsContainer');
    if (container) {
        container.innerHTML =
            '<div class="text-center py-10 text-slate-400"><i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i><p class="text-sm" id="momentAnalyticsProgress">기록을 읽는 중…</p></div>';
        refreshLucideIcons(container);
    }

    try {
        const excluded = await getExcludedAnalyticsUidSet().catch(() => new Set());
        const { rows, truncated, source, serverReads } = await loadRowsForRange(range.startYmd, range.endYmd, (msg) => {
            const p = document.getElementById('momentAnalyticsProgress');
            if (p) p.textContent = msg;
        });

        const readCount = rows.length;
        const targetRows = rows.filter((m) => {
            if (excluded && excluded.has(m.userId)) return false;
            // 하루기록 미러는 이 항목들을 갖지 않는다 — 분모에 넣으면 입력률이 통째로 내려앉는다
            if (isDailyJournalMealRecord(m) || String(m.slotId || '') === 'daily_journal') return false;
            return true;
        });

        const result = analyzeMomentRows(targetRows, range.startYmd, range.endYmd);
        const meta = { readCount, skippedCount: readCount - targetRows.length, truncated, source, serverReads };
        momentAnalyticsLastResult = result;
        momentAnalyticsCache.set(cacheKey, { ts: Date.now(), result, meta });
        renderMomentAnalyticsResult(result, meta);
        console.log(
            `[모먼트 분석] ${range.startYmd}~${range.endYmd}: ${source === 'mirror' ? `미러 집계 (서버 읽기 ${serverReads}건)` : `서버 읽기 ${readCount}건`} → 대상 ${targetRows.length}건, 사용자 ${result.userCount}명`
        );
    } catch (e) {
        console.error('[모먼트 분석] 실패:', e);
        const hint =
            e?.code === 'failed-precondition'
                ? '<br><span class="text-xs">meals 컬렉션 그룹의 date 인덱스가 필요할 수 있습니다: <code>firebase deploy --only firestore:indexes</code></span>'
                : '';
        if (container) {
            container.innerHTML = `
                <div class="text-center py-10 text-red-500">
                    <i data-lucide="triangle-alert" class="text-2xl mb-2"></i>
                    <p class="text-sm">분석 중 오류가 발생했습니다: ${escapeHtml(e?.message || String(e))}${hint}</p>
                </div>`;
            refreshLucideIcons(container);
        }
    }
}

window.syncMomentAnalyticsRangeInputs = syncMomentAnalyticsRangeInputs;

window.runMomentAnalytics = function (force = false) {
    return runAdminRefreshAction('momentAnalyticsRunBtn', () => runMomentAnalytics(force === true), {
        loadingText: '분석 중…'
    });
};

/** 결과를 엑셀(.xlsx)로 — 항목별 시트 + 추이 시트 */
window.exportMomentAnalyticsToExcel = async function () {
    const result = momentAnalyticsLastResult;
    if (!result || !result.overall.total) {
        alert('먼저 「분석 실행」으로 결과를 만들어 주세요.');
        return;
    }
    const total = result.overall.total;
    const fieldRows = MOMENT_FIELD_SPECS.map((spec) => ({
        항목: spec.label.replace('└ ', ''),
        구분: spec.aux ? '참고' : spec.core ? '핵심' : '상세',
        입력: result.overall.counts[spec.key],
        미입력: total - result.overall.counts[spec.key],
        입력률: Number(pct(result.overall.counts[spec.key], total).toFixed(1))
    }));
    const trendRows = result.trend.map((b) => {
        const row = { 구간: String(b.label).replace('\n', ' '), 기록수: b.total };
        CORE_FIELD_SPECS.forEach((f) => {
            row[f.label] = Number(pct(b.counts[f.key], b.total).toFixed(1));
        });
        row['무엇을(최종)'] = Number(pct(b.counts.whatFinal, b.total).toFixed(1));
        return row;
    });
    const pathRows = FOOD_PATH_SPECS.map((spec) => ({
        경로: spec.label,
        건수: result.overall.counts[spec.key],
        비율: Number(pct(result.overall.counts[spec.key], total).toFixed(1))
    }));
    try {
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fieldRows), '항목별 입력률');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pathRows), '무엇을 경로');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trendRows), '기간 추이');
        XLSX.writeFile(wb, `mealog-moment-analytics-${result.startYmd}-${result.endYmd}.xlsx`);
    } catch (e) {
        console.error('[모먼트 분석] 엑셀 내보내기 실패:', e);
        alert('엑셀 내보내기에 실패했습니다: ' + (e?.message || e));
    }
};

if (typeof document !== 'undefined') {
    const boot = () => syncMomentAnalyticsRangeInputs();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}

export { runMomentAnalytics };
