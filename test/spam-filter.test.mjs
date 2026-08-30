/**
 * 스팸 필터의 계약.
 *
 * 이 판정은 사용자가 방금 쓴 글을 통째로 거절한다. 틀리면 두 방향으로 다 나쁘다 —
 * 멀쩡한 글이 막히거나, 스팸이 통과한다. 그런데 그동안 확인할 방법이 없었고,
 * 실사용 중에 터져서야 알았다(2026-08-30, 밀톡 답변이 링크 하나 때문에 막힘).
 *
 * 여기서 못박는 것:
 *   1. 판정은 **호출 횟수와 무관하다** — 같은 글은 몇 번을 보내든 같은 답이다.
 *   2. 판정은 **다른 글에 오염되지 않는다** — 앞 요청이 뒤 요청의 답을 바꾸지 않는다.
 *   3. 우리 도메인 링크는 막지 않는다.
 *   4. 걸렸으면 무엇이 걸렸는지 말한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { checkSpam, MAX_EXTERNAL_LINKS } from '../functions/spam-filter.js';

/** 실제로 막혔던 그 글 (2026-08-30) */
const REAL_BLOCKED_MESSAGE = `우선 요청하신 내용들을 반영하긴 했으나, 현재 테스트 진행 중입니다.

혹시 생각한 대로 반영되었는지, 추가적으로 요청하고 싶은 부분이 있으신지 확인하고 싶으시다면 밀로그 웹으로 들어오시면 미리 보실 수 있습니다.

https://www.mealog.net/`;

describe('스팸 필터 — 판정의 안정성', () => {
    /**
     * 이것이 이 파일이 존재하는 이유다.
     *
     * 예전 구현은 모듈 스코프의 `/g` 정규식을 `test()` 로 썼다. `lastIndex` 가 호출마다
     * 남아서 같은 글이 「차단 → 차단 → 통과」로 순환했다. 사용자는 전송 버튼을 세 번
     * 누르면 뚫렸고, 그건 필터가 스팸을 전혀 막지 못했다는 뜻이기도 하다.
     */
    it('같은 글을 여러 번 검사해도 답이 흔들리지 않는다', () => {
        const samples = [
            REAL_BLOCKED_MESSAGE,
            '광고 문의 주세요',
            '무료 이벤트 할인 쿠폰',
            '오늘 점심은 김치찌개였습니다',
            'https://www.mealog.net/ 여기로 오세요',
            'http://a.example http://b.example http://c.example 다 보세요'
        ];
        for (const text of samples) {
            const first = checkSpam(text);
            for (let i = 0; i < 10; i++) {
                assert.deepEqual(
                    checkSpam(text),
                    first,
                    `"${text.slice(0, 20)}…" 의 판정이 ${i + 2}번째 호출에서 달라졌다`
                );
            }
        }
    });

    it('앞선 다른 글의 검사가 다음 글의 판정을 바꾸지 않는다', () => {
        /* 같은 인스턴스에서 다른 사용자의 글이 사이에 끼어드는 상황 */
        const clean = '오늘 저녁은 된장찌개';
        const dirty = '광고 문의는 여기로';

        const cleanAlone = checkSpam(clean);
        const dirtyAlone = checkSpam(dirty);

        for (let i = 0; i < 5; i++) {
            checkSpam(dirty);
            assert.deepEqual(checkSpam(clean), cleanAlone, '앞선 차단이 멀쩡한 글의 판정을 바꿨다');
            checkSpam(clean);
            assert.deepEqual(checkSpam(dirty), dirtyAlone, '앞선 통과가 스팸 글의 판정을 바꿨다');
        }
    });
});

describe('스팸 필터 — 링크', () => {
    it('실제로 막혔던 그 답변은 이제 통과한다', () => {
        assert.equal(checkSpam(REAL_BLOCKED_MESSAGE).isSpam, false);
    });

    it('우리 도메인 링크는 몇 개든 세지 않는다', () => {
        const text = [
            'https://www.mealog.net/',
            'https://mealog.net/privacy.html',
            'https://staging-mealog.vercel.app/',
            'https://play.google.com/store/apps/details?id=com.mealog.app'
        ].join(' ');
        assert.equal(checkSpam(text).isSpam, false);
    });

    it(`외부 링크가 ${MAX_EXTERNAL_LINKS}개까지는 통과한다`, () => {
        assert.equal(checkSpam('http://a.example 와 http://b.example 참고').isSpam, false);
    });

    it(`외부 링크가 ${MAX_EXTERNAL_LINKS}개를 넘으면 막는다`, () => {
        const r = checkSpam('http://a.example http://b.example http://c.example');
        assert.equal(r.isSpam, true);
        assert.match(r.reason, /링크/);
    });

    it('점이 들어간 평범한 표기는 링크가 아니다', () => {
        /* 예전 패턴 `[a-zA-Z0-9-]+\.[a-zA-Z]{2,}` 는 이런 것까지 링크로 잡았다 */
        assert.equal(checkSpam('오늘 3.5kg 감량, 목표는 2.0kg 더. 아침 7.30am 기상').isSpam, false);
    });

    it('링크라는 말 자체는 금칙어가 아니다', () => {
        assert.equal(checkSpam('아래 링크를 눌러 주세요').isSpam, false);
    });
});

describe('스팸 필터 — 일상어는 막지 않는다', () => {
    /* 예전 목록에는 이것들이 금칙어로 들어 있어서 정상 답변이 그대로 막혔다 */
    const everyday = [
        '지금은 무료로 쓰실 수 있어요',
        '이벤트 기간에는 조금 다릅니다',
        '할인 받으셨다니 다행이네요',
        '쿠폰 쓰신 거면 그 금액이 맞습니다',
        '무료 이벤트 할인 쿠폰'
    ];
    for (const text of everyday) {
        it(`"${text}" 는 통과한다`, () => {
            const r = checkSpam(text);
            assert.equal(r.isSpam, false, `막혔다: ${r.reason}`);
        });
    }
});

describe('스팸 필터 — 이유', () => {
    it('무엇이 걸렸는지 사용자에게 말한다', () => {
        const r = checkSpam('추천인 코드 넣어 주세요');
        assert.equal(r.isSpam, true);
        assert.match(r.reason, /추천인/, `걸린 말이 이유에 없다: ${r.reason}`);
    });

    it('사용자가 쓴 형태 그대로 돌려준다', () => {
        const r = checkSpam('HTTP 광고 문의');
        assert.equal(r.isSpam, true);
        assert.match(r.reason, /'광고'/);
    });
});

describe('스팸 필터 — 빈 입력', () => {
    it('빈 값·비문자열은 스팸이 아니다', () => {
        for (const v of ['', '   ', null, undefined, 0, {}, []]) {
            assert.equal(checkSpam(v).isSpam, false, `${JSON.stringify(v)} 가 스팸으로 판정됐다`);
        }
    });
});
