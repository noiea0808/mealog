// ADMIN 관리자 페이지 관련 함수들
// 리팩토링: 모듈화된 부분은 admin/ 디렉토리에서 import
import { 
    getSharedPhotoGroupKey, 
    dateKeyFromLocalDate, 
    getLast7DateKeys, 
    getTodayDateString,
    checkAdminStatus,
    escapeHtml
} from './admin/utils.js';
import {
    getUserStatistics,
    getSharedPhotos,
    renderDashboardStats,
    updateStatistics,
    refreshDashboardStats,
    renderSharedPhotos,
    switchDashboardSubtab
} from './admin/dashboard.js';
import {
    switchAdminUsersPage,
    switchAdminUsersListPage,
    ensureAdminUsersSortHandlers,
    processDeleteUserRequests,
    adminUserDeleteSelected,
    adminUserBanShare,
    adminUserBanWrite,
    refreshUsers
} from './admin/users.js';
import { switchAdminUsersSubmenu, refreshAdminUserAnalytics } from './admin/user-analytics.js';
import {
    handleAdminLogin,
    handleAdminLogout
} from './admin/auth.js';
import { renderNotices, renderNoticeImagePreviews } from './admin/notices.js';
import { loadAdminPushMessagesPage } from './admin/push-broadcast.js';
import { renderPopups, renderPopupImagePreviews } from './admin/popups.js';
import { loadLoginBannerConfig } from './admin/login-banner.js';
import { loadTagsContent } from './admin/tags.js';
import { registerRestaurantStats } from './admin/restaurant-stats.js';
import { loadMealogComments, showCharacterListView } from './admin/persona.js';
import { runAdminStatsBackfillForUid } from './admin/stats-backfill.js';
import { loadAdminLogTab } from './admin/ops-log.js';
import { bindAdminWelcomeApiOnce } from './admin/welcome-api.js';
import { invalidateAttendancePopupConfigCache, normalizeAttendancePopup } from './attendance-check.js';
// 모니터링(모먼트·밀톡·게시판): HTML onclick용 window.* 등록
import './admin/feed-moderation.js';
import './admin/lounge-chat-moderation.js';
import './admin/board-moderation.js';

import { app, db, appId, callableFunctions, auth } from './firebase.js';
import { GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

// Firestore 규칙·Callable은 기본 Auth만 인식 — 메인 앱과 동일한 `auth` 인스턴스 사용
import { collection, collectionGroup, getDocs, query, orderBy, limit, startAfter, doc, deleteDoc, getDoc, setDoc, where, writeBatch, addDoc, serverTimestamp, getCountFromServer, Timestamp, deleteField } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { uploadImageToStorage, uploadPersonaImageToStorage, uploadNoticeImages, uploadPopupImages, uploadLoginBannerImage } from './utils.js';
import { invalidateAdminDisplayNameCache } from './db.js';
import { getCurrentTermsVersion, invalidateTermsVersionCache } from './utils-terms.js';
import { sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly } from './render/utils.js';

let currentDeletePhotoId = null;

// 중복 함수 제거됨 - admin/dashboard.js, admin/users.js, admin/utils.js에서 import
// 기존 함수들은 모듈화되어 제거되었습니다.

registerRestaurantStats();

// 아래는 아직 모듈화되지 않은 부분들입니다.

// window 객체에 import한 함수들 노출
window.handleAdminLogin = handleAdminLogin;
window.handleAdminLogout = handleAdminLogout;

// 운영 적용일(로컬 자정 기준)부터 오늘까지 경과 일수
const ADMIN_OPS_START = new Date(2026, 2, 8); // 2026-03-08

function getAdminOpsElapsedDays() {
    const today = new Date();
    const d0 = new Date(ADMIN_OPS_START.getFullYear(), ADMIN_OPS_START.getMonth(), ADMIN_OPS_START.getDate());
    const d1 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.round((d1 - d0) / 86400000));
}

function updateAdminOpsSubtitle() {
    const el = document.getElementById('adminOpsElapsedDays');
    if (el) el.textContent = `오늘 기준 경과 ${getAdminOpsElapsedDays()}일`;
}

// 관리자 페이지 표시 (내부 함수)
function showAdminPage(user) {
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    const loadingOverlay = document.getElementById('loadingOverlay');
    
    if (loginPage) loginPage.classList.add('hidden');
    if (adminPage) adminPage.classList.remove('hidden');
    updateAdminOpsSubtitle();
    
    // 로딩 오버레이 숨기기
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    
    // 데이터 로드
    updateStatistics();
    renderSharedPhotos();
    switchAdminTab('dashboard');
}

function resetAdminScrollTop() {
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
}

// 어드민 탭 전환 (기존 코드 유지 - switchAdminTab은 import했지만 내부 구현은 여기서)
window.switchAdminTab = function(tab) {
    // 모든 탭 버튼 비활성화
    document.querySelectorAll('.admin-tab').forEach(btn => {
        btn.classList.remove('active', 'text-emerald-600', 'border-b-2', 'border-emerald-600');
        btn.classList.add('text-slate-500');
    });
    
    // 모든 탭 컨텐츠 숨기기
    document.querySelectorAll('.admin-tab-content').forEach(content => {
        content.classList.add('hidden');
    });
    
    // 선택한 탭 활성화
    const activeTabBtn = document.getElementById(`admin-tab-${tab}`);
    const activeTabContent = document.getElementById(`admin-tab-content-${tab}`);
    
    if (activeTabBtn) {
        activeTabBtn.classList.add('active', 'text-emerald-600', 'border-b-2', 'border-emerald-600');
        activeTabBtn.classList.remove('text-slate-500');
    }
    
    if (activeTabContent) {
        activeTabContent.classList.remove('hidden');
    }
    resetAdminScrollTop();
    
    // 탭별 데이터 새로고침
    if (tab === 'dashboard') {
        updateStatistics();
    } else if (tab === 'monitoring') {
        switchMonitoringSidebar('feed'); // UI만 전환 — 목록은 각 화면의 새로고침으로 로드
        loadAdminSettings(); // 공지·댓글 표시 이름 캐시 로드
    } else if (tab === 'persona') {
        // 페르소나 탭은 더 이상 사용하지 않음
    } else if (tab === 'users') {
        ensureAdminUsersSortHandlers();
        /* 사용자 목록은 새로고침 버튼으로만 로드 */
    } else if (tab === 'alerts') {
        switchAlertsSidebar('pushMessage');
    } else if (tab === 'content') {
        switchContentSidebar('mealog'); // 콘텐츠 탭 첫 메뉴(MEALOG)
    } else if (tab === 'adminLog') {
        loadAdminLogTab();
    }
}

// handleAdminLogout은 이미 import되어 window에 노출됨

// 대시보드 통계 새로고침 (전체 집계 후 캐시 문서에 저장)
window.refreshDashboardStats = refreshDashboardStats;
window.switchDashboardSubtab = switchDashboardSubtab;

// 공유 게시물 새로고침
window.refreshSharedPhotos = async function() {
    await renderSharedPhotos();
    await updateStatistics();
};

// 사용자 관리 함수들 window에 노출
window.switchAdminUsersPage = switchAdminUsersPage;
window.switchAdminUsersListPage = switchAdminUsersListPage;
window.processDeleteUserRequests = processDeleteUserRequests;
window.adminUserDeleteSelected = adminUserDeleteSelected;
window.adminUserBanShare = adminUserBanShare;
window.adminUserBanWrite = adminUserBanWrite;
window.refreshUsers = refreshUsers;
window.runAdminStatsBackfillForUid = runAdminStatsBackfillForUid;
window.switchAdminUsersSubmenu = switchAdminUsersSubmenu;
window.refreshAdminUserAnalytics = refreshAdminUserAnalytics;

// 삭제 모달 열기
window.openDeleteModal = function(photoId) {
    currentDeletePhotoId = photoId;
    document.getElementById('deleteModal').classList.remove('hidden');
};

// 삭제 모달 닫기
window.closeDeleteModal = function() {
    currentDeletePhotoId = null;
    document.getElementById('deleteModal').classList.add('hidden');
};

// 게시물 삭제 확인
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

// 인증 상태 변경 리스너
onAuthStateChanged(auth, async (user) => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    const loginError = document.getElementById('loginError');
    
    try {
        if (user) {
            let isAdmin;
            try {
                isAdmin = await checkAdminStatus(user.uid);
            } catch (e) {
                if (e?.code === 'admin-check-network' || e?.isNetwork) {
                    if (adminPage) adminPage.classList.add('hidden');
                    if (loginPage) loginPage.classList.remove('hidden');
                    if (loginError) {
                        loginError.textContent = e.message || '관리자 확인에 실패했습니다. 잠시 후 다시 시도해 주세요.';
                        loginError.classList.remove('hidden');
                    }
                    return;
                }
                throw e;
            }
            if (isAdmin) {
                if (loginPage) loginPage.classList.add('hidden');
                if (adminPage) adminPage.classList.remove('hidden');
                showAdminPage(user);
            } else {
                // ADMIN 권한 없음 - 로그인 페이지 표시
                if (adminPage) adminPage.classList.add('hidden');
                if (loginPage) loginPage.classList.remove('hidden');
                // 이미 로그인되어 있으면 로그아웃
                try {
                    await signOut(auth);
                } catch (e) {
                    console.error("로그아웃 실패:", e);
                }
            }
        } else {
            // 로그인 안됨 - 로그인 페이지 표시
            if (adminPage) adminPage.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    } catch (e) {
        console.error("인증 상태 확인 오류:", e);
        if (adminPage) adminPage.classList.add('hidden');
        if (loginPage) loginPage.classList.remove('hidden');
    } finally {
        // 로딩 오버레이 숨기기
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
});

// 페이지 로드 시 초기화
function initAdminPage() {
    console.log('🔧 initAdminPage 실행');
    // 초기 상태 설정 - 로그인 페이지 표시, 로딩 오버레이 숨김
    const loadingOverlay = document.getElementById('loadingOverlay');
    const loginPage = document.getElementById('loginPage');
    const adminPage = document.getElementById('adminPage');
    
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    if (loginPage) loginPage.classList.remove('hidden');
    if (adminPage) adminPage.classList.add('hidden');
    
    // 로그인 버튼 이벤트 리스너
    const loginBtn = document.getElementById('loginBtn');
    console.log('🔧 loginBtn 찾기:', loginBtn);
    if (loginBtn) {
        loginBtn.addEventListener('click', (e) => {
            console.log('🔧 로그인 버튼 클릭됨');
            e.preventDefault();
            if (window.handleAdminLogin) {
                window.handleAdminLogin();
            } else {
                console.error('❌ window.handleAdminLogin이 정의되지 않음');
            }
        });
        console.log('✅ 로그인 버튼 이벤트 리스너 등록됨');
    } else {
        console.error('❌ loginBtn을 찾을 수 없음');
    }
    
    // 공지 내용 포맷 툴바 (Bold, 취소선, 밑줄)
    document.querySelectorAll('.notice-format-toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const contentEl = document.getElementById('noticeContent');
            if (!contentEl) return;
            contentEl.focus();
            const cmd = btn.getAttribute('data-format');
            if (cmd) document.execCommand(cmd, false, null);
        });
    });
    const noticeAddPhotosBtn = document.getElementById('noticeAddPhotosBtn');
    const noticeImagesInput = document.getElementById('noticeImages');
    if (noticeAddPhotosBtn && noticeImagesInput) {
        noticeAddPhotosBtn.addEventListener('click', () => noticeImagesInput.click());
    }
    if (noticeImagesInput) {
        noticeImagesInput.addEventListener('change', (e) => {
            const existing = (window.noticeExistingUrls || []).length;
            const filesCount = (window.noticeFiles || []).length;
            const total = existing + filesCount;
            const canAdd = Math.max(0, 3 - total);
            const files = Array.from(e.target.files || []).slice(0, canAdd);
            if (files.length === 0) {
                if ((e.target.files || []).length > canAdd && canAdd === 0) alert('사진은 최대 3장까지 추가할 수 있습니다.');
                e.target.value = '';
                return;
            }
            if (!window.noticeFiles) window.noticeFiles = [];
            if (!window.noticeObjectUrls) window.noticeObjectUrls = [];
            files.forEach(f => {
                if (!f.type.startsWith('image/')) return;
                window.noticeFiles.push(f);
                window.noticeObjectUrls.push(URL.createObjectURL(f));
            });
            renderNoticeImagePreviews();
            e.target.value = '';
        });
    }
    const noticeContentEl = document.getElementById('noticeContent');
    if (noticeContentEl) {
        const syncPlaceholder = () => {
            const isEmpty = !(noticeContentEl.innerText || '').trim();
            noticeContentEl.classList.toggle('format-editor-empty', isEmpty);
        };
        noticeContentEl.addEventListener('input', syncPlaceholder);
        noticeContentEl.addEventListener('blur', syncPlaceholder);
        noticeContentEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
        });
    }
    
    // 팝업 내용 포맷 툴바 및 사진 추가
    document.querySelectorAll('.popup-format-toolbar-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const contentEl = document.getElementById('popupContent');
            if (!contentEl) return;
            contentEl.focus();
            const cmd = btn.getAttribute('data-format');
            if (cmd) document.execCommand(cmd, false, null);
        });
    });
    const popupAddPhotosBtn = document.getElementById('popupAddPhotosBtn');
    const popupImagesInput = document.getElementById('popupImages');
    if (popupAddPhotosBtn && popupImagesInput) {
        popupAddPhotosBtn.addEventListener('click', () => popupImagesInput.click());
    }
    if (popupImagesInput) {
        popupImagesInput.addEventListener('change', (e) => {
            const existing = (window.popupExistingUrls || []).length;
            const filesCount = (window.popupFiles || []).length;
            const total = existing + filesCount;
            const canAdd = Math.max(0, 3 - total);
            const files = Array.from(e.target.files || []).slice(0, canAdd);
            if (files.length === 0) {
                if ((e.target.files || []).length > canAdd && canAdd === 0) alert('사진은 최대 3장까지 추가할 수 있습니다.');
                e.target.value = '';
                return;
            }
            if (!window.popupFiles) window.popupFiles = [];
            if (!window.popupObjectUrls) window.popupObjectUrls = [];
            files.forEach(f => {
                if (!f.type.startsWith('image/')) return;
                window.popupFiles.push(f);
                window.popupObjectUrls.push(URL.createObjectURL(f));
            });
            renderPopupImagePreviews();
            e.target.value = '';
        });
    }
    const popupContentEl = document.getElementById('popupContent');
    if (popupContentEl) {
        const syncPlaceholder = () => {
            const isEmpty = !(popupContentEl.innerText || '').trim();
            popupContentEl.classList.toggle('format-editor-empty', isEmpty);
        };
        popupContentEl.addEventListener('input', syncPlaceholder);
        popupContentEl.addEventListener('blur', syncPlaceholder);
        popupContentEl.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain') || '';
            document.execCommand('insertText', false, text);
        });
    }
    
    // 로그인 배너 UI
    const loginBannerImageBtn = document.getElementById('loginBannerImageBtn');
    const loginBannerImageInput = document.getElementById('loginBannerImageInput');
    const loginBannerImageRemoveBtn = document.getElementById('loginBannerImageRemoveBtn');
    const loginBannerSaveBtn = document.getElementById('loginBannerSaveBtn');
    if (loginBannerImageBtn && loginBannerImageInput) {
        loginBannerImageBtn.addEventListener('click', () => loginBannerImageInput.click());
    }
    if (loginBannerImageInput) {
        loginBannerImageInput.addEventListener('change', (e) => {
            const file = (e.target.files && e.target.files[0]) ? e.target.files[0] : null;
            window.loginBannerFile = file && file.type.startsWith('image/') ? file : null;
            window.loginBannerRemoveImage = false;
            const labelEl = document.getElementById('loginBannerImageLabel');
            const previewEl = document.getElementById('loginBannerImagePreview');
            if (labelEl) labelEl.textContent = window.loginBannerFile ? file.name : '선택된 이미지 없음';
            if (previewEl) {
                previewEl.innerHTML = '';
                if (window.loginBannerFile) {
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(window.loginBannerFile);
                    img.alt = '미리보기';
                    img.className = 'max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-24';
                    previewEl.appendChild(img);
                }
            }
            e.target.value = '';
        });
    }
    if (loginBannerImageRemoveBtn) {
        loginBannerImageRemoveBtn.addEventListener('click', () => {
            window.loginBannerFile = null;
            window.loginBannerRemoveImage = true;
            const labelEl = document.getElementById('loginBannerImageLabel');
            const previewEl = document.getElementById('loginBannerImagePreview');
            if (labelEl) labelEl.textContent = '선택된 이미지 없음 (저장 시 이미지 제거됨)';
            if (previewEl) previewEl.innerHTML = '';
            const inputEl = document.getElementById('loginBannerImageInput');
            if (inputEl) inputEl.value = '';
        });
    }
    if (loginBannerSaveBtn) {
        loginBannerSaveBtn.addEventListener('click', () => window.saveLoginBanner());
    }
    const loginBannerLandingNoticeBtn = document.getElementById('loginBannerLandingNoticeBtn');
    const loginBannerLandingClearBtn = document.getElementById('loginBannerLandingClearBtn');
    const loginBannerLandingNoticeModalClose = document.getElementById('loginBannerLandingNoticeModalClose');
    if (loginBannerLandingNoticeBtn) {
        loginBannerLandingNoticeBtn.addEventListener('click', () => window.openLoginBannerLandingNoticeSelect());
    }
    if (loginBannerLandingClearBtn) {
        loginBannerLandingClearBtn.addEventListener('click', () => {
            const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
            const landingLabelEl = document.getElementById('loginBannerLandingLabel');
            const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
            const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
            if (landingIdEl) landingIdEl.value = '';
            if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
            if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
            if (landingSelectedTitle) landingSelectedTitle.textContent = '';
            window.loginBannerLandingNoticeTitle = '';
        });
    }
    if (loginBannerLandingNoticeModalClose) {
        loginBannerLandingNoticeModalClose.addEventListener('click', () => window.closeLoginBannerLandingNoticeSelect());
    }

    // Enter 키로 로그인
    const passwordInput = document.getElementById('adminPassword');
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (window.handleAdminLogin) {
                    window.handleAdminLogin();
                }
            }
        });
    }
    
    // 일정 시간 후에도 로딩이 계속되면 숨기기 (안전장치)
    setTimeout(() => {
        const loadingOverlay = document.getElementById('loadingOverlay');
        const loginPage = document.getElementById('loginPage');
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            console.warn("로딩 타임아웃 - 로딩 오버레이 강제로 숨김");
            loadingOverlay.classList.add('hidden');
            if (loginPage) loginPage.classList.remove('hidden');
        }
    }, 5000);
}

// DOM 준비 상태 확인 후 초기화
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initAdminPage);
} else {
    // DOM이 이미 준비되었으면 즉시 실행
    setTimeout(initAdminPage, 0); // 다음 이벤트 루프에서 실행
}

// 모니터링 사이드바 전환
window.switchMonitoringSidebar = function(section) {
    // 모든 서브탭 버튼 비활성화
    document.querySelectorAll('[id^="monitoring-sidebar-"]').forEach(btn => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        btn.classList.add('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    });
    
    // 모든 메인 섹션 숨기기
    document.querySelectorAll('.monitoring-main-section').forEach(sec => {
        sec.classList.add('hidden');
    });
    
    // 선택한 서브탭 버튼 활성화
    const activeSidebarBtn = document.getElementById(`monitoring-sidebar-${section}`);
    const activeMainSection = document.getElementById(`monitoring-main-${section}`);
    
    if (activeSidebarBtn) {
        activeSidebarBtn.classList.add('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        activeSidebarBtn.classList.remove('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    }
    
    if (activeMainSection) {
        activeMainSection.classList.remove('hidden');
    }
    resetAdminScrollTop();
    /* 데이터는 각 섹션의「새로고침」버튼에서만 로드 (탭/서브메뉴 진입 시 Firestore 조회 없음) */
};

// 콘텐츠 관리 관련 함수들

const ALERTS_SIDEBAR_SECTIONS = ['pushMessage', 'notice', 'popup', 'loginBanner'];

/** 알림 탭 사이드바 (공지·푸시·팝업·로그인 배너) */
window.switchAlertsSidebar = function (section) {
    if (!ALERTS_SIDEBAR_SECTIONS.includes(section)) return;
    document.querySelectorAll('[id^="alerts-sidebar-"]').forEach(btn => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        btn.classList.add('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    });
    document.querySelectorAll('.content-main-section').forEach(sec => {
        sec.classList.add('hidden');
    });
    const activeSidebarBtn = document.getElementById(`alerts-sidebar-${section}`);
    const activeMainSection = document.getElementById(`content-main-${section}`);
    if (activeSidebarBtn) {
        activeSidebarBtn.classList.add('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        activeSidebarBtn.classList.remove('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    }
    if (activeMainSection) {
        activeMainSection.classList.remove('hidden');
    }
    resetAdminScrollTop();
    if (section === 'notice') {
        renderNotices();
    } else if (section === 'pushMessage') {
        loadAdminPushMessagesPage();
    } else if (section === 'popup') {
        renderPopups();
    } else if (section === 'loginBanner') {
        loadLoginBannerConfig();
    }
};

/** 콘텐츠 상단 탭: 웰컴메시지(settings) vs 관리자명(displayName) — 동일 메인 영역(content-main-settings) */
function syncSettingsWelcomeTopTabs(sub) {
    const settingsBtn = document.getElementById('content-sidebar-settings');
    const displayNameBtn = document.getElementById('content-sidebar-displayName');
    if (!settingsBtn || !displayNameBtn) return;
    const off = ['text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50'];
    const on = ['text-emerald-600', 'bg-emerald-50', 'border-emerald-200'];
    [settingsBtn, displayNameBtn].forEach((btn) => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50', 'border-emerald-200', ...off);
        btn.classList.add(...off);
    });
    const target = sub === 'displayName' ? displayNameBtn : settingsBtn;
    off.forEach((c) => target.classList.remove(c));
    on.forEach((c) => target.classList.add(c));
}

// 사이드바 전환 (settings일 때 opts.sub: 'welcome' | 'welcome_api' | 'displayName')
window.switchContentSidebar = function (section, opts) {
    if (ALERTS_SIDEBAR_SECTIONS.includes(section)) {
        window.switchAdminTab('alerts');
        setTimeout(() => window.switchAlertsSidebar(section), 0);
        return;
    }
    // 모든 사이드바 버튼 비활성화
    document.querySelectorAll('[id^="content-sidebar-"]').forEach((btn) => {
        btn.classList.remove('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        btn.classList.add('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    });

    // 모든 메인 섹션 숨기기
    document.querySelectorAll('.content-main-section').forEach((sec) => {
        sec.classList.add('hidden');
    });

    if (section === 'settings') {
        const activeMainSection = document.getElementById('content-main-settings');
        if (activeMainSection) activeMainSection.classList.remove('hidden');
        bindAdminSettingsSubnavOnce();
        const sub = (opts && opts.sub) || 'welcome';
        window.switchAdminSettingsSub(sub);
        syncSettingsWelcomeTopTabs(sub);
        // loadAdminSettings가 끝날 때 fillAttendancePopupForm으로 라디오를 덮어쓰므로,
        // 로드 완료 전 클릭은 첫 번째 선택이 무효화되는 것처럼 보임 → 로드 후 스크롤·입력 허용
        void loadAdminSettings().finally(() => {
            resetAdminScrollTop();
        });
        return;
    }

    const activeSidebarBtn = document.getElementById(`content-sidebar-${section}`);
    const activeMainSection = document.getElementById(`content-main-${section}`);

    if (activeSidebarBtn) {
        activeSidebarBtn.classList.add('text-emerald-600', 'bg-emerald-50', 'border-emerald-200');
        activeSidebarBtn.classList.remove('text-slate-500', 'bg-white', 'border-slate-200', 'hover:bg-slate-50');
    }

    if (activeMainSection) {
        activeMainSection.classList.remove('hidden');
    }
    resetAdminScrollTop();

    // 섹션별 데이터 로드
    if (section === 'mealog') {
        loadMealogComments();
    } else if (section === 'characters') {
        showCharacterListView();
    } else if (section === 'terms') {
        loadTermsContent();
        // 약관관리 탭이 기본이므로 약관이력은 나중에 로드
    } else if (section === 'demoGuide') {
        loadDemoGuideContent();
    } else if (section === 'tags') {
        loadTagsContent();
    } else if (section === 'apk') {
        bindApkFileInput();
        loadApkContent();
    } else if (section === 'notice') {
        renderNotices();
    } else if (section === 'pushMessage') {
        loadAdminPushMessagesPage();
    } else if (section === 'popup') {
        renderPopups();
    } else if (section === 'loginBanner') {
        loadLoginBannerConfig();
    }
};

const ATT_DEFAULT_NO_L1 = '우리 오늘부터';
const ATT_DEFAULT_NO_L2 = '시작하는거죠?!';
const ATT_DEFAULT_NO_RECORD_COMBINED = `${ATT_DEFAULT_NO_L1}\n${ATT_DEFAULT_NO_L2}`;

let adminSettingsSubnavBound = false;
function bindAdminSettingsSubnavOnce() {
    if (adminSettingsSubnavBound) return;
    adminSettingsSubnavBound = true;
    document.querySelectorAll('.admin-settings-subnav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const sub = btn.dataset.settingsSub;
            if (sub) window.switchAdminSettingsSub(sub);
        });
    });
}

window.switchAdminSettingsSub = function (sub) {
    if (sub !== 'displayName' && sub !== 'welcome' && sub !== 'welcome_api') return;
    document.querySelectorAll('.admin-settings-subnav-btn').forEach((btn) => {
        const on = btn.dataset.settingsSub === sub;
        btn.classList.toggle('text-emerald-600', on);
        btn.classList.toggle('bg-emerald-50', on);
        btn.classList.toggle('border-emerald-200', on);
        btn.classList.toggle('text-slate-600', !on);
        btn.classList.toggle('bg-white', !on);
        btn.classList.toggle('border-slate-200', !on);
        btn.classList.toggle('hover:bg-slate-50', !on);
    });
    document.querySelectorAll('.admin-settings-subpanel').forEach((panel) => {
        const key = panel.id.replace('adminSettingsSub-', '');
        panel.classList.toggle('hidden', key !== sub);
    });
    if (sub === 'welcome_api') {
        bindAdminWelcomeApiOnce();
    }
    syncSettingsWelcomeTopTabs(sub);
};


// APK 배포 콘텐츠 로드
async function loadApkContent() {
    const container = document.getElementById('apkCurrentInfo');
    const linkEl = document.getElementById('apkDownloadPageLink');
    if (!container) return;
    try {
        const apkDoc = doc(db, 'artifacts', appId, 'content', 'apk');
        const apkSnap = await getDoc(apkDoc);
        if (apkSnap.exists()) {
            const d = apkSnap.data();
            const updatedAt = d.updatedAt?.toDate?.();
            const sizeMb = d.fileSize ? (d.fileSize / (1024 * 1024)).toFixed(2) : '-';
            container.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="text-emerald-600 font-bold">${d.fileName || '-'}</span>
                    ${d.version ? `<span class="px-2 py-0.5 bg-slate-200 rounded text-xs">v${d.version}</span>` : ''}
                </div>
                <p class="text-sm text-slate-600">용량: ${sizeMb} MB</p>
                <p class="text-sm text-slate-500">등록일: ${updatedAt ? updatedAt.toLocaleString('ko-KR') : '-'}</p>
                <a href="${d.downloadUrl}" target="_blank" class="inline-flex items-center gap-2 mt-2 px-3 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-sm font-bold hover:bg-emerald-200 transition-colors">
                    <i class="fa-solid fa-download"></i> 다운로드 링크
                </a>
            `;
        } else {
            container.innerHTML = '<p class="text-sm text-slate-500">등록된 APK가 없습니다. 위에서 APK 파일을 업로드해주세요.</p>';
        }
        if (linkEl) linkEl.href = new URL('./download.html', window.location.href).href;
    } catch (e) {
        console.error('APK 정보 로드 실패:', e);
        container.innerHTML = '<p class="text-sm text-red-500">로드 실패</p>';
    }
}

// APK 파일 업로드
window.uploadApkFile = async function() {
    const input = document.getElementById('apkFileInput');
    const uploadBtn = document.getElementById('apkUploadBtn');
    const statusEl = document.getElementById('apkUploadStatus');
    const versionInput = document.getElementById('apkVersionInput');
    if (!input?.files?.length) {
        if (typeof showToast === 'function') showToast('APK 파일을 선택해주세요.', 'error');
        return;
    }
    const file = input.files[0];
    if (!file.name.toLowerCase().endsWith('.apk')) {
        if (typeof showToast === 'function') showToast('APK 파일만 업로드할 수 있습니다.', 'error');
        return;
    }
    if (file.size > 100 * 1024 * 1024) {
        if (typeof showToast === 'function') showToast('파일 크기는 100MB 이하여야 합니다.', 'error');
        return;
    }
    try {
        uploadBtn.disabled = true;
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-slate-600';
            statusEl.textContent = '업로드 URL 요청 중...';
            statusEl.classList.remove('hidden');
        }
        const { uploadUrl, fileName } = await callableFunctions.getApkUploadUrl({
            fileName: file.name,
            version: (versionInput?.value || '').trim()
        }).then(r => r.data);
        if (statusEl) statusEl.textContent = '파일 업로드 중...';
        const res = await fetch(uploadUrl, {
            method: 'PUT',
            body: file,
            headers: { 'Content-Type': 'application/vnd.android.package-archive' }
        });
        if (!res.ok) {
            throw new Error(`업로드 실패: ${res.status}`);
        }
        if (statusEl) statusEl.textContent = '메타데이터 저장 중...';
        await callableFunctions.confirmApkUpload({
            fileName,
            version: (versionInput?.value || '').trim(),
            fileSize: file.size
        });
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-emerald-600';
            statusEl.textContent = '업로드 완료!';
        }
        if (typeof showToast === 'function') showToast('APK 업로드가 완료되었습니다.');
        loadApkContent();
        input.value = '';
        document.getElementById('apkFileInfo')?.classList.add('hidden');
    } catch (e) {
        console.error('APK 업로드 실패:', e);
        if (statusEl) {
            statusEl.className = 'mt-2 text-sm text-red-600';
            statusEl.textContent = '업로드 실패: ' + (e.message || '알 수 없는 오류');
            statusEl.classList.remove('hidden');
        }
        if (typeof showToast === 'function') showToast('업로드 실패: ' + (e.message || '알 수 없는 오류'), 'error');
    } finally {
        uploadBtn.disabled = false;
    }
};

// APK 파일 선택 시 UI 업데이트 (한 번만 바인딩)
let apkFileInputBound = false;
function bindApkFileInput() {
    if (apkFileInputBound) return;
    const apkInput = document.getElementById('apkFileInput');
    const apkInfo = document.getElementById('apkFileInfo');
    const apkUploadBtn = document.getElementById('apkUploadBtn');
    if (apkInput && apkInfo && apkUploadBtn) {
        apkInput.addEventListener('change', (e) => {
            const f = e.target.files?.[0];
            if (f) {
                apkInfo.textContent = `${f.name} (${(f.size / (1024 * 1024)).toFixed(2)} MB)`;
                apkInfo.classList.remove('hidden');
                apkUploadBtn.disabled = false;
            } else {
                apkInfo.classList.add('hidden');
                apkUploadBtn.disabled = true;
            }
        });
        apkFileInputBound = true;
    }
}

// 약관 콘텐츠 로드
async function loadTermsContent() {
    const termsDisplay = document.getElementById('termsContentDisplay');
    const termsEditor = document.getElementById('termsContentEditor');
    const termsTextarea = document.getElementById('termsContentTextarea');
    const privacyDisplay = document.getElementById('privacyContentDisplay');
    const privacyEditor = document.getElementById('privacyContentEditor');
    const privacyTextarea = document.getElementById('privacyContentTextarea');
    const termsUpdatedAt = document.getElementById('termsUpdatedAt');
    const privacyUpdatedAt = document.getElementById('privacyUpdatedAt');
    
    if (!termsDisplay || !termsEditor || !termsTextarea || !privacyDisplay || !privacyEditor || !privacyTextarea) return;
    
    try {
        // Firestore에서 약관 데이터 가져오기
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        const termsSnap = await getDoc(termsDoc);
        
        let termsData = {
            terms: '본 약관은 MEALOG(이하 "회사")가 제공하는 식사 기록 서비스의 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항을 규정함을 목적으로 합니다.\n\n제1조 (정의)\n1. "서비스"란 회사가 제공하는 식사 기록 및 관리 서비스를 의미합니다.\n2. "이용자"란 본 약관에 동의하고 회사가 제공하는 서비스를 이용하는 자를 의미합니다.\n\n제2조 (서비스의 제공)\n회사는 다음과 같은 서비스를 제공합니다: 식사 기록, 통계 분석, 사진 공유 등\n\n제3조 (이용자의 의무)\n이용자는 서비스를 이용함에 있어 관련 법령을 준수해야 합니다.',
            privacy: '회사는 다음의 목적을 위하여 개인정보를 처리합니다:\n1. 서비스 제공 및 계약의 이행\n2. 회원 관리 및 본인 확인\n3. 서비스 개선 및 신규 서비스 개발\n\n제1조 (수집하는 개인정보의 항목)\n회사는 다음과 같은 개인정보를 수집합니다:\n1. 필수항목: 이메일, 닉네임, 프로필 아이콘\n2. 선택항목: 위치 정보 (카카오 지도 이용 시)\n\n제2조 (개인정보의 보유 및 이용기간)\n회원 탈퇴 시까지 보유하며, 탈퇴 후 즉시 파기합니다.',
            updatedAt: null
        };
        
        if (termsSnap.exists()) {
            const data = termsSnap.data();
            // 기존 배열 형식에서 단일 텍스트로 변환
            if (data.terms) {
                if (Array.isArray(data.terms)) {
                    // 배열 형식인 경우 통합
                    termsData.terms = data.terms.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n');
                } else {
                    // 이미 단일 텍스트인 경우
                    termsData.terms = data.terms;
                }
            }
            if (data.privacy) {
                if (Array.isArray(data.privacy)) {
                    // 배열 형식인 경우 통합
                    termsData.privacy = data.privacy.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n');
                } else {
                    // 이미 단일 텍스트인 경우
                    termsData.privacy = data.privacy;
                }
            }
            if (data.updatedAt) {
                termsData.updatedAt = data.updatedAt;
            }
        }
        
        // 약관 렌더링 (읽기 모드)
        renderTermsContent('terms', termsData.terms, termsData.updatedAt);
        renderTermsContent('privacy', termsData.privacy, termsData.updatedAt);
        
    } catch (e) {
        console.error('약관 콘텐츠 로드 실패:', e);
        // 기본값으로 렌더링
        renderTermsContent('terms', termsData.terms, null);
        renderTermsContent('privacy', termsData.privacy, null);
    }
}

// 약관 내용 렌더링 (읽기 모드)
function renderTermsContent(type, content, updatedAt) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const updatedAtEl = document.getElementById(`${type}UpdatedAt`);
    
    if (!display || !editor || !textarea) return;
    
    // 읽기 모드로 전환
    display.classList.remove('hidden');
    editor.classList.add('hidden');
    
    // 내용 표시
    display.textContent = content || '';
    
    // textarea에 현재 값 저장 (편집 모드 전환 시 사용)
    textarea.value = content || '';
    
    // 저장 일자 표시
    if (updatedAtEl) {
        if (updatedAt) {
            try {
                const date = new Date(updatedAt);
                updatedAtEl.textContent = `최종 저장: ${date.toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })}`;
            } catch (e) {
                updatedAtEl.textContent = '';
            }
        } else {
            updatedAtEl.textContent = '';
        }
    }
    
    // 편집 버튼 상태 초기화
    const editBtn = document.getElementById(`${type}EditBtn`);
    if (editBtn) {
        editBtn.innerHTML = '<i class="fa-solid fa-pencil mr-1"></i>수정';
        editBtn.onclick = () => window.editTerms(type);
        editBtn.className = 'px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors';
    }
}

// 약관 편집 모드 전환
window.editTerms = function(type) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const editBtn = document.getElementById(`${type}EditBtn`);
    
    if (!display || !editor || !textarea || !editBtn) return;
    
    // 편집 모드로 전환
    display.classList.add('hidden');
    editor.classList.remove('hidden');
    textarea.focus();
    
    // 버튼 텍스트 변경
    editBtn.innerHTML = '<i class="fa-solid fa-times mr-1"></i>취소';
    editBtn.onclick = () => window.cancelEditTerms(type);
    editBtn.className = 'px-3 py-1.5 bg-slate-600 text-white rounded-lg text-sm font-bold hover:bg-slate-700 transition-colors';
};

// 약관 편집 취소
window.cancelEditTerms = function(type) {
    const display = document.getElementById(`${type}ContentDisplay`);
    const editor = document.getElementById(`${type}ContentEditor`);
    const textarea = document.getElementById(`${type}ContentTextarea`);
    const editBtn = document.getElementById(`${type}EditBtn`);
    
    if (!display || !editor || !textarea || !editBtn) return;
    
    // 읽기 모드로 전환
    display.classList.remove('hidden');
    editor.classList.add('hidden');
    
    // textarea 값을 원래 값(display의 내용)으로 복원
    textarea.value = display.textContent;
    
    // 버튼 텍스트 변경
    editBtn.innerHTML = '<i class="fa-solid fa-pencil mr-1"></i>수정';
    editBtn.onclick = () => window.editTerms(type);
    editBtn.className = 'px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-colors';
};

// 약관 탭 전환
window.switchTermsTab = function(tab) {
    const historyTab = document.getElementById('termsTabHistory');
    const manageTab = document.getElementById('termsTabManage');
    const historySection = document.getElementById('termsHistorySection');
    const manageSection = document.getElementById('termsManageSection');
    
    if (tab === 'history') {
        if (historyTab) {
            historyTab.className = 'px-4 py-2 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
        }
        if (manageTab) {
            manageTab.className = 'px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 border-b-2 border-transparent hover:border-slate-300 transition-colors';
        }
        if (historySection) historySection.classList.remove('hidden');
        if (manageSection) manageSection.classList.add('hidden');
        loadTermsHistory();
    } else {
        if (historyTab) {
            historyTab.className = 'px-4 py-2 text-sm font-bold text-slate-500 hover:text-slate-700 border-b-2 border-transparent hover:border-slate-300 transition-colors';
        }
        if (manageTab) {
            manageTab.className = 'px-4 py-2 text-sm font-bold text-emerald-600 border-b-2 border-emerald-600 transition-colors';
        }
        if (historySection) historySection.classList.add('hidden');
        if (manageSection) manageSection.classList.remove('hidden');
    }
};

// 약관 이력 로드
async function loadTermsHistory() {
    const historyList = document.getElementById('termsHistoryList');
    if (!historyList) return;
    
    try {
        historyList.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p class="text-sm">약관 이력 로딩 중...</p></div>';
        
        // 배포된 약관 버전 목록 가져오기 (terms 문서의 하위 컬렉션으로 저장)
        const versionsColl = collection(db, 'artifacts', appId, 'content', 'terms', 'versions');
        const versionsQuery = query(versionsColl, orderBy('deployedAt', 'desc'));
        const versionsSnapshot = await getDocs(versionsQuery);
        
        const versions = [];
        versionsSnapshot.forEach(doc => {
            const data = doc.data();
            versions.push({
                id: doc.id,
                version: data.version || doc.id,
                deployedAt: data.deployedAt,
                deployedBy: data.deployedBy || '관리자',
                terms: data.terms || [],
                privacy: data.privacy || []
            });
        });
        
        if (versions.length === 0) {
            historyList.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">배포된 약관 버전이 없습니다.</p></div>';
            return;
        }
        
        // 현재 약관 버전 가져오기
        const currentVersion = await getCurrentTermsVersion();
        
        // 약관 버전 리스트 렌더링
        historyList.innerHTML = versions.map(v => {
            const date = v.deployedAt ? new Date(v.deployedAt).toLocaleString('ko-KR') : '날짜 없음';
            // 버전 비교 시 숫자로 변환하여 비교 (1.0과 1은 같음)
            const vVersion = String(v.version).trim();
            const cVersion = String(currentVersion).trim();
            const vNum = parseFloat(vVersion);
            const cNum = parseFloat(cVersion);
            const isCurrent = !isNaN(vNum) && !isNaN(cNum) && vNum === cNum;
            
            return `
                <div class="bg-white rounded-xl p-4 border border-slate-200 hover:border-emerald-300 transition-colors">
                    <div class="flex items-center justify-between">
                        <div class="flex-1">
                            <div class="flex items-center gap-2 mb-1">
                                <span class="text-sm font-bold text-slate-800">버전 ${v.version}</span>
                                ${isCurrent ? '<span class="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded text-xs font-bold">현재 적용 중</span>' : ''}
                            </div>
                            <p class="text-xs text-slate-500">배포일: ${date}</p>
                            <p class="text-xs text-slate-500">배포자: ${v.deployedBy}</p>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="window.showTermsVersion('${v.id}')" class="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-200 transition-colors">
                                확인
                            </button>
                            ${!isCurrent ? `<button onclick="window.deleteTermsVersion('${v.id}')" class="px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors">
                                <i class="fa-solid fa-trash mr-1"></i>삭제
                            </button>` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (e) {
        console.error('약관 이력 로드 실패:', e);
        historyList.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">약관 이력 로드 중 오류가 발생했습니다.</p></div>';
    }
}

// 약관 버전 보기
window.showTermsVersion = async function(versionId) {
    try {
        const versionDoc = doc(db, 'artifacts', appId, 'content', 'terms', 'versions', versionId);
        const versionSnap = await getDoc(versionDoc);
        
        if (!versionSnap.exists()) {
            alert('약관 버전을 찾을 수 없습니다.');
            return;
        }
        
        const data = versionSnap.data();
        const versionContent = document.getElementById('termsVersionContent');
        const versionModal = document.getElementById('termsVersionModal');
        
        if (!versionContent || !versionModal) return;
        
        const date = data.deployedAt ? new Date(data.deployedAt).toLocaleString('ko-KR') : '날짜 없음';
        const currentVersion = await getCurrentTermsVersion();
        // 버전 비교 시 숫자로 변환하여 비교 (1.0과 1은 같음)
        const vNum = parseFloat(String(data.version).trim());
        const cNum = parseFloat(String(currentVersion).trim());
        const isCurrent = !isNaN(vNum) && !isNaN(cNum) && vNum === cNum;
        
        versionContent.innerHTML = `
            <div class="mb-4 pb-4 border-b border-slate-200">
                <div class="flex items-center justify-between">
                    <h4 class="text-base font-bold text-slate-800">버전 ${data.version}</h4>
                    ${isCurrent ? '<span class="px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-xs font-bold">현재 적용 중</span>' : ''}
                </div>
                <p class="text-xs text-slate-500 mt-1">배포일: ${date}</p>
                <p class="text-xs text-slate-500">배포자: ${data.deployedBy || '관리자'}</p>
            </div>
            
            <!-- 이용약관 -->
            <div class="bg-slate-50 rounded-xl p-4 border border-slate-200">
                <h5 class="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <i class="fa-solid fa-file-contract text-emerald-600"></i>
                    이용약관
                </h5>
                <div class="bg-white rounded-lg p-3 border border-slate-200 text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                    ${escapeHtml(Array.isArray(data.terms) ? data.terms.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n') : (data.terms || ''))}
                </div>
            </div>
            
            <!-- 개인정보 처리방침 -->
            <div class="bg-slate-50 rounded-xl p-4 border border-slate-200">
                <h5 class="text-sm font-bold text-slate-800 mb-3 flex items-center gap-2">
                    <i class="fa-solid fa-shield-halved text-blue-600"></i>
                    개인정보 처리방침
                </h5>
                <div class="bg-white rounded-lg p-3 border border-slate-200 text-xs text-slate-600 leading-relaxed whitespace-pre-line">
                    ${escapeHtml(Array.isArray(data.privacy) ? data.privacy.map(item => {
                        const title = item.title || '';
                        const content = item.content || '';
                        return title ? `${title}\n${content}` : content;
                    }).join('\n\n') : (data.privacy || ''))}
                </div>
            </div>
        `;
        
        versionModal.classList.remove('hidden');
    } catch (e) {
        console.error('약관 버전 보기 실패:', e);
        alert('약관 버전을 불러오는 중 오류가 발생했습니다: ' + e.message);
    }
};

// 약관 버전 모달 닫기
window.closeTermsVersionModal = function() {
    const modal = document.getElementById('termsVersionModal');
    if (modal) {
        modal.classList.add('hidden');
    }
};

// 약관 버전 삭제
window.deleteTermsVersion = async function(versionId) {
    if (!confirm('이 약관 버전을 삭제하시겠습니까?\n\n삭제된 버전은 복구할 수 없습니다.')) {
        return;
    }
    
    try {
        const versionDoc = doc(db, 'artifacts', appId, 'content', 'terms', 'versions', versionId);
        await deleteDoc(versionDoc);
        
        alert('약관 버전이 삭제되었습니다.');
        
        // 약관이력 새로고침
        await loadTermsHistory();
    } catch (e) {
        console.error('약관 버전 삭제 실패:', e);
        alert('약관 버전 삭제 중 오류가 발생했습니다: ' + e.message);
    }
};
window.deployTerms = async function() {
    if (!confirm('약관을 배포하시겠습니까?\n\n배포하면 모든 사용자에게 재동의를 요청하게 됩니다.')) {
        return;
    }
    
    try {
        // 현재 표시된 약관 내용 가져오기
        const termsDisplay = document.getElementById('termsContentDisplay');
        const privacyDisplay = document.getElementById('privacyContentDisplay');
        const termsTextarea = document.getElementById('termsContentTextarea');
        const privacyTextarea = document.getElementById('privacyContentTextarea');
        const termsEditor = document.getElementById('termsContentEditor');
        const privacyEditor = document.getElementById('privacyContentEditor');
        
        let termsContent = '';
        let privacyContent = '';
        
        // 편집 모드인지 확인하고, 편집 모드의 내용을 가져오기
        if (termsEditor && !termsEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            termsContent = termsTextarea ? termsTextarea.value : '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            termsContent = termsDisplay ? termsDisplay.textContent : '';
        }
        
        if (privacyEditor && !privacyEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            privacyContent = privacyTextarea ? privacyTextarea.value : '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            privacyContent = privacyDisplay ? privacyDisplay.textContent : '';
        }
        
        if (!termsContent || !privacyContent) {
            alert('약관 내용을 입력해주세요.');
            return;
        }
        
        // 현재 약관 버전 가져오기 (Firestore 우선, 없으면 constants.js 기본값)
        const currentVersion = await getCurrentTermsVersion();
        const baseVersion = parseFloat(currentVersion);
        const newVersion = (baseVersion + 0.1).toFixed(1); // 버전 0.1씩 증가
        
        // 약관 버전 데이터 저장 (배열 형식으로 변환하여 저장 - 기존 호환성 유지)
        const versionData = {
            version: newVersion,
            terms: [{ title: '이용약관', content: termsContent }],
            privacy: [{ title: '개인정보 처리방침', content: privacyContent }],
            deployedAt: new Date().toISOString(),
            deployedBy: auth.currentUser?.email || '관리자'
        };
        
        // 약관 버전 컬렉션에 저장 (terms 문서의 하위 컬렉션으로 저장)
        const versionsColl = collection(db, 'artifacts', appId, 'content', 'terms', 'versions');
        await addDoc(versionsColl, versionData);
        
        // 현재 약관도 업데이트 (단일 텍스트 형식으로 저장)
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        await setDoc(termsDoc, {
            terms: termsContent,
            privacy: privacyContent,
            updatedAt: new Date().toISOString(),
            currentVersion: newVersion  // Firestore에 현재 버전 저장
        }, { merge: true });
        
        // 약관 버전 캐시 무효화
        invalidateTermsVersionCache();
        
        alert(`약관 버전 ${newVersion}이 배포되었습니다.\n\n버전이 자동으로 업데이트되었습니다.`);
        console.log(`✅ 약관 버전 ${newVersion} 배포 완료. Firestore에 currentVersion 저장됨.`);
        
        // 약관이력 탭이면 새로고침
        const historySection = document.getElementById('termsHistorySection');
        if (historySection && !historySection.classList.contains('hidden')) {
            loadTermsHistory();
        }
        
        // 약관 관리 탭이면 내용 새로고침
        const manageSection = document.getElementById('termsManageSection');
        if (manageSection && !manageSection.classList.contains('hidden')) {
            await loadTermsContent();
        }
        
    } catch (e) {
        console.error('약관 배포 실패:', e);
        alert('약관 배포 중 오류가 발생했습니다: ' + e.message);
    }
};

// 약관 저장
window.saveTerms = async function() {
    try {
        const termsTextarea = document.getElementById('termsContentTextarea');
        const privacyTextarea = document.getElementById('privacyContentTextarea');
        const termsDisplay = document.getElementById('termsContentDisplay');
        const termsEditor = document.getElementById('termsContentEditor');
        const privacyDisplay = document.getElementById('privacyContentDisplay');
        const privacyEditor = document.getElementById('privacyContentEditor');
        
        if (!termsTextarea || !privacyTextarea) {
            alert('약관 데이터를 찾을 수 없습니다.');
            return;
        }
        
        // 편집 모드인지 확인하고, 편집 모드의 내용을 가져오기
        let termsContent = '';
        let privacyContent = '';
        
        if (termsEditor && !termsEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            termsContent = termsTextarea.value || '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            termsContent = termsDisplay ? termsDisplay.textContent : '';
        }
        
        if (privacyEditor && !privacyEditor.classList.contains('hidden')) {
            // 편집 모드이므로 textarea의 값을 가져옴
            privacyContent = privacyTextarea.value || '';
        } else {
            // 읽기 모드이므로 display의 내용을 가져옴
            privacyContent = privacyDisplay ? privacyDisplay.textContent : '';
        }
        
        const termsData = {
            terms: termsContent,
            privacy: privacyContent,
            updatedAt: new Date().toISOString()
        };
        
        const termsDoc = doc(db, 'artifacts', appId, 'content', 'terms');
        await setDoc(termsDoc, termsData, { merge: true });
        
        alert('약관이 저장되었습니다.');
        console.log('약관 저장 완료:', termsData);
        
        // 저장 후 다시 로드하여 최종 저장 일자 업데이트 및 편집 모드 해제
        await loadTermsContent();
        
    } catch (e) {
        console.error('약관 저장 실패:', e);
        alert('약관 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// ── 체험 가이드 편집 ──
const DEMO_GUIDE_TABS = [
    { key: 'dashboard', icon: 'fa-chart-line',  label: '밀당' },
    { key: 'gallery',   icon: 'fa-images',      label: '모먼트' },
    { key: 'timeline',  icon: 'fa-clock',        label: '밀로그' },
    { key: 'board',     icon: 'fa-comments',     label: '라운지' },
    { key: 'settings',  icon: 'fa-gear',         label: '설정' },
];

async function loadDemoGuideContent() {
    const container = document.getElementById('demoGuideEditorContainer');
    if (!container) return;

    try {
        const guideDoc = doc(db, 'artifacts', appId, 'content', 'demoGuide');
        const snap = await getDoc(guideDoc);
        const saved = snap.exists() ? snap.data() : {};

        container.innerHTML = DEMO_GUIDE_TABS.map(t => {
            const d = saved[t.key] || {};
            return `
            <div class="bg-slate-50 rounded-xl p-5 border border-slate-200">
                <h3 class="text-sm font-black text-slate-800 flex items-center gap-2 mb-3">
                    <i class="fa-solid ${t.icon} text-emerald-600"></i>${t.label}
                    <span class="text-[10px] font-mono text-slate-400">${t.key}</span>
                </h3>
                <div class="space-y-3">
                    <div>
                        <label class="block text-xs font-bold text-slate-600 mb-1">제목</label>
                        <input id="dg-label-${t.key}" type="text" value="${escapeHtml(d.label || t.label)}"
                               class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500"/>
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-600 mb-1">설명</label>
                        <textarea id="dg-desc-${t.key}" rows="2"
                                  class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y">${escapeHtml(d.desc || '')}</textarea>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error('체험 가이드 로드 실패:', e);
        container.innerHTML = '<p class="text-center py-8 text-red-400 text-sm">로드 중 오류가 발생했습니다.</p>';
    }
}

window.saveDemoGuide = async function() {
    try {
        const data = {};
        for (const t of DEMO_GUIDE_TABS) {
            const labelEl = document.getElementById(`dg-label-${t.key}`);
            const descEl  = document.getElementById(`dg-desc-${t.key}`);
            data[t.key] = {
                label: (labelEl?.value || '').trim(),
                desc:  (descEl?.value  || '').trim(),
            };
        }
        const guideDoc = doc(db, 'artifacts', appId, 'content', 'demoGuide');
        await setDoc(guideDoc, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
        alert('체험 가이드가 저장되었습니다.');
    } catch (e) {
        console.error('체험 가이드 저장 실패:', e);
        alert('체험 가이드 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 관리자 표시 이름 캐시 (공지·댓글 작성 시 사용)
let cachedAdminDisplayName = '관리자';

function fillTriFreq(name, value) {
    const v =
        value === 'off' || value === 'once_per_day' || value === 'every_session'
            ? value
            : 'every_session';
    document.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
        r.checked = r.value === v;
    });
}

function fillAttendancePopupForm(rawAp) {
    const n = normalizeAttendancePopup(rawAp && typeof rawAp === 'object' ? rawAp : {});
    const keys = ['noRecord', 'noStreak', 'streakOne', 'streakTwoOrMore'];
    const stagingFreqNames = [
        'attendanceNoRecordStagingFreq',
        'attendanceNoStreakStagingFreq',
        'attendanceStreakOneStagingFreq',
        'attendanceStreakMultiStagingFreq'
    ];
    const prodFreqNames = [
        'attendanceNoRecordProductionFreq',
        'attendanceNoStreakProductionFreq',
        'attendanceStreakOneProductionFreq',
        'attendanceStreakMultiProductionFreq'
    ];
    const msgIds = ['attendanceNoMessage', 'attendanceNoStreakMessage', 'attendanceStreakOneMessage', 'attendanceStreakMultiMessage'];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const row = n[k];
        fillTriFreq(stagingFreqNames[i], row.stagingFrequency);
        fillTriFreq(prodFreqNames[i], row.productionFrequency);
        const msgEl = document.getElementById(msgIds[i]);
        const v = row.message;
        if (msgEl) {
            if (i === 0) {
                msgEl.value = v === null || v === undefined ? ATT_DEFAULT_NO_RECORD_COMBINED : String(v);
            } else {
                msgEl.value = v == null ? '' : String(v);
            }
        }
    }
}

let loadAdminSettingsGen = 0;

async function loadAdminSettings() {
    const inputEl = document.getElementById('adminDisplayNameInput');
    if (!inputEl) return;
    const gen = ++loadAdminSettingsGen;
    const settingsShell = document.getElementById('content-main-settings');
    if (settingsShell) {
        settingsShell.classList.add('pointer-events-none', 'opacity-90', 'cursor-wait');
        settingsShell.setAttribute('aria-busy', 'true');
    }
    try {
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        const snap = await getDoc(configRef);
        const data = snap.exists() ? snap.data() : {};
        const displayName = data.displayName ? String(data.displayName).trim() : '관리자';
        cachedAdminDisplayName = displayName || '관리자';
        inputEl.value = cachedAdminDisplayName;

        const ap = data.attendancePopup && typeof data.attendancePopup === 'object' ? data.attendancePopup : {};
        fillAttendancePopupForm(ap);
    } catch (e) {
        console.warn('관리자 설정 로드 실패:', e);
        inputEl.value = cachedAdminDisplayName;
    } finally {
        if (gen === loadAdminSettingsGen && settingsShell) {
            settingsShell.classList.remove('pointer-events-none', 'opacity-90', 'cursor-wait');
            settingsShell.removeAttribute('aria-busy');
        }
    }
}

window.saveAdminDisplayName = async function() {
    const inputEl = document.getElementById('adminDisplayNameInput');
    if (!inputEl) return;
    const value = inputEl.value.trim() || '관리자';
    try {
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        await setDoc(configRef, { displayName: value }, { merge: true });
        cachedAdminDisplayName = value;
        invalidateAdminDisplayNameCache();
        alert('저장되었습니다.');
    } catch (e) {
        console.error('관리자 표시 이름 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
};

function readTriFreq(name) {
    const v = document.querySelector(`input[name="${name}"]:checked`)?.value;
    if (v === 'off' || v === 'once_per_day' || v === 'every_session') return v;
    return 'every_session';
}

window.saveAttendancePopupSettings = async function () {
    try {
        const configRef = doc(db, 'artifacts', appId, 'adminSettings', 'config');
        const payload = {
            noRecord: {
                message: document.getElementById('attendanceNoMessage')?.value?.trim() ?? '',
                stagingFrequency: readTriFreq('attendanceNoRecordStagingFreq'),
                productionFrequency: readTriFreq('attendanceNoRecordProductionFreq')
            },
            noStreak: {
                message: document.getElementById('attendanceNoStreakMessage')?.value?.trim() ?? '',
                stagingFrequency: readTriFreq('attendanceNoStreakStagingFreq'),
                productionFrequency: readTriFreq('attendanceNoStreakProductionFreq')
            },
            streakOne: {
                message: document.getElementById('attendanceStreakOneMessage')?.value?.trim() ?? '',
                stagingFrequency: readTriFreq('attendanceStreakOneStagingFreq'),
                productionFrequency: readTriFreq('attendanceStreakOneProductionFreq')
            },
            streakTwoOrMore: {
                message: document.getElementById('attendanceStreakMultiMessage')?.value?.trim() ?? '',
                stagingFrequency: readTriFreq('attendanceStreakMultiStagingFreq'),
                productionFrequency: readTriFreq('attendanceStreakMultiProductionFreq')
            }
        };
        await setDoc(configRef, { attendancePopup: payload }, { merge: true });
        invalidateAttendancePopupConfigCache();
        alert('웰컴메시지 설정이 저장되었습니다.');
    } catch (e) {
        console.error('연속 기록 팝업 설정 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e?.message || e));
    }
};

