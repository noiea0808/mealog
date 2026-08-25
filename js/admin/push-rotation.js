// ADMIN 푸시 순환 발송 설정 — 풀에서 셔플로 하나씩 꺼내 정기 발송
import { db, appId, functions, auth } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    getCountFromServer
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { escapeHtml, afterAdminClick } from './utils.js';

const saveAdminPushRotationFn = httpsCallable(functions, 'saveAdminPushRotation');
const planAdminPushRotationNowFn = httpsCallable(functions, 'planAdminPushRotationNow');
const reshuffleAdminPushRotationFn = httpsCallable(functions, 'reshuffleAdminPushRotation');

const ROTATION_ID = 'default';
const WEEKDAYS = [
    [1, '월'],
    [2, '화'],
    [3, '수'],
    [4, '목'],
    [5, '금'],
    [6, '토'],
    [7, '일']
];
const ENV_OPTIONS = [
    ['all', '전체'],
    ['production', '운영'],
    ['staging', '스테이징']
];

/**
 * 화면 상태. 서버는 슬롯을 [{weekday,time}] 쌍으로 저장하지만, 화면에서는
 * "요일 × 시각" 곱으로 다룬다 — 실제 운영이 "월·수·금 09:00·20:00" 형태라서다.
 */
let rot = null;
let weekdaySet = new Set();
let times = [];
let poolActiveCount = null;
let loading = false;

function defaultRotationState() {
    return {
        enabled: false,
        targetEnv: 'staging',
        horizonDays: 14,
        newMessagePriority: true,
        priorityWindow: 10,
        cycleNo: 0,
        deckRemaining: [],
        deckServed: [],
        plannedUntilYmd: ''
    };
}

/** 저장된 슬롯 쌍 → 요일 집합 + 시각 목록 (이 화면만 쓰기 때문에 항상 곱 형태다) */
function slotsToUiState(slots) {
    const wd = new Set();
    const tset = new Set();
    for (const s of slots || []) {
        const w = Number(s?.weekday);
        const t = String(s?.time || '');
        if (w >= 1 && w <= 7) wd.add(w);
        if (/^\d{2}:\d{2}$/.test(t)) tset.add(t);
    }
    return { weekdaySet: wd, times: [...tset].sort() };
}

function uiStateToSlots() {
    const out = [];
    for (const w of [...weekdaySet].sort((a, b) => a - b)) {
        for (const t of times) out.push({ weekday: w, time: t });
    }
    return out;
}

function fmtYmdKo(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '—';
    const [y, m, d] = ymd.split('-').map(Number);
    const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
    const wd = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(
        new Date(noonUtc)
    );
    return `${m}/${d} (${wd})`;
}

function tsToMillis(ts) {
    if (ts == null) return NaN;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return NaN;
}

/** 발송예정 목록에서 순환이 만든 다음 1건 (push-broadcast 가 이미 읽어둔 것을 쓴다) */
function nextRotationRow() {
    const rows = typeof window.getAdminPushUpcomingRows === 'function' ? window.getAdminPushUpcomingRows() : [];
    return (
        rows
            .filter((r) => r.scheduleSource === 'rotation' && (r.status || 'pending') === 'pending')
            .sort((a, b) => tsToMillis(a.scheduledAt) - tsToMillis(b.scheduledAt))[0] || null
    );
}

// ========== 조회 ==========

async function fetchRotation() {
    const ref = doc(db, 'artifacts', appId, 'adminPushRotations', ROTATION_ID);
    const snap = await getDoc(ref);
    rot = snap.exists() ? { ...defaultRotationState(), ...snap.data() } : defaultRotationState();
    const ui = slotsToUiState(rot.slots);
    weekdaySet = ui.weekdaySet;
    times = ui.times;
    try {
        const coll = collection(db, 'artifacts', appId, 'adminPushMessages');
        const agg = await getCountFromServer(query(coll, where('active', '==', true)));
        poolActiveCount = agg.data().count;
    } catch {
        poolActiveCount = null;
    }
}

// ========== 렌더 ==========

function buildWeekdayChipsHtml() {
    return WEEKDAYS.map(([w, label]) => {
        const on = weekdaySet.has(w);
        return `<button type="button" onclick="window.adminPushRotationToggleWeekday(${w})" class="w-9 h-9 rounded-lg text-xs font-bold border transition-colors ${
            on
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
        }">${escapeHtml(label)}</button>`;
    }).join('');
}

function buildTimesHtml() {
    if (times.length === 0) {
        return '<span class="text-xs text-slate-400">시각을 추가해 주세요.</span>';
    }
    return times
        .map(
            (t) =>
                `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 border border-slate-200 text-xs font-bold text-slate-700 tabular-nums">${escapeHtml(
                    t
                )}<button type="button" onclick="window.adminPushRotationRemoveTime('${escapeHtml(
                    t
                )}')" class="text-slate-400 hover:text-red-500" title="제거"><i class="fa-solid fa-xmark text-[10px]" aria-hidden="true"></i></button></span>`
        )
        .join('');
}

function buildStatusHtml() {
    const remaining = Array.isArray(rot.deckRemaining) ? rot.deckRemaining.length : 0;
    const cycleNo = Number(rot.cycleNo) || 0;
    const pool = poolActiveCount;
    const next = nextRotationRow();
    const cycleLine =
        cycleNo === 0
            ? '아직 시작하지 않았습니다.'
            : `${cycleNo}번째 바퀴 · ${pool == null ? '?' : pool}개 중 <b class="text-violet-700 tabular-nums">${remaining}</b>개 남음`;
    const nextLine = next
        ? `${new Intl.DateTimeFormat('ko-KR', {
              timeZone: 'Asia/Seoul',
              month: 'numeric',
              day: 'numeric',
              weekday: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
          }).format(new Date(tsToMillis(next.scheduledAt)))} — ${escapeHtml(
              (next.title || '').trim() || '(제목 없음)'
          )}`
        : '예정된 순환 발송이 없습니다.';
    const poolWarn =
        pool === 0
            ? '<div class="mt-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs font-bold text-amber-800"><i class="fa-solid fa-triangle-exclamation mr-1" aria-hidden="true"></i>풀에 활성 메시지가 없어 배정이 멈춥니다. 메시지 풀 탭에서 먼저 담아 주세요.</div>'
            : '';
    return `
        <div class="mt-5 pt-4 border-t border-slate-200">
            <h4 class="text-xs font-black text-slate-500 mb-2">현재 상태</h4>
            <dl class="space-y-1 text-xs text-slate-600">
                <div class="flex gap-2"><dt class="w-20 shrink-0 font-bold text-slate-500">진행</dt><dd>${cycleLine}</dd></div>
                <div class="flex gap-2"><dt class="w-20 shrink-0 font-bold text-slate-500">다음 발송</dt><dd>${nextLine}</dd></div>
                <div class="flex gap-2"><dt class="w-20 shrink-0 font-bold text-slate-500">배정 완료</dt><dd class="tabular-nums">${escapeHtml(
                    fmtYmdKo(rot.plannedUntilYmd)
                )} 까지</dd></div>
            </dl>
            ${poolWarn}
            <div class="mt-3 flex flex-wrap gap-2">
                <button type="button" id="adminPushRotationPlanBtn" onclick="window.adminPushRotationPlanNow()" class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border text-slate-600 bg-white hover:bg-slate-100 border-slate-200 transition-colors">
                    <i class="fa-solid fa-arrows-rotate mr-1" aria-hidden="true"></i>지금 다시 채우기
                </button>
                <button type="button" id="adminPushRotationReshuffleBtn" onclick="window.adminPushRotationReshuffle()" class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200 transition-colors">
                    <i class="fa-solid fa-shuffle mr-1" aria-hidden="true"></i>남은 바퀴 다시 섞기
                </button>
            </div>
        </div>`;
}

function buildRotationFormHtml() {
    const row = (label, inner, hint) => `
        <div class="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 border-b border-slate-100 last:border-0">
            <div class="w-28 shrink-0 pt-1.5 text-xs font-bold text-slate-500">${escapeHtml(label)}</div>
            <div class="flex-1 min-w-[16rem]">${inner}${
                hint ? `<p class="mt-1 text-[11px] text-slate-400">${hint}</p>` : ''
            }</div>
        </div>`;
    const envOpts = ENV_OPTIONS.map(
        ([v, l]) => `<option value="${v}" ${rot.targetEnv === v ? 'selected' : ''}>${escapeHtml(l)}</option>`
    ).join('');
    return `
        <div class="p-4">
            ${row(
                '순환 발송',
                `<label class="inline-flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" id="adminPushRotationEnabled" ${rot.enabled ? 'checked' : ''} class="cursor-pointer">
                    <span class="text-xs font-bold text-slate-700">켜기</span>
                </label>`,
                '끄면 새 배정이 멈춥니다. 이미 깔린 예약은 그대로 나갑니다.'
            )}
            ${row(
                '대상 환경',
                `<select id="adminPushRotationEnv" class="p-1.5 border border-slate-200 rounded-lg text-xs bg-white">${envOpts}</select>`
            )}
            ${row(
                '발송 요일',
                `<div id="adminPushRotationWeekdays" class="flex flex-wrap gap-1.5">${buildWeekdayChipsHtml()}</div>`
            )}
            ${row(
                '발송 시각',
                `<div class="flex flex-wrap items-center gap-1.5">
                    <span id="adminPushRotationTimes" class="flex flex-wrap items-center gap-1.5">${buildTimesHtml()}</span>
                    <input type="time" id="adminPushRotationTimeInput" value="09:00" class="p-1.5 border border-slate-200 rounded-lg text-xs bg-white">
                    <button type="button" onclick="window.adminPushRotationAddTime()" class="px-2 py-1.5 text-xs font-bold rounded-lg border text-violet-700 bg-violet-50 hover:bg-violet-100 border-violet-200">추가</button>
                </div>`,
                '선택한 요일마다 이 시각들에 한 건씩 나갑니다.'
            )}
            ${row(
                '미리 배정',
                `<span class="inline-flex items-center gap-1.5"><input type="number" id="adminPushRotationHorizon" min="1" max="60" value="${
                    Number(rot.horizonDays) || 14
                }" class="w-16 p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center tabular-nums"><span class="text-xs text-slate-600">일치</span></span>`,
                '이만큼 앞서 예약을 만들어 둡니다. 발송예정 목록에서 미리 확인·수정할 수 있습니다.'
            )}
            ${row(
                '새 메시지 우선',
                `<span class="inline-flex flex-wrap items-center gap-2">
                    <label class="inline-flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" id="adminPushRotationPriority" ${rot.newMessagePriority !== false ? 'checked' : ''} class="cursor-pointer">
                        <span class="text-xs font-bold text-slate-700">켜기</span>
                    </label>
                    <span class="inline-flex items-center gap-1.5 text-xs text-slate-600">다음 <input type="number" id="adminPushRotationWindow" min="1" max="100" value="${
                        Number(rot.priorityWindow) || 10
                    }" class="w-14 p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center tabular-nums"> 회 안에</span>
                </span>`,
                '풀이 커질수록 한 바퀴가 길어집니다. 켜두면 새로 담은 메시지가 몇 달 뒤가 아니라 곧 나갑니다.'
            )}
            <div class="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" id="adminPushRotationSaveBtn" onclick="window.adminPushRotationSave()" class="inline-flex items-center px-4 py-2 text-xs font-bold rounded-lg border text-white bg-violet-600 hover:bg-violet-700 border-violet-600 transition-colors">
                    <i class="fa-solid fa-save mr-1" aria-hidden="true"></i>저장
                </button>
                <span class="text-[11px] text-slate-400">요일·시각·대상 환경을 바꾸면 아직 안 나간 순환 예약을 다시 깝니다.</span>
            </div>
            ${buildStatusHtml()}
        </div>`;
}

export function renderAdminPushRotationFromCache() {
    const container = document.getElementById('adminPushRotationContainer');
    if (!container) return;
    if (!rot) {
        container.innerHTML =
            '<p class="text-center py-8 text-slate-400 text-sm">순환 설정을 불러오는 중…</p>';
        return;
    }
    container.innerHTML = buildRotationFormHtml();
}

export async function loadAdminPushRotation({ force = false } = {}) {
    const container = document.getElementById('adminPushRotationContainer');
    if (!container) return;
    if (rot && !force) {
        renderAdminPushRotationFromCache();
        return;
    }
    if (loading) return;
    loading = true;
    container.innerHTML =
        '<p class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>불러오는 중…</p>';
    try {
        await fetchRotation();
        renderAdminPushRotationFromCache();
    } catch (e) {
        console.error('순환 설정 조회 실패:', e);
        container.innerHTML = `<p class="text-center py-8 text-red-400 text-sm px-4">순환 설정을 불러오지 못했습니다. ${escapeHtml(
            e.message || ''
        )}</p>`;
    } finally {
        loading = false;
    }
}

// ========== 이벤트 핸들러 ==========

/** 요일 칩·시각 목록만 다시 그린다 — 숫자 입력 포커스를 지키기 위해 폼 전체는 건드리지 않는다 */
function refreshSlotEditors() {
    const wd = document.getElementById('adminPushRotationWeekdays');
    if (wd) wd.innerHTML = buildWeekdayChipsHtml();
    const tm = document.getElementById('adminPushRotationTimes');
    if (tm) tm.innerHTML = buildTimesHtml();
}

window.adminPushRotationToggleWeekday = function (weekday) {
    const w = Number(weekday);
    if (weekdaySet.has(w)) weekdaySet.delete(w);
    else weekdaySet.add(w);
    afterAdminClick(refreshSlotEditors);
};

window.adminPushRotationAddTime = function () {
    const el = document.getElementById('adminPushRotationTimeInput');
    const v = String(el?.value || '').trim();
    if (!/^\d{2}:\d{2}$/.test(v)) {
        alert('시각을 선택해 주세요.');
        return;
    }
    if (!times.includes(v)) {
        times = [...times, v].sort();
    }
    afterAdminClick(refreshSlotEditors);
};

window.adminPushRotationRemoveTime = function (t) {
    times = times.filter((x) => x !== t);
    afterAdminClick(refreshSlotEditors);
};

function readRotationForm() {
    const num = (id, fallback) => {
        const n = Number(document.getElementById(id)?.value);
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
    };
    return {
        rotationId: ROTATION_ID,
        enabled: document.getElementById('adminPushRotationEnabled')?.checked === true,
        targetEnv: document.getElementById('adminPushRotationEnv')?.value || 'all',
        slots: uiStateToSlots(),
        horizonDays: num('adminPushRotationHorizon', 14),
        newMessagePriority: document.getElementById('adminPushRotationPriority')?.checked !== false,
        priorityWindow: num('adminPushRotationWindow', 10)
    };
}

/** 버튼을 잠그고 실행 — 저장·배정은 서버에서 예약을 다시 까므로 중복 클릭을 막는다 */
async function runRotationAction(btnId, busyText, work) {
    if (!auth.currentUser?.uid) {
        alert('로그인이 필요합니다.');
        return null;
    }
    const btn = document.getElementById(btnId);
    const original = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1" aria-hidden="true"></i>${busyText}`;
    }
    try {
        return await work();
    } catch (e) {
        console.error('순환 작업 실패:', e);
        alert('실패: ' + (e?.message || e));
        return null;
    } finally {
        if (btn) {
            btn.disabled = false;
            if (original) btn.innerHTML = original;
        }
    }
}

function describePlanned(planned) {
    if (!planned) return '';
    const reasons = {
        disabled: '순환이 꺼져 있어 배정하지 않았습니다.',
        'no-slots': '발송 요일·시각이 없어 배정하지 않았습니다.',
        'empty-pool': '풀에 활성 메시지가 없어 배정하지 않았습니다.',
        'no-occurrence': '기간 안에 배정할 슬롯이 없습니다.',
        'not-found': '순환 설정을 찾을 수 없습니다.'
    };
    if (planned.reason && reasons[planned.reason]) return reasons[planned.reason];
    return `예약 ${planned.created || 0}건을 새로 깔았습니다.`;
}

/** 저장·배정 후 발송예정 목록까지 같이 새로 읽는다 */
async function refreshAfterRotationChange() {
    await loadAdminPushRotation({ force: true });
    if (typeof window.refreshAdminScheduledPushesQuiet === 'function') {
        await window.refreshAdminScheduledPushesQuiet();
    }
    renderAdminPushRotationFromCache();
}

window.adminPushRotationSave = async function () {
    const payload = readRotationForm();
    if (payload.enabled && payload.slots.length === 0) {
        alert('순환을 켜려면 발송 요일과 시각을 하나 이상 골라 주세요.');
        return;
    }
    const res = await runRotationAction('adminPushRotationSaveBtn', '저장 중…', () =>
        saveAdminPushRotationFn(payload)
    );
    if (!res) return;
    await refreshAfterRotationChange();
    alert('저장했습니다. ' + describePlanned(res?.data?.planned));
};

window.adminPushRotationPlanNow = async function () {
    const res = await runRotationAction('adminPushRotationPlanBtn', '채우는 중…', () =>
        planAdminPushRotationNowFn({ rotationId: ROTATION_ID })
    );
    if (!res) return;
    await refreshAfterRotationChange();
    alert(describePlanned(res?.data?.planned));
};

window.adminPushRotationReshuffle = async function () {
    if (
        !confirm(
            '아직 안 나간 순환 예약을 모두 되돌리고 남은 바퀴를 다시 섞을까요?\n이미 발송된 건과 직접 만든 예약은 그대로입니다.'
        )
    ) {
        return;
    }
    const res = await runRotationAction('adminPushRotationReshuffleBtn', '섞는 중…', () =>
        reshuffleAdminPushRotationFn({ rotationId: ROTATION_ID })
    );
    if (!res) return;
    await refreshAfterRotationChange();
    const d = res?.data || {};
    alert(`${d.rewound || 0}건을 되돌리고 다시 섞었습니다. ` + describePlanned(d.planned));
};

/** 풀이 바뀌면 상태 표시(잔여·풀 크기)가 낡는다 */
export function invalidateAdminPushRotationCache() {
    rot = null;
    poolActiveCount = null;
}
