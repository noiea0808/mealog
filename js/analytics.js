// analytics 모듈 인덱스 파일 - 모든 analytics 관련 함수들을 재export
// 이 파일은 모든 analytics 관련 함수들을 단일 진입점으로 제공합니다.

// Charts 관련 함수들
export { renderProportionChart, openDetailModal, closeDetailModal } from './analytics/charts.js';

// Dashboard 관련 함수들
export { 
    getDashboardData, 
    updateDashboard, 
    setDashboardMode, 
    setAnalysisType,
    updateCustomDates,
    updateSelectedMonth,
    updateSelectedWeek,
    changeWeek,
    changeMonth,
    changeYear,
    changeRecentWeek,
    navigatePeriod
} from './analytics/dashboard.js';

// Insight 관련 함수들
export {
    showInsightPage,
    setupInsightBubbleClick,
    openCharacterSelectModal,
    closeCharacterSelectModal,
    selectInsightCharacter,
    updateInsightComment,
    generateInsightComment,
    getCurrentCharacter,
    getInsightCharacters,
    openShareInsightModal,
    closeShareInsightModal,
    shareInsightToFeed
} from './analytics/insight.js';

// Best Share 관련 함수들
export {
    renderBestMeals,
    openShareBestModal,
    closeShareBestModal,
    shareBestToFeed
} from './analytics/best-share.js';

// Date utils 관련 함수들 (필요한 경우 export)
export {
    getWeekRange,
    getWeeksInMonth,
    getCurrentWeekInMonth,
    getDayName,
    formatDateWithDay
} from './analytics/date-utils.js';

// window 객체에 getDashboardData 추가 (다른 모듈에서 사용)
import { getDashboardData } from './analytics/dashboard.js';
window.getDashboardData = getDashboardData;
