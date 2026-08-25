/**
 * 순환 발송 덱의 계약.
 *
 * 요구는 한 문장이었다 — "40개를 랜덤한 순서로 보내고, 다 보내면 다시 또 랜덤으로."
 * 그 한 문장이 실제로 지켜지는지는 눈으로 볼 수 없다. 어긋나면 실사용자에게 같은 푸시가
 * 며칠 사이 두 번 나가고, 그때는 이미 나간 뒤다. 그래서 여기서 못박는다.
 *
 *  1. 한 바퀴 안에서는 중복이 없다.
 *  2. 바퀴 경계에서도 연달아 같은 메시지가 나오지 않는다.
 *     (없으면 40번째와 41번째가 같아진다 — 가장 티 나는 실패)
 *  3. 비활성·삭제된 잔재는 뽑는 자리에서 버려진다.
 *  4. 새로 담은 메시지는 이번 바퀴 앞쪽에 낀다 — 풀이 크면 몇 달 뒤에나 나가는 걸 막는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    shuffleIds,
    drawFromDeck,
    insertIntoDeckRemaining,
    rotationSlotDocId
} from '../functions/pushRotationDeck.js';

const ids = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
const emptyDeck = () => ({ remaining: [], served: [], cycleNo: 0, lastAssignedMessageId: null });

/** 예측 가능한 randomInt — 항상 첫 칸을 고른다 (셔플 결과가 뒤집힌 순서가 된다) */
const alwaysZero = () => 0;

describe('셔플 순환 덱', () => {
    it('한 바퀴(풀 크기)를 도는 동안 중복이 없다', () => {
        const pool = ids(40);
        const deck = emptyDeck();
        const drawn = Array.from({ length: 40 }, () => drawFromDeck(deck, pool));
        assert.equal(drawn.filter(Boolean).length, 40);
        assert.equal(new Set(drawn).size, 40, '한 바퀴 안에 같은 메시지가 두 번 나왔다');
        assert.deepEqual([...drawn].sort(), [...pool].sort(), '풀 전체가 정확히 한 번씩 나와야 한다');
    });

    it('다 뽑으면 새 바퀴가 시작되고 cycleNo 가 오른다', () => {
        const pool = ids(5);
        const deck = emptyDeck();
        for (let i = 0; i < 5; i++) drawFromDeck(deck, pool);
        assert.equal(deck.cycleNo, 1);
        assert.equal(deck.remaining.length, 0);
        drawFromDeck(deck, pool);
        assert.equal(deck.cycleNo, 2, '6번째에 두 번째 바퀴가 시작돼야 한다');
        assert.equal(deck.served.length, 1);
    });

    it('바퀴 경계에서 같은 메시지가 연달아 나오지 않는다', () => {
        // 1000회 반복해도 경계 중복이 한 번도 없어야 한다
        const pool = ids(3);
        for (let trial = 0; trial < 1000; trial++) {
            const deck = emptyDeck();
            const seq = Array.from({ length: 9 }, () => drawFromDeck(deck, pool));
            for (let i = 1; i < seq.length; i++) {
                assert.notEqual(seq[i], seq[i - 1], `연속 중복 발생: ${seq.join(',')}`);
            }
        }
    });

    it('풀이 1개뿐이면 매번 같은 메시지 — 막지 않고 그대로 낸다', () => {
        const pool = ['only'];
        const deck = emptyDeck();
        assert.equal(drawFromDeck(deck, pool), 'only');
        assert.equal(drawFromDeck(deck, pool), 'only');
    });

    it('풀이 비면 null — 배정이 멈춘다', () => {
        const deck = emptyDeck();
        assert.equal(drawFromDeck(deck, []), null);
        assert.equal(deck.cycleNo, 0, '뽑지 못했으면 바퀴도 돌지 않아야 한다');
    });

    it('비활성·삭제된 잔재 id 는 뽑는 자리에서 버려진다', () => {
        const pool = ['a', 'b'];
        // 덱에는 이미 사라진 gone1·gone2 가 남아 있다
        const deck = { remaining: ['gone1', 'a', 'gone2'], served: [], cycleNo: 1, lastAssignedMessageId: null };
        assert.equal(drawFromDeck(deck, pool), 'a');
        assert.deepEqual(deck.served, ['a'], '버려진 id 는 served 에 쌓이지 않는다');
        assert.equal(drawFromDeck(deck, pool), 'b', '잔재를 다 버린 뒤 새 바퀴로 넘어간다');
    });

    it('셔플은 원본을 건드리지 않고 같은 원소를 돌려준다', () => {
        const pool = ids(20);
        const copy = [...pool];
        const out = shuffleIds(pool);
        assert.deepEqual(pool, copy, '입력 배열이 변형되면 안 된다');
        assert.deepEqual([...out].sort(), [...copy].sort());
    });
});

describe('운영 중 메시지 추가', () => {
    it('우선 배정이 켜져 있으면 앞쪽 window 안에 낀다', () => {
        const remaining = ids(300);
        for (let trial = 0; trial < 200; trial++) {
            const next = insertIntoDeckRemaining(remaining, 'fresh', {
                newMessagePriority: true,
                priorityWindow: 10
            });
            const at = next.indexOf('fresh');
            assert.ok(at >= 0 && at <= 10, `앞쪽 10회 안이어야 하는데 ${at} 번째에 들어갔다`);
            assert.equal(next.length, remaining.length + 1);
        }
    });

    it('우선 배정을 끄면 잔여 구간 전체에 퍼진다', () => {
        const remaining = ids(300);
        const positions = new Set();
        for (let trial = 0; trial < 500; trial++) {
            const next = insertIntoDeckRemaining(remaining, 'fresh', { newMessagePriority: false });
            positions.add(next.indexOf('fresh'));
        }
        assert.ok(Math.max(...positions) > 50, '균등 삽입인데 앞쪽에만 몰렸다');
    });

    it('잔여가 비어 있으면 넣지 않는다 — 다음 셔플에 자연히 포함된다', () => {
        assert.deepEqual(insertIntoDeckRemaining([], 'fresh'), []);
    });

    it('이미 잔여에 있으면 두 번 넣지 않는다', () => {
        const remaining = ['a', 'b', 'c'];
        assert.deepEqual(insertIntoDeckRemaining(remaining, 'b'), remaining);
    });

    it('끼워 넣은 메시지는 그 바퀴 안에서 한 번만 나온다', () => {
        const pool = ids(5);
        const deck = emptyDeck();
        drawFromDeck(deck, pool); // 바퀴 시작
        const withFresh = [...pool, 'fresh'];
        deck.remaining = insertIntoDeckRemaining(deck.remaining, 'fresh', { priorityWindow: 2 });
        const rest = [];
        for (let i = 0; i < 5; i++) rest.push(drawFromDeck(deck, withFresh));
        assert.equal(rest.filter((x) => x === 'fresh').length, 1, 'fresh 가 한 바퀴에 두 번 나왔다');
    });
});

describe('결정론적 슬롯 문서 ID', () => {
    it('같은 슬롯이면 언제 계산해도 같은 ID — 중복 발송을 막는 자리', () => {
        assert.equal(rotationSlotDocId('default', '2026-09-03', '09:00'), 'rot_default_20260903_0900');
        assert.equal(
            rotationSlotDocId('default', '2026-09-03', '09:00'),
            rotationSlotDocId('default', '2026-09-03', '09:00')
        );
    });

    it('슬롯이 다르면 ID 도 다르다', () => {
        const a = rotationSlotDocId('default', '2026-09-03', '09:00');
        const b = rotationSlotDocId('default', '2026-09-03', '20:00');
        const c = rotationSlotDocId('default', '2026-09-04', '09:00');
        assert.equal(new Set([a, b, c]).size, 3);
    });
});

describe('주입한 난수로 동작을 고정할 수 있다', () => {
    it('randomInt 를 주면 셔플 결과가 결정된다', () => {
        // 항상 0을 고르는 randomInt → Fisher–Yates 가 배열을 뒤집는다
        assert.deepEqual(shuffleIds(['a', 'b', 'c'], alwaysZero), ['b', 'c', 'a']);
    });

    it('randomInt 를 주면 삽입 위치가 결정된다', () => {
        const next = insertIntoDeckRemaining(['a', 'b', 'c'], 'fresh', { randomInt: alwaysZero });
        assert.deepEqual(next, ['fresh', 'a', 'b', 'c']);
    });
});
