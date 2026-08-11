/**
 * 식사 동기화 UI — 상태는 meal-sync-manager 단일 소스.
 * 이 파일은 기존 import 경로 유지용 얇은 래퍼 + 도트 종류 헬퍼.
 */
import { getMealSyncManager, mealRecordHasBase64PendingPhotos } from './meal-sync-manager.js';
import { isDemoUser } from '../demo-account.js';

const mgr = () => getMealSyncManager();

let _scheduleStaleDotsTimer = null;

export { mealRecordHasBase64PendingPhotos };

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
/** 저장 직후 waitForPendingWrites·서버 ack UI — 로직은 meal-sync-manager 단일 소스 @returns {Promise<void>} */
export function scheduleMealServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal) {
    return mgr().scheduleServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal);
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
/** 아직 서버에 올라가지 않은 기록 수 — FAB 배지·아웃박스 드레인 공용 단일 기준 */
export function countUnsentMealWork() {
    return mgr().countUnsentMealWork();
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

/**
 * 동기화 표시를 서버 실체와 맞춘다 (ack·삭제 확정·미전송 승격 단일 패스).
 * @param {{ writeQueueFlushed?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function reconcileMealSyncAgainstServer(opts = {}) {
    if (typeof window !== 'undefined' && window.currentUser && isDemoUser(window.currentUser)) return;
    return mgr().reconcileMealSyncAgainstServer(opts);
}

/** meals onSnapshot 직후 연속 호출을 묶어 getDoc 폭주를 줄인다. */
export function scheduleMealSyncServerReconcileAfterSnapshot() {
    if (typeof window === 'undefined') return;
    if (_scheduleStaleDotsTimer) clearTimeout(_scheduleStaleDotsTimer);
    _scheduleStaleDotsTimer = window.setTimeout(() => {
        _scheduleStaleDotsTimer = null;
        void reconcileMealSyncAgainstServer();
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
