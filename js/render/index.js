// 렌더링 모듈 - 모든 렌더링 함수들을 re-export
// 구조: render/utils, timeline, entry-chips, photo-edit, post-group-utils, user-profiles, board-notice, gallery, feed, render.js(태그·일간카드 등)
export { escapeHtml, sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly, getPlainTextPreview } from './utils.js';
export {
    renderTimeline,
    renderTimelineDateSections,
    mealDatesFromNewlyLoadedChunk,
    localTodayYmd,
    collectNextPastTimelineDates,
    getOldestPendingPastTimelineDate,
    renderMiniCalendar,
    refreshMiniCalendarDots,
    resetTrackerMiniCalendarRange,
    updateTimelineShareIndicators,
    updateTimelineMealEntryPendingIndicators,
    invalidateTimelineDateSection,
    openTrackerMonthCalendar,
    refreshTrackerMonthCalendarPopupIfOpen
} from './timeline.js';
export { renderEntryChips } from './entry-chips.js';
export {
    editPhoto,
    editDailyJournalPhoto,
    openProfilePhotoEdit,
    zoomInPhotoEdit,
    zoomOutPhotoEdit,
    rotatePhotoEdit,
    addPhotoEditTimestamp,
    resetPhotoEdit,
    savePhotoEdit,
    closePhotoEditModal
} from './photo-edit.js';
export {
    getPostIdFromPhotoGroup,
    processPhotosToGroups,
    preloadAdjacentGalleryImages
} from './post-group-utils.js';
export { fetchUserProfiles, getUserSettings } from './user-profiles.js';
export { renderBoard, renderBoardDetail, renderNoticeDetail, renderBoardPostList, syncBoardFeedComposerVisibility, syncBoardSearchPanelVisibility, syncBoardTracePanelVisibility } from './board-notice.js';
export {
    renderBoardFeedTab,
    scrollFeedPanelToBottom,
    buildPendingFeedMessage,
    applyOptimisticFeedPost,
    removePendingFeedPosts
} from './board-feed.js';
export {
    renderGallery,
    invalidateGalleryRenderSession,
    filterGalleryByUser,
    resetGalleryUserFilterState,
    clearGalleryFilter,
    switchGalleryFilterTab
} from './gallery.js';
export { fetchMissingSharedComments } from './shared-entry-comments.js';
export { applyCollapsedCaptionToElement, computeCollapsedCaptionHtml } from './comment-caption-layout.js';
export { renderFeed, toggleFeedComment } from './feed.js';

// 나머지 함수들은 render.js에서 re-export
export {
    renderPhotoPreviews,
    renderPhotoProcessingPlaceholders,
    clampRecordPhotoHeroIndex,
    toggleComment,
    renderTagManager
} from '../render.js';
export { createDailyShareCard } from './daily-share-card.js';
