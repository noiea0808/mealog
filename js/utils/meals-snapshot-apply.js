/**
 * Firestore meals 쿼리 onSnapshot 콜백 본문 — 판단·병합·ack는 여기서만.
 * listeners.js는 스냅샷 수신 + 이 모듈 호출만 담당.
 */
import {
    addDaysToYmd,
    applyDemoDateShiftToDailyComments,
    applyDemoDateShiftToMeals,
    computeDemoDateShiftDays,
    todayLocalYmd
} from '../demo-date-shift.js';
import { findUniqueMeals, dedupeMealListOnly } from './find-unique-meals.js';
import {
    MealSyncManager,
    getMealSyncManager,
    mealDocSnapshotAppearsServerAcked,
    mergePreserveLocalSaveFailed,
    shouldPreserveMealSaveFailureOnMerge
} from './meal-sync-manager.js';
import {
    clearStuckMealPendingFlags,
    markMealEntryServerSynced,
    onMealDocFirestoreServerAcknowledged
} from './meal-entry-pending.js';

function triggerLoadMyShares() {
    void import('../db.js').then(({ loadMyShares }) => {
        loadMyShares()
            .then((list) => {
                window.sharedPhotos = list;
                if (typeof window.updateTimelineShareIndicators === 'function') {
                    window.updateTimelineShareIndicators();
                }
            })
            .catch(() => {});
    }).catch(() => {});
}

/**
 * @param {*} snap QuerySnapshot
 * @param {{ mergeStatsIntoDaily: () => void, onDataUpdate?: () => void, slice50: boolean }} opts
 */
function applyDemoMealsBranch(snap, { mergeStatsIntoDaily, onDataUpdate, slice50 }) {
    let rawMeals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (slice50) {
        rawMeals.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        rawMeals = rawMeals.slice(0, 50);
    }
    const shift = computeDemoDateShiftDays(rawMeals);
    window.__demoDateShiftDays = shift;
    window.mealHistory = applyDemoDateShiftToMeals(rawMeals, shift).sort(
        (a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time)
    );
    const rawDates = rawMeals
        .map((m) => m.date)
        .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (rawDates.length && shift) {
        const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
        window.loadedMealsDateRange = {
            start: addDaysToYmd(minRaw, shift),
            end: todayLocalYmd()
        };
    } else if (rawDates.length) {
        const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
        const maxRaw = rawDates.reduce((a, b) => (a > b ? a : b));
        window.loadedMealsDateRange = { start: minRaw, end: maxRaw };
    } else {
        const tl = todayLocalYmd();
        window.loadedMealsDateRange = { start: tl, end: tl };
    }
    if (window.userSettings && window.__demoRawDailyComments) {
        window.userSettings.dailyComments = applyDemoDateShiftToDailyComments(
            window.__demoRawDailyComments,
            shift
        );
    }
    mergeStatsIntoDaily();
    snap.docs.forEach((d) => {
        if (mealDocSnapshotAppearsServerAcked(d.metadata, { allowFromCacheAck: true })) {
            markMealEntryServerSynced(d.id);
        }
    });
    if (onDataUpdate) onDataUpdate();
    triggerLoadMyShares();
}

/**
 * primary meals onSnapshot 본문 (데모 아님 경로에서만 clearStuck + onDataUpdate 마지막에 호출)
 * @param {{ snap: *, demo: boolean, userId: string, cutoffDateStr: string, todayStr: string, loadState: { isInitialLoad: boolean }, mergeStatsIntoDaily: () => void, onDataUpdate?: () => void }} p
 * @returns {{ uidMismatch: boolean }}
 */
export function applyMealsSnapshotPrimary(p) {
    const { snap, demo, userId, cutoffDateStr, todayStr, loadState, mergeStatsIntoDaily, onDataUpdate } = p;

    if (window.currentUser && userId !== window.currentUser.uid) {
        console.error('⚠️ ⚠️ ⚠️ 데이터 리스너 콜백: 사용자 ID 불일치 감지!', {
            listenerUserId: userId,
            currentUserUid: window.currentUser.uid,
            email: window.currentUser?.email
        });
        return { uidMismatch: true };
    }

    if (demo) {
        applyDemoMealsBranch(snap, { mergeStatsIntoDaily, onDataUpdate, slice50: false });
        loadState.isInitialLoad = false;
        return { uidMismatch: false };
    }

    if (loadState.isInitialLoad) {
        const prevForMerge = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        const serverMapped = snap.docs
            .map((d) => {
                const row = { id: d.id, ...d.data() };
                const sid = String(d.id);
                if (getMealSyncManager().hasErrorId(sid)) {
                    row._localSaveFailed = true;
                    row.is_sync_error = true;
                }
                return row;
            })
            .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        window.mealHistory = findUniqueMeals(serverMapped, prevForMerge);
        window.loadedMealsDateRange = { start: cutoffDateStr, end: todayStr };
        loadState.isInitialLoad = false;
        snap.docs.forEach((d) => {
            if (mealDocSnapshotAppearsServerAcked(d.metadata, { allowFromCacheAck: true })) {
                onMealDocFirestoreServerAcknowledged(d.id, null);
            }
        });
    } else {
        const changes = snap.docChanges();
        let hasChanges = false;

        changes.forEach((change) => {
            if (change.type === 'removed') {
                const rid = change.doc.id;
                window.mealHistory = window.mealHistory.filter((m) => m.id !== rid);
                hasChanges = true;
                return;
            }
            const docData = { id: change.doc.id, ...change.doc.data() };
            if (change.type === 'added' || change.type === 'modified') {
                const serverAcked = mealDocSnapshotAppearsServerAcked(change.doc.metadata, {
                    allowFromCacheAck: false
                });
                const index = window.mealHistory.findIndex((m) => m.id === docData.id);
                const slotKey = `${docData.date || ''}__${docData.slotId || ''}`;
                const mgrSync = getMealSyncManager();
                const isPendingUpload = Boolean(
                    mgrSync.hasPendingPhotoEntry(docData.id) || mgrSync.hasPendingPhotoSlot(slotKey)
                );
                if (index >= 0) {
                    const localRecord = window.mealHistory[index];
                    const localPhotos = Array.isArray(localRecord?.photos)
                        ? localRecord.photos
                        : localRecord?.photos
                          ? [localRecord.photos]
                          : [];
                    const hasLocalBase64Preview = localPhotos.some(
                        (p) => typeof p === 'string' && p.startsWith('data:image')
                    );
                    const shouldKeepLocalPreview = isPendingUpload && hasLocalBase64Preview;

                    let mergedRow;
                    if (shouldKeepLocalPreview) {
                        const merged = { ...docData, photos: [...localPhotos] };
                        mergedRow = mergePreserveLocalSaveFailed(merged, localRecord);
                    } else {
                        mergedRow = mergePreserveLocalSaveFailed(docData, localRecord);
                    }
                    if (serverAcked) {
                        mergedRow = { ...mergedRow };
                        const lockFail = shouldPreserveMealSaveFailureOnMerge(localRecord, docData.id);
                        if (!lockFail) {
                            delete mergedRow._localSaveFailed;
                            delete mergedRow.is_sync_error;
                        }
                        onMealDocFirestoreServerAcknowledged(docData.id, null);
                    }
                    window.mealHistory[index] = mergedRow;
                } else {
                    const tempIdx = window.mealHistory.findIndex(
                        (m) =>
                            typeof m?.id === 'string' &&
                            m.id.startsWith('temp_') &&
                            m.date === docData.date &&
                            m.slotId === docData.slotId
                    );
                    if (tempIdx >= 0) {
                        const tempRecord = window.mealHistory[tempIdx];
                        const tempPhotos = Array.isArray(tempRecord?.photos)
                            ? tempRecord.photos
                            : tempRecord?.photos
                              ? [tempRecord.photos]
                              : [];
                        const hasTempBase64 = tempPhotos.some(
                            (p) => typeof p === 'string' && p.startsWith('data:image')
                        );
                        const keepTempPreview =
                            (isPendingUpload || mgrSync.hasPendingPhotoEntry(tempRecord.id)) && hasTempBase64;
                        const mergedTemp = keepTempPreview
                            ? { ...docData, photos: [...tempPhotos] }
                            : docData;
                        let mergedRow = mergePreserveLocalSaveFailed(mergedTemp, tempRecord);
                        if (serverAcked) {
                            mergedRow = { ...mergedRow };
                            const lockFail = shouldPreserveMealSaveFailureOnMerge(tempRecord, docData.id);
                            if (!lockFail) {
                                delete mergedRow._localSaveFailed;
                                delete mergedRow.is_sync_error;
                            }
                            onMealDocFirestoreServerAcknowledged(docData.id, tempRecord.id);
                        }
                        window.mealHistory[tempIdx] = mergedRow;
                        if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                            window.sharedPhotos = window.sharedPhotos.map((p) =>
                                p.entryId === tempRecord.id ? { ...p, entryId: docData.id } : p
                            );
                        }
                        if (mgrSync.hasPendingPhotoEntry(tempRecord.id)) {
                            mgrSync.movePendingPhotoTempToReal(tempRecord.id, docData.id);
                        }
                    } else {
                        window.mealHistory.push(docData);
                        if (serverAcked) {
                            const lockFail = shouldPreserveMealSaveFailureOnMerge(null, docData.id);
                            const row = { ...docData };
                            if (!lockFail) {
                                delete row._localSaveFailed;
                                delete row.is_sync_error;
                            }
                            window.mealHistory[window.mealHistory.length - 1] = row;
                            onMealDocFirestoreServerAcknowledged(docData.id, null);
                        }
                    }
                }
                hasChanges = true;
            }
        });

        if (hasChanges) {
            window.mealHistory.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            window.mealHistory = dedupeMealListOnly(window.mealHistory);
        }
    }

    clearStuckMealPendingFlags();
    if (onDataUpdate) onDataUpdate();
    return { uidMismatch: false };
}

/**
 * 날짜 범위 쿼리 실패 시 fallback 전체 컬렉션 리스너 콜백 본문
 * @param {{ snap: *, demo: boolean, userId: string, mergeStatsIntoDaily: () => void, onDataUpdate?: () => void, firstSnapshotState: { value: boolean } }} p
 */
export function applyMealsSnapshotFallback(p) {
    const { snap, demo, userId, mergeStatsIntoDaily, onDataUpdate, firstSnapshotState } = p;

    if (window.currentUser && userId !== window.currentUser.uid) {
        console.error('⚠️ Fallback 리스너: 사용자 ID 불일치! 무시');
        return { uidMismatch: true };
    }

    if (demo) {
        applyDemoMealsBranch(snap, { mergeStatsIntoDaily, onDataUpdate, slice50: true });
        return { uidMismatch: false };
    }

    const prevForMerge = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const serverMapped = snap.docs
        .map((d) => {
            const row = { id: d.id, ...d.data() };
            const sid = String(d.id);
            if (getMealSyncManager().hasErrorId(sid)) {
                row._localSaveFailed = true;
                row.is_sync_error = true;
            }
            return row;
        })
        .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
    window.mealHistory = findUniqueMeals(serverMapped, prevForMerge);
    const allowFromCacheAck = firstSnapshotState.value;
    snap.docs.forEach((d) => {
        if (
            mealDocSnapshotAppearsServerAcked(d.metadata, {
                allowFromCacheAck
            })
        ) {
            onMealDocFirestoreServerAcknowledged(d.id, null);
        }
    });
    firstSnapshotState.value = false;
    if (onDataUpdate) onDataUpdate();
    return { uidMismatch: false };
}

MealSyncManager.prototype.applyPrimaryMealsSnapshot = function (ctx) {
    return applyMealsSnapshotPrimary(ctx);
};

MealSyncManager.prototype.applyFallbackMealsSnapshot = function (ctx) {
    return applyMealsSnapshotFallback(ctx);
};
