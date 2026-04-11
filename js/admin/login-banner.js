// ADMIN 로그인 배너 설정
import { db, appId } from '../firebase.js';
import { collection, query, orderBy, getDocs, doc, getDoc, setDoc, deleteField } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { uploadLoginBannerImage } from '../utils.js';

// 로그인 배너 설정 로드
export async function loadLoginBannerConfig() {
    const enabledEl = document.getElementById('loginBannerEnabled');
    const targetEnvEl = document.getElementById('loginBannerTargetEnv');
    const labelEl = document.getElementById('loginBannerImageLabel');
    const previewEl = document.getElementById('loginBannerImagePreview');
    const inputEl = document.getElementById('loginBannerImageInput');
    const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
    const landingLabelEl = document.getElementById('loginBannerLandingLabel');
    const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
    if (!enabledEl) return;
    window.loginBannerFile = null;
    window.loginBannerRemoveImage = false;
    if (inputEl) inputEl.value = '';
    try {
        const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        const data = bannerDoc.exists() ? bannerDoc.data() : null;
        enabledEl.checked = !!(data && data.enabled);
        const targetEnv = (data && (data.targetEnv === 'production' || data.targetEnv === 'staging')) ? data.targetEnv : 'all';
        if (targetEnvEl) targetEnvEl.value = targetEnv;
        const imageUrl = (data && data.imageUrl && typeof data.imageUrl === 'string') ? data.imageUrl.trim() : '';
        if (labelEl) labelEl.textContent = imageUrl ? '등록된 이미지 있음' : '선택된 이미지 없음';
        if (previewEl) {
            previewEl.innerHTML = '';
            if (imageUrl) {
                const img = document.createElement('img');
                img.src = imageUrl;
                img.alt = '배너 미리보기';
                img.className = 'max-w-full h-auto rounded-xl border border-slate-200 object-contain max-h-24';
                previewEl.appendChild(img);
            }
        }
        const lid = (data && data.landingNoticeId && typeof data.landingNoticeId === 'string') ? data.landingNoticeId.trim() : '';
        const ltitle = (data && data.landingNoticeTitle && typeof data.landingNoticeTitle === 'string') ? data.landingNoticeTitle.trim() : '';
        if (landingIdEl) landingIdEl.value = lid;
        if (landingLabelEl) landingLabelEl.textContent = lid ? '공지 변경하기' : '공지 선택하기';
        if (landingSelectedWrap) landingSelectedWrap.classList.toggle('hidden', !lid);
        if (landingSelectedTitle) landingSelectedTitle.textContent = ltitle || '(공지)';
        window.loginBannerLandingNoticeTitle = ltitle || '';
        const viewCountEl = document.getElementById('loginBannerViewCount');
        const clickCountEl = document.getElementById('loginBannerClickCount');
        if (viewCountEl) viewCountEl.textContent = String(Number(data && data.viewCount) || 0);
        if (clickCountEl) clickCountEl.textContent = String(Number(data && data.clickCount) || 0);
    } catch (e) {
        console.error('로그인 배너 설정 로드 실패:', e);
        if (labelEl) labelEl.textContent = '로드 실패';
    }
}

/** 로그인 배너 조회수·클릭수 재조회 */
window.refreshLoginBannerStats = async function () {
    await runAdminRefreshAction(
        document.getElementById('loginBannerRefreshStatsBtn'),
        async () => {
            await loadLoginBannerConfig();
        },
        { loadingText: '재조회 중', tightSpinner: true }
    );
};

// 로그인 배너 저장
window.saveLoginBanner = async function() {
    const enabledEl = document.getElementById('loginBannerEnabled');
    const saveBtn = document.getElementById('loginBannerSaveBtn');
    if (!enabledEl || !saveBtn) return;
    const enabled = enabledEl.checked;
    let imageUrl = null;
    if (enabled && window.loginBannerRemoveImage) {
        imageUrl = null;
    } else if (enabled && window.loginBannerFile) {
        saveBtn.disabled = true;
        saveBtn.textContent = '업로드 중...';
        try {
            imageUrl = await uploadLoginBannerImage(window.loginBannerFile, appId);
        } catch (e) {
            console.error('배너 이미지 업로드 실패:', e);
            alert('이미지 업로드에 실패했습니다.');
            saveBtn.disabled = false;
            saveBtn.textContent = '저장';
            return;
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '저장';
    } else if (enabled) {
        const bannerDoc = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        const data = bannerDoc.exists() ? bannerDoc.data() : null;
        imageUrl = (data && data.imageUrl && typeof data.imageUrl === 'string') ? data.imageUrl.trim() : null;
        if (imageUrl === '') imageUrl = null;
    }
    const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
    const landingNoticeId = (landingIdEl && landingIdEl.value) ? landingIdEl.value.trim() : '';
    const landingNoticeTitle = window.loginBannerLandingNoticeTitle || '';
    const targetEnvEl = document.getElementById('loginBannerTargetEnv');
    const targetEnv = (targetEnvEl && (targetEnvEl.value === 'production' || targetEnvEl.value === 'staging')) ? targetEnvEl.value : 'all';
    try {
        const payload = {
            enabled,
            targetEnv: targetEnv || 'all',
            imageUrl: imageUrl || null,
            updatedAt: new Date().toISOString()
        };
        if (landingNoticeId) {
            payload.landingNoticeId = landingNoticeId;
            payload.landingNoticeTitle = landingNoticeTitle;
        } else {
            payload.landingNoticeId = deleteField();
            payload.landingNoticeTitle = deleteField();
        }
        await setDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'), payload, { merge: true });
        alert('저장되었습니다.');
        loadLoginBannerConfig();
    } catch (e) {
        console.error('로그인 배너 저장 실패:', e);
        alert('저장에 실패했습니다: ' + (e.message || e));
    }
};

window.openLoginBannerLandingNoticeSelect = async function() {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    const listEl = document.getElementById('loginBannerLandingNoticeList');
    if (!modal || !listEl) return;
    listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-sm">로딩 중...</p></div>';
    modal.classList.remove('hidden');
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const snap = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        if (snap.empty) {
            listEl.innerHTML = '<div class="text-center py-8 text-slate-400"><p class="text-sm">등록된 공지가 없습니다.</p></div>';
            return;
        }
        listEl.innerHTML = snap.docs.map(d => {
            const n = d.data();
            const id = d.id;
            const title = (n.title || '제목 없음').trim();
            return `<button type="button" data-notice-id="${escapeHtml(id)}" data-notice-title="${escapeHtml(title)}" class="login-banner-landing-notice-btn w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-emerald-300 transition-colors">
                <span class="font-bold text-slate-800">${escapeHtml(title)}</span>
            </button>`;
        }).join('');
        listEl.querySelectorAll('.login-banner-landing-notice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noticeId = btn.getAttribute('data-notice-id');
                const noticeTitle = btn.getAttribute('data-notice-title') || '(공지)';
                window.loginBannerLandingNoticeTitle = noticeTitle;
                const landingIdEl = document.getElementById('loginBannerLandingNoticeId');
                const landingLabelEl = document.getElementById('loginBannerLandingLabel');
                const landingSelectedWrap = document.getElementById('loginBannerLandingSelectedWrap');
                const landingSelectedTitle = document.getElementById('loginBannerLandingSelectedTitle');
                if (landingIdEl) landingIdEl.value = noticeId;
                if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                if (landingSelectedTitle) landingSelectedTitle.textContent = noticeTitle;
                window.closeLoginBannerLandingNoticeSelect();
            });
        });
    } catch (e) {
        console.error('공지 목록 로드 실패:', e);
        listEl.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">공지 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
};

window.closeLoginBannerLandingNoticeSelect = function() {
    const modal = document.getElementById('loginBannerLandingNoticeModal');
    if (modal) modal.classList.add('hidden');
};
