/**
 * 일간보기 공유용 캡처 카드 (html2canvas)
 * 헤더: mealog: 하루기록 + 날짜
 * 본문: 사진 있음 좌측 1:1 썸네일+아이콘 / 없음 아이콘 카드
 */
import { buildDailyShareHomeFeedBodyHtml } from './timeline.js';
import { scheduleLucideIcons } from '../icons.js';

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
    container.style.width = '420px';
    container.style.maxWidth = '420px';
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
                        <span class="daily-share-capture__brand mealog-title">mealog</span><span class="daily-share-capture__brand-sep">:</span><span class="daily-share-capture__brand-sub">하루기록</span>
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
