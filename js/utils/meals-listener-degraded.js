/**
 * meals primary onSnapshot 실패 시 — 제한적 1회 조회 + 사용자 안내 (전체 컬렉션 구독 금지)
 */
import { showToast } from '../ui.js';

export const MEALS_LISTENER_FALLBACK_LIMIT = 50;

export function isFirestoreIndexError(err) {
    if (!err) return false;
    if (err.code === 'failed-precondition') return true;
    return /index|indexes|requires an index/i.test(String(err.message || ''));
}

export function extractFirestoreIndexLink(err) {
    const msg = String(err?.message || '');
    const m = msg.match(/https:\/\/console\.firebase\.google\.com[^\s)]+/);
    return m ? m[0] : null;
}

function ensureBannerEl() {
    let el = document.getElementById('mealsLoadDegradedBanner');
    if (el) return el;
    const host = document.getElementById('timelineView');
    if (!host) return null;
    el = document.createElement('div');
    el.id = 'mealsLoadDegradedBanner';
    el.className = 'meals-load-degraded-banner hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
        <div class="meals-load-degraded-banner__inner">
            <p id="mealsLoadDegradedMessage" class="meals-load-degraded-banner__text"></p>
            <div class="meals-load-degraded-banner__actions">
                <a id="mealsLoadDegradedIndexLink" class="meals-load-degraded-banner__link hidden" href="#" target="_blank" rel="noopener noreferrer">Firestore 인덱스 만들기</a>
                <button type="button" id="mealsLoadDegradedRetryBtn" class="meals-load-degraded-banner__retry">다시 시도</button>
            </div>
        </div>`;
    host.insertBefore(el, host.firstChild);
    return el;
}

let retryHandler = null;

export function setMealsListenerRetryHandler(fn) {
    retryHandler = typeof fn === 'function' ? fn : null;
}

/**
 * meals 리스너가 강등(1회 조회 폴백) 상태면 실시간 리스너 재부착 시도.
 * 온라인 복구·포그라운드 복귀 시 호출 — 사용자가 '다시 시도'를 누르지 않아도 자동 복구.
 * @returns {boolean} 재부착을 시도했으면 true
 */
export function retryMealsListenerIfDegraded() {
    if (typeof window === 'undefined') return false;
    if (window.__mealogMealsLoadDegraded !== true) return false;
    if (!retryHandler) return false;
    console.log('[meals-listener] 강등 상태 감지 — 실시간 리스너 자동 재부착 시도');
    retryHandler();
    return true;
}

export function clearMealsLoadDegradedUi() {
    window.__mealogMealsLoadDegraded = false;
    window.__mealogMealsLoadDegradedReason = null;
    window.__mealogMealsRealtimeListenerActive = true;
    const el = document.getElementById('mealsLoadDegradedBanner');
    if (el) el.classList.add('hidden');
}

/**
 * @param {'partial'|'index'|'fetch-failed'} kind
 * @param {{ indexLink?: string|null, errorMessage?: string }} [opts]
 */
export function showMealsLoadDegradedUi(kind, opts = {}) {
    const banner = ensureBannerEl();
    const msgEl = document.getElementById('mealsLoadDegradedMessage');
    const linkEl = document.getElementById('mealsLoadDegradedIndexLink');
    const retryBtn = document.getElementById('mealsLoadDegradedRetryBtn');
    if (!banner || !msgEl || !retryBtn) return;

    window.__mealogMealsLoadDegraded = true;
    window.__mealogMealsLoadDegradedReason = kind;
    window.__mealogMealsRealtimeListenerActive = false;

    let message = '';
    let toast = '';
    if (kind === 'index') {
        message =
            '기록을 실시간으로 불러오지 못했어요. Firestore 인덱스 설정이 필요할 수 있습니다. 잠시 후 다시 시도해 주세요.';
        toast = '기록 동기화에 문제가 있어요. 다시 시도하거나 잠시 후 이용해 주세요.';
        if (linkEl) {
            const link = opts.indexLink || null;
            if (link) {
                linkEl.href = link;
                linkEl.classList.remove('hidden');
            } else {
                linkEl.classList.add('hidden');
            }
        }
    } else if (kind === 'partial') {
        message = `최근 기록 일부만 표시 중입니다(최대 ${MEALS_LISTENER_FALLBACK_LIMIT}건). 실시간 동기화가 연결되지 않았어요.`;
        toast = '일부 기록만 표시 중입니다. 다시 시도해 주세요.';
        linkEl?.classList.add('hidden');
    } else {
        message = '기록을 불러오지 못했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.';
        toast = message;
        linkEl?.classList.add('hidden');
    }

    if (opts.errorMessage && kind !== 'partial') {
        console.error('[meals-listener]', opts.errorMessage);
    }

    msgEl.textContent = message;
    banner.classList.remove('hidden');

    retryBtn.onclick = () => {
        if (retryHandler) retryHandler();
    };

    showToast(toast, kind === 'partial' ? 'info' : 'error');
}
