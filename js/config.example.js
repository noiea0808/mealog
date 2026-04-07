// 설정 파일 예제
// 이 파일을 복사하여 config.js로 만들고 값을 입력하세요
// config.js는 .gitignore에 추가되어 Git에 커밋되지 않습니다
//
// 밀당 AI(Gemini)는 브라우저에 키를 두지 않습니다. functions/.env 또는 Firebase에 GEMINI_API_KEY 설정 후 callGemini 사용.

// 네이티브 구글 로그인용 (Firebase Console > Authentication > Sign-in method > Google > Web SDK configuration > Web client ID)
export const GOOGLE_WEB_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';

// 카카오 로그인 — 반드시 「JavaScript 키」(REST 키 아님)
export const KAKAO_JAVASCRIPT_KEY = 'YOUR_KAKAO_JAVASCRIPT_KEY';
// authorize 400(KOE006 등): 플랫폼 키 > JavaScript 키 에서
//   (1) Redirect URI에 아래에서 쓰는 주소와 완전 동일하게 등록
//   (2) JavaScript SDK 도메인에 origin 만 등록 (예: http://localhost:8000 , https://www.mealog.net)
// Functions: KAKAO_REST_API_KEY(토큰 교환). 클라이언트 시크릿 사용 시 functions/.env KAKAO_CLIENT_SECRET
// index.html로 여는데 콘솔에는 `http://localhost:8000/` 만 있으면 여기로 맞추거나 콘솔에 index.html 경로를 추가
export const KAKAO_OAUTH_REDIRECT_URI = ''; // 예: 'http://localhost:8000/'
// 앱(APK) 카카오 로그인: 사이트 루트에 kakao-app-oauth-bridge.html 배포 후, 여기에 그 전체 URL을 넣거나 기본값 유지
export const KAKAO_APP_OAUTH_BRIDGE_URL = 'https://www.mealog.net/kakao-app-oauth-bridge.html';

// 샘플 타임라인용 데모 계정 (Firebase Auth 이메일/비밀번호). firestore.rules의 읽기 전용 이메일과 일치시키세요.
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
export const DEMO_ACCOUNT_PASSWORD = 'YOUR_DEMO_PASSWORD';