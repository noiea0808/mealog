// 통계 및 차트 관련 함수들
import { SLOTS, VIBRANT_COLORS, RATING_GRADIENT, SATIETY_DATA } from './constants.js';
import { appState } from './state.js';
import { generateColorMap } from './utils.js';

export function renderProportionChart(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const counts = {};
    data.forEach(m => {
        let val = m[key] || '미지정';
        counts[val] = (counts[val] || 0) + 1;
    });
    
    const total = data.length;
    if (total === 0) {
        container.innerHTML = '<div class="text-center py-4 text-slate-400 text-xs">데이터가 없습니다.</div>';
        return;
    }
    
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    
    const colorMap = generateColorMap(data, key, VIBRANT_COLORS);
    
    // 차트와 라벨을 감싸는 컨테이너
    let html = '<div class="relative">';
    html += '<div class="flex items-stretch h-6 rounded-full overflow-hidden border border-slate-200">';
    
    let cumulativePercent = 0;
    const segments = [];
    
    sorted.forEach(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        let bg = colorMap[name] || '#94a3b8';
        let textColor = '#ffffff';
        
        if (key === 'rating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
            }
        }
        
        if (key === 'satiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
        }
        
        if (pct < 5 || (key === 'rating' && parseInt(name) <= 2)) textColor = '#475569';
        if (pct > 5) {
            html += `<div class="prop-segment" style="width: ${pct}%; background: ${bg}; color: ${textColor}">${pct}%</div>`;
            segments.push({
                name,
                count,
                startPercent: cumulativePercent,
                widthPercent: pct
            });
            cumulativePercent += pct;
        }
    });
    
    html += '</div>';
    
    // 차트 아래 라벨 추가 (각 세그먼트 중간에 배치, 겹침 처리)
    html += '<div class="relative h-5 mt-1">';
    let lastLabelEnd = -1;
    segments.forEach(({ name, count, startPercent, widthPercent }) => {
        // 라벨 표시 텍스트 생성
        let displayName = name;
        if (key === 'rating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                displayName = `${ratingNum}점`;
            }
        } else if (key === 'satiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    displayName = satietyData.label;
                }
            }
        }
        
        // 세그먼트 중간 위치 계산
        const centerPercent = startPercent + widthPercent / 2;
        
        // 겹침 체크: 최소 8% 간격 유지
        if (centerPercent - lastLabelEnd >= 8 || lastLabelEnd < 0) {
            html += `<div class="absolute text-xs whitespace-nowrap" style="left: ${centerPercent}%; transform: translateX(-50%);">
                <span class="text-slate-600">${displayName}</span>
                <span class="text-slate-400">(${count})</span>
            </div>`;
            // 라벨의 예상 너비를 고려하여 lastLabelEnd 업데이트 (대략 10%로 간주)
            lastLabelEnd = centerPercent + 5;
        }
    });
    html += '</div>';
    html += '</div>';
    
    container.innerHTML = html;
}

// 주 범위 계산 (일요일 시작 ~ 토요일 끝)
export function getWeekRange(year, month, week) {
    const firstDay = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDay.getDay(); // 0 = 일요일
    
    // 해당 달의 첫 번째 일요일 찾기
    let firstSunday = new Date(firstDay);
    if (firstDayOfWeek !== 0) {
        firstSunday.setDate(1 - firstDayOfWeek);
    }
    
    // week번째 주의 시작일 (일요일)
    const weekStart = new Date(firstSunday);
    weekStart.setDate(firstSunday.getDate() + (week - 1) * 7);
    
    // week번째 주의 종료일 (토요일)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    
    return { start: weekStart, end: weekEnd };
}

// 한 달의 총 주 수 계산
export function getWeeksInMonth(year, month) {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const firstDayOfWeek = firstDay.getDay();
    const lastDayOfWeek = lastDay.getDay();
    
    const daysInMonth = lastDay.getDate();
    const daysFromFirstSunday = (7 - firstDayOfWeek) % 7;
    const fullWeeks = Math.floor((daysInMonth - daysFromFirstSunday) / 7);
    const remainingDays = (daysInMonth - daysFromFirstSunday) % 7;
    
    let totalWeeks = fullWeeks;
    if (daysFromFirstSunday > 0) totalWeeks++;
    if (remainingDays > 0 || (remainingDays === 0 && lastDayOfWeek === 6)) totalWeeks++;
    
    return totalWeeks;
}

// 현재 날짜가 해당 달의 몇 번째 주인지 계산
export function getCurrentWeekInMonth(year, month) {
    const today = new Date();
    if (today.getFullYear() !== year || today.getMonth() + 1 !== month) {
        return 1;
    }
    
    const firstDay = new Date(year, month - 1, 1);
    const firstDayOfWeek = firstDay.getDay();
    
    const firstSunday = new Date(firstDay);
    if (firstDayOfWeek !== 0) {
        firstSunday.setDate(1 - firstDayOfWeek);
    }
    
    const todayDate = today.getDate();
    const daysFromFirstSunday = Math.floor((todayDate + firstDayOfWeek - 1) / 7) * 7;
    const week = Math.floor(daysFromFirstSunday / 7) + 1;
    
    return week;
}

// 요일 이름 가져오기
function getDayName(date) {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return days[date.getDay()];
}

// 날짜 형식 변환 (월.일(요일))
function formatDateWithDay(date) {
    return `${date.getMonth() + 1}.${date.getDate()}(${getDayName(date)})`;
}

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
        label = `${y}년 ${m}월`;
    } else if (state.dashboardMode === 'week') {
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        startDate = start;
        endDate = end;
        label = `${state.selectedYear}년 ${state.selectedMonthForWeek}월 ${state.selectedWeek}주`;
    } else if (state.dashboardMode === 'year') {
        const year = state.selectedYearForYear || today.getFullYear();
        startDate = new Date(year, 0, 1);
        endDate = new Date(year, 11, 31);
        label = `${year}년`;
    } else if (state.dashboardMode === 'custom') {
        startDate = new Date(state.customStartDate);
        endDate = new Date(state.customEndDate);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${startDate.toLocaleDateString('ko-KR')} ~ ${endDate.toLocaleDateString('ko-KR')}`;
    }
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const filteredData = window.mealHistory.filter(m => m.date >= startStr && m.date <= endStr);
    const daysDiff = Math.max(1, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1);
    
    return { filteredData, dateRangeText: label, days: daysDiff };
}

async function getGeminiComment(filteredData) {
    if (filteredData.length === 0) return "오늘도 맛있는 기록 되세요!";
    return "멋진 식사 기록이 쌓이고 있어요! ✨";
}

export async function updateDashboard() {
    const state = appState;
    if (!window.currentUser) return;
    
    // 분석 타입 UI 업데이트
    updateAnalysisTypeUI();
    
    const { filteredData, dateRangeText, days } = getDashboardData();
    
    const periodNavigator = document.getElementById('periodNavigator');
    const periodDisplay = document.getElementById('periodDisplay');
    
    if (periodNavigator) {
        if (state.dashboardMode === 'week' || state.dashboardMode === 'month' || state.dashboardMode === 'year' || state.dashboardMode === '7d') {
            periodNavigator.classList.remove('hidden');
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
                } else if (state.dashboardMode === '7d') {
                    periodDisplay.innerText = dateRangeText;
                }
            }
        } else {
            periodNavigator.classList.add('hidden');
        }
    }
    
    // 버튼 스타일 업데이트
    ['7d', 'week', 'month', 'year', 'custom'].forEach(mode => {
        const btn = document.getElementById(`btn-dash-${mode}`);
        if (btn) {
            if (state.dashboardMode === mode) {
                btn.className = "flex-1 py-1 text-[10px] font-bold bg-emerald-600 text-white rounded-lg transition-colors";
            } else {
                btn.className = "flex-1 py-1 text-[10px] font-bold text-emerald-100 transition-colors";
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
        return slot && m.mealType !== '???';
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
    
    // 인사이트 코멘트
    const insightTextEl = document.getElementById('insightText');
    if (insightTextEl) {
        const comment = await getGeminiComment(filteredData);
        insightTextEl.innerText = comment || "멋진 식사 기록이 쌓이고 있어요! ✨";
    }
}

export function openDetailModal(key, title) {
    document.getElementById('detailModalTitle').innerText = title;
    const container = document.getElementById('detailContent');
    
    const { filteredData } = getDashboardData();
    
    let slots, slotLabels;
    if (key === 'snackType') {
        slots = ['pre_morning', 'snack1', 'snack2', 'night'];
        slotLabels = ['아침 전', '오전', '오후', '야식'];
    } else {
        slots = ['morning', 'lunch', 'dinner'];
        slotLabels = ['아침', '점심', '저녁'];
    }
    
    const getValue = (m) => {
        if (key === 'satiety') {
            const satietyNum = parseInt(m.satiety);
            if (!isNaN(satietyNum)) {
                return SATIETY_DATA.find(d => d.val === satietyNum)?.label || '미지정';
            }
            return '미지정';
        }
        if (key === 'rating') {
            const ratingNum = parseInt(m.rating);
            if (!isNaN(ratingNum)) {
                return `${ratingNum}점`;
            }
            return '미지정';
        }
        return m[key] || '미지정';
    };
    
    const colorMap = generateColorMap(filteredData.filter(m => slots.includes(m.slotId)), key, VIBRANT_COLORS);
    
    let html = '<div class="space-y-4">';
    
    // 각 슬롯별로 별도 차트 생성
    slots.forEach((slotId, slotIndex) => {
        const slotLabel = slotLabels[slotIndex];
        const slotData = filteredData.filter(m => m.slotId === slotId);
        
        if (slotData.length === 0) {
            html += `<div class="mb-4">
                <h3 class="text-sm font-bold text-slate-700 mb-2">${slotLabel}</h3>
                <div class="text-center py-4 text-slate-400 text-xs">데이터가 없습니다.</div>
            </div>`;
            return;
        }
        
        // 해당 슬롯의 값별 카운트
        const counts = {};
        slotData.forEach(m => {
            const val = getValue(m);
            counts[val] = (counts[val] || 0) + 1;
        });
        
        const total = slotData.length;
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        
        // 만족도나 포만감의 경우 정렬
        if (key === 'rating') {
            sorted.sort((a, b) => {
                const aNum = parseInt(a[0].replace('점', ''));
                const bNum = parseInt(b[0].replace('점', ''));
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum;
                }
                return 0;
            });
        } else if (key === 'satiety') {
            sorted.sort((a, b) => {
                const aData = SATIETY_DATA.find(d => d.label === a[0]);
                const bData = SATIETY_DATA.find(d => d.label === b[0]);
                if (aData && bData) {
                    return aData.val - bData.val;
                }
                return 0;
            });
        }
        
        html += `<div class="mb-4">
            <h3 class="text-sm font-bold text-slate-700 mb-2">${slotLabel}</h3>
            <div class="relative">
                <div class="flex items-stretch h-8 rounded-full overflow-hidden border border-slate-200">`;
        
        let cumulativePercent = 0;
        const segments = [];
        
        sorted.forEach(([name, count]) => {
            const pct = Math.round((count / total) * 100);
            let bg = colorMap[name] || '#94a3b8';
            let textColor = '#ffffff';
            
            if (key === 'rating') {
                const ratingNum = parseInt(name.replace('점', ''));
                if (!isNaN(ratingNum)) {
                    bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
                }
            }
            
            if (key === 'satiety') {
                const satietyData = SATIETY_DATA.find(d => d.label === name);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
            
            if (pct < 5 || (key === 'rating' && parseInt(name) <= 2)) textColor = '#475569';
            if (pct > 0) {
                html += `<div class="prop-segment relative" style="width: ${pct}%; background: ${bg}; color: ${textColor}">
                    ${pct >= 8 ? `<span class="text-[10px] font-bold">${pct}%</span>` : ''}
                </div>`;
                segments.push({
                    name,
                    count,
                    pct,
                    startPercent: cumulativePercent,
                    widthPercent: pct
                });
                cumulativePercent += pct;
            }
        });
        
        html += `</div>
                <div class="relative h-5 mt-1">`;
        
        let lastLabelEnd = -1;
        segments.forEach(({ name, count, startPercent, widthPercent }) => {
            // 세그먼트 중간 위치 계산
            const centerPercent = startPercent + widthPercent / 2;
            
            // 겹침 체크: 최소 8% 간격 유지
            if (centerPercent - lastLabelEnd >= 8 || lastLabelEnd < 0) {
                html += `<div class="absolute text-xs whitespace-nowrap" style="left: ${centerPercent}%; transform: translateX(-50%);">
                    <span class="text-slate-600">${name}</span>
                    <span class="text-slate-400">(${count})</span>
                </div>`;
                // 라벨의 예상 너비를 고려하여 lastLabelEnd 업데이트 (대략 10%로 간주)
                lastLabelEnd = centerPercent + 5;
            }
        });
        
        html += `</div>
            </div>
        </div>`;
    });
    
    html += '</div>';
    container.innerHTML = html;
    
    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
    }
    
    document.getElementById('detailModal').classList.remove('hidden');
}

export function closeDetailModal() {
    document.getElementById('detailModal').classList.add('hidden');
    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
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
        appState.selectedMonth = today.toISOString().slice(0, 7);
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

function updateAnalysisTypeUI() {
    const state = appState;
    const bestBtn = document.getElementById('btn-analysis-best');
    const mainBtn = document.getElementById('btn-analysis-main');
    const snackBtn = document.getElementById('btn-analysis-snack');
    const bestSection = document.getElementById('bestAnalysisSection');
    const mainSection = document.getElementById('mainAnalysisSection');
    const snackSection = document.getElementById('snackAnalysisSection');
    
    const activeBtnClass = "flex-1 py-1.5 text-xs font-bold bg-white text-emerald-700 rounded-lg shadow-sm transition-all";
    const inactiveBtnClass = "flex-1 py-1.5 text-xs font-bold text-emerald-600 hover:bg-emerald-100/50 rounded-lg transition-colors";
    
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

export function updateCustomDates() {
    const startInput = document.getElementById('customStartDate');
    const endInput = document.getElementById('customEndDate');
    if (startInput && endInput) {
        appState.customStartDate = new Date(startInput.value);
        appState.customEndDate = new Date(endInput.value);
        updateDashboard();
    }
}

export function updateSelectedMonth() {
    const monthInput = document.getElementById('monthPicker');
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

// Best 탭 데이터 렌더링 함수
export function renderBestMeals() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;
    
    const { filteredData } = getDashboardData();
    const state = appState;
    
    const highRatingMeals = filteredData.filter(m => {
        return m.rating && parseInt(m.rating) >= 4;
    });
    
    const periodKey = getBestPeriodKey();
    const savedOrder = (window.userSettings?.bestMeals || {})[periodKey] || [];
    
    const sortedMeals = [...highRatingMeals].sort((a, b) => {
        const aIndex = savedOrder.indexOf(a.id);
        const bIndex = savedOrder.indexOf(b.id);
        
        if (aIndex !== -1 && bIndex !== -1) {
            return aIndex - bIndex;
        } else if (aIndex !== -1) {
            return -1;
        } else if (bIndex !== -1) {
            return 1;
        } else {
            if (parseInt(b.rating) !== parseInt(a.rating)) {
                return parseInt(b.rating) - parseInt(a.rating);
            }
            return b.date.localeCompare(a.date);
        }
    });
    
    if (sortedMeals.length === 0) {
        container.innerHTML = '<div class="text-center py-8 text-slate-400 text-sm">만족도 4점 이상인 기록이 없습니다.</div>';
        return;
    }
    
    container.innerHTML = sortedMeals.map((meal, index) => {
        const slot = SLOTS.find(s => s.id === meal.slotId);
        const slotLabel = slot ? slot.label : '알 수 없음';
        const isSnack = slot && slot.type === 'snack';
        const displayTitle = isSnack ? (meal.menuDetail || meal.snackType || '간식') : (meal.menuDetail || meal.mealType || '식사');
        const photoUrl = meal.photos && meal.photos.length > 0 ? meal.photos[0] : null;
        const date = new Date(meal.date + 'T00:00:00');
        const dateStr = `${date.getMonth() + 1}.${date.getDate()}(${getDayName(date)})`;
        
        return `
            <div class="best-meal-item bg-white rounded-lg border border-slate-200 p-2 flex items-center gap-3 cursor-move active:scale-[0.98] transition-all" 
                 data-meal-id="${meal.id}" 
                 draggable="true">
                <div class="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-bold">
                    ${index + 1}
                </div>
                ${photoUrl ? `
                    <div class="flex-shrink-0 w-[140px] h-[140px] rounded-lg overflow-hidden bg-slate-100">
                        <img src="${photoUrl}" alt="${displayTitle}" class="w-full h-full object-cover">
                    </div>
                ` : `
                    <div class="flex-shrink-0 w-[140px] h-[140px] rounded-lg bg-slate-100 flex items-center justify-center">
                        <i class="fa-solid fa-utensils text-slate-300 text-4xl"></i>
                    </div>
                `}
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-base font-bold text-slate-600">${displayTitle}</span>
                        <span class="text-xs text-slate-400">${slotLabel}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-400">${dateStr}</span>
                        <div class="flex items-center gap-0.5">
                            ${Array.from({ length: parseInt(meal.rating) }).map(() => 
                                '<i class="fa-solid fa-star text-yellow-400 text-xs"></i>'
                            ).join('')}
                        </div>
                    </div>
                </div>
                <div class="flex-shrink-0 text-slate-300">
                    <i class="fa-solid fa-grip-vertical text-sm"></i>
                </div>
            </div>
        `;
    }).join('');
    
    setupDragAndDrop();
}

function getBestPeriodKey() {
    const state = appState;
    if (state.dashboardMode === '7d') {
        const startDate = state.recentWeekStartDate || new Date();
        startDate.setDate(startDate.getDate() - 6);
        return `7d_${startDate.toISOString().split('T')[0]}`;
    } else if (state.dashboardMode === 'week') {
        return `week_${state.selectedYear}_${state.selectedMonthForWeek}_${state.selectedWeek}`;
    } else if (state.dashboardMode === 'month') {
        return `month_${state.selectedMonth}`;
    } else if (state.dashboardMode === 'year') {
        return `year_${state.selectedYearForYear}`;
    } else if (state.dashboardMode === 'custom') {
        return `custom_${state.customStartDate.toISOString().split('T')[0]}_${state.customEndDate.toISOString().split('T')[0]}`;
    }
    return 'default';
}

function setupDragAndDrop() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;
    
    let draggedElement = null;
    
    container.querySelectorAll('.best-meal-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            item.classList.add('opacity-50');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        item.addEventListener('dragend', (e) => {
            item.classList.remove('opacity-50');
            container.querySelectorAll('.best-meal-item').forEach(el => {
                el.classList.remove('border-emerald-400', 'bg-emerald-50');
            });
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            if (!draggedElement) return;
            item.classList.add('border-emerald-400', 'bg-emerald-50');
        });
        
        item.addEventListener('dragleave', (e) => {
            item.classList.remove('border-emerald-400', 'bg-emerald-50');
        });
        
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('border-emerald-400', 'bg-emerald-50');
            
            if (draggedElement && draggedElement !== item) {
                const container = item.parentElement;
                const afterElement = getDragAfterElement(container, e.clientY);
                
                if (afterElement == null) {
                    container.appendChild(draggedElement);
                } else {
                    container.insertBefore(draggedElement, afterElement);
                }
                
                updateBestOrder();
            }
        });
    });
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
    
    const items = container.querySelectorAll('.best-meal-item');
    const order = Array.from(items).map(item => item.getAttribute('data-meal-id'));
    
    const periodKey = getBestPeriodKey();
    
    if (!window.userSettings.bestMeals) {
        window.userSettings.bestMeals = {};
    }
    window.userSettings.bestMeals[periodKey] = order;
    
    items.forEach((item, index) => {
        const numberEl = item.querySelector('.w-8.h-8');
        if (numberEl) {
            numberEl.textContent = index + 1;
        }
    });
    
    try {
        await window.dbOps.saveSettings(window.userSettings);
    } catch (e) {
        console.error('Best 순서 저장 실패:', e);
    }
}
