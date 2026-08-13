// 차트 렌더링 관련 함수들
import { logUsageMetric } from '../usage-metrics.js';
import { effectiveChartTag } from './meal-analytics-tags.js';
import { AUTO_CATEGORIES } from '../utils/food-classifier.js';
import { normalizePlace } from '../utils/place-normalize.js';
import { VIBRANT_COLORS, CUMULATIVE_BAR_GRADIENT, RATING_GRADIENT, SATIETY_DATA } from '../constants.js';
import { generateColorMap, toLocalDateString } from '../utils.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { getDayName } from './date-utils.js';

const CUMULATIVE_KEYS = ['mealType', 'category', 'withWhom', 'snackType', 'snackPlace', 'snackWhen']; // 식사·간식 바차트 동일 색구성(빈도순 그라데이션)
const DETAIL_MODAL_TAB_KEYS = ['mealType', 'category', 'withWhom', 'snackType', 'snackPlace', 'snackWithWhom']; // 상세보기 시 통계 + 세부 통계 탭 (간식 누구와 포함)
const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];

/** 식사 상세 공통 팝업 탭 */
const MEAL_DETAIL_TABS = [
    { key: 'mealType', label: '어떻게' },
    { key: 'category', label: '무엇을' },
    { key: 'withWhom', label: '함께' }
];
/** 간식 상세 공통 팝업 탭 */
const SNACK_DETAIL_TABS = [
    { key: 'snackType', label: '무엇을' },
    { key: 'snackPlace', label: '어디서' },
    { key: 'snackWithWhom', label: '누구와' }
];

/** @type {{ group: 'meal'|'snack'|null, key: string|null, records: any[] }} */
let detailModalState = { group: null, key: null, records: [] };

/** meal 기록에서 사용자 설정 태그(상세) 분석 - 테이블용. options.menuSlotsOnly: 'meal' | 'snack' */
function getTop10RankingsFromMeals(mealRecords, options = {}) {
    const { menuSlotsOnly } = options;
    const dataForMenu = menuSlotsOnly === 'meal'
        ? mealRecords.filter(m => MEAL_SLOTS.includes(m.slotId))
        : menuSlotsOnly === 'snack'
            ? mealRecords.filter(m => SNACK_SLOTS.includes(m.slotId))
            : mealRecords;
    const placeCounts = {};
    const menuCounts = {};
    const peopleCounts = {};
    mealRecords.forEach(m => {
        // 표기 정규화(우리집→집 등)로 같은 장소가 여러 줄로 쪼개지지 않게 — 원문은 저장에만 남는다
        const place = normalizePlace(m.place);
        if (place) {
            placeCounts[place] = (placeCounts[place] || 0) + 1;
        }
        const peopleRaw = (m.withWhomDetail || m.withWhom || '').trim();
        if (peopleRaw) {
            peopleRaw.split(',').forEach(v => {
                const vv = v.trim();
                if (vv) peopleCounts[vv] = (peopleCounts[vv] || 0) + 1;
            });
        } else {
            peopleCounts['혼자'] = (peopleCounts['혼자'] || 0) + 1;
        }
    });
    dataForMenu.forEach(m => {
        const menuRaw = (m.menuDetail || (menuSlotsOnly === 'snack' ? m.snackType : m.category) || '').trim();
        if (menuRaw) {
            menuRaw.split(',').forEach(v => {
                const vv = v.trim();
                if (vv) menuCounts[vv] = (menuCounts[vv] || 0) + 1;
            });
        }
    });
    const sortDesc = (obj) =>
        Object.entries(obj)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([name, count]) => ({ name, count }));
    return {
        place: sortDesc(placeCounts),
        menu: sortDesc(menuCounts),
        people: sortDesc(peopleCounts)
    };
}

/** 상세모달 테이블: meal 기록에서 사용자 설정 태그(상세) 분석 */
function buildDetailRankTabHtml(mealRecords, key) {
    if (!mealRecords || !Array.isArray(mealRecords)) return '';
    const renderTable = (items, emptyLabel, colLabel) => {
        if (!items.length) {
            return `<p class="text-slate-400 text-xs py-2">${emptyLabel}</p>`;
        }
        return `<table class="w-full text-sm border-collapse">
            <thead><tr class="border-b border-slate-200 text-slate-500 font-bold">
                <th class="text-left py-2 pr-3 w-12">순위</th>
                <th class="text-left py-2 pr-3">${colLabel}</th>
                <th class="text-right py-2 w-16">횟수</th>
            </tr></thead>
            <tbody>${items
                .map((item, i) => `<tr class="border-b border-slate-100"><td class="py-2 pr-3 text-slate-500">${i + 1}</td><td class="py-2 pr-3 font-medium text-slate-800">${escapeHtml(item.name)}</td><td class="py-2 text-right text-slate-600">${item.count}회</td></tr>`)
                .join('')}</tbody>
        </table>`;
    };
    if (key === 'mealType') {
        const mealOnly = mealRecords.filter(m => MEAL_SLOTS.includes(m.slotId));
        const { place } = getTop10RankingsFromMeals(mealOnly);
        return renderTable(place, '입력된 장소가 없습니다.', '어디서');
    }
    if (key === 'snackPlace') {
        const snackOnly = mealRecords.filter(m => SNACK_SLOTS.includes(m.slotId));
        const { place } = getTop10RankingsFromMeals(snackOnly);
        return renderTable(place, '입력된 장소가 없습니다.', '어디서');
    }
    if (key === 'category') {
        const { menu } = getTop10RankingsFromMeals(mealRecords, { menuSlotsOnly: 'meal' });
        return renderTable(menu, '입력된 메뉴가 없습니다.', '메뉴');
    }
    if (key === 'withWhom') {
        const mealOnly = mealRecords.filter(m => MEAL_SLOTS.includes(m.slotId));
        const { people } = getTop10RankingsFromMeals(mealOnly);
        return renderTable(people, '입력된 사람이 없습니다.', '누구와');
    }
    if (key === 'snackType') {
        const { menu } = getTop10RankingsFromMeals(mealRecords, { menuSlotsOnly: 'snack' });
        return renderTable(menu, '입력된 메뉴가 없습니다.', '메뉴');
    }
    if (key === 'snackWithWhom') {
        const snackOnly = mealRecords.filter((m) => SNACK_SLOTS.includes(m.slotId));
        const { people } = getTop10RankingsFromMeals(snackOnly);
        return renderTable(people, '입력된 사람이 없습니다.', '누구와');
    }
    return '';
}

/** 만족도·포만감 상세: 전체 집계 순위표 (시간대 없음) */
function buildDetailGaugeRankHtml(filteredData, key) {
    const isSnack = key === 'snackRating' || key === 'snackSatiety';
    const slots = isSnack ? SNACK_SLOTS : MEAL_SLOTS;
    const rows = (filteredData || []).filter((m) => slots.includes(m.slotId));
    const counts = {};
    rows.forEach((m) => {
        let label = '미입력';
        if (key === 'rating' || key === 'snackRating') {
            const n = parseInt(m.rating, 10);
            label = !isNaN(n) ? `${n}점` : '미입력';
        } else {
            const n = parseInt(m.satiety, 10);
            label = !isNaN(n)
                ? SATIETY_DATA.find((d) => d.val === n)?.label || '미입력'
                : '미입력';
        }
        counts[label] = (counts[label] || 0) + 1;
    });
    let sorted = Object.entries(counts).map(([name, count]) => ({ name, count }));
    if (key === 'rating' || key === 'snackRating') {
        sorted.sort((a, b) => {
            if (a.name === '미입력') return 1;
            if (b.name === '미입력') return -1;
            return parseInt(b.name, 10) - parseInt(a.name, 10);
        });
    } else {
        sorted.sort((a, b) => {
            if (a.name === '미입력') return 1;
            if (b.name === '미입력') return -1;
            const av = SATIETY_DATA.find((d) => d.label === a.name)?.val ?? 0;
            const bv = SATIETY_DATA.find((d) => d.label === b.name)?.val ?? 0;
            return bv - av;
        });
    }
    if (!sorted.length) {
        return '<p class="text-slate-400 text-xs py-2">데이터가 없습니다.</p>';
    }
    const colLabel = key === 'rating' || key === 'snackRating' ? '만족도' : '포만감';
    return `<table class="w-full text-sm border-collapse">
        <thead><tr class="border-b border-slate-200 text-slate-500 font-bold">
            <th class="text-left py-2 pr-3 w-12">순위</th>
            <th class="text-left py-2 pr-3">${colLabel}</th>
            <th class="text-right py-2 w-16">횟수</th>
        </tr></thead>
        <tbody>${sorted
            .map(
                (item, i) =>
                    `<tr class="border-b border-slate-100"><td class="py-2 pr-3 text-slate-500">${i + 1}</td><td class="py-2 pr-3 font-medium text-slate-800">${escapeHtml(item.name)}</td><td class="py-2 text-right text-slate-600">${item.count}회</td></tr>`
            )
            .join('')}</tbody>
    </table>`;
}

function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

/**
 * renderProportionChart / 웰컴 도넛 공통 — 집계·정렬·색상(막대와 동일 규칙)
 * @returns {{ total: number, sorted: [string, number][], colorMap: Record<string, string> } | null}
 */
function aggregateProportionData(data, key) {
    const userTags = window.userSettings?.tags || {};
    let allowedTags = null;

    if (key === 'mealType' && Array.isArray(userTags.mealType) && userTags.mealType.length > 0) {
        allowedTags = new Set(userTags.mealType);
    } else if (key === 'category' && Array.isArray(userTags.category) && userTags.category.length > 0) {
        // 자동 분류 축(밥/한상·단백질식…)은 사용자 태그 목록에 없다 — 합집합으로 허용해야
        // 차트에서 '미입력'으로 접히지 않는다 (docs/food-category-auto-classification.md §3.3)
        allowedTags = new Set([...userTags.category, ...AUTO_CATEGORIES]);
    } else if (key === 'withWhom' && Array.isArray(userTags.withWhom) && userTags.withWhom.length > 0) {
        allowedTags = new Set(userTags.withWhom);
    } else if (key === 'snackType' && Array.isArray(userTags.snackType) && userTags.snackType.length > 0) {
        allowedTags = new Set(userTags.snackType);
    } else if (key === 'snackPlace' && Array.isArray(userTags.snackPlaceMain) && userTags.snackPlaceMain.length > 0) {
        allowedTags = new Set(userTags.snackPlaceMain);
    }

    const counts = {};
    const getVal = (m) => {
        if (key === 'snackWhen') {
            const snackSlotLabelMap = {
                pre_morning: '아침 전',
                snack1: '오전',
                snack2: '오후',
                night: '야식'
            };
            return snackSlotLabelMap[m?.slotId] || '미입력';
        }
        if (key === 'snackPlace') {
            const v = effectiveChartTag(m, 'snackPlace');
            return v || '미입력';
        }
        if (key === 'mealType' || key === 'category' || key === 'withWhom' || key === 'snackType') {
            const v = effectiveChartTag(m, key);
            return v || '미입력';
        }
        return String(m[key] ?? '').trim() || '미입력';
    };
    data.forEach(m => {
        let val = getVal(m);
        if (allowedTags && val !== '미입력' && val !== '기타' && !allowedTags.has(val)) {
            val = '미입력';
        }
        counts[val] = (counts[val] || 0) + 1;
    });

    const total = data.length;
    if (total === 0 || Object.keys(counts).length === 0) {
        return null;
    }

    let sorted;
    if (allowedTags) {
        const tagOrder = Array.from(allowedTags);
        const tagEntries = tagOrder
            .filter(tag => counts[tag] > 0)
            .map(tag => [tag, counts[tag]])
            .sort((a, b) => b[1] - a[1]);
        if (counts['기타'] > 0 && !allowedTags.has('기타')) tagEntries.push(['기타', counts['기타']]);
        if (counts['미입력'] > 0) tagEntries.push(['미입력', counts['미입력']]);
        tagEntries.sort((a, b) => b[1] - a[1]);
        sorted = tagEntries;
    } else if (key === 'snackWhen') {
        const timeOrder = ['아침 전', '오전', '오후', '야식'];
        const emptyCount = counts['미입력'] || 0;
        const entries = [];
        // 시간 순서 고정
        timeOrder.forEach((label) => {
            const c = counts[label] || 0;
            if (c > 0) entries.push([label, c]);
        });
        // 혹시 모를 기타 값(예: 데이터 이상) 처리: 미입력 제외하고 뒤에 붙임(빈도순)
        const extras = Object.entries(counts)
            .filter(([name, c]) => name !== '미입력' && !timeOrder.includes(name) && c > 0)
            .sort((a, b) => b[1] - a[1]);
        sorted = extras.length ? [...entries, ...extras] : entries;
        if (emptyCount > 0) sorted.push(['미입력', emptyCount]);
    } else {
        const entries = Object.entries(counts);
        const emptyEntry = entries.find(([name]) => name === '미입력');
        const nonEmptyEntries = entries.filter(([name]) => name !== '미입력');

        if (key === 'rating' || key === 'snackRating') {
            const ratingEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum;
                }
                return 0;
            });
            sorted = emptyEntry ? [...ratingEntries, emptyEntry] : ratingEntries;
        } else if (key === 'satiety' || key === 'snackSatiety') {
            const satietyEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum;
                }
                return 0;
            });
            sorted = emptyEntry ? [...satietyEntries, emptyEntry] : satietyEntries;
        } else {
            const sortedEntries = nonEmptyEntries.sort((a, b) => b[1] - a[1]);
            sorted = emptyEntry ? [...sortedEntries, emptyEntry] : sortedEntries;
        }
    }

    const colorMap = generateColorMap(data, key, VIBRANT_COLORS);
    return { total, sorted, colorMap };
}

/** 막대·도넛 공통 표시용 라벨 */
function proportionSegmentDisplayName(name, key) {
    if (name === '미입력') return '미입력';
    if (key === 'rating' || key === 'snackRating') {
        const ratingNum = parseInt(name);
        if (!isNaN(ratingNum)) {
            return '★'.repeat(ratingNum);
        }
    } else if (key === 'satiety' || key === 'snackSatiety') {
        const satietyNum = parseInt(name);
        if (!isNaN(satietyNum)) {
            const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
            if (satietyData) {
                return satietyData.label;
            }
        }
    }
    return name;
}

/**
 * 웰컴 팝업 도넛용 — 비율·색상은 분석 막대와 동일
 * @returns {{ total: number, segments: { name: string, count: number, color: string, displayName: string, fraction: number }[] }}
 */
export function computeProportionSegmentsForAnalysis(data, key) {
    const agg = aggregateProportionData(data, key);
    if (!agg) {
        return { total: 0, segments: [] };
    }
    const { total, sorted, colorMap } = agg;
    const segments = [];
    let cumulativeColorIndex = 0;

    sorted.forEach(([name, count]) => {
        if (count <= 0) return;
        let bg = colorMap[name] || '#94a3b8';
        if (name === '미입력') {
            bg = '#e2e8f0';
        } else if (CUMULATIVE_KEYS.includes(key)) {
            bg = CUMULATIVE_BAR_GRADIENT[cumulativeColorIndex % CUMULATIVE_BAR_GRADIENT.length];
            cumulativeColorIndex += 1;
        } else if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
            }
        } else if (key === 'satiety' || key === 'snackSatiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
        }
        segments.push({
            name,
            count,
            color: bg,
            displayName: proportionSegmentDisplayName(name, key),
            fraction: count / total
        });
    });

    return { total, segments };
}

/**
 * 웰컴 팝업 슬라이드 — 도넛(비율) 슬라이드와 랭킹 상세(분석 > 상세와 동일 테이블) 슬라이드를 교대로 구성.
 * 순서·개수를 바꾸면 관리자 > 웰컴메시지 > 요일별 화면의 선택지(`js/welcome-weekday-config.js`의 WELCOME_SLIDE_LABELS)도 함께 맞춰야 한다.
 * @param {number} [days=7] 오늘 포함 최근 N일(로컬)
 * @param {'meal'|'snack'} [kind='meal'] 식사(메인 슬롯) vs 간식 슬롯
 * @returns {({ type: 'donut', title: string, key: string, total: number, segments: any[] } | { type: 'detail', title: string, key: string, html: string })[]}
 */
export function getWelcomeWeekDonutSlides(days = 7, kind = 'meal') {
    const hist =
        typeof window !== 'undefined' && window.mealHistory && Array.isArray(window.mealHistory)
            ? window.mealHistory
            : [];
    const today = new Date();
    const startDt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const start = toLocalDateString(startDt);
    const end = toLocalDateString(today);
    const week = hist.filter(m => m && typeof m.date === 'string' && m.date >= start && m.date <= end);

    const donut = (title, key, data) => {
        const { total, segments } = computeProportionSegmentsForAnalysis(data, key);
        return { type: 'donut', title, key, total, segments };
    };
    // 상세 랭킹 슬라이드용 키는 분석 > 상세 팝업의 탭 키와 동일 — 슬롯 필터는 buildDetailRankTabHtml 내부에서 처리하므로 week 전체를 그대로 넘김
    const detail = (title, key) => ({ type: 'detail', title, key, html: buildDetailRankTabHtml(week, key) });

    if (kind === 'snack') {
        const snackOnly = week.filter(m => SNACK_SLOTS.includes(m.slotId));
        return [
            donut('언제', 'snackWhen', snackOnly),
            donut('어디서', 'snackPlace', snackOnly),
            detail('어디서 상세', 'snackPlace'),
            donut('무엇을', 'snackType', snackOnly),
            detail('무엇을 상세', 'snackType'),
            donut('누구와', 'withWhom', snackOnly),
            detail('누구와 상세', 'snackWithWhom'),
            donut('만족도', 'rating', snackOnly.filter(m => m.rating)),
            donut('포만감', 'satiety', snackOnly.filter(m => m.satiety))
        ];
    }

    const mainOnly = week.filter(m => MEAL_SLOTS.includes(m.slotId));
    return [
        donut('어떻게', 'mealType', mainOnly),
        detail('어디서 상세', 'mealType'),
        donut('무엇을', 'category', mainOnly),
        detail('무엇을 상세', 'category'),
        donut('함께', 'withWhom', mainOnly),
        detail('함께 상세', 'withWhom'),
        donut('만족도', 'rating', mainOnly.filter(m => m.rating)),
        donut('포만감', 'satiety', week.filter(m => m.satiety))
    ];
}

/**
 * 최근 N일(로컬) 구간에서 식사(메인 슬롯) 또는 간식 슬롯 **기록 건수**
 * @param {number} [days=7]
 * @param {'meal'|'snack'} [kind='meal']
 */
export function getWelcomeWeekSlotRecordCount(days = 7, kind = 'meal') {
    const hist =
        typeof window !== 'undefined' && window.mealHistory && Array.isArray(window.mealHistory)
            ? window.mealHistory
            : [];
    const today = new Date();
    const startDt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const start = toLocalDateString(startDt);
    const end = toLocalDateString(today);
    const week = hist.filter(m => m && typeof m.date === 'string' && m.date >= start && m.date <= end);
    if (kind === 'snack') {
        return week.filter(m => SNACK_SLOTS.includes(m.slotId)).length;
    }
    return week.filter(m => MEAL_SLOTS.includes(m.slotId)).length;
}

export function renderProportionChart(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const agg = aggregateProportionData(data, key);
    if (!agg) {
        container.innerHTML = '<div class="text-center py-4 px-5 text-slate-400 text-xs">데이터가 없습니다.</div>';
        return;
    }

    const { total, sorted, colorMap } = agg;
    
    let html = '<div class="relative analytics-chart-wrap">';
    html += '<div class="dashboard-stack-bar flex items-stretch overflow-hidden">';
    
    let cumulativeColorIndex = 0;
    const legendRows = [];
    
    sorted.forEach(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        let bg = colorMap[name] || '#94a3b8';
        
        if (name === '미입력') {
            bg = '#e2e8f0';
        } else if (CUMULATIVE_KEYS.includes(key)) {
            bg = CUMULATIVE_BAR_GRADIENT[cumulativeColorIndex % CUMULATIVE_BAR_GRADIENT.length];
            cumulativeColorIndex += 1;
        } else if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
            }
        } else if (key === 'satiety' || key === 'snackSatiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
        }
        
        if (pct > 0) {
            html += `<div style="width: ${pct}%; background: ${bg};"></div>`;
        }

        let displayName = name === '미입력' ? '미입력' : name;
        if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                displayName = '★'.repeat(ratingNum);
            }
        } else if (key === 'satiety' || key === 'snackSatiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    displayName = satietyData.label;
                }
            }
        }
        legendRows.push({ name: displayName, pct, bg, count });
    });
    
    html += '</div>';
    html += '<div class="dashboard-chart-legend">';
    const leftCount = Math.ceil(legendRows.length / 2);
    const leftRows = legendRows.slice(0, leftCount);
    const rightRows = legendRows.slice(leftCount);
    const renderLegendRow = ({ name, pct, bg }) =>
        `<div class="dashboard-chart-legend-row"><span class="dashboard-chart-swatch" style="background:${bg}"></span><span class="name">${name}</span><span class="pct">${pct}%</span></div>`;
    html += `<div class="dashboard-chart-legend-col">${leftRows.map(renderLegendRow).join('')}</div>`;
    html += `<div class="dashboard-chart-legend-col">${rightRows.map(renderLegendRow).join('')}</div>`;
    html += '</div>';
    html += '</div>';
    
    container.innerHTML = html;
}

function getDetailTabGroup(key) {
    if (MEAL_DETAIL_TABS.some((t) => t.key === key)) return 'meal';
    if (SNACK_DETAIL_TABS.some((t) => t.key === key)) return 'snack';
    return null;
}

function renderDetailModalTabs(group, activeKey) {
    const tabsEl = document.getElementById('detailModalTabs');
    if (!tabsEl) return;
    const tabs = group === 'meal' ? MEAL_DETAIL_TABS : group === 'snack' ? SNACK_DETAIL_TABS : null;
    if (!tabs) {
        tabsEl.classList.add('hidden');
        tabsEl.innerHTML = '';
        return;
    }
    tabsEl.classList.remove('hidden');
    tabsEl.innerHTML = tabs
        .map(
            (t) =>
                `<button type="button" class="detail-modal-tab${t.key === activeKey ? ' detail-modal-tab--active' : ''}" role="tab" aria-selected="${t.key === activeKey ? 'true' : 'false'}" data-detail-tab="${t.key}">${t.label}</button>`
        )
        .join('');
}

function renderDetailModalBody(key, records, filteredData) {
    const container = document.getElementById('detailContent');
    if (!container) return;
    const gaugeKeys = ['rating', 'snackRating', 'satiety', 'snackSatiety'];
    let bodyHtml = '';
    if (DETAIL_MODAL_TAB_KEYS.includes(key)) {
        bodyHtml = buildDetailRankTabHtml(records || [], key);
    } else if (gaugeKeys.includes(key)) {
        bodyHtml = buildDetailGaugeRankHtml(filteredData || [], key);
    } else {
        bodyHtml = '<p class="text-slate-400 text-xs py-2">표시할 상세가 없습니다.</p>';
    }
    container.innerHTML = bodyHtml || '<p class="text-slate-400 text-xs py-2">데이터가 없습니다.</p>';
}

function bindDetailModalTabsOnce() {
    const tabsEl = document.getElementById('detailModalTabs');
    if (!tabsEl || tabsEl.dataset.bound === '1') return;
    tabsEl.dataset.bound = '1';
    tabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-detail-tab]');
        if (!btn) return;
        const next = btn.getAttribute('data-detail-tab');
        if (!next || next === detailModalState.key) return;
        detailModalState.key = next;
        renderDetailModalTabs(detailModalState.group, next);
        renderDetailModalBody(next, detailModalState.records, null);
    });
}

/**
 * @param {string} key mealType|category|withWhom|snackType|…|rating…
 * @param {string} [title] 게이지 등 단일 상세용 제목 (탭 모드는 그룹 제목 사용)
 */
export function openDetailModal(key, title) {
    logUsageMetric('mealdang_analysis_detail_click').catch(() => {});
    const titleEl = document.getElementById('detailModalTitle');
    const headerEl = document.getElementById('detailModalHeader');
    if (headerEl) headerEl.classList.remove('hidden');

    if (!window.getDashboardData) {
        console.error('getDashboardData 함수를 찾을 수 없습니다.');
        return;
    }

    const { filteredData, mealRecordsForTable } = window.getDashboardData();
    const group = getDetailTabGroup(key);
    const records = mealRecordsForTable || [];

    if (group) {
        detailModalState = { group, key, records };
        if (titleEl) titleEl.textContent = group === 'meal' ? '식사 상세' : '간식 상세';
        renderDetailModalTabs(group, key);
        bindDetailModalTabsOnce();
        renderDetailModalBody(key, records, null);
    } else {
        detailModalState = { group: null, key, records: [] };
        if (titleEl) titleEl.textContent = title || '상세 통계';
        renderDetailModalTabs(null, key);
        renderDetailModalBody(key, records, filteredData || []);
    }

    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
    }

    document.getElementById('detailModal')?.classList.remove('hidden');
    lockBodyScroll('detailModal');
}

export function closeDetailModal() {
    document.getElementById('detailModal')?.classList.add('hidden');
    unlockBodyScroll('detailModal');
    detailModalState = { group: null, key: null, records: [] };
    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
    }
}

