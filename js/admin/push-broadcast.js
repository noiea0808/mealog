// ADMIN 브로드캐스트 푸시 (발송예정 관리)
import { app, db, appId, functions, auth } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { collection, query, orderBy, where, getDocs, limit, doc, setDoc, serverTimestamp, deleteDoc, Timestamp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, runAdminRefreshAction, afterAdminClick } from './utils.js';

// ========== 푸시메시지 관리 (관리자 브로드캐스트) ==========
const scheduleAdminBroadcastPushFn = httpsCallable(functions, 'scheduleAdminBroadcastPush');
const cancelAdminScheduledPushFn = httpsCallable(functions, 'cancelAdminScheduledPush');
const deleteAdminBroadcastHistoryFn = httpsCallable(functions, 'deleteAdminBroadcastHistory');
const updateAdminScheduledPushFn = httpsCallable(functions, 'updateAdminScheduledPush');
/** Cloud Functions `ADMIN_BROADCAST_*_MAX` 와 동일 */
const ADMIN_BROADCAST_TITLE_MAX = 120;
const ADMIN_BROADCAST_BODY_MAX = 240;
const ADMIN_PUSH_LANDING_LABELS = {
    dashboard: '밀당',
    timeline: '밀로그',
    gallery: '모먼트',
    board: '라운지',
    settings: '설정'
};
const ADMIN_SCHEDULED_PUSH_STATUS_LABELS = {
    pending: '예약됨',
    sending: '발송 중',
    sent: '발송 완료',
    completed: '주기 완료',
    failed: '실패',
    cancelled: '취소됨'
};

const ADMIN_PUSH_TARGET_ENV_LABELS = {
    all: '전체',
    production: '운영',
    staging: '스테이징'
};

const WEEKDAY_LABELS = ['', '월', '화', '수', '목', '금', '토', '일'];

function sortWeeklySlots(ws) {
    return [...(ws || [])].sort((a, b) => (Number(a.weekday) || 0) - (Number(b.weekday) || 0));
}

function tsToMillis(ts) {
    if (ts == null) return NaN;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return NaN;
}

/** 서버 `kstYmdFromMillis` / `addOneKstYmd` / `kstWeekdayMon1Sun7FromYmd` 와 동일 규칙 (발송일 나열용) */
function kstYmdFromMsClient(ms) {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function addOneKstYmdClient(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
    return dt.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function kstWeekdayMon1Sun7FromYmdClient(ymd) {
    const [Y, M, D] = ymd.split('-').map(Number);
    const noonUtc = Date.UTC(Y, M - 1, D, 3, 0, 0);
    const dowSun0 = new Date(noonUtc).getUTCDay();
    return dowSun0 === 0 ? 7 : dowSun0;
}

/**
 * 반복 기간(recurringStartAt~recurringEndAt) 안에서 weeklySchedule 요일에 해당하는 모든 날짜
 * @returns {string[]} 예: ['4/20 (월)', '4/27 (월)']
 */
function listWeeklyOccurrenceDateLabels(ws, recurringStartAt, recurringEndAt, maxRows = 24) {
    const slots = sortWeeklySlots(ws || []);
    if (!slots.length) return [];
    const slotWds = new Set(slots.map((s) => Number(s.weekday)));
    const rangeStartMs = tsToMillis(recurringStartAt);
    const rangeEndMs = tsToMillis(recurringEndAt);
    if (!Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) return [];
    const rangeEndYmd = kstYmdFromMsClient(rangeEndMs);
    const labels = [];
    let ymd = kstYmdFromMsClient(rangeStartMs);
    for (let guard = 0; guard < 400 && ymd <= rangeEndYmd && labels.length < maxRows; guard++) {
        const wd = kstWeekdayMon1Sun7FromYmdClient(ymd);
        if (slotWds.has(wd)) {
            const [Y, Mo, D] = ymd.split('-').map(Number);
            const noonUtc = Date.UTC(Y, Mo - 1, D, 12, 0, 0);
            const wdKo = new Intl.DateTimeFormat('ko-KR', {
                timeZone: 'Asia/Seoul',
                weekday: 'short'
            }).format(new Date(noonUtc));
            labels.push(`${Mo}/${D} (${wdKo})`);
        }
        if (ymd >= rangeEndYmd) break;
        ymd = addOneKstYmdClient(ymd);
    }
    return labels;
}

function formatWeeklyReservationDatesCellHtml(r, ws) {
    const labels = listWeeklyOccurrenceDateLabels(ws, r.recurringStartAt, r.recurringEndAt, 24);
    if (!labels.length) return formatAdminPushScheduledCellHtml(r);
    const lines = labels.map((l) => `<div class="tabular-nums">${escapeHtml(l)}</div>`).join('');
    return `<div class="flex flex-col items-center gap-0.5 leading-snug text-center">${lines}</div>`;
}

/** 발송 기록 테이블 — 요일별 행의 랜딩 열 (슬롯별 값 요약) */
function summarizeWeeklyLandingTabs(ws) {
    if (!ws || !Array.isArray(ws) || ws.length === 0) return '—';
    const keys = [...new Set(ws.map((s) => String(s.landingTab || 'timeline').trim()))];
    return keys.map((k) => ADMIN_PUSH_LANDING_LABELS[k] || k).join(' · ') || '—';
}

/** 발송 기록 테이블 — 요일별 행의 대상 환경 열 */
function summarizeWeeklyTargetEnvs(ws) {
    if (!ws || !Array.isArray(ws) || ws.length === 0) return '—';
    const keys = [
        ...new Set(
            ws.map((s) => (s.targetEnv === 'production' || s.targetEnv === 'staging' ? s.targetEnv : 'all'))
        )
    ];
    return keys.map((k) => ADMIN_PUSH_TARGET_ENV_LABELS[k] || k).join(' · ') || '—';
}

/** 제목 열: 슬롯이 하나면 그 제목, 모두 동일 제목이면 동일, 다르면 안내 문구 */
function weeklyScheduleTitleSummary(ws) {
    if (!ws || !Array.isArray(ws) || ws.length === 0) return '요일별 발송';
    const sorted = sortWeeklySlots(ws);
    const titles = sorted.map((s) => String(s.title || '').trim()).filter(Boolean);
    if (!titles.length) return '요일별 발송';
    const unique = [...new Set(titles)];
    if (unique.length === 1) return unique[0];
    return `요일별 · 제목 ${unique.length}종`;
}

/**
 * 내용 열 — 푸시 본문만. 요일·시각·랜딩·환경은 각각 예약일시·랜딩·대상환경 열에 있으므로
 * 슬롯 1개일 때는 메타 줄을 넣지 않는다. (여러 슬롯일 때만 요일·시각으로 구분)
 */
function formatWeeklyScheduleBodyHtml(ws) {
    if (!ws || !Array.isArray(ws) || ws.length === 0) return '—';
    const sorted = sortWeeklySlots(ws);
    const multi = sorted.length > 1;
    if (!multi) {
        const sole = sorted[0];
        const b = escapeHtml((sole.body || '').trim() || '—');
        return `<span class="text-xs text-slate-600 whitespace-pre-wrap break-words">${b}</span>`;
    }
    return sorted
        .map((s) => {
            const wd = WEEKDAY_LABELS[s.weekday] || s.weekday;
            const b = escapeHtml((s.body || '').trim() || '—');
            const meta = `<div class="text-[10px] text-slate-500">${escapeHtml(wd)} ${escapeHtml(s.time || '')}</div>`;
            const titleLine = `<div class="mt-0.5 text-xs font-bold text-slate-800">${escapeHtml(
                (s.title || '').trim() || '(제목 없음)'
            )}</div>`;
            const bodyBlock = `<div class="mt-0.5 text-xs text-slate-600 whitespace-pre-wrap break-words">${b}</div>`;
            return `<div class="mb-2 last:mb-0 pb-2 last:pb-0 border-b border-slate-100/80 last:border-0">${meta}${titleLine}${bodyBlock}</div>`;
        })
        .join('');
}

function formatAdminPushDate(ts) {
    if (!ts) return '—';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
        return '—';
    }
}

/** 테이블용: 날짜(요일) / 시간을 줄바꿈 HTML */
function formatAdminPushDateTimeStackedHtml(ts) {
    if (!ts) return '—';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        const datePart = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            weekday: 'short'
        }).format(d);
        const timePart = new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(d);
        return `<div class="leading-snug tabular-nums text-center"><div>${escapeHtml(datePart)}</div><div class="text-slate-500">${escapeHtml(timePart)}</div></div>`;
    } catch {
        return '—';
    }
}

/** 상태 뱃지: 초록=완료 · 노랑=대기/진행 · 빨강=실패·취소 */
function adminPushStatusBadgeClass(st) {
    if (st === 'sent' || st === 'completed') return 'bg-green-600 text-white';
    if (st === 'pending' || st === 'sending') return 'bg-yellow-400 text-gray-900';
    if (st === 'failed' || st === 'cancelled') return 'bg-red-600 text-white';
    return 'bg-yellow-400 text-gray-900';
}

/** 예약(또는 다음 발송) 시각 HTML — 즉시 발송 이력은 예약 없음 */
function formatAdminPushScheduledCellHtml(r) {
    const scheduleType = r.scheduleType || 'once';
    if (scheduleType === 'now') return '—';
    return formatAdminPushDateTimeStackedHtml(r.scheduledAt);
}

/** 실제 발송 완료 시각 HTML */
function formatAdminPushSentCellHtml(r) {
    const st = r.status || 'pending';
    if (st === 'failed' && r.failedAt) return formatAdminPushDateTimeStackedHtml(r.failedAt);
    if (st === 'cancelled' && r.cancelledAt) return formatAdminPushDateTimeStackedHtml(r.cancelledAt);
    if (st === 'pending' || st === 'sending') return '—';
    return formatAdminPushDateTimeStackedHtml(r.sentAt || r.lastSentAt);
}

function completedHistorySortMs(r) {
    const st = r.status || '';
    if (st === 'failed' && r.failedAt) return tsToMillis(r.failedAt);
    if (st === 'cancelled' && r.cancelledAt) return tsToMillis(r.cancelledAt);
    const vals = [tsToMillis(r.sentAt), tsToMillis(r.lastSentAt), tsToMillis(r.scheduledAt)].filter((x) =>
        Number.isFinite(x)
    );
    return vals.length ? Math.max(...vals) : 0;
}

/** 발송 기록 탭: upcoming | done */
let adminPushHistoryActiveTab = 'upcoming';
let adminPushHistoryRows = { upcoming: [], done: [] };
/** 발송예정 항목별 선택(체크박스) 상태 — jobId 집합 */
const adminPushSelectedIds = new Set();
/**
 * 인라인 작성/수정 초안 목록 — 저장 전까지 Firestore 미반영
 * { draftKey, mode: 'create'|'edit', jobId?, title, body, landingTab, targetEnv, scheduledAtMs, original? }
 */
let adminPushInlineDrafts = [];
let adminPushDraftKeySeq = 0;

function nextAdminPushDraftKey() {
    adminPushDraftKeySeq += 1;
    return `d${adminPushDraftKeySeq}`;
}

function findInlineDraftByKey(draftKey) {
    return adminPushInlineDrafts.find((d) => d.draftKey === draftKey) || null;
}

function findInlineEditDraftByJobId(jobId) {
    return adminPushInlineDrafts.find((d) => d.mode === 'edit' && d.jobId === jobId) || null;
}

function draftFieldId(draftKey, field) {
    return `adminPushDraft-${field}-${draftKey}`;
}

const ADMIN_PUSH_LAND_OPTIONS = [
    ['dashboard', '밀당'],
    ['timeline', '밀로그'],
    ['gallery', '모먼트'],
    ['board', '라운지'],
    ['settings', '설정']
];
const ADMIN_PUSH_ENV_OPTIONS = [
    ['all', '전체'],
    ['production', '운영'],
    ['staging', '스테이징']
];

/** 발송예정 탭에서 취소(선택) 가능한 행: pending 상태만 */
function isAdminPushRowSelectable(r) {
    return (r?.status || 'pending') === 'pending';
}

/** pending·단일(once, 요일별 개별 포함) 예약만 수정 가능 */
function isAdminPushRowEditable(r) {
    if (!isAdminPushRowSelectable(r)) return false;
    const isWeeklyByDay = r.recurringMode === 'weeklyByDay' && Array.isArray(r.weeklySchedule);
    return (r.scheduleType || 'once') === 'once' && !isWeeklyByDay;
}

function findUpcomingRowById(id) {
    return adminPushHistoryRows.upcoming.find((r) => r.id === id) || null;
}

/** ms → datetime-local 입력값(브라우저/관리자 로컬=KST 기준) */
function msToDatetimeLocalValue(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
        d.getMinutes()
    )}`;
}

function ensureAdminPushHistoryTabHandlers() {
    if (window._adminPushHistoryTabBound) return;
    window._adminPushHistoryTabBound = true;
    const bind = (id, tab) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
            captureAdminPushInlineDraftsFromDom();
            switchAdminPushHistoryTabUi(tab);
            renderAdminPushHistoryTableFromCache();
        });
    };
    bind('adminPushHistoryTabUpcoming', 'upcoming');
    bind('adminPushHistoryTabDone', 'done');
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function datetimeLocalMinAhead(minutesAhead = 1) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + minutesAhead * 60 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 발송예정 목록에서 예약 시각이 가장 늦은(마지막) 항목 */
function getLastUpcomingPushRow() {
    const rows = adminPushHistoryRows.upcoming;
    if (!rows.length) return null;
    return [...rows].sort((a, b) => tsToMillis(b.scheduledAt) - tsToMillis(a.scheduledAt))[0];
}

/** 행 데이터 → 모달 초안 (addDay: 예약일 +1일, 시각 유지) */
function pushRowToDraft(r, { addDay = false } = {}) {
    let ms = tsToMillis(r.scheduledAt);
    if (!Number.isFinite(ms)) ms = Date.now() + 86400000;
    if (addDay) {
        const whenVal = msToDatetimeLocalValue(ms);
        const timePart = (whenVal.split('T')[1] || '09:00').slice(0, 5);
        const nextYmd = addOneKstYmdClient(kstYmdFromMsClient(ms));
        const [y, m, d] = nextYmd.split('-').map(Number);
        const [hh, mm] = timePart.split(':').map(Number);
        ms = new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0).getTime();
    }
    return {
        title: String(r.title || '').trim(),
        body: String(r.body || '').trim(),
        landingTab: r.landingTab || 'timeline',
        targetEnv: r.targetEnv === 'production' || r.targetEnv === 'staging' ? r.targetEnv : 'all',
        scheduledAtMs: ms
    };
}

/** 기존 예약이 없을 때 빈 초안 (내일 오전 9시 KST 기준) */
function blankAdminPushDraft() {
    const tomorrowYmd = addOneKstYmdClient(kstYmdFromMsClient(Date.now()));
    const [y, m, d] = tomorrowYmd.split('-').map(Number);
    const scheduledAtMs = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
    const minMs = Date.now() + 60 * 1000;
    return {
        title: '',
        body: '',
        landingTab: 'timeline',
        targetEnv: 'staging',
        scheduledAtMs: scheduledAtMs > minMs ? scheduledAtMs : minMs
    };
}

/** 인라인 초안 입력값을 상태에 반영 (재렌더 시 유실 방지) */
function captureAdminPushInlineDraftsFromDom() {
    if (!adminPushInlineDrafts.length) return;
    adminPushInlineDrafts = adminPushInlineDrafts.map((draft) => {
        const key = draft.draftKey;
        const titleEl = document.getElementById(draftFieldId(key, 'title'));
        if (!titleEl) return draft;
        const bodyEl = document.getElementById(draftFieldId(key, 'body'));
        const landEl = document.getElementById(draftFieldId(key, 'landing'));
        const envEl = document.getElementById(draftFieldId(key, 'targetEnv'));
        const whenEl = document.getElementById(draftFieldId(key, 'when'));
        const whenVal = whenEl?.value || '';
        const at = whenVal ? new Date(whenVal) : null;
        return {
            ...draft,
            title: titleEl.value || '',
            body: bodyEl?.value || '',
            landingTab: landEl?.value || 'timeline',
            targetEnv: envEl?.value || 'staging',
            scheduledAtMs: at && !Number.isNaN(at.getTime()) ? at.getTime() : draft.scheduledAtMs
        };
    });
}

function isAdminPushInlineDraftDirty(d) {
    if (!d) return false;
    if (d.mode === 'edit' && d.original) {
        const o = d.original;
        return (
            String(d.title || '') !== String(o.title || '') ||
            String(d.body || '') !== String(o.body || '') ||
            String(d.landingTab || '') !== String(o.landingTab || '') ||
            String(d.targetEnv || '') !== String(o.targetEnv || '') ||
            Number(d.scheduledAtMs) !== Number(o.scheduledAtMs)
        );
    }
    return Boolean(String(d.title || '').trim()) || Boolean(String(d.body || '').trim());
}

/** 저장으로 Firestore에 반영된 항목 — 대상환경 왼쪽 표시 */
function adminPushSavedEnvBadgeHtml() {
    return `<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" title="저장됨"><i class="fa-solid fa-paper-plane text-[9px]" aria-hidden="true"></i></span>`;
}

function adminPushUnsavedEnvBadgeHtml() {
    return `<span class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-400" title="미저장"><i class="fa-solid fa-circle text-[6px]" aria-hidden="true"></i></span>`;
}

function switchAdminPushHistoryTabUi(tab) {
    adminPushHistoryActiveTab = tab;
    document.querySelectorAll('.admin-push-history-tab').forEach((btn) => {
        const on = btn.getAttribute('data-tab') === tab;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.classList.toggle('bg-white', on);
        btn.classList.toggle('text-violet-700', on);
        btn.classList.toggle('shadow-sm', on);
        btn.classList.toggle('ring-1', on);
        btn.classList.toggle('ring-violet-200/80', on);
        btn.classList.toggle('text-slate-500', !on);
        btn.classList.toggle('hover:text-slate-700', !on);
        btn.classList.toggle('hover:bg-white/70', !on);
    });
}

export async function loadAdminPushMessagesPage() {
    ensureAdminPushHistoryTabHandlers();
    adminPushHistoryActiveTab = 'upcoming';
    document.querySelectorAll('.admin-push-history-tab').forEach((btn) => {
        const on = btn.getAttribute('data-tab') === 'upcoming';
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.classList.toggle('bg-white', on);
        btn.classList.toggle('text-violet-700', on);
        btn.classList.toggle('shadow-sm', on);
        btn.classList.toggle('ring-1', on);
        btn.classList.toggle('ring-violet-200/80', on);
        btn.classList.toggle('text-slate-500', !on);
        btn.classList.toggle('hover:text-slate-700', !on);
        btn.classList.toggle('hover:bg-white/70', !on);
    });
    await refreshAdminScheduledPushesCore();
}

function buildAdminPushHistoryThead(showSelect) {
    const selectTh = showSelect
        ? `<th class="px-3 py-2.5 whitespace-nowrap w-8 text-center"><input type="checkbox" id="adminPushSelectAll" onchange="window.toggleAllAdminPushSelection(this.checked)" class="align-middle cursor-pointer" title="전체 선택"></th>`
        : '';
    return `
            <thead>
                <tr class="bg-slate-100/90 text-center text-[11px] font-bold text-slate-600 uppercase tracking-wide border-b border-slate-200">
                    ${selectTh}
                    <th class="px-3 py-2.5 whitespace-nowrap">대상환경</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">상태</th>
                    <th class="px-3 py-2.5 whitespace-nowrap min-w-[7rem]">예약일시</th>
                    <th class="px-3 py-2.5 whitespace-nowrap min-w-[7rem]">발송일시</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">수신자수</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">랜딩</th>
                    <th class="px-3 py-2.5 min-w-[8rem]">제목</th>
                    <th class="px-3 py-2.5 min-w-[12rem]">내용</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">작업</th>
                </tr>
            </thead>`;
}

function buildAdminScheduledPushRowHtml(r, showSelect = false) {
    const editDraft = findInlineEditDraftByJobId(r.id);
    if (editDraft) {
        return buildAdminPushInlineEditorRowHtml(editDraft, showSelect);
    }
    const st = r.status || 'pending';
    const stLabel = ADMIN_SCHEDULED_PUSH_STATUS_LABELS[st] || st;
    const isWeeklyByDay = r.recurringMode === 'weeklyByDay' && Array.isArray(r.weeklySchedule);
    const isWeeklyExpanded = r.scheduleSource === 'weeklyByDayExpanded';
    const ws = isWeeklyByDay ? r.weeklySchedule : null;
    const land = isWeeklyByDay
        ? summarizeWeeklyLandingTabs(ws)
        : (ADMIN_PUSH_LANDING_LABELS[r.landingTab] || r.landingTab || '—');
    const canCancel = st === 'pending';
    const canDelete = !canCancel;
    const rawTitle = (r.title || '').trim() || '(제목 없음)';
    const rawBody = (r.body || '').trim() || '—';
    const summaryTitle = isWeeklyByDay ? weeklyScheduleTitleSummary(ws) : rawTitle;
    const titleText = escapeHtml(summaryTitle);
    const bodyHtml = isWeeklyByDay ? formatWeeklyScheduleBodyHtml(ws) : escapeHtml(rawBody);
    const errTitle = r.errorMessage ? escapeHtml(String(r.errorMessage).slice(0, 300)) : '';
    const targetEnv = r.targetEnv === 'production' || r.targetEnv === 'staging' ? r.targetEnv : 'all';
    const targetEnvLabel = isWeeklyByDay
        ? summarizeWeeklyTargetEnvs(ws)
        : (ADMIN_PUSH_TARGET_ENV_LABELS[targetEnv] || ADMIN_PUSH_TARGET_ENV_LABELS.all);
    const canEdit = isAdminPushRowEditable(r);
    const rc = typeof r.recipientCount === 'number' && !Number.isNaN(r.recipientCount) ? String(r.recipientCount) : '—';
    const actionBtns = [
        canEdit
            ? `<button type="button" onclick='window.editAdminScheduledPush(${JSON.stringify(r.id)})' class="px-2 py-1 text-[11px] font-bold text-violet-700 bg-violet-50 hover:bg-violet-100 rounded border border-violet-100">수정</button>`
            : '',
        canCancel
            ? `<button type="button" onclick='window.cancelAdminScheduledPush(${JSON.stringify(r.id)})' class="px-2 py-1 text-[11px] font-bold text-red-600 bg-red-50 hover:bg-red-100 rounded border border-red-100">취소</button>`
            : '',
        canDelete
            ? `<button type="button" onclick='window.deleteAdminBroadcastHistory(${JSON.stringify(r.id)})' class="px-2 py-1 text-[11px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200">삭제</button>`
            : ''
    ]
        .filter(Boolean)
        .join(' ');
    const selectable = isAdminPushRowSelectable(r);
    const selectCell = showSelect
        ? `<td class="px-3 py-2 align-top text-center">${
              selectable
                  ? `<input type="checkbox" class="admin-push-select-item align-middle cursor-pointer mt-0.5" data-job-id="${escapeAttr(
                        r.id
                    )}" ${adminPushSelectedIds.has(r.id) ? 'checked' : ''} onchange="window.onAdminPushRowSelect(${JSON.stringify(
                        r.id
                    )}, this.checked)">`
                  : ''
          }</td>`
        : '';
    const titleAttr = isWeeklyByDay
        ? sortWeeklySlots(ws)
              .map((s) => `${WEEKDAY_LABELS[s.weekday] || ''} ${String(s.title || '').trim()}`.trim())
              .join(' · ')
              .slice(0, 400)
        : rawTitle;
    const titleCell = `<span class="line-clamp-2 text-slate-800 font-medium" title="${escapeAttr(titleAttr)}">${titleText}</span>`;
    const envCellInner = `<span class="inline-flex items-center justify-center gap-1.5">${adminPushSavedEnvBadgeHtml()}<span>${escapeHtml(targetEnvLabel)}</span></span>`;
    const actionCell = actionBtns
        ? `<div class="inline-flex flex-wrap justify-center gap-1">${actionBtns}</div>`
        : '—';
    return `
            <tr class="border-b border-slate-100 hover:bg-slate-50/80 align-top text-center">
                ${selectCell}
                <td class="px-3 py-2 text-xs text-slate-800 whitespace-nowrap">${envCellInner}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <span class="text-xs font-bold px-2 py-0.5 rounded-md ${adminPushStatusBadgeClass(st)}">${escapeHtml(stLabel)}</span>
                    ${errTitle ? `<div class="text-[10px] text-red-500 mt-1 max-w-[12rem] mx-auto">${errTitle}</div>` : ''}
                </td>
                <td class="px-3 py-2 text-xs text-slate-700 ${isWeeklyByDay ? 'min-w-[5.5rem]' : ''}">${
                    isWeeklyByDay ? formatWeeklyReservationDatesCellHtml(r, ws) : formatAdminPushScheduledCellHtml(r)
                }${
                    isWeeklyExpanded && r.weeklyBatchGroupId
                        ? `<div class="text-[10px] text-slate-400 mt-0.5 font-mono" title="같은 등록 묶음 ID">#${escapeHtml(String(r.weeklyBatchGroupId).slice(0, 8))}…</div>`
                        : ''
                }</td>
                <td class="px-3 py-2 text-xs text-slate-700">${formatAdminPushSentCellHtml(r)}</td>
                <td class="px-3 py-2 text-xs text-slate-800 tabular-nums">${escapeHtml(rc)}</td>
                <td class="px-3 py-2 text-xs text-violet-700 font-semibold whitespace-nowrap">${escapeHtml(land)}</td>
                <td class="px-3 py-2 text-xs text-slate-800 max-w-[14rem]">${titleCell}</td>
                <td class="px-3 py-2 text-xs text-slate-600 max-w-[28rem]">${isWeeklyByDay ? bodyHtml : `<span class="whitespace-pre-wrap break-words" title="${escapeAttr(rawBody)}">${bodyHtml}</span>`}</td>
                <td class="px-3 py-2 whitespace-nowrap">${actionCell}</td>
            </tr>`;
}

/** 인라인 작성/수정 편집 행 (create: 테이블 하단, edit: 해당 행 위치) */
function buildAdminPushInlineEditorRowHtml(draft, showSelect = true) {
    if (!draft?.draftKey) return '';
    const key = draft.draftKey;
    const isEdit = draft.mode === 'edit';
    const whenVal = msToDatetimeLocalValue(draft.scheduledAtMs);
    const minWhen = datetimeLocalMinAhead(1);
    const title = draft.title || '';
    const body = draft.body || '';
    const land = draft.landingTab || 'timeline';
    const targetEnv = draft.targetEnv || 'staging';
    const statusLabel = isEdit ? '수정중' : '작성중';
    const keyAttr = escapeAttr(key);
    const selectCell = showSelect ? '<td class="px-3 py-2 align-top text-center"></td>' : '';
    return `
            <tr id="adminPushDraftRow-${keyAttr}" class="border-b border-violet-200 bg-violet-50/40 align-top text-center" data-draft-key="${keyAttr}" data-draft-mode="${escapeAttr(draft.mode || 'create')}">
                ${selectCell}
                <td class="px-3 py-2 text-xs whitespace-nowrap">
                    <span class="inline-flex items-center justify-center gap-1.5">
                        ${adminPushUnsavedEnvBadgeHtml()}
                        <select id="${draftFieldId(key, 'targetEnv')}" class="min-w-[5.5rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center">${buildAdminPushFormOptions(ADMIN_PUSH_ENV_OPTIONS, targetEnv)}</select>
                    </span>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <span class="text-xs font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-800">${statusLabel}</span>
                </td>
                <td class="px-3 py-2 text-xs whitespace-nowrap">
                    <input type="datetime-local" id="${draftFieldId(key, 'when')}" value="${escapeAttr(whenVal)}" min="${escapeAttr(minWhen)}" class="w-[11.5rem] max-w-full mx-auto p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center">
                </td>
                <td class="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">—</td>
                <td class="px-3 py-2 text-xs text-slate-400">—</td>
                <td class="px-3 py-2 text-xs whitespace-nowrap">
                    <select id="${draftFieldId(key, 'landing')}" class="min-w-[5rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center">${buildAdminPushFormOptions(ADMIN_PUSH_LAND_OPTIONS, land)}</select>
                </td>
                <td class="px-3 py-2 text-xs max-w-[14rem]">
                    <input type="text" id="${draftFieldId(key, 'title')}" maxlength="${ADMIN_BROADCAST_TITLE_MAX}" value="${escapeAttr(title)}" placeholder="제목" class="w-full min-w-[8rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center">
                </td>
                <td class="px-3 py-2 text-xs max-w-[28rem]">
                    <textarea id="${draftFieldId(key, 'body')}" maxlength="${ADMIN_BROADCAST_BODY_MAX}" rows="2" placeholder="내용" class="w-full min-w-[12rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white resize-y text-center">${escapeHtml(body)}</textarea>
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <div class="inline-flex flex-wrap justify-center gap-1">
                        <button type="button" onclick='window.cancelAdminPushInlineDraft(${JSON.stringify(key)})' class="px-2 py-1 text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-100 rounded border border-slate-200">취소</button>
                        <button type="button" id="${draftFieldId(key, 'saveBtn')}" onclick='window.submitAdminPushInlineDraft(${JSON.stringify(key)})' class="px-2 py-1 text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded border border-violet-600">저장</button>
                    </div>
                </td>
            </tr>`;
}

/** 발송예정 탭 상단 툴바 HTML (새알림 버튼은 재마운트하지 않도록 상태만 갱신) */
function buildAdminPushBulkBarHtml(rows) {
    const selectableCount = rows.filter(isAdminPushRowSelectable).length;
    const selectedCount = adminPushSelectedIds.size;
    const draftCount = adminPushInlineDrafts.length;
    return `
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-white border-b border-slate-200">
            <div class="flex items-center gap-2 text-xs text-slate-600">
                <label class="inline-flex items-center gap-1.5 cursor-pointer font-bold text-slate-700">
                    <input type="checkbox" id="adminPushSelectAllBar" onchange="window.toggleAllAdminPushSelection(this.checked)" class="cursor-pointer" ${
                        selectableCount === 0 ? 'disabled' : ''
                    }>
                    전체 선택
                </label>
                <span class="text-slate-400">·</span>
                <span>선택 <span id="adminPushSelectedCount" class="font-extrabold text-violet-700 tabular-nums">${selectedCount}</span> / 취소가능 ${selectableCount}건</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <button type="button" id="adminPushNewBtn" onclick="window.createAdminPushNewNotification()" class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border text-violet-700 bg-violet-50 hover:bg-violet-100 border-violet-200 transition-colors">
                    <i class="fa-solid fa-plus mr-1" aria-hidden="true"></i>새알림
                </button>
                <button type="button" id="adminPushSaveAllDraftsBtn" onclick="window.submitAllAdminPushInlineDrafts()" ${
                    draftCount === 0 ? 'disabled' : ''
                } class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                    draftCount === 0
                        ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                        : 'text-white bg-violet-600 hover:bg-violet-700 border-violet-600'
                }">
                    <i class="fa-solid fa-save mr-1" aria-hidden="true"></i><span id="adminPushSaveAllDraftsLabel">저장${
                        draftCount ? ` (${draftCount})` : ''
                    }</span>
                </button>
                <button type="button" id="adminPushBulkCancelBtn" onclick="window.bulkCancelAdminScheduledPushes()" ${
                    selectedCount === 0 ? 'disabled' : ''
                } class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
                    selectedCount === 0
                        ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                        : 'text-red-600 bg-red-50 hover:bg-red-100 border-red-100'
                }">
                    <i class="fa-solid fa-ban mr-1" aria-hidden="true"></i>선택 발송취소
                </button>
            </div>
        </div>`;
}

/** 툴바는 유지하고 카운트·disabled만 갱신 (CTA 클릭 중 DOM 교체 방지) */
function syncAdminPushBulkBar(rowsArg) {
    const bar = document.getElementById('adminPushBulkBar');
    if (!bar) return;
    const showSelect = adminPushHistoryActiveTab === 'upcoming';
    if (!showSelect) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
    }
    const rows = rowsArg || adminPushHistoryRows.upcoming;
    bar.classList.remove('hidden');
    if (!bar.querySelector('#adminPushNewBtn')) {
        bar.innerHTML = buildAdminPushBulkBarHtml(rows);
    }
    const selectable = rows.filter(isAdminPushRowSelectable);
    const selectedCount = adminPushSelectedIds.size;
    const draftCount = adminPushInlineDrafts.length;
    const allChecked = selectable.length > 0 && selectable.every((r) => adminPushSelectedIds.has(r.id));
    const barCb = document.getElementById('adminPushSelectAllBar');
    if (barCb) {
        barCb.disabled = selectable.length === 0;
        barCb.checked = allChecked;
    }
    const cntEl = document.getElementById('adminPushSelectedCount');
    if (cntEl) cntEl.textContent = String(selectedCount);
    const cancelBtn = document.getElementById('adminPushBulkCancelBtn');
    if (cancelBtn) {
        const disabled = selectedCount === 0;
        cancelBtn.disabled = disabled;
        cancelBtn.className = `inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
            disabled
                ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                : 'text-red-600 bg-red-50 hover:bg-red-100 border-red-100'
        }`;
    }
    const saveAllBtn = document.getElementById('adminPushSaveAllDraftsBtn');
    const saveAllLabel = document.getElementById('adminPushSaveAllDraftsLabel');
    if (saveAllBtn) {
        const disabled = draftCount === 0;
        saveAllBtn.disabled = disabled;
        saveAllBtn.className = `inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border transition-colors ${
            disabled
                ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                : 'text-white bg-violet-600 hover:bg-violet-700 border-violet-600'
        }`;
    }
    if (saveAllLabel) {
        saveAllLabel.textContent = draftCount ? `저장 (${draftCount})` : '저장';
    }
}

function renderAdminPushHistoryTableFromCache() {
    ensureAdminPushHistoryTabHandlers();
    const container = document.getElementById('adminScheduledPushesContainer');
    const cntUpEl = document.getElementById('adminPushHistoryCountUpcoming');
    const cntDoneEl = document.getElementById('adminPushHistoryCountDone');
    if (!container) return;
    const nUp = adminPushHistoryRows.upcoming.length;
    const nDone = adminPushHistoryRows.done.length;
    if (cntUpEl) cntUpEl.textContent = String(nUp);
    if (cntDoneEl) cntDoneEl.textContent = String(nDone);
    const showSelect = adminPushHistoryActiveTab === 'upcoming';
    const rows = adminPushHistoryActiveTab === 'upcoming' ? adminPushHistoryRows.upcoming : adminPushHistoryRows.done;
    if (showSelect) {
        const upcomingIds = new Set(rows.map((r) => r.id));
        adminPushInlineDrafts = adminPushInlineDrafts.filter(
            (d) => d.mode !== 'edit' || (d.jobId && upcomingIds.has(d.jobId))
        );
    }
    const createDrafts = showSelect
        ? adminPushInlineDrafts.filter((d) => d.mode === 'create')
        : [];
    const createDraftHtml = createDrafts.map((d) => buildAdminPushInlineEditorRowHtml(d, true)).join('');
    const hasCreateDraft = createDrafts.length > 0;
    const hasEditDraft =
        showSelect &&
        adminPushInlineDrafts.some((d) => d.mode === 'edit' && rows.some((r) => r.id === d.jobId));
    const hasDraft = hasCreateDraft || hasEditDraft;

    // 현재 목록에 없는 선택 id 정리 (새로고침·탭 전환 후 잔존 방지)
    if (showSelect) {
        const validIds = new Set(rows.filter(isAdminPushRowSelectable).map((r) => r.id));
        for (const id of [...adminPushSelectedIds]) {
            if (!validIds.has(id)) adminPushSelectedIds.delete(id);
        }
    } else {
        adminPushSelectedIds.clear();
    }

    syncAdminPushBulkBar(rows);

    if (rows.length === 0 && !hasDraft) {
        const msg =
            adminPushHistoryActiveTab === 'upcoming'
                ? '발송 예정인 푸시가 없습니다.'
                : '발송 완료·취소·실패 기록이 없습니다.';
        container.innerHTML = `<p class="text-center py-10 text-slate-400 text-sm px-4">${msg}</p>`;
        return;
    }
    const tbody =
        rows.map((row) => buildAdminScheduledPushRowHtml(row, showSelect)).join('') + createDraftHtml;
    const emptyHint =
        rows.length === 0 && hasCreateDraft
            ? '<p class="text-center py-3 text-slate-400 text-xs px-4 border-b border-slate-100">발송 예정 목록이 비어 있습니다. 아래 작성 행을 채운 뒤 저장을 눌러 주세요.</p>'
            : '';
    container.innerHTML = `${emptyHint}<div class="overflow-x-auto">
                <table class="w-full min-w-[960px] text-center border-collapse">${buildAdminPushHistoryThead(showSelect)}<tbody>${tbody}</tbody></table>
            </div>`;
    if (showSelect) syncAdminPushSelectAllCheckbox(rows);
}

/** 선택 건수·전체선택 체크박스·버튼 상태 갱신 (재렌더 없이) */
function syncAdminPushSelectAllCheckbox(rowsArg) {
    const rows = rowsArg || adminPushHistoryRows.upcoming;
    const selectable = rows.filter(isAdminPushRowSelectable);
    const selectedCount = adminPushSelectedIds.size;
    const allChecked = selectable.length > 0 && selectable.every((r) => adminPushSelectedIds.has(r.id));
    const headCb = document.getElementById('adminPushSelectAll');
    const barCb = document.getElementById('adminPushSelectAllBar');
    if (headCb) headCb.checked = allChecked;
    if (barCb) barCb.checked = allChecked;
    const cntEl = document.getElementById('adminPushSelectedCount');
    if (cntEl) cntEl.textContent = String(selectedCount);
    syncAdminPushBulkBar(rows);
}

async function refreshAdminScheduledPushesCore() {
    const container = document.getElementById('adminScheduledPushesContainer');
    if (!container) return;
    ensureAdminPushHistoryTabHandlers();
    captureAdminPushInlineDraftsFromDom();
    // 목록만 로딩 표시 — 툴바(새알림 등 CTA)는 유지해 클릭이 끊기지 않게 함
    container.innerHTML =
        '<p class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>불러오는 중…</p>';
    try {
        const coll = collection(db, 'artifacts', appId, 'adminScheduledPushes');
        const [snapMain, snapPending] = await Promise.all([
            getDocs(query(coll, orderBy('scheduledAt', 'desc'), limit(350))),
            getDocs(
                query(
                    coll,
                    where('status', 'in', ['pending', 'sending']),
                    orderBy('scheduledAt', 'asc'),
                    limit(120)
                )
            )
        ]);
        const mainRows = snapMain.docs.map((d) => ({ ...d.data(), id: d.id }));
        const upcomingRows = snapPending.docs.map((d) => ({ ...d.data(), id: d.id }));
        const doneRows = mainRows
            .filter((r) => !['pending', 'sending'].includes(r.status || ''))
            .sort((a, b) => completedHistorySortMs(b) - completedHistorySortMs(a));

        adminPushHistoryRows = { upcoming: upcomingRows, done: doneRows };

        if (snapMain.empty && snapPending.empty) {
            adminPushHistoryRows = { upcoming: [], done: [] };
            renderAdminPushHistoryTableFromCache();
            return;
        }

        renderAdminPushHistoryTableFromCache();
    } catch (e) {
        console.error('예약 푸시 목록 실패:', e);
        container.innerHTML = `<p class="text-center py-8 text-red-400 text-sm px-4">목록을 불러오지 못했습니다. ${escapeHtml(e.message || '')}</p>`;
    }
}

window.refreshAdminScheduledPushes = async function () {
    await runAdminRefreshAction(
        document.getElementById('adminRefreshScheduledPushesBtn'),
        refreshAdminScheduledPushesCore,
        { loadingText: '불러오는 중…', tightSpinner: true }
    );
};

/** Callable 미배포 등으로 보이는 오류인지 (Firestore 직접 쓰기 fallback 판단) */
function isUndeployedCallableError(msg) {
    return (
        msg.includes('not-found') ||
        msg.includes('UNIMPLEMENTED') ||
        msg.includes('No function') ||
        msg.includes('CORS') ||
        msg.includes('ERR_FAILED') ||
        msg.includes('internal')
    );
}

/** 예약 취소 1건 (확인·새로고침 없이) — callable 우선, 실패 시 Firestore 직접 쓰기 */
async function cancelAdminScheduledPushById(jobId) {
    try {
        await cancelAdminScheduledPushFn({ jobId });
    } catch (e) {
        const msg = String(e?.message || e || '');
        if (!isUndeployedCallableError(msg)) throw e;
        const ref = doc(db, 'artifacts', appId, 'adminScheduledPushes', jobId);
        await setDoc(ref, { status: 'cancelled', cancelledAt: serverTimestamp() }, { merge: true });
    }
}

window.cancelAdminScheduledPush = async function(jobId) {
    if (!jobId || !confirm('이 예약을 취소할까요?')) return;
    try {
        await cancelAdminScheduledPushById(jobId);
        await refreshAdminScheduledPushesCore();
    } catch (e) {
        console.error('예약 취소 실패:', e);
        alert('취소 실패: ' + (e?.message || e));
    }
};

/** 발송예정 항목별 선택 토글 */
window.onAdminPushRowSelect = function(jobId, checked) {
    if (!jobId) return;
    if (checked) adminPushSelectedIds.add(jobId);
    else adminPushSelectedIds.delete(jobId);
    syncAdminPushSelectAllCheckbox();
};

/** 전체 선택/해제 (현재 발송예정 목록의 취소 가능한 행) */
window.toggleAllAdminPushSelection = function(checked) {
    const selectable = adminPushHistoryRows.upcoming.filter(isAdminPushRowSelectable);
    adminPushSelectedIds.clear();
    if (checked) selectable.forEach((r) => adminPushSelectedIds.add(r.id));
    // 행 체크박스 DOM 동기화 (재렌더 없이)
    document.querySelectorAll('.admin-push-select-item').forEach((cb) => {
        const id = cb.getAttribute('data-job-id');
        cb.checked = !!id && adminPushSelectedIds.has(id);
    });
    syncAdminPushSelectAllCheckbox();
};

/** 선택 항목 일괄 발송취소 */
window.bulkCancelAdminScheduledPushes = async function() {
    const ids = [...adminPushSelectedIds];
    if (ids.length === 0) {
        alert('취소할 항목을 선택해 주세요.');
        return;
    }
    if (!confirm(`선택한 ${ids.length}건의 예약을 발송 취소할까요?`)) return;
    const btn = document.getElementById('adminPushBulkCancelBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1" aria-hidden="true"></i>취소 중…';
    }
    let ok = 0;
    const failed = [];
    for (const id of ids) {
        try {
            await cancelAdminScheduledPushById(id);
            adminPushSelectedIds.delete(id);
            ok++;
        } catch (e) {
            console.error('일괄 취소 실패:', id, e);
            failed.push(id);
        }
    }
    await refreshAdminScheduledPushesCore();
    alert(`발송 취소 완료: ${ok}건${failed.length ? `, 실패: ${failed.length}건` : ''}`);
};

window.deleteAdminBroadcastHistory = async function(jobId) {
    if (!jobId || !confirm('이 발송 기록을 삭제할까요?')) return;
    try {
        await deleteAdminBroadcastHistoryFn({ jobId });
        await refreshAdminScheduledPushesCore();
    } catch (e) {
        const msg = String(e?.message || e || '');
        const maybeUndeployedCallable =
            msg.includes('not-found') ||
            msg.includes('UNIMPLEMENTED') ||
            msg.includes('No function') ||
            msg.includes('CORS') ||
            msg.includes('ERR_FAILED') ||
            msg.includes('internal');
        if (maybeUndeployedCallable) {
            try {
                const ref = doc(db, 'artifacts', appId, 'adminScheduledPushes', jobId);
                await deleteDoc(ref);
                await refreshAdminScheduledPushesCore();
                return;
            } catch (fallbackErr) {
                console.error('발송 기록 삭제 fallback 실패:', fallbackErr);
                alert('삭제 실패: ' + (fallbackErr?.message || fallbackErr));
                return;
            }
        }
        console.error(e);
        alert('삭제 실패: ' + msg);
    }
};

/* ─────────────── 발송예정 인라인 등록·수정 ─────────────── */

function buildAdminPushFormOptions(opts, sel) {
    return opts.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
}

function focusAdminPushInlineDraftRow(draftKey) {
    const key = draftKey || adminPushInlineDrafts[adminPushInlineDrafts.length - 1]?.draftKey;
    if (!key) return;
    const titleEl = document.getElementById(draftFieldId(key, 'title'));
    // 화면 스크롤을 일으키지 않음 (scrollIntoView/기본 focus 스크롤이 CTA 더블클릭처럼 보이게 함)
    if (titleEl && typeof titleEl.focus === 'function') {
        try {
            titleEl.focus({ preventScroll: true });
        } catch {
            /* ignore */
        }
    }
}

/** 새 작성 행 기본값 — 일시·환경·랜딩만 복사(+1일), 제목·내용은 비움 */
function buildNextCreateDraftFields() {
    captureAdminPushInlineDraftsFromDom();
    const creates = adminPushInlineDrafts.filter((d) => d.mode === 'create');
    let base;
    if (creates.length) {
        const last = creates[creates.length - 1];
        base = pushRowToDraft(
            {
                scheduledAt: last.scheduledAtMs,
                landingTab: last.landingTab,
                targetEnv: last.targetEnv
            },
            { addDay: true }
        );
    } else {
        const last = getLastUpcomingPushRow();
        base = last ? pushRowToDraft(last, { addDay: true }) : blankAdminPushDraft();
    }
    return { ...base, title: '', body: '' };
}

/** 테이블 하단에 인라인 새알림 행 추가(기존 작성 행 유지) — 저장 전까지 미반영 */
window.createAdminPushNewNotification = function() {
    if (adminPushHistoryActiveTab !== 'upcoming') {
        switchAdminPushHistoryTabUi('upcoming');
    }
    const base = buildNextCreateDraftFields();
    const draftKey = nextAdminPushDraftKey();
    adminPushInlineDrafts.push({ mode: 'create', draftKey, ...base });
    // 클릭이 끝난 뒤 목록을 그려 스크롤 앵커링이 버튼을 밀어내지 않게 함
    afterAdminClick(() => {
        renderAdminPushHistoryTableFromCache();
        focusAdminPushInlineDraftRow(draftKey);
    });
};

/** 해당 행을 인라인 수정 모드로 전환 — 저장 전까지 미반영 */
window.editAdminScheduledPush = function(jobId) {
    const r = findUpcomingRowById(jobId);
    if (!r) {
        alert('수정할 예약을 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
        return;
    }
    if (!isAdminPushRowEditable(r)) {
        alert('이 예약은 수정할 수 없습니다. (대기 중인 단일 예약만 수정 가능)');
        return;
    }
    if (adminPushHistoryActiveTab !== 'upcoming') {
        switchAdminPushHistoryTabUi('upcoming');
    }
    captureAdminPushInlineDraftsFromDom();
    const existing = findInlineEditDraftByJobId(jobId);
    if (existing) {
        afterAdminClick(() => {
            renderAdminPushHistoryTableFromCache();
            focusAdminPushInlineDraftRow(existing.draftKey);
        });
        return;
    }
    const draft = pushRowToDraft(r);
    const draftKey = nextAdminPushDraftKey();
    adminPushInlineDrafts.push({
        mode: 'edit',
        draftKey,
        jobId,
        ...draft,
        original: { ...draft }
    });
    afterAdminClick(() => {
        renderAdminPushHistoryTableFromCache();
        focusAdminPushInlineDraftRow(draftKey);
    });
};

window.cancelAdminPushInlineDraft = function(draftKey) {
    captureAdminPushInlineDraftsFromDom();
    const draft = findInlineDraftByKey(draftKey);
    if (!draft) return;
    if (isAdminPushInlineDraftDirty(draft)) {
        const msg = draft.mode === 'edit' ? '수정 중인 내용을 취소할까요?' : '작성 중인 내용을 취소할까요?';
        if (!confirm(msg)) return;
    }
    adminPushInlineDrafts = adminPushInlineDrafts.filter((d) => d.draftKey !== draftKey);
    afterAdminClick(() => renderAdminPushHistoryTableFromCache());
};

function validateAdminPushInlineDraft(d) {
    const title = String(d.title || '').trim();
    const body = String(d.body || '').trim();
    const landingTab = d.landingTab || 'timeline';
    const targetEnv = d.targetEnv || 'all';
    const scheduledAtMs = d.scheduledAtMs;
    if (!title) return { ok: false, error: '제목을 입력해 주세요.', focus: 'title' };
    if (!body) return { ok: false, error: '내용을 입력해 주세요.', focus: 'body' };
    if (!Number.isFinite(scheduledAtMs)) return { ok: false, error: '예약 일시를 선택해 주세요.', focus: 'when' };
    if (scheduledAtMs < Date.now() + 50 * 1000) {
        return { ok: false, error: '예약 시각은 현재보다 최소 약 1분 이후로 설정해 주세요.', focus: 'when' };
    }
    return {
        ok: true,
        payload: {
            title: title.slice(0, ADMIN_BROADCAST_TITLE_MAX),
            body: body.slice(0, ADMIN_BROADCAST_BODY_MAX),
            landingTab,
            targetEnv,
            scheduledAtMs
        }
    };
}

async function persistAdminPushInlineDraft(d, payload) {
    if (d.mode === 'edit') {
        const jobId = d.jobId;
        if (!jobId) throw new Error('수정할 예약 ID가 없습니다.');
        const updatePayload = { jobId, ...payload };
        try {
            await updateAdminScheduledPushFn(updatePayload);
        } catch (e) {
            const msg = String(e?.message || e || '');
            if (!isUndeployedCallableError(msg)) throw e;
            const ref = doc(db, 'artifacts', appId, 'adminScheduledPushes', jobId);
            await setDoc(
                ref,
                {
                    title: payload.title,
                    body: payload.body,
                    landingTab: payload.landingTab,
                    targetEnv: payload.targetEnv,
                    scheduledAt: Timestamp.fromMillis(payload.scheduledAtMs),
                    updatedAt: serverTimestamp()
                },
                { merge: true }
            );
        }
        return;
    }
    await scheduleAdminBroadcastPushFn({
        scheduleType: 'once',
        ...payload
    });
}

/** 인라인 새알림/수정 — 저장 시에만 Firestore 반영 */
window.submitAdminPushInlineDraft = async function(draftKey) {
    captureAdminPushInlineDraftsFromDom();
    const draft = findInlineDraftByKey(draftKey);
    if (!draft) return;
    const validated = validateAdminPushInlineDraft(draft);
    if (!validated.ok) {
        alert(validated.error);
        document.getElementById(draftFieldId(draftKey, validated.focus || 'title'))?.focus();
        return;
    }
    if (!auth.currentUser?.uid) {
        alert('로그인이 필요합니다.');
        return;
    }
    const btn = document.getElementById(draftFieldId(draftKey, 'saveBtn'));
    if (btn) {
        btn.disabled = true;
        btn.textContent = '저장 중…';
    }
    try {
        await persistAdminPushInlineDraft(draft, validated.payload);
        adminPushInlineDrafts = adminPushInlineDrafts.filter((d) => d.draftKey !== draftKey);
        await refreshAdminScheduledPushesCore();
    } catch (e) {
        console.error(draft.mode === 'edit' ? '예약 수정 실패:' : '예약 등록 실패:', e);
        alert((draft.mode === 'edit' ? '수정' : '등록') + ' 실패: ' + (e?.message || e));
        if (btn) {
            btn.disabled = false;
            btn.textContent = '저장';
        }
    }
};

/** 작성·수정 중인 모든 인라인 행을 일괄 저장 */
window.submitAllAdminPushInlineDrafts = async function() {
    captureAdminPushInlineDraftsFromDom();
    if (!adminPushInlineDrafts.length) {
        alert('저장할 작성 중인 알림이 없습니다.');
        return;
    }
    if (!auth.currentUser?.uid) {
        alert('로그인이 필요합니다.');
        return;
    }
    const drafts = [...adminPushInlineDrafts];
    for (const d of drafts) {
        const validated = validateAdminPushInlineDraft(d);
        if (!validated.ok) {
            alert(validated.error);
            focusAdminPushInlineDraftRow(d.draftKey);
            document.getElementById(draftFieldId(d.draftKey, validated.focus || 'title'))?.focus();
            return;
        }
    }
    const btn = document.getElementById('adminPushSaveAllDraftsBtn');
    const saveLabel = document.getElementById('adminPushSaveAllDraftsLabel');
    if (btn) btn.disabled = true;
    if (saveLabel) saveLabel.textContent = '저장 중…';
    let ok = 0;
    const failed = [];
    for (const d of drafts) {
        const validated = validateAdminPushInlineDraft(d);
        if (!validated.ok) {
            failed.push(d.draftKey);
            continue;
        }
        try {
            await persistAdminPushInlineDraft(d, validated.payload);
            adminPushInlineDrafts = adminPushInlineDrafts.filter((x) => x.draftKey !== d.draftKey);
            ok++;
        } catch (e) {
            console.error('일괄 저장 실패:', d.draftKey, e);
            failed.push(d.draftKey);
        }
    }
    await refreshAdminScheduledPushesCore();
    if (failed.length) {
        alert(`저장 완료: ${ok}건, 실패: ${failed.length}건`);
        focusAdminPushInlineDraftRow(failed[0]);
    } else {
        alert(`저장 완료: ${ok}건`);
    }
};
