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
    /** fetch/Firestore 등이 끊김 계열로 실패했을 때 true (navigator.onLine 과 무관하게 설정) */
    localNetworkForcedOffline: false,
    tempSettings: null,
    
    // UI 상태
    /** 타임라인은 일간(page)만 사용 — 전체(list) 스크롤 모드는 제거됨 */
    viewMode: 'page',
    currentTab: 'timeline',
    pageDate: new Date(),
    galleryFilterUserId: null, // 앨범 탭에서 필터링된 사용자 ID
    galleryFilterPostId: null,  // 알림에서 클릭 시 해당 게시물만 보기
    galleryFilterTab: 'moment',  // 사용자 프로필 뷰에서 탭: 'moment' | 'board' (모먼트 | 밀톡)
    /** 사용자 프로필 모먼트 그리드: 처음 3×5셀(15게시물), 더보기마다 +15 (클라이언트 슬라이스) */
    galleryUserProfileMomentVisiblePostCount: 15,
    /** 프로필 모먼트: 누적 sharedPhotos 문서 (null이면 다음 render에서 첫 페이지 로드) */
    galleryUserProfileSharedDocs: null,
    /** 다음 페이지용 Firestore 마지막 문서 스냅샷 */
    galleryUserProfileSharedLastSnap: null,
    galleryUserProfileSharedHasMore: false,
    galleryUserProfileSharedForUserId: null,
    /** 프로필 모먼트: 페이지네이션·트림 후 커서 정합용 (문서 id → QueryDocumentSnapshot), 사용자 전환 시 새 Map */
    galleryUserProfileSharedDocSnaps: null,
    /** 모먼트 사용자 프로필에서 게시글 상세를 연 경우: 뒤로가기 시 갤러리 목록으로 복귀 */
    boardDetailOpenedFromGallery: false,
    galleryTraceFilter: null, // 앨범 흔적 필터: null | 'like' | 'comment' | 'bookmark'
    /** 모먼트 검색 팝업 적용 중 */
    gallerySearchActive: false,
    gallerySearchKeyword: '',
    gallerySearchDateRange: null, // { start, end } YYYY-MM-DD
    boardTraceFilter: null,   // 밀톡 흔적 필터: null | 'like' | 'comment' | 'bookmark'
    /** 라운지 게시판·공지 검색 팝업 적용 중 */
    boardSearchActive: false,
    boardSearchKeyword: '',
    boardSearchDateRange: null, // { start, end } YYYY-MM-DD
    /** 라운지 상단 서브탭: 'feed' 밀톡 | 'board' 사용자 게시판 | 'notice' 관리자 공지 */
    boardListSubTab: 'board',
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
    /** photos와 동일 인덱스 — { takenAt: ISO string | null } */
    currentPhotoMeta: [],
    currentPhotoFiles: [], // 실제 파일 객체 (Storage 업로드용)
    sharedPhotos: [], // 현재 공유된 사진 목록 (모달 내)
    originalSharedPhotos: [], // 모달 열 때의 원본 공유 사진 목록 (삭제 추적용)
    wantsToShare: false, // 공유를 원하는지 여부
    currentRating: null,
    currentSatiety: null,
    /** 기록 모달: 만족도·포만감 게이지 사용 여부 (식사 슬롯 vs 간식 슬롯 각각) */
    entryGaugeRatingOnMain: false,
    entryGaugeRatingOnSnack: false,
    entryGaugeSatietyOnMain: false,
    entryGaugeSatietyOnSnack: false,
    /** 기록 모달: 식사/간식 각각 시간 항목 on */
    entryTimeOnMain: false,
    entryTimeOnSnack: false,
    /** 기록 시트 통합: meal | snack (openModal에서 슬롯 기준 설정) */
    entryFormMode: 'meal',
    /** 신규 기록 모달: 시간 자동 채우기 1회 제한용 */
    entryMealClockDidSeedModalOpenMain: false,
    entryMealClockDidSeedModalOpenSnack: false,
    entryMealClockDidApplyPhotoExifMain: false,
    entryMealClockDidApplyPhotoExifSnack: false,
    /** 시간 off일 때 찍어둔 사진 첫 EXIF(HH:mm) — 시간 on 시 1회 반영 */
    entryMealClockPendingExifHhmmMain: null,
    entryMealClockPendingExifHhmmSnack: null,
    /** 기록 시간 입력 출처: 'now' | 'photo' | 'manual' | null */
    entryMealClockSourceMain: null,
    entryMealClockSourceSnack: null,

    /** 하루 기록 모달 */
    dailyJournalEditingDate: '',
    dailyJournalPhotos: [],
    dailyJournalWantsToShare: false,
    dailyJournalPhotoAspectRatio: '1:1',
    dailyJournalWeightEnabled: false,
    dailyJournalBloodSugarEnabled: false,
    dailyJournalWeightRecords: [],
    dailyJournalBloodSugarRecords: [],
    
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
    analysisType: 'main', // 'best', 'main', 'snack', 'health'
    mealdangView: 'analysis', // 'analysis' | 'comment' — 밀당 헤더 탭
    
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



