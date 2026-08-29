// ADMIN 기본 태그(끼니·함께·카테고리 등) 편집
//
// 목록의 출처는 `admin-tag-axes.js` 하나다 — 예전엔 이 파일 안에 기본값 리터럴이
// 정상 경로와 에러 폴백에 각각 박혀 있었다. 「모먼트 분석」이 같은 목록을 읽으므로
// 갈라지면 편집하는 목록과 세는 목록이 달라진다.
import { db, appId } from '../firebase.js';
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml } from './utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { ADMIN_TAG_AXES, loadAdminTagLists } from './admin-tag-axes.js';

// 태그 콘텐츠 로드
export async function loadTagsContent() {
    // loadAdminTagLists 는 실패해도 기본값을 돌려준다 — 화면이 비는 경우가 없다
    const { tags } = await loadAdminTagLists();
    ADMIN_TAG_AXES.forEach((axis) => renderTags(axis.key, tags[axis.key] || []));
}

// 태그 렌더링
function renderTags(type, tags) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return;
    
    // 컨테이너에 반응형 그리드 레이아웃 클래스 추가
    // 축마다 한 줄에 하나씩 — 순서를 눈으로 따라가고 드래그로 옮기기 좋게 폭을 묶는다
    container.className = 'flex flex-col gap-1.5';
    
    container.innerHTML = tags.map((tag, index) => `
        <div class="tag-item flex items-center gap-1 bg-white rounded-lg pl-1.5 pr-1 py-1 border border-slate-200 min-w-0 cursor-move hover:border-emerald-300 transition-colors"
             draggable="true"
             data-tag-index="${index}"
             data-tag-type="${type}"
             title="드래그해서 순서 변경">
            <span class="w-3.5 text-center text-[11px] font-bold text-slate-400 tabular-nums flex-shrink-0 select-none">${index + 1}</span>
            <input type="text" value="${escapeHtml(tag || '')}"
                   onchange="window.updateTagItem('${type}', this)"
                   class="flex-1 min-w-0 px-1.5 py-1 bg-slate-50 border border-slate-200 rounded text-sm font-bold text-slate-800 outline-none focus:border-emerald-500"
                   placeholder="태그 이름">
            <button onclick="window.removeTagItem('${type}', this.closest('.tag-item'))" class="w-6 h-6 flex items-center justify-center text-slate-400 rounded hover:bg-red-50 hover:text-red-600 transition-colors flex-shrink-0" title="삭제">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
        </div>
    `).join('');
    
    // 드래그 앤 드롭 이벤트 설정
    setupTagDragAndDrop(type, container);
    scheduleLucideIcons(container);
}

// 태그 드래그 앤 드롭 설정
function setupTagDragAndDrop(type, container) {
    let draggedElement = null;
    let draggedIndex = null;
    let dropIndex = null;
    
    container.querySelectorAll('.tag-item').forEach((item, index) => {
        // 드래그 시작
        item.addEventListener('dragstart', (e) => {
            draggedElement = item;
            draggedIndex = index;
            item.classList.add('opacity-50');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        // 드래그 종료
        item.addEventListener('dragend', (e) => {
            item.classList.remove('opacity-50');
            
            // 순서 변경 적용
            if (draggedIndex !== null && dropIndex !== null && draggedIndex !== dropIndex) {
                const tags = getCurrentTags(type);
                const [removed] = tags.splice(draggedIndex, 1);
                tags.splice(dropIndex, 0, removed);
                renderTags(type, tags);
            }
            
            // 초기화
            draggedElement = null;
            draggedIndex = null;
            dropIndex = null;
            
            // 모든 항목의 드래그 오버 스타일 제거
            container.querySelectorAll('.tag-item').forEach(el => {
                el.classList.remove('border-emerald-500', 'bg-emerald-50');
            });
        });
        
        // 드래그 오버 (호버 효과)
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const allItems = Array.from(container.querySelectorAll('.tag-item'));
            const currentIndex = allItems.indexOf(item);
            
            if (draggedIndex !== null && currentIndex !== draggedIndex) {
                dropIndex = currentIndex;
                
                // 드래그 오버 스타일 적용
                allItems.forEach(el => {
                    el.classList.remove('border-emerald-500', 'bg-emerald-50');
                });
                item.classList.add('border-emerald-500', 'bg-emerald-50');
            }
        });
        
        // 드래그 리브 (호버 효과 제거)
        item.addEventListener('dragleave', (e) => {
            if (!item.contains(e.relatedTarget)) {
                item.classList.remove('border-emerald-500', 'bg-emerald-50');
            }
        });
        
        // 드롭
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
}

// 태그 항목 추가
window.addTagItem = function(type) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return;
    
    const tags = getCurrentTags(type);
    tags.push('');
    
    renderTags(type, tags);
};

// 태그 항목 제거
window.removeTagItem = function(type, itemElement) {
    const tags = getCurrentTags(type);
    if (tags.length <= 1) {
        alert('최소 한 개의 태그가 필요합니다.');
        return;
    }
    
    const container = document.getElementById(`tags-${type}`);
    const allItems = Array.from(container.querySelectorAll('.tag-item'));
    const index = allItems.indexOf(itemElement);
    
    if (index > -1) {
        tags.splice(index, 1);
        renderTags(type, tags);
    }
};


// 태그 항목 업데이트
window.updateTagItem = function(type, inputElement) {
    // DOM 순서에 따라 태그가 자동으로 업데이트되므로 별도 처리 불필요
    // 실제 저장 시 getCurrentTags로 최신 순서를 가져옴
};

// 현재 태그 목록 가져오기 (DOM 순서대로)
function getCurrentTags(type) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return [];
    
    const tags = [];
    container.querySelectorAll('.tag-item').forEach(itemEl => {
        const input = itemEl.querySelector('input[type="text"]');
        if (input) {
            const value = input.value.trim();
            if (value.length > 0) {
                tags.push(value);
            }
        }
    });
    
    return tags;
}

// 태그 저장
window.saveTags = async function() {
    try {
        const mealType = getCurrentTags('mealType');
        const withWhom = getCurrentTags('withWhom');
        /**
         * '무엇을'은 편집란 하나로 관리하고 두 필드에 같은 값을 쓴다.
         * 필드를 하나로 합치는 것은 과거 기록 마이그레이션이 따르는 별도 문제이고,
         * 축을 통일하는 데 필요하지도 않다 (docs/food-category-auto-classification.md §6.2).
         */
        const category = getCurrentTags('category');
        const snackType = category;
        const subTagsPlaceSnack = getCurrentTags('subTagsPlaceSnack');

        // 빈 태그가 있는지 확인
        if (mealType.length === 0 || withWhom.length === 0 || category.length === 0) {
            alert('각 카테고리마다 최소 한 개의 태그가 필요합니다.');
            return;
        }
        if (subTagsPlaceSnack.length === 0) {
            alert('간식 장소는 최소 한 개의 태그가 필요합니다.');
            return;
        }
        
        const tagsData = {
            mealType: mealType,
            withWhom: withWhom,
            category: category,
            snackType: snackType,
            subTagsPlaceSnack: subTagsPlaceSnack,
            updatedAt: new Date().toISOString()
        };
        
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        await setDoc(tagsDoc, tagsData, { merge: true });

        alert('태그가 저장되었습니다.\n\n앱은 관리자 태그를 세션당 1회만 읽습니다 — 완전히 새로 로드해야 반영됩니다.');
        console.log('태그 저장 완료:', tagsData);
    } catch (e) {
        console.error('태그 저장 실패:', e);
        alert('태그 저장 중 오류가 발생했습니다: ' + e.message);
    }
};
