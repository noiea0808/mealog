// 온보딩 관련 함수들
import { showToast } from './ui.js';
import { DEFAULT_USER_SETTINGS } from './constants.js';
import { dbOps } from './db.js';

// 온보딩 슬라이드 데이터
const ONBOARDING_SLIDES = [
    {
        icon: '📝',
        title: '식사 기록하기',
        description: '매일 먹은 식사와 간식을 기록해보세요.\n사진, 메뉴, 장소, 함께한 사람 등을 기록할 수 있어요.'
    },
    {
        icon: '📊',
        title: '통계 보기',
        description: '대시보드에서 식사 패턴을 분석해보세요.\n주간, 월간, 연간 통계를 확인할 수 있어요.'
    },
    {
        icon: '📸',
        title: '사진 공유하기',
        description: '맛있었던 식사 사진을 피드에 공유해보세요.\n다른 사람들의 식사도 구경할 수 있어요.'
    },
    {
        icon: '💬',
        title: '소통하기',
        description: 'MEAL TALK 게시판에서\n식사 관련 이야기를 나눠보세요!'
    }
];

let currentOnboardingSlide = 0;

// 온보딩 모달 표시
export function showOnboardingModal() {
    const modal = document.getElementById('onboardingModal');
    if (modal) {
        modal.classList.remove('hidden');
        currentOnboardingSlide = 0;
        renderOnboardingSlide();
        updateOnboardingButtons();
    }
}

// 온보딩 모달 닫기
export function closeOnboardingModal() {
    const modal = document.getElementById('onboardingModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// 온보딩 슬라이드 렌더링
function renderOnboardingSlide() {
    const content = document.getElementById('onboardingContent');
    const indicators = document.getElementById('onboardingIndicators');
    
    if (!content || !indicators) return;
    
    const slide = ONBOARDING_SLIDES[currentOnboardingSlide];
    
    content.innerHTML = `
        <div class="text-center">
            <div class="text-5xl mb-4">${slide.icon}</div>
            <h4 class="text-base font-bold text-slate-800 mb-2">${slide.title}</h4>
            <p class="text-xs text-slate-600 leading-relaxed whitespace-pre-line">${slide.description}</p>
        </div>
    `;
    
    indicators.innerHTML = ONBOARDING_SLIDES.map((_, index) => `
        <div class="w-2 h-2 rounded-full ${index === currentOnboardingSlide ? 'bg-emerald-600' : 'bg-slate-300'} transition-colors"></div>
    `).join('');
}

// 온보딩 버튼 상태 업데이트
function updateOnboardingButtons() {
    const prevBtn = document.getElementById('onboardingPrevBtn');
    const nextBtn = document.getElementById('onboardingNextBtn');
    const skipBtn = document.getElementById('onboardingSkipBtn');
    
    if (currentOnboardingSlide === 0) {
        if (prevBtn) prevBtn.classList.add('hidden');
        if (skipBtn) skipBtn.classList.remove('hidden');
        if (nextBtn) {
            nextBtn.textContent = '다음';
            nextBtn.classList.remove('hidden');
        }
    } else if (currentOnboardingSlide === ONBOARDING_SLIDES.length - 1) {
        if (prevBtn) prevBtn.classList.remove('hidden');
        if (skipBtn) skipBtn.classList.add('hidden');
        if (nextBtn) {
            nextBtn.textContent = '시작하기';
            nextBtn.classList.remove('hidden');
        }
    } else {
        if (prevBtn) prevBtn.classList.remove('hidden');
        if (skipBtn) skipBtn.classList.remove('hidden');
        if (nextBtn) {
            nextBtn.textContent = '다음';
            nextBtn.classList.remove('hidden');
        }
    }
}

// 온보딩 이전
export function onboardingPrev() {
    if (currentOnboardingSlide > 0) {
        currentOnboardingSlide--;
        renderOnboardingSlide();
        updateOnboardingButtons();
    }
}

// 온보딩 다음
export async function onboardingNext() {
    if (currentOnboardingSlide < ONBOARDING_SLIDES.length - 1) {
        currentOnboardingSlide++;
        renderOnboardingSlide();
        updateOnboardingButtons();
    } else {
        // 마지막 슬라이드에서 "시작하기" 클릭
        await completeOnboarding();
    }
}

// 온보딩 건너뛰기
export async function onboardingSkip() {
    await completeOnboarding();
}

// 온보딩 완료
async function completeOnboarding() {
    try {
        if (!window.userSettings) {
            window.userSettings = { ...DEFAULT_USER_SETTINGS };
        }
        
        window.userSettings.onboardingCompleted = true;
        window.userSettings.isFirstLogin = false;
        
        await dbOps.saveSettings(window.userSettings);
        
        closeOnboardingModal();
        showToast("환영합니다! 이제 MEALOG를 시작해보세요.", "success");
        
        // 인증 플로우 관리자에게 온보딩 완료 알림
        const { authFlowManager } = await import('./auth-flow.js');
        await authFlowManager.onOnboardingCompleted();
    } catch (e) {
        console.error("온보딩 완료 저장 실패:", e);
        closeOnboardingModal();
        showToast("온보딩이 완료되었습니다.", "success");
        
        // 에러가 발생해도 플로우는 계속 진행
        try {
            const { authFlowManager } = await import('./auth-flow.js');
            await authFlowManager.onOnboardingCompleted();
        } catch (flowError) {
            console.error("인증 플로우 처리 실패:", flowError);
        }
    }
}

