#!/usr/bin/env node
/**
 * 로컬 개발용 정적 서버.
 *
 * 빌드 없이 리포 루트를 그대로 서빙한다. Tailwind 빌드 산출물 검증이나
 * 캐스케이드 순서 확인처럼 "배포 전에 실제 브라우저에서 확인"이 필요할 때 사용.
 *
 *   npm run dev:serve      → http://localhost:8777
 *
 * 주의: 개발 전용. 인증·압축·캐시 헤더가 없다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8777;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const file = path.resolve(ROOT, '.' + urlPath);
    // 디렉터리 탈출 차단
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
        res.writeHead(403).end('forbidden');
        return;
    }

    fs.readFile(file, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found: ' + urlPath);
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(buf);
    });
}).listen(PORT, () => {
    console.log('[dev-static-server] http://localhost:' + PORT + ' (root: ' + ROOT + ')');
});
