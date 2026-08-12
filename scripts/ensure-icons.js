#!/usr/bin/env node
/**
 * Android 런처 아이콘 생성.
 *
 * 소스(assets/):
 *   icon-foreground.png : 어댑티브 전경 — 108dp 캔버스 기준, 로고는 중앙 72dp 안전영역 안에 둔다
 *   icon-background.png : 어댑티브 배경 — 단색, 캔버스를 끝까지 채운다
 *   icon-legacy.png     : API 25 이하 런처가 그대로 그리는 비트맵(스쿼클 모양이 이미지에 포함)
 *
 * Android 8(API 26)+ 런처는 mipmap-anydpi-v26의 어댑티브 아이콘을 쓰고, 없으면 레거시 PNG를
 * 흰 배경 위에 얹어 마스킹한다. 삼성 One UI에서 아이콘 코너에 흰 여백이 보이던 원인이 이것이라
 * anydpi-v26은 반드시 있어야 한다.
 *
 * @capacitor/assets 를 쓰지 않고 직접 생성하는 이유:
 *   - 배경에까지 inset 16.7% 를 넣은 XML을 만들어 배경이 108dp를 못 채운다. 마스크가 72dp보다
 *     큰 런처에서 가장자리가 비어 흰 여백이 다시 보인다.
 *   - 어댑티브 레이어를 48dp 기준 해상도로 뽑아 홈 화면에서 흐려진다.
 *   - 레거시 아이콘을 icon-only.png(흰 배경 포함)에서 만들어 코너에 흰 링이 남는다.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res');

const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const ADAPTIVE_DP = 108; // 어댑티브 아이콘 캔버스
const SAFE_DP = 72; // 런처 마스크가 보장하는 표시 영역
const LEGACY_DP = 48; // 레거시 런처 아이콘

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;

const SOURCES = ['icon-foreground.png', 'icon-background.png', 'icon-legacy.png'];

async function generate(sharp) {
  const [fg, bg, legacy] = SOURCES.map((n) => path.join(assetsDir, n));

  for (const [density, scale] of Object.entries(DENSITIES)) {
    const dir = path.join(resDir, `mipmap-${density}`);
    fs.mkdirSync(dir, { recursive: true });

    const adaptive = Math.round(ADAPTIVE_DP * scale);
    const legacySize = Math.round(LEGACY_DP * scale);

    await sharp(fg).resize(adaptive, adaptive).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
    await sharp(bg).resize(adaptive, adaptive).png().toFile(path.join(dir, 'ic_launcher_background.png'));
    await sharp(legacy).resize(legacySize, legacySize).png().toFile(path.join(dir, 'ic_launcher.png'));

    // 원형 런처 아이콘: 레거시 캔버스(48dp)가 어댑티브 안전영역(72dp)에 대응하므로
    // 전경을 108/72 배로 키운 뒤 가운데를 잘라 써야 어댑티브와 크기가 같아 보인다.
    const scaled = Math.round((legacySize * ADAPTIVE_DP) / SAFE_DP);
    const inset = Math.round((scaled - legacySize) / 2);
    const fgCropped = await sharp(fg)
      .resize(scaled, scaled)
      .extract({ left: inset, top: inset, width: legacySize, height: legacySize })
      .toBuffer();
    const circle = Buffer.from(
      `<svg width="${legacySize}" height="${legacySize}"><circle cx="${legacySize / 2}" cy="${legacySize / 2}" r="${legacySize / 2}" fill="#fff"/></svg>`
    );
    await sharp(bg)
      .resize(legacySize, legacySize)
      .composite([{ input: fgCropped }, { input: circle, blend: 'dest-in' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_round.png'));
  }

  const anydpi = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(anydpi, { recursive: true });
  fs.writeFileSync(path.join(anydpi, 'ic_launcher.xml'), ADAPTIVE_XML);
  fs.writeFileSync(path.join(anydpi, 'ic_launcher_round.xml'), ADAPTIVE_XML);
}

(async () => {
  const missing = SOURCES.filter((n) => !fs.existsSync(path.join(assetsDir, n)));
  if (missing.length) {
    console.warn(`⚠ 아이콘 소스 없음 (${missing.join(', ')}) → 아이콘 생성 건너뜀`);
    return;
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.warn('⚠ sharp 없음 → 아이콘 생성 건너뜀 (빌드는 계속 진행됩니다)');
    return;
  }

  console.log('✓ 앱 아이콘 소스 발견 → 아이콘 생성 실행');
  try {
    await generate(sharp);
    console.log('✅ 앱 아이콘 생성 완료 (어댑티브 + 레거시)');
  } catch (e) {
    console.warn('⚠ 아이콘 생성 실패 (빌드는 계속 진행됩니다):', e.message || e);
  }
})();
