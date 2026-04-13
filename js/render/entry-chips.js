/**
 * 기록 화면 태그 칩(끼니·카테고리·함께·간식 등) 렌더링.
 * window.renderSecondary 는 여기서 등록합니다.
 */
/** 기록 모달 서브태그 중 '최근 사용'으로 보여 줄 최대 개수 (식사·간식 공통) */
const RECENT_SUBTAG_CHIP_LIMIT = 5;

/**
 * onclick="..." 안에 삽입할 때 JSON.stringify는 큰따옴표로 속성이 끊겨 SyntaxError 남.
 * 단일따옴표 리터럴 + decodeURIComponent로 안전히 전달.
 */
function valueExprForOnclick(str) {
    return `decodeURIComponent('${encodeURIComponent(str ?? '')}')`;
}

export function renderEntryChips() {
    const tags = window.userSettings?.tags;
    const subTags = window.userSettings?.subTags;
    
    // 설정이 없으면 기본값 사용
    if (!tags) {
        console.warn('userSettings.tags가 없습니다. 기본값을 사용합니다.');
        return;
    }
    
    // "???" 항목 제거 (기존 사용자 설정 정리)
    if (tags.mealType) {
        const index = tags.mealType.indexOf('???');
        if (index > -1) {
            tags.mealType.splice(index, 1);
        }
    }
    
    const renderPrimary = (id, list, inputId, subTagKey, subContainerId) => {
        const el = document.getElementById(id);
        if (!el || !list || list.length === 0) {
            if (el) el.innerHTML = '';
            return;
        }
        el.innerHTML = list.map(t =>
            `<button onclick="window.selectTag('${inputId}', ${valueExprForOnclick(t)}, this, true, '${subTagKey}', '${subContainerId}')" class="chip">${t}</button>`
        ).join('');
    };
    
    window.renderSecondary = (id, list, inputId, parentFilter = null, subTagKey = null) => {
        const el = document.getElementById(id);
        if (!el) return;
        let filteredList = list || [];
        // 메인 태그가 선택된 경우, 해당 메인 태그 아래에서만 사용한 서브 태그만 표시 (parent가 없는 항목은 제외)
        if (parentFilter) {
            filteredList = filteredList.filter(item => {
                const parent = typeof item === 'string' ? null : item.parent;
                return parent === parentFilter;
            });
        }
        
        // 메인 태그가 선택되지 않았을 때는 나만의 태그를 표시하지 않음
        const currentInputVal = document.getElementById(inputId)?.value || '';
        // 함께한 사람·메뉴 상세 태그는 다중 선택 가능(쉼표 구분)이므로 배열로 처리
        const isMultiSelect = id === 'peopleSuggestions' || id === 'menuSuggestions' || id === 'snackPeopleSuggestions';
        const currentValues = isMultiSelect ? currentInputVal.split(',').map(v => v.trim()).filter(v => v) : [currentInputVal];
        
        if (!parentFilter) {
            // 메인 태그가 선택되지 않았을 때는 아무것도 표시하지 않음
            el.innerHTML = '';
            return;
        }
        
        // 메인 태그가 선택되었을 때만 나만의 태그 표시 (간식 어디서는 snackPlace 사용)
        const mainTagKeyMap = {
            'place': 'mealType',
            'menu': 'category',
            'people': 'withWhom',
            'snack': 'snackType'
        };
        const mainTagKey = (subTagKey === 'place' && id === 'snackPlaceSuggestions') ? 'snackPlace' : mainTagKeyMap[subTagKey];
        const favoriteSubTags = window.userSettings?.favoriteSubTags?.[mainTagKey] || {};
        const myTags = favoriteSubTags[parentFilter] || [];
        
        // 나만의 태그와 최근 태그 분리
        const myTagsSet = new Set(myTags);
        const myTagsList = [];
        const recentTagsList = [];
        
        filteredList.forEach(item => {
            const text = typeof item === 'string' ? item : item.text;
            if (myTagsSet.has(text)) {
                myTagsList.push(item);
            } else {
                recentTagsList.push(item);
            }
        });
        // 나만의 태그 중 subTags(최근 사용)에 아직 없는 것도 칩으로 표시
        myTags.forEach(text => {
            const alreadyIn = filteredList.some(item => (typeof item === 'string' ? item : item.text) === text);
            if (!alreadyIn) {
                myTagsList.push({ text });
            }
        });
        
        // 나만의 태그를 인덱스 순서대로 정렬
        myTagsList.sort((a, b) => {
            const textA = typeof a === 'string' ? a : a.text;
            const textB = typeof b === 'string' ? b : b.text;
            const indexA = myTags.indexOf(textA);
            const indexB = myTags.indexOf(textB);
            return indexA - indexB;
        });
        
        // 최근 태그: 최신이 왼쪽, 식사·간식(어디서/무엇을/누구와) 공통으로 최대 RECENT_SUBTAG_CHIP_LIMIT개만 표시
        recentTagsList.reverse();
        const recentLimited = recentTagsList.slice(0, RECENT_SUBTAG_CHIP_LIMIT);

        // 나만의 태그 + 최근 태그 순서로 합치기
        const sortedList = [...myTagsList, ...recentLimited];
        
        if (sortedList.length === 0 && myTags.length === 0) {
            el.innerHTML = `<span class="text-[10px] text-slate-300 py-1 px-2">추천 태그 없음</span>`;
        } else {
            let html = '';
            
            // 나만의 태그와 최근 태그 모두 표시 (식사·간식 어디서/무엇을/누구와 동일: 최근만 ×)
            html += sortedList.map(t => {
                const text = typeof t === 'string' ? t : t.text;
                const isActive = isMultiSelect ? (currentValues.includes(text) ? 'active' : '') : (currentInputVal === text ? 'active' : '');
                const isMyTag = myTagsSet.has(text);
                const starHtml = isMyTag ? ' <i class="fa-solid fa-star text-[9px] text-emerald-600"></i>' : '';
                const selectOnclick = `window.selectTag('${inputId}', ${valueExprForOnclick(text)}, this, false, '${subTagKey}', '${id}')`;
                // 설정(즐겨찾기) 태그는 등록 화면에서 삭제 불가 — 최근 사용 태그만 ×로 subTags에서 제거
                if (isMyTag) {
                    return `<span class="sub-chip-wrapper inline-flex shrink-0 rounded-md overflow-hidden border border-emerald-400">
                        <button type="button" onclick="${selectOnclick}" class="sub-chip whitespace-nowrap ${isActive} bg-emerald-100 text-emerald-700 font-bold text-xs border-0 rounded-none shadow-none">${text}${starHtml}</button>
                    </span>`;
                }
                const chipDeletePayload = encodeURIComponent(JSON.stringify({
                    kind: 'recent',
                    subTagKey,
                    text,
                    containerId: id,
                    inputId,
                    parentFilter
                }));
                const wrapperFlex = 'inline-flex shrink-0 items-stretch rounded-md overflow-hidden border border-slate-400';
                const mainBtnClass = `sub-chip whitespace-nowrap justify-start ${isActive} bg-white text-slate-600 font-bold text-xs border-0 rounded-none shadow-none pl-2 pr-1.5`;
                const delBtnClass =
                    'sub-chip-delete-btn flex items-center justify-center px-1.5 min-w-[26px] shrink-0 border-l border-slate-200 bg-slate-50 text-slate-600 hover:bg-red-50 hover:text-red-500 transition-colors';
                return `<span class="sub-chip-wrapper ${wrapperFlex}">
                    <button type="button" onclick="${selectOnclick}" class="${mainBtnClass}">${text}</button>
                    <button type="button" data-chip-delete="${chipDeletePayload}" class="${delBtnClass}" aria-label="태그 삭제"><i class="fa-solid fa-xmark text-[10px]"></i></button>
                </span>`;
            }).join('');
            
            el.innerHTML = html;
        }
    };
    
    renderPrimary('typeChips', tags.mealType, 'null', 'place', 'restaurantSuggestions');
    window.renderSecondary('restaurantSuggestions', subTags?.place || [], 'placeInput', null, 'place');
    renderPrimary('categoryChips', tags.category, 'null', 'menu', 'menuSuggestions');
    window.renderSecondary('menuSuggestions', subTags?.menu || [], 'menuDetailInput', null, 'menu');
    renderPrimary('withChips', tags.withWhom, 'null', 'people', 'peopleSuggestions');
    window.renderSecondary('peopleSuggestions', subTags?.people || [], 'withWhomInput', null, 'people');
    // 간식 누구와
    renderPrimary('snackWithChips', tags.withWhom, 'null', 'people', 'snackPeopleSuggestions');
    window.renderSecondary('snackPeopleSuggestions', subTags?.people || [], 'snackWithWhomInput', null, 'people');
    
    // 간식 어디서: 관리자 메인태그 순서대로 칩 표시 (선택 시 개별 태그는 selectTag에서 renderSecondary 호출)
    const snackPlaceMain = tags.snackPlaceMain || ['집', '사무실', '카페'];
    renderPrimary('snackPlaceTypeChips', snackPlaceMain, 'null', 'place', 'snackPlaceSuggestions');
    window.renderSecondary('snackPlaceSuggestions', subTags?.place || [], 'snackPlaceInput', null, 'place');
    // 간식 무엇을
    const snackTypes = tags.snackType || ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
    renderPrimary('snackTypeChips', snackTypes, 'null', 'snack', 'snackSuggestions');
    window.renderSecondary('snackSuggestions', subTags?.snack || [], 'snackDetailInput', null, 'snack');
}
