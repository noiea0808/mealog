// 대시보드 메인 로직
import { SLOTS } from '../constants.js';
import { appState } from '../state.js';
import { loadMealsForDateRange } from '../db.js';
import { renderProportionChart } from './charts.js';
import { updateInsightComment, setupInsightBubbleClick, getCurrentCharacter, getInsightCharacters } from './insight.js';
import { getWeekRange, getCurrentWeekInMonth, getWeeksInMonth, formatDateWithDay } from './date-utils.js';
import { renderBestMeals } from './best-share.js';
import { toLocalDateString } from '../utils.js';

export function getDashboardData() {
    const state = appState;
    const today = new Date();
    let startDate = new Date();
    let endDate = new Date();
    let label = "";
    
    if (state.dashboardMode === '7d') {
        const start = state.recentWeekStartDate || (() => {
            const d = new Date(today);
            d.setDate(d.getDate() - 6);
            return d;
        })();
        startDate = new Date(start);
        endDate = new Date(today);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        
        const startStr = formatDateWithDay(startDate);
        const endStr = formatDateWithDay(endDate);
        label = `${startStr} ~ ${endStr}`;
    } else if (state.dashboardMode === 'month') {
        const [y, m] = state.selectedMonth.split('-').map(Number);
        startDate = new Date(y, m - 1, 1);
        endDate = new Date(y, m, 0);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${y}년 ${m}월`;
    } else if (state.dashboardMode === 'week') {
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        startDate = new Date(start);
        endDate = new Date(end);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주`;
    } else if (state.dashboardMode === 'year') {
        const year = state.selectedYearForYear || today.getFullYear();
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${year}년`;
    } else if (state.dashboardMode === 'custom') {
        startDate = new Date(state.customStartDate);
        endDate = new Date(state.customEndDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${startDate.toLocaleDateString('ko-KR')} ~ ${endDate.toLocaleDateString('ko-KR')}`;
    }
    
    const startStr = toLocalDateString(startDate);
    const endStr = toLocalDateString(endDate);
    const filteredData = window.mealHistory.filter(m => m.date >= startStr && m.date <= endStr);
    const daysDiff = Math.max(1, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1);
    
    return { filteredData, dateRangeText: label, days: daysDiff };
}

export async function updateDashboard() {
    const state = appState;
    if (!window.currentUser) return;
    
    // 연간/과거 월간 모드일 때만 추가 데이터 로드
    try {
        if (state.dashboardMode === 'year') {
            const year = state.selectedYearForYear || new Date().getFullYear();
            const yearStart = `${year}-01-01`;
            const yearEnd = `${year}-12-31`;
            await loadMealsForDateRange(yearStart, yearEnd);
        } else if (state.dashboardMode === 'month') {
            const [y, m] = state.selectedMonth.split('-').map(Number);
            const selectedDate = new Date(y, m - 1, 1);
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            oneMonthAgo.setDate(1);
            
            // 선택한 월이 1개월 이전이면 추가 로드
            if (selectedDate < oneMonthAgo) {
                const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
                const monthEnd = new Date(y, m, 0).toISOString().split('T')[0];
                await loadMealsForDateRange(monthStart, monthEnd);
            }
        } else if (state.dashboardMode === 'custom') {
            const startStr = toLocalDateString(state.customStartDate);
            const endStr = toLocalDateString(state.customEndDate);
            await loadMealsForDateRange(startStr, endStr);
        } else if (state.dashboardMode === 'week') {
            // 주간 모드: 선택한 주의 데이터 확인
            const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
            const startStr = toLocalDateString(start);
            const endStr = toLocalDateString(end);
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            
            if (start < oneMonthAgo) {
                await loadMealsForDateRange(startStr, endStr);
            }
        }
    } catch (e) {
        console.error("대시보드 데이터 로드 실패:", e);
        // 에러가 발생해도 기존 데이터로 계속 진행
    }
    
    // 분석 타입 UI 업데이트
    updateAnalysisTypeUI();
    
    const { filteredData, dateRangeText, days } = getDashboardData();
    
    const periodNavigator = document.getElementById('periodNavigator');
    const periodDisplay = document.getElementById('periodDisplay');
    
    // 최근1주 모드일 때도 다른 기간처럼 날짜 표시 (화살표 버튼은 숨김)
    if (state.dashboardMode === '7d') {
        const startDate = state.recentWeekStartDate || (() => {
            const d = new Date();
            d.setDate(d.getDate() - 6);
            d.setHours(0, 0, 0, 0);
            return d;
        })();
        const endDate = new Date();
        endDate.setHours(23, 59, 59, 999);
        const startStr = formatDateWithDay(startDate);
        const endStr = formatDateWithDay(endDate);
        
        if (periodNavigator) {
            periodNavigator.classList.remove('hidden');
            if (periodDisplay) {
                periodDisplay.innerHTML = `${startStr} ~ ${endStr}`;
            }
            // 화살표 버튼 숨기기
            const periodPrevBtn = document.getElementById('periodPrevBtn');
            const periodNextBtn = document.getElementById('periodNextBtn');
            if (periodPrevBtn) periodPrevBtn.classList.add('hidden');
            if (periodNextBtn) periodNextBtn.classList.add('hidden');
        }
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) {
            customDatePicker.classList.add('hidden');
        }
    } else if (state.dashboardMode === 'custom') {
        // 직접 설정 모드일 때는 날짜 선택 UI 표시
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) {
            customDatePicker.classList.remove('hidden');
            const startInput = document.getElementById('customStart');
            const endInput = document.getElementById('customEnd');
            if (startInput && endInput) {
                const startDate = state.customStartDate || new Date();
                const endDate = state.customEndDate || new Date();
                startInput.value = startDate.toISOString().split('T')[0];
                endInput.value = endDate.toISOString().split('T')[0];
            }
        }
        if (periodNavigator) {
            periodNavigator.classList.add('hidden');
        }
    } else {
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) {
            customDatePicker.classList.add('hidden');
        }
        if (periodNavigator) {
            if (state.dashboardMode === 'week' || state.dashboardMode === 'month' || state.dashboardMode === 'year') {
                periodNavigator.classList.remove('hidden');
                // 화살표 버튼 표시 (다른 모드에서는 사용)
                const periodPrevBtn = document.getElementById('periodPrevBtn');
                const periodNextBtn = document.getElementById('periodNextBtn');
                if (periodPrevBtn) periodPrevBtn.classList.remove('hidden');
                if (periodNextBtn) periodNextBtn.classList.remove('hidden');
                if (periodDisplay) {
                    if (state.dashboardMode === 'week') {
                        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
                        const startStr = formatDateWithDay(start);
                        const endStr = formatDateWithDay(end);
                        periodDisplay.innerHTML = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주 <span class="text-xs opacity-75">(${startStr}~${endStr})</span>`;
                    } else if (state.dashboardMode === 'month') {
                        const [y, m] = state.selectedMonth.split('-');
                        periodDisplay.innerText = `${y}년 ${parseInt(m)}월`;
                    } else if (state.dashboardMode === 'year') {
                        const year = state.selectedYearForYear || new Date().getFullYear();
                        periodDisplay.innerText = `${year}년`;
                    }
                }
            } else {
                periodNavigator.classList.add('hidden');
            }
        }
    }
    
    // 버튼 스타일 업데이트
    ['7d', 'week', 'month', 'year', 'custom'].forEach(mode => {
        const btn = document.getElementById(`btn-dash-${mode}`);
        if (btn) {
            if (state.dashboardMode === mode) {
                btn.className = "flex-1 py-1 text-xs font-bold bg-emerald-600 text-white rounded-lg transition-colors";
            } else {
                btn.className = "flex-1 py-1 text-xs font-bold text-emerald-100 transition-colors";
            }
        }
    });
    
    // 식사/간식 데이터 분리
    const mainMealsOnly = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId);
        return slot && slot.type === 'main';
    });
    
    const snacksOnly = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId);
        return slot && slot.type === 'snack';
    });
    
    // 식사 분석 차트
    renderProportionChart('propChartContainer', mainMealsOnly, 'mealType');
    renderProportionChart('categoryChartContainer', filteredData.filter(m => m.category), 'category');
    renderProportionChart('mateChartContainer', filteredData.filter(m => m.withWhom), 'withWhom');
    renderProportionChart('ratingChartContainer', mainMealsOnly.filter(m => m.rating), 'rating');
    renderProportionChart('satietyChartContainer', filteredData.filter(m => m.satiety), 'satiety');
    
    // 간식 분석 차트
    renderProportionChart('snackTypeChartContainer', snacksOnly.filter(m => m.snackType), 'snackType');
    renderProportionChart('snackRatingChartContainer', snacksOnly.filter(m => m.rating), 'rating');
    
    let targetDays = days;
    if (state.dashboardMode === 'month') {
        const today = new Date();
        const [selY, selM] = state.selectedMonth.split('-').map(Number);
        if (today.getFullYear() === selY && (today.getMonth() + 1) === selM) {
            targetDays = today.getDate();
        } else if (new Date(selY, selM - 1, 1) > today) {
            targetDays = 0;
        }
    } else if (state.dashboardMode === 'week') {
        targetDays = 7;
    }
    
    // 식사 기록 통계 계산
    const totalRec = Math.max(0, targetDays * 3);
    const recCount = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
        return slot && m.mealType !== 'Skip';
    }).length;
    const mealPercent = totalRec > 0 ? Math.round((recCount / totalRec) * 100) : 0;
    
    // 간식 기록 통계 계산
    const snackCount = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'snack');
        return slot && m.snackType;
    }).length;
    
    // 식사 기록 표시
    const mealRecordCountEl = document.getElementById('mealRecordCount');
    const mealRecordPercentEl = document.getElementById('mealRecordPercent');
    const mealRecordTotalEl = document.getElementById('mealRecordTotal');
    if (mealRecordCountEl) mealRecordCountEl.textContent = recCount;
    if (mealRecordPercentEl) mealRecordPercentEl.textContent = `(${mealPercent}%)`;
    if (mealRecordTotalEl) mealRecordTotalEl.textContent = `/${totalRec}`;
    
    // 간식 기록 표시
    const snackRecordCountEl = document.getElementById('snackRecordCount');
    if (snackRecordCountEl) snackRecordCountEl.textContent = snackCount;
    
    // 인사이트 코멘트는 처음 로드 시 기본 코멘트를 표시하고, 이후에는 COMMENT 버튼을 눌렀을 때만 업데이트됨
    // 처음 로드 시에만 기본 코멘트 표시 (이미 코멘트가 있으면 표시하지 않음)
    const insightTextContent = document.getElementById('insightTextContent');
    if (insightTextContent && (!insightTextContent.textContent || insightTextContent.textContent.trim() === '')) {
        if (window.getDashboardData) {
            const { filteredData, dateRangeText } = window.getDashboardData();
            updateInsightComment(filteredData, dateRangeText);
        }
    }
    
    // 말풍선 클릭 이벤트 설정
    setupInsightBubbleClick();
    
    // 초기 캐릭터 아이콘 설정
    const characterIconEl = document.getElementById('insightCharacterIcon');
    if (characterIconEl) {
        const currentCharacter = getCurrentCharacter();
        (async () => {
            const characters = await getInsightCharacters();
            const character = characters.find(c => c.id === currentCharacter);
            if (character) {
                if (character.image) {
                    // 이미지가 있으면 이미지 표시
                    characterIconEl.innerHTML = `<img src="${character.image}" alt="${character.name}" class="w-full h-full object-contain">`;
                    characterIconEl.className = 'w-full h-full flex items-center justify-center';
                } else if (character.id === 'mealog') {
                    // MEALOG는 텍스트 아이콘
                    characterIconEl.textContent = 'M';
                    characterIconEl.className = 'text-2xl font-black text-white';
                } else {
                    // 기본 이모지 아이콘
                    characterIconEl.textContent = character.icon;
                    characterIconEl.className = 'text-3xl';
                }
            }
        })();
    }
}

function updateAnalysisTypeUI() {
    const state = appState;
    const bestBtn = document.getElementById('btn-analysis-best');
    const mainBtn = document.getElementById('btn-analysis-main');
    const snackBtn = document.getElementById('btn-analysis-snack');
    const bestSection = document.getElementById('bestAnalysisSection');
    const mainSection = document.getElementById('mainAnalysisSection');
    const snackSection = document.getElementById('snackAnalysisSection');
    
    const activeBtnClass = "flex-1 py-2.5 text-sm font-semibold transition-all relative text-emerald-600 border-b-2 border-emerald-600";
    const inactiveBtnClass = "flex-1 py-2.5 text-sm font-semibold transition-all relative text-slate-400 hover:text-slate-600 border-b-2 border-transparent";
    
    if (bestBtn && mainBtn && snackBtn) {
        bestBtn.className = state.analysisType === 'best' ? activeBtnClass : inactiveBtnClass;
        mainBtn.className = state.analysisType === 'main' ? activeBtnClass : inactiveBtnClass;
        snackBtn.className = state.analysisType === 'snack' ? activeBtnClass : inactiveBtnClass;
    }
    
    if (bestSection && mainSection && snackSection) {
        bestSection.classList.toggle('hidden', state.analysisType !== 'best');
        mainSection.classList.toggle('hidden', state.analysisType !== 'main');
        snackSection.classList.toggle('hidden', state.analysisType !== 'snack');
    }
    
    if (state.analysisType === 'best') {
        renderBestMeals();
    }
}

export function setDashboardMode(m) {
    appState.dashboardMode = m;
    
    if (m === 'week') {
        const today = new Date();
        appState.selectedYear = today.getFullYear();
        appState.selectedMonthForWeek = today.getMonth() + 1;
        appState.selectedWeek = getCurrentWeekInMonth(today.getFullYear(), today.getMonth() + 1);
    } else if (m === 'month') {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        appState.selectedMonth = `${year}-${month}`;
    } else if (m === 'year') {
        const today = new Date();
        appState.selectedYearForYear = today.getFullYear();
    } else if (m === '7d') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        appState.recentWeekStartDate = new Date(today);
        appState.recentWeekStartDate.setDate(today.getDate() - 6);
    }
    
    updateDashboard();
}

export function setAnalysisType(type) {
    appState.analysisType = type;
    updateAnalysisTypeUI();
    updateDashboard();
}

export function updateCustomDates() {
    const startInput = document.getElementById('customStart');
    const endInput = document.getElementById('customEnd');
    if (startInput && endInput) {
        appState.customStartDate = new Date(startInput.value);
        appState.customEndDate = new Date(endInput.value);
        updateDashboard();
    }
}

export function updateSelectedMonth() {
    const monthInput = document.getElementById('monthInput');
    if (monthInput) {
        appState.selectedMonth = monthInput.value;
        updateDashboard();
    }
}

export function updateSelectedWeek() {
    const weekSelect = document.getElementById('weekSelect');
    if (weekSelect) {
        appState.selectedWeek = parseInt(weekSelect.value);
        updateDashboard();
    }
}

export function changeWeek(direction) {
    const state = appState;
    if (state.dashboardMode !== 'week') return;
    
    const totalWeeks = getWeeksInMonth(state.selectedYear, state.selectedMonthForWeek);
    let newWeek = state.selectedWeek + direction;
    
    if (newWeek < 1) {
        const prevMonth = state.selectedMonthForWeek - 1;
        const prevYear = prevMonth < 1 ? state.selectedYear - 1 : state.selectedYear;
        const prevMonthActual = prevMonth < 1 ? 12 : prevMonth;
        const prevTotalWeeks = getWeeksInMonth(prevYear, prevMonthActual);
        
        state.selectedYear = prevYear;
        state.selectedMonthForWeek = prevMonthActual;
        state.selectedWeek = prevTotalWeeks;
    } else if (newWeek > totalWeeks) {
        const nextMonth = state.selectedMonthForWeek + 1;
        const nextYear = nextMonth > 12 ? state.selectedYear + 1 : state.selectedYear;
        const nextMonthActual = nextMonth > 12 ? 1 : nextMonth;
        
        state.selectedYear = nextYear;
        state.selectedMonthForWeek = nextMonthActual;
        state.selectedWeek = 1;
    } else {
        state.selectedWeek = newWeek;
    }
    
    updateDashboard();
}

export function changeMonth(direction) {
    const state = appState;
    if (state.dashboardMode !== 'month') return;
    
    const [y, m] = state.selectedMonth.split('-').map(Number);
    let newMonth = m + direction;
    let newYear = y;
    
    if (newMonth < 1) {
        newMonth = 12;
        newYear--;
    } else if (newMonth > 12) {
        newMonth = 1;
        newYear++;
    }
    
    state.selectedMonth = `${newYear}-${String(newMonth).padStart(2, '0')}`;
    updateDashboard();
}

export function changeYear(direction) {
    const state = appState;
    if (state.dashboardMode !== 'year') return;
    
    state.selectedYearForYear = (state.selectedYearForYear || new Date().getFullYear()) + direction;
    updateDashboard();
}

export function changeRecentWeek(direction) {
    const state = appState;
    if (state.dashboardMode !== '7d') return;
    
    if (!state.recentWeekStartDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        state.recentWeekStartDate = new Date(today);
        state.recentWeekStartDate.setDate(today.getDate() - 6);
    }
    
    state.recentWeekStartDate.setDate(state.recentWeekStartDate.getDate() + (direction * 7));
    updateDashboard();
}

export function navigatePeriod(direction) {
    const state = appState;
    if (state.dashboardMode === 'week') {
        changeWeek(direction);
    } else if (state.dashboardMode === 'month') {
        changeMonth(direction);
    } else if (state.dashboardMode === 'year') {
        changeYear(direction);
    } else if (state.dashboardMode === '7d') {
        changeRecentWeek(direction);
    }
}
