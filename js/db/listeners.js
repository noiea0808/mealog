// Firestore 리스너 설정 (읽기 비용 절감: user/tags 세션당 1회, meals 기간·limit 등)
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { doc, getDoc, setDoc, onSnapshot, collection, query, orderBy, limit, where, startAfter, getDocs, getDocsFromServer, documentId } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { DEFAULT_SUB_TAGS, DEFAULT_USER_SETTINGS } from '../constants.js';
import { dbOps } from './ops.js';
import { hideLoading, isLikelyNetworkError } from '../ui.js';
import { notifyTransportOfflineUi } from '../utils/mealog-offline-ui.js';
import { isDemoUser } from '../demo-account.js';
import {
    applyDemoDateShiftToDailyComments,
    applyDemoDateShiftToDailyStats,
    applyDemoDateShiftToSharedPhoto,
    computeDemoDateShiftDaysFromKeyedObject
} from '../demo-date-shift.js';
import { getSharedPhotoGroupKey, processPhotosToGroups } from '../render/post-group-utils.js';
import {
    hydrateMealSyncErrorIdsFromStorage,
    hydrateMealSyncAbandonedIdsFromStorage
} from '../utils/meal-entry-pending.js';
import { applyMealsSnapshotPrimary, applyMealsOneTimeFetchResult } from '../utils/meals-snapshot-apply.js';
import {
    MEALS_LISTENER_FALLBACK_LIMIT,
    isFirestoreIndexError,
    extractFirestoreIndexLink,
    clearMealsLoadDegradedUi,
    showMealsLoadDegradedUi,
    setMealsListenerRetryHandler
} from '../utils/meals-listener-degraded.js';
import { applyStreakTrustPatchesToDailyStats, stripGhostDailyStatsInQueryWindow } from '../meal-record-count.js';
import { sharedPhotoTimestampMs, sortSharedPhotosByTimestampDesc } from '../utils/shared-photo-timestamp.js';
import { collapseDocsToFeedPage, countMomentPostsFromDocs } from '../utils/moment-post-v2.js';

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
    const defM = DEFAULT_USER_SETTINGS.entryModalGauges?.main || {
        ratingEnabled: false,
        satietyEnabled: false,
        timeEnabled: false
    };
    const defS = DEFAULT_USER_SETTINGS.entryModalGauges?.snack || {
        ratingEnabled: false,
        satietyEnabled: false,
        timeEnabled: false
    };
    if (!cur || typeof cur !== 'object') {
        window.userSettings.entryModalGauges = {
            main: { ...defM },
            snack: { ...defS }
        };
        return;
    }
    if (cur.main && cur.snack && typeof cur.main === 'object' && typeof cur.snack === 'object') {
        window.userSettings.entryModalGauges = {
            main: {
                ratingEnabled: cur.main.ratingEnabled === true,
                satietyEnabled: cur.main.satietyEnabled === true,
                timeEnabled: cur.main.timeEnabled === true
            },
            snack: {
                ratingEnabled: cur.snack.ratingEnabled === true,
                satietyEnabled: cur.snack.satietyEnabled === true,
                timeEnabled: cur.snack.timeEnabled === true
            }
        };
        return;
    }
    const r = cur.ratingEnabled === true;
    const s = cur.satietyEnabled === true;
    window.userSettings.entryModalGauges = {
        main: { ratingEnabled: r, satietyEnabled: s, timeEnabled: false },
        snack: { ratingEnabled: r, satietyEnabled: s, timeEnabled: false }
    };
}

export function setupListeners(userId, callbacks) {
    hydrateMealSyncErrorIdsFromStorage();
    hydrateMealSyncAbandonedIdsFromStorage();
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
            
            // user doc 보장과 관리자 태그 로드를 병렬로 처리 (첫 화면 이후 갱신 지연 최소화)
            Promise.resolve().then(async () => {
                const ensureUserDocIfNeeded = async () => {
                    if (userDocEnsureDoneForUid === userId) return;
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
                };

                const loadAndMergeAdminTags = async () => {
                    if (cachedDefaultTags) {
                        if (cachedDefaultTags.mealType?.length) window.userSettings.tags.mealType = [...cachedDefaultTags.mealType];
                        if (cachedDefaultTags.withWhom?.length) window.userSettings.tags.withWhom = [...cachedDefaultTags.withWhom];
                        if (cachedDefaultTags.category?.length) window.userSettings.tags.category = [...cachedDefaultTags.category];
                        if (cachedDefaultTags.snackType?.length) window.userSettings.tags.snackType = [...cachedDefaultTags.snackType];
                        if (cachedDefaultTags.subTagsPlaceSnack?.length) {
                            window.userSettings.tags.snackPlaceMain = [...cachedDefaultTags.subTagsPlaceSnack];
                        }
                        return;
                    }
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
                        if (adminTags.subTagsPlaceSnack && Array.isArray(adminTags.subTagsPlaceSnack) && adminTags.subTagsPlaceSnack.length > 0) {
                            window.userSettings.tags.snackPlaceMain = [...adminTags.subTagsPlaceSnack];
                        }
                        console.log('✅ 관리자 태그 병합 완료 (캐시 저장)');
                    }
                };

                try {
                    await Promise.all([ensureUserDocIfNeeded(), loadAndMergeAdminTags()]);
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
                    try {
                        const { maybeSeedNicknameFromAuthDisplayName } = await import('../auth-nickname-seed.js');
                        await maybeSeedNicknameFromAuthDisplayName();
                    } catch (e) {
                        console.warn('Auth 닉네임 시드(리스너) 스킵:', e?.message || e);
                    }
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

                    // profileCompleted 미정의만 명시(false) — 닉만 있고 플래그 없음으로 true 올리지 않음(온보딩 위저드와 정합)
                    if (settingsToSave.profileCompleted === undefined) {
                        settingsToSave.profileCompleted = false;
                        settingsToSave.profileCompletedAt = settingsToSave.profileCompletedAt || null;
                        needsSave = true;
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
            notifyTransportOfflineUi();
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
            const base = shift ? applyDemoDateShiftToDailyStats(merged, shift) : merged;
            window.dailyStats = applyStreakTrustPatchesToDailyStats(stripGhostDailyStatsInQueryWindow(base));
        } else {
            window.dailyStats = applyStreakTrustPatchesToDailyStats(stripGhostDailyStatsInQueryWindow(merged));
        }
        try {
            if (typeof window.fillProfileActivityStats === 'function') window.fillProfileActivityStats();
        } catch (_) {
            /* ignore */
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
        if (onDataUpdate) onDataUpdate({ source: 'stats', mode: 'statsOnly' });
    };
    const statsUnsubscribes = statsYearsToListen.map(year =>
        onSnapshot(doc(db, 'artifacts', appId, 'users', userId, 'config', 'stats', 'years', year), onStatsYearSnapshot(year), (err) => {
            console.warn('Stats year listener error:', year, err);
            statsYearData[year] = null;
            mergeStatsIntoDaily();
        })
    );
    const statsUnsubscribe = () => statsUnsubscribes.forEach(fn => fn());
    
    // 최근 N일 초기 로드 (스크롤·loadMoreMeals로 추가). 트래커 점은 dailyStats(별도 리스너)로 표시
    // 기간이 짧으면 오래된 기록이 메모리에 없어 수정 모달이 비는 경우가 있어 21일로 완화
    void refreshAppCheckTokenBeforeFirestore();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 21);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    
    const mealsColl = collection(db, 'artifacts', appId, 'users', userId, 'meals');
    const buildMealsPrimaryQuery = () =>
        demo
            ? query(mealsColl, orderBy('date', 'desc'), limit(MEALS_LISTENER_FALLBACK_LIMIT))
            : query(
                  mealsColl,
                  where('date', '>=', cutoffDateStr),
                  orderBy('date', 'desc'),
                  limit(MEALS_LISTENER_FALLBACK_LIMIT)
              );

    let mealsListenerUnsub = null;

    const runMealsLimitedOneTimeFetch = async () => {
        try {
            const limitedQuery = query(
                mealsColl,
                orderBy('date', 'desc'),
                limit(MEALS_LISTENER_FALLBACK_LIMIT)
            );
            const snap = await getDocs(limitedQuery);
            const r = applyMealsOneTimeFetchResult({
                snap,
                demo,
                userId,
                cutoffDateStr,
                todayStr,
                mergeStatsIntoDaily,
                onDataUpdate,
                limit: MEALS_LISTENER_FALLBACK_LIMIT
            });
            if (!r.uidMismatch) {
                showMealsLoadDegradedUi('partial');
            }
        } catch (fetchErr) {
            console.error('Meals limited one-time fetch failed:', fetchErr);
            showMealsLoadDegradedUi('fetch-failed', {
                errorMessage: fetchErr?.message || String(fetchErr)
            });
        } finally {
            hideLoading();
        }
    };

    const handleMealsListenerError = (error) => {
        console.error('Meals Listener Error:', error);
        if (window.currentUser && userId !== window.currentUser.uid) {
            console.error('⚠️ 데이터 리스너 에러 핸들러: 사용자 ID 불일치! 리스너 무시');
            return;
        }
        if (isLikelyNetworkError(error)) {
            hideLoading();
            notifyTransportOfflineUi();
            return;
        }

        try {
            if (mealsListenerUnsub) mealsListenerUnsub();
        } catch (_) {
            /* noop */
        }
        mealsListenerUnsub = null;

        if (isFirestoreIndexError(error)) {
            const indexLink = extractFirestoreIndexLink(error);
            console.error(
                'Meals primary query failed (Firestore index required). Deploy: firebase deploy --only firestore:indexes',
                { code: error?.code, message: error?.message, indexLink }
            );
            showMealsLoadDegradedUi('index', {
                indexLink,
                errorMessage: error?.message || String(error)
            });
            hideLoading();
            return;
        }

        console.warn(
            'Meals primary onSnapshot failed; one-time limited getDocs (no realtime).',
            error
        );
        void runMealsLimitedOneTimeFetch();
    };

    const attachMealsRealtimeListener = () => {
        clearMealsLoadDegradedUi();
        try {
            if (mealsListenerUnsub) mealsListenerUnsub();
        } catch (_) {
            /* noop */
        }

        let isInitialLoad = true;
        mealsListenerUnsub = onSnapshot(
            buildMealsPrimaryQuery(),
            { includeMetadataChanges: true },
            (snap) => {
                clearMealsLoadDegradedUi();
                const loadState = { isInitialLoad };
                const r = applyMealsSnapshotPrimary({
                    snap,
                    demo,
                    userId,
                    cutoffDateStr,
                    todayStr,
                    loadState,
                    mergeStatsIntoDaily,
                    onDataUpdate
                });
                isInitialLoad = loadState.isInitialLoad;
                if (r.uidMismatch) return;
            },
            handleMealsListenerError
        );
    };

    setMealsListenerRetryHandler(() => {
        attachMealsRealtimeListener();
    });
    attachMealsRealtimeListener();

    const dataUnsubscribe = () => {
        setMealsListenerRetryHandler(null);
        try {
            if (mealsListenerUnsub) mealsListenerUnsub();
        } catch (_) {
            /* noop */
        }
        mealsListenerUnsub = null;
        clearMealsLoadDegradedUi();
    };

    return { settingsUnsubscribe, dataUnsubscribe, statsUnsubscribe };
}

/** Firestore Timestamp를 ISO 문자열로 변환 */
function normalizeSharedPhotoDoc(docSnap) {
    const data = docSnap.data();
    if (data.sharedAt && data.sharedAt.toDate) {
        data.sharedAt = data.sharedAt.toDate().toISOString();
    } else if (data.sharedAt && typeof data.sharedAt === 'object' && data.sharedAt.seconds) {
        data.sharedAt = new Date(data.sharedAt.seconds * 1000).toISOString();
    }
    if (data.timestamp && data.timestamp.toDate) {
        data.timestamp = data.timestamp.toDate().toISOString();
    } else if (data.timestamp && typeof data.timestamp === 'object' && data.timestamp.seconds) {
        data.timestamp = new Date(data.timestamp.seconds * 1000).toISOString();
    }
    if (data.schemaVersion === 2 && !data.timestamp && data.sharedAt) {
        data.timestamp = data.sharedAt;
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
    return countMomentPostsFromDocs(docs || []);
}

/** docs를 그룹화했을 때 포스트(그룹) 수 계산 */
function countPostsFromDocs(docs) {
    return countMomentPostsFromDocs(docs);
}

/** docs에서 첫 N개 포스트에 해당하는 문서만 반환 */
function getDocsForFirstNPosts(docs, n) {
    return collapseDocsToFeedPage(docs, n).feedDocs;
}

function toTimestampMs(photo) {
    return sharedPhotoTimestampMs(photo);
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
    // v2: 문서 1개 ≈ 게시물 1개. legacy v1 다장 사진 버퍼용 배수.
    const BATCH_SIZE = startAfterDoc ? Math.max(targetPosts * 2, 15) : Math.max(targetPosts * 2, 20);
    const MAX_DOCS = Math.max(targetPosts * 4, 40);
    let allDocs = [];
    let allDocSnaps = [];
    let lastDoc = startAfterDoc;
    let hasMore = true;
    let lastBatchFull = false;

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
    const sorted = sortSharedPhotosByTimestampDesc(allDocs);
    const collapsed = collapseDocsToFeedPage(sorted, targetPosts);
    const docsToReturn = collapsed.feedDocs;
    const idToSnap = new Map();
    allDocSnaps.forEach(s => idToSnap.set(s.id, s));
    const sortedSnaps = sorted.map(d => idToSnap.get(d.id)).filter(Boolean);

    const hasMorePosts = collapsed.hasMorePosts || lastBatchFull;

    let returnLastDoc = null;
    if (docsToReturn.length > 0) {
        const lastId = docsToReturn[docsToReturn.length - 1].id;
        returnLastDoc = sortedSnaps.find(s => s.id === lastId) || idToSnap.get(lastId) || null;
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

/**
 * 본인의 해당 식사 기록(entryId)에 대응하는 sharedPhotos 문서가 있는지 (최대 1건 읽기).
 * 고아 동기화에서 loadMyShares(100)로 추론하지 않고 entryId 단위로 정확히 판별한다.
 * @param {string} entryId
 * @returns {Promise<boolean>}
 */
export async function hasSharedPhotosForEntry(entryId) {
    if (!window.currentUser || window.currentUser.isAnonymous || !entryId) return false;
    const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
    const uid = window.currentUser.uid;
    try {
        const q = query(
            sharedColl,
            where('userId', '==', uid),
            where('entryId', '==', entryId),
            limit(1)
        );
        const snap = await getDocsFromServer(q);
        return snap.docs.length > 0;
    } catch (e) {
        console.warn('hasSharedPhotosForEntry 실패:', entryId, e?.message || e);
        // 불확실할 때 재공유(타임스탬프 갱신)보다 동기화 생략이 안전
        return true;
    }
}

/** 프로필용: Firestore 한 번에 읽는 문서 수 (100장 한 방 X → 작은 배치) */
const SHARED_PHOTOS_BY_USER_BATCH = 15;
/** 한 번의 사용자 액션(첫 로드·더보기)에서 배치 루프 상한 */
const SHARED_PHOTOS_BY_USER_MAX_BATCHES = 80;

function normalizeSharedPhotoDocForUserQuery(d) {
    return normalizeSharedPhotoDoc(d);
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
        all = collapseDocsToFeedPage(sortSharedPhotoDocsByTimeDesc(all), targetTotalPostCount).feedDocs;
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
