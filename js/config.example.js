// 설정 파일 예제
// 이 파일을 복사하여 config.js로 만들고 실제 API 키를 입력하세요
// config.js는 .gitignore에 추가되어 Git에 커밋되지 않습니다

export const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE';

// 네이티브 구글 로그인용 (Firebase Console > Authentication > Sign-in method > Google > Web SDK configuration > Web client ID)
export const GOOGLE_WEB_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';

// 샘플 타임라인용 데모 계정 (Firebase Auth 이메일/비밀번호). firestore.rules의 읽기 전용 이메일과 일치시키세요.
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
export const DEMO_ACCOUNT_PASSWORD = 'YOUR_DEMO_PASSWORD';