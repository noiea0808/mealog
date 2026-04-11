/**
 * 공용 데모(샘플) 계정 — 읽기 전용, Firestore 규칙과 이메일이 일치해야 함
 */
import { auth, callableFunctions } from './firebase.js';
import {
    signInWithEmailAndPassword,
    signInWithCustomToken,
    signOut
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';

const INTRO_SEEN_KEY = 'mealog_demo_intro_seen';
const AUTO_DEMO_OFF_KEY = 'mealog_auto_demo_off';
const SEEN_REAL_LOGIN_KEY = 'mealog_seen_real_login';
/** 로그인 화면「둘러보기」등으로 데모에 들어올 때 intro_seen과 무관하게 안내 모달 1회 */
const FORCE_INTRO_FROM_BROWSE_KEY = 'mealog_force_demo_intro_from_browse';

/** Firestore 규칙·데모 로그인 이메일 (고정) */
const FALLBACK_DEMO_EMAIL = 'dummy@mealog.net';

async function getDemoPassword() {
    try {
        const c = await import('./config.js');
        if (c.DEMO_ACCOUNT_PASSWORD != null && String(c.DEMO_ACCOUNT_PASSWORD).trim() !== '') {
            return String(c.DEMO_ACCOUNT_PASSWORD).trim();
        }
    } catch (_) {}
    try {
        const d = await import('./config.default.js');
        if (d.DEMO_ACCOUNT_PASSWORD != null && String(d.DEMO_ACCOUNT_PASSWORD).trim() !== '') {
            return String(d.DEMO_ACCOUNT_PASSWORD).trim();
        }
    } catch (_) {}
    return '';
}

export async function isDemoCredentialsConfigured() {
    // Cloud Function signInAsDemo 배포 시 비밀번호 없이도 둘러보기 가능
    return true;
}

/** 동기 판별 — 이메일은 기본값과 config.default만 반영 (런타임 config.js 이메일 변경은 드묾) */
export function isDemoUser(user) {
    if (!user || user.isAnonymous || !user.email) return false;
    const em = user.email.toLowerCase().trim();
    return em === FALLBACK_DEMO_EMAIL;
}

/** 체험(샘플) 계정에서 좋아요·북마크 시 토스트 */
export const DEMO_TOAST_CANNOT_LIKE = "체험 모드에서는 '좋아요'를 할 수 없어요";
export const DEMO_TOAST_CANNOT_BOOKMARK = "체험 모드에서는 '북마크'를 할 수 없어요";

export async function signInAsDemoAccount() {
    let callableErr = null;
    try {
        const res = await callableFunctions.signInAsDemo({});
        const customToken = res?.data?.customToken;
        if (customToken) {
            await signInWithCustomToken(auth, customToken);
            return;
        }
    } catch (e) {
        callableErr = e;
        console.warn('signInAsDemo callable 실패, 이메일/비밀번호 폴백:', e?.code || e?.message || e);
    }
    const email = FALLBACK_DEMO_EMAIL;
    const password = await getDemoPassword();
    if (!password) {
        const detail = callableErr ? ' Functions에 signInAsDemo 배포 후 다시 시도하거나' : '';
        throw new Error(`DEMO_ACCOUNT_PASSWORD 미설정.${detail}`);
    }
    await signInWithEmailAndPassword(auth, email, password);
}

export function markUserHasRealLogin() {
    try {
        localStorage.setItem(SEEN_REAL_LOGIN_KEY, '1');
    } catch (_) {}
}

/** 둘러보기·배너 등으로 데모 로그인 직전 호출 → 메인 진입 시 안내 팝업 표시 */
export function requestDemoIntroFromBrowse() {
    try {
        sessionStorage.setItem(FORCE_INTRO_FROM_BROWSE_KEY, '1');
    } catch (_) {}
}

/** ESC·백드롭 등으로 데모 안내를 닫을 때 (「시작하기」와 동일하게 다시 뜨지 않도록 표시 처리) */
export function dismissDemoIntroModal() {
    const modal = document.getElementById('demoIntroModal');
    if (!modal || modal.classList.contains('hidden')) return;
    try {
        localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch (_) {}
    modal.classList.add('hidden');
}

export function maybeShowDemoIntroModal() {
    try {
        let forceFromBrowse = false;
        try {
            forceFromBrowse = sessionStorage.getItem(FORCE_INTRO_FROM_BROWSE_KEY) === '1';
        } catch (_) {}
        if (!forceFromBrowse && localStorage.getItem(INTRO_SEEN_KEY) === '1') return;
        if (!isDemoUser(auth.currentUser)) return;
        if (forceFromBrowse) {
            try {
                sessionStorage.removeItem(FORCE_INTRO_FROM_BROWSE_KEY);
            } catch (_) {}
        }
        const el = document.getElementById('demoIntroModal');
        if (!el) return;
        el.classList.remove('hidden');
    } catch (_) {}
}

export function registerDemoIntroModalHandlers() {
    const modal = document.getElementById('demoIntroModal');
    const btnContinue = document.getElementById('demoIntroContinueBtn');
    const btnSignup = document.getElementById('demoIntroSignupBtn');
    if (!modal || !btnContinue || !btnSignup) return;

    const close = () => modal.classList.add('hidden');

    btnContinue.addEventListener('click', () => {
        try {
            localStorage.setItem(INTRO_SEEN_KEY, '1');
        } catch (_) {}
        close();
    });

    btnSignup.addEventListener('click', () => {
        try {
            localStorage.setItem(INTRO_SEEN_KEY, '1');
            localStorage.setItem(AUTO_DEMO_OFF_KEY, '1');
        } catch (_) {}
        close();
        try {
            sessionStorage.setItem('explicitLogout', 'true');
            sessionStorage.setItem('wasDemoUserLogout', 'true');
            // localStorage에도 저장하여 페이지 리로드 후에도 유지
            localStorage.setItem('explicitLogout', 'true');
            localStorage.setItem('wasDemoUserLogout', 'true');
        } catch (_) {}
        signOut(auth).catch((e) => console.warn('데모→로그인 화면 전환 signOut:', e));
    });
}
