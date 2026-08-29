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
    buildAxisBreakdown,
    AXIS_CHART_SLOTS,
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

/* ── 선택지 분포와 입력 경로 ─────────────────────────────────────
 * 이 표가 답해야 하는 것은 셋이다: 안 골라지는 칩이 있나 · 「기타」가 여전히 큰가 ·
 * 늘어난 입력이 사람의 것인가 기계의 것인가. 셋 다 세는 규칙이 한 칸 어긋나도
 * 표는 멀쩡해 보인다 — 특히 「자동」은 값만 보면 직접 입력과 구별이 안 된다.
 */

/** 축별 태그 목록(관리자 화면이 편집하는 것과 같은 모양) */
const TAGS = {
    mealType: ['집밥', '외식', '기타'],
    withWhom: ['혼자', '가족', '기타'],
    category: ['밥류', '면류', '기타'],
    subTagsPlaceSnack: ['집', '사무실', '카페']
};

const byKey = (breakdown, key) => breakdown.find((a) => a.key === key);
const row = (axis, label) => axis.rows.find((r) => r.label === label);

test('자동 적용된 값은 「자동」으로, 사용자가 고른 값은 「직접」으로 갈린다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', mealType: '집밥', withWhom: '가족' },
        // 같은 값이지만 맥락 예측이 넣은 것 — 값만 보면 위와 구별되지 않는다
        { userId: 'u1', date: '2026-08-10', mealType: '집밥', withWhom: '가족', autoContext: ['mealType'] }
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);

    const how = byKey(b, 'how');
    assert.equal(how.filled, 2);
    assert.equal(how.direct, 1);
    assert.equal(how.auto, 1);
    assert.deepEqual(
        { n: row(how, '집밥').n, direct: row(how, '집밥').direct, auto: row(how, '집밥').auto },
        { n: 2, direct: 1, auto: 1 }
    );

    // autoContext 에 없는 축은 같은 기록이어도 직접이다
    const who = byKey(b, 'withWhom');
    assert.equal(who.direct, 2, 'withWhom 은 자동 목록에 없으므로 둘 다 직접');
    assert.equal(who.auto, 0);
});

test('아무도 안 고른 칩은 건수 0으로 남는다 — 목록에서 사라지지 않는다', () => {
    const rows = [{ userId: 'u1', date: '2026-08-10', mealType: '집밥' }];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const how = byKey(b, 'how');
    assert.deepEqual(how.rows.map((r) => [r.label, r.n]), [['집밥', 1], ['외식', 0], ['기타', 0]]);
    assert.deepEqual(how.rows.map((r) => r.label), TAGS.mealType, '행 순서는 관리자 목록 순서 그대로');
});

test('목록에 없는 값은 「목록 밖」으로 모이고 많은 순으로 예시가 붙는다', () => {
    const mk = (mealType) => ({ userId: 'u1', date: '2026-08-10', mealType });
    const rows = [mk('한식'), mk('한식'), mk('양식'), mk('집밥')];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const how = byKey(b, 'how');
    assert.equal(how.outside.n, 3);
    assert.equal(how.outside.distinct, 2);
    assert.deepEqual(how.outside.samples.map((s) => [s.label, s.n]), [['한식', 2], ['양식', 1]]);
    assert.equal(how.outside.rate, 75);
});

test('태그 목록을 못 읽으면 전부 목록 밖으로 떨어진다 — 그 사실을 표시로 남긴다', () => {
    const rows = [{ userId: 'u1', date: '2026-08-10', mealType: '집밥' }];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), {});
    const how = byKey(b, 'how');
    assert.equal(how.tagListMissing, true);
    assert.equal(how.rows.length, 0);
    assert.equal(how.outside.n, 1, '값은 사라지지 않고 목록 밖에 남는다');
});

test('「무엇을」 분포는 최종 값 축이다 — 자동 분류가 채운 값도 그 칩에 선다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', category: '밥류', categorySource: 'user' },
        { userId: 'u1', date: '2026-08-10', categoryAuto: '면류', categorySource: 'local' },
        { userId: 'u1', date: '2026-08-10', categoryAuto: '면류', categorySource: 'ai' },
        { userId: 'u1', date: '2026-08-10', category: '기타', categorySource: 'user' }
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const what = byKey(b, 'what');
    // 많은 순으로 선다. 동점이면 목록 순서가 순서를 잡는다(밥류가 기타보다 앞)
    assert.deepEqual(what.rows.map((r) => [r.label, r.n, r.direct, r.auto]), [
        ['면류', 2, 0, 2],
        ['밥류', 1, 1, 0],
        ['기타', 1, 1, 0]
    ]);
    assert.equal(what.direct, 2);
    assert.equal(what.auto, 2);
    assert.equal(what.empty, 0);
});

test('「무엇을」의 미입력은 거부·대기·상세없음으로 갈린다 — 손댈 곳이 다르다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', categorySource: 'dismissed' },
        { userId: 'u1', date: '2026-08-10', menuDetail: '김치찌개' },
        { userId: 'u1', date: '2026-08-10' }
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const what = byKey(b, 'what');
    assert.equal(what.empty, 3);
    assert.deepEqual(what.emptyPaths.map((p) => p.n), [1, 1, 1]);
    assert.equal(byKey(b, 'how').emptyPaths, null, '다른 축은 미입력을 가르지 않는다');
});

test('「어디서」는 간식 칩과 끼니 자유 입력을 한 축에서 센다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', snackPlaceMain: '카페' },
        { userId: 'u1', date: '2026-08-10', place: '김밥천국' },
        // 예측이 자동 적용한 place — 입력란은 건드리지 않고 저장 때만 들어온다
        { userId: 'u1', date: '2026-08-10', place: '집', autoContext: ['place'] },
        { userId: 'u1', date: '2026-08-10' }
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const where = byKey(b, 'where');
    assert.equal(where.freeText, true);
    assert.equal(where.filled, 3);
    assert.equal(where.auto, 1);
    assert.equal(where.empty, 1);
    assert.equal(row(where, '카페').n, 1);
    assert.equal(row(where, '집').auto, 1, '자동 적용값도 목록 칩에 선다');
    assert.equal(where.outside.n, 1, '가게 이름은 목록 밖');
});

test('「무엇을 · 종류」는 형태와 다른 절단면이다 — 옛 요리 종류 값이 여기서 제자리를 찾는다', () => {
    const mk = (o) => Object.assign({ userId: 'u1', date: '2026-08-10' }, o);
    const rows = [
        mk({ category: '밥류', categorySource: 'user', cuisineAuto: '한식' }),
        mk({ categoryAuto: '면류', categorySource: 'local', cuisineAuto: '중식' }),
        // 옛 기록: 사용자가 「무엇을」에 요리 종류를 골랐다. 형태 축에서는 목록 밖이다
        mk({ category: '양식', categorySource: 'user' }),
        mk({}) // 어느 축으로도 값이 없다
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const form = byKey(b, 'what');
    const cuisine = byKey(b, 'cuisine');

    assert.equal(form.label, '무엇을 · 형태');
    assert.equal(form.outside.n, 1, '「양식」은 형태 축의 목록 밖');
    assert.deepEqual(form.outside.samples.map((x) => x.label), ['양식']);

    assert.equal(cuisine.label, '무엇을 · 종류');
    assert.equal(cuisine.tagListMissing, false, '관리자 목록이 없어도 사전이 목록을 준다');
    assert.equal(cuisine.filled, 3, '「양식」이 여기서는 값으로 선다');
    assert.deepEqual(
        cuisine.rows.filter((r) => r.n > 0).map((r) => r.label).sort(),
        ['양식', '중식', '한식']
    );
    assert.equal(cuisine.outside.n, 0, '사전 어휘라 목록 밖이 없다');
    assert.equal(cuisine.noSourceSplit, true, '묻지 않는 축이라 직접/자동을 가르지 않는다');
});

test('추이의 자동적용 열은 축을 하나라도 자동으로 채운 기록만 센다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', mealType: '집밥', autoContext: ['mealType', 'place'] },
        { userId: 'u1', date: '2026-08-10', mealType: '집밥', autoContext: [] },
        { userId: 'u1', date: '2026-08-10', mealType: '집밥' }
    ];
    const r = analyzeMomentRows(rows, '2026-08-10', '2026-08-10');
    assert.equal(r.autoContextRows, 1, '빈 배열은 자동 적용이 아니다');
    assert.equal(r.overall.counts.autoContext, 1);
    assert.equal(r.trend[0].counts.autoContext, 1, '구간 카운터도 같이 센다');
});

test('축 비율의 분모는 전체 기록 수다 — 입력된 것만이 아니다', () => {
    const rows = [
        { userId: 'u1', date: '2026-08-10', mealType: '집밥' },
        { userId: 'u1', date: '2026-08-10' },
        { userId: 'u1', date: '2026-08-10' },
        { userId: 'u1', date: '2026-08-10' }
    ];
    const b = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS);
    const how = byKey(b, 'how');
    assert.equal(row(how, '집밥').rate, 25);
    assert.equal(how.filledRate, 25);
    assert.equal(how.autoShare, 0, '자동 비중의 분모는 입력된 건수다');
});

/* ── 누적 바의 재료 ───────────────────────────────────────────
 * 막대는 「길이가 곧 비율」이라는 전제 위에 서 있다. 몫의 합이 100%가 아니거나
 * 색이 기간마다 옮겨 다니면 그림은 여전히 그럴듯하게 그려지면서 거짓말을 한다.
 */

const chartOf = (rows, tags, key) =>
    buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), tags).find((a) => a.key === key).chart;

test('막대의 몫은 빠짐없이 100%가 된다 — 칸·그 외·목록 밖·미입력', () => {
    const mk = (o) => Object.assign({ userId: 'u1', date: '2026-08-10' }, o);
    const rows = [
        mk({ mealType: '집밥' }),
        mk({ mealType: '외식' }),
        mk({ mealType: '한식' }), // 목록 밖
        mk({}) // 미입력
    ];
    const c = chartOf(rows, TAGS, 'how');
    const sum =
        c.segments.reduce((a, s) => a + s.rate, 0) + c.folded.rate + c.outside.rate + c.empty.rate;
    assert.ok(Math.abs(sum - 100) < 1e-9, `몫의 합이 ${sum}`);
});

test('행은 많은 순으로 서고 색 슬롯도 그 순위를 따른다', () => {
    const mk = (mealType, times) => Array.from({ length: times }, () => ({ userId: 'u1', date: '2026-08-10', mealType }));
    const axisOf = (rows) =>
        buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS).find((a) => a.key === 'how');

    // 목록 순서는 집밥 → 외식 → 기타. 건수가 뒤집히면 순서도 뒤집힌다
    const a1 = axisOf([...mk('집밥', 1), ...mk('외식', 50)]);
    assert.deepEqual(a1.rows.map((r) => [r.label, r.slot]), [['외식', 0], ['집밥', 1], ['기타', null]]);

    const a2 = axisOf([...mk('집밥', 50), ...mk('외식', 1)]);
    assert.deepEqual(a2.rows.map((r) => [r.label, r.slot]), [['집밥', 0], ['외식', 1], ['기타', null]]);

    // 막대의 칸 순서도 같다 — 범례가 이 순서를 그대로 따라간다
    assert.deepEqual(a1.chart.segments.map((s) => s.label), ['외식', '집밥']);
});

test('동점이면 관리자 목록 순서가 순서를 잡는다 — 실행마다 흔들리지 않게', () => {
    const mk = (mealType) => ({ userId: 'u1', date: '2026-08-10', mealType });
    const axis = buildAxisBreakdown(
        analyzeMomentRows([mk('기타'), mk('외식'), mk('집밥')], '2026-08-10', '2026-08-10'),
        TAGS
    ).find((a) => a.key === 'how');
    assert.deepEqual(axis.rows.map((r) => r.label), ['집밥', '외식', '기타']);
});

test('슬롯을 넘는 선택지는 「그 외」로 접히지만 표에는 그대로 남는다', () => {
    const list = Array.from({ length: 11 }, (_, i) => `t${i}`);
    // 건수를 계단으로 줘서 순위가 목록 순서와 같아지게 한다
    const rows = list.flatMap((t, i) => Array.from({ length: 11 - i }, () => ({ userId: 'u1', date: '2026-08-10', mealType: t })));
    const axis = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), { mealType: list }).find(
        (a) => a.key === 'how'
    );
    assert.equal(axis.chart.segments.length, AXIS_CHART_SLOTS, '칸은 슬롯 수까지만');
    assert.deepEqual(axis.chart.segments.map((s) => s.slot), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(axis.chart.folded.distinct, 3, '나머지 셋이 접힌다');
    assert.equal(axis.chart.folded.n, 3 + 2 + 1, '접힌 것들의 건수 합');
    assert.equal(axis.rows.length, 11, '표는 열한 줄 전부 들고 있다');
    assert.equal(axis.rows[8].slot, null, '접힌 행은 슬롯이 없다');
});

test('막대의 목록 밖 몫은 종 수와 예시를 함께 들고 있다 — 범례가 그걸로 이름을 댄다', () => {
    const mk = (mealType) => ({ userId: 'u1', date: '2026-08-10', mealType });
    const rows = [mk('한식'), mk('한식'), mk('양식'), mk('집밥')];
    const c = chartOf(rows, TAGS, 'how');
    assert.equal(c.outside.n, 3);
    assert.equal(c.outside.distinct, 2);
    assert.deepEqual(c.outside.samples.map((x) => [x.label, x.n, x.rate]), [['한식', 2, 50], ['양식', 1, 25]]);
});

test('「무엇을」은 표기만 달랐던 옛 형태 축 값을 제 칩으로 되돌린다', () => {
    const mk = (o) => Object.assign({ userId: 'u1', date: '2026-08-10' }, o);
    const rows = [
        mk({ category: '밥/한상', categorySource: 'user' }), // 옛 형태 축 표기
        mk({ categoryAuto: '베이커리', categorySource: 'ai' }), // 옛 간식 축 표기
        mk({ category: '한식', categorySource: 'user' }) // 옛 요리 종류 축 — 대응이 없다
    ];
    const tags = { ...TAGS, category: ['밥류', '베이커리/떡', '면류'] };
    const axis = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), tags).find(
        (a) => a.key === 'what'
    );
    const at = (label) => axis.rows.find((r) => r.label === label);
    assert.equal(at('밥류').n, 1, '「밥/한상」은 「밥류」다');
    assert.equal(at('베이커리/떡').n, 1, '「베이커리」는 「베이커리/떡」이다');
    assert.equal(at('베이커리/떡').auto, 1, '자동 분류였다는 사실은 그대로');
    assert.equal(axis.outside.n, 1, '「한식」만 목록 밖에 남는다');
    assert.deepEqual(axis.outside.samples.map((s) => s.label), ['한식']);
});

test('건수 0인 선택지는 칸도 슬롯도 없이 뒤로 밀린다 — 범례에는 남는다', () => {
    const rows = [{ userId: 'u1', date: '2026-08-10', mealType: '기타' }];
    const axis = buildAxisBreakdown(analyzeMomentRows(rows, '2026-08-10', '2026-08-10'), TAGS).find(
        (a) => a.key === 'how'
    );
    assert.deepEqual(axis.chart.segments.map((s) => s.label), ['기타'], '값이 있는 것만 칸이 된다');
    assert.equal(axis.chart.segments[0].slot, 0, '유일한 값이라 첫 색');
    assert.deepEqual(axis.rows.map((r) => [r.label, r.slot]), [
        ['기타', 0],
        ['집밥', null],
        ['외식', null]
    ]);
});
