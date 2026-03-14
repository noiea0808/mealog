// 렌더링 관련 함수들
import { SLOTS, SLOT_STYLES, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';
import { escapeHtml, renderFormattedContent, getPlainTextPreview } from './render/utils.js';
import { normalizeUrl, getDisplayProfile, getProfileAvatarDisplay } from './utils.js';
import { getAdminDisplayName, getSharedPhotosByUser } from './db.js';

// renderGallery 실행 중 플래그 및 이벤트 리스너 관리
let isRenderingGallery = false;
let galleryScrollListeners = new Map(); // scrollContainer -> AbortController
let intersectionObserver = null; // Intersection Observer 인스턴스
let placeholderObserver = null; // Lazy Post Renderer의 Placeholder Observer
let galleryAbortController = null; // 현재 렌더링 작업의 AbortController
let loadedPostIds = new Set(); // 이미 로드한 포스트 ID 캐시
let postLoadQueue = []; // 포스트 로드 대기 큐
let postLoadBatchTimer = null; // 배치 처리 타이머
let previousGalleryPostIds = new Set(); // 이전 렌더링의 포스트 ID 목록 (diffing용)
const MAX_CONCURRENT_LOADS = 2; // 동시에 로드할 최대 포스트 수 (3에서 2로 감소)
const BATCH_DELAY = 200; // 배치 처리 지연 시간 (ms) (100에서 200으로 증가)

// renderTimeline과 renderMiniCalendar는 render/timeline.js로 이동됨

export function renderEntryChips() {
    const tags = window.userSettings?.tags;
    const subTags = window.userSettings?.subTags;
    
    // 설정이 없으면 기본값 사용
    if (!tags) {
        console.warn('userSettings.tags가 없습니다. 기본값을 사용합니다.');
        return;
    }
    
    // "???" 항목 제거 (기존 사용자 설정 정리)
    if (tags.mealType) {
        const index = tags.mealType.indexOf('???');
        if (index > -1) {
            tags.mealType.splice(index, 1);
        }
    }
    
    const renderPrimary = (id, list, inputId, subTagKey, subContainerId) => {
        const el = document.getElementById(id);
        if (!el || !list || list.length === 0) {
            if (el) el.innerHTML = '';
            return;
        }
        el.innerHTML = list.map(t => 
            `<button onclick="window.selectTag('${inputId}', '${t}', this, true, '${subTagKey}', '${subContainerId}')" class="chip">${t}</button>`
        ).join('');
    };
    
    window.renderSecondary = (id, list, inputId, parentFilter = null, subTagKey = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        let filteredList = list || [];
        // 메인 태그가 선택된 경우, 해당 메인 태그 아래에서만 사용한 서브 태그만 표시 (parent가 없는 항목은 제외)
        if (parentFilter) {
            filteredList = filteredList.filter(item => {
                const parent = typeof item === 'string' ? null : item.parent;
                return parent === parentFilter;
            });
        }
        
        // 메인 태그가 선택되지 않았을 때는 나만의 태그를 표시하지 않음
        const currentInputVal = document.getElementById(inputId)?.value || '';
        // 함께한 사람·메뉴 상세 태그는 다중 선택 가능(쉼표 구분)이므로 배열로 처리
        const isMultiSelect = id === 'peopleSuggestions' || id === 'menuSuggestions';
        const currentValues = isMultiSelect ? currentInputVal.split(',').map(v => v.trim()).filter(v => v) : [currentInputVal];
        
        if (!parentFilter) {
            // 메인 태그가 선택되지 않았을 때는 아무것도 표시하지 않음
            el.innerHTML = '';
            return;
        }
        
        // 메인 태그가 선택되었을 때만 나만의 태그 표시 (간식 어디서는 snackPlace 사용)
        const mainTagKeyMap = {
            'place': 'mealType',
            'menu': 'category',
            'people': 'withWhom',
            'snack': 'snackType'
        };
        const mainTagKey = (subTagKey === 'place' && id === 'snackPlaceSuggestions') ? 'snackPlace' : mainTagKeyMap[subTagKey];
        const favoriteSubTags = window.userSettings?.favoriteSubTags?.[mainTagKey] || {};
        const myTags = favoriteSubTags[parentFilter] || [];
        
        // 나만의 태그와 최근 태그 분리
        const myTagsSet = new Set(myTags);
        const myTagsList = [];
        const recentTagsList = [];
        
        filteredList.forEach(item => {
            const text = typeof item === 'string' ? item : item.text;
            if (myTagsSet.has(text)) {
                myTagsList.push(item);
            } else {
                recentTagsList.push(item);
            }
        });
        // 나만의 태그 중 subTags(최근 사용)에 아직 없는 것도 칩으로 표시
        myTags.forEach(text => {
            const alreadyIn = filteredList.some(item => (typeof item === 'string' ? item : item.text) === text);
            if (!alreadyIn) {
                myTagsList.push({ text });
            }
        });
        
        // 나만의 태그를 인덱스 순서대로 정렬
        myTagsList.sort((a, b) => {
            const textA = typeof a === 'string' ? a : a.text;
            const textB = typeof b === 'string' ? b : b.text;
            const indexA = myTags.indexOf(textA);
            const indexB = myTags.indexOf(textB);
            return indexA - indexB;
        });
        
        // 최근 태그는 역순으로 정렬 (최근 사용한 태그가 왼쪽에). 간식 어디서는 관리자 배열 순서 유지
        if (id !== 'snackPlaceSuggestions') recentTagsList.reverse();
        
        // 나만의 태그 + 최근 태그 순서로 합치기
        const sortedList = [...myTagsList, ...recentTagsList];
        
        if (sortedList.length === 0 && myTags.length === 0) {
            el.innerHTML = `<span class="text-[10px] text-slate-300 py-1 px-2">추천 태그 없음</span>`;
        } else {
            let html = '';
            
            // 나만의 태그와 최근 태그 모두 표시
            // 간식 어디서: 관리자 강제 태그만 표시, 기록 화면에서는 삭제 불가
            const isSnackPlace = id === 'snackPlaceSuggestions';
            html += sortedList.map(t => {
                const text = typeof t === 'string' ? t : t.text;
                const isActive = isMultiSelect ? (currentValues.includes(text) ? 'active' : '') : (currentInputVal === text ? 'active' : '');
                const isMyTag = myTagsSet.has(text);
                // 나만의 태그는 삭제 불가, 간식 어디서는 관리자 강제만이라 모두 삭제 불가
                const canDelete = !isSnackPlace && !isMyTag;
                // 최근 태그도 나만의 태그와 동일한 크기로
                const tagClass = isMyTag 
                    ? 'bg-emerald-100 border border-emerald-400 text-emerald-700 font-bold text-xs' 
                    : 'border border-slate-400 text-slate-600 font-bold text-xs';
                return `<span class="sub-chip-wrapper relative inline-block mr-1 mb-1 group">
                    <button onclick="window.selectTag('${inputId}', '${text}', this, false, '${subTagKey}', '${id}')" class="sub-chip ${isActive} ${tagClass} ${canDelete ? 'pr-7' : ''}">${text}${isMyTag ? ' <i class="fa-solid fa-star text-[9px] text-emerald-600"></i>' : ''}</button>
                    ${canDelete ? `<button onclick="event.stopPropagation(); window.deleteSubTag('${subTagKey}', '${text}', '${id}', '${inputId}', '${parentFilter}')" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-600 hover:text-red-500 w-4 h-4 flex items-center justify-center rounded-full active:bg-slate-200 transition-colors">
                        <i class="fa-solid fa-xmark"></i>
                    </button>` : ''}
                </span>`;
            }).join('');
            
            el.innerHTML = html;
        }
    };
    
    renderPrimary('typeChips', tags.mealType, 'null', 'place', 'restaurantSuggestions');
    window.renderSecondary('restaurantSuggestions', subTags?.place || [], 'placeInput', null, 'place');
    renderPrimary('categoryChips', tags.category, 'null', 'menu', 'menuSuggestions');
    window.renderSecondary('menuSuggestions', subTags?.menu || [], 'menuDetailInput', null, 'menu');
    renderPrimary('withChips', tags.withWhom, 'null', 'people', 'peopleSuggestions');
    window.renderSecondary('peopleSuggestions', subTags?.people || [], 'withWhomInput', null, 'people');
    
    // 간식 어디서: 관리자 메인태그 순서대로 칩 표시 (선택 시 개별 태그는 selectTag에서 renderSecondary 호출)
    const snackPlaceMain = tags.snackPlaceMain || ['집', '사무실', '카페'];
    renderPrimary('snackPlaceTypeChips', snackPlaceMain, 'null', 'place', 'snackPlaceSuggestions');
    window.renderSecondary('snackPlaceSuggestions', subTags?.place || [], 'snackPlaceInput', null, 'place');
    // 간식 무엇을
    const snackTypes = tags.snackType || ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
    renderPrimary('snackTypeChips', snackTypes, 'null', 'snack', 'snackSuggestions');
    window.renderSecondary('snackSuggestions', subTags?.snack || [], 'snackDetailInput', null, 'snack');
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
            `<div class="relative rounded-xl overflow-hidden bg-slate-100 flex-shrink-0 photo-preview-item border-2 border-slate-300" style="width: 7rem; aspect-ratio: ${aspectCss};" draggable="true" data-index="${idx}">
                <img src="${src}" class="absolute inset-0 w-full h-full object-cover" alt="">
                <button onclick="window.removePhoto(${idx})" class="photo-remove-btn">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <button onclick="window.editPhoto(${idx})" class="photo-edit-btn">
                    <i class="fa-solid fa-crop"></i>
                </button>
                <div class="absolute bottom-1 left-1 w-5 h-5 bg-black/60 text-white text-[10px] font-bold rounded-full flex items-center justify-center">${idx + 1}</div>
            </div>`
        ).join('');
        
        // 드래그 앤 드롭 이벤트 리스너 추가 (long press 지원)
        const photoItems = container.querySelectorAll('.photo-preview-item');
        photoItems.forEach(item => {
            // 기존 드래그 앤 드롭 (데스크톱)
            item.addEventListener('dragstart', handleDragStart);
            item.addEventListener('dragover', handleDragOver);
            item.addEventListener('drop', handleDrop);
            item.addEventListener('dragend', handleDragEnd);
            
            // 롱터치 시 컨텍스트 메뉴 방지
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
            });
            
            // Long press to drag (모바일/터치)
            setupLongPressDrag(item);
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

// Long press to drag (터치 디바이스 지원)
let longPressTimer = null;
let isLongPressing = false;
let touchStartY = null;
let originalDragIndex = null; // 터치 종료 시 splice용 원본 인덱스

function setupLongPressDrag(item) {
    const LONG_PRESS_DURATION = 300; // 300ms
    
    // 터치 시작
    item.addEventListener('touchstart', (e) => {
        // 편집 버튼이나 삭제 버튼 클릭 시 무시
        if (e.target.closest('.photo-edit-btn') || e.target.closest('.photo-remove-btn')) {
            return;
        }
        
        isLongPressing = false;
        touchStartY = e.touches[0].clientY;
        
        longPressTimer = setTimeout(() => {
            isLongPressing = true;
            const index = parseInt(item.dataset.index);
            
            // 드래그 시작
            originalDragIndex = index;
            draggedIndex = index;
            draggedElement = item;
            dropIndex = index;
            
            item.classList.add('opacity-50', 'scale-110', 'z-50');
            item.style.transition = 'transform 0.2s';
            
            // 햅틱 피드백 (지원되는 경우)
            if (navigator.vibrate) {
                navigator.vibrate(50);
            }
        }, LONG_PRESS_DURATION);
    }, { passive: true });
    
    // 터치 이동 (사진은 가로 배치이므로 X축 기준으로 가장 가까운 아이템 찾기)
    item.addEventListener('touchmove', (e) => {
        if (!isLongPressing || !draggedElement) return;
        
        e.preventDefault();
        const touchX = e.touches[0].clientX;
        const container = item.parentElement;
        const allItems = Array.from(container.querySelectorAll('.photo-preview-item'));
        
        // 가장 가까운 아이템 찾기 (가로 배치이므로 X축 중심 기준)
        let closestItem = null;
        let closestDistance = Infinity;
        
        allItems.forEach(otherItem => {
            if (otherItem === draggedElement) return;
            
            const rect = otherItem.getBoundingClientRect();
            const itemCenterX = rect.left + rect.width / 2;
            const distance = Math.abs(touchX - itemCenterX);
            
            if (distance < closestDistance) {
                closestDistance = distance;
                closestItem = otherItem;
            }
        });
        
        if (closestItem) {
            const targetIndex = parseInt(closestItem.dataset.index);
            const rect = closestItem.getBoundingClientRect();
            const itemCenterX = rect.left + rect.width / 2;
            const swapThreshold = rect.width * 0.1; // 아이템 너비의 10% 넘어가면 스왑 (충분히 부드러운 반응)
            
            if (draggedIndex !== null && draggedIndex !== targetIndex) {
                // 스왑 임계값: 터치가 대상 아이템 중심을 충분히 넘어갔을 때만 스왑
                const pastCenter = (draggedIndex < targetIndex && touchX > itemCenterX + swapThreshold) ||
                    (draggedIndex > targetIndex && touchX < itemCenterX - swapThreshold);
                if (!pastCenter) return;
                
                dropIndex = targetIndex;
                
                // 시각적 피드백: DOM 위치 변경
                if (draggedIndex < targetIndex) {
                    container.insertBefore(draggedElement, closestItem.nextSibling);
                } else {
                    container.insertBefore(draggedElement, closestItem);
                }
                
                // 모든 아이템의 인덱스와 번호 업데이트
                const updatedItems = Array.from(container.querySelectorAll('.photo-preview-item'));
                updatedItems.forEach((updatedItem, idx) => {
                    updatedItem.dataset.index = idx;
                    const numberBadge = updatedItem.querySelector('.absolute.bottom-1');
                    if (numberBadge) {
                        numberBadge.textContent = idx + 1;
                    }
                });
                draggedIndex = targetIndex; // 스왑 후 갱신 (즉시 되돌아가는 현상 방지)
            }
        }
    }, { passive: false });
    
    // 터치 종료
    item.addEventListener('touchend', (e) => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        
        if (isLongPressing && originalDragIndex !== null && dropIndex !== null && originalDragIndex !== dropIndex) {
            // 순서 업데이트 (originalDragIndex: 원본 위치, dropIndex: 최종 위치)
            const reorderedPhotos = [...appState.currentPhotos];
            const [movedPhoto] = reorderedPhotos.splice(originalDragIndex, 1);
            reorderedPhotos.splice(dropIndex, 0, movedPhoto);
            appState.currentPhotos = reorderedPhotos;
            // 상태 반영을 위해 전체 재렌더 (DOM·버튼 인덱스 동기화 보장)
            renderPhotoPreviews();
        }
        
        // 상태 초기화
        if (draggedElement) {
            draggedElement.classList.remove('opacity-50', 'scale-110', 'z-50');
            draggedElement.style.transition = '';
        }
        
        isLongPressing = false;
        originalDragIndex = null;
        draggedIndex = null;
        draggedElement = null;
        dropIndex = null;
        touchStartY = null;
    }, { passive: true });
    
    // 터치 취소
    item.addEventListener('touchcancel', () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
        
        if (draggedElement) {
            draggedElement.classList.remove('opacity-50', 'scale-110', 'z-50');
            draggedElement.style.transition = '';
        }
        
        isLongPressing = false;
        originalDragIndex = null;
        draggedIndex = null;
        draggedElement = null;
        dropIndex = null;
        touchStartY = null;
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
    
    const targetIndex = parseInt(target.dataset.index);
    if (draggedIndex === null || draggedIndex === targetIndex) return;
    
    dropIndex = targetIndex;
    const container = target.parentElement;
    
    // 시각적 피드백: DOM 위치 변경
    if (draggedIndex < targetIndex) {
        container.insertBefore(draggedElement, target.nextSibling);
    } else {
        container.insertBefore(draggedElement, target);
    }
    
    // 모든 아이템의 인덱스와 번호 업데이트 (시각적)
    const allItems = Array.from(container.querySelectorAll('.photo-preview-item'));
    allItems.forEach((item, idx) => {
        item.dataset.index = idx;
        const numberBadge = item.querySelector('.absolute.bottom-1');
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
    
    // 드래그가 실제로 끝났을 때 순서 업데이트
    if (draggedIndex !== null && dropIndex !== null && draggedIndex !== dropIndex) {
        const reorderedPhotos = [...appState.currentPhotos];
        const [movedPhoto] = reorderedPhotos.splice(draggedIndex, 1);
        reorderedPhotos.splice(dropIndex, 0, movedPhoto);
        appState.currentPhotos = reorderedPhotos;
        // 상태 반영을 위해 전체 재렌더 (DOM·버튼 인덱스 동기화 보장)
        renderPhotoPreviews();
    }
    
    draggedIndex = null;
    draggedElement = null;
    dropIndex = null;
}

// entryId가 실제로 공유되었는지 확인하는 헬퍼 함수
// record: meal 문서 (sharedPhotos 필드). sharedPhotos 컬렉션과 meal 문서 불일치 시 meal 문서 우선
function isEntryShared(entryId, record) {
    if (!entryId) return false;
    if (record && record.sharedPhotos && Array.isArray(record.sharedPhotos) && record.sharedPhotos.length > 0) return true;
    if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        return window.sharedPhotos.some(photo => photo.entryId === entryId);
    }
    return false;
}

// renderTimeline과 renderMiniCalendar는 render/timeline.js로 이동됨
// 이 함수들은 더 이상 render.js에 없음
function renderTimeline() {
    const state = appState;
    if (!window.currentUser || state.currentTab !== 'timeline') return;
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    
    // 오늘 날짜를 명확하게 계산 (시간대 문제 방지)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // 로컬 날짜로 변환하여 시간대 문제 방지
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    const targetDates = [];
    if (state.viewMode === 'list') {
        // 초기 로드 시 오늘 날짜를 무조건 첫 번째로 추가
        if (window.loadedDates.length === 0) {
            targetDates.push(todayStr);
        } else if (!window.loadedDates.includes(todayStr)) {
            // 오늘 날짜가 아직 로드되지 않았다면 추가
            targetDates.push(todayStr);
        }
        
        // 이미 로드된 과거 날짜 수를 계산 (오늘 날짜 제외)
        const pastLoadedDates = window.loadedDates.filter(d => d < todayStr);
        const pastLoadedCount = pastLoadedDates.length;
        
        // 과거 날짜를 순차적으로 추가 (어제부터 시작)
        for (let i = 1; i <= 5; i++) {
            const dayOffset = pastLoadedCount + i;
            const d = new Date(today);
            d.setDate(d.getDate() - dayOffset);
            // 로컬 날짜로 변환하여 시간대 문제 방지
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            // 과거 날짜만 추가하고 중복 체크
            if (dateStr < todayStr && !window.loadedDates.includes(dateStr) && !targetDates.includes(dateStr)) {
                targetDates.push(dateStr);
            }
        }
        
    } else {
        // page 모드: 선택한 날짜만 표시 (로컬 날짜로 변환)
        const pageYear = state.pageDate.getFullYear();
        const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
        const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
        targetDates.push(`${pageYear}-${pageMonth}-${pageDay}`);
    }

    // 날짜를 최신순으로 정렬하여 DOM에 추가 (최신 -> 과거)
    let sortedTargetDates = [...targetDates].sort((a, b) => b.localeCompare(a));
    
    // 오늘 날짜가 있으면 항상 맨 앞에 위치하도록 보장
    if (state.viewMode === 'list' && sortedTargetDates.includes(todayStr)) {
        sortedTargetDates = sortedTargetDates.filter(d => d !== todayStr);
        sortedTargetDates.unshift(todayStr);
    } else if (state.viewMode === 'list' && !window.loadedDates.includes(todayStr) && !sortedTargetDates.includes(todayStr)) {
        // 오늘 날짜가 아직 추가되지 않았다면 강제로 맨 앞에 추가
        sortedTargetDates.unshift(todayStr);
    }
    
    sortedTargetDates.forEach(dateStr => {
        // 일간보기 모드에서는 기존 섹션이 있어도 공유 버튼만 업데이트
        const existingSection = document.getElementById(`date-${dateStr}`);
        if (existingSection && state.viewMode === 'page') {
            // 공유 버튼만 업데이트
            const headerEl = existingSection.querySelector('.date-section-header');
            if (headerEl) {
                const dailyShare = window.sharedPhotos && Array.isArray(window.sharedPhotos) 
                    ? window.sharedPhotos.find(photo => 
                        photo.type === 'daily' && 
                        photo.date === dateStr && 
                        photo.userId === window.currentUser?.uid
                    )
                    : null;
                const isShared = !!dailyShare;
                
                const shareButton = `<button onclick="window.shareDailySummary('${dateStr}')" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-slate-800 text-white' : 'text-slate-600'}">
                    <i class="fa-solid fa-share text-[12px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
                </button>`;
                
                const h3El = headerEl.querySelector('h3');
                if (h3El) {
                    headerEl.innerHTML = h3El.outerHTML + shareButton;
                }
            }
            return;
        }
        
        // 이미 로드된 날짜이거나 DOM에 이미 존재하는 경우 건너뛰기
        if (window.loadedDates.includes(dateStr)) return;
        if (existingSection) return;
        
        window.loadedDates.push(dateStr);
        const dObj = new Date(dateStr + 'T00:00:00');
        const dayOfWeek = dObj.getDay();
        let dayColorClass = (dayOfWeek === 0 || dayOfWeek === 6) ? "text-rose-400" : "text-slate-800";
        const section = document.createElement('div');
        section.id = `date-${dateStr}`;
        section.className = "animate-fade";
        // 일간보기 모드일 때만 공유 버튼 추가
        let shareButton = '';
        if (state.viewMode === 'page') {
            // 공유 상태 확인
            const dailyShare = window.sharedPhotos && Array.isArray(window.sharedPhotos) 
                ? window.sharedPhotos.find(photo => photo.type === 'daily' && photo.date === dateStr)
                : null;
            const isShared = !!dailyShare;
            
            shareButton = `<button onclick="window.shareDailySummary('${dateStr}')" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-slate-800 text-white' : 'text-slate-600'}">
                <i class="fa-solid fa-share text-[12px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
            </button>`;
        }
        let html = `<div class="date-section-header text-sm font-black ${dayColorClass} mb-1.5 px-4 flex items-center justify-between">
            <h3>${dObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}</h3>
            ${shareButton}
        </div>`;

        SLOTS.forEach(slot => {
            const records = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
            if (slot.type === 'main') {
                const r = records[0];
                const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                let containerClass = r ? 'border-slate-200' : 'border-slate-200 opacity-80';
                let titleClass = r ? 'text-slate-800' : 'text-slate-300';
                let iconBoxClass = `bg-slate-100 border-slate-200 ${specificStyle.iconText}`;
                const safeSlotLabel = escapeHtml(slot.label);
                let titleLine1 = '';
                let titleLine2 = '';
                let tagsHtml = '';
                if (r) {
                    if (r.mealType === 'Skip') {
                        titleLine1 = 'Skip';
                    } else {
                        const p = r.place || '';
                        const m = r.menuDetail || r.category || '';
                        // 첫 번째 줄: "아침 @ 장소" 형식 (아침/점심/저녁 텍스트 색상 적용, @부터 회색)
                        const safePlace = escapeHtml(p);
                        if (p) {
                            titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span> <span class="text-xs font-bold text-slate-400">@ ${safePlace}</span>`;
                        } else {
                            titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span>`;
                        }
                        // 두 번째 줄: 메뉴
                        titleLine2 = escapeHtml(m || '');
                        const tags = [];
                        if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
                        if (r.withWhomDetail) tags.push(r.withWhomDetail);
                        else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
                        if (r.satiety) {
                            const sData = SATIETY_DATA.find(d => d.val === r.satiety);
                            if (sData) tags.push(sData.label);
                        }
                        if (tags.length > 0) {
                            tagsHtml = `<div class="mt-1 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags.map(t => 
                                `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${t}</span>`
                            ).join('')}</div>`;
                        }
                    }
                } else {
                    // 기록되지 않은 카드에도 끼니 표시
                    titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span>`;
                    titleLine2 = '<span class="text-xs text-slate-400">기록하기</span>';
                }
                let iconHtml = '';
                if (!r) {
                    iconHtml = `<div class="flex flex-col items-center justify-center text-center px-2">
                        <span class="text-3xl font-bold text-slate-400 mb-1">+</span>
                        <span class="text-[10px] text-slate-400 leading-tight">입력해주세요</span>
                    </div>`;
                } else if (r.photos && Array.isArray(r.photos) && r.photos[0]) {
                    iconHtml = `<img src="${r.photos[0]}" class="w-full h-full object-cover">`;
                } else if (r.photos && !Array.isArray(r.photos)) {
                    // photos가 배열이 아닌 경우 (문자열 등) 처리
                    iconHtml = `<img src="${r.photos}" class="w-full h-full object-cover">`;
                } else if (r.mealType === 'Skip') {
                    iconHtml = `<i class="fa-solid fa-ban text-2xl text-slate-600"></i>`;
                } else {
                    iconHtml = `<i class="fa-solid fa-utensils text-2xl text-slate-400"></i>`;
                }
                html += `<div onclick="window.openModal('${dateStr}', '${slot.id}', ${r ? `'${r.id}'` : null})" class="card mb-1.5 border ${containerClass} cursor-pointer active:scale-[0.98] transition-all !rounded-none">
                    <div class="flex">
                        <div class="w-[140px] h-[140px] ${iconBoxClass} flex-shrink-0 flex items-center justify-center overflow-hidden border-r">
                            ${iconHtml}
                        </div>
                        <div class="flex-1 min-w-0 flex flex-col justify-center p-4">
                            <div class="flex justify-between items-start mb-1">
                                <div class="flex-1">
                                    <h4 class="leading-tight mb-0 truncate">${titleLine1}</h4>
                                    ${titleLine2 ? (r ? `<p class="text-sm text-slate-600 font-bold mt-0.5 mb-0 truncate">${titleLine2}</p>` : `<p class="mt-0.5 mb-0 truncate">${titleLine2}</p>`) : ''}
                                </div>
                                ${r ? `<div class="flex items-center gap-2 flex-shrink-0 ml-2">
                                    ${isEntryShared(r.id, r) ? `<span class="text-xs text-emerald-600" title="공유됨"><i class="fa-solid fa-share"></i></span>` : ''}
                                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded-md flex items-center gap-0.5"><i class="fa-solid fa-star text-[10px]"></i><span class="text-[11px] font-black">${r.rating || '-'}</span></span>
                                </div>` : ''}
                            </div>
                            ${r && r.comment ? `<p class="text-xs text-slate-400 mt-1 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
                            ${tagsHtml}
                        </div>
                    </div>
                </div>`;
            } else {
                html += `<div class="snack-row mb-1.5 flex items-center">
                    <span class="text-xs font-black text-slate-400 uppercase mr-3 flex-shrink-0 px-4">${slot.label}</span>
                    <div class="flex-1 flex flex-wrap gap-2 items-center">
                        ${records.length > 0 ? records.map(r => 
                            `<div onclick="window.openModal('${dateStr}', '${slot.id}', '${r.id}')" class="snack-tag cursor-pointer active:bg-slate-50">
                                <span class="w-1.5 h-1.5 rounded-full bg-slate-400 mr-2"></span>
                                ${r.menuDetail || r.snackType || '간식'} 
                                ${isEntryShared(r.id, r) ? `<i class="fa-solid fa-share text-slate-500 text-[8px] ml-1" title="공유됨"></i>` : ''}
                                ${r.rating ? `<span class="text-[10px] font-black text-yellow-600 bg-yellow-50 px-1 py-0.5 rounded ml-1.5 flex items-center gap-0.5"><i class="fa-solid fa-star text-[9px]"></i>${r.rating}</span>` : ''}
                            </div>`
                        ).join('') : `<span class="text-xs text-slate-400 italic">기록없음</span>`}
                        <button onclick="window.openModal('${dateStr}', '${slot.id}')" class="text-xs font-bold text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200 transition-colors">+ 추가</button>
                    </div>
                </div>`;
            }
        });
        section.innerHTML = html;
        container.appendChild(section);
    });
    
    // 일간보기 모드일 때 하루 전체 Comment 입력 영역 추가
    if (state.viewMode === 'page' && sortedTargetDates.length > 0) {
        const currentDateStr = sortedTargetDates[0]; // 일간보기는 하나의 날짜만 표시
        const existingCommentSection = document.getElementById('dailyCommentSection');
        if (existingCommentSection) {
            existingCommentSection.remove();
        }
        
        const commentSection = document.createElement('div');
        commentSection.id = 'dailyCommentSection';
        commentSection.className = 'card mb-1.5 border border-slate-200 !rounded-none';
        
        // getDailyComment 함수가 있으면 사용, 없으면 빈 문자열
        let currentComment = '';
        try {
            if (window.dbOps && typeof window.dbOps.getDailyComment === 'function') {
                currentComment = window.dbOps.getDailyComment(currentDateStr) || '';
            } else if (window.userSettings && window.userSettings.dailyComments) {
                currentComment = window.userSettings.dailyComments[currentDateStr] || '';
            }
        } catch (e) {
            console.warn('getDailyComment 호출 실패:', e);
            currentComment = '';
        }
        
        commentSection.innerHTML = `
            <div class="p-4">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-extrabold text-slate-600 block uppercase">하루 소감</span>
                    <button onclick="window.saveDailyComment('${currentDateStr}')" 
                        class="text-xs text-slate-600 font-bold px-3 py-1.5 active:text-slate-700 transition-colors">
                        저장
                    </button>
                </div>
                <textarea id="dailyCommentInput" placeholder="오늘 하루는 어떠셨나요? 하루 전체에 대한 생각을 기록해보세요." 
                    class="w-full p-3 bg-slate-50 rounded-2xl text-sm border border-transparent focus:border-slate-400 transition-all resize-none min-h-[100px]" 
                    rows="4">${escapeHtml(currentComment)}</textarea>
            </div>
        `;
        
        container.appendChild(commentSection);
    } else {
        // 일간보기가 아닐 때는 Comment 영역 제거
        const existingCommentSection = document.getElementById('dailyCommentSection');
        if (existingCommentSection) {
            existingCommentSection.remove();
        }
    }
    
    // 최근 날짜(오늘)로 스크롤 (초기 로드 시에만)
    if (state.viewMode === 'list' && sortedTargetDates.length > 0 && !window.hasScrolledToToday) {
        const todaySection = document.getElementById(`date-${todayStr}`);
        if (todaySection) {
            setTimeout(() => {
                const trackerSection = document.getElementById('trackerSection');
                const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                const headerHeight = 73;
                const totalOffset = headerHeight + trackerHeight;
                const elementTop = todaySection.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementTop - totalOffset - 16;
                window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                window.hasScrolledToToday = true;
            }, 300);
        }
    }
    
    // 더보기 버튼 추가 (list 모드일 때만)
    if (state.viewMode === 'list' && window.loadedMealsDateRange) {
        // 가장 오래된 날짜 확인
        const oldestDate = window.mealHistory.length > 0 
            ? window.mealHistory[window.mealHistory.length - 1]?.date 
            : null;
        
        // 로드된 범위의 시작 날짜보다 오래된 데이터가 있으면 더보기 버튼 표시
        if (oldestDate && oldestDate >= window.loadedMealsDateRange.start) {
            // 더보기 버튼이 이미 있으면 제거
            const existingBtn = document.getElementById('loadMoreMealsBtn');
            if (existingBtn) existingBtn.remove();
            
            const loadMoreBtn = document.createElement('div');
            loadMoreBtn.id = 'loadMoreMealsBtn';
            loadMoreBtn.className = 'flex justify-center py-6';
            loadMoreBtn.innerHTML = `
                <button onclick="window.loadMoreMealsTimeline()" 
                        class="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-sm font-bold 
                               active:bg-slate-300 transition-colors flex items-center gap-2">
                    <i class="fa-solid fa-chevron-down"></i>
                    <span>더보기</span>
                </button>
            `;
            container.appendChild(loadMoreBtn);
        } else {
            // 더 이상 로드할 데이터가 없으면 버튼 제거
            const existingBtn = document.getElementById('loadMoreMealsBtn');
            if (existingBtn) existingBtn.remove();
        }
    }
}

// renderMiniCalendar는 render/timeline.js로 이동됨
// 이 함수는 더 이상 render.js에 없음

// 포스트 로드 배치 처리 함수
function processPostLoadQueue() {
    if (postLoadQueue.length === 0) {
        return;
    }
    
    // 최대 동시 로드 수만큼만 처리
    const toProcess = postLoadQueue.splice(0, MAX_CONCURRENT_LOADS);
    
    toProcess.forEach(({ postEl, postId }) => {
        // DOM이 여전히 존재하는지 확인
        if (!document.contains(postEl)) {
            return;
        }
        
        loadPostInteractions(postEl, postId).catch(err => {
            console.error(`포스트 ${postId} 상호작용 데이터 로드 실패:`, err);
            // 실패 시 캐시에서 제거하여 재시도 가능하게
            loadedPostIds.delete(postId);
        });
    });
    
    // 큐에 남은 항목이 있으면 다음 배치 예약
    if (postLoadQueue.length > 0) {
        postLoadBatchTimer = setTimeout(processPostLoadQueue, BATCH_DELAY);
    } else {
        postLoadBatchTimer = null;
    }
}

// 좋아요/북마크/댓글 데이터 로드 함수 (단일 포스트용 - Intersection Observer에서 호출)
async function loadPostInteractions(postEl, postId) {
    if (!window.postInteractions || !postEl || !postId) {
        return;
    }
    
    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
    
    // 로그인한 사용자는 좋아요/북마크 상태도 확인, 비로그인 사용자는 좋아요 수와 댓글만 가져오기
    const alternatePostIds = (postEl.getAttribute('data-post-id-alternates') || '').split(',').filter(Boolean);
    const promiseArray = [
        window.postInteractions.getLikes(postId).catch(e => {
            console.error(`좋아요 목록 가져오기 실패 (postId: ${postId}):`, e);
            return [];
        }),
        window.postInteractions.getComments(postId, alternatePostIds).catch(e => {
            console.error(`댓글 목록 가져오기 실패 (postId: ${postId}):`, e);
            return [];
        })
    ];
    
    // 로그인한 사용자만 좋아요/북마크 상태 확인
    if (isLoggedIn) {
        promiseArray.unshift(
            window.postInteractions.isLiked(postId, window.currentUser.uid).catch(e => {
                console.error(`좋아요 상태 확인 실패 (postId: ${postId}):`, e);
                return false;
            }),
            window.postInteractions.isBookmarked(postId, window.currentUser.uid).catch(e => {
                console.error(`북마크 상태 확인 실패 (postId: ${postId}):`, e);
                return false;
            })
        );
    }
    
    try {
        const results = await Promise.all(promiseArray);
        let isLiked = false;
        let isBookmarked = false;
        let likes = [];
        let comments = [];
        
        if (isLoggedIn) {
            [isLiked, isBookmarked, likes, comments] = results;
        } else {
            [likes, comments] = results;
        }
        
        // DOM이 여전히 존재하는지 확인
        if (!document.contains(postEl)) {
            return; // 포스트가 DOM에서 제거되었으면 업데이트하지 않음
        }
        
        // 로그인한 사용자만 좋아요/북마크 버튼 상태 업데이트
        if (isLoggedIn) {
            // 좋아요 버튼 업데이트
            const likeBtn = postEl.querySelector(`.post-like-btn[data-post-id="${postId}"]`);
            const likeIcon = likeBtn?.querySelector('.post-like-icon');
            if (likeBtn && likeIcon) {
                if (isLiked) {
                    likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800');
                    likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
                } else {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500');
                    likeIcon.classList.add('fa-regular', 'fa-heart', 'text-slate-800');
                }
            }
            
            // 북마크 버튼 업데이트
            const bookmarkBtn = postEl.querySelector(`.post-bookmark-btn[data-post-id="${postId}"]`);
            const bookmarkIcon = bookmarkBtn?.querySelector('.post-bookmark-icon');
            if (bookmarkBtn && bookmarkIcon) {
                if (isBookmarked) {
                    bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark');
                    bookmarkIcon.classList.add('fa-solid', 'fa-bookmark', 'text-slate-800');
                } else {
                    bookmarkIcon.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800');
                    bookmarkIcon.classList.add('fa-regular', 'fa-bookmark');
                }
            }
        }
        
        // 좋아요 수 업데이트
        const likeCountEl = postEl.querySelector(`.post-like-count[data-post-id="${postId}"]`);
        if (likeCountEl) {
            const likeCount = likes && Array.isArray(likes) ? likes.length : 0;
            likeCountEl.textContent = likeCount > 0 ? likeCount : '';
        }
        
        // 댓글 수 업데이트
        const commentCountEl = postEl.querySelector(`.post-comment-count[data-post-id="${postId}"]`);
        if (commentCountEl) {
            const commentCount = comments && Array.isArray(comments) ? comments.length : 0;
            commentCountEl.textContent = commentCount > 0 ? commentCount : '';
        }
        
        // 댓글 아이콘: 사용자가 댓글 단 경우 채우기 (fa-solid)
        const commentIcon = postEl.querySelector(`.post-comment-icon`);
        if (commentIcon && isLoggedIn && comments && Array.isArray(comments)) {
            const hasCommented = comments.some(c => (c.userId || c.authorId) === window.currentUser?.uid);
            if (hasCommented) {
                commentIcon.classList.remove('fa-regular');
                commentIcon.classList.add('fa-solid');
            } else {
                commentIcon.classList.remove('fa-solid');
                commentIcon.classList.add('fa-regular');
            }
        }
        
        // 댓글 표시 (최대 2개) — 등록 시간 포함
        const commentsListEl = postEl.querySelector(`.post-comments-list[data-post-id="${postId}"]`);
        if (commentsListEl) {
            const commentSection = postEl.querySelector(`#comment-section-${CSS.escape(postId)}`);
            if (comments.length > 0) {
                if (commentSection) commentSection.classList.remove('comments-empty');
                // 댓글 작성자들의 최신 프로필 로드
                const commentAuthorIds = [...new Set(comments.map(c => c.userId || c.authorId).filter(Boolean))];
                await fetchUserProfiles(commentAuthorIds);
                // 댓글 목록은 흰색 배경 유지 (앨범 스타일)
                const displayComments = comments.slice(0, 2);
                commentsListEl.innerHTML = displayComments.map(c => {
                    let dateStr = '', timeStr = '';
                    if (c.timestamp) {
                        try {
                            const commentDate = c.timestamp instanceof Date
                                ? c.timestamp
                                : (c.timestamp.toDate ? c.timestamp.toDate() : new Date(c.timestamp));
                            if (!isNaN(commentDate.getTime())) {
                                dateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                                timeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            }
                        } catch (_) {}
                    }
                    const commentDisplay = getDisplayProfile(c.userId, { nickname: c.userNickname });
                    return `
                    <div class="mb-1 text-sm">
                        <span class="font-bold text-slate-800">${commentDisplay.nickname}</span>
                        <span class="text-slate-800">${escapeHtml(c.comment)}</span>
                        ${dateStr && timeStr ? `<span class="text-xs text-slate-400 ml-2">${dateStr} ${timeStr}</span>` : ''}
                        ${isLoggedIn && c.userId === window.currentUser?.uid ? `<button onclick="window.deleteCommentFromPost('${c.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                    </div>
                `;
                }).join('');
                
                // 댓글이 2개보다 많으면 "댓글 모두 보기" 버튼 표시
                if (comments.length > 2) {
                    const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.remove('hidden');
                        viewCommentsBtn.textContent = `댓글 ${comments.length}개 모두 보기`;
                    }
                } else {
                    const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                    if (viewCommentsBtn) {
                        viewCommentsBtn.classList.add('hidden');
                    }
                }
            } else {
                commentsListEl.innerHTML = '';
                const viewCommentsBtn = postEl.querySelector(`#view-comments-${CSS.escape(postId)}`);
                if (viewCommentsBtn) {
                    viewCommentsBtn.classList.add('hidden');
                }
                if (commentSection) commentSection.classList.add('comments-empty');
            }
        } else {
            const commentSection = postEl.querySelector(`#comment-section-${CSS.escape(postId)}`);
            if (commentSection) commentSection.classList.add('comments-empty');
        }
    } catch (err) {
        console.error(`포스트 ${postId}의 좋아요/북마크/댓글 로드 실패:`, err);
        // 실패 시 캐시에서 제거하여 재시도 가능하게
        loadedPostIds.delete(postId);
    }
}

// photoGroup에서 postId 계산 (갤러리 흔적 필터 및 댓글/좋아요 일관된 키용)
// 모든 사용자가 동일한 postId를 보도록 entryId_userId 등 고정 키 사용 (첫 사진 문서 id 사용 시 사용자마다 달라져 댓글 미노출 문제 발생)
function getPostIdFromPhotoGroup(photoGroup) {
    const photo = photoGroup[0];
    if (!photo) return null;
    const isDailyShare = photo.type === 'daily';
    const isBestShare = photo.type === 'best';
    const isInsightShare = photo.type === 'insight';
    if (isDailyShare) return `daily_${photo.date || 'no-date'}_${photo.userId || 'unknown'}`;
    if (isBestShare) return `best_${photo.id || 'no-id'}_${photo.userId || 'unknown'}`;
    if (isInsightShare) return `insight_${(photo.dateRangeText || 'no-range').replace(/\s/g, '_')}_${photo.userId || 'unknown'}`;
    if (photo.entryId && photo.userId) return `${photo.entryId}_${photo.userId}`;
    let hash = 0;
    const groupKey = `${photo.entryId || 'no-entry'}_${photo.userId || 'unknown'}`;
    const ts = photo.timestamp || (photo.date ? photo.date + 'T12:00:00' : '') || '';
    const keyForHash = `${groupKey}_${ts}`;
    for (let i = 0; i < keyForHash.length; i++) {
        hash = ((hash << 5) - hash) + keyForHash.charCodeAt(i);
        hash = hash & hash;
    }
    return `post_${Math.abs(hash)}_${photo.userId || 'unknown'}`;
}

/** photos 배열을 그룹화·정렬하여 sortedGroups 반환 (appendGalleryPosts에서 재사용) */
function processPhotosToGroups(photos) {
    if (!photos || photos.length === 0) return [];
    const seen = new Set();
    const uniquePhotos = photos.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        let groupKey;
        if (photo.type === 'daily') groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        else if (photo.type === 'best') groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        else if (photo.type === 'insight') groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        else if (photo.entryId) groupKey = `${photo.entryId}_${photo.userId}`;
        else groupKey = `no-entry_${photo.userId}`;
        if (!groupedPhotos[groupKey]) groupedPhotos[groupKey] = [];
        groupedPhotos[groupKey].push(photo);
    });
    const photoSortTieBreaker = (a, b) => {
        const aKey = String(a.id ?? normalizeUrl(a.photoUrl) ?? '');
        const bKey = String(b.id ?? normalizeUrl(b.photoUrl) ?? '');
        return aKey.localeCompare(bKey, 'en');
    };
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        photoGroup.sort((a, b) => {
            const ai = a.photoIndex, bi = b.photoIndex;
            if (typeof ai === 'number' && typeof bi === 'number' && ai !== bi) return ai - bi;
            const ta = new Date(a.timestamp).getTime(), tb = new Date(b.timestamp).getTime();
            const cmp = ta - tb;
            return cmp !== 0 ? cmp : photoSortTieBreaker(a, b);
        });
    });
    const getTimestamp = (photo) => {
        if (!photo.timestamp) return 0;
        if (photo.timestamp instanceof Date) return photo.timestamp.getTime();
        if (typeof photo.timestamp === 'string') return new Date(photo.timestamp).getTime();
        if (photo.timestamp.toDate) return photo.timestamp.toDate().getTime();
        if (photo.timestamp.seconds) return photo.timestamp.seconds * 1000;
        return 0;
    };
    return Object.values(groupedPhotos).sort((a, b) => {
        const cmp = getTimestamp(b[0]) - getTimestamp(a[0]);
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
}

/** 포스트 그룹 HTML 생성 (appendGalleryPosts 및 renderGallery에서 공용) */
function renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap) {
    const photo = photoGroup[0];
    const photoCount = photoGroup.length;
    let entryId = photo.entryId;
    if (!entryId || entryId === '' || entryId === 'null') {
        const photoWithEntryId = photoGroup.find(p => p.entryId && p.entryId !== '' && p.entryId !== 'null');
        if (photoWithEntryId) entryId = photoWithEntryId.entryId;
    }
    const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
    const isGuestPost = isMyPost && window.currentUser && window.currentUser.isAnonymous;
    const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
    const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    const timeStr = photo.time || new Date(photo.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
    let mealLabel = '', mealLabelStyle = '';
    if (photo.slotId) {
        const slot = SLOTS.find(s => s.id === photo.slotId);
        mealLabel = slot ? slot.label : '';
        if (slot) {
            const slotStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            mealLabelStyle = `${slotStyle.text} ${slotStyle.iconBg}`;
        }
    }
    const isBestShare = photo.type === 'best';
    const isDailyShare = photo.type === 'daily';
    const isInsightShare = photo.type === 'insight';
    const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
    let comment = '';
    if (!isDailyShare) {
        if (photo.comment) comment = photo.comment;
        else if (entryId && mealHistoryMap && mealHistoryMap.has(entryId)) {
            const mealRecord = mealHistoryMap.get(entryId);
            if (mealRecord) comment = mealRecord.comment || '';
        }
        if (!entryId && window.mealHistory && photo.date && photo.slotId) {
            const matchingRecord = window.mealHistory.find(m =>
                m.date === photo.date && m.slotId === photo.slotId && (photo.comment ? (m.comment === photo.comment) : true));
            if (matchingRecord) {
                entryId = matchingRecord.id;
                if (!comment && matchingRecord.comment) comment = matchingRecord.comment;
            }
        }
    }
    let caption = '';
    if (isBestShare || isDailyShare || isInsightShare) {
        if (photo.comment) caption = photo.comment;
    } else if (isSnack) {
        const menu = photo.menuDetail || photo.snackType;
        if (photo.place && menu) caption = `<span>${escapeHtml(menu)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (menu) caption = `<span>${escapeHtml(menu)}</span>`;
        else caption = escapeHtml('간식');
    } else {
        if (photo.place && photo.menuDetail) caption = `<span>${escapeHtml(photo.menuDetail)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.menuDetail) caption = `<span>${escapeHtml(photo.menuDetail)}</span>`;
        else if (photo.mealType) caption = escapeHtml(photo.mealType);
    }
    const captionText = (() => {
        if (isBestShare || isDailyShare || isInsightShare) return (photo.comment || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (isSnack) {
            const m = photo.menuDetail || photo.snackType;
            return (photo.place && m) ? `${m} @ ${photo.place}` : (photo.place || m || '간식');
        }
        return (photo.place && photo.menuDetail) ? `${photo.menuDetail} @ ${photo.place}` : (photo.place || photo.menuDetail || photo.mealType || '');
    })();
    const captionAttr = (captionText || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let aspectRatio = photo.photoAspectRatio || (entryId && mealHistoryMap && mealHistoryMap.has(entryId) ? mealHistoryMap.get(entryId).photoAspectRatio : null) || '1:1';
    if (aspectRatio !== '1:1' && aspectRatio !== '3:4' && aspectRatio !== '4:3') aspectRatio = '1:1';
    const momentAspectCss = (aspectRatio === '3:4' ? '3/4' : aspectRatio === '4:3' ? '4/3' : '1');
    const photosHtml = photoGroup.map((p, idx) => {
        const isBest = p.type === 'best', isDaily = p.type === 'daily', isInsight = p.type === 'insight';
        return `
            <div class="flex-shrink-0 w-full snap-start ${(isBest || isDaily || isInsight) ? 'bg-white' : ''}" ${(isBest || isDaily || isInsight) ? 'style="display: flex; align-items: flex-start; justify-content: center;"' : ''}>
                ${(isBest || isDaily || isInsight) ? `<img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="w-full h-auto object-contain" style="display: block; width: 100%; height: auto; vertical-align: top;" loading="${idx <= 1 ? 'eager' : 'lazy'}">` : `<div class="w-full relative overflow-hidden" style="aspect-ratio: ${momentAspectCss};"><img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="absolute inset-0 w-full h-full object-cover" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`}
            </div>
        `;
    }).join('');
    const postId = getPostIdFromPhotoGroup(photoGroup);
    const groupKey = postId;
    const alternatePostIds = photoGroup.map(p => p.id).filter(Boolean).join(',');
    const userDisplay = getDisplayProfile(photo.userId, { nickname: photo.userNickname, icon: photo.userIcon, photoUrl: photo.userPhotoUrl });
    const avatarDisplay = getProfileAvatarDisplay(userDisplay);
    const hasBody = (caption && (isBestShare || isDailyShare || isInsightShare)) || (comment && !isBestShare && !isDailyShare && !isInsightShare);
    return `
            <div class="mb-2 bg-white border-b border-slate-200 instagram-post ${!hasBody ? 'post-no-body' : ''}" data-post-id="${postId}" data-post-id-alternates="${alternatePostIds}" data-group-key="${groupKey}">
                <div class="px-3 py-3 flex items-center gap-3 relative">
                    ${avatarDisplay.type === 'photo' ? `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden border-2 border-slate-300 relative" style="background-image: url(${avatarDisplay.value}); background-size: cover; background-position: center;">
                            ${isGuestPost ? '<span class="absolute bottom-0 right-0 bg-black/70 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center border border-white">게</span>' : ''}
                        </div>
                    ` : `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border-2 border-slate-300 ${avatarDisplay.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200 text-lg'}">
                            ${isGuestPost ? '게' : (avatarDisplay.type === 'default' ? '<i class="fa-solid fa-user text-lg"></i>' : escapeHtml(avatarDisplay.value))}
                        </div>
                    `}
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-bold text-slate-800 cursor-pointer hover:text-slate-600 transition-colors" onclick="window.filterGalleryByUser('${photo.userId}', '${escapeHtml(userDisplay.nickname)}')">${userDisplay.nickname}</div>
                        <div class="flex items-center gap-2">
                            <div class="text-xs text-slate-400">${dateStr}</div>
                            ${mealLabel ? `<div class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                        </div>
                    </div>
                    <div class="relative">
                        <button data-entry-id="${entryId || ''}" data-photo-urls="${(photoGroup.map(p => p.photoUrl).filter(Boolean).join(',') || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-caption="${captionAttr}" data-is-best="${isBestShare ? 'true' : 'false'}" data-is-daily="${isDailyShare ? 'true' : 'false'}" data-is-insight="${isInsightShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-date-range-text="${photo.dateRangeText || ''}" data-photo-slot-id="${photo.slotId || ''}" data-post-id="${postId || ''}" data-author-user-id="${photo.userId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                            <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                        </button>
                    </div>
                </div>
                <div class="relative overflow-hidden ${(isDailyShare || isInsightShare) ? 'bg-white' : 'bg-slate-100'}">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide gallery-photo-scroll" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute top-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${!isBestShare && !isDailyShare && !isInsightShare && caption ? (() => {
                    const firstPhotoUrl = photoGroup[0]?.photoUrl || '';
                    const urlForCss = firstPhotoUrl ? firstPhotoUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\/g, '\\\\').replace(/'/g, '\\27') : '';
                    return `
                <div class="gallery-caption-wrap">
                    <div class="gallery-caption-blur-bg"${urlForCss ? ` style="background-image: url('${urlForCss}');"` : ''} aria-hidden="true"></div>
                    <div class="gallery-caption-menu-place gallery-caption-blur px-6 py-1.5 text-white">${caption}</div>
                </div>
                `;
                })() : ''}
                <div class="feed-post-actions px-6 py-3">
                    <div class="feed-post-buttons flex items-center justify-between mb-2 pb-2 -mx-6 px-6 border-b border-slate-200">
                        <div class="flex items-center gap-4">
                            <button onclick="window.toggleLike('${postId}')" class="post-like-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-heart text-2xl text-slate-800 post-like-icon"></i>
                                <span class="post-like-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                            <button onclick="window.toggleCommentInput('${postId}')" class="post-comment-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-comment text-2xl text-slate-800 post-comment-icon"></i>
                                <span class="post-comment-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                        </div>
                        <button onclick="window.toggleBookmark('${postId}')" class="post-bookmark-btn active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                            <i class="fa-regular fa-bookmark text-2xl text-slate-800 post-bookmark-icon"></i>
                        </button>
                    </div>
                    ${caption && (isBestShare || isDailyShare || isInsightShare) ? `<div class="mb-2 text-sm text-slate-800">${caption}</div>` : ''}
                    ${comment && !isBestShare && !isDailyShare && !isInsightShare ? (() => {
                        const lineBreaks = (comment.match(/\n/g) || []).length;
                        const estimatedLines = Math.ceil(comment.length / 30);
                        const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
                        const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
                        return `
                        <div class="mb-2 text-sm text-slate-800">
                            <span id="post-caption-collapsed-${groupIdx}" class="whitespace-pre-line line-clamp-2 inline">${escapeHtml(comment).replace(/\n/g, '<br>')}</span>
                            <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-toggle-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1 ${toggleBtnClass}">더 보기</button>
                            <div id="post-caption-expanded-${groupIdx}" class="whitespace-pre-line hidden">
                                ${escapeHtml(comment).replace(/\n/g, '<br>')}
                                <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-collapse-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1">접기</button>
                            </div>
                        </div>
                    `;
                    })() : (!isBestShare && !isDailyShare && !isInsightShare && entryId && photo.userId && !isMyPost ? `<div class="shared-comment-fetch-placeholder mb-2 text-sm text-slate-800" data-post-id="${postId}" data-entry-id="${entryId}" data-owner-user-id="${photo.userId}" data-group-idx="${groupIdx}"><span class="text-xs text-slate-400">불러오는 중</span></div>` : '')}
                    <div class="comment-section comments-empty ${((caption && (isBestShare || isDailyShare || isInsightShare)) || (comment && !isBestShare && !isDailyShare && !isInsightShare)) ? 'border-t border-slate-200 ' : ''}-mx-6 px-6 pt-1.5 mt-1" id="comment-section-${postId}">
                        <div class="post-comments-list mb-1 rounded-lg py-2 bg-white" data-post-id="${postId}" id="comments-list-${postId}"></div>
                        <button id="view-comments-${postId}" class="hidden text-xs text-slate-500 font-bold mb-1 hover:text-slate-700 active:text-slate-900 transition-colors" onclick="window.viewAllComments('${postId}')">댓글 더보기</button>
                        <div id="comment-input-${postId}" class="hidden mt-1 py-3 -mx-6 px-6">
                            <div class="relative">
                                <input type="text" id="comment-text-${postId}" placeholder="댓글을 입력하세요..." class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100" onkeypress="if(event.key === 'Enter') window.submitComment('${postId}')">
                                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); window.submitComment('${postId}')" onclick="window.submitComment('${postId}')">게시</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
}

// 공유 게시물 코멘트 캐시 (lazy 로드 시 재요청 방지)
const sharedCommentsCache = new Map();

/** 공유 게시물 중 문서에 comment가 없는 경우 서버에서 일괄 조회해 DOM에 반영. commentsPromise 있으면 미리 보낸 요청 결과 사용 */
export async function fetchMissingSharedComments(container, commentsPromise) {
    const el = container && container.querySelector ? container : document.getElementById('galleryContainer');
    if (!el) return;
    const placeholders = el.querySelectorAll('.shared-comment-fetch-placeholder');
    if (placeholders.length === 0) return;
    const items = [];
    const placeholdersByKey = new Map();
    placeholders.forEach(div => {
        const entryId = div.getAttribute('data-entry-id');
        const ownerUserId = div.getAttribute('data-owner-user-id');
        if (!entryId || !ownerUserId) return;
        const key = `${entryId}\t${ownerUserId}`;
        if (!placeholdersByKey.has(key)) {
            items.push({ entryId, ownerUserId });
            placeholdersByKey.set(key, []);
        }
        placeholdersByKey.get(key).push(div);
    });
    if (items.length === 0) return;
    const commentByKey = new Map();
    const uncachedItems = items.filter(({ entryId, ownerUserId }) => {
        const key = `${entryId}\t${ownerUserId}`;
        if (sharedCommentsCache.has(key)) {
            commentByKey.set(key, sharedCommentsCache.get(key));
            return false;
        }
        return true;
    });
    if (uncachedItems.length === 0) {
        placeholdersByKey.forEach((divs, key) => {
            const comment = commentByKey.get(key) || '';
            divs.forEach(div => applyCommentToPlaceholder(el, div, comment));
        });
        return;
    }
    try {
        let data;
        if (commentsPromise && typeof commentsPromise.then === 'function') {
            const res = await commentsPromise;
            data = res && res.data ? res.data : res;
        } else if (uncachedItems.length > 0) {
            const mod = await import('./firebase.js');
            const callable = mod.callableFunctions?.getSharedEntryComments;
            if (!callable) return;
            const res = await callable({ items: uncachedItems });
            data = res && res.data ? res.data : res;
        }
        const comments = (data && data.comments && Array.isArray(data.comments)) ? data.comments : [];
        comments.forEach(c => {
            const key = `${c.entryId}\t${c.ownerUserId}`;
            const comment = (c.comment && String(c.comment).trim()) || '';
            sharedCommentsCache.set(key, comment);
            commentByKey.set(key, comment);
        });
        placeholdersByKey.forEach((divs, key) => {
            const comment = commentByKey.get(key) || '';
            divs.forEach(div => applyCommentToPlaceholder(el, div, comment));
        });
    } catch (e) {
        console.warn('공유 게시물 코멘트 일괄 조회 실패:', e);
        placeholders.forEach(div => { div.remove(); });
    }
}

function applyCommentToPlaceholder(el, div, comment) {
    const groupIdx = div.getAttribute('data-group-idx');
    const postId = div.getAttribute('data-post-id');
    div.classList.remove('shared-comment-fetch-placeholder');
    if (comment) {
        const lineBreaks = (comment.match(/\n/g) || []).length;
        const estimatedLines = Math.ceil(comment.length / 30);
        const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
        const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
        div.innerHTML = `
            <span id="post-caption-collapsed-${groupIdx}" class="whitespace-pre-line line-clamp-2 inline">${escapeHtml(comment).replace(/\n/g, '<br>')}</span>
            <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-toggle-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1 ${toggleBtnClass}">더 보기</button>
            <div id="post-caption-expanded-${groupIdx}" class="whitespace-pre-line hidden">
                ${escapeHtml(comment).replace(/\n/g, '<br>')}
                <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-collapse-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1">접기</button>
            </div>
        `;
        const commentSection = el.querySelector(`#comment-section-${CSS.escape(postId)}`);
        if (commentSection) commentSection.classList.remove('comments-empty'), commentSection.classList.add('border-t', 'border-slate-200');
    } else {
        div.remove();
    }
}

/** 갤러리 가로 스크롤 시 현재 슬라이드 기준 이전 1장 + 다음 2장 캐시에 미리 로드 */
function preloadAdjacentGalleryImages(scrollContainer) {
    const slides = Array.from(scrollContainer.children);
    if (slides.length <= 1) return;
    const scrollLeft = scrollContainer.scrollLeft;
    const containerWidth = scrollContainer.clientWidth;
    let currentIndex = 0;
    slides.forEach((slide, i) => {
        const center = slide.offsetLeft + slide.offsetWidth / 2;
        if (center >= scrollLeft && center <= scrollLeft + containerWidth) currentIndex = i;
    });
    const imgs = slides.map(s => s.querySelector('img')).filter(Boolean);
    const toPreload = [currentIndex - 1, currentIndex + 1, currentIndex + 2];
    toPreload.forEach(idx => {
        if (idx < 0 || idx >= imgs.length) return;
        const img = imgs[idx];
        const url = img.src || img.getAttribute('data-src');
        if (!url) return;
        const preload = new Image();
        preload.src = url;
    });
}

/** 갤러리 이벤트 리스너 설정 (세 번째 인자: AbortSignal 또는 { abortSignal?, startIndex? }) - appendGalleryPosts에서도 사용 */
function setupGalleryEventListeners(container, sortedGroups, opts = null) {
    const abortSignal = opts && typeof opts === 'object' && opts.abortSignal !== undefined ? opts.abortSignal : (opts && typeof opts.addEventListener === 'function' ? opts : null);
    const startIndex = opts && typeof opts === 'object' && typeof opts.startIndex === 'number' ? opts.startIndex : 0;
    const scrollContainers = container.querySelectorAll('.gallery-photo-scroll');
    scrollContainers.forEach((scrollContainer, idx) => {
        if (idx < startIndex) return;
        const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
        const photos = Array.from(scrollContainer.children);
        const photoCount = sortedGroups[idx]?.length || 0;
        if (photoCount > 1) {
            let isDragging = false;
            let startX = 0;
            let startScrollLeft = 0;
            scrollContainer.style.cursor = 'grab';
            const onMouseMove = (e) => {
                if (!isDragging) return;
                e.preventDefault();
                const dx = e.pageX - startX;
                scrollContainer.scrollLeft = Math.max(0, Math.min(scrollContainer.scrollWidth - scrollContainer.clientWidth, startScrollLeft - dx));
            };
            const endDrag = () => {
                if (!isDragging) return;
                isDragging = false;
                scrollContainer.style.cursor = 'grab';
                scrollContainer.style.userSelect = '';
                document.removeEventListener('mousemove', onMouseMove, { capture: true });
                document.removeEventListener('mouseup', endDrag, { capture: true });
            };
            scrollContainer.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                isDragging = true;
                startX = e.pageX;
                startScrollLeft = scrollContainer.scrollLeft;
                scrollContainer.style.cursor = 'grabbing';
                scrollContainer.style.userSelect = 'none';
                document.addEventListener('mousemove', onMouseMove, { capture: true, passive: false });
                document.addEventListener('mouseup', endDrag, { capture: true });
            }, { passive: false });
            const snapToNearest = () => {
                const sl = scrollContainer.scrollLeft;
                const cw = scrollContainer.clientWidth;
                let nearest = 0;
                let minDist = Infinity;
                photos.forEach((p, i) => {
                    const pos = p.offsetLeft + p.offsetWidth / 2;
                    const d = Math.abs(sl + cw / 2 - pos);
                    if (d < minDist) { minDist = d; nearest = i; }
                });
                const target = photos[nearest]?.offsetLeft ?? 0;
                if (Math.abs(sl - target) > 2) scrollContainer.scrollTo({ left: target, behavior: 'smooth' });
                preloadAdjacentGalleryImages(scrollContainer);
            };
            let snapTimeout = null;
            const onScrollEnd = () => { clearTimeout(snapTimeout); snapTimeout = setTimeout(snapToNearest, 80); };
            let preloadThrottle = null;
            const onScrollPreload = () => {
                if (preloadThrottle) return;
                preloadThrottle = setTimeout(() => { preloadThrottle = null; preloadAdjacentGalleryImages(scrollContainer); }, 50);
            };
            scrollContainer.addEventListener('scroll', onScrollEnd, { passive: true });
            scrollContainer.addEventListener('scroll', onScrollPreload, { passive: true });
            if ('onscrollend' in scrollContainer) scrollContainer.addEventListener('scrollend', snapToNearest);
            if (abortSignal) abortSignal.addEventListener('abort', () => {
                clearTimeout(snapTimeout);
                clearTimeout(preloadThrottle);
                scrollContainer.removeEventListener('scroll', onScrollEnd);
                scrollContainer.removeEventListener('scroll', onScrollPreload);
                scrollContainer.removeEventListener('scrollend', snapToNearest);
            });
            preloadAdjacentGalleryImages(scrollContainer);
        }
        if (counter && photoCount > 1) {
            const updateCounter = () => {
                const containerWidth = scrollContainer.clientWidth;
                const scrollLeft = scrollContainer.scrollLeft;
                let currentIndex = 1;
                photos.forEach((photo, photoIdx) => {
                    const photoCenter = photo.offsetLeft + photo.offsetWidth / 2;
                    if (photoCenter >= scrollLeft && photoCenter <= scrollLeft + containerWidth) currentIndex = photoIdx + 1;
                });
                counter.textContent = currentIndex;
            };
            const abortController = new AbortController();
            scrollContainer.addEventListener('scroll', updateCounter, { signal: abortController.signal });
            galleryScrollListeners.set(scrollContainer, abortController);
            updateCounter();
        }
    });
    if (window.showFeedOptions && !container._galleryFeedOptionsDelegate) {
        const delegateHandler = (e) => {
            const btn = e.target.closest('.feed-options-btn');
            if (!btn) return;
            e.stopPropagation();
            e.preventDefault();
            const entryId = btn.getAttribute('data-entry-id') || '';
            const photoUrls = btn.getAttribute('data-photo-urls') || '';
            const isBestShare = btn.getAttribute('data-is-best') === 'true';
            const photoDate = btn.getAttribute('data-photo-date') || '';
            const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
            const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
            const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
            const dateRangeText = btn.getAttribute('data-date-range-text') || '';
            const postId = btn.getAttribute('data-post-id') || '';
            const authorUserId = btn.getAttribute('data-author-user-id') || '';
            const caption = btn.getAttribute('data-caption') || '';
            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
        };
        container._galleryFeedOptionsDelegate = delegateHandler;
        container.addEventListener('click', delegateHandler);
    }
    const isLoggedIn = window.currentUser && !window.currentUser.isAnonymous;
    container.querySelectorAll('[data-requires-login="true"]').forEach(btn => {
        if (!isLoggedIn) { btn.classList.add('opacity-50', 'cursor-not-allowed'); btn.title = '로그인이 필요합니다'; if (btn.tagName === 'INPUT') { btn.disabled = true; btn.placeholder = '로그인 후 댓글을 달아보세요'; } }
        else { btn.classList.remove('opacity-50', 'cursor-not-allowed'); btn.title = ''; if (btn.tagName === 'INPUT') { btn.disabled = false; btn.placeholder = '댓글 달기...'; } }
    });
}

/** 더보기 시 새 포스트만 DOM에 추가 (전체 재렌더 없이 깜박임 방지) */
async function appendGalleryPosts(docs, loadMoreWrap) {
    if (!docs || docs.length === 0 || !loadMoreWrap || !loadMoreWrap.parentNode) return;
    const container = document.getElementById('galleryContainer');
    if (!container) return;
    const newGroups = processPhotosToGroups(docs);
    if (newGroups.length === 0) return;
    // 새로 추가되는 작성자들의 프로필을 먼저 로드해 두어 닉네임이 '익명'으로 나오지 않도록 함
    await fetchUserProfiles([...new Set(docs.map(p => p.userId).filter(Boolean))]);
    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => { if (meal.id) mealHistoryMap.set(meal.id, meal); });
    }
    const existingCount = container.querySelectorAll('.instagram-post').length;
    const newPostsHtml = newGroups.map((photoGroup, i) => renderPostGroupHtml(photoGroup, existingCount + i, mealHistoryMap)).join('');
    const fragment = document.createDocumentFragment();
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = newPostsHtml;
    while (tempDiv.firstChild) fragment.appendChild(tempDiv.firstChild);
    loadMoreWrap.parentNode.insertBefore(fragment, loadMoreWrap);
    const fullSortedGroups = processPhotosToGroups(window.sharedPhotosFeed || []);
    setTimeout(() => {
        setupGalleryEventListeners(container, fullSortedGroups, { startIndex: existingCount });
        fetchMissingSharedComments(container).catch(() => {});
        if (window.postInteractions && intersectionObserver) {
            container.querySelectorAll('.instagram-post').forEach((post, i) => {
                if (i >= existingCount && document.contains(post)) intersectionObserver.observe(post);
            });
        }
    }, 50);
}

// 사용자 설정 가져오기 헬퍼 함수
async function getUserSettings(userId) {
    try {
        const { db, appId } = await import('./firebase.js');
        const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const settingsDoc = doc(db, 'artifacts', appId, 'users', userId, 'config', 'settings');
        const settingsSnap = await getDoc(settingsDoc);
        if (settingsSnap.exists()) {
            return settingsSnap.data();
        }
    } catch (e) {
        console.warn('사용자 설정 가져오기 실패:', e);
    }
    return null;
}

/** 다른 사용자들의 최신 프로필을 Firestore에서 가져와 userProfileCache에 저장 (다른 사용자가 볼 때 최신 프로필 표시용) */
export async function fetchUserProfiles(userIds) {
    if (!userIds || userIds.length === 0) return;
    const currentUid = window.currentUser?.uid;
    const toFetch = [...new Set(userIds)].filter(id => id && id !== currentUid);
    if (toFetch.length === 0) return;
    if (!window.userProfileCache) window.userProfileCache = new Map();
    const uncached = toFetch.filter(id => !window.userProfileCache.has(id));
    if (uncached.length === 0) return;
    try {
        const results = await Promise.all(uncached.map(async (userId) => {
            const settings = await getUserSettings(userId);
            const p = settings?.profile;
            return { userId, profile: p ? { nickname: p.nickname || '익명', icon: p.icon ?? null, photoUrl: p.photoUrl || null } : null };
        }));
        results.forEach(({ userId, profile }) => {
            if (profile) window.userProfileCache.set(userId, profile);
        });
    } catch (e) {
        console.warn('프로필 일괄 로드 실패:', e);
    }
}

export async function renderGallery(options = {}) {
    const skipScrollToTop = options.skipScrollToTop === true; // 더보기 시 스크롤 위치 유지
    const savedScrollY = skipScrollToTop ? window.scrollY : 0; // 더보기 시 복원용
    // 중복 실행 방지
    if (isRenderingGallery) {
        console.log('[renderGallery] 이미 실행 중이므로 스킵');
        return;
    }
    
    try {
        isRenderingGallery = true;
        console.log('[renderGallery] 시작, window.sharedPhotos:', window.sharedPhotos?.length || 0);
        
        const container = document.getElementById('galleryContainer');
        if (!container) {
            console.warn('[renderGallery] galleryContainer를 찾을 수 없습니다');
            isRenderingGallery = false;
            return;
        }
        
        // ===== STRICT CLEANUP: 모든 Observer와 비동기 작업을 먼저 정리 =====
        
        // 1. 이전 AbortController로 모든 비동기 작업 취소
        if (galleryAbortController) {
            galleryAbortController.abort();
        }
        galleryAbortController = new AbortController();
        const abortSignal = galleryAbortController.signal;
        
        // 2. 이전 스크롤 이벤트 리스너 정리
        galleryScrollListeners.forEach((abortController, scrollContainer) => {
            abortController.abort();
        });
        galleryScrollListeners.clear();
        
        // 3. 이전 Intersection Observer 정리
        if (intersectionObserver) {
            intersectionObserver.disconnect();
            intersectionObserver = null;
        }
        
        // 4. 이전 Placeholder Observer 정리
        if (placeholderObserver) {
            placeholderObserver.disconnect();
            placeholderObserver = null;
        }
        
        // 5. 포스트 로드 큐 및 타이머 초기화
        postLoadQueue = [];
        if (postLoadBatchTimer) {
            clearTimeout(postLoadBatchTimer);
            postLoadBatchTimer = null;
        }
        
        // 6. 로드된 포스트 캐시 초기화 (렌더링이 완전히 새로 시작되므로)
        loadedPostIds.clear();
        
        // 7. 갤러리 피드 옵션 위임 리스너 제거 (재설정 시 중복 방지)
        if (container._galleryFeedOptionsDelegate) {
            container.removeEventListener('click', container._galleryFeedOptionsDelegate);
            delete container._galleryFeedOptionsDelegate;
        }
        
        // 사용자 필터링 적용
    const filterUserId = appState.galleryFilterUserId;
    const galleryFilterTab = appState.galleryFilterTab || 'moment';
    let photosToRender;
    if (filterUserId) {
        try {
            photosToRender = await getSharedPhotosByUser(filterUserId);
            appState.galleryFeedNetworkError = false;
        } catch (e) {
            console.error('모먼트(사용자) 로드 실패:', e);
            appState.galleryFeedNetworkError = true;
            photosToRender = [];
        }
    } else {
        photosToRender = window.sharedPhotosFeed || [];
        // 전체보기: 최신순 정렬 보장 (Firestore 혼합 타입·캐시 등으로 정렬 꼬임 방지)
        const ts = (p) => {
            const t = p?.timestamp;
            if (t != null && t !== '') {
                if (t?.toDate) return t.toDate().getTime();
                if (typeof t === 'string') return new Date(t).getTime();
                if (t?.seconds != null) return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6;
                if (typeof t === 'number') return t;
            }
            const d = p?.date, tm = p?.time || '12:00:00';
            if (d && typeof d === 'string') {
                const ms = new Date(d + 'T' + (String(tm).split(':').length === 2 ? tm + ':00' : tm)).getTime();
                if (!isNaN(ms)) return ms;
            }
            return 0;
        };
        photosToRender = [...photosToRender].sort((a, b) => ts(b) - ts(a));
    }
    
    // 사용자 프로필 뷰일 때 최상단 앱 헤더 숨김
    const mainHeader = document.querySelector('#mainApp > header');
    if (mainHeader) {
        if (filterUserId) mainHeader.classList.add('hidden');
        else mainHeader.classList.remove('hidden');
    }
    
    // 디버깅: 일간보기 공유 확인
    const dailyShares = photosToRender.filter(p => p.type === 'daily');
    console.log('renderGallery - 일간보기 공유 개수:', dailyShares.length, dailyShares);
    
    // 필터링된 사용자 정보 표시 (상단) — 프로필+소개+모먼트/밀톡 탭
    let userProfileHeader = '';
    if (filterUserId) {
        await fetchUserProfiles([filterUserId]);
        const filteredUserPhoto = photosToRender[0] || null;
        const initialDisplay = filteredUserPhoto
            ? getDisplayProfile(filteredUserPhoto.userId, { nickname: filteredUserPhoto.userNickname, icon: filteredUserPhoto.userIcon, photoUrl: filteredUserPhoto.userPhotoUrl })
            : getDisplayProfile(filterUserId, { nickname: '로딩...', icon: null, photoUrl: null });
        const initialAvatar = getProfileAvatarDisplay(initialDisplay);
        (async () => {
            if (abortSignal && abortSignal.aborted) return;
            try {
                const userSettings = await getUserSettings(filterUserId);
                const { db, appId } = await import('./firebase.js');
                const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
                const userDocSnap = await getDoc(doc(db, 'artifacts', appId, 'users', filterUserId));
                const existingHeader = container.querySelector('.gallery-user-profile-header');
                if (!existingHeader) return;
                const bio = userSettings?.profile?.bio || '';
                const bioEl = existingHeader.querySelector('.gallery-filter-bio');
                if (bioEl) bioEl.textContent = bio;
                let joinedStr = '';
                if (userDocSnap.exists()) {
                    const data = userDocSnap.data();
                    const createdAt = data.createdAt;
                    if (createdAt) {
                        try {
                            const d = createdAt.toDate ? createdAt.toDate() : new Date(createdAt);
                            if (!isNaN(d.getTime())) joinedStr = '가입일 ' + d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
                        } catch (_) {}
                    }
                }
                const joinedEl = existingHeader.querySelector('.gallery-filter-joined');
                if (joinedEl) joinedEl.textContent = joinedStr;
                if (!filteredUserPhoto && userSettings?.profile) {
                    const nickEl = existingHeader.querySelector('.gallery-filter-nickname');
                    const iconEl = existingHeader.querySelector('.gallery-filter-icon');
                    const photoEl = existingHeader.querySelector('.gallery-filter-photo');
                    const disp = getDisplayProfile(filterUserId, { nickname: userSettings.profile.nickname, icon: userSettings.profile.icon, photoUrl: userSettings.profile.photoUrl });
                    if (nickEl) nickEl.textContent = disp.nickname || '익명';
                    if (iconEl) {
                        const avatar = getProfileAvatarDisplay(disp);
                        if (avatar.type === 'photo') {
                            iconEl.textContent = '';
                            iconEl.style.backgroundImage = `url(${avatar.value})`;
                            iconEl.classList.add('bg-cover', 'bg-center');
                            iconEl.classList.remove('bg-slate-200', 'bg-indigo-100');
                        } else {
                            if (avatar.type === 'default') {
                                iconEl.innerHTML = '<i class="fa-solid fa-user text-sm text-slate-500"></i>';
                            } else {
                                iconEl.textContent = avatar.value;
                            }
                            iconEl.style.backgroundImage = '';
                            iconEl.className = `gallery-filter-icon w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border border-slate-300 ${avatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}`;
                        }
                    }
                    if (photoEl && disp.photoUrl) {
                        photoEl.style.backgroundImage = `url(${disp.photoUrl})`;
                        photoEl.classList.add('bg-cover', 'bg-center');
                    }
                }
            } catch (_) {}
        })();
        
        const isFilteredUserGuest = window.currentUser && window.currentUser.isAnonymous && filterUserId === window.currentUser.uid;
        userProfileHeader = `
            <div class="gallery-user-profile-header bg-white">
                <div class="gallery-user-profile-scrollable">
                    <div class="px-4 py-3 flex items-center gap-2 border-b border-slate-200">
                        <button onclick="window.clearGalleryFilter()" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                            <i class="fa-solid fa-arrow-left text-lg"></i>
                        </button>
                        ${initialAvatar.type === 'photo' ? `
                            <div class="gallery-filter-photo w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border border-slate-300 bg-slate-100" style="background-image: url(${initialAvatar.value}); background-size: cover; background-position: center;"></div>
                        ` : `
                            <div class="gallery-filter-icon w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border border-slate-300 ${initialAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">${initialAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(initialAvatar.value)}</div>
                        `}
                        <div class="flex-1 min-w-0">
                            <div class="gallery-filter-nickname text-sm font-bold text-slate-800">${initialDisplay.nickname || '익명'}</div>
                            <div class="gallery-filter-joined text-xs text-slate-400"></div>
                        </div>
                    </div>
                    <div class="gallery-filter-bio text-sm text-slate-600 whitespace-pre-wrap min-h-[1.5rem] px-4 py-3 border-b-2 border-slate-200">${filteredUserPhoto ? ('' /* 비동기로 채움 */) : ''}</div>
                </div>
                <div class="gallery-filter-tabs sticky top-0 z-30 flex w-full min-w-0 bg-white border-t-2 border-slate-200">
                    <button type="button" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('moment')" class="gallery-filter-tab-btn flex-1 min-w-0 py-3 text-sm font-bold transition-colors border-b-2 ${galleryFilterTab === 'moment' ? 'text-emerald-600 border-emerald-600' : 'text-slate-600 border-transparent'}">모먼트</button>
                    <button type="button" onclick="window.switchGalleryFilterTab && window.switchGalleryFilterTab('board')" class="gallery-filter-tab-btn flex-1 min-w-0 py-3 text-sm font-bold transition-colors border-b-2 ${galleryFilterTab === 'board' ? 'text-emerald-600 border-emerald-600' : 'text-slate-600 border-transparent'}">밀톡</button>
                </div>
            </div>
        `;
    }
    
    // 알림에서 클릭 시 해당 게시물만 보기: 상단에 전체보기 버튼
    if (appState.galleryFilterPostId && !filterUserId) {
        userProfileHeader = `
            <div class="gallery-post-filter-header bg-white border-b border-slate-200 sticky top-0 z-30">
                <div class="px-4 py-3 flex items-center gap-2">
                    <button type="button" onclick="window.clearGalleryFilterPostId && window.clearGalleryFilterPostId()" class="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="text-sm font-bold text-slate-800">댓글 달린 게시물</span>
                </div>
            </div>
        `;
    }
    
    // 사용자 프로필 뷰 + 밀톡 탭: 밀톡 탭과 동일한 목록 렌더링 (_renderBoardList 사용)
    if (filterUserId && galleryFilterTab === 'board') {
        container.innerHTML = userProfileHeader + `
            <div id="galleryFilterBoardList" class="px-4 pt-1 pb-4">
                <div class="flex justify-center py-8"><i class="fa-solid fa-spinner fa-spin text-2xl text-slate-300"></i></div>
            </div>
        `;
        (async () => {
            try {
                const { boardOperations } = await import('./db.js');
                const [posts, liked, bookmarked, commented] = await Promise.all([
                    boardOperations.getPostsByAuthor(filterUserId, 50),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
                    window.currentUser && !window.currentUser.isAnonymous ? boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
                ]);
                const listEl = document.getElementById('galleryFilterBoardList');
                if (!listEl || (abortSignal && abortSignal.aborted)) return;
                const likedPostIds = new Set(liked || []);
                const bookmarkedPostIds = new Set(bookmarked || []);
                const postIdsCommentedByUser = new Set(commented || []);
                if (posts.length === 0) {
                    listEl.innerHTML = `
                        <div class="flex flex-col items-center justify-center py-12 text-center">
                            <i class="fa-regular fa-comments text-4xl text-slate-200 mb-3"></i>
                            <p class="text-sm font-bold text-slate-400">작성한 글이 없습니다</p>
                            <p class="text-xs text-slate-300 mt-2">첫 번째 게시글을 작성해보세요!</p>
                        </div>
                    `;
                } else {
                    await _renderBoardList(listEl, posts, likedPostIds, bookmarkedPostIds, null, postIdsCommentedByUser);
                }
            } catch (e) {
                console.warn('getPostsByAuthor 실패:', e);
                const listEl = document.getElementById('galleryFilterBoardList');
                if (listEl && !(abortSignal && abortSignal.aborted)) {
                    listEl.innerHTML = `<div class="flex flex-col items-center justify-center py-8 text-center">
                        <p class="text-slate-400 text-sm mb-3">글 목록을 불러오지 못했습니다.</p>
                        <button type="button" onclick="window.renderGallery && window.renderGallery()" class="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold rounded-lg inline-flex items-center gap-1.5">
                            <i class="fa-solid fa-rotate-right"></i>다시 불러오기
                        </button>
                    </div>`;
                }
            } finally {
                isRenderingGallery = false;
            }
        })();
        return;
    }
    
    if (photosToRender.length === 0) {
        container.innerHTML = userProfileHeader + `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-solid fa-images text-6xl text-slate-200 mb-4"></i>
                <p class="text-sm font-bold text-slate-400">${filterUserId ? '이 사용자의 공유된 사진이 없습니다' : '공유된 사진이 없습니다'}</p>
                ${!filterUserId ? '<p class="text-xs text-slate-300 mt-2">타임라인에서 사진을 공유해보세요!</p>' : ''}
            </div>
        `;
        // 이전 포스트 ID 목록 초기화
        previousGalleryPostIds.clear();
        // 빈 갤러리일 때도 맨 위로 스크롤
        setTimeout(() => {
            if (!abortSignal || !abortSignal.aborted) {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }, 100);
        isRenderingGallery = false;
        return;
    }
    
    // 중복 제거: 같은 photoUrl과 entryId 조합은 하나만 표시
    const seen = new Set();
    const uniquePhotos = photosToRender.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    
    // entryId와 userId로 그룹화 (같은 기록의 사진들을 묶음)
    // 중요: 하나의 게시물(entryId)은 앨범에 한 번만 표시되어야 하므로, entryId와 userId만 사용
    // 일간보기 공유(type: 'daily')는 date와 userId로 그룹화
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        let groupKey;
        if (photo.type === 'daily') {
            // 일간보기 공유: date_userId로 그룹화 (같은 날짜의 일간보기 공유는 하나로 묶음)
            groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        } else if (photo.type === 'best') {
            // 베스트 공유: id_userId로 그룹화 (베스트 공유는 각각 고유)
            groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        } else if (photo.type === 'insight') {
            // 인사이트 공유: dateRangeText_userId로 그룹화 (같은 기간의 인사이트 공유는 하나로 묶음)
            groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        } else if (photo.entryId) {
            // entryId가 있는 경우: entryId_userId로 그룹화
            groupKey = `${photo.entryId}_${photo.userId}`;
        } else {
            // entryId가 없는 경우: no-entry_userId로 그룹화
            groupKey = `no-entry_${photo.userId}`;
        }
        if (!groupedPhotos[groupKey]) {
            groupedPhotos[groupKey] = [];
        }
        groupedPhotos[groupKey].push(photo);
    });
    
    // 다른 사용자들의 최신 프로필 미리 로드 (프로필 변경 시 다른 사용자도 최신 설정으로 표시)
    const galleryUserIds = [...new Set(uniquePhotos.map(p => p.userId).filter(Boolean))];
    await fetchUserProfiles(galleryUserIds);
    
    // mealHistoryMap: renderPostGroup에서 댓글 등 meal 정보 조회용 (사진 순서 정렬에는 사용하지 않음)
    let mealHistoryMap = new Map();
    if (window.mealHistory && Array.isArray(window.mealHistory)) {
        window.mealHistory.forEach(meal => {
            if (meal.id) mealHistoryMap.set(meal.id, meal);
        });
    }
    const renderPostGroup = (photoGroup, groupIdx) => renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap);
    // 각 그룹 내 사진을 Firestore photoIndex 기준으로만 정렬 (글쓴이/다른 사용자 동일 순서 보장)
    const photoSortTieBreaker = (a, b) => {
        const aKey = String(a.id ?? normalizeUrl(a.photoUrl) ?? '');
        const bKey = String(b.id ?? normalizeUrl(b.photoUrl) ?? '');
        return aKey.localeCompare(bKey, 'en');
    };
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        photoGroup.sort((a, b) => {
            const ai = a.photoIndex;
            const bi = b.photoIndex;
            if (typeof ai === 'number' && typeof bi === 'number') {
                const cmp = ai - bi;
                if (cmp !== 0) return cmp;
            }
            const ta = new Date(a.timestamp).getTime();
            const tb = new Date(b.timestamp).getTime();
            const cmp = ta - tb;
            return cmp !== 0 ? cmp : photoSortTieBreaker(a, b);
        });
    });
    
    // 그룹을 시간순으로 정렬 (동점 시 2차 키로 동일 순서 보장)
    let sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        // timestamp를 Date로 변환 (이미 ISO 문자열이거나 Date 객체일 수 있음)
        const getTimestamp = (photo) => {
            if (!photo.timestamp) return 0;
            if (photo.timestamp instanceof Date) return photo.timestamp.getTime();
            if (typeof photo.timestamp === 'string') return new Date(photo.timestamp).getTime();
            if (photo.timestamp.toDate) return photo.timestamp.toDate().getTime();
            if (photo.timestamp.seconds) return photo.timestamp.seconds * 1000;
            return 0;
        };
        
        const timeA = getTimestamp(a[0]);
        const timeB = getTimestamp(b[0]);
        const cmp = timeB - timeA; // 최신순 (큰 값이 먼저)
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
    
    // 앨범 흔적 필터: 본인이 좋아요/댓글/북마크한 게시물만 표시 (알림에서 한 게시물만 볼 때는 생략해 로딩 단축)
    let tracePostIds = null;
    if (appState.galleryTraceFilter && !appState.galleryFilterPostId && window.currentUser && !window.currentUser.isAnonymous && window.postInteractions) {
        let list = [];
        if (appState.galleryTraceFilter === 'like') {
            list = await window.postInteractions.getPostIdsLikedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'comment') {
            list = await window.postInteractions.getPostIdsCommentedByUser(window.currentUser.uid);
        } else if (appState.galleryTraceFilter === 'bookmark') {
            list = await window.postInteractions.getPostIdsBookmarkedByUser(window.currentUser.uid);
        }
        tracePostIds = new Set(list);
        sortedGroups = sortedGroups.filter(g => tracePostIds.has(getPostIdFromPhotoGroup(g)));
    }
    
    // 알림에서 클릭 시 해당 게시물만 필터
    const filterPostId = appState.galleryFilterPostId;
    if (filterPostId) {
        sortedGroups = sortedGroups.filter(g =>
            getPostIdFromPhotoGroup(g) === filterPostId
            || (Array.isArray(g) && (g.some(p => p.id === filterPostId) || g.some(p => p.entryId === filterPostId)))
        );
    }
    
    // 코멘트가 비어 있을 수 있는 글은 렌더와 동시에 미리 요청 (체감 지연 감소)
    let sharedCommentsPromise = null;
    const needCommentItems = [];
    for (const g of sortedGroups) {
        const photo = g[0];
        if (!photo || photo.type === 'best' || photo.type === 'daily' || photo.type === 'insight') continue;
        const eid = photo.entryId;
        const uid = photo.userId;
        if (!eid || !uid || (window.currentUser && uid === window.currentUser.uid)) continue;
        const hasComment = photo.comment || (mealHistoryMap.get(eid) && mealHistoryMap.get(eid).comment);
        if (hasComment) continue;
        needCommentItems.push({ entryId: eid, ownerUserId: uid });
    }
    if (needCommentItems.length > 0) {
        sharedCommentsPromise = import('./firebase.js').then(mod => {
            const fn = mod.callableFunctions?.getSharedEntryComments;
            return fn ? fn({ items: needCommentItems }) : { data: { comments: [] } };
        }).catch(() => ({ data: { comments: [] } }));
    }
    
    const traceEmptyLabels = { like: '좋아요한', comment: '댓글 단', bookmark: '북마크한' };
    const traceEmptyMsg = tracePostIds && sortedGroups.length === 0
        ? (traceEmptyLabels[appState.galleryTraceFilter] || '') + ' 게시물이 없습니다'
        : null;
    
    const traceEmptyIcon = appState.galleryTraceFilter === 'like' ? 'fa-heart' : (appState.galleryTraceFilter === 'comment' ? 'fa-comment' : 'fa-bookmark');
    
    // 알림 필터 시 빈 메시지 (해당 게시물이 없을 때)
    const filterPostEmptyMsg = filterPostId && sortedGroups.length === 0 ? '해당 게시물을 찾을 수 없습니다' : null;
    
    // 네트워크 단절 시 빈 메시지 (모먼트 피드 로드 실패 시)
    const networkEmptyMsg = sortedGroups.length === 0 && appState.galleryFeedNetworkError
        ? '네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.'
        : null;
    
    // ===== DIFFING: 변경사항이 작으면 차등 업데이트, 크면 전체 재렌더링 =====
    const currentPostIds = new Set(sortedGroups.map(g => getPostIdFromPhotoGroup(g)));
    const hasSignificantChanges = 
        previousGalleryPostIds.size === 0 || // 초기 로드
        currentPostIds.size === 0 || // 모든 포스트 삭제
        Math.abs(currentPostIds.size - previousGalleryPostIds.size) > 5 || // 5개 이상 차이
        Array.from(currentPostIds).slice(0, 10).some(id => !previousGalleryPostIds.has(id)); // 상위 10개 중 새 포스트 있음
    
    // AbortSignal 체크: 취소되었으면 중단
    if (abortSignal.aborted) {
        console.log('[renderGallery] AbortSignal 감지 - 렌더링 중단');
        isRenderingGallery = false;
        return;
    }
    
    // 헤더와 빈 메시지만 먼저 렌더링 (네트워크 오류 > 알림/흔적 필터 빈 메시지)
    const emptyMsg = networkEmptyMsg || filterPostEmptyMsg || traceEmptyMsg;
    const emptyIcon = networkEmptyMsg ? 'fa-wifi' : (filterPostEmptyMsg ? 'fa-comment' : traceEmptyIcon);
    const headerHtml = userProfileHeader + (emptyMsg ? `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-regular ${emptyIcon} text-6xl text-slate-200 mb-4"></i>
                <p class="text-sm font-bold text-slate-400">${emptyMsg}</p>
                ${networkEmptyMsg ? `<button type="button" onclick="window.reloadMomentFeed && window.reloadMomentFeed()" class="mt-4 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-bold rounded-xl transition-colors inline-flex items-center gap-1.5">
                    <i class="fa-solid fa-rotate-right"></i>다시 불러오기
                </button>` : ''}
            </div>
        ` : '');
    
    // 더보기 표시 여부 (타임라인처럼 초기 구조에 포함하여 누락 방지)
    const canLoadMore = !filterUserId && !appState.galleryFilterPostId &&
        (appState.sharedPhotosFeedHasMore || (sortedGroups.length >= 10 && appState.sharedPhotosFeedLastDoc));
    const loadMoreHtml = canLoadMore ? `
        <div id="galleryLoadMoreWrap" class="flex justify-center py-6">
            <button id="galleryLoadMoreBtn" type="button" class="px-6 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl transition-colors">
                <i class="fa-solid fa-chevron-down mr-1.5"></i>더보기
            </button>
        </div>
    ` : '';

    // 변경사항이 크거나 초기 로드면 전체 재렌더링
    if (hasSignificantChanges) {
        container.innerHTML = headerHtml + '<div id="galleryPostsInsertPoint"></div>' + loadMoreHtml;
    } else {
        // 차등 업데이트: 새로 추가된 포스트만 prepend
        const newPostIds = Array.from(currentPostIds).filter(id => !previousGalleryPostIds.has(id));
        if (newPostIds.length > 0) {
            const newGroups = sortedGroups.filter(g => {
                const postId = getPostIdFromPhotoGroup(g);
                return newPostIds.includes(postId);
            });
            
            if (newGroups.length > 0) {
                // 헤더가 없으면 추가
                const existingHeader = container.querySelector('.bg-white.border-b.border-slate-200.sticky');
                if (!existingHeader && userProfileHeader) {
                    const headerDiv = document.createElement('div');
                    headerDiv.innerHTML = userProfileHeader;
                    container.insertBefore(headerDiv.firstChild, container.firstChild);
                }
                
                // 새 포스트를 맨 위에 추가
                const newPostsHtml = newGroups.map((photoGroup, idx) => {
                    const postId = getPostIdFromPhotoGroup(photoGroup);
                    const existingIdx = Array.from(currentPostIds).indexOf(postId);
                    return renderPostGroup(photoGroup, existingIdx);
                }).join('');
                
                const fragment = document.createDocumentFragment();
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = newPostsHtml;
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
                
                // 헤더 다음에 삽입
                const firstPost = container.querySelector('.instagram-post');
                if (firstPost) {
                    container.insertBefore(fragment, firstPost);
                } else {
                    container.appendChild(fragment);
                }
                
                // 이전 포스트 ID 목록 업데이트
                previousGalleryPostIds = new Set(currentPostIds);
                
                // 이벤트 리스너만 다시 설정 (전체 재렌더링 없이)
                setTimeout(() => {
                    if (abortSignal.aborted) return;
                    setupGalleryEventListeners(container, sortedGroups, { abortSignal });
                    fetchMissingSharedComments(container).catch(() => {});
                    setupIntersectionObserver(container, abortSignal);
                }, 50);
                
                isRenderingGallery = false;
                return; // 차등 업데이트 완료
            }
        }
        
        // 차등 업데이트 실패 시 전체 재렌더링으로 폴백
        container.innerHTML = headerHtml + '<div id="galleryPostsInsertPoint"></div>' + loadMoreHtml;
    }

    // 더보기 이벤트 리스너 (초기 구조에 포함했으므로 여기서 바인딩)
    const postsInsertPoint = document.getElementById('galleryPostsInsertPoint') || container;
    if (canLoadMore) {
        const loadMoreWrap = document.getElementById('galleryLoadMoreWrap');
        const loadMoreBtn = document.getElementById('galleryLoadMoreBtn');
        const doLoadMore = async () => {
            if (!loadMoreBtn || loadMoreBtn.disabled) return;
            const hasMore = appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc;
            if (!hasMore) return;
            loadMoreBtn.disabled = true;
            loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i>로딩 중...';
            try {
                const { loadSharedPhotosPage } = await import('./db.js');
                const { docs, lastDoc, hasMore: nextHasMore } = await loadSharedPhotosPage(10, appState.sharedPhotosFeedLastDoc);
                appState.galleryFeedNetworkError = false;
                window.sharedPhotosFeed = [...(window.sharedPhotosFeed || []), ...docs];
                appState.sharedPhotosFeedLastDoc = lastDoc;
                appState.sharedPhotosFeedHasMore = nextHasMore;
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>더보기';
                if (!nextHasMore && loadMoreWrap) loadMoreWrap.remove();
                // 전체 재렌더 대신 새 포스트만 추가 (깜박임 방지)
                appendGalleryPosts(docs, loadMoreWrap);
            } catch (e) {
                console.error('공유 사진 더보기 실패:', e);
                appState.galleryFeedNetworkError = true;
                if (typeof showToast === 'function') showToast('네트워크가 끊겼습니다. 연결을 확인한 뒤 다시 시도해 주세요.', 'error');
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-chevron-down mr-1.5"></i>다시 시도';
            }
        };
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', doLoadMore);
            if (loadMoreWrap && typeof IntersectionObserver !== 'undefined') {
                const loadMoreObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (entry.isIntersecting && (appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc) && !loadMoreBtn.disabled) {
                            doLoadMore();
                        }
                    });
                }, { rootMargin: '200px', threshold: 0.1 });
                loadMoreObserver.observe(loadMoreWrap);
            }
        }
    }

    // 초기 렌더링: 최대 10건 먼저 표시, 나머지는 더보기/스크롤로 로드
    const estimatedPostHeight = 600; // 각 포스트의 예상 높이
    const INITIAL_POSTS_COUNT = Math.min(10, Math.max(1, sortedGroups.length)); // 10건씩 끊어서 표시
    
    // 초기 포스트만 먼저 렌더링 (비동기 배치 처리로 브라우저 블로킹 방지)
    const initialPosts = sortedGroups.slice(0, INITIAL_POSTS_COUNT);
    
    // 렌더링을 배치로 나누어 실행 (브라우저 프리즈 방지)
    let renderedIndex = 0;
    const POSTS_PER_BATCH = 2; // 한 번에 렌더링할 포스트 수 (작게 설정하여 블로킹 방지)
    
    function renderNextBatch() {
        // AbortSignal 체크
        if (abortSignal.aborted) {
            console.log('[renderGallery] AbortSignal 감지 - 배치 렌더링 중단');
            isRenderingGallery = false;
            return;
        }
        
        if (renderedIndex >= initialPosts.length) {
            // 모든 초기 포스트 렌더링 완료
            // 나머지 포스트는 placeholder로 렌더링 (스크롤 시 실제 포스트로 교체)
            if (sortedGroups.length > INITIAL_POSTS_COUNT) {
                const remainingCount = sortedGroups.length - INITIAL_POSTS_COUNT;
                const placeholderHtml = `<div id="gallery-placeholder" data-remaining="${remainingCount}" data-start-index="${INITIAL_POSTS_COUNT}" style="height: ${remainingCount * estimatedPostHeight}px;"></div>`;
                const placeholderDiv = document.createElement('div');
                placeholderDiv.innerHTML = placeholderHtml;
                postsInsertPoint.appendChild(placeholderDiv.firstChild);
            }
            // 더보기는 초기 구조에 이미 포함됨 (배치 완료 대기 없이 표시)

            // 이전 포스트 ID 목록 업데이트 (전체 재렌더링인 경우)
            previousGalleryPostIds = new Set(currentPostIds);
            // 코멘트 채우기는 50ms 대기 없이 곧바로 실행 (체감: 텍스트가 사진보다 늦게 뜨는 현상 완화)
            (() => {
                if (abortSignal.aborted) return;
                setupGalleryEventListeners(container, sortedGroups, { abortSignal });
                fetchMissingSharedComments(container, sharedCommentsPromise).catch(() => {});
            })();
            setTimeout(() => {
                if (abortSignal.aborted) {
                    console.log('[renderGallery] AbortSignal 감지 - 이벤트 리스너 설정 중단');
                    isRenderingGallery = false;
                    return;
                }
                // IntersectionObserver 설정 (포스트 렌더링 및 상호작용 로드용)
                setTimeout(() => {
                    if (abortSignal.aborted) {
                        console.log('[renderGallery] AbortSignal 감지 - Observer 설정 중단');
                        isRenderingGallery = false;
                        return;
                    }
                    setupIntersectionObserver(container, abortSignal);
                    setupLazyPostRenderer(container, sortedGroups, INITIAL_POSTS_COUNT, abortSignal);
                }, 200);
                
                // Comment "더 보기" 버튼 표시 여부 확인 및 위치 조정
                setTimeout(() => {
                    if (abortSignal.aborted) return;
                    initialPosts.forEach((photoGroup, idx) => {
                        const collapsedEl = document.getElementById(`post-caption-collapsed-${idx}`);
                        const toggleBtn = document.getElementById(`post-caption-toggle-${idx}`);
                        
                        if (collapsedEl && toggleBtn) {
                            const collapsedHeight = collapsedEl.scrollHeight;
                            const lineHeight = parseFloat(getComputedStyle(collapsedEl).lineHeight) || 20;
                            const maxHeight = lineHeight * 2;
                            
                            if (collapsedHeight > maxHeight + 2 && toggleBtn.classList.contains('hidden')) {
                                toggleBtn.classList.remove('hidden');
                            }
                        }
                    });
                }, 100);
                
                // 갤러리 렌더링 완료 후: 초기 진입은 맨 위로, 더보기 시에는 스크롤 위치 복원
                if (!abortSignal.aborted) {
                    if (skipScrollToTop && savedScrollY > 0) {
                        requestAnimationFrame(() => {
                            window.scrollTo({ top: savedScrollY, behavior: 'auto' });
                        });
                    } else if (!skipScrollToTop) {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                }
            }, 50);
            
            return;
        }
        
        // 다음 배치 렌더링
        const batch = initialPosts.slice(renderedIndex, renderedIndex + POSTS_PER_BATCH);
        const batchHtml = batch.map((photoGroup, batchIdx) => {
            const groupIdx = renderedIndex + batchIdx;
            return renderPostGroup(photoGroup, groupIdx);
        }).join('');
        
        // DocumentFragment 사용하여 DOM 조작 최적화
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = batchHtml;
        while (tempDiv.firstChild) {
            fragment.appendChild(tempDiv.firstChild);
        }
        postsInsertPoint.appendChild(fragment);
        
        renderedIndex += POSTS_PER_BATCH;
        
        // 다음 배치를 다음 프레임에서 실행 (브라우저가 렌더링할 시간을 줌)
        requestAnimationFrame(() => {
            setTimeout(renderNextBatch, 0);
        });
    }
    
    // 첫 배치 렌더링 시작
    renderNextBatch();
    
    // Lazy Post Renderer 설정 함수 (스크롤 시 포스트 렌더링)
    function setupLazyPostRenderer(container, sortedGroups, initialCount, abortSignal = null) {
        const placeholder = document.getElementById('gallery-placeholder');
        if (!placeholder || sortedGroups.length <= initialCount) return;
        
        // AbortSignal 체크
        if (abortSignal && abortSignal.aborted) {
            return;
        }
        
        let renderedCount = initialCount;
        let isRendering = false;
        const POSTS_PER_BATCH = 3; // 한 번에 렌더링할 포스트 수
        const estimatedPostHeight = 600;
        
        // Placeholder를 관찰하는 Observer (전역 변수에 저장하여 나중에 정리 가능)
        placeholderObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // AbortSignal 체크 (새 렌더 시작 시 placeholderObserver가 null일 수 있음)
                if (abortSignal && abortSignal.aborted) {
                    if (placeholderObserver) {
                        placeholderObserver.disconnect();
                        placeholderObserver = null;
                    }
                    return;
                }
                
                if (entry.isIntersecting && !isRendering && renderedCount < sortedGroups.length) {
                    isRendering = true;
                    
                    // 배치로 포스트 렌더링
                    function renderNextLazyBatch() {
                        // AbortSignal 체크 (새 렌더 시작 시 placeholderObserver가 null일 수 있음)
                        if (abortSignal && abortSignal.aborted) {
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        if (renderedCount >= sortedGroups.length) {
                            // 모든 포스트 렌더링 완료
                            if (placeholder && placeholder.parentNode) {
                                placeholder.remove();
                            }
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        // DOM 존재 확인 (새 렌더로 placeholder가 제거되었을 수 있음)
                        if (!document.contains(placeholder)) {
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                            isRendering = false;
                            return;
                        }
                        
                        const batch = sortedGroups.slice(renderedCount, renderedCount + POSTS_PER_BATCH);
                        const batchHtml = batch.map((photoGroup, batchIdx) => {
                            const groupIdx = renderedCount + batchIdx;
                            return renderPostGroup(photoGroup, groupIdx);
                        }).join('');
                        
                        // Placeholder 앞에 포스트 삽입
                        const fragment = document.createDocumentFragment();
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = batchHtml;
                        while (tempDiv.firstChild) {
                            fragment.appendChild(tempDiv.firstChild);
                        }
                        
                        if (placeholder && placeholder.parentNode) {
                            placeholder.parentNode.insertBefore(fragment, placeholder);
                        }
                        
                        renderedCount += POSTS_PER_BATCH;
                        
                        // Placeholder 높이 조정
                        const remaining = sortedGroups.length - renderedCount;
                        if (remaining > 0 && placeholder) {
                            placeholder.style.height = `${remaining * estimatedPostHeight}px`;
                        } else {
                            if (placeholder && placeholder.parentNode) {
                                placeholder.remove();
                            }
                            if (placeholderObserver) {
                                placeholderObserver.disconnect();
                                placeholderObserver = null;
                            }
                        }
                        
                        // 다음 배치 렌더링 (다음 프레임)
                        if (renderedCount < sortedGroups.length && (!abortSignal || !abortSignal.aborted)) {
                            requestAnimationFrame(() => {
                                if (!abortSignal || !abortSignal.aborted) {
                                    setTimeout(renderNextLazyBatch, 50);
                                }
                            });
                        } else {
                            isRendering = false;
                        }
                    }
                    
                    renderNextLazyBatch();
                }
            });
        }, {
            rootMargin: '200px' // 화면 밖 200px 전에 미리 렌더링
        });
        
        placeholderObserver.observe(placeholder);
    }
    
    // Intersection Observer 설정 함수
    function setupIntersectionObserver(container, abortSignal = null) {
        if (!window.postInteractions) return;
        
        // AbortSignal 체크
        if (abortSignal && abortSignal.aborted) {
            return;
        }
        
        // 이전 Observer 정리
        if (intersectionObserver) {
            intersectionObserver.disconnect();
        }
        
        // 새 Observer 생성: 화면에 보이는 포스트만 로드 (배치 처리)
        intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // AbortSignal 체크
                if (abortSignal && abortSignal.aborted) {
                    return;
                }
                
                if (entry.isIntersecting) {
                    const postEl = entry.target;
                    
                    // DOM 존재 확인
                    if (!document.contains(postEl)) {
                        return;
                    }
                    
                    const postId = postEl.getAttribute('data-post-id');
                    
                    if (!postId || loadedPostIds.has(postId)) {
                        return;
                    }
                    
                    loadedPostIds.add(postId);
                    postLoadQueue.push({ postEl, postId });
                    
                    if (!postLoadBatchTimer && (!abortSignal || !abortSignal.aborted)) {
                        postLoadBatchTimer = setTimeout(() => {
                            if (!abortSignal || !abortSignal.aborted) {
                                processPostLoadQueue();
                            }
                        }, BATCH_DELAY);
                    }
                }
            });
        }, {
            rootMargin: '100px' // 화면 밖 100px 전에 미리 로드 (50px에서 증가 - 너무 작으면 스크롤 시 깜빡임 발생)
        });
        
        // 모든 포스트에 Observer 연결 (렌더링 완료 후 지연 연결)
        setTimeout(() => {
            // AbortSignal 체크
            if (abortSignal && abortSignal.aborted) {
                return;
            }
            
            const posts = container.querySelectorAll('.instagram-post');
            posts.forEach(post => {
                if (abortSignal && abortSignal.aborted) {
                    return;
                }
                if (document.contains(post)) {
                    intersectionObserver.observe(post);
                }
            });
        }, 300); // 100ms에서 300ms로 증가 (초기 렌더링 완료 후 연결)
    }
    
    console.log('[renderGallery] 완료, 렌더링된 그룹 수:', sortedGroups.length, '전체 sharedPhotos:', window.sharedPhotos?.length || 0);
    } catch (error) {
        console.error('[renderGallery] 오류 발생:', error);
        console.error('[renderGallery] 스택:', error.stack);
    } finally {
        isRenderingGallery = false;
        // AbortController는 다음 renderGallery 호출 시 새로운 것으로 교체되므로 여기서는 null로 설정하지 않음
        // (현재 렌더링의 비동기 작업들이 완료될 때까지 유지)
    }
}

// 갤러리 사용자 필터링 함수
export function filterGalleryByUser(userId, userNickname) {
    // 모먼트 피드에서 사용자 클릭 시 진입 → 뒤로가기 시 모먼트로 복귀. openUserProfileFromBoard에서 'board'로 덮어씀
    if (appState.galleryFilterEntryTab === undefined || appState.galleryFilterEntryTab === null) {
        appState.galleryFilterEntryTab = 'gallery';
    }
    appState.galleryFilterUserId = userId;
    renderGallery();
}

// 갤러리 필터링 해제 함수 (뒤로가기 시 진입했던 탭으로 복귀)
export async function clearGalleryFilter() {
    const returnTab = appState.galleryFilterEntryTab;
    appState.galleryFilterUserId = null;
    appState.galleryFilterTab = 'moment';
    appState.galleryFilterEntryTab = null;
    const mainHeader = document.querySelector('#mainApp > header');
    if (mainHeader) mainHeader.classList.remove('hidden');
    if (returnTab === 'board') {
        if (typeof window.switchMainTab === 'function') window.switchMainTab('board');
        return;
    }
    // 전체 피드로 복귀 시 첫 페이지 로드 (sharedPhotosFeed 초기화)
    if (window.sharedPhotosFeed.length === 0) {
        try {
            const { loadSharedPhotosPage } = await import('./db.js');
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
            appState.galleryFeedNetworkError = false;
            window.sharedPhotosFeed = docs;
            appState.sharedPhotosFeedLastDoc = lastDoc;
            appState.sharedPhotosFeedHasMore = hasMore;
        } catch (e) {
            console.error('모먼트 피드 로드 실패:', e);
            appState.galleryFeedNetworkError = true;
            window.sharedPhotosFeed = [];
        }
    }
    renderGallery();
}

// 사용자 프로필 뷰에서 모먼트/밀톡 탭 전환
export function switchGalleryFilterTab(tab) {
    if (tab !== 'moment' && tab !== 'board') return;
    appState.galleryFilterTab = tab;
    renderGallery();
    if (window.syncBottomNavForGalleryFilter) window.syncBottomNavForGalleryFilter();
}

export async function renderFeed() {
    const container = document.getElementById('feedContent');
    if (!container) return;
    const photosToUse = window.sharedPhotosFeed || [];
    
    if (photosToUse.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-images text-4xl text-slate-200 mb-3"></i>
                <p class="text-xs font-bold text-slate-400">공유된 사진이 없습니다</p>
                <p class="text-[10px] text-slate-300 mt-1">타임라인에서 사진을 공유해보세요!</p>
            </div>
        `;
        return;
    }
    
    // 사용자 필터링 적용
    const filterUserId = appState.galleryFilterUserId;
    let photosToRender = photosToUse;
    
    if (filterUserId) {
        photosToRender = photosToUse.filter(photo => photo.userId === filterUserId);
    }
    
    // 중복 제거: 같은 photoUrl과 entryId 조합은 하나만 표시
    const seen = new Set();
    const uniquePhotos = photosToRender.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    
    // entryId와 userId로 그룹화 (같은 기록의 사진들을 묶음)
    // 중요: 하나의 게시물(entryId)은 앨범에 한 번만 표시되어야 하므로, entryId와 userId만 사용
    // 일간보기 공유(type: 'daily')는 date와 userId로 그룹화
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        let groupKey;
        if (photo.type === 'daily') {
            // 일간보기 공유: date_userId로 그룹화 (같은 날짜의 일간보기 공유는 하나로 묶음)
            groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        } else if (photo.type === 'best') {
            // 베스트 공유: id_userId로 그룹화 (베스트 공유는 각각 고유)
            groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        } else if (photo.type === 'insight') {
            // 인사이트 공유: dateRangeText_userId로 그룹화 (같은 기간의 인사이트 공유는 하나로 묶음)
            groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        } else if (photo.entryId) {
            // entryId가 있는 경우: entryId_userId로 그룹화
            groupKey = `${photo.entryId}_${photo.userId}`;
        } else {
            // entryId가 없는 경우: no-entry_userId로 그룹화
            groupKey = `no-entry_${photo.userId}`;
        }
        if (!groupedPhotos[groupKey]) {
            groupedPhotos[groupKey] = [];
        }
        groupedPhotos[groupKey].push(photo);
    });
    
    // 다른 사용자들의 최신 프로필 미리 로드 (프로필 변경 시 다른 사용자도 최신 설정으로 표시)
    const feedUserIds = [...new Set(uniquePhotos.map(p => p.userId).filter(Boolean))];
    await fetchUserProfiles(feedUserIds);
    
    // 각 그룹 내 사진을 Firestore photoIndex 기준으로만 정렬 (글쓴이/다른 사용자 동일 순서 보장)
    const photoSortTieBreakerSimple = (a, b) => {
        const aKey = String(a.id ?? normalizeUrl(a.photoUrl) ?? '');
        const bKey = String(b.id ?? normalizeUrl(b.photoUrl) ?? '');
        return aKey.localeCompare(bKey, 'en');
    };
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        photoGroup.sort((a, b) => {
            const ai = a.photoIndex;
            const bi = b.photoIndex;
            if (typeof ai === 'number' && typeof bi === 'number') {
                const cmp = ai - bi;
                if (cmp !== 0) return cmp;
            }
            const cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            return cmp !== 0 ? cmp : photoSortTieBreakerSimple(a, b);
        });
    });
    
    // 그룹을 시간순으로 정렬 (동점 시 2차 키로 동일 순서 보장)
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        const cmp = timeB - timeA; // 최신순
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
    
    container.innerHTML = sortedGroups.map((photoGroup, groupIdx) => {
        const photo = photoGroup[0]; // 첫 번째 사진의 정보 사용
        const photoCount = photoGroup.length;
        
        // 그룹 내에서 entryId 찾기 (첫 번째 사진에 없으면 다른 사진에서 찾기)
        let entryId = photo.entryId;
        if (!entryId || entryId === '' || entryId === 'null' || entryId === 'undefined') {
            const photoWithEntryId = photoGroup.find(p => {
                const pEntryId = p.entryId;
                return pEntryId && pEntryId !== '' && pEntryId !== 'null' && pEntryId !== 'undefined';
            });
            if (photoWithEntryId) {
                entryId = photoWithEntryId.entryId;
            }
        }
        
        // 베스트 공유인지 확인 (먼저 확인)
        const isBestShare = photo.type === 'best';
        
        // 일간보기 공유인지 확인
        const isDailyShare = photo.type === 'daily';
        
        // 인사이트 공유인지 확인
        const isInsightShare = photo.type === 'insight';
        
        const postId = getPostIdFromPhotoGroup(photoGroup);
        const alternatePostIds = photoGroup.map(p => p.id).filter(Boolean).join(',');
        
        // 본인 게시물인지 확인
        const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
        
        // 게스트 모드 확인 (본인 게시물이고 게스트인 경우)
        const isGuestPost = isMyPost && window.currentUser && window.currentUser.isAnonymous;
        
        // 공유 금지 상태 확인 (그룹 내 사진 중 하나라도 금지된 것이 있으면 금지 상태로 표시)
        const isBanned = photoGroup.some(p => p.banned === true);
        
        // 일자 정보
        const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
        const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        
        // 끼니 구분 정보 및 색상
        let mealLabel = '';
        let mealLabelStyle = '';
        if (photo.slotId) {
            const slot = SLOTS.find(s => s.id === photo.slotId);
            mealLabel = slot ? slot.label : '';
            if (slot) {
                const slotStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                mealLabelStyle = `${slotStyle.text} ${slotStyle.iconBg}`;
            }
        }
        
        // 간식인지 확인 (slotId로 간식 타입 확인)
        const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
        
        // Comment 정보 가져오기
        // 일간보기 공유는 하루 전체 comment를 caption에 표시하므로, 개별 식사 comment는 사용하지 않음
        let comment = '';
        if (!isDailyShare) {
            // 1. photo 객체에 comment가 있으면 우선 사용
            // 2. entryId가 있고 mealHistory에서 찾을 수 있으면 사용
            if (photo.comment) {
                comment = photo.comment;
            } else if (entryId && window.mealHistory) {
                const mealRecord = window.mealHistory.find(m => m.id === entryId);
                if (mealRecord) {
                    comment = mealRecord.comment || '';
                }
            }
            
            // entryId가 없어도 comment가 있거나, 같은 날짜/슬롯의 기록을 찾아서 entryId 찾기
            if (!entryId && window.mealHistory && photo.date && photo.slotId) {
                // photo의 comment나 다른 정보로 mealHistory에서 매칭되는 기록 찾기
                const matchingRecord = window.mealHistory.find(m => 
                    m.date === photo.date && 
                    m.slotId === photo.slotId &&
                    (photo.comment ? (m.comment === photo.comment) : true)
                );
                if (matchingRecord) {
                    entryId = matchingRecord.id;
                    if (!comment && matchingRecord.comment) {
                        comment = matchingRecord.comment;
                    }
                }
            }
        }
        
        let caption = '';
        if (isBestShare) {
            // 베스트 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isDailyShare) {
            // 일간보기 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isInsightShare) {
            // 인사이트 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isSnack) {
            // 간식인 경우: "메뉴 @ 장소" 형식 (장소만 있으면 "@ 장소")
            const menu = photo.menuDetail || photo.snackType;
            if (photo.place && menu) {
                caption = `${menu} @ ${photo.place}`;
            } else if (photo.place) {
                caption = `@ ${photo.place}`;
            } else if (menu) {
                caption = menu;
            } else {
                caption = '간식';
            }
        } else {
            // 일반 식사인 경우: "메뉴 @ 장소" 형식
            if (photo.place && photo.menuDetail) {
                caption = `${photo.menuDetail} @ ${photo.place}`;
            } else if (photo.place) {
                caption = `@ ${photo.place}`;
            } else if (photo.menuDetail) {
                caption = photo.menuDetail;
            } else if (photo.mealType) {
                caption = photo.mealType;
            }
        }
        
        const captionAttr = (caption || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        
        // 사진 비율: shared doc 또는 meal 기록에서 가져오기
        let aspectRatio = photo.photoAspectRatio || (entryId && window.mealHistory ? (window.mealHistory.find(m => m.id === entryId)?.photoAspectRatio) : null) || '1:1';
        if (aspectRatio !== '1:1' && aspectRatio !== '3:4' && aspectRatio !== '4:3') aspectRatio = '1:1';
        const momentAspectCss = (aspectRatio === '3:4' ? '3/4' : aspectRatio === '4:3' ? '4/3' : '1');
        const photosHtml = photoGroup.map((p, idx) => {
            const isBest = p.type === 'best';
            const isDaily = p.type === 'daily';
            const isInsight = p.type === 'insight';
            const photoBanned = p.banned === true;
            return `
            <div class="flex-shrink-0 w-full snap-start relative ${(isBest || isDaily || isInsight) ? 'bg-white' : ''}" ${(isBest || isDaily || isInsight) ? 'style="display: flex; align-items: flex-start; justify-content: center;"' : ''}>
                ${(isBest || isDaily || isInsight) ? `<img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="w-full h-auto object-contain ${photoBanned ? 'opacity-50' : ''}" style="display: block; width: 100%; height: auto; vertical-align: top;" loading="${idx <= 1 ? 'eager' : 'lazy'}">` : `<div class="w-full relative overflow-hidden" style="aspect-ratio: ${momentAspectCss};"><img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="absolute inset-0 w-full h-full object-cover ${photoBanned ? 'opacity-50' : ''}" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`}
                ${photoBanned && !(isBest || isDaily || isInsight) ? `
                    <div class="absolute inset-0 bg-orange-500/20 flex items-center justify-center">
                        <div class="bg-orange-600 text-white px-3 py-1.5 rounded-lg">
                            <i class="fa-solid fa-ban mr-1"></i>공유 금지
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
        }).join('');
        
        const userDisplay = getDisplayProfile(photo.userId, { nickname: photo.userNickname, icon: photo.userIcon, photoUrl: photo.userPhotoUrl });
        const avatarDisplay = getProfileAvatarDisplay(userDisplay);
        return `
            <div class="mb-4 bg-white border ${isBanned ? 'border-orange-300' : 'border-slate-100'} rounded-2xl overflow-hidden instagram-post" data-post-id="${postId}" data-post-id-alternates="${alternatePostIds}">
                <div class="px-2 py-3 flex items-center gap-3 relative">
                    ${avatarDisplay.type === 'photo' ? `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden border-2 border-slate-300 relative" style="background-image: url(${avatarDisplay.value}); background-size: cover; background-position: center;">
                            ${isGuestPost ? '<span class="absolute bottom-0 right-0 bg-black/70 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center border border-white">게</span>' : ''}
                        </div>
                    ` : `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border-2 border-slate-300 ${avatarDisplay.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200 text-lg'}">
                            ${isGuestPost ? '게' : (avatarDisplay.type === 'default' ? '<i class="fa-solid fa-user text-lg"></i>' : escapeHtml(avatarDisplay.value))}
                        </div>
                    `}
                    <div class="flex-1 min-w-0 mr-2">
                        <div class="text-sm font-bold text-slate-800">${userDisplay.nickname}</div>
                        <div class="flex items-center gap-1 flex-wrap">
                            <span class="text-xs text-slate-400">${dateStr}</span>
                            ${mealLabel ? `<span class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap ml-1">${mealLabel}</span>` : ''}
                        </div>
                    </div>
                    ${isBanned ? `<div class="text-[10px] font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0"><i class="fa-solid fa-ban mr-1"></i>공유 금지</div>` : ''}
                    <div class="relative flex-shrink-0">
                        <button data-entry-id="${entryId || ''}" data-photo-urls="${(photoGroup.map(p => p.photoUrl).filter(Boolean).join(',') || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-caption="${captionAttr}" data-is-best="${isBestShare ? 'true' : 'false'}" data-is-daily="${isDailyShare ? 'true' : 'false'}" data-is-insight="${isInsightShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-date-range-text="${photo.dateRangeText || ''}" data-photo-slot-id="${photo.slotId || ''}" data-post-id="${postId || ''}" data-author-user-id="${photo.userId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                            <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                        </button>
                    </div>
                </div>
                <div class="relative overflow-hidden ${(isDailyShare || isInsightShare) ? 'bg-white' : 'bg-slate-100'}">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide gallery-photo-scroll" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute top-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${caption ? `<div class="px-4 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
                ${comment && !isBestShare && !isDailyShare && !isInsightShare ? (() => {
                    // comment의 줄바꿈 개수 확인
                    const lineBreaks = (comment.match(/\n/g) || []).length;
                    // 대략적인 텍스트 길이로도 확인 (한 줄에 약 30자 정도로 가정)
                    const estimatedLines = Math.ceil(comment.length / 30);
                    const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
                    const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
                    
                    return `
                    <div class="px-4 pb-3 text-sm text-slate-600">
                        <span id="feed-comment-collapsed-${groupIdx}" class="comment-text whitespace-pre-line line-clamp-2 inline">${escapeHtml(comment).replace(/\n/g, '<br>')}</span>
                        <button onclick="window.toggleFeedComment(${groupIdx})" id="feed-comment-toggle-${groupIdx}" class="inline text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors ml-1 ${toggleBtnClass}">더 보기</button>
                        <div id="feed-comment-expanded-${groupIdx}" class="comment-text whitespace-pre-line hidden">
                            ${escapeHtml(comment).replace(/\n/g, '<br>')}
                            <button onclick="window.toggleFeedComment(${groupIdx})" id="feed-comment-collapse-${groupIdx}" class="inline text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors ml-1">접기</button>
                        </div>
                    </div>
                `;
                })() : ''}
            </div>
        `;
    }).join('');
    
    // 사진 카운터 업데이트를 위한 이벤트 리스너 추가 및 피드 옵션 버튼 이벤트 리스너 추가
    setTimeout(() => {
        const scrollContainers = container.querySelectorAll('.gallery-photo-scroll');
        scrollContainers.forEach((scrollContainer, idx) => {
            const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
            const photos = Array.from(scrollContainer.children);
            const photoCount = sortedGroups[idx]?.length || 0;
            // 스크롤 종료 시 가장 가까운 사진으로 스냅 (한장한장 구분감)
            if (photoCount > 1) {
                // 웹(데스크톱): 마우스 드래그로 사진 스와이프 (document에 리스너 등록해 빠른 드래그도 포착)
                let isDragging = false;
                let startX = 0;
                let startScrollLeft = 0;
                scrollContainer.style.cursor = 'grab';
                const onMouseMove = (e) => {
                    if (!isDragging) return;
                    e.preventDefault();
                    const dx = e.pageX - startX;
                    scrollContainer.scrollLeft = Math.max(0, Math.min(scrollContainer.scrollWidth - scrollContainer.clientWidth, startScrollLeft - dx));
                };
                const endDrag = () => {
                    if (!isDragging) return;
                    isDragging = false;
                    scrollContainer.style.cursor = 'grab';
                    scrollContainer.style.userSelect = '';
                    document.removeEventListener('mousemove', onMouseMove, { capture: true });
                    document.removeEventListener('mouseup', endDrag, { capture: true });
                };
                scrollContainer.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    isDragging = true;
                    startX = e.pageX;
                    startScrollLeft = scrollContainer.scrollLeft;
                    scrollContainer.style.cursor = 'grabbing';
                    scrollContainer.style.userSelect = 'none';
                    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: false });
                    document.addEventListener('mouseup', endDrag, { capture: true });
                }, { passive: false });

                const snapToNearest = () => {
                    const sl = scrollContainer.scrollLeft;
                    const cw = scrollContainer.clientWidth;
                    let nearest = 0;
                    let minDist = Infinity;
                    photos.forEach((p, i) => {
                        const pos = p.offsetLeft + p.offsetWidth / 2;
                        const d = Math.abs(sl + cw / 2 - pos);
                        if (d < minDist) { minDist = d; nearest = i; }
                    });
                    const target = photos[nearest]?.offsetLeft ?? 0;
                    if (Math.abs(sl - target) > 2) {
                        scrollContainer.scrollTo({ left: target, behavior: 'smooth' });
                    }
                    preloadAdjacentGalleryImages(scrollContainer);
                };
                let snapTimeout = null;
                const onScrollEnd = () => {
                    clearTimeout(snapTimeout);
                    snapTimeout = setTimeout(snapToNearest, 80);
                };
                let preloadThrottle = null;
                const onScrollPreload = () => {
                    if (preloadThrottle) return;
                    preloadThrottle = setTimeout(() => { preloadThrottle = null; preloadAdjacentGalleryImages(scrollContainer); }, 50);
                };
                scrollContainer.addEventListener('scroll', onScrollEnd, { passive: true });
                scrollContainer.addEventListener('scroll', onScrollPreload, { passive: true });
                if ('onscrollend' in scrollContainer) {
                    scrollContainer.addEventListener('scrollend', snapToNearest);
                }
                preloadAdjacentGalleryImages(scrollContainer);
            }
            if (counter && photoCount > 1) {
                const slideEls = Array.from(scrollContainer.children);
                const updateCounter = () => {
                    const containerWidth = scrollContainer.clientWidth;
                    const scrollLeft = scrollContainer.scrollLeft;
                    let currentIndex = 1;
                    slideEls.forEach((slide, photoIdx) => {
                        const photoCenter = slide.offsetLeft + slide.offsetWidth / 2;
                        if (photoCenter >= scrollLeft && photoCenter <= scrollLeft + containerWidth) {
                            currentIndex = photoIdx + 1;
                        }
                    });
                    counter.textContent = currentIndex;
                };
                scrollContainer.addEventListener('scroll', updateCounter);
                updateCounter();
            }
        });
        
        // 피드 옵션 버튼에 이벤트 리스너 추가
        const feedOptionsButtons = container.querySelectorAll('.feed-options-btn');
        feedOptionsButtons.forEach(btn => {
            // 이미 이벤트 리스너가 추가되었는지 확인 (중복 방지)
            if (btn.hasAttribute('data-listener-added')) return;
            
            if (window.showFeedOptions) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const entryId = btn.getAttribute('data-entry-id') || '';
                    const photoUrls = btn.getAttribute('data-photo-urls') || '';
                    const isBestShare = btn.getAttribute('data-is-best') === 'true';
                    const photoDate = btn.getAttribute('data-photo-date') || '';
                    const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
                    const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
                    const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
                    const dateRangeText = btn.getAttribute('data-date-range-text') || '';
                    const postId = btn.getAttribute('data-post-id') || '';
                    const authorUserId = btn.getAttribute('data-author-user-id') || '';
                    const caption = btn.getAttribute('data-caption') || '';
                    window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
                });
                btn.setAttribute('data-listener-added', 'true');
            } else {
                // 함수가 아직 로드되지 않았으면 조금 후에 다시 시도
                setTimeout(() => {
                    if (window.showFeedOptions && !btn.hasAttribute('data-listener-added')) {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const entryId = btn.getAttribute('data-entry-id') || '';
                            const photoUrls = btn.getAttribute('data-photo-urls') || '';
                            const isBestShare = btn.getAttribute('data-is-best') === 'true';
                            const photoDate = btn.getAttribute('data-photo-date') || '';
                            const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
                            const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
                            const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
                            const dateRangeText = btn.getAttribute('data-date-range-text') || '';
                            const postId = btn.getAttribute('data-post-id') || '';
                            const authorUserId = btn.getAttribute('data-author-user-id') || '';
                            const caption = btn.getAttribute('data-caption') || '';
                            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
                        });
                        btn.setAttribute('data-listener-added', 'true');
                    }
                }, 200);
            }
        });
        
        // Feed Comment "더 보기" 버튼 표시 여부 확인 및 위치 조정 (DOM 렌더링 후)
        setTimeout(() => {
            sortedGroups.forEach((photoGroup, idx) => {
                const collapsedEl = document.getElementById(`feed-comment-collapsed-${idx}`);
                const expandedEl = document.getElementById(`feed-comment-expanded-${idx}`);
                const toggleBtn = document.getElementById(`feed-comment-toggle-${idx}`);
                const collapseBtn = document.getElementById(`feed-comment-collapse-${idx}`);
                
                if (collapsedEl && toggleBtn) {
                    // 실제 렌더링된 높이 측정
                    const collapsedHeight = collapsedEl.scrollHeight;
                    const lineHeight = parseFloat(getComputedStyle(collapsedEl).lineHeight) || 20;
                    const maxHeight = lineHeight * 2; // 2줄 높이
                    
                    // 실제 높이가 두 줄을 넘으면 "더 보기" 버튼 표시
                    if (collapsedHeight > maxHeight + 2 && toggleBtn.classList.contains('hidden')) {
                        toggleBtn.classList.remove('hidden');
                    }
                    
                    // 버튼 위치 조정: 텍스트의 마지막 줄과 같은 높이로
                    if (!toggleBtn.classList.contains('hidden')) {
                        const computedStyle = getComputedStyle(collapsedEl);
                        const textLineHeight = parseFloat(computedStyle.lineHeight) || 20;
                        // 마지막 줄의 baseline 위치 계산
                        const lastLineBottom = textLineHeight * 2; // line-clamp-2이므로 2줄
                        // 버튼 높이를 고려하여 위치 조정
                        const btnHeight = toggleBtn.offsetHeight || 16;
                        const offset = (textLineHeight - btnHeight) / 2; // 수직 중앙 정렬
                        const bottomPosition = (lastLineBottom - btnHeight - offset);
                        toggleBtn.style.bottom = `${Math.max(0, bottomPosition)}px`;
                    }
                    
                    // 접기 버튼 위치도 동일하게 조정 (확장된 텍스트가 보일 때)
                    if (expandedEl && collapseBtn && !expandedEl.classList.contains('hidden')) {
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
                }
            });
        }, 300);
        
        // 각 포스트의 좋아요, 북마크, 댓글 로드
        sortedGroups.forEach((photoGroup) => {
            const photo = photoGroup[0];
            // 그룹 키 생성 (postId 계산용)
            let groupKey;
            const isBestShare = photo.type === 'best';
            const isDailyShare = photo.type === 'daily';
            const isInsightShare = photo.type === 'insight';
            if (isDailyShare) {
                groupKey = `daily_${photo.date || 'no-date'}_${photo.userId || 'unknown'}`;
            } else if (isBestShare) {
                groupKey = `best_${photo.id || 'no-id'}_${photo.userId || 'unknown'}`;
            } else if (isInsightShare) {
                groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId || 'unknown'}`;
            } else {
                groupKey = `${photo.entryId || 'no-entry'}_${photo.userId || 'unknown'}`;
            }
            
            // postId 계산
            let postId = photoGroup[0]?.id || photo.id || null;
            if (!postId || postId === 'undefined' || postId === 'null') {
                let hash = 0;
                const ts = photo.timestamp || (photo.date ? photo.date + 'T12:00:00' : '') || '';
                const keyForHash = `${groupKey}_${ts}`;
                for (let i = 0; i < keyForHash.length; i++) {
                    hash = ((hash << 5) - hash) + keyForHash.charCodeAt(i);
                    hash = hash & hash;
                }
                postId = `post_${Math.abs(hash)}_${photo.userId || 'unknown'}`;
            }
            
            if (postId && window.postInteractions && window.currentUser && !window.currentUser.isAnonymous) {
                // 좋아요 상태 및 수 로드
                Promise.all([
                    window.postInteractions.isLiked(postId, window.currentUser.uid).catch(() => false),
                    window.postInteractions.getLikes(postId).catch(() => []),
                    window.postInteractions.isBookmarked(postId, window.currentUser.uid).catch(() => false)
                ]).then(([isLiked, likes, isBookmarked]) => {
                    const likeBtn = document.querySelector(`.post-like-btn[data-post-id="${postId}"]`);
                    const likeIcon = likeBtn?.querySelector('.post-like-icon');
                    const likeCountEl = document.querySelector(`.post-like-count[data-post-id="${postId}"]`);
                    const bookmarkBtn = document.querySelector(`.post-bookmark-btn[data-post-id="${postId}"]`);
                    const bookmarkIcon = bookmarkBtn?.querySelector('.post-bookmark-icon');
                    
                    if (likeBtn && likeIcon) {
                        if (isLiked) {
                            likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800');
                            likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
                        }
                    }
                    if (likeCountEl) {
                        likeCountEl.textContent = likes.length > 0 ? likes.length : '';
                    }
                    if (bookmarkBtn && bookmarkIcon && isBookmarked) {
                        bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark');
                        bookmarkIcon.classList.add('fa-solid', 'fa-bookmark');
                    }
                }).catch(e => {
                    console.error(`좋아요/북마크 상태 로드 실패 (postId: ${postId}):`, e);
                });
            }
            
            // 댓글 로드
            if (postId && window.loadPostComments) {
                window.loadPostComments(postId).catch(e => {
                    console.error(`댓글 로드 실패 (postId: ${postId}):`, e);
                });
            }
        });
    }, 100);
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

export function toggleFeedComment(groupIdx) {
    const collapsedEl = document.getElementById(`feed-comment-collapsed-${groupIdx}`);
    const expandedEl = document.getElementById(`feed-comment-expanded-${groupIdx}`);
    const toggleBtn = document.getElementById(`feed-comment-toggle-${groupIdx}`);
    const collapseBtn = document.getElementById(`feed-comment-collapse-${groupIdx}`);
    
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

// 일간보기 공유용 컴팩트 카드 생성
// 공지 목록 가져오기
async function getNotices() {
    try {
        const { collection, getDocs, query, orderBy, where } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const { db, appId } = await import('./firebase.js');
        const noticesColl = collection(db, 'artifacts', appId, 'notices');
        const q = query(noticesColl, orderBy('timestamp', 'desc'));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (e) {
        console.error("Get notices error:", e);
        return [];
    }
}

// 공지 렌더링
async function renderNotices() {
    const noticesContainer = document.getElementById('noticesContainer');
    if (!noticesContainer) return;
    
    try {
        const notices = await getNotices();
        const activeNotices = notices.filter(n => n && !n.deleted && !n.hidden); // 삭제·숨김 아닌 공지만 표시 (밀로그·밀톡용)
        
        if (activeNotices.length === 0) {
            noticesContainer.innerHTML = '';
            noticesContainer.classList.add('hidden');
            return;
        }
        
        // 상단 고정 공지와 일반 공지 분리 (isPinned === true만 고정)
        const pinnedNotices = activeNotices.filter(n => n.isPinned === true);
        const normalNotices = activeNotices.filter(n => n.isPinned !== true);
        const sortedNotices = [...pinnedNotices, ...normalNotices];
        
        const noticeTypeLabels = {
            'important': '중요',
            'notice': '알림',
            'light': '가벼운'
        };
        
        const noticeTypeColors = {
            'important': 'bg-red-100 text-red-700',
            'notice': 'bg-blue-100 text-blue-700',
            'light': 'bg-slate-100 text-slate-700'
        };
        const noticeTypeBorderColors = {
            'important': 'border-l-2 border-red-400',
            'notice': 'border-l-2 border-blue-400',
            'light': 'border-l-2 border-yellow-400'
        };

        // 로그인 사용자의 공지 하트/북마크 상태
        let likedNoticeIds = new Set();
        let bookmarkedNoticeIds = new Set();
        if (window.currentUser && !window.currentUser.isAnonymous && window.noticeOperations) {
            const [liked, bookmarkResults] = await Promise.all([
                window.noticeOperations.getNoticeIdsLikedByUser ? window.noticeOperations.getNoticeIdsLikedByUser(window.currentUser.uid) : [],
                window.noticeOperations.isNoticeBookmarked ? Promise.all(sortedNotices.map(n => window.noticeOperations.isNoticeBookmarked(n.id, window.currentUser.uid))) : Promise.resolve([])
            ]);
            likedNoticeIds = new Set(liked || []);
            bookmarkedNoticeIds = new Set(Array.isArray(bookmarkResults) ? sortedNotices.map((n, i) => bookmarkResults[i] ? n.id : null).filter(Boolean) : []);
        }
        
        // 공지별 하트(좋아요) 카운트 - noticeInteractions에서 isLike=true만 계산
        const reactionCounts = await Promise.all(sortedNotices.map(async (n) => {
            try {
                if (window.noticeOperations?.getNoticeReactionCounts) {
                    const c = await window.noticeOperations.getNoticeReactionCounts(n.id);
                    return { noticeId: n.id, likes: c?.likes ?? 0, dislikes: c?.dislikes ?? 0 };
                }
            } catch (e) {
                console.warn('공지 반응 카운트 로드 실패(무시):', n?.id, e);
            }
            return { noticeId: n.id, likes: 0, dislikes: 0 };
        }));
        const reactionMap = new Map(reactionCounts.map(r => [r.noticeId, r]));
        const adminDisplayName = await getAdminDisplayName();
        
        noticesContainer.innerHTML = sortedNotices.map((notice, index) => {
            let date = notice.timestamp ? (() => {
                // timestamp 안전하게 변환
                if (notice.timestamp.toDate && typeof notice.timestamp.toDate === 'function') {
                    return notice.timestamp.toDate();
                } else if (typeof notice.timestamp === 'string') {
                    return new Date(notice.timestamp);
                } else if (notice.timestamp instanceof Date) {
                    return notice.timestamp;
                } else {
                    return new Date(notice.timestamp);
                }
            })() : new Date();
            
            // 유효하지 않은 날짜인지 확인
            if (isNaN(date.getTime())) {
                console.warn('Invalid timestamp for notice:', notice.id, notice.timestamp);
                date = new Date();
            }
            
            const dateStr = date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
            const noticeContent = notice.content || '';
            const formattedPreview = escapeHtml(getPlainTextPreview(noticeContent));
            const noticeType = notice.type || notice.noticeType || 'notice';
            const typeLabel = noticeTypeLabels[noticeType] || '알림';
            const typeColor = noticeTypeColors[noticeType] || noticeTypeColors.notice;
            const typeBorder = noticeTypeBorderColors[noticeType] || noticeTypeBorderColors.notice;

            const reactions = reactionMap.get(notice.id) || { likes: 0, dislikes: 0 };
            const likeCount = reactions.likes || 0;
            const viewCount = Number(notice.views || notice.viewCount || notice.viewsCount || notice.viewCounts || 0) || 0;
            const isLiked = likedNoticeIds.has(notice.id);
            const isBookmarked = bookmarkedNoticeIds.has(notice.id);
            
            return `
                <div onclick="window.openNoticeDetail('${notice.id}')" class="board-list-card rounded-2xl pt-4 px-5 pb-1.5 shadow-sm hover:shadow-md cursor-pointer active:scale-[0.98] transition-all mb-2 ${typeBorder}">
                    <div class="flex items-start gap-3 mb-1.5">
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-3 flex-wrap">
                                ${notice.isPinned === true ? `<i class="fa-solid fa-thumbtack text-black text-xs"></i>` : ''}
                                <span class="text-[10px] font-bold px-2.5 py-1 rounded-lg ${typeColor} whitespace-nowrap shrink-0">${typeLabel}</span>
                                <h3 class="text-base font-bold text-slate-800 line-clamp-2 flex-1 min-w-0 leading-tight">${escapeHtml(notice.title || '제목 없음')}</h3>
                                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? '<span class="text-slate-400 shrink-0" title="사진 포함"><i class="fa-solid fa-image text-sm"></i></span>' : ''}
                            </div>
                            <p class="text-sm text-slate-600 line-clamp-2 mb-1.5 leading-relaxed">${formattedPreview}</p>
                        </div>
                    </div>
                    <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-sm flex-shrink-0 border-2 border-slate-300">
                                <i class="fa-solid fa-bullhorn text-slate-500 text-xs"></i>
                            </div>
                            <div>
                                <div class="text-xs font-bold text-slate-800">${escapeHtml(adminDisplayName)}</div>
                                <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="event.stopPropagation(); window.toggleNoticeLike('${notice.id}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'}"></i>
                                <span class="text-xs font-bold text-slate-800">${likeCount}</span>
                            </button>
                            <button onclick="event.stopPropagation(); window.toggleNoticeBookmark('${notice.id}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-notice-id="${notice.id}" ${!window.currentUser ? 'disabled' : ''}>
                                <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        noticesContainer.classList.remove('hidden');
    } catch (e) {
        console.error("공지 렌더링 오류:", e);
        noticesContainer.innerHTML = '';
        noticesContainer.classList.add('hidden');
    }
}

// 게시판 렌더링 함수 (optimisticPost: 새 글 등록 시 즉시 표시, options.excludePostId: 삭제 시 캐시에서 제외)
export async function renderBoard(category = 'all', optimisticPost = null, options = null) {
    const container = document.getElementById('boardContainer');
    if (!container) return;
    
    renderNotices();
    
    if (!window.boardOperations) return;
    
    const excludePostId = options?.excludePostId ?? null;
    const hasFilter = appState.boardTraceFilter && window.currentUser && !window.currentUser.isAnonymous;
    const tracePromise = hasFilter ? (() => {
        const f = appState.boardTraceFilter;
        if (f === 'like') return window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid);
        if (f === 'comment') return window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid);
        if (f === 'bookmark') return window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid);
        return Promise.resolve([]);
    })() : Promise.resolve(null);
    
    // 낙관적: 새 글만 즉시 표시
    if (optimisticPost?.id && (category === 'all' || optimisticPost.category === category)) {
        const optWithTimestamp = { ...optimisticPost, timestamp: optimisticPost.timestamp || new Date().toISOString() };
        const likedPostIds = new Set();
        const bookmarkedPostIds = new Set();
        let filteredPosts = [optWithTimestamp];
        const tracePostIds = null;
        await _renderBoardList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds);
        Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]).then(async ([traceList, posts, liked, bookmarked, commented]) => {
            const tracePostIds2 = traceList ? new Set(traceList) : null;
            const likedPostIds2 = new Set(liked || []);
            const bookmarkedPostIds2 = new Set(bookmarked || []);
            const postIdsCommentedByUser = new Set(commented || []);
            let merged = [optWithTimestamp, ...(posts || []).filter(p => p.id !== optimisticPost.id)];
            merged = tracePostIds2 ? merged.filter(p => tracePostIds2.has(p.id)) : merged;
            merged.sort((a, b) => (new Date(b.timestamp || 0).getTime()) - (new Date(a.timestamp || 0).getTime()));
            window._boardPostsCache = merged;
            await _renderBoardList(container, merged, likedPostIds2, bookmarkedPostIds2, tracePostIds2, postIdsCommentedByUser);
        }).catch(() => {});
        return;
    }
    
    // 낙관적: 삭제 시 캐시에서 제외하고 즉시 표시
    if (excludePostId && window._boardPostsCache && Array.isArray(window._boardPostsCache)) {
        let filteredPosts = window._boardPostsCache.filter(p => p.id !== excludePostId);
        const likedPostIds = new Set();
        const bookmarkedPostIds = new Set();
        const tracePostIds = null;
        await _renderBoardList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds);
        Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]).then(async ([traceList, posts, liked, bookmarked, commented]) => {
            const tracePostIds2 = traceList ? new Set(traceList) : null;
            const likedPostIds2 = new Set(liked || []);
            const bookmarkedPostIds2 = new Set(bookmarked || []);
            const postIdsCommentedByUser = new Set(commented || []);
            let merged = tracePostIds2 ? (posts || []).filter(p => tracePostIds2.has(p.id)) : (posts || []);
            merged = merged.filter(p => p.isHidden !== true);
            merged = merged.filter(p => p.id !== excludePostId);
            window._boardPostsCache = merged;
            await _renderBoardList(container, merged, likedPostIds2, bookmarkedPostIds2, tracePostIds2, postIdsCommentedByUser);
        }).catch(() => {});
        return;
    }
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
                <p class="text-sm text-slate-400">게시글을 불러오는 중...</p>
            </div>
        </div>
    `;
    
    try {
        const [traceList, posts, liked, bookmarked, commented] = await Promise.all([
            tracePromise,
            window.boardOperations.getPosts(category, 'latest', 50),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsLikedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsBookmarkedByUser(window.currentUser.uid) : Promise.resolve([]),
            window.currentUser && !window.currentUser.isAnonymous ? window.boardOperations.getPostIdsCommentedByUser(window.currentUser.uid) : Promise.resolve([])
        ]);
        
        const tracePostIds = traceList ? new Set(traceList) : null;
        const likedPostIds = new Set(liked || []);
        const bookmarkedPostIds = new Set(bookmarked || []);
        const postIdsCommentedByUser = new Set(commented || []);
        
        let filteredPosts = tracePostIds ? posts.filter(p => tracePostIds.has(p.id)) : posts;
        if (excludePostId) filteredPosts = filteredPosts.filter(p => p.id !== excludePostId);
        
        filteredPosts.sort((a, b) => {
            const getTimestamp = (post) => {
                if (!post.timestamp) return 0;
                if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') return post.timestamp.toDate().getTime();
                if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
                if (post.timestamp instanceof Date) return post.timestamp.getTime();
                return new Date(post.timestamp || 0).getTime();
            };
            return getTimestamp(b) - getTimestamp(a);
        });
        window._boardPostsCache = filteredPosts;
        await _renderBoardList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds, postIdsCommentedByUser);
    } catch (error) {
        console.error("게시판 로드 오류:", error);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">게시글을 불러올 수 없습니다</p>
                <p class="text-xs text-slate-300 mt-2">잠시 후 다시 시도해주세요</p>
            </div>
        `;
    }
}

async function _renderBoardList(container, filteredPosts, likedPostIds, bookmarkedPostIds, tracePostIds, postIdsCommentedByUser = new Set()) {
    if (!container) return;
    // 다른 사용자들의 최신 프로필 미리 로드 (프로필 변경 시 다른 사용자도 최신 설정으로 표시)
    const authorIds = [...new Set((filteredPosts || []).map(p => p.authorId).filter(Boolean))];
    await fetchUserProfiles(authorIds);
    if (filteredPosts.length === 0) {
        const traceEmptyLabels = { like: '좋아요한', comment: '댓글 단', bookmark: '북마크한' };
        const traceEmptyMsg = tracePostIds
            ? (traceEmptyLabels[appState.boardTraceFilter] || '') + ' 게시글이 없습니다'
            : '게시글이 없습니다';
        const traceEmptySub = tracePostIds ? '다른 게시글에 좋아요, 댓글, 북마크를 남겨보세요!' : '첫 번째 게시글을 작성해보세요!';
        const traceEmptyIcon = appState.boardTraceFilter === 'like' ? 'fa-heart' : (appState.boardTraceFilter === 'comment' ? 'fa-comment' : 'fa-bookmark');
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-regular ${tracePostIds ? traceEmptyIcon : 'fa-comments'} text-4xl text-slate-200 mb-3"></i>
                <p class="text-sm font-bold text-slate-400">${traceEmptyMsg}</p>
                <p class="text-xs text-slate-300 mt-2">${traceEmptySub}</p>
            </div>
        `;
        return;
    }
    container.innerHTML = filteredPosts.map(post => {
                // timestamp 안전하게 변환 (Firestore Timestamp 객체 또는 문자열 지원)
                let postDate;
                if (!post.timestamp) {
                    postDate = new Date();
                } else if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
                    // Firestore Timestamp 객체
                    postDate = post.timestamp.toDate();
                } else if (typeof post.timestamp === 'string') {
                    // ISO 문자열
                    postDate = new Date(post.timestamp);
                } else if (post.timestamp instanceof Date) {
                    // 이미 Date 객체
                    postDate = post.timestamp;
                } else {
                    // 기타 경우 (숫자 등)
                    postDate = new Date(post.timestamp);
                }
                
                // 유효하지 않은 날짜인지 확인
                if (isNaN(postDate.getTime())) {
                    console.warn('Invalid timestamp for post:', post.id, post.timestamp);
                    postDate = new Date(); // 기본값으로 현재 시간 사용
                }
                
                const dateStr = postDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                const timeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                
                const categoryLabels = {
                    'serious': '무거운',
                    'chat': '가벼운',
                    'food': '먹는',
                    'admin': '치프에게'
                };
                
                const categoryColors = {
                    'serious': 'bg-slate-100 text-slate-700',
                    'chat': 'bg-blue-100 text-blue-700',
                    'food': 'bg-emerald-100 text-emerald-700',
                    'admin': 'bg-orange-100 text-orange-700'
                };
                
                // "치프에게" 카테고리 특별 처리: 작성자 이외에는 제목/내용 미리보기 숨김
                const isAuthor = window.currentUser && post.authorId === window.currentUser.uid;
                const isAdminCategory = post.category === 'admin';
                const shouldHideContent = isAdminCategory && !isAuthor;
                const isLiked = likedPostIds.has(post.id);
                const isBookmarked = bookmarkedPostIds.has(post.id);
                const authorDisplay = getDisplayProfile(post.authorId, { nickname: post.authorNickname, icon: post.authorIcon, photoUrl: post.authorPhotoUrl });
                const authorAvatar = getProfileAvatarDisplay(authorDisplay);
                
                const hasImages = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;
                const isPendingPost = post.id && String(post.id).startsWith('pending-');
                return `
                    <div onclick="${isPendingPost ? '' : "window.openBoardDetail('" + post.id + "')"}" class="board-list-card rounded-2xl pt-4 px-5 pb-1.5 shadow-sm hover:shadow-md ${isPendingPost ? 'cursor-default' : 'cursor-pointer'} active:scale-[0.98] transition-all mb-2 ${isPendingPost ? 'ring-2 ring-amber-200 bg-amber-50/50' : ''}">
                        <div class="flex items-start gap-3 mb-1.5">
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 mb-3 min-w-0 flex-wrap">
                                    <span class="text-[10px] font-bold px-2.5 py-1 rounded-lg ${categoryColors[post.category] || categoryColors.serious} whitespace-nowrap shrink-0">${categoryLabels[post.category] || '무거운'}</span>
                                    ${isPendingPost ? '<span class="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-amber-200 text-amber-800 whitespace-nowrap shrink-0"><i class="fa-solid fa-spinner fa-spin mr-1"></i>등록 중...</span>' : ''}
                                    ${shouldHideContent ? '<h3 class="text-base font-bold text-slate-400 line-clamp-2 flex-1 min-w-0 leading-tight">비공개 게시물</h3>' : `<h3 class="text-base font-bold text-slate-800 line-clamp-2 flex-1 min-w-0 leading-tight">${escapeHtml(post.title)}</h3>`}
                                    ${hasImages ? '<span class="text-slate-400 shrink-0" title="사진 포함"><i class="fa-solid fa-image text-sm"></i></span>' : ''}
                                </div>
                                ${shouldHideContent ? '<p class="text-sm text-slate-400 line-clamp-2 mb-1.5 leading-relaxed">이 게시물은 작성자만 볼 수 있습니다.</p>' : `<p class="text-sm text-slate-600 line-clamp-2 mb-1.5 leading-relaxed">${renderFormattedContent(post.content)}</p>`}
                            </div>
                        </div>
                        <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                            <div class="flex items-center gap-3 cursor-pointer hover:opacity-80 active:opacity-70 transition-opacity rounded-lg -m-1 p-1" onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${post.authorId}')" role="button" tabindex="0">
                                ${authorAvatar.type === 'photo' ? `
                                    <div class="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                                ` : `
                                    <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                        ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                                    </div>
                                `}
                                <div>
                                    <div class="text-xs font-bold text-slate-800">${escapeHtml(authorDisplay.nickname)}</div>
                                    <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <div class="flex items-center gap-1.5 text-slate-800">
                                    <i class="fa-${postIdsCommentedByUser.has(post.id) ? 'solid' : 'regular'} fa-comment text-xl"></i>
                                    <span class="text-xs font-bold">${post.comments ?? 0}</span>
                                </div>
                                <button onclick="event.stopPropagation(); window.toggleBoardLike('${post.id}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'}"></i>
                                    <span class="text-xs font-bold text-slate-800">${post.likes || 0}</span>
                                </button>
                                <button onclick="event.stopPropagation(); window.toggleBoardBookmark('${post.id}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform ${!window.currentUser ? 'opacity-60 cursor-default' : ''}" data-post-id="${post.id}" ${!window.currentUser ? 'disabled' : ''}>
                                    <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800"></i>
                                </button>
                            </div>
                    </div>
                </div>
            `;
        }).join('');
}

// 게시판 상세 렌더링
export async function renderBoardDetail(postId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.boardOperations) return;
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
                <p class="text-sm text-slate-400">게시글을 불러오는 중...</p>
            </div>
        </div>
    `;
    try {
        const post = await window.boardOperations.getPost(postId);
        if (!post) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                    <p class="text-sm font-bold text-red-400">게시글을 찾을 수 없습니다</p>
                </div>
            `;
            return;
        }
        
        // timestamp 안전하게 변환 (Firestore Timestamp 객체 또는 문자열 지원)
        let postDate;
        if (!post.timestamp) {
            postDate = new Date();
        } else if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
            // Firestore Timestamp 객체
            postDate = post.timestamp.toDate();
        } else if (typeof post.timestamp === 'string') {
            // ISO 문자열
            postDate = new Date(post.timestamp);
        } else if (post.timestamp instanceof Date) {
            // 이미 Date 객체
            postDate = post.timestamp;
        } else {
            // 기타 경우 (숫자 등)
            postDate = new Date(post.timestamp);
        }
        
        // 유효하지 않은 날짜인지 확인
        if (isNaN(postDate.getTime())) {
            console.warn('Invalid timestamp for post:', post.id, post.timestamp);
            postDate = new Date(); // 기본값으로 현재 시간 사용
        }
        
        const dateStr = postDate.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = postDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const categoryLabels = {
            'serious': '무거운',
            'chat': '가벼운',
            'food': '먹는',
            'admin': '치프에게'
        };
        
        const categoryColors = {
            'serious': 'bg-slate-100 text-slate-700',
            'chat': 'bg-blue-100 text-blue-700',
            'food': 'bg-emerald-100 text-emerald-700',
            'admin': 'bg-orange-100 text-orange-700'
        };
        
        // "치프에게" 카테고리 특별 처리: 작성자 이외에는 접근 불가
        const isAuthor = window.currentUser && post.authorId === window.currentUser.uid;
        const isAdminCategory = post.category === 'admin';
        
        if (isAdminCategory && !isAuthor) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-lock text-4xl text-slate-300 mb-3"></i>
                    <p class="text-sm font-bold text-slate-400">이 게시물은 작성자만 볼 수 있습니다</p>
                </div>
            `;
            return;
        }
        
        // 사용자의 반응(좋아요), 북마크 확인과 댓글 목록을 병렬로 가져오기 (관리자 댓글 표시명 포함)
        const [userReaction, isBookmarked, comments, adminDisplayName] = await Promise.all([
            window.currentUser ? window.boardOperations.getUserReaction(postId, window.currentUser.uid) : Promise.resolve(null),
            window.currentUser && window.boardOperations.isBookmarked ? window.boardOperations.isBookmarked(postId, window.currentUser.uid) : Promise.resolve(false),
            window.boardOperations.getComments(postId),
            getAdminDisplayName()
        ]);
        
        // 게시글·댓글 작성자들의 최신 프로필 로드
        const detailAuthorIds = [post.authorId, ...(comments || []).map(c => c.authorId).filter(Boolean)];
        await fetchUserProfiles(detailAuthorIds);
        
        container.innerHTML = `
            <div class="board-post-card space-y-4">
                <!-- 상단: 뒤로가기 / 카테고리·제목 / 내글 / 점3개 -->
                <div class="flex items-center gap-2 pb-3 border-b border-slate-200">
                    <button onclick="window.backToBoardList()" class="w-8 h-8 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${categoryColors[post.category] || categoryColors.serious}">${categoryLabels[post.category] || '무거운'}</span>
                    <h2 class="sub-title text-base text-slate-800 tracking-tight flex-1 line-clamp-2 min-w-0">${escapeHtml(post.title || '게시글')}</h2>
                    ${isAuthor ? '<span class="shrink-0 text-[10px] text-emerald-600 font-bold">내글</span>' : ''}
                    <button type="button" onclick="window.showBoardPostOptions && window.showBoardPostOptions('${postId}', ${isAuthor})" class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                    </button>
                </div>
                
                <!-- 사진 (본문 상단, 좌우 폭 꽉 차게 표시, 전체 비율 유지·잘림 없음) -->
                ${Array.isArray(post.imageUrls) && post.imageUrls.length > 0 ? `
                <div class="flex flex-col gap-2 mb-4 -mx-4 px-2">
                    ${post.imageUrls.map(url => `<img src="${url}" alt="게시글 사진" class="w-full h-auto rounded-xl border border-slate-200 object-contain" loading="lazy">`).join('')}
                </div>
                ` : ''}
                
                <!-- 게시글 내용 -->
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4 -mx-2 px-2">${renderFormattedContent(post.content)}</div>
                
                <!-- 하단: 작성자/일자/조회수(왼쪽) | 좋아요·북마크(오른쪽) -->
                ${(() => {
                    const authorDisplay = getDisplayProfile(post.authorId, { nickname: post.authorNickname, icon: post.authorIcon, photoUrl: post.authorPhotoUrl });
                    const authorAvatar = getProfileAvatarDisplay(authorDisplay);
                    return `
                <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                    <div class="flex items-center gap-3">
                        ${authorAvatar.type === 'photo' ? `
                            <div class="w-8 h-8 rounded-full flex-shrink-0 overflow-hidden border-2 border-slate-300" style="background-image: url(${authorAvatar.value}); background-size: cover; background-position: center;"></div>
                        ` : `
                            <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 border-2 border-slate-300 ${authorAvatar.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200'}">
                                ${authorAvatar.type === 'default' ? '<i class="fa-solid fa-user text-sm"></i>' : escapeHtml(authorAvatar.value)}
                            </div>
                        `}
                        <div>
                            <div class="text-xs font-bold text-slate-800">${escapeHtml(authorDisplay.nickname)}</div>
                            <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${post.views || 0}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="window.toggleBoardLike('${postId}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${userReaction === 'like' ? 'solid' : 'regular'} fa-heart text-xl ${userReaction === 'like' ? 'text-red-500' : 'text-slate-800'}"></i>
                            <span class="text-xs font-bold text-slate-800">${post.likes || 0}</span>
                        </button>
                        <button onclick="window.toggleBoardBookmark('${postId}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-post-id="${postId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800"></i>
                        </button>
                    </div>
                </div>
                `;
                })()}
                
                <!-- 댓글 섹션 -->
                <div class="pt-4 border-t border-slate-200">
                    <h3 class="text-sm font-black text-slate-800 mb-4">댓글 <span id="boardCommentsCount" class="text-emerald-600">${comments.length}</span></h3>
                    <div id="boardCommentsList" class="space-y-3 mb-4">
                        ${comments.length > 0 ? comments.map(comment => {
                            // timestamp 안전하게 변환 (Firestore Timestamp 객체 또는 문자열 지원)
                            let commentDate;
                            if (!comment.timestamp) {
                                commentDate = new Date();
                            } else if (comment.timestamp.toDate && typeof comment.timestamp.toDate === 'function') {
                                // Firestore Timestamp 객체
                                commentDate = comment.timestamp.toDate();
                            } else if (typeof comment.timestamp === 'string') {
                                // ISO 문자열
                                commentDate = new Date(comment.timestamp);
                            } else if (comment.timestamp instanceof Date) {
                                // 이미 Date 객체
                                commentDate = comment.timestamp;
                            } else {
                                // 기타 경우 (숫자 등)
                                commentDate = new Date(comment.timestamp);
                            }
                            
                            // 유효하지 않은 날짜인지 확인
                            if (isNaN(commentDate.getTime())) {
                                console.warn('Invalid timestamp for comment:', comment.id, comment.timestamp);
                                commentDate = new Date(); // 기본값으로 현재 시간 사용
                            }
                            
                            const commentDateStr = commentDate.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
                            const commentTimeStr = commentDate.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
                            const isCommentAuthor = window.currentUser && comment.authorId === window.currentUser.uid;
                            const commentNickname = comment.isAdminComment === true ? adminDisplayName : getDisplayProfile(comment.authorId, { nickname: comment.authorNickname || comment.anonymousId }).nickname;
                            const commentBody = comment.content ?? comment.text ?? '';
                            
                            return `
                                <div class="mb-1 text-sm" data-comment-id="${comment.id}">
                                    <span class="font-bold text-slate-800">${escapeHtml(commentNickname)}</span>
                                    <span class="text-slate-800 ml-2">${escapeHtml(commentBody)}</span>
                                    ${commentDateStr && commentTimeStr ? `<span class="text-xs text-slate-400 ml-2">${commentDateStr} ${commentTimeStr}</span>` : ''}
                                    ${isCommentAuthor ? `<button onclick="window.deleteBoardComment('${comment.id}', '${postId}')" class="ml-2 text-slate-400 text-xs hover:text-red-500">삭제</button>` : ''}
                                </div>
                            `;
                        }).join('') : ''}
                    </div>
                    
                    <!-- 댓글 입력 -->
                    <div class="flex gap-2 py-3 px-3 -mx-3 -mb-3">
                        <div class="relative flex-1">
                            <input type="text" id="boardCommentInput" placeholder="${window.currentUser ? '댓글을 입력하세요...' : '로그인 후 댓글을 작성할 수 있습니다'}" 
                                   class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100"
                                   ${!window.currentUser ? 'disabled' : ''}
                                   onkeypress="if(event.key === 'Enter' && window.currentUser && !event.shiftKey) { event.preventDefault(); window.addBoardComment('${postId}'); }">
                            <span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); if(window.currentUser) window.addBoardComment('${postId}')" onclick="if(window.currentUser) window.addBoardComment('${postId}')">게시</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } catch (error) {
        console.error("게시글 상세 로드 오류:", error);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">게시글을 불러올 수 없습니다</p>
            </div>
        `;
    }
}

// 공지 상세 렌더링 (본문 페이지, 좋아요/싫어요만 표시, 신고/댓글 없음)
export async function renderNoticeDetail(noticeId) {
    const container = document.getElementById('boardDetailContent');
    if (!container || !window.noticeOperations) return;
    
    container.innerHTML = `
        <div class="flex justify-center items-center py-12">
            <div class="text-center">
                <i class="fa-solid fa-spinner fa-spin text-4xl text-slate-300 mb-3"></i>
                <p class="text-sm text-slate-400">공지를 불러오는 중...</p>
            </div>
        </div>
    `;
    
    try {
        const [notice, counts, userReaction, isBookmarked, adminDisplayName] = await Promise.all([
            window.noticeOperations.getNotice(noticeId),
            window.noticeOperations.getNoticeReactionCounts(noticeId),
            window.currentUser ? window.noticeOperations.getNoticeUserReaction(noticeId, window.currentUser.uid) : Promise.resolve(null),
            window.currentUser && window.noticeOperations.isNoticeBookmarked ? window.noticeOperations.isNoticeBookmarked(noticeId, window.currentUser.uid) : Promise.resolve(false),
            getAdminDisplayName()
        ]);
        
        if (!notice) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center py-12 text-center">
                    <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                    <p class="text-sm font-bold text-red-400">공지를 찾을 수 없습니다</p>
                </div>
            `;
            return;
        }
        
        let date = notice.timestamp ? (() => {
            // timestamp 안전하게 변환
            if (notice.timestamp.toDate && typeof notice.timestamp.toDate === 'function') {
                return notice.timestamp.toDate();
            } else if (typeof notice.timestamp === 'string') {
                return new Date(notice.timestamp);
            } else if (notice.timestamp instanceof Date) {
                return notice.timestamp;
            } else {
                return new Date(notice.timestamp);
            }
        })() : new Date();
        
        // 유효하지 않은 날짜인지 확인
        if (isNaN(date.getTime())) {
            console.warn('Invalid timestamp for notice:', notice.id, notice.timestamp);
            date = new Date();
        }
        
        const dateStr = date.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const noticeTypeLabels = { important: '중요', notice: '알림', light: '가벼운' };
        const noticeTypeColors = { important: 'bg-red-100 text-red-700', notice: 'bg-blue-100 text-blue-700', light: 'bg-slate-100 text-slate-700' };
        const noticeType = notice.type || notice.noticeType || 'notice';
        const typeLabel = noticeTypeLabels[noticeType] || '알림';
        const typeColor = noticeTypeColors[noticeType] || noticeTypeColors.notice;
        
        const likes = counts?.likes ?? 0;
        const viewCount = Number(notice.views || notice.viewCount || notice.viewsCount || notice.viewCounts || 0) || 0;
        const isLiked = userReaction === 'like';
        
        container.innerHTML = `
            <div class="board-post-card space-y-4">
                <!-- 상단: 뒤로가기 / 타입·제목 -->
                <div class="flex items-center gap-2 pb-3 border-b border-slate-200">
                    <button onclick="window.backToBoardList()" class="w-8 h-8 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-full transition-colors flex-shrink-0">
                        <i class="fa-solid fa-arrow-left text-lg"></i>
                    </button>
                    <span class="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${typeColor}">${typeLabel}</span>
                    <h2 class="sub-title text-base text-slate-800 tracking-tight flex-1 line-clamp-2 min-w-0">${escapeHtml(notice.title || '공지')}</h2>
                    ${notice.isPinned === true ? '<span class="shrink-0 text-[10px] text-emerald-600 font-bold">고정</span>' : ''}
                </div>
                
                ${Array.isArray(notice.imageUrls) && notice.imageUrls.length > 0 ? `
                <div class="flex flex-col gap-2 mb-4 -mx-4 px-2">
                    ${notice.imageUrls.map(url => `<img src="${url}" alt="공지 사진" class="w-full h-auto rounded-xl border border-slate-200 object-contain" loading="lazy">`).join('')}
                </div>
                ` : ''}
                
                <!-- 게시글 내용 -->
                <div class="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed mb-4 -mx-2 px-2">${renderFormattedContent(notice.content || '')}</div>
                
                <!-- 하단: 작성자/일자/조회수(왼쪽) | 하트·북마크(오른쪽) -->
                <div class="flex items-center justify-between pt-3 border-t border-slate-200">
                    <div class="flex items-center gap-3">
                        <div class="w-8 h-8 bg-slate-200 rounded-full flex items-center justify-center text-sm flex-shrink-0 border-2 border-slate-300">
                            <i class="fa-solid fa-bullhorn text-slate-500 text-xs"></i>
                        </div>
                        <div>
                            <div class="text-xs font-bold text-slate-800">${escapeHtml(adminDisplayName)}</div>
                            <div class="text-[10px] text-slate-400">${dateStr} ${timeStr} · 조회 ${viewCount}</div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button onclick="window.toggleNoticeLike('${noticeId}', true)" class="board-post-like-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${noticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isLiked ? 'solid' : 'regular'} fa-heart text-xl ${isLiked ? 'text-red-500' : 'text-slate-800'}"></i>
                            <span class="text-xs font-bold text-slate-800">${likes}</span>
                        </button>
                        <button onclick="window.toggleNoticeBookmark('${noticeId}')" class="board-post-bookmark-btn flex items-center gap-1.5 active:scale-95 transition-transform" data-notice-id="${noticeId}" ${!window.currentUser ? 'disabled' : ''}>
                            <i class="fa-${isBookmarked ? 'solid' : 'regular'} fa-bookmark text-xl text-slate-800"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    } catch (e) {
        console.error("공지 상세 로드 오류:", e);
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-exclamation-triangle text-4xl text-red-300 mb-3"></i>
                <p class="text-sm font-bold text-red-400">공지를 불러올 수 없습니다</p>
            </div>
        `;
    }
}

export function createDailyShareCard(dateStr, forPreview = false) {
    const dObj = new Date(dateStr + 'T00:00:00');
    const year = dObj.getFullYear();
    const month = dObj.getMonth() + 1;
    const day = dObj.getDate();
    
    // 사용자 정보 가져오기 (아이콘 미설정 시 기본 회색 사람 아이콘)
    const userProfile = window.userSettings?.profile || {};
    const displayProfile = { nickname: userProfile.nickname || '익명', icon: userProfile.icon ?? null, photoUrl: userProfile.photoUrl || null };
    const userNickname = displayProfile.nickname;
    const dailyAvatar = getProfileAvatarDisplay(displayProfile);
    const userIconDisplay = dailyAvatar.type === 'photo' ? '' : (dailyAvatar.type === 'default' ? '' : dailyAvatar.value);
    
    // 기존 컨테이너 제거
    const existing = document.getElementById('dailyShareCardContainer');
    if (existing) existing.remove();
    
    // 공유용 컨테이너 생성 (forPreview: 모달용으로 배치/숨김 없음, !forPreview: 화면 밖에 숨김)
    const container = document.createElement('div');
    container.id = 'dailyShareCardContainer';
    if (!forPreview) {
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        container.style.top = '0';
    } else {
        container.style.margin = '0 auto';
    }
    container.style.width = '420px'; // 모바일 기준 너비
    container.style.maxWidth = '420px';
    container.style.backgroundColor = '#ffffff';
    container.style.padding = '0';
    container.style.fontFamily = 'Pretendard, sans-serif';
    
    // Fredoka 폰트 로드 확인 및 적용
    if (document.fonts && document.fonts.check) {
        // 폰트가 로드되었는지 확인
        const fredokaLoaded = document.fonts.check('1em Fredoka');
        if (!fredokaLoaded) {
            // Fredoka 폰트가 없으면 Google Fonts에서 로드
            const link = document.createElement('link');
            link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;500;600;700&display=swap';
            link.rel = 'stylesheet';
            document.head.appendChild(link);
        }
    }
    
    // 날짜 포맷팅 (26년 1월21일 형식)
    const shortYear = year.toString().slice(-2);
    const formattedDate = `'${shortYear}년 ${month}월${day}일`;
    
    const blue = '#1877F2';
    const borderLightGray = '#e2e8f0';
    const borderOuterGray = '#cbd5e1';
    const photoAreaEmptyBg = '#e2e8f0'; /* 사진 없을 때 영역: 본문보다 진한 회색 */
    let html = `
        <div style="width: 420px; max-width: 420px; margin: 0 auto; border: 1px solid ${borderOuterGray}; border-radius: 20px; overflow: hidden; background: #f1f5f9;">
            <!-- 헤더 (패딩 6/16/16으로 텍스트 10px 상향) -->
            <div style="background: #ffffff; padding: 6px 16px 16px; border-bottom: 1px solid ${borderLightGray};">
                <!-- 상단: mealog(파란색)와 날짜 (html2canvas 베이스라인 정렬: flex + align-items: center) -->
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-size: 28.8px; font-weight: 600; color: ${blue}; font-family: 'Fredoka', sans-serif; letter-spacing: -0.5px; text-transform: lowercase;">mealog</span>
                    <span style="font-size: 12px; font-weight: 400; color: #64748b; flex-shrink: 0;">${formattedDate}</span>
                </div>
                <!-- 하단: 닉네임의 하루소감 (html2canvas 베이스라인 정렬: flex + align-items: center) -->
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 16px; display: flex; align-items: center;">📅</span>
                    <span style="font-size: 15px; font-weight: 700; color: #1e293b; font-family: 'NanumSquareRound', sans-serif;">${escapeHtml(userNickname)}의 하루소감</span>
                </div>
            </div>
            
            <!-- 본문 (패딩 2px 상단으로 10px 상향) -->
            <div style="padding: 2px 0 12px 0; background: #f1f5f9; border-bottom-left-radius: 19px; border-bottom-right-radius: 19px;">
    `;
    
    // 타임라인처럼 모든 슬롯을 순서대로 표시 (간식 포함)
    SLOTS.forEach(slot => {
        const records = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
        
        if (slot.type === 'main') {
            // 메인 식사 (아침/점심/저녁)
            const r = records[0];
            const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            
            let containerStyle = 'border: 1px solid #cbd5e1; margin: 4px 8px; margin-bottom: 7px; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255, 255, 255, 0.9);';
            let iconTextColor = specificStyle.iconText.includes('amber') ? '#d97706' : specificStyle.iconText.includes('emerald') ? '#059669' : specificStyle.iconText.includes('sky') ? '#0284c7' : '#64748b';
            
            let titleLine1 = '';
            let titleLine2 = '';
            let iconHtml = '';
            let iconBoxStyle = '';
            
            if (r) {
                if (r.mealType === 'Skip') {
                    titleLine2 = 'Skip';
                    iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                    iconHtml = '<i class="fa-solid fa-ban" style="font-size: 24px; color: #94a3b8;"></i>';
                } else {
                    const p = r.place || '';
                    const m = r.menuDetail || r.category || '';
                    titleLine2 = escapeHtml(m || '');
                    
                    if (r.photos && Array.isArray(r.photos) && r.photos[0]) {
                        iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
                        const photoUrl = String(r.photos[0]).replace(/'/g, "%27");
                        iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(r.photos[0])}"></div>`;
                    } else if (r.photos && !Array.isArray(r.photos)) {
                        iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
                        const photoUrl = String(r.photos).replace(/'/g, "%27");
                        iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(r.photos)}"></div>`;
                    } else {
                        iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                        iconHtml = `<i class="fa-solid fa-utensils" style="font-size: 24px; color: #94a3b8;"></i>`;
                    }
                }
            } else {
                titleLine2 = '';
                iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                iconHtml = '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8px;"><span style="font-size: 32px; font-weight: 700; color: #94a3b8; margin-bottom: 4px;">+</span><span style="font-size: 10px; color: #94a3b8; line-height: 1.2;">입력해주세요</span></div>';
            }
            
            // 날짜 포맷팅 (베스트와 동일한 형식)
            const dateObj = r ? new Date(r.date + 'T00:00:00') : new Date(dateStr + 'T00:00:00');
            const formattedDateForCard = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
            
            html += `
                <div style="${containerStyle} min-height: 130px;">
                    <div style="display: flex;">
                        <div style="width: 130px; min-height: 130px; ${iconBoxStyle} display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; border-radius: 12px 0 0 12px;">
                            ${iconHtml}
                        </div>
                        <div style="flex: 1; padding: 10px 12px 12px 12px; display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: 130px;">
                            <div style="font-size: 11px; color: #64748b; margin-bottom: 6px; line-height: 1.4; display: flex; align-items: center; flex-wrap: wrap; gap: 0 4px;">
                                <span style="font-weight: 700; color: ${iconTextColor};">${escapeHtml(slot.label)}</span>
                                ${r && r.place ? `<span style="color: #94a3b8; font-weight: 700;">@ ${escapeHtml(r.place)}</span>` : ''}
                                <span style="color: #cbd5e1;">·</span>
                                <span style="color: #94a3b8;">${formattedDateForCard}</span>
                            </div>
                            ${titleLine2 ? `<div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 6px; line-height: 1.3; word-break: break-word;">
                                ${titleLine2}
                            </div>` : ''}
                            ${r && r.comment ? `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; padding-bottom: 2px;">
                                "${escapeHtml(r.comment)}"
                            </div>` : ''}
                            ${r && r.rating ? `<div style="display: flex; align-items: center; justify-content: flex-start; gap: 4px; margin-top: auto; padding-top: 4px;">
                                <span style="font-size: 10px; color: #ca8a04; font-weight: 900; display: flex; align-items: center; gap: 3px; white-space: nowrap;">
                                    <span style="font-size: 11px; line-height: 1;">⭐</span>
                                    <span style="font-size: 11px; font-weight: 900; line-height: 1;">${r.rating}</span>
                                </span>
                            </div>` : ''}
                        </div>
                    </div>
                </div>
            `;
        } else {
            // 간식 슬롯 (html2canvas 베이스라인 정렬: flex + align-items: center)
            html += `
                <div style="display: flex; align-items: center; margin-bottom: 6px; padding: 4px 8px; min-height: 32px; gap: 12px;">
                    <span style="font-size: 12px; font-weight: 900; color: #1e293b; text-transform: uppercase; flex-shrink: 0; padding: 0 8px; white-space: nowrap;">${escapeHtml(slot.label)}</span>
                    <div style="flex: 1; min-width: 0; display: flex; flex-wrap: nowrap; gap: 6px; align-items: center; justify-content: center; overflow-x: auto;">
                        ${records.length > 0 ? records.map(r => `
                            <div style="display: flex; align-items: center; padding: 2.5px 5px; background: #ffffff; border-radius: 8px; border: 1px solid #e2e8f0; flex-shrink: 0; box-sizing: border-box; gap: 6px;">
                                <span style="font-size: 12px; font-weight: 600; color: #334155; word-wrap: break-word; overflow-wrap: break-word; white-space: nowrap;">${escapeHtml(r.menuDetail || r.snackType || '간식')}</span>
                                ${r.rating ? `<span style="font-size: 10px; font-weight: 900; color: #ca8a04; display: flex; align-items: center; gap: 2px; flex-shrink: 0; white-space: nowrap;">
                                    <span style="font-size: 10px; line-height: 1;">⭐</span>
                                    <span style="font-size: 10px; font-weight: 900; line-height: 1;">${r.rating}</span>
                                </span>` : ''}
                            </div>
                        `).join('') : ''}
                    </div>
                </div>
            `;
        }
    });
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
    if (!forPreview) {
        document.body.appendChild(container);
    }
    
    return container;
}

// 사진 편집 관련 변수
let editingPhotoIndex = null;
let editingPhotoImage = null;
let photoEditCanvas = null;
let photoEditCtx = null;
let photoEditScale = 1;
let photoEditOffsetX = 0;
let photoEditOffsetY = 0;
let photoEditRotation = 0; // 회전 각도 (도 단위)
let isDraggingPhoto = false;
let dragStartX = 0;
let dragStartY = 0;
/** 드래그 시 화면 델타를 회전된 좌표계로 변환하기 위해 저장 */
let dragStartClientX = 0;
let dragStartClientY = 0;
let dragStartOffsetX = 0;
let dragStartOffsetY = 0;
let isPinching = false;
let initialPinchDistance = 0;
let initialPinchScale = 1;
/** 'meal' | 'profile' | null */
let photoEditContext = null;
/** 프로필 편집 시 취소/닫기 시 revoke용 */
let profilePhotoEditObjectUrl = null;

// 사진 편집 모달 열기 (식사 사진)
export function editPhoto(idx) {
    if (idx < 0 || idx >= appState.currentPhotos.length) return;
    
    photoEditContext = 'meal';
    profilePhotoEditObjectUrl = null;
    editingPhotoIndex = idx;
    const photoSrc = appState.currentPhotos[idx];
    
    openPhotoEditModalWithImage(photoSrc);
}

// 프로필 사진 편집 모달 열기 (사진 직접 등록 시)
export function openProfilePhotoEdit(objectUrl) {
    if (!objectUrl) return;
    photoEditContext = 'profile';
    profilePhotoEditObjectUrl = objectUrl;
    editingPhotoIndex = null;
    
    openPhotoEditModalWithImage(objectUrl);
}

function getPhotoEditAspectRatioCss() {
    const ratio = photoEditContext === 'profile' ? '1:1' : (appState.recordPhotoAspectRatio || '1:1');
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

/** 기록 등록 화면·편집 화면 공통: 선택된 사진 비율의 CSS aspect-ratio 값 */
function getRecordPhotoAspectRatioCss() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

function openPhotoEditModalWithImage(photoSrc) {
    const modal = document.getElementById('photoEditModal');
    if (!modal) return;
    
    const wrapper = document.getElementById('photoEditAspectWrapper');
    if (wrapper) wrapper.style.aspectRatio = getPhotoEditAspectRatioCss();
    
    modal.classList.remove('hidden');
    
    photoEditCanvas = document.getElementById('photoEditCanvas');
    if (!photoEditCanvas) return;
    
    photoEditCtx = photoEditCanvas.getContext('2d');
    
    editingPhotoImage = new Image();
    // Firebase Storage 같은 외부 URL 편집 시 canvas taint로 저장 실패하는 케이스를 줄임
    const src = String(photoSrc || '');
    const isLocalLike = src.startsWith('data:') || src.startsWith('blob:');
    if (!isLocalLike) {
        editingPhotoImage.crossOrigin = 'anonymous';
    }
    editingPhotoImage.onload = () => {
        initializePhotoEdit();
    };
    editingPhotoImage.onerror = () => {
        if (typeof window.showToast === 'function') window.showToast('이미지를 불러올 수 없습니다.', 'error');
        closePhotoEditModal();
    };
    editingPhotoImage.src = photoSrc;
}

// 사진 편집 초기화
function initializePhotoEdit() {
    if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;
    
    const container = document.getElementById('photoEditCanvasContainer');
    if (!container) return;
    
    // 모달이 완전히 렌더링된 후 크기 계산
    setTimeout(() => {
        // 모달이 닫힌 경우(이미지 로드 중 사용자가 닫음) 스킵
        if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;
        const containerAgain = document.getElementById('photoEditCanvasContainer');
        if (!containerAgain) return;

        const containerRect = containerAgain.getBoundingClientRect();
        const containerWidth = containerRect.width || containerAgain.offsetWidth;
        const containerHeight = containerRect.height || containerAgain.offsetHeight;
        
        // Canvas 크기 설정
        photoEditCanvas.width = containerWidth;
        photoEditCanvas.height = containerHeight;
        containerAgain.style.touchAction = 'none';

        // 이미지 비율 계산
        const imgAspect = editingPhotoImage.width / editingPhotoImage.height;
        const containerAspect = containerWidth / containerHeight;
    
    let drawWidth, drawHeight;
    if (imgAspect > containerAspect) {
        // 이미지가 더 넓음 - 높이에 맞춤
        drawHeight = containerHeight;
        drawWidth = drawHeight * imgAspect;
    } else {
        // 이미지가 더 높음 - 너비에 맞춤
        drawWidth = containerWidth;
        drawHeight = drawWidth / imgAspect;
    }
    
    photoEditScale = drawWidth / editingPhotoImage.width;
    photoEditOffsetX = (containerWidth - drawWidth) / 2;
    photoEditOffsetY = (containerHeight - drawHeight) / 2;
    photoEditRotation = 0; // 초기 회전 각도
    
        // 초기 렌더링
        drawPhotoEdit();
        
        // 드래그 이벤트 추가
        setupPhotoEditDrag();
        
        // 줌 및 회전 이벤트 추가
        setupPhotoEditZoomAndRotate();
    }, 100);
}

// 사진 편집 화면 그리기
function drawPhotoEdit() {
    if (!photoEditCanvas || !photoEditCtx || !editingPhotoImage) return;
    
    // Canvas 클리어
    photoEditCtx.clearRect(0, 0, photoEditCanvas.width, photoEditCanvas.height);
    
    // 배경
    photoEditCtx.fillStyle = '#f1f5f9';
    photoEditCtx.fillRect(0, 0, photoEditCanvas.width, photoEditCanvas.height);
    
    // 이미지 그리기 (회전 적용)
    const drawWidth = editingPhotoImage.width * photoEditScale;
    const drawHeight = editingPhotoImage.height * photoEditScale;
    
    // 축소 시(화면에 꽉 차지 않을 때) 미리보기에서도 중앙 정렬 강제 (인스타 스타일)
    const useCenterX = drawWidth < photoEditCanvas.width;
    const useCenterY = drawHeight < photoEditCanvas.height;
    const drawOffsetX = useCenterX ? (photoEditCanvas.width - drawWidth) / 2 : photoEditOffsetX;
    const drawOffsetY = useCenterY ? (photoEditCanvas.height - drawHeight) / 2 : photoEditOffsetY;
    
    const centerX = photoEditCanvas.width / 2;
    const centerY = photoEditCanvas.height / 2;
    
    photoEditCtx.save();
    photoEditCtx.translate(centerX, centerY);
    photoEditCtx.rotate((photoEditRotation * Math.PI) / 180);
    photoEditCtx.translate(-centerX, -centerY);
    photoEditCtx.drawImage(
        editingPhotoImage,
        drawOffsetX,
        drawOffsetY,
        drawWidth,
        drawHeight
    );
    
    photoEditCtx.restore();
}

// 사진 편집 드래그 설정
function setupPhotoEditDrag() {
    if (!photoEditCanvas) return;
    
    photoEditCanvas.style.cursor = 'grab';
    // 터치 드래그가 스크롤로 가로채지 않도록 (모바일)
    photoEditCanvas.style.touchAction = 'none';
    
    photoEditCanvas.addEventListener('mousedown', handlePhotoEditMouseDown);
    photoEditCanvas.addEventListener('mousemove', handlePhotoEditMouseMove);
    photoEditCanvas.addEventListener('mouseup', handlePhotoEditMouseUp);
    photoEditCanvas.addEventListener('mouseleave', handlePhotoEditMouseUp);
    
    // 터치 이벤트는 setupPhotoEditZoomAndRotate에서 통합 처리
}

/** 사진 편집 offset: 축소 시 중앙 정렬 강제, 확대 시 좌우/상하에 맞춰 클램프 (인스타 스타일) */
function clampPhotoEditOffset() {
    if (!photoEditCanvas || !editingPhotoImage) return;
    const drawWidth = editingPhotoImage.width * photoEditScale;
    const drawHeight = editingPhotoImage.height * photoEditScale;
    if (drawWidth < photoEditCanvas.width) {
        photoEditOffsetX = (photoEditCanvas.width - drawWidth) / 2;
    } else {
        const minX = Math.min(0, photoEditCanvas.width - drawWidth);
        const maxX = Math.max(0, photoEditCanvas.width - drawWidth);
        photoEditOffsetX = Math.min(maxX, Math.max(minX, photoEditOffsetX));
    }
    if (drawHeight < photoEditCanvas.height) {
        photoEditOffsetY = (photoEditCanvas.height - drawHeight) / 2;
    } else {
        const minY = Math.min(0, photoEditCanvas.height - drawHeight);
        const maxY = Math.max(0, photoEditCanvas.height - drawHeight);
        photoEditOffsetY = Math.min(maxY, Math.max(minY, photoEditOffsetY));
    }
}

/** 화면(캔버스) 좌표계의 이동량을 회전된 이미지 좌표계로 변환 (드래그 방향이 보이는 대로 동작하도록) */
function screenDeltaToRotatedOffset(dx, dy) {
    const rad = (photoEditRotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
        x: cos * dx + sin * dy,
        y: -sin * dx + cos * dy
    };
}

// 마우스 이벤트 핸들러
function handlePhotoEditMouseDown(e) {
    isDraggingPhoto = true;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragStartOffsetX = photoEditOffsetX;
    dragStartOffsetY = photoEditOffsetY;
    dragStartX = e.clientX - photoEditOffsetX;
    dragStartY = e.clientY - photoEditOffsetY;
    if (photoEditCanvas) {
        photoEditCanvas.style.cursor = 'grabbing';
    }
}

function handlePhotoEditMouseMove(e) {
    if (!isDraggingPhoto) return;
    
    const dx = e.clientX - dragStartClientX;
    const dy = e.clientY - dragStartClientY;
    const rotated = screenDeltaToRotatedOffset(dx, dy);
    photoEditOffsetX = dragStartOffsetX + rotated.x;
    photoEditOffsetY = dragStartOffsetY + rotated.y;
    
    // 경계 체크: 이미지가 화면보다 클 때는 빈 공간 없이, 작을 때는 자유롭게 이동 가능하도록 min/max로 클램프
    clampPhotoEditOffset();
    drawPhotoEdit();
}

function handlePhotoEditMouseUp() {
    isDraggingPhoto = false;
    if (photoEditCanvas) {
        photoEditCanvas.style.cursor = 'grab';
    }
}

// 터치 이벤트 핸들러
function handlePhotoEditTouchStart(e) {
    // 핀치 줌이면 드래그 무시
    if (e.touches.length === 2) {
        return;
    }
    e.preventDefault();
    const touch = e.touches[0];
    isDraggingPhoto = true;
    dragStartClientX = touch.clientX;
    dragStartClientY = touch.clientY;
    dragStartOffsetX = photoEditOffsetX;
    dragStartOffsetY = photoEditOffsetY;
    dragStartX = touch.clientX - photoEditOffsetX;
    dragStartY = touch.clientY - photoEditOffsetY;
}

function handlePhotoEditTouchMove(e) {
    // 핀치 줌이면 드래그 무시
    if (e.touches.length === 2 || isPinching) {
        return;
    }
    if (!isDraggingPhoto) return;
    e.preventDefault();
    
    const touch = e.touches[0];
    const dx = touch.clientX - dragStartClientX;
    const dy = touch.clientY - dragStartClientY;
    const rotated = screenDeltaToRotatedOffset(dx, dy);
    photoEditOffsetX = dragStartOffsetX + rotated.x;
    photoEditOffsetY = dragStartOffsetY + rotated.y;
    
    clampPhotoEditOffset();
    drawPhotoEdit();
}

function handlePhotoEditTouchEnd() {
    isDraggingPhoto = false;
    isPinching = false;
}

// 줌 및 회전 기능 설정
function setupPhotoEditZoomAndRotate() {
    if (!photoEditCanvas) return;
    
    // 휠 줌 (데스크톱)
    photoEditCanvas.addEventListener('wheel', handlePhotoEditWheel, { passive: false });
    
    // 터치 이벤트 (드래그 + 핀치 줌 통합) - capture로 터치 확실히 수신
    photoEditCanvas.addEventListener('touchstart', handlePhotoEditTouchStart, { passive: false, capture: true });
    photoEditCanvas.addEventListener('touchmove', handlePhotoEditTouchMove, { passive: false, capture: true });
    photoEditCanvas.addEventListener('touchend', handlePhotoEditTouchEnd, { capture: true });
    photoEditCanvas.addEventListener('touchcancel', handlePhotoEditTouchEnd, { capture: true });
}

// 휠 줌 핸들러
function handlePhotoEditWheel(e) {
    e.preventDefault();
    
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = Math.max(0.1, Math.min(3, photoEditScale + delta));
    
    // 줌 중심점 계산
    const rect = photoEditCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // 줌 중심점 기준으로 스케일 조정
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = x - (x - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = y - (y - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 줌인
export function zoomInPhotoEdit() {
    const newScale = Math.min(3, photoEditScale * 1.2);
    const centerX = photoEditCanvas.width / 2;
    const centerY = photoEditCanvas.height / 2;
    
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = centerX - (centerX - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = centerY - (centerY - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 줌아웃 (최소 0.1 — 초기 fit 스케일이 0.5 미만일 수 있어 축소 버튼이 확대되던 문제 수정)
export function zoomOutPhotoEdit() {
    const newScale = Math.max(0.1, photoEditScale / 1.2);
    const centerX = photoEditCanvas.width / 2;
    const centerY = photoEditCanvas.height / 2;
    
    const scaleChange = newScale / photoEditScale;
    photoEditOffsetX = centerX - (centerX - photoEditOffsetX) * scaleChange;
    photoEditOffsetY = centerY - (centerY - photoEditOffsetY) * scaleChange;
    
    photoEditScale = newScale;
    clampPhotoEditOffset();
    drawPhotoEdit();
}

// 회전 (90도씩)
export function rotatePhotoEdit() {
    photoEditRotation = (photoEditRotation + 90) % 360;
    drawPhotoEdit();
}

// 사진 편집 초기화 (리셋)
export function resetPhotoEdit() {
    if (!editingPhotoImage) return;
    
    const container = document.getElementById('photoEditCanvasContainer');
    if (!container) return;
    
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    const imgAspect = editingPhotoImage.width / editingPhotoImage.height;
    const containerAspect = containerWidth / containerHeight;
    
    let drawWidth, drawHeight;
    if (imgAspect > containerAspect) {
        drawHeight = containerHeight;
        drawWidth = drawHeight * imgAspect;
    } else {
        drawWidth = containerWidth;
        drawHeight = drawWidth / imgAspect;
    }
    
    photoEditScale = drawWidth / editingPhotoImage.width;
    photoEditOffsetX = (containerWidth - drawWidth) / 2;
    photoEditOffsetY = (containerHeight - drawHeight) / 2;
    photoEditRotation = 0;
    
    drawPhotoEdit();
}

// 사진 편집 저장 — 전체 이미지를 잘리지 않게 fit(contain)으로 저장해 재편집 시 원본 활용 가능
export function savePhotoEdit() {
    if (!photoEditCanvas || !editingPhotoImage) return;
    
    const w = photoEditCanvas.width;
    const h = photoEditCanvas.height;
    const imgW = editingPhotoImage.width;
    const imgH = editingPhotoImage.height;
    
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = w;
    outputCanvas.height = h;
    const outputCtx = outputCanvas.getContext('2d');
    
    outputCtx.fillStyle = '#ffffff';
    outputCtx.fillRect(0, 0, w, h);
    
    const centerX = w / 2;
    const centerY = h / 2;
    // 회전 후 보이는 너비/높이 (90/270이면 치환)
    const rotW = (photoEditRotation === 90 || photoEditRotation === 270) ? imgH : imgW;
    const rotH = (photoEditRotation === 90 || photoEditRotation === 270) ? imgW : imgH;
    const fitScale = Math.min(w / rotW, h / rotH);
    
    outputCtx.save();
    outputCtx.translate(centerX, centerY);
    outputCtx.rotate((photoEditRotation * Math.PI) / 180);
    outputCtx.scale(fitScale, fitScale);
    outputCtx.translate(-imgW / 2, -imgH / 2);
    outputCtx.drawImage(editingPhotoImage, 0, 0, imgW, imgH, 0, 0, imgW, imgH);
    outputCtx.restore();
    
    try {
        outputCanvas.toBlob((blob) => {
            if (!blob) {
                if (typeof window.showToast === 'function') {
                    window.showToast('사진 저장에 실패했습니다. 다시 시도해주세요.', 'error');
                }
                return;
            }
        
            if (photoEditContext === 'profile') {
                window.settingsPhotoFile = blob;
                window.settingsPhotoUrl = URL.createObjectURL(blob);
                if (profilePhotoEditObjectUrl) {
                    URL.revokeObjectURL(profilePhotoEditObjectUrl);
                    profilePhotoEditObjectUrl = null;
                }
                const photoPreview = document.getElementById('photoPreview');
                const photoDeleteBtn = document.getElementById('photoDeleteBtn');
                if (photoPreview) {
                    photoPreview.style.backgroundImage = `url(${window.settingsPhotoUrl})`;
                    photoPreview.style.backgroundSize = 'cover';
                    photoPreview.style.backgroundPosition = 'center';
                    photoPreview.innerHTML = '';
                    if (photoDeleteBtn) {
                        photoDeleteBtn.classList.toggle('hidden', !appState.isProfileEditing);
                    }
                }
                // 프로필 타입을 photo로 설정
                if (typeof window.setSettingsProfileType === 'function') {
                    window.setSettingsProfileType('photo');
                }
                closePhotoEditModal();
                if (typeof window.showToast === 'function') window.showToast('사진이 적용되었습니다.', 'success');
                return;
            }
        
            if (editingPhotoIndex === null) return;
            const reader = new FileReader();
            reader.onload = () => {
                appState.currentPhotos[editingPhotoIndex] = reader.result;
                renderPhotoPreviews();
                closePhotoEditModal();
            };
            reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.9);
    } catch (e) {
        console.error('사진 편집 저장 실패:', e);
        if (typeof window.showToast === 'function') {
            window.showToast('사진 저장 중 오류가 발생했습니다.', 'error');
        }
    }
}

// 사진 편집 모달 닫기
export function closePhotoEditModal() {
    const modal = document.getElementById('photoEditModal');
    if (modal) {
        modal.classList.add('hidden');
    }
    
    if (photoEditCanvas) {
        photoEditCanvas.removeEventListener('mousedown', handlePhotoEditMouseDown);
        photoEditCanvas.removeEventListener('mousemove', handlePhotoEditMouseMove);
        photoEditCanvas.removeEventListener('mouseup', handlePhotoEditMouseUp);
        photoEditCanvas.removeEventListener('mouseleave', handlePhotoEditMouseUp);
        photoEditCanvas.removeEventListener('touchstart', handlePhotoEditTouchStart, true);
        photoEditCanvas.removeEventListener('touchmove', handlePhotoEditTouchMove, true);
        photoEditCanvas.removeEventListener('touchend', handlePhotoEditTouchEnd, true);
        photoEditCanvas.removeEventListener('touchcancel', handlePhotoEditTouchEnd, true);
        photoEditCanvas.removeEventListener('wheel', handlePhotoEditWheel);
    }
    
    if (photoEditContext === 'profile') {
        if (profilePhotoEditObjectUrl) {
            URL.revokeObjectURL(profilePhotoEditObjectUrl);
            profilePhotoEditObjectUrl = null;
        }
        const photoInput = document.getElementById('photoInput');
        if (photoInput) photoInput.value = '';
    }
    
    editingPhotoIndex = null;
    editingPhotoImage = null;
    photoEditCanvas = null;
    photoEditCtx = null;
    photoEditScale = 1;
    photoEditOffsetX = 0;
    photoEditOffsetY = 0;
    photoEditRotation = 0;
    isPinching = false;
    isDraggingPhoto = false;
    photoEditContext = null;
}

// 전역 함수로 노출
window.editPhoto = editPhoto;
window.openProfilePhotoEdit = openProfilePhotoEdit;
window.closePhotoEditModal = closePhotoEditModal;
window.resetPhotoEdit = resetPhotoEdit;
window.savePhotoEdit = savePhotoEdit;
window.zoomInPhotoEdit = zoomInPhotoEdit;
window.zoomOutPhotoEdit = zoomOutPhotoEdit;
window.rotatePhotoEdit = rotatePhotoEdit;



