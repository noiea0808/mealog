// 인사이트 코멘트 관련 함수들
import { appState } from '../state.js';
import { showToast } from '../ui.js';

// 캐릭터 정의
const INSIGHT_CHARACTERS = [
    { id: 'mealog', name: 'MEALOG', icon: 'M', persona: '친근하고 따뜻한 식사 친구' },
    { id: 'trainer', name: '엄격한 트레이너', icon: '💪', persona: '건강과 웰빙을 중시하는 트레이너' }
];

// 현재 선택된 캐릭터 (기본값: MEALOG)
let currentCharacter = 'mealog';

// 코멘트 목록 (규칙 기반)
const COMMENT_LIST = [
    "멋진 식사 기록이 쌓이고 있어요! ✨\n\n이번 기간 동안 다양한 맛을 경험하셨네요. 건강하고 행복한 식사가 계속되기를 바랍니다!",
    "식사 패턴을 보니 규칙적인 식습관을 유지하고 계시네요! 🌟\n\n균형 잡힌 식사로 건강한 하루하루를 만들어가세요!",
    "오늘도 맛있는 시간들이 가득하셨을 것 같아요! 😊\n\n좋은 식사는 좋은 하루의 시작이에요!",
    "다양한 메뉴를 즐기고 계시는 모습이 보기 좋네요! 🍽️\n\n새로운 맛의 경험이 인생을 풍요롭게 만듭니다!",
    "식사 기록을 통해 하루하루를 되돌아볼 수 있어 좋네요! 📝\n\n소중한 기억들이 쌓이고 있습니다!",
    "규칙적인 식사 습관이 잘 유지되고 있어요! ⏰\n\n건강한 라이프스타일을 이어가고 계시네요!",
    "맛있는 음식과 함께한 즐거운 시간들이 느껴집니다! 🎉\n\n행복한 식사가 하루를 밝게 만들어요!",
    "식사 구성을 보니 영양을 고려한 선택을 하고 계시네요! 💪\n\n건강 관리에 신경 쓰시는 모습이 훌륭해요!",
    "다양한 식사 경험이 인상적이에요! 🌈\n\n새로운 맛의 발견이 삶에 활력을 더합니다!",
    "식사 기록을 꾸준히 하시는 모습이 멋집니다! 📚\n\n작은 습관이 큰 변화를 만들어내죠!",
    "좋은 식사 습관이 생활 전반에 긍정적인 영향을 주고 있어요! ✨\n\n계속 이렇게 지켜나가시면 좋을 것 같아요!",
    "식사 시간이 행복한 추억으로 남고 있네요! 💭\n\n소중한 순간들을 기록하고 계시는 거예요!",
    "균형잡힌 식사 패턴이 눈에 띄네요! ⚖️\n\n건강한 식습관을 유지하고 계시는 모습이 좋습니다!",
    "다양한 메뉴를 시도해보시는 모습이 활기차네요! 🚀\n\n새로운 경험이 인생을 풍요롭게 합니다!",
    "식사 기록을 통해 자신의 패턴을 파악할 수 있어 좋아요! 🔍\n\n데이터가 보여주는 인사이트가 있네요!",
    "맛있는 식사와 함께한 시간들이 소중하시겠어요! ❤️\n\n좋은 음식은 좋은 기억을 남깁니다!",
    "규칙적인 식사 시간이 건강한 생활 리듬을 만들어내고 있어요! 🕐\n\n잘 유지하고 계시는 모습이 훌륭합니다!",
    "식사 구성을 보니 영양 밸런스를 고려하고 계시네요! 🥗\n\n건강한 식습관의 좋은 예시예요!",
    "다양한 맛의 경험이 인생을 풍요롭게 만들어요! 🌍\n\n세계의 맛을 경험하는 것처럼 보입니다!",
    "식사 기록을 꾸준히 하시는 습관이 멋져요! 📖\n\n작은 노력이 큰 성과를 만들어냅니다!",
    "좋은 식사는 좋은 하루의 시작이에요! 🌅\n\n매일매일의 작은 선택이 인생을 바꿉니다!",
    "식사 패턴을 보니 건강한 라이프스타일을 유지하고 계시네요! 🏃\n\n계속 이렇게 지켜나가시면 좋을 것 같아요!",
    "맛있는 음식과 함께한 추억들이 아름답네요! 🎨\n\n좋은 식사는 좋은 기억을 만들어냅니다!",
    "균형잡힌 식사 습관이 생활 전반에 긍정적인 영향을 주고 있어요! 💎\n\n소중한 습관을 잘 유지하고 계시네요!",
    "다양한 메뉴를 즐기시는 모습이 활기차고 좋네요! 🎊\n\n새로운 맛의 발견이 즐거우셨을 것 같아요!",
    "식사 기록을 통해 자신의 식습관을 되돌아볼 수 있어 좋아요! 🪞\n\n데이터가 보여주는 이야기가 있네요!",
    "규칙적인 식사 시간이 일상의 리듬을 만들어내고 있어요! 🎵\n\n건강한 생활 패턴을 유지하고 계시는 모습이 좋습니다!",
    "식사 구성을 보니 영양을 고려한 선택을 하고 계시네요! 🧬\n\n건강 관리에 신경 쓰시는 모습이 훌륭해요!",
    "맛있는 식사와 함께한 행복한 시간들이 느껴집니다! 😄\n\n좋은 음식은 마음을 따뜻하게 만들어요!",
    "식사 기록이 소중한 추억들을 간직하는 역할을 하고 있네요! 🗄️\n\n시간이 지나도 돌아볼 수 있는 기록이 되어요!"
];

// 현재 코멘트 인덱스
let currentCommentIndex = 0;

// 텍스트를 5줄 단위로 나누는 함수 (더 정확한 줄 단위 분할)
function splitTextIntoPages(text, maxLines = 5) {
    if (!text) return [''];
    
    // 줄바꿈을 기준으로 분할
    const originalLines = text.split('\n');
    const allLines = [];
    
    // 각 줄을 최대 45자로 나누기 (말풍선 너비 고려)
    originalLines.forEach(line => {
        if (line.length <= 45) {
            allLines.push(line);
        } else {
            // 긴 줄을 단어 단위로 나누기
            const words = line.split(' ');
            let currentLine = '';
            
            words.forEach(word => {
                if (!currentLine) {
                    currentLine = word;
                } else if ((currentLine + ' ' + word).length <= 45) {
                    currentLine += ' ' + word;
                } else {
                    if (currentLine) allLines.push(currentLine);
                    currentLine = word;
                }
            });
            
            if (currentLine) allLines.push(currentLine);
        }
    });
    
    // 5줄씩 묶어서 페이지 만들기
    const pages = [];
    for (let i = 0; i < allLines.length; i += maxLines) {
        const pageLines = allLines.slice(i, i + maxLines);
        pages.push(pageLines.join('\n'));
    }
    
    return pages.length > 0 ? pages : [text];
}

// 말풍선에 텍스트 표시 (페이지네이션)
function displayInsightText(text, characterName = '') {
    const container = document.getElementById('insightTextPages');
    const indicator = document.getElementById('insightPageIndicator');
    
    if (!container) return;
    
    const pages = splitTextIntoPages(text, 5);
    
    // 캐릭터명을 각 페이지 상단에 추가
    const characterHeader = characterName ? `<div class="insight-character-name text-xs font-bold text-emerald-700 mb-1">[ ${characterName} ]</div>` : '';
    
    container.innerHTML = pages.map((page, index) => 
        `<div class="insight-text-page ${index === 0 ? 'active' : ''}" data-page="${index}">${characterHeader}<div class="insight-text-content">${page}</div></div>`
    ).join('');
    
    // 페이지 인디케이터 표시 (페이지가 2개 이상일 때만)
    if (pages.length > 1 && indicator) {
        indicator.classList.remove('hidden');
        indicator.innerHTML = pages.map((_, index) => 
            `<div class="insight-page-dot ${index === 0 ? 'active' : ''}" onclick="window.showInsightPage(${index})"></div>`
        ).join('');
    } else if (indicator) {
        indicator.classList.add('hidden');
    }
    
    // 첫 페이지로 초기화
    window.currentInsightPage = 0;
}

// 인사이트 페이지 전환
export function showInsightPage(pageIndex) {
    const pages = document.querySelectorAll('.insight-text-page');
    const dots = document.querySelectorAll('.insight-page-dot');
    
    if (pages.length === 0) return;
    
    pages.forEach((page, index) => {
        page.classList.toggle('active', index === pageIndex);
    });
    
    dots.forEach((dot, index) => {
        dot.classList.toggle('active', index === pageIndex);
    });
    
    window.currentInsightPage = pageIndex;
}

// 말풍선 클릭 시 다음 페이지로 (초기화)
export function setupInsightBubbleClick() {
    const bubble = document.getElementById('insightBubble');
    if (!bubble) return;
    
    // 기존 이벤트 리스너 제거 후 새로 추가
    bubble.removeEventListener('click', handleInsightBubbleClick);
    bubble.addEventListener('click', handleInsightBubbleClick);
}

function handleInsightBubbleClick() {
    const pages = document.querySelectorAll('.insight-text-page');
    if (pages.length <= 1) return;
    
    const currentPage = window.currentInsightPage || 0;
    const nextPage = (currentPage + 1) % pages.length;
    showInsightPage(nextPage);
}

// 캐릭터 선택 팝업 열기/토글
export function openCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    
    if (!popup) return;
    
    // 이미 열려있으면 닫기
    if (!popup.classList.contains('hidden')) {
        closeCharacterSelectModal();
        return;
    }
    
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

// 캐릭터 선택 팝업 닫기
export function closeCharacterSelectModal() {
    const popup = document.getElementById('characterSelectPopup');
    if (popup) {
        popup.classList.add('hidden');
    }
    document.removeEventListener('click', handleOutsideClick, true);
}

// 캐릭터 선택
export function selectInsightCharacter(characterId) {
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    if (!character) return;
    
    currentCharacter = characterId;
    
    // 캐릭터 아이콘 업데이트
    const iconEl = document.getElementById('insightCharacterIcon');
    if (iconEl) {
        if (character.id === 'mealog') {
            iconEl.textContent = 'M';
            iconEl.className = 'text-2xl font-black text-white';
        } else {
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
    
    // 선택된 캐릭터로 인사이트 다시 생성 (나중에 AI 연결 시)
    if (window.getDashboardData) {
        const { filteredData } = window.getDashboardData();
        updateInsightComment(filteredData);
    }
}

// 캐릭터에 맞는 인사이트 코멘트 업데이트
export async function updateInsightComment(filteredData) {
    const comment = await getGeminiComment(filteredData, currentCharacter);
    const character = INSIGHT_CHARACTERS.find(c => c.id === currentCharacter);
    const characterName = character ? character.name : '';
    displayInsightText(comment || "멋진 식사 기록이 쌓이고 있어요! ✨", characterName);
}

// 코멘트 생성 버튼 클릭 시
export async function generateInsightComment() {
    if (!window.getDashboardData) {
        console.error('getDashboardData 함수를 찾을 수 없습니다.');
        return;
    }
    
    const { filteredData } = window.getDashboardData();
    
    // 버튼 비활성화 및 로딩 상태
    const btn = document.getElementById('generateCommentBtn');
    if (btn) {
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '...';
    }
    
    try {
        // 다음 코멘트로 이동
        currentCommentIndex = (currentCommentIndex + 1) % COMMENT_LIST.length;
        
        // 코멘트 업데이트
        await updateInsightComment(filteredData);
        
        // 팝업이 열려있으면 닫기
        closeCharacterSelectModal();
    } catch (error) {
        console.error('코멘트 생성 실패:', error);
        showToast('코멘트 생성 중 오류가 발생했습니다.', 'error');
    } finally {
        // 버튼 활성화 및 원래 텍스트로 복원
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'COMMENT';
        }
    }
}

async function getGeminiComment(filteredData, characterId = currentCharacter) {
    if (filteredData.length === 0) {
        const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
        return character ? `${character.icon} 오늘도 맛있는 기록 되세요!` : "오늘도 맛있는 기록 되세요!";
    }
    
    // 규칙 기반 코멘트 리스트에서 현재 인덱스의 코멘트 반환
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    const prefix = character ? `${character.icon} ` : '';
    
    // 데이터 기반으로 적절한 코멘트 선택 (간단한 규칙)
    // 예: 식사 횟수, 만족도 평균 등을 고려하여 코멘트 선택
    const mealCount = filteredData.length;
    const avgRating = filteredData
        .filter(m => m.rating)
        .reduce((sum, m) => sum + parseInt(m.rating || 0), 0) / filteredData.filter(m => m.rating).length || 0;
    
    // 데이터에 맞는 코멘트 선택 (현재는 순환)
    const selectedComment = COMMENT_LIST[currentCommentIndex % COMMENT_LIST.length];
    
    return prefix + selectedComment;
}

// 현재 선택된 캐릭터 반환 (다른 모듈에서 사용)
export function getCurrentCharacter() {
    return currentCharacter;
}

// INSIGHT_CHARACTERS 반환
export function getInsightCharacters() {
    return INSIGHT_CHARACTERS;
}
