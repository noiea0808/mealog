// ADMIN 기본 태그(끼니·함께·카테고리 등) 편집
import { db, appId, auth } from '../firebase.js';
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { escapeHtml } from './utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { FORM_CATEGORIES } from '../utils/food-dictionary.js';

// 태그 콘텐츠 로드
export async function loadTagsContent() {
    try {
        // Firestore에서 태그 데이터 가져오기
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        const tagsSnap = await getDoc(tagsDoc);
        
        // 기본값 (constants.js의 DEFAULT_USER_SETTINGS에서 가져옴)
        let tagsData = {
            mealType: ['집밥', '배달/포장', '구내식당', '편의점', '외식', '회식/술자리', '건너뜀', '기타'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            // '무엇을'은 끼니·간식 공통 형태 축 (constants.js DEFAULT_USER_SETTINGS와 동일 소스)
            category: [...FORM_CATEGORIES],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };

        if (tagsSnap.exists()) {
            const data = tagsSnap.data();
            if (data.mealType) tagsData.mealType = data.mealType;
            if (data.withWhom) tagsData.withWhom = data.withWhom;
            if (data.category) tagsData.category = data.category;
            if (data.subTagsPlaceSnack && Array.isArray(data.subTagsPlaceSnack)) tagsData.subTagsPlaceSnack = data.subTagsPlaceSnack;
            savedFormAxisPilotUids = normalizePilotUids(data.formAxisPilotUids);
        } else {
            savedFormAxisPilotUids = [];
        }
        renderFormAxisPilotUids(savedFormAxisPilotUids);
        renderFormAxisPilotStatus();

        // 태그 렌더링
        renderTags('mealType', tagsData.mealType);
        renderTags('withWhom', tagsData.withWhom);
        // '무엇을'은 편집란 하나 — snackType 은 저장 시 category 와 같은 값으로 기록된다
        renderTags('category', tagsData.category);
        renderTags('subTagsPlaceSnack', tagsData.subTagsPlaceSnack);

    } catch (e) {
        console.error('태그 콘텐츠 로드 실패:', e);
        // 기본값으로 렌더링
        const defaultTags = {
            mealType: ['집밥', '배달/포장', '구내식당', '편의점', '외식', '회식/술자리', '건너뜀', '기타'],
            withWhom: ['혼자', '가족', '연인', '친구', '직장동료', '학교친구', '모임', '기타'],
            // '무엇을'은 끼니·간식 공통 형태 축 (constants.js DEFAULT_USER_SETTINGS와 동일 소스)
            category: [...FORM_CATEGORIES],
            subTagsPlaceSnack: ['집', '사무실', '카페']
        };
        renderTags('mealType', defaultTags.mealType);
        renderTags('withWhom', defaultTags.withWhom);
        renderTags('category', defaultTags.category);
        renderTags('subTagsPlaceSnack', defaultTags.subTagsPlaceSnack);
        // 읽기에 실패했으면 저장 상태를 아는 척하면 안 된다 — 빈 목록으로 그리고 사실을 남긴다
        savedFormAxisPilotUids = [];
        renderFormAxisPilotStatus();
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
                <i data-lucide="grip-vertical" class="text-xs"></i>
            </div>
            <input type="text" value="${escapeHtml(tag || '')}" 
                   onchange="window.updateTagItem('${type}', this)"
                   class="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-bold text-slate-800 outline-none focus:border-emerald-500"
                   placeholder="태그 이름">
            <button onclick="window.removeTagItem('${type}', this.closest('.tag-item'))" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                <i data-lucide="trash-2"></i>
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

/**
 * '무엇을' 목록을 코드의 형태 축으로 되돌린다 (편집란만 갱신 — 저장 버튼을 눌러야 반영).
 *
 * 저장된 값이 아직 옛 축(한식·양식… / 커피·베이커리…)인 환경에서 쓰는 버튼이다.
 * 자동으로 치환하지 않는 이유는, 관리자 문서를 고치는 순간 전 사용자 칩이 바뀌기 때문 —
 * 반영 시점은 관리자가 명시적으로 고르게 둔다.
 */
window.loadFormAxisTags = function() {
    renderTags('category', [...FORM_CATEGORIES]);
};

/*
 * ─── 형태 축 파일럿 (임시) ───────────────────────────────────────────────
 * 운영 전환일에 이 블록과 admin.html 의 편집란, js/utils/form-axis-pilot.js 를 함께 지운다.
 * 절차: docs/food-axis-rollout.md
 */

/**
 * 문서에 **실제로 저장돼 있는** 파일럿 목록.
 * 편집란의 텍스트와 구분해서 들고 있어야 "입력은 했는데 저장이 안 됐다"를 구분할 수 있다.
 * @type {string[]}
 */
let savedFormAxisPilotUids = [];

/** @param {unknown} uids */
function normalizePilotUids(uids) {
    return Array.isArray(uids)
        ? [...new Set(uids.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))]
        : [];
}

/** @param {unknown} uids */
function renderFormAxisPilotUids(uids) {
    const input = document.getElementById('formAxisPilotUids');
    if (!input) return;
    input.value = normalizePilotUids(uids).join(', ');
}

/**
 * 저장 상태를 눈으로 확인할 수 있게 그린다.
 *
 * 편집란만으로는 "내가 방금 넣은 값"과 "문서에 저장된 값"이 구별되지 않아,
 * 등록했는데 축이 안 바뀔 때 무엇이 잘못됐는지 알 방법이 없었다.
 * 특히 **관리자 계정과 앱 계정이 다르면** uid가 어긋나는데 그게 화면에 드러나지 않았다.
 */
function renderFormAxisPilotStatus() {
    const el = document.getElementById('formAxisPilotStatus');
    if (!el) return;
    const myUid = auth.currentUser?.uid || '';
    const saved = savedFormAxisPilotUids;
    const registered = Boolean(myUid) && saved.includes(myUid);

    const chips = saved.length
        ? saved
            .map((u) => {
                const isMine = u === myUid;
                return `<code class="px-1.5 py-0.5 rounded text-[11px] font-mono ${
                    isMine ? 'bg-emerald-100 text-emerald-800 font-bold' : 'bg-slate-200 text-slate-700'
                }">${escapeHtml(u)}${isMine ? ' (나)' : ''}</code>`;
            })
            .join(' ')
        : '<span class="text-slate-500">없음 — 전원 옛 축입니다</span>';

    const myLine = myUid
        ? `<code class="px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[11px] font-mono">${escapeHtml(myUid)}</code>
           ${registered
            ? '<span class="text-emerald-700 font-bold">✅ 등록됨</span>'
            : '<span class="text-rose-700 font-bold">❌ 저장된 목록에 없음</span>'}`
        : '<span class="text-rose-700 font-bold">로그인 정보를 확인할 수 없습니다</span>';

    el.innerHTML = `
        <div class="mt-3 p-3 bg-white border border-slate-200 rounded-lg text-xs space-y-2">
            <div><b class="text-slate-700">저장된 목록 (${saved.length})</b><br>${chips}</div>
            <div><b class="text-slate-700">지금 이 관리자 화면의 uid</b><br>${myLine}</div>
            <p class="text-slate-500 leading-relaxed">
                앱에서도 같은 계정으로 로그인해야 새 축이 보입니다.
                앱 콘솔에서 <code class="font-mono">window.currentUser.uid</code> 로 대조해 보세요.
            </p>
        </div>`;
}

/** @returns {string[]} 편집란의 uid 목록 (중복·공백 제거) */
function getFormAxisPilotUids() {
    const input = document.getElementById('formAxisPilotUids');
    if (!input) return [];
    return [...new Set(input.value.split(',').map((u) => u.trim()).filter(Boolean))];
}

/**
 * 관리자 본인 uid를 **입력칸에** 넣는다. 저장은 [파일럿 저장]이 한다.
 * 하는 일이 입력칸 채우기뿐이라 조용히 끝나면 "버튼이 안 먹는다"로 읽힌다 —
 * 그래서 결과와 **다음에 눌러야 할 것**을 alert 로 알린다.
 */
window.addMyUidToFormAxisPilot = function() {
    // 이 화면에는 토스트가 없다(window.showToast 는 어디에도 정의돼 있지 않다) — alert 로 확실히 알린다
    const uid = auth.currentUser?.uid;
    if (!uid) {
        alert('로그인 정보를 확인할 수 없습니다.');
        return;
    }
    const uids = getFormAxisPilotUids();
    const already = uids.includes(uid);
    if (!already) uids.push(uid);
    renderFormAxisPilotUids(uids);
    alert(
        `${already ? '이미 입력칸에 있습니다' : 'uid를 입력칸에 넣었습니다'}:\n${uid}\n\n` +
        '아직 저장되지 않았습니다 — 옆의 [파일럿 저장] 을 누르세요.'
    );
};

/**
 * 파일럿 목록만 문서에 쓴다.
 *
 * 위쪽 큰 [저장] 버튼과 분리한 이유가 둘 있다:
 * ① 두 단계(입력칸 채우기 → 멀리 있는 저장)라 한 단계만 어긋나도 **빈 값이 저장**된다.
 * ② 큰 저장 버튼은 '무엇을' 목록(category·snackType)도 함께 쓴다. 파일럿 등록하려다
 *    '형태 축 불러오기'가 눌려 있으면 **전 사용자 전환**이 나가 버린다 — 되돌릴 수는 있지만
 *    한 계정 테스트하려다 낼 사고가 아니다.
 */
window.saveFormAxisPilotUids = async function() {
    const uids = getFormAxisPilotUids();
    try {
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        // 파일럿 필드 하나만 merge — 태그 목록은 건드리지 않는다
        await setDoc(tagsDoc, { formAxisPilotUids: uids, updatedAt: new Date().toISOString() }, { merge: true });
        // 되읽기가 곧 확인이다
        const verifySnap = await getDoc(tagsDoc);
        savedFormAxisPilotUids = normalizePilotUids(verifySnap.data()?.formAxisPilotUids);
        renderFormAxisPilotUids(savedFormAxisPilotUids);
        renderFormAxisPilotStatus();
        const myUid = auth.currentUser?.uid || '';
        const mine = Boolean(myUid) && savedFormAxisPilotUids.includes(myUid);
        alert(
            `파일럿 목록을 저장했습니다 (${savedFormAxisPilotUids.length}개).\n` +
            (savedFormAxisPilotUids.length ? `${savedFormAxisPilotUids.join('\n')}\n\n` : '\n') +
            (mine
                ? '내 uid 포함 ✅ — 앱을 완전히 새로 로드하면 형태 축 14개가 보입니다.'
                : '내 uid 없음 ❌ — 앱 계정과 같은 uid인지 확인하세요.')
        );
    } catch (e) {
        console.error('형태 축 파일럿 저장 실패:', e);
        alert('파일럿 저장 중 오류가 발생했습니다: ' + (e?.message || e));
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
            // 임시 — 형태 축 파일럿 계정 (전환일에 빈 배열로 저장하고 코드에서 제거)
            formAxisPilotUids: getFormAxisPilotUids(),
            updatedAt: new Date().toISOString()
        };
        
        const tagsDoc = doc(db, 'artifacts', appId, 'content', 'defaultTags');
        await setDoc(tagsDoc, tagsData, { merge: true });

        /**
         * 저장 직후 문서를 **다시 읽어** 화면에 반영한다.
         * "저장했다"는 알림만으로는 파일럿 목록이 실제로 들어갔는지 알 수 없었다 —
         * 되읽기가 그 확인이다.
         */
        let pilotLine = '';
        try {
            const verifySnap = await getDoc(tagsDoc);
            savedFormAxisPilotUids = normalizePilotUids(verifySnap.data()?.formAxisPilotUids);
            renderFormAxisPilotUids(savedFormAxisPilotUids);
            renderFormAxisPilotStatus();
            const myUid = auth.currentUser?.uid || '';
            pilotLine = savedFormAxisPilotUids.length === 0
                ? '\n\n형태 축 파일럿: 등록된 계정 없음 (전원 옛 축)'
                : `\n\n형태 축 파일럿 ${savedFormAxisPilotUids.length}개 저장됨` +
                  (myUid && savedFormAxisPilotUids.includes(myUid)
                      ? '\n내 uid 포함 ✅ — 앱을 완전히 새로 로드하세요.'
                      : '\n내 uid 없음 ❌ — 앱 계정과 같은 uid인지 확인하세요.');
        } catch (_) {
            /* 되읽기 실패는 저장 자체와 무관하다 — 알림만 단순해진다 */
        }

        alert(`태그가 저장되었습니다.${pilotLine}`);
        console.log('태그 저장 완료:', tagsData);
    } catch (e) {
        console.error('태그 저장 실패:', e);
        alert('태그 저장 중 오류가 발생했습니다: ' + e.message);
    }
};
