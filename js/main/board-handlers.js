/**
 * main.js에서 분리한 청크 공통 import (register* 함수 내부에서 사용)
 */
import { appState, getState } from '../state.js';
import { auth, db, appId } from '../firebase.js';
import { refreshLucideIcons } from '../icons.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
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
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
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
    setupBirthdateInputFormatting,
    SEOUL_LOCALE_OPTIONS
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
    syncBoardTracePanelVisibility,
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
    setRecordPhotoAspectRatio,
    openKakaoPlaceSearch,
    searchKakaoPlaces,
    selectKakaoPlace
} from '../modals.js';
import { DEFAULT_SUB_TAGS, REPORT_REASONS, SATIETY_DATA } from '../constants.js';
import { logUsageMetric } from '../usage-metrics.js';
import { normalizeUrl } from '../utils.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';
import { updateFeedCharRemainingUi } from '../feed-char-count.js';

export function registerMainBoardHandlers() {

window.switchBoardListSubTab = (sub) => {
    const next = sub === 'board' ? 'board' : sub === 'notice' ? 'notice' : 'feed';
    if (appState.boardListSubTab === next) {
        try {
            if (next === 'feed' && typeof window.markBoardFeedSubtabSeen === 'function') {
                window.markBoardFeedSubtabSeen();
            } else if (next === 'board' && typeof window.markBoardBoardSubtabSeen === 'function') {
                window.markBoardBoardSubtabSeen();
            } else if (next === 'notice' && typeof window.markBoardNoticeSubtabSeen === 'function') {
                window.markBoardNoticeSubtabSeen();
            }
        } catch (_) {}
        return;
    }
    appState.boardListSubTab = next;
    appState.boardSearchActive = false;
    appState.boardSearchKeyword = '';
    appState.boardSearchDateRange = null;
    appState.boardTraceFilter = null;
    if (typeof window.closeBoardSearchModal === 'function') window.closeBoardSearchModal();
    if (next === 'feed') logUsageMetric('lounge_mealtalk').catch(() => {});
    else if (next === 'board') logUsageMetric('lounge_board').catch(() => {});
    else logUsageMetric('lounge_notice').catch(() => {});
    renderBoard(window.currentBoardCategory || 'all');
    try {
        if (next === 'feed' && typeof window.markBoardFeedSubtabSeen === 'function') {
            window.markBoardFeedSubtabSeen();
        } else if (next === 'board' && typeof window.markBoardBoardSubtabSeen === 'function') {
            window.markBoardBoardSubtabSeen();
        } else if (next === 'notice' && typeof window.markBoardNoticeSubtabSeen === 'function') {
            window.markBoardNoticeSubtabSeen();
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
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    if (boardWriteContentEl) {
        boardWriteContentEl.innerHTML = '';
        boardWriteContentEl.classList.add('format-editor-empty');
    }
    document.getElementById('boardWriteCategory').value = 'chat';
    if (typeof window.setBoardWriteCategory === 'function') {
        window.setBoardWriteCategory('chat');
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
    syncBoardTracePanelVisibility();
    
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
                <i data-lucide="x"></i>
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
                <i data-lucide="x"></i>
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
    const boardWriteContentEl = document.getElementById('boardWriteContent');
    const title = '';
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
    const likeCountEl = firstBtn?.querySelector('span.text-xs');
    const wasLiked = firstBtn?.classList.contains('liked') || !!firstBtn?.querySelector('.fa-solid.fa-heart, svg[fill="currentColor"]');
    
    try {
        await boardOperations.toggleLike(postId, isLike);
        likeBtns.forEach(btn => {
            const nextLiked = !wasLiked;
            btn.classList.toggle('liked', nextLiked);
            const icon = btn.querySelector('[data-lucide="heart"], .lucide, .fa-heart, svg');
            if (icon) {
                icon.classList?.remove?.('fa-regular', 'fa-solid', 'text-red-500', 'text-slate-800');
                if (icon.tagName === 'I' && icon.hasAttribute('data-lucide')) {
                    icon.classList.toggle('text-red-500', nextLiked);
                    icon.classList.toggle('text-slate-800', !nextLiked);
                } else if (icon.tagName === 'svg') {
                    icon.style.fill = nextLiked ? 'currentColor' : 'none';
                    icon.classList.toggle('text-red-500', nextLiked);
                    icon.classList.toggle('text-slate-800', !nextLiked);
                } else {
                    icon.classList.add(nextLiked ? 'fa-solid' : 'fa-regular', 'fa-heart', nextLiked ? 'text-red-500' : 'text-slate-800');
                }
            }
            const countEl = btn.querySelector('span.text-xs');
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
            const on = !!result?.bookmarked;
            btn.classList.toggle('bookmarked', on);
            const icon = btn.querySelector('[data-lucide="bookmark"], .lucide, .fa-bookmark, svg');
            if (icon) {
                icon.classList?.remove?.('fa-regular', 'fa-solid');
                if (icon.tagName === 'svg') {
                    icon.style.fill = on ? 'currentColor' : 'none';
                } else if (icon.tagName === 'I' && icon.hasAttribute('data-lucide')) {
                    /* fill via .bookmarked CSS */
                } else {
                    icon.classList.add(on ? 'fa-solid' : 'fa-regular', 'fa-bookmark');
                }
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
    menu.className = 'fixed inset-0 z-[var(--z-content-popup)]';
    
    const bg = document.createElement('div');
    bg.className = 'fixed inset-0 mealog-action-dim';
    bg.onclick = () => menu.remove();
    
    const menuContainer = document.createElement('div');
    menuContainer.className = 'mealog-action-wrap animate-fade-up';
    
    const actionCard = document.createElement('div');
    actionCard.className = 'mealog-action-card';
    
    if (isAuthor) {
        const editBtn = document.createElement('button');
        editBtn.className = 'mealog-action-btn';
        editBtn.type = 'button';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.editBoardPost(postId), 100);
        });
        editBtn.innerHTML = '<i data-lucide="pen"></i><span>수정하기</span>';
        actionCard.appendChild(editBtn);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'mealog-action-btn mealog-action-btn--danger';
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.deleteBoardPost(postId), 100);
        });
        deleteBtn.innerHTML = '<i data-lucide="trash-2"></i><span>삭제하기</span>';
        actionCard.appendChild(deleteBtn);
    } else {
        const reportBtn = document.createElement('button');
        reportBtn.className = 'mealog-action-btn mealog-action-btn--danger';
        reportBtn.type = 'button';
        reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => window.showReportModal && window.showReportModal(`board_${postId}`), 100);
        });
        reportBtn.innerHTML = '<i data-lucide="flag"></i><span>신고하기</span>';
        actionCard.appendChild(reportBtn);
    }
    
    menuContainer.addEventListener('click', (e) => e.stopPropagation());
    menuContainer.appendChild(actionCard);
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'mealog-action-cancel';
    cancelBtn.textContent = '닫기';
    cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
    });
    menuContainer.appendChild(cancelBtn);
    menu.appendChild(bg);
    menu.appendChild(menuContainer);
    document.body.appendChild(menu);
    if (typeof window.scheduleLucideIcons === 'function') window.scheduleLucideIcons(menu);
    else if (typeof window.lucide?.createIcons === 'function') window.lucide.createIcons({ root: menu });
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
    const wasLiked = firstBtn?.classList.contains('liked');
    
    try {
        await noticeOperations.toggleNoticeLike(noticeId, isLike);
        likeBtns.forEach(btn => {
            const nextLiked = !wasLiked;
            btn.classList.toggle('liked', nextLiked);
            const icon = btn.querySelector('[data-lucide="heart"], .lucide, .fa-heart, svg');
            if (icon) {
                if (typeof window.setLucideIconFilled === 'function') window.setLucideIconFilled(icon, nextLiked);
                icon.classList?.remove?.('fa-regular', 'fa-solid', 'text-red-500', 'text-slate-800');
                icon.classList?.add?.(nextLiked ? 'text-red-500' : 'text-slate-800');
            }
            const countEl = btn.querySelector('span.text-xs');
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
            const on = !!result?.bookmarked;
            btn.classList.toggle('bookmarked', on);
            const icon = btn.querySelector('[data-lucide="bookmark"], .lucide, .fa-bookmark, svg');
            if (icon) {
                if (typeof window.setLucideIconFilled === 'function') window.setLucideIconFilled(icon, on);
                icon.classList?.remove?.('fa-regular', 'fa-solid');
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
        
        // 입력 필드에 기존 데이터 채우기 — 구 제목은 본문 상단에 합쳐서 편집
        const boardWriteContentEl = document.getElementById('boardWriteContent');
        if (boardWriteContentEl) {
            const legacyTitle = post.title && String(post.title).trim() ? String(post.title).trim() : '';
            let bodyHtml = post.content || '';
            if (bodyHtml && !/<[a-z]/i.test(bodyHtml.trim())) {
                bodyHtml = escapeHtml(bodyHtml).replace(/\n/g, '<br>');
            }
            boardWriteContentEl.innerHTML = legacyTitle
                ? `<p><strong>${escapeHtml(legacyTitle)}</strong></p>${bodyHtml}`
                : bodyHtml;
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
const _boardDetailCommentImages = { files: [], objectUrls: [] };
const _noticeDetailCommentImages = { files: [], objectUrls: [] };

function revokeObjectUrls(list) {
    (list || []).forEach((u) => {
        try {
            if (u && String(u).startsWith('blob:')) URL.revokeObjectURL(u);
        } catch (_) {}
    });
}

function setDetailCommentFiles(kind, files) {
    const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
    revokeObjectUrls(target.objectUrls);
    target.files = Array.from(files || []).slice(0, 3);
    target.objectUrls = target.files.map((f) => URL.createObjectURL(f));
}

function clearDetailCommentFiles(kind, { revoke = true } = {}) {
    const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
    if (revoke) revokeObjectUrls(target.objectUrls);
    target.files = [];
    target.objectUrls = [];
}

function detachDetailCommentFiles(kind) {
    const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
    const files = Array.from(target.files || []);
    const objectUrls = Array.from(target.objectUrls || []);
    // UI에서는 즉시 비우되, object URL revoke는 호출 측이 결정(낙관적 row에 남아 있을 수 있음)
    clearDetailCommentFiles(kind, { revoke: false });
    return { files, objectUrls };
}

function replaceTempCommentImageUrls(tempCommentId, kind, imageUrls) {
    const urls = Array.isArray(imageUrls) ? imageUrls.map((u) => String(u || '').trim()).filter(Boolean) : [];
    if (!urls.length) return;
    const listId = kind === 'notice' ? 'noticeCommentsList' : 'boardCommentsList';
    const root = document.getElementById(listId);
    const row = root?.querySelector?.(`[data-comment-id="${tempCommentId}"]`);
    if (!row) return;
    row.querySelectorAll('[data-detail-comment-image="1"]').forEach((btn, idx) => {
        const url = urls[idx] || urls[0];
        if (!url) return;
        btn.setAttribute('data-src', url);
        const img = btn.querySelector('img');
        if (img) img.src = url;
    });
}

function renderDetailCommentPhotoPreview(kind) {
    const id = kind === 'notice' ? 'noticeCommentPhotoPreview' : 'boardCommentPhotoPreview';
    const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
    const el = document.getElementById(id);
    if (!el) return;
    if (!target.objectUrls.length) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    el.innerHTML = target.objectUrls
        .map(
            (url, idx) => `
            <button type="button" class="board-detail-comment-photo-thumb" data-detail-comment-photo-thumb="1" data-kind="${kind}" data-idx="${idx}" aria-label="첨부 이미지 미리보기">
                <img src="${url}" alt="" loading="lazy" />
            </button>
        `
        )
        .join('');
}

function detailComposerHasPayload(kind) {
    const inputId = kind === 'notice' ? 'noticeCommentInput' : 'boardCommentInput';
    const input = document.getElementById(inputId);
    const text = (input?.value || '').trim();
    const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
    return Boolean(text) || (target.files && target.files.length > 0);
}

function syncDetailCommentSendBtnVisibilityByKind(kind) {
    const btnSelector = kind === 'notice' ? '[data-notice-comment-send="1"]' : '[data-board-comment-send="1"]';
    const btn = document.querySelector(btnSelector);
    if (!btn) return;
    const hasPayload = detailComposerHasPayload(kind);
    btn.disabled = !hasPayload;
}

/** 게시판 상세 댓글 한 줄 — `renderBoardDetail` 마크업과 동일 */
function renderDetailCommentImagesHtml(imageUrls, kind) {
    const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
    if (urls.length === 0) return '';
    const k = kind === 'notice' ? 'notice' : 'board';
    return `<div class="board-detail-comment-images mt-2 flex flex-wrap gap-2" data-detail-comment-images="${k}">
        ${urls
            .map((u) => {
                const url = String(u || '').trim();
                if (!url) return '';
                const esc = escapeHtml(url);
                return `<button type="button" class="board-detail-comment-image-btn" data-detail-comment-image="1" data-kind="${k}" data-src="${esc}" aria-label="댓글 이미지 확대">
                    <img src="${esc}" alt="" loading="lazy" />
                </button>`;
            })
            .join('')}
    </div>`;
}

function buildBoardDetailCommentRowHtml({
    commentId,
    postId,
    nickname,
    body,
    commentDateStr,
    commentTimeStr,
    showDelete,
    imageUrls
}) {
    const timePart =
        commentDateStr && commentTimeStr
            ? `<time class="board-detail-comment__time">${commentDateStr} ${commentTimeStr}</time>`
            : '';
    const actionsPart = showDelete
        ? `<button type="button" onclick="window.deleteBoardComment('${commentId}', '${postId}')" class="board-detail-comment__delete">삭제</button>`
        : '';
    const imagesPart = renderDetailCommentImagesHtml(imageUrls, 'board');
    const bodyPart = body
        ? `<p class="board-detail-comment__body" data-board-comment-body="1">${escapeHtml(body)}</p>`
        : '';
    return `<div class="board-detail-comment" data-comment-id="${commentId}">
    <div class="board-detail-comment__head">
      <div class="board-detail-comment__meta">
        <span class="board-detail-comment__nick">${escapeHtml(nickname)}</span>
        ${timePart}
      </div>
      ${actionsPart || ''}
    </div>
    ${bodyPart}
    ${imagesPart}
  </div>`;
}

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
    const hasImages = _boardDetailCommentImages.files && _boardDetailCommentImages.files.length > 0;
    if (!content && !hasImages) {
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
    const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
    const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
    const rowHtml = buildBoardDetailCommentRowHtml({
        commentId: tempCommentId,
        postId,
        nickname: authorNickname,
        body: content,
        commentDateStr,
        commentTimeStr,
        showDelete: true,
        imageUrls: _boardDetailCommentImages.objectUrls || []
    });
    if (commentsListEl) {
        commentsListEl.querySelector('.board-detail-comments-empty')?.remove();
        commentsListEl.classList.add('has-items');
        commentsListEl.insertAdjacentHTML('beforeend', rowHtml);
        const last = commentsListEl.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (commentsCountEl) {
        const n = (parseInt(commentsCountEl.textContent, 10) || 0) + 1;
        commentsCountEl.textContent = String(n);
    }
    input.value = '';
    try {
        window.syncBoardDetailCommentComposer?.();
    } catch (_) {}
    
    try {
        let imageUrls = [];
        if (hasImages) {
            const { files: filesToUpload, objectUrls: optimisticUrls } = detachDetailCommentFiles('board');
            renderDetailCommentPhotoPreview('board');
            imageUrls = await uploadBoardImages(filesToUpload, window.currentUser.uid);
            // 업로드 성공 후: 낙관적 blob URL을 실제 URL로 치환 + revoke
            replaceTempCommentImageUrls(tempCommentId, 'board', imageUrls);
            revokeObjectUrls(optimisticUrls);
        } else {
            clearDetailCommentFiles('board');
            renderDetailCommentPhotoPreview('board');
        }
        const result = await boardOperations.addComment(postId, content, imageUrls);
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
        /* 서버가 이유를 말해 줬으면 그대로 보여 준다 — 「실패했습니다」만으로는 고칠 수가 없다 */
        showToast(e?.message || e?.details || "댓글 작성에 실패했습니다.", 'error');
        /* 전송 전에 비운 입력창을 되돌린다 (아직 아무것도 안 쓴 경우에만) */
        if (input && !input.value.trim()) {
            input.value = content;
            try {
                window.syncBoardDetailCommentComposer?.();
            } catch (_) {}
        }
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-comment-id="${tempCommentId}"]`);
            if (tempRow) tempRow.remove();
            if (commentsListEl.children.length === 0) {
                commentsListEl.classList.remove('has-items');
                commentsListEl.innerHTML =
                    '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
            }
        }
        if (commentsCountEl) {
            const n = Math.max(0, (parseInt(commentsCountEl.textContent, 10) || 0) - 1);
            commentsCountEl.textContent = String(n);
        }
    } finally {
        _boardCommentSubmitting[postId] = false;
        try {
            window.syncBoardDetailCommentComposer?.();
        } catch (_) {}
    }
};

const _noticeCommentSubmitting = {};

/** 공지 상세 댓글 한 줄 — `renderNoticeDetail` 마크업과 동일 */
function buildNoticeDetailCommentRowHtml({
    commentId,
    noticeId,
    nickname,
    body,
    commentDateStr,
    commentTimeStr,
    showDelete,
    imageUrls
}) {
    const timePart =
        commentDateStr && commentTimeStr
            ? `<time class="board-detail-comment__time">${commentDateStr} ${commentTimeStr}</time>`
            : '';
    const safeNid = String(noticeId || '').replace(/'/g, "\\'");
    const safeCid = String(commentId || '').replace(/'/g, "\\'");
    const actionsPart = showDelete
        ? `<button type="button" onclick="window.deleteNoticeComment('${safeCid}', '${safeNid}')" class="board-detail-comment__delete">삭제</button>`
        : '';
    const imagesPart = renderDetailCommentImagesHtml(imageUrls, 'notice');
    const bodyPart = body
        ? `<p class="board-detail-comment__body" data-notice-comment-body="1">${escapeHtml(body)}</p>`
        : '';
    return `<div class="board-detail-comment" data-comment-id="${String(commentId)}">
    <div class="board-detail-comment__head">
      <div class="board-detail-comment__meta">
        <span class="board-detail-comment__nick">${escapeHtml(nickname)}</span>
        ${timePart}
      </div>
      ${actionsPart || ''}
    </div>
    ${bodyPart}
    ${imagesPart}
  </div>`;
}

window.addNoticeComment = async (noticeId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 댓글을 작성할 수 없습니다.', 'error');
        return;
    }

    const input = document.getElementById('noticeCommentInput');
    if (!input) return;

    const content = input.value.trim();
    const hasImages = _noticeDetailCommentImages.files && _noticeDetailCommentImages.files.length > 0;
    if (!content && !hasImages) {
        showToast('댓글을 입력해주세요.', 'error');
        return;
    }
    if (_noticeCommentSubmitting[noticeId]) return;
    _noticeCommentSubmitting[noticeId] = true;

    const commentsListEl = document.getElementById('noticeCommentsList');
    const commentsCountEl = document.getElementById('noticeCommentsCount');
    const authorNickname =
        (window.userSettings && window.userSettings.profile && window.userSettings.profile.nickname) || '익명';
    const tempCommentId = `temp-${Date.now()}`;

    const commentDate = new Date();
    const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
    const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
    const rowHtml = buildNoticeDetailCommentRowHtml({
        commentId: tempCommentId,
        noticeId,
        nickname: authorNickname,
        body: content,
        commentDateStr,
        commentTimeStr,
        showDelete: true,
        imageUrls: _noticeDetailCommentImages.objectUrls || []
    });
    if (commentsListEl) {
        commentsListEl.querySelector('.board-detail-comments-empty')?.remove();
        commentsListEl.classList.add('has-items');
        commentsListEl.insertAdjacentHTML('beforeend', rowHtml);
        const last = commentsListEl.lastElementChild;
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    if (commentsCountEl) {
        const n = (parseInt(commentsCountEl.textContent, 10) || 0) + 1;
        commentsCountEl.textContent = String(n);
    }
    input.value = '';
    try {
        window.syncBoardDetailCommentComposer?.();
    } catch (_) {}

    try {
        let imageUrls = [];
        if (hasImages) {
            const { files: filesToUpload, objectUrls: optimisticUrls } = detachDetailCommentFiles('notice');
            renderDetailCommentPhotoPreview('notice');
            imageUrls = await uploadBoardImages(filesToUpload, window.currentUser.uid);
            replaceTempCommentImageUrls(tempCommentId, 'notice', imageUrls);
            revokeObjectUrls(optimisticUrls);
        } else {
            clearDetailCommentFiles('notice');
            renderDetailCommentPhotoPreview('notice');
        }
        const result = await noticeOperations.addNoticeComment(noticeId, content, imageUrls);
        const realId = (result && (result.commentId ?? result.id)) || null;
        if (realId && commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-comment-id="${tempCommentId}"]`);
            if (tempRow) {
                tempRow.setAttribute('data-comment-id', realId);
                const btn = tempRow.querySelector('button[onclick*="deleteNoticeComment"]');
                if (btn) {
                    const safeNid = String(noticeId || '').replace(/'/g, "\\'");
                    btn.setAttribute('onclick', `window.deleteNoticeComment('${String(realId).replace(/'/g, "\\'")}', '${safeNid}')`);
                }
            }
        }
    } catch (e) {
        console.error('공지 댓글 작성 오류:', e);
        showToast('댓글 작성에 실패했습니다.', 'error');
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-comment-id="${tempCommentId}"]`);
            if (tempRow) tempRow.remove();
            if (commentsListEl.children.length === 0) {
                commentsListEl.classList.remove('has-items');
                commentsListEl.innerHTML =
                    '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
            }
        }
        if (commentsCountEl) {
            const n = Math.max(0, (parseInt(commentsCountEl.textContent, 10) || 0) - 1);
            commentsCountEl.textContent = String(n);
        }
    } finally {
        _noticeCommentSubmitting[noticeId] = false;
        try {
            window.syncBoardDetailCommentComposer?.();
        } catch (_) {}
    }
};

function syncDetailCommentSendBtn({ inputId, btnSelector }) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const btn = document.querySelector(btnSelector);
    if (!btn) return;
    const hasText = Boolean((input.value || '').trim());
    btn.classList.toggle('hidden', !hasText);
    btn.disabled = !hasText;
}

window.syncBoardDetailCommentComposer = () => {
    syncDetailCommentSendBtnVisibilityByKind('board');
    syncDetailCommentSendBtnVisibilityByKind('notice');
};

// 댓글 이미지 확대(라이트박스) — 게시판/공지 상세 공용
let _detailCommentLightboxEl = null;
function openDetailCommentLightbox(src) {
    const url = typeof src === 'string' ? src.trim() : '';
    if (!url) return;
    if (!_detailCommentLightboxEl) {
        _detailCommentLightboxEl = document.createElement('div');
        _detailCommentLightboxEl.className = 'detail-comment-lightbox hidden';
        _detailCommentLightboxEl.innerHTML = `
            <div class="detail-comment-lightbox__scrim" data-dclb-close="1" aria-label="닫기"></div>
            <div class="detail-comment-lightbox__stage" role="dialog" aria-modal="true" aria-label="이미지 확대">
                <button type="button" class="detail-comment-lightbox__close" data-dclb-close="1" aria-label="닫기">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
                <img class="detail-comment-lightbox__img" alt="" />
            </div>
        `;
        document.body.appendChild(_detailCommentLightboxEl);
        _detailCommentLightboxEl.addEventListener('click', (e) => {
            const close = e.target?.closest?.('[data-dclb-close="1"]');
            if (close) {
                e.preventDefault();
                _detailCommentLightboxEl.classList.add('hidden');
                _detailCommentLightboxEl.querySelector('img')?.removeAttribute('src');
            }
        });
    }
    const img = _detailCommentLightboxEl.querySelector('img');
    if (img) img.src = url;
    _detailCommentLightboxEl.classList.remove('hidden');
}

(function bindDetailCommentImageLightbox() {
    if (document.documentElement.dataset.detailCommentImageLbBound === '1') return;
    document.documentElement.dataset.detailCommentImageLbBound = '1';
    document.addEventListener('click', (e) => {
        const thumb = e.target?.closest?.('[data-detail-comment-photo-thumb="1"]');
        if (thumb) {
            const kind = thumb.getAttribute('data-kind') || 'board';
            const idx = parseInt(thumb.getAttribute('data-idx') || '0', 10) || 0;
            const target = kind === 'notice' ? _noticeDetailCommentImages : _boardDetailCommentImages;
            const src = target.objectUrls && target.objectUrls[idx] ? String(target.objectUrls[idx]) : '';
            if (!src) return;
            e.preventDefault();
            openDetailCommentLightbox(src);
            return;
        }
        const btn = e.target?.closest?.('[data-detail-comment-image="1"]');
        if (!btn) return;
        const src = btn.getAttribute('data-src') || '';
        if (!src) return;
        e.preventDefault();
        openDetailCommentLightbox(src);
    });
})();

// 상세 댓글 입력: 내용 있을 때만 전송(화살표) 버튼 노출
(function bindDetailCommentComposerVisibility() {
    if (document.documentElement.dataset.detailCommentComposerBound === '1') return;
    document.documentElement.dataset.detailCommentComposerBound = '1';
    const onAnyInput = (e) => {
        const t = e?.target;
        if (!t) return;
        if (t.id === 'boardCommentInput' || t.id === 'noticeCommentInput') {
            try {
                window.syncBoardDetailCommentComposer?.();
            } catch (_) {}
        }
    };
    document.addEventListener('input', onAnyInput, { passive: true });
    document.addEventListener('focusin', onAnyInput, { passive: true });
    document.addEventListener('focusout', onAnyInput, { passive: true });
})();

// 상세 댓글 사진 첨부/미리보기 바인딩
(function bindDetailCommentPhotoAttach() {
    if (document.documentElement.dataset.detailCommentPhotoAttachBound === '1') return;
    document.documentElement.dataset.detailCommentPhotoAttachBound = '1';

    document.addEventListener('click', (e) => {
        const t = e.target;
        const boardBtn = t?.closest?.('[data-board-comment-attach="1"]');
        const noticeBtn = t?.closest?.('[data-notice-comment-attach="1"]');
        if (boardBtn) {
            e.preventDefault();
            document.getElementById('boardCommentPhotoInput')?.click?.();
            return;
        }
        if (noticeBtn) {
            e.preventDefault();
            document.getElementById('noticeCommentPhotoInput')?.click?.();
        }
    });

    document.addEventListener('change', (e) => {
        const input = e.target;
        if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
        if (input.id === 'boardCommentPhotoInput') {
            setDetailCommentFiles('board', input.files);
            renderDetailCommentPhotoPreview('board');
            syncDetailCommentSendBtnVisibilityByKind('board');
        } else if (input.id === 'noticeCommentPhotoInput') {
            setDetailCommentFiles('notice', input.files);
            renderDetailCommentPhotoPreview('notice');
            syncDetailCommentSendBtnVisibilityByKind('notice');
        }
    });
})();

// 버튼 눌림(press) 효과: 사진/발송 버튼 공용
(function bindDetailCommentPressFx() {
    if (document.documentElement.dataset.detailCommentPressFxBound === '1') return;
    document.documentElement.dataset.detailCommentPressFxBound = '1';

    const isPressTarget = (el) =>
        Boolean(
            el?.closest?.('.board-detail-comment-send') ||
                el?.closest?.('.board-detail-comment-attach') ||
                el?.closest?.('.moment-v2-social-comments-send')
        );

    const pressClass = 'is-pressed';
    const add = (el) => {
        const btn = el?.closest?.('.board-detail-comment-send, .board-detail-comment-attach, .moment-v2-social-comments-send');
        if (!btn) return;
        btn.classList.add(pressClass);
    };
    const clearAll = () => {
        document.querySelectorAll(`.${pressClass}`).forEach((n) => n.classList.remove(pressClass));
    };

    document.addEventListener(
        'mousedown',
        (e) => {
            if (!isPressTarget(e.target)) return;
            add(e.target);
        },
        { passive: true }
    );
    document.addEventListener(
        'touchstart',
        (e) => {
            if (!isPressTarget(e.target)) return;
            add(e.target);
        },
        { passive: true }
    );
    ['mouseup', 'touchend', 'touchcancel', 'mouseleave', 'blur'].forEach((evt) => {
        window.addEventListener(evt, () => clearAll(), { passive: true });
    });
})();

window.deleteNoticeComment = async (commentId, noticeId) => {
    if (!confirm('댓글을 삭제하시겠습니까?')) return;

    const commentsListEl = document.getElementById('noticeCommentsList');
    const commentsCountEl = document.getElementById('noticeCommentsCount');
    const row = commentsListEl?.querySelector(`[data-comment-id="${commentId}"]`);
    const prevCount = commentsCountEl ? parseInt(commentsCountEl.textContent, 10) || 0 : 0;
    if (row) {
        row.remove();
        if (commentsCountEl) commentsCountEl.textContent = String(Math.max(0, prevCount - 1));
        if (commentsListEl && commentsListEl.children.length === 0) {
            commentsListEl.classList.remove('has-items');
            commentsListEl.innerHTML =
                '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
        }
    }

    try {
        await noticeOperations.deleteNoticeComment(commentId, noticeId);
        showToast('댓글이 삭제되었습니다.', 'success');
    } catch (e) {
        console.error('공지 댓글 삭제 오류:', e);
        showToast('댓글 삭제에 실패했습니다.', 'error');
        try {
            const comments = await noticeOperations.getNoticeComments(noticeId);
            if (commentsListEl && commentsCountEl) {
                commentsCountEl.textContent = String(comments.length);
                if (comments.length > 0) {
                    commentsListEl.classList.add('has-items');
                    commentsListEl.innerHTML = comments
                        .map((comment) => {
                            let commentDate;
                            if (!comment.timestamp) commentDate = new Date();
                            else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') {
                                commentDate = comment.timestamp.toDate();
                            } else if (typeof comment.timestamp === 'string') commentDate = new Date(comment.timestamp);
                            else if (comment.timestamp instanceof Date) commentDate = comment.timestamp;
                            else commentDate = new Date(comment.timestamp || 0);
                            if (isNaN(commentDate.getTime())) commentDate = new Date();
                            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
                            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
                            const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                            const commentDisplay = getDisplayProfile(
                                comment.authorId,
                                {
                                    nickname: comment.authorNickname || comment.anonymousId,
                                    icon: comment.authorIcon,
                                    photoUrl: comment.authorPhotoUrl
                                },
                                { preferStoredNickname: true }
                            );
                            const commentBody = comment.content ?? comment.text ?? '';
                            return buildNoticeDetailCommentRowHtml({
                                commentId: comment.id,
                                noticeId,
                                nickname: commentDisplay.nickname,
                                body: commentBody,
                                commentDateStr,
                                commentTimeStr,
                                showDelete: isCommentAuthor,
                                imageUrls: comment.imageUrls || []
                            });
                        })
                        .join('');
                } else {
                    commentsListEl.classList.remove('has-items');
                    commentsListEl.innerHTML =
                        '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
                }
            }
        } catch (err) {
            console.error('공지 댓글 목록 새로고침 오류:', err);
        }
    }
};

window.editBoardComment = async (commentId, postId) => {
    const cid = String(commentId || '').trim();
    const pid = String(postId || '').trim();
    if (!cid || !pid) return;
    const row = document.getElementById('boardCommentsList')?.querySelector?.(`[data-comment-id="${cid}"]`);
    const current = row?.querySelector?.('[data-board-comment-body]')?.textContent ?? row?.querySelector?.('p')?.textContent ?? '';
    const next = prompt('댓글을 편집하세요', String(current || '').trim());
    if (next == null) return;
    const text = String(next).trim();
    if (!text) {
        showToast('댓글 내용을 입력해주세요.', 'error');
        return;
    }
    try {
        await boardOperations.updateComment(cid, pid, text);
        if (row) {
            const p = row.querySelector('[data-board-comment-body]') || row.querySelector('p');
            if (p) {
                p.textContent = text;
                p.classList.remove('hidden');
            }
        }
        showToast('댓글이 수정되었습니다.', 'success');
    } catch (_) {
        // updateComment 내에서 토스트 처리
    }
};

window.editNoticeComment = async (commentId, noticeId) => {
    const cid = String(commentId || '').trim();
    const nid = String(noticeId || '').trim();
    if (!cid || !nid) return;
    const row = document.getElementById('noticeCommentsList')?.querySelector?.(`[data-comment-id="${cid}"]`);
    const current = row?.querySelector?.('[data-notice-comment-body]')?.textContent ?? row?.querySelector?.('p')?.textContent ?? '';
    const next = prompt('댓글을 편집하세요', String(current || '').trim());
    if (next == null) return;
    const text = String(next).trim();
    if (!text) {
        showToast('댓글 내용을 입력해주세요.', 'error');
        return;
    }
    try {
        await noticeOperations.updateNoticeComment(cid, nid, text);
        if (row) {
            const p = row.querySelector('[data-notice-comment-body]') || row.querySelector('p');
            if (p) {
                p.textContent = text;
                p.classList.remove('hidden');
            }
        }
        showToast('댓글이 수정되었습니다.', 'success');
    } catch (_) {
        // updateNoticeComment 내에서 토스트 처리
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
        if (commentsCountEl) commentsCountEl.textContent = String(Math.max(0, prevCount - 1));
        if (commentsListEl && commentsListEl.children.length === 0) {
            commentsListEl.classList.remove('has-items');
            commentsListEl.innerHTML =
                '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
        }
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
                    commentsListEl.classList.add('has-items');
                    commentsListEl.innerHTML = comments.map(comment => {
                        let commentDate;
                        if (!comment.timestamp) commentDate = new Date();
                        else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') commentDate = comment.timestamp.toDate();
                        else if (typeof comment.timestamp === 'string') commentDate = new Date(comment.timestamp);
                        else if (comment.timestamp instanceof Date) commentDate = comment.timestamp;
                        else commentDate = new Date(comment.timestamp || 0);
                        if (isNaN(commentDate.getTime())) commentDate = new Date();
                        const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', ...SEOUL_LOCALE_OPTIONS });
                        const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, ...SEOUL_LOCALE_OPTIONS });
                        const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                        const commentDisplay = getDisplayProfile(
                                comment.authorId,
                                {
                                    nickname: comment.authorNickname || comment.anonymousId,
                                    icon: comment.authorIcon,
                                    photoUrl: comment.authorPhotoUrl
                                },
                                { preferStoredNickname: true }
                            );
                        const commentBody = comment.content ?? comment.text ?? '';
                        return buildBoardDetailCommentRowHtml({
                            commentId: comment.id,
                            postId,
                            nickname: commentDisplay.nickname,
                            body: commentBody,
                            commentDateStr,
                            commentTimeStr,
                            showDelete: isCommentAuthor,
                            imageUrls: comment.imageUrls || []
                        });
                    }).join('');
                } else {
                    commentsListEl.classList.remove('has-items');
                    commentsListEl.innerHTML =
                        '<p class="board-detail-comments-empty">아직 댓글이 없습니다</p>';
                }
            }
        } catch (err) {
            console.error("댓글 목록 새로고침 오류:", err);
        }
    }
};

const boardSubtabFeed = document.getElementById('boardSubtabFeed');
const boardSubtabBoard = document.getElementById('boardSubtabBoard');
const boardSubtabNotice = document.getElementById('boardSubtabNotice');
if (boardSubtabFeed) {
    boardSubtabFeed.addEventListener('click', () => window.switchBoardListSubTab('feed'));
}
if (boardSubtabBoard) {
    boardSubtabBoard.addEventListener('click', () => window.switchBoardListSubTab('board'));
}
if (boardSubtabNotice) {
    boardSubtabNotice.addEventListener('click', () => window.switchBoardListSubTab('notice'));
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
    const settingsScroll = document.querySelector('#settingsView .settings-view-content');
    if (settingsScroll) settingsScroll.addEventListener('scroll', onScroll, { passive: true });
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
        el.innerHTML = '<i data-lucide="user" class="text-xs"></i>';
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
    } else {
        el.className = `${baseClass} bg-slate-200 flex items-center justify-center ${av.type === 'emoji' ? 'text-base' : 'text-[11px] font-bold text-slate-700'}`;
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
            <button type="button" class="absolute top-0 right-0 w-5 h-5 flex items-center justify-center bg-black/55 text-white text-[10px] rounded-bl" aria-label="사진 제거"><i data-lucide="x"></i></button>
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
    updateFeedCharRemainingUi(boardInlineCount, len);
    if (boardInlineSubmit) boardInlineSubmit.disabled = !hasSendableText && !hasPhoto;
    if (boardInlineInput) {
        boardInlineInput.style.height = 'auto';
        const cap = Math.max(260, Math.floor(window.innerHeight * 0.5));
        boardInlineInput.style.height = `${Math.min(boardInlineInput.scrollHeight, cap)}px`;
    }
}
window.syncBoardInlineComposerUi = syncBoardInlineComposerUi;

/**
 * ── 전송 실패 시 입력창 복원 ────────────────────────────────────────────────
 *
 * 전송은 입력창을 **먼저 비우고** 시작한다(낙관적 반영 — 키보드가 내려가지 않게 하려는
 * 의도였다). 그래서 실패하면 사용자가 쓴 글이 화면에서 통째로 사라졌다. 아웃박스에는
 * 남지만 사용자에게는 보이지 않고, 앱 안에서 다시 꺼낼 방법도 없다.
 *
 * 실제 사고 (2026-08-30): 스팸 필터가 자기 도메인 링크를 금칙어로 잡아 밀톡 답변을
 * 거절했고, 사용자가 쓴 답변 한 편이 그대로 사라졌다. 필터는 고쳤지만(functions/spam-filter.js)
 * 「실패하면 글이 사라진다」는 자리 자체가 남아 있으면 다음 실패에서 또 같은 일이 난다.
 */
function captureFeedComposerState({ raw, photoFile, replyToPostId }) {
    const nickEl = document.getElementById('boardInlineComposerReplyNick');
    const snipEl = document.getElementById('boardInlineComposerReplySnippet');
    return {
        raw,
        photoFile,
        replyToPostId,
        replyNick: nickEl ? nickEl.textContent : '',
        replySnippet: snipEl ? snipEl.textContent : '',
        replyTitle: snipEl ? snipEl.getAttribute('title') : null
    };
}

/**
 * 스냅샷을 입력창에 되돌린다.
 *
 * 비어 있는 자리만 되돌린다 — 전송이 도는 동안 사용자가 이미 다음 글을 쓰고 있었다면
 * 그걸 덮어쓰는 쪽이 더 나쁘다. 그 경우에도 원문은 아웃박스에 남아 있다.
 */
function restoreFeedComposerState(snap) {
    if (!snap) return;
    if (boardInlineInput && !boardInlineInput.value.trim()) {
        boardInlineInput.value = snap.raw || '';
    }
    if (snap.photoFile && !window.feedComposerPhotoFile) {
        window.feedComposerPhotoFile = snap.photoFile;
        try {
            window.feedComposerPhotoObjectUrl = URL.createObjectURL(snap.photoFile);
        } catch (_) {}
        renderFeedComposerPhotoPreview();
    }
    if (snap.replyToPostId && !window.__feedReplyToPostId) {
        window.__feedReplyToPostId = snap.replyToPostId;
        const nickEl = document.getElementById('boardInlineComposerReplyNick');
        const snipEl = document.getElementById('boardInlineComposerReplySnippet');
        if (nickEl) nickEl.textContent = snap.replyNick || '';
        if (snipEl) {
            snipEl.textContent = snap.replySnippet || '';
            if (snap.replyTitle) snipEl.setAttribute('title', snap.replyTitle);
            else snipEl.removeAttribute('title');
        }
        document.getElementById('boardInlineComposerReplyBar')?.classList.remove('hidden');
    }
    syncBoardInlineComposerUi();
}

if (boardInlineInput) {
    /* 조합 중 height 재기입·리플로우가 IME 글자 렌더를 깨뜨림 — 모먼트 댓글과 동일 가드 */
    addCompositionAwareInput(boardInlineInput, syncBoardInlineComposerUi);
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

    /* 비우기 **전에** 찍는다 — 실패하면 이걸로 되돌린다 */
    const composerSnapshot = captureFeedComposerState({ raw, photoFile, replyToPostId });

    if (boardInlineInput) boardInlineInput.value = '';
    clearFeedReplyBar();
    clearFeedComposerPhoto();
    syncBoardInlineComposerUi();

    const submitBtn = boardInlineSubmit;
    const sendIconHtml = '<i data-lucide="arrow-up" class="text-sm"></i>';
    const prevHtml = submitBtn.innerHTML;
    /* i[data-lucide]는 전역 옵저버가 없어 넣은 쪽이 직접 SVG로 바꿔야 한다 — 안 하면 빈 아이콘 */
    const setSubmitIcon = (html) => {
        submitBtn.innerHTML = html;
        refreshLucideIcons(submitBtn);
    };
    submitBtn.disabled = true;
    setSubmitIcon('<i data-lucide="loader-circle" class="text-sm lucide-spin"></i>');

    let imageUrls = [];
    if (hasPhoto) {
        try {
            imageUrls = await uploadFeedImages([photoFile], window.currentUser.uid);
        } catch (err) {
            console.error('[feed composer] upload:', err);
            removePendingFeedPosts();
            restoreFeedComposerState(composerSnapshot);
            showToast(err?.message || '사진 업로드에 실패했습니다.', 'error');
            submitBtn.disabled = false;
            setSubmitIcon(prevHtml || sendIconHtml);
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
        restoreFeedComposerState(composerSnapshot);
        // createMessage에서 토스트 처리
    } finally {
        submitBtn.disabled = false;
        setSubmitIcon(sendIconHtml);
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
