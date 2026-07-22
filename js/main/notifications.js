/**
 * 댓글 알림: 읽음 상태(Firestore), 팝업 목록, 빨간 점, 실시간 onSnapshot 리스너
 */
import { appState } from '../state.js';
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
    postInteractions,
    subscribeToMyPostComments,
    boardOperations,
    getFeedNotificationsForUser,
    subscribeFeedNotifications,
    isNotificationTargetAvailable
} from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml, renderGallery } from '../render/index.js';

const NOTIFICATION_LAST_OPENED_KEY = 'mealog_notification_last_opened';
const NOTIFICATION_READ_POST_IDS_KEY = 'mealog_notification_read_post_ids';
const NOTIFICATION_READ_FIRESTORE_DOC = 'notificationRead';

/** 읽은 알림 탭: 표시 개수 상한 (더 오래된 읽음은 목록에서 생략) */
const READ_NOTIFICATIONS_MAX_DISPLAY = 50;
/** 읽은 알림 탭: 활동 시각 기준 보관 기간 (밀리초) — 그 이전 읽음은 표시하지 않음 */
const READ_NOTIFICATIONS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** 'unread' | 'read' — 팝업 내 탭 */
let notificationListActiveTab = 'unread';
let _notificationMergedCache = null;
let _notificationTabsBound = false;

const MV2_MENTION_NOTIFS_KEY = 'mealog_mv2_mention_notifs';

function loadMv2MentionNotifs() {
    try {
        const raw = localStorage.getItem(MV2_MENTION_NOTIFS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function saveMv2MentionNotifs(arr) {
    try {
        localStorage.setItem(MV2_MENTION_NOTIFS_KEY, JSON.stringify(arr.slice(0, 50)));
    } catch (_) {}
}

window.pushMomentMentionNotification = (postId, actorNickname, atMs) => {
    const pid = String(postId || '').trim();
    const actor = String(actorNickname || '').trim() || '누군가';
    const at = Number(atMs) || Date.now();
    if (!pid) return;
    const arr = loadMv2MentionNotifs();
    // 같은 글+같은 작성자: 최신 1개만 유지
    const filtered = arr.filter((x) => !(x && x.postId === pid && x.actorNickname === actor));
    filtered.unshift({ postId: pid, actorNickname: actor, at });
    saveMv2MentionNotifs(filtered);
    // 팝업 열려 있으면 즉시 갱신
    try {
        const modal = document.getElementById('notificationModal');
        if (modal && !modal.classList.contains('hidden') && typeof window.loadNotificationList === 'function') {
            window.loadNotificationList();
        }
        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
    } catch (_) {}
};

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
    _notificationMergedCache = null;
    notificationListActiveTab = 'unread';
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

window.openNotificationModal = () => {
    const modal = document.getElementById('notificationModal');
    if (!modal) return;
    if (!modal.classList.contains('hidden')) return;
    notificationListActiveTab = 'unread';
    modal.classList.remove('hidden');
    try { localStorage.setItem(NOTIFICATION_LAST_OPENED_KEY, String(Date.now())); } catch (_) {}
    if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
    window.loadNotificationList();
};

/** @deprecated toggle 대신 openNotificationModal 사용 */
window.toggleNotificationPopup = window.openNotificationModal;

window.closeNotificationPopup = () => {
    document.getElementById('notificationModal')?.classList.add('hidden');
};

export function initNotificationModal() {
    document.getElementById('notificationBackdrop')?.addEventListener('click', window.closeNotificationPopup);
    document.getElementById('notificationCloseBtn')?.addEventListener('click', window.closeNotificationPopup);
    document.getElementById('notificationDismissBtn')?.addEventListener('click', window.closeNotificationPopup);
}

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

function bindNotificationTabsOnce() {
    if (_notificationTabsBound) return;
    const unreadBtn = document.getElementById('notificationTabUnread');
    const readBtn = document.getElementById('notificationTabRead');
    if (!unreadBtn || !readBtn) return;
    _notificationTabsBound = true;
    unreadBtn.addEventListener('click', () => {
        notificationListActiveTab = 'unread';
        renderNotificationPanelFromCache();
    });
    readBtn.addEventListener('click', () => {
        notificationListActiveTab = 'read';
        renderNotificationPanelFromCache();
    });
}

/** @param {number} unreadCount — 새 알림 개수(모두 읽음 버튼 표시용) */
function syncNotificationTabUi(unreadCount = 0) {
    const unreadBtn = document.getElementById('notificationTabUnread');
    const readBtn = document.getElementById('notificationTabRead');
    const markAll = document.getElementById('notificationMarkAllReadBtn');
    const hint = document.getElementById('notificationReadHint');
    const isUnread = notificationListActiveTab === 'unread';
    if (unreadBtn) {
        unreadBtn.setAttribute('aria-selected', isUnread ? 'true' : 'false');
        unreadBtn.className = isUnread
            ? 'notification-tab-btn flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/80'
            : 'notification-tab-btn flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors bg-slate-100 text-slate-600 hover:bg-slate-200/70';
    }
    if (readBtn) {
        readBtn.setAttribute('aria-selected', !isUnread ? 'true' : 'false');
        readBtn.className = !isUnread
            ? 'notification-tab-btn flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition-colors bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/80'
            : 'notification-tab-btn flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors bg-slate-100 text-slate-600 hover:bg-slate-200/70';
    }
    if (markAll) {
        markAll.classList.toggle('invisible', !isUnread || unreadCount === 0);
    }
    if (hint) {
        hint.classList.toggle('hidden', isUnread);
    }
}

function buildReadNotificationsList(merged, readState) {
    const now = Date.now();
    return merged
        .filter((item) => isNotificationRead(item, readState))
        .filter((item) => now - Number(item.lastCommentAt || 0) <= READ_NOTIFICATIONS_MAX_AGE_MS)
        .sort((a, b) => b.lastCommentAt - a.lastCommentAt)
        .slice(0, READ_NOTIFICATIONS_MAX_DISPLAY);
}

function appendNotificationRow(listEl, item, { dimmed }) {
    const { postId, type, lastCommentAt, commentCount, thumbnailUrl, title, momentLabel } = item;
    const notificationKey = `${type}:${postId}`;
    const d = new Date(lastCommentAt);
    const timeStr =
        d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-50 active:bg-slate-100 transition-colors border-b border-slate-50 last:border-0 flex items-center gap-3 ${
        dimmed ? 'opacity-90' : ''
    }`;
    const label =
        type === 'feed'
            ? escapeHtml(item.title || '밀톡')
            : type === 'board'
              ? title
                  ? escapeHtml(title)
                  : '해당 게시물'
              : momentLabel
                ? escapeHtml(momentLabel)
                : '해당 게시물';
    const subText =
        type === 'feed'
            ? `밀톡 알림 · ${timeStr}`
            : type === 'moment' && item.kind === 'mention'
              ? `${escapeHtml(String(item.actorNickname || '누군가'))}님이 회원님을 언급했어요 · ${timeStr}`
              : `댓글 ${commentCount}개 · ${timeStr}`;
    const thumbHtml =
        type === 'moment' && thumbnailUrl
            ? `<div class="flex-shrink-0 w-10 h-10 rounded-lg overflow-hidden bg-slate-100 border border-slate-200"><img src="${escapeHtml(thumbnailUrl)}" alt="" class="w-full h-full object-cover" loading="lazy"></div>`
            : type === 'feed'
              ? `<div class="flex-shrink-0 w-10 h-10 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600"><i data-lucide="message-circle-more" aria-hidden="true"></i></div>`
              : '';
    const titleCls = dimmed ? 'text-slate-500 text-sm font-medium block truncate' : 'text-slate-700 text-sm font-medium block truncate';
    const subCls = dimmed ? 'text-slate-400 text-xs' : 'text-slate-500 text-xs';
    row.innerHTML = `${thumbHtml}<div class="flex-1 min-w-0"><span class="${titleCls}">${label}</span><span class="${subCls}">${subText}</span></div>`;
    row.addEventListener('click', async () => {
        markNotificationAsRead(notificationKey, lastCommentAt, commentCount);
        window.closeNotificationPopup();
        const ownerUid = window.currentUser?.uid;
        if (!ownerUid) {
            showToast('로그인이 필요합니다.', 'error');
            window.updateNotificationDot();
            return;
        }
        try {
            const ok = await isNotificationTargetAvailable(type, postId, ownerUid);
            if (!ok) {
                if (type === 'feed') {
                    showToast('삭제되었거나 볼 수 없는 밀톡입니다.', 'error');
                } else if (type === 'board') {
                    showToast('삭제되었거나 찾을 수 없는 게시글입니다.', 'error');
                } else {
                    showToast('공유가 해제되어 해당 게시물을 찾을 수 없습니다.', 'error');
                }
                window.updateNotificationDot();
                return;
            }
        } catch (e) {
            console.warn('알림 대상 확인 실패:', e?.message || e);
            showToast('알림을 열 수 없습니다. 잠시 후 다시 시도해 주세요.', 'error');
            window.updateNotificationDot();
            return;
        }
        if (type === 'feed') {
            if (typeof window.navigateToFeedNotification === 'function') window.navigateToFeedNotification(postId);
        } else if (type === 'board') {
            if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
            if (typeof window.openBoardDetail === 'function') window.openBoardDetail(postId);
        } else {
            window.navigateToNotificationPost(postId);
        }
        window.updateNotificationDot();
    });
    listEl.appendChild(row);
}

function renderNotificationPanelFromCache() {
    const listEl = document.getElementById('notificationList');
    const emptyEl = document.getElementById('notificationEmpty');
    if (!listEl || !emptyEl || !_notificationMergedCache) return;
    const readState = getNotificationReadState();
    const merged = _notificationMergedCache;
    const unread = merged.filter((item) => !isNotificationRead(item, readState));
    const readItems = buildReadNotificationsList(merged, readState);

    syncNotificationTabUi(unread.length);

    const markAllReadBtn = document.getElementById('notificationMarkAllReadBtn');
    if (markAllReadBtn && notificationListActiveTab === 'unread') {
        markAllReadBtn.onclick = () => {
            const state = getNotificationReadState();
            unread.forEach((item) => {
                const key = `${item.type}:${item.postId}`;
                state[key] = { lastCommentAt: item.lastCommentAt, commentCount: item.commentCount };
            });
            setNotificationReadState(state);
            window.loadNotificationList();
            window.updateNotificationDot();
        };
    }

    listEl.innerHTML = '';
    if (notificationListActiveTab === 'unread') {
        if (unread.length === 0) {
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = '새 알림이 없습니다.';
            return;
        }
        emptyEl.classList.add('hidden');
        unread.forEach((item) => appendNotificationRow(listEl, item, { dimmed: false }));
        return;
    }
    if (readItems.length === 0) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = '읽은 알림이 없습니다.';
        return;
    }
    emptyEl.classList.add('hidden');
    readItems.forEach((item) => appendNotificationRow(listEl, item, { dimmed: true }));
}

window.loadNotificationList = async () => {
    const listEl = document.getElementById('notificationList');
    const emptyEl = document.getElementById('notificationEmpty');
    if (!listEl || !emptyEl) return;
    listEl.innerHTML = '<div class="p-4 text-center text-slate-400 text-sm">불러오는 중...</div>';
    emptyEl.classList.add('hidden');
    bindNotificationTabsOnce();
    if (!window.currentUser || window.currentUser.isAnonymous || !window.postInteractions) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = '로그인이 필요합니다.';
        return;
    }
    try {
        await ensureNotificationReadStateLoaded();
        const [momentItems, boardItems, feedItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([]),
            getFeedNotificationsForUser(window.currentUser.uid)
        ]);
        const mv2Mentions = loadMv2MentionNotifs();
        // 모먼트(내 글 댓글) 항목에 @언급 정보를 오버레이 (subText를 바꾸기 위함)
        mv2Mentions.forEach((m) => {
            const pid = String(m?.postId || '').trim();
            if (!pid) return;
            const it = momentItems.find((x) => x && x.type === 'moment' && String(x.postId) === pid);
            if (!it) return;
            it.kind = 'mention';
            it.actorNickname = String(m.actorNickname || '').trim() || it.actorNickname || '누군가';
            const at = Number(m.at) || 0;
            if (at > 0 && at > Number(it.lastCommentAt || 0)) it.lastCommentAt = at;
        });
        _notificationMergedCache = [...momentItems, ...boardItems, ...feedItems].sort((a, b) => b.lastCommentAt - a.lastCommentAt);
        renderNotificationPanelFromCache();
    } catch (e) {
        console.error('알림 목록 로드 실패:', e);
        _notificationMergedCache = null;
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
        const [momentItems, boardItems, feedItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([]),
            getFeedNotificationsForUser(window.currentUser.uid)
        ]);
        const mv2Mentions = loadMv2MentionNotifs();
        mv2Mentions.forEach((m) => {
            const pid = String(m?.postId || '').trim();
            if (!pid) return;
            const it = momentItems.find((x) => x && x.type === 'moment' && String(x.postId) === pid);
            if (!it) return;
            it.kind = 'mention';
            it.actorNickname = String(m.actorNickname || '').trim() || it.actorNickname || '누군가';
            const at = Number(m.at) || 0;
            if (at > 0 && at > Number(it.lastCommentAt || 0)) it.lastCommentAt = at;
        });
        const merged = [...momentItems, ...boardItems, ...feedItems];
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

/** 밀톡 알림 탭: 라운지 > 밀톡 피드로 이동 후 해당 말풍선으로 스크롤 */
window.navigateToFeedNotification = (feedPostId) => {
    const id = String(feedPostId || '').trim();
    if (!id) return;
    appState.currentTab = 'board';
    appState.boardListSubTab = 'feed';
    if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
    if (typeof window.switchBoardListSubTab === 'function') window.switchBoardListSubTab('feed');
    const safeId =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(id)
            : String(id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const tryScroll = (attempt) => {
        const row = document.querySelector(`[data-post-id="${safeId}"]`);
        if (row) {
            row.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
        if (attempt < 12) setTimeout(() => tryScroll(attempt + 1), 150);
    };
    setTimeout(() => tryScroll(0), 200);
};

// 실시간 알림(빨간점): 내 글에 댓글 추가 시 onSnapshot으로 감지 후 디바운스 갱신
const NOTIFICATION_DEBOUNCE_MS = 300;
let notificationDebounceTimer = null;

function onNotificationChange() {
    clearTimeout(notificationDebounceTimer);
    notificationDebounceTimer = setTimeout(() => {
        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
        const modal = document.getElementById('notificationModal');
        if (modal && !modal.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
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
        appState.notificationUnsubscribeFeed = subscribeFeedNotifications(uid, onNotificationChange);
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
    if (appState.notificationUnsubscribeFeed) {
        appState.notificationUnsubscribeFeed();
        appState.notificationUnsubscribeFeed = null;
    }
}

// 앱 탭으로 돌아올 때 알림(빨간 점·목록) 갱신 + 실시간 리스너 재시작
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.currentUser && !window.currentUser.isAnonymous) {
        if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
        const modal = document.getElementById('notificationModal');
        if (modal && !modal.classList.contains('hidden') && typeof window.loadNotificationList === 'function') window.loadNotificationList();
        startNotificationListeners();
    } else if (document.visibilityState === 'hidden') {
        stopNotificationListeners();
    }
});
