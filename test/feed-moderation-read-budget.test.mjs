/**
 * 모먼트 관리 새로고침의 읽기 예산 — 「결과를 안 바꾸는 조회」 회귀 방지.
 *
 * 배경 (2026-08-27): 새로고침 한 번이 20행을 그리려고 4,000건 가까이 읽고 있었다.
 * 캐시를 전부 비우는 경로라 매번 제값을 다 냈다. 그중 셋은 결과를 하나도 바꾸지 않았다.
 *
 *   1. 특수 공유 「보강」 3회 — orderBy('timestamp') 쿼리가 성공했든 말든 타입당 400건씩
 *      더 읽었다. 받아 온 것 대부분은 byId 에서 중복으로 버려졌다. 최대 1,200건.
 *   2. 하루기록 미러 존재 재확인 — collectionGroup(meals) 로 방금 읽은 문서를 한 건씩
 *      getDoc 으로 다시 읽어 「있네」를 확인하고, 있으니까 목록에서 뺐다. 최대 800건.
 *   3. 특수 공유를 페이지와 무관하게 늘 500건 받았다. 한 페이지는 20행이다.
 *
 * 여기서 지키는 계약:
 *   - 미러에서 온 행은 다시 읽지 않는다.
 *   - 보강은 「빠진 문서가 있다」가 확인됐을 때만 돈다.
 *   - 특수 공유는 그 페이지가 필요한 만큼만 받는다.
 *
 * feed-moderation.js 는 Firestore SDK 를 import 하는 브라우저 모듈이라 여기서 실행할 수
 * 없다. 그래서 소스에서 해당 조각을 떼어 검사한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/admin/feed-moderation.js', import.meta.url), 'utf8');

/** 함수 본문 정규식은 리터럴로 둔다 (템플릿 리터럴로 조립하면 백슬래시가 한 번 풀린다) */
const MIRROR_FILTER = /async function filterDailyJournalRowsWithoutMealMirror\([\s\S]*?\n\}/;
const SPECIAL_FETCH = /async function fetchSpecialSharesForModeration\([\s\S]*?\n\}/;

describe('모먼트 관리 읽기 예산 (2026-08-27)', () => {
    describe('하루기록 미러를 다시 읽지 않는다', () => {
        it('미러에서 온 행은 getDoc 없이 판정한다', () => {
            const block = MIRROR_FILTER.exec(src);
            assert.ok(block, 'filterDailyJournalRowsWithoutMealMirror 를 찾지 못했습니다');
            assert.match(
                block[0],
                /isDailyJournalSlot === true && String\(r\.id \|\| ''\) === mealId/,
                '미러에서 온 행을 걸러내지 않고 전부 getDoc 합니다 — 방금 읽은 문서를 다시 읽습니다'
            );
        });

        it('그래도 getDoc 자체는 남아 있다 — 미러 없는 공유 전용 행은 확인해야 한다', () => {
            const block = MIRROR_FILTER.exec(src);
            assert.match(
                block[0],
                /getDoc\(/,
                '존재 확인을 통째로 없애면 미러 없는 하루기록이 목록에서 사라집니다'
            );
        });
    });

    describe('특수 공유 보강은 조건부다', () => {
        it('보강 루프가 조건 없이 돌지 않는다', () => {
            const block = SPECIAL_FETCH.exec(src);
            assert.ok(block, 'fetchSpecialSharesForModeration 을 찾지 못했습니다');
            assert.match(
                block[0],
                /if \(await specialSharesHaveDocsWithoutTimestamp\(\)\) \{[\s\S]*?for \(const ty of ADMIN_FEED_SPECIAL_SHARE_TYPES\)/,
                '보강 3회가 무조건 돕니다 — 새로고침마다 최대 1,200건이 헛돕니다'
            );
        });

        /**
         * 판단을 「받아 온 행 수」로 하면 안 된다. 상한을 페이지 크기로 줄이는 순간
         * 늘 모자라 보여서 보강이 항상 도는 쪽으로 되돌아간다.
         */
        it('판단 근거는 행 수가 아니라 건수(getCountFromServer)다', () => {
            const fn = /async function specialSharesHaveDocsWithoutTimestamp\(\)[\s\S]*?\n\}/.exec(src);
            assert.ok(fn, 'specialSharesHaveDocsWithoutTimestamp 를 찾지 못했습니다');
            assert.match(fn[0], /getCountFromServer\(/, '건수 집계를 쓰지 않습니다');
            assert.match(
                fn[0],
                /orderBy\('timestamp', 'desc'\)/,
                "orderBy 를 통과하는 건수를 세지 않으면 「빠진 문서」를 가릴 수 없습니다"
            );
        });

        it('확인이 실패하면 보강을 도는 쪽으로 답한다 — 모를 때 목록이 비면 안 된다', () => {
            const fn = /async function specialSharesHaveDocsWithoutTimestamp\(\)[\s\S]*?\n\}/.exec(src);
            assert.match(fn[0], /catch \(e\) \{[\s\S]*?result = true;/, '실패 시 false 로 답하면 문서가 조용히 사라집니다');
        });
    });

    describe('특수 공유는 그 페이지가 필요한 만큼만 받는다', () => {
        it('기본 쿼리 limit 이 고정 상한이 아니라 rowLimit 이다', () => {
            const block = SPECIAL_FETCH.exec(src);
            assert.match(
                block[0],
                /orderBy\('timestamp', 'desc'\),\s*\n\s*limit\(rowLimit\)/,
                '페이지와 무관하게 늘 상한만큼 받습니다'
            );
        });

        it('호출부가 skip + pageSize 로 상한을 잡는다', () => {
            assert.match(
                src,
                /Math\.min\(skip \+ pageSize, ADMIN_FEED_SPECIAL_ROWS_CAP\)/,
                '페이지가 필요한 행 수를 계산하지 않습니다'
            );
        });

        /**
         * 작성자 필터일 때는 이 결과의 **건수가 그대로 「전체」 수**로 쓰인다
         * (getFeedPage 의 specPinned.length). 줄이면 페이지 수가 틀어진다.
         */
        it('작성자 필터에서는 줄이지 않는다 — 그 건수가 「전체」 수다', () => {
            assert.match(
                src,
                /const specNeeded = authorUid\s*\n\s*\? ADMIN_FEED_SPECIAL_ROWS_CAP/,
                '작성자 필터에서도 상한을 줄이면 전체 건수·페이지 수가 틀어집니다'
            );
        });

        /**
         * 앞 페이지가 20건으로 캐시해 두면 5페이지(100건 필요)가 모자란 채로 그려진다.
         */
        it('캐시가 「몇 건으로 받았는지」를 기억한다', () => {
            const fn = /async function getSpecialSharesModerationRowsCached\([\s\S]*?\n\}/.exec(src);
            assert.ok(fn, 'getSpecialSharesModerationRowsCached 를 찾지 못했습니다');
            assert.match(
                fn[0],
                /limitUsed \|\| 0\) >= rowLimit/,
                '캐시가 상한을 무시하면 뒤 페이지에서 행이 모자랍니다'
            );
            assert.match(fn[0], /limitUsed: rowLimit/, '받은 상한을 캐시에 남기지 않습니다');
        });

        it('캐시 무효화가 새 캐시들도 함께 비운다', () => {
            const fn = /function invalidateAdminFeedMonitoringCache\(\)[\s\S]*?\n\}/.exec(src);
            assert.ok(fn, 'invalidateAdminFeedMonitoringCache 를 찾지 못했습니다');
            assert.match(fn[0], /specialSharesCountCache = \{ ts: 0/, '건수 캐시를 비우지 않습니다');
            assert.match(fn[0], /specialSharesMissingTsCache = \{ ts: 0/, '보강 판단 캐시를 비우지 않습니다');
            assert.match(fn[0], /limitUsed: 0/, '특수 공유 캐시의 limitUsed 를 되돌리지 않습니다');
        });
    });
});
