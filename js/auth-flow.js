// 인증 플로우 관리자
// 복잡한 로그인 플로우를 단순하고 명확하게 관리

import { auth, db, appId } from './firebase.js';
import { dbOps } from './db.js';
import { showToast, switchScreen, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS, CURRENT_TERMS_VERSION, DEFAULT_SUB_TAGS } from './constants.js';
import { getCurrentTermsVersion } from './utils-terms.js';
import { showTermsModal, closeTermsModal } from './auth.js';
import { isDemoUser, maybeShowDemoIntroModal } from './demo-account.js';
import { syncDemoNavGuideDots } from './demo-nav-guide.js';
import { isProfileWizardCompleted } from './profile-readiness.js';
import { maybeSeedNicknameFromAuthDisplayName } from './auth-nickname-seed.js';

/**
 * 설정 문서를 서버에서 한 번 읽어 window.userSettings를 맞춤.
 * 저장 직후 onSnapshot이 캐시된 이전 스냅샷으로 덮어쓰면 약관이 '미동의'로 보이는 루프가 나므로,
 * onTermsAgreed / onProfileSetup 직전에 호출한다.
 */
async function hydrateUserSettingsFromServer(uid) {
    if (!uid || typeof window === 'undefined') return false;
    try {
        const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js');
        const ref = doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings');
        const snap = await getDoc(ref, { source: 'server' });
        if (!snap.exists()) return false;
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
        return true;
    } catch (e) {
        console.warn('hydrateUserSettingsFromServer 실패:', e?.message || e);
        return false;
    }
}

/**
 * 앱에서 약관 단계를 건너뛸 수 있는지 (온보딩·재동의 판별)
 * — termsAgreed === true 이고 termsVersion 비어 있지 않으며 **현재 서비스 버전과 일치**
 * — 버전만 다르면 재동의 (약관 업데이트)
 */
async function isTermsAgreementRecordedAndCurrent(settings) {
    if (!settings || settings.termsAgreed !== true) return false;
    const v = settings.termsVersion;
    if (v == null || String(v).trim() === '') return false;
    let current = CURRENT_TERMS_VERSION;
    try {
        current = await getCurrentTermsVersion();
    } catch (e) {
        console.warn('isTermsAgreementRecordedAndCurrent: 현재 약관 버전 조회 실패, constants 로 비교', e);
    }
    return String(v).trim() === String(current).trim();
}

/**
 * termsAgreed === true 인데 termsVersion 이 비어 있으면, 현재 서비스 버전으로 저장 (DB·레거시 스냅샷 정리)
 * — 온보딩 위저드 없이 한 번만 merge 저장
 */
async function maybeBackfillTermsVersionFromAgreement(uid) {
    if (!uid || typeof window === 'undefined') return;
    if (auth.currentUser && isDemoUser(auth.currentUser)) return;
    const ws = window.userSettings;
    if (!ws || ws.termsAgreed !== true) return;
    const v = ws.termsVersion;
    if (v != null && String(v).trim() !== '') return;
    try {
        const current = await getCurrentTermsVersion();
        window.userSettings = { ...ws, termsVersion: current };
        await dbOps.saveSettings(window.userSettings);
        console.log('✅ 약관 동의만 있고 버전 없음 → termsVersion 백필:', current);
    } catch (e) {
        console.warn('약관 버전 백필 저장 실패:', e?.message || e);
    }
}

/** hasCompleted 직후 호출 — onDataUpdate가 더 이상 안 오는 경우에도 출석 팝업이 뜨도록 */
function queueAttendanceCheck() {
    const run = () => {
        import('./attendance-check.js')
            .then((m) => m.scheduleAttendanceCheckIfNeeded())
            .catch((e) => console.warn('웰컴 출석 체크 모듈 로드/실행 실패:', e));
    };
    queueMicrotask(run);
    /** hasCompleted 직전에만 onDataUpdate가 끝난 경우 1회 재시도 (로컬·캐시 타이밍) */
    setTimeout(run, 650);
}

/** Firebase에서 방금 만든 계정의 첫 로그인(creation≈lastSignIn) — Auth만 재생성·Firestore 설정은 남은 고아 문서일 때 온보딩 재요청 */
function isLikelyFirstSessionAfterAccountCreate(user) {
    if (!user?.metadata?.creationTime || !user?.metadata?.lastSignInTime) return false;
    const c = new Date(user.metadata.creationTime).getTime();
    const l = new Date(user.metadata.lastSignInTime).getTime();
    if (!Number.isFinite(c) || !Number.isFinite(l)) return false;
    return Math.abs(l - c) < 120000;
}

/** 카카오 웹 로그인 직후 1회만 자동 가입 위저드 허용 (auth.js에서 OAuth 성공 시 설정) */
const KAKAO_PROFILE_SETUP_GATE_KEY = 'mealog_kakaoProfileSetupGate';
/** localStorage 타임스탬프 유효 시간 (OAuth 직후 다른 탭에서도 인정) */
const KAKAO_PROFILE_GATE_TTL_MS = 30 * 60 * 1000;
/** sessionStorage 없을 때 보조: 직전 로그인으로 간주하는 시간 (다른 탭·게이트 소비 타이밍 완화) */
const KAKAO_PROFILE_GATE_RECENT_SIGNIN_MS = 25 * 60 * 1000;

function kakaoProfileGateUidKey(uid) {
    return `mealog_kakaoProfileSetupGateUid_${uid}`;
}

/**
 * 카카오 프로필 온보딩 허용 여부 — sessionStorage + localStorage + 최근 로그인(보조)
 */
function isKakaoProfileSetupGateOpen(user) {
    try {
        if (sessionStorage.getItem(KAKAO_PROFILE_SETUP_GATE_KEY) === '1') return true;
    } catch (_) {}
    const uid = user?.uid;
    if (!uid) return false;
    try {
        const raw = localStorage.getItem(kakaoProfileGateUidKey(uid));
        if (raw) {
            const ts = Number(raw);
            if (Number.isFinite(ts) && Date.now() - ts <= KAKAO_PROFILE_GATE_TTL_MS) return true;
            localStorage.removeItem(kakaoProfileGateUidKey(uid));
        }
    } catch (_) {}
    try {
        const last = user?.metadata?.lastSignInTime;
        if (!last) return false;
        const t = new Date(last).getTime();
        if (!Number.isFinite(t)) return false;
        if (Date.now() - t <= KAKAO_PROFILE_GATE_RECENT_SIGNIN_MS) return true;
    } catch (_) {}
    return false;
}

/** OAuth 직후 플래그 정리 — 가입 위저드 저장 완료 시 signup-wizard에서 호출 */
export function consumeKakaoProfileSetupGate(user) {
    try {
        sessionStorage.removeItem(KAKAO_PROFILE_SETUP_GATE_KEY);
    } catch (_) {}
    const uid = user?.uid;
    if (uid) {
        try {
            localStorage.removeItem(kakaoProfileGateUidKey(uid));
        } catch (_) {}
    }
}

function kakaoUidNeedsProfileWizardGuard(uid) {
    return typeof uid === 'string' && uid.startsWith('kakao_');
}

/** 약관만(기존 회원) 위저드는 새로고침 시에도 유지 — 가드 제외 */
function signupWizardIsProfileOnboarding(options) {
    return !(options && options.isTermsOnly === true);
}

/**
 * 카카오 신규 가입 위저드: 직전 OAuth에서만 허용. 플래그 없으면 로그아웃 후 로그인 화면부터.
 * skipKakaoStaleGuard: Auth는 유지한 채 온보딩만 염 (Firestore 고아 settings 복구 등 — signOut 시 리스너 permission-denied·빈 화면 유발)
 */
async function openSignupWizardWithKakaoStaleGuard(user, wizardOptions = {}) {
    const { skipKakaoStaleGuard, ...wizardOptionsForWizard } = wizardOptions;
    const bypassKakaoGate = skipKakaoStaleGuard === true;

    if (
        kakaoUidNeedsProfileWizardGuard(user?.uid) &&
        signupWizardIsProfileOnboarding(wizardOptionsForWizard) &&
        !bypassKakaoGate
    ) {
        if (!isKakaoProfileSetupGateOpen(user)) {
            console.log('🔐 카카오 가입: 직전 OAuth·최근 로그인 맥락이 아니어 로그아웃 후 로그인 화면부터 시작합니다.');
            try {
                // main.js onAuthStateChanged가 비의도적 로그아웃으로 무시하지 않도록
                sessionStorage.setItem('explicitLogout', 'true');
            } catch (_) {}
            const { signOut } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js');
            await signOut(auth);
            window._recordsLoadHidePending = false;
            switchScreen(false);
            hideLoading();
            try {
                const { closeSignupWizard } = await import('./signup-wizard.js');
                closeSignupWizard();
            } catch (_) {}
            showToast('처음부터 다시 로그인해 주세요.', 'error');
            return;
        }
    }
    const { openSignupWizard } = await import('./signup-wizard.js');
    openSignupWizard(wizardOptionsForWizard);
}

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
        
        if (isExistingUser) {
            readiness.isExistingUser = true;
            if (isProfileWizardCompleted(this.userSettings)) {
                console.log('✅ 기존 사용자: 프로필 위저드 완료로 보임');
            } else {
                console.log('⚠️ 기존 사용자: 프로필 위저드 보정 필요');
            }
        } else {
            readiness.isExistingUser = false;
            console.log('📋 신규 사용자 경로: 프로필·약관 동일 기준 검사');
        }

        readiness.hasProfile = isProfileWizardCompleted(this.userSettings);
        readiness.termsAgreed = await isTermsAgreementRecordedAndCurrent(this.userSettings);
        console.log('📋 약관·프로필 준비 상태:', {
            isExistingUser,
            termsAgreedSolid: readiness.termsAgreed,
            hasProfile: readiness.hasProfile,
            termsAgreed: this.userSettings.termsAgreed,
            termsVersion: this.userSettings.termsVersion,
            profileCompleted: this.userSettings.profileCompleted
        });

        return readiness;
    }
    
    /**
     * 기존 사용자 확인 (meals 데이터 존재 여부)
     */
    async checkExistingUser(uid) {
        try {
            const { collection, query, limit, getDocs, doc, getDoc } = await import(
                'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'
            );
            const { db, appId } = await import('./firebase.js');
            const mealsColl = collection(db, 'artifacts', appId, 'users', uid, 'meals');
            const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
            if (!mealsSnapshot.empty) return true;
            // meals 캐시가 비어 있어도(첫 설치 직후·오프라인) settings 캐시로 기존 회원 판별
            const settingsRef = doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings');
            const settingsSnap = await getDoc(settingsRef);
            if (settingsSnap.exists()) {
                const d = settingsSnap.data();
                // meals가 없을 때만 settings로 판별 — 온보딩 완결과 동일 기준(레거시 분기 제거)
                if (
                    d &&
                    isProfileWizardCompleted(d) &&
                    (await isTermsAgreementRecordedAndCurrent(d))
                ) {
                    return true;
                }
            }
            return false;
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
        // 로딩 즉시 해제 (meals 스냅샷 대기하지 않음 → 체감 로딩 시간 단축, 타임라인은 데이터 도착 시 onDataUpdate에서 채워짐)
        window._recordsLoadHidePending = false;
        hideLoading();
        maybeShowDemoIntroModal();
        syncDemoNavGuideDots();

        // 백그라운드에서 약관과 프로필 확인 (블로킹하지 않음)
        this.checkTermsAndProfileInBackground(user).catch(e => {
            console.warn('⚠️ 백그라운드 약관/프로필 확인 실패:', e);
        });
    }
    
    /**
     * 프로필·약관 완결 여부 (processState 등 보조용)
     * — 레거시 자동 보정 없음. profileCompleted+닉네임·약관 버전 모두 동일 기준.
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
            readiness.hasProfile = isProfileWizardCompleted(this.userSettings);
            readiness.termsAgreed = await isTermsAgreementRecordedAndCurrent(this.userSettings);
            if (readiness.hasProfile) {
                console.log('✅ 프로필 확인: 기존 사용자 + 위저드 완료 플래그');
            } else {
                console.log('⚠️ 프로필 확인: 기존 사용자이나 위저드 미완료 → 위저드 필요');
            }
            return readiness;
        }

        readiness.hasProfile = isProfileWizardCompleted(this.userSettings);
        readiness.termsAgreed = await isTermsAgreementRecordedAndCurrent(this.userSettings);
        console.log('📋 프로필 확인(신규):', { hasProfile: readiness.hasProfile, termsAgreed: readiness.termsAgreed });

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
            if (isDemoUser(user)) {
                this.hasCompleted = true;
                this.lastProcessedUserId = user?.uid;
                this.termsCheckInProgress = false;
                queueAttendanceCheck();
                return;
            }
            console.log('🔍 백그라운드에서 약관 및 프로필 상태 확인 시작');

            for (let i = 0; i < 40 && !window.userSettings; i++) {
                await new Promise((r) => setTimeout(r, 50));
            }
            try {
                await maybeSeedNicknameFromAuthDisplayName();
            } catch (e) {
                console.warn('Auth 닉네임 시드(백그라운드) 스킵:', e?.message || e);
            }
            try {
                await maybeBackfillTermsVersionFromAgreement(user.uid);
            } catch (e) {
                console.warn('약관 버전 백필(백그라운드) 스킵:', e?.message || e);
            }

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
            
            const settingsForNick = window.userSettings || JSON.parse(JSON.stringify(DEFAULT_USER_SETTINGS));
            if (isExistingUser && !isProfileWizardCompleted(settingsForNick)) {
                console.log('⚠️ 기존 사용자이나 프로필 위저드 미완료 → 위저드로 유도');
            }

            let readiness = await this.checkUserReadiness(user);
            /** 고아 settings 복구 시 카카오 게이트를 쓰면 signOut → Firestore permission-denied 연쇄로 화면이 비므로 게이트 생략 */
            let skipKakaoStaleGuard = false;
            // Auth 사용자만 새로 만들었는데(첫 세션) Firestore settings만 예전에 완료 플래그가 남은 경우 → 약관/프로필 다시 진행
            if (
                !isExistingUser &&
                isLikelyFirstSessionAfterAccountCreate(user) &&
                readiness.termsAgreed &&
                readiness.hasProfile
            ) {
                console.warn(
                    '🔁 신규 Firebase 계정의 첫 로그인인데 Firestore 설정만 완료로 보입니다. (Auth 삭제 후 settings 잔존 등) 온보딩을 다시 진행합니다.'
                );
                readiness.termsAgreed = false;
                readiness.hasProfile = false;
                skipKakaoStaleGuard = true;
            }

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
                if (readiness.hasProfile) {
                    // 기존 회원 약관 업데이트: 4페이지만 (1/1) — 카카오 가입 가드 제외
                    await openSignupWizardWithKakaoStaleGuard(user, {
                        startStep: 4,
                        totalSteps: 1,
                        isTermsOnly: true,
                        ...(skipKakaoStaleGuard ? { skipKakaoStaleGuard: true } : {})
                    });
                } else {
                    // 신규: 닉네임 → 생년월일/성별/라이프스타일 → 약관 (2/4 ~ 4/4)
                    await openSignupWizardWithKakaoStaleGuard(user, {
                        startStep: 2,
                        totalSteps: 4,
                        isEmailSignup: false,
                        ...(skipKakaoStaleGuard ? { skipKakaoStaleGuard: true } : {})
                    });
                }
                return;
            }
            
            if (!readiness.hasProfile) {
                console.log('📋 프로필 설정 필요: 위저드(페이지 형식) 표시');
                window._recordsLoadHidePending = false;
                switchScreen(false);
                hideLoading();
                await openSignupWizardWithKakaoStaleGuard(user, {
                    startStep: 2,
                    totalSteps: 4,
                    isEmailSignup: false,
                    ...(skipKakaoStaleGuard ? { skipKakaoStaleGuard: true } : {})
                });
            } else {
                console.log('✅ 약관과 프로필 모두 완료됨. 모달을 표시하지 않습니다.');
                this.hasCompleted = true;
                this.lastProcessedUserId = user?.uid;
                queueAttendanceCheck();
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
                    await openSignupWizardWithKakaoStaleGuard(
                        this.user,
                        readiness.hasProfile
                            ? { startStep: 4, totalSteps: 1, isTermsOnly: true }
                            : { startStep: 2, totalSteps: 4, isEmailSignup: false }
                    );
                    hideLoading();
                    break;
                    
                case AuthState.NEEDS_PROFILE: {
                    const profileReadiness = await this.checkUserReadinessForProfile(this.user);

                    if (profileReadiness.hasProfile) {
                        console.log('✅ 프로필이 이미 설정되어 있습니다. 약관 기록 확인');
                        const fullReadiness = await this.checkUserReadiness(this.user);
                        if (!fullReadiness.termsAgreed) {
                            this.currentState = AuthState.NEEDS_TERMS;
                            await this.processState(AuthState.NEEDS_TERMS, fullReadiness);
                        } else {
                            this.currentState = AuthState.READY;
                            await this.processState(AuthState.READY, fullReadiness);
                        }
                    } else {
                        console.log('📋 프로필 설정 필요: 위저드(페이지 형식) 표시');
                        switchScreen(false);
                        await openSignupWizardWithKakaoStaleGuard(this.user, {
                            startStep: 2,
                            totalSteps: 4,
                            isEmailSignup: false
                        });
                        hideLoading();
                    }
                    break;
                }
                    
                case AuthState.READY:
                    // 준비 완료: 메인 화면으로 전환, 완료 플래그 설정
                    // 약관 모달이 열려있으면 닫기
                    closeTermsModal();
                    switchScreen(true);
                    if (switchMainTab) switchMainTab('timeline');
                    this.hasCompleted = true;
                    this.lastProcessedUserId = this.user?.uid;
                    queueAttendanceCheck();
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

            const uid = this.user?.uid;
            await hydrateUserSettingsFromServer(uid);
            await maybeBackfillTermsVersionFromAgreement(uid);

            // 프로필·약관(버전 포함) 상태 확인
            let readiness = await this.checkUserReadiness(this.user);
            if (!readiness.termsAgreed && uid) {
                await new Promise((r) => setTimeout(r, 400));
                await hydrateUserSettingsFromServer(uid);
                await maybeBackfillTermsVersionFromAgreement(uid);
                readiness = await this.checkUserReadiness(this.user);
            }

            if (!readiness.termsAgreed) {
                console.log('📋 약관 모달 후에도 DB 기록 불충분 → 약관 위저드로 보강');
                window._recordsLoadHidePending = false;
                switchScreen(false);
                hideLoading();
                await openSignupWizardWithKakaoStaleGuard(this.user, {
                    startStep: 4,
                    totalSteps: 1,
                    isTermsOnly: true
                });
                return;
            }

            if (readiness.hasProfile) {
                console.log('✅ 약관 동의 완료, 프로필도 완료됨. 메인 화면으로 진행');
                switchScreen(true);
                this.hasCompleted = true;
                this.lastProcessedUserId = this.user?.uid;
                queueAttendanceCheck();
            } else {
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

            const uid = this.user.uid;
            await hydrateUserSettingsFromServer(uid);
            await maybeBackfillTermsVersionFromAgreement(uid);

            let readiness = await this.checkUserReadiness(this.user);
            if (!readiness.termsAgreed && uid) {
                await new Promise((r) => setTimeout(r, 400));
                await hydrateUserSettingsFromServer(uid);
                await maybeBackfillTermsVersionFromAgreement(uid);
                readiness = await this.checkUserReadiness(this.user);
            }
            if (!readiness.termsAgreed) {
                console.log('📋 프로필 완료 후 약관 기록 미비 → 약관 위저드');
                window._recordsLoadHidePending = false;
                switchScreen(false);
                hideLoading();
                await openSignupWizardWithKakaoStaleGuard(this.user, {
                    startStep: 4,
                    totalSteps: 1,
                    isTermsOnly: true
                });
                return;
            }

            console.log('✅ 프로필 설정 완료. 메인 화면으로 진행');
            switchScreen(true);
            this.hasCompleted = true;
            this.lastProcessedUserId = this.user?.uid;
            queueAttendanceCheck();
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
