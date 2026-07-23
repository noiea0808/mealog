/**
 * 모먼트 화면2 — **배치**: `사진 → 라벨(휠) → 기록 코멘트 → 소셜` (다장·단장 동일).
 * 다장: **사진 가로(hstrip)만** 스와이프, 하단 라벨·기록은 첫 사진 기준으로 고정(`data-moment-v2-swipe-photos-only`).
 * 한 장: 세로 스택(vscroll) 경로.
 * 용어: 글쓴이의 기록 = **코멘트** / 달린 소셜 = **댓글**
 */
import { escapeHtml } from './utils.js';
import { getDisplayImageUrl, imgFallbackAttrs } from '../utils/image-variants.js';
import { SLOTS } from '../constants.js';
import {
    DAILY_JOURNAL_MOMENT_SLOT_LABEL,
    isDailyJournalSharePhoto
} from '../utils/daily-journal-data.js';
import { isDietReportInsightShare, DIET_REPORT_MOMENT_SLOT_LABEL } from '../utils/diet-report-share.js';
import { formatMealMenuDisplayLine, mergeMealDisplayFields } from '../utils/meal-display-line.js';

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

function aspectToCss(ar) {
    if (ar === '3:4') return '3/4';
    if (ar === '4:3') return '4/3';
    return '1';
}

/** 기록 시트 비율(1:1·3:4·4:3)을 모먼트 프레임에 그대로 반영. 기본 1:1 */
function normalizePhotoAspectForDisplay(photo, groupFallback) {
    const raw = photo?.photoAspectRatio;
    if (raw === '1:1' || raw === '3:4' || raw === '4:3') return raw;
    if (groupFallback === '1:1' || groupFallback === '3:4' || groupFallback === '4:3') {
        return groupFallback;
    }
    return '1:1';
}

function buildMomentV2PhotoDotsHtml(n) {
    const count = Math.max(0, Number(n) || 0);
    if (count < 2) return '';
    const spans = Array.from({ length: count }, (_, i) =>
        `<span${i === 0 ? ' class="on"' : ''}></span>`
    ).join('');
    return `<div class="moment-v2-photo-dots" data-moment-v2-dots aria-hidden="true">${spans}</div>`;
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

/** 기록 코멘트(소셜 댓글 아님) */
function buildAuthorMealCommentForPhoto(p, flags, mealHistoryMap, groupEntryId) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const rawEid = p?.entryId || groupEntryId;
    const eid =
        rawEid != null && rawEid !== '' && String(rawEid) !== 'null' ? String(rawEid) : '';
    const strip = (v) =>
        String(v || '')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .trim();

    if (isDailyJournalSharePhoto(p, eid)) return strip(p?.comment);
    if (isBestShare || isDailyShare || isInsightShare) return strip(p?.comment);

    let authorMealComment = strip(p?.comment);
    if (!authorMealComment && eid && mealHistoryMap) {
        const mealRecord = mealHistoryMap.get(eid) || mealHistoryMap.get(String(eid));
        if (mealRecord?.comment) authorMealComment = strip(mealRecord.comment);
    }
    if (
        !authorMealComment &&
        typeof window !== 'undefined' &&
        Array.isArray(window.mealHistory) &&
        p?.date &&
        p?.slotId
    ) {
        const matchingRecord = window.mealHistory.find(
            (m) =>
                m.date === p.date &&
                m.slotId === p.slotId &&
                (!eid || String(m.id) === eid) &&
                (p.comment ? m.comment === p.comment : true)
        );
        if (matchingRecord?.comment) authorMealComment = strip(matchingRecord.comment);
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
    return `<button type="button" class="timeline-meal-photo-meatball-btn timeline-meal-photo-moment-social-btn pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0"${attr} data-meal-photo-meatball="1" onclick="event.stopPropagation();window._openMealOverlayFeedOptions&&window._openMealOverlayFeedOptions(this)" aria-label="더보기" aria-haspopup="true"><i data-lucide="ellipsis" class="timeline-meal-photo-meatball-icon text-white/95" aria-hidden="true"></i></button>`;
}

function buildV2InlineSocialBarHtml(postId) {
    const p = String(postId || '');
    const pidJson = JSON.stringify(p);
    return `<div class="moment-v2-social-below-photo pointer-events-auto flex items-center" data-meal-photo-social-bubble><div class="timeline-meal-photo-moment-social-row flex w-full items-center">
<button type="button" class="post-like-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleLike(${pidJson})' aria-label="좋아요"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i data-lucide="heart" class="post-like-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i data-lucide="heart" class="post-like-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span><span class="post-like-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-comment-btn timeline-meal-photo-moment-social-btn timeline-meal-photo-moment-social-hit inline-flex h-8 min-h-8 shrink-0 items-center justify-center gap-0 rounded-full" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleCommentInput(${pidJson})' aria-label="댓글"><span class="timeline-meal-photo-moment-social-icon-slot inline-flex h-8 w-8 shrink-0 items-center justify-center relative" aria-hidden="true"><span class="timeline-meal-photo-moment-social-icon-stack w-full h-full min-h-0 min-w-0"><i data-lucide="message-circle" class="post-comment-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i data-lucide="message-circle" class="post-comment-icon text-white/95 timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></span><span class="post-comment-count timeline-meal-photo-moment-social-count pointer-events-none tabular-nums" data-post-id="${escapeHtml(
        p
    )}" aria-hidden="true"></span></button>
<button type="button" class="post-bookmark-btn timeline-meal-photo-moment-social-btn relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full overflow-visible" data-post-id="${escapeHtml(
        p
    )}" data-requires-login="true" onclick='event.stopPropagation();window.toggleBookmark(${pidJson})' aria-label="북마크"><span class="timeline-meal-photo-moment-social-icon-stack absolute inset-0" aria-hidden="true"><i data-lucide="bookmark" class="post-bookmark-fill timeline-meal-photo-moment-social-icon-fill" aria-hidden="true"></i><i data-lucide="bookmark" class="post-bookmark-icon timeline-meal-photo-moment-social-icon relative z-[1]" aria-hidden="true"></i></span></button>
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
                            <i data-lucide="arrow-up" class="text-sm" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
}

function resolveMomentV2Place(photo, mealHistoryMap, groupEntryId) {
    const direct = String(photo?.place || photo?.snackPlace || '').trim();
    if (direct) return direct;
    const eid = photo?.entryId || groupEntryId;
    if (eid && mealHistoryMap && mealHistoryMap.has(eid)) {
        const rec = mealHistoryMap.get(eid);
        const p = String(rec?.place || rec?.snackPlace || '').trim();
        if (p) return p;
    }
    return '';
}

/** 메뉴 제목만 (장소·플레이스홀더 제외). 비어 있으면 '' */
function resolveMomentV2MenuTitle(photo, mealHistoryMap, groupEntryId, flags) {
    const { isBestShare, isDailyShare, isInsightShare } = flags;
    const eid = photo?.entryId || groupEntryId;
    if (isBestShare || isDailyShare || isInsightShare) return '';
    if (isDailyJournalSharePhoto(photo, eid)) return '';
    if (isDietReportInsightShare(photo)) return '';
    const isSnack = photo?.slotId && SLOTS.find((s) => s.id === photo.slotId)?.type === 'snack';
    if (isSnack) {
        return String(photo?.menuDetail || photo?.snackType || '').trim();
    }
    const meal =
        eid && mealHistoryMap && mealHistoryMap.has(eid)
            ? mergeMealDisplayFields(photo, mealHistoryMap.get(eid))
            : photo;
    const line = String(formatMealMenuDisplayLine(meal) || '').trim();
    if (line) return line;
    return String(photo?.mealType || '').trim();
}

function formatMomentV2AuthorSub(photo, flags = {}, entryId) {
    const { mo, day, wd } = getMomentV2DateParts(photo);
    if (mo === '—' || day === '—') return '';
    const monthNum = Number(mo);
    const dayNum = Number(day);
    if (!Number.isFinite(monthNum) || !Number.isFinite(dayNum)) return '';
    const datePart = `${monthNum}월 ${dayNum}일${wd && wd !== '—' ? ` ${wd}요일` : ''}`;
    const { isBestShare = false, isDailyShare = false, isInsightShare = false } = flags;
    const slotT = getMomentV2SlotWheelLabel(photo, isBestShare, isDailyShare, isInsightShare, entryId);
    if (slotT && slotT !== '—') return `${datePart} · ${slotT}`;
    return datePart;
}

/** 시안 v2: 작성자 행은 사진 위가 아니라 본문 */
function buildV2AuthorRowHtml(overlayRow, photo, flags = {}, entryId) {
    const postId = overlayRow?.overlayPostId;
    const a = overlayRow?.overlayAuthor;
    if (!postId || !a) return '';
    const nick = escapeHtml(String(a.nickname || ''));
    const sub = escapeHtml(formatMomentV2AuthorSub(photo, flags, entryId));
    const meatball = buildV2MeatballBtnHtml(overlayRow).replace(
        'timeline-meal-photo-meatball-icon text-white/95',
        'timeline-meal-photo-meatball-icon moment-v2-more-icon'
    );
    let avatarBlock;
    if (a.avatarType === 'photo' && a.avatarValue) {
        const url = escapeHtml(String(a.avatarValue));
        const inner = `<div class="moment-v2-avatar" style="background-image:url('${url}')" role="img" aria-label="${nick}"></div>`;
        avatarBlock = a.isGuestPost
            ? `<div class="relative shrink-0">${inner}<span class="absolute bottom-0 right-0 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white bg-slate-700 text-[7px] font-bold text-white">게</span></div>`
            : inner;
    } else {
        const ch = escapeHtml(String(a.avatarValue || '?'));
        avatarBlock = `<div class="moment-v2-avatar moment-v2-avatar--fallback" aria-hidden="true">${ch}</div>`;
    }
    return `<div class="moment-v2-author-row">
        <button type="button" class="moment-v2-author-hit flex min-w-0 flex-1 items-center gap-2.5 text-left" onclick='event.stopPropagation();window.filterGalleryByUser && window.filterGalleryByUser(${JSON.stringify(
            String(a.userId || '')
        )}, ${JSON.stringify(String(a.nickname || ''))})'>
            ${avatarBlock}
            <span class="moment-v2-author-meta min-w-0 flex-1">
                <span class="moment-v2-author-name block truncate">${nick}</span>
                ${sub ? `<span class="moment-v2-author-sub block truncate">${sub}</span>` : ''}
            </span>
        </button>
        ${meatball}
    </div>`;
}

/**
 * 시안 v2 본문 캡션: 장소 / 메뉴 제목 / 코멘트
 * (슬롯명은 작성자 행 날짜 옆 · 비어 있는 항목은 DOM에 넣지 않음)
 */
function buildMomentV2BodyCaptionHtml(photo, menuCaptionPlain, flags, entryId, mealHistoryMap, groupEntryId) {
    const { isBestShare } = flags;
    const specialChip = isBestShare
        ? `<div class="moment-v2-special-chip"><i data-lucide="crown" aria-hidden="true"></i> 이번 주 베스트</div>`
        : '';
    /* 슬롯명은 작성자 행 날짜 오른쪽에 표시 — 본문 메타는 장소만 */
    const place = resolveMomentV2Place(photo, mealHistoryMap, groupEntryId);
    const metaHtml = place
        ? `<div class="moment-v2-meal-meta">${escapeHtml(place)}</div>`
        : '';

    const menuFromFields = resolveMomentV2MenuTitle(photo, mealHistoryMap, groupEntryId, flags);
    let menu = menuFromFields;
    if (!menu && menuCaptionPlain) {
        /* 레거시 captionText에 "메뉴 @ 장소"가 오면 메뉴만 사용 */
        const plain = String(menuCaptionPlain).trim();
        if (plain && plain !== '—' && plain !== '간식') {
            menu = plain.includes(' @ ') ? plain.split(' @ ')[0].trim() : plain;
            if (menu.startsWith('@')) menu = '';
        }
    }
    const titleHtml = menu
        ? `<div class="moment-v2-meal-title" data-wheel-menu-caption>
            <span class="moment-v2-meal-title-text">${escapeHtml(menu)}</span>
          </div>`
        : '';

    const note = buildAuthorMealCommentForPhoto(photo, flags, mealHistoryMap, groupEntryId);
    const noteHtml = note
        ? `<div class="moment-v2-meal-note">
            <div class="whitespace-pre-wrap break-words">${escapeHtml(note)}</div>
          </div>`
        : '';

    const headingHtml = (metaHtml || titleHtml)
        ? `<div class="moment-v2-meal-heading">${metaHtml}${titleHtml}</div>`
        : '';

    if (!specialChip && !headingHtml && !noteHtml) return '';
    return `<div class="moment-v2-body-caption">
        ${specialChip}
        ${headingHtml}
        ${noteHtml}
    </div>`;
}

/** @deprecated 사진 위 칩 — 시안에서는 사용하지 않음(호환용 no-op) */
function buildV2InlineChromeHtml(_overlayRow) {
    return '';
}

/** 사진 영역만 — 시안: wrap #e2e8f0, cover, 비율 1:1·3:4·4:3 (세로 3:4 max 420px) */
function buildV2RawPhotoBlock(p, idx, ar) {
    const isBest = p.type === 'best';
    const isDaily = p.type === 'daily';
    const isInsight = p.type === 'insight';
    const arCss = aspectToCss(ar);
    const originalUrl = String(p.photoUrl || '').trim();
    if (!originalUrl) return '';
    // 공유 캡처 PNG(daily/best/insight)는 파생본 강제 금지 — 원본 유지. 일반 식사 사진만 800px display 우선.
    const url = escapeHtml(originalUrl);
    const displayRaw = getDisplayImageUrl(p, 0, 'moment-v2.photo') || originalUrl;
    const displayUrl = escapeHtml(displayRaw);
    const displayFallback = imgFallbackAttrs(originalUrl, displayRaw, escapeHtml, 'moment-v2.photo');
    const photoBanned = p.banned === true && !isBest && !isDaily && !isInsight;
    const bannedOverlay = photoBanned
        ? `<div class="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center bg-orange-500/20">
            <div class="rounded-lg bg-orange-600 px-3 py-1.5 text-sm text-white shadow-sm"><i data-lucide="ban" class="mr-1"></i>공유 금지</div>
        </div>`
        : '';
    const maxH = ar === '3:4' ? '420px' : 'none';
    /** 캡처 PNG 공유 카드: 가로 100%·비율 유지 전체 높이(피드 스크롤). max-height로 세로만 자르면 가로가 줄어 좌우 공백 발생 */
    if (isDaily || isBest || isDietReportInsightShare(p)) {
        return `<div class="moment-v2-photo-surface moment-v2-photo-surface--capture-share relative w-full max-w-full overflow-hidden">
            <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="moment-v2-capture-share-img timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo relative z-0 block h-auto w-full max-w-full select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
            ${bannedOverlay}
        </div>`;
    }
    if (isInsight) {
        return `<div class="moment-v2-photo-surface moment-v2-photo-surface--share-card timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden" style="aspect-ratio: ${arCss}; max-height: ${maxH};">
            <img src="${url}" alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo absolute inset-0 z-0 h-full w-full object-contain object-center select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
            ${bannedOverlay}
        </div>`;
    }
    return `<div class="moment-v2-photo-surface timeline-meal-photo-aspect-slot relative w-full max-w-full overflow-hidden" style="aspect-ratio: ${arCss}; max-height: ${maxH};">
        <img src="${displayUrl}"${displayFallback} alt="공유된 사진 ${idx + 1}" draggable="false" class="timeline-meal-photo-img moment-v2-carousel-photo moment-feed-photo absolute inset-0 z-0 h-full w-full object-cover object-center select-none" loading="${idx <= 1 ? 'eager' : 'lazy'}" />
        ${bannedOverlay}
    </div>`;
}

function buildVScrollPhotoCell(p, idx, groupAspect, hasChrome, postIdForUi, overlayRow) {
    const ar = normalizePhotoAspectForDisplay(p, groupAspect);
    const photoBlock = buildV2RawPhotoBlock(p, idx, ar);
    return `<div class="relative z-[2] flex w-full min-w-0 flex-col">
  <div class="moment-v2-v-photo-clip relative w-full min-w-0 overflow-hidden">
    ${photoBlock}
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
    const ar =
        aspectRatio === '1:1' || aspectRatio === '3:4' || aspectRatio === '4:3' ? aspectRatio : '1:1';
    const flags = { isBestShare, isDailyShare, isInsightShare };
    const rootDailyAttr = isDailyShare ? ' data-moment-v2-daily-share="1"' : '';
    const rootBestAttr = isBestShare ? ' data-moment-v2-best-share="1"' : '';
    const rootSpecialAttr = isBestShare ? ' data-moment-v2-special="1"' : '';
    const postIdForUi = String(overlayRow?.overlayPostId || String(postIdParam || ''));
    const postIdJs = postIdJsParam != null ? postIdJsParam : JSON.stringify(String(postIdForUi || ''));
    const photosWithUrl = (photoGroup || []).filter((p) => String(p?.photoUrl || '').trim());
    const n = photosWithUrl.length;
    const leadPhoto = photosWithUrl[0] || photoGroup[0];

    const labelsPayload = buildMomentV2LabelsPayload(photoGroup, captionTextPlain, flags, {
        mealHistoryMap,
        groupEntryId: groupEntryId != null && groupEntryId !== '' ? String(groupEntryId) : undefined
    });
    const labelsEncoded = encodeURIComponent(JSON.stringify(labelsPayload));
    const socialPanelBelow = postIdForUi && postIdJs ? buildV2SocialCommentPanelHtml(postIdForUi, postIdJs) : '';
    const authorRow = overlayRow
        ? buildV2AuthorRowHtml(overlayRow, leadPhoto, flags, groupEntryId)
        : '';
    const bodyCaption = buildMomentV2BodyCaptionHtml(
        leadPhoto,
        captionTextPlain,
        flags,
        groupEntryId,
        mealHistoryMap,
        groupEntryId
    );
    const socialBar = postIdForUi && overlayRow ? buildV2InlineSocialBarHtml(postIdForUi) : '';
    const bodySpecialCls = isBestShare ? ' moment-v2-body--special' : '';

    let photoBlockHtml = '';
    if (n > 1) {
        const hSlides = photosWithUrl
            .map((p, idx) => {
                const block = buildV2RawPhotoBlock(p, idx, normalizePhotoAspectForDisplay(p, ar));
                if (!block) return '';
                return `<div class="moment-v2-h-slide" data-moment-h-i="${idx}">${block}</div>`;
            })
            .filter(Boolean)
            .join('');
        const dotsHtml = buildMomentV2PhotoDotsHtml(n);
        photoBlockHtml = `<div class="moment-v2-photo-shell moment-v2-photo-wrap w-full min-w-0 py-0">
    <div class="moment-v2-photo-swipe-zone timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
        <div class="moment-v2-photo-strip-frame timeline-meal-photos-carousel-frame relative flex min-h-0 w-full min-w-0 flex-col items-stretch justify-start py-0 px-0" data-photo-index="0" tabindex="-1" data-moment-v2-legacy-strip="0" role="region" aria-label="게시물 사진">
            <div class="moment-v2-photo-strip-viewport timeline-meal-photos-carousel-viewport moment-v2-carousel-viewport--natural relative w-full min-w-0 min-h-0 shrink-0 overflow-hidden">
                <div class="moment-v2-hstrip scrollbar-hide relative z-[1] flex min-h-0 w-full min-w-0 select-none flex-row overflow-x-auto overflow-y-hidden overscroll-x-contain" style="-webkit-overflow-scrolling:touch" tabindex="-1">
                ${hSlides}
                </div>
                <div class="moment-v2-multi-badge timeline-meal-photos-carousel-badge pointer-events-none absolute z-[12]" data-carousel-badge role="status" aria-live="polite" aria-atomic="true" aria-label="사진 장 수">
                    <span data-carousel-badge-cur>1</span><span aria-hidden="true"> / </span><span data-carousel-badge-tot>${n}</span>
                </div>
                ${dotsHtml}
            </div>
        </div>
    </div>
</div>`;
        return `<div class="moment-feed-v2-scope flex min-w-0 flex-col" data-moment-v2-root${rootDailyAttr}${rootBestAttr}${rootSpecialAttr} data-moment-v2-swipe-photos-only="1" data-moment-v2-skip-dock="1" data-moment-v2-labels="${labelsEncoded}">
    <div class="moment-v2-wheel-stage moment-v2-wheel-stage--with-footer moment-v2-wheel-stage--split-caption relative box-border w-full min-w-0 flex flex-col items-stretch overflow-hidden px-0" data-moment-v2-wheel-stage>
        <div class="moment-v2-wheel-body flex w-full min-w-0 max-w-full flex-col items-stretch" data-moment-v2-wheel-body>
        <div class="moment-v2-wheel-center-stack w-full min-w-0 flex flex-col items-stretch" data-moment-v2-center-stack>
    ${photoBlockHtml}
        </div>
        <div class="moment-v2-dock-slab w-full min-h-0 shrink-0 hidden" data-moment-v2-dock-slab aria-hidden="true"></div>
        <div class="moment-v2-caption-footer moment-v2-body${bodySpecialCls} relative flex w-full min-w-0 max-w-full shrink-0 flex-col justify-center gap-0 px-0" data-moment-v2-caption>
        ${authorRow}
        ${bodyCaption}
        ${socialBar}
        ${socialPanelBelow}
        </div>
        </div>
    </div>
</div>`;
    }

    /* 한 장(또는 사진 없음): 본문(작성자 / 슬롯·장소 / 메뉴 / 코멘트 / 소셜) — 시안 v2 */
    if (n === 1) {
        const inner = buildVScrollPhotoCell(leadPhoto, 0, ar, false, postIdForUi, overlayRow);
        photoBlockHtml = `<div class="moment-v2-photo-shell moment-v2-photo-wrap w-full min-w-0 py-0">
    <div class="timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch">
        <div class="timeline-meal-photos-carousel-frame moment-v2-vscroll-frame relative flex min-h-0 w-full min-w-0 flex-col items-stretch justify-start py-0 px-0" data-photo-index="0" tabindex="-1" data-moment-v2-legacy-strip="0">
            <div class="moment-v2-photo-vscroll flex w-full min-w-0 flex-col" data-moment-v2-vscroll-list>
                <div class="moment-v2-v-unit relative w-full min-w-0" data-moment-v2-v-unit data-moment-i="0" data-moment-v2-n="1">
                  <div class="moment-v2-v-unit-stack relative z-[1] flex w-full min-w-0 flex-col overflow-hidden">
                    ${inner}
                  </div>
                </div>
            </div>
        </div>
    </div>
</div>`;
    }

    return `<div class="moment-feed-v2-scope flex min-w-0 flex-col" data-moment-v2-root${rootDailyAttr}${rootBestAttr}${rootSpecialAttr} data-moment-v2-vscroll="1" data-moment-v2-skip-dock="1" data-moment-v2-labels="${labelsEncoded}">
    <div class="moment-v2-wheel-stage moment-v2-wheel-stage--vscroll-photos moment-v2-wheel-stage--with-footer moment-v2-wheel-stage--split-caption relative box-border w-full min-w-0 flex flex-col items-stretch overflow-hidden px-0" data-moment-v2-wheel-stage>
        <div class="moment-v2-wheel-body flex w-full min-w-0 max-w-full flex-col items-stretch" data-moment-v2-wheel-body>
        <div class="moment-v2-wheel-center-stack w-full min-w-0 flex flex-col items-stretch" data-moment-v2-center-stack>
    ${photoBlockHtml}
        </div>
        <div class="moment-v2-dock-slab w-full min-h-0 shrink-0 hidden" data-moment-v2-dock-slab aria-hidden="true"></div>
        <div class="moment-v2-caption-footer moment-v2-body${bodySpecialCls} relative flex w-full min-w-0 max-w-full shrink-0 flex-col justify-center gap-0 px-0" data-moment-v2-caption>
        ${authorRow}
        ${bodyCaption}
        ${socialBar}
        ${socialPanelBelow}
        </div>
        </div>
    </div>
</div>`;
}
