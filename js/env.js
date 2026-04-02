// 로컬 개발용 기본값 (npm run copy:www 시 www/js/env.js 의 APP_ENV 는 capacitor appId 기준으로 갱신됨)
window.APP_ENV = 'production';
//
// 배지(개발/스테이징/운영) 안내 — 루트 index 를 localhost 로 열면 기본은 항상 「개발」(파랑)입니다.
// 「스테이징」(주황)을 보려면 아래 중 하나:
//   · 스테이징 배포 URL (호스트에 staging 포함) 또는 www 빌드(APP_ENV=staging)
//   · 로컬에서만: URL 에 ?mealogBadgeEnv=staging 또는 콘솔 localStorage.setItem('mealogBadgeEnv','staging')
//

/**
 * 브라우저에서 로컬/사설망 개발 호스트로 간주할지 (Capacitor 네이티브는 여기서 false).
 */
window.isMealogLocalWebHost = function isMealogLocalWebHost() {
    if (typeof window === 'undefined' || !window.location) return false;
    try {
        if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
            return false;
        }
    } catch (e) {
        /* ignore */
    }
    var loc = window.location;
    var protocol = String(loc.protocol || '').toLowerCase();
    if (protocol === 'file:') return true;
    var hostname = String(loc.hostname || '').toLowerCase();
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return true;
    if (hostname === '::1' || hostname === '[::1]') return true;
    if (hostname === '10.0.2.2') return true;
    if (hostname.indexOf('192.168.') === 0) return true;
    if (hostname.slice(-6) === '.local') return true;
    return false;
};

/**
 * 로컬에서만 배지 강제 (디자인 확인·스테이징 UI 테스트). 운영 호스트에서는 무시.
 * @returns {'개발'|'스테이징'|'운영'|null}
 */
window.getMealogUiEnvironmentLabelLocalOverride = function getMealogUiEnvironmentLabelLocalOverride() {
    if (!window.isMealogLocalWebHost || !window.isMealogLocalWebHost()) return null;
    try {
        var q = new URLSearchParams(window.location.search || '').get('mealogBadgeEnv');
        if (q === 'staging') return '스테이징';
        if (q === 'prod' || q === 'production') return '운영';
        if (q === 'dev' || q === 'development') return '개발';
        var ls = localStorage.getItem('mealogBadgeEnv');
        if (ls === 'staging') return '스테이징';
        if (ls === 'prod' || ls === 'production') return '운영';
        if (ls === 'dev' || ls === 'development') return '개발';
    } catch (e) {
        /* ignore */
    }
    return null;
};

/**
 * UI 배지용: 로컬 개발 / 스테이징 / 운영
 * — 네이티브 패키지 → 로컬 오버라이드 → 스테이징 URL·APP_ENV → 로컬 호스트.
 * @returns {'개발'|'스테이징'|'운영'}
 */
window.getMealogUiEnvironmentLabel = function getMealogUiEnvironmentLabel() {
    if (typeof window === 'undefined') return '운영';
    try {
        var cap = window.Capacitor;
        var capAppId = cap && cap.config && String(cap.config.appId || '').trim();
        if (capAppId === 'com.mealog.app.staging') return '스테이징';
        if (capAppId === 'com.mealog.app') return '운영';
    } catch (e) {
        /* ignore */
    }
    var overridden =
        window.getMealogUiEnvironmentLabelLocalOverride && window.getMealogUiEnvironmentLabelLocalOverride();
    if (overridden) return overridden;
    var hostname = (window.location && String(window.location.hostname || '').toLowerCase()) || '';
    if (hostname.indexOf('staging') !== -1) return '스테이징';
    if (window.APP_ENV === 'staging') return '스테이징';
    if (window.isMealogLocalWebHost && window.isMealogLocalWebHost()) return '개발';
    return '운영';
};

/**
 * @param {HTMLElement | null} el
 * @param {{ hideProduction?: boolean }} [opts]
 */
window.applyMealogEnvironmentBadge = function applyMealogEnvironmentBadge(el, opts) {
    if (!el) return;
    var hideProduction = opts && opts.hideProduction === true;
    var label = window.getMealogUiEnvironmentLabel();
    if (hideProduction && label === '운영') {
        el.textContent = '';
        el.className = 'hidden';
        el.setAttribute('aria-hidden', 'true');
        return;
    }
    el.removeAttribute('aria-hidden');
    el.setAttribute('aria-label', '실행 환경: ' + label);
    el.textContent = label;
    var base = 'px-2 py-0.5 rounded-md text-[10px] font-black tracking-tight shrink-0 leading-none shadow-sm';
    if (label === '개발') {
        el.className = base + ' bg-blue-600 text-white';
    } else if (label === '스테이징') {
        el.className = base + ' bg-orange-500 text-white';
    } else {
        el.className = base + ' bg-slate-100 text-slate-500 shadow-none';
    }
};

/**
 * 밀로그 index: 랜딩 + 메인 헤더 배지를 한 번에 갱신 (로그인 전/후 모두).
 */
window.refreshMealogAppEnvironmentBadges = function refreshMealogAppEnvironmentBadges() {
    if (typeof window.applyMealogEnvironmentBadge !== 'function') return;
    window.applyMealogEnvironmentBadge(document.getElementById('landingEnvBadge'), { hideProduction: true });
    window.applyMealogEnvironmentBadge(document.getElementById('headerEnvBadge'), { hideProduction: true });
};

if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('mealog:mainScreenShown', function () {
        if (typeof window.refreshMealogAppEnvironmentBadges === 'function') {
            window.refreshMealogAppEnvironmentBadges();
        }
    });
}
