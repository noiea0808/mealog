// ADMIN 콘텐츠 관리 > 분류사전
//
// 두 가지를 담는다:
//  1) 읽기 — 추론 흐름(메뉴 → 분류 → 어떻게 → 어디서 → 누구와)과 통상/개인 분류의 적용 규칙
//  2) 편집 — 끼니 사전의 음식별 형태·요리 종류
//
// 기본 사전은 코드(js/utils/food-dictionary.js)에 있고, 여기서 고친 값은 Firestore
// `content/foodDictionary` 에 **오버라이드**로 쌓인다. 코드 사전을 지우지 않으므로
// 언제든 '기본값으로 되돌리기'가 가능하다.
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import {
    FORM_CATEGORIES,
    CUISINE_CATEGORIES,
    ONE_CHAR_FOODS,
    DICTIONARY_SOURCE,
    FOOD_ENTRIES,
    classifyFoodDetail,
    tokenizeFoodText,
    setFoodDictionaryOverrides,
    getFoodDictionaryOverrides,
    isBaseFoodEntry,
    getBaseFoodEntry,
    formUsesCuisine,
} from '../utils/food-classifier.js';
import { escapeHtml } from './utils.js';

/** 편집 중 상태 — 저장 전까지 Firestore에 쓰지 않는다 */
let draft = { entries: {}, removed: [] };
let filterText = '';
/** 터치 기기용 2단계 이동: 칩을 눌러 고른 뒤 대상 칸의 종류 이름을 누른다 */
let selectedWord = null;

/** onclick="fn('...')" 안에 들어갈 문자열 — 따옴표·역슬래시가 속성을 깨지 않게 */
function jsArg(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

/* ─────────────────────────── 1. 추론 흐름 설명 ─────────────────────────── */

function renderFlowSection() {
    const step = (n, title, body) => `
        <div class="flex gap-3 mb-3">
            <span class="shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-black flex items-center justify-center">${n}</span>
            <div class="min-w-0">
                <p class="text-sm font-black text-slate-800 mb-0.5">${title}</p>
                <p class="text-xs text-slate-600 leading-relaxed">${body}</p>
            </div>
        </div>`;
    return `
        <div class="mb-6 bg-white rounded-xl p-5 border border-slate-200">
            <h3 class="text-base font-black text-slate-800 mb-1">추론 흐름</h3>
            <p class="text-xs text-slate-500 mb-4">사용자가 '무엇을'에 적은 텍스트 하나에서 시작해 세 세그먼트까지 이어집니다. 앞 단계의 결과가 뒤 단계의 입력이 됩니다.</p>
            ${step('1', '메뉴 (무엇을)', '사용자가 적은 원문. 예: "배민 치킨", "잡곡밥 + 김치찌개"')}
            ${step('2', '분류 (형태 · 요리 종류)', '원문을 토큰으로 쪼개 사전에서 <b>최장 일치</b>로 찾습니다. 형태는 ✨제안 칩으로 보여주고, 요리 종류는 묻지 않고 <code class="bg-slate-100 rounded px-1">cuisineAuto</code>로 자동 저장합니다.')}
            ${step('3', '세그먼트: 어떻게', '신뢰도 순으로 봅니다. ① 카카오 장소 픽(식당·술집·카페 → 외식) ② <b>원문의 조달 키워드</b>(배민·배달·구내식당·회식) ③ 장소 표기 \'구내식당\' ④ 장소=집 + 형태=밥류·국물요리 → 집밥 ⑤ <b>요리 종류</b>(개인 통계 → 시드) ⑥ 습관 예측. 앞 단계가 답을 내면 뒤는 보지 않습니다.')}
            ${step('4', '세그먼트: 어디서', '슬롯 습관 예측이 먼저입니다. 비어 있으면 <b>어떻게에서 이어받습니다</b>(집밥·배달/포장 → 우리집, 구내식당 → 구내식당). 외식·회식은 상호명이라 추론하지 않고 검색으로 넘깁니다. 어떻게가 바뀌면 이어받았던 값은 함께 무효화됩니다.')}
            ${step('5', '세그먼트: 누구와', '슬롯 습관 예측만 씁니다. 다만 <b>선택지 순서</b>는 어떻게에 따라 바뀝니다(회식이면 직장동료가 앞으로).')}
            <div class="mt-4 pt-3 border-t border-slate-200 text-xs text-slate-500 space-y-1">
                <p>· 모든 결과는 <b>점선 추천</b>일 뿐입니다. 시트의 '이대로 사용' 스위치는 <b>기본 꺼짐</b>이라, 켜지 않으면 저장되지 않습니다.</p>
                <p>· 자동 적용된 축은 <code class="bg-slate-100 rounded px-1">autoContext</code>에 기록되고, <b>다음 예측의 표본에서 제외</b>됩니다 — 추측이 추측을 강화하는 순환을 막습니다.</p>
            </div>
        </div>`;
}

function renderScopeSection() {
    const row = (name, scope, detail) => `
        <tr class="border-b border-slate-100 last:border-0">
            <td class="py-2 px-3 text-slate-800 font-bold whitespace-nowrap">${name}</td>
            <td class="py-2 px-3 whitespace-nowrap">
                <span class="px-2 py-0.5 rounded-md text-xs font-bold ${scope === '개인'
                    ? 'bg-violet-50 text-violet-700 border border-violet-200'
                    : scope === '개인 → 통상'
                        ? 'bg-sky-50 text-sky-700 border border-sky-200'
                        : 'bg-slate-100 text-slate-600 border border-slate-200'}">${scope}</span>
            </td>
            <td class="py-2 px-3 text-slate-600 text-xs">${detail}</td>
        </tr>`;
    return `
        <div class="mb-6 bg-white rounded-xl p-5 border border-slate-200">
            <h3 class="text-base font-black text-slate-800 mb-1">통상적 분류 vs 개인적 분류</h3>
            <p class="text-xs text-slate-500 mb-3"><b>통상</b>은 모든 사용자가 공유하는 사전·규칙이고, <b>개인</b>은 그 사용자의 기록 통계입니다. 둘 다 있는 항목은 <b>개인이 먼저</b>입니다 — 평균적으로 맞는 말보다 그 사람이 실제로 한 행동이 정확하기 때문입니다.</p>
            <div class="overflow-x-auto">
            <table class="w-full text-sm">
                <thead><tr class="bg-slate-50 text-xs text-slate-500">
                    <th class="py-2 px-3 text-left font-bold">항목</th>
                    <th class="py-2 px-3 text-left font-bold">적용</th>
                    <th class="py-2 px-3 text-left font-bold">설명</th>
                </tr></thead>
                <tbody>
                    ${row('형태 · 요리 종류', '통상', '아래 끼니 사전. 모든 사용자가 같은 사전을 씁니다.')}
                    ${row('조달 키워드', '통상', '배민·배달·구내식당·회식 등 고정밀 단어만. 오탐이 나는 말(포장·맥주)은 넣지 않습니다.')}
                    ${row('요리 종류 → 어떻게', '개인 → 통상', '“내가 중식을 먹을 때 뭐였나”(표본 3건+·점유 60%+)를 먼저 봅니다. 부족하면 시드(중식·일식·패스트푸드 → 외식)로 넘어갑니다.')}
                    ${row('어떻게 → 어디서', '개인 → 통상', '“내가 집밥일 때 어디였나”를 먼저 봅니다. 부족하면 시드(집밥·배달/포장 → 우리집).')}
                    ${row('습관 예측', '개인', '(슬롯 × 평일/주말) 최빈값. 표본 3건+·점유 60%+를 넘어야 발화합니다.')}
                    ${row('선택지 목록', '개인 → 통상', '어디서는 그 조달 방식으로 간 내 장소만 보여주고, 없으면 시드. 누구와는 거르지 않고 순서만 바꿉니다.')}
                </tbody>
            </table>
            </div>
        </div>`;
}

/* ─────────────────────────── 2. 끼니 사전 편집 ─────────────────────────── */

/** 현재 편집 상태를 반영한 전체 목록 */
function currentEntries() {
    const map = new Map(FOOD_ENTRIES);
    for (const w of draft.removed) map.delete(w);
    for (const [w, v] of Object.entries(draft.entries)) map.set(w, v);
    return [...map.entries()]
        .map(([word, v]) => ({ word, ...v }))
        .sort((a, b) => a.form.localeCompare(b.form) || a.word.localeCompare(b.word));
}

/** (형태 → 요리종류 → 음식[]) 로 묶기 — 편집 상태 반영 */
function cuisinesOf(form) {
    // 요리 종류를 묻지 않는 형태는 칸을 하나만 둔다 (빈 문자열 = 해당 없음)
    return formUsesCuisine(form) ? CUISINE_CATEGORIES : [''];
}

function groupedEntries() {
    const grouped = {};
    for (const form of FORM_CATEGORIES) {
        grouped[form] = {};
        for (const cuisine of cuisinesOf(form)) grouped[form][cuisine] = [];
    }
    for (const e of currentEntries()) {
        if (!grouped[e.form]) continue;
        const key = formUsesCuisine(e.form) ? (grouped[e.form][e.cuisine] ? e.cuisine : '기타') : '';
        grouped[e.form][key].push(e.word);
    }
    return grouped;
}

function renderChip(word) {
    const edited = Object.prototype.hasOwnProperty.call(draft.entries, word);
    const isBase = isBaseFoodEntry(word);
    const dim = filterText && !word.includes(filterText);
    const ring = !isBase
        ? 'border-emerald-400 bg-emerald-50 text-emerald-800'
        : edited
            ? 'border-amber-400 bg-amber-50 text-amber-800'
            : 'border-slate-200 bg-slate-50 text-slate-700';
    const selected = selectedWord === word ? ' ring-2 ring-emerald-500' : '';
    return `<span draggable="true" data-food-word="${escapeHtml(word)}"
        class="food-chip inline-flex items-center gap-1 px-2 py-1 border rounded-md text-xs font-semibold cursor-grab ${ring}${selected}"
        style="${dim ? 'opacity:.25;' : ''}" title="끌어서 옮기거나, 눌러서 선택 후 대상 그룹을 누르세요">
        ${escapeHtml(word)}
        ${edited || !isBase ? `<button type="button" data-food-reset="${escapeHtml(word)}" class="text-[10px] text-slate-400 hover:text-slate-700" title="기본값으로 되돌리기">↺</button>` : ''}
        <button type="button" data-food-remove="${escapeHtml(word)}" class="text-[10px] text-slate-400 hover:text-red-600" title="사전에서 삭제">✕</button>
    </span>`;
}

function renderEditorSection() {
    const grouped = groupedEntries();
    const total = currentEntries().length;
    const changed = Object.keys(draft.entries).length + draft.removed.length;
    const matched = filterText ? currentEntries().filter((e) => e.word.includes(filterText)).length : 0;

    const cards = FORM_CATEGORIES.map((form) => {
        const byCuisine = grouped[form];
        const count = Object.values(byCuisine).reduce((n, a) => n + a.length, 0);
        const groups = cuisinesOf(form).map((cuisine) => {
            const words = byCuisine[cuisine];
            const empty = words.length === 0;
            const label = cuisine || '요리 종류 없음';
            return `
                <div data-drop-form="${escapeHtml(form)}" data-drop-cuisine="${escapeHtml(cuisine)}"
                     class="food-drop rounded-lg border border-dashed border-slate-200 px-2 ${empty ? 'py-1' : 'py-1.5'} mb-1 transition-colors">
                    <button type="button" data-drop-target class="text-[11px] font-black ${empty ? 'text-slate-300' : cuisine ? 'text-emerald-700' : 'text-slate-400'} mr-1 align-top">${escapeHtml(label)}</button>
                    ${empty ? '' : `<span class="inline-flex flex-wrap gap-1 align-top">${words.map(renderChip).join('')}</span>`}
                </div>`;
        }).join('');
        return `
            <div class="border border-slate-200 rounded-xl p-3 bg-white">
                <div class="flex items-center justify-between mb-2">
                    <h4 class="text-sm font-black text-slate-800">${escapeHtml(form)}</h4>
                    <span class="text-xs text-slate-400 font-bold">${count}개</span>
                </div>
                ${groups}
            </div>`;
    }).join('');

    return `
        <div class="mb-6 bg-white rounded-xl p-5 border border-slate-200">
            <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
                <h3 class="text-base font-black text-slate-800">끼니 사전 편집</h3>
                <div class="flex items-center gap-2">
                    ${changed > 0 ? `<span class="text-xs font-bold text-amber-600">저장 안 된 변경 ${changed}건</span>` : ''}
                    <button onclick="window.saveFoodDict()" class="px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700">저장</button>
                </div>
            </div>
            <p class="text-xs text-slate-500 mb-1">음식을 <b>끌어서</b> 다른 형태·요리 종류 칸에 놓으면 분류가 바뀝니다. 터치 기기에서는 칩을 누른 뒤 옮길 칸의 <b>종류 이름</b>을 누르세요.</p>
            <p class="text-xs text-slate-400 mb-3">기본값은 코드에 있고 고친 값만 오버라이드로 저장됩니다. <span class="text-amber-600 font-bold">노랑=수정됨</span> · <span class="text-emerald-600 font-bold">초록=추가됨</span> · ↺ 되돌리기 · ✕ 삭제</p>
            <div class="flex flex-wrap items-center gap-2 mb-3">
                <input type="text" id="foodDictNewWord" placeholder="추가할 음식명" class="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-emerald-500">
                <select id="foodDictNewForm" class="px-2 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold outline-none">
                    ${FORM_CATEGORIES.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}
                </select>
                <select id="foodDictNewCuisine" class="px-2 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold outline-none disabled:bg-slate-100 disabled:text-slate-400">
                    <option value="">해당 없음</option>
                    ${CUISINE_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
                </select>
                <button onclick="window.addFoodDictEntry()" class="px-3 py-2 bg-slate-200 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-300">추가</button>
                <input type="text" id="foodDictFilter" value="${escapeHtml(filterText)}" placeholder="검색 (일치하지 않는 항목은 흐리게)" class="ml-auto px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-emerald-500" style="min-width:14rem">
            </div>
            <p class="text-xs text-slate-400 mb-2">전체 ${total}개${filterText ? ` · '${escapeHtml(filterText)}' 일치 ${matched}개` : ''}${selectedWord ? ` · <span class="text-emerald-600 font-bold">'${escapeHtml(selectedWord)}' 선택됨 — 옮길 칸의 종류 이름을 누르세요</span>` : ''}</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3">${cards}</div>
        </div>`;
}

/* ─────────────────────────── 3. 나머지 (읽기 전용) ─────────────────────────── */

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
            <h3 class="text-base font-black text-slate-800 mb-1">한 글자 예외 <span class="text-xs font-bold text-slate-400">(코드 전용)</span></h3>
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

/**
 * 간식 축 전용 뷰는 없앴다 — 간식도 위 사전 전체를 그대로 쓴다.
 * 끼니/간식은 슬롯이 가르고 '무엇을' 축은 하나다
 * (docs/food-category-auto-classification.md §6.2).
 */
function renderAxisNoteSection() {
    return `
        <div class="mb-6 bg-slate-50 rounded-xl p-4 border border-slate-200">
            <h3 class="text-sm font-black text-slate-800 mb-1">간식은 별도 사전이 없습니다</h3>
            <p class="text-xs text-slate-500">끼니·간식은 <b>기록 슬롯</b>으로 갈리고, '무엇을' 축은 위 사전 하나뿐입니다.
            간식에 방울토마토를 적으면 끼니와 똑같이 <b>채소·샐러드</b>로 분류됩니다.
            옛 간식 축 값(커피·베이커리…)으로 저장된 과거 기록은 원문을 그대로 두고 차트에서만 새 축으로 맞춥니다.</p>
        </div>`;
}

function renderTesterSection() {
    return `
        <div class="mb-6 bg-emerald-50/60 rounded-xl p-5 border border-emerald-200">
            <h3 class="text-base font-black text-slate-800 mb-1">분류 테스트</h3>
            <p class="text-xs text-slate-500 mb-3">실제 분류기와 같은 코드로 돌립니다. 위에서 편집한 내용이 <b>저장 후</b> 반영됩니다.</p>
            <input type="text" id="foodDictTestInput" placeholder="예: 짜장면 + 탕수육"
                   class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm outline-none focus:border-emerald-500">
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
    const chip = (v, color) => `<span class="inline-block px-2 py-1 ${color} rounded-md text-xs font-bold">${escapeHtml(v)}</span>`;
    const none = '<span class="text-xs text-slate-400">없음</span>';
    out.className = 'mt-3 text-sm text-slate-700 space-y-2';
    out.innerHTML = `
        <div><span class="text-xs font-bold text-slate-500 mr-2">토큰</span>${tokens.length ? tokens.map((t) => chip(t, 'bg-white border border-slate-200 text-slate-600')).join(' ') : none}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">형태</span>${detail.forms.length ? detail.forms.map((c) => chip(c, 'bg-emerald-100 text-emerald-700')).join(' ') : none}</div>
        <div><span class="text-xs font-bold text-slate-500 mr-2">요리 종류</span>${detail.cuisine ? chip(detail.cuisine, 'bg-sky-100 text-sky-700') : none}</div>`;
}

/* ─────────────────────────── 편집 액션 ─────────────────────────── */

function currentValueOf(word) {
    return draft.entries[word] || FOOD_ENTRIES.get(word) || null;
}

window.updateFoodDictEntry = function (word, field, value) {
    const cur = currentValueOf(word);
    if (!cur) return;
    draft.entries[word] = { form: cur.form, cuisine: cur.cuisine, [field]: value };
    draft.removed = draft.removed.filter((w) => w !== word);
    rerender();
};

/**
 * 음식을 다른 (형태 × 요리 종류) 칸으로 옮긴다 — 드래그앤드롭·선택이동 공통 경로.
 * 옮긴 값이 코드 기본값과 같아지면 오버라이드를 남기지 않는다(불필요한 저장 방지).
 * @param {string} word @param {string} form @param {string} cuisine
 */
function moveFoodEntry(word, form, cuisine) {
    const cur = currentValueOf(word);
    if (!cur || (cur.form === form && cur.cuisine === cuisine)) return;
    const base = getBaseFoodEntry(word);
    draft.removed = draft.removed.filter((w) => w !== word);
    if (base && base.form === form && base.cuisine === cuisine) delete draft.entries[word];
    else draft.entries[word] = { form, cuisine };
    selectedWord = null;
    rerender();
}

window.resetFoodDictEntry = function (word) {
    delete draft.entries[word];
    draft.removed = draft.removed.filter((w) => w !== word);
    rerender();
};

window.removeFoodDictEntry = function (word) {
    delete draft.entries[word];
    if (!draft.removed.includes(word)) draft.removed.push(word);
    rerender();
};

window.addFoodDictEntry = function () {
    const word = (document.getElementById('foodDictNewWord')?.value || '').trim();
    if (!word) {
        alert('음식명을 입력해주세요.');
        return;
    }
    const form = document.getElementById('foodDictNewForm')?.value || FORM_CATEGORIES[0];
    const picked = document.getElementById('foodDictNewCuisine')?.value ?? '';
    /**
     * 요리 종류는 **형태가 정한다.** 드롭다운 값을 그대로 믿지 않는 이유는 두 가지 —
     * 면제 형태(커피·과일…)에서는 어떤 값이 남아 있든 축이 해당되지 않고,
     * 반대로 요리 종류를 쓰는 형태에서 '해당 없음'을 고른 건 '기타'라는 뜻이다.
     * (저장 시 setFoodDictionaryOverrides 가 같은 규칙으로 한 번 더 강제한다)
     */
    draft.entries[word] = {
        form,
        cuisine: formUsesCuisine(form) ? (picked || '기타') : '',
    };
    draft.removed = draft.removed.filter((w) => w !== word);
    filterText = word;
    rerender();
};

window.saveFoodDict = async function () {
    try {
        const payload = { entries: draft.entries, removed: draft.removed, updatedAt: new Date().toISOString() };
        await setDoc(doc(db, 'artifacts', appId, 'content', 'foodDictionary'), payload, { merge: false });
        // 저장 즉시 이 화면의 분류 테스트에도 반영
        setFoodDictionaryOverrides(payload);
        rerender();
        alert('사전이 저장되었습니다. 사용자 앱에는 다음 실행부터 반영됩니다.');
    } catch (e) {
        console.error('음식 사전 저장 실패:', e);
        alert('저장 중 오류가 발생했습니다: ' + (e?.message || e));
    }
};

/* ─────────────────────────── 드래그앤드롭 · 선택 이동 ─────────────────────────── */

/**
 * 컨테이너에 **한 번만** 위임 바인딩한다. rerender 가 innerHTML 을 갈아끼워도
 * 컨테이너 자체는 유지되므로 칩 393개에 리스너를 각각 달 필요가 없다.
 */
let dndBound = false;
function bindEditorInteractionsOnce() {
    const container = document.getElementById('foodDictContainer');
    if (!container || dndBound) return;
    dndBound = true;

    const dropZoneOf = (el) => el?.closest?.('[data-drop-form]') || null;
    const clearHighlights = () => {
        container.querySelectorAll('.food-drop').forEach((z) => {
            z.classList.remove('border-emerald-500', 'bg-emerald-50');
        });
    };

    container.addEventListener('dragstart', (e) => {
        const chip = e.target.closest?.('[data-food-word]');
        if (!chip) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', chip.getAttribute('data-food-word'));
        chip.style.opacity = '0.4';
    });

    container.addEventListener('dragend', (e) => {
        const chip = e.target.closest?.('[data-food-word]');
        if (chip) chip.style.opacity = '';
        clearHighlights();
    });

    container.addEventListener('dragover', (e) => {
        const zone = dropZoneOf(e.target);
        if (!zone) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearHighlights();
        zone.classList.add('border-emerald-500', 'bg-emerald-50');
    });

    container.addEventListener('drop', (e) => {
        const zone = dropZoneOf(e.target);
        if (!zone) return;
        e.preventDefault();
        clearHighlights();
        const word = e.dataTransfer.getData('text/plain');
        if (word) moveFoodEntry(word, zone.getAttribute('data-drop-form'), zone.getAttribute('data-drop-cuisine'));
    });

    container.addEventListener('click', (e) => {
        const resetBtn = e.target.closest?.('[data-food-reset]');
        if (resetBtn) {
            window.resetFoodDictEntry(resetBtn.getAttribute('data-food-reset'));
            return;
        }
        const removeBtn = e.target.closest?.('[data-food-remove]');
        if (removeBtn) {
            window.removeFoodDictEntry(removeBtn.getAttribute('data-food-remove'));
            return;
        }
        // 터치 기기 대체 경로: 칩 선택 → 대상 칸의 종류 이름 클릭
        const chip = e.target.closest?.('[data-food-word]');
        if (chip) {
            const word = chip.getAttribute('data-food-word');
            selectedWord = selectedWord === word ? null : word;
            rerender();
            return;
        }
        const target = e.target.closest?.('[data-drop-target]');
        if (target && selectedWord) {
            const zone = dropZoneOf(target);
            if (zone) moveFoodEntry(selectedWord, zone.getAttribute('data-drop-form'), zone.getAttribute('data-drop-cuisine'));
        }
    });
}

/**
 * 추가 폼의 요리 종류 드롭다운을 형태에 맞춘다.
 *
 * 면제 형태를 고르면 '해당 없음'으로 고정하고 잠근다 — 예전에는 드롭다운이 '한식' 같은
 * 값을 물고 있는데 저장 시엔 빈 값으로 강제되어, 화면이 저장될 값과 다른 말을 하고 있었다.
 * (판정 자체는 addFoodDictEntry 가 형태에서 다시 하므로 이 함수는 표시만 책임진다)
 */
function syncNewEntryCuisineSelect() {
    const formSel = document.getElementById('foodDictNewForm');
    const cuisineSel = document.getElementById('foodDictNewCuisine');
    if (!formSel || !cuisineSel) return;
    const exempt = !formUsesCuisine(formSel.value);
    if (exempt) {
        cuisineSel.value = '';
    } else if (!cuisineSel.value) {
        cuisineSel.value = '기타';
    }
    cuisineSel.disabled = exempt;
    cuisineSel.title = exempt ? `'${formSel.value}'는 요리 종류를 묻지 않는 형태입니다` : '';
}

/* ─────────────────────────── 렌더 ─────────────────────────── */

function rerender() {
    const container = document.getElementById('foodDictContainer');
    if (!container) return;
    const testValue = document.getElementById('foodDictTestInput')?.value || '';
    container.innerHTML = [
        renderFlowSection(),
        renderScopeSection(),
        renderTesterSection(),
        renderEditorSection(),
        renderOneCharSection(),
        renderAxisNoteSection(),
    ].join('');
    const test = document.getElementById('foodDictTestInput');
    if (test) {
        test.value = testValue;
        test.addEventListener('input', runTester);
        if (testValue) runTester();
    }
    const newForm = document.getElementById('foodDictNewForm');
    if (newForm) newForm.addEventListener('change', syncNewEntryCuisineSelect);
    syncNewEntryCuisineSelect();

    const filter = document.getElementById('foodDictFilter');
    if (filter) {
        filter.addEventListener('input', () => {
            filterText = filter.value.trim();
            rerender();
            const next = document.getElementById('foodDictFilter');
            if (next) {
                next.focus();
                next.setSelectionRange(next.value.length, next.value.length);
            }
        });
    }
    bindEditorInteractionsOnce();
}

let loaded = false;

/** 분류사전 섹션 진입 — 저장된 오버라이드를 읽어 편집 상태로 올린다 */
export async function loadFoodDictContent() {
    if (!document.getElementById('foodDictContainer')) return;
    if (!loaded) {
        loaded = true;
        try {
            const snap = await getDoc(doc(db, 'artifacts', appId, 'content', 'foodDictionary'));
            if (snap.exists()) {
                const d = snap.data();
                draft = { entries: d.entries || {}, removed: Array.isArray(d.removed) ? d.removed : [] };
                setFoodDictionaryOverrides(draft);
            } else {
                draft = getFoodDictionaryOverrides();
            }
        } catch (e) {
            console.warn('음식 사전 오버라이드 로드 실패:', e?.message || e);
        }
    }
    rerender();
}
