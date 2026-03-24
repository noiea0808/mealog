/**
 * 배포용 js/config.js에 클라이언트 Gemini/API 키가 들어가지 않았는지 검사
 * 사용: npm run build 의 두 번째 단계
 */
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'js', 'config.js');
if (!fs.existsSync(p)) {
  console.error('verify-client-config: js/config.js 가 없습니다. build-config.js를 먼저 실행하세요.');
  process.exit(1);
}
const t = fs.readFileSync(p, 'utf8');
if (/export\s+const\s+GEMINI_API_KEY\s*=/m.test(t)) {
  console.error('verify-client-config: config.js에 GEMINI_API_KEY export 가 있으면 안 됩니다. scripts/build-config.js를 확인하세요.');
  process.exit(1);
}
// Google 브라우저 API 키(AIzaSy…)는 클라이언트에 두지 않음 (Functions·서버 전용)
if (/\bAIzaSy[A-Za-z0-9_-]{10,}\b/.test(t)) {
  console.error('verify-client-config: config.js에 AIzaSy… 형태의 API 키가 포함돼 있습니다.');
  process.exit(1);
}
console.log('✅ verify-client-config: 클라이언트 config.js 검사 통과');
