/**
 * 밀톡 피드 탭 — feedPosts 전용 (게시판 boardPosts와 분리)
 */
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { fetchUserProfiles } from './user-profiles.js';
import { getDisplayProfile, getProfileAvatarDisplay } from '../utils.js';

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
              ? `<span class="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-lg leading-none" style="font-family: system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif;">${escapeHtml(authorAvatar.value)}</span>`
              : `<span class="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-slate-500"><i class="fa-solid fa-user text-sm" aria-hidden="true"></i></span>`;

    return `
        <button type="button" class="feed-other-avatar-btn flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full p-0 shadow-sm outline-none ring-0 focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:opacity-90 ${authorAvatar.type === 'photo' && photoSrc ? 'border-0 bg-slate-200' : 'border-0 bg-transparent'}"
            onclick="event.stopPropagation(); window.openUserProfileFromBoard && window.openUserProfileFromBoard('${aid}')"
            aria-label="${escapeHtml(authorDisplay.nickname || '익명')} 프로필">
            ${inner}
        </button>`;
}

function feedReactionRowHtml(post, alignEnd) {
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
    const nick = escapeHtml(String(replyTo.authorNickname || '익명').trim());
    const prev = escapeHtml(String(replyTo.textPreview || '').trim());
    if (!nick && !prev) return '';
    const box =
        variant === 'other'
            ? 'border-l-2 border-slate-300 bg-slate-100/90'
            : 'border-l-2 border-emerald-600/45 bg-emerald-100/70';
    const nickC = variant === 'other' ? 'font-semibold text-slate-800' : 'font-bold text-emerald-900';
    const prevC = variant === 'other' ? 'text-slate-600' : 'text-emerald-800/90';
    return `
        <div class="feed-reply-quote mb-1.5 min-w-0 max-w-full rounded-md px-2 py-1 ${box}">
            <div class="truncate text-[11px] ${nickC}">${nick}</div>
            <div class="truncate text-[11px] ${prevC}">${prev}</div>
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

function feedBubbleHtml(post, opts = {}) {
    const showAuthorHeader = opts.showAuthorHeader !== false;
    const uid = window.currentUser?.uid;
    const isMine = !!(uid && post.authorId === uid);
    // 피드 본문은 순수 텍스트 — 줄바꿈 유지(getPlainTextPreview는 \n을 공백으로 제거함)
    const body = escapeHtml(String(post.text || post.content || ''));
    const hasImg = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;
    const img0 = hasImg ? post.imageUrls[0] : '';
    const time = postTimeLabel(post);
    const pid = escapeHtml(post.id || '');

    const imgBlock = hasImg
        ? `<div class="mt-1.5 overflow-hidden rounded-lg"><img src="${escapeHtml(img0)}" alt="" class="max-h-40 w-auto max-w-[min(85vw,240px)] rounded-lg bg-slate-100 object-cover" loading="lazy"></div>`
        : '';

    const timeMine = `<span class="feed-bubble-meta-time shrink-0 pb-1 text-[10px] leading-tight">${time}</span>`;
    const timeOtherBesideBubble = `<span class="feed-bubble-meta-time shrink-0 self-end pb-1 text-[10px] leading-tight whitespace-nowrap">${time}</span>`;

    if (isMine) {
        const replyQ = post.replyTo ? feedReplyQuoteHtml(post.replyTo, 'mine') : '';
        const reactRow = feedReactionRowHtml(post, true);
        return `
            <div class="feed-timeline-row feed-timeline-row-mine flex justify-end items-end gap-2 pr-0.5 sm:pr-2" data-post-id="${pid}">
                ${timeMine}
                <div class="flex w-fit max-w-[min(88%,22rem)] flex-col items-end sm:max-w-[18rem]">
                    <div class="feed-chat-bubble feed-chat-bubble-mine inline-block w-fit max-w-full text-left rounded-2xl rounded-br-md px-5 py-2 text-sm shadow-sm">
                        ${replyQ}
                        <p class="m-0 max-w-[min(72vw,20rem)] whitespace-pre-wrap break-words leading-snug sm:max-w-[18rem]">${body}</p>
                        ${imgBlock}
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
    const nick = escapeHtml(authorDisplay.nickname || '익명');
    const avatarCol = showAuthorHeader
        ? feedOtherAuthorAvatarBlock(post, authorDisplay)
        : '<div class="h-9 w-9 flex-shrink-0" aria-hidden="true"></div>';
    const nickRow = showAuthorHeader
        ? `<span class="feed-bubble-author-nick mb-0.5 max-w-full truncate pl-0.5 text-xs font-semibold">${nick}</span>`
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
                            <div class="feed-chat-bubble feed-chat-bubble-other inline-block w-fit max-w-full rounded-2xl rounded-bl-md border px-5 py-2 text-left text-sm shadow-sm">
                                ${replyQOther}
                                <p class="m-0 max-w-[min(72vw,20rem)] whitespace-pre-wrap break-words leading-snug sm:max-w-[18rem]">${body}</p>
                                ${imgBlock}
                            </div>
                            ${timeOtherBesideBubble}
                        </div>
                        ${reactRowOther}
                    </div>
                </div>
            </div>
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
    if (!posts.length) {
        root.innerHTML = `
            <div class="feed-timeline-empty flex flex-col items-center justify-center py-10 px-4 text-center">
                <i class="fa-regular fa-comments feed-timeline-empty-icon text-3xl mb-2" aria-hidden="true"></i>
                <p class="feed-timeline-empty-title text-xs">아직 메시지가 없어요</p>
                <p class="feed-timeline-empty-sub text-[11px] mt-1">아래에서 첫 메시지를 보내 보세요</p>
            </div>`;
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
    root.innerHTML = `<div class="feed-timeline flex min-h-full flex-col justify-end gap-2 pb-3 pt-1">${rowsHtml}</div>`;
}

/** innerHTML 직후 scrollHeight가 아직 갱신되지 않아 맨 위(과거 메시지)만 보이는 경우 방지 */
function scrollFeedPanelToBottom() {
    const el = document.getElementById('boardFeedPanelContent');
    if (!el) return;

    const run = () => {
        const last = el.querySelector('.feed-timeline-row:last-of-type');
        if (last) {
            const pad = 12;
            const cr = el.getBoundingClientRect();
            const br = last.getBoundingClientRect();
            const below = br.bottom - (cr.bottom - pad);
            if (below > 0) {
                el.scrollTop += below;
            }
            return;
        }
        el.scrollTop = el.scrollHeight;
    };

    run();
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 0);
    setTimeout(run, 100);
    setTimeout(run, 280);
}

/** 피드: feedPosts 컬렉션만 조회 (게시판과 무관) */
export async function renderBoardFeedTab(options = {}) {
    const root = document.getElementById('boardFeedPanelContent');
    if (!root || !window.feedOperations) return;

    root.innerHTML = `
        <div class="feed-panel-loading flex flex-col items-center justify-center py-10">
            <i class="fa-solid fa-spinner fa-spin feed-panel-loading-icon text-2xl mb-2" aria-hidden="true"></i>
            <span class="feed-panel-loading-text text-xs">불러오는 중…</span>
        </div>`;

    try {
        const posts = await window.feedOperations.getMessages(50);
        let list = (posts || []).filter((p) => p && p.isHidden !== true);
        const op = options.optimisticPost;
        if (op != null && op.id != null && String(op.id) && !list.some((p) => String(p.id) === String(op.id))) {
            const rc = op.reactionCounts || { like: 0, thumbs: 0, check: 0 };
            list = [...list, { ...op, reactionCounts: rc }];
        }
        const authorIds = [...new Set(list.map((p) => p.authorId).filter(Boolean))];
        await fetchUserProfiles(authorIds);
        appState.feedTimelinePosts = list;
        paintFeedTimeline(root, list);
        scrollFeedPanelToBottom();
    } catch (e) {
        console.error('renderBoardFeedTab:', e);
        root.innerHTML = `
            <div class="feed-panel-error flex flex-col items-center justify-center py-12 px-4 text-center text-sm">
                피드를 불러오지 못했어요
            </div>`;
    }
}
