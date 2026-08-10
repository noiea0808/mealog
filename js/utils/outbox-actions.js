/**
 * Callable 기반 콘텐츠 쓰기의 아웃박스 배선 — 공통 헬퍼 + 핸들러 레지스트리.
 *
 * 밀톡 글·댓글, 모먼트 글, 댓글, 공유는 전부 Cloud Functions Callable 로 나간다. Callable 은
 * Firestore 로컬 큐를 **타지 않으므로**, 실패하면 지금까지 아무 데도 남지 않았다. 사용자가 쓴
 * 글이 전송 실패로 그냥 사라지는 자리였다(설계 §2.2 와 같은 뿌리).
 *
 * 이 파일이 하는 일은 두 가지다:
 *   1. `runWithOutbox` — 「내구화 → 실행 → 성공 시에만 제거」를 한 함수로 묶는다.
 *      호출부는 기존 로직을 그대로 두고 감싸기만 하면 된다.
 *   2. 핸들러 레지스트리 — 워커가 target 만 보고 재시도할 수 있게 한다.
 *      워커에 target 별 분기를 늘려 가면 그 분기가 또 하나의 상태기계가 되므로,
 *      「어떻게 다시 보내는가」는 그 쓰기를 소유한 모듈이 등록한다.
 *
 * 설계: docs/sync-outbox-design.md §4.1.1, §4.3
 */
import { enqueueWithQuotaRelief, remove as outboxRemove, outboxKey, CLASS_CONTENT } from './outbox-store.js';
import { diag } from './diagnostics.js';

/** @type {Map<string, (payload: object, entry: object) => Promise<unknown>>} */
const handlers = new Map();

/**
 * target 의 재시도 방법을 등록한다. 워커가 이것만 보고 다시 보낸다.
 * 핸들러는 **성공 시 resolve, 실패 시 throw** 해야 한다 — 그 구분이 제거 여부를 정한다.
 */
export function registerOutboxHandler(target, handler) {
    if (typeof handler === 'function') handlers.set(target, handler);
}

export function getOutboxHandler(target) {
    return handlers.get(target) || null;
}

export function hasOutboxHandler(target) {
    return handlers.has(target);
}

/** 생성 계열은 서버 id 가 아직 없다 — 아웃박스 키용 로컬 액션 id */
export function newActionId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 내구화 → 실행 → 성공 시에만 제거.
 *
 * @template T
 * @param {{ target: string, id: string, uid: string, cls?: string, payload: object }} spec
 * @param {() => Promise<T>} run 실제 전송 (Callable 호출 등)
 * @returns {Promise<T>}
 * @throws run 이 던진 것을 그대로 다시 던진다 — 호출부의 기존 오류 처리를 바꾸지 않는다.
 */
export async function runWithOutbox(spec, run) {
    const key = outboxKey(spec.target, spec.id);
    const durable = await enqueueWithQuotaRelief({
        target: spec.target,
        id: spec.id,
        uid: spec.uid,
        op: 'upsert',
        class: spec.cls || CLASS_CONTENT,
        payload: { ...spec.payload, updatedAt: new Date().toISOString() }
    });
    if (!durable) {
        // 내구화하지 못했다 — 그래도 전송은 시도한다. 실패하면 예전과 같아지지만,
        // 「성공했다고 말해 놓고 사라지는」 경우는 만들지 않는다.
        diag('outbox.action.notDurable', { target: spec.target });
    }
    try {
        const result = await run();
        await outboxRemove(key); // 서버가 받았다 — 유일한 제거 조건
        return result;
    } catch (e) {
        /**
         * 아웃박스에 남긴다. 워커가 등록된 핸들러로 다시 보낸다.
         * 여기서 제거하면 사용자가 쓴 글이 그대로 사라진다 — 그게 원래 버그였다.
         */
        diag('outbox.action.failed', {
            target: spec.target,
            code: String(e?.code || ''),
            durable
        });
        throw e;
    }
}
