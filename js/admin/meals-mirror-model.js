/**
 * 관리자 meals 로컬 미러 — 순수 계산부
 *
 * meals-mirror.js(IndexedDB·Firestore 입출력)가 쓰는 판단 로직만 모아 둔다.
 * 여기 함수들은 DOM·IDB·네트워크를 모르므로 node 테스트로 그대로 돌릴 수 있다.
 *
 * 설계 문서: docs/admin-local-mirror.md
 */

/**
 * 증분 동기화의 시작점.
 *
 * updatedAt 은 **클라이언트 시계**가 찍은 ISO 문자열이라, 시계가 늦는 기기가
 * 북마크보다 과거 도장을 찍으면 델타에서 빠질 수 있다. 그래서 북마크에서
 * 겹침 창(overlap)만큼 물러난 지점부터 다시 읽는다 — 업서트는 멱등이라
 * 같은 문서를 두 번 받아도 해가 없다.
 *
 * @param {string} lastSyncedAt ISO 북마크 ('' 이면 부트스트랩 필요)
 * @param {number} overlapMs 겹침 창 (기본 48시간)
 * @returns {string} 델타 쿼리에 넣을 ISO 하한, 부트스트랩이면 ''
 */
export function computeSyncStartIso(lastSyncedAt, overlapMs = 48 * 3600 * 1000) {
    const t = Date.parse(lastSyncedAt || '');
    if (!Number.isFinite(t)) return '';
    return new Date(t - overlapMs).toISOString();
}

/** 미러 저장 키 — meals 문서 id는 사용자 서브컬렉션 안에서만 유일하므로 uid와 합친다 */
export function mirrorKey(userId, mealId) {
    return `${userId}/${mealId}`;
}

/**
 * Firestore 스냅숏 경로에서 userId 를 뽑는다.
 * @param {string} path 'artifacts/{app}/users/{uid}/meals/{id}'
 */
export function userIdFromMealPath(path) {
    const parts = String(path || '').split('/');
    const i = parts.indexOf('users');
    return i >= 0 && parts.length > i + 1 ? parts[i + 1] : '';
}

/**
 * 델타로 받은 문서 배열 → 미러에 넣을 레코드 배열.
 * date 가 없는 문서는 기간 조회 축(IDB date 인덱스)에 태울 수 없으므로 버린다
 * (getMealDelta 도 date 없는 문서를 세지 않는다 — 같은 취급).
 *
 * @param {{id:string, path:string, data:object}[]} docs
 * @returns {{k:string, id:string, userId:string, [key:string]:any}[]}
 */
export function toMirrorRecords(docs) {
    const out = [];
    for (const d of docs || []) {
        const userId = userIdFromMealPath(d.path);
        const date = d.data?.date;
        if (!userId || typeof date !== 'string' || !date) continue;
        out.push({ k: mirrorKey(userId, d.id), id: d.id, userId, ...d.data });
    }
    return out;
}

/**
 * 툼스톤 문서 배열 → 미러에서 지울 키 배열.
 * 툼스톤 id 자체가 `${userId}_${mealId}` 지만, 필드를 신뢰 축으로 쓴다.
 */
export function tombstonesToKeys(tombstones) {
    const out = [];
    for (const t of tombstones || []) {
        if (!t?.userId || !t?.mealId) continue;
        out.push(mirrorKey(t.userId, t.mealId));
    }
    return out;
}

/**
 * 동기화 한 번이 끝난 뒤의 새 북마크.
 * 시계 뒤틀림을 겹침 창이 흡수하므로, 북마크는 단순히 「이번 동기화를 시작한
 * 클라이언트 시각」이면 충분하다. 단, 뒤로 가지는 않는다(이전 북마크 유지).
 */
export function nextBookmark(prevIso, syncStartedIso) {
    const prev = Date.parse(prevIso || '');
    const cur = Date.parse(syncStartedIso || '');
    if (!Number.isFinite(cur)) return prevIso || '';
    if (!Number.isFinite(prev)) return syncStartedIso;
    return cur >= prev ? syncStartedIso : prevIso;
}

/** YMD 문자열 기간 필터 — 미러 조회 결과 검증용(경계 포함) */
export function isYmdInRange(ymd, startYmd, endYmd) {
    return typeof ymd === 'string' && ymd >= startYmd && ymd <= endYmd;
}

/**
 * meals 미러 드리프트 감지.
 *
 * meals 는 미러 중 제일 크고(부트스트랩 ~1.2만) 대시보드·모먼트 관리·사용자 목록이
 * 전부 여기 얹혀 있는데, **주기적 전체 재구축이 없다** — 비용 때문에 부트스트랩 1회 뒤
 * 영영 델타·툼스톤이다. 그래서 툼스톤이 유실되면(함수 실패·트리거 배포 전 삭제)
 * 어긋난 채로 영원히 간다.
 *
 * 감지 원리: 건강한 미러는 항상 `미러 수 ≤ 서버 수` 다. 미러는 `date` 있는 문서만
 * 담으므로 서버가 같거나 크다. **미러가 더 크면** 서버에서 사라진 문서를 미러가
 * 아직 들고 있다는 확실한 신호다.
 *
 * 못 잡는 것: 서버 수가 같거나 큰 채로 내용만 어긋난 경우(도장 없는 쓰기).
 * 그런 쓰기는 관리자 조치뿐이고, 그쪽은 patchLocalMeal 이 그 자리에서 반영한다.
 *
 * @param {number|null} serverCount 서버가 센 meals 전체 수 (못 셌으면 null)
 * @param {number} mirrorCount 미러 보유 수
 * @returns {{drift: boolean, reason: string}}
 */
export function detectMealsMirrorDrift(serverCount, mirrorCount) {
    if (typeof serverCount !== 'number' || !Number.isFinite(serverCount)) {
        return { drift: false, reason: 'count-unavailable' };
    }
    if (typeof mirrorCount !== 'number' || !Number.isFinite(mirrorCount)) {
        return { drift: false, reason: 'mirror-count-unavailable' };
    }
    if (mirrorCount > serverCount) return { drift: true, reason: 'mirror-exceeds-server' };
    return { drift: false, reason: 'ok' };
}
