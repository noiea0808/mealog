/**
 * assets/analysis-icons/*.png → js/analytics/analysis-icon-assets.js (data URI)
 * 실행: node scripts/embed-analysis-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, '..', 'assets', 'analysis-icons');
const outFile = path.join(__dirname, '..', 'js', 'analytics', 'analysis-icon-assets.js');

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_') && !f.includes('colored'));
const map = {};
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f));
  const key = f.replace(/\.png$/i, '');
  map[key] = `data:image/png;base64,${buf.toString('base64')}`;
}

const body = `/** Auto-generated from assets/analysis-icons/*.png — do not edit by hand.
 * Source cyan: assets/analysis-icons-colored.png
 * Crop: python3 scripts/crop-analysis-icons-from-cyan.py
 * Embed: node scripts/embed-analysis-icons.mjs
 */
export const ANALYSIS_ICON_ASSETS = ${JSON.stringify(map, null, 2)};
`;

fs.writeFileSync(outFile, body, 'utf8');
const kb = Math.round(Buffer.byteLength(body) / 1024);
console.log(`Embedded ${files.length} PNGs → ${path.relative(path.join(__dirname, '..'), outFile)} (${kb} KB)`);
