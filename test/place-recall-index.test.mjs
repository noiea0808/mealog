import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildPlaceIndex,
    pickPlaceSuggestions,
    placeSearchKey,
    hasTrailingJamo,
    PLACE_QUERY_MIN_LENGTH
} from '../js/utils/place-recall-index.js';

const rec = (place, date = '2026-08-01') => ({ place, date });

describe('어디서 회상 색인 — 이력에서 먼저 찾는다', () => {
    test('많이 간 곳부터 온다', () => {
        const idx = buildPlaceIndex([rec('스타벅스 강남점'), rec('오토김밥'), rec('오토김밥')]);
        assert.deepEqual(idx.map((i) => i.text), ['오토김밥', '스타벅스 강남점']);
    });

    test('같은 곳의 다른 말은 한 그룹 — 대표는 내가 더 자주 쓴 표기다', () => {
        // 변형 표(place-normalize.js)가 아는 짝만 묶인다: 우리집·자택·홈 → 집
        const idx = buildPlaceIndex([rec('우리집'), rec('우리집'), rec('자택')]);
        assert.equal(idx.length, 1);
        assert.equal(idx[0].text, '우리집');
        assert.equal(idx[0].count, 3);
    });

    test('변형 표에 없는 표기는 따로 선다 — 뭉개면 데이터 오염이다', () => {
        // '우리 집'(띄어쓰기)은 표에 없어 색인에서는 별개 항목이다
        const idx = buildPlaceIndex([rec('우리집'), rec('우리 집')]);
        assert.equal(idx.length, 2);
        // 다만 찾을 때는 띄어쓰기를 무시하므로 둘 다 "이미 친 그 값"이 되어 칩으로 안 나온다
        assert.deepEqual(pickPlaceSuggestions(idx, '우리집'), []);
        // 아직 덜 친 글자에는 둘 다 후보로 걸린다
        assert.equal(pickPlaceSuggestions(idx, '우리').length, 2);
    });

    test('장소가 없는 기록은 무시한다', () => {
        const idx = buildPlaceIndex([rec(''), { date: '2026-08-01' }, null, rec('롯데리아')]);
        assert.deepEqual(idx.map((i) => i.text), ['롯데리아']);
    });

    test('이력이 아니면 빈 색인 — 실패가 입력을 막지 않는다', () => {
        assert.deepEqual(buildPlaceIndex(null), []);
        assert.deepEqual(buildPlaceIndex(undefined), []);
        assert.deepEqual(buildPlaceIndex('오토김밥'), []);
    });
});

describe('어디서 후보 고르기', () => {
    const index = buildPlaceIndex([
        rec('스타벅스 강남점'),
        rec('스타벅스 강남점'),
        rec('이삭토스트'),
        rec('오토김밥'),
        rec('돈대리 돈까스 백반')
    ]);

    test('앞에서 시작하는 것이 먼저다', () => {
        // '토스'는 이삭토스트 안쪽에만 있다 — 머리에서 걸리는 후보가 없으면 그대로 온다
        assert.deepEqual(pickPlaceSuggestions(index, '토스'), ['이삭토스트']);
        assert.deepEqual(pickPlaceSuggestions(index, '이삭'), ['이삭토스트']);
    });

    test('머리 일치가 안쪽 일치보다 앞선다', () => {
        const idx = buildPlaceIndex([rec('김밥천국'), rec('오토김밥'), rec('오토김밥')]);
        // 오토김밥이 더 잦지만 '김밥'으로 시작하는 김밥천국이 먼저 온다
        assert.deepEqual(pickPlaceSuggestions(idx, '김밥'), ['김밥천국', '오토김밥']);
    });

    test('띄어쓰기 차이는 무시한다', () => {
        assert.deepEqual(pickPlaceSuggestions(index, '돈대리돈까스'), ['돈대리 돈까스 백반']);
    });

    test('친 글자와 똑같은 후보는 빼놓는다 — 이미 칸에 적혀 있다', () => {
        assert.deepEqual(pickPlaceSuggestions(index, '오토김밥'), []);
    });

    test(`${PLACE_QUERY_MIN_LENGTH}글자 미만은 후보를 못 좁힌다`, () => {
        assert.deepEqual(pickPlaceSuggestions(index, '스'), []);
        assert.deepEqual(pickPlaceSuggestions(index, ''), []);
        assert.deepEqual(pickPlaceSuggestions(index, '   '), []);
    });

    test('못 찾으면 빈 배열 — 호출부는 이때만 카카오를 부른다', () => {
        assert.deepEqual(pickPlaceSuggestions(index, '한번도안간곳'), []);
    });

    test('상한을 지킨다', () => {
        const many = buildPlaceIndex(
            Array.from({ length: 20 }, (_, i) => rec(`카페${i}호점`))
        );
        assert.equal(pickPlaceSuggestions(many, '카페', 6).length, 6);
        assert.equal(pickPlaceSuggestions(many, '카페', 2).length, 2);
    });

    test('색인이 비어도 죽지 않는다', () => {
        assert.deepEqual(pickPlaceSuggestions([], '스타벅스'), []);
        assert.deepEqual(pickPlaceSuggestions(null, '스타벅스'), []);
    });
});

describe('비교 키', () => {
    test('띄어쓰기·대소문자·가운뎃점을 지운다', () => {
        assert.equal(placeSearchKey('Star Bucks'), placeSearchKey('starbucks'));
        assert.equal(placeSearchKey('오토·김밥'), placeSearchKey('오토김밥'));
    });
});

describe('검색어가 여물었는가 (한글 조합 중 판정)', () => {
    test('자모만 남은 중간 상태는 아직이다', () => {
        assert.equal(hasTrailingJamo('한신포ㅊ'), true);
        assert.equal(hasTrailingJamo('스타벅ㅅ'), true);
        assert.equal(hasTrailingJamo('ㅎ'), true);
        assert.equal(hasTrailingJamo('카페ㅔ'), true);
    });

    test('완성된 음절로 끝나면 검색해도 된다 — 조합이 열려 있어도', () => {
        // 한글은 마지막 음절의 조합이 계속 열려 있다. 여기서 막으면 스페이스를 쳐야 결과가 뜬다
        assert.equal(hasTrailingJamo('한신포차'), false);
        assert.equal(hasTrailingJamo('스타벅스'), false);
    });

    test('한글이 아닌 글자는 언제나 여문 것으로 본다', () => {
        assert.equal(hasTrailingJamo('starbucks'), false);
        assert.equal(hasTrailingJamo('CU 편의점'), false);
        assert.equal(hasTrailingJamo('맥도날드1'), false);
    });

    test('꼬리 공백은 무시한다 — 스페이스를 쳤으면 이미 여문 것이다', () => {
        assert.equal(hasTrailingJamo('한신포차 '), false);
        assert.equal(hasTrailingJamo('한신포ㅊ '), true);
    });

    test('빈 값에서 죽지 않는다', () => {
        assert.equal(hasTrailingJamo(''), false);
        assert.equal(hasTrailingJamo(null), false);
        assert.equal(hasTrailingJamo(undefined), false);
    });
});
