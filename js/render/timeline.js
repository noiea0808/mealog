// 타임라인 및 미니 캘린더 렌더링
import {
    SLOTS,
    SLOT_STYLES,
    SATIETY_DATA,
    SNACK_TIMELINE_VIEW_STORAGE_KEY,
    MEAL_TIMELINE_VIEW_STORAGE_KEY
} from '../constants.js';
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { formatMealMenuDisplayLine } from '../utils/meal-display-line.js';
import { getRecordCountForIso } from '../meal-record-count.js';
import {
    isMealEntryPendingSync,
    isMealEntrySaveFailed,
    isMealEntryDeleting,
    isMealEntryRowBlocked,
    clearStuckMealPendingFlags
} from '../utils/meal-entry-pending.js';

/** 서버 반영 대기 중 타임라인 행에 쓰는 인라인 스피너(텍스트 줄 높이에 맞춤) */
const MEAL_ROW_SPINNER_HTML =
    '<span class="inline-flex h-[1em] w-[1em] shrink-0 items-center justify-center text-emerald-600 leading-none" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-[0.9em]"></i></span><span class="sr-only">등록 중</span>';

const MEAL_ROW_DELETE_SPINNER_HTML =
    '<span class="inline-flex h-[1em] w-[1em] shrink-0 items-center justify-center text-emerald-600 leading-none" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-[0.9em]"></i></span><span class="sr-only">삭제 중</span>';

const MEAL_ROW_FAIL_HTML =
    '<span class="inline-flex h-[1em] w-[1em] shrink-0 items-center justify-center text-red-600 leading-none" aria-hidden="true"><i class="fa-solid fa-circle-exclamation text-[0.9em]"></i></span><span class="sr-only">등록 실패</span>';

function mealEntryDeletingOverlayHtml() {
    return '<div class="meal-entry-deleting-overlay absolute inset-0 z-20 flex flex-col items-center justify-center rounded-md bg-white/75 backdrop-blur-[1px] pointer-events-none border border-slate-200/80" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-emerald-600 text-xl mb-1"></i><span class="text-xs font-extrabold text-slate-700">삭제 중</span><span class="sr-only">삭제 중</span></div>';
}

function mealEntrySyncLeadHtml(record) {
    if (!record) return '';
    if (isMealEntrySaveFailed(record)) return MEAL_ROW_FAIL_HTML;
    if (isMealEntryDeleting(record)) return MEAL_ROW_DELETE_SPINNER_HTML;
    if (isMealEntryPendingSync(record)) return MEAL_ROW_SPINNER_HTML;
    return '';
}

function mealEntryRowPointerClass(record) {
    if (!record) return 'cursor-pointer active:scale-[0.98]';
    if (isMealEntrySaveFailed(record)) return 'cursor-pointer active:scale-[0.98]';
    if (isMealEntryDeleting(record) || isMealEntryPendingSync(record)) {
        return 'cursor-wait pointer-events-none opacity-[0.93]';
    }
    return 'cursor-pointer active:scale-[0.98]';
}

const MEAL_ROW_POINTER_CLASS_TOKENS = new Set([
    'cursor-pointer',
    'active:scale-[0.98]',
    'cursor-wait',
    'pointer-events-none',
    'opacity-[0.93]'
]);

function stripMealRowPointerClasses(className) {
    return className
        .split(/\s+/)
        .filter((c) => c && !MEAL_ROW_POINTER_CLASS_TOKENS.has(c))
        .join(' ')
        .trim();
}

/** invalidate 후 renderTimeline이 targetDates에 해당 날짜를 넣지 못하면 섹션이 영구히 비어 실패 아이콘이 안 그려질 수 있음 */
const pendingTimelineSectionRebuildDates = new Set();

function patchTimelineCardLeadIcon(el, record) {
    const h4Candidates = [
        el.querySelector('h4.leading-tight.mb-0.flex.items-center'),
        el.querySelector('h4.flex.items-center.min-w-0'),
        el.querySelector('h4.flex.items-center')
    ].filter(Boolean);
    for (const titleEl of h4Candidates) {
        const menuSpan = titleEl.querySelector('span.min-w-0');
        if (!menuSpan) continue;
        titleEl.innerHTML = mealEntrySyncLeadHtml(record) + menuSpan.outerHTML;
        return true;
    }
    const pCandidates = [
        el.querySelector('p.text-sm.font-bold.text-slate-800.leading-snug.mb-0.flex.items-center.min-w-0'),
        el.querySelector('p.text-sm.font-bold.text-slate-800.leading-snug.mb-0.flex.items-center'),
        el.querySelector('p.leading-snug.mb-0.flex.items-center.min-w-0'),
        el.querySelector('p.flex.items-center.min-w-0')
    ].filter(Boolean);
    for (const pLine of pCandidates) {
        const menuSpan = pLine.querySelector('span.min-w-0');
        if (!menuSpan) continue;
        pLine.innerHTML = mealEntrySyncLeadHtml(record) + menuSpan.outerHTML;
        return true;
    }
    return false;
}

function applySnackTagPendingUi(tagEl, record) {
    const deleting = isMealEntryDeleting(record);
    const failed = isMealEntrySaveFailed(record);
    const pending = isMealEntryPendingSync(record);
    tagEl.querySelectorAll(':scope > div.absolute.inset-0').forEach((n) => n.remove());
    let cls = 'snack-tag relative inline-flex items-center gap-0.5 rounded-md ';
    if (deleting) cls += 'cursor-wait pointer-events-none opacity-90';
    else if (failed) cls += 'cursor-pointer active:bg-slate-50 ring-1 ring-red-200/90';
    else if (pending) cls += 'cursor-wait pointer-events-none opacity-90';
    else cls += 'cursor-pointer active:bg-slate-50';
    tagEl.className = cls;
    if (deleting || pending) {
        tagEl.removeAttribute('onclick');
    } else {
        tagEl.setAttribute(
            'onclick',
            `window.openModal(${JSON.stringify(record.date)}, ${JSON.stringify(record.slotId)}, ${JSON.stringify(record.id)})`
        );
    }
    if (failed) {
        tagEl.insertAdjacentHTML(
            'beforeend',
            '<div class="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-red-50/85 pointer-events-none" aria-hidden="true"><i class="fa-solid fa-circle-exclamation text-red-600 text-sm"></i></div>'
        );
    } else if (deleting) {
        tagEl.insertAdjacentHTML(
            'beforeend',
            '<div class="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-md bg-white/75 backdrop-blur-[1px] pointer-events-none border border-slate-200/60" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-emerald-600 text-sm mb-0.5"></i><span class="text-[10px] font-extrabold text-slate-700 leading-none">삭제 중</span></div>'
        );
    } else if (pending) {
        tagEl.insertAdjacentHTML(
            'beforeend',
            '<div class="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-white/65 pointer-events-none" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-emerald-600 text-sm"></i></div>'
        );
    }
}

function syncMealEntryDeletingOverlayOnCard(cardEl, record) {
    if (!cardEl.classList.contains('card')) return;
    const overlay = cardEl.querySelector(':scope > .meal-entry-deleting-overlay');
    if (isMealEntryDeleting(record)) {
        if (!cardEl.classList.contains('relative')) cardEl.classList.add('relative');
        if (!overlay) cardEl.insertAdjacentHTML('beforeend', mealEntryDeletingOverlayHtml());
    } else if (overlay) {
        overlay.remove();
    }
}

function applyCardRowPointerAndClick(rowEl, record) {
    if (!rowEl.classList.contains('card')) return;
    rowEl.className = `${stripMealRowPointerClasses(rowEl.className)} ${mealEntryRowPointerClass(record)}`.replace(/\s+/g, ' ').trim();
    if (isMealEntryRowBlocked(record)) {
        rowEl.removeAttribute('onclick');
    } else {
        rowEl.setAttribute(
            'onclick',
            `window.openModal(${JSON.stringify(record.date)}, ${JSON.stringify(record.slotId)}, ${JSON.stringify(record.id)})`
        );
    }
    syncMealEntryDeletingOverlayOnCard(rowEl, record);
}

/**
 * 이미 DOM에 그려진 날짜 섹션은 renderTimeline이 건너뛰므로, 대기 플래그만 바뀐 경우 스피너·클릭 상태가 남을 수 있음.
 * mealHistory와 동기화해 data-entry-id 행만 갱신한다.
 */
export function updateTimelineMealEntryPendingIndicators() {
    if (!window.currentUser) return;
    /* 탭이 타임라인이 아니어도 DOM이 남아 있으면 갱신(저장 실패 직후 다른 탭에 있을 때 스피너·실패 아이콘 동기화) */
    if (window.currentSearchQuery && window.currentSearchQuery.trim()) return;
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    clearStuckMealPendingFlags();

    container.querySelectorAll('[data-entry-id]').forEach((el) => {
        const entryId = el.getAttribute('data-entry-id');
        if (!entryId) return;
        const record = window.mealHistory?.find((m) => m && String(m.id) === String(entryId));
        if (!record) return;

        if (el.classList.contains('snack-tag')) {
            applySnackTagPendingUi(el, record);
            return;
        }

        patchTimelineCardLeadIcon(el, record);

        if (el.classList.contains('card')) {
            applyCardRowPointerAndClick(el, record);
        }
    });
}

/** false면 타임라인 첫 날짜 헤더의 간식보기(태그/카드) 전환 UI를 숨김 */
const SNACK_TIMELINE_VIEW_TOGGLE_VISIBLE = true;

/** true면 간식은 항상 태그 행으로만 표시 (localStorage의 카드 설정 무시) */
const SNACK_TIMELINE_FORCE_TAGS_MODE = false;

// entryId가 실제로 공유되었는지 확인하는 헬퍼 함수
// record: meal 문서 (sharedPhotos 필드 있음). sharedPhotos 컬렉션과 meal 문서가 불일치할 수 있어 둘 다 확인
function isEntryShared(entryId, record) {
    if (!entryId) return false;
    // 1) meal 문서에 sharedPhotos가 있으면 공유됨 (상세보기와 일치)
    if (record && record.sharedPhotos && Array.isArray(record.sharedPhotos) && record.sharedPhotos.length > 0) {
        return true;
    }
    // 2) sharedPhotos 컬렉션(모먼트 피드)에 entryId가 있으면 공유됨
    if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        return window.sharedPhotos.some(photo => photo.entryId === entryId);
    }
    return false;
}

function getSnackTimelineView() {
    if (SNACK_TIMELINE_FORCE_TAGS_MODE) return 'tags';
    try {
        const v = localStorage.getItem(SNACK_TIMELINE_VIEW_STORAGE_KEY);
        if (v === 'cards' || v === 'tags' || v === 'list') return v;
    } catch (_) {}
    return 'tags';
}

function getMealTimelineView() {
    try {
        const v = localStorage.getItem(MEAL_TIMELINE_VIEW_STORAGE_KEY);
        if (v === 'cards' || v === 'list') return v;
    } catch (_) {}
    return 'cards';
}

/** 같은 날·같은 간식 슬롯: 기록 시간 오름차순 — 번호 1=먼저 기록, 추가분은 후순(아래·큰 번호) */
function mealRecordTimeSortMs(r) {
    if (!r) return 0;
    const date = typeof r.date === 'string' ? r.date : '';
    let timeStr = typeof r.time === 'string' && r.time.trim() ? r.time.trim() : '12:00:00';
    if (timeStr.length === 5 && /^\d{1,2}:\d{2}$/.test(timeStr)) timeStr = `${timeStr}:00`;
    const ms = Date.parse(`${date}T${timeStr}`);
    if (!Number.isNaN(ms)) return ms;
    const ts = r.timestamp;
    if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts && typeof ts === 'object' && typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts === 'string' || typeof ts === 'number') {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t)) return t;
    }
    return 0;
}

function sortSnackSlotRecordsChronological(records) {
    return [...records].sort((a, b) => {
        const da = mealRecordTimeSortMs(a);
        const db = mealRecordTimeSortMs(b);
        if (da !== db) return da - db;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

/** 타임라인 썸네일: photos 배열·단일 문자열·photoUrl */
function getMealPhotoUrlsForTimeline(r) {
    if (!r) return [];
    if (Array.isArray(r.photos) && r.photos.length > 0) {
        return r.photos.map((u) => String(u || '').trim()).filter(Boolean);
    }
    if (r.photos && !Array.isArray(r.photos)) {
        const s = String(r.photos).trim();
        if (s) return [s];
    }
    if (r.photoUrl && String(r.photoUrl).trim()) {
        return [String(r.photoUrl).trim()];
    }
    return [];
}

/** 좌측 140×140 사진 칸: 첫 장 + 다중 등록 시 우상단 1/n */
function buildTimelinePhotoCellInnerHtml(urls, imgClass = 'object-cover') {
    const first = urls[0];
    if (!first) return '';
    const n = urls.length;
    const badge =
        n > 1
            ? `<span class="absolute top-1 right-1 z-10 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold leading-none pointer-events-none shadow-sm">1/${n}</span>`
            : '';
    return `<span class="relative block w-full h-full"><img src="${escapeHtml(first)}" class="absolute inset-0 w-full h-full ${imgClass}" alt="">${badge}</span>`;
}

function buildMealTimelineViewSelectHtml(current) {
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    return `<div class="flex flex-col items-center gap-0.5 flex-shrink-0">
            <label for="mealTimelineViewSelect" class="text-[10px] font-bold text-slate-500 leading-tight whitespace-nowrap text-center">식사보기</label>
            <select id="mealTimelineViewSelect" class="meal-timeline-view-select text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 max-w-[min(100%,8rem)] shadow-sm" title="식사보기: 카드·목록">
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
            </select>
        </div>`;
}

function buildSnackTimelineViewSelectHtml(current) {
    const tagsSel = current === 'tags' ? ' selected' : '';
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    return `<div class="flex flex-col items-center gap-0.5 flex-shrink-0">
            <label for="snackTimelineViewSelect" class="text-[10px] font-bold text-slate-500 leading-tight whitespace-nowrap text-center">간식보기</label>
            <select id="snackTimelineViewSelect" class="snack-timeline-view-select text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 max-w-[min(100%,10rem)] shadow-sm" title="간식보기: 태그·카드·목록">
                <option value="tags"${tagsSel}>태그</option>
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
            </select>
        </div>`;
}

function getDailyShareButtonHtmlForDate(dateStr) {
    if (appState.viewMode !== 'page') return '';
    const dailyShare =
        window.sharedPhotos && Array.isArray(window.sharedPhotos)
            ? window.sharedPhotos.find(
                  (photo) =>
                      photo.type === 'daily' && photo.date === dateStr && photo.userId === window.currentUser?.uid
              )
            : null;
    const isShared = !!dailyShare;
    return `<button type="button" data-mealog-daily="share" data-mealog-date="${dateStr}" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-slate-800 text-white' : 'text-slate-600'}">
        <i class="fa-solid fa-share text-[12px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
    </button>`;
}

/**
 * 트래커 바로 아래 첫 날짜 헤더: 날짜 오른쪽에 간식 표시 방식 드롭다운 (일간 보기 시 공유 버튼 유지)
 */
export function syncSnackViewDropdown(container) {
    const timeline = container || document.getElementById('timelineContainer');
    if (!timeline) return;
    const sections = Array.from(timeline.querySelectorAll(':scope > [id^="date-"]'));
    sections.forEach((section, index) => {
        const header = section.querySelector('.date-section-header');
        if (!header) return;
        const h3 = header.querySelector('h3');
        if (!h3) return;
        const h3Html = h3.outerHTML;
        const dateStr = section.id.replace(/^date-/, '');
        const dObj = new Date(dateStr + 'T00:00:00');
        const dayOfWeek = dObj.getDay();
        const dayColorClass = dayOfWeek === 0 || dayOfWeek === 6 ? 'text-rose-400' : 'text-slate-800';
        const shareHtml = getDailyShareButtonHtmlForDate(dateStr);

        if (index === 0 && SNACK_TIMELINE_VIEW_TOGGLE_VISIBLE) {
            const snackView = getSnackTimelineView();
            const mealView = getMealTimelineView();
            header.className = `date-section-header text-sm font-black ${dayColorClass} px-4 flex items-center justify-between gap-2 flex-wrap`;
            header.innerHTML = `
                <div class="min-w-0">${h3Html}</div>
                <div class="flex items-center justify-end gap-2 flex-shrink-0 flex-wrap">
                    ${buildMealTimelineViewSelectHtml(mealView)}
                    ${buildSnackTimelineViewSelectHtml(snackView)}
                    ${shareHtml}
                </div>`;
        } else {
            header.className = `date-section-header text-sm font-black ${dayColorClass} px-4 flex items-center justify-between`;
            header.innerHTML = shareHtml ? `${h3Html}<div class="flex-shrink-0">${shareHtml}</div>` : h3Html;
        }
    });
}

function buildSnackTimelineCardHtml(
    dateStr,
    slot,
    r,
    specificStyle,
    cardMbClass = 'mb-1.5',
    ordinal1Based = 1,
    totalInSlot = 1
) {
    const p = r.snackPlace || r.place || '';
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        (m || '').trim() ||
        String(r.menuDetail || r.snackType || '').trim() ||
        (r.category && String(r.category).trim()) ||
        '';
    const showOrdinal = totalInSlot > 1;
    const slotTitleForCard = showOrdinal ? `${slot.label}${ordinal1Based}` : slot.label;
    const safeSlotLabel = escapeHtml(slotTitleForCard);
    const safePlace = escapeHtml(p);
    let titleLine1 = '';
    if (p) {
        titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span> <span class="text-xs font-bold text-slate-400">@ ${safePlace}</span>`;
    } else {
        titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span>`;
    }
    const titleLine2 = escapeHtml(menuLine);
    const tags = [];
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.snackType && String(r.snackType).trim() && !tags.includes(r.snackType)) tags.push(r.snackType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    let tagsHtml = '';
    if (tags.length > 0) {
        tagsHtml = `<div class="mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${t}</span>`)
            .join('')}</div>`;
    }
    let iconHtml = '';
    const snackPhotoUrls = getMealPhotoUrlsForTimeline(r);
    if (snackPhotoUrls.length > 0) {
        iconHtml = buildTimelinePhotoCellInnerHtml(snackPhotoUrls, 'object-cover');
    } else if (r.mealType === 'Skip') {
        iconHtml = `<i class="fa-solid fa-ban text-2xl text-slate-600" aria-hidden="true"></i>`;
    } else {
        iconHtml = `<i class="fa-solid fa-mug-saucer text-2xl text-slate-400" aria-hidden="true"></i>`;
    }
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const blockOpen = isMealEntryRowBlocked(r);
    const openClick = blockOpen
        ? ''
        : `onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, ${JSON.stringify(r.id)})'`;
    const relDel = isMealEntryDeleting(r) ? 'relative' : '';
    return `<div ${openClick} class="card ${cardMbClass} border border-slate-200 ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${relDel}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex">
            <div class="w-[140px] h-[140px] bg-slate-100 border-slate-200 ${specificStyle.iconText} flex-shrink-0 flex items-center justify-center overflow-hidden border-r">
                ${iconHtml}
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center p-4">
                <div class="flex justify-between items-start gap-2">
                    <div class="flex-1 min-w-0 overflow-hidden">
                        <h4 class="leading-tight mb-0 flex items-center gap-1.5 min-w-0">${mealEntrySyncLeadHtml(r)}<span class="min-w-0 truncate">${titleLine1}</span></h4>
                        ${titleLine2 ? `<p class="text-sm text-slate-600 font-bold mt-1.5 mb-0 truncate">${titleLine2}</p>` : ''}
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0 ml-2">
                        <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                        <span class="text-xs font-bold text-yellow-600 bg-yellow-50 border border-yellow-300 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                            <span class="text-[13px]">⭐</span>
                            <span class="text-[12px] font-black">${ratingVal}</span>
                        </span>
                    </div>
                </div>
                ${r.comment ? `<p class="text-xs text-slate-400 mt-1.5 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
                ${tagsHtml}
            </div>
        </div>
        ${isMealEntryDeleting(r) ? mealEntryDeletingOverlayHtml() : ''}
    </div>`;
}

function buildSnackEmptySlotCardHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    /** 행 높이만 본식 카드(140px)의 1/3 — 사진 열 너비는 식사 카드와 동일 140px */
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    return `<div onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, null)' class="card mb-1.5 border border-slate-200 opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
        <div class="flex ${hThird}">
            <div class="w-[140px] min-w-[140px] ${hThird} flex-shrink-0 bg-slate-100 border-slate-200 ${specificStyle.iconText} flex items-center justify-center overflow-hidden border-r">
                <span class="text-3xl font-semibold text-slate-400 leading-none" aria-hidden="true">+</span>
            </div>
            <div class="flex-1 min-w-0 flex items-center px-4 py-0.5">
                <p class="mb-0 truncate text-xs leading-tight">
                    <span class="font-bold ${specificStyle.iconText}">${safeLabel}</span>
                    <span class="text-slate-400 font-normal"> <span class="font-bold">+</span> 기록하기</span>
                </p>
            </div>
        </div>
    </div>`;
}

/** 목록형: 기록 없음 — 좌 슬롯명, 우측 `+ 기록하기` */
function buildSnackListEmptyRowHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    return `<div onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, null)' class="card mb-1.5 border border-slate-200 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
        <div class="flex ${hThird}">
            <div class="w-[140px] min-w-[140px] ${hThird} flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex items-center justify-center overflow-hidden border-r px-2 text-center">
                <span class="text-sm font-bold leading-tight">${safeLabel}</span>
            </div>
            <div class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-4">
                <span class="text-xl font-semibold text-slate-400 leading-none" aria-hidden="true">+</span>
                <span class="text-xs text-slate-400 font-normal">기록하기</span>
            </div>
        </div>
    </div>`;
}

/** 본식 목록형: 기록 없음 */
function buildMainMealListEmptyRowHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    return `<div onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, null)' class="card mb-1.5 border border-slate-200 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
        <div class="flex ${hThird}">
            <div class="w-[140px] min-w-[140px] ${hThird} flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex items-center justify-center overflow-hidden border-r px-2 text-center">
                <span class="text-sm font-bold leading-tight">${safeLabel}</span>
            </div>
            <div class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-4">
                <span class="text-xl font-semibold text-slate-400 leading-none" aria-hidden="true">+</span>
                <span class="text-xs text-slate-400 font-normal">기록하기</span>
            </div>
        </div>
    </div>`;
}

/** 본식 목록형: 기록 있음 — 간식 목록과 동일 레이아웃(좌 슬롯·@장소 / 우 메뉴·코멘트·태그) */
function buildMainMealListFilledRowHtml(dateStr, slot, r, specificStyle, cardMbClass = 'mb-1.5') {
    const p = String(r.place || '').trim();
    const safePlaceLine = escapeHtml(p || '—');
    const safeSlotTitle = escapeHtml(slot.label);
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        r.mealType === 'Skip'
            ? 'Skip'
            : (m || '').trim() || (r.category && String(r.category).trim()) || '';
    const safeMenu = escapeHtml(menuLine);

    const tags = [];
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    let tagsHtml = '';
    if (tags.length > 0) {
        tagsHtml = `<div class="mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${escapeHtml(t)}</span>`)
            .join('')}</div>`;
    }

    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const blockMainList = isMealEntryRowBlocked(r);
    const openClickMainList = blockMainList
        ? ''
        : `onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, ${JSON.stringify(r.id)})'`;
    const relMainList = isMealEntryDeleting(r) ? 'relative' : '';

    return `<div ${openClickMainList} class="card ${cardMbClass} border border-slate-200 ${listLeft} ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${relMainList}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeSlotTitle}</span>
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex-1 min-w-0 relative py-2 pl-3 pr-2">
                <div class="absolute top-2 right-2 z-10 flex flex-row items-center gap-1.5">
                    <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 border border-yellow-300 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                        <span class="text-[13px]">⭐</span>
                        <span class="text-[12px] font-black">${ratingVal}</span>
                    </span>
                </div>
                <div class="min-w-0 pr-[4.25rem]">
                    <p class="text-sm font-bold text-slate-800 leading-snug mb-0 flex items-center gap-1.5 min-w-0 pl-2">${mealEntrySyncLeadHtml(r)}<span class="min-w-0">${safeMenu}</span></p>
                    ${r.comment ? `<p class="text-xs text-slate-400 mt-1.5 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
                    ${tagsHtml}
                </div>
            </div>
        </div>
        ${isMealEntryDeleting(r) ? mealEntryDeletingOverlayHtml() : ''}
    </div>`;
}

/** 목록형: 기록 있음 — 좌: 슬롯(+동일슬롯 다건일 때만 1,2,3) / 줄바꿈 / @ 장소 · 우: 메뉴 → 코멘트(1줄) → 태그, 공유·별점은 우상단 */
function buildSnackListFilledRowHtml(
    dateStr,
    slot,
    r,
    specificStyle,
    cardMbClass = 'mb-1.5',
    ordinal1Based = 1,
    totalInSlot = 1
) {
    const p = String(r.snackPlace || r.place || '').trim();
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        (m || '').trim() ||
        String(r.menuDetail || r.snackType || '').trim() ||
        (r.category && String(r.category).trim()) ||
        '';
    const showOrdinal = totalInSlot > 1;
    const slotTitle = showOrdinal ? `${slot.label}${ordinal1Based}` : slot.label;
    const safeSlotTitle = escapeHtml(slotTitle);
    const safePlaceLine = escapeHtml(p || '—');

    const tags = [];
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.snackType && String(r.snackType).trim() && !tags.includes(r.snackType)) tags.push(r.snackType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    let tagsHtml = '';
    if (tags.length > 0) {
        tagsHtml = `<div class="mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${escapeHtml(t)}</span>`)
            .join('')}</div>`;
    }

    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const safeMenu = escapeHtml(menuLine || '간식');
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const pendingSnackList = isMealEntryRowBlocked(r);
    const openClickSnackList = pendingSnackList
        ? ''
        : `onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, ${JSON.stringify(r.id)})'`;
    const relSnackList = isMealEntryDeleting(r) ? 'relative' : '';

    return `<div ${openClickSnackList} class="card ${cardMbClass} border border-slate-200 ${listLeft} ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${relSnackList}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeSlotTitle}</span>
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex-1 min-w-0 relative py-2 pl-3 pr-2">
                <div class="absolute top-2 right-2 z-10 flex flex-row items-center gap-1.5">
                    <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 border border-yellow-300 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                        <span class="text-[13px]">⭐</span>
                        <span class="text-[12px] font-black">${ratingVal}</span>
                    </span>
                </div>
                <div class="min-w-0 pr-[4.25rem]">
                    <p class="text-sm font-bold text-slate-800 leading-snug mb-0 flex items-center gap-1.5 min-w-0 pl-2">${mealEntrySyncLeadHtml(r)}<span class="min-w-0">${safeMenu}</span></p>
                    ${r.comment ? `<p class="text-xs text-slate-400 mt-1.5 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
                    ${tagsHtml}
                </div>
            </div>
        </div>
        ${isMealEntryDeleting(r) ? mealEntryDeletingOverlayHtml() : ''}
    </div>`;
}

function refreshTimelineAfterSnackViewChange() {
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    container.querySelectorAll(':scope > [id^="date-"]').forEach((el) => el.remove());
    const dc = document.getElementById('dailyCommentSection');
    if (dc) dc.remove();
    const lm = document.getElementById('loadMoreMealsBtn');
    if (lm) lm.remove();
    window.loadedDates = [];
    renderTimeline();
}

let timelineViewSelectDelegationBound = false;
function ensureTimelineViewSelectDelegation() {
    if (timelineViewSelectDelegationBound) return;
    timelineViewSelectDelegationBound = true;
    document.addEventListener(
        'change',
        (e) => {
            const t = e.target;
            if (!t || !t.classList) return;
            if (t.classList.contains('snack-timeline-view-select')) {
                try {
                    localStorage.setItem(SNACK_TIMELINE_VIEW_STORAGE_KEY, t.value);
                } catch (_) {}
                refreshTimelineAfterSnackViewChange();
                return;
            }
            if (t.classList.contains('meal-timeline-view-select')) {
                try {
                    localStorage.setItem(MEAL_TIMELINE_VIEW_STORAGE_KEY, t.value);
                } catch (_) {}
                refreshTimelineAfterSnackViewChange();
            }
        },
        true
    );
}

/**
 * 해당 날짜의 타임라인 섹션을 제거하고 loadedDates에서 빼 다음 renderTimeline에서 다시 그린다.
 * 저장 후 temp_* → 실제 id로 바뀌어도 기존 DOM이 건너뛰기되어 스피너가 영구 표시되는 문제를 막는다.
 * @param {string} dateStr YYYY-MM-DD
 */
export function invalidateTimelineDateSection(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
    pendingTimelineSectionRebuildDates.add(dateStr);
    const el = document.getElementById(`date-${dateStr}`);
    if (el?.parentNode) el.remove();
    if (window.loadedDates && Array.isArray(window.loadedDates)) {
        const idx = window.loadedDates.indexOf(dateStr);
        if (idx >= 0) window.loadedDates.splice(idx, 1);
    }
}

/** 타임라인에서 공유 화살표만 즉시 갱신 (기존 DOM만 업데이트, 풀 렌더 없음) */
export function updateTimelineShareIndicators() {
    const state = appState;
    if (!window.currentUser || state.currentTab !== 'timeline') return;
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    container.querySelectorAll('[data-entry-id]').forEach(el => {
        const entryId = el.getAttribute('data-entry-id');
        const record = window.mealHistory?.find(m => m.id === entryId);
        const arrow = el.querySelector('.timeline-share-arrow');
        if (arrow) {
            arrow.style.display = isEntryShared(entryId, record) ? 'inline' : 'none';
        }
    });
}

export function renderTimeline() {
    const state = appState;
    if (!window.currentUser || state.currentTab !== 'timeline') return;
    /* 검색 모드일 때는 타임라인 렌더하지 않음 (검색 결과만 표시) */
    if (window.currentSearchQuery && window.currentSearchQuery.trim()) return;
    clearStuckMealPendingFlags();
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    
    // mealHistory가 없으면 빈 배열로 초기화
    if (!window.mealHistory || !Array.isArray(window.mealHistory)) {
        window.mealHistory = [];
    }
    
    // 오늘 날짜를 명확하게 계산 (시간대 문제 방지)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // 로컬 날짜로 변환하여 시간대 문제 방지
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    const targetDates = [];
    if (state.viewMode === 'list') {
        // 초기 로드 시 오늘 날짜를 무조건 첫 번째로 추가
        if (window.loadedDates.length === 0) {
            targetDates.push(todayStr);
        } else if (!window.loadedDates.includes(todayStr)) {
            // 오늘 날짜가 아직 로드되지 않았다면 추가
            targetDates.push(todayStr);
        }
        
        // 이미 로드된 과거 날짜 수를 계산 (오늘 날짜 제외)
        const pastLoadedDates = window.loadedDates.filter(d => d < todayStr);
        const pastLoadedCount = pastLoadedDates.length;
        
        // 과거 날짜를 순차적으로 추가 (어제부터 시작)
        for (let i = 1; i <= 5; i++) {
            const dayOffset = pastLoadedCount + i;
            const d = new Date(today);
            d.setDate(d.getDate() - dayOffset);
            // 로컬 날짜로 변환하여 시간대 문제 방지
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            // 과거 날짜만 추가하고 중복 체크
            if (dateStr < todayStr && !window.loadedDates.includes(dateStr) && !targetDates.includes(dateStr)) {
                targetDates.push(dateStr);
            }
        }
        
    } else {
        // page 모드: 선택한 날짜만 표시 (로컬 날짜로 변환)
        const pageYear = state.pageDate.getFullYear();
        const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
        const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
        targetDates.push(`${pageYear}-${pageMonth}-${pageDay}`);
    }

    // 날짜를 최신순으로 정렬하여 DOM에 추가 (최신 -> 과거)
    let sortedTargetDates = [...targetDates].sort((a, b) => b.localeCompare(a));
    
    // 오늘 날짜가 있으면 항상 맨 앞에 위치하도록 보장
    if (state.viewMode === 'list' && sortedTargetDates.includes(todayStr)) {
        sortedTargetDates = sortedTargetDates.filter(d => d !== todayStr);
        sortedTargetDates.unshift(todayStr);
    } else if (state.viewMode === 'list' && !window.loadedDates.includes(todayStr) && !sortedTargetDates.includes(todayStr)) {
        // 오늘 날짜가 아직 추가되지 않았다면 강제로 맨 앞에 추가
        sortedTargetDates.unshift(todayStr);
    }

    if (pendingTimelineSectionRebuildDates.size > 0) {
        const extra = [...pendingTimelineSectionRebuildDates].filter(
            (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !sortedTargetDates.includes(d)
        );
        if (extra.length) {
            sortedTargetDates = [...sortedTargetDates, ...extra].sort((a, b) => b.localeCompare(a));
            if (state.viewMode === 'list' && sortedTargetDates.includes(todayStr)) {
                sortedTargetDates = sortedTargetDates.filter((d) => d !== todayStr);
                sortedTargetDates.unshift(todayStr);
            }
        }
    }

    sortedTargetDates.forEach(dateStr => {
        // 일간보기 모드에서는 기존 섹션이 있어도 공유 버튼만 업데이트
        const existingSection = document.getElementById(`date-${dateStr}`);
        if (existingSection && state.viewMode === 'page') {
            // 헤더(공유·간식 드롭다운)는 renderTimeline 끝에서 syncSnackViewDropdown으로 갱신
            return;
        }
        
        // 이미 로드된 날짜이거나 DOM에 이미 존재하는 경우 건너뛰기
        if (window.loadedDates.includes(dateStr)) return;
        if (existingSection) return;
        
        window.loadedDates.push(dateStr);
        const dObj = new Date(dateStr + 'T00:00:00');
        const dayOfWeek = dObj.getDay();
        let dayColorClass = (dayOfWeek === 0 || dayOfWeek === 6) ? "text-rose-400" : "text-slate-800";
        const section = document.createElement('div');
        section.id = `date-${dateStr}`;
        section.className = "animate-fade";
        // 일간보기 모드일 때만 공유 버튼 추가
        let shareButton = '';
        if (state.viewMode === 'page') {
            // 공유 상태 확인 (본인 것만 확인)
            const dailyShare = window.sharedPhotos && Array.isArray(window.sharedPhotos) 
                ? window.sharedPhotos.find(photo => 
                    photo.type === 'daily' && 
                    photo.date === dateStr && 
                    photo.userId === window.currentUser?.uid
                )
                : null;
            const isShared = !!dailyShare;
            
            shareButton = `<button type="button" data-mealog-daily="share" data-mealog-date="${dateStr}" class="text-xs font-bold px-3 py-1 active:opacity-70 transition-colors ml-2 rounded-lg ${isShared ? 'bg-slate-800 text-white' : 'text-slate-600'}">
                <i class="fa-solid fa-share text-[12px] mr-1"></i>${isShared ? '공유됨' : '공유하기'}
            </button>`;
        }
        let html = `<div class="date-section-header text-sm font-black ${dayColorClass} px-4 flex items-center justify-between">
            <h3>${dObj.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })}</h3>
            ${shareButton}
        </div>`;

        SLOTS.forEach(slot => {
            const recordsRaw = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
            const records = slot.type === 'snack' ? sortSnackSlotRecordsChronological(recordsRaw) : recordsRaw;
            if (slot.type === 'main') {
                const r = records[0];
                const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                const mealView = getMealTimelineView();
                if (mealView === 'list') {
                    if (r) {
                        html += buildMainMealListFilledRowHtml(dateStr, slot, r, specificStyle, 'mb-1.5');
                    } else {
                        html += buildMainMealListEmptyRowHtml(dateStr, slot, specificStyle);
                    }
                } else {
                let containerClass = r ? 'border-slate-200' : 'border-slate-200 opacity-80';
                let titleClass = r ? 'text-slate-800' : 'text-slate-300';
                let iconBoxClass = `bg-slate-100 border-slate-200 ${specificStyle.iconText}`;
                const safeSlotLabel = escapeHtml(slot.label);
                let titleLine1 = '';
                let titleLine2 = '';
                let tagsHtml = '';
                if (r) {
                    if (r.mealType === 'Skip') {
                        titleLine1 = 'Skip';
                    } else {
                        const p = r.place || '';
                        const m = formatMealMenuDisplayLine(r);
                        // 첫 번째 줄: "아침 @ 장소" 형식 (아침/점심/저녁 텍스트 색상 적용, @부터 회색)
                        const safePlace = escapeHtml(p);
                        if (p) {
                            titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span> <span class="text-xs font-bold text-slate-400">@ ${safePlace}</span>`;
                        } else {
                            titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span>`;
                        }
                        // 두 번째 줄: 메뉴 (본식 카테고리만 있을 때도 한 줄 표시)
                        const menuLine = (m || '').trim() || (r.category && String(r.category).trim()) || '';
                        titleLine2 = escapeHtml(menuLine);
                        const tags = [];
                        if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
                        if (r.withWhomDetail) tags.push(r.withWhomDetail);
                        else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
                        if (r.satiety) {
                            const sData = SATIETY_DATA.find(d => d.val === r.satiety);
                            if (sData) tags.push(sData.label);
                        }
                        if (tags.length > 0) {
                            tagsHtml = `<div class="mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags.map(t => 
                                `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${t}</span>`
                            ).join('')}</div>`;
                        }
                    }
                } else {
                    // 기록되지 않은 카드에도 끼니 표시
                    titleLine1 = `<span class="text-sm font-bold ${specificStyle.iconText}">${safeSlotLabel}</span>`;
                    titleLine2 = '<span class="text-xs text-slate-400"><span class="font-bold">+</span> 기록하기</span>';
                }
                let iconHtml = '';
                if (!r) {
                    iconHtml = `<div class="flex flex-col items-center justify-center text-center px-2">
                        <span class="text-3xl font-bold text-slate-400 mb-1">+</span>
                        <span class="text-[10px] text-slate-400 leading-tight">입력해주세요</span>
                    </div>`;
                } else {
                    const mainPhotoUrls = getMealPhotoUrlsForTimeline(r);
                    if (mainPhotoUrls.length > 0) {
                        iconHtml = buildTimelinePhotoCellInnerHtml(mainPhotoUrls, 'object-cover');
                    } else if (r.mealType === 'Skip') {
                        iconHtml = `<i class="fa-solid fa-ban text-2xl text-slate-600"></i>`;
                    } else {
                        iconHtml = `<i class="fa-solid fa-utensils text-2xl text-slate-400"></i>`;
                    }
                }
                const mainBlockOpen = r && isMealEntryRowBlocked(r);
                const mainOpenClick = mainBlockOpen
                    ? ''
                    : `onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, ${r ? JSON.stringify(r.id) : 'null'})'`;
                const mainPointer = !r ? 'cursor-pointer active:scale-[0.98]' : mealEntryRowPointerClass(r);
                const mainRelDel = r && isMealEntryDeleting(r) ? 'relative' : '';
                html += `<div ${mainOpenClick} class="card mb-1.5 border ${containerClass} ${mainPointer} transition-all !rounded-none ${mainRelDel}" ${r ? `data-entry-id="${escapeHtml(String(r.id))}"` : ''}>
                    <div class="flex">
                        <div class="w-[140px] h-[140px] ${iconBoxClass} flex-shrink-0 flex items-center justify-center overflow-hidden border-r">
                            ${iconHtml}
                        </div>
                        <div class="flex-1 min-w-0 flex flex-col justify-center p-4">
                            <div class="flex justify-between items-start gap-2">
                                <div class="flex-1 min-w-0 overflow-hidden">
                                    <h4 class="leading-tight mb-0 flex items-center gap-1.5 min-w-0">${r ? mealEntrySyncLeadHtml(r) : ''}<span class="min-w-0 truncate">${titleLine1}</span></h4>
                                    ${titleLine2 ? (r ? `<p class="text-sm text-slate-600 font-bold mt-1.5 mb-0 truncate">${titleLine2}</p>` : `<p class="mt-1.5 mb-0 truncate">${titleLine2}</p>`) : ''}
                                </div>
                                ${r ? `<div class="flex items-center gap-2 flex-shrink-0 ml-2">
                                    <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                                    <span class="text-xs font-bold text-yellow-600 bg-yellow-50 border border-yellow-300 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                                        <span class="text-[13px]">⭐</span>
                                        <span class="text-[12px] font-black">${r.rating || '-'}</span>
                                    </span>
                                </div>` : ''}
                            </div>
                            ${r && r.comment ? `<p class="text-xs text-slate-400 mt-1.5 mb-0 line-clamp-1 whitespace-pre-line">"${escapeHtml(r.comment).replace(/\n/g, '<br>')}"</p>` : ''}
                            ${tagsHtml}
                        </div>
                    </div>
                    ${r && isMealEntryDeleting(r) ? mealEntryDeletingOverlayHtml() : ''}
                </div>`;
                }
            } else {
                const snackView = getSnackTimelineView();
                const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                if (snackView === 'cards') {
                    if (records.length > 0) {
                        html += `<div class="snack-slot-card-group">`;
                        records.forEach((r, idx) => {
                            const isLast = idx === records.length - 1;
                            const cardHtml = buildSnackTimelineCardHtml(
                                dateStr,
                                slot,
                                r,
                                specificStyle,
                                isLast ? 'mb-0' : 'mb-1.5',
                                idx + 1,
                                records.length
                            );
                            if (isLast) {
                                html += `<div class="relative mb-1.5">
                                ${cardHtml}
                                <button type="button" onclick='event.stopPropagation(); window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)})' class="absolute bottom-2 right-2 z-10 text-xs font-bold text-slate-600 bg-white/95 backdrop-blur-sm px-2 py-0.5 rounded-lg border border-slate-200 active:scale-95 transition-transform" aria-label="${escapeHtml(slot.label)} 추가">+ 추가</button>
                            </div>`;
                            } else {
                                html += cardHtml;
                            }
                        });
                        html += `</div>`;
                    } else {
                        html += buildSnackEmptySlotCardHtml(dateStr, slot, specificStyle);
                    }
                } else if (snackView === 'list') {
                    if (records.length > 0) {
                        html += `<div class="snack-slot-list-group">`;
                        records.forEach((r, idx) => {
                            const isLast = idx === records.length - 1;
                            const rowHtml = buildSnackListFilledRowHtml(
                                dateStr,
                                slot,
                                r,
                                specificStyle,
                                isLast ? 'mb-0' : 'mb-1.5',
                                idx + 1,
                                records.length
                            );
                            if (isLast) {
                                html += `<div class="relative mb-1.5">
                                    ${rowHtml}
                                    <button type="button" onclick='event.stopPropagation(); window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)})' class="absolute bottom-2 right-2 z-10 text-xs font-bold text-slate-600 bg-white/95 backdrop-blur-sm px-2 py-0.5 rounded-lg border border-slate-200 active:scale-95 transition-transform" aria-label="${escapeHtml(slot.label)} 추가">+ 추가</button>
                                </div>`;
                            } else {
                                html += rowHtml;
                            }
                        });
                        html += `</div>`;
                    } else {
                        html += buildSnackListEmptyRowHtml(dateStr, slot, specificStyle);
                    }
                } else {
                    html += `<div class="snack-row mb-1.5 flex items-center">
                    <span class="text-xs font-black text-slate-400 uppercase mr-3 flex-shrink-0 px-4">${slot.label}</span>
                    <div class="flex-1 flex flex-wrap gap-2 items-center">
                        ${records.length > 0 ? records.map((r) => {
                            const tagDeleting = isMealEntryDeleting(r);
                            const tagPending = isMealEntryPendingSync(r);
                            const tagFailed = isMealEntrySaveFailed(r);
                            const tagBusy = tagDeleting || tagPending;
                            const tagClick = tagBusy
                                ? ''
                                : `onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)}, ${JSON.stringify(r.id)})'`;
                            const tagCls = tagDeleting
                                ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-wait pointer-events-none opacity-90'
                                : tagPending
                                  ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-wait pointer-events-none opacity-90'
                                  : tagFailed
                                    ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-pointer active:bg-slate-50 ring-1 ring-red-200/90'
                                    : 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-pointer active:bg-slate-50';
                            const tagOverlay = tagFailed
                                ? '<div class="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-red-50/85 pointer-events-none" aria-hidden="true"><i class="fa-solid fa-circle-exclamation text-red-600 text-sm"></i></div>'
                                : tagDeleting
                                  ? '<div class="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-md bg-white/75 backdrop-blur-[1px] pointer-events-none border border-slate-200/60" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-emerald-600 text-sm mb-0.5"></i><span class="text-[10px] font-extrabold text-slate-700 leading-none">삭제 중</span></div>'
                                  : tagPending
                                    ? '<div class="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-white/65 pointer-events-none" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin text-emerald-600 text-sm"></i></div>'
                                    : '';
                            return `<div ${tagClick} class="${tagCls}" data-entry-id="${escapeHtml(String(r.id))}">
                                ${r.menuDetail || r.snackType || '간식'}
                                <span class="timeline-share-arrow" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share text-slate-500 text-[8px] ml-1" title="게시됨"></i></span>
                                ${r.rating ? `<span class="text-[10px] font-black text-yellow-600 bg-yellow-50 border border-yellow-300 px-1 py-0.5 rounded-full ml-1.5 flex items-center gap-0.5">
                                    <span class="text-[11px]">⭐</span>
                                    <span class="text-[11px] font-black">${r.rating}</span>
                                </span>` : ''}
                                ${tagOverlay}
                            </div>`;
                        }).join('') : `<span class="text-xs text-slate-400 italic">기록없음</span>`}
                        <button onclick='window.openModal(${JSON.stringify(dateStr)}, ${JSON.stringify(slot.id)})' class="text-xs font-bold text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200 transition-colors">+ 추가</button>
                    </div>
                </div>`;
                }
            }
        });
        section.innerHTML = html;
        container.appendChild(section);
        pendingTimelineSectionRebuildDates.delete(dateStr);
    });
    
    // 일간보기 모드일 때 하루 전체 Comment 입력 영역 추가
    if (state.viewMode === 'page' && sortedTargetDates.length > 0) {
        const currentDateStr = sortedTargetDates[0]; // 일간보기는 하나의 날짜만 표시
        const existingCommentSection = document.getElementById('dailyCommentSection');
        if (existingCommentSection) {
            existingCommentSection.remove();
        }
        
        const commentSection = document.createElement('div');
        commentSection.id = 'dailyCommentSection';
        commentSection.className = 'card mb-1.5 border border-slate-200 !rounded-none';
        
        // getDailyComment 함수가 있으면 사용, 없으면 빈 문자열
        let currentComment = '';
        try {
            if (window.dbOps && typeof window.dbOps.getDailyComment === 'function') {
                currentComment = window.dbOps.getDailyComment(currentDateStr) || '';
            } else if (window.userSettings && window.userSettings.dailyComments) {
                currentComment = window.userSettings.dailyComments[currentDateStr] || '';
            }
        } catch (e) {
            console.warn('getDailyComment 호출 실패:', e);
            currentComment = '';
        }
        
        commentSection.innerHTML = `
            <div class="p-4">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-extrabold text-slate-600 block uppercase">하루 소감</span>
                    <button type="button" data-mealog-daily="save-comment" data-mealog-date="${currentDateStr}" 
                        class="text-xs text-slate-600 font-bold px-3 py-1.5 active:text-slate-700 transition-colors">
                        저장
                    </button>
                </div>
                <textarea id="dailyCommentInput" placeholder="오늘 하루는 어떠셨나요? 하루 전체에 대한 생각을 기록해보세요." 
                    class="w-full p-3 bg-slate-50 rounded-2xl text-sm border border-transparent focus:border-slate-400 transition-all resize-none min-h-[100px]" 
                    rows="4">${escapeHtml(currentComment)}</textarea>
            </div>
        `;
        
        container.appendChild(commentSection);
    } else {
        // 일간보기가 아닐 때는 Comment 영역 제거
        const existingCommentSection = document.getElementById('dailyCommentSection');
        if (existingCommentSection) {
            existingCommentSection.remove();
        }
    }
    
    // 최근 날짜(오늘)로 스크롤 (초기 로드 시에만)
    if (state.viewMode === 'list' && sortedTargetDates.length > 0 && !window.hasScrolledToToday) {
        const todaySection = document.getElementById(`date-${todayStr}`);
        if (todaySection) {
            setTimeout(() => {
                const trackerSection = document.getElementById('trackerSection');
                const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                const headerHeight = 73;
                const totalOffset = headerHeight + trackerHeight;
                const elementTop = todaySection.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementTop - totalOffset - 16;
                window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                window.hasScrolledToToday = true;
            }, 300);
        }
    }
    
    // 더보기 버튼 추가 (list 모드일 때만)
    if (state.viewMode === 'list' && window.loadedMealsDateRange) {
        // 가장 오래된 날짜 확인
        const oldestDate = window.mealHistory.length > 0 
            ? window.mealHistory[window.mealHistory.length - 1]?.date 
            : null;
        
        // 로드된 범위의 시작 날짜보다 오래된 데이터가 있으면 더보기 버튼 표시
        if (oldestDate && oldestDate >= window.loadedMealsDateRange.start) {
            // 더보기 버튼이 이미 있으면 제거
            const existingBtn = document.getElementById('loadMoreMealsBtn');
            if (existingBtn) existingBtn.remove();
            
            const loadMoreBtn = document.createElement('div');
            loadMoreBtn.id = 'loadMoreMealsBtn';
            loadMoreBtn.className = 'flex justify-center py-6';
            loadMoreBtn.innerHTML = `
                <button onclick="window.loadMoreMealsTimeline()" 
                        class="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl text-sm font-bold 
                               active:bg-slate-300 transition-colors flex items-center gap-2">
                    <i class="fa-solid fa-chevron-down"></i>
                    <span>더보기</span>
                </button>
            `;
            container.appendChild(loadMoreBtn);
        } else {
            // 더 이상 로드할 데이터가 없으면 버튼 제거
            const existingBtn = document.getElementById('loadMoreMealsBtn');
            if (existingBtn) existingBtn.remove();
        }
    }

    ensureTimelineViewSelectDelegation();
    syncSnackViewDropdown(container);

    if (typeof window.bindMealogDailyTimelineDelegation === 'function') {
        window.bindMealogDailyTimelineDelegation();
    }

    updateTimelineMealEntryPendingIndicators();
}

let miniCalendarPointerDragBound = false;
let miniCalendarScrollTitleBound = false;
let trackerMonthTitleRaf = null;
let trackerMonthCalendarModalBound = false;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function daysInMonth(year, month1to12) {
    return new Date(year, month1to12, 0).getDate();
}

let trackerMonthPopupYear = null;
let trackerMonthPopupMonth = null;

function closeTrackerMonthCalendar() {
    const modal = document.getElementById('trackerMonthCalendarModal');
    if (modal) modal.classList.add('hidden');
}

function renderTrackerMonthCalendarPopup() {
    const grid = document.getElementById('trackerMonthCalendarGrid');
    const heading = document.getElementById('trackerMonthCalendarHeading');
    if (!grid || !heading || trackerMonthPopupYear == null || trackerMonthPopupMonth == null) return;

    const y = trackerMonthPopupYear;
    const m = trackerMonthPopupMonth;
    heading.textContent = `${y}년 ${m}월`;

    const firstDow = new Date(y, m - 1, 1).getDay();
    const dim = daysInMonth(y, m);

    const pageY = appState.pageDate.getFullYear();
    const pageM = appState.pageDate.getMonth() + 1;
    const pageD = appState.pageDate.getDate();
    const activeIso = `${pageY}-${pad2(pageM)}-${pad2(pageD)}`;

    const parts = [];
    for (let i = 0; i < firstDow; i++) {
        parts.push('<div class="tracker-month-cell tracker-month-cell--empty" aria-hidden="true"></div>');
    }
    for (let d = 1; d <= dim; d++) {
        const iso = `${y}-${pad2(m)}-${pad2(d)}`;
        const c = getRecordCountForIso(iso);
        const st = c >= 3 ? 'dot-full' : c > 0 ? 'dot-partial' : 'dot-none';
        const sel = iso === activeIso ? 'dot-selected' : '';
        parts.push(
            `<button type="button" class="tracker-month-cell" data-tracker-popup-iso="${iso}" aria-label="${y}년 ${m}월 ${d}일">` +
                `<div class="calendar-dot tracker-month-dot ${st} ${sel}">${d}</div>` +
                `</button>`
        );
    }
    grid.innerHTML = parts.join('');
    grid.querySelectorAll('[data-tracker-popup-iso]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const iso = btn.getAttribute('data-tracker-popup-iso');
            if (iso && typeof window.jumpToDate === 'function') window.jumpToDate(iso);
            closeTrackerMonthCalendar();
        });
    });
}

export function openTrackerMonthCalendar() {
    if (!window.currentUser) return;
    const d = appState.pageDate;
    trackerMonthPopupYear = d.getFullYear();
    trackerMonthPopupMonth = d.getMonth() + 1;
    const modal = document.getElementById('trackerMonthCalendarModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    renderTrackerMonthCalendarPopup();
}

export function refreshTrackerMonthCalendarPopupIfOpen() {
    const modal = document.getElementById('trackerMonthCalendarModal');
    if (!modal || modal.classList.contains('hidden')) return;
    renderTrackerMonthCalendarPopup();
}

function setupTrackerMonthCalendarModal() {
    if (trackerMonthCalendarModalBound) return;
    trackerMonthCalendarModalBound = true;

    const backdrop = document.getElementById('trackerMonthCalendarBackdrop');
    const closeBtn = document.getElementById('trackerMonthCalendarClose');
    const prevBtn = document.getElementById('trackerMonthPrevMonth');
    const nextBtn = document.getElementById('trackerMonthNextMonth');
    const openBtn = document.getElementById('trackerMonthCalendarBtn');

    const goPrev = () => {
        if (trackerMonthPopupYear == null || trackerMonthPopupMonth == null) return;
        let y = trackerMonthPopupYear;
        let mo = trackerMonthPopupMonth - 1;
        if (mo < 1) {
            mo = 12;
            y -= 1;
        }
        trackerMonthPopupYear = y;
        trackerMonthPopupMonth = mo;
        renderTrackerMonthCalendarPopup();
    };
    const goNext = () => {
        if (trackerMonthPopupYear == null || trackerMonthPopupMonth == null) return;
        let y = trackerMonthPopupYear;
        let mo = trackerMonthPopupMonth + 1;
        if (mo > 12) {
            mo = 1;
            y += 1;
        }
        trackerMonthPopupYear = y;
        trackerMonthPopupMonth = mo;
        renderTrackerMonthCalendarPopup();
    };

    if (backdrop) backdrop.addEventListener('click', closeTrackerMonthCalendar);
    if (closeBtn) closeBtn.addEventListener('click', closeTrackerMonthCalendar);
    if (prevBtn) prevBtn.addEventListener('click', goPrev);
    if (nextBtn) nextBtn.addEventListener('click', goNext);
    if (openBtn) {
        openBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openTrackerMonthCalendar();
        });
    }
}

/** 보이는 트래커 날짜들의 월 → 제목 문자열 (한 달 / 두 달 / 여러 달) */
function formatTrackerMonthLabel(months) {
    if (!months.length) {
        const d = appState.pageDate;
        return `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
    }
    if (months.length === 1) {
        const { year, month } = months[0];
        return `${year}년 ${month}월`;
    }
    if (months.length === 2) {
        const a = months[0];
        const b = months[1];
        if (a.year === b.year) {
            return `${a.year}년 ${a.month}월/${b.month}월`;
        }
        return `${a.year}년 ${a.month}월/${b.year}년 ${b.month}월`;
    }
    const first = months[0];
    const last = months[months.length - 1];
    if (first.year === last.year) {
        return `${first.year}년 ${months.map((m) => `${m.month}월`).join('/')}`;
    }
    return months.map((m) => `${m.year}년 ${m.month}월`).join('/');
}

/**
 * 트래커 가로 스크롤에 맞춰 상단 월 표시 갱신 (가시 영역에 걸친 날짜의 월 기준)
 */
export function updateTrackerMonthTitle(container) {
    const el = container || document.getElementById('miniCalendar');
    const titleEl = document.getElementById('trackerTitle');
    if (!el || !titleEl) return;

    const cRect = el.getBoundingClientRect();
    const items = el.querySelectorAll('.calendar-item[data-tracker-date]');
    const seen = new Set();
    const months = [];

    items.forEach((item) => {
        const r = item.getBoundingClientRect();
        if (r.right <= cRect.left || r.left >= cRect.right) return;
        const iso = item.getAttribute('data-tracker-date');
        if (!iso) return;
        const parts = iso.split('-').map(Number);
        const y = parts[0];
        const m = parts[1];
        const key = `${y}-${m}`;
        if (seen.has(key)) return;
        seen.add(key);
        months.push({ year: y, month: m });
    });

    months.sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));
    titleEl.textContent = formatTrackerMonthLabel(months);
}

function scheduleTrackerMonthTitleUpdate(container) {
    if (trackerMonthTitleRaf != null) return;
    trackerMonthTitleRaf = requestAnimationFrame(() => {
        trackerMonthTitleRaf = null;
        updateTrackerMonthTitle(container);
    });
}

function setupMiniCalendarScrollTitle(container) {
    if (miniCalendarScrollTitleBound) return;
    miniCalendarScrollTitleBound = true;

    const onScrollOrResize = () => {
        const c = document.getElementById('miniCalendar');
        if (c) scheduleTrackerMonthTitleUpdate(c);
    };

    container.addEventListener('scroll', onScrollOrResize, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(onScrollOrResize);
        ro.observe(container);
    }
    window.addEventListener('resize', onScrollOrResize, { passive: true });
    container.addEventListener('scrollend', onScrollOrResize, { passive: true });
}

/** 웹: 마우스/펜으로 트래커(가로 스크롤) 드래그 — 터치는 네이티브 가로 스크롤 유지 */
function setupMiniCalendarPointerDrag(container) {
    if (miniCalendarPointerDragBound) return;
    miniCalendarPointerDragBound = true;
    /** 이 이상 움직여야 가로 스크롤(드래그)으로 간주 — 너무 낮으면 클릭이 미세 떨림에 막힘 */
    const DRAG_THRESHOLD = 10;
    /** pointerup 시 이 이상 이동했거나 스크롤이 바뀌었을 때만 날짜 클릭 취소 */
    const CLICK_CANCEL_MOVE_PX = 14;
    const CLICK_CANCEL_SCROLL_PX = 2;
    let startX = 0;
    let startScrollLeft = 0;
    let active = false;
    let activePointerId = null;
    let suppressClick = false;

    container.addEventListener(
        'pointerdown',
        (e) => {
            if (e.pointerType === 'touch') return;
            if (e.button !== 0) return;
            active = true;
            activePointerId = e.pointerId;
            suppressClick = false;
            startX = e.clientX;
            startScrollLeft = container.scrollLeft;
            try {
                container.setPointerCapture(e.pointerId);
            } catch (_) {}
            container.classList.add('calendar-scroll-dragging');
        },
        { passive: true }
    );

    container.addEventListener('pointermove', (e) => {
        if (!active || e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > DRAG_THRESHOLD) {
            container.scrollLeft = startScrollLeft - dx;
        }
    });

    const end = (e) => {
        if (!active || e.pointerId !== activePointerId) return;
        const totalMove = Math.abs(e.clientX - startX);
        const scrollDelta = Math.abs(container.scrollLeft - startScrollLeft);
        suppressClick =
            totalMove > CLICK_CANCEL_MOVE_PX || scrollDelta > CLICK_CANCEL_SCROLL_PX;
        active = false;
        activePointerId = null;
        container.classList.remove('calendar-scroll-dragging');
        try {
            container.releasePointerCapture(e.pointerId);
        } catch (_) {}
    };

    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);

    container.addEventListener(
        'click',
        (e) => {
            if (suppressClick) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                suppressClick = false;
            }
        },
        true
    );
}

export function renderMiniCalendar() {
    const state = appState;
    const container = document.getElementById('miniCalendar');
    if (!container || !window.currentUser) return;
    container.innerHTML = "";
    // 로컬 날짜로 변환하여 시간대 문제 방지
    const pageYear = state.pageDate.getFullYear();
    const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
    const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
    const activeStr = `${pageYear}-${pageMonth}-${pageDay}`;
    
    for (let i = 60; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        // 로컬 날짜로 변환하여 시간대 문제 방지
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const iso = `${year}-${month}-${day}`;
        const count = getRecordCountForIso(iso);
        let status = count >= 3 ? "dot-full" : (count > 0 ? "dot-partial" : "dot-none");
        let dayColorClass = (d.getDay() === 0 || d.getDay() === 6) ? "text-rose-400" : "text-slate-400";
        const item = document.createElement('div');
        item.className = "calendar-item flex flex-col items-center gap-1 flex-shrink-0";
        item.setAttribute('data-tracker-date', iso);
        item.innerHTML = `<span class="text-[11px] font-bold ${dayColorClass}">${d.toLocaleDateString('ko-KR', { weekday: 'narrow' })}</span>
            <div id="dot-${iso}" class="calendar-dot ${status} ${iso === activeStr ? 'dot-selected' : ''}">${d.getDate()}</div>`;
        item.onclick = () => window.jumpToDate(iso);
        container.appendChild(item);
    }

    setupMiniCalendarPointerDrag(container);
    setupMiniCalendarScrollTitle(container);
    setupTrackerMonthCalendarModal();

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateTrackerMonthTitle(container);
        });
    });

    setTimeout(() => {
        const activeDot = document.getElementById(`dot-${activeStr}`);
        if (activeDot) activeDot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        updateTrackerMonthTitle(container);
    }, 100);

    refreshTrackerMonthCalendarPopupIfOpen();
}
