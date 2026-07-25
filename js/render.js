// 렌더링 관련 함수들
import { SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS, RECORD_MAX_PHOTOS } from './constants.js';
import { appState } from './state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './render/utils.js';
import { setPhotoAddButtonsEnabled } from './utils/image-source-picker.js';
import { scheduleLucideIcons } from './icons.js';

// renderTimeline과 renderMiniCalendar는 render/timeline.js로 이동됨

/** 기록 등록 화면·편집 화면 공통: 선택된 사진 비율의 CSS aspect-ratio 값 (photo-edit.js의 동명 함수와 동일) */
function getRecordPhotoAspectRatioCss() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

export function clampRecordPhotoHeroIndex() {
    const n = Array.isArray(appState.currentPhotos) ? appState.currentPhotos.length : 0;
    if (n <= 0) {
        appState.recordPhotoHeroIndex = 0;
        return 0;
    }
    let i = Number(appState.recordPhotoHeroIndex);
    if (!Number.isInteger(i) || i < 0) i = 0;
    if (i >= n) i = n - 1;
    appState.recordPhotoHeroIndex = i;
    return i;
}

/** 기록 시트: 사진 + 아래 독립 컨트롤(‹ 편집 ›) */
function buildThumbPhotoHtml(src, idx, total, aspectCss) {
    const disPrev = idx <= 0 ? ' disabled' : '';
    const disNext = idx >= total - 1 ? ' disabled' : '';
    return `<div class="photo-preview-thumb-card" data-index="${idx}">
                <div class="photo-preview-item photo-preview-item--thumb relative rounded-xl overflow-hidden bg-slate-100 border border-slate-300 select-none" style="aspect-ratio: ${aspectCss}; -webkit-touch-callout:none;">
                    <img src="${src}" draggable="false" class="absolute inset-0 w-full h-full object-cover pointer-events-none select-none" style="-webkit-user-drag:none" alt="">
                    <button type="button" onclick="window.removePhoto(${idx})" class="photo-remove-btn" aria-label="사진 삭제">
                        <i data-lucide="x" aria-hidden="true"></i>
                    </button>
                    <div class="photo-preview-order-badge absolute top-1 left-1 w-5 h-5 bg-black/60 text-white text-[10px] font-bold rounded-full flex items-center justify-center pointer-events-none z-10">${idx + 1}</div>
                </div>
                <div class="photo-preview-thumb-controls" role="group" aria-label="사진 ${idx + 1} 순서·편집">
                    <button type="button" onclick="window.movePhotoOrder(${idx}, -1)" class="photo-order-btn photo-order-btn--arrow"${disPrev} title="순서 앞으로" aria-label="순서 앞으로"><span aria-hidden="true">‹</span></button>
                    <button type="button" onclick="window.editPhoto(${idx})" class="photo-edit-btn photo-edit-btn--text" title="편집" aria-label="사진 편집">편집</button>
                    <button type="button" onclick="window.movePhotoOrder(${idx}, 1)" class="photo-order-btn photo-order-btn--arrow"${disNext} title="순서 뒤로" aria-label="순서 뒤로"><span aria-hidden="true">›</span></button>
                </div>
            </div>`;
}

export function renderPhotoPreviews() {
    const isSnackMode = appState.entryFormMode === 'snack';
    const containerId = isSnackMode ? 'snackPhotoPreviewContainer' : 'photoPreviewContainer';
    const countId = isSnackMode ? 'snackPhotoCount' : 'photoCount';
    const cameraBtnId = isSnackMode ? 'snackImageCameraBtn' : 'imageCameraBtn';
    const albumBtnId = isSnackMode ? 'snackImageAlbumBtn' : 'imageAlbumBtn';
    const container = document.getElementById(containerId);
    const countEl = document.getElementById(countId);
    const cameraBtn = document.getElementById(cameraBtnId);
    const albumBtn = document.getElementById(albumBtnId);

    if (!Array.isArray(appState.currentPhotos)) {
        appState.currentPhotos = appState.currentPhotos ? [appState.currentPhotos] : [];
    }

    const maxPhotos = RECORD_MAX_PHOTOS;
    const currentCount = appState.currentPhotos.length;
    const photos = appState.currentPhotos;
    clampRecordPhotoHeroIndex();

    if (container) {
        const aspectCss = getRecordPhotoAspectRatioCss();
        if (currentCount === 0) {
            container.innerHTML = '';
        } else {
            const thumbsHtml = photos
                .map((src, i) => buildThumbPhotoHtml(src, i, currentCount, aspectCss))
                .join('');
            container.innerHTML = `
                <div class="entry-photo-thumb-strip" aria-label="등록된 사진">${thumbsHtml}</div>
            `;
            scheduleLucideIcons(container);
        }
    }

    if (countEl) {
        countEl.innerText = `${currentCount}/${maxPhotos}`;
        if (currentCount >= maxPhotos) {
            countEl.classList.add('text-emerald-600');
            countEl.classList.remove('text-slate-400');
        } else {
            countEl.classList.remove('text-emerald-600');
            countEl.classList.add('text-slate-400');
        }
    }

    setPhotoAddButtonsEnabled([cameraBtn, albumBtn], currentCount < maxPhotos, {
        disabledTitle: `사진은 최대 ${RECORD_MAX_PHOTOS}개까지 추가할 수 있습니다`
    });

    const activeId = isSnackMode ? 'entrySnackPhoto' : 'entryMealPhoto';
    const idleId = isSnackMode ? 'entryMealPhoto' : 'entrySnackPhoto';
    document.getElementById(activeId)?.classList.toggle('entry-photo-section--has-photos', currentCount > 0);
    document.getElementById(idleId)?.classList.remove('entry-photo-section--has-photos');
}

// Comment 확장/축소 토글 함수
export function toggleComment(groupIdx) {
    const collapsedEl = document.getElementById(`comment-collapsed-${groupIdx}`);
    const expandedEl = document.getElementById(`comment-expanded-${groupIdx}`);
    const toggleBtn = document.getElementById(`comment-toggle-${groupIdx}`);
    const collapseBtn = document.getElementById(`comment-collapse-${groupIdx}`);
    
    if (collapsedEl && expandedEl && toggleBtn && collapseBtn) {
        const isCollapsed = !collapsedEl.classList.contains('hidden');
        if (isCollapsed) {
            // 확장
            collapsedEl.classList.add('hidden');
            expandedEl.classList.remove('hidden');
            toggleBtn.classList.add('hidden');
            collapseBtn.classList.remove('hidden');
            
            // 접기 버튼 위치 조정: 확장된 텍스트의 마지막 줄과 같은 높이로
            setTimeout(() => {
                if (expandedEl && collapseBtn) {
                    const expandedStyle = getComputedStyle(expandedEl);
                    const expandedLineHeight = parseFloat(expandedStyle.lineHeight) || 20;
                    const expandedHeight = expandedEl.scrollHeight;
                    const btnHeight = collapseBtn.offsetHeight || 16;
                    // 확장된 텍스트의 마지막 줄 위치
                    const lastLineNumber = Math.ceil(expandedHeight / expandedLineHeight);
                    const lastLineBottom = expandedLineHeight * lastLineNumber;
                    const offset = (expandedLineHeight - btnHeight) / 2;
                    const bottomPosition = (lastLineBottom - btnHeight - offset);
                    collapseBtn.style.bottom = `${Math.max(0, bottomPosition)}px`;
                }
            }, 10);
        } else {
            // 축소
            collapsedEl.classList.remove('hidden');
            expandedEl.classList.add('hidden');
            toggleBtn.classList.remove('hidden');
            collapseBtn.classList.add('hidden');
            
            // 더 보기 버튼 위치 조정: collapsed 텍스트의 마지막 줄과 같은 높이로
            setTimeout(() => {
                if (collapsedEl && toggleBtn) {
                    const computedStyle = getComputedStyle(collapsedEl);
                    const textLineHeight = parseFloat(computedStyle.lineHeight) || 20;
                    const lastLineBottom = textLineHeight * 2; // line-clamp-2이므로 2줄
                    const btnHeight = toggleBtn.offsetHeight || 16;
                    const offset = (textLineHeight - btnHeight) / 2;
                    const bottomPosition = (lastLineBottom - btnHeight - offset);
                    toggleBtn.style.bottom = `${Math.max(0, bottomPosition)}px`;
                }
            }, 10);
        }
    }
}


export function renderTagManager(key, isSub = false, tempSettings) {
    const containerId = isSub ? `tagManage-sub-${key}` : `tagManage-${key}`;
    const container = document.getElementById(containerId);
    if (!container || !tempSettings) return;
    
    const tags = isSub ? (tempSettings.subTags[key] || []) : tempSettings.tags[key];
    const protectedTags = isSub ? [] : ['Skip', '혼자', '미분류'];
    const nonEditableMainTags = ['mealType', 'category']; // 메인 태그 중 편집 불가능한 태그
    const isNonEditable = !isSub && nonEditableMainTags.includes(key);
    
    let labelText = "";
    if (!isSub) {
        if (key === 'mealType') labelText = '어떻게 (대분류)';
        else if (key === 'withWhom') labelText = '누구와 (대분류)';
        else if (key === 'category') labelText = '무엇을 (대분류)';
        else if (key === 'snackType') labelText = '간식 구분 (대분류)';
    }
    
    let html = `<div class="text-[11px] font-bold text-slate-400 mb-2 uppercase tracking-tighter">${labelText}</div>
        <div class="flex flex-wrap gap-2 ${isNonEditable ? 'mb-0' : 'mb-2'}">
            ${tags.map((tag, idx) => {
                const text = typeof tag === 'string' ? tag : tag.text;
                const parentInfo = (isSub && tag.parent) ? `<span class="text-[9px] text-slate-400 ml-1 font-normal">(${tag.parent})</span>` : '';
                return `<div class="tag-manage-item">
                    <span class="text-[11px] font-bold text-slate-600">${text}</span>${parentInfo}
                    ${!isNonEditable && !protectedTags.includes(text) ? 
                        `<div onclick="window.removeTag('${key}', ${idx}, ${isSub})" class="tag-delete-btn">
                            <i data-lucide="x" class="text-[10px]"></i>
                        </div>` : ''
                    }
                </div>`;
            }).join('')}
        </div>`;
    
    // 메인 태그(mealType, category)는 편집 기능 제거
    if (!isNonEditable) {
        html += `<div class="flex gap-2">
            <input type="text" id="newTag-${isSub ? 'sub-' : ''}${key}" class="flex-1 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-slate-400" placeholder="태그 추가">
            <button ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); window.addTag('${key}', ${isSub})" onclick="window.addTag('${key}', ${isSub})" class="bg-emerald-50 text-emerald-600 px-3 py-1 rounded-lg text-xs font-bold border border-emerald-100">추가</button>
        </div>`;
    }
    
    container.innerHTML = html;
}

