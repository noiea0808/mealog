// 렌더링 관련 함수들
import { SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './render/utils.js';

// renderTimeline과 renderMiniCalendar는 render/timeline.js로 이동됨

/** 기록 등록 화면·편집 화면 공통: 선택된 사진 비율의 CSS aspect-ratio 값 (photo-edit.js의 동명 함수와 동일) */
function getRecordPhotoAspectRatioCss() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

export function renderPhotoPreviews() {
    const snackFields = document.getElementById('snackFields');
    const isSnackMode = snackFields && !snackFields.classList.contains('hidden');
    const containerId = isSnackMode ? 'snackPhotoPreviewContainer' : 'photoPreviewContainer';
    const countId = isSnackMode ? 'snackPhotoCount' : 'photoCount';
    const buttonId = isSnackMode ? 'snackImageBtn' : 'imageBtn';
    const container = document.getElementById(containerId);
    const countEl = document.getElementById(countId);
    const buttonEl = document.getElementById(buttonId);
    
    // currentPhotos가 배열인지 확인하고, 배열이 아니면 배열로 변환
    if (!Array.isArray(appState.currentPhotos)) {
        appState.currentPhotos = appState.currentPhotos ? [appState.currentPhotos] : [];
    }
    
    const maxPhotos = 10;
    const currentCount = appState.currentPhotos.length;
    
    if (container) {
        const aspectCss = getRecordPhotoAspectRatioCss();
        container.innerHTML = appState.currentPhotos.map((src, idx) => 
            `<div class="photo-preview-item relative rounded-xl overflow-hidden bg-slate-100 flex-shrink-0 border-2 border-slate-300 select-none" style="width: 7rem; aspect-ratio: ${aspectCss};-webkit-touch-callout:none;" draggable="true" data-index="${idx}" data-original-index="${idx}">
                <img src="${src}" draggable="false" class="absolute inset-0 w-full h-full object-cover pointer-events-none select-none" style="-webkit-user-drag:none" alt="">
                <button type="button" onclick="window.removePhoto(parseInt(this.closest('.photo-preview-item').dataset.originalIndex, 10))" class="photo-remove-btn">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <button type="button" onclick="window.editPhoto(parseInt(this.closest('.photo-preview-item').dataset.originalIndex, 10))" class="photo-edit-btn">
                    <i class="fa-solid fa-crop"></i>
                </button>
                <div class="photo-preview-order-badge absolute top-1 left-1 w-5 h-5 bg-black/60 text-white text-[10px] font-bold rounded-full flex items-center justify-center pointer-events-none">${idx + 1}</div>
            </div>`
        ).join('');
        
        // 드래그 앤 드롭 이벤트 리스너 추가 (long press 지원)
        const photoItems = container.querySelectorAll('.photo-preview-item');
        const touchPrimaryReorder =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(hover: none) and (pointer: coarse)').matches;
        photoItems.forEach(item => {
            item.draggable = !touchPrimaryReorder;
            // 기존 드래그 앤 드롭 (데스크톱)
            item.addEventListener('dragstart', handleDragStart);
            item.addEventListener('dragover', handleDragOver);
            item.addEventListener('drop', handleDrop);
            item.addEventListener('dragend', handleDragEnd);
            
            // 롱터치 시 컨텍스트 메뉴 방지
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
            });
            
            // 모바일: 터치는 요소 밖으로 나가면 touchmove가 끊김 → Pointer Events + setPointerCapture 사용
            const canPointerCapture =
                typeof Element !== 'undefined' &&
                Element.prototype &&
                typeof Element.prototype.setPointerCapture === 'function';
            setupLongPressDrag(item, touchPrimaryReorder && canPointerCapture);
        });
    }
    
    // 사진 개수 표시
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
    
    // 버튼 활성/비활성 처리
    if (buttonEl) {
        if (currentCount >= maxPhotos) {
            buttonEl.disabled = true;
            buttonEl.classList.add('opacity-50', 'cursor-not-allowed');
            buttonEl.classList.remove('active:bg-slate-100');
            buttonEl.title = '사진은 최대 10개까지 추가할 수 있습니다';
        } else {
            buttonEl.disabled = false;
            buttonEl.classList.remove('opacity-50', 'cursor-not-allowed');
            buttonEl.classList.add('active:bg-slate-100');
            buttonEl.title = '';
        }
    }
}

// 드래그 앤 드롭 핸들러
let draggedIndex = null;
let draggedElement = null;
let dropIndex = null;

/** 미리보기 DOM 순서 → appState.currentPhotos 반영 (img.src 정규화 불일치·동일 URL 중복 시에도 안전) */
function commitPhotoOrderFromDom(container) {
    if (!container) return false;
    const items = Array.from(container.querySelectorAll('.photo-preview-item'));
    const photos = appState.currentPhotos;
    if (!items.length || items.length !== photos.length) return false;
    const next = [];
    for (const el of items) {
        const oi = parseInt(el.dataset.originalIndex, 10);
        if (!Number.isNaN(oi) && oi >= 0 && oi < photos.length) {
            next.push(photos[oi]);
            continue;
        }
        const img = el.querySelector('img');
        const attrSrc = img?.getAttribute('src');
        const resolvedSrc = img?.src;
        const photo = photos.find((p) => p === attrSrc || p === resolvedSrc);
        if (photo === undefined) return false;
        next.push(photo);
    }
    const changed = items.some((el, i) => parseInt(el.dataset.originalIndex, 10) !== i);
    if (!changed) return false;
    appState.currentPhotos = next;
    renderPhotoPreviews();
    return true;
}

// Long press to drag (터치 디바이스 지원)
let longPressTimer = null;
let isLongPressing = false;
let photoDragScrollRow = null;
let photoDragScrollRowPrevTouchAction = '';

function lockPhotoDragScrollRow(item) {
    photoDragScrollRow = item.closest('.overflow-x-auto');
    if (photoDragScrollRow) {
        photoDragScrollRowPrevTouchAction = photoDragScrollRow.style.touchAction;
        photoDragScrollRow.style.touchAction = 'none';
    }
}

function unlockPhotoDragScrollRow() {
    if (photoDragScrollRow) {
        photoDragScrollRow.style.touchAction = photoDragScrollRowPrevTouchAction;
        photoDragScrollRow = null;
        photoDragScrollRowPrevTouchAction = '';
    }
}

function suppressSelectWhilePhotoTouchDrag(e) {
    e.preventDefault();
}

let photoTouchDragSelectGuardCount = 0;

function beginPhotoTouchDragSelectGuard() {
    if (photoTouchDragSelectGuardCount === 0) {
        document.addEventListener('selectstart', suppressSelectWhilePhotoTouchDrag, true);
    }
    photoTouchDragSelectGuardCount += 1;
}

function endPhotoTouchDragSelectGuard() {
    photoTouchDragSelectGuardCount = Math.max(0, photoTouchDragSelectGuardCount - 1);
    if (photoTouchDragSelectGuardCount === 0) {
        document.removeEventListener('selectstart', suppressSelectWhilePhotoTouchDrag, true);
    }
}

/** 손가락을 뗄 때 썸네일 노드에 touchend가 안 오는 경우가 많아 document 캡처에서 처리 */
let photoTouchDragTouchId = null;
let photoTouchDocEndFn = null;
let photoTouchDragFinalizeScheduled = false;
let photoTouchLastClientX = null;
let photoTouchLastClientY = null;
let photoReorderCapturedPointerId = null;

function changedTouchesIncludesId(e, id) {
    if (id == null || !e?.changedTouches?.length) return false;
    for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === id) return true;
    }
    return false;
}

function attachPhotoTouchDocEnd() {
    if (photoTouchDocEndFn) return;
    photoTouchDocEndFn = (e) => {
        if (!isLongPressing || photoTouchDragTouchId == null) return;
        if (!changedTouchesIncludesId(e, photoTouchDragTouchId)) return;
        scheduleFinalizePhotoTouchDrag();
    };
    document.addEventListener('touchend', photoTouchDocEndFn, true);
    document.addEventListener('touchcancel', photoTouchDocEndFn, true);
}

function detachPhotoTouchDocEnd() {
    if (!photoTouchDocEndFn) return;
    document.removeEventListener('touchend', photoTouchDocEndFn, true);
    document.removeEventListener('touchcancel', photoTouchDocEndFn, true);
    photoTouchDocEndFn = null;
}

function scheduleFinalizePhotoTouchDrag() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
    if (!isLongPressing) return;
    if (photoTouchDragFinalizeScheduled) return;
    photoTouchDragFinalizeScheduled = true;
    queueMicrotask(() => {
        try {
            if (isLongPressing) {
                finalizePhotoTouchDragGesture();
            }
        } finally {
            photoTouchDragFinalizeScheduled = false;
        }
    });
}

/** 터치 X 기준으로 삽입할 대상 썸네일 (드래그 중인 요소는 제외) */
function resolveTouchReorderTarget(container, touchX, touchY, draggedEl) {
    const allItems = Array.from(container.querySelectorAll('.photo-preview-item'));
    if (typeof document.elementFromPoint === 'function' && touchY != null) {
        const hit = document.elementFromPoint(touchX, touchY);
        const fromPoint = hit?.closest?.('.photo-preview-item');
        if (fromPoint && fromPoint !== draggedEl && container.contains(fromPoint)) {
            return fromPoint;
        }
    }
    let closestItem = null;
    let closestDistance = Infinity;
    allItems.forEach((other) => {
        if (other === draggedEl) return;
        const rect = other.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const d = Math.abs(touchX - cx);
        if (d < closestDistance) {
            closestDistance = d;
            closestItem = other;
        }
    });
    return closestItem;
}

function finalizePhotoTouchDragGesture() {
    detachPhotoTouchDocEnd();
    photoTouchDragTouchId = null;

    const el = draggedElement;
    const capId = photoReorderCapturedPointerId;
    photoReorderCapturedPointerId = null;
    if (el && capId != null && typeof el.releasePointerCapture === 'function') {
        try {
            el.releasePointerCapture(capId);
        } catch (_) { /* ignore */ }
    }

    const wasDragging = isLongPressing;
    if (
        wasDragging &&
        el?.parentElement &&
        photoTouchLastClientX != null &&
        photoTouchLastClientY != null
    ) {
        const c = el.parentElement;
        const t = resolveTouchReorderTarget(c, photoTouchLastClientX, photoTouchLastClientY, el);
        if (t) {
            applyTouchReorderInsert(c, t, photoTouchLastClientX);
        }
    }
    photoTouchLastClientX = null;
    photoTouchLastClientY = null;

    unlockPhotoDragScrollRow();
    let committed = false;
    if (wasDragging && el?.parentElement) {
        committed = commitPhotoOrderFromDom(el.parentElement);
    }
    if (!committed && el && el.isConnected) {
        el.classList.remove('opacity-50', 'scale-110', 'z-50');
        el.style.transition = '';
    }
    isLongPressing = false;
    draggedIndex = null;
    draggedElement = null;
    dropIndex = null;
    if (wasDragging) {
        endPhotoTouchDragSelectGuard();
    }
    try {
        window.getSelection()?.removeAllRanges();
    } catch (_) { /* ignore */ }
}

function applyTouchReorderInsert(container, targetItem, touchX) {
    if (!targetItem || !draggedElement) return;
    const rect = targetItem.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    if (touchX < mid) {
        if (draggedElement.nextSibling !== targetItem) {
            container.insertBefore(draggedElement, targetItem);
        }
    } else if (targetItem.nextSibling !== draggedElement) {
        container.insertBefore(draggedElement, targetItem.nextSibling);
    }
    const updatedItems = Array.from(container.querySelectorAll('.photo-preview-item'));
    updatedItems.forEach((updatedItem, idx) => {
        updatedItem.dataset.index = String(idx);
        const numberBadge = updatedItem.querySelector('.photo-preview-order-badge');
        if (numberBadge) {
            numberBadge.textContent = String(idx + 1);
        }
    });
    draggedIndex = updatedItems.indexOf(draggedElement);
    if (draggedIndex >= 0) {
        dropIndex = draggedIndex;
    }
}

/** 드래그 중 마지막 좌표로 한 칸이라도 맞춤 (scale 적용 직후 레이아웃·좌표 동기화용) */
function applyPhotoTouchReorderMoveFromCoords() {
    if (!isLongPressing || !draggedElement) return;
    const container = draggedElement.parentElement;
    if (!container) return;
    const touchX = photoTouchLastClientX;
    const touchY = photoTouchLastClientY;
    if (touchX == null || touchY == null) return;
    const targetItem = resolveTouchReorderTarget(container, touchX, touchY, draggedElement);
    if (targetItem) {
        applyTouchReorderInsert(container, targetItem, touchX);
    }
}

/** 썸네일 확대 직후 getBoundingClientRect가 한 박자 늦는 기기 대비 */
function schedulePhotoReorderLayoutSync() {
    applyPhotoTouchReorderMoveFromCoords();
    requestAnimationFrame(() => {
        applyPhotoTouchReorderMoveFromCoords();
        requestAnimationFrame(() => {
            applyPhotoTouchReorderMoveFromCoords();
        });
    });
}

function abortPendingPhotoReorderTimer() {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
    }
}

/** 이전 세션이 finalize 없이 남은 경우(웹뷰 이슈) 다음 제스처에서 정리 */
function closeStalePhotoTouchDragIfAny() {
    if (isLongPressing) {
        finalizePhotoTouchDragGesture();
    }
}

/** @param touchIdForDoc 터치 폴백일 때만 넘김 → document touchend 캡처 연결. 포인터 캡처 경로는 생략. */
function beginPhotoReorderDragSession(item, clientX, clientY, touchIdForDoc) {
    isLongPressing = true;
    const index = parseInt(item.dataset.index, 10);
    draggedIndex = index;
    draggedElement = item;
    dropIndex = index;
    photoTouchLastClientX = clientX;
    photoTouchLastClientY = clientY;
    if (touchIdForDoc !== undefined) {
        photoTouchDragTouchId = touchIdForDoc;
        attachPhotoTouchDocEnd();
    } else {
        photoTouchDragTouchId = null;
    }
    item.classList.add('opacity-50', 'scale-110', 'z-50');
    item.style.transition = 'transform 0.2s';
    lockPhotoDragScrollRow(item);
    beginPhotoTouchDragSelectGuard();
    try {
        window.getSelection()?.removeAllRanges();
    } catch (_) { /* ignore */ }
    if (navigator.vibrate) {
        navigator.vibrate(50);
    }
}

/**
 * @param {boolean} usePointerCapturePath - true면 Pointer Events + setPointerCapture (권장). false면 터치 전용 폴백.
 */
function setupLongPressDrag(item, usePointerCapturePath) {
    const LONG_PRESS_DURATION = 300; // 300ms

    if (usePointerCapturePath) {
        let pendingPointerId = null;

        item.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            if (e.target.closest('.photo-edit-btn') || e.target.closest('.photo-remove-btn')) {
                return;
            }

            abortPendingPhotoReorderTimer();
            closeStalePhotoTouchDragIfAny();

            pendingPointerId = e.pointerId;
            photoTouchLastClientX = e.clientX;
            photoTouchLastClientY = e.clientY;

            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                const index = parseInt(item.dataset.index, 10);
                if (Number.isNaN(index)) return;

                beginPhotoReorderDragSession(
                    item,
                    photoTouchLastClientX,
                    photoTouchLastClientY
                );
                photoReorderCapturedPointerId = pendingPointerId;
                try {
                    item.setPointerCapture(photoReorderCapturedPointerId);
                } catch (_) { /* ignore */ }
                schedulePhotoReorderLayoutSync();
            }, LONG_PRESS_DURATION);
        }, { passive: true });

        item.addEventListener('pointermove', (e) => {
            if (e.pointerType === 'mouse') return;
            if (pendingPointerId != null && e.pointerId !== pendingPointerId) return;

            if (longPressTimer && !isLongPressing) {
                photoTouchLastClientX = e.clientX;
                photoTouchLastClientY = e.clientY;
                return;
            }

            if (!isLongPressing || draggedElement !== item) return;
            if (
                photoReorderCapturedPointerId != null &&
                e.pointerId !== photoReorderCapturedPointerId
            ) {
                return;
            }
            e.preventDefault();
            try {
                window.getSelection()?.removeAllRanges();
            } catch (_) { /* ignore */ }
            photoTouchLastClientX = e.clientX;
            photoTouchLastClientY = e.clientY;
            applyPhotoTouchReorderMoveFromCoords();
        }, { passive: false });

        const onPointerEnd = (e) => {
            if (longPressTimer && e.pointerId === pendingPointerId) {
                abortPendingPhotoReorderTimer();
            }
            if (!isLongPressing) {
                if (e.pointerId === pendingPointerId) {
                    pendingPointerId = null;
                }
                return;
            }
            if (
                photoReorderCapturedPointerId != null &&
                e.pointerId !== photoReorderCapturedPointerId
            ) {
                return;
            }
            scheduleFinalizePhotoTouchDrag();
            pendingPointerId = null;
        };

        item.addEventListener('pointerup', onPointerEnd, { passive: true });
        item.addEventListener('pointercancel', onPointerEnd, { passive: true });
        return;
    }

    let pendingTouchId = null;

    item.addEventListener('touchstart', (e) => {
        if (e.target.closest('.photo-edit-btn') || e.target.closest('.photo-remove-btn')) {
            return;
        }

        abortPendingPhotoReorderTimer();
        closeStalePhotoTouchDragIfAny();

        const tid = e.changedTouches[0]?.identifier;
        if (tid === undefined) return;

        pendingTouchId = tid;
        photoTouchLastClientX = e.changedTouches[0].clientX;
        photoTouchLastClientY = e.changedTouches[0].clientY;

        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            const index = parseInt(item.dataset.index, 10);
            if (Number.isNaN(index)) return;

            beginPhotoReorderDragSession(
                item,
                photoTouchLastClientX,
                photoTouchLastClientY,
                tid
            );
            schedulePhotoReorderLayoutSync();
        }, LONG_PRESS_DURATION);
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        if (longPressTimer && !isLongPressing && touch && pendingTouchId != null) {
            if (touch.identifier === pendingTouchId) {
                photoTouchLastClientX = touch.clientX;
                photoTouchLastClientY = touch.clientY;
            }
            return;
        }

        if (!isLongPressing || !draggedElement) return;
        if (!touch) return;

        e.preventDefault();
        try {
            window.getSelection()?.removeAllRanges();
        } catch (_) { /* ignore */ }
        const touchX = touch.clientX;
        const touchY = touch.clientY;
        photoTouchLastClientX = touchX;
        photoTouchLastClientY = touchY;
        applyPhotoTouchReorderMoveFromCoords();
    }, { passive: false });

    item.addEventListener('touchend', (e) => {
        abortPendingPhotoReorderTimer();
        if (changedTouchesIncludesId(e, pendingTouchId)) {
            pendingTouchId = null;
        }
        if (!isLongPressing) return;
        if (changedTouchesIncludesId(e, photoTouchDragTouchId)) {
            scheduleFinalizePhotoTouchDrag();
        }
    }, { passive: true });

    item.addEventListener('touchcancel', (e) => {
        abortPendingPhotoReorderTimer();
        if (changedTouchesIncludesId(e, pendingTouchId)) {
            pendingTouchId = null;
        }
        if (!isLongPressing) return;
        if (changedTouchesIncludesId(e, photoTouchDragTouchId)) {
            scheduleFinalizePhotoTouchDrag();
        }
    }, { passive: true });
}

function handleDragStart(e) {
    draggedIndex = parseInt(e.currentTarget.dataset.index);
    draggedElement = e.currentTarget;
    dropIndex = draggedIndex;
    e.currentTarget.classList.add('opacity-50');
    e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.currentTarget.closest('.photo-preview-item');
    if (!target || target === draggedElement) return;
    
    const targetIndex = parseInt(target.dataset.index, 10);
    // draggedIndex는 드래그 시작 시점 인덱스로 고정됨. DOM 재배치 후에는 data-index만 최신이므로
    // stale한 draggedIndex와 targetIndex를 비교하면 잘못 스킵되어 순서가 반영되지 않음.
    const sourceIndex = draggedElement ? parseInt(draggedElement.dataset.index, 10) : NaN;
    if (draggedIndex === null || Number.isNaN(sourceIndex) || sourceIndex === targetIndex) return;
    
    dropIndex = targetIndex;
    const container = target.parentElement;
    
    // 시각적 피드백: DOM 위치 변경
    if (sourceIndex < targetIndex) {
        container.insertBefore(draggedElement, target.nextSibling);
    } else {
        container.insertBefore(draggedElement, target);
    }
    
    // 모든 아이템의 인덱스와 번호 업데이트 (시각적)
    const allItems = Array.from(container.querySelectorAll('.photo-preview-item'));
    allItems.forEach((item, idx) => {
        item.dataset.index = String(idx);
        const numberBadge = item.querySelector('.photo-preview-order-badge');
        if (numberBadge) {
            numberBadge.textContent = idx + 1;
        }
    });
}

function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDragEnd(e) {
    e.currentTarget.classList.remove('opacity-50');

    if (draggedElement?.parentElement) {
        commitPhotoOrderFromDom(draggedElement.parentElement);
    }

    draggedIndex = null;
    draggedElement = null;
    dropIndex = null;
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
                            <i class="fa-solid fa-xmark text-[10px]"></i>
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




