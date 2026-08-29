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
    buildAxisBreakdown,
    shiftYmd,
    pct
} from './moment-analytics-model.js';
import { loadAdminTagLists } from './admin-tag-axes.js';

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
/** 그때의 meta — 태그 목록이 있어야 선택지 분포를 같은 순서로 내보낼 수 있다 */
let momentAnalyticsLastMeta = null;

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

/**
 * 이 화면의 본표 — 선택지 하나하나가 얼마나 골라졌고, 그 값이 어디서 왔나.
 *
 * 표 하나로 묶은 이유: 세 질문이 원래 한 줄에서 답해져야 하는 것들이라서다.
 *   1. 「태그 관리」의 구분이 유의미했나 — 아무도 안 고르는 칩이 보인다(건수 0)
 *   2. 「기타」가 여전히 큰가 — 다른 칩과 같은 줄에서 비교된다
 *   3. 시트 개편의 자동 항목이 입력을 늘렸나 — 「직접 / 자동」 두 열이 그 자리에서 가른다
 * 따로 그리면 축을 오갈 때마다 사람이 머릿속에서 표를 합쳐야 한다.
 *
 * 막대는 뺐다. 축마다 선택지가 10개 안팎이고 비율이 이미 옆 칸에 있어, 긴 막대는
 * 세로 공간만 늘리고 축 사이 비교를 오히려 방해했다.
 */
function renderAxisTable(breakdown) {
    const axisBlocks = breakdown
        .map((axis) => {
            const cell = (n, tone = 'text-slate-700') =>
                `<td class="px-3 py-1.5 text-right tabular-nums ${n ? tone : 'text-slate-300'}">${n.toLocaleString()}</td>`;

            const tagRows = axis.rows
                .map((r) => {
                    const dim = r.n === 0;
                    return `
                <tr class="border-b border-slate-100 ${dim ? 'bg-slate-50/40' : ''}">
                    <td class="px-3 py-1.5 pl-8 ${dim ? 'text-slate-400' : 'text-slate-700'} whitespace-nowrap">${escapeHtml(r.label)}${
                        dim ? '<span class="ml-2 text-[10px] font-bold text-slate-400">선택 없음</span>' : ''
                    }</td>
                    ${cell(r.n)}
                    <td class="px-3 py-1.5 text-right text-xs font-bold tabular-nums ${rateCellClass(r.rate)}">${fmtPct(r.rate)}</td>
                    ${cell(r.direct)}
                    ${cell(r.auto, 'text-sky-600')}
                </tr>`;
                })
                .join('');

            const sampleText = axis.outside.samples.map((s) => `${s.label} ${s.n.toLocaleString()}`).join(' · ');
            const outsideRow = `
                <tr class="border-b border-slate-100 bg-amber-50/40">
                    <td class="px-3 py-1.5 pl-8 text-slate-600 whitespace-nowrap">
                        목록 밖 값
                        <span class="ml-1 text-[10px] text-slate-400">${axis.outside.distinct.toLocaleString()}종</span>
                    </td>
                    ${cell(axis.outside.n, 'text-amber-700')}
                    <td class="px-3 py-1.5 text-right text-xs font-bold tabular-nums ${rateCellClass(axis.outside.rate)}">${fmtPct(axis.outside.rate)}</td>
                    <td class="px-3 py-1.5 text-right text-slate-300">-</td>
                    <td class="px-3 py-1.5 text-right text-slate-300">-</td>
                </tr>
                ${
                    sampleText
                        ? `<tr class="border-b border-slate-100 bg-amber-50/20">
                               <td colspan="5" class="px-3 py-1 pl-12 text-[11px] text-slate-500">많은 순: ${escapeHtml(sampleText)}${
                                   axis.outside.distinct > axis.outside.samples.length ? ' …' : ''
                               }</td>
                           </tr>`
                        : ''
                }`;

            const emptyRows = axis.emptyPaths
                ? axis.emptyPaths
                      .map(
                          (p) => `
                <tr class="border-b border-slate-100">
                    <td class="px-3 py-1.5 pl-12 text-slate-400 text-xs whitespace-nowrap">└ ${escapeHtml(p.label)}</td>
                    ${cell(p.n, 'text-slate-500')}
                    <td class="px-3 py-1.5 text-right text-xs tabular-nums text-slate-400">${fmtPct(p.rate)}</td>
                    <td class="px-3 py-1.5"></td>
                    <td class="px-3 py-1.5"></td>
                </tr>`
                      )
                      .join('')
                : '';

            const emptyRate = pct(axis.empty, axis.total);
            return `
            <tbody class="border-t-2 border-slate-300">
                <tr class="bg-slate-100/80">
                    <td class="px-3 py-2 font-black text-slate-800 whitespace-nowrap">
                        ${escapeHtml(axis.label)}
                        <span class="ml-2 text-[11px] font-normal text-slate-500">${escapeHtml(axis.note || '')}</span>
                        ${axis.tagListMissing ? '<span class="ml-2 text-[10px] font-bold text-red-600">태그 목록을 읽지 못함</span>' : ''}
                    </td>
                    <td class="px-3 py-2 text-right tabular-nums font-bold text-slate-700">${axis.filled.toLocaleString()}</td>
                    <td class="px-3 py-2 text-right text-xs font-black tabular-nums ${rateCellClass(axis.filledRate)}">${fmtPct(axis.filledRate)}</td>
                    <td class="px-3 py-2 text-right tabular-nums font-bold text-slate-700">${axis.direct.toLocaleString()}</td>
                    <td class="px-3 py-2 text-right tabular-nums font-bold text-sky-700">${axis.auto.toLocaleString()}${
                        // 건수 뒤에 곧바로 비율을 붙이면 「1」 + 「25.0%」 가 125.0% 로 읽힌다
                        axis.auto ? `<span class="ml-1.5 text-[10px] font-normal text-sky-500">(${fmtPct(axis.autoShare)})</span>` : ''
                    }</td>
                </tr>
                ${tagRows}
                ${outsideRow}
                <tr class="border-b border-slate-100 bg-slate-50/60">
                    <td class="px-3 py-1.5 pl-8 font-bold text-slate-500 whitespace-nowrap">미입력</td>
                    ${cell(axis.empty, 'text-slate-500')}
                    <td class="px-3 py-1.5 text-right text-xs font-bold tabular-nums text-slate-500">${fmtPct(emptyRate)}</td>
                    <td class="px-3 py-1.5 text-right text-slate-300">-</td>
                    <td class="px-3 py-1.5 text-right text-slate-300">-</td>
                </tr>
                ${emptyRows}
            </tbody>`;
        })
        .join('');

    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">
                선택지별 분포와 입력 경로
                <span class="text-xs font-normal text-slate-400">(관리자 &gt; 태그 관리의 목록 순서 그대로)</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase">축 · 선택지</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">건수</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">비율</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">직접</th>
                            <th class="px-3 py-2 text-right text-xs font-bold text-sky-700 uppercase">자동</th>
                        </tr>
                    </thead>
                    ${axisBlocks}
                </table>
            </div>
            <p class="mt-2 text-[11px] leading-relaxed text-slate-400">
                · <b>자동</b> = 사람이 고르지 않았는데 값이 남은 것. 「어떻게·어디서·누구와」는 맥락 예측이 자동 적용한 축(<code>autoContext</code>),
                「무엇을」은 로컬·서버 분류기가 채운 값(<code>categoryAuto</code>)입니다. 비율의 분모는 축마다 <b>전체 기록 수</b>입니다.<br>
                · <b>목록 밖 값</b>은 태그 목록에 없는 값입니다 — 목록을 바꾸기 전에 저장된 옛 어휘거나, 「어디서」처럼 자유 입력이 허용된 축입니다.
                「어디서」는 끼니가 가게 이름을 자유 입력하므로 목록 밖이 크게 나오는 것이 정상입니다.<br>
                · <b>건수 0</b>인 선택지는 기간 안에 아무도 고르지 않은 칩입니다 — 구분을 접거나 이름을 바꿀 후보입니다.<br>
                · 「무엇을」의 <b>자동</b>은 서버 AI 배치가 <b>나중에</b> 돌아 채웁니다. 최근 며칠은 아직 안 돌았을 수 있어 「서버 분류 대기」가 부풀어 보입니다.
            </p>
        </div>`;
}

/**
 * 항목별 입력률 — 선택지가 없는 항목(사진·코멘트·만족도…)까지 포함한 「채워졌나」 표.
 * 막대는 뺐다: 12줄짜리 막대가 화면을 채우는 데 비해, 정작 비교하고 싶은 것은 옆 칸의 숫자였다.
 */
function renderFieldTable(result) {
    const total = result.overall.total;
    const rows = MOMENT_FIELD_SPECS.map((spec) => {
        const filled = result.overall.counts[spec.key];
        const rate = pct(filled, total);
        const labelClass = spec.core ? 'font-bold text-slate-800' : 'text-slate-500';
        return `
            <tr class="border-b border-slate-100 ${spec.aux ? 'bg-slate-50/60' : ''}">
                <td class="px-3 py-1.5 ${labelClass} whitespace-nowrap">${escapeHtml(spec.label)}${
                    spec.gated ? '<span class="ml-1 text-[10px] text-amber-600 font-bold">설정</span>' : ''
                }</td>
                <td class="px-3 py-1.5 text-right tabular-nums text-slate-700">${filled.toLocaleString()}</td>
                <td class="px-3 py-1.5 text-right tabular-nums text-slate-400">${(total - filled).toLocaleString()}</td>
                <td class="px-3 py-1.5 text-right text-xs font-black tabular-nums ${rateCellClass(rate)}">${fmtPct(rate)}</td>
                <td class="px-3 py-1.5 text-[11px] text-slate-400 whitespace-nowrap hidden lg:table-cell">${escapeHtml(spec.note || '')}</td>
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
                            <th class="px-3 py-2 text-right text-xs font-bold text-slate-600 uppercase">입력률</th>
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase hidden lg:table-cell">비고</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

function renderTrendTable(result) {
    if (!result.trend.length) return '';
    // 최신 구간이 위로 오게 뒤집어 보여 준다
    const rows = [...result.trend].reverse();
    /**
     * 핵심 8열 + 「무엇을(최종)」 + 「자동적용」.
     * 자동적용은 맥락 예측이 한 축이라도 채운 기록의 비율이다 — 시트 개편이 입력을
     * 늘렸는지는 항목 입력률만으로는 답이 안 나온다. 입력률이 올라도 그게 사람이
     * 더 채운 것인지 기계가 메운 것인지 갈리지 않기 때문이다.
     */
    const trendSpecs = [...CORE_FIELD_SPECS, MOMENT_FIELD_SPECS.find((f) => f.key === 'whatFinal')].filter(Boolean);
    const head =
        trendSpecs
            .map(
                (f) =>
                    `<th class="px-2 py-2 text-center text-xs font-bold text-slate-600 whitespace-nowrap">${escapeHtml(
                        f.key === 'whatFinal' ? '무엇을(최종)' : f.label
                    )}</th>`
            )
            .join('') +
        '<th class="px-2 py-2 text-center text-xs font-bold text-sky-700 whitespace-nowrap border-l border-slate-200">자동적용</th>';
    const body = rows
        .map((b) => {
            const cells = trendSpecs
                .map((f) => {
                    const rate = pct(b.counts[f.key], b.total);
                    return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${rateCellClass(rate)}">${
                        b.total ? rate.toFixed(0) : '-'
                    }</td>`;
                })
                .join('');
            const autoRate = pct(b.counts.autoContext || 0, b.total);
            return `
                <tr class="border-b border-slate-100">
                    <td class="px-3 py-2 text-xs font-bold text-slate-700 whitespace-pre-line sticky left-0 bg-white">${escapeHtml(b.label)}</td>
                    <td class="px-3 py-2 text-right text-xs tabular-nums text-slate-500">${b.total.toLocaleString()}</td>
                    ${cells}
                    <td class="px-2 py-2 text-center text-xs font-bold tabular-nums text-sky-700 border-l border-slate-200">${
                        b.total ? autoRate.toFixed(0) : '-'
                    }</td>
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
            <p class="mt-2 text-[11px] text-slate-400">
                · <b>자동적용</b> = 맥락 예측이 어떻게·어디서·누구와 중 한 축이라도 자동으로 채운 기록의 비율.
                개편 전 기록에는 이 자국이 없어 0으로 나옵니다.
            </p>
        </div>`;
}

/** 완성도 분포 — 막대 대신 한 줄 표. 0~8을 가로로 늘어놓아야 분포 모양이 한눈에 들어온다 */
function renderCompletenessTable(result) {
    const total = result.overall.total;
    const head = result.completeness
        .map((_, i) => `<th class="px-2 py-2 text-center text-xs font-bold text-slate-600">${i}개</th>`)
        .join('');
    const counts = result.completeness
        .map((c) => `<td class="px-2 py-2 text-center text-xs tabular-nums text-slate-700">${c.toLocaleString()}</td>`)
        .join('');
    const rates = result.completeness
        .map((c) => {
            const rate = pct(c, total);
            return `<td class="px-2 py-2 text-center text-xs font-bold tabular-nums ${rateCellClass(rate)}">${fmtPct(rate)}</td>`;
        })
        .join('');
    return `
        <div class="mt-6">
            <h4 class="text-sm font-black text-slate-800 mb-2">
                기록 하나가 채운 항목 수 <span class="text-xs font-normal text-slate-400">(핵심 ${CORE_FIELD_SPECS.length}항목 중)</span>
            </h4>
            <div class="overflow-x-auto rounded-xl border border-slate-200">
                <table class="min-w-full text-sm">
                    <thead class="bg-slate-50">
                        <tr class="border-b border-slate-200">
                            <th class="px-3 py-2 text-left text-xs font-bold text-slate-600 uppercase whitespace-nowrap">채운 항목</th>
                            ${head}
                        </tr>
                    </thead>
                    <tbody>
                        <tr class="border-b border-slate-100">
                            <td class="px-3 py-2 text-xs font-bold text-slate-600 whitespace-nowrap">기록 수</td>
                            ${counts}
                        </tr>
                        <tr>
                            <td class="px-3 py-2 text-xs font-bold text-slate-600 whitespace-nowrap">비율</td>
                            ${rates}
                        </tr>
                    </tbody>
                </table>
            </div>
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
        ${renderAxisTable(buildAxisBreakdown(result, meta.tagLists || {}))}
        ${renderFieldTable(result)}
        ${renderTrendTable(result)}
        ${renderCompletenessTable(result)}
        <p class="mt-4 text-[11px] leading-relaxed text-slate-400">
            · 분모는 기간 안의 끼니·간식 기록입니다. 하루기록(소감)과 캡처 공유는 이 항목들을 갖지 않아 제외했습니다.<br>
            · <b>만족도·포만감</b>은 사용자가 설정에서 끌 수 있는 항목이라, 미입력에는 「꺼 둔 사용자」가 섞여 있습니다.<br>
            · 「항목별 입력률」의 <b>무엇을</b>은 사용자가 확정한 값만 셉니다 — 자동 분류는 이 필드를 건드리지 않습니다.
              자동까지 합친 값은 바로 아래 「무엇을(최종 분류 도달)」 행과, 위 본표의 「무엇을」 묶음에 있습니다.<br>
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
            momentAnalyticsLastMeta = hit.meta;
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
        /**
         * 본표의 행 순서는 「태그 관리」의 목록 순서다 — 관리자가 보는 화면과 같은 줄에
         * 같은 값이 오도록. 문서 1건 읽기이고, 실패해도 기본값을 돌려주므로 분석을 막지 않는다.
         */
        const { tags: tagLists, fromServer: tagListsFromServer } = await loadAdminTagLists();
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
        const meta = {
            readCount,
            skippedCount: readCount - targetRows.length,
            truncated,
            source,
            serverReads,
            tagLists,
            tagListsFromServer
        };
        momentAnalyticsLastResult = result;
        momentAnalyticsLastMeta = meta;
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

/** 결과를 엑셀(.xlsx)로 — 선택지 분포 + 항목별 + 무엇을 경로 + 추이 */
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
        row['자동적용'] = Number(pct(b.counts.autoContext || 0, b.total).toFixed(1));
        return row;
    });
    /** 화면 본표를 그대로 편 시트 — 축·선택지·건수·직접·자동 */
    const axisRows = [];
    buildAxisBreakdown(result, momentAnalyticsLastMeta?.tagLists || {}).forEach((axis) => {
        axis.rows.forEach((r) => {
            axisRows.push({
                축: axis.label,
                선택지: r.label,
                구분: '태그 목록',
                건수: r.n,
                비율: Number(r.rate.toFixed(1)),
                직접: r.direct,
                자동: r.auto
            });
        });
        axis.outside.samples.forEach((r) => {
            axisRows.push({
                축: axis.label,
                선택지: r.label,
                구분: '목록 밖',
                건수: r.n,
                비율: Number(pct(r.n, axis.total).toFixed(1)),
                직접: r.direct,
                자동: r.auto
            });
        });
        axisRows.push({
            축: axis.label,
            선택지: '(목록 밖 합계)',
            구분: '합계',
            건수: axis.outside.n,
            비율: Number(axis.outside.rate.toFixed(1)),
            직접: '',
            자동: ''
        });
        (axis.emptyPaths || []).forEach((e) => {
            axisRows.push({ 축: axis.label, 선택지: e.label, 구분: '미입력 분해', 건수: e.n, 비율: Number(e.rate.toFixed(1)), 직접: '', 자동: '' });
        });
        axisRows.push({
            축: axis.label,
            선택지: '(미입력)',
            구분: '합계',
            건수: axis.empty,
            비율: Number(pct(axis.empty, axis.total).toFixed(1)),
            직접: '',
            자동: ''
        });
    });
    const pathRows = FOOD_PATH_SPECS.map((spec) => ({
        경로: spec.label,
        건수: result.overall.counts[spec.key],
        비율: Number(pct(result.overall.counts[spec.key], total).toFixed(1))
    }));
    try {
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(axisRows), '선택지 분포');
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
