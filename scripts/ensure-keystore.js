#!/usr/bin/env node
/**
 * 프로덕션 Release 서명용 keystore 확인.
 * android/keystore.properties와 keystore 파일이 없으면 생성하고,
 * 환경 변수 KEYSTORE_PASSWORD가 필요합니다.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const androidDir = path.join(root, 'android');
const propsPath = path.join(androidDir, 'keystore.properties');
const keystoreName = 'mealog-release.keystore';
const keystorePath = path.join(androidDir, keystoreName);

function getStoreFileFromProps() {
  if (!fs.existsSync(propsPath)) return null;
  const content = fs.readFileSync(propsPath, 'utf8');
  const m = content.match(/^\s*storeFile\s*=\s*(.+)\s*$/m);
  if (!m) return null;
  const value = m[1].trim();
  const resolved = path.isAbsolute(value) ? value : path.join(androidDir, value.replace(/^\.\.\//, ''));
  return resolved;
}

// keystore.properties가 있고, 그 안의 storeFile 경로에 파일이 있으면 완료
const existingKeystore = getStoreFileFromProps();
if (existingKeystore && fs.existsSync(existingKeystore)) {
  process.exit(0);
}

// 없으면 생성 (KEYSTORE_PASSWORD 필요)
const password = process.env.KEYSTORE_PASSWORD;
if (!password || password.length < 6) {
  console.error('');
  console.error('❌ Release 서명용 Keystore가 없습니다.');
  console.error('   서명된(바로 설치 가능한) 릴리즈를 만들려면 한 번만 아래 중 하나를 하세요.');
  console.error('');
  console.error('   [방법 1] 환경 변수로 비밀번호 지정 후 빌드 (최초 1회에 keystore 자동 생성)');
  console.error('     set KEYSTORE_PASSWORD=영문숫자비밀번호6자이상');
  console.error('     npm run cap:build:production:release');
  console.error('');
  console.error('   [방법 2] 수동 생성 후 keystore.properties 작성');
  console.error('     docs/production-release-checklist.md 의 "2. Keystore" 절차 참고');
  console.error('');
  process.exit(1);
}

console.log('✓ Keystore 없음 → 생성 중 (android/' + keystoreName + ')');

const dname = 'CN=MEALOG, OU=App, O=MEALOG, L=Seoul, ST=Seoul, C=KR';
const keytoolArgs = [
  '-genkeypair', '-v',
  '-keystore', keystoreName,
  '-alias', 'mealog',
  '-keyalg', 'RSA',
  '-keysize', '2048',
  '-validity', '10000',
  '-storepass', password,
  '-keypass', password,
  '-dname', dname,
];

const keytool = process.platform === 'win32' ? 'keytool.exe' : 'keytool';
const result = spawnSync(keytool, keytoolArgs, { cwd: androidDir, stdio: 'inherit', shell: false });
if (result.status !== 0) {
  console.error('keytool 실행 실패. keytool이 PATH에 있는지 확인하세요 (JDK 설치 필요).');
  process.exit(1);
}
if (!fs.existsSync(keystorePath)) {
  console.error('Keystore 파일이 생성되지 않았습니다. keytool 오류를 확인하세요.');
  process.exit(1);
}

// Gradle :app은 android/app/ 기준이므로 상위(android/)의 keystore를 가리킴
const propsContent = [
  '# Release 서명 (자동 생성됨, Git 제외)',
  'storeFile=../' + keystoreName,
  'storePassword=' + password,
  'keyAlias=mealog',
  'keyPassword=' + password,
].join('\n');

fs.writeFileSync(propsPath, propsContent, 'utf8');
console.log('✓ android/keystore.properties 생성 완료');
console.log('  → 이제 서명된 릴리즈가 빌드됩니다. Keystore 파일은 안전하게 백업하세요.');
