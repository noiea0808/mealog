/**
 * 모먼트 화면2: 가로 스냅 사진(게시물 내) + 휠 라벨(YY·메뉴@장소) + 영역(작성자 코멘트 + 소셜 댓글) —
 * - 용어: 글쓴이 본문 = 코멘트(기록) / 타인 소셜 답장 = 댓글(목록+입력)
 * - 세로: 게시물 전환 — `scrollIntoView` 등. 뷰포트 `translateY` 중앙 정렬은 사용하지 않음(레이아웃·겹침 안정).
 * - 가로: hstrip만 사진 스와이프(한 장 스냅). 라벨·날짜는 캐러셀 밖 — 스냅 확정 후에만 갱신.
 */
import { isMomentV2HstripAtSnapPoint } from './moment-v2-hstrip-snap.js';
import { ensureMomentV2InlineChromeForFrame } from './moment-v2-inline-chrome.js';
import {
    ensureMomentV2AuthorCommentToggleBound,
    onMomentV2ActivePhotoMaybeChangedForAuthorComment,
    syncMomentV2AuthorCommentBand
} from './moment-v2-author-comment.js';

/** 휠 열 내부만 세로 전환(하단 바·세퍼는 고정) — 타임라인 `animateWheelTextStrip`과 동일 한 줄(30px) */
const MOMENT_V2_WHEEL_LINE_PX = 30;
const MOMENT_V2_PORTAL_ID = 'moment-v2-fixed-caption-layer';

/**
 * `#moment-v2-fixed-caption-layer`에 남은 휠 푸터(라벨+기록+소셜)를 인플로 원위치로 복원
 */
function restoreAllMomentV2PortaledCaptions() {
    if (typeof document === 'undefined') return;
    if (typeof window !== 'undefined' && window._mv2DockSlabCapRo) {
        try {
            window._mv2DockSlabCapRo.disconnect();
        } catch (_) {}
        window._mv2DockSlabCapRo = null;
        window._mv2DockSlabCapEl = null;
    }
    const layer = document.getElementById(MOMENT_V2_PORTAL_ID);
    const inner =
        layer?.querySelector?.(':scope > .moment-v2-dock-portal-inner') ||
        layer?.querySelector?.(':scope > .moment-feed-v2-scope') ||
        layer;
    if (!inner) return;
    inner.querySelectorAll('.moment-v2-caption-footer[data-moment-v2-caption]').forEach((cap) => {
        const p = cap._mv2OriginalParent;
        if (p) {
            if (cap._mv2OriginalNext) p.insertBefore(cap, cap._mv2OriginalNext);
            else p.appendChild(cap);
        }
        const pr = cap._mv2PortaledRoot;
        if (pr) pr._mv2PortaledCaption = null;
        cap._mv2OriginalParent = null;
        cap._mv2OriginalNext = null;
        cap._mv2PortaledRoot = null;
        cap.classList.remove('moment-v2-caption--dock-fixed');
        cap.removeAttribute('data-moment-v2-docked');
        cap.removeAttribute('data-moment-v2-portaled');
    });
}

function ensureMomentV2FixedCaptionLayer() {
    if (typeof document === 'undefined') return null;
    let el = document.getElementById(MOMENT_V2_PORTAL_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = MOMENT_V2_PORTAL_ID;
        el.setAttribute('aria-hidden', 'true');
        const inner = document.createElement('div');
        inner.className = 'moment-v2-dock-portal-inner';
        el.appendChild(inner);
        document.body.appendChild(el);
    } else if (!el.querySelector(':scope > .moment-v2-dock-portal-inner')) {
        const inner = document.createElement('div');
        inner.className = 'moment-v2-dock-portal-inner';
        el.appendChild(inner);
    }
    return el;
}

function getFixedCaptionPortalInner() {
    const layer = ensureMomentV2FixedCaptionLayer();
    return layer?.querySelector?.(':scope > .moment-v2-dock-portal-inner') || null;
}

function connectMomentV2DockSlabObserver(cap, root) {
    if (typeof window === 'undefined' || !cap || !root) return;
    if (window._mv2DockSlabCapRo) {
        try {
            window._mv2DockSlabCapRo.disconnect();
        } catch (_) {}
        window._mv2DockSlabCapRo = null;
    }
    window._mv2DockSlabCapEl = null;
    const slab = root.querySelector('[data-moment-v2-dock-slab]');
    if (!slab) return;
    const update = () => {
        if (!cap.isConnected) return;
        if (root._mv2PortaledCaption && root._mv2PortaledCaption !== cap) return;
        const h = Math.max(0, Math.ceil(cap.getBoundingClientRect().height));
        slab.style.minHeight = `${h}px`;
        slab.style.height = `${h}px`;
    };
    const ro = new ResizeObserver(() => {
        requestAnimationFrame(update);
    });
    ro.observe(cap);
    window._mv2DockSlabCapRo = ro;
    window._mv2DockSlabCapEl = cap;
    requestAnimationFrame(() => {
        requestAnimationFrame(update);
    });
}

function moveCaptionToFixedLayer(cap, root) {
    if (!cap || !root) return;
    const inner = getFixedCaptionPortalInner();
    if (!inner) return;
    if (!cap._mv2OriginalParent) {
        cap._mv2OriginalParent = cap.parentNode;
        cap._mv2OriginalNext = cap.nextSibling;
    }
    root._mv2PortaledCaption = cap;
    cap._mv2PortaledRoot = root;
    cap.setAttribute('data-moment-v2-portaled', '1');
    cap.setAttribute('data-moment-v2-docked', '1');
    cap.classList.add('moment-v2-caption--dock-fixed');
    inner.appendChild(cap);
    connectMomentV2DockSlabObserver(cap, root);
}

function getPrimaryMomentV2PostEl() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return null;
    const all = document.querySelectorAll('.instagram-post[data-moment-card-layout="2"]');
    let best = null;
    let bestScore = -1e9;
    const vh = window.innerHeight || 0;
    const vMid = vh * 0.5;
    for (const post of all) {
        const anchor =
            post.querySelector('[data-moment-v2-wheel-body]') || post.querySelector('.moment-v2-wheel-stage') || post;
        const r = anchor.getBoundingClientRect();
        if (r.width < 2 && r.height < 2) continue;
        const visTop = Math.max(0, r.top);
        const visBottom = Math.min(vh, r.bottom);
        const vis = Math.max(0, visBottom - visTop);
        if (vis < 8) continue;
        const cy = (r.top + r.bottom) * 0.5;
        const score = vis * 2 - Math.abs(cy - vMid) * 0.02;
        if (score > bestScore) {
            bestScore = score;
            best = post;
        }
    }
    return best;
}

/**
 * 뷰포트에 가장 가까운 화면2 게시물의 휠 푸터를 앱 하단 네비 바로 위에 고정(나머지는 인플로 숨김).
 */
function runMomentV2PrimaryFixedDock() {
    if (typeof document === 'undefined') return;
    const primary = getPrimaryMomentV2PostEl();
    const allPosts = document.querySelectorAll('.instagram-post[data-moment-card-layout="2"]');
    allPosts.forEach((post) => {
        const root = post.querySelector('.moment-feed-v2-scope[data-moment-v2-root]');
        const cap = root?.querySelector?.('[data-moment-v2-caption]');
        const slab = root?.querySelector?.('[data-moment-v2-dock-slab]');
        if (slab) {
            slab.style.minHeight = '';
            slab.style.height = '';
        }
        if (cap) {
            if (post === primary) {
                cap.classList.remove('mv2-cap-inflow-hidden');
            } else {
                cap.classList.add('mv2-cap-inflow-hidden');
            }
        }
    });
    if (!primary) return;
    const root = primary.querySelector('.moment-feed-v2-scope[data-moment-v2-root]');
    const cap = root?.querySelector?.('[data-moment-v2-caption]');
    const stage = primary.querySelector('.moment-v2-wheel-stage');
    if (!root || !cap) return;
    ensureMomentV2FixedCaptionLayer();
    moveCaptionToFixedLayer(cap, root);
    requestAnimationFrame(() => {
        if (typeof stage?._momentV2RunLayout === 'function') {
            stage._momentV2RunLayout();
        } else {
            syncMomentV2AuthorCommentBand(root);
        }
    });
}

/**
 * @param {Element | null | undefined} stageEl
 * @returns {Element | null}
 */
function getMomentV2CaptionForStage(stageEl) {
    if (!stageEl) return null;
    const root = stageEl.closest?.('.moment-feed-v2-scope[data-moment-v2-root]');
    if (root?._mv2PortaledCaption?.isConnected) return root._mv2PortaledCaption;
    if (root?._mv2PortaledCaption) root._mv2PortaledCaption = null;
    const inStage = stageEl.querySelector?.('.moment-v2-caption-footer[data-moment-v2-caption]');
    if (inStage) return inStage;
    const st = stageEl.closest?.('.moment-v2-wheel-stage') || stageEl;
    return st?.querySelector?.('.moment-v2-caption-footer[data-moment-v2-caption]') || null;
}

function escapeHtmlMomentV2Text(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 애니 프레임은 타임라인 `animateWheelTextStrip`과 같이 `meal-photo-wheel-label-line`만 — Tailwind `leading-none`·`h-[30px]` 쓰면 한 줄(30px)과 translateY 거리가 어긋남 */
function lineClassForMomentV2Strip(strip) {
    const t = strip?.getAttribute?.('data-moment-v2-stripe');
    if (t === 'menu') {
        return 'meal-photo-wheel-label-line moment-v2-wheel-menu-anim-line';
    }
    if (t === 'label') {
        return 'meal-photo-wheel-label-line';
    }
    return 'meal-photo-wheel-label-line';
}

function setMomentV2StripImmediate(strip, text) {
    if (!strip) return;
    const t = text == null ? '—' : String(text);
    strip.dataset.momentV2Cur = t;
    strip.dataset.cur = t;
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    const cls = lineClassForMomentV2Strip(strip);
    strip.innerHTML = `<span class="${cls}">${escapeHtmlMomentV2Text(t)}</span>`;
}

/**
 * @param {'forward'|'backward'} direction
 */
function animateMomentV2TextStrip(strip, newText, direction, shouldAnimate) {
    if (!strip) return;
    const t = newText == null ? '—' : String(newText);
    const old =
        strip.dataset.cur != null
            ? String(strip.dataset.cur)
            : strip.dataset.momentV2Cur != null
              ? String(strip.dataset.momentV2Cur)
              : '';
    const cls = lineClassForMomentV2Strip(strip);
    if (strip._mv2StripTid) {
        clearTimeout(strip._mv2StripTid);
        strip._mv2StripTid = null;
    }
    if (strip._mv2StripOnEnd) {
        strip.removeEventListener('transitionend', strip._mv2StripOnEnd);
        strip._mv2StripOnEnd = null;
    }
    if (!shouldAnimate || old === t) {
        setMomentV2StripImmediate(strip, t);
        return;
    }
    const enc = escapeHtmlMomentV2Text(t);
    const encOld = escapeHtmlMomentV2Text(old);
    strip.style.transition = 'none';
    if (direction === 'forward') {
        strip.innerHTML = `<span class="${cls}">${encOld}</span><span class="${cls}">${enc}</span>`;
        strip.style.transform = 'translateY(0)';
    } else {
        strip.innerHTML = `<span class="${cls}">${enc}</span><span class="${cls}">${encOld}</span>`;
        strip.style.transform = `translateY(-${MOMENT_V2_WHEEL_LINE_PX}px)`;
    }
    void strip.offsetHeight;
    const finish = () => {
        if (strip._mv2StripOnEnd) {
            strip.removeEventListener('transitionend', strip._mv2StripOnEnd);
            strip._mv2StripOnEnd = null;
        }
        if (strip._mv2StripTid) {
            clearTimeout(strip._mv2StripTid);
            strip._mv2StripTid = null;
        }
        setMomentV2StripImmediate(strip, t);
    };
    strip._mv2StripOnEnd = (e) => {
        if (e.target !== strip) return;
        if (e.propertyName && e.propertyName !== 'transform') return;
        finish();
    };
    strip.addEventListener('transitionend', strip._mv2StripOnEnd);
    strip._mv2StripTid = setTimeout(finish, 320);
    strip.style.transition = 'transform 0.22s ease-out';
    if (direction === 'forward') {
        strip.style.transform = `translateY(-${MOMENT_V2_WHEEL_LINE_PX}px)`;
    } else {
        strip.style.transform = 'translateY(0)';
    }
}

function getMomentV2CarouselStrip(stageEl) {
    return stageEl.querySelector('.moment-v2-hstrip');
}

function parseMomentV2Labels(rootEl) {
    const raw = rootEl?.getAttribute?.('data-moment-v2-labels');
    if (!raw) return [];
    try {
        return JSON.parse(decodeURIComponent(raw));
    } catch (_) {
        return [];
    }
}

/** 세로 스크롤로 이전/다음 게시물로 바뀔 때 휠 박스(년·월·일·슬롯) 애니: 직전에 보이던 휠 값 */
let _mv2GlobalLastCaption = null;
let _mv2GlobalLastCaptionPost = null;

function commitMv2GlobalWheelCaptionFromPayload(postEl, payload) {
    if (!postEl || !payload || typeof payload !== 'object') return;
    _mv2GlobalLastCaption = {
        y: payload.y,
        mo: payload.mo,
        da: payload.da,
        wd: payload.wd,
        slot: payload.slot,
        menu: payload.menu
    };
    _mv2GlobalLastCaptionPost = postEl;
}

function applyMomentV2CaptionPayload(stageEl, payload, animCtx) {
    const cap = getMomentV2CaptionForStage(stageEl);
    if (!cap || !payload || typeof payload !== 'object') return;
    const root = stageEl.closest('[data-moment-v2-root]');
    const currentPost = stageEl.closest?.('.instagram-post') || null;
    const keys = ['y', 'mo', 'da', 'wd', 'slot', 'menu'];
    const prevIdx = animCtx && typeof animCtx.prevIndex === 'number' ? animCtx.prevIndex : null;
    const newIdx = animCtx && typeof animCtx.newIndex === 'number' ? animCtx.newIndex : null;
    const prevPayload = animCtx && animCtx.prevPayload;
    const crossPost = Boolean(animCtx && animCtx.crossPost);
    const samePostAnim =
        Boolean(animCtx && animCtx.shouldAnimate) &&
        prevIdx != null &&
        newIdx != null &&
        prevIdx !== newIdx &&
        prevPayload &&
        typeof prevPayload === 'object';
    const doAnim = samePostAnim || (crossPost && prevPayload && typeof prevPayload === 'object');
    let direction = 'forward';
    if (doAnim) {
        if (crossPost) {
            const ps = animCtx && animCtx.postScrollDirection;
            direction = ps === 'backward' ? 'backward' : 'forward';
        } else if (newIdx < prevIdx) {
            direction = 'backward';
        }
    }
    const staggerFieldMs = animCtx && crossPost && typeof animCtx.staggerFieldMs === 'number' ? animCtx.staggerFieldMs : 0;
    if (doAnim && crossPost && prevPayload) {
        for (const key of keys) {
            const strip = cap.querySelector(`.moment-v2-wheel-anim-strip[data-moment-v2-f="${key}"]`);
            if (!strip) continue;
            const o = prevPayload[key];
            const oldVal = o != null ? String(o) : '—';
            setMomentV2StripImmediate(strip, oldVal);
        }
        void cap.offsetHeight;
    }
    const runOneKey = (key) => {
        const strip = cap.querySelector(`.moment-v2-wheel-anim-strip[data-moment-v2-f="${key}"]`);
        if (!strip) return;
        const val = payload[key];
        if (val === undefined) return;
        const newVal = val != null ? String(val) : '—';
        if (doAnim) {
            const oldVal = prevPayload[key] != null ? String(prevPayload[key]) : '—';
            animateMomentV2TextStrip(strip, newVal, direction, oldVal !== newVal);
        } else {
            setMomentV2StripImmediate(strip, newVal);
        }
    };
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (staggerFieldMs > 0) {
            setTimeout(() => runOneKey(key), i * staggerFieldMs);
        } else {
            runOneKey(key);
        }
    }
    if (root && newIdx != null) {
        root._momentV2PrevPhotoIndex = newIdx;
        root._momentV2PrevCaptionPayload = { ...payload };
    }
    commitMv2GlobalWheelCaptionFromPayload(currentPost, payload);
}

function syncMomentV2WheelCaptionInnerWidth(stageEl) {
    const photoShell = stageEl.querySelector('.moment-v2-photo-shell');
    const cap = getMomentV2CaptionForStage(stageEl);
    const labelRow =
        cap?.querySelector?.('.moment-v2-wheel-caption-row.timeline-meal-photo-menu-bar') ||
        cap?.querySelector?.('.moment-v2-wheel-caption-row');
    /* APP 네비 폭(28rem 느낌)이 아닌, 휠 한 줄(날짜·메뉴 라벨) 실측 = 사진·도크 공통 --meal-wheel-caption-inner-w */
    let wRef = labelRow;
    let br = wRef ? wRef.getBoundingClientRect() : { width: 0, height: 0 };
    if (!wRef || br.width < 8) {
        wRef = cap || photoShell || stageEl;
        br = wRef.getBoundingClientRect();
    }
    const w = Math.max(40, Math.floor(br.width));
    const wStr = `${w}px`;
    stageEl.style.setProperty('--meal-wheel-caption-inner-w', wStr);
    if (cap) cap.style.setProperty('--meal-wheel-caption-inner-w', wStr);
    const innerRow = cap?.querySelector?.('.moment-v2-wheel-caption-row');
    if (innerRow) {
        innerRow.style.width = wStr;
        innerRow.style.maxWidth = '100%';
        innerRow.style.marginLeft = 'auto';
        innerRow.style.marginRight = 'auto';
        innerRow.style.boxSizing = 'border-box';
    }
}

export function getMomentV2CarouselActiveIndex(strip) {
    const cells = strip.querySelectorAll('.moment-v2-h-slide');
    if (!cells.length) return 0;
    const step = cells[0].offsetWidth || strip.clientWidth;
    if (step <= 0) return 0;
    let idx = Math.round(strip.scrollLeft / step);
    idx = Math.min(cells.length - 1, Math.max(0, idx));
    return idx;
}

function normalizeWheelDelta2D(e, clientW, clientH) {
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
        const line = 16;
        dx *= line;
        dy *= line;
    } else if (e.deltaMode === 2) {
        dx *= clientW > 0 ? clientW : 1;
        dy *= clientH > 0 ? clientH : 1;
    }
    return { dx, dy };
}

/** 세로 휠/트랙패드 → 같은 컨테이너의 위·아래 게시물 */
function scrollAdjacentInstagramPost(stageEl, deltaY) {
    if (!deltaY) return;
    const post = stageEl.closest('.instagram-post');
    if (!post?.parentElement) return;
    const posts = [...post.parentElement.querySelectorAll(':scope > .instagram-post')];
    const i = posts.indexOf(post);
    if (i < 0) return;
    const dir = deltaY > 0 ? 1 : -1;
    const next = posts[i + dir];
    if (next) {
        next.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    requestAnimationFrame(() => {
        setTimeout(() => scheduleMomentV2SplitCaptionLayout(), 0);
    });
}

let _v2CapFixRaf = 0;

function scheduleMomentV2SplitCaptionLayout() {
    if (typeof window === 'undefined') return;
    if (_v2CapFixRaf) return;
    _v2CapFixRaf = requestAnimationFrame(() => {
        _v2CapFixRaf = 0;
        runMomentV2SplitCaptionLayout();
    });
}

/** 인플로 복원 → primary 도크(앱 네비 위) → 휠 행(--meal-wheel-caption-inner-w) 동기화 */
function runMomentV2SplitCaptionLayout() {
    if (typeof document === 'undefined') return;
    restoreAllMomentV2PortaledCaptions();
    runMomentV2PrimaryFixedDock();
    document.querySelectorAll('.moment-v2-wheel-stage--split-caption').forEach((st) => {
        if (st?.isConnected) syncMomentV2WheelCaptionInnerWidth(st);
    });
}

function ensureMomentV2PrimaryCaptionGlobalListeners() {
    if (typeof window === 'undefined' || window._mv2PrimaryCaptionVfix) return;
    window._mv2PrimaryCaptionVfix = true;
    const on = () => scheduleMomentV2SplitCaptionLayout();
    if (typeof window !== 'undefined' && 'onscrollend' in window) {
        window.addEventListener('scrollend', on, { passive: true });
    } else {
        let t = 0;
        const debounced = () => {
            if (t) clearTimeout(t);
            t = setTimeout(() => {
                t = 0;
                on();
            }, 120);
        };
        window.addEventListener('scroll', debounced, { passive: true, capture: true });
    }
    window.addEventListener('resize', on, { passive: true });
    document.addEventListener('focusin', on, true);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', on, { passive: true });
    }
    requestAnimationFrame(on);
}

/**
 * 타임라인 `bindCarouselSwipe`의 hstrip 휠과 동일 + 세로는 게시물 이동
 */
function bindMomentV2CarouselAreaWheel(photoShell, strip, stageEl) {
    if (!photoShell || !strip || photoShell._momentV2CarouselWheelBound) return;
    photoShell._momentV2CarouselWheelBound = true;
    const onWheel = (e) => {
        if (!photoShell.contains(e.target)) return;
        const cw = strip.clientWidth || 1;
        const ch = strip.clientHeight || 1;
        const { dx, dy } = normalizeWheelDelta2D(e, cw, ch);
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absX > 0 && absX >= absY) {
            strip.scrollLeft += dx;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (e.shiftKey && absY > 0) {
            strip.scrollLeft += dy;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (absY > absX && absY > 0) {
            scrollAdjacentInstagramPost(stageEl, dy);
            e.preventDefault();
            e.stopPropagation();
        }
    };
    photoShell.addEventListener('wheel', onWheel, { passive: false, capture: true });

    /** 터치/포인터: 휠 이벤트가 없는 기기에서 사진 위 세로 스와이프 → 이전/다음 게시물 */
    if (!photoShell._momentV2PointerVNav) {
        photoShell._momentV2PointerVNav = true;
        let pDown = null;
        const onPD = (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            pDown = { x: e.clientX, y: e.clientY, id: e.pointerId };
        };
        const onPU = (e) => {
            if (!pDown || e.pointerId !== pDown.id) return;
            const dx = e.clientX - pDown.x;
            const dy = e.clientY - pDown.y;
            pDown = null;
            if (Math.abs(dy) < 56) return;
            if (Math.abs(dy) <= Math.abs(dx) * 1.12) return;
            scrollAdjacentInstagramPost(stageEl, dy);
        };
        const onPC = (e) => {
            if (pDown && e.pointerId === pDown.id) pDown = null;
        };
        photoShell.addEventListener('pointerdown', onPD, { passive: true, capture: true });
        photoShell.addEventListener('pointerup', onPU, { passive: true, capture: true });
        photoShell.addEventListener('pointercancel', onPC, { passive: true, capture: true });
    }
}

function bindOneMomentV2WheelStage(stageEl) {
    if (stageEl._momentV2WheelBound) return;
    stageEl._momentV2WheelBound = true;

    const root = stageEl.closest('[data-moment-v2-root]') || stageEl.parentElement?.closest?.('[data-moment-v2-root]');
    const strip = getMomentV2CarouselStrip(stageEl);
    const viewport = stageEl.querySelector('.timeline-meal-photos-carousel-viewport');
    const photoShell = stageEl.querySelector('.moment-v2-photo-shell') || viewport;

    let captionScrollRaf = null;

    const runAfterIndexChange = () => {
        if (strip) {
            const w = strip.clientWidth || 0;
            if (w > 0 && !isMomentV2HstripAtSnapPoint(strip, w)) {
                return;
            }
        }
        syncMomentV2WheelCaptionInnerWidth(stageEl);
        const labels = parseMomentV2Labels(root);
        if (labels.length && strip) {
            const idx = getMomentV2CarouselActiveIndex(strip);
            const currentPost = stageEl.closest('.instagram-post');
            const prevIdx = root._momentV2PrevPhotoIndex;
            const prevPay = root._momentV2PrevCaptionPayload;
            const payload = labels[idx];
            if (payload) {
                const samePostAnim = prevIdx != null && prevIdx !== idx && prevPay && typeof prevPay === 'object';
                let crossPost = false;
                let prevForAnim = prevPay;
                let postScrollDirection = 'forward';
                if (
                    !samePostAnim &&
                    _mv2GlobalLastCaption &&
                    _mv2GlobalLastCaptionPost &&
                    currentPost &&
                    _mv2GlobalLastCaptionPost !== currentPost
                ) {
                    crossPost = true;
                    prevForAnim = { ..._mv2GlobalLastCaption };
                    const parent = currentPost.parentElement;
                    if (parent && _mv2GlobalLastCaptionPost.parentElement === parent) {
                        const posts = [...parent.querySelectorAll(':scope > .instagram-post')];
                        const a = posts.indexOf(_mv2GlobalLastCaptionPost);
                        const b = posts.indexOf(currentPost);
                        if (a >= 0 && b >= 0) {
                            postScrollDirection = b < a ? 'backward' : 'forward';
                        }
                    }
                }
                const shouldAnimate = samePostAnim;
                applyMomentV2CaptionPayload(stageEl, payload, {
                    prevIndex: prevIdx,
                    newIndex: idx,
                    prevPayload: prevForAnim,
                    shouldAnimate,
                    crossPost,
                    postScrollDirection,
                    staggerFieldMs: crossPost ? 38 : 0
                });
            }
        }
        onMomentV2ActivePhotoMaybeChangedForAuthorComment(stageEl);
        syncMomentV2WheelCaptionInnerWidth(stageEl);
    };

    /** 팝업 `onHScroll` + `syncMealPhotoHstripIndexFromScroll`과 동일: 스냅에 붙었을 때만 휠·라벨·슬랩·primary 갱신 */
    const onHStripScrollSettled = () => {
        if (captionScrollRaf != null) return;
        captionScrollRaf = requestAnimationFrame(() => {
            captionScrollRaf = null;
            if (!strip) return;
            const w = strip.clientWidth || 0;
            if (w <= 0) return;
            if (!isMomentV2HstripAtSnapPoint(strip, w)) {
                return;
            }
            runAfterIndexChange();
        });
    };

    const rafSync = () => requestAnimationFrame(runAfterIndexChange);

    bindMomentV2CarouselAreaWheel(photoShell, strip, stageEl);

    if (strip) {
        strip.addEventListener('scroll', onHStripScrollSettled, { passive: true });
        if (typeof window !== 'undefined' && 'onscrollend' in window) {
            strip.addEventListener('scrollend', rafSync, { passive: true });
        } else {
            let settleTimer = null;
            strip.addEventListener(
                'scroll',
                () => {
                    if (settleTimer) clearTimeout(settleTimer);
                    settleTimer = setTimeout(() => {
                        settleTimer = null;
                        if (!isMomentV2HstripAtSnapPoint(strip, strip.clientWidth || 0)) {
                            return;
                        }
                        rafSync();
                    }, 200);
                },
                { passive: true }
            );
        }
    }

    window.addEventListener('resize', rafSync, { passive: true });
    const capForRo = getMomentV2CaptionForStage(stageEl);
    const ro = new ResizeObserver(() => {
        rafSync();
    });
    ro.observe(stageEl);
    if (photoShell) ro.observe(photoShell);
    if (viewport) ro.observe(viewport);
    if (root) ro.observe(root);
    const centerStack = stageEl.querySelector('[data-moment-v2-center-stack]');
    if (centerStack) ro.observe(centerStack);
    const wheelBody = stageEl.querySelector('[data-moment-v2-wheel-body]');
    if (wheelBody) ro.observe(wheelBody);
    if (capForRo) ro.observe(capForRo);
    stageEl._momentV2WheelResizeObserver = ro;

    const carouselFrame = stageEl.querySelector('.timeline-meal-photos-carousel-frame');
    ensureMomentV2InlineChromeForFrame(carouselFrame);

    stageEl.querySelectorAll('img.timeline-meal-photo-img').forEach((img) => {
        if (img.complete && (img.naturalHeight || 0) > 0) return;
        img.addEventListener('load', rafSync, { once: true });
        img.addEventListener('error', rafSync, { once: true });
    });

    requestAnimationFrame(() => requestAnimationFrame(runAfterIndexChange));
    // 기록 코멘트 토글 등으로 스택 높이만 바뀐 경우 세로 중앙 재계산
    stageEl._momentV2RunLayout = runAfterIndexChange;
}

/**
 * @param {ParentNode | null | undefined} scopeEl — #galleryContainer, #feedContent 등
 */
export function setupMomentFeedV2WheelLayout(scopeEl) {
    if (!scopeEl?.querySelector) return;
    ensureMomentV2AuthorCommentToggleBound(document.body);
    ensureMomentV2PrimaryCaptionGlobalListeners();
    scopeEl.querySelectorAll('.moment-v2-wheel-stage').forEach((stage) => bindOneMomentV2WheelStage(stage));
    scopeEl.querySelectorAll('.moment-feed-v2-scope').forEach((root) => syncMomentV2AuthorCommentBand(root));
    scheduleMomentV2SplitCaptionLayout();
}
