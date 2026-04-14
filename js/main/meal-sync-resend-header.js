/**
 * 하단 네비 위 FAB: 서버 미반영 식사 기록 일괄 재전송
 */
import { isDemoUser } from '../demo-account.js';
import { countMealCloudFabManualRetryEntries } from '../utils/meal-entry-pending.js';
import { showToast } from '../ui.js';
import { appState } from '../state.js';
import { db } from '../firebase.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

export function refreshMealSyncResendNavButton() {
    const btn = document.getElementById('mealSyncResendBtn');
    const badge = document.getElementById('mealSyncResendBadge');
    if (!btn) return;
    const u = window.currentUser;
    if (!u || u.isAnonymous || isDemoUser(u)) {
        btn.classList.add('hidden');
        btn.classList.remove('meal-sync-resend-fab--stacked');
        return;
    }
    const n = countMealCloudFabManualRetryEntries();
    if (n > 0) {
        btn.classList.remove('hidden');
        btn.classList.toggle('meal-sync-resend-fab--stacked', appState.currentTab === 'board');
        if (badge) {
            badge.textContent = n > 99 ? '99+' : String(n);
            badge.classList.remove('hidden');
            badge.classList.add('meal-sync-resend-fab__badge--retry-only');
        }
    } else {
        btn.classList.add('hidden');
        btn.classList.remove('meal-sync-resend-fab--stacked');
        if (badge) badge.classList.add('hidden', 'meal-sync-resend-fab__badge--retry-only');
    }
}

let mealSyncResendNavBound = false;

export function bindMealSyncResendNavButtonOnce() {
    if (mealSyncResendNavBound) return;
    const btn = document.getElementById('mealSyncResendBtn');
    if (!btn) return;
    mealSyncResendNavBound = true;
    btn.addEventListener('click', () => {
        if (btn.disabled) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            showToast('오프라인 상태라 지금 등록할 수 없습니다. 네트워크 연결 후 다시 눌러 주세요.', 'info');
            return;
        }
        void (async () => {
            const { retryPendingMealEntriesOnAppReady } = await import('../modals/entry-and-core.js');
            btn.disabled = true;
            try {
                try {
                    await waitForPendingWrites(db);
                } catch (e) {
                    console.warn('mealSyncResendFab waitForPendingWrites:', e?.message || e);
                }
                const tl = await import('../render/timeline.js');
                try {
                    tl.updateTimelineMealEntryPendingIndicators();
                } catch (_) {
                    /* ignore */
                }
                if (appState.currentTab === 'timeline') {
                    try {
                        tl.renderTimeline();
                    } catch (_) {
                        /* ignore */
                    }
                }
                await retryPendingMealEntriesOnAppReady();
            } finally {
                btn.disabled = false;
                refreshMealSyncResendNavButton();
            }
        })();
    });
}
