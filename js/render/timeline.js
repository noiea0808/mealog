// 타임라인 및 미니 캘린더 렌더링
import { SLOTS, SLOT_STYLES, SATIETY_DATA } from '../constants.js';
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';

// entryId가 실제로 공유되었는지 확인하는 헬퍼 함수
function isEntryShared(entryId) {
    if (!entryId || !window.sharedPhotos || !Array.isArray(window.sharedPhotos)) {
        return false;
    }
    // window.sharedPhotos에서 해당 entryId를 가진 항목이 있는지 확인
    return window.sharedPhotos.some(photo => photo.entryId === entryId);
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
                
                const shareButton = `<button onclick="window.shareDailySummary('${dateStr}')" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-emerald-600 text-white' : 'text-slate-600'}">
                    <i class="fa-solid fa-share text-[10px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
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
            // 공유 상태 확인 (본인 것만 확인)
            const dailyShare = window.sharedPhotos && Array.isArray(window.sharedPhotos) 
                ? window.sharedPhotos.find(photo => 
                    photo.type === 'daily' && 
                    photo.date === dateStr && 
                    photo.userId === window.currentUser?.uid
                )
                : null;
            const isShared = !!dailyShare;
            
            shareButton = `<button onclick="window.shareDailySummary('${dateStr}')" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-emerald-600 text-white' : 'text-slate-600'}">
                <i class="fa-solid fa-share text-[10px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
            </button>`;
        }
        let html = `<div class="date-section-header text-sm font-black ${dayColorClass} px-4 flex items-center justify-between">
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
                            tagsHtml = `<div class="mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags.map(t => 
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
                            <div class="flex justify-between items-start">
                                <div class="flex-1">
                                    <h4 class="leading-tight mb-0 truncate">${titleLine1}</h4>
                                    ${titleLine2 ? (r ? `<p class="text-sm text-slate-600 font-bold mt-1.5 mb-0 truncate">${titleLine2}</p>` : `<p class="mt-1.5 mb-0 truncate">${titleLine2}</p>`) : ''}
                                </div>
                                ${r ? `<div class="flex items-center gap-2 flex-shrink-0 ml-2">
                                    ${isEntryShared(r.id) ? `<span class="text-xs text-slate-500" title="게시됨"><i class="fa-solid fa-share"></i></span>` : ''}
                                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 border border-yellow-300 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                                        <span class="text-[13px]">⭐</span>
                                        <span class="text-[12px] font-black">${r.rating || '-'}</span>
                                    </span>
                                </div>` : ''}
                            </div>
                            ${r && r.comment ? `<p class="text-xs text-slate-400 mt-1.5 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
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
                                ${r.menuDetail || r.snackType || '간식'} 
                                ${isEntryShared(r.id) ? `<i class="fa-solid fa-share text-slate-500 text-[8px] ml-1" title="게시됨"></i>` : ''}
                                ${r.rating ? `<span class="text-[10px] font-black text-yellow-600 bg-yellow-50 border border-yellow-300 px-1 py-0.5 rounded-full ml-1.5 flex items-center gap-0.5">
                                    <span class="text-[11px]">⭐</span>
                                    <span class="text-[11px] font-black">${r.rating}</span>
                                </span>` : ''}
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
        item.innerHTML = `<span class="text-[11px] font-bold ${dayColorClass}">${d.toLocaleDateString('ko-KR', { weekday: 'narrow' })}</span>
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
