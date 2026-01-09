// 메인 애플리케이션 로직
console.log('main.js 로드 시작...');

import { appState, getState } from './state.js';
import { auth } from './firebase.js';
import { dbOps, setupListeners, setupSharedPhotosListener, loadMoreMeals } from './db.js';
import { switchScreen, showToast, updateHeaderUI } from './ui.js';
import { 
    initAuth, handleGoogleLogin, startGuest, openEmailModal, closeEmailModal,
    setEmailAuthMode, toggleEmailAuthMode, handleEmailAuth, confirmLogout, confirmLogoutAction,
    copyDomain, closeDomainModal, switchToLogin
} from './auth.js';
import { renderTimeline, renderMiniCalendar, renderGallery, renderFeed, renderEntryChips, toggleComment, toggleFeedComment, createDailyShareCard } from './render.js';
import { updateDashboard, setDashboardMode, updateCustomDates, updateSelectedMonth, updateSelectedWeek, changeWeek, changeMonth, navigatePeriod, openDetailModal, closeDetailModal, setAnalysisType, openShareBestModal, closeShareBestModal, shareBestToFeed, openCharacterSelectModal, closeCharacterSelectModal, selectInsightCharacter, showInsightPage, generateInsightComment } from './analytics.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, setRating, setSatiety, selectTag,
    handleMultipleImages, removePhoto, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, saveSettings, selectIcon, addTag, removeTag, deleteSubTag, addFavoriteTag, removeFavoriteTag, selectFavoriteMainTag
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
window.switchToLogin = switchToLogin;
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
window.addFavoriteTag = addFavoriteTag;
window.removeFavoriteTag = removeFavoriteTag;
window.selectFavoriteMainTag = selectFavoriteMainTag;
window.setDashboardMode = setDashboardMode;
window.updateCustomDates = updateCustomDates;
window.updateSelectedMonth = updateSelectedMonth;
window.updateSelectedWeek = updateSelectedWeek;
window.navigatePeriod = navigatePeriod;
window.openDetailModal = openDetailModal;
window.closeDetailModal = closeDetailModal;
window.setAnalysisType = setAnalysisType;
window.openShareBestModal = openShareBestModal;
window.closeShareBestModal = closeShareBestModal;
window.shareBestToFeed = shareBestToFeed;
window.openCharacterSelectModal = openCharacterSelectModal;
window.closeCharacterSelectModal = closeCharacterSelectModal;
window.selectInsightCharacter = selectInsightCharacter;
window.showInsightPage = showInsightPage;
window.generateInsightComment = generateInsightComment;
window.toggleComment = toggleComment;
window.toggleFeedComment = toggleFeedComment;

// 일간보기 공유 상태 확인
async function checkDailyShareStatus(dateStr) {
    if (!window.currentUser || !window.sharedPhotos) return null;
    
    // window.sharedPhotos에서 해당 날짜의 일간보기 공유 찾기
    const dailyShare = window.sharedPhotos.find(photo => 
        photo.type === 'daily' && photo.date === dateStr
    );
    
    return dailyShare || null;
}

// 일간보기 공유 버튼 업데이트 함수
function updateDailyShareButton(dateStr) {
    // 해당 날짜 섹션 찾기
    const dateSection = document.getElementById(`date-${dateStr}`);
    if (!dateSection) return;
    
    // 날짜 헤더 찾기
    const dateHeader = dateSection.querySelector('.date-section-header');
    if (!dateHeader) return;
    
    // 공유 상태 확인
    const dailyShare = window.sharedPhotos && Array.isArray(window.sharedPhotos) 
        ? window.sharedPhotos.find(photo => photo.type === 'daily' && photo.date === dateStr)
        : null;
    const isShared = !!dailyShare;
    
    // 기존 공유 버튼 찾기
    const existingButton = dateHeader.querySelector('button[onclick*="shareDailySummary"]');
    
    if (existingButton) {
        // 기존 버튼 업데이트
        existingButton.innerHTML = `<i class="fa-solid fa-share text-[10px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}`;
        existingButton.className = `text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-emerald-600 text-white' : 'text-emerald-600'}`;
    } else {
        // 버튼이 없으면 새로 추가 (일간보기 모드일 때만)
        if (appState.viewMode === 'page') {
            const shareButton = document.createElement('button');
            shareButton.onclick = () => window.shareDailySummary(dateStr);
            shareButton.className = `text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-emerald-600 text-white' : 'text-emerald-600'}`;
            shareButton.innerHTML = `<i class="fa-solid fa-share text-[10px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}`;
            dateHeader.appendChild(shareButton);
        }
    }
}

// 일간보기 공유 함수 (토글 방식)
window.shareDailySummary = async (dateStr) => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        // 공유 상태 확인
        const existingShare = await checkDailyShareStatus(dateStr);
        
        if (existingShare) {
            // 이미 공유된 경우: 공유 취소
            await dbOps.unsharePhotos([existingShare.photoUrl], null, false);
            
            // window.sharedPhotos에서 즉시 제거
            if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                window.sharedPhotos = window.sharedPhotos.filter(photo => 
                    !(photo.type === 'daily' && photo.date === dateStr)
                );
            }
            
            showToast('공유가 취소되었습니다.', 'success');
            
            // 해당 날짜 섹션의 공유 버튼만 업데이트
            updateDailyShareButton(dateStr);
            
            // 갤러리 새로고침
            if (appState.currentTab === 'gallery') {
                renderGallery();
            }
            return;
        }
        
        // 공유되지 않은 경우: 공유하기
        // 컴팩트 카드 생성
        const shareCard = createDailyShareCard(dateStr);
        
        // html2canvas로 캡쳐
        const canvas = await html2canvas(shareCard, {
            backgroundColor: '#ffffff',
            scale: 2,
            logging: false,
            useCORS: true,
            width: 400,
            height: shareCard.scrollHeight
        });
        
        // Canvas를 base64로 변환
        const base64Image = canvas.toDataURL('image/png');
        
        // Firebase Storage에 업로드
        const { uploadBase64ToStorage } = await import('./utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, window.currentUser.uid, `daily_${dateStr}`);
        
        // 공유 데이터 생성
        const userProfile = window.userSettings?.profile || {};
        const dailyShareData = {
            photoUrl: photoUrl,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            type: 'daily',
            date: dateStr,
            timestamp: new Date().toISOString(),
            entryId: null
        };
        
        // Firestore에 저장
        const { collection, addDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const { db, appId } = await import('./firebase.js');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
        await addDoc(sharedColl, dailyShareData);
        
        // window.sharedPhotos에 즉시 추가
        if (!window.sharedPhotos || !Array.isArray(window.sharedPhotos)) {
            window.sharedPhotos = [];
        }
        window.sharedPhotos.push(dailyShareData);
        
        // 컨테이너 제거
        shareCard.remove();
        
        showToast('하루 기록이 피드에 공유되었습니다!', 'success');
        
        // 해당 날짜 섹션의 공유 버튼만 업데이트
        updateDailyShareButton(dateStr);
        
        // 갤러리 새로고침
        if (appState.currentTab === 'gallery') {
            renderGallery();
        }
        
    } catch (e) {
        console.error('일간보기 공유 실패:', e);
        showToast('공유 중 오류가 발생했습니다.', 'error');
        
        // 컨테이너 제거
        const shareCard = document.getElementById('dailyShareCardContainer');
        if (shareCard) shareCard.remove();
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 일간보기 하루 전체 Comment 저장 함수
window.saveDailyComment = async (date) => {
    const input = document.getElementById('dailyCommentInput');
    if (!input) return;
    
    const comment = input.value || '';
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        await dbOps.saveDailyComment(date, comment);
        showToast("하루 전체 Comment가 저장되었습니다.", 'success');
    } catch (e) {
        console.error("Daily Comment Save Error:", e);
        showToast("저장 중 오류가 발생했습니다.", 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 피드 관련 함수들은 아래에서 정의되지만, 여기서도 확인
// (함수들이 정의되기 전에 renderFeed가 호출될 수 있으므로)

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
        // 갤러리 탭으로 전환 시 맨 위로 스크롤
        setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
    } else {
        // 타임라인 탭으로 전환 시 오늘 날짜로 초기화
        if (appState.viewMode === 'list') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            appState.pageDate = today;
        }
        window.loadedDates = [];
        window.hasScrolledToToday = false; // 스크롤 플래그 리셋
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
    window.hasScrolledToToday = false; // 스크롤 플래그 리셋
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

// 더보기 함수 (타임라인용)
window.loadMoreMealsTimeline = async () => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        const count = await loadMoreMeals(1); // 1개월 더 로드
        if (count > 0) {
            window.loadedDates = [];
            const container = document.getElementById('timelineContainer');
            if (container) container.innerHTML = "";
            renderTimeline();
            renderMiniCalendar();
            showToast(`${count}개의 기록을 불러왔습니다.`, 'success');
        } else {
            showToast("더 이상 불러올 기록이 없습니다.", 'info');
            // 더보기 버튼 제거
            const loadMoreBtn = document.getElementById('loadMoreMealsBtn');
            if (loadMoreBtn) loadMoreBtn.remove();
        }
    } catch (e) {
        console.error("더보기 로드 실패:", e);
        showToast("기록을 불러오는 중 오류가 발생했습니다.", 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 인증 상태 변경 리스너
initAuth((user) => {
    if (user) { 
        window.currentUser = user; 
        const { settingsUnsubscribe, dataUnsubscribe } = setupListeners(user.uid, {
            onSettingsUpdate: () => {
                updateHeaderUI();
                // 설정이 업데이트되면 간식 타입 칩도 다시 렌더링 (모달이 열려있지 않을 때만)
                const entryModal = document.getElementById('entryModal');
                if (!entryModal || entryModal.classList.contains('hidden')) {
                    renderEntryChips();
                }
            },
            onDataUpdate: () => {
                // 오늘 날짜로 초기화
                if (appState.viewMode === 'list') {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    appState.pageDate = today;
                }
                window.loadedDates = [];
                window.hasScrolledToToday = false; // 스크롤 플래그 리셋
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
            // 피드 탭이 있으면 renderFeed도 호출
            const feedContent = document.getElementById('feedContent');
            if (feedContent && !feedContent.classList.contains('hidden')) {
                renderFeed();
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
let scrollTimeout;
window.addEventListener('scroll', () => { 
    const state = appState;
    if (state.viewMode === 'list' && window.currentUser && 
        (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 400) {
        // 디바운싱: 연속 호출 방지
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            renderTimeline();
        }, 100);
    }
});

// 키보드 이벤트 리스너 (주간/월간 모드에서 좌우 방향키로 이동)
window.addEventListener('keydown', (e) => {
    // input, textarea, select 등이 포커스되어 있으면 키보드 이벤트 무시
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }
    
    const state = appState;
    
    // 대시보드 탭이 활성화되어 있고 주간/월간 모드일 때만 동작
    if (state.currentTab === 'dashboard') {
        if (state.dashboardMode === 'week') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                changeWeek(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                changeWeek(1);
            }
        } else if (state.dashboardMode === 'month') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                changeMonth(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                changeMonth(1);
            }
        } else if (state.dashboardMode === 'year') {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                navigatePeriod(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                navigatePeriod(1);
            }
        }
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

// 피드 옵션 관련 함수
window.showFeedOptions = (entryId, photoUrls, isBestShare = false, photoDate = '', photoSlotId = '') => {
    // 옵션 메뉴 표시
    const existingMenu = document.getElementById('feedOptionsMenu');
    if (existingMenu) {
        existingMenu.remove();
    }
    
    const menu = document.createElement('div');
    menu.id = 'feedOptionsMenu';
    menu.className = 'fixed inset-0 z-[450]';
    
    // entryId가 있는지 확인 (빈 문자열, null, 'null', 'undefined' 문자열 모두 체크)
    // 베스트 공유가 아닌 경우에는 entryId가 없어도 수정 가능 (Comment가 있는 경우 등)
    const hasEntryId = entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined';
    
    // 피드에서는 항상 게시 취소로 표시 (기록 삭제가 아닌 공유 취소)
    const deleteButtonText = '게시 취소';
    const deleteButtonIcon = 'fa-share';
    
    // 배경 클릭 시 닫기
    const bg = document.createElement('div');
    bg.className = 'fixed inset-0 bg-black/40';
    bg.onclick = () => menu.remove();
    
    // 메뉴 컨테이너
    const menuContainer = document.createElement('div');
    menuContainer.className = 'fixed bottom-0 left-0 right-0 w-full bg-white rounded-t-3xl p-4 pb-8 animate-fade-up z-[451]';
    
    // 핸들바
    const handlebar = document.createElement('div');
    handlebar.className = 'w-12 h-1 bg-slate-300 rounded-full mx-auto mb-4';
    
    // 버튼 컨테이너
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'space-y-2';
    
    // 수정하기 버튼 (베스트 공유가 아닌 경우에만 표시)
    // entryId가 있으면 수정 가능, entryId가 없어도 Comment 등 정보가 있으면 수정 가능
    // 베스트 공유는 별도 처리가 필요하므로 수정 옵션에서 제외
    if (!isBestShare) {
        const editBtn = document.createElement('button');
        editBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        editBtn.type = 'button';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => {
                // entryId가 있으면 editFeedPost 호출, 없으면 날짜와 slotId로 모달 열기
                if (entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined') {
                    window.editFeedPost(entryId);
                } else if (photoDate && photoSlotId) {
                    // entryId가 없어도 날짜와 slotId가 있으면 모달 열기 (새로 등록하는 것처럼 열기)
                    window.openModal(photoDate, photoSlotId, null);
                } else {
                    showToast("수정할 기록을 찾을 수 없습니다.", 'error');
                }
            }, 100);
        });
        editBtn.innerHTML = `
            <div class="flex items-center gap-3">
                <i class="fa-solid fa-pencil text-emerald-600 text-lg"></i>
                <span class="font-bold text-slate-800">수정하기</span>
            </div>
        `;
        buttonContainer.appendChild(editBtn);
    }
    
    // 삭제하기/게시 취소 버튼
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
    deleteBtn.type = 'button';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        setTimeout(() => {
            window.deleteFeedPost(entryId || '', photoUrls || '', isBestShare);
        }, 100);
    });
    deleteBtn.innerHTML = `
        <div class="flex items-center gap-3">
            <i class="fa-solid ${deleteButtonIcon} text-red-500 text-lg"></i>
            <span class="font-bold text-red-500">${deleteButtonText}</span>
        </div>
    `;
    buttonContainer.appendChild(deleteBtn);
    
    // 취소 버튼
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
    });
    cancelBtn.innerHTML = `
        <div class="flex items-center gap-3">
            <i class="fa-solid fa-xmark text-slate-400 text-lg"></i>
            <span class="font-bold text-slate-400">취소</span>
        </div>
    `;
    buttonContainer.appendChild(cancelBtn);
    
    // 메뉴 컨테이너 클릭 시 이벤트 전파 방지
    menuContainer.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    menuContainer.appendChild(handlebar);
    menuContainer.appendChild(buttonContainer);
    menu.appendChild(bg);
    menu.appendChild(menuContainer);
    document.body.appendChild(menu);
};

window.editFeedPost = (entryId) => {
    if (!entryId || entryId === '' || entryId === 'null') {
        showToast("이 게시물은 수정할 수 없습니다.", 'error');
        return;
    }
    
    if (!window.mealHistory) {
        showToast("기록 정보를 불러올 수 없습니다.", 'error');
        return;
    }
    
    const record = window.mealHistory.find(m => m.id === entryId);
    if (!record) {
        showToast("기록을 찾을 수 없습니다.", 'error');
        return;
    }
    
    // 해당 기록의 모달 열기
    openModal(record.date, record.slotId, entryId);
};

window.deleteFeedPost = async (entryId, photoUrls, isBestShare = false) => {
    // 피드에서는 항상 게시 취소
    if (!confirm("정말 게시를 취소하시겠습니까?")) {
        return;
    }
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        // 공유된 사진 삭제
        const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
        if (photoUrlArray.length > 0) {
            const validEntryId = (entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined') ? entryId : null;
            
            // photoUrl 정규화 (쿼리 파라미터 제거하여 비교)
            const normalizeUrl = (url) => (url || '').split('?')[0];
            const normalizedPhotoUrls = photoUrlArray.map(normalizeUrl);
            
            await dbOps.unsharePhotos(photoUrlArray, validEntryId, isBestShare);
            
            // window.sharedPhotos에서 삭제된 사진들 즉시 제거 (URL 정규화하여 비교)
            if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                window.sharedPhotos = window.sharedPhotos.filter(photo => {
                    const photoUrlNormalized = normalizeUrl(photo.photoUrl);
                    const isMatched = normalizedPhotoUrls.some(normalizedUrl => 
                        normalizedUrl === photoUrlNormalized || photo.photoUrl === normalizedUrl
                    );
                    
                    if (!isMatched) return true;
                    
                    // 베스트 공유인 경우 type='best'인 것만 제거
                    if (isBestShare) {
                        return !(photo.type === 'best');
                    } else {
                        // 일반 공유인 경우: entryId 조건 확인
                        if (validEntryId) {
                            // entryId가 제공된 경우: entryId가 일치하거나 photo의 entryId가 없으면 제거
                            return !(photo.entryId === validEntryId || !photo.entryId || photo.entryId === null);
                        } else {
                            // entryId가 없으면 photoUrl만 일치하면 제거
                            return false;
                        }
                    }
                });
            }
        }
        
        // 게시 취소 시 mealHistory의 sharedPhotos 필드 업데이트 (기록은 삭제하지 않음)
        if (entryId && entryId !== '' && entryId !== 'null' && window.mealHistory) {
            const record = window.mealHistory.find(m => m.id === entryId);
            if (record) {
                // sharedPhotos 필드에서 해당 사진들 제거 (유연한 URL 매칭)
                if (record.sharedPhotos && Array.isArray(record.sharedPhotos)) {
                    record.sharedPhotos = record.sharedPhotos.filter(url => {
                        // 정확히 일치하는 경우 제외
                        if (photoUrlArray.includes(url)) return false;
                        // URL의 파일명 부분만 비교 (쿼리 파라미터 제거)
                        const urlBase = url.split('?')[0];
                        const urlFileName = urlBase.split('/').pop();
                        return !photoUrlArray.some(photoUrl => {
                            const photoUrlBase = photoUrl.split('?')[0];
                            const photoUrlFileName = photoUrlBase.split('/').pop();
                            return urlFileName === photoUrlFileName && urlFileName !== '';
                        });
                    });
                    // sharedPhotos가 비어있으면 빈 배열로 설정
                    if (record.sharedPhotos.length === 0) {
                        record.sharedPhotos = [];
                    }
                    // 데이터베이스에 업데이트 (토스트 표시하지 않음 - 게시 취소 토스트만 표시)
                    try {
                        await dbOps.save(record, true); // silent = true
                    } catch (e) {
                        console.error("sharedPhotos 필드 업데이트 실패:", e);
                    }
                }
            }
        }
        
        // 게시 취소 성공 토스트 표시 (한 번만)
        // sharedPhotos 리스너가 업데이트를 트리거할 수 있으므로 여기서만 토스트 표시
        if (!window._feedPostDeleteInProgress) {
            window._feedPostDeleteInProgress = true;
            showToast("게시가 취소되었습니다.", 'success');
            setTimeout(() => {
                window._feedPostDeleteInProgress = false;
            }, 1000);
        }
        
        // 타임라인과 갤러리 즉시 다시 렌더링
        if (appState.currentTab === 'timeline') {
            // 타임라인을 완전히 다시 렌더링하기 위해 loadedDates 초기화 및 컨테이너 비우기
            const timelineContainer = document.getElementById('timelineContainer');
            if (timelineContainer) {
                timelineContainer.innerHTML = '';
            }
            window.loadedDates = [];
            renderTimeline();
            renderMiniCalendar();
        }
        // 갤러리(피드) 항상 렌더링하여 피드 업데이트
        renderGallery();
        
        // 피드 탭이 있으면 renderFeed도 호출
        const feedContent = document.getElementById('feedContent');
        if (feedContent && !feedContent.classList.contains('hidden')) {
            renderFeed();
        }
        
        // 대시보드가 열려있으면 업데이트 (베스트 탭 포함)
        if (appState.currentTab === 'dashboard') {
            updateDashboard();
            // 베스트 목록도 새로고침하여 공유 상태 업데이트
            const { renderBestMeals } = await import('./analytics.js');
            renderBestMeals();
        }
        
        // sharedPhotos 리스너가 업데이트될 때까지 대기 후 한 번 더 렌더링 (확실하게)
        setTimeout(() => {
            renderGallery();
            if (feedContent && !feedContent.classList.contains('hidden')) {
                renderFeed();
            }
        }, 800);
    } catch (e) {
        console.error("게시 취소 실패:", e);
        showToast("게시 취소 중 오류가 발생했습니다.", 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
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
