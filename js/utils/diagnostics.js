/**
 * 동기화 진단 계측 — 추론을 측정으로.
 *
 * 왜 새로 만드는가: 기존 `error-reporting.js` 는 이 서브시스템의 실패를 **원리적으로 볼 수 없다.**
 *   1. `window.error` 와 `unhandledrejection` 만 잡는데, 여기서 문제가 되는 실패는 전부
 *      catch 로 삼켜져 console.warn 으로만 남는다. `save-with-timeout.js` 는
 *      `runPromise.catch(() => {})` 로 unhandledrejection 을 **명시적으로 막기까지 한다.**
 *   2. 게다가 `errorLogs` 컬렉션은 규칙이 `allow write: if false` 라 클라이언트 쓰기가 항상
 *      permission-denied 로 실패해 왔다 — 텔레메트리가 0이었다.
 *
 * 그 결과 2026-06~08 의 13차례 수정이 전부 증거 없이 추론만으로 이뤄졌다. 가설을 세우고, 고치고,
 * 증상이 사라지면 맞았다고 판단했지만 **실제로 무엇이 발화했는지는 아무도 몰랐다.**
 *
 * 전송 방식이 핵심이다. Firestore 로 바로 보내면 **네트워크 문제일 때 못 보낸다** — 지금 구조의
 * 근본 결함이 그것이다. 그래서 로컬 링버퍼에 남기고, 채널이 살아 있는 것이 관측된 뒤에 묶어서 올린다.
 *
 * 설계: `docs/sync-outbox-design.md` §4.9
 */
import { openDb, putMany, getAll, trimOldest, del } from './idb.js';
import { withDeadline, withDeadlineOr, DEADLINE, registerDeadlineSink } from './with-deadline.js';

const DB_NAME = 'mealog-diagnostics';
const DB_VERSION = 1;
const STORE = 'events';

/** 링버퍼 상한. 넘으면 오래된 것부터 버린다 — 진단은 최근 것이 중요하다. */
const MAX_BUFFERED_EVENTS = 600;
/** 메모리에 이만큼 모이면 IDB 로 내린다. 이벤트마다 트랜잭션을 열면 저장 경로가 느려진다. */
const FLUSH_THRESHOLD = 12;
/** 이 시간마다도 내린다 (앱이 조용해도 유실되지 않게) */
const FLUSH_INTERVAL_MS = 15000;
/** 업로드 1회당 최대 이벤트 수 — 문서 크기 상한(1MB) 여유 있게 */
const UPLOAD_BATCH = 300;
/** 채널이 이보다 최근에 살아 있었을 때만 업로드를 시도한다 */
const CHANNEL_FRESH_MS = 30000;
/** 업로드 최소 간격 */
const UPLOAD_MIN_INTERVAL_MS = 120000;

const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** @type {Array<object>} IDB 로 내리기 전 메모리 버퍼 */
let pending = [];
let dbPromise = null;
let flushTimer = 0;
let lastUploadAt = 0;
let uploadInFlight = false;
let enabled = true;

function ensureDb() {
    if (!dbPromise) {
        dbPromise = openDb(DB_NAME, DB_VERSION, (db) => {
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: '_k', autoIncrement: true });
            }
        });
    }
    return dbPromise;
}

/**
 * 이벤트 1건 기록. **동기 호출이고 절대 던지지 않는다.**
 * 저장 경로 한가운데서 불리므로 await 하지 않는다 — 계측이 본 작업을 늦추면 안 된다.
 *
 * @param {string} ev 점 표기 이벤트 이름 (예: 'save.setdoc.begin')
 * @param {object} [detail] 작은 값만. PII·사진·본문은 절대 넣지 않는다.
 */
export function diag(ev, detail) {
    if (!enabled) return;
    try {
        pending.push({
            t: new Date().toISOString(),
            ev: String(ev),
            sid: sessionId,
            d: detail && typeof detail === 'object' ? detail : undefined
        });
        if (pending.length >= FLUSH_THRESHOLD) void flush('threshold');
        else scheduleFlush();
    } catch (_) {
        /* 계측은 절대 본 작업을 방해하지 않는다 */
    }
}

/**
 * 저장 1건이 어디까지 갔는지 — 진단 A 검증용.
 *
 * 가설은 이렇다: 반쯤 끊긴 연결에서 토큰·App Check 왕복이 매달려, 상위 10초 타임아웃이
 * **setDoc 이 호출되기도 전에** 터진다. 그러면 Firestore 로컬 큐에 아무것도 없고, 기록은
 * RAM 에만 남아 앱이 죽는 순간 사라진다.
 *
 * 이걸 확인하려면 타임아웃 이벤트가 「그때 setDoc 까지 갔었는가」를 스스로 답해야 한다.
 * 두 이벤트를 나중에 조인하지 않아도 되게 여기서 단계를 들고 있는다.
 *
 * @type {Map<string, string>}
 */
const savePhase = new Map();
/** 누수 방지 — 저장 건수가 많은 세션에서도 무한히 커지지 않게 */
const SAVE_PHASE_MAX = 50;

/** @param {string} id @param {string} phase */
export function markSavePhase(id, phase) {
    if (!id) return;
    try {
        if (savePhase.size >= SAVE_PHASE_MAX) {
            const oldest = savePhase.keys().next().value;
            if (oldest !== undefined) savePhase.delete(oldest);
        }
        savePhase.set(String(id), phase);
    } catch (_) {
        /* ignore */
    }
}

/** @param {string} id @returns {string} 기록이 없으면 'unknown' */
export function getSavePhase(id) {
    if (!id) return 'unknown';
    return savePhase.get(String(id)) || 'unknown';
}

/** @param {string} id */
export function clearSavePhase(id) {
    if (id) savePhase.delete(String(id));
}

function scheduleFlush() {
    if (flushTimer) return;
    try {
        flushTimer = setTimeout(() => {
            flushTimer = 0;
            void flush('interval');
        }, FLUSH_INTERVAL_MS);
    } catch (_) {
        /* ignore */
    }
}

/**
 * 메모리 버퍼를 IDB 로 내린다.
 *
 * **반드시 직렬화해야 한다.** `diag()` 가 임계치마다 `void flush()` 를 쏘므로, 가드가 없으면
 * 이전 flush 가 await 중일 때 다음 flush 가 겹쳐 들어온다. 그러면 각자 `trimOldest` 를 돌려
 * count 를 서로 다르게 보고 **과잉 삭제**한다(실측: 상한 600인데 356까지 깎였다).
 *
 * 진행 중이면 같은 프라미스를 돌려주고, 그 사이 들어온 것은 아래 while 루프가 이어서 처리한다.
 */
let flushInFlight = null;

async function doFlush(reason) {
    const db = await ensureDb();
    if (!db) {
        // IDB 를 못 쓰면 계측을 끈다. 메모리에 무한히 쌓는 것이 더 나쁘다.
        enabled = false;
        pending = [];
        console.warn('[diag] IndexedDB 사용 불가 — 계측 비활성화');
        return;
    }
    // await 중에 새로 들어온 이벤트까지 이 한 번의 flush 가 끝까지 처리한다
    while (pending.length > 0) {
        const batch = pending;
        pending = [];
        const ok = await putMany(db, STORE, batch);
        if (!ok) {
            console.warn('[diag] flush 쓰기 실패:', reason);
            return;
        }
    }
    await trimOldest(db, STORE, MAX_BUFFERED_EVENTS);
}

export function flush(reason = '') {
    if (!enabled || (pending.length === 0 && !flushInFlight)) return Promise.resolve();
    if (flushInFlight) return flushInFlight;
    flushInFlight = doFlush(reason)
        .catch((e) => {
            console.warn('[diag] flush 실패:', reason, e?.message || e);
        })
        .finally(() => {
            flushInFlight = null;
        });
    return flushInFlight;
}

/**
 * 버퍼를 서버로 올린다.
 *
 * **채널이 살아 있는 것이 관측된 뒤에만** 시도한다. 네트워크가 죽은 동안 올리려 하면 그 시도 자체가
 * 매달리거나 실패하고, 정작 진단하려던 상황의 기록을 잃는다.
 */
export async function uploadDiagnostics(reason = '') {
    if (!enabled || uploadInFlight) return;
    const now = Date.now();
    if (now - lastUploadAt < UPLOAD_MIN_INTERVAL_MS) return;

    try {
        const { getMealogFirestoreActivityAgeMs } = await import('./network-activity.js');
        if (getMealogFirestoreActivityAgeMs() > CHANNEL_FRESH_MS) return; // 채널이 살아 있다는 증거 없음
    } catch (_) {
        return;
    }

    const user = typeof window !== 'undefined' ? window.currentUser : null;
    if (!user?.uid || user.isAnonymous) return;

    uploadInFlight = true;
    lastUploadAt = now;
    try {
        await flush('pre-upload');
        const db = await ensureDb();
        if (!db) return;
        const rows = await getAll(db, STORE, UPLOAD_BATCH);
        if (!rows.length) return;

        const { db: fs, appId } = await import('../firebase.js');
        const { collection, addDoc } = await import(
            'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js'
        );
        const coll = collection(fs, 'artifacts', appId, 'users', user.uid, 'syncDiagnostics');

        const payload = {
            sessionId,
            uploadedAt: new Date().toISOString(),
            reason: String(reason || ''),
            appVersion: await resolveAppVersion(),
            platform: describePlatform(),
            eventCount: rows.length,
            events: rows.map((r) => ({ t: r.t, ev: r.ev, sid: r.sid, d: r.d ?? null }))
        };

        await withDeadline(addDoc(coll, payload), DEADLINE.DOC, 'diag-upload');

        // 올린 것만 지운다 — 실패하면 다음 기회에 다시 올린다
        for (const r of rows) await del(db, STORE, r._k);
        console.log(`[diag] ${rows.length}건 업로드 (${reason})`);
    } catch (e) {
        console.warn('[diag] 업로드 실패 (다음 기회에 재시도):', e?.message || e);
    } finally {
        uploadInFlight = false;
    }
}

/**
 * 어느 빌드에서 나온 기록인지 — 전후 비교의 기준이므로 반드시 있어야 한다.
 * 런타임 전역이 없어서 version.json 을 1회만 읽어 캐시한다.
 * @type {string|null}
 */
let cachedAppVersion = null;
let versionFetched = false;

async function resolveAppVersion() {
    if (versionFetched) return cachedAppVersion;
    versionFetched = true;
    cachedAppVersion = await withDeadlineOr(
        fetch('/version.json', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => (j?.version ? `${j.version} (${j.versionCode ?? '?'})` : null)),
        DEADLINE.DOC,
        null,
        'diag-version'
    );
    return cachedAppVersion;
}

function describePlatform() {
    try {
        const cap = typeof window !== 'undefined' && window.Capacitor;
        return {
            native: !!cap?.isNativePlatform?.(),
            platform: cap?.getPlatform?.() || 'web',
            ua: String(navigator.userAgent || '').slice(0, 200)
        };
    } catch (_) {
        return null;
    }
}

/** 진단용으로 지금까지 쌓인 것을 콘솔에서 보고 싶을 때 (관리자·개발) */
export async function dumpDiagnostics() {
    await flush('dump');
    const db = await ensureDb();
    if (!db) return [];
    return getAll(db, STORE);
}

let registered = false;

/** main.js 초기화 시 1회 */
export function registerDiagnostics() {
    if (registered || typeof window === 'undefined') return;
    registered = true;

    // 관문이 발화하면 그대로 이벤트로 남는다 — 어디서 매달렸는지가 곧 진단이다
    registerDeadlineSink(({ label, timeoutMs }) => {
        diag(label.startsWith('lease-expired:') ? 'lease.expired' : 'deadline', {
            label,
            ms: timeoutMs
        });
    });

    diag('session.start', { at: new Date().toISOString() });

    try {
        document.addEventListener(
            'visibilitychange',
            () => {
                if (document.visibilityState === 'visible') {
                    void uploadDiagnostics('foreground');
                } else {
                    // 백그라운드 전환은 앱이 죽기 직전일 수 있다 — 반드시 내려 둔다
                    void flush('background');
                }
            },
            { passive: true }
        );
        window.addEventListener('pagehide', () => void flush('pagehide'), { passive: true });
    } catch (_) {
        /* ignore */
    }

    // 부팅 직후 한 번 — 지난 세션에서 못 올린 것(= 그때 네트워크가 죽어 있었다는 뜻)을 올린다
    setTimeout(() => void uploadDiagnostics('boot'), 20000);
    setInterval(() => void uploadDiagnostics('periodic'), UPLOAD_MIN_INTERVAL_MS);

    try {
        window.Mealog = window.Mealog || {};
        window.Mealog.dumpDiagnostics = dumpDiagnostics;
        window.Mealog.uploadDiagnostics = uploadDiagnostics;
    } catch (_) {
        /* ignore */
    }
}
