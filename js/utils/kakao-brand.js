/**
 * 카카오톡 스타일 — 말풍선·꼬리만 있는 **채워진** 실루엣 (TALK 글자 구멍 없음)
 * Remix Icon `kakao-talk-fill` 첫 서브패스 + 닫힌 경로(z) — MIT
 * https://github.com/Remix-Design/RemixIcon
 */
const KAKAO_FILLED_SPEECH_BUBBLE_PATH =
    'M12 3c5.8 0 10.501 3.664 10.501 8.185c0 4.52-4.701 8.184-10.5 8.184a14 14 0 0 1-1.727-.11l-4.408 2.883c-.501.265-.678.236-.472-.413l.892-3.678c-2.88-1.46-4.785-3.99-4.785-6.866c0-4.52 4.7-8.185 10.5-8.185z';

/**
 * @param {{ className?: string, title?: string }} [opts]
 */
export function kakaoTalkLogoSvgHtml({ className = 'w-[22px] h-[22px]', title } = {}) {
    const titleAttr = title ? ` role="img" aria-label="${title}"` : ' aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="shrink-0 inline-block ${className}" fill="currentColor"${titleAttr} data-kakao-brand-logo="1"><path d="${KAKAO_FILLED_SPEECH_BUBBLE_PATH}"/></svg>`;
}

/** @deprecated 호환용 별칭 */
export const kakaoTalkBubbleSvgHtml = kakaoTalkLogoSvgHtml;
