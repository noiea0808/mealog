/**
 * 모먼트 검색 필터 유틸 (gallery ↔ moment-search 순환 import 방지)
 */
import { appState } from './state.js';

const TRACE_LABELS = { like: '좋아요', comment: '댓글', bookmark: '북마크' };

export function getPhotoGroupDateYmd(photoGroup) {
    const photo = photoGroup?.[0];
    if (!photo) return null;
    if (photo.date && /^\d{4}-\d{2}-\d{2}$/.test(String(photo.date))) {
        return String(photo.date);
    }
    const ts = photo.timestamp;
    if (!ts) return null;
    try {
        const d = ts.toDate && typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
        if (Number.isNaN(d.getTime())) return null;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    } catch (_) {
        return null;
    }
}

export function photoGroupMatchesKeyword(photoGroup, keyword, mealHistoryMap = null) {
    if (!keyword) return true;
    const q = keyword.toLowerCase();
    const photo = photoGroup?.[0];
    if (!photo) return false;

    const haystacks = [];
    const push = (v) => {
        if (v != null && String(v).trim()) haystacks.push(String(v));
    };

    push(photo.userNickname);
    push(photo.caption);
    push(photo.comment);
    push(photo.menuDetail);
    push(photo.snackType);
    push(photo.snackDetail);
    push(photo.place);
    push(photo.snackPlace);
    push(photo.deliveryVendor);
    push(photo.category);
    push(photo.periodText);
    push(photo.dateRangeText);

    const entryId = photo.entryId;
    if (entryId && mealHistoryMap?.get) {
        const meal = mealHistoryMap.get(entryId);
        if (meal) {
            push(meal.menuDetail);
            push(meal.snackDetail);
            push(meal.snackType);
            push(meal.place);
            push(meal.deliveryVendor);
            push(meal.category);
            push(meal.comment);
            push(meal.withWhomDetail || meal.withWhom);
        }
    }

    return haystacks.some((t) => t.toLowerCase().includes(q));
}

export function formatGallerySearchSummary() {
    const parts = [];
    const range = appState.gallerySearchDateRange;
    if (range?.start && range?.end) {
        parts.push(`${range.start.replace(/-/g, '.')} ~ ${range.end.replace(/-/g, '.')}`);
    }
    if (appState.galleryTraceFilter) {
        parts.push(TRACE_LABELS[appState.galleryTraceFilter] || appState.galleryTraceFilter);
    }
    const kw = (appState.gallerySearchKeyword || '').trim();
    if (kw) parts.push(`「${kw}」`);
    return parts.join(' · ');
}
