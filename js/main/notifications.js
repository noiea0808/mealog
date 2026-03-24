/**
 * 댓글 알림: 읽음 상태(Firestore), 팝업 목록, 빨간 점, 실시간 onSnapshot 리스너
 */
import { appState } from '../state.js';
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { postInteractions, subscribeToMyPostComments, boardOperations } from '../db.js';
import { escapeHtml, renderGallery } from '../render/index.js';

const NOTIFICATION_LAST_OPENED_KEY = 'mealog_notification_last_opened';
const NOTIFICATION_READ_POST_IDS_KEY = 'mealog_notification_read_post_ids';
const NOTIFICATION_READ_FIRESTORE_DOC = 'notificationRead';

/** 메모리 캐시( Firestore와 동기화 ). null이면 아직 로드 전 */
let notificationReadStateCache = null;
/** 캐시가 어떤 사용자 것인지 (사용자 전환 시 캐시 무효화) */
let notificationReadStateCacheUid = null;

/** localStorage 파싱만 (마이그레이션용). 반환: { "type:postId": { lastCommentAt, commentCount } } */
function parseLocalNotificationReadState() {
    try {
        const raw = localStorage.getItem(NOTIFICATION_READ_POST_IDS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            const obj = {};
            parsed.forEach(key => { obj[key] = { lastCommentAt: Infinity, commentCount: Infinity }; });
            return obj;
        }
        if (parsed && typeof parsed === 'object') return parsed;
        return {};
    } catch (_) { return {}; }
}

/** Firestore에서 알림 읽음 상태 로드 후 캐시에 반영. 기존 localStorage 있으면 병합 후 Firestore에 저장하고 localStorage 삭제 */
async function ensureNotificationReadStateLoaded() {
    const user = window.currentUser;
    if (user && !user.isAnonymous && notificationReadStateCacheUid !== user.uid) {
        notificationReadStateCache = null;
        notificationReadStateCacheUid = null;
    }
    if (notificationReadStateCache !== null) return;
    if (!user || user.isAnonymous) {
        notificationReadStateCache = {};
        notificationReadStateCacheUid = null;
        return;
    }
    try {
        const ref = doc(db, 'artifacts', appId, 'users', user.uid, 'config', NOTIFICATION_READ_FIRESTORE_DOC);
        const snap = await getDoc(ref);
        let state = {};
        if (snap.exists() && snap.data().data) {
            try {
                state = typeof snap.data().data === 'string' ? JSON.parse(snap.data().data) : { ...snap.data().data };
            } catch (_) {}
        }
        const local = parseLocalNotificationReadState();
        if (Object.keys(local).length > 0) {
            state = { ...state, ...local };
            await setDoc(ref, { data: JSON.stringify(state) }, { merge: true });
            try { localStorage.removeItem(NOTIFICATION_READ_POST_IDS_KEY); } catch (_) {}
        }
        if (Array.isArray(state)) {
            const obj = {};
            state.forEach(key => { obj[key] = { lastCommentAt: Infinity, commentCount: Infinity }; });
            state = obj;
        }
        notificationReadStateCache = state && typeof state === 'object' ? state : {};
        notificationReadStateCacheUid = user.uid;
    } catch (e) {
        console.warn('알림 읽음 상태 Firestore 로드 실패:', e);
        notificationReadStateCache = parseLocalNotificationReadState();
        notificationReadStateCacheUid = user.uid;
    }
}

/** 로그아웃 등 사용자 전환 시 알림 읽음 캐시 초기화 (auth에서 호출) */
window.clearNotificationReadStateCache = () => {
    notificationReadStateCache = null;
    notificationReadStateCacheUid = null;
};

/** 읽음 상태: { "type:postId": { lastCommentAt, commentCount } }. 캐시가 없으면 빈 객체(ensureNotificationReadStateLoaded 호출 후 사용) */
function getNotificationReadState() {
    if (notificationReadStateCache === null) return {};
    return notificationReadStateCache;
}

/** 읽음 상태 저장: 메모리 캐시 + Firestore (필드명 제한으로 data는 JSON 문자열로 저장) */
async function setNotificationReadState(state) {
    notificationReadStateCache = state;
    const user = window.currentUser;
    if (!user || user.isAnonymous) return;
    try {
        const ref = doc(db, 'artifacts', appId, 'users', user.uid, 'config', NOTIFICATION_READ_FIRESTORE_DOC);
        await setDoc(ref, { data: JSON.stringify(state) }, { merge: true });
    } catch (e) {
        console.warn('알림 읽음 상태 Firestore 저장 실패:', e);
    }
}

window.toggleNotificationPopup = () => {
    const popup = document.getElementById('notificationPopup');
    if (!popup) return;
    const isOpen = !popup.classList.contains('hidden');
    if (isOpen) {
        window.closeNotificationPopup();
        return;
    }
    popup.classList.remove('hidden');
    try { localStorage.setItem(NOTIFICATION_LAST_OPENED_KEY, String(Date.now())); } catch (_) {}
    if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
    window.loadNotificationList();
};

window.closeNotificationPopup = () => {
    const popup = document.getElementById('notificationPopup');
    if (popup) popup.classList.add('hidden');
};

function getNotificationReadPostIds() {
    const state = getNotificationReadState();
    return new Set(Object.keys(state));
}

function markNotificationAsRead(notificationKey, lastCommentAt, commentCount) {
    const state = getNotificationReadState();
    state[notificationKey] = { lastCommentAt: lastCommentAt ?? 0, commentCount: commentCount ?? 0 };
    setNotificationReadState(state);
}

/** 같은 글에 새 댓글이 달리면( lastCommentAt이 커지면) 미확인으로 표시 */
function isNotificationRead(item, readState) {
    const key = `${item.type}:${item.postId}`;
    const legacyKey = item.type === 'moment' ? item.postId : null;
    const stored = readState[key] || (legacyKey ? readState[legacyKey] : null);
    if (!stored) return false;
    const lastAt = Number(stored.lastCommentAt);
    const count = Number(stored.commentCount);
    if (Number.isNaN(lastAt)) return false;
    if (item.lastCommentAt > lastAt) return false;
    if (!Number.isNaN(count) && item.commentCount > count) return false;
    return true;
}

window.loadNotificationList = async () => {
    const listEl = document.getElementById('notificationList');
    const emptyEl = document.getElementById('notificationEmpty');
    if (!listEl || !emptyEl) return;
    listEl.innerHTML = '<div class="p-4 text-center text-slate-400 text-sm">불러오는 중...</div>';
    emptyEl.classList.add('hidden');
    if (!window.currentUser || window.currentUser.isAnonymous || !window.postInteractions) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
        return;
    }
    try {
        await ensureNotificationReadStateLoaded();
        const [momentItems, boardItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([])
        ]);
        const merged = [...momentItems, ...boardItems].sort((a, b) => b.lastCommentAt - a.lastCommentAt);
        const readState = getNotificationReadState();
        const unread = merged.filter(item => !isNotificationRead(item, readState));
        listEl.innerHTML = '';
        const markAllReadBtn = document.getElementById('notificationMarkAllReadBtn');
        if (markAllReadBtn) {
            if (unread.length === 0) {
                markAllReadBtn.classList.add('invisible');
                markAllReadBtn.onclick = null;
            } else {
                markAllReadBtn.classList.remove('invisible');
                markAllReadBtn.onclick = () => {
                    const state = getNotificationReadState();
                    unread.forEach(item => {
                        const key = `${item.type}:${item.postId}`;
                        state[key] = { lastCommentAt: item.lastCommentAt, commentCount: item.commentCount };
                    });
                    setNotificationReadState(state);
                    window.loadNotificationList();
                    window.updateNotificationDot();
                };
            }
        }
        if (unread.length === 0) {
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = '새로운 댓글이 없습니다.';
            return;
        }
        emptyEl.classList.add('hidden');
        unread.forEach((item) => {
            const { postId, type, lastCommentAt, commentCount, thumbnailUrl, title, momentLabel } = item;
            const notificationKey = `${type}:${postId}`;
            const d = new Date(lastCommentAt);
            const timeStr = d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-50 active:bg-slate-100 transition-colors border-b border-slate-50 last:border-0 flex items-center gap-3';
            const label = type === 'board' ? (title ? escapeHtml(title) : '해당 게시물') : (momentLabel ? escapeHtml(momentLabel) : '해당 게시물');
            const thumbHtml = type === 'moment' && thumbnailUrl
                ? `<div class="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-slate-100 border border-slate-200"><img src="${escapeHtml(thumbnailUrl)}" alt="" class="w-full h-full object-cover" loading="lazy"></div>`
                : '';
            row.innerHTML = `${thumbHtml}<div class="flex-1 min-w-0"><span class="text-slate-700 text-sm font-medium block truncate">${label}</span><span class="text-slate-500 text-xs">댓글 ${commentCount}개 · ${timeStr}</span></div>`;
            row.addEventListener('click', () => {
                markNotificationAsRead(notificationKey, lastCommentAt, commentCount);
                window.closeNotificationPopup();
                if (type === 'board') {
                    if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
                    if (typeof window.openBoardDetail === 'function') window.openBoardDetail(postId);
                } else {
                    window.navigateToNotificationPost(postId);
                }
                window.updateNotificationDot();
            });
            listEl.appendChild(row);
        });
    } catch (e) {
        console.error('알림 목록 로드 실패:', e);
        listEl.innerHTML = '';
        emptyEl.textContent = '목록을 불러올 수 없습니다.';
        emptyEl.classList.remove('hidden');
    }
};

window.updateNotificationDot = async () => {
    const dotEl = document.getElementById('notificationDot');
    if (!dotEl) return;
    if (!window.currentUser || window.currentUser.isAnonymous || !window.postInteractions) {
        dotEl.classList.add('hidden');
        return;
    }
    try {
        await ensureNotificationReadStateLoaded();
        const [momentItems, boardItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([])
        ]);
        const merged = [...momentItems, ...boardItems];
        const readState = getNotificationReadState();
        const unread = merged.filter(item => !isNotificationRead(item, readState));
        if (unread.length > 0) dotEl.classList.remove('hidden'); else dotEl.classList.add('hidden');
        appState.notificationUnreadCount = unread.length;
        if (typeof window.updateAppBadge === 'function') window.updateAppBadge();
    } catch (_) {
        dotEl.classList.add('hidden');
        appState.notificationUnreadCount = 0;
        if (typeof window.updateAppBadge === 'function') window.updateAppBadge();
    }
};

/**
 * 앱 아이콘 숫자 배지 (Capacitor Badge) — 런처 아이콘의 「숫자」만 다룸.
 * - 미읽음 댓글/밀톡 알림 집계(notificationUnreadCount)가 있을 때만 숫자 표시.
 * - Android: 상단 알림·알림 목록은 OS가 표시(점/닷 등). 숫자는 이 API로만 맞춤 → 관리자 푸시(adminBroadcast) 등은
 *   푸시 수신 시 updateNotificationDot를 타지 않으므로 숫자가 올라가지 않음(FCM 쪽 notificationCount:0 병행).
 */
window.updateAppBadge = async function updateAppBadge() {
    if (typeof window.Capacitor === 'undefined' || !window.Capacitor?.isNativePlatform?.()) return;
    const Badge = window.Capacitor?.Plugins?.Badge;
    if (!Badge) return;
    const count = typeof appState.notificationUnreadCount === 'number' ? appState.notificationUnreadCount : 0;
    try {
        const perm = await Badge.checkPermissions().catch(() => ({ display: 'prompt' }));
        if (perm.display !== 'granted') {
            const requested = await Badge.requestPermissions().catch(() => ({ display: 'denied' }));
            if (requested.display !== 'granted') return;
        }
        if (count <= 0) {
            await Badge.clear();
        } else {
            await Badge.set({ count });
        }
    } catch (e) {
        console.warn('앱 배지 설정 실패 (무시):', e?.message || e);
    }
};

window.navigateToNotificationPost = (postId) => {
    if (!postId) return;
    appState.currentTab = 'gallery';
    appState.galleryFilterUserId = null;
    appState.galleryFilterPostId = postId;
    appState.galleryFilterTab = 'moment';
    if (typeof window.switchMainTab === 'function') window.switchMainTab('gallery');
    setTimeout(() => renderGallery(), 100);
};

// 실시간 알림(빨간점): 내 글에 댓글 추가 시 onSnapshot으로 감지 후 디바운스 갱신
const NOTIFICATION_DEBOUNCE_MS = 300;
let notificationDebounceTimer = null;

function onNotificationChange() {
    clearTimeout(notificationDebounceTimer);
    notificationDebounceTimer = setTimeout(() => {
        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
        const popup = document.getElementById('notificationPopup');
        if (popup && !popup.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
    }, NOTIFICATION_DEBOUNCE_MS);
}

export function startNotificationListeners() {
    const uid = window.currentUser?.uid;
    if (!uid || window.currentUser?.isAnonymous || !postInteractions || !boardOperations) return;
    stopNotificationListeners();
    try {
        appState.notificationUnsubscribePost = subscribeToMyPostComments(uid, onNotificationChange);
        if (typeof boardOperations.subscribeToMyBoardComments === 'function') {
            appState.notificationUnsubscribeBoard = boardOperations.subscribeToMyBoardComments(uid, onNotificationChange);
        }
    } catch (e) {
        console.warn('실시간 알림 리스너 등록 실패:', e?.message || e);
    }
}

export function stopNotificationListeners() {
    if (appState.notificationUnsubscribePost) {
        appState.notificationUnsubscribePost();
        appState.notificationUnsubscribePost = null;
    }
    if (appState.notificationUnsubscribeBoard) {
        appState.notificationUnsubscribeBoard();
        appState.notificationUnsubscribeBoard = null;
    }
}

// 앱 탭으로 돌아올 때 알림(빨간 점·목록) 갱신 + 실시간 리스너 재시작
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.currentUser && !window.currentUser.isAnonymous) {
        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
        const popup = document.getElementById('notificationPopup');
        if (popup && !popup.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
        startNotificationListeners();
    } else if (document.visibilityState === 'hidden') {
        stopNotificationListeners();
    }
});
