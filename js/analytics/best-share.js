// 베스트 공유 관련 함수들
import {
    SLOTS,
    SLOT_STYLES,
    SATIETY_DATA
} from '../constants.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { dbOps } from '../db.js';
import { isDemoUser } from '../demo-account.js';
import { isUserSettingsReadyForContentWrites } from '../utils/user-settings-write-guard.js';
import { getWeekRange, getWeeksInMonth, getDayName, formatDateWithDay, getWeekDisplayLabel, getWeekInfoFromDate } from './date-utils.js';
import { renderGallery } from '../render/index.js';
import { buildBestShareCaptureHtml } from '../render/best-share-card.js';
import { toLocalDateString, captureWithGhostStrategy } from '../utils.js';
import { getThumbImageUrl, getOriginalImageUrl } from '../utils/image-variants.js';
import { scheduleLucideIcons } from '../icons.js';
import { unshareWithOptimisticUpdate, getSharedPhotos, setSharedPhotos, upsertSharedPhoto } from '../utils/moment-share-state.js';

// HTML 이스케이프 함수 (XSS 방지)
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function bestThumbEmptyHtml() {
    return `<div class="dashboard-best-thumb dashboard-best-thumb--empty" aria-hidden="true"><i data-lucide="utensils"></i></div>`;
}

/** 썸네일/원본 로드 실패 시 utensils 플레이스홀더로 교체 */
function ensureBestThumbErrorHandler() {
    if (typeof window === 'undefined' || window.__bestThumbOnError) return;
    window.__bestThumbOnError = function (img) {
        try {
            if (!img) return;
            if (img.dataset.imgFellBack !== '1') {
                const orig = (img.getAttribute('data-original-src') || '').trim();
                if (orig && img.src !== orig) {
                    img.dataset.imgFellBack = '1';
                    img.src = orig;
                    return;
                }
            }
            const wrap = document.createElement('div');
            wrap.innerHTML = bestThumbEmptyHtml();
            const empty = wrap.firstElementChild;
            if (empty) {
                img.replaceWith(empty);
                scheduleLucideIcons(empty);
            }
        } catch {
            /* no-op */
        }
    };
}

function getRecentWeekRangeForBest() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = appState.recentWeekStartDate ? new Date(appState.recentWeekStartDate) : new Date(today);
    start.setHours(0, 0, 0, 0);
    if (!appState.recentWeekStartDate) {
        start.setDate(today.getDate() - 6);
    }
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
}

/** @param {'default' | 'unshare' | 'edit'} variant */
function applyBestShareSubmitVariant(variant) {
    const btn = document.getElementById('bestShareSubmitBtn');
    if (!btn) return;
    const labelText =
        variant === 'unshare' ? '공유 취소' : variant === 'edit' ? '수정 완료' : '공유하기';
    btn.className = variant === 'unshare' ? 'mealog-btn mealog-btn-danger' : 'mealog-btn mealog-btn-primary';
    btn.disabled = false;
    btn.innerHTML =
        `<span class="mealog-share-btn__inner"><i data-lucide="send" aria-hidden="true"></i><span id="bestShareSubmitLabel">${labelText}</span></span>`;
    scheduleLucideIcons(btn);
}

function setBestShareSubmitLoading(isLoading) {
    const btn = document.getElementById('bestShareSubmitBtn');
    if (!btn || !isLoading) return;
    btn.disabled = true;
    btn.className = 'mealog-btn mealog-btn-primary';
    btn.innerHTML =
        '<span class="mealog-share-btn__inner"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span>공유 중...</span></span>';
    scheduleLucideIcons(btn);
}

function setBestShareSubmitEditing(isEditing) {
    const btn = document.getElementById('bestShareSubmitBtn');
    if (!btn || !isEditing) return;
    btn.disabled = true;
    btn.className = 'mealog-btn mealog-btn-primary';
    btn.innerHTML =
        '<span class="mealog-share-btn__inner"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span>수정 중...</span></span>';
    scheduleLucideIcons(btn);
}

function getRangeBestMeals(start, end, minRating = 4) {
    const startStr = toLocalDateString(start);
    const endStr = toLocalDateString(end);
    
    const rangeData = window.mealHistory.filter(m => {
        return m.date >= startStr && m.date <= endStr;
    });
    
    const highRatingMeals = rangeData.filter(m => {
        return m.rating && parseInt(m.rating) >= minRating;
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

// 주간 베스트 가져오기 (기본 만족도 4~5점, 전부 표시)
function getWeekBestMeals(year, month, week, minRating = 4) {
    const { start, end } = getWeekRange(year, month, week);
    return getRangeBestMeals(start, end, minRating);
}

// 월간 베스트 가져오기 (각 주간 베스트에서 선정된 것들만)
function getMonthBestMeals(year, month) {
    const totalWeeks = getWeeksInMonth(year, month);
    const allBestMeals = [];
    const mealMap = new Map(); // 중복 제거용 (같은 음식은 한 번만)
    
    // 해당 월의 시작일과 종료일 계산
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0);
    const monthStartStr = toLocalDateString(monthStart);
    const monthEndStr = toLocalDateString(monthEnd);
    
    for (let week = 1; week <= totalWeeks; week++) {
        // 각 주간의 베스트 가져오기 (사용자가 설정한 순서 포함)
        // weekKey는 주 시작일 기준으로 통일 (1월 6주/2월 1주 등 동일 기간 중복 방지)
        const { start } = getWeekRange(year, month, week);
        const { year: wkYear, month: wkMonth, week: wkNum } = getWeekInfoFromDate(start);
        const weekKey = `week_${wkYear}_${wkMonth}_${wkNum}`;
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

/** 베스트 공유 가능 기간 충족 여부. 주간 4일 이상, 월간 10일 이상, 연간 4월 1일 이후 */
function getBestSharePeriodAllowance() {
    const state = appState;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (state.dashboardMode === 'week') {
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        const rangeStart = new Date(start);
        const rangeEnd = new Date(end);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        const elapsedDays = effectiveEnd < rangeStart ? 0 : Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
        if (elapsedDays < 4) {
            return { allowed: false, message: '주간 베스트 공유는 해당 주가 4일 이상 경과된 후에 가능해요.' };
        }
        return { allowed: true };
    }
    if (state.dashboardMode === 'month') {
        const [y, m] = state.selectedMonth.split('-').map(Number);
        const rangeStart = new Date(y, m - 1, 1);
        const rangeEnd = new Date(y, m, 0);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        const elapsedDays = effectiveEnd < rangeStart ? 0 : Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
        if (elapsedDays < 10) {
            return { allowed: false, message: '월간 베스트 공유는 해당 월이 10일 이상 경과된 후에 가능해요.' };
        }
        return { allowed: true };
    }
    if (state.dashboardMode === 'year') {
        const year = state.selectedYearForYear || today.getFullYear();
        const effectiveEnd = new Date(year, today.getMonth(), today.getDate());
        if (year < today.getFullYear()) {
            return { allowed: true };
        }
        const aprilFirst = new Date(year, 3, 1); // 4월 1일
        if (effectiveEnd < aprilFirst) {
            return { allowed: false, message: '연간 베스트 공유는 해당 연도가 4월 1일 이후에 가능해요.' };
        }
        return { allowed: true };
    }
    return { allowed: true };
}

function getBestPeriodKey() {
    const state = appState;
    if (state.dashboardMode === '7d') {
        const { start, end } = getRecentWeekRangeForBest();
        return `recent7d_${toLocalDateString(start)}_${toLocalDateString(end)}`;
    } else if (state.dashboardMode === 'week') {
        const { start } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        const { year, month, week } = getWeekInfoFromDate(start);
        return `week_${year}_${month}_${week}`;
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
    let periodKey = '';
    
    if (state.dashboardMode === '7d') {
        const { start, end } = getRecentWeekRangeForBest();
        meals = getRangeBestMeals(start, end, 4);
        periodKey = getBestPeriodKey();
    } else if (state.dashboardMode === 'week') {
        // 주간 모드: 해당 기간의 만족도 4~5개 리스트
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        meals = getWeekBestMeals(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek, 4);
        const { year, month, week } = getWeekInfoFromDate(start);
        periodKey = `week_${year}_${month}_${week}`;
    } else if (state.dashboardMode === 'month') {
        // 월간 모드: 각 주간에서 1~5위
        const [y, m] = state.selectedMonth.split('-').map(Number);
        meals = getMonthBestMeals(y, m);
        periodKey = `month_${state.selectedMonth}`;
    } else if (state.dashboardMode === 'year') {
        // 연간 모드: 각 월별 1~5위
        const year = state.selectedYearForYear || new Date().getFullYear();
        meals = getYearBestMeals(year);
        periodKey = `year_${year}`;
    } else if (state.dashboardMode === 'custom') {
        // 직접설정 → 연간 베스트 표시 (연간과 동일한 형식: 해당 연도만 표시)
        const startDate = state.customStartDate || new Date();
        const year = startDate.getFullYear();
        meals = getYearBestMeals(year);
        periodKey = `year_${year}_custom`;
    }
    
    // 공유 버튼 표시: 주간/월간에서 베스트 메뉴가 1개 이상이면 항상 표시 (기간 충족 여부는 클릭 시 안내)
    const shareBtn = document.getElementById('shareBestBtn');
    if (shareBtn) {
        const hasTop3Meals = () => {
            // 1~3위 메뉴가 있는지 확인 (필터링 전 meals 사용)
            const top3 = meals.filter(m => m && m.rating).slice(0, 3);
            return top3.length >= 1; // 최소 1개 이상이면 공유 가능
        };
        const isShareableMode = state.dashboardMode === '7d' || state.dashboardMode === 'week' || state.dashboardMode === 'month' || state.dashboardMode === 'year';

        if (isShareableMode && hasTop3Meals()) {
            shareBtn.classList.remove('hidden');
            
            // 공유 상태 확인 및 버튼 텍스트 업데이트
            const state = appState;
            let periodType = '';
            let periodText = '';
            
            if (state.dashboardMode === '7d') {
                periodType = '최근1주';
                const { start, end } = getRecentWeekRangeForBest();
                periodText = `${formatDateWithDay(start)} ~ ${formatDateWithDay(end)}`;
            } else if (state.dashboardMode === 'week') {
                periodType = '주간';
                const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
                periodText = getWeekDisplayLabel(start, end);
            } else if (state.dashboardMode === 'month') {
                periodType = '월간';
                const [y, m] = state.selectedMonth.split('-').map(Number);
                periodText = `${y}년 ${m}월`;
            } else if (state.dashboardMode === 'year') {
                periodType = '연간';
                const year = state.selectedYearForYear || new Date().getFullYear();
                periodText = `${year}년`;
            }
            
            // 공유 캐시에서 해당 기간의 베스트 공유 찾기
            const bestShare = getSharedPhotos().find(photo =>
                photo.type === 'best' &&
                photo.periodType === periodType &&
                photo.periodText === periodText
            ) || null;
            
            const isShared = !!bestShare;
            
            // 밀로그 타임라인과 동일 — 공유됨은 check + 솔리드 green
            if (isShared) {
                shareBtn.innerHTML = '<i data-lucide="check" class="text-[10px]" aria-hidden="true"></i>공유됨';
                shareBtn.className = 'date-section-header__share-btn date-section-header__share-btn--shared';
                shareBtn.title = '공유됨 — 탭하면 공유 모달';
                shareBtn.setAttribute('aria-pressed', 'true');
            } else {
                shareBtn.innerHTML = '<i data-lucide="send" class="text-[10px]" aria-hidden="true"></i>공유하기';
                shareBtn.className = 'date-section-header__share-btn date-section-header__share-btn--default';
                shareBtn.title = '모먼트에 공유하기';
                shareBtn.setAttribute('aria-pressed', 'false');
            }
            scheduleLucideIcons(shareBtn);
        } else {
            shareBtn.classList.add('hidden');
        }
    }
    
    // 연간 모드: 만족도 5점만, 그 외 모드: 4점 이상
    const isYearMode = state.dashboardMode === 'year' || state.dashboardMode === 'custom';
    const isMonthMode = state.dashboardMode === 'month';
    const isMonthOrYearMode = isMonthMode || isYearMode;
    const minRatingForMode = isYearMode ? 5 : 4;
    const filteredMeals = isYearMode
        ? meals.filter(m => m && m.rating && parseInt(m.rating) === 5)
        : meals.filter(m => m && m.rating && parseInt(m.rating) >= minRatingForMode);
    
    if (filteredMeals.length === 0) {
        const message = isYearMode
            ? '만족도 5점인 기록이 없습니다.'
            : `만족도 ${minRatingForMode}점 이상인 기록이 없습니다.`;
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
        const originalUrl = getOriginalImageUrl(meal, 0, 'best.list') || '';
        const thumbUrl = getThumbImageUrl(meal, 0, 'best.list') || originalUrl;
        const rating = meal.rating ? parseInt(meal.rating) : 0;
        const place = meal.place || '';
        const menuDetail = meal.menuDetail || '';
        const safePlace = escapeHtml(place);
        const safeMenuDetail = escapeHtml(menuDetail || displayTitle);
        
        const safeDate = (meal.date || '').replace(/'/g, "\\'");
        const safeSlotId = (meal.slotId || '').replace(/'/g, "\\'");
        const safeMealId = (meal.id || '').replace(/'/g, "\\'");
        const slotLine = place ? `${escapeHtml(slotLabel)} · ${safePlace}` : escapeHtml(slotLabel);
        const stars = rating > 0 ? `★ ${Math.min(5, rating)}` : '—';
        
        let thumbHtml = '';
        if (thumbUrl) {
            ensureBestThumbErrorHandler();
            const dataOrig = (originalUrl && originalUrl !== thumbUrl)
                ? ` data-original-src="${escapeHtml(originalUrl)}"`
                : '';
            thumbHtml = `<img class="dashboard-best-thumb" alt="" src="${escapeHtml(thumbUrl)}"${dataOrig} loading="lazy" onerror="window.__bestThumbOnError&&window.__bestThumbOnError(this)" />`;
        } else {
            thumbHtml = bestThumbEmptyHtml();
        }

        const rank = index + 1;
        const showOrderControls = displayMeals.length > 1;
        const orderControlsHtml = showOrderControls ? `
                    <div class="dashboard-best-order flex flex-col gap-0.5 ml-1">
                        <button type="button" class="best-order-btn best-order-up-btn w-6 h-6 flex items-center justify-center rounded disabled:opacity-30 disabled:pointer-events-none" aria-label="위로"${index === 0 ? ' disabled' : ''}>
                            <i data-lucide="chevron-up" class="text-xs"></i>
                        </button>
                        <button type="button" class="best-order-btn best-order-down-btn w-6 h-6 flex items-center justify-center rounded disabled:opacity-30 disabled:pointer-events-none" aria-label="아래로"${index === displayMeals.length - 1 ? ' disabled' : ''}>
                            <i data-lucide="chevron-down" class="text-xs"></i>
                        </button>
                    </div>` : '';

        return `
            <div class="dashboard-best-item best-meal-item cursor-pointer"
                 data-meal-id="${safeMealId}"
                 data-rating="${rating}"
                 data-date="${safeDate}"
                 data-slot-id="${safeSlotId}">
                <span class="dashboard-best-rank" aria-label="${rank}위">${rank}</span>
                ${thumbHtml}
                <div class="dashboard-best-meta min-w-0">
                    <div class="slot">${slotLine}</div>
                    <div class="name truncate">${safeMenuDetail}</div>
                </div>
                <div class="flex items-center gap-1">
                    <div class="dashboard-best-stars" aria-label="${rating}점">${stars}</div>
                    ${orderControlsHtml}
                </div>
            </div>
        `;
    }).join('');
    
    setupBestOrderControls();
    scheduleLucideIcons(container);
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
    
    // 순위 번호 갱신 (순서 변경 직후)
    items.forEach((item, index) => {
        const rankEl = item.querySelector('.dashboard-best-rank');
        if (rankEl) {
            const newRank = index + 1;
            rankEl.textContent = String(newRank);
            rankEl.setAttribute('aria-label', `${newRank}위`);
        }
    });
    
    updateBestOrderButtonStates();

    try {
        if (window.dbOps && window.dbOps.saveSettings) {
            await window.dbOps.saveSettings(window.userSettings);
        }
    } catch (e) {
        console.error('Best 순서 저장 실패:', e);
    }
}

function updateBestOrderButtonStates() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;

    const items = container.querySelectorAll('.best-meal-item');
    items.forEach((item, index) => {
        const upBtn = item.querySelector('.best-order-up-btn');
        const downBtn = item.querySelector('.best-order-down-btn');
        if (upBtn) upBtn.disabled = index === 0;
        if (downBtn) downBtn.disabled = index === items.length - 1;
    });
}

function moveBestMealItem(item, delta) {
    const container = document.getElementById('bestMealsContainer');
    if (!container || !item) return;

    const items = Array.from(container.querySelectorAll('.best-meal-item'));
    const index = items.indexOf(item);
    const targetIndex = index + delta;
    if (index === -1 || targetIndex < 0 || targetIndex >= items.length) return;

    const targetItem = items[targetIndex];
    if (delta < 0) {
        container.insertBefore(item, targetItem);
    } else {
        container.insertBefore(targetItem, item);
    }

    updateBestOrder();
}

function setupBestOrderControls() {
    const container = document.getElementById('bestMealsContainer');
    if (!container) return;

    container.querySelectorAll('.best-meal-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.best-order-btn')) return;

            const date = item.getAttribute('data-date');
            const slotId = item.getAttribute('data-slot-id');
            const mealId = item.getAttribute('data-meal-id');
            if (date && slotId && mealId) {
                window.openModal(date, slotId, mealId);
            }
        });

        const upBtn = item.querySelector('.best-order-up-btn');
        const downBtn = item.querySelector('.best-order-down-btn');

        upBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            moveBestMealItem(item, -1);
        });

        downBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            moveBestMealItem(item, 1);
        });
    });

    updateBestOrderButtonStates();
}

// 베스트 공유 상태 확인
async function checkBestShareStatus(periodType, periodText) {
    if (!window.currentUser) return null;
    
    // 공유 캐시에서 해당 기간의 베스트 공유 찾기
    const bestShare = getSharedPhotos().find(photo => 
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
    let periodType = ''; // '최근1주', '주간', '월간', '연간'
    let periodText = '';
    
    // 현재 기간의 베스트 메뉴 가져오기
    if (state.dashboardMode === '7d') {
        const { start, end } = getRecentWeekRangeForBest();
        meals = getRangeBestMeals(start, end, 4);
        periodType = '최근1주';
        periodText = `${formatDateWithDay(start)} ~ ${formatDateWithDay(end)}`;
    } else if (state.dashboardMode === 'week') {
        meals = getWeekBestMeals(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek, 4);
        periodType = '주간';
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodText = getWeekDisplayLabel(start, end);
    } else if (state.dashboardMode === 'month') {
        const [y, m] = state.selectedMonth.split('-').map(Number);
        meals = getMonthBestMeals(y, m);
        periodType = '월간';
        periodText = `${y}년 ${m}월`;
    } else if (state.dashboardMode === 'year') {
        const year = state.selectedYearForYear || new Date().getFullYear();
        meals = getYearBestMeals(year);
        periodType = '연간';
        periodText = `${year}년`;
    } else {
        showToast('최근1주, 주간, 월간, 연간 모드에서만 공유할 수 있습니다.', 'error');
        return;
    }

    // 기간 경과 조건 미충족 시 안내 팝업 표시 후 종료 (주간 4일 이상, 월간 10일 이상, 연간 4월 1일 이후)
    const periodAllowance = getBestSharePeriodAllowance();
    if (!periodAllowance.allowed) {
        showBestSharePeriodNotice(periodAllowance.message || '해당 기간이 더 경과된 후에 베스트 공유가 가능해요.');
        return;
    }
    
    // 공유 상태 확인
    const existingShare = await checkBestShareStatus(periodType, periodText);
    const isShared = !!existingShare;
    
    // 베스트 탭과 동일한 필터·정렬 적용 후 1~3위만 사용 (미리보기와 화면 목록 일치)
    const periodKey = getBestPeriodKey();
    const isYearModeForShare = state.dashboardMode === 'year' || state.dashboardMode === 'custom';
    const minRatingForShare = isYearModeForShare ? 5 : 4;
    const filteredForShare = isYearModeForShare
        ? meals.filter(m => m && m.rating && parseInt(m.rating) === 5)
        : meals.filter(m => m && m.rating && parseInt(m.rating) >= minRatingForShare);
    const savedOrder = (window.userSettings && window.userSettings.bestMeals ? window.userSettings.bestMeals[periodKey] : null) || [];
    const sortedForShare = [...filteredForShare].sort((a, b) => {
        const aRating = a.rating ? parseInt(a.rating) : 0;
        const bRating = b.rating ? parseInt(b.rating) : 0;
        const aIndex = savedOrder.indexOf(a.id);
        const bIndex = savedOrder.indexOf(b.id);
        const isWeekMode = state.dashboardMode === '7d' || state.dashboardMode === 'week';
        if (isWeekMode) {
            if (aRating !== bRating) return bRating - aRating;
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            if (a.date && b.date) return b.date.localeCompare(a.date);
            return 0;
        }
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        if (bRating !== aRating) return bRating - aRating;
        if (a.date && b.date) return b.date.localeCompare(a.date);
        return 0;
    });
    const top3Meals = sortedForShare.slice(0, 3);
    
    if (top3Meals.length === 0 && !isShared) {
        showToast('공유할 베스트 메뉴가 없습니다.', 'error');
        return;
    }
    
    const userNickname = window.userSettings?.profile?.nickname || '익명';

    // 일간 공유와 동일 Soft Mint 캡처 (좌측 썸네일·헤더 A·코멘트 제외)
    if (document.fonts?.check && !document.fonts.check('1em Fredoka')) {
        const link = document.createElement('link');
        link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;500;600;700&display=swap';
        link.rel = 'stylesheet';
        document.head.appendChild(link);
    }

    preview.innerHTML = buildBestShareCaptureHtml(top3Meals, {
        userNickname,
        periodType,
        periodText
    });
    scheduleLucideIcons(preview);

    lockBodyScroll('bestShareModal');
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
        // 수정 모드 속성 제거
        submitBtn.removeAttribute('data-edit-mode');
        submitBtn.removeAttribute('data-photo-url');
        
        applyBestShareSubmitVariant(isShared ? 'unshare' : 'default');
    }
}

// 베스트 공유 모달 닫기
export function closeShareBestModal() {
    const modal = document.getElementById('bestShareModal');
    if (modal) {
        modal.classList.add('hidden');
        unlockBodyScroll('bestShareModal');
    }
}

// 베스트 공유 기간 안내 팝업 표시 (토스트 대신 확인 버튼 팝업)
export function showBestSharePeriodNotice(message) {
    const modal = document.getElementById('bestSharePeriodNoticeModal');
    const messageEl = document.getElementById('bestSharePeriodNoticeMessage');
    if (modal && messageEl) {
        messageEl.textContent = message || '해당 기간이 더 경과된 후에 베스트 공유가 가능해요.';
        lockBodyScroll('bestSharePeriodNotice');
        modal.classList.remove('hidden');
    }
}

// 베스트 공유 기간 안내 팝업 닫기
export function closeBestSharePeriodNotice() {
    const modal = document.getElementById('bestSharePeriodNoticeModal');
    if (modal) {
        modal.classList.add('hidden');
        unlockBodyScroll('bestSharePeriodNotice');
    }
}

// 베스트 공유 수정 모달 열기 (photoUrl로 찾기)
export async function openEditBestShareModal(photoUrl) {
    if (!photoUrl) {
        showToast('베스트 공유를 찾을 수 없습니다.', 'error');
        return;
    }
    
    // 공유 캐시에서 해당 photoUrl의 베스트 공유 찾기
    const bestShare = getSharedPhotos().find(photo => 
        photo.type === 'best' && 
        (photo.photoUrl === photoUrl || photo.photoUrl?.includes(photoUrl) || photoUrl?.includes(photo.photoUrl))
    );
    
    if (!bestShare) {
        showToast('베스트 공유를 찾을 수 없습니다.', 'error');
        return;
    }
    
    const modal = document.getElementById('bestShareModal');
    const preview = document.getElementById('bestSharePreview');
    if (!modal || !preview) return;
    
    // 베스트 공유 데이터에서 기간 정보 가져오기
    const periodType = bestShare.periodType || '';
    const periodText = bestShare.periodText || '';
    
    // 기간 정보로 dashboardMode 설정 (필요한 경우)
    // 하지만 이미 공유된 것이므로 기간 정보만 표시하면 됨
    
    // 사용자 닉네임 가져오기
    const userNickname = bestShare.userNickname || window.userSettings?.profile?.nickname || '익명';
    
    // 공유 모드와 동일한 형식으로 미리보기 표시 (기존 이미지 사용)
    const existingImageHtml = bestShare.photoUrl ? `
        <div id="bestScreenshotContainer" style="background: white; padding: 16px; max-width: 420px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="text-align: center;">
                <img src="${bestShare.photoUrl}" style="max-width: 100%; height: auto; display: block; margin: 0 auto;" alt="베스트 공유 이미지">
            </div>
        </div>
    ` : '<div style="text-align: center; padding: 40px; color: #94a3b8;">이미지를 불러올 수 없습니다.</div>';
    
    preview.innerHTML = existingImageHtml;
    
    // 모달 열기
    lockBodyScroll('bestShareModal');
    modal.classList.remove('hidden');
    
    // Comment 초기화 또는 기존 코멘트 표시
    const commentInput = document.getElementById('bestShareComment');
    if (commentInput) {
        commentInput.value = bestShare.comment || '';
    }
    
    // 공유 버튼 텍스트 업데이트 (수정 모드)
    const submitBtn = document.getElementById('bestShareSubmitBtn');
    if (submitBtn) {
        applyBestShareSubmitVariant('edit');
        // 수정 모드임을 표시하기 위한 데이터 속성 추가
        submitBtn.setAttribute('data-edit-mode', 'true');
        submitBtn.setAttribute('data-photo-url', photoUrl);
    }
}

// 베스트를 피드에 공유하기 (토글 방식)
export async function shareBestToFeed() {
    const preview = document.getElementById('bestScreenshotContainer');
    const commentInput = document.getElementById('bestShareComment');
    const submitBtn = document.getElementById('bestShareSubmitBtn');
    
    if (!commentInput) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (!isDemoUser(window.currentUser) && !isUserSettingsReadyForContentWrites(window.userSettings)) {
        showToast('약관 동의와 프로필(닉네임) 설정을 완료한 뒤 이용할 수 있습니다.', 'error');
        return;
    }
    
    const comment = commentInput.value.trim();
    
    // 수정 모드 확인
    const isEditMode = submitBtn && submitBtn.getAttribute('data-edit-mode') === 'true';
    const editPhotoUrl = isEditMode ? submitBtn.getAttribute('data-photo-url') : null;
    
    if (isEditMode && editPhotoUrl) {
        // 수정 모드: 코멘트만 업데이트
        if (submitBtn) {
            submitBtn.disabled = true;
            setBestShareSubmitEditing(true);
        }
        
        try {
            // Firestore에서 해당 베스트 공유 문서 찾아서 업데이트
            const { collection, query, where, getDocs, updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js");
            const { db: firestoreDb, appId } = await import('../firebase.js');
            const sharedColl = collection(firestoreDb, 'artifacts', appId, 'sharedPhotos');
            
            // photoUrl로 문서 찾기 (유연한 매칭)
            const q = query(sharedColl, where('userId', '==', window.currentUser.uid), where('type', '==', 'best'));
            const querySnapshot = await getDocs(q);
            
            let foundDoc = null;
            querySnapshot.forEach((docSnapshot) => {
                const data = docSnapshot.data();
                if (data.photoUrl === editPhotoUrl || 
                    data.photoUrl?.includes(editPhotoUrl) || 
                    editPhotoUrl?.includes(data.photoUrl)) {
                    foundDoc = docSnapshot;
                }
            });
            
            if (foundDoc) {
                // 코멘트만 업데이트
                await updateDoc(doc(sharedColl, foundDoc.id), {
                    comment: comment
                });
                
                // getSharedPhotos()도 업데이트
                if (getSharedPhotos()) {
                    const shareIndex = getSharedPhotos().findIndex(photo => 
                        photo.type === 'best' && 
                        (photo.photoUrl === editPhotoUrl || 
                         photo.photoUrl?.includes(editPhotoUrl) || 
                         editPhotoUrl?.includes(photo.photoUrl))
                    );
                    if (shareIndex !== -1) {
                        getSharedPhotos()[shareIndex].comment = comment;
                    }
                }
                
                showToast('코멘트가 수정되었습니다.', 'success');
                closeShareBestModal();
                
                // 갤러리/피드 새로고침
                if (appState.currentTab === 'gallery') {
                    renderGallery();
                } else if (appState.currentTab === 'feed') {
                    const { renderFeed } = await import('../render/index.js');
                    renderFeed();
                }
            } else {
                showToast('베스트 공유를 찾을 수 없습니다.', 'error');
            }
        } catch (e) {
            console.error('베스트 공유 수정 실패:', e);
            showToast('코멘트 수정 중 오류가 발생했습니다.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                applyBestShareSubmitVariant('edit');
            }
        }
        return;
    }
    
    // 일반 공유 모드
    if (!preview) return;
    
    // 베스트 공유 데이터 생성
    const state = appState;
    let periodType = '';
    let periodText = '';
    
    if (state.dashboardMode === '7d') {
        periodType = '최근1주';
        const { start, end } = getRecentWeekRangeForBest();
        periodText = `${formatDateWithDay(start)} ~ ${formatDateWithDay(end)}`;
    } else if (state.dashboardMode === 'week') {
        periodType = '주간';
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        periodText = getWeekDisplayLabel(start, end);
    } else if (state.dashboardMode === 'month') {
        periodType = '월간';
        const [y, m] = state.selectedMonth.split('-').map(Number);
        periodText = `${y}년 ${m}월`;
    } else if (state.dashboardMode === 'year') {
        periodType = '연간';
        const year = state.selectedYearForYear || new Date().getFullYear();
        periodText = `${year}년`;
    }
    
    // 공유 상태 확인
    const existingShare = await checkBestShareStatus(periodType, periodText);
    
    if (existingShare) {
        const photoUrlToRemove = existingShare.photoUrl;
        const prevPeriodType = existingShare.periodType;
        const prevPeriodText = existingShare.periodText;
        closeShareBestModal();
        showToast('공유가 취소되었습니다.', 'success');
        unshareWithOptimisticUpdate({
            photos: [photoUrlToRemove],
            shareType: 'best',
            matches: (p) =>
                p.type === 'best' &&
                p.periodType === prevPeriodType &&
                p.periodText === prevPeriodText &&
                p.userId === window.currentUser.uid,
            onChange: () => {
                renderBestMeals();
                if (appState.currentTab === 'gallery') renderGallery();
            }
        });
        return;
    }
    
    // 공유되지 않은 경우: 공유하기
    const bestShareModal = document.getElementById('bestShareModal');
    const bestShareSpinner = bestShareModal?.querySelector('#bestShareLoadingOverlay');
    if (bestShareSpinner) bestShareSpinner.classList.remove('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        setBestShareSubmitLoading(true);
    }
    // 스피너가 화면에 그려진 뒤 무거운 작업 진행
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 50));

    try {
        const screenshotContainer = preview.querySelector('#bestScreenshotContainer');
        const targetElement =
            screenshotContainer?.querySelector('.best-share-capture__sheet') ||
            screenshotContainer ||
            preview;

        await document.fonts.ready;
        let fontCSS = '';
        try {
            const fredokaRes = await fetch('https://fonts.googleapis.com/css2?family=Fredoka:wght@600&display=swap');
            fontCSS = await fredokaRes.text();
        } catch (e) { console.warn('폰트 CSS 로드 실패:', e); }

        // 유령 캡처: 화면 밖에 복제본을 만들어 모달/transform 간섭 없이 정사이즈 캡처
        const canvas = await captureWithGhostStrategy(targetElement, {
            captureWidth: 420,
            // html2canvas 폴백 전용 — 클론 문서 폰트 주입 (snapdom 은 embedFonts 로 처리)
            onclone: (clonedDoc) => {
                if (fontCSS) {
                    const style = clonedDoc.createElement('style');
                    style.textContent = fontCSS;
                    clonedDoc.head.appendChild(style);
                }
            }
        });
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
        
        // Firebase Storage에 업로드
        const base64Image = canvas.toDataURL('image/png');
        const { uploadBase64ToStorage } = await import('../utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, window.currentUser.uid, `best_${periodType}_${periodText.replace(/\s+/g, '_')}`, 1024);
        
        const userProfile = window.userSettings?.profile || {};
        
        const bestShareData = {
            id: 'pending-' + Date.now(),
            photoUrl,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            userPhotoUrl: userProfile.photoUrl || null,
            type: 'best',
            periodType,
            periodText,
            timestamp: new Date().toISOString(),
            entryId: null,
            comment: comment || ''
        };

        upsertSharedPhoto(bestShareData, (p) =>
            p.type === 'best' && p.periodType === periodType && p.periodText === periodText && p.userId === window.currentUser.uid
        );

        showToast('베스트가 피드에 공유되었습니다!', 'success');
        closeShareBestModal();
        renderBestMeals();
        if (appState.currentTab === 'gallery') renderGallery();

        const { callableFunctions } = await import('../firebase.js');
        callableFunctions.createBestShare({
            photoUrl,
            periodType,
            periodText,
            comment
        }).then((result) => {
            const serverData = result.data;
            const idx = getSharedPhotos().findIndex(p => p.id === bestShareData.id || (p.type === 'best' && p.periodType === periodType && p.periodText === periodText && p.userId === window.currentUser.uid && p.photoUrl === photoUrl));
            if (idx !== -1) {
                getSharedPhotos()[idx] = serverData;
                if (appState.currentTab === 'gallery') renderGallery();
            }
        }).catch((e) => {
            console.error('베스트 공유 서버 반영 실패:', e);
            if (getSharedPhotos()) {
                setSharedPhotos(getSharedPhotos().filter(p =>
                    !(p.type === 'best' && p.periodType === periodType && p.periodText === periodText && p.userId === window.currentUser.uid)
                ));
                renderBestMeals();
                if (appState.currentTab === 'gallery') renderGallery();
            }
            showToast(e?.message || e?.details || '공유 반영에 실패했습니다. 다시 시도해 주세요.', 'error');
        });
    } catch (e) {
        console.error('베스트 공유 실패:', e);
        const errorMessage = e.message || e.details || '공유 중 오류가 발생했습니다.';
        showToast(errorMessage, 'error');
    } finally {
        const modal = document.getElementById('bestShareModal');
        const spinner = modal?.querySelector('#bestShareLoadingOverlay');
        if (spinner) spinner.classList.add('hidden');
        if (submitBtn) {
            submitBtn.disabled = false;
            applyBestShareSubmitVariant('default');
        }
    }
}

