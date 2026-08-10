/**
 * 댓글 알림: 읽음 상태(Firestore), 팝업 목록, 빨간 점, 실시간 onSnapshot 리스너
 */
import { appState } from '../state.js';
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import {
    postInteractions,
    subscribeToMyPostComments,
    subscribeToMyLikeNotifications,
    boardOperations,
    getFeedNotificationsForUser,
    subscribeFeedNotifications,
    isNotificationTargetAvailable,
    loadSharedPhotosForMomentNotification
} from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml, renderGallery } from '../render/index.js';
import { scheduleLucideIcons } from '../icons.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';

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
/** true여야만 Firestore getDoc 성공으로 얻은 "완전한" 상태 — false인 동안은 setNotificationReadState가 서버에 쓰지 않음
 *  (로드 실패로 비어있는/불완전한 캐시를 그대로 저장하면 merge:true라도 data 필드 전체가 덮어써져 기존 읽음 이력이 통째로 사라짐) */
let notificationReadStateAuthoritative = false;

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
        notificationReadStateAuthoritative = false;
    }
    if (notificationReadStateCache !== null) return;
    if (!user || user.isAnonymous) {
        notificationReadStateCache = {};
        notificationReadStateCacheUid = null;
        notificationReadStateAuthoritative = false;
        return;
    }
    try {
        const ref = doc(db, 'artifacts', appId, 'users', user.uid, 'config', NOTIFICATION_READ_FIRESTORE_DOC);
        const snap = await getDoc(ref);
        let state = {};
        if (snap.exists() && snap.data().data) {
            try {
                state = typeof snap.data().data === 'string' ? JSON.parse(snap.data().data) : { ...snap.data().data };
            } catch (e) {
                console.warn('알림 읽음 상태 JSON 파싱 실패(빈 상태로 대체):', e?.message || e);
            }
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
        notificationReadStateAuthoritative = true;
    } catch (e) {
        console.warn('알림 읽음 상태 Firestore 로드 실패(이번 렌더링에만 임시 값 사용, 다음 조회 시 재시도):', e);
        // uid를 확정하지 않아 다음 ensureNotificationReadStateLoaded() 호출 시 캐시가 무효화되어 재시도됨.
        // authoritative=false인 동안 setNotificationReadState는 저장을 건너뛰므로, 이 불완전한 값으로
        // Firestore의 기존 읽음 이력을 덮어쓰는 일이 없음.
        notificationReadStateCache = parseLocalNotificationReadState();
        notificationReadStateCacheUid = null;
        notificationReadStateAuthoritative = false;
    }
}

/** 로그아웃 등 사용자 전환 시 알림 읽음 캐시 초기화 (auth에서 호출) */
window.clearNotificationReadStateCache = () => {
    notificationReadStateCache = null;
    notificationReadStateCacheUid = null;
    notificationReadStateAuthoritative = false;
    _notificationMergedCache = null;
    notificationListActiveTab = 'unread';
};

/** 읽음 상태: { "type:postId": { lastCommentAt, commentCount } }. 캐시가 없으면 빈 객체(ensureNotificationReadStateLoaded 호출 후 사용) */
function getNotificationReadState() {
    if (notificationReadStateCache === null) return {};
    return notificationReadStateCache;
}

/** 읽은 알림 복원에만 쓰이는 표시용 필드 — 보관기간이 지나면 떼어낸다 */
const READ_STATE_DISPLAY_FIELDS = ['type', 'postId', 'title', 'momentLabel', 'thumbnailUrl', 'actorNickname', 'kind', 'aliasPostIds'];

/**
 * 보관기간(READ_NOTIFICATIONS_MAX_AGE_MS)이 지난 항목에서 표시용 메타만 제거.
 * 읽음 판정 필드(lastCommentAt/commentCount/readAt)는 남기므로 읽은 알림이 미읽음으로 돌아가지 않는다.
 * 읽음 상태 전체가 Firestore 문서 하나에 JSON으로 들어가므로 장기 누적을 이 선에서 끊는다.
 */
function pruneReadStateDisplayMeta(state, now = Date.now()) {
    if (!state || typeof state !== 'object') return state;
    Object.values(state).forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        if (isWithinReadRetention(notificationActivityAt(entry), now)) return;
        READ_STATE_DISPLAY_FIELDS.forEach((f) => { delete entry[f]; });
    });
    return state;
}

/** 읽음 상태 저장 직렬화 — 동시 setDoc이 서로 덮어쓰지 않도록 */
let _notificationReadWriteChain = Promise.resolve();

/** 읽음 상태 저장: 메모리 캐시 + Firestore (필드명 제한으로 data는 JSON 문자열로 저장) */
async function setNotificationReadState(state) {
    notificationReadStateCache = state;
    const user = window.currentUser;
    if (!user || user.isAnonymous) return;
    if (!notificationReadStateAuthoritative) {
        // Firestore 로드가 실패한 상태에서 저장하면 불완전한 값(예: 빈 객체)이 서버 문서의 data 필드를
        // 통째로 덮어써 기존 읽음 이력이 사라진다. 이번 변경은 화면에만 반영하고 서버 저장은 건너뛴다.
        console.warn('알림 읽음 상태가 서버와 동기화되지 않아 이번 변경은 저장하지 않습니다.');
        return;
    }
    let toSave;
    try {
        toSave = JSON.parse(JSON.stringify(state));
    } catch (_) {
        toSave = { ...state };
    }
    toSave = pruneReadStateDisplayMeta(toSave);
    const uid = user.uid;
    _notificationReadWriteChain = _notificationReadWriteChain
        .then(async () => {
            try {
                const ref = doc(db, 'artifacts', appId, 'users', uid, 'config', NOTIFICATION_READ_FIRESTORE_DOC);
                await setDoc(ref, { data: JSON.stringify(toSave) }, { merge: true });
            } catch (e) {
                console.warn('알림 읽음 상태 Firestore 저장 실패:', e);
            }
        })
        .catch(() => {});
    return _notificationReadWriteChain;
}

window.openNotificationModal = () => {
    const modal = document.getElementById('notificationModal');
    if (!modal) return;
    if (!modal.classList.contains('hidden')) return;
    notificationListActiveTab = 'unread';
    modal.classList.remove('hidden');
    lockBodyScroll('notificationModal');
    try { localStorage.setItem(NOTIFICATION_LAST_OPENED_KEY, String(Date.now())); } catch (_) {}
    if (typeof window.updateNotificationDot === 'function') window.updateNotificationDot();
    window.loadNotificationList();
};

/** @deprecated toggle 대신 openNotificationModal 사용 */
window.toggleNotificationPopup = window.openNotificationModal;

window.closeNotificationPopup = () => {
    document.getElementById('notificationModal')?.classList.add('hidden');
    unlockBodyScroll('notificationModal');
};

export function initNotificationModal() {
    document.getElementById('notificationBackdrop')?.addEventListener('click', window.closeNotificationPopup);
    document.getElementById('notificationDismissBtn')?.addEventListener('click', window.closeNotificationPopup);
}

function getNotificationReadPostIds() {
    const state = getNotificationReadState();
    return new Set(Object.keys(state));
}

/** 읽음 키: type:postId + 모먼트 alias + 레거시 postId */
function notificationKeysForItem(item) {
    const keys = new Set();
    if (!item || !item.postId) return [];
    const type = item.type || 'moment';
    keys.add(`${type}:${item.postId}`);
    if (type === 'moment') {
        keys.add(item.postId);
    }
    if (type === 'moment' || type === 'momentLike') {
        (item.aliasPostIds || []).forEach((id) => {
            const s = String(id || '').trim();
            if (!s) return;
            keys.add(`${type}:${s}`);
            if (type === 'moment') keys.add(s);
        });
    }
    return [...keys];
}

/** 읽음 판정에 쓰이는 최소 필드 — alias/레거시 키에는 이것만 저장해 문서 크기를 줄인다 */
function buildReadCorePayload(item, readAt = Date.now()) {
    return {
        lastCommentAt: Number(item?.lastCommentAt) || 0,
        commentCount: Number(item?.commentCount) || 0,
        readAt: Number(readAt) || Date.now()
    };
}

/** 표시용 문자열 저장 상한 — 읽음 상태는 Firestore 문서 한 개에 JSON으로 들어가므로 길이를 제한한다 */
function sanitizeMetaText(value, maxLen = 120) {
    const s = value == null ? '' : String(value).trim();
    if (!s) return null;
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** 썸네일은 http(s) URL만 보관 (data: URI는 base64 본문이 통째로 문서에 실림) */
function sanitizeThumbUrl(value) {
    const s = value == null ? '' : String(value).trim();
    if (!s || !/^https?:\/\//i.test(s) || s.length > 512) return null;
    return s;
}

/**
 * 읽음 저장 페이로드 — 이후 라이브 집계에서 빠져도 읽은 알림 탭에 복원할 수 있게 표시 메타 포함.
 * 대표 키(`type:postId`)에만 저장하고 alias/레거시 키는 buildReadCorePayload를 쓴다.
 */
function buildNotificationReadPayload(item, readAt = Date.now()) {
    return {
        ...buildReadCorePayload(item, readAt),
        type: item?.type || 'moment',
        postId: item?.postId != null ? String(item.postId) : '',
        title: sanitizeMetaText(item?.title),
        momentLabel: sanitizeMetaText(item?.momentLabel),
        thumbnailUrl: sanitizeThumbUrl(item?.thumbnailUrl),
        actorNickname: sanitizeMetaText(item?.actorNickname, 40),
        kind: sanitizeMetaText(item?.kind, 20),
        aliasPostIds: Array.isArray(item?.aliasPostIds)
            ? item.aliasPostIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 20)
            : []
    };
}

/** 한 항목의 읽음 표시를 state에 반영 (대표 키=메타 포함, 나머지 키=최소 필드) */
function applyReadPayloadToState(state, item, readAt = Date.now()) {
    const keys = notificationKeysForItem(item);
    if (!keys.length) return;
    const primaryKey = `${item?.type || 'moment'}:${item?.postId}`;
    const full = buildNotificationReadPayload(item, readAt);
    const core = buildReadCorePayload(item, readAt);
    keys.forEach((key) => {
        state[key] = key === primaryKey ? full : { ...core };
    });
}

function markNotificationItemAsRead(item) {
    const state = getNotificationReadState();
    applyReadPayloadToState(state, item);
    setNotificationReadState(state);
}

/** 같은 글에 새 댓글이 달리면( lastCommentAt이 커지면) 미확인으로 표시 */
function isNotificationRead(item, readState) {
    const keys = notificationKeysForItem(item);
    let stored = null;
    for (const key of keys) {
        const s = readState[key];
        if (!s) continue;
        if (
            !stored ||
            Number(s.lastCommentAt) > Number(stored.lastCommentAt) ||
            (Number(s.lastCommentAt) === Number(stored.lastCommentAt) &&
                Number(s.commentCount) >= Number(stored.commentCount || 0))
        ) {
            stored = s;
        }
    }
    if (!stored) return false;
    const lastAt = Number(stored.lastCommentAt);
    const count = Number(stored.commentCount);
    if (Number.isNaN(lastAt)) return false;
    if (item.lastCommentAt > lastAt) return false;
    if (!Number.isNaN(count) && item.commentCount > count) return false;
    return true;
}

/** 활동/읽음 시각 — lastCommentAt → readAt 순으로 폴백, 둘 다 없으면 0 */
function notificationActivityAt(itemOrStored) {
    const last = Number(itemOrStored?.lastCommentAt);
    if (Number.isFinite(last) && last > 0) return last;
    const readAt = Number(itemOrStored?.readAt);
    if (Number.isFinite(readAt) && readAt > 0) return readAt;
    return 0;
}

function isWithinReadRetention(atMs, now = Date.now()) {
    // 시각이 없으면 드롭하지 않음 (예전엔 lastCommentAt=0 이 now-0 으로 계산돼 90일 필터에 걸려
    // 방금 읽은 알림도 읽은 목록에서 곧바로 사라졌다)
    if (!atMs || atMs <= 0) return true;
    return now - atMs <= READ_NOTIFICATIONS_MAX_AGE_MS;
}

/**
 * 모먼트 @언급(localStorage)을 목록에 합친다.
 * 내 글 댓글 집계에 있으면 표시만 덮어쓰고, 없으면(타인 글에서 언급 등) 단독 항목으로 추가.
 */
function mergeMomentMentionsIntoItems(momentItems) {
    const items = Array.isArray(momentItems) ? [...momentItems] : [];
    loadMv2MentionNotifs().forEach((m) => {
        const pid = String(m?.postId || '').trim();
        if (!pid) return;
        const actor = String(m?.actorNickname || '').trim() || '누군가';
        const existing = items.find(
            (x) =>
                x &&
                x.type === 'moment' &&
                (String(x.postId) === pid || (x.aliasPostIds || []).map(String).includes(pid))
        );
        if (existing) {
            // lastCommentAt은 읽음 판정용 — localStorage 시각으로 올리면 모두 읽음이 다시 미읽음으로 돌아옴
            existing.kind = 'mention';
            existing.actorNickname = actor;
            return;
        }
        // 시각이 없으면 0 — Date.now()를 넣으면 매 로드마다 값이 커져 읽음 판정이 계속 풀린다
        const at = Number(m?.at) > 0 ? Number(m.at) : 0;
        items.push({
            type: 'moment',
            postId: pid,
            lastCommentAt: at,
            commentCount: 1,
            kind: 'mention',
            actorNickname: actor,
            momentLabel: '언급된 게시물',
            thumbnailUrl: null,
            aliasPostIds: [pid]
        });
    });
    return items;
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
        unreadBtn.classList.toggle('active', isUnread);
    }
    if (readBtn) {
        readBtn.setAttribute('aria-selected', !isUnread ? 'true' : 'false');
        readBtn.classList.toggle('active', !isUnread);
    }
    if (markAll) {
        markAll.classList.toggle('invisible', !isUnread || unreadCount === 0);
    }
    if (hint) {
        hint.classList.toggle('hidden', isUnread);
    }
}

/** 읽음 키에서 type/postId 복원 — 메타가 없는 예전 저장분 대비 (콜론 없는 키는 레거시 모먼트) */
function parseReadStateKey(key) {
    const m = String(key).match(/^(moment|momentLike|board|feed):(.+)$/);
    if (m) return { type: m[1], postId: String(m[2] || '').trim() };
    if (key && !String(key).includes(':')) return { type: 'moment', postId: String(key).trim() };
    return { type: null, postId: '' };
}

/**
 * 읽은 알림 탭 목록.
 * 라이브 집계에 남아 있는 읽은 항목 + 집계에서 빠진(원글/댓글 삭제 등) 항목을 읽음 상태의 메타로 복원한 것.
 */
function buildReadNotificationsList(merged, readState) {
    const now = Date.now();
    const liveItems = Array.isArray(merged) ? merged : [];
    const liveRead = liveItems
        .filter((item) => isNotificationRead(item, readState))
        .filter((item) => isWithinReadRetention(notificationActivityAt(item), now));

    // 라이브 집계에 있는 항목은 읽음/안읽음 상관없이 복원 대상에서 제외한다.
    // (안읽음 항목까지 복원하면 같은 알림이 두 탭에 동시에 나온다)
    const covered = new Set();
    liveItems.forEach((item) => {
        notificationKeysForItem(item).forEach((k) => covered.add(k));
    });

    const history = [];
    const historySeen = new Set();
    Object.entries(readState || {}).forEach(([key, stored]) => {
        if (!stored || typeof stored !== 'object') return;
        if (covered.has(key)) return;

        const parsed = parseReadStateKey(key);
        const type = stored.type || parsed.type;
        const postId = stored.postId ? String(stored.postId).trim() : parsed.postId;
        if (!type || !postId) return;

        const primary = `${type}:${postId}`;
        if (covered.has(primary) || historySeen.has(primary)) return;
        if (!isWithinReadRetention(notificationActivityAt(stored), now)) return;

        historySeen.add(primary);
        const aliasPostIds = Array.isArray(stored.aliasPostIds) ? stored.aliasPostIds : [];
        // 같은 글의 alias 키가 별도 항목으로 또 잡히지 않도록 미리 막는다
        aliasPostIds.forEach((id) => {
            const s = String(id || '').trim();
            if (s) historySeen.add(`${type}:${s}`);
        });
        history.push({
            type,
            postId,
            lastCommentAt: notificationActivityAt(stored),
            commentCount: Number(stored.commentCount) || 0,
            title: stored.title || null,
            momentLabel: stored.momentLabel || stored.title || '해당 게시물',
            thumbnailUrl: stored.thumbnailUrl || null,
            actorNickname: stored.actorNickname || null,
            kind: stored.kind || null,
            aliasPostIds
        });
    });

    return [...liveRead, ...history]
        .sort((a, b) => (Number(b.lastCommentAt) || 0) - (Number(a.lastCommentAt) || 0))
        .slice(0, READ_NOTIFICATIONS_MAX_DISPLAY);
}

function appendNotificationRow(listEl, item, { dimmed }) {
    const { postId, type, lastCommentAt, commentCount, thumbnailUrl, title, momentLabel } = item;
    const atMs = Number(lastCommentAt);
    const d = Number.isFinite(atMs) && atMs > 0 ? new Date(atMs) : null;
    // 시각이 없는 항목(복원된 옛 읽음 등)은 1970년으로 찍히지 않게 빈 문자열
    const timeStr = d
        ? d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) +
          ' ' +
          d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
        : '';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `notification-row${dimmed ? ' notification-row--dimmed' : ''}`;
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
    const timeSuffix = timeStr ? ` · ${timeStr}` : '';
    const subText =
        type === 'feed'
            ? `밀톡 알림${timeSuffix}`
            : type === 'moment' && item.kind === 'mention'
              ? `${escapeHtml(String(item.actorNickname || '누군가'))}님이 회원님을 언급했어요${timeSuffix}`
              : type === 'momentLike'
                ? commentCount > 1
                    ? `${escapeHtml(String(item.actorNickname || '누군가'))}님 외 ${commentCount - 1}명이 좋아합니다${timeSuffix}`
                    : `${escapeHtml(String(item.actorNickname || '누군가'))}님이 좋아합니다${timeSuffix}`
                : `댓글 ${commentCount}개${timeSuffix}`;
    const thumbHtml =
        (type === 'moment' || type === 'momentLike') && thumbnailUrl
            ? `<div class="notification-row-thumb"><img src="${escapeHtml(thumbnailUrl)}" alt="" loading="lazy"></div>`
            : type === 'feed'
              ? `<div class="notification-row-ico" aria-hidden="true"><i data-lucide="message-circle-more" aria-hidden="true"></i></div>`
              : type === 'board'
                ? `<div class="notification-row-ico" aria-hidden="true"><i data-lucide="layout-list" aria-hidden="true"></i></div>`
                : type === 'momentLike'
                  ? `<div class="notification-row-ico" aria-hidden="true"><i data-lucide="heart" aria-hidden="true"></i></div>`
                  : `<div class="notification-row-ico" aria-hidden="true"><i data-lucide="images" aria-hidden="true"></i></div>`;
    row.innerHTML = `${thumbHtml}<div class="notification-row-body"><span class="notification-row-title">${label}</span><span class="notification-row-sub">${subText}</span></div>`;
    row.addEventListener('click', async () => {
        markNotificationItemAsRead(item);
        window.closeNotificationPopup();
        const ownerUid = window.currentUser?.uid;
        if (!ownerUid) {
            showToast('로그인이 필요합니다.', 'error');
            window.updateNotificationDot();
            return;
        }
        try {
            if (type === 'moment' || type === 'momentLike') {
                const photos = await loadSharedPhotosForMomentNotification(postId, ownerUid);
                if (!photos.length) {
                    showToast('공유가 해제되어 해당 게시물을 찾을 수 없습니다.', 'error');
                    window.updateNotificationDot();
                    return;
                }
                appState.galleryNotificationFilterPhotos = photos;
                window.navigateToNotificationPost(postId);
            } else {
                const ok = await isNotificationTargetAvailable(type, postId, ownerUid);
                if (!ok) {
                    if (type === 'feed') {
                        showToast('삭제되었거나 볼 수 없는 밀톡입니다.', 'error');
                    } else {
                        showToast('삭제되었거나 찾을 수 없는 게시글입니다.', 'error');
                    }
                    window.updateNotificationDot();
                    return;
                }
                if (type === 'feed') {
                    if (typeof window.navigateToFeedNotification === 'function') window.navigateToFeedNotification(postId);
                } else if (type === 'board') {
                    if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
                    if (typeof window.openBoardDetail === 'function') window.openBoardDetail(postId);
                }
            }
        } catch (e) {
            console.warn('알림 대상 확인 실패:', e?.message || e);
            showToast('알림을 열 수 없습니다. 잠시 후 다시 시도해 주세요.', 'error');
            window.updateNotificationDot();
            return;
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
            const readAt = Date.now();
            unread.forEach((item) => applyReadPayloadToState(state, item, readAt));
            setNotificationReadState(state);
            window.loadNotificationList();
            window.updateNotificationDot();
        };
    }

    listEl.innerHTML = '';
    if (notificationListActiveTab === 'unread') {
        if (unread.length === 0) {
            listEl.classList.add('hidden');
            emptyEl.classList.remove('hidden');
            emptyEl.textContent = '새 알림이 없습니다.';
            return;
        }
        listEl.classList.remove('hidden');
        emptyEl.classList.add('hidden');
        unread.forEach((item) => appendNotificationRow(listEl, item, { dimmed: false }));
        scheduleLucideIcons(listEl);
        return;
    }
    if (readItems.length === 0) {
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = '읽은 알림이 없습니다.';
        return;
    }
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    readItems.forEach((item) => appendNotificationRow(listEl, item, { dimmed: true }));
    scheduleLucideIcons(listEl);
}

window.loadNotificationList = async () => {
    const listEl = document.getElementById('notificationList');
    const emptyEl = document.getElementById('notificationEmpty');
    if (!listEl || !emptyEl) return;
    listEl.classList.remove('hidden');
    listEl.innerHTML = '<div class="notification-list-loading">불러오는 중…</div>';
    emptyEl.classList.add('hidden');
    bindNotificationTabsOnce();
    if (!window.currentUser || window.currentUser.isAnonymous || !window.postInteractions) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = '로그인이 필요합니다.';
        syncNotificationTabUi(0);
        return;
    }
    try {
        await ensureNotificationReadStateLoaded();
        const [momentRaw, momentLikeItems, boardItems, feedItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            postInteractions.getPostsWithLikesForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([]),
            getFeedNotificationsForUser(window.currentUser.uid)
        ]);
        const momentItems = mergeMomentMentionsIntoItems(momentRaw);
        _notificationMergedCache = [...momentItems, ...momentLikeItems, ...boardItems, ...feedItems].sort(
            (a, b) => (Number(b.lastCommentAt) || 0) - (Number(a.lastCommentAt) || 0)
        );
        renderNotificationPanelFromCache();
    } catch (e) {
        console.error('알림 목록 로드 실패:', e);
        _notificationMergedCache = null;
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        emptyEl.textContent = '목록을 불러올 수 없습니다.';
        emptyEl.classList.remove('hidden');
        syncNotificationTabUi(0);
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
        const [momentRaw, momentLikeItems, boardItems, feedItems] = await Promise.all([
            postInteractions.getPostsWithCommentsForUser(window.currentUser.uid),
            postInteractions.getPostsWithLikesForUser(window.currentUser.uid),
            window.boardOperations && typeof window.boardOperations.getBoardPostsWithCommentsForUser === 'function'
                ? window.boardOperations.getBoardPostsWithCommentsForUser(window.currentUser.uid)
                : Promise.resolve([]),
            getFeedNotificationsForUser(window.currentUser.uid)
        ]);
        const momentItems = mergeMomentMentionsIntoItems(momentRaw);
        const merged = [...momentItems, ...momentLikeItems, ...boardItems, ...feedItems];
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
    else setTimeout(() => renderGallery(), 100);
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
        appState.notificationUnsubscribeLike = subscribeToMyLikeNotifications(uid, onNotificationChange);
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
    if (appState.notificationUnsubscribeLike) {
        appState.notificationUnsubscribeLike();
        appState.notificationUnsubscribeLike = null;
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
