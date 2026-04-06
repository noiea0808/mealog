/**
 * 관리 로그 — 날짜별(로컬 YYYY-MM-DD) 다중 블록
 * 경로: artifacts/{appId}/adminLogs/{dateKey}/entries/{entryId}
 * UI: 사이드바는 항목별 `2026년 4월 1일(수)_13:30:30` 형식, 우측 단일 패널. 「추가」로 선택 날짜(없으면 오늘)에 블록 적층.
 */
import { db, appId } from '../firebase.js';
import {
    collection,
    getDocs,
    doc,
    getDoc,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    query,
    orderBy,
    serverTimestamp,
    deleteField
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { sanitizeAdminLogHtml } from '../render/utils.js';
import { getTodayDateString } from './utils.js';

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 900_000;
const MAX_TITLE = 120;

function normalizeTitle(raw) {
    if (raw == null) return '';
    return String(raw)
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE);
}

function adminLogsCol() {
    return collection(db, 'artifacts', appId, 'adminLogs');
}

/** @param {string} dateKey */
function entriesCol(dateKey) {
    return collection(db, 'artifacts', appId, 'adminLogs', dateKey, 'entries');
}

function parentDocRef(dateKey) {
    return doc(db, 'artifacts', appId, 'adminLogs', dateKey);
}

function sortDateKeysDesc(keys) {
    return [...keys].filter((k) => DATE_KEY_RE.test(k)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** @param {unknown} ts Firestore Timestamp 등 */
function tsToMs(ts) {
    if (ts == null) return null;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return null;
}

/** dateKey(YYYY-MM-DD) → 해당일 00:00 로컬 ms */
function dateKeyToLocalMidnightMs(dateKey) {
    const parts = dateKey.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return Date.now();
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

/**
 * @param {string} dateKey
 * @param {number | null} createdAtMs
 */
function formatSidebarEntryLabel(dateKey, createdAtMs) {
    const ms =
        createdAtMs != null && !Number.isNaN(createdAtMs)
            ? createdAtMs
            : dateKeyToLocalMidnightMs(dateKey);
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}년 ${m}월 ${day}일(${wd})_${hh}:${mm}:${ss}`;
}

/** 텍스트가 비었는지(태그만 있는 경우 포함) */
function bodyIsEffectivelyEmpty(body) {
    if (body == null || body === '') return true;
    const el = document.createElement('div');
    el.innerHTML = body;
    return (el.textContent || '').trim().length === 0;
}

function looksLikeHtml(s) {
    return typeof s === 'string' && /<[a-z][\s\S]*>/i.test(s.trim());
}

const VIEW_CONTENT_CLASS =
    'admin-log-entry-view text-sm text-slate-800 break-words [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6';

const EDITOR_CLASS =
    'admin-log-entry-editor w-full p-3 border border-slate-200 rounded-lg text-sm text-slate-800 outline-none focus:border-emerald-500 bg-white';

let listenersBound = false;
/** @type {string[]} */
let cachedDateKeys = [];
/** @type {string | null} */
let selectedDateKey = null;
/** @type {string | null} */
let selectedEntryId = null;
/** @type {Record<string, { id: string, body: string, title: string, createdAtMs: number | null }[]>} */
let entriesCache = {};

function getEls() {
    return {
        list: document.getElementById('adminLogDateList'),
        entriesWrap: document.getElementById('adminLogEntriesWrap'),
        entriesContainer: document.getElementById('adminLogEntriesContainer'),
        addBtn: document.getElementById('adminLogAddBtn'),
        emptyHint: document.getElementById('adminLogEmptyHint'),
        headerToolbar: document.getElementById('adminLogHeaderToolbar'),
        headerActionsView: document.getElementById('adminLogHeaderActionsView'),
        headerActionsEdit: document.getElementById('adminLogHeaderActionsEdit')
    };
}

function getEntryWrap() {
    return document.querySelector('#adminLogEntriesContainer .admin-log-entry');
}

function syncAdminLogHeader() {
    const { headerToolbar, headerActionsView, headerActionsEdit } = getEls();
    if (!headerToolbar) return;
    const wrap = getEntryWrap();
    if (!selectedEntryId || !selectedDateKey || !wrap) {
        headerToolbar.classList.add('hidden');
        return;
    }
    headerToolbar.classList.remove('hidden');
    const editor = wrap.querySelector('.admin-log-entry-editor');
    const isEdit = !!(editor && !editor.classList.contains('hidden'));
    if (headerActionsView) headerActionsView.classList.toggle('hidden', isEdit);
    if (headerActionsEdit) headerActionsEdit.classList.toggle('hidden', !isEdit);
}

function updateEditorChrome() {
    const { emptyHint, entriesWrap } = getEls();
    const hasEntry = !!(selectedDateKey && selectedEntryId);
    if (emptyHint) emptyHint.classList.toggle('hidden', hasEntry);
    if (entriesWrap) entriesWrap.classList.toggle('hidden', !hasEntry);
    syncAdminLogHeader();
}

/** 최신순(같은 시각이면 dateKey·id 안정 정렬) */
function getAllEntriesFlat() {
    /** @type {{ dateKey: string, id: string, body: string, title: string, createdAtMs: number | null }[]} */
    const rows = [];
    for (const dateKey of sortDateKeysDesc(cachedDateKeys)) {
        const arr = entriesCache[dateKey] || [];
        for (const e of arr) {
            rows.push({ dateKey, ...e });
        }
    }
    rows.sort((a, b) => {
        const ta = a.createdAtMs ?? dateKeyToLocalMidnightMs(a.dateKey);
        const tb = b.createdAtMs ?? dateKeyToLocalMidnightMs(b.dateKey);
        if (tb !== ta) return tb - ta;
        if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
        return a.id < b.id ? 1 : -1;
    });
    return rows;
}

function renderSidebarList() {
    const { list } = getEls();
    if (!list) return;
    const flat = getAllEntriesFlat();
    if (flat.length === 0) {
        list.innerHTML =
            '<p class="text-xs text-slate-400 px-2 py-3 text-center">저장된 로그가 없습니다.<br>「추가」로 오늘 첫 블록을 만들 수 있습니다.</p>';
        return;
    }
    list.innerHTML = flat
        .map((row) => {
            const active = row.dateKey === selectedDateKey && row.id === selectedEntryId;
            const cls = active
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50';
            const label = formatSidebarEntryLabel(row.dateKey, row.createdAtMs);
            const t = normalizeTitle(row.title);
            const sub =
                t.length > 0
                    ? `<span class="block mt-0.5 text-[10px] font-semibold text-slate-500 leading-tight truncate min-w-0" title="${escapeAttr(t)}">${escapeAttr(t)}</span>`
                    : '';
            return `<button type="button" class="admin-log-block-item w-full min-w-0 max-w-full text-left px-2.5 py-2 rounded-xl border text-xs font-bold leading-snug transition-colors ${cls}" data-date-key="${row.dateKey}" data-entry-id="${row.id}"><span class="block break-words">${escapeAttr(label)}</span>${sub}</button>`;
        })
        .join('');
}

function escapeAttr(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function showAdminLogToast(message, kind = 'ok') {
    const bg = kind === 'error' ? 'bg-red-600' : 'bg-emerald-600';
    const div = document.createElement('div');
    div.className = `fixed top-4 right-4 ${bg} text-white px-5 py-3 rounded-xl shadow-lg z-[600] text-sm font-bold`;
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 2800);
}

/** 구버전 단일 body → entries 1건으로 옮기고 body 필드 제거 */
async function migrateLegacyBodyIfNeeded(dateKey) {
    const parentRef = parentDocRef(dateKey);
    const parentSnap = await getDoc(parentRef);
    if (!parentSnap.exists()) return;

    const data = parentSnap.data();
    const legacyBody = typeof data.body === 'string' ? data.body : '';
    const entriesSnap = await getDocs(query(entriesCol(dateKey), orderBy('createdAt', 'asc')));

    if (!entriesSnap.empty) {
        if (legacyBody.length > 0) {
            await setDoc(parentRef, { body: deleteField() }, { merge: true });
        }
        return;
    }

    if (legacyBody.length > 0) {
        await addDoc(entriesCol(dateKey), {
            body: legacyBody,
            title: '',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        await setDoc(parentRef, { body: deleteField() }, { merge: true });
    }
}

async function ensureParentStub(dateKey) {
    await setDoc(parentDocRef(dateKey), { updatedAt: serverTimestamp() }, { merge: true });
}

function fillViewElement(viewEl, body) {
    viewEl.className = VIEW_CONTENT_CLASS;
    viewEl.removeAttribute('style');
    if (bodyIsEffectivelyEmpty(body)) {
        viewEl.textContent = '(내용 없음)';
        viewEl.classList.add('text-slate-400', 'italic');
        return;
    }
    viewEl.classList.remove('text-slate-400', 'italic');
    if (looksLikeHtml(body)) {
        viewEl.innerHTML = sanitizeAdminLogHtml(body);
    } else {
        viewEl.textContent = body;
        viewEl.style.whiteSpace = 'pre-wrap';
    }
}

function fillEditorElement(editorEl, body) {
    editorEl.innerHTML = '';
    if (bodyIsEffectivelyEmpty(body)) {
        editorEl.innerHTML = '<br>';
        return;
    }
    if (looksLikeHtml(body)) {
        editorEl.innerHTML = sanitizeAdminLogHtml(body);
    } else {
        editorEl.textContent = body;
    }
}

function setEntryMode(wrap, mode) {
    const view = wrap.querySelector('.admin-log-entry-view');
    const editor = wrap.querySelector('.admin-log-entry-editor');
    const titleView = wrap.querySelector('.admin-log-entry-title-view');
    const titleInput = wrap.querySelector('.admin-log-entry-title-input');
    const isView = mode === 'view';
    if (view) view.classList.toggle('hidden', !isView);
    if (editor) editor.classList.toggle('hidden', isView);
    const savedTitle = normalizeTitle(wrap.dataset.savedTitle || '');
    if (titleView) {
        titleView.classList.toggle('hidden', !isView || savedTitle.length === 0);
        if (isView && savedTitle.length > 0) titleView.textContent = savedTitle;
    }
    if (titleInput) titleInput.classList.toggle('hidden', isView);
}

function enterEditMode(wrap) {
    const body = wrap.dataset.savedBody || '';
    const editor = wrap.querySelector('.admin-log-entry-editor');
    const titleInput = wrap.querySelector('.admin-log-entry-title-input');
    if (titleInput) titleInput.value = wrap.dataset.savedTitle || '';
    if (editor) {
        fillEditorElement(editor, body);
        editor.focus();
    }
    setEntryMode(wrap, 'edit');
    syncAdminLogHeader();
}

function cancelEditMode(wrap) {
    const body = wrap.dataset.savedBody || '';
    const titleInput = wrap.querySelector('.admin-log-entry-title-input');
    if (titleInput) titleInput.value = wrap.dataset.savedTitle || '';
    fillEditorElement(wrap.querySelector('.admin-log-entry-editor'), body);
    const view = wrap.querySelector('.admin-log-entry-view');
    if (view) fillViewElement(view, body);
    setEntryMode(wrap, 'view');
    syncAdminLogHeader();
}

/**
 * @param {{ id: string, body: string, title?: string, createdAtMs?: number | null }} entry
 */
function buildEntryWrap(entry) {
    const wrap = document.createElement('div');
    wrap.className = 'admin-log-entry border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50';
    wrap.dataset.entryId = entry.id;
    wrap.dataset.savedBody = entry.body || '';
    wrap.dataset.savedTitle = normalizeTitle(entry.title);

    const titleView = document.createElement('div');
    titleView.className =
        'admin-log-entry-title-view text-sm font-bold text-slate-800 leading-snug break-words';
    const savedTitle = normalizeTitle(entry.title);
    if (savedTitle.length > 0) titleView.textContent = savedTitle;

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className =
        'admin-log-entry-title-input w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 outline-none focus:border-emerald-500 bg-white';
    titleInput.setAttribute('maxlength', String(MAX_TITLE));
    titleInput.setAttribute('placeholder', '제목 (선택)');
    titleInput.value = savedTitle;

    const view = document.createElement('div');
    fillViewElement(view, entry.body || '');

    const editor = document.createElement('div');
    editor.className = EDITOR_CLASS;
    editor.contentEditable = 'true';
    editor.setAttribute('spellcheck', 'true');
    fillEditorElement(editor, entry.body || '');

    wrap.append(titleView, titleInput, view, editor);

    const hasSaved = !bodyIsEffectivelyEmpty(entry.body);
    if (hasSaved) {
        setEntryMode(wrap, 'view');
    } else {
        setEntryMode(wrap, 'edit');
        editor.focus();
    }

    return wrap;
}

function renderActiveEntryPanel() {
    const { entriesContainer } = getEls();
    if (!entriesContainer || !selectedDateKey || !selectedEntryId) return;
    entriesContainer.innerHTML = '';
    const list = entriesCache[selectedDateKey] || [];
    const entry = list.find((e) => e.id === selectedEntryId);
    if (!entry) {
        entriesContainer.innerHTML =
            '<p class="text-sm text-slate-400 py-4 text-center">항목을 찾을 수 없습니다.</p>';
        syncAdminLogHeader();
        return;
    }
    entriesContainer.appendChild(buildEntryWrap(entry));
    syncAdminLogHeader();
}

/** @param {string} dateKey */
async function refreshEntriesForDate(dateKey) {
    if (!DATE_KEY_RE.test(dateKey)) return;
    await migrateLegacyBodyIfNeeded(dateKey);
    const q = query(entriesCol(dateKey), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    entriesCache[dateKey] = snap.docs.map((d) => {
        const x = d.data();
        const createdMs = tsToMs(x.createdAt);
        return {
            id: d.id,
            body: typeof x.body === 'string' ? x.body : '',
            title: normalizeTitle(typeof x.title === 'string' ? x.title : ''),
            createdAtMs: createdMs
        };
    });
}

async function refreshAllEntriesCache() {
    entriesCache = {};
    await Promise.all(cachedDateKeys.map((k) => refreshEntriesForDate(k)));
}

async function selectEntry(dateKey, entryId) {
    if (!DATE_KEY_RE.test(dateKey) || !entryId) return;
    if (!entriesCache[dateKey]) await refreshEntriesForDate(dateKey);
    selectedDateKey = dateKey;
    selectedEntryId = entryId;
    renderSidebarList();
    updateEditorChrome();
    renderActiveEntryPanel();
}

/** 해당 날짜의 가장 최근 블록 선택(createdAt asc 기준 마지막) */
async function selectDate(dateKey) {
    if (!DATE_KEY_RE.test(dateKey)) return;
    selectedDateKey = dateKey;
    if (!entriesCache[dateKey]) await refreshEntriesForDate(dateKey);
    const list = entriesCache[dateKey] || [];
    if (list.length > 0) {
        selectedEntryId = list[list.length - 1].id;
        renderSidebarList();
        updateEditorChrome();
        renderActiveEntryPanel();
    } else {
        selectedEntryId = null;
        const { entriesContainer } = getEls();
        if (entriesContainer) entriesContainer.innerHTML = '';
        renderSidebarList();
        updateEditorChrome();
    }
}

async function selectPreferredEntryOnLoad() {
    const flat = getAllEntriesFlat();
    const today = getTodayDateString();
    const todayRows = flat.filter((r) => r.dateKey === today);
    const pick = todayRows[0] || flat[0];
    if (pick) await selectEntry(pick.dateKey, pick.id);
}

async function refreshDateKeysFromServer() {
    const snap = await getDocs(adminLogsCol());
    const keys = snap.docs.map((d) => d.id);
    cachedDateKeys = sortDateKeysDesc(keys);
}

function mergeTodayIfNeeded(todayKey) {
    if (!cachedDateKeys.includes(todayKey)) {
        cachedDateKeys = sortDateKeysDesc([...cachedDateKeys, todayKey]);
    }
}

async function createEmptyEntry(dateKey) {
    await ensureParentStub(dateKey);
    await addDoc(entriesCol(dateKey), {
        body: '',
        title: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
    await setDoc(parentDocRef(dateKey), { updatedAt: serverTimestamp() }, { merge: true });
}

function bindListenersOnce() {
    if (listenersBound) return;
    listenersBound = true;
    const { list, addBtn } = getEls();
    if (list) {
        list.addEventListener('click', (e) => {
            const blockBtn = e.target.closest('.admin-log-block-item');
            if (blockBtn && list.contains(blockBtn)) {
                const key = blockBtn.getAttribute('data-date-key');
                const eid = blockBtn.getAttribute('data-entry-id');
                if (key && eid) selectEntry(key, eid);
            }
        });
    }
    if (addBtn) {
        addBtn.addEventListener('click', () => addTodayAdminLog());
    }

    document.getElementById('adminLogHdrEditBtn')?.addEventListener('click', () => {
        const w = getEntryWrap();
        if (w) enterEditMode(w);
    });
    document.getElementById('adminLogHdrDeleteBtn')?.addEventListener('click', () => {
        if (selectedEntryId) deleteAdminLogEntry(selectedEntryId);
    });
    document.getElementById('adminLogHdrSaveBtn')?.addEventListener('click', () => {
        const w = getEntryWrap();
        if (w && selectedEntryId) saveAdminLogEntry(selectedEntryId, w);
    });
    document.getElementById('adminLogHdrCancelBtn')?.addEventListener('click', () => {
        const w = getEntryWrap();
        if (w) cancelEditMode(w);
    });
    document.getElementById('adminLogHdrDeleteEditBtn')?.addEventListener('click', () => {
        if (selectedEntryId) deleteAdminLogEntry(selectedEntryId);
    });
}

export async function addTodayAdminLog() {
    const targetKey = selectedDateKey || getTodayDateString();
    try {
        await createEmptyEntry(targetKey);
        await refreshDateKeysFromServer();
        mergeTodayIfNeeded(targetKey);
        await refreshEntriesForDate(targetKey);
        renderSidebarList();
        const list = entriesCache[targetKey] || [];
        const last = list[list.length - 1];
        if (last) await selectEntry(targetKey, last.id);
        else await selectDate(targetKey);
        showAdminLogToast('블록을 추가했습니다.');
    } catch (e) {
        console.error('관리 로그 추가 실패:', e);
        showAdminLogToast('추가에 실패했습니다.', 'error');
    }
}

/**
 * @param {string} entryId
 * @param {HTMLElement} wrap
 */
async function saveAdminLogEntry(entryId, wrap) {
    if (!selectedDateKey || !entryId || !wrap) return;
    const editor = wrap.querySelector('.admin-log-entry-editor');
    const view = wrap.querySelector('.admin-log-entry-view');
    const titleInput = wrap.querySelector('.admin-log-entry-title-input');
    const titleView = wrap.querySelector('.admin-log-entry-title-view');
    if (!editor) return;

    const title = normalizeTitle(titleInput?.value);

    let html = sanitizeAdminLogHtml(editor.innerHTML);
    if (bodyIsEffectivelyEmpty(html)) {
        html = '';
    }
    if (html.length > MAX_BODY) {
        showAdminLogToast('본문이 너무 깁니다. 일부를 줄여 주세요.', 'error');
        return;
    }

    const saveBtn = document.getElementById('adminLogHdrSaveBtn');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '저장 중…';
    }
    try {
        const ref = doc(db, 'artifacts', appId, 'adminLogs', selectedDateKey, 'entries', entryId);
        await updateDoc(ref, { body: html, title, updatedAt: serverTimestamp() });
        await setDoc(parentDocRef(selectedDateKey), { updatedAt: serverTimestamp() }, { merge: true });
        wrap.dataset.savedBody = html;
        wrap.dataset.savedTitle = title;
        const cached = (entriesCache[selectedDateKey] || []).find((e) => e.id === entryId);
        if (cached) {
            cached.body = html;
            cached.title = title;
        }
        if (titleView) {
            titleView.textContent = title;
        }
        if (view) fillViewElement(view, html);
        setEntryMode(wrap, 'view');
        renderSidebarList();
        showAdminLogToast('저장했습니다.');
    } catch (e) {
        console.error('관리 로그 저장 실패:', e);
        showAdminLogToast('저장에 실패했습니다.', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '저장';
        }
        syncAdminLogHeader();
    }
}

async function deleteAdminLogEntry(entryId) {
    if (!selectedDateKey || !entryId) return;
    if (!confirm('이 블록을 삭제할까요?')) return;
    try {
        const dateKey = selectedDateKey;
        const listBefore = [...(entriesCache[dateKey] || [])];
        const delIdx = listBefore.findIndex((e) => e.id === entryId);

        await deleteDoc(doc(db, 'artifacts', appId, 'adminLogs', dateKey, 'entries', entryId));
        const left = await getDocs(query(entriesCol(dateKey), orderBy('createdAt', 'asc')));
        if (left.empty) {
            await deleteDoc(parentDocRef(dateKey));
            await refreshDateKeysFromServer();
            delete entriesCache[dateKey];
            selectedDateKey = null;
            selectedEntryId = null;
            renderSidebarList();
            const { entriesContainer } = getEls();
            if (entriesContainer) entriesContainer.innerHTML = '';
            updateEditorChrome();
            if (cachedDateKeys.length > 0) {
                await refreshAllEntriesCache();
                renderSidebarList();
                await selectDate(cachedDateKeys[0]);
            }
        } else {
            await refreshEntriesForDate(dateKey);
            const newList = entriesCache[dateKey] || [];
            if (newList.length === 0) {
                selectedEntryId = null;
            } else {
                const nextIdx = Math.min(delIdx, newList.length - 1);
                selectedEntryId = newList[Math.max(0, nextIdx)].id;
            }
            renderSidebarList();
            updateEditorChrome();
            renderActiveEntryPanel();
            await setDoc(parentDocRef(dateKey), { updatedAt: serverTimestamp() }, { merge: true });
        }
        showAdminLogToast('삭제했습니다.');
    } catch (e) {
        console.error('관리 로그 삭제 실패:', e);
        showAdminLogToast('삭제에 실패했습니다.', 'error');
    }
}

/** 관리 로그 탭 진입 시 호출 */
export async function loadAdminLogTab() {
    bindListenersOnce();
    const { list, entriesContainer, entriesWrap } = getEls();
    if (!list || !entriesContainer) return;
    list.innerHTML =
        '<p class="text-xs text-slate-500 px-2 py-4 text-center"><i class="fa-solid fa-spinner fa-spin mr-2"></i>불러오는 중…</p>';
    if (entriesWrap) entriesWrap.classList.add('hidden');
    try {
        await refreshDateKeysFromServer();
        await refreshAllEntriesCache();
        if (cachedDateKeys.length === 0) {
            selectedDateKey = null;
            selectedEntryId = null;
            entriesContainer.innerHTML = '';
            renderSidebarList();
            updateEditorChrome();
            return;
        }
        await selectPreferredEntryOnLoad();
    } catch (e) {
        console.error('관리 로그 목록 실패:', e);
        list.innerHTML =
            '<p class="text-xs text-red-600 px-2 py-3 text-center">목록을 불러오지 못했습니다.</p>';
        showAdminLogToast('목록 로드에 실패했습니다.', 'error');
    }
}
