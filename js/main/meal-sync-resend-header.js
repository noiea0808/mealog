/**
 * 하단 네비 위 FAB: 전송 오프라인 시 체인(끊김)·오프라인 작성 건수, 온라인 시 미전송 일괄 재전송
 */
import { isDemoUser } from '../demo-account.js';
import {
    countMealCloudFabManualRetryEntries,
    countMealSyncFabScheduledChipEntries,
    countMealSyncFabRedDotTransportSyncEntries
} from '../utils/meal-entry-pending.js';
import { showToast } from '../ui.js';
import { appState } from '../state.js';
import { db } from '../firebase.js';
import { waitForPendingWrites } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { countOfflineDraftMeals, isMealogTransportOffline } from '../utils/mealog-offline-ui.js';
import { syncEntryQuickInputFabVisibility } from '../modals/entry-quick-open.js';

const MEAL_SYNC_FAB_ARIA_IDLE = '동기화가 필요한 기록 재시도';
const MEAL_SYNC_FAB_ARIA_OFFLINE = '오프라인 — 저장 대기 기록 보기';
/**
 * 오프라인 표시 중 탭했을 때 스피너를 유지하는 상한. 복구 루프는 이보다 오래 걸릴 수 있는데,
 * 그때는 버튼을 먼저 돌려주고 루프는 뒤에서 계속 돌게 둔다 — 늦게 성공해도 markHealthy 가
 * FAB 를 갱신하므로 결과는 화면에 반영된다.
 */
const OFFLINE_TAP_RECOVERY_UI_WAIT_MS = 6000;

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

function runChainRelinkAnimation(btn) {
    if (!btn || btn.classList.contains('meal-sync-resend-fab--chain-relink')) return;
    btn.classList.add('meal-sync-resend-fab--chain-relink');
    window.setTimeout(() => {
        try {
            btn.classList.remove('meal-sync-resend-fab--chain-relink');
        } catch (_) {
            /* ignore */
        }
    }, 720);
}

function fabShouldStackAbovePrimary() {
    return appState.currentTab === 'board' || appState.currentTab === 'timeline';
}

function syncInitialRecordsLoadFabStacked() {
    try {
        const initialFab = document.getElementById('initialRecordsLoadFab');
        if (!initialFab || initialFab.classList.contains('hidden')) return;
        initialFab.classList.toggle('initial-records-load-fab--stacked', fabShouldStackAbovePrimary());
    } catch (_) {
        /* ignore */
    }
}

export function refreshMealSyncResendNavButton() {
    const btn = document.getElementById('mealSyncResendBtn');
    const badge = document.getElementById('mealSyncResendBadge');
    if (!btn) return;
    const u = window.currentUser;
    if (!u || u.isAnonymous || isDemoUser(u)) {
        btn.classList.add('hidden');
        btn.classList.remove('meal-sync-resend-fab--stacked', 'meal-sync-resend-fab--transport-offline');
        syncInitialRecordsLoadFabStacked();
        return;
    }

    const transportOff = isMealogTransportOffline();
    const draftN = countOfflineDraftMeals();
    const scheduled = countMealSyncFabScheduledChipEntries();
    const retry = countMealCloudFabManualRetryEntries();
    const redDotSync = countMealSyncFabRedDotTransportSyncEntries();

    /** 온라인에서 Firestore 쓰기·삭제 진행(레드닷) 중에는 FAB 숨김 — 예정 칩 뱃지와 역할 분리 */
    if (!transportOff && redDotSync > 0) {
        btn.classList.add('hidden');
        btn.classList.remove('meal-sync-resend-fab--stacked', 'meal-sync-resend-fab--transport-offline');
        if (badge) badge.classList.add('hidden', 'meal-sync-resend-fab__badge--retry-only');
        syncInitialRecordsLoadFabStacked();
        return;
    }

    if (transportOff) {
        btn.classList.remove('hidden');
        btn.classList.add('meal-sync-resend-fab--transport-offline');
        btn.classList.toggle('meal-sync-resend-fab--stacked', fabShouldStackAbovePrimary());
        btn.setAttribute('aria-label', MEAL_SYNC_FAB_ARIA_OFFLINE);
        btn.setAttribute('title', '오프라인 — 연결되면 자동으로 동기화돼요');
        const offlineBadgeNum =
            scheduled > 0 ? scheduled : retry > 0 ? retry : draftN;
        if (badge) {
            if (offlineBadgeNum > 0) {
                badge.textContent = offlineBadgeNum > 99 ? '99+' : String(offlineBadgeNum);
                badge.classList.remove('hidden');
                if (scheduled === 0 && retry > 0) badge.classList.add('meal-sync-resend-fab__badge--retry-only');
                else badge.classList.remove('meal-sync-resend-fab__badge--retry-only');
            } else {
                badge.classList.add('hidden');
                badge.classList.remove('meal-sync-resend-fab__badge--retry-only');
            }
        }
        syncInitialRecordsLoadFabStacked();
        return;
    }

    btn.classList.remove('meal-sync-resend-fab--transport-offline');
    const showFab = scheduled > 0 || retry > 0;
    const badgeNum = scheduled > 0 ? scheduled : retry;
    if (showFab) {
        btn.classList.remove('hidden');
        btn.classList.toggle('meal-sync-resend-fab--stacked', fabShouldStackAbovePrimary());
        btn.setAttribute('aria-label', MEAL_SYNC_FAB_ARIA_IDLE);
        btn.setAttribute('title', '등록 미확인·실패 또는 삭제 실패 항목을 다시 서버에 반영합니다');
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
    syncInitialRecordsLoadFabStacked();
    syncEntryQuickInputFabVisibility();
}

let mealSyncResendNavBound = false;

export function bindMealSyncResendNavButtonOnce() {
    if (mealSyncResendNavBound) return;
    const btn = document.getElementById('mealSyncResendBtn');
    if (!btn) return;
    mealSyncResendNavBound = true;
    btn.addEventListener('click', () => {
        if (btn.disabled || btn.classList.contains('meal-sync-resend-fab--busy')) return;

        if (btn.classList.contains('meal-sync-resend-fab--transport-offline')) {
            runChainRelinkAnimation(btn);
            // 오프라인 판정이 틀렸을 가능성이야말로 사용자가 이 버튼을 누르는 이유다. 판정을 게이트로
            // 써서 시도 자체를 막으면, 그 값이 고착됐을 때 사용자에게 남는 수단이 하나도 없다.
            // 그래서 여기서도 채널을 실제로 확인하고, 남은 기록이 있으면 드레인을 깨운다.
            setMealSyncFabBusy(btn, true);
            void (async () => {
                let recovered = false;
                try {
                    const { runNetworkRecoveryNow } = await import('../utils/network-loop.js');
                    recovered = await Promise.race([
                        runNetworkRecoveryNow('manual-fab-offline'),
                        new Promise((resolve) =>
                            setTimeout(() => resolve(false), OFFLINE_TAP_RECOVERY_UI_WAIT_MS)
                        )
                    ]);
                } catch (e) {
                    console.warn('mealSyncResendFab 오프라인 복구 시도 실패:', e?.message || e);
                }
                try {
                    const { pokeMealOutboxDrain, hasOutstandingMealWork } = await import(
                        '../utils/meal-outbox-drain.js'
                    );
                    const pending = hasOutstandingMealWork();
                    if (pending) pokeMealOutboxDrain('manual-fab-offline');
                    if (recovered) {
                        if (pending) showToast('연결됐어요. 서버에 반영 중입니다…', 'info');
                    } else if (countOfflineDraftMeals() === 0) {
                        showToast('잠시 오프라인 상태에요.', 'info');
                    }
                } catch (_) {
                    /* ignore */
                } finally {
                    setMealSyncFabBusy(btn, false);
                    refreshMealSyncResendNavButton();
                }
            })();
            return;
        }

        // navigator.onLine 은 Wi-Fi↔LTE 전환 후 false 로 고착되는 경우가 많아 하드 게이트로 쓰지 않는다.
        // 사용자가 명시적으로 재전송을 눌렀으므로 실제 원격 프로브로 연결을 확인하고, 도달 가능하면 진행한다.
        setMealSyncFabBusy(btn, true);
        void (async () => {
            const { retryPendingMealEntriesOnAppReady } = await import('../modals/entry-and-core.js');
            try {
                let reachable = false;
                try {
                    const { probeMealogRemoteReachable } = await import('../utils/network-probe.js');
                    reachable = await probeMealogRemoteReachable(5000);
                } catch (_) {
                    reachable = false;
                }
                if (!reachable) {
                    showToast('오프라인 상태라 지금 등록할 수 없습니다. 네트워크 연결 후 다시 눌러 주세요.', 'info');
                    return;
                }
                // 프로브 성공 — 채널을 실제로 확인해 오프라인 표시를 내린다.
                // 플래그를 직접 쓰지 않는다: 루프를 거치지 않으면 사다리·백오프가 리셋되지 않아
                // 이후 복구 판정이 어긋난다.
                try {
                    const { runNetworkRecoveryNow } = await import('../utils/network-loop.js');
                    await runNetworkRecoveryNow('manual-resend');
                } catch (_) {
                    /* ignore */
                }
                showToast('서버에 반영 중입니다…', 'info');
                try {
                    await waitForPendingWrites(db);
                } catch (e) {
                    console.warn('mealSyncResendFab waitForPendingWrites:', e?.message || e);
                }
                try {
                    const pend = await import('../utils/meal-entry-pending.js');
                    if (typeof pend.reconcileMealSyncUiAfterWriteQueueFlush === 'function') {
                        await pend.reconcileMealSyncUiAfterWriteQueueFlush();
                    }
                    if (typeof pend.reconcileStaleMealSyncDotsAgainstServer === 'function') {
                        await pend.reconcileStaleMealSyncDotsAgainstServer();
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
