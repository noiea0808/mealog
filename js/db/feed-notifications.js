/**
 * 밀톡 피드 알림 (답장·@언급) — users/{uid}/feedNotifications
 */
import { db, appId } from '../firebase.js';
import {
    collection,
    query,
    orderBy,
    limit,
    getDocs,
    getDocsFromServer,
    onSnapshot
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

function mapFeedNotifDoc(d) {
    const data = d.data() || {};
    const feedPostId = String(data.feedPostId || d.id || '').trim();
    let lastCommentAt = 0;
    const t = data.createdAt;
    if (t) {
        if (t.toDate && typeof t.toDate === 'function') lastCommentAt = t.toDate().getTime();
        else lastCommentAt = new Date(t).getTime();
    }
    const kind = data.kind || 'mention';
    const actor = String(data.actorNickname || '').trim() || '익명';
    let line = '';
    if (kind === 'reply') line = `${actor}님이 답장을 보냈어요`;
    else if (kind === 'mention') line = `${actor}님이 당신을 언급했어요`;
    else if (kind === 'reply_mention') line = `${actor}님이 답장에서 당신을 언급했어요`;
    else line = `${actor}님이 밀톡에 메시지를 보냈어요`;

    return {
        type: 'feed',
        postId: feedPostId,
        lastCommentAt,
        commentCount: 1,
        title: `밀톡 · ${line}`,
        thumbnailUrl: null,
        feedKind: kind,
        actorNickname: actor,
        previewText: data.previewText || ''
    };
}

/** 알림 목록용: 내 밀톡 알림 (최신순) */
export async function getFeedNotificationsForUser(ownerId) {
    const uid = String(ownerId || '').trim();
    if (!uid) return [];
    try {
        const coll = collection(db, 'artifacts', appId, 'users', uid, 'feedNotifications');
        const q = query(coll, orderBy('createdAt', 'desc'), limit(50));
        let snap;
        try {
            snap = await getDocsFromServer(q);
        } catch (_) {
            snap = await getDocs(q);
        }
        return snap.docs.map((d) => mapFeedNotifDoc(d));
    } catch (e) {
        console.warn('[getFeedNotificationsForUser]', e);
        return [];
    }
}

/** 실시간: 밀톡 알림 서브컬렉션 변경 시 콜백 */
export function subscribeFeedNotifications(uid, onChange) {
    const id = String(uid || '').trim();
    if (!id) return () => {};
    const coll = collection(db, 'artifacts', appId, 'users', id, 'feedNotifications');
    const q = query(coll, orderBy('createdAt', 'desc'), limit(50));
    return onSnapshot(
        q,
        () => onChange(),
        (e) => console.warn('[subscribeFeedNotifications]', e?.message || e)
    );
}
