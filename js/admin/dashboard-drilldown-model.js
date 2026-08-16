/**
 * 대시보드 드릴다운의 「누가 계속 썼고 누가 끊겼나」 판정.
 *
 * 화면·Firestore와 분리해 둔 이유는 이 계산이 조용히 틀리기 때문이다 — 마지막 구간을
 * 하나 잘못 세면 이탈자가 지속 사용자로 둔갑하고, 표는 아무 경고 없이 그럴듯하게 그려진다.
 * 여기에는 import 가 없어야 `node --test` 로 그대로 검증할 수 있다.
 *
 * @typedef {{ key: string, label: string, active: Set<string>, new: Set<string> }} Period
 */

/** 구간들의 활성·신규 합집합 (월 칸의 「유니크」와 같은 정의) */
export function unionOfPeriods(periods) {
    const active = new Set();
    const fresh = new Set();
    for (const p of periods || []) {
        p.active?.forEach((u) => active.add(u));
        p.new?.forEach((u) => fresh.add(u));
    }
    return { active, fresh };
}

/**
 * 사용자 한 명의 구간별 출석 행.
 *
 * `gap` 은 마지막 구간부터 연속으로 비어 있는 칸 수다. 지속/이탈을 임의 기준(예: 2주 이상)
 * 으로 판정하지 않고 이 숫자를 그대로 보여 주기 위한 것 — 기준은 보는 사람이 정한다.
 * @param {string} uid
 * @param {Period[]} periods
 */
export function buildMatrixRow(uid, periods, profile, joinKey, isNew) {
    const list = periods || [];
    const marks = list.map((p) => ({
        active: !!p.active?.has(uid),
        joined: !!p.new?.has(uid)
    }));
    const activeCount = marks.filter((m) => m.active).length;
    let gap = 0;
    for (let i = marks.length - 1; i >= 0 && !marks[i].active; i--) gap++;
    // 한 번도 활동이 없으면 gap 은 전체 길이가 되지만, 그건 「끊겼다」가 아니라 「시작을 안 했다」다
    const status = activeCount === 0 ? 'none' : gap === 0 ? 'kept' : 'gap';
    return {
        uid,
        nickname: profile?.nickname || '미설정',
        icon: profile?.icon || '🐻',
        joinKey: joinKey || '',
        isNew: !!isNew,
        marks,
        activeCount,
        gap: activeCount === 0 ? 0 : gap,
        status
    };
}

/**
 * 가입 순서(오래된 사람부터). 위에서부터 읽으면 「초기 사용자 중 몇 명이나 남았나」가 보인다.
 *
 * 가입일이 없는 사용자(createdAt 누락)는 맨 아래로 보낸다 — 빈 문자열은 어떤 날짜보다도
 * 앞서 정렬되므로, 그대로 두면 정보가 없는 행이 제일 오래된 사용자인 척 맨 위를 차지한다.
 */
export function sortMatrixRows(rows) {
    return [...(rows || [])].sort((a, b) => {
        const ak = String(a.joinKey || '');
        const bk = String(b.joinKey || '');
        if (!ak !== !bk) return ak ? -1 : 1;
        if (ak !== bk) return ak.localeCompare(bk);
        return String(a.nickname || '').localeCompare(String(b.nickname || ''), 'ko');
    });
}

/** 신규를 위로, 그다음 가입일 최신순 */
export function sortListRows(rows) {
    return [...(rows || [])].sort((a, b) => {
        if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
        return String(b.joinKey).localeCompare(String(a.joinKey));
    });
}

/** 상태별 인원 요약 */
export function summarizeMatrix(rows) {
    const out = { kept: 0, gap: 0, none: 0, total: (rows || []).length };
    for (const r of rows || []) {
        if (r.status in out) out[r.status]++;
    }
    return out;
}
