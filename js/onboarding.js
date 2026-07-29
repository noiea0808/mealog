/**
 * 로그인 전 서비스 가이드 (랜딩)
 * 미로그인: 가이드 → 로그인 화면 (매번)
 * 이미 로그인(세션 복원) 시 스킵
 */
import {
    getLandingAppPromoKind,
    openOsInstallGuideModal,
} from './pwa-install.js';
import { lockBodyScroll, unlockBodyScroll } from './utils/scroll-lock.js';

/** 레거시 키 — 더 이상 저장하지 않고 발견 시 삭제만 */
const SEEN_KEY = 'mealog_landingServiceGuideSeen';

const SLIDE_DEFS = [
    {
        id: 'welcome',
        visual: 'welcome',
        eyebrow: 'Welcome',
        title: '오늘의 한 끼가\n작은 이야기가 됩니다',
        body: '특별하지 않아도 괜찮아요.\n평범한 식탁도 지나고 나면 소중한 하루가 됩니다.',
    },
    {
        id: 'mealog',
        visual: 'mealog',
        eyebrow: '밀로그',
        title: '한 끼의 장면을\n오래 남겨두세요',
        body: '사진 한 장, 메뉴 하나, 짧은 한마디.\n오늘의 식탁이 하나의 기억이 됩니다.',
    },
    {
        id: 'analysis',
        visual: 'analysis',
        eyebrow: '분석',
        title: '기록이 쌓이면\n나의 식탁이 보여요',
        body: '자주 찾는 음식과 반복되는 습관까지.\n기록 속에서 몰랐던 나를 발견해 보세요.',
    },
    {
        id: 'moment',
        visual: 'moment',
        eyebrow: '모먼트',
        title: '맛있었던 순간을\n슬쩍 나눠보세요',
        body: '근사한 식사가 아니어도 괜찮아요.\n평범한 한 끼가 누군가에게는 좋은 이야기가 됩니다.',
    },
];

const INSTALL_SLIDES = {
    android: {
        id: 'install',
        visual: 'install',
        eyebrow: '더 가까이',
        title: '자주 찾는 곳에\n밀로그를 두세요',
        body: '홈 화면에 추가해 두면\n오늘의 식탁을 더 가볍게 기록할 수 있어요.',
        cta: '방법 보기',
        ctaAction: 'guide',
    },
    ios: {
        id: 'install',
        visual: 'install',
        eyebrow: '더 가까이',
        title: '자주 찾는 곳에\n밀로그를 두세요',
        body: '홈 화면에 추가해 두면\n오늘의 식탁을 더 가볍게 기록할 수 있어요.',
        cta: '방법 보기',
        ctaAction: 'guide',
    },
    desktop: {
        id: 'install',
        visual: 'install',
        eyebrow: '더 가까이',
        title: '자주 찾는 곳에\n밀로그를 두세요',
        body: '홈 화면에 추가해 두면\n오늘의 식탁을 더 가볍게 기록할 수 있어요.',
        cta: '방법 보기',
        ctaAction: 'guide',
    },
};

let slides = [];
let currentIndex = 0;
let active = false;
let completing = false;
let onCompleteCb = null;
let bound = false;

function $(id) {
    return document.getElementById(id);
}

export function hasSeenLandingServiceGuide() {
    return false;
}

export function markLandingServiceGuideSeen() {
    clearLandingServiceGuideSeen();
}

export function clearLandingServiceGuideSeen() {
    try {
        localStorage.removeItem(SEEN_KEY);
    } catch (_) {}
}

function buildSlides() {
    const list = SLIDE_DEFS.map((s) => ({ ...s }));
    const kind = getLandingAppPromoKind();
    if (kind && INSTALL_SLIDES[kind]) {
        list.push({ ...INSTALL_SLIDES[kind] });
    }
    return list;
}

function renderDots() {
    const dots = $('serviceGuideDots');
    if (!dots) return;
    dots.innerHTML = slides
        .map((_, i) => `<i class="${i === currentIndex ? 'on' : ''}" aria-hidden="true"></i>`)
        .join('');
}

function renderSlide() {
    const slide = slides[currentIndex];
    if (!slide) return;

    const eyebrow = $('serviceGuideEyebrow');
    const title = $('serviceGuideTitle');
    const body = $('serviceGuideBody');
    const cta = $('serviceGuideInstallCta');
    const prevBtn = $('serviceGuidePrevBtn');
    const nextBtn = $('serviceGuideNextBtn');
    const skipBtn = $('serviceGuideSkipBtn');
    const panel = $('serviceGuideCopy');
    const overlay = $('serviceGuideOverlay');

    if (eyebrow) eyebrow.textContent = slide.eyebrow || '';
    if (title) title.textContent = slide.title || '';
    if (body) body.textContent = slide.body || '';

    const last = currentIndex === slides.length - 1;
    if (prevBtn) prevBtn.disabled = currentIndex === 0;
    if (nextBtn) nextBtn.textContent = last ? '시작하기' : '다음';
    if (skipBtn) skipBtn.classList.toggle('invisible', last);

    if (cta) {
        const showCta = !!slide.cta;
        cta.classList.toggle('hidden', !showCta);
        if (showCta) {
            cta.textContent = slide.cta;
            cta.dataset.action = slide.ctaAction || '';
        }
    }

    document.querySelectorAll('.service-guide-visual').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.visual === slide.visual);
    });

    if (panel) {
        panel.classList.remove('service-guide-copy--enter');
        void panel.offsetWidth;
        panel.classList.add('service-guide-copy--enter');
    }

    if (overlay) overlay.dataset.slide = slide.id || '';
    renderDots();
}

async function finishGuide() {
    if (completing) return;
    completing = true;
    try {
        closeServiceGuideOverlay();
        if (typeof onCompleteCb === 'function') {
            const cb = onCompleteCb;
            onCompleteCb = null;
            cb();
        }
    } finally {
        completing = false;
    }
}

function onInstallCta() {
    const kind = getLandingAppPromoKind() || 'desktop';
    openOsInstallGuideModal(kind);
}

function bindOnce() {
    if (bound) return;
    bound = true;
    $('serviceGuideNextBtn')?.addEventListener('click', () => {
        if (currentIndex < slides.length - 1) {
            currentIndex += 1;
            renderSlide();
        } else {
            void finishGuide();
        }
    });
    $('serviceGuidePrevBtn')?.addEventListener('click', () => {
        if (currentIndex > 0) {
            currentIndex -= 1;
            renderSlide();
        }
    });
    $('serviceGuideSkipBtn')?.addEventListener('click', () => void finishGuide());
    $('serviceGuideInstallCta')?.addEventListener('click', onInstallCta);

    let touchX = null;
    const overlay = $('serviceGuideOverlay');
    overlay?.addEventListener(
        'touchstart',
        (e) => {
            touchX = e.changedTouches[0]?.clientX ?? null;
        },
        { passive: true }
    );
    overlay?.addEventListener(
        'touchend',
        (e) => {
            if (touchX == null) return;
            const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX;
            touchX = null;
            if (Math.abs(dx) < 56) return;
            if (dx < 0 && currentIndex < slides.length - 1) {
                currentIndex += 1;
                renderSlide();
            } else if (dx > 0 && currentIndex > 0) {
                currentIndex -= 1;
                renderSlide();
            }
        },
        { passive: true }
    );
}

export function isServiceGuideActive() {
    return active;
}

export function closeServiceGuideOverlay() {
    const overlay = $('serviceGuideOverlay');
    if (overlay) overlay.classList.add('hidden');
    document.documentElement.classList.remove('service-guide-active');
    unlockBodyScroll('serviceGuideOverlay');
    window._serviceGuideActive = false;
    active = false;
    currentIndex = 0;
}

/**
 * 로그인 화면 직전에 호출.
 * 로그인(비익명) 세션이 있을 때만 스킵 — 미로그인이면 매번 표시.
 * @returns {Promise<boolean>} 가이드를 띄웠으면 true
 */
export async function maybeStartLandingServiceGuide(options = {}) {
    onCompleteCb = typeof options.onComplete === 'function' ? options.onComplete : null;

    try {
        const { auth } = await import('./firebase.js');
        if (auth?.currentUser && !auth.currentUser.isAnonymous) {
            return false;
        }
    } catch (_) {}

    // 예전 1회 시청 플래그가 남아 있으면 정리
    clearLandingServiceGuideSeen();

    const overlay = $('serviceGuideOverlay');
    if (!overlay) return false;

    slides = buildSlides();
    if (!slides.length) return false;

    if (typeof window.dismissMealogBootSplash === 'function') {
        window.dismissMealogBootSplash();
    }

    bindOnce();
    currentIndex = 0;
    active = true;
    window._serviceGuideActive = true;
    document.documentElement.classList.add('service-guide-active');
    overlay.classList.remove('hidden');
    lockBodyScroll('serviceGuideOverlay');
    renderSlide();
    return true;
}

/** @deprecated 이름 호환 */
export async function maybeStartServiceGuide(options = {}) {
    return maybeStartLandingServiceGuide(options);
}

export function showOnboardingModal() {
    return maybeStartLandingServiceGuide();
}
export function closeOnboardingModal() {
    closeServiceGuideOverlay();
}
export function onboardingPrev() {
    if (currentIndex > 0) {
        currentIndex -= 1;
        renderSlide();
    }
}
export async function onboardingNext() {
    if (currentIndex < slides.length - 1) {
        currentIndex += 1;
        renderSlide();
    } else {
        await finishGuide();
    }
}
export async function onboardingSkip() {
    await finishGuide();
}

/** @deprecated 가입 후 플로우용 — no-op 유지 */
export function markServiceGuidePending() {}

/** 콘솔: `__mealogDebugServiceGuide()` */
if (typeof window !== 'undefined') {
    window.__mealogDebugServiceGuide = async () => {
        return maybeStartLandingServiceGuide({
            onComplete: () => window.location.reload(),
        });
    };
}
