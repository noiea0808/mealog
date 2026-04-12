// 데이터베이스 모듈 인덱스 파일
// 모든 db 관련 기능을 re-export하여 기존 import 경로 유지

export { dbOps } from './db/ops.js';
export {
    setupListeners,
    getSharedPhotosByUser,
    loadSharedPhotosByUserPage,
    loadSharedPhotosByUserUpToPostCount,
    loadSharedPhotosPage,
    loadSharedPhotosPageReliable,
    loadMyShares,
    peekLatestSharedPhotoTimestampMs
} from './db/listeners.js';
export { postInteractions, subscribeToMyPostComments, getUserReportForPost, submitReport, withdrawReport, getReportsAggregateByGroupKeys } from './db/social.js';
export { boardOperations, noticeOperations, getAdminDisplayName, invalidateAdminDisplayNameCache, deleteBoardPostByAdmin, setBoardPostHidden } from './db/board.js';
export {
    feedOperations,
    FEED_TIMELINE_BATCH_SIZE,
    setFeedPostHiddenByAdmin,
    deleteFeedPostByAdmin,
    attachReactionCountsToPosts
} from './db/feed-posts.js';
export { getFeedNotificationsForUser, subscribeFeedNotifications } from './db/feed-notifications.js';
export {
    isNotificationTargetAvailable,
    isBoardNotificationTargetAvailable,
    isFeedNotificationTargetAvailable,
    isMomentNotificationTargetAvailable
} from './db/notification-targets.js';
export { loadMoreMeals, loadMealsForDateRange, loadStatsForYears, migrateBase64ImagesToStorage } from './db/loading.js';
