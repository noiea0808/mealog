// 모먼트 분석: 항목별 입력률 계산
//
// 이 숫자들은 틀려도 표가 멀쩡해 보인다 — 「어디서」를 한 필드만 보고 세면 간식 기록이
// 통째로 미입력으로 떨어지고, 주 경계가 한 칸 밀리면 추이가 조용히 어긋난다.
// 화면으로는 그 차이를 알 수 없어서 여기서 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MOMENT_FIELD_SPECS,
    CORE_FIELD_SPECS,
    FOOD_PATH_SPECS,
    analyzeMomentRows,
    foodClassifyPath,
    daysBetweenYmd,
    shiftYmd,
    sundayKeyOfYmd,
    weekLabelOfSundayKey,
    hasNumericValue,
    hasPhoto
} from '../js/admin/moment-analytics-model.js';

const specByKey = (key) => MOMENT_FIELD_SPECS.find((f) => f.key === key);
const filled = (key, meal) => specByKey(key).filled(meal);

test('핵심 항목은 사용자가 화면에서 채우는 8개다', () => {
    assert.deepEqual(
        CORE_FIELD_SPECS.map((f) => f.key),
        ['how', 'where', 'what', 'withWhom', 'rating', 'satiety', 'photo', 'comment']
    );
});

test('「어디서」는 끼니(place)와 간식(snackPlaceMain) 어느 쪽으로 저장돼도 입력으로 센다', () => {
    assert.equal(filled('where', { place: '회사' }), true);
    assert.equal(filled('where', { snackPlaceMain: '집' }), true);
    assert.equal(filled('where', { snackPlace: '카페' }), true);
    assert.equal(filled('where', { place: '   ' }), false, '공백만 있는 값은 미입력이다');
    assert.equal(filled('where', {}), false);
});

test('「무엇을」은 사용자가 확정한 값만 세고, 자동분류는 최종 도달 행에서만 합쳐진다', () => {
    const userPicked = { category: '밥류', categoryAuto: '면류', categorySource: 'user' };
    const autoOnly = { categoryAuto: '면류', categorySource: 'ai' };
    assert.equal(filled('what', userPicked), true);
    assert.equal(filled('what', autoOnly), false, 'categoryAuto는 사람이 채운 값이 아니다');
    assert.equal(filled('whatFinal', autoOnly), true, '자동으로라도 값이 남았으면 최종 도달');
    assert.equal(filled('whatFinal', userPicked), true);
    assert.equal(filled('whatFinal', { menuDetail: '김치찌개' }), false, '상세만으로는 분류된 것이 아니다');
    assert.equal(filled('what', { snackType: '과자/스낵' }), true, '간식은 snackType으로 저장된다');
});

test('「무엇을」 경로는 저장 규칙대로 한 칸에만 떨어진다', () => {
    // 저장 규칙: 사용자 확정만 category/snackType, 자동 분류는 categoryAuto + source
    assert.equal(foodClassifyPath({ category: '밥류', categorySource: 'user' }), 'user');
    assert.equal(foodClassifyPath({ snackType: '커피', categorySource: 'user' }), 'user');
    assert.equal(
        foodClassifyPath({ category: '기타' }),
        'userEtc',
        '「기타」는 서버가 미분류로 보고 다시 집는 값이라 직접 선택과 가른다'
    );
    assert.equal(foodClassifyPath({ categoryAuto: '면류', categorySource: 'local' }), 'local');
    assert.equal(foodClassifyPath({ categoryAuto: '면류', categorySource: 'ai' }), 'ai');
    assert.equal(
        foodClassifyPath({ categoryAuto: '면류' }),
        'autoUnknown',
        'source 없이 값만 있는 옛 기록'
    );
    assert.equal(foodClassifyPath({ categorySource: 'dismissed', menuDetail: '김밥' }), 'dismissed');
    assert.equal(
        foodClassifyPath({ menuDetail: '김밥' }),
        'pending',
        '상세가 있고 아무도 안 집었으면 서버 배치 대기'
    );
    assert.equal(
        foodClassifyPath({ categorySource: 'ai' }),
        'noDetail',
        'source=ai 인데 값이 없으면 모델이 미분류로 종결한 것 — 다시 대기로 세지 않는다'
    );
    assert.equal(foodClassifyPath({}), 'noDetail', '상세 텍스트가 없으면 서버도 집을 수 없다');
});

test('경로는 서로 배타적이라 합이 전체 기록 수와 같다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', category: '밥류', categorySource: 'user' },
        { userId: 'u1', date: '2026-08-10', category: '기타' },
        { userId: 'u1', date: '2026-08-10', categoryAuto: '면류', categorySource: 'local' },
        { userId: 'u1', date: '2026-08-10', categoryAuto: '커피', categorySource: 'ai' },
        { userId: 'u1', date: '2026-08-10', categoryAuto: '빵류' },
        { userId: 'u1', date: '2026-08-10', categorySource: 'dismissed', menuDetail: '김밥' },
        { userId: 'u1', date: '2026-08-10', menuDetail: '라면' },
        { userId: 'u1', date: '2026-08-10' }
    ];
    const r = analyzeMomentRows(rows, '2026-08-10', '2026-08-10');
    const sum = FOOD_PATH_SPECS.reduce((acc, p) => acc + r.overall.counts[p.key], 0);
    assert.equal(sum, rows.length, '모든 기록이 정확히 한 경로에만 들어간다');
    FOOD_PATH_SPECS.forEach((p) => {
        assert.equal(r.overall.counts[p.key], 1, `${p.label}에 1건`);
    });

    // 최종 도달 = 사용자확정 + 기타 + local + ai + autoUnknown = 5
    assert.equal(r.overall.counts.whatFinal, 5);
    // 사용자 확정률(what)은 그중 2건뿐 — 이 둘이 갈려야 시트 개편의 영향을 읽을 수 있다
    assert.equal(r.overall.counts.what, 2);
});

test('만족도·포만감은 0도 값이다 — 미입력은 없거나 빈 값일 때뿐', () => {
    assert.equal(hasNumericValue(0), true);
    assert.equal(hasNumericValue(''), false);
    assert.equal(hasNumericValue(null), false);
    assert.equal(hasNumericValue(undefined), false);
    assert.equal(filled('rating', { rating: 0 }), true);
    assert.equal(filled('rating', { snackRating: 3 }), true);
    assert.equal(filled('satiety', { satiety: 0 }), true);
    assert.equal(filled('satiety', {}), false);
});

test('사진은 배열·단일 URL 어느 쪽이든 세고, 빈 배열은 미입력이다', () => {
    assert.equal(hasPhoto({ photos: ['https://x/1.jpg'] }), true);
    assert.equal(hasPhoto({ photoUrl: 'https://x/1.jpg' }), true);
    assert.equal(hasPhoto({ photos: [] }), false);
    assert.equal(hasPhoto({ photos: ['', '  '] }), false, '빈 문자열만 든 배열은 사진이 아니다');
    assert.equal(hasPhoto({}), false);
});

test('입력률 분자·분모와 완성도 히스토그램이 맞아떨어진다', () => {
    const rows = [
        // 핵심 8개를 모두 채운 기록
        {
            userId: 'u1',
            date: '2026-08-10',
            mealType: '외식',
            place: '회사',
            category: '한식',
            withWhom: '동료',
            rating: 4,
            satiety: 3,
            photos: ['https://x/1.jpg'],
            comment: '맛있었다'
        },
        // 「어떻게」만 채운 기록
        { userId: 'u2', date: '2026-08-10', mealType: '집밥' },
        // 아무것도 없는 기록
        { userId: 'u2', date: '2026-08-11' }
    ];
    const r = analyzeMomentRows(rows, '2026-08-10', '2026-08-11');

    assert.equal(r.overall.total, 3);
    assert.equal(r.userCount, 2, '같은 사용자의 두 기록은 한 명으로 센다');
    assert.equal(r.overall.counts.how, 2);
    assert.equal(r.overall.counts.comment, 1);
    assert.equal(r.overall.counts.where, 1);

    // 완성도: 8개 채운 기록 1건, 1개 1건, 0개 1건
    assert.equal(r.completeness.length, CORE_FIELD_SPECS.length + 1);
    assert.equal(r.completeness[8], 1);
    assert.equal(r.completeness[1], 1);
    assert.equal(r.completeness[0], 1);
    assert.equal(
        r.completeness.reduce((a, b) => a + b, 0),
        3,
        '모든 기록이 히스토그램 어딘가에 정확히 한 번 들어간다'
    );

    // 평균 완성도 = 채워진 핵심 칸 / (기록 수 × 8) = 9 / 24
    assert.equal(Math.round(r.avgCompleteness * 1000) / 1000, Math.round((9 / 24) * 1000) / 1000);
});

test('31일 이하는 일별로, 넘으면 주별로 끊는다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10' },
        { userId: 'u1', date: '2026-08-11' }
    ];
    const daily = analyzeMomentRows(rows, '2026-08-01', '2026-08-31');
    assert.equal(daily.byWeek, false);
    assert.deepEqual(daily.trend.map((b) => b.key), ['2026-08-10', '2026-08-11']);

    const weekly = analyzeMomentRows(rows, '2026-07-01', '2026-08-31');
    assert.equal(weekly.byWeek, true);
    // 2026-08-10(월)과 08-11(화)는 같은 주 — 일요일 08-09로 묶인다
    assert.deepEqual(weekly.trend.map((b) => b.key), ['2026-08-09']);
    assert.equal(weekly.trend[0].total, 2);
});

test('주 경계는 일요일에서 끊는다', () => {
    assert.equal(sundayKeyOfYmd('2026-08-09'), '2026-08-09', '일요일은 자기 자신이 주 시작');
    assert.equal(sundayKeyOfYmd('2026-08-15'), '2026-08-09', '토요일은 앞선 일요일에 붙는다');
    assert.equal(sundayKeyOfYmd('2026-08-16'), '2026-08-16', '다음 일요일부터 새 주');
    assert.equal(weekLabelOfSundayKey('2026-08-09'), '2주\n8/9~8/15');
});

test('기간 계산은 시작·종료일을 모두 포함하고 월을 넘겨도 맞는다', () => {
    assert.equal(daysBetweenYmd('2026-08-01', '2026-08-01'), 1);
    assert.equal(daysBetweenYmd('2026-08-01', '2026-08-31'), 31);
    assert.equal(daysBetweenYmd('2026-07-30', '2026-08-02'), 4);
    assert.equal(shiftYmd('2026-08-01', -1), '2026-07-31');
    assert.equal(shiftYmd('2026-08-28', -29), '2026-07-30', '최근 30일은 오늘을 포함해 29일 전부터');
});

test('기록이 없으면 0으로 나누지 않는다', () => {
    const r = analyzeMomentRows([], '2026-08-01', '2026-08-07');
    assert.equal(r.overall.total, 0);
    assert.equal(r.avgCompleteness, 0);
    assert.deepEqual(r.trend, []);
});
