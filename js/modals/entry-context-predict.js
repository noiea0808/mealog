/**
 * 기록 시트 — 어디서·누구와 예측 한 줄 (docs/entry-sheet-redesign.md §2 2층)
 *
 * 습관-추측 원칙: 과거 패턴에서 예측한 값은 "맞아요" 탭이라는 명시적 확인 없이는
 * 절대 저장되지 않는다. 탭 없이 저장하면 두 필드 모두 빈 값이다.
 *
 * 예측 키: (slotId × 평일/주말) 최빈값 — 슬롯 표본 3건+ · 점유 60%+.
 * 표본 부족 시 사용자 전체(슬롯 무관) 최빈값으로 폴백 (같은 문턱).
 * 콜드 스타트(문턱 미달)면 줄 자체가 없다 — 기존 칩 그리드가 그대로 콜드 스타트 UI.
 *
 * 전부 로컬 계산(window.mealHistory)·best-effort — 실패는 "줄 없음"일 뿐이다.
 */
import { appState } from '../state.js';
import { setVal } from '../utils.js';
import { refreshLucideIcons } from '../icons.js';
import { logUsageMetric } from '../usage-metrics.js';
import { dominantPlaceGroup } from '../utils/place-normalize.js';

const CONTAINER_ID = 'entryContextPredict';
const MIN_SAMPLES = 3;
const MODE_SHARE = 0.6;
const RECENT_LIMIT = 30;

const state = {
    predicted: /** @type {{ place: string|null, withWhom: string|null }} */ ({ place: null, withWhom: null }),
    confirmed: /** @type {{ place: string|null, withWhom: string|null }} */ ({ place: null, withWhom: null }),
    dismissed: false,
};

/**
 * 저장 어댑터가 읽는 확정값. "맞아요"를 탭한 경우에만 값이 있다.
 * @returns {{ place: string|null, withWhom: string|null }}
 */
export function getEntryContextPredictConfirm() {
    return { ...state.confirmed };
}

export function resetEntryContextPredict() {
    state.predicted = { place: null, withWhom: null };
    state.confirmed = { place: null, withWhom: null };
    state.dismissed = false;
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

/**
 * @param {any[]} history window.mealHistory
 * @param {'place'|'withWhom'} field
 * @param {string} slotId
 * @param {boolean} weekend
 * @returns {string|null}
 */
function predictField(history, field, slotId, weekend) {
    const withValue = history.filter(
        (r) => r && !isSkipRecord(r) && typeof r[field] === 'string' && r[field].trim()
    );
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
 * 시트 열림이 끝난 뒤 호출. 비어 있는 필드에 대해서만 예측 줄을 띄운다.
 * @param {{ slotId: string, dateStr: string, isSnack: boolean }} args
 */
export function setupEntryContextPredict({ slotId, dateStr, isSnack }) {
    try {
        resetEntryContextPredict();
        if (isSnack || !slotId || !dateStr) return;

        const placeFilled = Boolean((document.getElementById('entryWhereInput')?.value || '').trim());
        const withFilled =
            Boolean(document.querySelector('#entryWithChips button.chip.active')) ||
            Boolean((document.getElementById('entryWithInput')?.value || '').trim());

        const history = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        const weekend = isWeekendDate(dateStr);
        state.predicted = {
            place: placeFilled ? null : predictField(history, 'place', slotId, weekend),
            withWhom: withFilled ? null : predictField(history, 'withWhom', slotId, weekend),
        };
        if (state.predicted.place || state.predicted.withWhom) {
            logUsageMetric('context_predict_shown').catch(() => {});
        }
        render();
    } catch (_) {
        /* 예측 실패 = 줄 없음. 시트 열기에 영향 금지 */
    }
}

function render() {
    const el = document.getElementById(CONTAINER_ID);
    if (!el) return;
    const { place, withWhom } = state.predicted;
    if (state.dismissed || (!place && !withWhom)) {
        el.innerHTML = '';
        el.classList.add('hidden');
        return;
    }
    const parts = [];
    if (place) {
        parts.push(
            `<span class="entry-predict-value"><i data-lucide="map-pin" aria-hidden="true"></i>${escapeHtml(place)}</span>`
        );
    }
    if (withWhom) {
        parts.push(
            `<span class="entry-predict-value"><i data-lucide="user" aria-hidden="true"></i>${escapeHtml(withWhom)}</span>`
        );
    }
    el.innerHTML = `
        <span class="entry-predict-lead">지난 기록처럼</span>
        ${parts.join('<span class="entry-predict-sep">·</span>')}
        <button type="button" class="entry-predict-apply" data-predict-apply>맞아요</button>
        <button type="button" class="entry-predict-dismiss" data-predict-dismiss aria-label="예측 제안 닫기">
            <i data-lucide="x" aria-hidden="true"></i>
        </button>`;
    el.classList.remove('hidden');
    refreshLucideIcons(el);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function applyPrediction() {
    const { place, withWhom } = state.predicted;
    if (place) {
        setVal('entryWhereInput', place);
        state.confirmed.place = place;
    }
    if (withWhom) {
        // 칩이 렌더돼 있으면 실제 선택으로 반영 (서브태그 패널 등 기존 동작 포함)
        const chip = [...document.querySelectorAll('#entryWithChips button.chip')].find(
            (b) => b.innerText.trim() === withWhom
        );
        if (chip) chip.click();
        // 칩이 없어도(빠른입력 꺼짐) 저장 시 병합되도록 확정값을 남긴다
        state.confirmed.withWhom = withWhom;
    }
    state.predicted = { place: null, withWhom: null };
    render();
}

function onContainerClick(e) {
    if (e.target.closest('[data-predict-apply]')) {
        logUsageMetric('context_predict_applied').catch(() => {});
        applyPrediction();
        return;
    }
    if (e.target.closest('[data-predict-dismiss]')) {
        state.dismissed = true;
        logUsageMetric('context_predict_dismissed').catch(() => {});
        render();
    }
}

/** 시트 초기화 시 1회 — 클릭 위임 바인딩 */
export function initEntryContextPredict() {
    const el = document.getElementById(CONTAINER_ID);
    if (el && !el._contextPredictBound) {
        el._contextPredictBound = true;
        el.addEventListener('click', onContainerClick);
    }
}
