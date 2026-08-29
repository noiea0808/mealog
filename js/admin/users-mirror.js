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
import {
    buildUserMirrorRow,
    reviveUserRow,
    computeUsersSyncStart,
    decideUsersSyncMode,
    USERS_MIRROR_ROW_SCHEMA
} from './users-mirror-model.js';
import { dailyJournalHasContent, normalizeDailyJournalEntry } from '../utils/daily-journal-data.js';

const META_KEY = 'users';
const PAGE = 100;
/** settings 를 한 번에 몇 개씩 병렬로 읽을지 — 너무 크면 브라우저 커넥션이 막힌다 */
const SETTINGS_CONCURRENCY = 25;

let syncInFlight = null;

function readUsersMeta() {
    return readMeta(META_KEY, { lastSyncedAt: '', bootstrapDone: false, docCount: 0, rootDocCount: 0, rowSchema: 0 });
}

/**
 * settings 의 `dailyComments` 맵 → 하루 소감 자국 배열.
 *
 * 대시보드가 「하루 소감」행과 「기록·전체」를 셀 때 쓴다. 예전에는 그 숫자를 위해
 * `collectionGroup('config')` 를 통째로 훑었는데, users 미러가 어차피 사람마다
 * settings 를 읽고 있어서 **읽기를 하나도 더 쓰지 않고** 같은 값을 얻는다.
 *
 * 본문은 담지 않는다 — 필요한 것은 「어느 날짜에 내용 있는 소감이 있었나」와,
 * 시간대 행이 쓸 기록 시각뿐이다.
 */
function journalMarksFromSettings(settingsData) {
    const dc = settingsData?.dailyComments;
    if (!dc || typeof dc !== 'object') return [];
    const out = [];
    for (const [dateStr, raw] of Object.entries(dc)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) continue;
        const entry = normalizeDailyJournalEntry(raw);
        if (!dailyJournalHasContent(entry)) continue;
        out.push({ d: String(dateStr), r: entry.recordedAt || '' });
    }
    return out;
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
 *
 * settings 가 없는 고아 문서도 **담는다** (`hasSettings: false`). 「사용자 분석」과
 * 목록은 예전처럼 건너뛰지만, 대시보드 신규 사용자는 루트 `createdAt` 만으로 세기
 * 때문이다 — 여기서 지우면 서버 전량 조회 시절보다 신규 사용자가 줄어 보인다.
 */
async function enrichAndStore(rootDocs) {
    const rows = [];
    let orphans = 0;
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
            const row = buildUserMirrorRow(d.id, d.data, settingsData, journalMarksFromSettings(settingsData));
            if (!row) return;
            if (!row.hasSettings) orphans += 1;
            rows.push(row);
        });
    }
    await putUsers(rows);
    return { stored: rows.length, skipped: orphans };
}

/**
 * 전체 재구축 — 루트 문서를 경로 순으로 훑는다(lastLoginAt 없는 문서도 포함).
 *
 * 훑고 나면 **서버에 없던 행을 지운다.** 탈퇴한 사용자는 루트 문서째 사라져 이 순회에
 * 걸리지 않으므로, 담기만 해서는 옛 행이 미러에 영원히 남는다 (전체 재구축을 부르는
 * 계기가 「문서 수가 줄었다」인데, 정작 그 재구축이 줄어든 몫을 지우지 못했다).
 *
 * 먼저 비우지 않는 이유: 순회가 중간에 끊기면 미러가 통째로 빈 채로 남는다.
 * 다 받은 뒤에 차집합만 지우면 실패해도 옛 사본이 그대로 남는다.
 */
async function rebuildAll(onProgress) {
    const usersColl = collection(db, 'artifacts', appId, 'users');
    let cursor = null;
    let seen = 0;
    let stored = 0;
    const seenIds = new Set();
    for (;;) {
        const q = cursor
            ? query(usersColl, orderBy(documentId()), startAfter(cursor), limit(PAGE))
            : query(usersColl, orderBy(documentId()), limit(PAGE));
        const snap = await getDocs(q);
        if (snap.empty) break;
        seen += snap.size;
        snap.docs.forEach((d) => seenIds.add(d.id));
        const res = await enrichAndStore(snap.docs.map((d) => ({ id: d.id, data: d.data() })));
        stored += res.stored;
        cursor = snap.docs[snap.docs.length - 1];
        if (typeof onProgress === 'function') onProgress({ stage: 'full', fetched: seen });
        if (snap.size < PAGE) break;
    }
    const stale = (await getAllUserIdsInMirror()).filter((id) => !seenIds.has(id));
    await deleteUserKeys(stale);
    return { seen, stored, removed: stale.length };
}

/** 미러가 들고 있는 userId 전부 — 전체 재구축의 차집합 계산용 */
async function getAllUserIdsInMirror() {
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readonly');
    return (await idbRequest(tx.objectStore('users').getAllKeys())) || [];
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
            rowSchema: USERS_MIRROR_ROW_SCHEMA,
            docCount,
            rootDocCount: serverRootCount == null ? meta.rootDocCount || 0 : serverRootCount,
            lastSyncMode: decision.mode,
            lastSyncReason: decision.reason
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

/** 미러에 담긴 행 전부 (고아 포함) — 되살린 Date 로 */
export async function getAllUserMirrorRows() {
    const database = await openMirrorDb();
    const tx = database.transaction('users', 'readonly');
    const rows = await idbRequest(tx.objectStore('users').getAll());
    return (rows || []).map(reviveUserRow);
}

/**
 * 「사용자 분석」용 사용자 행 — settings 없는 고아 문서는 뺀다(목록과 같은 규칙).
 * 고아까지 필요한 대시보드는 `getAllUserMirrorRows()` 를 쓴다.
 */
export async function getAllUsersFromMirror() {
    const rows = await getAllUserMirrorRows();
    return rows.filter((r) => r && r.hasSettings !== false);
}

export async function getUsersMirrorStatus() {
    const meta = await readUsersMeta();
    return {
        bootstrapDone: !!meta.bootstrapDone,
        lastSyncedAt: meta.lastSyncedAt || '',
        docCount: meta.docCount || 0,
        rootDocCount: meta.rootDocCount || 0,
        rowSchema: meta.rowSchema || 0,
        lastSyncMode: meta.lastSyncMode || '',
        lastSyncReason: meta.lastSyncReason || '',
        /**
         * users 는 정기 재구축이 **필요하다** — saveSettings 가 아무 도장도 찍지 않아서
         * (setDoc merge 뿐), 로그인 없이 프로필만 고친 변경은 어떤 축으로도 못 잡는다.
         * 7일 재구축이 유일한 안전망이다.
         */
        periodicRebuild: true
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
