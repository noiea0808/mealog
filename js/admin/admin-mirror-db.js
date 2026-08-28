/**
 * 관리자 로컬 미러 — IndexedDB 공용 핸들
 *
 * meals·users 등 미러 스토어가 한 데이터베이스를 나눠 쓴다.
 * 스키마를 한 곳에서만 올려야 버전 충돌(두 모듈이 서로 다른 버전으로 open)이 없다.
 *
 * 설계 문서: docs/admin-local-mirror.md
 */

const IDB_NAME = 'mealog-admin-mirror';
/** v1: meals·meta · v2: users · v3: 범용 컬렉션 미러 스토어 · v4: usageDaily */
const IDB_VERSION = 4;

/**
 * 3단계에서 붙은 범용 컬렉션 미러들 — 스토어 이름 = 컬렉션 이름.
 * 여기 이름을 늘리면 다음 버전 올림 때 스토어가 생긴다.
 */
export const COLLECTION_MIRROR_STORES = [
    'sharedPhotos',
    'aiDietReports',
    'feedPosts',
    'boardPosts',
    'usageDaily'
];

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
            for (const name of COLLECTION_MIRROR_STORES) {
                if (database.objectStoreNames.contains(name)) continue;
                // 정렬용 숫자(ms) 인덱스 — 목록이 최신순을 요구한다
                database.createObjectStore(name, { keyPath: 'id' }).createIndex('sortMs', '_sortMs', {
                    unique: false
                });
            }
        };
        /**
         * 다른 탭이 옛 버전으로 이 DB 를 붙들고 있으면 업그레이드가 막힌다. 그때
         * `indexedDB.open` 은 성공도 실패도 하지 않고 **영원히 멈춘다** — 관리자 화면이
         * 「미러 상태를 읽는 중…」에서 굳는 모습이 된다. 스스로 풀 수 없는 대기이므로
         * 실패로 바꿔 사람이 읽을 수 있는 말을 남긴다.
         */
        req.onblocked = () =>
            reject(new Error('다른 탭에서 관리자 페이지가 열려 있어 로컬 미러를 갱신할 수 없습니다. 나머지 탭을 닫고 새로고침해 주세요.'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open 실패'));
    });
    // 실패를 캐시에 남기면 탭을 닫고 새로고침해도 같은 거절이 되돌아온다
    idbPromise.catch(() => {
        idbPromise = null;
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
