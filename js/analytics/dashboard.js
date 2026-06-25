// 대시보드 메인 로직
import { SLOTS, MEALOG_ICON_URL } from '../constants.js';
import { appState } from '../state.js';
import { loadMealsForDateRange, loadStatsForYears } from '../db.js';
import { renderProportionChart } from './charts.js';
import { updateInsightComment, setupInsightBubbleClick, getCurrentCharacter, getInsightCharacters, updateShareButtonStatus } from './insight.js';
import { getWeekRange, getCurrentWeekInMonth, getWeeksInMonth, formatDateWithDay, getWeekDisplayLabel } from './date-utils.js';
import { renderBestMeals } from './best-share.js';
import { renderHealthVitalsCharts, destroyHealthVitalsCharts } from './health-charts.js';
import { toLocalDateString } from '../utils.js';

const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

/** dailyStats에서 기간별 merged 데이터를 가상 record 배열로 변환 (차트용) + mainCount, snackCount */
function statsToFilteredData(dailyStats, startStr, endStr) {
    if (!dailyStats || typeof dailyStats !== 'object') return { records: [], mainCount: 0, snackCount: 0 };
    const records = [];
    let mainCount = 0;
    let snackCount = 0;
    const sumCounts = (counts) => Object.values(counts || {}).reduce((a, c) => a + (typeof c === 'number' ? c : parseInt(c, 10) || 0), 0);
    const expand = (counts, slotId, fieldKey) => {
        if (!counts || typeof counts !== 'object') return;
        Object.entries(counts).forEach(([k, c]) => {
            const kTrimmed = (k == null ? '' : String(k)).trim();
            if (!kTrimmed) return; // 빈 문자열/공백 키는 스킵 (미입력 중복 집계 방지)
            const n = typeof c === 'number' ? c : parseInt(c, 10) || 0;
            for (let i = 0; i < n; i++) {
                const r = { slotId };
                r[fieldKey] = kTrimmed;
                records.push(r);
            }
        });
    };
    const dates = Object.keys(dailyStats).filter(d => d >= startStr && d <= endStr).sort();
    dates.forEach(dateStr => {
        const day = dailyStats[dateStr];
        if (!day) return;
        if (day.main) {
            const n = (day.mainCount != null ? day.mainCount : sumCounts(day.main.withWhom) || sumCounts(day.main.mealType) || sumCounts(day.main.category) || 0);
            mainCount += n;
            if (day.main.mealType) expand(day.main.mealType, 'morning', 'mealType');
            if (day.main.category) expand(day.main.category, 'morning', 'category');
            if (day.main.withWhom) expand(day.main.withWhom, 'morning', 'withWhom');
            if (day.main.rating) expand(day.main.rating, 'morning', 'rating');
            if (day.main.satiety) expand(day.main.satiety, 'morning', 'satiety');
        }
        if (day.snack) {
            snackCount += (day.snackCount != null ? day.snackCount : sumCounts(day.snack.snackType) || sumCounts(day.snack.place) || 0);
            if (day.snack.place) expand(day.snack.place, 'snack1', 'place');
            if (day.snack.snackType) expand(day.snack.snackType, 'snack1', 'snackType');
            if (day.snack.rating) expand(day.snack.rating, 'snack1', 'rating');
            if (day.snack.withWhom) expand(day.snack.withWhom, 'snack1', 'withWhom');
            if (day.snack.satiety) expand(day.snack.satiety, 'snack1', 'satiety');
        }
    });
    return { records, mainCount, snackCount };
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
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = `${y}년 ${m}월`;
    } else if (state.dashboardMode === 'week') {
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        startDate = new Date(start);
        endDate = new Date(end);
        startDate.setHours(0, 0, 0, 0);
        endDate.setHours(23, 59, 59, 999);
        label = getWeekDisplayLabel(start, end);
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
    // 주간·연간·직접설정: 분석 끼니 모수는 경과한 날짜(오늘 포함)만 사용
    const todayStr = toLocalDateString(today);
    const useElapsedOnly = (state.dashboardMode === 'week' || state.dashboardMode === 'year' || state.dashboardMode === 'custom');
    const effectiveEndStr = useElapsedOnly && endStr > todayStr ? todayStr : endStr;

    const daysDiff = Math.max(1, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1);
    // 차트용: mealHistory가 있으면 우선 사용 (식사당 1개 레코드로 정확한 집계, stats expand는 필드별 별도 레코드 생성으로 중복/미입력 발생 가능)
    const mealFiltered = (window.mealHistory || []).filter(m => m.date >= startStr && m.date <= effectiveEndStr);
    const statsHasData = (window.dailyStats && Object.keys(window.dailyStats).length > 0);
    const r = statsHasData ? statsToFilteredData(window.dailyStats, startStr, effectiveEndStr) : null;
    let filteredData, statsMainCount, statsSnackCount;
    if (mealFiltered.length > 0) {
        filteredData = mealFiltered;
        statsMainCount = r?.mainCount ?? null;
        statsSnackCount = r?.snackCount ?? null;
    } else if (r && r.records.length > 0) {
        filteredData = r.records;
        statsMainCount = r.mainCount;
        statsSnackCount = r.snackCount;
    } else {
        filteredData = mealFiltered;
        statsMainCount = null;
        statsSnackCount = null;
    }
    
    return {
        filteredData,
        mealRecordsForTable: mealFiltered,
        dateRangeText: label,
        days: daysDiff,
        statsMainCount,
        statsSnackCount,
        startStr,
        endStr: effectiveEndStr
    };
}

/** 기간 탭·날짜 표시 등 기간 UI 즉시 업데이트 (데이터 로드 전 호출하여 체감 반응 속도 개선) */
function updatePeriodUI(state) {
    const periodNavigator = document.getElementById('periodNavigator');
    const periodDisplay = document.getElementById('periodDisplay');
    const tabBase = "insight-period-tab flex-1 text-xs font-bold transition-colors";

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
            if (periodDisplay) periodDisplay.innerHTML = `${startStr} ~ ${endStr}`;
            const periodPrevBtn = document.getElementById('periodPrevBtn');
            const periodNextBtn = document.getElementById('periodNextBtn');
            if (periodPrevBtn) periodPrevBtn.classList.add('hidden');
            if (periodNextBtn) periodNextBtn.classList.add('hidden');
        }
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) customDatePicker.classList.add('hidden');
    } else if (state.dashboardMode === 'custom') {
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
            if (typeof syncCustomDatePlaceholder === 'function') syncCustomDatePlaceholder();
        }
        if (periodNavigator) periodNavigator.classList.add('hidden');
    } else {
        const customDatePicker = document.getElementById('customDatePicker');
        if (customDatePicker) customDatePicker.classList.add('hidden');
        if (periodNavigator) {
            if (state.dashboardMode === 'week' || state.dashboardMode === 'month' || state.dashboardMode === 'year') {
                periodNavigator.classList.remove('hidden');
                const periodPrevBtn = document.getElementById('periodPrevBtn');
                const periodNextBtn = document.getElementById('periodNextBtn');
                if (periodPrevBtn) periodPrevBtn.classList.remove('hidden');
                if (periodNextBtn) periodNextBtn.classList.remove('hidden');
                if (periodDisplay) {
                    if (state.dashboardMode === 'week') {
                        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
                        periodDisplay.innerHTML = `${getWeekDisplayLabel(start, end)} <span class="text-xs opacity-75">(${formatDateWithDay(start)}~${formatDateWithDay(end)})</span>`;
                    } else if (state.dashboardMode === 'month') {
                        const [y, m] = state.selectedMonth.split('-');
                        periodDisplay.innerText = `${y}년 ${parseInt(m)}월`;
                    } else if (state.dashboardMode === 'year') {
                        periodDisplay.innerText = `${state.selectedYearForYear || new Date().getFullYear()}년`;
                    }
                }
            } else {
                periodNavigator.classList.add('hidden');
            }
        }
    }

    ['7d', 'week', 'month', 'year', 'custom'].forEach(mode => {
        const btn = document.getElementById(`btn-dash-${mode}`);
        if (btn) {
            btn.className = state.dashboardMode === mode ? `${tabBase} insight-period-tab--selected` : tabBase;
        }
    });
}

export async function updateDashboard() {
    const state = appState;
    if (!window.currentUser) return;

    // 1) 기간 탭·날짜 표시 즉시 업데이트 (탭 전환 체감 반응 개선)
    updatePeriodUI(state);
    updateAnalysisTypeUI();

    // 2) 데이터 로드: meals + stats 병렬 실행 (순차 대비 체감 속도 개선)
    const loadPromises = [];
    try {
        if (state.dashboardMode === 'year') {
            const year = state.selectedYearForYear || new Date().getFullYear();
            loadPromises.push(loadMealsForDateRange(`${year}-01-01`, `${year}-12-31`));
        } else if (state.dashboardMode === 'month') {
            const [y, m] = state.selectedMonth.split('-').map(Number);
            const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
            const monthEnd = new Date(y, m, 0).toISOString().split('T')[0];
            loadPromises.push(loadMealsForDateRange(monthStart, monthEnd));
        } else if (state.dashboardMode === 'custom') {
            loadPromises.push(loadMealsForDateRange(toLocalDateString(state.customStartDate), toLocalDateString(state.customEndDate)));
        } else if (state.dashboardMode === 'week') {
            const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            if (start < oneMonthAgo) {
                loadPromises.push(loadMealsForDateRange(toLocalDateString(start), toLocalDateString(end)));
            }
        }

        const { startStr, endStr } = (() => {
            const s = appState;
            const today = new Date();
            let startDate, endDate;
            if (s.dashboardMode === '7d') {
                const start = s.recentWeekStartDate || (() => { const d = new Date(today); d.setDate(d.getDate() - 6); return d; })();
                startDate = new Date(start);
                endDate = new Date(today);
            } else if (s.dashboardMode === 'month') {
                const [ym, mm] = s.selectedMonth.split('-').map(Number);
                startDate = new Date(ym, mm - 1, 1);
                endDate = new Date(ym, mm, 0);
            } else if (s.dashboardMode === 'week') {
                const { start, end } = getWeekRange(s.selectedYear, s.selectedMonthForWeek, s.selectedWeek);
                startDate = new Date(start);
                endDate = new Date(end);
            } else if (s.dashboardMode === 'year') {
                const year = s.selectedYearForYear || today.getFullYear();
                startDate = new Date(year, 0, 1);
                endDate = new Date(year, 11, 31);
            } else if (s.dashboardMode === 'custom') {
                startDate = new Date(s.customStartDate);
                endDate = new Date(s.customEndDate);
            } else {
                return {};
            }
            return { startStr: toLocalDateString(startDate), endStr: toLocalDateString(endDate) };
        })();
        if (startStr && endStr) {
            const startYear = parseInt(startStr.split('-')[0], 10);
            const endYear = parseInt(endStr.split('-')[0], 10);
            const currentYear = new Date().getFullYear();
            const yearsToLoad = [];
            for (let y = startYear; y <= endYear; y++) {
                if (y < currentYear - 1) yearsToLoad.push(y);
            }
            if (yearsToLoad.length > 0) loadPromises.push(loadStatsForYears(yearsToLoad));
        }

        await Promise.all(loadPromises);
    } catch (e) {
        console.error("대시보드 데이터 로드 실패:", e);
    }

    
    const { filteredData, dateRangeText, days, statsMainCount, statsSnackCount, startStr, endStr } = getDashboardData();

    // 식사/간식 데이터 분리
    const mainMealsOnly = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId);
        return slot && slot.type === 'main';
    });
    
    const snacksOnly = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId);
        return slot && slot.type === 'snack';
    });
    
    // 식사 분석 차트 (메인태그만 사용 - 상세입력항목 아님)
    renderProportionChart('propChartContainer', mainMealsOnly.filter(m => m.mealType), 'mealType');
    renderProportionChart('categoryChartContainer', mainMealsOnly.filter(m => m.category), 'category');
    renderProportionChart('mateChartContainer', mainMealsOnly.filter(m => m.withWhom), 'withWhom');
    renderProportionChart('ratingChartContainer', mainMealsOnly.filter(m => m.rating), 'rating');
    renderProportionChart('satietyChartContainer', filteredData.filter(m => m.satiety), 'satiety');
    
    // 간식 분석 차트 (어디서 → 무엇을 순) - place/snackType 없는 건도 미입력으로 포함
    const snackSlotLabelMap = {
        pre_morning: '아침 전',
        snack1: '오전',
        snack2: '오후',
        night: '야식'
    };
    const snacksForWhen = snacksOnly.map(m => ({
        ...m,
        snackWhen: snackSlotLabelMap[m.slotId] || '미입력'
    }));
    renderProportionChart('snackWhenChartContainer', snacksForWhen, 'snackWhen');
    renderProportionChart('snackPlaceChartContainer', snacksOnly, 'snackPlace');
    renderProportionChart('snackTypeChartContainer', snacksOnly, 'snackType');
    renderProportionChart('snackMateChartContainer', snacksOnly.filter(m => m.withWhom), 'withWhom');
    renderProportionChart('snackRatingChartContainer', snacksOnly.filter(m => m.rating), 'rating');
    renderProportionChart('snackSatietyChartContainer', snacksOnly.filter(m => m.satiety), 'satiety');

    if (state.analysisType === 'health' && startStr && endStr) {
        renderHealthVitalsCharts(startStr, endStr);
    } else {
        destroyHealthVitalsCharts();
    }
    
    // 식사 기록 모수 분모: 주간·연간·직접설정은 경과한 날짜(오늘 포함)만 사용
    const today = new Date();
    const todayStr = toLocalDateString(today);
    let targetDays = days;
    if (state.dashboardMode === 'month') {
        const [selY, selM] = state.selectedMonth.split('-').map(Number);
        if (today.getFullYear() === selY && (today.getMonth() + 1) === selM) {
            targetDays = today.getDate();
        } else if (new Date(selY, selM - 1, 1) > today) {
            targetDays = 0;
        }
    } else if (state.dashboardMode === 'week' || state.dashboardMode === 'year' || state.dashboardMode === 'custom') {
        let rangeStart, rangeEnd;
        if (state.dashboardMode === 'week') {
            const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
            rangeStart = new Date(start);
            rangeEnd = new Date(end);
        } else if (state.dashboardMode === 'year') {
            const y = state.selectedYearForYear || today.getFullYear();
            rangeStart = new Date(y, 0, 1);
            rangeEnd = new Date(y, 11, 31);
        } else {
            rangeStart = new Date(state.customStartDate);
            rangeEnd = new Date(state.customEndDate);
        }
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        if (effectiveEnd < rangeStart) {
            targetDays = 0;
        } else {
            targetDays = Math.floor((effectiveEnd - rangeStart) / (1000 * 60 * 60 * 24)) + 1;
        }
    }
    
    // 식사 기록 통계 계산 (간식 제외, 식사만 계산)
    // mealHistory 기반 filteredData(날짜 있음)는 직접 카운트. stats 기반(날짜 없음)은 mainCount/snackCount 사용
    const totalRec = Math.max(0, targetDays * 3);
    const hasMealHistoryData = filteredData.some(m => m.date);
    // 동일 날짜+슬롯에 여러 meal 문서가 있을 수 있으므로, (date, slotId) 기준 유니크 카운트 (총 끼니수 초과 방지)
    const recCount = (hasMealHistoryData ? null : statsMainCount) ?? (() => {
        const seen = new Set();
        return filteredData.filter(m => {
            const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
            if (!slot || m.mealType === 'Skip') return false;
            const key = `${m.date}|${m.slotId}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).length;
    })();
    const mealPercent = totalRec > 0 ? Math.round((recCount / totalRec) * 100) : 0;
    
    const snackCount = (hasMealHistoryData ? null : statsSnackCount) ?? filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'snack');
        return slot && m.snackType;
    }).length;
    
    // 식사 기록 표시 (undefined 방지)
    const mealRecordCountEl = document.getElementById('mealRecordCount');
    const mealRecordPercentEl = document.getElementById('mealRecordPercent');
    const mealRecordTotalEl = document.getElementById('mealRecordTotal');
    if (mealRecordCountEl) mealRecordCountEl.textContent = String(recCount ?? 0);
    if (mealRecordPercentEl) mealRecordPercentEl.textContent = `(${mealPercent}%)`;
    if (mealRecordTotalEl) mealRecordTotalEl.textContent = `/${totalRec}`;
    
    // 간식 기록 표시
    const snackRecordCountEl = document.getElementById('snackRecordCount');
    if (snackRecordCountEl) snackRecordCountEl.textContent = String(snackCount ?? 0);
    
    // 인사이트 코멘트는 처음 로드 시 기본 코멘트를 표시하고, 이후에는 COMMENT 버튼을 눌렀을 때만 업데이트됨
    // 처음 로드 시에만 기본 코멘트 표시 (이미 코멘트가 있으면 표시하지 않음). 표시 내용은 관리자 화면에서 수기 설정.
    const insightTextContent = document.getElementById('insightTextContent');
    if (insightTextContent && (!insightTextContent.textContent || insightTextContent.textContent.trim() === '')) {
        if (window.getDashboardData) {
            const { filteredData, dateRangeText } = window.getDashboardData();
            updateInsightComment(filteredData, dateRangeText);
        }
    }
    
    // 공유 버튼 상태 업데이트 (공유 상태가 변경되었을 수 있으므로 항상 업데이트)
    updateShareButtonStatus();
    
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
                    characterIconEl.innerHTML = `<img src="${character.image}" alt="${character.name}" class="w-full h-full object-cover">`;
                    characterIconEl.className = 'w-full h-full flex items-center justify-center';
                } else if (character.id === 'mealog') {
                    // MEALOG는 스마트폰용 밀로그 아이콘 이미지 (70x70 정사각형)
                    characterIconEl.innerHTML = `<div class="insight-character-icon-box w-[70px] h-[70px] flex items-center justify-center overflow-hidden rounded-2xl flex-shrink-0"><img src="${MEALOG_ICON_URL}" alt="MEALOG" class="w-full h-full object-contain" onerror="this.style.display='none';this.nextElementSibling?.classList.remove('hidden');"><span class="hidden text-2xl font-black mealog-character-m text-white">M</span></div>`;
                    characterIconEl.className = 'w-full h-full flex items-center justify-center mealog-character-m';
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
    const healthBtn = document.getElementById('btn-analysis-health');
    const bestSection = document.getElementById('bestAnalysisSection');
    const mainSection = document.getElementById('mainAnalysisSection');
    const snackSection = document.getElementById('snackAnalysisSection');
    const healthSection = document.getElementById('healthAnalysisSection');
    
    const activeBtnClass = "flex-1 py-2.5 text-sm font-semibold transition-all relative text-slate-900 border-b-2 border-slate-900";
    const inactiveBtnClass = "flex-1 py-2.5 text-sm font-semibold transition-all relative text-slate-400 hover:text-slate-600 border-b-2 border-transparent";
    
    const shouldHideBest = state.dashboardMode === 'custom';
    
    if (bestBtn && mainBtn && snackBtn) {
        if (shouldHideBest) {
            bestBtn.style.display = 'none';
            if (state.analysisType === 'best') {
                state.analysisType = 'main';
            }
        } else {
            bestBtn.style.display = '';
        }
        
        bestBtn.className = state.analysisType === 'best' ? activeBtnClass : inactiveBtnClass;
        mainBtn.className = state.analysisType === 'main' ? activeBtnClass : inactiveBtnClass;
        snackBtn.className = state.analysisType === 'snack' ? activeBtnClass : inactiveBtnClass;
    }

    if (healthBtn) {
        healthBtn.style.display = '';
        healthBtn.className = state.analysisType === 'health' ? activeBtnClass : inactiveBtnClass;
    }
    
    if (bestSection && mainSection && snackSection) {
        bestSection.classList.toggle('hidden', state.analysisType !== 'best' || shouldHideBest);
        mainSection.classList.toggle('hidden', state.analysisType !== 'main');
        snackSection.classList.toggle('hidden', state.analysisType !== 'snack');
    }

    if (healthSection) {
        healthSection.classList.toggle('hidden', state.analysisType !== 'health');
    }
    
    if (state.analysisType === 'best' && !shouldHideBest) {
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

export function syncCustomDatePlaceholder() {
    const startInput = document.getElementById('customStart');
    const endInput = document.getElementById('customEnd');
    const startWrap = startInput?.closest('.custom-date-input-wrap');
    const endWrap = endInput?.closest('.custom-date-input-wrap');
    if (startWrap) startWrap.classList.toggle('is-empty', !startInput?.value);
    if (endWrap) endWrap.classList.toggle('is-empty', !endInput?.value);
}

export function updateCustomDates() {
    const startInput = document.getElementById('customStart');
    const endInput = document.getElementById('customEnd');
    if (startInput && endInput) {
        if (startInput.value) appState.customStartDate = new Date(startInput.value);
        if (endInput.value) appState.customEndDate = new Date(endInput.value);
        syncCustomDatePlaceholder();
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

