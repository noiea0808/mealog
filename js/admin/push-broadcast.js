// ADMIN 브로드캐스트 푸시 (즉시 발송 / 예약)
import { app, db, appId, functions, auth } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { collection, query, orderBy, where, getDocs, limit, doc, setDoc, serverTimestamp, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, runAdminRefreshAction } from './utils.js';

// ========== 푸시메시지 관리 (관리자 브로드캐스트) ==========
const adminBroadcastPushNowFn = httpsCallable(functions, 'adminBroadcastPushNow');
const scheduleAdminBroadcastPushFn = httpsCallable(functions, 'scheduleAdminBroadcastPush');
const cancelAdminScheduledPushFn = httpsCallable(functions, 'cancelAdminScheduledPush');
const deleteAdminBroadcastHistoryFn = httpsCallable(functions, 'deleteAdminBroadcastHistory');
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

const ADMIN_RECURRING_INTERVAL_LABELS = {
    daily: '매일',
    weekly: '매주',
    monthly: '매월'
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
    if (!labels.length) return escapeHtml(formatAdminPushScheduledCell(r));
    const lines = labels.map((l) => `<div class="tabular-nums">${escapeHtml(l)}</div>`).join('');
    return `<div class="flex flex-col gap-0.5 leading-snug">${lines}</div>`;
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

/** 서울 기준 날짜·요일·시각 (예약/발송일시 표시용) */
function formatAdminPushDateTimeWithWeekday(ts) {
    if (!ts) return '—';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        return new Intl.DateTimeFormat('ko-KR', {
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(d);
    } catch {
        return '—';
    }
}

function formatAdminPushDateDay(ts) {
    if (!ts) return '—';
    try {
        const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
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

/** 예약(또는 다음 발송) 시각 — 즉시 발송 이력은 예약 없음 */
function formatAdminPushScheduledCell(r) {
    const scheduleType = r.scheduleType || 'once';
    if (scheduleType === 'now') return '—';
    return formatAdminPushDateTimeWithWeekday(r.scheduledAt);
}

/** 실제 발송 완료 시각 */
function formatAdminPushSentCell(r) {
    const st = r.status || 'pending';
    if (st === 'failed' && r.failedAt) return formatAdminPushDateTimeWithWeekday(r.failedAt);
    if (st === 'cancelled' && r.cancelledAt) return formatAdminPushDateTimeWithWeekday(r.cancelledAt);
    if (st === 'pending' || st === 'sending') return '—';
    return formatAdminPushDateTimeWithWeekday(r.sentAt || r.lastSentAt);
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

function ensureAdminPushHistoryTabHandlers() {
    if (window._adminPushHistoryTabBound) return;
    window._adminPushHistoryTabBound = true;
    const bind = (id, tab) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('click', () => {
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

function setAdminPushScheduleMinDatetime() {
    const minVal = datetimeLocalMinAhead(1);
    const el = document.getElementById('adminPushScheduleWhen');
    if (el) el.min = minVal;
}

function initAdminPushWeeklyDateRange() {
    const startEl = document.getElementById('adminPushWeeklyRangeStart');
    const endEl = document.getElementById('adminPushWeeklyRangeEnd');
    if (!startEl || !endEl) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const endStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
    startEl.min = today;
    endEl.min = today;
    if (!startEl.value) startEl.value = today;
    if (!endEl.value) endEl.value = endStr;
}

function collectWeeklyScheduleFromRows() {
    const out = [];
    for (let wd = 1; wd <= 7; wd++) {
        const timeEl = document.getElementById(`adminPushWd${wd}Time`);
        const titleEl = document.getElementById(`adminPushWd${wd}Title`);
        const bodyEl = document.getElementById(`adminPushWd${wd}Body`);
        const landEl = document.getElementById(`adminPushWd${wd}Landing`);
        const envEl = document.getElementById(`adminPushWd${wd}TargetEnv`);
        const time = (timeEl?.value || '').trim();
        const title = (titleEl?.value || '').trim();
        const body = (bodyEl?.value || '').trim();
        if (!time || !title || !body) continue;
        let hm = time;
        if (/^\d{1}:\d{2}$/.test(hm)) hm = `0${hm}`;
        out.push({
            weekday: wd,
            time: hm.length === 5 ? hm : time,
            landingTab: landEl?.value || 'timeline',
            targetEnv: envEl?.value || 'staging',
            title: title.slice(0, ADMIN_BROADCAST_TITLE_MAX),
            body: body.slice(0, ADMIN_BROADCAST_BODY_MAX)
        });
    }
    return out;
}

function clearAdminPushWeeklyForm() {
    for (let wd = 1; wd <= 7; wd++) {
        const timeEl = document.getElementById(`adminPushWd${wd}Time`);
        const titleEl = document.getElementById(`adminPushWd${wd}Title`);
        const bodyEl = document.getElementById(`adminPushWd${wd}Body`);
        if (timeEl) timeEl.value = '';
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
    }
}

/**
 * 예약 발송 하위: 특정 일시 1회 vs 요일별 주기
 * @param {'once'|'recurring'} kind
 */
window.setAdminPushScheduleKind = function(kind) {
    const onceTab = document.getElementById('adminPushScheduleKindOnce');
    const recTab = document.getElementById('adminPushScheduleKindRecurring');
    const onceBlock = document.getElementById('adminPushScheduleOnceBlock');
    const recBlock = document.getElementById('adminPushScheduleRecurringBlock');
    const isOnce = kind !== 'recurring';

    if (onceTab) {
        onceTab.classList.toggle('bg-white', isOnce);
        onceTab.classList.toggle('text-amber-800', isOnce);
        onceTab.classList.toggle('shadow-sm', isOnce);
        onceTab.classList.toggle('ring-1', isOnce);
        onceTab.classList.toggle('ring-amber-200/70', isOnce);
        onceTab.classList.toggle('text-slate-500', !isOnce);
        onceTab.classList.toggle('hover:text-slate-700', !isOnce);
        onceTab.classList.toggle('hover:bg-white/60', !isOnce);
        onceTab.setAttribute('aria-selected', isOnce ? 'true' : 'false');
    }
    if (recTab) {
        const recOn = !isOnce;
        recTab.classList.toggle('bg-white', recOn);
        recTab.classList.toggle('text-amber-800', recOn);
        recTab.classList.toggle('shadow-sm', recOn);
        recTab.classList.toggle('ring-1', recOn);
        recTab.classList.toggle('ring-amber-200/70', recOn);
        recTab.classList.toggle('text-slate-500', !recOn);
        recTab.classList.toggle('hover:text-slate-700', !recOn);
        recTab.classList.toggle('hover:bg-white/60', !recOn);
        recTab.setAttribute('aria-selected', recOn ? 'true' : 'false');
    }
    if (onceBlock) onceBlock.classList.toggle('hidden', !isOnce);
    if (recBlock) recBlock.classList.toggle('hidden', isOnce);

    setAdminPushScheduleMinDatetime();
    if (!isOnce) initAdminPushWeeklyDateRange();
};

/**
 * 푸시메시지 관리: 즉시 / 예약 옵션 전환
 * @param {'now'|'schedule'} mode
 */
window.setAdminPushSendMode = function(mode) {
    const nowTab = document.getElementById('adminPushModeTabNow');
    const schTab = document.getElementById('adminPushModeTabSchedule');
    const nowPanel = document.getElementById('adminPushPanelNow');
    const schPanel = document.getElementById('adminPushPanelSchedule');
    const isNow = mode !== 'schedule';

    if (nowTab) {
        nowTab.classList.toggle('bg-white', isNow);
        nowTab.classList.toggle('text-violet-700', isNow);
        nowTab.classList.toggle('shadow-sm', isNow);
        nowTab.classList.toggle('ring-1', isNow);
        nowTab.classList.toggle('ring-violet-200/70', isNow);
        nowTab.classList.toggle('text-slate-500', !isNow);
        nowTab.classList.toggle('hover:text-slate-700', !isNow);
        nowTab.classList.toggle('hover:bg-white/60', !isNow);
        nowTab.setAttribute('aria-selected', isNow ? 'true' : 'false');
    }
    if (schTab) {
        const schOn = !isNow;
        schTab.classList.toggle('bg-white', schOn);
        schTab.classList.toggle('text-amber-800', schOn);
        schTab.classList.toggle('shadow-sm', schOn);
        schTab.classList.toggle('ring-1', schOn);
        schTab.classList.toggle('ring-amber-200/70', schOn);
        schTab.classList.toggle('text-slate-500', !schOn);
        schTab.classList.toggle('hover:text-slate-700', !schOn);
        schTab.classList.toggle('hover:bg-white/60', !schOn);
        schTab.setAttribute('aria-selected', schOn ? 'true' : 'false');
    }
    if (nowPanel) nowPanel.classList.toggle('hidden', !isNow);
    if (schPanel) schPanel.classList.toggle('hidden', isNow);

    if (!isNow) {
        setAdminPushScheduleMinDatetime();
        window.setAdminPushScheduleKind('once');
    }
};

export async function loadAdminPushMessagesPage() {
    ensureAdminPushHistoryTabHandlers();
    window.setAdminPushSendMode('now');
    window.setAdminPushScheduleKind('once');
    const nowLandingEl = document.getElementById('adminPushNowLanding');
    const nowTargetEnvEl = document.getElementById('adminPushNowTargetEnv');
    const schLandingEl = document.getElementById('adminPushScheduleLanding');
    const schTargetEnvEl = document.getElementById('adminPushScheduleTargetEnv');
    if (nowLandingEl) nowLandingEl.value = 'timeline';
    if (nowTargetEnvEl) nowTargetEnvEl.value = 'staging';
    if (schLandingEl) schLandingEl.value = 'timeline';
    if (schTargetEnvEl) schTargetEnvEl.value = 'staging';
    setAdminPushScheduleMinDatetime();
    initAdminPushWeeklyDateRange();
    await refreshAdminScheduledPushesCore();
}

const ADMIN_PUSH_HISTORY_THEAD = `
            <thead>
                <tr class="bg-slate-100/90 text-left text-[11px] font-bold text-slate-600 uppercase tracking-wide border-b border-slate-200">
                    <th class="px-3 py-2.5 whitespace-nowrap">대상환경</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">상태</th>
                    <th class="px-3 py-2.5 whitespace-nowrap min-w-[7rem]">예약일시</th>
                    <th class="px-3 py-2.5 whitespace-nowrap min-w-[7rem]">발송일시</th>
                    <th class="px-3 py-2.5 whitespace-nowrap text-right">수신자수</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">랜딩</th>
                    <th class="px-3 py-2.5 min-w-[8rem]">제목</th>
                    <th class="px-3 py-2.5 min-w-[12rem]">내용</th>
                    <th class="px-3 py-2.5 whitespace-nowrap text-right">작업</th>
                </tr>
            </thead>`;

function buildAdminScheduledPushRowHtml(r) {
    const st = r.status || 'pending';
    const stLabel = ADMIN_SCHEDULED_PUSH_STATUS_LABELS[st] || st;
    const scheduleType = r.scheduleType || 'once';
    const isWeeklyByDay = r.recurringMode === 'weeklyByDay' && Array.isArray(r.weeklySchedule);
    const isWeeklyExpanded = r.scheduleSource === 'weeklyByDayExpanded';
    const isRecurring = scheduleType === 'recurring';
    const isNow = scheduleType === 'now';
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
    const kindTag = isNow
        ? '<span class="text-[10px] font-bold text-violet-700">즉시</span>'
        : isWeeklyByDay
          ? '<span class="text-[10px] font-bold text-violet-700">요일별(구)</span>'
          : isWeeklyExpanded
            ? '<span class="text-[10px] font-bold text-violet-700">요일별</span>'
            : isRecurring
              ? '<span class="text-[10px] font-bold text-slate-600">구주기</span>'
              : '<span class="text-[10px] font-bold text-slate-500">예약발송</span>';
    let recurHint = '';
    if (isWeeklyByDay) {
        recurHint = '';
    } else if (isRecurring && !isWeeklyByDay && r.recurringEndAt) {
        const intv = r.recurringInterval || 'daily';
        const intvLabel = ADMIN_RECURRING_INTERVAL_LABELS[intv] || intv;
        recurHint = `<div class="text-[10px] text-slate-400 mt-0.5">주기 ${escapeHtml(intvLabel)} · 종료 ${escapeHtml(formatAdminPushDateTimeWithWeekday(r.recurringEndAt))}</div>`;
    }
    const rc = typeof r.recipientCount === 'number' && !Number.isNaN(r.recipientCount) ? String(r.recipientCount) : '—';
    const actionBtns = [
        canCancel
            ? `<button type="button" onclick='window.cancelAdminScheduledPush(${JSON.stringify(r.id)})' class="px-2 py-1 text-[11px] font-bold text-red-600 bg-red-50 hover:bg-red-100 rounded border border-red-100">취소</button>`
            : '',
        canDelete
            ? `<button type="button" onclick='window.deleteAdminBroadcastHistory(${JSON.stringify(r.id)})' class="px-2 py-1 text-[11px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200">삭제</button>`
            : ''
    ]
        .filter(Boolean)
        .join(' ');
    const titleAttr = isWeeklyByDay
        ? sortWeeklySlots(ws)
              .map((s) => `${WEEKDAY_LABELS[s.weekday] || ''} ${String(s.title || '').trim()}`.trim())
              .join(' · ')
              .slice(0, 400)
        : rawTitle;
    const titleCell = `<span class="line-clamp-2 text-slate-800 font-medium" title="${escapeAttr(titleAttr)}">${titleText}</span>`;
    return `
            <tr class="border-b border-slate-100 hover:bg-slate-50/80 align-top">
                <td class="px-3 py-2 text-xs text-slate-800 whitespace-nowrap">${escapeHtml(targetEnvLabel)}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <div class="flex flex-col gap-0.5">
                        <span class="inline-flex flex-wrap items-center gap-1">
                            <span class="text-xs font-bold px-2 py-0.5 rounded-md ${adminPushStatusBadgeClass(st)}">${escapeHtml(stLabel)}</span>
                            ${kindTag}
                        </span>
                        ${recurHint}
                    </div>
                    ${errTitle ? `<div class="text-[10px] text-red-500 mt-1 max-w-[12rem]">${errTitle}</div>` : ''}
                </td>
                <td class="px-3 py-2 text-xs text-slate-700 ${isWeeklyByDay ? 'min-w-[5.5rem]' : 'whitespace-nowrap'}">${
                    isWeeklyByDay ? formatWeeklyReservationDatesCellHtml(r, ws) : escapeHtml(formatAdminPushScheduledCell(r))
                }${
                    isWeeklyExpanded && r.weeklyBatchGroupId
                        ? `<div class="text-[10px] text-slate-400 mt-0.5 font-mono" title="같은 등록 묶음 ID">#${escapeHtml(String(r.weeklyBatchGroupId).slice(0, 8))}…</div>`
                        : ''
                }</td>
                <td class="px-3 py-2 text-xs text-slate-700 whitespace-nowrap">${escapeHtml(formatAdminPushSentCell(r))}</td>
                <td class="px-3 py-2 text-xs text-slate-800 text-right tabular-nums">${escapeHtml(rc)}</td>
                <td class="px-3 py-2 text-xs text-violet-700 font-semibold whitespace-nowrap">${escapeHtml(land)}</td>
                <td class="px-3 py-2 text-xs text-slate-800 max-w-[14rem]">${titleCell}</td>
                <td class="px-3 py-2 text-xs text-slate-600 max-w-[28rem]">${isWeeklyByDay ? bodyHtml : `<span class="whitespace-pre-wrap break-words" title="${escapeAttr(rawBody)}">${bodyHtml}</span>`}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">${actionBtns || '—'}</td>
            </tr>`;
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
    const rows = adminPushHistoryActiveTab === 'upcoming' ? adminPushHistoryRows.upcoming : adminPushHistoryRows.done;
    if (rows.length === 0) {
        const msg =
            adminPushHistoryActiveTab === 'upcoming'
                ? '발송 예정인 푸시가 없습니다.'
                : '발송 완료·취소·실패 기록이 없습니다.';
        container.innerHTML = `<p class="text-center py-10 text-slate-400 text-sm px-4">${msg}</p>`;
        return;
    }
    const tbody = rows.map((row) => buildAdminScheduledPushRowHtml(row)).join('');
    container.innerHTML = `<div class="overflow-x-auto">
                <table class="w-full min-w-[960px] text-left border-collapse">${ADMIN_PUSH_HISTORY_THEAD}<tbody>${tbody}</tbody></table>
            </div>`;
}

async function refreshAdminScheduledPushesCore() {
    const container = document.getElementById('adminScheduledPushesContainer');
    if (!container) return;
    ensureAdminPushHistoryTabHandlers();
    container.innerHTML =
        '<p class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>불러오는 중…</p>';
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
            const cntUpEl = document.getElementById('adminPushHistoryCountUpcoming');
            const cntDoneEl = document.getElementById('adminPushHistoryCountDone');
            if (cntUpEl) cntUpEl.textContent = '0';
            if (cntDoneEl) cntDoneEl.textContent = '0';
            container.innerHTML = '<p class="text-center py-8 text-slate-400 text-sm">발송 기록이 없습니다.</p>';
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

window.cancelAdminScheduledPush = async function(jobId) {
    if (!jobId || !confirm('이 예약을 취소할까요?')) return;
    try {
        await cancelAdminScheduledPushFn({ jobId });
        await refreshAdminScheduledPushesCore();
    } catch (e) {
        const msg = String(e?.message || e || '');
        const maybeUndeployedCallable =
            msg.includes('not-found') ||
            msg.includes('UNIMPLEMENTED') ||
            msg.includes('No function');
        if (maybeUndeployedCallable) {
            try {
                const ref = doc(db, 'artifacts', appId, 'adminScheduledPushes', jobId);
                await setDoc(ref, { status: 'cancelled', cancelledAt: serverTimestamp() }, { merge: true });
                await refreshAdminScheduledPushesCore();
                return;
            } catch (fallbackErr) {
                console.error('예약 취소 fallback 실패:', fallbackErr);
                alert('취소 실패: ' + (fallbackErr?.message || fallbackErr));
                return;
            }
        }
        console.error(e);
        alert('취소 실패: ' + msg);
    }
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

window.submitAdminPushNow = async function() {
    const titleEl = document.getElementById('adminPushNowTitle');
    const bodyEl = document.getElementById('adminPushNowBody');
    const landEl = document.getElementById('adminPushNowLanding');
    const targetEnvEl = document.getElementById('adminPushNowTargetEnv');
    const btn = document.getElementById('adminPushNowBtn');
    const title = (titleEl?.value || '').trim();
    const body = (bodyEl?.value || '').trim();
    const landingTab = landEl?.value || 'timeline';
    const targetEnv = targetEnvEl?.value || 'staging';
    if (!title) {
        alert('제목을 입력해 주세요.');
        return;
    }
    if (!body) {
        alert('내용을 입력해 주세요.');
        return;
    }
    if (!confirm('알림을 허용한 전체 로그인 사용자에게 지금 발송합니다. 계속할까요?')) return;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '발송 중…';
    }
    try {
        await adminBroadcastPushNowFn({
            title: title.slice(0, ADMIN_BROADCAST_TITLE_MAX),
            body: body.slice(0, ADMIN_BROADCAST_BODY_MAX),
            landingTab,
            targetEnv
        });
        alert('발송 요청이 처리되었습니다.');
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
    } catch (e) {
        console.error(e);
        const msg = e?.message || e?.details || String(e);
        alert('발송 실패: ' + msg);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '지금 전체 발송';
        }
    }
};

window.submitAdminPushSchedule = async function() {
    const recTab = document.getElementById('adminPushScheduleKindRecurring');
    const isRecurring = recTab && recTab.getAttribute('aria-selected') === 'true';
    const whenEl = document.getElementById('adminPushScheduleWhen');
    const titleEl = document.getElementById('adminPushScheduleTitle');
    const bodyEl = document.getElementById('adminPushScheduleBody');
    const landEl = document.getElementById('adminPushScheduleLanding');
    const targetEnvEl = document.getElementById('adminPushScheduleTargetEnv');
    const btn = document.getElementById(isRecurring ? 'adminPushScheduleBtnWeekly' : 'adminPushScheduleBtnOnce');
    const minAhead = Date.now() + 50 * 1000;
    let payload;

    if (isRecurring) {
        const startDate = document.getElementById('adminPushWeeklyRangeStart')?.value;
        const endDate = document.getElementById('adminPushWeeklyRangeEnd')?.value;
        const weeklySchedule = collectWeeklyScheduleFromRows();
        if (!startDate || !endDate) {
            alert('시작일과 종료일을 선택해 주세요.');
            return;
        }
        if (endDate < startDate) {
            alert('종료일은 시작일 이후여야 합니다.');
            return;
        }
        if (weeklySchedule.length === 0) {
            alert('최소 한 요일에 발송 시각·제목·내용을 모두 입력해 주세요. (비운 요일은 발송하지 않습니다.)');
            return;
        }
        payload = {
            scheduleType: 'recurring',
            recurringStartDate: startDate,
            recurringEndDate: endDate,
            weeklySchedule
        };
    } else {
        const title = (titleEl?.value || '').trim();
        const body = (bodyEl?.value || '').trim();
        const landingTab = landEl?.value || 'timeline';
        const targetEnv = targetEnvEl?.value || 'staging';
        if (!title || !body) {
            alert('제목과 내용을 모두 입력해 주세요.');
            return;
        }
        const whenVal = whenEl?.value;
        if (!whenVal) {
            alert('발송 일시를 선택해 주세요.');
            return;
        }
        const at = new Date(whenVal);
        if (Number.isNaN(at.getTime())) {
            alert('발송 일시가 올바르지 않습니다.');
            return;
        }
        if (at.getTime() < minAhead) {
            alert('예약 시각은 현재보다 최소 약 1분 이후로 설정해 주세요.');
            return;
        }
        payload = {
            scheduleType: 'once',
            title: title.slice(0, ADMIN_BROADCAST_TITLE_MAX),
            body: body.slice(0, ADMIN_BROADCAST_BODY_MAX),
            landingTab,
            targetEnv,
            scheduledAtMs: at.getTime()
        };
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
        alert('로그인이 필요합니다.');
        return;
    }
    if (btn) {
        btn.disabled = true;
        btn.textContent = isRecurring ? '등록 중…' : '등록 중…';
    }
    try {
        const res = await scheduleAdminBroadcastPushFn(payload);
        const cnt = res?.data?.count;
        if (typeof cnt === 'number' && cnt > 1) {
            alert(
                `예약 ${cnt}건이 발송 기록에 등록되었습니다. 각 행은 예약일시별로 나뉘어 있으며, 대기 중인 건만 개별 취소할 수 있습니다.`
            );
        } else {
            alert('예약이 등록되었습니다.');
        }
        if (!isRecurring) {
            if (titleEl) titleEl.value = '';
            if (bodyEl) bodyEl.value = '';
            if (whenEl) whenEl.value = '';
        } else {
            clearAdminPushWeeklyForm();
            initAdminPushWeeklyDateRange();
        }
        setAdminPushScheduleMinDatetime();
        await refreshAdminScheduledPushesCore();
    } catch (e) {
        console.error(e);
        alert('예약 등록 실패: ' + (e.message || e));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = isRecurring ? '요일별 예약 등록' : '예약 등록';
        }
    }
};
