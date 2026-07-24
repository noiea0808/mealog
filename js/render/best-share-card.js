/**
 * 베스트 공유 캡처 — Best 화면 목록형
 * 헤더: mealog: Best + 기간 (하루기록과 동일 패턴)
 * table-cell + 고정 px (html2canvas 정렬 안정화)
 */
import { SLOTS } from '../constants.js';
import { escapeHtml } from './utils.js';
import { formatMealMenuDisplayLine } from '../utils/meal-display-line.js';
import { getThumbImageUrl, getOriginalImageUrl } from '../utils/image-variants.js';

/** 베스트 캡처 썸네일 — 기존 56px 대비 +20% */
const BEST_SHARE_THUMB_SIZE = 67;

function buildBestListItemHtml(meal, index) {
    const slot = SLOTS.find((s) => s.id === meal.slotId);
    const slotLabel = slot ? slot.label : '알 수 없음';
    const isSnack = slot && slot.type === 'snack';
    const menuLine = formatMealMenuDisplayLine(meal);
    const displayTitle =
        (menuLine || '').trim() ||
        (isSnack
            ? String(meal.menuDetail || meal.snackType || '간식').trim()
            : meal.mealType === 'Skip'
              ? 'Skip'
              : String(meal.menuDetail || meal.mealType || '식사').trim());
    const place = String(meal.place || meal.snackPlace || '').trim();
    const slotLine = place ? `${escapeHtml(slotLabel)} · ${escapeHtml(place)}` : escapeHtml(slotLabel);
    const rating = meal.rating ? parseInt(meal.rating, 10) : 0;
    const stars = rating > 0 ? '★'.repeat(Math.min(5, rating)) : '—';
    const rank = index + 1;
    const sz = BEST_SHARE_THUMB_SIZE;

    const originalUrl = getOriginalImageUrl(meal, 0, 'best.share') || '';
    const thumbUrl = getThumbImageUrl(meal, 0, 'best.share') || originalUrl;
    let thumbHtml;
    if (thumbUrl) {
        const src = escapeHtml(thumbUrl);
        const orig = escapeHtml(originalUrl || thumbUrl);
        thumbHtml = `<div class="share-cap-thumb">
            <img class="share-cap-thumb__img" alt="" src="${src}" width="${sz}" height="${sz}" data-photo-url="${orig}" draggable="false" loading="eager">
        </div>`;
    } else {
        thumbHtml = `<div class="share-cap-thumb share-cap-thumb--empty" aria-hidden="true"><i data-lucide="utensils"></i></div>`;
    }

    return `<div class="share-cap-row share-cap-row--best">
        <div class="share-cap-row__inner share-cap-row__inner--best">
            <div class="share-cap-cell share-cap-cell--rank" aria-label="${rank}위">${rank}</div>
            <div class="share-cap-cell share-cap-cell--thumb">${thumbHtml}</div>
            <div class="share-cap-cell share-cap-cell--text">
                <div class="share-cap-meta">${slotLine}</div>
                <div class="share-cap-title">${escapeHtml(displayTitle || slotLabel)}</div>
            </div>
            <div class="share-cap-cell share-cap-cell--stars" aria-label="${rating}점">${stars}</div>
        </div>
    </div>`;
}

/**
 * @param {object[]} top3Meals
 * @param {{ userNickname?: string, periodType?: string, periodText: string }} opts
 */
export function buildBestShareCaptureHtml(top3Meals, opts) {
    const periodText = opts.periodText || '';
    const listHtml =
        Array.isArray(top3Meals) && top3Meals.length
            ? `<div class="share-cap-list">${top3Meals.map((m, i) => buildBestListItemHtml(m, i)).join('')}</div>`
            : `<div class="daily-share-capture__empty"><p>공유할 베스트 메뉴가 없어요.</p></div>`;

    return `
        <div id="bestScreenshotContainer" class="best-share-capture" style="width:420px;max-width:420px;margin:0 auto;font-family:Pretendard,sans-serif;">
            <div class="best-share-capture__sheet">
                <div class="best-share-capture__head">
                    <div class="best-share-capture__brand-row">
                        <span class="best-share-capture__brand-group">
                            <span class="best-share-capture__brand mealog-title">mealog</span>
                            <span class="best-share-capture__brand-sub">Best</span>
                        </span>
                        <span class="best-share-capture__date">${escapeHtml(periodText)}</span>
                    </div>
                </div>
                <div class="best-share-capture__body">
                    ${listHtml}
                </div>
            </div>
        </div>
    `;
}
