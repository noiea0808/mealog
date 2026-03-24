/**
 * 콘솔/디버그용: 기록 → 모먼트 동기화, sharedPhotos 진단 (window.syncEntryToMoment 등)
 */
import { db, appId } from '../firebase.js';
import { appState } from '../state.js';
import { dbOps, loadSharedPhotosPage, loadMyShares } from '../db.js';
import { showToast } from '../ui.js';
import {
    doc,
    getDoc,
    collection,
    query,
    where,
    limit,
    getDocsFromServer
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { updateTimelineShareIndicators, renderGallery, renderFeed } from '../render/index.js';

export function registerMomentSyncDevTools() {
    window.syncEntryToMoment = async function(entryId, opts = {}) {
        const { batch = false } = opts;
        if (!entryId || !window.currentUser || window.currentUser.isAnonymous) {
            console.warn('syncEntryToMoment: entryId와 로그인이 필요합니다.');
            return false;
        }
        try {
            const mealRef = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', entryId);
            const mealSnap = await getDoc(mealRef);
            if (!mealSnap.exists()) {
                console.warn('syncEntryToMoment: 게시물을 찾을 수 없습니다.', entryId);
                return false;
            }
            const m = { id: mealSnap.id, ...mealSnap.data() };
            if (!m.sharedPhotos || !Array.isArray(m.sharedPhotos) || m.sharedPhotos.length === 0 || m.shareBanned) {
                console.warn('syncEntryToMoment: 공유할 사진이 없거나 공유 금지된 게시물입니다.');
                return false;
            }
            const validUrls = (url) => typeof url === 'string' && url && !url.startsWith('data:image');
            const urls = m.sharedPhotos.filter(validUrls);
            if (urls.length === 0) return false;
            await dbOps.sharePhotos(urls, m);
            if (!window.sharedPhotos) window.sharedPhotos = [];
            const newEntries = urls.map(url => ({ entryId: m.id, photoUrl: url, userId: window.currentUser?.uid }));
            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== m.id).concat(newEntries);
            updateTimelineShareIndicators();
            if (!batch) {
                const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
                window.sharedPhotosFeed = docs;
                appState.sharedPhotosFeedLastDoc = lastDoc;
                appState.sharedPhotosFeedHasMore = hasMore;
                if (appState.currentTab === 'gallery') renderGallery();
                if (document.getElementById('feedContent')) renderFeed();
                showToast('모먼트에 반영되었습니다.', 'success');
            }
            console.log('syncEntryToMoment 완료:', entryId);
            return true;
        } catch (e) {
            console.error('syncEntryToMoment 실패:', entryId, e);
            if (!batch) showToast('모먼트 동기화에 실패했습니다.', 'error');
            return false;
        }
    };

    window.syncEntriesToMomentBatch = async function(entryIds) {
        if (!Array.isArray(entryIds) || entryIds.length === 0) return { ok: 0, fail: 0 };
        let ok = 0; let fail = 0;
        for (const id of entryIds) {
            try {
                const r = await window.syncEntryToMoment(id, { batch: true });
                if (r) ok++; else fail++;
            } catch (_) { fail++; }
        }
        if (ok > 0) {
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
            window.sharedPhotosFeed = docs;
            appState.sharedPhotosFeedLastDoc = lastDoc;
            appState.sharedPhotosFeedHasMore = hasMore;
            if (appState.currentTab === 'gallery') renderGallery();
            if (document.getElementById('feedContent')) renderFeed();
            showToast(`${ok}건 모먼트에 반영되었습니다.${fail > 0 ? ` (${fail}건 실패)` : ''}`, ok === entryIds.length ? 'success' : 'info');
        } else if (fail > 0) {
            showToast('모먼트 동기화에 실패했습니다.', 'error');
        }
        return { ok, fail };
    };

    window.debugSharedPhotos = async function(entryId) {
        const path = `artifacts/${appId}/sharedPhotos`;
        console.log('📂 컬렉션 경로:', path);
        try {
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            const q = query(sharedColl, limit(5));
            const snap = await getDocsFromServer(q);
            const samples = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            console.log('📷 sharedPhotos 샘플(최대 5건):', samples);
            let entryIdResult = null;
            if (entryId) {
                const q2 = query(sharedColl, where('entryId', '==', entryId));
                const snap2 = await getDocsFromServer(q2);
                entryIdResult = { count: snap2.size, docs: snap2.docs.map(d => d.data()) };
                console.log(`entryId "${entryId}" 문서 수:`, snap2.size, entryIdResult.docs);
            }
            return { path, samples, entryIdCheck: entryIdResult };
        } catch (e) {
            console.error('debugSharedPhotos 실패:', e);
            throw e;
        }
    };

    window.Mealog = window.Mealog || {};
    window.Mealog.syncEntryToMoment = window.syncEntryToMoment;
    window.Mealog.syncEntriesToMomentBatch = window.syncEntriesToMomentBatch;
    window.Mealog.debugSharedPhotos = window.debugSharedPhotos;
    window.Mealog.loadMyShares = loadMyShares;
    window.Mealog.loadSharedPhotosPage = loadSharedPhotosPage;
}
