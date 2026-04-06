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
    signInWithKakao: httpsCallable(functions, 'signInWithKakao')
};

// App Check 초기화 (reCAPTCHA v3 사용)
// 로컬 개발 환경에서는 App Check를 비활성화 (localhost, 127.0.0.1, 0.0.0.0)
// 에러가 발생해도 앱이 계속 작동하도록 try-catch로 감쌈
(async () => {
    try {
        // 로컬 개발 환경 체크
        const isLocalhost = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.hostname === '0.0.0.0' ||
                           window.location.hostname === '';
        
        if (isLocalhost) {
            console.log('🔧 로컬 개발 환경: App Check 비활성화');
            return;
        }
        
        const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js");
        const appCheck = initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider('6LdjYVUsAAAAAP7RvrJgOEp-7wvDpmoC8Bll9-Kw'),
            isTokenAutoRefreshEnabled: true
        });
        console.log('✅ App Check 초기화 완료');
    } catch (e) {
        console.warn('⚠️ App Check 초기화 실패 (계속 진행):', e);
        // App Check 실패해도 앱은 계속 작동
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
