// Firestore 리스너 설정
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc, onSnapshot, collection, query, orderBy, limit, where, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { DEFAULT_SUB_TAGS } from '../constants.js';
import { dbOps } from './ops.js';

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
            import('../constants.js').then(async ({ DEFAULT_USER_SETTINGS }) => {
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
    // sharedPhotos는 게스트(익명)도 읽을 수 있도록 rules에서 request.auth != null 로 허용됨
    // (단, 로그아웃 직전에는 반드시 unsubscribe 해줘야 permission-denied 연쇄를 막을 수 있음)
    if (!window.currentUser) return () => {};
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
