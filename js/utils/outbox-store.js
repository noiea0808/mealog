/**
 * 아웃박스 저장소 — 이 앱이 **직접 소유하는** 미전송 큐.
 *
 * 불변식 (docs/sync-outbox-design.md §1):
 *   사용자가 저장을 누른 기록은, 어떤 fallible 한 단계도 시작하기 전에 이미 내구 저장돼 있다.
 *
 * 왜 Firestore 의 로컬 큐로는 안 되는가 (§2): 큐에 못 들어가는 경로가 셋 있다 —
 * 상위 타임아웃이 setDoc 전에 터지는 경우, Callable 폴백, 사진. 그때 기록 본문을 저장하는
 * 곳이 지금까지 **어디에도 없었다**(localStorage 에는 ID 세 종류만 있었다).
 *
 * 지우는 시점은 딱 하나 — **서버 존재가 확인됐을 때**. 그 외 어떤 이유로도 지우지 않는다.
 */
import { openDb, tx, getAll, getAllOrNull, get as idbGet, del as idbDel, count as idbCount, put as idbPut } from './idb.js';
import { diag } from './diagnostics.js';

const DB_NAME = 'mealog-outbox';
const DB_VERSION = 1;
const STORE = 'entries';

/** 콘텐츠: 사용자가 쓴 것. 자동 삭제 없음 */
export const CLASS_CONTENT = 'content';
/** 상호작용: 좋아요·읽음 등. 오래되면 만료 허용 */
export const CLASS_INTERACTION = 'interaction';

/** 상호작용 항목의 만료 (콘텐츠는 만료 없음) */
const INTERACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ── 동기 인덱스 ────────────────────────────────────────────────────────────────
 * 타임라인 렌더와 배지는 **동기**로 「이 기록이 아직 안 올라갔나」를 물어야 하는데,
 * IndexedDB 조회는 비동기다. 그래서 키 집합만 메모리에 미러링한다.
 *
 * 이 인덱스가 곧 표시의 단일 기준이다 — 예전에 배지(칩 기준)와 드레인(칩·inFlight·실패 기준)이
 * 서로 다른 집합을 세다가 「N 이 떠 있는데 눌러도 아무 일 없는 버튼」이 생겼던 문제가,
 * 기준이 하나뿐이면 원리적으로 생길 수 없다.
 *
 * @type {Map<string, { uid: string, permanent: boolean }>}
 */
const liveIndex = new Map();
let indexHydrated = false;
/** @type {Set<() => void>} 인덱스가 바뀌면 알린다 (배지·타임라인 갱신) */
const indexListeners = new Set();

function notifyIndexChanged() {
    for (const fn of indexListeners) {
        try {
            fn();
        } catch (_) {
            /* ignore */
        }
    }
}

export function subscribeOutboxIndex(fn) {
    if (typeof fn !== 'function') return () => {};
    indexListeners.add(fn);
    return () => indexListeners.delete(fn);
}

/** 동기 판정 — 렌더 경로에서 쓴다. 부팅 직후 hydrate 전에는 false 다(곧 이벤트로 갱신된다). */
export function isPendingSync(target, id) {
    if (id == null || id === '') return false;
    return liveIndex.has(outboxKey(target, id));
}

/** 동기 판정 — 재시도해도 무의미한 상태인가 */
export function isPermanentSync(target, id) {
    if (id == null || id === '') return false;
    return liveIndex.get(outboxKey(target, id))?.permanent === true;
}

/** 동기 개수 — 배지가 이 값을 그대로 쓴다 */
export function pendingCountSync(uid) {
    if (!uid) return liveIndex.size;
    let n = 0;
    for (const v of liveIndex.values()) if (v.uid === uid) n++;
    return n;
}

export function isOutboxIndexReady() {
    return indexHydrated;
}

/** 부팅 시 1회 — IndexedDB 의 키를 메모리로 올린다 */
export async function hydrateOutboxIndex() {
    const db = await ensureDb();
    if (!db) {
        indexHydrated = true;
        return 0;
    }
    const rows = await getAllOrNull(db, STORE);
    /**
     * 못 읽었으면 **인덱스를 비우지 않는다.** 여기서 clear 하면 아직 안 올라간 기록이
     * 화면에서 「반영됨」으로 보이고 배지도 사라진다 — 읽기 한 번 실패한 것을 데이터가
     * 없는 것으로 단정하는 셈이다. hydrated 로도 표시하지 않아 다음 기회에 다시 시도된다.
     */
    if (rows === null) {
        diag('outbox.hydrate.failed', { kept: liveIndex.size });
        return -1;
    }
    liveIndex.clear();
    for (const r of rows) liveIndex.set(r.key, { uid: r.uid, permanent: r.permanent === true });
    indexHydrated = true;
    notifyIndexChanged();
    diag('outbox.hydrate', { n: liveIndex.size });
    return liveIndex.size;
}

let dbPromise = null;

function ensureDb() {
    if (!dbPromise) {
        dbPromise = openDb(DB_NAME, DB_VERSION, (db) => {
            if (!db.objectStoreNames.contains(STORE)) {
                const s = db.createObjectStore(STORE, { keyPath: 'key' });
                s.createIndex('uid', 'uid', { unique: false });
                s.createIndex('createdAt', 'createdAt', { unique: false });
            }
        });
    }
    return dbPromise;
}

/** `${target}:${id}` — 같은 대상의 중복 항목이 쌓이지 않게 */
export function outboxKey(target, id) {
    return `${target}:${id}`;
}

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Blob) && !(v instanceof Date);
}

/**
 * 평범한 객체만 재귀 병합. 배열·Blob·Date 는 통째로 교체한다.
 *
 * 배열을 병합하지 않는 이유: photos 같은 목록은 「합집합」이 아니라 「마지막 상태」가 맞다.
 * 사진 두 장을 지우고 저장했는데 병합으로 되살아나면 그것도 사고다.
 */
function deepMergePlain(base, patch) {
    if (!isPlainObject(base)) return patch;
    if (!isPlainObject(patch)) return patch;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMergePlain(base[k], v) : v;
    }
    return out;
}

/**
 * 항목을 넣는다 (같은 key 가 있으면 대체하되, payload 병합이 필요한 대상은 병합).
 *
 * **반환값을 반드시 확인해야 한다.** false 면 내구화에 실패한 것이므로 호출부는
 * 성공 팝업을 띄우면 안 되고 모달도 닫으면 안 된다(§4.2). 조용히 넘어가면 불변식이
 * 소리 없이 깨지고, 지금까지와 똑같은 모양의 유실이 된다.
 *
 * @param {{
 *   target: string, id: string, uid: string, op?: 'upsert'|'delete',
 *   class?: string, payload?: object, photos?: Blob[], originals?: Blob[]|null,
 *   mergePayload?: boolean
 * }} entry
 * @returns {Promise<boolean>} 실제로 커밋됐는지
 */
export async function enqueue(entry) {
    const db = await ensureDb();
    if (!db) {
        diag('outbox.enqueue.fail', { target: entry?.target, reason: 'no-db' });
        return false;
    }
    const key = outboxKey(entry.target, entry.id);
    const now = new Date().toISOString();

    const existing = entry.mergePayload ? await idbGet(db, STORE, key) : null;
    /**
     * userSettings 처럼 **단일 큰 문서**를 겨냥하는 대상은 덮어쓰면 안 된다.
     * 하루 소감 저장과 프로필 수정이 같은 문서를 두고 서로를 지우게 된다.
     *
     * 얕은 병합으로는 부족하다 — payload 가 { settings: {...} } 형태라, 얕게 합치면
     * settings 가 통째로 교체돼 정확히 그 사고가 난다(실측으로 확인됨).
     */
    const payload = existing?.payload
        ? deepMergePlain(existing.payload, entry.payload || {})
        : entry.payload || {};

    const row = {
        key,
        target: entry.target,
        id: String(entry.id),
        uid: String(entry.uid || ''),
        op: entry.op || 'upsert',
        class: entry.class || CLASS_CONTENT,
        payload,
        photos: Array.isArray(entry.photos) ? entry.photos : [],
        originals: Array.isArray(entry.originals) ? entry.originals : null,
        updatedAt: now,
        createdAt: existing?.createdAt || now,
        attempts: 0,
        lastError: null,
        permanent: false
    };

    const ok = await idbPut(db, STORE, row);
    if (ok) {
        liveIndex.set(key, { uid: row.uid, permanent: false });
        notifyIndexChanged();
    }
    diag(ok ? 'outbox.enqueue' : 'outbox.enqueue.fail', {
        target: row.target,
        op: row.op,
        cls: row.class,
        photos: row.photos.length,
        merged: !!existing
    });
    return ok;
}

/**
 * 쿼터 초과 시 원본 사진부터 버려 공간을 확보하고 재시도 (§4.2).
 * 다운스케일본은 남기므로 사진 자체를 잃지는 않는다.
 * @returns {Promise<boolean>}
 */
export async function enqueueWithQuotaRelief(entry) {
    if (await enqueue(entry)) return true;

    diag('outbox.quota.relief', { target: entry?.target });
    const dropped = await dropAllOriginals();
    if (dropped > 0 && (await enqueue(entry))) return true;

    // 원본을 버려도 안 되면 사진 없이 본문만이라도 — 텍스트를 잃는 것이 최악이다
    if (Array.isArray(entry.photos) && entry.photos.length > 0) {
        const ok = await enqueue({ ...entry, photos: [], originals: null, photosDropped: true });
        diag('outbox.enqueue.textOnly', { target: entry?.target, ok });
        return ok;
    }
    return false;
}

/** 업로드가 끝난 항목의 원본을 버린다 (§4.6 — 저장소 비용을 일시적으로만 지불) */
export async function clearOriginals(key) {
    const db = await ensureDb();
    if (!db) return false;
    const row = await idbGet(db, STORE, key);
    if (!row || !row.originals) return false;
    return idbPut(db, STORE, { ...row, originals: null });
}

async function dropAllOriginals() {
    const db = await ensureDb();
    if (!db) return 0;
    const rows = await getAll(db, STORE);
    let n = 0;
    for (const r of rows) {
        if (!r.originals) continue;
        if (await idbPut(db, STORE, { ...r, originals: null })) n++;
    }
    return n;
}

/** @returns {Promise<Array<object>>} 오래된 것부터 */
/**
 * 미전송 항목 전체. **읽지 못했으면 `null`** — 빈 배열과 구분된다.
 *
 * 이 구분이 없을 때 실제로 난 사고: `getAll` 이 데드라인에 걸려 `[]` 를 돌려주면 워커는
 * 「큐가 비었다」로 읽고 그대로 쉰다. 배지는 부팅 때 채운 메모리 인덱스를 보므로 N 이
 * 그대로 떠 있고, 사용자가 FAB 을 눌러도 같은 빈 배열이 나와 아무 시도도 일어나지 않는다.
 * 항목은 앱을 다시 깔아도 IndexedDB 에 남아 영영 갇힌다.
 *
 * **저장소가 아예 없는 것**(시크릿 모드 등)과는 구분한다. 그때는 내구화된 항목도 존재할 수
 * 없으므로 「비었다」가 참이고, 영영 재시도해 봐야 소용이 없다 — 빈 배열로 답한다.
 * `null` 은 「스토어는 있는데 이번 읽기를 못 했다」는 뜻이며 그 경우에만 판단을 미룬다.
 *
 * @returns {Promise<Array|null>} null = 읽기 실패(모름)
 */
export async function listPending(uid) {
    const db = await ensureDb();
    if (!db) return []; // 저장소 자체가 없다 = 담긴 것도 없다 (§4.2 — 이때는 조용히 비어 있는 게 맞다)
    const rows = await getAllOrNull(db, STORE);
    if (rows === null) {
        diag('outbox.list.failed', { uid: uid ? String(uid).slice(0, 8) : '' });
        return null;
    }
    return rows
        .filter((r) => !uid || r.uid === uid)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function getEntry(key) {
    const db = await ensureDb();
    if (!db) return null;
    return idbGet(db, STORE, key);
}

/** 서버 존재가 확인됐을 때만 부른다 */
export async function remove(key) {
    /**
     * 인덱스에 없으면 IndexedDB 를 건드리지 않는다.
     *
     * 이 함수는 리스너가 ack 한 **모든** 문서마다 불린다(onServerDocumentAcknowledged).
     * 스냅샷에 50건이 오면 50번 불리는데, 그중 아웃박스에 실제로 있는 건 보통 0~1건이다.
     * 인덱스가 메모리에 있으므로 그 판정은 공짜다 — 없으면 트랜잭션을 아예 열지 않는다.
     */
    if (!liveIndex.has(key)) return true;
    const db = await ensureDb();
    if (!db) return false;
    const ok = await idbDel(db, STORE, key);
    if (ok) {
        liveIndex.delete(key);
        notifyIndexChanged();
    }
    diag('outbox.remove', { key: String(key).slice(0, 60), ok });
    return ok;
}

/** 시도 실패 기록. 네트워크성 실패는 **절대** permanent 가 아니다 (§4.4) */
export async function markAttempt(key, error, permanent = false) {
    const db = await ensureDb();
    if (!db) return false;
    const row = await idbGet(db, STORE, key);
    if (!row) return false;
    const ok = await idbPut(db, STORE, {
        ...row,
        attempts: (row.attempts || 0) + 1,
        lastError: error
            ? { code: String(error.code || ''), message: String(error.message || error).slice(0, 200), at: new Date().toISOString() }
            : null,
        permanent: permanent === true
    });
    if (ok && liveIndex.has(key)) {
        liveIndex.set(key, { uid: row.uid, permanent: permanent === true });
        notifyIndexChanged(); // 영구 실패로 바뀌면 표시가 달라져야 한다
    }
    return ok;
}

/**
 * 영구 실패 표식만 푼다. **`attempts` 와 `lastError` 는 건드리지 않는다.**
 *
 * 사용자가 재전송을 직접 누른 것이 §4.4 가 말하는 「개입」이다. 그때까지 이 상태에는
 * 빠져나올 길이 아예 없었다 — 워커는 permanent 를 거르고, 배지는 그것까지 세고,
 * content 등급은 만료도 없어서 항목이 영원히 갇혔다.
 *
 * attempts 를 함께 리셋하면 백오프 시계가 0 으로 돌아가 6초 틱마다 재시도하는 뜨거운
 * 루프가 된다(ops.saveSettings 의 `fromOutbox` 가드가 막는 것과 같은 함정). 그래서
 * 표식만 푼다 — 다시 실패하면 워커가 그 자리에서 도로 permanent 로 찍는다.
 *
 * @returns {Promise<boolean>} 실제로 풀었는지 (원래 permanent 가 아니었으면 false)
 */
export async function clearPermanent(key) {
    const db = await ensureDb();
    if (!db) return false;
    const row = await idbGet(db, STORE, key);
    if (!row || row.permanent !== true) return false;
    const ok = await idbPut(db, STORE, { ...row, permanent: false });
    if (ok) {
        liveIndex.set(key, { uid: row.uid, permanent: false });
        notifyIndexChanged();
        diag('outbox.permanent.cleared', { key: String(key).slice(0, 60), attempts: row.attempts || 0 });
    }
    return ok;
}

/** 배지·표시용 — 아웃박스 크기가 곧 「아직 안 올라간 개수」다 (§4.3) */
export async function pendingCount(uid) {
    const db = await ensureDb();
    if (!db) return 0;
    if (!uid) return idbCount(db, STORE);
    // 읽기 실패는 0 이 아니다 — 모르면 메모리 인덱스가 아는 값을 쓴다
    const rows = await listPending(uid);
    return rows === null ? pendingCountSync(uid) : rows.length;
}

/** id 로 아웃박스에 있는지 — find-unique-meals 의 orphan 보호가 이 한 줄로 대체된다 */
export async function hasEntry(target, id) {
    const row = await getEntry(outboxKey(target, id));
    return !!row;
}

/**
 * 만료 정리. **콘텐츠 등급은 절대 지우지 않는다** — 데이터 소멸은 사용자의 명시적 행동으로만.
 * 상호작용 등급만 TTL 을 넘기면 버린다.
 * @returns {Promise<number>} 지운 개수
 */
export async function expireInteractions() {
    const db = await ensureDb();
    if (!db) return 0;
    const rows = await getAll(db, STORE);
    const cutoff = Date.now() - INTERACTION_TTL_MS;
    let n = 0;
    for (const r of rows) {
        if (r.class !== CLASS_INTERACTION) continue;
        if (new Date(r.createdAt).getTime() > cutoff) continue;
        if (await idbDel(db, STORE, r.key)) {
            liveIndex.delete(r.key);
            n++;
        }
    }
    if (n > 0) {
        notifyIndexChanged();
        diag('outbox.expire', { n });
    }
    return n;
}

/** 탈퇴 시에만 — 해당 uid 항목 전체 제거 */
export async function purgeUser(uid) {
    const db = await ensureDb();
    if (!db || !uid) return 0;
    const rows = await listPending(uid);
    if (rows === null) return 0; // 못 읽었으면 지우지도 않는다
    let n = 0;
    for (const r of rows) {
        if (await idbDel(db, STORE, r.key)) {
            liveIndex.delete(r.key);
            n++;
        }
    }
    if (n > 0) notifyIndexChanged();
    diag('outbox.purgeUser', { n });
    return n;
}

/** 개발·진단용 */
export async function dumpOutbox() {
    const db = await ensureDb();
    if (!db) return [];
    const rows = await getAll(db, STORE);
    return rows.map((r) => ({
        key: r.key,
        target: r.target,
        op: r.op,
        class: r.class,
        photos: r.photos?.length || 0,
        hasOriginals: !!r.originals,
        attempts: r.attempts,
        permanent: r.permanent,
        createdAt: r.createdAt,
        lastError: r.lastError
    }));
}

if (typeof window !== 'undefined') {
    window.Mealog = window.Mealog || {};
    window.Mealog.dumpOutbox = dumpOutbox;
}

export { STORE as OUTBOX_STORE, tx as outboxTx };
