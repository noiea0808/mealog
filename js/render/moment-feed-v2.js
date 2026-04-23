/**
 * 모먼트 피드 화면 2 — 사진만 가로 캐러셀(.moment-v2-hstrip).
 * 용어: 글쓴이의 기록 문구 = **코멘트**(`data-moment-v2-author-comment` 계열) / 달린 소셜 = **댓글**(`post-comments-list` 등)
 * 하단 휠(날짜·메뉴)+코멘트+댓글은 **사진 열** 아래 `wheel-body` 안에서 일반 세로 플로우(가로 캐러셀과 겹치지 않음).
 */
import { escapeHtml } from './utils.js';
import { SLOTS } from '../constants.js';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function aspectToCss(ar) {
    if (ar === '3:4' || ar === '4:3') return ar === '3:4' ? '3/4' : '4/3';
    return '1/1';
}

/** @returns {{ y: string, mo: string, day: string, wd: string }} */
export function getMomentV2DateParts(photo) {
    const dstr = photo?.date;
    if (dstr && /^\d{4}-\d{2}-\d{2}$/.test(String(dstr))) {
        const [y, m, day] = String(dstr).split('-');
        const dt = new Date(Number(y), Number(m) - 1, Number(day));
        if (
            dt.getFullYear() === Number(y) &&
            dt.getMonth() === Number(m) - 1 &&
            dt.getDate() === Number(day)
        ) {
            return { y, mo: m, day, wd: WEEKDAY_KO[dt.getDay()] || '—' };
        }
    }
    const ts = photo?.timestamp;
    let dt = null;
    if (ts instanceof Date) dt = ts;
    else if (ts && typeof ts.toDate === 'function') dt = ts.toDate();
    else if (ts) dt = new Date(ts);
    if (dt && !isNaN(+dt)) {
        return {
            y: String(dt.getFullYear()),
            mo: String(dt.getMonth() + 1).padStart(2, '0'),
            day: String(dt.getDate()).padStart(2, '0'),
            wd: WEEKDAY_KO[dt.getDay()] || '—'
        };
    }
    return { y: '—', mo: '—', day: '—', wd: '—' };
}

export function getMomentV2SlotWheelLabel(photo, isBest, isDaily, isInsight) {
    if (isDaily) return '일간';
    if (isBest) return '베스트';
    if (isInsight) {
        const r = String(photo?.dateRangeText || '인사이트').replace(/\s+/g, '').trim();
        return r.length > 14 ? `${r.slice(0, 14)}…` : r || '인사이트';
    }
    const slot = photo?.slotId && SLOTS.find((s) => s.id === photo.slotId);
    const raw = slot ? slot.label : '—';
    return String(raw).replace(/\s+/g, '').trim() || '—';
}

function buildWheelNumericCol(val, isYear, fieldKey) {
    const v = escapeHtml(val);
    const yearCls = isYear ? ' meal-photo-wheel-col--year' : '';
    const fk = escapeHtml(fieldKey);
    /* 사진 캐러셀과 분리: 휠 바는 고정, 열 내부만 세로 전환(타임라인 휠 strip 애니메이션) */
    return `<div class="meal-photo-wheel-col${yearCls} flex shrink-0 flex-col items-center justify-center">
    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--static max-h-[30px] min-h-[30px] h-[30px] overflow-hidden flex items-start justify-center">
        <div class="meal-photo-wheel-label-strip moment-v2-wheel-anim-strip" data-moment-v2-f="${fk}" data-moment-v2-stripe="num" data-moment-v2-wheel-strip="1" aria-hidden="true">
            <span class="meal-photo-wheel-label-line">${v}</span>
        </div>
    </div>
</div>`;
}

function buildWheelLabelCol(modifier, val, fieldKey) {
    const v = escapeHtml(val);
    const fk = escapeHtml(fieldKey);
    return `<div class="meal-photo-wheel-col ${modifier} flex min-w-0 shrink-0 flex-col items-center justify-center">
    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--label meal-photo-wheel-viewport--static max-h-[30px] min-h-[30px] h-[30px] overflow-hidden">
        <div class="meal-photo-wheel-label-strip moment-v2-wheel-anim-strip" data-moment-v2-f="${fk}" data-moment-v2-stripe="label" data-moment-v2-wheel-strip="1">
            <span class="meal-photo-wheel-label-line">${v}</span>
        </div>
    </div>
</div>`;
}

/** 기록 코멘트(소셜 댓글 아님) — `buildSharedMomentWheelOverlayRow`과 동일 규칙 */
function buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const isSnack = p?.slotId && SLOTS.find((s) => s.id === p.slotId)?.type === 'snack';
    if (isBestShare || isDailyShare || isInsightShare) {
        return (p?.comment || '').replace(/<[^>]*>/g, '').trim();
    }
    if (isSnack) {
        return (p?.comment || '').toString().trim();
    }
    let authorMealComment = '';
    if (p?.comment) authorMealComment = String(p.comment).trim();
    const eid = p?.entryId || groupEntryId;
    if (!authorMealComment && eid && mealHistoryMap && mealHistoryMap.has(eid)) {
        const mealRecord = mealHistoryMap.get(eid);
        if (mealRecord?.comment) authorMealComment = String(mealRecord.comment).trim();
    }
    if (!authorMealComment && !eid && typeof window !== 'undefined' && window.mealHistory && p?.date && p?.slotId) {
        const matchingRecord = window.mealHistory.find(
            (m) =>
                m.date === p.date && m.slotId === p.slotId && (p.comment ? m.comment === p.comment : true)
        );
        if (matchingRecord?.comment) authorMealComment = String(matchingRecord.comment).trim();
    }
    return authorMealComment;
}

/**
 * 사진 인덱스마다 라벨 갱신용 페이로드 (JSON으로 data-moment-v2-labels에 저장)
 * @param {{ isBestShare: boolean, isDailyShare: boolean, isInsightShare: boolean }} flags
 * @param {{ mealHistoryMap?: Map, groupEntryId?: string }} [ctx]
 */
export function buildMomentV2LabelsPayload(photoGroup, captionTextPlain, flags, ctx = {}) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const { mealHistoryMap, groupEntryId } = ctx;
    const menuBase = (captionTextPlain || '').trim() || '—';
    return photoGroup.map((p) => {
        const { y, mo, day, wd } = getMomentV2DateParts(p);
        const slotT = getMomentV2SlotWheelLabel(p, isBestShare, isDailyShare, isInsightShare);
        const ac = buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId);
        return { y, mo, da: day, wd, slot: slotT, menu: menuBase, ac };
    });
}

/**
 * 휠 피커 스타일 하단 라벨 (정적 표시)
 * @param {string} menuCaptionPlain — 우측 메뉴@장소 등 (이미 평문)
 */
function buildV2MeatballBtnHtml(overlayRow) {
    const fo = overlayRow?.overlayFeedOptions;
    if (!fo) return '';
    const attr = ` data-meal-feed-options="${encodeURIComponent(JSON.stringify(fo))}"`;
    return `<button type="button" class="timeline-meal-photo-meatball-btn timeline-meal-photo-moment-social-btn pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0"${attr} data-meal-photo-meatball="1" onclick="event.stopPropagation();window._openMealOverlayFeedOptions&&window._openMealOverlayFeedOptions(this)" aria-label="더보기" aria-haspopup="true"><i class="fa-solid fa-ellipsis-vertical timeline-meal-photo-meatball-icon text-white/95" aria-hidden="true"></i></button>`;
}

/** 좋아요·댓글(소셜)·북마크 — 사진 기준 우하단 앵커(댓글은 `toggleCommentInput`으로 열기) */
function buildV2InlineSocialBarHtml(postId) {
    const p = String(postId || '');
    const pidJson = JSON.stringify(p);
    return `<div class="pointer-events-auto absolute z-[11] flex items-center" data-meal-photo-social-bubble><div class="timeline-meal-photo-moment-social-row flex shrink-0 items-center">
<button type="button" class="post-like-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleLike(${pidJson})' aria-label="좋아요"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true"><i class="fa-regular fa-heart text-white/95 post-like-icon timeline-meal-photo-moment-social-icon"></i></span><span class="post-like-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-comment-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleCommentInput(${pidJson})' aria-label="댓글"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true"><i class="fa-regular fa-comment post-comment-icon text-white/95 timeline-meal-photo-moment-social-icon" aria-hidden="true"></i></span><span class="post-comment-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-bookmark-btn timeline-meal-photo-moment-social-btn flex h-8 w-8 shrink-0 items-center justify-center rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleBookmark(${pidJson})' aria-label="북마크"><i class="fa-regular fa-bookmark text-white/95 post-bookmark-icon timeline-meal-photo-moment-social-icon" aria-hidden="true"></i></button>
</div></div>`;
}

function buildV2SocialCommentPanelHtml(postId, postIdJs) {
    const p = String(postId || '');
    return `<div class="comment-section moment-v2-social-comments-panel comments-empty hidden w-full min-w-0 border-t-0 -mx-0 px-0 pt-0 pb-0 moment-v2-social-below-label" id="comment-section-${p}">
        <div class="post-comments-list mb-1 rounded-lg py-2 bg-white" data-post-id="${p}" id="comments-list-${p}"></div>
        <button id="view-comments-${p}" class="hidden text-xs text-slate-500 font-bold mb-1 hover:text-slate-700 active:text-slate-900 transition-colors" onclick='window.viewAllComments(${postIdJs})'>댓글 더보기</button>
        <div id="comment-input-${p}" class="hidden mt-1 py-2 -mx-0 px-0">
            <div class="relative">
                <input type="text" id="comment-text-${p}" placeholder="댓글을 입력하세요..." class="w-full px-3 py-2 pr-16 border border-slate-300 rounded-lg text-sm focus:outline-none bg-slate-100" onkeypress='if(event.key==="Enter")window.submitComment(${postIdJs})'>
                <span class="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-600 text-sm font-bold cursor-pointer hover:text-emerald-700" ontouchstart="event.preventDefault()" ontouchend='event.preventDefault();window.submitComment(${postIdJs})' onclick='window.submitComment(${postIdJs})'>게시</span>
            </div>
        </div>
    </div>`;
}

function buildV2InlineChromeHtml(overlayRow) {
    const postId = overlayRow?.overlayPostId;
    const a = overlayRow?.overlayAuthor;
    if (!postId || !a) return '';
    const nick = escapeHtml(String(a.nickname || ''));
    const meatball = buildV2MeatballBtnHtml(overlayRow);
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
    return `<div class="timeline-meal-photo-moment-chrome pointer-events-none absolute inset-0 z-[18]">
            <div class="pointer-events-none w-full" data-moment-v2-chrome-top-wrap>
            <div class="flex items-center justify-between gap-2 px-2">
                <button type="button" class="timeline-meal-photo-moment-chrome-chip pointer-events-auto flex max-w-[min(100%,14rem)] items-center gap-2 rounded-full border border-white/35 bg-white/50 py-0 pl-1 pr-2.5 text-left shadow-sm backdrop-blur-sm active:bg-white/60" onclick='event.stopPropagation();window.filterGalleryByUser && window.filterGalleryByUser(${JSON.stringify(
                    String(a.userId || '')
                )}, ${JSON.stringify(String(a.nickname || ''))})'>
                    ${avatarBlock}
                    <span class="timeline-meal-photo-moment-nick truncate text-base font-bold text-slate-700">${nick}</span>
                </button>
                ${meatball}
            </div>
            </div>
        </div>`;
}

export function buildMomentV2WheelCaptionHtml(photo, menuCaptionPlain, flags) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const { y, mo, day, wd } = getMomentV2DateParts(photo);
    const slotT = getMomentV2SlotWheelLabel(photo, isBestShare, isDailyShare, isInsightShare);
    const menu = (menuCaptionPlain || '').trim() || '—';
    return `<div class="moment-v2-wheel-strip w-full max-w-full min-w-0 overflow-x-hidden scrollbar-hide">
    <div class="timeline-meal-photos-slide-caption-inner flex w-full max-w-full min-w-0 min-h-[30px] items-center rounded-md border border-white/10 bg-black/50 text-white timeline-meal-photo-menu-bar moment-v2-wheel-caption-row">
        <div class="timeline-meal-photos-wheelbar-inner flex min-w-0 shrink-0 items-center gap-0 flex-nowrap">
            ${buildWheelNumericCol(y, true, 'y')}
            <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
            ${buildWheelNumericCol(mo, false, 'mo')}
            <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
            ${buildWheelNumericCol(day, false, 'da')}
            <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
            ${buildWheelLabelCol('meal-photo-wheel-col--weekday', wd, 'wd')}
            <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
            ${buildWheelLabelCol('meal-photo-wheel-col--slot', slotT, 'slot')}
        </div>
        <div class="pointer-events-none min-w-0 flex-1 basis-0 text-right text-white/95 moment-v2-wheel-menu flex items-start justify-end" data-wheel-menu-caption>
            <div class="meal-photo-wheel-label-strip moment-v2-wheel-anim-strip moment-v2-wheel-anim-strip--menu max-w-full" data-moment-v2-f="menu" data-moment-v2-stripe="menu" data-moment-v2-wheel-strip="1">
                <span class="meal-photo-wheel-label-line moment-v2-wheel-menu-anim-line">${escapeHtml(menu)}</span>
            </div>
        </div>
    </div>
</div>`;
}

function buildOneCarouselCell(p, idx, aspectRatio) {
    const isBest = p.type === 'best';
    const isDaily = p.type === 'daily';
    const isInsight = p.type === 'insight';
    const ar = aspectToCss(aspectRatio);
    const url = escapeHtml(String(p.photoUrl || ''));
    const photoBanned = p.banned === true && !isBest && !isDaily && !isInsight;
    const bannedOverlay = photoBanned
        ? `<div class="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-orange-500/20">
            <div class="rounded-lg bg-orange-600 px-3 py-1.5 text-sm text-white shadow-sm"><i class="fa-solid fa-ban mr-1"></i>공유 금지</div>
        </div>`
        : '';
    const maxH = 'min(88vh, calc(100dvh - 7rem))';
    if (isBest || isDaily || isInsight) {
        return `<div class="moment-v2-h-slide timeline-meal-photo-cell flex min-h-0 w-full min-w-full flex-shrink-0 snap-start snap-always flex-col items-stretch justify-start p-0 box-border" data-moment-i="${idx}">
            <div class="flex w-full min-w-0 max-w-full flex-col items-stretch">
                <div class="flex min-h-0 w-full min-w-0 items-start justify-center">
                    <div class="relative w-full max-w-full overflow-hidden rounded-lg bg-transparent shadow-inner" style="max-height: ${maxH};">
                        <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo relative z-0 h-auto w-full object-contain object-top select-none" style="max-height: ${maxH};" loading="${idx === 0 ? 'eager' : 'lazy'}" />
                        ${bannedOverlay}
                    </div>
                </div>
            </div>
        </div>`;
    }
    return `<div class="moment-v2-h-slide timeline-meal-photo-cell flex min-h-0 w-full min-w-full flex-shrink-0 snap-start snap-always flex-col items-stretch justify-start p-0 box-border" data-moment-i="${idx}">
        <div class="flex w-full min-w-0 max-w-full flex-col items-stretch">
            <div class="flex min-h-0 w-full min-w-0 items-start justify-center">
                <div class="timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden rounded-lg bg-slate-100/40 shadow-sm ring-1 ring-slate-200/40" style="aspect-ratio: ${ar}; max-height: ${maxH};">
                    <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo absolute inset-0 z-0 h-full w-full object-cover object-top select-none" loading="${idx === 0 ? 'eager' : 'lazy'}" />
                    ${bannedOverlay}
                </div>
            </div>
        </div>
    </div>`;
}

/**
 * 사진 영역(팝업형 캐러셀) + 분리된 휠 라벨 영역
 */
export function buildMomentFeedV2PhotoAndLabelHtml(params) {
    const {
        photoGroup,
        momentUrlsEncoded,
        photo,
        aspectRatio,
        isBestShare,
        isDailyShare,
        isInsightShare,
        captionTextPlain,
        overlayRow,
        postId: postIdParam,
        postIdJs: postIdJsParam,
        mealHistoryMap,
        groupEntryId
    } = params;
    const ar = aspectRatio === '3:4' || aspectRatio === '4:3' ? aspectRatio : '1:1';
    const n = photoGroup.length;
    const cells = photoGroup.map((p, idx) => buildOneCarouselCell(p, idx, ar)).join('');

    const postIdForUi = String(overlayRow?.overlayPostId || String(postIdParam || ''));
    const postIdJs = postIdJsParam != null ? postIdJsParam : JSON.stringify(String(postIdForUi || ''));
    const momentChrome = overlayRow ? buildV2InlineChromeHtml(overlayRow) : '';
    const socialBar = postIdForUi && overlayRow ? buildV2InlineSocialBarHtml(postIdForUi) : '';

    const counterBadge =
        n > 1
            ? `<div class="pointer-events-none absolute z-10 flex items-baseline gap-0 rounded-md border-0 bg-black/35 px-2 py-1 tabular-nums leading-none text-white/95 shadow-sm backdrop-blur-sm timeline-meal-photos-carousel-badge" data-carousel-badge>
            <span data-carousel-badge-cur class="photo-counter-current carousel-badge-num leading-none">1</span><span class="carousel-badge-sep leading-none" aria-hidden="true">/</span><span class="carousel-badge-num leading-none" data-carousel-badge-tot>${n}</span>
        </div>`
            : `<div class="pointer-events-none absolute z-10 hidden" data-carousel-badge hidden aria-hidden="true"></div>`;

    const carouselBlock = `<div class="moment-v2-photo-shell w-full min-w-0 rounded-lg bg-transparent py-0">
    <div class="timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
        <div class="timeline-meal-photos-carousel-frame relative flex min-h-0 w-full min-w-0 flex-col items-stretch justify-start py-0 px-0" data-photo-index="0" tabindex="-1">
            <div class="timeline-meal-photos-carousel-viewport moment-v2-carousel-viewport moment-v2-carousel-viewport--natural relative min-h-0 w-full min-w-0 overflow-hidden">
                <div class="moment-v2-hstrip timeline-meal-photos-hstrip scrollbar-hide gallery-photo-scroll flex w-full min-w-0 min-h-0 select-none flex-row items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain snap-x snap-mandatory" data-moment-urls="${momentUrlsEncoded}" style="-webkit-overflow-scrolling:touch;touch-action:pan-x;scroll-snap-type:x mandatory;scroll-snap-stop:always" tabindex="-1">
                    ${cells}
                </div>
                ${momentChrome}
                ${socialBar}
                ${counterBadge}
            </div>
        </div>
    </div>
</div>`;

    const wheelBlock = buildMomentV2WheelCaptionHtml(photo, captionTextPlain, {
        isBestShare,
        isDailyShare,
        isInsightShare
    });
    const labelsPayload = buildMomentV2LabelsPayload(
        photoGroup,
        captionTextPlain,
        { isBestShare, isDailyShare, isInsightShare },
        { mealHistoryMap, groupEntryId: groupEntryId != null && groupEntryId !== '' ? String(groupEntryId) : undefined }
    );
    const labelsEncoded = encodeURIComponent(JSON.stringify(labelsPayload));
    const socialPanelBelow =
        postIdForUi && postIdJs ? buildV2SocialCommentPanelHtml(postIdForUi, postIdJs) : '';

    /**
     * 가로: hstrip만 캐러셀. 라벨·코멘트는 사진 열 아래 일반 플로우(가로 스와이프에 같이 끼지 않음). 세로 중앙 JS 보정은 제거(겹침·높이 0 이슈 방지).
     */
    return `<div class="moment-feed-v2-scope flex min-w-0 flex-col" data-moment-v2-root data-moment-v2-labels="${labelsEncoded}">
    <div class="moment-v2-wheel-stage moment-v2-wheel-stage--with-footer moment-v2-wheel-stage--split-caption relative box-border w-full min-w-0 flex flex-col items-stretch overflow-hidden px-0.5" data-moment-v2-wheel-stage>
        <div class="moment-v2-wheel-body flex w-full min-w-0 max-w-full flex-col items-stretch gap-1" data-moment-v2-wheel-body>
        <div class="moment-v2-wheel-center-stack w-full min-w-0 flex flex-col items-stretch" data-moment-v2-center-stack>
        ${carouselBlock}
        </div>
        <div class="moment-v2-dock-slab w-full min-h-0 shrink-0" data-moment-v2-dock-slab aria-hidden="true"></div>
        <div class="moment-v2-caption-footer relative flex w-full min-w-0 max-w-full shrink-0 flex-col justify-center gap-0 px-0" data-moment-v2-caption>
        ${wheelBlock}
        <div class="moment-v2-author-comment-band moment-v2-author-comment-band--toggled pointer-events-auto hidden w-full min-w-0 max-w-full box-border border border-white/10 bg-black/45 px-1.5 py-1.5 text-left text-white shadow-none backdrop-blur-sm" data-moment-v2-author-comment-band>
            <div class="moment-v2-author-comment-body moment-v2-label-font-body min-w-0 text-white/90" data-moment-v2-author-comment-body></div>
        </div>
        ${socialPanelBelow}
        </div>
        </div>
    </div>
</div>`;
}
