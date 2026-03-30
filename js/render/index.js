// 렌더링 모듈 - 모든 렌더링 함수들을 re-export
// 구조: render/utils, timeline, entry-chips, photo-edit, post-group-utils, user-profiles, board-notice, gallery, feed, render.js(태그·일간카드 등)
export { escapeHtml, sanitizeFormattedText, renderFormattedContent, stripDangerousTagsOnly, getPlainTextPreview } from './utils.js';
export {
    renderTimeline,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    openTrackerMonthCalendar,
    refreshTrackerMonthCalendarPopupIfOpen
} from './timeline.js';
export { renderEntryChips } from './entry-chips.js';
export {
    editPhoto,
    openProfilePhotoEdit,
    zoomInPhotoEdit,
    zoomOutPhotoEdit,
    rotatePhotoEdit,
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
export { renderBoard, renderBoardDetail, renderNoticeDetail, renderBoardPostList, syncBoardFeedComposerVisibility } from './board-notice.js';
export {
    renderBoardFeedTab,
    scrollFeedPanelToBottom,
    buildPendingFeedMessage,
    applyOptimisticFeedPost,
    removePendingFeedPosts
} from './board-feed.js';
export {
    renderGallery,
    filterGalleryByUser,
    clearGalleryFilter,
    switchGalleryFilterTab
} from './gallery.js';
export { fetchMissingSharedComments } from './shared-entry-comments.js';
export { renderFeed, toggleFeedComment } from './feed.js';

// 나머지 함수들은 render.js에서 re-export
export {
    renderPhotoPreviews,
    toggleComment,
    renderTagManager
} from '../render.js';
export { createDailyShareCard } from './daily-share-card.js';
