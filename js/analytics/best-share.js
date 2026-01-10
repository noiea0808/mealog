// 베스트 공유 관련 함수들
import { SLOTS, SLOT_STYLES, SATIETY_DATA } from '../constants.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { dbOps } from '../db.js';
import { getWeekRange, getCurrentWeekInMonth, getWeeksInMonth, getDayName } from './date-utils.js';
import { renderGallery } from '../render.js';

// 주간 베스트 가져오기 (만족도 4~5점, 전부 표시)
function getWeekBestMeals(year, month, week) {
    const { start, end } = getWeekRange(year, month, week);
    const startStr = start.toISOString().split('T')[0];
    const endStr = end.toISOString().split('T')[0];
    
    const weekData = window.mealHistory.filter(m => {
        return m.date >= startStr && m.date <= endStr;
    });
    
    const highRatingMeals = weekData.filter(m => {
        return m.rating && parseInt(m.rating) >= 4;
    });
    
    // 만족도 내림차순, 날짜 내림차순으로 정렬 (모든 항목 반환)
    const sorted = [...highRatingMeals].sort((a, b) => {
        if (parseInt(b.rating) !== parseInt(a.rating)) {
            return parseInt(b.rating) - parseInt(a.rating);
        }
        return b.date.localeCompare(a.date);
    });
    
    return sorted;
}

// 월간 베스트 가져오기 (각 주간 베스트에서 선정된 것들만)
function getMonthBestMeals(year, month) {
    const totalWeeks = getWeeksInMonth(year, month);
    const allBestMeals = [];
    const mealMap = new Map(); // 중복 제거용 (같은 음식은 한 번만)
    
    // 해당 월의 시작일과 종료일 계산
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const monthStartStr = monthStart.toISOString().split('T')[0];
    const monthEndStr = monthEnd.toISOString().split('T')[0];
    
    for (let week = 1; week <= totalWeeks; week++) {
        // 각 주간의 베스트 가져오기 (사용자가 설정한 순서 포함)
        const weekKey = `week_${year}_${month}_${week}`;
        const savedWeekOrder = (window.userSettings && window.userSettings.bestMeals ? window.userSettings.bestMeals[weekKey] : null) || [];
        const weekBest = getWeekBestMeals(year, month, week);
        
        // 저장된 순서가 있으면 그 순서대로, 없으면 만족도 순으로
        const orderedWeekBest = [...weekBest].sort((a, b) => {
            if (savedWeekOrder.length > 0) {
                const aIdx = savedWeekOrder.indexOf(a.id);
                const bIdx = savedWeekOrder.indexOf(b.id);
                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                if (aIdx !== -1) return -1;
                if (bIdx !== -1) return 1;
            }
            // 순서가 없으면 만족도 내림차순
            if (parseInt(b.rating) !== parseInt(a.rating)) {
                return parseInt(b.rating) - parseInt(a.rating);
            }
            return b.date.localeCompare(a.date);
        });
        
        // 주간 베스트만 추가 (해당 월에 속한 날짜만)
        orderedWeekBest.forEach(meal => {
            if (meal.date >= monthStartStr && meal.date <= monthEndStr) {
                const key = `${meal.menuDetail || meal.snackType || ''}_${meal.date}_${meal.slotId}`;
                if (!mealMap.has(key)) {
                    mealMap.set(key, meal);
                    allBestMeals.push(meal);
                }
            }
        });
    }
    
    return allBestMeals;
}

// 연간 베스트 가져오기 (각 월간 베스트에서 선정된 것들만)
function getYearBestMeals(year) {
    const allBestMeals = [];
    const mealMap = new Map(); // 중복 제거용
    
    for (let month = 1; month <= 12; month++) {
        // 각 월간의 베스트 가져오기 (사용자가 설정한 순서 포함)
        const monthStr = month < 10 ? `0${month}` : `${month}`;
        const monthKey = `${year}-${monthStr}`;
        const savedMonthOrder = (window.userSettings && window.userSettings.bestMeals ? window.userSettings.bestMeals[`month_${monthKey}`] : null) || [];
        const monthBest = getMonthBestMeals(year, month);
        
        // 저장된 순서가 있으면 그 순서대로, 없으면 만족도 순으로
        const orderedMonthBest = [...monthBest].sort((a, b) => {
            if (savedMonthOrder.length > 0) {
                const aIdx = savedMonthOrder.indexOf(a.id);
                const bIdx = savedMonthOrder.indexOf(b.id);
                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                if (aIdx !== -1) return -1;
                if (bIdx !== -1) return 1;
            }
            // 순서가 없으면 만족도 내림차순
            if (parseInt(b.rating) !== parseInt(a.rating)) {
                return parseInt(b.rating) - parseInt(a.rating);
            }
            return b.date.localeCompare(a.date);
        });
        
        // 월간 베스트만 추가
        orderedMonthBest.forEach(meal => {
            const key = `${meal.menuDetail || meal.snackType || ''}_${meal.date}_${meal.slotId}`;
            if (!mealMap.has(key)) {
                mealMap.set(key, meal);
                allBestMeals.push(meal);
            }
        });
    }
    
    return allBestMeals;
}

// 주간/월간이 끝났는지 확인하는 함수
function isPeriodEnded() {
    const state = appState;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (state.dashboardMode === 'week') {
        // 주간 모드: 선택한 주의 마지막 날(토요일)이 지났는지 확인
        const { end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        const weekEnd = new Date(end);
        weekEnd.setHours(23, 59, 59, 999);
        return today > weekEnd;
    } else if (state.dashboardMode === 'month') {
        // 월간 모드: 선택한 월의 마지막 날이 지났는지 확인
        const [y, m] = state.selectedMonth.split('-').map(Number);
        const monthEnd = new Date(y, m, 0); // 해당 월의 마지막 날
        monthEnd.setHours(23, 59, 59, 999);
        return today > monthEnd;
    }
    
    return false;
}

function getBestPeriodKey() {
    const state = appState;
    if (state.dashboardMode === '7d') {
        // 최근1주 = 주별 키 반환
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth() + 1;
        const currentWeek = getCurrentWeekInMonth(currentYear, currentMonth);
        return `week_${currentYear}_${currentMonth}_${currentWeek}`;
    } else if (state.dashboardMode === 'week') {
        return `week_${state.selectedYear}_${state.selectedMonthForWeek}_${state.selectedWeek}`;
    } else if (state.dashboardMode === 'month') {
        return `month_${state.selectedMonth}`;
    } else if (state.dashboardMode === 'year') {
        return `year_${state.selectedYearForYear}`;
    } else if (state.dashboardMode === 'custom') {
        // 직접설정 = 연간 키 반환
        const year = state.customStartDate.getFullYear();
        return `year_${year}_custom`;
    }
    return 'default';
}

// Best 탭 데이터 렌더링 함수
export function renderBestMeals() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;
    
    const state = appState;
    let meals = [];
    let periodLabel = '';
    let periodKey = '';
    
    // periodLabel 업데이트
    const periodLabelEl = document.getElementById('bestPeriodLabel');
    
    if (state.dashboardMode === '7d') {
        // 최근1주 → 주간 베스트 표시
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth() + 1;
        const currentWeek = getCurrentWeekInMonth(currentYear, currentMonth);
        
        meals = getWeekBestMeals(currentYear, currentMonth, currentWeek);
        periodKey = `week_${currentYear}_${currentMonth}_${currentWeek}`;
        periodLabel = '주간';
    } else if (state.dashboardMode === 'week') {
        // 주간 모드: 해당 기간의 만족도 4~5개 리스트
        meals = getWeekBestMeals(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodKey = `week_${state.selectedYear}_${state.selectedMonthForWeek}_${state.selectedWeek}`;
        periodLabel = '';
    } else if (state.dashboardMode === 'month') {
        // 월간 모드: 각 주간에서 1~5위
        const [y, m] = state.selectedMonth.split('-').map(Number);
        meals = getMonthBestMeals(y, m);
        periodKey = `month_${state.selectedMonth}`;
        periodLabel = '';
    } else if (state.dashboardMode === 'year') {
        // 연간 모드: 각 월별 1~5위
        meals = getYearBestMeals(state.selectedYearForYear);
        periodKey = `year_${state.selectedYearForYear}`;
        periodLabel = '';
    } else if (state.dashboardMode === 'custom') {
        // 직접설정 → 연간 베스트 표시
        const year = state.customStartDate.getFullYear();
        meals = getYearBestMeals(year);
        periodKey = `year_${year}_custom`;
        periodLabel = '연간';
    }
    
    // periodLabel 표시
    if (periodLabelEl) {
        periodLabelEl.textContent = periodLabel;
    }
    
    // 공유 버튼 표시 여부 및 상태 확인
    const shareBtn = document.getElementById('shareBestBtn');
    if (shareBtn) {
        const periodEnded = isPeriodEnded();
        const hasTop3Meals = () => {
            // 1~3위 메뉴가 있는지 확인 (필터링 전 meals 사용)
            const top3 = meals.filter(m => m && m.rating).slice(0, 3);
            return top3.length >= 1; // 최소 1개 이상이면 공유 가능
        };
        
        if (periodEnded && hasTop3Meals()) {
            shareBtn.classList.remove('hidden');
            
            // 공유 상태 확인 및 버튼 텍스트 업데이트
            const state = appState;
            let periodType = '';
            let periodText = '';
            
            if (state.dashboardMode === 'week') {
                periodType = '주간';
                periodText = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주`;
            } else if (state.dashboardMode === 'month') {
                periodType = '월간';
                const [y, m] = state.selectedMonth.split('-').map(Number);
                periodText = `${y}년 ${m}월`;
            }
            
            // window.sharedPhotos에서 해당 기간의 베스트 공유 찾기
            const bestShare = window.sharedPhotos && Array.isArray(window.sharedPhotos)
                ? window.sharedPhotos.find(photo => 
                    photo.type === 'best' && 
                    photo.periodType === periodType && 
                    photo.periodText === periodText
                )
                : null;
            
            const isShared = !!bestShare;
            
            // 버튼 텍스트 및 스타일 업데이트 (베스트는 초록색 배경)
            if (isShared) {
                shareBtn.innerHTML = `<i class="fa-solid fa-share text-[10px] mr-1"></i>공유됨`;
                shareBtn.className = 'text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 bg-emerald-600 text-white rounded-lg';
            } else {
                shareBtn.innerHTML = `<i class="fa-solid fa-share text-[10px] mr-1"></i>공유하기`;
                shareBtn.className = 'text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 text-emerald-600 rounded-lg';
            }
        } else {
            shareBtn.classList.add('hidden');
        }
    }
    
    // 월간/연간 모드에서는 만족도 5점 음식만 필터링
    const isMonthOrYearMode = state.dashboardMode === 'month' || state.dashboardMode === 'year' || state.dashboardMode === 'custom';
    const filteredMeals = isMonthOrYearMode 
        ? meals.filter(m => m && m.rating && parseInt(m.rating) === 5)
        : meals.filter(m => m && m.rating);
    
    if (filteredMeals.length === 0) {
        const message = isMonthOrYearMode 
            ? '만족도 5점인 기록이 없습니다.'
            : '만족도 4점 이상인 기록이 없습니다.';
        container.innerHTML = `<div class="text-center py-8 text-slate-400 text-sm">${message}</div>`;
        return;
    }
    
    // 저장된 순서 적용
    const savedOrder = (window.userSettings && window.userSettings.bestMeals ? window.userSettings.bestMeals[periodKey] : null) || [];
    
    const sortedMeals = [...filteredMeals].sort((a, b) => {
        const aRating = a.rating ? parseInt(a.rating) : 0;
        const bRating = b.rating ? parseInt(b.rating) : 0;
        const aIndex = savedOrder.indexOf(a.id);
        const bIndex = savedOrder.indexOf(b.id);
        
        // 주간 모드에서는 만족도가 높은 것이 기본적으로 위에 오도록
        const isWeekMode = state.dashboardMode === '7d' || state.dashboardMode === 'week';
        
        if (isWeekMode) {
            // 만족도가 다르면 만족도 우선 (5점이 4점보다 위에)
            if (aRating !== bRating) {
                return bRating - aRating;
            }
            // 만족도가 같고 둘 다 저장된 순서에 있으면 저장된 순서대로
            if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
            }
            // 만족도가 같고 하나만 저장된 순서에 있으면 저장된 것이 위에
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            // 만족도가 같고 둘 다 저장된 순서에 없으면 날짜 순
            if (a.date && b.date) {
                return b.date.localeCompare(a.date);
            }
            return 0;
        } else {
            // 월간/연간 모드는 기존 로직 유지 (저장된 순서 우선)
            if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
            } else if (aIndex !== -1) {
                return -1;
            } else if (bIndex !== -1) {
                return 1;
            } else {
                if (bRating !== aRating) {
                    return bRating - aRating;
                }
                if (a.date && b.date) {
                    return b.date.localeCompare(a.date);
                }
                return 0;
            }
        }
    });
    
    const displayMeals = sortedMeals;
    
    container.innerHTML = displayMeals.filter(m => m && m.id).map((meal, index) => {
        if (!meal) return '';
        const slot = SLOTS.find(s => s.id === meal.slotId);
        const slotLabel = slot ? slot.label : '알 수 없음';
        const isSnack = slot && slot.type === 'snack';
        const displayTitle = isSnack ? (meal.menuDetail || meal.snackType || '간식') : (meal.menuDetail || meal.mealType || '식사');
        const photoUrl = meal.photos && Array.isArray(meal.photos) && meal.photos.length > 0 ? meal.photos[0] : null;
        const date = meal.date ? new Date(meal.date + 'T00:00:00') : new Date();
        const dateStr = `${date.getMonth() + 1}.${date.getDate()}(${getDayName(date)})`;
        const rating = meal.rating ? parseInt(meal.rating) : 0;
        const rank = index + 1;
        
        // 1~3위는 금은동 색상, 4위 이상은 기본 색상
        let rankDisplay = rank.toString();
        let rankBgClass = 'bg-emerald-100';
        let rankTextClass = 'text-emerald-700';
        if (rank === 1) {
            // 1위: 금색
            rankBgClass = 'bg-yellow-500';
            rankTextClass = 'text-white';
        } else if (rank === 2) {
            // 2위: 은색
            rankBgClass = 'bg-gray-400';
            rankTextClass = 'text-white';
        } else if (rank === 3) {
            // 3위: 동색
            rankBgClass = 'bg-amber-600';
            rankTextClass = 'text-white';
        } else {
            // 4위 이상: 기본 색상
            rankBgClass = 'bg-emerald-100';
            rankTextClass = 'text-emerald-700';
        }
        
        // 타임라인과 동일한 정보 구성
        const place = meal.place || '';
        const menuDetail = meal.menuDetail || '';
        const title = (place && menuDetail) ? `${place} | ${menuDetail}` : (place || menuDetail || displayTitle);
        
        // 태그 정보 수집
        const tags = [];
        if (meal.mealType && meal.mealType !== 'Skip') tags.push(meal.mealType);
        if (meal.withWhomDetail) tags.push(meal.withWhomDetail);
        else if (meal.withWhom && meal.withWhom !== '혼자') tags.push(meal.withWhom);
        if (meal.satiety) {
            const sData = SATIETY_DATA.find(d => d.val === meal.satiety);
            if (sData) tags.push(sData.label);
        }
        
        // 날짜 포맷 (타임라인과 동일하게)
        const dateObj = meal.date ? new Date(meal.date + 'T00:00:00') : new Date();
        const formattedDate = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        
        // 슬롯 스타일 가져오기
        const specificStyle = SLOT_STYLES[meal.slotId] || SLOT_STYLES['default'];
        const iconBoxClass = `bg-slate-100 border-slate-200 ${specificStyle.iconText}`;
        
        // 아이콘 HTML 생성
        let iconHtml = '';
        if (photoUrl) {
            iconHtml = `<img src="${photoUrl}" class="w-full h-full object-cover">`;
        } else if (meal.mealType === 'Skip') {
            iconHtml = `<i class="fa-solid fa-ban text-2xl"></i>`;
        } else {
            iconHtml = `<i class="fa-solid fa-utensils text-2xl"></i>`;
        }
        
        // 태그 HTML 생성
        let tagsHtml = '';
        if (tags.length > 0) {
            tagsHtml = `<div class="mt-1 flex flex-wrap gap-1 pr-2">${tags.map(t => 
                `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded">#${t}</span>`
            ).join('')}</div>`;
        }
        
        // 안전한 문자열 이스케이프
        const safeDate = (meal.date || '').replace(/'/g, "\\'");
        const safeSlotId = (meal.slotId || '').replace(/'/g, "\\'");
        const safeMealId = (meal.id || '').replace(/'/g, "\\'");
        
        return `
            <div class="best-meal-item card mb-0 border-t border-b border-slate-200 cursor-move active:scale-[0.98] transition-all bg-white" 
                 data-meal-id="${safeMealId}" 
                 data-rating="${rating}"
                 data-date="${safeDate}"
                 data-slot-id="${safeSlotId}"
                 draggable="true"
                 style="height: 140px;">
                <div class="flex relative h-full">
                    <div class="w-[140px] h-full ${iconBoxClass} flex-shrink-0 flex items-center justify-center overflow-hidden border-r relative">
                        <div class="absolute top-1 left-1 w-6 h-6 rounded-full ${rankBgClass} ${rankTextClass} flex items-center justify-center text-xs font-bold z-10">
                            ${rankDisplay}
                        </div>
                        ${iconHtml}
                    </div>
                    <div class="flex-1 min-w-0 flex flex-col justify-center p-4 pr-12 relative">
                        <div class="absolute top-2 right-2 flex items-center gap-2 z-10">
                            ${meal.sharedPhotos && Array.isArray(meal.sharedPhotos) && meal.sharedPhotos.length > 0 ? `<span class="text-xs text-emerald-600" title="게시됨"><i class="fa-solid fa-share"></i></span>` : ''}
                            <span class="text-xs font-bold text-yellow-600 bg-yellow-50 px-1.5 py-0.5 rounded-md flex items-center gap-0.5"><i class="fa-solid fa-star text-[10px]"></i><span class="text-[11px] font-black">${rating || '-'}</span></span>
                        </div>
                        <div class="flex items-center gap-2 mb-1.5 pr-16">
                            <span class="text-xs font-black uppercase ${specificStyle.iconText}">${slotLabel}</span>
                            <span class="text-xs text-slate-400">${formattedDate}</span>
                        </div>
                        <h4 class="text-base font-bold truncate text-slate-800 mb-1 pr-2">${title}</h4>
                        ${meal.comment ? `<p class="text-xs text-slate-400 mb-1.5 line-clamp-1 pr-2">"${meal.comment}"</p>` : ''}
                        ${tagsHtml}
                    </div>
                    <div class="absolute top-1/2 right-2 -translate-y-1/2 text-slate-300">
                        <i class="fa-solid fa-grip-vertical text-sm"></i>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // 월간/연간 모드에서는 만족도 5점 음식만 순서 조정 가능
    setupDragAndDrop(isMonthOrYearMode && displayMeals.length > 0);
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.best-meal-item:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

async function updateBestOrder() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;
    
    if (!window.userSettings) {
        console.warn('userSettings가 아직 초기화되지 않았습니다.');
        return;
    }
    
    const items = container.querySelectorAll('.best-meal-item');
    const order = Array.from(items).map(item => item.getAttribute('data-meal-id'));
    
    const periodKey = getBestPeriodKey();
    
    if (!window.userSettings.bestMeals) {
        window.userSettings.bestMeals = {};
    }
    window.userSettings.bestMeals[periodKey] = order;
    
    // 순위 번호 업데이트 (동그라미 내부)
    items.forEach((item, index) => {
        const newRank = index + 1;
        // 순위 동그라미 찾기 (absolute top-1 left-1을 가진 요소)
        const rankCircle = Array.from(item.querySelectorAll('*')).find(el => 
            el.classList.contains('absolute') && 
            el.classList.contains('top-1') && 
            el.classList.contains('left-1') &&
            el.classList.contains('rounded-full')
        );
        if (rankCircle) {
            // 1~3위는 금은동 색상, 4위 이상은 기본 색상
            rankCircle.textContent = newRank;
            if (newRank === 1) {
                // 1위: 금색
                rankCircle.className = 'absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold z-10 bg-yellow-500 text-white';
            } else if (newRank === 2) {
                // 2위: 은색
                rankCircle.className = 'absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold z-10 bg-gray-400 text-white';
            } else if (newRank === 3) {
                // 3위: 동색
                rankCircle.className = 'absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold z-10 bg-amber-600 text-white';
            } else {
                // 4위 이상: 기본 색상
                rankCircle.className = 'absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold z-10 bg-emerald-100 text-emerald-700';
            }
        }
    });
    
    try {
        if (window.dbOps && window.dbOps.saveSettings) {
            await window.dbOps.saveSettings(window.userSettings);
        }
    } catch (e) {
        console.error('Best 순서 저장 실패:', e);
    }
}

function setupDragAndDrop(enableRatingConstraint = false) {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;
    
    let draggedElement = null;
    let isDragging = false;
    
    container.querySelectorAll('.best-meal-item').forEach(item => {
        // 클릭 이벤트 추가 (드래그 중이 아닐 때만)
        item.addEventListener('click', (e) => {
            if (!isDragging) {
                const date = item.getAttribute('data-date');
                const slotId = item.getAttribute('data-slot-id');
                const mealId = item.getAttribute('data-meal-id');
                if (date && slotId && mealId) {
                    window.openModal(date, slotId, mealId);
                }
            }
        });
        
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            isDragging = true;
            item.classList.add('opacity-50');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        item.addEventListener('dragend', (e) => {
            item.classList.remove('opacity-50');
            isDragging = false;
            container.querySelectorAll('.best-meal-item').forEach(el => {
                el.classList.remove('border-emerald-400', 'bg-emerald-50', 'border-red-400', 'bg-red-50');
            });
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            if (!draggedElement) return;
            
            // 만족도 제약 체크 (월간/연간 모드에서는 모든 음식이 5점이므로 제약 없음, 그냥 순서만 조정)
            // 제약 로직은 제거 (모두 5점이므로)
            
            item.classList.add('border-emerald-400', 'bg-emerald-50');
        });
        
        item.addEventListener('dragleave', (e) => {
            item.classList.remove('border-emerald-400', 'bg-emerald-50', 'border-red-400', 'bg-red-50');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('border-emerald-400', 'bg-emerald-50', 'border-red-400', 'bg-red-50');
            
            if (!draggedElement || draggedElement === item) return;
            
            const container = item.parentElement;
            const afterElement = getDragAfterElement(container, e.clientY);
            
            // 월간/연간 모드에서는 모든 음식이 5점이므로 제약 없음, 순서만 조정
            
            if (afterElement == null) {
                container.appendChild(draggedElement);
            } else {
                container.insertBefore(draggedElement, afterElement);
            }
            
            updateBestOrder();
        });
    });
}

// 베스트 공유 상태 확인
async function checkBestShareStatus(periodType, periodText) {
    if (!window.currentUser || !window.sharedPhotos) return null;
    
    // window.sharedPhotos에서 해당 기간의 베스트 공유 찾기
    const bestShare = window.sharedPhotos.find(photo => 
        photo.type === 'best' && 
        photo.periodType === periodType && 
        photo.periodText === periodText
    );
    
    return bestShare || null;
}

// 베스트 공유 모달 열기
export async function openShareBestModal() {
    const modal = document.getElementById('bestShareModal');
    const preview = document.getElementById('bestSharePreview');
    if (!modal || !preview) return;
    
    const state = appState;
    let meals = [];
    let periodType = ''; // '주간' or '월간'
    let periodText = '';
    
    // 현재 기간의 베스트 메뉴 가져오기
    if (state.dashboardMode === 'week') {
        meals = getWeekBestMeals(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodType = '주간';
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodText = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주`;
    } else if (state.dashboardMode === 'month') {
        const [y, m] = state.selectedMonth.split('-').map(Number);
        meals = getMonthBestMeals(y, m);
        periodType = '월간';
        periodText = `${y}년 ${m}월`;
    } else {
        showToast('주간 또는 월간 모드에서만 공유할 수 있습니다.', 'error');
        return;
    }
    
    // 공유 상태 확인
    const existingShare = await checkBestShareStatus(periodType, periodText);
    const isShared = !!existingShare;
    
    // 1~3위만 필터링
    const top3Meals = meals.filter(m => m && m.rating).slice(0, 3);
    
    if (top3Meals.length === 0 && !isShared) {
        showToast('공유할 베스트 메뉴가 없습니다.', 'error');
        return;
    }
    
    // 사용자 닉네임 가져오기
    const userNickname = window.userSettings?.profile?.nickname || '익명';
    
    // 스크린샷용 HTML 생성
    const screenshotHtml = `
        <div id="bestScreenshotContainer" style="background: white; padding: 24px; max-width: 400px; margin: 0 auto;">
            <div style="text-align: center; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #10b981;">
                <h2 style="font-size: 20px; font-weight: 800; color: #1e293b; margin: 0; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <span style="font-size: 22px;">🏆</span>
                    <span>
                        ${userNickname}의 ${periodType} Best
                        ${periodText ? `<span style="font-size: 12px; color: #64748b; font-weight: 700; margin-left: 6px;">${periodText}</span>` : ''}
                    </span>
                </h2>
            </div>
            ${top3Meals.map((meal, index) => {
                const slot = SLOTS.find(s => s.id === meal.slotId);
                const slotLabel = slot ? slot.label : '알 수 없음';
                const isSnack = slot && slot.type === 'snack';
                const displayTitle = isSnack ? (meal.menuDetail || meal.snackType || '간식') : (meal.menuDetail || meal.mealType || '식사');
                const photoUrl = meal.photos && Array.isArray(meal.photos) && meal.photos.length > 0 ? meal.photos[0] : null;
                const date = meal.date ? new Date(meal.date + 'T00:00:00') : new Date();
                const dateStr = `${date.getMonth() + 1}.${date.getDate()}(${getDayName(date)})`;
                const rating = meal.rating ? parseInt(meal.rating) : 0;
                const place = meal.place || '';
                const menuDetail = meal.menuDetail || '';
                const title = (place && menuDetail) ? `${place} | ${menuDetail}` : (place || menuDetail || displayTitle);
                
                // 순위 색상
                let rankBg = '#10b981';
                let rankText = '#ffffff';
                if (index === 0) {
                    rankBg = '#eab308'; // 금색
                } else if (index === 1) {
                    rankBg = '#9ca3af'; // 은색
                } else if (index === 2) {
                    rankBg = '#d97706'; // 동색
                }
                
                return `
                    <div style="display: flex; margin-bottom: 16px; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background: white;">
                        <div style="width: 120px; height: 120px; background: #f1f5f9; display: flex; align-items: center; justify-content: center; position: relative; flex-shrink: 0;">
                            ${photoUrl ? `<img src="${photoUrl}" style="width: 100%; height: 100%; object-fit: cover;">` : `<div style="font-size: 24px;">🍽️</div>`}
                            <div style="position: absolute; top: 8px; left: 8px; width: 24px; height: 24px; border-radius: 50%; background: ${rankBg}; color: ${rankText}; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; line-height: 1;">
                                ${index + 1}
                            </div>
                        </div>
                        <div style="flex: 1; padding: 12px; display: flex; flex-direction: column; justify-content: center;">
                            <div style="font-size: 10px; color: #64748b; margin-bottom: 4px;">${slotLabel} · ${dateStr}</div>
                            <div style="font-size: 14px; font-weight: 700; color: #1e293b; margin-bottom: 4px;">${title}</div>
                            <div style="font-size: 12px; color: #fbbf24; display: flex; align-items: center; gap: 4px;">
                                <span style="font-size: 13px; color: #d97706; font-weight: 900; background: #fef3c7; padding: 4px 8px; border-radius: 6px; display: inline-flex; align-items: center; gap: 3px;">⭐ <span style="font-weight: 900;">${rating}</span></span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
    
    // 미리보기 영역에 HTML 표시
    preview.innerHTML = screenshotHtml;
    
    // 모달 열기
    modal.classList.remove('hidden');
    
    // Comment 초기화 또는 기존 코멘트 표시
    const commentInput = document.getElementById('bestShareComment');
    if (commentInput) {
        if (isShared && existingShare.comment) {
            commentInput.value = existingShare.comment;
        } else {
            commentInput.value = '';
        }
    }
    
    // 공유 버튼 텍스트 업데이트
    const submitBtn = document.getElementById('bestShareSubmitBtn');
    if (submitBtn) {
        if (isShared) {
            submitBtn.textContent = '공유 취소';
            submitBtn.className = 'w-full py-4 bg-red-600 text-white rounded-xl font-bold active:bg-red-700 shadow-lg transition-all';
        } else {
            submitBtn.textContent = '공유하기';
            submitBtn.className = 'w-full py-4 bg-emerald-600 text-white rounded-xl font-bold active:bg-emerald-700 shadow-lg transition-all';
        }
    }
}

// 베스트 공유 모달 닫기
export function closeShareBestModal() {
    const modal = document.getElementById('bestShareModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 베스트를 피드에 공유하기 (토글 방식)
export async function shareBestToFeed() {
    const preview = document.getElementById('bestScreenshotContainer');
    const commentInput = document.getElementById('bestShareComment');
    const submitBtn = document.getElementById('bestShareSubmitBtn');
    
    if (!preview || !commentInput) return;
    
    const comment = commentInput.value.trim();
    
    // 베스트 공유 데이터 생성
    const state = appState;
    let periodType = '';
    let periodText = '';
    
    if (state.dashboardMode === 'week') {
        periodType = '주간';
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodText = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주`;
    } else if (state.dashboardMode === 'month') {
        periodType = '월간';
        const [y, m] = state.selectedMonth.split('-').map(Number);
        periodText = `${y}년 ${m}월`;
    }
    
    // 공유 상태 확인
    const existingShare = await checkBestShareStatus(periodType, periodText);
    
    if (existingShare) {
        // 이미 공유된 경우: 공유 취소
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '취소 중...';
        }
        
        try {
            await dbOps.unsharePhotos([existingShare.photoUrl], null, true);
            showToast('공유가 취소되었습니다.', 'success');
            closeShareBestModal();
            
            // 베스트 목록 새로고침
            renderBestMeals();
            
            // 갤러리 새로고침
            if (appState.currentTab === 'gallery') {
                renderGallery();
            }
        } catch (e) {
            console.error('베스트 공유 취소 실패:', e);
            showToast('공유 취소 중 오류가 발생했습니다.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '공유하기';
            }
        }
        return;
    }
    
    // 공유되지 않은 경우: 공유하기
    // 로딩 상태
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '공유 중...';
    }
    
    try {
        // html2canvas가 전역에 있는지 확인 (window.html2canvas 또는 전역 html2canvas)
        const html2canvasFunc = (typeof window !== 'undefined' && window.html2canvas) || (typeof html2canvas !== 'undefined' ? html2canvas : null);
        
        if (!html2canvasFunc) {
            throw new Error('html2canvas를 찾을 수 없습니다. HTML에 html2canvas 라이브러리가 로드되었는지 확인하세요.');
        }
        
        // 스크린샷 생성
        const canvas = await html2canvasFunc(preview, {
            backgroundColor: '#ffffff',
            scale: 2,
            logging: false,
            useCORS: true
        });
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
        
        // Firebase Storage에 업로드 (또는 base64로 저장)
        // 여기서는 간단하게 base64로 저장하겠습니다
        const base64Image = canvas.toDataURL('image/png');
        
        const userProfile = window.userSettings?.profile || {};
        const bestShareData = {
            photoUrl: base64Image,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            type: 'best',
            periodType: periodType,
            periodText: periodText,
            comment: comment,
            timestamp: new Date().toISOString(),
            entryId: null // 베스트 공유는 entryId가 없음
        };
        
        // Firestore에 저장
        const { collection, addDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const { db: firestoreDb, appId } = await import('../firebase.js');
        const sharedColl = collection(firestoreDb, 'artifacts', appId, 'sharedPhotos');
        await addDoc(sharedColl, bestShareData);
        
        showToast('베스트가 피드에 공유되었습니다!', 'success');
        closeShareBestModal();
        
        // 베스트 목록 새로고침
        renderBestMeals();
        
        // 갤러리 새로고침
        if (appState.currentTab === 'gallery') {
            renderGallery();
        }
        
    } catch (e) {
        console.error('베스트 공유 실패:', e);
        showToast('베스트 공유 중 오류가 발생했습니다.', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '공유하기';
        }
    }
}
