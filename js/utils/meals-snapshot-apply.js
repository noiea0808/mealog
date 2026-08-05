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
import { getSharedPhotos, setSharedPhotos } from './moment-share-state.js';
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
import { markMealsRangeLoaded, replaceLoadedMealsRanges } from './loaded-meals-range.js';
/** 스냅샷에 실제로 포함된 날짜만으로 실시간 윈도우 start를 잡을 때 사용 */
function minMealDateYmdInWindow(meals, cutoffDateStr) {
    if (!Array.isArray(meals) || !meals.length) return null;
    let min = null;
    for (const m of meals) {
        const d = m?.date;
        if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        if (cutoffDateStr && d < cutoffDateStr) continue;
        if (min == null || d < min) min = d;
    }
    return min;
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

/**
 * 초기 로드·1회성 조회 병합에서 로컬 base64(업로드 대기) 사진을 보존한다.
 * 오프라인 저장 시 Firestore 큐 문서는 data:image 사진이 제거된 상태라(ops.save sanitizePhotoArray),
 * 스냅샷 행으로 그대로 교체하면 업로드 원본이 유실되어 재시도 때 올릴 사진이 없어진다.
 * (증분 병합 분기의 shouldKeepLocalPreview/serverMissingUploadedPhotos 와 동일 취지)
 * @param {object} row 스냅샷에서 온 행
 * @param {Map<string, object>} prevById 병합 전 mealHistory (id → 행)
 */
function preserveLocalPendingPhotosOnRow(row, prevById) {
    if (!row?.id) return row;
    const local = prevById.get(String(row.id));
    if (!local) return row;
    const localPhotos = Array.isArray(local.photos) ? local.photos : local.photos ? [local.photos] : [];
    const localB64N = countDataImageInPhotos({ photos: localPhotos });
    if (localB64N === 0) return row;
    const mgr = getMealSyncManager();
    const slotKey = `${row.date || ''}__${row.slotId || ''}`;
    const docHttpsN = countHttpsInPhotos(row);
    if (mgr.hasPendingPhotoEntry(row.id) || mgr.hasPendingPhotoSlot(slotKey) || docHttpsN < localB64N) {
        return { ...row, photos: [...localPhotos] };
    }
    return row;
}

/** 초기 로드 ack 시 base64 업로드 대기 행은 초록 처리 보류 (증분 분기의 deferAck 와 동일) */
function shouldDeferServerAckForRow(row) {
    if (!row?.id) return false;
    const mgr = getMealSyncManager();
    const slotKey = `${row.date || ''}__${row.slotId || ''}`;
    return (
        mealRecordHasBase64PendingPhotos(row) ||
        mgr.hasPendingPhotoEntry(row.id) ||
        mgr.hasPendingPhotoSlot(slotKey)
    );
}

function triggerLoadMyShares() {
    void import('../db.js').then(({ loadMyShares }) => {
        loadMyShares()
            .then((list) => {
                setSharedPhotos(list);
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
        replaceLoadedMealsRanges(addDaysToYmd(minRaw, shift), todayLocalYmd());
    } else if (rawDates.length) {
        const minRaw = rawDates.reduce((a, b) => (a < b ? a : b));
        const maxRaw = rawDates.reduce((a, b) => (a > b ? a : b));
        replaceLoadedMealsRanges(minRaw, maxRaw);
    } else {
        const tl = todayLocalYmd();
        replaceLoadedMealsRanges(tl, tl);
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
        const prevById = new Map(
            prevForMerge.filter((m) => m?.id).map((m) => [String(m.id), m])
        );
        const serverMapped = snap.docs
            .map((d) => {
                let row = { id: d.id, ...d.data() };
                const sid = String(d.id);
                if (getMealSyncManager().hasErrorId(sid)) {
                    row._localSaveFailed = true;
                    row.is_sync_error = true;
                }
                row = preserveLocalPendingPhotosOnRow(row, prevById);
                return row;
            })
            .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
        const mergedById = new Map(serverMapped.map((r) => [String(r.id), r]));
        // 최근 N일 부분 윈도우: cutoff 이전 on-demand 캐시는 유지 (트래커 과거 이동 후 사라짐 방지)
        window.mealHistory = findUniqueMeals(serverMapped, prevForMerge, {
            preserveBeforeDate: cutoffDateStr
        });
        // limit(50) 때문에 윈도우 안 실제 최소일이 cutoff보다 늦을 수 있음 → 스냅샷 내 최소일 사용.
        // 과거 캐시 구간은 지우지 않고 실시간 윈도우만 mark (구멍 오인 방지).
        const minInWindow =
            minMealDateYmdInWindow(serverMapped, cutoffDateStr) ?? cutoffDateStr;
        markMealsRangeLoaded(minInWindow, todayStr);
        loadState.isInitialLoad = false;
        invalidateMealHistoryCountCache();
        snap.docs.forEach((d) => {
            if (!mealDocSnapshotAppearsServerAcked(d.metadata, { allowFromCacheAck: true })) return;
            if (shouldDeferServerAckForRow(mergedById.get(String(d.id)))) return;
            onMealDocFirestoreServerAcknowledged(d.id, null);
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
                /**
                 * 삭제를 확정할지는 이 removed 이벤트 자체가 답한다 — hasPendingWrites 가 true 면 아직
                 * 우리 큐에 남아 있는 우리 삭제이므로 행을 유지한다(삭제예정 칩). 앱 전역의 「오프라인
                 * 인가」를 따로 볼 필요가 없다. 이벤트별 출처는 고착되지도, 틀리지도 않는다.
                 * 큐가 서버에 닿으면 hasPendingWrites 가 내려가고, 그때 확정된다. 오프라인 중에 큐만
                 * 비워진 경우는 meal-outbox-drain 의 reconcilePendingMealDeletesWithServer 가 맞춘다.
                 */
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
                    let tempIdx = window.mealHistory.findIndex(
                        (m) =>
                            typeof m?.id === 'string' &&
                            m.id.startsWith('temp_') &&
                            m.date === docData.date &&
                            m.slotId === docData.slotId &&
                            mgrSync.hasOptimisticTemp(m.id)
                    );
                    if (tempIdx < 0) {
                        tempIdx = window.mealHistory.findIndex(
                            (m) =>
                                typeof m?.id === 'string' &&
                                m.id.startsWith('temp_') &&
                                m.date === docData.date &&
                                m.slotId === docData.slotId
                        );
                    }
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
                        if (getSharedPhotos()) {
                            setSharedPhotos(getSharedPhotos().map((p) =>
                                p.entryId === tempRecord.id ? { ...p, entryId: docData.id } : p
                            ));
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
            // 과거 on-demand 캐시가 있어도 실시간 윈도우 봉투를 과거로 늘리지 않음
        }
    }

    if (!demo) {
        // ghost stats 정합은 "리스너 쿼리 윈도우" 기준 (전체 loaded 봉투가 아님)
        window.__mealogMealsQueryCutoff = cutoffDateStr;
        window.__mealogMealsQueryEnd = todayStr;
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
 * primary onSnapshot 실패 시 1회성 getDocs 결과 반영 (limit·비실시간)
 * @param {{ snap: *, demo: boolean, userId: string, cutoffDateStr: string, todayStr: string, mergeStatsIntoDaily: () => void, onDataUpdate?: () => void, limit?: number }} p
 */
export function applyMealsOneTimeFetchResult(p) {
    const {
        snap,
        demo,
        userId,
        cutoffDateStr,
        todayStr,
        mergeStatsIntoDaily,
        onDataUpdate,
        limit: fetchLimit = 50
    } = p;

    if (window.currentUser && userId !== window.currentUser.uid) {
        console.error('⚠️ Meals 1회 조회: 사용자 ID 불일치! 무시');
        return { uidMismatch: true };
    }

    if (demo) {
        applyDemoMealsBranch(snap, { mergeStatsIntoDaily, onDataUpdate, slice50: true });
        return { uidMismatch: false };
    }

    const prevForMerge = Array.isArray(window.mealHistory) ? window.mealHistory : [];
    const prevById = new Map(
        prevForMerge.filter((m) => m?.id).map((m) => [String(m.id), m])
    );
    const serverMapped = snap.docs
        .map((d) => {
            let row = { id: d.id, ...d.data() };
            const sid = String(d.id);
            if (getMealSyncManager().hasErrorId(sid)) {
                row._localSaveFailed = true;
                row.is_sync_error = true;
            }
            row = preserveLocalPendingPhotosOnRow(row, prevById);
            return row;
        })
        .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));
    const mergedById = new Map(serverMapped.map((r) => [String(r.id), r]));
    window.mealHistory = findUniqueMeals(serverMapped, prevForMerge, {
        preserveBeforeDate: cutoffDateStr
    });
    invalidateMealHistoryCountCache();
    const minInWindow = minMealDateYmdInWindow(serverMapped, cutoffDateStr) ?? cutoffDateStr;
    markMealsRangeLoaded(minInWindow, todayStr);
    snap.docs.forEach((d) => {
        if (!mealDocSnapshotAppearsServerAcked(d.metadata, { allowFromCacheAck: true })) return;
        if (shouldDeferServerAckForRow(mergedById.get(String(d.id)))) return;
        onMealDocFirestoreServerAcknowledged(d.id, null);
    });
    window.__mealogMealsQueryCutoff = cutoffDateStr;
    window.__mealogMealsQueryEnd = todayStr;
    window.__mealogMealsWindowFullyLoaded = snap.docs.length < fetchLimit;
    mergeStatsIntoDaily();
    if (onDataUpdate) notifyMealsDataUpdate(onDataUpdate, { source: 'meals', mode: 'initial' });
    scheduleReconcileStaleMealSyncDotsAfterSnapshot();
    return { uidMismatch: false };
}

/** @deprecated applyMealsOneTimeFetchResult 사용 */
export function applyMealsSnapshotFallback(p) {
    return applyMealsOneTimeFetchResult(p);
}

MealSyncManager.prototype.applyPrimaryMealsSnapshot = function (ctx) {
    return applyMealsSnapshotPrimary(ctx);
};

MealSyncManager.prototype.applyFallbackMealsSnapshot = function (ctx) {
    return applyMealsOneTimeFetchResult(ctx);
};
