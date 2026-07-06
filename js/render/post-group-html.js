/**
 * 모먼트/피드 공통: 공유 사진 그룹(인스타 스타일) HTML
 * @param {{ layoutV2?: boolean, useGalleryPostGap?: boolean }} [options] — `useGalleryPostGap`: 갤러리 화면2만, `#galleryPostsInsertPoint`의 `gap`과 맞추기 위해 카드 `mb`/바깥 배경 제거
 */
import { SLOTS, SLOT_STYLES } from '../constants.js';
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { getDisplayImageUrl, getBlurImageUrl, imgFallbackAttrs } from '../utils/image-variants.js';
import { getPostIdFromPhotoGroup } from './post-group-utils.js';
import { formatMealMenuDisplayLine, mergeMealDisplayFields } from '../utils/meal-display-line.js';
import {
    DAILY_JOURNAL_MOMENT_SLOT_LABEL,
    isDailyJournalSharePhoto
} from '../utils/daily-journal-data.js';
import { DAILY_JOURNAL_SLOT_STYLE } from '../constants.js';
import { isDietReportInsightShare, DIET_REPORT_MOMENT_SLOT_LABEL } from '../utils/diet-report-share.js';
import { buildMomentFeedV2PhotoAndLabelHtml } from './moment-feed-v2.js';

/** 모먼트 공유 → 타임라인 `#timelineMealPhotosOverlay` 휠 모드와 동일한 `row` 페이로드 */
export function buildSharedMomentWheelOverlayRow(photoGroup, mealHistoryMap, ctx) {
    const photo = photoGroup[0];
    const urls = photoGroup.map((p) => p.photoUrl).filter(Boolean);
    const { entryId, isBestShare, isDailyShare, isInsightShare, isSnack, aspectRatio } = ctx;
    const dateStr = photo.date ? String(photo.date) : '';
    const slotId = photo.slotId || '';
    let recordId = null;
    if (entryId && entryId !== '' && entryId !== 'null') recordId = String(entryId);
    else if (photo.id) recordId = String(photo.id);

    const isDailyJournalShare = isDailyJournalSharePhoto(photo, entryId);

    let slotTitle = '—';
    if (isDailyJournalShare) slotTitle = DAILY_JOURNAL_MOMENT_SLOT_LABEL;
    else if (isDailyShare) slotTitle = '일간';
    else if (isBestShare) slotTitle = '베스트';
    else if (isInsightShare) {
        slotTitle = isDietReportInsightShare(photo) ? DIET_REPORT_MOMENT_SLOT_LABEL : (() => {
            const r = String(photo.dateRangeText || '인사이트').replace(/\s+/g, ' ').trim();
            return r.length > 20 ? `${r.slice(0, 20)}…` : r || '인사이트';
        })();
    } else if (photo.slotId) {
        const slot = SLOTS.find((s) => s.id === photo.slotId);
        slotTitle = slot ? slot.label : '—';
    }

    let menuLine = '';
    const place = isDailyJournalShare ? '' : String(photo.place || '').trim();
    if (isDailyJournalShare) {
        menuLine = '';
    } else if (isBestShare || isDailyShare || isInsightShare) {
        menuLine =
            isBestShare || isDailyShare || isDietReportInsightShare(photo)
                ? ''
                : (photo.comment || '').replace(/<[^>]*>/g, '').trim() || '—';
    } else if (isSnack) {
        menuLine = String(photo.menuDetail || photo.snackType || '').trim() || '간식';
    } else {
        const mealForLine =
            entryId && mealHistoryMap && mealHistoryMap.has(entryId)
                ? mergeMealDisplayFields(photo, mealHistoryMap.get(entryId))
                : photo;
        menuLine = (formatMealMenuDisplayLine(mealForLine) || '').trim() || '—';
    }

    const slotMeta = photo.slotId ? SLOTS.find((s) => s.id === photo.slotId) : null;
    const slotType = slotMeta?.type || 'main';
    const ar = aspectRatio === '3:4' || aspectRatio === '4:3' ? aspectRatio : '1:1';

    /** 기록/공유 시 작성자가 넣은 코멘트(소셜 댓글 아님) — renderPostGroupHtml `comment`와 동일 규칙 */
    let authorMealComment = '';
    if (isDailyJournalShare) {
        authorMealComment = (photo.comment || '').replace(/<[^>]*>/g, '').trim();
    } else if (isBestShare || isDailyShare || isInsightShare) {
        authorMealComment = (photo.comment || '').replace(/<[^>]*>/g, '').trim();
    } else {
        if (photo.comment) authorMealComment = String(photo.comment).trim();
        else if (entryId && mealHistoryMap && mealHistoryMap.has(entryId)) {
            const mealRecord = mealHistoryMap.get(entryId);
            if (mealRecord?.comment) authorMealComment = String(mealRecord.comment).trim();
        }
        if (!entryId && window.mealHistory && photo.date && photo.slotId) {
            const matchingRecord = window.mealHistory.find(
                (m) =>
                    m.date === photo.date &&
                    m.slotId === photo.slotId &&
                    (photo.comment ? m.comment === photo.comment : true)
            );
            if (matchingRecord?.comment) authorMealComment = String(matchingRecord.comment).trim();
        }
    }

    const base = {
        dateStr,
        slotId,
        recordId,
        slotTitle,
        urls,
        menuLine,
        place,
        authorMealComment,
        mealType: photo.mealType || null,
        slotType,
        isEmptyRow: false,
        photoAspectRatio: ar
    };
    if (ctx.overlayPostId) {
        base.overlayPostId = ctx.overlayPostId;
        base.overlayAuthor = ctx.overlayAuthor;
        const altIds = photoGroup.map((p) => p.id).filter(Boolean);
        base.overlayPostAlternateIds = [...new Set(altIds)].filter((id) => id !== ctx.overlayPostId);
        const captionPlain = (() => {
            if (isDailyJournalShare) return '';
            if (isBestShare || isDailyShare || isInsightShare) {
                return (photo.comment || '')
                    .replace(/<[^>]*>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .trim();
            }
            if (isSnack) {
                const m = photo.menuDetail || photo.snackType;
                return photo.place && m ? `${m} @ ${photo.place}` : photo.place || m || '간식';
            }
            const mealForLine =
                entryId && mealHistoryMap && mealHistoryMap.has(entryId)
                    ? mergeMealDisplayFields(photo, mealHistoryMap.get(entryId))
                    : photo;
            const ml = formatMealMenuDisplayLine(mealForLine);
            return photo.place && ml ? `${ml} @ ${photo.place}` : photo.place || ml || photo.mealType || '';
        })();
        base.overlayFeedOptions = {
            entryId: entryId && entryId !== '' && entryId !== 'null' ? String(entryId) : '',
            photoUrls: urls.join(','),
            isBestShare,
            isDailyShare,
            isInsightShare,
            photoDate: dateStr,
            photoSlotId: slotId,
            postId: String(ctx.overlayPostId || ''),
            authorUserId: String((ctx.overlayAuthor && ctx.overlayAuthor.userId) || photo.userId || ''),
            dateRangeText: String(photo.dateRangeText || ''),
            captionPlain
        };
    }
    return base;
}

export function renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap, options = {}) {
    const layoutV2 = options.layoutV2 === true;
    /** 갤러리 화면2: `#galleryPostsInsertPoint`의 `gap`만으로 간격 — 카드 mb·바깥 배경 제거 */
    const useGalleryPostGap = layoutV2 && options.useGalleryPostGap === true;
    const photo = photoGroup[0];
    const photoCount = photoGroup.length;
    let entryId = photo.entryId;
    if (!entryId || entryId === '' || entryId === 'null') {
        const photoWithEntryId = photoGroup.find(p => p.entryId && p.entryId !== '' && p.entryId !== 'null');
        if (photoWithEntryId) entryId = photoWithEntryId.entryId;
    }
    const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
    const isGuestPost = isMyPost && window.currentUser && window.currentUser.isAnonymous;
    const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
    const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
    const timeStr = photo.time || new Date(photo.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
    let mealLabel = '', mealLabelStyle = '';
    const isBestShare = photo.type === 'best';
    const isDailyShare = photo.type === 'daily';
    const isInsightShare = photo.type === 'insight';
    const isDailyJournalShare = isDailyJournalSharePhoto(photo, entryId);
    if (isDailyJournalShare) {
        mealLabel = DAILY_JOURNAL_MOMENT_SLOT_LABEL;
        mealLabelStyle = `${DAILY_JOURNAL_SLOT_STYLE.text} ${DAILY_JOURNAL_SLOT_STYLE.iconBg}`;
    } else if (photo.slotId) {
        const slot = SLOTS.find(s => s.id === photo.slotId);
        mealLabel = slot ? slot.label : '';
        if (slot) {
            const slotStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            mealLabelStyle = `${slotStyle.text} ${slotStyle.iconBg}`;
        }
    }
    const isSnack =
        !isDailyJournalShare && photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
    let comment = '';
    if (isDailyJournalShare) {
        if (photo.comment) comment = photo.comment;
    } else if (!isDailyShare) {
        if (photo.comment) comment = photo.comment;
        else if (entryId && mealHistoryMap && mealHistoryMap.has(entryId)) {
            const mealRecord = mealHistoryMap.get(entryId);
            if (mealRecord) comment = mealRecord.comment || '';
        }
        if (!entryId && window.mealHistory && photo.date && photo.slotId && !isDailyJournalShare) {
            const matchingRecord = window.mealHistory.find(m =>
                m.date === photo.date && m.slotId === photo.slotId && (photo.comment ? (m.comment === photo.comment) : true));
            if (matchingRecord) {
                entryId = matchingRecord.id;
                if (!comment && matchingRecord.comment) comment = matchingRecord.comment;
            }
        }
    }
    let caption = '';
    if (isBestShare || isDailyShare || isInsightShare) {
        if (photo.comment) caption = photo.comment;
    } else if (isDailyJournalShare) {
        caption = '';
    } else if (isSnack) {
        const menu = photo.menuDetail || photo.snackType;
        if (photo.place && menu) caption = `<span>${escapeHtml(menu)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (menu) caption = `<span>${escapeHtml(menu)}</span>`;
        else caption = escapeHtml('간식');
    } else {
        const mealForLine = entryId && mealHistoryMap && mealHistoryMap.has(entryId)
            ? mergeMealDisplayFields(photo, mealHistoryMap.get(entryId))
            : photo;
        const menuLine = formatMealMenuDisplayLine(mealForLine);
        if (photo.place && menuLine) caption = `<span>${escapeHtml(menuLine)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (menuLine) caption = `<span>${escapeHtml(menuLine)}</span>`;
        else if (photo.mealType) caption = escapeHtml(photo.mealType);
    }
    const captionText = (() => {
        if (isDailyJournalShare) return '';
        if (isBestShare || isDailyShare || isInsightShare) return (photo.comment || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (isSnack) {
            const m = photo.menuDetail || photo.snackType;
            return (photo.place && m) ? `${m} @ ${photo.place}` : (photo.place || m || '간식');
        }
        const mealForLine = entryId && mealHistoryMap && mealHistoryMap.has(entryId)
            ? mergeMealDisplayFields(photo, mealHistoryMap.get(entryId))
            : photo;
        const menuLine = formatMealMenuDisplayLine(mealForLine);
        return (photo.place && menuLine) ? `${menuLine} @ ${photo.place}` : (photo.place || menuLine || photo.mealType || '');
    })();
    const captionAttr = (captionText || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let aspectRatio = photo.photoAspectRatio || (entryId && mealHistoryMap && mealHistoryMap.has(entryId) ? mealHistoryMap.get(entryId).photoAspectRatio : null) || '1:1';
    if (aspectRatio !== '1:1' && aspectRatio !== '3:4' && aspectRatio !== '4:3') aspectRatio = '1:1';
    const momentAspectCss = (aspectRatio === '3:4' ? '3/4' : aspectRatio === '4:3' ? '4/3' : '1');
    const momentUrlsEncoded = encodeURIComponent(JSON.stringify(photoGroup.map((p) => p.photoUrl).filter(Boolean)));
    const postIdForWheel = getPostIdFromPhotoGroup(photoGroup);
    const postId = postIdForWheel;
    const postIdJs = JSON.stringify(String(postId || ''));
    const userDisplayForWheel = getDisplayProfile(photo.userId, {
        nickname: photo.userNickname,
        icon: photo.userIcon,
        photoUrl: photo.userPhotoUrl
    });
    const avatarDisplayForWheel = getProfileAvatarDisplay(userDisplayForWheel);
    const wheelOverlayRow = layoutV2
        ? buildSharedMomentWheelOverlayRow(photoGroup, mealHistoryMap, {
              entryId,
              isBestShare,
              isDailyShare,
              isInsightShare,
              isSnack,
              aspectRatio,
              overlayPostId: postIdForWheel,
              overlayAuthor: {
                  nickname: userDisplayForWheel.nickname,
                  userId: photo.userId,
                  avatarType: avatarDisplayForWheel.type,
                  avatarValue: avatarDisplayForWheel.value,
                  isGuestPost
              }
          })
        : null;
    const v2PhotoLabelBlock = layoutV2
        ? buildMomentFeedV2PhotoAndLabelHtml({
              photoGroup,
              momentUrlsEncoded,
              photo,
              aspectRatio,
              isBestShare,
              isDailyShare,
              isInsightShare,
              captionTextPlain: captionText,
              overlayRow: wheelOverlayRow,
              postId,
              postIdJs,
              mealHistoryMap,
              groupEntryId: entryId
          })
        : '';
    const photosHtml = layoutV2
        ? ''
        : photoGroup
              .map((p, idx) => {
                  const isBest = p.type === 'best',
                      isDaily = p.type === 'daily',
                      isInsight = p.type === 'insight';
                  const isDietReportShare = isDietReportInsightShare(p);
                  // 공유 캡처 PNG(best/daily/insight/diet)는 원본 유지. 일반 식사 사진만 800px display 우선 + 실패 시 원본 폴백.
                  const originalUrl = String(p.photoUrl || '');
                  const displayRaw = getDisplayImageUrl(p, 0, 'post-group.v1') || originalUrl;
                  const displayFallback = imgFallbackAttrs(originalUrl, displayRaw, escapeHtml, 'post-group.v1');
                  const inner =
                      isBest || isDietReportShare
                          ? `<div class="w-full relative overflow-hidden bg-white moment-feed-photo-slot--capture"><img src="${originalUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-feed-photo relative block w-full h-auto object-contain object-center" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`
                          : (isDaily || isInsight)
                          ? `<div class="w-full relative overflow-hidden bg-slate-100" style="aspect-ratio: ${momentAspectCss};"><img src="${originalUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-feed-photo absolute inset-0 w-full h-full object-contain object-center" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`
                          : `<div class="w-full relative overflow-hidden" style="aspect-ratio: ${momentAspectCss};"><img src="${escapeHtml(displayRaw)}"${displayFallback} alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-feed-photo absolute inset-0 w-full h-full object-cover" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`;
                  return `
            <div class="flex-shrink-0 w-full snap-start relative" data-moment-i="${idx}">
                <div class="moment-feed-pinch-host w-full relative">${inner}</div>
            </div>
        `;
              })
              .join('');
    const groupKey = postId;
    const alternatePostIds = photoGroup.map(p => p.id).filter(Boolean).join(',');
    const userDisplay = userDisplayForWheel;
    const avatarDisplay = avatarDisplayForWheel;
    const hasBody =
        (caption && (isBestShare || isDailyShare || isInsightShare)) ||
        (!layoutV2 && comment && !isBestShare && !isDailyShare && !isInsightShare);
    const showProfileMomentBack =
        appState.galleryFilterUserId &&
        appState.galleryFilterPostId &&
        photo.userId === appState.galleryFilterUserId;
    const profileBackBtn = showProfileMomentBack
        ? `<button type="button" onclick="window.clearGalleryFilterPostId && window.clearGalleryFilterPostId()" class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 -ml-1" aria-label="사진 목록으로">
                        <i class="fa-solid fa-arrow-left text-lg" aria-hidden="true"></i>
                    </button>`
        : '';
    const v2PostCaptionAndFetch =
        layoutV2
            ? [
                  caption && isInsightShare
                      ? `<div class="px-3 pt-2 text-sm text-slate-800">${caption}</div>`
                      : '',
                  !isBestShare && !isDailyShare && !isInsightShare && entryId && photo.userId && !isMyPost
                      ? `<div class="shared-comment-fetch-placeholder hidden h-0 overflow-hidden p-0" aria-hidden="true" data-post-id="${postId}" data-entry-id="${entryId}" data-owner-user-id="${photo.userId}" data-group-idx="${groupIdx}"></div>`
                      : ''
              ]
                  .filter(Boolean)
                  .join('')
            : '';
    const v2AfterMediaBlock =
        useGalleryPostGap && v2PostCaptionAndFetch.trim()
            ? `<div class="moment-v2-gallery-post-aux">${v2PostCaptionAndFetch}</div>`
            : v2PostCaptionAndFetch;
    const cardMb = layoutV2 ? (useGalleryPostGap ? 'mb-0' : 'mb-[3px]') : 'mb-2';
    const cardSkin =
        layoutV2 && !useGalleryPostGap ? 'bg-slate-100 border-b border-slate-200' : !layoutV2 ? 'bg-white border-b border-slate-200' : '';
    const galleryShellCls = useGalleryPostGap ? 'moment-v2-gallery-post-shell' : '';
    const cardClassList = [cardMb, cardSkin, 'instagram-post', galleryShellCls, !hasBody ? 'post-no-body' : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    const v2Meta = photo._v2Parent || (photo.schemaVersion === 2 ? photo : null);
    const seedLikeCount = v2Meta && typeof v2Meta.likeCount === 'number' ? v2Meta.likeCount : null;
    const seedCommentCount = v2Meta && typeof v2Meta.commentCount === 'number' ? v2Meta.commentCount : null;
    const seedCountAttrs =
        seedLikeCount != null || seedCommentCount != null
            ? ` data-seed-like-count="${seedLikeCount != null ? seedLikeCount : ''}" data-seed-comment-count="${seedCommentCount != null ? seedCommentCount : ''}"`
            : '';
    return `
            <div class="${cardClassList}" data-post-id="${postId}" data-post-id-alternates="${alternatePostIds}" data-group-key="${groupKey}"${layoutV2 ? ' data-moment-card-layout="2"' : ''}${seedCountAttrs}>
                ${
                    layoutV2 && showProfileMomentBack
                        ? `<div class="px-2 pt-2">${profileBackBtn}</div>`
                        : ''
                }
                ${
                    !layoutV2
                        ? `<div class="px-3 py-3 flex items-center gap-2 relative">
                    ${profileBackBtn}
                    ${avatarDisplay.type === 'photo' ? `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden border-2 border-slate-300 relative" style="background-image: url(${avatarDisplay.value}); background-size: cover; background-position: center;">
                            ${isGuestPost ? '<span class="absolute bottom-0 right-0 bg-black/70 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center border border-white">게</span>' : ''}
                        </div>
                    ` : `
                        <div class="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 border-2 border-slate-300 ${avatarDisplay.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200 text-lg'}">
                            ${isGuestPost ? '게' : (avatarDisplay.type === 'default' ? '<i class="fa-solid fa-user text-lg"></i>' : escapeHtml(avatarDisplay.value))}
                        </div>
                    `}
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-bold text-slate-800 cursor-pointer hover:text-slate-600 transition-colors" onclick="window.filterGalleryByUser('${photo.userId}', '${escapeHtml(userDisplay.nickname)}')">${userDisplay.nickname}</div>
                        <div class="flex items-center gap-2">
                            <div class="text-xs text-slate-400">${dateStr}</div>
                            ${mealLabel ? `<div class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap">${mealLabel}</div>` : ''}
                        </div>
                    </div>
                    <div class="relative">
                        <button data-entry-id="${entryId || ''}" data-photo-urls="${(photoGroup.map(p => p.photoUrl).filter(Boolean).join(',') || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-caption="${captionAttr}" data-is-best="${isBestShare ? 'true' : 'false'}" data-is-daily="${isDailyShare ? 'true' : 'false'}" data-is-insight="${isInsightShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-date-range-text="${photo.dateRangeText || ''}" data-photo-slot-id="${photo.slotId || ''}" data-post-id="${postId || ''}" data-author-user-id="${photo.userId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                            <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                        </button>
                    </div>
                </div>`
                        : ''
                }
                ${
                    layoutV2
                        ? `<div class="relative w-full moment-v2-media-wrap">${v2PhotoLabelBlock}</div>${v2AfterMediaBlock}`
                        : `<div class="relative overflow-hidden ${(isDailyShare || isInsightShare) ? 'bg-white' : 'bg-slate-100'}">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide gallery-photo-scroll" data-moment-urls="${momentUrlsEncoded}" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute top-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>`
                }
                ${!isBestShare && !isDailyShare && !isInsightShare && caption && !layoutV2 ? (() => {
                    const firstPhotoUrl = getBlurImageUrl(photoGroup[0], 0, 'post-group.caption-blur') || photoGroup[0]?.photoUrl || '';
                    const urlForCss = firstPhotoUrl ? firstPhotoUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\/g, '\\\\').replace(/'/g, '\\27') : '';
                    return `
                <div class="gallery-caption-wrap">
                    <div class="gallery-caption-blur-bg"${urlForCss ? ` style="background-image: url('${urlForCss}');"` : ''} aria-hidden="true"></div>
                    <div class="gallery-caption-menu-place gallery-caption-blur px-6 py-1.5 text-white">${caption}</div>
                </div>
                `;
                })() : ''}
                ${
                    layoutV2
                        ? ''
                        : `<div class="feed-post-actions px-3 py-3">
                    <div class="feed-post-buttons flex items-center justify-between mb-2 pb-2 -mx-3 px-3 border-b border-slate-200">
                        <div class="flex items-center gap-4">
                            <button onclick='window.toggleLike(${postIdJs})' class="post-like-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-heart text-2xl text-slate-800 post-like-icon social-action-icon-stroke"></i>
                                <span class="post-like-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                            <button onclick='window.toggleCommentInput(${postIdJs})' class="post-comment-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-comment text-2xl text-slate-800 post-comment-icon social-action-icon-stroke"></i>
                                <span class="post-comment-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                        </div>
                        <button onclick='window.toggleBookmark(${postIdJs})' class="post-bookmark-btn active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                            <i class="fa-regular fa-bookmark text-2xl text-slate-800 post-bookmark-icon social-action-icon-stroke"></i>
                        </button>
                    </div>
                    ${caption && (isBestShare || isInsightShare) ? `<div class="mb-2 text-sm text-slate-800">${caption}</div>` : ''}
                    ${comment && !isBestShare && !isDailyShare && !isInsightShare ? `
                        <div class="mb-2 text-sm text-slate-800">
                            <div id="post-caption-collapsed-${groupIdx}" class="min-h-[1em]" data-comment-raw="${encodeURIComponent(comment)}" data-caption-variant="moment" data-group-idx="${groupIdx}">
                                <div data-comment-collapsed-mount class="leading-snug"></div>
                            </div>
                            <div id="post-caption-expanded-${groupIdx}" class="hidden whitespace-pre-line break-words leading-snug cursor-pointer" onclick="window.togglePostCaption(${groupIdx})">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                        </div>
                    ` : (!isBestShare && !isDailyShare && !isInsightShare && entryId && photo.userId && !isMyPost ? `<div class="shared-comment-fetch-placeholder mb-2 text-sm text-slate-800" data-post-id="${postId}" data-entry-id="${entryId}" data-owner-user-id="${photo.userId}" data-group-idx="${groupIdx}"><span class="text-xs text-slate-400">불러오는 중</span></div>` : '')}
                    <div class="comment-section comments-empty ${((caption && (isBestShare || isInsightShare)) || (comment && !isBestShare && !isDailyShare && !isInsightShare)) ? 'border-t border-slate-200 ' : ''}-mx-3 px-3 pt-1.5 mt-1" id="comment-section-${postId}">
                        <div class="post-comments-list mb-1 rounded-lg py-2 bg-white" data-post-id="${postId}" id="comments-list-${postId}"></div>
                        <button id="view-comments-${postId}" class="hidden text-xs text-slate-500 font-bold mb-1 hover:text-slate-700 active:text-slate-900 transition-colors" onclick='window.viewAllComments(${postIdJs})'>댓글 더보기</button>
                        <div id="comment-input-${postId}" class="hidden mt-1 py-3 -mx-3 px-3">
                            <div class="relative">
                                <input type="text" id="comment-text-${postId}" placeholder="댓글을 입력하세요..." class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100" onkeypress='if(event.key==="Enter")window.submitComment(${postIdJs})'>
                                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend='event.preventDefault();window.submitComment(${postIdJs})' onclick='window.submitComment(${postIdJs})'>게시</span>
                            </div>
                        </div>
                    </div>
                </div>`
                }
            </div>
        `;
}
