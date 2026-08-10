/**
 * 테스트 프로세스를 붙잡는 긴 타이머를 unref 한다.
 *
 * 계측(`js/utils/diagnostics.js`)은 첫 이벤트에서 15초 flush 타이머를, 등록 시 주기 타이머를
 * 건다. 그대로 두면 테스트가 다 끝나고도 프로세스가 그만큼 더 살아 있다.
 *
 * **짧은 타이머는 건드리지 않는다** — 관문(`withDeadline`) 테스트가 쓰는 상한은 전부 1초 미만이고,
 * 그것까지 unref 하면 「상한이 발화하기 전에 프로세스가 끝나 버리는」 위양성이 생긴다.
 */
const LONG_TIMER_MS = 5000;

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...args) {
    const t = realSetTimeout(fn, ms, ...args);
    if (Number(ms) >= LONG_TIMER_MS && t && typeof t.unref === 'function') t.unref();
    return t;
};

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...args) {
    const t = realSetInterval(fn, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
};
