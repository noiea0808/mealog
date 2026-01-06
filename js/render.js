// 렌더링 관련 함수들
import { SLOTS, SLOT_STYLES, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS } from './constants.js';
import { appState } from './state.js';

export function renderEntryChips() {
    const tags = window.userSettings.tags;
    const subTags = window.userSettings.subTags;
    
    // "???" 항목 제거 (기존 사용자 설정 정리)
    if (tags && tags.mealType) {
        const index = tags.mealType.indexOf('???');
        if (index > -1) {
            tags.mealType.splice(index, 1);
        }
    }
    
    const renderPrimary = (id, list, inputId, subTagKey, subContainerId) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = list.map(t => 
            `<button onclick="window.selectTag('${inputId}', '${t}', this, true, '${subTagKey}', '${subContainerId}')" class="chip">${t}</button>`
        ).join('');
    };
    
    window.renderSecondary = (id, list, inputId, parentFilter = null, subTagKey = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        let filteredList = list;
        if (parentFilter) {
            filteredList = list.filter(item => {
                const parent = typeof item === 'string' ? null : item.parent;
                return !parent || parent === parentFilter;
            });
        }
        const currentInputVal = document.getElementById(inputId)?.value || '';
        if (filteredList.length === 0) {
            el.innerHTML = `<span class="text-[10px] text-slate-300 py-1 px-2">추천 태그 없음</span>`;
        } else {
            el.innerHTML = filteredList.map(t => {
                const text = typeof t === 'string' ? t : t.text;
                const isActive = currentInputVal === text ? 'active' : '';
                return `<span class="sub-chip-wrapper relative inline-block mr-1 mb-1 group">
                    <button onclick="window.selectTag('${inputId}', '${text}', this, false, '${subTagKey}', '${id}')" class="sub-chip ${isActive} pr-7">${text}</button>
                    <button onclick="event.stopPropagation(); window.deleteSubTag('${subTagKey}', '${text}', '${id}', '${inputId}', '${parentFilter}')" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-300 hover:text-red-500 w-4 h-4 flex items-center justify-center rounded-full active:bg-slate-200 transition-colors">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </span>`;
            }).join('');
        }
    };
    
    renderPrimary('typeChips', tags.mealType, 'null', 'place', 'restaurantSuggestions');
    window.renderSecondary('restaurantSuggestions', subTags.place || [], 'placeInput', null, 'place');
    renderPrimary('categoryChips', tags.category, 'null', 'menu', 'menuSuggestions');
    window.renderSecondary('menuSuggestions', subTags.menu || [], 'menuDetailInput', null, 'menu');
    renderPrimary('withChips', tags.withWhom, 'withWhomInput', 'people', 'peopleSuggestions');
    window.renderSecondary('peopleSuggestions', subTags.people || [], 'withWhomInput', null, 'people');
    renderPrimary('snackTypeChips', tags.snackType, 'null', 'snack', 'snackSuggestions');
    window.renderSecondary('snackSuggestions', subTags.snack || [], 'snackDetailInput', null, 'snack');
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
    
    const maxPhotos = 5;
    const currentCount = appState.currentPhotos.length;
    
    if (container) {
        container.innerHTML = appState.currentPhotos.map((src, idx) => 
            `<div class="relative w-20 h-20 rounded-xl overflow-hidden bg-slate-100 flex-shrink-0">
                <img src="${src}" class="w-full h-full object-cover">
                <button onclick="window.removePhoto(${idx})" class="photo-remove-btn">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`
        ).join('');
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
            buttonEl.title = '사진은 최대 5개까지 추가할 수 있습니다';
        } else {
            buttonEl.disabled = false;
            buttonEl.classList.remove('opacity-50', 'cursor-not-allowed');
            buttonEl.classList.add('active:bg-slate-100');
            buttonEl.title = '';
        }
    }
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
        section.className = "animate-fade pb-0.5";
        let html = `<h3 class="date-section-header text-sm font-black ${dayColorClass} mb-1 px-4">${dObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}</h3>`;

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
                                `<span class="text-[10px] text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100">#${t}</span>`
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
                                    <span class="text-xs text-yellow-500"><i class="fa-solid fa-star mr-0.5"></i>${r.rating || '-'}</span>
                                    <span class="text-[9px] text-slate-300">${r.time}</span>
                                </div>` : ''}
                            </div>
                            <h4 class="text-base font-bold truncate ${titleClass}">${title}</h4>
                            ${r && r.comment ? `<p class="text-xs text-slate-400 mt-1 line-clamp-1">"${r.comment}"</p>` : ''}
                            ${tagsHtml}
                        </div>
                    </div>
                </div>`;
            } else {
                html += `<div class="snack-row mb-1.5 px-2 flex items-center">
                    <span class="text-xs font-black text-slate-400 uppercase mr-3 w-16">${slot.label}</span>
                    <div class="flex-1 flex flex-wrap gap-2 items-center">
                        ${records.length > 0 ? records.map(r => 
                            `<div onclick="window.openModal('${dateStr}', '${slot.id}', '${r.id}')" class="snack-tag cursor-pointer active:bg-slate-50">
                                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-2"></span>
                                ${r.menuDetail || r.snackType || '간식'} 
                                ${r.sharedPhotos && Array.isArray(r.sharedPhotos) && r.sharedPhotos.length > 0 ? `<i class="fa-solid fa-share text-emerald-600 text-[8px] ml-1" title="게시됨"></i>` : ''}
                                ${r.rating ? `<i class="fa-solid fa-star text-yellow-400 text-[8px] ml-1"></i>${r.rating}` : ''}
                            </div>`
                        ).join('') : `<span class="text-xs text-slate-300 italic">기록없음</span>`}
                        <button onclick="window.openModal('${dateStr}', '${slot.id}')" class="text-xs font-bold text-emerald-600 bg-emerald-50 px-2.5 py-1.5 rounded-lg border border-emerald-100 transition-colors">+ 추가</button>
                    </div>
                </div>`;
            }
        });
        section.innerHTML = html;
        container.appendChild(section);
    });
    
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
    
    // 그룹을 시간순으로 정렬
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        return timeB - timeA; // 최신순
    });
    
    container.innerHTML = sortedGroups.map((photoGroup, groupIdx) => {
        const photo = photoGroup[0]; // 첫 번째 사진의 정보 사용
        const photoCount = photoGroup.length;
        
        // 일자 정보
        const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
        const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        const timeStr = photo.time || new Date(photo.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
        
        // 끼니 구분 정보
        let mealLabel = '';
        if (photo.slotId) {
            const slot = SLOTS.find(s => s.id === photo.slotId);
            mealLabel = slot ? slot.label : '';
        }
        
        // 간식인지 확인 (slotId로 간식 타입 확인)
        const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
        
        let caption = '';
        if (isSnack) {
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
        
        // 사진들 HTML 생성 (인스타그램 스타일 - 좌우 여백 없이)
        const photosHtml = photoGroup.map((p, idx) => `
            <div class="flex-shrink-0 w-full">
                <img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" class="w-full h-auto object-cover" style="aspect-ratio: 1; object-fit: cover;" loading="${idx === 0 ? 'eager' : 'lazy'}">
            </div>
        `).join('');
        
        return `
            <div class="mb-4 bg-white border-b border-slate-200">
                <div class="px-6 py-3 flex items-center gap-2">
                    <div class="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center text-lg flex-shrink-0">
                        ${photo.userIcon || '🐻'}
                    </div>
                    <div class="flex-1 min-w-0 flex items-center gap-2">
                        <div class="text-sm font-bold text-slate-800 truncate">${photo.userNickname || '익명'}</div>
                        <div class="text-xs text-slate-400">${dateStr}</div>
                        ${mealLabel ? `<div class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                    </div>
                </div>
                <div class="relative overflow-hidden bg-slate-100">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide" style="scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute bottom-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${caption ? `<div class="px-6 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
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
    
    // 그룹을 시간순으로 정렬
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        return timeB - timeA; // 최신순
    });
    
    container.innerHTML = sortedGroups.map((photoGroup, groupIdx) => {
        const photo = photoGroup[0]; // 첫 번째 사진의 정보 사용
        const photoCount = photoGroup.length;
        
        // 일자 정보
        const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
        const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        
        // 끼니 구분 정보
        let mealLabel = '';
        if (photo.slotId) {
            const slot = SLOTS.find(s => s.id === photo.slotId);
            mealLabel = slot ? slot.label : '';
        }
        
        // 간식인지 확인 (slotId로 간식 타입 확인)
        const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
        
        let caption = '';
        if (isSnack) {
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
        
        // 사진들 HTML 생성 (인스타그램 스타일 - 좌우 여백 없이)
        const photosHtml = photoGroup.map((p, idx) => `
            <div class="flex-shrink-0 w-full">
                <img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" class="w-full h-auto object-cover" style="aspect-ratio: 1; object-fit: cover;" loading="${idx === 0 ? 'eager' : 'lazy'}">
            </div>
        `).join('');
        
        return `
            <div class="mb-4 bg-white border border-slate-100 rounded-2xl overflow-hidden">
                <div class="px-4 py-3 flex items-center gap-2">
                    <div class="w-8 h-8 bg-emerald-100 rounded-full flex items-center justify-center text-lg flex-shrink-0">
                        ${photo.userIcon || '🐻'}
                    </div>
                    <div class="flex-1 min-w-0 flex items-center gap-2">
                        <div class="text-sm font-bold text-slate-800 truncate">${photo.userNickname || '익명'}</div>
                        <div class="text-xs text-slate-400">${dateStr}</div>
                        ${mealLabel ? `<div class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                    </div>
                </div>
                <div class="relative overflow-hidden bg-slate-100">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide" style="scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute bottom-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${caption ? `<div class="px-4 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
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
    }, 100);
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



