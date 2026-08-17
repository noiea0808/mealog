/**
 * 분석·차트용 메인 태그 해석 (저장 시점에 기타가 안 박혀 있던 옛 기록 포함).
 * 저장 로직(entry-and-core)과 동일한 의도: 메인 칩이 비어 있고 상세만 있으면 → 기타.
 */
import { SLOTS } from '../constants.js';
import { normalizePlace } from '../utils/place-normalize.js';
import { normalizeFoodForm } from '../utils/food-form-normalize.js';
import { classifyFoodText } from '../utils/food-classifier.js';
import { isFormAxisPilot } from '../utils/form-axis-pilot.js';

const MAIN_IDS = new Set(['morning', 'lunch', 'dinner']);
const SNACK_IDS = new Set(SLOTS.filter((s) => s.type === 'snack').map((s) => s.id));

function slotKind(slotId) {
    if (MAIN_IDS.has(slotId)) return 'main';
    if (SNACK_IDS.has(slotId)) return 'snack';
    return null;
}

function trim(s) {
    return (s != null && String(s).trim()) || '';
}

/**
 * 옛 '무엇을' 축 = **요리 종류**(한식·양식…). 형태 축과 1:1 대응이 없어
 * normalizeFoodForm 이 매핑하지 않는 값들이다 — '한식'은 밥류일 수도 국물요리일 수도
 * 고기·생선일 수도 있어서, 표로 바꾸면 없는 정보를 지어내는 셈이 된다.
 * ('카페'는 옛 기본 태그에만 있던 값이다.)
 */
const LEGACY_CUISINE_AXIS = new Set(['한식', '양식', '일식', '중식', '분식', '카페']);

/** 기록 id+텍스트 → 재분류 결과 (차트가 여러 개라 같은 기록을 여러 번 읽는다) */
const legacyFormCache = new Map();

/**
 * 옛 요리 종류 값을 형태 축으로 되살린다: 자동 분류값 → 없으면 상세 텍스트 재분류.
 * 근거가 없으면 빈 문자열을 돌려주고, 호출부는 원문을 그대로 쓴다.
 * @param {object} m
 * @returns {string}
 */
function reclassifyLegacyCuisine(m) {
    const auto = trim(m.categoryAuto);
    if (auto) return normalizeFoodForm(auto);
    const text = trim(m.menuDetail);
    if (!text) return '';
    // 텍스트를 키에 포함 — 기록을 수정하면 id가 같아도 결과가 달라져야 한다
    const key = `${m.id || `${m.date}|${m.slotId}`}|${text}`;
    if (legacyFormCache.has(key)) return legacyFormCache.get(key);
    const [form] = classifyFoodText(text);
    const derived = form || '';
    legacyFormCache.set(key, derived);
    return derived;
}

/**
 * 저장된 '무엇을' 값 하나를 현재 형태 축 표기로 해석한다.
 *
 * 형태 축 파일럿 계정에서만 옛 요리 종류 축 값을 재분류로 대체한다. 그 외 사용자에게는
 * 지금까지와 동일하게 normalizeFoodForm 결과가 나간다 (js/utils/form-axis-pilot.js).
 * 어느 경우에도 **저장된 원문은 바꾸지 않는다** — 읽을 때만 하는 해석이다.
 *
 * @param {object} m meal 문서
 * @param {string|null|undefined} raw 그 기록의 category 또는 snackType
 * @returns {string}
 */
export function resolveFoodFormValue(m, raw) {
    const v = trim(raw);
    if (!v) return '';
    if (m && isFormAxisPilot() && LEGACY_CUISINE_AXIS.has(v)) {
        const derived = reclassifyLegacyCuisine(m);
        if (derived) return derived;
    }
    return normalizeFoodForm(v);
}

/**
 * @param {object} m meal 문서
 * @returns {string} 차트용 (빈 문자열이면 호출부에서 미입력 처리)
 */
export function effectiveMealTypeForAnalytics(m) {
    if (!m || slotKind(m.slotId) !== 'main') return trim(m?.mealType);
    const mt = trim(m.mealType);
    if (mt === 'Skip' || mt === '건너뜀') return mt;
    if (mt) return mt;
    const place = trim(m.place);
    const menu = trim(m.menuDetail);
    const withD = trim(m.withWhomDetail);
    if (place || menu || withD) return '기타';
    return '';
}

export function effectiveCategoryForAnalytics(m) {
    /**
     * 형태 축 이름이 바뀐 뒤로 옛 축(밥/한상·단백질식…)과 새 축(밥류·고기·생선…)이
     * 한 필드에 섞여 있다. 읽을 때만 새 축으로 맞춘다 — 원문은 그대로 둔다
     * (js/utils/food-form-normalize.js).
     */
    if (!m || slotKind(m.slotId) !== 'main') return resolveFoodFormValue(m, m?.category);
    const c = trim(m.category);
    if (c) return resolveFoodFormValue(m, c);
    // 자동 분류값 (사용자 확정 없이 저장된 제안 — source='local'/'ai')
    const auto = trim(m.categoryAuto);
    if (auto) return normalizeFoodForm(auto);
    if (trim(m.menuDetail)) return '기타';
    return '';
}

export function effectiveWithWhomForAnalytics(m) {
    if (!m) return '';
    const w = trim(m.withWhom);
    if (w) return w;
    if (trim(m.withWhomDetail)) return '기타';
    return '';
}

/**
 * 간식 '무엇을'.
 *
 * 끼니와 **같은 축**을 읽는다 (docs/food-category-auto-classification.md §6.2).
 * 저장된 값은 시점에 따라 옛 간식 축('베이커리')일 수도, 형태 축('베이커리/떡',
 * '채소·샐러드')일 수도 있다 — 원문은 그대로 두고 여기서만 새 축으로 맞춘다.
 */
export function effectiveSnackTypeForAnalytics(m) {
    if (!m || slotKind(m.slotId) !== 'snack') return resolveFoodFormValue(m, m?.snackType);
    const st = trim(m.snackType);
    if (st) return resolveFoodFormValue(m, st);
    // 간식도 끼니와 같은 자동 분류 필드 쌍을 공유한다 (저장은 entry-save-record.js)
    const auto = trim(m.categoryAuto);
    if (auto) return normalizeFoodForm(auto);
    const detail = trim(m.menuDetail);
    const place = trim(m.place);
    const withD = trim(m.withWhomDetail);
    const withChip = trim(m.withWhom);
    if (detail || place || withD || withChip) return '기타';
    return '';
}

/**
 * 간식 어디서: snackPlaceMain 우선. 옛 기록(place만 있음)은 관리자 메인 목록에 있으면 그 키, 아니면 기타.
 * @param {object} m
 * @param {Set<string>|null} snackPlaceMainSet userSettings.tags.snackPlaceMain
 */
export function effectiveSnackPlaceForAnalytics(m, snackPlaceMainSet) {
    if (!m || slotKind(m.slotId) !== 'snack') return '';
    const sm = trim(m.snackPlaceMain);
    if (sm) return sm;
    // 표기 정규화(우리집→집)로 자유 텍스트가 메인 칩(집·사무실·카페)과 합쳐지게 한다
    const p = normalizePlace(m.place);
    if (!p) return '';
    if (!snackPlaceMainSet || snackPlaceMainSet.size === 0) return p;
    if (snackPlaceMainSet.has(p)) return p;
    return '기타';
}

/**
 * @param {object} m
 * @param {'mealType'|'category'|'withWhom'|'snackType'|'snackPlace'} key
 */
export function effectiveChartTag(m, key) {
    const snackMains = window.userSettings?.tags?.snackPlaceMain;
    const snackSet =
        Array.isArray(snackMains) && snackMains.length > 0 ? new Set(snackMains) : null;

    if (key === 'mealType') return effectiveMealTypeForAnalytics(m);
    if (key === 'category') return effectiveCategoryForAnalytics(m);
    if (key === 'withWhom') return effectiveWithWhomForAnalytics(m);
    if (key === 'snackType') return effectiveSnackTypeForAnalytics(m);
    if (key === 'snackPlace') return effectiveSnackPlaceForAnalytics(m, snackSet);
    return trim(m?.[key]);
}
