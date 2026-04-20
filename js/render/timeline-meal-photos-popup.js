/**
 * 타임라인 카드 좌측 사진 탭 — 가로: 해당 기록의 사진들(다장은 일부+펼침), 세로: 같은 달(월) 기록이 있는 날·슬롯 순서, 하단에서 다음 달 추가
 * 오버레이: 화면 전체(visualViewport), 사진·라벨은 CSS로 좌우 10px(+ safe-area) 안쪽
 */
import { escapeHtml } from './utils.js';
import {
    buildMealPhotoViewerRowsForDate,
    buildMealPhotoViewerRowsForMonth,
    findMealPhotoViewerRowIndex
} from './timeline.js';

const OVERLAY_ID = 'timelineMealPhotosOverlay';

/** 한 게시물(행)에서 처음에 DOM에 넣을 사진 장 수 — 초과분은「더 보기」로 펼침 */
const MEAL_PHOTO_VIEWER_INITIAL_PHOTOS = 8;

/** 실제 URL은 보이는 한 칸만 부여 — 나머지는 `hydrateMealPhotoVisibleImage`에서 로드 */
const MEAL_PHOTO_SRC_PENDING =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** 인접 슬라이드·가로 이웃 URL 프리로드(브라우저 캐시) — 세로 스와이프 시 빈 화면 완화 */
const _mealPhotoPreloadStarted = new Set();
function preloadMealPhotoUrl(url) {
    if (!url || typeof url !== 'string') return;
    if (_mealPhotoPreloadStarted.has(url)) return;
    _mealPhotoPreloadStarted.add(url);
    const im = new Image();
    im.decoding = 'async';
    im.src = url;
}

/** 가로 스와이프로 이전/다음 사진으로 넘길 최소 이동(px) */
const MEAL_PHOTO_SWIPE_THRESHOLD_PX = 36;

/** body `max-w-md`와 동일 — 웹에서 넓은 창일 때 오버레이도 이 너비에 맞춤 */
const MEAL_APP_COLUMN_MAX_REM = 28;

function getMealogColumnMaxWidthPx() {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return MEAL_APP_COLUMN_MAX_REM * rem;
}

/**
 * 오버레이 사각형: 세로는 visualViewport(키보드 등), 가로는 앱 컬럼(최대 28rem) 안에 맞춤.
 */
function getMealogContentOverlayRect() {
    const vv = window.visualViewport;
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const colW = getMealogColumnMaxWidthPx();
    const w = Math.min(innerW, colW);
    const left = Math.max(0, (innerW - w) / 2);
    const top = vv ? vv.offsetTop : 0;
    const height = typeof vv?.height === 'number' ? vv.height : innerH;
    return { top, left, width: Math.max(1, w), height: Math.max(120, height) };
}

function syncOverlayLayout() {
    const el = document.getElementById(OVERLAY_ID);
    if (!el || el.classList.contains('hidden')) return;
    const r = getMealogContentOverlayRect();
    el.style.top = `${Math.round(r.top)}px`;
    el.style.left = `${Math.round(r.left)}px`;
    el.style.width = `${Math.round(r.width)}px`;
    el.style.height = `${Math.round(r.height)}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el._mealPhotosSync?.();
    positionMealPhotoCloseButton(el);
    if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                syncMealPhotoWheelCaptionPhotoMinWidth(el);
                positionMealPhotoCloseButton(el);
            });
        });
    }
}

/** 닫기 버튼: 오버레이(앱 컬럼) 우상단 고정 */
function positionMealPhotoCloseButton(el) {
    if (!el || el.classList.contains('hidden')) return;
    const btn = el.querySelector('.timeline-meal-photos-close');
    if (!btn) return;
    btn.style.position = 'absolute';
    btn.style.left = 'auto';
    btn.style.removeProperty('transform');
    btn.style.top = 'max(8px, env(safe-area-inset-top, 0px))';
    btn.style.right = 'max(8px, env(safe-area-inset-right, 0px))';
    btn.style.bottom = 'auto';
}

function buildBottomCaption(row) {
    if (row.isEmptyRow) {
        const t = '기록 없음';
        return row.place ? `${escapeHtml(t)} @ ${escapeHtml(row.place)}` : escapeHtml(t);
    }
    const menu = (row.menuLine || '').trim() || '—';
    const m = escapeHtml(menu);
    const p = (row.place || '').trim();
    return p ? `${m} @ ${escapeHtml(p)}` : m;
}

/** 이미지 위 우측: 다장일 때만 i/N */
function buildPhotoIndexOnImageHtml(index1Based, nPhotos) {
    if (nPhotos <= 1) return '';
    return `<div class="pointer-events-none absolute right-1 top-1 z-[3] rounded bg-black/75 px-1 py-0.5 text-[10px] font-black tabular-nums leading-none text-white">${index1Based}/${nPhotos}</div>`;
}

function addCalendarMonth(year, month, delta) {
    const d = new Date(year, month - 1 + delta, 1);
    return { y: d.getFullYear(), mo: d.getMonth() + 1 };
}

function monthHasMealData(year, month) {
    const history = window.mealHistory || [];
    const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    return history.some((x) => typeof x.date === 'string' && x.date.startsWith(prefix));
}

/** from 연·월 이후(다음 달부터) 기록이 있는 첫 달 */
function getNextMonthWithData(fromYear, fromMonth) {
    let y = fromYear;
    let mo = fromMonth;
    for (let i = 0; i < 240; i++) {
        const n = addCalendarMonth(y, mo, 1);
        y = n.y;
        mo = n.mo;
        if (monthHasMealData(y, mo)) return { y, mo };
    }
    return null;
}

function parseYearMonthFromDateStr(dateStr) {
    const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(dateStr || ''));
    if (!m) return null;
    return { y: Number(m[1]), mo: Number(m[2]) };
}

/** @param {Array<object>} rows */
function prepareRowsWithPhotoCap(rows) {
    return rows.map((r) => {
        const all = Array.isArray(r.urls) ? r.urls.map((u) => String(u || '').trim()).filter(Boolean) : [];
        if (all.length <= MEAL_PHOTO_VIEWER_INITIAL_PHOTOS) return { ...r, urls: all };
        return { ...r, urls: all.slice(0, MEAL_PHOTO_VIEWER_INITIAL_PHOTOS), allUrls: all };
    });
}

/** 사진이 한 장도 없는 기록은 팝업 세로 목록에서 제외 */
function filterRowsWithPhotos(rows) {
    return (rows || []).filter((r) => {
        const u = Array.isArray(r.urls) ? r.urls : [];
        return u.length > 0;
    });
}

function buildMonthLoadFooterHtml(lastYear, lastMonth) {
    const next = getNextMonthWithData(lastYear, lastMonth);
    if (!next) return '';
    const label = `${next.y}년 ${next.mo}월`;
    return `<div class="timeline-meal-photos-month-footer flex w-full shrink-0 flex-col items-stretch border-t border-white/10 py-4">
            <button type="button" class="timeline-meal-photos-load-next-month w-full rounded-xl border border-white/20 bg-white/10 px-3 py-3 text-center text-sm font-bold text-white hover:bg-white/15 active:scale-[0.99]" data-next-y="${next.y}" data-next-m="${next.mo}">${escapeHtml(label)} 기록 더 불러오기</button>
        </div>`;
}

/**
 * @param {object} row
 * @param {string[]} urlsSlice
 * @param {number} globalStart0 — 전체 사진 기준 0부터 시작 인덱스
 * @param {number} nTotal
 */
function buildHorizontalPhotoCellsHtml(row, urlsSlice, globalStart0, nTotal, withMenuBar = true) {
    const menuBar = withMenuBar ? buildMenuBarBelowPhotoHtml(row) : '';
    return urlsSlice
        .map((url, i) => {
            const globalIdx = globalStart0 + i;
            const onImg = buildPhotoIndexOnImageHtml(globalIdx + 1, nTotal);
            const enc = escapeHtml(String(url));
            return `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-stretch justify-center p-1 box-border">
                    <div class="flex max-h-full min-h-0 w-full max-w-full flex-col items-stretch">
                        <div class="relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center">
                            <img src="${MEAL_PHOTO_SRC_PENDING}" data-meal-src="${enc}" alt="" class="timeline-meal-photo-img block max-h-full max-w-full rounded-lg object-contain object-center shadow-lg select-none" draggable="false" decoding="async" />
                            ${onImg}
                        </div>
                        ${menuBar}
                    </div>
                </div>`;
        })
        .join('');
}

/** 한 번에 한 장만 보이는 캐러셀(프레임 + 펼침 칩) — 라벨은 `buildVSlideHtml`에서 프레임 아래에 둠 */
function buildCarouselZoneHtml(row, opts = {}) {
    const wheelViewport = Boolean(opts.wheelViewport);
    const urls = row.urls || [];
    if (!urls.length) return '';
    const nShown = urls.length;
    const nTotal = Array.isArray(row.allUrls) && row.allUrls.length > nShown ? row.allUrls.length : nShown;
    const hidden = nTotal - nShown;
    const firstEnc = escapeHtml(String(urls[0] || ''));
    const badgeText = nTotal > 1 ? `1/${nTotal}` : '';
    const badgeHidden = nTotal <= 1 ? ' hidden' : '';
    const expand = !wheelViewport && hidden > 0 ? buildPhotoExpandChipHtml(row, hidden) : '';
    const expandMini =
        wheelViewport && hidden > 0
            ? `<button type="button" class="timeline-meal-photo-expand timeline-meal-photo-expand--wheel-chip pointer-events-auto absolute bottom-1 left-1/2 z-[4] -translate-x-1/2 cursor-pointer rounded-full border border-white/25 bg-black/65 px-2 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm hover:bg-black/80" data-expand-date="${escapeHtml(row.dateStr)}" data-expand-slot="${escapeHtml(row.slotId)}" data-expand-record="${escapeHtml(row.recordId || '')}" aria-label="사진 ${hidden}장 더 보기">+${hidden}장</button>`
            : '';
    return `<div class="timeline-meal-photos-carousel-zone flex w-full min-w-0 shrink-0 flex-col items-stretch touch-pan-y">
            <div class="timeline-meal-photos-carousel-frame relative flex w-full min-w-0 touch-pan-y flex-col items-center justify-center p-1" data-photo-index="0" tabindex="0" role="region" aria-roledescription="carousel" aria-label="기록 사진">
                <div class="relative flex min-h-0 w-full max-w-full flex-1 touch-pan-y items-center justify-center">
                    <img src="${MEAL_PHOTO_SRC_PENDING}" data-meal-src="${firstEnc}" alt="" class="timeline-meal-photo-img block max-h-full max-w-full rounded-lg object-contain object-center shadow-lg select-none touch-pan-y" draggable="false" decoding="async" />
                    <div class="pointer-events-none absolute right-1 top-1 z-[3] rounded bg-black/75 px-1 py-0.5 text-[10px] font-black tabular-nums leading-none text-white${badgeHidden}" data-carousel-badge>${escapeHtml(badgeText)}</div>
                    ${expandMini}
                </div>
            </div>
            ${expand}
        </div>`;
}

function buildCarouselTrackHtml(row, withInlineMenuBar) {
    const zone = buildCarouselZoneHtml(row);
    const inlineBar = withInlineMenuBar ? buildMenuBarBelowPhotoHtml(row) : '';
    return `${zone}${inlineBar}`;
}

function buildPhotoExpandChipHtml(row, hiddenCount) {
    if (hiddenCount <= 0) return '';
    return `<div class="timeline-meal-photo-cell timeline-meal-photo-expand flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always cursor-pointer flex-col items-center justify-center border border-dashed border-white/30 bg-white/5 p-4 box-border" role="button" tabindex="0" data-expand-date="${escapeHtml(row.dateStr)}" data-expand-slot="${escapeHtml(row.slotId)}" data-expand-record="${escapeHtml(row.recordId || '')}" aria-label="사진 ${hiddenCount}장 더 보기">
            <span class="text-center text-sm font-bold leading-snug text-white">+${hiddenCount}장<br /><span class="text-xs font-semibold text-white/80">탭하여 펼치기</span></span>
        </div>`;
}

function findMealPhotoRowState(el, dateStr, slotId, recordId) {
    const rid = recordId == null || recordId === '' ? null : String(recordId);
    return (
        el._mealPhotoRows?.find((row) => {
            const rowRid = row.recordId == null || row.recordId === '' ? null : String(row.recordId);
            return row.dateStr === dateStr && row.slotId === slotId && rowRid === rid;
        }) || null
    );
}


/** 사진 너비(컬럼)에 맞춘 하단 메뉴 바 — 폰트·크기는 `.timeline-meal-photo-menu-bar`(style.css) */
function buildMenuBarBelowPhotoHtml(row) {
    const line = buildBottomCaption(row);
    return `<div class="timeline-meal-photo-menu-bar pointer-events-none mt-0.5 w-full shrink-0 self-stretch rounded-md bg-black/50 px-1.5 py-1 text-left text-white">${line}</div>`;
}

/** 휠 모드: 스테이지 하단 고정 라벨(날짜·슬롯 | 메뉴@장소) — DOM은 오버레이에 한 번만 두고 `syncMealPhotoWheelFromVtrack`로 갱신 */
function buildMealPhotoGlobalCaptionFooterHtml() {
    return `<div class="timeline-meal-photos-caption-footer hidden w-full shrink-0 justify-center px-0.5">
            <div class="timeline-meal-photos-slide-caption-inner flex w-full max-w-full min-w-0 items-center rounded-md border border-white/10 bg-black/50 text-white timeline-meal-photo-menu-bar">
            <div class="timeline-meal-photos-wheelbar-inner flex min-w-0 flex-1 items-center gap-0">
                <div class="meal-photo-wheel-col meal-photo-wheel-col--year flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="year" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--month flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="month" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--day flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport">
                        <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="day" style="-webkit-overflow-scrolling:touch"></div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--weekday flex shrink-0 flex-col items-center justify-center">
                    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--label meal-photo-wheel-viewport--weekday">
                        <div class="meal-photo-wheel-label-strip" data-wheel-label-strip="weekday">
                            <span class="meal-photo-wheel-label-line">—</span>
                        </div>
                    </div>
                </div>
                <span class="meal-photo-wheel-sep meal-photo-wheel-sep--colon shrink-0 select-none text-white/45">:</span>
                <div class="meal-photo-wheel-col meal-photo-wheel-col--slot flex min-w-0 shrink-0 flex-col justify-center">
                    <div class="meal-photo-wheel-viewport meal-photo-wheel-viewport--label meal-photo-wheel-viewport--slot">
                        <div class="meal-photo-wheel-label-strip" data-wheel-label-strip="slot">
                            <span class="meal-photo-wheel-label-line">—</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="pointer-events-none min-w-0 max-w-[55%] shrink-0 text-right" data-wheel-menu-caption></div>
            </div>
        </div>`;
}

/** 사진 없음: 흰 영역 + 플러스(스킵만 금지 아이콘) */
function placeholderIconClass(row) {
    if (row.mealType === 'Skip') return 'fa-solid fa-ban text-5xl text-slate-500';
    return 'fa-solid fa-plus text-5xl text-slate-400';
}

function buildHorizontalSlidesHtml(row, withMenuBar = true) {
    const urls = row.urls || [];
    if (!urls.length) return '';
    return buildCarouselTrackHtml(row, withMenuBar);
}

function buildPlaceholderSlideHtml(row) {
    const ic = placeholderIconClass(row);
    const menuBar = buildMenuBarBelowPhotoHtml(row);
    return `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-stretch justify-center p-1 box-border">
        <div class="flex max-h-full min-h-0 w-full max-w-full flex-col items-stretch">
            <div class="relative flex min-h-[min(280px,55vh)] w-full min-w-0 max-h-[55vh] flex-1 flex-col items-stretch justify-center overflow-hidden rounded-lg bg-white px-4 py-8">
                <div class="flex w-full flex-1 items-center justify-center">
                    <i class="${escapeHtml(ic)} relative z-0" aria-hidden="true"></i><span class="sr-only">사진 없음</span>
                </div>
            </div>
            ${menuBar}
        </div>
    </div>`;
}

function buildHorizontalSlidesLegacyHtml(urls) {
    const row = { urls, dateStr: '', slotId: '', recordId: null, slotTitle: '', menuLine: '', place: '', isEmptyRow: false };
    return buildCarouselTrackHtml(row, false);
}

function buildVSlideHtml(row, withInlineMenuBar = true) {
    const nPhotos = Array.isArray(row.urls) ? row.urls.length : 0;
    if (!withInlineMenuBar) {
        const innerPhoto = nPhotos > 0 ? buildCarouselZoneHtml(row, { wheelViewport: true }) : buildPlaceholderSlideHtml(row);
        return `<section class="timeline-meal-photos-vslide timeline-meal-photos-vslide--photo-only flex h-full min-h-full w-full shrink-0 snap-center snap-always flex-col overflow-hidden border-b border-white/10 last:border-b-0" data-date-str="${escapeHtml(row.dateStr)}" data-slot-id="${escapeHtml(row.slotId)}" data-record-id="${escapeHtml(row.recordId || '')}" data-slot-title="${escapeHtml(String(row.slotTitle || ''))}">
            <div class="timeline-meal-photos-vslide-stage timeline-meal-photos-vslide-stage--wheel-only relative flex min-h-full w-full min-w-0 flex-1 flex-col items-center justify-center p-1">${innerPhoto}</div>
        </section>`;
    }
    const innerTrack = nPhotos > 0 ? buildHorizontalSlidesHtml(row, withInlineMenuBar) : buildPlaceholderSlideHtml(row);
    const sectionClass =
        'timeline-meal-photos-vslide flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden border-b border-white/10 last:border-b-0';
    const stageClass = 'timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col';
    const trackClass =
        'timeline-meal-photos-track timeline-meal-photos-track--carousel scrollbar-hide flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col items-stretch overflow-hidden';
    return `<section class="${sectionClass}" data-date-str="${escapeHtml(row.dateStr)}" data-slot-id="${escapeHtml(row.slotId)}" data-record-id="${escapeHtml(row.recordId || '')}" data-slot-title="${escapeHtml(String(row.slotTitle || ''))}">
        <div class="${stageClass}">
            <div class="${trackClass}" style="-webkit-overflow-scrolling:touch">${innerTrack}</div>
        </div>
    </section>`;
}

function getCarouselRowForSlide(slide, el) {
    if (!slide || !el) return null;
    if (slide.getAttribute('data-legacy-carousel') === '1') {
        const r = el._mealPhotoRows?.[0];
        return r?.isLegacy ? r : null;
    }
    const ds = slide.getAttribute('data-date-str');
    const sid = slide.getAttribute('data-slot-id');
    const ra = slide.getAttribute('data-record-id');
    if (!ds || !sid) return null;
    return findMealPhotoRowState(el, ds, sid, ra);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fade] — `false`이면 페이드 없이 즉시 교체(인접 세로 슬라이드 프리하이드용). 생략 시 기존 규칙(가로 넘김 등).
 */
function applyCarouselIndex(slide, el, newIdx, opts = {}) {
    const row = getCarouselRowForSlide(slide, el);
    const urls = row?.urls;
    if (!row || !Array.isArray(urls) || !urls.length) return;
    const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
    if (!frame) return;
    const n = urls.length;
    let idx = Math.floor(Number(newIdx));
    if (!Number.isFinite(idx)) idx = 0;
    idx = Math.min(n - 1, Math.max(0, idx));
    frame.dataset.photoIndex = String(idx);
    const u = urls[idx];
    const img = frame.querySelector('img.timeline-meal-photo-img');
    if (img && u) {
        if (img.dataset.mealSrcApplied === u) {
            /* 이미 동일 URL이면 스킵 */
        } else {
            const prev = img.dataset.mealSrcApplied;
            const allowFade =
                opts.fade !== false &&
                Boolean(prev) &&
                prev !== u &&
                typeof window.matchMedia === 'function' &&
                !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            delete img.dataset.mealSrcApplied;
            const applySrcAndFadeIn = () => {
                img.removeAttribute('src');
                img.src = MEAL_PHOTO_SRC_PENDING;
                img.src = u;
                img.dataset.mealSrcApplied = u;
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
    }
    const nTotal = Array.isArray(row.allUrls) && row.allUrls.length > urls.length ? row.allUrls.length : urls.length;
    const badge = frame.querySelector('[data-carousel-badge]');
    if (badge) {
        if (nTotal > 1) {
            badge.textContent = `${idx + 1}/${nTotal}`;
            badge.classList.remove('hidden');
        } else {
            badge.textContent = '';
            badge.classList.add('hidden');
        }
    }
}

function stepCarouselPhoto(el, delta) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const slide = slides[si];
    const frame = slide?.querySelector('.timeline-meal-photos-carousel-frame');
    if (!frame) return;
    const cur = Number(frame.dataset.photoIndex || 0);
    applyCarouselIndex(slide, el, cur + delta);
    if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
        clearTimeout(el._mealPhotoWheelLabelTimer);
        el._mealPhotoWheelLabelTimer = null;
        runMealPhotoWheelLabelLayoutWhenReady(el);
    }
    try {
        el._mealPhotoWheelSuppressLabelSchedule = Boolean(el.classList.contains('timeline-meal-photos-overlay--wheel'));
        el._mealPhotosSync?.();
    } finally {
        el._mealPhotoWheelSuppressLabelSchedule = false;
    }
}

/**
 * 다장: 가로 스와이프 — `carousel-zone` 전체에서 처리.
 * 모바일: `touch-action: pan-x`는 브라우저가 가로 제스처를 가져가 JS가 못 받는 경우가 있어
 * 캐러셀은 `pan-y`로 두고(세로는 vtrack), 가로는 여기서만 처리 + Touch 이벤트 보조.
 */
function bindCarouselSwipe(zone, el) {
    if (!zone || zone._mealCarouselBound) return;
    zone._mealCarouselBound = true;
    let swipePointerId = null;
    let swipeStartX = 0;
    let touchSwipeStartX = 0;
    let touchSwipeActive = false;

    const trySwipeDx = (dx) => {
        if (Math.abs(dx) < MEAL_PHOTO_SWIPE_THRESHOLD_PX) return;
        const now = Date.now();
        if (now - (zone._mealSwipeDedupeAt || 0) < 90) return;
        zone._mealSwipeDedupeAt = now;
        stepCarouselPhoto(el, dx < 0 ? 1 : -1);
    };

    const onDown = (e) => {
        if (e.pointerType === 'touch') return;
        if (e.button != null && e.button !== 0) return;
        if (e.target.closest?.('.timeline-meal-photo-expand')) return;
        swipePointerId = e.pointerId;
        swipeStartX = e.clientX;
        try {
            zone.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    };
    const endSwipe = (e) => {
        if (e.pointerType === 'touch') return;
        if (swipePointerId == null || (e && e.pointerId !== swipePointerId)) return;
        const dx = e.clientX - swipeStartX;
        swipePointerId = null;
        try {
            zone.releasePointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        trySwipeDx(dx);
    };
    zone.addEventListener('pointerdown', onDown);
    zone.addEventListener('pointerup', endSwipe);
    zone.addEventListener('pointercancel', endSwipe);
    zone.addEventListener('lostpointercapture', () => {
        swipePointerId = null;
    });

    zone.addEventListener(
        'touchstart',
        (e) => {
            if (e.touches.length !== 1) return;
            if (e.target.closest?.('.timeline-meal-photo-expand')) return;
            touchSwipeActive = true;
            touchSwipeStartX = e.touches[0].clientX;
        },
        { passive: true }
    );
    zone.addEventListener(
        'touchend',
        (e) => {
            if (!touchSwipeActive) return;
            touchSwipeActive = false;
            const t = e.changedTouches[0];
            if (!t) return;
            trySwipeDx(t.clientX - touchSwipeStartX);
        },
        { passive: true }
    );
    zone.addEventListener(
        'touchcancel',
        () => {
            touchSwipeActive = false;
        },
        { passive: true }
    );
}

function getVTrackActiveIndex(vtrack) {
    if (!vtrack) return 0;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return 0;
    const t = vtrack.getBoundingClientRect();
    const midY = (t.top + t.bottom) / 2;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < slides.length; i++) {
        const r = slides[i].getBoundingClientRect();
        const c = (r.top + r.bottom) / 2;
        const d = Math.abs(c - midY);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

/** 세로 트랙에서 해당 슬라이드가 스크롤 맨 위에 오도록 하는 scrollTop 증분(뷰포트·레이아웃 기준) */
function scrollDeltaToAlignSlideTop(vtrack, slide) {
    if (!vtrack || !slide) return 0;
    return slide.getBoundingClientRect().top - vtrack.getBoundingClientRect().top;
}

/** 휠 모드: 슬라이드(한 기록) 세로 중심이 vtrack 뷰포트 세로 중심에 오도록 하는 scrollTop 증분 */
function scrollDeltaToCenterSlideInVtrack(vtrack, slide) {
    if (!vtrack || !slide) return 0;
    const vt = vtrack.getBoundingClientRect();
    const sr = slide.getBoundingClientRect();
    const vMid = (vt.top + vt.bottom) / 2;
    const sMid = (sr.top + sr.bottom) / 2;
    return sMid - vMid;
}

/** 활성 캐러셀 프레임 크기가 바뀔 때(이미지 디코드·object-fit 레이아웃 후) 라벨 재정렬 — 첫 팝업 겹침 방지 */
function bindMealPhotoWheelCaptionResizeObserver(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const prev = el._mealPhotoWheelCaptionRO;
    if (prev) {
        prev.disconnect();
        el._mealPhotoWheelCaptionRO = null;
    }
    const vtrack = el._mealPhotosVTrack;
    const frame = getActiveCarouselFrame(vtrack);
    if (!frame) return;
    let raf = null;
    const ro = new ResizeObserver(() => {
        if (raf != null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            raf = null;
            if (el.classList.contains('hidden')) return;
            positionMealPhotoWheelCaption(el);
            syncMealPhotoWheelCaptionPhotoMinWidth(el);
        });
    });
    ro.observe(frame);
    el._mealPhotoWheelCaptionRO = ro;
}

/** 휠 모드: 라벨은 스크롤에 묶이지 않고, 화면 중앙에 온 활성 사진 바로 아래 5px에만 둠 */
function positionMealPhotoWheelCaption(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const vtrack = el._mealPhotosVTrack;
    const cap = el.querySelector('.timeline-meal-photos-caption-footer');
    const stage = el.querySelector('.timeline-meal-photos-stage--with-footer');
    if (!vtrack || !cap || !stage || cap.classList.contains('hidden')) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const slide = slides[si];
    if (!slide) return;
    const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
    const img = frame?.querySelector('img.timeline-meal-photo-img');
    const s = stage.getBoundingClientRect();
    let bottom;
    if (img) {
        const ir = img.getBoundingClientRect();
        bottom = ir.bottom;
    } else {
        const fr = frame?.getBoundingClientRect();
        if (!fr) return;
        bottom = fr.bottom;
    }
    const topPx = bottom - s.top + 5;
    cap.style.position = 'absolute';
    cap.style.left = '0';
    cap.style.right = '0';
    cap.style.bottom = 'auto';
    cap.style.top = `${Math.round(Math.max(0, topPx))}px`;
}

/** 휠 모드: 본문 패딩 안쪽 콘텐츠 너비를 고정값으로 두고 하단 라벨·사진 열을 동일 너비로 맞춤 */
function syncMealPhotoWheelCaptionPhotoMinWidth(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    const body = el.querySelector('.meal-photos-overlay-body');
    if (!body) return;
    const cs = getComputedStyle(body);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const br = body.getBoundingClientRect();
    const w = Math.max(40, Math.floor(br.width - pl - pr));
    el.style.setProperty('--meal-wheel-caption-inner-w', `${w}px`);
}

/** 휠 한 줄 높이 — 하단 라벨(메뉴@장소) 줄과 맞춤 */
const MEAL_PHOTO_WHEEL_ITEM_PX = 28;

function yearsRangeFromMealPhotoRows(rows) {
    let minY = 9999;
    let maxY = 0;
    for (const r of rows || []) {
        const m = /^(\d{4})-/.exec(String(r.dateStr || ''));
        if (!m) continue;
        const y = Number(m[1]);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    }
    if (minY > maxY) {
        const y = new Date().getFullYear();
        return { minY: y, maxY: y };
    }
    return { minY, maxY };
}

/** 큰 값이 위·작은 값이 아래 — 세로 스와이프(더 과거로)와 숫자 릴 방향이 맞도록 */
function buildWheelItemsHtml(from, to, pad2) {
    const parts = [];
    for (let n = to; n >= from; n--) {
        const v = pad2 ? String(n).padStart(2, '0') : String(n);
        parts.push(
            `<div class="meal-photo-wheel-item flex h-[28px] w-full shrink-0 items-center justify-center tabular-nums leading-none text-white/90" data-val="${escapeHtml(v)}">${escapeHtml(v)}</div>`
        );
    }
    return parts.join('');
}

/** 휠 라벨: 슬롯명 공백 제거(예: 오전 간식1 → 오전간식1), 고정 폭 계산용 */
function compactMealWheelSlotTitle(s) {
    return String(s || '')
        .replace(/\s+/g, '')
        .trim() || '—';
}

function scrollWheelInnerToValue(inner, valStr, opts = {}) {
    if (!inner || valStr == null) return;
    const want = String(valStr);
    const items = inner.querySelectorAll('.meal-photo-wheel-item');
    let idx = -1;
    items.forEach((it, i) => {
        if (it.getAttribute('data-val') === want) idx = i;
    });
    if (idx < 0) return;
    const viewport = inner.closest('.meal-photo-wheel-viewport');
    const vpH = viewport?.clientHeight || MEAL_PHOTO_WHEEL_ITEM_PX;
    const itemH = MEAL_PHOTO_WHEEL_ITEM_PX;
    const ideal = idx * itemH - (vpH - itemH) / 2;
    const maxScroll = Math.max(0, inner.scrollHeight - vpH);
    const top = Math.max(0, Math.min(ideal, maxScroll));
    const smooth = Boolean(opts.smooth);
    if (smooth && typeof inner.scrollTo === 'function') {
        inner.scrollTo({ top, behavior: 'smooth' });
    } else {
        inner.scrollTop = top;
        requestAnimationFrame(() => {
            inner.scrollTop = top;
        });
    }
}

/** 요일·슬롯 릴: 한 줄 높이는 숫자 휠과 동일 */
const MEAL_WHEEL_LABEL_LINE_PX = MEAL_PHOTO_WHEEL_ITEM_PX;

function setWheelTextStripImmediate(strip, text) {
    if (!strip) return;
    const t = text == null ? '—' : String(text);
    strip.dataset.cur = t;
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    strip.innerHTML = `<span class="meal-photo-wheel-label-line">${escapeHtml(t)}</span>`;
}

/**
 * 세로 기록 이동: index 증가(아래로 더 스크롤) = 이전 값이 위로 밀리고 새 값이 아래에서 올라옴(`forward`)
 * @param {'forward'|'backward'} direction
 */
function animateWheelTextStrip(strip, newText, direction, shouldAnimate) {
    if (!strip) return;
    const t = newText == null ? '—' : String(newText);
    const old = strip.dataset.cur != null ? String(strip.dataset.cur) : '';
    if (strip._mealStripTid) {
        clearTimeout(strip._mealStripTid);
        strip._mealStripTid = null;
    }
    if (strip._mealStripOnEnd) {
        strip.removeEventListener('transitionend', strip._mealStripOnEnd);
        strip._mealStripOnEnd = null;
    }
    if (!shouldAnimate || old === t) {
        setWheelTextStripImmediate(strip, t);
        return;
    }
    const enc = escapeHtml(t);
    const encOld = escapeHtml(old);
    strip.style.transition = 'none';
    if (direction === 'forward') {
        strip.innerHTML = `<span class="meal-photo-wheel-label-line">${encOld}</span><span class="meal-photo-wheel-label-line">${enc}</span>`;
        strip.style.transform = 'translateY(0)';
    } else {
        strip.innerHTML = `<span class="meal-photo-wheel-label-line">${enc}</span><span class="meal-photo-wheel-label-line">${encOld}</span>`;
        strip.style.transform = `translateY(-${MEAL_WHEEL_LABEL_LINE_PX}px)`;
    }
    void strip.offsetHeight;
    const finish = () => {
        if (strip._mealStripOnEnd) {
            strip.removeEventListener('transitionend', strip._mealStripOnEnd);
            strip._mealStripOnEnd = null;
        }
        if (strip._mealStripTid) {
            clearTimeout(strip._mealStripTid);
            strip._mealStripTid = null;
        }
        setWheelTextStripImmediate(strip, t);
    };
    strip._mealStripOnEnd = (e) => {
        if (e.target !== strip) return;
        if (e.propertyName && e.propertyName !== 'transform') return;
        finish();
    };
    strip.addEventListener('transitionend', strip._mealStripOnEnd);
    strip._mealStripTid = setTimeout(finish, 320);
    strip.style.transition = 'transform 0.22s ease-out';
    if (direction === 'forward') {
        strip.style.transform = `translateY(-${MEAL_WHEEL_LABEL_LINE_PX}px)`;
    } else {
        strip.style.transform = 'translateY(0)';
    }
}

/** 이전 버전에서 붙은 scroll/transform을 제거하기 위해 휠 inner 노드를 갈아끼움 */
function stripMealWheelInnerListeners(footer) {
    const bar = footer?.querySelector?.('.timeline-meal-photos-wheelbar-inner');
    if (!bar) return;
    bar.querySelectorAll('.meal-photo-wheel-inner').forEach((inner) => {
        const fresh = inner.cloneNode(false);
        inner.parentNode?.replaceChild(fresh, inner);
    });
}

function clearMealWheelInnerTilts(el) {
    const footer = el?.querySelector?.('.timeline-meal-photos-caption-footer');
    stripMealWheelInnerListeners(footer);
}

/** data-date-str가 YYYY-MM-DD가 아닐 때(구데이터 등) 휠 동기화용 */
function parseWheelIsoParts(iso) {
    const s = String(iso || '').trim();
    const strict = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (strict) return { y: strict[1], mo: strict[2], day: strict[3] };
    const loose = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/.exec(s);
    if (!loose) return null;
    const mo = String(Number(loose[2])).padStart(2, '0');
    const day = String(Number(loose[3])).padStart(2, '0');
    return { y: loose[1], mo, day };
}

const MEAL_WHEEL_WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** `YYYY-MM-DD` 등에서 한 글자 요일 (예: 금) */
function weekdayKoShortFromIso(iso) {
    const parts = parseWheelIsoParts(iso);
    if (!parts) return '—';
    const y = Number(parts.y);
    const mo = Number(parts.mo) - 1;
    const d = Number(parts.day);
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return '—';
    const dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return '—';
    return MEAL_WHEEL_WEEKDAY_KO[dt.getDay()] || '—';
}

function rebuildMealPhotoWheelPickers(el) {
    const footer = el.querySelector('.timeline-meal-photos-caption-footer');
    const bar = footer?.querySelector('.timeline-meal-photos-wheelbar-inner');
    const rows = el._mealPhotoRows;
    if (!bar || !footer || footer.classList.contains('hidden') || !Array.isArray(rows) || !rows.length) return;
    stripMealWheelInnerListeners(footer);
    el._mealPhotoWheelPrevSlideIndex = undefined;
    const { minY, maxY } = yearsRangeFromMealPhotoRows(rows);
    const yInner = bar.querySelector('[data-wheel-inner="year"]');
    const mInner = bar.querySelector('[data-wheel-inner="month"]');
    const dInner = bar.querySelector('[data-wheel-inner="day"]');
    if (yInner) yInner.innerHTML = buildWheelItemsHtml(minY, maxY, false);
    if (mInner) mInner.innerHTML = buildWheelItemsHtml(1, 12, true);
    if (dInner) dInner.innerHTML = buildWheelItemsHtml(1, 31, true);
}

function syncMealPhotoWheelFromVtrack(el, vtrack) {
    const footer = el.querySelector('.timeline-meal-photos-caption-footer');
    const bar = footer?.querySelector('.timeline-meal-photos-wheelbar-inner');
    if (!footer || footer.classList.contains('hidden') || !bar || !vtrack) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const i = getVTrackActiveIndex(vtrack);
    const slide = slides[i];
    if (!slide) return;
    const prevI = el._mealPhotoWheelPrevSlideIndex;
    const shouldAnim = prevI !== undefined && prevI !== i;
    const direction = shouldAnim && i > prevI ? 'forward' : 'backward';
    const iso = slide.getAttribute('data-date-str');
    const slotTitleRaw = slide.getAttribute('data-slot-title') || '—';
    const slotStrip = bar.querySelector('[data-wheel-label-strip="slot"]');
    animateWheelTextStrip(slotStrip, compactMealWheelSlotTitle(slotTitleRaw), direction, shouldAnim);
    const menuEl = footer.querySelector('[data-wheel-menu-caption]');
    const row = getCarouselRowForSlide(slide, el);
    if (menuEl && row) {
        menuEl.innerHTML = buildBottomCaption(row);
    }
    const wdStrip = bar.querySelector('[data-wheel-label-strip="weekday"]');
    animateWheelTextStrip(wdStrip, weekdayKoShortFromIso(iso), direction, shouldAnim);
    const parts = parseWheelIsoParts(iso);
    if (parts) {
        const smooth = shouldAnim;
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="year"]'), parts.y, { smooth });
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="month"]'), parts.mo, { smooth });
        scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="day"]'), parts.day, { smooth });
    }
    el._mealPhotoWheelPrevSlideIndex = i;
}

/** 활성 세로 슬라이드의 캐러셀 프레임(없으면 null) */
function getActiveCarouselFrame(vtrack) {
    const slides = vtrack?.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides?.length) return null;
    const i = getVTrackActiveIndex(vtrack);
    return slides[i]?.querySelector('.timeline-meal-photos-carousel-frame') || null;
}

/** 이전·다음 세로 슬롯 및 가로 이웃 사진 URL을 미리 로드 */
function preloadAdjacentMealPhotos(el) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack || el.classList.contains('hidden')) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    for (const ii of [si - 1, si + 1]) {
        if (ii < 0 || ii >= slides.length) continue;
        const slide = slides[ii];
        const row = getCarouselRowForSlide(slide, el);
        const urls = row?.urls;
        if (!Array.isArray(urls) || !urls.length) continue;
        const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
        const pIdx = Math.min(urls.length - 1, Math.max(0, Number(frame?.dataset.photoIndex || 0)));
        preloadMealPhotoUrl(urls[pIdx]);
        if (urls[pIdx + 1]) preloadMealPhotoUrl(urls[pIdx + 1]);
        if (urls[pIdx - 1]) preloadMealPhotoUrl(urls[pIdx - 1]);
    }
    const activeSlide = slides[si];
    const activeRow = getCarouselRowForSlide(activeSlide, el);
    const au = activeRow?.urls;
    if (Array.isArray(au) && au.length > 1) {
        const frame = activeSlide.querySelector('.timeline-meal-photos-carousel-frame');
        const ci = Math.min(au.length - 1, Math.max(0, Number(frame?.dataset.photoIndex || 0)));
        if (au[ci + 1]) preloadMealPhotoUrl(au[ci + 1]);
        if (au[ci - 1]) preloadMealPhotoUrl(au[ci - 1]);
    }
}

/** 활성 슬라이드 + 바로 위·아래 슬라이드의 `<img>`에 실제 URL 적용(빈 플레이스홀더 완화) */
function hydrateMealPhotoVisibleImage(el) {
    const vtrack = el?._mealPhotosVTrack;
    if (!vtrack || el.classList.contains('hidden')) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const si = getVTrackActiveIndex(vtrack);
    const neighbors = [si - 1, si, si + 1].filter((i) => i >= 0 && i < slides.length);
    for (const ii of neighbors) {
        const slide = slides[ii];
        const frame = slide.querySelector('.timeline-meal-photos-carousel-frame');
        if (!frame) continue;
        const idx = Number(frame.dataset.photoIndex || 0);
        const isActive = ii === si;
        applyCarouselIndex(slide, el, idx, isActive ? {} : { fade: false });
    }
    preloadAdjacentMealPhotos(el);
}

/**
 * 휠 모드: 세로/가로로 사진이 바뀐 뒤(스크롤 종료 + 활성 이미지 로드)에만
 * 라벨 텍스트·위치를 한 번 갱신 — 스크롤 중에는 라벨이 따라 움직이지 않음.
 */
function runMealPhotoWheelLabelLayoutWhenReady(el) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    if (el._mealPhotoWheelLayoutRunning) return;
    const vtrack = el._mealPhotosVTrack;
    if (!vtrack) return;
    el._mealPhotoWheelLayoutRunning = true;
    try {
        hydrateMealPhotoVisibleImage(el);
    } finally {
        el._mealPhotoWheelLayoutRunning = false;
    }
    const frame = getActiveCarouselFrame(vtrack);
    const img = frame?.querySelector('img.timeline-meal-photo-img');
    const finish = () => {
        syncMealPhotoWheelFromVtrack(el, vtrack);
        positionMealPhotoWheelCaption(el);
        positionMealPhotoCloseButton(el);
        syncMealPhotoWheelCaptionPhotoMinWidth(el);
        requestAnimationFrame(() => syncMealPhotoWheelCaptionPhotoMinWidth(el));
        bindMealPhotoWheelCaptionResizeObserver(el);
    };
    /** 이미지 실제 픽셀·object-fit 배치가 끝난 뒤 라벨 top 계산 */
    const runFinishAfterPaint = () => {
        requestAnimationFrame(() => {
            requestAnimationFrame(finish);
        });
    };
    const runAfterDecodeIfPossible = () => {
        const dec = img?.decode?.();
        if (dec && typeof dec.then === 'function') {
            dec.then(runFinishAfterPaint).catch(runFinishAfterPaint);
        } else {
            runFinishAfterPaint();
        }
    };
    if (!img) {
        runFinishAfterPaint();
        return;
    }
    if (img.complete && (img.naturalHeight || 0) > 1) {
        runAfterDecodeIfPossible();
    } else {
        const onReady = () => runAfterDecodeIfPossible();
        img.addEventListener('load', onReady, { once: true });
        img.addEventListener('error', onReady, { once: true });
    }
}

function scheduleMealPhotoWheelLabelLayout(el, delayMs = 80) {
    if (!el?.classList.contains('timeline-meal-photos-overlay--wheel')) return;
    clearTimeout(el._mealPhotoWheelLabelTimer);
    if (delayMs <= 0) {
        el._mealPhotoWheelLabelTimer = null;
        requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(el));
        return;
    }
    el._mealPhotoWheelLabelTimer = setTimeout(() => {
        el._mealPhotoWheelLabelTimer = null;
        runMealPhotoWheelLabelLayoutWhenReady(el);
    }, delayMs);
}

function getOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className =
        'hidden fixed inset-0 z-[310] flex min-h-0 flex-col items-stretch overflow-visible bg-slate-950/94 backdrop-blur-sm';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '기록 사진');
    el.innerHTML = `
        <button type="button" class="timeline-meal-photos-close absolute z-[60] flex h-[35px] w-[35px] shrink-0 items-center justify-center rounded-full border border-white/50 bg-black/65 text-white shadow-lg ring-2 ring-white/40 backdrop-blur-sm hover:bg-black/80 active:scale-95 transition-colors" aria-label="닫기">
            <i class="fa-solid fa-xmark text-sm" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-prev absolute left-1 top-1/2 z-30 hidden items-center justify-center -translate-y-1/2 rounded-full bg-white/15 p-3 text-white hover:bg-white/25" aria-label="이전 사진">
            <i class="fa-solid fa-chevron-left text-lg" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-next absolute right-1 top-1/2 z-30 hidden items-center justify-center -translate-y-1/2 rounded-full bg-white/15 p-3 text-white hover:bg-white/25" aria-label="다음 사진">
            <i class="fa-solid fa-chevron-right text-lg" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-vprev absolute left-1/2 top-14 z-30 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-2 text-white hover:bg-white/25" aria-label="이전 슬롯">
            <i class="fa-solid fa-chevron-up text-lg" aria-hidden="true"></i>
        </button>
        <button type="button" class="timeline-meal-photos-vnext absolute bottom-14 left-1/2 z-30 hidden -translate-x-1/2 items-center justify-center rounded-full bg-white/15 px-3 py-2 text-white hover:bg-white/25" aria-label="다음 슬롯">
            <i class="fa-solid fa-chevron-down text-lg" aria-hidden="true"></i>
        </button>
        <div class="timeline-meal-photos-body meal-photos-overlay-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div class="timeline-meal-photos-stage timeline-meal-photos-stage--with-footer relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden py-2">
                <div class="timeline-meal-photos-vtrack scrollbar-hide flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain snap-y snap-mandatory" style="-webkit-overflow-scrolling:touch;touch-action:pan-y"></div>
                ${buildMealPhotoGlobalCaptionFooterHtml()}
            </div>
        </div>
    `;
    document.body.appendChild(el);

    const vtrack = el.querySelector('.timeline-meal-photos-vtrack');
    const btnPrev = el.querySelector('.timeline-meal-photos-prev');
    const btnNext = el.querySelector('.timeline-meal-photos-next');
    const btnVPrev = el.querySelector('.timeline-meal-photos-vprev');
    const btnVNext = el.querySelector('.timeline-meal-photos-vnext');
    const btnClose = el.querySelector('.timeline-meal-photos-close');

    const syncMealPhotoChrome = () => {
        if (!vtrack) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        const rows = el._mealPhotoRows?.length || 0;
        const si = getVTrackActiveIndex(vtrack);
        const slide = slides[si];
        const frame = getActiveCarouselFrame(vtrack);
        const row = slide ? getCarouselRowForSlide(slide, el) : null;
        const nPhotos = row?.urls?.length || 0;
        frame?.classList.toggle('cursor-grab', nPhotos > 1);
        if (!frame || nPhotos <= 1) frame?.classList.remove('cursor-grabbing');
        vtrack?.classList.toggle('cursor-grab', rows > 1);
        if (rows <= 1) vtrack?.classList.remove('cursor-grabbing');
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
            if (!el._mealPhotoWheelSuppressLabelSchedule) {
                scheduleMealPhotoWheelLabelLayout(el, 80);
            }
        }
        hydrateMealPhotoVisibleImage(el);
        positionMealPhotoCloseButton(el);
    };

    vtrack?.addEventListener('scroll', syncMealPhotoChrome, { passive: true });
    vtrack?.addEventListener(
        'scrollend',
        () => {
            if (el.classList.contains('hidden') || !el.classList.contains('timeline-meal-photos-overlay--wheel')) return;
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            runMealPhotoWheelLabelLayoutWhenReady(el);
        },
        { passive: true }
    );

    const appendMonthRows = (year, month) => {
        if (!vtrack) return;
        const raw = buildMealPhotoViewerRowsForMonth(year, month);
        const prepared = prepareRowsWithPhotoCap(filterRowsWithPhotos(raw));
        const footer = vtrack.querySelector('.timeline-meal-photos-month-footer');
        const html = prepared.map((r) => buildVSlideHtml(r, false)).join('');
        if (footer) footer.insertAdjacentHTML('beforebegin', html);
        else vtrack.insertAdjacentHTML('beforeend', html);
        el._mealPhotoRows = (el._mealPhotoRows || []).concat(prepared);
        el._mealPhotoLastYM = { y: year, mo: month };
        footer?.remove();
        vtrack.insertAdjacentHTML('beforeend', buildMonthLoadFooterHtml(year, month));
        el._mealPhotosBindRowTracks?.();
        rebuildMealPhotoWheelPickers(el);
        el._mealPhotosSync?.();
        el._mealPhotosToggleVNav?.();
    };

    vtrack?.addEventListener('click', (e) => {
        const loadBtn = e.target.closest?.('.timeline-meal-photos-load-next-month');
        if (loadBtn) {
            e.preventDefault();
            e.stopPropagation();
            const y = Number(loadBtn.getAttribute('data-next-y'));
            const mo = Number(loadBtn.getAttribute('data-next-m'));
            if (Number.isFinite(y) && Number.isFinite(mo)) appendMonthRows(y, mo);
            return;
        }
        const exp = e.target.closest?.('.timeline-meal-photo-expand');
        if (!exp) return;
        e.preventDefault();
        e.stopPropagation();
        const dateStr = exp.getAttribute('data-expand-date');
        const slotId = exp.getAttribute('data-expand-slot');
        const recordAttr = exp.getAttribute('data-expand-record');
        const recordId = recordAttr == null || recordAttr === '' ? null : String(recordAttr);
        if (!dateStr || !slotId) return;
        const row = findMealPhotoRowState(el, dateStr, slotId, recordId);
        if (!row || !Array.isArray(row.allUrls) || !row.urls?.length) return;
        const slide = exp.closest('.timeline-meal-photos-vslide');
        if (!slide) return;
        row.urls = row.allUrls;
        delete row.allUrls;
        const zone = slide.querySelector('.timeline-meal-photos-carousel-zone');
        if (zone) {
            zone.outerHTML = buildCarouselZoneHtml(row, {
                wheelViewport: el.classList.contains('timeline-meal-photos-overlay--wheel')
            });
            el._mealPhotosBindRowTracks?.();
            applyCarouselIndex(slide, el, 0);
        }
        if (el.classList.contains('timeline-meal-photos-overlay--wheel')) {
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            runMealPhotoWheelLabelLayoutWhenReady(el);
        }
        try {
            el._mealPhotoWheelSuppressLabelSchedule = Boolean(el.classList.contains('timeline-meal-photos-overlay--wheel'));
            el._mealPhotosSync?.();
        } finally {
            el._mealPhotoWheelSuppressLabelSchedule = false;
        }
    });

    /** 세로: 마우스 드래그 */
    let vDragId = null;
    let vLastY = 0;
    const onVDown = (e) => {
        if (e.pointerType !== 'mouse') return;
        if ((vtrack?.querySelectorAll('.timeline-meal-photos-vslide').length || 0) <= 1) return;
        vDragId = e.pointerId;
        vLastY = e.clientY;
        try {
            vtrack.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        vtrack.classList.add('cursor-grabbing');
    };
    const onVMove = (e) => {
        if (vDragId == null || e.pointerId !== vDragId || !vtrack) return;
        const dy = e.clientY - vLastY;
        vLastY = e.clientY;
        vtrack.scrollTop -= dy;
    };
    const endV = (e) => {
        if (vDragId == null || (e && e.pointerId !== vDragId)) return;
        try {
            vtrack.releasePointerCapture(vDragId);
        } catch (_) {
            /* ignore */
        }
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
    };
    vtrack?.addEventListener('pointerdown', onVDown);
    vtrack?.addEventListener('pointermove', onVMove);
    vtrack?.addEventListener('pointerup', endV);
    vtrack?.addEventListener('pointercancel', endV);
    vtrack?.addEventListener('lostpointercapture', () => {
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
    });

    const close = () => {
        clearTimeout(el._mealPhotoWheelLabelTimer);
        el._mealPhotoWheelLabelTimer = null;
        el._mealPhotoWheelLayoutRunning = false;
        el.classList.add('hidden');
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        document.body.classList.remove('overflow-hidden');
        if (vtrack) vtrack.innerHTML = '';
        const cap = el.querySelector('.timeline-meal-photos-caption-footer');
        cap?.classList.add('hidden');
        cap?.classList.remove('flex');
        cap?.style.removeProperty('top');
        cap?.style.removeProperty('bottom');
        cap?.style.removeProperty('left');
        cap?.style.removeProperty('right');
        cap?.style.removeProperty('position');
        el.style.removeProperty('--meal-wheel-caption-inner-w');
        clearMealWheelInnerTilts(el);
        el._mealPhotoWheelPrevSlideIndex = undefined;
        el.querySelectorAll('[data-wheel-label-strip]').forEach((strip) => {
            if (strip._mealStripTid) {
                clearTimeout(strip._mealStripTid);
                strip._mealStripTid = null;
            }
            if (strip._mealStripOnEnd) {
                strip.removeEventListener('transitionend', strip._mealStripOnEnd);
                strip._mealStripOnEnd = null;
            }
            delete strip.dataset.cur;
            strip.style.transition = 'none';
            strip.style.transform = 'translateY(0)';
            strip.innerHTML = '<span class="meal-photo-wheel-label-line">—</span>';
        });
        el._mealPhotoRows = null;
        el._mealPhotoLastYM = null;
        _mealPhotoPreloadStarted.clear();
        if (el._mealPhotoWheelCaptionRO) {
            el._mealPhotoWheelCaptionRO.disconnect();
            el._mealPhotoWheelCaptionRO = null;
        }
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
        const cb = el.querySelector('.timeline-meal-photos-close');
        if (cb) {
            cb.style.removeProperty('left');
            cb.style.removeProperty('top');
            cb.style.removeProperty('right');
            cb.style.removeProperty('bottom');
            cb.style.removeProperty('transform');
        }
    };

    btnClose?.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
    });
    el.addEventListener('click', (e) => {
        if (e.target === el) close();
    });
    btnPrev?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepCarouselPhoto(el, -1);
    });
    btnNext?.addEventListener('click', (e) => {
        e.stopPropagation();
        stepCarouselPhoto(el, 1);
    });
    const scrollVBy = (dir) => {
        if (!vtrack) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        if (!slides.length) return;
        const i = getVTrackActiveIndex(vtrack);
        const next = Math.min(slides.length - 1, Math.max(0, i + dir));
        const delta = el.classList.contains('timeline-meal-photos-overlay--wheel')
            ? scrollDeltaToCenterSlideInVtrack(vtrack, slides[next])
            : scrollDeltaToAlignSlideTop(vtrack, slides[next]);
        vtrack.scrollTo({ top: vtrack.scrollTop + delta, behavior: 'smooth' });
    };
    btnVPrev?.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollVBy(-1);
    });
    btnVNext?.addEventListener('click', (e) => {
        e.stopPropagation();
        scrollVBy(1);
    });

    const onKey = (e) => {
        if (el.classList.contains('hidden')) return;
        if (e.key === 'Escape') {
            close();
            return;
        }
        const frame = getActiveCarouselFrame(vtrack);
        const rows = el._mealPhotoRows?.length || 0;
        if (e.key === 'ArrowLeft' && frame) {
            e.preventDefault();
            stepCarouselPhoto(el, -1);
        } else if (e.key === 'ArrowRight' && frame) {
            e.preventDefault();
            stepCarouselPhoto(el, 1);
        } else if (e.key === 'ArrowUp' && rows > 1) {
            e.preventDefault();
            scrollVBy(-1);
        } else if (e.key === 'ArrowDown' && rows > 1) {
            e.preventDefault();
            scrollVBy(1);
        }
    };
    document.addEventListener('keydown', onKey);

    const mq = window.matchMedia?.('(min-width: 768px)');
    const toggleNavDesktopOnly = () => {
        const slides = vtrack?.querySelectorAll('.timeline-meal-photos-vslide');
        const slide = slides?.[getVTrackActiveIndex(vtrack)];
        const row = slide ? getCarouselRowForSlide(slide, el) : null;
        const many = (row?.urls?.length || 0) > 1;
        const isMd = mq ? mq.matches : false;
        const show = many && isMd;
        [btnPrev, btnNext].forEach((b) => {
            if (!b) return;
            if (show) {
                b.classList.remove('hidden');
                b.classList.add('inline-flex');
            } else {
                b.classList.add('hidden');
                b.classList.remove('inline-flex');
            }
        });
    };
    /** 상하 슬롯 이동 화살표는 표시하지 않음(vtrack 세로 스크롤·스와이프로만 이동). */
    const toggleVNavDesktopOnly = () => {
        [btnVPrev, btnVNext].forEach((b) => {
            if (!b) return;
            b.classList.add('hidden');
            b.classList.remove('inline-flex');
        });
    };
    mq?.addEventListener?.('change', () => {
        toggleNavDesktopOnly();
        toggleVNavDesktopOnly();
    });

    window.addEventListener('resize', syncOverlayLayout, { passive: true });
    window.addEventListener('orientationchange', syncOverlayLayout, { passive: true });
    window.visualViewport?.addEventListener?.('resize', syncOverlayLayout, { passive: true });
    window.visualViewport?.addEventListener?.('scroll', syncOverlayLayout, { passive: true });

    el._mealPhotosClose = close;
    el._mealPhotosSync = syncMealPhotoChrome;
    el._mealPhotosToggleNav = toggleNavDesktopOnly;
    el._mealPhotosToggleVNav = toggleVNavDesktopOnly;
    el._mealPhotosLayout = syncOverlayLayout;
    el._mealPhotosVTrack = vtrack;
    el._mealPhotosBindRowTracks = () => {
        vtrack?.querySelectorAll('.timeline-meal-photos-carousel-zone').forEach((zone) => {
            bindCarouselSwipe(zone, el);
        });
    };
    return el;
}

/**
 * @param {HTMLButtonElement} btn — data-photos + (선택) data-meal-view-date/slot/record
 */
export function openTimelineMealPhotosPopup(btn) {
    const raw = btn?.getAttribute?.('data-photos');
    if (!raw) return;
    let urls;
    try {
        urls = JSON.parse(decodeURIComponent(raw));
    } catch {
        return;
    }
    if (!Array.isArray(urls) || urls.length === 0) return;

    const el = getOverlay();
    const vtrack = el._mealPhotosVTrack;
    if (!vtrack) return;

    const dateStr = btn.getAttribute('data-meal-view-date');
    const slotId = btn.getAttribute('data-meal-view-slot');
    const recordId = btn.getAttribute('data-meal-view-record');

    const useDayNav = Boolean(dateStr && slotId);
    if (useDayNav) {
        const ym = parseYearMonthFromDateStr(dateStr);
        const rowsRaw = ym ? buildMealPhotoViewerRowsForMonth(ym.y, ym.mo) : buildMealPhotoViewerRowsForDate(dateStr);
        const rows = filterRowsWithPhotos(rowsRaw);
        const startRow = findMealPhotoViewerRowIndex(rows, slotId, recordId, dateStr);
        const prepared = prepareRowsWithPhotoCap(rows);
        el._mealPhotoRows = prepared;
        if (ym) el._mealPhotoLastYM = { y: ym.y, mo: ym.mo };
        else el._mealPhotoLastYM = null;
        const footer = ym ? buildMonthLoadFooterHtml(ym.y, ym.mo) : '';
        vtrack.innerHTML = prepared.map((r) => buildVSlideHtml(r, false)).join('') + footer;
        el._mealPhotosBindRowTracks?.();
        el.classList.add('timeline-meal-photos-overlay--wheel');
        const capShow = el.querySelector('.timeline-meal-photos-caption-footer');
        capShow?.classList.remove('hidden');
        capShow?.classList.add('flex');
        rebuildMealPhotoWheelPickers(el);
        el.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        el._mealPhotosLayout?.();
        requestAnimationFrame(() => {
            el._mealPhotosLayout?.();
            const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
            const target = slides[startRow];
            if (target) {
                vtrack.scrollTop += scrollDeltaToCenterSlideInVtrack(vtrack, target);
            }
            el._mealPhotosSync?.();
            el._mealPhotosToggleNav?.();
            el._mealPhotosToggleVNav?.();
            clearTimeout(el._mealPhotoWheelLabelTimer);
            el._mealPhotoWheelLabelTimer = null;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => runMealPhotoWheelLabelLayoutWhenReady(el));
            });
        });
    } else {
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        clearMealWheelInnerTilts(el);
        const capLeg = el.querySelector('.timeline-meal-photos-caption-footer');
        capLeg?.classList.add('hidden');
        capLeg?.classList.remove('flex');
        el._mealPhotoRows = [{ urls, isLegacy: true }];
        const slide = `<section class="timeline-meal-photos-vslide timeline-meal-photos-vslide--legacy flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden" data-legacy-carousel="1">
            <div class="timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col">
                <div class="timeline-meal-photos-track timeline-meal-photos-track--carousel scrollbar-hide flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col items-stretch overflow-hidden" style="-webkit-overflow-scrolling:touch">${buildHorizontalSlidesLegacyHtml(urls)}</div>
            </div>
        </section>`;
        vtrack.innerHTML = slide;
        el._mealPhotosBindRowTracks?.();
        el.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        el._mealPhotosLayout?.();
        vtrack.scrollTop = 0;
        requestAnimationFrame(() => {
            el._mealPhotosLayout?.();
            el._mealPhotosSync?.();
            el._mealPhotosToggleNav?.();
            el._mealPhotosToggleVNav?.();
        });
    }

    try {
        btn.blur();
    } catch (_) {
        /* ignore */
    }
}

window.openTimelineMealPhotosPopup = openTimelineMealPhotosPopup;
