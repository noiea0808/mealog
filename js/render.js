// 렌더링 관련 함수들
import { SLOTS, SLOT_STYLES, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';

// HTML 이스케이프 함수 (XSS 방지)
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

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
        if (parentFilter) {
            filteredList = filteredList.filter(item => {
                const parent = typeof item === 'string' ? null : item.parent;
                return !parent || parent === parentFilter;
            });
        }
        
        // 메인 태그가 선택되지 않았을 때는 나만의 태그를 표시하지 않음
        const currentInputVal = document.getElementById(inputId)?.value || '';
        
        if (!parentFilter) {
            // 메인 태그가 선택되지 않았을 때는 아무것도 표시하지 않음
            el.innerHTML = '';
            return;
        }
        
        // 메인 태그가 선택되었을 때만 나만의 태그 표시
        const mainTagKeyMap = {
            'place': 'mealType',
            'menu': 'category',
            'people': 'withWhom',
            'snack': 'snackType'
        };
        const mainTagKey = mainTagKeyMap[subTagKey];
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
        
        // 나만의 태그를 인덱스 순서대로 정렬
        myTagsList.sort((a, b) => {
            const textA = typeof a === 'string' ? a : a.text;
            const textB = typeof b === 'string' ? b : b.text;
            const indexA = myTags.indexOf(textA);
            const indexB = myTags.indexOf(textB);
            return indexA - indexB;
        });
        
        // 나만의 태그 + 최근 태그 순서로 합치기
        const sortedList = [...myTagsList, ...recentTagsList];
        
        if (sortedList.length === 0 && myTags.length === 0) {
            el.innerHTML = `<span class="text-[10px] text-slate-300 py-1 px-2">추천 태그 없음</span>`;
        } else {
            let html = '';
            
            // 나만의 태그와 최근 태그 모두 표시
            html += sortedList.map(t => {
                const text = typeof t === 'string' ? t : t.text;
                const isActive = currentInputVal === text ? 'active' : '';
                const isMyTag = myTagsSet.has(text);
                // 나만의 태그는 삭제 불가, 최근 태그는 삭제 가능
                const canDelete = !isMyTag;
                // 최근 태그도 나만의 태그와 동일한 크기로
                const tagClass = isMyTag 
                    ? 'bg-emerald-100 border border-emerald-400 text-emerald-700 font-bold text-xs' 
                    : 'border border-slate-400 text-slate-600 font-bold text-xs';
                return `<span class="sub-chip-wrapper relative inline-block mr-1 mb-1 group">
                    <button onclick="window.selectTag('${inputId}', '${text}', this, false, '${subTagKey}', '${id}')" class="sub-chip ${isActive} ${tagClass} ${canDelete ? 'pr-7' : ''}">${text}${isMyTag ? ' <i class="fa-solid fa-star text-[9px] text-emerald-600"></i>' : ''}</button>
                    ${canDelete ? `<button onclick="event.stopPropagation(); window.deleteSubTag('${subTagKey}', '${text}', '${id}', '${inputId}', '${parentFilter}')" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-300 hover:text-red-500 w-4 h-4 flex items-center justify-center rounded-full active:bg-slate-200 transition-colors">
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
    renderPrimary('withChips', tags.withWhom, 'withWhomInput', 'people', 'peopleSuggestions');
    window.renderSecondary('peopleSuggestions', subTags?.people || [], 'withWhomInput', null, 'people');
    
    // 간식 타입 칩 렌더링 (설정이 없으면 기본값 사용)
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
        container.innerHTML = appState.currentPhotos.map((src, idx) => 
            `<div class="relative w-28 h-28 rounded-xl overflow-hidden bg-slate-100 flex-shrink-0 photo-preview-item" draggable="true" data-index="${idx}">
                <img src="${src}" class="w-full h-full object-cover">
                <button onclick="window.removePhoto(${idx})" class="photo-remove-btn">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="absolute bottom-1 left-1 w-5 h-5 bg-black/60 text-white text-[10px] font-bold rounded-full flex items-center justify-center">${idx + 1}</div>
                <div class="absolute top-1 left-1 w-5 h-5 bg-black/40 text-white rounded-full flex items-center justify-center cursor-move">
                    <i class="fa-solid fa-grip-vertical text-[8px]"></i>
                </div>
            </div>`
        ).join('');
        
        // 드래그 앤 드롭 이벤트 리스너 추가
        const photoItems = container.querySelectorAll('.photo-preview-item');
        photoItems.forEach(item => {
            item.addEventListener('dragstart', handleDragStart);
            item.addEventListener('dragover', handleDragOver);
            item.addEventListener('drop', handleDrop);
            item.addEventListener('dragend', handleDragEnd);
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
        const container = draggedElement.parentElement;
        const allItems = Array.from(container.querySelectorAll('.photo-preview-item'));
        
        // appState.currentPhotos 순서 업데이트
        const reorderedPhotos = [...appState.currentPhotos];
        const [movedPhoto] = reorderedPhotos.splice(draggedIndex, 1);
        reorderedPhotos.splice(dropIndex, 0, movedPhoto);
        appState.currentPhotos = reorderedPhotos;
        
        // 모든 아이템의 인덱스와 버튼 업데이트
        allItems.forEach((item, idx) => {
            item.dataset.index = idx;
            const numberBadge = item.querySelector('.absolute.bottom-1');
            if (numberBadge) {
                numberBadge.textContent = idx + 1;
            }
            // removePhoto 버튼의 인덱스도 업데이트
            const removeBtn = item.querySelector('.photo-remove-btn');
            if (removeBtn) {
                removeBtn.setAttribute('onclick', `window.removePhoto(${idx})`);
            }
        });
    }
    
    draggedIndex = null;
    draggedElement = null;
    dropIndex = null;
}

export function renderTimeline() {
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
        // 이미 로드된 날짜이거나 DOM에 이미 존재하는 경우 건너뛰기
        if (window.loadedDates.includes(dateStr)) return;
        const existingSection = document.getElementById(`date-${dateStr}`);
        if (existingSection) return;
        
        window.loadedDates.push(dateStr);
        const dObj = new Date(dateStr + 'T00:00:00');
        const dayOfWeek = dObj.getDay();
        let dayColorClass = (dayOfWeek === 0 || dayOfWeek === 6) ? "text-rose-400" : "text-slate-800";
        const section = document.createElement('div');
        section.id = `date-${dateStr}`;
        section.className = "animate-fade";
        // 일간보기 모드일 때만 공유 버튼 추가
        const shareButton = state.viewMode === 'page' 
            ? `<button onclick="window.shareDailySummary('${dateStr}')" class="text-xs text-emerald-600 font-bold px-3 py-1.5 active:text-emerald-700 transition-colors ml-2">
                <i class="fa-solid fa-share text-[10px] mr-1"></i>공유
            </button>`
            : '';
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
                let title = '기록하기';
                let tagsHtml = '';
                if (r) {
                    if (r.mealType === 'Skip') {
                        title = 'Skip';
                    } else {
                        const p = r.place || '';
                        const m = r.menuDetail || r.category || '';
                        title = (p && m) ? `${p} | ${m}` : (p || m || r.mealType);
                        const tags = [];
                        if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
                        if (r.withWhomDetail) tags.push(r.withWhomDetail);
                        else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
                        if (r.satiety) {
                            const sData = SATIETY_DATA.find(d => d.val === r.satiety);
                            if (sData) tags.push(sData.label);
                        }
                        if (tags.length > 0) {
                            tagsHtml = `<div class="mt-2 flex flex-wrap gap-1">${tags.map(t => 
                                `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded">#${t}</span>`
                            ).join('')}</div>`;
                        }
                    }
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
                    iconHtml = `<i class="fa-solid fa-ban text-2xl"></i>`;
                } else {
                    iconHtml = `<i class="fa-solid fa-utensils text-2xl"></i>`;
                }
                html += `<div onclick="window.openModal('${dateStr}', '${slot.id}', ${r ? `'${r.id}'` : null})" class="card mb-1.5 border ${containerClass} cursor-pointer active:scale-[0.98] transition-all !rounded-none">
                    <div class="flex">
                        <div class="w-[140px] h-[140px] ${iconBoxClass} flex-shrink-0 flex items-center justify-center overflow-hidden border-r">
                            ${iconHtml}
                        </div>
                        <div class="flex-1 min-w-0 flex flex-col justify-center p-4">
                            <div class="flex justify-between items-center mb-0.5">
                                <span class="text-xs font-black uppercase ${specificStyle.iconText}">${slot.label}</span>
                                ${r ? `<div class="flex items-center gap-2">
                                    ${r.sharedPhotos && Array.isArray(r.sharedPhotos) && r.sharedPhotos.length > 0 ? `<span class="text-xs text-emerald-600" title="게시됨"><i class="fa-solid fa-share"></i></span>` : ''}
                                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded-md flex items-center gap-0.5"><i class="fa-solid fa-star text-[10px]"></i><span class="text-[11px] font-black">${r.rating || '-'}</span></span>
                                </div>` : ''}
                            </div>
                            <h4 class="text-base font-bold truncate ${titleClass}">${title}</h4>
                            ${r && r.comment ? `<p class="text-xs text-slate-400 mt-1 line-clamp-1">"${r.comment}"</p>` : ''}
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
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-2"></span>
                                ${r.menuDetail || r.snackType || '간식'} 
                                ${r.sharedPhotos && Array.isArray(r.sharedPhotos) && r.sharedPhotos.length > 0 ? `<i class="fa-solid fa-share text-emerald-600 text-[8px] ml-1" title="게시됨"></i>` : ''}
                                ${r.rating ? `<span class="text-[10px] font-black text-yellow-600 bg-yellow-50 px-1 py-0.5 rounded ml-1.5 flex items-center gap-0.5"><i class="fa-solid fa-star text-[9px]"></i>${r.rating}</span>` : ''}
                            </div>`
                        ).join('') : `<span class="text-xs text-slate-400 italic">기록없음</span>`}
                        <button onclick="window.openModal('${dateStr}', '${slot.id}')" class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-100 transition-colors">+ 추가</button>
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
                        class="text-xs text-emerald-600 font-bold px-3 py-1.5 active:text-emerald-700 transition-colors">
                        저장
                    </button>
                </div>
                <textarea id="dailyCommentInput" placeholder="오늘 하루는 어떠셨나요? 하루 전체에 대한 생각을 기록해보세요." 
                    class="w-full p-3 bg-slate-50 rounded-2xl text-sm border border-transparent focus:border-emerald-500 transition-all resize-none min-h-[100px]" 
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
                    <span>더 오래된 기록 보기</span>
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

export function renderMiniCalendar() {
    const state = appState;
    const container = document.getElementById('miniCalendar');
    if (!container || !window.currentUser) return;
    container.innerHTML = "";
    // 로컬 날짜로 변환하여 시간대 문제 방지
    const pageYear = state.pageDate.getFullYear();
    const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
    const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
    const activeStr = `${pageYear}-${pageMonth}-${pageDay}`;
    
    for (let i = 60; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        // 로컬 날짜로 변환하여 시간대 문제 방지
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const iso = `${year}-${month}-${day}`;
        const count = window.mealHistory.filter(m => m.date === iso).length;
        let status = count >= 4 ? "dot-full" : (count > 0 ? "dot-partial" : "dot-none");
        let dayColorClass = (d.getDay() === 0 || d.getDay() === 6) ? "text-rose-400" : "text-slate-400";
        const item = document.createElement('div');
        item.className = "calendar-item flex flex-col items-center gap-1 cursor-pointer flex-shrink-0";
        item.innerHTML = `<span class="text-[9px] font-bold ${dayColorClass}">${d.toLocaleDateString('ko-KR', { weekday: 'narrow' })}</span>
            <div id="dot-${iso}" class="calendar-dot ${status} ${iso === activeStr ? 'dot-selected' : ''}">${d.getDate()}</div>`;
        item.onclick = () => window.jumpToDate(iso);
        container.appendChild(item);
    }
    
    setTimeout(() => {
        const activeDot = document.getElementById(`dot-${activeStr}`);
        if (activeDot) activeDot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        const title = document.getElementById('trackerTitle');
        if (title) title.innerText = `${state.pageDate.getFullYear()}년 ${state.pageDate.getMonth() + 1}월`;
    }, 100);
}

export function renderGallery() {
    const container = document.getElementById('galleryContainer');
    if (!container) return;
    if (!window.sharedPhotos) {
        window.sharedPhotos = [];
    }
    
    if (window.sharedPhotos.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-20 text-center">
                <i class="fa-solid fa-images text-6xl text-slate-200 mb-4"></i>
                <p class="text-sm font-bold text-slate-400">공유된 사진이 없습니다</p>
                <p class="text-xs text-slate-300 mt-2">타임라인에서 사진을 공유해보세요!</p>
            </div>
        `;
        // 빈 갤러리일 때도 맨 위로 스크롤
        setTimeout(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 100);
        return;
    }
    
    // 중복 제거: 같은 photoUrl과 entryId 조합은 하나만 표시
    const seen = new Set();
    const uniquePhotos = window.sharedPhotos.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    
    // entryId와 userId로 그룹화 (같은 기록의 사진들을 묶음)
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        const groupKey = `${photo.entryId || 'no-entry'}_${photo.userId}_${photo.date || ''}_${photo.slotId || ''}`;
        if (!groupedPhotos[groupKey]) {
            groupedPhotos[groupKey] = [];
        }
        groupedPhotos[groupKey].push(photo);
    });
    
    // 각 그룹 내 사진들을 mealHistory의 photos 배열 순서에 맞게 정렬
    const normalizeUrlGallery = (url) => (url || '').split('?')[0];
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        const entryId = photoGroup[0]?.entryId;
        
        if (entryId && window.mealHistory) {
            try {
                const mealRecord = window.mealHistory.find(m => m.id === entryId);
                if (mealRecord && Array.isArray(mealRecord.photos) && mealRecord.photos.length > 0) {
                    // mealHistory의 photos 배열 순서대로 정렬
                    const photosOrder = mealRecord.photos.map(normalizeUrlGallery);
                    
                    photoGroup.sort((a, b) => {
                        const aUrl = normalizeUrlGallery(a.photoUrl);
                        const bUrl = normalizeUrlGallery(b.photoUrl);
                        const aIndex = photosOrder.indexOf(aUrl);
                        const bIndex = photosOrder.indexOf(bUrl);
                        
                        // 순서가 있으면 순서대로, 없으면 timestamp 순으로
                        if (aIndex !== -1 && bIndex !== -1) {
                            return aIndex - bIndex;
                        } else if (aIndex !== -1) {
                            return -1;
                        } else if (bIndex !== -1) {
                            return 1;
                        } else {
                            return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
                        }
                    });
                }
            } catch (e) {
                console.warn('사진 순서 정렬 중 오류 (무시하고 계속 진행):', e);
            }
        } else {
            // entryId가 없으면 timestamp 순으로 정렬
            photoGroup.sort((a, b) => {
                return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            });
        }
    });
    
    // 그룹을 시간순으로 정렬
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        return timeB - timeA; // 최신순
    });
    
    container.innerHTML = sortedGroups.map((photoGroup, groupIdx) => {
        const photo = photoGroup[0]; // 첫 번째 사진의 정보 사용
        const photoCount = photoGroup.length;
        
        // 그룹 내에서 entryId 찾기 (첫 번째 사진에 없으면 다른 사진에서 찾기)
        let entryId = photo.entryId;
        if (!entryId || entryId === '' || entryId === 'null') {
            const photoWithEntryId = photoGroup.find(p => p.entryId && p.entryId !== '' && p.entryId !== 'null');
            if (photoWithEntryId) {
                entryId = photoWithEntryId.entryId;
            }
        }
        
        // 본인 게시물인지 확인
        const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
        
        // 일자 정보
        const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
        const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = photo.time || new Date(photo.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
        
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
        
        // 베스트 공유인지 확인
        const isBestShare = photo.type === 'best';
        
        // 일간보기 공유인지 확인
        const isDailyShare = photo.type === 'daily';
        
        // 간식인지 확인 (slotId로 간식 타입 확인)
        const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
        
        // Comment 정보 가져오기
        // 1. photo 객체에 comment가 있으면 우선 사용
        // 2. entryId가 있고 mealHistory에서 찾을 수 있으면 사용
        let comment = '';
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
        
        let caption = '';
        if (isBestShare) {
            // 베스트 공유인 경우: periodText와 comment 표시
            caption = photo.periodText || '';
            if (photo.comment) {
                caption = caption ? `${caption} - ${photo.comment}` : photo.comment;
            }
        } else if (isDailyShare) {
            // 일간보기 공유인 경우: 날짜 표시
            if (photo.date) {
                const dateObj = new Date(photo.date + 'T00:00:00');
                caption = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
            }
        } else if (isSnack) {
            // 간식인 경우: snackType과 menuDetail 조합
            if (photo.snackType && photo.menuDetail) {
                caption = `${photo.snackType} | ${photo.menuDetail}`;
            } else if (photo.snackType) {
                caption = photo.snackType;
            } else if (photo.menuDetail) {
                caption = photo.menuDetail;
            } else if (photo.place) {
                caption = photo.place;
            }
        } else {
            // 일반 식사인 경우: 기존 로직
            if (photo.place && photo.menuDetail) {
                caption = `${photo.place} | ${photo.menuDetail}`;
            } else if (photo.place) {
                caption = photo.place;
            } else if (photo.menuDetail) {
                caption = photo.menuDetail;
            } else if (photo.mealType) {
                caption = photo.mealType;
            }
        }
        
        // 사진들 HTML 생성 (인스타그램 스타일 - 좌우 여백 없이, 구분감 있게)
        // 베스트 공유와 일간보기 공유는 aspect-ratio를 유지하지 않고 원본 비율 사용
        const photosHtml = photoGroup.map((p, idx) => {
            const isBest = p.type === 'best';
            const isDaily = p.type === 'daily';
            return `
            <div class="flex-shrink-0 w-full snap-start">
                <img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" class="w-full h-auto object-cover" ${(isBest || isDaily) ? '' : 'style="aspect-ratio: 1; object-fit: cover;"'} loading="${idx === 0 ? 'eager' : 'lazy'}">
            </div>
        `;
        }).join('');
        
        return `
            <div class="mb-4 bg-white border-b border-slate-200">
                <div class="px-6 py-3 flex items-center gap-2 relative">
                    <div class="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center text-lg flex-shrink-0">
                        ${photo.userIcon || '🐻'}
                    </div>
                    <div class="flex-1 min-w-0 flex items-center gap-2">
                        <div class="text-sm font-bold text-slate-800 truncate">${photo.userNickname || '익명'}</div>
                        <div class="text-xs text-slate-400">${dateStr}</div>
                        ${mealLabel ? `<div class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                    </div>
                    ${isMyPost ? `
                        <div class="relative">
                            <button data-entry-id="${entryId || ''}" data-photo-urls="${photoGroup.map(p => p.photoUrl).join(',')}" data-is-best="${isBestShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-photo-slot-id="${photo.slotId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                                <i class="fa-solid fa-ellipsis text-lg"></i>
                            </button>
                        </div>
                    ` : ''}
                </div>
                <div class="relative overflow-hidden bg-slate-100">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute bottom-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${caption ? `<div class="px-6 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
                ${comment ? (() => {
                    // comment의 줄바꿈 개수 확인
                    const lineBreaks = (comment.match(/\n/g) || []).length;
                    // 대략적인 텍스트 길이로도 확인 (한 줄에 약 30자 정도로 가정)
                    const estimatedLines = Math.ceil(comment.length / 30);
                    const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
                    const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
                    
                    return `
                    <div class="px-6 pb-3 text-sm text-slate-600 relative">
                        <div id="comment-collapsed-${groupIdx}" class="comment-text whitespace-pre-line line-clamp-2 pr-16">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                        <div id="comment-expanded-${groupIdx}" class="comment-text whitespace-pre-line hidden pr-16">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                        <button onclick="window.toggleComment(${groupIdx})" id="comment-toggle-${groupIdx}" class="absolute right-6 text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors comment-toggle-btn px-2 py-0.5 rounded bg-slate-100/80 backdrop-blur-sm ${toggleBtnClass}" style="bottom: 3px;">더 보기</button>
                        <button onclick="window.toggleComment(${groupIdx})" id="comment-collapse-${groupIdx}" class="absolute right-6 text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors comment-toggle-btn px-2 py-0.5 rounded bg-slate-100/80 backdrop-blur-sm hidden" style="bottom: 3px;">접기</button>
                    </div>
                `;
                })() : ''}
            </div>
        `;
    }).join('');
    
    // 사진 카운터 업데이트를 위한 이벤트 리스너 추가
    setTimeout(() => {
        const scrollContainers = container.querySelectorAll('.flex.overflow-x-auto');
        scrollContainers.forEach((scrollContainer, idx) => {
            const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
            if (counter && sortedGroups[idx].length > 1) {
                const photos = scrollContainer.querySelectorAll('div');
                const updateCounter = () => {
                    const containerWidth = scrollContainer.clientWidth;
                    const scrollLeft = scrollContainer.scrollLeft;
                    // 각 사진의 위치를 확인하여 현재 보이는 사진 인덱스 계산
                    let currentIndex = 1;
                    photos.forEach((photo, photoIdx) => {
                        const photoLeft = photo.offsetLeft;
                        const photoRight = photoLeft + photo.offsetWidth;
                        const viewportLeft = scrollLeft;
                        const viewportRight = scrollLeft + containerWidth;
                        // 사진의 중앙이 뷰포트 안에 있으면 현재 사진
                        const photoCenter = photoLeft + photo.offsetWidth / 2;
                        if (photoCenter >= viewportLeft && photoCenter <= viewportRight) {
                            currentIndex = photoIdx + 1;
                        }
                    });
                    counter.textContent = currentIndex;
                };
                scrollContainer.addEventListener('scroll', updateCounter);
                // 초기 카운터 설정
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
                    window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId);
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
                            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId);
                        });
                        btn.setAttribute('data-listener-added', 'true');
                    }
                }, 200);
            }
        });
        
        // Comment "더 보기" 버튼 표시 여부 확인 및 위치 조정 (DOM 렌더링 후)
        setTimeout(() => {
            sortedGroups.forEach((photoGroup, idx) => {
                const collapsedEl = document.getElementById(`comment-collapsed-${idx}`);
                const expandedEl = document.getElementById(`comment-expanded-${idx}`);
                const toggleBtn = document.getElementById(`comment-toggle-${idx}`);
                const collapseBtn = document.getElementById(`comment-collapse-${idx}`);
                
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
                        const textPaddingBottom = parseFloat(computedStyle.paddingBottom) || 0;
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
        
        // 갤러리 렌더링 완료 후 항상 맨 위로 스크롤
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 100);
}

export function renderFeed() {
    const container = document.getElementById('feedContent');
    if (!container) return;
    if (!window.sharedPhotos) {
        window.sharedPhotos = [];
    }
    
    if (window.sharedPhotos.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-images text-4xl text-slate-200 mb-3"></i>
                <p class="text-xs font-bold text-slate-400">공유된 사진이 없습니다</p>
                <p class="text-[10px] text-slate-300 mt-1">타임라인에서 사진을 공유해보세요!</p>
            </div>
        `;
        return;
    }
    
    // 중복 제거: 같은 photoUrl과 entryId 조합은 하나만 표시
    const seen = new Set();
    const uniquePhotos = window.sharedPhotos.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    
    // entryId와 userId로 그룹화 (같은 기록의 사진들을 묶음)
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        const groupKey = `${photo.entryId || 'no-entry'}_${photo.userId}_${photo.date || ''}_${photo.slotId || ''}`;
        if (!groupedPhotos[groupKey]) {
            groupedPhotos[groupKey] = [];
        }
        groupedPhotos[groupKey].push(photo);
    });
    
    // 각 그룹 내 사진들을 mealHistory의 photos 배열 순서에 맞게 정렬
    const normalizeUrlFeed = (url) => (url || '').split('?')[0];
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        const entryId = photoGroup[0]?.entryId;
        
        if (entryId && window.mealHistory) {
            try {
                const mealRecord = window.mealHistory.find(m => m.id === entryId);
                if (mealRecord && Array.isArray(mealRecord.photos) && mealRecord.photos.length > 0) {
                    // mealHistory의 photos 배열 순서대로 정렬
                    const photosOrder = mealRecord.photos.map(normalizeUrlFeed);
                    
                    photoGroup.sort((a, b) => {
                        const aUrl = normalizeUrlFeed(a.photoUrl);
                        const bUrl = normalizeUrlFeed(b.photoUrl);
                        const aIndex = photosOrder.indexOf(aUrl);
                        const bIndex = photosOrder.indexOf(bUrl);
                        
                        // 순서가 있으면 순서대로, 없으면 timestamp 순으로
                        if (aIndex !== -1 && bIndex !== -1) {
                            return aIndex - bIndex;
                        } else if (aIndex !== -1) {
                            return -1;
                        } else if (bIndex !== -1) {
                            return 1;
                        } else {
                            return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
                        }
                    });
                }
            } catch (e) {
                console.warn('사진 순서 정렬 중 오류 (무시하고 계속 진행):', e);
            }
        } else {
            // entryId가 없으면 timestamp 순으로 정렬
            photoGroup.sort((a, b) => {
                return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            });
        }
    });
    
    // 그룹을 시간순으로 정렬
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        return timeB - timeA; // 최신순
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
        
        // 본인 게시물인지 확인
        const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
        
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
        // 1. photo 객체에 comment가 있으면 우선 사용
        // 2. entryId가 있고 mealHistory에서 찾을 수 있으면 사용
        let comment = '';
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
        
        let caption = '';
        if (isBestShare) {
            // 베스트 공유인 경우: periodText와 comment 표시
            caption = photo.periodText || '';
            if (photo.comment) {
                caption = caption ? `${caption} - ${photo.comment}` : photo.comment;
            }
        } else if (isDailyShare) {
            // 일간보기 공유인 경우: 날짜 표시
            if (photo.date) {
                const dateObj = new Date(photo.date + 'T00:00:00');
                caption = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
            }
        } else if (isSnack) {
            // 간식인 경우: snackType과 menuDetail 조합
            if (photo.snackType && photo.menuDetail) {
                caption = `${photo.snackType} | ${photo.menuDetail}`;
            } else if (photo.snackType) {
                caption = photo.snackType;
            } else if (photo.menuDetail) {
                caption = photo.menuDetail;
            } else if (photo.place) {
                caption = photo.place;
            }
        } else {
            // 일반 식사인 경우: 기존 로직
            if (photo.place && photo.menuDetail) {
                caption = `${photo.place} | ${photo.menuDetail}`;
            } else if (photo.place) {
                caption = photo.place;
            } else if (photo.menuDetail) {
                caption = photo.menuDetail;
            } else if (photo.mealType) {
                caption = photo.mealType;
            }
        }
        
        // 사진들 HTML 생성 (인스타그램 스타일 - 좌우 여백 없이, 구분감 있게)
        // 베스트 공유와 일간보기 공유는 aspect-ratio를 유지하지 않고 원본 비율 사용
        const photosHtml = photoGroup.map((p, idx) => {
            const isBest = p.type === 'best';
            const isDaily = p.type === 'daily';
            return `
            <div class="flex-shrink-0 w-full snap-start">
                <img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" class="w-full h-auto object-cover" ${(isBest || isDaily) ? '' : 'style="aspect-ratio: 1; object-fit: cover;"'} loading="${idx === 0 ? 'eager' : 'lazy'}">
            </div>
        `;
        }).join('');
        
        return `
            <div class="mb-4 bg-white border border-slate-100 rounded-2xl overflow-hidden">
                <div class="px-4 py-3 flex items-center gap-2 relative">
                    <div class="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center text-lg flex-shrink-0">
                        ${photo.userIcon || '🐻'}
                    </div>
                    <div class="flex-1 min-w-0 flex items-center gap-2">
                        <div class="text-sm font-bold text-slate-800 truncate">${photo.userNickname || '익명'}</div>
                        <div class="text-xs text-slate-400">${dateStr}</div>
                        ${mealLabel ? `<div class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                    </div>
                    ${isMyPost ? `
                        <div class="relative">
                            <button data-entry-id="${entryId || ''}" data-photo-urls="${photoGroup.map(p => p.photoUrl).join(',')}" data-is-best="${isBestShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-photo-slot-id="${photo.slotId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                                <i class="fa-solid fa-ellipsis text-lg"></i>
                            </button>
                        </div>
                    ` : ''}
                </div>
                <div class="relative overflow-hidden bg-slate-100">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute bottom-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${caption ? `<div class="px-4 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
                ${comment ? (() => {
                    // comment의 줄바꿈 개수 확인
                    const lineBreaks = (comment.match(/\n/g) || []).length;
                    // 대략적인 텍스트 길이로도 확인 (한 줄에 약 30자 정도로 가정)
                    const estimatedLines = Math.ceil(comment.length / 30);
                    const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
                    const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
                    
                    return `
                    <div class="px-4 pb-3 text-sm text-slate-600 relative">
                        <div id="feed-comment-collapsed-${groupIdx}" class="comment-text whitespace-pre-line line-clamp-2 pr-16">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                        <div id="feed-comment-expanded-${groupIdx}" class="comment-text whitespace-pre-line hidden pr-16">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                        <button onclick="window.toggleFeedComment(${groupIdx})" id="feed-comment-toggle-${groupIdx}" class="absolute right-4 text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors comment-toggle-btn px-2 py-0.5 rounded bg-slate-100/80 backdrop-blur-sm ${toggleBtnClass}" style="bottom: 3px;">더 보기</button>
                        <button onclick="window.toggleFeedComment(${groupIdx})" id="feed-comment-collapse-${groupIdx}" class="absolute right-4 text-xs text-blue-600 font-bold hover:text-blue-700 active:text-blue-800 transition-colors comment-toggle-btn px-2 py-0.5 rounded bg-slate-100/80 backdrop-blur-sm hidden" style="bottom: 3px;">접기</button>
                    </div>
                `;
                })() : ''}
            </div>
        `;
    }).join('');
    
    // 사진 카운터 업데이트를 위한 이벤트 리스너 추가 및 피드 옵션 버튼 이벤트 리스너 추가
    setTimeout(() => {
        const scrollContainers = container.querySelectorAll('.flex.overflow-x-auto');
        scrollContainers.forEach((scrollContainer, idx) => {
            const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
            if (counter && sortedGroups[idx].length > 1) {
                const photos = scrollContainer.querySelectorAll('div');
                const updateCounter = () => {
                    const containerWidth = scrollContainer.clientWidth;
                    const scrollLeft = scrollContainer.scrollLeft;
                    // 각 사진의 위치를 확인하여 현재 보이는 사진 인덱스 계산
                    let currentIndex = 1;
                    photos.forEach((photo, photoIdx) => {
                        const photoLeft = photo.offsetLeft;
                        const photoRight = photoLeft + photo.offsetWidth;
                        const viewportLeft = scrollLeft;
                        const viewportRight = scrollLeft + containerWidth;
                        // 사진의 중앙이 뷰포트 안에 있으면 현재 사진
                        const photoCenter = photoLeft + photo.offsetWidth / 2;
                        if (photoCenter >= viewportLeft && photoCenter <= viewportRight) {
                            currentIndex = photoIdx + 1;
                        }
                    });
                    counter.textContent = currentIndex;
                };
                scrollContainer.addEventListener('scroll', updateCounter);
                // 초기 카운터 설정
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
                    window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId);
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
                            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId);
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
        if (key === 'mealType') labelText = '식사 구분 (대분류)';
        else if (key === 'withWhom') labelText = '함께한 사람 (대분류)';
        else if (key === 'category') labelText = '메뉴 정보 (대분류)';
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
            <input type="text" id="newTag-${isSub ? 'sub-' : ''}${key}" class="flex-1 bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-500" placeholder="태그 추가">
            <button onclick="window.addTag('${key}', ${isSub})" class="bg-emerald-50 text-emerald-600 px-3 py-1 rounded-lg text-xs font-bold border border-emerald-100">추가</button>
        </div>`;
    }
    
    container.innerHTML = html;
}

// 일간보기 공유용 컴팩트 카드 생성
export function createDailyShareCard(dateStr) {
    const dObj = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = dObj.getDay();
    let dayColorClass = (dayOfWeek === 0 || dayOfWeek === 6) ? "text-rose-400" : "text-slate-800";
    const dateLabel = dObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    
    // 기존 컨테이너 제거
    const existing = document.getElementById('dailyShareCardContainer');
    if (existing) existing.remove();
    
    // 공유용 컨테이너 생성 (화면 밖에 숨김)
    const container = document.createElement('div');
    container.id = 'dailyShareCardContainer';
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.width = '400px';
    container.style.backgroundColor = '#ffffff';
    container.style.padding = '24px';
    container.style.fontFamily = 'Pretendard, sans-serif';
    
    let html = `
        <div style="max-width: 400px; margin: 0 auto;">
            <!-- 날짜 헤더 -->
            <div style="display: flex; justify-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #e2e8f0;">
                <h3 style="font-size: 16px; font-weight: 900; color: ${dayOfWeek === 0 || dayOfWeek === 6 ? '#fb7185' : '#1e293b'}; margin: 0;">${dateLabel}</h3>
            </div>
    `;
    
    // 식사 카드들 (컴팩트 버전)
    SLOTS.forEach(slot => {
        if (slot.type === 'main') {
            const records = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
            const r = records[0];
            const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            
            if (r) {
                const p = r.place || '';
                const m = r.menuDetail || r.category || '';
                const title = (p && m) ? `${p} | ${m}` : (p || m || r.mealType || '');
                
                let photoHtml = '';
                if (r.photos && Array.isArray(r.photos) && r.photos[0]) {
                    photoHtml = `<img src="${r.photos[0]}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px;" />`;
                } else if (r.photos && !Array.isArray(r.photos)) {
                    photoHtml = `<img src="${r.photos}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px;" />`;
                } else {
                    photoHtml = `<div style="width: 60px; height: 60px; background: #f1f5f9; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 24px;">
                        🍽️
                    </div>`;
                }
                
                html += `
                    <div style="display: flex; gap: 12px; margin-bottom: 12px; padding: 12px; background: #f8fafc; border-radius: 12px;">
                        ${photoHtml}
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; justify-between; align-items: center; margin-bottom: 4px;">
                                <span style="font-size: 10px; font-weight: 900; color: ${specificStyle.iconText.includes('emerald') ? '#10b981' : specificStyle.iconText.includes('orange') ? '#f97316' : specificStyle.iconText.includes('blue') ? '#3b82f6' : '#64748b'}; text-transform: uppercase;">${slot.label}</span>
                                ${r.rating ? `<span style="font-size: 12px; color: #d97706; font-weight: 900; background: #fef3c7; padding: 3px 6px; border-radius: 6px; display: inline-flex; align-items: center; gap: 2px;">★ <span style="font-weight: 900;">${r.rating}</span></span>` : ''}
                            </div>
                            <div style="font-size: 13px; font-weight: 700; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(title)}</div>
                        </div>
                    </div>
                `;
            }
        }
    });
    
    // 간식 요약
    const snackRecords = window.mealHistory.filter(m => m.date === dateStr && SLOTS.find(s => s.id === m.slotId)?.type === 'snack');
    if (snackRecords.length > 0) {
        const snackList = snackRecords.map(r => r.menuDetail || r.snackType || '간식').join(', ');
        html += `
            <div style="margin-bottom: 12px; padding: 12px; background: #f0fdf4; border-radius: 12px; border-left: 3px solid #10b981;">
                <div style="font-size: 10px; font-weight: 900; color: #059669; text-transform: uppercase; margin-bottom: 4px;">간식</div>
                <div style="font-size: 12px; font-weight: 600; color: #1e293b;">${escapeHtml(snackList)}</div>
            </div>
        `;
    }
    
    // 하루 소감
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
    
    if (dailyComment) {
        // 3줄로 제한
        const commentLines = dailyComment.split('\n').slice(0, 3).join('\n');
        html += `
            <div style="margin-bottom: 12px; padding: 12px; background: #f8fafc; border-radius: 12px; border-left: 3px solid #10b981;">
                <div style="font-size: 10px; font-weight: 900; color: #64748b; text-transform: uppercase; margin-bottom: 6px;">하루 소감</div>
                <div style="font-size: 12px; font-weight: 500; color: #475569; line-height: 1.5; white-space: pre-wrap; max-height: 60px; overflow: hidden;">${escapeHtml(commentLines)}</div>
            </div>
        `;
    }
    
    html += `
        </div>
    `;
    
    container.innerHTML = html;
    document.body.appendChild(container);
    
    return container;
}



