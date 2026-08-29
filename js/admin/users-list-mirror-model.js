/**
 * 사용자 목록 미러 조립 — 순수 계산부
 *
 * 「어느 사용자에게 몇 건이 붙는가」를 세는 자리. 예전에는 이 숫자 하나하나가
 * 서버 집계 쿼리였다(사용자마다 meals count, 페이지마다 `in` 쿼리).
 * 미러에서는 한 번 훑으면 전부 나온다.
 *
 * DOM·IDB·네트워크를 모르므로 node 테스트로 그대로 돌린다.
 * 설계 문서: docs/admin-local-mirror.md
 */

/**
 * 항목을 key 별로 센다.
 * @param {any[]} items
 * @param {(item:any)=>string|null|undefined} keyOf 세는 축 — 빈 값이면 세지 않는다
 * @returns {Map<string, number>}
 */
export function countByField(items, keyOf) {
    const out = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        let key;
        try {
            key = keyOf(item);
        } catch {
            continue;
        }
        if (!key) continue;
        out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
}

/**
 * key 별로 **처음 만난** 값 하나만 남긴다.
 *
 * 공유 게시물에서 아이콘을 빌려 올 때 쓴다 — 예전 서버 목록도 `in` 쿼리가 돌려준
 * 문서 중 먼저 만난 것을 썼다(`sharedUserMap` 에 `has()` 로 한 번만 넣었다).
 * 값이 비면(아이콘 없는 게시물) 건너뛰고 다음 것을 본다.
 *
 * @returns {Map<string, any>}
 */
export function firstValueByField(items, keyOf, valueOf) {
    const out = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        let key;
        let value;
        try {
            key = keyOf(item);
            value = valueOf(item);
        } catch {
            continue;
        }
        if (!key || value == null || value === '') continue;
        if (!out.has(key)) out.set(key, value);
    }
    return out;
}
