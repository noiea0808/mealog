/**
 * usageDaily 계측 키의 3자 동기화 계약.
 *
 * 배경: 2026-08-12~19 기록 시트 개편과 함께 계측 이벤트 21종을 심었는데,
 * 8/26에 열어 보니 usageDaily 에 **총 0건**이었다. functions/index.js 의
 * USAGE_DAILY_METRIC_KEYS 에 그 키들을 넣지 않아 Callable 이 invalid-argument 로
 * 전부 거절하고 있었다.
 *
 * 조용히 죽는 종류다. 클라이언트는 Firestore 직접 쓰기로 폴백하지만 그 경로는
 * 로컬 캐시에만 앉는 경우가 있어 서버에 아무것도 남지 않고, 관리자 표에는 행이
 * 멀쩡히 보이는데 값만 0 이라 「기능이 안 쓰인다」와 구분되지 않는다. 2주치
 * 개편 효과 측정을 통째로 날렸다.
 *
 * 여기서 지키는 계약: **호출부 · 대시보드 정의 · 서버 화이트리스트 셋이 일치한다.**
 * (폐지된 키는 과거 이력 때문에 정의·화이트리스트에 남을 수 있어 호출부만 면제한다)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 호출부에 없어도 되는 키 — 기능은 없어졌지만 과거 이력이 남아 표에 계속 보인다 */
const RETIRED_KEYS = new Set(['settings_tags']);

function collectJsFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...collectJsFiles(full));
        else if (name.endsWith('.js')) out.push(full);
    }
    return out;
}

/**
 * 앱이 실제로 올릴 수 있는 키.
 *
 * 두 갈래를 본다. 대부분은 logUsageMetric('...') 리터럴이지만, 키를 표로 들고 발행하는
 * 모듈(entry-sheet-session.js)도 있어서 그쪽은 리터럴로 안 잡힌다. 그런 모듈은
 * `export const ..._METRIC_KEYS = [...]` 로 발행 목록을 내보내기로 하고, 여기서 함께 읽는다.
 */
function calledKeys() {
    const keys = new Set();
    for (const file of collectJsFiles(join(ROOT, 'js'))) {
        const src = readFileSync(file, 'utf8');
        for (const m of src.matchAll(/logUsageMetric\(([^)]*)\)/g)) {
            const arg = m[1];
            // 삼항의 조건절에 있는 비교 문자열(mode === 'typeahead')은 키가 아니다
            const withoutConditions = arg.replace(/[=!]==?\s*'[^']*'/g, '');
            for (const lit of withoutConditions.matchAll(/'([a-z0-9_]+)'/g)) keys.add(lit[1]);
        }
        // 선언형 발행 목록 — export const XXX_METRIC_KEYS = Object.freeze([...]) / [...]
        for (const m of src.matchAll(/export const [A-Z0-9_]*METRIC_KEYS?\s*=\s*(?:Object\.freeze\()?\[([\s\S]*?)\]/g)) {
            for (const lit of m[1].matchAll(/'([a-z0-9_]+)'/g)) keys.add(lit[1]);
        }
    }
    return keys;
}

/** js/admin/dashboard.js 의 *_METRIC_DEFS 에 정의된 field */
function dashboardKeys() {
    const src = readFileSync(join(ROOT, 'js/admin/dashboard.js'), 'utf8');
    const keys = new Set();
    for (const block of src.matchAll(/_METRIC_DEFS = \[([\s\S]*?)\n\];/g)) {
        for (const m of block[1].matchAll(/field:\s*'([a-z0-9_]+)'/g)) keys.add(m[1]);
    }
    return keys;
}

/** functions/index.js 의 USAGE_DAILY_METRIC_KEYS */
function serverKeys() {
    const src = readFileSync(join(ROOT, 'functions/index.js'), 'utf8');
    const block = /const USAGE_DAILY_METRIC_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    assert.ok(block, 'functions/index.js 에서 USAGE_DAILY_METRIC_KEYS 를 찾지 못했습니다');
    return new Set([...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
}

describe('usageDaily 계측 키 동기화 (2026-08-26)', () => {
    const called = calledKeys();
    const dashboard = dashboardKeys();
    const server = serverKeys();

    it('세 목록 모두 비어 있지 않다', () => {
        assert.ok(called.size > 10, `호출부 키가 ${called.size}개뿐 — 파싱이 깨졌을 수 있습니다`);
        assert.ok(dashboard.size > 10, `대시보드 키가 ${dashboard.size}개뿐`);
        assert.ok(server.size > 10, `서버 키가 ${server.size}개뿐`);
    });

    it('호출하는 키는 서버가 모두 받는다 (빠지면 조용히 유실)', () => {
        const missing = [...called].filter((k) => !server.has(k)).sort();
        assert.deepEqual(
            missing,
            [],
            `functions/index.js USAGE_DAILY_METRIC_KEYS 에 없습니다 — Callable 이 거절합니다:\n  ${missing.join('\n  ')}`
        );
    });

    it('호출하는 키는 대시보드에 행이 있다 (없으면 쌓여도 안 보임)', () => {
        const missing = [...called].filter((k) => !dashboard.has(k)).sort();
        assert.deepEqual(missing, [], `js/admin/dashboard.js METRIC_DEFS 에 없습니다:\n  ${missing.join('\n  ')}`);
    });

    it('대시보드 행과 서버 화이트리스트가 일치한다', () => {
        const onlyDashboard = [...dashboard].filter((k) => !server.has(k)).sort();
        const onlyServer = [...server].filter((k) => !dashboard.has(k)).sort();
        assert.deepEqual(onlyDashboard, [], `대시보드에만 있음:\n  ${onlyDashboard.join('\n  ')}`);
        assert.deepEqual(onlyServer, [], `서버에만 있음:\n  ${onlyServer.join('\n  ')}`);
    });

    it('폐지 키를 뺀 나머지는 실제 호출부가 있다 (죽은 행 방지)', () => {
        const dead = [...dashboard].filter((k) => !called.has(k) && !RETIRED_KEYS.has(k)).sort();
        assert.deepEqual(dead, [], `표에는 있는데 아무 데서도 기록하지 않습니다:\n  ${dead.join('\n  ')}`);
    });
});
