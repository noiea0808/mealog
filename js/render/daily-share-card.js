/**
 * 일간보기 공유용 컴팩트 카드 (html2canvas 캡처용 DOM)
 * 하루 기록 공유 캡처는 타임라인「식사보기·간식보기」가 모두「자동(mixed)」일 때와 동일한 표시 규칙을 씁니다.
 */
import {
    SLOTS,
    SLOT_STYLES,
    SATIETY_DATA,
    MEALOG_SHARE_CAPTURE_HEADER_FONT_FAMILY,
    MEALOG_SHARE_CAPTURE_HEADER_DATE_FONT_SIZE,
    MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_SIZE,
    MEALOG_SHARE_CAPTURE_HEADER_TITLE_COLOR,
    MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_WEIGHT,
    getSlotLucideIcon
} from '../constants.js';
import { escapeHtml } from './utils.js';
import { formatMealMenuDisplayLine } from '../utils/meal-display-line.js';
import { mealClockTagLabelFromRecord } from '../meal-time-utils.js';
import { getMealPhotoUrlsForTimeline, sortSnackSlotRecordsChronological } from './timeline.js';

/** 피드 캡처 전용: 식사보기는 항상「자동」과 동일. 간식도 동일 규칙(건별 사진 유무)을 아래 mixed 분기로 고정 */
const SHARE_CAPTURE_MEAL_VIEW = 'mixed';

function shareSlotAccentColor(specificStyle) {
    const t = specificStyle.iconText || '';
    if (t.includes('amber')) return '#d97706';
    if (t.includes('emerald')) return '#3cb889';
    if (t.includes('sky')) return '#0284c7';
    return '#64748b';
}

function shareListLeftBorderStyle(specificStyle) {
    const rgb =
        specificStyle.iconText.includes('amber')
            ? '217, 119, 6'
            : specificStyle.iconText.includes('emerald')
              ? '5, 150, 105'
              : specificStyle.iconText.includes('sky')
                ? '2, 132, 199'
                : '100, 116, 139';
    return `border-left: 4px solid rgba(${rgb}, 0.55);`;
}

function shareBuildTagRowHtml(tags) {
    if (!tags || !tags.length) return '';
    const chips = tags
        .map(
            (t) =>
                `<span style="font-size: 11px; color: #334155; background: #f8fafc; padding: 2px 8px; border-radius: 0; white-space: nowrap; flex-shrink: 0;">#${escapeHtml(t)}</span>`
        )
        .join('');
    return `<div style="display: flex; flex-wrap: nowrap; gap: 4px; overflow: hidden; margin-top: 6px;">${chips}</div>`;
}

function shareCollectMainTags(r) {
    if (!r) return [];
    const tags = [];
    const clockTag = mealClockTagLabelFromRecord(r);
    if (clockTag) tags.push(clockTag);
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    return tags;
}

function shareCollectSnackTags(r) {
    if (!r) return [];
    const tags = [];
    const clockTag = mealClockTagLabelFromRecord(r);
    if (clockTag) tags.push(clockTag);
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.snackType && String(r.snackType).trim() && !tags.includes(r.snackType)) tags.push(r.snackType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    return tags;
}

function shareMainMealListRowHtml(slot, r, specificStyle, borderLightGray) {
    const accent = shareSlotAccentColor(specificStyle);
    const listBorder = shareListLeftBorderStyle(specificStyle);
    const p = String(r.place || '').trim();
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        r.mealType === 'Skip'
            ? 'Skip'
            : (m || '').trim() || (r.category && String(r.category).trim()) || '';
    const tagsHtml = shareBuildTagRowHtml(shareCollectMainTags(r));
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '';
    const ratingBlock = ratingVal
        ? `<span style="float: right; margin-left: 8px; display: inline-flex; align-items: center; gap: 2px; border: 1px solid #fcd34d; background: #fffbeb; padding: 2px 6px; border-radius: 0; font-size: 11px; font-weight: 900; color: #ca8a04;"><span>⭐</span><span>${ratingVal}</span></span>`
        : '';
    return `
        <div style="border: 1px solid #cbd5e1; margin: 4px 8px 7px; border-radius: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255,255,255,0.95); ${listBorder}">
            <div style="display: flex; align-items: stretch; min-height: 48px;">
                <div style="width: 112px; flex-shrink: 0; border-right: 1px solid ${borderLightGray}; background: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 8px 6px; text-align: center;">
                    <span style="font-size: 12px; font-weight: 800; color: ${accent}; line-height: 1.2;">${escapeHtml(slot.label)}</span>
                    <span style="font-size: 11px; font-weight: 700; color: #64748b; line-height: 1.2;">@ ${escapeHtml(p || '—')}</span>
                </div>
                <div style="flex: 1; min-width: 0; padding: 8px 10px 10px;">
                    <div style="overflow: hidden;">
                        ${ratingBlock}
                        <p style="margin: 0; font-size: 13px; font-weight: 700; color: #1e293b; line-height: 1.35; word-break: break-word;">${escapeHtml(menuLine)}</p>
                        ${r.comment ? `<p style="clear: both; margin: 6px 0 0; font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${escapeHtml(String(r.comment).replace(/\n/g, ' '))}"</p>` : ''}
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function shareMainMealListEmptyHtml(slot, specificStyle, borderLightGray) {
    const accent = shareSlotAccentColor(specificStyle);
    const listBorder = shareListLeftBorderStyle(specificStyle);
    return `
        <div style="border: 1px solid #cbd5e1; margin: 4px 8px 7px; border-radius: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255,255,255,0.92); opacity: 0.95; ${listBorder}">
            <div style="display: flex; align-items: stretch; min-height: 48px;">
                <div style="width: 112px; flex-shrink: 0; border-right: 1px solid ${borderLightGray}; background: #f8fafc; display: flex; align-items: center; justify-content: center; padding: 8px 6px; text-align: center;">
                    <span style="font-size: 12px; font-weight: 800; color: ${accent};">${escapeHtml(slot.label)}</span>
                </div>
                <div style="flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px;">
                    <span style="font-size: 20px; font-weight: 700; color: #94a3b8;">+</span>
                    <span style="font-size: 11px; color: #94a3b8; font-weight: 600;">기록하기</span>
                </div>
            </div>
        </div>
    `;
}

function shareSnackListRowHtml(slot, r, specificStyle, ordinal1Based, totalInSlot, borderLightGray) {
    const accent = shareSlotAccentColor(specificStyle);
    const listBorder = shareListLeftBorderStyle(specificStyle);
    const p = String(r.snackPlace || r.place || '').trim();
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        (m || '').trim() ||
        String(r.menuDetail || r.snackType || '').trim() ||
        (r.category && String(r.category).trim()) ||
        '간식';
    const showOrdinal = totalInSlot > 1;
    const slotTitle = showOrdinal ? `${slot.label}${ordinal1Based}` : slot.label;
    const tagsHtml = shareBuildTagRowHtml(shareCollectSnackTags(r));
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '';
    const ratingBlock = ratingVal
        ? `<span style="float: right; margin-left: 8px; display: inline-flex; align-items: center; gap: 2px; border: 1px solid #fcd34d; background: #fffbeb; padding: 2px 6px; border-radius: 0; font-size: 11px; font-weight: 900; color: #ca8a04;"><span>⭐</span><span>${ratingVal}</span></span>`
        : '';
    return `
        <div style="border: 1px solid #cbd5e1; margin: 4px 8px 7px; border-radius: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255,255,255,0.95); ${listBorder}">
            <div style="display: flex; align-items: stretch; min-height: 48px;">
                <div style="width: 112px; flex-shrink: 0; border-right: 1px solid ${borderLightGray}; background: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 8px 6px; text-align: center;">
                    <span style="font-size: 12px; font-weight: 800; color: ${accent}; line-height: 1.2;">${escapeHtml(slotTitle)}</span>
                    <span style="font-size: 11px; font-weight: 700; color: #64748b; line-height: 1.2;">@ ${escapeHtml(p || '—')}</span>
                </div>
                <div style="flex: 1; min-width: 0; padding: 8px 10px 10px;">
                    <div style="overflow: hidden;">
                        ${ratingBlock}
                        <p style="margin: 0; font-size: 13px; font-weight: 700; color: #1e293b; line-height: 1.35; word-break: break-word;">${escapeHtml(menuLine)}</p>
                        ${r.comment ? `<p style="clear: both; margin: 6px 0 0; font-size: 11px; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${escapeHtml(String(r.comment).replace(/\n/g, ' '))}"</p>` : ''}
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function shareSnackListEmptyHtml(slot, specificStyle, borderLightGray) {
    const accent = shareSlotAccentColor(specificStyle);
    const listBorder = shareListLeftBorderStyle(specificStyle);
    return `
        <div style="border: 1px solid #cbd5e1; margin: 4px 8px 7px; border-radius: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255,255,255,0.92); opacity: 0.95; ${listBorder}">
            <div style="display: flex; align-items: stretch; min-height: 48px;">
                <div style="width: 112px; flex-shrink: 0; border-right: 1px solid ${borderLightGray}; background: #f8fafc; display: flex; align-items: center; justify-content: center; padding: 8px 6px; text-align: center;">
                    <span style="font-size: 12px; font-weight: 800; color: ${accent};">${escapeHtml(slot.label)}</span>
                </div>
                <div style="flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px;">
                    <span style="font-size: 20px; font-weight: 700; color: #94a3b8;">+</span>
                    <span style="font-size: 11px; color: #94a3b8; font-weight: 600;">기록하기</span>
                </div>
            </div>
        </div>
    `;
}

/** 본식·간식 공통: 사진 칸이 있는 카드형 (타임라인 카드와 동일 조건에서 사용) */
function shareMealLikeCardHtml(dateStr, slot, r, specificStyle, photoAreaEmptyBg, slotType, ordinal1Based, totalInSlot) {
    const iconTextColor = shareSlotAccentColor(specificStyle);
    const containerStyle =
        'border: 1px solid #cbd5e1; margin: 4px 8px; margin-bottom: 7px; border-radius: 0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); background: rgba(255, 255, 255, 0.9);';

    const showOrdinal = slotType === 'snack' && totalInSlot > 1;
    const headerSlotLabel = showOrdinal ? `${slot.label}${ordinal1Based}` : slot.label;

    let titleLine2 = '';
    let iconHtml = '';
    let iconBoxStyle = '';

    if (slotType === 'main') {
        if (r) {
            if (r.mealType === 'Skip') {
                titleLine2 = 'Skip';
                iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                iconHtml = '<i data-lucide="ban" style="font-size: 24px; color: #94a3b8;"></i>';
            } else {
                const m = formatMealMenuDisplayLine(r);
                titleLine2 = escapeHtml((m || '').trim() || (r.category && String(r.category).trim()) || '');
                const urls = getMealPhotoUrlsForTimeline(r);
                if (urls[0]) {
                    iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
                    const photoUrl = String(urls[0]).replace(/'/g, '%27');
                    iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(urls[0])}"></div>`;
                } else {
                    iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
                    iconHtml = `<i data-lucide="utensils" style="font-size: 24px; color: #94a3b8;"></i>`;
                }
            }
        } else {
            titleLine2 = '';
            iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
            iconHtml =
                '<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 8px;"><span style="font-size: 32px; font-weight: 700; color: #94a3b8; margin-bottom: 4px;">+</span><span style="font-size: 10px; color: #94a3b8; line-height: 1.2;">입력해주세요</span></div>';
        }
    } else {
        // snack card branch only called when r exists
        const m = formatMealMenuDisplayLine(r);
        titleLine2 = escapeHtml(
            (m || '').trim() ||
                String(r.menuDetail || r.snackType || '').trim() ||
                (r.category && String(r.category).trim()) ||
                ''
        );
        const urls = getMealPhotoUrlsForTimeline(r);
        if (urls[0]) {
            iconBoxStyle = 'border-right: 1px solid #e2e8f0;';
            const photoUrl = String(urls[0]).replace(/'/g, '%27');
            iconHtml = `<div style="width: 100%; height: 100%; min-height: 130px; background-image: url('${photoUrl}'); background-size: cover; background-position: center;" data-photo-url="${escapeHtml(urls[0])}"></div>`;
        } else if (r.mealType === 'Skip') {
            iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
            iconHtml = '<i data-lucide="ban" style="font-size: 24px; color: #94a3b8;"></i>';
        } else {
            iconBoxStyle = `background: ${photoAreaEmptyBg}; border-right: 1px solid #e2e8f0;`;
            iconHtml = `<i data-lucide="${getSlotLucideIcon(slot.id)}" style="font-size: 24px; color: #94a3b8;"></i>`;
        }
    }

    const dateObj = r ? new Date(r.date + 'T00:00:00') : new Date(dateStr + 'T00:00:00');
    const formattedDateForCard = dateObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });

    const placeStr =
        slotType === 'main'
            ? r && r.place
                ? escapeHtml(r.place)
                : ''
            : r
              ? escapeHtml(String(r.snackPlace || r.place || '').trim())
              : '';

    return `
        <div style="${containerStyle} min-height: 130px;">
            <div style="display: flex;">
                <div style="width: 130px; min-height: 130px; ${iconBoxStyle} display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; border-radius: 0;">
                    ${iconHtml}
                </div>
                <div style="flex: 1; padding: 10px 12px 12px 12px; display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: 130px;">
                    <div style="font-size: 11px; color: #64748b; margin-bottom: 6px; line-height: 1.4; display: flex; align-items: center; flex-wrap: wrap; gap: 0 4px;">
                        <span style="font-weight: 700; color: ${iconTextColor};">${escapeHtml(headerSlotLabel)}</span>
                        ${placeStr ? `<span style="color: #94a3b8; font-weight: 700;">@ ${placeStr}</span>` : ''}
                        <span style="color: #cbd5e1;">·</span>
                        <span style="color: #94a3b8;">${formattedDateForCard}</span>
                    </div>
                    ${titleLine2 ? `<div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 6px; line-height: 1.3; word-break: break-word;">
                        ${titleLine2}
                    </div>` : ''}
                    ${r && r.comment ? `<div style="font-size: 11px; color: #94a3b8; margin-bottom: 8px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: italic; padding-bottom: 2px;">
                        "${escapeHtml(r.comment)}"
                    </div>` : ''}
                    ${r && r.rating ? `<div style="display: flex; align-items: center; justify-content: flex-start; gap: 4px; margin-top: auto; padding-top: 4px;">
                        <span style="font-size: 10px; color: #ca8a04; font-weight: 900; display: flex; align-items: center; gap: 3px; white-space: nowrap;">
                            <span style="font-size: 11px; line-height: 1;">⭐</span>
                            <span style="font-size: 11px; font-weight: 900; line-height: 1;">${r.rating}</span>
                        </span>
                    </div>` : ''}
                </div>
            </div>
        </div>
    `;
}

export function createDailyShareCard(dateStr, forPreview = false) {
    const dObj = new Date(dateStr + 'T00:00:00');
    const year = dObj.getFullYear();
    const month = dObj.getMonth() + 1;
    const day = dObj.getDate();

    const userProfile = window.userSettings?.profile || {};
    const displayProfile = { nickname: userProfile.nickname || '익명', icon: userProfile.icon ?? null, photoUrl: userProfile.photoUrl || null };
    const userNickname = displayProfile.nickname;
    const existing = document.getElementById('dailyShareCardContainer');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'dailyShareCardContainer';
    if (!forPreview) {
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        container.style.top = '0';
    } else {
        container.style.margin = '0 auto';
    }
    container.style.width = '420px';
    container.style.maxWidth = '420px';
    container.style.backgroundColor = '#ffffff';
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

    const blue = '#1877F2';
    const borderLightGray = '#e2e8f0';
    const borderOuterGray = '#cbd5e1';
    const photoAreaEmptyBg = '#e2e8f0';

    let html = `
        <div style="width: 420px; max-width: 420px; margin: 0 auto; border: 1px solid ${borderOuterGray}; border-radius: 0; overflow: hidden; background: #f1f5f9;">
            <div style="background: #ffffff; padding: 6px 16px 16px; border-bottom: 1px solid ${borderLightGray};">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
                    <span style="font-size: 28.8px; font-weight: 600; color: ${blue}; font-family: 'Fredoka', sans-serif; letter-spacing: -0.5px; text-transform: lowercase;">mealog</span>
                    <span style="font-size: ${MEALOG_SHARE_CAPTURE_HEADER_DATE_FONT_SIZE}; font-weight: normal; color: #64748b; flex-shrink: 0; font-family: ${MEALOG_SHARE_CAPTURE_HEADER_FONT_FAMILY}; line-height: 1.35;">${formattedDate}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span style="font-size: 16px; display: flex; align-items: center;">📅</span>
                    <span style="font-size: ${MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_SIZE}; font-weight: ${MEALOG_SHARE_CAPTURE_HEADER_TITLE_FONT_WEIGHT}; color: ${MEALOG_SHARE_CAPTURE_HEADER_TITLE_COLOR}; font-family: ${MEALOG_SHARE_CAPTURE_HEADER_FONT_FAMILY}; line-height: 1.35;">${escapeHtml(userNickname)}의 하루 기록</span>
                </div>
            </div>
            <div style="padding: 2px 0 12px 0; background: #f1f5f9;">
    `;

    SLOTS.forEach((slot) => {
        const recordsRaw = (window.mealHistory || []).filter((m) => m.date === dateStr && m.slotId === slot.id);
        const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES.default;

        if (slot.type === 'main') {
            const r = recordsRaw[0];
            const mainMealUseListLayout =
                SHARE_CAPTURE_MEAL_VIEW === 'list' ||
                (SHARE_CAPTURE_MEAL_VIEW === 'mixed' && (!r || getMealPhotoUrlsForTimeline(r).length === 0));

            if (mainMealUseListLayout) {
                if (r) html += shareMainMealListRowHtml(slot, r, specificStyle, borderLightGray);
                else html += shareMainMealListEmptyHtml(slot, specificStyle, borderLightGray);
            } else {
                html += shareMealLikeCardHtml(dateStr, slot, r, specificStyle, photoAreaEmptyBg, 'main', 1, 1);
            }
        } else {
            const records = sortSnackSlotRecordsChronological(recordsRaw);
            if (records.length === 0) {
                html += shareSnackListEmptyHtml(slot, specificStyle, borderLightGray);
            } else {
                records.forEach((r, idx) => {
                    const hasPhotos = getMealPhotoUrlsForTimeline(r).length > 0;
                    if (hasPhotos) {
                        html += shareMealLikeCardHtml(dateStr, slot, r, specificStyle, photoAreaEmptyBg, 'snack', idx + 1, records.length);
                    } else {
                        html += shareSnackListRowHtml(slot, r, specificStyle, idx + 1, records.length, borderLightGray);
                    }
                });
            }
        }
    });

    html += `
            </div>
        </div>
    `;

    container.innerHTML = html;
    if (!forPreview) {
        document.body.appendChild(container);
    }

    return container;
}
