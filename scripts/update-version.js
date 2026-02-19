#!/usr/bin/env node
/**
 * 버전 및 배포일자 자동 업데이트
 * - production: 1.0.0 → 1.0.1 → 1.0.2 (패치 증가)
 * - staging: 1.0.0 → 1.0.0_1 → 1.0.0_2, 프로덕션 후 1.0.1 → 1.0.1_1
 *
 * 사용: node scripts/update-version.js production | staging
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VERSION_JSON = path.join(ROOT, 'version.json');
const PRODUCTION_RELEASE_JSON = path.join(ROOT, 'production-release.json');

function loadJson(filePath, defaultVal = {}) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return defaultVal;
    }
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nowISO() {
    return new Date().toISOString();
}

function formatDateForDisplay(isoStr) {
    const d = new Date(isoStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
}

function parseVersion(ver) {
    const match = String(ver || '').match(/^(\d+)\.(\d+)\.(\d+)(?:_(\d+))?$/);
    if (!match) return null;
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        stagingNum: match[4] ? parseInt(match[4], 10) : null,
    };
}

function nextProductionVersion(current) {
    const p = parseVersion(current);
    if (!p) return '1.0.0';
    return `${p.major}.${p.minor}.${p.patch + 1}`;
}

function nextStagingVersion(current) {
    const p = parseVersion(current);
    if (!p) return '1.0.0_1';
    const base = `${p.major}.${p.minor}.${p.patch}`;
    const nextNum = (p.stagingNum || 0) + 1;
    return `${base}_${nextNum}`;
}

function run(mode) {
    const current = loadJson(VERSION_JSON, { version: '1.0.0', buildDate: nowISO() });

    if (mode === 'production') {
        const nextVer = nextProductionVersion(current.version);
        const buildDate = nowISO();
        const data = {
            version: nextVer,
            buildDate,
        };
        saveJson(VERSION_JSON, data);
        saveJson(PRODUCTION_RELEASE_JSON, { version: nextVer, buildDate });
        console.log(`✅ Production: ${current.version} → ${nextVer} (${formatDateForDisplay(buildDate)})`);
        return;
    }

    if (mode === 'staging') {
        const nextVer = nextStagingVersion(current.version);
        const buildDate = nowISO();
        const prodRelease = loadJson(PRODUCTION_RELEASE_JSON, {});
        const baseBuildDate = prodRelease.buildDate || buildDate;
        const data = {
            version: nextVer,
            buildDate,
            baseBuildDate,
        };
        saveJson(VERSION_JSON, data);
        console.log(`✅ Staging: ${current.version} → ${nextVer} (${formatDateForDisplay(baseBuildDate)} (${formatDateForDisplay(buildDate)}))`);
        return;
    }

    console.error('Usage: node scripts/update-version.js production | staging');
    process.exit(1);
}

const mode = process.argv[2]?.toLowerCase();
if (!['production', 'staging'].includes(mode)) {
    console.error('Usage: node scripts/update-version.js production | staging');
    process.exit(1);
}
run(mode);
