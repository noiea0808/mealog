/**
 * 하단 네비 위 FAB: 서버 미반영 식사 기록 일괄 재전송
 */
import { isDemoUser } from '../demo-account.js';
import {
    countMealCloudFabManualRetryEntries,
    countMealSyncFabScheduledChipEntries
} from '../utils/meal-entry-pending.js';
import { showToast } from '../ui.js';
import { appState } from '../state.js';
import { db } from '../firebase.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

const MEAL_SYNC_FAB_ARIA_IDLE = '동기화가 필요한 기록 재시도';

/** 클릭 직후 즉시 반응(스피너·비활성) — 동적 import 전에 호출 */
function setMealSyncFabBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
        btn.classList.add('meal-sync-resend-fab--busy');
        btn.setAttribute('aria-busy', 'true');
        btn.setAttribute('aria-label', '서버에 반영 중');
        btn.disabled = true;
    } else {
        btn.classList.remove('meal-sync-resend-fab--busy');
        btn.removeAttribute('aria-busy');
        btn.setAttribute('aria-label', MEAL_SYNC_FAB_ARIA_IDLE);
        btn.disabled = false;
    }
}

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
    const scheduled = countMealSyncFabScheduledChipEntries();
    const retry = countMealCloudFabManualRetryEntries();
    const showFab = scheduled > 0 || retry > 0;
    const badgeNum = scheduled > 0 ? scheduled : retry;
    if (showFab) {
        btn.classList.remove('hidden');
        btn.classList.toggle('meal-sync-resend-fab--stacked', appState.currentTab === 'board');
        if (badge) {
            badge.textContent = badgeNum > 99 ? '99+' : String(badgeNum);
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
        if (btn.disabled || btn.classList.contains('meal-sync-resend-fab--busy')) return;
        const offline =
            (typeof navigator !== 'undefined' && navigator.onLine === false) ||
            !!appState.localNetworkForcedOffline;
        if (offline) {
            showToast('오프라인 상태라 지금 등록할 수 없습니다. 네트워크 연결 후 다시 눌러 주세요.', 'info');
            return;
        }
        setMealSyncFabBusy(btn, true);
        showToast('서버에 반영 중입니다…', 'info');
        void (async () => {
            const { retryPendingMealEntriesOnAppReady } = await import('../modals/entry-and-core.js');
            try {
                try {
                    await waitForPendingWrites(db);
                } catch (e) {
                    console.warn('mealSyncResendFab waitForPendingWrites:', e?.message || e);
                }
                try {
                    const pend = await import('../utils/meal-entry-pending.js');
                    if (typeof pend.reconcileMealSyncUiAfterWriteQueueFlush === 'function') {
                        pend.reconcileMealSyncUiAfterWriteQueueFlush();
                    }
                } catch (_) {
                    /* ignore */
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
                setMealSyncFabBusy(btn, false);
                refreshMealSyncResendNavButton();
            }
        })();
    });
}
