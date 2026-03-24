/**
 * Firestore 리스너 정리 (게스트→로그인 전환 등)
 */
import { appState } from '../state.js';

/** main.js 초기화 시 한 번 호출 — window.cleanupFirestoreListeners 등록 */
export function registerMainCleanup() {
    window.cleanupFirestoreListeners = () => {
        try {
            if (appState.settingsUnsubscribe) {
                appState.settingsUnsubscribe();
                appState.settingsUnsubscribe = null;
            }
            if (appState.dataUnsubscribe) {
                appState.dataUnsubscribe();
                appState.dataUnsubscribe = null;
            }
            if (appState.statsUnsubscribe) {
                appState.statsUnsubscribe();
                appState.statsUnsubscribe = null;
            }
            if (appState.sharedPhotosUnsubscribe) {
                appState.sharedPhotosUnsubscribe();
                appState.sharedPhotosUnsubscribe = null;
            }
            if (appState.notificationUnsubscribePost) {
                appState.notificationUnsubscribePost();
                appState.notificationUnsubscribePost = null;
            }
            if (appState.notificationUnsubscribeBoard) {
                appState.notificationUnsubscribeBoard();
                appState.notificationUnsubscribeBoard = null;
            }
        } catch (e) {
            console.warn('cleanupFirestoreListeners 실패(무시):', e);
        }
    };
}
