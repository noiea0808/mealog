// 전역 상태 관리
import { DEFAULT_USER_SETTINGS } from './constants.js';

// 로컬 타임존 날짜 문자열 변환 함수 (순환 참조 방지를 위해 여기서 직접 구현)
function getLocalMonthString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

// 앱 상태 - 모든 상태를 중앙에서 관리 (평면 구조 유지하여 기존 코드와 호환)
export const appState = {
    // 리스너 관리
    dataUnsubscribe: null,
    settingsUnsubscribe: null,
    statsUnsubscribe: null,
    notificationUnsubscribePost: null,
    notificationUnsubscribeBoard: null,
    notificationUnsubscribeFeed: null,
    notificationUnreadCount: 0,
    sharedPhotosFeedLastDoc: null,
    sharedPhotosFeedHasMore: false,
    sharedPhotosFeedPrefetchedAt: 0, // 모먼트 프리페치 시각 (ms), 캐시 유효성 판단용
    sharedPhotosFeedByUserLastDoc: null,
    sharedPhotosFeedByUserHasMore: false,
    galleryFeedNetworkError: false, // 모먼트 피드 로드 시 네트워크 단절 등으로 실패했을 때 true
    tempSettings: null,
    
    // UI 상태
    viewMode: 'list',
    currentTab: 'timeline',
    pageDate: new Date(),
    galleryFilterUserId: null, // 앨범 탭에서 필터링된 사용자 ID
    galleryFilterPostId: null,  // 알림에서 클릭 시 해당 게시물만 보기
    galleryFilterTab: 'moment',  // 사용자 프로필 뷰에서 탭: 'moment' | 'board' (모먼트 | 밀톡)
    /** 모먼트 사용자 프로필에서 게시글 상세를 연 경우: 뒤로가기 시 갤러리 목록으로 복귀 */
    boardDetailOpenedFromGallery: false,
    galleryTraceFilter: null, // 앨범 흔적 필터: null | 'like' | 'comment' | 'bookmark'
    boardTraceFilter: null,   // 밀톡 흔적 필터: null | 'like' | 'comment' | 'bookmark'
    /** 밀톡 상단 서브탭: 'feed' (별도 피드 예정) | 'board' 게시판 리스트 */
    boardListSubTab: 'feed',
    /** 피드 탭 타임라인 (세션 내 메모리, 게시 시 앞에 추가) */
    feedTimelinePosts: [],
    /** 더 오래된 밀톡 페이지 로드용 Firestore 커서(마지막으로 받은 배치의 가장 오래된 문서) */
    feedTimelineOldestCursor: null,
    feedTimelineHasMore: false,
    
    // 편집 상태 (모달 관련)
    currentEditingId: null,
    currentEditingDate: "",
    currentEditingSlotId: "",
    currentPhotos: [], // 미리보기용 원본 data URL(선택 직후) 또는 Storage URL; 업로드 시에만 압축
    currentPhotoFiles: [], // 실제 파일 객체 (Storage 업로드용)
    sharedPhotos: [], // 현재 공유된 사진 목록 (모달 내)
    originalSharedPhotos: [], // 모달 열 때의 원본 공유 사진 목록 (삭제 추적용)
    wantsToShare: false, // 공유를 원하는지 여부
    currentRating: 3,
    currentSatiety: 3,
    
    // 대시보드
    dashboardMode: '7d',
    customStartDate: (() => { const d = new Date(); d.setDate(d.getDate() - 7); return d; })(),
    customEndDate: new Date(),
    selectedMonth: getLocalMonthString(new Date()),
    selectedYear: new Date().getFullYear(),
    selectedYearForYear: new Date().getFullYear(), // 연간 모드용
    selectedMonthForWeek: new Date().getMonth() + 1,
    selectedWeek: 1,
    recentWeekStartDate: null, // 최근 1주 모드에서 사용하는 시작 날짜
    analysisType: 'best', // 'best', 'main', or 'snack'
    
    // UI 상호작용
    currentDetailChart: null,
    touchStartX: 0,
    touchEndX: 0,
    
    // 데이터 상태 (window.* 변수들을 여기로 통합)
    _data: {
        mealHistory: [],
        sharedPhotos: [], // 본인 공유 (타임라인 표시용)
        sharedPhotosFeed: [], // 갤러리/피드 페이지네이션 (10건씩)
        loadedDates: [],
        loadedMealsDateRange: null,
        dailyStats: null, // 트래커·대시보드용 일별 집계 (users/{uid}/config/stats)
    },
    
    // 인증 상태
    _auth: {
        currentUser: null,
        emailAuthMode: 'login',
    },
    
    // 설정 상태
    _settings: {
        userSettings: { ...DEFAULT_USER_SETTINGS },
    },
};

// 하위 호환성: window.* 변수를 appState의 getter/setter로 매핑
// 기존 코드가 window.*를 사용하더라도 appState를 참조하도록 함
Object.defineProperty(window, 'mealHistory', {
    get: () => appState._data.mealHistory,
    set: (value) => { appState._data.mealHistory = value; },
    configurable: true
});

Object.defineProperty(window, 'sharedPhotos', {
    get: () => appState._data.sharedPhotos,
    set: (value) => { appState._data.sharedPhotos = value; },
    configurable: true
});

Object.defineProperty(window, 'sharedPhotosFeed', {
    get: () => appState._data.sharedPhotosFeed,
    set: (value) => { appState._data.sharedPhotosFeed = value; },
    configurable: true
});

Object.defineProperty(window, 'currentUser', {
    get: () => appState._auth.currentUser,
    set: (value) => { appState._auth.currentUser = value; },
    configurable: true
});

Object.defineProperty(window, 'loadedDates', {
    get: () => appState._data.loadedDates,
    set: (value) => { appState._data.loadedDates = value; },
    configurable: true
});

Object.defineProperty(window, 'userSettings', {
    get: () => appState._settings.userSettings,
    set: (value) => { appState._settings.userSettings = value; },
    configurable: true
});

Object.defineProperty(window, 'emailAuthMode', {
    get: () => appState._auth.emailAuthMode,
    set: (value) => { appState._auth.emailAuthMode = value; },
    configurable: true
});

Object.defineProperty(window, 'loadedMealsDateRange', {
    get: () => appState._data.loadedMealsDateRange,
    set: (value) => { appState._data.loadedMealsDateRange = value; },
    configurable: true
});

Object.defineProperty(window, 'dailyStats', {
    get: () => appState._data.dailyStats,
    set: (value) => { appState._data.dailyStats = value; },
    configurable: true
});

Object.defineProperty(window, 'currentDetailChart', {
    get: () => appState.currentDetailChart,
    set: (value) => { appState.currentDetailChart = value; },
    configurable: true
});

export function getState() {
    return appState;
}



