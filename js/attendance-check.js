/**
 * 출석/연속 기록 팝업 — 기록된 일자(dailyStats ∪ mealHistory) 기준 연속 일수 계산.
 * 테스트: 브라우저 세션(탭)당 1회 표시. 추후 localStorage + 당일 1회로 전환 가능.
 * 관리자 설정(adminSettings/config.attendancePopup)으로 환경별 문구·노출 on/off.
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
 * adminSettings/config.attendancePopup — 구버전(staging/production 분리)과 신규(단일 문구 + applyTo) 호환
 * @returns {{ enabled: boolean, applyTo: 'all'|'staging'|'production', noRecordLine1: string|null, noRecordLine2: string|null, streakLine2: string }}
 */
export function normalizeAttendancePopup(raw) {
    const defaults = () => ({
        enabled: true,
        applyTo: /** @type {'all'} */ ('all'),
        noRecordLine1: null,
        noRecordLine2: null,
        streakLine2: ''
    });
    if (!raw || typeof raw !== 'object') return defaults();

    if (raw.applyTo === 'staging' || raw.applyTo === 'production' || raw.applyTo === 'all') {
        return {
            enabled: raw.enabled !== false,
            applyTo: raw.applyTo,
            noRecordLine1: raw.noRecordLine1 != null ? raw.noRecordLine1 : null,
            noRecordLine2: raw.noRecordLine2 != null ? raw.noRecordLine2 : null,
            streakLine2: raw.streakLine2 != null ? String(raw.streakLine2) : ''
        };
    }

    const hasLegacy =
        (raw.staging != null && typeof raw.staging === 'object') ||
        (raw.production != null && typeof raw.production === 'object');
    if (hasLegacy) {
        const st = raw.staging && typeof raw.staging === 'object' ? raw.staging : {};
        const pr = raw.production && typeof raw.production === 'object' ? raw.production : {};
        const stOn = st.enabled !== false;
        const prOn = pr.enabled !== false;
        let applyTo = /** @type {'all'|'staging'|'production'} */ ('all');
        if (stOn && prOn) applyTo = 'all';
        else if (stOn && !prOn) applyTo = 'staging';
        else if (!stOn && prOn) applyTo = 'production';
        else applyTo = 'all';
        const enabled = stOn || prOn;
        const pick = (k) => {
            const a = st[k];
            const b = pr[k];
            if (a != null && String(a).trim() !== '') return a;
            if (b != null && String(b).trim() !== '') return b;
            return null;
        };
        const s2 = pick('streakLine2');
        return {
            enabled,
            applyTo,
            noRecordLine1: pick('noRecordLine1'),
            noRecordLine2: pick('noRecordLine2'),
            streakLine2: s2 != null ? String(s2) : ''
        };
    }

    const hasFlat =
        'noRecordLine1' in raw || 'noRecordLine2' in raw || 'streakLine2' in raw || 'enabled' in raw;
    if (hasFlat) {
        return {
            enabled: raw.enabled !== false,
            applyTo: 'all',
            noRecordLine1: raw.noRecordLine1 != null ? raw.noRecordLine1 : null,
            noRecordLine2: raw.noRecordLine2 != null ? raw.noRecordLine2 : null,
            streakLine2: raw.streakLine2 != null ? String(raw.streakLine2) : ''
        };
    }

    return defaults();
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
            if (cfg.enabled === false) return;
            if (cfg.applyTo === 'staging' && env !== 'staging') return;
            if (cfg.applyTo === 'production' && env !== 'production') return;

            attendanceShownForUidSession = true;
            const dates = collectRecordedDateSet();
            const l1Empty = String(cfg.noRecordLine1 ?? '').trim() || DEFAULT_NO_RECORD_L1;
            const l2Empty = String(cfg.noRecordLine2 ?? '').trim() || DEFAULT_NO_RECORD_L2;
            const streakL2 = String(cfg.streakLine2 ?? '').trim();

            if (dates.size === 0) {
                showAttendancePopup(l1Empty, l2Empty);
                return;
            }
            const streak = computeConsecutiveStreakDays(dates);
            showAttendancePopup(`${streak}일 연속 기록!!`, streakL2);
        })();
    }, 450);
}
