/**
 * 모먼트(갤러리) 공유 사진 — 사진 탭으로 전체 화면 확대
 * 다중 장: 좌우 스와이프로 전환 · 두 손가락 핀치로 확대/축소
 * v1(post-group-html): .gallery-photo-scroll[data-moment-urls], 슬라이드 [data-moment-i]
 * v2(휠, moment-feed-v2): .moment-feed-v2-scope[data-moment-urls], 슬라이드 [data-moment-i]
 */
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { scheduleLucideIcons } from '../icons.js';

let _overlay = null;
let _urls = [];
let _index = 0;
let _keyHandler = null;

/** @type {{ tx: number, ty: number, scale: number }} */
let _tf = { tx: 0, ty: 0, scale: 1 };

/** 한 손가락 스와이프(다음/이전) */
let _swipe = null;
/** 두 손가락 핀치 */
let _pinch = null;
/** 확대 상태 한 손가락 이동(팬) */
let _pan = null;

const SWIPE_MIN_DX = 56;
const SWIPE_MAX_RATIO = 0.75;
const SCALE_MIN = 1;
const SCALE_MAX = 4;
const DBLCLICK_ZOOM_SCALE = 2.4;

/** 타임라인 사진 팝업 `MEAL_PHOTO_SRC_PENDING`과 동일 — 교체 시 빈 프레임 방지 */
const MOMENT_LB_SRC_PENDING =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * 타임라인 `applyMealPhotoImgSrc`와 동일 규칙: 가로 넘김 시 opacity 페이드(reduce 시 생략).
 * @param {HTMLImageElement} img
 * @param {string} u
 * @param {{ fade?: boolean }} [opts]
 */
function applyMomentLbImgSrc(img, u, opts = {}) {
    if (!img || !u) return;
    if (img.dataset.momentLbSrcApplied === u) return;
    const prev = img.dataset.momentLbSrcApplied;
    const allowFade =
        opts.fade !== false &&
        Boolean(prev) &&
        prev !== u &&
        typeof window.matchMedia === 'function' &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    delete img.dataset.momentLbSrcApplied;
    const applySrcAndFadeIn = () => {
        img.removeAttribute('src');
        img.src = MOMENT_LB_SRC_PENDING;
        img.src = u;
        img.dataset.momentLbSrcApplied = u;
        if (allowFade) {
            const show = () => {
                img.style.opacity = '1';
            };
            if (img.complete && (img.naturalHeight || 0) > 0) {
                requestAnimationFrame(() => requestAnimationFrame(show));
            } else {
                img.addEventListener('load', () => requestAnimationFrame(() => requestAnimationFrame(show)), {
                    once: true
                });
                img.addEventListener('error', () => requestAnimationFrame(() => requestAnimationFrame(show)), {
                    once: true
                });
            }
        } else {
            img.style.opacity = '';
        }
    };
    if (allowFade) {
        img.style.opacity = '0';
        requestAnimationFrame(() => {
            requestAnimationFrame(applySrcAndFadeIn);
        });
    } else {
        applySrcAndFadeIn();
    }
}

function getTransformEl() {
    return _overlay?.querySelector('[data-moment-lb-transform]');
}

function applyLbTransform() {
    const el = getTransformEl();
    if (!el) return;
    const { tx, ty, scale } = _tf;
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    el.style.transformOrigin = 'center center';
}

function resetLbTransform() {
    _tf = { tx: 0, ty: 0, scale: 1 };
    applyLbTransform();
}

export function closeMomentImageLightbox() {
    if (!_overlay || _overlay.classList.contains('hidden')) return;
    /** 닫기 버튼 등 오버레이 안쪽 요소가 포커스를 쥔 채로 aria-hidden을 걸면
     * "포커스가 남아있는 조상에 aria-hidden" 경고가 뜬다 — 먼저 포커스를 밖으로 뺀다. */
    if (document.activeElement && _overlay.contains(document.activeElement)) {
        document.activeElement.blur();
    }
    _overlay.classList.add('hidden');
    unlockBodyScroll('momentLightbox');
    _overlay.setAttribute('aria-hidden', 'true');
    const img = _overlay.querySelector('[data-moment-lb-img]');
    if (img) {
        img.removeAttribute('src');
        img.alt = '';
        delete img.dataset.momentLbSrcApplied;
        img.style.opacity = '';
    }
    _urls = [];
    _index = 0;
    _swipe = null;
    _pinch = null;
    _pan = null;
    resetLbTransform();
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
}

function touchDistance(t0, t1) {
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
}

function syncMomentLightboxUi() {
    if (!_overlay) return;
    resetLbTransform();
    const img = _overlay.querySelector('[data-moment-lb-img]');
    const u = _urls[_index];
    if (img && u) {
        applyMomentLbImgSrc(img, u);
        img.alt = `모먼트 사진 ${_index + 1}/${_urls.length}`;
    }
    const counter = _overlay.querySelector('[data-moment-lb-counter]');
    const multi = _urls.length > 1;
    if (counter) {
        counter.textContent = multi ? `${_index + 1} / ${_urls.length}` : '';
        counter.classList.toggle('hidden', !multi);
    }
}

function goNextImage() {
    if (_index < _urls.length - 1) {
        _index += 1;
        syncMomentLightboxUi();
    }
}

function goPrevImage() {
    if (_index > 0) {
        _index -= 1;
        syncMomentLightboxUi();
    }
}

function bindMomentLbGestures() {
    const viewport = _overlay.querySelector('[data-moment-lb-viewport]');
    if (!viewport || viewport.dataset.momentLbGesturesBound === '1') return;
    viewport.dataset.momentLbGesturesBound = '1';

    viewport.addEventListener(
        'touchstart',
        (e) => {
            if (e.touches.length === 2) {
                _swipe = null;
                _pan = null;
                const d = touchDistance(e.touches[0], e.touches[1]);
                if (d > 0) {
                    _pinch = { startDist: d, startScale: _tf.scale };
                }
            } else if (e.touches.length === 1) {
                const t = e.touches[0];
                if (_tf.scale > 1.02) {
                    _swipe = null;
                    _pan = { lastX: t.clientX, lastY: t.clientY };
                } else {
                    _pan = null;
                    _swipe = { x0: t.clientX, y0: t.clientY };
                }
            }
        },
        { passive: true }
    );

    viewport.addEventListener(
        'touchmove',
        (e) => {
            if (e.touches.length === 2 && _pinch) {
                e.preventDefault();
                const d = touchDistance(e.touches[0], e.touches[1]);
                if (_pinch.startDist > 0 && d > 0) {
                    let s = _pinch.startScale * (d / _pinch.startDist);
                    s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
                    _tf.scale = s;
                    applyLbTransform();
                }
            } else if (e.touches.length === 1 && _pan && _tf.scale > 1.02) {
                e.preventDefault();
                const t = e.touches[0];
                _tf.tx += t.clientX - _pan.lastX;
                _tf.ty += t.clientY - _pan.lastY;
                _pan.lastX = t.clientX;
                _pan.lastY = t.clientY;
                applyLbTransform();
            }
        },
        { passive: false }
    );

    viewport.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            if (_pinch) _pinch = null;
            if (_pan) _pan = null;
            if (_tf.scale < 1.02) resetLbTransform();
            if (_swipe && _urls.length > 1 && _tf.scale <= 1.02 && e.changedTouches[0]) {
                const t = e.changedTouches[0];
                const dx = t.clientX - _swipe.x0;
                const dy = t.clientY - _swipe.y0;
                if (Math.abs(dx) >= SWIPE_MIN_DX && Math.abs(dx) > Math.abs(dy) / SWIPE_MAX_RATIO) {
                    if (dx < 0) goNextImage();
                    else goPrevImage();
                }
            }
            _swipe = null;
        } else if (e.touches.length === 1) {
            if (_pinch) _pinch = null;
            const t = e.touches[0];
            if (_tf.scale > 1.02) {
                _pan = { lastX: t.clientX, lastY: t.clientY };
                _swipe = null;
            } else {
                _pan = null;
                _swipe = { x0: t.clientX, y0: t.clientY };
            }
        }
    });

    /** 데스크톱: 휠+Ctrl(또는 ⌘) 핀치에 가까운 축소/확대 */
    viewport.addEventListener(
        'wheel',
        (e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            const delta = -e.deltaY * 0.01;
            let s = _tf.scale + delta;
            s = Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
            _tf.scale = s;
            if (s < 1.02) resetLbTransform();
            else applyLbTransform();
        },
        { passive: false }
    );

    /** 데스크톱: 더블클릭으로 확대/축소 토글 */
    viewport.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (_tf.scale > 1.02) {
            resetLbTransform();
        } else {
            _tf.scale = DBLCLICK_ZOOM_SCALE;
            applyLbTransform();
        }
    });

    /**
     * 마우스 드래그: scale≈1이면 좌우 전환, 확대 상태면 이미지 팬.
     * 포인터 캡처는 실제로 일정 거리 이상 움직였을 때만 건다 — 클릭/더블클릭 시점에
     * 바로 캡처하면 브라우저가 그 click을 캡처 대상(viewport)으로 재타깃해
     * "배경 클릭 시 닫기" 로직이 사진을 눌러도 오작동(즉시 닫힘)한다.
     */
    const DRAG_CAPTURE_THRESHOLD = 4;
    let drag = null;
    viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        drag = {
            x0: e.clientX,
            y0: e.clientY,
            id: e.pointerId,
            panning: _tf.scale > 1.02,
            lastX: e.clientX,
            lastY: e.clientY,
            captured: false
        };
    });
    viewport.addEventListener('pointermove', (e) => {
        if (!drag || drag.id !== e.pointerId) return;
        if (!drag.captured) {
            const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
            if (moved < DRAG_CAPTURE_THRESHOLD) return;
            drag.captured = true;
            try {
                viewport.setPointerCapture(e.pointerId);
            } catch (_) {}
        }
        if (!drag.panning) return;
        e.preventDefault();
        _tf.tx += e.clientX - drag.lastX;
        _tf.ty += e.clientY - drag.lastY;
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        applyLbTransform();
    });
    viewport.addEventListener('pointerup', (e) => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x0;
        const dy = e.clientY - drag.y0;
        const wasPanning = drag.panning;
        const wasCaptured = drag.captured;
        drag = null;
        if (wasCaptured) {
            try {
                viewport.releasePointerCapture(e.pointerId);
            } catch (_) {}
        }
        if (wasPanning) return;
        if (_urls.length < 2 || _tf.scale > 1.02) return;
        if (Math.abs(dx) >= SWIPE_MIN_DX && Math.abs(dx) > Math.abs(dy) / SWIPE_MAX_RATIO) {
            if (dx < 0) goNextImage();
            else goPrevImage();
        }
    });
    viewport.addEventListener('pointercancel', (e) => {
        if (drag && drag.id === e.pointerId) drag = null;
    });
}

/** @param {string[]} urlList @param {number} startIndex */
export function openMomentImageLightbox(urlList, startIndex = 0) {
    const list = (Array.isArray(urlList) ? urlList : []).map((u) => String(u || '').trim()).filter(Boolean);
    if (!list.length) return;
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
    _urls = list;
    _index = Math.max(0, Math.min(Math.floor(Number(startIndex)) || 0, _urls.length - 1));

    if (!_overlay) {
        _overlay = document.createElement('div');
        _overlay.id = 'momentImageLightbox';
        _overlay.className =
            'hidden fixed inset-0 z-[var(--z-lightbox-image)] flex justify-center';
        _overlay.setAttribute('role', 'dialog');
        _overlay.setAttribute('aria-modal', 'true');
        _overlay.setAttribute('aria-labelledby', 'momentImageLightboxTitle');
        _overlay.innerHTML = `
            <div class="flex h-full w-full max-w-md min-h-0 flex-col">
                <div class="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
                    <h2 id="momentImageLightboxTitle" class="sr-only">모먼트 사진</h2>
                    <span class="text-sm font-bold text-white/80">모먼트</span>
                    <span data-moment-lb-counter class="hidden min-w-[3rem] flex-1 text-center text-sm font-bold text-white/90 tabular-nums sm:flex-none"></span>
                    <div class="ml-auto flex flex-shrink-0 items-center">
                        <button type="button" data-moment-lb-close class="inline-flex h-10 w-10 shrink-0 items-center justify-center text-white transition-opacity hover:opacity-70 active:opacity-50" aria-label="닫기">
                            <i data-lucide="x" class="drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)] text-xl leading-none" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <div class="moment-lb-stage flex min-h-0 flex-1 cursor-default items-stretch justify-center overflow-hidden px-2 pb-[max(1rem,env(safe-area-inset-bottom))]" data-moment-lb-stage>
                    <div data-moment-lb-viewport class="moment-lb-viewport flex h-full w-full max-w-full touch-none items-center justify-center overflow-hidden">
                        <div data-moment-lb-transform class="will-change-transform">
                            <img data-moment-lb-img alt="" decoding="async" class="moment-lb-main-img max-h-[min(82vh,100dvh-6rem)] max-w-[min(100vw,28rem)] w-auto object-contain rounded-lg shadow-2xl select-none" draggable="false" />
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_overlay);
        scheduleLucideIcons(_overlay);
        const stage = _overlay.querySelector('[data-moment-lb-stage]');
        stage?.addEventListener('click', (e) => {
            if (e.target === stage) closeMomentImageLightbox();
        });
        const viewport = _overlay.querySelector('[data-moment-lb-viewport]');
        viewport?.addEventListener('click', (e) => {
            if (e.target === viewport) closeMomentImageLightbox();
        });
        _overlay.querySelector('[data-moment-lb-close]')?.addEventListener('click', () => closeMomentImageLightbox());
        bindMomentLbGestures();
    }

    syncMomentLightboxUi();
    lockBodyScroll('momentLightbox');
    _overlay.classList.remove('hidden');
    _overlay.setAttribute('aria-hidden', 'false');

    _keyHandler = (e) => {
        if (_tf.scale > 1.02) return;
        if (e.key === 'ArrowLeft') goPrevImage();
        else if (e.key === 'ArrowRight') goNextImage();
    };
    document.addEventListener('keydown', _keyHandler);
}

function parseMomentUrlsFromScroll(scrollEl) {
    const raw = scrollEl?.getAttribute?.('data-moment-urls');
    if (!raw) return [];
    try {
        const arr = JSON.parse(decodeURIComponent(raw));
        return Array.isArray(arr) ? arr.map((u) => String(u || '').trim()).filter(Boolean) : [];
    } catch (_) {
        return [];
    }
}

/** galleryContainer에 위임 (한 번만) */
export function ensureMomentImageLightbox() {
    const root = document.getElementById('galleryContainer');
    if (!root || root.dataset.momentImageLightboxBound === '1') return;
    root.dataset.momentImageLightboxBound = '1';

    root.addEventListener('click', (e) => {
        if (e.target.closest?.('.feed-options-btn')) return;
        const imgHit = e.target.closest?.('.moment-feed-photo');
        if (!imgHit) return;

        /** v1: .gallery-photo-scroll[data-moment-urls] · v2(휠): .moment-feed-v2-scope[data-moment-urls] */
        const scroll = imgHit.closest?.('[data-moment-urls]');
        if (!scroll || !root.contains(scroll)) return;

        const slide = imgHit.closest?.('[data-moment-i]');
        const idxRaw = slide?.getAttribute?.('data-moment-i');
        const startIdx = idxRaw != null ? parseInt(String(idxRaw), 10) : 0;

        const urls = parseMomentUrlsFromScroll(scroll);
        if (!urls.length) return;

        e.preventDefault();
        e.stopPropagation();
        openMomentImageLightbox(urls, Number.isFinite(startIdx) ? startIdx : 0);
    });
}
