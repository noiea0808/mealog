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
    clearIndexedDbPersistence,
    waitForPendingWrites,
    disableNetwork,
    enableNetwork
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { withDeadline, withDeadlineOr, DEADLINE } from './utils/with-deadline.js';
import { diag } from './utils/diagnostics.js';
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

/**
 * App Check 제공자를 **상한 안에 가둔다.** 관문(§4.8) 바깥에 남아 있던 유일한 구멍이다.
 *
 * 2026-08-09 실기기 계측으로 확인한 것: reCAPTCHA v3 가 한 번 얼면 `getToken()` 이 영영
 * 정착하지 않는데, 그 대기를 **두 곳이 각각 상한 없이** 기다린다.
 *
 *   1. `auth._getAppCheckToken()` — Auth 가 토큰 갱신 HTTP 요청을 **발사하기 전에** 기다린다.
 *      그래서 ID 토큰이 만료된 채 굳고(실측 6시간), securetoken 요청이 0건이었다.
 *   2. `db._appCheckCredentials.getToken()` — Firestore 가 스트림을 열기 전에 기다린다.
 *      그래서 WebChannel 요청이 0건이었다.
 *
 * 둘 다 **앱이 부르는 호출이 아니라 SDK 내부**라, 호출부에 상한을 거는 방식으로는 원리적으로
 * 못 막는다. `preflightFirestoreAuth` 의 2초 상한은 자기 호출부만 풀어 줄 뿐, 안쪽에 얼어붙은
 * await 는 그대로 남아 그 위의 모든 것(Firestore·Storage·Callable)이 같이 굶었다.
 * 게다가 `terminate()` + 인스턴스 재생성으로도 안 살아난다 — 자격증명 제공자가 앱 컨테이너에
 * 남아 새 인스턴스가 같은 것을 물려받는다. 세션 안에서는 회복 불가였다.
 *
 * 그래서 SDK 가 기다리는 **바로 그 지점**을 상한 안에 넣는다. 여기가 반드시 정착하면
 * 위의 둘도 따라서 정착한다.
 *
 * 상한을 넘기면 **거절한다.** 직접 더미 토큰을 만들어 돌려주면 안 된다 — App Check 내부가
 * 이미 실패를 더미 토큰(문자열)으로 바꿔 주고, Firestore 는 그 자리에서
 * `hardAssert(typeof token === 'string')` 을 돌리기 때문이다. `{ token: undefined }` 를
 * 돌려주면 `INTERNAL ASSERTION FAILED (ID: ae0e)` 로 즉사한다(실측). 거절만 하면 SDK 가
 * 알아서 올바른 모양을 만든다.
 *
 * 위임만 하므로 SDK 내부 구조에 기대지 않는다. `initializeAppCheck` 는 제공자를 덕 타이핑으로
 * 다루고(`initialize`/`getToken`/`isEqual`), 그 셋이 이 클래스가 구현하는 전부다.
 */
class DeadlineBoundedAppCheckProvider {
    /** @param {{ initialize: (app: any) => void, getToken: () => Promise<any>, isEqual?: (o: any) => boolean }} inner */
    constructor(inner) {
        this.inner = inner;
    }

    initialize(appInstance) {
        return this.inner.initialize(appInstance);
    }

    getToken() {
        // 함수 형태로 넘긴다 — 제공자가 동기로 던져도 관문 밖으로 새지 않게
        return withDeadline(() => this.inner.getToken(), DEADLINE.APPCHECK, 'appcheck-provider').catch((e) => {
            if (e?.__mealogDeadline) noteAppCheckStall();
            throw e;
        });
    }

    isEqual(other) {
        return other instanceof DeadlineBoundedAppCheckProvider && this.inner === other.inner;
    }
}

/**
 * 「App Check 가 응답하지 않는다」를 관측 가능하게 (§4.9).
 *
 * 이번 사고를 알아내는 데 실기기에 CDP 로 붙어야 했다. 다음에는 링버퍼가 스스로 답해야 한다.
 * 한 번의 실패는 흔하므로 시끄럽게 굴지 않고, **연속으로 막히는 것**만 사건으로 남긴다.
 */
let appCheckStallStreak = 0;
let appCheckLastOkAt = Date.now();
/** 이 횟수만큼 연속으로 못 받으면 「막혔다」로 본다 */
const APPCHECK_STALL_STREAK = 3;

function noteAppCheckStall() {
    appCheckStallStreak += 1;
    if (appCheckStallStreak === APPCHECK_STALL_STREAK || appCheckStallStreak % 10 === 0) {
        diag('appcheck.stalled', {
            streak: appCheckStallStreak,
            sinceOkMs: Date.now() - appCheckLastOkAt
        });
    }
}

function noteAppCheckOk() {
    if (appCheckStallStreak >= APPCHECK_STALL_STREAK) {
        diag('appcheck.recovered', { afterStreak: appCheckStallStreak, sinceOkMs: Date.now() - appCheckLastOkAt });
    }
    appCheckStallStreak = 0;
    appCheckLastOkAt = Date.now();
}

/**
 * 「ID 토큰 갱신이 정착하지 않는다」를 관측 가능하게 (§4.9).
 *
 * 이 신호가 이 서브시스템에서 가장 치명적이다. `getIdToken(false)` 는 토큰이 살아 있으면
 * 캐시에서 즉시 돌아오므로, **여기서 못 받는다는 것은 이미 만료됐는데 갱신도 안 된다는 뜻**이고,
 * 그 상태에서는 Firestore·Storage·Callable 이 전부 굶는다. 이번 사고에서 실제로 6시간 동안
 * 그랬는데 계측에는 「preflight-idtoken 데드라인」이라는 그림자만 남아 있었다 — 그것만으로는
 * 「느렸다」와 「죽었다」를 못 가른다. 그래서 연속 실패와 마지막 성공 이후 경과를 같이 남긴다.
 */
let idTokenStallStreak = 0;
let idTokenLastOkAt = Date.now();
const IDTOKEN_STALL_STREAK = 3;

function noteIdTokenResult(ok) {
    if (ok) {
        if (idTokenStallStreak >= IDTOKEN_STALL_STREAK) {
            diag('auth.token.recovered', {
                afterStreak: idTokenStallStreak,
                sinceOkMs: Date.now() - idTokenLastOkAt
            });
        }
        idTokenStallStreak = 0;
        idTokenLastOkAt = Date.now();
        return;
    }
    idTokenStallStreak += 1;
    if (idTokenStallStreak === IDTOKEN_STALL_STREAK || idTokenStallStreak % 10 === 0) {
        diag('auth.token.stalled', {
            streak: idTokenStallStreak,
            sinceOkMs: Date.now() - idTokenLastOkAt,
            appCheckStreak: appCheckStallStreak
        });
    }
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
            // 상한 없는 reCAPTCHA 대기가 Auth·Firestore 를 통째로 얼리지 않게 감싼다
            provider: new DeadlineBoundedAppCheckProvider(
                new ReCaptchaV3Provider('6LdjYVUsAAAAAP7RvrJgOEp-7wvDpmoC8Bll9-Kw')
            ),
            isTokenAutoRefreshEnabled: true
        });
        firebaseAppCheck = appCheck;
        /**
         * 초기 토큰 취득도 상한 안에서만 기다린다. 이 await 가 매달리면 이 모듈의 최상위
         * `await appCheckInitPromise` 가 안 끝나고, **firebase.js 자체가 평가를 마치지 못해**
         * 앱이 통째로 안 뜬다. 제공자에 상한이 걸렸으니 이론상 정착하지만, 부팅 경로에서만큼은
         * 이론에 기대지 않는다.
         */
        await withDeadlineOr(getToken(appCheck, false), DEADLINE.APPCHECK, null, 'appcheck-init-token');
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
    /**
     * 초기화 대기에도 상한이 필요하다. 예전에는 여기가 무제한 `await` 였고, 호출부인
     * `preflightFirestoreAuth` 가 같은 프라미스에 2초 상한을 따로 걸어 두고 있었다 —
     * 그 상한은 **아무것도 보호하지 못했다.** 바로 다음 줄에서 이 함수가 같은 것을 상한 없이
     * 다시 기다렸기 때문이다. 게다가 이 함수는 저장 경로 밖에서도 20곳 가까이 직접 await 되므로,
     * 보호는 호출부가 아니라 여기 있어야 한다.
     */
    await withDeadlineOr(appCheckInitPromise, DEADLINE.PREFLIGHT, undefined, 'appcheck-init-wait');
    if (!firebaseAppCheck || typeof window === 'undefined') return;
    try {
        const { getToken } = await import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-check.js');
        const now = Date.now();
        const force =
            opts.force === true || now - lastAppCheckForceRefreshAt >= APPCHECK_FORCE_MIN_INTERVAL_MS;
        const result = await withDeadlineOr(
            getToken(firebaseAppCheck, force),
            DEADLINE.PREFLIGHT,
            null,
            'appcheck-token'
        );
        if (result?.token) noteAppCheckOk();
        if (force) lastAppCheckForceRefreshAt = now;
    } catch (_) {
        /* ignore */
    }
}

/**
 * Firestore 쓰기 직전 준비 — 토큰·App Check 갱신을 **상한 안에서** 시도한다.
 *
 * 왜 상한이 필수인가 (docs/sync-outbox-design.md §2.1):
 *   이 두 왕복은 원래 상한이 없었다. 반쯤 끊긴 연결(와이파이는 잡혔는데 인터넷 없음, LTE↔Wi-Fi
 *   핸드오버, 캡티브 포털)에서 fetch 는 즉시 실패하지 않고 OS 타임아웃까지 매달린다. 그 사이
 *   상위 10초 저장 타임아웃이 먼저 터지면 **setDoc 이 호출조차 되지 않는다** — Firestore 로컬
 *   큐에 아무것도 없으니 재연결돼도 저절로 올라가지 않고, 앱이 죽는 순간 기록이 사라진다.
 *
 *   같은 실패 모드를 ops.js 에서 이미 한 번 발견해 저장 직전 getDoc 을 제거했지만, 바로 위의
 *   이 두 왕복은 그대로 남아 있었다. 수정이 절반만 됐던 것이다.
 *
 * 실패해도 **던지지 않는다.** 오프라인 큐잉에는 토큰이 필요 없다 — 전송 시점에 SDK 가 붙인다.
 * 여기서 예외를 던지면 호출부가 그걸 다시 중단 조건으로 쓰게 되고, 그게 없애려는 구조 그 자체다.
 *
 * @param {{ getIdToken?: (force?: boolean) => Promise<string> } | null} [user]
 * @param {{ force?: boolean }} [opts]
 */
export async function preflightFirestoreAuth(user, opts = {}) {
    const force = opts.force === true;
    const u = user || auth.currentUser;

    /**
     * **두 갱신을 나란히 돌린다.** 서로 의존하지 않는데 직렬로 두면 각자의 2초 상한이 그대로
     * 더해져, 둘 다 상한을 채우는 콜드 스타트에서 사용자가 4초를 기다린다. 실측이 정확히 그랬다 —
     * 첫 저장의 `save.preflight.done` 이 4003ms 였고, 그 사이 `preflight-idtoken`(2000ms)과
     * `appcheck-token`(2000ms) 이 2.000초 간격으로 차례로 발화했다.
     *
     * `appCheckInitPromise` 대기는 여기서 따로 걸지 않는다. 아래 함수가 첫 줄에서 같은 프라미스를
     * 상한과 함께 기다리므로, 여기서 한 번 더 기다리면 중복일 뿐이다.
     */
    await Promise.all([
        (async () => {
            if (!u || typeof u.getIdToken !== 'function') return;
            const token = await withDeadlineOr(u.getIdToken(force), DEADLINE.PREFLIGHT, null, 'preflight-idtoken');
            noteIdTokenResult(!!token);
        })(),
        refreshAppCheckTokenBeforeFirestore({ force })
    ]);
}

/**
 * **여기서 App Check 를 기다리지 않는다.** (예전에는 `await appCheckInitPromise` 가 있었다)
 *
 * 이 파일은 ES 모듈이므로 최상위 await 는 곧 **모듈 평가 자체를 멈추는 것**이다. 즉 reCAPTCHA v3
 * 로드와 토큰 교환이 끝나야 `db` 가 만들어지고, 그 뒤에야 auth·화면·조회가 시작됐다. 느리면 느린
 * 만큼, 얼면 DEADLINE.APPCHECK(10초)만큼 앱 전체가 그 뒤에 줄을 섰다. 실측된 증상은 부팅 직후
 * 서버 강제 조회가 한꺼번에 실패하는 것이었다(getDocsFromServer 실패 + "client is offline").
 *
 * 순서를 푸는 근거는 SDK 동작이다 — Firestore 의 App Check 자격증명 제공자는 생성 시점에 App Check
 * 가 없으면 `onInit` 으로 등록해 두고, 나중에 초기화되면 그때부터 토큰을 붙인다. 따라서 늦게 초기화
 * 돼도 이후 요청에는 정상적으로 토큰이 실린다.
 *
 * 남는 위험은 **초기화가 끝나기 전 창(window)에 나가는 App Check 필수 쓰기**뿐이다. firestore.rules
 * 에서 `hasValidAppCheckToken()` 을 요구하는 경로(sharedPhotos·boardPosts·각종 댓글의 update/delete)
 * 는 그 자체로 사용자 조작이 필요해 부팅 직후에 발생하지 않거나, 발생할 수 있는 자리
 * (boardOperations.getPost 의 조회수 증가)에는 호출부에서 명시적으로 토큰을 준비한다.
 * 부팅 순서라는 암묵적 보장 대신, 필요한 곳에서만 명시적으로 기다리는 쪽으로 바꾼 것이다.
 */

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

/**
 * 서울 리전 Functions — 지금은 카카오 장소 검색 하나뿐이다.
 *
 * 그 함수는 한국 사용자가 부르고 한국의 카카오 API 를 호출하며 서울 Firestore 를 읽는데,
 * 함수만 미국에 있어 한 번 검색에 태평양을 다섯 번 건넜다(실측 p50 1.3초).
 * 리전이 다르면 호출 주소가 달라서 Functions 인스턴스를 따로 만들어야 한다.
 */
export const functionsSeoul = getFunctions(app, 'asia-northeast3');
export const appId = 'mealog-r0';
export const apiKey = "";

/** main.js가 로그인 사용자용 onSnapshot 등을 다시 붙이는 콜백 등록 (복구 후 호출) */
let firestoreListenersRebind = null;
export function registerFirestoreListenersRebind(fn) {
    firestoreListenersRebind = typeof fn === 'function' ? fn : null;
}

/** 관찰 가능한 onSnapshot 리스너가 붙어 있는지 — 복구 성공을 활동 시각으로 판정할 수 있는지에 사용 */
export function hasFirestoreListenersRegistered() {
    return typeof firestoreListenersRebind === 'function';
}

/** 복구·전환 후 등록된 onSnapshot 리스너 재부착 */
export function rebindFirestoreListenersIfRegistered() {
    if (!firestoreListenersRebind) return false;
    try {
        firestoreListenersRebind();
        return true;
    } catch (e) {
        console.warn('[Firestore] 리스너 재등록 실패:', e?.message || e);
        return false;
    }
}

let listenersRebindTimer = 0;

/** 네트워크 오류로 리스너가 끊긴 뒤 백오프 재부착 */
export function scheduleFirestoreListenersRebind(delayMs = 3000) {
    if (listenersRebindTimer) clearTimeout(listenersRebindTimer);
    listenersRebindTimer = setTimeout(() => {
        listenersRebindTimer = 0;
        rebindFirestoreListenersIfRegistered();
    }, delayMs);
}

let lastTransportKickAt = 0;
const TRANSPORT_KICK_MIN_INTERVAL_MS = 12000;
let transportKickInFlight = null;

/**
 * Wi-Fi↔LTE 등 전환 후 죽은 WebChannel을 가볍게 재연결 (terminate 없음).
 * assertion 폭주 방지를 위해 최소 간격을 둔다.
 * @param {string} [reason]
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export async function kickFirestoreTransportReconnect(reason = '', opts = {}) {
    const force = opts.force === true;
    const now = Date.now();
    if (!force && lastTransportKickAt > 0 && now - lastTransportKickAt < TRANSPORT_KICK_MIN_INTERVAL_MS) {
        return false;
    }
    if (transportKickInFlight) return transportKickInFlight;
    transportKickInFlight = (async () => {
        try {
            console.warn('[Firestore] transport kick:', reason || '(no reason)');
            /**
             * 상한이 필수다. 이 둘이 매달리면 transportKickInFlight 가 영구히 잠기고, 그러면
             * **복구 넛지 자체가 죽는다** — 네트워크가 돌아와도 채널을 다시 찌를 방법이 없어진다.
             * enableNetwork 는 disableNetwork 성공 여부와 무관하게 반드시 시도한다.
             */
            await withDeadlineOr(disableNetwork(db), DEADLINE.DOC, null, 'kick-disableNetwork');
            await withDeadlineOr(enableNetwork(db), DEADLINE.DOC, null, 'kick-enableNetwork');
            lastTransportKickAt = Date.now();
            return true;
        } catch (e) {
            console.warn('[Firestore] transport kick 실패:', e?.message || e);
            return false;
        } finally {
            transportKickInFlight = null;
        }
    })();
    return transportKickInFlight;
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
            // clearIndexedDbPersistence는 로컬 쓰기 큐도 지운다 — 미전송 쓰기 유실을 막기 위해
            // 짧은 시간(4s) 안에 flush를 시도하고, flush가 확인된 경우에만 캐시를 지운다.
            // (오프라인 등으로 큐가 안 비었으면 캐시를 남겨 쓰기 유실 방지 — 재생성만으로도 대부분 복구됨)
            let pendingWritesFlushed = false;
            try {
                pendingWritesFlushed = await Promise.race([
                    waitForPendingWrites(db).then(() => true),
                    new Promise((resolve) => setTimeout(() => resolve(false), 4000))
                ]);
            } catch (e) {
                console.warn('[Firestore] recover 전 waitForPendingWrites:', e?.message || e);
            }
            const dbToClear = db;
            try {
                await terminate(dbToClear);
            } catch (e) {
                console.warn('[Firestore] terminate:', e?.message || e);
            }
            if (pendingWritesFlushed) {
                try {
                    // terminate 된 인스턴스를 넘겨야 함 (app 아님)
                    await clearIndexedDbPersistence(dbToClear);
                } catch (e) {
                    if (e?.code !== 'failed-precondition') {
                        console.warn('[Firestore] clearIndexedDbPersistence:', e?.message || e);
                    }
                }
            } else {
                console.warn('[Firestore] 미전송 쓰기 잔존 — IndexedDB 캐시 유지 (쓰기 유실 방지)');
            }
            db = createFirestore();
            try {
                setLogLevel('error');
            } catch (_) {}
            // 복구 경로에서 토큰 갱신이 매달리면 리스너 재등록까지 못 간다 — 상한 안에서만 시도
            await preflightFirestoreAuth(auth.currentUser, { force: true });
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
    logMealdangAnalysis: httpsCallable(functions, 'logMealdangAnalysis'),
    searchKakaoPlaces: httpsCallable(functionsSeoul, 'searchKakaoPlaces'),
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
    /** usageDaily 페이지별 카운터 (클라이언트 Firestore/App Check 거절 시 폴백) */
    logUsageMetric: httpsCallable(functions, 'logUsageMetric'),
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
    adminSetUserNickname: httpsCallable(functions, 'adminSetUserNickname'),
    /** 날짜별 AI 식단분석 리포트 수동 생성/재생성 */
    regenerateDietReport: httpsCallable(functions, 'regenerateDietReport')
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
