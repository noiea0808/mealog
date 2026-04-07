// Firebase 초기화 및 설정
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAnalytics, logEvent as analyticsLogEvent, setUserId, setUserProperties } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-analytics.js";
import { getAuth, initializeAuth, setPersistence, browserLocalPersistence, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, initializeFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-storage.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyDMhxZHK7CgtiUACy9fOIiT7IDUW1uAWBc",
    authDomain: "mealog-r0.firebaseapp.com",
    projectId: "mealog-r0",
    storageBucket: "mealog-r0.firebasestorage.app",
    messagingSenderId: "535597498508",
    appId: "1:535597498508:web:28a883a1acd8a955b87ba9",
    measurementId: "G-9BV2LKSTCD"
};

export const app = initializeApp(firebaseConfig);

// Firebase Analytics (GA4) - measurementId가 있으면 초기화
let analytics = null;
try {
    if (firebaseConfig.measurementId) {
        analytics = getAnalytics(app);
    }
} catch (e) {
    console.warn('Firebase Analytics 초기화 실패:', e?.message || e);
}
export { analytics };

/** Firebase Analytics 이벤트 로깅 (analytics가 없으면 무시) */
export function logAnalyticsEvent(eventName, eventParams = {}) {
    if (analytics) {
        try {
            analyticsLogEvent(analytics, eventName, eventParams);
        } catch (e) {
            console.warn('Analytics logEvent 실패:', e?.message || e);
        }
    }
}

/** 로그인한 사용자 ID 설정 (선택) */
export function setAnalyticsUserId(userId) {
    if (analytics && userId) {
        try {
            setUserId(analytics, userId);
        } catch (e) {
            console.warn('Analytics setUserId 실패:', e?.message || e);
        }
    }
}

/** 사용자 속성 설정 (선택) */
export function setAnalyticsUserProperties(properties) {
    if (analytics && properties && typeof properties === 'object') {
        try {
            setUserProperties(analytics, properties);
        } catch (e) {
            console.warn('Analytics setUserProperties 실패:', e?.message || e);
        }
    }
}

// Capacitor 네이티브에서는 getAuth 사용 시 인증이 멈출 수 있음 → initializeAuth + IndexedDB 사용
function getAuthInstance() {
    if (typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.()) {
        try {
            return initializeAuth(app, { persistence: indexedDBLocalPersistence });
        } catch (e) {
            console.warn('Firebase initializeAuth(IndexedDB) 실패, getAuth 사용:', e?.message || e);
            return getAuth(app);
        }
    }
    return getAuth(app);
}
export const auth = getAuthInstance();
if (!(typeof window.Capacitor !== 'undefined' && window.Capacitor?.isNativePlatform?.())) {
    setPersistence(auth, browserLocalPersistence).catch((e) => {
        console.warn('Auth persistence 설정 실패:', e);
    });
}
// 이메일 인증·비밀번호 재설정 메일을 한글로 발송
auth.languageCode = 'ko';

// Android WebView 등에서 firestore.googleapis.com QUIC(WebChannel) 오류(ERR_QUIC_*)로 쓰기 실패하는 경우가 있어
// 네이티브 앱에서는 장폴링을 강제해 FCM 토큰 저장·실시간 구독 안정화
function createFirestore() {
    const native = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
    if (native) {
        try {
            return initializeFirestore(app, {
                experimentalForceLongPolling: true
            });
        } catch (e) {
            const msg = String(e?.message || e);
            if (msg.includes('already') || msg.includes('Already')) {
                return getFirestore(app);
            }
            console.warn('Firestore initializeFirestore 실패, getFirestore로 대체:', msg);
        }
    }
    return getFirestore(app);
}
export const db = createFirestore();
export const storage = getStorage(app);

// Functions 초기화 (리전 명시: us-central1)
// 배포된 Functions가 us-central1에 있으므로 해당 리전 사용
export const functions = getFunctions(app, 'us-central1');
export const appId = 'mealog-r0';
export const apiKey = "";

// Callable Functions 참조
export const callableFunctions = {
    createFeedPost: httpsCallable(functions, 'createFeedPost'),
    createBoardPost: httpsCallable(functions, 'createBoardPost'),
    updateBoardPost: httpsCallable(functions, 'updateBoardPost'),
    deleteBoardPost: httpsCallable(functions, 'deleteBoardPost'),
    addBoardComment: httpsCallable(functions, 'addBoardComment'),
    addBoardCommentAsAdmin: httpsCallable(functions, 'addBoardCommentAsAdmin'),
    deleteBoardComment: httpsCallable(functions, 'deleteBoardComment'),
    addPostComment: httpsCallable(functions, 'addPostComment'),
    deletePostComment: httpsCallable(functions, 'deletePostComment'),
    submitPostReport: httpsCallable(functions, 'submitPostReport'),
    sharePhotos: httpsCallable(functions, 'sharePhotos'),
    unsharePhotos: httpsCallable(functions, 'unsharePhotos'),
    createDailyShare: httpsCallable(functions, 'createDailyShare'),
    createBestShare: httpsCallable(functions, 'createBestShare'),
    createInsightShare: httpsCallable(functions, 'createInsightShare'),
    getStorageImageAsBase64: httpsCallable(functions, 'getStorageImageAsBase64'),
    backfillUserStats: httpsCallable(functions, 'backfillUserStats'),
    /** 관리자 전용: 특정 UID의 daily stats 백필 */
    adminBackfillUserStats: httpsCallable(functions, 'adminBackfillUserStats'),
    removeDuplicateMeals: httpsCallable(functions, 'removeDuplicateMeals'),
    callGemini: httpsCallable(functions, 'callGemini'),
    searchKakaoPlaces: httpsCallable(functions, 'searchKakaoPlaces'),
    getApkUploadUrl: httpsCallable(functions, 'getApkUploadUrl'),
    confirmApkUpload: httpsCallable(functions, 'confirmApkUpload'),
    migrateSharedPhotosTimestamp: httpsCallable(functions, 'migrateSharedPhotosTimestamp'),
    getSharedEntryComment: httpsCallable(functions, 'getSharedEntryComment'),
    getSharedEntryComments: httpsCallable(functions, 'getSharedEntryComments'),
    backfillSharedPhotosComments: httpsCallable(functions, 'backfillSharedPhotosComments'),
    /** 둘러보기 전용 — 비로그인 호출 (데모 UID 커스텀 토큰) */
    signInAsDemo: httpsCallable(functions, 'signInAsDemo'),
    /** 카카오 액세스 토큰 → Firebase 커스텀 토큰 (비로그인 호출) */
    signInWithKakao: httpsCallable(functions, 'signInWithKakao'),
    /** 네이티브 앱: 카카오 인가 페이지 URL (REST 키는 Functions에서만 사용) */
    getKakaoOAuthAuthorizeUrl: httpsCallable(functions, 'getKakaoOAuthAuthorizeUrl'),
    /** FCM 토큰 문서 저장 폴백 (클라이언트 Firestore/App Check 거절 시) */
    registerFcmToken: httpsCallable(functions, 'registerFcmToken'),
    /** 클라이언트 Firestore permission-denied 시 설정+닉네임클레임 저장 폴백 (Admin) */
    saveArtifactUserSettings: httpsCallable(functions, 'saveArtifactUserSettings'),
    /** users/{uid} 루트 문서(lastLoginAt·createdAt·providerId·email) — 클라이언트 쓰기 거절 시 Admin 병합 */
    patchArtifactUserRoot: httpsCallable(functions, 'patchArtifactUserRoot')
};

/**
 * App Check — Firestore 강제 시 토큰 없으면 permission-denied.
 * initAuth는 appCheckInitPromise를 카카오 OAuth보다 먼저 await.
 */
/** @type {import('firebase/app-check').AppCheck | null} */
export let firebaseAppCheck = null;

/**
 * App Check 강제 시, 초기화 직후 첫 Firestore 쓰기가 토큰 없이 나가 permission-denied 나는 경우 완화
 */
export async function refreshAppCheckTokenBeforeFirestore() {
    await appCheckInitPromise;
    if (!firebaseAppCheck || typeof window === 'undefined') return;
    try {
        const { getToken } = await import('https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js');
        await getToken(firebaseAppCheck, true);
    } catch (_) {
        /* ignore */
    }
}

async function resolveAppCheckDebugTokenForLocalhost() {
    try {
        const mod = await import('./config.js');
        if (mod.APPCHECK_DEBUG_TOKEN && String(mod.APPCHECK_DEBUG_TOKEN).trim()) {
            return String(mod.APPCHECK_DEBUG_TOKEN).trim();
        }
    } catch (_) {}
    try {
        const def = await import('./config.default.js');
        if (def.APPCHECK_DEBUG_TOKEN && String(def.APPCHECK_DEBUG_TOKEN).trim()) {
            return String(def.APPCHECK_DEBUG_TOKEN).trim();
        }
    } catch (_) {}
    return '';
}

export const appCheckInitPromise = (async () => {
    try {
        if (typeof window === 'undefined') return;
        const isLocalhost =
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.hostname === '0.0.0.0' ||
            window.location.hostname === '';
        if (isLocalhost) {
            const fixed = await resolveAppCheckDebugTokenForLocalhost();
            if (fixed) {
                window.FIREBASE_APPCHECK_DEBUG_TOKEN = fixed;
                console.info(
                    '🔧 App Check: config의 APPCHECK_DEBUG_TOKEN 사용 중. Firebase Console → App Check → 웹 앱에 동일 토큰이 등록돼 있어야 합니다.'
                );
            } else {
                window.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
                console.warn(
                    '🔧 로컬 App Check: 아래 콘솔에 찍힌 디버그 토큰을 Firebase Console → App Check → 해당 웹 앱 → 디버그 토큰에 등록하세요. ' +
                        '매번 바뀌면 번거로우니 UUID 하나를 만들어 config.js에 APPCHECK_DEBUG_TOKEN으로 넣고, 그 문자열을 콘솔에도 등록하세요. ' +
                        '미등록 시 exchangeDebugToken 403 → Firestore permission-denied가 납니다.'
                );
            }
        }
        const { initializeAppCheck, ReCaptchaV3Provider, getToken } = await import(
            'https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js'
        );
        const appCheck = initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider('6LdjYVUsAAAAAP7RvrJgOEp-7wvDpmoC8Bll9-Kw'),
            isTokenAutoRefreshEnabled: true
        });
        firebaseAppCheck = appCheck;
        await getToken(appCheck, false);
        console.log('✅ App Check 초기화 완료');
    } catch (e) {
        console.warn('⚠️ App Check 초기화 실패 (계속 진행):', e);
    }
})();

// 에러 리포팅 시스템 초기화
(async () => {
    try {
        const { initErrorReporting } = await import('./error-reporting.js');
        await initErrorReporting();
    } catch (e) {
        console.warn('⚠️ 에러 리포팅 초기화 실패:', e);
    }
})();
