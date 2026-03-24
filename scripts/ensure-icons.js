#!/usr/bin/env node
/**
 * assets/icon-only.png 또는 icon-only.jpg가 있으면 아이콘 생성 실행.
 * Android 8(API 26) 이상은 mipmap-anydpi-v26(어댑티브 아이콘)을 우선 사용하는데,
 * @capacitor/assets 는 icon-only로 legacy mipmap PNG만 생성하므로, anydpi-v26을 제거해
 * 생성한 PNG가 런처에 쓰이도록 한다.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const iconPng = path.join(assetsDir, 'icon-only.png');
const iconJpg = path.join(assetsDir, 'icon-only.jpg');
const anydpiDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'mipmap-anydpi-v26');

function rmDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) rmDirRecursive(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

if (fs.existsSync(iconPng) || fs.existsSync(iconJpg)) {
  console.log('✓ 앱 아이콘 소스 발견 → 아이콘 생성 실행');
  try {
    // 패키지명은 @capacitor/assets (npx capacitor-assets 는 npm에 없어 404)
    execSync('npx @capacitor/assets generate --android', { stdio: 'inherit', cwd: root });
    if (fs.existsSync(anydpiDir)) {
      rmDirRecursive(anydpiDir);
      console.log('✓ mipmap-anydpi-v26 제거 → 생성한 아이콘 PNG 사용');
    }
    console.log('✅ 앱 아이콘 생성 완료');
  } catch (e) {
    console.warn('⚠ 아이콘 생성 실패 (빌드는 계속 진행됩니다):', e.message || e);
  }
}
