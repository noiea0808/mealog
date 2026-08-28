/**
 * 관리자 users 로컬 미러 — 「사용자 분석」용 사본 + 증분 동기화
 *
 * 지금까지 사용자 분석은 탭을 열 때마다 `fetchAllUsersForAdminAnalytics()` 로
 * 전체 사용자를 목록 화면과 똑같이 **풍부하게** 읽어 왔다 — 사용자 문서·settings·
 * userBans·deleteRequests·sharedPhotos·boardPosts·meals 카운트까지. 그런데 분석이
 * 실제로 쓰는 필드는 생년월일·성별·라이프스타일·로그인수단·마지막로그인·가입간격
 * 여섯 뿐이라, 나머지는 읽고 버리는 값이었다.
 *
 * 그래서 여기서는 **루트 users + config/settings 만** 읽어 미러에 담고,
 * 이후에는 마지막 로그인이 움직인 사용자만 다시 읽는다:
 *
 *   전체 재구축  users 전체(문서 경로 순) + 각 settings   ≈ 사용자수 × 2 읽기
 *   델타         users.where(lastLoginAt > 북마크-48h) + 그 사용자들의 settings
 *   삭제 감지    getCountFromServer(users) 1회 — 수가 줄면 전체 재구축
 *
 * 전체 재구축은 7일마다(또는 「전체 새로 읽기」) 한 번이면 충분하다.
 *
 * 설계 문서: docs/admin-local-mirror.md · 순수 로직: users-mirror-model.js
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import {
    collection,
    doc,
    documentId,
    getCountFromServer,
    getDoc,
    getDocs,
    limit,
    orderBy,
    query,
    startAfter,
    where
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { openMirrorDb, idbRequest, idbTxDone, readMeta, writeMeta, clearStore } from './admin-mirror-db.js';
import { buildUserAnalyticsRow, reviveUserRow, computeUsersSyncStart, decideUsersSyncMode } from './users-mirror-model.js';

const META_KEY = 'users';
const PAGE = 100;
/** settings 를 한 번에 몇 개씩 병렬로 읽을지 — 너무 크면 브라우저 커넥션이 막힌다 */
const SETTINGS_CONCURRENCY = 25;

let syncInFlight = null;

function readUsersMeta() {
    return readMeta(META_KEY, { lastSyncedAt: '', bootstrapDone: false, docCount: 0, rootDocCount: 0 });
}

async function putUsers(rows) {
    if (!rows.length) return;
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    rows.forEach((r) => store.put(r));
    await idbTxDone(tx);
}

async function deleteUserKeys(userIds) {
    if (!userIds.length) return;
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readwrite');
    const store = tx.objectStore('users');
    userIds.forEach((id) => store.delete(id));
    await idbTxDone(tx);
}

async function countUsersMirror() {
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readonly');
    return idbRequest(tx.objectStore('users').count());
}

/**
 * 루트 문서 묶음 → 미러 행. settings 를 병렬로 읽어 붙인다.
 * settings 가 없는 사용자(고아·탈퇴 잔재)는 행이 만들어지지 않으므로 미러에서도 지운다.
 */
async function enrichAndStore(rootDocs) {
    const rows = [];
    const orphans = [];
    for (let i = 0; i < rootDocs.length; i += SETTINGS_CONCURRENCY) {
        const chunk = rootDocs.slice(i, i + SETTINGS_CONCURRENCY);
        const settingsSnaps = await Promise.all(
            chunk.map((d) =>
                getDoc(doc(db, 'artifacts', appId, 'users', d.id, 'config', 'settings')).catch(() => null)
            )
        );
        chunk.forEach((d, j) => {
            const snap = settingsSnaps[j];
            const settingsData = snap && snap.exists() ? snap.data() : null;
            const row = buildUserAnalyticsRow(d.id, d.data, settingsData);
            if (row) rows.push(row);
            else orphans.push(d.id);
        });
    }
    await putUsers(rows);
    await deleteUserKeys(orphans);
    return { stored: rows.length, skipped: orphans.length };
}

/** 전체 재구축 — 루트 문서를 경로 순으로 훑는다(lastLoginAt 없는 문서도 포함) */
async function rebuildAll(onProgress) {
    const usersColl = collection(db, 'artifacts', appId, 'users');
    let cursor = null;
    let seen = 0;
    let stored = 0;
    for (;;) {
        const q = cursor
            ? query(usersColl, orderBy(documentId()), startAfter(cursor), limit(PAGE))
            : query(usersColl, orderBy(documentId()), limit(PAGE));
        const snap = await getDocs(q);
        if (snap.empty) break;
        seen += snap.size;
        const res = await enrichAndStore(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
        stored += res.stored;
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress({ stage: 'full', fetched: seen });
        if (snap.size < PAGE) break;
    }
    return { seen, stored };
}

/** 델타 — 마지막 로그인이 북마크 이후인 사용자만 (신규 가입도 여기에 걸린다) */
async function pullUsersSince(sinceDate, onProgress) {
    const usersColl = collection(db, 'artifacts', appId, 'users');
    let cursor = null;
    let seen = 0;
    let stored = 0;
    for (;;) {
        const parts = [where('lastLoginAt', '>', sinceDate), orderBy('lastLoginAt', 'asc')];
        const q = cursor
            ? query(usersColl, ...parts, startAfter(cursor), limit(PAGE))
            : query(usersColl, ...parts, limit(PAGE));
        const snap = await getDocs(q);
        if (snap.empty) break;
        seen += snap.size;
        const res = await enrichAndStore(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
        stored += res.stored;
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress({ stage: 'delta', fetched: seen });
        if (snap.size < PAGE) break;
    }
    return { seen, stored };
}

/** 루트 문서 수 — 삭제 감지용. 실패해도 동기화는 계속한다(감지만 못 할 뿐). */
async function countServerRootDocs() {
    try {
        const snap = await getCountFromServer(collection(db, 'artifacts', appId, 'users'));
        return snap.data().count ?? null;
    } catch (e) {
        console.warn('[users 미러] 루트 문서 수 조회 실패 — 삭제 감지 생략:', e?.message || e);
        return null;
    }
}

/**
 * 미러를 최신으로 맞춘다. 진행 중이면 그 약속을 그대로 돌려준다.
 *
 * @param {(p:{stage:'full'|'delta', fetched:number})=>void} [onProgress]
 * @param {{force?: boolean}} [options] force 면 무조건 전체 재구축
 * @returns {Promise<{mode:'full'|'delta', reason:string, serverReads:number, docCount:number}>}
 */
export function ensureUsersMirrorSynced(onProgress, options = {}) {
    if (syncInFlight && !options.force) return syncInFlight;
    const prev = syncInFlight;
    const run = (async () => {
        // force 로 끼어들었다면 진행 중인 동기화가 끝난 뒤에 — 같은 스토어를 둘이 동시에 쓰지 않게
        if (prev) await prev.catch(() => {});
        try {
            if (navigator?.storage?.persist) navigator.storage.persist();
        } catch { /* 지원 안 하면 그만 */ }

        await refreshAppCheckTokenBeforeFirestore();
        const meta = await readUsersMeta();
        const syncStartedIso = new Date().toISOString();

        const serverRootCount = await countServerRootDocs();
        // 삭제 감지에 쓴 카운트 1회 + 아래에서 실제로 읽는 문서들
        let serverReads = serverRootCount == null ? 0 : 1;

        const decision = options.force
            ? { mode: 'full', reason: 'forced' }
            : decideUsersSyncMode(meta, serverRootCount);

        let seen = 0;
        if (decision.mode === 'full') {
            const res = await rebuildAll(onProgress);
            seen = res.seen;
        } else {
            const since = computeUsersSyncStart(meta.lastSyncedAt);
            const res = await pullUsersSince(since, onProgress);
            seen = res.seen;
        }
        // 루트 1 + settings 1 씩 읽었다
        serverReads += seen * 2;

        const docCount = await countUsersMirror();
        await writeMeta(META_KEY, {
            bootstrapDone: true,
            lastSyncedAt: syncStartedIso,
            docCount,
            rootDocCount: serverRootCount == null ? meta.rootDocCount || 0 : serverRootCount
        });
        console.log(
            `[users 미러] ${decision.mode}(${decision.reason}): 훑음 ${seen}명 · 서버 읽기 ${serverReads}회 · 보유 ${docCount}명`
        );
        return { mode: decision.mode, reason: decision.reason, serverReads, docCount };
    })();
    syncInFlight = run;
    // 자리를 비우는 건 「내가 아직 현재 동기화일 때」만 — force 가 끼어들어 자리를
    // 넘겨받았는데 먼저 끝난 쪽이 그 자리를 지워 버리면 안 된다.
    const release = () => {
        if (syncInFlight === run) syncInFlight = null;
    };
    // then 의 두 갈래 모두 처리하므로 unhandled rejection 이 생기지 않는다.
    // 호출자에게는 run 을 그대로 돌려 실패를 전달한다.
    run.then(release, release);
    return run;
}

/** 미러의 전체 사용자 행 — 분석 코드가 기대하는 Date 로 되살려 돌려준다 */
export async function getAllUsersFromMirror() {
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readonly');
    const rows = await idbRequest(tx.objectStore('users').getAll());
    return (rows || []).map(reviveUserRow);
}

export async function getUsersMirrorStatus() {
    const meta = await readUsersMeta();
    return {
        bootstrapDone: !!meta.bootstrapDone,
        lastSyncedAt: meta.lastSyncedAt || '',
        docCount: meta.docCount || 0,
        rootDocCount: meta.rootDocCount || 0
    };
}

/** 전체 재다운로드 예약 — 다음 동기화가 전체 재구축부터 돈다 */
export async function resetUsersMirror() {
    await clearStore('users', META_KEY);
    console.log('[users 미러] 초기화 — 다음 동기화 때 전체를 다시 받는다');
}

if (typeof window !== 'undefined') {
    window.resetAdminUsersMirror = resetUsersMirror;
    window.adminUsersMirrorStatus = getUsersMirrorStatus;
}
