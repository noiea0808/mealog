/**
 * 공유 기록 코멘트 lazy 일괄 조회 (Callable)
 */
import { escapeHtml } from './utils.js';
import { applyCollapsedCaptionToElement } from './comment-caption-layout.js';
import { syncMomentV2AuthorCommentBand } from '../main/moment-v2-author-comment.js';

// 공유 게시물 코멘트 캐시 (lazy 로드 시 재요청 방지)
const sharedCommentsCache = new Map();

/** 공유 게시물 중 문서에 comment가 없는 경우 서버에서 일괄 조회해 DOM에 반영. commentsPromise 있으면 미리 보낸 요청 결과 사용 */
export async function fetchMissingSharedComments(container, commentsPromise) {
    const el = container && container.querySelector ? container : document.getElementById('galleryContainer');
    if (!el) return;
    const placeholders = el.querySelectorAll('.shared-comment-fetch-placeholder');
    if (placeholders.length === 0) return;
    const items = [];
    const placeholdersByKey = new Map();
    placeholders.forEach(div => {
        const entryId = div.getAttribute('data-entry-id');
        const ownerUserId = div.getAttribute('data-owner-user-id');
        if (!entryId || !ownerUserId) return;
        const key = `${entryId}\t${ownerUserId}`;
        if (!placeholdersByKey.has(key)) {
            items.push({ entryId, ownerUserId });
            placeholdersByKey.set(key, []);
        }
        placeholdersByKey.get(key).push(div);
    });
    if (items.length === 0) return;
    const commentByKey = new Map();
    const uncachedItems = items.filter(({ entryId, ownerUserId }) => {
        const key = `${entryId}\t${ownerUserId}`;
        if (sharedCommentsCache.has(key)) {
            commentByKey.set(key, sharedCommentsCache.get(key));
            return false;
        }
        return true;
    });
    if (uncachedItems.length === 0) {
        placeholdersByKey.forEach((divs, key) => {
            const comment = commentByKey.get(key) || '';
            divs.forEach(div => applyCommentToPlaceholder(el, div, comment));
        });
        return;
    }
    try {
        let data;
        if (commentsPromise && typeof commentsPromise.then === 'function') {
            const res = await commentsPromise;
            data = res && res.data ? res.data : res;
        } else if (uncachedItems.length > 0) {
            const mod = await import('../firebase.js');
            const callable = mod.callableFunctions?.getSharedEntryComments;
            if (!callable) return;
            const res = await callable({ items: uncachedItems });
            data = res && res.data ? res.data : res;
        }
        const comments = (data && data.comments && Array.isArray(data.comments)) ? data.comments : [];
        comments.forEach(c => {
            const key = `${c.entryId}\t${c.ownerUserId}`;
            const comment = (c.comment && String(c.comment).trim()) || '';
            sharedCommentsCache.set(key, comment);
            commentByKey.set(key, comment);
        });
        placeholdersByKey.forEach((divs, key) => {
            const comment = commentByKey.get(key) || '';
            divs.forEach(div => applyCommentToPlaceholder(el, div, comment));
        });
    } catch (e) {
        console.warn('공유 게시물 코멘트 일괄 조회 실패:', e);
        placeholders.forEach(div => { div.remove(); });
    }
}

function applyCommentToPlaceholder(el, div, comment) {
    const groupIdx = div.getAttribute('data-group-idx');
    const postId = div.getAttribute('data-post-id');
    const v2Root = div.closest?.('[data-moment-v2-root]');
    if (v2Root && postId) {
        div.classList.remove('shared-comment-fetch-placeholder');
        if (comment) {
            const raw = v2Root.getAttribute('data-moment-v2-labels');
            if (raw) {
                try {
                    const labels = JSON.parse(decodeURIComponent(raw));
                    if (Array.isArray(labels)) {
                        const c = String(comment).trim();
                        labels.forEach((row) => {
                            if (row && typeof row === 'object') row.ac = c;
                        });
                        v2Root.setAttribute('data-moment-v2-labels', encodeURIComponent(JSON.stringify(labels)));
                        syncMomentV2AuthorCommentBand(v2Root);
                    }
                } catch (_) {
                    /* ignore */
                }
            }
            const commentSection = el.querySelector(`#comment-section-${CSS.escape(postId)}`);
            if (commentSection) {
                commentSection.classList.remove('comments-empty');
                commentSection.classList.add('border-t', 'border-slate-200');
            }
        }
        div.remove();
        return;
    }
    div.classList.remove('shared-comment-fetch-placeholder');
    if (comment) {
        div.innerHTML = `
            <div id="post-caption-collapsed-${groupIdx}" class="min-h-[1em]" data-comment-raw="${encodeURIComponent(comment)}" data-caption-variant="moment" data-group-idx="${groupIdx}">
                <div data-comment-collapsed-mount class="leading-snug"></div>
            </div>
            <div id="post-caption-expanded-${groupIdx}" class="hidden whitespace-pre-line break-words leading-snug cursor-pointer" onclick="window.togglePostCaption(${groupIdx})">${escapeHtml(comment).replace(/\n/g, '<br>')}</div>
        `;
        requestAnimationFrame(() => {
            const collapsed = document.getElementById(`post-caption-collapsed-${groupIdx}`);
            if (collapsed) applyCollapsedCaptionToElement(collapsed);
        });
        const commentSection = el.querySelector(`#comment-section-${CSS.escape(postId)}`);
        if (commentSection) commentSection.classList.remove('comments-empty'), commentSection.classList.add('border-t', 'border-slate-200');
    } else {
        div.remove();
    }
}
