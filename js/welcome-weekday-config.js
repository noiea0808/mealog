/**
 * 웰컴 팝업 요일별 기본 노출 화면 — 앱(ui.js)·관리자(admin) 공용 스키마.
 * 슬라이드 라벨/순서는 `js/analytics/charts.js`의 getWelcomeWeekDonutSlides와 1:1로 유지해야 한다.
 * 저장 위치: artifacts/{appId}/adminSettings/config.welcomeWeekdayDefaults
 */

/** 0=일 … 6=토 (Date#getDay와 동일) */
export const WELCOME_WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

export const WELCOME_KIND_LABELS = {
    report: 'AI리포트',
    meal: '식사',
    snack: '간식'
};

/** 탭별 슬라이드 라벨 — 배열 인덱스가 곧 slideIdx */
export const WELCOME_SLIDE_LABELS = {
    report: ['AI리포트'],
    meal: ['어떻게', '어디서 상세', '무엇을', '무엇을 상세', '함께', '함께 상세', '만족도', '포만감'],
    snack: [
        '언제',
        '어디서',
        '어디서 상세',
        '무엇을',
        '무엇을 상세',
        '누구와',
        '누구와 상세',
        '만족도',
        '포만감'
    ]
};

/** @typedef {{ kind: 'report'|'meal'|'snack', slideIdx: number }} WelcomeWeekdayEntry */

/** 관리자 설정이 없을 때 쓰는 기본값 — 설정 도입 전 하드코딩과 동일 */
export const DEFAULT_WELCOME_WEEKDAY_DEFAULTS = Object.freeze({
    0: { kind: 'snack', slideIdx: 4 }, // 일 — 간식 무엇을 상세
    1: { kind: 'report', slideIdx: 0 }, // 월 — AI리포트
    2: { kind: 'meal', slideIdx: 0 }, // 화 — 어떻게
    3: { kind: 'meal', slideIdx: 5 }, // 수 — 함께 상세
    4: { kind: 'report', slideIdx: 0 }, // 목 — AI리포트
    5: { kind: 'meal', slideIdx: 2 }, // 금 — 무엇을
    6: { kind: 'meal', slideIdx: 3 } // 토 — 무엇을 상세
});

/** @param {unknown} v */
export function pickWelcomeKind(v) {
    return v === 'report' || v === 'meal' || v === 'snack' ? v : null;
}

/**
 * @param {'report'|'meal'|'snack'} kind
 * @param {unknown} idx
 * @returns {number} 해당 탭의 슬라이드 범위로 자른 인덱스
 */
export function clampWelcomeSlideIdx(kind, idx) {
    const max = (WELCOME_SLIDE_LABELS[kind] || WELCOME_SLIDE_LABELS.meal).length - 1;
    const n = Number(idx);
    if (!Number.isFinite(n)) return 0;
    return Math.min(Math.max(Math.trunc(n), 0), Math.max(max, 0));
}

/**
 * 저장 값 → 요일 7개가 모두 채워진 객체. 잘못된 값은 요일별 기본값으로 되돌린다.
 * @param {unknown} raw
 * @returns {Record<number, WelcomeWeekdayEntry>}
 */
export function normalizeWelcomeWeekdayDefaults(raw) {
    /** @type {Record<number, WelcomeWeekdayEntry>} */
    const out = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    for (let day = 0; day <= 6; day++) {
        const fallback = DEFAULT_WELCOME_WEEKDAY_DEFAULTS[day];
        const row = src[day] ?? src[String(day)];
        const kind = row && typeof row === 'object' ? pickWelcomeKind(row.kind) : null;
        if (!kind) {
            out[day] = { ...fallback };
            continue;
        }
        out[day] = { kind, slideIdx: clampWelcomeSlideIdx(kind, row.slideIdx) };
    }
    return out;
}
