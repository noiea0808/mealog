/**
 * 푸시 순환 발송의 덱(deck) 로직 — 순수 함수만.
 *
 * "랜덤이되 한 바퀴 안에서는 안 겹친다"를 카드 덱으로 구현한다.
 * 여기가 조용히 깨지면 실사용자에게 같은 푸시가 연달아 나가므로 index.js 에서 떼어내
 * 단위 테스트로 못박는다. Firestore 도 firebase-admin 도 참조하지 않는다.
 */
const crypto = require('crypto');

function defaultRandomInt(minInclusive, maxExclusive) {
  return crypto.randomInt(minInclusive, maxExclusive);
}

/** Fisher–Yates — modulo 편향 없는 randomInt 로 */
function shuffleIds(ids, randomInt = defaultRandomInt) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 덱에서 한 장 뽑는다. 비면 새 바퀴를 섞는다.
 *
 * - 한 바퀴 안에서는 같은 메시지가 두 번 나오지 않는다.
 * - 바퀴 경계에서 직전 발송과 같은 메시지가 연달아 나오지 않도록 첫 두 장을 스왑한다.
 *   (없으면 40번째와 41번째가 같아져 "이틀 연속 같은 푸시"가 된다 — 가장 티 나는 실패)
 * - 비활성·삭제된 잔재 id 는 뽑는 자리에서 조용히 버린다. 덱을 따로 청소하지 않아도 된다.
 *
 * @param {{remaining:string[], served:string[], cycleNo:number, lastAssignedMessageId:string|null}} deck 제자리에서 갱신된다
 * @param {string[]} activeIds 지금 활성인 메시지 id 전부
 * @returns {string|null} 뽑힌 id, 뽑을 게 없으면 null
 */
function drawFromDeck(deck, activeIds, randomInt = defaultRandomInt) {
    const activeSet = new Set(activeIds);
    // 잔여를 다 버려도 최대 한 번만 새로 섞으면 되므로 2회로 충분하다 (여유분 포함)
    for (let guard = 0; guard < 4; guard++) {
        while (deck.remaining.length > 0) {
            const id = deck.remaining.shift();
            if (!activeSet.has(id)) continue;
            deck.served.push(id);
            deck.lastAssignedMessageId = id;
            return id;
        }
        if (activeIds.length === 0) return null;
        const next = shuffleIds(activeIds, randomInt);
        if (next.length >= 2 && next[0] === deck.lastAssignedMessageId) {
            [next[0], next[1]] = [next[1], next[0]];
        }
        deck.remaining = next;
        deck.served = [];
        deck.cycleNo += 1;
    }
    return null;
}

/**
 * 새로 담은 메시지를 이번 바퀴 잔여 구간에 끼워 넣는다.
 *
 * 풀이 커질수록 잔여 구간이 길어져(300개면 한 바퀴 150일) 방금 쓴 문구가 몇 달 뒤에 나간다.
 * `newMessagePriority` 가 켜져 있으면 앞쪽 `priorityWindow` 회 안에 꽂아 그 지연만 없앤다.
 *
 * @returns {string[]} 새 잔여 덱 (입력은 건드리지 않는다)
 */
function insertIntoDeckRemaining(
    remaining,
    messageId,
    { newMessagePriority = true, priorityWindow = 10, randomInt = defaultRandomInt } = {}
) {
    // 잔여가 없으면 다음 셔플에 자연히 포함된다 — 굳이 넣지 않는다
    if (!Array.isArray(remaining) || remaining.length === 0) return [...(remaining || [])];
    if (remaining.includes(messageId)) return [...remaining];
    const windowSize = newMessagePriority ? Math.min(remaining.length, priorityWindow) : remaining.length;
    const next = [...remaining];
    next.splice(randomInt(0, windowSize + 1), 0, messageId);
    return next;
}

/**
 * 슬롯에서 계산하는 결정론적 문서 ID.
 * 크론이 두 번 돌든 수동 재배정이 겹치든 슬롯당 문서는 하나뿐이다 — 중복 발송을 막는 핵심.
 */
function rotationSlotDocId(rotationId, ymd, time) {
    return `rot_${rotationId}_${String(ymd).replace(/-/g, '')}_${String(time).replace(':', '')}`;
}

module.exports = {
    shuffleIds,
    drawFromDeck,
    insertIntoDeckRemaining,
    rotationSlotDocId
};
