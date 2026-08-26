/**
 * 시간대 행이 어느 축으로 문서를 읽는가 — 「소급 입력이 하루 만에 증발하던」 회귀 방지.
 *
 * 배경 (2026-08-26 → 08-27 관측):
 *   8/26 「기록 시각별」 135건, 그중 18–21시 67건.
 *   이튿날 같은 칸이 91건 / 19건으로 줄었다. 데이터는 그대로였다.
 *
 * 원인은 **읽는 축과 세는 축이 달랐던 것**이다.
 *   - 시간대 행은 recordedAt(기록 시각)으로 칸을 잡는다.
 *   - 그런데 문서는 date(식사 날짜) 범위 쿼리로 가져왔다.
 *   - 과거 끼니를 오늘 몰아 적은 소급 입력은 그 쿼리에 안 걸린다.
 *   - 증분 집계가 `recordedAt > lastAggregatedAt` 델타로 그 구멍을 임시로 메웠는데,
 *     그 델타는 「지난 집계 이후」라 한 번 집계가 돌면 같은 문서를 다시 잡지 않는다.
 *   - 게다가 「최근 7일」 시각 칸은 캐시에 남기지 않고 매번 새로 센다 → 메워 줄 것도 없다.
 *
 * 결과: 소급 입력은 집계 한 번 분량만 보였다가 영구히 사라졌다. 표는 아무 경고 없이
 * 그럴듯한 숫자를 계속 그렸다.
 *
 * 여기서 지키는 계약은 하나다 — **시간대 행은 recordedAt 축으로 읽은 스냅숏에서만 채운다.**
 * 식사 날짜 축 스캔(scanMealDoc)에 다시 얹으면 같은 함정으로 돌아간다.
 *
 * dashboard.js 는 Firestore SDK 를 import 하는 브라우저 모듈이라 여기서 실행할 수 없다.
 * 그래서 소스에서 해당 조각을 떼어 검사한다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/admin/dashboard.js', import.meta.url), 'utf8');

/** 함수 본문 정규식은 리터럴로 둔다 (템플릿 리터럴로 조립하면 백슬래시가 한 번 풀린다) */
const SCAN_MEAL_DOC = /const scanMealDoc = \(docSnap, retroOnly\) => \{[\s\S]*?\n {8}\};/;
const HOUR_START_ISO = /const hourScanStartIso = \(\(\) => \{[\s\S]*?\n {8}\}\)\(\);/;

describe('시간대 행의 읽기 축 (2026-08-27)', () => {
    it('기록 시각 축 스냅숏이 존재한다', () => {
        assert.match(
            src,
            /mealsRecordedSnap/,
            'recordedAt 축으로 읽는 스냅숏(mealsRecordedSnap)이 없습니다'
        );
        assert.match(
            src,
            /where\('recordedAt', '>=', hourScanStartIso\)/,
            '시간대 행이 recordedAt 범위 쿼리로 문서를 가져오지 않습니다'
        );
    });

    it('그 스냅숏이 실제로 시간대 집계를 채운다', () => {
        const feed = /mealsRecordedSnap\.forEach\(\([\s\S]*?\n {8}\}\);/.exec(src);
        assert.ok(feed, 'mealsRecordedSnap 을 순회하는 블록을 찾지 못했습니다');
        assert.match(feed[0], /addHourRecord\(hourSlotForMealDoc\(/, '시간대 집계를 채우지 않습니다');
        assert.match(feed[0], /excluded\.has\(uid\)/, '제외 UID 를 거르지 않습니다');
    });

    it('식사 날짜 축 스캔은 시간대를 건드리지 않는다 — 이게 원래 버그였다', () => {
        const scan = SCAN_MEAL_DOC.exec(src);
        assert.ok(scan, 'scanMealDoc 을 찾지 못했습니다');
        assert.doesNotMatch(
            scan[0],
            /addHourRecord\(/,
            'scanMealDoc 이 시간대 집계를 채웁니다 — 식사 날짜 축이라 소급 입력이 누락됩니다'
        );
    });

    it('시간대 집계가 lastAggregatedAt 에 의존하지 않는다', () => {
        // 소급 델타(mealsRetroSnap)는 지난 집계 이후만 잡는다. 시간대 행이 그걸 쓰면
        // 같은 문서가 두 번째 집계부터 사라진다.
        const feed = /mealsRetroSnap\.forEach\([\s\S]*?\);/.exec(src);
        assert.ok(feed, 'mealsRetroSnap 순회를 찾지 못했습니다');
        assert.doesNotMatch(feed[0], /addHourRecord/, '소급 델타로 시간대를 채우면 안 됩니다');
    });

    it('구간 하한을 로컬 자정 → ISO 로 바꾼다 (recordedAt 이 UTC ISO 문자열이라)', () => {
        const block = HOUR_START_ISO.exec(src);
        assert.ok(block, 'hourScanStartIso 계산을 찾지 못했습니다');
        assert.match(block[0], /setHours\(0, 0, 0, 0\)/, '로컬 자정으로 맞추지 않습니다');
        assert.match(block[0], /toISOString\(\)/, 'ISO 문자열로 바꾸지 않습니다');
    });

    it('하한 계산은 rescanStartKey 를 쓴다 — 캐시가 담당하는 과거까지 다시 읽지 않게', () => {
        const block = HOUR_START_ISO.exec(src);
        assert.match(block[0], /rescanStartKey/, 'rescanStartKey 를 하한으로 쓰지 않습니다');
    });
});
