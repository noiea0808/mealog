/**
 * 구버전 → 아웃박스 1회 마이그레이션.
 *
 * 신버전 이전에 저장된 미전송 기록은 아웃박스에 없다. 그것들을 흡수하지 않은 채 기존
 * 드레인(meal-outbox-drain)을 지우면 **그 기록들의 재시도 경로가 통째로 사라진다** —
 * 유실을 막으려는 작업이 유실을 만드는 셈이다. 그래서 흡수가 먼저다.
 *
 * 무엇을 미전송으로 볼 것인가:
 *   구버전은 「아직 안 올라감」을 localStorage ID 집합 3종과 행 플래그로 표현했다.
 *   그 표식들은 근사치라 서로 어긋날 수 있었지만, **표식이 붙어 있다는 사실 자체는
 *   신뢰할 수 있다** — 붙었다는 건 그때 뭔가 확인되지 않았다는 뜻이다. 반대로 표식이
 *   없는 행까지 전부 흡수하면 이미 서버에 있는 기록을 통째로 다시 밀어 올리게 된다.
 *   그래서 「표식이 있는 것」만 가져오고, 나머지는 워커의 정상 정합에 맡긴다.
 *
 * 설계: docs/sync-outbox-design.md §5 (마이그레이션)
 */
import { enqueueWithQuotaRelief, CLASS_CONTENT, isPendingSync } from './outbox-store.js';
import { dataUrlToBlob } from './image-downscale.js';
import { diag } from './diagnostics.js';

const MIGRATED_FLAG = 'mealog_outboxMigrated_v1';
/** 구버전이 「아직 안 올라감」을 적어 두던 곳 — 읽고 나서 폐기한다 */
const LEGACY_KEYS = [
    'mealog_mealSyncErrorIds_v1',
    'mealog_mealSyncAbandonedIds_v1',
    'mealog_mealSyncRegisterScheduledIds_v1'
];

function readLegacyIds() {
    const ids = new Set();
    if (typeof window === 'undefined' || !window.localStorage) return ids;
    for (const k of LEGACY_KEYS) {
        try {
            const raw = window.localStorage.getItem(k);
            if (!raw) continue;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) continue;
            for (const id of arr) {
                if (id != null && id !== '' && !String(id).startsWith('temp_')) ids.add(String(id));
            }
        } catch (_) {
            /* 깨진 값은 무시 — 마이그레이션이 실패해도 앱은 계속 떠야 한다 */
        }
    }
    return ids;
}

function dropLegacyKeys() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    for (const k of LEGACY_KEYS) {
        try {
            window.localStorage.removeItem(k);
        } catch (_) {
            /* ignore */
        }
    }
}

export function isOutboxMigrationDone() {
    try {
        return window.localStorage?.getItem(MIGRATED_FLAG) === '1';
    } catch (_) {
        return false;
    }
}

/**
 * 1회 실행. **mealHistory 가 로드된 뒤에** 불러야 한다 — 행 본문이 있어야 흡수할 수 있다.
 * @returns {Promise<{ migrated: number, skipped: number } | null>} 이미 했으면 null
 */
export async function migrateLegacyPendingToOutbox() {
    if (typeof window === 'undefined') return null;
    if (isOutboxMigrationDone()) return null;

    const uid = window.currentUser?.uid;
    if (!uid || window.currentUser?.isAnonymous) return null;

    const hist = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    // 아직 목록이 안 들어왔다면 다음 기회에 — 플래그를 세우지 않는다
    if (hist.length === 0) return null;

    const legacyIds = readLegacyIds();
    /** 행 자체에 실패 플래그가 박혀 있던 경우도 미전송이다 */
    for (const m of hist) {
        if (!m?.id) continue;
        if (m._localSaveFailed === true || m.is_sync_error === true) legacyIds.add(String(m.id));
    }

    let migrated = 0;
    let skipped = 0;
    for (const id of legacyIds) {
        if (isPendingSync('meal', id)) {
            skipped++;
            continue; // 이미 아웃박스에 있다
        }
        const row = hist.find((m) => m && String(m.id) === id);
        if (!row) {
            /**
             * 본문이 없다 — 구버전에서 ID 만 남고 행은 사라진 경우다. 되살릴 데이터가 없으므로
             * 흡수할 수 없다. 이것이 정확히 이 작업이 없애려는 유실이고, 이미 일어난 건은
             * 되돌릴 수 없다. 규모만 기록해 둔다.
             */
            skipped++;
            continue;
        }
        const photos = [];
        for (const p of Array.isArray(row.photos) ? row.photos : []) {
            if (typeof p !== 'string' || !p.startsWith('data:image')) continue;
            const blob = await dataUrlToBlob(p);
            if (blob) photos.push(blob);
        }
        const payload = {
            ...row,
            photos: (Array.isArray(row.photos) ? row.photos : []).filter(
                (p) => typeof p === 'string' && p && !p.startsWith('data:image') && !p.startsWith('blob:')
            ),
            // 구버전 문서에는 updatedAt 이 없다 — 충돌 판정이 이 값을 쓰므로 보수적으로 과거로 둔다.
            // 그래야 다른 기기의 최신 수정을 되돌리지 않는다.
            updatedAt: row.updatedAt || row.recordedAt || new Date(0).toISOString()
        };
        delete payload._localSaveFailed;
        delete payload.is_sync_error;

        if (await enqueueWithQuotaRelief({
            target: 'meal',
            id,
            uid,
            op: 'upsert',
            class: CLASS_CONTENT,
            payload,
            photos
        })) {
            migrated++;
        } else {
            skipped++;
        }
    }

    dropLegacyKeys();
    try {
        window.localStorage?.setItem(MIGRATED_FLAG, '1');
    } catch (_) {
        /* ignore */
    }
    diag('outbox.migrate', { migrated, skipped, candidates: legacyIds.size });
    console.log(`[outbox] 구버전 미전송 흡수: ${migrated}건 (건너뜀 ${skipped})`);
    return { migrated, skipped };
}
