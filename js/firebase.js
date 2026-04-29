// Firebase 초기화 및 설정
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAnalytics, logEvent as analyticsLogEvent, setUserId, setUserProperties } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-analytics.js";
import { getAuth, initializeAuth, setPersistence, browserLocalPersistence, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
    getFirestore,
    initializeFirestore,
    setLogLevel,
    memoryLocalCache,
    persistentLocalCache,
    persistentSingleTabManager,
    terminate,
    clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";

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

// 이전에는 experimentalForceLongPolling으로 b815를 완화하려 했으나,
// 동일 설정이 Watch(ca9/b815)와 충돌해 오류가 **반복**되는 사례가 있음(GitHub firebase-js-sdk #9267 등).
// 강제 장폴링 대신 자동 감지: 필요할 때만 장폴링, 그 외에는 WebChannel(기본).
//
// 영구 로컬 캐시(IndexedDB): 네트워크 불안정 시에도 setDoc/addDoc 등 Firestore 쓰기가 로컬에 쌓였다가
// 온라인 시 서버로 동기화됨(공식 오프라인 동작). 모먼트·Callable 폴백 등 HTTP 경로는 별도.
//
// 로컬 PC(localhost) + 네트워크 정상이어도 Watch(ca9/b815)가 콘솔에 쌓이는 경우가 있어,
// 개발 시에는 memoryLocalCache만 사용(IndexedDB·멀티탭 상태와의 조합 완화). 스테이징·앱은 영구 캐시 유지.
function isLocalhostWebDev() {
    if (typeof window === 'undefined') return false;
    if (window.Capacitor?.isNativePlatform?.()) return false;
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '';
}

function createFirestore() {
    const transport = { experimentalAutoDetectLongPolling: true };
    const localCache = isLocalhostWebDev()
        ? memoryLocalCache()
        : persistentLocalCache({ tabManager: persistentSingleTabManager() });
    try {
        return initializeFirestore(app, {
            localCache,
            ...transport
        });
    } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes('already') || msg.includes('Already')) {
            return getFirestore(app, '(default)');
        }
        console.warn('Firestore 영구 캐시 초기화 실패(사생활 보호 모드 등), 캐시 없이 재시도:', msg);
        try {
            return initializeFirestore(app, { ...transport });
        } catch (e2) {
            console.warn('Firestore initializeFirestore 실패, getFirestore로 대체:', String(e2?.message || e2));
        }
    }
    return getFirestore(app, '(default)');
}

/** @type {import('firebase/app-check').AppCheck | null} */
export let firebaseAppCheck = null;

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
        const isCapNative =
            typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
        const h = window.location.hostname;
        const isLocalhost =
            h === 'localhost' ||
            h === '127.0.0.1' ||
            h === '0.0.0.0' ||
            h.startsWith('192.168.') ||
            (!isCapNative && h === '');
        /** Capacitor WebView는 호스트가 localhost인 경우가 많아, 디버그 토큰을 켜면 exchangeDebugToken 403이 난다(콘솔 미등록). 네이티브는 reCAPTCHA만 사용 */
        if (isLocalhost && !isCapNative) {
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
            'https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js'
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

/** 연속 저장·삭제 시 매번 getToken(true) 하지 않도록 완화(재시도·force 시에만 강제) */
let lastAppCheckForceRefreshAt = 0;
const APPCHECK_FORCE_MIN_INTERVAL_MS = 4000;

/**
 * App Check: Firestore 쓰기 직전 호출. 기본은 캐시 우선(빠름), 일정 간격마다만 강제 갱신.
 * @param {{ force?: boolean }} [opts] — permission-denied 재시도 시 `force: true` 권장
 */
export async function refreshAppCheckTokenBeforeFirestore(opts = {}) {
    await appCheckInitPromise;
    if (!firebaseAppCheck || typeof window === 'undefined') return;
    try {
        const { getToken } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js');
        const now = Date.now();
        const force =
            opts.force === true || now - lastAppCheckForceRefreshAt >= APPCHECK_FORCE_MIN_INTERVAL_MS;
        await getToken(firebaseAppCheck, force);
        if (force) lastAppCheckForceRefreshAt = now;
    } catch (_) {
        /* ignore */
    }
}

// 공식 가이드: App Check를 Firestore 등보다 먼저 초기화. 기존에는 getFirestore가 먼저라 강제 적용 시 쓰기에 토큰이 안 붙을 수 있음.
await appCheckInitPromise;

/** @type {import('firebase/firestore').Firestore} — Watch(ca9/b815) 등 내부 assertion 후 `recoverFirestoreAfterWatchAssertion`에서 재할당될 수 있음 */
export let db = createFirestore();
try {
    setLogLevel('error');
} catch (_) {
    /* SDK 내부 assertion 등은 여전히 error로 찍힐 수 있음 */
}
export const storage = getStorage(app);

// Functions 초기화 (리전 명시: us-central1)
// 배포된 Functions가 us-central1에 있으므로 해당 리전 사용
export const functions = getFunctions(app, 'us-central1');
export const appId = 'mealog-r0';
export const apiKey = "";

/** main.js가 로그인 사용자용 onSnapshot 등을 다시 붙이는 콜백 등록 (복구 후 호출) */
let firestoreListenersRebind = null;
export function registerFirestoreListenersRebind(fn) {
    firestoreListenersRebind = typeof fn === 'function' ? fn : null;
}

let firestoreRecoverInFlight = null;
let lastFirestoreRecoverSuccessAt = 0;
const FIRESTORE_RECOVER_MIN_INTERVAL_MS = 12000;

function isFirestoreWatchInternalAssertionMessage(msg) {
    const s = String(msg || '');
    return s.includes('FIRESTORE') && s.includes('INTERNAL ASSERTION FAILED');
}

/**
 * Watch 스트림 내부 assertion(b815/ca9, ve:-1 등)으로 Firestore가 깨진 뒤 재개되지 않을 때:
 * terminate → IndexedDB 캐시 제거(가능 시) → 인스턴스 재생성 → 리스너 재등록.
 * @param {string} [reason]
 * @param {{ force?: boolean }} [opts] — true면 최소 간격 무시
 * @returns {Promise<boolean>}
 */
export async function recoverFirestoreAfterWatchAssertion(reason = '', opts = {}) {
    if (typeof window === 'undefined') return false;
    const force = opts.force === true;
    const now = Date.now();
    if (
        !force &&
        lastFirestoreRecoverSuccessAt > 0 &&
        now - lastFirestoreRecoverSuccessAt < FIRESTORE_RECOVER_MIN_INTERVAL_MS
    ) {
        return false;
    }
    if (firestoreRecoverInFlight) return firestoreRecoverInFlight;

    firestoreRecoverInFlight = (async () => {
        try {
            console.warn('[Firestore] Watch 내부 오류 복구 시도:', reason || '(detail omitted)');
            try {
                await terminate(db);
            } catch (e) {
                console.warn('[Firestore] terminate:', e?.message || e);
            }
            try {
                await clearIndexedDbPersistence(app);
            } catch (e) {
                if (e?.code !== 'failed-precondition') {
                    console.warn('[Firestore] clearIndexedDbPersistence:', e?.message || e);
                }
            }
            db = createFirestore();
            try {
                setLogLevel('error');
            } catch (_) {}
            try {
                await refreshAppCheckTokenBeforeFirestore({ force: true });
            } catch (_) {}
            try {
                const u = auth.currentUser;
                if (u && typeof u.getIdToken === 'function') {
                    await u.getIdToken(true);
                }
            } catch (_) {}
            if (firestoreListenersRebind) {
                try {
                    firestoreListenersRebind();
                } catch (e) {
                    console.warn('[Firestore] 리스너 재등록 실패:', e?.message || e);
                }
                try {
                    sessionStorage.removeItem('mealogFsAssertReload');
                } catch (_) {}
                lastFirestoreRecoverSuccessAt = Date.now();
                console.warn('[Firestore] 복구 완료 (리스너 재등록)');
                return true;
            }
            const u = auth.currentUser;
            if (u && !u.isAnonymous) {
                try {
                    if (!sessionStorage.getItem('mealogFsAssertReload')) {
                        sessionStorage.setItem('mealogFsAssertReload', '1');
                        location.reload();
                        return true;
                    }
                } catch (_) {}
            }
            lastFirestoreRecoverSuccessAt = Date.now();
            console.warn('[Firestore] 복구 완료 (인스턴스만 재생성, 리스너는 다음 로그인/새로고침)');
            return true;
        } catch (e) {
            console.error('[Firestore] 복구 실패:', e);
            return false;
        } finally {
            firestoreRecoverInFlight = null;
        }
    })();
    return firestoreRecoverInFlight;
}

let firestoreAssertionRecoverScheduled = false;
function scheduleRecoverFirestoreFromAssertion(detail) {
    if (firestoreAssertionRecoverScheduled) return;
    firestoreAssertionRecoverScheduled = true;
    setTimeout(() => {
        firestoreAssertionRecoverScheduled = false;
        void recoverFirestoreAfterWatchAssertion(detail);
    }, 80);
}

if (typeof window !== 'undefined') {
    window.addEventListener(
        'error',
        (e) => {
            const msg = String(e.message || e.error?.message || '');
            if (isFirestoreWatchInternalAssertionMessage(msg)) {
                scheduleRecoverFirestoreFromAssertion(msg.slice(0, 240));
            }
        },
        true
    );
    window.addEventListener('unhandledrejection', (e) => {
        const msg = String(e.reason?.message || e.reason || '');
        if (isFirestoreWatchInternalAssertionMessage(msg)) {
            e.preventDefault();
            scheduleRecoverFirestoreFromAssertion(msg.slice(0, 240));
        }
    });
}

// Callable Functions 참조
export const callableFunctions = {
    createFeedPost: httpsCallable(functions, 'createFeedPost'),
    createBoardPost: httpsCallable(functions, 'createBoardPost'),
    updateBoardPost: httpsCallable(functions, 'updateBoardPost'),
    deleteBoardPost: httpsCallable(functions, 'deleteBoardPost'),
    addBoardComment: httpsCallable(functions, 'addBoardComment'),
    addBoardCommentAsAdmin: httpsCallable(functions, 'addBoardCommentAsAdmin'),
    deleteBoardComment: httpsCallable(functions, 'deleteBoardComment'),
    deleteBoardCommentAsAdmin: httpsCallable(functions, 'deleteBoardCommentAsAdmin'),
    addNoticeComment: httpsCallable(functions, 'addNoticeComment'),
    deleteNoticeComment: httpsCallable(functions, 'deleteNoticeComment'),
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
    /** 관리자 전용: users 루트 createdAt 을 Auth UID 생성 시각으로 백필 */
    adminBackfillUserRootCreatedAtFromAuth: httpsCallable(functions, 'adminBackfillUserRootCreatedAtFromAuth'),
    /** 관리자 전용: 단일 UID 가입일(루트 createdAt) 보정 */
    adminBackfillUserRootCreatedAtForUid: httpsCallable(functions, 'adminBackfillUserRootCreatedAtForUid'),
    /** 관리자 전용: 가입일 백필 전체를 서버 한 번에 완료 */
    adminBackfillUserRootCreatedAtFromAuthRunAll: httpsCallable(functions, 'adminBackfillUserRootCreatedAtFromAuthRunAll'),
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
    patchArtifactUserRoot: httpsCallable(functions, 'patchArtifactUserRoot'),
    /** 식사 기록 — 클라이언트 Firestore permission-denied 시 Admin 폴백 */
    saveArtifactUserMeal: httpsCallable(functions, 'saveArtifactUserMeal'),
    deleteArtifactUserMeal: httpsCallable(functions, 'deleteArtifactUserMeal'),
    /** 관리자: 웰컴 API — 전일(서울) 기준 연속 기록 N일 이상 사용자 목록 + 3일 요약 */
    adminWelcomeStreakUsers: httpsCallable(functions, 'adminWelcomeStreakUsers'),
    /** 관리자: 웰컴용 제미나이 한 줄 코멘트(메뉴+응원, 서버에서 길이 상한 적용) */
    adminWelcomeGeminiComment: httpsCallable(functions, 'adminWelcomeGeminiComment'),
    /** 관리자: 특정 UID 닉네임 수정 (settings + nicknameClaims) */
    adminSetUserNickname: httpsCallable(functions, 'adminSetUserNickname')
};

/**
 * App Check / Firestore: initAuth 등은 appCheckInitPromise를 카카오 OAuth보다 먼저 await.
 */

// 에러 리포팅 시스템 초기화
(async () => {
    try {
        const { initErrorReporting } = await import('./error-reporting.js');
        await initErrorReporting();
    } catch (e) {
        console.warn('⚠️ 에러 리포팅 초기화 실패:', e);
    }
})();
