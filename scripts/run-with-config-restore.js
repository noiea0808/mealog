/**
 * capacitor.config.json은 select-cap-config.js가 빌드 대상(production/staging)에 맞춰
 * 덮어쓴다. production 빌드 스크립트는 이 파일을 그대로 두고 끝나서, 다음에 git status를
 * 보면 저장소 baseline(staging.bundled)과 달라진 채 남아 있었다.
 *
 * 이 래퍼는 전달받은 명령을 실행하고, 성공/실패와 무관하게 마지막에 항상
 * capacitor.config.json을 staging.bundled로 되돌린다.
 *
 * 사용: node scripts/run-with-config-restore.js "<실행할 명령 전체>"
 */
const { execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const cmd = process.argv.slice(2).join(' ');

if (!cmd) {
  console.error('Usage: node run-with-config-restore.js "<command>"');
  process.exit(1);
}

let exitCode = 0;
try {
  execSync(cmd, { stdio: 'inherit', cwd: root, env: process.env });
} catch (err) {
  exitCode = err.status != null ? err.status : 1;
} finally {
  try {
    execSync('node scripts/select-cap-config.js staging.bundled', {
      stdio: 'inherit',
      cwd: root,
      env: process.env
    });
  } catch (e) {
    console.warn('⚠ capacitor.config.json 복원 실패 — 수동으로 확인하세요:', e?.message || e);
  }
}

process.exit(exitCode);
