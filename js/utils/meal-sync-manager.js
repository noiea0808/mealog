/**
 * 식사 Firestore 동기화 UI 상태 단일 소스.
 * window.* 맵에 의존하지 않는다 — 외부는 getMealSyncManager()와 meal-entry-pending re-export만 사용.
 *
 * 오케스트레이션(저장 직후 waitForPendingWrites, 리스너 스냅샷이 서버 ack로 보이는지 등)도 이 모듈에 둔다.
 * 모달·리스너는 명령/이벤트만 넘기고 판단은 여기서만 한다.
 */

import { db, appId } from '../firebase.js';
import { waitForPendingWrites, doc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { appState } from '../state.js';
import { isMealogTransportOffline } from './mealog-offline-ui.js';

const MEAL_SYNC_ERROR_IDS_KEY = 'mealog_mealSyncErrorIds_v1';
const MEAL_ABANDONED_IDS_KEY = 'mealog_mealSyncAbandonedIds_v1';

function mealPhotosHaveBase64(record) {
    if (!record) return false;
    const photos = Array.isArray(record.photos) ? record.photos : record.photos ? [record.photos] : [];
    return photos.some(
        (p) =>
            typeof p === 'string' &&
            (p.startsWith('data:image') || p.startsWith('blob:'))
    );
}

/**
 * 타임라인 `mealEntrySyncLeadHtml` 오프라인 분기와 동일.
 * 오프라인일 때 `pending`·`await_server_ack`도 ‘등록예정’ 칩으로 보이므로 FAB 배지에 포함한다.
 */
function isMealSyncUiEffectiveOfflineFab() {
    return isMealogTransportOffline();
}

/** 저장 grace(30초) 분기용 — entry-and-core 등에서 사용 */
export function mealRecordHasBase64PendingPhotos(record) {
    return mealPhotosHaveBase64(record);
}

function persistErrorId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_SYNC_ERROR_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        const s = String(entryId);
        if (!Array.isArray(arr)) return;
        if (!arr.includes(s)) {
            arr.push(s);
            window.localStorage.setItem(MEAL_SYNC_ERROR_IDS_KEY, JSON.stringify(arr));
        }
    } catch (_) {
        /* ignore */
    }
}

function unpersistErrorId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_SYNC_ERROR_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        const s = String(entryId);
        window.localStorage.setItem(MEAL_SYNC_ERROR_IDS_KEY, JSON.stringify(arr.filter((x) => x !== s)));
    } catch (_) {
        /* ignore */
    }
}

function persistAbandonedId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_ABANDONED_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        const s = String(entryId);
        if (!Array.isArray(arr)) return;
        if (!arr.includes(s)) {
            arr.push(s);
            window.localStorage.setItem(MEAL_ABANDONED_IDS_KEY, JSON.stringify(arr));
        }
    } catch (_) {
        /* ignore */
    }
}

function unpersistAbandonedId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_ABANDONED_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        const s = String(entryId);
        window.localStorage.setItem(MEAL_ABANDONED_IDS_KEY, JSON.stringify(arr.filter((x) => x !== s)));
    } catch (_) {
        /* ignore */
    }
}

async function notifyTimelineAndFab() {
    void import('../render/timeline.js').then((mod) => {
        try {
            if (mod.updateTimelineMealEntryPendingIndicators) mod.updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
    });
    void import('../main/meal-sync-resend-header.js').then((m) => {
        try {
            m.refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
    });
}

async function refreshTimelineFull(dateStr, currentTab) {
    void import('../render/timeline.js').then((mod) => {
        try {
            if (dateStr && mod.invalidateTimelineDateSection) mod.invalidateTimelineDateSection(dateStr);
            if (currentTab === 'timeline' && mod.renderTimeline) mod.renderTimeline();
            else if (mod.updateTimelineMealEntryPendingIndicators) mod.updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
    });
    void notifyTimelineAndFab();
}

/**
 * meals onSnapshot 메타데이터가 서버 반영(동기화 도트 해제 후보)으로 보이는지.
 * @param {*} metadata Firestore SnapshotMetadata
 * @param {{ allowFromCacheAck?: boolean }} [options]
 */
export function mealDocSnapshotAppearsServerAcked(metadata, options = {}) {
    if (!metadata || metadata.hasPendingWrites) return false;
    /** onLine 은 웹뷰·잠금 직후 오판이 잦음. 여기서 false 처리하면 removed/modified 가 영구히 미인정 → 삭제·초록 도트 고착 */
    const allowCache = options.allowFromCacheAck === true;
    if (!allowCache && metadata.fromCache === true) return false;
    return true;
}

/** 리스너 병합 시 서버 스냅샷이 실패 뱃지를 지우지 않도록 */
export function shouldPreserveMealSaveFailureOnMerge(localRecord, docDataId) {
    const mgr = getMealSyncManager();
    const did = docDataId != null ? String(docDataId) : '';
    if (did && mgr.hasErrorId(did)) return true;
    const lid = localRecord?.id != null ? String(localRecord.id) : '';
    if (lid && mgr.hasErrorId(lid)) return true;
    if (localRecord?._localSaveFailed === true || localRecord?.is_sync_error === true) return true;
    return false;
}

export function mergePreserveLocalSaveFailed(docData, localRecord) {
    const id = docData?.id != null ? String(docData.id) : '';
    const fromLocal = localRecord?._localSaveFailed === true || localRecord?.is_sync_error === true;
    const fromMap = id && getMealSyncManager().hasErrorId(id);
    if (!fromLocal && !fromMap) return docData;
    return { ...docData, _localSaveFailed: true, is_sync_error: true };
}

/** 사진 없음: 이 시간 지나면 등록예정 칩(레드닷 종료) */
export const MEAL_SYNC_GRACE_MS_NO_PHOTO = 10000;
/** base64·Storage 업로드 대기 중인 등록: 30초 후 등록예정 칩 */
export const MEAL_SYNC_GRACE_MS_WITH_PHOTO = 30000;
/** @deprecated NO_PHOTO와 동일 — 호환용 */
export const MEAL_SYNC_GRACE_MS = MEAL_SYNC_GRACE_MS_NO_PHOTO;

export class MealSyncManager {
    constructor() {
        /** @type {Set<(rev: number) => void>} */
        this._listeners = new Set();
        this._revision = 0;

        this._optimisticPending = new Map();
        this._inFlight = new Map();
        this._serverSynced = new Map();
        this._abandoned = new Map();
        this._errorIds = new Map();
        this._deletePending = new Map();
        /** deleteDoc await 직전까지 false → 삭제예정, 이후 true → 삭제중 */
        this._deleteInFlight = new Map();
        this._deleteFailed = new Map();
        this._pendingPhotoByEntry = new Map();
        this._pendingPhotoBySlot = new Map();
        this._graceTimers = new Map();
        /** grace·오프라인 등: 서버 미확인이지만 재시도 도트가 아닌 등록예정 칩 */
        this._registerScheduledChip = new Set();
    }

    subscribe(fn) {
        if (typeof fn !== 'function') return () => {};
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    get revision() {
        return this._revision;
    }

    _bump() {
        this._revision++;
        for (const fn of this._listeners) {
            try {
                fn(this._revision);
            } catch (_) {
                /* ignore */
            }
        }
        void notifyTimelineAndFab();
    }

    hasErrorId(id) {
        return !!this._errorIds.get(String(id));
    }

    hasAbandonedId(id) {
        return !!this._abandoned.get(String(id));
    }

    hasPendingPhotoEntry(id) {
        return !!this._pendingPhotoByEntry.get(String(id));
    }

    hasPendingPhotoSlot(slotKey) {
        return !!this._pendingPhotoBySlot.get(String(slotKey));
    }

    hasOptimisticTemp(id) {
        return !!this._optimisticPending.get(String(id));
    }

    hasInFlight(id) {
        return !!this._inFlight.get(String(id));
    }

    hasServerSynced(id) {
        return !!this._serverSynced.get(String(id));
    }

    markOptimisticPending(tempId) {
        if (!tempId) return;
        this._optimisticPending.set(String(tempId), true);
        this._bump();
    }

    clearOptimisticPending(tempId) {
        if (!tempId) return;
        this._optimisticPending.delete(String(tempId));
        this._bump();
    }

    markInFlight(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this._inFlight.set(s, true);
        this._bump();
    }

    clearInFlight(entryId) {
        if (entryId == null || entryId === '') return;
        this._inFlight.delete(String(entryId));
        this._bump();
    }

    markServerSynced(entryId) {
        if (entryId == null || entryId === '') return;
        this._serverSynced.set(String(entryId), true);
        this._bump();
    }

    clearServerSynced(entryId) {
        if (entryId == null || entryId === '') return;
        this._serverSynced.delete(String(entryId));
        this._bump();
    }

    markAbandoned(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this._serverSynced.delete(s);
        this._abandoned.set(s, true);
        persistAbandonedId(entryId);
        this._bump();
    }

    clearAbandoned(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this._abandoned.delete(s);
        unpersistAbandonedId(entryId);
        this._bump();
    }

    /** UI 타임아웃·서버 실패 등 — errorIds(저장 실패) 단일 맵 */
    markError(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this._serverSynced.delete(s);
        this._abandoned.delete(s);
        unpersistAbandonedId(entryId);
        this._errorIds.set(s, true);
        persistErrorId(entryId);
        this._bump();
    }

    clearError(entryId) {
        if (entryId == null || entryId === '') return;
        this._errorIds.delete(String(entryId));
        unpersistErrorId(entryId);
        this._bump();
    }

    markDeletePending(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._deletePending.set(s, true);
        this._deleteInFlight.delete(s);
        this._bump();
    }

    markDeleteInFlight(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._deleteInFlight.set(s, true);
        this._bump();
    }

    markDeleteComplete(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this._deletePending.delete(s);
        this._deleteInFlight.delete(s);
        this._bump();
    }

    markDeleteFailed(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._registerScheduledChip.delete(s);
        this.markDeleteComplete(entryId);
        this._deleteFailed.set(s, true);
        this._bump();
    }

    clearDeleteFailed(entryId) {
        if (entryId == null || entryId === '') return;
        this._deleteFailed.delete(String(entryId));
        this._bump();
    }

    setPendingPhotoEntry(entryId, slotKey, on) {
        if (typeof window === 'undefined') return;
        if (on) {
            if (entryId) this._pendingPhotoByEntry.set(String(entryId), true);
            if (slotKey) this._pendingPhotoBySlot.set(String(slotKey), true);
        } else {
            if (entryId) this._pendingPhotoByEntry.delete(String(entryId));
            if (slotKey) this._pendingPhotoBySlot.delete(String(slotKey));
        }
        this._bump();
    }

    clearPendingPhotoFor(recordId, optimisticTempId, slotKey) {
        if (recordId) this._pendingPhotoByEntry.delete(String(recordId));
        if (optimisticTempId) this._pendingPhotoByEntry.delete(String(optimisticTempId));
        if (slotKey) this._pendingPhotoBySlot.delete(String(slotKey));
        this._bump();
    }

    movePendingPhotoTempToReal(tempId, realId) {
        if (this._pendingPhotoByEntry.has(String(tempId))) {
            this._pendingPhotoByEntry.delete(String(tempId));
            if (realId) this._pendingPhotoByEntry.set(String(realId), true);
        }
        this._bump();
    }

    clearGraceTimer(entryId) {
        if (entryId == null || entryId === '') return;
        const id = String(entryId);
        const t = this._graceTimers.get(id);
        if (t) {
            clearTimeout(t);
            this._graceTimers.delete(id);
        }
    }

    /**
     * grace 만료·오프라인 전환 등: abandon 대신 등록예정 칩 상태(재시도 도트 아님).
     * @param {string|number} entryId
     * @param {{ optimisticTempId?: string|null, dateStr?: string, currentTab?: string }} [opts]
     */
    promoteToRegisterScheduledChip(entryId, opts = {}) {
        if (typeof window === 'undefined' || entryId == null || entryId === '') return;
        const id = String(entryId);
        if (!id) return;
        if (this.hasServerSynced(id)) return;
        this.clearAbandoned(id);
        this._registerScheduledChip.add(id);
        this.clearInFlight(id);
        const ot = opts.optimisticTempId != null ? String(opts.optimisticTempId) : '';
        if (ot && ot.startsWith('temp_')) {
            this.clearAbandoned(ot);
            this.clearOptimisticPending(ot);
            this._registerScheduledChip.add(ot);
        }
        const row =
            Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === id) : null;
        if (row) {
            this.clearPendingFlagsForRecord(row);
        } else {
            this._pendingPhotoByEntry.delete(id);
        }
        this._bump();
        const { dateStr, currentTab } = opts;
        void refreshTimelineFull(dateStr, currentTab);
    }

    scheduleGraceAbandon(entryId, opts = {}) {
        if (typeof window === 'undefined' || entryId == null || entryId === '') return;
        const id = String(entryId);
        this.clearGraceTimer(id);
        const delayMs =
            typeof opts.graceMs === 'number' && opts.graceMs > 0 ? opts.graceMs : MEAL_SYNC_GRACE_MS_NO_PHOTO;
        this._graceTimers.set(
            id,
            setTimeout(() => {
                this._graceTimers.delete(id);
                if (this.hasServerSynced(id)) return;
                const row =
                    Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === id) : null;
                if (row && (row._localSaveFailed === true || row.is_sync_error === true)) return;
                if (this.hasErrorId(id)) return;

                this.promoteToRegisterScheduledChip(id, {
                    optimisticTempId: opts.optimisticTempId != null ? opts.optimisticTempId : null,
                    dateStr: opts.dateStr,
                    currentTab: opts.currentTab
                });
            }, delayMs)
        );
    }

    clearPendingFlagsForRecord(record) {
        if (!record?.id) return;
        const id = String(record.id);
        this._pendingPhotoByEntry.delete(id);
        const sk = `${record.date || ''}__${record.slotId || ''}`;
        if (sk) this._pendingPhotoBySlot.delete(sk);
    }

    /** find-unique-meals: temp 행 제거 시 */
    removeTempRowSideEffects(m) {
        if (!m?.id) return;
        const id = String(m.id);
        this._registerScheduledChip.delete(id);
        this._pendingPhotoByEntry.delete(id);
        if (m.date && m.slotId) {
            this._pendingPhotoBySlot.delete(`${m.date}__${m.slotId}`);
        }
        this.clearOptimisticPending(id);
    }

    /** find-unique-meals: 본식 실 id 중복 제거 시 */
    clearDuplicateRealIdSideEffects(id) {
        const sid = String(id);
        this.clearGraceTimer(sid);
        this._registerScheduledChip.delete(sid);
        this._inFlight.delete(sid);
        this._serverSynced.delete(sid);
        this._pendingPhotoByEntry.delete(sid);
        this._bump();
    }

    applyAbandonOnOffline() {
        for (const id of [...this._inFlight.keys()]) {
            this.clearGraceTimer(id);
            this.promoteToRegisterScheduledChip(id, {});
        }
        for (const tid of [...this._optimisticPending.keys()]) {
            this.clearGraceTimer(tid);
            this.promoteToRegisterScheduledChip(tid, {});
        }
        for (const pid of [...this._pendingPhotoByEntry.keys()]) {
            this.clearGraceTimer(pid);
            this.promoteToRegisterScheduledChip(pid, {});
        }
        this._bump();
    }

    applyOfflineUnconfirmed(effectiveMealId, optimisticTempId, dateStr, currentTabVal, opts) {
        const force = opts && opts.forceUnconfirmedUi === true;
        if (!force && typeof navigator !== 'undefined' && navigator.onLine !== false) return;
        const id = effectiveMealId != null ? String(effectiveMealId) : '';
        if (!id || id.startsWith('temp_')) return;
        this.clearGraceTimer(id);
        const ot =
            optimisticTempId != null && String(optimisticTempId).startsWith('temp_')
                ? String(optimisticTempId)
                : '';
        if (ot) this.clearGraceTimer(ot);
        this.promoteToRegisterScheduledChip(id, {
            optimisticTempId: ot || null,
            dateStr,
            currentTab: currentTabVal
        });
        const rowDraft =
            Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === id) : null;
        if (rowDraft) rowDraft._mealogOfflineDraft = true;
        const run = () => void refreshTimelineFull(dateStr, currentTabVal);
        run();
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(run);
    }

    /**
     * 리스너 전용: 서버 스냅샷에서 문서가 서버에 반영됨을 확인했을 때만 호출.
     * 스피너·grace·낙관 temp 정리, 실패 플래그는 기존 규칙 유지.
     */
    onServerDocumentAcknowledged(docId, optimisticTempId) {
        if (typeof window === 'undefined' || docId == null || docId === '') return;
        const sid = String(docId);
        this.clearGraceTimer(sid);
        if (optimisticTempId != null && optimisticTempId !== '') {
            this.clearGraceTimer(String(optimisticTempId));
        }
        this.clearInFlight(sid);
        this._registerScheduledChip.delete(sid);
        const row =
            Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === sid) : null;
        const rowIndicatesFailure =
            row?._localSaveFailed === true ||
            row?.is_sync_error === true;
        if (!rowIndicatesFailure && !this.hasErrorId(sid)) {
            this.clearError(sid);
        }
        this.clearAbandoned(sid);
        if (optimisticTempId != null && optimisticTempId !== '') {
            this.clearOptimisticPending(String(optimisticTempId));
            const tid = String(optimisticTempId);
            const tempRow =
                Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === tid) : null;
            const tempRowFailed =
                tempRow?._localSaveFailed === true ||
                tempRow?.is_sync_error === true;
            if (!tempRowFailed && !this.hasErrorId(tid)) {
                this.clearError(tid);
            }
            this.clearAbandoned(tid);
            this._registerScheduledChip.delete(tid);
        }
        this.markServerSynced(sid);
        this._bump();
    }

    /** waitForPendingWrites 성공 — 큐 flush만, 초록·grace는 onServerDocumentAcknowledged 전담 */
    onPendingWritesResolved(docId, optimisticTempId) {
        if (typeof window === 'undefined' || docId == null || docId === '') return;
        this.clearInFlight(String(docId));
        if (optimisticTempId != null && optimisticTempId !== '') {
            this.clearOptimisticPending(String(optimisticTempId));
        }
        this._bump();
    }

    /**
     * 클라이언트 쓰기 큐가 비었는데도 스냅샷이 fromCache 등으로 ack를 놓치면 await_server_ack·pending이 남는다.
     * waitForPendingWrites 직후에만 호출한다.
     */
    reconcileSyncUiAfterClientWriteQueueFlush() {
        if (typeof window === 'undefined') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        /** localNetworkForcedOffline 만으로 막지 않음 — `online` 이벤트 없이 복귀한 경우에도 큐 flush 후 초록 도트로 맞출 수 있어야 함 */
        const hist = window.mealHistory;
        if (!Array.isArray(hist) || hist.length === 0) return;
        // waitForPendingWrites 직후에도 inFlight 플래그만 남아 '등록 중' 레드닷이 고착되는 경우가 있음
        // (오프라인 저장 직후 이벤트 순서로 등록예정 칩으로 승격되지 않은 경로 등). 큐는 비었으므로 정리 후 ack.
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (this.hasErrorId(id)) continue;
            if (m._localSaveFailed === true || m.is_sync_error === true) continue;
            if (this.isDeleting(m)) continue;
            if (this.isDeleteFailed(m)) continue;
            if (this.hasInFlight(id) && !this._registerScheduledChip.has(id)) {
                this.clearInFlight(id);
            }
        }
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (this.hasErrorId(id)) continue;
            if (m._localSaveFailed === true || m.is_sync_error === true) continue;
            if (this.isDeleting(m)) continue;
            if (this.isDeleteFailed(m)) continue;
            if (mealRecordHasBase64PendingPhotos(m)) continue;
            const slotKey = `${m.date || ''}__${m.slotId || ''}`;
            if (this.hasPendingPhotoEntry(id) || this.hasPendingPhotoSlot(slotKey)) continue;
            const kind = this.getRowSyncLeadKind(m);
            if (kind === 'redoable_failed') continue;
            if (kind === 'register_scheduled') {
                this.onServerDocumentAcknowledged(id, null);
                continue;
            }
            if (
                (kind === 'await_server_ack' || kind === 'pending' || kind === 'redoable_abandoned') &&
                !this.hasInFlight(id)
            ) {
                this.onServerDocumentAcknowledged(id, null);
            }
        }
    }

    /**
     * 삭제 예약/진행이 스냅샷 removed·메타 누락으로 고착될 때, 서버에 meal 문서가 없으면 삭제 완료로 맞춘다.
     * `waitForPendingWrites` 직후에만 호출한다.
     * @returns {Promise<void>}
     */
    async reconcilePendingDeletesWithServer() {
        if (typeof window === 'undefined') return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        const uid = window.currentUser?.uid;
        if (!uid || window.currentUser?.isAnonymous) return;

        const idSet = new Set();
        for (const k of this._deletePending.keys()) idSet.add(String(k));
        for (const k of this._deleteInFlight.keys()) idSet.add(String(k));
        if (Array.isArray(window.mealHistory)) {
            for (const m of window.mealHistory) {
                if (!m?.id) continue;
                const sid = String(m.id);
                if (sid.startsWith('temp_')) continue;
                if (this._deletePending.has(sid) || this._deleteInFlight.has(sid)) idSet.add(sid);
            }
        }
        if (idSet.size === 0) return;

        const { applyOptimisticMealDelete } = await import('./meal-delete-optimistic.js');

        for (const id of idSet) {
            if (!id || id.startsWith('temp_')) continue;
            try {
                const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', id);
                const snap = await getDocFromServer(ref);
                if (snap.exists()) continue;
            } catch (_) {
                continue;
            }

            const prev =
                Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === id) : null;
            this.markDeleteComplete(id);
            this.clearDeleteFailed(id);
            if (prev) applyOptimisticMealDelete(id, prev);
        }
    }

    markServerWorkComplete(recordId, optimisticTempId, optimisticSlotKey) {
        if (recordId != null && recordId !== '') this._pendingPhotoByEntry.delete(String(recordId));
        if (optimisticTempId != null && optimisticTempId !== '') {
            this._pendingPhotoByEntry.delete(String(optimisticTempId));
        }
        if (optimisticSlotKey) this._pendingPhotoBySlot.delete(String(optimisticSlotKey));
        this._bump();
    }

    clearStuckMealPendingFlags() {
        if (typeof window === 'undefined') return false;
        const hist = window.mealHistory;
        if (!Array.isArray(hist) || hist.length === 0) return false;
        let changed = false;
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (!this._pendingPhotoByEntry.has(id)) continue;
            if (id.startsWith('temp_')) continue;
            if (!mealPhotosHaveBase64(m)) {
                this.clearPendingFlagsForRecord(m);
                changed = true;
            }
        }
        if (changed) this._bump();
        return changed;
    }

    hydrateErrorsFromStorage() {
        if (typeof window === 'undefined' || !window.localStorage) return;
        try {
            const raw = window.localStorage.getItem(MEAL_SYNC_ERROR_IDS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return;
            for (const id of arr) {
                if (id != null && id !== '') {
                    const s = String(id);
                    this._errorIds.set(s, true);
                    this._serverSynced.delete(s);
                }
            }
        } catch (_) {
            /* ignore */
        }
        this._bump();
    }

    hydrateAbandonedFromStorage() {
        if (typeof window === 'undefined' || !window.localStorage) return;
        try {
            const raw = window.localStorage.getItem(MEAL_ABANDONED_IDS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return;
            for (const id of arr) {
                if (id != null && id !== '') {
                    const s = String(id);
                    this._abandoned.set(s, true);
                    this._serverSynced.delete(s);
                }
            }
        } catch (_) {
            /* ignore */
        }
        this._bump();
    }

    isDeleting(record) {
        return !!(record?.id && this._deletePending.get(String(record.id)));
    }

    isDeleteInFlight(record) {
        return !!(record?.id && this._deleteInFlight.get(String(record.id)));
    }

    isDeleteFailed(record) {
        return !!(record?.id && this._deleteFailed.get(String(record.id)));
    }

    isSaveFailed(record) {
        if (!record) return false;
        if (record._localSaveFailed === true) return true;
        if (record.is_sync_error === true) return true;
        if (record.id == null || record.id === '') return false;
        return this.hasErrorId(String(record.id));
    }

    isAbandoned(record) {
        return !!(record?.id && this.hasAbandonedId(String(record.id)));
    }

    isServerSynced(record) {
        if (!record?.id) return false;
        const id = String(record.id);
        if (id.startsWith('temp_')) return false;
        return this.hasServerSynced(id);
    }

    isPendingSync(record) {
        if (!record || record._localSaveFailed === true || record.is_sync_error === true) return false;
        if (record.id == null || record.id === '') return false;
        const id = String(record.id);
        if (this.hasErrorId(id)) return false;
        if (this._registerScheduledChip.has(id)) return true;
        if (this.hasAbandonedId(id)) return false;
        if (this.hasInFlight(id)) return true;
        if (id.startsWith('temp_')) return this.hasOptimisticTemp(id);
        if (this.hasPendingPhotoEntry(id)) {
            if (!mealPhotosHaveBase64(record)) {
                this.clearPendingFlagsForRecord(record);
                this._bump();
                return false;
            }
            return true;
        }
        return false;
    }

    isRedoable(record) {
        return this.isSaveFailed(record) || this.isAbandoned(record);
    }

    isRowBlocked(record) {
        if (!record) return false;
        if (this.isDeleting(record)) return true;
        return this.isPendingSync(record);
    }

    countCloudFabManualRetryEntries() {
        if (typeof window === 'undefined' || !Array.isArray(window.mealHistory)) return 0;
        const seen = new Set();
        let n = 0;
        for (const m of window.mealHistory) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (seen.has(id)) continue;
            if (this.isRedoable(m) || this.isDeleteFailed(m)) {
                seen.add(id);
                n++;
            }
        }
        return n;
    }

    /** FAB 배지: 등록예정·삭제예정 칩(레드닷 진행 제외) 건수 */
    countMealSyncFabScheduledChipEntries() {
        if (typeof window === 'undefined' || !Array.isArray(window.mealHistory)) return 0;
        const effOff = isMealSyncUiEffectiveOfflineFab();
        const seen = new Set();
        let n = 0;
        for (const m of window.mealHistory) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (seen.has(id)) continue;
            const k = this.getRowSyncLeadKind(m);
            const chipLike =
                k === 'register_scheduled' ||
                k === 'delete_scheduled' ||
                (effOff && (k === 'pending' || k === 'await_server_ack')) ||
                (effOff && k === 'delete_inflight');
            if (chipLike) {
                seen.add(id);
                n++;
            }
        }
        const hist = window.mealHistory;
        for (const id of this._deletePending.keys()) {
            const sid = String(id);
            if (!sid || sid.startsWith('temp_') || seen.has(sid)) continue;
            if (hist.some((m) => m && String(m.id) === sid)) continue;
            seen.add(sid);
            n++;
        }
        return n;
    }

    countPendingSyncAndDeleteQueue() {
        if (typeof window === 'undefined' || !Array.isArray(window.mealHistory)) return 0;
        const seen = new Set();
        let c = 0;
        for (const m of window.mealHistory) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (seen.has(id)) continue;
            if (this.isPendingSync(m) || this.isDeleting(m)) {
                seen.add(id);
                c++;
            }
        }
        return c;
    }

    /** 타임라인 도트: 조건 한 줄로 분기 (레드닷 꼬임 방지) */
    getRowSyncLeadKind(record) {
        if (!record || record.id == null || record.id === '') return 'none';
        if (this.isDeleting(record)) {
            return this.isDeleteInFlight(record) ? 'delete_inflight' : 'delete_scheduled';
        }
        if (this.isDeleteFailed(record)) return 'delete_failed';
        if (this.isSaveFailed(record)) return 'redoable_failed';
        const rid = String(record.id);
        if (this._registerScheduledChip.has(rid) && !this.isServerSynced(record)) {
            return 'register_scheduled';
        }
        if (this.isAbandoned(record)) return 'redoable_abandoned';
        if (this.isPendingSync(record)) return 'pending';
        if (!this.isServerSynced(record)) return 'await_server_ack';
        return 'synced';
    }

    /** runWithTimeout 만료 시 — Firestore 큐와 무관하게 UI 실패 고정 */
    onSaveUiTimedOut(entryId, optimisticTempId) {
        if (entryId) this.markError(String(entryId));
        if (optimisticTempId) this.markError(String(optimisticTempId));
        this.clearInFlight(entryId);
        if (optimisticTempId) this.clearOptimisticPending(String(optimisticTempId));
        this.clearGraceTimer(entryId);
        if (optimisticTempId) this.clearGraceTimer(String(optimisticTempId));
        this._bump();
    }

    /**
     * Firestore 직접 쓰기 직후: grace → (온라인) waitForPendingWrites → 서버 ack와 타임라인 갱신.
     * Callable 폴백만 성공한 경우 호출하지 않는다(모달에서 즉시 onServerDocumentAcknowledged만).
     */
    /**
     * @returns {Promise<void>}
     */
    /**
     * @param {string|number|null|undefined} mealId
     * @param {string|null|undefined} optimisticTempId
     * @param {string} [dateStr]
     * @param {string} [currentTabVal]
     * @param {number} [graceMs] 사진 유무에 따른 grace (기본 10초)
     */
    scheduleServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal, graceMs) {
        if (!mealId) return Promise.resolve();
        this.scheduleGraceAbandon(String(mealId), {
            optimisticTempId: optimisticTempId || null,
            dateStr,
            currentTab: currentTabVal,
            graceMs: typeof graceMs === 'number' && graceMs > 0 ? graceMs : undefined
        });
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return Promise.resolve();
        }
        const self = this;
        return (async () => {
            try {
                await waitForPendingWrites(db);
                self.onServerDocumentAcknowledged(String(mealId), optimisticTempId || null);
                void refreshTimelineFull(dateStr, currentTabVal);
            } catch (e) {
                console.warn('waitForPendingWrites(동기화 도트):', e?.message || e);
                self.promoteToRegisterScheduledChip(String(mealId), {
                    optimisticTempId: optimisticTempId || null,
                    dateStr,
                    currentTab: currentTabVal
                });
            }
        })();
    }
}

let _singleton = null;

export function getMealSyncManager() {
    if (!_singleton) _singleton = new MealSyncManager();
    return _singleton;
}
