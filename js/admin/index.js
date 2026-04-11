// ADMIN 관리자 페이지 메인 진입점
// 모든 모듈을 통합하고 window 객체에 노출하여 기존 HTML 호환성 유지

// 공통 유틸리티
export * from './utils.js';

// 대시보드
export * from './dashboard.js';

// 사용자 관리
export * from './users.js';

// 인증
export * from './auth.js';

// 공지(알림) 관리
export * from './notices.js';

// 브로드캐스트 푸시 / 팝업
export * from './push-broadcast.js';
export * from './popups.js';

export * from './login-banner.js';
export * from './tags.js';

// window 객체에 노출 (기존 HTML 호환성 유지)
import { 
    updateStatistics, 
    refreshDashboardStats, 
    renderSharedPhotos 
} from './dashboard.js';

import {
    renderUsers,
    switchAdminUsersPage,
    switchAdminUsersListPage,
    processDeleteUserRequests,
    adminUserDeleteSelected,
    adminUserBanShare,
    adminUserBanWrite,
    refreshUsers
} from './users.js';

import {
    handleAdminLogin,
    handleAdminLogout
} from './auth.js';

import { db, appId } from '../firebase.js';
import { doc, deleteDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// 공유 게시물 삭제 관련
let currentDeletePhotoId = null;

// window 객체에 모든 함수 노출
window.handleAdminLogin = handleAdminLogin;
window.handleAdminLogout = handleAdminLogout;
// switchAdminTab은 admin.js에서 정의
window.refreshDashboardStats = refreshDashboardStats;
window.refreshSharedPhotos = async function() {
    await renderSharedPhotos();
    await updateStatistics();
};

window.openDeleteModal = function(photoId) {
    currentDeletePhotoId = photoId;
    document.getElementById('deleteModal').classList.remove('hidden');
};

window.closeDeleteModal = function() {
    currentDeletePhotoId = null;
    document.getElementById('deleteModal').classList.add('hidden');
};

window.confirmDeletePhoto = async function() {
    if (!currentDeletePhotoId) return;
    
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>삭제 중...';
    
    try {
        await deleteDoc(doc(db, 'artifacts', appId, 'sharedPhotos', currentDeletePhotoId));
        window.closeDeleteModal();
        await renderSharedPhotos();
        await updateStatistics();
        
        // 성공 메시지
        const successDiv = document.createElement('div');
        successDiv.className = 'fixed top-4 right-4 bg-emerald-600 text-white px-6 py-3 rounded-xl shadow-lg z-[600] flex items-center gap-2';
        successDiv.innerHTML = '<i class="fa-solid fa-check"></i> <span>게시물이 삭제되었습니다.</span>';
        document.body.appendChild(successDiv);
        setTimeout(() => successDiv.remove(), 3000);
        
    } catch (e) {
        console.error("게시물 삭제 실패:", e);
        alert("삭제 중 오류가 발생했습니다: " + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '삭제';
    }
};

// 사용자 관리 함수들
window.switchAdminUsersPage = switchAdminUsersPage;
window.switchAdminUsersListPage = switchAdminUsersListPage;
window.processDeleteUserRequests = processDeleteUserRequests;
window.adminUserDeleteSelected = adminUserDeleteSelected;
window.adminUserBanShare = adminUserBanShare;
window.adminUserBanWrite = adminUserBanWrite;
window.refreshUsers = refreshUsers;

// 나머지 함수들은 기존 admin.js에서 임포트하여 노출
// (콘텐츠 관리, 게시판, 피드 등은 아직 모듈화되지 않았으므로 기존 admin.js에서 로드)

console.log('✅ admin/index.js 로드 완료');
