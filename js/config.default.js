// 이 파일은 항상 Git에 커밋되며, config.js가 없을 때 사용됩니다.
// Gemini API 키는 클라이언트에 두지 않습니다. Firebase Functions `callGemini` + Functions 환경 변수 GEMINI_API_KEY.

// 네이티브 구글 로그인용 Web Client ID (Firebase Console > Authentication > Sign-in method > Google > Web SDK configuration)
// config.js에 GOOGLE_WEB_CLIENT_ID로 설정하거나, 여기 placeholder 사용 시 앱에서 구글 로그인 설정이 필요합니다.
export const GOOGLE_WEB_CLIENT_ID = '';

/** 공용 데모(샘플) 계정 — Firestore 규칙의 읽기 전용 이메일과 동일해야 함 */
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
/** config.js에만 실제 비밀번호 설정 (Git 커밋 금지). 비어 있으면 자동 데모 로그인·둘러보기 비활성 */
export const DEMO_ACCOUNT_PASSWORD = '';