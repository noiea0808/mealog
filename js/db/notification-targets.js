/**
 * 알림 탭에서 항목 클릭 시 — 삭제·숨김·공유 해제된 대상은 이동하지 않고 안내용.
 * 모먼트 알림은 postId 형식이 여러 세대가 섞여 있어 후보 키로 매칭한다.
 */
import { db, appId } from '../firebase.js';
import {
    collection,
    query,
    where,
    getDocs,
    getDocsFromServer,
    doc,
    getDoc,
    limit
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { photoGroupMatchesTracePostIds } from '../render/post-group-utils.js';
import { loadSharedPhotosByUserPage } from './listeners.js';
import { docsToSortedPhotoGroups } from '../utils/moment-post-v2.js';

function postVisible(data) {
    return data && data.isHidden !== true;
}

function normalizeSharedDoc(d) {
    return { id: d.id, ...d.data() };
}

/** 내 공유 목록에서 알림 postId와 매칭되는 그룹의 사진 문서들 */
function findMatchingGroupPhotos(photos, postId) {
    const pid = String(postId || '').trim();
    if (!pid || !photos?.length) return [];
    const groups = docsToSortedPhotoGroups(photos);
    const hit = groups.find((g) => photoGroupMatchesTracePostIds(g, new Set([pid])));
    return hit ? [...hit] : [];
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
 * 모먼트 알림 postId → 내 sharedPhotos에서 해당 게시물 사진들을 로드.
 * 전역 피드 첫 페이지에 없어도 열 수 있게 한다.
 */
export async function loadSharedPhotosForMomentNotification(postId, ownerUid) {
    const pid = String(postId || '').trim();
    const uid = String(ownerUid || '').trim();
    if (!pid || !uid) return [];

    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');

    try {
        // 1) sharedPhotos 문서 id 직접
        const directRef = doc(db, 'artifacts', appId, 'sharedPhotos', pid);
        const directSnap = await getDoc(directRef);
        if (directSnap.exists()) {
            const data = directSnap.data() || {};
            if (String(data.userId || '').trim() === uid && postVisible(data)) {
                const entryId = String(data.entryId || '').trim();
                if (entryId) {
                    const q = query(sharedColl, where('userId', '==', uid), where('entryId', '==', entryId), limit(30));
                    let snap;
                    try {
                        snap = await getDocsFromServer(q);
                    } catch (_) {
                        snap = await getDocs(q);
                    }
                    const photos = snap.docs.map(normalizeSharedDoc).filter((p) => postVisible(p));
                    if (photos.length) return photos;
                }
                return [normalizeSharedDoc(directSnap)].filter((p) => postVisible(p));
            }
        }

        // 2) entryId_uid / daily_date_uid 등
        if (pid.endsWith(`_${uid}`)) {
            const rest = pid.slice(0, -(uid.length + 1));
            if (rest.startsWith('daily_')) {
                const date = rest.slice(6);
                if (date) {
                    try {
                        const q = query(
                            sharedColl,
                            where('userId', '==', uid),
                            where('type', '==', 'daily'),
                            where('date', '==', date),
                            limit(20)
                        );
                        let snap;
                        try {
                            snap = await getDocsFromServer(q);
                        } catch (_) {
                            snap = await getDocs(q);
                        }
                        const photos = snap.docs.map(normalizeSharedDoc).filter((p) => postVisible(p));
                        if (photos.length) return photos;
                    } catch (_) {
                        /* 인덱스 없으면 아래 스캔으로 */
                    }
                }
            } else if (!rest.startsWith('best_') && !rest.startsWith('insight_') && !rest.startsWith('slot_')) {
                const entryId = rest;
                if (entryId) {
                    const q = query(sharedColl, where('userId', '==', uid), where('entryId', '==', entryId), limit(30));
                    let snap;
                    try {
                        snap = await getDocsFromServer(q);
                    } catch (_) {
                        snap = await getDocs(q);
                    }
                    const photos = snap.docs.map(normalizeSharedDoc).filter((p) => postVisible(p));
                    if (photos.length) return photos;
                }
            }
        }

        // 3) 내 공유 목록을 최신순 배치로 읽어 후보 키 매칭 (피드 페이지에 없어도 찾음)
        let accumulated = [];
        let lastSnap = null;
        for (let i = 0; i < 50; i++) {
            const { docs, lastDocSnap, hasMore } = await loadSharedPhotosByUserPage(uid, lastSnap);
            if (!docs?.length) break;
            const seen = new Set(accumulated.map((d) => d.id));
            for (const d of docs) {
                if (!seen.has(d.id)) {
                    seen.add(d.id);
                    accumulated.push(d);
                }
            }
            const matched = findMatchingGroupPhotos(accumulated, pid);
            if (matched.length) return matched;
            lastSnap = lastDocSnap;
            if (!hasMore) break;
        }
    } catch (e) {
        console.warn('loadSharedPhotosForMomentNotification 실패:', e?.message || e);
    }
    return [];
}

/** 모먼트 알림 대상이 아직 공유 중인지 */
export async function isMomentNotificationTargetAvailable(postId, ownerUid) {
    const photos = await loadSharedPhotosForMomentNotification(postId, ownerUid);
    return photos.length > 0;
}

export async function isNotificationTargetAvailable(type, postId, ownerUid) {
    if (type === 'feed') return isFeedNotificationTargetAvailable(postId);
    if (type === 'board') return isBoardNotificationTargetAvailable(postId);
    if (type === 'moment') return isMomentNotificationTargetAvailable(postId, ownerUid);
    return false;
}
