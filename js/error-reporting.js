// 에러 리포팅 시스템
// Firebase Performance Monitoring과 커스텀 에러 리포팅 통합

let errorReportingInitialized = false;
let errorQueue = [];
const MAX_QUEUE_SIZE = 50;

/**
 * 개발 환경인가 — 리포팅을 끌 것인지의 판정.
 *
 * **hostname 만으로 판정하면 안 된다.** Capacitor 네이티브 빌드는 웹 자산을 앱에 번들해
 * `https://localhost` 에서 서빙한다(`capacitor.config.json` 에 `server.url` 이 없는 형태).
 * 그래서 기존의 `hostname === 'localhost'` 게이트가 **실기기 앱 전체에서** 전역 에러 핸들러
 * 등록을 막고 있었다 — 정작 관측이 가장 필요한 환경에서 리포팅이 꺼져 있었다.
 *
 * 네이티브에서 개발 중인 경우(라이브 리로드)는 `server.url` 이 개발 서버를 가리켜 포트가 붙으므로,
 * 포트 유무로 번들 빌드와 갈라낸다.
 */
function isLocalDevEnvironment() {
    try {
        const host = window.location.hostname;
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '';
        if (!isLoopback) return false;

        const isNative = !!window.Capacitor?.isNativePlatform?.();
        // 네이티브 번들 빌드(포트 없음) = 실기기 프로덕션이므로 리포팅을 켠다
        return !(isNative && !window.location.port);
    } catch (_) {
        return false;
    }
}

/**
 * 에러 리포팅 초기화
 */
export async function initErrorReporting() {
    if (errorReportingInitialized) {
        return;
    }

    try {
        if (isLocalDevEnvironment()) {
            console.log('🔧 로컬 개발 환경: 에러 리포팅 비활성화');
            errorReportingInitialized = true;
            return;
        }

        // Firebase Performance Monitoring 초기화
        try {
            const { getPerformance } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-performance.js");
            const { app } = await import('./firebase.js');
            const perf = getPerformance(app);
            console.log('✅ Firebase Performance Monitoring 초기화 완료');
        } catch (e) {
            console.warn('⚠️ Firebase Performance Monitoring 초기화 실패:', e);
        }

        // 전역 에러 핸들러 설정
        setupGlobalErrorHandlers();
        
        errorReportingInitialized = true;
        console.log('✅ 에러 리포팅 시스템 초기화 완료');
        
        // 큐에 쌓인 에러 처리
        if (errorQueue.length > 0) {
            errorQueue.forEach(error => reportError(error));
            errorQueue = [];
        }
    } catch (e) {
        console.error('❌ 에러 리포팅 초기화 실패:', e);
    }
}

/**
 * 전역 에러 핸들러 설정
 */
function setupGlobalErrorHandlers() {
    // JavaScript 에러 캐치
    window.addEventListener('error', (event) => {
        const em = String(event.message || event.error?.message || '');
        if (isFirestoreSdkInternalAssertion(em)) {
            return;
        }
        // favicon.ico 같은 리소스 로드 실패는 무시
        if (event.target && (event.target.tagName === 'LINK' || event.target.tagName === 'IMG' || event.target.tagName === 'SCRIPT')) {
            const src = event.target.src || event.target.href || '';
            if (src.includes('favicon.ico') || src.includes('manifest.json')) {
                return;
            }
        }
        
        // 실제 JavaScript 오류만 리포팅
        if (event.error || (event.filename && event.filename.endsWith('.js'))) {
            reportError({
                message: event.message || 'Unknown error',
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                error: event.error,
                stack: event.error?.stack,
                type: 'javascript_error',
                url: window.location.href,
                userAgent: navigator.userAgent,
                timestamp: new Date().toISOString()
            });
        }
    }, true);

    // Promise rejection 캐치
    window.addEventListener('unhandledrejection', (event) => {
        const em = String(event.reason?.message || event.reason || '');
        if (isFirestoreSdkInternalAssertion(em)) {
            return;
        }
        reportError({
            message: event.reason?.message || String(event.reason) || 'Unhandled promise rejection',
            reason: event.reason,
            stack: event.reason?.stack,
            type: 'promise_rejection',
            url: window.location.href,
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString()
        });
    });
}

/** Firestore JS SDK 내부 Watch/WebChannel assertion — 앱 버그가 아니라 SDK/전송 계층 이슈로 간주 */
function isFirestoreSdkInternalAssertion(message) {
    const m = String(message || '');
    return m.includes('FIRESTORE') && m.includes('INTERNAL ASSERTION FAILED');
}

/**
 * 에러 리포팅
 */
export function reportError(errorInfo) {
    const msg = String(errorInfo?.message || errorInfo?.error?.message || '');
    if (isFirestoreSdkInternalAssertion(msg)) {
        return;
    }

    // 초기화 전이면 큐에 저장
    if (!errorReportingInitialized) {
        if (errorQueue.length < MAX_QUEUE_SIZE) {
            errorQueue.push(errorInfo);
        }
        return;
    }

    try {
        // 사용자 정보 추가
        const enhancedError = {
            ...errorInfo,
            userId: window.currentUser?.uid || 'anonymous',
            userEmail: window.currentUser?.email || null,
            isAnonymous: window.currentUser?.isAnonymous || false,
            timestamp: errorInfo.timestamp || new Date().toISOString()
        };

        // 콘솔에 로깅 (개발 환경)
        if (isLocalDevEnvironment()) {
            console.error('📊 에러 리포팅:', enhancedError);
        }

        sendErrorToDiagnostics(enhancedError);
    } catch (e) {
        console.error('에러 리포팅 실패:', e);
    }
}

/**
 * 잡힌 에러를 진단 버퍼로 넘긴다.
 *
 * 예전에는 여기서 `artifacts/{appId}/errorLogs` 로 직접 addDoc 했지만, 그 컬렉션은 규칙이
 * `allow write: if false` 라 클라이언트 쓰기가 **항상** permission-denied 로 실패했다 —
 * catch 가 삼켜서 조용했을 뿐 단 한 건도 저장된 적이 없다.
 *
 * 게다가 Firestore 로 바로 보내는 방식 자체가 이 앱에는 맞지 않는다. 관측하려는 실패의 상당수가
 * 네트워크가 반쯤 죽은 상황에서 나는데, 그때는 전송도 같이 실패해 정작 필요한 기록을 잃는다.
 * `diagnostics.js` 는 로컬 링버퍼에 남기고 채널이 살아 있는 것이 관측된 뒤 묶어서 올리므로
 * 그 문제가 없고, 쓰기 경로도 사용자 하위(`syncDiagnostics`)라 규칙이 허용한다.
 */
function sendErrorToDiagnostics(errorInfo) {
    // 중복 에러 방지: 같은 에러는 1시간에 1번만. 링버퍼가 600건이라 폭주 한 건이
    // 다른 진단을 통째로 밀어내는 것을 막아야 한다.
    const errorKey = `${errorInfo.type}_${errorInfo.message?.substring(0, 50)}`;
    try {
        const lastReported = sessionStorage.getItem(`error_${errorKey}`);
        const now = Date.now();
        if (lastReported && now - parseInt(lastReported) < 3600000) {
            return;
        }
        sessionStorage.setItem(`error_${errorKey}`, now.toString());
    } catch (_) {
        // sessionStorage 를 못 쓰면 중복 억제만 포기하고 계속 진행한다
    }

    import('./utils/diagnostics.js')
        .then(({ diag }) => {
            // detail 은 작게 — 링버퍼와 업로드 문서 크기가 걸려 있다
            diag('js.error', {
                type: errorInfo.type || 'unknown',
                message: String(errorInfo.message || 'Unknown error').substring(0, 300),
                at: errorInfo.filename
                    ? `${errorInfo.filename}:${errorInfo.lineno ?? '?'}:${errorInfo.colno ?? '?'}`
                    : undefined,
                stack: errorInfo.stack ? String(errorInfo.stack).substring(0, 600) : undefined
            });
        })
        .catch(() => {
            /* 계측이 없어도 앱은 돌아야 한다 */
        });
}

/**
 * 커스텀 에러 리포팅 (명시적 호출)
 */
export function reportCustomError(message, error, context = {}) {
    reportError({
        message,
        error,
        stack: error?.stack,
        type: 'custom_error',
        context,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
    });
}

/**
 * API 에러 리포팅
 */
export function reportApiError(apiName, error, requestData = {}) {
    reportError({
        message: `API Error: ${apiName}`,
        error,
        stack: error?.stack,
        type: 'api_error',
        apiName,
        requestData,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
    });
}

// 전역으로 노출 (기존 코드 호환성)
window.reportError = reportError;
window.reportCustomError = reportCustomError;
window.reportApiError = reportApiError;
