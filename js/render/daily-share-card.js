/**
 * 일간보기 공유용 캡처 카드 (html2canvas)
 * 헤더: mealog: 하루기록 + 날짜
 * 본문: 사진 있음 좌측 3:2 썸네일+아이콘 / 없음 아이콘 카드
 */
import { buildDailyShareHomeFeedBodyHtml } from './timeline.js';
import { scheduleLucideIcons } from '../icons.js';

/**
 * 카드(=캡처 출력) 폭. CSS `.daily-share-capture__sheet` 와 캡처의 captureWidth 가 이 값을
 * 따라간다 — 셋이 어긋나면 유령 캡처가 시트를 자르거나 여백을 남긴다.
 * 넓은 썸네일에 밀려 좁아진 제목 칸은 카드를 늘리는 대신 두 줄 줄바꿈으로 흡수한다.
 */
export const DAILY_SHARE_CARD_WIDTH = 420;

export function createDailyShareCard(dateStr, forPreview = false) {
    const dObj = new Date(dateStr + 'T00:00:00');
    const year = dObj.getFullYear();
    const month = dObj.getMonth() + 1;
    const day = dObj.getDate();

    const existing = document.getElementById('dailyShareCardContainer');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'dailyShareCardContainer';
    container.className = 'daily-share-capture';
    if (!forPreview) {
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        container.style.top = '0';
    } else {
        container.style.margin = '0 auto';
    }
    container.style.width = `${DAILY_SHARE_CARD_WIDTH}px`;
    container.style.maxWidth = `${DAILY_SHARE_CARD_WIDTH}px`;
    container.style.padding = '0';
    container.style.fontFamily = 'Pretendard, sans-serif';

    if (document.fonts && document.fonts.check) {
        const fredokaLoaded = document.fonts.check('1em Fredoka');
        if (!fredokaLoaded) {
            const link = document.createElement('link');
            link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@300;400;500;600;700&display=swap';
            link.rel = 'stylesheet';
            document.head.appendChild(link);
        }
    }

    const shortYear = year.toString().slice(-2);
    const formattedDate = `'${shortYear}년 ${month}월${day}일`;
    const bodyHtml = buildDailyShareHomeFeedBodyHtml(dateStr);

    container.innerHTML = `
        <div class="daily-share-capture__sheet">
            <div class="daily-share-capture__head">
                <div class="daily-share-capture__brand-row">
                    <span class="daily-share-capture__brand-group">
                        <span class="daily-share-capture__brand mealog-title">mealog</span>
                        <span class="daily-share-capture__brand-sub">하루기록</span>
                    </span>
                    <span class="daily-share-capture__date">${formattedDate}</span>
                </div>
            </div>
            <div class="daily-share-capture__body">
                ${bodyHtml}
            </div>
        </div>
    `;

    if (!forPreview) {
        document.body.appendChild(container);
    }
    scheduleLucideIcons(container);
    return container;
}