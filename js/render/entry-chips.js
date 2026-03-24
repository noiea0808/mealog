/**
 * 기록 화면 태그 칩(끼니·카테고리·함께·간식 등) 렌더링.
 * window.renderSecondary 는 여기서 등록합니다.
 */
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
            `<button onclick="window.selectTag('${inputId}', '${t}', this, true, '${subTagKey}', '${subContainerId}')" class="chip">${t}</button>`
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
        const isMultiSelect = id === 'peopleSuggestions' || id === 'menuSuggestions';
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
        
        // 최근 태그는 역순으로 정렬 (최근 사용한 태그가 왼쪽에). 간식 어디서는 관리자 배열 순서 유지
        if (id !== 'snackPlaceSuggestions') recentTagsList.reverse();
        
        // 나만의 태그 + 최근 태그 순서로 합치기
        const sortedList = [...myTagsList, ...recentTagsList];
        
        if (sortedList.length === 0 && myTags.length === 0) {
            el.innerHTML = `<span class="text-[10px] text-slate-300 py-1 px-2">추천 태그 없음</span>`;
        } else {
            let html = '';
            
            // 나만의 태그와 최근 태그 모두 표시
            // 간식 어디서: 관리자 강제 태그만 표시, 기록 화면에서는 삭제 불가
            const isSnackPlace = id === 'snackPlaceSuggestions';
            html += sortedList.map(t => {
                const text = typeof t === 'string' ? t : t.text;
                const isActive = isMultiSelect ? (currentValues.includes(text) ? 'active' : '') : (currentInputVal === text ? 'active' : '');
                const isMyTag = myTagsSet.has(text);
                // 나만의 태그는 삭제 불가, 간식 어디서는 관리자 강제만이라 모두 삭제 불가
                const canDelete = !isSnackPlace && !isMyTag;
                // 최근 태그도 나만의 태그와 동일한 크기로
                const tagClass = isMyTag 
                    ? 'bg-emerald-100 border border-emerald-400 text-emerald-700 font-bold text-xs' 
                    : 'border border-slate-400 text-slate-600 font-bold text-xs';
                return `<span class="sub-chip-wrapper relative inline-block mr-1 mb-1 group">
                    <button onclick="window.selectTag('${inputId}', '${text}', this, false, '${subTagKey}', '${id}')" class="sub-chip ${isActive} ${tagClass} ${canDelete ? 'pr-7' : ''}">${text}${isMyTag ? ' <i class="fa-solid fa-star text-[9px] text-emerald-600"></i>' : ''}</button>
                    ${canDelete ? `<button onclick="event.stopPropagation(); window.deleteSubTag('${subTagKey}', '${text}', '${id}', '${inputId}', '${parentFilter}')" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] text-slate-600 hover:text-red-500 w-4 h-4 flex items-center justify-center rounded-full active:bg-slate-200 transition-colors">
                        <i class="fa-solid fa-xmark"></i>
                    </button>` : ''}
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
    
    // 간식 어디서: 관리자 메인태그 순서대로 칩 표시 (선택 시 개별 태그는 selectTag에서 renderSecondary 호출)
    const snackPlaceMain = tags.snackPlaceMain || ['집', '사무실', '카페'];
    renderPrimary('snackPlaceTypeChips', snackPlaceMain, 'null', 'place', 'snackPlaceSuggestions');
    window.renderSecondary('snackPlaceSuggestions', subTags?.place || [], 'snackPlaceInput', null, 'place');
    // 간식 무엇을
    const snackTypes = tags.snackType || ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'];
    renderPrimary('snackTypeChips', snackTypes, 'null', 'snack', 'snackSuggestions');
    window.renderSecondary('snackSuggestions', subTags?.snack || [], 'snackDetailInput', null, 'snack');
}
