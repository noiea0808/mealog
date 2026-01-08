// 데이터베이스 작업
import { db, appId } from './firebase.js';
import { doc, setDoc, collection, addDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from './ui.js';
import { DEFAULT_SUB_TAGS } from './constants.js';
import { uploadBase64ToStorage } from './utils.js';

export const dbOps = {
    async save(record, silent = false) {
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
                if (!silent) {
                    showToast("기록이 수정되었습니다.", 'success');
                }
            } else {
                await addDoc(coll, dataToSave);
                if (!silent) {
                    showToast("식사가 기록되었습니다.", 'success');
                }
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
        if (!window.currentUser) {
            const error = new Error("로그인이 필요합니다.");
            throw error;
        }
        if (!id) {
            const error = new Error("삭제할 항목이 없습니다.");
            throw error;
        }
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', id));
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

    async saveDailyComment(date, comment) {
        if (!window.currentUser) {
            showToast("저장 실패: 로그인이 필요합니다.", 'error');
            return;
        }
        try {
            // 사용자 설정에 dailyComments 필드가 없으면 초기화
            if (!window.userSettings.dailyComments) {
                window.userSettings.dailyComments = {};
            }
            
            // 날짜별 Comment 저장
            if (comment && comment.trim()) {
                window.userSettings.dailyComments[date] = comment.trim();
            } else {
                // 빈 Comment는 삭제
                delete window.userSettings.dailyComments[date];
            }
            
            // 설정 저장
            await dbOps.saveSettings(window.userSettings);
        } catch (e) {
            console.error("Daily Comment Save Error:", e);
            throw e;
        }
    },
    getDailyComment(date) {
        if (!window.userSettings || !window.userSettings.dailyComments) {
            return '';
        }
        return window.userSettings.dailyComments[date] || '';
    },
    
    async sharePhotos(photos, mealData) {
        if (!window.currentUser || !photos || photos.length === 0) return;
        try {
            const userProfile = window.userSettings.profile || {};
            
            // 중복 체크: 같은 entryId와 photoUrl 조합이 이미 있는지 확인
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            
            // entryId가 null인 경우 쿼리 방식 변경 (Firestore에서 null 비교는 인덱스 필요)
            let allExistingDocs = [];
            if (mealData.id) {
                // entryId가 있는 경우: entryId로 필터링
                const existingQuery = query(
                    sharedColl,
                    where('userId', '==', window.currentUser.uid),
                    where('entryId', '==', mealData.id)
                );
                const existingSnapshot = await getDocs(existingQuery);
                allExistingDocs = existingSnapshot.docs;
            } else {
                // entryId가 null인 경우: userId로만 필터링 후 메모리에서 entryId null인 것만 필터링
                try {
                    const existingQuery = query(
                        sharedColl,
                        where('userId', '==', window.currentUser.uid)
                    );
                    const allUserPhotos = await getDocs(existingQuery);
                    // entryId가 null이거나 없는 항목만 필터링
                    allExistingDocs = allUserPhotos.docs.filter(doc => {
                        const data = doc.data();
                        return !data.entryId || data.entryId === null;
                    });
                } catch (e) {
                    console.warn('entryId null인 사진 중복 체크 중 오류 (무시하고 계속 진행):', e);
                    allExistingDocs = [];
                }
            }
            
            const existingPhotoUrls = new Set();
            allExistingDocs.forEach((docSnap) => {
                const data = docSnap.data();
                // URL에서 쿼리 파라미터 제거하여 비교
                const urlBase = (data.photoUrl || '').split('?')[0];
                existingPhotoUrls.add(urlBase);
            });
            
            // 중복이 아닌 사진만 필터링
            const newPhotos = photos.filter(photoUrl => {
                const urlBase = (photoUrl || '').split('?')[0];
                return !existingPhotoUrls.has(urlBase);
            });
            
            if (newPhotos.length === 0) {
                console.log('중복 체크: 모든 사진이 이미 공유되어 있습니다.');
                return;
            }
            
            const sharedPhotos = newPhotos.map((photoUrl, idx) => ({
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
            
            // 배치 쓰기 사용: 여러 사진을 한 번에 쓰기 (1번으로 카운트)
            // Firestore 배치는 최대 500개 작업을 한 번에 처리 가능
            const batch = writeBatch(db);
            sharedPhotos.forEach(sharedPhoto => {
                const docRef = doc(sharedColl);
                batch.set(docRef, sharedPhoto);
            });
            await batch.commit();
            
            console.log(`배치 쓰기로 ${sharedPhotos.length}개 사진 공유 완료 (중복 ${photos.length - newPhotos.length}개 제외)`);
        } catch (e) {
            console.error("Share Photos Error:", e);
            // 에러 토스트는 호출자에서 표시하도록 하고, 여기서는 throw만 함
            // (중복 토스트 방지)
            throw e;
        }
    },
    async unsharePhotos(photos, entryId, isBestShare = false) {
        if (!window.currentUser || !photos || photos.length === 0) return;
        try {
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            
            // 모든 공유 사진 가져오기 (userId로 필터링)
            const q = query(
                sharedColl,
                where('userId', '==', window.currentUser.uid)
            );
            
            const snapshot = await getDocs(q);
            const photosToDelete = [];
            
            console.log('unsharePhotos 호출:', { photos, entryId, isBestShare, snapshotSize: snapshot.size });
            
            // 디버깅: 모든 사진 URL과 entryId 확인
            const allPhotoUrls = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                allPhotoUrls.push({
                    photoUrl: data.photoUrl,
                    entryId: data.entryId,
                    type: data.type,
                    docId: docSnap.id
                });
            });
            console.log('현재 공유된 모든 사진:', allPhotoUrls);
            console.log('삭제하려는 사진 URL:', photos);
            
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                // 공유 해제하려는 사진 목록에 있는 경우 삭제
                // photoUrl이 정확히 일치하거나, URL의 파일명 부분이 일치하는지 확인
                const photoUrlMatch = photos.some(photoUrl => {
                    // 정확히 일치하는 경우
                    if (photoUrl === data.photoUrl) return true;
                    // URL에서 파일명 부분만 추출하여 비교 (쿼리 파라미터 제거)
                    const photoUrlBase = photoUrl.split('?')[0];
                    const dataUrlBase = data.photoUrl.split('?')[0];
                    if (photoUrlBase === dataUrlBase) return true;
                    // 파일명만 추출하여 비교
                    const photoFileName = photoUrlBase.split('/').pop();
                    const dataFileName = dataUrlBase.split('/').pop();
                    return photoFileName === dataFileName && photoFileName !== '';
                });
                
                console.log('사진 URL 매칭 확인:', {
                    찾는URL: photos,
                    현재URL: data.photoUrl,
                    매칭: photoUrlMatch,
                    entryId: data.entryId,
                    찾는entryId: entryId,
                    type: data.type,
                    isBestShare: isBestShare
                });
                
                if (photoUrlMatch) {
                    // 베스트 공유인 경우 type='best'인 항목만 삭제
                    if (isBestShare) {
                        if (data.type === 'best') {
                            photosToDelete.push(docSnap.id);
                            console.log('삭제할 베스트 공유 사진 발견:', data.photoUrl, 'docId:', docSnap.id);
                        } else {
                            console.log('베스트 공유가 아님, 건너뜀:', data.type);
                        }
                    } else {
                        // 일반 공유인 경우: photoUrl이 일치하면 삭제
                        // entryId가 제공된 경우에는 entryId도 일치해야 하지만, 
                        // entryId가 없거나 null인 경우에도 photoUrl만 일치하면 삭제
                        let shouldDelete = false;
                        
                        if (entryId) {
                            // entryId가 제공된 경우: entryId가 일치하거나 현재 사진의 entryId가 null/없으면 삭제
                            if (data.entryId === entryId || !data.entryId || data.entryId === null) {
                                shouldDelete = true;
                            }
                        } else {
                            // entryId가 제공되지 않은 경우: photoUrl만 일치하면 삭제 (entryId 유무와 관계없이)
                            shouldDelete = true;
                        }
                        
                        if (shouldDelete) {
                            photosToDelete.push(docSnap.id);
                            console.log('삭제할 사진 발견:', {
                                photoUrl: data.photoUrl,
                                docId: docSnap.id,
                                entryId: data.entryId,
                                찾는entryId: entryId
                            });
                        } else {
                            console.log('삭제 조건 불일치:', { 
                                찾는entryId: entryId, 
                                현재entryId: data.entryId 
                            });
                        }
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
            if (!window.userSettings.favoriteSubTags) {
                window.userSettings.favoriteSubTags = {
                    mealType: {},
                    category: {},
                    withWhom: {},
                    snackType: {}
                };
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
            // 간식 항목 마이그레이션: 새로운 항목으로 업데이트
            const newSnackTypes = ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
            const oldSnackTypes = ['커피', '음료', '과일', '빵/과자'];
            
            // tags가 없으면 생성
            if (!window.userSettings.tags) {
                window.userSettings.tags = {};
            }
            
            const currentSnackTypes = window.userSettings.tags.snackType || [];
            
            // 새로운 항목과 정확히 일치하는지 확인
            const isExactMatch = currentSnackTypes.length === newSnackTypes.length &&
                currentSnackTypes.every((tag, idx) => tag === newSnackTypes[idx]);
            
            if (!isExactMatch) {
                // 정확히 일치하지 않으면 무조건 업데이트
                console.log('간식 항목 마이그레이션: 새로운 항목으로 업데이트', {
                    before: currentSnackTypes,
                    after: newSnackTypes
                });
                window.userSettings.tags.snackType = [...newSnackTypes];
                // 변경사항 저장
                dbOps.saveSettings(window.userSettings).then(() => {
                    console.log('간식 항목 마이그레이션 저장 완료');
                }).catch(e => {
                    console.error('간식 항목 마이그레이션 저장 실패:', e);
                });
            }
            
            // 함께한 사람 태그 마이그레이션: 새로운 항목으로 업데이트
            const newWithWhomTags = ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'];
            const currentWithWhomTags = window.userSettings.tags.withWhom || [];
            
            // 새로운 항목과 정확히 일치하는지 확인
            const isWithWhomExactMatch = currentWithWhomTags.length === newWithWhomTags.length &&
                currentWithWhomTags.every((tag, idx) => tag === newWithWhomTags[idx]);
            
            if (!isWithWhomExactMatch) {
                // 기존 '회사사람'을 '직장동료'로 변환
                let updatedTags = [...currentWithWhomTags];
                const hasOldTag = updatedTags.includes('회사사람');
                
                if (hasOldTag) {
                    const oldIndex = updatedTags.indexOf('회사사람');
                    updatedTags[oldIndex] = '직장동료';
                }
                
                // 새로운 태그가 없으면 추가
                newWithWhomTags.forEach(newTag => {
                    if (!updatedTags.includes(newTag)) {
                        updatedTags.push(newTag);
                    }
                });
                
                // 순서 정렬 (newWithWhomTags 순서대로)
                updatedTags = newWithWhomTags.filter(tag => updatedTags.includes(tag));
                
                console.log('함께한 사람 태그 마이그레이션: 새로운 항목으로 업데이트', {
                    before: currentWithWhomTags,
                    after: updatedTags
                });
                window.userSettings.tags.withWhom = updatedTags;
                
                // 서브 태그도 업데이트: '회사사람' parent를 '직장동료'로 변경
                if (window.userSettings.subTags && window.userSettings.subTags.people) {
                    let hasSubTagUpdate = false;
                    window.userSettings.subTags.people = window.userSettings.subTags.people.map(subTag => {
                        if (subTag.parent === '회사사람') {
                            hasSubTagUpdate = true;
                            return { ...subTag, parent: '직장동료' };
                        }
                        return subTag;
                    });
                    
                    if (hasSubTagUpdate) {
                        console.log('함께한 사람 서브 태그 마이그레이션: 회사사람 -> 직장동료');
                    }
                }
                
                // 변경사항 저장
                dbOps.saveSettings(window.userSettings).then(() => {
                    console.log('함께한 사람 태그 마이그레이션 저장 완료');
                }).catch(e => {
                    console.error('함께한 사람 태그 마이그레이션 저장 실패:', e);
                });
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

// base64 이미지를 Firebase Storage로 마이그레이션
export async function migrateBase64ImagesToStorage() {
    if (!window.currentUser) {
        showToast("마이그레이션 실패: 로그인이 필요합니다.", 'error');
        throw new Error("로그인이 필요합니다.");
    }
    
    try {
        showToast("마이그레이션을 시작합니다...", 'info');
        
        const userId = window.currentUser.uid;
        const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
        
        // 모든 meal 기록 가져오기
        const snapshot = await getDocs(mealsColl);
        const meals = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        
        console.log(`총 ${meals.length}개의 기록을 확인합니다.`);
        
        let migratedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        
        // 각 기록을 순회하며 base64 이미지 찾기
        for (let i = 0; i < meals.length; i++) {
            const meal = meals[i];
            const mealId = meal.id;
            
            if (!meal.photos || !Array.isArray(meal.photos) || meal.photos.length === 0) {
                skippedCount++;
                continue;
            }
            
            // base64 이미지가 있는지 확인
            const base64Photos = meal.photos.filter(photo => 
                typeof photo === 'string' && photo.startsWith('data:image')
            );
            
            if (base64Photos.length === 0) {
                skippedCount++;
                continue;
            }
            
            console.log(`[${i + 1}/${meals.length}] 기록 ${mealId}의 ${base64Photos.length}개 base64 이미지 마이그레이션 중...`);
            
            try {
                // base64 이미지를 Storage에 업로드
                const uploadPromises = base64Photos.map(base64Photo => 
                    uploadBase64ToStorage(base64Photo, userId, mealId)
                );
                
                const uploadedUrls = await Promise.all(uploadPromises);
                
                // 기존 URL 이미지와 새로 업로드한 URL 합치기
                const existingUrls = meal.photos.filter(photo => 
                    typeof photo === 'string' && (photo.startsWith('http://') || photo.startsWith('https://'))
                );
                
                const newPhotos = [...existingUrls, ...uploadedUrls];
                
                // Firestore 업데이트
                const mealRef = doc(mealsColl, mealId);
                await setDoc(mealRef, { ...meal, photos: newPhotos }, { merge: true });
                
                migratedCount++;
                console.log(`✓ 기록 ${mealId} 마이그레이션 완료`);
                
                // 진행 상황 표시 (10개마다)
                if ((i + 1) % 10 === 0) {
                    showToast(`마이그레이션 진행 중... ${i + 1}/${meals.length}`, 'info');
                }
                
            } catch (error) {
                console.error(`기록 ${mealId} 마이그레이션 실패:`, error);
                errorCount++;
                // 개별 실패는 건너뛰고 계속 진행
            }
        }
        
        const message = `마이그레이션 완료! 성공: ${migratedCount}개, 건너뜀: ${skippedCount}개, 실패: ${errorCount}개`;
        console.log(message);
        showToast(message, 'success');
        
        return {
            total: meals.length,
            migrated: migratedCount,
            skipped: skippedCount,
            errors: errorCount
        };
        
    } catch (error) {
        console.error("마이그레이션 오류:", error);
        showToast("마이그레이션 실패: " + error.message, 'error');
        throw error;
    }
}
