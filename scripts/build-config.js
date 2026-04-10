const fs = require('fs');
const path = require('path');

function escapeJsSingleQuotedString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 빌드용 환경 변수 로드 (이미 설정된 process.env 는 덮어쓰지 않음)
 * 순서: .env.local → 루트 .env → functions/.env (기존 Functions용 파일에 JS 키만 추가해도 됨)
 */
function loadEnvFilesForBuild() {
  const root = path.join(__dirname, '..');
  const paths = [
    path.join(root, '.env.local'),
    path.join(root, '.env'),
    path.join(root, 'functions', '.env')
  ];
  for (const envPath of paths) {
    if (!fs.existsSync(envPath)) continue;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  }
}

loadEnvFilesForBuild();

/** mealog-r0 / google-services.json oauth client (client_type 3). 환경변수 미설정 시 네이티브 구글 로그인용 기본값 */
const DEFAULT_GOOGLE_WEB_CLIENT_ID =
  '535597498508-pi88b4aofmljpnrbrnstplsmj83clrnq.apps.googleusercontent.com';
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID || DEFAULT_GOOGLE_WEB_CLIENT_ID;
/** 운영 앱(Capacitor server.url → mealog.net)은 배포된 config.js만 씀. 비어 있으면 둘러보기(데모 로그인) 불가 */
const demoAccountEmail = process.env.DEMO_ACCOUNT_EMAIL || 'dummy@mealog.net';
const demoAccountPassword = process.env.DEMO_ACCOUNT_PASSWORD || '';
/** 웹(localhost·브라우저) 카카오 로그인용 JavaScript 키. 네이티브 앱 카카오(Browser+브리지)는 미사용 */
const kakaoJavascriptKey = process.env.KAKAO_JAVASCRIPT_KEY || '';
const outPath = path.join(__dirname, '..', 'js', 'config.js');

/**
 * 로컬 App Check 디버그 토큰 — 빌드가 config.js 전체를 덮어쓰므로 여기서 반드시 다시 넣어야 함.
 * 우선순위: APPCHECK_DEBUG_TOKEN 환경 변수 → 기존 js/config.js 에 있던 값(수동 편집 보존)
 */
function readExistingAppCheckDebugToken() {
  try {
    if (!fs.existsSync(outPath)) return '';
    const text = fs.readFileSync(outPath, 'utf8');
    const m = text.match(/export const APPCHECK_DEBUG_TOKEN\s*=\s*['"]([^'"]*)['"]/);
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}
const appcheckDebugToken =
  (process.env.APPCHECK_DEBUG_TOKEN && String(process.env.APPCHECK_DEBUG_TOKEN).trim()) ||
  readExistingAppCheckDebugToken() ||
  '';

// Gemini는 클라이언트에 노출하지 않음 → Firebase Functions callGemini + GEMINI_API_KEY(Functions 환경 변수)
const content = `// API 설정 - 빌드 시 환경 변수에서 주입 (Vercel 등)
export const GOOGLE_WEB_CLIENT_ID = '${escapeJsSingleQuotedString(googleWebClientId)}';
export const DEMO_ACCOUNT_EMAIL = '${escapeJsSingleQuotedString(demoAccountEmail)}';
export const DEMO_ACCOUNT_PASSWORD = '${escapeJsSingleQuotedString(demoAccountPassword)}';
export const KAKAO_JAVASCRIPT_KEY = '${escapeJsSingleQuotedString(kakaoJavascriptKey)}';
export const APPCHECK_DEBUG_TOKEN = '${escapeJsSingleQuotedString(appcheckDebugToken)}';
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, content);
console.log(
  '✅ js/config.js created (GOOGLE_WEB_CLIENT_ID, DEMO_ACCOUNT_*, KAKAO_JAVASCRIPT_KEY, APPCHECK_DEBUG_TOKEN)'
);
if (!kakaoJavascriptKey) {
  console.log(
    'ℹ️  KAKAO_JAVASCRIPT_KEY 비어 있음 → 웹 카카오 로그인용. 로컬: 루트 .env / functions/.env 에 추가 후 npm run build. Vercel: Environment Variables'
  );
}
