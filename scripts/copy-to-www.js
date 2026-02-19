/**
 * 웹 에셋을 www 폴더로 복사 (Capacitor 빌드용)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const www = path.join(root, 'www');

const toCopy = [
  'index.html',
  'manifest.json',
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

// Capacitor core + SocialLogin 플러그인 (앱에서 npm 모듈 해석 불가 → 스크립트로 로드)
const capacitorCore = path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
const socialLoginPlugin = path.join(root, 'node_modules', '@capgo', 'capacitor-social-login', 'dist', 'plugin.js');
if (fs.existsSync(capacitorCore)) {
  fs.copyFileSync(capacitorCore, path.join(www, 'js', 'capacitor.js'));
  console.log('✓ js/capacitor.js');
}
if (fs.existsSync(socialLoginPlugin)) {
  fs.copyFileSync(socialLoginPlugin, path.join(www, 'js', 'capacitor-social-login-plugin.js'));
  console.log('✓ js/capacitor-social-login-plugin.js');
}

// capacitor.config.json에서 appId 읽어 env.js 생성 (스테이징 여부 판별)
const capConfigPath = path.join(root, 'capacitor.config.json');
if (fs.existsSync(capConfigPath)) {
  const capConfig = JSON.parse(fs.readFileSync(capConfigPath, 'utf8'));
  const isStaging = (capConfig.appId || '').includes('staging');
  const envContent = `// 빌드 시 자동 생성 (capacitor.config.json appId 기준)
window.APP_ENV = ${JSON.stringify(isStaging ? 'staging' : 'production')};
`;
  fs.writeFileSync(path.join(www, 'js', 'env.js'), envContent);
  console.log('✓ js/env.js (APP_ENV=' + (isStaging ? 'staging' : 'production') + ')');
}

console.log('✅ www 폴더 준비 완료');
