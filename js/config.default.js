// 이 파일은 항상 Git에 커밋되며, config.js가 없을 때 사용됩니다.
// Gemini API 키는 클라이언트에 두지 않습니다. Firebase Functions `callGemini` + Functions 환경 변수 GEMINI_API_KEY.

/**
 * 로컬(localhost)에서만 사용. Firebase Console → App Check → 웹 앱 → 디버그 토큰 관리에 **동일한 UUID 문자열**을 등록하면
 * exchangeDebugToken 403·Firestore permission-denied가 사라집니다. 비우면 매 새로고침마다 새 토큰이 콘솔에 찍혀 등록이 번거롭습니다.
 * config.js(비커밋)에 복사해 쓰는 것을 권장.
 */
export const APPCHECK_DEBUG_TOKEN = '';

// 네이티브 구글 로그인용 Web Client ID (Firebase Console > Authentication > Google > Web SDK)
// android/app/google-services.json 의 oauth_client 중 client_type 3 과 동일해야 함 (공개 식별자).
export const GOOGLE_WEB_CLIENT_ID =
    '535597498508-pi88b4aofmljpnrbrnstplsmj83clrnq.apps.googleusercontent.com';

/** 카카오 로그인 — Kakao Developers > 앱 > 앱 키 > JavaScript 키 (config.js에 두는 것을 권장) */
export const KAKAO_JAVASCRIPT_KEY = '';

/**
 * 카카오 OAuth redirect_uri를 주소창과 다르게 고정할 때만 설정 (비우면 현재 URL 기준 자동)
 * 예: 콘솔에 `http://localhost:8000/` 만 등록했는데 `index.html`로 열고 있으면 여기에 `http://localhost:8000/` 입력
 */
export const KAKAO_OAUTH_REDIRECT_URI = '';

/** 공용 데모(샘플) 계정 — Firestore 규칙의 읽기 전용 이메일과 동일해야 함 */
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
/** config.js에만 실제 비밀번호 설정 (Git 커밋 금지). 비어 있으면 자동 데모 로그인·둘러보기 비활성 */
export const DEMO_ACCOUNT_PASSWORD = '';