/**
 * assets/analysis-icons/*.png → js/analytics/analysis-icon-assets.js (URL 맵)
 * 실행: node scripts/embed-analysis-icons.mjs
 *
 * data URI 임베드는 쓰지 않음(첫 로드 ~964KB 방지). PNG는 img src로 지연 로드.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'assets', 'analysis-icons');
const outFile = path.join(__dirname, '..', 'js', 'analytics', 'analysis-icon-assets.js');

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_') && !f.includes('colored'))
  .map((f) => f.replace(/\.png$/i, ''))
  .sort();

const keysLit = files.map((k) => `    '${k}'`).join(',\n');

const body = `/**
 * 분석 Top 아이콘 — assets/analysis-icons/*.png URL 맵
 * (이전 data URI 임베드는 ~964KB라 밀당 진입 시 URL로 지연 로드)
 *
 * Auto-generated — do not edit by hand.
 * Source cyan: assets/analysis-icons-colored.png
 * Crop: python3 scripts/crop-analysis-icons-from-cyan.py
 * Embed: node scripts/embed-analysis-icons.mjs
 */
const BASE = 'assets/analysis-icons';

const KEYS = [
${keysLit}
];

/** @type {Record<string, string>} */
export const ANALYSIS_ICON_ASSETS = Object.fromEntries(
    KEYS.map((key) => [key, \`\${BASE}/\${key}.png\`])
);
`;

fs.writeFileSync(outFile, body, 'utf8');
const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
console.log(`URL map ${files.length} icons → ${path.relative(path.join(__dirname, '..'), outFile)} (${kb} KB)`);
