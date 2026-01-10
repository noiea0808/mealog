// 인사이트 코멘트 관련 함수들
import { appState } from '../state.js';
import { showToast } from '../ui.js';

// Gemini API 설정
const GEMINI_API_KEY = 'AIzaSyDT_awa47kigQ3VPrPcQmUy8nLSSpZJkpw';
// 지원 가능한 모델 목록 (우선순위 순) - 실제 존재하는 모델 우선 사용
const GEMINI_MODELS = [
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash',
    'gemini-1.5-pro-latest',
    'gemini-1.5-pro',
    'gemini-2.0-flash-exp',
    'gemini-2.5-flash',
    'gemini-pro'
];

// API URL 생성 함수 (여러 버전 시도)
function getGeminiApiUrl(model, version = 'v1beta') {
    return `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
}

// 캐릭터 정의
const INSIGHT_CHARACTERS = [
    { 
        id: 'mealog', 
        name: 'MEALOG', 
        icon: 'M', 
        persona: '친근하고 따뜻한 식사 친구',
        systemPrompt: '당신은 MEALOG입니다. 사용자의 식사 기록을 친근하고 따뜻하면서도 재미있게 분석합니다. 유머러스하고 밝은 성격으로, 식사 패턴에서 발견한 재미있는 점들을 즐겁게 공유합니다. 진부한 격려보다는 캐주얼하고 친근한 말투로, 마치 친한 친구처럼 편하게 소통합니다. 식사의 즐거움과 소중함을 당신만의 개성 있는 방식으로 전달하세요.'
    },
    { 
        id: 'trainer', 
        name: '엄격한 트레이너', 
        icon: '💪', 
        persona: '건강과 웰빙을 중시하는 트레이너',
        systemPrompt: '당신은 건강과 웰빙을 중시하는 트레이너입니다. 엄격하지만 따뜻한 톤으로, 식사 패턴을 날카롭게 분석하고 건강한 식습관을 위한 명확한 조언을 제공합니다. 격려와 함께 건설적인 피드백을 주며, 때로는 유머를 섞어 지루하지 않게 전달합니다. 전문적이지만 딱딱하지 않고, 사용자가 행동 변화를 일으킬 수 있도록 동기부여하는 당신만의 스타일을 유지하세요.'
    }
];

// 현재 선택된 캐릭터 (기본값: MEALOG)
let currentCharacter = 'mealog';

// 텍스트를 5줄 단위로 나누는 함수 (최대 3페이지 제한)
function splitTextIntoPages(text, maxLines = 5, maxPages = 3) {
    if (!text) return [''];
    
    // 텍스트 정리 (연속된 공백 제거, 줄바꿈 정규화)
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n'); // 3개 이상 연속 줄바꿈은 2개로
    text = text.trim();
    
    // 줄바꿈을 기준으로 분할 (빈 줄도 유지)
    const originalLines = text.split('\n');
    const allLines = [];
    const maxCharsPerLine = 42; // 말풍선 너비 고려하여 약간 여유
    
    // 각 줄을 최대 문자 수로 나누기 (한국어 텍스트 고려)
    originalLines.forEach(line => {
        line = line.trim();
        
        if (line === '') {
            // 빈 줄은 그대로 유지
            allLines.push('');
        } else if (line.length <= maxCharsPerLine) {
            allLines.push(line);
        } else {
            // 긴 줄을 여러 줄로 나누기 (한국어 고려)
            let remaining = line;
            while (remaining.length > 0) {
                if (remaining.length <= maxCharsPerLine) {
                    allLines.push(remaining);
                    break;
                }
                
                // 최대 길이까지 자르되, 단어나 문장 중간에서 자르지 않도록
                let cutPos = maxCharsPerLine;
                
                // 문장 부호 앞에서 자르기 (., !, ?)
                const sentenceEnd = remaining.substring(0, maxCharsPerLine).lastIndexOf(/[.!?]/);
                if (sentenceEnd > maxCharsPerLine * 0.7) {
                    cutPos = sentenceEnd + 1;
                } else {
                    // 공백이나 쉼표 앞에서 자르기
                    const spacePos = remaining.substring(0, maxCharsPerLine).lastIndexOf(' ');
                    const commaPos = remaining.substring(0, maxCharsPerLine).lastIndexOf(',');
                    const maxPos = Math.max(spacePos, commaPos);
                    if (maxPos > maxCharsPerLine * 0.6) {
                        cutPos = maxPos + 1;
                    }
                }
                
                allLines.push(remaining.substring(0, cutPos).trim());
                remaining = remaining.substring(cutPos).trim();
            }
        }
    });
    
    // 5줄씩 묶어서 페이지 만들기 (최대 3페이지)
    const maxTotalLines = maxPages * maxLines;
    const linesToUse = allLines.slice(0, maxTotalLines);
    
    const pages = [];
    for (let i = 0; i < linesToUse.length; i += maxLines) {
        const pageLines = linesToUse.slice(i, i + maxLines);
        const pageText = pageLines.join('\n').trim();
        if (pageText) {
            pages.push(pageText);
        }
    }
    
    // 페이지가 없으면 최소한 1페이지는 반환
    return pages.length > 0 ? pages : [text.substring(0, maxTotalLines * maxCharsPerLine)];
}

// 말풍선에 텍스트 표시 (페이지네이션, 최대 3페이지)
function displayInsightText(text, characterName = '') {
    const container = document.getElementById('insightTextPages');
    const pageCounter = document.getElementById('insightPageCounter');
    const indicator = document.getElementById('insightPageIndicator');
    const bubble = document.getElementById('insightBubble');
    
    if (!container) return;
    
    // 텍스트를 최대 3페이지로 분할
    const pages = splitTextIntoPages(text, 5, 3);
    
    // 캐릭터명은 첫 페이지에만 표시
    const characterHeader = characterName && pages.length > 0 
        ? `<div class="insight-character-name text-xs font-bold text-emerald-700 mb-1">[ ${characterName} ]</div>` 
        : '';
    
    container.innerHTML = pages.map((page, index) => 
        `<div class="insight-text-page ${index === 0 ? 'active' : ''}" data-page="${index}">${index === 0 ? characterHeader : ''}<div class="insight-text-content">${page}</div></div>`
    ).join('');
    
    // 페이지 카운터 표시 (우상단) - 항상 표시 (1페이지여도)
    if (pageCounter) {
        pageCounter.classList.remove('hidden');
        pageCounter.textContent = `1/${pages.length}`;
        window.totalInsightPages = pages.length;
    }
    
    // 페이지 인디케이터 표시 (페이지가 2개 이상일 때만)
    if (pages.length > 1 && indicator) {
        indicator.classList.remove('hidden');
        indicator.innerHTML = pages.map((_, index) => 
            `<div class="insight-page-dot ${index === 0 ? 'active' : ''}" onclick="window.showInsightPage(${index})"></div>`
        ).join('');
    } else if (indicator) {
        indicator.classList.add('hidden');
    }
    
    // 말풍선 클릭 이벤트 설정 (페이지가 2개 이상일 때만)
    if (bubble && pages.length > 1) {
        bubble.style.cursor = 'pointer';
        bubble.title = '클릭하여 다음 페이지 보기';
    } else if (bubble) {
        bubble.style.cursor = 'default';
        bubble.title = '';
    }
    
    // 첫 페이지로 초기화
    window.currentInsightPage = 0;
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
    
    // 클릭 피드백 (선택사항)
    const bubble = document.getElementById('insightBubble');
    if (bubble) {
        bubble.style.transform = 'scale(0.98)';
        setTimeout(() => {
            bubble.style.transform = '';
        }, 150);
    }
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
    
    // 선택된 캐릭터로 인사이트 다시 생성
    if (window.getDashboardData) {
        const { filteredData, dateRangeText } = window.getDashboardData();
        updateInsightComment(filteredData, dateRangeText);
    }
}

// 캐릭터에 맞는 인사이트 코멘트 업데이트
export async function updateInsightComment(filteredData, dateRangeText = '') {
    const comment = await getGeminiComment(filteredData, currentCharacter, dateRangeText);
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
    
    const { filteredData, dateRangeText } = window.getDashboardData();
    
    // 버튼 비활성화 및 로딩 상태
    const btn = document.getElementById('generateCommentBtn');
    if (btn) {
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = '...';
    }
    
    try {
        // AI 코멘트 생성 및 업데이트
        await updateInsightComment(filteredData, dateRangeText);
        
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

// 데이터 분석 및 요약 정보 생성
function analyzeMealData(filteredData, dateRangeText) {
    if (!filteredData || filteredData.length === 0) {
        return null;
    }
    
    // 식사 구분 분석
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
        const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
        console.log('ListModels API 호출 중...', listUrl);
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
                        return methods.includes('generateContent');
                    })
                    .map(model => model.name?.replace('models/', '') || null)
                    .filter(name => name !== null);
                
                console.log('generateContent를 지원하는 모델:', modelsWithGenerateContent);
                availableModels = modelsWithGenerateContent;
                return modelsWithGenerateContent;
            }
        } else {
            const errorText = await response.text();
            console.error('ListModels API 오류:', response.status, errorText);
        }
    } catch (error) {
        console.error('모델 목록 조회 실패:', error);
    }
    return null;
}

// Gemini API를 사용하여 코멘트 생성
async function getGeminiComment(filteredData, characterId = currentCharacter, dateRangeText = '') {
    const character = INSIGHT_CHARACTERS.find(c => c.id === characterId);
    
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
        
        // 프롬프트 생성 (재미있고 캐릭터 성격 중심, 핵심만)
        const menuSummary = analysis.menuDetails.length > 0 
            ? analysis.menuDetails.slice(0, 5).join(', ') 
            : '없음';
        
        const prompt = `당신은 ${character.name}입니다. ${character.systemPrompt}

**중요**: ${character.persona}로서 당신의 고유한 성격과 말투를 확실히 드러내세요.

식사 데이터 분석:
- 총 ${analysis.totalMeals}회 기록
- 식사구분: ${analysis.mealTypes || '없음'}
- 주요 메뉴: ${menuSummary}
- 함께한 사람: ${analysis.companions || '대부분 혼자'}
${analysis.avgRating ? `- 만족도 평균: ${analysis.avgRating}/5` : ''}

위 데이터를 보고 12-15줄의 재미있고 개성 있는 코멘트를 작성하세요.

**절대 하지 말 것:**
- 자기 소개 금지 ("안녕하세요", "저는 OOO입니다" 등)
- 기간 언급 금지 ("지난 한 주", "이번 기간", "1월 4일부터" 등 - 상단에 이미 표시됨)
- 지루하고 진부한 문구 사용 금지

**반드시 할 것:**
- 캐릭터 성격이 확실히 드러나도록 재미있고 개성 있게 작성
- 식사 패턴에서 발견한 재미있거나 흥미로운 점을 우선 언급
- 긍정적이지만 진부하지 않은, 캐릭터다운 격려
- 핵심 인사이트만 전달 (불필요한 장황한 설명 없이)
- 캐릭터 고유의 말투와 유머 감각 사용
- 짧고 명확한 문장으로 구성 (한 줄당 30-40자)
- 이모지 최대 2개 자연스럽게 사용
- 한국어로만, 12-15줄 완전히 끝내기`;
        
        // v1beta API만 사용 (v1은 이 모델들을 지원하지 않음)
        let lastError = null;
        let data = null;
        const apiVersion = 'v1beta'; // v1beta만 사용
        
        // 먼저 사용 가능한 모델 목록 확인
        const modelsToTry = await listAvailableModels();
        
        // 사용 가능한 모델이 있으면 그것을 사용, 없으면 기본 목록 사용
        const models = modelsToTry && modelsToTry.length > 0 ? modelsToTry : GEMINI_MODELS;
        console.log('시도할 모델 목록:', models);
        
        for (const model of models) {
            try {
                const apiUrl = getGeminiApiUrl(model, apiVersion);
                console.log(`Gemini API 호출 시도: ${apiVersion}/${model}`);
                
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
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
                    })
                });
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`모델 ${apiVersion}/${model} API 응답 오류:`, response.status, errorText);
                    lastError = new Error(`API 요청 실패 (${apiVersion}/${model}): ${response.status} - ${errorText}`);
                    continue; // 다음 모델 시도
                }
                
                const responseData = await response.json();
                console.log(`Gemini API 성공: ${apiVersion}/${model}`);
                
                // 응답 검증
                if (responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content) {
                    let testComment = responseData.candidates[0].content.parts[0].text.trim();
                    const testFinishReason = responseData.candidates[0].finishReason;
                    
                    console.log('API 응답 확인:', {
                        모델: model,
                        finishReason: testFinishReason,
                        원본_길이: testComment.length,
                        원본_텍스트_미리보기: testComment.substring(0, 100) + '...'
                    });
                    
                    // 응답이 불완전한 경우 (너무 짧거나 MAX_TOKENS인데 짧음) 다음 모델로 재시도
                    if (!testComment || testComment.length < 150) {
                        console.warn(`응답이 너무 짧습니다 (${testComment.length}자). 다음 모델로 재시도합니다.`);
                        lastError = new Error(`응답이 너무 짧습니다: ${testComment.length}자`);
                        continue; // 다음 모델로 재시도
                    }
                    
                    if (testFinishReason === 'MAX_TOKENS' && testComment.length < 150) {
                        console.warn(`MAX_TOKENS인데 응답이 너무 짧습니다 (${testComment.length}자). 다음 모델로 재시도합니다.`);
                        lastError = new Error(`MAX_TOKENS로 잘렸지만 너무 짧음: ${testComment.length}자`);
                        continue; // 다음 모델로 재시도
                    }
                    
                    // 응답이 충분하면 이 모델 사용
                    data = responseData;
                    break; // 성공하면 반복 중단
                } else {
                    console.warn('응답 형식이 올바르지 않습니다. 다음 모델로 재시도합니다.');
                    lastError = new Error('응답 형식 오류');
                    continue; // 다음 모델로 재시도
                }
                
            } catch (error) {
                console.error(`모델 ${apiVersion}/${model} 호출 중 오류:`, error);
                lastError = error;
                continue; // 다음 모델 시도
            }
        }
        
        // 모든 모델 실패 시
        if (!data) {
            throw lastError || new Error('모든 Gemini 모델 호출 실패. 사용 가능한 모델 목록을 확인해주세요.');
        }
        
        // 최종 응답 처리
        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
            let comment = data.candidates[0].content.parts[0].text.trim();
            const finishReason = data.candidates[0].finishReason;
            
            console.log('최종 응답 처리:', {
                finishReason: finishReason,
                원본_길이: comment.length,
                원본_텍스트_전체: comment
            });
            
            // MAX_TOKENS인 경우 불완전한 마지막 문장 제거
            if (finishReason === 'MAX_TOKENS' && comment.length >= 150) {
                console.log('MAX_TOKENS이지만 충분히 긴 응답이므로 처리합니다.');
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
            if (!comment || comment.length < 150) {
                throw new Error(`최종 응답이 너무 짧습니다: ${comment.length}자`);
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
            
            console.log('최종 생성된 코멘트:', {
                길이: comment.length,
                줄_수: comment.split('\n').length,
                미리보기: comment.substring(0, 150) + '...'
            });
            
            return comment;
        } else {
            console.error('응답 데이터 구조 오류:', JSON.stringify(data, null, 2));
            throw new Error('응답 형식이 올바르지 않습니다.');
        }
        
    } catch (error) {
        console.error('Gemini API 오류:', error);
        
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

// INSIGHT_CHARACTERS 반환
export function getInsightCharacters() {
    return INSIGHT_CHARACTERS;
}
