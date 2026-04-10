// Firestore 리스너 설정 (읽기 비용 절감: user/tags 세션당 1회, meals 기간·limit 등)
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc, onSnapshot, collection, query, orderBy, limit, where, startAfter, getDocs, getDocsFromServer, documentId, enableNetwork } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { DEFAULT_SUB_TAGS, DEFAULT_USER_SETTINGS } from '../constants.js';
import { dbOps } from './ops.js';
import { hideLoading, showNetworkErrorOverlay, isLikelyNetworkError } from '../ui.js';
import { isDemoUser } from '../demo-account.js';
import {
    addDaysToYmd,
    applyDemoDateShiftToDailyComments,
    applyDemoDateShiftToDailyStats,
    applyDemoDateShiftToMeals,
    applyDemoDateShiftToSharedPhoto,
    computeDemoDateShiftDays,
    computeDemoDateShiftDaysFromKeyedObject,
    todayLocalYmd
} from '../demo-date-shift.js';
import { processPhotosToGroups } from '../render/post-group-utils.js';

/** 세션당 1회만 실행 (Firestore 읽기 절감) */
let userDocEnsureDoneForUid = null;
let cachedDefaultTags = null;
let lastListenersUserId = null;

function mergePushPreferencesIntoUserSettings() {
    if (!window.userSettings) return;
    const ppDef = DEFAULT_USER_SETTINGS.pushPreferences || {};
    window.userSettings.pushPreferences = {
        ...ppDef,
        ...(window.userSettings.pushPreferences && typeof window.userSettings.pushPreferences === 'object'
            ? window.userSettings.pushPreferences
            : {})
    };
}

function mergeEntryModalGaugesIntoUserSettings() {
    if (!window.userSettings) return;
    const cur = window.userSettings.entryModalGauges;
    window.userSettings.entryModalGauges = {
        ratingEnabled: cur && cur.ratingEnabled === true,
        satietyEnabled: cur && cur.satietyEnabled === true
    };
}

export function setupListeners(userId, callbacks) {
    const { onSettingsUpdate, onDataUpdate, settingsUnsubscribe: oldSettingsUnsubscribe, dataUnsubscribe: oldDataUnsubscribe } = callbacks;
    
    // 사용자 ID 확인 및 로깅
    console.log('🔧 setupListeners 호출:', { 
        userId, 
        currentUser: window.currentUser?.uid,
        isMatch: userId === window.currentUser?.uid
    });

    // ✅ 게스트(익명) 사용자는 Firestore 읽기 권한이 없을 수 있으므로 리스너를 시작하지 않음
    // main.js에서도 차단하지만, 혹시 다른 경로에서 호출되더라도 안전하게 막는다.
    if (!userId || !window.currentUser || window.currentUser.isAnonymous) {
        if (oldSettingsUnsubscribe) oldSettingsUnsubscribe();
        if (oldDataUnsubscribe) oldDataUnsubscribe();
        const noop = () => {};
        return { settingsUnsubscribe: noop, dataUnsubscribe: noop };
    }

    const demo = isDemoUser(window.currentUser);
    if (!demo) {
        delete window.__demoDateShiftDays;
        delete window.__demoRawDailyComments;
    }
    
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
    
    // 사용자 전환 시 태그 캐시 초기화 (읽기 절감: 동일 사용자 세션에서는 1회만 태그 로드)
    if (lastListenersUserId !== userId) {
        cachedDefaultTags = null;
        lastListenersUserId = userId;
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
                    snackType: {},
                    snackPlace: {}
                };
            }
            if (!window.userSettings.tags) {
                window.userSettings.tags = {};
            }
            mergePushPreferencesIntoUserSettings();
            mergeEntryModalGaugesIntoUserSettings();
            if (demo) {
                try {
                    window.__demoRawDailyComments = JSON.parse(JSON.stringify(window.userSettings.dailyComments || {}));
                    const sh = Number(window.__demoDateShiftDays);
                    if (sh) {
                        window.userSettings.dailyComments = applyDemoDateShiftToDailyComments(
                            window.__demoRawDailyComments,
                            sh
                        );
                    }
                } catch (_) {}
            }
            // 첫 화면을 빨리 보여주기 위해 user doc·태그 로드 전에 먼저 콜백 호출
            console.log('📞 onSettingsUpdate 콜백 호출 (초기)');
            if (onSettingsUpdate) onSettingsUpdate();
            
            // user doc 생성·관리자 태그는 백그라운드에서 처리 (초기 로딩 지연 최소화)
            Promise.resolve().then(async () => {
                if (userDocEnsureDoneForUid !== userId) {
                    try {
                        const userDocRef = doc(db, 'artifacts', appId, 'users', userId);
                        const userDocSnap = await getDoc(userDocRef);
                        if (!userDocSnap.exists()) {
                            // 가입 완료(createdAt)는 프로필 설정 후에만 등록. main.js updateUserDocument/ensureUserRegistered에서 처리
                            await setDoc(userDocRef, {
                                lastLoginAt: new Date().toISOString()
                            }, { merge: true });
                            console.log('✅ users/{userId} 문서 생성 (가입일은 프로필 설정 후 등록):', userId);
                        }
                        userDocEnsureDoneForUid = userId;
                    } catch (e) {
                        console.warn('users/{userId} 문서 생성 실패:', e);
                    }
                }
                try {
                    if (cachedDefaultTags) {
                        if (cachedDefaultTags.mealType?.length) window.userSettings.tags.mealType = [...cachedDefaultTags.mealType];
                        if (cachedDefaultTags.withWhom?.length) window.userSettings.tags.withWhom = [...cachedDefaultTags.withWhom];
                        if (cachedDefaultTags.category?.length) window.userSettings.tags.category = [...cachedDefaultTags.category];
                        if (cachedDefaultTags.snackType?.length) window.userSettings.tags.snackType = [...cachedDefaultTags.snackType];
                        if (cachedDefaultTags.subTagsPlaceSnack?.length) {
                            window.userSettings.tags.snackPlaceMain = [...cachedDefaultTags.subTagsPlaceSnack];
                        }
                    } else {
                        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
                        const tagsSnap = await getDoc(tagsDoc);
                        if (tagsSnap.exists()) {
                            const adminTags = tagsSnap.data();
                            cachedDefaultTags = {
                                mealType: adminTags.mealType,
                                withWhom: adminTags.withWhom,
                                category: adminTags.category,
                                snackType: adminTags.snackType,
                                subTagsPlaceSnack: adminTags.subTagsPlaceSnack
                            };
                            if (adminTags.mealType?.length) window.userSettings.tags.mealType = [...adminTags.mealType];
                            if (adminTags.withWhom?.length) window.userSettings.tags.withWhom = [...adminTags.withWhom];
                            if (adminTags.category?.length) window.userSettings.tags.category = [...adminTags.category];
                            if (adminTags.snackType?.length) window.userSettings.tags.snackType = [...adminTags.snackType];
                            // 간식 어디서: 관리자 메인태그 순서대로 사용 (메인태그는 칩으로, 개별 태그는 사용자 설정에서 등록)
                            if (adminTags.subTagsPlaceSnack && Array.isArray(adminTags.subTagsPlaceSnack) && adminTags.subTagsPlaceSnack.length > 0) {
                                window.userSettings.tags.snackPlaceMain = [...adminTags.subTagsPlaceSnack];
                            }
                            console.log('✅ 관리자 태그 병합 완료 (캐시 저장)');
                        }
                    }
                    if (onSettingsUpdate) onSettingsUpdate();
                } catch (e) {
                    console.warn('⚠️ 관리자 태그 로드 실패 (기본값 사용):', e);
                    if (onSettingsUpdate) onSettingsUpdate();
                }
            });
            
            // 마이그레이션 로직을 비동기로 처리하여 초기 로딩 지연 최소화
            if (!migrationInProgress) {
                migrationInProgress = true;
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

                    // ✅ profileCompleted 마이그레이션: 구버전 사용자는 플래그가 없을 수 있으므로,
                    // 닉네임이 유효하면 완료로 간주하여 다음 로그인에서 프로필 모달이 뜨지 않게 한다.
                    if (settingsToSave.profileCompleted !== true) {
                        const nn = (settingsToSave.profile?.nickname || '').trim();
                        if (nn && nn !== '게스트') {
                            settingsToSave.profileCompleted = true;
                            settingsToSave.profileCompletedAt = settingsToSave.profileCompletedAt || new Date().toISOString();
                            needsSave = true;
                            console.log('✅ 마이그레이션: profileCompleted=true 설정');
                        } else if (settingsToSave.profileCompleted === undefined) {
                            // 플래그 자체가 없고 닉네임도 미설정이면 false로 명시
                            settingsToSave.profileCompleted = false;
                            settingsToSave.profileCompletedAt = settingsToSave.profileCompletedAt || null;
                            needsSave = true;
                        }
                    }
                    
                    // providerId와 email 업데이트 (없을 때만 추가, 이미 있으면 유지)
                    // 주의: providerId는 로그인 방법이므로 변경되면 안 됨 (덮어쓰지 않음)
                    try {
                        const { auth } = await import('../firebase.js');
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

                    // 집밥·배달/포장 기본 서브태그 '우리집' (태그 관리에서 사용자가 수정·삭제 가능)
                    if (!settingsToSave.subTags) settingsToSave.subTags = {};
                    if (!Array.isArray(settingsToSave.subTags.place)) settingsToSave.subTags.place = [];
                    const placeSubs = settingsToSave.subTags.place;
                    const hasPlaceSub = (text, parent) =>
                        placeSubs.some((item) => {
                            const t = typeof item === 'string' ? item : item?.text;
                            const p = typeof item === 'string' ? null : item?.parent;
                            return t === text && p === parent;
                        });
                    if (!hasPlaceSub('우리집', '집밥')) {
                        placeSubs.push({ text: '우리집', parent: '집밥' });
                        needsSave = true;
                    }
                    if (!hasPlaceSub('우리집', '배달/포장')) {
                        placeSubs.push({ text: '우리집', parent: '배달/포장' });
                        needsSave = true;
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
            // snap.exists()=false: 신규 사용자(설정 문서 없음) 또는 캐시 미스. 서버에서 먼저 확인해 한 번만 올바른 데이터로 onSettingsUpdate 호출.
            const settingsRef = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
            try {
                const serverSnap = await getDoc(settingsRef, { source: 'server' });
                if (window.currentUser && userId !== window.currentUser.uid) return;
                if (serverSnap.exists()) {
                    window.userSettings = serverSnap.data();
                    if (!window.userSettings.subTags) window.userSettings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));
                    if (!window.userSettings.favoriteSubTags) window.userSettings.favoriteSubTags = { mealType: {}, category: {}, withWhom: {}, snackType: {}, snackPlace: {} };
                    mergePushPreferencesIntoUserSettings();
                    mergeEntryModalGaugesIntoUserSettings();
                    if (demo) {
                        try {
                            window.__demoRawDailyComments = JSON.parse(JSON.stringify(window.userSettings.dailyComments || {}));
                            const sh = Number(window.__demoDateShiftDays);
                            if (sh) {
                                window.userSettings.dailyComments = applyDemoDateShiftToDailyComments(
                                    window.__demoRawDailyComments,
                                    sh
                                );
                            }
                        } catch (_) {}
                    }
                    console.log('📥 설정 서버에서 로드 (캐시 미스 시): termsAgreed=', window.userSettings.termsAgreed);
                    if (onSettingsUpdate) onSettingsUpdate();
                    return;
                }
            } catch (e) {
                console.warn('설정 서버 재확인 실패, 기본값 사용:', e);
            }
            if (window.currentUser && userId !== window.currentUser.uid) return;
            window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
            console.log('📥 설정 문서 없음. 기본값으로 인증 플로우 진행.');
            if (onSettingsUpdate) onSettingsUpdate();
        }
    }, async (error) => {
        console.error("Settings Listener Error:", error);
        console.error("에러 상세:", {
            code: error.code,
            message: error.message,
            userId: userId
        });

        if (isLikelyNetworkError(error)) {
            hideLoading();
            showNetworkErrorOverlay();
            return;
        }

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
                    import('../constants.js').then(async ({ DEFAULT_USER_SETTINGS }) => {
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
        import('../constants.js').then(({ DEFAULT_USER_SETTINGS }) => {
            window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
            if (onSettingsUpdate) onSettingsUpdate();
        }).catch(e => {
            console.error('기본 설정 로드 실패:', e);
            if (onSettingsUpdate) onSettingsUpdate();
        });
    });
    
    // Meals 리스너 - 최근 7일(최대 50건) 초기 로드
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
    
    // Stats 리스너 (연도별 서브컬렉션: config/stats/years/{year}) — meals 콜백에서 mergeStatsIntoDaily 호출하므로 먼저 정의
    // 현재 연도 + 이전 연도 구독 (연말/연초 경계 대비)
    let statsBackfillRequested = false;
    const statsYearData = {};
    const statsYearsToListen = [
        String(new Date().getFullYear()),
        String(new Date().getFullYear() - 1)
    ];
    const mergeStatsIntoDaily = () => {
        const merged = {};
        Object.values(statsYearData).forEach((yearDaily) => {
            if (yearDaily && typeof yearDaily === 'object') {
                Object.assign(merged, yearDaily);
            }
        });
        let shift = 0;
        if (demo) {
            if (window.__demoDateShiftDays != null && !Number.isNaN(Number(window.__demoDateShiftDays))) {
                shift = Number(window.__demoDateShiftDays);
            } else {
                shift = computeDemoDateShiftDaysFromKeyedObject(merged);
            }
            window.dailyStats = shift ? applyDemoDateShiftToDailyStats(merged, shift) : merged;
        } else {
            window.dailyStats = merged;
        }
    };
    const onStatsYearSnapshot = (year) => (snap) => {
        if (window.currentUser && userId !== window.currentUser.uid) return;
        if (snap.exists() && snap.data().daily) {
            statsYearData[year] = snap.data().daily;
        } else {
            statsYearData[year] = null;
        }
        mergeStatsIntoDaily();
        const hasAnyData = Object.values(statsYearData).some(v => v && Object.keys(v).length > 0);
        if (!hasAnyData && !statsBackfillRequested && window.currentUser && !window.currentUser.isAnonymous && !demo) {
            statsBackfillRequested = true;
            import('../firebase.js').then(({ callableFunctions }) => {
                callableFunctions.backfillUserStats().then(() => {
                    console.log('✅ stats backfill 완료');
                }).catch(e => {
                    console.warn('stats backfill 실패:', e);
                });
            }).catch(() => {});
        }
        if (onDataUpdate) onDataUpdate();
    };
    const statsUnsubscribes = statsYearsToListen.map(year =>
        onSnapshot(doc(db, 'artifacts', appId, 'users', userId, 'config', 'stats', 'years', year), onStatsYearSnapshot(year), (err) => {
            console.warn('Stats year listener error:', year, err);
            statsYearData[year] = null;
            mergeStatsIntoDaily();
        })
    );
    const statsUnsubscribe = () => statsUnsubscribes.forEach(fn => fn());
    
    // 최근 7일 초기 로드 (스크롤·loadMoreMeals로 추가 로드). 트래커 점은 dailyStats(별도 리스너)로 표시
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 7);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    
    const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
    // limit(50): 초기 읽기/전송량 제한 → 나머지는 loadMoreMeals로 로드
    // 데모: 고정 샘플 날짜가 7일 밖이면 비어 보이므로 날짜 필터 없이 최근 50건만 로드 후 화면용 날짜 시프트
    const mealsQuery = demo
        ? query(mealsColl, orderBy('date', 'desc'), limit(50))
        : query(
            mealsColl,
            where('date', '>=', cutoffDateStr),
            orderBy('date', 'desc'),
            limit(50)
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
        if (demo) {
            const rawMeals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const shift = computeDemoDateShiftDays(rawMeals);
            window.__demoDateShiftDays = shift;
            window.mealHistory = applyDemoDateShiftToMeals(rawMeals, shift).sort(
                (a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time)
            );
            const rawDates = rawMeals
                .map((m) => m.date)
                .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
            if (rawDates.length && shift) {
                const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
                window.loadedMealsDateRange = {
                    start: addDaysToYmd(minRaw, shift),
                    end: todayLocalYmd()
                };
            } else if (rawDates.length) {
                const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
                const maxRaw = rawDates.reduce((a, b) => (a > b ? a : b));
                window.loadedMealsDateRange = { start: minRaw, end: maxRaw };
            } else {
                const tl = todayLocalYmd();
                window.loadedMealsDateRange = { start: tl, end: tl };
            }
            if (window.userSettings && window.__demoRawDailyComments) {
                window.userSettings.dailyComments = applyDemoDateShiftToDailyComments(
                    window.__demoRawDailyComments,
                    shift
                );
            }
            mergeStatsIntoDaily();
            isInitialLoad = false;
            if (onDataUpdate) onDataUpdate();
            import('../db.js').then(({ loadMyShares }) => {
                loadMyShares().then((list) => {
                    window.sharedPhotos = list;
                    if (typeof window.updateTimelineShareIndicators === 'function') {
                        window.updateTimelineShareIndicators();
                    }
                }).catch(() => {});
            }).catch(() => {});
            return;
        }
        if (isInitialLoad) {
            // 초기 로드: 최근 7일(최대 50건) 데이터
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
                    const slotKey = `${docData.date || ''}__${docData.slotId || ''}`;
                    const isPendingUpload = Boolean(
                        window._pendingPhotoUploadByEntryId?.[docData.id] ||
                        window._pendingPhotoUploadBySlotKey?.[slotKey]
                    );
                    if (index >= 0) {
                        const localRecord = window.mealHistory[index];
                        const incomingPhotos = Array.isArray(docData.photos)
                            ? docData.photos
                            : (docData.photos ? [docData.photos] : []);
                        const localPhotos = Array.isArray(localRecord?.photos)
                            ? localRecord.photos
                            : (localRecord?.photos ? [localRecord.photos] : []);
                        const hasLocalBase64Preview = localPhotos.some(
                            (p) => typeof p === 'string' && p.startsWith('data:image')
                        );
                        const shouldKeepLocalPreview = isPendingUpload && hasLocalBase64Preview;
                        
                        // 낙관 반영 직후 1차 스냅샷(photos 비어있음)으로 미리보기가 사라지는 깜빡임 방지
                        if (shouldKeepLocalPreview) {
                            window.mealHistory[index] = { ...docData, photos: [...localPhotos] };
                        } else {
                            window.mealHistory[index] = docData;
                        }
                    } else {
                        // 신규 저장 직후: 임시 ID 낙관 레코드(temp_*)를 실제 서버 ID로 치환해 깜빡임/중복 방지
                        const tempIdx = window.mealHistory.findIndex((m) =>
                            typeof m?.id === 'string' &&
                            m.id.startsWith('temp_') &&
                            m.date === docData.date &&
                            m.slotId === docData.slotId
                        );
                        if (tempIdx >= 0) {
                            const tempRecord = window.mealHistory[tempIdx];
                            const incomingPhotos = Array.isArray(docData.photos)
                                ? docData.photos
                                : (docData.photos ? [docData.photos] : []);
                            const tempPhotos = Array.isArray(tempRecord?.photos)
                                ? tempRecord.photos
                                : (tempRecord?.photos ? [tempRecord.photos] : []);
                            const hasTempBase64 = tempPhotos.some(
                                (p) => typeof p === 'string' && p.startsWith('data:image')
                            );
                            const keepTempPreview = (isPendingUpload || Boolean(window._pendingPhotoUploadByEntryId?.[tempRecord.id])) && hasTempBase64;
                            window.mealHistory[tempIdx] = keepTempPreview
                                ? { ...docData, photos: [...tempPhotos] }
                                : docData;
                            if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                                window.sharedPhotos = window.sharedPhotos.map((p) => (
                                    p.entryId === tempRecord.id ? { ...p, entryId: docData.id } : p
                                ));
                            }
                            if (window._pendingPhotoUploadByEntryId?.[tempRecord.id]) {
                                window._pendingPhotoUploadByEntryId[docData.id] = true;
                                delete window._pendingPhotoUploadByEntryId[tempRecord.id];
                            }
                        } else {
                            // 새로 추가된 문서 (1개월 범위 내)
                            window.mealHistory.push(docData);
                        }
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
        if (isLikelyNetworkError(error)) {
            hideLoading();
            showNetworkErrorOverlay();
            return;
        }
        // 인덱스가 없을 경우 fallback: 전체 컬렉션 사용 (경고만 표시)
        console.warn("날짜 범위 쿼리 실패, 전체 컬렉션으로 fallback");
        const fallbackQuery = collection(db, 'artifacts', appId, 'users', userId, 'meals');
        return onSnapshot(
            fallbackQuery,
            (snap) => {
                // 사용자 ID 재확인 (fallback 리스너 내부에서)
                if (window.currentUser && userId !== window.currentUser.uid) {
                    console.error('⚠️ Fallback 리스너: 사용자 ID 불일치! 무시');
                    return;
                }
                if (demo) {
                    let rawMeals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                    rawMeals.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
                    rawMeals = rawMeals.slice(0, 50);
                    const shift = computeDemoDateShiftDays(rawMeals);
                    window.__demoDateShiftDays = shift;
                    window.mealHistory = applyDemoDateShiftToMeals(rawMeals, shift).sort(
                        (a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time)
                    );
                    const rawDates = rawMeals
                        .map((m) => m.date)
                        .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
                    if (rawDates.length && shift) {
                        const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
                        window.loadedMealsDateRange = {
                            start: addDaysToYmd(minRaw, shift),
                            end: todayLocalYmd()
                        };
                    } else if (rawDates.length) {
                        const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
                        const maxRaw = rawDates.reduce((a, b) => (a > b ? a : b));
                        window.loadedMealsDateRange = { start: minRaw, end: maxRaw };
                    } else {
                        const tl = todayLocalYmd();
                        window.loadedMealsDateRange = { start: tl, end: tl };
                    }
                    if (window.userSettings && window.__demoRawDailyComments) {
                        window.userSettings.dailyComments = applyDemoDateShiftToDailyComments(
                            window.__demoRawDailyComments,
                            shift
                        );
                    }
                    mergeStatsIntoDaily();
                    import('../db.js').then(({ loadMyShares }) => {
                        loadMyShares().then((list) => {
                            window.sharedPhotos = list;
                            if (typeof window.updateTimelineShareIndicators === 'function') {
                                window.updateTimelineShareIndicators();
                            }
                        }).catch(() => {});
                    }).catch(() => {});
                } else {
                    window.mealHistory = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                        .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
                }
                if (onDataUpdate) onDataUpdate();
            },
            (err2) => {
                console.error('Meals fallback listener error:', err2);
                hideLoading();
                if (isLikelyNetworkError(err2)) {
                    showNetworkErrorOverlay();
                }
            }
        );
    });
    
    return { settingsUnsubscribe, dataUnsubscribe, statsUnsubscribe };
}

/** Firestore Timestamp를 ISO 문자열로 변환 */
function normalizeSharedPhotoDoc(docSnap) {
    const data = docSnap.data();
    if (data.timestamp && data.timestamp.toDate) {
        data.timestamp = data.timestamp.toDate().toISOString();
    } else if (data.timestamp && typeof data.timestamp === 'object' && data.timestamp.seconds) {
        data.timestamp = new Date(data.timestamp.seconds * 1000).toISOString();
    }
    return { id: docSnap.id, ...data };
}

/** 데모 계정 본인 공유만 date 필드를 화면용으로 시프트 (글로벌 피드에서는 본인 문서만) */
function applyDemoShiftToSharedDocsIfNeeded(docs) {
    if (!Array.isArray(docs) || !docs.length || !window.currentUser) return docs;
    if (!isDemoUser(window.currentUser)) return docs;
    const sh = Number(window.__demoDateShiftDays) || 0;
    if (!sh) return docs;
    const uid = window.currentUser.uid;
    return docs.map((p) => (p.userId === uid ? applyDemoDateShiftToSharedPhoto(p, sh) : p));
}

/** 프로필 모먼트 그리드와 동일: photoUrl 중복 제거 + 그룹 키 (processPhotosToGroups 길이) */
function profileMomentGridGroupCount(docs) {
    return processPhotosToGroups(docs || []).length;
}

/** docs를 그룹화했을 때 포스트(그룹) 수 계산 (그룹 키만 세는 버전 — 피드 배치 로직용) */
function countPostsFromDocs(docs) {
    const seen = new Set();
    (docs || []).forEach(photo => {
        let groupKey;
        if (photo.type === 'daily') groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        else if (photo.type === 'best') groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        else if (photo.type === 'insight') groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        else if (photo.entryId) groupKey = `${photo.entryId}_${photo.userId}`;
        else groupKey = `no-entry_${photo.userId}`;
        seen.add(groupKey);
    });
    return seen.size;
}

/** docs에서 첫 N개 포스트에 해당하는 문서만 반환 (countPostsFromDocs와 동일한 그룹 키 로직) */
function getDocsForFirstNPosts(docs, n) {
    const seen = new Set();
    let postCount = 0;
    const result = [];
    for (const photo of docs) {
        let groupKey;
        if (photo.type === 'daily') groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        else if (photo.type === 'best') groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        else if (photo.type === 'insight') groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        else if (photo.entryId) groupKey = `${photo.entryId}_${photo.userId}`;
        else groupKey = `no-entry_${photo.userId}`;
        if (!seen.has(groupKey)) {
            if (postCount >= n) break;
            postCount++;
            seen.add(groupKey);
        }
        result.push(photo);
    }
    return result;
}

/** timestamp를 ms로 변환 (Firestore Timestamp, ISO 문자열, seconds 등 혼합 형식 대응)
 * timestamp 없으면 date+time 조합으로 fallback (일부 문서에 timestamp 누락 시) */
function toTimestampMs(photo) {
    const t = photo?.timestamp;
    if (t != null && t !== '') {
        if (t.toDate) return t.toDate().getTime();
        if (typeof t === 'string') return new Date(t).getTime();
        if (t.seconds != null) return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6;
        if (t instanceof Date) return t.getTime();
        if (typeof t === 'number') return t;
    }
    // fallback: date + time
    const d = photo?.date;
    const tm = photo?.time || '12:00:00';
    if (d && typeof d === 'string') {
        const timePart = String(tm).split(':').length === 2 ? tm + ':00' : tm;
        const ms = new Date(d + 'T' + timePart).getTime();
        if (!isNaN(ms)) return ms;
    }
    return 0;
}

/** 모먼트 피드 최신 공유 1건의 시각(ms). 하단 네비 신규 공유 점 표시용 (1회 읽기) */
export async function peekLatestSharedPhotoTimestampMs() {
    if (!window.currentUser) return 0;
    try {
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        const q = query(sharedColl, orderBy('timestamp', 'desc'), limit(1));
        const snap = await getDocsFromServer(q);
        if (!snap.docs.length) return 0;
        const photo = normalizeSharedPhotoDoc(snap.docs[0]);
        const [shifted] = applyDemoShiftToSharedDocsIfNeeded([photo]);
        return toTimestampMs(shifted || photo);
    } catch (e) {
        console.warn('peekLatestSharedPhotoTimestampMs:', e?.message || e);
        return 0;
    }
}

/** 공유 사진 페이지네이션 로드 (갤러리/피드용). 포스트 targetPosts건만 반환, 나머지는 더보기로 로드
 * 항상 getDocsFromServer 사용 - 캐시로 인해 새 공유가 안 보이는 문제 방지 (읽기 최적화 후 발생)
 * 클라이언트 정렬: timestamp 혼합 타입(문자열/Timestamp) 시 Firestore 정렬 순서가 꼬이는 문제 방지 */
export async function loadSharedPhotosPage(targetPosts = 10, startAfterDoc = null) {
    if (!window.currentUser) return { docs: [], lastDoc: null, hasMore: false };
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const BATCH_SIZE = startAfterDoc ? 30 : 60; // 페이지네이션 시 30건씩 (포스트 10개 충족용)
    const MAX_DOCS = 120;
    let allDocs = [];
    let allDocSnaps = []; // DocumentSnapshot 배열 (startAfter용)
    let lastDoc = startAfterDoc;
    let hasMore = true;
    let lastBatchFull = false;

    // targetPosts(포스트 수) 충족 시까지 페치 (한 번에 60건 등 가져올 수 있음)
    while (hasMore && countPostsFromDocs(allDocs) < targetPosts && allDocs.length < MAX_DOCS) {
        let q = query(sharedColl, orderBy('timestamp', 'desc'), limit(BATCH_SIZE));
        if (lastDoc) q = query(sharedColl, orderBy('timestamp', 'desc'), startAfter(lastDoc), limit(BATCH_SIZE));
        const snap = await getDocsFromServer(q);
        const batch = snap.docs.map(d => normalizeSharedPhotoDoc(d));
        allDocs = allDocs.concat(batch);
        allDocSnaps = allDocSnaps.concat(snap.docs);
        lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
        lastBatchFull = snap.docs.length === BATCH_SIZE;
        hasMore = lastBatchFull;
        if (batch.length < BATCH_SIZE) break;
    }
    // timestamp 혼합 타입 시 Firestore 정렬 꼬임 방지 → 클라이언트에서 최신순 정렬
    const sorted = [...allDocs].sort((a, b) => toTimestampMs(b) - toTimestampMs(a));
    // 정렬 후 doc id 순서로 allDocSnaps 재매칭 (정렬과 동일 순서로)
    const idToSnap = new Map();
    allDocSnaps.forEach(s => idToSnap.set(s.id, s));
    const sortedSnaps = sorted.map(d => idToSnap.get(d.id)).filter(Boolean);

    // 첫 targetPosts개 포스트에 해당하는 문서만 반환 (10건씩 끊어서 표시)
    const docsToReturn = getDocsForFirstNPosts(sorted, targetPosts);
    const totalPostsFetched = countPostsFromDocs(sorted);
    const hasMorePosts = totalPostsFetched > targetPosts || lastBatchFull;

    // lastDoc: 반환하는 마지막 문서의 DocumentSnapshot (다음 페이지 startAfter용)
    let returnLastDoc = null;
    if (docsToReturn.length > 0) {
        const lastId = docsToReturn[docsToReturn.length - 1].id;
        returnLastDoc = sortedSnaps.find(s => s.id === lastId) || null;
    }

    const shifted = applyDemoShiftToSharedDocsIfNeeded(docsToReturn);
    return { docs: shifted, lastDoc: returnLastDoc, hasMore: hasMorePosts };
}

/**
 * 모먼트 피드 첫 로드/재시도용: 오프라인·불안정 직후 getDocsFromServer 일시 실패 시 재시도.
 * (다시 불러오기·당겨서 새로고침에서 공통 사용)
 */
export async function loadSharedPhotosPageReliable(targetPosts = 10, startAfterDoc = null, opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 3;
    const baseDelayMs = opts.baseDelayMs ?? 320;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            if (attempt > 0) {
                await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
            }
            try {
                await enableNetwork(db);
            } catch (_) {
                /* ignore */
            }
            return await loadSharedPhotosPage(targetPosts, startAfterDoc);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr;
}

/** 본인 공유만 조회 (타임라인 공유 표시, 일간/베스트/인사이트 공유 확인용)
 * 항상 getDocsFromServer 사용 - 캐시로 인해 sync/표시 불일치 방지 */
export async function loadMyShares() {
    if (!window.currentUser || window.currentUser.isAnonymous) return [];
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const uid = window.currentUser.uid;
    try {
        const q = query(
            sharedColl,
            where('userId', '==', uid),
            orderBy('timestamp', 'desc'),
            limit(100)
        );
        const snap = await getDocsFromServer(q);
        return applyDemoShiftToSharedDocsIfNeeded(snap.docs.map(d => normalizeSharedPhotoDoc(d)));
    } catch (e) {
        if (e?.code === 'failed-precondition' && /index|indexes/i.test(String(e?.message || ''))) {
            console.warn('⚠️ loadMyShares 인덱스 필요:', e?.message);
            if (e?.message && /https:\/\//.test(e.message)) {
                const linkMatch = e.message.match(/https:\/\/[^\s]+/);
                if (linkMatch) console.warn('인덱스 생성 링크:', linkMatch[0]);
            }
            const qFallback = query(sharedColl, where('userId', '==', uid), limit(100));
            const snap = await getDocsFromServer(qFallback);
            const docs = snap.docs.map(d => normalizeSharedPhotoDoc(d));
            docs.sort((a, b) => {
                const ta = (a.timestamp && new Date(a.timestamp).getTime()) || 0;
                const tb = (b.timestamp && new Date(b.timestamp).getTime()) || 0;
                return tb - ta;
            });
            return applyDemoShiftToSharedDocsIfNeeded(docs);
        }
        throw e;
    }
}

/** 프로필용: Firestore 한 번에 읽는 문서 수 (100장 한 방 X → 작은 배치) */
const SHARED_PHOTOS_BY_USER_BATCH = 15;
/** 한 번의 사용자 액션(첫 로드·더보기)에서 배치 루프 상한 */
const SHARED_PHOTOS_BY_USER_MAX_BATCHES = 80;

function normalizeSharedPhotoDocForUserQuery(d) {
    const data = d.data();
    if (data.timestamp && data.timestamp.toDate) {
        data.timestamp = data.timestamp.toDate().toISOString();
    } else if (data.timestamp && typeof data.timestamp === 'object' && data.timestamp.seconds) {
        data.timestamp = new Date(data.timestamp.seconds * 1000).toISOString();
    }
    return { id: d.id, ...data };
}

function sortSharedPhotoDocsByTimeDesc(docs) {
    return [...docs].sort((a, b) => {
        const ta = (a.timestamp && new Date(a.timestamp).getTime()) || 0;
        const tb = (b.timestamp && new Date(b.timestamp).getTime()) || 0;
        return tb - ta;
    });
}

/**
 * sharedPhotos를 batchSize개씩만 읽어 한 번 반환 (timestamp 경로 우선).
 * @returns {{ pairs: { doc: object, snap: import('@firebase/firestore').QueryDocumentSnapshot }[], lastDocSnap: import('@firebase/firestore').QueryDocumentSnapshot | null, batchWasFull: boolean }}
 */
async function fetchSharedPhotosByUserBatch(userId, startAfterSnap, batchSize) {
    if (!userId) {
        return { pairs: [], lastDocSnap: null, batchWasFull: false };
    }
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const normalize = (docSnap) => normalizeSharedPhotoDocForUserQuery(docSnap);
    const lim = Math.max(1, Math.min(batchSize, 30));

    try {
        let q = query(
            sharedColl,
            where('userId', '==', userId),
            orderBy('timestamp', 'desc'),
            limit(lim)
        );
        if (startAfterSnap) {
            q = query(
                sharedColl,
                where('userId', '==', userId),
                orderBy('timestamp', 'desc'),
                startAfter(startAfterSnap),
                limit(lim)
            );
        }
        const snap = await getDocsFromServer(q);
        const pairs = snap.docs.map((docSnap) => ({ doc: normalize(docSnap), snap: docSnap }));
        const lastDocSnap = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
        return { pairs, lastDocSnap, batchWasFull: snap.docs.length === lim };
    } catch (e) {
        if (e?.code === 'failed-precondition' && /index|indexes/i.test(String(e?.message || ''))) {
            console.warn('⚠️ fetchSharedPhotosByUserBatch 인덱스 필요:', e?.message);
            if (e?.message && /https:\/\//.test(e.message)) {
                const linkMatch = e.message.match(/https:\/\/[^\s]+/);
                if (linkMatch) console.warn('인덱스 생성 링크:', linkMatch[0]);
            }
            try {
                let qFb = query(
                    sharedColl,
                    where('userId', '==', userId),
                    orderBy(documentId()),
                    limit(lim)
                );
                if (startAfterSnap) {
                    qFb = query(
                        sharedColl,
                        where('userId', '==', userId),
                        orderBy(documentId()),
                        startAfter(startAfterSnap),
                        limit(lim)
                    );
                }
                const snap = await getDocsFromServer(qFb);
                const pairs = snap.docs.map((docSnap) => ({ doc: normalize(docSnap), snap: docSnap }));
                const pairById = new Map(pairs.map((p) => [p.doc.id, p]));
                const sortedDocs = sortSharedPhotoDocsByTimeDesc(pairs.map((p) => p.doc));
                const sortedPairs = sortedDocs.map((d) => pairById.get(d.id)).filter(Boolean);
                const lastDocSnap = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
                return { pairs: sortedPairs, lastDocSnap, batchWasFull: snap.docs.length === lim };
            } catch (e2) {
                console.warn('⚠️ fetchSharedPhotosByUserBatch documentId 폴백 실패:', e2?.message || e2);
                const qFallback = query(sharedColl, where('userId', '==', userId), limit(lim));
                const snap = await getDocsFromServer(qFallback);
                const pairs = snap.docs.map((docSnap) => ({ doc: normalize(docSnap), snap: docSnap }));
                const pairById = new Map(pairs.map((p) => [p.doc.id, p]));
                const sortedDocs = sortSharedPhotoDocsByTimeDesc(pairs.map((p) => p.doc));
                const sortedPairs = sortedDocs.map((d) => pairById.get(d.id)).filter(Boolean);
                return { pairs: sortedPairs, lastDocSnap: null, batchWasFull: false };
            }
        }
        throw e;
    }
}

function pickOldestSharedPhotoDocByTime(docs) {
    if (!docs || !docs.length) return null;
    return docs.reduce((a, b) => (toTimestampMs(a) <= toTimestampMs(b) ? a : b));
}

/**
 * 프로필 모먼트: 게시물(그룹) 개수가 targetTotalPostCount 이상이 될 때까지 batch만큼씩만 Firestore 읽기.
 * @param seedDocs 이미 메모리에 있는 문서(추가 로드 시)
 * @param docSnapById 프로필 세션 동안 유지할 id→QueryDocumentSnapshot (갤러리 appState 맵). null이면 호출 한정 새 Map
 */
export async function loadSharedPhotosByUserUpToPostCount(userId, startAfterSnap, targetTotalPostCount, seedDocs = [], docSnapById = null) {
    if (!userId || targetTotalPostCount < 1) {
        return { docs: [], lastDocSnap: null, hasMore: false };
    }
    const seen = new Set((seedDocs || []).map((d) => d.id));
    let all = sortSharedPhotoDocsByTimeDesc(seedDocs || []);
    let last = startAfterSnap;
    let lastBatchWasFull = false;
    let batches = 0;
    const snapById = docSnapById ?? new Map();

    if (profileMomentGridGroupCount(all) >= targetTotalPostCount) {
        const oldest0 = pickOldestSharedPhotoDocByTime(all);
        let lastOut = startAfterSnap;
        if (oldest0 && snapById.has(oldest0.id)) {
            lastOut = snapById.get(oldest0.id);
        }
        const keptIds0 = new Set(all.map((d) => d.id));
        for (const id of [...snapById.keys()]) {
            if (!keptIds0.has(id)) snapById.delete(id);
        }
        return {
            docs: applyDemoShiftToSharedDocsIfNeeded(all),
            lastDocSnap: lastOut,
            hasMore: !!startAfterSnap
        };
    }

    while (batches < SHARED_PHOTOS_BY_USER_MAX_BATCHES && profileMomentGridGroupCount(all) < targetTotalPostCount) {
        const { pairs, lastDocSnap, batchWasFull } = await fetchSharedPhotosByUserBatch(userId, last, SHARED_PHOTOS_BY_USER_BATCH);
        batches++;
        lastBatchWasFull = batchWasFull;
        if (!pairs.length) break;
        for (const { doc: d, snap } of pairs) {
            if (!seen.has(d.id)) {
                seen.add(d.id);
                snapById.set(d.id, snap);
                all.push(d);
            }
        }
        all = sortSharedPhotoDocsByTimeDesc(all);
        last = lastDocSnap;
        if (!batchWasFull) break;
    }

    if (profileMomentGridGroupCount(all) > targetTotalPostCount) {
        const groups = processPhotosToGroups(all);
        const keepIds = new Set();
        for (const g of groups.slice(0, targetTotalPostCount)) {
            for (const p of g) keepIds.add(p.id);
        }
        all = sortSharedPhotoDocsByTimeDesc(all.filter((d) => keepIds.has(d.id)));
    }

    let lastDocSnapOut = last;
    const oldest = pickOldestSharedPhotoDocByTime(all);
    if (oldest && snapById.has(oldest.id)) {
        lastDocSnapOut = snapById.get(oldest.id);
    }

    const keptIds = new Set(all.map((d) => d.id));
    for (const id of [...snapById.keys()]) {
        if (!keptIds.has(id)) snapById.delete(id);
    }

    return {
        docs: applyDemoShiftToSharedDocsIfNeeded(all),
        lastDocSnap: lastDocSnapOut,
        hasMore: lastBatchWasFull
    };
}

/** @deprecated 프로필은 loadSharedPhotosByUserUpToPostCount 사용. 하위 호환용 단일 배치(최대 15문서). */
export async function loadSharedPhotosByUserPage(userId, startAfterSnap = null) {
    return fetchSharedPhotosByUserBatch(userId, startAfterSnap, SHARED_PHOTOS_BY_USER_BATCH).then(({ pairs, lastDocSnap, batchWasFull }) => ({
        docs: applyDemoShiftToSharedDocsIfNeeded(pairs.map((p) => p.doc)),
        lastDocSnap,
        hasMore: batchWasFull
    }));
}

/** 특정 사용자 공유 — 약 그리드 1면(게시물 ~15그룹) 분량만 읽기 */
export async function getSharedPhotosByUser(userId) {
    const { docs } = await loadSharedPhotosByUserUpToPostCount(userId, null, 15, [], new Map());
    return docs;
}
