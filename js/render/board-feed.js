/**
 * 밀톡 피드 탭 — feedPosts 전용 (게시판 boardPosts와 분리)
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { escapeHtml } from './utils.js';
import { fetchUserProfiles } from './user-profiles.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';
import { isDemoUser } from '../demo-account.js';
import { FEED_TIMELINE_BATCH_SIZE } from '../db/feed-posts.js';

/** paintFeedTimeline마다 이전 관찰자 해제 — 레이아웃 변화 시 스크롤 한 번만 보정 */
let _feedScrollResizeCleanup = null;

let _feedLoadOlderInFlight = false;
/** 빠른 플링 시 scrollTop이 요청 중에 0으로 안착하는데, 예전 prevST로 복원하면 화면이 덜컥거림 → 디바운스 */
let _feedOlderNearTopDebounce = null;
const FEED_OLDER_NEAR_TOP_DEBOUNCE_MS = 100;

function getBoardLoungeScrollEl() {
    return document.getElementById('boardLoungeScrollArea');
}

/** quietRefresh 시 서버 최신 페이지와 이미 스크롤로 불러 둔 오래된 메시지 병합 */
function mergeFeedQuietRefreshFirstPage(serverPosts, existingWithoutPending) {
    const server = (serverPosts || []).filter((p) => p && p.isHidden !== true);
    const existing = existingWithoutPending || [];
    if (!server.length) {
        return existing.length
            ? [...existing].sort((a, b) => getPostTimestampMs(a) - getPostTimestampMs(b))
            : [];
    }
    const serverIds = new Set(server.map((p) => String(p.id)));
    const minServerTs = Math.min(...server.map(getPostTimestampMs));
    const preserved = existing.filter((p) => {
        const id = String(p.id);
        if (serverIds.has(id)) return false;
        return getPostTimestampMs(p) < minServerTs;
    });
    const byId = new Map();
    preserved.forEach((p) => byId.set(String(p.id), p));
    server.forEach((p) => byId.set(String(p.id), p));
    return Array.from(byId.values()).sort((a, b) => getPostTimestampMs(a) - getPostTimestampMs(b));
}

function ensureBoardFeedScrollOlderBound() {
    const el = getBoardLoungeScrollEl();
    if (!el || el.dataset.feedOlderScrollBound === '1') return;
    el.dataset.feedOlderScrollBound = '1';
    el.addEventListener('scroll', onBoardFeedPanelScrollOlder, { passive: true });
}

function onBoardFeedPanelScrollOlder() {
    const el = getBoardLoungeScrollEl();
    if (!el || appState.boardListSubTab !== 'feed') return;
    if (el.scrollTop > 72) {
        if (_feedOlderNearTopDebounce) {
            clearTimeout(_feedOlderNearTopDebounce);
            _feedOlderNearTopDebounce = null;
        }
        return;
    }
    if (_feedOlderNearTopDebounce) clearTimeout(_feedOlderNearTopDebounce);
    _feedOlderNearTopDebounce = setTimeout(() => {
        _feedOlderNearTopDebounce = null;
        const root = getBoardLoungeScrollEl();
        if (!root || appState.boardListSubTab !== 'feed') return;
        if (root.dataset.feedLoadingOlder === '1') return;
        if (!appState.feedTimelineHasMore) return;
        if (!appState.feedTimelineOldestCursor) return;
        if (_feedLoadOlderInFlight) return;
        if (root.scrollTop > 72) return;
        void loadMoreFeedOlderMessages();
    }, FEED_OLDER_NEAR_TOP_DEBOUNCE_MS);
}

async function loadMoreFeedOlderMessages() {
    if (_feedLoadOlderInFlight || !appState.feedTimelineHasMore || !appState.feedTimelineOldestCursor) return;
    const root = getBoardLoungeScrollEl();
    const content = document.getElementById('boardFeedPanelContent');
    if (!root || !content || !window.feedOperations?.getMessagesPage) return;
    _feedLoadOlderInFlight = true;
    root.dataset.feedLoadingOlder = '1';
    try {
        const { posts, cursorSnap, hasMore } = await window.feedOperations.getMessagesPage({
            limitCount: FEED_TIMELINE_BATCH_SIZE,
            startAfterSnapshot: appState.feedTimelineOldestCursor
        });
        appState.feedTimelineOldestCursor = cursorSnap;
        appState.feedTimelineHasMore = hasMore;

        const existing = appState.feedTimelinePosts || [];
        const byId = new Map();
        existing.forEach((p) => {
            if (p) byId.set(String(p.id), p);
        });
        (posts || []).forEach((p) => {
            if (p && p.isHidden !== true) byId.set(String(p.id), p);
        });
        const merged = Array.from(byId.values()).sort((a, b) => getPostTimestampMs(a) - getPostTimestampMs(b));

        const authorIds = [...new Set((posts || []).map((p) => p.authorId).filter(Boolean))];
        if (authorIds.length) await fetchUserProfiles(authorIds);

        appState.feedTimelinePosts = merged;
        // DOM 갱신 직전 시점 기준으로 보정(요청 시작 시 scrollTop을 쓰면 플링 중 값과 달라져 덜컥거림)
        const scrollHeightBeforePaint = root.scrollHeight;
        const scrollTopBeforePaint = root.scrollTop;
        // paint·scrollTop 보정이 한 번에 큰 delta로 잡혀 헤더/서브탭이 숨겨지지 않도록
        window.__suppressBoardPanelScrollHideNavUntil = Date.now() + 720;
        paintFeedTimeline(content, merged);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const added = root.scrollHeight - scrollHeightBeforePaint;
                root.scrollTop = scrollTopBeforePaint + added;
                if (typeof window.__syncBoardPanelScrollNavLast === 'function') {
                    window.__syncBoardPanelScrollNavLast();
                }
            });
        });
    } catch (e) {
        console.error('[loadMoreFeedOlderMessages]', e);
    } finally {
        _feedLoadOlderInFlight = false;
        delete root.dataset.feedLoadingOlder;
    }
}

let _feedImageLightboxOverlay = null;
let _feedImageLightboxUrl = '';
let _feedImageLightboxKeyHandler = null;
let _feedImageClickDelegateBound = false;

function feedLightboxExtFromMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    return 'jpg';
}

function closeFeedImageLightbox() {
    if (!_feedImageLightboxOverlay || _feedImageLightboxOverlay.classList.contains('hidden')) return;
    _feedImageLightboxOverlay.classList.add('hidden');
    _feedImageLightboxOverlay.setAttribute('aria-hidden', 'true');
    const img = _feedImageLightboxOverlay.querySelector('[data-feed-lb-img]');
    if (img) {
        img.removeAttribute('src');
        img.alt = '';
    }
    _feedImageLightboxUrl = '';
    if (_feedImageLightboxKeyHandler) {
        document.removeEventListener('keydown', _feedImageLightboxKeyHandler);
        _feedImageLightboxKeyHandler = null;
    }
}

async function downloadFeedLightboxImage(url) {
    if (!url) return;
    try {
        if (url.startsWith('blob:')) {
            const a = document.createElement('a');
            a.href = url;
            a.download = `mealog-feed-${Date.now()}.jpg`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            showToast('다운로드를 시작했어요.', 'success');
            return;
        }
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) throw new Error('fetch');
        const blob = await res.blob();
        const ext = feedLightboxExtFromMime(blob.type);
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `mealog-feed-${Date.now()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
        showToast('다운로드를 시작했어요.', 'success');
    } catch (_) {
        showToast('브라우저에서 저장이 막혀 새 탭으로 열었어요.', 'info');
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

function openFeedImageLightbox(imageUrl) {
    const u = typeof imageUrl === 'string' ? imageUrl.trim() : '';
    if (!u) return;
    if (_feedImageLightboxKeyHandler) {
        document.removeEventListener('keydown', _feedImageLightboxKeyHandler);
        _feedImageLightboxKeyHandler = null;
    }
    _feedImageLightboxUrl = u;
    if (!_feedImageLightboxOverlay) {
        _feedImageLightboxOverlay = document.createElement('div');
        _feedImageLightboxOverlay.id = 'feedImageLightbox';
        /* 본문과 동일 max-w-md 폭 안에서만 표시(데스크톡 웹에서 뷰포트 전체로 퍼지지 않게) */
        _feedImageLightboxOverlay.className =
            'hidden fixed inset-0 z-[10001] flex justify-center bg-slate-950/90 backdrop-blur-sm';
        _feedImageLightboxOverlay.setAttribute('role', 'dialog');
        _feedImageLightboxOverlay.setAttribute('aria-modal', 'true');
        _feedImageLightboxOverlay.setAttribute('aria-labelledby', 'feedImageLightboxTitle');
        _feedImageLightboxOverlay.innerHTML = `
            <div class="flex h-full w-full max-w-md min-h-0 flex-col">
            <div class="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <h2 id="feedImageLightboxTitle" class="sr-only">밀톡 사진</h2>
                <span class="text-xs font-medium text-white/80">사진</span>
                <div class="flex items-center gap-2">
                    <button type="button" data-feed-lb-download class="inline-flex h-10 min-w-[2.5rem] items-center justify-center gap-1.5 rounded-full bg-white/15 px-3 text-sm font-medium text-white hover:bg-white/25 active:bg-white/20" aria-label="다운로드">
                        <i class="fa-solid fa-download" aria-hidden="true"></i>
                        <span class="hidden sm:inline">다운로드</span>
                    </button>
                    <button type="button" data-feed-lb-close class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 active:bg-white/20" aria-label="닫기">
                        <i class="fa-solid fa-times text-lg leading-none" aria-hidden="true"></i>
                    </button>
                </div>
            </div>
            <div class="feed-lightbox-stage flex min-h-0 flex-1 cursor-default items-center justify-center overflow-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]" data-feed-lb-stage>
                <img data-feed-lb-img alt="" class="max-h-[min(82vh,100dvh-6rem)] w-full max-w-full object-contain rounded-lg shadow-2xl" />
            </div>
            </div>
        `;
        document.body.appendChild(_feedImageLightboxOverlay);
        const stage = _feedImageLightboxOverlay.querySelector('[data-feed-lb-stage]');
        stage?.addEventListener('click', (e) => {
            if (e.target === stage) closeFeedImageLightbox();
        });
        _feedImageLightboxOverlay.querySelector('[data-feed-lb-close]')?.addEventListener('click', () => closeFeedImageLightbox());
        _feedImageLightboxOverlay.querySelector('[data-feed-lb-download]')?.addEventListener('click', () => {
            void downloadFeedLightboxImage(_feedImageLightboxUrl);
        });
    }
    const img = _feedImageLightboxOverlay.querySelector('[data-feed-lb-img]');
    if (img) {
        img.src = u;
        img.alt = '밀톡 첨부 사진';
    }
    _feedImageLightboxOverlay.classList.remove('hidden');
    _feedImageLightboxOverlay.setAttribute('aria-hidden', 'false');
    _feedImageLightboxKeyHandler = (e) => {
        if (e.key === 'Escape') closeFeedImageLightbox();
    };
    document.addEventListener('keydown', _feedImageLightboxKeyHandler);
}

function ensureFeedImageLightboxDelegate() {
    const root = document.getElementById('boardFeedPanelContent');
    if (!root || _feedImageClickDelegateBound) return;
    _feedImageClickDelegateBound = true;
    root.addEventListener('click', (e) => {
        if (window.__feedSuppressNextImageLightboxClick) {
            window.__feedSuppressNextImageLightboxClick = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const btn = e.target.closest?.('[data-feed-image-open]');
        if (!btn || !root.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        const src = btn.getAttribute('data-feed-image-src');
        if (src) openFeedImageLightbox(src);
    });
}

function cleanupFeedScrollResizeObserver() {
    if (typeof _feedScrollResizeCleanup === 'function') {
        _feedScrollResizeCleanup();
        _feedScrollResizeCleanup = null;
    }
}

function feedOtherAuthorAvatarBlock(post, authorDisplay) {
    const authorAvatar = getProfileAvatarDisplay(authorDisplay);
    const aid = String(post.authorId || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const photoSrc =
        authorAvatar.type === 'photo' && authorAvatar.value
            ? escapeHtml(String(authorAvatar.value).trim())
            : '';

    const inner =
        authorAvatar.type === 'photo' && photoSrc
            ? `<img src="${photoSrc}" alt="" width="36" height="36" class="h-9 w-9 rounded-full object-cover bg-slate-200 block" loading="lazy" decoding="async">`
            : authorAvatar.type === 'emoji'
              ? `<span class="flex h-9 w-9 items-center justify-center rounded-full border-0 bg-slate-100 text-lg leading-none" style="font-family: system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif;">${escapeHtml(authorAvatar.value)}</span>`
              : `<span class="flex h-9 w-9 items-center justify-center rounded-full border-0 bg-slate-100 text-slate-500"><i class="fa-solid fa-user text-sm" aria-hidden="true"></i></span>`;

    return `
        <button type="button" class="feed-other-avatar-btn flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full p-0 shadow-sm outline-none ring-1 ring-white focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:opacity-90 ${authorAvatar.type === 'photo' && photoSrc ? 'border-0 bg-slate-200' : 'border-0 bg-transparent'}"
            onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${aid}')"
            aria-label="${escapeHtml(authorDisplay.nickname || '익명')} 프로필">
            ${inner}
        </button>`;
}

function feedReactionRowHtml(post, alignEnd) {
    if (isDemoUser(window.currentUser)) return '';
    const c = post.reactionCounts;
    if (!c) return '';
    const like = Number(c.like) || 0;
    const thumbs = Number(c.thumbs) || 0;
    const check = Number(c.check) || 0;
    const chips = [];
    /* 배경: /50 → /68 (투명도↓). 높이: 예전 ~15px 대비 ~30% ↑ → 세로 패딩만 증가, 글자·아이콘 13px 유지 */
    const chipShell =
        'inline-flex items-center gap-0.5 rounded-full border border-white/50 bg-white/80 px-1.5 py-[3.25px] shadow-sm';
    if (like > 0) {
        chips.push(
            `<span class="${chipShell}"><i class="fa-solid fa-heart text-[13px] leading-none text-rose-500" aria-hidden="true"></i><span class="text-[13px] leading-none tabular-nums text-slate-700">${like}</span></span>`
        );
    }
    if (thumbs > 0) {
        chips.push(
            `<span class="${chipShell}"><i class="fa-solid fa-thumbs-up text-[13px] leading-none text-amber-500" aria-hidden="true"></i><span class="text-[13px] leading-none tabular-nums text-slate-700">${thumbs}</span></span>`
        );
    }
    if (check > 0) {
        chips.push(
            `<span class="${chipShell}"><i class="fa-solid fa-check text-[13px] leading-none text-emerald-600" aria-hidden="true"></i><span class="text-[13px] leading-none tabular-nums text-slate-700">${check}</span></span>`
        );
    }
    if (!chips.length) return '';
    const j = alignEnd ? 'justify-end' : 'justify-start';
    /* 바깥 배경 없음 — 칩만 반투명(이중 박스 느낌 제거). 정렬용 래퍼만 유지 */
    return `<div class="feed-reaction-row mt-0.5 inline-flex max-w-full flex-wrap gap-1 ${j}">${chips.join('')}</div>`;
}

function feedReplyQuoteHtml(replyTo, variant = 'mine') {
    if (!replyTo || typeof replyTo !== 'object') return '';
    const rawReplyNick = String(replyTo.authorNickname || '익명').trim();
    const nick = escapeHtml(rawReplyNick);
    const prev = escapeHtml(String(replyTo.textPreview || '').trim());
    if (!nick && !prev) return '';
    const box =
        variant === 'other'
            ? 'border-l-2 border-slate-300 bg-slate-100/90'
            : 'border-l-2 border-emerald-600/45 bg-emerald-100/70';
    const nickC = variant === 'other' ? 'font-semibold text-slate-800' : 'font-bold text-emerald-900';
    const prevC = variant === 'other' ? 'text-slate-600' : 'text-emerald-800/90';
    const nickData = encodeURIComponent(rawReplyNick);
    return `
        <div class="feed-reply-quote mb-1.5 min-w-0 max-w-full rounded-md px-2 py-1 ${box}">
            <div class="truncate text-xs ${nickC} select-none" data-feed-mention-nick="${nickData}">${nick}</div>
            <div class="truncate text-xs ${prevC}">${prev}</div>
        </div>`;
}

function postTimeLabel(post) {
    let d;
    if (!post.timestamp) d = new Date();
    else if (post.timestamp.toDate) d = post.timestamp.toDate();
    else if (typeof post.timestamp === 'string') d = new Date(post.timestamp);
    else if (post.timestamp instanceof Date) d = post.timestamp;
    else d = new Date(post.timestamp || 0);
    if (isNaN(d.getTime())) d = new Date();
    return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 말풍선 본문: 이스케이프 후 줄 시작·공백 뒤 @닉네임만 볼드 (이메일 중간 @는 제외) */
function feedBubbleBodyHtml(raw) {
    const escaped = escapeHtml(String(raw ?? ''));
    return escaped.replace(/(^|[\s\n])@([^\s@]+)/g, (m, lead, nick) => {
        return `${lead}<strong class="font-bold">@${nick}</strong>`;
    });
}

function feedBubbleHtml(post, opts = {}) {
    const showAuthorHeader = opts.showAuthorHeader !== false;
    const uid = window.currentUser?.uid;
    const isMine = !!(uid && post.authorId === uid);
    const isPendingSend = isMine && String(post.id || '').startsWith('pending-');
    // 피드 본문: 줄바꿈 유지 + @언급 볼드( feedBubbleBodyHtml )
    const body = feedBubbleBodyHtml(post.text || post.content || '');
    const hasImg = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;
    const imageUrlsToShow = hasImg ? post.imageUrls.slice(0, 5) : [];
    const time = postTimeLabel(post);
    const pid = escapeHtml(post.id || '');
    const hasBody = String(post.text || post.content || '').trim().length > 0;
    const combinedImgText = hasImg && hasBody;

    const imgOnlyPendingSpinner =
        isMine && isPendingSend && hasImg && !hasBody
            ? `<span class="pointer-events-none absolute left-2 top-2 z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600/90 text-white shadow-sm" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-[11px] leading-none" aria-hidden="true"></i></span><span class="sr-only">전송 중</span>`
            : '';
    const imgWrapClass = hasImg
        ? `${imgOnlyPendingSpinner ? 'relative' : ''} flex flex-col gap-1.5 overflow-hidden ${
              combinedImgText ? 'rounded-t-2xl rounded-b-none' : 'rounded-lg'
          }`
        : '';
    const imgChildRound = combinedImgText ? 'rounded-none' : 'rounded-lg';
    const imgBlock = hasImg
        ? `<div class="${imgWrapClass}">${imgOnlyPendingSpinner}${imageUrlsToShow
              .map((urlRaw) => {
                  const src = escapeHtml(String(urlRaw));
                  return `<button type="button" class="feed-image-lightbox-trigger block w-full max-w-[min(92vw,280px)] cursor-zoom-in p-0 border-0 bg-transparent text-left outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900/40 ${imgChildRound}" data-feed-image-open data-feed-image-src="${src}" aria-label="사진 크게 보기">
            <img src="${src}" alt="" class="pointer-events-none max-h-[min(42vh,280px)] w-full max-w-[min(92vw,280px)] ${imgChildRound} bg-slate-100 object-contain" loading="lazy" decoding="async">
        </button>`;
              })
              .join('')}</div>`
        : '';

    const timeMine = `<span class="feed-bubble-meta-time shrink-0 pb-1 text-xs leading-tight">${time}</span>`;
    const timeOtherBesideBubble = `<span class="feed-bubble-meta-time shrink-0 self-end pb-1 text-xs leading-tight whitespace-nowrap">${time}</span>`;

    if (isMine) {
        const replyQ = post.replyTo ? feedReplyQuoteHtml(post.replyTo, 'mine') : '';
        const reactRow = feedReactionRowHtml(post, true);
        const pendingSpinnerLead = `<span class="pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600/90 text-white shadow-sm" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-[11px] leading-none" aria-hidden="true"></i></span><span class="sr-only">전송 중</span>`;
        const bodyMine = hasBody
            ? isPendingSend
                ? `<div class="flex min-w-0 max-w-full items-start gap-2 ${hasImg ? 'px-5 py-2' : ''}">${pendingSpinnerLead}<p class="m-0 min-w-0 flex-1 max-w-[min(72vw,20rem)] whitespace-pre-wrap break-words leading-snug sm:max-w-[18rem]">${body}</p></div>`
                : `<p class="m-0 max-w-[min(72vw,20rem)] whitespace-pre-wrap break-words leading-snug sm:max-w-[18rem] ${hasImg ? 'px-5 py-2' : ''}">${body}</p>`
            : '';
        return `
            <div class="feed-timeline-row feed-timeline-row-mine flex justify-end items-end gap-2 pr-0.5 sm:pr-2" data-post-id="${pid}"${isPendingSend ? ' aria-busy="true"' : ''}>
                ${timeMine}
                <div class="flex w-fit max-w-[min(88%,22rem)] flex-col items-end sm:max-w-[18rem]">
                    <div class="feed-chat-bubble feed-chat-bubble-mine inline-block w-fit max-w-full text-left rounded-2xl rounded-br-md ${hasImg ? 'p-0' : 'px-5 py-2'} text-base shadow-sm">
                        ${replyQ}
                        ${imgBlock}
                        ${bodyMine}
                    </div>
                    ${reactRow}
                </div>
            </div>`;
    }

    const authorDisplay = getDisplayProfile(post.authorId, {
        nickname: post.authorNickname,
        icon: post.authorIcon,
        photoUrl: post.authorPhotoUrl
    });
    const rawAuthorNick = (authorDisplay.nickname || '익명').trim();
    const nick = escapeHtml(rawAuthorNick);
    const nickData = encodeURIComponent(rawAuthorNick);
    const avatarCol = showAuthorHeader
        ? feedOtherAuthorAvatarBlock(post, authorDisplay)
        : '<div class="h-9 w-9 flex-shrink-0" aria-hidden="true"></div>';
    const nickRow = showAuthorHeader
        ? `<span class="feed-bubble-author-nick mb-0.5 max-w-full truncate pl-0.5 text-sm font-semibold select-none" data-feed-mention-nick="${nickData}">${nick}</span>`
        : '';
    const reactRowOther = feedReactionRowHtml(post, false);
    const replyQOther = post.replyTo ? feedReplyQuoteHtml(post.replyTo, 'other') : '';

    return `
        <div class="feed-timeline-row flex justify-start gap-2 pl-2 pr-2 sm:pr-10" data-post-id="${pid}">
            <div class="flex min-w-0 max-w-full items-start gap-2">
                ${avatarCol}
                <div class="flex min-w-0 flex-col items-start">
                    ${nickRow}
                    <div class="flex min-w-0 max-w-full flex-col items-start">
                        <div class="flex max-w-full items-end gap-1">
                            <div class="feed-chat-bubble feed-chat-bubble-other inline-block w-fit max-w-full rounded-2xl rounded-bl-md border ${hasImg ? 'p-0' : 'px-5 py-2'} text-left text-base shadow-sm">
                                ${replyQOther}
                                ${imgBlock}
                                ${hasBody ? `<p class="m-0 max-w-[min(72vw,20rem)] whitespace-pre-wrap break-words leading-snug sm:max-w-[18rem] ${hasImg ? 'px-5 py-2' : ''}">${body}</p>` : ''}
                            </div>
                            ${timeOtherBesideBubble}
                        </div>
                        ${reactRowOther}
                    </div>
                </div>
            </div>
        </div>`;
}

function feedRefreshButtonHtml() {
    return `
    <div class="feed-timeline-footer mt-5 flex w-full shrink-0 justify-center px-2 pb-1 pt-0.5">
      <button type="button" class="feed-refresh-btn inline-flex items-center justify-center gap-2 rounded-full border border-white/40 bg-white/15 px-4 py-2 text-sm font-medium text-white shadow-sm backdrop-blur-sm outline-none transition-colors hover:bg-white/25 active:bg-white/20 disabled:pointer-events-none disabled:opacity-50" data-feed-refresh aria-label="대화 새로고침">
        <i class="fa-solid fa-arrows-rotate text-base" aria-hidden="true"></i>
        <span>새로고침</span>
      </button>
    </div>`;
}

function getPostTimestampMs(post) {
    if (!post.timestamp) return 0;
    if (post.timestamp.toDate && typeof post.timestamp.toDate === 'function') {
        return post.timestamp.toDate().getTime();
    }
    if (typeof post.timestamp === 'string') return new Date(post.timestamp).getTime();
    if (post.timestamp instanceof Date) return post.timestamp.getTime();
    return new Date(post.timestamp || 0).getTime();
}

function paintFeedTimeline(root, posts) {
    cleanupFeedScrollResizeObserver();
    if (!posts.length) {
        root.innerHTML = `
            <div class="feed-timeline-stack flex min-h-full flex-col justify-end">
                <div class="feed-timeline-empty flex flex-1 flex-col items-center justify-center py-10 px-4 text-center">
                    <i class="fa-regular fa-comments feed-timeline-empty-icon text-3xl mb-2" aria-hidden="true"></i>
                    <p class="feed-timeline-empty-title text-xs">아직 메시지가 없어요</p>
                    <p class="feed-timeline-empty-sub text-[11px] mt-1">아래에서 첫 메시지를 보내 보세요</p>
                </div>
                ${feedRefreshButtonHtml()}
            </div>`;
        ensureFeedImageLightboxDelegate();
        return;
    }
    const chronological = [...posts].sort((a, b) => getPostTimestampMs(a) - getPostTimestampMs(b));
    const uid = window.currentUser?.uid;
    const rowsHtml = chronological
        .map((p, i) => {
            const prev = i > 0 ? chronological[i - 1] : null;
            const isMine = !!(uid && p.authorId === uid);
            let showAuthorHeader = true;
            if (!isMine && prev) {
                const id = String(p.authorId || '');
                const prevId = String(prev.authorId || '');
                const sameAuthor = id !== '' && prevId === id;
                showAuthorHeader = !sameAuthor;
            }
            return feedBubbleHtml(p, { showAuthorHeader });
        })
        .join('');
    root.innerHTML = `
        <div class="feed-timeline-stack flex min-h-full flex-col justify-end">
            <div class="feed-timeline flex w-full flex-col justify-end gap-2 pb-0 pt-1">${rowsHtml}</div>
            ${feedRefreshButtonHtml()}
        </div>`;
    ensureFeedImageLightboxDelegate();
}

function revokeBlobUrlsOnPost(post) {
    const urls = post?.imageUrls;
    if (!Array.isArray(urls)) return;
    urls.forEach((u) => {
        if (typeof u === 'string' && u.startsWith('blob:')) {
            try {
                URL.revokeObjectURL(u);
            } catch (_) {}
        }
    });
}

/** 전송 직후 목록에 임시 말풍선 표시 (서버 응답 전) */
export function buildPendingFeedMessage({ text, imagePreviewUrls = [], replyToPostId = null }) {
    const uid = window.currentUser?.uid;
    if (!uid) return null;
    const id = `pending-${Date.now()}`;
    const display = getDisplayProfile(uid, window.userSettings?.profile);
    let replyTo = null;
    const rid = replyToPostId ? String(replyToPostId).trim() : '';
    if (rid) {
        const parent = (appState.feedTimelinePosts || []).find((p) => String(p.id) === rid);
        if (parent) {
            const raw = String(parent.text || parent.content || '').trim();
            let prev = raw.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (prev.length > 80) prev = `${prev.slice(0, 79)}…`;
            if (!prev && Array.isArray(parent.imageUrls) && parent.imageUrls.length) prev = '(사진)';
            if (!prev) prev = '내용 없음';
            replyTo = { authorNickname: parent.authorNickname || '익명', textPreview: prev };
        }
    }
    return {
        id,
        text: String(text || ''),
        content: String(text || ''),
        imageUrls: imagePreviewUrls.slice(0, 5),
        authorId: uid,
        authorNickname: display.nickname || '익명',
        authorPhotoUrl: display.photoUrl || null,
        authorIcon: display.icon || null,
        timestamp: new Date(),
        reactionCounts: { like: 0, thumbs: 0, check: 0 },
        ...(replyTo ? { replyTo } : {})
    };
}

export function applyOptimisticFeedPost(post) {
    const root = document.getElementById('boardFeedPanelContent');
    if (!root || !post) return;
    const prev = appState.feedTimelinePosts || [];
    const withoutPending = prev.filter((p) => !String(p?.id || '').startsWith('pending-'));
    const next = [...withoutPending, post];
    appState.feedTimelinePosts = next;
    paintFeedTimeline(root, next);
    scrollFeedPanelToBottom();
}

/** 전송 실패 등: pending 말풍선 제거 + blob 정리 */
export function removePendingFeedPosts() {
    const root = document.getElementById('boardFeedPanelContent');
    const prev = appState.feedTimelinePosts || [];
    const next = [];
    for (const p of prev) {
        if (String(p?.id || '').startsWith('pending-')) {
            revokeBlobUrlsOnPost(p);
            continue;
        }
        next.push(p);
    }
    appState.feedTimelinePosts = next;
    if (root) paintFeedTimeline(root, next);
    scrollFeedPanelToBottom();
}

/** 맨 아래로 스크롤: 통합 스크롤(#boardLoungeScrollArea) 기준. 이미지 로드 등으로 높이가 늘면 ResizeObserver로 지연 1회 보정 */
export function scrollFeedPanelToBottom() {
    const lounge = getBoardLoungeScrollEl();
    const el = document.getElementById('boardFeedPanelContent');
    if (!lounge || !el) return;

    cleanupFeedScrollResizeObserver();

    // 사용자가 진입 직후 위로 스크롤하면 자동 보정(ResizeObserver)이 더 이상 맨 아래로 끌고 가지 않도록
    // "하단 근처일 때만" 자동 보정 허용 + 사용자가 위로 벗어나면 즉시 중단한다.
    const nearBottomPx = 18;
    const isNearBottom = () => {
        const maxScroll = Math.max(0, lounge.scrollHeight - lounge.clientHeight);
        return maxScroll - lounge.scrollTop <= nearBottomPx;
    };

    const apply = () => {
        lounge.scrollTop = Math.max(0, lounge.scrollHeight - lounge.clientHeight);
    };

    // 이 함수 호출 시점은 주로 "탭 진입/렌더 직후"이며,
    // 이때 스크롤 변화가 헤더/네비 숨김 로직을 트리거하면 레이아웃이 바뀌며 흔들릴 수 있다.
    window.__suppressBoardPanelScrollHideNavUntil = Date.now() + 1200;

    apply();
    requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
    });

    const stack = el.querySelector('.feed-timeline-stack');
    if (!stack || typeof ResizeObserver === 'undefined') return;

    let debounceT = null;
    let lastScrollH = el.scrollHeight;
    let cancelledByUser = false;
    const onUserScroll = () => {
        if (cancelledByUser) return;
        if (!isNearBottom()) {
            cancelledByUser = true;
            cleanupFeedScrollResizeObserver();
        }
    };
    // capture로 먼저 감지(패시브) — 사용자가 위로 올리는 순간 자동 보정 취소
    lounge.addEventListener('scroll', onUserScroll, { passive: true, capture: true });
    const ro = new ResizeObserver(() => {
        if (cancelledByUser) return;
        // 사용자가 이미 위로 벗어났으면(읽기 시작) 자동으로 아래로 당기지 않음
        if (!isNearBottom()) return;
        const h = el.scrollHeight;
        if (h === lastScrollH) return;
        lastScrollH = h;
        clearTimeout(debounceT);
        debounceT = setTimeout(() => {
            if (cancelledByUser) return;
            if (!isNearBottom()) return;
            apply();
            lastScrollH = el.scrollHeight;
        }, 80);
    });
    ro.observe(stack);

    const stopT = setTimeout(() => {
        clearTimeout(debounceT);
        ro.disconnect();
        if (!cancelledByUser && isNearBottom()) apply();
    }, 1600);

    _feedScrollResizeCleanup = () => {
        clearTimeout(stopT);
        clearTimeout(debounceT);
        try {
            lounge.removeEventListener('scroll', onUserScroll, { capture: true });
        } catch (_) {
            // 일부 브라우저는 options 일치가 필요할 수 있어 무시
            lounge.removeEventListener('scroll', onUserScroll, true);
        }
        ro.disconnect();
    };
}

/** 피드: feedPosts 컬렉션만 조회 (게시판과 무관)
 * @param {object} options
 * @param {object} [options.optimisticPost] - 전송 직후 목록에 임시로 합칠 글
 * @param {boolean} [options.quietRefresh] - true면 전체 패널 로딩 스켈레톤 생략(온디맨드 새로고침)
 */
export async function renderBoardFeedTab(options = {}) {
    const root = document.getElementById('boardFeedPanelContent');
    if (!root || !window.feedOperations) return;

    const quiet = !!options.quietRefresh;
    if (!quiet) {
        appState.feedTimelineOldestCursor = null;
        appState.feedTimelineHasMore = false;
        root.innerHTML = `
        <div class="feed-panel-loading flex flex-col items-center justify-center py-10">
            <i class="fa-solid fa-spinner fa-spin feed-panel-loading-icon text-2xl mb-2" aria-hidden="true"></i>
            <span class="feed-panel-loading-text text-xs">불러오는 중…</span>
        </div>`;
    }

    try {
        for (const p of appState.feedTimelinePosts || []) {
            if (String(p?.id || '').startsWith('pending-')) revokeBlobUrlsOnPost(p);
        }
        const prevWithoutPending = (appState.feedTimelinePosts || []).filter(
            (p) => !String(p?.id || '').startsWith('pending-')
        );

        const { posts: pagePosts, cursorSnap, hasMore } = await window.feedOperations.getMessagesPage({
            limitCount: FEED_TIMELINE_BATCH_SIZE,
            startAfterSnapshot: null
        });

        let list;
        if (quiet) {
            list = mergeFeedQuietRefreshFirstPage(pagePosts, prevWithoutPending);
            const server = (pagePosts || []).filter((p) => p && p.isHidden !== true);
            const minServerTs =
                server.length > 0 ? Math.min(...server.map(getPostTimestampMs)) : Infinity;
            const preservedOlder = prevWithoutPending.some((p) => getPostTimestampMs(p) < minServerTs);
            if (preservedOlder && appState.feedTimelineOldestCursor != null) {
                /* 스크롤로 불러 둔 구간 유지 — 페이지네이션 커서·hasMore 그대로 */
            } else {
                appState.feedTimelineOldestCursor = cursorSnap;
                appState.feedTimelineHasMore = hasMore;
            }
        } else {
            appState.feedTimelineOldestCursor = cursorSnap;
            appState.feedTimelineHasMore = hasMore;
            list = (pagePosts || []).filter((p) => p && p.isHidden !== true);
            list = list.filter((p) => !String(p?.id || '').startsWith('pending-'));
        }

        const op = options.optimisticPost;
        if (op != null && op.id != null && String(op.id) && !list.some((p) => String(p.id) === String(op.id))) {
            const rc = op.reactionCounts || { like: 0, thumbs: 0, check: 0 };
            list = [...list, { ...op, reactionCounts: rc }];
        }
        const authorIds = [...new Set(list.map((p) => p.authorId).filter(Boolean))];
        await fetchUserProfiles(authorIds);
        appState.feedTimelinePosts = list;
        paintFeedTimeline(root, list);
        ensureBoardFeedScrollOlderBound();
        scrollFeedPanelToBottom();
        window.refreshNavFeedUpdateDots?.().catch(() => {});
    } catch (e) {
        console.error('renderBoardFeedTab:', e);
        if (quiet) {
            showToast('밀톡을 다시 불러오지 못했어요.', 'error');
        } else {
            root.innerHTML = `
            <div class="feed-panel-error flex flex-col items-center justify-center py-12 px-4 text-center text-sm">
                밀톡을 불러오지 못했어요
            </div>`;
        }
    }
}
