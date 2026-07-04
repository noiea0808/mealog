// 상수 정의
/** 스마트폰 앱 아이콘(assets/icon-only.png) - 밀당 참견 등에서 MEALOG 캐릭터 아이콘으로 사용 */
export const MEALOG_ICON_URL = 'assets/icon-only.png';

/** 일간·베스트·인사이트 공유 캡처 헤더(타이틀·날짜) — 앨범·모먼트 휠과 동일 손글씨 스택 (style font-family 인라인용) */
export const MEALOG_SHARE_CAPTURE_HEADER_FONT_FAMILY =
    "'나눔손글씨 가람연꽃', 'Nanum Garam Yeonkot', 'Nanum Pen Script', cursive";

/** 캡처 헤더 날짜 줄 — 기본 12px에서 2단계 확대 */
export const MEALOG_SHARE_CAPTURE_HEADER_DATE_FONT_SIZE = '16px';

/** 캡처 헤더 타이틀 줄(닉네임의 하루 기록 등) — 기본 15px에서 2단계 확대, 진한 색·볼드 */
export const MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_SIZE = '19px';
export const MEALOG_SHARE_CAPTURE_HEADER_TITLE_COLOR = '#0f172a';
export const MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_WEIGHT = '700';

/** html2canvas 클론 문서용 @font-face — `css/style.css` 나눔손글씨 가람연꽃과 동일 소스 */
export const MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS = `@font-face{font-family:'나눔손글씨 가람연꽃';src:url('https://cdn.jsdelivr.net/gh/projectnoonnu/naverfont_04@1.0/Garam.woff') format('woff');font-weight:normal;font-style:normal;font-display:swap;}`;

/** 밀당 AI 코멘트(Gemini) — js/analytics/insight.js · functions callGemini 와 동기화 */
export const GEMINI_MEALDANG_MODEL = 'gemini-2.5-flash';
/** 목표: 입력 1,200~2,000 · 출력 150~300 · thinking 0~500 · 합계 1,500~2,800 */
export const GEMINI_MEALDANG_THINKING_BUDGET = 384;
export const GEMINI_MEALDANG_MAX_OUTPUT_TOKENS = 768;
export const GEMINI_MEALDANG_MEMO_MAX_CHARS = 350;
export const GEMINI_MEALDANG_COMMON_PERSONA_MAX_CHARS = 900;
export const GEMINI_MEALDANG_CHARACTER_PROMPT_MAX_CHARS = 700;

export const DEFAULT_ICONS = ['🐻', '🐰', '🐱', '🐶', '🦊', '🦁', '🐼', '🐨'];

/** 기록 입력 시트 — 식사·간식 사진 최대 장수 */
export const RECORD_MAX_PHOTOS = 5;

export const SLOTS = [
    { id: 'pre_morning', label: '아침 전 간식', type: 'snack' },
    { id: 'morning', label: '아침', type: 'main' },
    { id: 'snack1', label: '오전 간식', type: 'snack' },
    { id: 'lunch', label: '점심', type: 'main' },
    { id: 'snack2', label: '오후 간식', type: 'snack' },
    { id: 'dinner', label: '저녁', type: 'main' },
    { id: 'night', label: '야식', type: 'snack' }
];

/** 타임라인 하루 소감 슬롯 (meals 컬렉션과 별도, userSettings.dailyComments) */
export const DAILY_JOURNAL_SLOT = {
    id: 'daily_journal',
    label: '하루 기록',
    type: 'daily'
};

export const DAILY_JOURNAL_SLOT_STYLE = {
    iconBg: 'bg-slate-50',
    iconText: 'text-slate-400',
    border: 'border-slate-100',
    text: 'text-slate-400',
    listLeft: 'border-l-[4px] border-l-slate-400/60'
};

export const SLOT_STYLES = {
    'morning': { iconBg: 'bg-amber-50', iconText: 'text-amber-600', border: 'border-amber-200', text: 'text-amber-600', listLeft: 'border-l-[4px] border-l-amber-600/60' },
    'lunch': { iconBg: 'bg-emerald-50', iconText: 'text-emerald-600', border: 'border-emerald-200', text: 'text-emerald-600', listLeft: 'border-l-[4px] border-l-emerald-600/60' },
    'dinner': { iconBg: 'bg-sky-50', iconText: 'text-sky-600', border: 'border-sky-200', text: 'text-sky-600', listLeft: 'border-l-[4px] border-l-sky-600/60' },
    'default': { iconBg: 'bg-slate-50', iconText: 'text-slate-400', border: 'border-slate-100', text: 'text-slate-400', listLeft: 'border-l-[4px] border-l-slate-400/60' }
};

export const VIBRANT_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316', '#6366f1', '#14b8a6'];
/** 분석 탭 누적 막대(식사방식/메뉴/함께한 즐거움) 좌→우 빈도순 그라데이션: 빨강→주황(1개)→호박→녹색→청록→남색 */
export const CUMULATIVE_BAR_GRADIENT = ['#F06292', '#FF9800', '#FFC107', '#9CCC65', '#66BB6A', '#26C6DA', '#5C6BC0'];
/** 만족도·포만감 5단계용: 1→5 순서로 남색→청록→녹색→호박→핑크 (한입만/1점=남색, 과식/5점=핑크) */
export const RATING_SATIETY_GRADIENT = ['#5C6BC0', '#26C6DA', '#66BB6A', '#FFC107', '#F06292'];
export const RATING_GRADIENT = RATING_SATIETY_GRADIENT;

/** 타임라인 간식 표시: localStorage 키 — 값은 'tags' | 'cards' | 'list' */
export const SNACK_TIMELINE_VIEW_STORAGE_KEY = 'mealog_snack_timeline_view';

/** 타임라인 본식(끼니) 표시: localStorage 키 — 값은 'cards' | 'list' */
export const MEAL_TIMELINE_VIEW_STORAGE_KEY = 'mealog_meal_timeline_view';

export const SATIETY_DATA = [
    { val: 1, icon: 'fa-cookie-bite', label: '한입만', color: 'text-slate-400', chartColor: '#5C6BC0' },
    { val: 2, icon: 'fa-face-smile-wink', label: '가볍게', color: 'text-blue-400', chartColor: '#26C6DA' },
    { val: 3, icon: 'fa-face-smile', label: '적당히', color: 'text-emerald-500', chartColor: '#66BB6A' },
    { val: 4, icon: 'fa-face-grin', label: '든든하게', color: 'text-orange-400', chartColor: '#FFC107' },
    { val: 5, icon: 'fa-face-grin-beam-sweat', label: '과식', color: 'text-red-400', chartColor: '#F06292' }
];

// 약관 버전 (약관 업데이트 시 버전을 올려서 기존 사용자에게 재동의 요청)
export const CURRENT_TERMS_VERSION = '1.0';

export const DEFAULT_USER_SETTINGS = {
    profile: {
        // iconType: 'text' | 'emoji' | 'photo'
        iconType: 'text',
        icon: null,
        photoUrl: null,
        nickname: '게스트',
        bio: '',
        // 신규 가입 시 필수 입력
        birthdate: '',
        lifestyle: '',
        /** 성별: 'male' | 'female' | null (선택 입력, 기가입자 강제 아님) */
        gender: null,
        // 생년월일 변경 제한 (가입 후 1회만 변경 가능)
        birthdateChangeCount: 0,
        birthdateChangedAt: null
    },
    // 프로필 완료 플래그 (닉네임 문자열에 의존하지 않기 위함)
    profileCompleted: false,
    profileCompletedAt: null,
    tags: {
        mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
        withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
        category: ['한식', '양식', '일식', '중식', '분식', '카페'],
        snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'],
        snackPlaceMain: ['집', '사무실', '카페']
    },
    subTags: {
        place: [
            { text: '우리집', parent: '집밥' },
            { text: '우리집', parent: '배달/포장' },
            { text: '회사 식당', parent: '구내식당' }
        ],
        menu: [{ text: '김치찌개', parent: '한식' }, { text: '아메리카노', parent: '카페' }, { text: '샌드위치', parent: '양식' }],
        people: [{ text: '엄마', parent: '가족' }, { text: '팀장님', parent: '직장동료' }],
        snack: []
    },
    favoriteSubTags: {
        mealType: {}, // { '집밥': ['우리집', '할머니집', ...], '외식': [...], ... }
        category: {}, // { '한식': ['김치찌개', '된장찌개', ...], '양식': [...], ... }
        withWhom: {}, // { '가족': ['엄마', '아빠', ...], '친구': [...], ... }
        snackType: {}, // { '커피': ['아메리카노', '라떼', ...], '베이커리': [...], ... }
        snackPlace: {} // { '집': [...], '사무실': [...], '카페': [...], ... }
    },
    // 약관 동의 및 첫 로그인 관련
    termsAgreed: false,
    termsAgreedAt: null,
    termsVersion: null, // 동의한 약관 버전
    isFirstLogin: true,
    onboardingCompleted: false,
    // 토스트 메시지: 기본적으로 표시하지 않음
    showToast: false,
    /**
     * 푸시(FCM) 수신 여부 — 앱 내 알림(종)과 무관. false면 해당 종류 푸시는 Functions에서 발송 안 함.
     * master: 전체 끄기 시 하위 항목과 관계없이 푸시 없음.
     */
    pushPreferences: {
        master: true,
        momentComment: true,
        boardComment: true,
        mealTalk: true,
        adminDefault: true
    },
    /** 기록 모달: 만족도·포만감 다이얼 사용 여부 (식사·간식 각각 기억, 기본 끔) */
    entryModalGauges: {
        main: { ratingEnabled: false, satietyEnabled: false, timeEnabled: false },
        snack: { ratingEnabled: false, satietyEnabled: false, timeEnabled: false }
    },
    /** 기록 모달: 메인 태그 칩(빠른 입력) — 항목별·식사/간식별 기억 */
    entryModalQuickInput: {
        meal: { where: true, what: true, with: true },
        snack: { where: true, what: true, with: true },
    },
    /** 기록 모달: 상세 기록(누구와·만족도·포만감·시간) 항목별 on/off */
    entryModalDetailRecord: {
        main: { with: false, rating: false, satiety: false, time: false },
        snack: { with: false, rating: false, satiety: false, time: false },
    },
    /** 날짜별 하루 소감 — 값: string(구) | { comment, photos[], photoAspectRatio } */
    dailyComments: {}
};

// 게시물 신고 사유 (id는 Firestore에 저장, label은 UI 표시)
export const REPORT_REASONS = [
    { id: 'spam', label: '스팸/홍보' },
    { id: 'hate', label: '혐오/혐오발언' },
    { id: 'inappropriate', label: '부적절한 콘텐츠' },
    { id: 'violence', label: '폭력/위험' },
    { id: 'harassment', label: '괴롭힘/협박' },
    { id: 'copyright', label: '저작권 침해' },
    { id: 'other', label: '기타' }
];

export const DEFAULT_SUB_TAGS = {
    place: [
        { text: '우리집', parent: '집밥' },
        { text: '우리집', parent: '배달/포장' },
        { text: '회사 식당', parent: '구내식당' }
    ],
    menu: [{ text: '김치찌개', parent: '한식' }, { text: '아메리카노', parent: '카페' }, { text: '샌드위치', parent: '양식' }],
    people: [{ text: '엄마', parent: '가족' }, { text: '팀장님', parent: '직장동료' }],
    snack: []
};



