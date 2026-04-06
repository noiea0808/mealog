// 인증 관련 함수들
import { auth, setAnalyticsUserId, callableFunctions, appCheckInitPromise } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, getRedirectResult, signInWithCredential, signInWithCustomToken, signInAnonymously, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, deleteUser, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { showToast, showLoading, hideLoading } from './ui.js';
import { DEFAULT_USER_SETTINGS, CURRENT_TERMS_VERSION } from './constants.js';
import { dbOps } from './db.js';
import { normalizeBirthdateRaw } from './utils.js';
import { isDemoUser } from './demo-account.js';

function isNativePlatform() {
    return typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.();
}

async function getGoogleWebClientId() {
    try {
        const config = await import('./config.js');
        if (config.GOOGLE_WEB_CLIENT_ID) return config.GOOGLE_WEB_CLIENT_ID;
    } catch (_) {}
    const { GOOGLE_WEB_CLIENT_ID } = await import('./config.default.js');
    return GOOGLE_WEB_CLIENT_ID || '';
}

async function getKakaoJavascriptKey() {
    try {
        const config = await import('./config.js');
        if (config.KAKAO_JAVASCRIPT_KEY != null && String(config.KAKAO_JAVASCRIPT_KEY).trim() !== '') {
            return String(config.KAKAO_JAVASCRIPT_KEY).trim();
        }
    } catch (_) {}
    const { KAKAO_JAVASCRIPT_KEY } = await import('./config.default.js');
    return (KAKAO_JAVASCRIPT_KEY && String(KAKAO_JAVASCRIPT_KEY).trim()) || '';
}

/**
 * 브라우저 주소 기준 OAuth Redirect URI (카카오 콘솔 값과 글자 단위로 같아야 함)
 * 루트는 끝에 `/` 유지 (예: https://www.mealog.net/)
 */
export function getKakaoOAuthRedirectUri() {
    const u = new URL(window.location.href);
    const path = u.pathname || '/';
    if (path === '/') {
        return `${u.origin}/`;
    }
    return `${u.origin}${path}`;
}

/** config.js의 KAKAO_OAUTH_REDIRECT_URI가 있으면 우선 (로컬에서 `/`만 등록했을 때 등) */
async function resolveKakaoOAuthRedirectUri() {
    try {
        const c = await import('./config.js');
        const o = c.KAKAO_OAUTH_REDIRECT_URI;
        if (o != null && String(o).trim() !== '') {
            return String(o).trim();
        }
    } catch (_) {
        /* no config.js */
    }
    try {
        const d = await import('./config.default.js');
        const o = d.KAKAO_OAUTH_REDIRECT_URI;
        if (o != null && String(o).trim() !== '') {
            return String(o).trim();
        }
    } catch (_) {
        /* ignore */
    }
    return getKakaoOAuthRedirectUri();
}

const KAKAO_SDK_URL = 'https://t1.kakaocdn.net/kakao_js_sdk/2.8.0/kakao.min.js';
let kakaoSdkLoadPromise = null;

/** 스크립트만 로드됨(init 전에는 Kakao.Auth가 아직 없음 — SDK가 init 안에서 Auth를 붙임) */
function isKakaoSdkScriptPresent() {
    return typeof window !== 'undefined' && window.Kakao && typeof window.Kakao.init === 'function';
}

function isKakaoLoginReadyAfterInit() {
    return typeof window?.Kakao?.Auth?.authorize === 'function';
}

function loadKakaoJavascriptSdk() {
    if (isKakaoSdkScriptPresent()) {
        return Promise.resolve();
    }
    if (kakaoSdkLoadPromise) return kakaoSdkLoadPromise;
    kakaoSdkLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = KAKAO_SDK_URL;
        s.async = true;
        s.dataset.mealogKakaoSdk = '1';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('카카오 SDK 로드 실패'));
        document.head.appendChild(s);
    });
    return kakaoSdkLoadPromise;
}

function stripKakaoOAuthParamsFromUrl() {
    try {
        const u = new URL(window.location.href);
        ['code', 'state', 'error', 'error_description'].forEach((k) => u.searchParams.delete(k));
        const q = u.searchParams.toString();
        const path = u.pathname + (q ? `?${q}` : '') + u.hash;
        history.replaceState({}, '', path);
    } catch (_) {
        /* ignore */
    }
}

/**
 * 카카오 로그인 후 redirectUri로 돌아온 URL의 ?code= 처리 (페이지 1회)
 */
export async function tryCompleteKakaoOAuthReturn() {
    if (isNativePlatform() || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const oauthError = params.get('error');
    const code = params.get('code');
    if (oauthError) {
        stripKakaoOAuthParamsFromUrl();
        if (oauthError !== 'access_denied') {
            showToast(
                '카카오 로그인 오류: ' + (params.get('error_description') || oauthError).slice(0, 120),
                'error'
            );
        }
        return;
    }
    if (!code || !code.trim()) return;

    const redirectUri = await resolveKakaoOAuthRedirectUri();
    showLoading('카카오 로그인 처리 중...', { skipOnLoginScreen: false });
    try {
        const res = await callableFunctions.signInWithKakao({ code: code.trim(), redirectUri });
        const customToken = res?.data?.customToken;
        if (!customToken) {
            showToast('서버에서 로그인 토큰을 받지 못했습니다.', 'error');
            hideLoading();
            stripKakaoOAuthParamsFromUrl();
            return;
        }
        await signInWithCustomToken(auth, customToken);
        // 가입 위저드는 직후 OAuth 세션에서만 자동 오픈. 새로고침 시 플래그 없음 → auth-flow에서 로그아웃 후 로그인 화면
        try {
            sessionStorage.setItem('mealog_kakaoProfileSetupGate', '1');
        } catch (_) {}
        window._recordsLoadHidePending = true;
        showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
        showToast('카카오 로그인 성공!', 'success');
    } catch (error) {
        console.warn('[카카오 OAuth 복귀] 오류:', error?.code, error?.message, error);
        const msg = error?.message || '';
        const max = 240;
        const short = msg.length > max ? `${msg.slice(0, max)}…` : msg || '카카오 로그인에 실패했습니다.';
        showToast(short, 'error');
        hideLoading();
    } finally {
        stripKakaoOAuthParamsFromUrl();
    }
}

export async function handleKakaoLogin() {
    showLoading('카카오 로그인 중...', { skipOnLoginScreen: false });
    try {
        if (isNativePlatform()) {
            showToast('카카오 로그인은 현재 웹에서 이용해 주세요.', 'info');
            hideLoading();
            return;
        }
        const appKey = await getKakaoJavascriptKey();
        if (!appKey) {
            showToast('카카오 로그인 설정이 필요합니다. config.js에 KAKAO_JAVASCRIPT_KEY를 넣어 주세요.', 'error');
            hideLoading();
            return;
        }
        await loadKakaoJavascriptSdk();
        const Kakao = window.Kakao;
        if (!isKakaoSdkScriptPresent()) {
            showToast('카카오 로그인 SDK를 불러오지 못했습니다.', 'error');
            hideLoading();
            return;
        }
        try {
            if (typeof Kakao.isInitialized === 'function' && Kakao.isInitialized()) {
                /* noop */
            } else {
                Kakao.init(appKey);
            }
        } catch (initErr) {
            const already = String(initErr?.message || initErr).toLowerCase().includes('already');
            if (!already) throw initErr;
        }
        if (!isKakaoLoginReadyAfterInit()) {
            showToast('카카오 SDK 초기화에 실패했습니다. 앱 키(JavaScript 키)를 확인해 주세요.', 'error');
            hideLoading();
            return;
        }
        const redirectUri = await resolveKakaoOAuthRedirectUri();
        console.info(
            '[카카오 로그인] redirectUri:',
            redirectUri,
            '→ Kakao Developers > 플랫폼 키 > JavaScript 키 > Redirect URI·JavaScript SDK 도메인에 동일하게 등록했는지 확인하세요.'
        );
        // PC 브라우저에서 throughTalk: true 는 카카오톡 간편로그인 경로를 타며, 환경에 따라 kauth 400이 날 수 있음
        const preferTalkEasyLogin = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
        const host = window.location.hostname || '';
        const isLocalDev =
            host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
        // 로컬에서 is_popup=false 전체 이동 시 kauth 400이 나는 환경이 있어 팝업 플로우 시도
        const authorizeOpts = {
            redirectUri,
            throughTalk: preferTalkEasyLogin
        };
        if (isLocalDev) {
            authorizeOpts.isPopup = true;
            console.info('[카카오 로그인] 로컬: 팝업 창이 열립니다. 차단 시 주소창에서 팝업을 허용해 주세요.');
        }
        await Kakao.Auth.authorize(authorizeOpts);
        /* 성공 시 카카오로 리다이렉트되어 이후 코드는 실행되지 않음 */
    } catch (error) {
        console.warn('[카카오 로그인] 오류:', error?.code, error?.error, error?.message, error);
        const msg =
            error?.message ||
            error?.error_description ||
            (typeof error?.error === 'string' ? error.error : '') ||
            '';
        const cancelled =
            msg.includes('cancel') ||
            msg.includes('취소') ||
            error?.error === 'access_denied' ||
            error?.error === 'user_cancelled';
        if (!cancelled) {
            const short = msg.length > 80 ? `${msg.slice(0, 80)}…` : msg || '로그인에 실패했습니다.';
            showToast(short, 'error');
        }
        hideLoading();
    }
}

export async function handleGoogleLogin() {
    showLoading('로그인 중...', { skipOnLoginScreen: false });
    try {
        let result;
        if (isNativePlatform()) {
            const webClientId = await getGoogleWebClientId();
            if (!webClientId) {
                showToast('구글 로그인 설정이 필요합니다. config.js에 GOOGLE_WEB_CLIENT_ID를 설정해주세요.', 'error');
                hideLoading();
                return;
            }
            const SocialLogin = window.Capacitor?.Plugins?.SocialLogin;
            if (!SocialLogin) {
                console.warn('[구글 로그인] SocialLogin 플러그인을 찾을 수 없습니다. capacitor.js / capacitor-social-login-plugin.js 로드 여부 확인.');
                showToast('구글 로그인을 사용할 수 없습니다.', 'error');
                hideLoading();
                return;
            }
            await SocialLogin.initialize({
                google: { webClientId, mode: 'online' }
            });
            // 스코프를 명시하지 않으면 플러그인 기본값 사용 (OAuth 동의 화면 미수정 시 에러 방지)
            const response = await SocialLogin.login({
                provider: 'google',
                options: {}
            });
            // Android 등에서 idToken이 result 바로 아래 또는 authentication 안에 올 수 있음
            const idToken = response.result?.idToken ?? response.result?.authentication?.idToken ?? null;
            const isOnline = response.result?.responseType === 'online';
            if (!isOnline || !idToken) {
                const errMsg = response.result?.responseType === 'offline'
                    ? '오프라인 모드는 지원하지 않습니다.'
                    : '구글 로그인에서 ID 토큰을 받지 못했습니다.';
                console.warn('[구글 로그인] 응답:', response?.result);
                showToast(errMsg, 'error');
                hideLoading();
                return;
            }
            const credential = GoogleAuthProvider.credential(idToken);
            result = await signInWithCredential(auth, credential);
        } else {
            const provider = new GoogleAuthProvider();
            result = await signInWithPopup(auth, provider);
        }
        console.log('🔐 구글 로그인 성공:', {
            uid: result.user.uid,
            email: result.user.email,
            providerId: result.user.providerData[0]?.providerId,
            providerData: result.user.providerData.map(p => p.providerId)
        });
        window._recordsLoadHidePending = true;
        showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
        showToast("구글 로그인 성공!", "success");
    } catch (error) {
        console.warn('[구글 로그인] 오류:', error?.code, error?.message, error);
        if (error?.code === 'auth/unauthorized-domain' || error?.message?.includes('unauthorized-domain')) {
            const domainTextEl = document.getElementById('domainText');
            if (domainTextEl) {
                const host = window.location.hostname;
                if (host === 'localhost' || host === '127.0.0.1') {
                    domainTextEl.innerText = 'localhost or 127.0.0.1 (should work by default)';
                } else {
                    domainTextEl.innerText = host;
                }
                domainTextEl.style.display = 'none';
                domainTextEl.offsetHeight;
                domainTextEl.style.display = 'block';
            }
            document.getElementById('domainErrorModal').classList.remove('hidden');
            hideLoading();
        } else if (error?.code !== 'auth/cancelled-popup-request' && error?.message !== 'User cancelled flow') {
            const msg = error?.message || error?.error?.message || String(error);
            const isReauth = /reauth|re-auth|sha|fingerprint|credential/i.test(msg);
            const isStaging = isNativePlatform() && (window.Capacitor?.config?.appId === 'com.mealog.app.staging');
            const toastMsg = isReauth
                ? (isStaging
                    ? '스테이징: 이 PC의 디버그 키 SHA-1을 Firebase Android 앱(스테이징)에 추가하세요. android 폴더에서 gradlew signingReport 실행 후 표시된 SHA-1을 Firebase 프로젝트 설정에 등록하세요.'
                    : '구글 로그인 실패. Firebase에 해당 빌드(디버그/릴리즈)의 SHA-1이 등록돼 있는지 확인해 주세요.')
                : "로그인 실패: " + (msg.length > 50 ? msg.slice(0, 50) + '…' : msg);
            showToast(toastMsg, "error");
            hideLoading();
        } else {
            hideLoading();
        }
    }
}

export async function startGuest() {
    showLoading('둘러보기 준비 중...', { skipOnLoginScreen: false });
    try {
        const { signInAsDemoAccount, requestDemoIntroFromBrowse } = await import('./demo-account.js');
        requestDemoIntroFromBrowse();
        await signInAsDemoAccount();
        showToast('샘플 계정으로 둘러보기를 시작합니다.', 'info');
    } catch (e) {
        console.warn('둘러보기(데모) 로그인 실패:', e);
        const code = e?.code || '';
        const hint =
            code === 'auth/invalid-credential' || code === 'auth/wrong-password'
                ? ' firebase deploy --only functions(signInAsDemo) 후 다시 시도하거나, config의 DEMO_ACCOUNT_PASSWORD를 Firebase 비밀번호와 맞추세요.'
                : '';
        showToast('둘러보기를 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.' + hint, 'error');
        hideLoading();
    }
}

export function openEmailModal(initialMode = 'login') {
    // 이메일 회원가입: 페이지 형식 4단계 위저드 열기
    if (initialMode === 'signup') {
        document.getElementById('emailAuthModal').classList.add('hidden');
        import('./signup-wizard.js').then(({ openSignupWizard }) => {
            openSignupWizard({ startStep: 1, totalSteps: 4, isEmailSignup: true });
        });
        return;
    }
    document.getElementById('emailAuthModal').classList.remove('hidden');
    window.setEmailAuthMode(initialMode);
    const savedEmail = localStorage.getItem('savedEmail');
    if (savedEmail) {
        document.getElementById('emailInput').value = savedEmail;
        document.getElementById('rememberEmailCheck').checked = true;
    } else {
        document.getElementById('emailInput').value = '';
        document.getElementById('rememberEmailCheck').checked = false;
    }
    document.getElementById('passwordInput').value = '';
    
    // 비밀번호 입력창에 엔터 키 이벤트 추가 (이벤트 위임 사용)
    const emailAuthModal = document.getElementById('emailAuthModal');
    if (emailAuthModal) {
        // 모달에 이벤트 위임으로 한 번만 등록 (중복 방지)
        const handleKeyPress = (e) => {
            if (e.target.id === 'passwordInput' && e.key === 'Enter') {
                e.preventDefault();
                window.handleEmailAuth();
            }
        };
        
        // 기존 리스너가 있으면 제거 후 재등록
        emailAuthModal.removeEventListener('keypress', emailAuthModal._passwordKeyHandler);
        emailAuthModal._passwordKeyHandler = handleKeyPress;
        emailAuthModal.addEventListener('keypress', handleKeyPress);
    }
}

export function closeEmailModal() {
    document.getElementById('emailAuthModal').classList.add('hidden');
}

export function setEmailAuthMode(mode) {
    window.emailAuthMode = mode;
    const title = document.getElementById('emailAuthTitle');
    const btn = document.getElementById('emailAuthBtn');
    const toggleBtn = document.getElementById('emailAuthToggleBtn');
    const resetLink = document.getElementById('emailPasswordResetLink');
    const footerSep = document.getElementById('emailAuthFooterSep');
    if (mode === 'login') {
        title.innerText = "이메일 로그인";
        btn.innerText = "로그인";
        btn?.setAttribute("aria-label", "로그인");
        toggleBtn.textContent = "회원가입";
        toggleBtn.className =
            "shrink-0 text-emerald-600 font-bold underline underline-offset-2 hover:text-emerald-800";
        resetLink?.classList.remove("hidden");
        footerSep?.classList.remove("hidden");
    } else {
        title.innerText = "회원가입";
        btn.innerText = "가입하기";
        btn?.setAttribute("aria-label", "가입하기");
        toggleBtn.textContent = "로그인";
        toggleBtn.className =
            "shrink-0 text-emerald-600 font-bold underline underline-offset-2 hover:text-emerald-800";
        resetLink?.classList.add("hidden");
        footerSep?.classList.add("hidden");
    }
}

export function toggleEmailAuthMode() {
    if (window.emailAuthMode === 'login') {
        // 회원가입으로 전환: 이메일 로그인 모달 닫고, 페이지 형식 위저드 열기
        document.getElementById('emailAuthModal').classList.add('hidden');
        import('./signup-wizard.js').then(({ openSignupWizard }) => {
            openSignupWizard({ startStep: 1, totalSteps: 4, isEmailSignup: true });
        });
    } else {
        window.setEmailAuthMode('login');
    }
}

export async function handleEmailAuth() {
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passwordInput').value;
    
    if (!email || !password) {
        showToast("이메일과 비밀번호를 입력해주세요.", "error");
        return;
    }
    
    // 이메일 형식 기본 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        showToast("올바른 이메일 형식이 아닙니다.", "error");
        return;
    }
    
    // 비밀번호 최소 길이 검증
    if (password.length < 6) {
        showToast("비밀번호는 6자리 이상이어야 합니다.", "error");
        return;
    }
    
    const loadingMsg = window.emailAuthMode === 'signup' ? '가입 중...' : '로그인 중...';
    showLoading(loadingMsg, { skipOnLoginScreen: false });
    try {
        let result;
        if (window.emailAuthMode === 'signup') {
            result = await createUserWithEmailAndPassword(auth, email, password);
            console.log('🔐 이메일 회원가입 성공:', {
                uid: result.user.uid,
                email: result.user.email,
                providerId: result.user.providerData[0]?.providerId,
                providerData: result.user.providerData.map(p => p.providerId)
            });
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
            showToast("회원가입 성공! 환영합니다.", "success");
        } else {
            result = await signInWithEmailAndPassword(auth, email, password);
            console.log('🔐 이메일 로그인 성공:', {
                uid: result.user.uid,
                email: result.user.email,
                providerId: result.user.providerData[0]?.providerId,
                providerData: result.user.providerData.map(p => p.providerId)
            });
            window._recordsLoadHidePending = true;
            showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
            showToast("로그인되었습니다.", "success");
            if (document.getElementById('rememberEmailCheck').checked) {
                localStorage.setItem('savedEmail', email);
            } else {
                localStorage.removeItem('savedEmail');
            }
        }
        document.getElementById('emailAuthModal').classList.add('hidden');
        // 로그인 성공 후 로딩 오버레이는 onAuthStateChanged에서 인증 플로우가 완료될 때까지 유지
        // 인증 플로우가 완료되면 processState의 finally에서 hideLoading() 호출됨
    } catch (error) {
        console.error('🔐 이메일 인증 에러:', {
            code: error.code,
            message: error.message,
            error: error
        });
        
        let msg = error.message || '알 수 없는 오류가 발생했습니다.';
        
        // Firebase Auth 에러 코드별 메시지 처리
        if (error.code === 'auth/email-already-in-use') {
            msg = "이미 사용 중인 이메일입니다.";
        } else if (error.code === 'auth/wrong-password') {
            msg = "비밀번호가 틀렸습니다.";
        } else if (error.code === 'auth/user-not-found') {
            msg = "존재하지 않는 계정입니다.";
        } else if (error.code === 'auth/weak-password') {
            msg = "비밀번호는 6자리 이상이어야 합니다.";
        } else if (error.code === 'auth/invalid-email') {
            msg = "올바른 이메일 형식이 아닙니다.";
        } else if (error.code === 'auth/user-disabled') {
            msg = "이 계정은 비활성화되었습니다. 관리자에게 문의하세요.";
        } else if (error.code === 'auth/too-many-requests') {
            msg = "너무 많은 시도가 있었습니다. 잠시 후 다시 시도해주세요.";
        } else if (error.code === 'auth/operation-not-allowed') {
            msg = "이메일/비밀번호 로그인이 비활성화되었습니다.";
        } else if (error.code === 'auth/invalid-credential') {
            msg = "이메일 또는 비밀번호가 올바르지 않습니다.";
        } else if (error.code === 'auth/network-request-failed') {
            msg = "네트워크 연결을 확인해주세요.";
        } else if (error.message && error.message.includes('400')) {
            msg = "로그인 요청이 실패했습니다. 이메일과 비밀번호를 확인해주세요.";
        }
        
        showToast("오류: " + msg, "error");
        hideLoading(); // 에러 시에만 즉시 숨김
    }
}

/**
 * 비밀번호 재설정 메일 제목을 "Mealog의 비밀번호 재설정"으로 쓰려면
 * Firebase 콘솔 > Authentication > Templates > Password reset 에서 제목을 직접 수정해야 합니다.
 * (클라이언트 SDK에서는 제목을 바꿀 수 없습니다.) 자세한 안내: firebase/email-template-password-reset.txt
 */

function getEmailAuthInputEmail() {
    return document.getElementById('emailInput')?.value?.trim() || '';
}

export function closePasswordResetConfirmModal() {
    document.getElementById('passwordResetConfirmModal')?.classList.add('hidden');
}

export function closePasswordResetSuccessModal() {
    document.getElementById('passwordResetSuccessModal')?.classList.add('hidden');
}

/** 비밀번호 찾기 클릭: 이메일 검증 후 발송 확인 모달 */
export function requestPasswordReset() {
    const email = getEmailAuthInputEmail();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email) {
        showToast("이메일을 입력해주세요.", "error");
        return;
    }
    if (!emailRegex.test(email)) {
        showToast("올바른 이메일 형식이 아닙니다.", "error");
        return;
    }
    const label = document.getElementById('passwordResetConfirmEmail');
    if (label) label.textContent = email;
    document.getElementById('passwordResetConfirmModal')?.classList.remove('hidden');
}

/** 확인 모달에서 발송 실행 */
export async function sendPasswordResetAfterConfirm() {
    const email =
        document.getElementById('passwordResetConfirmEmail')?.textContent?.trim() || getEmailAuthInputEmail();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
        showToast("올바른 이메일을 확인해주세요.", "error");
        closePasswordResetConfirmModal();
        return;
    }
    showLoading('메일 전송 중...', { skipOnLoginScreen: false });
    try {
        await sendPasswordResetEmail(auth, email);
        closePasswordResetConfirmModal();
        document.getElementById('passwordResetSuccessModal')?.classList.remove('hidden');
    } catch (error) {
        console.error('비밀번호 재설정 메일 발송 실패:', error);
        let msg = error.message || '발송에 실패했습니다.';
        if (error.code === 'auth/invalid-email') msg = "올바른 이메일 형식이 아닙니다.";
        else if (error.code === 'auth/too-many-requests') msg = "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
        showToast(msg, "error");
    } finally {
        hideLoading();
    }
}

export async function handleLogout() {
    await signOut(auth);
    window.location.reload();
}

export function confirmLogout() {
    const user = auth.currentUser;
    if (user && !user.isAnonymous && isDemoUser(user)) {
        void confirmLogoutAction();
        return;
    }
    console.log('🔐 confirmLogout 호출됨 - 로그아웃 모달 열기');
    const modal = document.getElementById('logoutConfirmModal');
    if (!modal) {
        console.error('❌ logoutConfirmModal 요소를 찾을 수 없습니다!');
        return;
    }
    modal.classList.remove('hidden');
    console.log('✅ 로그아웃 모달 열림');
}

export async function confirmLogoutAction() {
    console.log('🔐 confirmLogoutAction 함수 시작');
    document.getElementById('logoutConfirmModal').classList.add('hidden');
    if (typeof window.clearNotificationReadStateCache === 'function') {
        window.clearNotificationReadStateCache();
    }
    
    // ⚠️ 중요: signOut 전에 플래그를 먼저 설정해야 함 (signOut 후 onAuthStateChanged가 즉시 호출될 수 있음)
    // 로그아웃 전에 더미 계정인지 확인하여 저장 (로그아웃 후에는 window.currentUser가 사라지므로)
    try {
        const { isDemoUser } = await import('./demo-account.js');
        const currentUser = auth.currentUser;
        console.log('🔐 로그아웃 전 사용자 확인:', {
            uid: currentUser?.uid,
            email: currentUser?.email,
            isDemo: currentUser ? isDemoUser(currentUser) : false
        });
        if (currentUser && isDemoUser(currentUser)) {
            // ⚠️ 중요: localStorage에 먼저 저장 (sessionStorage는 페이지 리로드 시 사라질 수 있음)
            // ⚠️ 중요: 동기적으로 저장하여 signOut 전에 확실히 저장됨
            localStorage.setItem('wasDemoUserLogout', 'true');
            sessionStorage.setItem('wasDemoUserLogout', 'true');
            console.log('🔐 더미 계정 로그아웃 플래그 설정 완료 (localStorage + sessionStorage)');
        } else {
            console.log('🔐 일반 계정 로그아웃 (더미 계정 아님)');
        }
    } catch (e) {
        console.error('더미 계정 확인 실패:', e);
    }
    
    // 명시적 로그아웃 플래그 설정 (페이지 리로드 후에도 유지)
    // ⚠️ 중요: localStorage에 먼저 저장 (동기적으로 저장)
    localStorage.setItem('explicitLogout', 'true');
    sessionStorage.setItem('explicitLogout', 'true');
    console.log('🔐 명시적 로그아웃 플래그 설정 완료 (localStorage + sessionStorage)');
    
    // 플래그가 확실히 저장되었는지 확인 (동기적으로 확인)
    const explicitFlag = localStorage.getItem('explicitLogout') === 'true' || sessionStorage.getItem('explicitLogout') === 'true';
    const demoFlag = localStorage.getItem('wasDemoUserLogout') === 'true' || sessionStorage.getItem('wasDemoUserLogout') === 'true';
    console.log('🔐 signOut 전 플래그 확인:', {
        explicitLogout: explicitFlag,
        wasDemoUserLogout: demoFlag,
        localStorageExplicit: localStorage.getItem('explicitLogout'),
        localStorageDemo: localStorage.getItem('wasDemoUserLogout')
    });
    
    if (!explicitFlag) {
        console.error('❌ explicitLogout 플래그가 설정되지 않았습니다!');
        return; // 플래그가 설정되지 않았으면 signOut하지 않음
    }
    
    // ⚠️ 중요: signOut은 비동기이지만, onAuthStateChanged는 signOut 직후 동기적으로 호출될 수 있음
    // 따라서 플래그는 이미 localStorage에 저장되어 있으므로, signOut 후에도 플래그를 확인할 수 있어야 함
    console.log('🔐 signOut 시작...');
    await signOut(auth);
    console.log('🔐 signOut 완료');
    
    // signOut 후 onAuthStateChanged가 호출되기 전에 플래그를 다시 확인
    const explicitFlagAfter = localStorage.getItem('explicitLogout') === 'true' || sessionStorage.getItem('explicitLogout') === 'true';
    const demoFlagAfter = localStorage.getItem('wasDemoUserLogout') === 'true' || sessionStorage.getItem('wasDemoUserLogout') === 'true';
    console.log('🔐 signOut 후 플래그 확인:', {
        explicitLogout: explicitFlagAfter,
        wasDemoUserLogout: demoFlagAfter,
        localStorageExplicit: localStorage.getItem('explicitLogout'),
        localStorageDemo: localStorage.getItem('wasDemoUserLogout')
    });
    
    // ⚠️ 중요: 페이지 리로드 전에 플래그가 확실히 저장되었는지 다시 확인
    if (!explicitFlagAfter) {
        console.error('❌ signOut 후 explicitLogout 플래그가 사라졌습니다! 다시 설정...');
        localStorage.setItem('explicitLogout', 'true');
        sessionStorage.setItem('explicitLogout', 'true');
    }
    
    // 페이지 리로드 (onAuthStateChanged에서 플래그를 확인하여 자동 로그인을 막음)
    console.log('🔐 페이지 리로드 시작...');
    window.location.reload();
}

export function confirmDeleteAccount() {
    document.getElementById('deleteAccountConfirmModal').classList.remove('hidden');
}

export function cancelDeleteAccount() {
    document.getElementById('deleteAccountConfirmModal').classList.add('hidden');
}

export async function confirmDeleteAccountAction() {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", "error");
        return;
    }
    const { isDemoUser } = await import('./demo-account.js');
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 탈퇴할 수 없습니다.', 'error');
        document.getElementById('deleteAccountConfirmModal')?.classList.add('hidden');
        return;
    }
    
    // 한 번 더 확인
    if (!confirm('정말로 탈퇴하시겠어요?\n\n모든 기록과 데이터가 삭제되며 복구할 수 없습니다.')) {
        return;
    }
    
    const modal = document.getElementById('deleteAccountConfirmModal');
    
    try {
        modal.classList.add('hidden');
        showLoading();
        
        // 1. 사용자 데이터 삭제
        await dbOps.deleteAllUserData();
        
        // 2. Firebase Authentication 계정 삭제
        const user = auth.currentUser;
        if (user) {
            await deleteUser(user);
        }
        
        // 3. 로그아웃 및 페이지 리로드
        // 명시적 로그아웃 플래그 설정
        sessionStorage.setItem('explicitLogout', 'true');
        await signOut(auth);
        hideLoading();
        showToast("계정이 성공적으로 삭제되었습니다.", "success");
        window.location.reload();
    } catch (error) {
        console.error("계정 삭제 실패:", error);
        hideLoading();
        
        let errorMessage = "계정 삭제 중 오류가 발생했습니다.";
        if (error.code === 'auth/requires-recent-login') {
            errorMessage = "보안을 위해 다시 로그인한 후 탈퇴해주세요.";
        }
        showToast(errorMessage, "error");
    }
}

export function copyDomain() {
    const text = document.getElementById('domainText').innerText;
    navigator.clipboard.writeText(text).then(() => showToast("복사완료", "success")).catch(() => showToast("실패", "error"));
}

export function closeDomainModal() {
    document.getElementById('domainErrorModal').classList.add('hidden');
}

export async function switchToLogin() {
    // 게스트 모드에서 로그인 페이지로 전환
    try {
        // Firestore 리스너가 살아있으면 signOut 시점에 permission-denied가 연쇄로 발생할 수 있으므로 선제 해제
        if (typeof window.cleanupFirestoreListeners === 'function') {
            window.cleanupFirestoreListeners();
        }
        if (typeof window.clearNotificationReadStateCache === 'function') {
            window.clearNotificationReadStateCache();
        }

        // 설정 페이지 닫기
        const settingsPage = document.getElementById('settingsPage');
        if (settingsPage) {
            settingsPage.classList.add('hidden');
        }
        
        // 명시적 로그아웃 플래그 설정
        sessionStorage.setItem('explicitLogout', 'true');
        // 게스트 모드 로그아웃
        await signOut(auth);
        // 로그아웃 후 자동으로 랜딩 페이지로 이동 (인증 상태 변경 리스너가 처리)
        showToast("로그인 페이지로 이동합니다.", "info");
    } catch (error) {
        console.error('로그아웃 실패:', error);
        showToast("로그아웃 중 오류가 발생했습니다.", "error");
    }
}

export async function initAuth(onAuthStateChangedCallback) {
    if (!isNativePlatform()) {
        await tryCompleteKakaoOAuthReturn();
    }
    // Redirect 로그인 복귀 시 결과 처리 (웹에서만 사용, 네이티브는 SocialLogin 사용)
    if (isNativePlatform()) {
        try {
            const result = await getRedirectResult(auth);
            if (result?.user) {
                console.log('🔐 구글 Redirect 로그인 성공:', result.user.uid);
                window._recordsLoadHidePending = true;
                showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
                showToast("구글 로그인 성공!", "success");
            }
        } catch (error) {
            // 네이티브에서는 리다이렉트 미사용 → 에러는 무시(콘솔만), 사용자에게 토스트 안 띄움
            console.warn('getRedirectResult (네이티브 무시 가능):', error?.code, error?.message);
            hideLoading();
        }
    }
    // Firestore App Check 강제 시: 리스너 등록 직후의 getDocs/스냅샷이 토큰 없이 나가면 전 구역 permission-denied
    await appCheckInitPromise;
    onAuthStateChanged(auth, (user) => {
        try {
            setAnalyticsUserId(user?.uid || null);
            onAuthStateChangedCallback(user);
        } catch (e) {
            console.error('인증 상태 처리 중 오류:', e);
            hideLoading();
            showToast("잠시 후 다시 시도해 주세요.", "error");
        }
    });
}

// 약관 동의 모달 표시
export async function showTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) {
        modal.classList.remove('hidden');
        // 체크박스 상태 초기화
        document.getElementById('termsAgreement').checked = false;
        document.getElementById('privacyAgreement').checked = false;
        updateTermsAgreeButton();
        
        // 기존 사용자인지 확인하여 안내 문구 변경
        const descriptionEl = document.getElementById('termsModalDescription');
        if (descriptionEl) {
            try {
                const currentUser = auth.currentUser;
                if (currentUser && !currentUser.isAnonymous) {
                    // authFlowManager에서 캐시된 기존 사용자 정보 확인 (이미 백그라운드에서 확인됨)
                    let isExistingUser = false;
                    try {
                        const { authFlowManager } = await import('./auth-flow.js');
                        if (authFlowManager._cachedExistingUser !== undefined) {
                            isExistingUser = authFlowManager._cachedExistingUser;
                        } else {
                            // 캐시가 없으면 약관 모달에서만 확인 (로그인 플로우를 지연시키지 않음)
                            const { collection, query, limit, getDocs } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                            const { db, appId } = await import('./firebase.js');
                            const mealsColl = collection(db, 'artifacts', appId, 'users', currentUser.uid, 'meals');
                            const mealsSnapshot = await getDocs(query(mealsColl, limit(1)));
                            isExistingUser = !mealsSnapshot.empty;
                            // 캐시에 저장
                            authFlowManager._cachedExistingUser = isExistingUser;
                        }
                    } catch (e) {
                        console.warn('기존 사용자 확인 실패:', e);
                    }
                    
                    if (isExistingUser) {
                        // 기존 사용자에게는 약관 업데이트 안내 문구 표시
                        descriptionEl.innerHTML = '<span class="text-emerald-600 font-semibold">💫 약관이 업데이트되었습니다</span><br><span class="text-slate-700">더 나은 서비스 제공을 위해 약관 내용을 일부 수정했습니다.<br>잠깐 시간을 내어 읽어 보시고 다시 동의해 주시면 감사하겠습니다. 🙏</span>';
                        descriptionEl.className = 'text-xs text-center mb-6 leading-relaxed space-y-1';
                    } else {
                        // 신규 사용자에게는 기본 문구 표시
                        descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                        descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
                    }
                } else {
                    // 게스트 사용자는 기본 문구
                    descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                    descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
                }
            } catch (e) {
                console.warn('기존 사용자 확인 실패:', e);
                // 에러 시 기본 문구 유지
                descriptionEl.textContent = '서비스 이용을 위해 아래 약관에 동의해주세요.';
                descriptionEl.className = 'text-xs text-slate-500 text-center mb-6';
            }
        }
    }
}

// 약관 동의 모달 닫기
export function closeTermsModal() {
    const modal = document.getElementById('termsModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 약관 동의 취소 (로그아웃)
export async function cancelTermsAgreement() {
    // 명시적 로그아웃 플래그 설정
    sessionStorage.setItem('explicitLogout', 'true');
    await signOut(auth);
    window.location.reload();
}

// 약관 상세 보기 토글
export function showTermsDetail(type) {
    const contentId = type === 'terms' ? 'termsContent' : 'privacyContent';
    const content = document.getElementById(contentId);
    if (content) {
        content.classList.toggle('hidden');
    }
}

// 약관 동의 버튼 상태 업데이트
export function updateTermsAgreeButton() {
    const termsChecked = document.getElementById('termsAgreement')?.checked || false;
    const privacyChecked = document.getElementById('privacyAgreement')?.checked || false;
    const agreeBtn = document.getElementById('termsAgreeBtn');
    
    if (agreeBtn) {
        if (termsChecked && privacyChecked) {
            agreeBtn.disabled = false;
            agreeBtn.className = 'flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm shadow-md active:bg-emerald-700 transition-colors';
        } else {
            agreeBtn.disabled = true;
            agreeBtn.className = 'flex-1 py-3 bg-slate-300 text-white rounded-xl font-bold text-sm';
        }
    }
}

// 약관 동의 확인
export async function confirmTermsAgreement() {
    const termsChecked = document.getElementById('termsAgreement')?.checked || false;
    const privacyChecked = document.getElementById('privacyAgreement')?.checked || false;
    
    if (!termsChecked || !privacyChecked) {
        showToast("모든 약관에 동의해주세요.", "error");
        return;
    }
    
    try {
        // 사용자 설정에 약관 동의 정보 저장
        if (!window.userSettings) {
            window.userSettings = { ...DEFAULT_USER_SETTINGS };
        }
        
        window.userSettings.termsAgreed = true;
        window.userSettings.termsAgreedAt = new Date().toISOString();
        
        // Firestore에서 현재 약관 버전 가져오기 (동적 import로 안전하게 로드)
        const { getCurrentTermsVersion } = await import('./utils-terms.js');
        const currentVersion = await getCurrentTermsVersion();
        window.userSettings.termsVersion = currentVersion;
        
        // 이메일 회원가입 플로우: 대기 중인 프로필을 userSettings에 반영
        if (window._pendingEmailSignupProfile) {
            const pending = window._pendingEmailSignupProfile;
            Object.assign(window.userSettings, pending);
            window._pendingEmailSignupProfile = null;
        }
        
        // providerId와 email을 현재 사용자 정보로 설정 (없을 때만, 또는 같은 providerId일 때만)
        try {
            const currentUser = auth.currentUser;
            if (currentUser && !currentUser.isAnonymous) {
                // providerId는 없을 때만 설정 (덮어쓰기 방지)
                if (currentUser.providerData && currentUser.providerData.length > 0) {
                    const currentProviderId = currentUser.providerData[0].providerId;
                    if (!window.userSettings.providerId) {
                        window.userSettings.providerId = currentProviderId;
                    } else if (window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만 (다른 계정일 수 있음)
                        console.warn(`⚠️ 약관 동의 시 providerId 불일치: 저장된(${window.userSettings.providerId}) vs 현재(${currentProviderId}). 기존 값 유지합니다.`);
                    }
                }
                // email은 같은 providerId일 때만 업데이트
                if (currentUser.email) {
                    const currentProviderId = currentUser.providerData?.[0]?.providerId;
                    if (!window.userSettings.email) {
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId === currentProviderId && window.userSettings.email !== currentUser.email) {
                        // 같은 providerId인데 이메일이 다르면 업데이트
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 약관 동의 시 providerId 불일치로 인한 email 불일치: 저장된(${window.userSettings.email}) vs 현재(${currentUser.email}). 기존 값 유지합니다.`);
                    }
                }
            }
        } catch (e) {
            console.warn('약관 동의 시 사용자 정보 가져오기 실패:', e);
        }
        
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        
        if (typeof window.ensureUserRegistered === 'function') {
            await window.ensureUserRegistered();
        }
        
        closeTermsModal();
        
        // 인증 플로우 관리자에게 다음 단계 처리 요청
        const { authFlowManager } = await import('./auth-flow.js');
        await authFlowManager.onTermsAgreed();
    } catch (e) {
        console.error("약관 동의 저장 실패:", e);
        // 모달을 닫고 토스트를 표시하여 사용자가 에러를 볼 수 있도록 함
        closeTermsModal();
        
        let errorMessage = "약관 동의 저장에 실패했습니다.";
        if (e.code === 'permission-denied') {
            errorMessage = "권한이 없습니다. 잠시 후 다시 시도해주세요.";
        } else if (e.code === 'unavailable') {
            errorMessage = "네트워크 연결을 확인해주세요.";
        }
        
        // 약간의 지연 후 토스트 표시 (모달이 완전히 닫힌 후)
        setTimeout(() => {
            showToast(errorMessage, "error");
        }, 300);
    }
}

// 프로필 설정 모달 표시 (구글 등 로그인 후 프로필만 입력할 때)
export function showProfileSetupModal() {
    window._profileModalMode = 'profileOnly';
    const block = document.getElementById('emailSignupBlock');
    if (block) block.classList.add('hidden');
    const titleEl = document.getElementById('profileSetupModalTitle');
    if (titleEl) titleEl.textContent = '프로필 설정';
    const descEl = document.getElementById('profileSetupModalDescription');
    if (descEl) descEl.textContent = '서비스를 이용하기 위해 닉네임을 입력해주세요.';
    const btn = document.getElementById('profileSetupBtn');
    if (btn) btn.textContent = '시작하기';
    const guestBtn = document.getElementById('profileSetupGuestBtn');
    if (guestBtn) guestBtn.classList.remove('hidden');
    _showProfileSetupModalCommon();
}

// 이메일 회원가입용: 이메일+비번+비번확인+회원정보 한 화면
export function showProfileSetupModalForEmailSignup() {
    window._profileModalMode = 'emailSignup';
    const block = document.getElementById('emailSignupBlock');
    if (block) block.classList.remove('hidden');
    const titleEl = document.getElementById('profileSetupModalTitle');
    if (titleEl) titleEl.textContent = '회원가입';
    const descEl = document.getElementById('profileSetupModalDescription');
    if (descEl) descEl.textContent = '이메일, 비밀번호와 회원정보를 입력해주세요.';
    const btn = document.getElementById('profileSetupBtn');
    if (btn) btn.textContent = '가입하기';
    const guestBtn = document.getElementById('profileSetupGuestBtn');
    if (guestBtn) guestBtn.classList.add('hidden');
    const signupEmail = document.getElementById('signupEmailInput');
    const signupPw = document.getElementById('signupPasswordInput');
    const signupPwConfirm = document.getElementById('signupPasswordConfirmInput');
    if (signupEmail) signupEmail.value = '';
    if (signupPw) signupPw.value = '';
    if (signupPwConfirm) signupPwConfirm.value = '';
    _showProfileSetupModalCommon();
}

function _showProfileSetupModalCommon() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) {
        modal.classList.remove('hidden');
        
        // 닉네임 입력 초기화
        const nicknameInput = document.getElementById('setupNickname');
        if (nicknameInput) {
            nicknameInput.value = '';
        }
        const birthdateInput = document.getElementById('setupBirthdate');
        if (birthdateInput) {
            birthdateInput.value = '';
        }
        const lifestyleSelect = document.getElementById('setupLifestyle');
        if (lifestyleSelect) {
            lifestyleSelect.value = '';
        }
        // 버튼 선택 상태 초기화
        document.querySelectorAll('.setup-lifestyle-btn').forEach(btn => {
            btn.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-600');
            btn.classList.add('bg-slate-50', 'text-slate-600', 'border-slate-200');
        });
        const setupGenderHidden = document.getElementById('setupGender');
        if (setupGenderHidden) setupGenderHidden.value = '';
        document.querySelectorAll('.setup-gender-btn').forEach(btn => {
            btn.classList.remove('bg-emerald-600', 'text-white');
            btn.classList.add('bg-slate-50', 'text-slate-600');
        });
    }
}

// 프로필 설정 모달 닫기
export function closeProfileSetupModal() {
    const modal = document.getElementById('profileSetupModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

/** 프로필 설정을 건너뛰고 게스트로 둘러보기 */
export async function continueAsGuestFromProfileSetup() {
    closeProfileSetupModal();
    try {
        sessionStorage.setItem('guestFromProfileSetup', 'true');
        showLoading('둘러보기로 시작하는 중...');
        await signOut(auth);
        const { signInAsDemoAccount, requestDemoIntroFromBrowse } = await import('./demo-account.js');
        try {
            requestDemoIntroFromBrowse();
            await signInAsDemoAccount();
            showToast('샘플 계정으로 둘러보기를 시작합니다.', 'info');
        } catch (eDemo) {
            console.warn('데모 둘러보기 실패, 익명 로그인 시도:', eDemo);
            await signInAnonymously(auth);
            showToast('게스트 모드로 둘러보기를 시작합니다.', 'info');
        }
    } catch (e) {
        sessionStorage.removeItem('guestFromProfileSetup');
        console.error("둘러보기 전환 실패:", e);
        showToast("둘러보기로 시작할 수 없습니다. 다시 시도해주세요.", "error");
        hideLoading();
    }
}

// 아이콘 선택 영역 렌더링
function renderSetupIconSelector() {
    const container = document.getElementById('setupIconSelector');
    if (!container) return;
    
    // 동적 import로 변경
    import('./constants.js').then(({ DEFAULT_ICONS }) => {
        container.innerHTML = DEFAULT_ICONS.map(icon => `
            <button onclick="window.selectSetupIcon('${icon}')" class="icon-option-setup w-12 h-12 rounded-xl border-2 border-slate-200 flex items-center justify-center text-2xl ${icon === '🐻' ? 'selected border-emerald-500 bg-emerald-50' : ''}" data-icon="${icon}">
                ${icon}
            </button>
        `).join('');
    });
}

// 프로필 설정 아이콘 선택
export function selectSetupIcon(icon) {
    window.selectedSetupIcon = icon;
    document.querySelectorAll('.icon-option-setup').forEach(el => {
        if (el.dataset.icon === icon) {
            el.classList.add('selected', 'border-emerald-500', 'bg-emerald-50');
            el.classList.remove('border-slate-200');
        } else {
            el.classList.remove('selected', 'border-emerald-500', 'bg-emerald-50');
            el.classList.add('border-slate-200');
        }
    });
}

// 프로필 타입 설정
export function setProfileType(type) {
    window.setupProfileType = type;
    
    const emojiBtn = document.getElementById('setupProfileTypeEmoji');
    const photoBtn = document.getElementById('setupProfileTypePhoto');
    const emojiSection = document.getElementById('setupEmojiSection');
    const photoSection = document.getElementById('setupPhotoSection');
    
    if (type === 'emoji') {
        if (emojiBtn) {
            emojiBtn.className = 'flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold active:bg-emerald-700 transition-colors';
        }
        if (photoBtn) {
            photoBtn.className = 'flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold active:bg-slate-200 transition-colors';
        }
        if (emojiSection) emojiSection.classList.remove('hidden');
        if (photoSection) photoSection.classList.add('hidden');
    } else {
        if (emojiBtn) {
            emojiBtn.className = 'flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold active:bg-slate-200 transition-colors';
        }
        if (photoBtn) {
            photoBtn.className = 'flex-1 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-bold active:bg-emerald-700 transition-colors';
        }
        if (emojiSection) emojiSection.classList.add('hidden');
        if (photoSection) photoSection.classList.remove('hidden');
    }
}

// 프로필 사진 업로드 처리
export async function handleSetupPhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showToast("이미지 파일만 업로드할 수 있습니다.", "error");
        return;
    }
    
    try {
        // 이미지 압축 및 미리보기
        const { compressImageToBlob } = await import('./utils.js');
        const compressedBlob = await compressImageToBlob(file);
        const photoUrl = URL.createObjectURL(compressedBlob);
        
        window.setupPhotoUrl = photoUrl;
        window.setupPhotoFile = compressedBlob;
        
        // 미리보기 업데이트
        const photoPreview = document.getElementById('setupPhotoPreview');
        if (photoPreview) {
            photoPreview.style.backgroundImage = `url(${photoUrl})`;
            photoPreview.style.backgroundSize = 'cover';
            photoPreview.style.backgroundPosition = 'center';
            photoPreview.innerHTML = '';
        }
    } catch (e) {
        console.error("사진 업로드 처리 실패:", e);
        showToast("사진 업로드 중 오류가 발생했습니다.", "error");
    }
}

/** 이메일 회원가입: 이메일+비번+회원정보 한 번에 제출 → 계정 생성 후 약관 단계로 */
export async function handleEmailSignupWithProfile() {
    const email = (document.getElementById('signupEmailInput')?.value || '').trim();
    const password = document.getElementById('signupPasswordInput')?.value || '';
    const passwordConfirm = document.getElementById('signupPasswordConfirmInput')?.value || '';
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
        showToast("올바른 이메일을 입력해주세요.", "error");
        return;
    }
    if (!password || password.length < 6) {
        showToast("비밀번호는 6자리 이상이어야 합니다.", "error");
        return;
    }
    if (password !== passwordConfirm) {
        showToast("비밀번호가 일치하지 않습니다.", "error");
        return;
    }
    
    const nicknameInput = document.getElementById('setupNickname');
    const nickname = nicknameInput?.value.trim() || '';
    const birthdate = (document.getElementById('setupBirthdate')?.value || '').trim();
    const lifestyle = (document.getElementById('setupLifestyle')?.value || '').trim();
    const gender = (document.getElementById('setupGender')?.value || '').trim() || null;
    
    if (!nickname) {
        showToast("닉네임을 입력해주세요.", "error");
        return;
    }
    if (nickname.length > 20) {
        showToast("닉네임은 20자 이하로 입력해주세요.", "error");
        return;
    }
    
    const { containsProfanity, isNicknameDuplicate } = await import('./utils/nickname.js');
    if (containsProfanity(nickname)) {
        showToast("사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }
    const duplicate = await isNicknameDuplicate(nickname, null);
    if (duplicate) {
        showToast("이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }
    if (!birthdate) {
        showToast("생년월일을 입력해주세요.", "error");
        return;
    }
    const { formatted, valid } = normalizeBirthdateRaw(birthdate);
    if (!valid) {
        showToast("입력한 생년월일이 올바르지 않습니다. 숫자 8자리(예: 19900115)로 입력해주세요.", "error");
        return;
    }
    
    showLoading('가입 중...', { skipOnLoginScreen: false });
    try {
        const result = await createUserWithEmailAndPassword(auth, email, password);
        console.log('🔐 이메일 회원가입 성공:', { uid: result.user.uid, email: result.user.email });
        window._recordsLoadHidePending = true;
        showLoading('기록을 불러오고 있어요', { dimBackground: false, skipOnLoginScreen: false });
        showToast("회원가입 성공! 약관에 동의해주세요.", "success");
        
        window._pendingEmailSignupProfile = {
            profile: {
                nickname,
                birthdate: formatted,
                lifestyle,
                gender: (gender === 'male' || gender === 'female') ? gender : null,
                birthdateChangeCount: 0,
                birthdateChangedAt: null,
                iconType: 'text',
                icon: null,
                photoUrl: null
            },
            profileCompleted: true,
            profileCompletedAt: new Date().toISOString()
        };
        closeProfileSetupModal();
        // 약관 모달은 onAuthStateChanged → checkTermsAndProfileInBackground 에서 표시됨
    } catch (error) {
        console.error('🔐 이메일 회원가입 에러:', error);
        let msg = error.message || '알 수 없는 오류가 발생했습니다.';
        if (error.code === 'auth/email-already-in-use') msg = "이미 사용 중인 이메일입니다.";
        else if (error.code === 'auth/weak-password') msg = "비밀번호는 6자리 이상이어야 합니다.";
        else if (error.code === 'auth/invalid-email') msg = "올바른 이메일 형식이 아닙니다.";
        else if (error.code === 'auth/network-request-failed') msg = "네트워크 연결을 확인해주세요.";
        showToast("오류: " + msg, "error");
        hideLoading();
    }
}

// 프로필 설정 확인
export async function confirmProfileSetup() {
    const nicknameInput = document.getElementById('setupNickname');
    const nickname = nicknameInput?.value.trim() || '';

    const birthdate = (document.getElementById('setupBirthdate')?.value || '').trim();
    const lifestyle = (document.getElementById('setupLifestyle')?.value || '').trim();
    const gender = (document.getElementById('setupGender')?.value || '').trim() || null;
    
    if (!nickname) {
        showToast("닉네임을 입력해주세요.", "error");
        return;
    }
    
    if (nickname.length > 20) {
        showToast("닉네임은 20자 이하로 입력해주세요.", "error");
        return;
    }
    
    const { containsProfanity, isNicknameDuplicate } = await import('./utils/nickname.js');
    if (containsProfanity(nickname)) {
        showToast("사용할 수 없는 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }
    
    const duplicate = await isNicknameDuplicate(nickname, auth.currentUser?.uid || null);
    if (duplicate) {
        showToast("이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.", "error");
        return;
    }

    if (!birthdate) {
        showToast("생년월일을 입력해주세요.", "error");
        return;
    }

    const { formatted, valid } = normalizeBirthdateRaw(birthdate);
    if (!valid) {
        showToast("입력한 생년월일이 올바르지 않습니다. 숫자 8자리(예: 19900115)로 입력해주세요.", "error");
        return;
    }

    // 라이프스타일은 선택 입력 (필수 아님)
    
    try {
        if (!window.userSettings) {
            window.userSettings = { ...DEFAULT_USER_SETTINGS };
        }
        
        window.userSettings.profile.nickname = nickname;
        window.userSettings.profile.birthdate = formatted;
        window.userSettings.profile.lifestyle = lifestyle;
        window.userSettings.profile.gender = (gender === 'male' || gender === 'female') ? gender : null;
        window.userSettings.profile.birthdateChangeCount = 0;
        window.userSettings.profile.birthdateChangedAt = null;
        // 초기 가입은 아이콘 설정 없이 텍스트(닉네임 첫 글자) 기본
        window.userSettings.profile.iconType = 'text';
        window.userSettings.profile.icon = null;
        window.userSettings.profile.photoUrl = null;
        // 프로필 완료 플래그 저장 (닉네임 문자열에 의존하지 않기 위함)
        window.userSettings.profileCompleted = true;
        window.userSettings.profileCompletedAt = new Date().toISOString();
        
        // providerId와 email을 현재 사용자 정보로 설정 (없을 때만, 또는 같은 providerId일 때만)
        try {
            const currentUser = auth.currentUser;
            if (currentUser && !currentUser.isAnonymous) {
                // providerId는 없을 때만 설정 (덮어쓰기 방지)
                if (currentUser.providerData && currentUser.providerData.length > 0) {
                    const currentProviderId = currentUser.providerData[0].providerId;
                    if (!window.userSettings.providerId) {
                        window.userSettings.providerId = currentProviderId;
                    } else if (window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 프로필 설정 시 providerId 불일치: 저장된(${window.userSettings.providerId}) vs 현재(${currentProviderId}). 기존 값 유지합니다.`);
                    }
                }
                // email은 같은 providerId일 때만 업데이트
                if (currentUser.email) {
                    const currentProviderId = currentUser.providerData?.[0]?.providerId;
                    if (!window.userSettings.email) {
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId === currentProviderId && window.userSettings.email !== currentUser.email) {
                        // 같은 providerId인데 이메일이 다르면 업데이트
                        window.userSettings.email = currentUser.email;
                    } else if (currentProviderId && window.userSettings.providerId !== currentProviderId) {
                        // providerId가 다르면 경고만
                        console.warn(`⚠️ 프로필 설정 시 providerId 불일치로 인한 email 불일치: 저장된(${window.userSettings.email}) vs 현재(${currentUser.email}). 기존 값 유지합니다.`);
                    }
                }
            }
        } catch (e) {
            console.warn('프로필 설정 시 사용자 정보 가져오기 실패:', e);
        }
        
        const { dbOps } = await import('./db.js');
        await dbOps.saveSettings(window.userSettings);
        
        // 가입 완료(프로필 설정 후) 사용자 문서에 createdAt 등록
        if (typeof window.ensureUserRegistered === 'function') {
            await window.ensureUserRegistered();
        }
        
        // 헤더 업데이트
        const { updateHeaderUI } = await import('./ui.js');
        updateHeaderUI();
        
        closeProfileSetupModal();
        
        // 인증 플로우 관리자에게 다음 단계 처리 요청
        const { authFlowManager } = await import('./auth-flow.js');
        await authFlowManager.onProfileSetup();
    } catch (e) {
        console.error("프로필 설정 저장 실패:", e);
        
        let errorMessage = "프로필 설정 저장에 실패했습니다.";
        if (e.code === 'permission-denied') {
            errorMessage = "권한이 없습니다. Firebase 보안 규칙을 확인해주세요.";
        } else if (e.code === 'unavailable') {
            errorMessage = "네트워크 연결을 확인해주세요.";
        }
        
        showToast(errorMessage, "error");
    }
}