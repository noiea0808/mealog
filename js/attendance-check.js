/**
 * 출석/연속 기록 팝업 — 어제(로컬)까지 이어진 연속 일수(dailyStats ∪ mealHistory). 어제 무기록이면 0.
 * 노출 빈도: 관리자 설정 noRecordFrequency / hasRecordFrequency — 접속 시마다(세션당 1회) 또는 하루 한 번(localStorage).
 * 관리자 설정(adminSettings/config.attendancePopup)으로 기록 유무·환경별 문구·노출(끔 포함).
 */
import { authFlowManager } from './auth-flow.js';
import { isDemoUser } from './demo-account.js';
import { db, appId } from './firebase.js';
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

/** @param {number} streak */
function formatAttendanceStreakHeadline(streak) {
    if (streak <= 0) return '0일 연속 기록중!!';
    if (streak === 1) return '2일 연속 기록 도전중!!';
    if (streak === 2) return '2일 연속 기록 중!';
    return `${streak}일 연속 기록 중!`;
}

let lastAttendanceUid = null;
let attendanceShownForUidSession = false;
/** 로컬 날짜가 바뀌면 세션 노출 플래그를 리셋(장시간 열린 탭에서도 자정 이후 재노출 가능) */
let welcomePopupLocalDay = null;
let attendanceDebounceTimer = null;

const WELCOME_DAY_LS_PREFIX = 'mealog_welcome_shown_';

/** @param {'no'|'has'} kind */
function welcomeDayStorageKey(uid, kind) {
    return `${WELCOME_DAY_LS_PREFIX}${uid}_${kind}`;
}

/** @param {'no'|'has'} kind */
function wasWelcomeShownToday(uid, kind) {
    const today = toLocalDateString(new Date());
    try {
        return localStorage.getItem(welcomeDayStorageKey(uid, kind)) === today;
    } catch {
        return false;
    }
}

/** @param {'no'|'has'} kind */
function markWelcomeShownToday(uid, kind) {
    const today = toLocalDateString(new Date());
    try {
        localStorage.setItem(welcomeDayStorageKey(uid, kind), today);
    } catch {
        /* ignore */
    }
}

function resetWelcomePopupGateIfNewLocalDay() {
    const t = toLocalDateString(new Date());
    if (welcomePopupLocalDay !== t) {
        welcomePopupLocalDay = t;
        attendanceShownForUidSession = false;
    }
}

/** @type {Record<string, unknown> | null} */
let cachedAttendancePopupRoot = null;
let attendancePopupConfigPromise = null;

export function invalidateAttendancePopupConfigCache() {
    cachedAttendancePopupRoot = null;
    attendancePopupConfigPromise = null;
}

const DEFAULT_NO_RECORD_L1 = '우리 오늘부터';
const DEFAULT_NO_RECORD_L2 = '시작하는거죠?!';

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

/** @returns {{ staging: EnvAttendanceBlock, production: EnvAttendanceBlock }} */
function attendancePopupDefaults() {
    const block = () => ({
        noRecord: {
            frequency: /** @type {'every_session'} */ ('every_session'),
            message: /** @type {string|null} */ (null)
        },
        hasRecord: {
            frequency: /** @type {'every_session'} */ ('every_session'),
            message: ''
        }
    });
    return {
        staging: block(),
        production: block()
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

/**
 * 스테이징/운영 × 기록 유무 4블록 형식인지
 * @param {Record<string, unknown>} raw
 */
function isAttendancePopupV2(raw) {
    if (!raw.staging || typeof raw.staging !== 'object' || !raw.production || typeof raw.production !== 'object') {
        return false;
    }
    const st = raw.staging;
    const pr = raw.production;
    return (
        typeof st.noRecord === 'object' &&
        st.noRecord != null &&
        typeof st.hasRecord === 'object' &&
        st.hasRecord != null &&
        typeof pr.noRecord === 'object' &&
        pr.noRecord != null &&
        typeof pr.hasRecord === 'object' &&
        pr.hasRecord != null
    );
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ staging: EnvAttendanceBlock, production: EnvAttendanceBlock }}
 */
function mergeV2AttendancePopup(raw) {
    const d = attendancePopupDefaults();
    /** @param {typeof d.staging} defEnv @param {Record<string, unknown>} incEnv */
    const mergeEnv = (defEnv, incEnv) => ({
        noRecord: {
            frequency: pickFrequencyWithOff(incEnv?.noRecord?.frequency, defEnv.noRecord.frequency),
            message:
                incEnv?.noRecord && Object.prototype.hasOwnProperty.call(incEnv.noRecord, 'message')
                    ? incEnv.noRecord.message == null
                        ? null
                        : String(incEnv.noRecord.message)
                    : defEnv.noRecord.message
        },
        hasRecord: {
            frequency: pickFrequencyWithOff(incEnv?.hasRecord?.frequency, defEnv.hasRecord.frequency),
            message:
                incEnv?.hasRecord && Object.prototype.hasOwnProperty.call(incEnv.hasRecord, 'message')
                    ? String(incEnv.hasRecord.message ?? '')
                    : defEnv.hasRecord.message
        }
    });
    return {
        staging: mergeEnv(d.staging, raw.staging && typeof raw.staging === 'object' ? raw.staging : {}),
        production: mergeEnv(d.production, raw.production && typeof raw.production === 'object' ? raw.production : {})
    };
}

/**
 * 구 flat 한 덩어리 → 스테이징/운영별 블록 (끔 = frequency off)
 * @param {{
 *   noRecordApplyTo: 'all'|'staging'|'production'|'off',
 *   hasRecordApplyTo: 'all'|'staging'|'production'|'off',
 *   noRecordMessage: string|null,
 *   hasRecordMessage: string,
 *   noRecordFrequency: 'once_per_day'|'every_session',
 *   hasRecordFrequency: 'once_per_day'|'every_session'
 * }} f
 */
function flatAttendanceToNested(f) {
    const fn = pickAttendanceShowFrequency(f.noRecordFrequency);
    const fh = pickAttendanceShowFrequency(f.hasRecordFrequency);
    const noStagingOff = f.noRecordApplyTo === 'production' || f.noRecordApplyTo === 'off';
    const noProdOff = f.noRecordApplyTo === 'staging' || f.noRecordApplyTo === 'off';
    const hasStagingOff = f.hasRecordApplyTo === 'production' || f.hasRecordApplyTo === 'off';
    const hasProdOff = f.hasRecordApplyTo === 'staging' || f.hasRecordApplyTo === 'off';
    return {
        staging: {
            noRecord: { frequency: noStagingOff ? 'off' : fn, message: f.noRecordMessage },
            hasRecord: { frequency: hasStagingOff ? 'off' : fh, message: f.hasRecordMessage ?? '' }
        },
        production: {
            noRecord: { frequency: noProdOff ? 'off' : fn, message: f.noRecordMessage },
            hasRecord: { frequency: hasProdOff ? 'off' : fh, message: f.hasRecordMessage ?? '' }
        }
    };
}

/**
 * adminSettings/config.attendancePopup — v2(스테이징·운영 × 기록 유무) + 구 flat·레거시 호환
 * @returns {{ staging: { noRecord: { frequency: 'off'|'once_per_day'|'every_session', message: string|null }, hasRecord: { frequency: 'off'|'once_per_day'|'every_session', message: string } }, production: same }}
 */
export function normalizeAttendancePopup(raw) {
    if (!raw || typeof raw !== 'object') return attendancePopupDefaults();
    if (isAttendancePopupV2(raw)) return mergeV2AttendancePopup(raw);

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

    return flatAttendanceToNested({
        noRecordApplyTo,
        hasRecordApplyTo,
        noRecordMessage,
        hasRecordMessage,
        noRecordFrequency: pickAttendanceShowFrequency(raw.noRecordFrequency),
        hasRecordFrequency: pickAttendanceShowFrequency(raw.hasRecordFrequency)
    });
}

async function fetchAttendancePopupRoot() {
    if (cachedAttendancePopupRoot !== null) return cachedAttendancePopupRoot;
    if (!attendancePopupConfigPromise) {
        attendancePopupConfigPromise = (async () => {
            try {
                const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
                const snap = await getDoc(configRef);
                const ap =
                    snap.exists() && snap.data().attendancePopup && typeof snap.data().attendancePopup === 'object'
                        ? snap.data().attendancePopup
                        : {};
                cachedAttendancePopupRoot = normalizeAttendancePopup(ap);
            } catch {
                cachedAttendancePopupRoot = normalizeAttendancePopup({});
            }
            return cachedAttendancePopupRoot;
        })();
    }
    return attendancePopupConfigPromise;
}

export function resetAttendanceCheckSessionForTesting() {
    lastAttendanceUid = null;
    attendanceShownForUidSession = false;
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
        attendanceShownForUidSession = false;
    }

    if (attendanceDebounceTimer) clearTimeout(attendanceDebounceTimer);
    attendanceDebounceTimer = setTimeout(() => {
        attendanceDebounceTimer = null;
        void (async () => {
            if (!window.currentUser || window.currentUser.uid !== user.uid || window.currentUser.isAnonymous) return;
            if (!authFlowManager.hasCompleted) return;
            const mainEl = document.getElementById('mainApp');
            if (!mainEl || mainEl.classList.contains('hidden')) return;
            if (isDemoUser(window.currentUser)) return;

            const cfg = await fetchAttendancePopupRoot();
            const env = getMealogClientEnv();
            const uid = user.uid;
            const envBlock = env === 'staging' ? cfg.staging : cfg.production;
            if (!envBlock) return;

            const dates = collectRecordedDateSet();

            if (dates.size === 0) {
                const sub = envBlock.noRecord;
                if (!sub || sub.frequency === 'off') return;
                const freqNo = sub.frequency;
                const noRecRaw = sub.message != null ? String(sub.message).trim() : '';
                const noRecordBody =
                    noRecRaw || `${DEFAULT_NO_RECORD_L1}\n${DEFAULT_NO_RECORD_L2}`;
                if (freqNo === 'once_per_day' && wasWelcomeShownToday(uid, 'no')) return;
                if (freqNo === 'every_session' && attendanceShownForUidSession) return;
                attendanceShownForUidSession = true;
                if (freqNo === 'once_per_day') markWelcomeShownToday(uid, 'no');
                showAttendancePopup(noRecordBody, '', 'noRecord');
                return;
            }
            const subHas = envBlock.hasRecord;
            if (!subHas || subHas.frequency === 'off') return;
            const freqHas = subHas.frequency;
            const streakExtra = String(subHas.message ?? '').trim();
            if (freqHas === 'once_per_day' && wasWelcomeShownToday(uid, 'has')) return;
            if (freqHas === 'every_session' && attendanceShownForUidSession) return;
            attendanceShownForUidSession = true;
            if (freqHas === 'once_per_day') markWelcomeShownToday(uid, 'has');
            const streak = computeConsecutiveStreakDays(dates);
            const streakHead = formatAttendanceStreakHeadline(streak);
            showAttendancePopup(streakHead, streakExtra, 'hasRecord');
        })();
    }, 450);
}
