/**
 * 관리 로그 — 날짜별(로컬 YYYY-MM-DD) 다중 블록
 * 경로: artifacts/{appId}/adminLogs/{dateKey}/entries/{entryId}
 * 본문: HTML 저장(붙여넣기 서식 일부 유지), 저장 시 stripDangerousTagsOnly 정제
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

function formatDateKeyLabel(dateKey) {
    const parts = dateKey.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return dateKey;
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short'
    });
}

/** 텍스트가 비었는지(태그만 있는 경우 포함) */
function bodyIsEffectivelyEmpty(body) {
    if (body == null || body === '') return true;
    const d = document.createElement('div');
    d.innerHTML = body;
    return (d.textContent || '').trim().length === 0;
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

function getEls() {
    return {
        list: document.getElementById('adminLogDateList'),
        entriesWrap: document.getElementById('adminLogEntriesWrap'),
        entriesContainer: document.getElementById('adminLogEntriesContainer'),
        addBtn: document.getElementById('adminLogAddBtn'),
        addBlockBtn: document.getElementById('adminLogAddBlockBtn'),
        selectedLabel: document.getElementById('adminLogSelectedDateLabel'),
        emptyHint: document.getElementById('adminLogEmptyHint')
    };
}

function renderDateList() {
    const { list } = getEls();
    if (!list) return;
    const keys = sortDateKeysDesc(cachedDateKeys);
    if (keys.length === 0) {
        list.innerHTML =
            '<p class="text-xs text-slate-400 px-2 py-3 text-center">저장된 로그가 없습니다.<br>「추가」로 오늘 블록을 만들 수 있습니다.</p>';
        return;
    }
    list.innerHTML = keys
        .map((key) => {
            const active = key === selectedDateKey;
            const cls = active
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50';
            return `<button type="button" class="admin-log-date-item w-full text-left px-3 py-2.5 rounded-xl border text-sm font-bold transition-colors ${cls}" data-date-key="${key}">
                <span class="block text-[11px] font-mono text-slate-400 mb-0.5">${key}</span>
                <span class="block leading-tight">${formatDateKeyLabel(key)}</span>
            </button>`;
        })
        .join('');
}

function updateEditorChrome() {
    const { selectedLabel, emptyHint, entriesWrap, addBlockBtn } = getEls();
    const hasSelection = !!selectedDateKey;
    if (selectedLabel) {
        selectedLabel.textContent = hasSelection
            ? `${selectedDateKey} · ${formatDateKeyLabel(selectedDateKey)}`
            : '날짜를 선택하세요';
    }
    if (emptyHint) emptyHint.classList.toggle('hidden', hasSelection);
    if (entriesWrap) entriesWrap.classList.toggle('hidden', !hasSelection);
    if (addBlockBtn) addBlockBtn.disabled = !hasSelection;
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
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });
        await setDoc(parentRef, { body: deleteField() }, { merge: true });
    }
}

async function ensureParentStub(dateKey) {
    await setDoc(parentDocRef(dateKey), { updatedAt: serverTimestamp() }, { merge: true });
}

/**
 * @param {HTMLElement} viewEl
 * @param {string} body
 */
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

/**
 * 편집 영역에 저장본 반영(붙여넣기용 contenteditable)
 * @param {HTMLElement} editorEl
 * @param {string} body
 */
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

/**
 * @param {HTMLElement} wrap
 * @param {'view'|'edit'} mode
 */
function setEntryMode(wrap, mode) {
    const view = wrap.querySelector('.admin-log-entry-view');
    const editor = wrap.querySelector('.admin-log-entry-editor');
    const actionsView = wrap.querySelector('.admin-log-entry-actions-view');
    const actionsEdit = wrap.querySelector('.admin-log-entry-actions-edit');
    const isView = mode === 'view';
    if (view) view.classList.toggle('hidden', !isView);
    if (editor) editor.classList.toggle('hidden', isView);
    if (actionsView) actionsView.classList.toggle('hidden', !isView);
    if (actionsEdit) actionsEdit.classList.toggle('hidden', isView);
}

function enterEditMode(wrap) {
    const body = wrap.dataset.savedBody || '';
    const editor = wrap.querySelector('.admin-log-entry-editor');
    if (editor) {
        fillEditorElement(editor, body);
        editor.focus();
    }
    setEntryMode(wrap, 'edit');
}

function cancelEditMode(wrap) {
    const body = wrap.dataset.savedBody || '';
    fillEditorElement(wrap.querySelector('.admin-log-entry-editor'), body);
    const view = wrap.querySelector('.admin-log-entry-view');
    if (view) fillViewElement(view, body);
    setEntryMode(wrap, 'view');
}

/**
 * @param {{ id: string, body: string }[]} entries
 */
function renderEntryBlocks(entries) {
    const { entriesContainer } = getEls();
    if (!entriesContainer) return;
    entriesContainer.innerHTML = '';

    if (entries.length === 0) {
        const p = document.createElement('p');
        p.className = 'text-sm text-slate-400 py-4 text-center';
        p.textContent = '이 날짜에 블록이 없습니다. 「블록 추가」로 붙여 넣을 영역을 만드세요.';
        entriesContainer.appendChild(p);
        return;
    }

    entries.forEach((e, i) => {
        const wrap = document.createElement('div');
        wrap.className =
            'admin-log-entry border border-slate-200 rounded-xl p-4 space-y-3 bg-slate-50/50';
        wrap.dataset.entryId = e.id;
        wrap.dataset.savedBody = e.body || '';

        const head = document.createElement('div');
        head.className = 'flex flex-wrap items-center justify-between gap-2';
        const title = document.createElement('span');
        title.className = 'text-xs font-bold text-slate-500';
        title.textContent = `블록 ${i + 1}`;

        const actionsView = document.createElement('div');
        actionsView.className = 'admin-log-entry-actions-view flex gap-2';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.dataset.action = 'edit';
        editBtn.className =
            'px-3 py-1.5 bg-slate-700 text-white rounded-lg text-xs font-bold hover:bg-slate-800';
        editBtn.textContent = '수정';
        const delBtnView = document.createElement('button');
        delBtnView.type = 'button';
        delBtnView.dataset.action = 'delete';
        delBtnView.className =
            'px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-red-50 hover:border-red-200 hover:text-red-600';
        delBtnView.textContent = '삭제';
        actionsView.append(editBtn, delBtnView);

        const actionsEdit = document.createElement('div');
        actionsEdit.className = 'admin-log-entry-actions-edit flex gap-2 hidden';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.dataset.action = 'save';
        saveBtn.className =
            'px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-bold hover:bg-emerald-700';
        saveBtn.textContent = '저장';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.dataset.action = 'cancel';
        cancelBtn.className =
            'px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-50';
        cancelBtn.textContent = '취소';
        const delBtnEdit = document.createElement('button');
        delBtnEdit.type = 'button';
        delBtnEdit.dataset.action = 'delete';
        delBtnEdit.className =
            'px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-bold hover:bg-red-50 hover:border-red-200 hover:text-red-600';
        delBtnEdit.textContent = '삭제';
        actionsEdit.append(saveBtn, cancelBtn, delBtnEdit);

        head.append(title, actionsView, actionsEdit);

        const view = document.createElement('div');
        fillViewElement(view, e.body || '');

        const editor = document.createElement('div');
        editor.className = EDITOR_CLASS;
        editor.contentEditable = 'true';
        editor.setAttribute('spellcheck', 'true');
        fillEditorElement(editor, e.body || '');

        wrap.append(head, view, editor);

        const hasSaved = !bodyIsEffectivelyEmpty(e.body);
        if (hasSaved) {
            setEntryMode(wrap, 'view');
        } else {
            setEntryMode(wrap, 'edit');
            editor.focus();
        }

        entriesContainer.appendChild(wrap);
    });
}

async function loadEntriesForDate(dateKey) {
    const { entriesContainer } = getEls();
    if (!entriesContainer || !dateKey) return;
    entriesContainer.innerHTML =
        '<p class="text-xs text-slate-500 py-6 text-center"><i class="fa-solid fa-spinner fa-spin mr-2"></i>불러오는 중…</p>';
    try {
        await migrateLegacyBodyIfNeeded(dateKey);
        const q = query(entriesCol(dateKey), orderBy('createdAt', 'asc'));
        const snap = await getDocs(q);
        const entries = snap.docs.map((d) => {
            const x = d.data();
            return { id: d.id, body: typeof x.body === 'string' ? x.body : '' };
        });
        renderEntryBlocks(entries);
    } catch (e) {
        console.error('관리 로그 블록 로드 실패:', e);
        entriesContainer.innerHTML = '';
        showAdminLogToast('불러오기에 실패했습니다.', 'error');
    }
}

async function selectDate(dateKey) {
    if (!DATE_KEY_RE.test(dateKey)) return;
    selectedDateKey = dateKey;
    renderDateList();
    updateEditorChrome();
    await loadEntriesForDate(dateKey);
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
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    });
    await setDoc(parentDocRef(dateKey), { updatedAt: serverTimestamp() }, { merge: true });
}

function bindListenersOnce() {
    if (listenersBound) return;
    listenersBound = true;
    const { list, addBtn, addBlockBtn, entriesContainer } = getEls();
    if (list) {
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-log-date-item');
            if (!btn || !list.contains(btn)) return;
            const key = btn.getAttribute('data-date-key');
            if (key) selectDate(key);
        });
    }
    if (addBtn) {
        addBtn.addEventListener('click', () => addTodayAdminLog());
    }
    if (addBlockBtn) {
        addBlockBtn.addEventListener('click', () => addBlockToSelectedDate());
    }
    if (entriesContainer) {
        entriesContainer.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !entriesContainer.contains(btn)) return;
            const wrap = btn.closest('.admin-log-entry');
            const entryId = wrap?.dataset?.entryId;
            if (!entryId || !selectedDateKey) return;
            const action = btn.dataset.action;
            if (action === 'edit') enterEditMode(wrap);
            else if (action === 'cancel') cancelEditMode(wrap);
            else if (action === 'save') saveAdminLogEntry(entryId, wrap);
            else if (action === 'delete') deleteAdminLogEntry(entryId);
        });
    }
}

export async function addBlockToSelectedDate() {
    if (!selectedDateKey) {
        showAdminLogToast('먼저 날짜를 선택하세요.', 'error');
        return;
    }
    const dateKey = selectedDateKey;
    try {
        await createEmptyEntry(dateKey);
        await refreshDateKeysFromServer();
        mergeTodayIfNeeded(dateKey);
        renderDateList();
        await loadEntriesForDate(dateKey);
        showAdminLogToast('블록을 추가했습니다.');
    } catch (e) {
        console.error('블록 추가 실패:', e);
        showAdminLogToast('블록 추가에 실패했습니다.', 'error');
    }
}

export async function addTodayAdminLog() {
    const today = getTodayDateString();
    try {
        await createEmptyEntry(today);
        await refreshDateKeysFromServer();
        mergeTodayIfNeeded(today);
        renderDateList();
        await selectDate(today);
        showAdminLogToast('오늘 날짜에 블록을 추가했습니다.');
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
    if (!editor) return;

    let html = sanitizeAdminLogHtml(editor.innerHTML);
    if (bodyIsEffectivelyEmpty(html)) {
        html = '';
    }
    if (html.length > MAX_BODY) {
        showAdminLogToast('본문이 너무 깁니다. 일부를 줄여 주세요.', 'error');
        return;
    }

    const saveBtn = wrap.querySelector('.admin-log-entry-actions-edit [data-action="save"]');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '저장 중…';
    }
    try {
        const ref = doc(db, 'artifacts', appId, 'adminLogs', selectedDateKey, 'entries', entryId);
        await updateDoc(ref, { body: html, updatedAt: serverTimestamp() });
        await setDoc(parentDocRef(selectedDateKey), { updatedAt: serverTimestamp() }, { merge: true });
        wrap.dataset.savedBody = html;
        if (view) fillViewElement(view, html);
        setEntryMode(wrap, 'view');
        showAdminLogToast('저장했습니다.');
    } catch (e) {
        console.error('관리 로그 저장 실패:', e);
        showAdminLogToast('저장에 실패했습니다.', 'error');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '저장';
        }
    }
}

async function deleteAdminLogEntry(entryId) {
    if (!selectedDateKey || !entryId) return;
    if (!confirm('이 블록을 삭제할까요?')) return;
    try {
        await deleteDoc(doc(db, 'artifacts', appId, 'adminLogs', selectedDateKey, 'entries', entryId));
        const left = await getDocs(query(entriesCol(selectedDateKey), orderBy('createdAt', 'asc')));
        if (left.empty) {
            await deleteDoc(parentDocRef(selectedDateKey));
            await refreshDateKeysFromServer();
            selectedDateKey = null;
            renderDateList();
            const { entriesContainer } = getEls();
            if (entriesContainer) entriesContainer.innerHTML = '';
            updateEditorChrome();
            if (cachedDateKeys.length > 0) {
                await selectDate(cachedDateKeys[0]);
            }
        } else {
            await loadEntriesForDate(selectedDateKey);
            await setDoc(parentDocRef(selectedDateKey), { updatedAt: serverTimestamp() }, { merge: true });
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
        if (cachedDateKeys.length === 0) {
            selectedDateKey = null;
            entriesContainer.innerHTML = '';
            renderDateList();
            updateEditorChrome();
            return;
        }
        const preferred = cachedDateKeys.includes(getTodayDateString())
            ? getTodayDateString()
            : cachedDateKeys[0];
        await selectDate(preferred);
    } catch (e) {
        console.error('관리 로그 목록 실패:', e);
        list.innerHTML =
            '<p class="text-xs text-red-600 px-2 py-3 text-center">목록을 불러오지 못했습니다.</p>';
        showAdminLogToast('목록 로드에 실패했습니다.', 'error');
    }
}
