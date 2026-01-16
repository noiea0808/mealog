// 상수 정의
export const DEFAULT_ICONS = ['🐻', '🐰', '🐱', '🐶', '🦊', '🦁', '🐼', '🐨'];

export const SLOTS = [
    { id: 'pre_morning', label: '아침 전 간식', type: 'snack' },
    { id: 'morning', label: '아침', type: 'main' },
    { id: 'snack1', label: '오전 간식', type: 'snack' },
    { id: 'lunch', label: '점심', type: 'main' },
    { id: 'snack2', label: '오후 간식', type: 'snack' },
    { id: 'dinner', label: '저녁', type: 'main' },
    { id: 'night', label: '야식', type: 'snack' }
];

export const SLOT_STYLES = {
    'morning': { iconBg: 'bg-orange-50', iconText: 'text-orange-500', border: 'border-orange-200', text: 'text-orange-600' },
    'lunch': { iconBg: 'bg-emerald-50', iconText: 'text-emerald-600', border: 'border-emerald-200', text: 'text-emerald-600' },
    'dinner': { iconBg: 'bg-indigo-50', iconText: 'text-indigo-600', border: 'border-indigo-200', text: 'text-indigo-600' },
    'default': { iconBg: 'bg-slate-50', iconText: 'text-slate-400', border: 'border-slate-100', text: 'text-slate-400' }
};

export const VIBRANT_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316', '#6366f1', '#14b8a6'];
export const RATING_GRADIENT = ['#ecfdf5', '#d1fae5', '#6ee7b7', '#34d399', '#059669'];

export const SATIETY_DATA = [
    { val: 1, icon: 'fa-face-dizzy', label: '배고픔', color: 'text-slate-400', chartColor: '#94a3b8' },
    { val: 2, icon: 'fa-face-frown-open', label: '약간 허기', color: 'text-blue-400', chartColor: '#60a5fa' },
    { val: 3, icon: 'fa-face-smile', label: '적당함', color: 'text-emerald-500', chartColor: '#10b981' },
    { val: 4, icon: 'fa-face-grin', label: '배부름', color: 'text-orange-400', chartColor: '#fb923c' },
    { val: 5, icon: 'fa-face-grin-beam-sweat', label: '과식', color: 'text-red-400', chartColor: '#f87171' }
];

// 약관 버전 (약관 업데이트 시 버전을 올려서 기존 사용자에게 재동의 요청)
export const CURRENT_TERMS_VERSION = '1.0';

export const DEFAULT_USER_SETTINGS = {
    profile: { icon: '🐻', nickname: '게스트', bio: '' },
    tags: {
        mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
        withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
        category: ['한식', '양식', '일식', '중식', '분식', '카페'],
        snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타']
    },
    subTags: {
        place: [{ text: '우리집', parent: '집밥' }, { text: '회사 식당', parent: '구내식당' }, { text: '스타벅스', parent: '배달/포장' }],
        menu: [{ text: '김치찌개', parent: '한식' }, { text: '아메리카노', parent: '카페' }, { text: '샌드위치', parent: '양식' }],
        people: [{ text: '엄마', parent: '가족' }, { text: '팀장님', parent: '직장동료' }],
        snack: []
    },
    favoriteSubTags: {
        mealType: {}, // { '집밥': ['우리집', '할머니집', ...], '외식': [...], ... }
        category: {}, // { '한식': ['김치찌개', '된장찌개', ...], '양식': [...], ... }
        withWhom: {}, // { '가족': ['엄마', '아빠', ...], '친구': [...], ... }
        snackType: {} // { '커피': ['아메리카노', '라떼', ...], '베이커리': [...], ... }
    },
    // 약관 동의 및 첫 로그인 관련
    termsAgreed: false,
    termsAgreedAt: null,
    termsVersion: null, // 동의한 약관 버전
    isFirstLogin: true,
    onboardingCompleted: false
};

export const DEFAULT_SUB_TAGS = {
    place: [{ text: '우리집', parent: '집밥' }, { text: '회사 식당', parent: '구내식당' }, { text: '스타벅스', parent: '배달/포장' }],
    menu: [{ text: '김치찌개', parent: '한식' }, { text: '아메리카노', parent: '카페' }, { text: '샌드위치', parent: '양식' }],
    people: [{ text: '엄마', parent: '가족' }, { text: '팀장님', parent: '직장동료' }],
    snack: []
};



