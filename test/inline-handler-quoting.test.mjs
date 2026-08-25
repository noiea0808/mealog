/**
 * 인라인 이벤트 핸들러 속성의 따옴표 계약.
 *
 * 배경: 2026-08-25, 관리자 > 푸시메시지의 발송 기록 행에서 개별 체크박스를 눌러도
 * 아무 일도 일어나지 않았다. '전체 선택'만 동작해 오래 눈에 띄지 않았다.
 *
 *   onchange="window.onAdminPushRowSelect(${JSON.stringify(r.id)}, this.checked)"
 *
 * JSON.stringify 는 값을 큰따옴표로 감싸 돌려준다. 그 결과가 큰따옴표로 열린 HTML
 * 속성 안에 들어가면 속성이 그 자리에서 끊긴다. 브라우저는 `window.onAdminPushRowSelect(`
 * 까지만 핸들러로 읽고 문법 오류로 버리며, 남은 조각(`abc123",` `this.checked)"`)을
 * 엉뚱한 속성으로 파싱한다. 조용히 죽는 종류의 버그다.
 *
 * 여기서 지키는 계약: **큰따옴표로 연 on* 속성 안에서는 JSON.stringify 를 쓰지 않는다.**
 * 대안은 두 가지 — data-* 속성에 값을 담고 `this.dataset.x` 로 읽거나,
 * 이 파일의 다른 핸들러들처럼 속성을 작은따옴표로 열거나.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const JS_ROOT = new URL('../js/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 앞에 공백이 있는 on* 속성만 — data-meal-feed-optio(ns)= 같은 우연한 일치를 걸러낸다 */
const BROKEN_ATTR = /\son[a-z]+\s*=\s*"[^"]*JSON\.stringify/g;

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

describe('인라인 핸들러 속성 — 조용히 죽는 따옴표 (2026-08-25)', () => {
    it('큰따옴표로 연 on* 속성 안에 JSON.stringify 가 없다', () => {
        const offenders = [];
        for (const file of collectJsFiles(JS_ROOT)) {
            const lines = readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                BROKEN_ATTR.lastIndex = 0;
                if (BROKEN_ATTR.test(line)) {
                    const rel = file.split('\\').join('/').replace(JS_ROOT, 'js/');
                    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
                }
            });
        }
        assert.deepEqual(
            offenders,
            [],
            `큰따옴표 속성 안의 JSON.stringify 는 핸들러를 통째로 무효화한다:\n${offenders.join('\n')}`
        );
    });

    it('깨진 마크업은 실제로 속성이 쪼개진다 — 계약의 근거', () => {
        // 브라우저 파서 없이도 재현되는 부분: JSON.stringify 는 큰따옴표를 만든다
        const id = 'AbC123xyz';
        const embedded = `onchange="handler(${JSON.stringify(id)}, this.checked)"`;
        assert.ok(embedded.includes('handler("'), '속성 값 안에서 큰따옴표가 열려 속성이 끊긴다');

        // 고친 형태는 속성 안에 큰따옴표를 만들지 않는다
        const fixed = 'onchange="handler(this.dataset.jobId, this.checked)"';
        assert.equal((fixed.match(/"/g) || []).length, 2, '속성을 여닫는 큰따옴표 2개뿐이어야 한다');
    });
});
