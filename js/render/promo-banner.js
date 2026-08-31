/**
 * 밀로그 타임라인 「같이 먹자」 앱 소개 배너 (자사 앱 크로스 프로모션).
 *
 * 기록이 아니라 광고다. 그래서 기록 카드 셸(buildHomeFeedCardShellHtml)을 일부러
 * 쓰지 않는다 — 같은 껍데기를 쓰면 스크롤하는 눈에 기록으로 읽히고, 누르면
 * 앱 바깥으로 나가버려서 오인의 대가가 크다.
 *
 * 이 파일에는 지켜야 할 제약이 둘 있다.
 *
 * 1) **공유 캡처에 들어가면 안 된다.** 하루 공유 이미지는
 *    `buildDailyShareHomeFeedBodyHtml` 이 `dayTimelineUnitsForDate` 로 따로 조립한다.
 *    배너를 「유닛」이나 「슬롯」으로 모델링하는 순간 사용자가 하루 기록을 모먼트에
 *    공유할 때 그 이미지에 광고가 같이 박혀 나간다. 배너는 화면 렌더 조립부에서만
 *    붙이는 순수 표시물이어야 한다.
 *
 * 2) **`a`·`button` 태그를 쓰면 안 된다.** 일간(page)보기는 카드 본문 위에서도 좌우
 *    스와이프로 날짜를 넘기는데, 조작 요소는 스와이프 시작 대상에서 빠진다
 *    (main.js `isInteractiveSwipeTarget`). 가로 전체를 차지하는 배너를 `a` 로 만들면
 *    배너 높이만큼 **날짜 전환이 죽는 띠**가 생긴다. 기록 카드들과 같이 `div` +
 *    `data-` 속성 + 클릭 위임으로 간다.
 */
import { logUsageMetric } from '../usage-metrics.js';

/** Play 스토어 — 안드로이드 전용 앱이라 딥링크·설치 감지 없이 스토어 한 곳으로 보낸다 */
const PROMO_STORE_URL = 'https://play.google.com/store/apps/details?id=app.eat_together.mobile';
const PROMO_ATTR = 'data-mealog-promo';
const PROMO_KEY = 'eat_together';
/** 관리자 대시보드 「페이지별」 표에 같은 이름의 행이 있다 (admin/dashboard.js) */
const PROMO_USAGE_METRIC_KEY = 'promo_eat_together_click';
const PROMO_ART_SRC = 'assets/promo-eat-together.png';

/** 탭과 스와이프를 가르는 이동 거리(px) — 이 이상 끌었으면 클릭이 아니다 */
const PROMO_DRAG_SLOP_PX = 10;

async function openPromoTarget() {
    logUsageMetric(PROMO_USAGE_METRIC_KEY).catch(() => {});
    const Browser = window.Capacitor?.Plugins?.Browser;
    if (Browser?.open) {
        try {
            await Browser.open({ url: PROMO_STORE_URL });
            return;
        } catch (e) {
            console.warn('[promo-banner] Browser.open 실패, window.open 으로 대체:', e);
        }
    }
    window.open(PROMO_STORE_URL, '_blank', 'noopener,noreferrer');
}

let promoDelegationBound = false;
/**
 * 배너 탭 위임.
 *
 * 일간보기에서 배너 위를 스와이프하면 손을 뗀 뒤 click 이 따라올 수 있다. 기록 카드는
 * 그래봐야 모달이 열리고 말지만 배너는 **앱 바깥으로 나간다** — 그래서 여기서만
 * 눌린 지점과 뗀 지점의 거리를 재서, 끌었으면 클릭으로 치지 않는다.
 */
function ensurePromoBannerDelegation() {
    if (promoDelegationBound) return;
    promoDelegationBound = true;
    let downX = 0;
    let downY = 0;
    let downOnBanner = false;
    document.addEventListener(
        'pointerdown',
        (e) => {
            downOnBanner = !!e.target?.closest?.(`[${PROMO_ATTR}]`);
            downX = e.clientX;
            downY = e.clientY;
        },
        true
    );
    document.addEventListener('click', (e) => {
        const el = e.target?.closest?.(`[${PROMO_ATTR}]`);
        if (!el) return;
        if (
            downOnBanner &&
            (Math.abs(e.clientX - downX) > PROMO_DRAG_SLOP_PX ||
                Math.abs(e.clientY - downY) > PROMO_DRAG_SLOP_PX)
        ) {
            return;
        }
        openPromoTarget();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target?.closest?.(`[${PROMO_ATTR}]`);
        if (!el) return;
        e.preventDefault();
        openPromoTarget();
    });
}

/**
 * 배너 HTML — 가로 배열(아트 · 문구 · 설치 배지)이라 카드 한 장 높이를 넘지 않는다.
 * 아트의 배경색은 이미지 자체의 베이지와 맞춰 두었다(CSS `--promo-art-bg`).
 */
export function buildTimelinePromoBannerHtml() {
    ensurePromoBannerDelegation();
    return `<div class="mealog-promo-banner" ${PROMO_ATTR}="${PROMO_KEY}" role="link" tabindex="0" aria-label="같이 먹자 앱 — Play 스토어에서 설치">
        <img class="mealog-promo-banner__art" src="${PROMO_ART_SRC}" alt="" width="52" height="52" loading="lazy" decoding="async">
        <div class="mealog-promo-banner__text">
            <p class="mealog-promo-banner__lead">"점약있어?" 묻지 말고,</p>
            <p class="mealog-promo-banner__title">같이 먹자</p>
        </div>
        <span class="mealog-promo-banner__cta">구경하기<i data-lucide="chevron-right"></i></span>
    </div>`;
}
