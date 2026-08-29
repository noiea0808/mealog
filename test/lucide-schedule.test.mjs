/**
 * 아이콘 예약(scheduleLucideIcons)의 계약.
 *
 * 배경: 밀톡 라이트박스의 닫기 X 가 빈 원으로 보였다. 원인 둘이 겹쳤다 —
 * (1) board-feed.js 가 <i data-lucide> 를 뿌리면서 아이콘 생성을 한 번도 안 불렀고,
 * (2) 예약 슬롯이 하나뿐이라 나중 호출이 앞 호출을 통째로 **취소**했다.
 *
 * 여기서 못박는 건 (2)다. 서로 다른 영역이 같은 프레임에 렌더돼도 **둘 다** 그려져야
 * 한다. 브라우저 자동화 창에서는 rAF 가 멈춰 있어 이 계약을 눈으로 확인할 수 없다 —
 * 그래서 테스트로 고정한다.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** createIcons 가 실제로 처리한 root 들 */
let processedRoots = [];
let flushRaf = null;

function makeEl(iconNames = []) {
    const el = {
        nodeType: 1,
        isConnected: true,
        _icons: [...iconNames],
        querySelector(sel) {
            if (sel === 'i[data-lucide]') return el._icons.length ? { tag: 'i' } : null;
            return null;
        },
        querySelectorAll(sel) {
            // svg[data-lucide] 조회 — 이 스텁엔 이미 그려진 svg 가 없다
            return sel.startsWith('svg') ? [] : [];
        }
    };
    return el;
}

before(async () => {
    const doc = {
        nodeType: 9,
        body: { nodeType: 1 },
        querySelector: () => null,
        querySelectorAll: () => []
    };
    globalThis.document = doc;
    globalThis.window = {
        lucide: {
            createIcons({ root }) {
                processedRoots.push(root);
                // 그려진 아이콘은 목록에서 비운다 (실제 동작과 동일한 효과)
                if (root && Array.isArray(root._icons)) root._icons.length = 0;
            }
        }
    };
    globalThis.requestAnimationFrame = (cb) => {
        flushRaf = cb;
        return 1;
    };
    globalThis.cancelAnimationFrame = () => {
        flushRaf = null;
    };
});

/** rAF → setTimeout(32) 두 단계를 넘긴다 */
async function flush() {
    if (flushRaf) {
        const cb = flushRaf;
        flushRaf = null;
        cb();
    }
    await new Promise((r) => setTimeout(r, 60));
}

describe('scheduleLucideIcons — 예약은 취소가 아니라 누적이다', () => {
    beforeEach(() => {
        processedRoots = [];
        flushRaf = null;
    });

    it('같은 프레임에 예약한 root 가 둘이면 둘 다 그린다', async () => {
        const { scheduleLucideIcons } = await import('../js/icons.js');
        const a = makeEl(['x']);
        const b = makeEl(['download']);

        scheduleLucideIcons(a);
        scheduleLucideIcons(b); // 예전엔 이 호출이 a 를 통째로 취소했다
        await flush();

        assert.ok(processedRoots.includes(a), '먼저 예약한 root 가 버려졌다');
        assert.ok(processedRoots.includes(b));
    });

    it('document 가 끼면 그 한 번으로 끝낸다 — 중복 순회를 만들지 않는다', async () => {
        const { scheduleLucideIcons } = await import('../js/icons.js');
        const a = makeEl(['x']);
        globalThis.document._icons = ['x'];
        globalThis.document.querySelector = () => ({ tag: 'i' });

        scheduleLucideIcons(a);
        scheduleLucideIcons(); // 기본값 = document
        await flush();

        assert.equal(processedRoots.length, 1);
        assert.equal(processedRoots[0], globalThis.document.body);
        globalThis.document.querySelector = () => null;
    });

    it('예약 뒤 떨어져 나간 노드는 건너뛴다', async () => {
        const { scheduleLucideIcons } = await import('../js/icons.js');
        const gone = makeEl(['x']);
        const alive = makeEl(['download']);

        scheduleLucideIcons(gone);
        scheduleLucideIcons(alive);
        gone.isConnected = false; // 라이트박스가 닫히는 등
        await flush();

        assert.ok(!processedRoots.includes(gone));
        assert.ok(processedRoots.includes(alive));
    });

    it('flush 후 대기 목록이 비워진다 — 다음 예약에 옛 root 가 딸려오지 않는다', async () => {
        const { scheduleLucideIcons } = await import('../js/icons.js');
        const first = makeEl(['x']);
        scheduleLucideIcons(first);
        await flush();

        processedRoots = [];
        const second = makeEl(['download']);
        scheduleLucideIcons(second);
        await flush();

        assert.deepEqual(processedRoots, [second]);
    });
});
