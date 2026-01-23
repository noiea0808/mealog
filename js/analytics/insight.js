// 인사이트 코멘트 관련 함수들
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { dbOps } from '../db.js';
import { GEMINI_API_KEY as DEFAULT_API_KEY } from '../config.default.js';
import { db, appId } from '../firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// escapeHtml 함수 (필요한 경우)
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// API 키 설정 (항상 기본값으로 시작)
// config.js가 있으면 나중에 업데이트됨
let GEMINI_API_KEY = DEFAULT_API_KEY;

// 전역 변수 확인 (최우선, HTML에서 주입된 경우)
if (typeof window !== 'undefined' && window.GEMINI_API_KEY) {
    GEMINI_API_KEY = window.GEMINI_API_KEY;
    console.log('✅ 전역 변수에서 API 키 로드');
}

// config.js에서 API 키를 가져오는 함수 (비동기, 필요할 때 호출)
// 즉시 실행하여 백그라운드에서 로드
(async function loadConfigApiKey() {
    try {
        const configModule = await import('../config.js');
        if (configModule && configModule.GEMINI_API_KEY && 
            configModule.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' &&
            !window.GEMINI_API_KEY) { // 전역 변수가 없을 때만 사용
            GEMINI_API_KEY = configModule.GEMINI_API_KEY;
            console.log('✅ config.js에서 API 키 로드 성공');
        }
    } catch (error) {
        // config.js가 없으면 기본값 사용 (정상, 로컬 개발 환경에서)
        console.debug('config.js 없음, 기본값 사용');
    }
})();

// getGeminiApiUrl 함수가 사용하는 API 키 가져오기 (최신 값 반환)
function getApiKey() {
    // 전역 변수 확인 (최우선)
    if (typeof window !== 'undefined' && window.GEMINI_API_KEY) {
        return window.GEMINI_API_KEY;
    }
    return GEMINI_API_KEY;
}
// 지원 가능한 모델 목록 - gemini-2.5-flash-lite만 사용
const GEMINI_MODELS = [
    'gemini-2.5-flash-lite'
];

// API URL 생성 함수 (여러 버전 시도)
function getGeminiApiUrl(model, version = 'v1beta') {
    const apiKey = getApiKey();
    return `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`;
}

// 기본 캐릭터 정의
const DEFAULT_CHARACTERS = [
    { 
        id: 'mealog', 
        name: 'MEALOG', 
        icon: 'M', 
        image: null, // MEALOG는 텍스트 아이콘 사용
        persona: '친근하고 따뜻한 식사 친구',
        systemPrompt: '당신은 MEALOG입니다. 사용자의 식사 기록을 친근하고 따뜻하면서도 재미있게 분석합니다. 유머러스하고 밝은 성격으로, 식사 패턴에서 발견한 재미있는 점들을 즐겁게 공유합니다. 진부한 격려보다는 캐주얼하고 친근한 말투로, 마치 친한 친구처럼 편하게 소통합니다. 식사의 즐거움과 소중함을 당신만의 개성 있는 방식으로 전달하세요.'
    },
    { 
        id: 'trainer', 
        name: '엄격한 트레이너', 
        icon: '💪', 
        image: 'persona/trainer.png', // 트레이너 캐릭터 이미지
        persona: '건강과 웰빙을 중시하는 트레이너',
        systemPrompt: '당신은 건강과 웰빙을 중시하는 트레이너입니다. 엄격하지만 따뜻한 톤으로, 식사 패턴을 날카롭게 분석하고 건강한 식습관을 위한 명확한 조언을 제공합니다. 격려와 함께 건설적인 피드백을 주며, 때로는 유머를 섞어 지루하지 않게 전달합니다. 전문적이지만 딱딱하지 않고, 사용자가 행동 변화를 일으킬 수 있도록 동기부여하는 당신만의 스타일을 유지하세요.'
    }
];

// 동적으로 업데이트되는 캐릭터 목록
let INSIGHT_CHARACTERS = [...DEFAULT_CHARACTERS];

// Firebase에서 캐릭터 목록 가져오기
async function loadCharactersFromFirebase() {
    try {
        const charactersDocRef = doc(db, 'artifacts', appId, 'persona', 'characters');
        const charactersDoc = await getDoc(charactersDocRef);
        
        if (charactersDoc.exists()) {
            const charactersData = charactersDoc.data();
            const loadedCharacters = [...DEFAULT_CHARACTERS];
            
            // Firebase에서 추가된 캐릭터들 추가 (기본 캐릭터와 중복되지 않는 것만)
            Object.entries(charactersData).forEach(([id, charData]) => {
                if (!DEFAULT_CHARACTERS.find(c => c.id === id)) {
                    // 각 캐릭터의 개별 설정 문서에서 persona와 systemPrompt 가져오기
                    loadedCharacters.push({
                        id,
                        name: charData.name || id,
                        icon: charData.icon || '👤',
                        image: charData.image || null,
                        persona: '', // 나중에 개별 문서에서 가져올 예정
                        systemPrompt: '' // 나중에 개별 문서에서 가져올 예정
                    });
                }
            });
            
            // 각 캐릭터의 개별 설정 문서에서 persona와 systemPrompt 가져오기
            for (const char of loadedCharacters) {
                if (char.id !== 'mealog') { // MEALOG는 기본값 사용
                    try {
                        const personaDocRef = doc(db, 'artifacts', appId, 'persona', char.id);
                        const personaDoc = await getDoc(personaDocRef);
                        if (personaDoc.exists()) {
                            const personaData = personaDoc.data();
                            if (personaData.persona) char.persona = personaData.persona;
                            if (personaData.systemPrompt) char.systemPrompt = personaData.systemPrompt;
                        }
                    } catch (e) {
                        console.error(`캐릭터 ${char.id} 설정 가져오기 실패:`, e);
                    }
                }
            }
            
            INSIGHT_CHARACTERS = loadedCharacters;
            return loadedCharacters;
        }
        
        INSIGHT_CHARACTERS = [...DEFAULT_CHARACTERS];
        return DEFAULT_CHARACTERS;
    } catch (e) {
        console.error('캐릭터 목록 가져오기 실패:', e);
        INSIGHT_CHARACTERS = [...DEFAULT_CHARACTERS];
        return DEFAULT_CHARACTERS;
    }
}

// 현재 선택된 캐릭터 (기본값: MEALOG)
let currentCharacter = 'mealog';

// MEALOG 코멘트 순차 선택을 위한 인덱스
let mealogCommentIndex = 0;

// 텍스트를 6줄 단위로 나누는 함수 (페이지 제한 없음)
// 원본 줄바꿈을 그대로 유지 (줄바꿈이 없는 텍스트는 그대로 유지)
function splitTextIntoPages(text, maxLines = 6) {
    if (!text) return [''];
    
    // 줄바꿈만 정규화 (원본 텍스트의 줄바꿈과 공백은 그대로 유지)
    const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 원본 텍스트의 마지막 줄바꿈 여부 확인
    const hasTrailingNewline = normalizedText.endsWith('\n');
    
    // 줄 단위로 분할 (split은 마지막 빈 줄도 포함)
    const lines = normalizedText.split('\n');
    
    // 빈 텍스트인 경우
    if (lines.length === 0) return [''];
    
    const pages = [];
    // 5줄씩 묶어서 페이지 만들기
    for (let i = 0; i < lines.length; i += maxLines) {
        const pageLines = lines.slice(i, i + maxLines);
        let pageText = pageLines.join('\n');
        
        // 마지막 페이지이고 원본이 줄바꿈으로 끝났다면 마지막 줄바꿈 추가
        if (i + maxLines >= lines.length && hasTrailingNewline) {
            pageText += '\n';
        }
        
        pages.push(pageText);
    }
    
    // 빈 페이지 방지
    if (pages.length === 0) {
        pages.push(normalizedText);
    }
    
    return pages;
}

// 말풍선에 텍스트 표시 (페이징 없이 전체 텍스트 표시)
function displayInsightText(text, characterName = '') {
    const container = document.getElementById('insightTextContent');
    const bubble = document.getElementById('insightBubble');
    const characterNameEl = document.getElementById('insightCharacterName');
    const characterBtn = document.getElementById('insightCharacterBtn');
    const shareBtn = document.getElementById('shareInsightBtn');
    
    if (!container) {
        console.error('insightTextContent 컨테이너를 찾을 수 없습니다.');
        return;
    }
    
    // 캐릭터명 표시
    if (characterNameEl) {
        if (characterName) {
            characterNameEl.textContent = `[${characterName}]`;
            characterNameEl.classList.remove('hidden');
        } else {
            // characterName이 없으면 현재 선택된 캐릭터 이름 사용
            const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
            if (character) {
                characterNameEl.textContent = `[${character.name}]`;
                characterNameEl.classList.remove('hidden');
            } else {
                characterNameEl.classList.add('hidden');
            }
        }
    }
    
    if (!text) {
        container.innerHTML = '';
        // 공유 버튼 숨기기
        if (shareBtn) {
            shareBtn.classList.add('hidden');
        }
        return;
    }
    
    // 줄바꿈을 <br>로 변환하고 HTML 이스케이프
    const escapedText = escapeHtml(text).replace(/\n/g, '<br>');
    container.innerHTML = escapedText;
    
    // 공유 버튼 상태 업데이트 (공유 상태에 따라 버튼 박스 표시 여부도 결정)
    updateShareButtonStatus();
    
    // 말풍선 최소 높이 설정 (캐릭터창 + 코멘트창의 합산 높이)
    if (bubble && characterBtn) {
        // 캐릭터창 높이 계산 (180px 설정됨)
        const characterContainer = characterBtn.closest('.relative.flex-shrink-0');
        if (characterContainer) {
            const characterHeight = 180; // 캐릭터창 높이 (index.html:546에서 확인)
            const minHeight = characterHeight + 'px';
            bubble.style.minHeight = minHeight;
        }
        
        bubble.style.cursor = 'default';
        bubble.title = '';
        // handleInsightBubbleClick 함수가 정의되어 있을 때만 제거
        if (typeof handleInsightBubbleClick === 'function') {
            bubble.removeEventListener('click', handleInsightBubbleClick);
        }
    }
}

// 인사이트 페이지 전환
export function showInsightPage(pageIndex) {
    const pages = document.querySelectorAll('.insight-text-page');
    const dots = document.querySelectorAll('.insight-page-dot');
    const pageCounter = document.getElementById('insightPageCounter');
    
    if (pages.length === 0) return;
    
    // 페이지 인덱스 범위 확인
    if (pageIndex < 0) pageIndex = pages.length - 1;
    if (pageIndex >= pages.length) pageIndex = 0;
    
    pages.forEach((page, index) => {
        page.classList.toggle('active', index === pageIndex);
    });
    
    dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === pageIndex);
    });
    
    // 페이지 카운터 업데이트
    if (pageCounter && window.totalInsightPages) {
        pageCounter.textContent = `${pageIndex + 1}/${window.totalInsightPages}`;
    }
    
    window.currentInsightPage = pageIndex;
}

// 말풍선 클릭 이벤트 설정 (페이징 없으므로 사용 안 함)
export function setupInsightBubbleClick() {
    const bubble = document.getElementById('insightBubble');
    if (!bubble) return;
    
    // 페이징이 없으므로 클릭 이벤트 제거
    // handleInsightBubbleClick 함수가 정의되어 있을 때만 제거
    if (typeof handleInsightBubbleClick === 'function') {
        bubble.removeEventListener('click', handleInsightBubbleClick);
    }
    bubble.style.cursor = 'default';
    bubble.title = '';
}

// 밀당 캐릭터 선택 팝업 렌더링
async function renderCharacterSelectPopup() {
    const popup = document.getElementById('characterSelectPopup');
    if (!popup) return;
    
    // Firebase에서 최신 캐릭터 목록 가져오기
    await loadCharactersFromFirebase();
    
    const popupContent = popup.querySelector('.bg-white');
    if (!popupContent) return;
    
    const charactersList = popupContent.querySelector('.flex.flex-col.gap-3');
    if (!charactersList) return;
    
    // 캐릭터 목록 렌더링
    charactersList.innerHTML = INSIGHT_CHARACTERS.map(char => {
        const isActive = char.id === currentCharacter;
        let iconHtml = '';
        
        if (char.image) {
            // 이미지 아이콘
            iconHtml = `<div class="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                <img src="${escapeHtml(char.image)}" alt="${escapeHtml(char.name)}" class="w-full h-full object-contain">
            </div>`;
        } else if (char.id === 'mealog') {
            // MEALOG 텍스트 아이콘
            iconHtml = `<div class="w-12 h-12 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-700 font-black text-lg flex-shrink-0">M</div>`;
        } else {
            // 이모지 아이콘
            iconHtml = `<div class="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-2xl flex-shrink-0">${escapeHtml(char.icon)}</div>`;
        }
        
        return `
            <div class="character-popup-item ${isActive ? 'active' : ''} flex items-center gap-3 p-4 rounded-xl cursor-pointer transition-colors hover:bg-slate-50" data-character-id="${char.id}" onclick="window.selectInsightCharacter('${char.id}')">
                ${iconHtml}
                <div class="flex-1">
                    <div class="text-sm font-bold text-slate-800">${escapeHtml(char.name)}</div>
                    <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(char.persona || '')}</div>
                </div>
            </div>
        `;
    }).join('');
}

// 밀당 캐릭터 선택 팝업 열기/토글
export async function openCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    
    if (!popup) return;
    
    // 이미 열려있으면 닫기
    if (!popup.classList.contains('hidden')) {
        closeCharacterSelectModal();
        return;
    }
    
    // 캐릭터 목록 렌더링
    await renderCharacterSelectPopup();
    
    // 화면 가운데에 표시 (CSS로 처리되므로 위치 설정 불필요)
    popup.classList.remove('hidden');
    
    // 외부 클릭 시 닫기
    setTimeout(() => {
        document.addEventListener('click', handleOutsideClick, true);
    }, 100);
}

// 외부 클릭 핸들러
function handleOutsideClick(e) {
    const popup = document.getElementById('characterSelectPopup');
    const popupContent = popup?.querySelector('.bg-white');
    
    // 팝업 내부가 아닌 배경 클릭 시에만 닫기
    if (popup && popupContent && !popupContent.contains(e.target)) {
        closeCharacterSelectModal();
        document.removeEventListener('click', handleOutsideClick, true);
    }
}

// 밀당 캐릭터 선택 팝업 닫기
export function closeCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    if (popup) {
        popup.classList.add('hidden');
    }
    document.removeEventListener('click', handleOutsideClick, true);
}

// 밀당 캐릭터 선택
export function selectInsightCharacter(characterId) {
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    if (!character) return;
    
    currentCharacter = characterId;
    
    // 캐릭터 아이콘 업데이트
    const iconEl = document.getElementById('insightCharacterIcon');
    if (iconEl) {
        if (character.image) {
            // 이미지가 있으면 이미지 표시
            iconEl.innerHTML = `<img src="${character.image}" alt="${character.name}" class="w-full h-full object-contain">`;
            iconEl.className = 'w-full h-full flex items-center justify-center';
        } else if (character.id === 'mealog') {
            // MEALOG는 텍스트 아이콘
            iconEl.textContent = 'M';
            iconEl.className = 'text-2xl font-black text-white';
        } else {
            // 기본 이모지 아이콘
            iconEl.textContent = character.icon;
            iconEl.className = 'text-3xl';
        }
    }
    
    // 캐릭터 목록 UI 업데이트
    const items = document.querySelectorAll('.character-popup-item');
    items.forEach(item => {
        const charId = item.getAttribute('data-character-id');
        if (charId === characterId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    // 팝업 닫기
    closeCharacterSelectModal();
    
    // 선택된 캐릭터로 인사이트 업데이트 (AI 호출 안 함, 기본 메시지만 표시)
    if (window.getDashboardData) {
        const { filteredData, dateRangeText } = window.getDashboardData();
        updateInsightComment(filteredData, dateRangeText);
    }
}

// 캐릭터 로딩 멘트 가져오기 (Firebase에서 가져오기)
async function getCharacterLoadingMessage(characterId) {
    try {
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        const personaDoc = await getDoc(personaDocRef);
        
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            const loadingMessage = data.loadingMessage || '';
            
            if (loadingMessage && loadingMessage.trim()) {
                return loadingMessage.trim();
            }
        }
        
        // 기본값
        return '분석중입니다';
    } catch (e) {
        console.error('캐릭터 로딩 멘트 가져오기 실패:', e);
        return '분석중입니다';
    }
}
async function getCharacterDefaultComment(characterId) {
    try {
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        const personaDoc = await getDoc(personaDocRef);
        
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            const defaultComments = data.defaultComments || [];
            
            // 비어있지 않은 코멘트만 필터링
            const validComments = defaultComments.filter(c => c && c.trim().length > 0);
            
            if (validComments.length > 0) {
                // 랜덤으로 하나 선택
                const randomIndex = Math.floor(Math.random() * validComments.length);
                return validComments[randomIndex];
            }
        }
        
        // 기본값 (Firebase에 저장된 값이 없거나 비어있는 경우)
        const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
        const characterName = character ? character.name : '';
        return `${characterName ? character.icon + ' ' : ''}COMMENT 버튼을 눌러서 ${characterName ? characterName + '의 ' : ''}분석을 받아보세요!`;
    } catch (e) {
        console.error('캐릭터 기본 코멘트 가져오기 실패:', e);
        // 기본값 반환
        const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
        const characterName = character ? character.name : '';
        return `${characterName ? character.icon + ' ' : ''}COMMENT 버튼을 눌러서 ${characterName ? characterName + '의 ' : ''}분석을 받아보세요!`;
    }
}

// MEALOG 캐릭터 사용 안내 텍스트 (Firebase에서 가져오기)
// 메시지별로 순차적으로 반환 (메시지1 > 2 > 3...)
async function getMealogComment() {
    try {
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', 'mealog');
        const personaDoc = await getDoc(personaDocRef);
        
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            const comments = data.comments || [];
            
            // 더 엄격한 필터링: undefined, null, 빈 문자열 모두 제거
            const validComments = comments.filter(c => {
                return c !== null && c !== undefined && typeof c === 'string' && c.trim().length > 0;
            });
            
            console.log('MEALOG 코멘트 로드:', {
                원본_배열_길이: comments.length,
                유효한_코멘트_수: validComments.length,
                현재_인덱스: mealogCommentIndex,
                선택될_코멘트_인덱스: mealogCommentIndex % validComments.length
            });
            
            if (validComments.length > 0) {
                // 순차적으로 선택 (메시지1 > 2 > 3... 순서대로)
                const selectedComment = validComments[mealogCommentIndex % validComments.length];
                mealogCommentIndex = (mealogCommentIndex + 1) % validComments.length;
                
                console.log('선택된 코멘트:', {
                    길이: selectedComment.length,
                    줄_수: selectedComment.split('\n').length,
                    미리보기: selectedComment.substring(0, 100) + '...',
                    전체_내용: selectedComment,
                    COMMENT_버튼_포함: selectedComment.includes('💬') || selectedComment.includes('COMMENT')
                });
                
                return selectedComment;
            }
        }
        
        // 기본값 (Firebase에 저장된 값이 없거나 비어있는 경우)
        return `안녕하세요! MEALOG 사용 방법을
안내해드릴게요.

📌 밀당 캐릭터 선택
왼쪽 캐릭터 아이콘을 클릭하면
다양한 밀당 캐릭터를 선택할 수 있어요.
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
확인해보세요.`;
    } catch (e) {
        console.error('MEALOG 코멘트 가져오기 실패:', e);
        // 기본값 반환
        return `안녕하세요! MEALOG 사용 방법을
안내해드릴게요.

📌 밀당 캐릭터 선택
왼쪽 캐릭터 아이콘을 클릭하면
다양한 밀당 캐릭터를 선택할 수 있어요.
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
확인해보세요.`;
    }
}

// 캐릭터에 맞는 인사이트 코멘트 업데이트
export async function updateInsightComment(filteredData, dateRangeText = '') {
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    
    // MEALOG 캐릭터일 때는 사용 안내 텍스트 표시 (AI 호출 안 함)
    if (currentCharacter === 'mealog') {
        const commentText = await getMealogComment();
        displayInsightText(commentText, characterName);
        return;
    }
    
    // 다른 캐릭터일 때는 기본 코멘트 표시 (Firebase에서 가져오기)
    const defaultComment = await getCharacterDefaultComment(currentCharacter);
    displayInsightText(defaultComment, characterName);
}

// 코멘트 생성 버튼 클릭 시 (COMMENT 버튼 클릭 시에만 AI 호출)
export async function generateInsightComment() {
    if (!window.getDashboardData) {
        console.error('getDashboardData 함수를 찾을 수 없습니다.');
        return;
    }
    
    const { filteredData, dateRangeText } = window.getDashboardData();
    
    // MEALOG 캐릭터일 때는 사용 안내만 표시 (AI 호출 안 함)
    if (currentCharacter === 'mealog') {
        const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
        const characterName = character ? character.name : '';
        const commentText = await getMealogComment();
        displayInsightText(commentText, characterName);
        return;
    }
    
    // 버튼 비활성화 및 로딩 상태
    const btn = document.getElementById('generateCommentBtn');
    let loadingInterval = null;
    let dotCount = 0;
    
    // 분석 시작 전에 로딩 멘트 표시
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    const loadingMessage = await getCharacterLoadingMessage(currentCharacter);
    displayInsightText(loadingMessage, characterName);
    
    if (btn) {
        btn.disabled = true;
        const originalText = btn.textContent || 'COMMENT';
        
        // 로딩 애니메이션 시작 (분석중... 점 애니메이션)
        loadingInterval = setInterval(() => {
            dotCount = (dotCount + 1) % 4; // 0~3 순환 (최대 3개 점)
            const dots = '.'.repeat(dotCount);
            btn.textContent = `분석중${dots}`;
        }, 400); // 400ms마다 업데이트
    }
    
    try {
        // AI 코멘트 생성 및 업데이트
        const comment = await getGeminiComment(filteredData, currentCharacter, dateRangeText);
        displayInsightText(comment || "멋진 식사 기록이 쌓이고 있어요! ✨", characterName);
        
        // 팝업이 열려있으면 닫기
        closeCharacterSelectModal();
    } catch (error) {
        console.error('코멘트 생성 실패:', error);
        
        // API 키 관련 에러인 경우 명확한 메시지 표시
        if (error.message && (error.message.includes('API 키') || error.message.includes('API key'))) {
            showToast(error.message, 'error');
            displayInsightText(error.message, characterName);
        } else {
            showToast('코멘트 생성 중 오류가 발생했습니다.', 'error');
        }
    } finally {
        // 로딩 애니메이션 중지
        if (loadingInterval) {
            clearInterval(loadingInterval);
        }
        
        // 버튼 활성화 및 원래 텍스트로 복원
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'COMMENT';
        }
        
        // 분석 중 메시지도 제거 (에러 발생 시에도)
        if (loadingInterval) {
            clearInterval(loadingInterval);
        }
    }
}

// 데이터 분석 및 요약 정보 생성
function analyzeMealData(filteredData, dateRangeText) {
    if (!filteredData || filteredData.length === 0) {
        return null;
    }
    
    // 식사 방식 분석
    const mealTypeCount = {};
    filteredData.forEach(meal => {
        if (meal.mealType && meal.mealType !== 'Skip') {
            mealTypeCount[meal.mealType] = (mealTypeCount[meal.mealType] || 0) + 1;
        }
    });
    const mealTypes = Object.entries(mealTypeCount)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type} ${count}회`)
        .join(', ');
    
    // 메뉴 정보 분석
    const categoryCount = {};
    const menuDetails = [];
    filteredData.forEach(meal => {
        if (meal.category) {
            categoryCount[meal.category] = (categoryCount[meal.category] || 0) + 1;
        }
        if (meal.menuDetail) {
            menuDetails.push(meal.menuDetail);
        }
    });
    const categories = Object.entries(categoryCount)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `${cat} ${count}회`)
        .join(', ');
    
    // 같이 먹은 사람 분석
    const withWhomCount = {};
    filteredData.forEach(meal => {
        const companion = meal.withWhomDetail || meal.withWhom;
        if (companion && companion !== '혼자') {
            withWhomCount[companion] = (withWhomCount[companion] || 0) + 1;
        }
    });
    const companions = Object.entries(withWhomCount)
        .sort((a, b) => b[1] - a[1])
        .map(([person, count]) => `${person} ${count}회`)
        .join(', ');
    
    // 만족도 평균
    const ratings = filteredData.filter(m => m.rating).map(m => parseInt(m.rating || 0));
    const avgRating = ratings.length > 0 
        ? (ratings.reduce((sum, r) => sum + r, 0) / ratings.length).toFixed(1)
        : null;
    
    return {
        period: dateRangeText,
        totalMeals: filteredData.length,
        mealTypes,
        categories,
        menuDetails: [...new Set(menuDetails)].slice(0, 10), // 중복 제거 후 최대 10개
        companions,
        avgRating
    };
}

// 사용 가능한 모델 목록 확인 및 캐시
let availableModels = null;

async function listAvailableModels() {
    if (availableModels) {
        return availableModels; // 캐시된 결과 반환
    }
    
    try {
        const apiKey = getApiKey();
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        // 보안: API 키가 포함된 URL은 로그에 출력하지 않음
        console.log('ListModels API 호출 중...');
        const response = await fetch(listUrl);
        
        if (response.ok) {
            const data = await response.json();
            console.log('사용 가능한 Gemini 모델 목록:', data);
            
            // generateContent를 지원하는 모델 이름 추출
            if (data.models && Array.isArray(data.models)) {
                const modelsWithGenerateContent = data.models
                    .filter(model => {
                        // supportedGenerationMethods에 generateContent가 있는지 확인
                        const methods = model.supportedGenerationMethods || [];
                        const hasGenerateContent = methods.includes('generateContent');
                        
                        // 모델 이름 체크 (tts, gemma 제외)
                        const modelName = model.name?.replace('models/', '') || '';
                        const isExcluded = modelName.toLowerCase().includes('tts') || 
                                          modelName.toLowerCase().includes('gemma');
                        
                        return hasGenerateContent && !isExcluded;
                    })
                    .map(model => model.name?.replace('models/', '') || null)
                    .filter(name => name !== null);
                
                console.log('generateContent를 지원하는 모델 (tts/gemma 제외):', modelsWithGenerateContent);
                availableModels = modelsWithGenerateContent;
                return modelsWithGenerateContent;
            }
        } else {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                errorData = { error: { message: errorText } };
            }
            
            // 에러 상세 정보 로그
            console.warn('ListModels API 오류:', {
                status: response.status,
                message: errorData.error?.message,
                reason: errorData.error?.details?.[0]?.reason,
                전체_에러: errorData
            });
            
            // API 키 문제는 나중에 사용자에게 알림
            if (response.status === 400 && errorData.error?.message?.includes('API key')) {
                // 에러는 이미 위에서 로그로 출력됨
            }
        }
    } catch (error) {
        console.error('모델 목록 조회 실패:', error);
    }
    return null;
}

// 공통 페르소나 가져오기
async function getCommonPersona() {
    try {
        const commonDocRef = doc(db, 'artifacts', appId, 'persona', 'common');
        const commonDoc = await getDoc(commonDocRef);
        
        if (commonDoc.exists()) {
            const data = commonDoc.data();
            return data.systemPrompt || '';
        }
    } catch (e) {
        console.error('공통 페르소나 가져오기 실패:', e);
    }
    return '';
}

// Gemini API를 사용하여 코멘트 생성
async function getGeminiComment(filteredData, characterId = currentCharacter, dateRangeText = '') {
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    
    // API 키 확인
    const apiKey = getApiKey();
    if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE' || apiKey.trim() === '') {
        console.error('❌ Gemini API 키가 설정되지 않았습니다.');
        const errorMessage = character 
            ? `${character.icon} API 키가 설정되지 않았습니다. js/config.js 파일에 GEMINI_API_KEY를 설정해주세요.`
            : 'API 키가 설정되지 않았습니다. js/config.js 파일에 GEMINI_API_KEY를 설정해주세요.';
        throw new Error(errorMessage);
    }
    
    // 데이터가 없을 때 기본 메시지
    if (!filteredData || filteredData.length === 0) {
        return character ? `${character.icon} 이 기간 동안 아직 식사 기록이 없네요. 맛있는 식사 기록을 시작해보세요!` : "이 기간 동안 아직 식사 기록이 없네요.";
    }
    
    try {
        // 데이터 분석
        const analysis = analyzeMealData(filteredData, dateRangeText);
        if (!analysis) {
            return character ? `${character.icon} 기록을 분석할 수 없습니다.` : "기록을 분석할 수 없습니다.";
        }
        
        // 공통 페르소나 가져오기
        const commonPersona = await getCommonPersona();
        
        // 밀당 메모 가져오기 (AI 분석 참고용)
        const userShortcuts = window.userSettings?.shortcuts || '';
        
        // 프롬프트 생성 (재미있고 캐릭터 성격 중심, 핵심만)
        const menuSummary = analysis.menuDetails.length > 0 
            ? analysis.menuDetails.slice(0, 5).join(', ') 
            : '없음';
        
        // 프롬프트 구성 (간결하고 명확하게)
        let prompt = '';
        
        // 공통 페르소나는 systemInstruction에 포함되므로 프롬프트에는 제외
        // 밀당 메모 (AI 분석 참고용)
        if (userShortcuts && userShortcuts.trim()) {
            prompt += `[밀당 메모 - 반드시 참고]\n${userShortcuts.trim()}\n\n`;
        }
        
        // 캐릭터 페르소나
        prompt += `[캐릭터 페르소나]\n당신은 ${character.name}입니다. ${character.persona}\n`;
        if (character.systemPrompt) {
            prompt += `${character.systemPrompt}\n`;
        }
        
        // 식사 데이터
        prompt += `\n[식사 데이터]\n`;
        prompt += `- 총 ${analysis.totalMeals}회 기록\n`;
        prompt += `- 식사방식: ${analysis.mealTypes || '없음'}\n`;
        prompt += `- 주요 메뉴: ${menuSummary}\n`;
        prompt += `- 함께한 사람: ${analysis.companions || '대부분 혼자'}\n`;
        if (analysis.avgRating) {
            prompt += `- 만족도 평균: ${analysis.avgRating}/5\n`;
        }
        
        // 작성 지침 (간결하게)
        prompt += `\n[작성 지침]\n`;
        if (commonPersona && commonPersona.trim()) {
            prompt += `- 공통 페르소나의 모든 지침을 반드시 적용\n`;
        }
        if (userShortcuts && userShortcuts.trim()) {
            prompt += `- 밀당 메모를 반드시 참고하여 분석 (예: 메뉴 약어 해석, 사용자 상태 고려)\n`;
        }
        prompt += `- 캐릭터 고유의 말투와 성격 드러내기\n`;
        prompt += `- 식사 패턴의 재미있는 점 우선 언급\n`;
        prompt += `- 자기 소개/기간 언급 금지\n`;
        prompt += `- 이모지 최대 2개, 한국어만 사용\n`;
        
        // 간소화된 프롬프트 정보 로그 (개발 모드에서만 상세 로그)
        const isDevMode = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        if (isDevMode) {
            console.log('📝 프롬프트 생성:', {
                공통페르소나: !!(commonPersona && commonPersona.trim()),
                밀당메모: !!(userShortcuts && userShortcuts.trim()),
                프롬프트길이: prompt.length + '자',
                프롬프트줄수: prompt.split('\n').length + '줄'
            });
        }
        
        // v1beta API만 사용 (v1은 이 모델들을 지원하지 않음)
        let lastError = null;
        let data = null;
        const apiVersion = 'v1beta'; // v1beta만 사용
        
        // 지정된 데이터 분석용 추천 모델 3개만 순차적으로 사용
        const models = GEMINI_MODELS;
        
        if (isDevMode) {
            console.log('시도할 모델 목록:', models);
        }
        
        for (const model of models) {
            try {
                const apiUrl = getGeminiApiUrl(model, apiVersion);
                if (isDevMode) {
                    console.log(`🔄 API 호출: ${model}`);
                }
                
                // API 요청 본문 구성
                const requestBody = {
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.7,
                        topK: 40,
                        topP: 0.95,
                        maxOutputTokens: 1000, // 충분한 토큰 수로 완전한 응답 보장
                        stopSequences: [], // 정지 시퀀스 제거하여 완전한 응답 보장
                    }
                };
                
                // 공통 페르소나가 있으면 system instruction으로 추가
                if (commonPersona && commonPersona.trim()) {
                    let systemInstructionText = `${commonPersona.trim()}\n\n위 공통 페르소나를 먼저 적용한 후, 사용자 프롬프트의 캐릭터별 페르소나를 추가로 적용하세요.`;
                    
                    requestBody.systemInstruction = {
                        parts: [{
                            text: systemInstructionText
                        }]
                    };
                }
                
                // 개발 모드에서만 상세 로그 출력
                if (isDevMode && model === models[0]) {
                    console.log('📤 요청 정보:', {
                        모델: model,
                        프롬프트길이: prompt.length,
                        systemInstruction: !!(requestBody.systemInstruction)
                    });
                }
                
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestBody)
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    let errorData;
                    try {
                        errorData = JSON.parse(errorText);
                    } catch (e) {
                        errorData = { error: { message: errorText } };
                    }
                    
                    // 첫 번째 모델에서만 상세 에러 로그
                    if (model === models[0] && isDevMode) {
                        console.warn(`⚠️ 모델 실패 (${model}):`, {
                            status: response.status,
                            message: errorData.error?.message
                        });
                    }
                    
                    // API 키 관련 에러
                    if (response.status === 400 && errorData.error?.message?.includes('API key')) {
                        const errorMsg = `API 키 문제: ${errorData.error.message}`;
                        console.error('❌', errorMsg);
                        lastError = new Error(errorMsg);
                        // API 키가 유효하지 않으면 다른 모델 시도하지 않고 즉시 중단
                        if (errorData.error?.message?.includes('invalid') || errorData.error?.message?.includes('Invalid')) {
                            throw new Error(`API 키가 유효하지 않습니다. js/config.js 파일의 GEMINI_API_KEY를 확인해주세요.`);
                        }
                        continue;
                    }
                    
                    // 404 (모델 없음), 429 (쿼터 초과)는 조용히 처리
                    if (response.status === 404 || response.status === 429) {
                        lastError = new Error(`API 요청 실패 (${apiVersion}/${model}): ${response.status}`);
                        continue;
                    }
                    
                    // 기타 에러
                    lastError = new Error(`API 요청 실패 (${apiVersion}/${model}): ${response.status} - ${errorData.error?.message || errorText}`);
                    continue; // 다음 모델 시도
                }
                
                const responseData = await response.json();
                if (isDevMode) {
                    console.log(`✅ API 성공: ${model}`);
                }
                
                // 응답 검증 (안전 필터 및 응답 구조 처리)
                if (responseData?.candidates && responseData.candidates.length > 0) {
                    const candidate = responseData.candidates[0];
                    
                    // 안전 필터 확인
                    if (responseData.promptFeedback) {
                        console.warn('⚠️ 안전 필터 작동:', responseData.promptFeedback);
                        lastError = new Error('안전 필터로 인해 응답이 차단됨');
                        continue; // 다음 모델 시도
                    }
                    
                    // 응답 구조 확인 (다양한 구조 지원)
                    let testComment = null;
                    const testFinishReason = candidate?.finishReason;
                    
                    // 구조 1: candidate.content.parts[0].text (일반적)
                    if (candidate?.content?.parts && candidate.content.parts.length > 0) {
                        const textPart = candidate.content.parts[0];
                        if (textPart?.text) {
                            testComment = textPart.text.trim();
                        }
                    }
                    
                    // 구조 2: candidate.text (간단한 구조)
                    if (!testComment && candidate?.text) {
                        testComment = candidate.text.trim();
                    }
                    
                    // 구조 3: candidate.output (일부 모델)
                    if (!testComment && candidate?.output) {
                        testComment = typeof candidate.output === 'string' 
                            ? candidate.output.trim() 
                            : candidate.output.text?.trim();
                    }
                    
                    // 텍스트 찾기 성공
                    if (testComment) {
                        if (isDevMode) {
                            console.log(`✅ ${model} 응답 확인:`, {
                                finishReason: testFinishReason,
                                길이: testComment.length + '자'
                            });
                        }
                        
                        // 최소 길이 체크 (50자 이상이거나 MAX_TOKENS인 경우 허용)
                        const minLength = testFinishReason === 'MAX_TOKENS' ? 30 : 50;
                        if (!testComment || testComment.length < minLength) {
                            if (isDevMode) {
                                console.warn(`⚠️ 응답이 너무 짧음: ${testComment.length}자 (최소: ${minLength}자)`);
                            }
                            lastError = new Error(`응답이 너무 짧습니다: ${testComment.length}자`);
                            continue;
                        }
                        
                        // 응답이 충분하면 이 모델 사용
                        data = responseData;
                        break; // 성공하면 반복 중단
                    } else {
                        // 텍스트를 찾지 못한 경우 - 개발 모드에서만 로깅
                        if (isDevMode) {
                            console.warn('⚠️ 응답 구조 불일치:', {
                                model: model,
                                candidateKeys: candidate ? Object.keys(candidate) : null
                            });
                        }
                        lastError = new Error('응답에 텍스트가 없음 (응답 구조 불일치)');
                        continue;
                    }
                } else {
                    // candidates가 없거나 비어있는 경우
                    console.warn('⚠️ API 응답에 candidates가 없습니다 (안전 필터 작동 가능성):', responseData);
                    
                    if (responseData.promptFeedback) {
                        lastError = new Error('안전 필터로 인해 응답이 차단됨');
                    } else {
                        lastError = new Error('응답 형식 오류 (candidates 없음)');
                    }
                    continue;
                }
                
            } catch (error) {
                console.error(`모델 ${apiVersion}/${model} 호출 중 오류:`, error);
                lastError = error;
                continue; // 다음 모델 시도
            }
        }
        
        // 모든 모델 실패 시
        if (!data) {
            // API 키 문제인지 확인
            const errorMessage = lastError?.message || '';
            if (errorMessage.includes('API key') || errorMessage.includes('API 키')) {
                throw new Error('API 키가 만료되었거나 유효하지 않습니다. 관리자에게 문의하세요.');
            }
            throw lastError || new Error('모든 Gemini 모델 호출 실패. 사용 가능한 모델 목록을 확인해주세요.');
        }
        
        // 최종 응답 처리 (안전 필터 및 응답 구조 안전하게 처리)
        let comment = null;
        const candidate = data?.candidates?.[0];
        const finishReason = candidate?.finishReason;
        
        // 다양한 응답 구조 지원
        if (candidate) {
            // 구조 1: candidate.content.parts[0].text (일반적)
            if (candidate?.content?.parts && candidate.content.parts.length > 0) {
                const textPart = candidate.content.parts[0];
                if (textPart?.text) {
                    comment = textPart.text.trim();
                }
            }
            
            // 구조 2: candidate.text (간단한 구조)
            if (!comment && candidate?.text) {
                comment = candidate.text.trim();
            }
            
            // 구조 3: candidate.output (일부 모델)
            if (!comment && candidate?.output) {
                comment = typeof candidate.output === 'string' 
                    ? candidate.output.trim() 
                    : candidate.output.text?.trim();
            }
        }
        
        // 텍스트 확인
        if (!comment) {
            // 내용이 없거나 안전 필터에 걸린 경우
            console.warn("⚠️ API 응답에 텍스트가 없습니다 (안전 필터 작동 가능성):", data);
            
            if (data?.promptFeedback) {
                throw new Error("죄송해요, 식사 기록 내용이 조금 민감해서 분석할 수 없어요. (Safety Filter)");
            }
            throw new Error("분석 결과를 가져오는데 실패했어요. (응답 형식 불일치)");
        }
        
        // comment가 있을 때 처리
        if (isDevMode) {
            console.log('✅ 최종 응답:', {
                finishReason: finishReason,
                길이: comment.length + '자'
            });
        }
        
        // MAX_TOKENS인 경우 불완전한 마지막 문장 제거
        if (finishReason === 'MAX_TOKENS' && comment.length >= 150) {
            if (isDevMode) {
                console.log('ℹ️ MAX_TOKENS - 불완전한 문장 정리 중');
            }
            // 불완전한 마지막 문장 제거
            comment = comment.replace(/[^\n가-힣a-zA-Z0-9\s.,!?]*$/, '');
            
            const lines = comment.split('\n').filter(line => line.trim());
            if (lines.length > 0) {
                const lastLine = lines[lines.length - 1];
                
                // 마지막 줄이 불완전하면 제거
                if (lastLine && !/[.!?]$/.test(lastLine.trim()) && lastLine.length < 20) {
                    lines.pop();
                    comment = lines.join('\n').trim();
                }
            }
            
            // 자연스러운 마무리
            if (comment && !/[.!?]$/.test(comment.trim())) {
                comment = comment.trim() + '!';
            }
        }
        
        // 최종 검증 (이미 루프에서 검증했지만 한 번 더)
        // MAX_TOKENS인 경우 더 관대하게 처리 (30자 이상)
        const minLength = finishReason === 'MAX_TOKENS' ? 30 : 50;
        if (!comment || comment.length < minLength) {
            throw new Error(`최종 응답이 너무 짧습니다: ${comment.length}자 (최소: ${minLength}자)`);
        }
        
        // 응답이 불완전한 것 같으면 (문장이 끝나지 않음) 경고
        const trimmedComment = comment.trim();
        if (!/[.!?]$/.test(trimmedComment)) {
            console.warn('응답이 불완전할 수 있습니다. 자연스럽게 마무리합니다.');
            // 마지막 문장이 불완전하면 마침표 추가
            if (trimmedComment.length > 30) {
                comment = trimmedComment + '.';
            }
        }
        
        // 캐릭터 아이콘 추가 (아이콘은 텍스트 앞에만 한 번)
        // 먼저 아이콘 제거 (중복 방지)
        if (character && comment.startsWith(character.icon)) {
            comment = comment.substring(character.icon.length).trim();
        }
        
        if (character && comment) {
            comment = `${character.icon} ${comment}`;
        }
        
        if (isDevMode) {
            console.log('✅ 코멘트 생성 완료:', {
                길이: comment.length + '자',
                미리보기: comment.substring(0, 80) + '...'
            });
        }
        
        return comment;
        
    } catch (error) {
        console.error('Gemini API 오류:', error);
        
        // API 키 관련 에러인 경우 명확한 메시지 표시
        if (error.message && (error.message.includes('API 키') || error.message.includes('API key'))) {
            throw error; // 상위로 전달하여 사용자에게 표시
        }
        
        // 오류 발생 시 기본 메시지 반환
        const fallbackMessage = character 
            ? `${character.icon} 이 기간 동안 ${filteredData.length}회의 식사 기록이 있네요! 계속 좋은 식습관을 유지해주세요!`
            : `이 기간 동안 ${filteredData.length}회의 식사 기록이 있네요!`;
        
        return fallbackMessage;
    }
}

// 현재 선택된 캐릭터 반환 (다른 모듈에서 사용)
export function getCurrentCharacter() {
    return currentCharacter;
}

// INSIGHT_CHARACTERS 반환 (최신 목록 가져오기)
export async function getInsightCharacters() {
    await loadCharactersFromFirebase();
    return INSIGHT_CHARACTERS;
}

// 인사이트 공유 상태 확인
async function checkInsightShareStatus(dateRangeText) {
    if (!window.currentUser || !window.sharedPhotos) return null;
    
    // window.sharedPhotos에서 해당 기간의 인사이트 공유 찾기
    // 각 기간별로 한 번만 공유 가능하므로 dateRangeText만으로 확인
    const insightShare = window.sharedPhotos.find(photo => 
        photo.type === 'insight' && 
        photo.dateRangeText === dateRangeText
    );
    
    return insightShare || null;
}

// 공유 버튼 상태 업데이트 함수
export async function updateShareButtonStatus() {
    const shareBtn = document.getElementById('shareInsightBtn');
    if (!shareBtn) return;
    
    // MEALOG 캐릭터가 아니고 코멘트가 있을 때만 표시
    const insightTextContent = document.getElementById('insightTextContent');
    if (currentCharacter === 'mealog' || !insightTextContent || !insightTextContent.textContent || insightTextContent.textContent.trim() === '') {
        shareBtn.classList.add('hidden');
        return;
    }
    
    shareBtn.classList.remove('hidden');
    
    // 공유 상태 확인
    if (window.getDashboardData) {
        const { dateRangeText } = window.getDashboardData();
        const existingShare = await checkInsightShareStatus(dateRangeText);
        const isShared = !!existingShare;
        
        if (isShared) {
            // 공유됨 상태: 버튼 박스 표시 (배경색만, 보더 없음)
            shareBtn.innerHTML = '<i class="fa-solid fa-share text-[10px] mr-1"></i>공유됨';
            shareBtn.className = 'flex-shrink-0 bg-emerald-600 rounded-lg font-bold text-[10px] shadow-md active:bg-emerald-700 transition-colors py-1 px-2 text-white';
        } else {
            // 공유 안 됨 상태: 버튼 박스 제거 (텍스트만 표시)
            shareBtn.innerHTML = '<i class="fa-solid fa-share text-[10px] mr-1"></i>공유하기';
            shareBtn.className = 'flex-shrink-0 font-bold text-[10px] text-emerald-600 hover:text-emerald-700 transition-colors py-1 px-2';
        }
    }
}

// 밀당 코멘트 공유 모달 열기
export async function openShareInsightModal() {
    const modal = document.getElementById('insightShareModal');
    const preview = document.getElementById('insightSharePreview');
    if (!modal || !preview) return;
    
    // 코멘트가 있는지 확인
    const insightTextContent = document.getElementById('insightTextContent');
    if (!insightTextContent || !insightTextContent.textContent || insightTextContent.textContent.trim() === '') {
        showToast('공유할 코멘트가 없습니다. COMMENT 버튼을 눌러 코멘트를 생성해주세요.', 'error');
        return;
    }
    
    // 현재 기간 정보 가져오기
    if (!window.getDashboardData) {
        showToast('대시보드 데이터를 가져올 수 없습니다.', 'error');
        return;
    }
    
    const { dateRangeText } = window.getDashboardData();
    
    // 공유 상태 확인
    const existingShare = await checkInsightShareStatus(dateRangeText);
    const isShared = !!existingShare;
    
    // 사용자 닉네임 및 아이콘 가져오기
    const userNickname = window.userSettings?.profile?.nickname || '익명';
    const userIcon = window.userSettings?.profile?.icon || '🐻';
    
    // 현재 선택된 캐릭터 정보
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    const characterIcon = character ? (character.icon || '') : '';
    
    // 인사이트 박스 내용 가져오기 (innerHTML 사용하여 줄바꿈 유지)
    const insightBubble = document.getElementById('insightBubble');
    const insightCharacterName = document.getElementById('insightCharacterName');
    const insightCharacterIcon = document.getElementById('insightCharacterIcon');
    const insightText = insightTextContent.innerHTML || insightTextContent.textContent || '';
    const characterNameText = insightCharacterName ? insightCharacterName.textContent : '';
    
    // 캐릭터 아이콘 HTML 가져오기
    let characterIconHtml = '';
    if (insightCharacterIcon) {
        if (character.image) {
            characterIconHtml = `<img src="${escapeHtml(character.image)}" alt="${escapeHtml(characterName)}" style="width: 100%; height: 100%; object-fit: contain;">`;
        } else if (character.id === 'mealog') {
            characterIconHtml = `<div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 900; color: white;">M</div>`;
        } else {
            characterIconHtml = `<div style="width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 32px;">${escapeHtml(characterIcon)}</div>`;
        }
    }
    
    // 스크린샷용 HTML 생성 (실제 화면과 동일한 구조 및 색상)
    const screenshotHtml = `
        <div id="insightScreenshotContainer" style="width: 448px; max-width: 448px; margin: 0 auto; background: #f8fafc; border-radius: 8px; overflow: hidden; font-family: Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <!-- 헤더 (밀로그 그린 배경) -->
            <div style="background: #059669; padding: 16px; border-bottom: 1px solid #047857;">
                <!-- 상단: MEALOG와 기간 -->
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-size: 28.8px; font-weight: 600; color: #ffffff; font-family: 'Fredoka', sans-serif; letter-spacing: -0.5px; text-transform: lowercase;">mealog</span>
                    <span style="font-size: 12px; font-weight: 400; color: #d1fae5; flex-shrink: 0;">${escapeHtml(dateRangeText || '')}</span>
                </div>
                <!-- 하단: 밀당(MEAL-DANG)들의 참견 -->
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 16px;">${escapeHtml(characterIcon)}</span>
                    <span style="font-size: 15px; font-weight: 700; color: #ffffff;">밀당(MEAL-DANG)들의 참견</span>
                </div>
            </div>
            
            <!-- 인사이트 섹션 (초록색 배경) -->
            <div style="background: #059669; padding: 12px 16px;">
                <!-- 캐릭터와 말풍선 영역 -->
                <div style="display: flex; gap: 12px; align-items: flex-start;">
                    <!-- 밀당 캐릭터 선택 창 -->
                    <div style="display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; width: 75px;">
                        <div style="width: 75px; height: 164px; background: rgba(255, 255, 255, 0.2); border-radius: 16px; border: 2px solid rgba(255, 255, 255, 0.3); display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden;">
                            ${characterIconHtml}
                        </div>
                        <div style="width: 75px; height: auto; background: #fbbf24; border-radius: 12px; padding: 4px; text-align: center; font-size: 10px; font-weight: 700; color: #3E2723; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                            COMMENT
                        </div>
                    </div>
                    
                    <!-- 말풍선 -->
                    <div style="flex: 1; min-width: 0;">
                        <div style="background: rgba(254, 252, 232, 0.9); border: 2px solid white; padding: 12px; border-radius: 0.5rem 1.25rem 1.25rem 0.5rem; min-height: 164px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                                ${characterNameText ? `<div style="font-size: 14px; font-weight: 800; color: #065f46;">${escapeHtml(characterNameText)}</div>` : '<div></div>'}
                                <div style="flex-shrink: 0; background: #059669; border-radius: 8px; padding: 4px 8px; font-size: 10px; font-weight: 700; color: white; border: 1px solid #047857; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                    <i class="fa-solid fa-share" style="font-size: 10px; margin-right: 4px;"></i>공유
                                </div>
                            </div>
                            <div style="font-size: 14px; line-height: 1.6; color: #1e293b; font-weight: 400; white-space: pre-line; word-wrap: break-word; overflow-wrap: break-word;">
                                ${insightText}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // 미리보기 영역에 HTML 표시
    preview.innerHTML = screenshotHtml;
    
    // 모달 열기
    modal.classList.remove('hidden');
    
    // Comment 초기화 또는 기존 코멘트 표시
    const commentInput = document.getElementById('insightShareComment');
    if (commentInput) {
        if (isShared && existingShare.comment) {
            commentInput.value = existingShare.comment;
        } else {
            commentInput.value = '';
        }
    }
    
    // 공유 버튼 텍스트 업데이트
    const submitBtn = document.getElementById('insightShareSubmitBtn');
    if (submitBtn) {
        if (isShared) {
            submitBtn.textContent = '공유 취소';
            submitBtn.className = 'w-full py-4 bg-red-600 text-white rounded-xl font-bold active:bg-red-700 shadow-lg transition-all';
        } else {
            submitBtn.textContent = '공유하기';
            submitBtn.className = 'w-full py-4 bg-emerald-600 text-white rounded-xl font-bold active:bg-emerald-700 shadow-lg transition-all';
        }
    }
}

// 밀당 코멘트 공유 수정 모달 열기 (photoUrl로 찾기)
export async function openEditInsightShareModal(photoUrl) {
    if (!photoUrl || !window.sharedPhotos) {
        showToast('밀당 코멘트 공유를 찾을 수 없습니다.', 'error');
        return;
    }
    
    // window.sharedPhotos에서 해당 photoUrl의 인사이트 공유 찾기
    const insightShare = window.sharedPhotos.find(photo => 
        photo.type === 'insight' && 
        (photo.photoUrl === photoUrl || photo.photoUrl?.includes(photoUrl) || photoUrl?.includes(photo.photoUrl))
    );
    
    if (!insightShare) {
        showToast('밀당 코멘트 공유를 찾을 수 없습니다.', 'error');
        return;
    }
    
    const modal = document.getElementById('insightShareModal');
    const preview = document.getElementById('insightSharePreview');
    if (!modal || !preview) return;
    
    // 기존 이미지 사용
    const existingImageHtml = insightShare.photoUrl ? `
        <div id="insightScreenshotContainer" style="width: 448px; max-width: 448px; margin: 0 auto; background: #f8fafc; border-radius: 8px; overflow: hidden; font-family: Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
            <div style="text-align: center;">
                <img src="${insightShare.photoUrl}" style="max-width: 100%; height: auto; display: block; margin: 0 auto;" alt="밀당 코멘트 공유 이미지">
            </div>
        </div>
    ` : '<div style="text-align: center; padding: 40px; color: #94a3b8;">이미지를 불러올 수 없습니다.</div>';
    
    preview.innerHTML = existingImageHtml;
    
    // 모달 열기
    modal.classList.remove('hidden');
    
    // Comment 초기화 또는 기존 코멘트 표시
    const commentInput = document.getElementById('insightShareComment');
    if (commentInput) {
        commentInput.value = insightShare.comment || '';
    }
    
    // 공유 버튼 텍스트 업데이트 (수정 모드)
    const submitBtn = document.getElementById('insightShareSubmitBtn');
    if (submitBtn) {
        submitBtn.textContent = '수정 완료';
        submitBtn.className = 'w-full py-4 bg-emerald-600 text-white rounded-xl font-bold active:bg-emerald-700 shadow-lg transition-all';
        // 수정 모드임을 표시하기 위한 데이터 속성 추가
        submitBtn.setAttribute('data-edit-mode', 'true');
        submitBtn.setAttribute('data-photo-url', photoUrl);
    }
}

// 밀당 코멘트 공유 모달 닫기
export function closeShareInsightModal() {
    const modal = document.getElementById('insightShareModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 밀당 코멘트를 피드에 공유하기
export async function shareInsightToFeed() {
    const preview = document.getElementById('insightScreenshotContainer');
    const commentInput = document.getElementById('insightShareComment');
    const submitBtn = document.getElementById('insightShareSubmitBtn');
    
    if (!commentInput || !preview) return;
    
    const comment = commentInput.value.trim();
    
    // 수정 모드 확인
    const isEditMode = submitBtn && submitBtn.getAttribute('data-edit-mode') === 'true';
    const editPhotoUrl = isEditMode ? submitBtn.getAttribute('data-photo-url') : null;
    
    // 현재 기간 정보 가져오기
    if (!window.getDashboardData) {
        showToast('대시보드 데이터를 가져올 수 없습니다.', 'error');
        return;
    }
    
    const { dateRangeText } = window.getDashboardData();
    
    // 공유 상태 확인
    const existingShare = await checkInsightShareStatus(dateRangeText);
    
    if (isEditMode && editPhotoUrl) {
        // 수정 모드: 코멘트만 업데이트
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '수정 중...';
        }
        
        try {
            // Firestore에서 해당 인사이트 공유 문서 찾아서 업데이트
            const { collection, query, where, getDocs, updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
            const { db: firestoreDb, appId } = await import('../firebase.js');
            const sharedColl = collection(firestoreDb, 'artifacts', appId, 'sharedPhotos');
            
            // photoUrl로 문서 찾기 (유연한 매칭)
            const q = query(sharedColl, where('userId', '==', window.currentUser.uid), where('type', '==', 'insight'));
            const querySnapshot = await getDocs(q);
            
            let foundDoc = null;
            for (const docSnap of querySnapshot.docs) {
                const data = docSnap.data();
                const docPhotoUrl = data.photoUrl || '';
                if (docPhotoUrl === editPhotoUrl || docPhotoUrl.includes(editPhotoUrl) || editPhotoUrl.includes(docPhotoUrl)) {
                    foundDoc = docSnap;
                    break;
                }
            }
            
            if (foundDoc) {
                await updateDoc(doc(sharedColl, foundDoc.id), {
                    comment: comment
                });
                
                // window.sharedPhotos 업데이트
                if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                    const shareIndex = window.sharedPhotos.findIndex(photo => 
                        photo.type === 'insight' && 
                        (photo.photoUrl === editPhotoUrl || photo.photoUrl?.includes(editPhotoUrl) || editPhotoUrl?.includes(photo.photoUrl))
                    );
                    if (shareIndex !== -1) {
                        window.sharedPhotos[shareIndex].comment = comment;
                    }
                }
                
                showToast('밀당 코멘트 공유가 수정되었습니다!', 'success');
                closeShareInsightModal();
                
                // 갤러리/피드 새로고침
                if (appState.currentTab === 'gallery') {
                    const { renderGallery } = await import('../render/index.js');
                    renderGallery();
                } else if (appState.currentTab === 'feed') {
                    const { renderFeed } = await import('../render/index.js');
                    renderFeed();
                }
            } else {
                showToast('밀당 코멘트 공유를 찾을 수 없습니다.', 'error');
            }
        } catch (e) {
            console.error('인사이트 공유 수정 실패:', e);
            showToast('인사이트 공유 수정 중 오류가 발생했습니다.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '수정 완료';
                submitBtn.removeAttribute('data-edit-mode');
                submitBtn.removeAttribute('data-photo-url');
            }
        }
        return;
    }
    
    if (existingShare) {
        // 이미 공유된 경우: 공유 취소
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = '취소 중...';
        }
        
        try {
            await dbOps.unsharePhotos([existingShare.photoUrl], null, false, false);
            showToast('공유가 취소되었습니다.', 'success');
            closeShareInsightModal();
            
            // 공유 버튼 상태 업데이트
            await updateShareButtonStatus();
            
            // 갤러리/피드 새로고침
            if (appState.currentTab === 'gallery') {
                const { renderGallery } = await import('../render/index.js');
                renderGallery();
            } else if (appState.currentTab === 'feed') {
                const { renderFeed } = await import('../render/index.js');
                renderFeed();
            }
        } catch (e) {
            console.error('인사이트 공유 취소 실패:', e);
            showToast('공유 취소 중 오류가 발생했습니다.', 'error');
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = '공유하기';
            }
        }
        return;
    }
    
    // 공유되지 않은 경우: 공유하기
    // 로딩 상태
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = '공유 중...';
    }
    
    try {
        // html2canvas가 전역에 있는지 확인
        const html2canvasFunc = (typeof window !== 'undefined' && window.html2canvas) || (typeof html2canvas !== 'undefined' ? html2canvas : null);
        
        if (!html2canvasFunc) {
            throw new Error('html2canvas를 찾을 수 없습니다. HTML에 html2canvas 라이브러리가 로드되었는지 확인하세요.');
        }
        
        // 스크린샷 생성
        const canvas = await html2canvasFunc(preview, {
            backgroundColor: '#ffffff',
            scale: 2,
            logging: false,
            useCORS: true,
            allowTaint: true
        });
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
        
        // base64로 저장
        const base64Image = canvas.toDataURL('image/png');
        
        const userProfile = window.userSettings?.profile || {};
        const insightShareData = {
            photoUrl: base64Image,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            userPhotoUrl: userProfile.photoUrl || null,
            type: 'insight',
            dateRangeText: dateRangeText,
            comment: comment,
            timestamp: new Date().toISOString(),
            entryId: null // 인사이트 공유는 entryId가 없음
        };
        
        // Firestore에 저장
        const { collection, addDoc } = await import("https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js");
        const { db: firestoreDb, appId } = await import('../firebase.js');
        const sharedColl = collection(firestoreDb, 'artifacts', appId, 'sharedPhotos');
        await addDoc(sharedColl, insightShareData);
        
        showToast('밀당(MEAL-DANG)들의 참견이 피드에 공유되었습니다!', 'success');
        closeShareInsightModal();
        
        // 공유 버튼 상태 업데이트
        await updateShareButtonStatus();
        
        // 갤러리/피드 새로고침
        if (appState.currentTab === 'gallery') {
            const { renderGallery } = await import('../render/index.js');
            renderGallery();
        } else if (appState.currentTab === 'feed') {
            const { renderFeed } = await import('../render/index.js');
            renderFeed();
        }
        
    } catch (e) {
        console.error('인사이트 공유 실패:', e);
        showToast('인사이트 공유 중 오류가 발생했습니다.', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '공유하기';
        }
    }
}

