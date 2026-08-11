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
import { isDemoUser } from '../demo-account.js';
import { withDeadline, DEADLINE } from './with-deadline.js';
import {
    isPendingSync as isOutboxPendingSync,
    isPermanentSync as isOutboxPermanentSync,
    pendingCountSync as outboxPendingCountSync
} from './outbox-store.js';

/**
 * localStorage ID 집합 3종(errorIds·abandoned·registerScheduled)은 폐기됐다.
 * 그것들은 「아직 안 올라간 기록」의 **근사치**였고, 근사치가 여러 개라 서로 어긋나는
 * 조합마다 버그가 났다. 이제 아웃박스가 그 사실 자체를 들고 있으므로 근사치가 필요 없다.
 *
 * 2026-08-11 에 abandoned·registerScheduled 와 grace 타이머를 실제로 걷어냈다. 남은 것은
 * `_errorIds` 하나뿐이며, 이것은 저장 실패 배지 병합(shouldPreserveMealSaveFailureOnMerge)이
 * 아직 쓴다 — 아웃박스의 permanent 와 의미가 겹치므로 그 경로를 붙일 때 함께 정리한다.
 */
const MEAL_SYNC_ERROR_IDS_KEY = 'mealog_mealSyncErrorIds_v1';

function mealPhotosHaveBase64(record) {
    if (!record) return false;
    const photos = Array.isArray(record.photos) ? record.photos : record.photos ? [record.photos] : [];
    return photos.some(
        (p) =>
            typeof p === 'string' &&
            (p.startsWith('data:image') || p.startsWith('blob:'))
    );
}

/** 사진 업로드가 아직 안 끝난 행인지 — 스냅샷 병합 보호·저장 분기에서 사용 */
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

export class MealSyncManager {
    constructor() {
        /** @type {Set<(rev: number) => void>} */
        this._listeners = new Set();
        this._revision = 0;

        this._optimisticPending = new Map();
        this._inFlight = new Map();
        this._serverSynced = new Map();
        this._errorIds = new Map();
        this._deletePending = new Map();
        /** deleteDoc await 직전까지 false → 삭제예정, 이후 true → 삭제중 */
        this._deleteInFlight = new Map();
        this._deleteFailed = new Map();
        this._pendingPhotoByEntry = new Map();
        this._pendingPhotoBySlot = new Map();
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

    /** UI 타임아웃·서버 실패 등 — errorIds(저장 실패) 단일 맵 */
    markError(entryId) {
        if (entryId == null || entryId === '') return;
        const s = String(entryId);
        this._serverSynced.delete(s);
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

    /**
     * 서버 반영을 확인하지 못했다 — 「보내는 중」 표시를 풀고 아웃박스에 맡긴다.
     *
     * 예전에는 grace 타이머(10초/30초)가 만료되면 이 자리에서 「등록예정 칩」이라는 별도 표식을
     * 붙였다. 그 표식은 사라졌다 — 표시는 `getRowSyncLeadKind` 가 아웃박스만 보고 판정하므로
     * 여기서 할 일은 **낙관적 표식을 되돌리는 것뿐**이다. 항목 자체는 아웃박스에 남아 있어
     * 다음 드레인·정합 패스가 이어받는다.
     *
     * @param {string|number} entryId
     * @param {{ optimisticTempId?: string|null, dateStr?: string, currentTab?: string }} [opts]
     */
    resetToUnsent(entryId, opts = {}) {
        if (typeof window === 'undefined' || entryId == null || entryId === '') return;
        const id = String(entryId);
        if (!id) return;
        if (this.hasServerSynced(id)) return;
        this.clearInFlight(id);
        const ot = opts.optimisticTempId != null ? String(opts.optimisticTempId) : '';
        if (ot && ot.startsWith('temp_')) {
            this.clearOptimisticPending(ot);
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
        this._inFlight.delete(sid);
        this._serverSynced.delete(sid);
        this._pendingPhotoByEntry.delete(sid);
        this._bump();
    }

    /**
     * 리스너 전용: 서버 스냅샷에서 문서가 서버에 반영됨을 확인했을 때만 호출.
     * 스피너·grace·낙관 temp 정리, 실패 플래그는 기존 규칙 유지.
     */
    onServerDocumentAcknowledged(docId, optimisticTempId) {
        if (typeof window === 'undefined' || docId == null || docId === '') return;
        const sid = String(docId);
        /**
         * 아웃박스에서 빼는 **유일한 지점**이다 (설계 §4.2).
         * 서버 존재가 확인됐을 때만 지운다 — 그 외 어떤 이유로도 지우지 않는다.
         */
        void import('./outbox-store.js').then((ob) => {
            void ob.remove(ob.outboxKey('meal', sid));
        });
        this.clearInFlight(sid);
        const row =
            Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === sid) : null;
        const rowIndicatesFailure =
            row?._localSaveFailed === true ||
            row?.is_sync_error === true;
        if (!rowIndicatesFailure && !this.hasErrorId(sid)) {
            this.clearError(sid);
        }
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

    /** 쓰기 큐가 비었는데도 inFlight 만 남아 '보내는 중' 표시가 고착되는 경우 정리 */
    _clearStuckInFlightFlags() {
        const hist = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_')) continue;
            if (this.hasErrorId(id)) continue;
            if (m._localSaveFailed === true || m.is_sync_error === true) continue;
            if (this.isDeleting(m) || this.isDeleteFailed(m)) continue;
            if (this.hasInFlight(id)) this.clearInFlight(id);
        }
    }

    /**
     * 이 문서가 지금 서버에 있는가 — 「기록별 서버 ack」의 단일 확인 지점.
     * @param {string} id
     * @returns {Promise<boolean|null>} true=있음, false=없음, null=확인 못 함(오프라인 등)
     */
    async _serverDocumentExists(id) {
        if (typeof window === 'undefined') return null;
        const user = window.currentUser;
        const uid = user?.uid;
        if (!uid || user?.isAnonymous) return null;
        // 데모 계정은 서버 대조 대상이 아니다 — 확인 없이 통과시켜 기존 동작을 유지한다.
        if (isDemoUser(user)) return true;
        try {
            // 상한 필수: 반쯤 끊긴 연결에서 getDocFromServer 는 정착하지 않는다.
            // 여기서 매달리면 이 함수를 await 하는 드레인 전체가 영구히 멈춘다.
            const snap = await withDeadline(
                getDocFromServer(doc(db, 'artifacts', appId, 'users', uid, 'meals', String(id))),
                DEADLINE.DOC,
                'serverDocumentExists'
            );
            return snap.exists();
        } catch (e) {
            console.warn('[meal-sync] 서버 문서 확인 실패:', id, e?.message || e);
            return null; // 확인 못 함 — 다음 패스가 이어받는다
        }
    }

    /**
     * 동기화 표시를 서버 실체와 맞추는 단일 정합 패스.
     *
     * 예전에는 ack 보정·삭제 보정·도트 보정 셋이 따로 있었고, 같은 문서를 각자 읽으면서 대상
     * 선정 기준만 조금씩 달랐다. 표시를 3가지로 축약(2fb7cbb)할 때 그중 하나는 결과 적용 필터가
     * 옛 이름('pending'·'await_server_ack'·'delete_scheduled')에 남아, 서버를 읽고도 아무것도
     * 반영하지 않는 채 죽어 있었다. 기준이 다시 갈라질 수 없도록 하나로 합친다 — 문서당 서버
     * 읽기도 3회에서 1회로 줄어든다.
     *
     * 연결 상태 boolean 으로 게이트하지 않는다. 실제로 오프라인이면 서버 읽기가 실패하고, 그
     * 문서만 조용히 건너뛰어 다음 패스가 이어받는다.
     *
     * @param {{ writeQueueFlushed?: boolean }} [opts] 쓰기 큐 flush 가 확인된 직후인지.
     *   확인됐을 때만 inFlight 고착을 정리한다 — 아직 보내는 중인 쓰기를 지우지 않기 위해.
     * @returns {Promise<void>}
     */
    async reconcileMealSyncAgainstServer(opts = {}) {
        if (typeof window === 'undefined') return;
        const uid = window.currentUser?.uid;
        if (!uid || window.currentUser?.isAnonymous) return;

        if (opts.writeQueueFlushed === true) this._clearStuckInFlightFlags();

        /** 서버 읽기 사이에 mealHistory 가 교체될 수 있으므로 매번 새로 읽는다 */
        const rowById = (id) => {
            const arr = Array.isArray(window.mealHistory) ? window.mealHistory : [];
            return arr.find((m) => m && String(m.id) === id) || null;
        };

        /** @type {Map<string, { deleting: boolean, record: * }>} */
        const targets = new Map();

        // 삭제 예약·진행 — 행이 이미 화면에서 사라진 경우도 있으므로 맵에서 직접 모은다
        for (const key of [...this._deletePending.keys(), ...this._deleteInFlight.keys()]) {
            const id = String(key);
            if (!id || id.startsWith('temp_')) continue;
            targets.set(id, { deleting: true, record: rowById(id) });
        }

        // 서버 반영이 확인되지 않은 행
        const hist = Array.isArray(window.mealHistory) ? window.mealHistory : [];
        for (const m of hist) {
            if (!m?.id) continue;
            const id = String(m.id);
            if (id.startsWith('temp_') || targets.has(id)) continue;
            if (this.isDeleting(m)) {
                targets.set(id, { deleting: true, record: m });
                continue;
            }
            if (this.isDeleteFailed(m)) continue;
            if (this.hasErrorId(id)) continue;
            if (m._localSaveFailed === true || m.is_sync_error === true) continue;
            if (this.hasInFlight(id)) continue; // 지금 보내는 중 — 결과를 기다린다
            if (mealPhotosHaveBase64(m)) continue;
            const slotKey = `${m.date || ''}__${m.slotId || ''}`;
            if (this.hasPendingPhotoEntry(id) || this.hasPendingPhotoSlot(slotKey)) continue;
            if (this.getRowSyncLeadKind(m) !== 'syncing') continue;
            targets.set(id, { deleting: false, record: m });
        }

        if (targets.size === 0) return;

        const reads = await Promise.all(
            [...targets.entries()].map(async ([id, t]) => {
                try {
                    // 상한 필수 — 이 Promise.all 이 매달리면 드레인이 통째로 죽는다.
                    // 읽지 못한 건은 exists: null 로 두면 아래에서 건너뛰고 다음 패스가 이어받는다.
                    const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', id);
                    const snap = await withDeadline(getDocFromServer(ref), DEADLINE.DOC, 'reconcile-read');
                    return { id, deleting: t.deleting, record: t.record, exists: snap.exists() };
                } catch (e) {
                    console.warn('[meal-sync] 서버 정합 읽기 실패:', id, e?.message || e);
                    return { id, deleting: t.deleting, record: t.record, exists: null };
                }
            })
        );

        const { applyOptimisticMealDelete } = await import('./meal-delete-optimistic.js');

        for (const r of reads) {
            if (r.exists === null) continue; // 읽지 못함 — 다음 패스가 이어받는다
            if (r.deleting) {
                if (r.exists) continue; // 아직 서버에 있다 — 삭제가 나가지 않았다
                const prev = rowById(r.id);
                this.markDeleteComplete(r.id);
                this.clearDeleteFailed(r.id);
                // 서버에서 사라진 것이 확인됐다 — 삭제 항목도 이때만 아웃박스에서 뺀다
                void import('./outbox-store.js').then((ob) => {
                    void ob.remove(ob.outboxKey('meal', r.id));
                });
                if (prev) applyOptimisticMealDelete(r.id, prev);
                continue;
            }
            if (r.exists) {
                this.onServerDocumentAcknowledged(r.id, null);
            } else {
                this.resetToUnsent(r.id, {
                    dateStr: r.record?.date,
                    currentTab: appState.currentTab
                });
            }
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
        return this.isSaveFailed(record);
    }

    isRowBlocked(record) {
        if (!record) return false;
        // 삭제 진행 중에만 행 열기 차단. 등록 대기(pending)는 ID 선발급으로 setDoc이 멱등이라
        // 수정·삭제 모두 안전 — 열어서 편집/삭제할 수 있게 허용 (오프라인 삭제불가 이슈 해소)
        return this.isDeleting(record);
    }

    /**
     * 아직 서버에 올라가지 않은 기록 수 — FAB 배지와 아웃박스 드레인이 같은 값을 본다.
     *
     * 예전에는 배지(등록예정 칩 기준)와 드레인 발동(칩·inFlight·실패 기준)이 서로 다른 집합을
     * 세서, 배지에 N 이 떠 있는데 눌러도 드레인이 「남은 일 없음」으로 즉시 반환하는 조합이
     * 생길 수 있었다. 사용자에게는 눌러도 아무 일도 안 일어나는 버튼으로 보인다.
     *
     * 기준은 행에 이미 그리고 있는 표시 그대로다 — synced 가 아니면 남은 일이다. 보내는 중
     * (inFlight)도 뺄 수 없다: 그 표식이 고착되면 기록이 배지에서 사라져 사용자가 손쓸 방법이
     * 없어진다. 실제로 다시 밀어 올릴지는 드레인이 기록별로 isRetryEligible 로 정한다.
     */
    countUnsentMealWork() {
        if (typeof window === 'undefined') return 0;
        /**
         * 배지 = 아웃박스 크기. 워커와 **같은 집합**을 본다.
         *
         * 예전에는 mealHistory 를 훑어 세면서 화면에서 사라진 삭제 예약을 따로 더하는
         * 보정이 필요했고, 그 기준이 드레인과 갈라져 「배지에 N 이 뜨는데 눌러도 아무 일도
         * 안 하는 버튼」이 생길 수 있었다. 기준이 하나면 그 불일치가 원리적으로 없다.
         */
        return outboxPendingCountSync(window.currentUser?.uid);
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
        const id = String(record.id);
        // 아웃박스 이전의 낙관 temp 행 — 아웃박스에 없으므로 별도 보호
        if (id.startsWith('temp_')) return 'syncing';
        /**
         * 아웃박스가 유일한 기준이다 (§4.4).
         *   없다              → synced  (워커는 서버 확인된 것만 지운다)
         *   있다              → syncing (기다리면 된다)
         *   있고 permanent    → failed  (재시도 무의미, 사용자 개입 필요)
         *
         * 예전에는 여섯 개의 병렬 플래그가 각자 표시를 주장했고, 표식이 재시도 과정에서
         * 서로 옮겨 다녀 「표식이 하나도 없는 찰나」에 기록이 사라졌다. 기준이 하나면
         * 그 레이스가 존재할 수 없다.
         */
        if (!isOutboxPendingSync('meal', id)) return 'synced';
        return isOutboxPermanentSync('meal', id) ? 'failed' : 'syncing';
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
     */
    scheduleServerAckAfterPendingWrites(mealId, optimisticTempId, dateStr, currentTabVal) {
        if (!mealId) return Promise.resolve();
        // 오프라인이어도 ack 대기를 건다. waitForPendingWrites 는 재연결 후 resolve 되므로
        // 쓰기가 서버에 닿는 즉시 초록 도트로 바뀐다. 그 사이에는 syncing 으로 표시된다.
        const self = this;
        return (async () => {
            let existsOnServer = null;
            try {
                /**
                 * 상한 필수. `waitForPendingWrites` 는 **오프라인이면 정의상 resolve 되지 않는다.**
                 * 그런데 이 함수는 「아직 못 보낸 것을 보내자」는 재시도 경로에서 await 되므로,
                 * 오프라인일 확률이 구조적으로 가장 높은 지점에서 영원히 매달렸다. 그 결과
                 * retryMealEntrySync 의 finally 가 돌지 않아 해당 기록은 다시 시도할 수 없게 되고,
                 * 그것을 await 하던 드레인의 drainInFlight 도 영구히 잠겼다.
                 *
                 * 타임아웃되면 아래에서 existsOnServer 가 null 로 남아 「등록예정」으로 되돌아간다 —
                 * 아웃박스에 그대로 남으므로 다음 패스가 이어받는다. 유실이 아니다.
                 */
                await withDeadline(waitForPendingWrites(db), DEADLINE.SAVE, 'ack-waitForPendingWrites');
                // 리스너가 이미 서버 스냅샷으로 ack 했으면 그것이 곧 기록별 확인이다 — 서버 읽기 생략.
                if (self.hasServerSynced(String(mealId))) {
                    void refreshTimelineFull(dateStr, currentTabVal);
                    return;
                }
                /**
                 * 「클라이언트 큐가 비었다」는 「내 문서가 서버에 닿았다」와 다른 말이다.
                 * setDoc 이 큐에 들어가기 전에 상위 await 가 끊겼거나(오프라인에서 저장 직전
                 * getDoc 이 매달리는 경로 등), 큐가 다른 이유로 비워졌으면 이 문서는 서버에
                 * 없는데도 여기에 도달한다. 그 상태로 ack 하면 초록으로 바뀌면서 보호 표식이
                 * 전부 풀리고, 다음 리스너 재구독 병합에서 행이 조용히 사라진다 — 사용자에게는
                 * 「올라가지도 않고 기록이 없어졌다」로 보인다. 그래서 문서 단위로 확인한다.
                 */
                existsOnServer = await self._serverDocumentExists(String(mealId));
            } catch (e) {
                console.warn('waitForPendingWrites(동기화 표시):', e?.message || e);
            }
            if (existsOnServer === true) {
                self.onServerDocumentAcknowledged(String(mealId), optimisticTempId || null);
                void refreshTimelineFull(dateStr, currentTabVal);
                return;
            }
            // 서버에 없거나 확인하지 못했다 — 아웃박스에 남겨 둔다. 다음 드레인·정합이 이어받는다.
            self.resetToUnsent(String(mealId), {
                optimisticTempId: optimisticTempId || null,
                dateStr,
                currentTab: currentTabVal
            });
        })();
    }
}

let _singleton = null;

export function getMealSyncManager() {
    if (!_singleton) _singleton = new MealSyncManager();
    return _singleton;
}
