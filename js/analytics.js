// 통계 및 차트 관련 함수들
import { SLOTS, SLOT_STYLES, VIBRANT_COLORS, RATING_GRADIENT, SATIETY_DATA } from './constants.js';
import { appState } from './state.js';
import { generateColorMap } from './utils.js';
import { loadMealsForDateRange } from './db.js';
import { showToast } from './ui.js';

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
        container.innerHTML = '<div class="text-center py-4 px-5 text-slate-400 text-xs">데이터가 없습니다.</div>';
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
        const emptyEntry = entries.find(([name]) => name === '미입력');
        const nonEmptyEntries = entries.filter(([name]) => name !== '미입력');
        
        // 만족도나 포만감의 경우 값 순서대로 정렬 (높은 수준이 오른쪽)
        if (key === 'rating' || key === 'snackRating') {
            const ratingEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum; // 오름차순 (1점부터 5점까지)
                }
                return 0;
            });
            sorted = emptyEntry ? [...ratingEntries, emptyEntry] : ratingEntries;
        } else if (key === 'satiety') {
            const satietyEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum; // 오름차순 (1부터 5까지)
                }
                return 0;
            });
            sorted = emptyEntry ? [...satietyEntries, emptyEntry] : satietyEntries;
        } else {
            // 다른 경우는 개수 내림차순으로 정렬
            const sortedEntries = nonEmptyEntries.sort((a, b) => b[1] - a[1]);
            sorted = emptyEntry ? [...sortedEntries, emptyEntry] : sortedEntries;
        }
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
        } else if (key === 'rating' || key === 'snackRating') {
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
        
        if (pct < 5 || ((key === 'rating' || key === 'snackRating') && parseInt(name) <= 2)) textColor = '#475569';
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
    html += '<div class="relative h-5 mt-1 mb-0">';
    let lastLabelEnd = -1;
    segments.forEach(({ name, count, startPercent, widthPercent }) => {
        // 라벨 표시 텍스트 생성
        let displayName = name === '미입력' ? '미입력' : name;
        if (key === 'rating' || key === 'snackRating') {
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

// 캐릭터 정의
const INSIGHT_CHARACTERS = [
    { id: 'mealog', name: 'MEALOG', icon: 'M', persona: '친근하고 따뜻한 식사 친구' },
    { id: 'trainer', name: '엄격한 트레이너', icon: '💪', persona: '건강과 웰빙을 중시하는 트레이너' }
];

// 현재 선택된 캐릭터 (기본값: MEALOG)
let currentCharacter = 'mealog';

// 텍스트를 5줄 단위로 나누는 함수 (더 정확한 줄 단위 분할)
function splitTextIntoPages(text, maxLines = 5) {
    if (!text) return [''];
    
    // 줄바꿈을 기준으로 분할
    const originalLines = text.split('\n');
    const allLines = [];
    
    // 각 줄을 최대 45자로 나누기 (말풍선 너비 고려)
    originalLines.forEach(line => {
        if (line.length <= 45) {
            allLines.push(line);
        } else {
            // 긴 줄을 단어 단위로 나누기
            const words = line.split(' ');
            let currentLine = '';
            
            words.forEach(word => {
                if (!currentLine) {
                    currentLine = word;
                } else if ((currentLine + ' ' + word).length <= 45) {
                    currentLine += ' ' + word;
                } else {
                    if (currentLine) allLines.push(currentLine);
                    currentLine = word;
                }
            });
            
            if (currentLine) allLines.push(currentLine);
        }
    });
    
    // 5줄씩 묶어서 페이지 만들기
    const pages = [];
    for (let i = 0; i < allLines.length; i += maxLines) {
        const pageLines = allLines.slice(i, i + maxLines);
        pages.push(pageLines.join('\n'));
    }
    
    return pages.length > 0 ? pages : [text];
}

// 말풍선에 텍스트 표시 (페이지네이션)
function displayInsightText(text, characterName = '') {
    const container = document.getElementById('insightTextPages');
    const indicator = document.getElementById('insightPageIndicator');
    
    if (!container) return;
    
    const pages = splitTextIntoPages(text, 5);
    
    // 캐릭터명을 각 페이지 상단에 추가
    const characterHeader = characterName ? `<div class="insight-character-name text-xs font-bold text-emerald-700 mb-1">[ ${characterName} ]</div>` : '';
    
    container.innerHTML = pages.map((page, index) => 
        `<div class="insight-text-page ${index === 0 ? 'active' : ''}" data-page="${index}">${characterHeader}<div class="insight-text-content">${page}</div></div>`
    ).join('');
    
    // 페이지 인디케이터 표시 (페이지가 2개 이상일 때만)
    if (pages.length > 1 && indicator) {
        indicator.classList.remove('hidden');
        indicator.innerHTML = pages.map((_, index) => 
            `<div class="insight-page-dot ${index === 0 ? 'active' : ''}" onclick="window.showInsightPage(${index})"></div>`
        ).join('');
    } else if (indicator) {
        indicator.classList.add('hidden');
    }
    
    // 첫 페이지로 초기화
    window.currentInsightPage = 0;
}

// 인사이트 페이지 전환
export function showInsightPage(pageIndex) {
    const pages = document.querySelectorAll('.insight-text-page');
    const dots = document.querySelectorAll('.insight-page-dot');
    
    if (pages.length === 0) return;
    
    pages.forEach((page, index) => {
        page.classList.toggle('active', index === pageIndex);
    });
    
    dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === pageIndex);
    });
    
    window.currentInsightPage = pageIndex;
}

// 말풍선 클릭 시 다음 페이지로 (초기화)
export function setupInsightBubbleClick() {
    const bubble = document.getElementById('insightBubble');
    if (!bubble) return;
    
    // 기존 이벤트 리스너 제거 후 새로 추가
    bubble.removeEventListener('click', handleInsightBubbleClick);
    bubble.addEventListener('click', handleInsightBubbleClick);
}

function handleInsightBubbleClick() {
    const pages = document.querySelectorAll('.insight-text-page');
    if (pages.length <= 1) return;
    
    const currentPage = window.currentInsightPage || 0;
    const nextPage = (currentPage + 1) % pages.length;
    showInsightPage(nextPage);
}

// 캐릭터 선택 팝업 열기/토글
export function openCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    
    if (!popup) return;
    
    // 이미 열려있으면 닫기
    if (!popup.classList.contains('hidden')) {
        closeCharacterSelectModal();
        return;
    }
    
    // 화면 가운데에 표시 (CSS로 처리되므로 위치 설정 불필요)
    popup.classList.remove('hidden');
    
    // 외부 클릭 시 닫기
    setTimeout(() => {
        document.addEventListener('click', handleOutsideClick, true);
    }, 100);
}

// 외부 클릭 핸들러
function handleOutsideClick(e) {
    const popup = document.getElementById('characterSelectPopup');
    const popupContent = popup?.querySelector('.bg-white');
    
    // 팝업 내부가 아닌 배경 클릭 시에만 닫기
    if (popup && popupContent && !popupContent.contains(e.target)) {
        closeCharacterSelectModal();
        document.removeEventListener('click', handleOutsideClick, true);
    }
}

// 캐릭터 선택 팝업 닫기
export function closeCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    if (popup) {
        popup.classList.add('hidden');
    }
    document.removeEventListener('click', handleOutsideClick, true);
}

// 캐릭터 선택
export function selectInsightCharacter(characterId) {
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    if (!character) return;
    
    currentCharacter = characterId;
    
    // 캐릭터 아이콘 업데이트
    const iconEl = document.getElementById('insightCharacterIcon');
    if (iconEl) {
        if (character.id === 'mealog') {
            iconEl.textContent = 'M';
            iconEl.className = 'text-2xl font-black text-white';
        } else {
            iconEl.textContent = character.icon;
            iconEl.className = 'text-3xl';
        }
    }
    
    // 캐릭터 목록 UI 업데이트
    const items = document.querySelectorAll('.character-popup-item');
    items.forEach(item => {
        const charId = item.getAttribute('data-character-id');
        if (charId === characterId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // 팝업 닫기
    closeCharacterSelectModal();
    
    // 선택된 캐릭터로 인사이트 다시 생성 (나중에 AI 연결 시)
    const { filteredData } = getDashboardData();
    updateInsightComment(filteredData);
}

// 캐릭터에 맞는 인사이트 코멘트 업데이트
export async function updateInsightComment(filteredData) {
    const comment = await getGeminiComment(filteredData, currentCharacter);
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    displayInsightText(comment || "멋진 식사 기록이 쌓이고 있어요! ✨", characterName);
}

async function getGeminiComment(filteredData, characterId = currentCharacter) {
    if (filteredData.length === 0) {
        const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
        return character ? `${character.icon} 오늘도 맛있는 기록 되세요!` : "오늘도 맛있는 기록 되세요!";
    }
    
    // 기본 메시지 (나중에 AI 연결 시 캐릭터별 페르소나 적용)
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    const prefix = character ? `${character.icon} ` : '';
    
    return prefix + "멋진 식사 기록이 쌓이고 있어요! ✨\n\n이번 기간 동안 다양한 맛을 경험하셨네요. 건강하고 행복한 식사가 계속되기를 바랍니다!";
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
    
    // 인사이트 코멘트 (말풍선에 표시)
    await updateInsightComment(filteredData);
    
    // 말풍선 클릭 이벤트 설정
    setupInsightBubbleClick();
    
    // 초기 캐릭터 아이콘 설정
    const characterIconEl = document.getElementById('insightCharacterIcon');
    if (characterIconEl) {
        const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
        if (character) {
            if (character.id === 'mealog') {
                characterIconEl.textContent = 'M';
                characterIconEl.className = 'text-2xl font-black text-white';
            } else {
                characterIconEl.textContent = character.icon;
                characterIconEl.className = 'text-3xl';
            }
        }
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
    // rating, snackRating, satiety는 숫자 값이므로 태그 필터링 불필요
    
    let slots, slotLabels;
    if (key === 'snackType' || key === 'snackRating') {
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
        if (key === 'rating' || key === 'snackRating') {
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
        if (key === 'rating' || key === 'snackRating') {
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
            } else if (key === 'rating' || key === 'snackRating') {
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
            
            if (pct < 5 || ((key === 'rating' || key === 'snackRating') && parseInt(name) <= 2)) textColor = '#475569';
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
        // 스크린샷 생성
        const canvas = await html2canvas(preview, {
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
        const { db, appId } = await import('./firebase.js');
        const sharedColl = collection(db, 'artifacts', appId, 'sharedPhotos');
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
