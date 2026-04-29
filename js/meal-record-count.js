/**
 * 트래커·웰컴·연속일 계산 공통: 일자별 실질 기록 건수.
 * dailyStats(Firestore 연도별 집계) ∪ mealHistory(최근 meals 스냅샷) 중 큰 값.
 *
 * 예전에는 삭제 직후 stats만 남는 경우를 막기 위해 stats>0·history=0 이면 0으로 덮었는데,
 * 초기 meals 쿼리가 최대 50건만 가져와서(같은 달 안에서도 일부 날짜가 스냅샷에 없음)
 * 스테이징·운영·세션마다 meal 개수가 달라 **캘린더 점·연속일이 환경마다 다르게** 보이는 버그가 있었다.
 * 그래서 max(stats, history)를 쓰는데, stats 리스너가 집계 갱신 전 옛 값을 다시 덮으면
 * 삭제 직후 **history=0인데 stats만 남는** 유령 일자가 생긴다.
 * 그날 끼니를 전부 지운 뒤에는 {@link trustStreakHistoryEmptyForDay}로 히스토리(0건)를 따르도록 표시한다.
 */
const STREAK_EMPTY_TRUST_KEY = '__mealogStreakEmptyDayTrustYmd';

function isValidYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function getStreakEmptyDayTrustSet() {
    if (typeof window === 'undefined') return null;
    if (!window[STREAK_EMPTY_TRUST_KEY]) {
        window[STREAK_EMPTY_TRUST_KEY] = new Set();
    }
    return window[STREAK_EMPTY_TRUST_KEY];
}

/**
 * 해당 날짜에 mealHistory에 끼니가 없을 때(삭제로 0이 됨), stats가 늦게/잘못 갱신돼도 연속일·트래커는 0건으로 본다.
 * @param {string} iso YYYY-MM-DD
 */
export function trustStreakHistoryEmptyForDay(iso) {
    if (!isValidYmd(iso)) return;
    getStreakEmptyDayTrustSet()?.add(iso);
}

/**
 * @param {string} iso YYYY-MM-DD
 */
export function untrustStreakHistoryEmptyForDay(iso) {
    if (!isValidYmd(iso)) return;
    getStreakEmptyDayTrustSet()?.delete(iso);
}

export function clearStreakEmptyDayTrustAll() {
    if (typeof window === 'undefined') return;
    try {
        getStreakEmptyDayTrustSet()?.clear();
    } catch (_) {
        /* ignore */
    }
    try {
        delete window[STREAK_EMPTY_TRUST_KEY];
    } catch (_) {
        /* ignore */
    }
}

/**
 * Firestore stats 병합 직후: 삭제로 "빈 날"로 마킹된 날짜 키는 서버 집계가 늦어도 제거해 유령 일자 방지.
 * @param {Record<string, unknown>|null|undefined} daily
 * @returns {Record<string, unknown>|null|undefined}
 */
export function applyStreakTrustPatchesToDailyStats(daily) {
    if (!daily || typeof daily !== 'object') return daily;
    const t = getStreakEmptyDayTrustSet();
    if (!t || t.size === 0) return daily;
    let out = null;
    for (const iso of t) {
        if (!isValidYmd(iso)) continue;
        if (Object.prototype.hasOwnProperty.call(daily, iso) && daily[iso]) {
            if (!out) out = { ...daily };
            delete out[iso];
        }
    }
    return out || daily;
}

/**
 * meals 쿼리 윈도우에 해당하는 스냅샷을 **전부** 받은 경우(doc 수 < limit 50일 때만):
 * [cutoff, end] 구간에서 mealHistory에 끼니가 없는 날의 daily 키는 서버 집계와 불일치·지연으로
 * 리로드 후에도 유령이 되므로 제거한다. (삭제 후 전부 지운 뒤 새로고침 시 연속일 복구 방지)
 * @param {Record<string, unknown>|null|undefined} daily
 */
export function stripGhostDailyStatsInQueryWindow(daily) {
    if (!daily || typeof daily !== 'object') return daily;
    if (!window.__mealogMealsWindowFullyLoaded) return daily;
    const cutoff = window.__mealogMealsQueryCutoff;
    const end = window.__mealogMealsQueryEnd;
    if (typeof cutoff !== 'string' || typeof end !== 'string' || !isValidYmd(cutoff.slice(0, 10)) || !isValidYmd(end.slice(0, 10)))
        return daily;
    const c0 = cutoff.slice(0, 10);
    const e0 = end.slice(0, 10);

    const byDate = {};
    for (const m of window.mealHistory || []) {
        if (!m?.date || typeof m.date !== 'string') continue;
        const d = m.date.trim().slice(0, 10);
        if (!isValidYmd(d)) continue;
        byDate[d] = (byDate[d] || 0) + 1;
    }
    let out = null;
    for (const iso of Object.keys(daily)) {
        if (!isValidYmd(iso) || iso < c0 || iso > e0) continue;
        if ((byDate[iso] || 0) !== 0) continue;
        if (!out) out = { ...daily };
        delete out[iso];
    }
    return out || daily;
}

/** 로그아웃·계정 전환 시 meals–stats 정합 플래그 초기화 */
export function clearMealsWindowStatsReconcileMeta() {
    if (typeof window === 'undefined') return;
    try {
        delete window.__mealogMealsWindowFullyLoaded;
        delete window.__mealogMealsQueryCutoff;
        delete window.__mealogMealsQueryEnd;
    } catch (_) {
        /* ignore */
    }
}

/**
 * @param {string} iso YYYY-MM-DD
 * @returns {number}
 */
export function getRecordCountForIso(iso) {
    if (!isValidYmd(iso)) return 0;
    const statsCount = (window.dailyStats && window.dailyStats[iso]?.count) ?? 0;
    const historyCount =
        window.mealHistory && Array.isArray(window.mealHistory)
            ? window.mealHistory.filter((m) => m && m.date === iso).length
            : 0;

    if (historyCount > 0) {
        getStreakEmptyDayTrustSet()?.delete(iso);
        return Math.max(statsCount, historyCount);
    }

    const t = getStreakEmptyDayTrustSet();
    if (t && t.has(iso)) {
        // statsCount===0일 때 Set에서 빼면 안 됨: 집계가 잠깐 0으로 온 뒤 캐시/늦은 스냅샷이
        // 다시 옛 count를 덮으면 trust 없이 유령 일자가 부활한다. 해제는 historyCount>0(재기록)뿐.
        return 0;
    }

    return Math.max(statsCount, historyCount);
}
