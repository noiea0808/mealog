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
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        renderTimeline();
    }
};

window.setViewMode = (m) => {
    appState.viewMode = m;
    document.getElementById('btn-view-list').className = `view-tab ${m === 'list' ? 'active' : 'inactive'}`;
    document.getElementById('btn-view-page').className = `view-tab ${m === 'page' ? 'active' : 'inactive'}`;
    if (m === 'list') {
        appState.pageDate = new Date();
    }
    window.loadedDates = [];
    const c = document.getElementById('timelineContainer');
    if (c) c.innerHTML = "";
    renderTimeline();
    renderMiniCalendar();
};

window.jumpToDate = (iso) => {
    appState.pageDate = new Date(iso);
    if (appState.viewMode === 'list') {
        const target = new Date(iso);
        const today = new Date();
        const diffDays = Math.ceil(Math.abs(today - target) / (1000 * 60 * 60 * 24));
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = "";
        renderTimeline();
        while (!window.loadedDates.includes(iso) && window.loadedDates.length < diffDays + 10) {
            renderTimeline();
        }
        renderMiniCalendar();
        // 저장 후 자동 스크롤이 아니면 기본 스크롤 동작 실행
        if (!window.isScrolling) {
            setTimeout(() => {
                const el = document.getElementById(`date-${iso}`);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
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
                window.jumpToDate(d.toISOString().split('T')[0]); 
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
