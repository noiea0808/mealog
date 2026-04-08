/** 관리·테스트 계정 — 관리자 트렌드 통계·페이지 사용량 로깅에서 제외 (firestore.rules 와 목록 동기화) */
export const EXCLUDED_ANALYTICS_UID_LIST = [
    'kakao_4833862234',
    'IYRL3bfBhKUrwJM6tb8h4BVX8DF3',
    '4UDeI0Bts0gkwnnrt1WNRgjOQ5x2'
];

export const EXCLUDED_ANALYTICS_UIDS = new Set(EXCLUDED_ANALYTICS_UID_LIST);
