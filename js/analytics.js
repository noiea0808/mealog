// 통계 및 차트 관련 함수들
import { SLOTS, VIBRANT_COLORS, RATING_GRADIENT, SATIETY_DATA } from './constants.js';
import { appState } from './state.js';
import { apiKey } from './firebase.js';
import { generateColorMap } from './utils.js';

export function renderProportionChart(containerId, data, key) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const counts = {};
    data.forEach(m => {
        let val = m[key];
        if (key === 'satiety' && val) val = SATIETY_DATA.find(d => d.val === val)?.label;
        val = val || '미지정';
        counts[val] = (counts[val] || 0) + 1;
    });
    
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) {
        container.innerHTML = `<p class="text-xs text-slate-300 text-center py-4">데이터 없음</p>`;
        return;
    }
    
    let sorted, getBg;
    if (key === 'rating') {
        sorted = Object.entries(counts).sort((a, b) => Number(a[0]) - Number(b[0]));
        getBg = (name) => {
            const r = parseInt(name);
            return (r >= 1 && r <= 5) ? RATING_GRADIENT[r - 1] : '#cbd5e1';
        };
    } else if (key === 'satiety') {
        sorted = Object.entries(counts).sort((a, b) => {
            const idxA = SATIETY_DATA.findIndex(d => d.label === a[0]);
            const idxB = SATIETY_DATA.findIndex(d => d.label === b[0]);
            return idxA - idxB;
        });
        getBg = (name) => {
            const item = SATIETY_DATA.find(d => d.label === name);
            return item ? item.chartColor : '#cbd5e1';
        };
    } else {
        sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        getBg = (name, idx) => VIBRANT_COLORS[idx % VIBRANT_COLORS.length];
    }
    
    let html = `<div class="prop-bar-container">`;
    sorted.forEach(([name, count], idx) => {
        const pct = (count / total * 100).toFixed(0);
        const bg = (key === 'rating' || key === 'satiety') ? getBg(name) : getBg(name, idx);
        let textColor = 'white';
        if ((key === 'rating' && parseInt(name) <= 2)) textColor = '#475569';
        if (pct > 5) {
            html += `<div class="prop-segment" style="width: ${pct}%; background: ${bg}; color: ${textColor}">${pct}%</div>`;
        }
    });
    html += `</div>`;
    
    // 각 세그먼트 바로 아래에 항목 이름만 표시 (같은 너비로)
    html += `<div class="flex mt-1" style="width: 100%;">`;
    sorted.forEach(([name, count], idx) => {
        let label = name;
        if (key === 'rating') label = `${name}점`;
        const pct = (count / total * 100).toFixed(0);
        if (pct > 5) {
            html += `<div class="flex items-center justify-center" style="width: ${pct}%;">
                <span class="text-[10px] text-slate-500 font-bold text-center">${label}</span>
            </div>`;
        }
    });
    html += `</div>`;
    
    container.innerHTML = html;
}

export function getDashboardData() {
    const state = appState;
    const today = new Date();
    let startDate = new Date();
    let endDate = new Date();
    let label = "";
    
    if (state.dashboardMode === '7d') {
        startDate.setDate(today.getDate() - 6);
        label = `${startDate.getMonth() + 1}.${startDate.getDate()} ~ ${today.getMonth() + 1}.${today.getDate()}`;
    } else if (state.dashboardMode === 'month') {
        const [y, m] = state.selectedMonth.split('-');
        startDate = new Date(parseInt(y), parseInt(m) - 1, 1);
        endDate = new Date(parseInt(y), parseInt(m), 0);
        label = `${y}년 ${parseInt(m)}월`;
    } else if (state.dashboardMode === 'custom') {
        startDate = new Date(state.customStartDate);
        endDate = new Date(state.customEndDate);
        label = "직접 설정";
    }
    
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];
    const filteredData = window.mealHistory.filter(m => m.date >= startStr && m.date <= endStr);
    const daysDiff = Math.max(1, Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1);
    
    return { filteredData, dateRangeText: label, days: daysDiff };
}

export async function getGeminiComment(data) {
    const simplifiedData = data.map(m => ({
        date: m.date,
        type: m.mealType,
        menu: m.menuDetail || m.category,
        isSnack: ['pre_morning', 'snack1', 'snack2', 'night'].includes(m.slotId)
    })).slice(0, 30);
    
    const prompt = `다정하고 유머러스한 AI 영양사 친구입니다. 사용자의 식사 기록을 보고 식습관 패턴에 대해 1~2문장으로 코멘트하세요. **자기소개나 인사는 생략하고 바로 분석 내용만 말해주세요.** 만약 간식(isSnack: true) 기록이 있다면 이에 대해서도 재치 있게 한 줄 덧붙여주세요. 한국어로 대답하세요. 데이터: ${JSON.stringify(simplifiedData)}`;
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        const result = await response.json();
        return result.candidates?.[0]?.content?.parts?.[0]?.text || "오늘도 맛있는 기록 되세요!";
    } catch (e) {
        console.error("Gemini API Error:", e);
        return "오늘도 맛있는 기록 되세요!";
    }
}

export async function updateDashboard() {
    const state = appState;
    if (!window.currentUser) return;
    
    const { filteredData, dateRangeText, days } = getDashboardData();
    document.getElementById('insightRange').innerText = dateRangeText;
    
    const setBtnStyle = (id, isActive) => {
        const el = document.getElementById(id);
        if (el) {
            el.className = isActive ?
                "flex-1 py-1 text-[10px] font-bold bg-white text-emerald-700 rounded-lg shadow-sm transition-all" :
                "flex-1 py-1 text-[10px] font-bold text-emerald-100 hover:bg-emerald-600/50 rounded-lg transition-colors";
        }
    };
    
    setBtnStyle('btn-dash-7d', state.dashboardMode === '7d');
    setBtnStyle('btn-dash-month', state.dashboardMode === 'month');
    setBtnStyle('btn-dash-custom', state.dashboardMode === 'custom');
    
    const datePicker = document.getElementById('customDatePicker');
    const monthPicker = document.getElementById('monthPickerContainer');
    if (datePicker) datePicker.classList.toggle('hidden', state.dashboardMode !== 'custom');
    if (monthPicker) monthPicker.classList.toggle('hidden', state.dashboardMode !== 'month');
    
    if (state.dashboardMode === 'custom') {
        document.getElementById('customStart').value = state.customStartDate.toISOString().split('T')[0];
        document.getElementById('customEnd').value = state.customEndDate.toISOString().split('T')[0];
    } else if (state.dashboardMode === 'month') {
        document.getElementById('monthInput').value = state.selectedMonth;
    }
    
    const mainMealsOnly = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId);
        return slot && slot.type === 'main';
    });
    
    renderProportionChart('propChartContainer', mainMealsOnly, 'mealType');
    renderProportionChart('categoryChartContainer', filteredData.filter(m => m.category), 'category');
    renderProportionChart('mateChartContainer', filteredData.filter(m => m.withWhom), 'withWhom');
    renderProportionChart('ratingChartContainer', filteredData.filter(m => m.rating), 'rating');
    renderProportionChart('satietyChartContainer', filteredData.filter(m => m.satiety), 'satiety');
    
    let targetDays = days;
    if (state.dashboardMode === 'month') {
        const today = new Date();
        const [selY, selM] = state.selectedMonth.split('-').map(Number);
        if (today.getFullYear() === selY && (today.getMonth() + 1) === selM) {
            targetDays = today.getDate();
        } else if (new Date(selY, selM - 1, 1) > today) {
            targetDays = 0;
        }
    }
    
    const totalRec = Math.max(0, targetDays * 3);
    const recCount = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
        // '???'는 기록 카운트에서 제외, Skip은 포함
        return slot && m.mealType !== '???';
    }).length;
    const statsBox = document.getElementById('insightStats');
    if (statsBox) statsBox.innerText = `${recCount}/${totalRec}회`;
    
    const insightBox = document.getElementById('insightText');
    if (filteredData.length < 5) {
        if (insightBox) insightBox.innerText = "데이터가 조금 더 모이면 분석해드릴게요! 🧐";
    } else {
        if (insightBox) insightBox.innerText = "분석 중...";
        try {
            const comment = await getGeminiComment(filteredData);
            if (insightBox) insightBox.innerText = comment;
        } catch (e) {
            if (insightBox) insightBox.innerText = "멋진 식사 기록이 쌓이고 있어요! ✨";
        }
    }
}

export function openDetailModal(key, title) {
    document.getElementById('detailModalTitle').innerText = title;
    const container = document.getElementById('detailContent');
    
    const { filteredData } = getDashboardData();
    const slots = ['morning', 'lunch', 'dinner'];
    const slotLabels = ['아침', '점심', '저녁'];
    
    const getValue = (m) => {
        if (key === 'satiety') return SATIETY_DATA.find(d => d.val === m.satiety)?.label || '미지정';
        return m[key] || '미지정';
    };
    
    let uniqueValues = [...new Set(filteredData.filter(m => slots.includes(m.slotId)).map(m => getValue(m)))];
    
    if (key === 'rating') {
        uniqueValues.sort((a, b) => parseInt(a) - parseInt(b));
    } else if (key === 'satiety') {
        uniqueValues.sort((a, b) => {
            const idxA = SATIETY_DATA.findIndex(d => d.label === a);
            const idxB = SATIETY_DATA.findIndex(d => d.label === b);
            return idxA - idxB;
        });
    }
    
    const datasets = uniqueValues.map((val, idx) => {
        const data = slots.map(slotId => {
            return filteredData.filter(m => m.slotId === slotId && getValue(m) == val).length;
        });
        
        let bg;
        if (key === 'rating') {
            const r = parseInt(val);
            bg = (r >= 1 && r <= 5) ? RATING_GRADIENT[r - 1] : '#cbd5e1';
        } else if (key === 'satiety') {
            const item = SATIETY_DATA.find(d => d.label === val);
            bg = item ? item.chartColor : '#cbd5e1';
        } else {
            const colorMap = generateColorMap(filteredData, key, VIBRANT_COLORS);
            bg = colorMap[val] || VIBRANT_COLORS[idx % VIBRANT_COLORS.length];
        }
        
        return {
            label: key === 'rating' ? `${val}점` : val,
            data: data,
            backgroundColor: bg,
            borderRadius: 4,
            barPercentage: 0.5
        };
    });
    
    // 차트 아래에 항목 표시할 HTML 준비
    let legendHtml = `<div class="flex flex-wrap gap-2 mt-1 justify-center">`;
    uniqueValues.forEach((val, idx) => {
        let bg;
        if (key === 'rating') {
            const r = parseInt(val);
            bg = (r >= 1 && r <= 5) ? RATING_GRADIENT[r - 1] : '#cbd5e1';
        } else if (key === 'satiety') {
            const item = SATIETY_DATA.find(d => d.label === val);
            bg = item ? item.chartColor : '#cbd5e1';
        } else {
            const colorMap = generateColorMap(filteredData, key, VIBRANT_COLORS);
            bg = colorMap[val] || VIBRANT_COLORS[idx % VIBRANT_COLORS.length];
        }
        const label = key === 'rating' ? `${val}점` : val;
        legendHtml += `<div class="flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full" style="background: ${bg}"></span>
            <span class="text-[10px] text-slate-500 font-bold">${label}</span>
        </div>`;
    });
    legendHtml += `</div>`;
    
    // HTML에 차트와 범례 추가
    container.innerHTML = '<div class="w-full h-64"><canvas id="detailChart"></canvas></div>' + legendHtml;
    
    // 차트 생성
    if (window.currentDetailChart) window.currentDetailChart.destroy();
    const ctx = document.getElementById('detailChart');
    if (ctx) {
        window.currentDetailChart = new Chart(ctx.getContext('2d'), {
            type: 'bar',
            data: { labels: slotLabels, datasets: datasets },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: { stacked: true, grid: { display: false } },
                    y: { stacked: true, beginAtZero: true, grid: { color: '#f1f5f9' } }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }
    
    document.getElementById('detailModal').classList.remove('hidden');
}

export function closeDetailModal() {
    document.getElementById('detailModal').classList.add('hidden');
}

export function setDashboardMode(m) {
    appState.dashboardMode = m;
    updateDashboard();
}

export function updateCustomDates() {
    const state = appState;
    const start = document.getElementById('customStart').value;
    const end = document.getElementById('customEnd').value;
    if (start && end) {
        state.customStartDate = new Date(start);
        state.customEndDate = new Date(end);
        updateDashboard();
    }
}

export function updateSelectedMonth() {
    const state = appState;
    const m = document.getElementById('monthInput').value;
    if (m) {
        state.selectedMonth = m;
        updateDashboard();
    }
}

