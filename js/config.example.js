// 설정 파일 예제
// 이 파일을 복사하여 config.js로 만들고 값을 입력하세요
// config.js는 .gitignore에 추가되어 Git에 커밋되지 않습니다
//
// 밀당 AI(Gemini)는 브라우저에 키를 두지 않습니다. functions/.env 또는 Firebase에 GEMINI_API_KEY 설정 후 callGemini 사용.

// 네이티브 구글 로그인용 (Firebase Console > Authentication > Sign-in method > Google > Web SDK configuration > Web client ID)
export const GOOGLE_WEB_CLIENT_ID = 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com';

// 로컬 웹(localhost 등) App Check 디버그 — firestore.rules 가 아니라 App Check 콘솔(웹 앱 mealog → 디버그 토큰)에 동일 문자열 등록.
// npm run build 시 scripts/build-config.js 가 덮어쓰므로, 루트 .env / functions/.env 에 APPCHECK_DEBUG_TOKEN=... 두는 편이 안전.
export const APPCHECK_DEBUG_TOKEN = '';

// 카카오 로그인 — 반드시 「JavaScript 키」(REST 키 아님). 웹 전용; 네이티브 앱 카카오는 미사용
// 로컬: 루트 .env 또는 functions/.env 에 KAKAO_JAVASCRIPT_KEY=... 후 npm run build → js/config.js 생성
export const KAKAO_JAVASCRIPT_KEY = 'YOUR_KAKAO_JAVASCRIPT_KEY';
// authorize 400(KOE006 등): 플랫폼 키 > JavaScript 키 에서
//   (1) Redirect URI에 아래에서 쓰는 주소와 완전 동일하게 등록
//   (2) JavaScript SDK 도메인에 origin 만 등록 (예: http://localhost:8000 , https://www.mealog.net)
// Functions: KAKAO_REST_API_KEY(토큰 교환). 클라이언트 시크릿 사용 시 functions/.env KAKAO_CLIENT_SECRET
// index.html로 여는데 콘솔에는 `http://localhost:8000/` 만 있으면 여기로 맞추거나 콘솔에 index.html 경로를 추가
export const KAKAO_OAUTH_REDIRECT_URI = ''; // 예: 'http://localhost:8000/'
// 앱 카카오 브리지 URL. 비우면: 운영=www.mealog.net, 스테이징 APK·staging-mealog.vercel.app=자동(staging 브리지)
export const KAKAO_APP_OAUTH_BRIDGE_URL = 'https://www.mealog.net/kakao-app-oauth-bridge.html';

// 샘플 타임라인용 데모 계정 (Firebase Auth 이메일/비밀번호). firestore.rules의 읽기 전용 이메일과 일치시키세요.
export const DEMO_ACCOUNT_EMAIL = 'dummy@mealog.net';
export const DEMO_ACCOUNT_PASSWORD = 'YOUR_DEMO_PASSWORD';