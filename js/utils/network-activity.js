/**
 * Firestore·원격 프로브 마지막 성공 시각 — Wi-Fi↔LTE 전환 등으로 onLine은 true인데 채널만 죽은 경우 감지.
 *
 * 원격 HTTP 프로브 성공 ≠ Firestore WebChannel 생존.
 * stale/하트비트는 Firestore 활동만 본다.
 */
import { isMealogTransportOffline } from './mealog-offline-ui.js';

let lastMealogFirestoreActivityAt = Date.now();
let lastMealogRemoteProbeAt = 0;
let lastMealogOfflineEvidenceAt = 0;

/** @param {number} [at] */
export function markMealogFirestoreActivity(at = Date.now()) {
    lastMealogFirestoreActivityAt = at;
}

/**
 * 원격 HTTP 프로브 성공 시각만 기록한다.
 * Firestore stale 감지에는 반영하지 않는다 (프로브 성공이 kick을 막는 오염 방지).
 * @param {number} [at]
 */
export function markMealogRemoteProbeSuccess(at = Date.now()) {
    lastMealogRemoteProbeAt = at;
}

export function getMealogFirestoreLastActivityAt() {
    return lastMealogFirestoreActivityAt;
}

export function getMealogRemoteProbeLastAt() {
    return lastMealogRemoteProbeAt;
}

/**
 * 오프라인 증거 시각 기록 — window 'offline' 이벤트, Capacitor 단절 통지, 끊김 계열 fetch/Firestore 실패.
 * navigator.onLine=false 고착(Android WebView) 판별에 사용: 이 시각보다 나중에 원격 프로브가
 * 성공했다면 onLine=false 는 고착으로 보고 무시한다.
 * @param {number} [at]
 */
export function markMealogOfflineEvidence(at = Date.now()) {
    lastMealogOfflineEvidenceAt = at;
}

export function getMealogOfflineEvidenceAt() {
    return lastMealogOfflineEvidenceAt;
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
