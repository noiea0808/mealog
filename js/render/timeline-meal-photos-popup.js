/**
 * 타임라인 카드 좌측 사진 탭 — 가로: 해당 기록의 사진들(다장은 일부+펼침), 세로: 같은 달(월) 기록이 있는 날·슬롯 순서, 하단에서 다음 달 추가
 * 오버레이 크기: 뷰포트 상·하 `MEAL_PHOTO_OVERLAY_INSET_Y` 고정 여백
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

/** 뷰포트 기준 오버레이 상·하 여백(px) — 크기 고정용, 필요 시 숫자만 조정 */
const MEAL_PHOTO_OVERLAY_INSET_Y = 20;
const MEAL_PHOTO_OVERLAY_INSET_X = 12;

/**
 * 세로: `window.innerHeight - 2 * INSET_Y` 고정(항상 동일).
 * 가로: `#mainApp` 컬럼에 맞춤(폭·좌표), 최소 좌우 INSET_X 확보.
 */
function getMealogContentOverlayRect() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const top = MEAL_PHOTO_OVERLAY_INSET_Y;
    const height = Math.max(120, vh - 2 * MEAL_PHOTO_OVERLAY_INSET_Y);

    const mainApp = document.getElementById('mainApp');
    if (!mainApp || mainApp.classList.contains('hidden')) {
        return {
            top,
            left: MEAL_PHOTO_OVERLAY_INSET_X,
            width: Math.max(1, vw - 2 * MEAL_PHOTO_OVERLAY_INSET_X),
            height
        };
    }
    const appRect = mainApp.getBoundingClientRect();
    const left = Math.max(MEAL_PHOTO_OVERLAY_INSET_X, appRect.left);
    const maxW = vw - MEAL_PHOTO_OVERLAY_INSET_X - left;
    const width = Math.max(1, Math.min(appRect.width, maxW));
    return { top, left, width, height };
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
function buildHorizontalPhotoCellsHtml(row, urlsSlice, globalStart0, nTotal) {
    const menuBar = buildMenuBarBelowPhotoHtml(row);
    return urlsSlice
        .map((url, i) => {
            const globalIdx = globalStart0 + i;
            const onImg = buildPhotoIndexOnImageHtml(globalIdx + 1, nTotal);
            const lazyAttr = globalIdx > 0 ? ' loading="lazy" decoding="async"' : ' decoding="async"';
            return `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-stretch justify-center p-1 box-border">
                    <div class="flex max-h-full min-h-0 w-full max-w-full flex-col items-stretch">
                        <div class="relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center">
                            <img src="${escapeHtml(String(url))}" alt="" class="block max-h-full max-w-full rounded-lg object-contain object-center shadow-lg select-none" draggable="false"${lazyAttr} />
                            ${onImg}
                        </div>
                        ${menuBar}
                    </div>
                </div>`;
        })
        .join('');
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

/** 사진 없음: 흰 영역 + 플러스(스킵만 금지 아이콘) */
function placeholderIconClass(row) {
    if (row.mealType === 'Skip') return 'fa-solid fa-ban text-5xl text-slate-500';
    return 'fa-solid fa-plus text-5xl text-slate-400';
}

function buildHorizontalSlidesHtml(row) {
    const urls = row.urls || [];
    if (!urls.length) return '';
    const nTotal = Array.isArray(row.allUrls) && row.allUrls.length > urls.length ? row.allUrls.length : urls.length;
    const hidden = nTotal - urls.length;
    const cells = buildHorizontalPhotoCellsHtml(row, urls, 0, nTotal);
    const expand = hidden > 0 ? buildPhotoExpandChipHtml(row, hidden) : '';
    return cells + expand;
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
    const n = urls.length;
    return urls
        .map(
            (url, idx) =>
                `<div class="timeline-meal-photo-cell flex h-full min-h-0 w-full min-w-full flex-shrink-0 snap-center snap-always flex-col items-center justify-center p-1 box-border">
                    <div class="inline-flex max-h-full min-h-0 max-w-full flex-col items-stretch">
                        <div class="relative flex min-h-0 w-full min-w-0 flex-1 items-center justify-center">
                            <img src="${escapeHtml(String(url))}" alt="" class="block max-h-full max-w-full rounded-lg object-contain object-center shadow-lg select-none" draggable="false"${idx > 0 ? ' loading="lazy"' : ''} decoding="async" />
                            ${buildPhotoIndexOnImageHtml(idx + 1, n)}
                        </div>
                    </div>
                </div>`
        )
        .join('');
}

function buildVSlideHtml(row) {
    const nPhotos = Array.isArray(row.urls) ? row.urls.length : 0;
    const innerTrack = nPhotos > 0 ? buildHorizontalSlidesHtml(row) : buildPlaceholderSlideHtml(row);
    return `<section class="timeline-meal-photos-vslide flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden border-b border-white/10 last:border-b-0" data-date-str="${escapeHtml(row.dateStr)}" data-slot-id="${escapeHtml(row.slotId)}" data-record-id="${escapeHtml(row.recordId || '')}" data-slot-title="${escapeHtml(String(row.slotTitle || ''))}">
        <div class="timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col">
            <div class="timeline-meal-photos-track scrollbar-hide flex min-h-0 flex-1 w-full max-w-full min-w-0 snap-x snap-mandatory flex-row overflow-x-auto overflow-y-hidden scroll-smooth" style="-webkit-overflow-scrolling:touch;touch-action:pan-x">${innerTrack}</div>
        </div>
    </section>`;
}

function bindHorizontalTrackDrag(track) {
    if (!track || track._mealHBound) return;
    track._mealHBound = true;
    let dragPointerId = null;
    let dragLastX = 0;
    const onDown = (e) => {
        if (e.pointerType !== 'mouse') return;
        if ((track.children?.length || 0) <= 1) return;
        dragPointerId = e.pointerId;
        dragLastX = e.clientX;
        try {
            track.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
        track.classList.add('cursor-grabbing');
    };
    const onMove = (e) => {
        if (dragPointerId == null || e.pointerId !== dragPointerId) return;
        const dx = e.clientX - dragLastX;
        dragLastX = e.clientX;
        track.scrollLeft -= dx;
    };
    const end = (e) => {
        if (dragPointerId == null || (e && e.pointerId !== dragPointerId)) return;
        try {
            track.releasePointerCapture(dragPointerId);
        } catch (_) {
            /* ignore */
        }
        dragPointerId = null;
        track.classList.remove('cursor-grabbing');
    };
    track.addEventListener('pointerdown', onDown);
    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('lostpointercapture', () => {
        dragPointerId = null;
        track.classList.remove('cursor-grabbing');
    });
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

const MEAL_PHOTO_WHEEL_ITEM_PX = 32;

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

function buildWheelItemsHtml(from, to, pad2) {
    const parts = [];
    for (let n = from; n <= to; n++) {
        const v = pad2 ? String(n).padStart(2, '0') : String(n);
        parts.push(
            `<div class="meal-photo-wheel-item flex h-8 w-full shrink-0 items-center justify-center text-[12px] font-black tabular-nums leading-none text-white/90" data-val="${escapeHtml(v)}">${escapeHtml(v)}</div>`
        );
    }
    return parts.join('');
}

function scrollWheelInnerToValue(inner, valStr) {
    if (!inner || valStr == null) return;
    const want = String(valStr);
    const items = inner.querySelectorAll('.meal-photo-wheel-item');
    let idx = -1;
    items.forEach((it, i) => {
        if (it.getAttribute('data-val') === want) idx = i;
    });
    if (idx < 0) return;
    const top = idx * MEAL_PHOTO_WHEEL_ITEM_PX;
    inner.scrollTop = top;
    requestAnimationFrame(() => {
        inner.scrollTop = top;
    });
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

function rebuildMealPhotoWheelPickers(el) {
    const bar = el.querySelector('.timeline-meal-photos-wheelbar');
    if (!bar) return;
    const rows = el._mealPhotoRows;
    if (!Array.isArray(rows) || !rows.length) return;
    const { minY, maxY } = yearsRangeFromMealPhotoRows(rows);
    const yInner = bar.querySelector('[data-wheel-inner="year"]');
    const mInner = bar.querySelector('[data-wheel-inner="month"]');
    const dInner = bar.querySelector('[data-wheel-inner="day"]');
    if (yInner) yInner.innerHTML = buildWheelItemsHtml(minY, maxY, false);
    if (mInner) mInner.innerHTML = buildWheelItemsHtml(1, 12, true);
    if (dInner) dInner.innerHTML = buildWheelItemsHtml(1, 31, true);
}

function syncMealPhotoWheelFromVtrack(el, vtrack) {
    const bar = el.querySelector('.timeline-meal-photos-wheelbar');
    if (!bar || bar.classList.contains('hidden') || !vtrack) return;
    const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides.length) return;
    const i = getVTrackActiveIndex(vtrack);
    const slide = slides[i];
    if (!slide) return;
    const iso = slide.getAttribute('data-date-str');
    const slotTitle = slide.getAttribute('data-slot-title') || '—';
    const slotEl = bar.querySelector('[data-wheel-slot]');
    if (slotEl) slotEl.textContent = slotTitle;
    const parts = parseWheelIsoParts(iso);
    if (!parts) return;
    scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="year"]'), parts.y);
    scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="month"]'), parts.mo);
    scrollWheelInnerToValue(bar.querySelector('[data-wheel-inner="day"]'), parts.day);
}

function getActiveHorizontalTrack(vtrack) {
    const slides = vtrack?.querySelectorAll('.timeline-meal-photos-vslide');
    if (!slides?.length) return null;
    const i = getVTrackActiveIndex(vtrack);
    return slides[i]?.querySelector('.timeline-meal-photos-track') || null;
}

function getOverlay() {
    let el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className =
        'hidden fixed z-[310] flex min-h-0 flex-col items-stretch overflow-hidden rounded-2xl border border-slate-700/40 bg-slate-950/94 shadow-2xl backdrop-blur-sm';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '기록 사진');
    el.innerHTML = `
        <button type="button" class="timeline-meal-photos-close absolute top-3 right-3 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 active:scale-95 transition-colors" aria-label="닫기">
            <i class="fa-solid fa-xmark text-lg" aria-hidden="true"></i>
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
        <div class="timeline-meal-photos-body flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div class="timeline-meal-photos-stage relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
                <div class="timeline-meal-photos-wheelbar pointer-events-none absolute left-3 top-3 z-40 hidden max-w-[calc(100%-2.75rem)] min-w-0 shrink-0 items-center gap-0.5 rounded-lg border border-white/10 bg-slate-950/55 px-2 py-1 backdrop-blur-sm">
                    <div class="meal-photo-wheel-col flex shrink-0 flex-col items-center">
                        <div class="meal-photo-wheel-viewport">
                            <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="year" style="-webkit-overflow-scrolling:touch"></div>
                        </div>
                    </div>
                    <span class="meal-photo-wheel-sep shrink-0 select-none text-xs font-bold text-white/45">:</span>
                    <div class="meal-photo-wheel-col flex shrink-0 flex-col items-center">
                        <div class="meal-photo-wheel-viewport">
                            <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="month" style="-webkit-overflow-scrolling:touch"></div>
                        </div>
                    </div>
                    <span class="meal-photo-wheel-sep shrink-0 select-none text-xs font-bold text-white/45">:</span>
                    <div class="meal-photo-wheel-col flex shrink-0 flex-col items-center">
                        <div class="meal-photo-wheel-viewport">
                            <div class="meal-photo-wheel-inner scrollbar-hide" data-wheel-inner="day" style="-webkit-overflow-scrolling:touch"></div>
                        </div>
                    </div>
                    <span class="meal-photo-wheel-sep shrink-0 select-none px-0.5 text-xs font-bold text-white/45">|</span>
                    <div class="meal-photo-wheel-col meal-photo-wheel-col--slot flex min-w-0 shrink-0 flex-col justify-center">
                        <span class="meal-photo-wheel-slot block w-full truncate text-left text-[11px] font-bold leading-tight text-white/90" data-wheel-slot></span>
                    </div>
                </div>
                <div class="timeline-meal-photos-vtrack scrollbar-hide flex h-full min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-y-contain snap-y snap-mandatory" style="-webkit-overflow-scrolling:touch;touch-action:pan-y"></div>
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
        const rows = el._mealPhotoRows?.length || 0;
        const tr = getActiveHorizontalTrack(vtrack);
        const n = tr?.children?.length || 0;
        tr?.classList.toggle('cursor-grab', n > 1);
        if (!tr || n <= 1) tr?.classList.remove('cursor-grabbing');
        vtrack?.classList.toggle('cursor-grab', rows > 1);
        if (rows <= 1) vtrack?.classList.remove('cursor-grabbing');
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        syncMealPhotoWheelFromVtrack(el, vtrack);
    };

    vtrack?.addEventListener('scroll', syncMealPhotoChrome, { passive: true });

    const appendMonthRows = (year, month) => {
        if (!vtrack) return;
        const raw = buildMealPhotoViewerRowsForMonth(year, month);
        const prepared = prepareRowsWithPhotoCap(raw);
        const footer = vtrack.querySelector('.timeline-meal-photos-month-footer');
        const html = prepared.map((r) => buildVSlideHtml(r)).join('');
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
        const track = exp.closest('.timeline-meal-photos-track');
        if (!track) return;
        const rest = row.allUrls.slice(row.urls.length);
        if (!rest.length) return;
        const nTotal = row.allUrls.length;
        const start = row.urls.length;
        const html = buildHorizontalPhotoCellsHtml(row, rest, start, nTotal);
        exp.insertAdjacentHTML('beforebegin', html);
        exp.remove();
        row.urls = row.allUrls;
        delete row.allUrls;
        el._mealPhotosSync?.();
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
        el.classList.add('hidden');
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        document.body.classList.remove('overflow-hidden');
        if (vtrack) vtrack.innerHTML = '';
        const wb = el.querySelector('.timeline-meal-photos-wheelbar');
        wb?.classList.add('hidden');
        wb?.classList.remove('flex');
        el._mealPhotoRows = null;
        el._mealPhotoLastYM = null;
        el._mealPhotosToggleNav?.();
        el._mealPhotosToggleVNav?.();
        vDragId = null;
        vtrack?.classList.remove('cursor-grabbing');
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
        const tr = getActiveHorizontalTrack(vtrack);
        const w = tr?.clientWidth;
        if (w) tr.scrollBy({ left: -w, behavior: 'smooth' });
    });
    btnNext?.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = getActiveHorizontalTrack(vtrack);
        const w = tr?.clientWidth;
        if (w) tr.scrollBy({ left: w, behavior: 'smooth' });
    });
    const scrollVBy = (dir) => {
        if (!vtrack) return;
        const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
        if (!slides.length) return;
        const i = getVTrackActiveIndex(vtrack);
        const next = Math.min(slides.length - 1, Math.max(0, i + dir));
        const delta = scrollDeltaToAlignSlideTop(vtrack, slides[next]);
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
        const tr = getActiveHorizontalTrack(vtrack);
        const w = tr?.clientWidth;
        const rows = el._mealPhotoRows?.length || 0;
        if (e.key === 'ArrowLeft' && w) {
            e.preventDefault();
            tr.scrollBy({ left: -w, behavior: 'smooth' });
        } else if (e.key === 'ArrowRight' && w) {
            e.preventDefault();
            tr.scrollBy({ left: w, behavior: 'smooth' });
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
        const tr = getActiveHorizontalTrack(vtrack);
        const many = (tr?.children?.length || 0) > 1;
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
    const toggleVNavDesktopOnly = () => {
        const rows = el._mealPhotoRows?.length || 0;
        const isMd = mq ? mq.matches : false;
        const show = rows > 1 && isMd;
        [btnVPrev, btnVNext].forEach((b) => {
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
    mq?.addEventListener?.('change', () => {
        toggleNavDesktopOnly();
        toggleVNavDesktopOnly();
    });

    window.addEventListener('resize', syncOverlayLayout, { passive: true });
    window.addEventListener('orientationchange', syncOverlayLayout, { passive: true });

    el._mealPhotosClose = close;
    el._mealPhotosSync = syncMealPhotoChrome;
    el._mealPhotosToggleNav = toggleNavDesktopOnly;
    el._mealPhotosToggleVNav = toggleVNavDesktopOnly;
    el._mealPhotosLayout = syncOverlayLayout;
    el._mealPhotosVTrack = vtrack;
    el._mealPhotosBindRowTracks = () => {
        vtrack?.querySelectorAll('.timeline-meal-photos-track').forEach((t) => {
            bindHorizontalTrackDrag(t);
            if (!t._mealTrackScrollSync) {
                t._mealTrackScrollSync = true;
                t.addEventListener('scroll', syncMealPhotoChrome, { passive: true });
            }
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
        const rows = ym ? buildMealPhotoViewerRowsForMonth(ym.y, ym.mo) : buildMealPhotoViewerRowsForDate(dateStr);
        const startRow = findMealPhotoViewerRowIndex(rows, slotId, recordId, dateStr);
        const prepared = prepareRowsWithPhotoCap(rows);
        el._mealPhotoRows = prepared;
        if (ym) el._mealPhotoLastYM = { y: ym.y, mo: ym.mo };
        else el._mealPhotoLastYM = null;
        const footer = ym ? buildMonthLoadFooterHtml(ym.y, ym.mo) : '';
        vtrack.innerHTML = prepared.map((r) => buildVSlideHtml(r)).join('') + footer;
        el._mealPhotosBindRowTracks?.();
        el.classList.add('timeline-meal-photos-overlay--wheel');
        const wbShow = el.querySelector('.timeline-meal-photos-wheelbar');
        wbShow?.classList.remove('hidden');
        wbShow?.classList.add('flex');
        rebuildMealPhotoWheelPickers(el);
        el.classList.remove('hidden');
        document.body.classList.add('overflow-hidden');
        el._mealPhotosLayout?.();
        requestAnimationFrame(() => {
            el._mealPhotosLayout?.();
            const slides = vtrack.querySelectorAll('.timeline-meal-photos-vslide');
            const target = slides[startRow];
            if (target) {
                vtrack.scrollTop += scrollDeltaToAlignSlideTop(vtrack, target);
            }
            el._mealPhotosSync?.();
            el._mealPhotosToggleNav?.();
            el._mealPhotosToggleVNav?.();
            requestAnimationFrame(() => {
                syncMealPhotoWheelFromVtrack(el, vtrack);
            });
        });
    } else {
        el.classList.remove('timeline-meal-photos-overlay--wheel');
        const wbLeg = el.querySelector('.timeline-meal-photos-wheelbar');
        wbLeg?.classList.add('hidden');
        wbLeg?.classList.remove('flex');
        el._mealPhotoRows = [{ urls, isLegacy: true }];
        const slide = `<section class="timeline-meal-photos-vslide flex min-h-full w-full shrink-0 snap-start snap-always flex-col overflow-hidden">
            <div class="timeline-meal-photos-vslide-stage relative flex min-h-0 flex-1 flex-col">
                <div class="timeline-meal-photos-track scrollbar-hide flex min-h-0 flex-1 w-full max-w-full min-w-0 snap-x snap-mandatory flex-row overflow-x-auto overflow-y-hidden scroll-smooth" style="-webkit-overflow-scrolling:touch;touch-action:pan-x">${buildHorizontalSlidesLegacyHtml(urls)}</div>
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
            const tr = getActiveHorizontalTrack(vtrack);
            if (tr) tr.scrollLeft = 0;
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
