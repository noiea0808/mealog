/**
 * 정착 관문 + 리스 — 교착 방지 계약.
 *
 * 설계: `docs/sync-outbox-design.md` §4.7(리스), §4.8(관문), `docs/reliability-principles.md`
 *
 * 대전제: **이 앱이 통제할 수 없는 모든 대기는 영원히 끝나지 않을 수 있다고 가정한다.**
 * 그래서 여기서 검증하는 것은 「빨리 끝나는가」가 아니라 **「반드시 끝나는가」** 다.
 */
import './helpers/quiet-timers.mjs';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    withDeadline,
    withDeadlineOr,
    registerDeadlineSink,
    DeadlineError,
    DEADLINE,
    Lease
} from '../js/utils/with-deadline.js';

/** 절대 정착하지 않는 작업 — SDK 내부가 얼어붙은 상태의 모형 */
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterEach(() => registerDeadlineSink(null));

describe('withDeadline — 상한 안에 반드시 정착한다 (§4.8)', () => {
    it('시간 안에 끝나면 결과를 그대로 돌려준다', async () => {
        assert.equal(await withDeadline(Promise.resolve('ok'), 100, 'fast'), 'ok');
    });

    it('영원히 정착하지 않는 작업도 상한에서 끊긴다', async () => {
        const started = Date.now();

        await assert.rejects(withDeadline(never(), 30, 'frozen-sdk'), (e) => {
            assert.ok(e instanceof DeadlineError);
            assert.equal(e.code, 'deadline-exceeded');
            assert.equal(e.__mealogDeadline, true);
            assert.equal(e.label, 'frozen-sdk');
            assert.equal(e.timeoutMs, 30);
            return true;
        });

        assert.ok(Date.now() - started < 1000, '상한이 실제로 발화하지 않았다');
    });

    it('함수를 넘기면 지연 실행한다 — 호출 자체가 던져도 거절로 바뀐다', async () => {
        let ran = false;
        const p = withDeadline(() => {
            ran = true;
            throw new Error('즉시 실패');
        }, 100, 'throwing');

        await assert.rejects(p, /즉시 실패/);
        assert.equal(ran, true);
    });

    it('상한이 0 이면 그대로 통과시킨다 (상한 없음)', async () => {
        assert.equal(await withDeadline(Promise.resolve(1), 0, 'no-limit'), 1);
    });

    it('관문이 끊은 뒤 원 작업이 늦게 거절해도 unhandledrejection 으로 새지 않는다', async () => {
        // 이게 깨지면 관문을 쓸수록 프로세스 단위 에러가 늘어난다.
        // save-with-timeout 이 `.catch(() => {})` 로 막던 것을 관문이 대신 보장해야 한다.
        //
        // 지금 이 보장은 `Promise.race` 가 원 프라미스에 핸들러를 달아 주는 데서 나온다
        // (`observe()` 는 이중 안전장치라 지워도 이 테스트는 통과한다 — 돌연변이로 확인).
        // 그래서 이 테스트가 지키는 것은 특정 구현 줄이 아니라 **관측 가능한 계약**이다:
        // race 를 걷어내는 식의 리팩터가 들어오면 그때 걸린다.
        const seen = [];
        const onUnhandled = (reason) => seen.push(reason);
        process.on('unhandledRejection', onUnhandled);

        try {
            const late = new Promise((_, reject) => setTimeout(() => reject(new Error('늦은 실패')), 30));
            await assert.rejects(withDeadline(late, 10, 'late-reject'), DeadlineError);
            await sleep(80); // 원 프라미스가 거절될 시간을 준다
            assert.deepEqual(seen, [], '관문이 원 프라미스를 관찰하지 않았다');
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('발화하면 계측 싱크에 알린다 — 어디서 매달렸는지가 곧 진단이다 (§4.9)', async () => {
        const hits = [];
        registerDeadlineSink((info) => hits.push(info));

        await assert.rejects(withDeadline(never(), 20, 'appcheck-getToken'), DeadlineError);

        assert.equal(hits.length, 1);
        assert.equal(hits[0].label, 'appcheck-getToken');
        assert.equal(hits[0].timeoutMs, 20);
    });

    it('계측 싱크가 던져도 본 작업을 방해하지 않는다', async () => {
        registerDeadlineSink(() => {
            throw new Error('계측 고장');
        });

        await assert.rejects(withDeadline(never(), 20, 'x'), DeadlineError);
    });

    it('표준 상한값이 정의돼 있다 — 호출부가 매번 새 숫자를 만들지 않게', () => {
        for (const k of ['LOCAL', 'PREFLIGHT', 'APPCHECK', 'DOC', 'SAVE', 'UPLOAD']) {
            assert.equal(typeof DEADLINE[k], 'number', `DEADLINE.${k} 가 없다`);
            assert.ok(DEADLINE[k] > 0);
        }
        // App Check 는 호출부가 기다려 주는 시간이 아니라 SDK 내부 대기를 대신 끊는 값이라
        // 인색하게 잡으면 멀쩡한 회선에서 정상 토큰을 버린다 (§2.5).
        assert.ok(DEADLINE.APPCHECK > DEADLINE.PREFLIGHT, 'APPCHECK 을 PREFLIGHT 수준으로 줄이면 §2.5 재발');
    });
});

describe('withDeadlineOr — 실패해도 진행해야 하는 단계 (§4.8)', () => {
    it('상한을 넘기면 fallback 으로 resolve 한다 — 절대 거절하지 않는다', async () => {
        assert.equal(await withDeadlineOr(never(), 20, 'fallback', 'token-refresh'), 'fallback');
    });

    it('일반 예외도 fallback 으로 흡수한다', async () => {
        assert.equal(await withDeadlineOr(Promise.reject(new Error('boom')), 100, null, 'x'), null);
    });

    it('성공하면 실제 값을 돌려준다', async () => {
        assert.equal(await withDeadlineOr(Promise.resolve('real'), 100, 'fallback', 'x'), 'real');
    });
});

describe('Lease — 어디서 매달려도 스스로 풀린다 (§4.7)', () => {
    it('점유 중에는 다른 획득을 막는다', () => {
        const lease = new Lease('worker', 1000);

        assert.equal(lease.acquire(), true);
        assert.equal(lease.acquire(), false, '중복 실행을 막지 못했다');
        assert.equal(lease.held, true);
    });

    it('release 하면 즉시 다시 잡을 수 있다', () => {
        const lease = new Lease('worker', 1000);
        lease.acquire();

        lease.release();

        assert.equal(lease.held, false);
        assert.equal(lease.acquire(), true);
    });

    it('TTL 이 지나면 만료된 점유를 빼앗는다 — 불린 가드였다면 영구 교착이던 자리', async () => {
        const lease = new Lease('drain', 20);
        assert.equal(lease.acquire(), true);

        await sleep(40); // 점유자가 상한 없는 await 안에서 매달린 상태

        assert.equal(lease.held, false);
        assert.equal(lease.acquire(), true, '만료된 점유가 풀리지 않으면 큐 전체가 멈춘다');
    });

    it('만료 탈취는 계측에 남는다 — 잦으면 그 자체가 버그 신호다', async () => {
        const hits = [];
        registerDeadlineSink((info) => hits.push(info));
        const lease = new Lease('drain', 20);
        lease.acquire();

        await sleep(40);
        lease.acquire();

        assert.equal(hits.length, 1);
        assert.equal(hits[0].label, 'lease-expired:drain');
    });

    it('renew 는 진행 중인 작업이 점유를 뺏기지 않게 연장한다', async () => {
        const lease = new Lease('worker', 40);
        lease.acquire();

        await sleep(25);
        lease.renew();
        await sleep(25);

        assert.equal(lease.held, true, '연장이 반영되지 않았다');
    });

    it('renew 는 비어 있는 리스를 되살리지 않는다', () => {
        const lease = new Lease('worker', 1000);

        lease.renew();

        assert.equal(lease.held, false);
    });

    it('run 은 작업이 던져도 반드시 반납한다', async () => {
        const lease = new Lease('worker', 10000);

        await assert.rejects(lease.run(async () => {
            throw new Error('사이클 실패');
        }), /사이클 실패/);

        assert.equal(lease.held, false, '예외 경로에서 반납이 안 되면 이후 사이클이 전부 막힌다');
    });

    it('run 은 점유 실패 시 undefined 로 구분해 준다', async () => {
        const lease = new Lease('worker', 10000);
        lease.acquire();

        const result = await lease.run(async () => 'ran');

        assert.equal(result, undefined, '호출부가 「이미 돌고 있음」을 구분할 수 없다');
    });
});
