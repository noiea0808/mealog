/** 밀톡 메시지 글자 수 (입력·수정 공통) */
export const FEED_MESSAGE_MAX_LEN = 280;
export const FEED_CHAR_WARN_AT = 200;
export const FEED_CHAR_AMBER_AT = 260;

/**
 * @param {HTMLElement | null} el — "N자 남음" 표시 요소
 * @param {number} len — 현재 글자 수
 */
export function updateFeedCharRemainingUi(el, len) {
    if (!el) return;
    const safeLen = Math.max(0, Math.min(FEED_MESSAGE_MAX_LEN, Number(len) || 0));
    const remaining = FEED_MESSAGE_MAX_LEN - safeLen;

    if (safeLen < FEED_CHAR_WARN_AT) {
        el.classList.add('hidden');
        el.textContent = '';
        el.setAttribute('aria-hidden', 'true');
        return;
    }

    el.classList.remove('hidden');
    el.setAttribute('aria-hidden', 'false');
    el.textContent = `${remaining}자 남음`;
    el.classList.remove('text-slate-400', 'text-amber-600', 'text-red-500');
    if (safeLen >= FEED_MESSAGE_MAX_LEN) {
        el.classList.add('text-red-500');
    } else if (safeLen >= FEED_CHAR_AMBER_AT) {
        el.classList.add('text-amber-600');
    } else {
        el.classList.add('text-slate-400');
    }
}
