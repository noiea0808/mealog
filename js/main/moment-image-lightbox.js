/**
 * 모먼트(갤러리) 공유 사진 — 사진 탭으로 전체 화면 확대
 * 다중 장: 좌우 스와이프로 전환 · 두 손가락 핀치로 확대/축소
 * post-group-html: .gallery-photo-scroll[data-moment-urls], 슬라이드 [data-moment-i]
 */

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
    _overlay.classList.add('hidden');
    _overlay.setAttribute('aria-hidden', 'true');
    const img = _overlay.querySelector('[data-moment-lb-img]');
    if (img) {
        img.removeAttribute('src');
        img.alt = '';
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
        img.src = u;
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

    /** 마우스 드래그로 좌우 전환(scale≈1) */
    let drag = null;
    viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        if (_tf.scale > 1.02) return;
        drag = { x0: e.clientX, y0: e.clientY, id: e.pointerId };
        viewport.setPointerCapture(e.pointerId);
    });
    viewport.addEventListener('pointerup', (e) => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x0;
        const dy = e.clientY - drag.y0;
        drag = null;
        try {
            viewport.releasePointerCapture(e.pointerId);
        } catch (_) {}
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
            'hidden fixed inset-0 z-[10002] flex justify-center bg-slate-950/90 backdrop-blur-sm';
        _overlay.setAttribute('role', 'dialog');
        _overlay.setAttribute('aria-modal', 'true');
        _overlay.setAttribute('aria-labelledby', 'momentImageLightboxTitle');
        _overlay.innerHTML = `
            <div class="flex h-full w-full max-w-md min-h-0 flex-col">
                <div class="flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))]">
                    <h2 id="momentImageLightboxTitle" class="sr-only">모먼트 사진</h2>
                    <span class="text-xs font-medium text-white/80">모먼트</span>
                    <span data-moment-lb-counter class="hidden min-w-[3rem] flex-1 text-center text-xs font-bold text-white/90 tabular-nums sm:flex-none"></span>
                    <div class="ml-auto flex flex-shrink-0 items-center">
                        <button type="button" data-moment-lb-close class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 active:bg-white/20" aria-label="닫기">
                            <i class="fa-solid fa-times text-lg leading-none" aria-hidden="true"></i>
                        </button>
                    </div>
                </div>
                <div class="moment-lb-stage flex min-h-0 flex-1 cursor-default items-stretch justify-center overflow-hidden px-2 pb-[max(1rem,env(safe-area-inset-bottom))]" data-moment-lb-stage>
                    <div data-moment-lb-viewport class="moment-lb-viewport flex h-full w-full max-w-full touch-none items-center justify-center overflow-hidden">
                        <div data-moment-lb-transform class="will-change-transform">
                            <img data-moment-lb-img alt="" class="max-h-[min(82vh,100dvh-6rem)] max-w-[min(100vw,28rem)] w-auto object-contain rounded-lg shadow-2xl select-none" draggable="false" />
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(_overlay);
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
        /* 화면2(모먼트 보기 2): 캐러셀·휠과 겹침 방지 — 탭 확대(라이트박스) 비활성 */
        if (imgHit.closest?.('.moment-feed-v2-scope')) return;

        const scroll = imgHit.closest?.('.gallery-photo-scroll');
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
