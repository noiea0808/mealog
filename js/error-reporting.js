// 에러 리포팅 시스템
// Firebase Performance Monitoring과 커스텀 에러 리포팅 통합

let errorReportingInitialized = false;
let errorQueue = [];
const MAX_QUEUE_SIZE = 50;

/**
 * 에러 리포팅 초기화
 */
export async function initErrorReporting() {
    if (errorReportingInitialized) {
        return;
    }

    try {
        // 로컬 개발 환경에서는 에러 리포팅 비활성화
        const isLocalhost = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' || 
                           window.location.hostname === '0.0.0.0' ||
                           window.location.hostname === '';
        
        if (isLocalhost) {
            console.log('🔧 로컬 개발 환경: 에러 리포팅 비활성화');
            errorReportingInitialized = true;
            return;
        }

        // Firebase Performance Monitoring 초기화
        try {
            const { getPerformance } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-performance.js");
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

/**
 * 에러 리포팅
 */
export function reportError(errorInfo) {
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
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.error('📊 에러 리포팅:', enhancedError);
        }

        // Firebase Firestore에 에러 로그 저장 (선택적)
        // 주의: 너무 많은 에러가 발생하면 Firestore 비용이 증가할 수 있음
        // 프로덕션에서는 외부 서비스(Sentry 등) 사용 권장
        logErrorToFirestore(enhancedError).catch(e => {
            console.warn('에러 로그 저장 실패:', e);
        });

        // 향후 Sentry나 다른 서비스로 전송 가능하도록 구조화
        // sendToSentry(enhancedError);
    } catch (e) {
        console.error('에러 리포팅 실패:', e);
    }
}

/**
 * Firestore에 에러 로그 저장 (선택적, 비용 고려)
 */
async function logErrorToFirestore(errorInfo) {
    // 프로덕션에서는 주석 처리하거나, 샘플링하여 저장
    // 예: 10%만 저장하거나, 특정 에러 타입만 저장
    
    // 중복 에러 방지: 같은 에러는 1시간에 1번만 저장
    const errorKey = `${errorInfo.type}_${errorInfo.message?.substring(0, 50)}`;
    const lastReported = sessionStorage.getItem(`error_${errorKey}`);
    const now = Date.now();
    
    if (lastReported && (now - parseInt(lastReported)) < 3600000) {
        return; // 1시간 이내에 같은 에러는 무시
    }
    
    sessionStorage.setItem(`error_${errorKey}`, now.toString());

    try {
        const { db, appId } = await import('./firebase.js');
        const { collection, addDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        
        // 에러 로그 컬렉션 (관리자만 읽을 수 있도록 Rules 설정 필요)
        const errorLogsColl = collection(db, 'artifacts', appId, 'errorLogs');
        
        // 민감 정보 제거
        const sanitizedError = {
            message: errorInfo.message?.substring(0, 500) || 'Unknown error',
            type: errorInfo.type || 'unknown',
            filename: errorInfo.filename || null,
            lineno: errorInfo.lineno || null,
            colno: errorInfo.colno || null,
            stack: errorInfo.stack?.substring(0, 2000) || null,
            url: errorInfo.url || window.location.href,
            userAgent: errorInfo.userAgent || navigator.userAgent,
            userId: errorInfo.userId || 'anonymous',
            isAnonymous: errorInfo.isAnonymous || false,
            timestamp: errorInfo.timestamp || new Date().toISOString()
        };

        await addDoc(errorLogsColl, sanitizedError);
    } catch (e) {
        // Firestore 저장 실패는 무시 (에러 리포팅 자체가 실패하면 안 됨)
        console.warn('에러 로그 Firestore 저장 실패:', e);
    }
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
