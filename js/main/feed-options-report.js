/**
 * main.js에서 분리한 청크 공통 import (register* 함수 내부에서 사용)
 */
import { appState, getState } from '../state.js';
import { auth, db, appId } from '../firebase.js';
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
import { isDemoUser, markUserHasRealLogin } from '../demo-account.js';
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

export function registerMainFeedOptionsReport() {
// 피드 옵션 관련 함수
window.showFeedOptions = (
    entryId,
    photoUrls,
    isBestShare = false,
    photoDate = '',
    photoSlotId = '',
    isDailyShare = false,
    postId = '',
    authorUserId = '',
    isInsightShare = false,
    dateRangeText = '',
    caption = '',
    placement = 'bottom'
) => {
    const existingMenu = document.getElementById('feedOptionsMenu');
    if (existingMenu) existingMenu.remove();
    
    const menu = document.createElement('div');
    menu.id = 'feedOptionsMenu';
    const isCenterPopup = placement === 'center';
    /* 사진 휠 오버레이(z-310) 위에 두되, 가입 마법사 등(z-550)보다 낮을 수 있어 중앙 메뉴는 충분히 높게 */
    menu.className = isCenterPopup
        ? 'fixed inset-0 z-[580] flex items-center justify-center p-4'
        : 'fixed inset-0 z-[450]';
    
    const isMyPost = window.currentUser && authorUserId && window.currentUser.uid === authorUserId;
    const deleteButtonText = '공유 취소';
    
    const bg = document.createElement('div');
    bg.className = isCenterPopup ? 'absolute inset-0 mealog-action-dim' : 'fixed inset-0 mealog-action-dim';
    
    const menuContainer = document.createElement('div');
    menuContainer.className = isCenterPopup
        ? 'mealog-action-center-panel relative z-[1] w-full max-w-[14rem] p-1'
        : 'mealog-action-wrap animate-fade-up';
    
    const actionCard = document.createElement('div');
    actionCard.className = 'mealog-action-card';
    
    const buttonContainer = isCenterPopup ? menuContainer : actionCard;

    function closeMenu() {
        document.removeEventListener('keydown', onKey);
        menu.remove();
    }
    const onKey = (e) => {
        if (e.key === 'Escape') closeMenu();
    };
    bg.onclick = () => closeMenu();

    if (isMyPost) {
        // 1. 수정하기
        const editBtn = document.createElement('button');
        editBtn.className = 'mealog-action-btn';
        editBtn.type = 'button';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            setTimeout(() => {
                if (isBestShare) {
                    const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
                    if (photoUrlArray.length > 0) window.editBestShare(photoUrlArray[0]);
                    else showToast("수정할 베스트 공유를 찾을 수 없습니다.", 'error');
                } else if (isDailyShare) {
                    if (photoDate) window.openDailyJournalModal(photoDate);
                    else showToast("수정할 일간보기 공유를 찾을 수 없습니다.", 'error');
                } else if (isInsightShare) {
                    const photoUrlArray = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(url => url.trim()).filter(url => url) : [];
                    if (photoUrlArray.length > 0) window.editInsightShare(photoUrlArray[0]);
                    else showToast("수정할 밀당 코멘트 공유를 찾을 수 없습니다.", 'error');
                } else {
                    let idToEdit = (entryId && entryId !== '' && entryId !== 'null' && entryId !== 'undefined') ? entryId : null;
                    if (!idToEdit && photoDate && photoSlotId && window.mealHistory?.length > 0) {
                        // entryId 없을 때: 같은 날짜·슬롯의 기존 기록 찾아서 수정 (중복 생성 방지)
                        const found = window.mealHistory.find(m => m.date === photoDate && m.slotId === photoSlotId);
                        if (found) idToEdit = found.id;
                    }
                    if (idToEdit) {
                        window.editFeedPost(idToEdit);
                    } else if (photoDate && photoSlotId) {
                        showToast("수정할 기록을 찾을 수 없습니다.", 'error');
                    } else {
                        showToast("수정할 기록을 찾을 수 없습니다.", 'error');
                    }
                }
            }, 100);
        });
        editBtn.innerHTML = '<i data-lucide="pen"></i><span>수정하기</span>';
        buttonContainer.appendChild(editBtn);
        
        // 2. SNS 공유
        const externalShareBtn = document.createElement('button');
        externalShareBtn.className = 'mealog-action-btn';
        externalShareBtn.type = 'button';
        externalShareBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeMenu();
            const urls = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(u => u.trim()).filter(Boolean) : [];
            if (urls.length > 0) {
                try {
                    showLoading('사진 불러오는 중...');
                    await sharePhotosToExternal(urls, caption, isBestShare || isDailyShare || isInsightShare);
                } catch (err) {
                    console.error('외부 공유 실패:', err);
                } finally {
                    hideLoading();
                }
            } else {
                showToast('공유할 사진이 없습니다.', 'error');
            }
        });
        externalShareBtn.innerHTML = '<i data-lucide="share-2"></i><span>SNS 공유</span>';
        buttonContainer.appendChild(externalShareBtn);
        
        // 3. 공유 취소
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'mealog-action-btn mealog-action-btn--danger';
        deleteBtn.type = 'button';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            window.deleteFeedPost(entryId || '', photoUrls || '', isBestShare, isDailyShare, isInsightShare);
        });
        deleteBtn.innerHTML = `<i data-lucide="share-2"></i><span>${deleteButtonText}</span>`;
        buttonContainer.appendChild(deleteBtn);
    } else {
        // 다른 사람 게시물: 공유하기 > 신고하기
        const externalShareBtn = document.createElement('button');
        externalShareBtn.className = 'mealog-action-btn';
        externalShareBtn.type = 'button';
        externalShareBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            closeMenu();
            const urls = photoUrls && photoUrls !== '' ? photoUrls.split(',').map(u => u.trim()).filter(Boolean) : [];
            if (urls.length > 0) {
                try {
                    showLoading('사진 불러오는 중...');
                    await sharePhotosToExternal(urls, caption, isBestShare || isDailyShare || isInsightShare);
                } catch (err) {
                    console.error('외부 공유 실패:', err);
                } finally {
                    hideLoading();
                }
            } else {
                showToast('공유할 사진이 없습니다.', 'error');
            }
        });
        externalShareBtn.innerHTML = '<i data-lucide="share-2"></i><span>SNS 공유</span>';
        buttonContainer.appendChild(externalShareBtn);
        
        const reportBtn = document.createElement('button');
        reportBtn.className = 'mealog-action-btn mealog-action-btn--danger';
        reportBtn.type = 'button';
        reportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
            const targetGroupKey = isBestShare ? `best_${postId || 'unknown'}` : isDailyShare ? `daily_${photoDate || 'nodate'}_${authorUserId || 'unknown'}` : isInsightShare ? `insight_${dateRangeText || 'no-range'}_${authorUserId || 'unknown'}` : `entry_${entryId || 'none'}_${authorUserId || 'unknown'}`;
            setTimeout(() => window.showReportModal(targetGroupKey), 100);
        });
        reportBtn.innerHTML = '<i data-lucide="flag"></i><span>신고하기</span>';
        buttonContainer.appendChild(reportBtn);
    }
    
    menuContainer.addEventListener('click', (e) => e.stopPropagation());
    if (!isCenterPopup) {
        menuContainer.appendChild(actionCard);
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'mealog-action-cancel';
        cancelBtn.textContent = '닫기';
        cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeMenu();
        });
        menuContainer.appendChild(cancelBtn);
    }
    menu.appendChild(bg);
    menu.appendChild(menuContainer);
    document.body.appendChild(menu);
    document.addEventListener('keydown', onKey);
    if (typeof window.scheduleLucideIcons === 'function') window.scheduleLucideIcons(menu);
    else if (typeof window.lucide?.createIcons === 'function') window.lucide.createIcons({ root: menu });
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
    bg.className = 'absolute inset-0 mealog-action-dim';
    bg.onclick = () => overlay.remove();
    
    const panel = document.createElement('div');
    panel.className = 'relative w-full max-w-md bg-white rounded-t-[1.5rem] sm:rounded-[1.125rem] border border-[var(--line)] p-6 pb-8 max-h-[85vh] overflow-y-auto';
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

window.editFeedPost = async (entryId) => {
    if (!entryId || entryId === '' || entryId === 'null') {
        showToast("이 게시물은 수정할 수 없습니다.", 'error');
        return;
    }
    
    const uid = window.currentUser?.uid;
    if (!uid) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    
    let record = window.mealHistory?.find(m => m.id === entryId);
    if (!record) {
        // mealHistory에는 최근 7일만 로드됨. 과거 기록은 Firestore에서 직접 조회
        try {
            const mealRef = doc(db, 'artifacts', appId, 'users', uid, 'meals', entryId);
            const mealSnap = await getDoc(mealRef);
            if (!mealSnap.exists()) {
                showToast("기록을 찾을 수 없습니다.", 'error');
                return;
            }
            record = { id: mealSnap.id, ...mealSnap.data() };
            if (!window.mealHistory) window.mealHistory = [];
            window.mealHistory.push(record);
            window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
        } catch (e) {
            console.error('editFeedPost: meal 조회 실패', e);
            showToast("기록을 불러오는 중 오류가 발생했습니다.", 'error');
            return;
        }
    }
    
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
    
    dbOps.unsharePhotos(photoUrlArray, validEntryId, isBestShare, isDailyShare, isInsightShare).catch(() => {
        if (window.sharedPhotos) window.sharedPhotos = prevSharedPhotos;
        if (record && prevRecordSharedPhotos !== null) record.sharedPhotos = prevRecordSharedPhotos;
        if (appState.currentTab === 'timeline') {
            updateTimelineShareIndicators();
            renderTimeline();
        }
        if (appState.currentTab === 'gallery') renderGallery();
    });
};
}
