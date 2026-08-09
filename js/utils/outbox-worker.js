/**
 * 아웃박스 워커 — 미전송 큐를 소비하는 **단일 주체**.
 *
 * 예전에는 재시도 주체가 다섯이었다 (retryPendingMealEntriesOnAppReady,
 * reconcileMealSyncAgainstServer, scheduleServerAckAfterPendingWrites, grace 타이머,
 * drainMealOutbox). 각자 「무엇이 미전송인가」를 따로 판단했고, 그 기준이 조금씩 갈라지는
 * 조합마다 버그가 났다 — 배지에는 N 이 뜨는데 눌러도 아무 일도 안 하는 버튼 같은 것들이다.
 *
 * 여기서는 답이 하나다: **아웃박스에 있으면 미전송이다.**
 *
 * 규칙:
 *   1. 지우는 시점은 딱 하나 — 서버 존재(또는 부재)가 확인됐을 때.
 *   2. 네트워크성 실패는 절대 permanent 가 아니다. 무한 재시도한다.
 *   3. 모든 네트워크 대기는 관문을 통과한다. 워커가 매달리면 큐 전체가 멈춘다.
 *   4. 오래된 항목이 서버 최신본을 덮어쓰지 않는다 (updatedAt 비교).
 *
 * 설계: docs/sync-outbox-design.md §4.3
 */
import { db, appId, auth } from '../firebase.js';
import { doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { withDeadline, withDeadlineOr, Lease, DEADLINE } from './with-deadline.js';
import { diag } from './diagnostics.js';
import {
    listPending,
    remove as outboxRemove,
    markAttempt,
    clearOriginals,
    expireInteractions,
    hydrateOutboxIndex,
    subscribeOutboxIndex,
    outboxKey
} from './outbox-store.js';
import { getMealogFirestoreActivityAgeMs } from './network-activity.js';
import { pokeNetworkLoop } from './network-loop.js';
import { getOutboxHandler } from './outbox-actions.js';

/** 한 사이클에서 처리할 최대 항목 수 — 한 번에 다 밀지 않고 나눠 보낸다 */
const MAX_PER_CYCLE = 5;
/** 사이클 주기 */
const TICK_MS = 6000;
/** 남은 일이 있는데 채널이 이만큼 조용하면 찔러본다 */
const CHANNEL_QUIET_MS = 20000;
/** 항목당 처리 상한 — 사진 업로드가 낀 경우까지 감안 */
const PER_ENTRY_TIMEOUT_MS = 60000;
/** 재시도 백오프 (attempts 기준). 마지막 값에서 고정 */
const BACKOFF_MS = [0, 5000, 15000, 30000, 60000, 120000, 300000];

/**
 * 워커 점유. 불린이 아니라 만료 있는 리스 — 안에서 매달려도 스스로 풀린다.
 * 개별 상한을 모두 걸었지만, 리스는 「다음에 추가될 await」까지 막아 준다.
 */
const workerLease = new Lease('outbox-worker', 300000);

/**
 * 재시도해도 무의미한 실패인가 (§4.4).
 *
 * **네트워크성은 절대 여기 들어오면 안 된다.** 한 번 permanent 로 찍히면 사용자가 손대기
 * 전까지 다시 시도하지 않으므로, 잘못 분류하면 그 자체가 유실이 된다. 그래서 「확실히
 * 다시 해도 안 되는 것」만 나열하고 나머지는 전부 재시도로 둔다.
 */
function isPermanentFailure(err, attempts) {
    const code = String(err?.code || '');
    const msg = String(err?.message || '');
    if (code === 'invalid-argument') return true;
    if (/exceeds the maximum allowed size|too large/i.test(msg)) return true;
    // 닉네임 중복은 아무리 재시도해도 안 된다 — 사용자가 다른 닉네임을 골라야 한다
    if (msg === 'NICKNAME_TAKEN' || /already-exists/.test(code)) return true;
    // 온보딩 미완료도 사용자 행동이 필요하다
    if (msg === 'ONBOARDING_INCOMPLETE') return true;
    if (code === 'not-found' && /project|database/i.test(msg)) return true;
    // 권한 거부는 대개 토큰·App Check 일시 문제라 바로 포기하면 안 된다.
    // 여러 번 연속으로 같은 이유라면 그때는 사용자 개입이 필요한 상태로 본다.
    if ((code === 'permission-denied' || code === 'functions/permission-denied') && attempts >= 8) return true;
    return false;
}

function backoffFor(attempts) {
    return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
}

/**
 * 방금 만들어진 항목은 건드리지 않는다.
 *
 * 정상 경로(saveEntry → dbOps.save → 리스너 ack → 아웃박스 제거)는 보통 1초 안에 끝난다.
 * 워커가 그 사이에 끼어들면 **같은 쓰기를 두 번 보내고**(setDoc 은 멱등이라 데이터는
 * 안전하지만 쓰기 1회 + 서버 읽기 2회가 낭비된다), 사용자가 저장한 직후마다 그 낭비가 난다.
 * 워커는 「정상 경로가 실패했을 때」만 필요하므로, 그 판정이 날 시간을 준다.
 */
const FRESH_ENTRY_GRACE_MS = 15000;

function dueNow(entry, { ignoreGrace = false, ignoreBackoff = false } = {}) {
    /**
     * 사용자가 직접 재전송을 눌렀으면 백오프도 무시한다.
     *
     * 예전에는 유예(`ignoreGrace`)만 무시했는데, 그건 `attempts === 0` 인 항목에만 걸리는
     * 조건이라 **정작 여러 번 실패해서 버튼이 떠 있는 항목은 눌러도 그냥 건너뛰었다.**
     * 백오프가 최대 5분이므로 사용자는 눌렀는데 아무 시도도 일어나지 않고, 그 상태로
     * 「아직 서버에 닿지 못했어요」 토스트가 떴다 — 닿아 보지도 않고 못 닿았다고 말한 것이다.
     */
    if (ignoreBackoff) return true;
    const attempts = entry.attempts || 0;
    if (attempts === 0) {
        if (ignoreGrace) return true;
        const created = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
        if (created && Date.now() - created < FRESH_ENTRY_GRACE_MS) return false;
        return true;
    }
    const last = entry.lastError?.at ? new Date(entry.lastError.at).getTime() : 0;
    if (!last) return true;
    return Date.now() - last >= backoffFor(attempts);
}

/**
 * 서버본이 더 최신인가 (§4.5).
 * @returns {Promise<'server-newer'|'ours-newer'|'absent'|'unknown'>}
 */
async function compareWithServer(uid, id, ourUpdatedAt) {
    try {
        const snap = await withDeadline(
            getDocFromServer(doc(db, 'artifacts', appId, 'users', uid, 'meals', String(id))),
            DEADLINE.DOC,
            'worker-compare'
        );
        if (!snap.exists()) return 'absent';
        const data = snap.data() || {};
        // 기존 문서에는 updatedAt 이 없다 — recordedAt 으로 폴백한다
        const serverAt = data.updatedAt || data.recordedAt || '';
        if (!serverAt || !ourUpdatedAt) return 'ours-newer';
        return String(serverAt) > String(ourUpdatedAt) ? 'server-newer' : 'ours-newer';
    } catch (e) {
        console.warn('[outbox-worker] 서버 비교 실패:', id, e?.message || e);
        return 'unknown'; // 확인 못 함 — 다음 사이클이 이어받는다
    }
}

/** 아웃박스에 담긴 Blob 사진을 Storage 로 올려 URL 로 바꾼다 */
async function uploadEntryPhotos(entry, uid) {
    if (!Array.isArray(entry.photos) || entry.photos.length === 0) return [];
    const { uploadImageToStorage } = await import('../utils.js');
    const urls = [];
    for (const blob of entry.photos) {
        const url = await withDeadline(
            uploadImageToStorage(blob, uid, entry.id),
            DEADLINE.UPLOAD,
            'worker-photo-upload'
        );
        if (url) urls.push(url);
    }
    return urls;
}

/** 항목 1건 처리. 성공하면 아웃박스에서 제거된 상태로 끝난다. */
async function processEntry(entry) {
    const uid = entry.uid;
    if (!uid || auth.currentUser?.uid !== uid) return; // 계정이 바뀌었다 — 이 항목은 그 계정으로 로그인했을 때 처리

    const startedAt = Date.now();
    diag('worker.entry.begin', { key: entry.key, op: entry.op, attempts: entry.attempts || 0 });

    try {
        /**
         * 등록된 핸들러가 있으면 그것으로 다시 보낸다 (outbox-actions 레지스트리).
         * 워커에 target 별 분기를 늘려 가면 그 분기가 또 하나의 상태기계가 되므로,
         * 「어떻게 다시 보내는가」는 그 쓰기를 소유한 모듈이 등록한다.
         */
        /**
         * 핸들러는 그 쓰기를 소유한 모듈 하단에서 등록되고, 그 모듈은 **지연 로드**된다.
         * 아직 로드되지 않았으면 먼저 불러온다 — 없는 채로 아래로 흘리면 boardPost 같은
         * 항목을 식사 기록으로 오처리해서(meals 경로의 compareWithServer) 지워 버린다.
         */
        await ensureHandlerLoaded(entry.target);
        const handler = getOutboxHandler(entry.target);
        if (!handler && !NATIVE_TARGETS.has(entry.target)) {
            /**
             * 어떻게 다시 보내야 하는지 모른다. **건너뛴다** — 추측해서 처리하면 유실이 된다.
             * 항목은 아웃박스에 그대로 남으므로, 핸들러가 등록되는 세션에서 처리된다.
             */
            diag('worker.entry.noHandler', { key: entry.key, target: entry.target });
            return;
        }
        if (handler) {
            await withDeadline(handler(entry.payload || {}, entry), DEADLINE.SAVE, `worker-${entry.target}`);
            await outboxRemove(entry.key); // 핸들러가 resolve 했다 = 서버가 받았다
            diag('worker.entry.done', {
                key: entry.key,
                op: entry.target,
                ms: Date.now() - startedAt
            });
            return;
        }

        if (entry.target === 'settings') {
            /**
             * userSettings 단일 문서. Firestore 쓰기 프라미스는 **서버 커밋에서 resolve** 되고
             * 오프라인이면 resolve 되지 않으므로, 정상 반환이 곧 서버 반영 확인이다.
             * (ops.saveSettings 가 성공 지점에서 스스로 아웃박스를 비우므로 여기서는 호출만 한다)
             */
            const { dbOps } = await import('../db/ops.js');
            await withDeadline(
                dbOps.saveSettings(entry.payload?.settings || {}, { fromOutbox: true }),
                DEADLINE.SAVE,
                'worker-settings'
            );
            diag('worker.entry.done', { key: entry.key, op: 'settings', ms: Date.now() - startedAt });
            return;
        }

        if (entry.op === 'delete') {
            const { dbOps } = await import('../db/ops.js');
            try {
                await withDeadline(dbOps.delete(entry.id), DEADLINE.SAVE, 'worker-delete');
            } catch (e) {
                // 이미 없으면 목적은 달성된 것이다
                if (String(e?.code || '') !== 'not-found') throw e;
            }
            const state = await compareWithServer(uid, entry.id, null);
            if (state === 'absent') {
                await outboxRemove(entry.key);
                diag('worker.entry.done', { key: entry.key, op: 'delete', ms: Date.now() - startedAt });
            }
            return;
        }

        // ── upsert ──────────────────────────────────────────────────────────
        const ourUpdatedAt = entry.payload?.updatedAt || entry.updatedAt || '';
        /**
         * 충돌 사전 확인은 **묵은 항목에만** 한다.
         *
         * 이 확인의 목적은 「며칠 묵은 항목이 다른 기기의 최신 수정을 되돌리는 것」을 막는
         * 것이다(§4.5). 아직 한 번도 못 보낸 신선한 항목은 사용자가 방금 만든 것이므로
         * 되돌릴 최신본이 있을 수 없다 — 그 경우 이 서버 읽기는 순수 낭비다.
         */
        const needsConflictCheck = (entry.attempts || 0) > 0;
        const cmp = needsConflictCheck
            ? await compareWithServer(uid, entry.id, ourUpdatedAt)
            : 'absent';
        if (cmp === 'server-newer') {
            /**
             * 다른 기기에서 더 최근에 고쳤다 — 묵은 항목이 그걸 되돌리면 안 된다(§4.5).
             * 이 항목은 목적을 잃었으므로 제거한다. 유실이 아니라 「이미 반영된 것보다 옛것」이다.
             */
            await outboxRemove(entry.key);
            diag('worker.entry.superseded', { key: entry.key });
            return;
        }
        if (cmp === 'unknown') {
            await markAttempt(entry.key, { code: 'unavailable', message: 'server-compare-failed' });
            return; // 채널이 죽어 있다 — 다음 사이클
        }

        const payload = { ...entry.payload, id: entry.id };
        const uploadedUrls = await uploadEntryPhotos(entry, uid);
        if (uploadedUrls.length > 0) {
            const existing = Array.isArray(payload.photos) ? payload.photos : [];
            payload.photos = [...existing, ...uploadedUrls];
        }

        const { dbOps } = await import('../db/ops.js');
        await withDeadline(
            dbOps.save(payload, true, { isNewRecord: false }),
            DEADLINE.SAVE,
            'worker-save'
        );

        // 서버에 실제로 있는지 확인된 뒤에만 제거한다 — 이것이 유일한 제거 조건이다
        const after = await compareWithServer(uid, entry.id, ourUpdatedAt);
        if (after === 'absent' || after === 'unknown') {
            await markAttempt(entry.key, { code: 'unverified', message: 'server-not-confirmed' });
            diag('worker.entry.unverified', { key: entry.key });
            return;
        }
        await clearOriginals(entry.key); // 업로드가 끝났으니 원본은 버린다 (§4.6)
        await outboxRemove(entry.key);
        diag('worker.entry.done', {
            key: entry.key,
            op: 'upsert',
            ms: Date.now() - startedAt,
            photos: uploadedUrls.length
        });
    } catch (e) {
        const attempts = (entry.attempts || 0) + 1;
        const permanent = isPermanentFailure(e, attempts);
        await markAttempt(entry.key, e, permanent);
        diag('worker.entry.error', {
            key: entry.key,
            code: String(e?.code || ''),
            attempts,
            permanent,
            message: String(e?.message || e).slice(0, 120)
        });
    }
}

/** 한 사이클 — 오래된 것부터 최대 MAX_PER_CYCLE 건 */
export async function runOutboxCycle(reason = '') {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    /** 리스를 못 잡으면 undefined — 호출부가 「이미 돌고 있음」을 구분할 수 있어야 한다 */
    return workerLease.run(async () => {
        const all = await listPending(uid);
        /**
         * 사용자가 재전송 버튼을 누른 것(`manual-resend`)만 백오프까지 무시한다.
         * 포그라운드 복귀(`poke`)는 사용자의 의사 표시가 아니므로 유예만 무시한다 —
         * 앱 전환을 반복할 때마다 큐 전체를 다시 밀면 그것대로 낭비다.
         */
        const userInitiated = reason === 'manual-resend';
        const ignoreGrace = userInitiated || reason === 'poke';
        const due = all
            .filter((e) => !e.permanent && dueNow(e, { ignoreGrace, ignoreBackoff: userInitiated }))
            .slice(0, MAX_PER_CYCLE);
        if (due.length === 0) return { processed: 0, pending: all.length };
        diag('worker.cycle', { reason, pending: all.length, due: due.length });
        for (const entry of due) {
            await withDeadlineOr(processEntry(entry), PER_ENTRY_TIMEOUT_MS, undefined, 'worker-entry');
            workerLease.renew(); // 진행 중임을 관측했을 때만 연장한다
        }
        return { processed: due.length, pending: all.length };
    });
}

function tick() {
    void (async () => {
        const uid = auth.currentUser?.uid;
        if (!uid) return;
        const pending = await listPending(uid);
        if (pending.length === 0) return;
        /**
         * 보낼 것이 있는데 채널이 조용하면 그 자체가 찔러야 할 이유다.
         * 보낼 것이 없으면 찌르지 않는다 — 멀쩡한 연결을 공회전시킬 뿐이다.
         */
        if (getMealogFirestoreActivityAgeMs() >= CHANNEL_QUIET_MS) pokeNetworkLoop('outbox-worker-quiet');
        void runOutboxCycle('tick');
    })();
}

/** 사용자 조작·포그라운드 복귀 등 — 백오프를 무시하고 즉시 한 사이클 */
export async function pokeOutboxWorker(reason = '') {
    await runOutboxCycle(reason || 'poke');
}

/**
 * 이 워커가 직접 아는 target — 핸들러 없이도 처리 방법이 이 파일에 있다.
 * 그 외 target 은 반드시 등록된 핸들러가 있어야 한다.
 */
const NATIVE_TARGETS = new Set(['meal', 'settings']);

/**
 * target → 핸들러를 등록하는 모듈. 지연 로드된 모듈의 핸들러를 필요할 때 불러온다.
 * 부팅 시 전부 import 하면 쓰지도 않을 무거운 모듈까지 끌어오게 된다.
 */
const TARGET_OWNERS = {
    boardPost: '../db/board.js',
    boardComment: '../db/board.js',
    feedPost: '../db/feed-posts.js',
    postComment: '../db/social.js'
};

async function ensureHandlerLoaded(target) {
    if (getOutboxHandler(target)) return;
    const mod = TARGET_OWNERS[target];
    if (!mod) return;
    try {
        await import(mod);
    } catch (e) {
        console.warn('[outbox-worker] 핸들러 모듈 로드 실패:', target, e?.message || e);
    }
}

/** 인덱스가 바뀌면 배지·타임라인 도트를 갱신한다 */
async function notifyIndicators() {
    try {
        const tl = await import('../render/timeline.js');
        tl.updateTimelineMealEntryPendingIndicators?.();
    } catch (_) {
        /* ignore */
    }
    try {
        const h = await import('../main/meal-sync-resend-header.js');
        h.refreshMealSyncResendNavButton?.();
    } catch (_) {
        /* ignore */
    }
}

let registered = false;

/** main.js 초기화 시 1회 */
export function registerOutboxWorker() {
    if (registered || typeof window === 'undefined') return;
    registered = true;

    /**
     * 동기 인덱스를 먼저 채운다. 렌더가 「아직 안 올라감」을 동기로 물어보므로,
     * 채워지기 전에는 전부 synced 로 보인다 — hydrate 후 알림으로 바로잡는다.
     */
    void hydrateOutboxIndex().then(() => {
        void notifyIndicators();
    });

    // 인덱스가 바뀌면 배지·타임라인 표시를 갱신한다 (표시의 단일 기준)
    subscribeOutboxIndex(() => void notifyIndicators());

    try {
        setInterval(tick, TICK_MS);
    } catch (_) {
        return;
    }
    try {
        document.addEventListener(
            'visibilitychange',
            () => {
                if (document.visibilityState !== 'visible') return;
                void pokeOutboxWorker('foreground');
                void expireInteractions();
            },
            { passive: true }
        );
    } catch (_) {
        /* ignore */
    }
    try {
        window.Mealog = window.Mealog || {};
        window.Mealog.pokeOutboxWorker = pokeOutboxWorker;
    } catch (_) {
        /* ignore */
    }
}

export { outboxKey };
