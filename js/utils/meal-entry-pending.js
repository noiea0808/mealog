/**
 * 식사 동기화 UI — 상태는 meal-sync-manager 단일 소스.
 * 이 파일은 기존 import 경로 유지용 얇은 래퍼 + 도트 종류 헬퍼.
 */
import { getMealSyncManager, MEAL_SYNC_GRACE_MS as _GRACE } from './meal-sync-manager.js';

const mgr = () => getMealSyncManager();

export const MEAL_SYNC_GRACE_MS = _GRACE;

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
/** 저장 직후 waitForPendingWrites·서버 ack UI — 로직은 meal-sync-manager 단일 소스 */
export function scheduleMealServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal) {
    mgr().scheduleServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal);
}
export function applyMealSyncAbandonOnOffline() {
    mgr().applyAbandonOnOffline();
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
export function applyOfflineAfterLocalSaveUi(effectiveMealId, optimisticTempId, dateStr, currentTabVal, opts) {
    mgr().applyOfflineUnconfirmed(effectiveMealId, optimisticTempId, dateStr, currentTabVal, opts);
}
export function markMealEntryDeletePending(entryId) {
    mgr().markDeletePending(entryId);
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
export function isMealEntryRowBlocked(record) {
    return mgr().isRowBlocked(record);
}
export function clearStuckMealPendingFlags() {
    return mgr().clearStuckMealPendingFlags();
}

/** 타임라인 도트 분기 단일화 — 레드닷 조건 꼬임 방지 */
export function getMealRowSyncLeadKind(record) {
    return mgr().getRowSyncLeadKind(record);
}

export function subscribeMealSyncState(fn) {
    return mgr().subscribe(fn);
}

export { getMealSyncManager };
