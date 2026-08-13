// ADMIN 콘텐츠 관리 > 분류사전 — '무엇을' 자동 분류 규칙·사전 열람 (읽기 전용)
//
// 사전 원본은 js/utils/food-classifier.js 코드에 있다. 여기서는 그대로 import해
// 보여주기만 한다 — 화면과 실제 분류 로직이 어긋날 수 없는 구조.
// 사전 수정은 코드 배포로만 한다 (docs/food-category-auto-classification.md §4 사전 관리 기준).
import {
    AUTO_CATEGORIES,
    FOOD_KEYWORDS,
    SNACK_KEYWORDS,
    ONE_CHAR_FOODS,
    classifyFoodText,
    classifySnackText,
    tokenizeFoodText,
} from '../utils/food-classifier.js';
import { escapeHtml } from './utils.js';

/** 카테고리별 키워드 칩 그리드 HTML */
function renderDictSection(title, subtitle, dictionary, order) {
    const keys = order || Object.keys(dictionary);
    const blocks = keys
        .filter((cat) => Array.isArray(dictionary[cat]))
        .map((cat) => {
            const keywords = dictionary[cat];
            const chips = keywords
                .map((k) => `<span class="inline-block px-2 py-1 bg-slate-100 text-slate-700 rounded-md text-xs font-semibold">${escapeHtml(k)}</span>`)
                .join(' ');
            return `
                <div class="border border-slate-200 rounded-xl p-4 bg-white">
                    <div class="flex items-center justify-between mb-2">
                        <h4 class="text-sm font-black text-slate-800">${escapeHtml(cat)}</h4>
                        <span class="text-xs text-slate-400 font-bold">${keywords.length}개</span>
                    </div>
                    <div class="flex flex-wrap gap-1.5">${chips}</div>
                </div>`;
        })
        .join('');
    return `
        <div class="mb-6">
            <h3 class="text-base font-black text-slate-800 mb-1">${escapeHtml(title)}</h3>
            <p class="text-xs text-slate-500 mb-3">${subtitle}</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${blocks}</div>
        </div>`;
}

/** 한 글자 예외 표 HTML */
function renderOneCharSection() {
    const rows = Array.from(ONE_CHAR_FOODS.entries())
        .map(([token, cat]) => `
            <tr class="border-b border-slate-100 last:border-0">
                <td class="py-1.5 px-3 font-black text-slate-800">${escapeHtml(token)}</td>
                <td class="py-1.5 px-3 text-slate-600">${escapeHtml(cat)}</td>
            </tr>`)
        .join('');
    return `
        <div class="mb-6">
            <h3 class="text-base font-black text-slate-800 mb-1">한 글자 예외</h3>
            <p class="text-xs text-slate-500 mb-3">한 글자 토큰은 오탐이 많아 원칙적으로 버리지만, 실데이터 최빈 음식어는 예외로 인정합니다.</p>
            <div class="border border-slate-200 rounded-xl bg-white overflow-hidden inline-block">
                <table class="text-sm">
                    <thead><tr class="bg-slate-50 text-xs text-slate-500">
                        <th class="py-2 px-3 text-left font-bold">토큰</th>
                        <th class="py-2 px-3 text-left font-bold">카테고리</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

/** 분류 규칙 요약 카드 HTML */
function renderRulesSection() {
    return `
        <div class="mb-6 bg-slate-50 rounded-xl p-5 border border-slate-200">
            <h3 class="text-base font-black text-slate-800 mb-3">분류 규칙</h3>
            <ol class="list-decimal list-inside space-y-2 text-sm text-slate-700">
                <li><b>토큰 분해</b> — 상세 텍스트를 <code class="text-xs bg-white border border-slate-200 rounded px-1">+ , ， · 공백 줄바꿈</code> 으로 나눕니다.</li>
                <li><b>수량·단위 제거</b> — 토큰 끝의 수량 표기를 떼어냅니다. 예: "닭다리살100"→"닭다리살", "계란 2알"→"계란", "밥1/2공기"→"밥"</li>
                <li><b>짧은 토큰 버림</b> — 2글자 미만은 버립니다. 단, 아래 '한 글자 예외' 표의 토큰은 해당 카테고리에 바로 1표.</li>
                <li><b>사전 투표</b> — 토큰이 키워드를 <b>포함</b>하면 그 카테고리에 1표. 예: "훈제계란"은 '계란'을 포함하므로 단백질식 1표.</li>
                <li><b>제안 확정</b> — 최다 득표 카테고리를 제안. 2위 득표가 1위의 절반 이상이면 2위까지 함께 제안 (최대 2개).</li>
            </ol>
            <div class="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <p>· 결과는 <b>제안 칩(✨)</b>일 뿐 자동 저장되지 않습니다 — 사용자가 눌러야 기록에 반영됩니다.</p>
                <p>· 분류 실패는 "제안 없음"일 뿐이며 저장 경로에 영향을 주지 않습니다.</p>
                <p>· 간식 제안은 사용자 태그 목록(snackType)에 있는 값만 노출합니다.</p>
                <p>· 개인 사전(사용자 교정 학습)은 설계만 있고 아직 미적용입니다 — 적용 시 전역 사전보다 우선합니다.</p>
                <p>· 사전 수정은 코드 배포로만 합니다. 추가 기준: 실데이터 반복 관측 + 의미가 확실한 2글자 이상 구체어.</p>
            </div>
        </div>`;
}

/** 실시간 테스트 입력 카드 HTML */
function renderTesterSection() {
    return `
        <div class="mb-6 bg-emerald-50/60 rounded-xl p-5 border border-emerald-200">
            <h3 class="text-base font-black text-slate-800 mb-1">분류 테스트</h3>
            <p class="text-xs text-slate-500 mb-3">'무엇을' 상세 텍스트를 넣으면 실제 분류기와 동일한 코드로 결과를 보여줍니다.</p>
            <input type="text" id="foodDictTestInput"
                   placeholder="예: 잡곡밥 + 제육볶음 + 계란국"
                   class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-emerald-500 transition-colors">
            <div id="foodDictTestResult" class="mt-3 text-sm text-slate-400">입력하면 토큰·제안 결과가 여기에 표시됩니다.</div>
        </div>`;
}

function runTester() {
    const input = document.getElementById('foodDictTestInput');
    const out = document.getElementById('foodDictTestResult');
    if (!input || !out) return;
    const text = input.value.trim();
    if (!text) {
        out.className = 'mt-3 text-sm text-slate-400';
        out.textContent = '입력하면 토큰·제안 결과가 여기에 표시됩니다.';
        return;
    }
    const tokens = tokenizeFoodText(text);
    const mealResult = classifyFoodText(text);
    const snackResult = classifySnackText(text); // 태그 필터 없이 원제안 표시 (실사용은 사용자 태그로 한 번 더 거름)
    const chip = (v, color) => `<span class="inline-block px-2 py-1 ${color} rounded-md text-xs font-bold">${escapeHtml(v)}</span>`;
    out.className = 'mt-3 text-sm text-slate-700 space-y-2';
    out.innerHTML = `
        <div><span class="text-xs font-bold text-slate-500 mr-2">토큰</span>${tokens.length ? tokens.map((t) => chip(t, 'bg-white border border-slate-200 text-slate-600')).join(' ') : '<span class="text-xs text-slate-400">없음</span>'}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">끼니 제안</span>${mealResult.length ? mealResult.map((c) => chip(c, 'bg-emerald-100 text-emerald-700')).join(' ') : '<span class="text-xs text-slate-400">제안 없음</span>'}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">간식 제안</span>${snackResult.length ? snackResult.map((c) => chip(c, 'bg-amber-100 text-amber-700')).join(' ') : '<span class="text-xs text-slate-400">제안 없음</span>'}</div>`;
}

let foodDictRendered = false;

/** 분류사전 섹션 렌더 (정적 데이터라 1회만) */
export function loadFoodDictContent() {
    const container = document.getElementById('foodDictContainer');
    if (!container || foodDictRendered) return;
    foodDictRendered = true;
    container.innerHTML = [
        renderTesterSection(),
        renderRulesSection(),
        renderDictSection(
            '끼니 사전 (새 축)',
            '끼니 "무엇을" 상세 텍스트에 적용됩니다. 축은 식사 형태 기반 새 축이며, 기존 축(한식/양식…)과의 호환은 읽기 계층이 처리합니다.',
            FOOD_KEYWORDS,
            AUTO_CATEGORIES
        ),
        renderOneCharSection(),
        renderDictSection(
            '간식 사전 (기존 snackType 축)',
            '간식은 기존 축을 그대로 씁니다. 사용자 태그 목록에 없는 값은 제안하지 않습니다.',
            SNACK_KEYWORDS
        ),
    ].join('');
    document.getElementById('foodDictTestInput')?.addEventListener('input', runTester);
}
