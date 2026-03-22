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
    uploadBoardImages,
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

export function registerMainPostInteractions() {
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

/** stats 집계 문서 재생성 (콘솔에서 window.backfillUserStats() 호출) */
window.backfillUserStats = async () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    try {
        showToast('통계 재계산 중...', 'info');
        const result = await callableFunctions.backfillUserStats();
        const { mealCount, dayCount } = result.data || {};
        showToast(`통계 재계산 완료 (${mealCount}건, ${dayCount}일)`, 'success');
        if (appState.currentTab === 'timeline') { renderTimeline(); renderMiniCalendar(); }
        if (appState.currentTab === 'dashboard') updateDashboard();
        return result.data;
    } catch (e) {
        console.error('backfillUserStats 실패:', e);
        showToast(e?.message || '통계 재계산 실패', 'error');
        throw e;
    }
};
window.Mealog.backfillUserStats = window.backfillUserStats;

// 좋아요 토글 함수
window.toggleLike = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_LIKE, 'info');
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
    if (isDemoUser(window.currentUser)) {
        showToast(DEMO_TOAST_CANNOT_BOOKMARK, 'info');
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
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 댓글을 작성할 수 없습니다.', 'error');
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
                    const alternates = getAlternatePostIdsForPost(postId);
                    const comments = await postInteractions.getComments(postId, alternates);
                    
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
                            commentsListEl.innerHTML = displayComments.map(c => {
                                const commentDisplay = getDisplayProfile(c.userId, { nickname: c.userNickname });
                                return `
                                <div class="mb-1 text-sm">
                                    <span class="font-bold text-slate-800">${commentDisplay.nickname}</span>
                                    <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                                    ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                                </div>
                            `;
                            }).join('');
                            
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

// 앨범 카드의 구 postId(문서 id) 목록 — 댓글 조회 시 canonical id + 이 목록으로 함께 조회해 작성자/댓글 작성자 동일하게 표시
function getAlternatePostIdsForPost(postId) {
    const el = document.querySelector(`.instagram-post[data-post-id="${postId}"]`);
    if (!el) return [];
    const attr = el.getAttribute('data-post-id-alternates');
    return attr ? attr.split(',').filter(Boolean) : [];
}

// 댓글 모두 보기 함수
window.viewAllComments = async (postId) => {
    try {
        const alternates = getAlternatePostIdsForPost(postId);
        const comments = await postInteractions.getComments(postId, alternates);
        const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
        const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
        
        if (commentsListEl) {
            if (comments.length > 0) {
                commentsListEl.classList.add('bg-slate-50');
                const commentAuthorIds = [...new Set(comments.map(c => c.userId).filter(Boolean))];
                await fetchUserProfiles(commentAuthorIds);
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
                    const commentDisplay = getDisplayProfile(comment.userId, { nickname: comment.userNickname });
                    return `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${escapeHtml(commentDisplay.nickname)}</span>
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
const _commentSubmitting = {};
window.submitComment = async (postId) => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다.", 'error');
        window.requestLogin();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 댓글을 작성할 수 없습니다.', 'error');
        return;
    }

    const inputEl = document.getElementById(`comment-text-${postId}`);
    if (!inputEl) return;
    
    const commentText = inputEl.value.trim();
    if (!commentText) {
        showToast("댓글을 입력해주세요.", 'error');
        return;
    }
    if (_commentSubmitting[postId]) return;
    _commentSubmitting[postId] = true;
    
    const commentsListEl = document.getElementById(`comments-list-${postId}`);
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
    const userProfile = window.userSettings?.profile || {};
    const userNickname = userProfile?.nickname || '익명';
    const tempId = `temp-${Date.now()}`;
    
    // 즉시 비우기 (disabled 대신 플래그로 더블 탭 방지 → 키보드 유지)
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
                const commentDisplay = getDisplayProfile(window.currentUser?.uid, { nickname: result.userNickname });
                tempRow.outerHTML = `
                    <div class="mb-1 text-sm">
                        <span class="font-bold text-slate-800">${escapeHtml(commentDisplay.nickname)}</span>
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
        _commentSubmitting[postId] = false;
    }
};

// 포스트 댓글 로드 함수
async function loadPostComments(postId) {
    try {
        const alternates = getAlternatePostIdsForPost(postId);
        const comments = await postInteractions.getComments(postId, alternates);
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
                    const commentDisplay = getDisplayProfile(comment.userId, { nickname: comment.userNickname });
                    return `
                        <div class="mb-1 text-sm">
                            <span class="font-bold text-slate-800">${escapeHtml(commentDisplay.nickname)}</span>
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
    modal.className = 'fixed inset-0 z-[500] flex items-center justify-center py-4 bg-black/50 capture-share-modal';

    modal.innerHTML = `
        <div class="relative w-full max-w-md mx-auto bg-white rounded-2xl flex flex-col max-h-[92vh] shadow-xl">
            <div id="dailyShareLoadingOverlay" class="hidden absolute inset-0 bg-white/90 rounded-2xl flex flex-col items-center justify-center z-20">
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
                <button onclick="window.confirmDailyShare('${dateStr}')" class="flex-1 py-4 bg-slate-800 text-white rounded-xl font-bold active:bg-slate-900 shadow-lg transition-all">
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
        
        // 이미지 로드 확인 (img + background-image용 data-photo-url)
        const images = previewCard.querySelectorAll('img');
        const imageLoadPromises = Array.from(images).map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 400);
            });
        });
        const bgDivs = previewCard.querySelectorAll('[data-photo-url]');
        const bgLoadPromises = Array.from(bgDivs).map(div => {
            const url = div.getAttribute('data-photo-url');
            if (!url) return Promise.resolve();
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = resolve;
                img.onerror = resolve;
                img.src = url;
                if (img.complete) resolve();
            });
        });
        await Promise.all([...imageLoadPromises, ...bgLoadPromises]);

        const innerContent = previewCard.querySelector('div[style*="width: 420px"]') || previewCard;

        // 유령 캡처: 화면 밖(-10000px)에 복제본을 만들어 모달/transform/Flex 간섭 없이 정사이즈 캡처
        const canvas = await captureWithGhostStrategy(innerContent, {
            captureWidth: 420,
            allowTaint: false,
            foreignObjectRendering: false,
            onclone: (clonedDoc) => {
                if (fredokaFontCSS) {
                    const clonedStyle = clonedDoc.createElement('style');
                    clonedStyle.textContent = fredokaFontCSS;
                    clonedDoc.head.appendChild(clonedStyle);
                } else {
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
                const allSpans = clonedDoc.querySelectorAll('span');
                allSpans.forEach(el => {
                    const style = el.getAttribute('style') || '';
                    const text = el.textContent.trim();
                    if (style.includes('MEALOG') || text === 'MEALOG' || (style.includes('font-family') && style.includes('Fredoka'))) {
                        el.style.fontFamily = "'Fredoka', sans-serif";
                        el.style.fontWeight = '700';
                    }
                });
                // Ghost Hack: 별점 배지들만 캡처본에서 margin-top으로 살짝 내려서 베이스라인 정렬 보정
                const badges = clonedDoc.querySelectorAll('span[style*="fefce8"]');
                badges.forEach(el => {
                    el.style.marginTop = '-5px';
                    el.style.display = 'flex';
                    el.style.alignItems = 'center';
                });
            }
        });

        const base64Image = canvas.toDataURL('image/png');
        const { uploadBase64ToStorage } = await import('../utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, window.currentUser.uid, `daily_${dateStr}`, 1024);

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
        // 갤러리 피드에도 낙관 반영 (맨 앞에 추가)
        if (!window.sharedPhotosFeed) window.sharedPhotosFeed = [];
        window.sharedPhotosFeed = [dailyShareData, ...window.sharedPhotosFeed];

        window.closeDailySharePreviewModal();
        showToast('하루 기록이 피드에 공유되었습니다!', 'success');
        if (appState.currentTab === 'timeline') renderTimeline();
        if (appState.currentTab === 'gallery') renderGallery();

        const { callableFunctions } = await import('../firebase.js');
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
}
