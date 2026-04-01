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
