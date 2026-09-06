import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sumMemoRowArrays, sumMemoRowTotals } from '../js/admin/dashboard-memo-row.js';

describe('트렌드 「메모」행 — 하루 소감 + 사용자 메모', () => {
    test('두 축이 다 있으면 자리별로 더한다', () => {
        assert.deepEqual(sumMemoRowArrays([1, 2, 3], [10, 0, 5]), [11, 2, 8]);
    });

    test('사용자 메모 축이 없는 옛 캐시는 하루 소감만 보여준다', () => {
        assert.deepEqual(sumMemoRowArrays([1, 2, 3], undefined), [1, 2, 3]);
        assert.deepEqual(sumMemoRowArrays([1, 2, 3], []), [1, 2, 3]);
    });

    test('하루 소감 쪽이 비어도 같은 규칙이다', () => {
        assert.deepEqual(sumMemoRowArrays(null, [4, 5]), [4, 5]);
    });

    test('둘 다 없으면 빈 배열 — 표는 이 자리를 「모른다」로 둔다', () => {
        assert.deepEqual(sumMemoRowArrays(null, undefined), []);
        assert.deepEqual(sumMemoRowArrays([], []), []);
    });

    test('길이가 어긋나면 긴 쪽에 맞추고 모자란 자리는 0 으로 본다', () => {
        assert.deepEqual(sumMemoRowArrays([1, 1], [1, 1, 1]), [2, 2, 1]);
    });

    test('원본 배열을 건드리지 않는다', () => {
        const journal = [1, 2];
        const memo = [3, 4];
        sumMemoRowArrays(journal, memo);
        assert.deepEqual(journal, [1, 2]);
        assert.deepEqual(memo, [3, 4]);
    });

    test('숫자가 아닌 값은 0 으로 센다 — 캐시가 문자열을 들고 있어도 표가 깨지지 않는다', () => {
        assert.deepEqual(sumMemoRowArrays([null, '2'], [1, 1]), [1, 3]);
    });

    test('합계 칸: 한쪽만 있어도 그 값이 나온다', () => {
        assert.equal(sumMemoRowTotals(5, 3), 8);
        assert.equal(sumMemoRowTotals(5, undefined), 5);
        assert.equal(sumMemoRowTotals(undefined, 3), 3);
        assert.equal(sumMemoRowTotals(0, 0), 0);
    });

    test('합계 칸: 둘 다 모르면 undefined — 0 이 아니다', () => {
        assert.equal(sumMemoRowTotals(undefined, undefined), undefined);
        assert.equal(sumMemoRowTotals(null, null), undefined);
    });
});
