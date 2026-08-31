/**
 * 시각 표시 칸의 계약 — `[오전][08:35]` 두 조각을 24시 값 하나에서 그린다.
 *
 * 이 자리는 두 번 접혔다. 오전/오후가 `<select>` 였다가, 눌러서 뒤집는 버튼이
 * 됐다가, 지금은 컨트롤이 아니다 — 시각은 '현재'·'사진'이면 시계와 EXIF 가
 * 정하고 '직접 입력'이면 캐러셀 안에서 고르므로 따로 뒤집을 일이 없다.
 *
 * 여기서 못박는 것은 **빈 값의 모습**이다. 예전에는 '미입력'을 골라도 오전/오후
 * 칸에 기본값 '오후'가 그대로 떠 있었다 — 시각이 없는데 있다고 말하는 표시였고,
 * 저장값은 비어 있으니 화면만 조용히 거짓말을 했다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMealClockDisplay } from '../js/meal-time-utils.js';

/** 글자 자리 노릇만 하는 최소 대역 — textContent 와 classList 면 된다 */
function fakeSpan() {
    const classes = new Set();
    return {
        textContent: '',
        classList: {
            toggle(name, on) {
                if (on) classes.add(name);
                else classes.delete(name);
            },
            contains: (name) => classes.has(name)
        }
    };
}

const PLACEHOLDER = 'entry-meal-clock-text--placeholder';

describe('시각 표시 칸 — 24시 값 하나가 두 조각을 정한다', () => {
    it('오전을 오전으로, 오후를 오후로 그린다', () => {
        const ampm = fakeSpan();
        const text = fakeSpan();

        renderMealClockDisplay(ampm, text, '08:35');
        assert.equal(ampm.textContent, '오전');
        assert.equal(text.textContent, '08:35');

        renderMealClockDisplay(ampm, text, '20:35');
        assert.equal(ampm.textContent, '오후');
        assert.equal(text.textContent, '08:35');
    });

    it('자정과 정오 — 12시계의 두 경계', () => {
        const ampm = fakeSpan();
        const text = fakeSpan();

        renderMealClockDisplay(ampm, text, '00:00');
        assert.equal(ampm.textContent, '오전');
        assert.equal(text.textContent, '12:00');

        renderMealClockDisplay(ampm, text, '12:00');
        assert.equal(ampm.textContent, '오후');
        assert.equal(text.textContent, '12:00');
    });

    it('값이 없으면 오전/오후까지 지운다 — 없는 시각을 있다고 말하지 않는다', () => {
        const ampm = fakeSpan();
        const text = fakeSpan();

        renderMealClockDisplay(ampm, text, '08:35');
        renderMealClockDisplay(ampm, text, '');

        assert.equal(ampm.textContent, '');
        assert.equal(text.textContent, '시:분');
        assert.ok(text.classList.contains(PLACEHOLDER));
    });

    it('다시 값이 들어오면 자리표시 표시를 걷는다', () => {
        const ampm = fakeSpan();
        const text = fakeSpan();

        renderMealClockDisplay(ampm, text, '');
        renderMealClockDisplay(ampm, text, '21:05');

        assert.equal(ampm.textContent, '오후');
        assert.equal(text.textContent, '09:05');
        assert.equal(text.classList.contains(PLACEHOLDER), false);
    });

    it('읽을 수 없는 값은 빈 값과 같게 다룬다', () => {
        const ampm = fakeSpan();
        const text = fakeSpan();

        for (const bad of [null, undefined, '', '아침', '::']) {
            renderMealClockDisplay(ampm, text, bad);
            assert.equal(ampm.textContent, '', `${bad} 은 오전/오후를 비워야 한다`);
            assert.equal(text.textContent, '시:분');
        }
    });

    it('범위를 넘는 시각은 잘려 들어온다 — 빈 값이 아니다 (기존 정규화 규칙)', () => {
        // normalizeMealClockInputValue 가 25 → 23 으로 죈다. 저장 경로가 늘 통과시키는
        // 값이라 여기서 다시 판정하지 않는다 — 이 줄은 그 사실을 잊지 않으려고 둔다.
        const ampm = fakeSpan();
        const text = fakeSpan();
        renderMealClockDisplay(ampm, text, '25:00');
        assert.equal(ampm.textContent, '오후');
        assert.equal(text.textContent, '11:00');
    });

    it('없는 원소에 그려도 던지지 않는다 — 시트가 닫힌 뒤에도 동기화가 돈다', () => {
        assert.doesNotThrow(() => renderMealClockDisplay(null, null, '08:35'));
        assert.doesNotThrow(() => renderMealClockDisplay(null, fakeSpan(), ''));
    });
});
