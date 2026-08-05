/**
 * 모먼트 피드 자동 재시도.
 *
 * 모먼트 로드는 리스너가 아니라 일회성 페이지네이션 쿼리라, 실패하면 스스로 되살아나지 않는다.
 * 그래서 「연결이 끊겼어요」 화면이 떠 있는 동안 조용히 백오프 재시도한다.
 *
 * 설계 원칙: 이 모듈은 네트워크 상태를 알지 못한다.
 *   재연결을 감지해서 재로드하는 게 아니라, 실패한 읽기를 그냥 다시 시도할 뿐이다.
 *   (연결 판정 boolean 을 게이트로 쓰면 그 값이 틀렸을 때 복구가 통째로 막힌다 — navigator.onLine 이 그랬다.)
 *
 * 탭 진입 재로드는 main/tabs.js 가 이미 한다. 여기서 메우는 것은 그 사이의 두 경우다.
 *   1. 모먼트 탭에 머무는 동안 연결이 돌아온 경우 (탭 전환이 없어 아무 트리거도 없다)
 *   2. 앱이 백그라운드에 있다가 돌아온 경우
 */
import { appState } from '../state.js';

/** 재시도 간격 — 마지막 값에서 고정. 화면에 계속 떠 있어도 부담되지 않는 수준으로 둔다. */
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
/** 재시도 조건을 점검하는 주기 */
const TICK_MS = 5000;

let tickTimer = 0;
let backoffIndex = 0;
let nextAttemptAt = 0;
let retryInFlight = false;

function momentViewActive() {
    try {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
        return appState.currentTab === 'gallery';
    } catch (_) {
        return false;
    }
}

function resetBackoff() {
    backoffIndex = 0;
    nextAttemptAt = 0;
}

async function attemptQuietReload() {
    if (retryInFlight) return;
    if (typeof window.reloadMomentFeed !== 'function') return;
    retryInFlight = true;
    try {
        await window.reloadMomentFeed({ quiet: true });
    } catch (_) {
        /* 실패는 galleryFeedNetworkError 로 남으므로 다음 tick 이 이어받는다 */
    } finally {
        retryInFlight = false;
    }
    if (appState.galleryFeedNetworkError === true) {
        const delay = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
        backoffIndex += 1;
        nextAttemptAt = Date.now() + delay;
    } else {
        resetBackoff();
    }
}

function tick() {
    if (appState.galleryFeedNetworkError !== true) {
        resetBackoff();
        return;
    }
    if (!momentViewActive()) return;
    if (Date.now() < nextAttemptAt) return;
    void attemptQuietReload();
}

/** main.js 초기화 시 1회 */
export function registerMomentFeedAutoRetry() {
    if (tickTimer) return;
    try {
        tickTimer = setInterval(tick, TICK_MS);
    } catch (_) {
        return;
    }
    // 포그라운드 복귀·탭 진입 직후에는 백오프를 기다리지 않고 즉시 한 번 시도한다.
    try {
        document.addEventListener(
            'visibilitychange',
            () => {
                if (document.visibilityState !== 'visible') return;
                resetBackoff();
                tick();
            },
            { passive: true }
        );
    } catch (_) {
        /* ignore */
    }
}
