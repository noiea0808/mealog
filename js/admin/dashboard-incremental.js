/**
 * 관리자 대시보드 증분 집계 — 「새로고침」이 meals 전량을 다시 읽지 않게 하는 병합 규칙.
 *
 * 전량 스캔이 비싼 이유는 단순하다. 운영 시작일 이후 meals 가 1만 건을 넘는데,
 * 그중 지난 주차들의 숫자는 이미 확정돼 다시 셀 이유가 없다.
 *
 * 그래서 구간을 셋으로 나눈다.
 *
 *   [ 얼린 과거 주차 ]  [ 소급 delta ]  [ 다시 세는 최근 구간 ]
 *
 * - **다시 세는 구간**: 현재 주와 최근 7일이 걸치는 곳. 여기는 캐시를 버리고 새로 센다.
 *   이 구간이 정확해야 「최근 7일」과 이번 주 칸이 맞는다.
 * - **얼린 과거**: 캐시 값을 그대로 쓴다.
 * - **소급 delta**: 8/26에 7/29 식사를 적는 식으로 과거 칸에 뒤늦게 들어온 기록.
 *   `recordedAt` 으로 「지난 집계 이후 새로 적힌 것」만 골라 과거 칸에 더한다.
 *
 * 이 파일은 날짜·배열 계산만 한다 — Firestore 는 모른다.
 */

/** 'YYYY-MM-DD' 에 일수를 더한 키. 잘못된 입력이면 '' */
export function addDaysToDateKey(dateKey, days) {
    if (typeof dateKey !== 'string') return '';
    const p = dateKey.split('-');
    if (p.length !== 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    if (Number.isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

/**
 * 다시 세는 구간의 시작 날짜.
 *
 * 현재 주의 일요일과 「최근 7일」의 첫날 중 **이른 쪽**이다. 둘 중 하나만 덮으면
 * 나머지 표가 어긋난다 — 수요일이면 최근 7일이 지난 주 목요일까지 뻗고,
 * 일요일이면 반대로 현재 주가 하루뿐이라 최근 7일이 더 넓다.
 *
 * @param {string} todayKey 'YYYY-MM-DD'
 * @param {string} sundayKeyOfToday 오늘이 속한 주의 일요일 키
 */
export function rescanStartDateKey(todayKey, sundayKeyOfToday) {
    const last7First = addDaysToDateKey(todayKey, -6);
    if (!last7First) return sundayKeyOfToday || todayKey;
    if (!sundayKeyOfToday) return last7First;
    return last7First < sundayKeyOfToday ? last7First : sundayKeyOfToday;
}

/**
 * 다시 세는 구간이 시작되는 주차 인덱스. 이 인덱스부터는 캐시를 쓰지 않는다.
 * 못 찾으면 0 — 전 구간을 다시 세는 쪽이 틀린 숫자를 보여주는 것보다 낫다.
 *
 * @param {{sundayKey: string}[]} weeks
 * @param {string} rescanStartKey
 */
export function rescanFromWeekIndex(weeks, rescanStartKey) {
    if (!Array.isArray(weeks) || weeks.length === 0) return 0;
    if (!rescanStartKey) return 0;
    for (let i = 0; i < weeks.length; i++) {
        const wk = weeks[i]?.sundayKey;
        const next = weeks[i + 1]?.sundayKey;
        if (!wk) continue;
        // rescanStartKey 가 속한 주 = 이 주의 일요일 <= 시작키 < 다음 주 일요일
        if (wk <= rescanStartKey && (!next || rescanStartKey < next)) return i;
    }
    return 0;
}

/**
 * 주차 배열 하나를 병합한다.
 *
 * @param {number[]} cached 지난 집계가 남긴 값 (없으면 0으로 친다)
 * @param {number[]} rescanned 다시 센 값 — fromIndex 이후만 신뢰한다
 * @param {number[]} retroDelta 소급 입력분 — fromIndex 이전 칸에만 더한다
 * @param {number} fromIndex 이 인덱스부터 rescanned 로 덮어쓴다
 * @param {number} length 결과 길이
 */
export function mergeWeeklyArray(cached, rescanned, retroDelta, fromIndex, length) {
    const out = [];
    for (let i = 0; i < length; i++) {
        if (i >= fromIndex) {
            out.push(Number(rescanned?.[i]) || 0);
        } else {
            // 소급분은 다시 세는 구간 밖에서만 의미가 있다.
            // 구간 안쪽은 rescanned 에 이미 포함돼 있어, 여기서 또 더하면 이중 계산이다.
            out.push((Number(cached?.[i]) || 0) + (Number(retroDelta?.[i]) || 0));
        }
    }
    return out;
}

/**
 * `{ 키: number[] }` 형태(슬롯별·시간대별)를 통째로 병합한다.
 * @param {string[]} keys 결과에 담을 키 목록 — 캐시에 없던 키도 0으로 채워 자리를 만든다
 */
export function mergeWeeklyMap(keys, cachedMap, rescannedMap, retroMap, fromIndex, length) {
    const out = {};
    for (const k of keys) {
        out[k] = mergeWeeklyArray(cachedMap?.[k], rescannedMap?.[k], retroMap?.[k], fromIndex, length);
    }
    return out;
}

/**
 * 소급 입력으로 볼지 판단한다.
 *
 * `recordedAt` 이 지난 집계 이후인 문서만 증분 쿼리에 걸리는데, 그중 상당수는
 * 다시 세는 구간 안(=오늘 적고 오늘 먹은 것)이라 이미 세어졌다. 구간 **밖**을 가리키는
 * 것만 과거 칸에 더해야 한다.
 *
 * @param {string} mealDateKey 기록이 가리키는 식사 날짜
 * @param {string} rescanStartKey 다시 세는 구간의 시작
 */
export function isRetroactive(mealDateKey, rescanStartKey) {
    if (typeof mealDateKey !== 'string' || !mealDateKey) return false;
    if (typeof rescanStartKey !== 'string' || !rescanStartKey) return false;
    return mealDateKey < rescanStartKey;
}

/**
 * 증분을 쓸 수 있는 상태인지.
 *
 * 캐시가 없거나, 지난 집계 시각을 모르거나, 주차 구성이 달라졌으면(운영 시작일 변경 등)
 * 얼릴 근거가 없으므로 전량 집계로 돌아간다.
 *
 * @param {{lastAggregatedAt?: string, weeklyBreakdown?: {weeks?: {sundayKey: string}[]}}|null} cached
 * @param {{sundayKey: string}[]} weeks 이번에 계산한 주차 메타
 * @returns {{ok: boolean, reason?: string}}
 */
export function canUseIncremental(cached, weeks) {
    if (!cached) return { ok: false, reason: 'no-cache' };
    const at = typeof cached.lastAggregatedAt === 'string' ? cached.lastAggregatedAt.trim() : '';
    if (!at) return { ok: false, reason: 'no-last-aggregated-at' };
    if (Number.isNaN(Date.parse(at))) return { ok: false, reason: 'bad-last-aggregated-at' };
    const cachedWeeks = cached.weeklyBreakdown?.weeks;
    if (!Array.isArray(cachedWeeks) || cachedWeeks.length === 0) return { ok: false, reason: 'no-cached-weeks' };
    // 주차가 늘어나는 것은 정상(시간이 흐르면 늘어난다). 앞쪽이 어긋나면 다른 구간이다.
    if (cachedWeeks.length > weeks.length) return { ok: false, reason: 'cached-weeks-longer' };
    for (let i = 0; i < cachedWeeks.length; i++) {
        if (cachedWeeks[i]?.sundayKey !== weeks[i]?.sundayKey) return { ok: false, reason: 'week-mismatch' };
    }
    return { ok: true };
}

/**
 * 유니크 수(활성 사용자, 공유 게시물)를 병합한다.
 *
 * 이런 값은 **더할 수 없다.** 같은 사람이 그 주에 이미 세어졌는지 숫자만 봐서는 알 수 없어서다.
 * 그래서 다시 센 구간만 새 값으로 쓰고, 과거는 캐시를 그대로 둔다.
 *
 * 대가가 있다 — 소급 입력으로 어떤 주에 **처음** 기록한 사람이 생기면 그 주 칸이 한 명 적게 남는다.
 * 「전체 재집계」가 청소한다.
 */
export function mergeUniqueArray(cached, computed, fromIndex, length) {
    const out = [];
    for (let i = 0; i < length; i++) {
        out.push(i >= fromIndex ? Number(computed?.[i]) || 0 : Number(cached?.[i]) || 0);
    }
    return out;
}

/**
 * 주차 밖까지 포함한 「전체」 값.
 *
 * 증분은 주차 배열만 정확히 유지한다. 그런데 운영 시작일 이전에 가입한 사람처럼
 * **어느 주차에도 속하지 않는 몫**이 있어서, 주차 합만 쓰면 그만큼 빠진다.
 * 그 수는 캐시가 알고 있고(캐시의 전체 − 캐시의 주차 합) 앞으로 더 늘지 않는다.
 */
export function totalWithOutsideWeeks(mergedWeekSum, cachedTotal, cachedWeekSum) {
    const outside = (Number(cachedTotal) || 0) - (Number(cachedWeekSum) || 0);
    return (Number(mergedWeekSum) || 0) + Math.max(0, outside);
}
