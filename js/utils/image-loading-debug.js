/**
 * 개발 환경(localhost·LAN) 전용 이미지 로딩 계측.
 * 운영·스테이징 APK WebView에는 no-op — UI/토스트 노출 없음.
 */

const stats = {
    picks: { display: 0, thumb: 0, blur: 0, original: 0 },
    fallbacks: 0,
    urlHits: new Map(),
    resourceRequests: 0
};

let enabledCache = null;
let observerStarted = false;

function hostname() {
    return typeof window !== 'undefined' ? String(window.location.hostname || '').toLowerCase() : '';
}

/** localhost / LAN 개발 서버에서만 활성 */
export function isImageDebugEnabled() {
    if (enabledCache !== null) return enabledCache;
    const h = hostname();
    enabledCache =
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '0.0.0.0' ||
        h === '::1' ||
        h.startsWith('192.168.');
    return enabledCache;
}

function trackUrl(url) {
    if (!url) return;
    const prev = stats.urlHits.get(url) || 0;
    stats.urlHits.set(url, prev + 1);
    if (prev >= 1) {
        console.debug(`[mealog:img] duplicate url (${prev + 1}x)`, url.slice(0, 96));
    }
}

export function logImagePick(component, kind, url, originalUrl) {
    if (!isImageDebugEnabled() || !url) return;
    const k = kind === 'display' || kind === 'thumb' || kind === 'blur' || kind === 'original' ? kind : 'original';
    stats.picks[k] = (stats.picks[k] || 0) + 1;
    trackUrl(url);
    const usedFallback = !!(originalUrl && url !== originalUrl);
    console.debug(`[mealog:img] pick:${k} @${component || '?'}`, {
        usedFallback,
        url: url.slice(0, 96)
    });
}

export function logImageFallback(fromUrl, toUrl, component = 'onerror') {
    if (!isImageDebugEnabled()) return;
    stats.fallbacks += 1;
    if (fromUrl) trackUrl(fromUrl);
    if (toUrl) trackUrl(toUrl);
    console.debug(`[mealog:img] fallback @${component}`, {
        from: fromUrl ? fromUrl.slice(0, 96) : '',
        to: toUrl ? toUrl.slice(0, 96) : ''
    });
}

function snapshotStats() {
    const duplicates = [];
    stats.urlHits.forEach((count, url) => {
        if (count > 1) duplicates.push({ url: url.slice(0, 120), count });
    });
    duplicates.sort((a, b) => b.count - a.count);
    return {
        picks: { ...stats.picks },
        fallbacks: stats.fallbacks,
        resourceRequests: stats.resourceRequests,
        uniqueUrls: stats.urlHits.size,
        duplicateUrls: duplicates.slice(0, 30)
    };
}

function resetStats() {
    stats.picks = { display: 0, thumb: 0, blur: 0, original: 0 };
    stats.fallbacks = 0;
    stats.urlHits.clear();
    stats.resourceRequests = 0;
}

function startResourceObserver() {
    if (observerStarted || typeof PerformanceObserver === 'undefined') return;
    observerStarted = true;
    try {
        const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const name = entry.name || '';
                const type = entry.initiatorType || '';
                if (type === 'img' || type === 'css' || name.includes('firebasestorage.googleapis.com')) {
                    stats.resourceRequests += 1;
                    trackUrl(name);
                }
            }
        });
        obs.observe({ type: 'resource', buffered: true });
    } catch {
        /* PerformanceObserver 미지원 — pick/fallback 로그만 사용 */
    }
}

/** main.js 등에서 1회 호출 — window.__mealogImageDebug 노출 */
export function initImageLoadingDebug() {
    if (!isImageDebugEnabled() || typeof window === 'undefined') return;
    startResourceObserver();
    window.__mealogImageDebug = {
        enabled: true,
        stats: snapshotStats,
        reset: resetStats,
        dump() {
            const s = snapshotStats();
            console.debug('[mealog:img] stats', s);
            if (s.duplicateUrls.length) {
                console.table(s.duplicateUrls);
            }
            return s;
        }
    };
    console.debug('[mealog:img] dev image debug enabled — window.__mealogImageDebug.dump()');
}
