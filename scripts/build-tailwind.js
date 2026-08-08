#!/usr/bin/env node
/**
 * Tailwind 정적 CSS 빌드 (Play CDN 대체).
 *
 * CDN(cdn.tailwindcss.com)은 398KB짜리 JIT 컴파일러를 렌더 차단 위치에서
 * 받아 런타임에 CSS를 생성한다. 실제 산출물은 수십 KB뿐이라 빌드타임으로 옮긴다.
 *
 * 산출물: css/tailwind.build.css
 * 로드 위치: index.html에서 css/style.css **뒤** (tailwind.config.js 주석 참고)
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'css', 'tailwind.build.css');

// 경로에 공백이 있으면(예: "E:\200. Dev\mealog") win32 shell 실행 시 인자가 쪼개진다.
// cwd를 ROOT로 두고 상대 경로만 넘겨 회피.
const minify = !process.argv.includes('--no-minify');

const args = [
    'tailwindcss',
    '-c', 'tailwind.config.js',
    '-i', 'css/tailwind.input.css',
    '-o', 'css/tailwind.build.css'
];
if (minify) args.push('--minify');

console.log('[build-tailwind] 빌드 시작' + (minify ? ' (minify)' : ''));
try {
    execFileSync('npx', args, {
        cwd: ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: process.platform === 'win32'
    });
} catch (err) {
    console.error('[build-tailwind] 빌드 실패:', err.message);
    process.exit(1);
}

if (!fs.existsSync(OUTPUT)) {
    console.error('[build-tailwind] 산출물이 생성되지 않았습니다:', OUTPUT);
    process.exit(1);
}
const bytes = fs.statSync(OUTPUT).size;
if (bytes < 1024) {
    console.error('[build-tailwind] 산출물이 비정상적으로 작습니다(' + bytes + 'B). content 경로를 확인하세요.');
    process.exit(1);
}
console.log('[build-tailwind] 완료: css/tailwind.build.css (' + (bytes / 1024).toFixed(1) + 'KB)');
