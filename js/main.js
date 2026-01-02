// 메인 애플리케이션 로직
console.log('main.js 로드 시작...');

import { appState, getState } from './state.js';
import { auth } from './firebase.js';
import { dbOps, setupListeners, setupSharedPhotosListener } from './db.js';
import { switchScreen, showToast, updateHeaderUI } from './ui.js';
import { 
    initAuth, handleGoogleLogin, startGuest, openEmailModal, closeEmailModal,
    setEmailAuthMode, toggleEmailAuthMode, handleEmailAuth, confirmLogout, confirmLogoutAction,
    copyDomain, closeDomainModal
} from './auth.js';
import { renderTimeline, renderMiniCalendar, renderGallery } from './render.js';
import { updateDashboard, setDashboardMode, updateCustomDates, updateSelectedMonth, openDetailModal, closeDetailModal } from './analytics.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, setRating, setSatiety, selectTag,
    handleMultipleImages, removePhoto, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, saveSettings, selectIcon, addTag, removeTag, deleteSubTag
} from './modals.js';
import { DEFAULT_SUB_TAGS } from './constants.js';

// 전역 객체에 함수들 할당 (HTML에서 접근 가능하도록)
window.dbOps = dbOps;
window.showToast = showToast;
window.renderTimeline = renderTimeline;
window.renderGallery = renderGallery;
window.updateHeaderUI = updateHeaderUI;
window.copyDomain = copyDomain;
window.closeDomainModal = closeDomainModal;
window.handleGoogleLogin = handleGoogleLogin;
window.startGuest = startGuest;
window.openEmailModal = openEmailModal;
window.closeEmailModal = closeEmailModal;
window.setEmailAuthMode = setEmailAuthMode;
window.toggleEmailAuthMode = toggleEmailAuthMode;
window.handleEmailAuth = handleEmailAuth;
window.confirmLogout = confirmLogout;
window.confirmLogoutAction = confirmLogoutAction;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveEntry = saveEntry;
window.deleteEntry = deleteEntry;
window.setRating = setRating;
window.setSatiety = setSatiety;
window.selectTag = selectTag;
window.handleMultipleImages = handleMultipleImages;
window.removePhoto = removePhoto;
window.updateShareIndicator = updateShareIndicator;
window.toggleSharePhoto = toggleSharePhoto;
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.saveSettings = saveSettings;
window.selectIcon = selectIcon;
window.addTag = addTag;
window.removeTag = removeTag;
window.deleteSubTag = deleteSubTag;
window.setDashboardMode = setDashboardMode;
window.updateCustomDates = updateCustomDates;
window.updateSelectedMonth = updateSelectedMonth;
window.openDetailModal = openDetailModal;
window.closeDetailModal = closeDetailModal;

// 탭 및 뷰 모드 전환
window.switchMainTab = (tab) => {
    appState.currentTab = tab;
    document.getElementById('timelineView').classList.toggle('hidden', tab !== 'timeline');
    document.getElementById('galleryView').classList.toggle('hidden', tab !== 'gallery');
    document.getElementById('dashboardView').classList.toggle('hidden', tab !== 'dashboard');
    document.getElementById('trackerSection').classList.toggle('hidden', tab !== 'timeline');
    document.getElementById('nav-timeline').className = tab === 'timeline' ? 
        'text-emerald-600 flex justify-center items-center py-1' : 
        'text-slate-300 flex justify-center items-center py-1';
    document.getElementById('nav-gallery').className = tab === 'gallery' ? 
        'text-emerald-600 flex justify-center items-center py-1' : 
        'text-slate-300 flex justify-center items-center py-1';
    document.getElementById('nav-dashboard').className = tab === 'dashboard' ? 
        'text-emerald-600 flex justify-center items-center py-1' : 
        'text-slate-300 flex justify-center items-center py-1';
    
    const searchBtn = document.getElementById('searchTriggerBtn');
    if (searchBtn) searchBtn.style.display = tab === 'timeline' ? 'flex' : 'none';
    
    if (tab === 'dashboard') {
        updateDashboard();
    } else if (tab === 'gallery') {
        renderGallery();
    } else {
        // 타임라인 탭으로 전환 시 오늘 날짜로 초기화
        if (appState.viewMode === 'list') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            appState.pageDate = today;
        }
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        renderTimeline();
        renderMiniCalendar();
    }
};

window.setViewMode = (m) => {
    appState.viewMode = m;
    document.getElementById('btn-view-list').className = `view-tab ${m === 'list' ? 'active' : 'inactive'}`;
    document.getElementById('btn-view-page').className = `view-tab ${m === 'page' ? 'active' : 'inactive'}`;
    if (m === 'list') {
        // 오늘 날짜로 설정
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        appState.pageDate = today;
    }
    window.loadedDates = [];
    const c = document.getElementById('timelineContainer');
    if (c) c.innerHTML = "";
    renderTimeline();
    renderMiniCalendar();
};

window.jumpToDate = (iso) => {
    // 날짜를 명확하게 설정 (시간대 문제 방지)
    const targetDate = new Date(iso + 'T00:00:00');
    appState.pageDate = targetDate;
    
    if (appState.viewMode === 'list') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // 로컬 날짜로 변환하여 시간대 문제 방지
        const todayYear = today.getFullYear();
        const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
        const todayDay = String(today.getDate()).padStart(2, '0');
        const todayStr = `${todayYear}-${todayMonth}-${todayDay}`;
        const targetStr = iso;
        
        // 오늘부터 선택한 날짜까지의 날짜 차이 계산 (날짜만 비교)
        const [todayY, todayM, todayD] = todayStr.split('-').map(Number);
        const [targetY, targetM, targetD] = targetStr.split('-').map(Number);
        const todayDateOnly = new Date(todayY, todayM - 1, todayD);
        const targetDateOnly = new Date(targetY, targetM - 1, targetD);
        const diffDays = Math.ceil((todayDateOnly - targetDateOnly) / (1000 * 60 * 60 * 24));
        
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        
        // 선택한 날짜가 포함될 때까지 렌더링
        renderTimeline();
        while (!window.loadedDates.includes(targetStr) && window.loadedDates.length < Math.max(diffDays + 5, 10)) {
            renderTimeline();
        }
        
        renderMiniCalendar();
        
        // 저장 후 자동 스크롤이 아니면 기본 스크롤 동작 실행
        if (!window.isScrolling) {
            setTimeout(() => {
                const el = document.getElementById(`date-${targetStr}`);
                if (el) {
                    // 트래커 섹션 높이를 고려하여 스크롤
                    const trackerSection = document.getElementById('trackerSection');
                    const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                    const headerHeight = 73;
                    const totalOffset = headerHeight + trackerHeight;
                    const elementTop = el.getBoundingClientRect().top + window.pageYOffset;
                    const offsetPosition = elementTop - totalOffset - 16;
                    window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                }
            }, 200);
        }
    } else {
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        renderTimeline();
        renderMiniCalendar();
    }
};

window.toggleSearch = () => {
    const sc = document.getElementById('searchContainer');
    if (sc.classList.contains('hidden')) {
        sc.classList.remove('hidden');
    } else {
        sc.classList.add('hidden');
    }
};

window.closeSearch = () => {
    document.getElementById('searchContainer')?.classList.add('hidden');
    document.getElementById('searchInput').value = '';
    window.loadedDates = [];
    document.getElementById('timelineContainer').innerHTML = "";
    renderTimeline();
};

window.handleSearch = (k) => {
    const c = document.getElementById('timelineContainer');
    if (!c) return;
    if (!k.trim()) {
            window.loadedDates = [];
        c.innerHTML = "";
            renderTimeline(); 
        return;
    }
    const res = window.mealHistory.filter(m => 
        (m.menuDetail?.toLowerCase().includes(k.toLowerCase()) || 
         m.place?.toLowerCase().includes(k.toLowerCase()))
    );
    c.innerHTML = `<div class="px-2 py-2 text-xs font-bold text-slate-400">결과 ${res.length}건</div>` + 
        res.map(r => 
            `<div onclick="window.openModal('${r.date}', '${r.slotId}', '${r.id}')" class="card p-4 mb-4 border border-slate-100 active:scale-[0.98] transition-all">
                <h4 class="font-bold">${r.menuDetail || r.mealType}</h4>
                <p class="text-[10px] text-slate-400">${r.date}</p>
            </div>`
        ).join('');
};

// 인증 상태 변경 리스너
initAuth((user) => {
    if (user) { 
        window.currentUser = user; 
        const { settingsUnsubscribe, dataUnsubscribe } = setupListeners(user.uid, {
            onSettingsUpdate: updateHeaderUI,
            onDataUpdate: () => {
                // 오늘 날짜로 초기화
                if (appState.viewMode === 'list') {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    appState.pageDate = today;
                }
                window.loadedDates = [];
                const container = document.getElementById('timelineContainer');
                if (container) container.innerHTML = "";
                renderTimeline();
                renderMiniCalendar();
            },
            settingsUnsubscribe: appState.settingsUnsubscribe,
            dataUnsubscribe: appState.dataUnsubscribe
        });
        appState.settingsUnsubscribe = settingsUnsubscribe;
        appState.dataUnsubscribe = dataUnsubscribe;
        
        // 공유 사진 리스너 설정
        if (appState.sharedPhotosUnsubscribe) {
            appState.sharedPhotosUnsubscribe();
        }
        appState.sharedPhotosUnsubscribe = setupSharedPhotosListener((sharedPhotos) => {
            window.sharedPhotos = sharedPhotos;
            if (appState.currentTab === 'gallery') {
                renderGallery();
            }
        });
        
        // 초기 로드 시 오늘 날짜로 설정
        if (appState.viewMode === 'list') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            appState.pageDate = today;
        }
        
        switchScreen(true);
    } else {
        switchScreen(false);
        if (appState.sharedPhotosUnsubscribe) {
            appState.sharedPhotosUnsubscribe();
            appState.sharedPhotosUnsubscribe = null;
        }
    }
    document.getElementById('loadingOverlay')?.classList.add('hidden');
});

// 스크롤 이벤트 리스너
window.addEventListener('scroll', () => { 
    const state = appState;
    if (state.viewMode === 'list' && window.currentUser && 
        (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 400) {
        renderTimeline();
    }
});

// 터치 제스처 초기화
window.onload = () => {
    const tv = document.getElementById('timelineView');
    if (tv) {
        tv.addEventListener('touchstart', e => {
            appState.touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });
        
        tv.addEventListener('touchend', e => { 
            appState.touchEndX = e.changedTouches[0].screenX;
            const state = appState;
            if (state.viewMode === 'page' && Math.abs(state.touchStartX - state.touchEndX) > 50) {
                let d = new Date(state.pageDate);
                d.setDate(d.getDate() + (state.touchStartX - state.touchEndX > 0 ? 1 : -1));
                // 로컬 날짜로 변환하여 시간대 문제 방지
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                window.jumpToDate(`${year}-${month}-${day}`); 
            } 
        }, { passive: true });
    }
};

// 초기화 완료
console.log('main.js 초기화 완료');
console.log('renderTimeline 함수:', typeof window.renderTimeline);

// 에러 핸들링
window.addEventListener('error', (e) => {
    console.error('JavaScript 에러:', e);
    console.error('에러 파일:', e.filename);
    console.error('에러 메시지:', e.message);
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
});
