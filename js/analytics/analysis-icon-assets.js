/**
 * 분석 Top 아이콘 — assets/analysis-icons/*.png URL 맵
 * (이전 data URI 임베드는 ~964KB라 밀당 진입 시 URL로 지연 로드)
 *
 * 재생성: node scripts/embed-analysis-icons.mjs
 * 크롭: python3 scripts/crop-analysis-icons-from-cyan.py
 */
const BASE = 'assets/analysis-icons';

const KEYS = [
    'how-building',
    'how-ellipsis',
    'how-home',
    'how-motorcycle',
    'how-skip',
    'how-utensils',
    'how-wine',
    'rating-1',
    'rating-2',
    'rating-3',
    'rating-4',
    'rating-5',
    'satiety-1',
    'satiety-2',
    'satiety-3',
    'satiety-4',
    'satiety-5',
    'snack-place-cafe',
    'snack-place-home',
    'snack-place-misc',
    'snack-place-office',
    'snack-type-alcohol',
    'snack-type-bakery',
    'snack-type-coffee',
    'snack-type-fruit',
    'snack-type-icecream',
    'snack-type-misc',
    'snack-type-snack',
    'snack-type-tea',
    'snack-when-am',
    'snack-when-night',
    'snack-when-pm',
    'snack-when-pre',
    'what-bowl',
    'what-coffee',
    'what-fish',
    'what-pizza',
    'what-sandwich',
    'what-soup',
    'with-briefcase',
    'with-ellipsis',
    'with-friends',
    'with-graduation',
    'with-heart',
    'with-party',
    'with-user',
    'with-users'
];

/** @type {Record<string, string>} */
export const ANALYSIS_ICON_ASSETS = Object.fromEntries(
    KEYS.map((key) => [key, `${BASE}/${key}.png`])
);
