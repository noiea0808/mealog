/**
 * 공유 사진 그룹 키(postId) 계산, 그룹화·정렬, 갤러리/피드 가로 스크롤 인접 이미지 프리로드
 */
import { normalizeUrl } from '../utils.js';

// photoGroup에서 postId 계산 (갤러리 흔적 필터 및 댓글/좋아요 일관된 키용)
// 모든 사용자가 동일한 postId를 보도록 entryId_userId 등 고정 키 사용 (첫 사진 문서 id 사용 시 사용자마다 달라져 댓글 미노출 문제 발생)
export function getPostIdFromPhotoGroup(photoGroup) {
    const photo = photoGroup[0];
    if (!photo) return null;
    const isDailyShare = photo.type === 'daily';
    const isBestShare = photo.type === 'best';
    const isInsightShare = photo.type === 'insight';
    if (isDailyShare) return `daily_${photo.date || 'no-date'}_${photo.userId || 'unknown'}`;
    if (isBestShare) return `best_${photo.id || 'no-id'}_${photo.userId || 'unknown'}`;
    if (isInsightShare) return `insight_${(photo.dateRangeText || 'no-range').replace(/\s/g, '_')}_${photo.userId || 'unknown'}`;
    if (photo.entryId && photo.userId) return `${photo.entryId}_${photo.userId}`;
    let hash = 0;
    const groupKey = `${photo.entryId || 'no-entry'}_${photo.userId || 'unknown'}`;
    const ts = photo.timestamp || (photo.date ? photo.date + 'T12:00:00' : '') || '';
    const keyForHash = `${groupKey}_${ts}`;
    for (let i = 0; i < keyForHash.length; i++) {
        hash = ((hash << 5) - hash) + keyForHash.charCodeAt(i);
        hash = hash & hash;
    }
    return `post_${Math.abs(hash)}_${photo.userId || 'unknown'}`;
}

/** photos 배열을 그룹화·정렬하여 sortedGroups 반환 (appendGalleryPosts에서 재사용) */
export function processPhotosToGroups(photos) {
    if (!photos || photos.length === 0) return [];
    const seen = new Set();
    const uniquePhotos = photos.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const groupedPhotos = {};
    uniquePhotos.forEach(photo => {
        let groupKey;
        if (photo.type === 'daily') groupKey = `daily_${photo.date || 'no-date'}_${photo.userId}`;
        else if (photo.type === 'best') groupKey = `best_${photo.id || 'no-id'}_${photo.userId}`;
        else if (photo.type === 'insight') groupKey = `insight_${photo.dateRangeText || 'no-range'}_${photo.userId}`;
        else if (photo.entryId) groupKey = `${photo.entryId}_${photo.userId}`;
        else groupKey = `no-entry_${photo.userId}`;
        if (!groupedPhotos[groupKey]) groupedPhotos[groupKey] = [];
        groupedPhotos[groupKey].push(photo);
    });
    const photoSortTieBreaker = (a, b) => {
        const aKey = String(a.id ?? normalizeUrl(a.photoUrl) ?? '');
        const bKey = String(b.id ?? normalizeUrl(b.photoUrl) ?? '');
        return aKey.localeCompare(bKey, 'en');
    };
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        photoGroup.sort((a, b) => {
            const ai = a.photoIndex, bi = b.photoIndex;
            if (typeof ai === 'number' && typeof bi === 'number' && ai !== bi) return ai - bi;
            const ta = new Date(a.timestamp).getTime(), tb = new Date(b.timestamp).getTime();
            const cmp = ta - tb;
            return cmp !== 0 ? cmp : photoSortTieBreaker(a, b);
        });
    });
    const getTimestamp = (photo) => {
        if (!photo.timestamp) return 0;
        if (photo.timestamp instanceof Date) return photo.timestamp.getTime();
        if (typeof photo.timestamp === 'string') return new Date(photo.timestamp).getTime();
        if (photo.timestamp.toDate) return photo.timestamp.toDate().getTime();
        if (photo.timestamp.seconds) return photo.timestamp.seconds * 1000;
        return 0;
    };
    return Object.values(groupedPhotos).sort((a, b) => {
        const cmp = getTimestamp(b[0]) - getTimestamp(a[0]);
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
}

/** 갤러리 가로 스크롤 시 현재 슬라이드 기준 이전 1장 + 다음 2장 캐시에 미리 로드 */
export function preloadAdjacentGalleryImages(scrollContainer) {
    const slides = Array.from(scrollContainer.children);
    if (slides.length <= 1) return;
    const scrollLeft = scrollContainer.scrollLeft;
    const containerWidth = scrollContainer.clientWidth;
    let currentIndex = 0;
    slides.forEach((slide, i) => {
        const center = slide.offsetLeft + slide.offsetWidth / 2;
        if (center >= scrollLeft && center <= scrollLeft + containerWidth) currentIndex = i;
    });
    const imgs = slides.map(s => s.querySelector('img')).filter(Boolean);
    const toPreload = [currentIndex - 1, currentIndex + 1, currentIndex + 2];
    toPreload.forEach(idx => {
        if (idx < 0 || idx >= imgs.length) return;
        const img = imgs[idx];
        const url = img.src || img.getAttribute('data-src');
        if (!url) return;
        const preload = new Image();
        preload.src = url;
    });
}
