/**
 * 출석/연속 기록 팝업 — 연속 일수는 {@link computeTrackerStreakDisplayDays}(서울 달력, 당일 기록이 있으면 오늘부터 세는 값)으로 분기·문구 치환.
 * (meals 쿼리는 최근 구간만 로드되므로 일자별 유무는 전역 dailyStats ∪ mealHistory와 {@link getRecordCountForIso}로 맞춤.)
 * 노출 빈도: 케이스별(기록 없음·연속 없음·1일·2일+) 관리자 설정 — 접속마다(sessionStorage) 또는 하루 1회(localStorage). 설정 미로드 시 기본은 하루 1회.
 * 관리자 설정(adminSettings/config.attendancePopup)으로 기록 유무·환경별 문구·노출(끔 포함).
 */
import { isDemoUser } from './demo-account.js';
import { appCheckInitPromise, db, appId, refreshAppCheckTokenBeforeFirestore } from './firebase.js';
import { getRecordCountForIso } from './meal-record-count.js';
import { showAttendancePopup, prepareWelcomeReportState } from './ui.js';
import { addCalendarDaysSeoulYmd, getMealogClientEnv, toLocalDateString, toSeoulDateString } from './utils.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

function isValidYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** @returns {Set<string>} */
export function collectRecordedDateSet() {
    const candidates = new Set();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        for (const m of window.mealHistory) {
            if (m?.date && isValidYmd(m.date)) candidates.add(m.date);
        }
    }
    if (window.dailyStats && typeof window.dailyStats === 'object') {
        for (const iso of Object.keys(window.dailyStats)) {
            if (isValidYmd(iso)) candidates.add(iso);
        }
    }
    const set = new Set();
    for (const iso of candidates) {
        if (getRecordCountForIso(iso) > 0) set.add(iso);
    }
    return set;
}

/**
 * 연속 기록·기록완료 멘트용 날짜 집합.
 * — 예전에는 mealHistory만 썼는데, meals 리스너가 **최근 ~21일·최대 50건**만 올려
 *   긴 연속 기록이 그 구간 밖에서 끊긴 것처럼 짧게 나왔음(해당 월 한정 계산 아님).
 * — 트래커와 동일하게 {@link collectRecordedDateSet} (dailyStats ∪ mealHistory, count>0) 사용.
 * @returns {Set<string>}
 */
export function collectRecordedDateSetForStreak() {
    return collectRecordedDateSet();
}

/**
 * 오늘(서울 달력) 기준 **전일(어제)**부터 역순으로 이어진 연속 기록 일수.
 * 전일에 기록이 없으면 0 (과거에만 기록이 있어도 연속 기록으로 보지 않음).
 * — 브라우저 로컬 날짜와 기록 YYYY-MM-DD가 어긋나면 오판하므로 Asia/Seoul 기준으로 통일.
 */
export function computeConsecutiveStreakDays(dateSet) {
    if (!dateSet || dateSet.size === 0) return 0;
    const today = toSeoulDateString(new Date());
    const yesterday = addCalendarDaysSeoulYmd(today, -1);
    if (!yesterday || !dateSet.has(yesterday)) return 0;
    let streak = 0;
    let cursor = yesterday;
    while (dateSet.has(cursor)) {
        streak++;
        cursor = addCalendarDaysSeoulYmd(cursor, -1);
    }
    return streak;
}

/**
 * 트래커 헤더 문구용: 오늘(서울)에 기록이 있으면 **오늘부터** 역순 연속 일수 (당일 첫 끼니 후에도 증가).
 * 없으면 {@link computeConsecutiveStreakDays}와 같이 **어제부터** (어제 공백이면 0).
 * — 서버·관리자 웰컴 내보내기 등 **전일만** 쓰는 곳은 {@link computeConsecutiveStreakDays} 유지.
 * @returns {number}
 */
export function computeTrackerStreakDisplayDays() {
    const set = collectRecordedDateSetForStreak();
    if (!set || set.size === 0) return 0;
    const today = toSeoulDateString(new Date());
    const yesterday = addCalendarDaysSeoulYmd(today, -1);
    const start = set.has(today) ? today : yesterday;
    if (!start || !set.has(start)) return 0;
    let streak = 0;
    let cursor = start;
    while (set.has(cursor)) {
        streak++;
        cursor = addCalendarDaysSeoulYmd(cursor, -1);
    }
    return streak;
}

/**
 * 타임라인 트래커 헤더(달력 아이콘 옆) — {@link computeTrackerStreakDisplayDays} 값 표시.
 */
export function updateTrackerStreakLabel() {
    const el = document.getElementById('trackerStreakLabel');
    if (!el) return;
    const n = computeTrackerStreakDisplayDays();
    let textEl = el.querySelector('.tracker-streak-pill__text');
    if (!textEl) {
        el.className = 'tracker-streak-pill tabular-nums whitespace-nowrap shrink-0';
        el.setAttribute('role', 'status');
        el.innerHTML =
            '<i data-lucide="flame" class="tracker-streak-pill__icon" aria-hidden="true"></i>' +
            `<span class="tracker-streak-pill__text">${n}일 연속</span>`;
        return;
    }
    textEl.textContent = `${n}일 연속`;
}

/**
 * 기록 완료 팝업 문구 — 해당 날짜 **첫** 신규 기록만 연속 메시지.
 * - {@link computeTrackerStreakDisplayDays}가 2일 미만이면 `기록 완료!`, 이상이면 `N일 연속 기록!` (당일 기준 연속 일수).
 * - 그날 두 번째 기록부터는 항상 `기록 완료!`
 * @param {boolean} wasNewRecord
 * @param {string} [mealDateIso] YYYY-MM-DD
 * @returns {string}
 */
export function resolveRecordCompletePopupMessage(wasNewRecord, mealDateIso) {
    if (!mealDateIso || typeof mealDateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(mealDateIso)) {
        return '기록 완료!';
    }
    if (!wasNewRecord) return '기록 완료!';
    const hist = window.mealHistory && Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const countOnDate = hist.filter((m) => m && m.date === mealDateIso).length;
    /** 병합 전 호출 시 0이 되어 첫 기록 분기가 깨짐 → entry-and-core에서는 mealHistory 반영 직후 호출 */
    if (countOnDate < 1) return '기록 완료!';
    if (countOnDate !== 1) return '기록 완료!';

    const s = computeTrackerStreakDisplayDays();
    if (s < 2) return '기록 완료!';
    return `${s}일 연속 기록!`;
}

let lastAttendanceUid = null;
/** 로컬 날짜가 바뀌면 세션 노출 플래그를 리셋(장시간 열린 탭에서도 자정 이후 재노출 가능) */
let welcomePopupLocalDay = null;
let attendanceDebounceTimer = null;

/** v3: 이전 세션/일일 키에 걸려 영구 미노출된 경우 초기화 */
const WELCOME_DAY_LS_PREFIX = 'mealog_welcome_shown_v3_';
const WELCOME_SESS_PREFIX = 'mealog_welcome_sess_v3_';
/**
 * 기록 없음(no)·기록 있음(ns/s1/s2p)이 서로 다른 localStorage 키를 쓰면,
 * meals/dailyStats 로드 전에는 기록 없음으로 팝업 → 마킹 후, 로드 후에는 연속일 분기로 다시 시도되어
 * 같은 날 웰컴이 여러 번 뜸(운영 ‘하루 1회’ 설정과 불일치).
 * `once_per_day`일 때는 시나리오와 무관하게 하루 1회만(rec)으로 통합한다.
 */
const WELCOME_RECORD_DAY_KIND = 'rec';

/**
 * @param {'no'|'ns'|'s1'|'s2p'} kind
 * @param {'off'|'once_per_day'|'every_session'} frequency
 * @returns {'no'|'ns'|'s1'|'s2p'|'rec'}
 */
function resolveWelcomeDayStorageKind(kind, frequency) {
    if (frequency === 'once_per_day') {
        return WELCOME_RECORD_DAY_KIND;
    }
    return kind;
}

/** 로컬 개발: sessionStorage는 탭 내 새로고침(F5)에도 유지되어 ‘접속마다’ 테스트가 막힘 → 풀 리로드마다 새 ID로 분리 */
const WELCOME_SESS_PAGE_ID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;

function isWelcomeLocalDevHost() {
    if (typeof window === 'undefined') return false;
    const h = window.location.hostname || '';
    return h === 'localhost' || h === '127.0.0.1' || h.startsWith('192.168.');
}

/** @param {'no'|'ns'|'s1'|'s2p'} kind */
function welcomeDayStorageKey(uid, kind) {
    return `${WELCOME_DAY_LS_PREFIX}${uid}_${kind}`;
}

/** @param {'no'|'ns'|'s1'|'s2p'} kind */
function wasWelcomeShownToday(uid, kind) {
    const today = toLocalDateString(new Date());
    try {
        return localStorage.getItem(welcomeDayStorageKey(uid, kind)) === today;
    } catch {
        return false;
    }
}

/** @param {'no'|'ns'|'s1'|'s2p'} kind */
function markWelcomeShownToday(uid, kind) {
    const today = toLocalDateString(new Date());
    try {
        localStorage.setItem(welcomeDayStorageKey(uid, kind), today);
    } catch {
        /* ignore */
    }
}

function welcomeSessionKey(uid, kind) {
    const base = `${WELCOME_SESS_PREFIX}${uid}_${kind}`;
    return isWelcomeLocalDevHost() ? `${base}_pl_${WELCOME_SESS_PAGE_ID}` : base;
}

/** @param {'no'|'ns'|'s1'|'s2p'} kind */
function wasWelcomeShownThisSession(uid, kind) {
    try {
        return sessionStorage.getItem(welcomeSessionKey(uid, kind)) === '1';
    } catch {
        return false;
    }
}

/** @param {'no'|'ns'|'s1'|'s2p'} kind */
function markWelcomeShownThisSession(uid, kind) {
    try {
        sessionStorage.setItem(welcomeSessionKey(uid, kind), '1');
    } catch {
        /* ignore */
    }
}

/**
 * @param {'no'|'ns'|'s1'|'s2p'} kind
 * @param {'off'|'once_per_day'|'every_session'} frequency
 */
function passesWelcomeFrequency(uid, kind, frequency) {
    if (frequency === 'off') return false;
    if (frequency === 'once_per_day') {
        const dayKind = resolveWelcomeDayStorageKind(kind, frequency);
        return !wasWelcomeShownToday(uid, dayKind);
    }
    if (frequency === 'every_session') return !wasWelcomeShownThisSession(uid, kind);
    return false;
}

/**
 * @param {'no'|'ns'|'s1'|'s2p'} kind
 * @param {'once_per_day'|'every_session'} frequency
 */
function markWelcomeForFrequency(uid, kind, frequency) {
    if (frequency === 'once_per_day') {
        const dayKind = resolveWelcomeDayStorageKind(kind, frequency);
        markWelcomeShownToday(uid, dayKind);
    } else if (frequency === 'every_session') {
        markWelcomeShownThisSession(uid, kind);
    }
}

function resetWelcomePopupGateIfNewLocalDay() {
    const t = toLocalDateString(new Date());
    if (welcomePopupLocalDay !== t) {
        welcomePopupLocalDay = t;
    }
}

/** in-flight만 공유 — 완료 후 비워서 매번 최신 adminSettings 반영(관리자 저장 직후 다른 탭 앱도 다음 팝업 시도에서 재조회) */
let attendancePopupConfigPromise = null;
/** 마지막으로 성공적으로 정규화한 웰컴 설정 — getDoc 지연으로 타임아웃 시 캐시·기본값(하루 1회)으로 과도 노출 완화 */
let lastResolvedAttendancePopupConfig = null;

export function invalidateAttendancePopupConfigCache() {
    attendancePopupConfigPromise = null;
    lastResolvedAttendancePopupConfig = null;
}

/** 메인 화면만 보면 스케줄(인증 hasCompleted·모달은 표시 직전에만 검사) */
function isMainScreenVisibleForWelcome() {
    if (typeof document === 'undefined') return false;
    const mainApp = document.getElementById('mainApp');
    return Boolean(mainApp && !mainApp.classList.contains('hidden'));
}

/** 실제 표시 직전: 온보딩·모달이 가리면 스킵. 로딩은 z가 더 낮아 웰컴이 위에 그려지므로 여기서 막지 않음(막으면 로딩과 타이밍만 겹쳐도 영구 미노출). */
function shouldShowWelcomeNow() {
    if (typeof document === 'undefined') return false;
    if (window._serviceGuideActive) return false;
    const guide = document.getElementById('serviceGuideOverlay');
    if (guide && !guide.classList.contains('hidden')) return false;
    const wiz = document.getElementById('signupWizard');
    if (wiz && !wiz.classList.contains('hidden')) return false;
    const terms = document.getElementById('termsModal');
    if (terms && !terms.classList.contains('hidden')) return false;
    const prof = document.getElementById('profileSetupModal');
    if (prof && !prof.classList.contains('hidden')) return false;
    return true;
}

const DEFAULT_NO_RECORD_L1 = '우리 오늘부터';
const DEFAULT_NO_RECORD_L2 = '시작하는거죠?!';

const DEFAULT_HEADLINE_NO_STREAK = '밀로그하기 좋은 날!!';
const DEFAULT_HEADLINE_STREAK_ONE = '2일 연속 기록 도전중!!';
const DEFAULT_HEADLINE_STREAK_MULTI = '{streak}일 연속 기록 중!';

/**
 * @param {{ message?: string|null }} sub message만 사용(빈도는 호출부에서 이미 반영)
 * @param {'noStreak'|'streakOne'|'streakTwoOrMore'} slot
 * @param {number} streak {@link computeTrackerStreakDisplayDays}와 동일(당일 기준, 2일 이상 문구의 {streak} 치환)
 */
function resolveHasRecordHeadline(sub, slot, streak) {
    const raw = sub?.message;
    const trimmed = raw != null ? String(raw).trim() : '';
    if (slot === 'noStreak') return trimmed || DEFAULT_HEADLINE_NO_STREAK;
    if (slot === 'streakOne') return trimmed || DEFAULT_HEADLINE_STREAK_ONE;
    const base = trimmed || DEFAULT_HEADLINE_STREAK_MULTI;
    return base.replace(/\{streak\}/g, String(streak));
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {string|null} 저장된 멀티라인 또는 null(앱 기본값)
 */
function pickNoRecordMessage(raw) {
    if (Object.prototype.hasOwnProperty.call(raw, 'noRecordMessage')) {
        if (raw.noRecordMessage == null) return '';
        return String(raw.noRecordMessage).trim();
    }
    const a = raw.noRecordLine1 != null ? String(raw.noRecordLine1).trim() : '';
    const b = raw.noRecordLine2 != null ? String(raw.noRecordLine2).trim() : '';
    const leg = [a, b].filter(Boolean).join('\n');
    return leg || null;
}

/** @param {unknown} v @param {'all'|'staging'|'production'} fallback */
function pickScenarioApplyTo(v, fallback) {
    if (v === 'staging' || v === 'production' || v === 'all' || v === 'off') return v;
    return fallback;
}

/** @typedef {{ message: string|null, stagingFrequency: 'off'|'once_per_day'|'every_session', productionFrequency: 'off'|'once_per_day'|'every_session' }} UnifiedScenarioRow */
/** @typedef {{ noRecord: UnifiedScenarioRow, noStreak: UnifiedScenarioRow, streakOne: UnifiedScenarioRow, streakTwoOrMore: UnifiedScenarioRow }} AttendancePopupUnified */

/** @returns {AttendancePopupUnified} 문구 공통, 노출 빈도만 스테이징/운영 분리 */
function attendancePopupDefaults() {
    const row = () => ({
        message: /** @type {string|null} */ (null),
        /** 설정 미로드·타임아웃 시 — every_session이면 접속마다 노출되어 운영 빈도와 불일치가 나기 쉬움 */
        stagingFrequency: /** @type {'once_per_day'} */ ('once_per_day'),
        productionFrequency: /** @type {'once_per_day'} */ ('once_per_day')
    });
    return {
        noRecord: { ...row(), message: null },
        noStreak: row(),
        streakOne: row(),
        streakTwoOrMore: row()
    };
}

/**
 * @param {UnifiedScenarioRow} row
 * @param {string} env getMealogClientEnv()
 */
function pickFrequencyForEnv(row, env) {
    if (!row) return 'off';
    return env === 'staging'
        ? pickFrequencyWithOff(row.stagingFrequency, 'once_per_day')
        : pickFrequencyWithOff(row.productionFrequency, 'once_per_day');
}

/**
 * @param {UnifiedScenarioRow} row
 * @param {string} env
 * @returns {{ frequency: string, message: string|null }}
 */
function scenarioForClient(row, env) {
    return {
        frequency: pickFrequencyForEnv(row, env),
        message: row?.message ?? null
    };
}

/**
 * Firestore/레거시에서 잘못된 문자열이면 알 수 없음(null) — 과거 기본이 every_session 이어서
 * 운영에서 '하루 1회'로 저장해도 접속마다 노출되는 문제가 있었음. 폴백은 once_per_day 권장.
 * @param {unknown} v
 * @returns {'off'|'once_per_day'|'every_session'|null}
 */
function normalizeWelcomeFreqToken(v) {
    if (v === 'off' || v === 'once_per_day' || v === 'every_session') return v;
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (s === 'off') return 'off';
    /** 콘텐츠 팝업 등 레거시 */
    if (s === 'once_per_day' || s === 'daily') return 'once_per_day';
    if (s === 'every_session') return 'every_session';
    return null;
}

/** @param {unknown} v @returns {'once_per_day'|'every_session'} */
function pickAttendanceShowFrequency(v) {
    const n = normalizeWelcomeFreqToken(v);
    if (n === 'once_per_day' || n === 'every_session') return n;
    return 'once_per_day';
}

/** @param {unknown} v @param {'off'|'once_per_day'|'every_session'} fallback */
function pickFrequencyWithOff(v, fallback = 'once_per_day') {
    const n = normalizeWelcomeFreqToken(v);
    if (n != null) return n;
    return fallback;
}

/** 문구 공통 + staging/production 빈도 분리 저장 형식(4행 중 하나라도 있으면 통합으로 처리) */
function isAttendancePopupUnified(raw) {
    if (!raw || typeof raw !== 'object') return false;
    const keys = ['noRecord', 'noStreak', 'streakOne', 'streakTwoOrMore'];
    return keys.some((k) => {
        if (!Object.prototype.hasOwnProperty.call(raw, k)) return false;
        const row = raw[k];
        if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
        return (
            Object.prototype.hasOwnProperty.call(row, 'stagingFrequency') ||
            Object.prototype.hasOwnProperty.call(row, 'productionFrequency') ||
            Object.prototype.hasOwnProperty.call(row, 'message')
        );
    });
}

/** 구형: staging / production 각각에 frequency·message */
function isAttendancePopupNestedV3(raw) {
    return (
        raw.staging &&
        typeof raw.staging === 'object' &&
        typeof raw.staging.noRecord === 'object' &&
        raw.staging.noRecord != null &&
        'frequency' in raw.staging.noRecord
    );
}

/**
 * @param {{ staging: Record<string, unknown>, production: Record<string, unknown> }} nested
 * @returns {AttendancePopupUnified}
 */
function nestedV3ToUnified(nested) {
    const keys = ['noRecord', 'noStreak', 'streakOne', 'streakTwoOrMore'];
    /** @type {AttendancePopupUnified} */
    const out = {
        noRecord: { message: null, stagingFrequency: 'once_per_day', productionFrequency: 'once_per_day' },
        noStreak: { message: null, stagingFrequency: 'once_per_day', productionFrequency: 'once_per_day' },
        streakOne: { message: null, stagingFrequency: 'once_per_day', productionFrequency: 'once_per_day' },
        streakTwoOrMore: { message: null, stagingFrequency: 'once_per_day', productionFrequency: 'once_per_day' }
    };
    for (const k of keys) {
        const st = nested.staging?.[k];
        const pr = nested.production?.[k];
        const msgSt = st?.message;
        const msgPr = pr?.message;
        let message = null;
        if (msgSt != null && String(msgSt).trim() !== '') message = String(msgSt);
        else if (msgPr != null && String(msgPr).trim() !== '') message = String(msgPr);
        else message = null;
        out[k] = {
            message,
            stagingFrequency: pickFrequencyWithOff(st?.frequency, 'once_per_day'),
            productionFrequency: pickFrequencyWithOff(pr?.frequency, 'once_per_day')
        };
    }
    return out;
}

/**
 * 구 v2: noRecord + hasRecord 만 있는 형식
 * @param {Record<string, unknown>} raw
 */
function isAttendancePopupLegacyBinary(raw) {
    if (!raw.staging || typeof raw.staging !== 'object' || !raw.production || typeof raw.production !== 'object') {
        return false;
    }
    const st = raw.staging;
    if (st.noStreak) return false;
    return (
        typeof st.noRecord === 'object' &&
        st.noRecord != null &&
        typeof st.hasRecord === 'object' &&
        st.hasRecord != null &&
        typeof raw.production.noRecord === 'object' &&
        typeof raw.production.hasRecord === 'object'
    );
}

/**
 * @param {{ frequency: string, message: string|null }} def
 * @param {unknown} inc
 */
function mergeNestedScenarioRow(def, inc) {
    const incOb = inc && typeof inc === 'object' ? inc : {};
    return {
        frequency: pickFrequencyWithOff(incOb.frequency, def.frequency),
        message: Object.prototype.hasOwnProperty.call(incOb, 'message')
            ? incOb.message == null
                ? null
                : String(incOb.message)
            : def.message
    };
}

/**
 * @param {UnifiedScenarioRow} def
 * @param {unknown} inc
 * @returns {UnifiedScenarioRow}
 */
function mergeUnifiedScenarioRow(def, inc) {
    const incOb = inc && typeof inc === 'object' ? inc : {};
    return {
        message: Object.prototype.hasOwnProperty.call(incOb, 'message')
            ? incOb.message == null
                ? null
                : String(incOb.message)
            : def.message,
        stagingFrequency: pickFrequencyWithOff(incOb.stagingFrequency, def.stagingFrequency),
        productionFrequency: pickFrequencyWithOff(incOb.productionFrequency, def.productionFrequency)
    };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ staging: object, production: object }}
 */
function mergeNestedV3AttendancePopup(raw) {
    const d = attendancePopupDefaults();
    const emptyNested = () => ({
        noRecord: { frequency: 'once_per_day', message: null },
        noStreak: { frequency: 'once_per_day', message: null },
        streakOne: { frequency: 'once_per_day', message: null },
        streakTwoOrMore: { frequency: 'once_per_day', message: null }
    });
    const stDef = emptyNested();
    const prDef = emptyNested();
    /** @param {typeof stDef} defEnv @param {Record<string, unknown>} incEnv */
    const mergeEnv = (defEnv, incEnv) => ({
        noRecord: mergeNestedScenarioRow(defEnv.noRecord, incEnv?.noRecord),
        noStreak: mergeNestedScenarioRow(defEnv.noStreak, incEnv?.noStreak),
        streakOne: mergeNestedScenarioRow(defEnv.streakOne, incEnv?.streakOne),
        streakTwoOrMore: mergeNestedScenarioRow(defEnv.streakTwoOrMore, incEnv?.streakTwoOrMore)
    });
    return {
        staging: mergeEnv(stDef, raw.staging && typeof raw.staging === 'object' ? raw.staging : {}),
        production: mergeEnv(prDef, raw.production && typeof raw.production === 'object' ? raw.production : {})
    };
}

/**
 * @param {Record<string, unknown>} raw
 */
function mergeUnifiedAttendancePopup(raw) {
    const d = attendancePopupDefaults();
    return {
        noRecord: mergeUnifiedScenarioRow(d.noRecord, raw.noRecord),
        noStreak: mergeUnifiedScenarioRow(d.noStreak, raw.noStreak),
        streakOne: mergeUnifiedScenarioRow(d.streakOne, raw.streakOne),
        streakTwoOrMore: mergeUnifiedScenarioRow(d.streakTwoOrMore, raw.streakTwoOrMore)
    };
}

/**
 * @param {{ noRecord: { frequency: string, message: string|null }, hasRecord: { frequency: string, message: string } }} env
 */
function upgradeLegacyBinaryEnvToV3(env) {
    const fq = pickFrequencyWithOff(env.hasRecord?.frequency, 'once_per_day');
    const msg = String(env.hasRecord?.message ?? '').trim();
    return {
        noRecord: env.noRecord,
        noStreak: { frequency: fq, message: null },
        streakOne: { frequency: fq, message: null },
        streakTwoOrMore: { frequency: fq, message: msg || null }
    };
}

/**
 * @param {Record<string, unknown>} raw
 */
function mergeLegacyBinaryAttendancePopup(raw) {
    const emptyPair = () => ({
        noRecord: { frequency: 'once_per_day', message: null },
        hasRecord: { frequency: 'once_per_day', message: '' }
    });
    /** @param {ReturnType<typeof emptyPair>} defEnv @param {Record<string, unknown>} incEnv */
    const mergeEnv = (defEnv, incEnv) => ({
        noRecord: mergeNestedScenarioRow(defEnv.noRecord, incEnv?.noRecord),
        hasRecord: {
            frequency: pickFrequencyWithOff(incEnv?.hasRecord?.frequency, 'once_per_day'),
            message:
                incEnv?.hasRecord && Object.prototype.hasOwnProperty.call(incEnv.hasRecord, 'message')
                    ? String(incEnv.hasRecord.message ?? '')
                    : ''
        }
    });
    const pairStaging = mergeEnv(emptyPair(), raw.staging && typeof raw.staging === 'object' ? raw.staging : {});
    const pairProd = mergeEnv(emptyPair(), raw.production && typeof raw.production === 'object' ? raw.production : {});
    return {
        staging: upgradeLegacyBinaryEnvToV3(pairStaging),
        production: upgradeLegacyBinaryEnvToV3(pairProd)
    };
}

/**
 * 구 flat 한 덩어리 → 통합 블록 (끔 = frequency off)
 * @param {{
 *   noRecordApplyTo: 'all'|'staging'|'production'|'off',
 *   hasRecordApplyTo: 'all'|'staging'|'production'|'off',
 *   noRecordMessage: string|null,
 *   hasRecordMessage: string,
 *   noRecordFrequency: 'once_per_day'|'every_session',
 *   hasRecordFrequency: 'once_per_day'|'every_session'
 * }} f
 * @returns {AttendancePopupUnified}
 */
function flatAttendanceToUnified(f) {
    const fn = pickAttendanceShowFrequency(f.noRecordFrequency);
    const fh = pickAttendanceShowFrequency(f.hasRecordFrequency);
    const noStagingOff = f.noRecordApplyTo === 'production' || f.noRecordApplyTo === 'off';
    const noProdOff = f.noRecordApplyTo === 'staging' || f.noRecordApplyTo === 'off';
    const hasStagingOff = f.hasRecordApplyTo === 'production' || f.hasRecordApplyTo === 'off';
    const hasProdOff = f.hasRecordApplyTo === 'staging' || f.hasRecordApplyTo === 'off';
    const hMsg = f.hasRecordMessage != null ? String(f.hasRecordMessage) : '';
    return {
        noRecord: {
            message: f.noRecordMessage,
            stagingFrequency: noStagingOff ? 'off' : fn,
            productionFrequency: noProdOff ? 'off' : fn
        },
        noStreak: {
            message: null,
            stagingFrequency: hasStagingOff ? 'off' : fh,
            productionFrequency: hasProdOff ? 'off' : fh
        },
        streakOne: {
            message: null,
            stagingFrequency: hasStagingOff ? 'off' : fh,
            productionFrequency: hasProdOff ? 'off' : fh
        },
        streakTwoOrMore: {
            message: hMsg || null,
            stagingFrequency: hasStagingOff ? 'off' : fh,
            productionFrequency: hasProdOff ? 'off' : fh
        }
    };
}

/**
 * adminSettings/config.attendancePopup — v3(4케이스) + 구 v2·flat·레거시 호환
 */
export function normalizeAttendancePopup(raw) {
    if (!raw || typeof raw !== 'object') return attendancePopupDefaults();
    if (isAttendancePopupUnified(raw)) return mergeUnifiedAttendancePopup(raw);
    if (isAttendancePopupNestedV3(raw)) return nestedV3ToUnified(mergeNestedV3AttendancePopup(raw));
    if (isAttendancePopupLegacyBinary(raw)) return nestedV3ToUnified(mergeLegacyBinaryAttendancePopup(raw));

    const hasLegacy =
        (raw.staging != null && typeof raw.staging === 'object') ||
        (raw.production != null && typeof raw.production === 'object');

    const hasFlat =
        'noRecordMessage' in raw ||
        'noRecordLine1' in raw ||
        'noRecordLine2' in raw ||
        'streakLine2' in raw ||
        'hasRecordMessage' in raw ||
        'enabled' in raw ||
        'noRecordFrequency' in raw ||
        'hasRecordFrequency' in raw;

    const hasPerScenario =
        Object.prototype.hasOwnProperty.call(raw, 'noRecordApplyTo') ||
        Object.prototype.hasOwnProperty.call(raw, 'hasRecordApplyTo');

    let legacyMasterOff = false;
    /** @type {'all'|'staging'|'production'} */
    let legacyApply = 'all';
    let noRecordMessage = pickNoRecordMessage(raw);
    let hasRecordMessage =
        raw.hasRecordMessage != null
            ? String(raw.hasRecordMessage)
            : raw.streakLine2 != null
              ? String(raw.streakLine2)
              : '';

    if (hasLegacy) {
        const st = raw.staging && typeof raw.staging === 'object' ? raw.staging : {};
        const pr = raw.production && typeof raw.production === 'object' ? raw.production : {};
        const stOn = st.enabled !== false;
        const prOn = pr.enabled !== false;
        if (stOn && prOn) legacyApply = 'all';
        else if (stOn && !prOn) legacyApply = 'staging';
        else if (!stOn && prOn) legacyApply = 'production';
        else legacyApply = 'all';
        legacyMasterOff = !(stOn || prOn);
        const pick = (k) => {
            const a = st[k];
            const b = pr[k];
            if (a != null && String(a).trim() !== '') return a;
            if (b != null && String(b).trim() !== '') return b;
            return null;
        };
        const s2 = pick('streakLine2');
        const n1 = pick('noRecordLine1');
        const n2 = pick('noRecordLine2');
        const n1s = n1 != null ? String(n1).trim() : '';
        const n2s = n2 != null ? String(n2).trim() : '';
        noRecordMessage = [n1s, n2s].filter(Boolean).join('\n') || null;
        hasRecordMessage = s2 != null ? String(s2) : '';
    } else if (
        hasPerScenario ||
        hasFlat ||
        raw.applyTo === 'staging' ||
        raw.applyTo === 'production' ||
        raw.applyTo === 'all'
    ) {
        if (raw.applyTo === 'staging' || raw.applyTo === 'production' || raw.applyTo === 'all') {
            legacyApply = raw.applyTo;
        }
        legacyMasterOff = raw.enabled === false;
        noRecordMessage = pickNoRecordMessage(raw);
        hasRecordMessage =
            raw.hasRecordMessage != null
                ? String(raw.hasRecordMessage)
                : raw.streakLine2 != null
                  ? String(raw.streakLine2)
                  : '';
    } else {
        return attendancePopupDefaults();
    }

    let noRecordApplyTo = pickScenarioApplyTo(raw.noRecordApplyTo, legacyApply);
    let hasRecordApplyTo = pickScenarioApplyTo(raw.hasRecordApplyTo, legacyApply);

    if (legacyMasterOff && !hasPerScenario) {
        noRecordApplyTo = 'off';
        hasRecordApplyTo = 'off';
    }

    return flatAttendanceToUnified({
        noRecordApplyTo,
        hasRecordApplyTo,
        noRecordMessage,
        hasRecordMessage,
        noRecordFrequency: pickAttendanceShowFrequency(raw.noRecordFrequency),
        hasRecordFrequency: pickAttendanceShowFrequency(raw.hasRecordFrequency)
    });
}

async function fetchAttendancePopupRoot() {
    if (!attendancePopupConfigPromise) {
        attendancePopupConfigPromise = (async () => {
            try {
                await appCheckInitPromise;
                await refreshAppCheckTokenBeforeFirestore();
                const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
                const snap = await getDoc(configRef);
                const ap =
                    snap.exists() && snap.data().attendancePopup && typeof snap.data().attendancePopup === 'object'
                        ? snap.data().attendancePopup
                        : {};
                const normalized = normalizeAttendancePopup(ap);
                lastResolvedAttendancePopupConfig = normalized;
                return normalized;
            } catch {
                const normalized = normalizeAttendancePopup({});
                lastResolvedAttendancePopupConfig = normalized;
                return normalized;
            }
        })();
    }
    try {
        return await attendancePopupConfigPromise;
    } finally {
        attendancePopupConfigPromise = null;
    }
}

/** App Check·네트워크 지연 시 getDoc 무한 대기로 _attendancePopupResolutionPending이 고착되는 것 방지 */
async function fetchAttendancePopupRootWithTimeout() {
    const ms = 12000;
    return await Promise.race([
        fetchAttendancePopupRoot(),
        new Promise((resolve) =>
            setTimeout(() => {
                resolve(lastResolvedAttendancePopupConfig || attendancePopupDefaults());
            }, ms)
        )
    ]);
}

export function resetAttendanceCheckSessionForTesting() {
    lastAttendanceUid = null;
    welcomePopupLocalDay = null;
}

/**
 * 데이터 리스너 onDataUpdate 등에서 호출.
 * 조건 충족 시 짧게 디바운스 후 팝업 (노출 빈도는 관리자 설정).
 */
export function scheduleAttendanceCheckIfNeeded() {
    if (typeof window === 'undefined') return;
    if (window._serviceGuideActive) return;
    const guide = document.getElementById('serviceGuideOverlay');
    if (guide && !guide.classList.contains('hidden')) return;
    const user = window.currentUser;
    if (!user?.uid || user.isAnonymous) return;
    if (isDemoUser(user)) return;
    if (!isMainScreenVisibleForWelcome()) return;

    resetWelcomePopupGateIfNewLocalDay();

    if (user.uid !== lastAttendanceUid) {
        lastAttendanceUid = user.uid;
    }

    if (attendanceDebounceTimer) clearTimeout(attendanceDebounceTimer);
    attendanceDebounceTimer = setTimeout(() => {
        attendanceDebounceTimer = null;
        void (async () => {
            if (!window.currentUser || window.currentUser.uid !== user.uid || window.currentUser.isAnonymous) return;
            if (!isMainScreenVisibleForWelcome()) return;
            if (isDemoUser(window.currentUser)) return;

            /** 콘텐츠 팝업이 이 플래그로 대기함 — 디바운스 전에 켜면 getDoc 지연 시 영구 대기하므로 조회 직전에만 설정 */
            window._attendancePopupResolutionPending = true;
            try {
                const cfg = await fetchAttendancePopupRootWithTimeout();
                const env = getMealogClientEnv();
                const uid = user.uid;

                const dates = collectRecordedDateSet();

                if (dates.size === 0) {
                    const sub = scenarioForClient(cfg.noRecord, env);
                    if (!sub || sub.frequency === 'off') return;
                    if (!passesWelcomeFrequency(uid, 'no', sub.frequency)) return;
                    if (!shouldShowWelcomeNow()) return;
                    const noRecRaw = sub.message != null ? String(sub.message).trim() : '';
                    const noRecordBody =
                        noRecRaw || `${DEFAULT_NO_RECORD_L1}\n${DEFAULT_NO_RECORD_L2}`;
                    if (showAttendancePopup(noRecordBody, '', 'noRecord')) {
                        markWelcomeForFrequency(uid, 'no', sub.frequency);
                    }
                    return;
                }
                const streak = computeTrackerStreakDisplayDays();
                /** @type {{ row: UnifiedScenarioRow, slot: 'noStreak'|'streakOne'|'streakTwoOrMore', welcomeIcon: 'hasRecordRestart'|'hasRecord', markKind: 'ns'|'s1'|'s2p' }} */
                let picked;
                if (streak <= 0) {
                    picked = {
                        row: cfg.noStreak,
                        slot: 'noStreak',
                        welcomeIcon: 'hasRecordRestart',
                        markKind: 'ns'
                    };
                } else if (streak === 1) {
                    picked = {
                        row: cfg.streakOne,
                        slot: 'streakOne',
                        welcomeIcon: 'hasRecord',
                        markKind: 's1'
                    };
                } else {
                    picked = {
                        row: cfg.streakTwoOrMore,
                        slot: 'streakTwoOrMore',
                        welcomeIcon: 'hasRecord',
                        markKind: 's2p'
                    };
                }
                const sub = scenarioForClient(picked.row, env);
                if (!sub || sub.frequency === 'off') return;
                if (!passesWelcomeFrequency(uid, picked.markKind, sub.frequency)) return;
                if (!shouldShowWelcomeNow()) return;
                const streakHead = resolveHasRecordHeadline(sub, picked.slot, streak);
                const welcomePrepared = await prepareWelcomeReportState(uid);
                if (!window.currentUser || window.currentUser.uid !== uid || window.currentUser.isAnonymous) return;
                if (!isMainScreenVisibleForWelcome()) return;
                if (!shouldShowWelcomeNow()) return;
                if (showAttendancePopup(streakHead, '', picked.welcomeIcon, welcomePrepared)) {
                    markWelcomeForFrequency(uid, picked.markKind, sub.frequency);
                }
            } finally {
                window._attendancePopupResolutionPending = false;
                const ap = document.getElementById('attendancePopup');
                if (!ap || ap.classList.contains('hidden')) {
                    try {
                        if (typeof window.flushPendingContentPopup === 'function') window.flushPendingContentPopup();
                    } catch (_) {
                        /* ignore */
                    }
                }
            }
        })();
    }, 180);
}
