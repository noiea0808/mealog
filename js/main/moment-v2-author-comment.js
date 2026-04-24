/**
 * 화면2: `data-moment-v2-author-comment-band` — 글쓴이 **코멘트**(기록, 소셜 **댓글**과 구분)
 * (타임라인 휠 팝업 `authorMealComment`과 동일 데이터)
 */
import { escapeHtml } from '../render/utils.js';

function v2ActiveIndexFromStrip(strip) {
    const cells = strip.querySelectorAll('.moment-v2-h-slide');
    if (!cells.length) return 0;
    const step = cells[0].offsetWidth || strip.clientWidth;
    if (step <= 0) return 0;
    let idx = Math.round(strip.scrollLeft / step);
    return Math.min(cells.length - 1, Math.max(0, idx));
}

function getStripAndIdx(scope) {
    const stage = scope.querySelector('.moment-v2-wheel-stage');
    const strip = stage?.querySelector?.('.moment-v2-hstrip');
    if (!strip) return { strip: null, idx: 0 };
    /* 다장·가로 사진만 스와이프: 기록 코멘트는 첫 사진(인덱스 0) 기준으로 고정 */
    if (scope.getAttribute('data-moment-v2-swipe-photos-only') === '1') {
        return { strip, idx: 0 };
    }
    return { strip, idx: v2ActiveIndexFromStrip(strip) };
}

function readLabels(root) {
    const raw = root?.getAttribute?.('data-moment-v2-labels');
    if (!raw) return [];
    try {
        return JSON.parse(decodeURIComponent(raw));
    } catch (_) {
        return [];
    }
}

function getCaptionInRoot(root) {
    if (root?._mv2PortaledCaption?.isConnected) return root._mv2PortaledCaption;
    if (root?._mv2PortaledCaption) root._mv2PortaledCaption = null;
    return root?.querySelector?.('[data-moment-v2-caption]') || null;
}

/**
 * @param {HTMLElement} root — `.moment-feed-v2-scope`
 */
export function syncMomentV2AuthorCommentBand(root) {
    if (!root?.querySelector) return;
    if (root.getAttribute('data-moment-v2-vscroll') === '1') return;
    const cap = getCaptionInRoot(root);
    const band = cap?.querySelector?.('[data-moment-v2-author-comment-band]');
    const body = cap?.querySelector?.('[data-moment-v2-author-comment-body]');
    if (!band || !body) return;
    const labels = readLabels(root);
    const { strip, idx } = getStripAndIdx(root);
    const payload = Array.isArray(labels) && labels[idx] ? labels[idx] : null;
    const ac = (payload && String(payload.ac || '').trim()) || '';
    const hasAc = Boolean(ac);
    if (!hasAc) {
        body.innerHTML = '';
        band.classList.add('hidden');
        const stEmpty = root.querySelector('.moment-v2-wheel-stage');
        if (stEmpty && typeof stEmpty._momentV2RunLayout === 'function') {
            requestAnimationFrame(() => stEmpty._momentV2RunLayout());
        }
        return;
    }
    body.innerHTML = `<div class="whitespace-pre-wrap break-words">${escapeHtml(ac)}</div>`;
    band.classList.remove('hidden');
    const st = root.querySelector('.moment-v2-wheel-stage');
    if (st && typeof st._momentV2RunLayout === 'function') {
        requestAnimationFrame(() => st._momentV2RunLayout());
    }
}

/**
 * @param {ParentNode | null} scopeEl
 */
export function ensureMomentV2AuthorCommentToggleBound(scopeEl) {
    if (!scopeEl || scopeEl._momentV2AuthorCommentBound) return;
    scopeEl._momentV2AuthorCommentBound = true;
    /* 화면2는 기록 코멘트 토글 없음(타임라인 휠 팝업만 `data-meal-photo-comment-toggle` 사용) */
}

/**
 * 휠 스트립 인덱스 바뀔 때(스크롤) 기록 코멘트 갱신
 * @param {HTMLElement} stage — `.moment-v2-wheel-stage`
 */
export function onMomentV2ActivePhotoMaybeChangedForAuthorComment(stage) {
    const root = stage?.closest?.('.moment-feed-v2-scope');
    if (!root) return;
    syncMomentV2AuthorCommentBand(root);
}
