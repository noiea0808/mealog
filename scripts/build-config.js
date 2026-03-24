const fs = require('fs');
const path = require('path');

function escapeJsSingleQuotedString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const geminiKey = process.env.GEMINI_API_KEY || '';
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID || '';
/** 운영 앱(Capacitor server.url → mealog.net)은 배포된 config.js만 씀. 비어 있으면 둘러보기(데모 로그인) 불가 */
const demoAccountEmail = process.env.DEMO_ACCOUNT_EMAIL || 'dummy@mealog.net';
const demoAccountPassword = process.env.DEMO_ACCOUNT_PASSWORD || '';
const outPath = path.join(__dirname, '..', 'js', 'config.js');

const content = `// API 설정 - 빌드 시 환경 변수에서 주입 (Vercel 등)
export const GEMINI_API_KEY = '${escapeJsSingleQuotedString(geminiKey)}';
export const GOOGLE_WEB_CLIENT_ID = '${escapeJsSingleQuotedString(googleWebClientId)}';
export const DEMO_ACCOUNT_EMAIL = '${escapeJsSingleQuotedString(demoAccountEmail)}';
export const DEMO_ACCOUNT_PASSWORD = '${escapeJsSingleQuotedString(demoAccountPassword)}';
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content);
console.log('✅ js/config.js created (GEMINI_API_KEY, GOOGLE_WEB_CLIENT_ID, DEMO_ACCOUNT_*)');
