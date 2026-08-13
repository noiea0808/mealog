// ADMIN 콘텐츠 관리 > 분류사전 — '무엇을' 자동 분류 규칙·사전 열람 (읽기 전용)
//
// 사전 원본은 js/utils/food-dictionary.js 코드에 있다. 여기서는 그대로 import해
// 보여주기만 한다 — 화면과 실제 분류 로직이 어긋날 수 없는 구조.
// 사전 수정은 코드 배포로만 한다 (docs/entry-axes-and-tags-direction.md §5 사전 관리 기준).
import {
    FORM_CATEGORIES,
    CUISINE_CATEGORIES,
    SNACK_KEYWORDS,
    ONE_CHAR_FOODS,
    DICTIONARY_SOURCE,
    classifyFoodDetail,
    classifySnackText,
    tokenizeFoodText,
} from '../utils/food-classifier.js';
import { escapeHtml } from './utils.js';

/** 형태 → 요리종류 → 음식 목록 (사전 원본 구조 그대로) */
function renderFormSection() {
    const blocks = FORM_CATEGORIES
        .filter((form) => DICTIONARY_SOURCE[form])
        .map((form) => {
            const byCuisine = DICTIONARY_SOURCE[form];
            const total = Object.values(byCuisine).reduce((n, arr) => n + arr.length, 0);
            const rows = CUISINE_CATEGORIES
                .filter((c) => Array.isArray(byCuisine[c]) && byCuisine[c].length)
                .map((cuisine) => {
                    const chips = byCuisine[cuisine]
                        .map((w) => `<span class="inline-block px-2 py-1 bg-slate-100 text-slate-700 rounded-md text-xs font-semibold">${escapeHtml(w)}</span>`)
                        .join(' ');
                    return `
                        <div class="mb-2">
                            <span class="inline-block mb-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md text-xs font-bold">${escapeHtml(cuisine)}</span>
                            <div class="flex flex-wrap gap-1.5">${chips}</div>
                        </div>`;
                })
                .join('');
            return `
                <div class="border border-slate-200 rounded-xl p-4 bg-white">
                    <div class="flex items-center justify-between mb-2">
                        <h4 class="text-sm font-black text-slate-800">${escapeHtml(form)}</h4>
                        <span class="text-xs text-slate-400 font-bold">${total}개</span>
                    </div>
                    ${rows}
                </div>`;
        })
        .join('');
    return `
        <div class="mb-6">
            <h3 class="text-base font-black text-slate-800 mb-1">끼니 사전 — 형태 × 요리 종류</h3>
            <p class="text-xs text-slate-500 mb-3">음식 하나가 <b>형태</b>(사용자가 고르는 주 축)와 <b>요리 종류</b>(자동 저장, 입력받지 않음) 두 라벨을 함께 갖습니다. 매칭은 <b>최장 일치</b>라 '탕수육'이 '수육'보다 먼저 잡힙니다.</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${blocks}</div>
        </div>`;
}

/** 간식 사전 (기존 snackType 축) */
function renderSnackSection() {
    const blocks = Object.entries(SNACK_KEYWORDS)
        .map(([cat, keywords]) => {
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
            <h3 class="text-base font-black text-slate-800 mb-1">간식 사전 (기존 snackType 축)</h3>
            <p class="text-xs text-slate-500 mb-3">간식은 아직 기존 축을 씁니다. 형태 축으로의 통합은 실데이터 검증 뒤 예정입니다. 사용자 태그 목록에 없는 값은 제안하지 않습니다.</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${blocks}</div>
        </div>`;
}

/** 한 글자 예외 표 */
function renderOneCharSection() {
    const rows = Array.from(ONE_CHAR_FOODS.entries())
        .map(([token, v]) => `
            <tr class="border-b border-slate-100 last:border-0">
                <td class="py-1.5 px-3 font-black text-slate-800">${escapeHtml(token)}</td>
                <td class="py-1.5 px-3 text-slate-600">${escapeHtml(v.form)}</td>
                <td class="py-1.5 px-3 text-slate-500">${escapeHtml(v.cuisine)}</td>
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
                        <th class="py-2 px-3 text-left font-bold">형태</th>
                        <th class="py-2 px-3 text-left font-bold">요리 종류</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

/** 분류 규칙 요약 */
function renderRulesSection() {
    return `
        <div class="mb-6 bg-slate-50 rounded-xl p-5 border border-slate-200">
            <h3 class="text-base font-black text-slate-800 mb-3">분류 규칙</h3>
            <ol class="list-decimal list-inside space-y-2 text-sm text-slate-700">
                <li><b>토큰 분해</b> — 상세 텍스트를 <code class="text-xs bg-white border border-slate-200 rounded px-1">+ , ， · 공백 줄바꿈</code> 으로 나눕니다.</li>
                <li><b>수량·단위 제거</b> — 토큰 끝의 수량 표기를 떼어냅니다. 예: "닭다리살100"→"닭다리살", "계란 2알"→"계란"</li>
                <li><b>짧은 토큰 버림</b> — 2글자 미만은 버립니다. 단, '한 글자 예외' 표의 토큰은 예외.</li>
                <li><b>최장 일치</b> — 토큰이 품은 사전 항목 중 <b>가장 긴 것 하나</b>만 채택합니다. 한 토큰이 여러 카테고리에 표를 뿌리지 않습니다.</li>
                <li><b>집계</b> — 형태는 최다 득표, 2위가 1위의 절반 이상이면 복수 제안(최대 2개). 요리 종류는 최다 득표 하나만이며 '기타'는 구체적인 값이 있으면 양보합니다.</li>
            </ol>
            <div class="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <p>· <b>형태</b>는 제안 칩(✨)으로 뜨고 사용자가 눌러야 기록에 반영됩니다.</p>
                <p>· <b>요리 종류</b>는 묻지 않고 <code class="bg-white border border-slate-200 rounded px-1">cuisineAuto</code> 로 자동 저장됩니다(사실-유도).</p>
                <p>· 분류 실패는 "제안 없음"일 뿐이며 저장 경로에 영향을 주지 않습니다.</p>
                <p>· 사전 추가 기준: 실데이터 반복 관측 · 형태는 "주된 몸통이 무엇인가" · 요리 종류가 애매하면 '기타'로 두고 형태만 채웁니다.</p>
            </div>
        </div>`;
}

/** 실시간 테스트 */
function renderTesterSection() {
    return `
        <div class="mb-6 bg-emerald-50/60 rounded-xl p-5 border border-emerald-200">
            <h3 class="text-base font-black text-slate-800 mb-1">분류 테스트</h3>
            <p class="text-xs text-slate-500 mb-3">'무엇을' 상세 텍스트를 넣으면 실제 분류기와 동일한 코드로 결과를 보여줍니다.</p>
            <input type="text" id="foodDictTestInput"
                   placeholder="예: 짜장면 + 탕수육"
                   class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-emerald-500 transition-colors">
            <div id="foodDictTestResult" class="mt-3 text-sm text-slate-400">입력하면 토큰·형태·요리 종류가 여기에 표시됩니다.</div>
        </div>`;
}

function runTester() {
    const input = document.getElementById('foodDictTestInput');
    const out = document.getElementById('foodDictTestResult');
    if (!input || !out) return;
    const text = input.value.trim();
    if (!text) {
        out.className = 'mt-3 text-sm text-slate-400';
        out.textContent = '입력하면 토큰·형태·요리 종류가 여기에 표시됩니다.';
        return;
    }
    const tokens = tokenizeFoodText(text);
    const detail = classifyFoodDetail(text);
    const snackResult = classifySnackText(text); // 태그 필터 없이 원제안 (실사용은 사용자 태그로 한 번 더 거름)
    const chip = (v, color) => `<span class="inline-block px-2 py-1 ${color} rounded-md text-xs font-bold">${escapeHtml(v)}</span>`;
    const none = '<span class="text-xs text-slate-400">없음</span>';
    out.className = 'mt-3 text-sm text-slate-700 space-y-2';
    out.innerHTML = `
        <div><span class="text-xs font-bold text-slate-500 mr-2">토큰</span>${tokens.length ? tokens.map((t) => chip(t, 'bg-white border border-slate-200 text-slate-600')).join(' ') : none}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">형태</span>${detail.forms.length ? detail.forms.map((c) => chip(c, 'bg-emerald-100 text-emerald-700')).join(' ') : none}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">요리 종류</span>${detail.cuisine ? chip(detail.cuisine, 'bg-sky-100 text-sky-700') : none}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">간식 제안</span>${snackResult.length ? snackResult.map((c) => chip(c, 'bg-amber-100 text-amber-700')).join(' ') : none}</div>`;
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
        renderFormSection(),
        renderOneCharSection(),
        renderSnackSection(),
    ].join('');
    document.getElementById('foodDictTestInput')?.addEventListener('input', runTester);
}
