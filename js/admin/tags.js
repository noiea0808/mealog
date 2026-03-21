// ADMIN 기본 태그(끼니·함께·카테고리 등) 편집
import { db, appId } from '../firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { escapeHtml } from './utils.js';

// 태그 콘텐츠 로드
export async function loadTagsContent() {
    try {
        // Firestore에서 태그 데이터 가져오기
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        const tagsSnap = await getDoc(tagsDoc);
        
        // 기본값 (constants.js의 DEFAULT_USER_SETTINGS에서 가져옴)
        let tagsData = {
            mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            category: ['한식', '양식', '일식', '중식', '분식', '카페'],
            snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };
        
        if (tagsSnap.exists()) {
            const data = tagsSnap.data();
            if (data.mealType) tagsData.mealType = data.mealType;
            if (data.withWhom) tagsData.withWhom = data.withWhom;
            if (data.category) tagsData.category = data.category;
            if (data.snackType) tagsData.snackType = data.snackType;
            if (data.subTagsPlaceSnack && Array.isArray(data.subTagsPlaceSnack)) tagsData.subTagsPlaceSnack = data.subTagsPlaceSnack;
        }
        
        // 태그 렌더링
        renderTags('mealType', tagsData.mealType);
        renderTags('withWhom', tagsData.withWhom);
        renderTags('category', tagsData.category);
        renderTags('snackType', tagsData.snackType);
        renderTags('subTagsPlaceSnack', tagsData.subTagsPlaceSnack);
        
    } catch (e) {
        console.error('태그 콘텐츠 로드 실패:', e);
        // 기본값으로 렌더링
        const defaultTags = {
            mealType: ['집밥', '외식', '회식/술자리', '배달/포장', '구내식당', '기타', '건너뜀'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            category: ['한식', '양식', '일식', '중식', '분식', '카페'],
            snackType: ['커피', '차/음료', '술/주류', '베이커리', '과자/스낵', '아이스크림', '과일/견과', '기타'],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };
        renderTags('mealType', defaultTags.mealType);
        renderTags('withWhom', defaultTags.withWhom);
        renderTags('category', defaultTags.category);
        renderTags('snackType', defaultTags.snackType);
        renderTags('subTagsPlaceSnack', defaultTags.subTagsPlaceSnack);
    }
}

// 태그 렌더링
function renderTags(type, tags) {
    const container = document.getElementById(`tags-${type}`);
    if (!container) return;
    
    // 컨테이너에 반응형 그리드 레이아웃 클래스 추가
    container.className = 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2';
    
    container.innerHTML = tags.map((tag, index) => `
        <div class="tag-item flex items-center gap-2 bg-white rounded-lg p-3 border border-slate-200 min-w-0 cursor-move hover:border-emerald-300 transition-colors" 
             draggable="true" 
             data-tag-index="${index}"
             data-tag-type="${type}">
            <div class="flex items-center justify-center w-6 h-6 text-slate-400 flex-shrink-0">
                <i class="fa-solid fa-grip-vertical text-xs"></i>
            </div>
            <input type="text" value="${escapeHtml(tag || '')}" 
                   onchange="window.updateTagItem('${type}', this)"
                   class="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 outline-none focus:border-emerald-500"
                   placeholder="태그 이름">
            <button onclick="window.removeTagItem('${type}', this.closest('.tag-item'))" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `).join('');
    
    // 드래그 앤 드롭 이벤트 설정
    setupTagDragAndDrop(type, container);
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
        const category = getCurrentTags('category');
        const snackType = getCurrentTags('snackType');
        const subTagsPlaceSnack = getCurrentTags('subTagsPlaceSnack');
        
        // 빈 태그가 있는지 확인
        if (mealType.length === 0 || withWhom.length === 0 || category.length === 0 || snackType.length === 0) {
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
        
        alert('태그가 저장되었습니다.');
        console.log('태그 저장 완료:', tagsData);
    } catch (e) {
        console.error('태그 저장 실패:', e);
        alert('태그 저장 중 오류가 발생했습니다: ' + e.message);
    }
};
