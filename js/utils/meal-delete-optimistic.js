/**
 * 식사 기록 삭제 시 mealHistory·dailyStats·모먼트 캐시 낙관적 반영 (entry-and-core·스냅샷 공용)
 */
import { clearMealEntrySaveFailedById } from './meal-entry-pending.js';

const DELETE_OPT_MAIN = new Set(['morning', 'lunch', 'dinner']);
const DELETE_OPT_SNACK = new Set(['pre_morning', 'snack1', 'snack2', 'night']);

/**
 * @returns {{ meal: object, prevDayStats: object | null, dateIso: string, hadShared: boolean } | null}
 */
export function applyOptimisticMealDelete(mealId, preloadedMeal = null) {
    if (mealId) clearMealEntrySaveFailedById(mealId);
    const meal =
        (preloadedMeal && preloadedMeal.id === mealId ? preloadedMeal : null) ||
        window.mealHistory?.find((m) => m.id === mealId);
    if (!meal) return null;
    const dateIso = typeof meal.date === 'string' ? meal.date : '';
    const slotId = meal.slotId || '';
    let prevDayStats = null;

    window.mealHistory = window.mealHistory.filter((m) => m.id !== mealId);

    if (dateIso && window.dailyStats && typeof window.dailyStats === 'object') {
        const day = window.dailyStats[dateIso];
        if (day && typeof day === 'object') {
            prevDayStats = JSON.parse(JSON.stringify(day));
            const count = Math.max(0, (day.count || 0) - 1);
            if (count <= 0) {
                const next = { ...window.dailyStats };
                delete next[dateIso];
                window.dailyStats = next;
            } else {
                let mainCount = day.mainCount || 0;
                let snackCount = day.snackCount || 0;
                if (DELETE_OPT_MAIN.has(slotId) && mainCount > 0) mainCount -= 1;
                else if (DELETE_OPT_SNACK.has(slotId) && snackCount > 0) snackCount -= 1;
                window.dailyStats = {
                    ...window.dailyStats,
                    [dateIso]: { ...day, count, mainCount, snackCount }
                };
            }
        }
    }

    try {
        if (typeof window.fillProfileActivityStats === 'function') window.fillProfileActivityStats();
    } catch (_) {
        /* ignore */
    }

    const hadShared = Array.isArray(meal.sharedPhotos) && meal.sharedPhotos.length > 0;
    if (hadShared && window.sharedPhotos) {
        window.sharedPhotos = window.sharedPhotos.filter((p) => p.entryId !== mealId);
    }
    if (window.sharedPhotosFeed) {
        window.sharedPhotosFeed = window.sharedPhotosFeed.filter((p) => p.entryId !== mealId);
    }

    return { meal, prevDayStats, dateIso, hadShared };
}

export function rollbackOptimisticMealDelete(ctx) {
    if (!ctx?.meal) return;
    const m = ctx.meal;
    window.mealHistory = [...(window.mealHistory || []), m].sort(
        (a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
    );
    if (ctx.dateIso && ctx.prevDayStats && window.dailyStats && typeof window.dailyStats === 'object') {
        window.dailyStats = { ...window.dailyStats, [ctx.dateIso]: ctx.prevDayStats };
    }
    if (ctx.hadShared && Array.isArray(m.sharedPhotos) && m.sharedPhotos.length && window.currentUser?.uid) {
        if (!window.sharedPhotos) window.sharedPhotos = [];
        const uid = window.currentUser.uid;
        const entries = m.sharedPhotos.map((photoUrl) => ({ entryId: m.id, photoUrl, userId: uid }));
        window.sharedPhotos = window.sharedPhotos.filter((p) => p.entryId !== m.id).concat(entries);
    }
    try {
        if (typeof window.fillProfileActivityStats === 'function') window.fillProfileActivityStats();
    } catch (_) {
        /* ignore */
    }
}
