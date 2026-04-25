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

function refreshMomentV2AuthorCommentClampForBand(band) {
    if (!band || band.classList.contains('hidden')) return;
    const body = band.querySelector('[data-moment-v2-author-comment-body], [data-moment-v2-author-comment-body-unit]');
    if (!body) return;
    band.classList.remove('moment-v2-author-comment-band--expanded', 'moment-v2-author-comment-band--expandable');
    band.removeAttribute('data-moment-v2-author-comment-overflow');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            void body.offsetHeight;
            const ch = body.clientHeight;
            const sh = body.scrollHeight;
            if (sh <= ch + 3) return;
            band.classList.add('moment-v2-author-comment-band--expandable');
            band.setAttribute('data-moment-v2-author-comment-overflow', '1');
        });
    });
}

/**
 * @param {ParentNode | null | undefined} scopeEl — #galleryContainer, #feedContent 등
 */
export function refreshAllMomentV2AuthorCommentBandsIn(scopeEl) {
    if (!scopeEl?.querySelectorAll) return;
    scopeEl.querySelectorAll('[data-moment-v2-author-comment-band], [data-moment-v2-author-unit]').forEach((band) => {
        if (!band.classList.contains('hidden')) refreshMomentV2AuthorCommentClampForBand(band);
    });
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
        band.classList.remove('moment-v2-author-comment-band--expanded', 'moment-v2-author-comment-band--expandable');
        band.removeAttribute('data-moment-v2-author-comment-overflow');
        const stEmpty = root.querySelector('.moment-v2-wheel-stage');
        if (stEmpty && typeof stEmpty._momentV2RunLayout === 'function') {
            requestAnimationFrame(() => stEmpty._momentV2RunLayout());
        }
        return;
    }
    body.innerHTML = `<div class="whitespace-pre-wrap break-words">${escapeHtml(ac)}</div>`;
    band.classList.remove('hidden');
    refreshMomentV2AuthorCommentClampForBand(band);
    const st = root.querySelector('.moment-v2-wheel-stage');
    if (st && typeof st._momentV2RunLayout === 'function') {
        requestAnimationFrame(() => st._momentV2RunLayout());
    }
}

/**
 * @param {ParentNode | null | undefined} scopeEl — 보통 `document.body` (한 번만 바인딩)
 */
export function ensureMomentV2AuthorCommentToggleBound(scopeEl) {
    if (!scopeEl || scopeEl._momentV2AuthorCommentBound) return;
    scopeEl._momentV2AuthorCommentBound = true;
    document.body.addEventListener(
        'click',
        (ev) => {
            const band = ev.target.closest('[data-moment-v2-author-comment-band], [data-moment-v2-author-unit]');
            if (!band || band.classList.contains('hidden')) return;
            const inMv2 =
                band.closest('#galleryContainer.moment-feed-layout-v2') ||
                band.closest('#feedContent[data-moment-feed-layout="2"]');
            if (!inMv2) return;
            if (!band.classList.contains('moment-v2-author-comment-band--expandable')) return;
            if (ev.target.closest('button, a, input, textarea, [role="button"], [data-meal-feed-options]')) return;
            band.classList.toggle('moment-v2-author-comment-band--expanded');
            const st = band.closest('.moment-v2-wheel-stage');
            if (st && typeof st._momentV2RunLayout === 'function') {
                requestAnimationFrame(() => st._momentV2RunLayout());
            }
        },
        true
    );
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
