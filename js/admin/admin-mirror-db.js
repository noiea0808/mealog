/**
 * 관리자 로컬 미러 — IndexedDB 공용 핸들
 *
 * meals·users 등 미러 스토어가 한 데이터베이스를 나눠 쓴다.
 * 스키마를 한 곳에서만 올려야 버전 충돌(두 모듈이 서로 다른 버전으로 open)이 없다.
 *
 * 설계 문서: docs/admin-local-mirror.md
 */

const IDB_NAME = 'mealog-admin-mirror';
/** v1: meals·meta · v2: users 추가 */
const IDB_VERSION = 2;

let idbPromise = null;

export function openMirrorDb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const database = req.result;
            if (!database.objectStoreNames.contains('meals')) {
                const store = database.createObjectStore('meals', { keyPath: 'k' });
                store.createIndex('date', 'date', { unique: false });
            }
            if (!database.objectStoreNames.contains('meta')) {
                database.createObjectStore('meta', { keyPath: 'k' });
            }
            if (!database.objectStoreNames.contains('users')) {
                database.createObjectStore('users', { keyPath: 'userId' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open 실패'));
    });
    return idbPromise;
}

export function idbRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('IDB 트랜잭션 중단'));
    });
}

/** meta 스토어의 한 칸 — 스토어 이름(`meals`·`users`)을 키로 쓴다 */
export async function readMeta(key, fallback) {
    const database = await openMirrorDb();
    const tx = database.transaction('meta', 'readonly');
    const row = await idbRequest(tx.objectStore('meta').get(key));
    return row || { k: key, ...fallback };
}

export async function writeMeta(key, meta) {
    const database = await openMirrorDb();
    const tx = database.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ ...meta, k: key });
    await idbTxDone(tx);
}

/** 스토어를 통째로 비운다 (해당 meta 칸도 함께) */
export async function clearStore(storeName, metaKey) {
    const database = await openMirrorDb();
    const tx = database.transaction([storeName, 'meta'], 'readwrite');
    tx.objectStore(storeName).clear();
    tx.objectStore('meta').delete(metaKey);
    await idbTxDone(tx);
}
