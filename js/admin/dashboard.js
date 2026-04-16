// ADMIN 대시보드 통계 관련 함수들
import { db, appId } from '../firebase.js';
import {
    collection,
    collectionGroup,
    getDocs,
    query,
    orderBy,
    limit,
    doc,
    getDoc,
    setDoc,
    where,
    getCountFromServer,
    Timestamp,
    serverTimestamp,
    documentId
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
    getSharedPhotoGroupKey,
    dateKeyFromLocalDate,
    getLast7DateKeys,
    getTodayDateString,
    escapeHtml,
    runAdminRefreshAction,
    startOfSundayWeek,
    enumerateSundayWeeksInclusive,
    sundayKeyForDateKey,
    weekLabelKoreanFromSunday
} from './utils.js';
import { SLOTS } from '../constants.js';
import { getExcludedAnalyticsUidList, getExcludedAnalyticsUidSet } from '../excluded-analytics-uids.js';

/** 대시보드 주간 통계 시작일 (admin.js ADMIN_OPS_START 와 동일) */
const DASHBOARD_STATS_RANGE_START = new Date(2026, 2, 8);

/** usageDaily 문서 ID 하한 (YYYY-MM-DD, 운영 시작일과 맞춤) */
const USAGE_DAILY_MIN_ID = dateKeyFromLocalDate(DASHBOARD_STATS_RANGE_START) || '2026-03-08';

/** 관리자 「페이지별」표 행 정의 (usageDaily 필드명과 동일) */
export const PAGE_USAGE_METRIC_DEFS = [
    { field: 'tab_mealdang', section: '밀당', label: '탭 방문' },
    { field: 'mealdang_comment_click', section: '밀당', label: '코멘트 클릭' },
    { field: 'mealdang_analysis_detail_click', section: '밀당', label: '분석 상세 클릭' },
    { field: 'tab_moment', section: '모먼트', label: '탭 방문' },
    { field: 'tab_mealog', section: '밀로그', label: '탭 방문' },
    { field: 'lounge_mealtalk', section: '라운지', label: '밀톡' },
    { field: 'lounge_board', section: '라운지', label: '게시판' },
    { field: 'settings_profile', section: '사용자', label: '프로필' },
    { field: 'settings_tags', section: '사용자', label: '태그 관리' },
    { field: 'settings_mealdang_memo', section: '사용자', label: '밀당 메모' },
    { field: 'settings_push', section: '사용자', label: '푸시 알림' }
];

function zeroPageUsageTotals() {
    const o = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        o[def.field] = 0;
    }
    return o;
}

function addDocDataToPageTotals(data, into) {
    const d = data || {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        into[def.field] += Number(d[def.field]) || 0;
    }
}

/** 행 정의·레이아웃이 바뀌면 tbody를 다시 생성 */
let _pageUsageTableBuildKey = '';

function computePageUsageSectionRowspans() {
    const n = PAGE_USAGE_METRIC_DEFS.length;
    /** @type {number[]} rowspan > 0 = 첫 행에 출력, -1 = 구분 셀 생략(위 행 rowspan) */
    const spans = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const sec = PAGE_USAGE_METRIC_DEFS[i].section;
        if (i > 0 && PAGE_USAGE_METRIC_DEFS[i - 1].section === sec) {
            spans[i] = -1;
        } else {
            let c = 1;
            for (let j = i + 1; j < n && PAGE_USAGE_METRIC_DEFS[j].section === sec; j++) c++;
            spans[i] = c;
        }
    }
    return spans;
}

function ensurePageUsageTableBody() {
    const tb = document.getElementById('dashboardPageUsageTableBody');
    if (!tb) return;
    const n = PAGE_USAGE_METRIC_DEFS.length;
    const buildKey = `${n}-v4-stripe-bg`;
    if (_pageUsageTableBuildKey === buildKey && tb.querySelector('tr')) return;

    const rowSpans = computePageUsageSectionRowspans();
    const sectionCellClass =
        'px-2 py-2 text-sm sticky left-0 z-20 w-[4.5rem] min-w-[4.5rem] max-w-[4.5rem] box-border shadow-[4px_0_12px_-6px_rgba(0,0,0,0.1)] border-r border-slate-300 align-middle text-center';
    const labelCellClass =
        'px-2 py-2 text-xs font-semibold text-slate-700 sticky left-[4.5rem] z-20 w-[8rem] min-w-[8rem] max-w-[8rem] box-border shadow-[4px_0_12px_-6px_rgba(0,0,0,0.1)] border-r border-slate-300 align-middle leading-snug';

    tb.innerHTML = PAGE_USAGE_METRIC_DEFS.map((def, rowIdx) => {
        const cells = [];
        const rs = rowSpans[rowIdx];
        if (rs > 0) {
            const rowspanAttr = rs > 1 ? ` rowspan="${rs}"` : '';
            cells.push(
                `<td${rowspanAttr} class="${sectionCellClass}"><span class="block text-base font-black text-slate-800 leading-tight">${escapeHtml(def.section)}</span></td>`
            );
        }
        cells.push(
            `<td class="${labelCellClass}">${escapeHtml(def.label)}</td>`
        );
        cells.push(
            `<td class="px-2 py-2 text-center text-sm font-bold text-slate-800 sticky left-[12.5rem] z-20 min-w-[4rem] shadow-[4px_0_12px_-6px_rgba(0,0,0,0.1)] border-r border-slate-300 align-middle" id="pageUsageRow_${rowIdx}_all">—</td>`
        );
        cells.push(
            `<td data-page-dash-7block-start class="px-2 py-2 text-center text-sm font-bold text-slate-800 tabular-nums border-l border-slate-300" id="pageUsageRow_${rowIdx}_7Sum">—</td>`
        );
        for (let i = 0; i < 7; i++) {
            const border = i === 6 ? ' border-r border-slate-300' : '';
            cells.push(
                `<td class="px-1 py-2 text-center text-xs font-bold text-slate-800 tabular-nums${border}" id="pageUsageRow_${rowIdx}_7d${i}">—</td>`
            );
        }
        return `<tr class="group border-b border-slate-300">${cells.join('')}</tr>`;
    }).join('');
    _pageUsageTableBuildKey = buildKey;
}

function renderPageUsage7dHeaders(dates) {
    for (let i = 0; i < 7; i++) {
        const th = document.getElementById(`pageDashboard7dHead${i}`);
        if (!th) continue;
        if (dates && dates.length === 7 && dates[i]) {
            const parts = String(dates[i]).split('-');
            const m = parts[1] ? parseInt(parts[1], 10) : 0;
            const day = parts[2] ? parseInt(parts[2], 10) : 0;
            th.innerHTML = `<span class="block leading-tight text-xs">${m}/${day}</span>`;
            th.title = dates[i];
        } else {
            th.textContent = '—';
            th.removeAttribute('title');
        }
    }
}

function fillPageUsage7dRow(rowIdx, values, fallbackTotal) {
    const tip = (fallbackTotal != null && Number.isFinite(Number(fallbackTotal)))
        ? `7일 범위 합(캐시): ${Number(fallbackTotal).toLocaleString()} — 「새로고침」으로 일별`
        : '「새로고침」으로 일별 집계';
    for (let i = 0; i < 7; i++) {
        const el = document.getElementById(`pageUsageRow_${rowIdx}_7d${i}`);
        if (!el) continue;
        if (values && values.length === 7) {
            el.textContent = Number(values[i] || 0).toLocaleString();
            el.removeAttribute('title');
        } else {
            el.textContent = '—';
            el.title = tip;
        }
    }
}

export async function renderDashboardPageExcludedFooter() {
    const el = document.getElementById('dashboardPageUsageExcludedUidList');
    if (el) {
        const list = await getExcludedAnalyticsUidList();
        el.textContent = list.join(', ');
    }
}

export function renderDashboardPageUsage(pageUsage) {
    void renderDashboardPageExcludedFooter();
    ensurePageUsageTableBody();
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value != null ? Number(value).toLocaleString() : '—';
    };
    if (!pageUsage || !pageUsage.last7Breakdown || !pageUsage.last7Breakdown.dates) {
        renderPageUsage7dHeaders(null);
        PAGE_USAGE_METRIC_DEFS.forEach((_, rowIdx) => {
            set(`pageUsageRow_${rowIdx}_all`, null);
            set(`pageUsageRow_${rowIdx}_7Sum`, null);
            fillPageUsage7dRow(rowIdx, null, null);
        });
        return;
    }
    const dates = pageUsage.last7Breakdown.dates;
    const byField = pageUsage.last7Breakdown.byField || {};
    renderPageUsage7dHeaders(dates);
    PAGE_USAGE_METRIC_DEFS.forEach((def, rowIdx) => {
        const all = pageUsage.all?.[def.field];
        const last7 = pageUsage.last7Sum?.[def.field];
        const dayArr = byField[def.field];
        set(`pageUsageRow_${rowIdx}_all`, all);
        const sum7 = dayArr && dayArr.length === 7 ? dayArr.reduce((a, b) => a + (Number(b) || 0), 0) : null;
        set(`pageUsageRow_${rowIdx}_7Sum`, sum7 != null ? sum7 : last7);
        fillPageUsage7dRow(rowIdx, dayArr, last7);
    });
}

/**
 * 페이지별 집계 (트렌드와 동일하게 dashboardStats 캐시 + 증분으로 읽기 최소화)
 * - 화면 로드: 캐시 1회 getDoc만 사용 (updateStatistics)
 * - 새로고침: 최근 7일은 고정 7회 getDoc, 누적(all)은 이전 캐시가 있으면 신규 일자 usageDaily만 추가 조회
 */
export async function aggregatePageUsageFromFirestore(prevDashboardData) {
    const todayStr = getTodayDateString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const last7DateKeys = getLast7DateKeys(todayStart);

    const usageCol = collection(db, 'artifacts', appId, 'usageDaily');
    const todayRef = doc(db, 'artifacts', appId, 'usageDaily', todayStr);

    const last7Snaps = await Promise.all(
        last7DateKeys.map((k) => getDoc(doc(db, 'artifacts', appId, 'usageDaily', k)))
    );

    const byFieldDay = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        byFieldDay[def.field] = [0, 0, 0, 0, 0, 0, 0];
    }
    last7DateKeys.forEach((dk, i) => {
        const data = last7Snaps[i]?.exists() ? last7Snaps[i].data() : {};
        for (const def of PAGE_USAGE_METRIC_DEFS) {
            byFieldDay[def.field][i] = Number(data[def.field]) || 0;
        }
    });

    const last7Sum = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        last7Sum[def.field] = byFieldDay[def.field].reduce((a, b) => a + b, 0);
    }

    const prevPU = prevDashboardData?.pageUsage;
    const prevMerge =
        prevPU?.mergeThroughDate && typeof prevPU.mergeThroughDate === 'string' ? prevPU.mergeThroughDate : null;
    const prevAll = prevPU?.all && typeof prevPU.all === 'object' ? prevPU.all : null;

    let byFieldAll = zeroPageUsageTotals();
    let todayFieldSnap = zeroPageUsageTotals();

    if (!prevMerge || !prevAll) {
        const q = query(
            usageCol,
            where(documentId(), '>=', USAGE_DAILY_MIN_ID),
            where(documentId(), '<=', todayStr),
            orderBy(documentId())
        );
        const snap = await getDocs(q);
        snap.docs.forEach((d) => addDocDataToPageTotals(d.data(), byFieldAll));
        const tSnap = await getDoc(todayRef);
        addDocDataToPageTotals(tSnap.data(), todayFieldSnap);
    } else if (prevMerge === todayStr) {
        for (const def of PAGE_USAGE_METRIC_DEFS) {
            byFieldAll[def.field] = Number(prevAll[def.field]) || 0;
        }
        if (!prevPU.todayFieldSnap || typeof prevPU.todayFieldSnap !== 'object') {
            const q = query(
                usageCol,
                where(documentId(), '>=', USAGE_DAILY_MIN_ID),
                where(documentId(), '<=', todayStr),
                orderBy(documentId())
            );
            const snap = await getDocs(q);
            byFieldAll = zeroPageUsageTotals();
            snap.docs.forEach((d) => addDocDataToPageTotals(d.data(), byFieldAll));
            const tSnap = await getDoc(todayRef);
            todayFieldSnap = zeroPageUsageTotals();
            addDocDataToPageTotals(tSnap.data(), todayFieldSnap);
        } else {
            const newT = zeroPageUsageTotals();
            const tSnap = await getDoc(todayRef);
            addDocDataToPageTotals(tSnap.data(), newT);
            const oldT = prevPU.todayFieldSnap;
            for (const def of PAGE_USAGE_METRIC_DEFS) {
                const f = def.field;
                byFieldAll[f] = byFieldAll[f] - (Number(oldT[f]) || 0) + (Number(newT[f]) || 0);
            }
            todayFieldSnap = newT;
        }
    } else {
        for (const def of PAGE_USAGE_METRIC_DEFS) {
            byFieldAll[def.field] = Number(prevAll[def.field]) || 0;
        }
        const incQ = query(
            usageCol,
            where(documentId(), '>', prevMerge),
            where(documentId(), '<=', todayStr),
            orderBy(documentId())
        );
        const incSnap = await getDocs(incQ);
        incSnap.docs.forEach((d) => addDocDataToPageTotals(d.data(), byFieldAll));
        const tSnap = await getDoc(todayRef);
        addDocDataToPageTotals(tSnap.data(), todayFieldSnap);
    }

    return {
        last7Breakdown: { dates: last7DateKeys, byField: byFieldDay },
        all: byFieldAll,
        last7Sum,
        mergeThroughDate: todayStr,
        todayFieldSnap
    };
}

export function switchDashboardSubtab(which) {
    const trendPanel = document.getElementById('dashboard-panel-trend');
    const pagePanel = document.getElementById('dashboard-panel-page');
    const excludedPanel = document.getElementById('dashboard-panel-excluded');
    const btnTrend = document.getElementById('dashboard-subtab-trend');
    const btnPage = document.getElementById('dashboard-subtab-page');
    const btnExcluded = document.getElementById('dashboard-subtab-excluded');
    const active =
        'px-4 py-2 text-sm font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-xl whitespace-nowrap transition-colors shrink-0';
    const idle =
        'px-4 py-2 text-sm font-bold text-slate-500 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl whitespace-nowrap transition-colors shrink-0';
    const w = which === 'page' ? 'page' : which === 'excluded' ? 'excluded' : 'trend';
    if (trendPanel) trendPanel.classList.toggle('hidden', w !== 'trend');
    if (pagePanel) pagePanel.classList.toggle('hidden', w !== 'page');
    if (excludedPanel) excludedPanel.classList.toggle('hidden', w !== 'excluded');
    if (btnTrend) btnTrend.className = w === 'trend' ? active : idle;
    if (btnPage) btnPage.className = w === 'page' ? active : idle;
    if (btnExcluded) btnExcluded.className = w === 'excluded' ? active : idle;
    if (w === 'excluded') {
        import('./excluded-analytics-admin.js').then((m) => m.loadExcludedAnalyticsAdminPanel());
    }
}

const RECORD_SLOT_7D_PREFIXES = SLOTS.map((s) => `statRecSlot_${s.id}_7d`);
const RECORD_SLOT_7_SUM_IDS = SLOTS.map((s) => `statRecSlot_${s.id}_7Sum`);

const DASHBOARD_7D_ROW_PREFIXES = [
    'statNewUsers7d', 'statActiveUsers7d', 'statRecords7d',
    ...RECORD_SLOT_7D_PREFIXES,
    'statShared7d'
];

const DASHBOARD_7_SUM_IDS = [
    'statNewUsers7Sum', 'statActiveUsers7Sum', 'statRecords7Sum',
    ...RECORD_SLOT_7_SUM_IDS,
    'statShared7Sum'
];

/** 일별 7칸이 있으면 합계, 없으면 null */
function sumSevenDaily(values) {
    if (!values || values.length !== 7) return null;
    return values.reduce((a, b) => a + (Number(b) || 0), 0);
}

function getDashboard7dCellIds() {
    const ids = [...DASHBOARD_7_SUM_IDS];
    DASHBOARD_7D_ROW_PREFIXES.forEach((p) => {
        for (let i = 0; i < 7; i++) ids.push(`${p}${i}`);
    });
    return ids;
}

/** 최근 7일 날짜 헤더 (컬럼 7개, 과거 → 오늘) */
function renderDashboard7dHeaders(dates) {
    for (let i = 0; i < 7; i++) {
        const th = document.getElementById(`dashboard7dHead${i}`);
        if (!th) continue;
        if (dates && dates.length === 7 && dates[i]) {
            const parts = String(dates[i]).split('-');
            const m = parts[1] ? parseInt(parts[1], 10) : 0;
            const day = parts[2] ? parseInt(parts[2], 10) : 0;
            th.innerHTML = `<span class="block leading-tight text-xs">${m}/${day}</span>`;
            th.title = dates[i];
        } else {
            th.textContent = '—';
            th.removeAttribute('title');
        }
    }
}

/** 한 지표의 7개 컬럼 (baseId + 0..6) */
function fillDashboard7dNumericRow(baseId, values, fallbackTotal) {
    const tip = (fallbackTotal != null && Number.isFinite(Number(fallbackTotal)))
        ? `7일 범위 합(캐시): ${Number(fallbackTotal).toLocaleString()} — 「새로고침」으로 일별`
        : '「새로고침」으로 일별 집계';
    for (let i = 0; i < 7; i++) {
        const el = document.getElementById(`${baseId}${i}`);
        if (!el) continue;
        if (values && values.length === 7) {
            el.textContent = Number(values[i] || 0).toLocaleString();
            el.removeAttribute('title');
        } else {
            el.textContent = '—';
            el.title = tip;
        }
    }
}

/** Firestore 캐시의 last7Breakdown을 안전하게 복사 (길이 7 정규화) */
function cloneLast7Breakdown(raw) {
    if (!raw || !Array.isArray(raw.dates) || raw.dates.length !== 7) return null;
    const pick = (arr) => {
        const a = Array.isArray(arr) ? arr.map(v => Number(v) || 0) : [];
        while (a.length < 7) a.push(0);
        return a.slice(0, 7);
    };
    const rbs = raw.recordsBySlot && typeof raw.recordsBySlot === 'object' ? raw.recordsBySlot : {};
    const recordsBySlot = {};
    for (const s of SLOTS) {
        recordsBySlot[s.id] = pick(rbs[s.id]);
    }
    return {
        dates: [...raw.dates],
        newUsers: pick(raw.newUsers),
        activeUsers: pick(raw.activeUsers),
        records: pick(raw.records),
        recordsBySlot,
        sharedPhotos: pick(raw.sharedPhotos)
    };
}

function pickWeekArr(arr, n) {
    const a = Array.isArray(arr) ? arr.map((v) => Number(v) || 0) : [];
    while (a.length < n) a.push(0);
    return a.slice(0, n);
}

/** 캐시 weeklyBreakdown 정규화 (sundayKey로 월 헤더용 year/monthIndex 보강) */
function cloneWeeklyBreakdown(raw) {
    if (!raw || !Array.isArray(raw.weeks) || raw.weeks.length === 0) return null;
    const n = raw.weeks.length;
    const weeks = raw.weeks.map((w) => {
        const sk = String(w.sundayKey || '');
        const p = sk.split('-');
        const d =
            p.length === 3 ? new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)) : null;
        const label = d && !Number.isNaN(d.getTime()) ? weekLabelKoreanFromSunday(d) : String(w.label || '—');
        return {
            sundayKey: sk,
            label,
            year: d ? d.getFullYear() : 0,
            monthIndex: d ? d.getMonth() : 0
        };
    });
    const rbs = raw.recordsBySlot && typeof raw.recordsBySlot === 'object' ? raw.recordsBySlot : {};
    const recordsBySlot = {};
    for (const s of SLOTS) {
        recordsBySlot[s.id] = pickWeekArr(rbs[s.id], n);
    }
    return {
        weeks,
        monthGroups: buildMonthHeaderGroupsWithStarts(weeks),
        newUsers: pickWeekArr(raw.newUsers, n),
        activeUsers: pickWeekArr(raw.activeUsers, n),
        records: pickWeekArr(raw.records, n),
        recordsBySlot,
        sharedPhotos: pickWeekArr(raw.sharedPhotos, n)
    };
}

/** 월별 헤더: 같은 달(일요일 기준)에 속한 연속 주차 구간 + 해당 구간 시작 week 인덱스 */
function buildMonthHeaderGroupsWithStarts(weeks) {
    const groups = [];
    let i = 0;
    while (i < weeks.length) {
        const y = weeks[i].year;
        const m = weeks[i].monthIndex;
        const startWeekIndex = i;
        let span = 0;
        while (i < weeks.length && weeks[i].year === y && weeks[i].monthIndex === m) {
            span++;
            i++;
        }
        groups.push({ span, startWeekIndex, label: `${m + 1}월` });
    }
    return groups;
}

/** 주차별 값 배열 → [월합, w0, w1, …] 순으로 펼침 (월합은 해당 월에 속한 주 값의 합) */
function expandWeeklyValuesWithMonthSums(vals, monthGroups) {
    const v = Array.isArray(vals) ? vals.map((x) => Number(x) || 0) : [];
    const out = [];
    for (const g of monthGroups) {
        let sum = 0;
        for (let k = 0; k < g.span; k++) {
            sum += v[g.startWeekIndex + k] || 0;
        }
        out.push(sum);
        for (let k = 0; k < g.span; k++) {
            out.push(v[g.startWeekIndex + k] || 0);
        }
    }
    return out;
}

function clearAdminDashboardWeekInjections() {
    document.querySelectorAll('.js-dash-month-th, .js-dash-week-th, .js-dash-week-td').forEach((el) => el.remove());
}

/**
 * 주간 헤더·본문 셀 삽입 (항목·전체 열은 고정, 주차·최근7일은 가로 스크롤)
 */
function syncAdminDashboardWeekLayout(weeklyBreakdown) {
    clearAdminDashboardWeekInjections();
    const row1 = document.getElementById('dashboardHeadRow1');
    const row2 = document.getElementById('dashboardHeadRow2');
    const head7d = document.getElementById('dashboardHead7dTop');
    const sumHead = document.getElementById('dashboard7dSumHead');
    if (!row1 || !row2 || !head7d || !sumHead) return;

    const weeks = weeklyBreakdown?.weeks;
    const monthGroups = weeklyBreakdown?.monthGroups || (weeks?.length ? buildMonthHeaderGroupsWithStarts(weeks) : []);
    if (!weeks || weeks.length === 0) return;

    for (const g of monthGroups) {
        const th = document.createElement('th');
        th.className =
            'js-dash-month-th px-2 py-1.5 font-black text-slate-700 uppercase text-center text-xs tracking-wide border-b border-slate-200 bg-slate-50';
        th.colSpan = g.span + 1;
        th.textContent = g.label;
        row1.insertBefore(th, head7d);
    }

    for (const g of monthGroups) {
        const sumTh = document.createElement('th');
        sumTh.className =
            'js-dash-week-th px-0.5 py-1 text-center font-bold text-slate-600 min-w-[2.75rem] max-w-[3.25rem] text-[9px] leading-tight border-b border-slate-200 bg-slate-100';
        sumTh.textContent = '합계';
        sumTh.title = `${g.label} 주간 합계(같은 달에 속한 주차 수치의 합)`;
        row2.insertBefore(sumTh, sumHead);
        for (let j = 0; j < g.span; j++) {
            const w = weeks[g.startWeekIndex + j];
            const th = document.createElement('th');
            th.className =
                'js-dash-week-th px-1 py-1 text-center font-bold text-slate-600 min-w-[3.5rem] max-w-[5.5rem] text-[10px] leading-tight border-b border-slate-200 bg-slate-50/90 whitespace-pre-line';
            th.textContent = w?.label || '—';
            th.title = w?.sundayKey || '';
            row2.insertBefore(th, sumHead);
        }
    }

    document.querySelectorAll('tr[data-dash-week-row]').forEach((tr) => {
        for (const g of monthGroups) {
            const slotLike = tr.getAttribute('data-dash-slot-row') === '1';
            const baseCls = slotLike
                ? 'js-dash-week-td px-1 py-2 text-center text-xs font-bold text-slate-800 tabular-nums'
                : 'js-dash-week-td px-2 py-2 text-center text-sm font-bold text-slate-800 tabular-nums';
            const sumTd = document.createElement('td');
            sumTd.className = `${baseCls} bg-slate-50/80`;
            tr.insertBefore(sumTd, tr.querySelector('[data-dash-7block-start]'));
            for (let j = 0; j < g.span; j++) {
                const td = document.createElement('td');
                td.className = baseCls;
                tr.insertBefore(td, tr.querySelector('[data-dash-7block-start]'));
            }
        }
    });
}

function weeklyValuesForRow(key, weeklyBreakdown) {
    if (!weeklyBreakdown) return [];
    if (key === 'newUsers') return weeklyBreakdown.newUsers || [];
    if (key === 'activeUsers') return weeklyBreakdown.activeUsers || [];
    if (key === 'sharedPhotos') return weeklyBreakdown.sharedPhotos || [];
    if (key === 'records') return weeklyBreakdown.records || [];
    if (key.startsWith('slot:')) {
        const id = key.slice(5);
        return weeklyBreakdown.recordsBySlot?.[id] || [];
    }
    return [];
}

function fillAdminDashboardWeeklyCells(weeklyBreakdown) {
    const monthGroups = weeklyBreakdown?.monthGroups;
    document.querySelectorAll('tr[data-dash-week-row]').forEach((tr) => {
        const key = tr.getAttribute('data-dash-week-row');
        const vals = weeklyValuesForRow(key, weeklyBreakdown);
        const expanded =
            monthGroups && monthGroups.length ? expandWeeklyValuesWithMonthSums(vals, monthGroups) : vals;
        const tds = tr.querySelectorAll(':scope > td.js-dash-week-td');
        tds.forEach((td, i) => {
            const v = expanded[i];
            if (v != null && Number.isFinite(Number(v))) {
                td.textContent = Number(v).toLocaleString();
                td.removeAttribute('title');
            } else {
                td.textContent = '—';
                td.title = '「새로고침」으로 주간 집계';
            }
        });
    });
}

// 대시보드 통계 캐시 문서 (adminSettings 사용 — Firestore 규칙에서 관리자 쓰기 허용됨)
const DASHBOARD_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats');

/**
 * 컬렉션 그룹 `slotId` 인덱스가 없을 때(aggregation failed-precondition):
 * 각 사용자 `users/{uid}/meals`에서 슬롯별 count를 더해 전체 건수 산출 (새로고침 1회당 읽기 다량).
 */
async function countMealsSlotAllViaUserSubcollections(userIds, countQFn) {
    const totals = SLOTS.map(() => 0);
    const UID_BATCH = 8;
    for (let i = 0; i < userIds.length; i += UID_BATCH) {
        const chunk = userIds.slice(i, i + UID_BATCH);
        const perUserArrays = await Promise.all(
            chunk.map(async (uid) => {
                const mc = collection(db, 'artifacts', appId, 'users', uid, 'meals');
                const counts = await Promise.all(
                    SLOTS.map(async (s) => {
                        try {
                            return await countQFn(query(mc, where('slotId', '==', s.id)));
                        } catch {
                            return 0;
                        }
                    })
                );
                return counts;
            })
        );
        perUserArrays.forEach((arr) => {
            arr.forEach((n, si) => {
                totals[si] += n;
            });
        });
    }
    return totals;
}

/** meals 문서 ref → users/{uid}/meals 경로에서 uid 추출 */
function userIdFromMealDocRef(ref) {
    const parts = ref.path.split('/');
    const i = parts.indexOf('users');
    return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

function addLocalDays(date, delta) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + delta);
    return d;
}

/**
 * 관리자 「새로고침」 전용 집계.
 * collectionGroup·getCountFromServer·운영 시작일(일요일 주차) 이후 meals getDocs + 슬롯별 전체는 slotId당 count.
 * 공유: 동일 기간 sharedPhotos 스캔 후 게시물 키로 일별·주별 집계.
 */
function weekIndexForDateKeyStr(dateKeyStr, sundayKeyToIndex) {
    const sk = sundayKeyForDateKey(dateKeyStr);
    return sk && sundayKeyToIndex.has(sk) ? sundayKeyToIndex.get(sk) : -1;
}

export async function getUserStatistics() {
    try {
        const excluded = await getExcludedAnalyticsUidSet();
        const usersColl = collection(db, 'artifacts', appId, 'users');
        const usersSnapshot = await getDocs(usersColl);
        const usersFromCollection = usersSnapshot.docs.filter((d) => !excluded.has(d.id)).length;

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const last7FirstDay = new Date(todayStart);
        last7FirstDay.setDate(last7FirstDay.getDate() - 6);

        const weekMetas = enumerateSundayWeeksInclusive(DASHBOARD_STATS_RANGE_START, todayStart);
        const nWeeks = weekMetas.length;
        const sundayKeyToIndex = new Map(weekMetas.map((w, i) => [w.sundayKey, i]));
        const firstSundayKey = nWeeks > 0 ? weekMetas[0].sundayKey : dateKeyFromLocalDate(todayStart);

        const last7DateKeys = getLast7DateKeys(todayStart);
        const last7IndexMap = new Map(last7DateKeys.map((k, i) => [k, i]));
        const last7DayIndex = (dateOnly) => {
            const k = dateKeyFromLocalDate(dateOnly);
            return k != null && last7IndexMap.has(k) ? last7IndexMap.get(k) : -1;
        };

        const todayStr = dateKeyFromLocalDate(todayStart);
        const last7FirstStr = dateKeyFromLocalDate(last7FirstDay);
        const tomorrowStart = addLocalDays(todayStart, 1);

        const z7 = () => [0, 0, 0, 0, 0, 0, 0];
        const zW = () => Array.from({ length: nWeeks }, () => 0);
        const newUsersByDay = z7();
        const recordsByDay = z7();
        const activeSetsByDay = Array.from({ length: 7 }, () => new Set());
        const sharedByDayCounts = z7();

        const newUsersByWeek = zW();
        const recordsByWeek = zW();
        const activeSetsByWeek = Array.from({ length: nWeeks }, () => new Set());
        const sharedSetsByWeek = Array.from({ length: nWeeks }, () => new Set());

        const inPeriod = (dateOnly, period) => {
            if (!dateOnly) return false;
            if (period === 'today') return dateOnly.getTime() >= todayStart.getTime();
            if (period === 'last7') return dateOnly.getTime() >= last7FirstDay.getTime();
            return false;
        };

        const emptySlotAgg = () => ({
            last7: 0,
            today: 0,
            byDay: z7(),
            byWeek: zW()
        });
        const slotAgg = {};
        for (const s of SLOTS) slotAgg[s.id] = emptySlotAgg();

        const stats = {
            newUsers: { all: 0, last7: 0, today: 0 },
            activeUsers: { all: 0, last7: 0, today: 0 },
            records: { all: 0, last7: 0, today: 0 },
            recordsBySlot: {},
            sharedPhotos: { all: 0, last7: 0, today: 0 },
            totalUsers: 0,
            totalMeals: 0,
            totalSharedPhotos: 0,
            recentActivity: { last7Days: 0 }
        };

        const activeUserSets = { all: new Set(), last7: new Set(), today: new Set() };

        const mealsCg = collectionGroup(db, 'meals');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const countQ = async (q) => (await getCountFromServer(q)).data().count ?? 0;

        const emptyMealsSnap = { forEach() {} };
        const [recordsAllCountRaw, mealsRangeSnap] = await Promise.all([
            countQ(query(mealsCg)),
            nWeeks > 0
                ? getDocs(query(mealsCg, where('date', '>=', firstSundayKey), where('date', '<=', todayStr)))
                : Promise.resolve(emptyMealsSnap)
        ]);
        let recordsAllCount = recordsAllCountRaw;

        const userIdsForSlots = usersSnapshot.docs.map((d) => d.id).filter((uid) => !excluded.has(uid));
        let slotAllArr;
        try {
            slotAllArr = await Promise.all(
                SLOTS.map((s) => countQ(query(mealsCg, where('slotId', '==', s.id))))
            );
        } catch (e) {
            if (e?.code === 'failed-precondition') {
                console.warn(
                    '⚠️ meals 컬렉션 그룹(slotId) 인덱스가 아직 없습니다. 사용자별 meals로 슬롯「전체」건수를 집계합니다. 배포: firebase deploy --only firestore:indexes',
                    e.message || e
                );
                slotAllArr = await countMealsSlotAllViaUserSubcollections(userIdsForSlots, countQ);
            } else {
                throw e;
            }
        }

        for (const exUid of excluded) {
            const mcEx = collection(db, 'artifacts', appId, 'users', exUid, 'meals');
            recordsAllCount -= await countQ(query(mcEx));
            for (let si = 0; si < SLOTS.length; si++) {
                slotAllArr[si] -= await countQ(query(mcEx, where('slotId', '==', SLOTS[si].id)));
            }
        }

        stats.records.all = recordsAllCount;
        let recordsToday = 0;
        let recordsLast7 = 0;

        mealsRangeSnap.forEach((docSnap) => {
            const mealData = docSnap.data();
            const dateStr = mealData.date;
            const uid = userIdFromMealDocRef(docSnap.ref);
            if (!dateStr || typeof dateStr !== 'string' || !uid) return;
            if (excluded.has(uid)) return;

            const wi = weekIndexForDateKeyStr(dateStr, sundayKeyToIndex);
            if (wi >= 0) {
                recordsByWeek[wi]++;
                activeSetsByWeek[wi].add(uid);
            }

            if (dateStr === todayStr) {
                recordsToday++;
                activeUserSets.today.add(uid);
            }
            if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                recordsLast7++;
                const rdi = last7IndexMap.get(dateStr);
                if (rdi != null && rdi >= 0) {
                    recordsByDay[rdi]++;
                    activeSetsByDay[rdi].add(uid);
                }
                activeUserSets.last7.add(uid);
            }

            const sid = mealData.slotId;
            if (sid && slotAgg[sid]) {
                if (wi >= 0) slotAgg[sid].byWeek[wi]++;
                if (dateStr === todayStr) slotAgg[sid].today++;
                if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                    slotAgg[sid].last7++;
                    const sdi = last7IndexMap.get(dateStr);
                    if (sdi != null && sdi >= 0) slotAgg[sid].byDay[sdi]++;
                }
            }
        });

        stats.records.today = recordsToday;
        stats.records.last7 = recordsLast7;

        SLOTS.forEach((s, i) => {
            const a = slotAgg[s.id];
            stats.recordsBySlot[s.id] = {
                all: slotAllArr[i] ?? 0,
                last7: a.last7,
                today: a.today
            };
        });

        const userIds = userIdsForSlots;
        const UID_BATCH = 30;
        for (let i = 0; i < userIds.length; i += UID_BATCH) {
            const chunk = userIds.slice(i, i + UID_BATCH);
            await Promise.all(
                chunk.map(async (uid) => {
                    try {
                        const mc = collection(db, 'artifacts', appId, 'users', uid, 'meals');
                        const n = await countQ(query(mc));
                        if (n > 0) activeUserSets.all.add(uid);
                    } catch (_) {}
                })
            );
        }

        usersSnapshot.docs.forEach((userDoc) => {
            if (excluded.has(userDoc.id)) return;
            const userData = userDoc.data();
            let createdAt = null;
            if (userData.createdAt) {
                createdAt = userData.createdAt.toDate ? userData.createdAt.toDate() : new Date(userData.createdAt);
            }
            if (createdAt) {
                const createdDateOnly = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate());
                stats.newUsers.all++;
                if (inPeriod(createdDateOnly, 'today')) stats.newUsers.today++;
                if (inPeriod(createdDateOnly, 'last7')) stats.newUsers.last7++;
                const ndi = last7DayIndex(createdDateOnly);
                if (ndi >= 0) newUsersByDay[ndi]++;
                const ck = dateKeyFromLocalDate(createdDateOnly);
                const wi = ck ? weekIndexForDateKeyStr(ck, sundayKeyToIndex) : -1;
                if (wi >= 0) newUsersByWeek[wi]++;
            }
        });
        stats.totalUsers = Math.max(usersFromCollection, stats.newUsers.all);

        try {
            let sharedAll = await countQ(query(sharedColl));
            for (const exUid of excluded) {
                sharedAll -= await countQ(query(sharedColl, where('userId', '==', exUid)));
            }
            stats.sharedPhotos.all = sharedAll;
            stats.totalSharedPhotos = stats.sharedPhotos.all;

            const tsEnd = Timestamp.fromDate(tomorrowStart);
            const tToday0 = todayStart.getTime();
            const tLast7 = last7FirstDay.getTime();
            const tTomorrow = tomorrowStart.getTime();

            const keysToday = new Set();
            const keysLast7 = new Set();
            const keysByDay7 = Array.from({ length: 7 }, () => new Set());

            const firstSunParts = firstSundayKey.split('-');
            const firstSunDate =
                firstSunParts.length === 3
                    ? new Date(
                          parseInt(firstSunParts[0], 10),
                          parseInt(firstSunParts[1], 10) - 1,
                          parseInt(firstSunParts[2], 10)
                      )
                    : startOfSundayWeek(DASHBOARD_STATS_RANGE_START);
            firstSunDate.setHours(0, 0, 0, 0);
            const tsRangeLo = Timestamp.fromDate(firstSunDate);

            const sharedRangeSnap = await getDocs(
                query(sharedColl, where('timestamp', '>=', tsRangeLo), where('timestamp', '<', tsEnd))
            );
            sharedRangeSnap.forEach((docSnap) => {
                const data = docSnap.data();
                if (excluded.has(String(data.userId || ''))) return;
                const rawTs = data.timestamp;
                const ts = rawTs && rawTs.toDate ? rawTs.toDate() : null;
                if (!ts || Number.isNaN(ts.getTime())) return;
                const t = ts.getTime();
                const gk = getSharedPhotoGroupKey(data);
                const dk = dateKeyFromLocalDate(new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()));
                const widx = dk ? weekIndexForDateKeyStr(dk, sundayKeyToIndex) : -1;
                if (widx >= 0) sharedSetsByWeek[widx].add(gk);
                if (t >= tLast7 && t < tTomorrow) {
                    keysLast7.add(gk);
                    const idx = dk != null ? last7IndexMap.get(dk) : -1;
                    if (idx != null && idx >= 0) keysByDay7[idx].add(gk);
                }
                if (t >= tToday0 && t < tTomorrow) keysToday.add(gk);
            });

            stats.sharedPhotos.today = keysToday.size;
            stats.sharedPhotos.last7 = keysLast7.size;
            for (let di = 0; di < 7; di++) {
                sharedByDayCounts[di] = keysByDay7[di].size;
            }
        } catch (se) {
            console.warn('⚠️ sharedPhotos 집계 실패:', se?.message || se);
        }

        stats.recentActivity.last7Days = stats.sharedPhotos.last7;

        stats.activeUsers.all = activeUserSets.all.size;
        stats.activeUsers.last7 = activeUserSets.last7.size;
        stats.activeUsers.today = activeUserSets.today.size;
        stats.totalMeals = stats.records.all;

        const recordsBySlotBreakdown = {};
        for (const s of SLOTS) {
            recordsBySlotBreakdown[s.id] = [...slotAgg[s.id].byDay];
        }
        stats.last7Breakdown = {
            dates: last7DateKeys,
            newUsers: [...newUsersByDay],
            activeUsers: activeSetsByDay.map((s) => s.size),
            records: [...recordsByDay],
            recordsBySlot: recordsBySlotBreakdown,
            sharedPhotos: [...sharedByDayCounts]
        };

        stats.weeklyBreakdown =
            nWeeks > 0
                ? {
                      weeks: weekMetas.map((w) => ({
                          sundayKey: w.sundayKey,
                          label: w.label,
                          year: w.year,
                          monthIndex: w.monthIndex
                      })),
                      newUsers: [...newUsersByWeek],
                      activeUsers: activeSetsByWeek.map((s) => s.size),
                      records: [...recordsByWeek],
                      recordsBySlot: Object.fromEntries(SLOTS.map((s) => [s.id, [...slotAgg[s.id].byWeek]])),
                      sharedPhotos: sharedSetsByWeek.map((s) => s.size)
                  }
                : null;

        console.log('📊 대시보드 통계(최적화 집계):', stats);
        return stats;
    } catch (e) {
        console.error("❌ Get user statistics error:", e);
        console.error("오류 코드:", e.code);
        console.error("오류 메시지:", e.message);
        throw e;
    }
}

// 공유 게시물 조회 (최신순)
export async function getSharedPhotos(pageSize = 100) {
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const q = query(sharedColl, orderBy('timestamp', 'desc'), limit(pageSize));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (e) {
        console.error("Get shared photos error:", e);
        throw e;
    }
}

/** 통계 객체를 화면에 반영 + 마지막 업데이트 문구 */
export function renderDashboardStats(stats, updatedAt, last7BreakdownOverride = null) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value != null ? Number(value).toLocaleString() : '-';
    };
    const bdRaw = last7BreakdownOverride != null ? last7BreakdownOverride : stats?.last7Breakdown;
    const bd = bdRaw && bdRaw.dates?.length === 7 ? bdRaw : null;

    clearAdminDashboardWeekInjections();
    const wb = stats?.weeklyBreakdown ? cloneWeeklyBreakdown(stats.weeklyBreakdown) : null;
    if (wb) {
        syncAdminDashboardWeekLayout(wb);
        fillAdminDashboardWeeklyCells(wb);
    }

    if (stats) {
        set('statNewUsersAll', stats.newUsers?.all);
        set('statActiveUsersAll', stats.activeUsers?.all);
        set('statRecordsAll', stats.records?.all);
        set('statSharedAll', stats.sharedPhotos?.all);

        renderDashboard7dHeaders(bd?.dates);
        fillDashboard7dNumericRow('statNewUsers7d', bd?.newUsers, stats.newUsers?.last7);
        fillDashboard7dNumericRow('statActiveUsers7d', bd?.activeUsers, stats.activeUsers?.last7);
        fillDashboard7dNumericRow('statRecords7d', bd?.records, stats.records?.last7);
        fillDashboard7dNumericRow('statShared7d', bd?.sharedPhotos, stats.sharedPhotos?.last7);

        set('statNewUsers7Sum', sumSevenDaily(bd?.newUsers) ?? stats.newUsers?.last7);
        set('statActiveUsers7Sum', stats.activeUsers?.last7);
        set('statRecords7Sum', sumSevenDaily(bd?.records) ?? stats.records?.last7);
        set('statShared7Sum', sumSevenDaily(bd?.sharedPhotos) ?? stats.sharedPhotos?.last7);

        SLOTS.forEach((s) => {
            const d = stats.recordsBySlot?.[s.id] || { all: 0, last7: 0, today: 0 };
            set(`statRecSlot_${s.id}_all`, d.all);
            const bdSlot = bd?.recordsBySlot?.[s.id];
            fillDashboard7dNumericRow(`statRecSlot_${s.id}_7d`, bdSlot, d.last7);
            set(`statRecSlot_${s.id}_7Sum`, sumSevenDaily(bdSlot) ?? d.last7);
        });
    } else {
        const recordSlotAll = SLOTS.map((s) => `statRecSlot_${s.id}_all`);
        ['statNewUsersAll', 'statActiveUsersAll', 'statRecordsAll', 'statSharedAll', ...recordSlotAll].forEach((id) =>
            set(id, null)
        );
        renderDashboard7dHeaders(null);
        getDashboard7dCellIds().forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = '—';
                el.removeAttribute('title');
            }
        });
    }
    const label = document.getElementById('dashboardStatsUpdatedAt');
    if (label) {
        if (updatedAt) {
            const d = updatedAt && (updatedAt.toDate ? updatedAt.toDate() : new Date(updatedAt));
            label.textContent = '마지막 업데이트: ' + d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
        } else {
            label.textContent = '캐시된 통계가 없습니다. 「새로고침」을 눌러 주세요.';
        }
    }
}

/** 당일(오늘 00:00~) 데이터만 경량 조회 — 캐시가 전일 기준일 때 오늘 숫자만 보정용 (읽기 최소화). 공유는 게시물 수로 카운트 */
async function getTodayOnlyStats() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = Timestamp.fromDate(todayStart);
    try {
        const [
            newUsersCountSnap,
            sharedDocsSnap
        ] = await Promise.all([
            getCountFromServer(query(
                collection(db, 'artifacts', appId, 'users'),
                where('createdAt', '>=', todayTimestamp)
            )),
            getDocs(query(
                collection(db, 'artifacts', appId, 'sharedPhotos'),
                where('timestamp', '>=', todayTimestamp)
            ))
        ]);
        const todayPostKeys = new Set();
        (sharedDocsSnap.docs || []).forEach(d => {
            todayPostKeys.add(getSharedPhotoGroupKey(d.data()));
        });
        return {
            newUsersToday: newUsersCountSnap.data().count ?? 0,
            sharedPhotosToday: todayPostKeys.size
        };
    } catch (e) {
        console.warn('당일 통계 조회 실패 (캐시값만 표시):', e?.message || e);
        return { newUsersToday: 0, sharedPhotosToday: 0 };
    }
}

// 통계 업데이트: 전일까지는 캐시 1회 읽기, 당일만 필요 시 경량 쿼리로 보정 (DB 읽기 최소화)
export async function updateStatistics() {
    const btn = document.getElementById('dashboardStatsRefreshBtn');
    try {
        if (btn) btn.disabled = true;
        const snap = await getDoc(DASHBOARD_STATS_REF());
        if (!snap.exists()) {
            renderDashboardStats(null, null);
            renderDashboardPageUsage(null);
            return;
        }
        const data = snap.data();
        const asOfDate = data.asOfDate || null; // YYYY-MM-DD, 전일까지 집계된 기준일
        const todayStr = getTodayDateString();
        const stats = {
            newUsers: data.newUsers || { all: 0, last7: 0, today: 0 },
            activeUsers: data.activeUsers || { all: 0, last7: 0, today: 0 },
            records: data.records || { all: 0, last7: 0, today: 0 },
            recordsBySlot: data.recordsBySlot && typeof data.recordsBySlot === 'object' ? data.recordsBySlot : {},
            sharedPhotos: data.sharedPhotos || { all: 0, last7: 0, today: 0 },
            weeklyBreakdown: data.weeklyBreakdown && data.weeklyBreakdown.weeks?.length ? data.weeklyBreakdown : null
        };
        let last7Breakdown = cloneLast7Breakdown(data.last7Breakdown);
        // 캐시가 오늘 이전 기준이면 당일 숫자만 경량 조회해서 보정 (전일까지는 캐시 유지)
        if (asOfDate && asOfDate !== todayStr) {
            const todayOnly = await getTodayOnlyStats();
            if (last7Breakdown && last7Breakdown.dates) {
                const ti = last7Breakdown.dates.indexOf(todayStr);
                if (ti >= 0) {
                    last7Breakdown.newUsers[ti] = todayOnly.newUsersToday;
                    last7Breakdown.sharedPhotos[ti] = todayOnly.sharedPhotosToday;
                }
            }
            // records/activeUsers·7일 일별의 오늘 칸은 집계 비용상 캐시 유지 (새로고침 시 반영)
        }
        renderDashboardStats(stats, data.updatedAt, last7Breakdown);
        renderDashboardPageUsage(data.pageUsage || null);
    } catch (e) {
        console.error("대시보드 통계 로드 실패:", e);
        renderDashboardStats(null, null);
        renderDashboardPageUsage(null);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// 새로고침: 전체 집계 후 캐시 문서에 저장 (이때만 DB 다량 읽기)
export async function refreshDashboardStats() {
    try {
        await runAdminRefreshAction(
            document.getElementById('dashboardStatsRefreshBtn'),
            async () => {
                const prevSnap = await getDoc(DASHBOARD_STATS_REF());
                const prevData = prevSnap.exists() ? prevSnap.data() : null;
                const [stats, pageUsage] = await Promise.all([
                    getUserStatistics(),
                    aggregatePageUsageFromFirestore(prevData)
                ]);
                const payload = {
                    newUsers: stats.newUsers,
                    activeUsers: stats.activeUsers,
                    records: stats.records,
                    recordsBySlot: stats.recordsBySlot,
                    sharedPhotos: stats.sharedPhotos,
                    last7Breakdown: stats.last7Breakdown || null,
                    weeklyBreakdown: stats.weeklyBreakdown || null,
                    pageUsage,
                    asOfDate: getTodayDateString(),
                    updatedAt: serverTimestamp()
                };
                await setDoc(DASHBOARD_STATS_REF(), payload);
                renderDashboardStats(stats, new Date(), stats.last7Breakdown);
                renderDashboardPageUsage(pageUsage);
            },
            { loadingText: '집계 중…' }
        );
    } catch (e) {
        console.error('대시보드 새로고침 실패:', e);
        alert('새로고침 중 오류가 발생했습니다: ' + (e.message || e));
    }
}

// 공유 게시물 렌더링
export async function renderSharedPhotos() {
    const container = document.getElementById('sharedPhotosContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        const photos = await getSharedPhotos(100);
        
        if (photos.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-images text-2xl mb-2"></i><p>공유된 게시물이 없습니다.</p></div>';
            return;
        }
        
        // 문서에 userNickname이 비어 있는 작성자들은 사용자 설정에서 닉네임 조회 (관리번호에 닉네임이 안 보이는 문제 방지)
        const userIdsNeedingNickname = [...new Set(photos.filter(p => !(p.userNickname && p.userNickname.trim()) && p.userId).map(p => p.userId))];
        const nicknameFallbackMap = new Map();
        for (const uid of userIdsNeedingNickname) {
            try {
                const settingsRef = doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings');
                const snap = await getDoc(settingsRef);
                if (snap.exists()) {
                    const nn = snap.data()?.profile?.nickname;
                    if (nn && String(nn).trim()) nicknameFallbackMap.set(uid, String(nn).trim());
                }
            } catch (e) {
                console.warn(`관리자 공유 게시물: 사용자 ${uid} 설정 조회 실패`, e);
            }
        }
        const resolveNickname = (photo) => (photo.userNickname && String(photo.userNickname).trim()) ? photo.userNickname : (nicknameFallbackMap.get(photo.userId) || '익명');
        
        container.innerHTML = photos.map(photo => {
            const displayNickname = resolveNickname(photo);
            const date = photo.timestamp ? new Date(photo.timestamp) : new Date();
            const dateStr = date.toLocaleString('ko-KR', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            
            return `
                <div class="border border-slate-200 rounded-xl p-4 hover:shadow-md transition-shadow">
                    <div class="flex gap-4">
                        ${photo.photoUrl ? `
                            <div class="flex-shrink-0">
                                <img src="${photo.photoUrl}" alt="공유 사진" class="w-20 h-20 object-cover rounded-xl">
                            </div>
                        ` : ''}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-start justify-between mb-2">
                                <div class="flex items-center gap-2">
                                    <span class="text-lg">${photo.userIcon || '🐻'}</span>
                                    <span class="font-bold text-slate-800">${escapeHtml(displayNickname)}</span>
                                    ${photo.type === 'best' ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">베스트</span>' : ''}
                                    ${photo.type === 'daily' ? '<span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded">일간</span>' : ''}
                                    <span class="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs font-bold rounded">관리번호: ${photo.id}</span>
                                </div>
                                <button onclick="window.openDeleteModal('${photo.id}')" class="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">
                                    <i class="fa-solid fa-trash mr-1"></i>삭제
                                </button>
                            </div>
                            <div class="text-sm text-slate-600 mb-1">
                                ${photo.menuDetail || photo.place || photo.snackType || '내용 없음'}
                            </div>
                            <div class="text-xs text-slate-400">${dateStr}</div>
                            ${photo.comment ? `<div class="mt-2 text-sm text-slate-700 bg-slate-50 p-2 rounded">${photo.comment}</div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("공유 게시물 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}
