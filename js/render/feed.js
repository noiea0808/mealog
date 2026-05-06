/**
 * 타임라인 옆 피드 탭 (`feedContent`) 렌더링
 */
import { ensureMomentFeedPinchDelegate } from '../main/moment-feed-pinch.js';
import { SLOTS, SLOT_STYLES } from '../constants.js';

ensureMomentFeedPinchDelegate();
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { normalizeUrl, getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { getPostIdFromPhotoGroup, getSharedPhotoGroupKey, preloadAdjacentGalleryImages } from './post-group-utils.js';
import { fetchUserProfiles } from './user-profiles.js';
import { formatMealMenuDisplayLine, mergeMealDisplayFields } from '../utils/meal-display-line.js';
import { applyCollapsedCaptionToElement } from './comment-caption-layout.js';
import { getMomentsFeedView } from '../db.js';
import { buildMomentFeedV2PhotoAndLabelHtml } from './moment-feed-v2.js';
import { buildSharedMomentWheelOverlayRow } from './post-group-html.js';
import { setupMomentFeedV2WheelLayout } from '../main/moment-feed-v2-wheel-layout.js';

export async function renderFeed() {
    const container = document.getElementById('feedContent');
    if (!container) return;
    let layoutV2 = false;
    try {
        layoutV2 = (await getMomentsFeedView()) === '2';
    } catch (_) {
        layoutV2 = false;
    }
    container.classList.toggle('moment-feed-layout-v2', layoutV2);
    container.setAttribute('data-moment-feed-layout', layoutV2 ? '2' : '1');
    const photosToUse = window.sharedPhotosFeed || [];
    
    if (photosToUse.length === 0) {
        if (appState.galleryFeedNetworkError) {
            container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center px-3">
                <i class="fa-regular fa-wifi text-4xl text-slate-200 mb-3" aria-hidden="true"></i>
                <p class="text-xs font-bold text-slate-600">모먼트를 불러오지 못했습니다</p>
                <p class="text-[10px] text-slate-400 mt-1 leading-relaxed">네트워크가 끊겼거나 불안정할 때 이 안내가 나올 수 있습니다.</p>
                <button type="button" class="mt-4 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg inline-flex items-center gap-1.5" id="feedRetryLoadBtn">
                    <i class="fa-solid fa-rotate-right" aria-hidden="true"></i>다시 불러오기
                </button>
            </div>`;
            const retry = container.querySelector('#feedRetryLoadBtn');
            if (retry && typeof window.reloadMomentFeed === 'function') {
                retry.addEventListener('click', () => {
                    window.reloadMomentFeed();
                });
            }
            return;
        }
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-center">
                <i class="fa-solid fa-images text-4xl text-slate-200 mb-3"></i>
                <p class="text-xs font-bold text-slate-400">공유된 사진이 없습니다</p>
                <p class="text-[10px] text-slate-300 mt-1">타임라인에서 사진을 공유해보세요!</p>
            </div>
        `;
        return;
    }
    
    // 사용자 필터링 적용
    const filterUserId = appState.galleryFilterUserId;
    let photosToRender = photosToUse;
    
    if (filterUserId) {
        photosToRender = photosToUse.filter(photo => photo.userId === filterUserId);
    }
    
    // 중복 제거: 같은 photoUrl과 entryId 조합은 하나만 표시
    const seen = new Set();
    const uniquePhotos = photosToRender.filter(photo => {
        const key = `${photo.photoUrl}_${photo.entryId || 'no-entry'}_${photo.userId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    
    // entryId와 userId로 그룹화 (같은 기록의 사진들을 묶음)
    // 중요: 하나의 게시물(entryId)은 앨범에 한 번만 표시되어야 하므로, entryId와 userId만 사용
    // 일간보기 공유(type: 'daily')는 date와 userId로 그룹화
    const groupedPhotos = {};
    uniquePhotos.forEach((photo) => {
        const groupKey = getSharedPhotoGroupKey(photo);
        if (!groupedPhotos[groupKey]) {
            groupedPhotos[groupKey] = [];
        }
        groupedPhotos[groupKey].push(photo);
    });
    
    // 다른 사용자들의 최신 프로필 미리 로드 (프로필 변경 시 다른 사용자도 최신 설정으로 표시)
    const feedUserIds = [...new Set(uniquePhotos.map(p => p.userId).filter(Boolean))];
    await fetchUserProfiles(feedUserIds);
    
    // 각 그룹 내 사진을 Firestore photoIndex 기준으로만 정렬 (글쓴이/다른 사용자 동일 순서 보장)
    const photoSortTieBreakerSimple = (a, b) => {
        const aKey = String(a.id ?? normalizeUrl(a.photoUrl) ?? '');
        const bKey = String(b.id ?? normalizeUrl(b.photoUrl) ?? '');
        return aKey.localeCompare(bKey, 'en');
    };
    Object.keys(groupedPhotos).forEach(groupKey => {
        const photoGroup = groupedPhotos[groupKey];
        photoGroup.sort((a, b) => {
            const ai = a.photoIndex;
            const bi = b.photoIndex;
            if (typeof ai === 'number' && typeof bi === 'number') {
                const cmp = ai - bi;
                if (cmp !== 0) return cmp;
            }
            const cmp = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
            return cmp !== 0 ? cmp : photoSortTieBreakerSimple(a, b);
        });
    });
    
    // 그룹을 시간순으로 정렬 (동점 시 2차 키로 동일 순서 보장)
    const sortedGroups = Object.values(groupedPhotos).sort((a, b) => {
        const timeA = new Date(a[0].timestamp).getTime();
        const timeB = new Date(b[0].timestamp).getTime();
        const cmp = timeB - timeA; // 최신순
        return cmp !== 0 ? cmp : (getPostIdFromPhotoGroup(a) || '').localeCompare(getPostIdFromPhotoGroup(b) || '', 'en');
    });
    
    container.innerHTML = sortedGroups.map((photoGroup, groupIdx) => {
        const photo = photoGroup[0]; // 첫 번째 사진의 정보 사용
        const photoCount = photoGroup.length;
        
        // 그룹 내에서 entryId 찾기 (첫 번째 사진에 없으면 다른 사진에서 찾기)
        let entryId = photo.entryId;
        if (!entryId || entryId === '' || entryId === 'null' || entryId === 'undefined') {
            const photoWithEntryId = photoGroup.find(p => {
                const pEntryId = p.entryId;
                return pEntryId && pEntryId !== '' && pEntryId !== 'null' && pEntryId !== 'undefined';
            });
            if (photoWithEntryId) {
                entryId = photoWithEntryId.entryId;
            }
        }
        
        // 베스트 공유인지 확인 (먼저 확인)
        const isBestShare = photo.type === 'best';
        
        // 일간보기 공유인지 확인
        const isDailyShare = photo.type === 'daily';
        
        // 인사이트 공유인지 확인
        const isInsightShare = photo.type === 'insight';
        
        const postId = getPostIdFromPhotoGroup(photoGroup);
        const alternatePostIds = photoGroup.map(p => p.id).filter(Boolean).join(',');
        
        // 본인 게시물인지 확인
        const isMyPost = window.currentUser && photo.userId === window.currentUser.uid;
        
        // 게스트 모드 확인 (본인 게시물이고 게스트인 경우)
        const isGuestPost = isMyPost && window.currentUser && window.currentUser.isAnonymous;
        
        // 공유 금지 상태 확인 (그룹 내 사진 중 하나라도 금지된 것이 있으면 금지 상태로 표시)
        const isBanned = photoGroup.some(p => p.banned === true);
        
        // 일자 정보
        const photoDate = photo.date ? new Date(photo.date + 'T00:00:00') : new Date(photo.timestamp);
        const dateStr = photoDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
        
        // 끼니 구분 정보 및 색상
        let mealLabel = '';
        let mealLabelStyle = '';
        if (photo.slotId) {
            const slot = SLOTS.find(s => s.id === photo.slotId);
            mealLabel = slot ? slot.label : '';
            if (slot) {
                const slotStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                mealLabelStyle = `${slotStyle.text} ${slotStyle.iconBg}`;
            }
        }
        
        // 간식인지 확인 (slotId로 간식 타입 확인)
        const isSnack = photo.slotId && SLOTS.find(s => s.id === photo.slotId)?.type === 'snack';
        
        // Comment 정보 가져오기
        // 일간보기 공유는 하루 전체 comment를 caption에 표시하므로, 개별 식사 comment는 사용하지 않음
        let comment = '';
        if (!isDailyShare) {
            // 1. photo 객체에 comment가 있으면 우선 사용
            // 2. entryId가 있고 mealHistory에서 찾을 수 있으면 사용
            if (photo.comment) {
                comment = photo.comment;
            } else if (entryId && window.mealHistory) {
                const mealRecord = window.mealHistory.find(m => m.id === entryId);
                if (mealRecord) {
                    comment = mealRecord.comment || '';
                }
            }
            
            // entryId가 없어도 comment가 있거나, 같은 날짜/슬롯의 기록을 찾아서 entryId 찾기
            if (!entryId && window.mealHistory && photo.date && photo.slotId) {
                // photo의 comment나 다른 정보로 mealHistory에서 매칭되는 기록 찾기
                const matchingRecord = window.mealHistory.find(m => 
                    m.date === photo.date && 
                    m.slotId === photo.slotId &&
                    (photo.comment ? (m.comment === photo.comment) : true)
                );
                if (matchingRecord) {
                    entryId = matchingRecord.id;
                    if (!comment && matchingRecord.comment) {
                        comment = matchingRecord.comment;
                    }
                }
            }
        }
        
        let caption = '';
        if (isBestShare) {
            // 베스트 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isDailyShare) {
            // 일간보기 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isInsightShare) {
            // 인사이트 공유인 경우: comment만 표시
            if (photo.comment) {
                caption = photo.comment;
            }
        } else if (isSnack) {
            // 간식인 경우: "메뉴 @ 장소" 형식 (장소만 있으면 "@ 장소")
            const menu = photo.menuDetail || photo.snackType;
            if (photo.place && menu) {
                caption = `${menu} @ ${photo.place}`;
            } else if (photo.place) {
                caption = `@ ${photo.place}`;
            } else if (menu) {
                caption = menu;
            } else {
                caption = '간식';
            }
        } else {
            const mealRecord = entryId && window.mealHistory
                ? window.mealHistory.find(m => m.id === entryId)
                : null;
            const mealForLine = mergeMealDisplayFields(photo, mealRecord);
            const menuLine = formatMealMenuDisplayLine(mealForLine);
            if (photo.place && menuLine) {
                caption = `${menuLine} @ ${photo.place}`;
            } else if (photo.place) {
                caption = `@ ${photo.place}`;
            } else if (menuLine) {
                caption = menuLine;
            } else if (photo.mealType) {
                caption = photo.mealType;
            }
        }
        
        const captionAttr = (caption || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        
        // 사진 비율: shared doc 또는 meal 기록에서 가져오기
        let aspectRatio = photo.photoAspectRatio || (entryId && window.mealHistory ? (window.mealHistory.find(m => m.id === entryId)?.photoAspectRatio) : null) || '1:1';
        if (aspectRatio !== '1:1' && aspectRatio !== '3:4' && aspectRatio !== '4:3') aspectRatio = '1:1';
        const momentAspectCss = (aspectRatio === '3:4' ? '3/4' : aspectRatio === '4:3' ? '4/3' : '1');
        const momentUrlsEncoded = encodeURIComponent(
            JSON.stringify(photoGroup.map((p) => p.photoUrl).filter(Boolean))
        );

        const cardOuter = layoutV2
            ? `mb-[3px] bg-slate-100 border ${isBanned ? 'border-orange-300' : 'border-slate-200'} rounded-2xl overflow-hidden instagram-post`
            : `mb-4 bg-white border ${isBanned ? 'border-orange-300' : 'border-slate-100'} rounded-2xl overflow-hidden instagram-post`;
        const userDisplayForWheel = getDisplayProfile(photo.userId, {
            nickname: photo.userNickname,
            icon: photo.userIcon,
            photoUrl: photo.userPhotoUrl
        });
        const avatarDisplayForWheel = getProfileAvatarDisplay(userDisplayForWheel);
        const mealHistoryMapForWheel =
            window.mealHistory && Array.isArray(window.mealHistory)
                ? new Map(window.mealHistory.map((m) => [m.id, m]))
                : new Map();
        const wheelOverlayRow = layoutV2
            ? buildSharedMomentWheelOverlayRow(photoGroup, mealHistoryMapForWheel, {
                  entryId,
                  isBestShare,
                  isDailyShare,
                  isInsightShare,
                  isSnack,
                  aspectRatio,
                  overlayPostId: postId,
                  overlayAuthor: {
                      nickname: userDisplayForWheel.nickname,
                      userId: photo.userId,
                      avatarType: avatarDisplayForWheel.type,
                      avatarValue: avatarDisplayForWheel.value,
                      isGuestPost
                  }
              })
            : null;
        const postIdJsFeed = JSON.stringify(String(postId || ''));
        const v2PhotoLabelBlock = layoutV2
            ? buildMomentFeedV2PhotoAndLabelHtml({
                  photoGroup,
                  momentUrlsEncoded,
                  photo,
                  aspectRatio,
                  isBestShare,
                  isDailyShare,
                  isInsightShare,
                  captionTextPlain: caption,
                  overlayRow: wheelOverlayRow,
                  postId,
                  postIdJs: postIdJsFeed,
                  mealHistoryMap: mealHistoryMapForWheel,
                  groupEntryId: entryId
              })
            : '';
        const photosHtml = layoutV2
            ? ''
            : photoGroup
                  .map((p, idx) => {
                      const isBest = p.type === 'best';
                      const isDaily = p.type === 'daily';
                      const isInsight = p.type === 'insight';
                      const photoBanned = p.banned === true;
                      const inner =
                          (isBest || isDaily || isInsight)
                              ? `<div class="w-full relative overflow-hidden bg-slate-100" style="aspect-ratio: ${momentAspectCss};"><img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-feed-photo absolute inset-0 w-full h-full object-contain object-center ${photoBanned ? 'opacity-50' : ''}" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`
                              : `<div class="w-full relative overflow-hidden" style="aspect-ratio: ${momentAspectCss};"><img src="${p.photoUrl}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-feed-photo absolute inset-0 w-full h-full object-cover ${photoBanned ? 'opacity-50' : ''}" loading="${idx <= 1 ? 'eager' : 'lazy'}"></div>`;
                      const bannedOverlay =
                          photoBanned && !(isBest || isDaily || isInsight)
                              ? `
                    <div class="absolute inset-0 bg-orange-500/20 flex items-center justify-center pointer-events-none">
                        <div class="bg-orange-600 text-white px-3 py-1.5 rounded-lg">
                            <i class="fa-solid fa-ban mr-1"></i>공유 금지
                        </div>
                    </div>
                `
                              : '';
                      return `
            <div class="flex-shrink-0 w-full snap-start relative" data-moment-i="${idx}">
                <div class="moment-feed-pinch-host relative w-full">${inner}</div>
                ${bannedOverlay}
            </div>
        `;
                  })
                  .join('');
        
        const userDisplay = userDisplayForWheel;
        const avatarDisplay = avatarDisplayForWheel;
        const headPad = 'px-2 py-3';
        const avSize = 'w-10 h-10';
        const avIconCls = 'text-lg';
        return `
            <div class="${cardOuter}" data-post-id="${postId}" data-post-id-alternates="${alternatePostIds}"${layoutV2 ? ' data-moment-card-layout="2"' : ''}>
                ${
                    layoutV2
                        ? isBanned
                            ? `<div class="px-2 pt-2"><div class="text-[10px] font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full inline-flex items-center"><i class="fa-solid fa-ban mr-1"></i>공유 금지</div></div>`
                            : ''
                        : `<div class="${headPad} flex items-center gap-3 relative">
                    ${avatarDisplay.type === 'photo' ? `
                        <div class="${avSize} rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden border-2 border-slate-300 relative" style="background-image: url(${avatarDisplay.value}); background-size: cover; background-position: center;">
                            ${isGuestPost ? '<span class="absolute bottom-0 right-0 bg-black/70 text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center border border-white">게</span>' : ''}
                        </div>
                    ` : `
                        <div class="${avSize} rounded-full flex items-center justify-center flex-shrink-0 border-2 border-slate-300 ${avatarDisplay.type === 'default' ? 'bg-slate-200 text-slate-500' : 'bg-slate-200 ' + avIconCls}">
                            ${isGuestPost ? '게' : (avatarDisplay.type === 'default' ? `<i class="fa-solid fa-user ${avIconCls}"></i>` : escapeHtml(avatarDisplay.value))}
                        </div>
                    `}
                    <div class="flex-1 min-w-0 mr-2">
                        <div class="text-sm font-bold text-slate-800">${userDisplay.nickname}</div>
                        <div class="flex items-center gap-1 flex-wrap">
                            <span class="text-xs text-slate-400">${dateStr}</span>
                            ${mealLabel ? `<span class="text-[10px] font-bold ${mealLabelStyle || 'text-emerald-600 bg-emerald-50'} px-2 py-0.5 rounded-full whitespace-nowrap ml-1">${mealLabel}</span>` : ''}
                        </div>
                    </div>
                    ${isBanned ? `<div class="text-[10px] font-bold bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0"><i class="fa-solid fa-ban mr-1"></i>공유 금지</div>` : ''}
                    <div class="relative flex-shrink-0">
                        <button data-entry-id="${entryId || ''}" data-photo-urls="${(photoGroup.map(p => p.photoUrl).filter(Boolean).join(',') || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-caption="${captionAttr}" data-is-best="${isBestShare ? 'true' : 'false'}" data-is-daily="${isDailyShare ? 'true' : 'false'}" data-is-insight="${isInsightShare ? 'true' : 'false'}" data-photo-date="${photo.date || ''}" data-date-range-text="${photo.dateRangeText || ''}" data-photo-slot-id="${photo.slotId || ''}" data-post-id="${postId || ''}" data-author-user-id="${photo.userId || ''}" class="feed-options-btn w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-600 active:bg-slate-50 rounded-full transition-colors">
                            <i class="fa-solid fa-ellipsis-vertical text-lg"></i>
                        </button>
                    </div>
                </div>`
                }
                ${
                    layoutV2
                        ? v2PhotoLabelBlock
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
                ${caption && !layoutV2 ? `<div class="px-4 py-2 text-sm font-bold text-slate-800">${caption}</div>` : ''}
                ${
                    !layoutV2 && comment && !isBestShare && !isDailyShare && !isInsightShare
                        ? `
                    <div class="px-4 pb-3 text-sm text-slate-600">
                        <div id="feed-comment-collapsed-${groupIdx}" class="comment-text min-h-[1em]" data-comment-raw="${encodeURIComponent(comment)}" data-caption-variant="feed" data-group-idx="${groupIdx}">
                            <div data-comment-collapsed-mount class="leading-snug"></div>
                        </div>
                        <div id="feed-comment-expanded-${groupIdx}" class="comment-text hidden whitespace-pre-line break-words leading-snug cursor-pointer" onclick="window.toggleFeedComment(${groupIdx})">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
                    </div>
                `
                        : ''
                }
            </div>
        `;
    }).join('');
    
    // 사진 카운터 업데이트를 위한 이벤트 리스너 추가 및 피드 옵션 버튼 이벤트 리스너 추가
    setTimeout(() => {
        if (layoutV2) {
            setupMomentFeedV2WheelLayout(container);
        }
        const scrollContainers = container.querySelectorAll('.gallery-photo-scroll');
        scrollContainers.forEach((scrollContainer, idx) => {
            const counter = scrollContainer.parentElement.querySelector('.photo-counter-current');
            const photos = Array.from(scrollContainer.children);
            const photoCount = sortedGroups[idx]?.length || 0;
            const isVertical = scrollContainer.getAttribute('data-moment-carousel') === 'vertical';
            if (photoCount > 1) {
                let isDragging = false;
                let startX = 0;
                let startY = 0;
                let startScrollLeft = 0;
                let startScrollTop = 0;
                scrollContainer.style.cursor = 'grab';
                const onMouseMove = (e) => {
                    if (!isDragging) return;
                    e.preventDefault();
                    if (isVertical) {
                        const dy = e.pageY - startY;
                        scrollContainer.scrollTop = Math.max(0, Math.min(scrollContainer.scrollHeight - scrollContainer.clientHeight, startScrollTop - dy));
                    } else {
                        const dx = e.pageX - startX;
                        scrollContainer.scrollLeft = Math.max(0, Math.min(scrollContainer.scrollWidth - scrollContainer.clientWidth, startScrollLeft - dx));
                    }
                };
                const endDrag = () => {
                    if (!isDragging) return;
                    isDragging = false;
                    scrollContainer.style.cursor = 'grab';
                    scrollContainer.style.userSelect = '';
                    document.removeEventListener('mousemove', onMouseMove, { capture: true });
                    document.removeEventListener('mouseup', endDrag, { capture: true });
                };
                scrollContainer.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    isDragging = true;
                    startX = e.pageX;
                    startY = e.pageY;
                    startScrollLeft = scrollContainer.scrollLeft;
                    startScrollTop = scrollContainer.scrollTop;
                    scrollContainer.style.cursor = 'grabbing';
                    scrollContainer.style.userSelect = 'none';
                    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: false });
                    document.addEventListener('mouseup', endDrag, { capture: true });
                }, { passive: false });

                const snapToNearest = () => {
                    // 강한 스와이프/관성 스크롤로 여러 장이 한 번에 넘어가는 것을 방지:
                    // 스냅 목표 인덱스를 "직전 스냅 인덱스 ±1"로 제한한다.
                    if (scrollContainer._mealogMomentLastSnapIdx == null) {
                        scrollContainer._mealogMomentLastSnapIdx = 0;
                    }
                    if (isVertical) {
                        const sl = scrollContainer.scrollTop;
                        const ch = scrollContainer.clientHeight;
                        let nearest = 0;
                        let minDist = Infinity;
                        photos.forEach((p, i) => {
                            const pos = p.offsetTop + p.offsetHeight / 2;
                            const d = Math.abs(sl + ch / 2 - pos);
                            if (d < minDist) { minDist = d; nearest = i; }
                        });
                        {
                            const last = Number(scrollContainer._mealogMomentLastSnapIdx || 0);
                            if (nearest > last + 1) nearest = last + 1;
                            else if (nearest < last - 1) nearest = last - 1;
                            nearest = Math.max(0, Math.min(photos.length - 1, nearest));
                            scrollContainer._mealogMomentLastSnapIdx = nearest;
                        }
                        const target = photos[nearest]?.offsetTop ?? 0;
                        if (Math.abs(sl - target) > 2) scrollContainer.scrollTo({ top: target, behavior: 'smooth' });
                    } else {
                        const sl = scrollContainer.scrollLeft;
                        const cw = scrollContainer.clientWidth;
                        let nearest = 0;
                        let minDist = Infinity;
                        photos.forEach((p, i) => {
                            const pos = p.offsetLeft + p.offsetWidth / 2;
                            const d = Math.abs(sl + cw / 2 - pos);
                            if (d < minDist) { minDist = d; nearest = i; }
                        });
                        {
                            const last = Number(scrollContainer._mealogMomentLastSnapIdx || 0);
                            if (nearest > last + 1) nearest = last + 1;
                            else if (nearest < last - 1) nearest = last - 1;
                            nearest = Math.max(0, Math.min(photos.length - 1, nearest));
                            scrollContainer._mealogMomentLastSnapIdx = nearest;
                        }
                        const target = photos[nearest]?.offsetLeft ?? 0;
                        if (Math.abs(sl - target) > 2) scrollContainer.scrollTo({ left: target, behavior: 'smooth' });
                    }
                    preloadAdjacentGalleryImages(scrollContainer);
                };
                let snapTimeout = null;
                const onScrollEnd = () => {
                    clearTimeout(snapTimeout);
                    snapTimeout = setTimeout(snapToNearest, 80);
                };
                let preloadThrottle = null;
                const onScrollPreload = () => {
                    if (preloadThrottle) return;
                    preloadThrottle = setTimeout(() => { preloadThrottle = null; preloadAdjacentGalleryImages(scrollContainer); }, 50);
                };
                scrollContainer.addEventListener('scroll', onScrollEnd, { passive: true });
                scrollContainer.addEventListener('scroll', onScrollPreload, { passive: true });
                if ('onscrollend' in scrollContainer) {
                    scrollContainer.addEventListener('scrollend', snapToNearest);
                }
                preloadAdjacentGalleryImages(scrollContainer);
            }
            if (counter && photoCount > 1) {
                const slideEls = Array.from(scrollContainer.children);
                const updateCounter = () => {
                    let currentIndex = 1;
                    if (isVertical) {
                        const containerHeight = scrollContainer.clientHeight;
                        const scrollTop = scrollContainer.scrollTop;
                        slideEls.forEach((slide, photoIdx) => {
                            const c = slide.offsetTop + slide.offsetHeight / 2;
                            if (c >= scrollTop && c <= scrollTop + containerHeight) currentIndex = photoIdx + 1;
                        });
                    } else {
                        const containerWidth = scrollContainer.clientWidth;
                        const scrollLeft = scrollContainer.scrollLeft;
                        slideEls.forEach((slide, photoIdx) => {
                            const photoCenter = slide.offsetLeft + slide.offsetWidth / 2;
                            if (photoCenter >= scrollLeft && photoCenter <= scrollLeft + containerWidth) {
                                currentIndex = photoIdx + 1;
                            }
                        });
                    }
                    counter.textContent = currentIndex;
                };
                scrollContainer.addEventListener('scroll', updateCounter);
                updateCounter();
            }
        });

        // 피드 옵션 버튼에 이벤트 리스너 추가
        const feedOptionsButtons = container.querySelectorAll('.feed-options-btn');
        feedOptionsButtons.forEach(btn => {
            // 이미 이벤트 리스너가 추가되었는지 확인 (중복 방지)
            if (btn.hasAttribute('data-listener-added')) return;
            
            if (window.showFeedOptions) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const entryId = btn.getAttribute('data-entry-id') || '';
                    const photoUrls = btn.getAttribute('data-photo-urls') || '';
                    const isBestShare = btn.getAttribute('data-is-best') === 'true';
                    const photoDate = btn.getAttribute('data-photo-date') || '';
                    const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
                    const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
                    const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
                    const dateRangeText = btn.getAttribute('data-date-range-text') || '';
                    const postId = btn.getAttribute('data-post-id') || '';
                    const authorUserId = btn.getAttribute('data-author-user-id') || '';
                    const caption = btn.getAttribute('data-caption') || '';
                    window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
                });
                btn.setAttribute('data-listener-added', 'true');
            } else {
                // 함수가 아직 로드되지 않았으면 조금 후에 다시 시도
                setTimeout(() => {
                    if (window.showFeedOptions && !btn.hasAttribute('data-listener-added')) {
                        btn.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const entryId = btn.getAttribute('data-entry-id') || '';
                            const photoUrls = btn.getAttribute('data-photo-urls') || '';
                            const isBestShare = btn.getAttribute('data-is-best') === 'true';
                            const photoDate = btn.getAttribute('data-photo-date') || '';
                            const photoSlotId = btn.getAttribute('data-photo-slot-id') || '';
                            const isDailyShare = btn.getAttribute('data-is-daily') === 'true';
                            const isInsightShare = btn.getAttribute('data-is-insight') === 'true';
                            const dateRangeText = btn.getAttribute('data-date-range-text') || '';
                            const postId = btn.getAttribute('data-post-id') || '';
                            const authorUserId = btn.getAttribute('data-author-user-id') || '';
                            const caption = btn.getAttribute('data-caption') || '';
                            window.showFeedOptions(entryId, photoUrls, isBestShare, photoDate, photoSlotId, isDailyShare, postId, authorUserId, isInsightShare, dateRangeText, caption);
                        });
                        btn.setAttribute('data-listener-added', 'true');
                    }
                }, 200);
            }
        });
        
        // Feed 코멘트: 본문+더보기 합쳐 3줄 레이아웃 (측정 후 마운트)
        setTimeout(() => {
            sortedGroups.forEach((_, idx) => {
                const collapsedEl = document.getElementById(`feed-comment-collapsed-${idx}`);
                if (collapsedEl) applyCollapsedCaptionToElement(collapsedEl);
            });
        }, 300);
        
        // 각 포스트의 좋아요, 북마크, 댓글 로드
        sortedGroups.forEach((photoGroup) => {
            const postId = getPostIdFromPhotoGroup(photoGroup);

            if (postId && window.postInteractions && window.currentUser && !window.currentUser.isAnonymous) {
                // 좋아요 상태 및 수 로드
                Promise.all([
                    window.postInteractions.isLiked(postId, window.currentUser.uid).catch(() => false),
                    window.postInteractions.getLikes(postId).catch(() => []),
                    window.postInteractions.isBookmarked(postId, window.currentUser.uid).catch(() => false)
                ]).then(([isLiked, likes, isBookmarked]) => {
                    const likeBtn = document.querySelector(`.post-like-btn[data-post-id="${postId}"]`);
                    const likeIcon = likeBtn?.querySelector('.post-like-icon');
                    const likeCountEl = document.querySelector(`.post-like-count[data-post-id="${postId}"]`);
                    const bookmarkBtn = document.querySelector(`.post-bookmark-btn[data-post-id="${postId}"]`);
                    const bookmarkIcon = bookmarkBtn?.querySelector('.post-bookmark-icon');
                    
                    if (likeBtn && likeIcon) {
                        if (isLiked) {
                            likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800');
                            likeIcon.classList.add('fa-solid', 'fa-heart', 'text-red-500');
                        }
                    }
                    if (likeCountEl) {
                        likeCountEl.textContent = likes.length > 0 ? likes.length : '';
                    }
                    if (bookmarkBtn && bookmarkIcon && isBookmarked) {
                        bookmarkIcon.classList.remove('fa-regular', 'fa-bookmark');
                        bookmarkIcon.classList.add('fa-solid', 'fa-bookmark');
                    }
                }).catch(e => {
                    console.error(`좋아요/북마크 상태 로드 실패 (postId: ${postId}):`, e);
                });
            }
            
            // 댓글 로드
            if (postId && window.loadPostComments) {
                window.loadPostComments(postId).catch(e => {
                    console.error(`댓글 로드 실패 (postId: ${postId}):`, e);
                });
            }
        });
    }, 100);
}

export function toggleFeedComment(groupIdx) {
    const id = groupIdx != null && groupIdx !== '' ? String(groupIdx) : '';
    if (!id) return;
    const collapsedEl = document.getElementById(`feed-comment-collapsed-${id}`);
    const expandedEl = document.getElementById(`feed-comment-expanded-${id}`);
    if (!collapsedEl || !expandedEl) return;

    const isCollapsed = !collapsedEl.classList.contains('hidden');
    if (isCollapsed) {
        collapsedEl.classList.add('hidden');
        expandedEl.classList.remove('hidden');
    } else {
        expandedEl.classList.add('hidden');
        collapsedEl.classList.remove('hidden');
    }
}
