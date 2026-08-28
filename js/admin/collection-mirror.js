/**
 * 관리자 범용 컬렉션 미러 — IndexedDB 사본 + 생성축 증분
 *
 * 최상위 컬렉션 하나를 통째로 브라우저에 담아 두고, 이후에는 **새로 생긴 문서만**
 * 당겨온다. 쓰임새와 한계는 collection-mirror-model.js 머리말에 적어 두었다.
 *
 *   전체 재구축  컬렉션 전체를 __name__ 순으로 페이지 다운로드
 *   델타         where(축 > 북마크-6h) — 대개 새 문서만 (usageDaily 만 수정 시각 축)
 *   삭제 감지    getCountFromServer 1회(1읽기), 수가 줄면 전체 재구축
 *   관리자 조치  applyLocalUpsert / applyLocalDelete 로 그 자리에서 미러에 반영
 *
 * 설계 문서: docs/admin-local-mirror.md
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collection,
    documentId,
    getCountFromServer,
    getDocs,
    limit,
    orderBy,
    query,
    startAfter,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { openMirrorDb, idbRequest, idbTxDone, readMeta, writeMeta, clearStore } from './admin-mirror-db.js';
import {
    toMirrorRow,
    rowToDocLike,
    computeCollectionSyncStart,
    decideCollectionSyncMode,
    sortRowsDesc,
    toSortMs,
    flattenForIdb
} from './collection-mirror-model.js';

const PAGE = 500;

/**
 * @param {object} cfg
 * @param {string} cfg.name 컬렉션 이름 (= IDB 스토어 이름 = meta 키)
 * @param {string} cfg.sortField 생성·정렬 축 필드명 (timestamp / generatedAt …)
 * @param {(v:Date)=>any} [cfg.toQueryBound] 델타 쿼리 하한을 이 필드 타입에 맞게 변환
 *        (기본: Date 그대로 — Firestore Timestamp 필드용. ISO 문자열 필드면 toISOString)
 * @param {number} [cfg.fullRebuildMs] 전체 재구축 주기 (기본 7일)
 */
export function createCollectionMirror(cfg) {
    const { name, sortField } = cfg;
    const toQueryBound = cfg.toQueryBound || ((d) => d);
    const fullRebuildMs = cfg.fullRebuildMs || 7 * 24 * 3600 * 1000;
    const collectionPath = `artifacts/${appId}/${name}`;

    let syncInFlight = null;

    const coll = () => collection(db, 'artifacts', appId, name);
    const readOwnMeta = () =>
        readMeta(name, { lastSyncedAt: '', bootstrapDone: false, docCount: 0, serverCount: 0 });

    async function putRows(rows) {
        if (!rows.length) return;
        const database = await openMirrorDb();
        const tx = database.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        rows.forEach((r) => store.put(r));
        await idbTxDone(tx);
    }

    async function deleteIds(ids) {
        if (!ids.length) return;
        const database = await openMirrorDb();
        const tx = database.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        ids.forEach((id) => store.delete(id));
        await idbTxDone(tx);
    }

    async function countMirror() {
        const database = await openMirrorDb();
        const tx = database.transaction(name, 'readonly');
        return idbRequest(tx.objectStore(name).count());
    }

    async function readAllRows() {
        const database = await openMirrorDb();
        const tx = database.transaction(name, 'readonly');
        return (await idbRequest(tx.objectStore(name).getAll())) || [];
    }

    function storeSnap(snap) {
        const rows = snap.docs.map((d) => toMirrorRow({ id: d.id, data: d.data() }, sortField)).filter(Boolean);
        return putRows(rows).then(() => rows.length);
    }

    /** 전체 재구축 — 경로 순이라 정렬 축이 없는 문서도 빠지지 않는다 */
    async function rebuildAll(onProgress) {
        let cursor = null;
        let fetched = 0;
        for (;;) {
            const q = cursor
                ? query(coll(), orderBy(documentId()), startAfter(cursor), limit(PAGE))
                : query(coll(), orderBy(documentId()), limit(PAGE));
            const snap = await getDocs(q);
            if (snap.empty) break;
            fetched += snap.size;
            await storeSnap(snap);
            cursor = snap.docs[snap.docs.length - 1];
            if (typeof onProgress === 'function') onProgress({ stage: 'full', fetched });
            if (snap.size < PAGE) break;
        }
        return fetched;
    }

    /** 델타 — 생성축이 북마크 이후인 문서만 */
    async function pullSince(sinceDate, onProgress) {
        const bound = toQueryBound(sinceDate);
        let cursor = null;
        let fetched = 0;
        for (;;) {
            const parts = [where(sortField, '>', bound), orderBy(sortField, 'asc')];
            const q = cursor
                ? query(coll(), ...parts, startAfter(cursor), limit(PAGE))
                : query(coll(), ...parts, limit(PAGE));
            const snap = await getDocs(q);
            if (snap.empty) break;
            fetched += snap.size;
            await storeSnap(snap);
            cursor = snap.docs[snap.docs.length - 1];
            if (typeof onProgress === 'function') onProgress({ stage: 'delta', fetched });
            if (snap.size < PAGE) break;
        }
        return fetched;
    }

    async function countServer() {
        try {
            return (await getCountFromServer(coll())).data().count ?? null;
        } catch (e) {
            console.warn(`[${name} 미러] 문서 수 조회 실패 — 삭제 감지 생략:`, e?.message || e);
            return null;
        }
    }

    /**
     * 미러를 최신으로 맞춘다.
     * @returns {Promise<{mode:string, reason:string, serverReads:number, docCount:number}>}
     */
    function ensureSynced(onProgress, options = {}) {
        if (syncInFlight && !options.force) return syncInFlight;
        const prev = syncInFlight;
        const run = (async () => {
            if (prev) await prev.catch(() => {});
            try {
                if (navigator?.storage?.persist) navigator.storage.persist();
            } catch { /* 지원 안 하면 그만 */ }

            await refreshAppCheckTokenBeforeFirestore();
            const meta = await readOwnMeta();
            const syncStartedIso = new Date().toISOString();

            const serverCount = await countServer();
            let serverReads = serverCount == null ? 0 : 1;

            const decision = options.force
                ? { mode: 'full', reason: 'forced' }
                : decideCollectionSyncMode(meta, serverCount, fullRebuildMs);

            let fetched = 0;
            if (decision.mode === 'full') {
                fetched = await rebuildAll(onProgress);
            } else {
                fetched = await pullSince(computeCollectionSyncStart(meta.lastSyncedAt), onProgress);
            }
            serverReads += fetched;

            const docCount = await countMirror();
            await writeMeta(name, {
                bootstrapDone: true,
                lastSyncedAt: syncStartedIso,
                docCount,
                serverCount: serverCount == null ? meta.serverCount || 0 : serverCount,
                // 미러 콘솔 표시용 — 마지막 동기화가 왜 그 모드로 돌았는지
                lastSyncMode: decision.mode,
                lastSyncReason: decision.reason
            });
            console.log(
                `[${name} 미러] ${decision.mode}(${decision.reason}): 받음 ${fetched}건 · 서버 읽기 ${serverReads}회 · 보유 ${docCount}건`
            );
            return { mode: decision.mode, reason: decision.reason, serverReads, docCount };
        })();
        syncInFlight = run;
        const release = () => {
            if (syncInFlight === run) syncInFlight = null;
        };
        run.then(release, release);
        return run;
    }

    /**
     * 미러 전체를 Firestore 스냅숏 문서처럼 — 최신순.
     * @param {{rowLimit?: number, filter?: (data:object, id:string)=>boolean}} [opts]
     */
    async function getDocsLike(opts = {}) {
        const rows = sortRowsDesc(await readAllRows(), opts.rowLimit ?? Infinity);
        const docs = rows.map((r) => rowToDocLike(r, collectionPath));
        if (typeof opts.filter !== 'function') return docs;
        return docs.filter((d) => {
            try {
                return opts.filter(d.data(), d.id);
            } catch {
                return false;
            }
        });
    }

    /** 필터를 먼저 걸고 상한을 자른다 — 「조건에 맞는 최신 N건」이 필요할 때 */
    async function getFilteredDocsLike(filter, rowLimit = Infinity) {
        const rows = sortRowsDesc(await readAllRows(), Infinity);
        const out = [];
        for (const r of rows) {
            const docLike = rowToDocLike(r, collectionPath);
            let keep = false;
            try {
                keep = filter(docLike.data(), docLike.id);
            } catch {
                keep = false;
            }
            if (!keep) continue;
            out.push(docLike);
            if (out.length >= rowLimit) break;
        }
        return out;
    }

    /** 미러에 담긴 문서 수 (필터 조건부) — getCountFromServer 대체 */
    async function countLocal(filter) {
        const rows = await readAllRows();
        if (typeof filter !== 'function') return rows.length;
        let n = 0;
        for (const r of rows) {
            const docLike = rowToDocLike(r, collectionPath);
            try {
                if (filter(docLike.data(), docLike.id)) n += 1;
            } catch { /* 판단 불가는 세지 않는다 */ }
        }
        return n;
    }

    /** 관리자 조치 직후 — 서버에 쓴 값을 미러에도 즉시 반영(재조회 없이) */
    async function applyLocalUpsert(id, data) {
        if (!id) return;
        const flat = flattenForIdb(data || {});
        await putRows([{ id, _sortMs: toSortMs((data || {})[sortField]), d: flat }]);
    }

    /** 관리자 조치 직후 — 삭제분을 미러에서 제거 */
    async function applyLocalDelete(ids) {
        await deleteIds(Array.isArray(ids) ? ids.filter(Boolean) : [ids].filter(Boolean));
    }

    /**
     * 이미 미러에 있는 문서의 일부 필드만 갈아끼운다 (숨김·신고 처리 등).
     * 미러에 없으면 아무것도 하지 않는다 — 다음 동기화가 가져온다.
     */
    async function patchLocal(id, patch) {
        if (!id || !patch) return;
        const database = await openMirrorDb();
        const tx = database.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        const row = await idbRequest(store.get(id));
        if (row) {
            row.d = { ...(row.d || {}), ...flattenForIdb(patch) };
            store.put(row);
        }
        await idbTxDone(tx);
    }

    async function getStatus() {
        const meta = await readOwnMeta();
        return {
            name,
            bootstrapDone: !!meta.bootstrapDone,
            lastSyncedAt: meta.lastSyncedAt || '',
            docCount: meta.docCount || 0,
            serverCount: meta.serverCount || 0,
            lastSyncMode: meta.lastSyncMode || '',
            lastSyncReason: meta.lastSyncReason || '',
            /** 정기 전체 재구축이 걸려 있는지 — 콘솔이 상태 뱃지를 가른다 */
            periodicRebuild: Number.isFinite(fullRebuildMs),
            fullRebuildMs
        };
    }

    async function reset() {
        await clearStore(name, name);
        console.log(`[${name} 미러] 초기화 — 다음 동기화 때 전체를 다시 받는다`);
    }

    /** 백업 파일용 — 원본 행 그대로 */
    const exportRows = () => readAllRows();
    /** 백업 복원용 — 행을 그대로 밀어 넣고 메타를 세운다 */
    async function importRows(rows, meta) {
        await putRows(rows || []);
        const docCount = await countMirror();
        await writeMeta(name, {
            bootstrapDone: true,
            lastSyncedAt: meta?.lastSyncedAt || new Date().toISOString(),
            docCount,
            serverCount: meta?.serverCount || 0
        });
        return docCount;
    }

    return {
        name,
        ensureSynced,
        getDocsLike,
        getFilteredDocsLike,
        countLocal,
        applyLocalUpsert,
        applyLocalDelete,
        patchLocal,
        getStatus,
        reset,
        exportRows,
        importRows
    };
}

/** sharedPhotos — 모먼트 관리·대시보드가 읽는다. 생성 축은 Timestamp `timestamp`. */
export const sharedPhotosMirror = createCollectionMirror({ name: 'sharedPhotos', sortField: 'timestamp' });

/**
 * aiDietReports — 규칙이 `allow write: if false` 다. 클라이언트도 관리자도 못 쓰고,
 * 서버가 만들고 나면 수정·삭제가 일어나지 않는다(진짜 append-only). 축은 `generatedAt`.
 *
 * **정기 재구축을 끈다** — 재구축이 잡을 수정·삭제 자체가 없어서, 7일마다 전량을
 * 다시 사는 것은 순수 낭비였다. 삭제 감지(count 1읽기)는 그대로 둔다: Firebase 콘솔에서
 * 손으로 지우는 경우까지 막을 수는 없고, 그때는 count 가 줄어 스스로 재구축한다.
 */
export const aiDietReportsMirror = createCollectionMirror({
    name: 'aiDietReports',
    sortField: 'generatedAt',
    fullRebuildMs: Infinity
});

/** feedPosts — 밀톡. 축은 Timestamp `timestamp`. */
export const feedPostsMirror = createCollectionMirror({ name: 'feedPosts', sortField: 'timestamp' });

/** boardPosts — 게시판. 축은 Timestamp `timestamp`. */
export const boardPostsMirror = createCollectionMirror({ name: 'boardPosts', sortField: 'timestamp' });

/**
 * usageDaily — 대시보드 「페이지별」탭. 문서 id 가 곧 날짜(YYYY-MM-DD)이고, 하루치
 * 문서에 필드별 increment 가 쌓인다.
 *
 * **이 컬렉션만은 축이 「수정 시각」이다.** 다른 넷과 달리 쓰기 경로가 둘뿐이고
 * (`js/usage-metrics.js` 직접 쓰기 · `logUsageMetric` Callable), 둘 다 예외 없이
 * `updatedAt: serverTimestamp()` 를 함께 찍는다. 서버 시각이라 시계 뒤틀림도 없다.
 * 그래서 「새 문서만」이 아니라 **바뀐 문서만** 정확히 따라갈 수 있다 — 오늘 문서는
 * 하루 종일 값이 오르는데, 생성 축이었다면 첫날 이후로 영영 못 따라갔을 것이다.
 *
 * 삭제는 규칙에서 막혀 있다(`allow delete: if false`). 줄어들 일이 없으니 문서 수
 * 감시는 사실상 「빠진 게 없나」 확인용이다.
 */
export const usageDailyMirror = createCollectionMirror({
    name: 'usageDaily',
    sortField: 'updatedAt',
    /**
     * 정기 재구축을 끈다 — 축이 완전해서다. 모든 쓰기가 `updatedAt` 서버 시각을 찍으므로
     * 수정이 델타에 빠짐없이 걸리고, 삭제는 규칙이 막는다(`allow delete: if false`).
     * 재구축이 잡을 것이 없는데 7일마다 전 구간을 다시 사는 것은 낭비였다.
     * 삭제 감지(count)는 aiDietReports 와 같은 이유로 남긴다.
     */
    fullRebuildMs: Infinity
});

export const ALL_COLLECTION_MIRRORS = [
    sharedPhotosMirror,
    aiDietReportsMirror,
    feedPostsMirror,
    boardPostsMirror,
    usageDailyMirror
];
