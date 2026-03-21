/**
 * 공유 기록 코멘트 lazy 일괄 조회 (Callable)
 */
import { escapeHtml } from './utils.js';

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
    div.classList.remove('shared-comment-fetch-placeholder');
    if (comment) {
        const lineBreaks = (comment.match(/\n/g) || []).length;
        const estimatedLines = Math.ceil(comment.length / 30);
        const shouldShowToggle = lineBreaks >= 2 || estimatedLines > 2;
        const toggleBtnClass = shouldShowToggle ? '' : 'hidden';
        div.innerHTML = `
            <span id="post-caption-collapsed-${groupIdx}" class="whitespace-pre-line line-clamp-2 inline">${escapeHtml(comment).replace(/\n/g, '<br>')}</span>
            <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-toggle-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1 ${toggleBtnClass}">더 보기</button>
            <div id="post-caption-expanded-${groupIdx}" class="whitespace-pre-line hidden">
                ${escapeHtml(comment).replace(/\n/g, '<br>')}
                <button onclick="window.togglePostCaption(${groupIdx})" id="post-caption-collapse-${groupIdx}" class="inline text-xs text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 transition-colors ml-1">접기</button>
            </div>
        `;
        const commentSection = el.querySelector(`#comment-section-${CSS.escape(postId)}`);
        if (commentSection) commentSection.classList.remove('comments-empty'), commentSection.classList.add('border-t', 'border-slate-200');
    } else {
        div.remove();
    }
}
