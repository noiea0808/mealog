// 기본 CRUD 작업
import { db, appId, auth } from '../firebase.js';
import { doc, getDoc, setDoc, deleteDoc, collection, addDoc, query, where, getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { showToast } from '../ui.js';
import { logger } from '../utils.js';

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
                    const { storage } = await import('../firebase.js');
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
