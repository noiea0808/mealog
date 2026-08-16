/**
 * 아웃박스 스토어 — **저장소를 못 쓸 때** 의 계약.
 *
 * 설계: `docs/sync-outbox-design.md` §4.2 「아웃박스 쓰기가 실패하면」
 *
 * IndexedDB 는 실패한다 — 쿼터 초과, 시크릿 모드, DB 손상, iOS 의 7일 미사용 제거.
 * 그때 **조용히 넘어가면 §1 의 불변식이 소리 없이 깨지고, 지금까지와 똑같은 모양의 유실이 된다.**
 * 「저장했다고 말했는데 안 됐다」가 이 서브시스템의 원죄다.
 *
 * 그래서 이 파일은 fake-indexeddb 를 **일부러 설치하지 않는다**. Node 에는 indexedDB 전역이
 * 없으므로 저장소가 통째로 죽은 상태가 그대로 재현된다. (`node --test` 는 파일마다 별도
 * 프로세스로 돌기 때문에 다른 테스트의 환경과 섞이지 않는다.)
 */
import './helpers/quiet-timers.mjs';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../js/utils/outbox-store.js';

const UID = 'user-1';

before(() => {
    assert.equal(typeof globalThis.indexedDB, 'undefined', '이 파일은 저장소가 없는 상태를 재현해야 한다');
});

describe('저장소가 죽어 있으면 실패는 시끄러워야 한다 (§4.2)', () => {
    it('enqueue 는 false 를 돌려준다 — 호출부가 성공 팝업을 띄우면 안 되므로', async () => {
        const ok = await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: { memo: '점심' } });

        assert.equal(ok, false);
    });

    it('커밋되지 않은 항목은 「아직 안 올라감」 으로도 표시되지 않는다', async () => {
        await store.enqueue({ target: 'meal', id: 'm2', uid: UID, payload: {} });

        // 여기서 true 를 돌려주면 사용자는 「어딘가에 남아 있다」고 믿지만 실제로는 아무 데도 없다.
        assert.equal(store.isPendingSync('meal', 'm2'), false);
        assert.equal(store.pendingCountSync(UID), 0);
    });

    it('쿼터 완화 경로도 마지막에는 false 로 끝난다', async () => {
        const ok = await store.enqueueWithQuotaRelief({
            target: 'meal',
            id: 'm3',
            uid: UID,
            payload: { memo: '저녁' },
            photos: [new Blob(['x'])]
        });

        assert.equal(ok, false, '완화 단계를 다 거쳐도 저장이 안 됐으면 false 여야 한다');
    });

    it('읽기 경로는 던지지 않고 빈 값으로 답한다 — 저장소가 죽어도 앱은 돈다', async () => {
        assert.deepEqual(await store.listPending(UID), []);
        assert.equal(await store.pendingCount(UID), 0);
        assert.equal(await store.getEntry('meal:m1'), null);
        assert.equal(await store.hasEntry('meal', 'm1'), false);
        assert.deepEqual(await store.dumpOutbox(), []);
    });

    it('hydrate 는 0 으로 끝나되 준비 완료로 표시된다 — 렌더가 영원히 기다리지 않게', async () => {
        assert.equal(await store.hydrateOutboxIndex(), 0);
        assert.equal(store.isOutboxIndexReady(), true);
    });

    it('정리 경로는 아무것도 지우지 않는다', async () => {
        assert.equal(await store.expireInteractions(), 0);
        assert.equal(await store.purgeUser(UID), 0);
    });
});
