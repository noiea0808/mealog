/**
 * 모먼트 화면2: 가로 스냅 사진(게시물 내) + 휠 라벨(YY·메뉴@장소) + 영역(작성자 코멘트 + 소셜 댓글) —
 * - 용어: 글쓴이 본문 = 코멘트(기록) / 타인 소셜 답장 = 댓글(목록+입력)
 * - 세로: 피드는 문서 스크롤(사진 영역에서 휠·세로 제스처로 인접 게시물 점프하지 않음).
 * - 가로: hstrip 사진 스와이프(x 스냅 + smooth). `data-moment-v2-swipe-photos-only` 는 하단 휠·기록 코멘트는 고정(첫 사진 기준). 닉/소셜/장수 뱃지는 스냅에 안착한 뒤에만 활성 슬롯에 맞춤(스와이프 중에는 이전 스냅 자리 유지).
 */
import { isMomentV2HstripAtSnapPoint } from './moment-v2-hstrip-snap.js';
import { ensureMomentV2InlineChromeForFrame } from './moment-v2-inline-chrome.js';
import {
    ensureMomentV2AuthorCommentToggleBound,
    onMomentV2ActivePhotoMaybeChangedForAuthorComment,
    refreshAllMomentV2AuthorCommentBandsIn,
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
    const layer = document.getElementById(MOMENT_V2_PORTAL_ID);
    const inner =
        layer?.querySelector?.(':scope > .moment-v2-dock-portal-inner') ||
        layer?.querySelector?.(':scope > .moment-feed-v2-scope') ||
        layer;
    const portaled = inner?.querySelectorAll?.('.moment-v2-caption-footer[data-moment-v2-caption][data-moment-v2-portaled="1"]');
    if (!portaled?.length) return;
    if (typeof window !== 'undefined' && window._mv2DockSlabCapRo) {
        try {
            window._mv2DockSlabCapRo.disconnect();
        } catch (_) {}
        window._mv2DockSlabCapRo = null;
        window._mv2DockSlabCapEl = null;
    }
    if (!inner) return;
    portaled.forEach((cap) => {
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
    if (typeof window.restoreMomentV2SocialCommentSheetsFromBody === 'function') {
        window.restoreMomentV2SocialCommentSheetsFromBody();
    }
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
 * 시안 v2(`skip-dock`): 캡션은 항상 카드 인플로 — 절대 숨기지 않음.
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
            const skipDock = root?.getAttribute?.('data-moment-v2-skip-dock') === '1';
            const swipePhotosOnly = root?.getAttribute?.('data-moment-v2-swipe-photos-only') === '1';
            /* skip-dock/다장: 본문(작성자·메타·소셜)이 캡션에 있음 → 숨기면 스크롤 전까지 안 보임 */
            if (skipDock || swipePhotosOnly || post === primary) {
                cap.classList.remove('mv2-cap-inflow-hidden');
            } else {
                cap.classList.add('mv2-cap-inflow-hidden');
            }
        }
    });
    if (!primary) return;
    if (primary.querySelector?.('.moment-feed-v2-scope[data-moment-v2-skip-dock="1"]')) {
        return;
    }
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

/**
 * 메뉴@장소: 첫 `@` 뒤에 `<wbr>`로 장소 줄 우선 분리(HTML 조각, 한 줄용 span 안에 삽입).
 */
export function buildMomentV2MenuLabelLineInnerHtml(raw) {
    const s = raw == null ? '—' : String(raw);
    const esc = escapeHtmlMomentV2Text;
    const i = s.indexOf('@');
    if (i < 0) return esc(s);
    const pre = s.slice(0, i);
    const suf = s.slice(i + 1);
    return `<span class="moment-v2-wheel-menu-pre">${esc(pre)}</span><span class="moment-v2-wheel-menu-at-mark">@</span><wbr><span class="moment-v2-wheel-menu-suf">${esc(suf)}</span>`;
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
    const inner =
        strip.getAttribute('data-moment-v2-stripe') === 'menu'
            ? buildMomentV2MenuLabelLineInnerHtml(t)
            : escapeHtmlMomentV2Text(t);
    strip.innerHTML = `<span class="${cls}">${inner}</span>`;
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
    const isMenu = strip.getAttribute('data-moment-v2-stripe') === 'menu';
    const enc = isMenu ? buildMomentV2MenuLabelLineInnerHtml(t) : escapeHtmlMomentV2Text(t);
    const encOld = isMenu ? buildMomentV2MenuLabelLineInnerHtml(old) : escapeHtmlMomentV2Text(old);
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
    const staggerMs = (keys.length - 1) * staggerFieldMs;
    if (staggerMs > 0) {
        window.setTimeout(() => {
            if (stageEl.isConnected) syncMomentV2WheelCaptionInnerWidth(stageEl);
        }, staggerMs + 48);
    }
}

function syncMomentV2WheelCaptionInnerWidth(stageEl) {
    const photoShell = stageEl.querySelector('.moment-v2-photo-shell');
    const cap = getMomentV2CaptionForStage(stageEl);
    const anyRow =
        stageEl.querySelector?.('.moment-v2-wheel-caption-row') ||
        cap?.querySelector?.('.moment-v2-wheel-caption-row');
    const labelRow =
        cap?.querySelector?.('.moment-v2-wheel-caption-row.timeline-meal-photo-menu-bar') || anyRow;
    /* APP 네비 폭(28rem 느낌)이 아닌, 휠 한 줄(날짜·메뉴 라벨) 실측 = 사진·도크 공통 --meal-wheel-caption-inner-w */
    let wRef = labelRow;
    let br = wRef ? wRef.getBoundingClientRect() : { width: 0, height: 0 };
    if (!wRef || br.width < 8) {
        wRef = cap || photoShell || stageEl;
        br = wRef.getBoundingClientRect();
    }
    const MIN_APPLY_PX = 120;
    let w = Math.floor(br.width);
    if (w < MIN_APPLY_PX) {
        const fallbacks = [
            stageEl.closest('[data-moment-v2-root]'),
            stageEl.closest('.moment-feed-v2-scope'),
            stageEl.closest('.instagram-post'),
            document.getElementById('galleryPostsInsertPoint'),
            document.getElementById('galleryContainer'),
            document.getElementById('feedContent')
        ];
        for (const el of fallbacks) {
            if (!el?.getBoundingClientRect) continue;
            const rw = Math.floor(el.getBoundingClientRect().width);
            if (rw >= MIN_APPLY_PX) {
                w = rw;
                break;
            }
        }
    }
    const rows = stageEl.querySelectorAll('.moment-v2-wheel-caption-row');
    const list = rows.length > 0 ? rows : (cap ? cap.querySelectorAll('.moment-v2-wheel-caption-row') : []);
    if (w < MIN_APPLY_PX) {
        /* 배치 렌더·이미지 로드 전 등 — 40px 등 잘못된 폭을 고정하지 않고 CSS 기본(100%) 유지 */
        stageEl.style.removeProperty('--meal-wheel-caption-inner-w');
        if (cap) cap.style.removeProperty('--meal-wheel-caption-inner-w');
        list.forEach((innerRow) => {
            if (!innerRow) return;
            innerRow.style.removeProperty('width');
            innerRow.style.maxWidth = '100%';
            innerRow.style.marginLeft = 'auto';
            innerRow.style.marginRight = 'auto';
            innerRow.style.boxSizing = 'border-box';
        });
        return;
    }
    const wStr = `${w}px`;
    stageEl.style.setProperty('--meal-wheel-caption-inner-w', wStr);
    if (cap) cap.style.setProperty('--meal-wheel-caption-inner-w', wStr);
    list.forEach((innerRow) => {
        if (!innerRow) return;
        innerRow.style.width = wStr;
        innerRow.style.maxWidth = '100%';
        innerRow.style.marginLeft = 'auto';
        innerRow.style.marginRight = 'auto';
        innerRow.style.boxSizing = 'border-box';
    });
    syncMomentV2WheelMenuCompactLayoutForStage(stageEl);
    requestAnimationFrame(() => syncMomentV2WheelMenuCompactLayoutForStage(stageEl));
}

/** `.meal-photo-wheel-label-line`은 overflow:hidden이라 scrollWidth로는 판단 불가 → 텍스트 실폭 측정 */
function measureMomentV2WheelMenuNaturalWidth(line) {
    if (!line || typeof document === 'undefined') return 0;
    try {
        const r = document.createRange();
        r.selectNodeContents(line);
        const br = r.getBoundingClientRect();
        if (Number.isFinite(br.width) && br.width > 0.5) return br.width;
    } catch (_) {}
    const cs = window.getComputedStyle(line);
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = [
        'position:fixed',
        'left:-99999px',
        'top:0',
        'visibility:hidden',
        'white-space:nowrap',
        'pointer-events:none',
        `font-family:${cs.fontFamily}`,
        `font-size:${cs.fontSize}`,
        `font-weight:${cs.fontWeight}`,
        `font-style:${cs.fontStyle}`,
        `letter-spacing:${cs.letterSpacing || '0.05em'}`
    ].join(';');
    probe.textContent = line.textContent || '';
    document.body.appendChild(probe);
    const w = probe.offsetWidth;
    probe.remove();
    return w;
}

function clearMomentV2MenuPreZwsp(line) {
    const pre = line?.querySelector?.('.moment-v2-wheel-menu-pre');
    if (!pre) return;
    pre.textContent = pre.textContent.replace(/\u200b/g, '');
}

/** 날짜 열과 겹치면 `@` 뒤 줄바꿈만으로는 부족 — 메뉴( @ 앞) 끝에서부터 ZWSP로 한 글자씩 줄 끊기 유도 */
function applyMomentV2MenuTailZwspForWheelOverlap(captionRow, line) {
    const wb = captionRow?.querySelector?.('.timeline-meal-photos-wheelbar-inner');
    const pre = line?.querySelector?.('.moment-v2-wheel-menu-pre');
    if (!wb || !pre || !line) return;
    clearMomentV2MenuPreZwsp(line);
    const thr = 4;
    let n = 0;
    while (n++ < 200) {
        const lr = line.getBoundingClientRect();
        const wr = wb.getBoundingClientRect();
        if (lr.left >= wr.right - thr) break;
        const plain = pre.textContent.replace(/\u200b/g, '');
        if (plain.length <= 1) break;
        const tail = plain.slice(-1);
        const head = plain.slice(0, -1);
        pre.textContent = `${head}\u200b${tail}`;
    }
}

/** 메뉴@장소: 한 줄(20px)에 들어가면 유지, 아니면 18px·최대 두 줄(우정렬) */
function syncMomentV2WheelMenuCompactLayoutForStage(stageEl) {
    if (!stageEl) return;
    const cap = getMomentV2CaptionForStage(stageEl);
    const roots = [stageEl, cap].filter(Boolean);
    const seen = new Set();
    roots.forEach((root) => {
        root.querySelectorAll?.('[data-wheel-menu-caption]').forEach((el) => {
            if (seen.has(el)) return;
            seen.add(el);
            const line = el.querySelector('.moment-v2-wheel-menu-anim-line');
            if (!line) return;
            clearMomentV2MenuPreZwsp(line);
            el.classList.remove('moment-v2-wheel-menu--compact');
            const avail = el.clientWidth;
            const naturalW = measureMomentV2WheelMenuNaturalWidth(line);
            if (avail > 8 && naturalW > avail + 0.5) {
                el.classList.add('moment-v2-wheel-menu--compact');
                const captionRow = el.closest('.moment-v2-wheel-caption-row');
                requestAnimationFrame(() => {
                    const ln = el.querySelector('.moment-v2-wheel-menu-anim-line');
                    applyMomentV2MenuTailZwspForWheelOverlap(captionRow, ln);
                });
            }
        });
    });
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

/** 다장 hstrip: 활성 슬롯 기준 다음 1~2장을 네트워크 캐시에 미리 로드(디코드 강제 X, 개수 상한). */
function preloadMomentV2HstripAdjacent(strip, idx) {
    if (!strip) return;
    const cells = strip.querySelectorAll('.moment-v2-h-slide');
    if (cells.length <= 1) return;
    for (const nextIdx of [idx + 1, idx + 2]) {
        if (nextIdx < 0 || nextIdx >= cells.length) continue;
        const img = cells[nextIdx]?.querySelector?.('img');
        const url = (img && (img.getAttribute('src') || img.src)) || '';
        if (!url) continue;
        const pre = new Image();
        pre.src = url;
    }
}

/** 다장: 게시물 전역 배경(라벨·코멘트까지)을 활성 사진 URL로 갱신 */
function syncMomentV2HstripBgToIndex(strip, idx) {
    const stage = strip?.closest?.('[data-moment-v2-wheel-stage]');
    const ambient = stage?.querySelector?.('[data-moment-v2-hpost-ambient]');
    const raw = ambient?.getAttribute?.('data-moment-v2-hstrip-bgs');
    if (!raw) return;
    let urls;
    try {
        urls = JSON.parse(decodeURIComponent(raw));
    } catch {
        return;
    }
    if (!Array.isArray(urls) || !urls.length) return;
    const u = String(urls[idx] != null ? urls[idx] : urls[0] || '').trim();
    if (!u) return;
    const el = stage?.querySelector?.('.moment-v2-hpost-bg-img');
    if (!el) return;
    if (el.getAttribute('data-moment-v2-bg-idx') === String(idx) && (el.getAttribute('src') || '') === u) {
        return;
    }
    el.setAttribute('data-moment-v2-bg-idx', String(idx));
    if (el.getAttribute('src') !== u) {
        el.setAttribute('src', u);
    }
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

function momentV2PrefersReducedMotion() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const _mv2HstripHScrollRaf = new WeakMap();

/** 가로 hstrip: 휠·트랙패드 델타를 rAF 1회로 합쳐 smooth 이동(이벤트마다 smooth 스택 방지) */
function momentV2HstripScrollHorizontallyBy(strip, delta) {
    if (!strip || !delta) return;
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
    let st = _mv2HstripHScrollRaf.get(strip);
    if (!st) {
        st = { raf: 0, acc: 0 };
        _mv2HstripHScrollRaf.set(strip, st);
    }
    st.acc += delta;
    if (st.raf) return;
    st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        const acc = st.acc;
        st.acc = 0;
        if (!acc) return;
        const next = Math.max(0, Math.min(max, strip.scrollLeft + acc));
        strip.scrollTo({ left: next, behavior: momentV2PrefersReducedMotion() ? 'auto' : 'smooth' });
    });
}

/** 마우스 드래그 종료(또는 캡처 상실) 시 가장 가까운 가로 슬롯으로 부드럽게 정렬 */
function snapMomentV2HstripToNearestSlide(strip) {
    if (!strip) return;
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
    const cells = strip.querySelectorAll('.moment-v2-h-slide');
    if (!cells.length) return;
    const w0 = strip.clientWidth || 0;
    const step = cells[0].offsetWidth || w0;
    if (step <= 0) return;
    const maxIdx = cells.length - 1;
    const idx = Math.max(0, Math.min(maxIdx, Math.round(strip.scrollLeft / step)));
    const target = idx * step;
    const minDist = Math.max(2, Math.min(8, Math.floor(step * 0.02)));
    if (Math.abs(strip.scrollLeft - target) <= minDist) return;
    const beh = momentV2PrefersReducedMotion() ? 'auto' : 'smooth';
    requestAnimationFrame(() => {
        strip.scrollTo({ left: target, behavior: beh });
    });
}

let _v2CapFixRaf = 0;
/** 세로 피드 스크롤 중: ResizeObserver·폭 동기화 등 무거운 layout read/write 억제 */
let _mv2FeedScrollActive = false;
let _mv2FeedScrollEndTimer = 0;
const MV2_FEED_SCROLL_SETTLE_MS = 200;
const MV2_VIEWPORT_SYNC_MARGIN_PX = 240;

function isMomentV2FeedScrollActive() {
    return _mv2FeedScrollActive;
}

function isMomentV2StageNearViewport(stageEl, margin = MV2_VIEWPORT_SYNC_MARGIN_PX) {
    if (!stageEl?.getBoundingClientRect || typeof window === 'undefined') return false;
    const r = stageEl.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    return r.bottom >= -margin && r.top <= vh + margin;
}

function markMomentV2FeedScrolling() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    _mv2FeedScrollActive = true;
    document.documentElement.classList.add('mv2-feed-scrolling');
    if (_mv2FeedScrollEndTimer) clearTimeout(_mv2FeedScrollEndTimer);
    _mv2FeedScrollEndTimer = setTimeout(() => {
        _mv2FeedScrollEndTimer = 0;
        _mv2FeedScrollActive = false;
        document.documentElement.classList.remove('mv2-feed-scrolling');
        scheduleMomentV2SplitCaptionLayout();
        flushMomentV2DeferredStageLayouts();
    }, MV2_FEED_SCROLL_SETTLE_MS);
}

function flushMomentV2DeferredStageLayouts() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.moment-v2-wheel-stage').forEach((st) => {
        if (!st?._mv2ResizePending || !st.isConnected) return;
        st._mv2ResizePending = false;
        if (!isMomentV2StageNearViewport(st)) return;
        if (typeof st._momentV2RunLayout === 'function') {
            st._momentV2RunLayout();
        }
    });
}

function scheduleMomentV2SplitCaptionLayout() {
    if (typeof window === 'undefined') return;
    if (_mv2FeedScrollActive) return;
    if (_v2CapFixRaf) return;
    _v2CapFixRaf = requestAnimationFrame(() => {
        _v2CapFixRaf = 0;
        runMomentV2SplitCaptionLayout();
    });
}

/** 인플로 복원 → primary 도크(앱 네비 위) → 휠 행(--meal-wheel-caption-inner-w) 동기화 */
function runMomentV2SplitCaptionLayout() {
    if (typeof document === 'undefined' || _mv2FeedScrollActive) return;
    restoreAllMomentV2PortaledCaptions();
    runMomentV2PrimaryFixedDock();
    document.querySelectorAll('.moment-v2-wheel-stage--split-caption').forEach((st) => {
        if (st?.isConnected && isMomentV2StageNearViewport(st)) {
            syncMomentV2WheelCaptionInnerWidth(st);
        }
    });
}

function ensureMomentV2FeedScrollGate() {
    if (typeof window === 'undefined' || window._mv2FeedScrollGate) return;
    window._mv2FeedScrollGate = true;
    window.addEventListener('scroll', markMomentV2FeedScrolling, { passive: true, capture: true });
}

function ensureMomentV2PrimaryCaptionGlobalListeners() {
    if (typeof window === 'undefined' || window._mv2PrimaryCaptionVfix) return;
    window._mv2PrimaryCaptionVfix = true;
    ensureMomentV2FeedScrollGate();
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
            }, MV2_FEED_SCROLL_SETTLE_MS);
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
 * 웹: 마우스로 hstrip `scrollLeft` 드래그(터치/트랙패드는 브라우저 기본).
 * 캡처는 실제로 일정 거리 이상 움직였을 때만 건다 — pointerdown 즉시 캡처하면
 * 브라우저가 뒤이은 click을 캡처 대상(strip)으로 재타깃해서, 사진을 그냥
 * 클릭(탭)만 했을 때 라이트박스 오픈 델리게이션이 `.moment-feed-photo`를
 * 못 찾아 아무 반응이 없어진다(데스크톱 마우스에서만 재현, 터치는 이 핸들러를 안 탐).
 */
function bindMomentV2HstripPointerDragForWeb(strip) {
    if (!strip || strip._mv2HstripMouseDrag) return;
    strip._mv2HstripMouseDrag = true;
    const DRAG_CAPTURE_THRESHOLD = 4;
    let drag = null;
    const onDown = (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (strip.scrollWidth <= strip.clientWidth + 1) return;
        drag = { s0: strip.scrollLeft, x0: e.clientX, id: e.pointerId, captured: false };
    };
    const onMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        if (e.pointerType !== 'mouse') return;
        if (!drag.captured) {
            if (Math.abs(e.clientX - drag.x0) < DRAG_CAPTURE_THRESHOLD) return;
            drag.captured = true;
            try {
                strip.setPointerCapture(e.pointerId);
            } catch (_) {}
            strip.classList.add('moment-v2-hstrip--dragging');
        }
        const dx = e.clientX - drag.x0;
        strip.scrollLeft = drag.s0 - dx;
        e.preventDefault();
    };
    const end = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const wasCaptured = drag.captured;
        drag = null;
        if (!wasCaptured) return;
        try {
            strip.releasePointerCapture(e.pointerId);
        } catch (_) {}
        strip.classList.remove('moment-v2-hstrip--dragging');
        snapMomentV2HstripToNearestSlide(strip);
    };
    const onLost = (e) => {
        if (drag && e.pointerId === drag.id) {
            const wasCaptured = drag.captured;
            drag = null;
            if (wasCaptured) {
                strip.classList.remove('moment-v2-hstrip--dragging');
                snapMomentV2HstripToNearestSlide(strip);
            }
        }
    };
    strip.addEventListener('pointerdown', onDown);
    strip.addEventListener('pointermove', onMove, { passive: false });
    strip.addEventListener('pointerup', end);
    strip.addEventListener('pointercancel', end);
    strip.addEventListener('lostpointercapture', onLost);
}

/**
 * 가로 hstrip이 있으면 휠·트랙패드로 좌우만 가로 이동(세로 델타는 피드 스크롤에 맡김).
 */
function bindMomentV2CarouselAreaWheel(photoShell, strip, _stageEl) {
    if (!photoShell || photoShell._momentV2CarouselWheelBound) return;
    photoShell._momentV2CarouselWheelBound = true;
    const onWheel = (e) => {
        if (!photoShell.contains(e.target)) return;
        const cw = (strip && strip.clientWidth) || photoShell.clientWidth || 1;
        const ch = (strip && strip.clientHeight) || photoShell.clientHeight || 1;
        const { dx, dy } = normalizeWheelDelta2D(e, cw, ch);
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (strip) {
            if (absX > 0 && absX >= absY) {
                momentV2HstripScrollHorizontallyBy(strip, dx);
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (e.shiftKey && absY > 0) {
                momentV2HstripScrollHorizontallyBy(strip, dy);
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }
    };
    photoShell.addEventListener('wheel', onWheel, { passive: false, capture: true });
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
        /* 사진 스와이프 중에도 폭은 항상 재측정(40px 고정·좁은 띠 멈춤 방지). 휠 라벨 애니만 스냅 이후. */
        syncMomentV2WheelCaptionInnerWidth(stageEl);
        const isVScroll = !strip;
        if (strip) {
            const w = strip.clientWidth || 0;
            if (w > 0 && !isMomentV2HstripAtSnapPoint(strip, w)) {
                return;
            }
        }
        const labels = parseMomentV2Labels(root);
        const photosOnlySwipe = root?.getAttribute?.('data-moment-v2-swipe-photos-only') === '1';
        let idx = 0;
        if (strip) {
            idx = getMomentV2CarouselActiveIndex(strip);
            const pageCur = stageEl.querySelector('[data-carousel-badge-cur]');
            if (pageCur) pageCur.textContent = String(idx + 1);
            const dots = stageEl.querySelector('[data-moment-v2-dots]');
            if (dots) {
                dots.querySelectorAll('span').forEach((el, i) => {
                    el.classList.toggle('on', i === idx);
                });
            }
            syncMomentV2HstripBgToIndex(strip, idx);
            preloadMomentV2HstripAdjacent(strip, idx);
        }
        /* 다장: 사진만 스와이프 — 휠 라벨/기록은 스냅 시 갱신하지 않음(단일·첫 슬롯과 동일) */
        if (labels.length && strip && !isVScroll && !photosOnlySwipe) {
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
        if (!isVScroll && !photosOnlySwipe) onMomentV2ActivePhotoMaybeChangedForAuthorComment(stageEl);
    };

    /** 팝업 `onHScroll` + `syncMealPhotoHstripIndexFromScroll`과 동일: 스냅에 붙었을 때만 휠·라벨·슬랩·primary 갱신 */
    const onHStripScrollSettled = () => {
        if (captionScrollRaf != null) return;
        captionScrollRaf = requestAnimationFrame(() => {
            captionScrollRaf = null;
            if (!strip) {
                runAfterIndexChange();
                return;
            }
            const w = strip.clientWidth || 0;
            if (w <= 0) return;
            if (!isMomentV2HstripAtSnapPoint(strip, w)) {
                return;
            }
            runAfterIndexChange();
        });
    };

    const rafSync = () => {
        if (isMomentV2FeedScrollActive()) {
            stageEl._mv2ResizePending = true;
            return;
        }
        requestAnimationFrame(runAfterIndexChange);
    };

    bindMomentV2CarouselAreaWheel(photoShell, strip, stageEl);
    if (strip) {
        bindMomentV2HstripPointerDragForWeb(strip);
    }

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
    requestAnimationFrame(() => requestAnimationFrame(() => refreshAllMomentV2AuthorCommentBandsIn(scopeEl)));
    scheduleMomentV2SplitCaptionLayout();
}
