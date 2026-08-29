/**
 * 관리자 범용 컬렉션 미러 — 순수 계산부
 *
 * meals·users 처럼 전용 미러를 따로 쓸 만큼 크지 않은 최상위 컬렉션
 * (sharedPhotos·aiDietReports·feedPosts·boardPosts)을 한 틀로 담기 위한 규칙.
 *
 * **왜 생성 시각을 축으로 쓰나.** meals 는 앱이 모든 저장 경로에서 `updatedAt` 을
 * 찍어 주지만, 이 컬렉션들은 클라이언트·Functions 십수 곳에서 제각각 쓰인다
 * (좋아요·댓글·신고·관리자 조치…). 공통 도장이 없으니 「수정」을 축으로 삼을 수 없다.
 * 그래서 생성 시각으로 **새 문서만** 따라가고, 나머지는 이렇게 메운다:
 *
 *   - 관리자 조치(숨김·삭제)는 본인이 하는 쓰기라 그 자리에서 미러에 직접 반영
 *   - 사용자 쪽 수정·삭제는 주기적 전체 재구축(기본 7일)과 문서 수 감시가 정리
 *
 * DOM·IDB·네트워크를 모르므로 node 테스트로 그대로 돌린다.
 * 설계 문서: docs/admin-local-mirror.md
 */

/** Firestore Timestamp 를 IDB 에 담을 수 있게 눕힌 형태 */
const TS_MARK = '__fsts';

/** Timestamp 처럼 생겼는가 — SDK 클래스를 import 하지 않고 오리 판별로 */
function isTimestampLike(v) {
    return (
        v != null &&
        typeof v === 'object' &&
        typeof v.toDate === 'function' &&
        (typeof v.seconds === 'number' || typeof v._seconds === 'number')
    );
}

/**
 * Firestore 문서 데이터를 IndexedDB 가 담을 수 있는 값으로 눕힌다.
 *
 * Timestamp·DocumentReference 같은 클래스 인스턴스는 구조화 복제(structured clone)를
 * 통과하지 못하거나 프로토타입을 잃는다. Timestamp 는 ms 를 단 표식으로 바꿔 두고
 * (reviveDoc 이 되살린다), 참조형은 경로 문자열로 남긴다.
 */
export function flattenForIdb(value, depth = 0) {
    if (value === null || value === undefined) return value ?? null;
    if (depth > 12) return null; // 순환·과도한 중첩 방어
    if (isTimestampLike(value)) {
        const ms = typeof value.seconds === 'number' ? value.seconds * 1000 : value._seconds * 1000;
        const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
        return { [TS_MARK]: ms + Math.floor(nanos / 1e6) };
    }
    if (value instanceof Date) return { [TS_MARK]: value.getTime() };
    if (Array.isArray(value)) return value.map((v) => flattenForIdb(v, depth + 1));
    if (typeof value === 'object') {
        // DocumentReference 등 — 경로만 남긴다
        if (typeof value.path === 'string' && typeof value.id === 'string' && typeof value.toDate !== 'function') {
            return { __ref: value.path };
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'function') continue;
            out[k] = flattenForIdb(v, depth + 1);
        }
        return out;
    }
    if (typeof value === 'function' || typeof value === 'symbol') return null;
    return value;
}

/** 눕혀 둔 Timestamp 를 다시 `.toDate()` 가 되는 물건으로 — 소비자 코드를 그대로 두려고 */
export function reviveForConsumers(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 12) return value;
    if (Array.isArray(value)) return value.map((v) => reviveForConsumers(v, depth + 1));
    if (typeof value === 'object') {
        if (typeof value[TS_MARK] === 'number') {
            const ms = value[TS_MARK];
            return {
                seconds: Math.floor(ms / 1000),
                nanoseconds: (ms % 1000) * 1e6,
                toDate: () => new Date(ms),
                toMillis: () => ms
            };
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = reviveForConsumers(v, depth + 1);
        return out;
    }
    return value;
}

/**
 * 정렬 축의 값을 ms 로 — 없는 문서는 0 (목록 맨 뒤로 간다).
 * 문자열 ISO·숫자·Timestamp·눕힌 Timestamp 를 모두 받는다.
 */
export function toSortMs(raw) {
    if (raw == null || raw === '') return 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'object') {
        if (typeof raw[TS_MARK] === 'number') return raw[TS_MARK];
        if (isTimestampLike(raw)) {
            const d = raw.toDate();
            return d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
        }
        if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? 0 : raw.getTime();
    }
    const t = Date.parse(String(raw));
    return Number.isFinite(t) ? t : 0;
}

/**
 * Firestore 스냅숏 문서 → 미러 행.
 * @param {{id:string, data:object}} d
 * @param {string} sortField 정렬·델타 축 필드명
 */
export function toMirrorRow(d, sortField) {
    if (!d || !d.id) return null;
    const flat = flattenForIdb(d.data || {});
    return { id: d.id, _sortMs: toSortMs((d.data || {})[sortField]), d: flat };
}

/**
 * 미러 행 → Firestore 스냅숏처럼 쓰는 물건.
 * 소비자들이 `snap.docs` 를 `{id, data(), ref.path}` 로 다루므로 모양을 맞춘다.
 */
export function rowToDocLike(row, collectionPath) {
    if (!row) return null;
    let cached = null;
    return {
        id: row.id,
        exists: () => true,
        data: () => {
            if (cached === null) cached = reviveForConsumers(row.d || {});
            return cached;
        },
        get ref() {
            return { id: row.id, path: `${collectionPath}/${row.id}` };
        },
        _sortMs: row._sortMs
    };
}

/**
 * 델타 시작점 — 마지막 동기화 시각에서 겹침 창만큼 물러난다.
 * 생성 축이라 원래는 겹칠 필요가 없지만, 서버 시각과 클라이언트 시각이 어긋나거나
 * 동기화 도중 새 문서가 끼어들 수 있어 안전 폭을 둔다. 업서트는 멱등이라 무해하다.
 *
 * @returns {Date|null} null 이면 전체 재구축
 */
export function computeCollectionSyncStart(lastSyncedAt, overlapMs = 6 * 3600 * 1000) {
    const t = Date.parse(lastSyncedAt || '');
    if (!Number.isFinite(t)) return null;
    return new Date(t - overlapMs);
}

/**
 * 전체 재구축이 필요한지.
 *
 * users 미러와 같은 규칙 — 미러가 없거나, 북마크가 깨졌거나, 주기가 지났거나,
 * 서버 문서 수가 **줄었으면**(삭제) 전체를 다시 받는다.
 */
export function decideCollectionSyncMode(meta, serverCount, maxAgeMs = 7 * 24 * 3600 * 1000, nowMs = Date.now()) {
    if (!meta || !meta.bootstrapDone) return { mode: 'full', reason: 'no-mirror' };
    const t = Date.parse(meta.lastSyncedAt || '');
    if (!Number.isFinite(t)) return { mode: 'full', reason: 'bad-bookmark' };
    if (nowMs - t > maxAgeMs) return { mode: 'full', reason: 'stale' };
    if (
        typeof serverCount === 'number' &&
        Number.isFinite(serverCount) &&
        typeof meta.serverCount === 'number' &&
        serverCount < meta.serverCount
    ) {
        return { mode: 'full', reason: 'deletion-detected' };
    }
    return { mode: 'delta', reason: 'ok' };
}

/** 최신순 정렬 + 상한 — 미러에서 목록을 만들 때 */
export function sortRowsDesc(rows, rowLimit = Infinity) {
    const out = [...(rows || [])].sort((a, b) => (b?._sortMs || 0) - (a?._sortMs || 0));
    return Number.isFinite(rowLimit) ? out.slice(0, rowLimit) : out;
}
