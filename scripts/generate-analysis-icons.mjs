/**
 * 분석 Top 아이콘 SVG — 컬러 칩 + 채색 심볼 (시안 v2)
 * 실행: node scripts/generate-analysis-icons.mjs && node scripts/embed-analysis-icons.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'assets', 'analysis-icons');

/** 라운드 칩 + 선택적 글리프(24×24 좌표계를 12,12로 이동) */
function chip(bg, glyph) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img">
  <rect width="48" height="48" rx="14" fill="${bg}"/>
  <g transform="translate(12 12)">
${glyph}
  </g>
</svg>
`;
}

const S = (color, w = 2) =>
  `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;

function starsChip(n) {
  const gold = '#F5B800';
  const empty = '#E2E8F0';
  const bg = '#FFF6D6';
  const starPath = (cx, cy, r) => {
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const b = a + Math.PI / 5;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      pts.push([cx + r * 0.4 * Math.cos(b), cy + r * 0.4 * Math.sin(b)]);
    }
    return `M${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L')}Z`;
  };
  // 5 stars centered in 48×48
  const gap = 8.2;
  const total = gap * 4;
  const start = (48 - total) / 2;
  const stars = Array.from({ length: 5 }, (_, i) => {
    const cx = start + gap * i;
    const fill = i < n ? gold : empty;
    return `<path fill="${fill}" d="${starPath(cx, 24, 3.6)}"/>`;
  }).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img">
  <rect width="48" height="48" rx="14" fill="${bg}"/>
  ${stars}
</svg>
`;
}

const icons = {
  /* —— 어떻게 —— */
  'how-home': chip(
    '#F8E4DC',
    `<g ${S('#D96B4A', 2.1)}>
      <path d="M3 11L12 3.2 21 11"/>
      <path d="M5.4 10.2V21h13.2V10.2"/>
      <path d="M10 21v-6.2h4V21"/>
    </g>
    <rect x="10.2" y="14.2" width="3.6" height="6.8" rx="0.6" fill="#D96B4A" opacity="0.2"/>`
  ),
  'how-utensils': chip(
    '#D9F3EC',
    `<g ${S('#1F9A88', 2.1)}>
      <path d="M7.2 2.5v7.2c0 1.4 1.1 2.5 2.4 2.5h0c1.3 0 2.4-1.1 2.4-2.5V2.5"/>
      <path d="M9.6 12.2V21.5"/>
      <path d="M16.2 2.5v19"/>
      <path d="M16.2 2.5c2.6 0 4.2 1.9 4.2 4.6S18.8 11.7 16.2 11.7"/>
    </g>`
  ),
  'how-wine': chip(
    '#F0E2F6',
    `<g ${S('#7A2F8F', 2.1)}>
      <path d="M8.2 2.8h7.6l-1 7.6A4.4 4.4 0 0 1 10.6 15h0a4.4 4.4 0 0 1-4.2-4.6L5.4 2.8h2.8"/>
      <path d="M12 15v5.2"/>
      <path d="M8.4 21.2h7.2"/>
    </g>
    <path d="M8.6 8.8c1.1 1.4 2.2 2.1 3.4 2.1s2.3-.7 3.4-2.1" fill="none" stroke="#7A2F8F" stroke-width="1.4" stroke-linecap="round" opacity="0.45"/>`
  ),
  'how-motorcycle': chip(
    '#FFE2CC',
    `<g ${S('#E8893A', 2)}>
      <circle cx="6.8" cy="17.2" r="3.4"/>
      <circle cx="17.6" cy="17.2" r="3.4"/>
      <path d="M10.2 17.2h4.4"/>
      <path d="M10.1 17.2 12.2 10.8h3.4L17.6 17.2"/>
      <path d="M12.2 10.8 10.4 7.4H7.2"/>
      <path d="M15.2 10.8h3.8l1.4-2.4H18"/>
      <path d="M7.2 7.4H5.4"/>
      <circle cx="6.8" cy="17.2" r="1.2" fill="#E8893A" opacity="0.35" stroke="none"/>
      <circle cx="17.6" cy="17.2" r="1.2" fill="#E8893A" opacity="0.35" stroke="none"/>
    </g>`
  ),
  'how-building': chip(
    '#DDEAF4',
    `<g ${S('#3E7399', 2)}>
      <path d="M4 21.2h16"/>
      <path d="M6.2 21.2V6.2L12 2.8l5.8 3.4v15"/>
      <path d="M9 8.8h1.4M13.6 8.8H15"/>
      <path d="M9 12.2h1.4M13.6 12.2H15"/>
      <path d="M9 15.6h1.4M13.6 15.6H15"/>
      <path d="M11 21.2v-3.2h2v3.2"/>
    </g>
    <rect x="9" y="8.2" width="1.4" height="1.2" fill="#3E7399" opacity="0.25" stroke="none"/>
    <rect x="13.6" y="8.2" width="1.4" height="1.2" fill="#3E7399" opacity="0.25" stroke="none"/>
    <rect x="9" y="11.6" width="1.4" height="1.2" fill="#3E7399" opacity="0.25" stroke="none"/>
    <rect x="13.6" y="11.6" width="1.4" height="1.2" fill="#3E7399" opacity="0.25" stroke="none"/>`
  ),
  'how-ellipsis': chip(
    '#EEEAE6',
    `<circle cx="6" cy="12" r="2" fill="#8A837C"/>
    <circle cx="12" cy="12" r="2" fill="#8A837C"/>
    <circle cx="18" cy="12" r="2" fill="#8A837C"/>`
  ),
  'how-skip': chip(
    '#E8EEF4',
    `<g ${S('#8494A8', 2.2)}>
      <path d="M4.5 5.2v13.6L14.2 12z" fill="#8494A8" fill-opacity="0.18"/>
      <path d="M4.5 5.2v13.6L14.2 12z"/>
      <path d="M16.2 5v14"/>
      <path d="M19.2 5v14"/>
    </g>`
  ),

  /* —— 무엇을 —— */
  'what-soup': chip(
    '#F9DEE2',
    `<g ${S('#D93A4A', 2)}>
      <path d="M3.8 11.5h16.4"/>
      <path d="M5 11.5a7 7 0 0 0 14 0"/>
      <path d="M4.2 11.5v1.2A2.6 2.6 0 0 0 6.8 15.3h10.4a2.6 2.6 0 0 0 2.6-2.6v-1.2"/>
      <path d="M9 7.2c0-1.1.8-2 1.8-2"/>
      <path d="M13.2 6.4c0-1.1.8-2 1.8-2"/>
    </g>
    <ellipse cx="12" cy="13.2" rx="5.2" ry="1.1" fill="#D93A4A" opacity="0.15" stroke="none"/>`
  ),
  'what-pizza': chip(
    '#FFF0C9',
    `<g ${S('#E0A010', 2)}>
      <path d="M12 3.2 3.2 20.8h17.6L12 3.2z" fill="#E0A010" fill-opacity="0.12"/>
      <path d="M12 3.2 3.2 20.8h17.6L12 3.2z"/>
      <circle cx="10" cy="12.2" r="1.15" fill="#E0A010" stroke="none"/>
      <circle cx="13.6" cy="14.6" r="1.15" fill="#E0A010" stroke="none"/>
      <circle cx="11.4" cy="16.8" r="1" fill="#E0A010" stroke="none"/>
    </g>`
  ),
  'what-fish': chip(
    '#E2E4F7',
    `<g ${S('#4A52C0', 2)}>
      <path d="M2.2 12s3.6-6.2 9.8-6.2S21.8 12 21.8 12s-3.6 6.2-9.8 6.2S2.2 12 2.2 12z" fill="#4A52C0" fill-opacity="0.1"/>
      <path d="M2.2 12s3.6-6.2 9.8-6.2S21.8 12 21.8 12s-3.6 6.2-9.8 6.2S2.2 12 2.2 12z"/>
      <path d="M21.8 12 16.8 9v6L21.8 12z" fill="#4A52C0" fill-opacity="0.2"/>
      <circle cx="8" cy="11.2" r="1.1" fill="#4A52C0" stroke="none"/>
    </g>`
  ),
  'what-bowl': chip(
    '#F7E2DC',
    `<g ${S('#D03F16', 2)}>
      <path d="M4.2 10.8h15.6"/>
      <path d="M5 10.8a7 7 0 0 0 14 0"/>
      <path d="M7.8 6.8 10.6 10.8"/>
      <path d="M16.2 6.8 13.4 10.8"/>
      <path d="M12 16.6V20.4"/>
      <path d="M8.6 20.4h6.8"/>
    </g>`
  ),
  'what-sandwich': chip(
    '#F9DCEC',
    `<g ${S('#D23A9A', 2)}>
      <path d="M3.5 9.2h17"/>
      <path d="M4 9.2c0-2.1 2.6-3.6 8-3.6s8 1.5 8 3.6" fill="#D23A9A" fill-opacity="0.12"/>
      <path d="M4 9.2c0-2.1 2.6-3.6 8-3.6s8 1.5 8 3.6"/>
      <path d="M4 14.6h16"/>
      <path d="M4 14.6c0 2.1 2.6 3.6 8 3.6s8-1.5 8-3.6"/>
      <path d="M5.2 11.9h13.6"/>
    </g>`
  ),
  'what-coffee': chip(
    '#F0E4D8',
    `<g ${S('#7E5434', 2)}>
      <path d="M5 8.8h10.6v6.8a3.4 3.4 0 0 1-3.4 3.4H8.4A3.4 3.4 0 0 1 5 15.6V8.8z" fill="#7E5434" fill-opacity="0.12"/>
      <path d="M5 8.8h10.6v6.8a3.4 3.4 0 0 1-3.4 3.4H8.4A3.4 3.4 0 0 1 5 15.6V8.8z"/>
      <path d="M15.6 10.2h2a2.2 2.2 0 1 1 0 4.4h-2"/>
      <path d="M8.2 3.6c.6 1.1.6 2.1 0 3.2"/>
      <path d="M11.2 3.2c.6 1.1.6 2.1 0 3.2"/>
    </g>`
  ),

  /* —— 함께 —— */
  'with-user': chip(
    '#E8EEF4',
    `<g ${S('#5B6B7C', 2)}>
      <circle cx="12" cy="8" r="3.6" fill="#5B6B7C" fill-opacity="0.15"/>
      <circle cx="12" cy="8" r="3.6"/>
      <path d="M4.8 20.6c0-3.7 3.2-6.6 7.2-6.6s7.2 2.9 7.2 6.6"/>
    </g>`
  ),
  'with-users': chip(
    '#DDF4EA',
    `<g ${S('#2A9B72', 2)}>
      <circle cx="9" cy="8" r="3.1" fill="#2A9B72" fill-opacity="0.15"/>
      <circle cx="9" cy="8" r="3.1"/>
      <circle cx="16.6" cy="9" r="2.5"/>
      <path d="M2.6 20.4c0-3.2 2.8-5.8 6.4-5.8"/>
      <path d="M12.4 20.4c0-2.6 2.2-4.7 5-4.7 1.3 0 2.5.4 3.4 1.1"/>
    </g>`
  ),
  'with-heart': chip(
    '#FFE0E6',
    `<path d="M12 20.2S4.4 15.4 4.4 10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.6 2.8C19.6 15.4 12 20.2 12 20.2z" fill="#E11D48" fill-opacity="0.92" stroke="#C9163C" stroke-width="1.2" stroke-linejoin="round"/>`
  ),
  'with-friends': chip(
    '#D7EEFC',
    `<g ${S('#0B95D6', 2)}>
      <circle cx="8.4" cy="8" r="3.1" fill="#0B95D6" fill-opacity="0.15"/>
      <circle cx="8.4" cy="8" r="3.1"/>
      <circle cx="16.2" cy="8.4" r="2.6"/>
      <path d="M2.4 20.4c0-3 2.5-5.4 6-5.4"/>
      <path d="M12.2 20.4c.2-2.5 2.2-4.5 4.8-4.5 1.2 0 2.2.3 3 .9"/>
    </g>`
  ),
  'with-briefcase': chip(
    '#E7ECF1',
    `<g ${S('#2F3E4E', 2)}>
      <rect x="3.4" y="8" width="17.2" height="11.6" rx="2" fill="#2F3E4E" fill-opacity="0.1"/>
      <rect x="3.4" y="8" width="17.2" height="11.6" rx="2"/>
      <path d="M9 8V6.4A1.6 1.6 0 0 1 10.6 4.8h2.8A1.6 1.6 0 0 1 15 6.4V8"/>
      <path d="M3.4 12.8h17.2"/>
    </g>`
  ),
  'with-graduation': chip(
    '#DCE6F2',
    `<g ${S('#1A3558', 2)}>
      <path d="M2.4 10.2 12 5.6l9.6 4.6L12 14.8 2.4 10.2z" fill="#1A3558" fill-opacity="0.12"/>
      <path d="M2.4 10.2 12 5.6l9.6 4.6L12 14.8 2.4 10.2z"/>
      <path d="M6.6 12.2v4c0 0 2.3 2.2 5.4 2.2s5.4-2.2 5.4-2.2v-4"/>
      <path d="M21.6 10.2v5.4"/>
    </g>`
  ),
  'with-party': chip(
    '#FDE9C2',
    `<g ${S('#D97706', 2)}>
      <path d="M5 14.8 10.8 3.8l4 2.2L9 17z" fill="#D97706" fill-opacity="0.15"/>
      <path d="M5 14.8 10.8 3.8l4 2.2L9 17z"/>
      <path d="M14.8 6 19.4 8.4"/>
      <path d="M16.6 3.2v2.2"/>
      <path d="M19.6 5 18 6.8"/>
      <path d="M12.2 3.6 13.2 5.4"/>
      <path d="M4.4 19h8.2"/>
      <path d="M6 21h5"/>
    </g>`
  ),
  'with-ellipsis': chip(
    '#EEEAE6',
    `<circle cx="6" cy="12" r="2" fill="#8A837C"/>
    <circle cx="12" cy="12" r="2" fill="#8A837C"/>
    <circle cx="18" cy="12" r="2" fill="#8A837C"/>`
  ),

  /* —— 포만감 참고 SVG (UI는 FA 사용, 에셋 톤 맞춤) —— */
  'satiety-1': chip(
    '#EEF2F6',
    `<g ${S('#94A3B8', 2)}>
      <circle cx="12" cy="13" r="7.2"/>
      <path d="M9.2 11.4h.02M14.8 11.4h.02"/>
      <path d="M9.4 16c.9-1.1 1.8-1.6 2.6-1.6s1.7.5 2.6 1.6"/>
    </g>`
  ),
  'satiety-2': chip(
    '#DCEEFF',
    `<g ${S('#60A5FA', 2)}>
      <circle cx="12" cy="12" r="8"/>
      <path d="M8.6 10h.02M15.4 10h.02"/>
      <path d="M9 15.2c1-.9 2.1-1.4 3-1.4s2 .5 3 1.4"/>
    </g>`
  ),
  'satiety-3': chip(
    '#DDF6EA',
    `<g ${S('#10B981', 2)}>
      <circle cx="12" cy="12" r="8"/>
      <path d="M8.6 10h.02M15.4 10h.02"/>
      <path d="M8.8 14c1.2 1.6 2.6 2.4 3.2 2.4s2-.8 3.2-2.4"/>
    </g>`
  ),
  'satiety-4': chip(
    '#FFE8CC',
    `<g ${S('#FB923C', 2)}>
      <circle cx="12" cy="12" r="8"/>
      <path d="M8.6 10h.02M15.4 10h.02"/>
      <path d="M8.2 13.4c1.4 2.3 3 3.4 3.8 3.4s2.4-1.1 3.8-3.4"/>
    </g>`
  ),
  'satiety-5': chip(
    '#FCE4F0',
    `<g ${S('#F472B6', 2)}>
      <circle cx="12" cy="12" r="8"/>
      <path d="M8.6 10h.02M15.4 10h.02"/>
      <path d="M8 13.2c1.6 2.7 3.3 4 4 4s2.4-1.3 4-4"/>
    </g>`
  )
};

fs.mkdirSync(outDir, { recursive: true });
for (const [name, svg] of Object.entries(icons)) {
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg.trim() + '\n', 'utf8');
}
for (let n = 1; n <= 5; n++) {
  fs.writeFileSync(path.join(outDir, `rating-${n}.svg`), starsChip(n).trim() + '\n', 'utf8');
}
console.log(`Wrote ${Object.keys(icons).length + 5} icons → ${outDir}`);
