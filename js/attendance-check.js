/**
 * 출석/연속 기록 팝업 — 기록된 일자(dailyStats ∪ mealHistory) 기준 연속 일수 계산.
 * 테스트: 브라우저 세션(탭)당 1회 표시. 추후 localStorage + 당일 1회로 전환 가능.
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

/** 가장 최근 기록일부터 달력 역순으로 이어진 연속 일수 */
export function computeConsecutiveStreakDays(dateSet) {
    if (!dateSet || dateSet.size === 0) return 0;
    const sorted = [...dateSet].sort();
    const end = sorted[sorted.length - 1];
    let streak = 0;
    let cursor = end;
    while (dateSet.has(cursor)) {
        streak++;
        cursor = prevLocalYmd(cursor);
    }
    return streak;
}

let lastAttendanceUid = null;
let attendanceShownForUidSession = false;
let attendanceDebounceTimer = null;

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

function attendancePopupDefaults() {
    return {
        noRecordApplyTo: /** @type {'all'} */ ('all'),
        hasRecordApplyTo: /** @type {'all'} */ ('all'),
        noRecordMessage: /** @type {string|null} */ (null),
        hasRecordMessage: ''
    };
}

/**
 * adminSettings/config.attendancePopup — 구버전(단일 applyTo·streakLine2·enabled) + 신규(기록 유무별 적용·끔) 호환
 * @returns {{ noRecordApplyTo: 'all'|'staging'|'production'|'off', hasRecordApplyTo: 'all'|'staging'|'production'|'off', noRecordMessage: string|null, hasRecordMessage: string }}
 */
export function normalizeAttendancePopup(raw) {
    if (!raw || typeof raw !== 'object') return attendancePopupDefaults();

    const hasLegacy =
        (raw.staging != null && typeof raw.staging === 'object') ||
        (raw.production != null && typeof raw.production === 'object');

    const hasFlat =
        'noRecordMessage' in raw ||
        'noRecordLine1' in raw ||
        'noRecordLine2' in raw ||
        'streakLine2' in raw ||
        'hasRecordMessage' in raw ||
        'enabled' in raw;

    const hasPerScenario =
        Object.prototype.hasOwnProperty.call(raw, 'noRecordApplyTo') ||
        Object.prototype.hasOwnProperty.call(raw, 'hasRecordApplyTo');

    /** 구버전 상위 스위치(off)만 있는 경우 → 아래에서 양쪽 끔으로 승격 */
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

    return {
        noRecordApplyTo,
        hasRecordApplyTo,
        noRecordMessage,
        hasRecordMessage
    };
}

/** @param {'all'|'staging'|'production'|'off'} mode @param {'staging'|'production'} env */
function envMatchesScenario(mode, env) {
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    if (mode === 'staging') return env === 'staging';
    if (mode === 'production') return env === 'production';
    return true;
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
}

/**
 * 데이터 리스너 onDataUpdate 등에서 호출.
 * 조건 충족 시 짧게 디바운스 후 1회만 팝업 (같은 로그인 세션·같은 uid 기준).
 */
export function scheduleAttendanceCheckIfNeeded() {
    if (typeof window === 'undefined') return;
    const user = window.currentUser;
    if (!user?.uid || user.isAnonymous) return;
    if (isDemoUser(user)) return;
    if (!authFlowManager.hasCompleted) return;
    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) return;

    if (user.uid !== lastAttendanceUid) {
        lastAttendanceUid = user.uid;
        attendanceShownForUidSession = false;
    }
    if (attendanceShownForUidSession) return;

    if (attendanceDebounceTimer) clearTimeout(attendanceDebounceTimer);
    attendanceDebounceTimer = setTimeout(() => {
        attendanceDebounceTimer = null;
        void (async () => {
            if (attendanceShownForUidSession) return;
            if (!window.currentUser || window.currentUser.uid !== user.uid || window.currentUser.isAnonymous) return;
            if (!authFlowManager.hasCompleted) return;
            const mainEl = document.getElementById('mainApp');
            if (!mainEl || mainEl.classList.contains('hidden')) return;
            if (isDemoUser(window.currentUser)) return;

            const cfg = await fetchAttendancePopupRoot();
            const env = getMealogClientEnv();

            const dates = collectRecordedDateSet();
            const noRecRaw = cfg.noRecordMessage != null ? String(cfg.noRecordMessage).trim() : '';
            const noRecordBody =
                noRecRaw || `${DEFAULT_NO_RECORD_L1}\n${DEFAULT_NO_RECORD_L2}`;
            const streakExtra = String(cfg.hasRecordMessage ?? '').trim();

            if (dates.size === 0) {
                if (!envMatchesScenario(cfg.noRecordApplyTo, env)) return;
                attendanceShownForUidSession = true;
                showAttendancePopup(noRecordBody);
                return;
            }
            if (!envMatchesScenario(cfg.hasRecordApplyTo, env)) return;
            attendanceShownForUidSession = true;
            const streak = computeConsecutiveStreakDays(dates);
            const streakHead = `${streak}일 연속 기록!!`;
            showAttendancePopup(
                streakExtra ? `${streakHead}\n${streakExtra}` : streakHead
            );
        })();
    }, 450);
}
