/**
 * Firestore가 마지막으로 서버 응답을 전달한 시각.
 *
 * 네트워크 상태 판정의 유일한 진실이다. onSnapshot 이 fromCache=false 로 발화하거나
 * getDocs 가 서버에서 성공했을 때만 갱신된다 — 즉 「채널이 실제로 살아 있다」는 증거일 때만.
 *
 * 원격 HTTP 프로브 성공은 여기에 반영하지 않는다. gstatic 에 닿는 것과 Firestore WebChannel 이
 * 살아 있는 것은 별개이고, 프로브 성공을 활동으로 기록하면 죽은 채널을 살아 있다고 오판한다.
 */

let lastMealogFirestoreActivityAt = Date.now();

/** @param {number} [at] */
export function markMealogFirestoreActivity(at = Date.now()) {
    lastMealogFirestoreActivityAt = at;
}

export function getMealogFirestoreLastActivityAt() {
    return lastMealogFirestoreActivityAt;
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
