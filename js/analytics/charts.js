// 차트 렌더링 관련 함수들
import { VIBRANT_COLORS, RATING_GRADIENT, SATIETY_DATA } from '../constants.js';
import { generateColorMap } from '../utils.js';
import { getDayName } from './date-utils.js';

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
    }
    // rating과 satiety는 숫자 값이므로 태그 필터링 불필요
    
    const counts = {};
    data.forEach(m => {
        let val = m[key] || '미입력';
        
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
    
    // 차트와 라벨을 감싸는 컨테이너
    let html = '<div class="relative">';
    html += '<div class="flex items-stretch h-6 rounded-full overflow-hidden border border-slate-200">';
    
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
            html += `<div class="prop-segment" style="width: ${pct}%; background: ${bg}; color: ${textColor}">${pct >= 5 ? `${pct}%` : ''}</div>`;
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
    }
    // rating, snackRating, satiety는 숫자 값이므로 태그 필터링 불필요
    
    let slots, slotLabels;
    if (key === 'snackType' || key === 'snackRating') {
        slots = ['pre_morning', 'snack1', 'snack2', 'night'];
        slotLabels = ['아침 전', '오전', '오후', '야식'];
    } else {
        slots = ['morning', 'lunch', 'dinner'];
        slotLabels = ['아침', '점심', '저녁'];
    }
    
    const getValue = (m) => {
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
    
    const colorMap = generateColorMap(filteredData.filter(m => slots.includes(m.slotId)), key, VIBRANT_COLORS);
    
    let html = '<div class="space-y-4">';
    
    // 각 슬롯별로 별도 차트 생성
    slots.forEach((slotId, slotIndex) => {
        const slotLabel = slotLabels[slotIndex];
        const slotData = filteredData.filter(m => m.slotId === slotId);
        
        if (slotData.length === 0) {
            html += `<div class="mb-4">
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
        
        html += `<div class="mb-4">
            <h3 class="text-sm font-bold text-slate-700 mb-2">${slotLabel}</h3>
            <div class="relative">
                <div class="flex items-stretch h-8 rounded-full overflow-hidden border border-slate-200">`;
        
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
                html += `<div class="prop-segment relative" style="width: ${pct}%; background: ${bg}; color: ${textColor}">
                    ${pct >= 8 ? `<span class="text-[10px] font-bold">${pct}%</span>` : ''}
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
        
        html += `</div>
                <div class="relative h-5 mt-1">`;
        
        let lastLabelEnd = -1;
        segments.forEach(({ name, count, startPercent, widthPercent }) => {
            // 세그먼트 중간 위치 계산
            const centerPercent = startPercent + widthPercent / 2;
            
            // 라벨 표시 텍스트 생성 (미입력은 그대로 표시)
            const displayName = name === '미입력' ? '미입력' : name;
            
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
        
        html += `</div>
            </div>
        </div>`;
    });
    
    html += '</div>';
    container.innerHTML = html;
    
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

