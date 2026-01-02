// 전역 상태 관리
import { DEFAULT_USER_SETTINGS } from './constants.js';

// 전역 상태 초기화
window.mealHistory = [];
window.currentUser = null;
window.loadedDates = [];
window.currentDetailChart = null;
window.emailAuthMode = 'login';
window.userSettings = { ...DEFAULT_USER_SETTINGS };

// 앱 상태
export const appState = {
    dataUnsubscribe: null,
    settingsUnsubscribe: null,
    sharedPhotosUnsubscribe: null,
    tempSettings: null,
    viewMode: 'list',
    currentTab: 'timeline',
    pageDate: new Date(),
    currentPhotos: [],
    currentEditingId: null,
    currentEditingDate: "",
    currentEditingSlotId: "",
    currentRating: 3,
    currentSatiety: 3,
    dashboardMode: '7d',
    customStartDate: (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })(),
    customEndDate: new Date(),
    selectedMonth: new Date().toISOString().slice(0, 7),
    touchStartX: 0,
    touchEndX: 0
};

export function getState() {
    return appState;
}



