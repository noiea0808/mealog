/**
 * 로그인 화면 하단 앱 설치 유도
 * Android: Play Store · iOS: 홈 화면 추가 · PC: 즐겨찾기 안내
 */

let deferredInstallPrompt = null;

export function isCapacitorNative() {
    try {
        return !!window.Capacitor?.isNativePlatform?.();
    } catch (_) {
        return false;
    }
}

export function isIOSDevice() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/i.test(ua)) return true;
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

export function isAndroidDevice() {
    return /Android/i.test(navigator.userAgent || '');
}

export function isRunningAsInstalledPwa() {
    if (window.navigator.standalone === true) return true;
    try {
        if (window.matchMedia('(display-mode: standalone)').matches) return true;
        if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
    } catch (_) {}
    return false;
}

/** @returns {'android' | 'ios' | 'desktop' | null} */
export function getLandingAppPromoKind() {
    if (isCapacitorNative()) return null;
    if (isRunningAsInstalledPwa()) return null;
    if (isIOSDevice()) return 'ios';
    if (isAndroidDevice()) return 'android';
    return 'desktop';
}

function getPromoElements() {
    return {
        apkSection: document.getElementById('apkDownloadSection'),
        pwaSection: document.getElementById('pwaInstallSection'),
        desktopSection: document.getElementById('desktopShortcutSection'),
    };
}

function updateDesktopPwaInstallOptionalVisibility() {
    const wrap = document.getElementById('desktopPwaInstallOptional');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !deferredInstallPrompt);
}

export function initDeferredInstallPrompt() {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        updateDesktopPwaInstallOptionalVisibility();
    });
    window.addEventListener('appinstalled', () => {
        deferredInstallPrompt = null;
        updateDesktopPwaInstallOptionalVisibility();
        closeDesktopShortcutGuideModal();
    });
}

export function configureLandingAppPromo() {
    const { apkSection, pwaSection, desktopSection } = getPromoElements();
    if (isCapacitorNative()) {
        if (apkSection) apkSection.style.display = 'none';
        if (pwaSection) pwaSection.style.display = 'none';
        if (desktopSection) desktopSection.style.display = 'none';
        return;
    }
    if (apkSection) apkSection.style.display = '';
    if (pwaSection) pwaSection.style.display = '';
    if (desktopSection) desktopSection.style.display = '';
}

export function showLandingAppPromo() {
    const kind = getLandingAppPromoKind();
    const { apkSection, pwaSection, desktopSection } = getPromoElements();
    if (apkSection) apkSection.classList.add('hidden');
    if (pwaSection) pwaSection.classList.add('hidden');
    if (desktopSection) desktopSection.classList.add('hidden');
    if (kind === 'android' && apkSection) {
        apkSection.classList.remove('hidden');
    } else if (kind === 'ios' && pwaSection) {
        pwaSection.classList.remove('hidden');
    } else if (kind === 'desktop' && desktopSection) {
        desktopSection.classList.remove('hidden');
    }
}

export function openPwaInstallGuideModal() {
    const modal = document.getElementById('pwaInstallGuideModal');
    if (!modal) return;
    modal.classList.remove('hidden');
}

export function closePwaInstallGuideModal() {
    const modal = document.getElementById('pwaInstallGuideModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

export function openDesktopShortcutGuideModal() {
    const modal = document.getElementById('desktopShortcutGuideModal');
    if (!modal) return;
    updateDesktopPwaInstallOptionalVisibility();
    modal.classList.remove('hidden');
}

export function closeDesktopShortcutGuideModal() {
    const modal = document.getElementById('desktopShortcutGuideModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

async function tryTriggerDesktopPwaInstall() {
    if (!deferredInstallPrompt) return false;
    try {
        await deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
    } catch (_) {
        return false;
    }
    deferredInstallPrompt = null;
    updateDesktopPwaInstallOptionalVisibility();
    return true;
}

/** PC: 즐겨찾기는 브라우저가 자동 추가를 막음 → 안내 모달. PWA 지원 시에만 원클릭 바탕화면 추가 시도 */
async function handleDesktopPromoClick() {
    if (deferredInstallPrompt) {
        const installed = await tryTriggerDesktopPwaInstall();
        if (installed) return;
    }
    openDesktopShortcutGuideModal();
}

export function registerPwaInstallGuideHandlers() {
    initDeferredInstallPrompt();

    const pwaOpenBtn = document.getElementById('pwaInstallOpenGuideBtn');
    const pwaModal = document.getElementById('pwaInstallGuideModal');
    const pwaCloseBtn = document.getElementById('pwaInstallGuideCloseBtn');
    const pwaBackdrop = document.getElementById('pwaInstallGuideBackdrop');

    if (pwaOpenBtn) {
        pwaOpenBtn.addEventListener('click', openPwaInstallGuideModal);
    }
    if (pwaCloseBtn) {
        pwaCloseBtn.addEventListener('click', closePwaInstallGuideModal);
    }
    if (pwaBackdrop) {
        pwaBackdrop.addEventListener('click', closePwaInstallGuideModal);
    }
    if (pwaModal) {
        pwaModal.addEventListener('click', (e) => {
            if (e.target === pwaModal) closePwaInstallGuideModal();
        });
    }

    const desktopOpenBtn = document.getElementById('desktopShortcutOpenGuideBtn');
    const desktopModal = document.getElementById('desktopShortcutGuideModal');
    const desktopCloseBtn = document.getElementById('desktopShortcutGuideCloseBtn');
    const desktopBackdrop = document.getElementById('desktopShortcutGuideBackdrop');
    const desktopInstallBtn = document.getElementById('desktopShortcutInstallBtn');

    if (desktopOpenBtn) {
        desktopOpenBtn.addEventListener('click', handleDesktopPromoClick);
    }
    if (desktopCloseBtn) {
        desktopCloseBtn.addEventListener('click', closeDesktopShortcutGuideModal);
    }
    if (desktopBackdrop) {
        desktopBackdrop.addEventListener('click', closeDesktopShortcutGuideModal);
    }
    if (desktopModal) {
        desktopModal.addEventListener('click', (e) => {
            if (e.target === desktopModal) closeDesktopShortcutGuideModal();
        });
    }
    if (desktopInstallBtn) {
        desktopInstallBtn.addEventListener('click', async () => {
            const installed = await tryTriggerDesktopPwaInstall();
            if (installed) closeDesktopShortcutGuideModal();
        });
    }
}
