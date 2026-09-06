// 밀당 건강 탭 — 체중·혈당 일별 차트
// 보기 두 가지: 라인(복수 기록일은 마지막 값 + 점마다 수치) / 캔들(시고저종)
import { getDailyJournalFromSettings } from '../utils/daily-journal-data.js';
import { defaultMemoKey, MEMO_SLOT_ID } from '../utils/slot-plan.js';
import { formatMealogDateLabel } from '../utils/date-label.js';
import { formatMealClockTagLabel } from '../meal-time-utils.js';

const WEEKDAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

const chartInstances = new Map();

const POINT_HIT_RADIUS = 14;
/** 한 달(31일) 이하는 뷰포트에 맞춤 — 그보다 길면(연간 등) 가로 스크롤 */
const VITALS_DAYS_PER_VIEWPORT = 31;
/** 연간 등 좁은 일별 폭에서도 탭 인식 (px) */
const VITALS_MIN_HIT_PX = 28;
const VITALS_TAP_MOVE_PX = 10;

let bubbleDismissBound = false;
let activeBubbleCanvasId = null;
let vitalsBubbleSuppressDismiss = false;

/**
 * 체중·혈당 공통 색
 * - 당일 1건: 중립 닷
 * - 당일 2건+: 당일 첫 기록(시) vs 마지막(종) — 상승 주황, 하락 파랑
 */
const VITALS_CHART_COLORS = {
    dot: '#64748b',
    line: '#cbd5e1',
    fill: 'transparent',
    intradayUp: '#ea580c',
    intradayDown: '#2563eb'
};

const POINT_RADIUS = 4;
const POINT_HOVER_RADIUS = 6;

/** 라인 보기에서 점 위 수치 — 이 간격보다 좁으면 건너뛴다 (겹침 방지) */
const VALUE_LABEL_MIN_GAP_PX = 32;
const VALUE_LABEL_COLOR = '#475569';

const VITALS_VIEW_LINE = 'line';
const VITALS_VIEW_CANDLE = 'candle';
const VITALS_VIEW_STORAGE_KEY = 'mealog_vitalsChartView';

/** 체중·혈당은 읽는 결이 달라 보기 모드를 따로 기억한다 */
const vitalsViewModes = { weight: VITALS_VIEW_CANDLE, bloodSugar: VITALS_VIEW_CANDLE };

/** metric -> 마지막 렌더 인자 (보기 전환 때 그 차트만 다시 그린다) */
const lastVitalsRender = new Map();

function isVitalsView(mode) {
    return mode === VITALS_VIEW_LINE || mode === VITALS_VIEW_CANDLE;
}

function loadVitalsViewModes() {
    try {
        const raw = localStorage.getItem(VITALS_VIEW_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        Object.keys(vitalsViewModes).forEach((m) => {
            if (isVitalsView(parsed?.[m])) vitalsViewModes[m] = parsed[m];
        });
    } catch (_) {
        /* 저장값이 깨져도 기본(캔들)으로 간다 */
    }
}
loadVitalsViewModes();

export function getVitalsChartView(metric) {
    return vitalsViewModes[metric] || VITALS_VIEW_CANDLE;
}

/** 보기 전환 — 저장하고 그 metric 차트만 다시 그린다 */
export function setVitalsChartView(metric, mode) {
    if (!isVitalsView(mode) || !(metric in vitalsViewModes)) return false;
    if (vitalsViewModes[metric] === mode) return false;
    vitalsViewModes[metric] = mode;
    try {
        localStorage.setItem(VITALS_VIEW_STORAGE_KEY, JSON.stringify(vitalsViewModes));
    } catch (_) {
        /* 저장 실패는 이번 세션만 유지하고 넘어간다 */
    }
    const last = lastVitalsRender.get(metric);
    if (last) renderVitalsChart(last.canvasId, last.emptyId, last.series, last.opts);
    return true;
}

/** 스위치 버튼 활성 상태를 현재 모드에 맞춘다 */
function setVitalsViewSwitchVisible(metric, visible) {
    document
        .querySelectorAll('[data-vitals-view][data-vitals-metric="' + metric + '"]')
        .forEach((btn) => {
            btn.closest('.health-vitals-view-bar')?.classList.toggle('hidden', !visible);
        });
}

function syncVitalsViewSwitch(metric) {
    const mode = getVitalsChartView(metric);
    document
        .querySelectorAll('[data-vitals-view][data-vitals-metric="' + metric + '"]')
        .forEach((btn) => {
            const on = btn.getAttribute('data-vitals-view') === mode;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
}

const ohlcPlugin = {
    id: 'mealogOhlc',
    afterDatasetsDraw(chart, _args, opts) {
        const days = opts?.ohlcDays;
        if (!days?.length) return;
        const yScale = chart.scales.y;
        const xScale = chart.scales.x;
        if (!yScale || !xScale) return;
        const ctx = chart.ctx;
        const count = chart.data.labels?.length || 1;
        const bodyWidth = Math.max(6, Math.min(16, (xScale.width / count) * 0.45));
        const colorUp = opts?.colorUp || VITALS_CHART_COLORS.intradayUp;
        const colorDown = opts?.colorDown || VITALS_CHART_COLORS.intradayDown;

        days.forEach((day) => {
            const x = xScale.getPixelForValue(day.index);
            const yHigh = yScale.getPixelForValue(day.high);
            const yLow = yScale.getPixelForValue(day.low);
            const yOpen = yScale.getPixelForValue(day.open);
            const yClose = yScale.getPixelForValue(day.close);
            const up = day.close >= day.open;
            const color = up ? colorUp : colorDown;

            ctx.save();
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, yHigh);
            ctx.lineTo(x, yLow);
            ctx.stroke();

            const top = Math.min(yOpen, yClose);
            let height = Math.abs(yClose - yOpen);
            if (height < 2) height = 2;
            ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
            ctx.restore();
        });
    }
};

/** 라인 보기 전용 — 점 위(자리 없으면 아래)에 수치 */
const valueLabelPlugin = {
    id: 'mealogVitalsValues',
    afterDatasetsDraw(chart, _args, opts) {
        if (!opts?.enabled) return;
        const values = opts.values;
        if (!values?.length) return;
        const yScale = chart.scales.y;
        const xScale = chart.scales.x;
        if (!yScale || !xScale) return;

        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '600 10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = opts.color || VALUE_LABEL_COLOR;

        let lastX = -Infinity;
        values.forEach((v, i) => {
            if (v == null) return;
            const x = xScale.getPixelForValue(i);
            if (!Number.isFinite(x) || x - lastX < VALUE_LABEL_MIN_GAP_PX) return;
            lastX = x;
            const y = yScale.getPixelForValue(v);
            if (!Number.isFinite(y)) return;
            const text = formatValue(v, opts.decimals);
            const above = y - 9;
            if (above >= chart.chartArea.top + 4) {
                ctx.textBaseline = 'bottom';
                ctx.fillText(text, x, above);
            } else {
                ctx.textBaseline = 'top';
                ctx.fillText(text, x, y + 9);
            }
        });
        ctx.restore();
    }
};

function ensureVitalsPlugins() {
    if (typeof Chart === 'undefined' || !Chart.registry) return;
    if (!Chart.registry.plugins.get('mealogOhlc')) Chart.register(ohlcPlugin);
    if (!Chart.registry.plugins.get('mealogVitalsValues')) Chart.register(valueLabelPlugin);
}

ensureVitalsPlugins();

function destroyVitalsChart(canvasId) {
    const entry = chartInstances.get(canvasId);
    const canvas = entry?.chart?.canvas;
    if (canvas && entry?.pointerHandlers) {
        entry.pointerHandlers.forEach(({ type, fn }) => canvas.removeEventListener(type, fn));
    }
    if (entry?.chart) {
        entry.chart.destroy();
        chartInstances.delete(canvasId);
    }
}

function hasValidRecordTime(time) {
    return typeof time === 'string' && /^\d{2}:\d{2}$/.test(time.trim());
}

/** 시간 있으면 시간순·시간 표시, 없으면 입력 순서·수치만 */
function buildDayDetailRows(records, { decimals, unit }) {
    if (!records?.length) return [];
    const anyTimed = records.some((r) => hasValidRecordTime(r.time));
    const ordered = anyTimed ? sortRecordsByTime(records) : [...records];

    return ordered.map((r) => {
        const label = hasValidRecordTime(r.time)
            ? formatMealClockTagLabel(r.time) || r.time
            : null;
        return { label, valueText: `${formatValue(r.value, decimals)} ${unit}` };
    });
}

function bubbleRowHtml(row) {
    if (row.label) {
        return `<li class="health-vitals-bubble__row"><span class="health-vitals-bubble__label">${escapeHtml(row.label)}</span><span class="health-vitals-bubble__value">${escapeHtml(row.valueText)}</span></li>`;
    }
    return `<li class="health-vitals-bubble__row health-vitals-bubble__row--solo"><span class="health-vitals-bubble__value">${escapeHtml(row.valueText)}</span></li>`;
}

function buildSingleRecordBodyHtml(row) {
    if (row.label) {
        return `<div class="health-vitals-bubble__single-body health-vitals-bubble__row"><span class="health-vitals-bubble__label">${escapeHtml(row.label)}</span><span class="health-vitals-bubble__value">${escapeHtml(row.valueText)}</span></div>`;
    }
    return `<div class="health-vitals-bubble__single-body health-vitals-bubble__row health-vitals-bubble__row--solo"><span class="health-vitals-bubble__value">${escapeHtml(row.valueText)}</span></div>`;
}

function buildBubbleInnerHtml(dateStr, rows) {
    const title = formatMealogDateLabel(dateStr);
    if (rows.length === 1) {
        return `<div class="health-vitals-bubble__title">${escapeHtml(title)}</div>${buildSingleRecordBodyHtml(rows[0])}`;
    }
    const listHtml = rows.map(bubbleRowHtml).join('');
    return `<div class="health-vitals-bubble__title">${escapeHtml(title)}</div><ul class="health-vitals-bubble__list">${listHtml}</ul>`;
}

function dayIndexHasData(meta, index) {
    if (!meta || index < 0 || index >= meta.dates.length) return false;
    if (meta.points[index] != null) return true;
    return meta.ohlcDays.some((d) => d.index === index);
}

function getChartDom(canvas) {
    const wrap = canvas?.closest('.health-vitals-chart-wrap');
    const scroll = wrap?.querySelector('.health-vitals-chart-scroll');
    const inner = wrap?.querySelector('.health-vitals-chart-inner');
    const bubble = inner?.querySelector('.health-vitals-bubble');
    return { wrap, scroll, inner, bubble };
}

function computeChartLayout(dayCount, wrapEl) {
    const viewportW = wrapEl?.clientWidth || 320;
    if (dayCount <= VITALS_DAYS_PER_VIEWPORT) {
        return { scrollable: false, innerWidth: viewportW };
    }
    const innerWidth = Math.max(viewportW, Math.round((dayCount / VITALS_DAYS_PER_VIEWPORT) * viewportW));
    return { scrollable: true, innerWidth };
}

function applyChartLayout(canvas, layout) {
    const { scroll, inner } = getChartDom(canvas);
    if (!scroll || !inner) return;
    scroll.classList.toggle('health-vitals-chart-scroll--scrollable', layout.scrollable);
    inner.style.width = layout.scrollable ? `${layout.innerWidth}px` : '100%';
}

/** 라벨 겹침 방지 — 차트 너비·일수 기준 최대 눈금 수 */
function computeXTickLimit(chartWidthPx, dayCount) {
    const LABEL_MIN_PX = 46;
    const usable = Math.max(72, (chartWidthPx || 320) - 20);
    const byWidth = Math.max(4, Math.floor(usable / LABEL_MIN_PX));
    return Math.min(Math.max(4, dayCount), byWidth);
}

/** 스크롤 영역을 맨 오른쪽(최근 날짜)으로 — 레이아웃 반영 후 재시도 */
function scrollHealthChartToEnd(canvas, attempt = 0) {
    const { scroll } = getChartDom(canvas);
    if (!scroll || !scroll.classList.contains('health-vitals-chart-scroll--scrollable')) return;
    const target = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    scroll.scrollLeft = target;
    if (attempt < 6 && scroll.scrollLeft < target - 2) {
        requestAnimationFrame(() => scrollHealthChartToEnd(canvas, attempt + 1));
    }
}

function getNativeEvent(event) {
    return event?.native || event;
}

/** 캔버스 기준 X (가로 스크롤·연간 wide 차트 대응) */
function xPixelFromEvent(chart, event) {
    const native = getNativeEvent(event);
    if (!native) return null;

    if (native.target === chart.canvas && Number.isFinite(native.offsetX)) {
        return native.offsetX;
    }

    const helpers = typeof Chart !== 'undefined' ? Chart.helpers : null;
    if (helpers?.getRelativePosition && chart.chartArea) {
        try {
            const pos = helpers.getRelativePosition(native, chart);
            if (pos && Number.isFinite(pos.x)) {
                return chart.chartArea.left + pos.x;
            }
        } catch (_) {
            /* fallback */
        }
    }

    const rect = chart.canvas.getBoundingClientRect();
    const clientX = native.clientX;
    if (!Number.isFinite(clientX) || rect.width <= 0) return null;
    const ratio = chart.canvas.width / rect.width;
    return (clientX - rect.left) * ratio;
}

function getDayCenterPixel(chart, index) {
    const xScale = chart.scales.x;
    if (!xScale) return NaN;
    if (typeof xScale.getPixelForTick === 'function') {
        const tickPx = xScale.getPixelForTick(index);
        if (Number.isFinite(tickPx)) return tickPx;
    }
    const byIndex = xScale.getPixelForValue(index);
    if (Number.isFinite(byIndex)) return byIndex;
    return xScale.getPixelForValue(chart.data.labels[index]);
}

/** 가장 가까운 기록일(캔들·점) — 연간 등 좁은 칸에서도 최소 px 허용 */
function resolveClickedDayIndex(chart, event, meta) {
    const xScale = chart.scales.x;
    const xPixel = xPixelFromEvent(chart, event);
    if (!xScale || xPixel == null) return -1;

    const count = meta.dates.length;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < count; i++) {
        if (!dayIndexHasData(meta, i)) continue;
        const px = getDayCenterPixel(chart, i);
        if (!Number.isFinite(px)) continue;
        const dist = Math.abs(px - xPixel);
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    }
    if (bestIdx < 0) return -1;

    const slotW = count > 0 ? xScale.width / count : xScale.width;
    const maxDist = slotW < VITALS_MIN_HIT_PX ? VITALS_MIN_HIT_PX : Math.max(VITALS_MIN_HIT_PX, slotW * 0.9);
    if (bestDist > maxDist) return -1;
    return bestIdx;
}

function hideAllVitalsBubbles() {
    document.querySelectorAll('.health-vitals-bubble').forEach((el) => {
        el.classList.add('hidden');
        el.classList.remove('health-vitals-bubble--single');
        el.setAttribute('aria-hidden', 'true');
    });
    activeBubbleCanvasId = null;
    chartInstances.forEach((entry) => {
        if (entry?.meta) entry.meta.activeBubbleIndex = null;
    });
}

function ensureBubbleDismissListener() {
    if (bubbleDismissBound) return;
    bubbleDismissBound = true;
    document.addEventListener('click', (e) => {
        if (vitalsBubbleSuppressDismiss) return;
        if (e.target.closest('.health-vitals-chart-wrap')) return;
        hideAllVitalsBubbles();
    });
}

function showVitalsBubble(canvasId, chart, index, { dateStr, rows }) {
    const { inner, bubble, scroll } = getChartDom(chart.canvas);
    if (!inner || !bubble) return;

    hideAllVitalsBubbles();
    activeBubbleCanvasId = canvasId;

    const entry = chartInstances.get(canvasId);
    if (entry?.meta) entry.meta.activeBubbleIndex = index;

    bubble.innerHTML = buildBubbleInnerHtml(dateStr, rows);
    bubble.classList.toggle('health-vitals-bubble--single', rows.length === 1);
    bubble.classList.remove('hidden');
    bubble.setAttribute('aria-hidden', 'false');

    const placeBubble = () => {
        const xScale = chart.scales.x;
        if (!xScale) return;
        const x = getDayCenterPixel(chart, index);
        if (!Number.isFinite(x)) return;
        const half = Math.min(110, Math.max(40, bubble.offsetWidth / 2));
        const innerW = inner.clientWidth;
        let left = x;
        left = Math.max(half + 6, Math.min(left, innerW - half - 6));
        bubble.style.left = `${left}px`;

        if (scroll?.classList.contains('health-vitals-chart-scroll--scrollable')) {
            const bubbleRect = bubble.getBoundingClientRect();
            const scrollRect = scroll.getBoundingClientRect();
            if (bubbleRect.left < scrollRect.left + 8) {
                scroll.scrollLeft -= scrollRect.left + 8 - bubbleRect.left;
            } else if (bubbleRect.right > scrollRect.right - 8) {
                scroll.scrollLeft += bubbleRect.right - scrollRect.right + 8;
            }
        }
    };

    placeBubble();
    requestAnimationFrame(placeBubble);
}

function handleVitalsChartClick(canvasId, event, _activeElements) {
    const native = getNativeEvent(event);

    vitalsBubbleSuppressDismiss = true;
    queueMicrotask(() => {
        vitalsBubbleSuppressDismiss = false;
    });

    const entry = chartInstances.get(canvasId);
    const chart = entry?.chart;
    const meta = entry?.meta;
    if (!chart || !meta) return;

    const index = resolveClickedDayIndex(chart, event, meta);
    if (!dayIndexHasData(meta, index)) {
        hideAllVitalsBubbles();
        return;
    }

    if (meta.activeBubbleIndex === index && activeBubbleCanvasId === canvasId) {
        hideAllVitalsBubbles();
        return;
    }

    const dateStr = meta.dates[index];
    const records = getMetricRecordsForDate(window.userSettings, dateStr, meta.metric);
    if (!records.length) return;

    native?.stopPropagation?.();

    showVitalsBubble(canvasId, chart, index, {
        dateStr,
        rows: buildDayDetailRows(records, { decimals: meta.decimals, unit: meta.unit })
    });
}

function bindVitalsChartPointer(canvasId, chart) {
    const tap = { x: 0, y: 0, active: false };
    let lastHandledAt = 0;

    const onDown = (e) => {
        if (e.button != null && e.button !== 0) return;
        tap.active = true;
        tap.x = e.clientX;
        tap.y = e.clientY;
    };

    const onUp = (e) => {
        if (e.button != null && e.button !== 0) return;
        if (!tap.active) return;
        tap.active = false;
        const dx = Math.abs(e.clientX - tap.x);
        const dy = Math.abs(e.clientY - tap.y);
        if (dx > VITALS_TAP_MOVE_PX || dy > VITALS_TAP_MOVE_PX) return;

        const now = Date.now();
        if (now - lastHandledAt < 400) return;
        lastHandledAt = now;

        const meta = chartInstances.get(canvasId)?.meta;
        if (!meta) return;
        const index = resolveClickedDayIndex(chart, { native: e }, meta);
        if (!dayIndexHasData(meta, index)) return;
        handleVitalsChartClick(canvasId, { native: e }, []);
    };

    const canvas = chart.canvas;
    canvas.addEventListener('pointerdown', onDown, { passive: true });
    canvas.addEventListener('pointerup', onUp, { passive: true });

    return [
        { type: 'pointerdown', fn: onDown },
        { type: 'pointerup', fn: onUp }
    ];
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function enumerateDates(startStr, endStr) {
    const out = [];
    const cur = new Date(startStr + 'T00:00:00');
    const end = new Date(endStr + 'T00:00:00');
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return out;
    while (cur <= end) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        out.push(`${y}-${m}-${d}`);
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

function shortDayLabel(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (Number.isNaN(d.getTime())) return dateStr;
    return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_SHORT[d.getDay()] || ''})`;
}

function sortRecordsByTime(records) {
    return [...records].sort((a, b) => {
        const ta = a.time && /^\d{2}:\d{2}$/.test(a.time) ? a.time : '99:99';
        const tb = b.time && /^\d{2}:\d{2}$/.test(b.time) ? b.time : '99:99';
        return ta.localeCompare(tb);
    });
}

function recordsToOHLC(records) {
    const sorted = sortRecordsByTime(records);
    const values = sorted.map((r) => r.value);
    return {
        open: values[0],
        high: Math.max(...values),
        low: Math.min(...values),
        close: values[values.length - 1]
    };
}

function legacyVitalsToRecords(raw, field) {
    const onKey = field === 'weight' ? 'weightOn' : 'glucoseOn';
    const valKey = field === 'weight' ? 'weight' : 'glucose';
    if (!raw || raw[onKey] !== true) return [];
    const v = raw[valKey];
    if (v === '' || v == null) return [];
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) return [];
    return [{ value: num, time: '' }];
}

/**
 * 그 날짜 메모 기록에서 온 값 — 새 입력은 전부 여기로 들어온다
 * (docs/user-memo-items.md §6.2). 기본 메모의 key 가 결정적이라(§2.6)
 * 사용자가 이름을 '몸무게'로 고쳐도 이 조회가 안 끊긴다.
 */
function memoRecordsForDate(dateStr, metric) {
    const key = defaultMemoKey(metric === 'weight' ? 'weight' : 'bloodSugar');
    const out = [];
    for (const m of window.mealHistory || []) {
        if (!m || m.date !== dateStr || m.slotId !== MEMO_SLOT_ID || m.slotKey !== key) continue;
        const value = Number(m.value);
        if (!Number.isFinite(value)) continue;
        const t = String(m.time || '').slice(0, 5);
        out.push({ value, time: /^\d{2}:\d{2}$/.test(t) ? t : '' });
    }
    return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/**
 * 폴백 사슬 세 칸 (docs/user-memo-items.md §6.2):
 *   숫자 메모 → 하루 소감의 weightRecords → 구세대 dailyVitals
 *
 * **마이그레이션이 없다.** 옷 데이터를 옷기지 않고 사슬만 늘렸다 —
 * 이미 `dailyVitals` 에 쓰고 있는 수법 그대로다. 하루 소감의 입력 UI 를
 * 걷어낸 뒤에도 옳 값이 그대로 보이는 이유가 이 사슬이다.
 */
function getMetricRecordsForDate(settings, dateStr, metric) {
    const fromMemo = memoRecordsForDate(dateStr, metric);
    if (fromMemo.length > 0) return fromMemo;

    const entry = getDailyJournalFromSettings(settings, dateStr);
    const listKey = metric === 'weight' ? 'weightRecords' : 'bloodSugarRecords';
    const enabledKey = metric === 'weight' ? 'weightEnabled' : 'bloodSugarEnabled';
    let records = [];
    if (entry[enabledKey] && entry[listKey]?.length) {
        records = entry[listKey];
    }
    if (records.length === 0 && settings?.dailyVitals?.[dateStr]) {
        records = legacyVitalsToRecords(settings.dailyVitals[dateStr], metric);
    }
    return records;
}

/** 1·2·5×10ⁿ 계열로 눈금 간격 정리 */
function niceNum(range, round) {
    if (!Number.isFinite(range) || range <= 0) return 1;
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    let nf;
    if (round) {
        if (f < 1.5) nf = 1;
        else if (f < 3) nf = 2;
        else if (f < 7) nf = 5;
        else nf = 10;
    } else if (f <= 1) nf = 1;
    else if (f <= 2) nf = 2;
    else if (f <= 5) nf = 5;
    else nf = 10;
    return nf * 10 ** exp;
}

/**
 * 데이터 중심 Y축 + nice 눈금
 * 하한 0: 값이 0 근처이거나, 체중 20kg 미만·혈당 50 미만일 때만
 */
function computeNiceYAxis(dataMin, dataMax, { styleKey, decimals, tickCount = 5 }) {
    const minSpan = styleKey === 'weight' ? 1 : 12;
    let lo = dataMin;
    let hi = dataMax;
    let span = hi - lo;
    if (!Number.isFinite(span) || span < minSpan) {
        const mid = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : hi || lo || 0;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
        span = minSpan;
    }

    const padRatio = 0.18;
    let rawMin = lo - span * padRatio;
    const rawMax = hi + span * padRatio;

    const useZeroFloor =
        rawMin <= 0 ||
        lo <= span * 0.5 ||
        (styleKey === 'weight' && lo < 20) ||
        (styleKey === 'bloodSugar' && lo < 50);

    if (useZeroFloor) rawMin = 0;

    const range = niceNum(rawMax - rawMin, false);
    const step = niceNum(range / Math.max(2, tickCount - 1), true);
    const stepSafe = step > 0 ? step : (decimals === 0 ? 1 : 0.5);

    let niceMin = Math.floor(rawMin / stepSafe) * stepSafe;
    let niceMax = Math.ceil(rawMax / stepSafe) * stepSafe;
    if (niceMax <= niceMin) niceMax = niceMin + stepSafe;
    if (useZeroFloor && niceMin > 0) niceMin = 0;

    return { min: niceMin, max: niceMax, stepSize: stepSafe };
}

function buildDailySeries(settings, dates, metric) {
    const points = [];
    const ohlcDays = [];
    let hasAny = false;

    dates.forEach((dateStr, index) => {
        const records = getMetricRecordsForDate(settings, dateStr, metric);
        if (!records.length) {
            points.push(null);
            return;
        }
        hasAny = true;
        if (records.length === 1) {
            points.push(records[0].value);
        } else {
            points.push(null);
            ohlcDays.push({ index, ...recordsToOHLC(records) });
        }
    });

    return { labels: dates.map(shortDayLabel), dates, points, ohlcDays, hasAny };
}

/** 값 없는 날은 투명 — 캔들 보기는 중립 닷, 라인 보기는 선 색 */
function pointColorsForSeries(points, color) {
    const dot = color || VITALS_CHART_COLORS.dot;
    return points.map((v) => (v == null ? 'transparent' : dot));
}

function renderVitalsChart(canvasId, emptyId, series, opts) {
    const { unit, decimals, styleKey, metric, metricLabel, stroke } = opts;
    ensureBubbleDismissListener();
    ensureVitalsPlugins();
    lastVitalsRender.set(metric, { canvasId, emptyId, series, opts });
    syncVitalsViewSwitch(metric);

    const isLine = getVitalsChartView(metric) === VITALS_VIEW_LINE;
    const colors = VITALS_CHART_COLORS;
    const lineColor = stroke || colors.dot;
    // 라인 보기는 복수 기록일을 마지막 값 하나로 잇는다 — 캔들은 시고저종을 다 그린다
    const displayPoints = isLine ? seriesCloseValues(series) : series.points;
    const displayOhlc = isLine ? [] : series.ohlcDays;
    const ptColors = pointColorsForSeries(displayPoints, isLine ? lineColor : colors.dot);
    const canvas = document.getElementById(canvasId);
    const emptyEl = document.getElementById(emptyId);
    const wrap = canvas?.closest('.health-vitals-chart-wrap');
    if (!canvas) return;

    destroyVitalsChart(canvasId);
    hideAllVitalsBubbles();

    setVitalsViewSwitchVisible(metric, series.hasAny);

    if (!series.hasAny) {
        canvas.classList.add('hidden');
        if (wrap) {
            wrap.classList.remove('health-vitals-chart-wrap--interactive');
            wrap.classList.add('health-vitals-chart-wrap--empty');
        }
        if (emptyEl) {
            emptyEl.classList.remove('hidden');
            emptyEl.setAttribute('aria-hidden', 'false');
        }
        return;
    }

    canvas.classList.remove('hidden');
    if (wrap) {
        wrap.classList.add('health-vitals-chart-wrap--interactive');
        wrap.classList.remove('health-vitals-chart-wrap--empty');
    }
    if (emptyEl) {
        emptyEl.classList.add('hidden');
        emptyEl.setAttribute('aria-hidden', 'true');
    }

    const layout = computeChartLayout(series.dates.length, wrap);
    applyChartLayout(canvas, layout);

    const meta = {
        dates: series.dates,
        points: displayPoints,
        ohlcDays: displayOhlc,
        metric,
        metricLabel,
        unit,
        decimals,
        activeBubbleIndex: null,
        scrollable: layout.scrollable
    };

    const numericPoints = displayPoints.filter((v) => v != null);
    const ohlcVals = displayOhlc.flatMap((d) => [d.open, d.high, d.low, d.close]);
    const allVals = [...numericPoints, ...ohlcVals];
    const dataMin = Math.min(...allVals);
    const dataMax = Math.max(...allVals);
    const yAxis = computeNiceYAxis(dataMin, dataMax, { styleKey, decimals });
    const chartWidthForTicks = layout.scrollable ? layout.innerWidth : wrap?.clientWidth || 320;
    const xTickLimit = computeXTickLimit(chartWidthForTicks, series.dates.length);

    const chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: series.labels,
            datasets: [
                {
                    label: unit,
                    data: displayPoints,
                    showLine: isLine,
                    borderColor: isLine ? lineColor : colors.line,
                    backgroundColor: colors.fill,
                    pointBackgroundColor: ptColors,
                    pointBorderColor: ptColors,
                    pointRadius: POINT_RADIUS,
                    pointHoverRadius: POINT_HOVER_RADIUS,
                    pointHitRadius: 18,
                    borderWidth: isLine ? 2 : 0,
                    tension: 0,
                    // 기록 없는 날은 건너뛰고 잇는다 (라인 보기)
                    spanGaps: isLine
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false },
                mealogOhlc: {
                    ohlcDays: displayOhlc,
                    colorUp: colors.intradayUp,
                    colorDown: colors.intradayDown
                },
                mealogVitalsValues: {
                    enabled: isLine,
                    values: displayPoints,
                    decimals,
                    color: VALUE_LABEL_COLOR
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        maxRotation: 0,
                        autoSkip: true,
                        autoSkipPadding: 6,
                        maxTicksLimit: xTickLimit,
                        font: { size: 10 }
                    }
                },
                y: {
                    min: yAxis.min,
                    max: yAxis.max,
                    ticks: {
                        stepSize: yAxis.stepSize,
                        callback: (v) => formatValue(v, decimals),
                        font: { size: 10 }
                    },
                    grid: { color: 'rgba(148, 163, 184, 0.25)' }
                }
            }
        },
    });

    const pointerHandlers = bindVitalsChartPointer(canvasId, chart);
    chartInstances.set(canvasId, { chart, meta, pointerHandlers });

    if (layout.scrollable) {
        chart.resize();
        requestAnimationFrame(() => {
            chart.resize();
            scrollHealthChartToEnd(canvas);
        });
    }
}

function formatValue(v, decimals) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    if (decimals === 0) return String(Math.round(n));
    return n.toFixed(1);
}

/** 일별 대표값 — 당일 복수 기록은 마지막 값(close) */
function seriesCloseValues(series) {
    const vals = series.dates.map((dateStr, index) => {
        if (series.points[index] != null) return series.points[index];
        const ohlc = series.ohlcDays.find((d) => d.index === index);
        return ohlc ? ohlc.close : null;
    });
    return vals;
}

function lastDefined(values) {
    for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] != null && Number.isFinite(values[i])) return { value: values[i], index: i };
    }
    return null;
}

function firstDefined(values) {
    for (let i = 0; i < values.length; i++) {
        if (values[i] != null && Number.isFinite(values[i])) return { value: values[i], index: i };
    }
    return null;
}

/** 카드 머리 요약 — 현재값과 기간 증감 (그래프는 renderVitalsChart 가 그린다) */
function renderVitalSummary({ valueId, deltaId, series, decimals }) {
    const valueEl = document.getElementById(valueId);
    const deltaEl = document.getElementById(deltaId);

    const values = seriesCloseValues(series);
    const last = lastDefined(values);
    const first = firstDefined(values);

    if (!series.hasAny || !last) {
        if (valueEl) valueEl.textContent = '—';
        if (deltaEl) {
            deltaEl.textContent = '';
            deltaEl.classList.remove('is-up');
        }
        return;
    }

    if (valueEl) valueEl.textContent = formatValue(last.value, decimals);
    if (!deltaEl) return;

    if (!first || first.index === last.index) {
        deltaEl.textContent = '';
        deltaEl.classList.remove('is-up');
        return;
    }

    const delta = last.value - first.value;
    const abs = Math.abs(delta);
    const absText = formatValue(abs, decimals);
    if (delta === 0 || abs < (decimals === 0 ? 0.5 : 0.05)) {
        deltaEl.textContent = '변동 없음';
        deltaEl.classList.remove('is-up');
    } else if (delta < 0) {
        deltaEl.textContent = `▼ ${absText} 기간`;
        deltaEl.classList.remove('is-up');
    } else {
        deltaEl.textContent = `▲ ${absText} 기간`;
        deltaEl.classList.add('is-up');
    }
}

/** 기간 내 체중·혈당 — 카드 머리 요약 + 라인·캔들 차트 */
export function renderHealthVitalsCharts(startStr, endStr) {
    const settings = window.userSettings;
    const dates = enumerateDates(startStr, endStr);
    if (!dates.length) return;

    const weightSeries = buildDailySeries(settings, dates, 'weight');
    const glucoseSeries = buildDailySeries(settings, dates, 'bloodSugar');

    renderVitalSummary({
        valueId: 'healthWeightValue',
        deltaId: 'healthWeightDelta',
        series: weightSeries,
        decimals: 1
    });
    renderVitalSummary({
        valueId: 'healthBloodSugarValue',
        deltaId: 'healthBloodSugarDelta',
        series: glucoseSeries,
        decimals: 0
    });

    renderVitalsChart('healthWeightChart', 'healthWeightEmpty', weightSeries, {
        unit: 'kg',
        decimals: 1,
        styleKey: 'weight',
        metric: 'weight',
        metricLabel: '체중',
        stroke: '#3cb889'
    });
    renderVitalsChart('healthBloodSugarChart', 'healthBloodSugarEmpty', glucoseSeries, {
        unit: 'mg/dL',
        decimals: 0,
        styleKey: 'bloodSugar',
        metric: 'bloodSugar',
        metricLabel: '혈당',
        stroke: '#3b82f6'
    });
}

export function destroyHealthVitalsCharts() {
    hideAllVitalsBubbles();
    destroyVitalsChart('healthWeightChart');
    destroyVitalsChart('healthBloodSugarChart');
}
