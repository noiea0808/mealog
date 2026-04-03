const fs = require('fs');
const path = require('path');

function escapeJsSingleQuotedString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** mealog-r0 / google-services.json oauth client (client_type 3). 환경변수 미설정 시 네이티브 구글 로그인용 기본값 */
const DEFAULT_GOOGLE_WEB_CLIENT_ID =
  '535597498508-pi88b4aofmljpnrbrnstplsmj83clrnq.apps.googleusercontent.com';
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID || DEFAULT_GOOGLE_WEB_CLIENT_ID;
/** 운영 앱(Capacitor server.url → mealog.net)은 배포된 config.js만 씀. 비어 있으면 둘러보기(데모 로그인) 불가 */
const demoAccountEmail = process.env.DEMO_ACCOUNT_EMAIL || 'dummy@mealog.net';
const demoAccountPassword = process.env.DEMO_ACCOUNT_PASSWORD || '';
const outPath = path.join(__dirname, '..', 'js', 'config.js');

// Gemini는 클라이언트에 노출하지 않음 → Firebase Functions callGemini + GEMINI_API_KEY(Functions 환경 변수)
const content = `// API 설정 - 빌드 시 환경 변수에서 주입 (Vercel 등)
export const GOOGLE_WEB_CLIENT_ID = '${escapeJsSingleQuotedString(googleWebClientId)}';
export const DEMO_ACCOUNT_EMAIL = '${escapeJsSingleQuotedString(demoAccountEmail)}';
export const DEMO_ACCOUNT_PASSWORD = '${escapeJsSingleQuotedString(demoAccountPassword)}';
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content);
console.log('✅ js/config.js created (GOOGLE_WEB_CLIENT_ID, DEMO_ACCOUNT_*)');
