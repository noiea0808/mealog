/**
 * 타임라인 카드 좌측 사진 탭 — 가로: 해당 기록의 사진들(다장은 일부+펼침), 세로: 같은 달(월) 기록이 있는 날·슬롯 순서, 하단에서 다음 달 추가
 * 오버레이 루트: 앱 컬럼(max 28rem) 가운데. 전체 스크림은 `.timeline-meal-photos-overlay-backdrop`(fixed)만 뷰포트 전체.
 */
import { escapeHtml } from './utils.js';
import { appState } from '../state.js';
import { processPhotosToGroups } from './post-group-utils.js';
import { appendMomentFeedNextPage } from './gallery.js';
import {
    buildMealPhotoViewerRowsForDate,
    buildMealPhotoViewerRowsForMonth,
    findMealPhotoViewerRowIndex
} from './timeline.js';
import { applyStackCommentBtnVisual } from './moment-post-interactions.js';

const OVERLAY_ID = 'timelineMealPhotosOverlay';

/**
 * 사진 팝업 소셜 댓글 아이콘 — `overlay` 댓글 박스 열림 시 `fa-solid`·채움, 아닐 때 `fa-regular`
 * @param {string} postId
 * @param {boolean} filled
 */
function setMealPhotoOverlayPostCommentIconFilled(overlayEl, postId, filled) {
    if (!overlayEl?.querySelectorAll || !postId) return;
    const p = String(postId);
    let btn;
    overlayEl.querySelectorAll('.post-comment-btn[data-post-id]').forEach((b) => {
        if (b.getAttribute('data-post-id') === p) btn = b;
    });
    const icon = btn?.querySelector?.('.post-comment-icon');
    if (!icon) return;
    if (btn.querySelector('.post-comment-fill')) {
        applyStackCommentBtnVisual(p);
        return;
    }
    icon.classList.remove('fa-regular', 'fa-solid', 'text-white/95', 'text-slate-800');
    if (filled) {
        icon.classList.add('fa-solid', 'fa-comment', 'text-white/95', 'post-comment-icon', 'timeline-meal-photo-moment-social-icon');
    } else {
        icon.classList.add('fa-regular', 'fa-comment', 'text-white/95', 'post-comment-icon', 'timeline-meal-photo-moment-social-icon');
    }
}

function getMealPhotoOverlayActiveRow(overlayEl) {
    const vtrack = overlayEl?._mealPhotosVTrack;
    if (!vtrack) return null;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return null;
    const si = getVTrackActiveIndex(vtrack);
    return getCarouselRowForSlide(slides[si], overlayEl);
}

/** 댓글 패널 높이만큼 본문 `padding-bottom`에 맞출 값(px). flex 가운데 정렬로 잘리는 문제를 피하려고 예약 영역을 쓴다. */
function updateMealPhotoOverlayPostCommentsReserve(overlayEl) {
    if (!overlayEl) return;
    if (!overlayEl._mealPhotoPostCommentsOpen) {
        overlayEl.style.removeProperty('--meal-overlay-post-comments-reserve');
        return;
    }
    const panel = overlayEl.querySelector('[data-meal-overlay-post-comments-panel]');
    if (!panel || panel.classList.contains('hidden')) {
        overlayEl.style.removeProperty('--meal-overlay-post-comments-reserve');
        return;
    }
    const h = Math.round(panel.getBoundingClientRect().height);
    if (h > 0) {
        overlayEl.style.setProperty('--meal-overlay-post-comments-reserve', `${h}px`);
    } else {
        overlayEl.style.removeProperty('--meal-overlay-post-comments-reserve');
    }
}

function ensureMealPhotoOverlayPostCommentsPanelReserveObserver(overlayEl) {
    if (!overlayEl || overlayEl._mealPhotoPostCommentsReserveObserverBound) return;
    const panel = overlayEl.querySelector('[data-meal-overlay-post-comments-panel]');
    if (!panel) return;
    overlayEl._mealPhotoPostCommentsReserveObserverBound = true;
    const ro = new ResizeObserver(() => {
        if (!overlayEl._mealPhotoPostCommentsOpen) return;
        updateMealPhotoOverlayPostCommentsReserve(overlayEl);
        if (overlayEl.classList.contains('timeline-meal-photos-overlay--wheel')) {
            requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(overlayEl));
        } else {
            overlayEl._mealPhotosLayout?.();
        }
    });
    ro.observe(panel);
    overlayEl._mealPhotoPostCommentsPanelResizeObserver = ro;
}

function hideMealPhotoOverlayPostCommentsPanel(overlayEl) {
    if (!overlayEl) return;
    overlayEl.classList.remove('timeline-meal-photos-overlay--post-comments-open');
    overlayEl.style.removeProperty('--meal-overlay-post-comments-reserve');
    const panel = overlayEl.querySelector('[data-meal-overlay-post-comments-panel]');
    if (panel) {
        panel.classList.add('hidden');
        panel.classList.remove('flex', 'flex-col');
    }
    const pid = overlayEl._mealPhotoPostCommentsPostId;
    overlayEl._mealPhotoPostCommentsOpen = false;
    overlayEl._mealPhotoPostCommentsPostId = null;
    if (pid) setMealPhotoOverlayPostCommentIconFilled(overlayEl, pid, false);
    const inp = overlayEl.querySelector('[data-meal-overlay-post-comments-input]');
    if (inp) inp.value = '';
    requestAnimationFrame(() => {
        overlayEl._mealPhotosLayout?.();
        if (overlayEl.classList.contains('timeline-meal-photos-overlay--wheel')) {
            requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(overlayEl));
        }
    });
}

/**
 * @param {string} postId
 * @param {{ closeOnly?: boolean }} [opts] — `true`이면 켜져 있을 때 끄기(토글 닫힘)만
 */
function toggleMealPhotoOverlayPostCommentPanel(overlayEl, postId, opts = {}) {
    if (!overlayEl || overlayEl.classList.contains('hidden') || !postId) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        window.requestLogin?.();
        return;
    }
    const closeOnly = opts.closeOnly === true;
    const sameOpen =
        overlayEl._mealPhotoPostCommentsOpen && String(overlayEl._mealPhotoPostCommentsPostId) === String(postId);
    if (closeOnly) {
        if (sameOpen) hideMealPhotoOverlayPostCommentsPanel(overlayEl);
        return;
    }
    if (sameOpen) {
        hideMealPhotoOverlayPostCommentsPanel(overlayEl);
        return;
    }

    if (overlayEl._mealPhotoAuthorCommentBoxVisible) {
        overlayEl._mealPhotoAuthorCommentBoxVisible = false;
        const row = getMealPhotoOverlayActiveRow(overlayEl);
        syncMealPhotoOverlayAuthorCommentLine(overlayEl, row);
        updateMealPhotoCommentToggleUi(overlayEl);
    }

    const panel = overlayEl.querySelector('[data-meal-overlay-post-comments-panel]');
    const list = overlayEl.querySelector('[data-meal-overlay-post-comments-list]');
    const inp = overlayEl.querySelector('[data-meal-overlay-post-comments-input]');
    if (!panel || !list || !inp) return;

    overlayEl._mealPhotoPostCommentsOpen = true;
    overlayEl._mealPhotoPostCommentsPostId = String(postId);
    setMealPhotoOverlayPostCommentIconFilled(overlayEl, postId, true);

    overlayEl.classList.add('timeline-meal-photos-overlay--post-comments-open');
    panel.classList.remove('hidden');
    panel.classList.add('flex', 'flex-col');
    ensureMealPhotoOverlayPostCommentsPanelReserveObserver(overlayEl);
    void window.loadPostCommentsForMealPhotoOverlayList?.(String(postId), list);
    requestAnimationFrame(() => {
        updateMealPhotoOverlayPostCommentsReserve(overlayEl);
        overlayEl._mealPhotosLayout?.();
        requestAnimationFrame(() => {
            if (overlayEl.classList.contains('timeline-meal-photos-overlay--wheel')) {
                runMealPhotoWheelLabelLayoutWhenReady(overlayEl);
            }
            requestAnimationFrame(() => {
                updateMealPhotoOverlayPostCommentsReserve(overlayEl);
            });
        });
        try {
            inp.focus();
        } catch (_) {
            /* ignore */
        }
    });
}

function maybeCloseMealPhotoPostCommentsOnPostChange(overlayEl) {
    if (!overlayEl?._mealPhotoPostCommentsOpen) return;
    const row = getMealPhotoOverlayActiveRow(overlayEl);
    const ap = row?.overlayPostId != null && String(row.overlayPostId) !== '' ? String(row.overlayPostId) : null;
    const st = overlayEl._mealPhotoPostCommentsPostId != null ? String(overlayEl._mealPhotoPostCommentsPostId) : null;
    if (!ap || !st || ap !== st) hideMealPhotoOverlayPostCommentsPanel(overlayEl);
}

/** 소셜 댓글 아이콘: 팝업 댓글 박스에 맞게 재동기화 */
function syncMealPhotoOverlayPostCommentIconState(overlayEl) {
    if (!overlayEl?._mealPhotoPostCommentsOpen || !overlayEl?._mealPhotoPostCommentsPostId) return;
    setMealPhotoOverlayPostCommentIconFilled(overlayEl, overlayEl._mealPhotoPostCommentsPostId, true);
}

window._mealPhotoOverlayOpenComment = (postId) => {
    const o = document.getElementById(OVERLAY_ID);
    if (!o || o.classList.contains('hidden')) return;
    toggleMealPhotoOverlayPostCommentPanel(o, String(postId));
};

/** 모먼트 휠 오버레이 ⋮ 메뉴 — 피드와 동일 옵션을 중앙 팝업으로 */
window._openMealOverlayFeedOptions = (btn) => {
    const raw = btn?.getAttribute?.('data-meal-feed-options');
    if (!raw || typeof window.showFeedOptions !== 'function') return;
    let o;
    try {
        o = JSON.parse(decodeURIComponent(raw));
    } catch (_) {
        return;
    }
    window.showFeedOptions(
        o.entryId || '',
        o.photoUrls || '',
        Boolean(o.isBestShare),
        o.photoDate || '',
        o.photoSlotId || '',
        Boolean(o.isDailyShare),
        o.postId || '',
        o.authorUserId || '',
        Boolean(o.isInsightShare),
        o.dateRangeText || '',
        o.captionPlain || '',
        'center'
    );
};

/** 모먼트 카드와 동일한 좋아요·북마크 표시로 오버레이 버튼 초기 동기화 */
function syncMealPhotoOverlaySocialFromFeed(overlayEl) {
    if (!overlayEl?.querySelector) return;
    overlayEl.querySelectorAll('.post-like-btn[data-post-id]').forEach((btn) => {
        const pid = btn.getAttribute('data-post-id');
        if (!pid) return;
        const srcIcon = document.querySelector(`.instagram-post .post-like-btn[data-post-id="${pid}"] .post-like-icon`);
        const dstIcon = btn.querySelector('.post-like-icon');
        if (!srcIcon || !dstIcon) return;
        const liked = srcIcon.classList.contains('fa-solid');
        const dstFill = btn.querySelector('.post-like-fill');
        if (dstFill) {
            dstIcon.className =
                'fa-regular fa-heart text-white/95 post-like-icon timeline-meal-photo-moment-social-icon relative z-[1]';
            btn.classList.toggle('post-social-state-on', liked);
            return;
        }
        dstIcon.className =
            'post-like-icon timeline-meal-photo-moment-social-icon ' +
            (liked ? 'fa-solid fa-heart' : 'fa-regular fa-heart text-white/95');
    });
    overlayEl.querySelectorAll('.post-bookmark-btn[data-post-id]').forEach((btn) => {
        const pid = btn.getAttribute('data-post-id');
        if (!pid) return;
        const srcIcon = document.querySelector(`.instagram-post .post-bookmark-btn[data-post-id="${pid}"] .post-bookmark-icon`);
        const dstIcon = btn.querySelector('.post-bookmark-icon');
        if (!srcIcon || !dstIcon) return;
        const marked = srcIcon.classList.contains('fa-solid');
        const dstFill = btn.querySelector('.post-bookmark-fill');
        if (dstFill) {
            dstIcon.className =
                'fa-regular fa-bookmark text-white/95 post-bookmark-icon timeline-meal-photo-moment-social-icon relative z-[1]';
            btn.classList.toggle('post-social-state-on', marked);
            return;
        }
        dstIcon.className =
            'post-bookmark-icon timeline-meal-photo-moment-social-icon ' +
            (marked ? 'fa-solid fa-bookmark' : 'fa-regular fa-bookmark text-white/95');
    });
    overlayEl.querySelectorAll('.post-like-count[data-post-id]').forEach((el) => {
        const pid = el.getAttribute('data-post-id');
        if (!pid) return;
        const feed = document.querySelector(`.instagram-post .post-like-count[data-post-id="${pid}"]`);
        if (feed) el.textContent = feed.textContent || '';
    });
}

/**
 * 팝업만 피드 카드(`.instagram-post`)에 없을 때(타임라인 휠 등) — 서버·DOM 중 최종 상태로 아이콘·개수 갱신
 * `syncMealPhotoOverlaySocialFromFeed` 후 호출(서버가 피드 미러보다 우선)
 */
async function hydrateMealPhotoOverlaySocial(overlayEl) {
    const pi = window.postInteractions;
    if (!overlayEl?.querySelector || !pi?.getLikes) return;
    const u = window.currentUser;
    const canUser = u && !u.isAnonymous;
    const ids = [
        ...new Set(
            [
                ...overlayEl.querySelectorAll(
                    '.post-like-btn[data-post-id], .post-bookmark-btn[data-post-id], .post-comment-btn[data-post-id]'
                )
            ]
                .map((el) => el.getAttribute('data-post-id'))
                .filter(Boolean)
        )
    ];
    for (const postId of ids) {
        try {
            const altEl = document.querySelector(`.instagram-post[data-post-id="${CSS.escape(String(postId))}"]`);
            const alternates = altEl
                ? (altEl.getAttribute('data-post-id-alternates') || '').split(',').filter(Boolean)
                : [];
            const likesP = pi.getLikes(postId).catch(() => []);
            const likedP = canUser && pi.isLiked ? pi.isLiked(postId, u.uid).catch(() => false) : Promise.resolve(false);
            const markP = canUser && pi.isBookmarked ? pi.isBookmarked(postId, u.uid).catch(() => false) : Promise.resolve(false);
            const commentsP =
                canUser && typeof pi.getComments === 'function'
                    ? pi.getComments(postId, alternates).catch(() => [])
                    : Promise.resolve([]);
            const [likes, isLiked, isMarked, comments] = await Promise.all([likesP, likedP, markP, commentsP]);
            const likeN = Array.isArray(likes) ? likes.length : 0;
            overlayEl.querySelectorAll(`.post-like-count[data-post-id="${postId}"]`).forEach((el) => {
                el.textContent = likeN > 0 ? String(likeN) : '';
            });
            overlayEl.querySelectorAll(`.post-like-btn[data-post-id="${postId}"]`).forEach((likeBtn) => {
                const likeIcon = likeBtn.querySelector('.post-like-icon');
                if (!likeIcon) return;
                if (likeBtn.querySelector('.post-like-fill')) {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-red-400', 'text-slate-800', 'text-white', 'text-white/95');
                    likeIcon.classList.add('fa-regular', 'fa-heart', 'text-white/95', 'timeline-meal-photo-moment-social-icon', 'relative', 'z-[1]');
                    likeBtn.classList.toggle('post-social-state-on', Boolean(isLiked));
                    return;
                }
                if (isLiked) {
                    likeIcon.classList.remove('fa-regular', 'fa-heart', 'text-slate-800', 'text-white', 'text-white/95', 'text-red-500');
                    likeIcon.classList.add('fa-solid', 'fa-heart', 'timeline-meal-photo-moment-social-icon');
                } else {
                    likeIcon.classList.remove('fa-solid', 'fa-heart', 'text-red-500', 'text-red-400');
                    likeIcon.classList.add('fa-regular', 'fa-heart', 'text-white/95', 'timeline-meal-photo-moment-social-icon');
                }
            });
            overlayEl.querySelectorAll(`.post-bookmark-btn[data-post-id="${postId}"]`).forEach((bookmarkBtn) => {
                const ic = bookmarkBtn.querySelector('.post-bookmark-icon');
                if (!ic) return;
                if (bookmarkBtn.querySelector('.post-bookmark-fill')) {
                    ic.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800', 'text-white', 'text-white/95');
                    ic.classList.add('fa-regular', 'fa-bookmark', 'text-white/95', 'timeline-meal-photo-moment-social-icon', 'relative', 'z-[1]');
                    bookmarkBtn.classList.toggle('post-social-state-on', Boolean(isMarked));
                    return;
                }
                if (isMarked) {
                    ic.classList.remove('fa-regular', 'fa-bookmark', 'text-white', 'text-slate-800', 'text-white/95');
                    ic.classList.add('fa-solid', 'fa-bookmark', 'timeline-meal-photo-moment-social-icon');
                } else {
                    ic.classList.remove('fa-solid', 'fa-bookmark', 'text-slate-800', 'text-white', 'text-white/95');
                    ic.classList.add('fa-regular', 'fa-bookmark', 'text-white/95', 'timeline-meal-photo-moment-social-icon');
                }
            });
            const hasCommented =
                canUser &&
                Array.isArray(comments) &&
                comments.some((c) => (c.userId || c.authorId) === u.uid);
            overlayEl.querySelectorAll(`.post-comment-btn[data-post-id="${postId}"]`).forEach((btn) => {
                if (!btn.querySelector('.post-comment-fill')) return;
                if (hasCommented) btn.setAttribute('data-post-user-commented', '1');
                else btn.removeAttribute('data-post-user-commented');
            });
            applyStackCommentBtnVisual(postId);
        } catch (_) {
            /* ignore */
        }
    }
    syncMealPhotoOverlayPostCommentIconState(overlayEl);
}

/** 휠 하단: 글 작성 시 넣은 기록 코멘트(소셜 댓글 아님) — 토글이 켜졌을 때만 밴드 표시 */
function syncMealPhotoOverlayAuthorCommentLine(overlayEl, row) {
    const footer = overlayEl?.querySelector?.('.timeline-meal-photos-caption-footer');
    const band = footer?.querySelector?.('[data-meal-overlay-comment-band]');
    const body = footer?.querySelector?.('[data-meal-overlay-comment-body]');
    if (!band || !body) return;
    let r = row;
    if ((!r || !String(r.authorMealComment || '').trim()) && overlayEl?._mealPhotosVTrack) {
        const vtrack = overlayEl._mealPhotosVTrack;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const si = getVTrackActiveIndex(vtrack);
        const slide = slides[si];
        if (slide) {
            const resolved = getCarouselRowForSlide(slide, overlayEl);
            if (resolved) r = resolved;
        }
    }
    const text = String(r?.authorMealComment || '').trim();
    if (!text) {
        band.classList.add('hidden');
        body.innerHTML = '';
        updateMealPhotoCommentToggleUi(overlayEl);
        return;
    }
    body.innerHTML = `<div class="whitespace-pre-wrap break-words">${escapeHtml(text)}</div>`;
    if (overlayEl._mealPhotoAuthorCommentBoxVisible === true) {
        band.classList.remove('hidden');
    } else {
        band.classList.add('hidden');
    }
    updateMealPhotoCommentToggleUi(overlayEl);
}

/** `comment` 토글 버튼(휠 모드) — 온/오프 UI 동기화 */
function updateMealPhotoCommentToggleUi(overlayEl) {
    if (!overlayEl?.querySelector) return;
    const on = overlayEl._mealPhotoAuthorCommentBoxVisible === true;
    overlayEl.querySelectorAll('[data-meal-photo-comment-toggle]').forEach((btn) => {
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.classList.toggle('timeline-meal-photo-comment-toggle--on', on);
        btn.classList.toggle('timeline-meal-photo-comment-toggle--off', !on);
    });
}

/** 캐러셀 마우스 축 잠금용 document 리스너 — add/remove 시 동일 객체 참조 필요 */
const MEAL_PHOTO_CAROUSEL_DOC_CAPTURE = { passive: false, capture: true };
function removeMealPhotoCarouselDocumentPointerListeners(overlayEl) {
    if (!overlayEl?._mealCarouselDocAttached) return;
    overlayEl._mealCarouselDocAttached = false;
    const mv = overlayEl._mealCarouselDocMove;
    const up = overlayEl._mealCarouselDocUp;
    if (mv) document.removeEventListener('pointermove', mv, MEAL_PHOTO_CAROUSEL_DOC_CAPTURE);
    if (up) {
        document.removeEventListener('pointerup', up, true);
        document.removeEventListener('pointercancel', up, true);
    }
    overlayEl._mealCarouselDocMove = null;
    overlayEl._mealCarouselDocUp = null;
}

/** 한 게시물(행)에서 처음에 DOM에 넣을 사진 장 수 — 초과분은「더 보기」로 펼침 */
const MEAL_PHOTO_VIEWER_INITIAL_PHOTOS = 8;

/** 실제 URL은 보이는 한 칸만 부여 — 나머지는 `hydrateMealPhotoVisibleImage`에서 로드 */
const MEAL_PHOTO_SRC_PENDING =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 인접 슬라이드·가로 이웃 URL 프리로드(브라우저 캐시) — 세로 스와이프 시 빈 화면 완화 */
const _mealPhotoPreloadStarted = new Set();
function preloadMealPhotoUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (_mealPhotoPreloadStarted.has(url)) return;
    _mealPhotoPreloadStarted.add(url);
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
}

/** body `max-w-md`와 동일 — 오버레이 루트 가로·내부 정렬 */
const MEAL_APP_COLUMN_MAX_REM = 28;

function getMealogColumnMaxWidthPx() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return MEAL_APP_COLUMN_MAX_REM * rem;
}

/**
 * 오버레이 루트(대화상자 박스): 세로는 visualViewport, 가로는 앱 컬럼(최대 28rem) 가운데.
 * 좌우 끝까지 스크림은 `syncOverlayLayout`이 `.timeline-meal-photos-overlay-backdrop`에만 맞춤.
 */
function getMealogContentOverlayRect() {
    const vv = window.visualViewport;
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const colW = getMealogColumnMaxWidthPx();
    const w = Math.min(innerW, colW);
    const left = Math.max(0, (innerW - w) / 2);
    const top = vv ? vv.offsetTop : 0;
    const height = typeof vv?.height === 'number' ? vv.height : innerH;
    return { top, left, width: Math.max(1, w), height: Math.max(120, height) };
}

function ensureMealPhotoOverlayBackdrop(overlayEl) {
    if (!overlayEl || overlayEl.querySelector('.timeline-meal-photos-overlay-backdrop')) return;
    const bd = document.createElement('div');
    bd.className =
        'timeline-meal-photos-overlay-backdrop pointer-events-auto fixed z-0 bg-white/50 backdrop-blur-md';
    bd.setAttribute('aria-hidden', 'true');
    overlayEl.insertBefore(bd, overlayEl.firstChild);
}

function syncOverlayLayout() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el || el.classList.contains('hidden')) return;
    const r = getMealogContentOverlayRect();
    el.style.top = `${Math.round(r.top)}px`;
    el.style.left = `${Math.round(r.left)}px`;
    el.style.width = `${Math.round(r.width)}px`;
    el.style.height = `${Math.round(r.height)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    const bd = el.querySelector('.timeline-meal-photos-overlay-backdrop');
    if (bd) {
        const vv = window.visualViewport;
        const innerW = window.innerWidth;
        const innerH = window.innerHeight;
        const fw = vv && typeof vv.width === 'number' && vv.width > 0 ? vv.width : innerW;
        const fl = vv && typeof vv.offsetLeft === 'number' ? Math.max(0, vv.offsetLeft) : 0;
        const ft = vv ? vv.offsetTop : 0;
        const fh = vv && typeof vv.height === 'number' ? vv.height : innerH;
        bd.style.top = `${Math.round(ft)}px`;
        bd.style.left = `${Math.round(fl)}px`;
        bd.style.width = `${Math.round(fw)}px`;
        bd.style.height = `${Math.round(fh)}px`;
        bd.style.right = 'auto';
        bd.style.bottom = 'auto';
    }
    el._mealPhotosSync?.();
    positionMealPhotoCloseButton(el);
    if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                syncMealPhotoWheelCaptionPhotoMinWidth(el);
                positionMealPhotoCloseButton(el);
            });
        });
    }
}

/** 닫기 버튼: 오버레이(앱 컬럼) 우상단 고정 */
function positionMealPhotoCloseButton(el) {
    if (!el || el.classList.contains('hidden')) return;
    const btn = el.querySelector('.timeline-meal-photos-close');
    if (!btn) return;
    btn.style.position = 'absolute';
    btn.style.left = 'auto';
    btn.style.removeProperty('transform');
    btn.style.top = 'max(8px, env(safe-area-inset-top, 0px))';
    btn.style.right = 'max(8px, env(safe-area-inset-right, 0px))';
    btn.style.bottom = 'auto';
}

function buildBottomCaption(row) {
    if (row.isEmptyRow) {
        const t = '기록 없음';
        return row.place ? `${escapeHtml(t)} @ ${escapeHtml(row.place)}` : escapeHtml(t);
    }
    const menu = (row.menuLine || '').trim() || '—';
    const m = escapeHtml(menu);
    const p = (row.place || '').trim();
    return p ? `${m} @ ${escapeHtml(p)}` : m;
}

/** 이미지 위 우측: 다장일 때만 i/N */
function buildPhotoIndexOnImageHtml(index1Based, nPhotos) {
    if (nPhotos <= 1) return '';
    return `<div class="pointer-events-none absolute right-[3px] top-[3px] z-[3] rounded bg-black/75 px-1 py-0.5 text-[10px] font-black tabular-nums leading-none text-white">${index1Based}/${nPhotos}</div>`;
}

/** 사진 팝업 오버레이: 좋아요·댓글·북마크 (캐러셀 하단앵커) */
function buildMealPhotoOverlaySocialButtonsHtml(postId) {
    const pid = escapeHtml(String(postId));
    const pidJson = JSON.stringify(String(postId));
    return `<button type="button" class="post-like-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${pid}" data-requires-login="true" onclick='window.toggleLike(${pidJson})' aria-label="좋아요"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i class="fa-solid fa-heart post-like-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-heart post-like-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span><span class="post-like-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${pid}" aria-hidden="true"></span></button><button type="button" class="post-comment-btn timeline-meal-photo-moment-social-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-full" data-post-id="${pid}" data-requires-login="true" onclick='window._mealPhotoOverlayOpenComment && window._mealPhotoOverlayOpenComment(${pidJson})' aria-label="댓글"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i class="fa-solid fa-comment post-comment-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-comment post-comment-icon text-white/95 timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span></button><button type="button" class="post-bookmark-btn timeline-meal-photo-moment-social-btn relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full overflow-visible" data-post-id="${pid}" data-requires-login="true" onclick='window.toggleBookmark(${pidJson})' aria-label="북마크"><span class="timeline-meal-photo-moment-social-icon-stack absolute inset-0" aria-hidden="true"><i class="fa-solid fa-bookmark post-bookmark-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-bookmark post-bookmark-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></button>`;
}

/** 모먼트 휠: 사진 위 좌상단 프로필·우상단 미트볼(옵션) — 소셜은 사진 하단 우측 앵커 */
function buildMomentOverlayChromeHtml(row) {
    const postId = row.overlayPostId;
    const a = row.overlayAuthor;
    if (!postId || !a) return '';
    const nick = escapeHtml(String(a.nickname || ''));
    const meatball = buildMealPhotoMeatballBtnHtml(row);
    let avatarBlock;
    if (a.avatarType === 'photo' && a.avatarValue) {
        const url = escapeHtml(String(a.avatarValue));
        const inner = `<div class="timeline-meal-photo-moment-avatar h-8 w-8 rounded-full bg-slate-800/25 bg-cover bg-center shadow-inner" style="background-image:url('${url}')"></div>`;
        avatarBlock = a.isGuestPost
            ? `<div class="relative shrink-0">${inner}<span class="absolute bottom-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white/40 bg-black/50 text-[7px] font-bold text-white">게</span></div>`
            : inner;
    } else if (a.avatarType === 'default') {
        avatarBlock = `<div class="timeline-meal-photo-moment-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800/30 shadow-inner"><i class="fa-solid fa-user text-sm text-white/90" aria-hidden="true"></i></div>`;
    } else {
        const ch = escapeHtml(String(a.avatarValue || '').slice(0, 1));
        avatarBlock = `<div class="timeline-meal-photo-moment-avatar flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800/30 text-sm font-medium text-white/95 shadow-inner">${ch}</div>`;
    }
    return `<div class="timeline-meal-photo-moment-chrome pointer-events-none absolute inset-0 z-[18] flex flex-col">
            <div class="pointer-events-none flex items-center justify-between gap-2 px-2 pt-1.5">
                <button type="button" class="timeline-meal-photo-moment-chrome-chip pointer-events-auto flex max-w-[min(100%,14rem)] items-center gap-2 rounded-full border border-white/35 bg-white/50 py-0 pl-1 pr-2.5 text-left shadow-sm backdrop-blur-sm active:bg-white/60" onclick='window.filterGalleryByUser && window.filterGalleryByUser(${JSON.stringify(String(a.userId || ''))}, ${JSON.stringify(String(a.nickname || ''))})'>
                    ${avatarBlock}
                    <span class="timeline-meal-photo-moment-nick truncate text-base font-bold text-slate-700">${nick}</span>
                </button>
                ${meatball}
            </div>
        </div>`;
}

function addCalendarMonth(year, month, delta) {
    const d = new Date(year, month - 1 + delta, 1);
    return { y: d.getFullYear(), mo: d.getMonth() + 1 };
}

function monthHasMealData(year, month) {
    const history = window.mealHistory || [];
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    return history.some((x) => typeof x.date === 'string' && x.date.startsWith(prefix));
}

/** from 연·월 이후(다음 달부터) 기록이 있는 첫 달 */
function getNextMonthWithData(fromYear, fromMonth) {
    let y = fromYear;
    let mo = fromMonth;
    for (let i = 0; i < 240; i++) {
        const n = addCalendarMonth(y, mo, 1);
        y = n.y;
        mo = n.mo;
        if (monthHasMealData(y, mo)) return { y, mo };
    }
    return null;
}

function parseYearMonthFromDateStr(dateStr) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateStr || ''));
    if (!m) return null;
    return { y: Number(m[1]), mo: Number(m[2]) };
}

/** @param {Array<object>} rows */
function prepareRowsWithPhotoCap(rows) {
    return rows.map((r) => {
        const all = Array.isArray(r.urls) ? r.urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
        if (all.length <= MEAL_PHOTO_VIEWER_INITIAL_PHOTOS) return { ...r, urls: all };
        return { ...r, urls: all.slice(0, MEAL_PHOTO_VIEWER_INITIAL_PHOTOS), allUrls: all };
    });
}

/** 사진이 한 장도 없는 기록은 팝업 세로 목록에서 제외 */
function filterRowsWithPhotos(rows) {
    return (rows || []).filter((r) => {
        const u = Array.isArray(r.urls) ? r.urls : [];
        return u.length > 0;
    });
}

function normalizeViewerPhotoAspectRatio(val) {
    const v = String(val || '1:1');
    if (v === '3:4' || v === '4:3') return v;
    return '1:1';
}

function getViewerAspectRatioCss(row) {
    const r = normalizeViewerPhotoAspectRatio(row?.photoAspectRatio);
    if (r === '3:4') return '3/4';
    if (r === '4:3') return '4/3';
    return '1/1';
}

function buildMonthLoadFooterHtml(lastYear, lastMonth) {
    const next = getNextMonthWithData(lastYear, lastMonth);
    if (!next) return '';
    const label = `${next.y}년 ${next.mo}월`;
    return `<div class="timeline-meal-photos-month-footer flex w-full shrink-0 flex-col items-stretch border-t border-white/10 py-4">
            <button type="button" class="timeline-meal-photos-load-next-month w-full rounded-xl border border-white/20 bg-white/10 px-3 py-3 text-center text-sm font-bold text-white hover:bg-white/15 active:scale-[0.99]" data-next-y="${next.y}" data-next-m="${next.mo}">${escapeHtml(label)} 기록 더 불러오기</button>
        </div>`;
}

/**
 * @param {object} row
 * @param {string[]} urlsSlice
 * @param {number} globalStart0 — 전체 사진 기준 0부터 시작 인덱스
 * @param {number} nTotal
 * @param {{ omitPerCellIndex?: boolean }} [cellOpts] — 가로 스트립+프레임 뱃지 쓸 때 셀 우상단 i/N 생략
 */
function buildHorizontalPhotoCellsHtml(row, urlsSlice, globalStart0, nTotal, withMenuBar = true, cellOpts = null) {
    const menuBar = withMenuBar ? buildMenuBarBelowPhotoHtml(row) : '';
    const omitPerCell = Boolean(cellOpts?.omitPerCellIndex);
    const aspectCss = getViewerAspectRatioCss(row);
    return urlsSlice
        .map((url, i) => {
            const globalIdx = globalStart0 + i;
            const onImg = omitPerCell ? '' : buildPhotoIndexOnImageHtml(globalIdx + 1, nTotal);
            const enc = escapeHtml(String(url));
            return `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-stretch justify-center p-1 box-border">
                    <div class="flex max-h-full min-h-0 w-full max-w-full flex-col items-stretch">
                        <div class="flex min-h-0 w-full min-w-0 flex-1 items-end justify-center">
                            <div class="timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden rounded-lg bg-black/25 shadow-lg" style="aspect-ratio: ${aspectCss}; max-height: min(72vh, 520px);">
                                <img src="${MEAL_PHOTO_SRC_PENDING}" data-meal-src="${enc}" alt="" class="timeline-meal-photo-img absolute inset-0 z-0 h-full w-full object-cover object-center select-none" draggable="false" decoding="async" />
                                ${onImg}
                            </div>
                        </div>
                        ${menuBar}
                    </div>
                </div>`;
        })
        .join('');
}

/** 모먼트: 상단 오른쪽 ⋮ — `overlayFeedOptions` 있을 때만(absolute 아님, 크롬 행에 배치) */
function buildMealPhotoMeatballBtnHtml(row) {
    const fo = row.overlayFeedOptions;
    if (!fo) return '';
    const attr = ` data-meal-feed-options="${encodeURIComponent(JSON.stringify(fo))}"`;
    return `<button type="button" class="timeline-meal-photo-meatball-btn timeline-meal-photo-moment-social-btn pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0"${attr} data-meal-photo-meatball="1" onclick="event.stopPropagation();window._openMealOverlayFeedOptions&&window._openMealOverlayFeedOptions(this)" aria-label="더보기" aria-haspopup="true"><i class="fa-solid fa-ellipsis-vertical timeline-meal-photo-meatball-icon text-white/95" aria-hidden="true"></i></button>`;
}

/** 사진 하단 우측(구 미트볼자리)에 소셜 3개 앵커 — 프로필·게시가 있을 때만 */
function buildMealPhotoSocialBarCornerHtml(row) {
    const postId = row.overlayPostId;
    const a = row.overlayAuthor;
    if (!postId || !a) return '';
    return `<div class="pointer-events-auto absolute z-[11] flex items-center" data-meal-photo-social-bubble><div class="timeline-meal-photo-moment-social-row flex shrink-0 items-center">${buildMealPhotoOverlaySocialButtonsHtml(postId)}</div></div>`;
}

/** 휠: 사진 좌하단「comment」— 하단 기록 코멘트 박스 표시 토글(기본 off·반전) */
function buildMealPhotoCommentToggleBtnHtml() {
    return `<button type="button" class="timeline-meal-photo-comment-toggle pointer-events-auto absolute z-[11] rounded-md px-2 py-1 text-[10px] font-bold uppercase leading-none tracking-wide transition-colors timeline-meal-photo-comment-toggle--off" data-meal-photo-comment-toggle aria-pressed="false" aria-label="기록 코멘트 보기">comment</button>`;
}

/** 한 번에 한 장만 보이는 캐러셀(프레임 + 펼침 칩) — 라벨은 `buildVSlideHtml`에서 프레임 아래에 둠 */
function buildCarouselZoneHtml(row, opts = {}) {
    const wheelViewport = Boolean(opts.wheelViewport);
    const urls = row.urls || [];
    if (!urls.length) return '';
    const nShown = urls.length;
    const nTotal = Array.isArray(row.allUrls) && row.allUrls.length > nShown ? row.allUrls.length : nShown;
    const hidden = nTotal - nShown;
    const badgeHidden = nTotal <= 1 ? ' hidden' : '';
    const expand = !wheelViewport && hidden > 0 ? buildPhotoExpandChipHtml(row, hidden) : '';
    const expandMini =
        wheelViewport && hidden > 0
            ? `<button type="button" class="timeline-meal-photo-expand timeline-meal-photo-expand--wheel-chip pointer-events-auto absolute bottom-1 left-1/2 z-[4] -translate-x-1/2 cursor-pointer rounded-full border border-white/25 bg-black/65 px-2 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm hover:bg-black/80" data-expand-date="${escapeHtml(row.dateStr)}" data-expand-slot="${escapeHtml(row.slotId)}" data-expand-record="${escapeHtml(row.recordId || '')}" aria-label="사진 ${hidden}장 더 보기">+${hidden}장</button>`
            : '';
    const cellsHtml = buildHorizontalPhotoCellsHtml(row, urls, 0, nTotal, false, { omitPerCellIndex: true });
    const momentChrome = buildMomentOverlayChromeHtml(row);
    const socialBarHtml = buildMealPhotoSocialBarCornerHtml(row);
    const commentToggleHtml = wheelViewport ? buildMealPhotoCommentToggleBtnHtml() : '';
    const badgeInner =
        nTotal > 1
            ? `<span data-carousel-badge-cur class="carousel-badge-num leading-none">1</span><span class="carousel-badge-sep leading-none" aria-hidden="true">/</span><span data-carousel-badge-tot class="carousel-badge-num leading-none">${nTotal}</span>`
            : '';
    return `<div class="timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
            <div class="timeline-meal-photos-carousel-frame relative flex min-h-0 w-full min-w-0 flex-1 flex-col items-stretch justify-center p-1" data-photo-index="0" tabindex="0" role="region" aria-roledescription="carousel" aria-label="기록 사진">
                <div class="timeline-meal-photos-carousel-viewport relative min-h-0 w-full min-w-0 flex-1">
                    <div class="timeline-meal-photos-hstrip scrollbar-hide flex min-h-0 h-full w-full min-w-0 select-none flex-row overflow-x-auto overflow-y-hidden overscroll-x-contain snap-x snap-mandatory" style="-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;scroll-snap-type:x mandatory" tabindex="-1">
                        ${cellsHtml}
                    </div>
                    ${momentChrome}
                    ${socialBarHtml}
                    ${commentToggleHtml}
                    <div class="timeline-meal-photos-carousel-badge pointer-events-none absolute z-10 flex items-baseline gap-0 rounded-md border-0 bg-black/35 px-2 py-1 tabular-nums leading-none text-white/95 shadow-sm backdrop-blur-sm${badgeHidden}" data-carousel-badge>${badgeInner}</div>
                </div>
                ${expandMini}
            </div>
            ${expand}
        </div>`;
}

function buildCarouselTrackHtml(row, withInlineMenuBar) {
    const zone = buildCarouselZoneHtml(row);
    const inlineBar = withInlineMenuBar ? buildMenuBarBelowPhotoHtml(row) : '';
    return `${zone}${inlineBar}`;
}

function buildPhotoExpandChipHtml(row, hiddenCount) {
    if (hiddenCount <= 0) return '';
    return `<div class="timeline-meal-photo-cell timeline-meal-photo-expand flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always cursor-pointer flex-col items-center justify-center border border-dashed border-white/30 bg-white/5 p-4 box-border" role="button" tabindex="0" data-expand-date="${escapeHtml(row.dateStr)}" data-expand-slot="${escapeHtml(row.slotId)}" data-expand-record="${escapeHtml(row.recordId || '')}" aria-label="사진 ${hiddenCount}장 더 보기">
            <span class="text-center text-sm font-bold leading-snug text-white">+${hiddenCount}장<br /><span class="text-xs font-semibold text-white/80">탭하여 펼치기</span></span>
        </div>`;
}

function findMealPhotoRowState(el, dateStr, slotId, recordId) {
    const rid = recordId == null || recordId === '' ? null : String(recordId);
    return (
        el._mealPhotoRows?.find((row) => {
            const rowRid = row.recordId == null || row.recordId === '' ? null : String(row.recordId);
            return row.dateStr === dateStr && row.slotId === slotId && rowRid === rid;
        }) || null
    );
}


/** 사진 너비(컬럼)에 맞춘 하단 메뉴 바 — 폰트·크기는 `.timeline-meal-photo-menu-bar`(style.css) */
function buildMenuBarBelowPhotoHtml(row) {
    const line = buildBottomCaption(row);
    return `<div class="timeline-meal-photo-menu-bar pointer-events-none mt-0.5 w-full shrink-0 self-stretch rounded-md bg-black/50 px-1.5 py-1 text-left text-white">${line}</div>`;
}

/** 휠 모드: 스테이지 하단 고정 라벨(날짜·슬롯 | 메뉴@장소) — DOM은 오버레이에 한 번만 두고 `syncMealPhotoWheelFromVtrack`로 갱신 */
function buildMealPhotoGlobalCaptionFooterHtml() {
    return `<div class="timeline-meal-photos-caption-footer hidden w-full shrink-0 flex flex-col justify-center gap-px px-0.5">
            <div class="timeline-meal-photos-slide-caption-inner flex w-full max-w-full min-w-0 items-center rounded-md border border-white/10 bg-black/50 text-white timeline-meal-photo-menu-bar">
            <div class="timeline-meal-photos-wheelbar-inner flex min-w-0 shrink-0 items-center gap-0">
                <div class="meal-photo-wheel-col meal-photo-wheel-col--year flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="year" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--month flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="month" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--day flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="day" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--weekday flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--label meal-photo-wheel-viewport--weekday">
                        <div class="meal-photo-wheel-label-strip" data-wheel-label-strip="weekday">
                            <span class="meal-photo-wheel-label-line">—</span>
                        </div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--slot flex min-w-0 shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--label meal-photo-wheel-viewport--slot">
                        <div class="meal-photo-wheel-label-strip" data-wheel-label-strip="slot">
                            <span class="meal-photo-wheel-label-line">—</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="pointer-events-none min-w-0 flex-1 basis-0 text-right" data-wheel-menu-caption></div>
            </div>
            <div class="timeline-meal-photos-overlay-comment-band pointer-events-none hidden block w-full min-w-0 rounded-none border border-white/10 bg-black/45 px-1.5 py-1.5 text-left text-white backdrop-blur-sm" data-meal-overlay-comment-band>
                <div class="timeline-meal-photos-overlay-comment-body min-w-0" data-meal-overlay-comment-body></div>
            </div>
        </div>`;
}

/** 사진 없음: 흰 영역 + 플러스(스킵만 금지 아이콘) */
function placeholderIconClass(row) {
    if (row.mealType === 'Skip') return 'fa-solid fa-ban text-5xl text-slate-500';
    return 'fa-solid fa-plus text-5xl text-slate-400';
}

function buildHorizontalSlidesHtml(row, withMenuBar = true) {
    const urls = row.urls || [];
    if (!urls.length) return '';
    return buildCarouselTrackHtml(row, withMenuBar);
}

function buildPlaceholderSlideHtml(row) {
    const ic = placeholderIconClass(row);
    const menuBar = buildMenuBarBelowPhotoHtml(row);
    return `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-stretch justify-center p-1 box-border">
        <div class="flex max-h-full min-h-0 w-full max-w-full flex-col items-stretch">
            <div class="relative flex min-h-[min(280px,55vh)] w-full min-w-0 max-h-[55vh] flex-1 flex-col items-stretch justify-center overflow-hidden rounded-lg bg-white px-4 py-8">
                <div class="flex w-full flex-1 items-center justify-center">
                    <i class="${escapeHtml(ic)} relative z-0" aria-hidden="true"></i><span class="sr-only">사진 없음</span>
                </div>
            </div>
            ${menuBar}
        </div>
    </div>`;
}

function buildHorizontalSlidesLegacyHtml(urls) {
    const ar = appState?.recordPhotoAspectRatio;
    const photoAspectRatio = ar === '3:4' || ar === '4:3' ? ar : '1:1';
    const row = {
        urls,
        photoAspectRatio,
        dateStr: '',
        slotId: '',
        recordId: null,
        slotTitle: '',
        menuLine: '',
        place: '',
        isEmptyRow: false
    };
    return buildCarouselTrackHtml(row, false);
}

function buildVSlideHtml(row, withInlineMenuBar = true) {
    const nPhotos = Array.isArray(row.urls) ? row.urls.length : 0;
    if (!withInlineMenuBar) {
        const innerPhoto = nPhotos > 0 ? buildCarouselZoneHtml(row, { wheelViewport: true }) : buildPlaceholderSlideHtml(row);
        return `<section class="timeline-meal-photos-vslide timeline-meal-photos-vslide--photo-only flex h-full min-h-full w-full shrink-0 snap-center snap-always flex-col overflow-hidden border-b border-white/10 last:border-b-0" data-date-str="${escapeHtml(row.dateStr)}" data-slot-id="${escapeHtml(row.slotId)}" data-record-id="${escapeHtml(row.recordId || '')}" data-slot-title="${escapeHtml(String(row.slotTitle || ''))}">
            <div class="timeline-meal-photos-vslide-stage timeline-meal-photos-vslide-stage--wheel-only relative flex min-h-full w-full min-w-0 flex-1 flex-col items-center justify-center p-1">${innerPhoto}</div>
        </section>`;
    }
    const innerTrack = nPhotos > 0 ? buildHorizontalSlidesHtml(row, withInlineMenuBar) : buildPlaceholderSlideHtml(row);
    const sectionClass =
        'timeline-meal-photos-vslide flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden border-b border-white/10 last:border-b-0';
    const stageClass = 'timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col';
    const trackClass =
        'timeline-meal-photos-track timeline-meal-photos-track--carousel scrollbar-hide flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col items-stretch overflow-hidden';
    return `<section class="${sectionClass}" data-date-str="${escapeHtml(row.dateStr)}" data-slot-id="${escapeHtml(row.slotId)}" data-record-id="${escapeHtml(row.recordId || '')}" data-slot-title="${escapeHtml(String(row.slotTitle || ''))}">
        <div class="${stageClass}">
            <div class="${trackClass}" style="-webkit-overflow-scrolling:touch">${innerTrack}</div>
        </div>
    </section>`;
}

function getCarouselRowForSlide(slide, el) {
    if (!slide || !el) return null;
    if (slide.getAttribute('data-legacy-carousel') === '1') {
        const r = el._mealPhotoRows?.[0];
        return r?.isLegacy ? r : null;
    }
    const vtrack = el._mealPhotosVTrack;
    const slides = vtrack?.querySelectorAll?.('.timeline-meal-photos-vslide');
    const slideIndex = slides && slide ? Array.prototype.indexOf.call(slides, slide) : -1;
    const rows = el._mealPhotoRows;
    /* vtrack 안 슬라이드 순서와 _mealPhotoRows 인덱스는 동일 — date/slot 누락·불일치 시에도 overlayPostId 등 행 조회 */
    if (slideIndex >= 0 && Array.isArray(rows) && slideIndex < rows.length && rows[slideIndex]) {
        return rows[slideIndex];
    }
    const ds = slide.getAttribute('data-date-str');
    const sid = slide.getAttribute('data-slot-id');
    const ra = slide.getAttribute('data-record-id');
    /* 모먼트 공유 등: date/slot이 비어도 휠 모드는 행이 1개뿐이면 _mealPhotoRows[0]이 해당 슬라이드 */
    if ((!ds || !sid) && rows?.length === 1 && slide.classList.contains('timeline-meal-photos-vslide--photo-only')) {
        const only = rows[0];
        if (only?.urls?.length) return only;
    }
    if (!ds || !sid) return null;
    return findMealPhotoRowState(el, ds, sid, ra);
}

/** 휠 라벨 등: 현재 `data-photo-index`에 해당하는 `<img>` (가로 스트립은 해당 셀) */
function getCarouselPrimaryImageFromFrame(frame) {
    if (!frame) return null;
    const cells = frame.querySelectorAll('.timeline-meal-photo-cell');
    const maxI = Math.max(0, cells.length - 1);
    let pi = Math.floor(Number(frame.dataset.photoIndex || 0));
    if (!Number.isFinite(pi)) pi = 0;
    pi = Math.min(maxI, Math.max(0, pi));
    if (cells.length) {
        return cells[pi]?.querySelector('img.timeline-meal-photo-img') || null;
    }
    return frame.querySelector('img.timeline-meal-photo-img');
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fade] — `false`이면 페이드 없이 즉시 교체(인접 세로 슬라이드 프리하이드용). 생략 시 기존 규칙(가로 넘김 등).
 */
function applyMealPhotoImgSrc(img, u, opts = {}) {
    if (!img || !u) return;
    if (img.dataset.mealSrcApplied === u) return;
    const prev = img.dataset.mealSrcApplied;
    const allowFade =
        opts.fade !== false &&
        Boolean(prev) &&
        prev !== u &&
        typeof window.matchMedia === 'function' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    delete img.dataset.mealSrcApplied;
    const applySrcAndFadeIn = () => {
        img.removeAttribute('src');
        img.src = MEAL_PHOTO_SRC_PENDING;
        img.src = u;
        img.dataset.mealSrcApplied = u;
        if (allowFade) {
            const show = () => {
                img.style.opacity = '1';
            };
            if (img.complete && (img.naturalHeight || 0) > 0) {
                requestAnimationFrame(() => requestAnimationFrame(show));
            } else {
                img.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(show)), {
                    once: true
                });
                img.addEventListener('error', () => requestAnimationFrame(() => requestAnimationFrame(show)), {
                    once: true
                });
            }
        } else {
            img.style.opacity = '';
        }
    };
    if (allowFade) {
        img.style.opacity = '0';
        requestAnimationFrame(() => {
            requestAnimationFrame(applySrcAndFadeIn);
        });
    } else {
        applySrcAndFadeIn();
    }
}

function updateCarouselBadge(frame, row, idx, urls) {
    const nTotal = Array.isArray(row.allUrls) && row.allUrls.length > urls.length ? row.allUrls.length : urls.length;
    const badge = frame.querySelector('[data-carousel-badge]');
    if (!badge) return;
    const curEl = badge.querySelector('[data-carousel-badge-cur]');
    const totEl = badge.querySelector('[data-carousel-badge-tot]');
    if (nTotal > 1) {
        if (curEl) curEl.textContent = String(idx + 1);
        if (totEl) totEl.textContent = String(nTotal);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
    scheduleCarouselBadgeAnchor(frame);
}

/**
 * 캐러셀에서 활성 셀의 사진(슬롯/img)·뷰포트 getBoundingClientRect
 * @returns {{ ir: DOMRect, vr: DOMRect, viewport: Element, hstrip: Element } | null}
 */
function getMealPhotoCarouselImageAndViewportRects(frame) {
    const viewport = frame?.querySelector?.('.timeline-meal-photos-carousel-viewport');
    const hstrip = frame?.querySelector?.('.timeline-meal-photos-hstrip');
    if (!viewport || !hstrip) return null;
    const nCell = hstrip.querySelectorAll('.timeline-meal-photo-cell').length;
    let idx = Math.floor(Number(frame?.dataset?.photoIndex || 0));
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.min(Math.max(0, nCell - 1), idx);
    const cell = hstrip.querySelectorAll('.timeline-meal-photo-cell')[idx];
    const slot = cell?.querySelector?.('.timeline-meal-photo-aspect-slot');
    const img = cell?.querySelector?.('img.timeline-meal-photo-img');
    const irSlot = slot ? slot.getBoundingClientRect() : null;
    const irImg = img ? img.getBoundingClientRect() : null;
    const slotOk = irSlot && irSlot.width > 2 && irSlot.height > 2;
    const imgOk = irImg && irImg.width > 2 && irImg.height > 2;
    /** `object-contain` 등으로 비트맵이 슬롯보다 작을 때 — 실제 보이는 사진 기준 */
    let ir;
    if (imgOk && slotOk) {
        const wDiff = irSlot.width - irImg.width;
        const hDiff = irSlot.height - irImg.height;
        ir = wDiff > 1 || hDiff > 1 ? irImg : irSlot;
    } else if (imgOk) ir = irImg;
    else if (slotOk) ir = irSlot;
    else return null;
    const vr = viewport.getBoundingClientRect();
    if (ir.width < 4 || ir.height < 4) return null;
    return { ir, vr, viewport, hstrip, img, slot };
}

/**
 * 사진 하단 `comment` / 페이지(뱃지) / 소셜 — 세로 중심을 한 줄에 맞춤.
 * 소셜이 있으면 그 박스 중심, 없으면 `anchorMealPhotoSocialBar`와 동일 lane(이미지 하단 근처) — 뷰~이미지 띠 **중앙**은 쓰지 않음(레터박스 밖으로 떨어짐).
 */
function syncMealPhotoBottomOverlayRowCenters(frame) {
    const ctx = getMealPhotoCarouselImageAndViewportRects(frame);
    if (!ctx) return;
    const { ir, vr } = ctx;
    const social = frame?.querySelector?.('[data-meal-photo-social-bubble]');
    const badge = frame?.querySelector?.('[data-carousel-badge]');
    const comment = frame?.querySelector?.('[data-meal-photo-comment-toggle]');

    let cY;
    if (social) {
        const r = social.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) cY = r.top + r.height / 2;
    }
    if (cY == null) {
        const laneInset = 1;
        const pickH = (el) =>
            el && !el.classList?.contains('hidden') && el.getBoundingClientRect().height > 0.4
                ? el.getBoundingClientRect().height
                : 0;
        const hRow = Math.max(pickH(badge), pickH(comment), 28);
        cY = ir.bottom - laneInset - hRow * 0.5;
    }

    const applyBottom = (el) => {
        if (!el) return;
        if (el.classList?.contains('hidden')) return;
        const h = el.getBoundingClientRect().height;
        if (h < 0.5) return;
        const b = Math.max(0, Math.round(vr.bottom - cY - h * 0.5));
        el.style.bottom = `${b}px`;
    };
    applyBottom(social);
    applyBottom(badge);
    applyBottom(comment);
}

/** 활성 사진 `<img>`의 우상단에 맞춤 — 뷰포트 모서리가 아니라 실제 이미지 영역 안에 두기 */
function anchorCarouselBadgeToActivePhoto(frame) {
    const badge = frame?.querySelector?.('[data-carousel-badge]');
    if (!badge) return;
    const ctx = getMealPhotoCarouselImageAndViewportRects(frame);
    if (badge.classList.contains('hidden')) {
        badge.style.removeProperty('top');
        badge.style.removeProperty('right');
        badge.style.removeProperty('left');
        badge.style.removeProperty('bottom');
        badge.style.removeProperty('transform');
        return;
    }
    if (!ctx) return;
    const { ir, vr } = ctx;
    const inset = 4;
    const bottom = vr.bottom - ir.bottom + inset;
    const cx = (ir.left + ir.right) / 2 - vr.left;
    badge.style.position = 'absolute';
    badge.style.top = 'auto';
    badge.style.right = 'auto';
    badge.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    badge.style.left = `${Math.round(cx)}px`;
    badge.style.transform = 'translateX(-50%)';
}

function scheduleCarouselBadgeAnchor(frame) {
    if (!frame) return;
    if (frame._mealPhotoBadgeAnchorRaf != null) cancelAnimationFrame(frame._mealPhotoBadgeAnchorRaf);
    frame._mealPhotoBadgeAnchorRaf = requestAnimationFrame(() => {
        frame._mealPhotoBadgeAnchorRaf = null;
        anchorCarouselBadgeToActivePhoto(frame);
        anchorMealPhotoSocialBarToActivePhoto(frame);
        anchorMealPhotoCommentToggleToActivePhoto(frame);
        syncMealPhotoBottomOverlayRowCenters(frame);
    });
}

/** 사진 하단 소셜 랩(구 미트볼 위치)을 활성 슬롯 사각형에 맞춤 — 뱃지·동일 앵커(세로는 `syncMealPhotoBottomOverlayRowCenters`) */
function anchorMealPhotoSocialBarToActivePhoto(frame) {
    const btn = frame?.querySelector?.('[data-meal-photo-social-bubble]');
    const ctx = getMealPhotoCarouselImageAndViewportRects(frame);
    if (!btn || !ctx) return;
    const { ir, vr } = ctx;
    /* 뱃지보다 약간 더 붙임 (페이지 표시·하단거리 1/2) */
    const inset = 1;
    const bottom = vr.bottom - ir.bottom + inset;
    const right = vr.right - ir.right + inset;
    btn.style.position = 'absolute';
    btn.style.top = 'auto';
    btn.style.left = 'auto';
    btn.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    btn.style.right = `${Math.max(0, Math.round(right))}px`;
    btn.style.transform = 'none';
}

/** 휠: 좌하단 comment 토글 — 가로만(세로는 `syncMealPhotoBottomOverlayRowCenters`가 소셜·뱃지와 맞춤) */
function anchorMealPhotoCommentToggleToActivePhoto(frame) {
    const btn = frame?.querySelector?.('[data-meal-photo-comment-toggle]');
    const ctx = getMealPhotoCarouselImageAndViewportRects(frame);
    if (!btn || !ctx) return;
    const { ir, vr } = ctx;
    const cornerPadX = 10;
    const inset = 1;
    const left = ir.left - vr.left + inset + cornerPadX;
    btn.style.position = 'absolute';
    btn.style.top = 'auto';
    btn.style.right = 'auto';
    const bottom = vr.bottom - ir.bottom + inset; /* `sync`가 세로 정렬로 덮어씀 */
    btn.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    btn.style.left = `${Math.max(0, Math.round(left))}px`;
    btn.style.transform = 'none';
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fade] — `false`이면 페이드 없이 즉시 교체(인접 세로 슬라이드 프리하이드용). 생략 시 기존 규칙(가로 넘김 등).
 * @param {boolean} [opts.skipHstripScroll] — `true`이면 가로 스크롤 위치는 건드리지 않고 이미지·뱃지만 갱신(활성 슬라이드 하이드레이트 시 smooth와 충돌 방지).
 * @param {boolean} [opts.hstripSmooth] — 가로 스크롤을 `smooth`로(화살표 등). `skipHstripScroll`이면 무시.
 */
function applyCarouselIndex(slide, el, newIdx, opts = {}) {
    const row = getCarouselRowForSlide(slide, el);
    const urls = row?.urls;
    if (!row || !Array.isArray(urls) || !urls.length) return;
    const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
    if (!frame) return;
    const n = urls.length;
    let idx = Math.floor(Number(newIdx));
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.min(n - 1, Math.max(0, idx));
    frame.dataset.photoIndex = String(idx);
    const hstrip = frame.querySelector('.timeline-meal-photos-hstrip');
    if (hstrip) {
        const skipScroll = opts.skipHstripScroll === true;
        const prefersReduce =
            typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const useSmooth = !skipScroll && opts.hstripSmooth === true && !prefersReduce;
        if (!skipScroll) {
            const scrollHstripToIndex = () => {
                const w = hstrip.clientWidth;
                if (w <= 0) return false;
                hstrip.scrollTo({ left: idx * w, behavior: useSmooth ? 'smooth' : 'auto' });
                return true;
            };
            if (!scrollHstripToIndex()) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(scrollHstripToIndex);
                });
            }
        }
        const cells = hstrip.querySelectorAll('.timeline-meal-photo-cell');
        for (const j of [idx - 1, idx, idx + 1]) {
            if (j < 0 || j >= n) continue;
            const img = cells[j]?.querySelector('img.timeline-meal-photo-img');
            if (img) applyMealPhotoImgSrc(img, urls[j], opts);
        }
        updateCarouselBadge(frame, row, idx, urls);
        return;
    }
    const u = urls[idx];
    const img = frame.querySelector('img.timeline-meal-photo-img');
    if (img && u) applyMealPhotoImgSrc(img, u, opts);
    updateCarouselBadge(frame, row, idx, urls);
}

function stepCarouselPhoto(el, delta) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const slide = slides[si];
    const frame = slide?.querySelector('.timeline-meal-photos-carousel-frame');
    if (!frame) return;
    const cur = Number(frame.dataset.photoIndex || 0);
    const prefersReduce =
        typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    applyCarouselIndex(slide, el, cur + delta, { fade: false, hstripSmooth: !prefersReduce });
    if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
        clearTimeout(el._mealPhotoWheelLabelTimer);
        el._mealPhotoWheelLabelTimer = null;
        runMealPhotoWheelLabelLayoutWhenReady(el);
    }
    try {
        el._mealPhotoWheelSuppressLabelSchedule = Boolean(el.classList.contains('timeline-meal-photos-overlay--wheel'));
        el._mealPhotosSync?.();
    } finally {
        el._mealPhotoWheelSuppressLabelSchedule = false;
    }
}

/** 스냅 지점 근처에서만 인덱스 동기화 — 프로그램 smooth 스크롤 중간에 뱃지가 뒤집히지 않게 함 */
function mealPhotoHstripScrollSettled(hstrip, w) {
    const sl = hstrip.scrollLeft;
    const nearest = Math.round(sl / w);
    const tol = Math.max(8, Math.min(28, Math.floor(w * 0.035)));
    return Math.abs(sl - nearest * w) <= tol;
}

/** 가로 다장: `snap-x` 스트립 스크롤과 `data-photo-index`·뱃지·이웃 이미지 동기화 */
function syncMealPhotoHstripIndexFromScroll(hstrip, frame, slide, el) {
    const row = getCarouselRowForSlide(slide, el);
    const urls = row?.urls;
    if (!row || !Array.isArray(urls) || !urls.length) return;
    const w = hstrip.clientWidth;
    if (w <= 0) return;
    if (!mealPhotoHstripScrollSettled(hstrip, w)) return;
    let idx = Math.round(hstrip.scrollLeft / w);
    idx = Math.min(urls.length - 1, Math.max(0, idx));
    const prev = Number(frame.dataset.photoIndex || 0);
    if (idx === prev) return;
    frame.dataset.photoIndex = String(idx);
    updateCarouselBadge(frame, row, idx, urls);
    const cells = hstrip.querySelectorAll('.timeline-meal-photo-cell');
    for (const j of [idx - 1, idx, idx + 1]) {
        if (j < 0 || j >= urls.length) continue;
        const img = cells[j]?.querySelector('img.timeline-meal-photo-img');
        if (img) applyMealPhotoImgSrc(img, urls[j], { fade: false });
    }
    preloadAdjacentMealPhotos(el);
    if (el.classList.contains('timeline-meal-photos-overlay--wheel') && !el._mealPhotoWheelSuppressLabelSchedule) {
        scheduleMealPhotoWheelLabelLayout(el);
    }
}

/**
 * 다장: 가로 `snap-x` 스트립 + 마우스 드래그로 `scrollLeft` 조절(세로 vtrack과 동일한 조작감).
 * 터치: 캐러셀은 `touch-action: pan-x pan-y`로 가로 스냅 + 세로는 부모 vtrack(게시물 간)으로 전달.
 */
function bindCarouselSwipe(zone, el) {
    if (!zone || zone._mealCarouselBound) return;
    const slide = zone.closest('.timeline-meal-photos-vslide');
    const viewport = zone.querySelector('.timeline-meal-photos-carousel-viewport');
    const hstrip = zone.querySelector('.timeline-meal-photos-hstrip');
    const frame = zone.querySelector('.timeline-meal-photos-carousel-frame');
    const cellCount = zone.querySelectorAll('.timeline-meal-photo-cell:not(.timeline-meal-photo-expand)').length;
    let row = slide && getCarouselRowForSlide(slide, el);
    if (!row && cellCount > 1 && el._mealPhotoRows?.length === 1) {
        row = el._mealPhotoRows[0];
    }
    const nPhotos = Math.max(row?.urls?.length || 0, cellCount);
    if (!hstrip || !viewport || !frame || !slide || !row || nPhotos <= 1) return;
    zone._mealCarouselBound = true;

    if (!frame._mealPhotoBadgeRO) {
        frame._mealPhotoBadgeRO = new ResizeObserver(() => scheduleCarouselBadgeAnchor(frame));
        frame._mealPhotoBadgeRO.observe(viewport);
        frame._mealPhotoBadgeRO.observe(hstrip);
    }
    scheduleCarouselBadgeAnchor(frame);

    let scrollRaf = null;
    const onHScroll = () => {
        if (scrollRaf != null) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = null;
            syncMealPhotoHstripIndexFromScroll(hstrip, frame, slide, el);
            scheduleCarouselBadgeAnchor(frame);
        });
    };
    hstrip.addEventListener('scroll', onHScroll, { passive: true });

    const onWheelHstrip = (e) => {
        const { dx, dy } = normalizeWheelDeltaPx(e);
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        let handled = false;
        if (absX > 0 && absX >= absY) {
            hstrip.scrollLeft += dx;
            handled = true;
        } else if (e.shiftKey && absY > 0) {
            hstrip.scrollLeft += dy;
            handled = true;
        }
        if (handled) e.preventDefault();
    };
    hstrip.addEventListener('wheel', onWheelHstrip, { passive: false });

    /** 마우스/펜: pointerdown 직후 가로 캡처하지 않고 임계값으로 세로(vtrack)·가로(hstrip) 분기 */
    const CAROUSEL_AXIS_LOCK_PX = 10;
    const snapHstripAfterDrag = () => {
        const w = hstrip.clientWidth;
        const n = Math.max(row.urls.length || 0, cellCount || 0);
        if (w <= 0 || n <= 0) return;
        const prefersReduce =
            typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const snapIdx = Math.min(n - 1, Math.max(0, Math.round(hstrip.scrollLeft / w)));
        hstrip.scrollTo({ left: snapIdx * w, behavior: prefersReduce ? 'auto' : 'smooth' });
        frame.dataset.photoIndex = String(snapIdx);
        updateCarouselBadge(frame, row, snapIdx, row.urls);
        const cells = hstrip.querySelectorAll('.timeline-meal-photo-cell');
        for (const j of [snapIdx - 1, snapIdx, snapIdx + 1]) {
            if (j < 0 || j >= n) continue;
            const img = cells[j]?.querySelector('img.timeline-meal-photo-img');
            if (img) applyMealPhotoImgSrc(img, row.urls[j], { fade: false });
        }
        preloadAdjacentMealPhotos(el);
        if (el.classList.contains('timeline-meal-photos-overlay--wheel') && !el._mealPhotoWheelSuppressLabelSchedule) {
            scheduleMealPhotoWheelLabelLayout(el);
        }
    };
    const onHMoveFromEl = (e) => {
        const hd = el._mealCarouselHStripDrag;
        if (!hd || e.pointerId !== hd.pointerId) return;
        const dx = e.clientX - hd.lastX;
        hd.lastX = e.clientX;
        hd.hstrip.scrollLeft -= dx;
        e.preventDefault();
    };

    const endHStripDrag = (e) => {
        const hd = el._mealCarouselHStripDrag;
        if (!hd || (e && e.pointerId !== hd.pointerId)) return;
        const pid = hd.pointerId;
        const { hstrip: hs, frame: fr } = hd;
        el._mealCarouselHStripDrag = null;
        removeMealPhotoCarouselDocumentPointerListeners(el);
        try {
            hs.releasePointerCapture(pid);
        } catch (_) {
            /* ignore */
        }
        hs.classList.remove('cursor-grabbing');
        fr.classList.remove('cursor-grabbing');
        snapHstripAfterDrag();
    };

    const onCarouselOrHPointerMove = (e) => {
        const g = el._mealCarouselAxisGesture;
        if (!g || e.pointerId !== g.pointerId) {
            if (el._mealCarouselHStripDrag && e.pointerId === el._mealCarouselHStripDrag.pointerId) {
                onHMoveFromEl(e);
            }
            return;
        }
        const vtrack = el._mealPhotosVTrack;
        if (g.phase === 'pending') {
            const rdx = e.clientX - g.x0;
            const rdy = e.clientY - g.y0;
            if (Math.max(Math.abs(rdx), Math.abs(rdy)) < CAROUSEL_AXIS_LOCK_PX) return;
            if (Math.abs(rdy) >= Math.abs(rdx)) {
                g.phase = 'v';
                g.lastY = e.clientY;
                if (vtrack) e.preventDefault();
                return;
            }
            el._mealCarouselAxisGesture = null;
            el._mealCarouselHStripDrag = {
                pointerId: g.pointerId,
                lastX: e.clientX,
                hstrip,
                frame
            };
            hstrip.classList.add('cursor-grabbing');
            frame.classList.add('cursor-grabbing');
            try {
                hstrip.setPointerCapture(g.pointerId);
            } catch (_) {
                /* ignore */
            }
            onHMoveFromEl(e);
            return;
        }
        if (g.phase === 'v') {
            if (!vtrack) return;
            const ddy = e.clientY - g.lastY;
            g.lastY = e.clientY;
            vtrack.scrollTop += ddy;
            e.preventDefault();
        }
    };

    const onCarouselOrHPointerUp = (e) => {
        const g = el._mealCarouselAxisGesture;
        if (g && e.pointerId === g.pointerId) {
            removeMealPhotoCarouselDocumentPointerListeners(el);
            el._mealCarouselAxisGesture = null;
            if (g.phase === 'v' && el.classList.contains('timeline-meal-photos-overlay--wheel')) {
                scheduleMealPhotoWheelLabelLayout(el);
            }
        }
        if (el._mealCarouselHStripDrag && e.pointerId === el._mealCarouselHStripDrag.pointerId) {
            endHStripDrag(e);
        }
    };

    const attachCarouselAxisDoc = () => {
        if (el._mealCarouselDocAttached) return;
        el._mealCarouselDocAttached = true;
        el._mealCarouselDocMove = onCarouselOrHPointerMove;
        el._mealCarouselDocUp = onCarouselOrHPointerUp;
        document.addEventListener('pointermove', el._mealCarouselDocMove, MEAL_PHOTO_CAROUSEL_DOC_CAPTURE);
        document.addEventListener('pointerup', el._mealCarouselDocUp, true);
        document.addEventListener('pointercancel', el._mealCarouselDocUp, true);
    };

    const onHDown = (e) => {
        /* 터치: 네이티브 가로 스트립 + 세로는 vtrack. 마우스·펜은 축 잠금 후 가로/세로 */
        if (e.pointerType === 'touch') return;
        if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
        if (e.target.closest?.('.timeline-meal-photo-expand')) return;
        if (!frame.contains(e.target)) return;
        if (el._mealCarouselAxisGesture || el._mealCarouselHStripDrag || el._mealCarouselDocAttached) return;
        el._mealCarouselAxisGesture = {
            pointerId: e.pointerId,
            phase: 'pending',
            x0: e.clientX,
            y0: e.clientY,
            lastY: e.clientY
        };
        attachCarouselAxisDoc();
    };
    /* 버블: stopPropagation 없이 두어 vtrack(다장 시 세로 드래그는 제스처로만 처리) */
    frame.addEventListener('pointerdown', onHDown, false);
}

function getVTrackActiveIndex(vtrack) {
    if (!vtrack) return 0;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return 0;
    const t = vtrack.getBoundingClientRect();
    const midY = (t.top + t.bottom) / 2;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < slides.length; i++) {
        const r = slides[i].getBoundingClientRect();
        const c = (r.top + r.bottom) / 2;
        const d = Math.abs(c - midY);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

/** 세로 트랙에서 해당 슬라이드가 스크롤 맨 위에 오도록 하는 scrollTop 증분(뷰포트·레이아웃 기준) */
function scrollDeltaToAlignSlideTop(vtrack, slide) {
    if (!vtrack || !slide) return 0;
    return slide.getBoundingClientRect().top - vtrack.getBoundingClientRect().top;
}

/** 휠 모드: 슬라이드(한 기록) 세로 중심이 vtrack 뷰포트 세로 중심에 오도록 하는 scrollTop 증분 */
function scrollDeltaToCenterSlideInVtrack(vtrack, slide) {
    if (!vtrack || !slide) return 0;
    const vt = vtrack.getBoundingClientRect();
    const sr = slide.getBoundingClientRect();
    const vMid = (vt.top + vt.bottom) / 2;
    const sMid = (sr.top + sr.bottom) / 2;
    return sMid - vMid;
}

/** 활성 캐러셀 프레임 크기가 바뀔 때(이미지 디코드·object-fit 레이아웃 후) 라벨 재정렬 — 첫 팝업 겹침 방지 */
function bindMealPhotoWheelCaptionResizeObserver(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const prev = el._mealPhotoWheelCaptionRO;
    if (prev) {
        prev.disconnect();
        el._mealPhotoWheelCaptionRO = null;
    }
    const vtrack = el._mealPhotosVTrack;
    const frame = getActiveCarouselFrame(vtrack);
    if (!frame) return;
    let raf = null;
    const ro = new ResizeObserver(() => {
        if (raf != null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            raf = null;
            if (el.classList.contains('hidden')) return;
            positionMealPhotoWheelCaption(el);
            syncMealPhotoWheelCaptionPhotoMinWidth(el);
        });
    });
    ro.observe(frame);
    const cap = el.querySelector('.timeline-meal-photos-caption-footer');
    if (cap) ro.observe(cap);
    el._mealPhotoWheelCaptionRO = ro;
}

const MEAL_PHOTO_WHEEL_CAPTION_GAP_PX = 5;

/** 휠 모드: 사진+하단 라벨+코멘트 블록의 세로 중심이 스테이지(본문) 세로 중앙에 오도록 활성 슬라이드에 translateY 보정. 푸터는 활성 사진 아래 고정 간격. */
function positionMealPhotoWheelCaption(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const vtrack = el._mealPhotosVTrack;
    const cap = el.querySelector('.timeline-meal-photos-caption-footer');
    const stage = el.querySelector('.timeline-meal-photos-stage--with-footer');
    if (!vtrack || !cap || !stage || cap.classList.contains('hidden')) return;
    vtrack.querySelectorAll('.timeline-meal-photos-vslide-stage--wheel-only').forEach((st) => {
        st.style.transform = '';
    });
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const slide = slides[si];
    if (!slide) return;
    const activeWheelStage = slide.querySelector('.timeline-meal-photos-vslide-stage--wheel-only');
    const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');

    const placeFooterBelowPhoto = () => {
        const img = getCarouselPrimaryImageFromFrame(frame);
        const slot = frame?.querySelector?.('.timeline-meal-photo-aspect-slot');
        const s = stage.getBoundingClientRect();
        let bottom;
        if (slot) {
            bottom = slot.getBoundingClientRect().bottom;
        } else if (img) {
            bottom = img.getBoundingClientRect().bottom;
        } else {
            const fr = frame?.getBoundingClientRect();
            if (!fr) return false;
            bottom = fr.bottom;
        }
        const topPx = bottom - s.top + MEAL_PHOTO_WHEEL_CAPTION_GAP_PX;
        cap.style.position = 'absolute';
        cap.style.left = '0';
        cap.style.right = '0';
        cap.style.bottom = 'auto';
        cap.style.top = `${Math.round(Math.max(0, topPx))}px`;
        return true;
    };

    if (!placeFooterBelowPhoto()) return;
    /* 모먼트 피드(화면2): 사진·라벨 블록을 세로 가운데로 올리지 않음 — 사진은 상단, 라벨은 사진 실제 하단(높이에 따라) */
    if (el.classList.contains('timeline-meal-photos-overlay--moment-feed')) {
        if (activeWheelStage) activeWheelStage.style.transform = '';
        return;
    }
    const footerH = cap.getBoundingClientRect().height;
    const offset = (footerH + MEAL_PHOTO_WHEEL_CAPTION_GAP_PX) / 2;
    if (activeWheelStage && offset > 0.5) {
        activeWheelStage.style.transform = `translateY(${-Math.round(offset)}px)`;
    }
    placeFooterBelowPhoto();
}

/** 휠 모드: 본문 패딩 안쪽 콘텐츠 너비를 고정값으로 두고 하단 라벨·사진 열을 동일 너비로 맞춤 */
function syncMealPhotoWheelCaptionPhotoMinWidth(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const body = el.querySelector('.meal-photos-overlay-body');
    if (!body) return;
    const cs = getComputedStyle(body);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const br = body.getBoundingClientRect();
    const w = Math.max(40, Math.floor(br.width - pl - pr));
    el.style.setProperty('--meal-wheel-caption-inner-w', `${w}px`);
}

/** 휠 한 줄 높이 — 하단 라벨(메뉴@장소) 줄과 맞춤 */
const MEAL_PHOTO_WHEEL_ITEM_PX = 30;

function yearsRangeFromMealPhotoRows(rows) {
    let minY = 9999;
    let maxY = 0;
    for (const r of rows || []) {
        const m = /^(\d{4})-/.exec(String(r.dateStr || ''));
        if (!m) continue;
        const y = Number(m[1]);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    if (minY > maxY) {
        const y = new Date().getFullYear();
        return { minY: y, maxY: y };
    }
    return { minY, maxY };
}

/** 큰 값이 위·작은 값이 아래 — 세로 스와이프(더 과거로)와 숫자 릴 방향이 맞도록 */
function buildWheelItemsHtml(from, to, pad2) {
    const parts = [];
    for (let n = to; n >= from; n--) {
        const v = pad2 ? String(n).padStart(2, '0') : String(n);
        parts.push(
            `<div class="meal-photo-wheel-item flex h-[30px] w-full shrink-0 items-center justify-center tabular-nums leading-none text-white/90" data-val="${escapeHtml(v)}">${escapeHtml(v)}</div>`
        );
    }
    return parts.join('');
}

/** 휠 라벨: 슬롯명 공백 제거(예: 오전 간식1 → 오전간식1), 고정 폭 계산용 */
function compactMealWheelSlotTitle(s) {
    return String(s || '')
        .replace(/\s+/g, '')
        .trim() || '—';
}

function scrollWheelInnerToValue(inner, valStr, opts = {}) {
    if (!inner || valStr == null) return;
    const want = String(valStr);
    const items = inner.querySelectorAll('.meal-photo-wheel-item');
    let idx = -1;
    items.forEach((it, i) => {
        if (it.getAttribute('data-val') === want) idx = i;
    });
    if (idx < 0) return;
    const viewport = inner.closest('.meal-photo-wheel-viewport');
    const vpH = viewport?.clientHeight || MEAL_PHOTO_WHEEL_ITEM_PX;
    const itemH = MEAL_PHOTO_WHEEL_ITEM_PX;
    const ideal = idx * itemH - (vpH - itemH) / 2;
    const maxScroll = Math.max(0, inner.scrollHeight - vpH);
    const top = Math.max(0, Math.min(ideal, maxScroll));
    const smooth = Boolean(opts.smooth);
    if (smooth && typeof inner.scrollTo === 'function') {
        inner.scrollTo({ top, behavior: 'smooth' });
    } else {
        inner.scrollTop = top;
        requestAnimationFrame(() => {
            inner.scrollTop = top;
        });
    }
}

/** 요일·슬롯 릴: 한 줄 높이는 숫자 휠과 동일 */
const MEAL_WHEEL_LABEL_LINE_PX = MEAL_PHOTO_WHEEL_ITEM_PX;

function setWheelTextStripImmediate(strip, text) {
    if (!strip) return;
    const t = text == null ? '—' : String(text);
    strip.dataset.cur = t;
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    strip.innerHTML = `<span class="meal-photo-wheel-label-line">${escapeHtml(t)}</span>`;
}

/**
 * 세로 기록 이동: index 증가(아래로 더 스크롤) = 이전 값이 위로 밀리고 새 값이 아래에서 올라옴(`forward`)
 * @param {'forward'|'backward'} direction
 */
function animateWheelTextStrip(strip, newText, direction, shouldAnimate) {
    if (!strip) return;
    const t = newText == null ? '—' : String(newText);
    const old = strip.dataset.cur != null ? String(strip.dataset.cur) : '';
    if (strip._mealStripTid) {
        clearTimeout(strip._mealStripTid);
        strip._mealStripTid = null;
    }
    if (strip._mealStripOnEnd) {
        strip.removeEventListener('transitionend', strip._mealStripOnEnd);
        strip._mealStripOnEnd = null;
    }
    if (!shouldAnimate || old === t) {
        setWheelTextStripImmediate(strip, t);
        return;
    }
    const enc = escapeHtml(t);
    const encOld = escapeHtml(old);
    strip.style.transition = 'none';
    if (direction === 'forward') {
        strip.innerHTML = `<span class="meal-photo-wheel-label-line">${encOld}</span><span class="meal-photo-wheel-label-line">${enc}</span>`;
        strip.style.transform = 'translateY(0)';
    } else {
        strip.innerHTML = `<span class="meal-photo-wheel-label-line">${enc}</span><span class="meal-photo-wheel-label-line">${encOld}</span>`;
        strip.style.transform = `translateY(-${MEAL_WHEEL_LABEL_LINE_PX}px)`;
    }
    void strip.offsetHeight;
    const finish = () => {
        if (strip._mealStripOnEnd) {
            strip.removeEventListener('transitionend', strip._mealStripOnEnd);
            strip._mealStripOnEnd = null;
        }
        if (strip._mealStripTid) {
            clearTimeout(strip._mealStripTid);
            strip._mealStripTid = null;
        }
        setWheelTextStripImmediate(strip, t);
    };
    strip._mealStripOnEnd = (e) => {
        if (e.target !== strip) return;
        if (e.propertyName && e.propertyName !== 'transform') return;
        finish();
    };
    strip.addEventListener('transitionend', strip._mealStripOnEnd);
    strip._mealStripTid = setTimeout(finish, 320);
    strip.style.transition = 'transform 0.22s ease-out';
    if (direction === 'forward') {
        strip.style.transform = `translateY(-${MEAL_WHEEL_LABEL_LINE_PX}px)`;
    } else {
        strip.style.transform = 'translateY(0)';
    }
}

/** 이전 버전에서 붙은 scroll/transform을 제거하기 위해 휠 inner 노드를 갈아끼움 */
function stripMealWheelInnerListeners(footer) {
    const bar = footer?.querySelector?.('.timeline-meal-photos-wheelbar-inner');
    if (!bar) return;
    bar.querySelectorAll('.meal-photo-wheel-inner').forEach((inner) => {
        const fresh = inner.cloneNode(false);
        inner.parentNode?.replaceChild(fresh, inner);
    });
}

function clearMealWheelInnerTilts(el) {
    const footer = el?.querySelector?.('.timeline-meal-photos-caption-footer');
    stripMealWheelInnerListeners(footer);
}

/** data-date-str가 YYYY-MM-DD가 아닐 때(구데이터 등) 휠 동기화용 */
function parseWheelIsoParts(iso) {
    const s = String(iso || '').trim();
    const strict = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (strict) return { y: strict[1], mo: strict[2], day: strict[3] };
    const loose = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/.exec(s);
    if (!loose) return null;
    const mo = String(Number(loose[2])).padStart(2, '0');
    const day = String(Number(loose[3])).padStart(2, '0');
    return { y: loose[1], mo, day };
}

const MEAL_WHEEL_WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** `YYYY-MM-DD` 등에서 한 글자 요일 (예: 금) */
function weekdayKoShortFromIso(iso) {
    const parts = parseWheelIsoParts(iso);
    if (!parts) return '—';
    const y = Number(parts.y);
    const mo = Number(parts.mo) - 1;
    const d = Number(parts.day);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return '—';
    const dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return '—';
    return MEAL_WHEEL_WEEKDAY_KO[dt.getDay()] || '—';
}

function rebuildMealPhotoWheelPickers(el) {
    const footer = el.querySelector('.timeline-meal-photos-caption-footer');
    const bar = footer?.querySelector('.timeline-meal-photos-wheelbar-inner');
    const rows = el._mealPhotoRows;
    if (!bar || !footer || footer.classList.contains('hidden') || !Array.isArray(rows) || !rows.length) return;
    stripMealWheelInnerListeners(footer);
    el._mealPhotoWheelPrevSlideIndex = undefined;
    el._mealPhotoWheelPrevDateKey = undefined;
    const { minY, maxY } = yearsRangeFromMealPhotoRows(rows);
    const yInner = bar.querySelector('[data-wheel-inner="year"]');
    const mInner = bar.querySelector('[data-wheel-inner="month"]');
    const dInner = bar.querySelector('[data-wheel-inner="day"]');
    if (yInner) yInner.innerHTML = buildWheelItemsHtml(minY, maxY, false);
    if (mInner) mInner.innerHTML = buildWheelItemsHtml(1, 12, true);
    if (dInner) dInner.innerHTML = buildWheelItemsHtml(1, 31, true);
}

function syncMealPhotoWheelFromVtrack(el, vtrack) {
    const footer = el.querySelector('.timeline-meal-photos-caption-footer');
    const bar = footer?.querySelector('.timeline-meal-photos-wheelbar-inner');
    if (!footer || footer.classList.contains('hidden') || !bar || !vtrack) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const i = getVTrackActiveIndex(vtrack);
    const slide = slides[i];
    if (!slide) return;
    const prevI = el._mealPhotoWheelPrevSlideIndex;
    const iso = slide.getAttribute('data-date-str') || '';
    const slotId = slide.getAttribute('data-slot-id') || '';
    const recordId = slide.getAttribute('data-record-id') || '';
    const dateKey = `${iso}|${slotId}|${recordId}`;
    const prevKey = el._mealPhotoWheelPrevDateKey;
    const indexChanged = prevI !== undefined && prevI !== i;
    const slideKeyChanged = prevKey !== undefined && prevKey !== dateKey;
    const shouldAnim = indexChanged || slideKeyChanged;
    let direction = 'backward';
    if (shouldAnim) {
        if (indexChanged) {
            direction = i > prevI ? 'forward' : 'backward';
        } else {
            const prevIso = String(prevKey).split('|')[0];
            direction = prevIso < iso ? 'forward' : 'backward';
        }
    }
    const slotTitleRaw = slide.getAttribute('data-slot-title') || '—';
    const slotStrip = bar.querySelector('[data-wheel-label-strip="slot"]');
    animateWheelTextStrip(slotStrip, compactMealWheelSlotTitle(slotTitleRaw), direction, shouldAnim);
    const menuEl = footer.querySelector('[data-wheel-menu-caption]');
    const row = getCarouselRowForSlide(slide, el);
    if (menuEl && row) {
        menuEl.innerHTML = buildBottomCaption(row);
    }
    syncMealPhotoOverlayAuthorCommentLine(el, row);
    const wdStrip = bar.querySelector('[data-wheel-label-strip="weekday"]');
    animateWheelTextStrip(wdStrip, weekdayKoShortFromIso(iso), direction, shouldAnim);
    const parts = parseWheelIsoParts(iso);
    if (parts) {
        const smooth = shouldAnim;
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="year"]'), parts.y, { smooth });
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="month"]'), parts.mo, { smooth });
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="day"]'), parts.day, { smooth });
    }
    el._mealPhotoWheelPrevSlideIndex = i;
    el._mealPhotoWheelPrevDateKey = dateKey;
}

/** 활성 세로 슬라이드의 캐러셀 프레임(없으면 null) */
function getActiveCarouselFrame(vtrack) {
    const slides = vtrack?.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides?.length) return null;
    const i = getVTrackActiveIndex(vtrack);
    return slides[i]?.querySelector('.timeline-meal-photos-carousel-frame') || null;
}

/** 이전·다음 세로 슬롯 및 가로 이웃 사진 URL을 미리 로드 */
function preloadAdjacentMealPhotos(el) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack || el.classList.contains('hidden')) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    for (const ii of [si - 1, si + 1]) {
        if (ii < 0 || ii >= slides.length) continue;
        const slide = slides[ii];
        const row = getCarouselRowForSlide(slide, el);
        const urls = row?.urls;
        if (!Array.isArray(urls) || !urls.length) continue;
        const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
        const pIdx = Math.min(urls.length - 1, Math.max(0, Number(frame?.dataset.photoIndex || 0)));
        preloadMealPhotoUrl(urls[pIdx]);
        if (urls[pIdx + 1]) preloadMealPhotoUrl(urls[pIdx + 1]);
        if (urls[pIdx - 1]) preloadMealPhotoUrl(urls[pIdx - 1]);
    }
    const activeSlide = slides[si];
    const activeRow = getCarouselRowForSlide(activeSlide, el);
    const au = activeRow?.urls;
    if (Array.isArray(au) && au.length > 1) {
        const frame = activeSlide.querySelector('.timeline-meal-photos-carousel-frame');
        const ci = Math.min(au.length - 1, Math.max(0, Number(frame?.dataset.photoIndex || 0)));
        if (au[ci + 1]) preloadMealPhotoUrl(au[ci + 1]);
        if (au[ci - 1]) preloadMealPhotoUrl(au[ci - 1]);
    }
}

/** 활성 슬라이드 + 바로 위·아래 슬라이드의 `<img>`에 실제 URL 적용(빈 플레이스홀더 완화) */
function hydrateMealPhotoVisibleImage(el) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack || el.classList.contains('hidden')) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const neighbors = [si - 1, si, si + 1].filter((i) => i >= 0 && i < slides.length);
    for (const ii of neighbors) {
        const slide = slides[ii];
        const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
        if (!frame) continue;
        const idx = Number(frame.dataset.photoIndex || 0);
        const active = ii === si;
        applyCarouselIndex(slide, el, idx, { fade: false, skipHstripScroll: active });
    }
    preloadAdjacentMealPhotos(el);
}

/**
 * 휠 모드: 세로/가로로 사진이 바뀐 뒤(스크롤 종료 + 활성 이미지 로드)에만
 * 라벨 텍스트·위치를 한 번 갱신 — 스크롤 중에는 라벨이 따라 움직이지 않음.
 */
function runMealPhotoWheelLabelLayoutWhenReady(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    if (el._mealPhotoWheelLayoutRunning) return;
    const vtrack = el._mealPhotosVTrack;
    if (!vtrack) return;
    el._mealPhotoWheelLayoutRunning = true;
    try {
        hydrateMealPhotoVisibleImage(el);
    } finally {
        el._mealPhotoWheelLayoutRunning = false;
    }
    const frame = getActiveCarouselFrame(vtrack);
    const img = getCarouselPrimaryImageFromFrame(frame);
    const finish = () => {
        syncMealPhotoWheelFromVtrack(el, vtrack);
        positionMealPhotoWheelCaption(el);
        positionMealPhotoCloseButton(el);
        syncMealPhotoWheelCaptionPhotoMinWidth(el);
        requestAnimationFrame(() => syncMealPhotoWheelCaptionPhotoMinWidth(el));
        bindMealPhotoWheelCaptionResizeObserver(el);
    };
    /** 이미지 실제 픽셀·object-fit 배치가 끝난 뒤 라벨 top 계산 */
    const runFinishAfterPaint = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(finish);
        });
    };
    const runAfterDecodeIfPossible = () => {
        const dec = img?.decode?.();
        if (dec && typeof dec.then === 'function') {
            dec.then(runFinishAfterPaint).catch(runFinishAfterPaint);
        } else {
            runFinishAfterPaint();
        }
    };
    if (!img) {
        runFinishAfterPaint();
        return;
    }
    if (img.complete && (img.naturalHeight || 0) > 1) {
        runAfterDecodeIfPossible();
    } else {
        const onReady = () => runAfterDecodeIfPossible();
        img.addEventListener('load', onReady, { once: true });
        img.addEventListener('error', onReady, { once: true });
    }
}

function scheduleMealPhotoWheelLabelLayout(el, delayMs = 80) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    clearTimeout(el._mealPhotoWheelLabelTimer);
    if (delayMs <= 0) {
        el._mealPhotoWheelLabelTimer = null;
        requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(el));
        return;
    }
    el._mealPhotoWheelLabelTimer = setTimeout(() => {
        el._mealPhotoWheelLabelTimer = null;
        runMealPhotoWheelLabelLayoutWhenReady(el);
    }, delayMs);
}

/** WheelEvent.deltaMode(줄·페이지)를 픽셀 근사로 — 웹 마우스 휠에서 세로량이 0으로 보이는 경우 방지 */
function mealPhotoOverlayPrefersReducedMotion() {
    try {
        return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    } catch {
        return false;
    }
}

function normalizeWheelDeltaPx(e) {
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
    } else if (e.deltaMode === 2) {
        const w = window.innerWidth || 800;
        const h = window.innerHeight || 600;
        dx *= w;
        dy *= h;
    }
    return { dx, dy };
}

/**
 * 오버레이 루트: 세로 vtrack·모먼트 게시물 휠만(가로는 hstrip 직접 리스너).
 * getOverlay()가 기존 노드만 반환할 때도 매 호출 시 바인딩 보장.
 */
function ensureMealPhotoOverlayWheelRouting(overlayEl) {
    if (overlayEl._mealOverlayWheelRouterBound) return;
    overlayEl._mealOverlayWheelRouterBound = true;
    overlayEl.addEventListener(
        'wheel',
        (e) => {
            if (overlayEl.classList.contains('hidden')) return;
            if (e.target.closest?.('.meal-photo-wheel-inner')) return;

            /* 가로 캐러셀 휠은 bindCarouselSwipe에서 hstrip에 직접 연결(스크롤 컨테이너에서 확실히 수신) */

            const vtrack = overlayEl._mealPhotosVTrack;
            if (!vtrack?.contains(e.target)) return;

            const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
            if (slides.length > 1) {
                if (e.target.closest?.('.timeline-meal-photos-carousel-zone')) {
                    const { dx, dy } = normalizeWheelDeltaPx(e);
                    const absX = Math.abs(dx);
                    const absY = Math.abs(dy);
                    const forCarousel = absX > absY || (e.shiftKey && absY > 0);
                    if (forCarousel) return;
                }
                const { dy } = normalizeWheelDeltaPx(e);
                if (Math.abs(dy) < 0.001) return;
                /* WheelEvent: deltaY>0 = 아래로 휠 = 문서는 scrollTop 증가 — 브라우저 기본과 동일 */
                vtrack.scrollTop += dy;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        },
        { passive: false }
    );
}

/**
 *「comment」버튼: 기록 코멘트 박스 표시 토글(휠 모드). 기본 off = 반전 표시
 */
function ensureMealPhotoOverlayAuthorCommentToggle(overlayEl) {
    if (overlayEl._mealPhotoAuthorCommentToggleBound) return;
    overlayEl._mealPhotoAuthorCommentToggleBound = true;
    overlayEl.addEventListener('click', (e) => {
        const t = e.target.closest?.('[data-meal-photo-comment-toggle]');
        if (!t) return;
        e.stopPropagation();
        e.preventDefault();
        if (overlayEl._mealPhotoPostCommentsOpen) hideMealPhotoOverlayPostCommentsPanel(overlayEl);
        overlayEl._mealPhotoAuthorCommentBoxVisible = overlayEl._mealPhotoAuthorCommentBoxVisible !== true;
        const vtrack = overlayEl._mealPhotosVTrack;
        if (!vtrack) {
            updateMealPhotoCommentToggleUi(overlayEl);
            return;
        }
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const si = getVTrackActiveIndex(vtrack);
        const row = getCarouselRowForSlide(slides[si], overlayEl);
        syncMealPhotoOverlayAuthorCommentLine(overlayEl, row);
    });
}

function getOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) {
        ensureMealPhotoOverlayBackdrop(el);
        ensureMealPhotoOverlayWheelRouting(el);
        ensureMealPhotoOverlayAuthorCommentToggle(el);
        return el;
    }
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className =
        'hidden fixed inset-0 z-[310] flex min-h-0 flex-col items-stretch overflow-visible';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '기록 사진');
    el.innerHTML = `
        <div class="timeline-meal-photos-overlay-backdrop pointer-events-auto fixed z-0 bg-white/50 backdrop-blur-md" aria-hidden="true"></div>
        <button type="button" class="timeline-meal-photos-close absolute z-[60] flex h-[35px] w-[35px] shrink-0 items-center justify-center rounded-full border border-white/50 bg-black/65 text-white shadow-lg ring-2 ring-white/40 backdrop-blur-sm hover:bg-black/80 active:scale-95 transition-colors" aria-label="닫기">
            <i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-vprev absolute left-1/2 top-14 z-30 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-2 text-white hover:bg-white/25" aria-label="이전 슬롯">
            <i class="fa-solid fa-chevron-up text-lg" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-vnext absolute bottom-14 left-1/2 z-30 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-2 text-white hover:bg-white/25" aria-label="다음 슬롯">
            <i class="fa-solid fa-chevron-down text-lg" aria-hidden="true"></i>
        </button>
        <div class="timeline-meal-photos-body meal-photos-overlay-body relative z-[1] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div class="timeline-meal-photos-stage timeline-meal-photos-stage--with-footer relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden py-2">
                <div class="timeline-meal-photos-vtrack scrollbar-hide flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain snap-y snap-mandatory" style="-webkit-overflow-scrolling:touch;touch-action:pan-y"></div>
                ${buildMealPhotoGlobalCaptionFooterHtml()}
            </div>
            <div class="timeline-meal-photos-post-comments-panel pointer-events-auto absolute bottom-0 left-0 right-0 z-20 hidden min-w-0 max-w-full max-h-[min(48vh,360px)] flex-col rounded-none text-left" data-meal-overlay-post-comments-panel aria-label="댓글 입력" role="region">
                <div class="meal-overlay-post-comments-list timeline-meal-photos-overlay-post-comments-list-text scrollbar-hide max-h-[min(28vh,220px)] min-h-0 w-full min-w-0 overflow-y-auto overflow-x-hidden" data-meal-overlay-post-comments-list style="-webkit-overflow-scrolling:touch"></div>
                <div class="mt-1.5 flex min-w-0 shrink-0 items-stretch gap-1.5 border-t border-white/10 pt-1.5" data-meal-overlay-post-comments-input-row>
                    <input type="text" class="min-w-0 flex-1 rounded-none border border-white/15 bg-black/25 px-2 py-1.5 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none" placeholder="댓글을 입력하세요" autocomplete="off" data-meal-overlay-post-comments-input aria-label="댓글 입력" />
                    <button type="button" class="shrink-0 rounded-none border border-white/20 bg-white/10 px-2.5 py-1.5 text-sm font-bold text-white hover:bg-white/20" data-meal-overlay-post-comments-submit>게시</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(el);

    if (!el._mealPhotoPostCommentsUiBound) {
        el._mealPhotoPostCommentsUiBound = true;
        el.addEventListener('click', (e) => {
            const sub = e.target.closest?.('[data-meal-overlay-post-comments-submit]');
            if (!sub || !el.contains(sub)) return;
            e.preventDefault();
            const pid = el._mealPhotoPostCommentsPostId;
            if (pid && typeof window.submitComment === 'function') window.submitComment(pid);
        });
        el.addEventListener(
            'keydown',
            (e) => {
                if (e.key !== 'Enter' || e.isComposing) return;
                if (!e.target?.matches?.('[data-meal-overlay-post-comments-input]') || !el.contains(e.target)) return;
                const pid = el._mealPhotoPostCommentsPostId;
                if (pid && typeof window.submitComment === 'function') {
                    e.preventDefault();
                    window.submitComment(pid);
                }
            },
            true
        );
    }

    const vtrack = el.querySelector('.timeline-meal-photos-vtrack');
    const btnVPrev = el.querySelector('.timeline-meal-photos-vprev');
    const btnVNext = el.querySelector('.timeline-meal-photos-vnext');
    const btnClose = el.querySelector('.timeline-meal-photos-close');

    const syncMealPhotoChrome = () => {
        if (!vtrack) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const rows = el._mealPhotoRows?.length || 0;
        const si = getVTrackActiveIndex(vtrack);
        const slide = slides[si];
        const frame = getActiveCarouselFrame(vtrack);
        const row = slide ? getCarouselRowForSlide(slide, el) : null;
        const nPhotos = row?.urls?.length || 0;
        const hstrip = frame?.querySelector('.timeline-meal-photos-hstrip');
        const carouselViewport = frame?.querySelector('.timeline-meal-photos-carousel-viewport');
        frame?.classList.toggle('cursor-grab', nPhotos > 1);
        hstrip?.classList.toggle('cursor-grab', nPhotos > 1);
        carouselViewport?.classList.toggle('cursor-grab', nPhotos > 1);
        if (!frame || nPhotos <= 1) {
            frame?.classList.remove('cursor-grabbing');
            hstrip?.classList.remove('cursor-grabbing');
            carouselViewport?.classList.remove('cursor-grabbing');
        }
        vtrack?.classList.toggle('cursor-grab', rows > 1);
        if (rows <= 1) vtrack?.classList.remove('cursor-grabbing');
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
            if (!el._mealPhotoWheelSuppressLabelSchedule) {
                scheduleMealPhotoWheelLabelLayout(el);
            }
        }
        hydrateMealPhotoVisibleImage(el);
        positionMealPhotoCloseButton(el);
        if (
            el._mealPhotoMomentFeedContext &&
            el.classList.contains('timeline-meal-photos-overlay--wheel') &&
            rows > 0 &&
            si >= rows - 1
        ) {
            maybeScheduleMomentFeedWheelExtend(el);
        }
        maybeCloseMealPhotoPostCommentsOnPostChange(el);
    };

    vtrack?.addEventListener('scroll', syncMealPhotoChrome, { passive: true });
    vtrack?.addEventListener(
        'scrollend',
        () => {
            if (el.classList.contains('hidden') || !el.classList.contains('timeline-meal-photos-overlay--wheel')) return;
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            runMealPhotoWheelLabelLayoutWhenReady(el);
            maybeScheduleMomentFeedWheelExtend(el);
        },
        { passive: true }
    );

    const appendMonthRows = (year, month) => {
        if (!vtrack) return;
        const raw = buildMealPhotoViewerRowsForMonth(year, month);
        const prepared = prepareRowsWithPhotoCap(filterRowsWithPhotos(raw));
        const footer = vtrack.querySelector('.timeline-meal-photos-month-footer');
        const html = prepared.map((r) => buildVSlideHtml(r, false)).join('');
        if (footer) footer.insertAdjacentHTML('beforebegin', html);
        else vtrack.insertAdjacentHTML('beforeend', html);
        el._mealPhotoRows = (el._mealPhotoRows || []).concat(prepared);
        el._mealPhotoLastYM = { y: year, mo: month };
        footer?.remove();
        vtrack.insertAdjacentHTML('beforeend', buildMonthLoadFooterHtml(year, month));
        el._mealPhotosBindRowTracks?.();
        rebuildMealPhotoWheelPickers(el);
        el._mealPhotosSync?.();
        el._mealPhotosToggleVNav?.();
    };

    vtrack?.addEventListener('click', (e) => {
        const loadBtn = e.target.closest?.('.timeline-meal-photos-load-next-month');
        if (loadBtn) {
            e.preventDefault();
            e.stopPropagation();
            const y = Number(loadBtn.getAttribute('data-next-y'));
            const mo = Number(loadBtn.getAttribute('data-next-m'));
            if (Number.isFinite(y) && Number.isFinite(mo)) appendMonthRows(y, mo);
            return;
        }
        const exp = e.target.closest?.('.timeline-meal-photo-expand');
        if (!exp) return;
        e.preventDefault();
        e.stopPropagation();
        const dateStr = exp.getAttribute('data-expand-date');
        const slotId = exp.getAttribute('data-expand-slot');
        const recordAttr = exp.getAttribute('data-expand-record');
        const recordId = recordAttr == null || recordAttr === '' ? null : String(recordAttr);
        if (!dateStr || !slotId) return;
        const row = findMealPhotoRowState(el, dateStr, slotId, recordId);
        if (!row || !Array.isArray(row.allUrls) || !row.urls?.length) return;
        const slide = exp.closest('.timeline-meal-photos-vslide');
        if (!slide) return;
        row.urls = row.allUrls;
        delete row.allUrls;
        const zone = slide.querySelector('.timeline-meal-photos-carousel-zone');
        if (zone) {
            zone.outerHTML = buildCarouselZoneHtml(row, {
                wheelViewport: el.classList.contains('timeline-meal-photos-overlay--wheel')
            });
            el._mealPhotosBindRowTracks?.();
            applyCarouselIndex(slide, el, 0);
        }
        if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            runMealPhotoWheelLabelLayoutWhenReady(el);
        }
        try {
            el._mealPhotoWheelSuppressLabelSchedule = Boolean(el.classList.contains('timeline-meal-photos-overlay--wheel'));
            el._mealPhotosSync?.();
        } finally {
            el._mealPhotoWheelSuppressLabelSchedule = false;
        }
    });

    /** 세로: 마우스·펜·터치 드래그(다장 가로 영역은 터치는 캐러셀에 맡김) */
    let vDragId = null;
    let vLastY = 0;
    const onVDown = (e) => {
        if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return;
        const carouselViewportHit = e.target.closest?.('.timeline-meal-photos-carousel-viewport');
        if (carouselViewportHit) {
            const slideEl = carouselViewportHit.closest?.('.timeline-meal-photos-vslide');
            const rowH = slideEl && getCarouselRowForSlide(slideEl, el);
            if (rowH && (rowH.urls?.length || 0) > 1) return;
        }
        const slideCount = vtrack?.querySelectorAll('.timeline-meal-photos-vslide').length || 0;
        /* 터치 + 세로 슬라이드 여러 개: 포인터 캡처·수동 scrollTop 대신 vtrack 네이티브 스크롤(스와이프) */
        if (e.pointerType === 'touch' && slideCount > 1) return;
        if (slideCount <= 1) return;
        vDragId = e.pointerId;
        vLastY = e.clientY;
        try {
            vtrack.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        vtrack.classList.add('cursor-grabbing');
    };
    const onVMove = (e) => {
        if (vDragId == null || e.pointerId !== vDragId || !vtrack) return;
        const dy = e.clientY - vLastY;
        vLastY = e.clientY;
        vtrack.scrollTop += dy;
        try {
            e.preventDefault();
        } catch (_) {
            /* ignore */
        }
    };
    const endV = (e) => {
        if (vDragId == null || (e && e.pointerId !== vDragId)) return;
        try {
            vtrack.releasePointerCapture(vDragId);
        } catch (_) {
            /* ignore */
        }
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
    };
    vtrack?.addEventListener('pointerdown', onVDown);
    vtrack?.addEventListener('pointermove', onVMove, { passive: false });
    vtrack?.addEventListener('pointerup', endV);
    vtrack?.addEventListener('pointercancel', endV);
    vtrack?.addEventListener('lostpointercapture', () => {
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
    });

    const close = () => {
        hideMealPhotoOverlayPostCommentsPanel(el);
        clearTimeout(el._mealPhotoWheelLabelTimer);
        el._mealPhotoWheelLabelTimer = null;
        el._mealPhotoWheelLayoutRunning = false;
        el.classList.add('hidden');
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        el.classList.remove('timeline-meal-photos-overlay--moment-feed');
        document.body.classList.remove('meal-photo-moment-chrome-hidden');
        el._mealPhotoMomentNavState = null;
        document.body.classList.remove('overflow-hidden');
        const hdClose = el._mealCarouselHStripDrag;
        if (hdClose?.hstrip) {
            try {
                hdClose.hstrip.releasePointerCapture(hdClose.pointerId);
            } catch (_) {
                /* ignore */
            }
        }
        removeMealPhotoCarouselDocumentPointerListeners(el);
        el._mealCarouselAxisGesture = null;
        el._mealCarouselHStripDrag = null;
        vtrack?.querySelectorAll('.timeline-meal-photos-carousel-frame').forEach((fr) => {
            if (fr._mealPhotoBadgeAnchorRaf != null) {
                cancelAnimationFrame(fr._mealPhotoBadgeAnchorRaf);
                fr._mealPhotoBadgeAnchorRaf = null;
            }
            if (fr._mealPhotoBadgeRO) {
                fr._mealPhotoBadgeRO.disconnect();
                fr._mealPhotoBadgeRO = null;
            }
        });
        if (vtrack) vtrack.innerHTML = '';
        const cap = el.querySelector('.timeline-meal-photos-caption-footer');
        cap?.classList.add('hidden');
        cap?.classList.remove('flex');
        cap?.style.removeProperty('top');
        cap?.style.removeProperty('bottom');
        cap?.style.removeProperty('left');
        cap?.style.removeProperty('right');
        cap?.style.removeProperty('position');
        el.style.removeProperty('--meal-wheel-caption-inner-w');
        clearMealWheelInnerTilts(el);
        el._mealPhotoWheelPrevSlideIndex = undefined;
        el._mealPhotoWheelPrevDateKey = undefined;
        el.querySelectorAll('[data-wheel-label-strip]').forEach((strip) => {
            if (strip._mealStripTid) {
                clearTimeout(strip._mealStripTid);
                strip._mealStripTid = null;
            }
            if (strip._mealStripOnEnd) {
                strip.removeEventListener('transitionend', strip._mealStripOnEnd);
                strip._mealStripOnEnd = null;
            }
            delete strip.dataset.cur;
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0)';
            strip.innerHTML = '<span class="meal-photo-wheel-label-line">—</span>';
        });
        el._mealPhotoRows = null;
        el._mealPhotoLastYM = null;
        el._mealPhotoMomentFeedContext = null;
        el._mealPhotoMomentSeenPostIds = null;
        el._mealPhotoMomentFeedLoading = false;
        el._mealPhotoMomentFeedExtendScheduled = false;
        _mealPhotoPreloadStarted.clear();
        if (el._mealPhotoWheelCaptionRO) {
            el._mealPhotoWheelCaptionRO.disconnect();
            el._mealPhotoWheelCaptionRO = null;
        }
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
        const cb = el.querySelector('.timeline-meal-photos-close');
        if (cb) {
            cb.style.removeProperty('left');
            cb.style.removeProperty('top');
            cb.style.removeProperty('right');
            cb.style.removeProperty('bottom');
            cb.style.removeProperty('transform');
        }
    };

    btnClose?.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
    });
    el.addEventListener('click', (e) => {
        if (e.target === el) close();
    });
    const scrollVBy = (dir) => {
        if (!vtrack) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        if (!slides.length) return;
        const i = getVTrackActiveIndex(vtrack);
        const next = Math.min(slides.length - 1, Math.max(0, i + dir));
        const delta =
            el.classList.contains('timeline-meal-photos-overlay--wheel') &&
            !el.classList.contains('timeline-meal-photos-overlay--moment-feed')
                ? scrollDeltaToCenterSlideInVtrack(vtrack, slides[next])
                : scrollDeltaToAlignSlideTop(vtrack, slides[next]);
        vtrack.scrollTo({ top: vtrack.scrollTop + delta, behavior: 'smooth' });
    };
    btnVPrev?.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollVBy(-1);
    });
    btnVNext?.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollVBy(1);
    });

    const onKey = (e) => {
        if (el.classList.contains('hidden')) return;
        if (e.key === 'Escape') {
            close();
            return;
        }
        const frame = getActiveCarouselFrame(vtrack);
        const rows = el._mealPhotoRows?.length || 0;
        if (e.key === 'ArrowLeft' && frame) {
            e.preventDefault();
            stepCarouselPhoto(el, -1);
        } else if (e.key === 'ArrowRight' && frame) {
            e.preventDefault();
            stepCarouselPhoto(el, 1);
        } else if (e.key === 'ArrowUp') {
            if (rows > 1) {
                e.preventDefault();
                scrollVBy(-1);
            }
        } else if (e.key === 'ArrowDown') {
            if (rows > 1) {
                e.preventDefault();
                scrollVBy(1);
            }
        }
    };
    document.addEventListener('keydown', onKey);

    const mq = window.matchMedia?.('(min-width: 768px)');
    /** 좌우 화살표 버튼은 사용하지 않음(스와이프·키보드만). 훅은 호환용 noop. */
    const toggleNavDesktopOnly = () => {};
    /** 상하 슬롯 이동 화살표는 표시하지 않음(vtrack 세로 스크롤·스와이프로만 이동). */
    const toggleVNavDesktopOnly = () => {
        [btnVPrev, btnVNext].forEach((b) => {
            if (!b) return;
            b.classList.add('hidden');
            b.classList.remove('inline-flex');
        });
    };
    mq?.addEventListener?.('change', () => {
        toggleVNavDesktopOnly();
    });

    window.addEventListener('resize', syncOverlayLayout, { passive: true });
    window.addEventListener('orientationchange', syncOverlayLayout, { passive: true });
    window.visualViewport?.addEventListener?.('resize', syncOverlayLayout, { passive: true });
    window.visualViewport?.addEventListener?.('scroll', syncOverlayLayout, { passive: true });

    el._mealPhotosClose = close;
    el._mealPhotosSync = syncMealPhotoChrome;
    el._mealPhotosToggleNav = toggleNavDesktopOnly;
    el._mealPhotosToggleVNav = toggleVNavDesktopOnly;
    el._mealPhotosLayout = syncOverlayLayout;
    el._mealPhotosVTrack = vtrack;
    el._mealPhotosBindRowTracks = () => {
        vtrack?.querySelectorAll('.timeline-meal-photos-carousel-zone').forEach((zone) => {
            bindCarouselSwipe(zone, el);
        });
    };
    ensureMealPhotoOverlayWheelRouting(el);
    ensureMealPhotoOverlayAuthorCommentToggle(el);
    return el;
}

/**
 * @param {HTMLButtonElement} btn — data-photos + (선택) data-meal-view-date/slot/record
 */
export function openTimelineMealPhotosPopup(btn) {
    const raw = btn?.getAttribute?.('data-photos');
    if (!raw) return;
    let urls;
    try {
        urls = JSON.parse(decodeURIComponent(raw));
    } catch {
        return;
    }
    if (!Array.isArray(urls) || urls.length === 0) return;

    const el = getOverlay();
    el.classList.remove('timeline-meal-photos-overlay--moment-feed');
    hideMealPhotoOverlayPostCommentsPanel(el);
    el._mealPhotoAuthorCommentBoxVisible = false;
    const vtrack = el._mealPhotosVTrack;
    if (!vtrack) return;

    const dateStr = btn.getAttribute('data-meal-view-date');
    const slotId = btn.getAttribute('data-meal-view-slot');
    const recordId = btn.getAttribute('data-meal-view-record');

    const useDayNav = Boolean(dateStr && slotId);
    if (useDayNav) {
        const ym = parseYearMonthFromDateStr(dateStr);
        const rowsRaw = ym ? buildMealPhotoViewerRowsForMonth(ym.y, ym.mo) : buildMealPhotoViewerRowsForDate(dateStr);
        const rows = filterRowsWithPhotos(rowsRaw);
        const startRow = findMealPhotoViewerRowIndex(rows, slotId, recordId, dateStr);
        const prepared = prepareRowsWithPhotoCap(rows);
        el._mealPhotoRows = prepared;
        if (ym) el._mealPhotoLastYM = { y: ym.y, mo: ym.mo };
        else el._mealPhotoLastYM = null;
        const footer = ym ? buildMonthLoadFooterHtml(ym.y, ym.mo) : '';
        vtrack.innerHTML = prepared.map((r) => buildVSlideHtml(r, false)).join('') + footer;
        el._mealPhotosBindRowTracks?.();
        el.classList.add('timeline-meal-photos-overlay--wheel');
        const capShow = el.querySelector('.timeline-meal-photos-caption-footer');
        capShow?.classList.remove('hidden');
        capShow?.classList.add('flex');
        rebuildMealPhotoWheelPickers(el);
        el.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        el._mealPhotosLayout?.();
        syncMealPhotoWheelCaptionPhotoMinWidth(el);
        requestAnimationFrame(() => {
            el._mealPhotosLayout?.();
            syncMealPhotoWheelCaptionPhotoMinWidth(el);
            const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
            const target = slides[startRow];
            if (target) {
                vtrack.scrollTop += scrollDeltaToCenterSlideInVtrack(vtrack, target);
            }
            el._mealPhotosSync?.();
            syncMealPhotoOverlaySocialFromFeed(el);
            void hydrateMealPhotoOverlaySocial(el);
            updateMealPhotoCommentToggleUi(el);
            el._mealPhotosToggleNav?.();
            el._mealPhotosToggleVNav?.();
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(el));
            });
        });
    } else {
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        clearMealWheelInnerTilts(el);
        const capLeg = el.querySelector('.timeline-meal-photos-caption-footer');
        capLeg?.classList.add('hidden');
        capLeg?.classList.remove('flex');
        el._mealPhotoRows = [{ urls, isLegacy: true }];
        const slide = `<section class="timeline-meal-photos-vslide timeline-meal-photos-vslide--legacy flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden" data-legacy-carousel="1">
            <div class="timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col">
                <div class="timeline-meal-photos-track timeline-meal-photos-track--carousel scrollbar-hide flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col items-stretch overflow-hidden" style="-webkit-overflow-scrolling:touch">${buildHorizontalSlidesLegacyHtml(urls)}</div>
            </div>
        </section>`;
        vtrack.innerHTML = slide;
        el._mealPhotosBindRowTracks?.();
        el.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        el._mealPhotosLayout?.();
        vtrack.scrollTop = 0;
        requestAnimationFrame(() => {
            el._mealPhotosLayout?.();
            el._mealPhotosSync?.();
            el._mealPhotosToggleNav?.();
            el._mealPhotosToggleVNav?.();
        });
    }

    try {
        btn.blur();
    } catch (_) {
        /* ignore */
    }
}

function applyMomentOverlayChrome(show) {
    document.body.classList.toggle('meal-photo-moment-chrome-hidden', Boolean(show));
}

/** 모먼트 피드(#galleryContainer / #feedContent)에서 휠 행 JSON이 붙은 카드만 순서대로 */
function collectMomentFeedWheelRowsFromDom(container) {
    if (!container?.querySelectorAll) return [];
    const out = [];
    container.querySelectorAll('.instagram-post').forEach((card) => {
        const tap = card.querySelector('.timeline-meal-photo-tap[data-meal-wheel-row]');
        if (!tap) return;
        const raw = tap.getAttribute('data-meal-wheel-row');
        if (!raw) return;
        let row;
        try {
            row = JSON.parse(decodeURIComponent(raw));
        } catch {
            return;
        }
        if (!row || !Array.isArray(row.urls) || !row.urls.length) return;
        out.push({
            postId: card.getAttribute('data-post-id') || '',
            row
        });
    });
    return out;
}

/** DOM 순서대로, 아직 휠에 넣지 않은 게시물의 `row`만 모은다. `seen`에 새 postId를 기록한다. */
function collectNewMomentFeedWheelRows(container, seen) {
    const entries = collectMomentFeedWheelRowsFromDom(container);
    const novel = [];
    for (const e of entries) {
        const pid = e.postId || '';
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        novel.push(e.row);
    }
    return novel;
}

function appendMomentFeedWheelSlides(el, rawRows) {
    if (!rawRows?.length || !el?._mealPhotosVTrack) return;
    const prepared = prepareRowsWithPhotoCap(rawRows);
    el._mealPhotoRows = (el._mealPhotoRows || []).concat(prepared);
    const html = prepared.map((r) => buildVSlideHtml(r, false)).join('');
    el._mealPhotosVTrack.insertAdjacentHTML('beforeend', html);
    el._mealPhotosBindRowTracks?.();
    rebuildMealPhotoWheelPickers(el);
    el._mealPhotosLayout?.();
    syncMealPhotoWheelCaptionPhotoMinWidth(el);
    el._mealPhotosSync?.();
    syncMealPhotoOverlaySocialFromFeed(el);
    void hydrateMealPhotoOverlaySocial(el);
}

async function tryExtendMomentFeedWheel(el) {
    if (!el._mealPhotoMomentFeedContext || el._mealPhotoMomentFeedLoading) return;
    const { container, isGallery } = el._mealPhotoMomentFeedContext;
    const seen = el._mealPhotoMomentSeenPostIds;
    if (!(seen instanceof Set)) return;

    el._mealPhotoMomentFeedLoading = true;
    try {
        let novel = collectNewMomentFeedWheelRows(container, seen);

        if (isGallery && novel.length === 0) {
            const groups = processPhotosToGroups(window.sharedPhotosFeed || []);
            if (seen.size < groups.length) {
                const ph = document.getElementById('gallery-placeholder');
                if (ph) {
                    ph.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    await new Promise((r) => setTimeout(r, 420));
                }
                novel = collectNewMomentFeedWheelRows(container, seen);
            }
        }

        if (novel.length > 0) {
            appendMomentFeedWheelSlides(el, novel);
            return;
        }

        const hasNet = appState.sharedPhotosFeedHasMore || appState.sharedPhotosFeedLastDoc;
        if (!hasNet) return;

        const res = await appendMomentFeedNextPage({ syncFeed: !isGallery });
        if (!res?.ok) return;

        await new Promise((r) => setTimeout(r, isGallery ? 120 : 80));

        novel = collectNewMomentFeedWheelRows(container, seen);
        if (novel.length > 0) {
            appendMomentFeedWheelSlides(el, novel);
        }
    } finally {
        el._mealPhotoMomentFeedLoading = false;
    }
}

function maybeScheduleMomentFeedWheelExtend(el) {
    if (!el._mealPhotoMomentFeedContext || el._mealPhotoMomentFeedLoading) return;
    if (el._mealPhotoMomentFeedExtendScheduled) return;
    el._mealPhotoMomentFeedExtendScheduled = true;
    requestAnimationFrame(() => {
        el._mealPhotoMomentFeedExtendScheduled = false;
        const vtrack = el._mealPhotosVTrack;
        if (!vtrack || el.classList.contains('hidden') || !el.classList.contains('timeline-meal-photos-overlay--wheel')) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const n = el._mealPhotoRows?.length || 0;
        if (n < 1 || slides.length < 1) return;
        const si = getVTrackActiveIndex(vtrack);
        if (si < slides.length - 1 || si < n - 1) return;
        void tryExtendMomentFeedWheel(el);
    });
}

/**
 * 모먼트 앨범: 타임라인 `openTimelineMealPhotosPopup` 일간·휠 모드와 동일하게
 * 게시물마다 `buildVSlideHtml` 세로 슬라이드 + vtrack 스냅·스크롤로 전환.
 */
export function openMealPhotosWheelOverlayFromBtn(btn) {
    const raw = btn?.getAttribute?.('data-meal-wheel-row');
    const idxRaw = btn?.getAttribute?.('data-meal-start-idx');
    if (!raw) return;
    let row;
    try {
        row = JSON.parse(decodeURIComponent(raw));
    } catch {
        return;
    }
    if (!row || !Array.isArray(row.urls) || !row.urls.length) return;

    const el = getOverlay();
    hideMealPhotoOverlayPostCommentsPanel(el);
    el._mealPhotoAuthorCommentBoxVisible = false;
    const vtrack = el._mealPhotosVTrack;
    if (!vtrack) return;
    el.classList.add('timeline-meal-photos-overlay--moment-feed');

    const startPhotoIdx = idxRaw != null ? parseInt(String(idxRaw), 10) : 0;
    const startPhotoSi = Number.isFinite(startPhotoIdx) ? startPhotoIdx : 0;

    applyMomentOverlayChrome(true);
    el._mealPhotoMomentNavState = null;

    const container = btn.closest?.('#galleryContainer, #feedContent');
    const entries = container ? collectMomentFeedWheelRowsFromDom(container) : [];
    let rowsPayload;
    let startRow = 0;
    if (entries.length) {
        rowsPayload = entries.map((e) => e.row);
        const card = btn.closest('.instagram-post');
        const pid = card?.getAttribute('data-post-id') || '';
        const idx = entries.findIndex((e) => e.postId === pid);
        startRow = idx >= 0 ? idx : 0;
        el._mealPhotoMomentFeedContext = {
            container,
            isGallery: container?.id === 'galleryContainer'
        };
        el._mealPhotoMomentSeenPostIds = new Set(entries.map((e) => e.postId).filter(Boolean));
        el._mealPhotoMomentFeedLoading = false;
        el._mealPhotoMomentFeedExtendScheduled = false;
    } else {
        rowsPayload = [row];
        el._mealPhotoMomentFeedContext = null;
        el._mealPhotoMomentSeenPostIds = null;
        el._mealPhotoMomentFeedLoading = false;
        el._mealPhotoMomentFeedExtendScheduled = false;
    }

    const prepared = prepareRowsWithPhotoCap(rowsPayload);
    el._mealPhotoRows = prepared;
    el._mealPhotoLastYM = null;
    vtrack.innerHTML = prepared.map((r) => buildVSlideHtml(r, false)).join('');
    el._mealPhotosBindRowTracks?.();
    el.classList.add('timeline-meal-photos-overlay--wheel');
    const capShow = el.querySelector('.timeline-meal-photos-caption-footer');
    capShow?.classList.remove('hidden');
    capShow?.classList.add('flex');
    rebuildMealPhotoWheelPickers(el);
    el.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
    el._mealPhotosLayout?.();
    syncMealPhotoWheelCaptionPhotoMinWidth(el);

    requestAnimationFrame(() => {
        el._mealPhotosLayout?.();
        syncMealPhotoWheelCaptionPhotoMinWidth(el);
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const target = slides[startRow];
        if (target) {
            vtrack.scrollTop += scrollDeltaToAlignSlideTop(vtrack, target);
        }
        el._mealPhotosSync?.();
        syncMealPhotoOverlaySocialFromFeed(el);
        void hydrateMealPhotoOverlaySocial(el);
        updateMealPhotoCommentToggleUi(el);
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        clearTimeout(el._mealPhotoWheelLabelTimer);
        el._mealPhotoWheelLabelTimer = null;
        const rowAtStart = prepared[startRow];
        const n = rowAtStart?.urls?.length || 0;
        const si = n > 0 ? Math.min(n - 1, Math.max(0, startPhotoSi)) : 0;
        if (target && n > 0) {
            applyCarouselIndex(target, el, si, { fade: false });
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(el));
        });
    });

    try {
        btn.blur();
    } catch (_) {
        /* ignore */
    }
}

window.openTimelineMealPhotosPopup = openTimelineMealPhotosPopup;
window.openMealPhotosWheelOverlayFromBtn = openMealPhotosWheelOverlayFromBtn;
