/**
 * 알림 탭에서 항목 클릭 시 — 삭제·숨김·공유 해제된 대상은 이동하지 않고 안내용.
 */
import { db, appId } from '../firebase.js';
import {
    collection,
    query,
    where,
    getDocs,
    getDocsFromServer,
    doc,
    getDoc
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { processPhotosToGroups, getPostIdFromPhotoGroup } from '../render/post-group-utils.js';

function postVisible(data) {
    return data && data.isHidden !== true;
}

export async function isBoardNotificationTargetAvailable(postId) {
    const id = String(postId || '').trim();
    if (!id) return false;
    try {
        const ref = doc(db, 'artifacts', appId, 'boardPosts', id);
        const snap = await getDoc(ref);
        return snap.exists() && postVisible(snap.data());
    } catch {
        return false;
    }
}

export async function isFeedNotificationTargetAvailable(postId) {
    const id = String(postId || '').trim();
    if (!id) return false;
    try {
        const ref = doc(db, 'artifacts', appId, 'feedPosts', id);
        const snap = await getDoc(ref);
        return snap.exists() && postVisible(snap.data());
    } catch {
        return false;
    }
}

/**
 * 모먼트 알림 postId는 sharedPhotos 문서 id, entryId_uid, daily·best·insight 그룹 키, post_해시 등 가능.
 * 갤러리 그룹 규칙과 맞추기 위해 내 공유 목록으로 유효 키 집합을 구성한다.
 */
export async function isMomentNotificationTargetAvailable(postId, ownerUid) {
    const pid = String(postId || '').trim();
    const uid = String(ownerUid || '').trim();
    if (!pid || !uid) return false;
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const sharedQ = query(sharedColl, where('userId', '==', uid));
        let sharedSnap;
        try {
            sharedSnap = await getDocsFromServer(sharedQ);
        } catch (_) {
            sharedSnap = await getDocs(sharedQ);
        }
        const valid = new Set();
        const photos = [];
        for (const d of sharedSnap.docs) {
            const data = d.data();
            const docId = d.id;
            const docUserId = String(data.userId || '').trim();
            if (docUserId !== uid) continue;
            photos.push({ id: docId, ...data });
            valid.add(docId);
            const entryId = String(data.entryId || '').trim();
            if (entryId) {
                valid.add(`${entryId}_${uid}`);
                valid.add(entryId);
            }
            const shareType = (data.type || '').trim();
            if (shareType === 'daily' && data.date) {
                valid.add(`daily_${data.date}_${docUserId}`);
            } else if (shareType === 'best') {
                valid.add(`best_${docId}_${docUserId}`);
            } else if (shareType === 'insight' && data.dateRangeText) {
                valid.add(`insight_${String(data.dateRangeText).replace(/\s/g, '_')}_${docUserId}`);
            }
        }
        const groups = processPhotosToGroups(photos);
        for (const g of groups) {
            const gid = getPostIdFromPhotoGroup(g);
            if (gid) valid.add(gid);
        }
        return valid.has(pid);
    } catch {
        return false;
    }
}

export async function isNotificationTargetAvailable(type, postId, ownerUid) {
    if (type === 'feed') return isFeedNotificationTargetAvailable(postId);
    if (type === 'board') return isBoardNotificationTargetAvailable(postId);
    if (type === 'moment') return isMomentNotificationTargetAvailable(postId, ownerUid);
    return false;
}
