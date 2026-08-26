/**
 * 형태 축 파일럿 게이트 — **임시 코드다. 운영 전환일에 통째로 지운다.**
 * (전환 절차: docs/food-axis-rollout.md)
 *
 * ## 왜 필요한가
 *
 * 운영·staging·test가 같은 Firebase 프로젝트(`mealog-r0`)와 같은 `appId`를 쓰기 때문에
 * 축을 정하는 관리자 태그 문서(`content/defaultTags`)도 **전역에 하나뿐**이다. 그래서
 * "운영은 옛 축, test는 새 축"을 브랜치로 가를 수 없다 — 문서를 새 축으로 저장하는 순간
 * 전 사용자 칩이 바뀌고, 저장하지 않으면 test에서도 새 축을 볼 수 없다.
 *
 * 이 모듈은 그 사이에 계정 단위 스위치를 하나 끼운다. 여기 등록된 uid만:
 *   - '무엇을' 칩이 관리자 문서(옛 축) 대신 코드의 형태 축을 쓰고,
 *   - 분석에서 옛 요리 종류 축 값(한식·양식…)을 무시하고 상세 텍스트로 재분류한다.
 *
 * 등록되지 않은 사용자는 **어느 경로에서도 동작이 달라지지 않는다.** 목록이 비어 있는 것이
 * 기본값이고, 문서 로드에 실패해도 비어 있는 상태로 남는다(운영 쪽으로 안전하게 실패).
 *
 * 저장은 `content/defaultTags.formAxisPilotUids` 배열이고, 관리자 화면 → 태그 →
 * '무엇을' 카드 아래에서 편집한다.
 */

/** @type {string[]} 관리자 문서에서 읽은 파일럿 uid 목록 */
let pilotUids = [];

/**
 * 관리자 태그 문서 로드 시 1회 호출 (js/db/listeners.js loadAndMergeAdminTags).
 * @param {unknown} list
 */
export function setFormAxisPilotUids(list) {
    pilotUids = Array.isArray(list)
        ? list.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
        : [];
}

/** @returns {string[]} */
export function getFormAxisPilotUids() {
    return [...pilotUids];
}

/**
 * 지금 로그인한 사용자가 형태 축 파일럿인가.
 * 로그인 전·비회원·목록 미설정이면 항상 false — 기본은 옛 축이다.
 * @returns {boolean}
 */
export function isFormAxisPilot() {
    if (pilotUids.length === 0) return false;
    const uid = window.currentUser?.uid;
    return Boolean(uid) && pilotUids.includes(uid);
}
