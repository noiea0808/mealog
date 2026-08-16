/**
 * 대시보드 드릴다운의 「누가 계속 썼고 누가 끊겼나」 판정.
 *
 * 화면·Firestore와 분리해 둔 이유는 이 계산이 조용히 틀리기 때문이다 — 마지막 구간을
 * 하나 잘못 세면 이탈자가 지속 사용자로 둔갑하고, 표는 아무 경고 없이 그럴듯하게 그려진다.
 * 여기에는 import 가 없어야 `node --test` 로 그대로 검증할 수 있다.
 *
 * @typedef {{ key: string, label: string, active: Set<string>, new: Set<string>,
 *   counts?: Record<string, number>|null }} Period
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
    const marks = list.map((p) => {
        const active = !!p.active?.has(uid);
        // counts 가 없는 구간(이 기능 이전에 저장된 문서)은 null → 화면이 ● 로 되돌아간다.
        // 0 으로 채우면 「그 주에 안 썼다」로 읽혀 활성 사용자가 결번처럼 보인다.
        const raw = p.counts ? Number(p.counts[uid]) : NaN;
        return {
            active,
            joined: !!p.new?.has(uid),
            count: p.counts ? (Number.isFinite(raw) ? raw : 0) : null
        };
    });
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

/**
 * 칸 배경 농도(0~4). 숫자만 늘어놓으면 점 격자가 주던 「한눈에 보이는 패턴」이 사라지므로
 * 값에 비례해 진하게 칠한다. 절대값이 아니라 표 안 최대값 대비 비율로 나눈다 —
 * 주차(기록 일수, 최대 7)와 일자(기록 건수, 상한 없음)가 같은 함수를 써야 하기 때문.
 * @param {number|null} count
 * @param {number} max 표 전체에서 가장 큰 값
 */
export function heatLevel(count, max) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return 0;
    const m = Number(max);
    if (!Number.isFinite(m) || m <= 0) return 1;
    const ratio = n / m;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
}

/** 표 안에서 가장 큰 칸 값 (농도 기준). 값이 하나도 없으면 0 */
export function maxMarkCount(rows) {
    let max = 0;
    for (const r of rows || []) {
        for (const m of r.marks || []) {
            const n = Number(m.count);
            if (Number.isFinite(n) && n > max) max = n;
        }
    }
    return max;
}

// ============================================================
// 닉네임 캐시 직렬화
//
// 닉네임은 사용자당 문서 1건이라 팝업 읽기의 대부분을 차지한다. 세션을 넘겨 재사용하려고
// localStorage 에 담는데, 만료·용량 처리를 틀리면 조용히 옛날 닉네임을 보여 주거나
// 저장이 영영 실패한다. 그래서 순수 함수로 떼어 검증한다.
// ============================================================

/** 저장 형식: { [uid]: { n: 닉네임, i: 아이콘, t: 저장시각ms } } */

/**
 * 저장본 → Map. 만료·형식 불량 항목은 버린다.
 * @param {string|null} raw localStorage 문자열
 * @param {number} nowMs
 * @param {number} ttlMs
 */
export function decodeProfileStore(raw, nowMs, ttlMs) {
    const out = new Map();
    if (!raw) return out;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [uid, v] of Object.entries(parsed)) {
        if (!uid || !v || typeof v !== 'object') continue;
        const t = Number(v.t);
        if (!Number.isFinite(t) || t > nowMs || nowMs - t > ttlMs) continue;
        if (typeof v.n !== 'string' || v.n === '') continue;
        out.set(uid, { nickname: v.n, icon: typeof v.i === 'string' && v.i ? v.i : '🐻', t });
    }
    return out;
}

/**
 * Map → 저장할 평범한 객체. 최근에 담은 것부터 cap 개까지만 남긴다
 * (용량 초과로 저장 자체가 실패하는 것보다 오래된 항목을 버리는 편이 낫다).
 * @param {Map<string,{nickname:string,icon:string,t:number}>} cache
 * @param {number} cap
 */
export function encodeProfileStore(cache, cap) {
    const entries = [...(cache?.entries?.() || [])]
        .filter(([uid, v]) => uid && v && typeof v.nickname === 'string' && Number.isFinite(v.t))
        .sort((a, b) => b[1].t - a[1].t)
        .slice(0, Math.max(0, cap));
    const obj = {};
    for (const [uid, v] of entries) obj[uid] = { n: v.nickname, i: v.icon || '🐻', t: v.t };
    return obj;
}
