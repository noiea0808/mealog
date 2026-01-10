// 전역 상태 관리
import { DEFAULT_USER_SETTINGS } from './constants.js';

// 전역 상태 초기화
window.mealHistory = [];
window.sharedPhotos = [];
window.currentUser = null;
window.loadedDates = [];
window.currentDetailChart = null;
window.emailAuthMode = 'login';
window.userSettings = { ...DEFAULT_USER_SETTINGS };
window.loadedMealsDateRange = null; // 로드된 데이터의 날짜 범위 { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }

// 앱 상태
export const appState = {
    dataUnsubscribe: null,
    settingsUnsubscribe: null,
    sharedPhotosUnsubscribe: null,
    tempSettings: null,
    viewMode: 'list',
    currentTab: 'timeline',
    pageDate: new Date(),
    currentPhotos: [], // 미리보기용 base64 URL 또는 Storage URL
    currentPhotoFiles: [], // 실제 파일 객체 (Storage 업로드용)
    sharedPhotos: [], // 현재 공유된 사진 목록
    originalSharedPhotos: [], // 모달 열 때의 원본 공유 사진 목록 (삭제 추적용)
    wantsToShare: false, // 공유를 원하는지 여부
    currentEditingId: null,
    currentEditingDate: "",
    currentEditingSlotId: "",
    currentRating: 3,
    currentSatiety: 3,
    dashboardMode: '7d',
    customStartDate: (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })(),
    customEndDate: new Date(),
    selectedMonth: new Date().toISOString().slice(0, 7),
    selectedYear: new Date().getFullYear(),
    selectedYearForYear: new Date().getFullYear(), // 연간 모드용
    selectedMonthForWeek: new Date().getMonth() + 1,
    selectedWeek: 1,
    recentWeekStartDate: null, // 최근 1주 모드에서 사용하는 시작 날짜
    analysisType: 'best', // 'best', 'main', or 'snack'
    touchStartX: 0,
    touchEndX: 0
};

export function getState() {
    return appState;
}



