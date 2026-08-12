/**
 * 분석·차트용 메인 태그 해석 (저장 시점에 기타가 안 박혀 있던 옛 기록 포함).
 * 저장 로직(entry-and-core)과 동일한 의도: 메인 칩이 비어 있고 상세만 있으면 → 기타.
 */
import { SLOTS } from '../constants.js';

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
    if (!m || slotKind(m.slotId) !== 'main') return trim(m?.category);
    const c = trim(m.category);
    if (c) return c;
    // 자동 분류값 (사용자 확정 없이 저장된 제안 — source='local'/'ai')
    const auto = trim(m.categoryAuto);
    if (auto) return auto;
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

export function effectiveSnackTypeForAnalytics(m) {
    if (!m || slotKind(m.slotId) !== 'snack') return trim(m?.snackType);
    const st = trim(m.snackType);
    if (st) return st;
    // 간식도 끼니와 같은 자동 분류 필드 쌍을 공유한다 (저장은 entry-save-record.js)
    const auto = trim(m.categoryAuto);
    if (auto) return auto;
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
    const p = trim(m.place);
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
