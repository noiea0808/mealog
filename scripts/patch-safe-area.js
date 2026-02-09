#!/usr/bin/env node
/**
 * ProGuard 파일명 수정 (proguard-android.txt → proguard-android-optimize.txt)
 * node_modules 내 모든 android/build.gradle에 적용 - 두더지 잡기
 */
const fs = require('fs');
const path = require('path');

const search = 'proguard-android.txt';
const replace = 'proguard-android-optimize.txt';

const nodeModules = path.join(__dirname, '..', 'node_modules');
if (!fs.existsSync(nodeModules)) {
  process.exit(0);
}

let patched = 0;

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.name === 'android' && fs.statSync(full).isDirectory()) {
      const gradle = path.join(full, 'build.gradle');
      if (fs.existsSync(gradle)) {
        let content = fs.readFileSync(gradle, 'utf8');
        if (content.includes(search)) {
          content = content.split(search).join(replace);
          fs.writeFileSync(gradle, content);
          const rel = path.relative(nodeModules, path.dirname(path.dirname(gradle)));
          console.log(`[${rel}] ProGuard 패치 적용`);
          patched++;
        }
      }
    }
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      scanDir(full);
    }
  }
}

scanDir(nodeModules);
if (patched > 0) {
  console.log(`✅ ProGuard 패치 ${patched}개 적용 완료`);
}
