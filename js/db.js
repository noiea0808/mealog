// 데이터베이스 작업
import { db, appId } from './firebase.js';
import { doc, setDoc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from './ui.js';
import { DEFAULT_SUB_TAGS } from './constants.js';

export const dbOps = {
    async save(record) {
        if (!window.currentUser) {
            const error = new Error("로그인이 필요합니다.");
            showToast("저장 실패: 로그인이 필요합니다.", 'error');
            throw error;
        }
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
            // 에러 메시지 생성
            let errorMessage = "저장 실패: ";
            if (e.code === 'permission-denied') {
                errorMessage += "권한이 없습니다.";
            } else if (e.code === 'unavailable') {
                errorMessage += "네트워크 연결을 확인해주세요.";
            } else if (e.message && e.message.includes('Quota exceeded')) {
                errorMessage = "Firebase 할당량이 초과되었습니다.";
            } else if (e.message) {
                errorMessage += e.message;
            } else {
                errorMessage += "알 수 없는 오류가 발생했습니다.";
            }
            showToast(errorMessage, 'error');
            throw e;
        }
    },
    async delete(id) {
        console.log('dbOps.delete 호출:', { id, currentUser: window.currentUser });
        if (!window.currentUser) {
            const error = new Error("로그인이 필요합니다.");
            console.error('삭제 실패: 로그인 필요', { id, currentUser: window.currentUser });
            throw error;
        }
        if (!id) {
            const error = new Error("삭제할 항목이 없습니다.");
            console.error('삭제 실패: ID 없음', { id, currentUser: window.currentUser });
            throw error;
        }
        try {
            console.log('Firestore 삭제 시도:', { id, uid: window.currentUser.uid });
            await deleteDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', id));
            console.log('Firestore 삭제 성공:', { id });
            // 성공 토스트는 호출자에서 표시
        } catch (e) {
            console.error("Delete Error:", e);
            // 에러만 throw하고 토스트는 호출자에서 표시
            throw e;
        }
    },
    async saveSettings(newSettings) {
        if (!window.currentUser) {
            showToast("설정 저장 실패: 로그인이 필요합니다.", 'error');
            return;
        }
        try {
            await setDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'config', 'settings'), newSettings, { merge: true });
        } catch (e) {
            console.error("Settings Save Error:", e);
            let errorMessage = "설정 저장 실패: ";
            if (e.code === 'permission-denied') {
                errorMessage += "권한이 없습니다.";
            } else if (e.code === 'unavailable') {
                errorMessage += "네트워크 연결을 확인해주세요.";
            } else if (e.message && e.message.includes('Quota exceeded')) {
                errorMessage = "Firebase 할당량이 초과되었습니다.";
            } else if (e.message) {
                errorMessage += e.message;
            } else {
                errorMessage += "알 수 없는 오류가 발생했습니다.";
            }
            showToast(errorMessage, 'error');
            throw e;
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
            
            // 배치 쓰기 사용: 여러 사진을 한 번에 쓰기 (1번으로 카운트)
            // Firestore 배치는 최대 500개 작업을 한 번에 처리 가능
            const batch = writeBatch(db);
            sharedPhotos.forEach(sharedPhoto => {
                const docRef = doc(sharedColl);
                batch.set(docRef, sharedPhoto);
            });
            await batch.commit();
            
            console.log(`배치 쓰기로 ${sharedPhotos.length}개 사진 공유 완료`);
        } catch (e) {
            console.error("Share Photos Error:", e);
            let errorMessage = "사진 공유 실패: ";
            if (e.code === 'permission-denied') {
                errorMessage += "권한이 없습니다.";
            } else if (e.code === 'unavailable') {
                errorMessage += "네트워크 연결을 확인해주세요.";
            } else if (e.message && e.message.includes('Quota exceeded')) {
                errorMessage = "Firebase 할당량이 초과되었습니다.";
            } else if (e.message) {
                errorMessage += e.message;
            } else {
                errorMessage += "알 수 없는 오류가 발생했습니다.";
            }
            showToast(errorMessage, 'error');
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
            
            // 배치 삭제 사용: 여러 사진을 한 번에 삭제 (1번으로 카운트)
            if (photosToDelete.length > 0) {
                const batch = writeBatch(db);
                photosToDelete.forEach(docId => {
                    const docRef = doc(db, 'artifacts', appId, 'sharedPhotos', docId);
                    batch.delete(docRef);
                });
                await batch.commit();
                console.log(`배치 삭제로 ${photosToDelete.length}개 사진 공유 해제 완료`);
            }
        } catch (e) {
            console.error("Unshare Photos Error:", e);
            let errorMessage = "사진 공유 해제 실패: ";
            if (e.code === 'permission-denied') {
                errorMessage += "권한이 없습니다.";
            } else if (e.code === 'unavailable') {
                errorMessage += "네트워크 연결을 확인해주세요.";
            } else if (e.message && e.message.includes('Quota exceeded')) {
                errorMessage = "Firebase 할당량이 초과되었습니다.";
            } else if (e.message) {
                errorMessage += e.message;
            } else {
                errorMessage += "알 수 없는 오류가 발생했습니다.";
            }
            showToast(errorMessage, 'error');
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
            // "???" 항목 제거 (기존 사용자 설정 정리)
            if (window.userSettings.tags && window.userSettings.tags.mealType) {
                const index = window.userSettings.tags.mealType.indexOf('???');
                if (index > -1) {
                    window.userSettings.tags.mealType.splice(index, 1);
                    // 변경사항 저장
                    dbOps.saveSettings(window.userSettings).catch(e => {
                        console.error('설정 정리 저장 실패:', e);
                    });
                }
            }
        }
        if (onSettingsUpdate) onSettingsUpdate();
    });
    
    // Meals 리스너 - 최근 1개월만 초기 로드
    if (oldDataUnsubscribe) oldDataUnsubscribe();
    
    // 최근 1개월 날짜 계산
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - 1);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    
    // 최근 1개월만 쿼리
    const mealsQuery = query(
        collection(db, 'artifacts', appId, 'users', userId, 'meals'),
        where('date', '>=', cutoffDateStr),
        orderBy('date', 'desc')
    );
    
    let isInitialLoad = true;
    const dataUnsubscribe = onSnapshot(mealsQuery, (snap) => {
        if (isInitialLoad) {
            // 초기 로드: 최근 1개월 데이터
            window.mealHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            window.loadedMealsDateRange = { start: cutoffDateStr, end: todayStr };
            isInitialLoad = false;
            console.log(`초기 로드: 최근 1개월 데이터 ${snap.docs.length}개 로드 완료`);
        } else {
            // 이후 변경사항: 변경된 문서만 처리
            const changes = snap.docChanges();
            let hasChanges = false;
            
            changes.forEach(change => {
                const docData = { id: change.doc.id, ...change.doc.data() };
                if (change.type === 'added' || change.type === 'modified') {
                    const index = window.mealHistory.findIndex(m => m.id === docData.id);
                    if (index >= 0) {
                        window.mealHistory[index] = docData;
                    } else {
                        // 새로 추가된 문서 (1개월 범위 내)
                        window.mealHistory.push(docData);
                    }
                    hasChanges = true;
                } else if (change.type === 'removed') {
                    window.mealHistory = window.mealHistory.filter(m => m.id !== docData.id);
                    hasChanges = true;
                }
            });
            
            if (hasChanges) {
                window.mealHistory.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
                console.log(`변경사항 반영: ${changes.length}개 문서 업데이트`);
            }
        }
        
        if (onDataUpdate) onDataUpdate();
    }, (error) => {
        console.error("Meals Listener Error:", error);
        // 인덱스가 없을 경우 fallback: 전체 컬렉션 사용 (경고만 표시)
        console.warn("날짜 범위 쿼리 실패, 전체 컬렉션으로 fallback");
        const fallbackQuery = collection(db, 'artifacts', appId, 'users', userId, 'meals');
        return onSnapshot(fallbackQuery, (snap) => {
            window.mealHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            if (onDataUpdate) onDataUpdate();
        });
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

// 더보기 함수: 추가 기간의 데이터 로드
export async function loadMoreMeals(monthsToLoad = 1) {
    if (!window.currentUser) {
        console.error("로그인이 필요합니다.");
        return 0;
    }
    
    try {
        const currentStart = window.loadedMealsDateRange?.start;
        if (!currentStart) {
            console.error("로드된 데이터 범위 정보가 없습니다.");
            return 0;
        }
        
        // 추가로 로드할 시작 날짜 계산
        const newStartDate = new Date(currentStart);
        newStartDate.setMonth(newStartDate.getMonth() - monthsToLoad);
        const newStartStr = newStartDate.toISOString().split('T')[0];
        
        console.log(`더보기: ${newStartStr} ~ ${currentStart} 기간 데이터 로드 시작`);
        
        const q = query(
            collection(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals'),
            where('date', '>=', newStartStr),
            where('date', '<', currentStart),
            orderBy('date', 'desc')
        );
        
        const snapshot = await getDocs(q);
        const additionalMeals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // 기존 데이터와 병합 (중복 제거)
        const existingIds = new Set(window.mealHistory.map(m => m.id));
        const newMeals = additionalMeals.filter(m => !existingIds.has(m.id));
        
        if (newMeals.length > 0) {
            window.mealHistory = [...window.mealHistory, ...newMeals]
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            
            // 로드된 범위 업데이트
            window.loadedMealsDateRange.start = newStartStr;
            
            console.log(`더보기 완료: ${newMeals.length}개 기록 추가`);
        } else {
            console.log("더보기: 추가할 기록이 없습니다.");
        }
        
        return newMeals.length;
    } catch (e) {
        console.error("Load More Meals Error:", e);
        // 인덱스 없을 경우 fallback 시도
        if (e.code === 'failed-precondition') {
            console.warn("날짜 범위 쿼리 인덱스가 없습니다. Firestore 콘솔에서 인덱스를 생성해주세요.");
        }
        throw e;
    }
}

// 특정 날짜 범위의 데이터 로드 (대시보드용)
export async function loadMealsForDateRange(startDate, endDate) {
    if (!window.currentUser) {
        console.error("로그인이 필요합니다.");
        return 0;
    }
    
    try {
        const startStr = typeof startDate === 'string' ? startDate : startDate.toISOString().split('T')[0];
        const endStr = typeof endDate === 'string' ? endDate : endDate.toISOString().split('T')[0];
        
        // 이미 로드된 범위 확인
        if (window.loadedMealsDateRange) {
            const loadedStart = new Date(window.loadedMealsDateRange.start);
            const loadedEnd = new Date(window.loadedMealsDateRange.end);
            const requestedStart = new Date(startStr);
            const requestedEnd = new Date(endStr);
            
            // 요청한 범위가 이미 로드된 범위에 포함되는지 확인
            if (requestedStart >= loadedStart && requestedEnd <= loadedEnd) {
                console.log("요청한 날짜 범위는 이미 로드되어 있습니다.");
                return 0;
            }
        }
        
        console.log(`날짜 범위 로드: ${startStr} ~ ${endStr}`);
        
        const q = query(
            collection(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals'),
            where('date', '>=', startStr),
            where('date', '<=', endStr),
            orderBy('date', 'desc')
        );
        
        const snapshot = await getDocs(q);
        const additionalMeals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // 기존 데이터와 병합 (중복 제거)
        const existingIds = new Set(window.mealHistory.map(m => m.id));
        const newMeals = additionalMeals.filter(m => !existingIds.has(m.id));
        
        if (newMeals.length > 0) {
            window.mealHistory = [...window.mealHistory, ...newMeals]
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            
            // 로드된 범위 업데이트
            if (!window.loadedMealsDateRange) {
                window.loadedMealsDateRange = { start: startStr, end: endStr };
            } else {
                const currentStart = new Date(window.loadedMealsDateRange.start);
                const currentEnd = new Date(window.loadedMealsDateRange.end);
                const newStart = new Date(startStr);
                const newEnd = new Date(endStr);
                
                window.loadedMealsDateRange.start = newStart < currentStart ? startStr : window.loadedMealsDateRange.start;
                window.loadedMealsDateRange.end = newEnd > currentEnd ? endStr : window.loadedMealsDateRange.end;
            }
            
            console.log(`날짜 범위 로드 완료: ${newMeals.length}개 기록 추가`);
        } else {
            console.log("날짜 범위 로드: 추가할 기록이 없습니다.");
        }
        
        return newMeals.length;
    } catch (e) {
        console.error("Load Meals For Date Range Error:", e);
        if (e.code === 'failed-precondition') {
            console.warn("날짜 범위 쿼리 인덱스가 없습니다. Firestore 콘솔에서 인덱스를 생성해주세요.");
        }
        throw e;
    }
}

