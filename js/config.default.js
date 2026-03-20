// 기본 API 키 (fallback)
// 이 파일은 항상 Git에 커밋되며, config.js가 없을 때 사용됩니다.
// ⚠️ 실제 API 키는 여기에 넣지 마세요! config.js에 넣으세요.
export const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE';

// 네이티브 구글 로그인용 Web Client ID (Firebase Console > Authentication > Sign-in method > Google > Web SDK configuration)
// config.js에 GOOGLE_WEB_CLIENT_ID로 설정하거나, 여기 placeholder 사용 시 앱에서 구글 로그인 설정이 필요합니다.
export const GOOGLE_WEB_CLIENT_ID = '';

/** 공용 데모(샘플) 계정 — Firestore 규칙의 읽기 전용 이메일과 동일해야 함 */
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
/** config.js에만 실제 비밀번호 설정 (Git 커밋 금지). 비어 있으면 자동 데모 로그인·둘러보기 비활성 */
export const DEMO_ACCOUNT_PASSWORD = '';