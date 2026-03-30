/**
 * 피드 말풍선 롱프레스 / 우클릭 액션 시트
 */
import { appState } from '../state.js';
import { showToast } from '../ui.js';
import { feedOperations } from '../db.js';
import { renderBoardFeedTab } from '../render/board-feed.js';
import { getDisplayProfile } from '../utils.js';
import { isDemoUser } from '../demo-account.js';

const LONG_PRESS_MS = 520;
const MOVE_CANCEL_PX = 16;
const SHEET_ID = 'feedBubbleActionSheet';

function getFeedPostById(postId) {
    const list = appState.feedTimelinePosts;
    if (!Array.isArray(list)) return null;
    return list.find((p) => p && String(p.id) === String(postId)) || null;
}

function removeSheet() {
    const el = document.getElementById(SHEET_ID);
    if (el) el.remove();
    document.body.classList.remove('feed-bubble-sheet-open');
    document.removeEventListener('keydown', onSheetEscape);
}

function onSheetEscape(e) {
    if (e.key === 'Escape') removeSheet();
}

async function copyFeedText(postId, bubble) {
    const post = getFeedPostById(postId);
    const raw = post ? String(post.text || post.content || '') : '';
    const fromDom = bubble?.querySelector('p')?.innerText ?? '';
    const text = raw || fromDom;
    if (!text.trim()) {
        showToast('복사할 텍스트가 없습니다.', 'info');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast('복사했어요.', 'success');
    } catch (_) {
        showToast('복사에 실패했습니다.', 'error');
    }
}

function oneLineSnippet(text, maxLen = 64) {
    const single = String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (single.length <= maxLen) return single;
    return `${single.slice(0, Math.max(1, maxLen - 1))}…`;
}

function replyToPost(postId) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        window.requestLogin?.();
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('체험 계정에서는 답장을 보낼수 없어요', 'error');
        return;
    }
    const post = getFeedPostById(postId);
    if (!post) return;
    const display = getDisplayProfile(post.authorId, {
        nickname: post.authorNickname,
        icon: post.authorIcon,
        photoUrl: post.authorPhotoUrl
    });
    const nick = (display.nickname || '익명').trim();
    const bodyRaw = String(post.text || post.content || '').trim();
    const hasImg = Array.isArray(post.imageUrls) && post.imageUrls.length > 0;
    let snippet = oneLineSnippet(bodyRaw, 72);
    if (!snippet && hasImg) snippet = '(사진)';
    if (!snippet) snippet = '내용 없음';

    const bar = document.getElementById('boardInlineComposerReplyBar');
    const nickEl = document.getElementById('boardInlineComposerReplyNick');
    const snipEl = document.getElementById('boardInlineComposerReplySnippet');
    if (nickEl) nickEl.textContent = nick;
    if (snipEl) {
        snipEl.textContent = snippet;
        const tip = bodyRaw || (hasImg ? '(사진)' : '');
        if (tip.length > 0) snipEl.setAttribute('title', tip.length > 240 ? `${tip.slice(0, 240)}…` : tip);
        else snipEl.removeAttribute('title');
    }
    if (bar) bar.classList.remove('hidden');
    window.__feedReplyToPostId = postId;

    const input = document.getElementById('boardInlineComposerInput');
    if (!input) return;
    input.value = '';
    input.focus();
    try {
        input.setSelectionRange(0, 0);
    } catch (_) {}
    if (typeof window.syncBoardInlineComposerUi === 'function') {
        window.syncBoardInlineComposerUi();
    }
}

function openEditFeedModal(postId) {
    const post = getFeedPostById(postId);
    if (!post) return;
    const initial = String(post.text || post.content || '');
    const wrap = document.createElement('div');
    wrap.id = 'feedBubbleEditOverlay';
    wrap.className =
        'fixed inset-0 z-[210] flex items-center justify-center p-4 bg-slate-900/45';
    wrap.innerHTML = `
        <div class="feed-bubble-edit-panel w-full max-w-xs rounded-2xl bg-white p-4 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="feedEditTitle">
            <h2 id="feedEditTitle" class="mb-2 text-sm text-slate-800">메시지 수정</h2>
            <textarea id="feedBubbleEditTa" rows="3" maxlength="280" class="w-full resize-none rounded-xl border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"></textarea>
            <p class="mb-2 mt-1 text-xs text-slate-400"><span id="feedBubbleEditCount">0</span>/280</p>
            <div class="flex justify-end gap-2">
                <button type="button" id="feedBubbleEditCancel" class="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600 active:bg-slate-200">취소</button>
                <button type="button" id="feedBubbleEditSave" class="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white active:bg-emerald-700">저장</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('#feedBubbleEditTa');
    const countEl = wrap.querySelector('#feedBubbleEditCount');
    ta.value = initial;
    const updCount = () => {
        if (countEl) countEl.textContent = String((ta.value || '').length);
    };
    updCount();
    ta.addEventListener('input', updCount);

    const close = () => wrap.remove();

    wrap.querySelector('#feedBubbleEditCancel').addEventListener('click', close);
    wrap.addEventListener('click', (e) => {
        if (e.target === wrap) close();
    });

    wrap.querySelector('#feedBubbleEditSave').addEventListener('click', async () => {
        const text = ta.value.trim();
        const btn = wrap.querySelector('#feedBubbleEditSave');
        btn.disabled = true;
        try {
            await feedOperations.updateMessageText(postId, text);
            close();
            await renderBoardFeedTab();
        } catch (_) {
            btn.disabled = false;
        }
    });
    setTimeout(() => ta.focus(), 50);
}

function showFeedBubbleSheet({ postId, isMine, bubble }) {
    removeSheet();
    try {
        if (navigator.vibrate) navigator.vibrate(12);
    } catch (_) {}

    const root = document.createElement('div');
    root.id = SHEET_ID;
    root.className =
        'fixed inset-0 z-[200] flex items-center justify-center p-4 pointer-events-none';
    root.setAttribute('role', 'presentation');

    // 샘플 계정도 버튼은 보여주되(체험), 누르면 현재 팝업 상태에서 토스트로 안내만 한다.
    const reactionsBlock = isMine
        ? ''
        : `
        <div class="mb-2.5 flex justify-center gap-2.5">
            <button type="button" data-feed-react="like" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-500 shadow-md active:scale-95 active:opacity-90" aria-label="좋아요">
                <i class="fa-solid fa-heart text-sm text-white" aria-hidden="true"></i>
            </button>
            <button type="button" data-feed-react="thumbs" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500 shadow-md active:scale-95 active:opacity-90" aria-label="따봉">
                <i class="fa-solid fa-thumbs-up text-sm text-white" aria-hidden="true"></i>
            </button>
            <button type="button" data-feed-react="check" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 shadow-md active:scale-95 active:opacity-90" aria-label="체크">
                <i class="fa-solid fa-check text-sm text-white" aria-hidden="true"></i>
            </button>
        </div>`;

    const rowBase =
        'flex w-full cursor-pointer items-center justify-center gap-2 border-0 bg-transparent px-2 py-[calc(0.625rem*1.3)] text-center text-base outline-none active:bg-slate-100';

    const replyBtn = isMine
        ? ''
        : `<button type="button" data-feed-action="reply" class="${rowBase} text-slate-900">
            <i class="fa-solid fa-reply shrink-0 text-sm text-slate-600" aria-hidden="true"></i>답장
        </button>`;

    const editBtn = isMine && !isDemoUser(window.currentUser)
        ? `<button type="button" data-feed-action="edit" class="${rowBase} text-slate-900">
            <i class="fa-solid fa-pen shrink-0 text-sm text-slate-600" aria-hidden="true"></i>수정
        </button>`
        : '';

    const delBtn = isMine && !isDemoUser(window.currentUser)
        ? `<button type="button" data-feed-action="delete" class="${rowBase} text-red-800 active:bg-red-50">
            <i class="fa-solid fa-trash shrink-0 text-sm text-red-700" aria-hidden="true"></i>삭제
        </button>`
        : '';

    /* 최소 너비: 반응 줄 기준 × 1.3, 본문은 영역 탭(테두리 없음) */
    root.innerHTML = `
        <div class="feed-bubble-popup-backdrop absolute inset-0 bg-black/45 pointer-events-auto" data-feed-sheet-dismiss></div>
        <div class="feed-bubble-popup-panel relative z-[1] mx-auto min-w-[12.025rem] w-max max-w-[92vw] pointer-events-auto overflow-y-auto rounded-2xl bg-white px-2 py-2 text-center shadow-xl" style="max-height:min(78vh, 420px)">
            ${reactionsBlock}
            <div class="flex flex-col divide-y divide-slate-200/90">
                <button type="button" data-feed-action="copy" class="${rowBase} text-slate-900 leading-tight">
                    <i class="fa-regular fa-copy shrink-0 text-sm text-slate-600" aria-hidden="true"></i><span class="break-words">텍스트 복사</span>
                </button>
                ${replyBtn}
                ${editBtn}
                ${delBtn}
            </div>
            <button type="button" data-feed-sheet-dismiss class="mt-0 w-full border-t border-slate-200/90 bg-transparent py-[calc(0.625rem*1.3)] text-center text-base text-slate-900 outline-none active:bg-slate-100">닫기</button>
        </div>`;

    document.body.appendChild(root);
    document.body.classList.add('feed-bubble-sheet-open');
    document.addEventListener('keydown', onSheetEscape);

    root.querySelectorAll('[data-feed-sheet-dismiss]').forEach((el) => {
        el.addEventListener('click', () => removeSheet());
    });

    root.querySelector('[data-feed-action="copy"]')?.addEventListener('click', async () => {
        await copyFeedText(postId, bubble);
        removeSheet();
    });

    root.querySelector('[data-feed-action="reply"]')?.addEventListener('click', () => {
        // 샘플 계정: 팝업 유지 + 토스트만
        if (isDemoUser(window.currentUser)) {
            showToast('체험 계정에서는 답장을 보낼수 없어요', 'error');
            return;
        }
        removeSheet();
        replyToPost(postId);
    });

    root.querySelector('[data-feed-action="edit"]')?.addEventListener('click', () => {
        removeSheet();
        openEditFeedModal(postId);
    });

    root.querySelector('[data-feed-action="delete"]')?.addEventListener('click', async () => {
        if (!confirm('이 메시지를 삭제할까요?')) return;
        removeSheet();
        try {
            await feedOperations.deleteMessage(postId);
            await renderBoardFeedTab();
        } catch (_) {}
    });

    root.querySelectorAll('[data-feed-react]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const type = btn.getAttribute('data-feed-react');
            if (!type) return;
            if (!window.currentUser || window.currentUser.isAnonymous) {
                showToast('로그인이 필요합니다.', 'error');
                window.requestLogin?.();
                return;
            }
            if (isDemoUser(window.currentUser)) {
                showToast('체험 계정에서는 반응을 표시할 수 없어요', 'error');
                return;
            }
            removeSheet();
            try {
                await feedOperations.setFeedReaction(postId, type);
                await renderBoardFeedTab();
            } catch (_) {}
        });
    });
}

export function initFeedBubbleContextMenu() {
    const root = document.getElementById('boardFeedPanelContent');
    if (!root || root.dataset.feedBubbleMenuBound === '1') return;
    root.dataset.feedBubbleMenuBound = '1';

    let timer = null;
    let startX = 0;
    let startY = 0;
    let pending = null;

    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
    };

    const armLongPress = (e, bubble, postId, isMine) => {
        clearTimer();
        startX = e.clientX;
        startY = e.clientY;
        pending = { bubble, postId, isMine };
        timer = setTimeout(() => {
            timer = null;
            if (!pending) return;
            try {
                e.preventDefault();
            } catch (_) {}
            showFeedBubbleSheet({ postId: pending.postId, isMine: pending.isMine, bubble: pending.bubble });
            pending = null;
        }, LONG_PRESS_MS);
    };

    root.addEventListener(
        'pointerdown',
        (e) => {
            const bubble = e.target.closest?.('.feed-chat-bubble');
            if (!bubble || !root.contains(bubble)) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            const row = bubble.closest('[data-post-id]');
            const postId = row?.getAttribute('data-post-id');
            if (!postId) return;
            const isMine = bubble.classList.contains('feed-chat-bubble-mine');
            armLongPress(e, bubble, postId, isMine);
        },
        { passive: true }
    );

    root.addEventListener('pointermove', (e) => {
        if (!timer || !pending) return;
        const dx = Math.abs(e.clientX - startX);
        const dy = Math.abs(e.clientY - startY);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) clearTimer();
    });

    root.addEventListener('pointerup', clearTimer);
    root.addEventListener('pointercancel', clearTimer);

    root.addEventListener('contextmenu', (e) => {
        const bubble = e.target.closest?.('.feed-chat-bubble');
        if (!bubble || !root.contains(bubble)) return;
        e.preventDefault();
        const row = bubble.closest('[data-post-id]');
        const postId = row?.getAttribute('data-post-id');
        if (!postId) return;
        clearTimer();
        const isMine = bubble.classList.contains('feed-chat-bubble-mine');
        showFeedBubbleSheet({ postId, isMine, bubble });
    });
}
