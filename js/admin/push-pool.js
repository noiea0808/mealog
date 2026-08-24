// ADMIN 푸시 메시지 풀 — 반복 발송용 메시지 보관함
import { db, appId, functions, auth } from '../firebase.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js';
import { collection, query, orderBy, getDocs, limit } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, afterAdminClick } from './utils.js';

const upsertAdminPushMessageFn = httpsCallable(functions, 'upsertAdminPushMessage');
const deleteAdminPushMessageFn = httpsCallable(functions, 'deleteAdminPushMessage');
const importAdminPushMessagesFromHistoryFn = httpsCallable(functions, 'importAdminPushMessagesFromHistory');

/** Cloud Functions `ADMIN_BROADCAST_*_MAX` 와 동일 */
const POOL_TITLE_MAX = 120;
const POOL_BODY_MAX = 240;
/** 한 화면에 그리는 최대 행 수 — 풀이 커져도 렌더가 무너지지 않게 */
const POOL_PAGE_SIZE = 50;

const POOL_LAND_OPTIONS = [
    ['dashboard', '밀당'],
    ['timeline', '밀로그'],
    ['gallery', '모먼트'],
    ['board', '라운지'],
    ['settings', '설정']
];
const POOL_LANDING_LABELS = Object.fromEntries(POOL_LAND_OPTIONS);

const POOL_SORT_OPTIONS = [
    ['recent', '최근 등록순'],
    ['used', '많이 쓴 순'],
    ['lastUsed', '최근 사용순'],
    ['title', '제목순']
];

let poolRows = [];
let poolLoaded = false;
let poolSearch = '';
let poolFilter = 'all'; // all | active | inactive
let poolSort = 'recent';
let poolPage = 0;
/** 인라인 작성/수정 초안 — 저장 전까지 Firestore 미반영 */
let poolDrafts = [];
let poolDraftSeq = 0;

function nextPoolDraftKey() {
    poolDraftSeq += 1;
    return `p${poolDraftSeq}`;
}

function poolFieldId(draftKey, field) {
    return `adminPoolDraft-${field}-${draftKey}`;
}

function findPoolDraft(draftKey) {
    return poolDrafts.find((d) => d.draftKey === draftKey) || null;
}

function findPoolEditDraft(messageId) {
    return poolDrafts.find((d) => d.mode === 'edit' && d.messageId === messageId) || null;
}

function findPoolRow(messageId) {
    return poolRows.find((r) => r.id === messageId) || null;
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

function tsToMillis(ts) {
    if (ts == null) return NaN;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return NaN;
}

/** "3일 전" 같은 상대 표기 — 사용 이력 열용 */
function relativeDayLabel(ts) {
    const ms = tsToMillis(ts);
    if (!Number.isFinite(ms)) return '';
    const diffDays = Math.floor((Date.now() - ms) / 86400000);
    if (diffDays <= 0) return '오늘';
    if (diffDays === 1) return '어제';
    if (diffDays < 30) return `${diffDays}일 전`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)}달 전`;
    return `${Math.floor(diffDays / 365)}년 전`;
}

export function getAdminPushPoolCount() {
    return poolRows.length;
}

function syncPoolCountBadge() {
    const el = document.getElementById('adminPushHistoryCountPool');
    if (el) el.textContent = poolLoaded ? String(poolRows.length) : '—';
}

// ========== 목록 조회 ==========

async function fetchAdminPushPool() {
    const coll = collection(db, 'artifacts', appId, 'adminPushMessages');
    const snap = await getDocs(query(coll, orderBy('createdAt', 'desc'), limit(2000)));
    poolRows = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    poolLoaded = true;
}

/** 검색·필터·정렬을 적용한 목록 */
function visiblePoolRows() {
    const kw = poolSearch.trim().toLowerCase();
    let rows = poolRows.filter((r) => {
        if (poolFilter === 'active' && r.active === false) return false;
        if (poolFilter === 'inactive' && r.active !== false) return false;
        if (!kw) return true;
        return (
            String(r.title || '').toLowerCase().includes(kw) ||
            String(r.body || '').toLowerCase().includes(kw)
        );
    });
    const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ko');
    if (poolSort === 'used') {
        rows = rows.sort((a, b) => (Number(b.useCount) || 0) - (Number(a.useCount) || 0) || byTitle(a, b));
    } else if (poolSort === 'lastUsed') {
        rows = rows.sort((a, b) => (tsToMillis(b.lastUsedAt) || 0) - (tsToMillis(a.lastUsedAt) || 0));
    } else if (poolSort === 'title') {
        rows = rows.sort(byTitle);
    } else {
        rows = rows.sort((a, b) => (tsToMillis(b.createdAt) || 0) - (tsToMillis(a.createdAt) || 0));
    }
    return rows;
}

// ========== 초안 상태 ==========

/** 인라인 입력값을 상태에 반영 (재렌더 시 유실 방지) */
function capturePoolDraftsFromDom() {
    if (!poolDrafts.length) return;
    poolDrafts = poolDrafts.map((draft) => {
        const key = draft.draftKey;
        const titleEl = document.getElementById(poolFieldId(key, 'title'));
        if (!titleEl) return draft;
        const bodyEl = document.getElementById(poolFieldId(key, 'body'));
        const landEl = document.getElementById(poolFieldId(key, 'landing'));
        const activeEl = document.getElementById(poolFieldId(key, 'active'));
        return {
            ...draft,
            title: titleEl.value || '',
            body: bodyEl?.value || '',
            landingTab: landEl?.value || 'dashboard',
            active: activeEl ? activeEl.checked : draft.active !== false
        };
    });
}

function isPoolDraftDirty(d) {
    if (!d) return false;
    if (d.mode === 'edit' && d.original) {
        const o = d.original;
        return (
            String(d.title || '') !== String(o.title || '') ||
            String(d.body || '') !== String(o.body || '') ||
            String(d.landingTab || '') !== String(o.landingTab || '') ||
            Boolean(d.active) !== Boolean(o.active)
        );
    }
    return Boolean(String(d.title || '').trim()) || Boolean(String(d.body || '').trim());
}

function focusPoolDraftRow(draftKey) {
    const el = document.getElementById(poolFieldId(draftKey, 'title'));
    if (el && typeof el.focus === 'function') {
        try {
            el.focus({ preventScroll: true });
        } catch {
            /* ignore */
        }
    }
}

// ========== 렌더 ==========

function buildPoolOptions(opts, sel) {
    return opts.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
}

function buildPoolThead() {
    return `
            <thead>
                <tr class="bg-slate-100/90 text-center text-[11px] font-bold text-slate-600 uppercase tracking-wide border-b border-slate-200">
                    <th class="px-3 py-2.5 whitespace-nowrap">상태</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">랜딩</th>
                    <th class="px-3 py-2.5 min-w-[8rem]">제목</th>
                    <th class="px-3 py-2.5 min-w-[12rem]">내용</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">사용</th>
                    <th class="px-3 py-2.5 whitespace-nowrap">작업</th>
                </tr>
            </thead>`;
}

function buildPoolRowHtml(r) {
    const editDraft = findPoolEditDraft(r.id);
    if (editDraft) return buildPoolEditorRowHtml(editDraft);
    const active = r.active !== false;
    const idJson = JSON.stringify(r.id);
    const useCount = Number(r.useCount) || 0;
    const lastUsed = relativeDayLabel(r.lastUsedAt);
    const useCell = useCount
        ? `<div class="leading-snug"><div class="font-bold text-slate-700 tabular-nums">${useCount}회</div>${
              lastUsed ? `<div class="text-[10px] text-slate-400">${escapeHtml(lastUsed)}</div>` : ''
          }</div>`
        : '<span class="text-slate-300">—</span>';
    const statusCell = active
        ? '<span class="text-xs font-bold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700">활성</span>'
        : '<span class="text-xs font-bold px-2 py-0.5 rounded-md bg-slate-200 text-slate-500">중지</span>';
    return `
            <tr class="border-b border-slate-100 align-top text-center hover:bg-slate-50/60 ${active ? '' : 'opacity-60'}">
                <td class="px-3 py-2 whitespace-nowrap">
                    <button type="button" onclick='window.adminPushPoolToggleActive(${idJson})' title="${active ? '순환에서 제외' : '다시 활성화'}" class="cursor-pointer">${statusCell}</button>
                </td>
                <td class="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">${escapeHtml(POOL_LANDING_LABELS[r.landingTab] || r.landingTab || '—')}</td>
                <td class="px-3 py-2 text-xs font-bold text-slate-800 text-left">${escapeHtml((r.title || '').trim() || '(제목 없음)')}</td>
                <td class="px-3 py-2 text-xs text-slate-600 text-left whitespace-pre-wrap break-words">${escapeHtml((r.body || '').trim() || '—')}</td>
                <td class="px-3 py-2 text-xs whitespace-nowrap">${useCell}</td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <div class="inline-flex flex-wrap justify-center gap-1">
                        <button type="button" onclick='window.adminPushPoolUseAsSchedule(${idJson})' class="px-2 py-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded border border-emerald-100">예약</button>
                        <button type="button" onclick='window.adminPushPoolEdit(${idJson})' class="px-2 py-1 text-[11px] font-bold text-violet-700 bg-violet-50 hover:bg-violet-100 rounded border border-violet-100">수정</button>
                        <button type="button" onclick='window.adminPushPoolDelete(${idJson})' class="px-2 py-1 text-[11px] font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded border border-slate-200">삭제</button>
                    </div>
                </td>
            </tr>`;
}

function buildPoolEditorRowHtml(draft) {
    const key = draft.draftKey;
    const keyAttr = escapeAttr(key);
    const isEdit = draft.mode === 'edit';
    const active = draft.active !== false;
    return `
            <tr id="adminPoolDraftRow-${keyAttr}" class="border-b border-violet-200 bg-violet-50/40 align-top text-center">
                <td class="px-3 py-2 whitespace-nowrap">
                    <label class="inline-flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer">
                        <input type="checkbox" id="${poolFieldId(key, 'active')}" ${active ? 'checked' : ''} class="cursor-pointer">활성
                    </label>
                    <div class="mt-1 text-[10px] font-bold text-amber-700">${isEdit ? '수정중' : '작성중'}</div>
                </td>
                <td class="px-3 py-2 text-xs whitespace-nowrap">
                    <select id="${poolFieldId(key, 'landing')}" class="min-w-[5rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white text-center">${buildPoolOptions(POOL_LAND_OPTIONS, draft.landingTab || 'dashboard')}</select>
                </td>
                <td class="px-3 py-2 text-xs max-w-[14rem]">
                    <input type="text" id="${poolFieldId(key, 'title')}" maxlength="${POOL_TITLE_MAX}" value="${escapeAttr(draft.title || '')}" placeholder="제목" class="w-full min-w-[8rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white">
                </td>
                <td class="px-3 py-2 text-xs max-w-[28rem]">
                    <textarea id="${poolFieldId(key, 'body')}" maxlength="${POOL_BODY_MAX}" rows="2" placeholder="내용" class="w-full min-w-[12rem] p-1.5 border border-slate-200 rounded-lg text-xs bg-white resize-y">${escapeHtml(draft.body || '')}</textarea>
                </td>
                <td class="px-3 py-2 text-xs text-slate-400">—</td>
                <td class="px-3 py-2 whitespace-nowrap">
                    <div class="inline-flex flex-wrap justify-center gap-1">
                        <button type="button" onclick='window.adminPushPoolCancelDraft(${JSON.stringify(key)})' class="px-2 py-1 text-[11px] font-bold text-slate-600 bg-white hover:bg-slate-100 rounded border border-slate-200">취소</button>
                        <button type="button" id="${poolFieldId(key, 'saveBtn')}" onclick='window.adminPushPoolSaveDraft(${JSON.stringify(key)})' class="px-2 py-1 text-[11px] font-bold text-white bg-violet-600 hover:bg-violet-700 rounded border border-violet-600">저장</button>
                    </div>
                </td>
            </tr>`;
}

function buildPoolToolbarHtml() {
    const activeCount = poolRows.filter((r) => r.active !== false).length;
    const inactiveCount = poolRows.length - activeCount;
    const filterBtn = (val, label) => {
        const on = poolFilter === val;
        return `<button type="button" onclick="window.adminPushPoolSetFilter('${val}')" class="px-2.5 py-1 text-xs font-bold rounded-md transition-colors ${
            on ? 'bg-white text-violet-700 shadow-sm ring-1 ring-violet-200/80' : 'text-slate-500 hover:text-slate-700 hover:bg-white/70'
        }">${escapeHtml(label)}</button>`;
    };
    return `
        <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-white border-b border-slate-200">
            <div class="flex flex-wrap items-center gap-2">
                <div class="relative">
                    <i class="fa-solid fa-magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-400" aria-hidden="true"></i>
                    <input type="search" id="adminPushPoolSearch" value="${escapeAttr(poolSearch)}" oninput="window.adminPushPoolSearchInput(this.value)" placeholder="제목·내용 검색" class="w-48 pl-7 pr-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white">
                </div>
                <div class="inline-flex rounded-lg border border-slate-200 bg-slate-100/90 p-0.5 gap-0.5">
                    ${filterBtn('all', `전체 ${poolRows.length}`)}
                    ${filterBtn('active', `활성 ${activeCount}`)}
                    ${filterBtn('inactive', `중지 ${inactiveCount}`)}
                </div>
                <select id="adminPushPoolSort" onchange="window.adminPushPoolSetSort(this.value)" class="p-1.5 border border-slate-200 rounded-lg text-xs bg-white">${buildPoolOptions(POOL_SORT_OPTIONS, poolSort)}</select>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <button type="button" onclick="window.adminPushPoolAddDraft()" class="inline-flex items-center px-3 py-1.5 text-xs font-bold rounded-lg border text-violet-700 bg-violet-50 hover:bg-violet-100 border-violet-200 transition-colors">
                    <i class="fa-solid fa-plus mr-1" aria-hidden="true"></i>메시지 추가
                </button>
                <button type="button" id="adminPushPoolRefreshBtn" onclick="window.refreshAdminPushPool()" class="inline-flex items-center gap-1 text-xs font-bold text-slate-500 hover:text-violet-600 px-2 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">
                    <i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i><span>새로고침</span>
                </button>
            </div>
        </div>`;
}

function buildPoolPagerHtml(total, pageCount) {
    if (pageCount <= 1) return '';
    const from = poolPage * POOL_PAGE_SIZE + 1;
    const to = Math.min(total, (poolPage + 1) * POOL_PAGE_SIZE);
    const btn = (target, label, disabled) =>
        `<button type="button" ${disabled ? 'disabled' : ''} onclick="window.adminPushPoolSetPage(${target})" class="px-2.5 py-1 text-xs font-bold rounded-md border transition-colors ${
            disabled
                ? 'text-slate-300 bg-slate-50 border-slate-100 cursor-not-allowed'
                : 'text-slate-600 bg-white border-slate-200 hover:bg-slate-100'
        }">${escapeHtml(label)}</button>`;
    return `
        <div class="flex items-center justify-center gap-2 px-3 py-2 border-t border-slate-200 bg-white">
            ${btn(poolPage - 1, '이전', poolPage === 0)}
            <span class="text-xs text-slate-500 tabular-nums">${from}–${to} / ${total}</span>
            ${btn(poolPage + 1, '다음', poolPage >= pageCount - 1)}
        </div>`;
}

export function renderAdminPushPoolFromCache() {
    const toolbar = document.getElementById('adminPushPoolToolbar');
    const container = document.getElementById('adminPushPoolContainer');
    if (!container) return;
    syncPoolCountBadge();
    if (toolbar) toolbar.innerHTML = buildPoolToolbarHtml();

    const rows = visiblePoolRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / POOL_PAGE_SIZE));
    if (poolPage > pageCount - 1) poolPage = pageCount - 1;
    if (poolPage < 0) poolPage = 0;
    const pageRows = rows.slice(poolPage * POOL_PAGE_SIZE, (poolPage + 1) * POOL_PAGE_SIZE);

    // 목록에서 사라진 대상의 수정 초안은 정리
    const visibleIds = new Set(poolRows.map((r) => r.id));
    poolDrafts = poolDrafts.filter((d) => d.mode !== 'edit' || visibleIds.has(d.messageId));
    const createDrafts = poolDrafts.filter((d) => d.mode === 'create');

    if (rows.length === 0 && createDrafts.length === 0) {
        const msg = poolRows.length === 0
            ? '풀에 담긴 메시지가 없습니다. 발송예정·발송완료 목록에서 골라 담거나, 메시지 추가로 직접 등록해 주세요.'
            : '검색·필터 조건에 맞는 메시지가 없습니다.';
        container.innerHTML = `<p class="text-center py-10 text-slate-400 text-sm px-4">${msg}</p>`;
        return;
    }

    const tbody = pageRows.map(buildPoolRowHtml).join('') + createDrafts.map(buildPoolEditorRowHtml).join('');
    container.innerHTML = `<div class="overflow-x-auto">
                <table class="w-full min-w-[820px] text-center border-collapse">${buildPoolThead()}<tbody>${tbody}</tbody></table>
            </div>${buildPoolPagerHtml(rows.length, pageCount)}`;
}

/** 풀 탭 진입 — 이미 불러왔으면 캐시로 그린다 */
export async function loadAdminPushPool({ force = false } = {}) {
    const container = document.getElementById('adminPushPoolContainer');
    if (!container) return;
    if (poolLoaded && !force) {
        renderAdminPushPoolFromCache();
        return;
    }
    container.innerHTML =
        '<p class="text-center py-8 text-slate-400 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2" aria-hidden="true"></i>불러오는 중…</p>';
    try {
        await fetchAdminPushPool();
        renderAdminPushPoolFromCache();
    } catch (e) {
        console.error('메시지 풀 조회 실패:', e);
        container.innerHTML = `<p class="text-center py-8 text-red-400 text-sm px-4">메시지 풀을 불러오지 못했습니다. ${escapeHtml(e.message || '')}</p>`;
    }
}

// ========== 이벤트 핸들러 ==========

window.refreshAdminPushPool = async function () {
    capturePoolDraftsFromDom();
    await loadAdminPushPool({ force: true });
};

window.adminPushPoolSearchInput = function (value) {
    poolSearch = String(value || '');
    poolPage = 0;
    capturePoolDraftsFromDom();
    // 입력 중 포커스를 잃지 않도록 표만 다시 그린다
    const rows = visiblePoolRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / POOL_PAGE_SIZE));
    const pageRows = rows.slice(0, POOL_PAGE_SIZE);
    const container = document.getElementById('adminPushPoolContainer');
    if (!container) return;
    const createDrafts = poolDrafts.filter((d) => d.mode === 'create');
    if (rows.length === 0 && createDrafts.length === 0) {
        container.innerHTML =
            '<p class="text-center py-10 text-slate-400 text-sm px-4">검색·필터 조건에 맞는 메시지가 없습니다.</p>';
        return;
    }
    const tbody = pageRows.map(buildPoolRowHtml).join('') + createDrafts.map(buildPoolEditorRowHtml).join('');
    container.innerHTML = `<div class="overflow-x-auto">
                <table class="w-full min-w-[820px] text-center border-collapse">${buildPoolThead()}<tbody>${tbody}</tbody></table>
            </div>${buildPoolPagerHtml(rows.length, pageCount)}`;
};

window.adminPushPoolSetFilter = function (value) {
    poolFilter = value;
    poolPage = 0;
    capturePoolDraftsFromDom();
    afterAdminClick(() => renderAdminPushPoolFromCache());
};

window.adminPushPoolSetSort = function (value) {
    poolSort = value;
    poolPage = 0;
    capturePoolDraftsFromDom();
    renderAdminPushPoolFromCache();
};

window.adminPushPoolSetPage = function (page) {
    poolPage = Number(page) || 0;
    capturePoolDraftsFromDom();
    afterAdminClick(() => renderAdminPushPoolFromCache());
};

window.adminPushPoolAddDraft = function () {
    capturePoolDraftsFromDom();
    const draftKey = nextPoolDraftKey();
    poolDrafts.push({
        mode: 'create',
        draftKey,
        title: '',
        body: '',
        landingTab: 'dashboard',
        active: true
    });
    afterAdminClick(() => {
        renderAdminPushPoolFromCache();
        focusPoolDraftRow(draftKey);
    });
};

window.adminPushPoolEdit = function (messageId) {
    const r = findPoolRow(messageId);
    if (!r) {
        alert('메시지를 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.');
        return;
    }
    capturePoolDraftsFromDom();
    const existing = findPoolEditDraft(messageId);
    if (existing) {
        afterAdminClick(() => {
            renderAdminPushPoolFromCache();
            focusPoolDraftRow(existing.draftKey);
        });
        return;
    }
    const draftKey = nextPoolDraftKey();
    const fields = {
        title: String(r.title || ''),
        body: String(r.body || ''),
        landingTab: r.landingTab || 'dashboard',
        active: r.active !== false
    };
    poolDrafts.push({ mode: 'edit', draftKey, messageId, ...fields, original: { ...fields } });
    afterAdminClick(() => {
        renderAdminPushPoolFromCache();
        focusPoolDraftRow(draftKey);
    });
};

window.adminPushPoolCancelDraft = function (draftKey) {
    capturePoolDraftsFromDom();
    const draft = findPoolDraft(draftKey);
    if (!draft) return;
    if (isPoolDraftDirty(draft)) {
        const msg = draft.mode === 'edit' ? '수정 중인 내용을 취소할까요?' : '작성 중인 내용을 취소할까요?';
        if (!confirm(msg)) return;
    }
    poolDrafts = poolDrafts.filter((d) => d.draftKey !== draftKey);
    afterAdminClick(() => renderAdminPushPoolFromCache());
};

window.adminPushPoolSaveDraft = async function (draftKey) {
    capturePoolDraftsFromDom();
    const draft = findPoolDraft(draftKey);
    if (!draft) return;
    const title = String(draft.title || '').trim();
    const body = String(draft.body || '').trim();
    if (!title) {
        alert('제목을 입력해 주세요.');
        document.getElementById(poolFieldId(draftKey, 'title'))?.focus();
        return;
    }
    if (!body) {
        alert('내용을 입력해 주세요.');
        document.getElementById(poolFieldId(draftKey, 'body'))?.focus();
        return;
    }
    if (!auth.currentUser?.uid) {
        alert('로그인이 필요합니다.');
        return;
    }
    const btn = document.getElementById(poolFieldId(draftKey, 'saveBtn'));
    if (btn) {
        btn.disabled = true;
        btn.textContent = '저장 중…';
    }
    try {
        const res = await upsertAdminPushMessageFn({
            ...(draft.mode === 'edit' ? { messageId: draft.messageId } : {}),
            title,
            body,
            landingTab: draft.landingTab || 'dashboard',
            active: draft.active !== false
        });
        poolDrafts = poolDrafts.filter((d) => d.draftKey !== draftKey);
        await loadAdminPushPool({ force: true });
        if (res?.data?.duplicated) {
            alert('같은 제목·내용의 메시지가 이미 풀에 있어 새로 담지 않았습니다.');
        }
    } catch (e) {
        console.error('메시지 저장 실패:', e);
        alert('저장 실패: ' + (e?.message || e));
        if (btn) {
            btn.disabled = false;
            btn.textContent = '저장';
        }
    }
};

window.adminPushPoolToggleActive = async function (messageId) {
    const r = findPoolRow(messageId);
    if (!r) return;
    const next = r.active === false;
    try {
        await upsertAdminPushMessageFn({
            messageId,
            title: String(r.title || ''),
            body: String(r.body || ''),
            landingTab: r.landingTab || 'dashboard',
            active: next
        });
        r.active = next;
        afterAdminClick(() => renderAdminPushPoolFromCache());
    } catch (e) {
        console.error('상태 변경 실패:', e);
        alert('상태 변경 실패: ' + (e?.message || e));
    }
};

window.adminPushPoolDelete = async function (messageId) {
    const r = findPoolRow(messageId);
    if (!r) return;
    const label = (r.title || '').trim() || '(제목 없음)';
    if (!confirm(`"${label}" 메시지를 풀에서 삭제할까요?\n이미 등록된 예약에는 영향이 없습니다.`)) return;
    try {
        await deleteAdminPushMessageFn({ messageId });
        await loadAdminPushPool({ force: true });
    } catch (e) {
        console.error('메시지 삭제 실패:', e);
        alert('삭제 실패: ' + (e?.message || e));
    }
};

/** 풀 메시지를 발송예정 탭의 작성 행으로 옮긴다 (등록은 그쪽에서) */
window.adminPushPoolUseAsSchedule = function (messageId) {
    const r = findPoolRow(messageId);
    if (!r) return;
    if (typeof window.createAdminPushDraftFromPoolMessage !== 'function') {
        alert('예약 작성 화면을 열 수 없습니다. 새로고침 후 다시 시도해 주세요.');
        return;
    }
    window.createAdminPushDraftFromPoolMessage({
        messageId,
        title: String(r.title || ''),
        body: String(r.body || ''),
        landingTab: r.landingTab || 'dashboard'
    });
};

/**
 * 발송예정·발송완료에서 선택한 기록을 풀에 담는다.
 * @param {string[]} jobIds
 * @returns {Promise<{imported:number, skippedDuplicate:number, skippedInvalid:number}|null>}
 */
export async function importAdminPushHistoryToPool(jobIds) {
    const ids = [...new Set((jobIds || []).map((v) => String(v || '').trim()).filter(Boolean))];
    if (ids.length === 0) {
        alert('풀에 담을 항목을 선택해 주세요.');
        return null;
    }
    if (!auth.currentUser?.uid) {
        alert('로그인이 필요합니다.');
        return null;
    }
    const res = await importAdminPushMessagesFromHistoryFn({ jobIds: ids });
    const data = res?.data || {};
    // 다음 풀 탭 진입 때 최신 목록을 다시 읽도록
    poolLoaded = false;
    return {
        imported: Number(data.imported) || 0,
        skippedDuplicate: Number(data.skippedDuplicate) || 0,
        skippedInvalid: Number(data.skippedInvalid) || 0
    };
}
