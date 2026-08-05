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
const MEAL_REGISTER_SCHEDULED_IDS_KEY = 'mealog_mealSyncRegisterScheduledIds_v1';

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

function persistRegisterScheduledId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    const s = String(entryId);
    if (s.startsWith('temp_')) return; // temp 행 데이터는 재시작 후 없으므로 영속화하지 않음
    try {
        const raw = window.localStorage.getItem(MEAL_REGISTER_SCHEDULED_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        if (!arr.includes(s)) {
            arr.push(s);
            window.localStorage.setItem(MEAL_REGISTER_SCHEDULED_IDS_KEY, JSON.stringify(arr));
        }
    } catch (_) {
        /* ignore */
    }
}

function unpersistRegisterScheduledId(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_REGISTER_SCHEDULED_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        const s = String(entryId);
        window.localStorage.setItem(MEAL_REGISTER_SCHEDULED_IDS_KEY, JSON.stringify(arr.filter((x) => x !== s)));
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
            if (currentTab === 'timeline') {
                if (dateStr && mod.renderTimelineDateSections) mod.renderTimelineDateSections([dateStr]);
                else if (mod.renderTimeline) mod.renderTimeline();
            } else if (mod.updateTimelineMealEntryPendingIndicators) mod.updateTimelineMealEntryPendingIndicators();
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

    /** 등록예정 칩 상태 — 리스너 재구독 병합(find-unique-meals)에서 로컬 전용 행 보호에 사용 */
    hasRegisterScheduledChip(id) {
        return id != null && id !== '' && this._registerScheduledChip.has(String(id));
    }

    _addRegisterScheduledChip(id) {
        const s = String(id);
        this._registerScheduledChip.add(s);
        persistRegisterScheduledId(s);
    }

    _deleteRegisterScheduledChip(id) {
        const s = String(id);
        this._registerScheduledChip.delete(s);
        unpersistRegisterScheduledId(s);
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
        this._deleteRegisterScheduledChip(s);
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
        this._deleteRegisterScheduledChip(s);
        this._serverSynced.delete(s);
        this._abandoned.set(s, true);
        persistAbandonedId(entryId);
        this._bump();
    }

    clearAbandoned(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._deleteRegisterScheduledChip(s);
        this._abandoned.delete(s);
        unpersistAbandonedId(entryId);
        this._bump();
    }

    /** UI 타임아웃·서버 실패 등 — errorIds(저장 실패) 단일 맵 */
    markError(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._deleteRegisterScheduledChip(s);
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
        this._deleteRegisterScheduledChip(s);
        this._deletePending.delete(s);
        this._deleteInFlight.delete(s);
        this._bump();
    }

    markDeleteFailed(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._deleteRegisterScheduledChip(s);
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
        this._addRegisterScheduledChip(id);
        this.clearInFlight(id);
        const ot = opts.optimisticTempId != null ? String(opts.optimisticTempId) : '';
        if (ot && ot.startsWith('temp_')) {
            this.clearAbandoned(ot);
            this.clearOptimisticPending(ot);
            this._addRegisterScheduledChip(ot);
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
        this._deleteRegisterScheduledChip(id);
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
        this._deleteRegisterScheduledChip(sid);
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
        // navigator.onLine 뿐 아니라 localNetworkForcedOffline(실패로 감지된 오프라인)도 등록예정 칩으로 승격
        if (!force && !isMealogTransportOffline()) return;
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
        this._deleteRegisterScheduledChip(sid);
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
            this._deleteRegisterScheduledChip(tid);
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
     * 서버에 meal 문서가 실제로 있을 때만 ack — 로컬만 앞서 간 상태에서 초록으로 잘못 올라가는 것을 막는다.
     * @returns {Promise<void>}
     */
    async reconcileSyncUiAfterClientWriteQueueFlush() {
        if (typeof window === 'undefined') return;
        // navigator.onLine 은 Wi-Fi↔LTE 전환 후 false 로 고착되어 오탐이 잦으므로 게이트로 쓰지 않는다.
        // 실패로 확인된 오프라인(localNetworkForcedOffline)일 때만 건너뛴다 — `online` 이벤트 없이 복귀한
        // 경우에도 큐 flush 후 초록 도트로 맞출 수 있어야 함. (오프라인이면 아래 서버 읽기가 실패해 자연히 skip)
        if (appState.localNetworkForcedOffline === true) return;
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

        const uid = window.currentUser?.uid;
        const candidates = [];
        const seenCand = new Set();
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
            // 서버 반영이 확인되지 않았고 지금 보내는 중도 아닌 것만 대조 대상
            if (this.getRowSyncLeadKind(m) !== 'syncing') continue;
            if (this.hasInFlight(id)) continue;
            if (!seenCand.has(id)) {
                seenCand.add(id);
                candidates.push(id);
            }
        }

        if (candidates.length === 0) return;
        if (!uid) return;

        await Promise.all(
            candidates.map(async (id) => {
                try {
                    const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', id);
                    const snap = await getDocFromServer(ref);
                    if (snap.exists()) {
                        this.onServerDocumentAcknowledged(id, null);
                    }
                } catch (e) {
                    console.warn('reconcileSyncUi server verify:', id, e?.message || e);
                }
            })
        );
    }

    /**
     * 삭제 예약/진행이 스냅샷 removed·메타 누락으로 고착될 때, 서버에 meal 문서가 없으면 삭제 완료로 맞춘다.
     * `waitForPendingWrites` 직후에만 호출한다.
     * @returns {Promise<void>}
     */
    async reconcilePendingDeletesWithServer() {
        if (typeof window === 'undefined') return;
        // navigator.onLine 오탐 회피 — 실패로 확인된 오프라인일 때만 skip
        if (appState.localNetworkForcedOffline === true) return;
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

    /**
     * 스냅샷 메타(hasPendingWrites·fromCache)와 어긋나 레드닷·삭제 표시가 고착된 경우,
     * getDocFromServer으로 서버 실체와 맞춘다.
     * @returns {Promise<void>}
     */
    async reconcileStaleMealSyncDotsAgainstServer() {
        if (typeof window === 'undefined') return;
        // navigator.onLine 오탐 회피 — 실패로 확인된 오프라인일 때만 skip
        if (appState.localNetworkForcedOffline === true) return;
        const uid = window.currentUser?.uid;
        if (!uid || window.currentUser?.isAnonymous) return;
        const hist = window.mealHistory;
        if (!Array.isArray(hist) || hist.length === 0) return;

        const tasks = [];
        const seen = new Set();
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_') || seen.has(id)) continue;
            const kind = this.getRowSyncLeadKind(m);
            if (kind !== 'syncing') continue;
            seen.add(id);
            tasks.push({ id, kind, record: m });
        }
        if (tasks.length === 0) return;

        const { applyOptimisticMealDelete } = await import('./meal-delete-optimistic.js');

        const reads = await Promise.all(
            tasks.map(async ({ id, kind, record }) => {
                try {
                    const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', id);
                    const snap = await getDocFromServer(ref);
                    return { id, kind, record, exists: snap.exists() };
                } catch (e) {
                    console.warn('reconcileStaleMealSyncDotsAgainstServer read:', id, e?.message || e);
                    return { id, kind, record, exists: null };
                }
            })
        );

        const deletes = reads.filter(
            (r) => r.exists === false && (r.kind === 'delete_scheduled' || r.kind === 'delete_inflight')
        );
        const acks = reads.filter(
            (r) => r.exists === true && (r.kind === 'pending' || r.kind === 'await_server_ack')
        );
        const fallbacks = reads.filter(
            (r) => r.exists === false && (r.kind === 'pending' || r.kind === 'await_server_ack')
        );

        for (const r of deletes) {
            const prev = window.mealHistory?.find((m) => m && String(m.id) === r.id);
            this.markDeleteComplete(r.id);
            this.clearDeleteFailed(r.id);
            if (prev) applyOptimisticMealDelete(r.id, prev);
        }

        for (const r of acks) {
            this.onServerDocumentAcknowledged(r.id, null);
        }

        for (const r of fallbacks) {
            this.promoteToRegisterScheduledChip(r.id, {
                dateStr: r.record?.date,
                currentTab: appState.currentTab
            });
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

    /** 등록예정 칩 복원 — 재시작 후에도 서버 미확인 기록이 등록예정으로 남도록. 서버 ack 시 자동 해제됨 */
    hydrateRegisterScheduledFromStorage() {
        if (typeof window === 'undefined' || !window.localStorage) return;
        try {
            const raw = window.localStorage.getItem(MEAL_REGISTER_SCHEDULED_IDS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(arr)) return;
            for (const id of arr) {
                if (id != null && id !== '' && !String(id).startsWith('temp_')) {
                    this._registerScheduledChip.add(String(id));
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
        // 삭제 진행 중에만 행 열기 차단. 등록 대기(pending)는 ID 선발급으로 setDoc이 멱등이라
        // 수정·삭제 모두 안전 — 열어서 편집/삭제할 수 있게 허용 (오프라인 삭제불가 이슈 해소)
        return this.isDeleting(record);
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
    /**
     * 온라인일 때 레드닷 동기화 진행 중(pending / 서버 반영 대기 / 삭제 중) 건수.
     * 이 동안에는 FAB를 숨겨 예정 칩 전용 뱃지와 역할이 겹치지 않게 한다.
     */
    countMealSyncFabRedDotTransportSyncEntries() {
        if (typeof window === 'undefined' || !Array.isArray(window.mealHistory)) return 0;
        if (isMealSyncUiEffectiveOfflineFab()) return 0;
        const seen = new Set();
        let n = 0;
        for (const m of window.mealHistory) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (seen.has(id)) continue;
            if (this.getRowSyncLeadKind(m) === 'syncing') {
                seen.add(id);
                n++;
            }
        }
        return n;
    }

    countMealSyncFabScheduledChipEntries() {
        if (typeof window === 'undefined' || !Array.isArray(window.mealHistory)) return 0;
        const seen = new Set();
        let n = 0;
        for (const m of window.mealHistory) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (seen.has(id)) continue;
            if (this.getRowSyncLeadKind(m) === 'syncing') {
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

    /**
     * 행 동기화 표시 — 사용자가 다르게 행동할 수 있는 것만 남긴 3가지.
     *
     *   syncing : 서버 반영이 아직 확인되지 않음 → 기다리면 된다
     *   failed  : 쓰기가 실제로 실패함 → 탭해서 다시 시도한다
     *   synced  : 서버 반영 확인됨
     *
     * 예전에는 pending·await_server_ack·register_scheduled·abandoned·delete_scheduled·
     * delete_inflight 를 따로 구분했는데, 어느 쪽이든 사용자가 할 수 있는 일은 같았다.
     * 게다가 그 구분이 시간(grace 10·30초)과 연결 상태에 따라 바뀌어서, 느린 네트워크와
     * 끊긴 네트워크가 같은 UI로 수렴했고 「진짜 끊겼는지」를 되묻는 로직이 UI 쪽으로 번졌다.
     *
     * 삭제/등록 구분은 상태가 아니라 문구의 문제이므로 렌더에서 isDeleting 으로 판단한다.
     */
    getRowSyncLeadKind(record) {
        if (!record || record.id == null || record.id === '') return 'none';
        if (this.isDeleteFailed(record) || this.isSaveFailed(record)) return 'failed';
        if (this.isDeleting(record)) return 'syncing';
        if (this.isPendingSync(record)) return 'syncing';
        if (!this.isServerSynced(record)) return 'syncing';
        return 'synced';
    }

    /**
     * 다시 밀어 올릴 대상인지 — 아웃박스 드레인·재전송 FAB 공용.
     *
     * 「서버 반영이 확인되지 않았고, 지금 보내는 중도 아니다」가 기준이다.
     * 예전에는 abandoned·register_scheduled 표식이 붙은 것만 대상으로 삼았는데,
     * 그 표식은 grace 타이머가 붙여 주는 것이라 타이머를 놓치면 재전송에서 누락됐다.
     */
    isRetryEligible(record) {
        if (!record?.id) return false;
        const id = String(record.id);
        if (id.startsWith('temp_')) return false;
        if (this.isDeleteFailed(record) || this.isSaveFailed(record)) return true;
        if (this.isDeleting(record)) return false; // 삭제는 별도 재시도 경로
        if (this.hasInFlight(id)) return false; // 이미 전송 중
        return !this.isServerSynced(record);
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
        // navigator.onLine 오탐으로 ack 대기를 건너뛰면 초록 도트가 안 뜨므로, 실패로 확인된 오프라인일 때만 skip.
        // (실제 오프라인이면 waitForPendingWrites 는 재연결 후 resolve 되고 그 사이 grace→등록예정 칩으로 표시됨)
        if (appState.localNetworkForcedOffline === true) {
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
