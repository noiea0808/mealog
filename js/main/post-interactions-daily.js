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
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import { scheduleLucideIcons } from '../icons.js';
import { unshareWithOptimisticUpdate, getSharedPhotos, setSharedPhotos, upsertSharedPhoto } from '../utils/moment-share-state.js';
import { bindDialogGrabberPullClose } from '../utils/dialog-grabber.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import {
    getDisplayProfile,
    getProfileAvatarDisplay,
    uploadBoardImages,
    captureWithGhostStrategy,
    addCompositionAwareInput,
    warmUpIME,
    sharePhotosToExternal,
    shareBlobsToExternal,
    setupBirthdateInputFormatting
} from '../utils.js';
import { createShareBlobCache } from '../utils/share-blob-cache.js';
import { logUsageMetric } from '../usage-metrics.js';
import { applyStackCommentBtnVisual } from '../render/moment-post-interactions.js';
import {
    patchMomentFeedSocialCounts,
    syncMomentPostSeedCounts
} from '../utils/moment-feed-cache.js';
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
import { isUserSettingsReadyForContentWrites } from '../utils/user-settings-write-guard.js';
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
    DAILY_SHARE_CARD_WIDTH,
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
import { ensureAnalytics } from '../analytics/ensure.js';
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
import { DEFAULT_SUB_TAGS, REPORT_REASONS, SATIETY_DATA, MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS } from '../constants.js';
import { normalizeUrl } from '../utils.js';
import { syncOrphanedSharesToMoment } from './shares-sync.js';

// escapeHtml은 render/index.js에서 import됨

function findExistingDailyShare(dateStr, uid) {
    if (!dateStr || !uid) return null;
    return (
        getSharedPhotos().find(
            (photo) => photo.type === 'daily' && photo.date === dateStr && photo.userId === uid
        ) || null
    );
}

// 일간보기 공유: 미리보기 모달 열기 (이미 공유됨 → 하단 '공유 취소')
window.shareDailySummary = async (dateStr) => {
    try {
        if (!dateStr) {
            showToast('날짜 정보가 없습니다.', 'error');
            return;
        }
        const uid = window.currentUser?.uid;
        if (!uid) {
            showToast('로그인이 필요합니다.', 'error');
            if (typeof window.requestLogin === 'function') window.requestLogin();
            return;
        }
        window.openDailySharePreviewModal(dateStr);
    } catch (err) {
        console.error('[shareDailySummary]', err);
        showToast('공유를 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.', 'error');
    }
};

/**
 * 미리보기 축소 — 카드는 캡처 출력 폭(DAILY_SHARE_CARD_WIDTH)에 묶여 있는데 모달은 그보다 좁다.
 * (모달 폭은 min(448px, 100vw-24px) 이라 375px 기기에서 쓸 수 있는 폭이 351px 뿐이다.)
 *
 * **transform 으로만 줄인다.** 유령 캡처가 클론과 조상 래퍼 양쪽에 inline `transform:none` 을
 * 덮어쓰므로(utils.js 의 captureWithGhostStrategy·buildGhostAncestorWrappers) 이 축소는 출력
 * 이미지로 새지 않는다. zoom 은 그 방어 목록에 없어 캡처까지 같이 작아진다 — 쓰면 안 된다.
 *
 * transform 은 레이아웃 상자를 줄이지 않으므로, 줄어든 만큼을 음수 마진으로 회수해야
 * 가로 잘림(overflow-x:hidden)과 아래 빈 띠가 생기지 않는다.
 */
function fitDailySharePreviewCard(scrollEl, card) {
    if (!scrollEl || !card) return;
    const apply = () => {
        const natural = card.offsetWidth || DAILY_SHARE_CARD_WIDTH;
        // clientWidth 는 padding 을 포함한다 — 그대로 쓰면 padding 만큼 가로로 넘친다
        const pad = getComputedStyle(scrollEl);
        const avail =
            scrollEl.clientWidth - (parseFloat(pad.paddingLeft) || 0) - (parseFloat(pad.paddingRight) || 0);
        if (!natural || avail <= 0) return;
        const ratio = Math.min(1, avail / natural);
        if (ratio >= 1) {
            card.style.transform = '';
            card.style.transformOrigin = '';
            card.style.marginRight = '';
            card.style.marginBottom = '';
            return;
        }
        card.style.transformOrigin = 'top left';
        card.style.transform = `scale(${ratio})`;
        card.style.marginRight = `${-Math.round(natural * (1 - ratio))}px`;
        card.style.marginBottom = `${-Math.round(card.offsetHeight * (1 - ratio))}px`;
    };
    apply();
    // 사진·아이콘이 늦게 그려지며 높이가 변하면 아래 음수 마진이 어긋난다 → 다시 맞춘다
    if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => apply());
        ro.observe(card);
        ro.observe(scrollEl);
        card._dailySharePreviewFitObserver = ro;
    }
}

// 하루 기록 공유 미리보기 모달 열기
window.openDailySharePreviewModal = (dateStr) => {
    const existing = document.getElementById('dailySharePreviewModal');
    if (existing) existing.remove();

    let previewCard;
    try {
        previewCard = createDailyShareCard(dateStr, true);
    } catch (e) {
        console.error('일간 공유 미리보기 카드 생성 실패:', e);
        showToast('공유 미리보기를 열 수 없습니다. 잠시 후 다시 시도해 주세요.', 'error');
        return;
    }
    if (!previewCard) {
        showToast('공유 미리보기를 열 수 없습니다.', 'error');
        return;
    }

    const uid = window.currentUser?.uid;
    const existingShare = findExistingDailyShare(dateStr, uid);
    const isShared = !!existingShare;
    const safeDate = String(dateStr).replace(/'/g, '');
    const existingComment = existingShare?.comment ? String(existingShare.comment) : '';

    const modal = document.createElement('div');
    modal.id = 'dailySharePreviewModal';
    modal.className = 'fixed inset-0 z-[var(--z-onboarding)] flex items-center justify-center py-4 bg-slate-900/60 capture-share-modal';
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-labelledby', 'dailySharePreviewTitle');
    if (isShared) modal.setAttribute('data-daily-share-mode', 'unshare');

    modal.innerHTML = `
        <div class="relative w-full max-w-md mx-auto bg-white rounded-2xl flex flex-col max-h-[92vh] shadow-xl overflow-hidden border border-slate-200/80">
            <div class="mealog-dialog-grabber" role="button" tabindex="0" aria-label="아래로 스와이프하여 닫기" title="아래로 스와이프하여 닫기"></div>
            <div id="dailyShareLoadingOverlay" class="hidden absolute inset-0 bg-white/90 rounded-2xl flex flex-col items-center justify-center z-20">
                <div class="w-10 h-10 border-4 border-emerald-100 border-t-emerald-600 rounded-full animate-spin mb-3"></div>
                <p class="text-slate-600 font-bold" id="dailyShareLoadingLabel">공유 중...</p>
            </div>
            <div class="mealog-dialog-head border-b border-slate-200">
                <h2 id="dailySharePreviewTitle" class="text-base font-bold text-slate-800 tracking-tight">하루 기록 공유하기</h2>
            </div>
            <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
                <div id="dailySharePreviewScroll" class="bg-slate-50 py-0" style="padding: 3px;">
                    <!-- createDailyShareCard(forPreview) 결과가 여기 들어감 -->
                </div>
                <div class="px-4 sm:px-5 pt-3 pb-2">
                    <label for="dailyShareComment" class="text-sm font-bold text-slate-600 block mb-2">코멘트 (선택사항)</label>
                    <textarea id="dailyShareComment" placeholder="모먼트에 함께 올릴 코멘트를 입력하세요..." class="w-full p-3 bg-slate-100 rounded-xl text-sm border border-slate-200/80 focus:border-slate-400 transition-all resize-none" rows="3"></textarea>
                </div>
            </div>
            <div class="mealog-dialog-actions mealog-dialog-actions--pair mealog-dialog-actions--border">
                <button type="button" onclick="window.closeDailySharePreviewModal()" class="mealog-btn mealog-btn-secondary">닫기</button>
                <button type="button" id="dailyShareSnsBtn" onclick="window.shareDailyToSns('${safeDate}')" class="mealog-btn mealog-btn-secondary" aria-label="다른 앱으로 공유" title="카카오톡·인스타 등으로 보내기">
                    <span class="mealog-share-btn__inner"><i data-lucide="share-2" aria-hidden="true"></i><span>SNS</span></span>
                </button>
                <button type="button" id="dailyShareConfirmBtn" data-date="${safeDate}" data-mode="${isShared ? 'unshare' : 'share'}" class="${isShared ? 'mealog-btn mealog-btn-danger' : 'mealog-btn mealog-btn-primary'}">
                    <span class="mealog-share-btn__inner"><i data-lucide="send" aria-hidden="true"></i><span id="dailyShareConfirmLabel">${isShared ? '공유 취소' : '모먼트'}</span></span>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    lockBodyScroll('dailySharePreviewModal');
    const panel = modal.firstElementChild;
    if (panel) {
        bindDialogGrabberPullClose({
            root: modal,
            panel,
            onClose: () => window.closeDailySharePreviewModal()
        });
    }
    const confirmBtn = document.getElementById('dailyShareConfirmBtn');
    if (confirmBtn) {
        confirmBtn.onclick = (ev) => {
            if (confirmBtn.getAttribute('data-mode') === 'unshare') {
                void window.cancelDailyShare(safeDate, ev);
            } else {
                void window.confirmDailyShare(safeDate, ev);
            }
        };
    }
    const commentEl = document.getElementById('dailyShareComment');
    if (commentEl && existingComment) commentEl.value = existingComment;
    scheduleLucideIcons(modal);
    const scrollEl = document.getElementById('dailySharePreviewScroll');
    if (scrollEl && previewCard) {
        scrollEl.appendChild(previewCard);
        fitDailySharePreviewCard(scrollEl, previewCard);
        setTimeout(() => {
            scrollEl.scrollTop = 0;
        }, 0);
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) window.closeDailySharePreviewModal();
    });

    // 캡처는 폰트·이미지 로드까지 기다리느라 느리다. 모달이 그려진 직후 미리 돌려 둬야
    // SNS 버튼을 눌렀을 때 제스처를 잃지 않고 공유 시트가 곧바로 열린다.
    dailyShareBlobCache.clear();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            void dailyShareBlobCache.warm(dateStr);
        });
    });
};

/** 미리보기에서 일간 공유 취소 */
window.cancelDailyShare = async (dateStr) => {
    const uid = window.currentUser?.uid;
    if (!uid) {
        showToast('로그인이 필요합니다.', 'error');
        if (typeof window.requestLogin === 'function') window.requestLogin();
        return;
    }
    const existingShare = findExistingDailyShare(dateStr, uid);
    if (!existingShare?.photoUrl) {
        showToast('공유된 하루 기록을 찾을 수 없습니다.', 'error');
        window.closeDailySharePreviewModal();
        return;
    }

    const previewModal = document.getElementById('dailySharePreviewModal');
    const inModalSpinner = previewModal?.querySelector('#dailyShareLoadingOverlay');
    const loadingLabel = previewModal?.querySelector('#dailyShareLoadingLabel');
    if (loadingLabel) loadingLabel.textContent = '공유 취소 중...';
    if (inModalSpinner) inModalSpinner.classList.remove('hidden');

    const shareBtn = document.getElementById('dailyShareConfirmBtn');
    if (shareBtn) {
        shareBtn.disabled = true;
        shareBtn.className = 'mealog-btn mealog-btn-danger opacity-50 cursor-not-allowed';
        shareBtn.innerHTML =
            '<span class="mealog-share-btn__inner"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span id="dailyShareConfirmLabel">공유 취소 중...</span></span>';
        scheduleLucideIcons(shareBtn);
    }

    const photoUrlToRemove = existingShare.photoUrl;
    window.closeDailySharePreviewModal();
    showToast('공유가 취소되었습니다.', 'success');
    await unshareWithOptimisticUpdate({
        photos: [photoUrlToRemove],
        shareType: 'daily',
        matches: (p) => p.type === 'daily' && p.date === dateStr && p.userId === uid,
        onChange: () => {
            if (appState.currentTab === 'timeline') renderTimeline();
            if (appState.currentTab === 'gallery') renderGallery();
        }
    });
};

// 일간 공유 미리보기 모달 닫기
window.closeDailySharePreviewModal = () => {
    const modal = document.getElementById('dailySharePreviewModal');
    const fitted = modal?.querySelector('#dailyShareCardContainer');
    fitted?._dailySharePreviewFitObserver?.disconnect();
    if (modal) modal.remove();
    unlockBodyScroll('dailySharePreviewModal');
    // 카드가 사라졌으니 예열해 둔 이미지도 버린다 — 다음에 열 때 그 시점 내용으로 다시 뜬다.
    dailyShareBlobCache.clear();
};

// 미리보기에서 공유 확정: 미리보기 화면을 그대로 캡쳐해서 공유
/**
 * 하루 기록 공유 카드를 캡처해 canvas 로 돌려준다.
 *
 * 모먼트 공유(업로드용 base64)와 외부 SNS 공유(blob 예열)가 같은 캡처를 쓴다.
 * 캡처는 폰트·이미지 로드를 기다리느라 느리므로, SNS 쪽은 모달이 열릴 때 미리 돌려
 * 두고 클릭 시점에는 결과만 꺼내 쓴다(share-blob-cache.js).
 */
async function captureDailyShareCanvas() {
    const previewModal = document.getElementById('dailySharePreviewModal');
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

    const innerContent =
        previewCard.querySelector('.daily-share-capture__sheet') ||
        previewCard.querySelector(`div[style*="width: ${DAILY_SHARE_CARD_WIDTH}px"]`) ||
        previewCard;

    // 유령 캡처: 화면 밖(-10000px)에 복제본을 만들어 모달/transform/Flex 간섭 없이 정사이즈 캡처
    const canvas = await captureWithGhostStrategy(innerContent, {
        captureWidth: DAILY_SHARE_CARD_WIDTH,
        allowTaint: false,
        foreignObjectRendering: false,
        // html2canvas 폴백 전용 — 클론 문서 폰트 주입 (snapdom 은 embedFonts 로 처리)
        onclone: (clonedDoc) => {
            const garamCss = MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS;
            if (fredokaFontCSS) {
                const clonedStyle = clonedDoc.createElement('style');
                clonedStyle.textContent = fredokaFontCSS + garamCss;
                clonedDoc.head.appendChild(clonedStyle);
            } else {
                const clonedStyle = clonedDoc.createElement('style');
                clonedStyle.textContent =
                    `
                    @font-face {
                        font-family: 'Fredoka';
                        font-style: normal;
                        font-weight: 700;
                        font-display: swap;
                        src: url('https://fonts.gstatic.com/s/fredoka/v14/X7nP4b87HvSqjb_WIi2yDCRwoQ_k7367_DWs89XyHw.woff2') format('woff2');
                        unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
                    }
                ` + garamCss;
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
        }
    });

    return canvas;
}

/** 예열 중에는 SNS 버튼을 흐리게 — 눌러도 되지만 잠깐 기다린다는 표시다. */
function setDailySnsButtonBusy(busy) {
    const btn = document.getElementById('dailyShareSnsBtn');
    if (!btn) return;
    btn.classList.toggle('opacity-60', !!busy);
    if (busy) btn.setAttribute('aria-busy', 'true');
    else btn.removeAttribute('aria-busy');
}

/** 하루 기록 SNS 공유용 blob 예열 캐시 — 모달을 열 때 채우고 닫을 때 비운다. */
const dailyShareBlobCache = createShareBlobCache({
    capture: captureDailyShareCanvas,
    onBusy: setDailySnsButtonBusy,
    label: 'daily'
});

/**
 * 하루 기록 카드를 카카오톡·인스타 등 외부 앱으로 내보낸다.
 * 모먼트 공유와 달리 서버 상태를 건드리지 않는다 — 캡처 이미지를 공유 시트에 넘길 뿐이다.
 */
window.shareDailyToSns = async (dateStr) => {
    const btn = document.getElementById('dailyShareSnsBtn');
    if (btn?.disabled) return;

    logUsageMetric('daily_sns_share_tap').catch(() => {});
    if (btn) btn.disabled = true;
    let loadingShown = false;
    try {
        // 예열이 끝나 있으면 제스처를 잃지 않고 공유 시트가 곧바로 열린다.
        let blob = dailyShareBlobCache.get(dateStr);
        if (!blob) {
            showLoading('공유 이미지 준비 중...');
            loadingShown = true;
            blob = await dailyShareBlobCache.ensure(dateStr);
            hideLoading();
            loadingShown = false;
        }
        if (!blob) {
            showToast('공유 이미지를 만들지 못했어요.', 'error');
            return;
        }

        // 캡처 카드에 이미 MEALOG 마크가 들어가 있고 폭도 맞춰져 있다 — 다시 손대지 않는다.
        const shared = await shareBlobsToExternal([blob], {
            caption: (document.getElementById('dailyShareComment')?.value || '').trim(),
            appendLogo: false,
            resize: false,
            fileNamePrefix: `mealog_daily_${dateStr}`
        });
        if (shared) logUsageMetric('daily_sns_share_done').catch(() => {});
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('하루 기록 SNS 공유 실패:', e);
            showToast(e?.message || 'SNS 공유에 실패했어요.', 'error');
        }
    } finally {
        if (loadingShown) hideLoading();
        if (btn) btn.disabled = false;
    }
};

window.confirmDailyShare = async (dateStr, ev) => {
    const uid = window.currentUser?.uid;
    if (!uid) {
        showToast('로그인이 필요합니다.', 'error');
        if (typeof window.requestLogin === 'function') window.requestLogin();
        return;
    }
    if (window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (!isDemoUser(window.currentUser) && !isUserSettingsReadyForContentWrites(window.userSettings)) {
        showToast('약관 동의와 프로필(닉네임) 설정을 완료한 뒤 공유할 수 있습니다.', 'error');
        return;
    }

    const previewModal = document.getElementById('dailySharePreviewModal');
    const inModalSpinner = previewModal?.querySelector('#dailyShareLoadingOverlay');
    if (inModalSpinner) inModalSpinner.classList.remove('hidden');

    const fromEv = ev && ev.target && typeof ev.target.closest === 'function'
        ? ev.target.closest('#dailyShareConfirmBtn')
        : null;
    const shareBtn = document.getElementById('dailyShareConfirmBtn') || fromEv || (ev && ev.target) || document.querySelector(`button[onclick*="confirmDailyShare('${dateStr}')"]`);
    if (shareBtn) {
        shareBtn.disabled = true;
        shareBtn.classList.add('opacity-50', 'cursor-not-allowed');
        shareBtn.className = 'mealog-btn mealog-btn-primary opacity-50 cursor-not-allowed';
        shareBtn.innerHTML =
            '<span class="mealog-share-btn__inner"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span id="dailyShareConfirmLabel">공유 중...</span></span>';
        scheduleLucideIcons(shareBtn);
    }
    // 스피너가 실제로 화면에 그려진 뒤 무거운 작업 진행 (두 프레임 양보로 페인트 확실히 반영)
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 50));

    try {
        const canvas = await captureDailyShareCanvas();

        const base64Image = canvas.toDataURL('image/png');
        const { uploadBase64ToStorage } = await import('../utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, uid, `daily_${dateStr}`, 1024);

        const userProfile = window.userSettings?.profile || {};
        // 팝업 코멘트 → 모먼트 캡션(코멘트란). 캡처 이미지와 별개.
        const dailyComment =
            (document.getElementById('dailyShareComment')?.value || '').trim();

        // 낙관적 UI: 클라이언트 데이터로 즉시 반영 후 서버는 백그라운드 호출
        const dailyShareData = {
            id: 'pending-' + Date.now(),
            photoUrl,
            userId: uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            userPhotoUrl: userProfile.photoUrl || null,
            type: 'daily',
            date: dateStr,
            timestamp: new Date().toISOString(),
            entryId: null,
            comment: dailyComment || ''
        };

        upsertSharedPhoto(dailyShareData, (p) =>
            p.type === 'daily' && p.date === dateStr && p.userId === uid
        );
        // 갤러리 피드에도 낙관 반영 (맨 앞에 추가)
        if (!window.sharedPhotosFeed) window.sharedPhotosFeed = [];
        const { sortSharedPhotosByTimestampDesc } = await import('../utils/shared-photo-timestamp.js');
        window.sharedPhotosFeed = sortSharedPhotosByTimestampDesc([dailyShareData, ...(window.sharedPhotosFeed || [])]);

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
            const idx = getSharedPhotos().findIndex(p => p.id === dailyShareData.id || (p.type === 'daily' && p.date === dateStr && p.userId === uid && p.photoUrl === photoUrl));
            if (idx !== -1) {
                getSharedPhotos()[idx] = serverData;
                if (appState.currentTab === 'timeline') renderTimeline();
                if (appState.currentTab === 'gallery') renderGallery();
            }
        }).catch((e) => {
            console.error('일간보기 공유 서버 반영 실패:', e);
            if (getSharedPhotos()) {
                setSharedPhotos(getSharedPhotos().filter(p =>
                    !(p.type === 'daily' && p.date === dateStr && p.userId === uid)
                ));
                if (appState.currentTab === 'timeline') renderTimeline();
                if (appState.currentTab === 'gallery') renderGallery();
            }
            showToast(getUserFacingErrorMessage(e, 'share'), 'error');
        });
    } catch (e) {
        console.error('일간보기 공유 실패:', e);
        showToast(getUserFacingErrorMessage(e, 'share'), 'error');
        window.closeDailySharePreviewModal();
    } finally {
        const modal = document.getElementById('dailySharePreviewModal');
        const spinner = modal?.querySelector('#dailyShareLoadingOverlay');
        if (spinner) spinner.classList.add('hidden');
        // 버튼 상태 복원 (모달이 아직 DOM에 있을 때만)
        const shareBtn = document.getElementById('dailyShareConfirmBtn') || document.querySelector(`button[onclick*="confirmDailyShare('${dateStr}')"]`);
        if (shareBtn) {
            shareBtn.disabled = false;
            shareBtn.className = 'mealog-btn mealog-btn-primary';
            shareBtn.innerHTML =
                '<span class="mealog-share-btn__inner"><i data-lucide="send" aria-hidden="true"></i><span id="dailyShareConfirmLabel">모먼트</span></span>';
            scheduleLucideIcons(shareBtn);
        }
    }
};



// 일간보기 실제 공유 실행 (캡처 → 업로드 → Firestore) - 사용하지 않음 (confirmDailyShare에서 직접 처리)
/*
window.executeDailyShare = async (dateStr) => {
    // 이 함수는 더 이상 사용하지 않습니다. confirmDailyShare에서 미리보기 화면을 직접 캡쳐합니다.
};
*/

function getDailyJournalSectionForDate(date, sourceEl = null) {
    const dateStr = String(date || '');
    const scopedSection = sourceEl?.closest?.('.daily-journal-section');
    if (scopedSection && (!dateStr || scopedSection.getAttribute('data-mealog-date') === dateStr)) {
        return scopedSection;
    }
    return [...document.querySelectorAll('.daily-journal-section')].find(
        (el) => el.getAttribute('data-mealog-date') === dateStr
    );
}

function getDailyCommentInputForDate(date, sourceEl = null) {
    const section = getDailyJournalSectionForDate(date, sourceEl);
    if (section) {
        const scopedInput = section.querySelector('textarea[data-mealog-daily-comment-input], #dailyCommentInput');
        if (scopedInput) return scopedInput;
    }
    return document.getElementById('dailyCommentInput');
}

function collectDailyVitalsFromSection(section) {
    if (!section) {
        return { weight: '', glucose: '', weightOn: false, glucoseOn: false };
    }
    const weightToggle = section.querySelector('[data-vital-toggle="weight"]');
    const glucoseToggle = section.querySelector('[data-vital-toggle="glucose"]');
    const weightInput = section.querySelector('[data-vital-input="weight"]');
    const glucoseInput = section.querySelector('[data-vital-input="glucose"]');
    return {
        weight: weightInput?.value?.trim() || '',
        glucose: glucoseInput?.value?.trim() || '',
        weightOn: weightToggle?.checked === true,
        glucoseOn: glucoseToggle?.checked === true
    };
}

// 일간보기 하루 기록(일간 코멘트) 저장 함수
window.saveDailyComment = async (date, sourceEl = null) => {
    const input = getDailyCommentInputForDate(date, sourceEl);
    if (!input) {
        console.warn('[saveDailyComment] #dailyCommentInput 없음 — 타임라인「일간」모드에서만 표시됩니다.');
        showToast('하루 기록 영역을 찾을 수 없어요. 타임라인에서「일간」보기로 전환한 뒤 다시 시도해 주세요.', 'error');
        return;
    }
    
    const comment = input.value || '';
    const section = getDailyJournalSectionForDate(date, sourceEl);
    const vitals = collectDailyVitalsFromSection(section);
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        await dbOps.saveDailyComment(date, comment);
        if (typeof dbOps.saveDailyVitals === 'function') {
            await dbOps.saveDailyVitals(date, vitals);
        }
        showToast('하루 기록이 저장되었습니다.', 'success');
        // 전체 renderTimeline()은 스크롤·레이아웃이 튀므로 생략 — 이미 메모리·Firestore에 반영됨
        if (input) input.blur();
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
    modal.className = 'fixed inset-0 z-[var(--z-onboarding)] flex items-center justify-center p-4 bg-black/50';
    
    modal.innerHTML = `
        <div class="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div class="flex justify-between items-center mb-4">
                <h3 class="text-base font-black text-slate-800">하루 기록 수정</h3>
                <button type="button" onclick="window.closeDailyCommentModal()" class="text-slate-400 hover:text-slate-600">
                    <i data-lucide="x" class="text-xl"></i>
                </button>
            </div>
            <textarea id="dailyCommentModalInput" 
                placeholder="오늘 하루는 어떠셨나요? 하루 전체에 대한 생각을 기록해보세요." 
                class="w-full p-4 bg-slate-50 rounded-xl text-sm border border-slate-200 focus:border-slate-400 transition-all resize-none min-h-[150px]" 
                rows="6">${escapeHtml(currentComment)}</textarea>
            <div class="flex gap-3 mt-6">
                <button type="button" onclick="window.closeDailyCommentModal()" class="flex-1 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold text-sm">
                    취소
                </button>
                <button type="button" onmousedown="event.preventDefault()" onclick="window.saveDailyCommentFromModal('${dateStr}')" class="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold text-sm hover:bg-emerald-700">
                    저장
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    lockBodyScroll('dailyCommentModal');

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
    unlockBodyScroll('dailyCommentModal');
};

// 모달에서 일간보기 코멘트 저장
window.saveDailyCommentFromModal = async (dateStr) => {
    const input = document.getElementById('dailyCommentModalInput');
    if (!input) {
        console.warn('[saveDailyCommentFromModal] 입력란 없음');
        showToast('입력란을 찾을 수 없습니다. 모달을 닫았다가 다시 열어 주세요.', 'error');
        return;
    }
    
    const comment = input.value || '';
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        await dbOps.saveDailyComment(dateStr, comment);
        showToast('하루 기록이 저장되었습니다.', 'success');
        window.closeDailyCommentModal();
        if (appState.currentTab === 'timeline' && appState.viewMode === 'page') {
            const d = appState.pageDate;
            const pageStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (pageStr === dateStr) {
                const inlineIn = getDailyCommentInputForDate(dateStr);
                if (inlineIn) inlineIn.value = comment;
            }
        }
        // 타임라인은 하루 기록만 바뀐 경우 풀 렌더 시 스크롤이 튐 → 생략 (데이터는 이미 반영됨)
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

/** 타임라인「일간」공유/하루 기록 저장 — 인라인 onclick 대신 위임 (CSP·캡처 단계 이슈 회피) */
const _mealogDailyTimelineBound = new WeakMap();
function bindMealogDailyTimelineDelegation() {
    const root = document.getElementById('timelineContainer');
    if (!root) return;
    if (_mealogDailyTimelineBound.has(root)) return;
    _mealogDailyTimelineBound.set(root, true);
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-mealog-daily]');
        if (!btn || !root.contains(btn)) return;
        const kind = btn.getAttribute('data-mealog-daily');
        const dateStr = btn.getAttribute('data-mealog-date') || '';
        if (!kind || !dateStr) return;
        if (kind === 'share') {
            if (typeof window.shareDailySummary === 'function') {
                void window.shareDailySummary(dateStr);
            } else {
                console.error('[Mealog] shareDailySummary 미정의');
                showToast('공유 기능을 불러오지 못했습니다. 페이지를 새로고침 해 주세요.', 'error');
            }
        } else if (kind === 'save-comment') {
            if (typeof window.saveDailyComment === 'function') {
                void window.saveDailyComment(dateStr, btn);
            } else {
                console.error('[Mealog] saveDailyComment 미정의');
                showToast('저장 기능을 불러오지 못했습니다. 페이지를 새로고침 해 주세요.', 'error');
            }
        }
    });
}
window.bindMealogDailyTimelineDelegation = bindMealogDailyTimelineDelegation;
bindMealogDailyTimelineDelegation();

export function registerMainPostInteractions() {
// 로그인 요청 함수
window.requestLogin = () => {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast("로그인이 필요합니다. 로그인해주세요.", 'error');
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
        if (appState.currentTab === 'dashboard') {
            void ensureAnalytics().then((m) => m.updateDashboard()).catch(() => {});
        }
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
        showToast(DEMO_TOAST_CANNOT_LIKE, 'error');
        return;
    }
    
    try {
        const result = await postInteractions.toggleLike(postId, window.currentUser.uid);

        document.querySelectorAll(`.post-like-btn[data-post-id="${postId}"]`).forEach((likeBtn) => {
            const likeIcon = likeBtn.querySelector('.post-like-icon');
            if (!likeIcon) return;
            const inOverlay = Boolean(likeBtn.closest('#timelineMealPhotosOverlay'));
            const inMomentPhoto = Boolean(likeBtn.querySelector('.post-like-fill'));
            if (inMomentPhoto) {
                likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-red-400', 'text-slate-800', 'text-white', 'text-white/95');
                likeIcon.classList.add('fa-regular', 'fa-heart', 'timeline-meal-photo-moment-social-icon', 'relative', 'z-[1]', 'text-white/95');
                likeBtn.classList.toggle('post-social-state-on', Boolean(result.liked));
                return;
            }
            if (result.liked) {
                likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800', 'text-white', 'text-white/95', 'text-red-500');
                likeIcon.classList.add('fa-solid', 'fa-heart', ...(inOverlay ? [] : ['text-red-500']));
            } else {
                likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-red-400');
                likeIcon.classList.add('fa-regular', 'fa-heart', inOverlay ? 'text-white/95' : 'text-slate-800');
            }
        });

        let likeCount = 0;
        if (postInteractions.getLikeCount) {
            likeCount = await postInteractions.getLikeCount(postId);
        } else {
            const likes = await postInteractions.getLikes(postId);
            likeCount = likes.length || 0;
        }
        const likeText = likeCount > 0 ? String(likeCount) : '';
        document.querySelectorAll(`.post-like-count[data-post-id="${postId}"]`).forEach((el) => {
            el.textContent = likeText;
        });
        // 탭 재진입 시 시드/캐시가 비지 않도록 동기화 (likeCount 문서는 트리거로 보정)
        window.sharedPhotosFeed = patchMomentFeedSocialCounts(window.sharedPhotosFeed, postId, { likeCount });
        syncMomentPostSeedCounts(postId, { likeCount });
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
        showToast(DEMO_TOAST_CANNOT_BOOKMARK, 'error');
        return;
    }
    
    try {
        const result = await postInteractions.toggleBookmark(postId, window.currentUser.uid);

        document.querySelectorAll(`.post-bookmark-btn[data-post-id="${postId}"]`).forEach((bookmarkBtn) => {
            const bookmarkIcon = bookmarkBtn.querySelector('.post-bookmark-icon');
            if (!bookmarkIcon) return;
            const inOverlay = Boolean(bookmarkBtn.closest('#timelineMealPhotosOverlay'));
            const inMomentPhoto = Boolean(bookmarkBtn.querySelector('.post-bookmark-fill'));
            if (inMomentPhoto) {
                bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800', 'text-white', 'text-white/95');
                bookmarkIcon.classList.add('fa-regular', 'fa-bookmark', 'timeline-meal-photo-moment-social-icon', 'relative', 'z-[1]', 'text-white/95');
                bookmarkBtn.classList.toggle('post-social-state-on', Boolean(result.bookmarked));
                return;
            }
            if (result.bookmarked) {
                bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark', 'text-white', 'text-slate-800');
                bookmarkIcon.classList.add('fa-solid', 'fa-bookmark', ...(inOverlay ? [] : ['text-slate-800']));
            } else {
                bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800', 'text-white', 'text-white/95');
                bookmarkIcon.classList.add('fa-regular', 'fa-bookmark', inOverlay ? 'text-white/95' : 'text-slate-800');
            }
        });
        const bookmarks = await postInteractions.getBookmarks(postId);
        const bmCount = bookmarks.length || 0;
        const bmText = bmCount > 0 ? String(bmCount) : '';
        document.querySelectorAll(`.post-bookmark-count[data-post-id="${postId}"]`).forEach((el) => {
            el.textContent = bmText;
        });
        if (result.bookmarked) {
            showToast('북마크에 추가되었습니다.', 'success');
        } else {
            showToast('북마크에서 제거되었습니다.', 'info');
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
        showToast(getUserFacingErrorMessage(e, 'comment'), 'error');
        
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
    
    let commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
    if (!commentsListEl) {
        const mo = document.getElementById('timelineMealPhotosOverlay');
        if (mo && !mo.classList.contains('hidden') && mo._mealPhotoPostCommentsOpen) {
            commentsListEl = mo.querySelector('[data-meal-overlay-post-comments-list]');
        }
    }
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
    const isMealPhotoOverlayList = Boolean(commentsListEl?.getAttribute?.('data-meal-overlay-post-comments-list'));

    // 낙관적 업데이트: 즉시 UI에서 제거
    const commentEl = commentsListEl?.querySelector(`[onclick*="deleteCommentFromPost('${commentId}'"]`)?.closest(
        '.moment-v2-social-comment, .mb-1.text-sm, [data-comment-id]'
    );
    let wasVisible = false;
    if (commentEl) {
        wasVisible = true;
        commentEl.remove();
    }
    
    // 댓글 개수 즉시 감소
    if (commentCountEl) {
        const currentCount = parseInt(commentCountEl.textContent) || 0;
        const next = currentCount > 0 ? currentCount - 1 : 0;
        commentCountEl.textContent = next > 0 ? String(next) : '';
        window.sharedPhotosFeed = patchMomentFeedSocialCounts(window.sharedPhotosFeed, postId, { commentCount: next });
        syncMomentPostSeedCounts(postId, { commentCount: next });
        document.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((el) => {
            if (el !== commentCountEl) el.textContent = next > 0 ? String(next) : '';
        });
    }
    
    // 댓글 목록이 비어있으면 스타일 제거
    const isMomentV2SheetList = Boolean(commentsListEl?.closest?.('.moment-v2-social-comments-sheet'));
    if (commentsListEl) {
        const remainingComments = commentsListEl.querySelectorAll('.moment-v2-social-comment, .mb-1.text-sm');
        if (remainingComments.length === 0) {
            commentsListEl.innerHTML = '';
            if (!isMealPhotoOverlayList) commentsListEl.classList.remove('bg-slate-50');
            if (viewCommentsBtn) viewCommentsBtn.classList.add('hidden');
            collapseMomentV2SocialPanelIfListEmpty(String(postId));
            if (isMomentV2SheetList) syncMomentV2SocialCommentEmptyOverlay(String(postId));
        } else {
            // 댓글 개수 업데이트
            const newCount = parseInt(commentCountEl?.textContent) || 0;
            if (isMomentV2SheetList) syncMomentV2SocialCommentSheetCount(postId, remainingComments.length);
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
                    const isLoggedInDel = window.currentUser && !window.currentUser.isAnonymous;
                    const hasCommentedAfterDel =
                        isLoggedInDel &&
                        Array.isArray(comments) &&
                        comments.some((c) => (c.userId || c.authorId) === window.currentUser?.uid);
                    document.querySelectorAll('.post-comment-btn[data-post-id]').forEach((btn) => {
                        if (btn.getAttribute('data-post-id') !== String(postId)) return;
                        if (!btn.querySelector('.post-comment-fill')) return;
                        if (hasCommentedAfterDel) btn.setAttribute('data-post-user-commented', '1');
                        else btn.removeAttribute('data-post-user-commented');
                    });
                    applyStackCommentBtnVisual(postId);

                    // 댓글 개수 업데이트
                    if (commentCountEl) {
                        commentCountEl.textContent = comments.length > 0 ? comments.length : '';
                    }
                    window.sharedPhotosFeed = patchMomentFeedSocialCounts(window.sharedPhotosFeed, postId, {
                        commentCount: comments.length
                    });
                    syncMomentPostSeedCounts(postId, { commentCount: comments.length });
                    document.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((el) => {
                        el.textContent = comments.length > 0 ? String(comments.length) : '';
                    });
                    
                    if (commentsListEl && isMealPhotoOverlayList && typeof window.loadPostCommentsForMealPhotoOverlayList === 'function') {
                        await window.loadPostCommentsForMealPhotoOverlayList(postId, commentsListEl);
                    } else if (commentsListEl) {
                        const isMomentV2SheetAfterDel = Boolean(
                            commentsListEl.closest?.('.moment-v2-social-comments-sheet')
                        );
                        if (comments.length === 0) {
                            commentsListEl.innerHTML = '';
                            commentsListEl.classList.remove('bg-slate-50');
                            if (viewCommentsBtn) viewCommentsBtn.classList.add('hidden');
                            collapseMomentV2SocialPanelIfListEmpty(String(postId));
                            syncMomentV2SocialCommentEmptyOverlay(String(postId));
                        } else if (isMomentV2SheetAfterDel) {
                            const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                            try {
                                await fetchUserProfiles(
                                    [...new Set(comments.map((c) => c.userId).filter(Boolean))]
                                );
                            } catch (_) {}
                            commentsListEl.innerHTML = comments
                                .map((c) => {
                                    let dateStr = '';
                                    let timeStr = '';
                                    if (c.timestamp) {
                                        try {
                                            const commentDate =
                                                c.timestamp instanceof Date
                                                    ? c.timestamp
                                                    : c.timestamp.toDate
                                                      ? c.timestamp.toDate()
                                                      : new Date(c.timestamp);
                                            if (!isNaN(commentDate.getTime())) {
                                                dateStr = commentDate.toLocaleDateString('ko-KR', {
                                                    month: 'numeric',
                                                    day: 'numeric'
                                                });
                                                timeStr = commentDate.toLocaleTimeString('ko-KR', {
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                    hour12: false
                                                });
                                            }
                                        } catch (_) {
                                            /* ignore */
                                        }
                                    }
                                    const { nickname, avatarProfile } = resolveMomentV2CommentDisplay(c);
                                    return buildMomentV2SocialCommentRowHtml({
                                        commentId: c.id,
                                        postId,
                                        nickname,
                                        avatarProfile,
                                        body: c.comment || '',
                                        dateStr,
                                        timeStr,
                                        showDelete: isLoggedIn && c.userId === window.currentUser?.uid
                                    });
                                })
                                .join('');
                            syncMomentV2SocialCommentEmptyOverlay(String(postId));
                        } else {
                            commentsListEl.classList.add('bg-slate-50');
                            const displayComments = comments.slice(0, 2);
                            const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
                            commentsListEl.innerHTML = displayComments.map(c => {
                                const commentDisplay = getDisplayProfile(
                                c.userId,
                                { nickname: c.userNickname, icon: c.userIcon },
                                { preferStoredNickname: true }
                            );
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

const MV2_SOCIAL_SHEET_BODY_CLASS = 'moment-v2-social-comments-panel--sheet-in-body';

function mv2EscapeAttr(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildMomentV2SocialCommentAvatarHtml(profile = {}) {
    const av = getProfileAvatarDisplay(profile || {});
    if (av.type === 'photo') {
        return `<span class="moment-v2-social-comment__avatar" aria-hidden="true"><img src="${mv2EscapeAttr(av.value)}" alt="" decoding="async" loading="lazy" referrerpolicy="no-referrer" /></span>`;
    }
    const emojiClass = av.type === 'emoji' ? ' moment-v2-social-comment__avatar--emoji' : '';
    return `<span class="moment-v2-social-comment__avatar${emojiClass}" aria-hidden="true">${escapeHtml(av.value)}</span>`;
}

/** Soft Mint 모먼트 댓글 시트 행 — 왼쪽 아바타 + 닉/본문 */
function buildMomentV2SocialCommentRowHtml({
    commentId = '',
    postId = '',
    nickname = '',
    body = '',
    dateStr = '',
    timeStr = '',
    showDelete = false,
    tempId = '',
    avatarProfile = null
} = {}) {
    const safePostId = String(postId || '').replace(/'/g, "\\'");
    const safeCommentId = String(commentId || '').replace(/'/g, "\\'");
    const idAttr = commentId
        ? ` data-comment-id="${mv2EscapeAttr(commentId)}"`
        : tempId
          ? ` data-temp-comment-id="${mv2EscapeAttr(tempId)}"`
          : '';
    const timeHtml =
        dateStr && timeStr
            ? `<time class="moment-v2-social-comment__time">${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</time>`
            : '';
    const deleteHtml = showDelete
        ? `<button type="button" onclick="window.deleteCommentFromPost('${safeCommentId || String(tempId || '').replace(/'/g, "\\'")}', '${safePostId}')" class="moment-v2-social-comment__delete">삭제</button>`
        : '';
    const bodyHtml = body
        ? `<p class="moment-v2-social-comment__body">${escapeHtml(body)}</p>`
        : '';
    const avatarHtml = buildMomentV2SocialCommentAvatarHtml(
        avatarProfile || { nickname, icon: null, photoUrl: null }
    );
    return `<div class="moment-v2-social-comment"${idAttr}>
    ${avatarHtml}
    <div class="moment-v2-social-comment__main">
      <div class="moment-v2-social-comment__head">
        <div class="moment-v2-social-comment__meta">
          <button type="button" class="moment-v2-social-comment__nick" data-mv2-mention-nick="${mv2EscapeAttr(nickname)}">${escapeHtml(nickname)}</button>
          ${timeHtml}
        </div>
        ${deleteHtml}
      </div>
      ${bodyHtml}
    </div>
  </div>`;
}

/** 닉네임은 스냅샷 우선, 아바타는 캐시/프로필 반영 */
function resolveMomentV2CommentDisplay(comment) {
    const stored = {
        nickname: comment?.userNickname,
        icon: comment?.userIcon,
        photoUrl: comment?.userPhotoUrl
    };
    const nickDisplay = getDisplayProfile(comment?.userId, stored, { preferStoredNickname: true });
    const avatarProfile = getDisplayProfile(comment?.userId, stored);
    return { nickname: nickDisplay.nickname, avatarProfile };
}

function syncMomentV2SocialCommentSheetCount(postId, count) {
    const pid = String(postId ?? '');
    const section = document.getElementById(`comment-section-${pid}`);
    if (!section?.classList?.contains('moment-v2-social-comments-panel')) return;
    const countEl = section.querySelector('[data-moment-v2-social-comments-count="1"]');
    const list = section.querySelector('.moment-v2-social-comments-list');
    const n = Number.isFinite(Number(count))
        ? Math.max(0, Number(count))
        : list
          ? list.querySelectorAll('.moment-v2-social-comment').length
          : 0;
    if (list) list.classList.toggle('has-items', n > 0);
    if (!countEl) return;
    if (n > 0) {
        countEl.textContent = String(n);
        countEl.hidden = false;
    } else {
        countEl.textContent = '';
        countEl.hidden = true;
    }
}

function syncMomentV2CommentTextareaHeight(textarea) {
    if (!textarea || textarea.tagName !== 'TEXTAREA') return;
    const maxPx = 176;
    textarea.style.height = 'auto';
    const h = Math.min(Math.max(textarea.scrollHeight, 40), maxPx);
    textarea.style.height = `${h}px`;
}

function mv2InsertMentionIntoInput(postId, nickname) {
    const pid = String(postId ?? '');
    const nick = String(nickname ?? '').trim();
    if (!pid || !nick) return;
    const input = document.getElementById(`comment-text-${pid}`);
    if (!input) return;
    const tag = `@${nick}`;
    const cur = String(input.value ?? '');
    if (cur.includes(tag)) {
        input.focus();
        return;
    }
    const prefix = cur.length > 0 && !/\s$/.test(cur) ? ' ' : '';
    input.value = `${cur}${prefix}${tag} `;
    input.focus();
    try {
        syncMomentV2CommentTextareaHeight(input);
    } catch (_) {}
    try {
        const end = input.value.length;
        input.setSelectionRange(end, end);
    } catch (_) {}
}

function mv2NotifyIfMentionedOnce(postId, comment) {
    try {
        const u = window.currentUser;
        if (!u || u.isAnonymous) return;
        const myNick = String(window.userSettings?.profile?.nickname || '').trim();
        if (!myNick) return;
        if (!comment || comment.userId === u.uid) return;
        const text = String(comment.comment || '');
        if (!text) return;
        const re = new RegExp(`(^|\\s)@${myNick.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?=\\s|$|[.,!?:;\\)\\]】\\}])`, 'u');
        if (!re.test(text)) return;
        const id = String(comment.id || '');
        if (!window._mv2MentionNotified) window._mv2MentionNotified = new Set();
        if (id && window._mv2MentionNotified.has(id)) return;
        if (id) window._mv2MentionNotified.add(id);
        if (typeof window.showToast === 'function') {
            const from = String(comment.userNickname || '누군가');
            window.showToast(`${from}님이 회원님을 언급했어요`, 'info');
        }
        try {
            if (typeof window.pushMomentMentionNotification === 'function') {
                const from = String(comment.userNickname || '누군가');
                window.pushMomentMentionNotification(String(postId ?? ''), from, Date.now());
            }
        } catch (_) {}
    } catch (_) {}
}

function bindMomentV2MentionDelegation(commentSection) {
    if (!commentSection || commentSection.dataset.mv2MentionBound === '1') return;
    commentSection.dataset.mv2MentionBound = '1';
    commentSection.addEventListener('click', (e) => {
        const t = e.target;
        const el = t?.closest?.('[data-mv2-mention-nick]');
        if (!el) return;
        const nick = el.getAttribute('data-mv2-mention-nick') || '';
        const pid = String(commentSection.id || '').replace(/^comment-section-/, '');
        if (!pid) return;
        e.preventDefault();
        e.stopPropagation();
        mv2InsertMentionIntoInput(pid, nick);
    });
}

function syncMomentV2SocialCommentEmptyOverlay(postId) {
    const pid = String(postId ?? '');
    const section = document.getElementById(`comment-section-${pid}`);
    if (!section?.classList?.contains('moment-v2-social-comments-panel')) return;
    const overlay = section.querySelector('[data-moment-v2-social-comments-empty="1"]');
    const list = section.querySelector('.post-comments-list');
    if (!overlay || !list) return;

    const hasCommentRows = Boolean(list.querySelector('.moment-v2-social-comment, .mb-1'));
    if (hasCommentRows) {
        section.classList.remove('comments-empty');
        overlay.classList.add('hidden');
        list.classList.remove('hidden');
        syncMomentV2SocialCommentSheetCount(pid);
        return;
    }

    // 빈 상태: 리스트는 비우고(플레이스홀더는 오버레이로만), 오버레이를 본문 중앙에 표시
    list.innerHTML = '';
    list.classList.add('hidden');
    list.classList.remove('has-items');
    overlay.classList.remove('hidden');
    syncMomentV2SocialCommentSheetCount(pid, 0);
}

/** 모먼트2 하단 시트: 핸들·헤더 아래로 드래그해 닫기 (센터 다이얼로그 grabber와 동일 pointer 경로) */
function bindMomentV2SocialSheetHandlePullClose(commentSection) {
    const sheet = commentSection.querySelector('.moment-v2-social-comments-sheet');
    const handle = commentSection.querySelector('.moment-v2-social-comments-sheet-handle');
    const header = commentSection.querySelector('.moment-v2-social-comments-sheet-header');
    if (!sheet || !handle) return;
    if (commentSection.dataset.mv2PullBound === '1') return;
    commentSection.dataset.mv2PullBound = '1';

    const postId = String(commentSection.id || '').replace(/^comment-section-/, '');
    const onClose = () => {
        if (postId) window.closeMomentV2SocialCommentSheet?.(postId);
    };
    const isDisabled = () =>
        commentSection.classList.contains('hidden') ||
        !commentSection.classList.contains('comment-input-open');

    bindDialogGrabberPullClose({
        root: commentSection,
        panel: sheet,
        grabber: handle,
        threshold: 72,
        onClose,
        isDisabled
    });
    // 얇은 핸들만으로는 터치가 거의 안 잡히므로 헤더도 동일 제스처 허용
    if (header) {
        bindDialogGrabberPullClose({
            root: commentSection,
            panel: sheet,
            grabber: header,
            threshold: 72,
            onClose,
            isDisabled
        });
    }
}

/*
 * 배경 잠금은 공용 lockBodyScroll 로 — html overflow:hidden 만으로는 실기기 터치가
 * 새고, scrollY 도 살아 있어 키보드 핀(overlay-keyboard-pin 의 scrollTo(0,0))이
 * 피드를 맨 위로 날려 버렸다("댓글 열면 뒤의 사진이 휘리릭"). 잠그면 scrollY=0 이라
 * 그 경로가 무해해지고, 닫을 때 원래 위치로 되돌린다.
 */
const MV2_SOCIAL_SHEET_LOCK_OWNER = 'mv2SocialCommentSheet';

function mv2SetSocialSheetBodyScrollLock(on) {
    if (typeof document === 'undefined' || !document.documentElement) return;
    document.documentElement.classList.toggle('mv2-social-comment-sheet-open', Boolean(on));
    if (on) lockBodyScroll(MV2_SOCIAL_SHEET_LOCK_OWNER);
    else unlockBodyScroll(MV2_SOCIAL_SHEET_LOCK_OWNER);
}

/** 열려 있고 돌아갈 자리(캡션 푸터)가 아직 문서에 있는 시트 — 재배치가 건드리면 안 된다 */
function isMomentV2SocialCommentSheetOpenInBody(commentSection) {
    return (
        commentSection?.dataset?.mv2SheetInBody === '1' &&
        !commentSection.classList.contains('hidden') &&
        commentSection.classList.contains('comment-input-open') &&
        Boolean(commentSection._mv2SheetAnchorParent?.isConnected)
    );
}

function mountMomentV2SocialCommentSheetToBody(commentSection) {
    if (!commentSection || commentSection.dataset.mv2SheetInBody === '1') return;
    commentSection.dataset.mv2SheetInBody = '1';
    commentSection._mv2SheetAnchorParent = commentSection.parentNode;
    commentSection._mv2SheetAnchorNext = commentSection.nextSibling;
    document.body.appendChild(commentSection);
    commentSection.classList.add(MV2_SOCIAL_SHEET_BODY_CLASS);
    bindMomentV2SocialSheetHandlePullClose(commentSection);
    bindMomentV2MentionDelegation(commentSection);
    try {
        const postId = String(commentSection.id || '').replace(/^comment-section-/, '');
        if (postId) syncMomentV2SocialCommentEmptyOverlay(postId);
    } catch (_) {}
    try {
        if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons(commentSection);
        else if (typeof window.lucide?.createIcons === 'function') {
            window.lucide.createIcons({ root: commentSection });
        }
    } catch (_) {}
    mv2SetSocialSheetBodyScrollLock(true);
}

function restoreMomentV2SocialCommentSheetFromBody(commentSection) {
    if (!commentSection || commentSection.dataset.mv2SheetInBody !== '1') return;
    const p = commentSection._mv2SheetAnchorParent;
    const n = commentSection._mv2SheetAnchorNext;
    if (p && commentSection.isConnected) {
        try {
            if (n && n.parentNode === p) {
                p.insertBefore(commentSection, n);
            } else {
                p.appendChild(commentSection);
            }
        } catch (_) {
            try {
                p.appendChild(commentSection);
            } catch (_) {
                /* ignore */
            }
        }
    }
    delete commentSection.dataset.mv2SheetInBody;
    commentSection._mv2SheetAnchorParent = null;
    commentSection._mv2SheetAnchorNext = null;
    commentSection.classList.remove(MV2_SOCIAL_SHEET_BODY_CLASS);
    if (!document.querySelector(`.moment-v2-social-comments-panel.${MV2_SOCIAL_SHEET_BODY_CLASS}`)) {
        mv2SetSocialSheetBodyScrollLock(false);
    }
}

/*
 * 휠 레이아웃의 캡션 재배치(scrollend·resize·focusin 마다)가 부른다. 열린 시트까지
 * 피드 안으로 되돌리면 댓글창에 포커스가 가는 순간 시트가 body 를 떠나 잠금이
 * 풀리고, 댓글 로드가 끝나면 다시 body 로 — 이 왕복이 "시트 뒤가 가끔 스크롤"의
 * 원인이었다. 열린 시트는 두고, 피드가 다시 그려져 자리를 잃은 시트만 거둔다.
 */
function restoreAllMomentV2SocialCommentSheetsFromBody() {
    let stillOpen = false;
    document.querySelectorAll(`.moment-v2-social-comments-panel.${MV2_SOCIAL_SHEET_BODY_CLASS}`).forEach((el) => {
        if (isMomentV2SocialCommentSheetOpenInBody(el)) {
            stillOpen = true;
            return;
        }
        restoreMomentV2SocialCommentSheetFromBody(el);
    });
    if (!stillOpen) mv2SetSocialSheetBodyScrollLock(false);
}

window.restoreMomentV2SocialCommentSheetsFromBody = restoreAllMomentV2SocialCommentSheetsFromBody;

/** 모먼트2: 하단 시트(스크림) 닫기 */
window.closeMomentV2SocialCommentSheet = (postId) => {
    const pid = String(postId ?? '');
    const inputWrap = document.getElementById(`comment-input-${pid}`);
    const commentSection = document.getElementById(`comment-section-${pid}`);
    if (!commentSection?.classList?.contains('moment-v2-social-comments-panel')) return;
    if (inputWrap) inputWrap.classList.add('hidden');
    commentSection.classList.remove('comment-input-open');
    commentSection.classList.add('hidden');
    restoreMomentV2SocialCommentSheetFromBody(commentSection);
};
window.Mealog.closeMomentV2SocialCommentSheet = window.closeMomentV2SocialCommentSheet;
window.Mealog.syncMomentV2SocialCommentEmptyOverlay = syncMomentV2SocialCommentEmptyOverlay;

function collapseMomentV2SocialPanelIfListEmpty(postId) {
    const commentSection = document.getElementById(`comment-section-${postId}`);
    if (!commentSection?.classList?.contains('moment-v2-social-comments-panel')) {
        return;
    }
    const list = commentSection.querySelector && commentSection.querySelector('.post-comments-list');
    const hasList =
        list &&
        list.innerHTML &&
        list.innerHTML.replace(/&nbsp;|\s|<!--[\s\S]*?-->/g, '').length > 0;
    if (hasList) {
        return;
    }
    // 모먼트2 하단 시트: 댓글이 0개여도 시트를 접지 않고 빈 상태를 표시한다.
    syncMomentV2SocialCommentEmptyOverlay(postId);
    commentSection.classList.remove('comments-empty');
    commentSection.classList.remove('hidden');
}

// 댓글 모두 보기 함수
window.viewAllComments = async (postId) => {
    try {
        const alternates = getAlternatePostIdsForPost(postId);
        const comments = await postInteractions.getComments(postId, alternates);
        const commentsListEl = document.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
        const isMomentV2Sheet = Boolean(commentsListEl?.closest?.('.moment-v2-social-comments-sheet'));
        
        if (commentsListEl) {
            if (comments.length > 0) {
                if (!isMomentV2Sheet) commentsListEl.classList.add('bg-slate-50');
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
                    const { nickname, avatarProfile } = resolveMomentV2CommentDisplay(comment);
                    mv2NotifyIfMentionedOnce(postId, comment);
                    if (isMomentV2Sheet) {
                        return buildMomentV2SocialCommentRowHtml({
                            commentId: comment.id,
                            postId,
                            nickname,
                            avatarProfile,
                            body: comment.comment || '',
                            dateStr,
                            timeStr,
                            showDelete: isMyComment
                        });
                    }
                    return `
                        <div class="mb-1 text-sm">
                            <button type="button" class="font-bold text-slate-800" data-mv2-mention-nick="${mv2EscapeAttr(nickname)}">${escapeHtml(nickname)}</button>
                            <span class="text-slate-800 ml-2">${escapeHtml(comment.comment || '')}</span>
                            ${dateStr && timeStr ? `<span class="text-xs text-slate-500 ml-2">${dateStr} ${timeStr}</span>` : ''}
                            ${isMyComment ? `<button onclick="window.deleteCommentFromPost('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `;
                }).join('');
            } else {
                commentsListEl.innerHTML = '';
                commentsListEl.classList.remove('bg-slate-50');
            }
            
        }
        const v2Section = document.getElementById(`comment-section-${postId}`);
        if (v2Section?.classList?.contains('moment-v2-social-comments-panel')) {
            // toggleCommentInput 이 이미 올린 시트를 댓글 로드 뒤 다시 내렸다 올리지 않는다
            const alreadyOpen =
                v2Section.dataset.mv2SheetInBody === '1' &&
                !v2Section.classList.contains('hidden') &&
                v2Section.classList.contains('comment-input-open');
            if (!alreadyOpen) {
                v2Section.classList.remove('comment-input-open');
                v2Section.classList.remove('hidden');
                mountMomentV2SocialCommentSheetToBody(v2Section);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        v2Section.classList.add('comment-input-open');
                    });
                });
            }
        }
        syncMomentV2SocialCommentEmptyOverlay(postId);
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
            if (commentSection) {
                if (commentSection.classList?.contains('moment-v2-social-comments-panel')) {
                    commentSection.classList.remove('comment-input-open');
                    commentSection.classList.remove('hidden');
                    mountMomentV2SocialCommentSheetToBody(commentSection);
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            commentSection.classList.add('comment-input-open');
                        });
                    });
                    // 시트를 올렸으면 댓글은 항상 전체 로드(더보기 버튼 없음)
                    try {
                        window.viewAllComments?.(postId);
                    } catch (_) {}
                } else {
                    commentSection.classList.add('comment-input-open');
                }
            }
            const textInput = document.getElementById(`comment-text-${postId}`);
            if (textInput) {
                textInput.focus();
                try {
                    syncMomentV2CommentTextareaHeight(textInput);
                } catch (_) {}
                try {
                    if (!textInput.dataset.mv2SendBtnBound) {
                        textInput.dataset.mv2SendBtnBound = '1';
                        /*
                         * 조합(한글 IME) 중 style.height 재기입 + scrollHeight 강제 리플로우가
                         * WebView의 조합 글자 렌더를 깨뜨려, 단어가 끝나야 텍스트가 보였다.
                         * 기록시트와 동일하게 조합 중에는 미루고 compositionend에 한 번 실행.
                         */
                        addCompositionAwareInput(textInput, () => {
                            syncMomentV2CommentTextareaHeight(textInput);
                            syncCommentSendButtonVisibility(postId, textInput);
                        });
                        textInput.addEventListener('blur', () => {
                            syncCommentSendButtonVisibility(postId, textInput);
                        });
                    }
                    syncCommentSendButtonVisibility(postId, textInput);
                } catch (_) {}
            }
            syncMomentV2SocialCommentEmptyOverlay(postId);
            // 입력창 왼쪽 아바타 반영 (사진 > 이모지 > 닉네임 첫 글자)
            try {
                const avatarEl = commentSection?.querySelector?.('.moment-v2-social-comments-input-avatar');
                if (avatarEl) {
                    const display = getDisplayProfile(
                        window.currentUser?.uid,
                        window.userSettings?.profile || {}
                    );
                    const av = getProfileAvatarDisplay(display);
                    avatarEl.innerHTML = '';
                    if (av.type === 'photo') {
                        const img = document.createElement('img');
                        img.alt = '';
                        img.decoding = 'async';
                        img.loading = 'lazy';
                        img.referrerPolicy = 'no-referrer';
                        img.src = av.value;
                        avatarEl.appendChild(img);
                    } else {
                        avatarEl.textContent = av.value;
                    }
                }
            } catch (_) {}
            if (commentSection?.classList?.contains('moment-v2-dockable-comment')) {
                requestAnimationFrame(() => {
                    commentSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
            }
        } else {
            inputEl.classList.add('hidden');
            if (commentSection) {
                commentSection.classList.remove('comment-input-open');
                if (commentSection.classList?.contains('moment-v2-social-comments-panel')) {
                    commentSection.classList.add('hidden');
                    restoreMomentV2SocialCommentSheetFromBody(commentSection);
                    collapseMomentV2SocialPanelIfListEmpty(postId);
                }
            }
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

    const mealO = document.getElementById('timelineMealPhotosOverlay');
    const overlayCommentOpen =
        mealO &&
        !mealO.classList.contains('hidden') &&
        mealO._mealPhotoPostCommentsOpen &&
        String(mealO._mealPhotoPostCommentsPostId) === String(postId);
    /* 팝업 댓글 열림 시 피드에 숨겨진 `comment-text-*`가 먼저 잡혀 빈 값으로 처리되던 것 방지 — 오버레이 input 우선 */
    let inputEl = null;
    if (overlayCommentOpen) {
        inputEl = mealO.querySelector('[data-meal-overlay-post-comments-input]');
    }
    if (!inputEl) {
        inputEl = document.getElementById(`comment-text-${postId}`);
    }
    if (!inputEl) return;
    
    const commentText = inputEl.value.trim();
    if (!commentText) {
        showToast("댓글을 입력해주세요.", 'error');
        return;
    }
    if (_commentSubmitting[postId]) return;
    _commentSubmitting[postId] = true;
    
    let commentsListEl = null;
    if (overlayCommentOpen) {
        commentsListEl = mealO.querySelector('[data-meal-overlay-post-comments-list]');
    }
    if (!commentsListEl) {
        commentsListEl = document.getElementById(`comments-list-${postId}`);
    }
    const commentCountEl = document.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
    const isMealPhotoOverlayCommentsList = Boolean(
        commentsListEl?.getAttribute?.('data-meal-overlay-post-comments-list') != null
    );
    const isMomentV2SocialCommentSheetList = Boolean(commentsListEl?.closest?.('.moment-v2-social-comments-sheet'));
    // 모먼트2 시트는 밝은 톤(검은 글자) — 다크 스타일은 사진 오버레이만 사용
    const useDarkCommentRowStyle = isMealPhotoOverlayCommentsList;
    const userProfile = window.userSettings?.profile || {};
    const userNickname = userProfile?.nickname || '익명';
    const tempId = `temp-${Date.now()}`;
    
    // 즉시 비우기 (disabled 대신 플래그로 더블 탭 방지 → 키보드 유지)
    inputEl.value = '';
    try {
        syncCommentSendButtonVisibility(postId, inputEl);
    } catch (_) {}
    try {
        syncMomentV2CommentTextareaHeight(inputEl);
    } catch (_) {}
    
    // 낙관적 업데이트: 댓글 한 줄 즉시 표시
    if (commentsListEl) {
        if (isMealPhotoOverlayCommentsList) {
            commentsListEl.querySelector?.('[data-meal-overlay-comments-empty]')?.remove();
        } else if (!isMomentV2SocialCommentSheetList) {
            commentsListEl.classList.add('bg-slate-50');
        }
        if (isMomentV2SocialCommentSheetList) {
            const optimisticAvatar = getDisplayProfile(
                window.currentUser?.uid,
                window.userSettings?.profile || {}
            );
            commentsListEl.insertAdjacentHTML(
                'beforeend',
                buildMomentV2SocialCommentRowHtml({
                    postId,
                    nickname: userNickname,
                    avatarProfile: optimisticAvatar,
                    body: commentText,
                    tempId,
                    showDelete: false
                })
            );
        } else {
            const nickCls = useDarkCommentRowStyle ? 'font-bold text-white/95' : 'font-bold text-slate-800';
            const bodyCls = useDarkCommentRowStyle ? 'text-white/90 ml-2' : 'text-slate-800 ml-2';
            commentsListEl.insertAdjacentHTML(
                'beforeend',
                `<div class="mb-1 ${useDarkCommentRowStyle ? '' : 'text-sm'}" data-temp-comment-id="${tempId}">
                <button type="button" class="${nickCls}" data-mv2-mention-nick="${mv2EscapeAttr(userNickname)}">${escapeHtml(userNickname)}</button>
                <span class="${bodyCls}">${escapeHtml(commentText)}</span>
            </div>`
            );
        }
        const commentSection = document.getElementById(`comment-section-${postId}`);
        if (commentSection) {
            commentSection.classList.remove('comments-empty');
            if (commentSection.classList?.contains('moment-v2-social-comments-panel')) {
                commentSection.classList.remove('comment-input-open');
                commentSection.classList.remove('hidden');
                mountMomentV2SocialCommentSheetToBody(commentSection);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        commentSection.classList.add('comment-input-open');
                    });
                });
            }
        }
        if (isMomentV2SocialCommentSheetList) {
            syncMomentV2SocialCommentEmptyOverlay(String(postId));
        }
    }
    if (commentCountEl) {
        const n = (parseInt(commentCountEl.textContent || '0', 10) || 0) + 1;
        commentCountEl.textContent = n;
        window.sharedPhotosFeed = patchMomentFeedSocialCounts(window.sharedPhotosFeed, postId, { commentCount: n });
        syncMomentPostSeedCounts(postId, { commentCount: n });
        document.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((el) => {
            if (el !== commentCountEl) el.textContent = String(n);
        });
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
                const commentDisplay = getDisplayProfile(
                    window.currentUser?.uid,
                    { nickname: result.userNickname, icon: result.userIcon },
                    { preferStoredNickname: true }
                );
                if (isMomentV2SocialCommentSheetList) {
                    tempRow.outerHTML = buildMomentV2SocialCommentRowHtml({
                        commentId: result.id,
                        postId,
                        nickname: commentDisplay.nickname,
                        avatarProfile: getDisplayProfile(
                            window.currentUser?.uid,
                            {
                                nickname: result.userNickname,
                                icon: result.userIcon,
                                photoUrl: result.userPhotoUrl
                            }
                        ),
                        body: result.comment || '',
                        dateStr,
                        timeStr,
                        showDelete: true
                    });
                } else {
                    const nickCls2 = useDarkCommentRowStyle ? 'font-bold text-white/95' : 'font-bold text-slate-800';
                    const bodyCls2 = useDarkCommentRowStyle ? 'text-white/90 ml-2' : 'text-slate-800 ml-2';
                    const dateCls = useDarkCommentRowStyle ? 'text-xs text-white/65 ml-2' : 'text-xs text-slate-500 ml-2';
                    const delCls = useDarkCommentRowStyle
                        ? 'ml-2 text-white/50 text-xs hover:text-red-300'
                        : 'ml-2 text-slate-400 text-xs hover:text-red-500';
                    tempRow.outerHTML = `
                    <div class="mb-1 ${useDarkCommentRowStyle ? '' : 'text-sm'}">
                        <button type="button" class="${nickCls2}" data-mv2-mention-nick="${mv2EscapeAttr(commentDisplay.nickname)}">${escapeHtml(commentDisplay.nickname)}</button>
                        <span class="${bodyCls2}">${escapeHtml(result.comment || '')}</span>
                        ${dateStr && timeStr ? `<span class="${dateCls}">${dateStr} ${timeStr}</span>` : ''}
                        <button onclick="window.deleteCommentFromPost('${safeId}', '${postId}')" class="${delCls}">삭제</button>
                    </div>`;
                }
            }
        }
        document.querySelectorAll('.post-comment-btn[data-post-id]').forEach((btn) => {
            if (btn.getAttribute('data-post-id') !== String(postId)) return;
            if (btn.querySelector('.post-comment-fill')) {
                btn.setAttribute('data-post-user-commented', '1');
            }
        });
        applyStackCommentBtnVisual(postId);
        if (isMomentV2SocialCommentSheetList) {
            syncMomentV2SocialCommentEmptyOverlay(String(postId));
        }
    } catch (e) {
        console.error("[submitComment] 에러:", e);
        const errorMessage = e.message || e.details || e.code || "댓글 작성에 실패했습니다.";
        showToast(errorMessage, 'error');
        /* 전송 전에 비운 입력창을 되돌린다 — 실패하면 쓴 글이 사라지던 자리다 (2026-08-30 밀톡 사고와 같은 구조).
           그 사이에 다음 댓글을 이미 쓰고 있었다면 덮어쓰지 않는다. */
        if (inputEl && !inputEl.value.trim()) {
            inputEl.value = commentText;
            try {
                syncCommentSendButtonVisibility(postId, inputEl);
            } catch (_) {}
            try {
                syncMomentV2CommentTextareaHeight(inputEl);
            } catch (_) {}
        }
        // 낙관적 업데이트 롤백
        if (commentsListEl) {
            const tempRow = commentsListEl.querySelector(`[data-temp-comment-id="${tempId}"]`);
            if (tempRow) tempRow.remove();
            const left = commentsListEl.querySelectorAll('.moment-v2-social-comment, .mb-1.text-sm').length;
            if (left === 0 && !isMealPhotoOverlayCommentsList && !isMomentV2SocialCommentSheetList) {
                commentsListEl.classList.remove('bg-slate-50');
            }
            if (isMomentV2SocialCommentSheetList) {
                syncMomentV2SocialCommentEmptyOverlay(String(postId));
            }
        }
        if (commentCountEl) {
            const n = Math.max(0, (parseInt(commentCountEl.textContent || '0', 10) || 0) - 1);
            commentCountEl.textContent = n || '';
            window.sharedPhotosFeed = patchMomentFeedSocialCounts(window.sharedPhotosFeed, postId, { commentCount: n });
            syncMomentPostSeedCounts(postId, { commentCount: n });
            document.querySelectorAll(`.post-comment-count[data-post-id="${postId}"]`).forEach((el) => {
                if (el !== commentCountEl) el.textContent = n || '';
            });
            /** 미선언 상태로 참조돼 롤백 경로가 ReferenceError로 중단되고 있었다 */
            const viewCommentsBtn = document.getElementById(`view-comments-${postId}`);
            if (viewCommentsBtn && n <= 2) viewCommentsBtn.classList.add('hidden');
            else if (viewCommentsBtn && n > 2) viewCommentsBtn.textContent = `댓글 ${n}개 모두 보기`;
        }
    } finally {
        _commentSubmitting[postId] = false;
    }
};

function syncCommentSendButtonVisibility(postId, inputEl) {
    const pid = String(postId || '');
    if (!pid) return;
    const input = inputEl || document.getElementById(`comment-text-${pid}`);
    if (!input) return;
    const wrap = input.closest?.('.moment-v2-social-comments-input-shell') || input.parentElement;
    const btn =
        (wrap && wrap.querySelector ? wrap.querySelector('[data-comment-send-btn="1"]') : null) ||
        document.querySelector(`.moment-v2-social-comments-send[data-post-id="${CSS.escape(pid)}"]`);
    if (!btn) return;
    const hasText = Boolean((input.value || '').trim());
    btn.disabled = !hasText;
}

/** 사진 팝업 하단 댓글 박스 — 코멘트 밴드와 유사한 어두운 톤 */
async function loadPostCommentsForMealPhotoOverlayList(postId, listEl) {
    if (!listEl || !postId || !postInteractions?.getComments) return;
    try {
        const alternates = getAlternatePostIdsForPost(postId);
        const comments = await postInteractions.getComments(postId, alternates);
        if (comments.length === 0) {
            listEl.innerHTML =
                '<p class="py-1 text-white/50" data-meal-overlay-comments-empty>댓글이 없습니다.</p>';
            return;
        }
        const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
        listEl.innerHTML = comments
            .map((comment) => {
                let dateStr = '';
                let timeStr = '';
                if (comment.timestamp) {
                    try {
                        const commentDate =
                            comment.timestamp instanceof Date
                                ? comment.timestamp
                                : comment.timestamp.toDate
                                  ? comment.timestamp.toDate()
                                  : new Date(comment.timestamp);
                        if (!isNaN(commentDate.getTime())) {
                            dateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                            timeStr = commentDate.toLocaleTimeString('ko-KR', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false
                            });
                        }
                    } catch (_) {
                        /* ignore */
                    }
                }
                const commentDisplay = getDisplayProfile(
                    comment.userId,
                    { nickname: comment.userNickname, icon: comment.userIcon },
                    { preferStoredNickname: true }
                );
                const isMyComment = isLoggedIn && comment.userId === window.currentUser.uid;
                const del =
                    isMyComment && comment.id
                        ? `<button type="button" onclick="window.deleteCommentFromPost('${String(comment.id).replace(/'/g, "\\'")}', '${String(postId).replace(/'/g, "\\'")}')" class="ml-2 text-white/50 text-xs hover:text-red-300">삭제</button>`
                        : '';
                return `
                    <div class="mb-1.5">
                        <span class="font-bold text-white/95">${escapeHtml(commentDisplay.nickname)}</span>
                        <span class="ml-2 text-white/90">${escapeHtml(comment.comment || '')}</span>
                        ${
                            dateStr && timeStr
                                ? `<span class="ml-2 text-xs text-white/45">${dateStr} ${timeStr}</span>`
                                : ''
                        }
                        ${del}
                    </div>`;
            })
            .join('');
    } catch (e) {
        console.error('loadPostCommentsForMealPhotoOverlayList', e);
        listEl.innerHTML = '<p class="py-1 text-sm text-red-300/90">댓글을 불러오지 못했습니다.</p>';
    }
}
window.loadPostCommentsForMealPhotoOverlayList = loadPostCommentsForMealPhotoOverlayList;

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
                const isMomentV2Sheet = Boolean(commentsListEl.closest?.('.moment-v2-social-comments-sheet'));
                if (!isMomentV2Sheet) commentsListEl.classList.add('bg-slate-50');
                const displayComments = isMomentV2Sheet ? comments : comments.slice(0, 2);
                if (isMomentV2Sheet) {
                    try {
                        await fetchUserProfiles(
                            [...new Set(comments.map((c) => c.userId).filter(Boolean))]
                        );
                    } catch (_) {}
                }
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
                    const { nickname, avatarProfile } = resolveMomentV2CommentDisplay(comment);
                    if (isMomentV2Sheet) mv2NotifyIfMentionedOnce(postId, comment);
                    if (isMomentV2Sheet) {
                        return buildMomentV2SocialCommentRowHtml({
                            commentId: comment.id,
                            postId,
                            nickname,
                            avatarProfile,
                            body: comment.comment || '',
                            dateStr,
                            timeStr,
                            showDelete: isMyComment
                        });
                    }
                    return `
                        <div class="mb-1 text-sm">
                            <button type="button" class="font-bold text-slate-800" data-mv2-mention-nick="${mv2EscapeAttr(nickname)}">${escapeHtml(nickname)}</button>
                            <span class="text-slate-800 ml-2">${escapeHtml(comment.comment || '')}</span>
                            ${dateStr && timeStr ? `<span class="text-xs text-slate-500 ml-2">${dateStr} ${timeStr}</span>` : ''}
                            ${isMyComment ? `<button onclick="window.deleteCommentFromPost('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                        </div>
                    `;
                }).join('');
                if (isMomentV2Sheet) syncMomentV2SocialCommentEmptyOverlay(postId);
            }
        }
    } catch (e) {
        console.error("댓글 로드 실패:", e);
    }
}
window.loadPostComments = loadPostComments;
window.Mealog.loadPostComments = loadPostComments;

// 포스트 캡션 토글 (접힘 ↔ 전체; 펼친 뒤에는 본문 탭으로 접기 — 별도 「접기」 문구 없음)
window.togglePostCaption = (idx) => {
    const id = idx != null && idx !== '' ? String(idx) : '';
    if (!id) return;
    const collapsedEl = document.getElementById(`post-caption-collapsed-${id}`);
    const expandedEl = document.getElementById(`post-caption-expanded-${id}`);
    if (!collapsedEl || !expandedEl) return;

    const isCollapsed = !collapsedEl.classList.contains('hidden');
    if (isCollapsed) {
        collapsedEl.classList.add('hidden');
        expandedEl.classList.remove('hidden');
    } else {
        expandedEl.classList.add('hidden');
        collapsedEl.classList.remove('hidden');
    }
};
}
