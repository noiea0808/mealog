/**
 * 분석 Top 아이콘 행 — 식사/간식 기간 내 항목별 최다 선택 요소
 * 아이콘: 시안·간식 PNG (data URI)
 */
import { SATIETY_DATA } from '../constants.js';
import { appState } from '../state.js';
import { effectiveChartTag } from './meal-analytics-tags.js';
import { AUTO_CATEGORIES } from '../utils/food-classifier.js';
import { ANALYSIS_ICON_ASSETS } from './analysis-icon-assets.js';

const SNACK_WHEN_LABEL = {
    pre_morning: '아침 전',
    snack1: '오전',
    snack2: '오후',
    night: '야식'
};

/** @type {Record<string, string>} */
const MEAL_TYPE_ICON = {
    집밥: 'how-home',
    외식: 'how-utensils',
    '회식/술자리': 'how-wine',
    '배달/포장': 'how-motorcycle',
    구내식당: 'how-building',
    // 편의점 전용 아이콘 에셋이 아직 없다 — 생기면 여기에 붙인다(지금은 how-ellipsis 폴백)
    기타: 'how-ellipsis',
    건너뜀: 'how-skip',
    Skip: 'how-skip'
};

/** @type {Record<string, string>} */
/**
 * '무엇을' = 형태 축 (js/utils/food-dictionary.js FORM_CATEGORIES).
 *
 * 옛 요리 종류 축 키(한식·양식…)를 남겨 둔 이유: 상세 텍스트가 없어 재분류할 근거가
 * 없는 옛 기록은 원문 그대로 차트에 오른다 (meal-analytics-tags.js resolveFoodFormValue).
 * 그 값들도 아이콘을 잃지 않게 둔다.
 *
 * 에셋이 없어 기본 점으로 남는 형태: 면류·반찬류·영양제/약.
 * 시안(assets/analysis-icons-colored.png)에서 크롭하는 방식이라 코드로 만들 수 없다 —
 * 그림이 생기면 여기 세 줄만 채우면 된다 (assets/analysis-icons/README.md).
 */
const CATEGORY_ICON = {
    // ─ 형태 축 ─
    '밥류': 'what-bowl',
    '국물요리': 'what-soup',
    '빵류': 'what-sandwich',
    '고기·생선': 'what-fish',
    '튀김·분식': 'what-pizza',
    // 과일 아이콘을 함께 쓴다 — 초록 식물이라는 점만 맞는 임시 자리다
    '채소·샐러드': 'snack-type-fruit',
    '커피': 'what-coffee',
    '차/음료': 'snack-type-tea',
    '술/주류': 'snack-type-alcohol',
    '베이커리/떡': 'snack-type-bakery',
    '과자/스낵': 'snack-type-snack',
    '아이스크림': 'snack-type-icecream',
    '과일/견과': 'snack-type-fruit',
    '기타': 'snack-type-misc',
    // ─ 옛 요리 종류 축 (재분류 근거가 없는 기록이 이 값으로 남는다) ─
    한식: 'what-soup',
    양식: 'what-pizza',
    일식: 'what-fish',
    중식: 'what-bowl',
    분식: 'what-sandwich',
    카페: 'what-coffee'
};

/** @type {Record<string, string>} */
const WITH_WHOM_ICON = {
    혼자: 'with-user',
    가족: 'with-users',
    연인: 'with-heart',
    친구: 'with-friends',
    직장동료: 'with-briefcase',
    학교친구: 'with-graduation',
    모임: 'with-party',
    기타: 'with-ellipsis'
};

/** @type {Record<string, string>} */
const SNACK_WHEN_ICON = {
    '아침 전': 'snack-when-pre',
    오전: 'snack-when-am',
    오후: 'snack-when-pm',
    야식: 'snack-when-night'
};

/** @type {Record<string, string>} */
const SNACK_TYPE_ICON = {
    커피: 'snack-type-coffee',
    '차/음료': 'snack-type-tea',
    '술/주류': 'snack-type-alcohol',
    베이커리: 'snack-type-bakery',
    '베이커리/떡': 'snack-type-bakery',
    '과자/스낵': 'snack-type-snack',
    아이스크림: 'snack-type-icecream',
    '과일/견과': 'snack-type-fruit',
    기타: 'snack-type-misc'
};

/** @type {Record<string, string>} */
const SNACK_PLACE_ICON = {
    집: 'snack-place-home',
    사무실: 'snack-place-office',
    카페: 'snack-place-cafe',
    기타: 'snack-place-misc'
};

const MEAL_ROW_DEFS = [
    { id: 'mealType', label: '어떻게', key: 'mealType' },
    { id: 'category', label: '무엇을', key: 'category' },
    { id: 'withWhom', label: '함께', key: 'withWhom' },
    { id: 'rating', label: '만족도', key: 'rating' },
    { id: 'satiety', label: '포만감', key: 'satiety' }
];

const SNACK_ROW_DEFS = [
    { id: 'snackWhen', label: '언제', key: 'snackWhen' },
    { id: 'snackType', label: '무엇을', key: 'snackType' },
    { id: 'snackPlace', label: '어디서', key: 'snackPlace' },
    { id: 'withWhom', label: '누구와', key: 'withWhom' },
    { id: 'rating', label: '만족도', key: 'rating' },
    { id: 'satiety', label: '포만감', key: 'satiety' }
];

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/** 기간 탭 라벨 기준 대표 패턴 제목 */
export function getMainAnalysisPatternTitle(mode = appState.dashboardMode) {
    switch (mode) {
        case '7d':
            return '최근 1주 대표 패턴';
        case 'week':
            return '주간 대표 패턴';
        case 'month':
            return '월간 대표 패턴';
        case 'year':
            return '연간 대표 패턴';
        case 'custom':
            return '선택 기간 대표 패턴';
        default:
            return '대표 패턴';
    }
}

function updatePatternTitle() {
    const titleEl = document.getElementById('mainAnalysisTopIconsTitle');
    if (titleEl) titleEl.textContent = getMainAnalysisPatternTitle();
}

function getAllowedTags(key) {
    const userTags = window.userSettings?.tags || {};
    if (key === 'mealType' && Array.isArray(userTags.mealType) && userTags.mealType.length > 0) {
        return userTags.mealType;
    }
    if (key === 'category' && Array.isArray(userTags.category) && userTags.category.length > 0) {
        // 자동 분류 축은 사용자 태그에 없으므로 합집합 (charts.js aggregateProportionData와 동일)
        return [...userTags.category, ...AUTO_CATEGORIES];
    }
    if (key === 'withWhom' && Array.isArray(userTags.withWhom) && userTags.withWhom.length > 0) {
        return userTags.withWhom;
    }
    if (key === 'snackType' && Array.isArray(userTags.snackType) && userTags.snackType.length > 0) {
        // 간식 축에 옛 이름이 없는 형태는 형태 축 값으로 저장된다 (charts.js와 동일 규칙)
        return [...userTags.snackType, ...AUTO_CATEGORIES];
    }
    if (key === 'snackPlace' && Array.isArray(userTags.snackPlaceMain) && userTags.snackPlaceMain.length > 0) {
        return userTags.snackPlaceMain;
    }
    if (key === 'snackWhen') {
        return ['아침 전', '오전', '오후', '야식'];
    }
    return null;
}

/**
 * @param {object[]} data
 * @param {string} key
 * @returns {{ value: string, count: number } | null}
 */
function pickTopAnalysisValue(data, key) {
    if (!Array.isArray(data) || data.length === 0) return null;
    const counts = Object.create(null);
    const allowedTags = getAllowedTags(key);
    const allowedSet = allowedTags ? new Set(allowedTags) : null;

    for (const m of data) {
        if (!m) continue;
        // 차트 데이터 범위와 맞춤
        if (key === 'mealType' && !String(m.mealType ?? '').trim()) continue;
        // categoryAuto만 있는(사용자 확정 없는 자동 분류) 기록도 집계에 포함한다
        if (key === 'category' && !String(m.category ?? '').trim() && !String(m.categoryAuto ?? '').trim()) continue;
        if (key === 'withWhom' && !String(m.withWhom ?? '').trim()) continue;
        if (key === 'snackType' && !String(m.snackType ?? '').trim() && !String(m.menuDetail ?? '').trim()) {
            // snackType 차트는 전체 snacksOnly 포함 — 빈 값은 effective가 기타/미입력 처리
        }

        let raw;
        if (key === 'snackWhen') {
            raw = m.snackWhen || SNACK_WHEN_LABEL[m.slotId] || '';
        } else if (
            key === 'mealType' ||
            key === 'category' ||
            key === 'withWhom' ||
            key === 'snackType' ||
            key === 'snackPlace'
        ) {
            raw = effectiveChartTag(m, key === 'snackPlace' ? 'snackPlace' : key);
            if (allowedSet && raw && raw !== '기타' && raw !== '미입력' && !allowedSet.has(raw)) {
                raw = '';
            }
        } else if (key === 'rating') {
            const n = Number(m.rating);
            raw = Number.isFinite(n) && n > 0 ? String(Math.min(5, Math.round(n))) : '';
        } else if (key === 'satiety') {
            const n = Number(m.satiety);
            raw = Number.isFinite(n) && n > 0 ? String(Math.min(5, Math.round(n))) : '';
        } else {
            raw = '';
        }
        const val = String(raw || '').trim();
        if (!val || val === '미입력') continue;
        counts[val] = (counts[val] || 0) + 1;
    }

    const entries = Object.entries(counts);
    if (!entries.length) return null;

    const tagOrder = allowedTags || [];
    const rankInTags = (name) => {
        const i = tagOrder.indexOf(name);
        return i >= 0 ? i : 999;
    };
    const isMisc = (name) => name === '기타' || name === 'Skip' || name === '건너뜀';

    entries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        const am = isMisc(a[0]) ? 1 : 0;
        const bm = isMisc(b[0]) ? 1 : 0;
        if (am !== bm) return am - bm;
        return rankInTags(a[0]) - rankInTags(b[0]);
    });

    const [value, count] = entries[0];
    return { value, count };
}

function pngBadge(iconKey) {
    const src = ANALYSIS_ICON_ASSETS[iconKey] || ANALYSIS_ICON_ASSETS['how-ellipsis'];
    return `<span class="dashboard-analysis-top-icon__badge" aria-hidden="true"><img src="${src}" alt="" width="42" height="42" decoding="async"></span>`;
}

function resolveBadge(key, value) {
    if (key === 'mealType') {
        return pngBadge(MEAL_TYPE_ICON[value] || 'how-ellipsis');
    }
    if (key === 'category') {
        if (CATEGORY_ICON[value]) return pngBadge(CATEGORY_ICON[value]);
        if (String(value).includes('카페')) return pngBadge('what-coffee');
        if (String(value).includes('패스트')) return pngBadge('what-pizza');
        return pngBadge('how-ellipsis');
    }
    if (key === 'withWhom') {
        return pngBadge(WITH_WHOM_ICON[value] || 'with-ellipsis');
    }
    if (key === 'snackWhen') {
        return pngBadge(SNACK_WHEN_ICON[value] || 'how-ellipsis');
    }
    if (key === 'snackType') {
        if (SNACK_TYPE_ICON[value]) return pngBadge(SNACK_TYPE_ICON[value]);
        // 간식으로 밥류·국물요리를 적는 일도 있다 — '무엇을'과 같은 어휘라 그 표를 함께 본다
        if (CATEGORY_ICON[value]) return pngBadge(CATEGORY_ICON[value]);
        if (String(value).includes('커피') || String(value).includes('카페')) return pngBadge('snack-type-coffee');
        if (String(value).includes('차') || String(value).includes('음료')) return pngBadge('snack-type-tea');
        if (String(value).includes('술') || String(value).includes('주류')) return pngBadge('snack-type-alcohol');
        if (String(value).includes('베이커') || String(value).includes('빵')) return pngBadge('snack-type-bakery');
        if (String(value).includes('아이스') || String(value).includes('빙수')) return pngBadge('snack-type-icecream');
        if (String(value).includes('과일') || String(value).includes('견과')) return pngBadge('snack-type-fruit');
        if (String(value).includes('과자') || String(value).includes('스낵')) return pngBadge('snack-type-snack');
        return pngBadge('snack-type-misc');
    }
    if (key === 'snackPlace') {
        if (SNACK_PLACE_ICON[value]) return pngBadge(SNACK_PLACE_ICON[value]);
        if (String(value).includes('집') || String(value).includes('홈')) return pngBadge('snack-place-home');
        if (String(value).includes('회사') || String(value).includes('사무실') || String(value).includes('오피스')) {
            return pngBadge('snack-place-office');
        }
        if (String(value).includes('카페')) return pngBadge('snack-place-cafe');
        return pngBadge('snack-place-misc');
    }
    if (key === 'rating') {
        const n = Math.max(1, Math.min(5, parseInt(value, 10) || 1));
        return pngBadge(`rating-${n}`);
    }
    if (key === 'satiety') {
        const n = Math.max(1, Math.min(5, parseInt(value, 10) || 1));
        return pngBadge(`satiety-${n}`);
    }
    return pngBadge('how-ellipsis');
}

function displayValue(key, value) {
    if (key === 'rating') return `${value}점`;
    if (key === 'satiety') {
        const n = parseInt(value, 10);
        return SATIETY_DATA.find((d) => d.val === n)?.label || value;
    }
    return value;
}

function cellHtml(def, top) {
    const label = escapeHtml(def.label);
    if (!top) {
        return `<div class="dashboard-analysis-top-icon dashboard-analysis-top-icon--empty" title="${label}">
            <div class="dashboard-analysis-top-icon__badge" aria-hidden="true"></div>
            <span class="dashboard-analysis-top-icon__cat">${label}</span>
            <span class="dashboard-analysis-top-icon__val">—</span>
        </div>`;
    }
    const valText = escapeHtml(displayValue(def.key, top.value));
    const countText = `${top.count}회`;
    const title = `${def.label}: ${displayValue(def.key, top.value)} (${countText})`;
    return `<div class="dashboard-analysis-top-icon" title="${escapeHtml(title)}">
        ${resolveBadge(def.key, top.value)}
        <span class="dashboard-analysis-top-icon__cat">${label}</span>
        <span class="dashboard-analysis-top-icon__val">
            <span class="dashboard-analysis-top-icon__name">${valText}</span>
            <span class="dashboard-analysis-top-icon__sep" aria-hidden="true">·</span>
            <span class="dashboard-analysis-top-icon__count">${escapeHtml(countText)}</span>
        </span>
    </div>`;
}

function renderPatternRow(defs, records) {
    const row = document.getElementById('mainAnalysisTopIcons');
    if (!row) return;
    updatePatternTitle();
    const list = Array.isArray(records) ? records : [];
    row.innerHTML = defs.map((def) => cellHtml(def, pickTopAnalysisValue(list, def.key))).join('');
}

/** @param {object[]} mainMealsOnly */
export function renderMainAnalysisTopIcons(mainMealsOnly) {
    renderPatternRow(MEAL_ROW_DEFS, mainMealsOnly);
}

/**
 * @param {object[]} snacksOnly
 * @param {{ includeWhen?: boolean }} [opts] — 슬롯 필터가 '전체'일 때만 언제 표시
 */
export function renderSnackAnalysisTopIcons(snacksOnly, opts = {}) {
    const includeWhen = opts.includeWhen !== false;
    const snacks = Array.isArray(snacksOnly)
        ? snacksOnly.map((m) => ({
              ...m,
              snackWhen: SNACK_WHEN_LABEL[m.slotId] || m.snackWhen || ''
          }))
        : [];
    const defs = includeWhen
        ? SNACK_ROW_DEFS
        : SNACK_ROW_DEFS.filter((d) => d.id !== 'snackWhen');
    renderPatternRow(defs, snacks);
}

/** 식사·간식 탭에서 대표 패턴 카드 표시 */
export function setAnalysisTopIconsVisible(visible) {
    const wrap = document.getElementById('mainAnalysisTopIconsCard');
    const row = document.getElementById('mainAnalysisTopIcons');
    if (wrap) {
        wrap.classList.toggle('hidden', !visible);
        wrap.toggleAttribute('hidden', !visible);
    }
    if (row) {
        row.classList.toggle('hidden', !visible);
        row.toggleAttribute('hidden', !visible);
    }
    if (visible) updatePatternTitle();
}

/** @deprecated use setAnalysisTopIconsVisible */
export function setMainAnalysisTopIconsVisible(visible) {
    setAnalysisTopIconsVisible(visible);
}
