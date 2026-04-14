/**
 * 식사 기록이 아직 서버 반영 전(임시 id)이거나 사진 업로드 등 후속 작업 중인지
 * (_localSaveFailed가 있으면 등록 실패 상태이므로 대기 아님)
 */
function mealPhotosHaveBase64(record) {
    if (!record) return false;
    const photos = Array.isArray(record.photos) ? record.photos : record.photos ? [record.photos] : [];
    return photos.some((p) => typeof p === 'string' && p.startsWith('data:image'));
}

/**
 * Firestore 저장이 끝났고(필요 시 Storage 업로드까지 끝났을 때) 호출 — 스피너용 대기 플래그 제거
 * await dbOps.save / 업로드 finally 등 “서버 작업 완료” 피드백 지점에서 호출한다.
 */
/** 신규 저장 시도 중인 temp_* 행만 스피너 — 무조건 temp_≠항상 대기(오프라인·실패 시 고착 방지) */
export function markMealOptimisticSavePending(tempId) {
    if (typeof window === 'undefined' || !tempId) return;
    if (!window._mealOptimisticPendingTempIds) window._mealOptimisticPendingTempIds = {};
    window._mealOptimisticPendingTempIds[String(tempId)] = true;
}

export function clearMealOptimisticSavePending(tempId) {
    if (typeof window === 'undefined' || !tempId) return;
    if (window._mealOptimisticPendingTempIds) delete window._mealOptimisticPendingTempIds[String(tempId)];
}

/** 수정 저장 등 실제 id로 서버 요청 중일 때 타임라인 스피너용 */
export function markMealEntrySaveInFlight(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (!window._mealEntrySaveInFlightIds) window._mealEntrySaveInFlightIds = {};
    window._mealEntrySaveInFlightIds[String(entryId)] = true;
}

export function clearMealEntrySaveInFlight(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (window._mealEntrySaveInFlightIds) delete window._mealEntrySaveInFlightIds[String(entryId)];
}

export function isMealEntrySaveInFlight(record) {
    if (!record?.id || typeof window === 'undefined') return false;
    return !!window._mealEntrySaveInFlightIds?.[String(record.id)];
}

/**
 * 사진 업로드·슬롯 대기 플래그만 정리한다.
 * 타임라인 스피너(등록 중)는 Firestore 스냅샷에서 서버 반영(hasPendingWrites false)일 때
 * onMealDocFirestoreServerAcknowledged에서만 해제한다 — setDoc/addDoc Promise만으로는 큐에만 쌓인 경우가 있어
 * 모달 전환 후 스피너가 사라지는 문제를 막는다.
 */
export function markMealEntryServerWorkComplete(recordId, optimisticTempId, optimisticSlotKey) {
    if (typeof window === 'undefined') return;
    if (!window._pendingPhotoUploadByEntryId) window._pendingPhotoUploadByEntryId = {};
    if (recordId != null && recordId !== '') {
        delete window._pendingPhotoUploadByEntryId[String(recordId)];
    }
    if (optimisticTempId != null && optimisticTempId !== '') {
        delete window._pendingPhotoUploadByEntryId[String(optimisticTempId)];
    }
    if (optimisticSlotKey && window._pendingPhotoUploadBySlotKey) {
        delete window._pendingPhotoUploadBySlotKey[optimisticSlotKey];
    }
}

function clearPendingFlagsForEntryId(record) {
    if (!record?.id || typeof window === 'undefined') return;
    const id = String(record.id);
    if (window._pendingPhotoUploadByEntryId) {
        delete window._pendingPhotoUploadByEntryId[id];
    }
    const sk = `${record.date || ''}__${record.slotId || ''}`;
    if (sk && window._pendingPhotoUploadBySlotKey) {
        delete window._pendingPhotoUploadBySlotKey[sk];
    }
}

/** findIndex 실패 등으로 meal 레코드에 못 붙일 때만 쓰는 보조 실패 표시 (오프라인 등) */
const MEAL_SYNC_ERROR_IDS_KEY = 'mealog_mealSyncErrorIds_v1';

function persistMealSyncErrorIdToStorage(entryId) {
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

function unpersistMealSyncErrorIdFromStorage(entryId) {
    if (typeof window === 'undefined' || !window.localStorage || entryId == null || entryId === '') return;
    try {
        const raw = window.localStorage.getItem(MEAL_SYNC_ERROR_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        const s = String(entryId);
        const next = arr.filter((x) => x !== s);
        window.localStorage.setItem(MEAL_SYNC_ERROR_IDS_KEY, JSON.stringify(next));
    } catch (_) {
        /* ignore */
    }
}

/**
 * 새로고침 후에도 동기화 실패(느낌표) 상태를 복원하기 위해 id 목록을 localStorage에 보관한다.
 * setupListeners / mealHistory 병합 전에 한 번 호출한다.
 */
export function hydrateMealSyncErrorIdsFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const raw = window.localStorage.getItem(MEAL_SYNC_ERROR_IDS_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return;
        if (!window._mealEntrySaveFailedIds) window._mealEntrySaveFailedIds = {};
        for (const id of arr) {
            if (id != null && id !== '') window._mealEntrySaveFailedIds[String(id)] = true;
        }
    } catch (_) {
        /* ignore */
    }
}

export function markMealEntrySaveFailedById(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (!window._mealEntrySaveFailedIds) window._mealEntrySaveFailedIds = {};
    window._mealEntrySaveFailedIds[String(entryId)] = true;
    persistMealSyncErrorIdToStorage(entryId);
}

export function clearMealEntrySaveFailedById(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (window._mealEntrySaveFailedIds) delete window._mealEntrySaveFailedIds[String(entryId)];
    unpersistMealSyncErrorIdFromStorage(entryId);
}

/**
 * Firestore 스냅샷에서 해당 문서가 반영됨(hasPendingWrites false)일 때 — 스피너·temp 낙관 정리.
 * 등록 실패(느낌표)는 _mealEntrySaveFailedIds / is_sync_error 로 남을 수 있는데,
 * 편집 저장이 네트워크로 실패해도 서버에는 **이전 버전 문서**가 그대로 있어 스냅샷이 자주 온다.
 * 그때마다 실패 플래그를 지우면 느낌표를 한 번도 못 보게 된다.
 * → 실패로 표시 중인 id는 여기서 지우지 않고, 저장/재시도 성공 시에만 clearMealEntrySaveFailedById 한다.
 */
export function onMealDocFirestoreServerAcknowledged(docId, optimisticTempId) {
    if (typeof window === 'undefined' || docId == null || docId === '') return;
    clearMealEntrySaveInFlight(String(docId));
    const sid = String(docId);
    const row =
        Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === sid) : null;
    const rowIndicatesFailure =
        row?._localSaveFailed === true ||
        row?.is_sync_error === true;
    if (!rowIndicatesFailure && !window._mealEntrySaveFailedIds?.[sid]) {
        clearMealEntrySaveFailedById(sid);
    }
    if (optimisticTempId != null && optimisticTempId !== '') {
        clearMealOptimisticSavePending(String(optimisticTempId));
        const tid = String(optimisticTempId);
        const tempRow =
            Array.isArray(window.mealHistory) ? window.mealHistory.find((m) => m && String(m.id) === tid) : null;
        const tempRowFailed =
            tempRow?._localSaveFailed === true ||
            tempRow?.is_sync_error === true;
        if (!tempRowFailed && !window._mealEntrySaveFailedIds?.[tid]) {
            clearMealEntrySaveFailedById(tid);
        }
    }
}

export function isMealEntryPendingSync(record) {
    if (!record || record._localSaveFailed === true || record.is_sync_error === true) return false;
    if (record.id == null || record.id === '') return false;
    const id = String(record.id);
    if (typeof window !== 'undefined' && window._mealEntrySaveFailedIds?.[id]) return false;

    if (typeof window !== 'undefined' && window._mealEntrySaveInFlightIds?.[id]) return true;

    if (id.startsWith('temp_')) {
        return !!(typeof window !== 'undefined' && window._mealOptimisticPendingTempIds?.[id]);
    }

    if (typeof window !== 'undefined' && window._pendingPhotoUploadByEntryId?.[id]) {
        // 플래그만 남고 사진은 이미 URL만인 경우(수정 반영·리스너 병합 후 경합) → 대기 아님으로 보고 플래그 정리
        if (!mealPhotosHaveBase64(record)) {
            clearPendingFlagsForEntryId(record);
            return false;
        }
        return true;
    }
    return false;
}

/** 서버 저장 실패 후 타임라인에만 로컬로 붙이는 표시용 플래그 */
export function isMealEntrySaveFailed(record) {
    if (!record) return false;
    if (record._localSaveFailed === true) return true;
    if (record.is_sync_error === true) return true;
    if (record.id == null || record.id === '') return false;
    return !!(typeof window !== 'undefined' && window._mealEntrySaveFailedIds?.[String(record.id)]);
}

/** Firestore 삭제 요청 후 응답 전까지 타임라인 행에 삭제 중 UI 표시 */
export function markMealEntryDeletePending(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (!window._mealDeletePendingByEntryId) window._mealDeletePendingByEntryId = {};
    window._mealDeletePendingByEntryId[String(entryId)] = true;
}

export function markMealEntryDeleteComplete(entryId) {
    if (typeof window === 'undefined' || !window._mealDeletePendingByEntryId) return;
    delete window._mealDeletePendingByEntryId[String(entryId)];
}

export function isMealEntryDeleting(record) {
    if (!record?.id || typeof window === 'undefined') return false;
    return !!window._mealDeletePendingByEntryId?.[String(record.id)];
}

/** 등록 대기 또는 삭제 중 — 모달 열기·행 클릭 차단용 */
export function isMealEntryRowBlocked(record) {
    if (!record) return false;
    if (isMealEntryDeleting(record)) return true;
    return isMealEntryPendingSync(record);
}

/**
 * 서버/로컬 mealHistory에는 이미 URL만 있는데 업로드 대기 플래그만 남은 경우 정리
 * (스테이징·모바일에서 분기 미진입·리스너 경합 시 스피너가 멈추지 않는 현상 완화)
 */
export function clearStuckMealPendingFlags() {
    if (typeof window === 'undefined' || !window._pendingPhotoUploadByEntryId) return false;
    const hist = window.mealHistory;
    if (!Array.isArray(hist) || hist.length === 0) return false;
    let changed = false;
    for (const m of hist) {
        if (!m?.id) continue;
        const id = String(m.id);
        if (!window._pendingPhotoUploadByEntryId[id]) continue;
        if (id.startsWith('temp_')) continue;
        if (!mealPhotosHaveBase64(m)) {
            clearPendingFlagsForEntryId(m);
            changed = true;
        }
    }
    return changed;
}
