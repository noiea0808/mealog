/**
 * 기록 시트 개편 효과 측정의 계산 규칙.
 *
 * 이 계산은 **틀려도 그럴듯한 숫자가 나온다.** 창을 비대칭으로 자르면 "개편 후 기록이
 * 40% 줄었다" 같은 결론이 멀쩡한 표로 출력되고, 실제로 처음 돌렸을 때 그 함정에 빠졌다
 * (도입 후 4일 vs 도입 전 14일 → 610건 → 220건). 숫자를 눈으로 검산할 수 없으니
 * 규칙 자체를 고정해 둔다.
 *
 * functions/scripts/entry-sheet-effect.js 는 CommonJS 라 default import 로 받는다.
 * 스크립트는 require.main 가드가 있어 import 만으로는 Firestore 에 붙지 않는다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import model from '../functions/scripts/entry-sheet-effect.js';

const {
    kstDateKey,
    addDays,
    dayDiff,
    median,
    symmetricWindows,
    adoptionDateByUser,
    sessionGaps,
    isFilled,
    summarizeWindow,
    pairedComparison,
    meanOver,
    categoryAcceptance,
    MIN_ROWS_PER_WINDOW
} = model;

/** 편의: KST 시각으로 meal 문서 하나 */
const meal = (kstIso, extra = {}) => ({
    // 'YYYY-MM-DDTHH:mm' (KST) → UTC ISO
    recordedAt: new Date(Date.parse(`${kstIso}:00+09:00`)).toISOString(),
    date: kstIso.slice(0, 10),
    ...extra
});

describe('날짜·시각 기본기', () => {
    it('UTC ISO 를 KST 날짜로 옮긴다 — 자정 근처가 하루 밀리지 않게', () => {
        assert.equal(kstDateKey('2026-08-25T15:00:00.000Z'), '2026-08-26'); // KST 00:00
        assert.equal(kstDateKey('2026-08-25T14:59:59.000Z'), '2026-08-25'); // KST 23:59
    });

    it('못 읽는 값은 빈 문자열', () => {
        assert.equal(kstDateKey(''), '');
        assert.equal(kstDateKey('어제'), '');
        assert.equal(kstDateKey(null), '');
    });

    it('날짜 더하기는 월·연 경계를 넘는다', () => {
        assert.equal(addDays('2026-08-31', 1), '2026-09-01');
        assert.equal(addDays('2026-01-01', -1), '2025-12-31');
        assert.equal(addDays('2026-08-26', 0), '2026-08-26');
        assert.equal(addDays('nope', 1), '');
    });

    it('일수 차이', () => {
        assert.equal(dayDiff('2026-08-20', '2026-08-26'), 6);
        assert.equal(dayDiff('2026-08-26', '2026-08-20'), -6);
        assert.ok(Number.isNaN(dayDiff('x', '2026-08-20')));
    });

    it('중앙값 — 짝수는 가운데 둘의 평균, 빈 배열은 null', () => {
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1, 3, 2]), 2.5);
        assert.equal(median([]), null);
        assert.equal(median([null, undefined, NaN]), null);
    });
});

describe('대칭 창 — 비대칭 비교가 만드는 가짜 감소를 막는다', () => {
    it('도입 후 길이만큼 도입 전도 잘라낸다', () => {
        const w = symmetricWindows('2026-08-21', '2026-08-25');
        assert.deepEqual(w, {
            days: 5,
            beforeLo: '2026-08-16',
            beforeHi: '2026-08-20',
            afterLo: '2026-08-21',
            afterHi: '2026-08-25'
        });
    });

    it('전 구간과 후 구간의 길이가 항상 같다', () => {
        for (const end of ['2026-08-23', '2026-08-25', '2026-09-04']) {
            const w = symmetricWindows('2026-08-21', end);
            assert.equal(dayDiff(w.beforeLo, w.beforeHi) + 1, w.days);
            assert.equal(dayDiff(w.afterLo, w.afterHi) + 1, w.days);
        }
    });

    it('두 구간이 겹치지 않는다 — 도입일은 후 구간의 첫날', () => {
        const w = symmetricWindows('2026-08-21', '2026-08-25');
        assert.ok(w.beforeHi < w.afterLo);
        assert.equal(addDays(w.beforeHi, 1), w.afterLo);
    });

    it('창이 너무 짧으면 비교를 포기한다 (요일 하나가 결과를 뒤집는다)', () => {
        assert.equal(symmetricWindows('2026-08-25', '2026-08-26'), null); // 2일
        assert.ok(symmetricWindows('2026-08-24', '2026-08-26')); // 3일
    });
});

describe('도입일 판정', () => {
    it('categorySuggested 가 처음 나온 기록일 — 식사 날짜가 아니라', () => {
        const rows = [
            // 8/26 에 적었지만 식사는 8/07 — 도입일은 8/26 이어야 한다
            meal('2026-08-26T18:34', { date: '2026-08-07', categorySuggested: '밥류' }),
            meal('2026-08-27T09:00', { date: '2026-08-27', categorySuggested: '면류' })
        ];
        const got = adoptionDateByUser(new Map([['u1', rows]]));
        assert.equal(got.get('u1'), '2026-08-26');
    });

    it('필드가 없으면 도입하지 않은 것', () => {
        const rows = [meal('2026-08-26T12:00'), meal('2026-08-25T12:00')];
        assert.equal(adoptionDateByUser(new Map([['u1', rows]])).size, 0);
    });

    it('빈 문자열 제안도 도입으로 친다 — 필드가 생겼다는 것 자체가 새 시트의 증거', () => {
        const rows = [meal('2026-08-22T12:00', { categorySuggested: '' })];
        assert.equal(adoptionDateByUser(new Map([['u1', rows]])).get('u1'), '2026-08-22');
    });

    it('사용자마다 따로 잡는다', () => {
        const got = adoptionDateByUser(
            new Map([
                ['u1', [meal('2026-08-21T12:00', { categorySuggested: 'a' })]],
                ['u2', [meal('2026-08-25T12:00', { categorySuggested: 'b' })]]
            ])
        );
        assert.equal(got.get('u1'), '2026-08-21');
        assert.equal(got.get('u2'), '2026-08-25');
    });
});

describe('연속 입력 간격 — 건당 입력 시간의 대리 지표', () => {
    // 'YYYY-MM-DDTHH:mm[:ss]' (KST) → UTC ISO. 초가 없으면 채워 준다
    const iso = (kst) => {
        const withSec = kst.length === 16 ? `${kst}:00` : kst;
        return new Date(Date.parse(`${withSec}+09:00`)).toISOString();
    };

    it('이어 적은 간격만 센다', () => {
        const gaps = sessionGaps([iso('2026-08-26T18:00'), iso('2026-08-26T18:00:30'), iso('2026-08-26T18:01:10')]);
        assert.deepEqual(gaps, [30, 40]);
    });

    it('10분을 넘으면 다른 세션 — 점심과 저녁이 입력 시간으로 섞이지 않게', () => {
        assert.deepEqual(sessionGaps([iso('2026-08-26T12:00'), iso('2026-08-26T19:00')]), []);
    });

    it('5초 이하는 저장 직후 중복으로 보고 버린다', () => {
        assert.deepEqual(sessionGaps([iso('2026-08-26T18:00'), iso('2026-08-26T18:00:03')]), []);
    });

    it('순서가 뒤섞여 들어와도 정렬해서 잰다', () => {
        const gaps = sessionGaps([iso('2026-08-26T18:01'), iso('2026-08-26T18:00')]);
        assert.deepEqual(gaps, [60]);
    });

    it('한 건뿐이면 간격이 없다', () => {
        assert.deepEqual(sessionGaps([iso('2026-08-26T18:00')]), []);
        assert.deepEqual(sessionGaps([]), []);
    });
});

describe('채움 판정', () => {
    it('빈 배열·빈 문자열·0·공백은 안 채운 것', () => {
        assert.equal(isFilled([]), false);
        assert.equal(isFilled(''), false);
        assert.equal(isFilled('   '), false);
        assert.equal(isFilled(0), false); // rating 0 = 미입력
        assert.equal(isFilled(null), false);
        assert.equal(isFilled(undefined), false);
    });

    it('값이 있으면 채운 것', () => {
        assert.equal(isFilled(['url']), true);
        assert.equal(isFilled('김치찌개'), true);
        assert.equal(isFilled(3), true);
    });
});

describe('구간 요약', () => {
    it('하루 평균의 분모는 창 길이 — 기록한 날 수가 아니다', () => {
        // 5일 창에 3건: 하루 0.6건. '적은 날만' 세면 1.5건으로 부풀어 이탈이 가려진다
        const rows = [meal('2026-08-21T12:00'), meal('2026-08-21T18:00'), meal('2026-08-22T12:00')];
        assert.equal(summarizeWindow(rows, 5).perDay, 0.6);
    });

    it('소급입력 비율 — 기록일과 식사일이 다른 비율', () => {
        const rows = [
            meal('2026-08-26T18:00', { date: '2026-08-26' }),
            meal('2026-08-26T18:30', { date: '2026-08-20' })
        ];
        assert.equal(summarizeWindow(rows, 1).retroRate, 0.5);
    });

    it('빈 구간에서 0으로 나누지 않는다', () => {
        const s = summarizeWindow([], 5);
        assert.equal(s.n, 0);
        assert.equal(s.perDay, 0);
        assert.equal(s.retroRate, 0);
        assert.equal(s.gapMedianSec, null);
    });
});

describe('짝 비교', () => {
    it('도입하지 않은 사용자는 제외되고 이유가 남는다', () => {
        const meals = new Map([['u1', [meal('2026-08-20T12:00')]]]);
        const r = pairedComparison(meals, new Map(), '2026-08-25');
        assert.equal(r.per.length, 0);
        assert.equal(r.skipped.noAdoption, 1);
    });

    it('창이 짧으면 제외', () => {
        const meals = new Map([['u1', [meal('2026-08-25T12:00', { categorySuggested: 'a' })]]]);
        const r = pairedComparison(meals, new Map([['u1', '2026-08-25']]), '2026-08-26');
        assert.equal(r.skipped.windowTooShort, 1);
    });

    it('한쪽 표본이 모자라면 제외 — 한 건짜리 비교로 결론 내지 않는다', () => {
        const rows = [
            ...Array.from({ length: MIN_ROWS_PER_WINDOW }, (_, i) => meal(`2026-08-2${1 + (i % 5)}T12:0${i}`)),
            meal('2026-08-20T12:00') // 전 구간은 1건뿐
        ];
        const r = pairedComparison(new Map([['u1', rows]]), new Map([['u1', '2026-08-21']]), '2026-08-25');
        assert.equal(r.per.length, 0);
        assert.equal(r.skipped.tooFewRows, 1);
    });

    it('양쪽이 충분하면 대칭 창으로 비교한다', () => {
        const before = Array.from({ length: 6 }, (_, i) => meal(`2026-08-1${6 + (i % 4)}T1${i}:00`));
        const after = Array.from({ length: 6 }, (_, i) => meal(`2026-08-2${1 + (i % 4)}T1${i}:00`));
        const r = pairedComparison(new Map([['u1', [...before, ...after]]]), new Map([['u1', '2026-08-21']]), '2026-08-25');
        assert.equal(r.per.length, 1);
        assert.equal(r.per[0].windowDays, 5);
        assert.equal(r.per[0].before.n, 6);
        assert.equal(r.per[0].after.n, 6);
    });

    it('구간 밖의 기록은 어느 쪽에도 안 들어간다', () => {
        const rows = [
            ...Array.from({ length: 5 }, (_, i) => meal(`2026-08-1${6 + (i % 4)}T1${i}:00`)),
            ...Array.from({ length: 5 }, (_, i) => meal(`2026-08-2${1 + (i % 4)}T1${i}:00`)),
            meal('2026-07-01T12:00') // 한참 전 — 제외되어야 한다
        ];
        const r = pairedComparison(new Map([['u1', rows]]), new Map([['u1', '2026-08-21']]), '2026-08-25');
        assert.equal(r.per[0].before.n + r.per[0].after.n, 10);
    });
});

describe('사용자 평균', () => {
    it('사용자마다 한 표 — 많이 적는 사람이 결과를 독식하지 않는다', () => {
        const per = [{ v: 10 }, { v: 2 }];
        assert.equal(meanOver(per, (p) => p.v), 6);
    });

    it('값이 없는 사용자는 평균에서 빠진다', () => {
        assert.equal(meanOver([{ v: 4 }, { v: null }], (p) => p.v), 4);
        assert.equal(meanOver([], (p) => p.v), null);
    });
});

describe('분류 제안 수용/교정', () => {
    it('교정률은 결론까지 간 것 중 사용자가 고친 비율', () => {
        const rows = [
            meal('2026-08-22T12:00', { categorySuggested: 'a', categorySource: 'local' }),
            meal('2026-08-22T12:10', { categorySuggested: 'a', categorySource: 'local' }),
            meal('2026-08-22T12:20', { categorySuggested: 'a', categorySource: 'ai' }),
            meal('2026-08-22T12:30', { categorySuggested: 'a', categorySource: 'user' })
        ];
        const r = categoryAcceptance(new Map([['u1', rows]]));
        assert.equal(r.decided, 4);
        assert.equal(r.correctionRate, 0.25);
    });

    it('거부(dismissed)는 분모에 넣지 않는다 — 분류를 안 하겠다는 뜻이지 오분류가 아니다', () => {
        const rows = [
            meal('2026-08-22T12:00', { categorySuggested: 'a', categorySource: 'user' }),
            meal('2026-08-22T12:10', { categorySuggested: 'a', categorySource: 'dismissed' })
        ];
        const r = categoryAcceptance(new Map([['u1', rows]]));
        assert.equal(r.decided, 1);
        assert.equal(r.correctionRate, 1);
        assert.equal(r.counts.dismissed, 1);
    });

    it('출처가 없으면 none 으로 따로 센다', () => {
        const rows = [meal('2026-08-22T12:00', { categorySuggested: 'a' })];
        const r = categoryAcceptance(new Map([['u1', rows]]));
        assert.equal(r.counts.none, 1);
        assert.equal(r.correctionRate, null);
    });

    it('제안이 없던 기록은 아예 세지 않는다', () => {
        const r = categoryAcceptance(new Map([['u1', [meal('2026-08-01T12:00', { categorySource: 'local' })]]]));
        assert.equal(r.decided, 0);
    });
});
