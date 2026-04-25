/**
 * 화면2 인라인: 사진 위 닉/소셜 — 가로 hstrip 또는 세로 vscroll(`.moment-v2-v-photo-clip`마다) 앵커.
 */
import { isMomentV2HstripAtSnapPoint } from './moment-v2-hstrip-snap.js';

function frameUsesMv2Hstrip(frame) {
    return Boolean(frame?.querySelector?.('.moment-v2-hstrip'));
}

function getMv2CarouselViewportEl(frame) {
    return frame?.querySelector?.('.moment-v2-carousel-viewport, .timeline-meal-photos-carousel-viewport') || null;
}

function v2ActiveIndexFromStrip(strip) {
    const cells = strip.querySelectorAll('.moment-v2-h-slide');
    if (!cells.length) return 0;
    const step = cells[0].offsetWidth || strip.clientWidth;
    if (step <= 0) return 0;
    let idx = Math.round(strip.scrollLeft / step);
    return Math.min(cells.length - 1, Math.max(0, idx));
}

function getV2FrameRects(frame) {
    if (!frame) return null;
    const viewport = frame.querySelector('.moment-v2-carousel-viewport, .timeline-meal-photos-carousel-viewport');
    const hstrip = frame.querySelector('.moment-v2-hstrip');
    if (!viewport || !hstrip) return null;
    const cells = hstrip.querySelectorAll('.moment-v2-h-slide');
    if (!cells.length) return null;
    /* 스크롤 중에도 보이는 슬롯 기준 — dataset.photoIndex(스냅 후 갱신)만 쓰면 배지·닉 위치가 어긋남 */
    let idx = v2ActiveIndexFromStrip(hstrip);
    idx = Math.min(Math.max(0, cells.length - 1), idx);
    const cell = cells[idx];
    const slot = cell?.querySelector?.('.timeline-meal-photo-aspect-slot');
    const img = cell?.querySelector?.('img.timeline-meal-photo-img');
    const irSlot = slot ? slot.getBoundingClientRect() : null;
    const irImg = img ? img.getBoundingClientRect() : null;
    const slotOk = irSlot && irSlot.width > 2 && irSlot.height > 2;
    const imgOk = irImg && irImg.width > 2 && irImg.height > 2;
    let ir;
    if (imgOk && slotOk) {
        const wDiff = irSlot.width - irImg.width;
        const hDiff = irSlot.height - irImg.height;
        ir = wDiff > 1 || hDiff > 1 ? irImg : irSlot;
    } else if (imgOk) ir = irImg;
    else if (slotOk) ir = irSlot;
    else return null;
    const vr = viewport.getBoundingClientRect();
    if (ir.width < 4 || ir.height < 4) return null;
    return { ir, vr, viewport, hstrip, img, slot };
}

function getV2ClipRects(clip) {
    if (!clip) return null;
    const slot = clip.querySelector?.('.timeline-meal-photo-aspect-slot');
    const img = clip.querySelector?.('img.timeline-meal-photo-img');
    const irSlot = slot ? slot.getBoundingClientRect() : null;
    const irImg = img ? img.getBoundingClientRect() : null;
    const slotOk = irSlot && irSlot.width > 2 && irSlot.height > 2;
    const imgOk = irImg && irImg.width > 2 && irImg.height > 2;
    let ir;
    if (imgOk && slotOk) {
        const wDiff = irSlot.width - irImg.width;
        const hDiff = irSlot.height - irImg.height;
        ir = wDiff > 1 || hDiff > 1 ? irImg : irSlot;
    } else if (imgOk) ir = irImg;
    else if (slotOk) ir = irSlot;
    else return null;
    const vr = clip.getBoundingClientRect();
    if (ir.width < 4 || ir.height < 4) return null;
    return { ir, vr, viewport: clip, img, slot };
}

function positionChromeWrapFromCtx(wrap, ctx) {
    if (!wrap || !ctx) return;
    const { ir, vr } = ctx;
    const pad = 4;
    wrap.style.position = 'absolute';
    wrap.style.left = `${Math.max(0, Math.round(ir.left - vr.left + pad))}px`;
    wrap.style.right = `${Math.max(0, Math.round(vr.right - ir.right + pad))}px`;
    wrap.style.top = `${Math.max(0, Math.round(ir.top - vr.top + pad))}px`;
    wrap.style.width = 'auto';
}

function positionSocialFromCtx(btn, ctx) {
    if (!btn || !ctx) return;
    const { ir, vr } = ctx;
    const inset = 1;
    const bottom = vr.bottom - ir.bottom + inset;
    const right = vr.right - ir.right + inset;
    btn.style.position = 'absolute';
    btn.style.top = 'auto';
    btn.style.left = 'auto';
    btn.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    btn.style.right = `${Math.max(0, Math.round(right))}px`;
    btn.style.transform = 'none';
}

function runVscrollClipLayout(clip) {
    const ctx = getV2ClipRects(clip);
    const wrap = clip?.querySelector?.('[data-moment-v2-chrome-top-wrap]');
    if (wrap) {
        if (!ctx) {
            wrap.style.removeProperty('position');
            wrap.style.removeProperty('left');
            wrap.style.removeProperty('right');
            wrap.style.removeProperty('top');
            wrap.style.removeProperty('width');
        } else {
            positionChromeWrapFromCtx(wrap, ctx);
        }
    }
    const btn = clip?.querySelector?.('[data-meal-photo-social-bubble]');
    if (btn) {
        if (!ctx) {
            btn.style.removeProperty('position');
            btn.style.removeProperty('left');
            btn.style.removeProperty('right');
            btn.style.removeProperty('bottom');
            btn.style.removeProperty('top');
            btn.style.removeProperty('transform');
        } else {
            positionSocialFromCtx(btn, ctx);
        }
    }
}

/** 닉/미트볼: 실제 사진(또는 aspect 슬롯) 사각형 좌·우·상단에 맞춤 — 휠 팝업과 동일 */
function applyTopChromeInPhoto(frame) {
    const wrap = frame?.querySelector?.('[data-moment-v2-chrome-top-wrap]');
    if (!wrap) return;
    if (frameUsesMv2Hstrip(frame)) {
        const vp = getMv2CarouselViewportEl(frame);
        const vr = vp?.getBoundingClientRect?.();
        if (!vr || vr.width < 4 || vr.height < 4) {
            wrap.style.removeProperty('position');
            wrap.style.removeProperty('left');
            wrap.style.removeProperty('right');
            wrap.style.removeProperty('top');
            wrap.style.removeProperty('width');
            return;
        }
        const pad = 4;
        wrap.style.position = 'absolute';
        wrap.style.left = `${pad}px`;
        wrap.style.right = `${pad}px`;
        wrap.style.top = `${pad}px`;
        wrap.style.width = 'auto';
        return;
    }
    const ctx = getV2FrameRects(frame);
    if (!ctx) {
        wrap.style.removeProperty('position');
        wrap.style.removeProperty('left');
        wrap.style.removeProperty('right');
        wrap.style.removeProperty('top');
        wrap.style.removeProperty('width');
        return;
    }
    const { ir, vr } = ctx;
    const pad = 4;
    wrap.style.position = 'absolute';
    wrap.style.left = `${Math.max(0, Math.round(ir.left - vr.left + pad))}px`;
    wrap.style.right = `${Math.max(0, Math.round(vr.right - ir.right + pad))}px`;
    wrap.style.top = `${Math.max(0, Math.round(ir.top - vr.top + pad))}px`;
    wrap.style.width = 'auto';
}

function applySocialAnchor(frame) {
    const btn = frame?.querySelector?.('[data-meal-photo-social-bubble]');
    if (!btn) return;
    if (frameUsesMv2Hstrip(frame)) {
        const vp = getMv2CarouselViewportEl(frame);
        const vr = vp?.getBoundingClientRect?.();
        if (!vr || vr.width < 4 || vr.height < 4) {
            btn.style.removeProperty('position');
            btn.style.removeProperty('left');
            btn.style.removeProperty('right');
            btn.style.removeProperty('bottom');
            btn.style.removeProperty('top');
            btn.style.removeProperty('transform');
            return;
        }
        btn.style.position = 'absolute';
        btn.style.top = 'auto';
        btn.style.left = 'auto';
        btn.style.right = '4px';
        btn.style.bottom = '4px';
        btn.style.transform = 'none';
        return;
    }
    const ctx = getV2FrameRects(frame);
    if (!ctx) {
        btn.style.removeProperty('position');
        btn.style.removeProperty('left');
        btn.style.removeProperty('right');
        btn.style.removeProperty('bottom');
        btn.style.removeProperty('top');
        btn.style.removeProperty('transform');
        return;
    }
    const { ir, vr } = ctx;
    const inset = 1;
    const bottom = vr.bottom - ir.bottom + inset;
    const right = vr.right - ir.right + inset;
    btn.style.position = 'absolute';
    btn.style.top = 'auto';
    btn.style.left = 'auto';
    btn.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    btn.style.right = `${Math.max(0, Math.round(right))}px`;
    btn.style.transform = 'none';
}

function syncBottomRowCenters(frame) {
    if (frameUsesMv2Hstrip(frame)) return;
    const ctx = getV2FrameRects(frame);
    if (!ctx) return;
    const { ir, vr } = ctx;
    const social = frame?.querySelector?.('[data-meal-photo-social-bubble]');
    const badge = frame?.querySelector?.('[data-carousel-badge]');

    let cY;
    if (social) {
        const r = social.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) cY = r.top + r.height / 2;
    }
    if (cY == null) {
        const laneInset = 1;
        const pickH = (el) =>
            el && !el.classList?.contains('hidden') && el.getBoundingClientRect().height > 0.4
                ? el.getBoundingClientRect().height
                : 0;
        const hRow = Math.max(pickH(badge), 28);
        cY = ir.bottom - laneInset - hRow * 0.5;
    }

    const applyBottom = (el) => {
        if (!el) return;
        if (el.classList?.contains('hidden')) return;
        const h = el.getBoundingClientRect().height;
        if (h < 0.5) return;
        const b = Math.max(0, Math.round(vr.bottom - cY - h * 0.5));
        el.style.bottom = `${b}px`;
    };
    applyBottom(social);
    applyBottom(badge);
}

function anchorBadgeToPhoto(frame) {
    const badge = frame?.querySelector?.('[data-carousel-badge]');
    if (!badge || badge.classList.contains('hidden')) {
        if (badge) {
            badge.style.removeProperty('top');
            badge.style.removeProperty('right');
            badge.style.removeProperty('left');
            badge.style.removeProperty('bottom');
            badge.style.removeProperty('transform');
        }
        return;
    }
    if (frameUsesMv2Hstrip(frame)) {
        const vp = getMv2CarouselViewportEl(frame);
        const vr = vp?.getBoundingClientRect?.();
        if (!vr || vr.width < 4 || vr.height < 4) return;
        badge.style.position = 'absolute';
        badge.style.top = 'auto';
        badge.style.right = 'auto';
        badge.style.left = '50%';
        badge.style.bottom = '8px';
        badge.style.transform = 'translateX(-50%)';
        return;
    }
    const ctx = getV2FrameRects(frame);
    if (!ctx) return;
    const { ir, vr } = ctx;
    const inset = 4;
    const bottom = vr.bottom - ir.bottom + inset;
    const cx = (ir.left + ir.right) / 2 - vr.left;
    badge.style.position = 'absolute';
    badge.style.top = 'auto';
    badge.style.right = 'auto';
    badge.style.bottom = `${Math.max(0, Math.round(bottom))}px`;
    badge.style.left = `${Math.round(cx)}px`;
    badge.style.transform = 'translateX(-50%)';
}

/**
 * @param {Element | null} frame — `.timeline-meal-photos-carousel-frame` within `.moment-feed-v2-scope`
 */
export function runMomentV2InlineChromeLayout(frame) {
    if (!frame) return;
    if (frame.querySelector?.('.moment-v2-v-photo-clip')) {
        frame.querySelectorAll('.moment-v2-v-photo-clip').forEach((c) => runVscrollClipLayout(c));
        return;
    }
    applyTopChromeInPhoto(frame);
    anchorBadgeToPhoto(frame);
    applySocialAnchor(frame);
    syncBottomRowCenters(frame);
}

export function ensureMomentV2InlineChromeForFrame(frame) {
    if (!frame || frame._momentV2InlineChromeBound) return;
    frame._momentV2InlineChromeBound = true;
    const hstrip = frame.querySelector?.('.moment-v2-hstrip');
    const vClips = frame.querySelectorAll?.('.moment-v2-v-photo-clip') || [];
    let scrollRaf = null;

    const applySettled = (relaxedSnap) => {
        if (hstrip) {
            const w = hstrip.clientWidth || 0;
            /* 가로 다장: 크롬/소셜/뱃지는 캐러셀 뷰포트 기준 고정 — 스크롤 중에도 레이아웃을 돌려도 ‘밀림’이 없음 */
            runMomentV2InlineChromeLayout(frame);
            const atSnap = w <= 0 || relaxedSnap || isMomentV2HstripAtSnapPoint(hstrip, w);
            if (atSnap && w > 0) {
                frame.dataset.photoIndex = String(v2ActiveIndexFromStrip(hstrip));
            }
            return;
        }
        runMomentV2InlineChromeLayout(frame);
    };

    const onHScroll = () => {
        if (scrollRaf != null) return;
        scrollRaf = requestAnimationFrame(() => {
            scrollRaf = null;
            applySettled(false);
        });
    };
    hstrip?.addEventListener('scroll', onHScroll, { passive: true });
    if (typeof window !== 'undefined' && 'onscrollend' in window) {
        hstrip?.addEventListener('scrollend', () => applySettled(false), { passive: true });
    }
    if (vClips.length) {
        window.addEventListener('scroll', onHScroll, { passive: true });
    }
    const onResize = () => applySettled(true);
    window.addEventListener('resize', onResize, { passive: true });
    const ro = new ResizeObserver(() => onResize());
    ro.observe(frame);
    if (hstrip) ro.observe(hstrip);
    vClips.forEach((c) => ro.observe(c));
    applySettled(true);
}
