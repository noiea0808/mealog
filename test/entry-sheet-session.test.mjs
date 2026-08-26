/**
 * 기록 시트 세션 계수기 — 완주율(저장/열기)의 분모를 만드는 상태기.
 *
 * 여기서 틀리면 조용히 틀린다. 계측은 화면에 아무 영향이 없어서, 이탈을 두 번 세거나
 * 수정 진입을 분모에 섞어도 대시보드 숫자가 그럴듯하게 나온다. 그래서 경로마다
 * "정확히 몇 번 나가는지"를 못 박아 둔다.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    createEntrySheetSessionTracker,
    ENTRY_SHEET_METRIC_KEYS,
    ENTRY_SHEET_OPENED_KEY,
    ENTRY_SHEET_OUTCOMES
} from '../js/modals/entry-sheet-session.js';

let emitted;
const make = () => createEntrySheetSessionTracker((k) => emitted.push(k));
beforeEach(() => {
    emitted = [];
});

describe('기록 시트 세션 계수기 (2026-08-26)', () => {
    it('열기 → 저장: opened 와 saved 가 한 번씩', () => {
        const t = make();
        t.begin();
        t.mark('saved');
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_saved']);
    });

    it('열기 → 그냥 닫기: 표시가 없으면 이탈로 센다', () => {
        const t = make();
        t.begin();
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_abandoned']);
    });

    it('열기 → 쓰다가 버리기: discarded 로 구분된다', () => {
        const t = make();
        t.begin();
        t.mark('discarded');
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_discarded']);
    });

    it('삭제는 이탈이 아니다 — 결과 키가 나가지 않는다', () => {
        const t = make();
        t.begin();
        t.mark('deleted');
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened']);
    });

    it('수정 진입은 아예 세지 않는다 (분모 오염 방지)', () => {
        const t = make();
        assert.equal(t.begin({ isEdit: true }), false);
        t.mark('saved');
        t.end();
        assert.deepEqual(emitted, []);
    });

    it('닫기를 두 번 불러도 결과는 한 번만 나간다', () => {
        const t = make();
        t.begin();
        t.mark('saved');
        t.end();
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_saved']);
    });

    it('먼저 표시한 결과가 이긴다 — 저장 뒤 늦은 표시가 덮지 않는다', () => {
        const t = make();
        t.begin();
        t.mark('saved');
        t.mark('discarded');
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_saved']);
    });

    it('세션 없이 표시·닫기를 불러도 아무 일이 없다', () => {
        const t = make();
        assert.equal(t.mark('saved'), false);
        assert.equal(t.end(), null);
        assert.deepEqual(emitted, []);
    });

    it('닫히지 않은 채 다시 열면 앞 세션을 이탈로 정리한다', () => {
        const t = make();
        t.begin();
        t.begin();
        t.end();
        assert.deepEqual(emitted, [
            'entry_sheet_opened',
            'entry_sheet_abandoned',
            'entry_sheet_opened',
            'entry_sheet_abandoned'
        ]);
    });

    it('모르는 결과 이름은 표시되지 않는다 (오타가 조용히 먹히지 않게)', () => {
        const t = make();
        t.begin();
        assert.equal(t.mark('saaved'), false);
        t.end();
        assert.deepEqual(emitted, ['entry_sheet_opened', 'entry_sheet_abandoned']);
    });

    it('계측 함수가 던져도 시트 흐름을 막지 않는다', () => {
        const t = createEntrySheetSessionTracker(() => {
            throw new Error('계측 실패');
        });
        assert.doesNotThrow(() => {
            t.begin();
            t.mark('saved');
            t.end();
        });
    });

    it('실제로 나가는 키는 전부 ENTRY_SHEET_METRIC_KEYS 안에 있다', () => {
        const seen = new Set();
        for (const outcome of ENTRY_SHEET_OUTCOMES) {
            emitted = [];
            const t = make();
            t.begin();
            t.mark(outcome);
            t.end();
            emitted.forEach((k) => seen.add(k));
        }
        emitted = [];
        const t = make();
        t.begin();
        t.end();
        emitted.forEach((k) => seen.add(k));

        const declared = new Set(ENTRY_SHEET_METRIC_KEYS);
        assert.deepEqual([...seen].filter((k) => !declared.has(k)).sort(), [], '선언 목록에 없는 키가 나갑니다');
        assert.ok(seen.has(ENTRY_SHEET_OPENED_KEY));
        // 반대 방향 — 선언만 해두고 아무도 안 쓰는 키가 남지 않게
        assert.deepEqual([...declared].filter((k) => !seen.has(k)).sort(), [], '선언했지만 나가지 않는 키가 있습니다');
    });
});
