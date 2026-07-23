/**
 * meals on-demand / realtime 로드 구간 추적.
 * 단일 [start,end] 봉투만 쓰면 멀리 점프 시 중간 구멍이 "이미 로드됨"으로 오인된다.
 * 서로 겹치거나 인접한 구간은 합치고, 커버리지로 needs/skip 을 판단한다.
 */

const INTERVALS_KEY = '__mealogLoadedMealsIntervals';

function isYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function getIntervalsRaw() {
    if (typeof window === 'undefined') return [];
    const arr = window[INTERVALS_KEY];
    return Array.isArray(arr) ? arr : [];
}

function setIntervalsRaw(intervals) {
    if (typeof window === 'undefined') return;
    window[INTERVALS_KEY] = intervals;
}

/** 겹치거나 하루 이내로 인접한 구간 병합 */
export function mergeDateIntervals(intervals) {
    const list = (intervals || [])
        .filter((iv) => iv && isYmd(iv.start) && isYmd(iv.end) && iv.start <= iv.end)
        .map((iv) => ({ start: iv.start, end: iv.end }))
        .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
    if (!list.length) return [];
    const out = [{ ...list[0] }];
    for (let i = 1; i < list.length; i++) {
        const cur = list[i];
        const last = out[out.length - 1];
        // end+1day >= cur.start → 인접/겹침 (문자열 날짜는 addDay 없이 하루 간격 판별)
        if (cur.start <= nextYmd(last.end)) {
            if (cur.end > last.end) last.end = cur.end;
        } else {
            out.push({ ...cur });
        }
    }
    return out;
}

function nextYmd(ymd) {
    if (!isYmd(ymd)) return ymd;
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d + 1);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function syncEnvelopeFromIntervals(intervals) {
    if (typeof window === 'undefined') return;
    if (!intervals.length) {
        window.loadedMealsDateRange = null;
        return;
    }
    window.loadedMealsDateRange = {
        start: intervals[0].start,
        end: intervals[intervals.length - 1].end
    };
}

/** 로그아웃·계정 전환 시 */
export function clearLoadedMealsRanges() {
    setIntervalsRaw([]);
    if (typeof window !== 'undefined') {
        window.loadedMealsDateRange = null;
    }
}

/**
 * 구간을 로드 완료로 표시하고 봉투(loadedMealsDateRange)를 갱신.
 * @param {string} startYmd
 * @param {string} endYmd
 */
export function markMealsRangeLoaded(startYmd, endYmd) {
    if (!isYmd(startYmd) || !isYmd(endYmd)) return;
    const start = startYmd <= endYmd ? startYmd : endYmd;
    const end = startYmd <= endYmd ? endYmd : startYmd;
    const merged = mergeDateIntervals([...getIntervalsRaw(), { start, end }]);
    setIntervalsRaw(merged);
    syncEnvelopeFromIntervals(merged);
}

/**
 * 기존 구간을 버리고 하나의 구간만 남김 (데모·1회 전체 교체 등).
 * @param {string} startYmd
 * @param {string} endYmd
 */
export function replaceLoadedMealsRanges(startYmd, endYmd) {
    clearLoadedMealsRanges();
    markMealsRangeLoaded(startYmd, endYmd);
}

/**
 * [start,end]가 이미 로드된 구간들로 완전히 덮이는지.
 * @param {string} startYmd
 * @param {string} endYmd
 */
export function isMealsRangeFullyLoaded(startYmd, endYmd) {
    if (!isYmd(startYmd) || !isYmd(endYmd)) return false;
    const start = startYmd <= endYmd ? startYmd : endYmd;
    const end = startYmd <= endYmd ? endYmd : startYmd;
    const intervals = getIntervalsRaw();
    if (!intervals.length) {
        // 레거시: intervals 없이 봉투만 있는 세션 호환
        const range = typeof window !== 'undefined' ? window.loadedMealsDateRange : null;
        if (!range?.start || !range?.end) return false;
        return start >= range.start && end <= range.end;
    }
    // 요청 구간을 걷어내며 각 interval로 덮이는지 확인
    let cursor = start;
    const sorted = mergeDateIntervals(intervals);
    for (const iv of sorted) {
        if (iv.end < cursor) continue;
        if (iv.start > cursor) return false;
        if (iv.end >= end) return true;
        cursor = nextYmd(iv.end);
        if (cursor > end) return true;
    }
    return false;
}

export function getLoadedMealsIntervals() {
    return mergeDateIntervals(getIntervalsRaw());
}
