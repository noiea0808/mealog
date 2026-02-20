// 인사이트 코멘트 관련 함수들
import { SLOTS, SATIETY_DATA, MEALOG_ICON_URL } from '../constants.js';
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { dbOps } from '../db.js';
import { GEMINI_API_KEY as DEFAULT_API_KEY } from '../config.default.js';
import { db, appId, callableFunctions } from '../firebase.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { captureWithGhostStrategy, toLocalDateString } from '../utils.js';
import { getWeekRange } from './date-utils.js';

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
            
            // Firebase에서 추가된 캐릭터들 추가 (기본 캐릭터와 중복되지 않는 것만, 관리자 화면과 동일하게 id 순 정렬)
            Object.entries(charactersData)
                .filter(([id]) => !DEFAULT_CHARACTERS.find(c => c.id === id))
                .sort(([a], [b]) => a.localeCompare(b))
                .forEach(([id, charData]) => {
                    loadedCharacters.push({
                        id,
                        name: charData.name || id,
                        icon: charData.icon || '👤',
                        image: charData.image || null,
                        persona: '', // 나중에 개별 문서에서 가져올 예정
                        systemPrompt: '' // 나중에 개별 문서에서 가져올 예정
                    });
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
                            if (personaData.name) char.name = personaData.name;
                            if (personaData.image !== undefined) char.image = personaData.image || null;
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
// 현재 말풍선 텍스트가 COMMENT 분석 결과인지 (캐릭터만 선택한 기본/안내 문구가 아님)
let currentInsightIsAnalysisResult = false;

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
    
    // 공유 버튼은 분석 결과일 때만 표시 (displayInsightText 호출 전에 currentInsightIsAnalysisResult 설정됨)
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
            // MEALOG 스마트폰용 밀로그 아이콘
            iconHtml = `<div class="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center overflow-hidden flex-shrink-0"><img src="${MEALOG_ICON_URL}" alt="MEALOG" class="w-full h-full object-contain" onerror="this.style.display='none';this.nextElementSibling?.classList.remove('hidden');"><span class="hidden text-emerald-700 font-black text-lg">M</span></div>`;
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
            iconEl.innerHTML = `<img src="${character.image}" alt="${character.name}" class="w-full h-full object-cover">`;
            iconEl.className = 'w-full h-full flex items-center justify-center';
        } else if (character.id === 'mealog') {
            // MEALOG는 스마트폰용 밀로그 아이콘 이미지 (70x70 정사각형)
            iconEl.innerHTML = `<div class="insight-character-icon-box w-[70px] h-[70px] flex items-center justify-center overflow-hidden rounded-2xl flex-shrink-0"><img src="${MEALOG_ICON_URL}" alt="MEALOG" class="w-full h-full object-contain" onerror="this.style.display='none';this.nextElementSibling?.classList.remove('hidden');"><span class="hidden text-2xl font-black mealog-character-m text-white">M</span></div>`;
            iconEl.className = 'w-full h-full flex items-center justify-center mealog-character-m';
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
    
    // 캐릭터 선택/기본 문구는 분석 결과가 아니므로 공유 버튼 숨김
    currentInsightIsAnalysisResult = false;
    
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
        currentInsightIsAnalysisResult = false;
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
    
    // 분석 시작 전에 로딩 멘트 표시 (분석 결과 아님)
    currentInsightIsAnalysisResult = false;
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    const loadingMessage = await getCharacterLoadingMessage(currentCharacter);
    displayInsightText(loadingMessage, characterName);
    
    if (btn) {
        btn.disabled = true;
        const originalText = btn.textContent || '코멘트';
        
        // 로딩 애니메이션 시작 (분석중... 점 애니메이션)
        loadingInterval = setInterval(() => {
            dotCount = (dotCount + 1) % 4; // 0~3 순환 (최대 3개 점)
            const dots = '.'.repeat(dotCount);
            btn.textContent = `분석중${dots}`;
        }, 400); // 400ms마다 업데이트
    }
    
    try {
        // 기간 경과/기록 부족 시 AI 호출 없이 관리자 설정 멘트 표시 (분석 결과가 아니므로 공유 버튼 숨김)
        const reason = !filteredData || filteredData.length === 0 ? 'insufficient_records' : getInsufficientReason(filteredData);
        if (reason) {
            currentInsightIsAnalysisResult = false;
            const fallback = await getInsightFallbackMessages(currentCharacter);
            const text = reason === 'insufficient_period' ? fallback.insufficientPeriod : fallback.insufficientRecords;
            displayInsightText(text || "멋진 식사 기록이 쌓이고 있어요! ✨", characterName);
            closeCharacterSelectModal();
            return;
        }

        // AI 코멘트 생성 및 업데이트 (분석 결과이므로 공유 버튼 표시)
        currentInsightIsAnalysisResult = true;
        const comment = await getGeminiComment(filteredData, currentCharacter, dateRangeText);
        displayInsightText(comment || "멋진 식사 기록이 쌓이고 있어요! ✨", characterName);
        
        // 팝업이 열려있으면 닫기
        closeCharacterSelectModal();
    } catch (error) {
        console.error('코멘트 생성 실패:', error);
        currentInsightIsAnalysisResult = false;
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
            btn.textContent = '코멘트';
        }
        
        // 분석 중 메시지도 제거 (에러 발생 시에도)
        if (loadingInterval) {
            clearInterval(loadingInterval);
        }
    }
}

// 점수별 횟수 집계 (만족도 1~5점)
function countByScore(records, field) {
    const count = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    records.forEach(m => {
        const v = parseInt(m[field] || 0);
        if (v >= 1 && v <= 5) count[v]++;
    });
    return Object.entries(count)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([score, n]) => `${score}점 ${n}회`)
        .join(', ') || '없음';
}

// 포만감 점수별 횟수 (1=배고픔~5=과식 라벨 포함)
function countSatietyByScore(records) {
    const count = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    records.forEach(m => {
        const v = parseInt(m.satiety || 0);
        if (v >= 1 && v <= 5) count[v]++;
    });
    const labelMap = Object.fromEntries(SATIETY_DATA.map(d => [d.val, d.label]));
    return Object.entries(count)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([score, n]) => `${score}점(${labelMap[score] || ''}) ${n}회`)
        .join(', ') || '없음';
}

// 데이터 분석 및 요약 정보 생성 (본식/간식 분리)
function analyzeMealData(filteredData, dateRangeText) {
    if (!filteredData || filteredData.length === 0) {
        return null;
    }
    
    const mainMeals = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
        return slot;
    });
    const snacks = filteredData.filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'snack');
        return slot;
    });
    
    // 본식 분석
    const mealTypeCount = {};
    const categoryCount = {};
    const menuDetails = [];
    const withWhomCount = {};
    mainMeals.forEach(meal => {
        if (meal.mealType && meal.mealType !== 'Skip') {
            mealTypeCount[meal.mealType] = (mealTypeCount[meal.mealType] || 0) + 1;
        }
        if (meal.category) {
            categoryCount[meal.category] = (categoryCount[meal.category] || 0) + 1;
        }
        if (meal.menuDetail) menuDetails.push(meal.menuDetail);
        const companion = meal.withWhomDetail || meal.withWhom;
        if (companion && companion !== '혼자') {
            withWhomCount[companion] = (withWhomCount[companion] || 0) + 1;
        }
    });
    
    const main = {
        count: mainMeals.length,
        mealTypes: Object.entries(mealTypeCount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}회`).join(', ') || '없음',
        categories: Object.entries(categoryCount).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}회`).join(', ') || '없음',
        menuDetails: [...new Set(menuDetails)].slice(0, 10),
        companions: Object.entries(withWhomCount).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}회`).join(', ') || '대부분 혼자',
        ratingByScore: countByScore(mainMeals, 'rating'),
        satietyByScore: countSatietyByScore(mainMeals),
        avgRating: null,
        avgSatiety: null
    };
    const mainRatings = mainMeals.filter(m => m.rating).map(m => parseInt(m.rating || 0));
    const mainSatiety = mainMeals.filter(m => m.satiety).map(m => parseInt(m.satiety || 0));
    if (mainRatings.length) main.avgRating = (mainRatings.reduce((a, b) => a + b, 0) / mainRatings.length).toFixed(1);
    if (mainSatiety.length) main.avgSatiety = (mainSatiety.reduce((a, b) => a + b, 0) / mainSatiety.length).toFixed(1);
    
    // 간식 분석
    const snackTypeCount = {};
    const snackPlaceCount = {};
    snacks.forEach(meal => {
        const st = meal.snackType || meal.category;
        if (st) snackTypeCount[st] = (snackTypeCount[st] || 0) + 1;
        const pl = meal.place;
        if (pl) snackPlaceCount[pl] = (snackPlaceCount[pl] || 0) + 1;
    });
    
    const snack = {
        count: snacks.length,
        snackTypes: Object.entries(snackTypeCount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}회`).join(', ') || '없음',
        places: Object.entries(snackPlaceCount).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}회`).join(', ') || '없음',
        ratingByScore: countByScore(snacks, 'rating'),
        satietyByScore: countSatietyByScore(snacks),
        avgRating: null,
        avgSatiety: null
    };
    const snackRatings = snacks.filter(m => m.rating).map(m => parseInt(m.rating || 0));
    const snackSatiety = snacks.filter(m => m.satiety).map(m => parseInt(m.satiety || 0));
    if (snackRatings.length) snack.avgRating = (snackRatings.reduce((a, b) => a + b, 0) / snackRatings.length).toFixed(1);
    if (snackSatiety.length) snack.avgSatiety = (snackSatiety.reduce((a, b) => a + b, 0) / snackSatiety.length).toFixed(1);
    
    // 시간대별 분석 (아침/점심/저녁, 아침전간식/오전간식/오후간식/야식)
    const slotLabelMap = Object.fromEntries(SLOTS.map(s => [s.id, s.label]));
    const bySlot = {};
    SLOTS.forEach(slot => {
        const recs = filteredData.filter(m => m.slotId === slot.id);
        if (recs.length === 0) return;
        const isMain = slot.type === 'main';
        const mealTypeCountS = {};
        const categoryCountS = {};
        const snackTypeCountS = {};
        const placeCountS = {};
        const menuDetailsS = [];
        const withWhomCountS = {};
        recs.forEach(meal => {
            if (isMain) {
                if (meal.mealType && meal.mealType !== 'Skip') mealTypeCountS[meal.mealType] = (mealTypeCountS[meal.mealType] || 0) + 1;
                if (meal.category) categoryCountS[meal.category] = (categoryCountS[meal.category] || 0) + 1;
                if (meal.menuDetail) menuDetailsS.push(meal.menuDetail);
                const c = meal.withWhomDetail || meal.withWhom;
                if (c && c !== '혼자') withWhomCountS[c] = (withWhomCountS[c] || 0) + 1;
            } else {
                const st = meal.snackType || meal.category;
                if (st) snackTypeCountS[st] = (snackTypeCountS[st] || 0) + 1;
                if (meal.place) placeCountS[meal.place] = (placeCountS[meal.place] || 0) + 1;
            }
        });
        const entry = {
            count: recs.length,
            label: slotLabelMap[slot.id] || slot.id
        };
        if (isMain) {
            entry.mealTypes = Object.entries(mealTypeCountS).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}회`).join(', ') || '없음';
            entry.categories = Object.entries(categoryCountS).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}회`).join(', ') || '없음';
            entry.menuDetails = [...new Set(menuDetailsS)].slice(0, 5);
            entry.companions = Object.keys(withWhomCountS).length ? Object.entries(withWhomCountS).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}회`).join(', ') : '대부분 혼자';
        } else {
            entry.snackTypes = Object.entries(snackTypeCountS).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}회`).join(', ') || '없음';
            entry.places = Object.entries(placeCountS).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}회`).join(', ') || '없음';
        }
        entry.ratingByScore = countByScore(recs, 'rating');
        entry.satietyByScore = countSatietyByScore(recs);
        bySlot[slot.id] = entry;
    });
    
    return {
        period: dateRangeText,
        totalMeals: filteredData.length,
        main,
        snack,
        bySlot
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

/** 기간 경과/기록 부족 여부 판정. 'insufficient_period' | 'insufficient_records' | null */
function getInsufficientReason(filteredData) {
    const state = appState;
    const mode = state.dashboardMode;
    const today = new Date();
    const todayStr = toLocalDateString(today);

    let rangeStart, rangeEnd, elapsedDays, totalPeriodDays;
    if (mode === '7d') {
        const start = state.recentWeekStartDate || (() => { const d = new Date(today); d.setDate(d.getDate() - 6); return d; })();
        rangeStart = new Date(start);
        rangeEnd = new Date(today);
        rangeStart.setHours(0, 0, 0, 0);
        rangeEnd.setHours(23, 59, 59, 999);
        totalPeriodDays = 7;
        elapsedDays = Math.floor((rangeEnd - rangeStart) / 86400000) + 1;
        // 최근 1주: 기간 경과 부족 해당 없음
    } else if (mode === 'week') {
        const { start, end } = getWeekRange(state.selectedYear, state.selectedMonthForWeek, state.selectedWeek);
        rangeStart = new Date(start);
        rangeEnd = new Date(end);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        totalPeriodDays = 7;
        elapsedDays = effectiveEnd < rangeStart ? 0 : Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
        if (elapsedDays < 4) return 'insufficient_period';
    } else if (mode === 'month') {
        const [y, m] = state.selectedMonth.split('-').map(Number);
        rangeStart = new Date(y, m - 1, 1);
        rangeEnd = new Date(y, m, 0);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        totalPeriodDays = rangeEnd.getDate();
        elapsedDays = effectiveEnd < rangeStart ? 0 : Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
        if (elapsedDays < 10) return 'insufficient_period';
    } else if (mode === 'year') {
        const year = state.selectedYearForYear || today.getFullYear();
        rangeStart = new Date(year, 0, 1);
        rangeEnd = new Date(year, 11, 31);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        const aprilFirst = new Date(year, 3, 1);
        if (effectiveEnd < aprilFirst) return 'insufficient_period';
        totalPeriodDays = 365 + (new Date(year, 1, 29).getMonth() === 1 ? 1 : 0);
        elapsedDays = Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
    } else if (mode === 'custom') {
        rangeStart = new Date(state.customStartDate);
        rangeEnd = new Date(state.customEndDate);
        const effectiveEnd = rangeEnd > today ? today : rangeEnd;
        totalPeriodDays = Math.floor((rangeEnd - rangeStart) / 86400000) + 1;
        elapsedDays = effectiveEnd < rangeStart ? 0 : Math.floor((effectiveEnd - rangeStart) / 86400000) + 1;
        if (totalPeriodDays > 0 && elapsedDays / totalPeriodDays < 0.5) return 'insufficient_period';
    } else {
        return null;
    }

    // 기록 부족: 경과 기간의 본식 슬롯 대비 50% 미만 기록 (간식 제외)
    const mainMealCount = (filteredData || []).filter(m => {
        const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
        return slot && m.mealType !== 'Skip';
    }).length;
    const elapsedMainSlots = Math.max(1, elapsedDays) * 3;
    if (mainMealCount / elapsedMainSlots < 0.5) return 'insufficient_records';
    return null;
}

/** 관리자 설정 밀당 안내 멘트 (캐릭터별, 기간 경과 부족 / 기록 부족) */
const DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_PERIOD = '아직 이 기간이 충분히 경과하지 않았어요. 조금 더 지나면 더 의미 있는 코멘트를 드릴 수 있어요.';
const DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_RECORDS = '이 기간의 식사 기록이 아직 충분하지 않아요. 조금 더 기록해 보시면 더 재미있는 코멘트를 드릴 수 있어요.';

async function getInsightFallbackMessages(characterId) {
    if (!characterId) {
        return {
            insufficientPeriod: DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_PERIOD,
            insufficientRecords: DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_RECORDS
        };
    }
    try {
        const personaDocRef = doc(db, 'artifacts', appId, 'persona', characterId);
        const personaDoc = await getDoc(personaDocRef);
        if (personaDoc.exists()) {
            const data = personaDoc.data();
            return {
                insufficientPeriod: (data.insightMessageInsufficientPeriod || '').trim() || DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_PERIOD,
                insufficientRecords: (data.insightMessageInsufficientRecords || '').trim() || DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_RECORDS
            };
        }
    } catch (e) {
        console.error('밀당 안내 멘트 가져오기 실패:', e);
    }
    return {
        insufficientPeriod: DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_PERIOD,
        insufficientRecords: DEFAULT_INSIGHT_MESSAGE_INSUFFICIENT_RECORDS
    };
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
        
        // 본식 기록 비율 (밀당 박스 기준: 본식만, days*3 대비)
        const dashData = typeof window.getDashboardData === 'function' ? window.getDashboardData() : null;
        const days = dashData?.days ?? 1;
        const targetDays = Math.max(1, days);
        const totalMainSlots = targetDays * 3;
        const mainMealCount = filteredData.filter(m => {
            const slot = SLOTS.find(s => s.id === m.slotId && s.type === 'main');
            return slot && m.mealType !== 'Skip';
        }).length;
        const mealRecordPercent = totalMainSlots > 0 ? Math.round((mainMealCount / totalMainSlots) * 100) : 0;
        
        // 공통 페르소나 가져오기
        const commonPersona = await getCommonPersona();
        
        // 밀당 메모 가져오기 (AI 분석 참고용)
        const userShortcuts = window.userSettings?.shortcuts || '';
        const userNickname = (window.userSettings?.profile?.nickname || '').trim() || '사용자';
        
        // 프롬프트 구성 (간결하고 명확하게)
        let prompt = '';
        
        // 사용자 닉네임 (코멘트에서 사용자 부를 때 사용)
        prompt += `[대상 사용자]\n이름(닉네임): ${userNickname.replace(/\n/g, ' ')}\n\n`;
        
        // 공통 페르소나는 systemInstruction에 포함, 밀당 메모는 프롬프트에 포함 (둘 다 분석 요청에 사용됨)
        if (userShortcuts && userShortcuts.trim()) {
            prompt += `[밀당 메모 - 반드시 참고]\n${userShortcuts.trim()}\n\n`;
        }
        
        // 캐릭터 페르소나
        prompt += `[캐릭터 페르소나]\n당신은 ${character.name}입니다. ${character.persona}\n`;
        if (character.systemPrompt) {
            prompt += `${character.systemPrompt}\n`;
        }
        
        // 식사 데이터 (시간대별로만 전송 - 본식/간식 통합, 중복 제거)
        prompt += `\n[식사 데이터]\n`;
        prompt += `- 본식 기록 비율: ${mainMealCount}회 / ${totalMainSlots}회 (${mealRecordPercent}%)\n`;
        if (analysis.bySlot && Object.keys(analysis.bySlot).length > 0) {
            const slotOrder = ['pre_morning', 'morning', 'snack1', 'lunch', 'snack2', 'dinner', 'night'];
            slotOrder.forEach(slotId => {
                const s = analysis.bySlot[slotId];
                if (!s) return;
                prompt += `\n- ${s.label} (${s.count}회)\n`;
                if (s.mealTypes) prompt += `  식사방식: ${s.mealTypes}, 메뉴분류: ${s.categories}\n`;
                if (s.menuDetails && s.menuDetails.length) prompt += `  메뉴: ${s.menuDetails.slice(0, 3).join(', ')}\n`;
                if (s.companions) prompt += `  누구와: ${s.companions}\n`;
                if (s.snackTypes) prompt += `  간식종류: ${s.snackTypes}, 장소: ${s.places}\n`;
                prompt += `  만족도: ${s.ratingByScore}, 포만감: ${s.satietyByScore}\n`;
            });
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
        prompt += `- 대상 사용자(위 [대상 사용자]의 이름)를 자연스럽게 부르기 (예: "OO님", "OO야" 등)\n`;
        prompt += `- 식사 패턴의 재미있는 점 우선 언급\n`;
        prompt += `- 시간대별 데이터를 활용해 아침/점심/저녁·간식 시간대별 패턴 분석 가능\n`;
        prompt += `- 자기 소개/기간 언급 금지\n`;
        prompt += `- 이모지 최대 2개, 한국어만 사용\n`;
        
        // Gemini 전송 데이터 확인용 로그 (F12 콘솔에서 확인, 배포 환경에서는 콘솔에 window.DEBUG_GEMINI=true 입력 후 코멘트 버튼 클릭)
        const isDevMode = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const showDebugLog = isDevMode || window.DEBUG_GEMINI;
        if (showDebugLog) {
            console.group('📤 Gemini 분석 요청 데이터');
            console.log('분석 요약:', {
                본식: `${analysis.main.count}회`,
                간식: `${analysis.snack.count}회`,
                본식기록비율: `${mainMealCount}회 / ${totalMainSlots}회 (${mealRecordPercent}%)`,
                공통페르소나: !!(commonPersona && commonPersona.trim()) ? 'systemInstruction으로 전송됨' : '없음',
                밀당메모: !!(userShortcuts && userShortcuts.trim()) ? '프롬프트에 포함됨' : '없음'
            });
            console.log('전체 프롬프트:', prompt);
            console.log('원본 filteredData 건수:', filteredData.length);
            console.groupEnd();
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
                if (isDevMode) {
                    console.log(`🔄 API 호출 (프록시): ${model}`);
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
                
                // 백엔드 프록시 사용 (WebView/앱에서 API 차단 우회)
                let responseData;
                try {
                    const result = await callableFunctions.callGemini({ requestBody, model, apiVersion });
                    responseData = result?.data;
                } catch (callableErr) {
                    const errMsg = callableErr?.message || String(callableErr);
                    if (model === models[0] && isDevMode) {
                        console.warn(`⚠️ callGemini 실패 (${model}):`, errMsg);
                    }
                    if (errMsg.includes('API 키') || errMsg.includes('GEMINI_API_KEY')) {
                        throw new Error(`API 키가 유효하지 않습니다. Firebase 함수 환경 변수 GEMINI_API_KEY를 확인해주세요.`);
                    }
                    if (errMsg.includes('로그인이 필요')) {
                        throw new Error('로그인이 필요합니다. 밀당 분석을 사용하려면 로그인해주세요.');
                    }
                    lastError = new Error(errMsg);
                    continue;
                }
                
                if (!responseData) {
                    lastError = new Error('Gemini API 응답이 없습니다.');
                    continue;
                }
                // Callable이 { data }로 감쌀 수 있음: result.data -> { data: geminiResponse }
                const geminiResponse = responseData?.data ?? responseData;
                if (isDevMode) {
                    console.log(`✅ API 성공: ${model}`);
                }
                // 토큰 사용량 로그 (usageMetadata)
                const usage = geminiResponse?.usageMetadata;
                if (usage && (isDevMode || window.DEBUG_GEMINI)) {
                    console.log('📊 토큰 사용량:', {
                        입력: usage.promptTokenCount ?? usage.prompt_token_count ?? '-',
                        출력: usage.candidatesTokenCount ?? usage.candidates_token_count ?? '-',
                        총합: usage.totalTokenCount ?? usage.total_token_count ?? '-'
                    });
                }
                
                // 응답 검증 (안전 필터 및 응답 구조 처리)
                if (geminiResponse?.candidates && geminiResponse.candidates.length > 0) {
                    const candidate = geminiResponse.candidates[0];
                    
                    // 안전 필터 확인
                    if (geminiResponse.promptFeedback) {
                        console.warn('⚠️ 안전 필터 작동:', geminiResponse.promptFeedback);
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
                        data = geminiResponse;
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
                    console.warn('⚠️ API 응답에 candidates가 없습니다 (안전 필터 작동 가능성):', geminiResponse);
                    
                    if (geminiResponse.promptFeedback) {
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
    
    // 분석 결과가 나온 경우에만 공유 버튼 표시 (캐릭터만 선택한 기본/안내 문구일 때는 숨김)
    const insightTextContent = document.getElementById('insightTextContent');
    if (!currentInsightIsAnalysisResult || currentCharacter === 'mealog' || !insightTextContent || !insightTextContent.textContent || insightTextContent.textContent.trim() === '') {
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
            // 공유됨 상태: 흰 배경으로 구분감
            shareBtn.innerHTML = '<i class="fa-solid fa-share text-[12px] mr-1"></i>공유됨';
            shareBtn.className = 'insight-share-btn insight-share-btn--shared flex-shrink-0 rounded-lg font-bold text-[12px] py-1 px-2';
        } else {
            // 공유 안 됨 상태: 흰 배경으로 구분감
            shareBtn.innerHTML = '<i class="fa-solid fa-share text-[12px] mr-1"></i>공유하기';
            shareBtn.className = 'insight-share-btn insight-share-btn--default flex-shrink-0 rounded-lg font-bold text-[12px] py-1 px-2';
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
    
    // 스크린샷용 HTML 생성 (캐릭터는 원본 DOM 복제로 삽입)
    const borderLightGray = '#e2e8f0';
    const borderOuterGray = '#cbd5e1';
    const screenshotHtml = `
        <div id="insightScreenshotContainer" style="width: 100%; max-width: 420px; margin: 0 auto; border: 1px solid ${borderOuterGray}; border-radius: 20px; overflow: hidden; font-family: Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: #f1f5f9; box-sizing: border-box;">
            <!-- 헤더: 흰 배경, 초록 타이틀 (html2canvas 호환 - line-height로 하단 잘림 방지, align-items: center) -->
            <div style="background: #ffffff; padding: 10px 16px 16px; border-bottom: 1px solid ${borderLightGray};">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px; min-width: 0;">
                    <span style="font-size: 28.8px; font-weight: 600; color: #059669; font-family: 'Fredoka', sans-serif; letter-spacing: -0.5px; text-transform: lowercase; line-height: 1.2; min-width: 0;">mealog</span>
                    <span style="font-size: 12px; font-weight: 400; color: #64748b; flex-shrink: 0; line-height: 1.3;">${escapeHtml(dateRangeText || '')}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
                    <span style="font-size: 16px; flex-shrink: 0;">💬</span>
                    <span style="font-size: 15px; font-weight: 700; color: #1e293b; font-family: 'NanumSquareRound', sans-serif; line-height: 1.35; min-width: 0;">${escapeHtml(userNickname)}에 대한 밀당의 참견</span>
                </div>
            </div>
            <!-- 본문: 연회색 배경, 캐릭터+말풍선 (캐릭터는 원본 DOM 복제) -->
            <div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px 16px 16px; background: #f1f5f9; border-bottom-left-radius: 19px; border-bottom-right-radius: 19px; min-width: 0;">
                <div style="display: flex; flex-direction: column; gap: 8px; flex-shrink: 0;">
                    <div id="insightShareCharacterSlot" style="width: 70px; height: 70px; flex-shrink: 0;"></div>
                    <div style="width: 100%; max-width: 75px; background: #ffca2c; border-radius: 12px; padding: 6px 4px; text-align: center; font-size: 12px; font-weight: 700; color: #1e293b; border: 1px solid rgba(0,0,0,0.08); box-sizing: border-box;">
                        코멘트
                    </div>
                </div>
                <!-- 말풍선 (초록 보더, 흰 배경, 어두운 텍스트) -->
                <div style="flex: 1; min-width: 0;">
                    <div style="background: #ffffff; border: 1px solid #047857; padding: 8px 20px 12px 20px; border-radius: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); min-height: 132px; display: flex; flex-direction: column;">
                        <div style="margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                            ${characterNameText ? `<span style="font-size: 15px; font-weight: 700; color: #1e293b; letter-spacing: -0.01em;">${escapeHtml(characterNameText)}</span>` : '<span></span>'}
                            <span class="insight-share-button" style="font-size: 12px; font-weight: 600; color: #64748b; flex-shrink: 0;">공유</span>
                        </div>
                        <div style="font-size: 13px; line-height: 1.55; color: #1e293b; font-weight: 400; white-space: pre-line; word-wrap: break-word; overflow-wrap: break-word; flex: 1;">
                            ${insightText}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // 미리보기 영역에 HTML 표시
    preview.innerHTML = screenshotHtml;
    
    // 캐릭터 원본 DOM 복제하여 삽입 (납작해짐 방지)
    const characterSlot = preview.querySelector('#insightShareCharacterSlot');
    if (characterSlot && insightCharacterIcon) {
        const clone = insightCharacterIcon.cloneNode(true);
        characterSlot.parentNode.replaceChild(clone, characterSlot);
    }
    
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
            submitBtn.className = 'w-full py-4 bg-slate-800 text-white rounded-xl font-bold active:bg-slate-900 shadow-lg transition-all';
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
        <div id="insightScreenshotContainer" style="width: 100%; max-width: 420px; margin: 0 auto; background: #f8fafc; border-radius: 8px; overflow: hidden; font-family: Pretendard, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; box-sizing: border-box;">
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
        submitBtn.className = 'w-full py-4 bg-slate-800 text-white rounded-xl font-bold active:bg-slate-900 shadow-lg transition-all';
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
        const photoUrlToRemove = existingShare.photoUrl;
        const prevShared = window.sharedPhotos ? [...window.sharedPhotos] : [];
        if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
            window.sharedPhotos = window.sharedPhotos.filter(p =>
                !(p.type === 'insight' && p.dateRangeText === dateRangeText && p.userId === window.currentUser.uid)
            );
        }
        closeShareInsightModal();
        showToast('공유가 취소되었습니다.', 'success');
        updateShareButtonStatus();
        if (appState.currentTab === 'gallery') {
            import('../render/index.js').then(({ renderGallery }) => renderGallery());
        } else if (appState.currentTab === 'feed') {
            import('../render/index.js').then(({ renderFeed }) => renderFeed());
        }
        dbOps.unsharePhotos([photoUrlToRemove], null, false, true).catch(() => {
            if (window.sharedPhotos) window.sharedPhotos = prevShared;
            updateShareButtonStatus();
            if (appState.currentTab === 'gallery') {
                import('../render/index.js').then(({ renderGallery }) => renderGallery());
            } else if (appState.currentTab === 'feed') {
                import('../render/index.js').then(({ renderFeed }) => renderFeed());
            }
        });
        return;
    }
    
    // 공유되지 않은 경우: 공유하기
    const insightShareModal = document.getElementById('insightShareModal');
    const insightShareSpinner = insightShareModal?.querySelector('#insightShareLoadingOverlay');
    if (insightShareSpinner) insightShareSpinner.classList.remove('hidden');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i>공유 중...';
    }
    await new Promise(r => requestAnimationFrame(r));
    await new Promise(r => setTimeout(r, 50));

    try {
        // 스크린샷 생성 시 insightScreenshotContainer 사용
        const screenshotContainer = preview.querySelector('#insightScreenshotContainer');
        const targetElement = screenshotContainer || preview;

        // 외부 이미지(Firebase Storage)를 base64로 변환 (CORS 우회: Cloud Function 사용)
        const imgs = targetElement.querySelectorAll('img[src^="http"]');
        const loadPromises = [];
        for (const img of imgs) {
            try {
                if (img.src.includes('firebasestorage.googleapis.com')) {
                    const { callableFunctions } = await import('../firebase.js');
                    const result = await callableFunctions.getStorageImageAsBase64({ imageUrl: img.src });
                    const dataUrl = result?.data?.dataUrl;
                    if (dataUrl) {
                        const loadP = new Promise((resolve, reject) => {
                            img.onload = () => resolve();
                            img.onerror = () => reject(new Error('이미지 로드 실패'));
                            img.src = dataUrl;
                            if (img.complete && img.naturalWidth > 0) resolve();
                        });
                        loadPromises.push(loadP);
                    } else {
                        console.warn('getStorageImageAsBase64 반환값 없음:', result);
                    }
                } else {
                    const res = await fetch(img.src, { mode: 'cors' });
                    const blob = await res.blob();
                    const dataUrl = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                    });
                    const loadP = new Promise((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error('이미지 로드 실패'));
                        img.src = dataUrl;
                        if (img.complete && img.naturalWidth > 0) resolve();
                    });
                    loadPromises.push(loadP);
                }
            } catch (e) {
                console.warn('캐릭터 이미지 base64 변환 실패:', e);
            }
        }
        await Promise.all(loadPromises).catch(() => {});
        await document.fonts.ready;
        await new Promise(r => setTimeout(r, 150)); // 페인트 대기

        // 폰트 CSS (html2canvas 클론에서 폰트 로드용)
        let fontCSS = '';
        try {
            const [fredokaRes, nanumRes] = await Promise.all([
                fetch('https://fonts.googleapis.com/css2?family=Fredoka:wght@600&display=swap'),
                fetch('https://fonts.googleapis.com/earlyaccess/nanumsquareround.css')
            ]);
            fontCSS = (await fredokaRes.text()) + (await nanumRes.text());
        } catch (e) { console.warn('폰트 CSS 로드 실패:', e); }

        // 유령 캡처: 화면 밖에 복제본을 만들어 모달/transform 간섭 없이 정사이즈 캡처
        const canvas = await captureWithGhostStrategy(targetElement, {
            captureWidth: 420,
            onclone: (clonedDoc) => {
                if (fontCSS) {
                    const style = clonedDoc.createElement('style');
                    style.textContent = fontCSS;
                    clonedDoc.head.appendChild(style);
                }
                const shareBtn = clonedDoc.querySelector('.insight-share-button');
                if (shareBtn) shareBtn.style.display = 'none';
            }
        });
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
        
        // Firebase Storage에 업로드
        const base64Image = canvas.toDataURL('image/png');
        const { uploadBase64ToStorage } = await import('../utils.js');
        const photoUrl = await uploadBase64ToStorage(base64Image, window.currentUser.uid, `insight_${dateRangeText.replace(/\s+/g, '_')}`, 1024);
        
        const userProfile = window.userSettings?.profile || {};
        
        const insightShareData = {
            id: 'pending-' + Date.now(),
            photoUrl,
            userId: window.currentUser.uid,
            userNickname: userProfile.nickname || '익명',
            userIcon: userProfile.icon || '🐻',
            userPhotoUrl: userProfile.photoUrl || null,
            type: 'insight',
            dateRangeText,
            timestamp: new Date().toISOString(),
            entryId: null,
            comment: comment || ''
        };

        if (!window.sharedPhotos) window.sharedPhotos = [];
        window.sharedPhotos = window.sharedPhotos.filter(p =>
            !(p.type === 'insight' && p.dateRangeText === dateRangeText && p.userId === window.currentUser.uid)
        );
        window.sharedPhotos.push(insightShareData);
        window.sharedPhotos.sort((a, b) => (new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime()));

        showToast('밀당(MEAL-DANG)들의 참견이 피드에 공유되었습니다!', 'success');
        closeShareInsightModal();
        updateShareButtonStatus();
        if (appState.currentTab === 'gallery') {
            const { renderGallery } = await import('../render/index.js');
            renderGallery();
        } else if (appState.currentTab === 'feed') {
            const { renderFeed } = await import('../render/index.js');
            renderFeed();
        }

        const { callableFunctions } = await import('../firebase.js');
        callableFunctions.createInsightShare({
            photoUrl,
            dateRangeText,
            comment
        }).then((result) => {
            const serverData = result.data;
            const idx = window.sharedPhotos?.findIndex(p => p.id === insightShareData.id || (p.type === 'insight' && p.dateRangeText === dateRangeText && p.userId === window.currentUser.uid && p.photoUrl === photoUrl));
            if (idx !== undefined && idx !== -1 && window.sharedPhotos) {
                window.sharedPhotos[idx] = serverData;
                if (appState.currentTab === 'gallery') import('../render/index.js').then(({ renderGallery }) => renderGallery());
                if (appState.currentTab === 'feed') import('../render/index.js').then(({ renderFeed }) => renderFeed());
            }
        }).catch((e) => {
            console.error('인사이트 공유 서버 반영 실패:', e);
            if (window.sharedPhotos) {
                window.sharedPhotos = window.sharedPhotos.filter(p =>
                    !(p.type === 'insight' && p.dateRangeText === dateRangeText && p.userId === window.currentUser.uid)
                );
                updateShareButtonStatus();
                if (appState.currentTab === 'gallery') import('../render/index.js').then(({ renderGallery }) => renderGallery());
                if (appState.currentTab === 'feed') import('../render/index.js').then(({ renderFeed }) => renderFeed());
            }
            showToast(e?.message || e?.details || '공유 반영에 실패했습니다. 다시 시도해 주세요.', 'error');
        });
    } catch (e) {
        console.error('인사이트 공유 실패:', e);
        const errorMessage = e.message || e.details || '공유 중 오류가 발생했습니다.';
        showToast(errorMessage, 'error');
    } finally {
        const modal = document.getElementById('insightShareModal');
        const spinner = modal?.querySelector('#insightShareLoadingOverlay');
        if (spinner) spinner.classList.add('hidden');
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = '공유하기';
        }
    }
}

