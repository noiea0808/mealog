// ADMIN 팝업 관리
import { app, db, appId, auth } from '../firebase.js';
import {
    collection, query, orderBy, getDocs, doc, getDoc, setDoc, addDoc, deleteDoc, deleteField
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly } from '../render/utils.js';
import { uploadPopupImages } from '../utils.js';
import { getAdminDisplayName } from '../db.js';

const POPUP_TARGET_MENU_LABELS = { dashboard: '밀당', timeline: '밀로그', gallery: '모먼트', board: '라운지', settings: '사용자' };
const POPUP_FREQUENCY_LABELS = { daily: '하루 한 번', on_login: '로그인 시마다', on_visit: '접근시마다' };
const POPUP_TARGET_ENV_LABELS = { all: '전체', production: '프로덕션만', staging: '스테이징만' };
let currentEditingPopupId = null;
let currentSelectedPopupId = null;

export async function renderPopups() {
    const container = document.getElementById('popupsContainer');
    if (!container) return;
    try {
        const popupsColl = collection(db, 'artifacts', appId, 'popups');
        const popupsSnapshot = await getDocs(query(popupsColl, orderBy('timestamp', 'desc')));
        if (popupsSnapshot.empty) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400 px-4"><i class="fa-solid fa-window-maximize text-2xl mb-2"></i><p>등록된 팝업이 없습니다.</p></div>';
            return;
        }
        container.innerHTML = popupsSnapshot.docs.map(d => {
            const p = d.data();
            const id = d.id;
            const menuLabel = POPUP_TARGET_MENU_LABELS[p.targetMenu] || p.targetMenu;
            const freqLabel = POPUP_FREQUENCY_LABELS[p.frequency] || p.frequency;
            const envLabel = POPUP_TARGET_ENV_LABELS[p.targetEnv] || POPUP_TARGET_ENV_LABELS.all;
            const start = p.startDate || '';
            const end = p.endDate || '';
            const viewCount = Number(p.viewCount) || 0;
            const clickCount = Number(p.clickCount) || 0;
            const isSelected = currentSelectedPopupId === id;
            return `
                <div data-popup-id="${id}" onclick="window.selectAdminPopup('${id}')" class="admin-popup-row flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 transition-colors ${isSelected ? 'bg-emerald-50 border-l-4 border-l-emerald-500' : ''}">
                    <h3 class="font-bold text-slate-800 truncate min-w-0 flex-shrink">${escapeHtml(p.title || '제목 없음')}</h3>
                    <p class="text-xs text-slate-500 text-right whitespace-nowrap shrink-0">조회 <span class="font-bold text-slate-600">${viewCount}</span> · 클릭 <span class="font-bold text-slate-600">${clickCount}</span> · ${envLabel} · ${menuLabel} · ${freqLabel} · ${start} ~ ${end}</p>
                </div>
            `;
        }).join('');
    } catch (e) {
        console.error("팝업 목록 로드 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400 px-4"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>팝업 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

/** 팝업 목록·상세의 조회수·클릭수 재조회 */
window.refreshPopupsStats = async function () {
    await runAdminRefreshAction(
        document.getElementById('popupRefreshStatsBtn'),
        async () => {
            await renderPopups();
            if (currentSelectedPopupId) await renderPopupDetailInAdmin(currentSelectedPopupId);
        },
        { loadingText: '재조회 중', tightSpinner: true }
    );
};

window.selectAdminPopup = async function(popupId) {
    currentSelectedPopupId = popupId;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (!listPage || !detailPage) return;
    listPage.classList.add('hidden');
    writePage.classList.add('hidden');
    detailPage.classList.remove('hidden');
    await renderPopupDetailInAdmin(popupId);
    document.querySelectorAll('.admin-popup-row').forEach(row => {
        const id = row.getAttribute('data-popup-id');
        row.classList.toggle('bg-emerald-50', id === popupId);
        row.classList.toggle('border-l-4', id === popupId);
        row.classList.toggle('border-l-emerald-500', id === popupId);
    });
};

window.backToPopupList = function() {
    currentSelectedPopupId = null;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
    renderPopups();
};

async function renderPopupDetailInAdmin(popupId) {
    const container = document.getElementById('popupDetailContainer');
    if (!container) return;
    container.innerHTML = '<p class="text-slate-500">로딩 중...</p>';
    try {
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        const snap = await getDoc(popupDoc);
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">팝업을 찾을 수 없습니다.</p>';
            return;
        }
        const p = snap.data();
        const menuLabel = POPUP_TARGET_MENU_LABELS[p.targetMenu] || p.targetMenu;
        const freqLabel = POPUP_FREQUENCY_LABELS[p.frequency] || p.frequency;
        const envLabel = POPUP_TARGET_ENV_LABELS[p.targetEnv] || POPUP_TARGET_ENV_LABELS.all;
        const viewCount = Number(p.viewCount) || 0;
        const clickCount = Number(p.clickCount) || 0;
        const imagesHtml = Array.isArray(p.imageUrls) && p.imageUrls.length > 0
            ? `<div class="flex flex-col gap-2 mb-4">${p.imageUrls.map(url => `<img src="${url}" alt="팝업 사진" class="max-w-full h-auto rounded-xl border border-slate-200 object-contain" style="max-height: 50vh;">`).join('')}</div>`
            : '';
        const landingHtml = p.landingNoticeId
            ? `<p class="text-sm text-slate-600"><span class="font-bold">버튼 문구:</span> ${escapeHtml(p.landingButtonLabel || '선택한 공지 보기')}</p><p class="text-sm text-slate-600 mt-0.5"><span class="font-bold">연결 공지:</span> ${escapeHtml(p.landingNoticeTitle || '(공지)')}</p>`
            : '<p class="text-sm text-slate-500">미설정</p>';
        container.innerHTML = `
            <div class="mb-4">
                <h2 class="text-lg font-bold text-slate-800 mb-3">${escapeHtml(p.title || '제목 없음')}</h2>
                <div class="bg-slate-100 rounded-xl p-3 mb-4 text-sm">
                    <p class="font-bold text-slate-700 mb-1.5">통계</p>
                    <p class="text-slate-600">조회 <span class="font-bold text-slate-700">${viewCount}</span> · 클릭 <span class="font-bold text-slate-700">${clickCount}</span></p>
                    <p class="font-bold text-slate-700 mb-1.5 mt-3">설정</p>
                    <p class="text-slate-600"><span class="font-bold">표시 환경:</span> ${envLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">팝업 메뉴:</span> ${menuLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">팝업 주기:</span> ${freqLabel}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">표시 기간:</span> ${p.startDate || ''} ~ ${p.endDate || ''}</p>
                    <p class="text-slate-600 mt-0.5"><span class="font-bold">랜딩 페이지:</span></p>
                    <div class="ml-2 mt-0.5">${landingHtml}</div>
                </div>
            </div>
            ${imagesHtml}
            <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4">${renderFormattedContent(p.content || '')}</div>
            <div class="flex gap-2 pt-2 border-t border-slate-200">
                <button type="button" onclick="window.editPopup('${popupId}')" class="px-4 py-2 bg-blue-50 text-blue-600 rounded-lg text-sm font-bold hover:bg-blue-100">수정</button>
                <button type="button" onclick="window.deletePopup('${popupId}')" class="px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm font-bold hover:bg-red-100">삭제</button>
            </div>
        `;
    } catch (e) {
        console.error("팝업 본문 로드 실패:", e);
        container.innerHTML = '<p class="text-red-400">팝업을 불러오는 중 오류가 발생했습니다.</p>';
    }
}

export function renderPopupImagePreviews() {
    const container = document.getElementById('popupImagePreviews');
    if (!container) return;
    const existing = window.popupExistingUrls || [];
    const files = window.popupFiles || [];
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
            window.popupExistingUrls.splice(i, 1);
            renderPopupImagePreviews();
        });
        container.appendChild(wrap);
    });
    files.forEach((file, i) => {
        const objectUrl = window.popupObjectUrls && window.popupObjectUrls[i];
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
            if (window.popupObjectUrls && window.popupObjectUrls[i]) {
                try { URL.revokeObjectURL(window.popupObjectUrls[i]); } catch (_) {}
                window.popupObjectUrls.splice(i, 1);
            }
            window.popupFiles.splice(i, 1);
            renderPopupImagePreviews();
        });
        container.appendChild(wrap);
    });
}

window.openPopupWriteModal = function(popupId = null) {
    currentEditingPopupId = popupId;
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    const titleEl = document.getElementById('popupWritePageTitle');
    const submitBtn = document.getElementById('popupSubmitBtn');
    const titleInput = document.getElementById('popupTitle');
    const contentInput = document.getElementById('popupContent');
    const targetMenuSelect = document.getElementById('popupTargetMenu');
    const startDateInput = document.getElementById('popupStartDate');
    const endDateInput = document.getElementById('popupEndDate');
    const frequencySelect = document.getElementById('popupFrequency');
    if (!writePage) return;
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    writePage.classList.remove('hidden');
    if (titleInput) titleInput.value = '';
    if (contentInput) {
        contentInput.innerHTML = '';
        contentInput.classList.add('format-editor-empty');
    }
    window.popupExistingUrls = [];
    window.popupFiles = [];
    if (window.popupObjectUrls?.length) {
        window.popupObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    window.popupObjectUrls = [];
    const popupImagesInput = document.getElementById('popupImages');
    if (popupImagesInput) popupImagesInput.value = '';
    renderPopupImagePreviews();
    const today = new Date().toISOString().slice(0, 10);
    if (startDateInput) startDateInput.value = today;
    if (endDateInput) endDateInput.value = today;
    if (targetMenuSelect) targetMenuSelect.value = 'timeline';
    if (frequencySelect) frequencySelect.value = 'daily';
    window.popupLandingNoticeId = '';
    window.popupLandingNoticeTitle = '';
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    const landingButtonLabelInput = document.getElementById('popupLandingButtonLabel');
    if (landingIdEl) landingIdEl.value = '';
    if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = '';
    if (landingButtonLabelInput) landingButtonLabelInput.value = '';
    if (popupId) {
        if (titleEl) titleEl.textContent = '팝업 수정';
        if (submitBtn) submitBtn.textContent = '수정';
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        getDoc(popupDoc).then(snap => {
            if (snap.exists()) {
                const d = snap.data();
                if (titleInput) titleInput.value = d.title || '';
                if (contentInput) {
                    contentInput.innerHTML = (d.content || '').replace(/\n/g, '<br>');
                    contentInput.classList.remove('format-editor-empty');
                }
                window.popupExistingUrls = Array.isArray(d.imageUrls) ? [...d.imageUrls] : [];
                window.popupFiles = [];
                if (window.popupObjectUrls?.length) {
                    window.popupObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
                }
                window.popupObjectUrls = [];
                if (popupImagesInput) popupImagesInput.value = '';
                renderPopupImagePreviews();
                if (targetMenuSelect) targetMenuSelect.value = d.targetMenu || 'timeline';
                if (startDateInput) startDateInput.value = d.startDate || today;
                if (endDateInput) endDateInput.value = d.endDate || today;
                if (frequencySelect) frequencySelect.value = d.frequency || 'daily';
                const targetEnvSelect = document.getElementById('popupTargetEnv');
                if (targetEnvSelect) targetEnvSelect.value = d.targetEnv || 'all';
                if (d.landingNoticeId) {
                    window.popupLandingNoticeId = d.landingNoticeId;
                    window.popupLandingNoticeTitle = d.landingNoticeTitle || '';
                    if (landingIdEl) landingIdEl.value = d.landingNoticeId;
                    if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
                    if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
                    if (landingSelectedTitle) landingSelectedTitle.textContent = d.landingNoticeTitle || '(공지)';
                }
                if (landingButtonLabelInput) landingButtonLabelInput.value = d.landingButtonLabel || '';
            }
        }).catch(e => {
            console.error("팝업 로드 실패:", e);
            alert("팝업을 불러오는 중 오류가 발생했습니다.");
        });
    } else {
        if (titleEl) titleEl.textContent = '팝업 작성';
        if (submitBtn) submitBtn.textContent = '등록';
    }
}

window.openPopupLandingNoticeSelect = async function() {
    const modal = document.getElementById('popupLandingNoticeModal');
    const listEl = document.getElementById('popupLandingNoticeList');
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
            return `<button type="button" data-notice-id="${escapeHtml(id)}" data-notice-title="${escapeHtml(title)}" class="popup-landing-notice-btn w-full text-left px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 hover:border-emerald-300 transition-colors">
                <span class="font-bold text-slate-800">${escapeHtml(title)}</span>
            </button>`;
        }).join('');
        listEl.querySelectorAll('.popup-landing-notice-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const noticeId = btn.getAttribute('data-notice-id');
                const noticeTitle = btn.getAttribute('data-notice-title') || '(공지)';
                window.selectPopupLandingNotice(noticeId, noticeTitle);
            });
        });
    } catch (e) {
        console.error("공지 목록 로드 실패:", e);
        listEl.innerHTML = '<div class="text-center py-8 text-red-400"><p class="text-sm">공지 목록을 불러오는 중 오류가 발생했습니다.</p></div>';
    }
};

window.selectPopupLandingNotice = function(noticeId, noticeTitle) {
    noticeTitle = (typeof noticeTitle === 'string') ? noticeTitle : (noticeTitle || '(공지)');
    window.popupLandingNoticeId = noticeId;
    window.popupLandingNoticeTitle = noticeTitle;
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    if (landingIdEl) landingIdEl.value = noticeId;
    if (landingLabelEl) landingLabelEl.textContent = '공지 변경하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.remove('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = noticeTitle;
    window.closePopupLandingNoticeSelect();
};

window.closePopupLandingNoticeSelect = function() {
    const modal = document.getElementById('popupLandingNoticeModal');
    if (modal) modal.classList.add('hidden');
};

window.clearPopupLanding = function() {
    window.popupLandingNoticeId = '';
    window.popupLandingNoticeTitle = '';
    const landingIdEl = document.getElementById('popupLandingNoticeId');
    const landingLabelEl = document.getElementById('popupLandingLabel');
    const landingSelectedWrap = document.getElementById('popupLandingSelectedWrap');
    const landingSelectedTitle = document.getElementById('popupLandingSelectedTitle');
    if (landingIdEl) landingIdEl.value = '';
    if (landingLabelEl) landingLabelEl.textContent = '공지 선택하기';
    if (landingSelectedWrap) landingSelectedWrap.classList.add('hidden');
    if (landingSelectedTitle) landingSelectedTitle.textContent = '';
};

window.backToPopupListFromWrite = function() {
    const listPage = document.getElementById('popupListPage');
    const detailPage = document.getElementById('popupDetailPage');
    const writePage = document.getElementById('popupWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
    currentEditingPopupId = null;
    renderPopups();
}

window.submitPopup = async function() {
    const titleInput = document.getElementById('popupTitle');
    const contentInput = document.getElementById('popupContent');
    const targetMenuSelect = document.getElementById('popupTargetMenu');
    const startDateInput = document.getElementById('popupStartDate');
    const endDateInput = document.getElementById('popupEndDate');
    const frequencySelect = document.getElementById('popupFrequency');
    const submitBtn = document.getElementById('popupSubmitBtn');
    if (!titleInput || !contentInput) return;
    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    if (!content && rawContent.trim()) content = stripDangerousTagsOnly(rawContent).trim();
    if (!content) content = (contentInput.innerText || '').trim().replace(/\n/g, '<br>');
    const targetMenu = targetMenuSelect ? targetMenuSelect.value : 'timeline';
    const startDate = startDateInput ? startDateInput.value : '';
    const endDate = endDateInput ? endDateInput.value : '';
    const frequency = frequencySelect ? frequencySelect.value : 'daily';
    const targetEnvSelect = document.getElementById('popupTargetEnv');
    const targetEnv = targetEnvSelect ? targetEnvSelect.value : 'all';
    if (!title) { alert('제목을 입력해주세요.'); return; }
    if (!content) { alert('내용을 입력해주세요.'); return; }
    if (!startDate || !endDate) { alert('팝업 기간(시작일·종료일)을 입력해주세요.'); return; }
    if (new Date(startDate) > new Date(endDate)) { alert('시작일이 종료일보다 늦을 수 없습니다.'); return; }
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>처리 중...';
    }
    try {
        const existingUrls = window.popupExistingUrls || [];
        const newFiles = window.popupFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = auth.currentUser?.uid;
            if (!uid) {
                alert('로그인이 필요합니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentEditingPopupId ? '수정' : '등록'; }
                return;
            }
            const newUrls = await uploadPopupImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }
        const landingIdEl = document.getElementById('popupLandingNoticeId');
        const landingButtonLabelInput = document.getElementById('popupLandingButtonLabel');
        const landingNoticeId = (landingIdEl && landingIdEl.value) ? landingIdEl.value.trim() : '';
        const popupData = {
            title,
            content,
            imageUrls,
            targetMenu,
            startDate,
            endDate,
            frequency,
            targetEnv: targetEnv || 'all',
            timestamp: new Date().toISOString(),
            authorDisplayName: await getAdminDisplayName()
        };
        if (landingNoticeId) {
            popupData.landingNoticeId = landingNoticeId;
            popupData.landingNoticeTitle = window.popupLandingNoticeTitle || '';
            popupData.landingButtonLabel = (landingButtonLabelInput && landingButtonLabelInput.value) ? landingButtonLabelInput.value.trim() : '';
        } else if (currentEditingPopupId) {
            popupData.landingNoticeId = deleteField();
            popupData.landingNoticeTitle = deleteField();
            popupData.landingButtonLabel = deleteField();
        }
        if (currentEditingPopupId) {
            const popupDoc = doc(db, 'artifacts', appId, 'popups', currentEditingPopupId);
            await setDoc(popupDoc, popupData, { merge: true });
            alert('팝업이 수정되었습니다.');
        } else {
            const popupsColl = collection(db, 'artifacts', appId, 'popups');
            await addDoc(popupsColl, popupData);
            alert('팝업이 등록되었습니다.');
        }
        window.backToPopupListFromWrite();
    } catch (e) {
        console.error("팝업 저장 실패:", e);
        alert("팝업 저장 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = currentEditingPopupId ? '수정' : '등록';
        }
    }
}

window.editPopup = function(popupId) {
    window.openPopupWriteModal(popupId);
}

window.deletePopup = async function(popupId) {
    if (!confirm('이 팝업을 삭제하시겠습니까?')) return;
    try {
        const popupDoc = doc(db, 'artifacts', appId, 'popups', popupId);
        await deleteDoc(popupDoc);
        alert('팝업이 삭제되었습니다.');
        window.backToPopupList();
    } catch (e) {
        console.error("팝업 삭제 실패:", e);
        alert("팝업 삭제 중 오류가 발생했습니다: " + e.message);
    }
}
