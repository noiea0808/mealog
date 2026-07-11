/**
 * Firestore·원격 프로브 마지막 성공 시각 — Wi-Fi↔LTE 전환 등으로 onLine은 true인데 채널만 죽은 경우 감지.
 */
import { isMealogTransportOffline } from './mealog-offline-ui.js';

let lastMealogFirestoreActivityAt = Date.now();

/** @param {number} [at] */
export function markMealogFirestoreActivity(at = Date.now()) {
    lastMealogFirestoreActivityAt = at;
}

/** 원격 HTTP 프로브 성공도 Firestore 활동으로 간주 */
export function markMealogRemoteProbeSuccess() {
    markMealogFirestoreActivity();
}

export function getMealogFirestoreActivityAgeMs() {
    return Date.now() - lastMealogFirestoreActivityAt;
}

/**
 * @param {number} [thresholdMs]
 * @returns {boolean}
 */
export function isMealogFirestoreActivityStale(thresholdMs = 45000) {
    return getMealogFirestoreActivityAgeMs() >= thresholdMs;
}

/**
 * 하트비트·능동 프로브가 필요한지: 로컬 오프라인이거나 Firestore 활동이 오래 멈춤.
 * @param {number} [staleThresholdMs]
 * @returns {boolean}
 */
export function shouldProbeMealogNetworkConnectivity(staleThresholdMs = 45000) {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    if (isMealogTransportOffline()) return true;
    return isMealogFirestoreActivityStale(staleThresholdMs);
}
