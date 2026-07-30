/**
 * 로그인 화면 하단 앱 설치 유도
 * Android: Play Store · iOS: 홈 화면 추가 · PC: 즐겨찾기 안내
 * 가이드 모달은 OS 탭(Android / iPhone / PC) 통합
 */

let deferredInstallPrompt = null;
let osInstallTabsBound = false;

const PLAY_STORE_URL =
    'https://play.google.com/store/apps/details?id=com.mealog.app&pcampaignid=web_share';

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

function getActiveOsInstallTab() {
    const active = document.querySelector('[data-os-tab][aria-selected="true"]');
    const tab = active?.getAttribute('data-os-tab');
    return tab === 'android' || tab === 'ios' || tab === 'desktop' ? tab : null;
}

function updateDesktopPwaInstallOptionalVisibility() {
    const tip = document.getElementById('desktopPwaInstallOptional');
    const activeTab = getActiveOsInstallTab();
    if (tip) tip.classList.toggle('hidden', activeTab !== 'desktop' || !deferredInstallPrompt);
    if (activeTab) updateOsInstallActions(activeTab);
}

/** 활성 탭에 맞춰 하단 버튼(확인 / 스토어 / 바로가기) 표시·가로 배치 */
function updateOsInstallActions(tab) {
    const actions = document.getElementById('osInstallActions');
    const playStore = document.getElementById('osInstallPlayStoreLink');
    const desktopInstall = document.getElementById('desktopShortcutInstallBtn');
    if (!actions) return;

    const showPlay = tab === 'android';
    const showDesktop = tab === 'desktop' && !!deferredInstallPrompt;
    if (playStore) playStore.classList.toggle('hidden', !showPlay);
    if (desktopInstall) desktopInstall.classList.toggle('hidden', !showDesktop);
    actions.classList.toggle('os-install-actions--dual', showPlay || showDesktop);
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
        closeOsInstallGuideModal();
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

/** @param {'android'|'ios'|'desktop'} tab */
export function setOsInstallGuideTab(tab) {
    const allowed = tab === 'android' || tab === 'ios' || tab === 'desktop' ? tab : 'desktop';
    document.querySelectorAll('[data-os-tab]').forEach((btn) => {
        const on = btn.getAttribute('data-os-tab') === allowed;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.classList.toggle('is-active', on);
    });
    document.querySelectorAll('.os-install-panel').forEach((panel) => {
        const id = panel.id || '';
        const match =
            (allowed === 'android' && id === 'osInstallPanelAndroid') ||
            (allowed === 'ios' && id === 'osInstallPanelIos') ||
            (allowed === 'desktop' && id === 'osInstallPanelDesktop');
        panel.classList.toggle('hidden', !match);
    });
    if (allowed === 'desktop') updateDesktopPwaInstallOptionalVisibility();
    else {
        const tip = document.getElementById('desktopPwaInstallOptional');
        if (tip) tip.classList.add('hidden');
    }
    updateOsInstallActions(allowed);
    if (typeof window.lucide?.createIcons === 'function') {
        try {
            window.lucide.createIcons();
        } catch (_) {}
    }
}

/**
 * @param {'android'|'ios'|'desktop'|null} [preferredTab]
 */
export function openOsInstallGuideModal(preferredTab = null) {
    const modal = document.getElementById('pwaInstallGuideModal');
    if (!modal) return;
    const kind = preferredTab || getLandingAppPromoKind() || 'desktop';
    setOsInstallGuideTab(kind);
    modal.classList.remove('hidden');
}

export function closeOsInstallGuideModal() {
    const modal = document.getElementById('pwaInstallGuideModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

/** @deprecated 통합 모달 — iOS 탭 */
export function openPwaInstallGuideModal() {
    openOsInstallGuideModal('ios');
}

export function closePwaInstallGuideModal() {
    closeOsInstallGuideModal();
}

/** @deprecated 통합 모달 — PC 탭 */
export function openDesktopShortcutGuideModal() {
    openOsInstallGuideModal('desktop');
}

export function closeDesktopShortcutGuideModal() {
    closeOsInstallGuideModal();
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
    openOsInstallGuideModal('desktop');
}

function bindOsInstallTabsOnce() {
    if (osInstallTabsBound) return;
    osInstallTabsBound = true;
    document.querySelectorAll('[data-os-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tab = btn.getAttribute('data-os-tab');
            if (tab === 'android' || tab === 'ios' || tab === 'desktop') {
                setOsInstallGuideTab(tab);
            }
        });
    });
}

export function registerPwaInstallGuideHandlers() {
    initDeferredInstallPrompt();
    bindOsInstallTabsOnce();

    const pwaOpenBtn = document.getElementById('pwaInstallOpenGuideBtn');
    const pwaModal = document.getElementById('pwaInstallGuideModal');
    const pwaCloseBtn = document.getElementById('pwaInstallGuideCloseBtn');
    const pwaBackdrop = document.getElementById('pwaInstallGuideBackdrop');

    if (pwaOpenBtn) {
        pwaOpenBtn.addEventListener('click', () => openOsInstallGuideModal('ios'));
    }
    if (pwaCloseBtn) {
        pwaCloseBtn.addEventListener('click', closeOsInstallGuideModal);
    }
    if (pwaBackdrop) {
        pwaBackdrop.addEventListener('click', closeOsInstallGuideModal);
    }
    if (pwaModal) {
        pwaModal.addEventListener('click', (e) => {
            if (e.target === pwaModal) closeOsInstallGuideModal();
        });
    }

    const desktopOpenBtn = document.getElementById('desktopShortcutOpenGuideBtn');
    const desktopInstallBtn = document.getElementById('desktopShortcutInstallBtn');
    const apkLink = document.getElementById('apkDownloadLink');

    if (desktopOpenBtn) {
        desktopOpenBtn.addEventListener('click', handleDesktopPromoClick);
    }
    if (desktopInstallBtn) {
        desktopInstallBtn.addEventListener('click', async () => {
            const installed = await tryTriggerDesktopPwaInstall();
            if (installed) closeOsInstallGuideModal();
        });
    }
    // 랜딩 Android 배너는 스토어 직행 유지. 가이드 「방법 보기」는 탭 모달 사용.
    if (apkLink && !apkLink.getAttribute('href')) {
        apkLink.setAttribute('href', PLAY_STORE_URL);
    }
}
