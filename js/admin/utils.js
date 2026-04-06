// ADMIN 공통 유틸리티 함수들
import { db, appId } from '../firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

/** sharedPhotos 문서를 게시물(포스트) 단위로 그룹하기 위한 키 (listeners.js와 동일 로직) */
export function getSharedPhotoGroupKey(data) {
    if (data.type === 'daily') return `daily_${data.date || 'no-date'}_${data.userId}`;
    if (data.type === 'best') return `best_${data.id || 'no-id'}_${data.userId}`;
    if (data.type === 'insight') return `insight_${data.dateRangeText || 'no-range'}_${data.userId}`;
    if (data.entryId) return `${data.entryId}_${data.userId}`;
    return `no-entry_${data.userId}`;
}

/** 로컬 날짜(자정 기준) → YYYY-MM-DD */
export function dateKeyFromLocalDate(d) {
    if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 금일 포함 7일치 날짜 키 (과거→오늘 순) */
export function getLast7DateKeys(todayStart) {
    const keys = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayStart);
        d.setDate(d.getDate() - i);
        keys.push(dateKeyFromLocalDate(d));
    }
    return keys;
}

/** 오늘 날짜 문자열 (YYYY-MM-DD) */
export function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 로컬 기준 해당 주의 일요일 00:00 */
export function startOfSundayWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = x.getDay();
    x.setDate(x.getDate() - dow);
    x.setHours(0, 0, 0, 0);
    return x;
}

/** 로컬 날짜 M/D (연도 생략) */
function formatMonthDayLocal(d) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 해당 월 안에서 몇 번째 일요일인지(1부터) + 일~토 구간 → "2주(3/2~3/8)"
 * @param {Date} sun - 그 주의 일요일(로컬)
 */
export function weekLabelKoreanFromSunday(sun) {
    const y = sun.getFullYear();
    const m = sun.getMonth();
    const daySun = sun.getDate();
    let n = 0;
    for (let day = 1; day <= daySun; day++) {
        if (new Date(y, m, day).getDay() === 0) n++;
    }
    const sat = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate() + 6);
    // 대시보드 주간 컬럼: 주차와 날짜 구간을 줄바꿈으로 구분 (th에 whitespace-pre-line)
    return `${n}주\n${formatMonthDayLocal(sun)}~${formatMonthDayLocal(sat)}`;
}

/**
 * from~to(포함)가 속한 일요일 시작 주들을 과거→현재 순으로 나열
 * @param {Date} fromDate
 * @param {Date} toDate
 */
export function enumerateSundayWeeksInclusive(fromDate, toDate) {
    const start = startOfSundayWeek(fromDate);
    const end = startOfSundayWeek(toDate);
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 7 * 86400000) {
        const sun = new Date(t);
        sun.setHours(0, 0, 0, 0);
        out.push({
            sundayKey: dateKeyFromLocalDate(sun),
            label: weekLabelKoreanFromSunday(sun),
            year: sun.getFullYear(),
            monthIndex: sun.getMonth()
        });
    }
    return out;
}

/** YYYY-MM-DD가 속한 주의 일요일 키 → weeks[].sundayKey와 동일 형식 */
export function sundayKeyForDateKey(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const p = dateStr.split('-');
    if (p.length !== 3) return null;
    const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    if (Number.isNaN(d.getTime())) return null;
    return dateKeyFromLocalDate(startOfSundayWeek(d));
}

// ADMIN 권한 확인
export async function checkAdminStatus(userId) {
    if (!userId) {
        console.log('❌ ADMIN 체크: userId가 없습니다.');
        return false;
    }
    
    try {
        const adminDocRef = doc(db, 'artifacts', appId, 'admins', userId);
        console.log('🔍 ADMIN 체크 중:', {
            userId: userId,
            path: `artifacts/${appId}/admins/${userId}`
        });
        
        const adminDoc = await getDoc(adminDocRef);
        
        if (!adminDoc.exists()) {
            console.log('❌ ADMIN 문서가 존재하지 않습니다:', userId);
            console.log('💡 Firebase 콘솔에서 확인하세요: artifacts/mealog-r0/admins/{사용자UID}');
            return false;
        }
        
        const adminData = adminDoc.data();
        console.log('📄 ADMIN 문서 데이터:', adminData);
        
        const isAdmin = adminData.isAdmin === true;
        if (!isAdmin) {
            console.log('❌ isAdmin 필드가 true가 아닙니다:', adminData.isAdmin);
        } else {
            console.log('✅ ADMIN 권한 확인됨!');
        }
        
        return isAdmin;
    } catch (e) {
        console.error("❌ ADMIN 체크 오류:", e);
        const code = e?.code || '';
        // 일시적 네트워크/백엔드 오류는 '권한 없음'으로 처리하면 로그아웃되어 혼란스러움 → 호출부에서 재시도 유도
        if (
            code === 'unavailable' ||
            code === 'deadline-exceeded' ||
            code === 'resource-exhausted' ||
            code === 'aborted'
        ) {
            const err = new Error(
                '관리자 권한을 확인할 수 없습니다. 네트워크·방화벽을 확인한 뒤 잠시 후 다시 시도해 주세요.'
            );
            err.code = 'admin-check-network';
            err.isNetwork = true;
            throw err;
        }
        return false;
    }
}

/**
 * 관리자 화면용: uid별 이메일 (users 문서 → config/settings, users.js와 동일)
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string>>}
 */
export async function fetchAdminEmailsForUserIds(userIds) {
    const unique = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const map = new Map();
    await Promise.all(
        unique.map(async (uid) => {
            let email = '';
            try {
                const userSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid));
                if (userSnap.exists()) {
                    const e = userSnap.data()?.email;
                    if (e && String(e).trim()) email = String(e).trim();
                }
                const settingsSnap = await getDoc(doc(db, 'artifacts', appId, 'users', uid, 'config', 'settings'));
                if (settingsSnap.exists()) {
                    const se = settingsSnap.data()?.email;
                    if (se && String(se).trim()) email = String(se).trim();
                }
            } catch (_) {
                /* ignore */
            }
            map.set(uid, email);
        })
    );
    return map;
}

// HTML 이스케이프 헬퍼 함수
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 관리자 화면 새로고침 버튼: 조회 중 스피너·배경색·비활성화 후 복구
 * @param {HTMLElement|string|null} button — 요소 또는 id
 * @param {() => Promise<void>} work
 * @param {{ loadingText?: string, tightSpinner?: boolean }} [options]
 */
export async function runAdminRefreshAction(button, work, options = {}) {
    const loadingText = options.loadingText || '조회 중…';
    const spinClass = options.tightSpinner ? 'mr-1' : 'mr-2';
    const el = typeof button === 'string' ? document.getElementById(button) : button;
    if (!el) {
        await work();
        return;
    }
    if (el.getAttribute('aria-busy') === 'true') return;
    el.dataset.arPrevHtml = el.innerHTML;
    el.dataset.arPrevClass = el.className;
    el.dataset.arPrevStyle = el.getAttribute('style') || '';
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = `<i class="fa-solid fa-spinner fa-spin ${spinClass}" aria-hidden="true"></i><span>${loadingText}</span>`;
    el.style.backgroundColor = '#475569';
    el.style.color = '#fff';
    el.style.borderColor = 'transparent';
    el.style.cursor = 'wait';
    try {
        await work();
    } finally {
        el.innerHTML = el.dataset.arPrevHtml;
        el.className = el.dataset.arPrevClass;
        const ps = el.dataset.arPrevStyle;
        if (ps) el.setAttribute('style', ps);
        else el.removeAttribute('style');
        delete el.dataset.arPrevHtml;
        delete el.dataset.arPrevClass;
        delete el.dataset.arPrevStyle;
        el.removeAttribute('aria-busy');
        el.disabled = false;
    }
}
