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
import { openDb, tx, getAll, get as idbGet, del as idbDel, count as idbCount, put as idbPut } from './idb.js';
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
    const rows = await getAll(db, STORE);
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
     */
    const payload = existing?.payload
        ? { ...existing.payload, ...(entry.payload || {}) }
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
export async function listPending(uid) {
    const db = await ensureDb();
    if (!db) return [];
    const rows = await getAll(db, STORE);
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
    const db = await ensureDb();
    if (!db) return false;
    const wasPresent = liveIndex.has(key);
    const ok = await idbDel(db, STORE, key);
    if (ok && wasPresent) {
        liveIndex.delete(key);
        notifyIndexChanged();
    }
    // 없던 키를 지우는 호출은 정상 흐름(리스너 ack)이라 로그를 남기지 않는다 — 소음만 된다
    if (wasPresent) diag('outbox.remove', { key: String(key).slice(0, 60), ok });
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

/** 배지·표시용 — 아웃박스 크기가 곧 「아직 안 올라간 개수」다 (§4.3) */
export async function pendingCount(uid) {
    const db = await ensureDb();
    if (!db) return 0;
    if (!uid) return idbCount(db, STORE);
    return (await listPending(uid)).length;
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
