// 데이터베이스 작업
import { db, appId } from './firebase.js';
import { doc, setDoc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from './ui.js';
import { DEFAULT_SUB_TAGS } from './constants.js';

export const dbOps = {
    async save(record) {
        if (!window.currentUser) throw new Error("로그인이 필요합니다.");
        try {
            const dataToSave = { ...record };
            const docId = dataToSave.id;
            delete dataToSave.id;
            const coll = collection(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals');
            if (docId) {
                await setDoc(doc(coll, docId), dataToSave);
                showToast("기록이 수정되었습니다.", 'success');
            } else {
                await addDoc(coll, dataToSave);
                showToast("식사가 기록되었습니다.", 'success');
            }
        } catch (e) {
            console.error("Save Error:", e);
            throw e;
        }
    },
    async delete(id) {
        if (!window.currentUser || !id) return;
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', id));
            showToast("기록이 삭제되었습니다.", 'success');
        } catch (e) {
            console.error("Delete Error:", e);
            showToast("삭제 실패: " + e.message, 'error');
        }
    },
    async saveSettings(newSettings) {
        if (!window.currentUser) return;
        try {
            await setDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'config', 'settings'), newSettings, { merge: true });
        } catch (e) {
            console.error("Settings Save Error:", e);
        }
    },
    async sharePhotos(photos, mealData) {
        if (!window.currentUser || !photos || photos.length === 0) return;
        try {
            const userProfile = window.userSettings.profile || {};
            const sharedPhotos = photos.map((photoUrl, idx) => ({
                photoUrl,
                userId: window.currentUser.uid,
                userNickname: userProfile.nickname || '익명',
                userIcon: userProfile.icon || '🐻',
                mealType: mealData.mealType || '',
                place: mealData.place || '',
                menuDetail: mealData.menuDetail || '',
                snackType: mealData.snackType || '',
                date: mealData.date || '',
                slotId: mealData.slotId || '',
                time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                timestamp: new Date().toISOString(),
                entryId: mealData.id || null
            }));
            
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            for (const sharedPhoto of sharedPhotos) {
                await addDoc(sharedColl, sharedPhoto);
            }
        } catch (e) {
            console.error("Share Photos Error:", e);
            throw e;
        }
    },
    async unsharePhotos(photos, entryId) {
        if (!window.currentUser || !photos || photos.length === 0) return;
        try {
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            
            // entryId가 있으면 entryId로 필터링, 없으면 userId와 photoUrl로만 필터링
            let q;
            if (entryId) {
                q = query(
                    sharedColl,
                    where('userId', '==', window.currentUser.uid),
                    where('entryId', '==', entryId)
                );
            } else {
                // entryId가 null인 경우 userId와 photoUrl로만 필터링
                q = query(
                    sharedColl,
                    where('userId', '==', window.currentUser.uid)
                );
            }
            
            const snapshot = await getDocs(q);
            const photosToDelete = [];
            
            console.log('unsharePhotos 호출:', { photos, entryId, snapshotSize: snapshot.size });
            
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                // 공유 해제하려는 사진 목록에 있는 경우 삭제
                // entryId가 null인 경우 entryId도 null이어야 함
                if (photos.includes(data.photoUrl)) {
                    if (!entryId || data.entryId === entryId) {
                        photosToDelete.push(docSnap.id);
                        console.log('삭제할 사진 발견:', data.photoUrl, 'docId:', docSnap.id, 'entryId:', data.entryId);
                    }
                }
            });
            
            console.log('삭제할 사진 개수:', photosToDelete.length);
            
            // 공유 해제하려는 사진들을 삭제
            for (const docId of photosToDelete) {
                await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', docId));
                console.log('피드에서 사진 삭제 완료:', docId);
            }
        } catch (e) {
            console.error("Unshare Photos Error:", e);
            throw e;
        }
    }
};

export function setupListeners(userId, callbacks) {
    const { onSettingsUpdate, onDataUpdate, settingsUnsubscribe: oldSettingsUnsubscribe, dataUnsubscribe: oldDataUnsubscribe } = callbacks;
    
    // Settings 리스너
    if (oldSettingsUnsubscribe) oldSettingsUnsubscribe();
    const settingsUnsubscribe = onSnapshot(doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings'), (snap) => {
        if (snap.exists()) {
            window.userSettings = snap.data();
            if (!window.userSettings.subTags) {
                window.userSettings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));
            }
            // mealType에 "???"가 없으면 추가 (기존 사용자 호환성)
            if (window.userSettings.tags && window.userSettings.tags.mealType && !window.userSettings.tags.mealType.includes('???')) {
                // Skip 다음에 "???" 추가
                const skipIndex = window.userSettings.tags.mealType.indexOf('Skip');
                if (skipIndex >= 0) {
                    window.userSettings.tags.mealType.splice(skipIndex + 1, 0, '???');
                } else {
                    window.userSettings.tags.mealType.unshift('???');
                }
                // 자동으로 설정 저장
                dbOps.saveSettings(window.userSettings);
            }
        } else {
            // 설정이 없으면 기본값 사용 (이미 state.js에서 초기화됨)
            // 하지만 여기서도 확인하여 "???"가 있는지 확인
            if (window.userSettings && window.userSettings.tags && window.userSettings.tags.mealType && !window.userSettings.tags.mealType.includes('???')) {
                const skipIndex = window.userSettings.tags.mealType.indexOf('Skip');
                if (skipIndex >= 0) {
                    window.userSettings.tags.mealType.splice(skipIndex + 1, 0, '???');
                } else {
                    window.userSettings.tags.mealType.unshift('???');
                }
            }
        }
        if (onSettingsUpdate) onSettingsUpdate();
    });
    
    // Meals 리스너
    if (oldDataUnsubscribe) oldDataUnsubscribe();
    const dataUnsubscribe = onSnapshot(collection(db, 'artifacts', appId, 'users', userId, 'meals'), (snap) => {
        window.mealHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        if (onDataUpdate) onDataUpdate();
    });
    
    return { settingsUnsubscribe, dataUnsubscribe };
}

export function setupSharedPhotosListener(callback) {
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const q = query(sharedColl, orderBy('timestamp', 'desc'), limit(100));
    
    const unsubscribe = onSnapshot(q, (snap) => {
        const sharedPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (callback) callback(sharedPhotos);
    }, (error) => {
        console.error("Shared Photos Listener Error:", error);
    });
    
    return unsubscribe;
}

