/**
 * 식사 동기화 UI — 상태는 meal-sync-manager 단일 소스.
 * 이 파일은 기존 import 경로 유지용 얇은 래퍼 + 도트 종류 헬퍼.
 */
import {
    getMealSyncManager,
    MEAL_SYNC_GRACE_MS as _GRACE,
    MEAL_SYNC_GRACE_MS_NO_PHOTO,
    MEAL_SYNC_GRACE_MS_WITH_PHOTO,
    mealRecordHasBase64PendingPhotos
} from './meal-sync-manager.js';
import { isDemoUser } from '../demo-account.js';

const mgr = () => getMealSyncManager();

let _scheduleStaleDotsTimer = null;

export const MEAL_SYNC_GRACE_MS = _GRACE;
export { MEAL_SYNC_GRACE_MS_NO_PHOTO, MEAL_SYNC_GRACE_MS_WITH_PHOTO, mealRecordHasBase64PendingPhotos };

export function markMealOptimisticSavePending(tempId) {
    mgr().markOptimisticPending(tempId);
}
export function clearMealOptimisticSavePending(tempId) {
    mgr().clearOptimisticPending(tempId);
}
export function markMealEntrySaveInFlight(entryId) {
    mgr().markInFlight(entryId);
}
export function clearMealEntrySaveInFlight(entryId) {
    mgr().clearInFlight(entryId);
}
export function isMealEntrySaveInFlight(record) {
    return !!(record?.id && mgr().hasInFlight(String(record.id)));
}
export function markMealEntryServerWorkComplete(recordId, optimisticTempId, optimisticSlotKey) {
    mgr().markServerWorkComplete(recordId, optimisticTempId, optimisticSlotKey);
}
export function hydrateMealSyncErrorIdsFromStorage() {
    mgr().hydrateErrorsFromStorage();
}
export function hydrateMealSyncAbandonedIdsFromStorage() {
    mgr().hydrateAbandonedFromStorage();
}
export function hydrateMealSyncRegisterScheduledIdsFromStorage() {
    mgr().hydrateRegisterScheduledFromStorage();
}
export function markMealEntrySyncAbandonedById(entryId) {
    mgr().markAbandoned(entryId);
}
export function clearMealEntrySyncAbandonedById(entryId) {
    mgr().clearAbandoned(entryId);
}
export function isMealEntrySyncAbandoned(record) {
    return mgr().isAbandoned(record);
}
export function clearMealSyncGraceTimer(entryId) {
    mgr().clearGraceTimer(entryId);
}
export function scheduleMealSyncGraceAbandon(entryId, opts = {}) {
    mgr().scheduleGraceAbandon(entryId, opts);
}
/** 저장 직후 waitForPendingWrites·서버 ack UI — 로직은 meal-sync-manager 단일 소스 @returns {Promise<void>} */
export function scheduleMealServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal, graceMs) {
    return mgr().scheduleServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal, graceMs);
}
export function markMealEntryServerSynced(entryId) {
    mgr().markServerSynced(entryId);
}
export function clearMealEntryServerSynced(entryId) {
    mgr().clearServerSynced(entryId);
}
export function isMealEntryServerSynced(record) {
    return mgr().isServerSynced(record);
}
export function markMealEntrySaveFailedById(entryId) {
    mgr().markError(entryId);
}
export function clearMealEntrySaveFailedById(entryId) {
    mgr().clearError(entryId);
}
export function onMealDocFirestoreServerAcknowledged(docId, optimisticTempId) {
    mgr().onServerDocumentAcknowledged(docId, optimisticTempId);
}
export function onMealDocFirestorePendingWritesResolved(docId, optimisticTempId) {
    mgr().onPendingWritesResolved(docId, optimisticTempId);
}
export function isMealEntryPendingSync(record) {
    return mgr().isPendingSync(record);
}
export function isMealEntrySaveFailed(record) {
    return mgr().isSaveFailed(record);
}
export function isMealEntrySyncRedoable(record) {
    return mgr().isRedoable(record);
}
export function countMealPendingSyncAndDeleteQueue() {
    return mgr().countPendingSyncAndDeleteQueue();
}
export function countMealCloudFabManualRetryEntries() {
    return mgr().countCloudFabManualRetryEntries();
}
export function countMealSyncFabScheduledChipEntries() {
    return mgr().countMealSyncFabScheduledChipEntries();
}
export function markMealEntryDeletePending(entryId) {
    mgr().markDeletePending(entryId);
}
export function markMealEntryDeleteInFlight(entryId) {
    mgr().markDeleteInFlight(entryId);
}
export function markMealEntryDeleteComplete(entryId) {
    mgr().markDeleteComplete(entryId);
}
export function markMealEntryDeleteFailed(entryId) {
    mgr().markDeleteFailed(entryId);
}
export function clearMealEntryDeleteFailed(entryId) {
    mgr().clearDeleteFailed(entryId);
}
export function isMealEntryDeleteFailed(record) {
    return mgr().isDeleteFailed(record);
}
export function isMealEntryDeleting(record) {
    return mgr().isDeleting(record);
}
export function isMealEntryDeleteInFlight(record) {
    return mgr().isDeleteInFlight(record);
}
export function isMealEntryRowBlocked(record) {
    return mgr().isRowBlocked(record);
}
export function clearStuckMealPendingFlags() {
    return mgr().clearStuckMealPendingFlags();
}

/** waitForPendingWrites 성공 직후: 스냅샷 ack 누락 시 타임라인 동기화 표시 보정 */
export function reconcileMealSyncUiAfterWriteQueueFlush() {
    return mgr().reconcileSyncUiAfterClientWriteQueueFlush();
}

/** 삭제 예약 고착 시 서버에 문서 없음을 확인해 레드닷·행을 정리한다. @returns {Promise<void>} */
export function reconcilePendingMealDeletesWithServer() {
    return mgr().reconcilePendingDeletesWithServer();
}

/**
 * 레드닷·삭제 진행 표시가 스냅샷과 어긋날 때 서버 문서 존재 여부로 보정한다.
 * @returns {Promise<void>}
 */
export async function reconcileStaleMealSyncDotsAgainstServer() {
    if (typeof window !== 'undefined' && window.currentUser && isDemoUser(window.currentUser)) return;
    return mgr().reconcileStaleMealSyncDotsAgainstServer();
}

/** meals onSnapshot 직후 연속 호출을 묶어 getDoc 폭주를 줄인다. */
export function scheduleReconcileStaleMealSyncDotsAfterSnapshot() {
    if (typeof window === 'undefined') return;
    if (_scheduleStaleDotsTimer) clearTimeout(_scheduleStaleDotsTimer);
    _scheduleStaleDotsTimer = window.setTimeout(() => {
        _scheduleStaleDotsTimer = null;
        void reconcileStaleMealSyncDotsAgainstServer();
    }, 500);
}

/** 행 동기화 표시 — 'none' | 'syncing' | 'failed' | 'synced' */
export function getMealRowSyncLeadKind(record) {
    return mgr().getRowSyncLeadKind(record);
}

/** 다시 밀어 올릴 대상인지 (서버 미확인 + 전송 중 아님) */
export function isMealEntryRetryEligible(record) {
    return mgr().isRetryEligible(record);
}

export function subscribeMealSyncState(fn) {
    return mgr().subscribe(fn);
}

export { getMealSyncManager };
