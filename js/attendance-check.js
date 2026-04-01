/**
 * 출석/연속 기록 팝업 — 기록된 일자(dailyStats ∪ mealHistory) 기준 연속 일수 계산.
 * 테스트: 브라우저 세션(탭)당 1회 표시. 추후 localStorage + 당일 1회로 전환 가능.
 */
import { authFlowManager } from './auth-flow.js';
import { showAttendancePopup } from './ui.js';
import { toLocalDateString } from './utils.js';

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
        if (attendanceShownForUidSession) return;
        if (!window.currentUser || window.currentUser.uid !== user.uid || window.currentUser.isAnonymous) return;
        if (!authFlowManager.hasCompleted) return;
        const mainEl = document.getElementById('mainApp');
        if (!mainEl || mainEl.classList.contains('hidden')) return;

        attendanceShownForUidSession = true;
        const dates = collectRecordedDateSet();
        if (dates.size === 0) {
            showAttendancePopup('우리 오늘부터', '시작하는거죠?!');
            return;
        }
        const streak = computeConsecutiveStreakDays(dates);
        showAttendancePopup(`${streak}일 연속 기록!!`, '');
    }, 450);
}
