/**
 * 모먼트/피드 공통: 공유 사진 그룹(인스타 스타일) HTML
 */
import { SLOTS, SLOT_STYLES } from '../constants.js';
import { escapeHtml } from './utils.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { getPostIdFromPhotoGroup } from './post-group-utils.js';

export function renderPostGroupHtml(photoGroup, groupIdx, mealHistoryMap) {
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
    if (photo.slotId) {
        const slot = SLOTS.find(s => s.id === photo.slotId);
        mealLabel = slot ? slot.label : '';
        if (slot) {
            const slotStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            mealLabelStyle = `${slotStyle.text} ${slotStyle.iconBg}`;
        }
    }
    const isBestShare = photo.type === 'best';
    const isDailyShare = photo.type === 'daily';
    const isInsightShare = photo.type === 'insight';
    const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
    let comment = '';
    if (!isDailyShare) {
        if (photo.comment) comment = photo.comment;
        else if (entryId && mealHistoryMap && mealHistoryMap.has(entryId)) {
            const mealRecord = mealHistoryMap.get(entryId);
            if (mealRecord) comment = mealRecord.comment || '';
        }
        if (!entryId && window.mealHistory && photo.date && photo.slotId) {
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
    } else if (isSnack) {
        const menu = photo.menuDetail || photo.snackType;
        if (photo.place && menu) caption = `<span>${escapeHtml(menu)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (menu) caption = `<span>${escapeHtml(menu)}</span>`;
        else caption = escapeHtml('간식');
    } else {
        if (photo.place && photo.menuDetail) caption = `<span>${escapeHtml(photo.menuDetail)}</span> @ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.place) caption = `@ <span>${escapeHtml(photo.place)}</span>`;
        else if (photo.menuDetail) caption = `<span>${escapeHtml(photo.menuDetail)}</span>`;
        else if (photo.mealType) caption = escapeHtml(photo.mealType);
    }
    const captionText = (() => {
        if (isBestShare || isDailyShare || isInsightShare) return (photo.comment || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (isSnack) {
            const m = photo.menuDetail || photo.snackType;
            return (photo.place && m) ? `${m} @ ${photo.place}` : (photo.place || m || '간식');
        }
        return (photo.place && photo.menuDetail) ? `${photo.menuDetail} @ ${photo.place}` : (photo.place || photo.menuDetail || photo.mealType || '');
    })();
    const captionAttr = (captionText || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    let aspectRatio = photo.photoAspectRatio || (entryId && mealHistoryMap && mealHistoryMap.has(entryId) ? mealHistoryMap.get(entryId).photoAspectRatio : null) || '1:1';
    if (aspectRatio !== '1:1' && aspectRatio !== '3:4' && aspectRatio !== '4:3') aspectRatio = '1:1';
    const momentAspectCss = (aspectRatio === '3:4' ? '3/4' : aspectRatio === '4:3' ? '4/3' : '1');
    const photosHtml = photoGroup.map((p, idx) => {
        const isBest = p.type === 'best', isDaily = p.type === 'daily', isInsight = p.type === 'insight';
        return `
            <div class="flex-shrink-0 w-full snap-start ${(isBest || isDaily || isInsight) ? 'bg-white' : ''}" ${(isBest || isDaily || isInsight) ? 'style="display: flex; align-items: flex-start; justify-content: center;"' : ''}>
                ${(isBest || isDaily || isInsight) ? `<img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="w-full h-auto object-contain" style="display: block; width: 100%; height: auto; vertical-align: top;" loading="${idx <= 1 ? 'eager' : 'lazy'}">` : `<div class="w-full relative overflow-hidden" style="aspect-ratio: ${momentAspectCss};"><img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="absolute inset-0 w-full h-full object-cover" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`}
            </div>
        `;
    }).join('');
    const postId = getPostIdFromPhotoGroup(photoGroup);
    const groupKey = postId;
    const alternatePostIds = photoGroup.map(p => p.id).filter(Boolean).join(',');
    const userDisplay = getDisplayProfile(photo.userId, { nickname: photo.userNickname, icon: photo.userIcon, photoUrl: photo.userPhotoUrl });
    const avatarDisplay = getProfileAvatarDisplay(userDisplay);
    const hasBody = (caption && (isBestShare || isDailyShare || isInsightShare)) || (comment && !isBestShare && !isDailyShare && !isInsightShare);
    return `
            <div class="mb-2 bg-white border-b border-slate-200 instagram-post ${!hasBody ? 'post-no-body' : ''}" data-post-id="${postId}" data-post-id-alternates="${alternatePostIds}" data-group-key="${groupKey}">
                <div class="px-3 py-3 flex items-center gap-3 relative">
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
                </div>
                <div class="relative overflow-hidden ${(isDailyShare || isInsightShare) ? 'bg-white' : 'bg-slate-100'}">
                    <div class="flex overflow-x-auto snap-x snap-mandatory scrollbar-hide gallery-photo-scroll" style="scroll-snap-type: x mandatory; scroll-snap-stop: always; -webkit-overflow-scrolling: touch;">
                        ${photosHtml}
                    </div>
                    ${photoCount > 1 ? `
                        <div class="absolute top-3 right-3 bg-black/60 text-white text-xs font-bold px-2.5 py-1 rounded-full backdrop-blur-sm">
                            <span class="photo-counter-current">1</span>/${photoCount}
                        </div>
                    ` : ''}
                </div>
                ${!isBestShare && !isDailyShare && !isInsightShare && caption ? (() => {
                    const firstPhotoUrl = photoGroup[0]?.photoUrl || '';
                    const urlForCss = firstPhotoUrl ? firstPhotoUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\\/g, '\\\\').replace(/'/g, '\\27') : '';
                    return `
                <div class="gallery-caption-wrap">
                    <div class="gallery-caption-blur-bg"${urlForCss ? ` style="background-image: url('${urlForCss}');"` : ''} aria-hidden="true"></div>
                    <div class="gallery-caption-menu-place gallery-caption-blur px-6 py-1.5 text-white">${caption}</div>
                </div>
                `;
                })() : ''}
                <div class="feed-post-actions px-3 py-3">
                    <div class="feed-post-buttons flex items-center justify-between mb-2 pb-2 -mx-3 px-3 border-b border-slate-200">
                        <div class="flex items-center gap-4">
                            <button onclick="window.toggleLike('${postId}')" class="post-like-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-heart text-2xl text-slate-800 post-like-icon social-action-icon-stroke"></i>
                                <span class="post-like-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                            <button onclick="window.toggleCommentInput('${postId}')" class="post-comment-btn flex items-center gap-2 active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                                <i class="fa-regular fa-comment text-2xl text-slate-800 post-comment-icon social-action-icon-stroke"></i>
                                <span class="post-comment-count text-sm font-bold text-slate-800" data-post-id="${postId}"></span>
                            </button>
                        </div>
                        <button onclick="window.toggleBookmark('${postId}')" class="post-bookmark-btn active:scale-95 transition-transform" data-post-id="${postId}" data-requires-login="true">
                            <i class="fa-regular fa-bookmark text-2xl text-slate-800 post-bookmark-icon social-action-icon-stroke"></i>
                        </button>
                    </div>
                    ${caption && (isBestShare || isDailyShare || isInsightShare) ? `<div class="mb-2 text-sm text-slate-800">${caption}</div>` : ''}
                    ${comment && !isBestShare && !isDailyShare && !isInsightShare ? (() => {
                        const lineBreaks = (comment.match(/\n/g) || []).length;
                        const estimatedLines = Math.ceil(comment.length / 30);
                        const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
                        const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
                        return `
                        <div class="mb-2 text-sm text-slate-800">
                            <span id="post-caption-collapsed-${groupIdx}" class="whitespace-pre-line line-clamp-2 inline">${escapeHtml(comment).replace(/\n/g, '<br>')}</span>
                            <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-toggle-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1 ${toggleBtnClass}">더 보기</button>
                            <div id="post-caption-expanded-${groupIdx}" class="whitespace-pre-line hidden">
                                ${escapeHtml(comment).replace(/\n/g, '<br>')}
                                <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-collapse-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1">접기</button>
                            </div>
                        </div>
                    `;
                    })() : (!isBestShare && !isDailyShare && !isInsightShare && entryId && photo.userId && !isMyPost ? `<div class="shared-comment-fetch-placeholder mb-2 text-sm text-slate-800" data-post-id="${postId}" data-entry-id="${entryId}" data-owner-user-id="${photo.userId}" data-group-idx="${groupIdx}"><span class="text-xs text-slate-400">불러오는 중</span></div>` : '')}
                    <div class="comment-section comments-empty ${((caption && (isBestShare || isDailyShare || isInsightShare)) || (comment && !isBestShare && !isDailyShare && !isInsightShare)) ? 'border-t border-slate-200 ' : ''}-mx-3 px-3 pt-1.5 mt-1" id="comment-section-${postId}">
                        <div class="post-comments-list mb-1 rounded-lg py-2 bg-white" data-post-id="${postId}" id="comments-list-${postId}"></div>
                        <button id="view-comments-${postId}" class="hidden text-xs text-slate-500 font-bold mb-1 hover:text-slate-700 active:text-slate-900 transition-colors" onclick="window.viewAllComments('${postId}')">댓글 더보기</button>
                        <div id="comment-input-${postId}" class="hidden mt-1 py-3 -mx-3 px-3">
                            <div class="relative">
                                <input type="text" id="comment-text-${postId}" placeholder="댓글을 입력하세요..." class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100" onkeypress="if(event.key === 'Enter') window.submitComment('${postId}')">
                                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend="event.preventDefault(); window.submitComment('${postId}')" onclick="window.submitComment('${postId}')">게시</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
}
