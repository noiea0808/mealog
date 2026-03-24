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
        return false;
    }
}

// HTML 이스케이프 헬퍼 함수
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
