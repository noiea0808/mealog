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
import { getAxis1TagList } from './entry-form-config.js';

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
     * 추측을 이대로 쓸지. **기본 OFF** — 맥락 축은 "쓴다/안 쓴다"가 먼저이고,
     * 추천은 그 축을 쓰기로 했을 때 채워질 값으로 미리 들어가 있는 것이다.
     * (원칙 2 "추측은 확인 없이 데이터가 되지 않는다"도 이 기본값에서 지켜진다)
     */
    useGuess: false,
    /** 습관 예측 원본(이력 최빈값) — 사실-유도 추론과 합성할 때 참조 */
    habitMealType: /** @type {string|null} */ (null),
    /** 무엇을 자동 분류의 현재 1순위 (entry-category-suggest가 밀어줌) */
    foodCategory: /** @type {string|null} */ (null),
    /** 인라인 피커가 열린 축 (null이면 닫힘) */
    openAxis: /** @type {string|null} */ (null),
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
    state.useGuess = false;
    state.habitMealType = null;
    state.foodCategory = null;
    state.openAxis = null;
    state.active = false;
    render();
}

function isWeekendDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    const w = d.getDay();
    return w === 0 || w === 6;
}

function isSkipRecord(r) {
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

    const anySamples = sorted.slice(0, RECENT_LIMIT).map((r) => r[field].trim());
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

/** 축별 피커에 올릴 선택지 */
function optionsForAxis(axisKey) {
    const tags = window.userSettings?.tags || {};
    if (axisKey === 'mealType') {
        return getAxis1TagList('meal', tags).filter((t) => t !== '건너뜀' && t !== 'Skip');
    }
    if (axisKey === 'withWhom') {
        return Array.isArray(tags.withWhom) ? tags.withWhom : [];
    }
    return recentPlaceChips(Array.isArray(window.mealHistory) ? window.mealHistory : []);
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
 * 1. 카카오 장소 픽 → placeType이 식당/술집/카페면 '외식' (사용자가 고른 장소의 객관 속성)
 * 2. 장소 표기가 '구내식당' → '구내식당' (장소가 값 자체)
 * 3. 장소가 집 그룹 + 무엇을 분류가 밥/한상 → '집밥' (집에서 차린 한 상)
 *    — 집에서 배달을 먹는 반례가 있어 확신은 아니지만, 점선 추측 + 확인 장치가 받는다.
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
        if (!raw) return null;
        const norm = normalizePlace(raw);
        if (norm.includes('구내식당')) return '구내식당';
        if (norm === '집' && state.foodCategory === '밥/한상') return '집밥';
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
        render();
    }
}

/**
 * 무엇을 자동 분류의 1순위가 바뀔 때 entry-category-suggest가 호출.
 * '집+밥/한상→집밥' 추론의 입력이 된다.
 * @param {string|null} category
 */
export function updateEntryContextFoodCategory(category) {
    const next = category || null;
    if (state.foodCategory === next) return;
    state.foodCategory = next;
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
         * 간식도 줄은 활성화하되 **예측은 하지 않는다** — 간식 place 입력률·반복성
         * 데이터를 본 뒤 판단하기로 한 결정(place-axis-unification.md §3) 유지.
         * 빈 트리거(+ 어디서 · + 누구와)와 ⋯(자세히)만 제공해 입력 진입점을 통일한다.
         */
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

        if (isSnack) {
            render();
            return;
        }

        const mealTypeFilled = Boolean(existing.mealType);
        const placeFilled = Boolean(existing.place);
        const withFilled =
            Boolean(existing.withWhom) ||
            Boolean((document.getElementById('entryWithInput')?.value || '').trim());

        const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        const weekend = isWeekendDate(dateStr);
        state.habitMealType = mealTypeFilled ? null : predictField(history, 'mealType', slotId, weekend);
        state.predicted = {
            // 어떻게는 습관 예측 + 사실-유도 추론(카카오 픽·장소 표기·음식 분류)의 합성
            mealType: mealTypeFilled ? null : (inferMealTypeFromFacts() || state.habitMealType),
            place: placeFilled ? null : predictField(history, 'place', slotId, weekend),
            withWhom: withFilled ? null : predictField(history, 'withWhom', slotId, weekend),
        };
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
    // 토글 OFF일 때 추측 세그먼트는 값을 남긴 채 흐려진다 — 되돌릴 수 있으려면 보여야 한다
    const isMutedGuess = !isConfirmed && Boolean(state.predicted[axis.key]) && !state.useGuess;
    const isOpen = state.openAxis === axis.key;
    const cls = [
        'entry-context-seg',
        isConfirmed ? 'entry-context-seg--confirmed' : '',
        !value ? 'entry-context-seg--empty' : '',
        isMutedGuess ? 'entry-context-seg--muted' : '',
        isOpen ? 'entry-context-seg--open' : '',
    ].filter(Boolean).join(' ');
    const text = value ? escapeHtml(value) : `+ ${axis.label}`;
    const title = value ? `${axis.label} 고치기` : `${axis.label} 입력`;
    return `
        <button type="button" class="${cls}" data-context-seg="${axis.key}" title="${title}" aria-expanded="${isOpen}">
            <i data-lucide="${axis.icon}" aria-hidden="true"></i><span>${text}</span>
            <i data-lucide="chevron-down" class="entry-context-seg__caret" aria-hidden="true"></i>
        </button>`;
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
    // 어디서만 자유 입력 — 카테고리로 안 잡히는 장소는 검색·직접 입력으로 (설계 §5)
    const free = axis.key === 'place'
        ? `<button type="button" class="entry-context-free" data-context-search>
               <i data-lucide="search" aria-hidden="true"></i>장소 검색 · 직접 입력
           </button>`
        : '';
    // 어느 축의 피커인지는 텍스트 라벨 대신 **열린 세그먼트의 하이라이트**가 말한다
    return `
        <div class="entry-context-picker">
            <div class="entry-context-picker__chips">${chips}</div>
            ${free}
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
     * '이대로 사용'(기본 ON) ↔ '사용 안함'. 어느 쪽이든 버튼은 사라지지 않고
     * 언제든 되돌릴 수 있다 — 한 번 거부하면 되돌릴 수 없던 게 이전 방식의 문제였다.
     * OFF여도 추측값은 흐리게 남아 다시 켤 수 있다.
     * 개별 수정은 세그먼트 탭 → 피커에서 한다.
     */
    const hasAuto = axes.some((a) => state.predicted[a.key] && !state.confirmed[a.key]);
    const axisDetailOpen = !document.getElementById('entryAxisFields')?.classList.contains('hidden');
    const toggle = hasAuto
        ? `<button type="button" class="entry-predict-toggle${state.useGuess ? ' entry-predict-toggle--on' : ''}"
                data-predict-toggle role="switch" aria-checked="${state.useGuess}"
                aria-label="추천값 사용 ${state.useGuess ? '켜짐' : '꺼짐'}">
               <span class="entry-predict-toggle__track"><span class="entry-predict-toggle__knob"></span></span>
               <span class="entry-predict-toggle__label">${state.useGuess ? '이대로 사용' : '사용 안함'}</span>
           </button>`
        : '';
    // 추측이 있으면 근거("지난 기록처럼")를, 없으면 이 줄이 받는 질문들을 리드로 쓴다
    const lead = hasAuto ? '지난 기록처럼' : axes.map((a) => a.label).join(' · ');
    el.innerHTML = `
        <div class="entry-context-head">
            <span class="entry-predict-lead">${lead}</span>
            ${toggle}
        </div>
        <div class="entry-context-segs">
            ${axes.map(renderSegment).join('')}
            <button type="button" class="entry-context-seg entry-context-seg--more${axisDetailOpen ? ' entry-context-seg--open' : ''}" data-context-more title="세부 항목 직접 입력" aria-expanded="${axisDetailOpen}" aria-controls="entryAxisFields">
                <i data-lucide="sliders-horizontal" aria-hidden="true"></i><span>세부</span>
            </button>
        </div>
        ${renderPicker()}`;
    el.classList.remove('hidden');
    refreshLucideIcons(el);
    // 피커가 열리면 시트를 그만큼 키우고(높이 잠금 재측정), 잘려 있으면 통째로 보이는 자리까지
    // 끌어온다 — 선택지를 보려고 사용자가 직접 스크롤하지 않게 한다.
    if (typeof window.syncEntrySheetHeightLock === 'function') window.syncEntrySheetHeightLock();
    if (state.openAxis) {
        const picker = el.querySelector('.entry-context-picker');
        if (picker) requestAnimationFrame(() => picker.scrollIntoView({ block: 'nearest' }));
    }
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
    if (chip && !chip.classList.contains('active')) chip.click();
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

function onContainerClick(e) {
    const seg = e.target.closest('[data-context-seg]');
    if (seg) {
        const key = seg.getAttribute('data-context-seg');
        state.openAxis = state.openAxis === key ? null : key;
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
    if (e.target.closest('[data-context-more]')) {
        // '세부' = 전체 축 섹션(건너뜀·서브태그·누구와 상세) 여닫기 — 상태는 render가 다시 읽는다
        if (typeof window.toggleEntryAxisDetail === 'function') window.toggleEntryAxisDetail();
        render();
        return;
    }
    if (e.target.closest('[data-context-search]')) {
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
    }
    const placeInput = document.getElementById('entryWhereInput');
    if (placeInput && !placeInput._contextPredictSync) {
        placeInput._contextPredictSync = true;
        placeInput.addEventListener('change', syncEntryContextPlaceFromInput);
    }
}
