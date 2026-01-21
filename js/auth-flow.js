// 인증 플로우 관리자
// 복잡한 로그인 플로우를 단순하고 명확하게 관리

import { auth } from './firebase.js';
import { dbOps } from './db.js';
import { showToast, switchScreen, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS, CURRENT_TERMS_VERSION } from './constants.js';
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
        // 신규 사용자만 프로필 설정 필요
        if (!this.hasProfile && !this.isExistingUser) return AuthState.NEEDS_PROFILE;
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
        
        // 약관 동의 확인 (약관 버전도 체크)
        const agreedVersion = this.userSettings.termsVersion || null;
        const hasAgreed = this.userSettings.termsAgreed === true;
        
        // termsVersion이 null이지만 termsAgreed가 true인 경우
        // (이전 버전에서 약관에 동의했지만 termsVersion을 저장하지 않은 경우)
        // 기존 사용자로 간주하고 현재 버전에 동의한 것으로 처리
        let versionMatches = false;
        if (agreedVersion !== null) {
            versionMatches = String(agreedVersion) === String(CURRENT_TERMS_VERSION);
        } else if (hasAgreed && !agreedVersion) {
            // termsVersion이 없지만 termsAgreed가 true인 경우, 기존 사용자로 간주
            // 현재 버전에 동의한 것으로 처리하고 termsVersion 저장
            versionMatches = true;
            console.log('⚠️ termsVersion이 없지만 termsAgreed가 true입니다. 현재 버전으로 설정합니다.');
            // termsVersion을 현재 버전으로 업데이트 (비동기로 저장)
            this.userSettings.termsVersion = CURRENT_TERMS_VERSION;
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
            currentVersion: CURRENT_TERMS_VERSION,
            versionMatches: versionMatches,
            finalAgreed: readiness.termsAgreed,
            userSettingsTermsVersion: this.userSettings.termsVersion,
            userSettingsTermsAgreed: this.userSettings.termsAgreed
        });
        
        // 프로필 확인
        readiness.hasProfile = !!(
            this.userSettings.profile &&
            this.userSettings.profile.nickname &&
            this.userSettings.profile.nickname !== '게스트' &&
            this.userSettings.profile.nickname.trim() !== ''
        );
        
        // 기존 사용자 확인
        try {
            readiness.isExistingUser = await this.checkExistingUser(user.uid);
        } catch (e) {
            console.warn('기존 사용자 확인 실패:', e);
            readiness.isExistingUser = false;
        }
        
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
        
        this.user = user;
        
        // 게스트 모드
        if (!user || user.isAnonymous) {
            console.log('👤 게스트 모드로 처리');
            this.currentState = AuthState.GUEST;
            switchScreen(true);
            // 랜딩 페이지 명시적으로 숨김
            const landingPage = document.getElementById('landingPage');
            if (landingPage) {
                landingPage.style.display = 'none';
            }
            this.hasCompleted = true;
            this.lastProcessedUserId = user?.uid;
            hideLoading();
            return;
        }
        
        // Phase 2-1: 불필요한 조건 체크 제거
        // 이미 완료되었거나 처리 중이면 위에서 리턴했으므로 여기서는 진행
        
        // 설정이 없으면 기본값 사용 (main.js에서 이미 대기했으므로 여기서는 확인만)
        if (!window.userSettings) {
            console.warn('⚠️ 설정이 없음. 기본값 사용');
            window.userSettings = JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
        }
        
        // 준비 상태 확인
        const readiness = await this.checkUserReadiness(user);
        
        console.log('✅ 준비 상태:', {
            termsAgreed: readiness.termsAgreed,
            hasProfile: readiness.hasProfile,
            isExistingUser: readiness.isExistingUser
        });
        
        // Phase 2-2: 상태 전이 로직 명확화 - 순차적으로 처리
        // 다음 단계 확인 및 처리 (약관 → 프로필 → 완료)
        const nextStep = readiness.nextStep;
        this.currentState = nextStep;
        await this.processState(this.currentState, readiness);
    }
    
    
    /**
     * 상태별 처리
     */
    async processState(state, readiness) {
        this.isProcessing = true;
        
        try {
            // Phase 2-3: 에러 처리 강화
            const switchMainTab = window.switchMainTab;
            const landingPage = document.getElementById('landingPage');
            
            // Phase 2-2: 상태 전이 로직 명확화 - 각 상태별 명확한 처리
            switch (state) {
                case AuthState.NEEDS_TERMS:
                    // 약관 동의 필요: 랜딩 페이지 유지, 약관 모달 표시
                    // 하지만 설정이 로드된 후 다시 확인했을 때 이미 동의한 경우 모달을 열지 않음
                    if (readiness.termsAgreed) {
                        console.log('⚠️ 약관 동의가 이미 완료되었습니다. 모달을 열지 않습니다.');
                        // 다음 단계로 진행
                        const nextReadiness = await this.checkUserReadiness(this.user);
                        const nextStep = nextReadiness.nextStep;
                        this.currentState = nextStep;
                        await this.processState(this.currentState, nextReadiness);
                    } else {
                        // Firestore 캐시→서버 타이밍으로 인해 agreed인데도 NEEDS_TERMS로 들어올 수 있음.
                        // 모달을 띄우기 전에 잠시 대기 후 재확인하여, 이미 동의한 사용자에게는 모달을 표시하지 않음
                        await new Promise(r => setTimeout(r, 200));
                        const recheck = await this.checkUserReadiness(this.user);
                        if (recheck.termsAgreed) {
                            console.log('✅ 재확인: 약관 동의됨. 모달 생략 후 다음 단계로.');
                            const nextStep = recheck.nextStep;
                            this.currentState = nextStep;
                            await this.processState(this.currentState, recheck);
                        } else {
                            switchScreen(false);
                            showTermsModal();
                        }
                    }
                    break;
                    
                case AuthState.NEEDS_PROFILE:
                    // 프로필 설정 필요: 랜딩 페이지 유지, 프로필 설정 모달 표시
                    switchScreen(false);
                    if (window.showProfileSetupModal) {
                        window.showProfileSetupModal();
                    } else {
                        const { showProfileSetupModal } = await import('./auth.js');
                        showProfileSetupModal();
                    }
                    break;
                    
                case AuthState.READY:
                    // 준비 완료: 메인 화면으로 전환, 완료 플래그 설정
                    // 약관 모달이 열려있으면 닫기
                    closeTermsModal();
                    switchScreen(true);
                    if (landingPage) landingPage.style.display = 'none';
                    if (switchMainTab) switchMainTab('timeline');
                    this.hasCompleted = true;
                    this.lastProcessedUserId = this.user?.uid;
                    console.log('✅ 인증 플로우 완료:', this.user?.uid);
                    break;
                    
                case AuthState.GUEST:
                    // 게스트 모드: 메인 화면으로 전환, 완료 플래그 설정
                    switchScreen(true);
                    if (landingPage) landingPage.style.display = 'none';
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
            // READY나 GUEST 상태가 아니면 로딩 오버레이는 유지 (모달이 표시되므로)
            if (this.currentState === AuthState.READY || this.currentState === AuthState.GUEST) {
                hideLoading();
            }
        }
    }
    
    /**
     * 약관 동의 완료 후 다음 단계로
     * Phase 2-2: 상태 전이 로직 명확화
     */
    async onTermsAgreed() {
        try {
            const readiness = await this.checkUserReadiness(this.user);
            if (readiness) {
                this.currentState = readiness.nextStep;
                await this.processState(this.currentState, readiness);
            }
        } catch (error) {
            console.error('❌ onTermsAgreed 에러:', error);
            hideLoading();
        }
    }
    
    /**
     * 프로필 설정 완료 후 다음 단계로
     * Phase 2-2: 상태 전이 로직 명확화
     */
    async onProfileSetup() {
        try {
            if (!this.user) {
                console.warn('⚠️ onProfileSetup: user가 없음');
                return;
            }
            
            const readiness = await this.checkUserReadiness(this.user);
            if (readiness) {
                this.currentState = readiness.nextStep;
                await this.processState(this.currentState, readiness);
            }
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
