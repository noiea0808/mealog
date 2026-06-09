/**
 * sharedPhotos 문서 timestamp — Firestore Timestamp·ISO·{seconds}·date+time 혼재 대응
 */

export function sharedPhotoTimestampMs(photo) {
    const sharedAt = photo?.sharedAt;
    if (sharedAt != null && sharedAt !== '') {
        if (typeof sharedAt?.toDate === 'function') {
            const ms = sharedAt.toDate().getTime();
            if (Number.isFinite(ms)) return ms;
        }
        if (typeof sharedAt === 'string') {
            const ms = new Date(sharedAt).getTime();
            if (Number.isFinite(ms)) return ms;
        }
        if (sharedAt instanceof Date) {
            const ms = sharedAt.getTime();
            if (Number.isFinite(ms)) return ms;
        }
    }
    const t = photo?.timestamp;
    if (t != null && t !== '') {
        if (typeof t?.toDate === 'function') {
            const ms = t.toDate().getTime();
            if (Number.isFinite(ms)) return ms;
        }
        if (typeof t === 'string') {
            const ms = new Date(t).getTime();
            if (Number.isFinite(ms)) return ms;
        }
        if (t instanceof Date) {
            const ms = t.getTime();
            if (Number.isFinite(ms)) return ms;
        }
        if (typeof t === 'object' && typeof t.seconds === 'number') {
            return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6;
        }
        if (typeof t === 'number' && Number.isFinite(t)) {
            return t > 1e12 ? t : t * 1000;
        }
    }
    const d = photo?.date;
    const tm = photo?.time || '12:00:00';
    if (d && typeof d === 'string') {
        const timePart = String(tm).split(':').length === 2 ? `${tm}:00` : tm;
        const ms = new Date(`${d}T${timePart}`).getTime();
        if (Number.isFinite(ms)) return ms;
    }
    return 0;
}

export function sortSharedPhotosByTimestampDesc(photos) {
    return [...(photos || [])].sort((a, b) => sharedPhotoTimestampMs(b) - sharedPhotoTimestampMs(a));
}

/** 모먼트 피드 게시물(사진 그룹) 정렬용 — 그룹 안 가장 최근 sharedPhotos 문서 시각 */
export function sharedPhotoGroupSortMs(photoGroup) {
    if (!Array.isArray(photoGroup) || photoGroup.length === 0) return 0;
    let max = 0;
    for (const p of photoGroup) {
        const ms = sharedPhotoTimestampMs(p);
        if (ms > max) max = ms;
    }
    return max;
}
