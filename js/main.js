// 메인 애플리케이션 로직
import { appState, getState } from './state.js';
import { auth } from './firebase.js';
import { dbOps, setupListeners, setupSharedPhotosListener, loadMoreMeals, postInteractions, boardOperations } from './db.js';
import { switchScreen, showToast, updateHeaderUI } from './ui.js';
import { 
    initAuth, handleGoogleLogin, startGuest, openEmailModal, closeEmailModal,
    setEmailAuthMode, toggleEmailAuthMode, handleEmailAuth, confirmLogout, confirmLogoutAction,
    copyDomain, closeDomainModal, switchToLogin, showTermsModal, cancelTermsAgreement, confirmTermsAgreement,
    showTermsDetail, updateTermsAgreeButton, selectSetupIcon, confirmProfileSetup
} from './auth.js';
import { renderTimeline, renderMiniCalendar, renderGallery, renderFeed, renderEntryChips, toggleComment, toggleFeedComment, createDailyShareCard, renderBoard, renderBoardDetail } from './render/index.js';
import { updateDashboard, setDashboardMode, updateCustomDates, updateSelectedMonth, updateSelectedWeek, changeWeek, changeMonth, navigatePeriod, openDetailModal, closeDetailModal, setAnalysisType, openShareBestModal, closeShareBestModal, shareBestToFeed, openCharacterSelectModal, closeCharacterSelectModal, selectInsightCharacter, generateInsightComment } from './analytics.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, setRating, setSatiety, selectTag,
    handleMultipleImages, removePhoto, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, saveSettings, saveProfileSettings, selectIcon, addTag, removeTag, deleteSubTag, addFavoriteTag, removeFavoriteTag, selectFavoriteMainTag,
    openKakaoPlaceSearch, searchKakaoPlaces, selectKakaoPlace
} from './modals.js';
import { DEFAULT_SUB_TAGS } from './constants.js';
import { onboardingPrev, onboardingNext, onboardingSkip } from './onboarding.js';
import { normalizeUrl } from './utils.js';

// 전역 객체에 함수들 할당 (HTML에서 접근 가능하도록)
window.dbOps = dbOps;
window.postInteractions = postInteractions;
window.removeDuplicateMeals = () => dbOps.removeDuplicateMeals();
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
window.showTermsModal = showTermsModal;
window.cancelTermsAgreement = cancelTermsAgreement;
window.confirmTermsAgreement = confirmTermsAgreement;
window.showTermsDetail = showTermsDetail;
window.updateTermsAgreeButton = updateTermsAgreeButton;
window.selectSetupIcon = selectSetupIcon;
window.confirmProfileSetup = confirmProfileSetup;
window.onboardingPrev = onboardingPrev;
window.onboardingNext = onboardingNext;
window.onboardingSkip = onboardingSkip;
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
window.saveProfileSettings = saveProfileSettings;
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
window.openCharacterSelectModal = openCharacterSelectModal;
window.closeCharacterSelectModal = closeCharacterSelectModal;
window.selectInsightCharacter = selectInsightCharacter;
window.generateInsightComment = generateInsightComment;
window.closeDetailModal = closeDetailModal;
window.setAnalysisType = setAnalysisType;
window.openShareBestModal = openShareBestModal;
window.closeShareBestModal = closeShareBestModal;
window.shareBestToFeed = shareBestToFeed;
window.toggleComment = toggleComment;
window.toggleFeedComment = toggleFeedComment;
window.openKakaoPlaceSearch = openKakaoPlaceSearch;
window.searchKakaoPlaces = searchKakaoPlaces;
window.selectKakaoPlace = selectKakaoPlace;
window.boardOperations = boardOperations;
window.renderBoard = renderBoard;
window.renderBoardDetail = renderBoardDetail;

// 로그인 요청 함수
window.requestLogin = () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다. 로그인해주세요.", 'info');
        // 설정 페이지를 열어서 로그인 유도
        setTimeout(() => {
            window.openSettings();
        }, 500);
    }
};

// 좋아요 토글 함수
window.toggleLike = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    try {
        const result = await postInteractions.toggleLike(postId, window.currentUser.uid);
        const likeBtn = document.querySelector(`.post-like-btn[data-post-id="${postId}"]`);
        const likeIcon = likeBtn?.querySelector('.post-like-icon');
        const likeCountEl = document.querySelector(`.post-like-count[data-post-id="${postId}"]`);
        
        if (likeBtn && likeIcon) {
            if (result.liked) {
                likeIcon.classList.remove('fa-regular', 'fa-heart');
                likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
            } else {
                likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500');
                likeIcon.classList.add('fa-regular', 'fa-heart');
            }
        }
        
        // 실제 좋아요 수 다시 가져오기
        if (likeCountEl) {
            const likes = await postInteractions.getLikes(postId);
            const likeCount = likes.length || 0;
            likeCountEl.textContent = likeCount > 0 ? likeCount : '';
        }
    } catch (e) {
        console.error("좋아요 토글 실패:", e);
        showToast("좋아요 처리 중 오류가 발생했습니다.", 'error');
    }
};

// 북마크 토글 함수
window.toggleBookmark = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    try {
        const result = await postInteractions.toggleBookmark(postId, window.currentUser.uid);
        const bookmarkBtn = document.querySelector(`.post-bookmark-btn[data-post-id="${postId}"]`);
        const bookmarkIcon = bookmarkBtn?.querySelector('.post-bookmark-icon');
        
        if (bookmarkBtn && bookmarkIcon) {
            if (result.bookmarked) {
                bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark');
                bookmarkIcon.classList.add('fa-solid', 'fa-bookmark', 'text-slate-800');
                showToast("북마크에 추가되었습니다.", 'success');
            } else {
                bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800');
                bookmarkIcon.classList.add('fa-regular', 'fa-bookmark');
                showToast("북마크에서 제거되었습니다.", 'info');
            }
        }
    } catch (e) {
        console.error("북마크 토글 실패:", e);
        showToast("북마크 처리 중 오류가 발생했습니다.", 'error');
    }
};

// 댓글 추가 함수
window.addCommentToPost = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    const inputEl = document.getElementById(`comment-input-${postId}`);
    if (!inputEl) return;
    
    const commentText = inputEl.value.trim();
    if (!commentText) return;
    
    const submitBtn = document.querySelector(`.post-comment-submit-btn[data-post-id="${postId}"]`);
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '게시 중...';
    }
    
    try {
        if (!postId || postId === 'undefined' || postId === 'null') {
            showToast("잘못된 포스트 ID입니다.", 'error');
            return;
        }
        
        const userProfile = window.userSettings?.profile || {};
        const newComment = await postInteractions.addComment(postId, window.currentUser.uid, commentText, userProfile);
        
        if (!newComment) {
            showToast("댓글 추가에 실패했습니다.", 'error');
            return;
        }
        
        // 입력 필드 초기화
        inputEl.value = '';
        
        // 약간의 지연 후 댓글 목록 다시 로드 (Firestore 인덱싱 반영 시간)
        setTimeout(async () => {
            // 댓글 개수 업데이트
            const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
            if (commentCountEl) {
                const comments = await postInteractions.getComments(postId);
                commentCountEl.textContent = comments.length > 0 ? comments.length : '';
            }
            
            // 댓글 목록에 추가
            const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
            if (commentsListEl) {
                const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
                
                // 모든 댓글 다시 로드
                const comments = await postInteractions.getComments(postId);
                
                if (comments.length > 0) {
                    commentsListEl.classList.add('bg-slate-50');
                    const displayComments = comments.slice(0, 2);
                    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                    commentsListEl.innerHTML = displayComments.map(c => `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${c.userNickname || '익명'}</span>
                            <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                            ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `).join('');
                    
                    if (comments.length > 2) {
                        if (viewCommentsBtn) {
                            viewCommentsBtn.textContent = `댓글 ${comments.length}개 모두 보기`;
                            viewCommentsBtn.classList.remove('hidden');
                        }
                    } else {
                        if (viewCommentsBtn) {
                            viewCommentsBtn.classList.add('hidden');
                        }
                    }
                } else {
                    commentsListEl.innerHTML = '';
                    commentsListEl.classList.remove('bg-slate-50');
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.add('hidden');
                    }
                }
            }
        }, 500);
        
        showToast("댓글이 추가되었습니다.", 'success');
    } catch (e) {
        console.error("댓글 추가 실패:", e);
        showToast("댓글 추가 중 오류가 발생했습니다: " + (e.message || e), 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '게시';
        }
    }
};

// 댓글 삭제 함수
window.deleteCommentFromPost = async (commentId, postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous || !commentId || !postId) {
        if (!window.currentUser || window.currentUser.isAnonymous) {
            showToast("로그인이 필요합니다.", 'error');
            window.requestLogin();
        }
        return;
    }
    
    if (!confirm("댓글을 삭제하시겠습니까?")) return;
    
    try {
        const success = await postInteractions.deleteComment(commentId, window.currentUser.uid);
        if (success) {
            // 댓글 다시 로드
            const comments = await postInteractions.getComments(postId);
            const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
            const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
            
            // 댓글 개수 업데이트
            const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
            if (commentCountEl) {
                commentCountEl.textContent = comments.length > 0 ? comments.length : '';
            }
            
            if (commentsListEl) {
                if (comments.length === 0) {
                    commentsListEl.innerHTML = '';
                    commentsListEl.classList.remove('bg-slate-50');
                    if (viewCommentsBtn) viewCommentsBtn.classList.add('hidden');
                } else {
                    commentsListEl.classList.add('bg-slate-50');
                    const displayComments = comments.slice(0, 2);
                    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                    commentsListEl.innerHTML = displayComments.map(c => `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${c.userNickname || '익명'}</span>
                            <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                            ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `).join('');
                    
                    if (comments.length > 2) {
                        if (viewCommentsBtn) {
                            viewCommentsBtn.textContent = `댓글 ${comments.length}개 모두 보기`;
                            viewCommentsBtn.classList.remove('hidden');
                        }
                    } else {
                        if (viewCommentsBtn) viewCommentsBtn.classList.add('hidden');
                    }
                }
            }
            showToast("댓글이 삭제되었습니다.", 'success');
        } else {
            showToast("댓글을 삭제할 수 없습니다.", 'error');
        }
    } catch (e) {
        console.error("댓글 삭제 실패:", e);
        showToast("댓글 삭제 중 오류가 발생했습니다.", 'error');
    }
};

// 댓글 모두 보기 함수
window.showAllComments = async (postId) => {
    try {
        const comments = await postInteractions.getComments(postId);
        const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
        const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
        
        if (commentsListEl) {
            if (comments.length > 0) {
                commentsListEl.classList.add('bg-slate-50');
                const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                commentsListEl.innerHTML = comments.map(c => `
                    <div class="mb-1 text-sm">
                        <span class="font-bold text-slate-800">${c.userNickname || '익명'}</span>
                        <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                        ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                    </div>
                `).join('');
            } else {
                commentsListEl.innerHTML = '';
                commentsListEl.classList.remove('bg-slate-50');
            }
            
            if (viewCommentsBtn) {
                viewCommentsBtn.classList.add('hidden');
            }
        }
    } catch (e) {
        console.error("댓글 로드 실패:", e);
        showToast("댓글을 불러오는 중 오류가 발생했습니다.", 'error');
    }
};

// 댓글 입력 필드 토글 (더블클릭으로 댓글 입력창 포커스)
window.toggleCommentInput = (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        window.requestLogin();
        return;
    }
    const inputEl = document.getElementById(`comment-input-${postId}`);
    if (inputEl) {
        inputEl.focus();
    }
};

// 포스트 캡션 토글 (더 보기/접기)
window.togglePostCaption = (idx) => {
    const collapsedEl = document.getElementById(`post-caption-collapsed-${idx}`);
    const expandedEl = document.getElementById(`post-caption-expanded-${idx}`);
    const toggleBtn = document.getElementById(`post-caption-toggle-${idx}`);
    const collapseBtn = document.getElementById(`post-caption-collapse-${idx}`);
    
    if (collapsedEl && expandedEl && toggleBtn && collapseBtn) {
        const isCollapsed = !collapsedEl.classList.contains('hidden');
        if (isCollapsed) {
            collapsedEl.classList.add('hidden');
            expandedEl.classList.remove('hidden');
            toggleBtn.classList.add('hidden');
            collapseBtn.classList.remove('hidden');
        } else {
            collapsedEl.classList.remove('hidden');
            expandedEl.classList.add('hidden');
            toggleBtn.classList.remove('hidden');
            collapseBtn.classList.add('hidden');
        }
    }
};

// HTML 이스케이프 헬퍼 함수 (전역으로 사용)
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 일간보기 공유 함수
window.shareDailySummary = async (dateStr) => {
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
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
        
        // 컨테이너 제거
        shareCard.remove();
        
        showToast('하루 기록이 피드에 공유되었습니다!', 'success');
        
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
    
    // 게시판 관련 뷰 관리
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    
    if (tab === 'board') {
        // 게시판 탭일 때는 목록 뷰만 표시
        if (boardListView) boardListView.classList.remove('hidden');
        if (boardDetailView) boardDetailView.classList.add('hidden');
        if (boardWriteView) boardWriteView.classList.add('hidden');
        
        // 게시글 목록 로드
        const category = window.currentBoardCategory || 'all';
        renderBoard(category);
        setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
    } else {
        // 다른 탭일 때는 게시판 뷰 모두 숨김
        if (boardListView) boardListView.classList.add('hidden');
        if (boardDetailView) boardDetailView.classList.add('hidden');
        if (boardWriteView) boardWriteView.classList.add('hidden');
    }
    
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
    document.getElementById('nav-board').className = tab === 'board' ? 
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
    } else if (tab !== 'board') {
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
// 현재 체크 중인 사용자 ID (중복 체크 방지)
let currentCheckingUserId = null;

initAuth(async (user) => {
    if (user) { 
        window.currentUser = user; 
        
        // 사용자가 변경되면 플래그 리셋
        if (currentCheckingUserId !== user.uid) {
            currentCheckingUserId = user.uid;
            window._firstLoginChecked = false;
        }
        
        // 중복 기록 자동 정리 (한 번만 실행)
        if (!window._duplicateCleanupDone && window.mealHistory && window.mealHistory.length > 0) {
            window._duplicateCleanupDone = true;
            // 약간의 지연 후 실행 (데이터 로드 완료 대기)
            setTimeout(async () => {
                await dbOps.removeDuplicateMeals();
            }, 2000);
        }
        
        // 게스트가 아니면 첫 로그인 체크를 onSettingsUpdate에서만 수행
        let shouldCheckFirstLogin = !user.isAnonymous;
        
        const { settingsUnsubscribe, dataUnsubscribe } = setupListeners(user.uid, {
            onSettingsUpdate: () => {
                updateHeaderUI();
                // 설정이 업데이트되면 간식 타입 칩도 다시 렌더링 (모달이 열려있지 않을 때만)
                const entryModal = document.getElementById('entryModal');
                if (!entryModal || entryModal.classList.contains('hidden')) {
                    renderEntryChips();
                }
                
                // 첫 로그인 체크 (게스트가 아니고 설정이 로드된 후, 현재 사용자와 일치하고 아직 체크하지 않은 경우만)
                if (shouldCheckFirstLogin && window.userSettings && window.userSettings.profile && currentCheckingUserId === user.uid && !window._firstLoginChecked) {
                    window._firstLoginChecked = true;
                    checkFirstLoginFlow(user);
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
            // 타임라인, 갤러리 모두 업데이트 (같은 데이터 소스를 사용하므로)
            if (appState.currentTab === 'timeline') {
                renderTimeline();
            }
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
        
        // 게스트인 경우 바로 메인 화면 표시
        if (!shouldCheckFirstLogin) {
            switchScreen(true);
            switchMainTab('timeline');
            document.getElementById('loadingOverlay')?.classList.add('hidden');
        }
        // 게스트가 아닌 경우 설정이 로드될 때까지 대기 (onSettingsUpdate에서 체크)
    } else {
        // 로그아웃 상태
        switchScreen(false);
        currentCheckingUserId = null;
        window._firstLoginChecked = false;
        if (appState.settingsUnsubscribe) {
            appState.settingsUnsubscribe();
            appState.settingsUnsubscribe = null;
        }
        if (appState.dataUnsubscribe) {
            appState.dataUnsubscribe();
            appState.dataUnsubscribe = null;
        }
        if (appState.sharedPhotosUnsubscribe) {
            appState.sharedPhotosUnsubscribe();
            appState.sharedPhotosUnsubscribe = null;
        }
        document.getElementById('loadingOverlay')?.classList.add('hidden');
    }
});

// 첫 로그인 플로우 체크 함수
async function checkFirstLoginFlow(user) {
    if (!window.userSettings || !window.currentUser || window.currentUser.uid !== user.uid) {
        document.getElementById('loadingOverlay')?.classList.add('hidden');
        return;
    }
    
    const termsAgreed = window.userSettings.termsAgreed === true;
    const hasProfile = window.userSettings.profile && 
                     window.userSettings.profile.nickname && 
                     window.userSettings.profile.nickname !== '게스트';
    const onboardingCompleted = window.userSettings.onboardingCompleted === true;
    
    // 약관 미동의 시 약관 동의 모달 표시
    if (!termsAgreed) {
        switchScreen(false);
        showTermsModal();
        document.getElementById('loadingOverlay')?.classList.add('hidden');
        return;
    }
    // 프로필 미설정 시 프로필 설정 모달 표시
    else if (!hasProfile) {
        switchScreen(false);
        const { showProfileSetupModal } = await import('./auth.js');
        showProfileSetupModal();
        document.getElementById('loadingOverlay')?.classList.add('hidden');
        return;
    }
    // 온보딩 미완료 시 온보딩 표시 (메인 앱 표시 후)
    else if (!onboardingCompleted) {
        switchScreen(true);
        switchMainTab('timeline');
        const { showOnboardingModal } = await import('./onboarding.js');
        showOnboardingModal();
        // switchScreen이 이미 loadingOverlay를 숨김
        return;
    }
    
    // 모든 체크 통과 - 메인 화면 표시
    switchScreen(true);
    switchMainTab('timeline');
    document.getElementById('loadingOverlay')?.classList.add('hidden');
}

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
            
            // photoUrl 정규화 (쿼리 파라미터 제거하여 비교) - utils.js의 normalizeUrl 사용
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
        
        // 대시보드가 열려있으면 업데이트
        if (appState.currentTab === 'dashboard') {
            updateDashboard();
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

// 게시판 관련 함수들
window.currentBoardCategory = 'all';
window.currentBoardPostId = null;

window.openBoardWrite = () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    // 작성 뷰 표시
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    
    if (boardListView) boardListView.classList.add('hidden');
    if (boardDetailView) boardDetailView.classList.add('hidden');
    if (boardWriteView) boardWriteView.classList.remove('hidden');
    
    // 수정 모드 초기화
    window.currentEditingPostId = null;
    
    // 입력 필드 초기화
    document.getElementById('boardWriteTitle').value = '';
    document.getElementById('boardWriteContent').value = '';
    document.getElementById('boardWriteCategory').value = 'serious';
    
    // 제목 및 버튼 초기화
    const titleEl = document.querySelector('#boardWriteView h2');
    if (titleEl) titleEl.textContent = '글쓰기';
    const submitBtn = boardWriteView?.querySelector('button[onclick="window.submitBoardPost()"]');
    if (submitBtn) submitBtn.textContent = '등록';
    
    // 스크롤 맨 위로
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.backToBoardList = () => {
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    
    if (boardListView) boardListView.classList.remove('hidden');
    if (boardDetailView) boardDetailView.classList.add('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    
    window.currentBoardPostId = null;
    window.currentEditingPostId = null;
    
    // 작성 뷰 제목 및 버튼 초기화
    const titleEl = document.querySelector('#boardWriteView h2');
    if (titleEl) titleEl.textContent = '글쓰기';
    const submitBtn = boardWriteView?.querySelector('button[onclick="window.submitBoardPost()"]');
    if (submitBtn) submitBtn.textContent = '등록';
    
    // 게시판 목록 새로고침
    const category = window.currentBoardCategory || 'all';
    renderBoard(category);
    
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.submitBoardPost = async () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    
    const title = document.getElementById('boardWriteTitle').value.trim();
    const content = document.getElementById('boardWriteContent').value.trim();
    const category = document.getElementById('boardWriteCategory').value;
    
    if (!title) {
        showToast("제목을 입력해주세요.", 'error');
        return;
    }
    if (!content) {
        showToast("내용을 입력해주세요.", 'error');
        return;
    }
    
    try {
        // 수정 모드인 경우
        if (window.currentEditingPostId) {
            await boardOperations.updatePost(window.currentEditingPostId, { title, content, category });
            window.currentEditingPostId = null;
        } else {
            // 새 게시글 작성
            await boardOperations.createPost({ title, content, category });
        }
        window.backToBoardList();
    } catch (e) {
        console.error("게시글 처리 오류:", e);
    }
};

window.openBoardDetail = async (postId) => {
    window.currentBoardPostId = postId;
    
    // 상세 뷰 표시
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    
    if (boardListView) boardListView.classList.add('hidden');
    if (boardDetailView) boardDetailView.classList.remove('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    
    await renderBoardDetail(postId);
    
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.setBoardCategory = (category) => {
    window.currentBoardCategory = category;
    
    // 버튼 상태 업데이트
    document.querySelectorAll('.board-category-btn').forEach(btn => {
        btn.classList.remove('active', 'bg-emerald-600', 'text-white');
        btn.classList.add('bg-slate-100', 'text-slate-600');
    });
    const activeBtn = document.getElementById(`board-category-${category}`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-emerald-600', 'text-white');
        activeBtn.classList.remove('bg-slate-100', 'text-slate-600');
    }
    
    // 게시글 목록 새로고침
    renderBoard(category);
};


window.toggleBoardLike = async (postId, isLike) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    try {
        await boardOperations.toggleLike(postId, isLike);
        // 게시글 상세 새로고침
        await renderBoardDetail(postId);
    } catch (e) {
        console.error("추천/비추천 오류:", e);
        showToast("처리 중 오류가 발생했습니다.", 'error');
    }
};

window.editBoardPost = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    
    try {
        const post = await boardOperations.getPost(postId);
        if (!post) {
            showToast("게시글을 찾을 수 없습니다.", 'error');
            return;
        }
        
        if (post.authorId !== window.currentUser.uid) {
            showToast("본인의 게시글만 수정할 수 있습니다.", 'error');
            return;
        }
        
        // 작성 뷰 표시 및 데이터 채우기
        const boardListView = document.getElementById('boardListView');
        const boardDetailView = document.getElementById('boardDetailView');
        const boardWriteView = document.getElementById('boardWriteView');
        
        if (boardListView) boardListView.classList.add('hidden');
        if (boardDetailView) boardDetailView.classList.add('hidden');
        if (boardWriteView) boardWriteView.classList.remove('hidden');
        
        // 입력 필드에 기존 데이터 채우기
        document.getElementById('boardWriteTitle').value = post.title || '';
        document.getElementById('boardWriteContent').value = post.content || '';
        document.getElementById('boardWriteCategory').value = post.category || 'serious';
        
        // 수정 모드 표시를 위한 플래그 저장
        window.currentEditingPostId = postId;
        
        // 제목 변경
        const titleEl = document.querySelector('#boardWriteView h2');
        if (titleEl) titleEl.textContent = '글 수정';
        
        // 등록 버튼 텍스트 변경
        const submitBtn = boardWriteView.querySelector('button[onclick="window.submitBoardPost()"]');
        if (submitBtn) submitBtn.textContent = '수정';
        
        setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
    } catch (e) {
        console.error("게시글 수정 준비 오류:", e);
        showToast("게시글을 불러올 수 없습니다.", 'error');
    }
};

window.deleteBoardPost = async (postId) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    
    try {
        await boardOperations.deletePost(postId);
        window.backToBoardList();
    } catch (e) {
        console.error("게시글 삭제 오류:", e);
    }
};

window.addBoardComment = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    const input = document.getElementById('boardCommentInput');
    if (!input) return;
    
    const content = input.value.trim();
    if (!content) {
        showToast("댓글을 입력해주세요.", 'error');
        return;
    }
    
    // 입력 필드 비활성화
    input.disabled = true;
    const submitBtn = input.nextElementSibling;
    if (submitBtn) submitBtn.disabled = true;
    
    try {
        // 사용자 닉네임 가져오기
        const authorNickname = (window.userSettings && window.userSettings.profile && window.userSettings.profile.nickname) || '익명';
        
        const commentsListEl = document.getElementById('boardCommentsList');
        const commentsCountEl = document.getElementById('boardCommentsCount');
        
        // 댓글 추가 (데이터베이스에 저장)
        await boardOperations.addComment(postId, content);
        
        input.value = '';
        
        if (commentsListEl && commentsCountEl) {
            // 현재 댓글 수 가져오기
            const currentCount = parseInt(commentsCountEl.textContent) || 0;
            const newCount = currentCount + 1;
            
            // 댓글 수 업데이트
            commentsCountEl.textContent = newCount;
            
            // 임시 댓글을 화면에 추가 (즉시 표시)
            const commentDate = new Date();
            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
            const tempCommentId = `temp-${Date.now()}`;
            
            // 댓글이 없는 경우 메시지 제거
            if (commentsListEl.innerHTML.includes('댓글이 없습니다')) {
                commentsListEl.innerHTML = '';
            }
            
            const newCommentHtml = `
                <div class="bg-white border border-slate-200 rounded-xl p-4 mb-3" data-comment-id="${tempCommentId}">
                    <div class="flex items-center justify-between mb-2">
                        <div class="flex items-center gap-2">
                            <div class="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-xs font-bold text-slate-600">${authorNickname.charAt(0)}</div>
                            <div>
                                <div class="text-xs font-bold text-slate-700">${escapeHtml(authorNickname)}</div>
                                <div class="text-[10px] text-slate-400">${commentDateStr} ${commentTimeStr}</div>
                            </div>
                        </div>
                        <button onclick="window.deleteBoardComment('${tempCommentId}', '${postId}')" class="text-xs text-red-500 font-bold px-2 py-1 rounded-lg hover:bg-red-50 active:opacity-70 transition-colors hidden">
                            삭제
                        </button>
                    </div>
                    <p class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed pl-8">${escapeHtml(content)}</p>
                </div>
            `;
            
            commentsListEl.insertAdjacentHTML('beforeend', newCommentHtml);
            
            // 새 댓글로 스크롤
            setTimeout(() => {
                const lastComment = commentsListEl.lastElementChild;
                if (lastComment) {
                    lastComment.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }, 100);
            
            // 실제 댓글 목록 다시 가져오기 (Firestore 인덱싱 반영 후)
            setTimeout(async () => {
                try {
                    const comments = await boardOperations.getComments(postId);
                    if (commentsListEl && commentsCountEl && comments.length > 0) {
                        commentsCountEl.textContent = comments.length;
                        
                        // 댓글 목록 다시 렌더링 (실제 데이터로 업데이트)
                        commentsListEl.innerHTML = comments.map(comment => {
                            const commentDate = new Date(comment.timestamp);
                            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                            const commentAuthorNickname = comment.authorNickname || comment.anonymousId || '익명';
                            
                            return `
                                <div class="bg-white border border-slate-200 rounded-xl p-4 mb-3" data-comment-id="${comment.id}">
                                    <div class="flex items-center justify-between mb-2">
                                        <div class="flex items-center gap-2">
                                            <div class="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-xs font-bold text-slate-600">${commentAuthorNickname.charAt(0)}</div>
                                            <div>
                                                <div class="text-xs font-bold text-slate-700">${escapeHtml(commentAuthorNickname)}</div>
                                                <div class="text-[10px] text-slate-400">${commentDateStr} ${commentTimeStr}</div>
                                            </div>
                                        </div>
                                        ${isCommentAuthor ? `
                                            <button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="text-xs text-red-500 font-bold px-2 py-1 rounded-lg hover:bg-red-50 active:opacity-70 transition-colors">
                                                삭제
                                            </button>
                                        ` : ''}
                                    </div>
                                    <p class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed pl-8">${escapeHtml(comment.content)}</p>
                                </div>
                            `;
                        }).join('');
                    }
                } catch (e) {
                    console.error("댓글 목록 새로고침 오류:", e);
                    // 에러가 발생해도 임시 댓글은 그대로 유지
                }
            }, 1000); // Firestore 인덱싱 반영 시간 고려
        }
        
        showToast("댓글이 등록되었습니다.", 'success');
    } catch (e) {
        console.error("댓글 작성 오류:", e);
        showToast("댓글 작성에 실패했습니다.", 'error');
    } finally {
        // 입력 필드 다시 활성화
        input.disabled = false;
        if (submitBtn) submitBtn.disabled = false;
    }
};

window.deleteBoardComment = async (commentId, postId) => {
    if (!confirm("댓글을 삭제하시겠습니까?")) return;
    
    try {
        await boardOperations.deleteComment(commentId, postId);
        showToast("댓글이 삭제되었습니다.", 'success');
        
        // 댓글 목록 다시 로드
        setTimeout(async () => {
            const comments = await boardOperations.getComments(postId);
            const commentsListEl = document.getElementById('boardCommentsList');
            const commentsCountEl = document.getElementById('boardCommentsCount');
            
            if (commentsListEl && commentsCountEl) {
                // 댓글 수 업데이트
                commentsCountEl.textContent = comments.length;
                
                // 댓글 목록 다시 렌더링
                if (comments.length > 0) {
                    commentsListEl.innerHTML = comments.map(comment => {
                        const commentDate = new Date(comment.timestamp);
                        const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                        const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                        const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                        const commentAuthorNickname = comment.authorNickname || comment.anonymousId || '익명';
                        
                        return `
                            <div class="bg-white border border-slate-200 rounded-xl p-4 mb-3" data-comment-id="${comment.id}">
                                <div class="flex items-center justify-between mb-2">
                                    <div class="flex items-center gap-2">
                                        <div class="w-6 h-6 bg-slate-100 rounded-full flex items-center justify-center text-xs font-bold text-slate-600">${commentAuthorNickname.charAt(0)}</div>
                                        <div>
                                            <div class="text-xs font-bold text-slate-700">${escapeHtml(commentAuthorNickname)}</div>
                                            <div class="text-[10px] text-slate-400">${commentDateStr} ${commentTimeStr}</div>
                                        </div>
                                    </div>
                                    ${isCommentAuthor ? `
                                        <button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="text-xs text-red-500 font-bold px-2 py-1 rounded-lg hover:bg-red-50 active:opacity-70 transition-colors">
                                            삭제
                                        </button>
                                    ` : ''}
                                </div>
                                <p class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed pl-8">${escapeHtml(comment.content)}</p>
                            </div>
                        `;
                    }).join('');
                } else {
                    commentsListEl.innerHTML = '<p class="text-sm text-slate-400 text-center py-4">댓글이 없습니다. 첫 번째 댓글을 작성해보세요!</p>';
                }
            }
        }, 300);
    } catch (e) {
        console.error("댓글 삭제 오류:", e);
        showToast("댓글 삭제에 실패했습니다.", 'error');
    }
};

// 에러 핸들링
window.addEventListener('error', (e) => {
    console.error('JavaScript 에러:', e);
    console.error('에러 파일:', e.filename);
    console.error('에러 메시지:', e.message);
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
});
