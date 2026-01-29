// 메인 애플리케이션 로직
console.log('📦 main.js 모듈 로드 시작');

// 모듈 로드 시작 플래그 설정 (index.html의 체크가 감지할 수 있도록)
window.moduleLoading = true;

import { appState, getState } from './state.js';
import { auth, db, appId } from './firebase.js';
import { signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { dbOps, setupListeners, setupSharedPhotosListener, loadMoreMeals, postInteractions, boardOperations, noticeOperations, submitReport, getUserReportForPost, withdrawReport } from './db.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { serverTimestamp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { switchScreen, showToast, updateHeaderUI, showLoading, hideLoading } from './ui.js';
import { 
    initAuth, handleGoogleLogin, startGuest, openEmailModal, closeEmailModal,
    setEmailAuthMode, toggleEmailAuthMode, handleEmailAuth, confirmLogout, confirmLogoutAction,
    copyDomain, closeDomainModal, switchToLogin, showTermsModal, closeTermsModal, cancelTermsAgreement, confirmTermsAgreement,
    showTermsDetail, updateTermsAgreeButton, selectSetupIcon, confirmProfileSetup, setProfileType, handleSetupPhotoUpload,
    confirmDeleteAccount, cancelDeleteAccount, confirmDeleteAccountAction
} from './auth.js';
import { authFlowManager } from './auth-flow.js';

// 전역 리스너 정리 함수 (게스트→로그인 이동 등에서 사용)
window.cleanupFirestoreListeners = () => {
    try {
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
    } catch (e) {
        console.warn('cleanupFirestoreListeners 실패(무시):', e);
    }
};
import { renderTimeline, renderMiniCalendar, updateTimelineShareIndicators, renderGallery, renderFeed, renderEntryChips, toggleComment, toggleFeedComment, createDailyShareCard, renderBoard, renderBoardDetail, renderNoticeDetail, escapeHtml, filterGalleryByUser, clearGalleryFilter } from './render/index.js';
import { updateDashboard, setDashboardMode, updateCustomDates, updateSelectedMonth, updateSelectedWeek, changeWeek, changeMonth, navigatePeriod, openDetailModal, closeDetailModal, setAnalysisType, openShareBestModal, closeShareBestModal, shareBestToFeed, openCharacterSelectModal, closeCharacterSelectModal, selectInsightCharacter, generateInsightComment, openShareInsightModal, closeShareInsightModal, shareInsightToFeed, openEditInsightShareModal } from './analytics.js';
import { openEditBestShareModal } from './analytics/best-share.js';
import { 
    openModal, closeModal, saveEntry, deleteEntry, setRating, setSatiety, selectTag,
    handleMultipleImages, removePhoto, updateShareIndicator, toggleSharePhoto,
    openSettings, closeSettings, switchSettingsTab, saveSettings, saveProfileSettings, selectIcon, setSettingsProfileType, handlePhotoUpload, addTag, removeTag, deleteSubTag, addFavoriteTag, removeFavoriteTag, selectFavoriteMainTag,
    openKakaoPlaceSearch, searchKakaoPlaces, selectKakaoPlace
} from './modals.js';
import { DEFAULT_SUB_TAGS, REPORT_REASONS } from './constants.js';
import { normalizeUrl } from './utils.js';

// 전역 네임스페이스 객체 생성 (하위 호환성 유지)
window.Mealog = window.Mealog || {};

// 전역 객체에 함수들 할당 (HTML에서 접근 가능하도록)
// 하위 호환성을 위해 window.*에도 유지하고, window.Mealog에도 할당
window.dbOps = dbOps;
window.Mealog.dbOps = dbOps;
window.postInteractions = postInteractions;
window.Mealog.postInteractions = postInteractions;
window.removeDuplicateMeals = () => dbOps.removeDuplicateMeals();
window.Mealog.removeDuplicateMeals = window.removeDuplicateMeals;
window.showToast = showToast;
window.Mealog.showToast = showToast;
window.renderTimeline = renderTimeline;
window.Mealog.renderTimeline = renderTimeline;
window.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.Mealog.updateTimelineShareIndicators = updateTimelineShareIndicators;
window.renderGallery = renderGallery;
window.Mealog.renderGallery = renderGallery;
window.filterGalleryByUser = filterGalleryByUser;
window.Mealog.filterGalleryByUser = filterGalleryByUser;
window.clearGalleryFilter = clearGalleryFilter;
window.Mealog.clearGalleryFilter = clearGalleryFilter;
window.updateHeaderUI = updateHeaderUI;
window.Mealog.updateHeaderUI = updateHeaderUI;
window.copyDomain = copyDomain;
window.Mealog.copyDomain = copyDomain;
window.closeDomainModal = closeDomainModal;
window.Mealog.closeDomainModal = closeDomainModal;
window.handleGoogleLogin = handleGoogleLogin;
window.Mealog.handleGoogleLogin = handleGoogleLogin;
window.startGuest = startGuest;
window.Mealog.startGuest = startGuest;
window.openEmailModal = openEmailModal;
window.Mealog.openEmailModal = openEmailModal;
window.closeEmailModal = closeEmailModal;
window.Mealog.closeEmailModal = closeEmailModal;
window.setEmailAuthMode = setEmailAuthMode;
window.Mealog.setEmailAuthMode = setEmailAuthMode;
window.toggleEmailAuthMode = toggleEmailAuthMode;
window.Mealog.toggleEmailAuthMode = toggleEmailAuthMode;
window.handleEmailAuth = handleEmailAuth;
window.Mealog.handleEmailAuth = handleEmailAuth;
window.confirmLogout = confirmLogout;
window.Mealog.confirmLogout = confirmLogout;
window.confirmLogoutAction = confirmLogoutAction;
window.Mealog.confirmLogoutAction = confirmLogoutAction;
window.confirmDeleteAccount = confirmDeleteAccount;
window.Mealog.confirmDeleteAccount = confirmDeleteAccount;
window.switchToLogin = switchToLogin;
window.Mealog.switchToLogin = switchToLogin;
window.showTermsModal = showTermsModal;
window.Mealog.showTermsModal = showTermsModal;
window.closeTermsModal = closeTermsModal;
window.Mealog.closeTermsModal = closeTermsModal;
window.cancelTermsAgreement = cancelTermsAgreement;
window.Mealog.cancelTermsAgreement = cancelTermsAgreement;
window.confirmTermsAgreement = confirmTermsAgreement;
window.Mealog.confirmTermsAgreement = confirmTermsAgreement;
window.showTermsDetail = showTermsDetail;
window.Mealog.showTermsDetail = showTermsDetail;
window.updateTermsAgreeButton = updateTermsAgreeButton;
window.Mealog.updateTermsAgreeButton = updateTermsAgreeButton;
window.selectSetupIcon = selectSetupIcon;
window.Mealog.selectSetupIcon = selectSetupIcon;
window.confirmProfileSetup = confirmProfileSetup;
window.Mealog.confirmProfileSetup = confirmProfileSetup;
window.setProfileType = setProfileType;
window.Mealog.setProfileType = setProfileType;
window.handleSetupPhotoUpload = handleSetupPhotoUpload;
window.Mealog.handleSetupPhotoUpload = handleSetupPhotoUpload;
window.openModal = openModal;
window.Mealog.openModal = openModal;
window.closeModal = closeModal;
window.Mealog.closeModal = closeModal;
window.saveEntry = saveEntry;
window.Mealog.saveEntry = saveEntry;
window.deleteEntry = deleteEntry;
window.Mealog.deleteEntry = deleteEntry;
window.setRating = setRating;
window.Mealog.setRating = setRating;
window.setSatiety = setSatiety;
window.Mealog.setSatiety = setSatiety;
window.selectTag = selectTag;
window.Mealog.selectTag = selectTag;
window.handleMultipleImages = handleMultipleImages;
window.Mealog.handleMultipleImages = handleMultipleImages;
window.removePhoto = removePhoto;
window.Mealog.removePhoto = removePhoto;
window.updateShareIndicator = updateShareIndicator;
window.Mealog.updateShareIndicator = updateShareIndicator;
window.toggleSharePhoto = toggleSharePhoto;
window.Mealog.toggleSharePhoto = toggleSharePhoto;
window.openSettings = openSettings;
window.Mealog.openSettings = openSettings;
window.closeSettings = closeSettings;
window.Mealog.closeSettings = closeSettings;
window.switchSettingsTab = switchSettingsTab;
window.Mealog.switchSettingsTab = switchSettingsTab;
window.saveSettings = saveSettings;
window.Mealog.saveSettings = saveSettings;
window.saveProfileSettings = saveProfileSettings;
window.Mealog.saveProfileSettings = saveProfileSettings;
window.selectIcon = selectIcon;
window.Mealog.selectIcon = selectIcon;
window.setSettingsProfileType = setSettingsProfileType;
window.Mealog.setSettingsProfileType = setSettingsProfileType;
window.handlePhotoUpload = handlePhotoUpload;
window.Mealog.handlePhotoUpload = handlePhotoUpload;
window.addTag = addTag;
window.Mealog.addTag = addTag;
window.removeTag = removeTag;
window.Mealog.removeTag = removeTag;
window.deleteSubTag = deleteSubTag;
window.Mealog.deleteSubTag = deleteSubTag;
window.addFavoriteTag = addFavoriteTag;
window.Mealog.addFavoriteTag = addFavoriteTag;
window.removeFavoriteTag = removeFavoriteTag;
window.Mealog.removeFavoriteTag = removeFavoriteTag;
window.selectFavoriteMainTag = selectFavoriteMainTag;
window.Mealog.selectFavoriteMainTag = selectFavoriteMainTag;
window.setDashboardMode = setDashboardMode;
window.Mealog.setDashboardMode = setDashboardMode;
window.updateCustomDates = updateCustomDates;
window.Mealog.updateCustomDates = updateCustomDates;
window.updateSelectedMonth = updateSelectedMonth;
window.Mealog.updateSelectedMonth = updateSelectedMonth;
window.updateSelectedWeek = updateSelectedWeek;
window.Mealog.updateSelectedWeek = updateSelectedWeek;
window.navigatePeriod = navigatePeriod;
window.Mealog.navigatePeriod = navigatePeriod;
window.openDetailModal = openDetailModal;
window.Mealog.openDetailModal = openDetailModal;
window.openCharacterSelectModal = openCharacterSelectModal;
window.Mealog.openCharacterSelectModal = openCharacterSelectModal;
window.closeCharacterSelectModal = closeCharacterSelectModal;
window.Mealog.closeCharacterSelectModal = closeCharacterSelectModal;
window.selectInsightCharacter = selectInsightCharacter;
window.Mealog.selectInsightCharacter = selectInsightCharacter;
window.generateInsightComment = generateInsightComment;
window.Mealog.generateInsightComment = generateInsightComment;
window.openShareInsightModal = openShareInsightModal;
window.Mealog.openShareInsightModal = openShareInsightModal;
window.closeShareInsightModal = closeShareInsightModal;
window.Mealog.closeShareInsightModal = closeShareInsightModal;
window.shareInsightToFeed = shareInsightToFeed;
window.Mealog.shareInsightToFeed = shareInsightToFeed;
window.closeDetailModal = closeDetailModal;
window.Mealog.closeDetailModal = closeDetailModal;
window.setAnalysisType = setAnalysisType;
window.Mealog.setAnalysisType = setAnalysisType;
window.openShareBestModal = openShareBestModal;
window.Mealog.openShareBestModal = openShareBestModal;
window.closeShareBestModal = closeShareBestModal;
window.Mealog.closeShareBestModal = closeShareBestModal;
window.shareBestToFeed = shareBestToFeed;
window.Mealog.shareBestToFeed = shareBestToFeed;
window.editBestShare = openEditBestShareModal;
window.Mealog.editBestShare = openEditBestShareModal;
window.editInsightShare = openEditInsightShareModal;
window.Mealog.editInsightShare = openEditInsightShareModal;
window.toggleComment = toggleComment;
window.Mealog.toggleComment = toggleComment;
window.toggleFeedComment = toggleFeedComment;
window.Mealog.toggleFeedComment = toggleFeedComment;
window.openKakaoPlaceSearch = openKakaoPlaceSearch;
window.Mealog.openKakaoPlaceSearch = openKakaoPlaceSearch;
window.searchKakaoPlaces = searchKakaoPlaces;
window.Mealog.searchKakaoPlaces = searchKakaoPlaces;
window.selectKakaoPlace = selectKakaoPlace;
window.Mealog.selectKakaoPlace = selectKakaoPlace;
window.boardOperations = boardOperations;
window.Mealog.boardOperations = boardOperations;
window.noticeOperations = noticeOperations;
window.Mealog.noticeOperations = noticeOperations;
window.renderBoard = renderBoard;
window.Mealog.renderBoard = renderBoard;
window.renderBoardDetail = renderBoardDetail;
window.Mealog.renderBoardDetail = renderBoardDetail;
window.renderNoticeDetail = renderNoticeDetail;
window.Mealog.renderNoticeDetail = renderNoticeDetail;

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
window.Mealog.requestLogin = window.requestLogin;

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
                likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800');
                likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
            } else {
                likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500');
                likeIcon.classList.add('fa-regular', 'fa-heart', 'text-slate-800');
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
window.Mealog.toggleLike = window.toggleLike;

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
window.Mealog.toggleBookmark = window.toggleBookmark;

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
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '게시 중...';
    }
    
    // 낙관적 업데이트: 즉시 UI에 반영
    const userProfile = window.userSettings?.profile || {};
    const userNickname = userProfile.nickname || window.userSettings?.nickname || '익명';
    const tempCommentId = `temp-${Date.now()}`;
    
    // 댓글 개수 즉시 증가
    if (commentCountEl) {
        const currentCount = parseInt(commentCountEl.textContent) || 0;
        commentCountEl.textContent = currentCount + 1;
    }
    
    // 댓글 목록에 즉시 추가
    if (commentsListEl) {
        const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
        const existingComments = commentsListEl.querySelectorAll('.mb-1.text-sm');
        const currentCommentCount = existingComments.length;
        
        // 기존 댓글이 2개 미만이면 새 댓글 추가
        if (currentCommentCount < 2) {
            commentsListEl.classList.add('bg-slate-50');
            const tempCommentHtml = `
                <div class="mb-1 text-sm" data-temp-comment-id="${tempCommentId}">
                    <span class="font-bold text-slate-800">${escapeHtml(userNickname)}</span>
                    <span class="text-slate-800">${escapeHtml(commentText)}</span>
                    ${isLoggedIn ? `<button onclick="window.deleteCommentFromPost('${tempCommentId}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                </div>
            `;
            commentsListEl.insertAdjacentHTML('beforeend', tempCommentHtml);
        }
        
        // "댓글 모두 보기" 버튼 표시
        if (viewCommentsBtn) {
            const newCount = (parseInt(commentCountEl?.textContent) || 0);
            if (newCount > 2) {
                viewCommentsBtn.textContent = `댓글 ${newCount}개 모두 보기`;
                viewCommentsBtn.classList.remove('hidden');
            }
        }
    }
    
    // 입력 필드 초기화
    inputEl.value = '';
    
    try {
        if (!postId || postId === 'undefined' || postId === 'null') {
            showToast("잘못된 포스트 ID입니다.", 'error');
            // 낙관적 업데이트 롤백
            if (commentCountEl) {
                const currentCount = parseInt(commentCountEl.textContent) || 0;
                commentCountEl.textContent = currentCount > 0 ? currentCount - 1 : '';
            }
            if (commentsListEl) {
                const tempComment = commentsListEl.querySelector(`[data-temp-comment-id="${tempCommentId}"]`);
                if (tempComment) tempComment.remove();
            }
            return;
        }
        
        const newComment = await postInteractions.addComment(postId, window.currentUser.uid, commentText, userProfile);
        
        if (!newComment) {
            showToast("댓글 추가에 실패했습니다.", 'error');
            // 낙관적 업데이트 롤백
            if (commentCountEl) {
                const currentCount = parseInt(commentCountEl.textContent) || 0;
                commentCountEl.textContent = currentCount > 0 ? currentCount - 1 : '';
            }
            if (commentsListEl) {
                const tempComment = commentsListEl.querySelector(`[data-temp-comment-id="${tempCommentId}"]`);
                if (tempComment) tempComment.remove();
            }
            return;
        }
        
        // 서버 응답으로 임시 댓글만 실제 id로 갱신 (getComments 제거 → 체감 속도 개선)
        if (commentsListEl && newComment.id) {
            const tempComment = commentsListEl.querySelector(`[data-temp-comment-id="${tempCommentId}"]`);
            if (tempComment) {
                tempComment.removeAttribute('data-temp-comment-id');
                tempComment.setAttribute('data-comment-id', newComment.id);
                const delBtn = tempComment.querySelector('button[onclick*="deleteCommentFromPost"]');
                if (delBtn) delBtn.setAttribute('onclick', `window.deleteCommentFromPost('${String(newComment.id).replace(/'/g, "\\'")}', '${postId}')`);
            }
        }
    } catch (e) {
        console.error("댓글 추가 실패:", e);
        showToast("댓글 추가 중 오류가 발생했습니다: " + (e.message || e), 'error');
        
        // 낙관적 업데이트 롤백
        if (commentCountEl) {
            const currentCount = parseInt(commentCountEl.textContent) || 0;
            commentCountEl.textContent = currentCount > 0 ? currentCount - 1 : '';
        }
        if (commentsListEl) {
            const tempComment = commentsListEl.querySelector(`[data-temp-comment-id="${tempCommentId}"]`);
            if (tempComment) tempComment.remove();
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '게시';
        }
    }
};

window.Mealog.addCommentToPost = window.addCommentToPost;

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
    
    const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
    
    // 낙관적 업데이트: 즉시 UI에서 제거
    const commentEl = commentsListEl?.querySelector(`[onclick*="deleteCommentFromPost('${commentId}'"]`)?.closest('.mb-1.text-sm');
    let wasVisible = false;
    if (commentEl) {
        wasVisible = true;
        commentEl.remove();
    }
    
    // 댓글 개수 즉시 감소
    if (commentCountEl) {
        const currentCount = parseInt(commentCountEl.textContent) || 0;
        commentCountEl.textContent = currentCount > 0 ? currentCount - 1 : '';
    }
    
    // 댓글 목록이 비어있으면 스타일 제거
    if (commentsListEl) {
        const remainingComments = commentsListEl.querySelectorAll('.mb-1.text-sm');
        if (remainingComments.length === 0) {
            commentsListEl.innerHTML = '';
            commentsListEl.classList.remove('bg-slate-50');
            if (viewCommentsBtn) viewCommentsBtn.classList.add('hidden');
        } else {
            // 댓글 개수 업데이트
            const newCount = parseInt(commentCountEl?.textContent) || 0;
            if (newCount <= 2 && viewCommentsBtn) {
                viewCommentsBtn.classList.add('hidden');
            } else if (viewCommentsBtn) {
                viewCommentsBtn.textContent = `댓글 ${newCount}개 모두 보기`;
            }
        }
    }
    
    try {
        const success = await postInteractions.deleteComment(commentId, window.currentUser.uid);
        if (success) {
            // 서버 응답 후 실제 데이터로 업데이트
            setTimeout(async () => {
                try {
                    const comments = await postInteractions.getComments(postId);
                    
                    // 댓글 개수 업데이트
                    if (commentCountEl) {
                        commentCountEl.textContent = comments.length > 0 ? comments.length : '';
                    }
                    
                    // 댓글 목록 업데이트
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
                } catch (e) {
                    console.error("댓글 목록 업데이트 실패:", e);
                    // 에러가 발생해도 낙관적 업데이트는 유지
                }
            }, 200);
            
            showToast("댓글이 삭제되었습니다.", 'success');
        } else {
            // 실패 시 롤백
            if (wasVisible && commentEl && commentsListEl) {
                commentsListEl.insertAdjacentElement('beforeend', commentEl);
            }
            if (commentCountEl) {
                const currentCount = parseInt(commentCountEl.textContent) || 0;
                commentCountEl.textContent = currentCount + 1;
            }
            showToast("댓글을 삭제할 수 없습니다.", 'error');
        }
    } catch (e) {
        console.error("댓글 삭제 실패:", e);
        // 실패 시 롤백
        if (wasVisible && commentEl && commentsListEl) {
            commentsListEl.insertAdjacentElement('beforeend', commentEl);
        }
        if (commentCountEl) {
            const currentCount = parseInt(commentCountEl.textContent) || 0;
            commentCountEl.textContent = currentCount + 1;
        }
        showToast("댓글 삭제 중 오류가 발생했습니다.", 'error');
    }
};

window.Mealog.deleteCommentFromPost = window.deleteCommentFromPost;

// 댓글 모두 보기 함수
window.viewAllComments = async (postId) => {
    try {
        const comments = await postInteractions.getComments(postId);
        const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
        const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
        
        if (commentsListEl) {
            if (comments.length > 0) {
                commentsListEl.classList.add('bg-slate-50');
                const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                commentsListEl.innerHTML = comments.map(comment => {
                    // timestamp가 유효한지 확인
                    let dateStr = '';
                    let timeStr = '';
                    if (comment.timestamp) {
                        try {
                            const commentDate = comment.timestamp instanceof Date 
                                ? comment.timestamp 
                                : (comment.timestamp.toDate ? comment.timestamp.toDate() : new Date(comment.timestamp));
                            
                            if (!isNaN(commentDate.getTime())) {
                                dateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                                timeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            }
                        } catch (e) {
                            console.warn('댓글 날짜 파싱 실패:', comment.timestamp, e);
                        }
                    }
                    
                    const isMyComment = isLoggedIn && comment.userId === window.currentUser.uid;
                    return `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${escapeHtml(comment.userNickname || '익명')}</span>
                            <span class="text-slate-800 ml-2">${escapeHtml(comment.comment || '')}</span>
                            ${dateStr && timeStr ? `<span class="text-xs text-slate-400 ml-2">${dateStr} ${timeStr}</span>` : ''}
                            ${isMyComment ? `<button onclick="window.deleteCommentFromPost('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `;
                }).join('');
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
window.Mealog.viewAllComments = window.viewAllComments;

// 댓글 모두 보기 함수 (기존 함수명 유지)
window.showAllComments = window.viewAllComments;

// 댓글 입력 필드 토글 (댓글 버튼 클릭 시)
window.toggleCommentInput = (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        window.requestLogin();
        return;
    }
    const inputEl = document.getElementById(`comment-input-${postId}`);
    const commentSection = document.getElementById(`comment-section-${postId}`);
    if (inputEl) {
        const isHidden = inputEl.classList.contains('hidden');
        if (isHidden) {
            inputEl.classList.remove('hidden');
            if (commentSection) commentSection.classList.add('comment-input-open');
            const textInput = document.getElementById(`comment-text-${postId}`);
            if (textInput) {
                textInput.focus();
            }
        } else {
            inputEl.classList.add('hidden');
            if (commentSection) commentSection.classList.remove('comment-input-open');
        }
    }
};

// 피드 댓글 작성 함수 (앨범/밀톡 공통)
window.submitComment = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    
    const inputEl = document.getElementById(`comment-text-${postId}`);
    if (!inputEl) return;
    
    const commentText = inputEl.value.trim();
    if (!commentText) {
        showToast("댓글을 입력해주세요.", 'error');
        return;
    }
    
    const commentsListEl = document.getElementById(`comments-list-${postId}`);
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
    const userProfile = window.userSettings?.profile || {};
    const userNickname = userProfile?.nickname || '익명';
    const tempId = `temp-${Date.now()}`;
    
    // 입력 필드 비활성화 + 즉시 비우기 (더블 탭 방지)
    inputEl.disabled = true;
    inputEl.value = '';
    
    // 낙관적 업데이트: 댓글 한 줄 즉시 표시
    if (commentsListEl) {
        commentsListEl.classList.add('bg-slate-50');
        commentsListEl.insertAdjacentHTML('beforeend',
            `<div class="mb-1 text-sm" data-temp-comment-id="${tempId}">
                <span class="font-bold text-slate-800">${escapeHtml(userNickname)}</span>
                <span class="text-slate-800 ml-2">${escapeHtml(commentText)}</span>
            </div>`);
        const commentSection = document.getElementById(`comment-section-${postId}`);
        if (commentSection) commentSection.classList.remove('comments-empty');
    }
    if (commentCountEl) {
        const n = (parseInt(commentCountEl.textContent || '0', 10) || 0) + 1;
        commentCountEl.textContent = n;
        if (viewCommentsBtn && n > 2) {
            viewCommentsBtn.classList.remove('hidden');
            viewCommentsBtn.textContent = `댓글 ${n}개 모두 보기`;
        }
    }
    
    try {
        const result = await postInteractions.addComment(postId, window.currentUser.uid, commentText, userProfile);
        if (!result || !result.id) {
            throw new Error('댓글 등록 결과가 없습니다.');
        }
        // 임시 줄을 실제 id가 반영된 한 줄로 교체 (loadPostComments 호출 제거로 체감 속도 개선)
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-temp-comment-id="${tempId}"]`);
            if (tempRow) {
                let dateStr = '', timeStr = '';
                if (result.timestamp) {
                    try {
                        const d = new Date(result.timestamp);
                        if (!isNaN(d.getTime())) {
                            dateStr = d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                            timeStr = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                        }
                    } catch (_) {}
                }
                const safeId = String(result.id).replace(/'/g, "\\'");
                tempRow.outerHTML = `
                    <div class="mb-1 text-sm">
                        <span class="font-bold text-slate-800">${escapeHtml(result.userNickname || '익명')}</span>
                        <span class="text-slate-800 ml-2">${escapeHtml(result.comment || '')}</span>
                        ${dateStr && timeStr ? `<span class="text-xs text-slate-400 ml-2">${dateStr} ${timeStr}</span>` : ''}
                        <button onclick="window.deleteCommentFromPost('${safeId}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>
                    </div>`;
            }
        }
    } catch (e) {
        console.error("[submitComment] 에러:", e);
        const errorMessage = e.message || e.details || e.code || "댓글 작성에 실패했습니다.";
        showToast(errorMessage, 'error');
        // 낙관적 업데이트 롤백
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-temp-comment-id="${tempId}"]`);
            if (tempRow) tempRow.remove();
            const left = commentsListEl.querySelectorAll('.mb-1.text-sm').length;
            if (left === 0) commentsListEl.classList.remove('bg-slate-50');
        }
        if (commentCountEl) {
            const n = Math.max(0, (parseInt(commentCountEl.textContent || '0', 10) || 0) - 1);
            commentCountEl.textContent = n || '';
            if (viewCommentsBtn && n <= 2) viewCommentsBtn.classList.add('hidden');
            else if (viewCommentsBtn && n > 2) viewCommentsBtn.textContent = `댓글 ${n}개 모두 보기`;
        }
    } finally {
        inputEl.disabled = false;
    }
};

// 포스트 댓글 로드 함수
async function loadPostComments(postId) {
    try {
        const comments = await postInteractions.getComments(postId);
        const commentsListEl = document.getElementById(`comments-list-${postId}`);
        const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
        
        if (commentCountEl) {
            commentCountEl.textContent = comments.length > 0 ? comments.length : '';
        }
        
        if (commentsListEl) {
            if (comments.length === 0) {
                commentsListEl.innerHTML = '';
                commentsListEl.classList.remove('bg-slate-50');
            } else {
                commentsListEl.classList.add('bg-slate-50');
                const displayComments = comments.slice(0, 2);
                commentsListEl.innerHTML = displayComments.map(comment => {
                    // timestamp가 유효한지 확인
                    let dateStr = '';
                    let timeStr = '';
                    if (comment.timestamp) {
                        try {
                            const commentDate = comment.timestamp instanceof Date 
                                ? comment.timestamp 
                                : (comment.timestamp.toDate ? comment.timestamp.toDate() : new Date(comment.timestamp));
                            
                            if (!isNaN(commentDate.getTime())) {
                                dateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                                timeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            }
                        } catch (e) {
                            console.warn('댓글 날짜 파싱 실패:', comment.timestamp, e);
                        }
                    }
                    
                    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                    const isMyComment = isLoggedIn && comment.userId === window.currentUser.uid;
                    return `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${escapeHtml(comment.userNickname || '익명')}</span>
                            <span class="text-slate-800 ml-2">${escapeHtml(comment.comment || '')}</span>
                            ${dateStr && timeStr ? `<span class="text-xs text-slate-400 ml-2">${dateStr} ${timeStr}</span>` : ''}
                            ${isMyComment ? `<button onclick="window.deleteCommentFromPost('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `;
                }).join('');
                
                // 댓글이 2개보다 많으면 "댓글 모두 보기" 버튼 표시
                if (comments.length > 2) {
                    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.remove('hidden');
                        viewCommentsBtn.textContent = `댓글 ${comments.length}개 모두 보기`;
                    }
                } else {
                    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.add('hidden');
                    }
                }
            }
        }
    } catch (e) {
        console.error("댓글 로드 실패:", e);
    }
}
window.loadPostComments = loadPostComments;
window.Mealog.loadPostComments = loadPostComments;

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

// escapeHtml은 render/index.js에서 import됨

// 일간보기 공유: 이미 공유된 경우 해제, 아니면 미리보기 모달 열기
window.shareDailySummary = async (dateStr) => {
    const existingShare = window.sharedPhotos && Array.isArray(window.sharedPhotos)
        ? window.sharedPhotos.find(photo => photo.type === 'daily' && photo.date === dateStr && photo.userId === window.currentUser.uid)
        : null;

    if (existingShare) {
        const photoUrlToRemove = existingShare.photoUrl;
        const prevShared = window.sharedPhotos ? [...window.sharedPhotos] : [];
        if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
            window.sharedPhotos = window.sharedPhotos.filter(p =>
                !(p.type === 'daily' && p.date === dateStr && p.userId === window.currentUser.uid)
            );
        }
        if (appState.currentTab === 'timeline') renderTimeline();
        if (appState.currentTab === 'gallery') renderGallery();
        showToast('공유가 해제되었습니다.', 'success');
        dbOps.unsharePhotos([photoUrlToRemove], null, false, true).catch(() => {
            if (window.sharedPhotos) window.sharedPhotos = prevShared;
            if (appState.currentTab === 'timeline') renderTimeline();
            if (appState.currentTab === 'gallery') renderGallery();
        });
        return;
    }

    window.openDailySharePreviewModal(dateStr);
};

// 일간 식단 공유 미리보기 모달 열기
window.openDailySharePreviewModal = (dateStr) => {
    const existing = document.getElementById('dailySharePreviewModal');
    if (existing) existing.remove();

    const previewCard = createDailyShareCard(dateStr, true);

    const modal = document.createElement('div');
    modal.id = 'dailySharePreviewModal';
    modal.className = 'fixed inset-0 z-[500] flex items-end bg-black/50';

    modal.innerHTML = `
        <div class="relative w-full max-w-md mx-auto bg-white rounded-t-[2rem] flex flex-col max-h-[92vh] shadow-2xl">
            <div id="dailyShareLoadingOverlay" class="hidden absolute inset-0 bg-white/90 rounded-t-[2rem] flex flex-col items-center justify-center z-20">
                <div class="w-10 h-10 border-4 border-emerald-100 border-t-emerald-600 rounded-full animate-spin mb-3"></div>
                <p class="text-slate-600 font-bold">공유 중...</p>
            </div>
            <div class="flex justify-between items-center p-4 border-b border-slate-100 flex-shrink-0">
                <h3 class="text-lg font-black text-slate-800">일간 식단 공유 미리보기</h3>
                <button onclick="window.closeDailySharePreviewModal()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-full">
                    <i class="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>
            <div id="dailySharePreviewScroll" class="flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 py-0 min-h-0" style="padding: 3px;">
                <!-- createDailyShareCard(forPreview) 결과가 여기 들어감 -->
            </div>
            <div class="flex gap-3 p-4 border-t border-slate-100 flex-shrink-0">
                <button onclick="window.closeDailySharePreviewModal()" class="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm">
                    취소
                </button>
                <button onclick="window.confirmDailyShare('${dateStr}')" class="flex-1 py-4 bg-emerald-600 text-white rounded-xl font-bold active:bg-emerald-700 shadow-lg transition-all">
                    공유
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    const scrollEl = document.getElementById('dailySharePreviewScroll');
    if (scrollEl && previewCard) {
        scrollEl.appendChild(previewCard);
        // 처음부터 화면 안쪽을 꽉 채워서 보여주기 위해 스크롤을 상단으로
        setTimeout(() => {
            scrollEl.scrollTop = 0;
        }, 0);
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) window.closeDailySharePreviewModal();
    });
};

// 일간 공유 미리보기 모달 닫기
window.closeDailySharePreviewModal = () => {
    const modal = document.getElementById('dailySharePreviewModal');
    if (modal) modal.remove();
};

// 미리보기에서 공유 확정: 미리보기 화면을 그대로 캡쳐해서 공유
window.confirmDailyShare = async (dateStr) => {
    const previewModal = document.getElementById('dailySharePreviewModal');
    const inModalSpinner = previewModal?.querySelector('#dailyShareLoadingOverlay');
    if (inModalSpinner) inModalSpinner.classList.remove('hidden');

    const shareBtn = event?.target || document.querySelector(`button[onclick*="confirmDailyShare('${dateStr}')"]`);
    if (shareBtn) {
        shareBtn.disabled = true;
        shareBtn.classList.add('opacity-50', 'cursor-not-allowed');
        shareBtn.textContent = '공유 중...';
    }
    // 스피너가 실제로 화면에 그려진 뒤 무거운 작업 진행 (두 프레임 양보로 페인트 확실히 반영)
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 50));

    try {
        if (!previewModal) {
            throw new Error('미리보기 모달을 찾을 수 없습니다.');
        }

        const previewCard = previewModal.querySelector('#dailyShareCardContainer');
        if (!previewCard) {
            throw new Error('미리보기 카드를 찾을 수 없습니다.');
        }

        // Fredoka 폰트 CSS를 미리 가져와서 실제 @font-face URL 추출
        let fredokaFontCSS = '';
        // 폰트가 이미 로드되어 있는지 먼저 확인
        const fontAlreadyLoaded = document.fonts.check('1em Fredoka');
        
        if (!fontAlreadyLoaded) {
            try {
                const fontCSSResponse = await fetch('https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;500;600;700&display=swap');
                fredokaFontCSS = await fontCSSResponse.text();
                // CSS를 스타일 태그로 추가하여 폰트 로드
                const styleTag = document.createElement('style');
                styleTag.textContent = fredokaFontCSS;
                document.head.appendChild(styleTag);
                
                await document.fonts.ready;
                let attempts = 0;
                while (attempts < 10) {
                    if (document.fonts.check('1em Fredoka')) break;
                    await new Promise(resolve => setTimeout(resolve, 50));
                    attempts++;
                }
            } catch (e) {
                console.warn('Fredoka 폰트 CSS 로드 실패:', e);
            }
        }
        
        // 이미지 로드 확인 (이미 로드된 이미지는 즉시 스킵)
        const images = previewCard.querySelectorAll('img');
        const imageLoadPromises = Array.from(images).map(img => {
            if (img.complete && img.naturalWidth > 0) {
                return Promise.resolve(); // 이미 로드된 이미지
            }
            return new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 400);
            });
        });
        await Promise.all(imageLoadPromises);

        const innerContent = previewCard.querySelector('div[style*="width: 420px"]') || previewCard;
        let actualHeight = innerContent.offsetHeight || innerContent.scrollHeight;
        if (!actualHeight || actualHeight < 100) {
            await new Promise(resolve => setTimeout(resolve, 50));
            actualHeight = innerContent.offsetHeight || innerContent.scrollHeight;
        }

        actualHeight = Math.ceil(actualHeight);

        // 미리보기 카드를 그대로 캡쳐
        const canvas = await html2canvas(innerContent, {
            backgroundColor: '#ffffff',
            scale: 2,
            logging: false,
            useCORS: true,
            width: 420,
            height: actualHeight,
            x: 0,
            y: 0,
            scrollX: 0,
            scrollY: 0,
            allowTaint: false,
            foreignObjectRendering: false,
            fontEmbedCSS: true,
            onclone: (clonedDoc) => {
                // 복제된 문서에 Fredoka 폰트 CSS를 직접 주입
                if (fredokaFontCSS) {
                    const clonedStyle = clonedDoc.createElement('style');
                    clonedStyle.textContent = fredokaFontCSS;
                    clonedDoc.head.appendChild(clonedStyle);
                } else {
                    // 폴백: 직접 @font-face 정의
                    const clonedStyle = clonedDoc.createElement('style');
                    clonedStyle.textContent = `
                        @font-face {
                            font-family: 'Fredoka';
                            font-style: normal;
                            font-weight: 700;
                            font-display: swap;
                            src: url('https://fonts.gstatic.com/s/fredoka/v14/X7nP4b87HvSqjb_WIi2yDCRwoQ_k7367_DWs89XyHw.woff2') format('woff2');
                            unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
                        }
                    `;
                    clonedDoc.head.appendChild(clonedStyle);
                }
                
                // 복제된 문서의 모든 MEALOG 텍스트에 Fredoka 폰트 강제 적용
                const allSpans = clonedDoc.querySelectorAll('span');
                allSpans.forEach(el => {
                    const style = el.getAttribute('style') || '';
                    const text = el.textContent.trim();
                    if (style.includes('MEALOG') || text === 'MEALOG' || (style.includes('font-family') && style.includes('Fredoka'))) {
                        el.style.fontFamily = "'Fredoka', sans-serif";
                        el.style.fontWeight = '700';
                    }
                });
            }
        });

        const base64Image = canvas.toDataURL('image/png');
        const { uploadBase64ToStorage } = await import('./utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, window.currentUser.uid, `daily_${dateStr}`);

        const userProfile = window.userSettings?.profile || {};

        let dailyComment = '';
        try {
            if (window.dbOps && typeof window.dbOps.getDailyComment === 'function') {
                dailyComment = window.dbOps.getDailyComment(dateStr) || '';
            } else if (window.userSettings && window.userSettings.dailyComments) {
                dailyComment = window.userSettings.dailyComments[dateStr] || '';
            }
        } catch (e) {
            console.warn('getDailyComment 호출 실패:', e);
        }

        // 낙관적 UI: 클라이언트 데이터로 즉시 반영 후 서버는 백그라운드 호출
        const dailyShareData = {
            id: 'pending-' + Date.now(),
            photoUrl,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            userPhotoUrl: userProfile.photoUrl || null,
            type: 'daily',
            date: dateStr,
            timestamp: new Date().toISOString(),
            entryId: null,
            comment: dailyComment || ''
        };

        if (!window.sharedPhotos) window.sharedPhotos = [];
        window.sharedPhotos = window.sharedPhotos.filter(p =>
            !(p.type === 'daily' && p.date === dateStr && p.userId === window.currentUser.uid)
        );
        window.sharedPhotos.push(dailyShareData);
        window.sharedPhotos.sort((a, b) => (new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()));

        window.closeDailySharePreviewModal();
        showToast('하루 기록이 피드에 공유되었습니다!', 'success');
        if (appState.currentTab === 'timeline') renderTimeline();
        if (appState.currentTab === 'gallery') renderGallery();

        const { callableFunctions } = await import('./firebase.js');
        callableFunctions.createDailyShare({
            photoUrl,
            date: dateStr,
            comment: dailyComment
        }).then((result) => {
            const serverData = result.data;
            const idx = window.sharedPhotos?.findIndex(p => p.id === dailyShareData.id || (p.type === 'daily' && p.date === dateStr && p.userId === window.currentUser.uid && p.photoUrl === photoUrl));
            if (idx !== undefined && idx !== -1 && window.sharedPhotos) {
                window.sharedPhotos[idx] = serverData;
                if (appState.currentTab === 'timeline') renderTimeline();
                if (appState.currentTab === 'gallery') renderGallery();
            }
        }).catch((e) => {
            console.error('일간보기 공유 서버 반영 실패:', e);
            if (window.sharedPhotos) {
                window.sharedPhotos = window.sharedPhotos.filter(p =>
                    !(p.type === 'daily' && p.date === dateStr && p.userId === window.currentUser.uid)
                );
                if (appState.currentTab === 'timeline') renderTimeline();
                if (appState.currentTab === 'gallery') renderGallery();
            }
            showToast(e?.message || e?.details || '공유 반영에 실패했습니다. 다시 시도해 주세요.', 'error');
        });
    } catch (e) {
        console.error('일간보기 공유 실패:', e);
        const errorMessage = e.message || e.details || '공유 중 오류가 발생했습니다.';
        showToast(errorMessage, 'error');
        window.closeDailySharePreviewModal();
    } finally {
        const modal = document.getElementById('dailySharePreviewModal');
        const spinner = modal?.querySelector('#dailyShareLoadingOverlay');
        if (spinner) spinner.classList.add('hidden');
        // 버튼 상태 복원 (모달이 아직 DOM에 있을 때만)
        const shareBtn = document.querySelector(`button[onclick*="confirmDailyShare('${dateStr}')"]`);
        if (shareBtn) {
            shareBtn.disabled = false;
            shareBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            shareBtn.textContent = '공유';
        }
    }
};

// 일간보기 실제 공유 실행 (캡처 → 업로드 → Firestore) - 사용하지 않음 (confirmDailyShare에서 직접 처리)
/*
window.executeDailyShare = async (dateStr) => {
    // 이 함수는 더 이상 사용하지 않습니다. confirmDailyShare에서 미리보기 화면을 직접 캡쳐합니다.
};
*/

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
        
        // 타임라인과 앨범 새로고침
        if (appState.currentTab === 'timeline') {
            renderTimeline();
        }
        if (appState.currentTab === 'gallery') {
            renderGallery();
        }
    } catch (e) {
        console.error("Daily Comment Save Error:", e);
        showToast("저장 중 오류가 발생했습니다.", 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 일간보기 코멘트 수정 모달 열기
window.openDailyCommentModal = (dateStr) => {
    // 기존 모달 제거
    const existingModal = document.getElementById('dailyCommentModal');
    if (existingModal) existingModal.remove();
    
    // 날짜 포맷팅
    const dateObj = new Date(dateStr + 'T00:00:00');
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();
    const dateLabel = `${year}년 ${month}월 ${day}일`;
    
    // 현재 코멘트 가져오기
    let currentComment = '';
    try {
        if (window.dbOps && typeof window.dbOps.getDailyComment === 'function') {
            currentComment = window.dbOps.getDailyComment(dateStr) || '';
        } else if (window.userSettings && window.userSettings.dailyComments) {
            currentComment = window.userSettings.dailyComments[dateStr] || '';
        }
    } catch (e) {
        console.warn('getDailyComment 호출 실패:', e);
    }
    
    // 모달 생성
    const modal = document.createElement('div');
    modal.id = 'dailyCommentModal';
    modal.className = 'fixed inset-0 z-[500] flex items-center justify-center p-4 bg-black/50';
    
    modal.innerHTML = `
        <div class="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-black text-slate-800">하루 소감 수정</h3>
                <button onclick="window.closeDailyCommentModal()" class="text-slate-400 hover:text-slate-600">
                    <i class="fa-solid fa-xmark text-xl"></i>
                </button>
            </div>
            <textarea id="dailyCommentModalInput" 
                placeholder="오늘 하루는 어떠셨나요? 하루 전체에 대한 생각을 기록해보세요." 
                class="w-full p-4 bg-slate-50 rounded-xl text-sm border border-slate-200 focus:border-slate-400 transition-all resize-none min-h-[150px]" 
                rows="6">${escapeHtml(currentComment)}</textarea>
            <div class="flex gap-3 mt-6">
                <button onclick="window.closeDailyCommentModal()" class="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm">
                    취소
                </button>
                <button onclick="window.saveDailyCommentFromModal('${dateStr}')" class="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700">
                    저장
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 배경 클릭 시 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            window.closeDailyCommentModal();
        }
    });
    
    // 포커스
    setTimeout(() => {
        const input = document.getElementById('dailyCommentModalInput');
        if (input) input.focus();
    }, 100);
};

// 일간보기 코멘트 모달 닫기
window.closeDailyCommentModal = () => {
    const modal = document.getElementById('dailyCommentModal');
    if (modal) modal.remove();
};

// 모달에서 일간보기 코멘트 저장
window.saveDailyCommentFromModal = async (dateStr) => {
    const input = document.getElementById('dailyCommentModalInput');
    if (!input) return;
    
    const comment = input.value || '';
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        await dbOps.saveDailyComment(dateStr, comment);
        showToast("하루 소감이 저장되었습니다.", 'success');
        window.closeDailyCommentModal();
        
        // 타임라인과 앨범 새로고침
        if (appState.currentTab === 'timeline') {
            renderTimeline();
        }
        if (appState.currentTab === 'gallery') {
            renderGallery();
        }
        if (appState.currentTab === 'feed') {
            renderFeed();
        }
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
    try {
        console.log('[탭전환] 시작:', { 이전탭: appState.currentTab, 새탭: tab });
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
        
        if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
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
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    const timelineSearchPanel = document.getElementById('timelineSearchPanel');
    if (searchBtn) searchBtn.style.display = (tab === 'timeline') ? 'flex' : 'none';
    if (timelineSearchPanel) {
        if (tab === 'timeline') {
            timelineSearchPanel.classList.remove('hidden');
        } else {
            timelineSearchPanel.classList.add('hidden');
            timelineSearchPanel.classList.remove('expanded');
        }
    }
    if (tracePanel) {
        if (tab === 'gallery' || tab === 'board') {
            tracePanel.classList.remove('hidden');
        } else {
            tracePanel.classList.add('hidden');
            tracePanel.classList.remove('expanded');
        }
    }
    
    if (tab === 'dashboard') {
        updateDashboard();
    } else if (tab === 'gallery') {
        // 리스너가 업데이트될 시간을 주기 위해 약간의 지연 후 렌더링
        setTimeout(() => {
            renderGallery();
            // 갤러리 탭으로 전환 시 맨 위로 스크롤
            setTimeout(() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }, 100);
        }, 200);
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
    console.log('[탭전환] 완료:', { 현재탭: appState.currentTab });
    } catch (error) {
        console.error('[탭전환] 오류 발생:', error);
        console.error('[탭전환] 스택:', error.stack);
        // 오류 발생 시에도 기본 탭 상태는 유지
        showToast('탭 전환 중 오류가 발생했습니다.', 'error');
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

window.toggleGalleryTracePanel = () => {
    const panel = document.getElementById('galleryTraceFilterPanel');
    if (panel) panel.classList.toggle('expanded');
    if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
};

/** 타임라인 검색 확장 너비: 타이틀(MEALOG) 오른쪽에서 20px 거리까지 (화면 크기 무관) */
function updateTimelineSearchExpandWidth() {
    const title = document.querySelector('header .mealog-title');
    const wrapper = document.getElementById('timelineSearchPanel');
    const panel = wrapper?.querySelector('.timeline-search-panel');
    if (!title || !wrapper || !panel || !wrapper.classList.contains('expanded')) return;
    const titleRight = title.getBoundingClientRect().right;
    const wrapperRight = wrapper.getBoundingClientRect().right;
    let w = wrapperRight - titleRight - 20;
    w = Math.max(96, w);
    panel.style.width = `${w}px`;
}

window.toggleSearch = () => {
    if (appState.currentTab === 'gallery' || appState.currentTab === 'board') {
        window.toggleGalleryTracePanel();
        return;
    }
    const panel = document.getElementById('timelineSearchPanel');
    if (!panel) return;
    if (panel.classList.contains('expanded')) {
        window.closeSearch();
    } else {
        panel.classList.add('expanded');
        requestAnimationFrame(updateTimelineSearchExpandWidth);
        document.getElementById('searchInput')?.focus();
    }
};

window.closeSearch = () => {
    const wrapper = document.getElementById('timelineSearchPanel');
    if (wrapper) {
        wrapper.classList.remove('expanded');
        const panel = wrapper.querySelector('.timeline-search-panel');
        if (panel) panel.style.width = '';
    }
    document.getElementById('searchInput')?.blur();
    const inp = document.getElementById('searchInput');
    if (inp) inp.value = '';
    window.loadedDates = [];
    const tc = document.getElementById('timelineContainer');
    if (tc) tc.innerHTML = '';
    renderTimeline();
};

window.addEventListener('resize', updateTimelineSearchExpandWidth);

// 앨범/밀톡 흔적 필터 패널 버튼 상태 갱신
window.updateGalleryTraceFilterBarUI = () => {
    const panel = document.getElementById('galleryTraceFilterPanel');
    if (!panel) return;
    const f = appState.currentTab === 'board' ? appState.boardTraceFilter : appState.galleryTraceFilter;
    ['like', 'comment', 'bookmark'].forEach((trace) => {
        const btn = panel.querySelector(`[data-trace="${trace}"]`);
        if (!btn) return;
        const icon = btn.querySelector('i');
        const isActive = f === trace;
        btn.classList.toggle('bg-slate-100', isActive);
        btn.classList.toggle('text-slate-700', isActive && trace !== 'like');
        btn.classList.remove('text-red-500');
        if (trace === 'like') {
            if (isActive) { btn.classList.add('text-red-500'); }
            if (icon) {
                icon.classList.remove('fa-regular', 'fa-solid', 'fa-heart');
                icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-heart');
            }
        } else if (trace === 'comment' && icon) {
            icon.classList.remove('fa-regular', 'fa-solid');
            icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-comment');
        } else if (trace === 'bookmark' && icon) {
            icon.classList.remove('fa-regular', 'fa-solid');
            icon.classList.add(isActive ? 'fa-solid' : 'fa-regular', 'fa-bookmark');
        }
    });
};

// 앨범/밀톡 흔적 필터 설정 및 다시 렌더 (같은 필터 재클릭 시 해제)
window.setGalleryTraceFilter = (value) => {
    if (!value || value === 'collapse') return;
    const v = value === '' || value == null ? null : value;
    if (v && (!window.currentUser || window.currentUser.isAnonymous)) {
        showToast('로그인이 필요합니다.', 'info');
        window.requestLogin();
        return;
    }
    if (appState.currentTab === 'board') {
        appState.boardTraceFilter = (appState.boardTraceFilter === v) ? null : v;
    } else {
        appState.galleryTraceFilter = (appState.galleryTraceFilter === v) ? null : v;
    }
    if (typeof window.updateGalleryTraceFilterBarUI === 'function') window.updateGalleryTraceFilterBarUI();
    
    if (appState.currentTab === 'gallery') {
        renderGallery();
    } else if (appState.currentTab === 'board') {
        const category = window.currentBoardCategory || 'all';
        renderBoard(category);
    }
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

/**
 * 사용자 문서 업데이트 (가입일, 마지막 로그인 날짜)
 */
async function updateUserDocument(user) {
    if (!user || user.isAnonymous) return;
    
    try {
        const userDocRef = doc(db, 'artifacts', appId, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        
        const updateData = {
            lastLoginAt: serverTimestamp()
        };
        
        if (!userDocSnap.exists()) {
            // 신규 사용자: createdAt, providerId, email 모두 설정
            updateData.createdAt = serverTimestamp();
            
            // providerId와 email은 처음 한 번만 설정
            if (user.providerData && user.providerData.length > 0) {
                updateData.providerId = user.providerData[0].providerId;
            }
            if (user.email) {
                updateData.email = user.email;
            }
            
            console.log('✅ 신규 사용자 문서 생성:', { 
                userId: user.uid,
                providerId: updateData.providerId,
                email: updateData.email
            });
        } else {
            // 기존 사용자: providerId와 email이 없을 때만 설정 (한 번만)
            const existingData = userDocSnap.data();
            if (!existingData.providerId && user.providerData && user.providerData.length > 0) {
                updateData.providerId = user.providerData[0].providerId;
                console.log('✅ providerId 초기 설정:', updateData.providerId);
            }
            if (!existingData.email && user.email) {
                updateData.email = user.email;
                console.log('✅ email 초기 설정:', updateData.email);
            }
            
            console.log('✅ 사용자 문서 업데이트 (마지막 로그인):', { userId: user.uid });
        }
        
        await setDoc(userDocRef, updateData, { merge: true });
    } catch (e) {
        console.error('❌ 사용자 문서 업데이트 실패:', e);
        // 에러가 발생해도 계속 진행 (비중요한 정보이므로)
    }
}

// 인증 상태 변경 리스너 - 단순화된 버전
let lastProcessedUserId = null; // 마지막으로 처리한 사용자 ID
let isFirstLoad = true; // 첫 로드 여부

initAuth(async (user) => {
    // 페이지 로드 시 자동으로 로그아웃 (테스트를 위한 설정)
    if (isFirstLoad && user && !user.isAnonymous) {
        isFirstLoad = false;
        console.log('🔄 페이지 로드 시 자동 로그아웃 실행');
        await signOut(auth);
        // 로그아웃 후 리턴 (다음 onAuthStateChanged에서 null user로 다시 호출됨)
        return;
    }
    isFirstLoad = false;
    // 1. 관리자 페이지가 열려있는지 확인 (현재 탭이 관리자 페이지인 경우)
    if (window.location.pathname.includes('admin.html') || window.location.href.includes('admin.html')) {
        console.log('⚠️ 관리자 페이지에서 인증 상태 변경 무시');
        return;
    }
    
    // 2. 갑작스러운 게스트 전환 방지: 이전에 로그인된 사용자가 있었는데 갑자기 게스트로 전환되는 경우
    // 하지만 Firestore 규칙은 request.auth를 확인하므로, 실제 인증 상태를 확인해야 함
    if ((!user || user.isAnonymous) && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous) {
        // 실제 auth.currentUser를 확인하여 관리자 페이지 영향인지 확인
        const actualCurrentUser = auth.currentUser;
        
        // 실제 인증 상태가 게스트이거나 null이고, 이전에 로그인된 사용자가 있었으면
        // 관리자 페이지 영향일 가능성이 높지만, Firestore 규칙이 작동하려면 실제 인증 상태가 필요함
        // 따라서 이 경우는 무시하지 않고, 실제 인증 상태를 확인하여 처리
        if ((!actualCurrentUser || actualCurrentUser.isAnonymous) && actualCurrentUser?.uid !== lastProcessedUserId) {
            console.log('⚠️ 로그인된 사용자가 게스트로 전환 감지 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email,
                currentUser: user?.uid || 'null',
                actualAuthUser: actualCurrentUser?.uid || 'null'
            });
            // 실제 인증 상태가 게스트이면 Firestore 규칙이 작동하지 않으므로
            // 이전 사용자 정보를 유지하되, 실제 인증 상태가 복원될 때까지 대기
            // 하지만 이 경우는 실제로 인증 상태가 변경되었으므로, 무시하지 않고 처리해야 함
            // 대신 이전 사용자 정보를 유지하고, 실제 인증 상태가 복원되면 다시 처리
            return;
        }
    }
    
    // 3. 로그아웃 시에도 이전 사용자가 있었으면 무시 (관리자 페이지 영향 가능)
    // 단, 명시적 로그아웃인 경우는 허용 (sessionStorage에서 확인)
    const isExplicitLogout = sessionStorage.getItem('explicitLogout') === 'true';
    if (!user && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous && !isExplicitLogout) {
        // 실제 auth.currentUser를 확인
        const actualCurrentUser = auth.currentUser;
        
        // 실제 인증 상태가 null이고, 이전에 로그인된 사용자가 있었으면 무시
        if (!actualCurrentUser || actualCurrentUser.isAnonymous) {
            console.log('⚠️ 로그인된 사용자가 로그아웃 시도 - 무시 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email,
                actualAuthUser: actualCurrentUser?.uid || 'null'
            });
            // 현재 사용자 상태 유지 - 인증 상태 변경 무시
            return;
        }
    }
    
    // 명시적 로그아웃 플래그 초기화 (사용 후 제거)
    if (isExplicitLogout) {
        sessionStorage.removeItem('explicitLogout');
    }
    
    if (user) {
        // 사용자 변경 감지: 다른 사용자로 로그인한 경우 이전 리스너 완전히 해제
        if (lastProcessedUserId && lastProcessedUserId !== user.uid) {
            console.log('⚠️ 사용자 변경 감지:', { 
                previousUserId: lastProcessedUserId, 
                newUserId: user.uid,
                previousEmail: window.currentUser?.email,
                newEmail: user.email
            });
            
            // 모든 리스너 해제
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
            
            // 전역 상태 초기화
            window.userSettings = null;
            window.mealHistory = null;
            window.sharedPhotos = null;
            window._duplicateCleanupDone = false;
            authFlowManager.hasCompleted = false;
            authFlowManager.lastProcessedUserId = null;
            
            console.log('✅ 이전 사용자 리스너 및 상태 초기화 완료');
        }
        
        window.currentUser = user;
        lastProcessedUserId = user.uid;
        
        console.log('🔐 인증 상태 변경:', {
            uid: user.uid,
            email: user.email,
            providerId: user.providerData?.[0]?.providerId,
            isAnonymous: user.isAnonymous
        });
        
        // 사용자 문서 업데이트 (가입일, 마지막 로그인 날짜)
        // 로그인 플로우를 지연시키지 않기 위해 비동기로 나중에 실행
        updateUserDocument(user).catch(e => {
            console.warn('사용자 문서 업데이트 실패 (무시):', e);
        });
        
        // 이미 메인 화면이 표시되어 있으면 보통은 추가 처리 없이 리턴.
        // 단, 게스트 → 이메일/구글 로그인처럼 "메인 화면 위에서" 인증이 바뀌는 경우,
        // 약관/프로필 플로우 및 리스너 설정이 반드시 필요하므로 여기서 종료하면 안 됨.
        const mainApp = document.getElementById('mainApp');
        const landingPage = document.getElementById('landingPage');
        if (mainApp && !mainApp.classList.contains('hidden') && landingPage && landingPage.style.display === 'none') {
            const sameUser = lastProcessedUserId === user.uid;
            const readyToSkip =
                sameUser &&
                !user.isAnonymous &&
                !!window.userSettings &&
                authFlowManager.hasCompleted;
            if (readyToSkip) {
                return;
            }
        }
        
                // 중요: providerId와 email은 처음 로그인 시 약관 동의 또는 프로필 설정 시에만 설정됩니다.
                // 로그인 직후 자동 저장은 하지 않습니다. (중복 저장 방지)
        
        // 중복 기록 자동 정리 (한 번만 실행)
        if (!window._duplicateCleanupDone && window.mealHistory && window.mealHistory.length > 0) {
            window._duplicateCleanupDone = true;
            setTimeout(async () => {
                await dbOps.removeDuplicateMeals();
            }, 2000);
        }
        
        // ✅ 게스트(익명) 모드:
        // - 내 meals/settings는 굳이 리스너를 붙이지 않음(기록/설정 기능도 제한됨)
        // - 대신 앨범(공유 피드)은 보여야 하므로 sharedPhotos 리스너는 유지
        if (user.isAnonymous) {
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
            }
            appState.sharedPhotosUnsubscribe = setupSharedPhotosListener((sharedPhotos) => {
                window.sharedPhotos = sharedPhotos;
                
                // 현재 탭에서만 렌더링 (다른 탭에서는 렌더링하지 않음 - 프리즈 방지)
                const currentTab = appState.currentTab;
                if (currentTab === 'gallery') {
                    renderGallery();
                } else if (currentTab === 'timeline') {
                    renderTimeline();
                }
                // analytics, dashboard 등 다른 탭에서는 렌더링하지 않음
            });
            
            // 게스트 모드일 때 헤더 UI 업데이트
            updateHeaderUI();
        } else {
            // 리스너 설정 (이전 리스너는 setupListeners 내부에서 해제됨)
            let dataUpdateTimer = null; // 공유 시 meals 이중 리스너 방지용 디바운스
            const { settingsUnsubscribe, dataUnsubscribe } = setupListeners(user.uid, {
                onSettingsUpdate: () => {
                    // 헤더 UI 업데이트 (디바운싱됨)
                    updateHeaderUI();
                    const entryModal = document.getElementById('entryModal');
                    if (!entryModal || entryModal.classList.contains('hidden')) {
                        renderEntryChips();
                    }
                    
                    // 설정이 완전히 로드된 후 인증 플로우 실행
                    // 단, 이미 완료되었거나 처리 중인 경우는 건너뛰기
                    if (!authFlowManager.hasCompleted && !authFlowManager.isProcessing && window.userSettings) {
                        console.log('✅ 설정 업데이트 완료. 인증 플로우 실행...');
                        authFlowManager.handleAuthState(user).catch(e => {
                            console.error('❌ 인증 플로우 처리 실패:', e);
                            hideLoading();
                        });
                    }
                    // 약관 모달은 auth-flow.js에서만 관리하므로 여기서는 닫지 않음
                    // onSettingsUpdate에서 약관 모달을 닫으면 타이밍 이슈로 인해 모달이 잠깐 표시되었다가 사라질 수 있음
                },
                onDataUpdate: () => {
                    // 타임라인 탭이 보일 때만 재렌더. 다른 탭(앨범/분석/피드)에서는 스킵해 프리즈·고CPU 방지.
                    if (appState.currentTab !== 'timeline') return;
                    // 저장 직후 800ms 동안은 재렌더 스킵 (낙관 반영 + jumpToDate·스크롤이 리스너 재렌더에 덮이지 않게)
                    if (window._timelineRerenderFreezeUntil && Date.now() < window._timelineRerenderFreezeUntil) return;
                    if (dataUpdateTimer) clearTimeout(dataUpdateTimer);
                    dataUpdateTimer = setTimeout(() => {
                        dataUpdateTimer = null;
                        if (appState.currentTab !== 'timeline') return; // 대기 중 탭 바뀌면 스킵
                        if (appState.viewMode === 'list') {
                            const today = new Date();
                            today.setHours(0, 0, 0, 0);
                            appState.pageDate = today;
                        }
                        window.loadedDates = [];
                        window.hasScrolledToToday = false;
                        const container = document.getElementById('timelineContainer');
                        if (container) container.innerHTML = "";
                        renderTimeline();
                        renderMiniCalendar();
                    }, 120);
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
            
            // 리스너 콜백 디바운싱을 위한 타이머
            let sharedPhotosUpdateTimer = null;
            let isInitialSharedPhotosLoad = true; // 초기 로드 플래그
            
            appState.sharedPhotosUnsubscribe = setupSharedPhotosListener((sharedPhotos) => {
                // 전체 배열 로깅 제거: 공유 시마다 대용량 객체 직렬화로 CPU/메모리 부담·프리징 악화
                // 필요 시: console.log('[리스너] 공유 사진:', sharedPhotos?.length, appState.currentTab);
                
                // 초기 로드는 즉시 처리 (디바운싱 없음)
                if (isInitialSharedPhotosLoad) {
                    isInitialSharedPhotosLoad = false;
                    window.sharedPhotos = sharedPhotos;
                    
                    // 현재 탭에서만 렌더링 (다른 탭에서는 렌더링하지 않음 - 프리즈 방지)
                    const currentTab = appState.currentTab;
                    if (currentTab === 'timeline') {
                        renderTimeline();
                        updateTimelineShareIndicators();
                    } else if (currentTab === 'gallery') {
                        console.log('[리스너] 초기 로드: 갤러리 탭에서 renderGallery 호출');
                        renderGallery();
                    } else if (currentTab === 'feed') {
                        const feedContent = document.getElementById('feedContent');
                        if (feedContent && !feedContent.classList.contains('hidden')) {
                            renderFeed();
                        }
                    }
                    // analytics, dashboard 등 다른 탭에서는 렌더링하지 않음
                    return; // 초기 로드 후 즉시 반환
                }
                
                // 타임라인 탭이면 공유 화살표를 즉시 갱신 (디바운싱 없음)
                const currentTab = appState.currentTab;
                if (currentTab === 'timeline') {
                    window.sharedPhotos = sharedPhotos;
                    updateTimelineShareIndicators();
                    return;
                }
                
                // 그 외 탭은 디바운싱 적용 (빠른 연속 업데이트 방지)
                if (sharedPhotosUpdateTimer) {
                    clearTimeout(sharedPhotosUpdateTimer);
                }
                sharedPhotosUpdateTimer = setTimeout(() => {
                    window.sharedPhotos = sharedPhotos;
                    if (currentTab === 'gallery') {
                        console.log('[리스너] 갤러리 탭에서 renderGallery 호출');
                        renderGallery();
                    } else if (currentTab === 'feed') {
                        const feedContent = document.getElementById('feedContent');
                        if (feedContent && !feedContent.classList.contains('hidden')) {
                            renderFeed();
                        }
                    }
                }, 500); // 500ms 디바운싱 (공유 처리 후 빠른 연속 업데이트 방지)
            });
        }
        
        // 초기 로드 시 오늘 날짜로 설정
        if (appState.viewMode === 'list') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            appState.pageDate = today;
        }
        
        // Phase 1-1: 인증 플로우를 한 곳에서만 호출 (단일 진입점)
        // 게스트는 즉시 처리, 일반 사용자는 onSettingsUpdate에서 처리
        if (user.isAnonymous) {
            // 게스트는 설정 없이 즉시 처리
            authFlowManager.handleAuthState(user).catch(e => {
                console.error('❌ 게스트 인증 플로우 처리 실패:', e);
                hideLoading();
            });
        } else {
            // 일반 사용자: onSettingsUpdate에서 설정 로드 완료 후 인증 플로우 실행
            // 설정이 이미 로드되어 있으면 즉시 실행, 아니면 onSettingsUpdate에서 처리
            if (window.userSettings && !authFlowManager.hasCompleted) {
                console.log('✅ 설정이 이미 로드됨. 인증 플로우 시작...');
                authFlowManager.handleAuthState(user).catch(e => {
                    console.error('❌ 인증 플로우 처리 실패:', e);
                    hideLoading();
                });
            }
            // 설정이 없으면 onSettingsUpdate 콜백에서 처리됨
        }
    } else {
        // 로그아웃 상태
        // 추가 안전장치: 이전에 로그인된 사용자가 있었는데 갑자기 로그아웃되는 경우 무시
        // 단, 명시적 로그아웃(게스트→로그인 이동 포함)은 반드시 처리해야 함
        const isExplicitLogout = sessionStorage.getItem('explicitLogout') === 'true';
        if (isExplicitLogout) {
            sessionStorage.removeItem('explicitLogout');
        }
        if (!isExplicitLogout && lastProcessedUserId && window.currentUser && !window.currentUser.isAnonymous) {
            console.log('⚠️ 로그아웃 처리 중 이전 사용자 감지 - 무시 (관리자 페이지 영향 가능):', {
                previousUserId: lastProcessedUserId,
                previousEmail: window.currentUser.email
            });
            return;
        }
        
        const mainApp = document.getElementById('mainApp');
        const landingPage = document.getElementById('landingPage');
        // 이미 랜딩 화면이면 추가 처리 없이 종료
        if (landingPage && landingPage.style.display === 'flex' && mainApp && mainApp.classList.contains('hidden')) {
            return;
        }
        
        // 로그아웃 처리 전에 lastProcessedUserId 초기화
        lastProcessedUserId = null;
        
        switchScreen(false);
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
        hideLoading();
    }
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
window.showFeedOptions = (entryId, photoUrls, isBestShare = false, photoDate = '', photoSlotId = '', isDailyShare = false, postId = '', authorUserId = '', isInsightShare = false, dateRangeText = '') => {
    const existingMenu = document.getElementById('feedOptionsMenu');
    if (existingMenu) existingMenu.remove();
    
    const menu = document.createElement('div');
    menu.id = 'feedOptionsMenu';
    menu.className = 'fixed inset-0 z-[450]';
    
    const isMyPost = window.currentUser && authorUserId && window.currentUser.uid === authorUserId;
    const deleteButtonText = '공유 취소';
    const deleteButtonIcon = 'fa-share';
    
    const bg = document.createElement('div');
    bg.className = 'fixed inset-0 bg-black/40';
    bg.onclick = () => menu.remove();
    
    const menuContainer = document.createElement('div');
    menuContainer.className = 'fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white rounded-t-3xl p-4 pb-8 animate-fade-up z-[451]';
    
    const handlebar = document.createElement('div');
    handlebar.className = 'w-12 h-1 bg-slate-300 rounded-full mx-auto mb-4';
    
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'space-y-2';
    
    if (isMyPost) {
        // 수정하기
        const editBtn = document.createElement('button');
        editBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        editBtn.type = 'button';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            setTimeout(() => {
                if (isBestShare) {
                    const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
                    if (photoUrlArray.length > 0) window.editBestShare(photoUrlArray[0]);
                    else showToast("수정할 베스트 공유를 찾을 수 없습니다.", 'error');
                } else if (isDailyShare) {
                    if (photoDate) window.openDailyCommentModal(photoDate);
                    else showToast("수정할 일간보기 공유를 찾을 수 없습니다.", 'error');
                } else if (isInsightShare) {
                    const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
                    if (photoUrlArray.length > 0) window.editInsightShare(photoUrlArray[0]);
                    else showToast("수정할 밀당 코멘트 공유를 찾을 수 없습니다.", 'error');
                } else {
                    if (entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined') {
                        window.editFeedPost(entryId);
                    } else if (photoDate && photoSlotId) {
                        window.openModal(photoDate, photoSlotId, null);
                    } else {
                        showToast("수정할 기록을 찾을 수 없습니다.", 'error');
                    }
                }
            }, 100);
        });
        editBtn.innerHTML = '<div class="flex items-center gap-3"><i class="fa-solid fa-pencil text-emerald-600 text-lg"></i><span class="font-bold text-slate-800">수정하기</span></div>';
        buttonContainer.appendChild(editBtn);
        
        // 공유 취소
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            window.deleteFeedPost(entryId || '', photoUrls || '', isBestShare, isDailyShare, isInsightShare);
        });
        deleteBtn.innerHTML = `<div class="flex items-center gap-3"><i class="fa-solid ${deleteButtonIcon} text-red-500 text-lg"></i><span class="font-bold text-red-500">${deleteButtonText}</span></div>`;
        buttonContainer.appendChild(deleteBtn);
    } else {
        // 다른 사람 게시물: 신고하기 (첫 번째 옵션)
        const reportBtn = document.createElement('button');
        reportBtn.className = 'w-full py-4 text-left px-4 bg-slate-50 rounded-xl active:bg-slate-100 transition-colors';
        reportBtn.type = 'button';
        reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            const targetGroupKey = isBestShare ? `best_${postId || 'unknown'}` : isDailyShare ? `daily_${photoDate || 'nodate'}_${authorUserId || 'unknown'}` : isInsightShare ? `insight_${dateRangeText || 'no-range'}_${authorUserId || 'unknown'}` : `entry_${entryId || 'none'}_${authorUserId || 'unknown'}`;
            setTimeout(() => window.showReportModal(targetGroupKey), 100);
        });
        reportBtn.innerHTML = '<div class="flex items-center gap-3"><i class="fa-solid fa-flag text-amber-600 text-lg"></i><span class="font-bold text-slate-800">신고하기</span></div>';
        buttonContainer.appendChild(reportBtn);
    }
    
    // 취소 버튼 없음: 바깥 영역(배경) 탭으로 닫기
    menuContainer.addEventListener('click', (e) => e.stopPropagation());
    menuContainer.appendChild(handlebar);
    menuContainer.appendChild(buttonContainer);
    menu.appendChild(bg);
    menu.appendChild(menuContainer);
    document.body.appendChild(menu);
};

// 신고 사유 라벨 (reason id, reasonOther -> 표시 문자열)
function getReportReasonLabel(reason, reasonOther) {
    if (reason === 'other' && reasonOther) return `기타: ${reasonOther}`;
    return (REPORT_REASONS.find(r => r.id === reason) || {}).label || reason;
}

// 신고하기 모달 (이미 신고한 경우: 사유 표시 + 신고 취소, 아니면 사유 선택 폼. 하단 취소 버튼 없음)
window.showReportModal = async (targetGroupKey) => {
    const existing = document.getElementById('reportModal');
    if (existing) existing.remove();
    
    const overlay = document.createElement('div');
    overlay.id = 'reportModal';
    overlay.className = 'fixed inset-0 z-[500] flex items-end sm:items-center justify-center';
    
    const bg = document.createElement('div');
    bg.className = 'absolute inset-0 bg-black/50';
    bg.onclick = () => overlay.remove();
    
    const panel = document.createElement('div');
    panel.className = 'relative w-full max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-6 pb-8 max-h-[85vh] overflow-y-auto';
    panel.innerHTML = '<div id="reportModalBody" class="py-6 text-center text-slate-500">확인 중...</div>';
    
    overlay.appendChild(bg);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    
    const body = panel.querySelector('#reportModalBody');
    const uid = (auth?.currentUser || window.currentUser)?.uid;
    if (!uid) {
        body.innerHTML = '<p class="text-slate-600">로그인이 필요합니다.</p>';
        return;
    }
    
    let report = null;
    try {
        report = await getUserReportForPost(targetGroupKey, uid);
    } catch (e) {
        console.error('getUserReportForPost 오류:', e);
        body.innerHTML = '<p class="text-red-600">확인 중 오류가 발생했습니다.</p>';
        return;
    }
    
    if (report) {
        // 이미 신고한 경우: "이미 신고함" + 신고 사유 + 신고 취소 버튼 (옆에). 하단 취소 버튼 없음
        const label = getReportReasonLabel(report.reason, report.reasonOther);
        body.innerHTML = `
            <h3 class="text-lg font-bold text-slate-800 mb-4">게시물 신고</h3>
            <p class="text-sm text-amber-600 font-bold mb-3">이미 신고한 게시물입니다.</p>
            <div class="flex flex-wrap items-center justify-between gap-3 py-3 px-4 bg-slate-50 rounded-xl">
                <span class="text-sm text-slate-700">신고 사유: <strong>${escapeHtml(String(label || ''))}</strong></span>
                <button type="button" id="reportWithdrawBtn" class="flex-shrink-0 py-2 px-4 rounded-xl font-bold text-sm bg-slate-200 text-slate-700 hover:bg-slate-300 active:bg-slate-400">신고 취소</button>
            </div>
        `;
        body.querySelector('#reportWithdrawBtn').onclick = async () => {
            const btn = body.querySelector('#reportWithdrawBtn');
            btn.disabled = true;
            btn.textContent = '처리 중...';
            try {
                await withdrawReport(report.id, targetGroupKey);
                showToast('신고가 취소되었습니다.', 'success');
                overlay.remove();
            } catch (e) {
                showToast(e?.message || '신고 취소에 실패했습니다.', 'error');
                btn.disabled = false;
                btn.textContent = '신고 취소';
            }
        };
        return;
    }
    
    // 신고 사유 선택 폼 (하단 취소 버튼 없음, 신고 버튼만)
    body.innerHTML = `
        <h3 class="text-lg font-bold text-slate-800 mb-4">게시물 신고</h3>
        <p class="text-sm text-slate-600 mb-4">신고 사유를 선택해주세요.</p>
        <div class="space-y-2 mb-4" id="reportReasons"></div>
        <div id="reportOtherWrap" class="hidden mb-4">
            <label class="block text-sm font-bold text-slate-700 mb-2">기타 (직접 입력)</label>
            <textarea id="reportOtherInput" rows="3" class="w-full p-3 border border-slate-200 rounded-xl text-sm resize-none" placeholder="신고 사유를 입력해주세요."></textarea>
        </div>
        <button type="button" id="reportSubmitBtn" class="w-full py-3 rounded-xl font-bold text-white bg-amber-600">신고</button>
    `;
    
    const reasonsEl = body.querySelector('#reportReasons');
    REPORT_REASONS.forEach(r => {
        const lbl = document.createElement('label');
        lbl.className = 'flex items-center gap-3 p-3 rounded-xl border border-slate-200 has-[:checked]:border-amber-500 has-[:checked]:bg-amber-50 cursor-pointer';
        lbl.innerHTML = `<input type="radio" name="reportReason" value="${r.id}" class="report-reason-radio"> <span class="text-sm font-medium text-slate-800">${r.label}</span>`;
        reasonsEl.appendChild(lbl);
    });
    
    const otherWrap = body.querySelector('#reportOtherWrap');
    const otherInput = body.querySelector('#reportOtherInput');
    body.querySelectorAll('.report-reason-radio').forEach(radio => {
        radio.addEventListener('change', () => { otherWrap.classList.toggle('hidden', radio.value !== 'other'); });
    });
    
    body.querySelector('#reportSubmitBtn').onclick = async () => {
        const checked = body.querySelector('input[name="reportReason"]:checked');
        if (!checked) { showToast('신고 사유를 선택해주세요.', 'error'); return; }
        const reason = checked.value;
        const reasonOther = reason === 'other' ? (otherInput.value || '').trim() : '';
        if (reason === 'other' && !reasonOther) { showToast('기타 사유를 입력해주세요.', 'error'); return; }
        
        const btn = body.querySelector('#reportSubmitBtn');
        btn.disabled = true;
        btn.textContent = '처리 중...';
        try {
            await submitReport({ targetGroupKey, reason, reasonOther });
            showToast('신고가 접수되었습니다.', 'success');
            overlay.remove();
        } catch (e) {
            showToast(e?.message || '신고 접수에 실패했습니다.', 'error');
            btn.disabled = false;
            btn.textContent = '신고';
        }
    };
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

window.deleteFeedPost = async (entryId, photoUrls, isBestShare = false, isDailyShare = false, isInsightShare = false) => {
    // 피드에서는 항상 공유 취소
    if (!confirm("정말 공유를 취소하시겠습니까?")) {
        return;
    }
    
    const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
    if (photoUrlArray.length === 0) return;
    
    const validEntryId = (entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined') ? entryId : null;
    const normalizedPhotoUrls = photoUrlArray.map(normalizeUrl);
    
    // 롤백용 이전 상태 저장
    const prevSharedPhotos = window.sharedPhotos && Array.isArray(window.sharedPhotos) ? [...window.sharedPhotos] : [];
    let record = null;
    let prevRecordSharedPhotos = null;
    if (entryId && entryId !== '' && entryId !== 'null' && window.mealHistory) {
        record = window.mealHistory.find(m => m.id === entryId);
        if (record && record.sharedPhotos && Array.isArray(record.sharedPhotos)) {
            prevRecordSharedPhotos = [...record.sharedPhotos];
        }
    }
    
    // 공유 제거 판별 헬퍼
    const shouldRemovePhoto = (photo) => {
        const photoUrlNormalized = normalizeUrl(photo.photoUrl);
        const isMatched = normalizedPhotoUrls.some(normalizedUrl =>
            normalizedUrl === photoUrlNormalized || photo.photoUrl === normalizedUrl
        );
        if (!isMatched) return false;
        if (isBestShare) return photo.type === 'best';
        if (isDailyShare) return photo.type === 'daily';
        if (isInsightShare) return photo.type === 'insight';
        if (validEntryId) return photo.entryId === validEntryId || !photo.entryId || photo.entryId === null;
        return true;
    };
    
    // 낙관적 업데이트: UI 즉시 반영
    if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        window.sharedPhotos = window.sharedPhotos.filter(photo => !shouldRemovePhoto(photo));
    }
    if (record && record.sharedPhotos && Array.isArray(record.sharedPhotos)) {
        record.sharedPhotos = record.sharedPhotos.filter(url => {
            if (photoUrlArray.includes(url)) return false;
            const urlBase = url.split('?')[0];
            const urlFileName = urlBase.split('/').pop();
            return !photoUrlArray.some(photoUrl => {
                const photoUrlBase = photoUrl.split('?')[0];
                const photoUrlFileName = photoUrlBase.split('/').pop();
                return urlFileName === photoUrlFileName && urlFileName !== '';
            });
        });
        if (record.sharedPhotos.length === 0) record.sharedPhotos = [];
    }
    if (appState.currentTab === 'timeline') {
        updateTimelineShareIndicators();
        renderTimeline();
    }
    if (appState.currentTab === 'gallery') {
        // 일반 식사 기록: 해당 카드만 DOM에서 제거 (전체 renderGallery 호출 없이 즉시 반영)
        const uid = window.currentUser?.uid;
        if (!isBestShare && !isDailyShare && !isInsightShare && validEntryId && uid) {
            const groupKey = `${validEntryId}_${uid}`;
            const container = document.getElementById('galleryContainer');
            const postEl = container?.querySelector(`[data-group-key="${groupKey}"]`);
            if (postEl) postEl.remove();
        } else {
            renderGallery();
        }
    }
    if (!window._feedPostDeleteInProgress) {
        window._feedPostDeleteInProgress = true;
        showToast("공유가 취소되었습니다.", 'success');
        setTimeout(() => { window._feedPostDeleteInProgress = false; }, 1000);
    }
    
    // 서버는 백그라운드에서 호출
    dbOps.unsharePhotos(photoUrlArray, validEntryId, isBestShare, isDailyShare, isInsightShare)
        .then(() => {
            if (record && prevRecordSharedPhotos !== null) {
                dbOps.save(record, true).catch((e) => {
                    console.error("sharedPhotos 필드 업데이트 실패:", e);
                    showToast("공유 취소는 되었으나 기록 반영에 실패했습니다.", 'error');
                });
            }
        })
        .catch(() => {
            if (window.sharedPhotos) window.sharedPhotos = prevSharedPhotos;
            if (record && prevRecordSharedPhotos !== null) record.sharedPhotos = prevRecordSharedPhotos;
            if (appState.currentTab === 'timeline') {
                updateTimelineShareIndicators();
                renderTimeline();
            }
            if (appState.currentTab === 'gallery') renderGallery();
        });
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
    if (typeof window.setBoardWriteCategory === 'function') {
        window.setBoardWriteCategory('serious');
    }
    
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

window.backToBoardList = (optimisticPost = null, options = null) => {
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    
    if (boardListView) boardListView.classList.remove('hidden');
    if (boardDetailView) boardDetailView.classList.add('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    if (tracePanel && appState.currentTab === 'board') tracePanel.classList.remove('hidden');
    
    window.currentBoardPostId = null;
    window.currentEditingPostId = null;
    
    // 작성 뷰 제목 및 버튼 초기화
    const titleEl = document.querySelector('#boardWriteView h2');
    if (titleEl) titleEl.textContent = '글쓰기';
    const submitBtn = boardWriteView?.querySelector('button[onclick="window.submitBoardPost()"]');
    if (submitBtn) submitBtn.textContent = '등록';
    
    const category = window.currentBoardCategory || 'all';
    renderBoard(category, optimisticPost, options);
    
    setTimeout(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
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
    
    const listCategory = window.currentBoardCategory || 'all';
    
    if (window.currentEditingPostId) {
        const postId = window.currentEditingPostId;
        window.currentEditingPostId = null;
        window.backToBoardList();
        boardOperations.updatePost(postId, { title, content, category })
            .then(() => renderBoard(listCategory))
            .catch((e) => {
                console.error("[submitBoardPost] 수정 에러:", e);
            });
        return;
    }
    
    const optimisticPost = {
        id: 'pending-' + Date.now(),
        title,
        content,
        category: category || 'serious',
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
    boardOperations.createPost({ title, content, category })
        .then((result) => {
            if (result?.id) renderBoard(listCategory);
        })
        .catch(() => {
            renderBoard(listCategory);
        });
};

window.openBoardDetail = async (postId) => {
    window.currentBoardPostId = postId;
    window.currentBoardNoticeId = null;
    
    // 상세 뷰 표시
    const boardListView = document.getElementById('boardListView');
    const boardDetailView = document.getElementById('boardDetailView');
    const boardWriteView = document.getElementById('boardWriteView');
    const tracePanel = document.getElementById('galleryTraceFilterPanel');
    
    if (boardListView) boardListView.classList.add('hidden');
    if (boardDetailView) boardDetailView.classList.remove('hidden');
    if (boardWriteView) boardWriteView.classList.add('hidden');
    if (tracePanel) tracePanel.classList.add('hidden');
    
    await renderBoardDetail(postId);
    
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
        document.getElementById('boardWriteContent').value = post.content || '';
        document.getElementById('boardWriteCategory').value = post.category || 'serious';
        if (typeof window.setBoardWriteCategory === 'function') {
            window.setBoardWriteCategory(post.category || 'serious');
        }
        
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

window.deleteBoardPost = (postId) => {
    if (!confirm("정말 삭제하시겠습니까?")) return;
    
    window.backToBoardList(null, { excludePostId: postId });
    boardOperations.deletePost(postId).catch((e) => {
        console.error("게시글 삭제 오류:", e);
        const category = window.currentBoardCategory || 'all';
        renderBoard(category);
    });
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
    input.disabled = true;
    
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
        input.disabled = false;
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
                        const commentAuthorNickname = comment.authorNickname || comment.anonymousId || '익명';
                        const commentBody = comment.content ?? comment.text ?? '';
                        return `<div class="mb-1 text-sm" data-comment-id="${comment.id}"><span class="font-bold text-slate-800">${escapeHtml(commentAuthorNickname)}</span><span class="text-slate-800 ml-2">${escapeHtml(commentBody)}</span><span class="text-xs text-slate-400 ml-2">${commentDateStr} ${commentTimeStr}</span>${isCommentAuthor ? `<button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}</div>`;
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

// 이벤트 리스너 초기화 함수
// 이벤트 리스너 관리 유틸리티 (중복 등록 방지 및 정리)
const eventListenerManager = {
    listeners: new Map(), // element -> Map<eventType, handler>
    
    // 이벤트 리스너 등록 (중복 방지)
    add(element, eventType, handler, options = false) {
        if (!element) return;
        
        const key = `${eventType}_${options ? JSON.stringify(options) : 'default'}`;
        
        // 기존 리스너가 있으면 제거
        if (this.listeners.has(element)) {
            const elementListeners = this.listeners.get(element);
            if (elementListeners.has(key)) {
                const oldHandler = elementListeners.get(key);
                element.removeEventListener(eventType, oldHandler, options);
            }
        } else {
            this.listeners.set(element, new Map());
        }
        
        // 새 리스너 등록
        this.listeners.get(element).set(key, handler);
        element.addEventListener(eventType, handler, options);
    },
    
    // 특정 요소의 모든 리스너 제거
    removeAll(element) {
        if (!element || !this.listeners.has(element)) return;
        
        const elementListeners = this.listeners.get(element);
        elementListeners.forEach((handler, key) => {
            const [eventType, optionsStr] = key.split('_');
            const options = optionsStr !== 'default' ? JSON.parse(optionsStr) : false;
            element.removeEventListener(eventType, handler, options);
        });
        
        this.listeners.delete(element);
    },
    
    // 모든 리스너 제거
    clear() {
        this.listeners.forEach((elementListeners, element) => {
            elementListeners.forEach((handler, key) => {
                const [eventType, optionsStr] = key.split('_');
                const options = optionsStr !== 'default' ? JSON.parse(optionsStr) : false;
                element.removeEventListener(eventType, handler, options);
            });
        });
        this.listeners.clear();
    }
};

// 전역 이벤트 리스너 관리자 노출 (디버깅용)
window.Mealog.eventListenerManager = eventListenerManager;

function initEventListeners() {
    // 랜딩 페이지 버튼들
    const googleLoginBtn = document.getElementById('googleLoginBtn');
    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', handleGoogleLogin);
    }
    
    const emailLoginBtn = document.getElementById('emailLoginBtn');
    if (emailLoginBtn) {
        emailLoginBtn.addEventListener('click', openEmailModal);
    }
    
    const guestLoginBtn = document.getElementById('guestLoginBtn');
    if (guestLoginBtn) {
        guestLoginBtn.addEventListener('click', startGuest);
    }
    
    // 이메일 인증 모달 버튼들
    const emailAuthCloseBtn = document.getElementById('emailAuthCloseBtn');
    if (emailAuthCloseBtn) {
        emailAuthCloseBtn.addEventListener('click', closeEmailModal);
    }
    
    const emailAuthBtn = document.getElementById('emailAuthBtn');
    if (emailAuthBtn) {
        emailAuthBtn.addEventListener('click', handleEmailAuth);
    }
    
    const emailAuthToggleBtn = document.getElementById('emailAuthToggleBtn');
    if (emailAuthToggleBtn) {
        emailAuthToggleBtn.addEventListener('click', toggleEmailAuthMode);
    }
    
    // Domain Error Modal
    const domainCopyBtn = document.getElementById('domainCopyBtn');
    if (domainCopyBtn) {
        domainCopyBtn.addEventListener('click', copyDomain);
    }
    
    const domainModalGuestBtn = document.getElementById('domainModalGuestBtn');
    if (domainModalGuestBtn) {
        domainModalGuestBtn.addEventListener('click', () => {
            closeDomainModal();
            startGuest();
        });
    }
    
    const domainModalCloseBtn = document.getElementById('domainModalCloseBtn');
    if (domainModalCloseBtn) {
        domainModalCloseBtn.addEventListener('click', closeDomainModal);
    }
    
    // Terms Agreement Modal
    const termsDetailBtn = document.getElementById('termsDetailBtn');
    if (termsDetailBtn) {
        termsDetailBtn.addEventListener('click', () => showTermsDetail('terms'));
    }
    
    const privacyDetailBtn = document.getElementById('privacyDetailBtn');
    if (privacyDetailBtn) {
        privacyDetailBtn.addEventListener('click', () => showTermsDetail('privacy'));
    }
    
    const termsCancelBtn = document.getElementById('termsCancelBtn');
    if (termsCancelBtn) {
        termsCancelBtn.addEventListener('click', cancelTermsAgreement);
    }
    
    const termsAgreeBtn = document.getElementById('termsAgreeBtn');
    if (termsAgreeBtn) {
        termsAgreeBtn.addEventListener('click', confirmTermsAgreement);
    }
    
    // Profile Setup Modal
    const setupProfileTypeEmoji = document.getElementById('setupProfileTypeEmoji');
    if (setupProfileTypeEmoji) {
        setupProfileTypeEmoji.addEventListener('click', () => setProfileType('emoji'));
    }
    
    const setupProfileTypePhoto = document.getElementById('setupProfileTypePhoto');
    if (setupProfileTypePhoto) {
        setupProfileTypePhoto.addEventListener('click', () => setProfileType('photo'));
    }
    
    const setupPhotoSelectBtn = document.getElementById('setupPhotoSelectBtn');
    if (setupPhotoSelectBtn) {
        setupPhotoSelectBtn.addEventListener('click', () => {
            document.getElementById('setupPhotoInput')?.click();
        });
    }
    
    const setupPhotoInput = document.getElementById('setupPhotoInput');
    if (setupPhotoInput) {
        setupPhotoInput.addEventListener('change', (e) => handleSetupPhotoUpload(e));
    }
    
    const profileSetupBtn = document.getElementById('profileSetupBtn');
    if (profileSetupBtn) {
        profileSetupBtn.addEventListener('click', confirmProfileSetup);
    }

    // 초기 가입: 라이프스타일 버튼
    document.querySelectorAll('.setup-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('setupLifestyle');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.setup-lifestyle-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-emerald-600', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('border-emerald-600', active);
                b.classList.toggle('bg-slate-50', !active);
                b.classList.toggle('text-slate-600', !active);
                b.classList.toggle('border-slate-200', !active);
            });
        });
    });
    
    // 헤더 및 검색
    const searchTriggerBtn = document.getElementById('searchTriggerBtn');
    if (searchTriggerBtn) {
        searchTriggerBtn.addEventListener('click', window.toggleSearch);
    }
    
    const headerSettingsBtn = document.getElementById('headerSettingsBtn');
    if (headerSettingsBtn) {
        headerSettingsBtn.addEventListener('click', openSettings);
    }
    
    const galleryTraceFilterPanel = document.getElementById('galleryTraceFilterPanel');
    if (galleryTraceFilterPanel) {
        galleryTraceFilterPanel.addEventListener('click', (e) => {
            const btn = e.target.closest('.gallery-trace-btn');
            if (!btn) return;
            const v = btn.getAttribute('data-trace');
            if (v === 'collapse') {
                window.toggleGalleryTracePanel();
                return;
            }
            window.setGalleryTraceFilter(v);
        });
    }
    
    // 뷰 모드
    const btnViewList = document.getElementById('btn-view-list');
    if (btnViewList) {
        btnViewList.addEventListener('click', () => window.setViewMode('list'));
    }
    
    const btnViewPage = document.getElementById('btn-view-page');
    if (btnViewPage) {
        btnViewPage.addEventListener('click', () => window.setViewMode('page'));
    }
    
    // 하단 네비게이션
    const navDashboard = document.getElementById('nav-dashboard');
    if (navDashboard) {
        navDashboard.addEventListener('click', () => window.switchMainTab('dashboard'));
    }
    
    const navTimeline = document.getElementById('nav-timeline');
    if (navTimeline) {
        navTimeline.addEventListener('click', () => window.switchMainTab('timeline'));
    }
    
    const navGallery = document.getElementById('nav-gallery');
    if (navGallery) {
        navGallery.addEventListener('click', () => window.switchMainTab('gallery'));
    }
    
    const navBoard = document.getElementById('nav-board');
    if (navBoard) {
        navBoard.addEventListener('click', () => window.switchMainTab('board'));
    }
    
    // 설정 페이지
    const settingsCloseBtn = document.getElementById('settingsCloseBtn');
    if (settingsCloseBtn) {
        settingsCloseBtn.addEventListener('click', closeSettings);
    }
    
    const settingsTabProfile = document.getElementById('settingsTabProfile');
    if (settingsTabProfile) {
        settingsTabProfile.addEventListener('click', () => window.switchSettingsTab('profile'));
    }
    
    const settingsTabTags = document.getElementById('settingsTabTags');
    if (settingsTabTags) {
        settingsTabTags.addEventListener('click', () => window.switchSettingsTab('tags'));
    }
    
    const settingsTabShortcuts = document.getElementById('settingsTabShortcuts');
    if (settingsTabShortcuts) {
        settingsTabShortcuts.addEventListener('click', () => window.switchSettingsTab('shortcuts'));
    }
    
    const saveProfileSettingsBtn = document.getElementById('saveProfileSettingsBtn');
    if (saveProfileSettingsBtn) {
        saveProfileSettingsBtn.addEventListener('click', saveProfileSettings);
    }

    const editProfileSettingsBtn = document.getElementById('editProfileSettingsBtn');
    if (editProfileSettingsBtn) {
        editProfileSettingsBtn.addEventListener('click', () => window.startProfileSettingsEdit?.());
    }

    const cancelProfileSettingsBtn = document.getElementById('cancelProfileSettingsBtn');
    if (cancelProfileSettingsBtn) {
        cancelProfileSettingsBtn.addEventListener('click', () => window.cancelProfileSettingsEdit?.());
    }
    
    const profileTypeEmoji = document.getElementById('profileTypeEmoji');
    if (profileTypeEmoji) {
        profileTypeEmoji.addEventListener('click', () => window.setSettingsProfileType('emoji'));
    }
    
    const profileTypePhoto = document.getElementById('profileTypePhoto');
    if (profileTypePhoto) {
        profileTypePhoto.addEventListener('click', () => window.setSettingsProfileType('photo'));
    }

    const profileTypeText = document.getElementById('profileTypeText');
    if (profileTypeText) {
        profileTypeText.addEventListener('click', () => window.setSettingsProfileType('text'));
    }

    const photoSelectBtn = document.getElementById('photoSelectBtn');
    if (photoSelectBtn) {
        photoSelectBtn.addEventListener('click', () => {
            if (!appState.isProfileEditing) {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
                return;
            }
            document.getElementById('photoInput')?.click();
        });
    }

    // 설정: 라이프스타일 버튼
    document.querySelectorAll('.settings-lifestyle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!appState.isProfileEditing) {
                showToast("수정 버튼을 누른 뒤 변경할 수 있습니다.", "info");
                return;
            }
            const v = btn.getAttribute('data-value') || '';
            const hidden = document.getElementById('settingLifestyle');
            if (hidden) hidden.value = v;
            document.querySelectorAll('.settings-lifestyle-btn').forEach(b => {
                const active = b === btn;
                b.classList.toggle('bg-emerald-600', active);
                b.classList.toggle('text-white', active);
                b.classList.toggle('border-emerald-600', active);
                b.classList.toggle('bg-white', !active);
                b.classList.toggle('text-slate-600', !active);
                b.classList.toggle('border-slate-200', !active);
            });
        });
    });
    
    // 게시판
    const boardWriteBtn = document.getElementById('boardWriteBtn');
    if (boardWriteBtn) {
        boardWriteBtn.addEventListener('click', window.openBoardWrite);
    }
    
    // 게시판 카테고리 버튼들
    ['all', 'serious', 'chat', 'food', 'admin'].forEach(category => {
        const btn = document.getElementById(`board-category-${category}`);
        if (btn) {
            btn.addEventListener('click', () => window.setBoardCategory(category));
        }
    });
    
    // 대시보드 모드 버튼들
    ['7d', 'week', 'month', 'year', 'custom'].forEach(mode => {
        const btn = document.getElementById(`btn-dash-${mode}`);
        if (btn) {
            btn.addEventListener('click', () => window.setDashboardMode(mode));
        }
    });
    
    // 분석 타입 버튼들
    ['best', 'main', 'snack'].forEach(type => {
        const btn = document.getElementById(`btn-analysis-${type}`);
        if (btn) {
            btn.addEventListener('click', () => window.setAnalysisType(type));
        }
    });
    
    // 로그아웃 확인 모달
    const logoutConfirmCancelBtn = document.getElementById('logoutConfirmCancelBtn');
    if (logoutConfirmCancelBtn) {
        logoutConfirmCancelBtn.addEventListener('click', () => {
            document.getElementById('logoutConfirmModal')?.classList.add('hidden');
        });
    }
    
    const logoutConfirmActionBtn = document.getElementById('logoutConfirmActionBtn');
    if (logoutConfirmActionBtn) {
        logoutConfirmActionBtn.addEventListener('click', confirmLogoutAction);
    }
    
    // 탈퇴 모달 버튼
    const deleteAccountConfirmCancelBtn = document.getElementById('deleteAccountConfirmCancelBtn');
    if (deleteAccountConfirmCancelBtn) {
        deleteAccountConfirmCancelBtn.addEventListener('click', cancelDeleteAccount);
    }
    
    const deleteAccountConfirmActionBtn = document.getElementById('deleteAccountConfirmActionBtn');
    if (deleteAccountConfirmActionBtn) {
        deleteAccountConfirmActionBtn.addEventListener('click', confirmDeleteAccountAction);
    }
}

// DOM이 준비되면 이벤트 리스너 초기화
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEventListeners);
} else {
    // DOM이 이미 로드된 경우
    initEventListeners();
}

// 모듈 로드 완료 표시
window.moduleLoaded = true;
console.log('✅ main.js 모듈 로드 완료');
console.log('✅ window.renderTimeline 함수 확인:', typeof window.renderTimeline);

// 에러 핸들링
window.addEventListener('error', (e) => {
    console.error('JavaScript 에러:', e);
    console.error('에러 파일:', e.filename);
    console.error('에러 메시지:', e.message);
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
});
