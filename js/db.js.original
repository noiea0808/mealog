// 데이터베이스 작업
import { db, appId, auth } from './firebase.js';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, onSnapshot, collection, addDoc, query, orderBy, limit, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from './ui.js';
import { DEFAULT_SUB_TAGS } from './constants.js';
import { uploadBase64ToStorage, toLocalDateString, logger } from './utils.js';

export const dbOps = {
    async save(record, silent = false) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            const error = new Error("로그인이 필요합니다.");
            showToast("저장 실패: 로그인이 필요합니다.", 'error');
            throw error;
        }
        try {
            const dataToSave = { ...record };
            const docId = dataToSave.id;
            delete dataToSave.id;
            const coll = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'meals');
            logger.log('식사 기록 저장 시도:', { userId: currentUser.uid, docId, dataToSave });
            if (docId) {
                await setDoc(doc(coll, docId), dataToSave);
                if (!silent) {
                    showToast("기록이 수정되었습니다.", 'success');
                }
                return docId; // 기존 ID 반환
            } else {
                const docRef = await addDoc(coll, dataToSave);
                logger.log('식사 기록 저장 성공:', docRef.id);
                if (!silent) {
                    showToast("식사가 기록되었습니다.", 'success');
                }
                return docRef.id; // 새로 생성된 ID 반환
            }
        } catch (e) {
            console.error("Save Error:", e);
            const currentUser = auth.currentUser || window.currentUser;
            console.error("저장 실패 상세:", { 
                userId: currentUser?.uid, 
                errorCode: e.code, 
                errorMessage: e.message 
            });
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
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            const error = new Error("로그인이 필요합니다.");
            throw error;
        }
        if (!id) {
            const error = new Error("삭제할 항목이 없습니다.");
            throw error;
        }
        try {
            await deleteDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'meals', id));
            // 성공 토스트는 호출자에서 표시
        } catch (e) {
            console.error("Delete Error:", e);
            // 에러만 throw하고 토스트는 호출자에서 표시
            throw e;
        }
    },
    async saveSettings(newSettings) {
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
            showToast("설정 저장 실패: 로그인이 필요합니다.", 'error');
            return;
        }
        try {
            // 기존 설정을 먼저 읽어서 profile 정보 보존
            let existingSettings = {};
            try {
                const existingDoc = await getDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'settings'));
                if (existingDoc.exists()) {
                    existingSettings = existingDoc.data();
                }
            } catch (e) {
                console.warn('기존 설정 읽기 실패 (무시하고 계속):', e);
            }
            
            // 새 설정과 기존 설정을 병합 (profile 정보 보존)
            const settingsToSave = { ...existingSettings, ...newSettings };
            
            // 프로필 정보 병합 (닉네임은 새 값이 있으면 업데이트, 없으면 기존 값 유지)
            if (newSettings.profile || existingSettings.profile) {
                // 닉네임을 제외한 프로필 정보 먼저 병합
                const { nickname: newNickname, ...newProfileWithoutNickname } = newSettings.profile || {};
                const { nickname: existingNickname, ...existingProfileWithoutNickname } = existingSettings.profile || {};
                
                settingsToSave.profile = {
                    ...existingProfileWithoutNickname,
                    ...newProfileWithoutNickname
                };
                
                // 닉네임 처리: 새 닉네임이 명시적으로 제공되고 유효하면 업데이트, 아니면 기존 값 유지
                // 단, 새 닉네임이 기본값('게스트')이고 기존 닉네임이 유효한 경우 기존 값 유지
                if (newNickname !== undefined && newNickname !== null && newNickname !== '' && newNickname !== '게스트') {
                    // 새 닉네임이 명시적으로 제공되고 기본값이 아닌 경우 업데이트
                    settingsToSave.profile.nickname = newNickname;
                    console.log('✅ 닉네임 업데이트:', { 
                        old: existingNickname, 
                        new: newNickname 
                    });
                } else if (existingNickname && existingNickname !== '게스트') {
                    // 기존 닉네임이 있고 기본값이 아니면 유지
                    settingsToSave.profile.nickname = existingNickname;
                } else if (existingNickname) {
                    // 기존 닉네임이 기본값이어도 일단 유지
                    settingsToSave.profile.nickname = existingNickname;
                } else if (!settingsToSave.profile.nickname) {
                    // 닉네임이 전혀 없을 때만 기본값 사용
                    settingsToSave.profile.nickname = '게스트';
                }
            } else if (!settingsToSave.profile) {
                // profile 자체가 없을 때만 기본값 설정
                settingsToSave.profile = { icon: '🐻', nickname: '게스트' };
            }
            
            // 중요: providerId와 email은 처음 로그인 시에만 설정되는 고정 항목입니다.
            // saveSettings에서는 기존 값만 보존하고, 절대 업데이트하지 않습니다.
            // providerId와 email은 약관 동의 또는 프로필 설정 시에만 설정됩니다.
            
            // 기존 설정에서 providerId와 email 보존 (새 설정에 포함되어 있지 않으면 기존 값 유지)
            if (existingSettings.providerId && !newSettings.providerId) {
                settingsToSave.providerId = existingSettings.providerId;
            }
            if (existingSettings.email && !newSettings.email) {
                settingsToSave.email = existingSettings.email;
            }
            
            const settingsPath = `artifacts/${appId}/users/${currentUser.uid}/config/settings`;
            console.log('💾 설정 저장 시도:', { 
                userId: currentUser.uid, 
                path: settingsPath,
                providerId: settingsToSave.providerId,
                email: settingsToSave.email,
                nickname: settingsToSave.profile?.nickname,
                hasProfile: !!settingsToSave.profile
            });
            await setDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'settings'), settingsToSave, { merge: true });
            console.log('✅ 설정 저장 성공:', {
                providerId: settingsToSave.providerId,
                email: settingsToSave.email,
                nickname: settingsToSave.profile?.nickname
            });
        } catch (e) {
            console.error("Settings Save Error:", e);
            const currentUser = auth.currentUser || window.currentUser;
            console.error("설정 저장 실패 상세:", { 
                userId: currentUser?.uid, 
                errorCode: e.code, 
                errorMessage: e.message 
            });
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
        const currentUser = auth.currentUser || window.currentUser;
        if (!currentUser || currentUser.isAnonymous) {
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
    
    async sharePhotos(photosToShare, mealData) {
        if (!window.currentUser) return;
        
        // 공유 금지 체크
        if (mealData && mealData.shareBanned === true) {
            showToast("이 게시물은 공유가 금지되어 있습니다.", 'error');
            throw new Error("공유 금지된 게시물입니다.");
        }
        
        // photosToShare가 빈 배열이면 공유 해제 (기존 문서만 삭제)
        // photosToShare가 있으면 공유 설정 (기존 문서 삭제 + 새 문서 추가)
        
        try {
            const userProfile = window.userSettings.profile || {};
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            const batch = writeBatch(db);
            
            // entryId가 있는 경우: 같은 entryId의 기존 문서를 모두 삭제
            if (mealData.id) {
                try {
                    const existingQuery = query(
                        sharedColl,
                        where('userId', '==', window.currentUser.uid),
                        where('entryId', '==', mealData.id)
                    );
                    const existingSnapshot = await getDocs(existingQuery);
                    existingSnapshot.docs.forEach(docSnap => {
                        batch.delete(docSnap.ref);
                    });
                    if (existingSnapshot.docs.length > 0) {
                        console.log(`기존 ${existingSnapshot.docs.length}개 문서 삭제 (entryId: ${mealData.id})`);
                    }
                } catch (e) {
                    console.warn('기존 문서 삭제 중 오류 (무시하고 계속 진행):', e);
                }
            } else {
                // entryId가 null인 경우: userId로만 필터링 후 메모리에서 entryId null인 것만 삭제
                try {
                    const existingQuery = query(
                        sharedColl,
                        where('userId', '==', window.currentUser.uid)
                    );
                    const allUserPhotos = await getDocs(existingQuery);
                    const docsToDelete = allUserPhotos.docs.filter(docSnap => {
                        const data = docSnap.data();
                        return !data.entryId || data.entryId === null;
                    });
                    docsToDelete.forEach(docSnap => {
                        batch.delete(docSnap.ref);
                    });
                    if (docsToDelete.length > 0) {
                        console.log(`기존 ${docsToDelete.length}개 문서 삭제 (entryId: null)`);
                    }
                } catch (e) {
                    console.warn('entryId null인 기존 문서 삭제 중 오류 (무시하고 계속 진행):', e);
                }
            }
            
            // 새로운 사진들을 추가 (photosToShare가 빈 배열이면 추가 안 함 = 공유 해제)
            if (photosToShare && photosToShare.length > 0) {
                photosToShare.forEach(photoUrl => {
                    const docRef = doc(sharedColl);
                    batch.set(docRef, {
                        photoUrl,
                        userId: window.currentUser.uid,
                        userNickname: userProfile.nickname || '익명',
                        userIcon: userProfile.icon || '🐻',
                        userPhotoUrl: userProfile.photoUrl || null,
                        mealType: mealData.mealType || '',
                        place: mealData.place || '',
                        menuDetail: mealData.menuDetail || '',
                        snackType: mealData.snackType || '',
                        date: mealData.date || '',
                        slotId: mealData.slotId || '',
                        time: mealData.time || new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }),
                        timestamp: new Date().toISOString(),
                        entryId: mealData.id || null
                    });
                });
            }
            
            await batch.commit();
            
            // record.sharedPhotos 필드 업데이트 (mealData.id가 있는 경우에만)
            if (mealData.id) {
                try {
                    const mealDoc = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', mealData.id);
                    await setDoc(mealDoc, { sharedPhotos: photosToShare || [] }, { merge: true });
                } catch (e) {
                    console.warn('record.sharedPhotos 필드 업데이트 실패 (무시하고 계속 진행):', e);
                }
            }
            
            const action = photosToShare && photosToShare.length > 0 ? '공유' : '공유 해제';
            console.log(`${action} 완료 (entryId: ${mealData.id || 'null'}, 사진 수: ${photosToShare?.length || 0})`);
        } catch (e) {
            console.error("Share Photos Error:", e);
            // 에러 토스트는 호출자에서 표시하도록 하고, 여기서는 throw만 함
            // (중복 토스트 방지)
            throw e;
        }
    },
    async unsharePhotos(photos, entryId, isBestShare = false, isDailyShare = false, isInsightShare = false) {
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
                
                if (photoUrlMatch) {
                    // 베스트 공유인 경우 type='best'인 항목만 삭제
                    if (isBestShare) {
                        if (data.type === 'best') {
                            photosToDelete.push(docSnap.id);
                        }
                    } else if (isDailyShare) {
                        // 일간보기 공유인 경우: type='daily'이고 photoUrl이 일치하면 삭제
                        if (data.type === 'daily') {
                            photosToDelete.push(docSnap.id);
                        }
                    } else if (isInsightShare) {
                        // 인사이트 공유인 경우: type='insight'이고 photoUrl이 일치하면 삭제
                        if (data.type === 'insight') {
                            photosToDelete.push(docSnap.id);
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
                        }
                    }
                }
            });
            
            // 배치 삭제 사용: 여러 사진을 한 번에 삭제 (1번으로 카운트)
            if (photosToDelete.length > 0) {
                const batch = writeBatch(db);
                photosToDelete.forEach(docId => {
                    const docRef = doc(db, 'artifacts', appId, 'sharedPhotos', docId);
                    batch.delete(docRef);
                });
                await batch.commit();
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
    },
    
    // 사용자 데이터 삭제 (탈퇴용)
    async deleteAllUserData() {
        if (!window.currentUser || window.currentUser.isAnonymous) {
            throw new Error("로그인이 필요합니다.");
        }
        
        const userId = window.currentUser.uid;
        try {
            // 1. 모든 meals 삭제
            const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
            const mealsSnapshot = await getDocs(mealsColl);
            const mealsBatch = writeBatch(db);
            mealsSnapshot.docs.forEach(docSnap => {
                mealsBatch.delete(docSnap.ref);
            });
            if (mealsSnapshot.docs.length > 0) {
                await mealsBatch.commit();
            }
            
            // 2. settings 삭제
            const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            await deleteDoc(settingsRef);
            
            // 3. 공유된 사진 삭제
            const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
            const sharedQuery = query(sharedColl, where('userId', '==', userId));
            const sharedSnapshot = await getDocs(sharedQuery);
            const sharedBatch = writeBatch(db);
            sharedSnapshot.docs.forEach(docSnap => {
                sharedBatch.delete(docSnap.ref);
            });
            if (sharedSnapshot.docs.length > 0) {
                await sharedBatch.commit();
            }
            
            // 4. 프로필 사진 삭제 (Storage)
            if (window.userSettings?.profile?.photoUrl) {
                try {
                    const { storage } = await import('./firebase.js');
                    const { ref, deleteObject } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js");
                    // photoUrl에서 경로 추출
                    const photoUrl = window.userSettings.profile.photoUrl;
                    const urlMatch = photoUrl.match(/users%2F([^%]+)%2Fprofile%2F(.+)/);
                    if (urlMatch) {
                        const photoPath = `users/${userId}/profile/${urlMatch[2]}`;
                        const photoRef = ref(storage, photoPath);
                        await deleteObject(photoRef);
                    }
                } catch (storageError) {
                    console.warn('프로필 사진 삭제 중 오류 (무시하고 계속 진행):', storageError);
                }
            }
        } catch (e) {
            console.error("Delete All User Data Error:", e);
            throw e;
        }
    }
};

export function setupListeners(userId, callbacks) {
    const { onSettingsUpdate, onDataUpdate, settingsUnsubscribe: oldSettingsUnsubscribe, dataUnsubscribe: oldDataUnsubscribe } = callbacks;
    
    // 사용자 ID 확인 및 로깅
    console.log('🔧 setupListeners 호출:', { 
        userId, 
        currentUser: window.currentUser?.uid,
        isMatch: userId === window.currentUser?.uid
    });
    
    // 사용자 ID 불일치 경고
    if (window.currentUser && userId !== window.currentUser.uid) {
        console.error('⚠️ ⚠️ ⚠️ 사용자 ID 불일치!', {
            setupListenersUserId: userId,
            currentUserUid: window.currentUser.uid,
            email: window.currentUser.email
        });
    }
    
    // Settings 리스너
    if (oldSettingsUnsubscribe) {
        console.log('🔌 이전 settings 리스너 해제');
        oldSettingsUnsubscribe();
    }
    
    // Data 리스너도 미리 해제
    if (oldDataUnsubscribe) {
        console.log('🔌 이전 data 리스너 해제');
        oldDataUnsubscribe();
    }
    
    let migrationInProgress = false; // 마이그레이션 중복 실행 방지
    
    const settingsUnsubscribe = onSnapshot(doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings'), async (snap) => {
        // 사용자 ID 재확인 (리스너 내부에서)
        if (window.currentUser && userId !== window.currentUser.uid) {
            console.error('⚠️ ⚠️ ⚠️ 설정 리스너 콜백: 사용자 ID 불일치 감지!', {
                listenerUserId: userId,
                currentUserUid: window.currentUser.uid,
                email: window.currentUser.email
            });
            // 잘못된 사용자의 리스너이므로 무시
            return;
        }
        
        // users/{userId} 문서가 없으면 생성 (관리자 페이지에서 사용자 목록을 보기 위해)
        try {
            const userDocRef = doc(db, 'artifacts', appId, 'users', userId);
            const userDocSnap = await getDoc(userDocRef);
            if (!userDocSnap.exists()) {
                // 최소한의 사용자 문서 생성 (타임스탬프만)
                await setDoc(userDocRef, {
                    createdAt: new Date().toISOString(),
                    lastLoginAt: new Date().toISOString()
                }, { merge: true });
                console.log('✅ users/{userId} 문서 생성 완료:', userId);
            }
        } catch (e) {
            console.warn('users/{userId} 문서 생성 실패:', e);
        }
        
        if (snap.exists()) {
            window.userSettings = snap.data();
            console.log('📥 설정 로드 완료:', {
                hasProfile: !!(window.userSettings.profile && window.userSettings.profile.nickname),
                nickname: window.userSettings.profile?.nickname,
                termsAgreed: window.userSettings.termsAgreed,
                termsVersion: window.userSettings.termsVersion
            });
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
            
            // 관리자에서 등록한 태그를 로드하여 사용자 설정에 병합
            try {
                const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
                const tagsSnap = await getDoc(tagsDoc);
                if (tagsSnap.exists()) {
                    const adminTags = tagsSnap.data();
                    // 사용자 설정의 tags가 없으면 생성
                    if (!window.userSettings.tags) {
                        window.userSettings.tags = {};
                    }
                    // 관리자 태그를 사용자 설정에 병합 (관리자 태그가 우선)
                    if (adminTags.mealType && Array.isArray(adminTags.mealType)) {
                        window.userSettings.tags.mealType = [...adminTags.mealType];
                    }
                    if (adminTags.withWhom && Array.isArray(adminTags.withWhom)) {
                        window.userSettings.tags.withWhom = [...adminTags.withWhom];
                    }
                    if (adminTags.category && Array.isArray(adminTags.category)) {
                        window.userSettings.tags.category = [...adminTags.category];
                    }
                    if (adminTags.snackType && Array.isArray(adminTags.snackType)) {
                        window.userSettings.tags.snackType = [...adminTags.snackType];
                    }
                    console.log('✅ 관리자 태그 병합 완료:', {
                        mealType: window.userSettings.tags.mealType?.length || 0,
                        withWhom: window.userSettings.tags.withWhom?.length || 0,
                        category: window.userSettings.tags.category?.length || 0,
                        snackType: window.userSettings.tags.snackType?.length || 0
                    });
                } else {
                    console.warn('⚠️ 관리자 태그 문서가 없습니다. 기본값을 사용합니다.');
                }
            } catch (e) {
                console.warn('⚠️ 관리자 태그 로드 실패 (기본값 사용):', e);
            }
            
            // 마이그레이션 로직을 비동기로 처리하여 초기 로딩 지연 최소화
            if (!migrationInProgress) {
                migrationInProgress = true;
                // 즉시 콜백 호출하여 UI 업데이트 지연 방지
                console.log('📞 onSettingsUpdate 콜백 호출');
                if (onSettingsUpdate) onSettingsUpdate();
                
                // 마이그레이션은 백그라운드에서 처리
                Promise.resolve().then(async () => {
                    let needsSave = false;
                    // 깊은 복사로 기존 설정 보존
                    const settingsToSave = JSON.parse(JSON.stringify(window.userSettings));
                    
                    // profile 정보 보존 확인 (닉네임이 없거나 '게스트'인 경우 기존 설정 확인)
                    // 주의: Firestore에 '게스트'로 저장되어 있을 수 있으므로, 실제로는 기존 설정을 확인하지 않음
                    // 대신, profile이 완전히 없을 때만 기본값 설정
                    if (!settingsToSave.profile) {
                        settingsToSave.profile = { icon: '🐻', nickname: '게스트' };
                        needsSave = true;
                    } else if (!settingsToSave.profile.nickname || settingsToSave.profile.nickname === '게스트') {
                        // 닉네임이 '게스트'이거나 없으면, 이것이 실제 저장된 값일 수 있으므로
                        // 마이그레이션에서는 건드리지 않음 (사용자가 직접 수정해야 함)
                        console.log('⚠️ 닉네임이 "게스트"이거나 없습니다. 사용자가 직접 수정해야 합니다.');
                    }
                    
                    // providerId와 email 업데이트 (없을 때만 추가, 이미 있으면 유지)
                    // 주의: providerId는 로그인 방법이므로 변경되면 안 됨 (덮어쓰지 않음)
                    try {
                        const { auth } = await import('./firebase.js');
                        const currentUser = auth.currentUser;
                        if (currentUser && !currentUser.isAnonymous) {
                            // providerId 업데이트 (없을 때만 추가, 기존 값은 보존)
                            if (currentUser.providerData && currentUser.providerData.length > 0) {
                                const currentProviderId = currentUser.providerData[0].providerId;
                                if (!settingsToSave.providerId) {
                                    // providerId가 없을 때만 설정
                                    settingsToSave.providerId = currentProviderId;
                                    needsSave = true;
                                    console.log('✅ 마이그레이션: providerId 초기 설정:', currentProviderId);
                                } else if (settingsToSave.providerId !== currentProviderId) {
                                    // providerId가 다르면 경고만 (덮어쓰지 않음)
                                    console.warn(`⚠️ providerId 불일치 감지: 저장된 값(${settingsToSave.providerId}) vs 현재(${currentProviderId}). 기존 값 유지합니다.`);
                                }
                            }
                            // email 업데이트 (없을 때만 추가, 또는 같은 providerId일 때만 업데이트)
                            if (currentUser.email) {
                                const currentProviderId = currentUser.providerData?.[0]?.providerId;
                                if (!settingsToSave.email) {
                                    // 기존 이메일이 없으면 설정
                                    settingsToSave.email = currentUser.email;
                                    needsSave = true;
                                    console.log('✅ 마이그레이션: email 초기 설정:', currentUser.email);
                                } else if (settingsToSave.providerId === currentProviderId && settingsToSave.email !== currentUser.email) {
                                    // 같은 providerId인데 이메일이 다르면 업데이트
                                    settingsToSave.email = currentUser.email;
                                    needsSave = true;
                                    console.log('✅ 마이그레이션: email 업데이트:', currentUser.email);
                                } else if (settingsToSave.providerId !== currentProviderId) {
                                    // providerId가 다르면 경고만
                                    console.warn(`⚠️ providerId 불일치로 인한 email 불일치: 저장된(${settingsToSave.email}) vs 현재(${currentUser.email}). 기존 값 유지합니다.`);
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('사용자 정보 가져오기 실패:', e);
                    }
                    
                    // "???" 항목 제거 (기존 사용자 설정 정리)
                    if (settingsToSave.tags && settingsToSave.tags.mealType) {
                        const index = settingsToSave.tags.mealType.indexOf('???');
                        if (index > -1) {
                            settingsToSave.tags.mealType.splice(index, 1);
                            needsSave = true;
                        }
                    }
                    
                    // 식사 방식 태그 마이그레이션: 새로운 순서로 정리
                    const newMealTypes = ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'];
                    const currentMealTypes = settingsToSave.tags?.mealType || [];
                    
                    let updatedMealTypes = [...currentMealTypes];
                    
                    // 기존 태그를 새로운 태그로 매핑
                    const tagMapping = {
                        'Skip': '건너뜀',
                        '건너뜀': '건너뜀',
                        '배달': '배달/포장',
                        '회사밥': '구내식당',
                        '술자리': '회식/술자리'
                    };
                    
                    // 기존 태그를 새로운 태그로 변환
                    updatedMealTypes = updatedMealTypes.map(tag => tagMapping[tag] || tag);
                    
                    // '배달'이 있으면 '배달/포장'으로 변경
                    const hasOldDelivery = updatedMealTypes.includes('배달');
                    if (hasOldDelivery) {
                        const oldIndex = updatedMealTypes.indexOf('배달');
                        updatedMealTypes[oldIndex] = '배달/포장';
                        needsSave = true;
                    }
                    
                    // 새로운 태그가 없으면 추가
                    newMealTypes.forEach(newTag => {
                        if (!updatedMealTypes.includes(newTag)) {
                            updatedMealTypes.push(newTag);
                            needsSave = true;
                        }
                    });
                    
                    // 순서 정렬 (newMealTypes 순서대로)
                    updatedMealTypes = newMealTypes.filter(tag => updatedMealTypes.includes(tag));
                    if (updatedMealTypes.length > 0) {
                        if (!settingsToSave.tags) settingsToSave.tags = {};
                        settingsToSave.tags.mealType = updatedMealTypes;
                    }
                    
                    // subTags의 place에서도 parent 변경
                    if (settingsToSave.subTags && settingsToSave.subTags.place) {
                        settingsToSave.subTags.place.forEach(item => {
                            if (item.parent === '배달') {
                                item.parent = '배달/포장';
                                needsSave = true;
                            } else if (item.parent === '회사밥') {
                                item.parent = '구내식당';
                                needsSave = true;
                            }
                        });
                    }
                    
                    // 간식 항목 마이그레이션: 새로운 항목으로 업데이트
                    const newSnackTypes = ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
                    
                    // tags가 없으면 생성
                    if (!settingsToSave.tags) {
                        settingsToSave.tags = {};
                    }
                    
                    const currentSnackTypes = settingsToSave.tags.snackType || [];
                    
                    // 새로운 항목과 정확히 일치하는지 확인
                    const isExactMatch = currentSnackTypes.length === newSnackTypes.length &&
                        currentSnackTypes.every((tag, idx) => tag === newSnackTypes[idx]);
                    
                    if (!isExactMatch) {
                        // 정확히 일치하지 않으면 무조건 업데이트
                        settingsToSave.tags.snackType = [...newSnackTypes];
                        needsSave = true;
                    }
                    
                    // 함께한 사람 태그 마이그레이션: 새로운 항목으로 업데이트
                    const newWithWhomTags = ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'];
                    const currentWithWhomTags = settingsToSave.tags.withWhom || [];
                    
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
                        
                        settingsToSave.tags.withWhom = updatedTags;
                        
                        // 서브 태그도 업데이트: '회사사람' parent를 '직장동료'로 변경
                        if (settingsToSave.subTags && settingsToSave.subTags.people) {
                            settingsToSave.subTags.people = settingsToSave.subTags.people.map(subTag => {
                                if (subTag.parent === '회사사람') {
                                    return { ...subTag, parent: '직장동료' };
                                }
                                return subTag;
                            });
                        }
                        
                        needsSave = true;
                    }
                    
                    // 변경사항이 있으면 저장 (비동기, 에러는 무시)
                    if (needsSave) {
                        window.userSettings = settingsToSave;
                        dbOps.saveSettings(settingsToSave).catch(e => {
                            console.error('설정 마이그레이션 저장 실패:', e);
                        });
                    }
                    
                    migrationInProgress = false;
                }).catch(e => {
                    console.error('마이그레이션 처리 중 오류:', e);
                    migrationInProgress = false;
                });
            } else {
                // 마이그레이션 진행 중이면 콜백만 호출
                if (onSettingsUpdate) onSettingsUpdate();
            }
        } else {
            // snap.exists()=false: 캐시 미스일 수 있음. 약관 동의된 사용자가 모달이 잠깐 뜨는 현상 방지를 위해 서버에서 재확인.
            const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            try {
                const serverSnap = await getDoc(settingsRef, { source: 'server' });
                if (serverSnap.exists()) {
                    window.userSettings = serverSnap.data();
                    if (!window.userSettings.subTags) window.userSettings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));
                    if (!window.userSettings.favoriteSubTags) window.userSettings.favoriteSubTags = { mealType: {}, category: {}, withWhom: {}, snackType: {} };
                    console.log('📥 설정 서버에서 로드 (캐시 미스 시): termsAgreed=', window.userSettings.termsAgreed);
                    if (onSettingsUpdate) onSettingsUpdate();
                    return;
                }
            } catch (e) {
                console.warn('설정 서버 재확인 실패, 기본값 사용:', e);
            }
            // 서버에도 없음: 기본값 사용 (providerId와 email 포함)
            console.log('📥 설정이 없음. 기본값 로드 시작...');
            import('./constants.js').then(async ({ DEFAULT_USER_SETTINGS }) => {
                window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
                
                // 기존 사용자인지 확인 (meals 데이터가 있으면 기존 사용자)
                let isExistingUser = false;
                try {
                    const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
                    const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
                    isExistingUser = !mealsSnapshot.empty;
                    console.log('기존 사용자 여부 확인:', { userId, isExistingUser, hasMeals: !mealsSnapshot.empty });
                } catch (e) {
                    console.warn('기존 사용자 확인 실패:', e);
                }
                
                // 기존 사용자라면 약관 동의를 true로 설정
                if (isExistingUser) {
                    window.userSettings.termsAgreed = true;
                    window.userSettings.termsAgreedAt = new Date().toISOString();
                    console.log('✅ 기존 사용자로 확인되어 약관 동의 자동 설정');
                }
                
                // 중요: providerId와 email은 약관 동의나 프로필 설정 시에만 설정됩니다.
                // 설정 로드 시에는 설정하지 않습니다. (고정 항목이므로)
                
                console.log('✅ 기본 설정 로드 완료. onSettingsUpdate 호출');
                if (onSettingsUpdate) onSettingsUpdate();
            }).catch(e => {
                console.error('기본 설정 로드 실패:', e);
                // 에러 발생 시에도 콜백 호출 (빈 설정으로라도)
                if (onSettingsUpdate) onSettingsUpdate();
            });
        }
    }, async (error) => {
        console.error("Settings Listener Error:", error);
        console.error("에러 상세:", {
            code: error.code,
            message: error.message,
            userId: userId
        });
        
        // 권한 오류인 경우 기존 사용자인지 확인하여 약관 동의 자동 설정
        if (error.code === 'permission-denied') {
            console.warn('⚠️ 설정 읽기 권한 오류. 기존 사용자인지 확인합니다...');
            try {
                const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
                const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
                const isExistingUser = !mealsSnapshot.empty;
                
                if (isExistingUser) {
                    console.log('✅ 기존 사용자로 확인. 약관 동의 자동 설정 시도...');
                    // 기본값에 약관 동의 설정
                    import('./constants.js').then(async ({ DEFAULT_USER_SETTINGS }) => {
                        window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
                        window.userSettings.termsAgreed = true;
                        window.userSettings.termsAgreedAt = new Date().toISOString();
                        
                        // 중요: providerId와 email은 약관 동의나 프로필 설정 시에만 설정됩니다.
                        // 권한 오류 시 자동 설정에서는 설정하지 않습니다.
                        
                        if (onSettingsUpdate) onSettingsUpdate();
                    });
                    return;
                }
            } catch (e) {
                console.warn('기존 사용자 확인 실패:', e);
            }
        }
        
        // 에러 발생 시 기본값 사용
        import('./constants.js').then(({ DEFAULT_USER_SETTINGS }) => {
            window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
            if (onSettingsUpdate) onSettingsUpdate();
        }).catch(e => {
            console.error('기본 설정 로드 실패:', e);
            if (onSettingsUpdate) onSettingsUpdate();
        });
    });
    
    // Meals 리스너 - 최근 1개월만 초기 로드
    if (oldDataUnsubscribe) {
        console.log('🔌 이전 data 리스너 해제');
        oldDataUnsubscribe();
    }
    
    // 사용자 ID 확인 (데이터 리스너)
    if (window.currentUser && userId !== window.currentUser.uid) {
        console.error('⚠️ ⚠️ ⚠️ 데이터 리스너: 사용자 ID 불일치!', {
            setupListenersUserId: userId,
            currentUserUid: window.currentUser.uid
        });
    }
    
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
        // 사용자 ID 재확인 (리스너 내부에서)
        if (window.currentUser && userId !== window.currentUser.uid) {
            console.error('⚠️ ⚠️ ⚠️ 데이터 리스너 콜백: 사용자 ID 불일치 감지!', {
                listenerUserId: userId,
                currentUserUid: window.currentUser.uid,
                email: window.currentUser.email
            });
            // 잘못된 사용자의 리스너이므로 무시
            return;
        }
        if (isInitialLoad) {
            // 초기 로드: 최근 1개월 데이터
            window.mealHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            window.loadedMealsDateRange = { start: cutoffDateStr, end: todayStr };
            isInitialLoad = false;
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
            }
        }
        
        if (onDataUpdate) onDataUpdate();
    }, (error) => {
        console.error("Meals Listener Error:", error);
        // 사용자 ID 재확인
        if (window.currentUser && userId !== window.currentUser.uid) {
            console.error('⚠️ 데이터 리스너 에러 핸들러: 사용자 ID 불일치! 리스너 무시');
            return;
        }
        // 인덱스가 없을 경우 fallback: 전체 컬렉션 사용 (경고만 표시)
        console.warn("날짜 범위 쿼리 실패, 전체 컬렉션으로 fallback");
        const fallbackQuery = collection(db, 'artifacts', appId, 'users', userId, 'meals');
        return onSnapshot(fallbackQuery, (snap) => {
            // 사용자 ID 재확인 (fallback 리스너 내부에서)
            if (window.currentUser && userId !== window.currentUser.uid) {
                console.error('⚠️ Fallback 리스너: 사용자 ID 불일치! 무시');
                return;
            }
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

// 좋아요, 댓글, 북마크 관련 함수들
export const postInteractions = {
    // 좋아요 추가/제거
    async toggleLike(postId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(
                likesColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                // 좋아요 추가
                await addDoc(likesColl, {
                    postId,
                    userId,
                    timestamp: new Date().toISOString()
                });
                return { liked: true };
            } else {
                // 좋아요 제거
                const docId = snapshot.docs[0].id;
                await deleteDoc(doc(db, 'artifacts', appId, 'postLikes', docId));
                return { liked: false };
            }
        } catch (e) {
            console.error("Toggle Like Error:", e);
            throw e;
        }
    },
    
    // 좋아요 목록 가져오기 (특정 포스트)
    async getLikes(postId) {
        if (!postId) return [];
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            // 서버 측에서 정렬 (인덱스 필요: postId, timestamp)
            const q = query(
                likesColl,
                where('postId', '==', postId),
                orderBy('timestamp', 'desc')
            );
            const snapshot = await getDocs(q);
            return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.error("Get Likes Error:", e);
            // 인덱스가 없을 경우 fallback: 클라이언트 측 정렬
            if (e.code === 'failed-precondition') {
                try {
                    const likesColl = collection(db, 'artifacts', appId, 'postLikes');
                    const fallbackQ = query(
                        likesColl,
                        where('postId', '==', postId)
                    );
                    const snapshot = await getDocs(fallbackQ);
                    const likes = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    likes.sort((a, b) => {
                        const timeA = new Date(a.timestamp || 0).getTime();
                        const timeB = new Date(b.timestamp || 0).getTime();
                        return timeB - timeA;
                    });
                    return likes;
                } catch (fallbackError) {
                    console.error("Get Likes Fallback Error:", fallbackError);
                    return [];
                }
            }
            return [];
        }
    },
    
    // 사용자가 좋아요 했는지 확인
    async isLiked(postId, userId) {
        if (!postId || !userId) return false;
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(
                likesColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Liked Error:", e);
            return false;
        }
    },
    
    // 북마크 추가/제거
    async toggleBookmark(postId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) {
                // 북마크 추가
                await addDoc(bookmarksColl, {
                    postId,
                    userId,
                    timestamp: new Date().toISOString()
                });
                return { bookmarked: true };
            } else {
                // 북마크 제거
                const docId = snapshot.docs[0].id;
                await deleteDoc(doc(db, 'artifacts', appId, 'postBookmarks', docId));
                return { bookmarked: false };
            }
        } catch (e) {
            console.error("Toggle Bookmark Error:", e);
            throw e;
        }
    },
    
    // 사용자가 북마크 했는지 확인
    async isBookmarked(postId, userId) {
        if (!postId || !userId) return false;
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(
                bookmarksColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            return !snapshot.empty;
        } catch (e) {
            console.error("Is Bookmarked Error:", e);
            return false;
        }
    },
    
    // 본인이 좋아요한 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsLikedByUser(userId) {
        if (!userId) return [];
        try {
            const likesColl = collection(db, 'artifacts', appId, 'postLikes');
            const q = query(likesColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Liked By User Error:", e);
            return [];
        }
    },
    
    // 본인이 북마크한 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsBookmarkedByUser(userId) {
        if (!userId) return [];
        try {
            const bookmarksColl = collection(db, 'artifacts', appId, 'postBookmarks');
            const q = query(bookmarksColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Bookmarked By User Error:", e);
            return [];
        }
    },
    
    // 본인이 댓글 단 포스트 ID 목록 (앨범 흔적 필터용)
    async getPostIdsCommentedByUser(userId) {
        if (!userId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const q = query(commentsColl, where('userId', '==', userId));
            const snapshot = await getDocs(q);
            return [...new Set(snapshot.docs.map(d => d.data().postId).filter(Boolean))];
        } catch (e) {
            console.error("Get PostIds Commented By User Error:", e);
            return [];
        }
    },
    
    // 댓글 추가
    async addComment(postId, userId, commentText, userProfile) {
        if (!window.currentUser || window.currentUser.isAnonymous || !postId || !commentText?.trim()) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            const commentData = {
                postId,
                userId,
                userNickname: userProfile?.nickname || '익명',
                userIcon: userProfile?.icon || '🐻',
                comment: commentText.trim(),
                timestamp: new Date().toISOString()
            };
            const docRef = await addDoc(commentsColl, commentData);
            return { id: docRef.id, ...commentData };
        } catch (e) {
            console.error("Add Comment Error:", e);
            throw e;
        }
    },
    
    // 댓글 목록 가져오기
    async getComments(postId) {
        if (!postId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'postComments');
            // 서버 측에서 정렬 (인덱스 필요: postId, timestamp)
            const q = query(
                commentsColl,
                where('postId', '==', postId),
                orderBy('timestamp', 'asc')
            );
            const snapshot = await getDocs(q);
            return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (e) {
            console.error("Get Comments Error:", e);
            // 인덱스가 없을 경우 fallback: 클라이언트 측 정렬
            if (e.code === 'failed-precondition') {
                try {
                    const commentsColl = collection(db, 'artifacts', appId, 'postComments');
                    const fallbackQ = query(
                        commentsColl,
                        where('postId', '==', postId)
                    );
                    const snapshot = await getDocs(fallbackQ);
                    const comments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    comments.sort((a, b) => {
                        const timeA = new Date(a.timestamp || 0).getTime();
                        const timeB = new Date(b.timestamp || 0).getTime();
                        return timeA - timeB;
                    });
                    return comments;
                } catch (fallbackError) {
                    console.error("Get Comments Fallback Error:", fallbackError);
                    return [];
                }
            }
            return [];
        }
    },
    
    // 댓글 삭제
    async deleteComment(commentId, userId) {
        if (!window.currentUser || window.currentUser.isAnonymous || !commentId) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            // 본인 댓글인지 확인
            const commentRef = doc(db, 'artifacts', appId, 'postComments', commentId);
            const commentSnap = await getDocs(query(
                collection(db, 'artifacts', appId, 'postComments'),
                where('userId', '==', userId)
            ));
            
            // 해당 commentId를 가진 댓글이 있는지 확인
            const targetComment = commentSnap.docs.find(d => d.id === commentId);
            if (targetComment) {
                await deleteDoc(commentRef);
                return true;
            }
            return false;
        } catch (e) {
            console.error("Delete Comment Error:", e);
            // 직접 삭제 시도 (권한 체크는 Firestore 규칙에서 처리)
            try {
                await deleteDoc(doc(db, 'artifacts', appId, 'postComments', commentId));
                return true;
            } catch (deleteError) {
                console.error("직접 삭제 실패:", deleteError);
                throw e;
            }
        }
    }
};

// 현재 사용자가 해당 게시물을 이미 신고했는지 조회 (있으면 { id, reason, reasonOther } 반환)
// postReports read 권한 이슈 회피: 사용자 자신의 config/reportedPosts 문서에서 조회
export async function getUserReportForPost(targetGroupKey, userId) {
    if (!targetGroupKey || !userId) return null;
    const ref = doc(db, 'artifacts', appId, 'users', userId, 'config', 'reportedPosts');
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const entry = snap.data()[targetGroupKey];
    if (!entry || !entry.reportId) return null;
    return { id: entry.reportId, reason: entry.reason, reasonOther: entry.reasonOther };
}

// 게시물 신고 (이미 신고한 경우 throw)
export async function submitReport(payload) {
    const currentUser = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : window.currentUser;
    if (!currentUser || currentUser.isAnonymous) {
        throw new Error("로그인이 필요합니다.");
    }
    const { targetGroupKey, reason, reasonOther } = payload;
    if (!targetGroupKey || !reason) {
        throw new Error("신고 대상과 사유가 필요합니다.");
    }
    const existing = await getUserReportForPost(targetGroupKey, currentUser.uid);
    if (existing) {
        throw new Error("이미 신고한 게시물입니다.");
    }
    const reportsColl = collection(db, 'artifacts', appId, 'postReports');
    const reasonOtherVal = (reason === 'other' && reasonOther && String(reasonOther).trim()) ? String(reasonOther).trim() : undefined;
    const data = {
        targetGroupKey,
        reason,
        reportedBy: currentUser.uid,
        reportedAt: new Date().toISOString()
    };
    if (reasonOtherVal) data.reasonOther = reasonOtherVal;
    const reportRef = await addDoc(reportsColl, data);
    // 본인 config/reportedPosts에 기록 (getUserReportForPost에서 조회, postReports read 권한 불필요)
    const userReportedRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'reportedPosts');
    await setDoc(userReportedRef, { [targetGroupKey]: { reportId: reportRef.id, reason, reasonOther: reasonOtherVal || null } }, { merge: true });
    return reportRef.id;
}

// 신고 취소 (본인이 신고한 문서만 삭제 가능, 규칙에서 검증. targetGroupKey로 config/reportedPosts에서도 제거)
export async function withdrawReport(reportId, targetGroupKey) {
    const currentUser = (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser : window.currentUser;
    if (!currentUser || currentUser.isAnonymous) {
        throw new Error("로그인이 필요합니다.");
    }
    if (!reportId) throw new Error("취소할 신고가 없습니다.");
    const reportRef = doc(db, 'artifacts', appId, 'postReports', reportId);
    await deleteDoc(reportRef);
    if (targetGroupKey) {
        const userReportedRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'config', 'reportedPosts');
        await updateDoc(userReportedRef, { [targetGroupKey]: deleteField() });
    }
}

// 관리자: targetGroupKey별 신고 집계 (전체 조회 후 메모리에서 집계)
export async function getReportsAggregateByGroupKeys() {
    const reportsColl = collection(db, 'artifacts', appId, 'postReports');
    const snapshot = await getDocs(reportsColl);
    const byKey = {};
    snapshot.docs.forEach(d => {
        const { targetGroupKey, reason, reasonOther } = d.data();
        if (!targetGroupKey) return;
        if (!byKey[targetGroupKey]) {
            byKey[targetGroupKey] = { count: 0, byReason: {} };
        }
        byKey[targetGroupKey].count += 1;
        const reasonLabel = reason === 'other' && reasonOther ? `기타: ${reasonOther}` : reason;
        byKey[targetGroupKey].byReason[reasonLabel] = (byKey[targetGroupKey].byReason[reasonLabel] || 0) + 1;
    });
    return byKey;
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
        const startStr = typeof startDate === 'string' ? startDate : toLocalDateString(startDate);
        const endStr = typeof endDate === 'string' ? endDate : toLocalDateString(endDate);
        
        // 이미 로드된 범위 확인
        if (window.loadedMealsDateRange) {
            const loadedStart = new Date(window.loadedMealsDateRange.start);
            const loadedEnd = new Date(window.loadedMealsDateRange.end);
            const requestedStart = new Date(startStr);
            const requestedEnd = new Date(endStr);
            
            // 요청한 범위가 이미 로드된 범위에 포함되는지 확인
            if (requestedStart >= loadedStart && requestedEnd <= loadedEnd) {
                return 0;
            }
        }
        
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

// 게시판 관련 함수들
export const boardOperations = {
    // 게시글 작성
    async createPost(postData) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            // 사용자 닉네임 가져오기
            let authorNickname = '익명';
            try {
                if (window.userSettings && window.userSettings.profile && window.userSettings.profile.nickname) {
                    authorNickname = window.userSettings.profile.nickname;
                } else {
                    // userSettings가 없으면 Firestore에서 직접 가져오기
                    const userSettingsDoc = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'config', 'settings');
                    const userSettingsSnap = await getDoc(userSettingsDoc);
                    if (userSettingsSnap.exists()) {
                        const settingsData = userSettingsSnap.data();
                        if (settingsData.profile && settingsData.profile.nickname) {
                            authorNickname = settingsData.profile.nickname;
                        }
                    }
                }
            } catch (e) {
                console.warn("닉네임 가져오기 실패, 기본값 사용:", e);
            }
            
            const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
            const newPost = {
                title: postData.title,
                content: postData.content,
                category: postData.category || 'serious',
                authorId: window.currentUser.uid,
                authorNickname: authorNickname,
                likes: 0,
                dislikes: 0,
                views: 0,
                comments: 0,
                isHidden: false,
                timestamp: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            const docRef = await addDoc(postsColl, newPost);
            showToast("게시글이 등록되었습니다.", 'success');
            return { id: docRef.id, ...newPost };
        } catch (e) {
            console.error("Create Post Error:", e);
            showToast("게시글 등록에 실패했습니다.", 'error');
            throw e;
        }
    },
    
    // 익명 ID 가져오기 또는 생성 (사용자별 고정)
    async getAnonymousId(userId) {
        try {
            const userDoc = doc(db, 'artifacts', appId, 'boardUsers', userId);
            const userSnap = await getDoc(userDoc);
            
            // 사용자가 이미 익명 ID를 가지고 있는지 확인
            if (userSnap.exists()) {
                const userData = userSnap.data();
                if (userData && userData.anonymousId) {
                    return userData.anonymousId;
                }
            }
            
            // 새로운 익명 ID 생성
            const randomNum = Math.floor(Math.random() * 9999) + 1;
            const anonymousId = `익명${randomNum.toString().padStart(4, '0')}`;
            
            // 사용자 문서에 익명 ID 저장
            await setDoc(userDoc, {
                userId: userId,
                anonymousId: anonymousId,
                createdAt: new Date().toISOString()
            }, { merge: true });
            
            return anonymousId;
        } catch (e) {
            console.error("Get Anonymous ID Error:", e);
            // 에러 발생 시 임시 익명 ID 반환
            const randomNum = Math.floor(Math.random() * 9999) + 1;
            return `익명${randomNum.toString().padStart(4, '0')}`;
        }
    },
    
    // 게시글 목록 가져오기 (가려진 글 isHidden===true 제외, 클라이언트에서 필터)
    async getPosts(category = 'all', sortBy = 'latest', limitCount = 50) {
        try {
            const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
            const fetchLimit = Math.min(limitCount * 2, 100);
            let q;
            
            if (category === 'all') {
                q = query(postsColl, orderBy('timestamp', 'desc'), limit(fetchLimit));
            } else {
                q = query(
                    postsColl,
                    where('category', '==', category),
                    orderBy('timestamp', 'desc'),
                    limit(fetchLimit)
                );
            }
            
            const snapshot = await getDocs(q);
            let posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
                .filter(p => p.isHidden !== true);
            posts = posts.slice(0, limitCount);
            
            // 인기순 정렬 (좋아요 - 비추천 수 기준)
            if (sortBy === 'popular') {
                posts.sort((a, b) => {
                    const scoreA = (a.likes || 0) - (a.dislikes || 0);
                    const scoreB = (b.likes || 0) - (b.dislikes || 0);
                    if (scoreB !== scoreA) return scoreB - scoreA;
                    // 점수가 같으면 최신순
                    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                });
            }
            
            return posts;
        } catch (e) {
            console.error("Get Posts Error:", e);
            // 인덱스가 없을 경우 fallback: 전체 가져와서 클라이언트 측에서 필터링
            if (e.code === 'failed-precondition' || e.message?.includes('index')) {
                console.warn("Firestore 인덱스가 없어 fallback 모드로 작동합니다. 전체 게시글을 가져와 필터링합니다.");
                try {
                    const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
                    const fallbackQuery = query(postsColl, orderBy('timestamp', 'desc'), limit(limitCount * 2)); // 더 많이 가져와서 필터링
                    const snapshot = await getDocs(fallbackQuery);
                    let allPosts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                    
                    // 카테고리 필터링
                    if (category !== 'all') {
                        allPosts = allPosts.filter(post => post.category === category);
                    }
                    
                    // limit 적용
                    allPosts = allPosts.slice(0, limitCount);
                    
                    // 인기순 정렬
                    if (sortBy === 'popular') {
                        allPosts.sort((a, b) => {
                            const scoreA = (a.likes || 0) - (a.dislikes || 0);
                            const scoreB = (b.likes || 0) - (b.dislikes || 0);
                            if (scoreB !== scoreA) return scoreB - scoreA;
                            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
                        });
                    }
                    
                    return allPosts;
                } catch (fallbackError) {
                    console.error("Fallback Get Posts Error:", fallbackError);
                    return [];
                }
            }
            return [];
        }
    },
    
    // 게시글 상세 가져오기
    async getPost(postId) {
        try {
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            
            if (!postSnap.exists()) {
                return null;
            }
            
            const postData = { id: postSnap.id, ...postSnap.data() };
            if (postData.isHidden === true) {
                return null;
            }
            const newViews = (postData.views || 0) + 1;
            
            // 조회수 증가
            await setDoc(postDoc, {
                views: newViews
            }, { merge: true });
            
            return { ...postData, views: newViews };
        } catch (e) {
            console.error("Get Post Error:", e);
            // 조회수 업데이트 실패해도 게시글은 반환
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            if (postSnap.exists()) {
                const data = { id: postSnap.id, ...postSnap.data() };
                if (data.isHidden === true) return null;
                return data;
            }
            return null;
        }
    },
    
    // 게시글 수정
    async updatePost(postId, postData) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            
            if (!postSnap.exists()) {
                throw new Error("게시글을 찾을 수 없습니다.");
            }
            
            const existingPost = postSnap.data();
            if (existingPost.authorId !== window.currentUser.uid) {
                throw new Error("본인의 게시글만 수정할 수 있습니다.");
            }
            
            await setDoc(postDoc, {
                title: postData.title,
                content: postData.content,
                category: postData.category || existingPost.category,
                updatedAt: new Date().toISOString()
            }, { merge: true });
            
            showToast("게시글이 수정되었습니다.", 'success');
            return true;
        } catch (e) {
            console.error("Update Post Error:", e);
            showToast("게시글 수정에 실패했습니다.", 'error');
            throw e;
        }
    },
    
    // 게시글 삭제
    async deletePost(postId) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            
            if (!postSnap.exists()) {
                throw new Error("게시글을 찾을 수 없습니다.");
            }
            
            const postData = postSnap.data();
            if (postData.authorId !== window.currentUser.uid) {
                throw new Error("본인의 게시글만 삭제할 수 있습니다.");
            }
            
            await deleteDoc(postDoc);
            showToast("게시글이 삭제되었습니다.", 'success');
            return true;
        } catch (e) {
            console.error("Delete Post Error:", e);
            showToast("게시글 삭제에 실패했습니다.", 'error');
            throw e;
        }
    },
    
    // 게시글 좋아요/비추천
    async toggleLike(postId, isLike = true) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const interactionsColl = collection(db, 'artifacts', appId, 'boardInteractions');
            const q = query(
                interactionsColl,
                where('postId', '==', postId),
                where('userId', '==', window.currentUser.uid)
            );
            const snapshot = await getDocs(q);
            
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            const postData = postSnap.exists() ? postSnap.data() : null;
            
            if (snapshot.empty) {
                // 새로 좋아요/비추천 추가
                await addDoc(interactionsColl, {
                    postId: postId,
                    userId: window.currentUser.uid,
                    isLike: isLike,
                    timestamp: new Date().toISOString()
                });
                
                // 게시글의 좋아요/비추천 수 업데이트
                if (isLike) {
                    await setDoc(postDoc, {
                        likes: (postData?.likes || 0) + 1
                    }, { merge: true });
                } else {
                    await setDoc(postDoc, {
                        dislikes: (postData?.dislikes || 0) + 1
                    }, { merge: true });
                }
            } else {
                const existingInteraction = snapshot.docs[0];
                const existingData = existingInteraction.data();
                
                if (existingData.isLike === isLike) {
                    // 같은 반응이면 제거
                    await deleteDoc(doc(db, 'artifacts', appId, 'boardInteractions', existingInteraction.id));
                    
                    if (isLike) {
                        await setDoc(postDoc, {
                            likes: Math.max(0, (postData?.likes || 0) - 1)
                        }, { merge: true });
                    } else {
                        await setDoc(postDoc, {
                            dislikes: Math.max(0, (postData?.dislikes || 0) - 1)
                        }, { merge: true });
                    }
                } else {
                    // 다른 반응이면 변경
                    await setDoc(doc(db, 'artifacts', appId, 'boardInteractions', existingInteraction.id), {
                        isLike: isLike,
                        timestamp: new Date().toISOString()
                    }, { merge: true });
                    
                    // 게시글의 좋아요/비추천 수 업데이트
                    if (isLike) {
                        await setDoc(postDoc, {
                            likes: (postData?.likes || 0) + 1,
                            dislikes: Math.max(0, (postData?.dislikes || 0) - 1)
                        }, { merge: true });
                    } else {
                        await setDoc(postDoc, {
                            likes: Math.max(0, (postData?.likes || 0) - 1),
                            dislikes: (postData?.dislikes || 0) + 1
                        }, { merge: true });
                    }
                }
            }
            
            return true;
        } catch (e) {
            console.error("Toggle Like Error:", e);
            throw e;
        }
    },
    
    // 사용자의 게시글 반응 확인
    async getUserReaction(postId, userId) {
        if (!userId) return null;
        try {
            const interactionsColl = collection(db, 'artifacts', appId, 'boardInteractions');
            const q = query(
                interactionsColl,
                where('postId', '==', postId),
                where('userId', '==', userId)
            );
            const snapshot = await getDocs(q);
            
            if (snapshot.empty) return null;
            return snapshot.docs[0].data().isLike ? 'like' : 'dislike';
        } catch (e) {
            console.error("Get User Reaction Error:", e);
            return null;
        }
    },
    
    // 게시글 댓글 가져오기 (orderBy 제거 → 복합 인덱스 불필요, 클라이언트에서 정렬)
    async getComments(postId) {
        if (!postId) return [];
        try {
            const commentsColl = collection(db, 'artifacts', appId, 'boardComments');
            const q = query(commentsColl, where('postId', '==', String(postId)));
            const snapshot = await getDocs(q);
            const comments = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            comments.sort((a, b) => {
                const tA = new Date(a.timestamp || 0).getTime();
                const tB = new Date(b.timestamp || 0).getTime();
                return tA - tB;
            });
            return comments;
        } catch (e) {
            console.error("Get Comments Error (boardComments):", e);
            return [];
        }
    },
    
    // 댓글 작성
    async addComment(postId, content) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            // 사용자 닉네임 가져오기
            let authorNickname = '익명';
            try {
                if (window.userSettings && window.userSettings.profile && window.userSettings.profile.nickname) {
                    authorNickname = window.userSettings.profile.nickname;
                } else {
                    // userSettings가 없으면 Firestore에서 직접 가져오기
                    const userSettingsDoc = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'config', 'settings');
                    const userSettingsSnap = await getDoc(userSettingsDoc);
                    if (userSettingsSnap.exists()) {
                        const settingsData = userSettingsSnap.data();
                        if (settingsData.profile && settingsData.profile.nickname) {
                            authorNickname = settingsData.profile.nickname;
                        }
                    }
                }
            } catch (e) {
                console.warn("댓글 작성자 닉네임 가져오기 실패, 기본값 사용:", e);
            }
            
            const commentsColl = collection(db, 'artifacts', appId, 'boardComments');
            const newComment = {
                postId: String(postId),
                content: content,
                authorId: window.currentUser.uid,
                authorNickname: authorNickname,
                timestamp: new Date().toISOString()
            };
            await addDoc(commentsColl, newComment);
            
            // 게시글의 댓글 수 증가
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            if (postSnap.exists()) {
                const postData = postSnap.data();
                await setDoc(postDoc, {
                    comments: (postData.comments || 0) + 1
                }, { merge: true });
            }
            
            return { id: 'temp', ...newComment };
        } catch (e) {
            console.error("Add Comment Error:", e);
            throw e;
        }
    },
    
    // 댓글 삭제
    async deleteComment(commentId, postId) {
        if (!window.currentUser) {
            throw new Error("로그인이 필요합니다.");
        }
        try {
            const commentDoc = doc(db, 'artifacts', appId, 'boardComments', commentId);
            const commentSnap = await getDoc(commentDoc);
            
            if (!commentSnap.exists()) {
                throw new Error("댓글을 찾을 수 없습니다.");
            }
            
            const commentData = commentSnap.data();
            if (commentData.authorId !== window.currentUser.uid) {
                throw new Error("본인의 댓글만 삭제할 수 있습니다.");
            }
            
            await deleteDoc(commentDoc);
            
            // 게시글의 댓글 수 감소
            const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
            const postSnap = await getDoc(postDoc);
            if (postSnap.exists()) {
                const postData = postSnap.data();
                await setDoc(postDoc, {
                    comments: Math.max(0, (postData.comments || 0) - 1)
                }, { merge: true });
            }
            
            return true;
        } catch (e) {
            console.error("Delete Comment Error:", e);
            throw e;
        }
    },
    
    // 게시판 리스너 설정 (실시간 업데이트)
    setupBoardListener(callback) {
        const postsColl = collection(db, 'artifacts', appId, 'boardPosts');
        const q = query(postsColl, orderBy('timestamp', 'desc'), limit(50));
        
        const unsubscribe = onSnapshot(q, (snapshot) => {
            const posts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            if (callback) callback(posts);
        }, (error) => {
            console.error("Board Listener Error:", error);
        });
        
        return unsubscribe;
    }
};

// 공지 관련 함수 (본문 조회, 좋아요/싫어요 - noticeInteractions 사용, notice 문서는 관리자만 쓰기 가능)
export const noticeOperations = {
    async getNotice(noticeId) {
        try {
            const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
            const snap = await getDoc(noticeDoc);
            if (!snap.exists()) return null;
            const d = snap.data();
            if (d.deleted === true) return null;
            return { id: snap.id, ...d };
        } catch (e) {
            console.error("Get Notice Error:", e);
            return null;
        }
    },
    async getNoticeReactionCounts(noticeId) {
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId));
            const snapshot = await getDocs(q);
            let likes = 0, dislikes = 0;
            snapshot.docs.forEach(d => {
                if (d.data().isLike === true) likes++;
                else dislikes++;
            });
            return { likes, dislikes };
        } catch (e) {
            console.error("Get Notice Reaction Counts Error:", e);
            return { likes: 0, dislikes: 0 };
        }
    },
    async getNoticeUserReaction(noticeId, userId) {
        if (!userId) return null;
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', userId));
            const snapshot = await getDocs(q);
            if (snapshot.empty) return null;
            return snapshot.docs[0].data().isLike ? 'like' : 'dislike';
        } catch (e) {
            console.error("Get Notice User Reaction Error:", e);
            return null;
        }
    },
    async toggleNoticeLike(noticeId, isLike = true) {
        if (!window.currentUser) throw new Error("로그인이 필요합니다.");
        try {
            const coll = collection(db, 'artifacts', appId, 'noticeInteractions');
            const q = query(coll, where('noticeId', '==', noticeId), where('userId', '==', window.currentUser.uid));
            const snapshot = await getDocs(q);
            if (snapshot.empty) {
                await addDoc(coll, {
                    noticeId,
                    userId: window.currentUser.uid,
                    isLike: !!isLike,
                    timestamp: new Date().toISOString()
                });
            } else {
                const ref = snapshot.docs[0].ref;
                const data = snapshot.docs[0].data();
                if (data.isLike === isLike) {
                    await deleteDoc(ref);
                } else {
                    await setDoc(ref, { isLike: !!isLike, timestamp: new Date().toISOString() }, { merge: true });
                }
            }
            return true;
        } catch (e) {
            console.error("Toggle Notice Like Error:", e);
            throw e;
        }
    }
};

// 관리자: MEAL TALK 게시글 삭제 (Firestore 규칙에서 isAdmin 체크)
export async function deleteBoardPostByAdmin(postId) {
    if (!postId) throw new Error("게시글 ID가 필요합니다.");
    const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
    const postSnap = await getDoc(postDoc);
    if (!postSnap.exists()) throw new Error("게시글을 찾을 수 없습니다.");
    await deleteDoc(postDoc);
}

// 관리자: MEAL TALK 게시글 가리기/가리기 해제 (Firestore 규칙에서 isAdmin 체크)
export async function setBoardPostHidden(postId, hidden) {
    if (!postId) throw new Error("게시글 ID가 필요합니다.");
    const postDoc = doc(db, 'artifacts', appId, 'boardPosts', postId);
    const postSnap = await getDoc(postDoc);
    if (!postSnap.exists()) throw new Error("게시글을 찾을 수 없습니다.");
    await updateDoc(postDoc, { isHidden: !!hidden });
}
