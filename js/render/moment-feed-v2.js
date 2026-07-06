/**
 * 모먼트 화면2 — **배치**: `사진 → 라벨(휠) → 기록 코멘트 → 소셜` (다장·단장 동일).
 * 다장: **사진 가로(hstrip)만** 스와이프, 하단 라벨·기록은 첫 사진 기준으로 고정(`data-moment-v2-swipe-photos-only`).
 * 한 장: 세로 스택(vscroll) 경로.
 * 용어: 글쓴이의 기록 = **코멘트** / 달린 소셜 = **댓글**
 */
import { escapeHtml } from './utils.js';
import { getDisplayImageUrl, getBlurImageUrl, imgFallbackAttrs } from '../utils/image-variants.js';
import { SLOTS } from '../constants.js';
import {
    DAILY_JOURNAL_MOMENT_SLOT_LABEL,
    isDailyJournalSharePhoto
} from '../utils/daily-journal-data.js';
import { buildMomentV2MenuLabelLineInnerHtml } from '../main/moment-feed-v2-wheel-layout.js';
import { isDietReportInsightShare, DIET_REPORT_MOMENT_SLOT_LABEL } from '../utils/diet-report-share.js';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function aspectToCss(ar) {
    if (ar === '3:4' || ar === '4:3') return ar === '3:4' ? '3/4' : '4/3';
    return '1/1';
}

/** 공유 문서·기록의 `photoAspectRatio` 우선 — 타임라인/휠 팝업과 동일 1:1·3:4·4:3 */
function normalizePhotoAspectForDisplay(photo, groupFallback) {
    const raw = photo?.photoAspectRatio;
    if (raw === '3:4' || raw === '4:3') return raw;
    if (groupFallback === '3:4' || groupFallback === '4:3') return groupFallback;
    return '1:1';
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

export function getMomentV2SlotWheelLabel(photo, isBest, isDaily, isInsight, entryId) {
    if (isDailyJournalSharePhoto(photo, entryId)) return DAILY_JOURNAL_MOMENT_SLOT_LABEL;
    if (isDaily) return '일간';
    if (isBest) return '베스트';
    if (isInsight) {
        if (isDietReportInsightShare(photo)) return DIET_REPORT_MOMENT_SLOT_LABEL;
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

/** 기록 코멘트(소셜 댓글 아님) */
function buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const eid = p?.entryId || groupEntryId;
    if (isDailyJournalSharePhoto(p, eid)) {
        return (p?.comment || '').replace(/<[^>]*>/g, '').trim();
    }
    const isSnack = p?.slotId && SLOTS.find((s) => s.id === p.slotId)?.type === 'snack';
    if (isBestShare || isDailyShare || isInsightShare) {
        return (p?.comment || '').replace(/<[^>]*>/g, '').trim();
    }
    if (isSnack) {
        return (p?.comment || '').toString().trim();
    }
    let authorMealComment = '';
    if (p?.comment) authorMealComment = String(p.comment).trim();
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
 * @param {{ isBestShare: boolean, isDailyShare: boolean, isInsightShare: boolean }} flags
 * @param {{ mealHistoryMap?: Map, groupEntryId?: string }} [ctx]
 */
export function buildMomentV2LabelsPayload(photoGroup, captionTextPlain, flags, ctx = {}) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const { mealHistoryMap, groupEntryId } = ctx;
    return photoGroup.map((p) => {
        const { y, mo, day, wd } = getMomentV2DateParts(p);
        const eid = p?.entryId || groupEntryId;
        const isDj = isDailyJournalSharePhoto(p, eid);
        const isDietReportShare = isInsightShare && isDietReportInsightShare(p);
        const slotT = getMomentV2SlotWheelLabel(p, isBestShare, isDailyShare, isInsightShare, eid);
        const menuBase =
            isBestShare || isDailyShare || isDj || isDietReportShare
                ? ''
                : (captionTextPlain || '').trim() || '—';
        const ac = buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId);
        return { y, mo, da: day, wd, slot: slotT, menu: menuBase, ac };
    });
}

function buildV2MeatballBtnHtml(overlayRow) {
    const fo = overlayRow?.overlayFeedOptions;
    if (!fo) return '';
    const attr = ` data-meal-feed-options="${encodeURIComponent(JSON.stringify(fo))}"`;
    return `<button type="button" class="timeline-meal-photo-meatball-btn timeline-meal-photo-moment-social-btn pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-0"${attr} data-meal-photo-meatball="1" onclick="event.stopPropagation();window._openMealOverlayFeedOptions&&window._openMealOverlayFeedOptions(this)" aria-label="더보기" aria-haspopup="true"><i class="fa-solid fa-ellipsis-vertical timeline-meal-photo-meatball-icon text-white/95" aria-hidden="true"></i></button>`;
}

function buildV2InlineSocialBarHtml(postId) {
    const p = String(postId || '');
    const pidJson = JSON.stringify(p);
    return `<div class="pointer-events-auto absolute z-[11] flex items-center" data-meal-photo-social-bubble><div class="timeline-meal-photo-moment-social-row flex shrink-0 items-center">
<button type="button" class="post-like-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleLike(${pidJson})' aria-label="좋아요"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i class="fa-solid fa-heart post-like-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-heart post-like-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span><span class="post-like-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-comment-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleCommentInput(${pidJson})' aria-label="댓글"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i class="fa-solid fa-comment post-comment-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-comment post-comment-icon text-white/95 timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span><span class="post-comment-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-bookmark-btn timeline-meal-photo-moment-social-btn relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full overflow-visible" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleBookmark(${pidJson})' aria-label="북마크"><span class="timeline-meal-photo-moment-social-icon-stack absolute inset-0" aria-hidden="true"><i class="fa-solid fa-bookmark post-bookmark-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i class="fa-regular fa-bookmark post-bookmark-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></button>
</div></div>`;
}

function buildV2SocialCommentPanelHtml(postId, postIdJs) {
    const p = String(postId || '');
    return `<div class="comment-section moment-v2-social-comments-panel comments-empty hidden w-full min-w-0 border-t-0 -mx-0 px-0 pt-0 pb-0 moment-v2-social-below-label" id="comment-section-${p}" data-moment-v2-social-comments="1">
        <div class="moment-v2-social-comments-sheet-root">
            <button type="button" class="moment-v2-social-comments-scrim" aria-label="댓글 닫기" onclick='event.preventDefault();event.stopPropagation();window.closeMomentV2SocialCommentSheet&&window.closeMomentV2SocialCommentSheet(${postIdJs})'></button>
            <div class="moment-v2-social-comments-sheet" role="dialog" aria-modal="true" aria-label="댓글">
                <div class="moment-v2-social-comments-sheet-handle" aria-label="아래로 드래그하여 닫기" role="button" tabindex="0"></div>
                <div class="moment-v2-social-comments-sheet-body">
                    <div class="post-comments-list moment-v2-social-comments-list mb-1 rounded-lg py-2" data-post-id="${p}" id="comments-list-${p}"></div>
                </div>
                <div
                    class="moment-v2-social-comments-empty hidden"
                    data-moment-v2-social-comments-empty="1"
                    aria-live="polite"
                >
                    <div class="moment-v2-social-comments-empty-inner">
                        아직 댓글이 없습니다.<br />
                        첫번째 댓글을 남겨주세요
                    </div>
                </div>
                <div id="comment-input-${p}" class="moment-v2-social-comments-input-wrap hidden px-1.5 pt-1.5 pb-2">
                    <div class="moment-v2-social-comments-input-shell relative backdrop-blur-sm">
                        <span class="moment-v2-social-comments-input-avatar" aria-hidden="true"></span>
                        <textarea id="comment-text-${p}" rows="1" placeholder="댓글을 입력하세요…" class="moment-v2-social-comments-input w-full min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent py-1 text-[14px] leading-snug text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-0" onkeydown='if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();window.submitComment(${postIdJs});}'></textarea>
                        <button type="button" class="moment-v2-social-comments-send" data-comment-send-btn="1" data-post-id="${p}" onclick='event.preventDefault();event.stopPropagation();window.submitComment(${postIdJs})' aria-label="입력">
                            <i class="fa-solid fa-arrow-up text-sm" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
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

/**
 * 휠 한 줄(라벨) — 4귀서 R 없음: moment-v2-wheel-caption-row--unit
 */
export function buildMomentV2WheelCaptionHtml(photo, menuCaptionPlain, flags, entryId) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const { y, mo, day, wd } = getMomentV2DateParts(photo);
    const eid = entryId != null && entryId !== '' ? entryId : photo?.entryId;
    const isDailyJournalShare = isDailyJournalSharePhoto(photo, eid);
    const isDietReportShare = isInsightShare && isDietReportInsightShare(photo);
    const slotT = getMomentV2SlotWheelLabel(photo, isBestShare, isDailyShare, isInsightShare, eid);
    let menuCol = '';
    if (!isBestShare && !isDailyShare && !isDailyJournalShare && !isDietReportShare) {
        const menu = (menuCaptionPlain || '').trim() || '—';
        menuCol = `<div class="pointer-events-none min-w-0 flex-1 basis-0 text-right text-white/95 moment-v2-wheel-menu flex items-start justify-end" data-wheel-menu-caption>
            <div class="meal-photo-wheel-label-strip moment-v2-wheel-anim-strip moment-v2-wheel-anim-strip--menu max-w-full" data-moment-v2-f="menu" data-moment-v2-stripe="menu" data-moment-v2-wheel-strip="1">
                <span class="meal-photo-wheel-label-line moment-v2-wheel-menu-anim-line">${buildMomentV2MenuLabelLineInnerHtml(menu)}</span>
            </div>
        </div>`;
    }
    return `<div class="moment-v2-wheel-strip w-full max-w-full min-w-0 overflow-x-hidden scrollbar-hide">
    <div class="timeline-meal-photos-slide-caption-inner flex w-full max-w-full min-w-0 min-h-[30px] items-center rounded-none border border-white/10 bg-black/50 text-white timeline-meal-photo-menu-bar moment-v2-wheel-caption-row moment-v2-wheel-caption-row--unit">
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
        ${menuCol}
    </div>
</div>`;
}

/** 사진 영역만 (크롬/소셜 제외) — vscroll 셀·hstrip 슬라이드 공통 (`ar`은 해당 장 비율) */
function buildV2RawPhotoBlock(p, idx, ar) {
    const isBest = p.type === 'best';
    const isDaily = p.type === 'daily';
    const isInsight = p.type === 'insight';
    const arCss = aspectToCss(ar);
    const originalUrl = String(p.photoUrl || '');
    // 공유 캡처 PNG(daily/best/insight)는 파생본 강제 금지 — 원본 유지. 일반 식사 사진만 800px display 우선.
    const url = escapeHtml(originalUrl);
    const displayRaw = getDisplayImageUrl(p, 0, 'moment-v2.photo') || originalUrl;
    const displayUrl = escapeHtml(displayRaw);
    const displayFallback = imgFallbackAttrs(originalUrl, displayRaw, escapeHtml, 'moment-v2.photo');
    const photoBanned = p.banned === true && !isBest && !isDaily && !isInsight;
    const bannedOverlay = photoBanned
        ? `<div class="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-orange-500/20">
            <div class="rounded-lg bg-orange-600 px-3 py-1.5 text-sm text-white shadow-sm"><i class="fa-solid fa-ban mr-1"></i>공유 금지</div>
        </div>`
        : '';
    const maxH = 'min(88vh, calc(100dvh - 7rem))';
    /** 캡처 PNG 공유 카드: 가로 100%·비율 유지 전체 높이(피드 스크롤). max-height로 세로만 자르면 가로가 줄어 좌우 공백 발생 */
    if (isDaily || isBest || isDietReportInsightShare(p)) {
        return `<div class="moment-v2-photo-surface moment-v2-photo-surface--capture-share relative w-full max-w-full overflow-hidden rounded-t-lg rounded-b-none bg-white shadow-sm ring-1 ring-slate-200/40">
            <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-v2-capture-share-img timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo relative z-0 block h-auto w-full max-w-full select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
            ${bannedOverlay}
        </div>`;
    }
    if (isInsight) {
        return `<div class="moment-v2-photo-surface moment-v2-photo-surface--share-card timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden rounded-t-lg rounded-b-none bg-slate-100/40 shadow-sm ring-1 ring-slate-200/40" style="aspect-ratio: ${arCss}; max-height: ${maxH};">
            <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo absolute inset-0 z-0 h-full w-full object-contain object-center select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
            ${bannedOverlay}
        </div>`;
    }
    return `<div class="moment-v2-photo-surface timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden rounded-t-lg rounded-b-none bg-slate-100/40 shadow-sm ring-1 ring-slate-200/40" style="aspect-ratio: ${arCss}; max-height: ${maxH};">
        <img src="${displayUrl}"${displayFallback} alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo absolute inset-0 z-0 h-full w-full object-cover object-center select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
        ${bannedOverlay}
    </div>`;
}

function buildVScrollPhotoCell(p, idx, groupAspect, hasChrome, postIdForUi, overlayRow) {
    const ar = normalizePhotoAspectForDisplay(p, groupAspect);
    const photoBlock = buildV2RawPhotoBlock(p, idx, ar);
    const momentChrome = hasChrome && overlayRow ? buildV2InlineChromeHtml(overlayRow) : '';
    const socialBar = postIdForUi && overlayRow ? buildV2InlineSocialBarHtml(postIdForUi) : '';
    return `<div class="relative z-[2] flex w-full min-w-0 flex-col">
  <div class="moment-v2-v-photo-clip relative w-full min-w-0 overflow-hidden">
    ${photoBlock}
    ${momentChrome}
    ${socialBar}
  </div>
</div>`;
}

/**
 * 다장: 사진 뷰포트 + (고정) 휠·기록·소셜. 한 장은 세로 스택(vscroll) 유지.
 */
export function buildMomentFeedV2PhotoAndLabelHtml(params) {
    const {
        photoGroup,
        momentUrlsEncoded: _momentUrlsEncoded,
        photo: _first,
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
    const flags = { isBestShare, isDailyShare, isInsightShare };
    const rootDailyAttr = isDailyShare ? ' data-moment-v2-daily-share="1"' : '';
    const rootBestAttr = isBestShare ? ' data-moment-v2-best-share="1"' : '';
    const postIdForUi = String(overlayRow?.overlayPostId || String(postIdParam || ''));
    const postIdJs = postIdJsParam != null ? postIdJsParam : JSON.stringify(String(postIdForUi || ''));
    const n = photoGroup.length;

    const labelsPayload = buildMomentV2LabelsPayload(photoGroup, captionTextPlain, flags, {
        mealHistoryMap,
        groupEntryId: groupEntryId != null && groupEntryId !== '' ? String(groupEntryId) : undefined
    });
    const labelsEncoded = encodeURIComponent(JSON.stringify(labelsPayload));
    const socialPanelBelow = postIdForUi && postIdJs ? buildV2SocialCommentPanelHtml(postIdForUi, postIdJs) : '';

    if (n > 1) {
        const bgsJson = encodeURIComponent(JSON.stringify(photoGroup.map((p) => getBlurImageUrl(p, 0, 'moment-v2.hstrip-bg') || p?.photoUrl || '')));
        const bg0 = String(getBlurImageUrl(photoGroup[0], 0, 'moment-v2.hstrip-bg') || photoGroup[0]?.photoUrl || '').trim();
        const hpostBgBlock =
            !isDailyShare && bg0.length > 0
                ? `<div class="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-lg moment-v2-hpost-bg-wrap" data-moment-v2-hpost-backdrop="1" aria-hidden="true">
  <img src="${escapeHtml(bg0)}" alt="" draggable="false" class="moment-v2-hpost-bg-img" loading="eager" />
  <div class="pointer-events-none absolute inset-0 moment-v2-hpost-bg-dim" aria-hidden="true"></div>
</div>`
                : '';
        const hSlides = photoGroup
            .map(
                (p, idx) =>
                    `<div class="moment-v2-h-slide" data-moment-h-i="${idx}">${buildV2RawPhotoBlock(p, idx, normalizePhotoAspectForDisplay(p, ar))}</div>`
            )
            .join('');
        const firstAc = buildAuthorMealCommentForPhoto(photoGroup[0], flags, mealHistoryMap, groupEntryId);
        const hasFirstAc = Boolean((firstAc || '').trim());
        const firstAcHtml = hasFirstAc
            ? `<div class="whitespace-pre-wrap break-words">${escapeHtml(firstAc)}</div>`
            : '';
        const momentChrome = overlayRow ? buildV2InlineChromeHtml(overlayRow) : '';
        const socialBar = postIdForUi && overlayRow ? buildV2InlineSocialBarHtml(postIdForUi) : '';
        const wheelBlock = buildMomentV2WheelCaptionHtml(photoGroup[0], captionTextPlain, flags, groupEntryId);
        return `<div class="moment-feed-v2-scope flex min-w-0 flex-col" data-moment-v2-root${rootDailyAttr}${rootBestAttr} data-moment-v2-swipe-photos-only="1" data-moment-v2-skip-dock="1" data-moment-v2-labels="${labelsEncoded}">
    <div class="moment-v2-wheel-stage moment-v2-wheel-stage--with-footer moment-v2-wheel-stage--split-caption relative box-border w-full min-w-0 flex flex-col items-stretch overflow-hidden px-0.5" data-moment-v2-wheel-stage>
        <div class="moment-v2-wheel-body flex w-full min-w-0 max-w-full flex-col items-stretch gap-px" data-moment-v2-wheel-body>
        <div class="moment-v2-hpost-ambient relative flex w-full min-w-0 flex-col items-stretch gap-px overflow-hidden rounded-lg" data-moment-v2-hpost-ambient data-moment-v2-hstrip-bgs="${bgsJson}">
        ${hpostBgBlock}
        <div class="relative z-[1] flex w-full min-w-0 min-h-0 flex-col items-stretch gap-px">
        <div class="moment-v2-wheel-center-stack w-full min-w-0 flex flex-col items-stretch" data-moment-v2-center-stack>
    <div class="moment-v2-photo-shell w-full min-w-0 bg-transparent py-0">
    <div class="moment-v2-photo-swipe-zone timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
        <div class="moment-v2-photo-strip-frame timeline-meal-photos-carousel-frame relative flex min-h-0 w-full min-w-0 flex-col items-stretch justify-start py-0 px-0" data-photo-index="0" tabindex="-1" data-moment-v2-legacy-strip="0" role="region" aria-label="게시물 사진">
            <div class="moment-v2-photo-strip-viewport timeline-meal-photos-carousel-viewport moment-v2-carousel-viewport--natural relative w-full min-w-0 min-h-0 shrink-0 overflow-hidden">
                <div class="moment-v2-hstrip scrollbar-hide relative z-[1] flex min-h-0 w-full min-w-0 select-none flex-row overflow-x-auto overflow-y-hidden overscroll-x-contain" style="-webkit-overflow-scrolling:touch" tabindex="-1">
                ${hSlides}
                </div>
                ${momentChrome}
                ${socialBar}
                <div class="moment-v2-photo-page-indicator timeline-meal-photos-carousel-badge pointer-events-none absolute z-[12] flex items-baseline gap-0 rounded-md border-0 bg-black/35 px-2.5 py-1 tabular-nums leading-none text-white/95 shadow-sm backdrop-blur-sm" data-carousel-badge role="status" aria-live="polite" aria-atomic="true" aria-label="사진 장 수">
                    <span data-carousel-badge-cur class="carousel-badge-num leading-none">1</span><span class="carousel-badge-sep leading-none text-white/80" aria-hidden="true">/</span><span data-carousel-badge-tot class="carousel-badge-num leading-none">${n}</span>
                </div>
            </div>
        </div>
    </div>
</div>
        </div>
        <div class="moment-v2-dock-slab w-full min-h-0 shrink-0 hidden" data-moment-v2-dock-slab aria-hidden="true"></div>
        <div class="moment-v2-caption-footer moment-v2-caption-footer--hstrip-below relative flex w-full min-w-0 max-w-full shrink-0 flex-col justify-center gap-0 px-0" data-moment-v2-caption>
        <div class="moment-v2-wheel-hstrip-label w-full min-w-0 max-w-full shrink-0" data-moment-v2-hstrip-footer-wheel>${wheelBlock}</div>
        <div class="moment-v2-author-comment-band moment-v2-author-unit-band relative rounded-b-lg rounded-t-none border border-white/10 bg-black/45 px-0 py-1.5 text-left text-white shadow-none backdrop-blur-sm ${hasFirstAc ? '' : 'hidden'}" data-moment-v2-author-comment-band ${hasFirstAc ? '' : 'hidden'}">
            <div class="moment-v2-author-comment-body moment-v2-label-font-body min-w-0 text-white/90" data-moment-v2-author-comment-body>${firstAcHtml}</div>
            <span class="moment-v2-author-comment-more-hint pointer-events-none" data-moment-v2-author-more-hint aria-hidden="true">
                <span class="moment-v2-author-comment-more-hint-label moment-v2-author-comment-more-hint-label--collapsed">더보기</span>
                <span class="moment-v2-author-comment-more-hint-label moment-v2-author-comment-more-hint-label--expanded">접기</span>
            </span>
        </div>
        ${socialPanelBelow}
        </div>
        </div>
        </div>
        </div>
    </div>
</div>`;
    }

    const vUnits = photoGroup
        .map((p, idx) => {
            const hasChrome = idx === 0;
            const inner = buildVScrollPhotoCell(p, idx, ar, hasChrome, postIdForUi, overlayRow);
            const wheel = buildMomentV2WheelCaptionHtml(p, captionTextPlain, flags, groupEntryId);
            const ac = buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId);
            const hasAc = Boolean((ac || '').trim());
            const acHtml = hasAc
                ? `<div class="whitespace-pre-wrap break-words">${escapeHtml(ac)}</div>`
                : '';
            const bgUrl = String(getBlurImageUrl(p, 0, 'moment-v2.vscroll-bg') || p?.photoUrl || '').trim();
            const bgBlock =
                p.type !== 'daily' && bgUrl.length > 0
                    ? `<div class="pointer-events-none absolute inset-0 z-0 overflow-hidden moment-v2-v-unit-bg-wrap" aria-hidden="true" data-moment-v2-bg-clip>
  <img src="${escapeHtml(bgUrl)}" alt="" draggable="false" class="moment-v2-v-unit-bg-img" loading="${idx === 0 ? 'eager' : 'lazy'}" />
</div>`
                    : '';
            return `<div class="moment-v2-v-unit relative w-full min-w-0" data-moment-v2-v-unit data-moment-i="${idx}" data-moment-v2-n="${n}">
  ${bgBlock}
  <div class="moment-v2-v-unit-stack relative z-[1] flex w-full min-w-0 flex-col gap-px overflow-hidden rounded-t-lg rounded-b-lg">
    ${inner}
    ${wheel}
    <div class="moment-v2-author-comment-band moment-v2-author-unit-band relative rounded-b-lg rounded-t-none border border-white/10 bg-black/45 px-0 py-1.5 text-left text-white shadow-none backdrop-blur-sm ${hasAc ? '' : 'hidden'}" data-moment-v2-author-unit ${hasAc ? '' : 'hidden'} aria-hidden="${hasAc ? 'false' : 'true'}">
      <div class="moment-v2-author-comment-body moment-v2-label-font-body min-w-0 text-white/90" data-moment-v2-author-comment-body-unit>${acHtml}</div>
      <span class="moment-v2-author-comment-more-hint pointer-events-none" data-moment-v2-author-more-hint aria-hidden="true">
        <span class="moment-v2-author-comment-more-hint-label moment-v2-author-comment-more-hint-label--collapsed">더보기</span>
        <span class="moment-v2-author-comment-more-hint-label moment-v2-author-comment-more-hint-label--expanded">접기</span>
      </span>
    </div>
  </div>
</div>`;
        })
        .join('');

    return `<div class="moment-feed-v2-scope flex min-w-0 flex-col" data-moment-v2-root${rootDailyAttr}${rootBestAttr} data-moment-v2-vscroll="1" data-moment-v2-skip-dock="1" data-moment-v2-labels="${labelsEncoded}">
    <div class="moment-v2-wheel-stage moment-v2-wheel-stage--vscroll-photos moment-v2-wheel-stage--with-footer moment-v2-wheel-stage--split-caption relative box-border w-full min-w-0 flex flex-col items-stretch overflow-hidden px-0.5" data-moment-v2-wheel-stage>
        <div class="moment-v2-wheel-body flex w-full min-w-0 max-w-full flex-col items-stretch gap-px" data-moment-v2-wheel-body>
        <div class="moment-v2-wheel-center-stack w-full min-w-0 flex flex-col items-stretch" data-moment-v2-center-stack>
    <div class="moment-v2-photo-shell w-full min-w-0 bg-transparent py-0">
    <div class="timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
        <div class="timeline-meal-photos-carousel-frame moment-v2-vscroll-frame relative flex min-h-0 w-full min-w-0 flex-col items-stretch justify-start py-0 px-0" data-photo-index="0" tabindex="-1" data-moment-v2-legacy-strip="0">
            <div class="moment-v2-photo-vscroll flex w-full min-w-0 flex-col gap-2" data-moment-v2-vscroll-list>
                ${vUnits}
            </div>
        </div>
    </div>
</div>
        </div>
        <div class="moment-v2-dock-slab w-full min-h-0 shrink-0 hidden" data-moment-v2-dock-slab aria-hidden="true"></div>
        <div class="moment-v2-caption-footer moment-v2-caption-footer--social-only relative flex w-full min-w-0 max-w-full shrink-0 flex-col justify-center gap-0 px-0" data-moment-v2-caption>
        ${socialPanelBelow}
        </div>
        </div>
    </div>
</div>`;
}
