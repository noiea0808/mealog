/**
 * 공유 사진 그룹 키(postId) 계산, 그룹화·정렬, 갤러리/피드 가로 스크롤 인접 이미지 프리로드
 */
import { normalizeUrl } from '../utils.js';
import { sharedPhotoTimestampMs, sharedPhotoGroupSortMs } from '../utils/shared-photo-timestamp.js';

/**
 * 모먼트/피드 그룹 키 — 같은 식사·슬롯 다장은 한 게시물로 묶음.
 * entryId는 문자열 정규화('null'·공백 제외). 없으면 date+slotId+userId.
 */
export function getSharedPhotoGroupKey(photo) {
    if (!photo) return 'unknown';
    if (photo.type === 'daily') return `daily_${photo.date || 'no-date'}_${photo.userId || ''}`;
    if (photo.type === 'best') {
        if (photo.periodType && photo.periodText) {
            const pt = String(photo.periodText).replace(/\s/g, '_');
            return `best_${photo.periodType}_${pt}_${photo.userId || ''}`;
        }
        return `best_${photo.id || 'no-id'}_${photo.userId || ''}`;
    }
    if (photo.type === 'insight') {
        return `insight_${String(photo.dateRangeText || 'no-range').replace(/\s/g, '_')}_${photo.userId || ''}`;
    }
    const raw = photo.entryId;
    const eid =
        raw != null && String(raw).trim() !== '' && String(raw).trim() !== 'null'
            ? String(raw).trim()
            : '';
    if (eid) return `${eid}_${photo.userId || ''}`;
    const d = photo.date || 'no-date';
    const s = photo.slotId || 'no-slot';
    return `slot_${d}_${s}_${photo.userId || 'unknown'}`;
}

// photoGroup에서 postId 계산 (갤러리 흔적 필터 및 댓글/좋아요 일관된 키용)
// 모든 사용자가 동일한 postId를 보도록 entryId_userId 등 고정 키 사용 (첫 사진 문서 id 사용 시 사용자마다 달라져 댓글 미노출 문제 발생)
export function getPostIdFromPhotoGroup(photoGroup) {
    const photo = photoGroup[0];
    if (!photo) return null;
    if (photo.postId) return String(photo.postId);
    const parent = photo._v2Parent;
    if (parent?.postId) return String(parent.postId);
    const isDailyShare = photo.type === 'daily';
    const isBestShare = photo.type === 'best';
    const isInsightShare = photo.type === 'insight';
    if (isDailyShare) return `daily_${photo.date || 'no-date'}_${photo.userId || 'unknown'}`;
    if (isBestShare) {
        if (photo.periodType && photo.periodText) {
            const pt = String(photo.periodText).replace(/\s/g, '_');
            return `best_${photo.periodType}_${pt}_${photo.userId || 'unknown'}`;
        }
        return `best_${photo.id || 'no-id'}_${photo.userId || 'unknown'}`;
    }
    if (isInsightShare) return `insight_${(photo.dateRangeText || 'no-range').replace(/\s/g, '_')}_${photo.userId || 'unknown'}`;
    return getSharedPhotoGroupKey(photo);
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
    uniquePhotos.forEach((photo) => {
        const groupKey = getSharedPhotoGroupKey(photo);
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
            const cmp = sharedPhotoTimestampMs(a) - sharedPhotoTimestampMs(b);
            return cmp !== 0 ? cmp : photoSortTieBreaker(a, b);
        });
    });
    return Object.values(groupedPhotos).sort((a, b) => {
        const cmp = sharedPhotoGroupSortMs(b) - sharedPhotoGroupSortMs(a);
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
}

/** 갤러리 가로/세로 스크롤 시 현재 슬라이드 기준 이전 1장 + 다음 2장 캐시에 미리 로드 */
export function preloadAdjacentGalleryImages(scrollContainer) {
    const slides = Array.from(scrollContainer.children);
    if (slides.length <= 1) return;
    const vertical = scrollContainer.getAttribute('data-moment-carousel') === 'vertical';
    let currentIndex = 0;
    if (vertical) {
        const scrollTop = scrollContainer.scrollTop;
        const containerHeight = scrollContainer.clientHeight;
        slides.forEach((slide, i) => {
            const center = slide.offsetTop + slide.offsetHeight / 2;
            if (center >= scrollTop && center <= scrollTop + containerHeight) currentIndex = i;
        });
    } else {
        const scrollLeft = scrollContainer.scrollLeft;
        const containerWidth = scrollContainer.clientWidth;
        slides.forEach((slide, i) => {
            const center = slide.offsetLeft + slide.offsetWidth / 2;
            if (center >= scrollLeft && center <= scrollLeft + containerWidth) currentIndex = i;
        });
    }
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
