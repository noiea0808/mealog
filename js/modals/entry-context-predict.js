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
 * 습관-추측 원칙: 예측값은 "맞아요" 또는 조각 직접 선택이라는 명시적 확인 없이는
 * 절대 저장되지 않는다. 확인 없이 저장하면 세 필드 모두 빈 값이다.
 * 미확인 조각은 점선으로, 확인된 조각은 실선으로 구분한다.
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
    dismissed: false,
    /** 인라인 피커가 열린 축 (null이면 닫힘) */
    openAxis: /** @type {string|null} */ (null),
    active: false,
};

/**
 * 저장 어댑터가 읽는 확정값. "맞아요" 또는 조각 선택으로 확인한 경우에만 값이 있다.
 * @returns {{ mealType: string|null, place: string|null, withWhom: string|null }}
 */
export function getEntryContextPredictConfirm() {
    return { ...state.confirmed };
}

export function resetEntryContextPredict() {
    state.predicted = { mealType: null, place: null, withWhom: null };
    state.confirmed = { mealType: null, place: null, withWhom: null };
    state.dismissed = false;
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
            !(field === 'mealType' && MEALTYPE_PREDICT_EXCLUDE.has(r[field].trim()))
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
 * 시트 열림이 끝난 뒤 호출. 비어 있는 필드에 대해서만 예측한다.
 * @param {{ slotId: string, dateStr: string, isSnack: boolean }} args
 */
export function setupEntryContextPredict({ slotId, dateStr, isSnack }) {
    try {
        resetEntryContextPredict();
        if (isSnack || !slotId || !dateStr) return;
        state.active = true;

        const mealTypeFilled = Boolean(document.querySelector('#entryWhereChips button.chip.active'));
        const placeFilled = Boolean((document.getElementById('entryWhereInput')?.value || '').trim());
        const withFilled =
            Boolean(document.querySelector('#entryWithChips button.chip.active')) ||
            Boolean((document.getElementById('entryWithInput')?.value || '').trim());

        const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        const weekend = isWeekendDate(dateStr);
        state.predicted = {
            mealType: mealTypeFilled ? null : predictField(history, 'mealType', slotId, weekend),
            place: placeFilled ? null : predictField(history, 'place', slotId, weekend),
            withWhom: withFilled ? null : predictField(history, 'withWhom', slotId, weekend),
        };
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
    const isOpen = state.openAxis === axis.key;
    const cls = [
        'entry-context-seg',
        isConfirmed ? 'entry-context-seg--confirmed' : '',
        !value ? 'entry-context-seg--empty' : '',
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
    return `
        <div class="entry-context-picker">
            <span class="entry-context-picker__label">${axis.label}</span>
            <div class="entry-context-picker__chips">${chips}</div>
            ${free}
        </div>`;
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;
    const axes = visibleAxes();
    const hasAnything = axes.some((a) => axisValue(a.key)) || state.openAxis;
    if (!state.active || state.dismissed) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    // 미확인 예측이 하나라도 있을 때만 "맞아요" — 전부 확정됐으면 버튼은 사라진다
    const hasUnconfirmed = axes.some((a) => state.predicted[a.key] && !state.confirmed[a.key]);
    el.innerHTML = `
        <div class="entry-context-line">
            <span class="entry-predict-lead">${hasAnything ? '지난 기록처럼' : '맥락'}</span>
            ${axes.map(renderSegment).join('')}
            ${hasUnconfirmed ? '<button type="button" class="entry-predict-apply" data-predict-apply>맞아요</button>' : ''}
            <button type="button" class="entry-predict-dismiss" data-predict-dismiss aria-label="맥락 줄 닫기">
                <i data-lucide="x" aria-hidden="true"></i>
            </button>
        </div>
        ${renderPicker()}`;
    el.classList.remove('hidden');
    refreshLucideIcons(el);
    if (typeof window.syncEntrySheetHeightLock === 'function') window.syncEntrySheetHeightLock();
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
    writeThrough(key, value);
}

function applyAllPredictions() {
    /**
     * 어떻게를 먼저 확정한다 — 칩 클릭이 어디서 기본값 라우팅(집밥→우리집 등)을
     * 발화시키므로, 그 뒤에 예측 place를 써야 예측값이 기본값을 덮는 올바른 순서가 된다.
     */
    for (const axis of visibleAxes()) {
        const predicted = state.predicted[axis.key];
        if (predicted && !state.confirmed[axis.key]) confirmAxis(axis.key, predicted);
    }
    state.openAxis = null;
    render();
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
            confirmAxis(key, pick.getAttribute('data-context-pick') || '');
            logUsageMetric('context_predict_applied').catch(() => {});
        }
        state.openAxis = null;
        render();
        return;
    }
    if (e.target.closest('[data-context-search]')) {
        // 카카오 검색 시트는 entryWhereInput에 값을 넣는다 — 닫힌 뒤 그 값을 확정으로 승격
        state.openAxis = null;
        render();
        if (typeof window.openKakaoPlaceSearch === 'function') window.openKakaoPlaceSearch();
        return;
    }
    if (e.target.closest('[data-predict-apply]')) {
        logUsageMetric('context_predict_applied').catch(() => {});
        applyAllPredictions();
        return;
    }
    if (e.target.closest('[data-predict-dismiss]')) {
        state.dismissed = true;
        state.openAxis = null;
        logUsageMetric('context_predict_dismissed').catch(() => {});
        render();
    }
}

/**
 * 어디서 입력이 이 줄 밖에서 바뀐 경우(카카오 검색·2페이지 직접 입력) 세그먼트에 반영.
 * 사용자가 직접 넣은 값이므로 확정 취급이다 — 추측이 아니다.
 */
export function syncEntryContextPlaceFromInput() {
    if (!state.active || state.dismissed) return;
    const v = (document.getElementById('entryWhereInput')?.value || '').trim();
    if (!v || state.confirmed.place === v) return;
    state.confirmed.place = v;
    state.predicted.place = null;
    render();
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
