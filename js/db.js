// 데이터베이스 모듈 인덱스 파일
// 모든 db 관련 기능을 re-export하여 기존 import 경로 유지

export { dbOps } from './db/ops.js';
export { setupListeners, setupSharedPhotosListener } from './db/listeners.js';
export { postInteractions, getUserReportForPost, submitReport, withdrawReport, getReportsAggregateByGroupKeys } from './db/social.js';
export { boardOperations, noticeOperations, getAdminDisplayName, invalidateAdminDisplayNameCache, deleteBoardPostByAdmin, setBoardPostHidden } from './db/board.js';
export { loadMoreMeals, loadMealsForDateRange, loadStatsForYears, migrateBase64ImagesToStorage } from './db/loading.js';
