// 통계 및 차트 관련 함수들
import { SLOTS, VIBRANT_COLORS, RATING_GRADIENT, SATIETY_DATA } from './constants.js';
import { appState } from './state.js';
import { generateColorMap } from './utils.js';
import { loadMealsForDateRange } from './db.js';

export function renderProportionChart(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // 사용자 설정 태그 목록 가져오기
    const userTags = window.userSettings?.tags || {};
    let allowedTags = null;
    
    // 태그 필터링이 필요한 키인지 확인
    if (key === 'mealType' && userTags.mealType) {
        allowedTags = new Set(userTags.mealType);
    } else if (key === 'category' && userTags.category) {
        allowedTags = new Set(userTags.category);
    } else if (key === 'withWhom' && userTags.withWhom) {
        allowedTags = new Set(userTags.withWhom);
    } else if (key === 'snackType' && userTags.snackType) {
        allowedTags = new Set(userTags.snackType);
    }
    // rating과 satiety는 숫자 값이므로 태그 필터링 불필요
    
    const counts = {};
    data.forEach(m => {
        let val = m[key] || '미입력';
        
        // 태그 필터링: 사용자가 설정한 태그만 표시
        if (allowedTags && val !== '미입력') {
            if (!allowedTags.has(val)) {
                // 설정된 태그에 없으면 "미입력"으로 처리
                val = '미입력';
            }
        }
        
        counts[val] = (counts[val] || 0) + 1;
    });
    
    const total = data.length;
    if (total === 0 || Object.keys(counts).length === 0) {
        container.innerHTML = '<div class="text-center py-4 text-slate-400 text-xs">데이터가 없습니다.</div>';
        return;
    }
    
    // 사용자가 설정한 태그 순서대로 정렬 (데이터가 있는 것만, 미입력은 항상 마지막)
    let sorted;
    if (allowedTags) {
        const tagOrder = Array.from(allowedTags);
        const tagEntries = tagOrder
            .filter(tag => counts[tag] > 0)
            .map(tag => [tag, counts[tag]])
            .sort((a, b) => b[1] - a[1]); // 개수 내림차순
        
        // 미입력 항목이 있으면 마지막에 추가
        if (counts['미입력'] > 0) {
            tagEntries.push(['미입력', counts['미입력']]);
        }
        
        sorted = tagEntries;
    } else {
        const entries = Object.entries(counts);
        const nonEmptyEntries = entries.filter(([name]) => name !== '미입력').sort((a, b) => b[1] - a[1]);
        const emptyEntry = entries.find(([name]) => name === '미입력');
        sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
    }
    
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
        
        // 미입력 항목은 연회색으로 표시
        if (name === '미입력') {
            bg = '#e2e8f0'; // 연회색
            textColor = '#64748b'; // 진한 회색 텍스트
        } else if (key === 'rating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
            }
        } else if (key === 'satiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
        }
        
        if (pct < 5 || (key === 'rating' && parseInt(name) <= 2)) textColor = '#475569';
        if (pct > 0) {
            html += `<div class="prop-segment" style="width: ${pct}%; background: ${bg}; color: ${textColor}">${pct >= 5 ? `${pct}%` : ''}</div>`;
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
        let displayName = name === '미입력' ? '미입력' : name;
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
            const startStr = state.customStartDate.toISOString().split('T')[0];
            const endStr = state.customEndDate.toISOString().split('T')[0];
            await loadMealsForDateRange(startStr, endStr);
        } else if (state.dashboardMode === 'week') {
            // 주간 모드: 선택한 주의 데이터 확인
            const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
            const startStr = start.toISOString().split('T')[0];
            const endStr = end.toISOString().split('T')[0];
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
    
    // 사용자 설정 태그 목록 가져오기
    const userTags = window.userSettings?.tags || {};
    let allowedTags = null;
    
    // 태그 필터링이 필요한 키인지 확인
    if (key === 'mealType' && userTags.mealType) {
        allowedTags = new Set(userTags.mealType);
    } else if (key === 'category' && userTags.category) {
        allowedTags = new Set(userTags.category);
    } else if (key === 'withWhom' && userTags.withWhom) {
        allowedTags = new Set(userTags.withWhom);
    } else if (key === 'snackType' && userTags.snackType) {
        allowedTags = new Set(userTags.snackType);
    }
    // rating과 satiety는 숫자 값이므로 태그 필터링 불필요
    
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
                return SATIETY_DATA.find(d => d.val === satietyNum)?.label || '미입력';
            }
            return '미입력';
        }
        if (key === 'rating') {
            const ratingNum = parseInt(m.rating);
            if (!isNaN(ratingNum)) {
                return `${ratingNum}점`;
            }
            return '미입력';
        }
        return m[key] || '미입력';
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
            let val = getValue(m);
            
            // 태그 필터링: 사용자가 설정한 태그만 표시
            if (allowedTags && val !== '미입력') {
                if (!allowedTags.has(val)) {
                    // 설정된 태그에 없으면 "미입력"으로 처리
                    val = '미입력';
                }
            }
            
            counts[val] = (counts[val] || 0) + 1;
        });
        
        const total = slotData.length;
        
        // 사용자가 설정한 태그 순서대로 정렬 (데이터가 있는 것만, 미입력은 항상 마지막)
        let sorted;
        if (allowedTags) {
            const tagOrder = Array.from(allowedTags);
            const tagEntries = tagOrder
                .filter(tag => counts[tag] > 0)
                .map(tag => [tag, counts[tag]])
                .sort((a, b) => b[1] - a[1]); // 개수 내림차순
            
            // 미입력 항목이 있으면 마지막에 추가
            if (counts['미입력'] > 0) {
                tagEntries.push(['미입력', counts['미입력']]);
            }
            
            sorted = tagEntries;
        } else {
            const entries = Object.entries(counts);
            const nonEmptyEntries = entries.filter(([name]) => name !== '미입력').sort((a, b) => b[1] - a[1]);
            const emptyEntry = entries.find(([name]) => name === '미입력');
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
        }
        
        // 만족도나 포만감의 경우 정렬 (미입력은 항상 마지막)
        if (key === 'rating') {
            const emptyEntry = sorted.find(([name]) => name === '미입력');
            const nonEmptyEntries = sorted.filter(([name]) => name !== '미입력').sort((a, b) => {
                const aNum = parseInt(a[0].replace('점', ''));
                const bNum = parseInt(b[0].replace('점', ''));
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum;
                }
                return 0;
            });
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
        } else if (key === 'satiety') {
            const emptyEntry = sorted.find(([name]) => name === '미입력');
            const nonEmptyEntries = sorted.filter(([name]) => name !== '미입력').sort((a, b) => {
                const aData = SATIETY_DATA.find(d => d.label === a[0]);
                const bData = SATIETY_DATA.find(d => d.label === b[0]);
                if (aData && bData) {
                    return aData.val - bData.val;
                }
                return 0;
            });
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
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
            
            // 미입력 항목은 연회색으로 표시
            if (name === '미입력') {
                bg = '#e2e8f0'; // 연회색
                textColor = '#64748b'; // 진한 회색 텍스트
            } else if (key === 'rating') {
                const ratingNum = parseInt(name.replace('점', ''));
                if (!isNaN(ratingNum)) {
                    bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
                }
            } else if (key === 'satiety') {
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
            
            // 라벨 표시 텍스트 생성 (미입력은 그대로 표시)
            const displayName = name === '미입력' ? '미입력' : name;
            
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

// 주간 베스트 가져오기 (만족도 4~5점, 최대 5개)
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
    
    // 만족도 내림차순, 날짜 내림차순으로 정렬하고 최대 5개만
    const sorted = [...highRatingMeals].sort((a, b) => {
        if (parseInt(b.rating) !== parseInt(a.rating)) {
            return parseInt(b.rating) - parseInt(a.rating);
        }
        return b.date.localeCompare(a.date);
    });
    
    return sorted.slice(0, 5);
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
        
        // 1~3위 색상 구분 (현대적이고 눈에 띄는 색상)
        let rankBgClass = 'bg-emerald-100';
        let rankTextClass = 'text-emerald-700';
        if (rank === 1) {
            // 1위: 강렬한 보라색
            rankBgClass = 'bg-purple-500';
            rankTextClass = 'text-white';
        } else if (rank === 2) {
            // 2위: 밝은 파란색
            rankBgClass = 'bg-blue-400';
            rankTextClass = 'text-white';
        } else if (rank === 3) {
            // 3위: 따뜻한 주황색
            rankBgClass = 'bg-orange-500';
            rankTextClass = 'text-white';
        }
        
        return `
            <div class="best-meal-item bg-white rounded-lg border border-slate-200 p-2 flex items-start gap-3 cursor-move active:scale-[0.98] transition-all" 
                 data-meal-id="${meal.id}" 
                 data-rating="${rating}"
                 draggable="true">
                ${photoUrl ? `
                    <div class="flex-shrink-0 w-[140px] h-[140px] rounded-lg overflow-hidden bg-slate-100 relative">
                        <div class="absolute top-1 left-1 w-6 h-6 rounded-full ${rankBgClass} ${rankTextClass} flex items-center justify-center text-xs font-bold z-10">
                            ${rank}
                        </div>
                        <img src="${photoUrl}" alt="${displayTitle}" class="w-full h-full object-cover">
                    </div>
                ` : `
                    <div class="flex-shrink-0 w-[140px] h-[140px] rounded-lg bg-slate-100 flex items-center justify-center relative">
                        <div class="absolute top-1 left-1 w-6 h-6 rounded-full ${rankBgClass} ${rankTextClass} flex items-center justify-center text-xs font-bold z-10">
                            ${rank}
                        </div>
                        <i class="fa-solid fa-utensils text-slate-300 text-4xl"></i>
                    </div>
                `}
                <div class="flex-1 min-w-0">
                    <div class="text-xs text-slate-400 mb-1">${dateStr}</div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-base font-bold text-slate-600">${displayTitle}</span>
                        <span class="text-xs text-slate-400">${slotLabel}</span>
                    </div>
                    <div class="flex items-center gap-0.5">
                        ${Array.from({ length: rating }).map(() => 
                            '<i class="fa-solid fa-star text-yellow-400 text-xs"></i>'
                        ).join('')}
                    </div>
                </div>
                <div class="flex-shrink-0 text-slate-300">
                    <i class="fa-solid fa-grip-vertical text-sm"></i>
                </div>
            </div>
        `;
    }).join('');
    
    // 월간/연간 모드에서는 만족도 5점 음식만 순서 조정 가능
    setupDragAndDrop(isMonthOrYearMode && displayMeals.length > 0);
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

function setupDragAndDrop(enableRatingConstraint = false) {
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
        // 순위 동그라미 찾기 (w-6 h-6)
        const rankCircle = item.querySelector('.w-6.h-6.rounded-full');
        if (rankCircle) {
            rankCircle.textContent = newRank;
            
            // 1~3위 색상 업데이트 (보라색, 파란색, 주황색)
            rankCircle.className = 'absolute top-1 left-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold z-10';
            if (newRank === 1) {
                // 1위: 강렬한 보라색
                rankCircle.classList.add('bg-purple-500', 'text-white');
            } else if (newRank === 2) {
                // 2위: 밝은 파란색
                rankCircle.classList.add('bg-blue-400', 'text-white');
            } else if (newRank === 3) {
                // 3위: 따뜻한 주황색
                rankCircle.classList.add('bg-orange-500', 'text-white');
            } else {
                rankCircle.classList.add('bg-emerald-100', 'text-emerald-700');
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
