// 렌더링 모듈 - 모든 렌더링 함수들을 re-export
// 새로운 분리된 모듈들을 우선 import
export { escapeHtml } from './utils.js';
export { renderTimeline, renderMiniCalendar, updateTimelineShareIndicators } from './timeline.js';

// 나머지 함수들은 기존 render.js에서 re-export
export {
    renderEntryChips,
    renderPhotoPreviews,
    renderGallery,
    renderFeed,
    toggleComment,
    toggleFeedComment,
    renderTagManager,
    renderBoard,
    renderBoardDetail,
    renderNoticeDetail,
    createDailyShareCard,
    filterGalleryByUser,
    clearGalleryFilter
} from '../render.js';
