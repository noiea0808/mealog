/**
 * 밀톡·게시판·댓글의 스팸 필터.
 *
 * index.js 안에 있던 것을 떼어냈다. 이유는 하나다 — 이 판정은 사용자가 방금 쓴 글을
 * 통째로 거절하는데, 그게 맞게 도는지 확인할 방법이 없었다. 실제로 아래 두 버그가
 * 그 상태로 배포돼 있었고, 실사용 중에 터졌다(2026-08-30).
 */

/**
 * ── 버그 1: 정규식에 `/g` 를 붙이면 안 된다 ──────────────────────────────────
 *
 * `test()` 는 `/g` 정규식의 `lastIndex` 를 호출할 때마다 갱신한다. 이 목록은 모듈
 * 스코프라 인스턴스가 살아 있는 동안 **모든 요청이 같은 정규식 객체를 공유**한다.
 * 그래서 같은 글이 「차단 → 차단 → 통과」로 순환했다:
 *
 *   실측 2026-08-30, 끝에 `https://www.mealog.net/` 이 붙은 밀톡 답변
 *     1번째: `http` 에서 매치 → 차단 (lastIndex=125)
 *     2번째: 125 부터 검사 → `www.` 에서 매치 → 차단 (lastIndex=133)
 *     3번째: 133 부터 검사 → 남은 건 `mealog.net/` 뿐 → 매치 없음 → **통과** (lastIndex=0)
 *
 * 결과가 둘 다 나쁘다. 멀쩡한 글이 무작위로 막히고, 스패머는 두어 번 다시 누르면
 * 그냥 뚫었다. `lastIndex` 는 요청 사이에도 남으므로 **다른 사용자의 글이 내 판정을
 * 바꿨다** — 사용자에게는 재현되지 않는 버그로 보인다.
 *
 * 그래서 여기서는 `/g` 를 쓰지 않는다. `exec` 로 매치된 말을 그대로 꺼내 쓴다(버그 2).
 */
const BANNED_WORDS = [
  { label: '스팸 의심', re: /(광고|홍보|무료|이벤트|할인|쿠폰|추천인)/i },
  { label: '부적절한 표현', re: /(욕설|비방|혐오)/i }
];

/**
 * ── 버그 2: 링크를 금칙어로 다루면 안 된다 ──────────────────────────────────
 *
 * 예전 목록에는 `링크`·`http`·`www.`·`.com` 이 금칙어로 들어 있었다. 그래서 링크가
 * **한 개만 있어도** 무조건 차단이었고, 정작 그 아래에 있던 「링크 3개 이상」 검사는
 * 도달 자체가 불가능했다. 자기 서비스 주소를 안내하는 정상 답변이 막혔다.
 *
 * 여기서는 링크를 세는 것으로 바꾼다. 우리 도메인은 세지 않는다.
 */
const ALLOWED_LINK_HOSTS = [
  'mealog.net',
  'mealog.app',
  'staging-mealog.vercel.app',
  // 앱 설치 안내에 쓰는 스토어 주소 — 앱 자신이 걸어 두는 링크다
  'play.google.com'
];

/** 이 개수를 **넘으면** 스팸으로 본다 (우리 도메인은 세지 않는다) */
const MAX_EXTERNAL_LINKS = 2;

/**
 * 링크 추출. 스킴이 있거나 `www.` 로 시작하는 것만 링크로 본다.
 *
 * 「점이 들어간 문자열」을 전부 링크로 잡던 패턴(`[a-zA-Z0-9-]+\.[a-zA-Z]{2,}`)은 쓰지
 * 않는다. `3.5kg` 같은 평범한 표기가 링크가 된다.
 *
 * 정규식을 호출마다 새로 만드는 것은 낭비처럼 보이지만 의도적이다 — 모듈 스코프의
 * `/g` 상태 공유가 버그 1 을 만들었고, 그 자리를 다시 만들지 않는다.
 */
function findLinks(text) {
  return text.match(/(?:https?:\/\/|www\.)[^\s]+/gi) || [];
}

/** 링크 문자열에서 호스트만 — 스킴과 `www.` 를 벗기고 경로 앞까지 */
function linkHost(link) {
  const m = /^(?:https?:\/\/)?(?:www\.)?([^/?#\s]+)/i.exec(String(link));
  return m ? m[1].toLowerCase() : '';
}

function isAllowedHost(host) {
  if (!host) return false;
  return ALLOWED_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * 스팸 판정.
 *
 * `reason` 은 사용자에게 그대로 보인다. **무엇이 걸렸는지 반드시 말한다** — 예전에는
 * 「금칙어가 포함되어 있습니다.」만 돌려줘서, 사용자는 자기 글의 어느 말이 문제인지
 * 알 방법이 없었고 고쳐 볼 수도 없었다.
 *
 * @param {string} content
 * @returns {{ isSpam: boolean, reason?: string }}
 */
function checkSpam(content) {
  if (!content || typeof content !== 'string') {
    return { isSpam: false };
  }

  /* 소문자로 낮추지 않는다 — 정규식이 이미 `/i` 다. 원문을 그대로 봐야 걸린 말을 사용자가 쓴 형태로 돌려줄 수 있다. */
  const text = content.trim();

  for (const { label, re } of BANNED_WORDS) {
    const m = re.exec(text);
    if (m) {
      return { isSpam: true, reason: `${label} 단어가 포함되어 있습니다: '${m[0]}'` };
    }
  }

  const external = findLinks(text).filter((link) => !isAllowedHost(linkHost(link)));
  if (external.length > MAX_EXTERNAL_LINKS) {
    return {
      isSpam: true,
      reason: `외부 링크는 ${MAX_EXTERNAL_LINKS}개까지 넣을 수 있습니다. (${external.length}개)`
    };
  }

  return { isSpam: false };
}

module.exports = {
  checkSpam,
  findLinks,
  linkHost,
  isAllowedHost,
  BANNED_WORDS,
  ALLOWED_LINK_HOSTS,
  MAX_EXTERNAL_LINKS
};
