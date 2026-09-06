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
    getDocFromServer,
    setDoc,
    runTransaction,
    where,
    getCountFromServer,
    Timestamp,
    serverTimestamp,
    documentId
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { dailyJournalHasContent, normalizeDailyJournalEntry } from '../utils/daily-journal-data.js';
import { withDeadlineOr, DEADLINE } from '../utils/with-deadline.js';
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
import { MEMO_SLOT_ID } from '../utils/slot-plan.js';
import {
    HOUR_BUCKETS,
    hourSlotForMealDoc,
    hourSlotForJournalEntry
} from './dashboard-hour-buckets.js';
import { sumMemoRowArrays, sumMemoRowTotals } from './dashboard-memo-row.js';
import {
    rescanStartDateKey,
    rescanFromWeekIndex,
    mergeWeeklyArray,
    mergeWeeklyMap,
    mergeUniqueArray,
    totalWithOutsideWeeks,
    isRetroactive,
    canUseIncremental,
    needsWeeklyFullRefresh
} from './dashboard-incremental.js';
import { getExcludedAnalyticsUidList, getExcludedAnalyticsUidSet } from '../excluded-analytics-uids.js';
import { loadDashboardMirrorSource } from './dashboard-mirror.js';
import {
    snapshotFromDocs,
    indexDocsById,
    docOrMissing,
    filterDocsByIdRange,
    filterMealRowsByDate,
    countSlotAllFromRows,
    countMealRows,
    distinctMealUserIds,
    userRowsToDocLike,
    journalMarksFromUserRows
} from './dashboard-mirror-model.js';
import {
    writeDashboardUserDrilldown,
    markDashboardDrilldownCell,
    markDashboardDrilldownHeader,
    clearDashboardDrilldownCell,
    ensureDashboardDrilldownBinding,
    setDashboardDrilldownWeekKeys
} from './dashboard-user-drilldown.js';

/** 대시보드 주간 통계 시작일 (admin.js ADMIN_OPS_START 와 동일) */
const DASHBOARD_STATS_RANGE_START = new Date(2026, 2, 8);

/** usageDaily 문서 ID 하한 (YYYY-MM-DD, 운영 시작일과 맞춤) */
const USAGE_DAILY_MIN_ID = dateKeyFromLocalDate(DASHBOARD_STATS_RANGE_START) || '2026-03-08';

/**
 * 「페이지별」탭 행 — 화면 방문·조작 수.
 * @type {{field: string, section: string, label: string}[]}
 */
const PAGE_VIEW_METRIC_DEFS = [
    { field: 'tab_mealdang', section: '밀당', label: '탭 방문' },
    { field: 'mealdang_comment_click', section: '밀당', label: '코멘트 클릭' },
    { field: 'mealdang_analysis_detail_click', section: '밀당', label: '분석 상세 클릭' },
    { field: 'mealdang_analysis_cuisine_axis', section: '밀당', label: '분석 요리 종류 전환' },
    { field: 'tab_moment', section: '모먼트', label: '탭 방문' },
    /**
     * SNS 공유 — 「공유 시트로 넘김」은 대상 앱을 골랐다는 뜻까지다. 실제 게시 여부는
     * OS 가 알려주지 않는다. 두 행의 차이가 「열어 보고 그만둔 양」이다.
     */
    { field: 'moment_sns_share_tap', section: '모먼트', label: 'SNS 공유 누름' },
    { field: 'moment_sns_share_done', section: '모먼트', label: 'SNS 공유 시트로 넘김' },
    { field: 'tab_mealog', section: '밀로그', label: '탭 방문' },
    { field: 'promo_eat_together_click', section: '밀로그', label: '같이 먹자 배너 클릭' },
    { field: 'lounge_mealtalk', section: '라운지', label: '밀톡' },
    { field: 'lounge_board', section: '라운지', label: '게시판' },
    { field: 'lounge_notice', section: '라운지', label: '공지' },
    { field: 'settings_profile', section: '사용자', label: '프로필' },
    // 마이 > 태그 탭은 없어졌다(나만의 태그 제거) — 호출부가 없어 더 오르지 않지만 과거 이력이 남아 있다
    { field: 'settings_tags', section: '사용자', label: '태그 관리(폐지)' },
    { field: 'settings_mealdang_memo', section: '사용자', label: '밀당 메모' },
    { field: 'settings_push', section: '사용자', label: '푸시 알림' },
    /**
     * 웰컴 팝업 — 「뜬 것」과 「본 것」은 다르다.
     * 첫 화면(shown_*)은 요일별 기본값이 정하는 것이라 사용자 선택이 아니다. 사용자가 고른
     * 것은 kind_switch_* 쪽이다. 둘을 같은 줄로 읽지 말 것.
     */
    { field: 'welcome_shown_report', section: '웰컴', label: '첫 화면 리포트' },
    { field: 'welcome_shown_meal', section: '웰컴', label: '첫 화면 식사' },
    { field: 'welcome_shown_snack', section: '웰컴', label: '첫 화면 간식' },
    { field: 'welcome_dwell_3s', section: '웰컴', label: '3초 이상 머묾' },
    { field: 'welcome_kind_switch_report', section: '웰컴', label: '탭 전환 → 리포트' },
    { field: 'welcome_kind_switch_meal', section: '웰컴', label: '탭 전환 → 식사' },
    { field: 'welcome_kind_switch_snack', section: '웰컴', label: '탭 전환 → 간식' },
    { field: 'welcome_slide_move', section: '웰컴', label: '슬라이드 넘김' },
    { field: 'welcome_report_nav', section: '웰컴', label: '리포트 날짜 이동' },
    /**
     * AI 식단분석 리포트 열람 — 분모는 welcome_shown_report 다.
     * 이 두 행이 낮으면 리포트를 덜 만들어도 되고, 높으면 비용을 아끼면 안 된다는 뜻이다.
     */
    { field: 'diet_report_open_welcome', section: '리포트', label: '웰컴에서 열기' },
    { field: 'diet_report_open_timeline', section: '리포트', label: '타임라인에서 열기' }
];

/**
 * 「기록」탭 행 — 기록 시트 안에서 벌어지는 일.
 *
 * 페이지 방문 수와 성격이 다르다. 이쪽은 **제안이 맞았는지**를 재는 지표라 행 하나만
 * 보면 뜻이 없고 짝을 이뤄야 읽힌다 (표시 대비 채택, 표시 대비 교정). 그래서 표를
 * 나눴다 — 페이지별 표에 섞어 두면 두 종류의 숫자가 같은 축으로 읽힌다.
 *
 * @type {{field: string, section: string, label: string}[]}
 */
const RECORD_USAGE_METRIC_DEFS = [
    // 완주율의 분모·분자 — 열었는데 저장까지 갔나 (js/modals/entry-sheet-session.js)
    { field: 'entry_sheet_opened', section: '시트', label: '시트 열기(신규)' },
    { field: 'entry_sheet_saved', section: '시트', label: '저장까지 완료' },
    // 내용 없이 그냥 닫음 — 열어만 보고 나간 것
    { field: 'entry_sheet_abandoned', section: '시트', label: '내용 없이 닫음' },
    // 쓰다가 버림(나가기 확인) — 같은 이탈이라도 신호의 세기가 다르다
    { field: 'entry_sheet_discarded', section: '시트', label: '쓰다가 버림' },
    { field: 'what_recall_shown', section: '무엇을', label: '자주 먹는 것 표시' },
    { field: 'what_recall_picked', section: '무엇을', label: '자주 먹는 것 선택' },
    { field: 'what_typeahead_shown', section: '무엇을', label: '자동완성 표시' },
    { field: 'what_typeahead_picked', section: '무엇을', label: '자동완성 선택' },
    { field: 'category_suggest_shown', section: '분류 추천', label: '추천 표시' },
    { field: 'category_suggest_confirmed', section: '분류 추천', label: '추천 확정(탭)' },
    // 제안을 손대지 않고 저장 = 자동값 채택 (entry-and-core.js) — 확정과 합쳐야 채택률이 된다
    { field: 'category_suggest_auto_saved', section: '분류 추천', label: '추천 그대로 저장' },
    { field: 'category_suggest_grid_opened', section: '분류 추천', label: '다른 구분 열기' },
    { field: 'category_suggest_dismissed', section: '분류 추천', label: '분류 안 함' },
    { field: 'category_suggest_undismissed', section: '분류 추천', label: '분류 안 함 취소' },
    { field: 'context_predict_shown', section: '맥락 줄', label: '맥락 줄 표시' },
    { field: 'context_predict_applied', section: '맥락 줄', label: '맞아요(적용)' },
    { field: 'context_predict_dismissed', section: '맥락 줄', label: '거부' },
    // 손대지 않고 저장 = 추측이 그대로 적용된 기록 — 교정률의 분모
    { field: 'context_predict_auto_saved', section: '맥락 줄', label: '그대로 저장' },
    { field: 'context_place_typed', section: '맥락 줄', label: '어디서 직접 입력' },
    /**
     * 어디서 인라인 검색 — 적으면 곧 검색이다(entry-context-predict.js).
     * 「내 이력」과 「지도」를 갈라 세는 것이 요점이다. 이력 쪽이 클수록 카카오 호출이
     * 적다는 뜻이고(분당 15회 제한), 지도 쪽이 클수록 새로 가는 곳이 많다는 뜻이다.
     */
    { field: 'context_place_found_recent', section: '맥락 줄', label: '어디서 이력 후보 표시' },
    { field: 'context_place_picked_recent', section: '맥락 줄', label: '어디서 이력 후보 선택' },
    { field: 'context_place_found_kakao', section: '맥락 줄', label: '어디서 지도 후보 표시' },
    { field: 'context_place_picked_kakao', section: '맥락 줄', label: '어디서 지도 후보 선택' },
    { field: 'context_sub_picked', section: '맥락 줄', label: '누구와 세부 선택' },
    { field: 'context_sub_added', section: '맥락 줄', label: '누구와 세부 추가' },
    { field: 'context_sub_deleted', section: '맥락 줄', label: '누구와 세부 삭제' },
    { field: 'photo_gps_present', section: '사진', label: '위치정보 있음' },
    { field: 'photo_gps_absent', section: '사진', label: '위치정보 없음' }
];

/**
 * 두 탭의 행 정의를 이어 붙인 것 — **집계·캐시는 하나로 돈다.**
 *
 * usageDaily 문서는 필드가 한 벌이고 읽기도 한 번이라, 표만 갈라 두고 데이터 경로는
 * 건드리지 않는다. 표시는 `group` 으로 거른다 (applyUsageTableGroupFilter).
 *
 * ⚠️ 같은 `section` 은 **반드시 연속**이어야 한다 — 구분 셀이 rowspan 으로 묶이므로
 * 흩어지면 표가 어긋난다 (computePageUsageSectionRowspans).
 */
export const PAGE_USAGE_METRIC_DEFS = [
    ...PAGE_VIEW_METRIC_DEFS.map((d) => ({ ...d, group: 'page' })),
    ...RECORD_USAGE_METRIC_DEFS.map((d) => ({ ...d, group: 'record' }))
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

function zeroPageUsageWeeklyByField(nWeeks) {
    const o = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        o[def.field] = Array.from({ length: nWeeks }, () => 0);
    }
    return o;
}

function addDocDataToPageWeeklyTotals(data, dateKey, intoWeekly, sundayKeyToIndex) {
    const wi = weekIndexForDateKeyStr(dateKey, sundayKeyToIndex);
    if (wi < 0) return;
    const d = data || {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        intoWeekly[def.field][wi] += Number(d[def.field]) || 0;
    }
}

function clonePageUsageWeeklyFromPrev(prevByField, nWeeks) {
    const o = zeroPageUsageWeeklyByField(nWeeks);
    if (!prevByField || typeof prevByField !== 'object') return o;
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        const arr = prevByField[def.field];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < nWeeks && i < arr.length; i++) {
            o[def.field][i] = Number(arr[i]) || 0;
        }
    }
    return o;
}

function pageUsageWeeklyByFieldShapeOk(prevPU, nWeeks) {
    const bf = prevPU?.weeklyBreakdown?.byField;
    if (!bf || typeof bf !== 'object' || nWeeks <= 0) return false;
    return PAGE_USAGE_METRIC_DEFS.some((def) => {
        const a = bf[def.field];
        return Array.isArray(a) && a.length === nWeeks;
    });
}

/** 페이지별 표용: 캐시 weeklyBreakdown → 트렌드와 동일 레이아웃(월·주 헤더) + byField */
function normalizePageUsageWeeklyForRender(raw) {
    if (!raw || !Array.isArray(raw.weeks) || raw.weeks.length === 0) return null;
    const weeks = raw.weeks.map((w) => {
        const sk = String(w.sundayKey || '');
        const p = sk.split('-');
        const d =
            p.length === 3 ? new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)) : null;
        const label = d && !Number.isNaN(d.getTime()) ? weekLabelKoreanFromSunday(d) : String(w.label || '—');
        return {
            sundayKey: sk,
            label,
            year: Number.isFinite(Number(w.year)) ? Number(w.year) : d ? d.getFullYear() : 0,
            monthIndex: Number.isFinite(Number(w.monthIndex)) ? Number(w.monthIndex) : d ? d.getMonth() : 0
        };
    });
    return {
        weeks,
        monthGroups: buildMonthHeaderGroupsWithStarts(weeks),
        byField: raw.byField && typeof raw.byField === 'object' ? raw.byField : null
    };
}

/** 행 정의·레이아웃이 바뀌면 tbody를 다시 생성 */
let _pageUsageTableBuildKey = '';

/** 지금 보고 있는 탭 — tbody 재생성 시 숨김을 복원하는 데 쓴다 */
let _usageTableGroup = 'page';

/**
 * 페이지별·기록 탭은 **같은 표를 나눠 본다.** 집계가 한 벌이라 행을 거르는 편이
 * 표를 둘로 만드는 것보다 단순하다 — 주차 열 삽입·가로 스크롤 로직이 그대로 산다.
 *
 * 구분 셀이 rowspan 으로 여러 행을 덮지만, 섹션은 그룹 경계를 넘지 않으므로
 * 블록이 통째로 숨겨진다 (PAGE_USAGE_METRIC_DEFS 주석).
 *
 * @param {'page'|'record'} group
 */
function applyUsageTableGroupFilter(group) {
    _usageTableGroup = group === 'record' ? 'record' : 'page';
    document.querySelectorAll('tr[data-usage-group]').forEach((tr) => {
        tr.classList.toggle('hidden', tr.getAttribute('data-usage-group') !== _usageTableGroup);
    });
    document.getElementById('dashboardPageUsageHelp')?.classList.toggle('hidden', _usageTableGroup !== 'page');
    document.getElementById('dashboardRecordUsageHelp')?.classList.toggle('hidden', _usageTableGroup !== 'record');
}

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

/**
 * 구분 셀 색 — **정체성이 아니라 덩어리 나누기**다.
 *
 * 어느 구분인지는 셀에 적힌 글자가 말한다. 색이 하는 일은 53행짜리 표에서
 * 「여기서 묶음이 바뀐다」를 눈에 띄게 하는 것뿐이라, 구분마다 고유색을 박지 않고
 * 4톤을 돌려 쓴다 — 이웃끼리만 다르면 목적을 다한다.
 *
 * 4톤인 것은 취향이 아니라 검증 결과다. 8색 팔레트에서 7색을 한 화면에 올리면 전 쌍
 * 색각 분리가 깨진다(정상시 ΔE 12.9 < 15 하한). blue·orange·aqua·violet 네 개는 전 쌍
 * 통과다. 구분을 중간에 끼워 넣어도 이웃 충돌이 안 생기도록 이름이 아니라 순서로 돌린다.
 */
function computePageUsageSectionTones() {
    const n = PAGE_USAGE_METRIC_DEFS.length;
    const tones = new Array(n).fill(1);
    let sectionIdx = -1;
    for (let i = 0; i < n; i++) {
        if (i === 0 || PAGE_USAGE_METRIC_DEFS[i - 1].section !== PAGE_USAGE_METRIC_DEFS[i].section) {
            sectionIdx++;
        }
        tones[i] = (sectionIdx % 4) + 1;
    }
    return tones;
}

function ensurePageUsageTableBody() {
    const tb = document.getElementById('dashboardPageUsageTableBody');
    if (!tb) return;
    const n = PAGE_USAGE_METRIC_DEFS.length;
    const buildKey = `${n}-v8-section-tones`;
    const rowCount = tb.querySelectorAll('tr').length;
    if (_pageUsageTableBuildKey === buildKey && rowCount === n) return;

    const rowSpans = computePageUsageSectionRowspans();
    const sectionTones = computePageUsageSectionTones();
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
                `<td${rowspanAttr} data-usage-tone="${sectionTones[rowIdx]}" class="${sectionCellClass}"><span class="block text-base font-black text-slate-800 leading-tight">${escapeHtml(def.section)}</span></td>`
            );
        }
        cells.push(
            `<td class="${labelCellClass}">${escapeHtml(def.label)}</td>`
        );
        cells.push(
            `<td class="px-2 py-2 text-center text-sm font-bold text-slate-800 sticky left-[12.5rem] z-20 min-w-[4rem] shadow-[4px_0_12px_-6px_rgba(0,0,0,0.1)] border-r border-slate-300 align-middle" id="pageUsageRow_${rowIdx}_all">—</td>`
        );
        cells.push(
            `<td data-page-dash-7block-start class="px-2 py-2 text-center text-sm font-bold text-slate-900 tabular-nums border-l border-slate-300 bg-slate-300/90" id="pageUsageRow_${rowIdx}_7Sum">—</td>`
        );
        for (let i = 0; i < 7; i++) {
            const border = i === 6 ? ' border-r border-slate-300' : '';
            cells.push(
                `<td class="px-1 py-2 text-center text-xs font-bold text-slate-800 tabular-nums${border}" id="pageUsageRow_${rowIdx}_7d${i}">—</td>`
            );
        }
        const sectionStart = rs > 0 ? ' data-usage-section-start' : '';
        return `<tr class="group border-b border-slate-300"${sectionStart} data-page-dash-row="${rowIdx}" data-usage-group="${def.group || 'page'}">${cells.join('')}</tr>`;
    }).join('');
    _pageUsageTableBuildKey = buildKey;
    // tbody를 다시 만들면 숨김이 풀린다 — 지금 보고 있는 탭으로 되돌린다
    applyUsageTableGroupFilter(_usageTableGroup);
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

/**
 * 캐시·Firestore에서 내려온 일별 값을 길이 7 숫자 배열로 맞춤 (배열·숫자 키 객체 대응)
 */
function normalizePageUsageDaily7(raw) {
    if (raw == null) return null;
    let nums = [];
    if (Array.isArray(raw)) {
        nums = raw.map((v) => Number(v) || 0);
    } else if (typeof raw === 'object') {
        const keys = Object.keys(raw)
            .filter((k) => /^\d+$/.test(k))
            .map((k) => Number(k, 10))
            .sort((a, b) => a - b);
        nums = keys.map((k) => Number(raw[String(k)]) || 0);
    } else {
        return null;
    }
    if (nums.length === 0) {
        return [0, 0, 0, 0, 0, 0, 0];
    }
    while (nums.length < 7) nums.push(0);
    return nums.slice(0, 7);
}

/**
 * Firestore 캐시 변형 대응: byField가
 * - 맵 { tab_mealdang: [n0..n6], ... } 이거나
 * - 길이 7 배열 [ { tab_mealdang: n, ... }, ... ] (요일→필드) 일 때 맵 형으로 통일
 */
function coercePageUsageByFieldToMap(byField) {
    if (byField == null) return {};
    if (Array.isArray(byField)) {
        if (byField.length !== 7) return {};
        const out = {};
        for (const def of PAGE_USAGE_METRIC_DEFS) {
            out[def.field] = byField.map((day) => Number(day?.[def.field]) || 0);
        }
        return out;
    }
    if (typeof byField === 'object') return byField;
    return {};
}

/** 캐시의 byField가 비었거나 깨졌는지 판별 (정규화 후 길이 7 배열이 하나라도 있으면 usable) */
function pageUsageLast7ByFieldUsable(pageUsage) {
    const bf = coercePageUsageByFieldToMap(pageUsage?.last7Breakdown?.byField);
    return PAGE_USAGE_METRIC_DEFS.some((def) => {
        const a = normalizePageUsageDaily7(bf[def.field]);
        return a != null && a.length === 7;
    });
}

function last7DatesForRender(pageUsage) {
    const d = pageUsage?.last7Breakdown?.dates;
    if (Array.isArray(d) && d.length === 7 && d.every((x) => x != null && String(x).trim() !== '')) {
        return d.map((x) => String(x));
    }
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return getLast7DateKeys(todayStart);
}

/**
 * usageDaily 스냅샷에서 페이지별 최근 7일 일별·합계만 생성 (aggregate와 동일 규칙)
 * @param {string[]} last7DateKeys
 * @param {unknown[]} last7Snaps — getDoc 결과 스냅샷 배열
 */
function buildPageUsageLast7FromDayDocs(last7DateKeys, last7Snaps) {
    const byFieldDay = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        byFieldDay[def.field] = [0, 0, 0, 0, 0, 0, 0];
    }
    last7DateKeys.forEach((dk, i) => {
        const d = last7Snaps[i]?.exists() ? last7Snaps[i].data() : {};
        for (const def of PAGE_USAGE_METRIC_DEFS) {
            byFieldDay[def.field][i] = Number(d[def.field]) || 0;
        }
    });
    const last7Sum = {};
    for (const def of PAGE_USAGE_METRIC_DEFS) {
        last7Sum[def.field] = byFieldDay[def.field].reduce((a, b) => a + b, 0);
    }
    return { dates: last7DateKeys, byField: byFieldDay, last7Sum };
}

/** 화면 보정용: usageDaily 7문서만 읽어 최근 7일 블록 생성 */
export async function fetchPageUsageLast7FromUsageDaily() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const last7DateKeys = getLast7DateKeys(todayStart);
    const last7Snaps = await Promise.all(
        last7DateKeys.map((k) => getDocFromServer(doc(db, 'artifacts', appId, 'usageDaily', k)))
    );
    return buildPageUsageLast7FromDayDocs(last7DateKeys, last7Snaps);
}

export async function renderDashboardPageExcludedFooter() {
    const el = document.getElementById('dashboardPageUsageExcludedUidList');
    if (el) {
        const list = await getExcludedAnalyticsUidList();
        el.textContent = list.join(', ');
    }
}

export function renderDashboardPageUsage(pageUsage, opts = {}) {
    void renderDashboardPageExcludedFooter();
    ensurePageUsageTableBody();
    const skipAsyncRepair = opts.skipAsyncRepair === true;
    const skipAsyncWeekRepair = opts.skipAsyncWeekRepair === true;
    const fallbackWeekly = opts.fallbackWeeklyBreakdown ?? null;
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value != null ? Number(value).toLocaleString() : '—';
    };

    clearAdminDashboardPageWeekInjections();
    const weeklyLayout = pageUsage ? resolveWeeklyLayoutForPagePanel(pageUsage, fallbackWeekly) : null;
    const nWeeks = weeklyLayout?.weeks?.length || 0;
    const needsWeekClientRepair =
        Boolean(pageUsage) &&
        nWeeks > 0 &&
        !skipAsyncWeekRepair &&
        !pageUsageWeeklyByFieldShapeOk(pageUsage, nWeeks);

    if (weeklyLayout?.weeks?.length) {
        syncAdminDashboardPageWeekLayout(weeklyLayout);
        const weekByFieldForFill =
            pageUsage && pageUsageWeeklyByFieldShapeOk(pageUsage, nWeeks)
                ? pageUsage.weeklyBreakdown.byField
                : null;
        fillAdminDashboardPageWeeklyCells(weeklyLayout, weekByFieldForFill);
    }

    if (!pageUsage) {
        renderPageUsage7dHeaders(null);
        PAGE_USAGE_METRIC_DEFS.forEach((_, rowIdx) => {
            set(`pageUsageRow_${rowIdx}_all`, null);
            set(`pageUsageRow_${rowIdx}_7Sum`, null);
            fillPageUsage7dRow(rowIdx, null, null);
        });
        scrollDashboardPageTableToRight();
        return;
    }
    const dates = last7DatesForRender(pageUsage);
    renderPageUsage7dHeaders(dates);
    const byField = coercePageUsageByFieldToMap(pageUsage.last7Breakdown?.byField);
    const needsDailyRepair =
        pageUsage.all && typeof pageUsage.all === 'object' && !pageUsageLast7ByFieldUsable(pageUsage);

    if (needsWeekClientRepair) {
        fetchPageUsageWeeklyRepairFromUsageDaily(weeklyLayout)
            .then((byFieldFixed) => {
                if (!byFieldFixed) return;
                const weeksPayload = weeklyLayout.weeks.map((w) => ({
                    sundayKey: w.sundayKey,
                    label: w.label,
                    year: w.year,
                    monthIndex: w.monthIndex
                }));
                renderDashboardPageUsage(
                    {
                        ...pageUsage,
                        weeklyBreakdown: { weeks: weeksPayload, byField: byFieldFixed }
                    },
                    { skipAsyncWeekRepair: true, skipAsyncRepair, fallbackWeeklyBreakdown: fallbackWeekly }
                );
            })
            .catch((e) => {
                console.warn('페이지별 주간 보정(usageDaily) 실패:', e?.message || e);
            });
    } else if (needsDailyRepair && !skipAsyncRepair) {
        fetchPageUsageLast7FromUsageDaily()
            .then((r) => {
                renderDashboardPageUsage(
                    {
                        ...pageUsage,
                        last7Breakdown: { dates: r.dates, byField: r.byField },
                        last7Sum: r.last7Sum
                    },
                    { skipAsyncRepair: true, skipAsyncWeekRepair, fallbackWeeklyBreakdown: fallbackWeekly }
                );
            })
            .catch((e) => {
                console.warn('페이지별 최근 7일(usageDaily) 클라이언트 보정 실패:', e?.message || e);
            });
    }
    PAGE_USAGE_METRIC_DEFS.forEach((def, rowIdx) => {
        const all = pageUsage.all?.[def.field];
        const last7 = pageUsage.last7Sum?.[def.field];
        const dayArr = normalizePageUsageDaily7(byField[def.field]);
        set(`pageUsageRow_${rowIdx}_all`, all);
        const sum7 = dayArr && dayArr.length === 7 ? dayArr.reduce((a, b) => a + (Number(b) || 0), 0) : null;
        set(`pageUsageRow_${rowIdx}_7Sum`, sum7 != null ? sum7 : last7);
        fillPageUsage7dRow(rowIdx, dayArr, last7);
    });
    scrollDashboardPageTableToRight();
}

/**
 * 페이지별 집계 (dashboardStats 캐시 + 새로고침 시 usageDaily 전 구간 재스캔)
 * - 화면 로드: 캐시 1회 getDoc만 사용 (updateStatistics)
 * - 새로고침: usageDaily 전 구간 + 최근 7일 getDocFromServer로 all·주별·7일 일괄 산출
 * - 주별: 일요일 시작 주 메타는 트렌드(getUserStatistics)와 동일, usageDaily 일자를 주 인덱스로 합산
 */
async function rebuildPageUsageWeeklyFromFirestoreRange(usageCol, todayStr, sundayKeyToIndex, nWeeks) {
    const wf = zeroPageUsageWeeklyByField(nWeeks);
    if (nWeeks <= 0) return wf;
    const q = query(
        usageCol,
        where(documentId(), '>=', USAGE_DAILY_MIN_ID),
        where(documentId(), '<=', todayStr),
        orderBy(documentId())
    );
    const snap = await getDocs(q);
    snap.docs.forEach((d) => addDocDataToPageWeeklyTotals(d.data(), d.id, wf, sundayKeyToIndex));
    return wf;
}

/** 클라이언트 보정: 트렌드와 같은 주차 배열 기준으로 usageDaily 전 구간 스캔해 페이지별 주간 칸 채움 */
async function fetchPageUsageWeeklyRepairFromUsageDaily(weeklyLayout) {
    const weeks = weeklyLayout?.weeks;
    if (!weeks?.length) return null;
    const sundayKeyToIndex = new Map(weeks.map((w, i) => [w.sundayKey, i]));
    const todayStr = getTodayDateString();
    const usageCol = collection(db, 'artifacts', appId, 'usageDaily');
    return rebuildPageUsageWeeklyFromFirestoreRange(usageCol, todayStr, sundayKeyToIndex, weeks.length);
}

/**
 * 페이지별 집계.
 *
 * @param {object|null} _prevDashboardData
 * @param {object[]|null} [usageDailyDocs] usageDaily 미러 문서. 주면 서버를 읽지 않는다 —
 *        예전에는 새로고침마다 운영 시작일부터 오늘까지 전 구간(현재 약 180문서)과
 *        최근 7일을 `getDocFromServer` 로 다시 사 왔고, 대시보드를 미러로 옮긴 뒤에는
 *        **여기가 남은 서버 읽기의 대부분**이었다.
 */
export async function aggregatePageUsageFromFirestore(_prevDashboardData, usageDailyDocs = null) {
    const useMirror = Array.isArray(usageDailyDocs);
    const mirrorById = useMirror ? indexDocsById(usageDailyDocs) : null;
    const todayStr = getTodayDateString();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const last7DateKeys = getLast7DateKeys(todayStart);

    const weekMetas = enumerateSundayWeeksInclusive(DASHBOARD_STATS_RANGE_START, todayStart);
    const nWeeks = weekMetas.length;
    const sundayKeyToIndex = new Map(weekMetas.map((w, i) => [w.sundayKey, i]));

    const usageCol = collection(db, 'artifacts', appId, 'usageDaily');
    const todayRef = doc(db, 'artifacts', appId, 'usageDaily', todayStr);

    const last7Snaps = useMirror
        ? last7DateKeys.map((k) => docOrMissing(mirrorById, k))
        : await Promise.all(
              last7DateKeys.map((k) => getDocFromServer(doc(db, 'artifacts', appId, 'usageDaily', k)))
          );
    const { byField: byFieldDay, last7Sum } = buildPageUsageLast7FromDayDocs(last7DateKeys, last7Snaps);

    // usageDaily 일자는 수십~백여 건 수준이라 새로고침마다 전 구간 재집계(캐시 증분 오염 방지)
    let byFieldAll = zeroPageUsageTotals();
    let todayFieldSnap = zeroPageUsageTotals();
    let weeklyByField = zeroPageUsageWeeklyByField(nWeeks);

    const rangeDocs = useMirror
        ? filterDocsByIdRange(usageDailyDocs, USAGE_DAILY_MIN_ID, todayStr)
        : (
              await getDocs(
                  query(
                      usageCol,
                      where(documentId(), '>=', USAGE_DAILY_MIN_ID),
                      where(documentId(), '<=', todayStr),
                      orderBy(documentId())
                  )
              )
          ).docs;
    rangeDocs.forEach((d) => {
        addDocDataToPageTotals(d.data(), byFieldAll);
        addDocDataToPageWeeklyTotals(d.data(), d.id, weeklyByField, sundayKeyToIndex);
    });
    const tSnap = useMirror ? docOrMissing(mirrorById, todayStr) : await getDocFromServer(todayRef);
    if (tSnap.exists()) {
        addDocDataToPageTotals(tSnap.data(), todayFieldSnap);
    }

    const hasAnyMetric = PAGE_USAGE_METRIC_DEFS.some((def) => (Number(byFieldAll[def.field]) || 0) > 0);
    console.log('[대시보드] 페이지별 usageDaily 집계:', {
        출처: useMirror ? '로컬 미러' : '서버',
        docCount: rangeDocs.length,
        hasAnyMetric,
        todayStr,
        rangeFrom: USAGE_DAILY_MIN_ID
    });
    if (!hasAnyMetric) {
        console.warn(
            '[대시보드] usageDaily에 페이지별 수치가 없습니다. 앱에서 탭 전환 후 Firestore `artifacts/mealog-r0/usageDaily/{오늘}` 문서에 tab_mealdang 등 필드가 생기는지 확인하세요.'
        );
    }

    return {
        last7Breakdown: { dates: last7DateKeys, byField: byFieldDay },
        all: byFieldAll,
        last7Sum,
        weeklyBreakdown:
            nWeeks > 0
                ? {
                      weeks: weekMetas.map((w) => ({
                          sundayKey: w.sundayKey,
                          label: w.label,
                          year: w.year,
                          monthIndex: w.monthIndex
                      })),
                      byField: weeklyByField
                  }
                : null,
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
    const btnRecord = document.getElementById('dashboard-subtab-record');
    const btnExcluded = document.getElementById('dashboard-subtab-excluded');
    const active =
        'px-4 py-2 text-sm font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-xl whitespace-nowrap transition-colors shrink-0';
    const idle =
        'px-4 py-2 text-sm font-bold text-slate-500 bg-white border border-slate-200 hover:bg-slate-50 rounded-xl whitespace-nowrap transition-colors shrink-0';
    const w = which === 'page' || which === 'record' || which === 'excluded' ? which : 'trend';
    // 페이지별·기록은 같은 패널을 그룹 필터로 나눠 쓴다 (applyUsageTableGroupFilter)
    const usesUsagePanel = w === 'page' || w === 'record';
    if (trendPanel) trendPanel.classList.toggle('hidden', w !== 'trend');
    if (pagePanel) pagePanel.classList.toggle('hidden', !usesUsagePanel);
    if (excludedPanel) excludedPanel.classList.toggle('hidden', w !== 'excluded');
    if (btnTrend) btnTrend.className = w === 'trend' ? active : idle;
    if (btnPage) btnPage.className = w === 'page' ? active : idle;
    if (btnRecord) btnRecord.className = w === 'record' ? active : idle;
    if (btnExcluded) btnExcluded.className = w === 'excluded' ? active : idle;
    if (w === 'excluded') {
        import('./excluded-analytics-admin.js').then((m) => m.loadExcludedAnalyticsAdminPanel());
    }
    if (w === 'trend') {
        scrollDashboardTrendTableToRight();
    }
    if (usesUsagePanel) {
        applyUsageTableGroupFilter(w);
        scrollDashboardPageTableToRight();
    }
}

const RECORD_SLOT_7D_PREFIXES = SLOTS.map((s) => `statRecSlot_${s.id}_7d`);
const RECORD_SLOT_7_SUM_IDS = SLOTS.map((s) => `statRecSlot_${s.id}_7Sum`);

const RECORD_HOUR_7D_PREFIXES = ['statRecHourTotal_7d', ...HOUR_BUCKETS.map((b) => `statRecHour_${b.id}_7d`)];
const RECORD_HOUR_7_SUM_IDS = ['statRecHourTotal_7Sum', ...HOUR_BUCKETS.map((b) => `statRecHour_${b.id}_7Sum`)];

const DASHBOARD_7D_ROW_PREFIXES = [
    'statNewUsers7d', 'statActiveUsers7d', 'statRecords7d',
    ...RECORD_SLOT_7D_PREFIXES,
    'statMemo7d',
    'statRecordedUsers7d',
    ...RECORD_HOUR_7D_PREFIXES,
    'statShared7d'
];

const DASHBOARD_7_SUM_IDS = [
    'statNewUsers7Sum', 'statActiveUsers7Sum', 'statRecords7Sum',
    ...RECORD_SLOT_7_SUM_IDS,
    'statMemo7Sum',
    'statRecordedUsers7Sum',
    ...RECORD_HOUR_7_SUM_IDS,
    'statShared7Sum'
];

/** config/settings dailyComments 스캔 상한 (관리자 새로고침 시 1회) */
const DASHBOARD_DAILY_JOURNAL_CONFIG_SCAN_CAP = 10000;

/**
 * 시간대 버킷 배열들을 칸마다 더한 「기록 시각 기준 합계」.
 * 별도로 저장하지 않고 파생시켜야 합계와 내역이 어긋날 일이 없다.
 */
function sumHourBucketArrays(byBucket, length) {
    if (!byBucket) return null;
    const total = Array.from({ length }, () => 0);
    for (const b of HOUR_BUCKETS) {
        const arr = byBucket[b.id];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < length; i++) total[i] += Number(arr[i]) || 0;
    }
    return total;
}

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
    const rbh = raw.recordsByHour && typeof raw.recordsByHour === 'object' ? raw.recordsByHour : null;
    const recordsByHour = {};
    for (const b of HOUR_BUCKETS) {
        recordsByHour[b.id] = pick(rbh?.[b.id]);
    }
    return {
        dates: [...raw.dates],
        newUsers: pick(raw.newUsers),
        activeUsers: pick(raw.activeUsers),
        records: pick(raw.records),
        recordsBySlot,
        // 시간대는 나중에 추가된 필드라 옛 캐시엔 없다 — 없으면 '—'로 두려고 통째로 뺀다
        ...(rbh ? { recordsByHour } : {}),
        // 기록한 사람도 마찬가지 (시간대와 같은 recordedAt 축)
        ...(Array.isArray(raw.recordedUsers) ? { recordedUsers: pick(raw.recordedUsers) } : {}),
        sharedPhotos: pick(raw.sharedPhotos),
        dailyJournal: pick(raw.dailyJournal),
        // 사용자 메모는 나중에 생긴 축이라 옛 캐시엔 없다 — 없으면 통째로 빼서 하루 소감만으로 센다
        ...(Array.isArray(raw.memo) ? { memo: pick(raw.memo) } : {})
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
    const rbh = raw.recordsByHour && typeof raw.recordsByHour === 'object' ? raw.recordsByHour : null;
    const recordsByHour = {};
    if (rbh) {
        for (const b of HOUR_BUCKETS) {
            recordsByHour[b.id] = pickWeekArr(rbh[b.id], n);
        }
    }
    const monthGroups = buildMonthHeaderGroupsWithStarts(weeks);
    /** 유니크 지표의 월 칸은 주간 합이 아니다 — 길이가 맞을 때만 쓴다 */
    const pickMonthUnique = (arr) =>
        Array.isArray(arr) && arr.length === monthGroups.length ? arr.map((x) => Number(x) || 0) : undefined;
    const activeUsersMonthUnique = pickMonthUnique(raw.activeUsersMonthUnique);
    const recordedUsersMonthUnique = pickMonthUnique(raw.recordedUsersMonthUnique);
    return {
        weeks,
        monthGroups,
        newUsers: pickWeekArr(raw.newUsers, n),
        activeUsers: pickWeekArr(raw.activeUsers, n),
        records: pickWeekArr(raw.records, n),
        recordsBySlot,
        // 옛 캐시(시간대 필드 이전)에는 없다 — 없으면 행이 '—'로 남는다
        ...(rbh ? { recordsByHour, recordsByHourTotal: sumHourBucketArrays(recordsByHour, n) } : {}),
        sharedPhotos: pickWeekArr(raw.sharedPhotos, n),
        dailyJournal: pickWeekArr(raw.dailyJournal, n),
        // 사용자 메모는 나중에 생긴 축이다 — 옛 캐시에 없으면 하루 소감만 세게 둔다
        ...(Array.isArray(raw.memo) ? { memo: pickWeekArr(raw.memo, n) } : {}),
        // 옛 캐시엔 없다 — 없으면 행이 '—'로 남는다
        ...(Array.isArray(raw.recordedUsers) ? { recordedUsers: pickWeekArr(raw.recordedUsers, n) } : {}),
        ...(activeUsersMonthUnique ? { activeUsersMonthUnique } : {}),
        ...(recordedUsersMonthUnique ? { recordedUsersMonthUnique } : {})
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

/** 같은 달(헤더 구간)에 속한 주들의 uid Set을 합쳐 월간 유니크 수 (주간 합과 다름) */
function computeMonthUniqueFromWeekSets(setsByWeek, monthGroups) {
    const out = [];
    for (const g of monthGroups) {
        const union = new Set();
        for (let k = 0; k < g.span; k++) {
            const wi = g.startWeekIndex + k;
            const s = setsByWeek[wi];
            if (s && typeof s.forEach === 'function') s.forEach((uid) => union.add(uid));
        }
        out.push(union.size);
    }
    return out;
}

/**
 * 월 칸을 주간 합으로 낼 수 없는 행 — 사람 수는 더하면 같은 사람을 여러 번 센다.
 * 값: weeklyBreakdown 에 든 월간 유니크 배열의 키.
 */
const TREND_MONTH_UNIQUE_ROWS = {
    activeUsers: 'activeUsersMonthUnique',
    recordedUsers: 'recordedUsersMonthUnique'
};

/** 이 행의 월 칸에 쓸 유니크 배열. 없거나 길이가 안 맞으면 null(→ 주간 합으로 폴백) */
function monthUniqueArrayForRow(rowKey, weeklyBreakdown, monthGroups) {
    const field = TREND_MONTH_UNIQUE_ROWS[rowKey];
    if (!field) return null;
    const arr = weeklyBreakdown?.[field];
    return Array.isArray(arr) && monthGroups && arr.length === monthGroups.length ? arr : null;
}

/**
 * 트렌드 표 펼침: 대부분 지표는 월 칸 = 주간 합, 사람 수 행은 월 칸 = 유니크.
 * monthUnique 가 없으면(옛 캐시) 그 행도 기존처럼 주간 합으로 떨어진다 — 참고용.
 */
function expandWeeklyValuesForTrend(vals, monthGroups, monthUnique) {
    const v = Array.isArray(vals) ? vals.map((x) => Number(x) || 0) : [];
    const useMonthUnique = Array.isArray(monthUnique) && monthUnique.length === monthGroups?.length;
    const out = [];
    let u = 0;
    for (const g of monthGroups) {
        if (useMonthUnique) {
            out.push(Number(monthUnique[u]) || 0);
        } else {
            let sum = 0;
            for (let k = 0; k < g.span; k++) {
                sum += v[g.startWeekIndex + k] || 0;
            }
            out.push(sum);
        }
        u++;
        for (let k = 0; k < g.span; k++) {
            out.push(v[g.startWeekIndex + k] || 0);
        }
    }
    return out;
}

/**
 * expandWeeklyValuesForTrend 결과와 같은 순서로 각 칸이 가리키는 기간 서술
 * (월 선두 칸 = 그 달의 주차 전부, 나머지 = 주차 1개)
 */
function buildTrendColumnDescriptors(weeks, monthGroups) {
    const out = [];
    if (!weeks?.length || !monthGroups?.length) return out;
    for (const g of monthGroups) {
        const keys = [];
        for (let k = 0; k < g.span; k++) {
            const sk = weeks[g.startWeekIndex + k]?.sundayKey;
            if (sk) keys.push(sk);
        }
        out.push({ scope: 'month', keys, label: `${weeks[g.startWeekIndex]?.year ?? ''} ${g.label}`.trim() });
        for (let k = 0; k < g.span; k++) {
            const w = weeks[g.startWeekIndex + k];
            out.push({
                scope: 'week',
                keys: w?.sundayKey ? [w.sundayKey] : [],
                label: String(w?.label || '').replace(/\n/g, ' ')
            });
        }
    }
    return out;
}

/** expandWeeklyValuesForTrend 결과에서 월 선두 칸(합계/유니크) 인덱스 */
function monthLeadColumnFlags(monthGroups, expandedLength) {
    if (!monthGroups?.length || !Number.isFinite(expandedLength)) return null;
    const flags = new Array(expandedLength).fill(false);
    let pos = 0;
    for (const g of monthGroups) {
        if (pos >= expandedLength) break;
        flags[pos] = true;
        pos += 1 + g.span;
    }
    return flags;
}

function clearAdminDashboardWeekInjections() {
    document.querySelectorAll('.js-dash-month-th, .js-dash-week-th, .js-dash-week-td').forEach((el) => el.remove());
}

/** 대시보드 가로 스크롤 표: 최신 열(오른쪽)이 보이도록 */
function scrollDashboardTableToRight(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const apply = () => {
        el.scrollLeft = el.scrollWidth - el.clientWidth;
    };
    requestAnimationFrame(() => {
        requestAnimationFrame(apply);
    });
}

function scrollDashboardTrendTableToRight() {
    scrollDashboardTableToRight('dashboardTrendTableScroll');
}

function scrollDashboardPageTableToRight() {
    scrollDashboardTableToRight('dashboardPageTableScroll');
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
        // 월 헤더 클릭 → 그 달의 주차별 출석 표 (지속·이탈 확인용)
        markDashboardDrilldownHeader(th, {
            scope: 'month',
            keys: Array.from({ length: g.span }, (_, k) => weeks[g.startWeekIndex + k]?.sundayKey).filter(
                Boolean
            ),
            label: `${weeks[g.startWeekIndex]?.year ?? ''} ${g.label}`.trim()
        });
        row1.insertBefore(th, head7d);
    }

    for (const g of monthGroups) {
        const sumTh = document.createElement('th');
        sumTh.className =
            'js-dash-week-th px-0.5 py-1 text-center font-extrabold text-slate-900 min-w-[2.75rem] max-w-[3.25rem] text-[9px] leading-tight border-b border-slate-200 bg-slate-400/85';
        sumTh.textContent = '합계';
        sumTh.title = `${g.label}: 대부분 지표는 같은 달 주차 수치의 합. 활성 사용자는 같은 구간에서 기록한 유니크 사용자 수`;
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
            sumTd.className = `${baseCls} !bg-slate-300/90`;
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
    if (key === 'recordedUsers') return weeklyBreakdown.recordedUsers || [];
    if (key === 'sharedPhotos') return weeklyBreakdown.sharedPhotos || [];
    if (key === 'memo') return sumMemoRowArrays(weeklyBreakdown.dailyJournal, weeklyBreakdown.memo);
    if (key === 'records') return weeklyBreakdown.records || [];
    if (key.startsWith('slot:')) {
        const id = key.slice(5);
        return weeklyBreakdown.recordsBySlot?.[id] || [];
    }
    if (key === 'hourTotal') return weeklyBreakdown.recordsByHourTotal || [];
    if (key.startsWith('hour:')) {
        const id = key.slice(5);
        return weeklyBreakdown.recordsByHour?.[id] || [];
    }
    return [];
}

function fillAdminDashboardWeeklyCells(weeklyBreakdown) {
    const monthGroups = weeklyBreakdown?.monthGroups;
    // 코호트 표는 클릭한 칸이 아니라 전 구간을 본다
    setDashboardDrilldownWeekKeys((weeklyBreakdown?.weeks || []).map((w) => w.sundayKey));
    const columnDescriptors = buildTrendColumnDescriptors(weeklyBreakdown?.weeks, monthGroups);
    document.querySelectorAll('tr[data-dash-week-row]').forEach((tr) => {
        const key = tr.getAttribute('data-dash-week-row');
        const drillable = key === 'newUsers' || key === 'activeUsers';
        const vals = weeklyValuesForRow(key, weeklyBreakdown);
        const monthUnique = monthUniqueArrayForRow(key, weeklyBreakdown, monthGroups);
        /**
         * 배열이 통째로 없으면(그 필드가 생기기 전의 옛 캐시) 0 으로 펴지 않는다.
         * 0 은 「아무도 안 했다」로 읽히는데 실제로는 「모른다」다 — 그 자리는 '—' 여야 한다.
         */
        const missing = !Array.isArray(vals) || vals.length === 0;
        const expanded = missing
            ? []
            : monthGroups && monthGroups.length
              ? expandWeeklyValuesForTrend(vals, monthGroups, monthUnique)
              : vals;
        const monthLeads = monthLeadColumnFlags(monthGroups, expanded.length);
        const tds = tr.querySelectorAll(':scope > td.js-dash-week-td');
        tds.forEach((td, i) => {
            const v = expanded[i];
            if (v != null && Number.isFinite(Number(v))) {
                td.textContent = Number(v).toLocaleString();
                const uniqueMonthLead = Boolean(TREND_MONTH_UNIQUE_ROWS[key] && monthLeads && monthLeads[i]);
                if (uniqueMonthLead && monthUnique) {
                    td.title =
                        key === 'recordedUsers'
                            ? '해당 월(표시 주차 구간)에 한 번이라도 기록을 남긴 유니크 사용자 수'
                            : '해당 월(표시 주차 구간) 동안 기록이 있었던 유니크 사용자 수';
                } else if (uniqueMonthLead) {
                    td.title =
                        '캐시에 월간 유니크가 없어 주간 숫자의 합으로 표시됩니다. 「통계 새로고침」으로 갱신하세요.';
                } else {
                    td.removeAttribute('title');
                }
            } else {
                td.textContent = '—';
                td.title = '「새로고침」으로 주간 집계';
            }
            const desc = drillable ? columnDescriptors[i] : null;
            if (desc) {
                markDashboardDrilldownCell(td, {
                    kind: key,
                    scope: desc.scope,
                    keys: desc.keys,
                    label: desc.label,
                    count: Number(v) || 0
                });
            } else {
                clearDashboardDrilldownCell(td);
            }
        });
    });
}

function clearAdminDashboardPageWeekInjections() {
    document.querySelectorAll('.js-dash-page-month-th, .js-dash-page-week-th, .js-dash-page-week-td').forEach((el) =>
        el.remove()
    );
}

function syncAdminDashboardPageWeekLayout(weeklyLayout) {
    clearAdminDashboardPageWeekInjections();
    const row1 = document.getElementById('dashboardPageHeadRow1');
    const row2 = document.getElementById('dashboardPageHeadRow2');
    const head7d = document.getElementById('dashboardPageHead7dTop');
    const sumHead = document.getElementById('pageDashboard7dSumHead');
    if (!row1 || !row2 || !head7d || !sumHead) return;

    const weeks = weeklyLayout?.weeks;
    const monthGroups =
        weeklyLayout?.monthGroups || (weeks?.length ? buildMonthHeaderGroupsWithStarts(weeks) : []);
    if (!weeks || weeks.length === 0) return;

    for (const g of monthGroups) {
        const th = document.createElement('th');
        th.className =
            'js-dash-page-month-th px-2 py-1.5 font-black text-slate-800 uppercase text-center text-xs tracking-wide border-b border-slate-400 bg-slate-50';
        th.colSpan = g.span + 1;
        th.textContent = g.label;
        row1.insertBefore(th, head7d);
    }

    for (const g of monthGroups) {
        const sumTh = document.createElement('th');
        sumTh.className =
            'js-dash-page-week-th px-0.5 py-1 text-center font-extrabold text-slate-900 min-w-[2.75rem] max-w-[3.25rem] text-[9px] leading-tight border-b border-slate-400 bg-slate-400/85';
        sumTh.textContent = '합계';
        sumTh.title = `${g.label} 주간 합계(같은 달에 속한 주차 수치의 합)`;
        row2.insertBefore(sumTh, sumHead);
        for (let j = 0; j < g.span; j++) {
            const w = weeks[g.startWeekIndex + j];
            const th = document.createElement('th');
            th.className =
                'js-dash-page-week-th px-1 py-1 text-center font-bold text-slate-600 min-w-[3.5rem] max-w-[5.5rem] text-[10px] leading-tight border-b border-slate-400 bg-slate-50/90 whitespace-pre-line';
            th.textContent = w?.label || '—';
            th.title = w?.sundayKey || '';
            row2.insertBefore(th, sumHead);
        }
    }

    document.querySelectorAll('tr[data-page-dash-row]').forEach((tr) => {
        for (const g of monthGroups) {
            const baseCls =
                'js-dash-page-week-td px-1 py-2 text-center text-xs font-bold text-slate-800 tabular-nums';
            const sumTd = document.createElement('td');
            sumTd.className = `${baseCls} !bg-slate-300/90`;
            const anchor = tr.querySelector('[data-page-dash-7block-start]');
            if (anchor) tr.insertBefore(sumTd, anchor);
            for (let j = 0; j < g.span; j++) {
                const td = document.createElement('td');
                td.className = baseCls;
                if (anchor) tr.insertBefore(td, anchor);
            }
        }
    });
}

function fillAdminDashboardPageWeeklyCells(weeklyLayout, byFieldMap) {
    const monthGroups = weeklyLayout?.monthGroups;
    const nW = weeklyLayout?.weeks?.length || 0;
    const usable =
        byFieldMap &&
        typeof byFieldMap === 'object' &&
        nW > 0 &&
        PAGE_USAGE_METRIC_DEFS.some((def) => {
            const a = byFieldMap[def.field];
            return Array.isArray(a) && a.length === nW;
        });
    document.querySelectorAll('tr[data-page-dash-row]').forEach((tr) => {
        const rowIdx = parseInt(tr.getAttribute('data-page-dash-row'), 10);
        const field = PAGE_USAGE_METRIC_DEFS[rowIdx]?.field;
        const vals = usable && field ? byFieldMap[field] || [] : null;
        const tds = tr.querySelectorAll(':scope > td.js-dash-page-week-td');
        if (vals == null) {
            tds.forEach((td) => {
                td.textContent = '—';
                td.title = '「새로고침」으로 페이지별 집계';
            });
            return;
        }
        const expanded =
            monthGroups && monthGroups.length ? expandWeeklyValuesWithMonthSums(vals, monthGroups) : vals;
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

function resolveWeeklyLayoutForPagePanel(pageUsage, fallbackWeekly) {
    let layout = normalizePageUsageWeeklyForRender(pageUsage?.weeklyBreakdown);
    if (!layout?.weeks?.length && fallbackWeekly) {
        const cl = cloneWeeklyBreakdown(fallbackWeekly);
        if (cl?.weeks?.length) {
            layout = { weeks: cl.weeks, monthGroups: cl.monthGroups, byField: null };
        }
    }
    return layout;
}

// 대시보드 통계 캐시 문서 (adminSettings 사용 — Firestore 규칙에서 관리자 쓰기 허용됨)
const DASHBOARD_STATS_REF = () => doc(db, 'artifacts', appId, 'adminSettings', 'dashboardStats');

/**
 * 「전체」열을 세는 slotId 목록.
 *
 * 뒤에 붙은 둘은 슬롯 행이 아니다.
 *
 * - `'daily_journal'` 은 **하루 소감 meals 미러**의 건수다. 하루 소감은
 *   config/settings 의 dailyComments 와 meals 미러 문서 양쪽에 있어서, 미러 수를 알아야
 *   「기록 · 전체」에서 같은 기록을 두 번 세지 않는다 (dbOps.syncDailyJournalMealMirror).
 * - `'memo'` 는 사용자 메모다. 이쪽은 meals 가 정본이라 뺄 것이 없고, 세는 이유가
 *   반대다 — 안 세면 「기록 · 전체」에만 섞이고 어느 행에도 안 보인다
 *   (docs/user-memo-items.md §6.3).
 */
const MEAL_COUNT_SLOT_IDS = [...SLOTS.map((s) => s.id), 'daily_journal', MEMO_SLOT_ID];
const JOURNAL_MIRROR_COUNT_INDEX = MEAL_COUNT_SLOT_IDS.indexOf('daily_journal');
/**
 * 사용자 메모(docs/user-memo-items.md)의 「전체」. 하루 소감과 달리 meals 가 정본이라
 * 미러 보정이 없다 — 이 값이 그대로 메모 건수다.
 */
const MEMO_COUNT_INDEX = MEAL_COUNT_SLOT_IDS.indexOf(MEMO_SLOT_ID);

/**
 * 컬렉션 그룹 `slotId` 인덱스가 없을 때(aggregation failed-precondition):
 * 각 사용자 `users/{uid}/meals`에서 슬롯별 count를 더해 전체 건수 산출 (새로고침 1회당 읽기 다량).
 */
async function countMealsSlotAllViaUserSubcollections(userIds, countQFn) {
    const totals = MEAL_COUNT_SLOT_IDS.map(() => 0);
    const UID_BATCH = 8;
    for (let i = 0; i < userIds.length; i += UID_BATCH) {
        const chunk = userIds.slice(i, i + UID_BATCH);
        const perUserArrays = await Promise.all(
            chunk.map(async (uid) => {
                const mc = collection(db, 'artifacts', appId, 'users', uid, 'meals');
                const counts = await Promise.all(
                    MEAL_COUNT_SLOT_IDS.map(async (sid) => {
                        try {
                            return await countQFn(query(mc, where('slotId', '==', sid)));
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

/**
 * 관리자 「새로고침」 전용 집계.
 *
 * @param {{mode?: 'full'|'incremental', cached?: object|null}} [options]
 *   `incremental` 이면 지난 집계 이후 달라진 것만 읽어 캐시에 얹는다.
 *   캐시가 없거나 주차 구성이 어긋나면 알아서 전량으로 되돌아간다.
 */
export async function getUserStatistics(options = {}) {
    try {
        const wantIncremental = options?.mode === 'incremental';
        /**
         * 미러 모드 — meals·users·sharedPhotos 를 브라우저 사본에서 읽는다.
         *
         * 로컬에서는 전량을 훑어도 비용이 없으므로 **증분 병합을 쓰지 않는다.**
         * 얼린 과거 주차·소급 delta 는 서버 읽기가 비싸서 만든 장치였고, 그 대가로
         * 지난 주차의 수정·삭제와 제외 UID 변경을 놓쳤다. 미러에서는 매번 전량이라
         * 그 구멍이 통째로 없어진다.
         */
        const wantMirror = options?.mode === 'mirror';
        const mirrorSource = options?.mirrorSource || null;
        const cachedForIncremental = options?.cached || null;
        const excluded = await getExcludedAnalyticsUidSet();
        const usersColl = collection(db, 'artifacts', appId, 'users');

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
        const dailyJournalByDay = z7();
        const activeSetsByDay = Array.from({ length: 7 }, () => new Set());
        const sharedByDayCounts = z7();

        const newUsersByWeek = zW();
        const recordsByWeek = zW();
        const dailyJournalByWeek = zW();
        const activeSetsByWeek = Array.from({ length: nWeeks }, () => new Set());
        const sharedSetsByWeek = Array.from({ length: nWeeks }, () => new Set());

        // 트렌드 표 드릴다운(명단 팝업)용 — 숫자와 같은 집합에서 뽑아야 표와 명단이 어긋나지 않는다
        const newUserSetsByDay = Array.from({ length: 7 }, () => new Set());
        const newUserSetsByWeek = Array.from({ length: nWeeks }, () => new Set());
        const newUserSetAll = new Set();
        /** uid → 가입일(YYYY-MM-DD). createdAt이 없는 사용자는 '' */
        const joinKeyByUid = new Map();
        /**
         * 출석 표 칸에 넣을 「얼마나 썼나」. 활성 여부(●)만으로는 주 1회와 매일 쓰는 사람이
         * 똑같이 보여서, 강도가 줄어드는 이탈 전조가 안 보인다.
         * - 주차: 기록 일수 (uid → 그 주에 기록이 있던 날짜 Set → 크기)
         * - 일자: 기록 건수 (하루는 0/1뿐이라 일수가 의미 없다)
         * 활성 사용자 정의와 같게 끼니 기록(meals)만 센다 — 하루기록은 activeSets에도 안 들어간다.
         */
        const weekDaySetsByUid = Array.from({ length: nWeeks }, () => new Map());
        const dayRecordCountsByUid = Array.from({ length: 7 }, () => new Map());

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
        // 사용자 메모도 같은 통에 담는다 — scanMealDoc 이 slotId 로 찾아 넣는다
        slotAgg[MEMO_SLOT_ID] = emptySlotAgg();

        /**
         * 시간대 집계. 슬롯과 달리 「전체」를 count 쿼리로 못 센다 —
         * 문서에 시간대 필드가 없어 where를 걸 수 없다. 그래서 rangeAll(스캔 구간 합계)로 채운다.
         *
         * 날짜 칸은 식사 날짜가 아니라 **기록한 날짜**로 잡는다. 그래서 끼니·간식 행과
         * 열별 합계가 다를 수 있다 — 어제 끼니를 오늘 적으면 저쪽은 어제 칸, 이쪽은 오늘 칸이다.
         */
        const hourAgg = {};
        for (const b of HOUR_BUCKETS) hourAgg[b.id] = { rangeAll: 0, last7: 0, today: 0, byDay: z7(), byWeek: zW() };
        /**
         * @param {{dateKey: string, bucketId: string}|null} slot 기록 시점(hourSlotFor* 산출)
         *
         * meals 스캔은 식사 날짜로 범위를 걸었으므로, 기록 날짜는 구간 밖으로 나갈 수 있다
         * (운영 시작 전에 적어 둔 기록, 기기 시계가 앞선 기록). 그런 건 넣을 칸이 없어 버린다.
         */
        /**
         * 「기록한 사람」 — 시간대 행과 **같은 축(recordedAt)** 의 유니크 사용자.
         *
         * 활성 사용자와 다르다. 저쪽은 식사 날짜라 「그 날짜의 끼니를 가진 사람」이고,
         * 이쪽은 「그 날 실제로 앱을 켜서 적은 사람」이다. 어제 끼니를 오늘 몰아 적으면
         * 활성 사용자는 어제 칸, 이쪽은 오늘 칸에 선다.
         *
         * 더할 수 없는 값이라 주차·월 칸은 Set 을 그대로 들고 있다가 크기로 낸다.
         */
        const recordedUserSetsByDay = Array.from({ length: 7 }, () => new Set());
        const recordedUserSetsByWeek = Array.from({ length: nWeeks }, () => new Set());
        const recordedUserSetsToday = new Set();
        const recordedUserSetsLast7 = new Set();
        /**
         * @param {{dateKey: string}|null} slot addHourRecord 와 같은 슬롯
         * @param {string} uid
         */
        const addRecordedUser = (slot, uid) => {
            if (!slot || !uid) return;
            const { dateKey } = slot;
            if (dateKey < firstSundayKey || dateKey > todayStr) return;
            const wi = weekIndexForDateKeyStr(dateKey, sundayKeyToIndex);
            if (wi >= 0) recordedUserSetsByWeek[wi].add(uid);
            if (dateKey === todayStr) recordedUserSetsToday.add(uid);
            if (dateKey >= last7FirstStr) {
                recordedUserSetsLast7.add(uid);
                const di = last7IndexMap.get(dateKey);
                if (di != null && di >= 0) recordedUserSetsByDay[di].add(uid);
            }
        };

        const addHourRecord = (slot) => {
            if (!slot) return;
            const { dateKey } = slot;
            if (dateKey < firstSundayKey || dateKey > todayStr) return;
            const a = hourAgg[slot.bucketId] || hourAgg.unknown;
            a.rangeAll++;
            const wi = weekIndexForDateKeyStr(dateKey, sundayKeyToIndex);
            if (wi >= 0) a.byWeek[wi]++;
            if (dateKey === todayStr) a.today++;
            if (dateKey >= last7FirstStr) {
                a.last7++;
                const di = last7IndexMap.get(dateKey);
                if (di != null && di >= 0) a.byDay[di]++;
            }
        };

        const stats = {
            newUsers: { all: 0, last7: 0, today: 0 },
            activeUsers: { all: 0, last7: 0, today: 0 },
            recordedUsers: { all: 0, last7: 0, today: 0 },
            records: { all: 0, last7: 0, today: 0 },
            recordsBySlot: {},
            recordsByHour: {},
            sharedPhotos: { all: 0, last7: 0, today: 0 },
            dailyJournal: { all: 0, last7: 0, today: 0 },
            memo: { all: 0, last7: 0, today: 0 },
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

        /**
         * 증분 가능 여부. 여기서 한 번 정하고 아래 전부가 이 값을 따른다 —
         * 중간에 갈리면 어떤 칸은 캐시, 어떤 칸은 재계산이 되어 표가 섞인다.
         */
        const incr = wantIncremental
            ? canUseIncremental(cachedForIncremental, weekMetas)
            : { ok: false, reason: wantMirror ? 'mirror-full' : 'full-requested' };
        const useIncremental = incr.ok && nWeeks > 0;
        /** 미러 모드가 실제로 성립하는지 — 재료가 손에 있어야 한다 */
        const useMirror = wantMirror && !!mirrorSource;
        if (wantIncremental && !useIncremental) {
            console.warn('[대시보드] 증분 집계를 쓸 수 없어 전량으로 집계합니다:', incr.reason);
        }

        /** 캐시를 버리고 다시 세는 구간의 시작 날짜 (전량이면 운영 시작 주) */
        const rescanStartKey = useIncremental
            ? rescanStartDateKey(todayStr, sundayKeyForDateKey(todayStr))
            : firstSundayKey;
        /** 이 주차 인덱스부터는 캐시를 쓰지 않는다 */
        const rescanFromIdx = useIncremental ? rescanFromWeekIndex(weekMetas, rescanStartKey) : 0;
        const lastAggregatedAt = useIncremental ? String(cachedForIncremental.lastAggregatedAt) : '';

        /**
         * 시간대 행이 읽을 구간의 시작 — **기록 시각(recordedAt) 축**의 하한.
         *
         * 시간대 행은 「며칟날 몇 시에 앱을 켰나」라서 recordedAt 으로 칸을 잡는데,
         * 문서를 가져오는 쿼리는 식사 날짜(date)로 범위를 건다. 두 축이 어긋나는 문서
         * (= 과거 끼니를 오늘 몰아 적은 소급 입력)는 그 쿼리에 아예 안 걸린다.
         * 그래서 같은 축으로 한 번 더 읽는다.
         *
         * recordedAt 은 ISO(UTC) 문자열이라 로컬 자정을 ISO 로 바꿔 비교한다.
         */
        const hourScanStartIso = (() => {
            const parts = String(rescanStartKey || '').split('-');
            if (parts.length !== 3) return new Date(0).toISOString();
            const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
            d.setHours(0, 0, 0, 0);
            return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
        })();

        /**
         * meals 세 갈래.
         *
         * - **미러 모드**: 사본을 한 번 읽어 두 축으로 나눠 쓴다. 소급 delta 는 필요 없다 —
         *   전량이라 「지난 집계 이후」라는 개념 자체가 없다.
         * - **서버 모드**: 예전 그대로 쿼리 세 개.
         */
        const [recordsAllCountRaw, mealsRangeSnap, mealsRetroSnap, mealsRecordedSnap] = useMirror
            ? [
                  countMealRows(mirrorSource.mealRows, excluded),
                  snapshotFromDocs(
                      filterMealRowsByDate(mirrorSource.mealDocs, rescanStartKey, todayStr, (d) => d.data().date)
                  ),
                  emptyMealsSnap,
                  // 시간대 행은 기록 시각 축이라 식사 날짜로 자르면 소급 입력이 샌다 — 전량을 넘긴다
                  snapshotFromDocs(mirrorSource.mealDocs)
              ]
            : await Promise.all([
                  countQ(query(mealsCg)),
                  nWeeks > 0
                      ? getDocs(query(mealsCg, where('date', '>=', rescanStartKey), where('date', '<=', todayStr)))
                      : Promise.resolve(emptyMealsSnap),
                  // 소급 입력분: 지난 집계 뒤에 적혔지만 과거 날짜를 가리키는 기록
                  useIncremental
                      ? getDocs(query(mealsCg, where('recordedAt', '>', lastAggregatedAt)))
                      : Promise.resolve(emptyMealsSnap),
                  // 시간대 행 전용 — 기록 시각으로 구간을 건다 (위 두 스냅숏과 축이 다르다)
                  nWeeks > 0
                      ? getDocs(query(mealsCg, where('recordedAt', '>=', hourScanStartIso)))
                      : Promise.resolve(emptyMealsSnap)
              ]);
        let recordsAllCount = recordsAllCountRaw;

        /**
         * 사용자 목록. 증분에서는 다시 세는 구간에 가입한 사람만 읽는다 —
         * 그 이전 가입자의 주차 칸은 캐시가 들고 있고, 가입일은 나중에 바뀌지 않는다.
         * 전체 인원수만 count 로 따로 센다(문서를 읽지 않는다).
         */
        const rescanStartDate = (() => {
            const p = String(rescanStartKey || '').split('-');
            if (p.length !== 3) return DASHBOARD_STATS_RANGE_START;
            const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
            d.setHours(0, 0, 0, 0);
            return Number.isNaN(d.getTime()) ? DASHBOARD_STATS_RANGE_START : d;
        })();
        const usersSnapshot = useMirror
            ? snapshotFromDocs(userRowsToDocLike(mirrorSource.userRows))
            : useIncremental
              ? await getDocs(query(usersColl, where('createdAt', '>=', Timestamp.fromDate(rescanStartDate))))
              : await getDocs(usersColl);
        let usersFromCollection;
        if (useIncremental) {
            let n = await countQ(query(usersColl));
            for (const exUid of excluded) {
                const exSnap = await getDoc(doc(usersColl, exUid));
                if (exSnap.exists()) n -= 1;
            }
            usersFromCollection = Math.max(0, n);
        } else {
            usersFromCollection = usersSnapshot.docs.filter((d) => !excluded.has(d.id)).length;
        }

        const userIdsForSlots = usersSnapshot.docs.map((d) => d.id).filter((uid) => !excluded.has(uid));
        let slotAllArr;
        if (useMirror) {
            // 슬롯마다 던지던 count 쿼리 자리 — 미러를 한 번 훑으면 같은 값이 나온다
            slotAllArr = countSlotAllFromRows(mirrorSource.mealRows, MEAL_COUNT_SLOT_IDS, excluded);
        } else {
            try {
                slotAllArr = await Promise.all(
                    MEAL_COUNT_SLOT_IDS.map((sid) => countQ(query(mealsCg, where('slotId', '==', sid))))
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
        }

        // 미러 모드에서는 세는 자리마다 제외 UID 를 이미 걸렀다 — 여기서 또 빼면 두 번 빼진다
        if (!useMirror) {
            for (const exUid of excluded) {
                const mcEx = collection(db, 'artifacts', appId, 'users', exUid, 'meals');
                recordsAllCount -= await countQ(query(mcEx));
                for (let si = 0; si < MEAL_COUNT_SLOT_IDS.length; si++) {
                    slotAllArr[si] -= await countQ(query(mcEx, where('slotId', '==', MEAL_COUNT_SLOT_IDS[si])));
                }
            }
        }

        let recordsToday = 0;
        let recordsLast7 = 0;
        /** meals 에 미러 문서가 있는 하루 소감 `${uid}|${date}` — 이중 계산 방지 */
        const mirroredJournalKeys = new Set();

        let dailyJournalAll = 0;
        let dailyJournalToday = 0;
        let dailyJournalLast7 = 0;
        /**
         * 하루 소감을 실제로 센 출처가 있었는지 (config 전량 스캔 또는 users 미러).
         * 실패하면(권한·인덱스) 미러가 하루 소감의 **유일한** 출처가 되므로,
         * 아래에서 미러를 빼면 그만큼 통째로 증발한다. 그 경우엔 빼지 않는다.
         */
        let journalCountedFromSource = false;
        /**
         * meals 미러가 없는 하루 소감. 「하루 소감」행은 전량(위 카운터)을 보여주지만,
         * 「기록 · 전체」에는 미러로 이미 센 몫을 빼고 이쪽만 얹는다.
         */
        let dailyJournalUnmirroredToday = 0;
        let dailyJournalUnmirroredLast7 = 0;
        const dailyJournalUnmirroredByDay = z7();
        const dailyJournalUnmirroredByWeek = zW();

        /**
         * @param {boolean} retroOnly 소급분 스냅숏인지.
         *   참이면 다시 세는 구간 **밖**(과거 칸)을 가리키는 기록만 센다.
         *   구간 안쪽은 mealsRangeSnap 이 이미 정확히 세었으므로, 여기서 또 세면 이중 계산이다.
         */
        const scanMealDoc = (docSnap, retroOnly) => {
            const mealData = docSnap.data();
            const dateStr = mealData.date;
            const uid = userIdFromMealDocRef(docSnap.ref);
            if (!dateStr || typeof dateStr !== 'string' || !uid) return;
            if (excluded.has(uid)) return;
            if (retroOnly && !isRetroactive(dateStr, rescanStartKey)) return;
            // 스캔 구간을 좁혔으므로 그보다 과거는 캐시가 담당한다 (전량 모드에선 firstSundayKey 라 무해)
            if (dateStr < firstSundayKey) return;

            const wi = weekIndexForDateKeyStr(dateStr, sundayKeyToIndex);
            if (wi >= 0) {
                recordsByWeek[wi]++;
                activeSetsByWeek[wi].add(uid);
                let days = weekDaySetsByUid[wi].get(uid);
                if (!days) {
                    days = new Set();
                    weekDaySetsByUid[wi].set(uid, days);
                }
                days.add(dateStr);
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
                    dayRecordCountsByUid[rdi].set(uid, (dayRecordCountsByUid[rdi].get(uid) || 0) + 1);
                }
                activeUserSets.last7.add(uid);
            }

            const sid = mealData.slotId;
            // 하루 소감 미러는 아래 dailyComments 스캔에서 또 세지 않도록 표시해 둔다.
            if (sid === 'daily_journal') {
                mirroredJournalKeys.add(`${uid}|${dateStr}`);
                /**
                 * 증분에서는 config/settings 를 읽지 않는다 — dailyComments 가 맵이라
                 * 「어느 항목이 새로 생겼는지」를 문서 단위로 가릴 수 없어서다.
                 * 대신 미러(2026-06-10 이후 항상 만들어진다)를 정본으로 삼는다.
                 * 미러가 없던 시절의 옛 소감은 캐시에 이미 얼려져 있다.
                 */
                if (useIncremental) {
                    dailyJournalAll++;
                    if (wi >= 0) dailyJournalByWeek[wi]++;
                    if (dateStr === todayStr) dailyJournalToday++;
                    if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                        dailyJournalLast7++;
                        const jdi = last7IndexMap.get(dateStr);
                        if (jdi != null && jdi >= 0) dailyJournalByDay[jdi]++;
                    }
                }
            }
            if (sid && slotAgg[sid]) {
                if (wi >= 0) slotAgg[sid].byWeek[wi]++;
                if (dateStr === todayStr) slotAgg[sid].today++;
                if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                    slotAgg[sid].last7++;
                    const sdi = last7IndexMap.get(dateStr);
                    if (sdi != null && sdi >= 0) slotAgg[sid].byDay[sdi]++;
                }
            }
        };

        mealsRangeSnap.forEach((d) => scanMealDoc(d, false));
        mealsRetroSnap.forEach((d) => scanMealDoc(d, true));

        /**
         * 시간대 행은 여기서만 채운다.
         *
         * 예전에는 위 두 스캔에 얹어 셌는데, 소급 입력이 **집계 한 번 분량만 보였다가
         * 영구히 사라졌다.** 식사 날짜 범위 쿼리에는 안 걸리고, 소급 델타 쿼리는
         * `recordedAt > lastAggregatedAt` 이라 한 번 집계가 돌고 나면 같은 문서를 다시
         * 잡지 않기 때문이다. 게다가 「최근 7일」 시각 칸은 캐시에 남기지 않고 매번 새로
         * 세므로, 사라진 자리를 메워 줄 것도 없었다.
         * (2026-08-26 관측: 8/26 시각별 135 → 이튿날 91, 18–21시 67 → 19)
         *
         * 이제 기록 시각 축으로 직접 읽으므로 **언제 집계를 돌리든 같은 칸에 들어간다.**
         */
        mealsRecordedSnap.forEach((docSnap) => {
            const uid = userIdFromMealDocRef(docSnap.ref);
            if (!uid || excluded.has(uid)) return;
            const slot = hourSlotForMealDoc(docSnap.data());
            addHourRecord(slot);
            addRecordedUser(slot, uid);
        });

        if (useIncremental) {
            console.log('[대시보드] 증분 집계:', {
                rescanFrom: rescanStartKey,
                rescanFromWeekIndex: rescanFromIdx,
                since: lastAggregatedAt,
                rescanDocs: mealsRangeSnap.size ?? 0,
                retroDocs: mealsRetroSnap.size ?? 0,
                hourDocs: mealsRecordedSnap.size ?? 0
            });
        } else if (useMirror) {
            console.log('[대시보드] 미러 전량 집계:', {
                meals: mirrorSource.mealRows.length,
                users: mirrorSource.userRows.length,
                sharedPhotos: mirrorSource.sharedDocs.length,
                동기화: mirrorSource.syncModes,
                서버읽기: mirrorSource.serverReads
            });
        }

        try {
            if (useIncremental) {
                // 증분에서는 미러가 정본이라 config 를 아예 읽지 않는다 (아래 skip 참조)
                throw { code: 'skip-config-scan' };
            }
            /**
             * 하루 소감 자국 — `{uid, dateStr, recordedAt}` 목록.
             *
             * 미러 모드에서는 users 미러가 settings 를 읽을 때 함께 담아 둔 것을 쓴다
             * (읽기 0회). 서버 모드에서는 예전처럼 `collectionGroup('config')` 를 훑는다 —
             * 사용자 수만큼 문서를 사 오는, 전량 집계에서 두 번째로 비싼 자리였다.
             */
            let journalMarks;
            if (useMirror) {
                journalMarks = journalMarksFromUserRows(mirrorSource.userRows, excluded);
            } else {
                const configGroup = collectionGroup(db, 'config');
                const configSnap = await getDocs(query(configGroup, limit(DASHBOARD_DAILY_JOURNAL_CONFIG_SCAN_CAP)));
                journalMarks = [];
                configSnap.forEach((docSnap) => {
                    if (docSnap.id !== 'settings') return;
                    const uid = userIdFromMealDocRef(docSnap.ref);
                    if (!uid || excluded.has(uid)) return;
                    const dc = docSnap.data()?.dailyComments;
                    if (!dc || typeof dc !== 'object') return;
                    for (const [dateStr, raw] of Object.entries(dc)) {
                        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) continue;
                        const entry = normalizeDailyJournalEntry(raw);
                        if (!dailyJournalHasContent(entry)) continue;
                        journalMarks.push({ uid, dateStr, recordedAt: entry.recordedAt || '' });
                    }
                });
            }
            journalMarks.forEach(({ uid, dateStr, recordedAt }) => {
                dailyJournalAll++;
                const wi = weekIndexForDateKeyStr(dateStr, sundayKeyToIndex);
                const mirrored = mirroredJournalKeys.has(`${uid}|${dateStr}`);
                /**
                 * 「다시 세는 구간」은 증분에서만 뜻이 있다. dailyComments 는 맵이라
                 * 「어느 항목이 새로 생겼는지」를 문서 단위로 가릴 수 없어, 증분에서는 전량을
                 * 훑되 구간 밖은 세지 않는다 — 그 몫은 캐시에 이미 들어 있다.
                 * 전량·미러 모드는 캐시를 쓰지 않으므로 항상 참이다.
                 */
                const inRescanWindow = !useIncremental || dateStr >= rescanStartKey;
                if (!mirrored && inRescanWindow) {
                    if (wi >= 0) dailyJournalUnmirroredByWeek[wi]++;
                    // 미러가 있는 몫은 meals 스캔에서 이미 시간대에 넣었다
                    const jSlot = hourSlotForJournalEntry(dateStr, { recordedAt });
                    addHourRecord(jSlot);
                    addRecordedUser(jSlot, uid);
                }
                if (wi >= 0 && inRescanWindow) dailyJournalByWeek[wi]++;
                if (dateStr === todayStr) {
                    dailyJournalToday++;
                    if (!mirrored) dailyJournalUnmirroredToday++;
                }
                if (dateStr >= last7FirstStr && dateStr <= todayStr) {
                    dailyJournalLast7++;
                    const rdi = last7IndexMap.get(dateStr);
                    if (rdi != null && rdi >= 0) dailyJournalByDay[rdi]++;
                    if (!mirrored) {
                        dailyJournalUnmirroredLast7++;
                        if (rdi != null && rdi >= 0) dailyJournalUnmirroredByDay[rdi]++;
                    }
                }
            });
            journalCountedFromSource = true;
        } catch (djErr) {
            if (djErr?.code !== 'skip-config-scan') {
                console.warn(
                    '⚠️ 하루 기록(dailyComments) 집계 실패 — 미러만으로 셉니다:',
                    djErr?.code || djErr?.message || djErr
                );
            }
        }
        stats.dailyJournal.all = dailyJournalAll;
        stats.dailyJournal.today = dailyJournalToday;
        stats.dailyJournal.last7 = dailyJournalLast7;

        /**
         * 사용자 메모. 하루 소감과 달리 되찾을 것이 없다 — meals 가 정본이라
         * 「전체」는 count 쿼리(또는 미러 전량)가 이미 정확하고, 최근 7일·오늘은
         * 다시 세는 구간 안이라 스캔이 빠짐없이 훑는다.
         */
        const memoAgg = slotAgg[MEMO_SLOT_ID];
        stats.memo.all = Math.max(0, slotAllArr[MEMO_COUNT_INDEX] ?? 0);
        stats.memo.today = memoAgg.today;
        stats.memo.last7 = memoAgg.last7;

        /**
         * 「전체」는 스캔 구간 밖 날짜도 포함해야 해서 미러 키 집합(구간 내)만으로는 못 뺀다.
         * meals 전량 count 에 섞여 있는 미러 문서 수를 통째로 덜어내고 dailyComments 전량을 얹는다.
         */
        const journalMirrorAll = Math.max(0, slotAllArr[JOURNAL_MIRROR_COUNT_INDEX] ?? 0);
        /**
         * 하루 소감은 config 와 meals 미러 양쪽에 있어 그냥 더하면 두 번 세어진다.
         * 그래서 미러를 덜어내고 소감 쪽을 얹는데 — **그 출처를 못 읽었다면 얘기가 다르다.**
         * 그때는 미러가 유일한 출처라 덜어내면 그대로 사라진다.
         */
        stats.records.all = journalCountedFromSource
            ? Math.max(0, recordsAllCount - journalMirrorAll) + dailyJournalAll
            : recordsAllCount;
        stats.records.today = recordsToday + dailyJournalUnmirroredToday;
        stats.records.last7 = recordsLast7 + dailyJournalUnmirroredLast7;
        for (let di = 0; di < 7; di++) {
            recordsByDay[di] += dailyJournalUnmirroredByDay[di];
        }
        for (let wi = 0; wi < nWeeks; wi++) {
            recordsByWeek[wi] += dailyJournalUnmirroredByWeek[wi];
        }

        SLOTS.forEach((s, i) => {
            const a = slotAgg[s.id];
            stats.recordsBySlot[s.id] = {
                all: slotAllArr[i] ?? 0,
                last7: a.last7,
                today: a.today
            };
        });

        HOUR_BUCKETS.forEach((b) => {
            const a = hourAgg[b.id];
            stats.recordsByHour[b.id] = {
                // 슬롯의 all과 달리 「운영 시작일 이후」 합계다 (표에 각주로 밝힌다)
                all: a.rangeAll,
                last7: a.last7,
                today: a.today
            };
        });

        /**
         * 「기록이 하나라도 있는 사람」 — 활성 사용자·전체.
         * 서버 경로에서는 사용자 한 명당 count 쿼리를 한 번씩 던졌다(사용자가 늘면 그대로 는다).
         */
        if (useMirror) {
            distinctMealUserIds(mirrorSource.mealRows, excluded).forEach((uid) => activeUserSets.all.add(uid));
        } else {
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
                const ck = dateKeyFromLocalDate(createdDateOnly);
                joinKeyByUid.set(userDoc.id, ck || '');
                newUserSetAll.add(userDoc.id);
                stats.newUsers.all++;
                if (inPeriod(createdDateOnly, 'today')) stats.newUsers.today++;
                if (inPeriod(createdDateOnly, 'last7')) stats.newUsers.last7++;
                const ndi = last7DayIndex(createdDateOnly);
                if (ndi >= 0) {
                    newUsersByDay[ndi]++;
                    newUserSetsByDay[ndi].add(userDoc.id);
                }
                const wi = ck ? weekIndexForDateKeyStr(ck, sundayKeyToIndex) : -1;
                if (wi >= 0) {
                    newUsersByWeek[wi]++;
                    newUserSetsByWeek[wi].add(userDoc.id);
                }
            } else {
                joinKeyByUid.set(userDoc.id, '');
            }
        });
        stats.totalUsers = Math.max(usersFromCollection, stats.newUsers.all);

        try {
            let sharedAll;
            if (useMirror) {
                sharedAll = mirrorSource.sharedDocs.filter(
                    (d) => !excluded.has(String(d.data()?.userId || ''))
                ).length;
            } else {
                sharedAll = await countQ(query(sharedColl));
                for (const exUid of excluded) {
                    sharedAll -= await countQ(query(sharedColl, where('userId', '==', exUid)));
                }
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
            // 공유는 소급이 없다 — timestamp 가 곧 공유한 순간이라 과거 칸은 다시 바뀌지 않는다
            const tsRangeLo = Timestamp.fromDate(useIncremental ? rescanStartDate : firstSunDate);

            const tsRangeLoMs = tsRangeLo.toDate().getTime();
            const sharedRangeSnap = useMirror
                ? snapshotFromDocs(
                      mirrorSource.sharedDocs.filter((d) => {
                          const raw = d.data()?.timestamp;
                          const ts = raw && raw.toDate ? raw.toDate() : null;
                          if (!ts || Number.isNaN(ts.getTime())) return false;
                          // 서버 쿼리와 같은 반열린 구간 [시작, 내일 0시)
                          return ts.getTime() >= tsRangeLoMs && ts.getTime() < tTomorrow;
                      })
                  )
                : await getDocs(
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
        /**
         * 「전체」는 누적이라 축과 무관하다 — 어느 날 적었든 「기록이 하나라도 있는 사람」은
         * 같은 집합이다. 그래서 활성 사용자의 전체를 그대로 쓴다(추가 읽기 0).
         * 축이 갈리는 것은 날짜 칸뿐이고, 그건 아래 recordedUserSets 가 센다.
         */
        stats.recordedUsers.all = activeUserSets.all.size;
        stats.recordedUsers.last7 = recordedUserSetsLast7.size;
        stats.recordedUsers.today = recordedUserSetsToday.size;
        stats.totalMeals = stats.records.all;

        const recordsBySlotBreakdown = {};
        for (const s of SLOTS) {
            recordsBySlotBreakdown[s.id] = [...slotAgg[s.id].byDay];
        }
        stats.last7Breakdown = {
            dates: last7DateKeys,
            newUsers: [...newUsersByDay],
            activeUsers: activeSetsByDay.map((s) => s.size),
            recordedUsers: recordedUserSetsByDay.map((s) => s.size),
            records: [...recordsByDay],
            recordsBySlot: recordsBySlotBreakdown,
            recordsByHour: Object.fromEntries(HOUR_BUCKETS.map((b) => [b.id, [...hourAgg[b.id].byDay]])),
            sharedPhotos: [...sharedByDayCounts],
            dailyJournal: [...dailyJournalByDay],
            memo: [...slotAgg[MEMO_SLOT_ID].byDay]
        };

        stats.weeklyBreakdown =
            nWeeks > 0
                ? (() => {
                      const weeksPayload = weekMetas.map((w) => ({
                          sundayKey: w.sundayKey,
                          label: w.label,
                          year: w.year,
                          monthIndex: w.monthIndex
                      }));
                      const mg = buildMonthHeaderGroupsWithStarts(weeksPayload);
                      const computedActive = activeSetsByWeek.map((x) => x.size);
                      const computedMonthUnique = computeMonthUniqueFromWeekSets(activeSetsByWeek, mg);
                      const computedRecorded = recordedUserSetsByWeek.map((x) => x.size);
                      const computedRecordedMonthUnique = computeMonthUniqueFromWeekSets(recordedUserSetsByWeek, mg);

                      if (!useIncremental) {
                          return {
                              weeks: weeksPayload,
                              newUsers: [...newUsersByWeek],
                              activeUsers: computedActive,
                              activeUsersMonthUnique: computedMonthUnique,
                              recordedUsers: computedRecorded,
                              recordedUsersMonthUnique: computedRecordedMonthUnique,
                              records: [...recordsByWeek],
                              recordsBySlot: Object.fromEntries(SLOTS.map((x) => [x.id, [...slotAgg[x.id].byWeek]])),
                              recordsByHour: Object.fromEntries(HOUR_BUCKETS.map((b) => [b.id, [...hourAgg[b.id].byWeek]])),
                              sharedPhotos: sharedSetsByWeek.map((x) => x.size),
                              dailyJournal: [...dailyJournalByWeek],
                              memo: [...slotAgg[MEMO_SLOT_ID].byWeek]
                          };
                      }

                      const cw = cachedForIncremental.weeklyBreakdown || {};
                      // 세는 값(덧셈이 성립하는 것)은 캐시 + 소급분, 다시 센 구간은 덮어쓴다.
                      // rescanned 와 retroDelta 에 같은 배열을 넘기는 것이 맞다 —
                      // 소급분은 구간 밖만 통과했으므로 두 역할이 한 배열에 겹치지 않는다.
                      const mergeCount = (cached, computed) =>
                          mergeWeeklyArray(cached, computed, computed, rescanFromIdx, nWeeks);

                      const mergeUnique = mergeUniqueArray;

                      // 월 유니크도 같은 규칙. 다시 센 주차를 하나라도 품은 월부터 새로 쓴다.
                      let monthFromIdx = mg.length;
                      for (let gi = 0; gi < mg.length; gi++) {
                          if (mg[gi].startWeekIndex + mg[gi].span > rescanFromIdx) {
                              monthFromIdx = gi;
                              break;
                          }
                      }

                      return {
                          weeks: weeksPayload,
                          // 가입일은 나중에 바뀌지 않으므로 과거 칸은 캐시 그대로 남는다
                          newUsers: mergeCount(cw.newUsers, newUsersByWeek),
                          activeUsers: mergeUnique(cw.activeUsers, computedActive, rescanFromIdx, nWeeks),
                          activeUsersMonthUnique: mergeUnique(
                              cw.activeUsersMonthUnique,
                              computedMonthUnique,
                              monthFromIdx,
                              mg.length
                          ),
                          // 다시 세는 구간은 recordedAt 축으로 통째로 다시 읽으므로 그대로 신뢰한다
                          recordedUsers: mergeUnique(cw.recordedUsers, computedRecorded, rescanFromIdx, nWeeks),
                          recordedUsersMonthUnique: mergeUnique(
                              cw.recordedUsersMonthUnique,
                              computedRecordedMonthUnique,
                              monthFromIdx,
                              mg.length
                          ),
                          records: mergeCount(cw.records, recordsByWeek),
                          recordsBySlot: mergeWeeklyMap(
                              SLOTS.map((x) => x.id),
                              cw.recordsBySlot,
                              Object.fromEntries(SLOTS.map((x) => [x.id, slotAgg[x.id].byWeek])),
                              Object.fromEntries(SLOTS.map((x) => [x.id, slotAgg[x.id].byWeek])),
                              rescanFromIdx,
                              nWeeks
                          ),
                          recordsByHour: mergeWeeklyMap(
                              HOUR_BUCKETS.map((b) => b.id),
                              cw.recordsByHour,
                              Object.fromEntries(HOUR_BUCKETS.map((b) => [b.id, hourAgg[b.id].byWeek])),
                              Object.fromEntries(HOUR_BUCKETS.map((b) => [b.id, hourAgg[b.id].byWeek])),
                              rescanFromIdx,
                              nWeeks
                          ),
                          // 공유 게시물 수는 유니크라 더할 수 없다 (같은 게시물의 사진 여러 장)
                          sharedPhotos: mergeUnique(
                              cw.sharedPhotos,
                              sharedSetsByWeek.map((x) => x.size),
                              rescanFromIdx,
                              nWeeks
                          ),
                          dailyJournal: mergeCount(cw.dailyJournal, dailyJournalByWeek),
                          memo: mergeCount(cw.memo, slotAgg[MEMO_SLOT_ID].byWeek)
                      };
                  })()
                : null;

        /**
         * 시간대 「전체」는 스캔 구간의 합계다. 증분에서는 구간이 좁아 그대로 두면 확 줄어 보이므로,
         * 병합된 주차 배열의 합으로 되찾는다 — 정의상 같은 값이다.
         */
        if (useIncremental && stats.weeklyBreakdown) {
            const sumArr = (arr) => (Array.isArray(arr) ? arr.reduce((x, y) => x + (Number(y) || 0), 0) : null);

            for (const b of HOUR_BUCKETS) {
                const n = sumArr(stats.weeklyBreakdown.recordsByHour?.[b.id]);
                if (n != null) stats.recordsByHour[b.id].all = n;
            }

            /**
             * 하루 소감 「전체」도 같은 이유로 되찾는다 — 증분에서는 config 를 읽지 않으므로
             * 위에서 센 dailyJournalAll 은 다시 센 구간의 미러뿐이다.
             * 하루 소감 기능은 운영 시작일보다 늦게 생겨서, 주차 밖에 남은 소감은 없다.
             */
            const djAll = sumArr(stats.weeklyBreakdown.dailyJournal);
            if (djAll != null) {
                stats.dailyJournal.all = djAll;
                stats.records.all = Math.max(0, recordsAllCount - journalMirrorAll) + djAll;
                stats.totalMeals = stats.records.all;
            }

            /**
             * 신규 사용자 「전체」. 증분에서는 최근 가입자만 읽었으므로 그대로 쓰면 확 줄어든다.
             * 주차 합으로는 **운영 시작일 이전 가입자**가 빠지는데, 그 인원은 캐시가 알고 있다
             * (캐시의 전체 − 캐시의 주차 합). 가입일은 바뀌지 않으니 이 값도 고정이다.
             */
            const mergedNewWeekSum = sumArr(stats.weeklyBreakdown.newUsers);
            if (mergedNewWeekSum != null) {
                stats.newUsers.all = totalWithOutsideWeeks(
                    mergedNewWeekSum,
                    cachedForIncremental?.newUsers?.all,
                    sumArr(cachedForIncremental?.weeklyBreakdown?.newUsers)
                );
                stats.totalUsers = Math.max(usersFromCollection, stats.newUsers.all);
            }
        }

        // 드릴다운 명단(UID) — 캐시 본문(payload)에는 넣지 않고 drilldown 하위 문서로만 저장한다
        /**
         * 증분에서는 다시 센 구간의 UID 만 손에 있다.
         * 주차 문서는 비면 건너뛰므로(writeDashboardUserDrilldown) 과거가 보존되지만,
         * 「전체」 문서는 통째로 덮어쓰기 때문에 저장을 막아야 한다.
         */
        stats.userSetsPartial = useIncremental;
        stats.userSets = {
            weeks: weekMetas.map((w, i) => ({
                sundayKey: w.sundayKey,
                active: [...activeSetsByWeek[i]],
                new: [...newUserSetsByWeek[i]],
                // uid → 그 주 기록 일수
                dayCounts: Object.fromEntries([...weekDaySetsByUid[i]].map(([u, s]) => [u, s.size]))
            })),
            last7: {
                dates: last7DateKeys,
                byDate: Object.fromEntries(
                    last7DateKeys.map((k, i) => [
                        k,
                        {
                            active: [...activeSetsByDay[i]],
                            new: [...newUserSetsByDay[i]],
                            // uid → 그날 기록 건수 (하루는 0/1뿐이라 일수 대신 건수)
                            counts: Object.fromEntries(dayRecordCountsByUid[i])
                        }
                    ])
                )
            },
            all: {
                active: [...activeUserSets.all],
                new: [...newUserSetAll],
                joinKeys: Object.fromEntries(joinKeyByUid)
            }
        };

        stats.aggregationMode = useIncremental ? 'incremental' : useMirror ? 'mirror' : 'full';
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

/**
 * 주차 칸 밖의 고정 칸(전체·7일 합·7일 일별)에도 명단 드릴다운을 단다.
 * 주차 칸은 fillAdminDashboardWeeklyCells에서 처리한다.
 */
function markFixedUserDrilldownCells(stats, bd) {
    const rows = [
        { kind: 'newUsers', allId: 'statNewUsersAll', sumId: 'statNewUsers7Sum', dayPrefix: 'statNewUsers7d' },
        { kind: 'activeUsers', allId: 'statActiveUsersAll', sumId: 'statActiveUsers7Sum', dayPrefix: 'statActiveUsers7d' }
    ];
    for (const r of rows) {
        const stat = r.kind === 'newUsers' ? stats?.newUsers : stats?.activeUsers;
        markDashboardDrilldownCell(document.getElementById(r.allId), {
            kind: r.kind,
            scope: 'all',
            keys: ['all'],
            label: '전체 기간',
            count: Number(stat?.all) || 0
        });
        markDashboardDrilldownCell(document.getElementById(r.sumId), {
            kind: r.kind,
            scope: 'last7',
            keys: ['last7'],
            label: '최근 7일',
            count: Number(stat?.last7) || 0
        });
        const dailyVals = r.kind === 'newUsers' ? bd?.newUsers : bd?.activeUsers;
        for (let i = 0; i < 7; i++) {
            const td = document.getElementById(`${r.dayPrefix}${i}`);
            const dk = bd?.dates?.[i];
            markDashboardDrilldownCell(td, {
                kind: r.kind,
                scope: 'day',
                keys: dk ? [dk] : [],
                label: dk || '',
                count: Number(dailyVals?.[i]) || 0
            });
        }
    }
    // 「최근 7일」 헤더 클릭 → 일자별 출석 표
    const head7d = document.getElementById('dashboardHead7dTop');
    if (head7d && bd?.dates?.length === 7) {
        markDashboardDrilldownHeader(head7d, { scope: 'last7', keys: bd.dates, label: '최근 7일' });
    } else if (head7d) {
        clearDashboardDrilldownCell(head7d);
    }
}

/** 통계 객체를 화면에 반영 + 마지막 업데이트 문구 */
export function renderDashboardStats(stats, updatedAt, last7BreakdownOverride = null, fullAggregatedAt = null) {
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
        set('statRecordedUsersAll', stats.recordedUsers?.all);
        set('statRecordsAll', stats.records?.all);
        set('statSharedAll', stats.sharedPhotos?.all);
        // 「메모」행은 하루 소감과 사용자 메모를 합쳐 보여준다 (dashboard-memo-row.js 주석 참조)
        const memoAllSum = sumMemoRowTotals(stats.dailyJournal?.all, stats.memo?.all);
        const memoLast7Sum = sumMemoRowTotals(stats.dailyJournal?.last7, stats.memo?.last7);
        const memoByDay = sumMemoRowArrays(bd?.dailyJournal, bd?.memo);
        set('statMemoAll', memoAllSum);

        renderDashboard7dHeaders(bd?.dates);
        fillDashboard7dNumericRow('statNewUsers7d', bd?.newUsers, stats.newUsers?.last7);
        fillDashboard7dNumericRow('statActiveUsers7d', bd?.activeUsers, stats.activeUsers?.last7);
        fillDashboard7dNumericRow('statRecordedUsers7d', bd?.recordedUsers, stats.recordedUsers?.last7);
        fillDashboard7dNumericRow('statRecords7d', bd?.records, stats.records?.last7);
        fillDashboard7dNumericRow('statShared7d', bd?.sharedPhotos, stats.sharedPhotos?.last7);
        fillDashboard7dNumericRow('statMemo7d', memoByDay, memoLast7Sum);

        set('statNewUsers7Sum', sumSevenDaily(bd?.newUsers) ?? stats.newUsers?.last7);
        set('statActiveUsers7Sum', stats.activeUsers?.last7);
        set('statRecordedUsers7Sum', stats.recordedUsers?.last7);
        set('statRecords7Sum', sumSevenDaily(bd?.records) ?? stats.records?.last7);
        set('statShared7Sum', sumSevenDaily(bd?.sharedPhotos) ?? stats.sharedPhotos?.last7);
        set('statMemo7Sum', sumSevenDaily(memoByDay) ?? memoLast7Sum);

        SLOTS.forEach((s) => {
            const d = stats.recordsBySlot?.[s.id] || { all: 0, last7: 0, today: 0 };
            set(`statRecSlot_${s.id}_all`, d.all);
            const bdSlot = bd?.recordsBySlot?.[s.id];
            fillDashboard7dNumericRow(`statRecSlot_${s.id}_7d`, bdSlot, d.last7);
            set(`statRecSlot_${s.id}_7Sum`, sumSevenDaily(bdSlot) ?? d.last7);
        });

        const hasHour = stats.recordsByHour && Object.keys(stats.recordsByHour).length > 0;
        const hourTotals = hasHour
            ? HOUR_BUCKETS.reduce(
                  (acc, b) => {
                      const d = stats.recordsByHour[b.id];
                      acc.all += Number(d?.all) || 0;
                      acc.last7 += Number(d?.last7) || 0;
                      return acc;
                  },
                  { all: 0, last7: 0 }
              )
            : null;
        // 새로고침 직후에는 캐시를 거치지 않은 breakdown 이 들어와 파생 합계가 없다 — 여기서 만든다
        const hourTotalByDay = sumHourBucketArrays(bd?.recordsByHour, 7);
        set('statRecHourTotal_all', hourTotals ? hourTotals.all : null);
        fillDashboard7dNumericRow('statRecHourTotal_7d', hourTotalByDay, hourTotals?.last7);
        set('statRecHourTotal_7Sum', sumSevenDaily(hourTotalByDay) ?? hourTotals?.last7);

        HOUR_BUCKETS.forEach((b) => {
            const d = hasHour ? (stats.recordsByHour[b.id] || { all: 0, last7: 0, today: 0 }) : null;
            set(`statRecHour_${b.id}_all`, d ? d.all : null);
            const bdHour = bd?.recordsByHour?.[b.id];
            fillDashboard7dNumericRow(`statRecHour_${b.id}_7d`, bdHour, d?.last7);
            set(`statRecHour_${b.id}_7Sum`, sumSevenDaily(bdHour) ?? d?.last7);
        });
    } else {
        const recordSlotAll = SLOTS.map((s) => `statRecSlot_${s.id}_all`);
        const recordHourAll = ['statRecHourTotal_all', ...HOUR_BUCKETS.map((b) => `statRecHour_${b.id}_all`)];
        ['statNewUsersAll', 'statActiveUsersAll', 'statRecordedUsersAll', 'statRecordsAll', 'statSharedAll', 'statMemoAll', ...recordSlotAll, ...recordHourAll].forEach(
            (id) => set(id, null)
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
    markFixedUserDrilldownCells(stats, bd);
    ensureDashboardDrilldownBinding();

    const fmtStamp = (v) => {
        if (!v) return null;
        const d = v.toDate ? v.toDate() : new Date(v);
        return Number.isNaN(d.getTime())
            ? null
            : d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    };

    const label = document.getElementById('dashboardStatsUpdatedAt');
    if (label) {
        const t = fmtStamp(updatedAt);
        label.textContent = t ? `최근 업데이트: ${t}` : '캐시된 통계가 없습니다. 「새로고침」을 눌러 주세요.';
    }
    const fullLabel = document.getElementById('dashboardStatsFullUpdatedAt');
    if (fullLabel) {
        const t = fmtStamp(fullAggregatedAt);
        fullLabel.textContent = t ? `전체 업데이트: ${t}` : '전체 업데이트: -';
        fullLabel.title = t
            ? '증분이 놓치는 수정·삭제·제외 UID 변경까지 반영한 시각. 주가 바뀌면 자동으로 다시 돕니다.'
            : '아직 전체 재집계를 돌린 적이 없습니다.';
    }
    scrollDashboardTrendTableToRight();
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
            recordsByHour: data.recordsByHour && typeof data.recordsByHour === 'object' ? data.recordsByHour : {},
            sharedPhotos: data.sharedPhotos || { all: 0, last7: 0, today: 0 },
            dailyJournal: data.dailyJournal || { all: 0, last7: 0, today: 0 },
            memo: data.memo || { all: 0, last7: 0, today: 0 },
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
        renderDashboardStats(stats, data.updatedAt, last7Breakdown, data.lastFullAggregatedAt || null);
        maybeStartWeeklyFullRefresh(data.lastFullAggregatedAt || null).catch((e) => {
            console.warn('[대시보드] 주간 정기 재집계 판단 실패:', e?.message || e);
        });
        let pageUsage = data.pageUsage || null;
        if (pageUsage && pageUsage.all && typeof pageUsage.all === 'object' && !pageUsageLast7ByFieldUsable(pageUsage)) {
            try {
                const r = await fetchPageUsageLast7FromUsageDaily();
                pageUsage = {
                    ...pageUsage,
                    last7Breakdown: { dates: r.dates, byField: r.byField },
                    last7Sum: r.last7Sum
                };
            } catch (repErr) {
                console.warn('페이지별 최근 7일 보정(usageDaily) 실패:', repErr?.message || repErr);
            }
        }
        renderDashboardPageUsage(pageUsage, { fallbackWeeklyBreakdown: stats.weeklyBreakdown });
    } catch (e) {
        console.error("대시보드 통계 로드 실패:", e);
        renderDashboardStats(null, null);
        renderDashboardPageUsage(null);
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * 새로고침.
 *
 * **로컬 미러가 기본 경로다.** meals·users·sharedPhotos 를 브라우저 사본에서 읽고,
 * 서버로는 변경분만 당겨온다. 그러면 「전량이라 비싸다」는 전제가 사라지므로
 * 집계는 **언제나 전량**이 된다 — 얼린 과거 주차도, 소급 delta 도 쓰지 않는다.
 *
 * 두 버튼의 차이는 이제 **미러를 얼마나 믿느냐**다.
 *   새로고침      미러 델타 동기화 → 전량 재계산
 *   전체 재집계    미러를 통째로 다시 받고(`full`) → 전량 재계산
 *
 * 미러를 못 쓰면(첫 실행 실패·인덱스 미배포·저장소 거부) 예전 서버 경로로 물러난다.
 * 그때는 옛 규칙 그대로 — 기본이 증분, `full` 이 전량이다.
 */
export async function refreshDashboardStats(options = {}) {
    const full = options?.full === true;
    /**
     * 미러를 통째로 다시 받을지. 기본은 `full` 을 따르되 따로 끌 수 있다 —
     * 주간 정기 재집계처럼 **사람이 누르지 않은** 경로가 화면을 여는 순간 부트스트랩
     * 1.2만 읽기를 부르면, 미러로 없앤 비용이 그대로 돌아온다.
     */
    const forceMirror = options?.forceMirror ?? full;
    // 주간 정기 재집계는 사람이 누른 게 아니다 — 실패했다고 경고창을 띄우면 안 된다
    const silent = options?.silent === true;
    try {
        await runAdminRefreshAction(
            // 「전체 재집계」 버튼은 미러 콘솔로 옮겨졌다 — full 이어도 새로고침 버튼을 잠가
            // 대시보드 탭에서도 진행 중임이 보이게 한다 (동시에 또 누르는 것도 막는다)
            document.getElementById('dashboardStatsRefreshBtn'),
            async () => {
                const prevSnap = await getDoc(DASHBOARD_STATS_REF());
                const prevData = prevSnap.exists() ? prevSnap.data() : null;
                // 집계가 읽어들인 시점 — 다음 증분의 기준이 된다.
                // 집계 **전** 시각을 찍어야 도는 동안 들어온 기록을 다음 번에 놓치지 않는다.
                const aggregationStartedAt = new Date().toISOString();

                let mirrorSource = null;
                try {
                    mirrorSource = await loadDashboardMirrorSource({ force: forceMirror });
                } catch (mirrErr) {
                    console.warn(
                        '[대시보드] 로컬 미러를 쓸 수 없어 서버 집계로 돌아갑니다:',
                        mirrErr?.message || mirrErr
                    );
                }

                const statsOptions = mirrorSource
                    ? { mode: 'mirror', mirrorSource }
                    : full
                      ? { mode: 'full' }
                      : { mode: 'incremental', cached: prevData };
                const [stats, pageUsage] = await Promise.all([
                    getUserStatistics(statsOptions),
                    aggregatePageUsageFromFirestore(prevData, mirrorSource?.usageDailyDocs || null)
                ]);
                const payload = {
                    newUsers: stats.newUsers,
                    activeUsers: stats.activeUsers,
                    recordedUsers: stats.recordedUsers,
                    records: stats.records,
                    recordsBySlot: stats.recordsBySlot,
                    recordsByHour: stats.recordsByHour,
                    sharedPhotos: stats.sharedPhotos,
                    dailyJournal: stats.dailyJournal,
                    memo: stats.memo,
                    last7Breakdown: stats.last7Breakdown || null,
                    weeklyBreakdown: stats.weeklyBreakdown || null,
                    pageUsage,
                    asOfDate: getTodayDateString(),
                    lastAggregatedAt: aggregationStartedAt,
                    lastAggregationMode: stats.aggregationMode || (full ? 'full' : 'incremental'),
                    // lastFullAggregatedAt·weeklyFullRefreshClaim 은 아래 트랜잭션에서 정한다
                    updatedAt: serverTimestamp()
                };
                /**
                 * 전량 완료 도장(lastFullAggregatedAt)을 증분이 덮어 되돌리지 않게 한다.
                 *
                 * 집계는 몇 분이 걸린다. 그 사이에 주간 정기 전량이 끝나 도장을 찍었는데,
                 * 집계 **시작 전** 스냅샷인 prevData 에서 도장을 물려받아 merge 없는 setDoc 으로
                 * 덮으면 도장이 옛값으로 돌아간다. 그럼 다음 날 아침에 전량이 또 돌고,
                 * 한 번에 meals 전량을 다시 읽는다(실측 약 12.6K 읽기).
                 *
                 * 그래서 저장 직전에 서버 값을 다시 읽어, 증분은 **그때의 최신 도장**을 그대로
                 * 놓아둔다. 본문은 지금까지처럼 통째로 덮는다 — 옆가지로 불어난 옛 필드를 지우려면
                 * merge 없는 쓰기가 필요하기 때문이다.
                 */
                let finalFullAggregatedAt = null;
                await runTransaction(db, async (tx) => {
                    const curSnap = await tx.get(DASHBOARD_STATS_REF());
                    const serverStamp = curSnap.exists() ? curSnap.data()?.lastFullAggregatedAt || null : null;
                    // 미러 집계도 전량이다 — 얼린 구간이 없으므로 도장을 찍을 자격이 있다
                    const wasFull = stats.aggregationMode === 'full' || stats.aggregationMode === 'mirror';
                    finalFullAggregatedAt = wasFull ? aggregationStartedAt : serverStamp;
                    // 주간 재집계 빗장도 서버 값을 그대로 둔다 — merge 없는 쓰기라 빠뜨리면
                    // 전량이 도는 중에 누른 증분 새로고침이 빗장을 지워, 다른 탭이 같은 집계를
                    // 또 시작한다. (리스는 시간으로 풀리므로 남은 표식이 영영 잠그지는 않는다)
                    const serverClaim = curSnap.exists() ? curSnap.data()?.weeklyFullRefreshClaim || null : null;
                    tx.set(DASHBOARD_STATS_REF(), {
                        ...payload,
                        lastFullAggregatedAt: finalFullAggregatedAt,
                        weeklyFullRefreshClaim: serverClaim
                    });
                });
                // 아래 렌더링이 같은 값을 보도록 맞춰 둔다
                payload.lastFullAggregatedAt = finalFullAggregatedAt;
                // 명단(UID)은 본문 문서가 1MB 한계로 커지지 않도록 drilldown 하위 문서에 나눠 저장.
                // 실패해도 숫자 통계는 이미 저장됐으므로 새로고침 전체를 실패로 만들지 않는다.
                try {
                    await writeDashboardUserDrilldown(stats.userSets, { partial: stats.userSetsPartial === true });
                } catch (drillErr) {
                    console.warn('[대시보드] 사용자 명단 캐시 저장 실패:', drillErr?.message || drillErr);
                }
                let pageUsageToShow = pageUsage;
                try {
                    const verified = await getDocFromServer(DASHBOARD_STATS_REF());
                    const vpu = verified.exists() ? verified.data()?.pageUsage : null;
                    if (vpu && pageUsageLast7ByFieldUsable(vpu)) {
                        pageUsageToShow = vpu;
                    } else if (pageUsageLast7ByFieldUsable(pageUsage)) {
                        console.warn(
                            '[대시보드] 서버 캐시에 pageUsage.last7Breakdown.byField가 비어 있어 집계 직후 값으로 표시합니다. pageUsage만 다시 저장합니다.'
                        );
                        await setDoc(DASHBOARD_STATS_REF(), { pageUsage }, { merge: true });
                        pageUsageToShow = pageUsage;
                    }
                } catch (verErr) {
                    console.warn('[대시보드] 캐시 서버 확인 생략:', verErr?.message || verErr);
                }
                renderDashboardStats(stats, new Date(), stats.last7Breakdown, payload.lastFullAggregatedAt || null);
                renderDashboardPageUsage(pageUsageToShow, { fallbackWeeklyBreakdown: stats.weeklyBreakdown });
            },
            { loadingText: full ? '전체 재집계 중…' : '집계 중…' }
        );
    } catch (e) {
        console.error('대시보드 새로고침 실패:', e);
        if (!silent) {
            // 버튼으로 부른 경우엔 여기서 끝낸다 — 던지면 onclick 에 처리되지 않은 rejection 이 남는다
            alert('새로고침 중 오류가 발생했습니다: ' + (e.message || e));
            return;
        }
        throw e;
    }
}

/**
 * 한 탭 안에서 대시보드를 여러 번 오갈 때 매번 도는 것을 막는 1차 빗장.
 * 탭 사이는 이것으로 못 막으므로 `claimWeeklyFullRefresh` 가 이어받는다 —
 * 여기서 먼저 걸러 주는 덕에 흔한 경우에는 트랜잭션 왕복조차 하지 않는다.
 */
let weeklyFullRefreshStarted = false;

/**
 * 주간 재집계 빗장의 유효 기간.
 *
 * 빗장을 잡은 탭이 집계 도중 닫히면 표식만 남는다. 그래서 **시간으로 풀리는 리스**로 둔다
 * (`utils/with-deadline.js` 의 Lease 와 같은 이유 — 해제 코드에 도달해야만 풀리는 불린은
 * 어딘가에서 매달리면 영영 잠긴다). 이 시간이 지나면 버려진 것으로 보고 다른 탭이 다시 잡는다.
 * 전량 집계가 실제로 도는 시간보다 넉넉해야 하고, 한 주보다는 훨씬 짧아야 한다.
 */
const WEEKLY_FULL_REFRESH_LEASE_MS = 30 * 60 * 1000;

/**
 * 주간 전체 재집계를 이 탭이 맡을지 **탭 간에** 정한다.
 *
 * 모듈 변수 빗장(`weeklyFullRefreshStarted`)은 한 탭 안에서만 유효하다. 관리자가 탭을 두 개
 * 띄우면 각 탭이 따로 판단해 전량 집계를 각각 돌리는데, 한 번이 meals 1만 건대 스캔이라
 * 그대로 읽기 비용이 곱해진다. 그래서 표식을 캐시 문서에 두고 **트랜잭션으로** 잡는다 —
 * 둘이 동시에 읽고 동시에 쓰는 창을 없애려면 조건부 쓰기여야 한다.
 *
 * 실패하면 **잡지 않은 것으로 친다.** 못 잡아서 생기는 손해는 이번 주 숫자가 조금 늦게
 * 정리되는 것뿐이고(대시보드를 다음에 열 때 다시 시도한다), 잘못 잡아서 생기는 손해는
 * 전량 스캔이 한 번 더 도는 것이다. 비용이 큰 쪽을 피한다.
 *
 * @param {string} sundayKey 오늘이 속한 주의 일요일 키
 * @returns {Promise<boolean>} 이 탭이 맡기로 했는가
 */
async function claimWeeklyFullRefresh(sundayKey) {
    return withDeadlineOr(
        () =>
            runTransaction(db, async (tx) => {
                const snap = await tx.get(DASHBOARD_STATS_REF());
                const data = snap.exists() ? snap.data() : null;
                // 읽는 사이에 다른 탭이 이미 끝냈을 수 있다 — 트랜잭션 안에서 다시 본다
                if (!needsWeeklyFullRefresh(data?.lastFullAggregatedAt || null, sundayKey)) return false;
                const claim = data?.weeklyFullRefreshClaim;
                const claimedAt = Date.parse(claim?.at || '');
                const held =
                    claim?.sundayKey === sundayKey &&
                    !Number.isNaN(claimedAt) &&
                    Date.now() - claimedAt < WEEKLY_FULL_REFRESH_LEASE_MS;
                if (held) return false;
                tx.set(
                    DASHBOARD_STATS_REF(),
                    { weeklyFullRefreshClaim: { sundayKey, at: new Date().toISOString() } },
                    { merge: true }
                );
                return true;
            }),
        DEADLINE.DOC,
        false,
        'dashboard-weekly-full-refresh-claim'
    );
}

/**
 * 주가 바뀌었으면 전체 재집계를 **백그라운드로** 시작한다.
 *
 * 집계 로직이 클라이언트에 있어서 서버 cron 으로는 돌릴 수 없다. 관리자가 대시보드를
 * 여는 순간이 유일한 기회다. 화면은 캐시로 이미 그려져 있으므로 기다리게 하지 않고,
 * 끝나면 표가 새 숫자로 갈아 끼워진다.
 *
 * 실패해도 조용히 넘어간다 — 다음에 열 때 다시 시도한다.
 */
async function maybeStartWeeklyFullRefresh(lastFullAggregatedAt) {
    if (weeklyFullRefreshStarted) return;
    const todayKey = getTodayDateString();
    const sundayKey = sundayKeyForDateKey(todayKey);
    if (!needsWeeklyFullRefresh(lastFullAggregatedAt, sundayKey)) return;
    // 빗장을 잡으러 가기 전에 세운다 — 확보를 기다리는 동안 이 탭이 또 들어오지 않게
    weeklyFullRefreshStarted = true;

    const claimed = await claimWeeklyFullRefresh(sundayKey);
    if (!claimed) {
        console.log('[대시보드] 주간 정기 재집계는 다른 탭이 맡았거나 이미 끝났습니다 — 건너뜁니다', {
            sundayKey
        });
        // 그 탭이 끝내지 못하면 리스가 만료되고, 대시보드를 다시 열 때 이 탭이 잡는다
        weeklyFullRefreshStarted = false;
        return;
    }

    console.log('[대시보드] 주간 정기 전체 재집계를 시작합니다', { lastFullAggregatedAt, sundayKey });
    const fullLabel = document.getElementById('dashboardStatsFullUpdatedAt');
    if (fullLabel) fullLabel.textContent = '전체 업데이트: 정리 중…';
    // 미러는 강제로 다시 받지 않는다 — 자동 경로가 부트스트랩을 부르면 본전이 없다
    refreshDashboardStats({ full: true, silent: true, forceMirror: false }).catch((e) => {
        console.warn('[대시보드] 주간 정기 재집계 실패 — 다음에 다시 시도합니다:', e?.message || e);
        weeklyFullRefreshStarted = false;
        const el = document.getElementById('dashboardStatsFullUpdatedAt');
        if (el && el.textContent.includes('정리 중')) el.textContent = '전체 업데이트: -';
    });
}

/** 관리자 「전체 재집계」 — 증분이 놓친 수정·삭제·제외 UID 변경을 청소한다 */
export async function refreshDashboardStatsFull() {
    await refreshDashboardStats({ full: true });
}

// 공유 게시물 렌더링
export async function renderSharedPhotos() {
    const container = document.getElementById('sharedPhotosContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i data-lucide="loader-circle" class="text-2xl mb-2 lucide-spin"></i><p>로딩 중...</p></div>';
    
    try {
        const photos = await getSharedPhotos(100);
        
        if (photos.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400"><i data-lucide="images" class="text-2xl mb-2"></i><p>공유된 게시물이 없습니다.</p></div>';
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
                                    <i data-lucide="trash-2" class="mr-1"></i>삭제
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
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i data-lucide="triangle-alert" class="text-2xl mb-2"></i><p>게시물을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}
