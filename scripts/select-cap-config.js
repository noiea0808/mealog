/**
 * 스테이징/프로덕션에 맞는 capacitor.config.json 선택
 * 사용: node scripts/select-cap-config.js [staging|production|staging.bundled|production.bundled]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const env = (process.argv[2] || 'staging').toLowerCase();
const valid = ['staging', 'production', 'staging.bundled', 'production.bundled'];
if (!valid.includes(env)) {
  console.error(
    'Usage: node select-cap-config.js [staging|production|staging.bundled|production.bundled]'
  );
  process.exit(1);
}
const srcFile = path.join(root, 'config', `capacitor.config.${env}.json`);
const destFile = path.join(root, 'capacitor.config.json');
if (!fs.existsSync(srcFile)) {
  console.error(`❌ ${srcFile} not found`);
  process.exit(1);
}
fs.copyFileSync(srcFile, destFile);
const urlLabel =
  env === 'staging'
    ? 'staging-mealog.vercel.app'
    : env === 'staging.bundled' || env === 'production.bundled'
      ? 'www번들'
      : 'mealog.net';
console.log(`✓ capacitor.config.json → ${env} (${urlLabel})`);
