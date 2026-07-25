/**
 * 밀당(analytics) 모듈 지연 로드 — 첫 진입/HTML onclick 시점에만 로드
 */
let _loadPromise = null;
let _analyticsMod = null;
let _bestShareMod = null;

const WINDOW_BINDINGS = [
    ['setDashboardMode', (m) => m.setDashboardMode],
    ['updateCustomDates', (m) => m.updateCustomDates],
    ['syncCustomDatePlaceholder', (m) => m.syncCustomDatePlaceholder],
    ['updateSelectedMonth', (m) => m.updateSelectedMonth],
    ['updateSelectedWeek', (m) => m.updateSelectedWeek],
    ['changeWeek', (m) => m.changeWeek],
    ['changeMonth', (m) => m.changeMonth],
    ['navigatePeriod', (m) => m.navigatePeriod],
    ['openDetailModal', (m) => m.openDetailModal],
    ['closeDetailModal', (m) => m.closeDetailModal],
    ['openCharacterSelectModal', (m) => m.openCharacterSelectModal],
    ['closeCharacterSelectModal', (m) => m.closeCharacterSelectModal],
    ['selectInsightCharacter', (m) => m.selectInsightCharacter],
    ['generateInsightComment', (m) => m.generateInsightComment],
    ['openShareInsightModal', (m) => m.openShareInsightModal],
    ['closeShareInsightModal', (m) => m.closeShareInsightModal],
    ['shareInsightToFeed', (m) => m.shareInsightToFeed],
    ['setAnalysisType', (m) => m.setAnalysisType],
    ['setAnalysisSlotFilter', (m) => m.setAnalysisSlotFilter],
    ['setMealdangView', (m) => m.setMealdangView],
    ['openShareBestModal', (m) => m.openShareBestModal],
    ['closeShareBestModal', (m) => m.closeShareBestModal],
    ['closeBestSharePeriodNotice', (m) => m.closeBestSharePeriodNotice],
    ['shareBestToFeed', (m) => m.shareBestToFeed],
    ['editInsightShare', (m) => m.openEditInsightShareModal],
    ['updateDashboard', (m) => m.updateDashboard]
];

function assignWindow(name, fn) {
    if (typeof fn !== 'function') return;
    window[name] = fn;
    if (window.Mealog) window.Mealog[name] = fn;
}

function bindAnalyticsWindow(analyticsMod, bestShareMod) {
    for (const [name, pick] of WINDOW_BINDINGS) {
        assignWindow(name, pick(analyticsMod));
    }
    if (bestShareMod?.openEditBestShareModal) {
        assignWindow('editBestShare', bestShareMod.openEditBestShareModal);
    }
}

/**
 * analytics + best-share 로드 후 window 바인딩·UI 초기화
 * @returns {Promise<typeof import('../analytics.js')>}
 */
export function ensureAnalytics() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
        const [analyticsMod, bestShareMod] = await Promise.all([
            import('../analytics.js'),
            import('./best-share.js')
        ]);
        _analyticsMod = analyticsMod;
        _bestShareMod = bestShareMod;
        bindAnalyticsWindow(analyticsMod, bestShareMod);
        try {
            analyticsMod.initDashboardAnalysisUi?.();
        } catch (e) {
            console.warn('[analytics] initDashboardAnalysisUi 실패:', e);
        }
        return analyticsMod;
    })().catch((err) => {
        _loadPromise = null;
        throw err;
    });
    return _loadPromise;
}

/** HTML onclick용 — 로드 전에도 호출 가능 */
export function installAnalyticsLazyStubs() {
    window.Mealog = window.Mealog || {};
    for (const [name, pick] of WINDOW_BINDINGS) {
        if (typeof window[name] === 'function' && window[name].__mealogAnalyticsLazy) continue;
        const stub = async (...args) => {
            const mod = await ensureAnalytics();
            const fn = pick(mod);
            if (typeof fn !== 'function') {
                console.warn(`[analytics] ${name} 없음`);
                return undefined;
            }
            return fn(...args);
        };
        stub.__mealogAnalyticsLazy = true;
        assignWindow(name, stub);
    }
    if (typeof window.editBestShare !== 'function' || window.editBestShare.__mealogAnalyticsLazy) {
        const stub = async (...args) => {
            await ensureAnalytics();
            const fn = _bestShareMod?.openEditBestShareModal;
            if (typeof fn !== 'function') {
                console.warn('[analytics] editBestShare 없음');
                return undefined;
            }
            return fn(...args);
        };
        stub.__mealogAnalyticsLazy = true;
        assignWindow('editBestShare', stub);
    }
}

export function getCachedAnalytics() {
    return _analyticsMod;
}
