/**
 * 웹 에셋을 www 폴더로 복사 (Capacitor 빌드용)
 */
const fs = require('fs');
const path = require('path');
const { checkDeployConfig } = require('./verify-deploy-config.js');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

/**
 * APK 에 실릴 js/config.js 안전 검사 — hosting predeploy 와 같은 검사를 앱 빌드에도 건다.
 *
 * 왜 여기인가: 아래 toCopy 가 js/ 를 통째로 복사하므로 로컬 js/config.js 가 그대로 APK 안에
 * 들어간다. 그런데 검사는 firebase.json 의 hosting predeploy 에만 걸려 있었다. 정작 실제
 * 배포 경로(플레이스토어)에는 아무 검사가 없어서, 디버그 토큰이 실린 채 스토어에 올라갈 수
 * 있었다. 웹과 달리 앱은 되돌리려면 재심사를 받아야 한다.
 *
 * 복사를 시작하기 전에 멈춘다 — 반쯤 만들어진 www 를 남기지 않기 위해.
 *
 * 스테이징(appId ...*.staging)은 본인 기기 테스트용이라 경고만 하고 진행한다.
 * 운영 빌드에서만 중단한다.
 */
function verifyConfigForAppBuild() {
    let appId = '';
    try {
        appId = String(JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8')).appId || '');
    } catch (_) {
        /* 못 읽으면 판단 불가 — 엄격한 쪽(운영)으로 본다 */
    }
    const isStaging = appId.endsWith('.staging');
    const { errors } = checkDeployConfig(undefined, {
        allowEmptyDemoPassword: process.env.ALLOW_EMPTY_DEMO_PASSWORD === '1'
    });
    if (errors.length === 0) return;

    const head = `js/config.js 가 앱에 그대로 실립니다 (appId: ${appId || '알 수 없음'})`;
    if (isStaging) {
        console.warn(`\n⚠️  ${head}`);
        errors.forEach((e, i) => console.warn(` ${i + 1}. ${e}`));
        console.warn('   스테이징 빌드라 계속 진행합니다. 운영 빌드에서는 중단됩니다.\n');
        return;
    }
    console.error(`\n❌ 빌드 중단 — ${head}\n`);
    errors.forEach((e, i) => console.error(` ${i + 1}. ${e}\n`));
    console.error('   (이 검사는 scripts/copy-to-www.js 에 걸려 있습니다. hosting 배포와 같은 검사입니다.)\n');
    process.exit(1);
}

verifyConfigForAppBuild();

const toCopy = [
  'index.html',
  'kakao-app-oauth-bridge.html',
  'privacy.html',
  'manifest.json',
  'favicon.ico',
  'sw.js',
  'version.json',
  'css',
  'js',
  'assets',
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursive(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

if (fs.existsSync(www)) {
  fs.rmSync(www, { recursive: true });
}
fs.mkdirSync(www, { recursive: true });

for (const item of toCopy) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) {
    copyRecursive(src, path.join(www, item));
    console.log('✓', item);
  }
}

// config.js가 없으면 config.default.js를 config.js로 복사
const configSrc = path.join(root, 'js', 'config.js');
const configDest = path.join(www, 'js', 'config.js');
if (!fs.existsSync(configSrc) && fs.existsSync(path.join(root, 'js', 'config.default.js'))) {
  fs.copyFileSync(path.join(root, 'js', 'config.default.js'), configDest);
  console.log('✓ js/config.js (from config.default.js)');
}

// Capacitor core + 플러그인 (앱에서 npm 모듈 해석 불가 → 스크립트로 로드)
// 로컬에서 루트(index.html → js/…)로 서빙할 때도 동작하도록 www와 프로젝트 루트 js/ 둘 다에 복사
const jsRoot = path.join(root, 'js');
function copyCapacitorAsset(src, destFileName) {
  if (!fs.existsSync(src)) return false;
  const name = path.basename(destFileName);
  fs.mkdirSync(path.join(www, 'js'), { recursive: true });
  fs.mkdirSync(jsRoot, { recursive: true });
  fs.copyFileSync(src, path.join(www, 'js', name));
  fs.copyFileSync(src, path.join(jsRoot, name));
  console.log('✓ js/' + name + ' (www + root)');
  return true;
}

const capacitorCore = path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
const socialLoginPlugin = path.join(root, 'node_modules', '@capgo', 'capacitor-social-login', 'dist', 'plugin.js');
const splashScreenPlugin = path.join(root, 'node_modules', '@capacitor', 'splash-screen', 'dist', 'plugin.js');
const sharePlugin = path.join(root, 'node_modules', '@capacitor', 'share', 'dist', 'plugin.js');
const filesystemPlugin = path.join(root, 'node_modules', '@capacitor', 'filesystem', 'dist', 'plugin.js');
const appPlugin = path.join(root, 'node_modules', '@capacitor', 'app', 'dist', 'plugin.js');
const browserPlugin = path.join(root, 'node_modules', '@capacitor', 'browser', 'dist', 'plugin.js');
const pushNotificationsPlugin = path.join(root, 'node_modules', '@capacitor', 'push-notifications', 'dist', 'plugin.js');
const hapticsPlugin = path.join(root, 'node_modules', '@capacitor', 'haptics', 'dist', 'plugin.js');
copyCapacitorAsset(capacitorCore, 'capacitor.js');
copyCapacitorAsset(socialLoginPlugin, 'capacitor-social-login-plugin.js');
copyCapacitorAsset(splashScreenPlugin, 'capacitor-splash-screen-plugin.js');
copyCapacitorAsset(sharePlugin, 'capacitor-share-plugin.js');
copyCapacitorAsset(filesystemPlugin, 'capacitor-filesystem-plugin.js');
copyCapacitorAsset(appPlugin, 'capacitor-app-plugin.js');
copyCapacitorAsset(browserPlugin, 'capacitor-browser-plugin.js');
copyCapacitorAsset(pushNotificationsPlugin, 'capacitor-push-notifications-plugin.js');
copyCapacitorAsset(hapticsPlugin, 'capacitor-haptics-plugin.js');
const badgePlugin = path.join(root, 'node_modules', '@capawesome', 'capacitor-badge', 'dist', 'plugin.js');
copyCapacitorAsset(badgePlugin, 'capacitor-badge-plugin.js');
const appUpdatePlugin = path.join(root, 'node_modules', '@capawesome', 'capacitor-app-update', 'dist', 'plugin.js');
copyCapacitorAsset(appUpdatePlugin, 'capacitor-app-update-plugin.js');
const networkPlugin = path.join(root, 'node_modules', '@capacitor', 'network', 'dist', 'plugin.js');
copyCapacitorAsset(networkPlugin, 'capacitor-network-plugin.js');

// capacitor.config.json에서 appId 읽어 www/js/env.js 의 APP_ENV 만 맞춤 (배지 등 나머지는 루트 env.js 유지)
const capConfigPath = path.join(root, 'capacitor.config.json');
const wwwEnvPath = path.join(www, 'js', 'env.js');
const rootEnvPath = path.join(root, 'js', 'env.js');
if (fs.existsSync(wwwEnvPath) && fs.existsSync(capConfigPath)) {
  const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf8'));
  const isStaging = (capConfig.appId || '').includes('staging');
  const appEnvVal = isStaging ? 'staging' : 'production';
  let envBody = fs.readFileSync(wwwEnvPath, 'utf8');
  envBody = envBody.replace(/window\.APP_ENV\s*=\s*['"][^'"]*['"]\s*;/, `window.APP_ENV = ${JSON.stringify(appEnvVal)};`);
  const banner = '// www 빌드: APP_ENV는 capacitor.config.json appId 기준으로 갱신됨 (scripts/copy-to-www.js)\n';
  fs.writeFileSync(wwwEnvPath, banner + envBody);
  console.log('✓ js/env.js (APP_ENV=' + appEnvVal + ', 배지 로직 유지)');
} else if (fs.existsSync(rootEnvPath) && fs.existsSync(wwwEnvPath)) {
  let envBody = fs.readFileSync(rootEnvPath, 'utf8');
  fs.writeFileSync(wwwEnvPath, envBody);
  console.log('✓ js/env.js (루트와 동기, capacitor.config 없음)');
}

console.log('✅ www 폴더 준비 완료');
