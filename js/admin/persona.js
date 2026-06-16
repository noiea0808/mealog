/**
 * 관리자 콘텐츠: MEALOG 안내 메시지·페르소나 캐릭터 편집
 */
import { app, db, appId, callableFunctions, auth } from '../firebase.js';
import { uploadPersonaImageToStorage } from '../utils.js';
import { escapeHtml, runAdminRefreshAction } from './utils.js';
import { GEMINI_MEALDANG_MODEL } from '../constants.js';
import {
    collection,
    doc,
    getDoc,
    setDoc,
    deleteDoc,
    getDocs,
    query,
    where,
    limit,
    orderBy
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

// 페르소나 사이드바 전환
// switchPersonaSidebar는 더 이상 사용하지 않음 (콘텐츠 관리로 이동)
// 기존 호출을 switchContentSidebar로 변경
window.switchPersonaSidebar = function(section) {
    // 콘텐츠 관리 탭으로 리다이렉트
    window.switchAdminTab('content');
    setTimeout(() => {
        window.switchContentSidebar(section);
    }, 100);
};

// MEALOG 코멘트 로드
async function loadMealogComments() {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return;
    
    container.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        const mealogDocRef = doc(db, 'artifacts', appId, 'persona', 'mealog');
        const mealogSnap = await getDoc(mealogDocRef);
        
        let comments = [];
        if (mealogSnap.exists()) {
            const data = mealogSnap.data();
            comments = data.comments || [];
        }
        
        // 기본값이 없으면 기본 메시지 추가
        if (comments.length === 0) {
            comments = [`안녕하세요! MEALOG 사용 방법을
안내해드릴게요.

📌 캐릭터 선택
왼쪽 캐릭터 아이콘을 클릭하면
다양한 캐릭터를 선택할 수 있어요.
각 캐릭터는 서로 다른 스타일로
식사 기록을 분석해줘요.

💬 COMMENT 버튼
노란색 COMMENT 버튼을 누르면
선택한 캐릭터가 AI로 당신의
식사 기록을 분석해서
특별한 코멘트를 만들어줘요!

🏆 베스트 공유
Best 분석 탭에서 "공유하기"
버튼을 누르면 이번 주/월의
베스트 식사를 피드에
공유할 수 있어요.

📊 식사/간식 분석
Best, 식사, 간식 탭을 눌러서
다양한 방식으로 기록을
확인해보세요.`];
        }
        
        renderMealogComments(comments);
    } catch (e) {
        console.error('MEALOG 코멘트 로드 실패:', e);
        container.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>MEALOG 코멘트를 불러오는 중 오류가 발생했습니다: ' + e.message + '</p></div>';
    }
}

// MEALOG 코멘트 렌더링
function renderMealogComments(comments) {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return;
    
    // 기존 내용 제거
    container.innerHTML = '';
    
    // 각 코멘트를 DOM 요소로 생성하여 추가
    comments.forEach((comment, index) => {
        const commentDiv = document.createElement('div');
        commentDiv.className = 'bg-slate-50 rounded-xl p-4 border border-slate-200';
        commentDiv.setAttribute('data-index', index);
        
        commentDiv.innerHTML = `
            <div class="flex items-start justify-between mb-3">
                <span class="text-xs font-bold text-slate-500">메시지 ${index + 1}</span>
                <button onclick="window.removeMealogComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <textarea onchange="window.updateMealogComment(${index}, this.value)"
                      class="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[200px]"
                      placeholder="MEALOG 안내 메시지를 입력하세요"></textarea>
        `;
        
        // textarea의 값을 value 속성으로 직접 설정 (줄바꿈 유지, HTML 이스케이프 불필요)
        const textarea = commentDiv.querySelector('textarea');
        if (textarea && comment) {
            textarea.value = comment; // textarea.value는 줄바꿈을 그대로 유지
        }
        
        container.appendChild(commentDiv);
    });
}

// MEALOG 코멘트 추가
window.addMealogComment = function() {
    const comments = getCurrentMealogComments();
    comments.push('');
    renderMealogComments(comments);
};

// MEALOG 코멘트 제거
window.removeMealogComment = function(index) {
    const comments = getCurrentMealogComments();
    if (comments.length <= 1) {
        alert('최소 한 개의 메시지가 필요합니다.');
        return;
    }
    
    comments.splice(index, 1);
    renderMealogComments(comments);
};

// MEALOG 코멘트 업데이트
window.updateMealogComment = function(index, value) {
    const comments = getCurrentMealogComments();
    if (comments[index] !== undefined) {
        comments[index] = value;
    }
};

// 현재 MEALOG 코멘트 목록 가져오기
function getCurrentMealogComments() {
    const container = document.getElementById('mealogCommentsContainer');
    if (!container) return [];
    
    const comments = [];
    // DOM 순서대로 모든 textarea를 순회하여 순차적으로 배열에 추가
    // 인덱스 기반 할당 대신 push를 사용하여 빈 슬롯 방지
    container.querySelectorAll('[data-index]').forEach(itemEl => {
        const textarea = itemEl.querySelector('textarea');
        if (textarea && textarea.value) {
            // textarea의 값을 그대로 추가 (줄바꿈 포함)
            comments.push(textarea.value);
        }
    });
    
    return comments;
}

// MEALOG 코멘트 저장
window.saveMealogComments = async function() {
    try {
        const comments = getCurrentMealogComments();
        
        // 더 엄격한 필터링: undefined, null, 빈 문자열 모두 제거
        const validComments = comments.filter(c => {
            return c !== null && c !== undefined && typeof c === 'string' && c.trim().length > 0;
        });
        
        if (validComments.length === 0) {
            alert('최소 한 개의 메시지가 필요합니다.');
            return;
        }
        
        const mealogData = {
            comments: validComments,
            updatedAt: new Date().toISOString()
        };
        
        const mealogDocRef = doc(db, 'artifacts', appId, 'persona', 'mealog');
        await setDoc(mealogDocRef, mealogData, { merge: true });
        
        alert('MEALOG 메시지가 저장되었습니다.');
        console.log('MEALOG 메시지 저장 완료:', mealogData);
        console.log('저장된 코멘트 수:', validComments.length);
        console.log('저장된 코멘트 내용:', validComments);
        // 각 코멘트의 전체 내용과 길이를 상세히 로그
        validComments.forEach((comment, idx) => {
            console.log(`코멘트 ${idx + 1}:`, {
                길이: comment.length,
                줄_수: comment.split('\n').length,
                전체_내용: comment,
                COMMENT_버튼_포함: comment.includes('💬') || comment.includes('COMMENT')
            });
        });
    } catch (e) {
        console.error('MEALOG 메시지 저장 실패:', e);
        alert('MEALOG 메시지 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 기본 캐릭터 정의 (insight.js와 동일)
const DEFAULT_CHARACTERS = [
    { 
        id: 'trainer', 
        name: '엄격한 트레이너', 
        icon: '💪', 
        image: 'persona/trainer.png',
        persona: '건강과 웰빙을 중시하는 트레이너',
        systemPrompt: '당신은 건강과 웰빙을 중시하는 트레이너입니다. 엄격하지만 따뜻한 톤으로, 식사 패턴을 날카롭게 분석하고 건강한 식습관을 위한 명확한 조언을 제공합니다. 격려와 함께 건설적인 피드백을 주며, 때로는 유머를 섞어 지루하지 않게 전달합니다. 전문적이지만 딱딱하지 않고, 사용자가 행동 변화를 일으킬 수 있도록 동기부여하는 당신만의 스타일을 유지하세요.'
    }
];

// 현재 선택된 캐릭터 ID
let currentEditingCharacterId = null;

function localDateKeyYmdOffsetDays(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() - offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** 최근 30일 geminiUsageDaily byModel 합산 */
async function loadGeminiModelUsageLast30Days() {
    const keys = [];
    for (let i = 0; i < 30; i++) keys.push(localDateKeyYmdOffsetDays(i));
    const snaps = await Promise.all(
        keys.map((k) => getDoc(doc(db, 'artifacts', appId, 'geminiUsageDaily', k)))
    );
    const totals = {};
    snaps.forEach((snap) => {
        if (!snap.exists()) return;
        const byModel = snap.data()?.byModel;
        if (!byModel || typeof byModel !== 'object') return;
        Object.entries(byModel).forEach(([model, count]) => {
            const n = Number(count);
            if (!Number.isFinite(n) || n <= 0) return;
            totals[model] = (totals[model] || 0) + n;
        });
    });
    return totals;
}

function renderPersonaGeminiModelInfo(usageTotals) {
    const el = document.getElementById('personaGeminiModelInfo');
    if (!el) return;

    const rows = Object.entries(usageTotals || {})
        .filter(([, count]) => Number(count) > 0)
        .sort((a, b) => b[1] - a[1]);

    const usageHtml = rows.length
        ? `<ul class="mt-1 space-y-0.5">${rows.map(([model, count]) =>
            `<li><code class="text-slate-500">${escapeHtml(model)}</code> <span class="text-slate-600 font-semibold">${Number(count).toLocaleString('ko-KR')}회</span></li>`
        ).join('')}</ul>`
        : '<p class="mt-1 text-slate-400">최근 30일 호출 기록이 없습니다. (Functions 배포 후 새 호출부터 집계됩니다)</p>';

    el.innerHTML = `
        <p>AI 코멘트 모델: <code class="text-slate-500">${escapeHtml(GEMINI_MEALDANG_MODEL)}</code></p>
        <div>
            <p class="text-slate-500 font-semibold">최근 30일 모델별 호출 횟수</p>
            ${usageHtml}
        </div>
    `;
}

async function refreshPersonaGeminiModelInfo() {
    const el = document.getElementById('personaGeminiModelInfo');
    if (!el) return;
    try {
        const totals = await loadGeminiModelUsageLast30Days();
        renderPersonaGeminiModelInfo(totals);
    } catch (e) {
        console.error('Gemini 모델 사용량 로드 실패:', e);
        el.innerHTML = `
            <p>AI 코멘트 모델: <code class="text-slate-500">${escapeHtml(GEMINI_MEALDANG_MODEL)}</code></p>
            <p class="text-red-400">최근 30일 사용량을 불러오지 못했습니다.</p>
        `;
    }
}

// 페르소나 캐릭터 렌더링
async function renderPersonaCharacters() {
    const listContainer = document.getElementById('personaCharactersList');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<div class="text-center py-4 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-xl mb-2"></i><p class="text-xs">로딩 중...</p></div>';
    
    try {
        // 기본 캐릭터 + Firebase 캐릭터 로드
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        
        let allCharacters = [...DEFAULT_CHARACTERS];
        
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            // Firebase에서 추가된 캐릭터들 추가 (기본 캐릭터와 중복되지 않는 것만, id 순 정렬)
            Object.entries(data)
                .filter(([id]) => !DEFAULT_CHARACTERS.find(c => c.id === id))
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([id, charData]) => {
                    allCharacters.push({
                        id,
                        name: charData.name || id,
                        icon: charData.icon || '👤',
                        image: charData.image || null,
                        persona: charData.persona || '',
                        systemPrompt: ''
                    });
                });
        }
        
        // 각 캐릭터의 개별 설정 문서에서 상세 정보 가져오기
        for (const char of allCharacters) {
            try {
                const personaDocRef = doc(db, 'artifacts', appId, 'persona', char.id);
                const personaDoc = await getDoc(personaDocRef);
                if (personaDoc.exists()) {
                    const personaData = personaDoc.data();
                    if (personaData.persona) char.persona = personaData.persona;
                    if (personaData.systemPrompt) char.systemPrompt = personaData.systemPrompt;
                    if (personaData.defaultComments) char.defaultComments = personaData.defaultComments;
                    if (personaData.image) char.image = personaData.image;
                    if (personaData.name) char.name = personaData.name;
                }
            } catch (e) {
                console.error(`캐릭터 ${char.id} 설정 가져오기 실패:`, e);
            }
        }
        
        // '공통' 캐릭터를 맨 앞에 추가
        const commonCharacter = {
            id: 'common',
            name: '공통',
            icon: '🌐',
            image: null,
            persona: '모든 캐릭터에 공통으로 적용되는 페르소나',
            systemPrompt: ''
        };
        
        // 공통 페르소나 로드
        try {
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            const commonDoc = await getDoc(commonDocRef);
            if (commonDoc.exists()) {
                const commonData = commonDoc.data();
                if (commonData.systemPrompt) commonCharacter.systemPrompt = commonData.systemPrompt;
            }
        } catch (e) {
            console.error('공통 페르소나 로드 실패:', e);
        }
        
        // 공통 + 다른 캐릭터들 (순서: 공통 → 기본 → Firebase)
        const allCharactersWithCommon = [commonCharacter, ...allCharacters];
        
        // 캐릭터 목록 렌더링 (세로)
        listContainer.innerHTML = allCharactersWithCommon.map((char, index) => {
            const isCommon = char.id === 'common';
            return `
                <div class="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 transition-colors">
                    <button type="button" onclick="window.selectCharacterForEdit('${String(char.id).replace(/'/g, "\\'")}')" 
                            data-character-id="${escapeHtml(char.id)}"
                            class="flex-1 flex items-center gap-3 text-left min-w-0">
                        <span class="text-sm font-bold text-slate-500 w-6">${index + 1}</span>
                        ${char.image ? `
                            <img src="${escapeHtml(char.image)}" alt="${escapeHtml(char.name || '')}" class="w-10 h-10 object-cover rounded-lg flex-shrink-0" onerror="this.style.display='none'">
                        ` : ''}
                        ${!char.image && char.icon ? `
                            <div class="w-10 h-10 rounded-lg bg-slate-200 flex items-center justify-center text-xl flex-shrink-0">${escapeHtml(char.icon)}</div>
                        ` : ''}
                        <span class="text-sm font-bold text-slate-800 truncate">${escapeHtml(char.name || char.id || '')}</span>
                    </button>
                    ${!isCommon ? `
                        <button type="button" onclick="window.deleteCharacter('${String(char.id).replace(/'/g, "\\'")}')" 
                                class="px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                            <i class="fa-solid fa-trash mr-1"></i>삭제
                        </button>
                    ` : ''}
                </div>
            `;
        }).join('');
        await refreshPersonaGeminiModelInfo();
    } catch (e) {
        console.error("페르소나 캐릭터 렌더링 실패:", e);
        listContainer.innerHTML = '<div class="text-center py-4 text-red-400"><i class="fa-solid fa-exclamation-triangle text-xl mb-2"></i><p class="text-xs">캐릭터를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 캐릭터 목록 뷰 표시
function showCharacterListView() {
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.remove('hidden');
    if (editView) editView.classList.add('hidden');
    currentEditingCharacterId = null;
    renderPersonaCharacters();
}
window.showCharacterListView = showCharacterListView;

// 캐릭터 선택 (편집용) - 편집 뷰로 전환
window.selectCharacterForEdit = async function(characterId) {
    currentEditingCharacterId = characterId;
    
    // 목록 뷰 숨기고 편집 뷰 표시
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.add('hidden');
    if (editView) editView.classList.remove('hidden');
    
    // 편집 폼 로드
    await loadCharacterEditor(characterId);
};

// 캐릭터 편집 폼 로드
async function loadCharacterEditor(characterId) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = '<div class="text-center py-8 text-slate-400"><i class="fa-solid fa-spinner fa-spin text-2xl mb-2"></i><p>로딩 중...</p></div>';
    
    try {
        // 공통 캐릭터인지 확인
        if (characterId === 'common') {
            let commonData = {
                id: 'common',
                name: '공통',
                icon: '🌐',
                image: null,
                persona: '모든 캐릭터에 공통으로 적용되는 페르소나',
                systemPrompt: ''
            };
            
            // Firebase에서 공통 페르소나 가져오기
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            const commonDoc = await getDoc(commonDocRef);
            if (commonDoc.exists()) {
                const data = commonDoc.data();
                commonData.systemPrompt = data.systemPrompt || '';
            }
            
            // 공통 페르소나 편집 폼 렌더링
            renderCommonPersonaForm(commonData);
            return;
        }
        
        // 기본 캐릭터인지 확인
        const defaultChar = DEFAULT_CHARACTERS.find(c => c.id === characterId);
        let characterData = defaultChar ? { ...defaultChar } : { id: characterId, name: '', icon: '👤', image: '', persona: '', systemPrompt: '', defaultComments: [] };
        
        // Firebase에서 개별 설정 가져오기
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        const personaDoc = await getDoc(personaDocRef);
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            characterData = { ...characterData, ...data };
        }
        
        // Firebase에서 characters 목록에서도 가져오기 (이름, 아이콘, 이미지)
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            if (data[characterId]) {
                characterData.name = data[characterId].name || characterData.name;
                characterData.icon = data[characterId].icon || characterData.icon;
                characterData.image = data[characterId].image || characterData.image;
            }
        }
        
        // 기본 멘트가 없으면 빈 배열로 초기화
        if (!characterData.defaultComments || !Array.isArray(characterData.defaultComments)) {
            characterData.defaultComments = [];
        }
        
        // 로딩 멘트가 없으면 기본값 설정
        if (!characterData.loadingMessage) {
            characterData.loadingMessage = '분석중입니다';
        }
        
        // 편집 폼 렌더링
        renderCharacterEditorForm(characterData);
    } catch (e) {
        console.error('캐릭터 편집 폼 로드 실패:', e);
        editorContent.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl mb-2"></i><p>캐릭터 정보를 불러오는 중 오류가 발생했습니다.</p></div>';
    }
}

// 공통 페르소나 편집 폼 렌더링
function renderCommonPersonaForm(commonData) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = `
        <div class="space-y-6">
            <div class="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <div class="flex items-start gap-3">
                    <i class="fa-solid fa-info-circle text-blue-600 text-xl mt-0.5"></i>
                    <div>
                        <h3 class="text-sm font-bold text-blue-800 mb-1">공통 페르소나</h3>
                        <p class="text-xs text-blue-700">이 페르소나는 모든 AI 캐릭터의 분석에 공통으로 적용됩니다. 각 캐릭터의 고유한 페르소나와 함께 사용됩니다.</p>
                    </div>
                </div>
            </div>
            
            <!-- 공통 페르소나: 입력 텍스트만큼 창 자동 확장 -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-robot mr-2"></i>공통 페르소나 (구글 AI 스튜디오에 발송할 프롬프트)
                </label>
                <textarea id="commonSystemPrompt" 
                          class="persona-auto-resize w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 min-h-[200px] resize-none overflow-hidden"
                          placeholder="모든 캐릭터에 공통으로 적용될 페르소나를 입력하세요. 예: '항상 친근하고 따뜻한 톤으로 대화하며, 사용자의 식사 기록을 긍정적으로 분석합니다.'">${escapeHtml(commonData.systemPrompt || '')}</textarea>
            </div>
        </div>
    `;
    attachPersonaAutoResize();
}

// 캐릭터 편집 폼 렌더링
function renderCharacterEditorForm(characterData) {
    const editorContent = document.getElementById('personaCharacterEditorContent');
    if (!editorContent) return;
    
    editorContent.innerHTML = `
        <div class="space-y-6">
            <!-- 이미지: 좌(미리보기) | 우(선택+경로, 이미지 높이에 맞춤) -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-image mr-2"></i>캐릭터 이미지 <span class="text-slate-500 font-normal">(75×132)</span>
                </label>
                <div class="flex gap-3 items-stretch">
                    <div id="characterImagePreview" class="relative flex-shrink-0 w-[75px] h-[132px] rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center overflow-hidden">
                        ${characterData.image ? `
                            <img src="${escapeHtml(characterData.image)}" alt="미리보기" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<span class=\\'text-slate-400 text-2xl\\'>👤</span>'">
                            <button type="button" onclick="window.removeCharacterImage()" 
                                    class="absolute top-0.5 right-0.5 px-1.5 py-0.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600">
                                <i class="fa-solid fa-times"></i>
                            </button>
                        ` : '<span class="text-slate-400 text-2xl">👤</span>'}
                    </div>
                    <div class="flex flex-col gap-2 justify-center min-w-0">
                        <input type="file" id="characterImageFile" accept="image/*" 
                               onchange="window.handleCharacterImageUpload(event)"
                               class="hidden">
                        <button type="button" onclick="document.getElementById('characterImageFile').click()" 
                                class="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold transition-colors flex items-center justify-center gap-2">
                            <i class="fa-solid fa-upload"></i>
                            <span>이미지 선택</span>
                        </button>
                        <input type="text" id="characterImage" value="${escapeHtml(characterData.image || '')}" 
                               placeholder="또는 이미지 URL 직접 입력"
                               onchange="window.updateCharacterImageFromUrl(this.value)"
                               class="w-full min-w-[160px] px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500">
                    </div>
                </div>
            </div>
            
            <!-- 캐릭터 이름: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-center">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28">
                    <i class="fa-solid fa-tag mr-2"></i>캐릭터 이름
                </label>
                <input type="text" id="characterName" value="${escapeHtml(characterData.name || '')}" 
                       placeholder="예: 엄격한 트레이너"
                       class="flex-1 min-w-0 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500">
            </div>
            
            <!-- 기본 멘트: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-start">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">
                    <i class="fa-solid fa-comment mr-2"></i>기본 멘트
                </label>
                <div class="flex-1 min-w-0">
                    <p class="text-xs text-slate-500 mb-2">COMMENT 버튼 클릭 시 표시. 여러 개 입력 시 랜덤 표시.</p>
                    <div id="characterDefaultCommentsContainer" class="space-y-3">
                        ${characterData.defaultComments && characterData.defaultComments.length > 0 ? characterData.defaultComments.map((comment, index) => `
                            <div class="flex gap-2 items-start" data-comment-index="${index}">
                                <textarea onchange="window.updateCharacterDefaultComment(${index}, this.value)"
                                          class="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                          placeholder="기본 멘트를 입력하세요">${escapeHtml(comment || '')}</textarea>
                                <button onclick="window.removeCharacterDefaultComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        `).join('') : ''}
                    </div>
                    <button onclick="window.addCharacterDefaultComment()" class="mt-2 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg text-sm font-bold hover:bg-slate-300 transition-colors">
                        <i class="fa-solid fa-plus mr-2"></i>멘트 추가
                    </button>
                </div>
            </div>
            
            <!-- 로딩 멘트: 타이틀 오른쪽에 입력 -->
            <div class="flex gap-4 items-start">
                <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">
                    <i class="fa-solid fa-spinner mr-2"></i>로딩 멘트
                </label>
                <div class="flex-1 min-w-0">
                    <p class="text-xs text-slate-500 mb-2">AI 코멘트 생성 중 표시 (일반 텍스트)</p>
                    <textarea id="characterLoadingMessage" 
                              class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                              placeholder="예: 분석중입니다">${escapeHtml(characterData.loadingMessage || '')}</textarea>
                </div>
            </div>

            <div class="border-t border-slate-200 pt-4 space-y-4">
                <div class="flex gap-4 items-start">
                    <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">기간 경과 부족 시</label>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs text-slate-500 mb-1">표시 조건: 주간 4일 미만, 월간 10일 미만, 연간 3월 미만, 직접설정 50% 미만 경과 시</p>
                        <p class="text-xs text-emerald-700 mb-2">분석 가능 시점: 주간 4일 경과 후 · 월간 10일 경과 후 · 연간 4월 1일 이후 · 직접설정은 선택 기간의 50% 이상 경과 후</p>
                        <textarea id="characterInsightMessageInsufficientPeriod" rows="2"
                                  class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                  placeholder="아직 이 기간이 충분히 경과하지 않았어요. 조금 더 지나면 더 의미 있는 코멘트를 드릴 수 있어요.">${escapeHtml(characterData.insightMessageInsufficientPeriod || '')}</textarea>
                    </div>
                </div>
                <div class="flex gap-4 items-start">
                    <label class="flex-shrink-0 text-sm font-bold text-slate-700 w-28 pt-2">기록 부족 시</label>
                    <div class="flex-1 min-w-0">
                        <p class="text-xs text-slate-500 mb-1">표시 조건: 경과한 일수 × 3(아침/점심/저녁) 대비 본식 기록이 50% 미만일 때</p>
                        <p class="text-xs text-emerald-700 mb-2">분석 가능 시점: 경과 일수의 본식 슬롯 수의 50% 이상 기록 시 (예: 7일 경과 시 11회 이상, 10일 경과 시 15회 이상)</p>
                        <textarea id="characterInsightMessageInsufficientRecords" rows="2"
                                  class="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                                  placeholder="이 기간의 식사 기록이 아직 충분하지 않아요. 조금 더 기록해 보시면 더 재미있는 코멘트를 드릴 수 있어요.">${escapeHtml(characterData.insightMessageInsufficientRecords || '')}</textarea>
                    </div>
                </div>
            </div>
            
            <!-- 페르소나: 입력 텍스트만큼 창 자동 확장 -->
            <div>
                <label class="block text-sm font-bold text-slate-700 mb-2">
                    <i class="fa-solid fa-robot mr-2"></i>페르소나 (구글 AI 스튜디오에 발송할 프롬프트)
                </label>
                <textarea id="characterSystemPrompt" 
                          class="persona-auto-resize w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 min-h-[200px] resize-none overflow-hidden"
                          placeholder="캐릭터의 성격, 말투, 분석 스타일 등을 정의하는 프롬프트를 입력하세요">${escapeHtml(characterData.systemPrompt || '')}</textarea>
            </div>
        </div>
    `;
    attachPersonaAutoResize();
}

// 페르소나 입력창: 입력 텍스트만큼 자동 확장 (스크롤 없음)
function attachPersonaAutoResize() {
    const resize = (ta) => {
        ta.style.height = 'auto';
        ta.style.height = Math.max(200, ta.scrollHeight) + 'px';
    };
    document.querySelectorAll('.persona-auto-resize').forEach(ta => {
        resize(ta);
        ta.addEventListener('input', () => resize(ta));
    });
}

// 기본 멘트 추가
window.addCharacterDefaultComment = function() {
    const container = document.getElementById('characterDefaultCommentsContainer');
    if (!container) return;
    
    const index = container.children.length;
    const newCommentDiv = document.createElement('div');
    newCommentDiv.className = 'flex gap-2 items-start';
    newCommentDiv.setAttribute('data-comment-index', index);
    newCommentDiv.innerHTML = `
        <textarea onchange="window.updateCharacterDefaultComment(${index}, this.value)"
                  class="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700 outline-none focus:border-emerald-500 resize-y min-h-[80px] overflow-hidden"
                  placeholder="기본 멘트를 입력하세요"></textarea>
        <button onclick="window.removeCharacterDefaultComment(${index})" class="px-3 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-bold hover:bg-red-200 transition-colors flex-shrink-0">
            <i class="fa-solid fa-trash"></i>
        </button>
    `;
    container.appendChild(newCommentDiv);
};

// 기본 멘트 제거
window.removeCharacterDefaultComment = function(index) {
    const container = document.getElementById('characterDefaultCommentsContainer');
    if (!container) return;
    
    const commentDiv = container.querySelector(`[data-comment-index="${index}"]`);
    if (commentDiv) {
        commentDiv.remove();
        // 인덱스 재정렬
        Array.from(container.children).forEach((child, idx) => {
            child.setAttribute('data-comment-index', idx);
            const textarea = child.querySelector('textarea');
            const button = child.querySelector('button');
            if (textarea) {
                textarea.setAttribute('onchange', `window.updateCharacterDefaultComment(${idx}, this.value)`);
            }
            if (button) {
                button.setAttribute('onclick', `window.removeCharacterDefaultComment(${idx})`);
            }
        });
    }
};

// 기본 멘트 업데이트
window.updateCharacterDefaultComment = function(index, value) {
    // 실시간 업데이트는 렌더링 시 자동으로 반영됨
};

// 캐릭터 이미지 업로드 핸들러
window.handleCharacterImageUpload = async function(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // 파일 타입 확인
    if (!file.type.startsWith('image/')) {
        alert('이미지 파일만 업로드할 수 있습니다.');
        return;
    }
    
    // 파일 크기 확인 (10MB 제한)
    if (file.size > 10 * 1024 * 1024) {
        alert('파일 크기는 10MB 이하여야 합니다.');
        return;
    }
    
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    
    try {
        // 현재 사용자 ID 가져오기 (관리자)
        const user = auth.currentUser;
        if (!user) {
            alert('로그인이 필요합니다.');
            return;
        }
        
        // Firebase Storage에 업로드 (PNG 투명 배경 보존)
        const imageUrl = await uploadPersonaImageToStorage(file, user.uid, currentEditingCharacterId || 'temp');
        
        // 이미지 URL 필드에 설정
        const imageInput = document.getElementById('characterImage');
        if (imageInput) {
            imageInput.value = imageUrl;
        }
        
        // 미리보기 업데이트
        updateCharacterImagePreview(imageUrl);
        
        // 파일 입력 초기화
        event.target.value = '';
        
    } catch (e) {
        console.error('이미지 업로드 실패:', e);
        alert('이미지 업로드 중 오류가 발생했습니다: ' + e.message);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
};

// 캐릭터 이미지 미리보기 업데이트
function updateCharacterImagePreview(imageUrl) {
    const previewContainer = document.getElementById('characterImagePreview');
    if (!previewContainer) return;
    
    if (imageUrl) {
        previewContainer.innerHTML = `
            <img src="${escapeHtml(imageUrl)}" alt="미리보기" class="w-full h-full object-cover" onerror="this.parentElement.innerHTML='<span class=\\'text-slate-400 text-2xl\\'>👤</span>'">
            <button type="button" onclick="window.removeCharacterImage()" 
                    class="absolute top-0.5 right-0.5 px-1.5 py-0.5 bg-red-500 text-white rounded text-xs font-bold hover:bg-red-600">
                <i class="fa-solid fa-times"></i>
            </button>
        `;
    } else {
        previewContainer.innerHTML = '<span class="text-slate-400 text-2xl">👤</span>';
    }
}

// 캐릭터 이미지 제거
window.removeCharacterImage = function() {
    const imageInput = document.getElementById('characterImage');
    if (imageInput) {
        imageInput.value = '';
    }
    updateCharacterImagePreview('');
};

// URL 입력으로 이미지 미리보기 업데이트
window.updateCharacterImageFromUrl = function(imageUrl) {
    updateCharacterImagePreview(imageUrl || '');
};

// 새 캐릭터 추가
window.addNewCharacter = function() {
    const newId = 'character_' + Date.now();
    currentEditingCharacterId = newId;
    
    // 편집 뷰로 전환
    const listView = document.getElementById('characters-list-view');
    const editView = document.getElementById('character-edit-view');
    if (listView) listView.classList.add('hidden');
    if (editView) editView.classList.remove('hidden');
    
    // 편집 폼 로드
    loadCharacterEditor(newId);
};

// 캐릭터 삭제
window.deleteCharacter = async function(characterId) {
    // 공통 캐릭터는 삭제 불가
    if (characterId === 'common') {
        alert('공통 페르소나는 삭제할 수 없습니다.');
        return;
    }
    
    if (!confirm('정말 이 캐릭터를 삭제하시겠습니까?')) return;
    
    try {
        // characters 목록에서 삭제
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersSnap = await getDoc(charactersDocRef);
        if (charactersSnap.exists()) {
            const data = charactersSnap.data();
            delete data[characterId];
            await setDoc(charactersDocRef, data, { merge: true });
        }
        
        // 개별 설정 문서 삭제
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        await deleteDoc(personaDocRef);
        
        // 현재 선택된 캐릭터가 삭제된 경우 목록 뷰로 전환
        if (currentEditingCharacterId === characterId) {
            currentEditingCharacterId = null;
            showCharacterListView();
        }
        
        // 목록 새로고침
        await renderPersonaCharacters();
        
        alert('캐릭터가 삭제되었습니다.');
    } catch (e) {
        console.error('캐릭터 삭제 실패:', e);
        alert('캐릭터 삭제 중 오류가 발생했습니다: ' + e.message);
    }
};

// 캐릭터 저장
window.saveCharacter = async function() {
    if (!currentEditingCharacterId) {
        alert('저장할 캐릭터를 선택해주세요.');
        return;
    }
    
    try {
        // 공통 페르소나 저장
        if (currentEditingCharacterId === 'common') {
            const commonSystemPromptInput = document.getElementById('commonSystemPrompt');
            if (!commonSystemPromptInput) {
                alert('폼을 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
                return;
            }
            const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
            await setDoc(commonDocRef, {
                systemPrompt: commonSystemPromptInput.value.trim(),
                updatedAt: new Date().toISOString()
            }, { merge: true });
            
            alert('공통 페르소나가 저장되었습니다.');
            
            // 목록 새로고침
            await renderPersonaCharacters();
            return;
        }
        
        const imageInput = document.getElementById('characterImage');
        const nameInput = document.getElementById('characterName');
        const systemPromptInput = document.getElementById('characterSystemPrompt');
        const loadingMessageInput = document.getElementById('characterLoadingMessage');
        const insightPeriodEl = document.getElementById('characterInsightMessageInsufficientPeriod');
        const insightRecordsEl = document.getElementById('characterInsightMessageInsufficientRecords');
        const commentsContainer = document.getElementById('characterDefaultCommentsContainer');
        
        if (!imageInput || !nameInput || !systemPromptInput) {
            alert('폼을 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
            return;
        }
        
        const image = imageInput.value.trim();
        const name = nameInput.value.trim();
        const systemPrompt = systemPromptInput.value.trim();
        const loadingMessage = loadingMessageInput ? loadingMessageInput.value.trim() : '';
        
        if (!name) {
            alert('캐릭터 이름을 입력해주세요.');
            return;
        }
        
        // 기본 멘트 수집
        const defaultComments = [];
        if (commentsContainer) {
            commentsContainer.querySelectorAll('textarea').forEach(textarea => {
                const value = textarea.value.trim();
                if (value) {
                    defaultComments.push(value);
                }
            });
        }
        
        // characters 목록에 저장 (기본 캐릭터가 아닌 경우만)
        const isDefaultCharacter = DEFAULT_CHARACTERS.find(c => c.id === currentEditingCharacterId);
        if (!isDefaultCharacter) {
            const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
            const charactersSnap = await getDoc(charactersDocRef);
            const charactersData = charactersSnap.exists() ? charactersSnap.data() : {};
            
            charactersData[currentEditingCharacterId] = {
                name: name,
                icon: '👤', // 기본값
                image: image || null
            };
            
            await setDoc(charactersDocRef, charactersData, { merge: true });
        }
        
        // 개별 설정 문서에 저장
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', currentEditingCharacterId);
        await setDoc(personaDocRef, {
            persona: name, // 간단한 설명으로 이름 사용
            systemPrompt: systemPrompt,
            defaultComments: defaultComments,
            loadingMessage: loadingMessage || '분석중입니다', // 기본값
            insightMessageInsufficientPeriod: (insightPeriodEl && insightPeriodEl.value) ? insightPeriodEl.value.trim() : '',
            insightMessageInsufficientRecords: (insightRecordsEl && insightRecordsEl.value) ? insightRecordsEl.value.trim() : '',
            image: image || null,
            name: name,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        
        alert('캐릭터가 저장되었습니다.');
        
        // 목록 새로고침
        await renderPersonaCharacters();
    } catch (e) {
        console.error('캐릭터 저장 실패:', e);
        alert('캐릭터 저장 중 오류가 발생했습니다: ' + e.message);
    }
};

// 페르소나 설정 렌더링 (초기화)
async function renderPersonaSettings() {
    // 페르소나 설정은 더 이상 사용하지 않음
    // 콘텐츠 관리 탭으로 리다이렉트
    window.switchAdminTab('content');
    setTimeout(() => {
        window.switchContentSidebar('mealog');
    }, 100);
}

// 페르소나 새로고침 (콘텐츠 관리로 이동)
window.refreshPersona = async function (buttonEl) {
    await runAdminRefreshAction(buttonEl || null, async () => {
        const activeSection = document.querySelector('.content-main-section:not(.hidden)');
        if (activeSection) {
            const sectionId = activeSection.id.replace('content-main-', '');
            if (['notice', 'pushMessage', 'popup', 'loginBanner'].includes(sectionId)) {
                window.switchAdminTab('alerts');
                await new Promise((r) => setTimeout(r, 0));
                window.switchAlertsSidebar(sectionId);
                return;
            }
            if (sectionId === 'mealog' || sectionId === 'characters') {
                window.switchContentSidebar(sectionId);
            }
        } else {
            window.switchContentSidebar('mealog');
        }
    });
};

export { loadMealogComments, showCharacterListView };
