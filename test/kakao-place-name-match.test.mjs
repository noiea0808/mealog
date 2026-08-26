// 카카오 장소 검색: 상호명이 맞는 가게를 위로
//
// 카카오 로컬 API 는 업종·메뉴 분류까지 매칭해서, 「돈까스」로 찾으면 카테고리가
// `돈까스,우동` 인 가게가 전부 걸린다(실측 15건 중 상호명 일치는 3건).
// 여기서 검증하는 것은 두 가지다: 상호명 일치가 위로 오는가, 그리고 **거르지는 않는가**.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePlaceSearchText,
    kakaoPlaceNameMatchScore,
    sortKakaoPlacesByNameMatch
} from '../js/utils/place-type.js';

/** 실측(2026-08-26) 응답에서 상호명만 추린 것 — 순서도 카카오가 준 그대로 */
const REAL_RESULT = [
    '정돈',
    '모스키친',
    '연돈',
    '동경우동',
    '행운돈까스',
    '한성돈까스',
    '중앙모밀',
    '일월카츠 계동점',
    '호돈돈가스',
    '1982성북동왕돈까스'
].map((place_name) => ({ place_name }));

test('된소리와 예사소리를 같은 것으로 본다', () => {
    assert.equal(normalizePlaceSearchText('돈까스'), normalizePlaceSearchText('돈가스'));
    assert.equal(normalizePlaceSearchText('짜장'), normalizePlaceSearchText('자장'));
    assert.equal(normalizePlaceSearchText('빵집'), normalizePlaceSearchText('방집'));
});

test('띄어쓰기·구분기호·대소문자를 지운다', () => {
    assert.equal(normalizePlaceSearchText(' 스타 벅스 '), normalizePlaceSearchText('스타벅스'));
    assert.equal(normalizePlaceSearchText('B.H.C'), normalizePlaceSearchText('bhc'));
    assert.equal(normalizePlaceSearchText('맘스터치(강남)'), normalizePlaceSearchText('맘스터치강남'));
});

test('상호명에 통째로 들어가면 2점, 낱말만 들어가면 1점', () => {
    assert.equal(kakaoPlaceNameMatchScore('행운돈까스', '돈까스'), 2);
    assert.equal(kakaoPlaceNameMatchScore('행운돈까스', '강남 돈까스'), 1);
    assert.equal(kakaoPlaceNameMatchScore('정돈', '돈까스'), 0);
});

test('표기가 달라도 상호명 일치로 친다 — 호돈돈가스 ↔ 돈까스', () => {
    assert.equal(kakaoPlaceNameMatchScore('호돈돈가스', '돈까스'), 2);
});

test('한 글자 낱말은 아무 데나 걸리므로 점수를 주지 않는다', () => {
    // 「집 돈까스」의 '집' 하나로 「밥집」이 올라오면 안 된다
    assert.equal(kakaoPlaceNameMatchScore('밥집', '집 돈까스'), 0);
});

test('빈 값에는 점수를 주지 않는다', () => {
    assert.equal(kakaoPlaceNameMatchScore('', '돈까스'), 0);
    assert.equal(kakaoPlaceNameMatchScore('행운돈까스', ''), 0);
    assert.equal(kakaoPlaceNameMatchScore(undefined, undefined), 0);
});

test('실측 결과에서 상호명이 맞는 가게가 맨 위로 온다', () => {
    const sorted = sortKakaoPlacesByNameMatch(REAL_RESULT, '돈까스').map((p) => p.place_name);
    // 상호명 일치 4곳(호돈돈가스 포함)이 앞자리를 차지해야 한다
    assert.deepEqual(sorted.slice(0, 4), ['행운돈까스', '한성돈까스', '호돈돈가스', '1982성북동왕돈까스']);
    // 그리고 카카오 순서를 지킨다 — 행운(5번)이 한성(6번)보다 앞
    assert.ok(sorted.indexOf('행운돈까스') < sorted.indexOf('한성돈까스'));
});

test('상호명이 안 맞아도 버리지 않는다 — 업종으로 찾는 경우가 있다', () => {
    const sorted = sortKakaoPlacesByNameMatch(REAL_RESULT, '돈까스');
    assert.equal(sorted.length, REAL_RESULT.length, '결과가 줄었다');
    assert.ok(sorted.some((p) => p.place_name === '정돈'), '정돈이 사라졌다');
});

test('같은 점수끼리는 카카오가 준 순서를 흐트러뜨리지 않는다', () => {
    const sorted = sortKakaoPlacesByNameMatch(REAL_RESULT, '돈까스').map((p) => p.place_name);
    const tail = sorted.slice(4);
    assert.deepEqual(tail, ['정돈', '모스키친', '연돈', '동경우동', '중앙모밀', '일월카츠 계동점']);
});

test('빈 목록·잘못된 입력에도 죽지 않는다', () => {
    assert.deepEqual(sortKakaoPlacesByNameMatch([], '돈까스'), []);
    assert.deepEqual(sortKakaoPlacesByNameMatch(null, '돈까스'), []);
    assert.equal(sortKakaoPlacesByNameMatch([{ place_name: '가게' }], '').length, 1);
});
