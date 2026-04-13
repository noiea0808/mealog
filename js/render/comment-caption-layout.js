/**
 * 모먼트/피드 공유 코멘트: 본문 + 「더보기」를 합쳐 최대 3줄로 표시 (측정 후 마운트)
 */
import { escapeHtml } from './utils.js';

const DEFAULT_MAX_LINES = 3;

function getToggleHandler(variant) {
    return variant === 'feed' ? 'toggleFeedComment' : 'togglePostCaption';
}

function copyTextMeasureStyles(fromEl, measure) {
    if (!fromEl) return;
    const cs = getComputedStyle(fromEl);
    measure.style.font = cs.font;
    measure.style.fontSize = cs.fontSize;
    measure.style.fontFamily = cs.fontFamily;
    measure.style.fontWeight = cs.fontWeight;
    measure.style.fontStyle = cs.fontStyle;
    measure.style.letterSpacing = cs.letterSpacing;
    measure.style.lineHeight = cs.lineHeight;
}

/**
 * 접힌 캡션 HTML 생성 (폭·폰트를 알 때 줄임)
 * @param {string} rawText
 * @param {{ widthPx?: number, maxLines?: number, variant?: string, groupIdx?: string|number, styleSourceEl?: Element }} options
 * @returns {{ html: string, truncated: boolean }}
 */
export function computeCollapsedCaptionHtml(rawText, options = {}) {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const variant = options.variant || 'moment';
    const groupIdx = options.groupIdx != null ? String(options.groupIdx) : '';
    const width = options.widthPx;
    const styleSource = options.styleSourceEl || null;
    const raw = rawText == null ? '' : String(rawText);

    if (!raw.trim()) {
        return { html: '', truncated: false };
    }

    if (!width || width <= 0) {
        return {
            html: `<span class="whitespace-pre-wrap break-words leading-snug">${escapeHtml(raw)}</span>`,
            truncated: false
        };
    }

    const measure = document.createElement('div');
    measure.style.cssText =
        'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;word-break:break-word;';
    measure.style.width = `${width}px`;
    copyTextMeasureStyles(styleSource, measure);
    document.body.appendChild(measure);

    try {
        const lh = parseFloat(getComputedStyle(measure).lineHeight) || 21;
        const maxH = lh * maxLines + 1;

        const spanFull = document.createElement('span');
        spanFull.style.whiteSpace = 'pre-wrap';
        spanFull.style.wordBreak = 'break-word';
        spanFull.textContent = raw;
        measure.appendChild(spanFull);
        if (measure.scrollHeight <= maxH) {
            return {
                html: `<span class="whitespace-pre-wrap break-words leading-snug">${escapeHtml(raw)}</span>`,
                truncated: false
            };
        }
        measure.removeChild(spanFull);

        const handler = getToggleHandler(variant);
        let lo = 0;
        let hi = raw.length;
        let best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const prefix = raw.slice(0, mid);
            measure.innerHTML = buildTruncatedInnerHtml(prefix, handler, groupIdx);
            if (measure.scrollHeight <= maxH) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        if (best <= 0) {
            best = 1;
        }
        const prefix = raw.slice(0, best);
        return {
            html: buildTruncatedInnerHtml(prefix, handler, groupIdx),
            truncated: true
        };
    } finally {
        measure.remove();
    }
}

function buildTruncatedInnerHtml(prefix, handler, groupIdx) {
    const esc = escapeHtml(prefix);
    const idx = escapeAttr(groupIdx);
    const moreBtn = `<button type="button" class="inline p-0 align-baseline text-emerald-600 font-bold hover:text-emerald-700 active:text-emerald-800 bg-transparent border-0 cursor-pointer" data-caption-more="1" onclick="window.${handler}('${idx}')">더보기</button>`;
    return `<span class="whitespace-pre-wrap break-words leading-snug">${esc}… </span>${moreBtn}`;
}

function escapeAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * `#post-caption-collapsed-*` / `#feed-comment-collapsed-*` 안의 `[data-comment-collapsed-mount]`에 HTML 마운트
 * @param {HTMLElement} collapsedEl
 */
export function applyCollapsedCaptionToElement(collapsedEl) {
    if (!collapsedEl || !collapsedEl.querySelector) return;
    const mount = collapsedEl.querySelector('[data-comment-collapsed-mount]');
    if (!mount) return;

    let raw = '';
    try {
        raw = decodeURIComponent(collapsedEl.getAttribute('data-comment-raw') || '');
    } catch (_) {
        raw = collapsedEl.getAttribute('data-comment-raw') || '';
    }
    const variant = collapsedEl.getAttribute('data-caption-variant') || 'moment';
    const groupIdx = collapsedEl.getAttribute('data-group-idx') != null ? collapsedEl.getAttribute('data-group-idx') : '';

    if (!raw) {
        mount.innerHTML = '';
        return;
    }

    const width = collapsedEl.getBoundingClientRect().width;
    const { html } = computeCollapsedCaptionHtml(raw, {
        widthPx: width,
        variant,
        groupIdx,
        maxLines: DEFAULT_MAX_LINES,
        styleSourceEl: collapsedEl
    });

    mount.innerHTML = html;
}
