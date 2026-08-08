/**
 * 하단 네비 위 FAB — 「아직 서버에 못 올린 기록 N건, 누르면 지금 시도」.
 *
 * 모드가 하나뿐이다. 예전에는 오프라인/온라인 두 모습에 각각 다른 동작과 안내 문구가 달려 있었는데,
 * 그 분기의 기준이던 「지금 오프라인인가」는 앱이 정확히 알 수 없는 값이었고 재연결 후에도 고착돼
 * 사용자를 오프라인 모습에 가둬 놓곤 했다. 무선 상태는 사용자가 알고 싶은 것이 아니다 — 알고 싶은
 * 것은 내 기록이 안전한가이고, 그건 기록별 서버 ack 으로 셀 수 있는 사실이다.
 *
 * 그래서 이 파일은 네트워크 상태를 읽지 않는다. 배지는 미전송 건수이고, 탭하면 채널을 찌르고
 * 아웃박스를 비운다. 다 올라가면 FAB 는 스스로 사라진다.
 */
import { isDemoUser } from '../demo-account.js';
import { countUnsentMealWork } from '../utils/meal-entry-pending.js';
import { showToast } from '../ui.js';
import { appState } from '../state.js';
import { syncEntryQuickInputFabVisibility } from '../modals/entry-quick-open.js';

const MEAL_SYNC_FAB_ARIA = '아직 서버에 올라가지 않은 기록 다시 보내기';

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
        btn.setAttribute('aria-label', MEAL_SYNC_FAB_ARIA);
        btn.disabled = false;
    }
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
    // 배지와 드레인은 반드시 같은 기준을 본다 (countUnsentMealWork 단일 소스)
    const n = !u || u.isAnonymous || isDemoUser(u) ? 0 : countUnsentMealWork();

    btn.classList.remove('meal-sync-resend-fab--transport-offline');
    if (n <= 0) {
        btn.classList.add('hidden');
        btn.classList.remove('meal-sync-resend-fab--stacked');
        if (badge) badge.classList.add('hidden', 'meal-sync-resend-fab__badge--retry-only');
        syncInitialRecordsLoadFabStacked();
        return;
    }

    btn.classList.remove('hidden');
    btn.classList.toggle('meal-sync-resend-fab--stacked', fabShouldStackAbovePrimary());
    btn.setAttribute('aria-label', MEAL_SYNC_FAB_ARIA);
    btn.setAttribute('title', '아직 서버에 올라가지 않은 기록이에요. 누르면 지금 다시 시도합니다.');
    if (badge) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.classList.remove('hidden');
        badge.classList.add('meal-sync-resend-fab__badge--retry-only');
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
        setMealSyncFabBusy(btn, true);
        void (async () => {
            try {
                // 연결을 확인한 뒤 보낼지 말지 정하지 않는다. 확인은 틀릴 수 있고, 틀리면 사용자가
                // 누른 시도가 통째로 막힌다. 채널을 찌르고 아웃박스를 비우는 일을 그냥 한다.
                const [{ runNetworkRecoveryNow }, worker] = await Promise.all([
                    import('../utils/network-loop.js'),
                    import('../utils/outbox-worker.js')
                ]);
                await runNetworkRecoveryNow('manual-resend');
                if (countUnsentMealWork() > 0) showToast('서버에 반영 중입니다…', 'info');
                await worker.pokeOutboxWorker('manual-resend');
                if (countUnsentMealWork() > 0) {
                    showToast('아직 서버에 닿지 못했어요. 연결되면 자동으로 다시 보냅니다.', 'info');
                }
            } catch (e) {
                console.warn('mealSyncResendFab 재전송 실패:', e?.message || e);
            } finally {
                setMealSyncFabBusy(btn, false);
                refreshMealSyncResendNavButton();
            }
        })();
    });
}
