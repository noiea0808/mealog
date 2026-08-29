/**
 * 대시보드 로컬 미러 집계 — 순수 계산부
 *
 * 대시보드가 Firestore 스냅숏을 받아 세던 코드를 그대로 두고, **미러 행을 스냅숏처럼
 * 보이게** 만드는 어댑터다. 집계 규칙(주차 병합·시간대 축·유니크 집합)은 이미
 * `dashboard.js` 에서 검증된 것이라, 그 코드를 다시 쓰는 대신 입력만 갈아 끼운다.
 *
 * 여기 함수들은 DOM·IDB·네트워크를 모르므로 node 테스트로 그대로 돌린다.
 * 설계 문서: docs/admin-local-mirror.md
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * meals 미러 행 → Firestore 스냅숏 문서처럼.
 *
 * `dashboard.js` 의 `userIdFromMealDocRef(ref)` 가 경로에서 uid 를 뽑으므로, 경로를
 * 같은 모양으로 지어 준다 — 그래야 스캔 함수를 한 줄도 고치지 않고 재사용한다.
 *
 * @param {{id?:string, userId?:string}} row
 * @param {string} appId
 */
export function mealRowToDocLike(row, appId) {
    const uid = row?.userId || '';
    const id = row?.id || '';
    return {
        id,
        ref: { path: `artifacts/${appId}/users/${uid}/meals/${id}` },
        data: () => row
    };
}

/**
 * 배열 → `forEach`·`size` 를 가진 스냅숏처럼.
 * 대시보드 스캔부가 `snap.forEach(...)` 와 `snap.size` 만 쓰기 때문에 이걸로 충분하다.
 */
export function snapshotFromDocs(docs) {
    const list = Array.isArray(docs) ? docs : [];
    return {
        size: list.length,
        docs: list,
        forEach: (fn) => list.forEach(fn)
    };
}

/**
 * 식사 날짜(date)로 자른다 — 경계 포함.
 *
 * 서버 쿼리가 `where('date','>=',start)` + `where('date','<=',end)` 로 걸던 구간과
 * 같아야 한다. 특히 **위쪽 경계를 빼먹으면 안 된다**: 내일 날짜로 적힌 기록이
 * 이번 주 칸에 들어가 오늘까지의 합계가 부풀어 오른다.
 *
 * @param {object[]} items 미러 행이거나, 행을 감싼 스냅숏 흉내 객체
 * @param {(item:object)=>any} [getDate] 항목에서 날짜키를 꺼내는 법 (기본: `item.date`)
 */
export function filterMealRowsByDate(items, startYmd, endYmd, getDate) {
    if (!Array.isArray(items)) return [];
    const pick = typeof getDate === 'function' ? getDate : (x) => x?.date;
    return items.filter((x) => {
        const d = pick(x);
        return typeof d === 'string' && d >= startYmd && d <= endYmd;
    });
}

/**
 * 슬롯별 「전체」 건수 — 서버의 `count(where slotId == …)` 자리.
 * 제외 UID 는 세지 않는다(서버 경로에서 나중에 빼던 몫을 여기서 미리 거른다).
 *
 * @param {object[]} rows meals 미러 행
 * @param {string[]} slotIds 세고 싶은 슬롯 id 목록 — 결과는 같은 순서의 배열
 * @param {Set<string>} excluded
 */
export function countSlotAllFromRows(rows, slotIds, excluded) {
    const ids = Array.isArray(slotIds) ? slotIds : [];
    const index = new Map(ids.map((id, i) => [id, i]));
    const out = ids.map(() => 0);
    for (const r of rows || []) {
        if (!r || (excluded && excluded.has(r.userId))) continue;
        const i = index.get(r.slotId);
        if (i != null) out[i] += 1;
    }
    return out;
}

/** meals 전체 건수 — 제외 UID 를 뺀 값 (서버의 `count(meals)` 자리) */
export function countMealRows(rows, excluded) {
    let n = 0;
    for (const r of rows || []) {
        if (!r || (excluded && excluded.has(r.userId))) continue;
        n += 1;
    }
    return n;
}

/**
 * 기록이 하나라도 있는 사용자 — 「활성 사용자·전체」 자리.
 *
 * 서버 경로에서는 이걸 알아내려고 **사용자마다 count 쿼리를 한 번씩** 던졌다
 * (사용자가 늘수록 그대로 늘어나는 비용). 미러에서는 한 번 훑으면 끝이다.
 */
export function distinctMealUserIds(rows, excluded) {
    const set = new Set();
    for (const r of rows || []) {
        const uid = r?.userId;
        if (!uid || (excluded && excluded.has(uid))) continue;
        set.add(uid);
    }
    return set;
}

/**
 * users 미러 행 → 대시보드가 훑던 `usersSnapshot.docs` 모양.
 * 대시보드는 `doc.id` 와 `doc.data().createdAt` 만 본다.
 */
export function userRowsToDocLike(rows) {
    return (Array.isArray(rows) ? rows : [])
        .filter((r) => r && r.userId)
        .map((r) => ({
            id: r.userId,
            data: () => ({ createdAt: r.createdAt || null })
        }));
}

/**
 * users 미러 행에 담긴 하루 소감 자국 → 대시보드가 세는 평평한 목록.
 *
 * 서버 경로의 `collectionGroup('config')` 전량 스캔이 만들던 것과 같은 모양이다.
 * 내용 유무는 미러에 담을 때 이미 걸렀으므로 여기서 다시 보지 않는다.
 *
 * @returns {{uid:string, dateStr:string, recordedAt:string}[]}
 */
export function journalMarksFromUserRows(rows, excluded) {
    const out = [];
    for (const r of rows || []) {
        const uid = r?.userId;
        if (!uid || (excluded && excluded.has(uid))) continue;
        for (const m of Array.isArray(r.journal) ? r.journal : []) {
            const dateStr = typeof m?.d === 'string' ? m.d : '';
            if (!DATE_KEY_RE.test(dateStr)) continue;
            out.push({ uid, dateStr, recordedAt: typeof m?.r === 'string' ? m.r : '' });
        }
    }
    return out;
}

/** 있지도 않은 문서 자리 — 소비자가 `exists()`/`data()` 를 그대로 부를 수 있게 */
const MISSING_DOC = { exists: () => false, data: () => ({}) };

/**
 * 미러 문서를 id 로 찾을 수 있게 편다.
 * `usageDaily` 는 문서 id 가 곧 날짜(YYYY-MM-DD)라, 날짜로 바로 집어 쓴다.
 */
export function indexDocsById(docs) {
    const map = new Map();
    for (const d of Array.isArray(docs) ? docs : []) {
        if (d && d.id) map.set(d.id, d);
    }
    return map;
}

/** 없으면 「빈 문서」를 돌려준다 — 서버 경로에서 `exists() === false` 이던 자리 */
export function docOrMissing(map, id) {
    return (map && map.get(id)) || MISSING_DOC;
}

/**
 * 문서 id 로 자른다 — 경계 포함. 서버의
 * `where(documentId() >= from)` + `where(documentId() <= to)` 자리다.
 */
export function filterDocsByIdRange(docs, fromId, toId) {
    return (Array.isArray(docs) ? docs : []).filter((d) => {
        const id = d?.id;
        return typeof id === 'string' && id >= fromId && id <= toId;
    });
}
