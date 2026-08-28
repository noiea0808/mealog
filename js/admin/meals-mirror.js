/**
 * 관리자 meals 로컬 미러 — IndexedDB 사본 + 증분 동기화
 *
 * 어드민은 1인·고정 환경이므로, meals 전체를 브라우저 IndexedDB 에 한 번
 * 내려받아 두고(부트스트랩 ~1.2만 읽기) 이후에는 변경분만 당겨온다:
 *
 *   신규·수정  collectionGroup(meals).where(updatedAt > 북마크-48h)
 *   삭제       adminMealTombstones.where(deletedAt > 북마크-48h)  ← onMealWritten 이 남김
 *
 * 분석 화면들은 Firestore 대신 여기의 getMealsInRange() 를 읽는다 — 읽기 0회.
 * 미러가 날아가면(사이트 데이터 삭제 등) 부트스트랩이 다시 돌 뿐, 유실은 없다.
 *
 * 설계 문서: docs/admin-local-mirror.md · 순수 로직: meals-mirror-model.js
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collection,
    collectionGroup,
    documentId,
    getDocs,
    limit,
    orderBy,
    query,
    startAfter,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
    computeSyncStartIso,
    toMirrorRecords,
    tombstonesToKeys,
    nextBookmark
} from './meals-mirror-model.js';
import { openMirrorDb, idbRequest, idbTxDone, readMeta, writeMeta, clearStore } from './admin-mirror-db.js';

const BATCH = 1000;
const META_KEY = 'meals';

/** 동시에 두 번 돌지 않게 — 진행 중이면 같은 약속을 돌려준다 */
let syncInFlight = null;

function readMealsMeta() {
    return readMeta(META_KEY, { lastSyncedAt: '', bootstrapDone: false, docCount: 0 });
}

async function putRecords(records) {
    if (!records.length) return;
    const database = await openMirrorDb();
    const tx = database.transaction('meals', 'readwrite');
    const store = tx.objectStore('meals');
    records.forEach((r) => store.put(r));
    await idbTxDone(tx);
}

async function deleteKeys(keys) {
    if (!keys.length) return;
    const database = await openMirrorDb();
    const tx = database.transaction('meals', 'readwrite');
    const store = tx.objectStore('meals');
    keys.forEach((k) => store.delete(k));
    await idbTxDone(tx);
}

async function countMirror() {
    const database = await openMirrorDb();
    const tx = database.transaction('meals', 'readonly');
    return idbRequest(tx.objectStore('meals').count());
}

/** 스냅숏 배열 → 모델이 원하는 {id, path, data} 배열 */
function snapToDocs(snap) {
    return snap.docs.map((d) => ({ id: d.id, path: d.ref.path, data: d.data() }));
}

/**
 * 부트스트랩 — meals 컬렉션그룹 전체를 문서 경로(__name__) 순으로 페이지 다운로드.
 * date 정렬이 아니라 경로 정렬인 이유: date 없는 문서도 빠짐없이 훑기 위해서다
 * (저장은 date 있는 것만 — toMirrorRecords 가 거른다).
 */
async function bootstrapAll(onProgress) {
    let cursor = null;
    let fetched = 0;
    for (;;) {
        const parts = [orderBy(documentId()), limit(BATCH)];
        const q = cursor
            ? query(collectionGroup(db, 'meals'), orderBy(documentId()), startAfter(cursor), limit(BATCH))
            : query(collectionGroup(db, 'meals'), ...parts);
        const snap = await getDocs(q);
        if (snap.empty) break;
        fetched += snap.size;
        await putRecords(toMirrorRecords(snapToDocs(snap)));
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress({ stage: 'bootstrap', fetched });
        if (snap.size < BATCH) break;
    }
    return fetched;
}

/** 신규·수정 델타 — updatedAt 오름차순 페이지 (컬렉션그룹 updatedAt ASC 인덱스 필요) */
async function pullUpdatedSince(sinceIso, onProgress) {
    let cursor = null;
    let fetched = 0;
    for (;;) {
        const parts = [where('updatedAt', '>', sinceIso), orderBy('updatedAt', 'asc'), limit(BATCH)];
        const q = cursor
            ? query(collectionGroup(db, 'meals'), ...parts.slice(0, 2), startAfter(cursor), limit(BATCH))
            : query(collectionGroup(db, 'meals'), ...parts);
        const snap = await getDocs(q);
        if (snap.empty) break;
        fetched += snap.size;
        await putRecords(toMirrorRecords(snapToDocs(snap)));
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress({ stage: 'delta', fetched });
        if (snap.size < BATCH) break;
    }
    return fetched;
}

/** 삭제 델타 — onMealWritten 이 남긴 툼스톤 소비 */
async function pullTombstonesSince(sinceIso) {
    const coll = collection(db, 'artifacts', appId, 'adminMealTombstones');
    const snap = await getDocs(query(coll, where('deletedAt', '>', sinceIso), orderBy('deletedAt', 'asc')));
    const keys = tombstonesToKeys(snap.docs.map((d) => d.data()));
    await deleteKeys(keys);
    return keys.length;
}

/**
 * 미러를 최신으로 맞춘다. 진행 중이면 그 약속을 그대로 돌려준다.
 *
 * @param {(p:{stage:'bootstrap'|'delta', fetched:number})=>void} [onProgress]
 * @returns {Promise<{mode:'bootstrap'|'delta', fetched:number, removed:number, docCount:number}>}
 */
export function ensureMealsMirrorSynced(onProgress) {
    if (syncInFlight) return syncInFlight;
    syncInFlight = (async () => {
        // 브라우저 자동 정리(eviction)에서 이 사이트의 데이터를 제외해 달라고 요청
        try {
            if (navigator?.storage?.persist) navigator.storage.persist();
        } catch { /* 지원 안 하면 그만 */ }

        await refreshAppCheckTokenBeforeFirestore();
        const meta = await readMealsMeta();
        const syncStartedIso = new Date().toISOString();
        let mode = 'delta';
        let fetched = 0;
        let removed = 0;

        if (!meta.bootstrapDone) {
            mode = 'bootstrap';
            fetched = await bootstrapAll(onProgress);
        } else {
            const sinceIso = computeSyncStartIso(meta.lastSyncedAt);
            if (sinceIso) {
                fetched = await pullUpdatedSince(sinceIso, onProgress);
                removed = await pullTombstonesSince(sinceIso);
            } else {
                // 북마크가 깨져 있으면 부트스트랩부터
                mode = 'bootstrap';
                fetched = await bootstrapAll(onProgress);
            }
        }

        const docCount = await countMirror();
        await writeMeta(META_KEY, {
            bootstrapDone: true,
            lastSyncedAt: nextBookmark(meta.lastSyncedAt, syncStartedIso),
            docCount
        });
        console.log(`[meals 미러] ${mode}: 받음 ${fetched}건 · 지움 ${removed}건 · 보유 ${docCount}건`);
        return { mode, fetched, removed, docCount };
    })().finally(() => {
        syncInFlight = null;
    });
    return syncInFlight;
}

/**
 * 기간(YMD, 경계 포함) 안의 meals 를 미러에서 읽는다 — Firestore 읽기 0회.
 * 반환 형태는 기존 서버 스캔과 동일: {id, userId, ...docData}
 */
export async function getMealsInRange(startYmd, endYmd) {
    const database = await openMirrorDb();
    const tx = database.transaction('meals', 'readonly');
    const index = tx.objectStore('meals').index('date');
    const range = IDBKeyRange.bound(startYmd, endYmd);
    return new Promise((resolve, reject) => {
        const rows = [];
        const req = index.openCursor(range);
        req.onsuccess = () => {
            const cur = req.result;
            if (!cur) {
                resolve(rows);
                return;
            }
            const { k, ...row } = cur.value;
            rows.push(row);
            cur.continue();
        };
        req.onerror = () => reject(req.error);
    });
}

/** 미러 상태 — UI 표시용 */
export async function getMealsMirrorStatus() {
    const meta = await readMealsMeta();
    return { bootstrapDone: !!meta.bootstrapDone, lastSyncedAt: meta.lastSyncedAt || '', docCount: meta.docCount || 0 };
}

/** 전량 재다운로드 — 정합성이 의심될 때 수동으로 (다음 동기화가 부트스트랩부터 돈다) */
export async function resetMealsMirror() {
    await clearStore('meals', META_KEY);
    console.log('[meals 미러] 초기화 — 다음 동기화 때 전량을 다시 받는다');
}

// 콘솔에서 수동 조작할 수 있게
if (typeof window !== 'undefined') {
    window.resetAdminMealsMirror = resetMealsMirror;
    window.adminMealsMirrorStatus = getMealsMirrorStatus;
}
