/**
 * 기록 시트 1층 — 맥락 한 줄 (어떻게 · 어디서 · 누구와)
 * (docs/entry-sheet-redesign.md §2 2층, 축 구성은 docs/entry-axes-and-tags-direction.md §5)
 *
 * 위치: 1페이지 '무엇을' 바로 아래. 저장 필드의 소유자는 여전히 2페이지 섹션이고,
 * 이 줄은 그 값을 **미리 채우는 지름길**이다 — 세그먼트를 탭하면 그 축의 칩만
 * 이 자리에서 인라인으로 열린다(오버레이 없음 — 시트 높이 재측정 지뢰 회피).
 *
 * 순서가 곧 라우팅이다: 어떻게(조달)가 어디서(장소)의 입력 방식을 결정하므로 앞에 선다.
 *
 * 적용 모델 (2026-08-13 사용자 결정 — 재설계 원칙 2의 무확인 저장 금지를 맥락 필드에
 * 한해 대체한다): 추측은 **저장 시 그대로 적용**된다. 확인 버튼을 두지 않는 대신
 * 데이터 정직성은 categoryAuto 패턴으로 지킨다 —
 *   1) 자동 적용값은 record.autoContext에 출처가 남는다 (사용자 입력과 구분 가능)
 *   2) 예측 표본에서 자동 적용값을 제외한다 (추측이 추측을 강화하는 루프 차단)
 *   3) 교정률(피커 수정/자동 저장)이 품질 지표가 된다
 * 점선 = 자동(추측), 실선 = 사용자가 직접 고름. 탭하면 언제든 수정·해제.
 *
 * 예측 키: (slotId × 평일/주말) 최빈값 — 슬롯 표본 3건+ · 점유 60%+.
 * 표본 부족 시 사용자 전체(슬롯 무관) 최빈값으로 폴백 (같은 문턱).
 * 콜드 스타트(문턱 미달)면 값 없는 "+ 어디서" 트리거로만 존재한다 — 조르지 않되,
 * 1페이지에서 바로 열 수 있는 입구는 남긴다.
 *
 * 전부 로컬 계산(window.mealHistory)·best-effort — 실패는 "줄 없음"일 뿐이다.
 */
import { appState } from '../state.js';
import { setVal } from '../utils.js';
import { refreshLucideIcons } from '../icons.js';
import { logUsageMetric } from '../usage-metrics.js';
import { dominantPlaceGroup, normalizePlace } from '../utils/place-normalize.js';
import { placeTypeFromKakaoCategory } from '../utils/place-type.js';
import { procurementHintFromText } from '../utils/procurement-hint.js';
import { classifyCuisineText } from '../utils/food-classifier.js';
import { getAxis1TagList } from './entry-form-config.js';
import { frequentSubTagValues } from '../utils/frequent-subtags.js';

const CONTAINER_ID = 'entryContextPredict';
const MIN_SAMPLES = 3;
const MODE_SHARE = 0.6;
const RECENT_LIMIT = 30;
/** 어디서 피커에 올릴 내 장소 칩 개수 */
const PLACE_CHIP_LIMIT = 6;

/** 축 메타 — 표시 순서가 곧 라우팅 순서 */
const AXES = [
    { key: 'mealType', label: '어떻게', icon: 'utensils', mealOnly: true },
    { key: 'place', label: '어디서', icon: 'map-pin', mealOnly: false },
    { key: 'withWhom', label: '누구와', icon: 'user', mealOnly: false },
];

const state = {
    predicted: /** @type {{ mealType: string|null, place: string|null, withWhom: string|null }} */ ({ mealType: null, place: null, withWhom: null }),
    confirmed: /** @type {{ mealType: string|null, place: string|null, withWhom: string|null }} */ ({ mealType: null, place: null, withWhom: null }),
    /** 사용자가 명시적으로 비운 축 — 추측이 다시 채우지 않는다 */
    userCleared: /** @type {{ [key: string]: boolean }} */ ({}),
    /**
     * 추측을 이대로 쓸지. **기본 ON** — 맞는 추천을 켜려고 매번 손대게 하는 쪽이
     * 틀린 추천을 끄는 쪽보다 비용이 컸다. 추천값은 흐린 점선으로 "아직 추측"임을
     * 계속 말하고 스위치는 사라지지 않으므로, 한 번의 탭으로 언제든 되돌릴 수 있다.
     */
    useGuess: true,
    /** 습관 예측 원본(이력 최빈값) — 사실-유도 추론과 합성할 때 참조 */
    habitMealType: /** @type {string|null} */ (null),
    /**
     * 슬롯 기반 누구와 습관 예측 원본.
     * 어떻게가 바뀌어 연쇄 추론을 다시 돌릴 때, 그 어떻게로 좁힌 표본이 문턱을 못 넘으면
     * 여기로 되돌아온다 — 누구와는 값 공간이 작아 슬롯 습관도 여전히 쓸모가 있다.
     */
    habitWithWhom: /** @type {string|null} */ (null),
    /** 무엇을 자동 분류의 현재 1순위 (entry-category-suggest가 밀어줌) */
    foodCategory: /** @type {string|null} */ (null),
    /** 무엇을에서 파생한 요리 종류 — '중식→외식' 추론의 입력 */
    foodCuisine: /** @type {string|null} */ (null),
    /** 현재 어디서 추측이 어떻게에서 파생된 것인지 (어떻게가 바뀌면 함께 무효화) */
    placeFromMealTypeChain: false,
    /** 누구와도 같은 표시 — 어떻게가 바뀌면 다시 뽑는다 */
    withFromMealTypeChain: false,
    /** 인라인 피커가 열린 축 (null이면 닫힘) */
    openAxis: /** @type {string|null} */ (null),
    /** 누구와 3단 뎁스의 '직접 입력' 칸이 열려 있는지 */
    subFreeOpen: false,
    /**
     * 이번 시트에서 직접 적어 만든 이름 (부모별).
     * 해제(재탭)해도 알약은 남아야 하므로 입력란 값과 별개로 들고 있는다 —
     * 입력란만 보면 해제하는 순간 알약이 사라져 다시 못 고른다.
     * @type {Record<string, string[]>}
     */
    subAdded: {},
    /** 이번 시트에서만 감춘 3단 알약 — 이력에서 나오는 값은 지울 수 없다 (deleteSubOption) */
    subHidden: {},
    active: false,
};

/**
 * 저장 어댑터가 읽는 결과. 축마다 값과 출처를 함께 준다 —
 * 'user' = 피커에서 직접 고름 / 'auto' = 추측이 그대로 적용됨 (record.autoContext 대상).
 * @returns {{ mealType: {value: string|null, source: 'user'|'auto'|null},
 *             place: {value: string|null, source: 'user'|'auto'|null},
 *             withWhom: {value: string|null, source: 'user'|'auto'|null} }}
 */
export function getEntryContextPredictResult() {
    const axis = (key) => {
        // 직접 고른 값은 토글과 무관하게 항상 저장된다 — 토글이 지배하는 건 추측뿐이다
        if (state.confirmed[key]) return { value: state.confirmed[key], source: 'user' };
        if (state.useGuess && state.predicted[key]) return { value: state.predicted[key], source: 'auto' };
        return { value: null, source: null };
    };
    return { mealType: axis('mealType'), place: axis('place'), withWhom: axis('withWhom') };
}

export function resetEntryContextPredict() {
    state.predicted = { mealType: null, place: null, withWhom: null };
    state.confirmed = { mealType: null, place: null, withWhom: null };
    state.userCleared = {};
    state.useGuess = true;
    state.habitMealType = null;
    state.habitWithWhom = null;
    state.foodCategory = null;
    state.foodCuisine = null;
    state.placeFromMealTypeChain = false;
    state.withFromMealTypeChain = false;
    state.openAxis = null;
    state.subFreeOpen = false;
    state.subAdded = {};
    state.subHidden = {};
    clearTimeout(subFreeCommitTimer);
    state.active = false;
    render();
}

function isWeekendDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    const w = d.getDay();
    return w === 0 || w === 6;
}

export function isSkipRecord(r) {
    return r?.mealType === '건너뜀' || r?.mealType === 'Skip';
}

/**
 * @param {string[]} values
 * @param {boolean} [groupPlaces] place 필드면 표기 정규화 그룹으로 투표
 *   ('우리집' 40% + '집' 30%는 같은 그룹 70% — 표기가 갈려 예측이 침묵하는 걸 막는다).
 *   대표값은 그 그룹의 최다 원문 표기 — 사용자의 습관 어휘를 보존한다.
 * @returns {string|null} 최빈값 (문턱 충족 시)
 */
function qualifiedMode(values, groupPlaces = false) {
    if (!Array.isArray(values) || values.length < MIN_SAMPLES) return null;
    if (groupPlaces) {
        const g = dominantPlaceGroup(values);
        return g && g.count / g.total >= MODE_SHARE ? g.representative : null;
    }
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let top = null;
    let topN = 0;
    for (const [v, n] of counts) {
        if (n > topN) {
            top = v;
            topN = n;
        }
    }
    return topN / values.length >= MODE_SHARE ? top : null;
}

/** 어떻게(mealType) 예측에서 제외하는 값 — 폴백·기록상태는 습관이 아니다 */
const MEALTYPE_PREDICT_EXCLUDE = new Set(['기타', '건너뜀', 'Skip']);

/** 맥락 줄 → 칩 반영 중에 칩 → 맥락 줄 훅이 되돌아오는 것을 막는다 */
let syncingMealTypeChips = false;

/** '직접 입력'을 막 열었을 때만 커서를 옮긴다 (칩 탭마다 포커스를 뺏지 않게) */
let pendingSubFreeFocus = false;

/** 장소 직접 입력 칸도 엔터로 굳힌 뒤 커서를 그대로 둔다 */
let pendingPlaceFreeFocus = false;

/** blur 로 굳히기 전에 두는 여유 — 옆 알약 클릭이 먼저 처리되게 한다 */
const SUB_FREE_COMMIT_DELAY_MS = 150;
let subFreeCommitTimer = null;

function usableRecords(history, field) {
    return history.filter(
        (r) =>
            r && !isSkipRecord(r) && typeof r[field] === 'string' && r[field].trim() &&
            !(field === 'mealType' && MEALTYPE_PREDICT_EXCLUDE.has(r[field].trim())) &&
            // 자동 적용된 값은 표본에서 제외 — 추측이 추측을 강화하는 루프 차단
            !(Array.isArray(r.autoContext) && r.autoContext.includes(field))
    );
}

/**
 * @param {any[]} history window.mealHistory
 * @param {'mealType'|'place'|'withWhom'} field
 * @param {string} slotId
 * @param {boolean} weekend
 * @returns {string|null}
 */
function predictField(history, field, slotId, weekend) {
    const withValue = usableRecords(history, field);
    if (withValue.length === 0) return null;
    // 최근 우선 — date 문자열(YYYY-MM-DD) 내림차순
    const sorted = [...withValue].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    const groupPlaces = field === 'place';
    const slotSamples = sorted
        .filter((r) => r.slotId === slotId && isWeekendDate(String(r.date || '')) === weekend)
        .slice(0, RECENT_LIMIT)
        .map((r) => r[field].trim());
    const bySlot = qualifiedMode(slotSamples, groupPlaces);
    if (bySlot) return bySlot;

    /**
     * 슬롯 표본이 모자라면 넓히되 **같은 종류(끼니/간식)까지만** 본다.
     * 예전엔 전체 이력으로 폴백했는데, 간식 예측이 켜지면서 끼니 장소('구내식당')가
     * 간식 추측으로 새는 경로가 된다 — 카페에서 먹는 간식과 섞이면 안 된다.
     */
    const wantSnack = isSnackSlot(slotId);
    const sameKind = sorted.filter((r) => isSnackSlot(r.slotId) === wantSnack);
    const anySamples = sameKind.slice(0, RECENT_LIMIT).map((r) => r[field].trim());
    return qualifiedMode(anySamples, groupPlaces);
}

/**
 * 어디서 피커용 "내 장소" 칩 — 최근 기록에서 자주 쓴 표기 순.
 * 정규화 그룹으로 묶고 대표는 그 그룹의 최다 원문 표기 (습관 어휘 보존).
 * @returns {string[]}
 */
function recentPlaceChips(history) {
    try {
        const values = usableRecords(history, 'place')
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
            .slice(0, 200)
            .map((r) => r.place.trim());
        /** @type {Map<string, Map<string, number>>} 정규화키 → 원문별 횟수 */
        const groups = new Map();
        for (const v of values) {
            const key = normalizePlace(v) || v;
            if (!groups.has(key)) groups.set(key, new Map());
            const inner = groups.get(key);
            inner.set(v, (inner.get(v) || 0) + 1);
        }
        return [...groups.values()]
            .map((inner) => {
                let rep = '';
                let total = 0;
                let best = 0;
                for (const [raw, n] of inner) {
                    total += n;
                    if (n > best) {
                        best = n;
                        rep = raw;
                    }
                }
                return { rep, total };
            })
            .sort((a, b) => b.total - a.total)
            .slice(0, PLACE_CHIP_LIMIT)
            .map((g) => g.rep);
    } catch (_) {
        return [];
    }
}

/**
 * 어떻게(조달)별 콜드 스타트 장소 시드.
 * **이력이 없을 때만** 쓰는 마중물이다 — 실제 선택지는 그 조달 방식으로 기록한
 * 사용자 자신의 장소에서 나온다(어휘 보존 원칙). 외식·회식은 상호명이 답이라 시드가 없다.
 */
const PLACE_SEEDS_BY_MEALTYPE = {
    '집밥': ['우리집', '본가', '처가', '친구집'],
    '배달/포장': ['우리집', '본가', '사무실'],
    '구내식당': ['구내식당'],
    // 편의점은 사서 어디서든 먹는다 — 산 곳이 아니라 먹은 곳이 장소다
    '편의점': ['편의점', '사무실', '우리집'],
    '외식': [],
    '회식/술자리': [],
};

/**
 * 어떻게별 누구와 우선순위. 장소와 달리 **거르지 않고 정렬만** 한다 —
 * '혼자 외식'·'가족 회식'처럼 드물지만 정당한 조합을 막으면 안 된다.
 */
const WITH_PRIORITY_BY_MEALTYPE = {
    '집밥': ['가족', '혼자'],
    '배달/포장': ['혼자', '가족'],
    '구내식당': ['직장동료', '혼자'],
    '편의점': ['혼자'],
    '외식': ['가족', '친구', '연인'],
    '회식/술자리': ['직장동료', '친구'],
};

/**
 * 축별 피커에 올릴 선택지.
 *
 * **상위 축(어떻게)이 하위 축의 선택지를 좁힌다** — 집밥을 골랐는데 식당 이름이 뜨거나,
 * 외식을 골랐는데 '우리집'이 먼저 뜨는 걸 막는다. 좁히는 기준은 하드코딩된 분류표가
 * 아니라 **그 조달 방식으로 기록한 사용자 자신의 이력**이다. 이력이 없을 때만 시드가 나선다.
 */
function optionsForAxis(axisKey) {
    const tags = window.userSettings?.tags || {};
    if (axisKey === 'mealType') {
        return getAxis1TagList('meal', tags).filter((t) => t !== '건너뜀' && t !== 'Skip');
    }
    const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const mealType = appState.entryFormMode === 'snack' ? '' : axisValue('mealType');
    const scoped = mealType ? history.filter((r) => r && r.mealType === mealType) : history;

    if (axisKey === 'withWhom') {
        const all = Array.isArray(tags.withWhom) ? tags.withWhom : [];
        if (!mealType || all.length === 0) return all;
        // 이 조달 방식에서 실제로 쓴 값 → 시드 → 나머지 순. 값은 하나도 빼지 않는다
        const used = frequentValues(scoped, 'withWhom').filter((v) => all.includes(v));
        const seeds = (WITH_PRIORITY_BY_MEALTYPE[mealType] || []).filter((v) => all.includes(v));
        const ordered = [...new Set([...used, ...seeds])];
        return [...ordered, ...all.filter((v) => !ordered.includes(v))];
    }

    // 어디서: 그 조달 방식으로 간 곳만. 이력이 없으면 시드, 그것도 없으면 전체 이력 폴백
    if (!mealType) return recentPlaceChips(history);
    const fromHistory = recentPlaceChips(scoped);
    const seeds = PLACE_SEEDS_BY_MEALTYPE[mealType] || [];
    const merged = [...new Set([...fromHistory, ...seeds])].slice(0, PLACE_CHIP_LIMIT);
    return merged.length > 0 ? merged : recentPlaceChips(history);
}

/**
 * 기록 목록에서 그 필드의 빈도순 값 (정규화 없이 원문 그대로).
 * @param {any[]} records @param {string} field @returns {string[]}
 */
function frequentValues(records, field) {
    const counts = new Map();
    for (const r of records) {
        const v = typeof r?.[field] === 'string' ? r[field].trim() : '';
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

/** 이 시트에서 보여줄 축 목록 (간식은 어떻게 없음) */
function visibleAxes() {
    const isSnack = appState.entryFormMode === 'snack';
    return AXES.filter((a) => !(a.mealOnly && isSnack));
}

/**
 * 어떻게(mealType) 사실-유도 추론 — **이 기록에 이미 입력된 것**에서 조달 방식을 읽는다
 * (docs/entry-axes-and-tags-direction.md §5). 이력 통계(습관 예측)가 아니라 현재 기록의
 * 사실에서 나오므로, 합성 시 습관 예측보다 우선한다.
 *
 * 신뢰도 높은 순서:
 * 1. 카카오 장소 픽 → placeType이 식당/술집/카페면 '외식' (사용자가 고른 장소의 객관 속성)
 * 2. **무엇을 원문의 조달 키워드** ("배민 치킨"→배달/포장, "구내식당 백반"→구내식당).
 *    음식 카테고리는 조달을 거의 못 알려주지만(면은 집·배달·식당 모두 가능) 원문에는
 *    조달어가 직접 들어 있다. 장소가 비어 있어도 발화하는 유일한 규칙이다.
 * 3. 장소 표기가 '구내식당' → '구내식당' (장소가 값 자체)
 * 4. 장소가 집 그룹 + 무엇을 형태가 밥류 → '집밥' (집에서 차린 한 상)
 *    — 집에서 배달을 먹는 반례가 있어 확신은 아니지만, 점선 추측 + 토글이 받는다.
 * 5. **요리 종류** (장소가 비었을 때만) → 개인 통계 우선, 없으면 시드(중식·일식→외식).
 *    탕수육을 적었는데 슬롯 최빈값이라는 이유로 '집밥'이 뜨는 걸 막는다.
 *
 * @returns {string|null}
 */
function inferMealTypeFromFacts() {
    try {
        const input = document.getElementById('entryWhereInput');
        const raw = (input?.value || '').trim();
        const dataStr = input?.getAttribute('data-kakao-place-data');
        const pickedName = (input?.getAttribute('data-kakao-place-name') || '').trim();
        // 장소명을 수정했으면 카카오 속성도 무효 (저장 경로의 nameMatches와 같은 규칙)
        if (dataStr && pickedName && raw === pickedName) {
            const d = JSON.parse(dataStr);
            const pt = placeTypeFromKakaoCategory(d?.categoryGroupCode, d?.category);
            if (pt === '식당' || pt === '술집' || pt === '카페') return '외식';
        }
        const whatText = document.getElementById('entryWhatInput')?.value || '';
        const byText = procurementHintFromText(whatText, window.userSettings?.tags?.mealType || null);
        if (byText) return byText;

        const norm = raw ? normalizePlace(raw) : '';
        if (norm.includes('구내식당')) return '구내식당';
        // 집에서 끓인 찌개·국은 가장 확실한 집밥 신호라 밥류와 함께 본다
        if (norm === '집' && HOME_COOKED_FORMS.has(state.foodCategory)) return '집밥';

        /**
         * 요리 종류 신호 — 장소가 비어 있을 때 습관 예측보다 먼저 본다.
         * "탕수육"을 적었는데 그 슬롯 최빈값이 집밥이라 집밥이 뜨는 걸 막는다.
         * 개인 통계 우선: 내가 중식을 먹을 때 실제로 뭐였는지(배달인지 외식인지)가
         * 전역 시드보다 정확하다. 이력이 모자랄 때만 시드가 나선다.
         */
        if (!norm && state.foodCuisine) {
            const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
            const personal = mealTypeForCuisine(history, state.foodCuisine);
            if (personal) return personal;
            const seed = MEALTYPE_SEED_BY_CUISINE[state.foodCuisine];
            const allowed = window.userSettings?.tags?.mealType;
            if (seed && (!Array.isArray(allowed) || allowed.includes(seed))) return seed;
        }
        return null;
    } catch (_) {
        return null;
    }
}

/**
 * 어떻게 추측 재합성: 사실-유도 추론 > 습관 예측. 확정됐거나 칩이 이미 선택돼 있으면 개입 금지.
 * 무엇을 텍스트·어디서 입력이 바뀔 때마다 불린다 — 추측이 입력을 따라 실시간으로 갱신된다.
 */
function refreshMealTypeGuess() {
    if (!state.active || appState.entryFormMode === 'snack') return;
    if (state.confirmed.mealType || state.userCleared.mealType) return;
    if (document.querySelector('#entryWhereChips button.chip.active')) return;
    const next = inferMealTypeFromFacts() || state.habitMealType;
    if ((state.predicted.mealType || null) !== (next || null)) {
        state.predicted.mealType = next;
        /**
         * 어떻게가 바뀌면 **그 어떻게 때문에 넣었던 어디서**는 근거를 잃는다.
         * ("배민 치킨"→배달/포장·우리집 에서 "탕수육"으로 고치면 우리집이 남으면 안 된다)
         * 습관 예측이 내놓은 어디서는 근거가 따로라 건드리지 않는다.
         */
        if (state.placeFromMealTypeChain) {
            state.predicted.place = null;
            state.placeFromMealTypeChain = false;
        }
        applyPlaceFromMealType();
        /**
         * 누구와도 같은 이유로 다시 뽑는다.
         *
         * 예전에는 이 경로에서 어디서만 갱신했다 — 사용자가 어떻게를 **직접 고른** 경우
         * (rederiveContextFromMealType)만 누구와까지 이어지고, 무엇을·어디서 입력으로
         * 어떻게 **추측이 바뀐** 경우에는 이전 어떻게로 뽑은 누구와가 그대로 남았다.
         * 두 경로 모두 "어떻게가 달라졌다"는 같은 사건이므로 연쇄도 같아야 한다.
         *
         * 어디서와 달리 무효화 플래그를 먼저 끌 필요가 없다 — applyWithWhomFromMealType 은
         * 매번 처음부터 다시 계산하고, 표본이 모자라면 슬롯 습관으로 되돌아간다.
         */
        applyWithWhomFromMealType();
        render();
    }
}

/**
 * 어떻게 → 어디서 연쇄 추론.
 *
 * 어떻게가 '집밥'으로 추천됐는데 어디서가 비어 있으면 '우리집'이 따라오는 게 자연스럽다.
 * 다만 **빈칸을 채울 때만** 개입한다 — 이미 슬롯 기반 습관 예측이 장소를 내놨다면
 * 그쪽이 더 구체적이므로 덮지 않는다(추측 위에 추측을 얹어 오차가 곱해지는 걸 막는다).
 *
 * 값은 개인 통계 우선: "내가 집밥일 때 어디서였나"가 시드('우리집')보다 정확하다.
 * 외식·회식은 상호명이라 추론하지 않는다.
 */
function applyPlaceFromMealType() {
    if (state.confirmed.place || state.predicted.place || state.userCleared.place) return;
    if ((document.getElementById('entryWhereInput')?.value || '').trim()) return;
    const mealType = state.predicted.mealType || state.confirmed.mealType;
    if (!mealType) return;

    const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const samples = usableRecords(history, 'place')
        .filter((r) => r.mealType === mealType)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, RECENT_LIMIT)
        .map((r) => r.place.trim());
    const personal = qualifiedMode(samples, true);
    const derived = personal || PLACE_SEED_BY_MEALTYPE[mealType] || null;
    state.predicted.place = derived;
    // 이 어디서가 어떻게에서 파생됐음을 표시 — 어떻게가 바뀌면 함께 무효화된다
    state.placeFromMealTypeChain = Boolean(derived);
}

/**
 * 어떻게 → 누구와 연쇄 추론. 어디서와 같은 규칙(개인 통계·같은 문턱)이다.
 *
 * 다만 **폴백이 한 단 더 있다**: 어디서는 표본이 모자라면 시드로 넘어가는데, 누구와는
 * 값 공간이 작아 슬롯 습관('아침엔 혼자')이 여전히 쓸모 있으므로 그쪽을 먼저 거친다.
 * 개인 통계 > 슬롯 습관 > 시드(WITH_SEED_BY_MEALTYPE) 순.
 */
function applyWithWhomFromMealType() {
    if (state.confirmed.withWhom || state.userCleared.withWhom) return;
    if ((document.getElementById('entryWithInput')?.value || '').trim()) return;
    const mealType = state.confirmed.mealType || state.predicted.mealType;
    if (!mealType) return;

    const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const samples = usableRecords(history, 'withWhom')
        .filter((r) => r.mealType === mealType)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, RECENT_LIMIT)
        .map((r) => r.withWhom.trim());
    const scoped = qualifiedMode(samples);
    const seed = WITH_SEED_BY_MEALTYPE[mealType] || null;
    // 시드는 슬롯 습관이 침묵할 때만 나선다 — 개인 이력이 일반론을 이긴다
    const fromHow = scoped || (state.habitWithWhom ? null : seed);
    state.predicted.withWhom = scoped || state.habitWithWhom || seed;
    state.withFromMealTypeChain = Boolean(fromHow);
}

/**
 * 어떻게가 바뀌었을 때 어디서·누구와를 다시 뽑는다.
 *
 * 사용자가 어떻게를 **직접 고른** 순간, 그 값으로 좁힌 통계가 슬롯 기반 습관 예측보다
 * 정보가 많다. 그래서 추측은 통째로 버리고 다시 계산한다 — 확정값과 사용자가 비운 축은
 * 건드리지 않는다.
 *
 * 외식·회식/술자리는 어디서가 상호명이라 추론할 근거가 없다 → **빈칸으로 남는다.**
 * (집밥일 때 채워둔 '우리집'이 외식으로 바꾼 뒤에도 남아 있으면 그게 곧 오기록이다)
 */
function rederiveContextFromMealType() {
    if (appState.entryFormMode === 'snack') return;
    if (!state.confirmed.place && !state.userCleared.place) {
        state.predicted.place = null;
        state.placeFromMealTypeChain = false;
    }
    if (!state.confirmed.withWhom && !state.userCleared.withWhom) {
        state.predicted.withWhom = null;
        state.withFromMealTypeChain = false;
    }
    // 이전 어떻게가 넣었던 입력값을 먼저 치운다 — 남아 있으면 재추론이 "이미 값 있음"으로 막힌다
    clearHowFilledPlaceInput();
    applyPlaceFromMealType();
    applyWithWhomFromMealType();
    writeDerivedPlaceToInput();
}

/**
 * 이전 어떻게가 자동으로 넣었던 어디서만 비운다.
 *
 * 표시(`data-how-filled`)에는 **넣은 값 자체**를 담는다. 플래그('1')만 두면 사용자가 그 위에
 * 다른 장소를 타이핑했을 때 표시가 그대로 남아 사람이 넣은 값을 지워버린다 —
 * 값을 담아 두면 현재 입력과 대조해서 "아직 자동값 그대로인가"를 알 수 있다.
 */
function clearHowFilledPlaceInput() {
    const pi = document.getElementById('entryWhereInput');
    if (!pi) return;
    const marked = pi.getAttribute('data-how-filled');
    if (!marked) return;
    if (pi.value.trim() !== marked) {
        // 사용자가 손댔다 — 자동값이 아니므로 표시만 떼고 값은 남긴다
        pi.removeAttribute('data-how-filled');
        return;
    }
    pi.value = '';
    pi.removeAttribute('data-how-filled');
}

/**
 * 어떻게에서 파생된 어디서를 입력란에도 반영한다(집밥 → 우리집).
 * 파생값이 없으면(외식·회식) 아무것도 쓰지 않으므로 **빈칸으로 남는다.**
 */
function writeDerivedPlaceToInput() {
    if (!state.placeFromMealTypeChain || !state.predicted.place) return;
    const pi = document.getElementById('entryWhereInput');
    if (!pi || pi.value.trim()) return;
    pi.value = state.predicted.place;
    pi.setAttribute('data-how-filled', state.predicted.place);
    ['id', 'address', 'data', 'name'].forEach((k) => pi.removeAttribute(`data-kakao-place-${k}`));
}

/**
 * 어떻게 칩 그리드('자세히' 안)에서 고른 값을 맥락 줄에 반영한다.
 * entry-and-core.js selectTag 가 호출한다 — 알리지 않으면 그리드와 줄이 서로 다른 값을 보인다.
 */
export function syncEntryContextMealTypeFromChips() {
    if (!state.active || syncingMealTypeChips || appState.entryFormMode === 'snack') return;
    const active = document.querySelector('#entryWhereChips button.chip.active');
    const picked = active ? active.innerText.trim() : '';
    if ((state.confirmed.mealType || null) === (picked || null)) return;
    state.confirmed.mealType = picked || null;
    state.predicted.mealType = null;
    if (picked) delete state.userCleared.mealType;
    else state.userCleared.mealType = true;
    rederiveContextFromMealType();
    render();
}

/**
 * 요리 종류별 조달 방식 시드 — **집에서 해 먹는 일이 드문 종류만** 담는다.
 * 한식·양식·분식은 집에서도 흔히 만들므로 넣지 않는다(습관 예측에 맡긴다).
 * 이력이 쌓이면 개인 통계가 이 시드를 대체한다.
 */
/**
 * 집에서 차렸다는 신호가 되는 형태 — 장소가 '집'일 때 집밥 추측의 근거.
 * 반찬류가 함께 있는 것은 반찬만 적은 기록("김치, 나물") 때문이다 — 밥상을 차렸다는
 * 뜻이지 사 먹었다는 뜻이 아니다. 밥·국이 함께 적힌 기록은 어차피 그쪽으로 분류된다.
 */
const HOME_COOKED_FORMS = new Set(['밥류', '국물요리', '반찬류']);

/** 간식 슬롯 (js/analytics/charts.js SNACK_SLOTS 와 동기화) */
const SNACK_SLOT_IDS = new Set(['pre_morning', 'snack1', 'snack2', 'night']);

/** @param {string} slotId */
export function isSnackSlot(slotId) {
    return SNACK_SLOT_IDS.has(String(slotId || ''));
}

/**
 * 어떻게 → 어디서 콜드 스타트 시드.
 * 이력이 없을 때만 쓴다 — 실제 값은 "내가 집밥일 때 어디서였나"라는 개인 통계에서 나온다.
 * 외식·회식은 상호명이라 시드가 불가능하다.
 */
const PLACE_SEED_BY_MEALTYPE = {
    '집밥': '우리집',
    '배달/포장': '우리집',
    '구내식당': '구내식당',
    '편의점': '편의점',
};

/**
 * 어떻게 → 누구와 시드 (2026-08-18 추가).
 *
 * 원래는 두지 않았다 — "회식이면 직장동료일 것"이라고 값까지 단정하기엔 근거가 약하다는
 * 이유였다. 그런데 실제로는 그 결정 때문에 **이력이 얕은 축이 영영 안 뜨는** 증상이 났다:
 * 구내식당 기록 3건 중 누구와가 채워진 건 2건, 문턱(3건)에 한 건 모자라 침묵.
 * 어디서는 PLACE_SEED_BY_MEALTYPE 가 같은 문제를 이미 시드로 풀고 있었다.
 *
 * 다만 시드는 **조달 방식이 곧 동석자를 정하는 경우로만** 좁힌다.
 * 집밥·외식·배달은 사람마다 갈리므로(혼자 사는 사람의 집밥, 가족 외식, 혼밥 배달)
 * 넣지 않는다 — 거기까지 단정하면 원래의 우려가 그대로 현실이 된다.
 * WITH_PRIORITY_BY_MEALTYPE 를 그대로 쓰지 않는 것도 같은 이유다(그건 피커 정렬용이라
 * 확신이 약한 값까지 1순위를 갖는다).
 *
 * 개인 통계 > 슬롯 습관 > 이 시드 순이고, 한 번 고치면 그 뒤로는 개인 통계가 이긴다.
 */
const WITH_SEED_BY_MEALTYPE = {
    '구내식당': '직장동료',
    '회식/술자리': '직장동료',
    '편의점': '혼자',
};

const MEALTYPE_SEED_BY_CUISINE = {
    '중식': '외식',
    '일식': '외식',
    // 햄버거·피자·치킨 — 집에서 만드는 일이 사실상 없다.
    // 외식이냐 배달이냐는 사람마다 갈리므로 시드는 '외식' 하나만 두고,
    // 한 번 고치면 그 뒤로는 개인 통계가 시드를 이긴다.
    '패스트푸드': '외식',
};

/** 기록 id → 파생 요리 종류 (시트 세션 동안 재사용 — 매번 재분류하지 않게) */
const cuisineCache = new Map();

/**
 * 그 기록의 요리 종류. 과거 기록에는 cuisineAuto 가 없으므로 상세 텍스트에서 파생한다
 * (마이그레이션 없이 옛 기록도 신호로 쓰기 위해).
 * @param {any} r
 * @returns {string|null}
 */
function recordCuisine(r) {
    if (!r) return null;
    if (r.cuisineAuto) return r.cuisineAuto;
    // 텍스트를 키에 포함 — 기록을 수정하면 id가 같아도 파생값이 달라져야 한다
    const key = `${r.id || `${r.date}|${r.slotId}`}|${r.menuDetail || ''}`;
    if (cuisineCache.has(key)) return cuisineCache.get(key);
    const derived = classifyCuisineText(r.menuDetail || '');
    cuisineCache.set(key, derived);
    return derived;
}

/**
 * "내가 이 요리 종류를 먹을 때 어떻게였나" — 개인 통계.
 * 같은 문턱(표본 3+·점유 60%+)을 쓴다. 최근 기록만 본다(전수 재분류는 비싸다).
 * @param {any[]} history @param {string} cuisine
 * @returns {string|null}
 */
function mealTypeForCuisine(history, cuisine) {
    if (!cuisine) return null;
    const recent = usableRecords(history, 'mealType')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 150);
    const samples = recent
        .filter((r) => recordCuisine(r) === cuisine)
        .slice(0, RECENT_LIMIT)
        .map((r) => r.mealType.trim());
    return qualifiedMode(samples);
}

/**
 * 무엇을 자동 분류 결과가 바뀔 때 entry-category-suggest가 호출.
 * 형태는 '집+밥류→집밥' 추론에, 요리 종류는 '중식→외식' 추론에 쓰인다.
 * @param {string|null} category 형태 1순위
 * @param {string|null} [cuisine] 요리 종류
 */
export function updateEntryContextFoodCategory(category, cuisine = null) {
    state.foodCuisine = cuisine || null;
    /**
     * 분류가 그대로여도 항상 재합성한다 — 조달 키워드는 **원문**에서 읽으므로
     * "라면" → "배민 라면" 처럼 카테고리가 안 변해도 추측은 바뀌어야 한다.
     * refreshMealTypeGuess 는 값이 실제로 달라질 때만 render 하므로 헛일이 아니다.
     */
    state.foodCategory = category || null;
    refreshMealTypeGuess();
}

/**
 * 시트 열림이 끝난 뒤 호출. 비어 있는 필드에 대해서만 예측한다.
 * @param {{ slotId: string, dateStr: string, isSnack: boolean }} args
 */
export function setupEntryContextPredict({ slotId, dateStr, isSnack, autoContext }) {
    try {
        resetEntryContextPredict();
        if (!slotId || !dateStr) return;
        state.active = true;

        /**
         * 이미 채워진 값(기록 수정 진입·시트 재열기)을 세그먼트에 싣는다.
         * 이게 없으면 값이 있는 기록을 수정할 때 세그먼트가 '+ 어떻게'로 비어 보였다.
         * 사용자가 저장했던 값이므로 확정(실선) 취급이다 — 추측이 아니다.
         */
        const activeChipLabel = (containerId) =>
            document.querySelector(`#${containerId} button.chip.active`)?.innerText.trim() || '';
        const existing = {
            mealType: isSnack ? '' : activeChipLabel('entryWhereChips'),
            place: (document.getElementById('entryWhereInput')?.value || '').trim(),
            withWhom: activeChipLabel('entryWithChips'),
        };
        /**
         * 이전에 **자동 적용으로 저장된 축**(record.autoContext)은 확정이 아니라 추천으로
         * 되살린다 — 수정 화면에서도 스위치가 나타나 그때의 자동 적용을 끌 수 있어야 한다.
         * 사용자가 직접 고른 축은 확정(실선)으로 남아 스위치의 지배를 받지 않는다.
         */
        const autoAxes = new Set(Array.isArray(autoContext) ? autoContext : []);
        state.confirmed = {
            mealType: (!autoAxes.has('mealType') && existing.mealType) || null,
            place: (!autoAxes.has('place') && existing.place) || null,
            withWhom: (!autoAxes.has('withWhom') && existing.withWhom) || null,
        };
        if (autoAxes.size > 0) state.useGuess = true;

        const mealTypeFilled = Boolean(existing.mealType);
        const placeFilled = Boolean(existing.place);
        const withFilled =
            Boolean(existing.withWhom) ||
            Boolean((document.getElementById('entryWithInput')?.value || '').trim());

        const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        const weekend = isWeekendDate(dateStr);
        /**
         * 간식도 끼니와 같은 예측을 탄다 (2026-08-13 결정 — 이전에는 데이터를 본 뒤
         * 판단하기로 미뤄뒀다). 축은 어디서·누구와 둘뿐이라 어떻게 관련 계산은 건너뛴다.
         * 표본은 predictField 가 같은 종류(간식 슬롯)로 좁혀 뽑는다.
         */
        state.habitMealType = (isSnack || mealTypeFilled)
            ? null
            : predictField(history, 'mealType', slotId, weekend);
        state.predicted = {
            // 어떻게는 습관 예측 + 사실-유도 추론(카카오 픽·장소 표기·음식 분류)의 합성
            mealType: (isSnack || mealTypeFilled) ? null : (inferMealTypeFromFacts() || state.habitMealType),
            place: placeFilled ? null : predictField(history, 'place', slotId, weekend),
            withWhom: withFilled ? null : predictField(history, 'withWhom', slotId, weekend),
        };
        // 어떻게가 바뀔 때 되돌아갈 슬롯 기반 원본을 남겨 둔다
        state.habitWithWhom = state.predicted.withWhom;
        // 어떻게가 추측됐는데 어디서·누구와가 비었으면 거기서 이어 받는다 (집밥 → 우리집)
        if (!isSnack) {
            applyPlaceFromMealType();
            applyWithWhomFromMealType();
        }
        // 자동 적용으로 저장됐던 축은 그때 값을 추천으로 복원 (예측 계산보다 우선)
        for (const key of autoAxes) {
            if (existing[key]) state.predicted[key] = existing[key];
        }
        if (state.predicted.mealType || state.predicted.place || state.predicted.withWhom) {
            logUsageMetric('context_predict_shown').catch(() => {});
        }
        render();
    } catch (_) {
        /* 예측 실패 = 줄 없음. 시트 열기에 영향 금지 */
    }
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** 현재 이 축이 화면에 들고 있는 값 (확정 우선, 없으면 예측) */
function axisValue(key) {
    return state.confirmed[key] || state.predicted[key] || '';
}

function renderSegment(axis) {
    const value = axisValue(axis.key);
    const isConfirmed = Boolean(state.confirmed[axis.key]);
    const isGuess = !isConfirmed && Boolean(state.predicted[axis.key]);
    /**
     * 세 상태를 색으로 구분한다:
     *   확정(사용자가 고름) = 진한 초록 채움  ·  추천+사용 ON = 연한 초록 채움(점선 유지)
     *   추천+사용 OFF       = 흐림 (값은 남겨 되돌릴 수 있게)
     */
    const isAutoOn = isGuess && state.useGuess;
    const isMutedGuess = isGuess && !state.useGuess;
    const isOpen = state.openAxis === axis.key;
    const cls = [
        'entry-context-seg',
        isConfirmed ? 'entry-context-seg--confirmed' : '',
        isAutoOn ? 'entry-context-seg--auto' : '',
        !value ? 'entry-context-seg--empty' : '',
        isMutedGuess ? 'entry-context-seg--muted' : '',
        isOpen ? 'entry-context-seg--open' : '',
    ].filter(Boolean).join(' ');
    const text = value ? escapeHtml(value) : `+ ${axis.label}`;
    const title = value ? `${axis.label} 고치기` : `${axis.label} 입력`;
    return `
        <button type="button" class="${cls}" data-context-seg="${axis.key}" title="${title}" aria-expanded="${isOpen}">
            <i data-lucide="${axis.icon}" aria-hidden="true"></i><span>${text}</span>
        </button>`;
}

/** 3단 뎁스 상한 — 피커가 두 줄을 넘기면 시트가 출렁인다 */
const SUB_OPTION_LIMIT = 8;

/**
 * 3단 뎁스 선택지 — **2단계에 종속된다.** '친구'를 골랐으면 친구 이름들만 나온다.
 *
 * 누구와만 이 뎁스를 쓴다. 어디서_상세는 실측 입력률이 0%이고 장소는 카카오 검색이
 * 주 경로다(docs/entry-sheet-redesign.md §4). 어떻게는 서브태그 개념 자체가 없다.
 *
 * **나만의 태그는 더 이상 보지 않는다** (2026-08-18). 미리 등록해 두는 목록 대신 그 부모로
 * 기록한 내 이력의 빈도를 쓴다 (js/utils/frequent-subtags.js) — 이 축이 favoriteSubTags 를
 * 읽던 마지막 자리였다. 이번에 적은 이름과 입력란에 이미 든 이름은 그대로 앞에 선다.
 */
function subOptionsForAxis(axisKey, parent) {
    if (axisKey !== 'withWhom' || !parent) return [];
    const frequent = frequentSubTagValues(window.mealHistory, {
        field: 'withWhomDetail',
        parentField: 'withWhom',
        parent,
        splitCommas: true,
        limit: SUB_OPTION_LIMIT,
    });
    // 이번에 직접 적은 이름과 이미 입력란에 든 이름도 알약으로 세운다
    const added = state.subAdded[parent] || [];
    const hidden = new Set(state.subHidden[parent] || []);
    return [...new Set([...added, ...frequent, ...currentWithDetailValues()])]
        .filter((v) => !hidden.has(v))
        .slice(0, SUB_OPTION_LIMIT);
}

/** 누구와 상세 입력란에 이미 들어 있는 이름들 (쉼표 다중값) */
function currentWithDetailValues() {
    return (document.getElementById('entryWithInput')?.value || '')
        .split(/[,，]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

function renderPicker() {
    const axis = AXES.find((a) => a.key === state.openAxis);
    if (!axis) return '';
    const current = axisValue(axis.key);
    const options = optionsForAxis(axis.key);
    const chips = options.length
        ? options.map((opt) => `
            <button type="button" class="entry-context-opt${opt === current ? ' entry-context-opt--on' : ''}" data-context-pick="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`).join('')
        : '<span class="entry-context-picker__empty">아직 쓸 만한 값이 없어요. 직접 입력해 주세요.</span>';
    /**
     * 어디서만 자유 입력 — 카테고리로 안 잡히는 장소는 직접 적거나 검색으로 (설계 §5).
     *
     * 추천 칩과 같은 흐름에 두면 "칩 하나 더"로 읽힌다 — 고르는 자리와 새로 적는 자리는
     * 층이 다르다. 패널 **바닥의 별도 칸**으로 내려 자리와 구분선으로 그 층을 말한다.
     *
     * **기본은 직접 입력**이다. 버튼 하나로 카카오 검색 시트를 띄우던 때는, 이름만 적으면
     * 되는 '집'·'회사' 같은 자리에도 지도 검색이 통째로 열려 과했다. 검색은 돋보기를
     * 눌렀을 때만 — 옆의 작은 버튼 하나로 좁힌다.
     *
     * 값의 주인은 여전히 entryWhereInput 하나이고 이 칸은 그 거울이다 — 그래서 현재
     * 확정값을 그대로 담고, 엔터·포커스 이동에서 굳힌다(누구와 상세 칸과 같은 규칙).
     */
    const free = axis.key === 'place'
        ? `<div class="entry-context-picker__foot">
               <div class="entry-context-place-free">
                   <button type="button" class="entry-context-place-free__search" data-context-search
                           aria-label="장소 검색" title="장소 검색">
                       <i data-lucide="search" aria-hidden="true"></i>
                   </button>
                   <input type="text" class="entry-context-place-free__input" data-context-place-input
                          value="${escapeHtml(current || '')}" placeholder="장소를 직접 적어요"
                          aria-label="어디서 직접 입력" enterkeyhint="done">
               </div>
           </div>`
        : '';
    /**
     * 3단 뎁스 — 2단계에서 값을 고른 상태면 **같은 패널 아래에 이어서** 펼친다.
     * 예전에는 이걸 '자세히' 접힘 안에서만 할 수 있었는데, 거기까지 가는 사람이 거의 없었다
     * (누구와_상세 입력률 5%). 2·3단계를 한 번에 보여 주면 탭 하나로 끝난다.
     */
    const subs = subOptionsForAxis(axis.key, current);
    const picked = axis.key === 'withWhom' ? currentWithDetailValues() : [];
    /**
     * 목록에 없는 이름은 **이 자리에서 바로** 받는다.
     * 처음에는 '자세히'를 펼쳐 그쪽 입력란으로 보냈는데, 이름 하나 적자고 축 섹션이
     * 통째로 열려 과했다. 값의 주인은 여전히 entryWithInput 하나이고 이 칸은 그 거울이다.
     */
    /**
     * 입력칸도 알약 모양이다 — 옆의 이름 알약들과 같은 줄에서 같은 높이로 흐른다.
     * 엔터를 치거나 포커스를 옮기면 적은 이름이 알약이 되어 선택된 상태로 들어간다.
     */
    const freeInput = state.subFreeOpen
        ? `<input type="text" class="entry-context-sub-input" data-context-sub-input
                  placeholder="이름 추가" aria-label="누구와 상세 추가" enterkeyhint="done">`
        : '<button type="button" class="entry-context-sub-more" data-context-sub-free>+ 직접 입력</button>';
    /**
     * 알약 하나 = [이름][×]. 이름을 누르면 선택/해제, ×는 목록에서 아예 지운다.
     * 삭제를 button 안의 button 으로 넣으면 HTML 이 깨지므로 span 에 역할을 준다.
     */
    const subChips = subs.map((s) => {
        const on = picked.includes(s);
        const safe = escapeHtml(s);
        return `<span class="entry-context-sub-opt${on ? ' entry-context-sub-opt--on' : ''}">
                    <button type="button" class="entry-context-sub-opt__label" data-context-sub="${safe}"
                            aria-pressed="${on}">${safe}</button>
                    <span class="entry-context-sub-opt__del" role="button" tabindex="0"
                          data-context-sub-del="${safe}" aria-label="${safe} 삭제">×</span>
                </span>`;
    }).join('');
    const subBlock = axis.key === 'withWhom' && current
        ? `<div class="entry-context-sub">
               <span class="entry-context-sub__label">${escapeHtml(current)} 중에</span>
               <div class="entry-context-sub__chips">${subChips}${freeInput}</div>
           </div>`
        : '';

    // 어느 축의 피커인지는 텍스트 라벨 대신 **열린 세그먼트의 하이라이트**가 말한다
    return `
        <div class="entry-context-picker">
            <div class="entry-context-picker__chips">${chips}</div>
            ${free}
            ${subBlock}
        </div>`;
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;
    const axes = visibleAxes();
    if (!state.active) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    /**
     * 행 구조: [헤더: 리드 텍스트 ─ 사용 토글] / [세그먼트들 + ⋯자세히] / [피커].
     *
     * 질문에 답하는 형태('맞아요/아니에요')가 아니라 **상태 토글**이다:
     * '사용'(기본 ON) ↔ '사용 안함'. 어느 쪽이든 버튼은 사라지지 않고
     * 언제든 되돌릴 수 있다 — 한 번 거부하면 되돌릴 수 없던 게 이전 방식의 문제였다.
     * OFF여도 추측값은 흐리게 남아 다시 켤 수 있다.
     * 개별 수정은 세그먼트 탭 → 피커에서 한다.
     */
    const hasAuto = axes.some((a) => state.predicted[a.key] && !state.confirmed[a.key]);
    const toggle = hasAuto
        ? `<button type="button" class="entry-predict-toggle${state.useGuess ? ' entry-predict-toggle--on' : ''}"
                data-predict-toggle role="switch" aria-checked="${state.useGuess}"
                aria-label="추천값 사용 ${state.useGuess ? '켜짐' : '꺼짐'}">
               <span class="entry-predict-toggle__label">${state.useGuess ? '사용' : '사용 안함'}</span>
               <span class="entry-predict-toggle__track"><span class="entry-predict-toggle__knob"></span></span>
           </button>`
        : '';
    // 추측이 있으면 그 사실을, 없으면 이 줄이 받는 질문들을 리드로 쓴다
    const lead = hasAuto ? '추천 분류' : axes.map((a) => a.label).join(' · ');
    el.innerHTML = `
        <div class="entry-context-head">
            <span class="entry-predict-lead">${lead}</span>
            ${toggle}
        </div>
        <div class="entry-context-segs">
            ${axes.map(renderSegment).join('')}
        </div>
        ${renderPicker()}`;
    el.classList.remove('hidden');
    refreshLucideIcons(el);
    // '직접 입력'을 연 직후에만 커서를 넣는다 — 칩을 탭할 때마다 뺏으면 성가시다
    if (pendingSubFreeFocus) {
        pendingSubFreeFocus = false;
        const free = el.querySelector('[data-context-sub-input]');
        if (free) {
            try {
                free.focus({ preventScroll: true });
            } catch (_) {
                free.focus();
            }
            const end = free.value.length;
            try {
                free.setSelectionRange(end, end);
            } catch (_) {
                /* 커서 위치는 부수적이다 */
            }
        }
    }
    // 엔터로 굳힌 직후에는 장소 칸에 커서를 남긴다 — 이어서 고쳐 적을 수 있게
    if (pendingPlaceFreeFocus) {
        pendingPlaceFreeFocus = false;
        const place = el.querySelector('[data-context-place-input]');
        if (place) {
            try {
                place.focus({ preventScroll: true });
            } catch (_) {
                place.focus();
            }
            const end = place.value.length;
            try {
                place.setSelectionRange(end, end);
            } catch (_) {
                /* 커서 위치는 부수적이다 */
            }
        }
    }
    // 피커가 열리면 시트를 그만큼 키우고(높이 잠금 재측정), 잘려 있으면 통째로 보이는 자리까지
    // 끌어온다 — 선택지를 보려고 사용자가 직접 스크롤하지 않게 한다.
    if (typeof window.syncEntrySheetHeightLock === 'function') window.syncEntrySheetHeightLock();
    if (state.openAxis) {
        const picker = el.querySelector('.entry-context-picker');
        if (picker) requestAnimationFrame(() => picker.scrollIntoView({ block: 'nearest' }));
    }
}

/**
 * 추천 분류 줄이 스크롤 밖으로 밀려나지 않게 시트를 굴린다.
 *
 * 이 줄 **위**에 뜨는 것들(✨분류 제안 · 회상 줄)은 '무엇을' 포커스와 함께 나타나 아래를
 * 통째로 밀어낸다. 시트가 커질 수 있는 폭은 정해져 있어(80vh · 레이아웃 상한) 상한에
 * 닿으면 늘어난 분이 스크롤로 흐르고, 그러면 이 줄의 아래가 스크롤 경계 밑으로 내려간다.
 * 모자란 만큼만 아래로 굴려 되돌린다. 두 가지는 지킨다:
 *   - 사용자가 직접 스크롤 중이면 손대지 않는다 (CTA 로 내려가는 걸 되감지 않기 위해)
 *   - 지금 치고 있는 '무엇을' 입력란이 위로 사라질 만큼은 굴리지 않는다
 */
export function keepEntryContextPredictVisible() {
    const modal = document.getElementById('entryModal');
    const el = document.getElementById(CONTAINER_ID);
    const area = modal?.querySelector('#modalScrollArea');
    if (!modal || !el || !area || el.classList.contains('hidden')) return;
    if (area.dataset?.entryUserScrolling === '1') return;
    /**
     * '무엇을'을 치고 있는 동안에만 보정한다. 시트를 막 열었을 때는 이 줄이 접힌 아래에
     * 있는 게 정상이고, 그때까지 끌어올리면 사진·날짜 머리가 위로 사라진다.
     */
    if (document.activeElement !== document.getElementById('entryWhatInput')) return;
    // 줄이 방금 렌더된 직후에도 불리므로 레이아웃이 굳은 다음 프레임에 잰다
    requestAnimationFrame(() => {
        if (!document.contains(el) || el.classList.contains('hidden')) return;
        if (area.dataset?.entryUserScrolling === '1') return;
        // 이미 끝까지 내려가 있으면 더 굴려도 달라지는 게 없다
        if (area.scrollTop >= area.scrollHeight - area.clientHeight - 1) return;
        const pad = 8;
        const areaRect = area.getBoundingClientRect();
        const need = el.getBoundingClientRect().bottom + pad - areaRect.bottom;
        if (need <= 1) return;
        const input = document.getElementById('entryWhatInput');
        const room = input
            ? input.getBoundingClientRect().top - (areaRect.top + pad)
            : Number.POSITIVE_INFINITY;
        const delta = Math.min(need, room);
        if (delta > 1) area.scrollTop += delta;
    });
}

/**
 * 확정값을 실제 입력 필드에 반영한다.
 * 2페이지 칩이 렌더돼 있으면 그 칩을 눌러 기존 동작(서브태그·라우팅)을 그대로 태우고,
 * 빠른입력이 꺼져 칩이 없으면 confirmed 값만 남긴다 — 저장 시 buildEntrySaveRecord가 병합한다.
 * @param {string} key @param {string} value
 */
function writeThrough(key, value) {
    if (key === 'place') {
        setVal('entryWhereInput', value);
        return;
    }
    const containerId = key === 'mealType' ? 'entryWhereChips' : 'entryWithChips';
    const chip = [...document.querySelectorAll(`#${containerId} button.chip`)].find(
        (b) => b.innerText.trim() === value
    );
    if (!chip || chip.classList.contains('active')) return;
    // 칩 클릭이 selectTag → 칩→줄 동기화를 다시 부르므로 그 왕복을 끊는다
    syncingMealTypeChips = key === 'mealType';
    try {
        chip.click();
    } finally {
        syncingMealTypeChips = false;
    }
}

/** @param {string} key @param {string} value */
function confirmAxis(key, value) {
    if (!value) return;
    state.confirmed[key] = value;
    state.predicted[key] = null;
    delete state.userCleared[key];
    writeThrough(key, value);
    // 장소 확정은 어떻게 추론의 입력 (피커에서 '집'을 고르면 집밥 추측이 뜰 수 있다)
    if (key === 'place') refreshMealTypeGuess();
    // 어떻게를 직접 골랐으면 어디서·누구와 추측은 근거가 바뀐다 — 그 자리에서 다시 뽑는다
    if (key === 'mealType') rederiveContextFromMealType();
}

/**
 * 축 비우기 — 피커에서 현재 값을 다시 탭하면 해제된다.
 * userCleared로 표시해 추측이 그 자리를 다시 채우지 않게 한다 (사용자의 거부는 존중).
 * @param {string} key
 */
function clearAxis(key) {
    state.confirmed[key] = null;
    state.predicted[key] = null;
    state.userCleared[key] = true;
    if (key === 'place') {
        setVal('entryWhereInput', '');
    } else {
        const containerId = key === 'mealType' ? 'entryWhereChips' : 'entryWithChips';
        const active = document.querySelector(`#${containerId} button.chip.active`);
        if (active) active.click(); // 토글 해제 — 기존 selectTag 경로로 입력값도 정리된다
    }
}

/**
 * 3단 뎁스 칩 탭 — 누구와 상세 입력란에 이름을 넣거나 뺀다(쉼표 다중값).
 * 값의 주인은 계속 `entryWithInput`(= withWhomDetail)이다. 여기서 별도 상태를 들지 않는 이유는
 * '자세히' 안의 입력란과 두 곳이 같은 값을 들고 어긋나는 걸 막기 위해서다.
 */
function toggleWithDetail(name) {
    const input = document.getElementById('entryWithInput');
    if (!input || !name) return;
    const values = currentWithDetailValues();
    const idx = values.indexOf(name);
    if (idx >= 0) values.splice(idx, 1);
    else values.push(name);
    input.value = values.join(', ');
    // 기존 리스너(서브칩 활성 표시 등)를 그대로 태운다
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 입력칸의 이름을 알약으로 굳힌다 (엔터 · 포커스 이동).
 * 쉼표로 여러 개를 한 번에 적어도 각각 알약이 된다.
 * @returns {boolean} 실제로 만든 게 있으면 true
 */
/**
 * 장소 직접 입력 칸을 굳힌다 — 엔터 / 포커스 이동에서 불린다.
 * 값의 주인은 entryWhereInput 이므로 confirmAxis 를 그대로 태운다(어떻게 추론도 함께 갱신).
 * 비우면 축을 비운 것으로 본다 — 사용자가 지운 것이니 추측이 다시 채우지 않는다.
 * @returns {boolean} 값이 바뀌어 다시 그려야 하면 true
 */
function commitPlaceFreeInput() {
    const el = document.getElementById(CONTAINER_ID);
    const input = el?.querySelector('[data-context-place-input]');
    if (!input) return false;
    const value = (input.value || '').trim();
    if (value === (axisValue('place') || '')) return false;
    if (value) {
        confirmAxis('place', value);
        logUsageMetric('context_place_typed').catch(() => {});
    } else {
        clearAxis('place');
    }
    return true;
}

function commitSubFreeInput() {
    const el = document.getElementById(CONTAINER_ID);
    const free = el?.querySelector('[data-context-sub-input]');
    const parent = axisValue('withWhom');
    if (!free || !parent) return false;
    const names = free.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
    free.value = '';
    if (names.length === 0) return false;
    if (!Array.isArray(state.subAdded[parent])) state.subAdded[parent] = [];
    const bag = state.subAdded[parent];
    const values = currentWithDetailValues();
    for (const name of names) {
        if (!bag.includes(name)) bag.push(name);
        if (!values.includes(name)) values.push(name);
    }
    const input = document.getElementById('entryWithInput');
    if (input) {
        input.value = values.join(', ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    logUsageMetric('context_sub_added').catch(() => {});
    return true;
}

/**
 * 알약을 목록에서 지운다 — 선택 해제(재탭)와 다르다.
 *
 * **이번 시트에서만 감춘다.** 목록이 내 이력의 빈도에서 나오므로(js/utils/frequent-subtags.js)
 * 저장된 값을 지울 방법이 없다 — 지운 척하고 다음 기록에서 되살아나느니, 감추는 것이
 * 실제로 하는 일이라고 말하는 편이 낫다. 그 이름이 계속 뜨는 게 싫다면 그렇게 저장된
 * 기록을 고치면 된다. 이번에 직접 적은 이름은 아직 저장 전이라 완전히 사라진다.
 */
function deleteSubOption(name, parent) {
    if (!name || !parent) return;
    const bag = state.subAdded[parent];
    if (Array.isArray(bag)) state.subAdded[parent] = bag.filter((v) => v !== name);
    if (!Array.isArray(state.subHidden[parent])) state.subHidden[parent] = [];
    if (!state.subHidden[parent].includes(name)) state.subHidden[parent].push(name);

    // 입력란에 들어 있었다면 함께 뺀다 — 목록에 없는 값이 저장되면 안 된다
    const values = currentWithDetailValues().filter((v) => v !== name);
    const input = document.getElementById('entryWithInput');
    if (input) {
        input.value = values.join(', ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
        logUsageMetric('context_sub_deleted').catch(() => {});
}

function onContainerClick(e) {
    const del = e.target.closest('[data-context-sub-del]');
    if (del) {
        e.preventDefault();
        e.stopPropagation();
        deleteSubOption(del.getAttribute('data-context-sub-del') || '', axisValue('withWhom'));
        render();
        return;
    }
    const subOpt = e.target.closest('[data-context-sub]');
    if (subOpt) {
        toggleWithDetail(subOpt.getAttribute('data-context-sub') || '');
        logUsageMetric('context_sub_picked').catch(() => {});
        render();
        return;
    }
    if (e.target.closest('[data-context-sub-free]')) {
        state.subFreeOpen = true;
        pendingSubFreeFocus = true;
        render();
        return;
    }
    const seg = e.target.closest('[data-context-seg]');
    if (seg) {
        const key = seg.getAttribute('data-context-seg');
        state.openAxis = state.openAxis === key ? null : key;
        state.subFreeOpen = false; // 축을 옮기면 직접 입력 칸은 접는다
        render();
        return;
    }
    const pick = e.target.closest('[data-context-pick]');
    if (pick) {
        const key = state.openAxis;
        if (key) {
            const value = pick.getAttribute('data-context-pick') || '';
            if (value && value === axisValue(key)) {
                // 현재 값을 다시 탭 = 해제 (추측 거부 또는 선택 취소)
                clearAxis(key);
                logUsageMetric('context_predict_dismissed').catch(() => {});
            } else {
                confirmAxis(key, value);
                logUsageMetric('context_predict_applied').catch(() => {});
            }
        }
        // 피커는 열어 둔다 — 닫는 건 해당 구분 세그먼트를 다시 누를 때뿐이다.
        // (고르자마자 닫히면 연달아 고쳐보기가 어렵고 화면이 튀는 느낌을 준다)
        render();
        return;
    }
    if (e.target.closest('[data-predict-toggle]')) {
        // 상태 토글 — 값은 지우지 않는다. OFF는 "저장에 쓰지 않음"일 뿐 되돌릴 수 있다
        state.useGuess = !state.useGuess;
        logUsageMetric(state.useGuess ? 'context_predict_applied' : 'context_predict_dismissed').catch(() => {});
        render();
        return;
    }
    /**
     * '세부' 칩은 현재 렌더하지 않는다 (모양 검토 중 제외). 핸들러는 남겨둔다 —
     * 다시 붙이면 바로 동작하고, window.toggleEntryAxisDetail 로도 열 수 있다.
     * ⚠️ 칩이 없는 동안 전체 축 섹션(건너뜀 칩·서브태그·누구와 상세)에 UI 진입점이 없다.
     */
    if (e.target.closest('[data-context-more]')) {
        if (typeof window.toggleEntryAxisDetail === 'function') window.toggleEntryAxisDetail();
        render();
        return;
    }
    if (e.target.closest('[data-context-search]')) {
        // 검색은 **돋보기를 눌렀을 때만** — 옆 입력칸은 직접 적는 자리다.
        // 카카오 검색 시트는 entryWhereInput에 값을 넣는다 — 닫힌 뒤 그 값을 확정으로 승격.
        // 피커는 열어 둬서 검색을 취소해도 원래 자리로 돌아온다
        if (typeof window.openKakaoPlaceSearch === 'function') window.openKakaoPlaceSearch();
        return;
    }
}

/**
 * 어디서 입력이 이 줄 밖에서 바뀐 경우(카카오 검색·2페이지 직접 입력) 세그먼트에 반영.
 * 사용자가 직접 넣은 값이므로 확정 취급이다 — 추측이 아니다.
 */
export function syncEntryContextPlaceFromInput() {
    if (!state.active) return;
    const v = (document.getElementById('entryWhereInput')?.value || '').trim();
    if (state.confirmed.place === (v || null)) return;
    // 지운 경우: 확정 회수 + 사용자의 비움 존중(추측 재채움 금지) + 어떻게 추측 재계산
    state.confirmed.place = v || null;
    state.predicted.place = null;
    if (v) delete state.userCleared.place;
    else state.userCleared.place = true;
    render();
    // 장소가 바뀌면 어떻게 추론의 입력이 바뀐다 (카카오 픽→외식 등)
    refreshMealTypeGuess();
}

/** 시트 초기화 시 1회 — 클릭 위임 바인딩 */
export function initEntryContextPredict() {
    const el = document.getElementById(CONTAINER_ID);
    if (el && !el._contextPredictBound) {
        el._contextPredictBound = true;
        el.addEventListener('click', onContainerClick);
        // 엔터 = 지금 적은 이름을 알약으로 굳히고 계속 적을 수 있게 커서를 남긴다
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            if (e.target.closest?.('[data-context-place-input]')) {
                e.preventDefault();
                if (commitPlaceFreeInput()) {
                    pendingPlaceFreeFocus = true;
                    render();
                }
                return;
            }
            if (!e.target.closest?.('[data-context-sub-input]')) return;
            e.preventDefault();
            if (commitSubFreeInput()) {
                pendingSubFreeFocus = true;
                render();
            }
        });
        /**
         * 포커스를 옮겨도 굳힌다. 곧바로 하지 않고 한 박자 늦추는 이유는,
         * 옆 알약을 누르려던 경우 blur → (여기서 재렌더) → click 순서가 되면 그 클릭이
         * 사라진 노드를 치기 때문이다. 늦추면 click 이 먼저 처리된다.
         */
        el.addEventListener('focusout', (e) => {
            if (e.target.closest?.('[data-context-place-input]')) {
                clearTimeout(subFreeCommitTimer);
                subFreeCommitTimer = setTimeout(() => {
                    if (commitPlaceFreeInput()) render();
                }, SUB_FREE_COMMIT_DELAY_MS);
                return;
            }
            if (!e.target.closest?.('[data-context-sub-input]')) return;
            clearTimeout(subFreeCommitTimer);
            subFreeCommitTimer = setTimeout(() => {
                if (commitSubFreeInput()) render();
            }, SUB_FREE_COMMIT_DELAY_MS);
        });
        el.addEventListener('focusin', (e) => {
            if (e.target.closest?.('[data-context-sub-input], [data-context-place-input]')) {
                clearTimeout(subFreeCommitTimer);
            }
        });
    }
    const placeInput = document.getElementById('entryWhereInput');
    if (placeInput && !placeInput._contextPredictSync) {
        placeInput._contextPredictSync = true;
        placeInput.addEventListener('change', syncEntryContextPlaceFromInput);
    }
}
