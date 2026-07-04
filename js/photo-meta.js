/**
 * 식사 사진별 촬영 시각 메타 (photos 배열과 동일 인덱스)
 */
import { tryExifDateFromImageFile, tryExifDateFromImageSrc } from './meal-time-utils.js';

/** @returns {{ takenAt: string | null }} */
export function createPhotoMetaEntry(date) {
    if (!date || Number.isNaN(date.getTime())) return { takenAt: null };
    return { takenAt: date.toISOString() };
}

/** @param {{ takenAt?: string | null } | null | undefined} metaEntry */
export function parsePhotoTakenAt(metaEntry) {
    if (!metaEntry?.takenAt) return null;
    const d = new Date(metaEntry.takenAt);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Firestore photoMeta → 편집용 배열 (photos.length와 동일 길이) */
export function normalizePhotoMetaFromRecord(photoMeta, photoCount) {
    const count = Math.max(0, Number(photoCount) || 0);
    const src = Array.isArray(photoMeta) ? photoMeta : [];
    const result = [];
    for (let i = 0; i < count; i++) {
        const entry = src[i];
        const takenAt = entry && typeof entry === 'object' && entry.takenAt ? String(entry.takenAt) : null;
        result.push({ takenAt });
    }
    return result;
}

/** currentPhotoMeta 길이를 photos와 맞춤 */
export function syncPhotoMetaLength(meta, targetLen) {
    const len = Math.max(0, Number(targetLen) || 0);
    const m = Array.isArray(meta) ? meta.map((e) => ({ takenAt: e?.takenAt ?? null })) : [];
    while (m.length < len) m.push({ takenAt: null });
    while (m.length > len) m.pop();
    return m;
}

export async function createPhotoMetaFromFile(file) {
    const d = await tryExifDateFromImageFile(file);
    return createPhotoMetaEntry(d);
}

/** 첫 번째로 찾은 사진 촬영 시각 (photoMeta 우선, 없으면 EXIF) */
export async function resolveFirstPhotoTakenAt({ photoMeta, photos } = {}) {
    if (Array.isArray(photoMeta)) {
        for (const entry of photoMeta) {
            const d = parsePhotoTakenAt(entry);
            if (d) return d;
        }
    }
    if (Array.isArray(photos)) {
        for (const src of photos) {
            const d = await tryExifDateFromImageSrc(src);
            if (d) return d;
        }
    }
    return null;
}
