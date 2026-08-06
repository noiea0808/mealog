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
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERSION_JSON = path.join(ROOT, 'version.json');
const PRODUCTION_RELEASE_JSON = path.join(ROOT, 'production-release.json');

// versionCode = git 커밋 수 + 오프셋. 여러 작업환경이 각자 로컬에서 +1씩 증가시키던
// 방식은 같은 시점에 서로 다른 값으로 갈라져 병합 충돌을 유발했음.
// 커밋 수는 같은 HEAD에서는 어느 환경에서 빌드하든 항상 같은 값이 나오므로 충돌이 사라짐.
// 오프셋은 2026-08-06 전환 시점 값(커밋 725개 → versionCode 482)에 맞춰 연속성만 보정한 상수.
const VERSION_CODE_OFFSET = -243;

function getCommitCount() {
    try {
        return parseInt(execSync('git rev-list --count HEAD', { cwd: ROOT }).toString().trim(), 10);
    } catch {
        return null;
    }
}

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
    const current = loadJson(VERSION_JSON, { version: '1.0.0', versionCode: 1, buildDate: nowISO() });
    // INSTALL_FAILED_VERSION_DOWNGRADE: 기기에 더 큰 versionCode가 있으면 MEALOG_MIN_VERSION_CODE=185 형태로 한 번 빌드해 강제로 맞춘다.
    const commitCount = getCommitCount();
    const derivedCode = commitCount != null ? commitCount + VERSION_CODE_OFFSET : null;
    const envRaw = process.env.MEALOG_MIN_VERSION_CODE;
    const envParsed = envRaw != null && String(envRaw).trim() !== '' ? parseInt(envRaw, 10) : NaN;
    const envMin = Number.isFinite(envParsed) && envParsed > 0 ? envParsed : 0;
    // git 커밋 수를 못 구하면(예: git 없는 CI 아카이브) 기존 방식으로 안전하게 +1 폴백.
    const floor = Math.max(1, current.versionCode || 0, envMin);
    const nextCode = derivedCode != null ? Math.max(derivedCode, floor) : floor + 1;

    if (mode === 'production') {
        const nextVer = nextProductionVersion(current.version);
        const buildDate = nowISO();
        const data = {
            version: nextVer,
            versionCode: nextCode,
            buildDate,
        };
        saveJson(VERSION_JSON, data);
        saveJson(PRODUCTION_RELEASE_JSON, { version: nextVer, versionCode: nextCode, buildDate });
        console.log(`✅ Production: ${current.version} → ${nextVer}, versionCode: ${current.versionCode || 0} → ${nextCode} (${formatDateForDisplay(buildDate)})`);
        return;
    }

    if (mode === 'staging') {
        const nextVer = nextStagingVersion(current.version);
        const buildDate = nowISO();
        const prodRelease = loadJson(PRODUCTION_RELEASE_JSON, {});
        const baseBuildDate = prodRelease.buildDate || buildDate;
        const data = {
            version: nextVer,
            versionCode: nextCode,
            buildDate,
            baseBuildDate,
        };
        saveJson(VERSION_JSON, data);
        console.log(`✅ Staging: ${current.version} → ${nextVer}, versionCode: ${current.versionCode || 0} → ${nextCode} (${formatDateForDisplay(baseBuildDate)} (${formatDateForDisplay(buildDate)}))`);
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
