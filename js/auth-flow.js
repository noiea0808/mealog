// 인증 플로우 관리자
// 복잡한 로그인 플로우를 단순하고 명확하게 관리

import { auth } from './firebase.js';
import { dbOps } from './db.js';
import { showToast, switchScreen, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS, CURRENT_TERMS_VERSION } from './constants.js';
import { getCurrentTermsVersion } from './utils-terms.js';
import { showTermsModal, closeTermsModal } from './auth.js';

/**
 * 인증 상태 정의
 */
export const AuthState = {
    UNKNOWN: 'unknown',           // 초기 상태
    GUEST: 'guest',               // 게스트 모드
    NEEDS_TERMS: 'needs_terms',   // 약관 동의 필요
    NEEDS_PROFILE: 'needs_profile', // 프로필 설정 필요
    READY: 'ready'                // 모든 준비 완료
};

/**
 * 사용자 준비 상태 체크 결과
 */
class UserReadiness {
    constructor() {
        this.termsAgreed = false;
        this.hasProfile = false;
        this.isExistingUser = false;
    }
    
    get isReady() {
        return this.termsAgreed && this.hasProfile;
    }
    
    get nextStep() {
        if (!this.termsAgreed) return AuthState.NEEDS_TERMS;
        // 프로필이 완료되지 않았으면 항상 프로필 설정으로 (닉네임 문자열 의존 제거)
        if (!this.hasProfile) return AuthState.NEEDS_PROFILE;
        // 사용자 가이드는 삭제했으므로 프로필 설정 후 바로 완료
        return AuthState.READY;
    }
}

/**
 * 인증 플로우 관리자
 */
export class AuthFlowManager {
    constructor() {
        this.currentState = AuthState.UNKNOWN;
        this.user = null;
        this.userSettings = null;
        this.isProcessing = false;
        this.hasCompleted = false; // 인증 플로우 완료 여부
        this.lastProcessedUserId = null; // 마지막으로 처리한 사용자 ID
        this.termsCheckInProgress = false; // 약관 확인 진행 중 플래그
        this._cachedExistingUser = undefined; // 기존 사용자 캐시 (약관/프로필 모두에서 사용)
        this._existingUserCheckInProgress = false; // 기존 사용자 확인 진행 중 플래그
    }
    
    /**
     * 사용자 준비 상태 확인 (단순화 버전)
     * handleAuthState에서 이미 설정 로드를 대기하므로 여기서는 null을 반환하지 않음
     */
    async checkUserReadiness(user) {
        const readiness = new UserReadiness();
        
        if (!user || user.isAnonymous) {
            return readiness;
        }
        
        // 설정이 없으면 기본값 사용 (이미 handleAuthState에서 처리됨)
        this.userSettings = window.userSettings || JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
        
        // 기존 사용자 확인 (캐시 우선)
        let isExistingUser = false;
        if (this._cachedExistingUser !== undefined) {
            isExistingUser = this._cachedExistingUser;
        } else {
            // 캐시가 없으면 확인
            try {
                isExistingUser = await this.checkExistingUser(user.uid);
                this._cachedExistingUser = isExistingUser;
            } catch (e) {
                console.warn('기존 사용자 확인 실패:', e);
                isExistingUser = false;
            }
        }
        
        // 기존 사용자는 약관과 프로필 모두 완료된 것으로 간주
        if (isExistingUser) {
            readiness.termsAgreed = true;
            readiness.hasProfile = true;
            readiness.isExistingUser = true;
            console.log('✅ 기존 사용자: 약관과 프로필 모두 완료로 처리');
            return readiness;
        }
        
        // 신규 사용자: 약관 동의 확인 (약관 버전도 체크)
        const agreedVersion = this.userSettings.termsVersion || null;
        const hasAgreed = this.userSettings.termsAgreed === true;
        
        // 약관 동의 상태 확인 로직 개선
        // 1. termsAgreed가 false이면 무조건 동의 필요 (신규 사용자)
        // 2. termsAgreed가 true이고 termsVersion이 있으면 버전 비교
        //    - 버전이 일치하면 동의 완료 (모달 표시 안 함)
        //    - 버전이 불일치하면 약관 업데이트됨 (모달 표시)
        // 3. termsAgreed가 true이지만 termsVersion이 없으면 기존 사용자로 간주 (동의 완료 처리)
        
        let versionMatches = false;
        
        if (!hasAgreed) {
            // 약관에 동의하지 않음 - 신규 사용자
            versionMatches = false;
        } else if (agreedVersion !== null && agreedVersion !== '') {
            // termsVersion이 있는 경우: Firestore에서 현재 버전 가져와서 비교
            let currentVersion = CURRENT_TERMS_VERSION; // 기본값
            let versionCheckFailed = false;
            
            try {
                currentVersion = await getCurrentTermsVersion();
            } catch (e) {
                console.warn('약관 버전 가져오기 실패, 기본값 사용:', e);
                versionCheckFailed = true;
            }
            
            if (versionCheckFailed) {
                // 버전 확인 실패 시: 기존 사용자로 간주하고 동의 완료 처리
                // 네트워크 문제 등으로 인한 오탐 방지 - 약관 모달을 표시하지 않음
                versionMatches = true;
                console.log('⚠️ 약관 버전 확인 실패했지만, 기존 사용자로 간주하여 동의 완료 처리합니다.');
            } else {
                // 버전 비교 (정규화하여 비교)
                const normalizedAgreed = String(agreedVersion).trim();
                const normalizedCurrent = String(currentVersion).trim();
                versionMatches = normalizedAgreed === normalizedCurrent;
                
                if (!versionMatches) {
                    console.log('📋 약관 버전 불일치 (약관 업데이트됨):', {
                        동의한_버전: normalizedAgreed,
                        현재_버전: normalizedCurrent
                    });
                } else {
                    console.log('✅ 약관 버전 일치 (약관 업데이트 없음):', {
                        버전: normalizedAgreed
                    });
                }
            }
        } else {
            // termsVersion이 없지만 termsAgreed가 true인 경우
            // 기존 사용자로 간주하고 현재 버전에 동의한 것으로 처리
            versionMatches = true;
            console.log('✅ 기존 사용자 (termsVersion 없음): 약관 동의 완료로 처리');
            
            // Firestore에서 현재 버전 가져오기 (에러 발생 시 기본값 사용)
            let currentVersion = CURRENT_TERMS_VERSION;
            try {
                currentVersion = await getCurrentTermsVersion();
            } catch (e) {
                console.warn('약관 버전 가져오기 실패, 기본값 사용:', e);
            }
            
            // termsVersion을 현재 버전으로 업데이트 (비동기로 저장)
            this.userSettings.termsVersion = currentVersion;
            if (window.dbOps) {
                window.dbOps.saveSettings(this.userSettings).catch(e => {
                    console.warn('termsVersion 업데이트 실패:', e);
                });
            }
        }
        
        readiness.termsAgreed = hasAgreed && versionMatches;
        
        // 디버깅 로그 (항상 출력)
        console.log('📋 약관 동의 상태 확인:', {
            termsAgreed: hasAgreed,
            agreedVersion: agreedVersion,
            versionMatches: versionMatches,
            finalAgreed: readiness.termsAgreed,
            userSettingsTermsVersion: this.userSettings.termsVersion,
            userSettingsTermsAgreed: this.userSettings.termsAgreed
        });
        
        // 프로필 확인: profileCompleted 플래그를 1차 기준으로 사용
        // (구버전 데이터 호환을 위해, 플래그가 없으면 기존 닉네임 기준으로만 임시 판단)
        if (this.userSettings.profileCompleted === true) {
            readiness.hasProfile = true;
        } else if (this.userSettings.profileCompleted === false) {
            readiness.hasProfile = false;
        } else {
            // legacy fallback
            readiness.hasProfile = !!(
                this.userSettings.profile &&
                this.userSettings.profile.nickname &&
                this.userSettings.profile.nickname !== '게스트' &&
                this.userSettings.profile.nickname.trim() !== ''
            );
        }
        
        readiness.isExistingUser = false;
        
        return readiness;
    }
    
    /**
     * 기존 사용자 확인 (meals 데이터 존재 여부)
     */
    async checkExistingUser(uid) {
        try {
            const { collection, query, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
            const { db, appId } = await import('./firebase.js');
            const mealsColl = collection(db, 'artifacts', appId, 'users', uid, 'meals');
            const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
            return !mealsSnapshot.empty;
        } catch (e) {
            console.error('기존 사용자 확인 실패:', e);
            return false;
        }
    }
    
    /**
     * 인증 상태에 따른 화면 전환 처리 (단순화 버전)
     * 약관과 프로필은 백그라운드에서 확인하고, 먼저 메인 화면으로 입장
     */
    async handleAuthState(user) {
        // 이미 완료된 사용자면 무시
        if (this.hasCompleted && this.lastProcessedUserId === user?.uid) {
            console.log('⏸️ 인증 플로우 이미 완료됨. 중복 호출 무시');
            return;
        }
        
        if (this.isProcessing) {
            console.log('⏸️ 인증 플로우 처리 중... 중복 호출 무시');
            return; // 중복 처리 방지
        }
        
        console.log('🚀 handleAuthState 시작:', {
            uid: user?.uid,
            isAnonymous: user?.isAnonymous,
            hasUserSettings: !!window.userSettings,
            hasCompleted: this.hasCompleted,
            lastProcessedUserId: this.lastProcessedUserId
        });
        
        // 사용자가 변경되면 캐시 초기화
        if (this.lastProcessedUserId !== user?.uid) {
            this._cachedExistingUser = undefined;
            this._existingUserCheckInProgress = false;
        }
        
        this.user = user;
        
        // 게스트 모드
        if (!user || user.isAnonymous) {
            console.log('👤 게스트 모드로 처리');
            this.currentState = AuthState.GUEST;
            closeTermsModal();
            // 프로필 설정 모달도 닫기 (게스트로 둘러보기 후 뒤에 남아 있을 수 있음)
            const profileSetupModal = document.getElementById('profileSetupModal');
            if (profileSetupModal) profileSetupModal.classList.add('hidden');
            switchScreen(true);
            // ✅ 초기 진입에서도 타임라인 렌더가 되도록 탭을 명시적으로 세팅
            const switchMainTab = window.switchMainTab;
            if (switchMainTab) switchMainTab('timeline');
            this.hasCompleted = true;
            this.lastProcessedUserId = user?.uid;
            // 둘러보기 방문 기록 (main.js에서도 기록하지만, 게스트 화면 진입 시점에서 한 번 더 보장)
            if (user?.uid && typeof window.recordGuestVisit === 'function') {
                window.recordGuestVisit(user.uid).catch(() => {});
            }
            hideLoading();
            return;
        }
        
        // 설정이 없으면 기본값 사용 (main.js에서 이미 대기했으므로 여기서는 확인만)
        if (!window.userSettings) {
            console.warn('⚠️ 설정이 없음. 기본값 사용');
            window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
        }
        
        // 일단 메인 화면으로 입장 (약관과 프로필은 백그라운드에서 확인)
        console.log('✅ 메인 화면으로 입장 (약관/프로필은 백그라운드에서 확인)');
        this.currentState = AuthState.READY;
        const switchMainTab = window.switchMainTab;
        closeTermsModal();
        switchScreen(true);
        if (switchMainTab) switchMainTab('timeline');
        // 밀로그 메인 화면에서 기록 로드 중 메시지 표시 (onDataUpdate에서 meals 로드 시 hideLoading)
        if (!window._recordsLoadHidePending) {
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false });
            // 데이터가 이미 로드된 경우(레이스) 즉시 숨김
            queueMicrotask(() => {
                if (window._recordsLoadHidePending && window.loadedMealsDateRange) {
                    window._recordsLoadHidePending = false;
                    hideLoading();
                }
            });
        }
        
        // 백그라운드에서 약관과 프로필 확인 (블로킹하지 않음)
        this.checkTermsAndProfileInBackground(user).catch(e => {
            console.warn('⚠️ 백그라운드 약관/프로필 확인 실패:', e);
        });
    }
    
    /**
     * 프로필만 확인하는 간단한 준비 상태 체크 (약관 제외)
     * 기존 사용자는 프로필이 완료된 것으로 간주
     */
    async checkUserReadinessForProfile(user) {
        const readiness = new UserReadiness();
        
        if (!user || user.isAnonymous) {
            return readiness;
        }
        
        // 설정이 없으면 기본값 사용
        this.userSettings = window.userSettings || JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
        
        // 기존 사용자 확인 (캐시 우선 사용)
        let isExistingUser = false;
        
        // 캐시가 있으면 사용
        if (this._cachedExistingUser !== undefined) {
            isExistingUser = this._cachedExistingUser;
            console.log('✅ 프로필 확인: 캐시된 기존 사용자 정보 사용', { isExistingUser });
        } else {
            // 캐시가 없으면 확인 (이미 확인 중이면 대기하지 않음)
            if (!this._existingUserCheckInProgress) {
                this._existingUserCheckInProgress = true;
                try {
                    isExistingUser = await this.checkExistingUser(user.uid);
                    this._cachedExistingUser = isExistingUser;
                    console.log('✅ 프로필 확인: 기존 사용자 확인 완료', { isExistingUser });
                } catch (e) {
                    console.warn('기존 사용자 확인 실패 (프로필 확인):', e);
                    // 에러 발생 시 신규 사용자로 간주
                    isExistingUser = false;
                } finally {
                    this._existingUserCheckInProgress = false;
                }
            } else {
                // 이미 확인 중이면 잠시 대기 후 재확인
                await new Promise(r => setTimeout(r, 100));
                if (this._cachedExistingUser !== undefined) {
                    isExistingUser = this._cachedExistingUser;
                }
            }
        }
        
        if (isExistingUser) {
            // 기존 사용자는 프로필이 완료된 것으로 간주
            readiness.hasProfile = true;
            console.log('✅ 프로필 확인: 기존 사용자로 확인됨. 프로필 완료로 처리');
            
            // profileCompleted 플래그가 없으면 설정 (마이그레이션)
            if (this.userSettings.profileCompleted !== true) {
                this.userSettings.profileCompleted = true;
                if (!this.userSettings.profileCompletedAt) {
                    this.userSettings.profileCompletedAt = new Date().toISOString();
                }
                // 비동기로 저장 (블로킹하지 않음)
                if (window.dbOps) {
                    window.dbOps.saveSettings(this.userSettings).catch(e => {
                        console.warn('profileCompleted 플래그 업데이트 실패:', e);
                    });
                }
            }
            
            // 약관은 일단 true로 설정 (백그라운드에서 확인)
            readiness.termsAgreed = true;
            return readiness;
        }
        
        // 신규 사용자: 프로필 확인 로직
        // 프로필 확인: profileCompleted 플래그를 1차 기준으로 사용
        if (this.userSettings.profileCompleted === true) {
            readiness.hasProfile = true;
            console.log('✅ 프로필 확인: profileCompleted 플래그가 true');
        } else if (this.userSettings.profileCompleted === false) {
            readiness.hasProfile = false;
            console.log('❌ 프로필 확인: profileCompleted 플래그가 false');
        } else {
            // legacy fallback: 닉네임으로 확인
            const hasNickname = !!(
                this.userSettings.profile &&
                this.userSettings.profile.nickname &&
                this.userSettings.profile.nickname !== '게스트' &&
                this.userSettings.profile.nickname.trim() !== ''
            );
            readiness.hasProfile = hasNickname;
            
            if (hasNickname) {
                console.log('✅ 프로필 확인: 닉네임이 설정되어 있음 (legacy fallback)', {
                    nickname: this.userSettings.profile?.nickname
                });
            } else {
                console.log('❌ 프로필 확인: 닉네임이 없거나 유효하지 않음 (legacy fallback)', {
                    hasProfile: !!this.userSettings.profile,
                    nickname: this.userSettings.profile?.nickname
                });
            }
        }
        
        // 약관은 일단 true로 설정 (백그라운드에서 확인)
        readiness.termsAgreed = true;
        
        return readiness;
    }
    
    /**
     * 백그라운드에서 약관과 프로필 상태 확인 및 필요시 모달 표시
     * 약관 > 프로필 순서로 확인하고 표시
     */
    async checkTermsAndProfileInBackground(user) {
        // 이미 확인 중이면 중복 실행 방지
        if (this.termsCheckInProgress) {
            console.log('⏸️ 약관/프로필 확인 이미 진행 중. 중복 호출 무시');
            return;
        }
        
        this.termsCheckInProgress = true;
        
        try {
            console.log('🔍 백그라운드에서 약관 및 프로필 상태 확인 시작');
            
            // 기존 사용자 확인 (캐시 우선)
            let isExistingUser = false;
            if (this._cachedExistingUser !== undefined) {
                isExistingUser = this._cachedExistingUser;
                console.log('✅ 기존 사용자 확인: 캐시 사용', { isExistingUser });
            } else {
                if (!this._existingUserCheckInProgress) {
                    this._existingUserCheckInProgress = true;
                    try {
                        isExistingUser = await this.checkExistingUser(user.uid);
                        this._cachedExistingUser = isExistingUser;
                        console.log('✅ 기존 사용자 확인 완료', { isExistingUser });
                    } catch (e) {
                        console.warn('기존 사용자 확인 실패:', e);
                        isExistingUser = false;
                    } finally {
                        this._existingUserCheckInProgress = false;
                    }
                } else {
                    // 이미 확인 중이면 잠시 대기
                    await new Promise(r => setTimeout(r, 200));
                    if (this._cachedExistingUser !== undefined) {
                        isExistingUser = this._cachedExistingUser;
                    }
                }
            }
            
            // 기존 사용자는 약관과 프로필 모두 완료된 것으로 간주
            if (isExistingUser) {
                console.log('✅ 기존 사용자: 약관과 프로필 모두 완료로 처리. 모달을 표시하지 않습니다.');
                this.hasCompleted = true;
                this.lastProcessedUserId = user?.uid;
                return;
            }
            
            // 신규 사용자: 약관과 프로필 확인
            const readiness = await this.checkUserReadiness(user);
            
            console.log('✅ 약관 및 프로필 상태 확인 완료:', {
                termsAgreed: readiness.termsAgreed,
                hasProfile: readiness.hasProfile
            });
            
            // 약관 또는 프로필 필요 시 페이지 형식 위저드 표시
            if (!readiness.termsAgreed) {
                console.log('📋 약관 동의 필요: 위저드(페이지 형식) 표시');
                window._recordsLoadHidePending = false;
                switchScreen(false);
                hideLoading();
                const { openSignupWizard } = await import('./signup-wizard.js');
                if (readiness.hasProfile) {
                    // 기존 회원 약관 업데이트: 4페이지만 (1/1)
                    openSignupWizard({ startStep: 4, totalSteps: 1, isTermsOnly: true });
                } else {
                    // 신규: 닉네임 → 생년월일/성별/라이프스타일 → 약관 (2/4 ~ 4/4)
                    openSignupWizard({ startStep: 2, totalSteps: 4, isEmailSignup: false });
                }
                return;
            }
            
            if (!readiness.hasProfile) {
                console.log('📋 프로필 설정 필요: 위저드(페이지 형식) 표시');
                window._recordsLoadHidePending = false;
                switchScreen(false);
                hideLoading();
                const { openSignupWizard } = await import('./signup-wizard.js');
                openSignupWizard({ startStep: 2, totalSteps: 4, isEmailSignup: false });
            } else {
                console.log('✅ 약관과 프로필 모두 완료됨. 모달을 표시하지 않습니다.');
                this.hasCompleted = true;
                this.lastProcessedUserId = user?.uid;
            }
        } catch (error) {
            console.error('❌ 백그라운드 약관/프로필 확인 에러:', error);
        } finally {
            this.termsCheckInProgress = false;
        }
    }
    
    /**
     * 백그라운드에서 약관 동의 상태 확인 및 필요시 모달 표시
     * @deprecated checkTermsAndProfileInBackground로 대체됨
     */
    async checkTermsInBackground(user) {
        // 기존 함수 호환성을 위해 유지하지만, 새로운 함수로 위임
        return this.checkTermsAndProfileInBackground(user);
    }
    
    
    /**
     * 상태별 처리
     */
    async processState(state, readiness) {
        this.isProcessing = true;
        
        try {
            // Phase 2-3: 에러 처리 강화
            const switchMainTab = window.switchMainTab;
            
            // Phase 2-2: 상태 전이 로직 명확화 - 각 상태별 명확한 처리
            switch (state) {
                case AuthState.NEEDS_TERMS:
                    console.log('📋 약관 동의 필요: 위저드(페이지 형식) 표시');
                    switchScreen(false);
                    const { openSignupWizard: openWizardTerms } = await import('./signup-wizard.js');
                    openWizardTerms(readiness.hasProfile ? { startStep: 4, totalSteps: 1, isTermsOnly: true } : { startStep: 2, totalSteps: 4, isEmailSignup: false });
                    hideLoading();
                    break;
                    
                case AuthState.NEEDS_PROFILE:
                    const profileReadiness = await this.checkUserReadinessForProfile(this.user);
                    
                    if (profileReadiness.hasProfile) {
                        console.log('✅ 프로필이 이미 설정되어 있습니다.');
                        this.currentState = AuthState.READY;
                        await this.processState(this.currentState, profileReadiness);
                    } else {
                        console.log('📋 프로필 설정 필요: 위저드(페이지 형식) 표시');
                        switchScreen(false);
                        const { openSignupWizard: openWizardProfile } = await import('./signup-wizard.js');
                        openWizardProfile({ startStep: 2, totalSteps: 4, isEmailSignup: false });
                        hideLoading();
                    }
                    break;
                    
                case AuthState.READY:
                    // 준비 완료: 메인 화면으로 전환, 완료 플래그 설정
                    // 약관 모달이 열려있으면 닫기
                    closeTermsModal();
                    switchScreen(true);
                    if (switchMainTab) switchMainTab('timeline');
                    this.hasCompleted = true;
                    this.lastProcessedUserId = this.user?.uid;
                    console.log('✅ 인증 플로우 완료:', this.user?.uid);
                    break;
                    
                case AuthState.GUEST:
                    // 게스트 모드: 메인 화면으로 전환, 완료 플래그 설정
                    switchScreen(true);
                    if (switchMainTab) switchMainTab('timeline');
                    this.hasCompleted = true;
                    this.lastProcessedUserId = this.user?.uid;
                    console.log('✅ 게스트 모드 완료');
                    break;
                    
                default:
                    console.warn('⚠️ 알 수 없는 상태:', state);
                    hideLoading();
            }
        } catch (error) {
            // Phase 2-3: 에러 처리 강화
            console.error('❌ processState 에러:', error);
            console.error('상태:', state);
            console.error('에러 상세:', error.stack);
            hideLoading();
            showToast('인증 처리 중 오류가 발생했습니다.', 'error');
            throw error; // 에러를 다시 던져서 호출자가 처리할 수 있도록
        } finally {
            this.isProcessing = false;
            // 모달/화면 전환이 끝났으면 로딩 오버레이는 내려야 함
            // 단, READY 상태에서 _recordsLoadHidePending이면 기록 로드 대기 중이므로 hideLoading 건너뜀
            if (
                this.currentState === AuthState.READY ||
                this.currentState === AuthState.GUEST ||
                this.currentState === AuthState.NEEDS_TERMS ||
                this.currentState === AuthState.NEEDS_PROFILE
            ) {
                if (!(this.currentState === AuthState.READY && window._recordsLoadHidePending)) {
                    hideLoading();
                }
            }
        }
    }
    
    /**
     * 약관 동의 완료 후 다음 단계로
     * 약관 동의 후에는 프로필 확인하고 필요하면 프로필 모달 표시
     */
    async onTermsAgreed() {
        try {
            // 약관 모달 닫기
            closeTermsModal();
            
            // 프로필 상태 확인
            const readiness = await this.checkUserReadiness(this.user);
            
            // 프로필 상태에 따라 진행
            if (readiness.hasProfile) {
                // 프로필 완료: 메인 화면으로
                console.log('✅ 약관 동의 완료, 프로필도 완료됨. 메인 화면으로 진행');
                switchScreen(true);
                this.hasCompleted = true;
                this.lastProcessedUserId = this.user?.uid;
            } else {
                // 프로필 미완료: 프로필 설정 모달 표시
                console.log('📋 약관 동의 완료, 프로필 설정 필요: 모달 표시');
                if (window.showProfileSetupModal) {
                    window.showProfileSetupModal();
                } else {
                    const { showProfileSetupModal } = await import('./auth.js');
                    showProfileSetupModal();
                }
            }
        } catch (error) {
            console.error('❌ onTermsAgreed 에러:', error);
            hideLoading();
        }
    }
    
    /**
     * 프로필 설정 완료 후 다음 단계로
     * 프로필 설정 후에는 바로 메인 화면으로 진행
     */
    async onProfileSetup() {
        try {
            if (!this.user) {
                console.warn('⚠️ onProfileSetup: user가 없음');
                return;
            }
            
            console.log('✅ 프로필 설정 완료. 메인 화면으로 진행');
            switchScreen(true);
            this.hasCompleted = true;
            this.lastProcessedUserId = this.user?.uid;
        } catch (error) {
            console.error('❌ onProfileSetup 에러:', error);
            hideLoading();
        }
    }
    
}

// 싱글톤 인스턴스
export const authFlowManager = new AuthFlowManager();

// 전역 함수로 노출 (기존 코드 호환성)
window.authFlowManager = authFlowManager;
