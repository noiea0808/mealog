/**
 * 최소 IndexedDB 헬퍼.
 *
 * 3단계 아웃박스와 0단계 계측이 같은 것을 쓴다. 라이브러리를 새로 들이지 않는 이유는 이 프로젝트가
 * 번들러 없이 CDN + ES 모듈로 돌기 때문이다.
 *
 * 두 가지를 보장한다:
 *   1. **절대 throw 하지 않는다.** 저장소가 죽어 있다고 해서 저장 흐름이 멈추면 안 된다.
 *      실패는 null/false 로 돌려주고, 호출부가 그것을 보고 판단한다(조용히 넘기지 않는다).
 *   2. **절대 매달리지 않는다.** open 은 다른 탭이 이전 버전을 잡고 있으면 blocked 로 영원히
 *      멈출 수 있다. 모든 경로에 상한을 건다.
 *
 * IndexedDB 는 실패한다 — 쿼터 초과, 시크릿 모드, DB 손상, iOS 의 장기 미사용 제거.
 * 그래서 「성공했는지」를 호출부가 반드시 확인할 수 있게 만든다.
 */
import { withDeadline, DEADLINE } from './with-deadline.js';

/** @type {Map<string, Promise<IDBDatabase|null>>} */
const openPromises = new Map();

function idbAvailable() {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch (_) {
        return false;
    }
}

/** IDBRequest → Promise. 성공/실패 어느 쪽이든 반드시 정착한다. */
function requestToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('idb-request-failed'));
    });
}

/**
 * DB 를 연다. 같은 이름은 한 번만 연다.
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number) => void} upgrade
 * @returns {Promise<IDBDatabase|null>} 실패 시 null
 */
export function openDb(name, version, upgrade) {
    if (!idbAvailable()) return Promise.resolve(null);
    const cached = openPromises.get(name);
    if (cached) return cached;

    const p = withDeadline(
        new Promise((resolve, reject) => {
            let req;
            try {
                req = indexedDB.open(name, version);
            } catch (e) {
                reject(e);
                return;
            }
            req.onupgradeneeded = (ev) => {
                try {
                    upgrade(req.result, ev.oldVersion || 0);
                } catch (e) {
                    reject(e);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('idb-open-failed'));
            // 다른 탭이 이전 버전을 잡고 있는 경우. 상한이 처리하지만 원인은 남긴다.
            req.onblocked = () => console.warn(`[idb] ${name} open blocked — 다른 탭이 이전 버전 점유 중`);
        }),
        DEADLINE.LOCAL,
        `idb-open:${name}`
    ).catch((e) => {
        console.warn(`[idb] ${name} 열기 실패:`, e?.message || e);
        // 다음 호출에서 다시 시도할 수 있게 캐시를 비운다
        openPromises.delete(name);
        return null;
    });

    openPromises.set(name, p);
    return p;
}

/**
 * 트랜잭션 1회 실행. 실패·타임아웃이면 null.
 * @template T
 * @param {IDBDatabase|null} db
 * @param {string} store
 * @param {IDBTransactionMode} mode
 * @param {(s: IDBObjectStore) => Promise<T>|T} fn
 * @param {string} [label]
 * @returns {Promise<T|null>}
 */
export async function tx(db, store, mode, fn, label = '') {
    if (!db) return null;
    try {
        return await withDeadline(
            (async () => {
                const t = db.transaction(store, mode);
                const s = t.objectStore(store);
                const result = await fn(s);
                // 쓰기는 트랜잭션 complete 까지 봐야 실제로 반영됐다고 말할 수 있다
                if (mode !== 'readonly') {
                    await new Promise((resolve, reject) => {
                        t.oncomplete = () => resolve(undefined);
                        t.onerror = () => reject(t.error || new Error('idb-tx-failed'));
                        t.onabort = () => reject(t.error || new Error('idb-tx-aborted'));
                    });
                }
                return result;
            })(),
            DEADLINE.LOCAL,
            `idb-tx:${label || store}`
        );
    } catch (e) {
        console.warn(`[idb] ${label || store} 트랜잭션 실패:`, e?.message || e);
        return null;
    }
}

/** @returns {Promise<boolean>} 실제로 커밋됐는지 */
export async function put(db, store, value, key) {
    const r = await tx(db, store, 'readwrite', (s) => requestToPromise(key === undefined ? s.put(value) : s.put(value, key)), `put:${store}`);
    return r !== null;
}

/**
 * 여러 건을 **단일 트랜잭션**으로 넣는다.
 * 건당 트랜잭션을 열면 느릴 뿐 아니라, 그 사이에 다른 쓰기가 끼어들어 count 기반 정리(trimOldest)가
 * 어긋난다. 실제로 그렇게 과잉 삭제되는 버그가 났다.
 * @returns {Promise<boolean>} 전부 커밋됐는지
 */
export async function putMany(db, store, values) {
    if (!Array.isArray(values) || values.length === 0) return true;
    const r = await tx(
        db,
        store,
        'readwrite',
        async (s) => {
            for (const v of values) s.put(v);
            return true;
        },
        `putMany:${store}`
    );
    return r !== null;
}

export async function getAll(db, store, count) {
    const r = await tx(db, store, 'readonly', (s) => requestToPromise(count ? s.getAll(undefined, count) : s.getAll()), `getAll:${store}`);
    return Array.isArray(r) ? r : [];
}

export async function get(db, store, key) {
    return tx(db, store, 'readonly', (s) => requestToPromise(s.get(key)), `get:${store}`);
}

export async function del(db, store, key) {
    const r = await tx(db, store, 'readwrite', (s) => requestToPromise(s.delete(key)), `del:${store}`);
    return r !== null;
}

export async function count(db, store) {
    const r = await tx(db, store, 'readonly', (s) => requestToPromise(s.count()), `count:${store}`);
    return typeof r === 'number' ? r : 0;
}

/**
 * 오래된 것부터 지워 최대 개수를 맞춘다 (링버퍼).
 * autoIncrement 키를 쓰는 스토어 전용 — 키 순서가 곧 시간 순서다.
 * @returns {Promise<number>} 지운 개수
 */
export async function trimOldest(db, store, maxEntries) {
    const n = await count(db, store);
    const excess = n - maxEntries;
    if (excess <= 0) return 0;
    const r = await tx(
        db,
        store,
        'readwrite',
        (s) =>
            new Promise((resolve, reject) => {
                let removed = 0;
                const req = s.openCursor();
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur || removed >= excess) {
                        resolve(removed);
                        return;
                    }
                    cur.delete();
                    removed++;
                    cur.continue();
                };
                req.onerror = () => reject(req.error || new Error('idb-cursor-failed'));
            }),
        `trim:${store}`
    );
    return typeof r === 'number' ? r : 0;
}
