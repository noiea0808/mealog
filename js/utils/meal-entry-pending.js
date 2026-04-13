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

export function markMealEntryServerWorkComplete(recordId, optimisticTempId, optimisticSlotKey) {
    if (typeof window === 'undefined') return;
    clearMealOptimisticSavePending(optimisticTempId);
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
export function markMealEntrySaveFailedById(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (!window._mealEntrySaveFailedIds) window._mealEntrySaveFailedIds = {};
    window._mealEntrySaveFailedIds[String(entryId)] = true;
}

export function clearMealEntrySaveFailedById(entryId) {
    if (typeof window === 'undefined' || entryId == null || entryId === '') return;
    if (window._mealEntrySaveFailedIds) delete window._mealEntrySaveFailedIds[String(entryId)];
}

/** Firestore 스냅샷에서 해당 문서가 반영됨(hasPendingWrites false)일 때 — 실패 느낌표·temp 낙관만 정리 */
export function onMealDocFirestoreServerAcknowledged(docId, optimisticTempId) {
    if (typeof window === 'undefined' || docId == null || docId === '') return;
    clearMealEntrySaveFailedById(String(docId));
    if (optimisticTempId != null && optimisticTempId !== '') {
        clearMealOptimisticSavePending(String(optimisticTempId));
        clearMealEntrySaveFailedById(String(optimisticTempId));
    }
}

export function isMealEntryPendingSync(record) {
    if (!record || record._localSaveFailed) return false;
    if (record.id == null || record.id === '') return false;
    const id = String(record.id);
    if (typeof window !== 'undefined' && window._mealEntrySaveFailedIds?.[id]) return false;

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
