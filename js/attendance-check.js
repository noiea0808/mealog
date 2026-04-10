/**
 * 출석/연속 기록 팝업 — 어제(로컬)까지 이어진 연속 일수(dailyStats ∪ mealHistory). 어제 무기록이면 0.
 * 노출 빈도: 케이스별(기록 없음·연속 없음·1일·2일+) 관리자 설정 — 접속마다(sessionStorage) 또는 하루 1회(localStorage).
 * 관리자 설정(adminSettings/config.attendancePopup)으로 기록 유무·환경별 문구·노출(끔 포함).
 */
import { authFlowManager } from './auth-flow.js';
import { isDemoUser } from './demo-account.js';
import { appCheckInitPromise, db, appId, refreshAppCheckTokenBeforeFirestore } from './firebase.js';
import { showAttendancePopup } from './ui.js';
import { getMealogClientEnv, toLocalDateString } from './utils.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

function isValidYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * 트래커·타임라인과 동일: 해당 일에 실제 기록 건수 (dailyStats.count ∪ mealHistory)
 * dailyStats에 main/snack 키만 있고 count·실데이터가 없으면 0으로 본다 (빈 객체 오탐 방지).
 */
function getRecordCountForIso(iso) {
    const statsCount = (window.dailyStats && window.dailyStats[iso]?.count) ?? 0;
    const historyCount =
        window.mealHistory && Array.isArray(window.mealHistory)
            ? window.mealHistory.filter((m) => m.date === iso).length
            : 0;
    return Math.max(statsCount, historyCount);
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

function prevLocalYmd(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - 1);
    return toLocalDateString(dt);
}

/**
 * 오늘(로컬) 기준 **어제**까지 달력 역순으로 이어진 연속 기록 일수.
 * 어제에 기록이 없으면 0 (과거에만 기록이 있어도 연속 기록으로 보지 않음).
 */
export function computeConsecutiveStreakDays(dateSet) {
    if (!dateSet || dateSet.size === 0) return 0;
    const today = toLocalDateString(new Date());
    const yesterday = prevLocalYmd(today);
    if (!dateSet.has(yesterday)) return 0;
    let streak = 0;
    let cursor = yesterday;
    while (dateSet.has(cursor)) {
        streak++;
        cursor = prevLocalYmd(cursor);
    }
    return streak;
}

/**
 * 기록 완료 팝업 문구 — 해당 날짜 **첫** 신규 기록만 연속 메시지.
 * - 어제까지 연속 일수 n (`computeConsecutiveStreakDays`): n≥1 → `(n+1)일 연속 기록!`, n=0 → `기록 완료!`
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

    const n = computeConsecutiveStreakDays(collectRecordedDateSet());
    if (n <= 0) return '기록 완료!';
    return `${n + 1}일 연속 기록!`;
}

let lastAttendanceUid = null;
/** 로컬 날짜가 바뀌면 세션 노출 플래그를 리셋(장시간 열린 탭에서도 자정 이후 재노출 가능) */
let welcomePopupLocalDay = null;
let attendanceDebounceTimer = null;

const WELCOME_DAY_LS_PREFIX = 'mealog_welcome_shown_';
const WELCOME_SESS_PREFIX = 'mealog_welcome_sess_';

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
    return `${WELCOME_SESS_PREFIX}${uid}_${kind}`;
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
    if (frequency === 'once_per_day') return !wasWelcomeShownToday(uid, kind);
    if (frequency === 'every_session') return !wasWelcomeShownThisSession(uid, kind);
    return false;
}

/**
 * @param {'no'|'ns'|'s1'|'s2p'} kind
 * @param {'once_per_day'|'every_session'} frequency
 */
function markWelcomeForFrequency(uid, kind, frequency) {
    if (frequency === 'once_per_day') markWelcomeShownToday(uid, kind);
    else if (frequency === 'every_session') markWelcomeShownThisSession(uid, kind);
}

function resetWelcomePopupGateIfNewLocalDay() {
    const t = toLocalDateString(new Date());
    if (welcomePopupLocalDay !== t) {
        welcomePopupLocalDay = t;
    }
}

/** in-flight만 공유 — 완료 후 비워서 매번 최신 adminSettings 반영(관리자 저장 직후 다른 탭 앱도 다음 팝업 시도에서 재조회) */
let attendancePopupConfigPromise = null;

export function invalidateAttendancePopupConfigCache() {
    attendancePopupConfigPromise = null;
}

const DEFAULT_NO_RECORD_L1 = '우리 오늘부터';
const DEFAULT_NO_RECORD_L2 = '시작하는거죠?!';

const DEFAULT_HEADLINE_NO_STREAK = '밀로그하기 좋은 날!!';
const DEFAULT_HEADLINE_STREAK_ONE = '2일 연속 기록 도전중!!';
const DEFAULT_HEADLINE_STREAK_MULTI = '{streak}일 연속 기록 중!';

/**
 * @param {{ message?: string|null }} sub message만 사용(빈도는 호출부에서 이미 반영)
 * @param {'noStreak'|'streakOne'|'streakTwoOrMore'} slot
 * @param {number} streak 어제부터 이어진 연속 일수(2일 이상 문구용)
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
        stagingFrequency: /** @type {'every_session'} */ ('every_session'),
        productionFrequency: /** @type {'every_session'} */ ('every_session')
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
        ? pickFrequencyWithOff(row.stagingFrequency, 'every_session')
        : pickFrequencyWithOff(row.productionFrequency, 'every_session');
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

/** @param {unknown} v @returns {'once_per_day'|'every_session'} */
function pickAttendanceShowFrequency(v) {
    if (v === 'once_per_day' || v === 'every_session') return v;
    return 'every_session';
}

/** @param {unknown} v @param {'off'|'once_per_day'|'every_session'} fallback */
function pickFrequencyWithOff(v, fallback = 'every_session') {
    if (v === 'off' || v === 'once_per_day' || v === 'every_session') return v;
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
        noRecord: { message: null, stagingFrequency: 'every_session', productionFrequency: 'every_session' },
        noStreak: { message: null, stagingFrequency: 'every_session', productionFrequency: 'every_session' },
        streakOne: { message: null, stagingFrequency: 'every_session', productionFrequency: 'every_session' },
        streakTwoOrMore: { message: null, stagingFrequency: 'every_session', productionFrequency: 'every_session' }
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
            stagingFrequency: pickFrequencyWithOff(st?.frequency, 'every_session'),
            productionFrequency: pickFrequencyWithOff(pr?.frequency, 'every_session')
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
        noRecord: { frequency: 'every_session', message: null },
        noStreak: { frequency: 'every_session', message: null },
        streakOne: { frequency: 'every_session', message: null },
        streakTwoOrMore: { frequency: 'every_session', message: null }
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
    const fq = pickFrequencyWithOff(env.hasRecord?.frequency, 'every_session');
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
        noRecord: { frequency: 'every_session', message: null },
        hasRecord: { frequency: 'every_session', message: '' }
    });
    /** @param {ReturnType<typeof emptyPair>} defEnv @param {Record<string, unknown>} incEnv */
    const mergeEnv = (defEnv, incEnv) => ({
        noRecord: mergeNestedScenarioRow(defEnv.noRecord, incEnv?.noRecord),
        hasRecord: {
            frequency: pickFrequencyWithOff(incEnv?.hasRecord?.frequency, 'every_session'),
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
                return normalizeAttendancePopup(ap);
            } catch {
                return normalizeAttendancePopup({});
            }
        })();
    }
    try {
        return await attendancePopupConfigPromise;
    } finally {
        attendancePopupConfigPromise = null;
    }
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
    const user = window.currentUser;
    if (!user?.uid || user.isAnonymous) return;
    if (isDemoUser(user)) return;
    if (!authFlowManager.hasCompleted) return;
    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) return;

    resetWelcomePopupGateIfNewLocalDay();

    if (user.uid !== lastAttendanceUid) {
        lastAttendanceUid = user.uid;
    }

    if (attendanceDebounceTimer) clearTimeout(attendanceDebounceTimer);
    window._attendancePopupResolutionPending = true;
    attendanceDebounceTimer = setTimeout(() => {
        attendanceDebounceTimer = null;
        void (async () => {
            try {
                if (!window.currentUser || window.currentUser.uid !== user.uid || window.currentUser.isAnonymous) return;
                if (!authFlowManager.hasCompleted) return;
                const mainEl = document.getElementById('mainApp');
                if (!mainEl || mainEl.classList.contains('hidden')) return;
                if (isDemoUser(window.currentUser)) return;

                const cfg = await fetchAttendancePopupRoot();
                const env = getMealogClientEnv();
                const uid = user.uid;

                const dates = collectRecordedDateSet();

                if (dates.size === 0) {
                    const sub = scenarioForClient(cfg.noRecord, env);
                    if (!sub || sub.frequency === 'off') return;
                    if (!passesWelcomeFrequency(uid, 'no', sub.frequency)) return;
                    const noRecRaw = sub.message != null ? String(sub.message).trim() : '';
                    const noRecordBody =
                        noRecRaw || `${DEFAULT_NO_RECORD_L1}\n${DEFAULT_NO_RECORD_L2}`;
                    markWelcomeForFrequency(uid, 'no', sub.frequency);
                    showAttendancePopup(noRecordBody, '', 'noRecord');
                    return;
                }
                const streak = computeConsecutiveStreakDays(dates);
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
                const streakHead = resolveHasRecordHeadline(sub, picked.slot, streak);
                markWelcomeForFrequency(uid, picked.markKind, sub.frequency);
                showAttendancePopup(streakHead, '', picked.welcomeIcon);
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
    }, 450);
}
