/**
 * 아웃박스 테스트 환경.
 *
 * 이 테스트가 검증하는 것은 `docs/sync-outbox-design.md` §1 의 불변식이다 —
 * **사용자가 저장을 누른 기록은, 어떤 fallible 한 단계도 시작하기 전에 이미 내구 저장돼 있다.**
 *
 * 그래서 스토어를 목으로 갈아끼우지 않고 **실제 IndexedDB 구현**(fake-indexeddb) 위에서 돌린다.
 * 목으로 바꾸면 정작 검증하려던 「내구화가 실제로 됐는가」가 검증 대상에서 빠진다 —
 * 이 서브시스템이 13번 고쳐지는 동안 반복된 실수가 정확히 그 종류였다(§4.9: 증거 없이 추론).
 */
import './quiet-timers.mjs';
import 'fake-indexeddb/auto';

const DB_NAME = 'mealog-outbox';
const DB_VERSION = 1;
const STORE = 'entries';

/** 스토어와 같은 스키마로 직접 연다 (검증·조작용 두 번째 연결) */
function openRaw() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const s = db.createObjectStore(STORE, { keyPath: 'key' });
                s.createIndex('uid', 'uid', { unique: false });
                s.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('open-failed'));
    });
}

function runTx(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let req;
        try {
            req = fn(t.objectStore(STORE));
        } catch (e) {
            reject(e);
            return;
        }
        t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
        t.onerror = () => reject(t.error || new Error('tx-failed'));
        t.onabort = () => reject(t.error || new Error('tx-aborted'));
    });
}

/** 테스트 간 격리 — DB 를 비우고 스토어의 동기 인덱스를 다시 채운다 */
export async function clearOutbox(store) {
    resetStorageBudget();
    const db = await openRaw();
    await runTx(db, 'readwrite', (s) => s.clear());
    db.close();
    await store.hydrateOutboxIndex();
}

/** 스토어를 거치지 않고 실제로 커밋된 행을 읽는다 (「정말 내구 저장됐는가」 검증용) */
export async function readRaw(key) {
    const db = await openRaw();
    const row = await runTx(db, 'readonly', (s) => s.get(key));
    db.close();
    return row;
}

/**
 * 항목을 「오래된 것」으로 만든다. TTL(7일)을 실제로 기다릴 수 없으므로 createdAt 을 과거로 돌린다.
 * @param {string} key
 * @param {number} days 며칠 전으로 되돌릴지
 * @returns {Promise<string>} 새로 박힌 createdAt
 */
export async function ageEntry(key, days) {
    const db = await openRaw();
    const row = await runTx(db, 'readonly', (s) => s.get(key));
    if (!row) {
        db.close();
        throw new Error(`ageEntry: ${key} 가 아웃박스에 없다`);
    }
    const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    await runTx(db, 'readwrite', (s) => s.put({ ...row, createdAt: at }));
    db.close();
    return at;
}

/** 지정 바이트 수의 사진 Blob */
export function photoBlob(bytes) {
    return new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
}

// ── 저장소 쿼터 시뮬레이션 ──────────────────────────────────────────────────────
//
// §4.2: 쿼터 초과 시 originals 부터 버려 공간을 확보하고 재시도하며, 그래도 안 되면 사진 없이
// 본문만이라도 저장한다. 실제 쿼터는 재현할 수 없으므로 「저장된 사진 바이트 합이 예산을 넘으면
// put 이 실패한다」로 모형화한다 — **원본을 버리면 합이 줄어 통과한다**는 관계가 실제와 같아야
// 이 경로가 의미 있게 검증된다.

let budget = Infinity;
/** @type {Map<string, number>} key → 사진 바이트 */
const sizes = new Map();
let patched = false;

function blobBytes(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const b of list) n += b?.size || 0;
    return n;
}

function rowBytes(row) {
    return blobBytes(row?.photos) + blobBytes(row?.originals);
}

/**
 * 패치는 **모듈 로드 시점에** 건다. 예산을 거는 시점에 걸면, 그 전에 저장된 행은 크기 추적에서
 * 빠져 「이미 차 있는 저장소」를 재현하지 못한다(예산을 걸어도 첫 put 이 그냥 통과해 버린다).
 * 기본 예산은 Infinity 라 걸어 두어도 무해하다.
 */
function patchOnce() {
    if (patched) return;
    patched = true;
    const proto = globalThis.IDBObjectStore.prototype;

    const realPut = proto.put;
    proto.put = function (value, key) {
        if (this.name === STORE && value && typeof value === 'object' && value.key) {
            const size = rowBytes(value);
            let total = size;
            for (const [k, v] of sizes) if (k !== value.key) total += v;
            if (total > budget) {
                const e = new Error('QuotaExceededError (테스트 시뮬레이션)');
                e.name = 'QuotaExceededError';
                throw e;
            }
            sizes.set(value.key, size);
        }
        return realPut.call(this, value, key);
    };

    const realDelete = proto.delete;
    proto.delete = function (k) {
        if (this.name === STORE) sizes.delete(k);
        return realDelete.call(this, k);
    };

    const realClear = proto.clear;
    proto.clear = function () {
        if (this.name === STORE) sizes.clear();
        return realClear.call(this);
    };
}

patchOnce();

/** 저장소 예산(사진 바이트 합)을 건다. 넘기는 put 은 QuotaExceededError 로 실패한다. */
export function setStorageBudget(bytes) {
    budget = bytes;
}

export function resetStorageBudget() {
    budget = Infinity;
    sizes.clear();
}
