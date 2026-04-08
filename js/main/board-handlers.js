/**
 * main.js에서 분리한 청크 공통 import (register* 함수 내부에서 사용)
 */
import { appState, getState } from '../state.js';
import { auth, db, appId } from '../firebase.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
    dbOps,
    setupListeners,
    loadSharedPhotosPage,
    loadMyShares,
    loadMoreMeals,
    loadMealsForDateRange,
    postInteractions,
    subscribeToMyPostComments,
    boardOperations,
    feedOperations,
    noticeOperations,
    submitReport,
    getUserReportForPost,
    withdrawReport
} from '../db.js';
import { callableFunctions } from '../firebase.js';
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    collection,
    query,
    where,
    limit,
    orderBy,
    getDocs,
    getDocsFromServer
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import { switchScreen, showToast, updateHeaderUI, showLoading, hideLoading } from '../ui.js';
import {
    getDisplayProfile,
    getProfileAvatarDisplay,
    uploadBoardImages,
    uploadFeedImages,
    captureWithGhostStrategy,
    addCompositionAwareInput,
    warmUpIME,
    sharePhotosToExternal,
    setupBirthdateInputFormatting
} from '../utils.js';
import {
    initAuth,
    handleGoogleLogin,
    startGuest,
    openEmailModal,
    closeEmailModal,
    setEmailAuthMode,
    toggleEmailAuthMode,
    handleEmailAuth,
    requestPasswordReset,
    confirmLogout,
    confirmLogoutAction,
    copyDomain,
    closeDomainModal,
    switchToLogin,
    showTermsModal,
    closeTermsModal,
    cancelTermsAgreement,
    confirmTermsAgreement,
    showTermsDetail,
    updateTermsAgreeButton,
    selectSetupIcon,
    confirmProfileSetup,
    handleEmailSignupWithProfile,
    continueAsGuestFromProfileSetup,
    setProfileType,
    handleSetupPhotoUpload,
    confirmDeleteAccount,
    cancelDeleteAccount,
    confirmDeleteAccountAction
} from '../auth.js';
import { authFlowManager } from '../auth-flow.js';
import {
    isDemoUser,
    markUserHasRealLogin,
    DEMO_TOAST_CANNOT_LIKE,
    DEMO_TOAST_CANNOT_BOOKMARK
} from '../demo-account.js';
import { syncDemoNavGuideDots } from '../demo-nav-guide.js';
import { initFeedBubbleContextMenu } from './feed-bubble-menu.js';
import {
    renderTimeline,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    renderGallery,
    renderFeed,
    renderEntryChips,
    toggleComment,
    toggleFeedComment,
    createDailyShareCard,
    renderBoard,
    renderBoardFeedTab,
    buildPendingFeedMessage,
    applyOptimisticFeedPost,
    removePendingFeedPosts,
    syncBoardFeedComposerVisibility,
    renderBoardDetail,
    renderNoticeDetail,
    escapeHtml,
    sanitizeFormattedText,
    stripDangerousTagsOnly,
    filterGalleryByUser,
    clearGalleryFilter,
    switchGalleryFilterTab,
    fetchUserProfiles
} from '../render/index.js';
import {
    updateDashboard,
    setDashboardMode,
    updateCustomDates,
    syncCustomDatePlaceholder,
    updateSelectedMonth,
    updateSelectedWeek,
    changeWeek,
    changeMonth,
    navigatePeriod,
    openDetailModal,
    closeDetailModal,
    setAnalysisType,
    openShareBestModal,
    closeShareBestModal,
    shareBestToFeed,
    closeBestSharePeriodNotice,
    openCharacterSelectModal,
    closeCharacterSelectModal,
    selectInsightCharacter,
    generateInsightComment,
    openShareInsightModal,
    closeShareInsightModal,
    shareInsightToFeed,
    openEditInsightShareModal
} from '../analytics.js';
import { openEditBestShareModal } from '../analytics/best-share.js';
import {
    openModal,
    closeModal,
    saveEntry,
    deleteEntry,
    setRating,
    setSatiety,
    selectTag,
    handleMultipleImages,
    removePhoto,
    updateShareIndicator,
    toggleSharePhoto,
    openSettings,
    closeSettings,
    switchSettingsTab,
    saveSettings,
    saveProfileSettings,
    selectIcon,
    setSettingsProfileType,
    handlePhotoUpload,
    addTag,
    removeTag,
    deleteSubTag,
    addFavoriteTag,
    removeFavoriteTag,
    selectFavoriteMainTag,
    setRecordPhotoAspectRatio,
    openKakaoPlaceSearch,
    searchKakaoPlaces,
    selectKakaoPlace
} from '../modals.js';
import { DEFAULT_SUB_TAGS, REPORT_REASONS, SATIETY_DATA } from '../constants.js';
import { normalizeUrl } from '../utils.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';

export function registerMainBoardHandlers() {

window.switchBoardListSubTab = (sub) => {
    const next = sub === 'board' ? 'board' : 'feed';
    if (appState.boardListSubTab === next) {
        try {
            if (next === 'feed' && typeof window.markBoardFeedSubtabSeen === 'function') {
                window.markBoardFeedSubtabSeen();
            } else if (next === 'board' && typeof window.markBoardBoardSubtabSeen === 'function') {
                window.markBoardBoardSubtabSeen();
            }
        } catch (_) {}
        return;
    }
    appState.boardListSubTab = next;
    renderBoard(window.currentBoardCategory || 'all');
    try {
        if (next === 'feed' && typeof window.markBoardFeedSubtabSeen === 'function') {
            window.markBoardFeedSubtabSeen();
        } else if (next === 'board' && typeof window.markBoardBoardSubtabSeen === 'function') {
            window.markBoardBoardSubtabSeen();
        }
    } catch (_) {}
    if (typeof window.__resetBoardPanelScrollNav === 'function') window.__resetBoardPanelScrollNav();
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
    
    // 사진 미리보기 초기화
    if (window.boardWriteObjectUrls?.length) {
        window.boardWriteObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    window.boardWriteFiles = [];
    window.boardWriteExistingUrls = [];
    window.boardWriteObjectUrls = [];
    const boardWriteImagesEl = document.getElementById('boardWriteImages');
    if (boardWriteImagesEl) boardWriteImagesEl.value = '';
    if (typeof window.renderBoardWritePreviews === 'function') window.renderBoardWritePreviews();
    
    // 입력 필드 초기화
    document.getElementById('boardWriteTitle').value = '';
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    if (boardWriteContentEl) {
        boardWriteContentEl.innerHTML = '';
        boardWriteContentEl.classList.add('format-editor-empty');
    }
    document.getElementById('boardWriteCategory').value = 'serious';
    if (typeof window.setBoardWriteCategory === 'function') {
        window.setBoardWriteCategory('serious');
    }

    const prefill = window._boardWritePrefill;
    const openPhotos = window._boardWriteOpenPhotos;
    window._boardWritePrefill = null;
    window._boardWriteOpenPhotos = false;
    if (prefill?.body && boardWriteContentEl) {
        const raw = String(prefill.body).trim();
        if (raw) {
            boardWriteContentEl.innerHTML = escapeHtml(raw).replace(/\n/g, '<br>');
            boardWriteContentEl.classList.remove('format-editor-empty');
            const titleInput = document.getElementById('boardWriteTitle');
            if (titleInput) {
                const firstLine = raw.split(/\n/).map((s) => s.trim()).find(Boolean) || raw;
                titleInput.value = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
            }
            if (prefill.category && typeof window.setBoardWriteCategory === 'function') {
                window.setBoardWriteCategory(prefill.category);
            }
        }
    }
    
    // 제목 및 버튼 초기화
    const titleEl = document.querySelector('#boardWriteView h2');
    if (titleEl) titleEl.textContent = '글쓰기';
    const submitBtn = boardWriteView?.querySelector('#boardWriteSubmitBtn');
    if (submitBtn) submitBtn.textContent = '등록';
    
    if (openPhotos) {
        setTimeout(() => {
            document.getElementById('boardWriteAddPhotosBtn')?.click();
        }, 50);
    }

    syncBoardFeedComposerVisibility();

    // 스크롤 맨 위로
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.backToBoardList = (optimisticPost = null, options = null) => {
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    const tracePanel = document.getElementById('galleryTraceFilterPanel');

    if (appState.boardDetailOpenedFromGallery) {
        appState.boardDetailOpenedFromGallery = false;
        if (boardDetailView) boardDetailView.classList.add('hidden');
        const galleryView = document.getElementById('galleryView');
        if (galleryView) galleryView.classList.remove('hidden');
        window.currentBoardPostId = null;
        window.currentBoardNoticeId = null;
        if (appState.currentTab === 'gallery' && appState.galleryFilterUserId) {
            const mainHeader = document.querySelector('#mainApp > header');
            if (mainHeader) mainHeader.classList.add('hidden');
        }
        if (typeof window.renderGallery === 'function') window.renderGallery();
        return;
    }
    
    if (boardListView) boardListView.classList.remove('hidden');
    if (boardDetailView) boardDetailView.classList.add('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    if (tracePanel && appState.currentTab === 'board' && appState.boardListSubTab !== 'feed') {
        tracePanel.classList.remove('hidden');
    }
    
    window.currentBoardPostId = null;
    window.currentEditingPostId = null;
    
    // 작성 뷰 제목 및 버튼 초기화
    const titleEl = document.querySelector('#boardWriteView h2');
    if (titleEl) titleEl.textContent = '글쓰기';
    const submitBtn = boardWriteView?.querySelector('#boardWriteSubmitBtn');
    if (submitBtn) submitBtn.textContent = '등록';

    if (optimisticPost || options?.excludePostId) {
        appState.boardListSubTab = 'board';
    }

    const category = window.currentBoardCategory || 'all';
    renderBoard(category, optimisticPost, options);
    
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
};

// 밀톡 작성: 사진 미리보기 렌더 (기존 URL + 새 파일)
window.renderBoardWritePreviews = () => {
    const container = document.getElementById('boardWriteImagePreviews');
    if (!container) return;
    const existing = window.boardWriteExistingUrls || [];
    const files = window.boardWriteFiles || [];
    container.innerHTML = '';
    existing.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${url}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="url" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', () => {
            window.boardWriteExistingUrls.splice(i, 1);
            window.renderBoardWritePreviews();
        });
        container.appendChild(wrap);
    });
    files.forEach((file, i) => {
        const objectUrl = window.boardWriteObjectUrls && window.boardWriteObjectUrls[i];
        if (!objectUrl) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${objectUrl}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="file" data-index="${i}" aria-label="삭제">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', () => {
            if (window.boardWriteObjectUrls && window.boardWriteObjectUrls[i]) {
                try { URL.revokeObjectURL(window.boardWriteObjectUrls[i]); } catch (_) {}
                window.boardWriteObjectUrls.splice(i, 1);
            }
            window.boardWriteFiles.splice(i, 1);
            window.renderBoardWritePreviews();
        });
        container.appendChild(wrap);
    });
};

// 밀톡 작성: 미리보기에서 항목 제거 (버튼용 래퍼는 위에서 직접 바인딩)
window.removeBoardWritePreview = (type, index) => {
    if (type === 'url') (window.boardWriteExistingUrls || []).splice(index, 1);
    else if (type === 'file') {
        if (window.boardWriteObjectUrls && window.boardWriteObjectUrls[index]) {
            try { URL.revokeObjectURL(window.boardWriteObjectUrls[index]); } catch (_) {}
            window.boardWriteObjectUrls.splice(index, 1);
        }
        (window.boardWriteFiles || []).splice(index, 1);
    }
    window.renderBoardWritePreviews();
};

// 게시판 글쓰기 카테고리 선택 (버튼 UI)
window.setBoardWriteCategory = (category) => {
    const input = document.getElementById('boardWriteCategory');
    if (input) input.value = category;
    
    document.querySelectorAll('.board-write-category-btn').forEach(btn => {
        const value = btn.getAttribute('data-value');
        const active = value === category;
        btn.classList.toggle('active', active);
        // 기본 스타일은 css/style.css (.board-category-btn / .active)가 강제함
    });

    // 치프에게 선택 시 내용 입력 placeholder 안내 문구 변경
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    if (boardWriteContentEl) {
        const adminPlaceholder = '치프에게 글을 쓰는 경우, 해당 글은 작성자 외의 다른 사용자에게는 보이지 않아요';
        const defaultPlaceholder = '내용을 입력하세요';
        boardWriteContentEl.setAttribute('data-placeholder', category === 'admin' ? adminPlaceholder : defaultPlaceholder);
    }
};

window.submitBoardPost = async () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 글을 작성할 수 없습니다.', 'error');
        return;
    }
    // 모바일 IME(한글 등) 조합 중인 텍스트가 반영되도록 blur 후 대기
    const boardWriteView = document.getElementById('boardWriteView');
    const active = document.activeElement;
    if (active && boardWriteView?.contains(active) && (active.matches('input, textarea') || active.isContentEditable)) {
        active.blur();
        await new Promise(r => setTimeout(r, 80));
    }
    const titleEl = document.getElementById('boardWriteTitle');
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    const title = (titleEl && titleEl.value) ? titleEl.value.trim() : '';
    const rawContent = boardWriteContentEl ? boardWriteContentEl.innerHTML : '';
    let content = sanitizeFormattedText(rawContent).trim();
    const categoryEl = document.getElementById('boardWriteCategory');
    const category = categoryEl ? categoryEl.value : '';
    if (!content && rawContent.trim()) {
        content = stripDangerousTagsOnly(rawContent).trim();
    }
    if (!content && boardWriteContentEl) {
        const plainText = (boardWriteContentEl.innerText || '').trim();
        if (plainText) content = plainText.replace(/\n/g, '<br>');
    }
    if (!title) {
        showToast("제목을 입력해주세요.", 'error');
        return;
    }
    if (!content) {
        showToast("내용을 입력해주세요.", 'error');
        return;
    }
    // 키보드는 사용자가 포커스를 옮길 때만 내림 (등록 시 강제 숨기지 않음)
    
    const listCategory = window.currentBoardCategory || 'all';
    const submitBtn = boardWriteView?.querySelector('#boardWriteSubmitBtn');
    const isEdit = !!window.currentEditingPostId;
    const restoreSubmitBtn = () => {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = isEdit ? '수정' : '등록';
        }
    };
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '등록 중...';
    }
    
    if (window.currentEditingPostId) {
        const postId = window.currentEditingPostId;
        window.currentEditingPostId = null;
        window.backToBoardList();
        const existingUrls = window.boardWriteExistingUrls || [];
        const newFiles = window.boardWriteFiles || [];
        let finalImageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            try {
                showToast('사진 업로드 중...', 'info');
                const newUrls = await uploadBoardImages(newFiles, window.currentUser.uid);
                finalImageUrls = [...existingUrls, ...newUrls];
            } catch (e) {
                console.error("[submitBoardPost] 사진 업로드 에러:", e);
                showToast(e?.message || "사진 업로드에 실패했습니다.", 'error');
                restoreSubmitBtn();
                return;
            }
        }
        boardOperations.updatePost(postId, { title, content, category, imageUrls: finalImageUrls })
            .then(() => {
                renderBoard(listCategory);
                restoreSubmitBtn();
            })
            .catch((e) => {
                console.error("[submitBoardPost] 수정 에러:", e);
                restoreSubmitBtn();
            });
        return;
    }
    
    const newFiles = window.boardWriteFiles || [];
    // 낙관적 UI: 먼저 목록에 새 글 표시한 뒤, 이미지 업로드·등록은 백그라운드에서 처리 (체감 속도 개선)
    const optimisticPost = {
        id: 'pending-' + Date.now(),
        title,
        content,
        category: category || 'serious',
        imageUrls: [], // 업로드 완료 후 서버에서 받은 글로 갱신됨
        authorId: window.currentUser.uid,
        authorNickname: window.userSettings?.profile?.nickname || '익명',
        authorPhotoUrl: window.userSettings?.profile?.photoUrl || null,
        authorIcon: window.userSettings?.profile?.icon || null,
        likes: 0,
        dislikes: 0,
        views: 0,
        comments: 0,
        timestamp: new Date().toISOString()
    };
    window.backToBoardList(optimisticPost);
    (async () => {
        let imageUrls = [];
        if (newFiles.length > 0) {
            try {
                imageUrls = await uploadBoardImages(newFiles, window.currentUser.uid);
            } catch (e) {
                console.error("[submitBoardPost] 사진 업로드 에러:", e);
                showToast(e?.message || "사진 업로드에 실패했습니다.", 'error');
                renderBoard(listCategory);
                restoreSubmitBtn();
                return;
            }
        }
        try {
            const result = await boardOperations.createPost({ title, content, category, imageUrls });
            if (result?.id) renderBoard(listCategory);
        } catch (e) {
            renderBoard(listCategory);
        } finally {
            restoreSubmitBtn();
        }
    })();
};

window.openBoardDetail = async (postId) => {
    window.currentBoardPostId = postId;
    window.currentBoardNoticeId = null;
    
    // 상세 뷰 표시
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    const galleryView = document.getElementById('galleryView');
    
    if (boardListView) boardListView.classList.add('hidden');
    if (boardDetailView) boardDetailView.classList.remove('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    if (tracePanel) tracePanel.classList.add('hidden');

    // 모먼트「사용자 프로필 → 게시판」목록에서 연 경우: 갤러리 레이어를 숨기고 본문만 전체 화면에 표시
    if (appState.currentTab === 'gallery') {
        appState.boardDetailOpenedFromGallery = true;
        if (galleryView) galleryView.classList.add('hidden');
        const mainHeader = document.querySelector('#mainApp > header');
        if (mainHeader) mainHeader.classList.remove('hidden');
    } else {
        appState.boardDetailOpenedFromGallery = false;
    }
    
    await renderBoardDetail(postId);
    syncBoardFeedComposerVisibility();

    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.openNoticeDetail = async (noticeId) => {
    window.currentBoardNoticeId = noticeId;
    window.currentBoardPostId = null;
    
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    
    if (boardListView) boardListView.classList.add('hidden');
    if (boardDetailView) boardDetailView.classList.remove('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    if (tracePanel) tracePanel.classList.add('hidden');
    
    await renderNoticeDetail(noticeId);
    syncBoardFeedComposerVisibility();

    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
};

window.setBoardCategory = (category) => {
    window.currentBoardCategory = category;
    
    // 버튼 상태 업데이트
    document.querySelectorAll('.board-category-btn').forEach(btn => {
        btn.classList.remove('active', 'bg-black', 'text-white', 'border-black');
        btn.classList.add('bg-white', 'text-slate-700', 'border', 'border-slate-200');
    });
    const activeBtn = document.getElementById(`board-category-${category}`);
    if (activeBtn) {
        activeBtn.classList.add('active', 'bg-black', 'text-white', 'border', 'border-black');
        activeBtn.classList.remove('bg-white', 'text-slate-700', 'border-slate-200');
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
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_LIKE, 'error');
        return;
    }
    
    const likeBtns = document.querySelectorAll(`.board-post-like-btn[data-post-id="${postId}"]`);
    const firstBtn = likeBtns[0];
    const likeIcon = firstBtn?.querySelector('.fa-heart');
    const likeCountEl = firstBtn?.querySelector('span.text-xs');
    const wasLiked = likeIcon?.classList.contains('fa-solid');
    
    try {
        await boardOperations.toggleLike(postId, isLike);
        likeBtns.forEach(btn => {
            const icon = btn.querySelector('.fa-heart');
            const countEl = btn.querySelector('span.text-xs');
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid', 'text-red-500', 'text-slate-800');
                icon.classList.add(wasLiked ? 'fa-regular' : 'fa-solid', 'fa-heart', wasLiked ? 'text-slate-800' : 'text-red-500');
            }
            if (countEl) {
                const current = parseInt(countEl.textContent || '0', 10);
                countEl.textContent = wasLiked ? Math.max(0, current - 1) : current + 1;
            }
        });
    } catch (e) {
        console.error("좋아요 오류:", e);
        showToast("처리 중 오류가 발생했습니다.", 'error');
    }
};

window.toggleBoardBookmark = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_BOOKMARK, 'error');
        return;
    }
    
    const bookmarkBtns = document.querySelectorAll(`.board-post-bookmark-btn[data-post-id="${postId}"]`);
    
    try {
        const result = await boardOperations.toggleBookmark(postId);
        bookmarkBtns.forEach(btn => {
            const icon = btn.querySelector('.fa-bookmark');
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid');
                icon.classList.add(result?.bookmarked ? 'fa-solid' : 'fa-regular', 'fa-bookmark');
            }
        });
    } catch (e) {
        console.error("북마크 오류:", e);
        showToast("처리 중 오류가 발생했습니다.", 'error');
    }
};

// 밀톡 게시글 점3개 메뉴 (내글: 수정/삭제, 타인글: 신고)
window.showBoardPostOptions = (postId, isAuthor) => {
    const existingMenu = document.getElementById('boardPostOptionsMenu');
    if (existingMenu) existingMenu.remove();
    
    const menu = document.createElement('div');
    menu.id = 'boardPostOptionsMenu';
    menu.className = 'fixed inset-0 z-[450]';
    
    const bg = document.createElement('div');
    bg.className = 'fixed inset-0 bg-black/40';
    bg.onclick = () => menu.remove();
    
    const menuContainer = document.createElement('div');
    menuContainer.className = 'fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white rounded-t-3xl p-4 pb-8 animate-fade-up z-[451]';
    
    const handlebar = document.createElement('div');
    handlebar.className = 'w-12 h-1 bg-slate-300 rounded-full mx-auto mb-4';
    
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'space-y-2';
    
    if (isAuthor) {
        const editBtn = document.createElement('button');
        editBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        editBtn.type = 'button';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.editBoardPost(postId), 100);
        });
        editBtn.innerHTML = '<div class="flex items-center gap-3"><i class="fa-solid fa-pencil text-emerald-600 text-lg"></i><span class="font-bold text-slate-800">수정하기</span></div>';
        buttonContainer.appendChild(editBtn);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.deleteBoardPost(postId), 100);
        });
        deleteBtn.innerHTML = '<div class="flex items-center gap-3"><i class="fa-solid fa-trash text-red-500 text-lg"></i><span class="font-bold text-red-500">삭제하기</span></div>';
        buttonContainer.appendChild(deleteBtn);
    } else {
        const reportBtn = document.createElement('button');
        reportBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        reportBtn.type = 'button';
        reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.showReportModal && window.showReportModal(`board_${postId}`), 100);
        });
        reportBtn.innerHTML = '<div class="flex items-center gap-3"><i class="fa-solid fa-flag text-amber-600 text-lg"></i><span class="font-bold text-slate-800">신고하기</span></div>';
        buttonContainer.appendChild(reportBtn);
    }
    
    menuContainer.addEventListener('click', (e) => e.stopPropagation());
    menuContainer.appendChild(handlebar);
    menuContainer.appendChild(buttonContainer);
    menu.appendChild(bg);
    menu.appendChild(menuContainer);
    document.body.appendChild(menu);
};

window.toggleNoticeLike = async (noticeId, isLike = true) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_LIKE, 'error');
        return;
    }
    
    const likeBtns = document.querySelectorAll(`.board-post-like-btn[data-notice-id="${noticeId}"]`);
    const firstBtn = likeBtns[0];
    const likeIcon = firstBtn?.querySelector('.fa-heart');
    const wasLiked = likeIcon?.classList.contains('fa-solid');
    
    try {
        await noticeOperations.toggleNoticeLike(noticeId, isLike);
        likeBtns.forEach(btn => {
            const icon = btn.querySelector('.fa-heart');
            const countEl = btn.querySelector('span.text-xs');
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid', 'text-red-500', 'text-slate-800');
                icon.classList.add(wasLiked ? 'fa-regular' : 'fa-solid', 'fa-heart', wasLiked ? 'text-slate-800' : 'text-red-500');
            }
            if (countEl) {
                const current = parseInt(countEl.textContent || '0', 10);
                countEl.textContent = wasLiked ? Math.max(0, current - 1) : current + 1;
            }
        });
    } catch (e) {
        console.error("공지 하트 오류:", e);
        showToast("처리 중 오류가 발생했습니다.", 'error');
    }
};

window.toggleNoticeBookmark = async (noticeId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_BOOKMARK, 'error');
        return;
    }
    
    const bookmarkBtns = document.querySelectorAll(`.board-post-bookmark-btn[data-notice-id="${noticeId}"]`);
    
    try {
        const result = await noticeOperations.toggleNoticeBookmark(noticeId);
        bookmarkBtns.forEach(btn => {
            const icon = btn.querySelector('.fa-bookmark');
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid');
                icon.classList.add(result?.bookmarked ? 'fa-solid' : 'fa-regular', 'fa-bookmark');
            }
        });
    } catch (e) {
        console.error("공지 북마크 오류:", e);
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
        const boardWriteContentEl = document.getElementById('boardWriteContent');
        if (boardWriteContentEl) {
            boardWriteContentEl.innerHTML = (post.content || '').replace(/\n/g, '<br>');
            boardWriteContentEl.classList.remove('format-editor-empty');
        }
        document.getElementById('boardWriteCategory').value = post.category || 'serious';
        if (typeof window.setBoardWriteCategory === 'function') {
            window.setBoardWriteCategory(post.category || 'serious');
        }
        // 기존 사진 미리보기
        window.boardWriteExistingUrls = Array.isArray(post.imageUrls) ? [...post.imageUrls] : [];
        window.boardWriteFiles = [];
        if (window.boardWriteObjectUrls?.length) {
            window.boardWriteObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
        }
        window.boardWriteObjectUrls = [];
        const boardWriteImagesInput = document.getElementById('boardWriteImages');
        if (boardWriteImagesInput) boardWriteImagesInput.value = '';
        if (typeof window.renderBoardWritePreviews === 'function') window.renderBoardWritePreviews();
        
        // 수정 모드 표시를 위한 플래그 저장
        window.currentEditingPostId = postId;
        
        // 제목 변경
        const titleEl = document.querySelector('#boardWriteView h2');
        if (titleEl) titleEl.textContent = '글 수정';
        
        // 등록 버튼 텍스트 변경
        const submitBtn = boardWriteView.querySelector('#boardWriteSubmitBtn');
        if (submitBtn) submitBtn.textContent = '수정';
        
        setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
    } catch (e) {
        console.error("게시글 수정 준비 오류:", e);
        showToast("게시글을 불러올 수 없습니다.", 'error');
    }
};

window.deleteBoardPost = (postId) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    
    window.backToBoardList(null, { excludePostId: postId });
    const category = window.currentBoardCategory || 'all';
    boardOperations.deletePost(postId).then(() => {
        if (window._boardPostsCache && Array.isArray(window._boardPostsCache)) {
            window._boardPostsCache = window._boardPostsCache.filter((p) => p.id !== postId);
        }
        renderBoard(category);
    }).catch((e) => {
        console.error("게시글 삭제 오류:", e);
        renderBoard(category);
    });
};

const _boardCommentSubmitting = {};
window.addBoardComment = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 댓글을 작성할 수 없습니다.', 'error');
        return;
    }

    const input = document.getElementById('boardCommentInput');
    if (!input) return;
    
    const content = input.value.trim();
    if (!content) {
        showToast("댓글을 입력해주세요.", 'error');
        return;
    }
    if (_boardCommentSubmitting[postId]) return;
    _boardCommentSubmitting[postId] = true;
    
    const commentsListEl = document.getElementById('boardCommentsList');
    const commentsCountEl = document.getElementById('boardCommentsCount');
    const authorNickname = (window.userSettings && window.userSettings.profile && window.userSettings.profile.nickname) || '익명';
    const tempCommentId = `temp-${Date.now()}`;
    
    // 낙관적 반영: 목록과 같은 포맷으로 바로 표시 (이전 포맷→변환 현상 제거)
    const commentDate = new Date();
    const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const rowHtml = `
        <div class="mb-1 text-sm" data-comment-id="${tempCommentId}">
            <span class="font-bold text-slate-800">${escapeHtml(authorNickname)}</span>
            <span class="text-slate-800 ml-2">${escapeHtml(content)}</span>
            <span class="text-xs text-slate-400 ml-2">${commentDateStr} ${commentTimeStr}</span>
            <button onclick="window.deleteBoardComment('${tempCommentId}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>
        </div>
    `;
    if (commentsListEl) {
        commentsListEl.insertAdjacentHTML('beforeend', rowHtml);
        const last = commentsListEl.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (commentsCountEl) {
        const n = (parseInt(commentsCountEl.textContent, 10) || 0) + 1;
        commentsCountEl.textContent = n;
    }
    input.value = '';
    
    try {
        const result = await boardOperations.addComment(postId, content);
        const realId = (result && (result.commentId ?? result.id)) || null;
        if (realId && commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-comment-id="${tempCommentId}"]`);
            if (tempRow) {
                tempRow.setAttribute('data-comment-id', realId);
                const btn = tempRow.querySelector('button[onclick*="deleteBoardComment"]');
                if (btn) btn.setAttribute('onclick', `window.deleteBoardComment('${realId}', '${postId}')`);
            }
        }
    } catch (e) {
        console.error("댓글 작성 오류:", e);
        showToast("댓글 작성에 실패했습니다.", 'error');
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-comment-id="${tempCommentId}"]`);
            if (tempRow) tempRow.remove();
        }
        if (commentsCountEl) {
            const n = Math.max(0, (parseInt(commentsCountEl.textContent, 10) || 0) - 1);
            commentsCountEl.textContent = n || '';
        }
    } finally {
        _boardCommentSubmitting[postId] = false;
    }
};

window.deleteBoardComment = async (commentId, postId) => {
    if (!confirm("댓글을 삭제하시겠습니까?")) return;
    
    const commentsListEl = document.getElementById('boardCommentsList');
    const commentsCountEl = document.getElementById('boardCommentsCount');
    const row = commentsListEl?.querySelector(`[data-comment-id="${commentId}"]`);
    const prevCount = commentsCountEl ? (parseInt(commentsCountEl.textContent, 10) || 0) : 0;
    if (row) {
        row.remove();
        if (commentsCountEl) commentsCountEl.textContent = Math.max(0, prevCount - 1);
    }
    
    try {
        await boardOperations.deleteComment(commentId, postId);
        showToast("댓글이 삭제되었습니다.", 'success');
    } catch (e) {
        console.error("댓글 삭제 오류:", e);
        showToast("댓글 삭제에 실패했습니다.", 'error');
        try {
            const comments = await boardOperations.getComments(postId);
            if (commentsListEl && commentsCountEl) {
                commentsCountEl.textContent = comments.length;
                if (comments.length > 0) {
                    commentsListEl.innerHTML = comments.map(comment => {
                        let commentDate;
                        if (!comment.timestamp) commentDate = new Date();
                        else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') commentDate = comment.timestamp.toDate();
                        else if (typeof comment.timestamp === 'string') commentDate = new Date(comment.timestamp);
                        else if (comment.timestamp instanceof Date) commentDate = comment.timestamp;
                        else commentDate = new Date(comment.timestamp || 0);
                        if (isNaN(commentDate.getTime())) commentDate = new Date();
                        const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                        const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                        const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                        const commentDisplay = getDisplayProfile(comment.authorId, { nickname: comment.authorNickname || comment.anonymousId });
                        const commentBody = comment.content ?? comment.text ?? '';
                        return `<div class="mb-1 text-sm" data-comment-id="${comment.id}"><span class="font-bold text-slate-800">${escapeHtml(commentDisplay.nickname)}</span><span class="text-slate-800 ml-2">${escapeHtml(commentBody)}</span><span class="text-xs text-slate-400 ml-2">${commentDateStr} ${commentTimeStr}</span>${isCommentAuthor ? `<button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}</div>`;
                    }).join('');
                } else {
                    commentsListEl.innerHTML = '';
                }
            }
        } catch (err) {
            console.error("댓글 목록 새로고침 오류:", err);
        }
    }
};

const boardSubtabFeed = document.getElementById('boardSubtabFeed');
const boardSubtabBoard = document.getElementById('boardSubtabBoard');
if (boardSubtabFeed) {
    boardSubtabFeed.addEventListener('click', () => window.switchBoardListSubTab('feed'));
}
if (boardSubtabBoard) {
    boardSubtabBoard.addEventListener('click', () => window.switchBoardListSubTab('board'));
}

const BOARD_SCROLLBAR_ACTIVE_MS = 750;
const boardPanelScrollbarHideTimers = new WeakMap();

function showBoardPanelScrollbarWhileScrolling(el) {
    if (!el) return;
    el.classList.add('board-panel-scrollbar-active');
    const t = boardPanelScrollbarHideTimers.get(el);
    if (t) clearTimeout(t);
    boardPanelScrollbarHideTimers.set(
        el,
        setTimeout(() => {
            el.classList.remove('board-panel-scrollbar-active');
            boardPanelScrollbarHideTimers.delete(el);
        }, BOARD_SCROLLBAR_ACTIVE_MS)
    );
}

(function bindBoardPanelScrollbarReveal() {
    const onScroll = (e) => showBoardPanelScrollbarWhileScrolling(e.currentTarget);
    const lounge = document.getElementById('boardLoungeScrollArea');
    if (lounge) lounge.addEventListener('scroll', onScroll, { passive: true });
})();

(function bindFeedManualRefresh() {
    const panel = document.getElementById('boardFeedPanelContent');
    if (!panel) return;
    panel.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-feed-refresh]');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        const icon = btn.querySelector('i');
        icon?.classList.add('fa-spin');
        try {
            await renderBoardFeedTab({ quietRefresh: true });
        } finally {
            icon?.classList.remove('fa-spin');
        }
    });
})();

window.syncBoardInlineComposerAvatar = () => {
    const el = document.getElementById('boardInlineComposerAvatar');
    if (!el) return;
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.textContent = '';
    if (!window.currentUser || window.currentUser.isAnonymous) {
        el.className =
            'board-inline-composer-avatar w-9 h-9 rounded-full flex-shrink-0 bg-slate-200 flex items-center justify-center text-slate-500 overflow-hidden border border-slate-200';
        el.innerHTML = '<i class="fa-solid fa-user text-xs"></i>';
        return;
    }
    const display = getDisplayProfile(window.currentUser.uid, window.userSettings?.profile);
    const av = getProfileAvatarDisplay(display);
    const baseClass =
        'board-inline-composer-avatar w-9 h-9 rounded-full flex-shrink-0 overflow-hidden border border-slate-200';
    if (av.type === 'photo') {
        el.className = `${baseClass} bg-slate-100`;
        el.style.backgroundImage = `url(${av.value})`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
    } else if (av.type === 'default') {
        el.className = `${baseClass} bg-slate-200 flex items-center justify-center text-slate-500`;
        el.innerHTML = '<i class="fa-solid fa-user text-xs"></i>';
    } else {
        el.className = `${baseClass} bg-slate-200 flex items-center justify-center text-[11px] font-bold text-slate-700`;
        el.textContent = av.value || '?';
    }
};

function clearFeedComposerPhoto() {
    if (window.feedComposerPhotoObjectUrl) {
        try {
            URL.revokeObjectURL(window.feedComposerPhotoObjectUrl);
        } catch (_) {}
        window.feedComposerPhotoObjectUrl = null;
    }
    window.feedComposerPhotoFile = null;
    const prev = document.getElementById('boardFeedComposerPhotoPreview');
    if (prev) prev.innerHTML = '';
}

function clearFeedReplyBar() {
    const bar = document.getElementById('boardInlineComposerReplyBar');
    if (bar) bar.classList.add('hidden');
    window.__feedReplyToPostId = null;
    const nickEl = document.getElementById('boardInlineComposerReplyNick');
    const snipEl = document.getElementById('boardInlineComposerReplySnippet');
    if (nickEl) nickEl.textContent = '';
    if (snipEl) {
        snipEl.textContent = '';
        snipEl.removeAttribute('title');
    }
}

function renderFeedComposerPhotoPreview() {
    const prev = document.getElementById('boardFeedComposerPhotoPreview');
    if (!prev || !window.feedComposerPhotoObjectUrl) {
        if (prev && !window.feedComposerPhotoFile) prev.innerHTML = '';
        return;
    }
    prev.innerHTML = `
        <div class="relative w-12 h-12 rounded-md overflow-hidden border border-slate-200 shrink-0">
            <img src="${window.feedComposerPhotoObjectUrl}" alt="" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-5 h-5 flex items-center justify-center bg-black/55 text-white text-[10px] rounded-bl" aria-label="사진 제거"><i class="fa-solid fa-times"></i></button>
        </div>`;
    prev.querySelector('button')?.addEventListener('click', () => {
        clearFeedComposerPhoto();
        syncBoardInlineComposerUi();
    });
}

const boardInlineInput = document.getElementById('boardInlineComposerInput');
const boardInlineSubmit = document.getElementById('boardInlineComposerSubmit');
const boardInlineCount = document.getElementById('boardInlineComposerCount');
const boardFeedPhotoInput = document.getElementById('boardFeedComposerPhotoInput');

function syncBoardInlineComposerUi() {
    const raw = boardInlineInput?.value || '';
    const len = raw.length;
    const hasPhoto = !!window.feedComposerPhotoFile;
    const hasSendableText = raw.trim().length > 0;
    if (boardInlineCount) boardInlineCount.textContent = `${len}/280`;
    if (boardInlineSubmit) boardInlineSubmit.disabled = !hasSendableText && !hasPhoto;
    if (boardInlineInput) {
        boardInlineInput.style.height = 'auto';
        const cap = Math.max(260, Math.floor(window.innerHeight * 0.5));
        boardInlineInput.style.height = `${Math.min(boardInlineInput.scrollHeight, cap)}px`;
    }
}
window.syncBoardInlineComposerUi = syncBoardInlineComposerUi;

if (boardInlineInput) {
    boardInlineInput.addEventListener('input', syncBoardInlineComposerUi);
    // Enter = 줄바꿈. Shift+Enter = 전송 (Ctrl/Cmd+Enter 도 전송)
    boardInlineInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            if (!boardInlineSubmit?.disabled) boardInlineSubmit.click();
        }
    });
}
if (boardFeedPhotoInput) {
    boardFeedPhotoInput.addEventListener('change', (e) => {
        const f = (e.target.files && e.target.files[0]) || null;
        e.target.value = '';
        clearFeedComposerPhoto();
        if (!f || !f.type.startsWith('image/')) return;
        window.feedComposerPhotoFile = f;
        window.feedComposerPhotoObjectUrl = URL.createObjectURL(f);
        renderFeedComposerPhotoPreview();
        syncBoardInlineComposerUi();
    });
}
/** 모바일: 입력 포커스 상태에서 전송 탭 시 키보드만 내려가고 click이 안 먹는 경우 방지 (게시 버튼과 동일 패턴) */
let _boardFeedSubmitTouchTs = 0;
const BOARD_FEED_TOUCH_CLICK_SUPPRESS_MS = 500;

async function runBoardInlineFeedSubmit() {
    if (!boardInlineSubmit) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        window.requestLogin?.();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('체험 계정에서는 메시지를 보낼수 없어요', 'error');
        return;
    }
    const raw = boardInlineInput?.value || '';
    const text = raw.trim();
    const photoFile = window.feedComposerPhotoFile;
    const hasPhoto = !!photoFile;
    if (!text && !hasPhoto) return;

    const replyToPostId = window.__feedReplyToPostId ? String(window.__feedReplyToPostId).trim() : '';

    const imagePreviewUrls = [];
    if (photoFile) {
        imagePreviewUrls.push(URL.createObjectURL(photoFile));
    }
    const pending = buildPendingFeedMessage({ text, imagePreviewUrls, replyToPostId });
    if (pending) applyOptimisticFeedPost(pending);

    if (boardInlineInput) boardInlineInput.value = '';
    clearFeedReplyBar();
    clearFeedComposerPhoto();
    syncBoardInlineComposerUi();

    const submitBtn = boardInlineSubmit;
    const sendIconHtml = '<i class="fa-solid fa-arrow-up text-sm"></i>';
    const prevHtml = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-sm"></i>';

    let imageUrls = [];
    if (hasPhoto) {
        try {
            imageUrls = await uploadFeedImages([photoFile], window.currentUser.uid);
        } catch (err) {
            console.error('[feed composer] upload:', err);
            removePendingFeedPosts();
            showToast(err?.message || '사진 업로드에 실패했습니다.', 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = prevHtml || sendIconHtml;
            syncBoardInlineComposerUi();
            return;
        }
    }

    try {
        const created = await feedOperations.createMessage({
            text,
            imageUrls,
            ...(replyToPostId ? { replyToPostId } : {})
        });
        await renderBoardFeedTab({ quietRefresh: true, optimisticPost: created });
    } catch (_) {
        removePendingFeedPosts();
        // createMessage에서 토스트 처리
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = sendIconHtml;
        syncBoardInlineComposerUi();
    }
}

if (boardInlineSubmit) {
    boardInlineSubmit.addEventListener(
        'touchstart',
        (e) => {
            if (boardInlineSubmit.disabled) return;
            e.preventDefault();
        },
        { passive: false }
    );
    boardInlineSubmit.addEventListener(
        'touchend',
        (e) => {
            if (boardInlineSubmit.disabled) return;
            e.preventDefault();
            e.stopPropagation();
            _boardFeedSubmitTouchTs = Date.now();
            void runBoardInlineFeedSubmit();
        },
        { passive: false }
    );
    boardInlineSubmit.addEventListener('click', (e) => {
        if (Date.now() - _boardFeedSubmitTouchTs < BOARD_FEED_TOUCH_CLICK_SUPPRESS_MS) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        void runBoardInlineFeedSubmit();
    });
}
const boardInlinePhotoBtn = document.getElementById('boardInlineComposerPhotoBtn');
if (boardInlinePhotoBtn && boardFeedPhotoInput) {
    boardInlinePhotoBtn.addEventListener('click', () => {
        if (!window.currentUser || window.currentUser.isAnonymous) {
            showToast('로그인이 필요합니다.', 'error');
            window.requestLogin?.();
            return;
        }
        boardFeedPhotoInput.click();
    });
}

document.getElementById('boardInlineComposerReplyClear')?.addEventListener('click', () => {
    clearFeedReplyBar();
    syncBoardInlineComposerUi();
});

syncBoardInlineComposerUi();

initFeedBubbleContextMenu();

}
