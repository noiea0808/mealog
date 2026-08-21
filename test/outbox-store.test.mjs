/**
 * 아웃박스 스토어 — 불변식 테스트.
 *
 * 설계: `docs/sync-outbox-design.md`
 *
 * 여기서 지키려는 문장은 하나다(§1):
 *   **사용자가 저장을 누른 기록은, 어떤 fallible 한 단계도 시작하기 전에 이미 내구 저장돼 있다.**
 *
 * 그래서 테스트도 「함수가 뭘 돌려주나」가 아니라 「정말 커밋됐나」를 본다 — 판정은 스토어의
 * 반환값이 아니라 별도 연결로 IndexedDB 를 직접 읽어서 한다(`readRaw`).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearOutbox, readRaw, ageEntry, photoBlob, setStorageBudget, resetStorageBudget } from './helpers/outbox-env.mjs';
import * as store from '../js/utils/outbox-store.js';

const UID = 'user-1';

beforeEach(() => clearOutbox(store));

describe('내구화 — 성공했다고 말하려면 실제로 커밋돼 있어야 한다 (§1, §4.2)', () => {
    it('enqueue 가 true 면 IndexedDB 에서도 읽힌다', async () => {
        const ok = await store.enqueue({
            target: 'meal',
            id: 'm1',
            uid: UID,
            payload: { memo: '점심', updatedAt: '2026-08-10T00:00:00.000Z' }
        });

        assert.equal(ok, true);
        const row = await readRaw('meal:m1');
        assert.ok(row, '반환은 true 인데 실제로는 저장돼 있지 않다');
        assert.equal(row.payload.memo, '점심');
        assert.equal(row.uid, UID);
        assert.equal(row.op, 'upsert', 'op 기본값은 upsert');
        assert.equal(row.class, store.CLASS_CONTENT, 'class 기본값은 content');
    });

    it('사진은 Blob 그대로 보존된다 (§4.6 — data URL 문자열이 아니다)', async () => {
        const ok = await store.enqueue({
            target: 'meal',
            id: 'm2',
            uid: UID,
            payload: {},
            photos: [photoBlob(64), photoBlob(32)],
            originals: [photoBlob(512)]
        });

        assert.equal(ok, true);
        const row = await readRaw('meal:m2');
        assert.equal(row.photos.length, 2);
        assert.ok(row.photos[0] instanceof Blob, '사진이 Blob 이 아니면 §4.6 의 전제가 깨진다');
        assert.equal(row.photos[0].size, 64);
        assert.equal(row.originals.length, 1);
    });

    it('삭제도 아웃박스에 남는다 — 삭제 유실도 유실이다', async () => {
        const ok = await store.enqueue({ target: 'meal', id: 'm3', uid: UID, op: 'delete' });

        assert.equal(ok, true);
        const row = await readRaw('meal:m3');
        assert.equal(row.op, 'delete');
    });
});

describe('병합 — 같은 문서를 겨냥한 편집이 서로를 지우지 않는다 (§4.1)', () => {
    it('mergePayload 는 중첩 객체를 깊게 병합한다', async () => {
        // userSettings 는 단일 큰 문서다. 얕게 합치면 settings 가 통째로 교체돼
        // 하루 소감과 프로필 수정이 서로를 지운다(설계 문서에 실측으로 확인됐다고 적힌 사고).
        await store.enqueue({
            target: 'settings',
            id: UID,
            uid: UID,
            mergePayload: true,
            payload: { settings: { nickname: '노이에', dailyJournal: { '2026-08-10': '맛있었다' } } }
        });
        await store.enqueue({
            target: 'settings',
            id: UID,
            uid: UID,
            mergePayload: true,
            payload: { settings: { birthdate: '1990-01-01' } }
        });

        const row = await readRaw(`settings:${UID}`);
        assert.equal(row.payload.settings.nickname, '노이에', '나중 저장이 앞선 편집을 지웠다');
        assert.equal(row.payload.settings.dailyJournal['2026-08-10'], '맛있었다');
        assert.equal(row.payload.settings.birthdate, '1990-01-01');
    });

    it('배열은 병합하지 않고 통째로 교체한다 — 지운 사진이 되살아나면 안 된다', async () => {
        await store.enqueue({
            target: 'settings',
            id: UID,
            uid: UID,
            mergePayload: true,
            payload: { settings: { tags: ['한식', '중식', '일식'] } }
        });
        await store.enqueue({
            target: 'settings',
            id: UID,
            uid: UID,
            mergePayload: true,
            payload: { settings: { tags: ['한식'] } }
        });

        const row = await readRaw(`settings:${UID}`);
        assert.deepEqual(row.payload.settings.tags, ['한식'], '배열이 합집합으로 병합되면 삭제가 되돌아온다');
    });

    it('mergePayload 가 없으면 덮어쓴다 — 식사 기록은 마지막 상태가 맞다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: { memo: '처음', place: '집' } });
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: { memo: '고침' } });

        const row = await readRaw('meal:m1');
        assert.equal(row.payload.memo, '고침');
        assert.equal(row.payload.place, undefined, '덮어쓰기여야 하는데 이전 값이 남았다');
    });

    it('병합해도 createdAt 은 최초 값을 유지한다 — 워커가 오래된 것부터 밀기 때문', async () => {
        await store.enqueue({ target: 'settings', id: UID, uid: UID, mergePayload: true, payload: { a: 1 } });
        const firstCreatedAt = (await readRaw(`settings:${UID}`)).createdAt;

        await new Promise((r) => setTimeout(r, 5));
        await store.enqueue({ target: 'settings', id: UID, uid: UID, mergePayload: true, payload: { b: 2 } });

        const row = await readRaw(`settings:${UID}`);
        assert.equal(row.createdAt, firstCreatedAt, 'createdAt 이 갱신되면 큐 순서가 뒤로 밀린다');
        assert.ok(row.updatedAt >= firstCreatedAt, 'updatedAt 은 갱신돼야 한다');
    });
});

describe('동기 인덱스 — 표시의 단일 기준 (§4.3, §4.4)', () => {
    it('enqueue / remove 를 그대로 따라간다', async () => {
        assert.equal(store.isPendingSync('meal', 'm1'), false);

        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        assert.equal(store.isPendingSync('meal', 'm1'), true);
        assert.equal(store.pendingCountSync(UID), 1);

        await store.remove('meal:m1');
        assert.equal(store.isPendingSync('meal', 'm1'), false);
        assert.equal(store.pendingCountSync(UID), 0);
    });

    it('pendingCountSync 는 uid 로 가른다 — 다른 계정 항목이 배지에 섞이면 안 된다', async () => {
        await store.enqueue({ target: 'meal', id: 'a', uid: UID, payload: {} });
        await store.enqueue({ target: 'meal', id: 'b', uid: 'user-2', payload: {} });

        assert.equal(store.pendingCountSync(UID), 1);
        assert.equal(store.pendingCountSync('user-2'), 1);
        assert.equal(store.pendingCountSync(), 2, 'uid 를 안 주면 전체');
    });

    it('hydrateOutboxIndex 가 부팅 시 인덱스를 복원한다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        await store.enqueue({ target: 'boardPost', id: 'p1', uid: UID, payload: {} });

        const n = await store.hydrateOutboxIndex();

        assert.equal(n, 2);
        assert.equal(store.isOutboxIndexReady(), true);
        assert.equal(store.isPendingSync('boardPost', 'p1'), true);
    });

    it('인덱스 변경이 구독자에게 알려진다 — 배지·타임라인이 이걸로 갱신된다', async () => {
        let calls = 0;
        const off = store.subscribeOutboxIndex(() => calls++);

        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        assert.ok(calls > 0, 'enqueue 가 구독자에게 알리지 않았다');

        const before = calls;
        await store.remove('meal:m1');
        assert.ok(calls > before, 'remove 가 구독자에게 알리지 않았다');

        off();
        await store.enqueue({ target: 'meal', id: 'm2', uid: UID, payload: {} });
        assert.equal(calls, before + 1, '해지된 구독자가 계속 불렸다');
    });

    it('인덱스에 없는 key 의 remove 는 조용히 성공한다 — ack 폭주 경로', async () => {
        // onServerDocumentAcknowledged 가 스냅샷의 모든 문서마다 부른다. 대부분은 아웃박스에
        // 없으므로, 그때 트랜잭션을 열지 않는 것이 이 경로의 성능 계약이다.
        assert.equal(await store.remove('meal:없는거'), true);
    });
});

describe('실패 기록 — 재시도가 무의미한 것만 permanent (§4.4)', () => {
    it('markAttempt 가 attempts 를 올리고 lastError 를 남긴다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });

        await store.markAttempt('meal:m1', Object.assign(new Error('unavailable'), { code: 'unavailable' }));
        await store.markAttempt('meal:m1', Object.assign(new Error('unavailable'), { code: 'unavailable' }));

        const row = await readRaw('meal:m1');
        assert.equal(row.attempts, 2);
        assert.equal(row.lastError.code, 'unavailable');
        assert.ok(row.lastError.at, '백오프 계산이 lastError.at 에 의존한다');
        assert.equal(row.permanent, false, '네트워크성 실패는 절대 permanent 가 아니다');
        assert.equal(store.isPermanentSync('meal', 'm1'), false);
    });

    it('permanent 는 동기 인덱스에도 반영된다 — 표시가 달라져야 하므로', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });

        await store.markAttempt('meal:m1', new Error('invalid'), true);

        assert.equal(store.isPermanentSync('meal', 'm1'), true);
        assert.equal(store.isPendingSync('meal', 'm1'), true, 'permanent 여도 아웃박스에는 남아 있다');
    });

    it('clearPermanent 는 표식만 풀고 attempts·lastError 는 남긴다', async () => {
        // 사용자가 재전송을 직접 누른 것이 §4.4 가 말하는 「개입」이다. 이 수단이 없던 동안
        // permanent 는 빠져나올 길이 없는 종착 상태였다 — 워커는 거르고, 배지는 세고,
        // content 등급은 만료도 없어서 항목이 영원히 갇혔다.
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        await store.markAttempt('meal:m1', Object.assign(new Error('nope'), { code: 'invalid-argument' }), true);

        assert.equal(await store.clearPermanent('meal:m1'), true);

        const row = await readRaw('meal:m1');
        assert.equal(row.permanent, false);
        assert.equal(row.attempts, 1, 'attempts 를 리셋하면 백오프가 0 으로 돌아가 6초마다 재시도하는 뜨거운 루프가 된다');
        assert.ok(row.lastError, '무엇 때문에 막혔는지는 남아 있어야 한다');
        assert.equal(store.isPermanentSync('meal', 'm1'), false);
        assert.equal(store.isPendingSync('meal', 'm1'), true, '표식만 풀렸을 뿐 항목은 그대로다');
    });

    it('clearPermanent 는 permanent 가 아니던 항목에는 false 를 돌려준다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });

        assert.equal(await store.clearPermanent('meal:m1'), false);
        assert.equal(await store.clearPermanent('meal:없는키'), false);
    });

    it('다시 저장하면 attempts·permanent 가 초기화된다', async () => {
        // 사용자가 고쳐서 다시 눌렀다면 백오프도 영구실패 판정도 처음부터다.
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        await store.markAttempt('meal:m1', new Error('boom'), true);

        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: { memo: '고침' } });

        const row = await readRaw('meal:m1');
        assert.equal(row.attempts, 0);
        assert.equal(row.permanent, false);
        assert.equal(row.lastError, null);
        assert.equal(store.isPermanentSync('meal', 'm1'), false);
    });
});

describe('보존 정책 — 콘텐츠는 자동으로 지우지 않는다 (§4.1.1)', () => {
    it('content 등급은 아무리 오래돼도 만료되지 않는다', async () => {
        await store.enqueue({ target: 'meal', id: 'old', uid: UID, class: store.CLASS_CONTENT, payload: {} });
        await ageEntry('meal:old', 400);

        const n = await store.expireInteractions();

        assert.equal(n, 0);
        assert.ok(await readRaw('meal:old'), '사용자가 쓴 것을 시간이 지났다고 지웠다');
    });

    it('interaction 등급은 TTL(7일)을 넘기면 만료된다', async () => {
        await store.enqueue({ target: 'interaction', id: 'like-1', uid: UID, class: store.CLASS_INTERACTION, payload: {} });
        await ageEntry('interaction:like-1', 8);

        const n = await store.expireInteractions();

        assert.equal(n, 1);
        assert.equal(await readRaw('interaction:like-1'), undefined);
        assert.equal(store.isPendingSync('interaction', 'like-1'), false, '인덱스에서도 빠져야 한다');
    });

    it('TTL 이내의 interaction 은 남는다', async () => {
        await store.enqueue({ target: 'interaction', id: 'like-2', uid: UID, class: store.CLASS_INTERACTION, payload: {} });
        await ageEntry('interaction:like-2', 3);

        assert.equal(await store.expireInteractions(), 0);
        assert.ok(await readRaw('interaction:like-2'));
    });

    it('purgeUser 는 해당 uid 만 지운다 (탈퇴 경로)', async () => {
        await store.enqueue({ target: 'meal', id: 'a', uid: UID, payload: {} });
        await store.enqueue({ target: 'meal', id: 'b', uid: UID, payload: {} });
        await store.enqueue({ target: 'meal', id: 'c', uid: 'user-2', payload: {} });

        const n = await store.purgeUser(UID);

        assert.equal(n, 2);
        assert.equal(store.pendingCountSync(UID), 0);
        assert.ok(await readRaw('meal:c'), '다른 계정 항목까지 지웠다');
    });
});

describe('큐 순서 — 워커는 오래된 것부터 민다 (§4.3)', () => {
    it('listPending 은 createdAt 오름차순이다', async () => {
        await store.enqueue({ target: 'meal', id: 'new', uid: UID, payload: {} });
        await store.enqueue({ target: 'meal', id: 'old', uid: UID, payload: {} });
        await ageEntry('meal:old', 2);

        const rows = await store.listPending(UID);

        assert.deepEqual(rows.map((r) => r.id), ['old', 'new']);
    });

    it('listPending 은 uid 로 거른다', async () => {
        await store.enqueue({ target: 'meal', id: 'a', uid: UID, payload: {} });
        await store.enqueue({ target: 'meal', id: 'b', uid: 'user-2', payload: {} });

        const rows = await store.listPending(UID);

        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, 'a');
    });
});

describe('쿼터 초과 — 사진보다 본문이 먼저다 (§4.2)', () => {
    beforeEach(() => resetStorageBudget());

    it('원본을 버려 공간을 확보하고 재시도해 사진을 지킨다', async () => {
        await store.enqueue({
            target: 'meal',
            id: 'a',
            uid: UID,
            payload: {},
            photos: [photoBlob(300)],
            originals: [photoBlob(600)]
        });

        // a(900) + b(900) = 1800 > 1300 이지만, a 의 원본 600 을 버리면 1200 으로 들어간다
        setStorageBudget(1300);
        const ok = await store.enqueueWithQuotaRelief({
            target: 'meal',
            id: 'b',
            uid: UID,
            payload: { memo: '저녁' },
            photos: [photoBlob(300)],
            originals: [photoBlob(600)]
        });

        assert.equal(ok, true);
        const b = await readRaw('meal:b');
        assert.equal(b.photos.length, 1, '원본만 버리고 다운스케일본은 지켜야 한다');
        assert.equal(b.payload.memo, '저녁');
        const a = await readRaw('meal:a');
        assert.equal(a.originals, null, '공간 확보가 실제로 일어나지 않았다');
        assert.equal(a.photos.length, 1, '기존 항목의 다운스케일본까지 버리면 안 된다');
    });

    it('그래도 안 되면 사진을 버리고 본문만 저장한다 — 텍스트를 잃는 것이 최악이다', async () => {
        await store.enqueue({
            target: 'meal',
            id: 'a',
            uid: UID,
            payload: {},
            photos: [photoBlob(300)],
            originals: [photoBlob(600)]
        });

        // 원본을 다 버려도 300 + 900 = 1200 > 1000 이라 사진째로는 절대 못 들어간다
        setStorageBudget(1000);
        const ok = await store.enqueueWithQuotaRelief({
            target: 'meal',
            id: 'b',
            uid: UID,
            payload: { memo: '이 텍스트는 살아야 한다' },
            photos: [photoBlob(300)],
            originals: [photoBlob(600)]
        });

        assert.equal(ok, true);
        const b = await readRaw('meal:b');
        assert.equal(b.photos.length, 0);
        assert.equal(b.originals, null);
        assert.equal(b.payload.memo, '이 텍스트는 살아야 한다');
    });

    it('본문만으로도 안 들어가면 false 로 알린다 — 조용히 성공이라고 말하지 않는다', async () => {
        setStorageBudget(-1); // 어떤 put 도 통과하지 못한다

        const ok = await store.enqueueWithQuotaRelief({
            target: 'meal',
            id: 'z',
            uid: UID,
            payload: { memo: '들어갈 곳이 없다' }
        });

        assert.equal(ok, false, '내구화 실패를 true 로 덮으면 §1 이 소리 없이 깨진다');
        assert.equal(store.isPendingSync('meal', 'z'), false, '커밋되지 않은 것이 인덱스에 남았다');
    });
});

describe('읽기 실패 — 「못 읽었다」와 「비었다」는 다르다', () => {
    /**
     * 이 구분이 없어서 난 사고(실측 2026-08-21, 프로덕션):
     *
     * `getAll` 이 3초 데드라인에 걸리면 예전에는 `[]` 로 뭉개졌고, 워커는 그걸 「보낼 게
     * 없다」로 읽고 그대로 쉬었다. 배지는 부팅 때 채운 메모리 인덱스를 보므로 N 이 그대로
     * 떠 있었고, 사용자가 FAB 을 눌러도 같은 빈 배열이 나와 **아무 시도도 일어나지 않았다.**
     * 항목은 앱을 다시 깔아도 IndexedDB 에 남아 영영 갇혔다.
     *
     * 그때 실제로 남은 계측: `deadline {"label":"idb-tx:getAll:entries","ms":3000}` 6회.
     */
    function breakReads() {
        const orig = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function () {
            throw new Error('idb-busy');
        };
        return () => {
            IDBDatabase.prototype.transaction = orig;
        };
    }

    it('listPending 은 읽기에 실패하면 null 이다 — 빈 배열이 아니다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        const restore = breakReads();
        try {
            assert.equal(await store.listPending(UID), null, '읽기 실패가 「큐가 비었음」으로 둔갑하면 항목이 갇힌다');
        } finally {
            restore();
        }
        assert.deepEqual((await store.listPending(UID)).map((r) => r.key), ['meal:m1'], '복구되면 다시 읽힌다');
    });

    it('hydrate 는 실패해도 이미 아는 인덱스를 지우지 않는다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });
        assert.equal(store.pendingCountSync(UID), 1);

        const restore = breakReads();
        try {
            assert.equal(await store.hydrateOutboxIndex(), -1, '실패는 0 건이 아니라 -1 로 구분된다');
            // 여기서 인덱스를 비우면 아직 안 올라간 기록이 화면에서 「반영됨」으로 보인다.
            assert.equal(store.pendingCountSync(UID), 1, '읽기 한 번 실패한 것을 데이터 없음으로 단정하면 안 된다');
            assert.equal(await store.pendingCount(UID), 1, '못 읽었으면 0 이 아니라 인덱스가 아는 값을 쓴다');
        } finally {
            restore();
        }
    });

    it('purgeUser 는 못 읽었으면 아무것도 지우지 않는다', async () => {
        await store.enqueue({ target: 'meal', id: 'm1', uid: UID, payload: {} });

        const restore = breakReads();
        try {
            assert.equal(await store.purgeUser(UID), 0);
        } finally {
            restore();
        }
        assert.ok(await readRaw('meal:m1'), '읽기 실패를 「지울 게 없음」으로 읽으면 안 된다');
    });
});
