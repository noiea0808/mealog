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
/**
 * CI(Vercel 등)에서 빌드할 때는 그 결과물이 곧 배포본이므로 배포 안전 검사도 같이 건다.
 * 로컬에서는 개발자가 App Check 디버그 토큰을 넣어 두는 게 정상이라 경고만 하고 통과시킨다
 * (여기서 막으면 로컬에서 npm run build 자체를 못 돌린다).
 * Firebase 경로는 npm 빌드를 안 타므로 firebase.json 의 hosting predeploy 가 따로 막는다.
 */
const { checkDeployConfig } = require('./verify-deploy-config');
const isCI = process.env.CI === '1' || process.env.CI === 'true' || !!process.env.VERCEL;
const { errors } = checkDeployConfig(p, {
  allowEmptyDemoPassword: process.env.ALLOW_EMPTY_DEMO_PASSWORD === '1'
});
if (errors.length > 0) {
  const head = isCI ? '❌ 배포 빌드 중단' : '⚠️  로컬 빌드 — 이대로 배포하면 안 됩니다';
  console[isCI ? 'error' : 'warn'](`\n${head}\n`);
  errors.forEach((e, i) => console[isCI ? 'error' : 'warn'](` ${i + 1}. ${e}\n`));
  if (isCI) process.exit(1);
}

console.log('✅ verify-client-config: 클라이언트 config.js 검사 통과');
