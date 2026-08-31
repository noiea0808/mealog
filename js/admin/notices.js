// ADMIN 공지(알림) 관리
import { app, db, appId, auth } from '../firebase.js';
import {
    collection, query, orderBy, getDocs, doc, getDoc, setDoc, addDoc, deleteDoc, getCountFromServer
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml } from './utils.js';
import { sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly } from '../render/utils.js';
import { uploadNoticeImages } from '../utils.js';
import { getAdminDisplayName } from '../db.js';

let currentEditingNoticeId = null;
let currentSelectedNoticeId = null;

const NOTICE_TYPE_LABELS = { important: '중요', notice: '알림', light: '가벼운' };
const NOTICE_PUSH_LABELS = { none: '알림 없음', once: '한 번만', daily: '하루 한 번' };
const NOTICE_TYPE_CLASSES = { important: 'bg-red-100 text-red-700', notice: 'bg-blue-100 text-blue-700', light: 'bg-slate-100 text-slate-700' };

function formatNoticeDate(notice) {
    const ts = notice.timestamp;
    if (!ts) return '-';
    const d = typeof ts?.toDate === 'function' ? ts.toDate() : new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString('ko-KR') : '-';
}

export async function renderNotices() {
    const container = document.getElementById('noticesContainer');
    if (!container) return;
    
    try {
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const noticesSnapshot = await getDocs(query(noticesColl, orderBy('timestamp', 'desc')));
        
        if (noticesSnapshot.empty) {
            container.innerHTML = '<div class="text-center py-8 text-slate-400 px-4"><i data-lucide="megaphone" class="text-2xl mb-2"></i><p>공지가 없습니다.</p></div>';
            document.getElementById('noticeDetailContainer').innerHTML = '목록에서 공지를 선택하면 본문이 표시됩니다.';
            return;
        }
        const viewCounts = await Promise.all(noticesSnapshot.docs.map(async (d) => {
            try {
                const viewColl = collection(db, 'artifacts', appId, 'notices', d.id, 'views');
                const snap = await getCountFromServer(viewColl);
                return { noticeId: d.id, count: snap.data().count };
            } catch (e) {
                return { noticeId: d.id, count: 0 };
            }
        }));
        const viewCountMap = new Map(viewCounts.map(v => [v.noticeId, v.count]));
        
        container.innerHTML = noticesSnapshot.docs.map(d => {
            const notice = d.data();
            const noticeId = d.id;
            const date = formatNoticeDate(notice);
            const type = notice.type || notice.noticeType || 'notice';
            const typeLabel = NOTICE_TYPE_LABELS[type] || '알림';
            const typeClass = NOTICE_TYPE_CLASSES[type] || NOTICE_TYPE_CLASSES.notice;
            const isSelected = currentSelectedNoticeId === noticeId;
            const viewCount = viewCountMap.get(noticeId) ?? 0;
            return `
                <div data-notice-id="${noticeId}" onclick="window.selectAdminNotice('${noticeId}')" class="admin-notice-row px-4 py-3 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 transition-colors ${isSelected ? 'bg-emerald-50 border-l-4 border-l-emerald-500' : ''}">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="px-2 py-0.5 text-xs font-bold rounded ${typeClass}">${escapeHtml(typeLabel)}</span>
                        ${notice.isPinned === true ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">고정</span>' : ''}
                        ${notice.hidden === true ? '<span class="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs font-bold rounded">숨김</span>' : ''}
                        ${(notice.pushFrequency && notice.pushFrequency !== 'none') ? `<span class="px-2 py-0.5 bg-violet-100 text-violet-700 text-xs font-bold rounded">${escapeHtml(NOTICE_PUSH_LABELS[notice.pushFrequency] || notice.pushFrequency)}</span>` : ''}
                    </div>
                    <h3 class="font-bold text-slate-800 truncate mt-1">${escapeHtml(notice.title || '제목 없음')}</h3>
                    <div class="flex items-center gap-3 mt-1 text-xs text-slate-400">
                        <span>${date}</span>
                        <span class="text-slate-500">조회 <span class="font-bold text-slate-600">${viewCount}</span></span>
                    </div>
                </div>
            `;
        }).join('');
        
        const listPage = document.getElementById('noticeListPage');
        const detailPage = document.getElementById('noticeDetailPage');
        if (listPage) listPage.classList.remove('hidden');
        if (detailPage) detailPage.classList.add('hidden');
    } catch (e) {
        console.error("공지 렌더링 실패:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400 px-4"><i data-lucide="triangle-alert" class="text-2xl mb-2"></i><p>공지를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 관리자 공지 본문 표시
async function renderNoticeDetailInAdmin(noticeId) {
    const container = document.getElementById('noticeDetailContainer');
    if (!container) return;
    
    if (!noticeId) {
        container.innerHTML = '';
        return;
    }
    
    try {
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        const snap = await getDoc(noticeDoc);
        if (!snap.exists()) {
            container.innerHTML = '<p class="text-red-400">공지를 찾을 수 없습니다.</p>';
            return;
        }
        const notice = snap.data();
        const date = formatNoticeDate(notice);
        const type = notice.type || notice.noticeType || 'notice';
        const typeLabel = NOTICE_TYPE_LABELS[type] || '알림';
        const typeClass = NOTICE_TYPE_CLASSES[type] || NOTICE_TYPE_CLASSES.notice;
        
        container.innerHTML = `
            <div class="bg-white rounded-xl p-4 border border-slate-200">
                <div class="flex items-center gap-2 flex-wrap mb-2">
                    <span class="px-2 py-0.5 text-xs font-bold rounded ${typeClass}">${escapeHtml(typeLabel)}</span>
                    ${notice.isPinned === true ? '<span class="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-bold rounded">고정</span>' : ''}
                    ${notice.hidden === true ? '<span class="px-2 py-0.5 bg-slate-200 text-slate-600 text-xs font-bold rounded">숨김</span>' : ''}
                    <span class="px-2 py-0.5 bg-violet-50 text-violet-700 text-xs font-bold rounded border border-violet-100">푸시: ${escapeHtml(NOTICE_PUSH_LABELS[notice.pushFrequency] || NOTICE_PUSH_LABELS.none)}</span>
                </div>
                <h2 class="text-lg font-bold text-slate-800 mb-2">${escapeHtml(notice.title || '제목 없음')}</h2>
                <div class="text-xs text-slate-400 mb-4">${date}</div>
                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? `
                <div class="flex flex-wrap gap-2 mb-4">
                    ${notice.imageUrls.map(url => `<img src="${url}" alt="공지 사진" class="max-w-full h-auto rounded-xl border border-slate-200 object-cover" style="max-height: 200px;" loading="lazy">`).join('')}
                </div>
                ` : ''}
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4">${renderFormattedContent(notice.content || '')}</div>
                <div class="pt-2 border-t border-slate-200">
                    <p class="text-xs text-slate-500 mb-2">작업</p>
                    <div class="flex gap-2 flex-wrap">
                        <button type="button" onclick="window.toggleNoticeHidden('${noticeId}')" class="px-4 py-2 ${notice.hidden === true ? 'bg-emerald-500 text-white hover:bg-emerald-600' : 'bg-slate-500 text-white hover:bg-slate-600'} rounded-lg text-sm font-bold transition-colors">
                            <i class="fa-solid fa-eye${notice.hidden === true ? '-slash' : ''} mr-1.5"></i>${notice.hidden === true ? '숨김 해제' : '숨김'}
                        </button>
                        <button type="button" onclick="window.editNotice('${noticeId}')" class="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold hover:bg-blue-100 transition-colors">
                            <i data-lucide="pen" class="mr-1"></i>수정
                        </button>
                        <button type="button" onclick="window.deleteNotice('${noticeId}')" class="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-bold hover:bg-red-100 transition-colors">
                            <i data-lucide="trash-2" class="mr-1"></i>삭제
                        </button>
                    </div>
                </div>
            </div>
        `;
    } catch (e) {
        console.error("공지 본문 로드 실패:", e);
        container.innerHTML = '<p class="text-red-400">본문을 불러오는 중 오류가 발생했습니다.</p>';
    }
}

// 관리자 공지 목록에서 항목 선택 → 글본문 페이지로 전환
window.selectAdminNotice = function(noticeId) {
    currentSelectedNoticeId = noticeId;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.remove('hidden');
    renderNoticeDetailInAdmin(noticeId);
    document.querySelectorAll('.admin-notice-row').forEach(row => {
        const id = row.getAttribute('data-notice-id');
        if (id === noticeId) {
            row.classList.add('bg-emerald-50', 'border-l-4', 'border-l-emerald-500');
            row.classList.remove('border-l-0');
        } else {
            row.classList.remove('bg-emerald-50', 'border-l-4', 'border-l-emerald-500');
        }
    });
};

// 관리자 공지 글본문 → 글목록 페이지로 돌아가기
window.backToNoticeList = function() {
    currentSelectedNoticeId = null;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    const writePage = document.getElementById('noticeWritePage');
    if (listPage) listPage.classList.remove('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    if (writePage) writePage.classList.add('hidden');
};

// 글쓰기/수정 페이지에서 목록으로 (취소·등록 후 공통)
window.backToNoticeListFromWrite = function() {
    window.backToNoticeList();
    currentEditingNoticeId = null;
};

// 공지 작성/수정 페이지 열기 (페이지 형식)
window.openNoticeWriteModal = function(noticeId = null) {
    currentEditingNoticeId = noticeId;
    const listPage = document.getElementById('noticeListPage');
    const detailPage = document.getElementById('noticeDetailPage');
    const writePage = document.getElementById('noticeWritePage');
    const titleEl = document.getElementById('noticeWritePageTitle');
    const submitBtn = document.getElementById('noticeSubmitBtn');
    const titleInput = document.getElementById('noticeTitle');
    const contentInput = document.getElementById('noticeContent');
    const typeSelect = document.getElementById('noticeType');
    const pinnedCheckbox = document.getElementById('noticeIsPinned');
    const hiddenCheckbox = document.getElementById('noticeHidden');
    
    if (!writePage) return;
    
    // 목록/상세 숨기고 글쓰기 페이지 표시
    if (listPage) listPage.classList.add('hidden');
    if (detailPage) detailPage.classList.add('hidden');
    writePage.classList.remove('hidden');
    
    // 초기화
    if (titleInput) titleInput.value = '';
    if (contentInput) {
        contentInput.innerHTML = '';
        contentInput.classList.add('format-editor-empty');
    }
    window.noticeExistingUrls = [];
    window.noticeFiles = [];
    if (window.noticeObjectUrls?.length) {
        window.noticeObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
    }
    window.noticeObjectUrls = [];
    const noticeImagesInput = document.getElementById('noticeImages');
    if (noticeImagesInput) noticeImagesInput.value = '';
    renderNoticeImagePreviews();
    if (typeSelect) typeSelect.value = 'important';
    if (pinnedCheckbox) pinnedCheckbox.checked = false;
    if (hiddenCheckbox) hiddenCheckbox.checked = false;
    const pushFreqSelect = document.getElementById('noticePushFrequency');
    if (pushFreqSelect) pushFreqSelect.value = 'none';

    // 수정 모드인 경우
    if (noticeId) {
        if (titleEl) titleEl.textContent = '공지 수정';
        if (submitBtn) submitBtn.textContent = '수정';
        
        // 공지 데이터 로드
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        getDoc(noticeDoc).then(snap => {
            if (snap.exists()) {
                const noticeData = snap.data();
                if (titleInput) titleInput.value = noticeData.title || '';
                if (contentInput) {
                    contentInput.innerHTML = (noticeData.content || '').replace(/\n/g, '<br>');
                    contentInput.classList.remove('format-editor-empty');
                }
                window.noticeExistingUrls = Array.isArray(noticeData.imageUrls) ? [...noticeData.imageUrls] : [];
                window.noticeFiles = [];
                if (window.noticeObjectUrls?.length) {
                    window.noticeObjectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
                }
                window.noticeObjectUrls = [];
                const noticeImagesInput = document.getElementById('noticeImages');
                if (noticeImagesInput) noticeImagesInput.value = '';
                renderNoticeImagePreviews();
                if (typeSelect) typeSelect.value = noticeData.type || 'important';
                if (pinnedCheckbox) pinnedCheckbox.checked = Boolean(noticeData.isPinned === true);
                if (hiddenCheckbox) hiddenCheckbox.checked = Boolean(noticeData.hidden === true);
                const pushSel = document.getElementById('noticePushFrequency');
                if (pushSel) {
                    const pf = noticeData.pushFrequency;
                    pushSel.value = pf === 'once' || pf === 'daily' ? pf : 'none';
                }
            }
        }).catch(e => {
            console.error("공지 로드 실패:", e);
            alert("공지를 불러오는 중 오류가 발생했습니다.");
        });
    } else {
        if (titleEl) titleEl.textContent = '공지 작성';
        if (submitBtn) submitBtn.textContent = '등록';
    }
};

// 공지 사진 미리보기 렌더
export function renderNoticeImagePreviews() {
    const container = document.getElementById('noticeImagePreviews');
    if (!container) return;
    const existing = window.noticeExistingUrls || [];
    const files = window.noticeFiles || [];
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
        wrap.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            window.noticeExistingUrls.splice(i, 1);
            renderNoticeImagePreviews();
        });
        container.appendChild(wrap);
    });
    files.forEach((file, i) => {
        const objectUrl = window.noticeObjectUrls && window.noticeObjectUrls[i];
        if (!objectUrl) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `
            <img src="${objectUrl}" alt="미리보기" class="w-full h-full object-cover">
            <button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl hover:bg-red-600" data-type="file" data-index="${i}" aria-label="삭제">
                <i data-lucide="x"></i>
            </button>
        `;
        wrap.querySelector('button').addEventListener('click', (e) => {
            e.preventDefault();
            if (window.noticeObjectUrls && window.noticeObjectUrls[i]) {
                try { URL.revokeObjectURL(window.noticeObjectUrls[i]); } catch (_) {}
                window.noticeObjectUrls.splice(i, 1);
            }
            window.noticeFiles.splice(i, 1);
            renderNoticeImagePreviews();
        });
        container.appendChild(wrap);
    });
}

// 공지 작성 페이지 닫기 (목록으로 복귀)
window.closeNoticeModal = function() {
    window.backToNoticeListFromWrite();
};

// 공지 제출 (작성/수정)
window.submitNotice = async function() {
    const titleInput = document.getElementById('noticeTitle');
    const contentInput = document.getElementById('noticeContent');
    const typeSelect = document.getElementById('noticeType');
    const pinnedCheckbox = document.getElementById('noticeIsPinned');
    const hiddenCheckbox = document.getElementById('noticeHidden');
    const submitBtn = document.getElementById('noticeSubmitBtn');
    
    if (!titleInput || !contentInput) return;
    
    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    const type = typeSelect ? typeSelect.value : 'important';
    const isPinned = pinnedCheckbox ? Boolean(pinnedCheckbox.checked) : false;
    const hidden = hiddenCheckbox ? Boolean(hiddenCheckbox.checked) : false;
    const pushFreqEl = document.getElementById('noticePushFrequency');
    let pushFrequency = pushFreqEl ? String(pushFreqEl.value || 'none') : 'none';
    if (pushFrequency !== 'once' && pushFrequency !== 'daily') pushFrequency = 'none';

    // sanitize 결과가 비었으나 rawContent에 내용이 있으면 위험 태그만 제거하여 서식 보존
    if (!content && rawContent.trim()) {
        content = stripDangerousTagsOnly(rawContent).trim();
    }
    if (!content) {
        const plainText = (contentInput.innerText || '').trim();
        if (plainText) content = plainText.replace(/\n/g, '<br>');
    }
    
    if (!title) {
        alert('제목을 입력해주세요.');
        return;
    }
    
    if (!content) {
        alert('내용을 입력해주세요.');
        return;
    }
    
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader-circle" class="mr-2 lucide-spin"></i>처리 중...';
    }
    
    try {
        const existingUrls = window.noticeExistingUrls || [];
        const newFiles = window.noticeFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = auth.currentUser?.uid;
            if (!uid) {
                alert('로그인이 필요합니다.');
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = currentEditingNoticeId ? '수정' : '등록'; }
                return;
            }
            const newUrls = await uploadNoticeImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }
        
        const noticeData = {
            title: title,
            content: content,
            type: type,
            isPinned: isPinned,
            hidden: hidden,
            pushFrequency,
            imageUrls: imageUrls,
            timestamp: new Date().toISOString(),
            /**
             * 하단 네비 레드닷의 내 글 제외용 — 이 timestamp 를 갱신한 관리자 본인에게는
             * 새 공지 점을 띄우지 않는다 (nav-feed-update-dots.js peekLatestNoticeTimestampMs).
             * 수정도 timestamp 를 갱신하므로 수정자 uid 로 덮어쓰는 것이 맞다.
             */
            authorId: auth.currentUser?.uid || null,
            authorDisplayName: await getAdminDisplayName()
        };

        if (currentEditingNoticeId) {
            // 수정 (isPinned, hidden 명시적 저장 - 체크 해제 시 false로 반영)
            const noticeDoc = doc(db, 'artifacts', appId, 'notices', currentEditingNoticeId);
            await setDoc(noticeDoc, { ...noticeData, isPinned: isPinned, hidden: hidden }, { merge: true });
            alert('공지가 수정되었습니다.');
        } else {
            // 작성
            const noticesColl = collection(db, 'artifacts', appId, 'notices');
            await addDoc(noticesColl, noticeData);
            alert('공지가 등록되었습니다.');
        }
        
        window.backToNoticeListFromWrite();
        await renderNotices();
    } catch (e) {
        console.error("공지 저장 실패:", e);
        alert("공지 저장 중 오류가 발생했습니다: " + e.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = currentEditingNoticeId ? '수정' : '등록';
        }
    }
};

// 공지 수정 (글쓰기 페이지로 전환)
window.editNotice = function(noticeId) {
    window.openNoticeWriteModal(noticeId);
};

function renderNoticeInlineImagePreviews() {
    const container = document.getElementById('noticeInlineImagePreviews');
    if (!container) return;
    const existing = window.noticeExistingUrls || [];
    const files = window.noticeFiles || [];
    container.innerHTML = '';
    existing.forEach((url, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `<img src="${url}" alt="미리보기" class="w-full h-full object-cover"><button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl" data-type="url" data-index="${i}"><i data-lucide="x"></i></button>`;
        wrap.querySelector('button').onclick = () => { window.noticeExistingUrls.splice(i, 1); renderNoticeInlineImagePreviews(); };
        container.appendChild(wrap);
    });
    files.forEach((_, i) => {
        const url = (window.noticeObjectUrls || [])[i];
        if (!url) return;
        const wrap = document.createElement('div');
        wrap.className = 'relative w-16 h-16 rounded-lg overflow-hidden border border-slate-200 flex-shrink-0';
        wrap.innerHTML = `<img src="${url}" alt="미리보기" class="w-full h-full object-cover"><button type="button" class="absolute top-0 right-0 w-6 h-6 flex items-center justify-center bg-red-500 text-white text-xs rounded-bl"><i data-lucide="x"></i></button>`;
        wrap.querySelector('button').onclick = () => {
            window.noticeFiles.splice(i, 1);
            window.noticeObjectUrls.splice(i, 1);
            renderNoticeInlineImagePreviews();
        };
        container.appendChild(wrap);
    });
}

window.cancelNoticeEdit = function(noticeId) {
    currentEditingNoticeId = null;
    renderNoticeDetailInAdmin(noticeId);
};

window.submitNoticeFromInline = async function(noticeId) {
    const titleInput = document.getElementById('noticeInlineTitle');
    const contentInput = document.getElementById('noticeInlineContent');
    const typeSelect = document.getElementById('noticeInlineType');
    const pinnedCheckbox = document.getElementById('noticeInlinePinned');
    const hiddenCheckbox = document.getElementById('noticeInlineHidden');
    if (!titleInput || !contentInput) return;

    const title = titleInput.value.trim();
    const rawContent = contentInput.innerHTML || '';
    let content = sanitizeFormattedText(rawContent).trim();
    if (!content && rawContent.trim()) content = stripDangerousTagsOnly(rawContent).trim();
    if (!content) content = (contentInput.innerText || '').trim().replace(/\n/g, '<br>');

    if (!title) { alert('제목을 입력해주세요.'); return; }
    if (!content) { alert('내용을 입력해주세요.'); return; }

    const type = typeSelect ? typeSelect.value : 'important';
    const isPinned = pinnedCheckbox ? Boolean(pinnedCheckbox.checked) : false;
    const hidden = hiddenCheckbox ? Boolean(hiddenCheckbox.checked) : false;

    try {
        const existingUrls = window.noticeExistingUrls || [];
        const newFiles = window.noticeFiles || [];
        let imageUrls = [...existingUrls];
        if (newFiles.length > 0) {
            const uid = auth.currentUser?.uid;
            if (!uid) { alert('로그인이 필요합니다.'); return; }
            const newUrls = await uploadNoticeImages(newFiles, uid);
            imageUrls = [...existingUrls, ...newUrls];
        }

        const noticeData = {
            title, content, type, isPinned, hidden, imageUrls,
            timestamp: new Date().toISOString(),
            authorDisplayName: await getAdminDisplayName()
        };
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        await setDoc(noticeDoc, { ...noticeData, isPinned, hidden }, { merge: true });
        alert('공지가 수정되었습니다.');
        currentEditingNoticeId = null;
        await renderNotices();
        await renderNoticeDetailInAdmin(noticeId);
    } catch (e) {
        console.error("공지 저장 실패:", e);
        alert("공지 저장 중 오류가 발생했습니다: " + e.message);
    }
};

// 공지 숨김/숨김 해제 토글 (글본문 페이지에서 바로)
window.toggleNoticeHidden = async function(noticeId) {
    if (!noticeId) return;
    try {
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        const snap = await getDoc(noticeDoc);
        if (!snap.exists()) {
            alert('공지를 찾을 수 없습니다.');
            return;
        }
        const current = Boolean(snap.data().hidden === true);
        await setDoc(noticeDoc, { hidden: !current }, { merge: true });
        await renderNoticeDetailInAdmin(noticeId);
        await renderNotices();
    } catch (e) {
        console.error("공지 숨김 토글 실패:", e);
        alert("처리 중 오류가 발생했습니다: " + e.message);
    }
};

// 공지 삭제
window.deleteNotice = async function(noticeId) {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    
    try {
        if (noticeId === currentSelectedNoticeId) currentSelectedNoticeId = null;
        const noticeDoc = doc(db, 'artifacts', appId, 'notices', noticeId);
        await deleteDoc(noticeDoc);
        alert('공지가 삭제되었습니다.');
        await renderNotices();
    } catch (e) {
        console.error("공지 삭제 실패:", e);
        alert("공지 삭제 중 오류가 발생했습니다: " + e.message);
    }
};
