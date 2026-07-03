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
    mealRecordHasBase64PendingPhotos,
    mergePreserveLocalSaveFailed,
    shouldPreserveMealSaveFailureOnMerge
} from './meal-sync-manager.js';
import {
    clearStuckMealPendingFlags,
    markMealEntryServerSynced,
    markMealEntryDeleteComplete,
    onMealDocFirestoreServerAcknowledged,
    scheduleReconcileStaleMealSyncDotsAfterSnapshot
} from './meal-entry-pending.js';
import { applyOptimisticMealDelete } from './meal-delete-optimistic.js';
import { showToast } from '../ui.js';
import { applyStreakTrustPatchesToDailyStats, stripGhostDailyStatsInQueryWindow, invalidateMealHistoryCountCache } from '../meal-record-count.js';
import { appState } from '../state.js';

/** mealHistory에서 YYYY-MM-DD 최소일 (없으면 null). limit(50)으로 초기 스냅샷에 구멍이 생길 때 loaded 범위와 일치시키기 위함 */
function minMealDateYmd(meals) {
    if (!Array.isArray(meals) || !meals.length) return null;
    let min = null;
    for (const m of meals) {
        const d = m?.date;
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
            if (min == null || d < min) min = d;
        }
    }
    return min;
}

/** 전송 계층 오프라인만 — 연결 오버레이 표시만으로는 서버 removed 를 막지 않음(복구 직후 고착 방지) */
function mealsSnapshotDeleteHoldWhileTransportOffline() {
    if (appState.localNetworkForcedOffline === true) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return false;
}

function countDataImageInPhotos(recordOrDoc) {
    const arr = Array.isArray(recordOrDoc?.photos)
        ? recordOrDoc.photos
        : recordOrDoc?.photos
          ? [recordOrDoc.photos]
          : [];
    return arr.filter((p) => typeof p === 'string' && p.startsWith('data:image')).length;
}

function countHttpsInPhotos(recordOrDoc) {
    const arr = Array.isArray(recordOrDoc?.photos)
        ? recordOrDoc.photos
        : recordOrDoc?.photos
          ? [recordOrDoc.photos]
          : [];
    return arr.filter((p) => typeof p === 'string' && /^https?:\/\//.test(p)).length;
}

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

/** 동기화·타임스탬프 필드만 바뀐 경우 DOM 재구성 불필요 */
const MEAL_SYNC_ONLY_KEYS = new Set([
    '_localSaveFailed',
    'is_sync_error',
    'recordedAt',
    'updatedAt',
    'timestamp'
]);

function stableMealDisplayJson(rec) {
    if (!rec || typeof rec !== 'object') return '';
    const keys = Object.keys(rec).filter((k) => !MEAL_SYNC_ONLY_KEYS.has(k)).sort();
    const o = {};
    for (const k of keys) {
        const v = rec[k];
        if (v !== undefined) o[k] = v;
    }
    return JSON.stringify(o);
}

/** id·표시 필드 변경 여부 (sync 플래그만 바뀌면 false) */
function mealRecordDisplayChanged(prev, next) {
    if (!prev || !next) return true;
    if (String(prev.id) !== String(next.id)) return true;
    return stableMealDisplayJson(prev) !== stableMealDisplayJson(next);
}

function notifyMealsDataUpdate(onDataUpdate, payload) {
    if (typeof onDataUpdate === 'function') onDataUpdate(payload);
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
    invalidateMealHistoryCountCache();
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
    if (onDataUpdate) notifyMealsDataUpdate(onDataUpdate, { source: 'meals', mode: 'initial' });
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

    let hasMealDataChanges = false;
    let hasSyncOnlyChanges = false;
    const changedDates = new Set();
    const wasInitialLoad = loadState.isInitialLoad;

    if (wasInitialLoad) {
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
        // cutoff~오늘 "윈도우"와 limit(50) 때문에 실제 최소 일자는 cutoff보다 훨씬 늦을 수 있음.
        // start를 cutoff로 두면 loadMore가 <cutoff만 당겨와 그 사이(예: 3/28~4/8)가 영구 구멍이 됨 → 실제 최소 일자 사용.
        const minActual = minMealDateYmd(window.mealHistory);
        window.loadedMealsDateRange = { start: minActual ?? cutoffDateStr, end: todayStr };
        loadState.isInitialLoad = false;
        invalidateMealHistoryCountCache();
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
                const meta = change.doc.metadata;
                const prev = window.mealHistory.find((m) => m.id === rid);
                const mgrRm = getMealSyncManager();
                const wasDeleteFlow = !!(prev && (mgrRm.isDeleting(prev) || mgrRm.isDeleteInFlight(prev)));
                /**
                 * 삭제 예약 중 + 앱이 오프라인으로 보일 때: 로컬 큐만 반영된 removed 로는 행을 유지(삭제예정 칩).
                 * 온라인 복구 후에는 `allowFromCacheAck` 로 서버 삭제 반영(캐시 메타만 와도 처리) — fromCache===false 강제 시 레드닷 고착.
                 */
                if (wasDeleteFlow && mealsSnapshotDeleteHoldWhileTransportOffline()) {
                    return;
                }
                const serverAckedRemove = mealDocSnapshotAppearsServerAcked(meta, {
                    allowFromCacheAck: true
                });
                if (!serverAckedRemove) {
                    return;
                }
                const showDeleteToast = !!(prev && mgrRm.isDeleting(prev));
                markMealEntryDeleteComplete(rid);
                if (prev) {
                    const ctx = applyOptimisticMealDelete(rid, prev);
                    if (ctx) {
                        if (showDeleteToast) showToast('기록이 삭제되었습니다.', 'success');
                    } else {
                        window.mealHistory = window.mealHistory.filter((m) => m.id !== rid);
                    }
                } else {
                    window.mealHistory = window.mealHistory.filter((m) => m.id !== rid);
                }
                hasChanges = true;
                hasMealDataChanges = true;
                if (prev?.date) changedDates.add(prev.date);
                return;
            }
            const docData = { id: change.doc.id, ...change.doc.data() };
            if (change.type === 'added' || change.type === 'modified') {
                const serverAcked = mealDocSnapshotAppearsServerAcked(change.doc.metadata, {
                    /* 초기 로드와 동일: 캐시 메타만 온 modified에서도 서버 반영 완료로 인정 (그렇지 않으면 ack 누락 → 초록 도트가 재시작 전까지 갱신 안 됨) */
                    allowFromCacheAck: true
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
                    const localB64N = countDataImageInPhotos({ photos: localPhotos });
                    const docHttpsN = countHttpsInPhotos(docData);
                    const serverMissingUploadedPhotos =
                        localB64N > 0 && docHttpsN < localB64N && (isPendingUpload || hasLocalBase64Preview);

                    let mergedRow;
                    if (shouldKeepLocalPreview || serverMissingUploadedPhotos) {
                        const merged = { ...docData, photos: [...localPhotos] };
                        mergedRow = mergePreserveLocalSaveFailed(merged, localRecord);
                    } else {
                        mergedRow = mergePreserveLocalSaveFailed(docData, localRecord);
                    }
                    const deferAck =
                        mealRecordHasBase64PendingPhotos(mergedRow) ||
                        mealRecordHasBase64PendingPhotos(localRecord) ||
                        mgrSync.hasPendingPhotoEntry(docData.id) ||
                        mgrSync.hasPendingPhotoSlot(slotKey) ||
                        (localB64N > 0 && docHttpsN < localB64N);
                    if (serverAcked) {
                        mergedRow = { ...mergedRow };
                        const lockFail = shouldPreserveMealSaveFailureOnMerge(localRecord, docData.id);
                        if (!lockFail) {
                            delete mergedRow._localSaveFailed;
                            delete mergedRow.is_sync_error;
                        }
                        if (!deferAck) {
                            onMealDocFirestoreServerAcknowledged(docData.id, null);
                        }
                    }
                    window.mealHistory[index] = mergedRow;
                    if (mealRecordDisplayChanged(localRecord, mergedRow)) {
                        hasMealDataChanges = true;
                        if (docData.date) changedDates.add(docData.date);
                        if (localRecord?.date && localRecord.date !== docData.date) {
                            changedDates.add(localRecord.date);
                        }
                    } else {
                        hasSyncOnlyChanges = true;
                    }
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
                        const deferAckTemp =
                            mealRecordHasBase64PendingPhotos(mergedRow) ||
                            mealRecordHasBase64PendingPhotos(tempRecord) ||
                            mgrSync.hasPendingPhotoEntry(docData.id) ||
                            mgrSync.hasPendingPhotoEntry(tempRecord.id) ||
                            mgrSync.hasPendingPhotoSlot(slotKey);
                        if (serverAcked) {
                            mergedRow = { ...mergedRow };
                            const lockFail = shouldPreserveMealSaveFailureOnMerge(tempRecord, docData.id);
                            if (!lockFail) {
                                delete mergedRow._localSaveFailed;
                                delete mergedRow.is_sync_error;
                            }
                            if (!deferAckTemp) {
                                onMealDocFirestoreServerAcknowledged(docData.id, tempRecord.id);
                            }
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
                        hasMealDataChanges = true;
                        if (docData.date) changedDates.add(docData.date);
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
                        hasMealDataChanges = true;
                        if (docData.date) changedDates.add(docData.date);
                    }
                }
                hasChanges = true;
            }
        });

        if (hasChanges) {
            window.mealHistory.sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
            window.mealHistory = dedupeMealListOnly(window.mealHistory);
            invalidateMealHistoryCountCache();
            const minD = minMealDateYmd(window.mealHistory);
            if (window.loadedMealsDateRange && minD) {
                window.loadedMealsDateRange = { ...window.loadedMealsDateRange, start: minD };
            }
        }
    }

    if (!demo) {
        const wr = window.loadedMealsDateRange;
        window.__mealogMealsQueryCutoff = wr?.start || cutoffDateStr;
        window.__mealogMealsQueryEnd = wr?.end || todayStr;
        window.__mealogMealsWindowFullyLoaded = snap.docs.length < 50;
        if (window.dailyStats && typeof window.dailyStats === 'object') {
            window.dailyStats = applyStreakTrustPatchesToDailyStats(
                stripGhostDailyStatsInQueryWindow({ ...window.dailyStats })
            );
        }
    }

    clearStuckMealPendingFlags();
    if (onDataUpdate) {
        if (wasInitialLoad) {
            notifyMealsDataUpdate(onDataUpdate, { source: 'meals', mode: 'initial' });
        } else if (hasMealDataChanges) {
            notifyMealsDataUpdate(onDataUpdate, {
                source: 'meals',
                mode: 'mealData',
                changedDates: [...changedDates]
            });
        } else if (hasSyncOnlyChanges) {
            notifyMealsDataUpdate(onDataUpdate, { source: 'meals', mode: 'metadataOnly' });
        }
    }
    if (!demo) {
        scheduleReconcileStaleMealSyncDotsAfterSnapshot();
    }
    return { uidMismatch: false };
}

/**
 * 날짜 범위 쿼리 실패 시 fallback 전체 컬렉션 리스너 콜백 본문
 * @param {{ snap: *, demo: boolean, userId: string, cutoffDateStr: string, todayStr: string, mergeStatsIntoDaily: () => void, onDataUpdate?: () => void, firstSnapshotState: { value: boolean } }} p
 */
export function applyMealsSnapshotFallback(p) {
    const {
        snap,
        demo,
        userId,
        cutoffDateStr,
        todayStr,
        mergeStatsIntoDaily,
        onDataUpdate,
        firstSnapshotState
    } = p;

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
    invalidateMealHistoryCountCache();
    const minF = minMealDateYmd(window.mealHistory);
    window.loadedMealsDateRange = {
        start: minF ?? cutoffDateStr,
        end: todayStr
    };
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
    if (!demo) {
        const wr = window.loadedMealsDateRange;
        window.__mealogMealsQueryCutoff = wr?.start || cutoffDateStr;
        window.__mealogMealsQueryEnd = wr?.end || todayStr;
        // 전체 컬렉션 스냅샷: 날짜 범위 내 실제 끼니 유무는 mealHistory와 일치
        window.__mealogMealsWindowFullyLoaded = true;
        mergeStatsIntoDaily();
    }
    if (onDataUpdate) notifyMealsDataUpdate(onDataUpdate, { source: 'meals', mode: 'initial' });
    if (!demo) {
        scheduleReconcileStaleMealSyncDotsAfterSnapshot();
    }
    return { uidMismatch: false };
}

MealSyncManager.prototype.applyPrimaryMealsSnapshot = function (ctx) {
    return applyMealsSnapshotPrimary(ctx);
};

MealSyncManager.prototype.applyFallbackMealsSnapshot = function (ctx) {
    return applyMealsSnapshotFallback(ctx);
};
