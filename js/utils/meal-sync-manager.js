/**
 * 식사 Firestore 동기화 UI 상태 단일 소스.
 * window.* 맵에 의존하지 않는다 — 외부는 getMealSyncManager()와 meal-entry-pending re-export만 사용.
 */

const MEAL_SYNC_ERROR_IDS_KEY = 'mealog_mealSyncErrorIds_v1';
const MEAL_ABANDONED_IDS_KEY = 'mealog_mealSyncAbandonedIds_v1';

function mealPhotosHaveBase64(record) {
    if (!record) return false;
    const photos = Array.isArray(record.photos) ? record.photos : record.photos ? [record.photos] : [];
    return photos.some((p) => typeof p === 'string' && p.startsWith('data:image'));
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

export const MEAL_SYNC_GRACE_MS = 10000;

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
        this._deleteFailed = new Map();
        this._pendingPhotoByEntry = new Map();
        this._pendingPhotoBySlot = new Map();
        this._graceTimers = new Map();
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
        this._inFlight.set(String(entryId), true);
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
        this._serverSynced.delete(s);
        this._abandoned.set(s, true);
        persistAbandonedId(entryId);
        this._bump();
    }

    clearAbandoned(entryId) {
        if (entryId == null || entryId === '') return;
        this._abandoned.delete(String(entryId));
        unpersistAbandonedId(entryId);
        this._bump();
    }

    /** UI 타임아웃·서버 실패 등 — errorIds(저장 실패) 단일 맵 */
    markError(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
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
        this._deletePending.set(String(entryId), true);
        this._bump();
    }

    markDeleteComplete(entryId) {
        if (entryId == null || entryId === '') return;
        this._deletePending.delete(String(entryId));
        this._bump();
    }

    markDeleteFailed(entryId) {
        if (entryId == null || entryId === '') return;
        this.markDeleteComplete(entryId);
        this._deleteFailed.set(String(entryId), true);
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

    scheduleGraceAbandon(entryId, opts = {}) {
        if (typeof window === 'undefined' || entryId == null || entryId === '') return;
        const id = String(entryId);
        this.clearGraceTimer(id);
        this._graceTimers.set(
            id,
            setTimeout(() => {
                this._graceTimers.delete(id);
                if (this.hasServerSynced(id)) return;
                const row =
                    Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === id) : null;
                if (row && (row._localSaveFailed === true || row.is_sync_error === true)) return;
                if (this.hasErrorId(id)) return;

                this.markAbandoned(id);
                this.clearInFlight(id);

                const ot = opts.optimisticTempId != null ? String(opts.optimisticTempId) : '';
                if (ot && ot.startsWith('temp_')) {
                    this.clearOptimisticPending(ot);
                    this.markAbandoned(ot);
                }
                if (row) {
                    this.clearPendingFlagsForRecord(row);
                } else {
                    this._pendingPhotoByEntry.delete(id);
                }

                this._bump();
                const { dateStr, currentTab } = opts;
                void refreshTimelineFull(dateStr, currentTab);
            }, MEAL_SYNC_GRACE_MS)
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
        this._inFlight.delete(sid);
        this._serverSynced.delete(sid);
        this._pendingPhotoByEntry.delete(sid);
        this._bump();
    }

    applyAbandonOnOffline() {
        for (const id of [...this._inFlight.keys()]) {
            this.clearGraceTimer(id);
            this.markAbandoned(id);
            this.clearInFlight(id);
        }
        for (const tid of [...this._optimisticPending.keys()]) {
            this.clearGraceTimer(tid);
            this.markAbandoned(tid);
            this.clearOptimisticPending(tid);
        }
        for (const pid of [...this._pendingPhotoByEntry.keys()]) {
            this.clearGraceTimer(pid);
            this.markAbandoned(pid);
            this._pendingPhotoByEntry.delete(pid);
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
        this.markAbandoned(id);
        this.clearInFlight(id);
        if (ot) this.markAbandoned(ot);
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
        if (this.isDeleting(record)) return 'deleting';
        if (this.isDeleteFailed(record)) return 'delete_failed';
        if (this.isSaveFailed(record)) return 'redoable_failed';
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
}

let _singleton = null;

export function getMealSyncManager() {
    if (!_singleton) _singleton = new MealSyncManager();
    return _singleton;
}
