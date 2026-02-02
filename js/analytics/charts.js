// 차트 렌더링 관련 함수들
import { VIBRANT_COLORS, CUMULATIVE_BAR_GRADIENT, RATING_GRADIENT, SATIETY_DATA } from '../constants.js';
import { generateColorMap } from '../utils.js';

const CUMULATIVE_KEYS = ['mealType', 'category', 'withWhom', 'snackType', 'snackPlace']; // 식사·간식 바차트 동일 색구성(빈도순 그라데이션)
const DETAIL_MODAL_TAB_KEYS = ['mealType', 'category', 'withWhom', 'snackType', 'snackPlace']; // 상세보기 시 통계 + 세부 통계 탭 (간식 어디서 포함)
const MEAL_SLOTS = ['morning', 'lunch', 'dinner'];
const SNACK_SLOTS = ['pre_morning', 'snack1', 'snack2', 'night'];
import { getDayName } from './date-utils.js';

/** filteredData에서 장소/메뉴/사람별 빈도 집계 후 상위 10개 반환. options.menuSlotsOnly: 'meal' | 'snack' 이면 메뉴는 해당 슬롯만 집계 */
function getTop10Rankings(filteredData, options = {}) {
    const { menuSlotsOnly } = options;
    const dataForMenu = menuSlotsOnly === 'meal'
        ? filteredData.filter(m => MEAL_SLOTS.includes(m.slotId))
        : menuSlotsOnly === 'snack'
            ? filteredData.filter(m => SNACK_SLOTS.includes(m.slotId))
            : filteredData;
    const placeCounts = {};
    const menuCounts = {};
    const peopleCounts = {};
    filteredData.forEach(m => {
        const place = (m.place || '').trim();
        if (place) placeCounts[place] = (placeCounts[place] || 0) + 1;
        const peopleRaw = (m.withWhomDetail || '').trim();
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
        const menuRaw = (m.menuDetail || '').trim();
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

/** 세부 통계 탭 HTML 생성: key에 따라 테이블 형태로 1~10위 표시. 식사 무엇을=식사 메뉴만, 간식 무엇을=간식 메뉴만 */
function buildDetailRankTabHtml(filteredData, key) {
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
        const { place } = getTop10Rankings(filteredData);
        return renderTable(place, '입력된 장소가 없습니다.', '어디서');
    }
    if (key === 'snackPlace') {
        const snackOnly = filteredData.filter(m => SNACK_SLOTS.includes(m.slotId));
        const { place } = getTop10Rankings(snackOnly);
        return renderTable(place, '입력된 장소가 없습니다.', '어디서');
    }
    if (key === 'category') {
        const { menu } = getTop10Rankings(filteredData, { menuSlotsOnly: 'meal' });
        return renderTable(menu, '입력된 메뉴가 없습니다.', '메뉴');
    }
    if (key === 'withWhom') {
        const { people } = getTop10Rankings(filteredData);
        return renderTable(people, '입력된 사람이 없습니다.', '누구와');
    }
    if (key === 'snackType') {
        const { menu } = getTop10Rankings(filteredData, { menuSlotsOnly: 'snack' });
        return renderTable(menu, '입력된 메뉴가 없습니다.', '메뉴');
    }
    return '';
}

function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

export function renderProportionChart(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    // 사용자 설정 태그 목록 가져오기
    const userTags = window.userSettings?.tags || {};
    let allowedTags = null;
    
    // 태그 필터링이 필요한 키인지 확인
    if (key === 'mealType' && userTags.mealType) {
        allowedTags = new Set(userTags.mealType);
    } else if (key === 'category' && userTags.category) {
        allowedTags = new Set(userTags.category);
    } else if (key === 'withWhom' && userTags.withWhom) {
        allowedTags = new Set(userTags.withWhom);
    } else if (key === 'snackType' && userTags.snackType) {
        allowedTags = new Set(userTags.snackType);
    } else if (key === 'snackPlace' && userTags.snackPlaceMain) {
        allowedTags = new Set(userTags.snackPlaceMain);
    }
    // rating과 satiety는 숫자 값이므로 태그 필터링 불필요
    
    const counts = {};
    data.forEach(m => {
        let val = (key === 'snackPlace' ? (m.place || '').trim() : m[key]) || '미입력';
        
        // 태그 필터링: 사용자가 설정한 태그만 표시
        if (allowedTags && val !== '미입력') {
            if (!allowedTags.has(val)) {
                // 설정된 태그에 없으면 "미입력"으로 처리
                val = '미입력';
            }
        }
        
        counts[val] = (counts[val] || 0) + 1;
    });
    
    const total = data.length;
    if (total === 0 || Object.keys(counts).length === 0) {
        container.innerHTML = '<div class="text-center py-4 px-5 text-slate-400 text-xs">데이터가 없습니다.</div>';
        return;
    }
    
    // 사용자가 설정한 태그 순서대로 정렬 (데이터가 있는 것만, 미입력은 항상 마지막)
    let sorted;
    if (allowedTags) {
        const tagOrder = Array.from(allowedTags);
        const tagEntries = tagOrder
            .filter(tag => counts[tag] > 0)
            .map(tag => [tag, counts[tag]])
            .sort((a, b) => b[1] - a[1]); // 개수 내림차순
        
        // 미입력 항목이 있으면 마지막에 추가
        if (counts['미입력'] > 0) {
            tagEntries.push(['미입력', counts['미입력']]);
        }
        
        sorted = tagEntries;
    } else {
        const entries = Object.entries(counts);
        const emptyEntry = entries.find(([name]) => name === '미입력');
        const nonEmptyEntries = entries.filter(([name]) => name !== '미입력');
        
        // 만족도나 포만감의 경우 값 순서대로 정렬 (높은 수준이 오른쪽)
        if (key === 'rating' || key === 'snackRating') {
            const ratingEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum; // 오름차순 (1점부터 5점까지)
                }
                return 0;
            });
            sorted = emptyEntry ? [...ratingEntries, emptyEntry] : ratingEntries;
        } else if (key === 'satiety') {
            const satietyEntries = nonEmptyEntries.sort((a, b) => {
                const aNum = parseInt(a[0]);
                const bNum = parseInt(b[0]);
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum; // 오름차순 (1부터 5까지)
                }
                return 0;
            });
            sorted = emptyEntry ? [...satietyEntries, emptyEntry] : satietyEntries;
        } else {
            // 다른 경우는 개수 내림차순으로 정렬
            const sortedEntries = nonEmptyEntries.sort((a, b) => b[1] - a[1]);
            sorted = emptyEntry ? [...sortedEntries, emptyEntry] : sortedEntries;
        }
    }
    
    const colorMap = generateColorMap(data, key, VIBRANT_COLORS);
    
    // 차트와 라벨을 감싸는 컨테이너 (헤더와 같은 수평 범위로 정렬)
    let html = '<div class="relative analytics-chart-wrap">';
    html += '<div class="flex items-stretch h-8 rounded-full overflow-hidden border border-slate-200">';
    
    let cumulativePercent = 0;
    const segments = [];
    let cumulativeColorIndex = 0; // 식사방식/메뉴/함께한 즐거움: 좌→우 빈도순 그라데이션용
    
    sorted.forEach(([name, count]) => {
        const pct = Math.round((count / total) * 100);
        let bg = colorMap[name] || '#94a3b8';
        let textColor = '#ffffff';
        
        // 미입력 항목은 연회색으로 표시
        if (name === '미입력') {
            bg = '#e2e8f0'; // 연회색
            textColor = '#64748b'; // 진한 회색 텍스트
        } else if (CUMULATIVE_KEYS.includes(key)) {
            // 식사방식/메뉴/함께한 즐거움: 좌(많은 순)부터 그라데이션 색상 적용
            bg = CUMULATIVE_BAR_GRADIENT[cumulativeColorIndex % CUMULATIVE_BAR_GRADIENT.length];
            cumulativeColorIndex += 1;
        } else if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
            }
        } else if (key === 'satiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
        }
        
        if (pct < 5 || ((key === 'rating' || key === 'snackRating') && parseInt(name) <= 2)) textColor = '#475569';
        if (pct > 0) {
            html += `<div class="prop-segment flex items-center justify-center" style="width: ${pct}%; background: ${bg}; color: ${textColor}">${pct >= 5 ? `<span style="font-size: 1.2em">${pct}%</span>` : ''}</div>`;
            segments.push({
                name,
                count,
                startPercent: cumulativePercent,
                widthPercent: pct
            });
            cumulativePercent += pct;
        }
    });
    
    html += '</div>';
    
    // 차트 아래 라벨 추가 (각 세그먼트 중간에 배치, 겹침 처리)
    html += '<div class="relative h-5 mt-1 mb-0">';
    let lastLabelEnd = -1;
    segments.forEach(({ name, count, startPercent, widthPercent }) => {
        // 라벨 표시 텍스트 생성
        let displayName = name === '미입력' ? '미입력' : name;
        if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(name);
            if (!isNaN(ratingNum)) {
                displayName = `${ratingNum}점`;
            }
        } else if (key === 'satiety') {
            const satietyNum = parseInt(name);
            if (!isNaN(satietyNum)) {
                const satietyData = SATIETY_DATA.find(d => d.val === satietyNum);
                if (satietyData) {
                    displayName = satietyData.label;
                }
            }
        }
        
        // 세그먼트 중간 위치 계산
        const centerPercent = startPercent + widthPercent / 2;
        
        // 겹침 체크: 최소 8% 간격 유지
        if (centerPercent - lastLabelEnd >= 8 || lastLabelEnd < 0) {
            html += `<div class="absolute text-xs whitespace-nowrap" style="left: ${centerPercent}%; transform: translateX(-50%);">
                <span class="text-slate-600">${displayName}</span>
                <span class="text-slate-400">(${count})</span>
            </div>`;
            // 라벨의 예상 너비를 고려하여 lastLabelEnd 업데이트 (대략 10%로 간주)
            lastLabelEnd = centerPercent + 5;
        }
    });
    html += '</div>';
    html += '</div>';
    
    container.innerHTML = html;
}

export function openDetailModal(key, title) {
    document.getElementById('detailModalTitle').innerText = title;
    const container = document.getElementById('detailContent');
    
    if (!window.getDashboardData) {
        console.error('getDashboardData 함수를 찾을 수 없습니다.');
        return;
    }
    
    const { filteredData } = window.getDashboardData();
    
    // 사용자 설정 태그 목록 가져오기
    const userTags = window.userSettings?.tags || {};
    let allowedTags = null;
    
    // 태그 필터링이 필요한 키인지 확인
    if (key === 'mealType' && userTags.mealType) {
        allowedTags = new Set(userTags.mealType);
    } else if (key === 'category' && userTags.category) {
        allowedTags = new Set(userTags.category);
    } else if (key === 'withWhom' && userTags.withWhom) {
        allowedTags = new Set(userTags.withWhom);
    } else if (key === 'snackType' && userTags.snackType) {
        allowedTags = new Set(userTags.snackType);
    } else if (key === 'snackPlace' && userTags.snackPlaceMain) {
        allowedTags = new Set(userTags.snackPlaceMain);
    }
    // rating, snackRating, satiety는 숫자 값이므로 태그 필터링 불필요
    
    let slots, slotLabels;
    if (key === 'snackType' || key === 'snackRating' || key === 'snackPlace') {
        slots = ['pre_morning', 'snack1', 'snack2', 'night'];
        slotLabels = ['아침 전', '오전', '오후', '야식'];
    } else {
        slots = ['morning', 'lunch', 'dinner'];
        slotLabels = ['아침', '점심', '저녁'];
    }
    
    const getValue = (m) => {
        if (key === 'snackPlace') {
            return (m.place || '').trim() || '미입력';
        }
        if (key === 'satiety') {
            const satietyNum = parseInt(m.satiety);
            if (!isNaN(satietyNum)) {
                return SATIETY_DATA.find(d => d.val === satietyNum)?.label || '미입력';
            }
            return '미입력';
        }
        if (key === 'rating' || key === 'snackRating') {
            const ratingNum = parseInt(m.rating);
            if (!isNaN(ratingNum)) {
                return `${ratingNum}점`;
            }
            return '미입력';
        }
        return m[key] || '미입력';
    };
    
    const dataForSlots = filteredData.filter(m => slots.includes(m.slotId));
    const colorMap = generateColorMap(dataForSlots, key, VIBRANT_COLORS);
    
    // 본 차트와 동일한 항목별 색상: CUMULATIVE_KEYS는 전체 데이터 기준 빈도순 그라데이션으로 고정
    let globalColorMap = {};
    if (CUMULATIVE_KEYS.includes(key)) {
        const globalCounts = {};
        dataForSlots.forEach(m => {
            let val = getValue(m);
            if (allowedTags && val !== '미입력' && !allowedTags.has(val)) val = '미입력';
            globalCounts[val] = (globalCounts[val] || 0) + 1;
        });
        let globalSorted;
        if (allowedTags) {
            const tagOrder = Array.from(allowedTags);
            const tagEntries = tagOrder
                .filter(tag => globalCounts[tag] > 0)
                .map(tag => [tag, globalCounts[tag]])
                .sort((a, b) => b[1] - a[1]);
            if (globalCounts['미입력'] > 0) tagEntries.push(['미입력', globalCounts['미입력']]);
            globalSorted = tagEntries;
        } else {
            const entries = Object.entries(globalCounts);
            const nonEmpty = entries.filter(([name]) => name !== '미입력').sort((a, b) => b[1] - a[1]);
            const emptyEntry = entries.find(([name]) => name === '미입력');
            globalSorted = emptyEntry ? [...nonEmpty, emptyEntry] : nonEmpty;
        }
        globalSorted.forEach(([name], idx) => {
            if (name !== '미입력') {
                globalColorMap[name] = CUMULATIVE_BAR_GRADIENT[idx % CUMULATIVE_BAR_GRADIENT.length];
            }
        });
    }
    
    let chartHtml = '<div class="space-y-4">';
    
    // 각 슬롯별로 별도 차트 생성
    slots.forEach((slotId, slotIndex) => {
        const slotLabel = slotLabels[slotIndex];
        const slotData = filteredData.filter(m => m.slotId === slotId);
        
        if (slotData.length === 0) {
            chartHtml += `<div class="mb-4">
                <h3 class="text-sm font-bold text-slate-700 mb-2">${slotLabel}</h3>
                <div class="text-center py-4 text-slate-400 text-xs">데이터가 없습니다.</div>
            </div>`;
            return;
        }
        
        // 해당 슬롯의 값별 카운트
        const counts = {};
        slotData.forEach(m => {
            let val = getValue(m);
            
            // 태그 필터링: 사용자가 설정한 태그만 표시
            if (allowedTags && val !== '미입력') {
                if (!allowedTags.has(val)) {
                    // 설정된 태그에 없으면 "미입력"으로 처리
                    val = '미입력';
                }
            }
            
            counts[val] = (counts[val] || 0) + 1;
        });
        
        const total = slotData.length;
        
        // 사용자가 설정한 태그 순서대로 정렬 (데이터가 있는 것만, 미입력은 항상 마지막)
        let sorted;
        if (allowedTags) {
            const tagOrder = Array.from(allowedTags);
            const tagEntries = tagOrder
                .filter(tag => counts[tag] > 0)
                .map(tag => [tag, counts[tag]])
                .sort((a, b) => b[1] - a[1]); // 개수 내림차순
            
            // 미입력 항목이 있으면 마지막에 추가
            if (counts['미입력'] > 0) {
                tagEntries.push(['미입력', counts['미입력']]);
            }
            
            sorted = tagEntries;
        } else {
            const entries = Object.entries(counts);
            const nonEmptyEntries = entries.filter(([name]) => name !== '미입력').sort((a, b) => b[1] - a[1]);
            const emptyEntry = entries.find(([name]) => name === '미입력');
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
        }
        
        // 만족도나 포만감의 경우 정렬 (미입력은 항상 마지막)
        if (key === 'rating' || key === 'snackRating') {
            const emptyEntry = sorted.find(([name]) => name === '미입력');
            const nonEmptyEntries = sorted.filter(([name]) => name !== '미입력').sort((a, b) => {
                const aNum = parseInt(a[0].replace('점', ''));
                const bNum = parseInt(b[0].replace('점', ''));
                if (!isNaN(aNum) && !isNaN(bNum)) {
                    return aNum - bNum;
                }
                return 0;
            });
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
        } else if (key === 'satiety') {
            const emptyEntry = sorted.find(([name]) => name === '미입력');
            const nonEmptyEntries = sorted.filter(([name]) => name !== '미입력').sort((a, b) => {
                const aData = SATIETY_DATA.find(d => d.label === a[0]);
                const bData = SATIETY_DATA.find(d => d.label === b[0]);
                if (aData && bData) {
                    return aData.val - bData.val;
                }
                return 0;
            });
            sorted = emptyEntry ? [...nonEmptyEntries, emptyEntry] : nonEmptyEntries;
        }
        
        chartHtml += `<div class="mb-4">
            <h3 class="text-sm font-bold text-slate-700 mb-2">${slotLabel}</h3>
            <div class="relative">
                <div class="flex items-stretch h-10 rounded-full overflow-hidden border border-slate-200">`;
        
        let cumulativePercent = 0;
        const segments = [];
        
        sorted.forEach(([name, count]) => {
            const pct = Math.round((count / total) * 100);
            let bg = colorMap[name] || '#94a3b8';
            let textColor = '#ffffff';
            
            // 미입력 항목은 연회색으로 표시
            if (name === '미입력') {
                bg = '#e2e8f0'; // 연회색
                textColor = '#64748b'; // 진한 회색 텍스트
            } else if (CUMULATIVE_KEYS.includes(key) && globalColorMap[name]) {
                bg = globalColorMap[name]; // 본 차트와 동일한 항목별 색상
            } else if (key === 'rating' || key === 'snackRating') {
                const ratingNum = parseInt(name.replace('점', ''));
                if (!isNaN(ratingNum)) {
                    bg = RATING_GRADIENT[ratingNum - 1] || RATING_GRADIENT[0];
                }
            } else if (key === 'satiety') {
                const satietyData = SATIETY_DATA.find(d => d.label === name);
                if (satietyData) {
                    bg = satietyData.chartColor;
                }
            }
            
            if (pct < 5 || ((key === 'rating' || key === 'snackRating') && parseInt(name) <= 2)) textColor = '#475569';
            if (pct > 0) {
                chartHtml += `<div class="prop-segment relative flex items-center justify-center" style="width: ${pct}%; background: ${bg}; color: ${textColor}">
                    ${pct >= 8 ? `<span class="text-[12px]">${pct}%</span>` : ''}
                </div>`;
                segments.push({
                    name,
                    count,
                    pct,
                    startPercent: cumulativePercent,
                    widthPercent: pct
                });
                cumulativePercent += pct;
            }
        });
        
        chartHtml += `</div>
                <div class="relative h-5 mt-1">`;
        
        let lastLabelEnd = -1;
        segments.forEach(({ name, count, startPercent, widthPercent }) => {
            // 세그먼트 중간 위치 계산
            const centerPercent = startPercent + widthPercent / 2;
            
            // 라벨 표시 텍스트 생성 (미입력은 그대로 표시)
            const displayName = name === '미입력' ? '미입력' : name;
            
            // 겹침 체크: 최소 8% 간격 유지
            if (centerPercent - lastLabelEnd >= 8 || lastLabelEnd < 0) {
                chartHtml += `<div class="absolute text-xs whitespace-nowrap" style="left: ${centerPercent}%; transform: translateX(-50%);">
                    <span class="text-slate-600">${displayName}</span>
                    <span class="text-slate-400">(${count})</span>
                </div>`;
                // 라벨의 예상 너비를 고려하여 lastLabelEnd 업데이트 (대략 10%로 간주)
                lastLabelEnd = centerPercent + 5;
            }
        });
        
        chartHtml += `</div>
            </div>
        </div>`;
    });
    
    chartHtml += '</div>';
    
    // 식사방식/메뉴/함께한 즐거움: 탭만 상단, 제목 숨김 / 탭 선택=검정, 미선택=회색
    const useTabs = DETAIL_MODAL_TAB_KEYS.includes(key);
    const headerEl = document.getElementById('detailModalHeader');
    if (useTabs) {
        if (headerEl) headerEl.classList.add('hidden');
        const rankHtml = buildDetailRankTabHtml(filteredData, key);
        container.innerHTML = `
            <div class="flex items-center border-b border-slate-200 mb-4 -mx-1 flex-shrink-0">
                <div class="flex flex-1">
                    <button type="button" id="detailTabChartBtn" class="detail-modal-tab active flex-1 py-2.5 px-3 text-sm font-bold text-slate-900 border-b-2 border-slate-900 transition-colors">${title}</button>
                    <button type="button" id="detailTabRankBtn" class="detail-modal-tab flex-1 py-2.5 px-3 text-sm font-bold text-slate-400 border-b-2 border-transparent hover:text-slate-600 transition-colors">어디서 / 메뉴 / 누구와</button>
                </div>
                <button type="button" onclick="window.closeDetailModal()" class="p-2 -m-2 text-slate-500 hover:text-slate-700 flex-shrink-0" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div id="detailTabChartPanel" class="detail-modal-panel">${chartHtml}</div>
            <div id="detailTabRankPanel" class="detail-modal-panel hidden">${rankHtml}</div>
        `;
        const chartBtn = document.getElementById('detailTabChartBtn');
        const rankBtn = document.getElementById('detailTabRankBtn');
        const chartPanel = document.getElementById('detailTabChartPanel');
        const rankPanel = document.getElementById('detailTabRankPanel');
        chartBtn.addEventListener('click', () => {
            chartBtn.classList.add('active', 'text-slate-900', 'border-slate-900');
            chartBtn.classList.remove('text-slate-400');
            rankBtn.classList.remove('active', 'text-slate-900', 'border-slate-900');
            rankBtn.classList.add('text-slate-400', 'border-transparent');
            chartPanel.classList.remove('hidden');
            rankPanel.classList.add('hidden');
        });
        rankBtn.addEventListener('click', () => {
            rankBtn.classList.add('active', 'text-slate-900', 'border-slate-900');
            rankBtn.classList.remove('text-slate-400', 'border-transparent');
            chartBtn.classList.remove('active', 'text-slate-900', 'border-slate-900');
            chartBtn.classList.add('text-slate-400', 'border-transparent');
            rankPanel.classList.remove('hidden');
            chartPanel.classList.add('hidden');
        });
    } else {
        if (headerEl) headerEl.classList.remove('hidden');
        document.getElementById('detailModalTitle').innerText = title;
        container.innerHTML = chartHtml;
    }
    
    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
    }
    
    document.getElementById('detailModal').classList.remove('hidden');
}

export function closeDetailModal() {
    document.getElementById('detailModal').classList.add('hidden');
    if (window.currentDetailChart) {
        window.currentDetailChart.destroy();
        window.currentDetailChart = null;
    }
}

