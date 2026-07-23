// 타임라인 및 미니 캘린더 렌더링
import {
    SLOTS,
    SLOT_STYLES,
    DAILY_JOURNAL_SLOT,
    DAILY_JOURNAL_SLOT_STYLE,
    SATIETY_DATA,
    SNACK_TIMELINE_VIEW_STORAGE_KEY,
    MEAL_TIMELINE_VIEW_STORAGE_KEY,
    getSlotLucideIcon
} from '../constants.js';
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { getThumbImageUrl, getDisplayImageUrl, imgFallbackAttrs } from '../utils/image-variants.js';
import { formatMealMenuDisplayLine } from '../utils/meal-display-line.js';
import { getRecordCountForIso, buildMealHistoryCountByDate } from '../meal-record-count.js';
import {
    getMealRowSyncLeadKind,
    isMealEntryPendingSync,
    isMealEntrySaveFailed,
    isMealEntrySyncAbandoned,
    isMealEntrySyncRedoable,
    isMealEntryDeleting,
    isMealEntryDeleteFailed,
    isMealEntryRowBlocked,
    clearStuckMealPendingFlags
} from '../utils/meal-entry-pending.js';
import { refreshMealSyncResendNavButton } from '../main/meal-sync-resend-header.js';
import { isMealogTransportOffline } from '../utils/mealog-offline-ui.js';
import { updateTrackerStreakLabel } from '../attendance-check.js';
import { mealClockTagLabelFromRecord, normalizeMealClockInputValue } from '../meal-time-utils.js';
import {
    getDailyJournalFromSettings,
    dailyJournalHasContent,
    dailyJournalHasPhotos,
    dailyJournalHasPendingPhotoUpload,
    dailyJournalSlotFallbackLine,
    getDailyJournalShareEntryId,
    isDailyJournalShared,
    isDailyJournalMealRecord,
    formatMetricRecordChain,
    normalizeDailyJournalEntry
} from '../utils/daily-journal-data.js';
import { formatMealogDateLabel, isWeekendIsoDate } from '../utils/date-label.js';
import {
    getAiDietReportButtonHtml,
    isAiDietReportDateVisible,
    refreshAiDietReportFlagsForDates
} from '../modals/diet-report.js';
import { scheduleLucideIcons } from '../icons.js';

function mainMealSlotLucideIcon(slotId) {
    return getSlotLucideIcon(slotId);
}

function mainMealSlotIconHtml(slotId, iconTextClass = 'text-slate-400', size = 'lg') {
    const sizeClass = size === 'sm' ? 'text-lg' : 'text-2xl';
    return `<i data-lucide="${mainMealSlotLucideIcon(slotId)}" class="${sizeClass} ${iconTextClass} shrink-0" aria-hidden="true"></i>`;
}

function mainMealSlotListTitleHtml(slot, specificStyle, displayLabel = null) {
    const label = displayLabel != null ? displayLabel : slot.label;
    return `<div class="flex items-center justify-center gap-1.5 min-w-0">
        ${mainMealSlotIconHtml(slot.id, specificStyle.iconText, 'sm')}
        <span class="text-sm font-bold leading-tight">${escapeHtml(label)}</span>
    </div>`;
}

/** 슬롯 라벨 — 동일 슬롯에 2건 이상이면 아침1·점심2·야식1 형식 */
function slotOrdinalTitle(slot, ordinal1Based, totalInSlot) {
    return totalInSlot > 1 ? `${slot.label}${ordinal1Based}` : slot.label;
}

function buildMainMealPhotoAreaHtml(slot, r, dateStr, iconTextClass) {
    if (!r) {
        return mainMealSlotIconHtml(slot.id, iconTextClass, 'lg');
    }
    const mainPhotoUrls = getMealPhotoUrlsForTimeline(r);
    if (mainPhotoUrls.length > 0) {
        return buildTimelinePhotoCellInnerHtml(mainPhotoUrls, 'object-cover', {
            dateStr,
            slotId: slot.id,
            recordId: r.id
        }, getMealThumbUrlsForTimeline(r));
    }
    if (r.mealType === 'Skip') {
        return `<i data-lucide="ban" class="text-2xl text-slate-600" aria-hidden="true"></i>`;
    }
    return mainMealSlotIconHtml(slot.id, iconTextClass, 'lg');
}

/**
 * 기록 행 제목 왼쪽: 동기화 표시
 * — 삭제예정·등록예정: 밝은 칩 / 삭제 진행·등록 진행(온라인): 빨간 도트 / 동기화 필요: 재시도 도트
 */
function mealLeadChip(text, title, variant = 'neutral') {
    const styles = {
        neutral: 'border-slate-400 text-slate-800 bg-white',
        /* 예정·안내 칩 — 보더·글자 모두 한 톤 밝게 */
        warn: 'border-amber-200 text-amber-700 bg-amber-50',
        danger: 'border-red-500 text-red-800 bg-red-50'
    };
    const cls = styles[variant] || styles.neutral;
    const t = escapeHtml(title);
    const x = escapeHtml(text);
    return `<span class="inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[10px] font-semibold leading-tight border border-solid ${cls}" title="${t}" aria-label="${t}">${x}</span>`;
}

/**
 * 오프라인 UI 분기 — navigator.onLine 만으로는 부족함(끊겼는데도 true인 경우 다수).
 */
function isMealSyncUiEffectiveOffline() {
    return isMealogTransportOffline();
}

/** 동기화 진행(재시도 버튼 아님) — 빨간 도트 */
function mealLeadSyncRedDot(srLabel, title) {
    const dot = (bg) =>
        `<span class="inline-block h-[7.8px] w-[7.8px] shrink-0 rounded-full ${bg} ring-1 ring-white/90 ring-inset" aria-hidden="true"></span>`;
    const t = escapeHtml(title);
    const sr = escapeHtml(srLabel);
    return `<span class="inline-flex h-[1em] w-[13.8px] shrink-0 items-center justify-center leading-none" title="${t}" aria-label="${sr}">${dot(
        'bg-red-500'
    )}</span><span class="sr-only">${sr}</span>`;
}

function mealEntrySyncLeadHtml(record) {
    if (!record || record.id == null || record.id === '') return '';
    const eid = escapeHtml(String(record.id));
    const dot = (bg) =>
        `<span class="inline-block h-[7.8px] w-[7.8px] shrink-0 rounded-full ${bg} ring-1 ring-white/90 ring-inset" aria-hidden="true"></span>`;

    const kind = getMealRowSyncLeadKind(record);
    const offline = isMealSyncUiEffectiveOffline();

    if (offline) {
        switch (kind) {
            case 'delete_scheduled':
            case 'delete_inflight':
                return mealLeadChip(
                    '삭제예정',
                    '오프라인이라 서버로 삭제가 아직 진행되지 않았어요. 연결되면 반영돼요.',
                    'warn'
                );
            case 'pending':
            case 'await_server_ack':
            case 'register_scheduled':
                return mealLeadChip(
                    '등록예정',
                    '오프라인이라 서버에 등록·수정이 아직 반영되지 않았어요. 연결되면 반영돼요.',
                    'warn'
                );
            default:
                break;
        }
    }

    switch (kind) {
        case 'delete_scheduled':
            return mealLeadChip(
                '삭제예정',
                '삭제는 예약된 상태예요. 서버에 반영되면 목록에서 사라져요.',
                'warn'
            );
        case 'delete_inflight':
            return mealLeadSyncRedDot('삭제 중', '삭제를 서버에 보내는 중이에요.');
        case 'register_scheduled':
            return mealLeadChip(
                '등록예정',
                '서버에 아직 반영되지 않았어요. 연결이 안정되면 자동으로 반영되거나, 동기화 버튼으로 다시 보낼 수 있어요.',
                'warn'
            );
        case 'pending':
            return mealLeadSyncRedDot('등록 중', '등록·수정 내용을 서버에 보내는 중이에요.');
        case 'await_server_ack':
            return mealLeadSyncRedDot('서버 반영 대기', '서버 반영을 확인하는 중이에요.');
        case 'delete_failed':
        case 'redoable_failed':
        case 'redoable_abandoned': {
            const title = '서버와 동기화되지 않았어요. 탭하면 다시 시도해요.';
            const sr = '동기화 필요';
            return `<span class="meal-sync-retry-btn inline-flex h-[1em] w-[13.8px] shrink-0 items-center justify-center leading-none cursor-pointer" data-meal-sync-retry="${eid}" role="button" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(sr)}, 탭하여 재시도">${dot(
                'bg-red-500'
            )}</span><span class="sr-only">${escapeHtml(sr)}</span>`;
        }
        case 'synced':
            return `<span class="inline-flex h-[1em] w-[13.8px] shrink-0 items-center justify-center leading-none" title="서버 반영 완료" aria-label="서버 반영 완료">${dot('bg-emerald-500')}</span><span class="sr-only">서버 반영 완료</span>`;
        default:
            return '';
    }
}

function mealCardRelativeClass(record) {
    if (!record) return '';
    return '';
}

function mealEntryRowPointerClass(record) {
    if (!record) return 'cursor-pointer active:scale-[0.98]';
    if (isMealEntryDeleting(record) || isMealEntryPendingSync(record)) {
        return 'cursor-wait pointer-events-none opacity-[0.93]';
    }
    if (isMealEntryDeleteFailed(record)) return 'cursor-pointer active:scale-[0.98]';
    if (isMealEntrySyncRedoable(record)) return 'cursor-pointer active:scale-[0.98]';
    return 'cursor-pointer active:scale-[0.98]';
}

/** 타임라인 식사·간식 행 탭 → 기록 모달 (인라인 onclick 대신 data 속성 + 위임) */
function mealTimelineOpenDataAttrs(dateStr, slotId, entryId = null) {
    const eid =
        entryId != null && entryId !== '' && entryId !== 'null'
            ? ` data-mealog-open-entry="${escapeHtml(String(entryId))}"`
            : '';
    return `data-mealog-open-date="${escapeHtml(String(dateStr))}" data-mealog-open-slot="${escapeHtml(String(slotId))}"${eid}`;
}

function applyMealTimelineOpenTarget(el, dateStr, slotId, entryId = null) {
    if (!el) return;
    if (slotId === 'daily_journal' || (entryId && String(entryId).startsWith('dailyJournal_'))) return;
    el.setAttribute('data-mealog-open-date', String(dateStr));
    el.setAttribute('data-mealog-open-slot', String(slotId));
    if (entryId != null && entryId !== '' && entryId !== 'null') {
        el.setAttribute('data-mealog-open-entry', String(entryId));
    } else {
        el.removeAttribute('data-mealog-open-entry');
    }
    el.removeAttribute('onclick');
}

function clearMealTimelineOpenTarget(el) {
    if (!el) return;
    el.removeAttribute('data-mealog-open-date');
    el.removeAttribute('data-mealog-open-slot');
    el.removeAttribute('data-mealog-open-entry');
    el.removeAttribute('onclick');
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

/** 초기 '오늘로 이동' 예약 — 추가 로드 renderTimeline 시 중복·역스크롤 방지 */
let timelineScrollToTodayTimer = null;

function cancelTimelineScrollToToday() {
    if (timelineScrollToTodayTimer != null) {
        clearTimeout(timelineScrollToTodayTimer);
        timelineScrollToTodayTimer = null;
    }
}

/** 날짜 섹션은 최신일이 위(먼저) — appendChild만 쓰면 invalidate 후 재삽입 시 해당 일이 맨 아래로 가버림 */
function insertTimelineDateSectionInChronologicalOrder(container, section, dateStr) {
    if (!container || !section || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        container?.appendChild(section);
        return;
    }
    for (const el of [...container.children]) {
        if (!el.id || !el.id.startsWith('date-')) continue;
        const other = el.id.slice(5);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(other)) continue;
        if (other < dateStr) {
            container.insertBefore(section, el);
            return;
        }
    }
    container.appendChild(section);
}

function patchTimelineCardLeadIcon(el, record) {
    const titleEl =
        el.querySelector('h4.mb-0.flex.min-w-0.items-center') ||
        el.querySelector('h4.mb-0.leading-tight') ||
        el.querySelector('h4.leading-tight.mb-0.flex.items-center') ||
        el.querySelector('h4.flex.items-center.min-w-0') ||
        el.querySelector('h4.flex.items-center') ||
        el.querySelector('p.text-sm.font-bold.text-slate-800.leading-snug.mb-0.flex.items-center.min-w-0.pl-2') ||
        el.querySelector('p.text-sm.font-bold.text-slate-800.leading-snug.mb-0.flex.items-center.min-w-0') ||
        el.querySelector('p.text-sm.font-bold.text-slate-800.leading-snug.mb-0.flex.items-center') ||
        el.querySelector('p.leading-snug.mb-0.flex.items-center.min-w-0') ||
        el.querySelector('p.flex.items-center.min-w-0');
    if (titleEl) {
        let menuSpan =
            titleEl.querySelector(':scope > span.min-w-0.flex-1.truncate') ||
            titleEl.querySelector(':scope > span.break-words') ||
            titleEl.querySelector(':scope > span.min-w-0');
        if (!menuSpan) {
            const kids = [...titleEl.children].filter((n) => n.tagName === 'SPAN');
            if (kids.length) menuSpan = kids[kids.length - 1];
        }
        if (menuSpan) {
            titleEl.innerHTML = mealEntrySyncLeadHtml(record) + menuSpan.outerHTML;
            return true;
        }
    }
    return false;
}

/** 태그형: 본문 라벨 왼쪽에 동기화 도트 — 카드·목록의 mealEntrySyncLeadHtml 과 동일 위치 */
function buildSnackTagRowInnerHtml(r) {
    const label = escapeHtml(String(r.menuDetail || r.snackType || '간식'));
    const shareDisp = isEntryShared(r.id, r) ? 'inline' : 'none';
    const ratingHtml = r.rating
        ? `<span class="text-[10px] font-black text-yellow-600 bg-yellow-50 border border-yellow-300 px-1 py-0.5 rounded-full ml-1.5 inline-flex items-center gap-0.5">
            <span class="text-[11px]">⭐</span>
            <span class="text-[11px] font-black">${r.rating}</span>
        </span>`
        : '';
    return `<span class="inline-flex items-center gap-1 min-w-0 max-w-full">${mealEntrySyncLeadHtml(r)}<span class="min-w-0">${label}</span></span><span class="timeline-share-arrow" style="display:${shareDisp === 'none' ? 'none' : 'inline-flex'}" title="게시됨"><i data-lucide="send" aria-hidden="true"></i></span>${ratingHtml}`;
}

function applySnackTagPendingUi(tagEl, record) {
    const deleting = isMealEntryDeleting(record);
    const deleteFailed = isMealEntryDeleteFailed(record);
    const redoable = isMealEntrySyncRedoable(record);
    const pending = isMealEntryPendingSync(record);
    tagEl.innerHTML = buildSnackTagRowInnerHtml(record);
    tagEl.querySelectorAll('.meal-entry-deleting-overlay').forEach((n) => n.remove());
    let cls = 'snack-tag relative inline-flex items-center gap-0.5 rounded-md ';
    if (deleting) cls += 'cursor-wait pointer-events-none opacity-90';
    else if (deleteFailed) cls += 'cursor-pointer active:bg-slate-50 ring-1 ring-amber-200/90';
    else if (redoable) cls += 'cursor-pointer active:bg-slate-50 ring-1 ring-red-200/90';
    else if (pending) cls += 'cursor-wait pointer-events-none opacity-90';
    else cls += 'cursor-pointer active:bg-slate-50';
    tagEl.className = cls;
    if (deleting || pending) {
        clearMealTimelineOpenTarget(tagEl);
    } else {
        applyMealTimelineOpenTarget(tagEl, record.date, record.slotId, record.id);
    }
}

function syncMealEntryDeletingOverlayOnCard(cardEl, record) {
    if (!cardEl.classList.contains('card')) return;
    cardEl.querySelectorAll(':scope > .meal-entry-deleting-overlay').forEach((n) => n.remove());
    cardEl.classList.remove('relative');
}

function applyCardRowPointerAndClick(rowEl, record) {
    if (!rowEl.classList.contains('card')) return;
    if (rowEl.classList.contains('daily-journal-slot') || isDailyJournalMealRecord(record)) return;
    rowEl.className = `${stripMealRowPointerClasses(rowEl.className)} ${mealEntryRowPointerClass(record)}`.replace(/\s+/g, ' ').trim();
    if (isMealEntryRowBlocked(record)) {
        clearMealTimelineOpenTarget(rowEl);
    } else {
        applyMealTimelineOpenTarget(rowEl, record.date, record.slotId, record.id);
    }
    syncMealEntryDeletingOverlayOnCard(rowEl, record);
}

/**
 * 이미 DOM에 그려진 날짜 섹션은 renderTimeline이 건너뛰므로, 대기 플래그만 바뀐 경우 동기화 도트·클릭 상태가 남을 수 있음.
 * mealHistory와 동기화해 data-entry-id 행만 갱신한다.
 */
export function updateTimelineMealEntryPendingIndicators() {
    if (!window.currentUser) {
        try {
            refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
        return;
    }
    /* 탭이 타임라인이 아니어도 DOM이 남아 있으면 갱신(저장 실패 직후 다른 탭에 있을 때 도트·재시도 버튼 동기화) */
    if (window.currentSearchQuery && window.currentSearchQuery.trim()) {
        try {
            refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
        return;
    }
    const container = document.getElementById('timelineContainer');
    if (!container) {
        try {
            refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
        return;
    }
    clearStuckMealPendingFlags();

    container.querySelectorAll('[data-entry-id]').forEach((el) => {
        const entryId = el.getAttribute('data-entry-id');
        if (!entryId) return;
        if (el.classList.contains('daily-journal-slot') || String(entryId).startsWith('dailyJournal_')) return;
        const record = window.mealHistory?.find((m) => m && String(m.id) === String(entryId));
        if (!record) return;
        if (isDailyJournalMealRecord(record)) return;

        if (el.classList.contains('snack-tag')) {
            applySnackTagPendingUi(el, record);
            return;
        }

        patchTimelineCardLeadIcon(el, record);

        if (el.classList.contains('card')) {
            applyCardRowPointerAndClick(el, record);
        }
    });
    try {
        refreshMealSyncResendNavButton();
    } catch (_) {
        /* ignore */
    }
}

let mealSyncRetryDelegationBound = false;
function ensureMealSyncRetryClickDelegation() {
    if (mealSyncRetryDelegationBound) return;
    mealSyncRetryDelegationBound = true;
    document.addEventListener(
        'click',
        (e) => {
            const btn = e.target?.closest?.('.meal-sync-retry-btn');
            if (!btn || !document.getElementById('timelineContainer')?.contains(btn)) return;
            const id = btn.getAttribute('data-meal-sync-retry');
            if (!id) return;
            const rec = window.mealHistory?.find((m) => m && String(m.id) === String(id));
            if (rec && isMealEntryDeleteFailed(rec)) {
                if (typeof window.retryMealEntryDeleteSync !== 'function') return;
                e.preventDefault();
                e.stopPropagation();
                window.retryMealEntryDeleteSync(id);
                return;
            }
            if (typeof window.retryMealEntrySync !== 'function') return;
            e.preventDefault();
            e.stopPropagation();
            window.retryMealEntrySync(id);
        },
        true
    );
}

/** false면 타임라인 날짜 헤더의 식사/간식 보기 전환 UI를 숨김 */
const SNACK_TIMELINE_VIEW_TOGGLE_VISIBLE = false;

/** @deprecated 간식은 홈피드 카드만 사용 */
const SNACK_TIMELINE_FORCE_TAGS_MODE = false;

// entryId가 모먼트(sharedPhotos 컬렉션)에 공유 중인지 — canonical 소스만 사용
function isEntryShared(entryId, record) {
    if (!entryId) return false;
    if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        return window.sharedPhotos.some(photo => photo.entryId === entryId);
    }
    return false;
}

function getSnackTimelineView() {
    return 'cards';
}

function getMealTimelineView() {
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

/** date+time이 동일할 때(구버전 분 단위 등): 서버/문서 timestamp로 실제 생성 순 보조 정렬 */
function mealRecordAuxChronoMs(r) {
    if (!r) return 0;
    const ts = r.timestamp;
    if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts && typeof ts === 'object' && typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (typeof ts === 'string' || typeof ts === 'number') {
        const t = new Date(ts).getTime();
        if (!Number.isNaN(t)) return t;
    }
    return 0;
}

/** Firestore recordedAt(ISO) 우선 — 신규 간식이 시간 없을 때 아래(뒤)로 쌓이게 */
function mealRecordedAtPrimaryMs(r) {
    if (!r) return NaN;
    if (typeof r.recordedAt === 'string' && r.recordedAt.trim()) {
        const ms = Date.parse(r.recordedAt.trim());
        if (!Number.isNaN(ms)) return ms;
    }
    return NaN;
}

/** mealClock 있으면 시간 기록으로 간주 */
function snackHasMealClockForSort(r) {
    return Boolean(r && normalizeMealClockInputValue(r.mealClock || ''));
}

/** mealClock만으로 당일 순서(자정 기준 분 단위) */
function snackMealClockMinutesFromMidnight(r) {
    const mc = normalizeMealClockInputValue(r?.mealClock || '');
    const m = String(mc).match(/^(\d{2}):(\d{2})$/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function sortSnackSlotRecordsChronological(records) {
    return [...records].sort((a, b) => {
        const ha = snackHasMealClockForSort(a);
        const hb = snackHasMealClockForSort(b);
        /** 사용자가 시간을 입력한 두 기록만 시각(HH:mm) 순으로 정렬 */
        if (ha && hb) {
            const ma = snackMealClockMinutesFromMidnight(a);
            const mb = snackMealClockMinutesFromMidnight(b);
            if (ma !== mb) return ma - mb;
            const ra = mealRecordedAtPrimaryMs(a);
            const rb = mealRecordedAtPrimaryMs(b);
            const ta = Number.isFinite(ra) ? ra : mealRecordAuxChronoMs(a) || mealRecordTimeSortMs(a);
            const tb = Number.isFinite(rb) ? rb : mealRecordAuxChronoMs(b) || mealRecordTimeSortMs(b);
            if (ta !== tb) return ta - tb;
            return String(a.id || '').localeCompare(String(b.id || ''));
        }
        /** 그 외: recordedAt·생성순 (슬롯 변경 시 recordedAt 갱신 → 이동 항목이 뒷번호) */
        const ra = mealRecordedAtPrimaryMs(a);
        const rb = mealRecordedAtPrimaryMs(b);
        const ta = Number.isFinite(ra) ? ra : mealRecordAuxChronoMs(a) || mealRecordTimeSortMs(a);
        const tb = Number.isFinite(rb) ? rb : mealRecordAuxChronoMs(b) || mealRecordTimeSortMs(b);
        if (ta !== tb) return ta - tb;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
}

/** 타임라인 썸네일: photos 배열·단일 문자열·photoUrl */
export function getMealPhotoUrlsForTimeline(r) {
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

/**
 * 타임라인 썸네일 표시용 URL(원본과 index 정렬).
 * 신규 업로드는 200px thumb → 없으면 800px display → 없으면 원본.
 * 반환 배열은 getMealPhotoUrlsForTimeline과 같은 길이/순서를 유지한다(팝업 원본과 매칭).
 * 작은 셀·태그용. 홈피드 와이드 카드는 getMealDisplayUrlsForTimeline 사용.
 */
export function getMealThumbUrlsForTimeline(r) {
    const originals = getMealPhotoUrlsForTimeline(r);
    if (originals.length === 0) return [];
    return originals.map((orig, i) => getThumbImageUrl(r, i, 'timeline.cell') || orig);
}

/**
 * 홈피드 와이드 카드용(800px display → 원본).
 * 200px thumb을 카드 전폭에 쓰면 화질이 크게 떨어진다.
 */
export function getMealDisplayUrlsForTimeline(r) {
    const originals = getMealPhotoUrlsForTimeline(r);
    if (originals.length === 0) return [];
    return originals.map((orig, i) => getDisplayImageUrl(r, i, 'timeline.home-feed') || orig);
}

/**
 * 사진 뷰어용: 해당 날짜·SLOTS 순서 — 기록이 있는 슬롯마다 1행(다건이면 아침1·점심2 등)
 * @returns {Array<{dateStr:string,slotId:string,recordId:string|null,slotTitle:string,urls:string[],menuLine:string,place:string,mealType:string|null,slotType:string,isEmptyRow:boolean,photoAspectRatio?:string}>}
 */
export function buildMealPhotoViewerRowsForDate(dateStr) {
    const rows = [];
    const history = window.mealHistory || [];
    SLOTS.forEach((slot) => {
        const recordsRaw = history.filter((m) => m.date === dateStr && m.slotId === slot.id);
        const records = sortSnackSlotRecordsChronological(recordsRaw);
        records.forEach((r, idx) => {
            rows.push(mealPhotoViewerRowFromRecord(dateStr, slot, r, idx + 1, records.length));
        });
    });
    return rows;
}

/**
 * 해당 연·월(1~12)에 기록이 있는 날짜만, 날짜 내림차순(최신일이 위)으로 이어 붙인 뷰어 행
 * @param {number} year
 * @param {number} month 1~12
 */
export function buildMealPhotoViewerRowsForMonth(year, month) {
    const history = window.mealHistory || [];
    const ym = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
    const dates = [
        ...new Set(
            history.map((m) => (typeof m.date === 'string' ? m.date : '')).filter((d) => d.startsWith(ym))
        )
    ].sort((a, b) => b.localeCompare(a));
    const rows = [];
    for (const dateStr of dates) {
        rows.push(...buildMealPhotoViewerRowsForDate(dateStr));
    }
    return rows;
}

/**
 * @param {string|null|undefined} recordId
 * @param {string|null|undefined} dateStr 같은 슬롯이 여러 날 있을 때(월 뷰) 날짜로 구분
 */
export function findMealPhotoViewerRowIndex(rows, slotId, recordId, dateStr = null) {
    const rid = recordId == null || recordId === '' ? null : String(recordId);
    const day = dateStr == null || dateStr === '' ? null : String(dateStr);
    const idx = rows.findIndex((row) => {
        const rowRid = row.recordId == null || row.recordId === '' ? null : String(row.recordId);
        const dateOk = day == null || row.dateStr === day;
        return dateOk && row.slotId === slotId && rowRid === rid;
    });
    return idx >= 0 ? idx : 0;
}

function mealPhotoViewerSlotTitle(slot, ordinal1Based, totalInSlot) {
    return slotOrdinalTitle(slot, ordinal1Based, totalInSlot);
}

function mealPhotoViewerRowFromRecord(dateStr, slot, r, ordinal1Based, totalInSlot) {
    const urls = getMealPhotoUrlsForTimeline(r);
    let place = '';
    let menuLine = '';
    if (slot.type === 'main') {
        place = String(r.place || '').trim();
        if (r.mealType === 'Skip') menuLine = 'Skip';
        else {
            const m = formatMealMenuDisplayLine(r);
            menuLine = (m || '').trim() || (r.category && String(r.category).trim()) || '';
        }
    } else {
        place = String(r.snackPlace || r.place || '').trim();
        const m = formatMealMenuDisplayLine(r);
        menuLine =
            (m || '').trim() ||
            String(r.menuDetail || r.snackType || '').trim() ||
            (r.category && String(r.category).trim()) ||
            '';
    }
    const ar = r.photoAspectRatio;
    const photoAspectRatio = ar === '3:4' || ar === '4:3' ? ar : '1:1';
    return {
        dateStr,
        slotId: slot.id,
        recordId: r.id != null && r.id !== '' ? String(r.id) : null,
        slotTitle: mealPhotoViewerSlotTitle(slot, ordinal1Based, totalInSlot),
        urls,
        menuLine,
        place,
        authorMealComment: String(r.comment || '').trim(),
        mealType: r.mealType || null,
        slotType: slot.type,
        isEmptyRow: false,
        photoAspectRatio
    };
}

/**
 * 좌측 140×140 사진 칸: 첫 장 + 다중 등록 시 우상단 1/n — 탭 시 전역 사진 팝업(부모 카드 onclick 전파 차단)
 * @param {string[]} urls 원본 URL(팝업/확대 보기용)
 * @param {string} imgClass
 * @param {object|null} viewCtx
 * @param {string[]|null} thumbUrls 표시용 썸네일 URL(원본과 index 정렬). 미제공 시 원본 사용.
 */
/**
 * @param {object|null} viewCtx
 * @param {string[]|null} thumbUrls
 * @param {{ interactive?: boolean }} [opts] interactive=false 면 사진 확대 버튼 없이 장식만(홈피드 카드 탭=수정)
 */
function buildTimelinePhotoCellInnerHtml(urls, imgClass = 'object-cover', viewCtx = null, thumbUrls = null, opts = null) {
    const first = urls[0];
    if (!first) return '';
    const n = urls.length;
    const interactive = opts?.interactive !== false;
    const enc = encodeURIComponent(JSON.stringify(urls));
    // 표시는 썸네일 우선, 로딩 실패 시 원본으로 폴백. 팝업(data-photos)은 항상 원본 유지.
    const displayFirst = (Array.isArray(thumbUrls) && thumbUrls[0]) ? thumbUrls[0] : first;
    const fallbackAttrs = imgFallbackAttrs(first, displayFirst, escapeHtml, 'timeline.cell');
    const badge =
        n > 1
            ? `<span class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold leading-none pointer-events-none shadow-sm">1/${n}</span>`
            : '';
    const ctxAttrs =
        viewCtx && viewCtx.dateStr && viewCtx.slotId
            ? ` data-meal-view-date="${escapeHtml(String(viewCtx.dateStr))}" data-meal-view-slot="${escapeHtml(String(viewCtx.slotId))}" data-meal-view-record="${escapeHtml(viewCtx.recordId != null ? String(viewCtx.recordId) : '')}"`
            : '';
    const tapBtn = interactive
        ? `<button type="button" class="timeline-meal-photo-tap absolute inset-0 z-20 h-full w-full cursor-zoom-in border-0 bg-transparent p-0 active:bg-white/5" style="-webkit-tap-highlight-color:transparent" aria-label="사진 ${n}장 보기"${ctxAttrs} data-photos="${enc}" onclick="event.stopPropagation();window.openTimelineMealPhotosPopup(this);"></button>`
        : '';
    return `<div class="absolute inset-0 overflow-hidden">
        <img src="${escapeHtml(displayFirst)}"${fallbackAttrs} class="absolute inset-0 z-0 h-full w-full ${imgClass} select-none pointer-events-none" alt="" draggable="false" loading="lazy">
        ${badge}
        ${tapBtn}
    </div>`;
}

const DATE_HEADER_ACTION_HEIGHT_CLASS = 'date-section-header__action-btn';

function buildMealTimelineViewSelectHtml(current) {
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    const mixedSel = current === 'mixed' ? ' selected' : '';
    return `<label class="timeline-view-picker timeline-view-picker--meal ${DATE_HEADER_ACTION_HEIGHT_CLASS}" title="식사보기: 카드·목록·자동(사진 있으면 카드, 없으면 목록)">
            <select id="mealTimelineViewSelect" class="meal-timeline-view-select timeline-view-picker__select" aria-label="식사 보기 방식">
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
                <option value="mixed"${mixedSel}>자동</option>
            </select>
            <span class="timeline-view-picker__visual" aria-hidden="true">
                <span class="timeline-view-picker__icon"><i data-lucide="utensils"></i></span>
                <span class="timeline-view-picker__body">
                    <span class="timeline-view-picker__category">식사</span>
                    <span class="timeline-view-picker__value-row">
                        <span class="timeline-view-picker__value">${current === 'cards' ? '카드' : current === 'list' ? '목록' : '자동'}</span>
                        <span class="timeline-view-picker__chevron"><i data-lucide="chevron-down"></i></span>
                    </span>
                </span>
            </span>
        </label>`;
}

function buildSnackTimelineViewSelectHtml(current) {
    const tagsSel = current === 'tags' ? ' selected' : '';
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    const mixedSel = current === 'mixed' ? ' selected' : '';
    const valueLabel =
        current === 'tags' ? '태그' : current === 'cards' ? '카드' : current === 'list' ? '목록' : '자동';
    return `<label class="timeline-view-picker timeline-view-picker--snack ${DATE_HEADER_ACTION_HEIGHT_CLASS}" title="간식보기: 태그·카드·목록·자동(건별 사진 있으면 카드, 없으면 목록)">
            <select id="snackTimelineViewSelect" class="snack-timeline-view-select timeline-view-picker__select" aria-label="간식 보기 방식">
                <option value="tags"${tagsSel}>태그</option>
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
                <option value="mixed"${mixedSel}>자동</option>
            </select>
            <span class="timeline-view-picker__visual" aria-hidden="true">
                <span class="timeline-view-picker__icon"><i data-lucide="cookie"></i></span>
                <span class="timeline-view-picker__body">
                    <span class="timeline-view-picker__category">간식</span>
                    <span class="timeline-view-picker__value-row">
                        <span class="timeline-view-picker__value">${valueLabel}</span>
                        <span class="timeline-view-picker__chevron"><i data-lucide="chevron-down"></i></span>
                    </span>
                </span>
            </span>
        </label>`;
}

function getDailyShareButtonHtmlForDate(dateStr) {
    if (!window.currentUser || window.currentUser.isAnonymous) return '';
    const dailyShare =
        window.sharedPhotos && Array.isArray(window.sharedPhotos)
            ? window.sharedPhotos.find(
                  (photo) =>
                      photo.type === 'daily' && photo.date === dateStr && photo.userId === window.currentUser?.uid
              )
            : null;
    const isShared = !!dailyShare;
    const styleCls = isShared
        ? 'date-section-header__share-btn--shared'
        : 'date-section-header__share-btn--default';
    return `<button type="button" data-mealog-daily="share" data-mealog-date="${dateStr}" class="date-section-header__share-btn ${DATE_HEADER_ACTION_HEIGHT_CLASS} ${styleCls}">
        <i data-lucide="send" class="text-[10px]" aria-hidden="true"></i>${isShared ? '공유됨' : '공유하기'}
    </button>`;
}

function buildDateHeaderRightActionsHtml(dateStr) {
    const parts = [];
    const share = getDailyShareButtonHtmlForDate(dateStr);
    if (share) parts.push(share);
    if (!parts.length) return '';
    return `<div class="date-section-header__actions">${parts.join('')}</div>`;
}

function buildDateHeaderDateHtml(dateStr) {
    const weekendCls = isWeekendIsoDate(dateStr) ? ' date-section-header__date--weekend' : '';
    return `<h3 class="date-section-header__date min-w-0${weekendCls}">${escapeHtml(formatMealogDateLabel(dateStr))}</h3>`;
}

function buildDateHeaderLeftHtml(dateStr) {
    const ai = getAiDietReportButtonHtml(dateStr);
    const aiInline = ai ? `<span class="ml-2 shrink-0 inline-flex">${ai}</span>` : '';
    return `<div class="min-w-0 flex items-center flex-wrap">${buildDateHeaderDateHtml(dateStr)}${aiInline}</div>`;
}

/**
 * 트래커 바로 아래 날짜 헤더: 공유 버튼 등 우측 액션 동기화
 */
export function syncSnackViewDropdown(container) {
    const timeline = container || document.getElementById('timelineContainer');
    if (!timeline) return;
    const sections = Array.from(timeline.querySelectorAll(':scope > [id^="date-"]'));
    sections.forEach((section) => {
        const header = section.querySelector('.date-section-header');
        if (!header) return;
        const dateStr = section.id.replace(/^date-/, '');
        const leftHtml = buildDateHeaderLeftHtml(dateStr);
        const rightHtml = buildDateHeaderRightActionsHtml(dateStr);

        header.className = 'date-section-header flex items-center gap-2';
        header.innerHTML = rightHtml ? `${leftHtml}${rightHtml}` : leftHtml;
    });
}

function timelineRatingHtml(value) {
    const parsed = Number(value);
    const count = Number.isFinite(parsed) ? Math.min(5, Math.max(0, Math.round(parsed))) : 0;
    const stars = count > 0 ? '★'.repeat(count) : '☆';
    const label = count > 0 ? `만족도 ${count}점` : '만족도 미입력';
    return `<span class="timeline-entry-rating" aria-label="${label}" title="${label}">${stars}</span>`;
}

function timelineTagsHtml(tags) {
    const clean = tags.map((tag) => String(tag || '').trim()).filter(Boolean);
    if (!clean.length) return '';
    return `<div class="timeline-entry-tags scrollbar-hide">${clean
        .map((tag) => `<span class="timeline-entry-tag">#${escapeHtml(tag)}</span>`)
        .join('')}</div>`;
}

function buildHomeFeedStarsHtml(rating) {
    const n = Number.parseInt(rating, 10);
    const filled = Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 0;
    let stars = '';
    for (let i = 1; i <= 5; i++) {
        stars += `<i data-lucide="star" class="${i > filled ? 'home-feed-card__star--empty' : ''}" aria-hidden="true"></i>`;
    }
    return `<div class="home-feed-card__stars" aria-label="${filled}점">${stars}</div>`;
}

function buildHomeFeedTagsHtml(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    const shown = tags.slice(0, 2);
    return `<div class="home-feed-card__tags">${shown
        .map((t) => `<span class="home-feed-card__tag">#${escapeHtml(t)}</span>`)
        .join('')}</div>`;
}

/**
 * 시안 v2 세로 피드 카드 — 상단 사진(선택) + 본문(아이콘·텍스트·별점)
 * 사진이 있어도 본문 왼쪽 아이콘은 유지. 별점은 메타(슬롯·장소) 행 오른쪽에만.
 */
function buildHomeFeedCardShellHtml({
    openClick,
    cardMbClass,
    record,
    hasPhoto,
    photoHtml,
    iconHtml,
    iconKind = 'meal',
    metaHtml,
    titleHtml,
    noteHtml,
    tagsHtml,
    ratingVal
}) {
    const photoClass = hasPhoto ? ' home-feed-card--photo' : '';
    const shareDisp = isEntryShared(record?.id, record) ? 'inline' : 'none';
    const stars = buildHomeFeedStarsHtml(ratingVal);
    const iconMod =
        iconKind === 'snack'
            ? ' home-feed-card__icon--snack'
            : iconKind === 'journal'
              ? ' home-feed-card__icon--journal'
              : ' home-feed-card__icon--meal';
    const photoBlock = hasPhoto
        ? `<div class="home-feed-card__photo relative">${photoHtml}</div>`
        : '';
    return `<div ${openClick} class="card home-feed-card${photoClass} ${cardMbClass} ${mealEntryRowPointerClass(record)} ${mealCardRelativeClass(record)}" data-entry-id="${escapeHtml(String(record.id))}">
        ${photoBlock}
        <div class="home-feed-card__body">
            <div class="home-feed-card__icon${iconMod}" aria-hidden="true">${iconHtml}</div>
            <div class="home-feed-card__main min-w-0">
                <div class="home-feed-card__meta-row">
                    <div class="home-feed-card__meta">${mealEntrySyncLeadHtml(record)}${metaHtml}<span class="timeline-share-arrow home-feed-card__share" title="게시됨" style="display:${shareDisp === 'none' ? 'none' : 'inline-flex'}"><i data-lucide="send" aria-hidden="true"></i></span></div>
                    ${stars}
                </div>
                <div class="home-feed-card__title">${titleHtml}</div>
                ${noteHtml || ''}
                ${tagsHtml || ''}
            </div>
        </div>
    </div>`;
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
    const slotTitleForCard = slotOrdinalTitle(slot, ordinal1Based, totalInSlot);
    const metaParts = [slotTitleForCard];
    if (p) metaParts.push(p);
    const metaHtml = escapeHtml(metaParts.join(' · '));
    const titleHtml = escapeHtml(menuLine || slotTitleForCard);
    const noteHtml = r.comment
        ? `<p class="home-feed-card__note">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>`
        : '';
    const tags = [];
    const clockTag = mealClockTagLabelFromRecord(r);
    if (clockTag) tags.push(clockTag);
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.snackType && String(r.snackType).trim() && !tags.includes(r.snackType)) tags.push(r.snackType);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    const snackPhotoUrls = getMealPhotoUrlsForTimeline(r);
    const hasPhoto = snackPhotoUrls.length > 0;
    let photoHtml = '';
    let iconHtml = `<i data-lucide="${getSlotLucideIcon(slot.id)}"></i>`;
    if (hasPhoto) {
        photoHtml = buildTimelinePhotoCellInnerHtml(
            snackPhotoUrls,
            'object-cover',
            { dateStr, slotId: slot.id, recordId: r.id },
            getMealDisplayUrlsForTimeline(r),
            { interactive: false }
        );
    } else if (r.mealType === 'Skip') {
        iconHtml = `<i data-lucide="ban"></i>`;
    }
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '';
    const blockOpen = isMealEntryRowBlocked(r);
    const openClick = blockOpen ? '' : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
    return buildHomeFeedCardShellHtml({
        openClick,
        cardMbClass,
        record: r,
        hasPhoto,
        photoHtml,
        iconHtml,
        iconKind: 'snack',
        metaHtml,
        titleHtml,
        noteHtml,
        tagsHtml: buildHomeFeedTagsHtml(tags),
        ratingVal
    });
}

function buildMainMealTimelineCardHtml(
    dateStr,
    slot,
    r,
    specificStyle,
    cardMbClass = 'mb-1.5',
    ordinal1Based = 1,
    totalInSlot = 1
) {
    const slotTitleForCard = slotOrdinalTitle(slot, ordinal1Based, totalInSlot);
    let metaHtml = escapeHtml(slotTitleForCard);
    let titleHtml = escapeHtml(slotTitleForCard);
    let noteHtml = '';
    let tags = [];
    if (r.mealType === 'Skip') {
        titleHtml = 'Skip';
    } else {
        const p = r.place || '';
        const m = formatMealMenuDisplayLine(r);
        const menuLine = (m || '').trim() || (r.category && String(r.category).trim()) || '';
        if (p) metaHtml = escapeHtml(`${slotTitleForCard} · ${p}`);
        titleHtml = escapeHtml(menuLine || slotTitleForCard);
        if (r.comment) {
            noteHtml = `<p class="home-feed-card__note">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>`;
        }
        const clockTagMain = mealClockTagLabelFromRecord(r);
        if (clockTagMain) tags.push(clockTagMain);
        if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
        if (r.withWhomDetail) tags.push(r.withWhomDetail);
        else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
        if (r.satiety) {
            const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
            if (sData) tags.push(sData.label);
        }
    }
    const mainPhotoUrls = getMealPhotoUrlsForTimeline(r);
    const hasPhoto = mainPhotoUrls.length > 0;
    let photoHtml = '';
    let iconHtml = mainMealSlotIconHtml(slot.id, '', 'lg');
    if (hasPhoto) {
        photoHtml = buildTimelinePhotoCellInnerHtml(
            mainPhotoUrls,
            'object-cover',
            { dateStr, slotId: slot.id, recordId: r.id },
            getMealDisplayUrlsForTimeline(r),
            { interactive: false }
        );
    } else if (r.mealType === 'Skip') {
        iconHtml = `<i data-lucide="ban"></i>`;
    }
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '';
    const blockOpen = isMealEntryRowBlocked(r);
    const openClick = blockOpen ? '' : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
    return buildHomeFeedCardShellHtml({
        openClick,
        cardMbClass,
        record: r,
        hasPhoto,
        photoHtml,
        iconHtml,
        iconKind: 'meal',
        metaHtml,
        titleHtml,
        noteHtml,
        tagsHtml: buildHomeFeedTagsHtml(tags),
        ratingVal
    });
}

function buildMainMealEmptySlotCardHtml(dateStr, slot, specificStyle) {
    const safeSlotLabel = escapeHtml(slot.label);
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card home-feed-card mb-1.5 opacity-80 cursor-pointer active:scale-[0.98] transition-all">
        <div class="home-feed-card__body">
            <div class="home-feed-card__icon home-feed-card__icon--meal" aria-hidden="true">${mainMealSlotIconHtml(slot.id, '', 'lg')}</div>
            <div class="home-feed-card__main min-w-0">
                <div class="home-feed-card__meta">${safeSlotLabel}</div>
                <div class="home-feed-card__title">기록하기</div>
            </div>
        </div>
    </div>`;
}

function buildSnackEmptySlotCardHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card home-feed-card mb-1.5 opacity-80 cursor-pointer active:scale-[0.98] transition-all">
        <div class="home-feed-card__body">
            <div class="home-feed-card__icon home-feed-card__icon--snack" aria-hidden="true"><i data-lucide="${getSlotLucideIcon(slot.id)}"></i></div>
            <div class="home-feed-card__main min-w-0">
                <div class="home-feed-card__meta">${safeLabel}</div>
                <div class="home-feed-card__title">기록하기</div>
            </div>
        </div>
    </div>`;
}

/** 목록형: 기록 없음 — 좌 슬롯명, 우측 `+ 기록하기` */
function buildSnackListEmptyRowHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card timeline-entry-row mb-1.5 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all">
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
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card timeline-entry-row mb-1.5 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all">
        <div class="flex ${hThird}">
            <div class="w-[140px] min-w-[140px] ${hThird} flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex items-center justify-center overflow-hidden border-r px-2 text-center">
                ${mainMealSlotListTitleHtml(slot, specificStyle)}
            </div>
            <div class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-4">
                <span class="text-xl font-semibold text-slate-400 leading-none" aria-hidden="true">+</span>
                <span class="text-xs text-slate-400 font-normal">기록하기</span>
            </div>
        </div>
    </div>`;
}

/** 본식 목록형: 기록 있음 — 좌 슬롯·@장소 / 우 메뉴·코멘트·태그(카드형과 동일 float 배지 + 코멘트 clear) */
function buildMainMealListFilledRowHtml(
    dateStr,
    slot,
    r,
    specificStyle,
    cardMbClass = 'mb-1.5',
    ordinal1Based = 1,
    totalInSlot = 1
) {
    const slotTitle = slotOrdinalTitle(slot, ordinal1Based, totalInSlot);
    const p = String(r.place || '').trim();
    const safePlaceLine = escapeHtml(p || '—');
    const m = formatMealMenuDisplayLine(r);
    const menuLine =
        r.mealType === 'Skip'
            ? 'Skip'
            : (m || '').trim() || (r.category && String(r.category).trim()) || '';
    const safeMenu = escapeHtml(menuLine);

    const tags = [];
    const clockTag = mealClockTagLabelFromRecord(r);
    if (clockTag) tags.push(clockTag);
    if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
    if (r.withWhomDetail) tags.push(r.withWhomDetail);
    else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
    if (r.satiety) {
        const sData = SATIETY_DATA.find((d) => d.val === r.satiety);
        if (sData) tags.push(sData.label);
    }
    let tagsHtml = '';
    if (tags.length > 0) {
        tagsHtml = timelineTagsHtml(tags);
    }

    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const blockMainList = isMealEntryRowBlocked(r);
    const openClickMainList = blockMainList
        ? ''
        : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
    return `<div ${openClickMainList} class="card timeline-entry-row ${cardMbClass} ${listLeft} ${mealEntryRowPointerClass(r)} transition-all ${mealCardRelativeClass(r)}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                ${mainMealSlotListTitleHtml(slot, specificStyle, slotTitle)}
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col py-2 pl-3 pr-2">
                <div class="min-w-0 overflow-hidden">
                    <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-1.5">
                        <span class="timeline-share-arrow" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline-flex' : 'none'}"><i data-lucide="send" aria-hidden="true"></i></span>
                        ${timelineRatingHtml(r.rating)}
                    </div>
                    <p class="mb-0 flex min-w-0 items-center gap-1.5 pl-2 text-sm font-bold leading-snug text-slate-800">${mealEntrySyncLeadHtml(r)}<span class="min-w-0 flex-1 truncate">${safeMenu}</span></p>
                    ${r.comment ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-xs text-slate-400">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>` : ''}
                    ${tagsHtml}
                </div>
            </div>
        </div>
    </div>`;
}

/** 목록형: 기록 있음 — 좌: 슬롯 / @ 장소 · 우: 메뉴·코멘트(한 줄+말줄임) → 태그 */
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
    const slotTitle = slotOrdinalTitle(slot, ordinal1Based, totalInSlot);
    const safeSlotTitle = escapeHtml(slotTitle);
    const safePlaceLine = escapeHtml(p || '—');

    const tags = [];
    const clockTag = mealClockTagLabelFromRecord(r);
    if (clockTag) tags.push(clockTag);
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
        tagsHtml = timelineTagsHtml(tags);
    }

    const safeMenu = escapeHtml(menuLine || '간식');
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const pendingSnackList = isMealEntryRowBlocked(r);
    const openClickSnackList = pendingSnackList
        ? ''
        : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);

    return `<div ${openClickSnackList} class="card timeline-entry-row ${cardMbClass} ${listLeft} ${mealEntryRowPointerClass(r)} transition-all ${mealCardRelativeClass(r)}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeSlotTitle}</span>
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col py-2 pl-3 pr-2">
                <div class="min-w-0 overflow-hidden">
                    <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-1.5">
                        <span class="timeline-share-arrow" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline-flex' : 'none'}"><i data-lucide="send" aria-hidden="true"></i></span>
                        ${timelineRatingHtml(r.rating)}
                    </div>
                    <p class="mb-0 flex min-w-0 items-center gap-1.5 pl-2 text-sm font-bold leading-snug text-slate-800">${mealEntrySyncLeadHtml(r)}<span class="min-w-0 flex-1 truncate">${safeMenu}</span></p>
                    ${r.comment ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-xs text-slate-400">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>` : ''}
                    ${tagsHtml}
                </div>
            </div>
        </div>
    </div>`;
}

function dailyJournalOpenDataAttrs(dateStr) {
    return `data-mealog-open-daily="${escapeHtml(String(dateStr))}"`;
}

function dailyJournalCardDataAttrs(dateStr, journal) {
    const base = dailyJournalOpenDataAttrs(dateStr);
    const entryId = getDailyJournalShareEntryId(dateStr);
    if (entryId && dailyJournalHasPhotos(journal)) {
        return `${base} data-entry-id="${escapeHtml(entryId)}"`;
    }
    return base;
}

function dailyJournalShareArrowHtml(dateStr, journal) {
    if (!dailyJournalHasPhotos(journal)) return '';
    const disp = isDailyJournalShared(dateStr, journal) ? 'inline' : 'none';
    return `<span class="timeline-share-arrow" title="게시됨" style="display:${disp === 'none' ? 'none' : 'inline-flex'}"><i data-lucide="send" aria-hidden="true"></i></span>`;
}

function getDailyJournalForTimeline(dateStr) {
    try {
        if (window.dbOps && typeof window.dbOps.getDailyJournal === 'function') {
            return window.dbOps.getDailyJournal(dateStr);
        }
    } catch (_) {}
    return getDailyJournalFromSettings(window.userSettings, dateStr);
}

/** 하루 기록 사진이 있을 때 — 식사 행과 동일한 동기화 도트(업로드 중 빨강 / 반영 완료 초록) */
function dailyJournalPhotoSyncLeadHtml(journal) {
    if (!dailyJournalHasPhotos(journal)) return '';
    if (dailyJournalHasPendingPhotoUpload(journal)) {
        return mealLeadSyncRedDot('등록 중', '하루 기록 사진을 서버에 업로드하는 중이에요.');
    }
    const dot = (bg) =>
        `<span class="inline-block h-[7.8px] w-[7.8px] shrink-0 rounded-full ${bg} ring-1 ring-white/90 ring-inset" aria-hidden="true"></span>`;
    return `<span class="inline-flex h-[1em] w-[13.8px] shrink-0 items-center justify-center leading-none" title="사진 서버 반영 완료" aria-label="사진 서버 반영 완료">${dot('bg-emerald-500')}</span><span class="sr-only">사진 서버 반영 완료</span>`;
}

function wrapDailyJournalSlotTextWithSyncLead(journal, innerHtml) {
    const lead = dailyJournalPhotoSyncLeadHtml(journal);
    if (!lead) return innerHtml;
    return `<div class="flex min-w-0 items-start gap-1.5">${lead}<div class="min-w-0 flex-1">${innerHtml}</div></div>`;
}

function dailyJournalCommentPreviewHtml(comment) {
    const c = String(comment || '').trim();
    if (!c) return '';
    return `<p class="daily-journal-summary-text clear-both mt-1.5 mb-0 min-w-0 text-xs font-medium text-slate-400">"${escapeHtml(c)}"</p>`;
}

function dailyJournalMetricHashtagSpan(label, chain) {
    if (!chain) return '';
    const tagText = `${label} ${chain}`;
    return `<span class="home-feed-card__tag">#${escapeHtml(tagText)}</span>`;
}

function dailyJournalMetricsSlotPreviewHtml(journal) {
    const n = normalizeDailyJournalEntry(journal);
    const tags = [];
    if (n.weightEnabled && n.weightRecords.length > 0) {
        const chain = formatMetricRecordChain(n.weightRecords, { isWeight: true });
        const span = dailyJournalMetricHashtagSpan('체중', chain);
        if (span) tags.push(span);
    }
    if (n.bloodSugarEnabled && n.bloodSugarRecords.length > 0) {
        const chain = formatMetricRecordChain(n.bloodSugarRecords, { isWeight: false });
        const span = dailyJournalMetricHashtagSpan('혈당', chain);
        if (span) tags.push(span);
    }
    if (!tags.length) return '';
    return `<div class="home-feed-card__tags">${tags.join('')}</div>`;
}

function buildDailyJournalSlotHtml(dateStr) {
    const journal = getDailyJournalForTimeline(dateStr);
    return buildDailyJournalCardHtml(dateStr, journal);
}

function buildDailyJournalListEmptyHtml(dateStr) {
    const style = DAILY_JOURNAL_SLOT_STYLE;
    const slot = DAILY_JOURNAL_SLOT;
    const safeLabel = escapeHtml(slot.label);
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = style.listLeft || '';
    return `<div ${dailyJournalOpenDataAttrs(dateStr)} class="card timeline-entry-row daily-journal-slot mb-1.5 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all">
        <div class="flex ${hThird}">
            <div class="w-[140px] min-w-[140px] ${hThird} flex-shrink-0 border-slate-200 ${style.iconText} bg-slate-50 flex items-center justify-center overflow-hidden border-r px-2 text-center">
                <span class="text-sm font-bold leading-tight">${safeLabel}</span>
            </div>
            <div class="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-4">
                <span class="text-xl font-semibold text-slate-400 leading-none" aria-hidden="true">+</span>
                <span class="text-xs text-slate-400 font-normal">기록하기</span>
            </div>
        </div>
    </div>`;
}

function buildDailyJournalListFilledHtml(dateStr, journal) {
    const style = DAILY_JOURNAL_SLOT_STYLE;
    const slot = DAILY_JOURNAL_SLOT;
    const comment = String(journal.comment || '').trim();
    const safeLabel = escapeHtml(slot.label);
    const listLeft = style.listLeft || '';
    const metricsHtml = dailyJournalMetricsSlotPreviewHtml(journal);
    const commentHtml = dailyJournalCommentPreviewHtml(comment);
    const fallback = dailyJournalSlotFallbackLine(journal);
    const fallbackHtml = !commentHtml && fallback
        ? `<p class="mb-0 min-w-0 truncate text-xs text-slate-400">${escapeHtml(fallback)}</p>`
        : '';
    const bodyInner =
        commentHtml +
        (metricsHtml || '') +
        fallbackHtml +
        (!metricsHtml && !commentHtml && !fallbackHtml ? `<p class="mb-0 text-xs text-slate-400">—</p>` : '');
    const bodyHtml = wrapDailyJournalSlotTextWithSyncLead(journal, bodyInner);

    return `<div ${dailyJournalCardDataAttrs(dateStr, journal)} class="card timeline-entry-row daily-journal-slot mb-1.5 ${listLeft} cursor-pointer active:scale-[0.98] transition-all">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${style.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words inline-flex items-center justify-center gap-1">${safeLabel}${dailyJournalShareArrowHtml(dateStr, journal)}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col justify-center py-2 pl-3 pr-2">
                ${bodyHtml}
            </div>
        </div>
    </div>`;
}

function buildDailyJournalCardHtml(dateStr, journal) {
    const style = DAILY_JOURNAL_SLOT_STYLE;
    const slot = DAILY_JOURNAL_SLOT;
    const hasContent = dailyJournalHasContent(journal);
    const comment = String(journal.comment || '').trim();
    const photos = Array.isArray(journal.photos) ? journal.photos.filter(Boolean) : [];
    const safeLabel = escapeHtml(slot.label);
    const hasPhoto = photos.length > 0;

    let photoHtml = '';
    let iconHtml = `<i data-lucide="book-open"></i>`;
    if (hasPhoto) {
        photoHtml = buildTimelinePhotoCellInnerHtml(photos, 'object-cover', null, null, {
            interactive: false
        });
    } else if (!hasContent) {
        iconHtml = `<i data-lucide="plus"></i>`;
    }

    const shareArrow = dailyJournalShareArrowHtml(dateStr, journal);
    const metaHtml = `${dailyJournalHasPhotos(journal) ? dailyJournalPhotoSyncLeadHtml(journal) : ''}${safeLabel}${shareArrow}`;
    const titleHtml = hasContent
        ? escapeHtml(
              comment
                  ? comment.replace(/\n/g, ' ').slice(0, 80)
                  : dailyJournalSlotFallbackLine(journal) || '하루 기록'
          )
        : '기록하기';
    const metricsPreview = dailyJournalMetricsSlotPreviewHtml(journal);
    const noteParts = [];
    if (comment && hasContent) {
        noteParts.push(
            `<p class="home-feed-card__note">"${escapeHtml(comment).replace(/\n/g, ' ')}"</p>`
        );
    }
    if (metricsPreview) noteParts.push(metricsPreview);
    const noteHtml = noteParts.join('');
    const photoClass = hasPhoto ? ' home-feed-card--photo' : '';
    const opacity = hasContent ? '' : ' opacity-80';

    return `<div ${dailyJournalCardDataAttrs(dateStr, journal)} class="card home-feed-card${photoClass} daily-journal-slot mb-1.5${opacity} cursor-pointer active:scale-[0.98] transition-all">
        ${hasPhoto ? `<div class="home-feed-card__photo relative">${photoHtml}</div>` : ''}
        <div class="home-feed-card__body">
            <div class="home-feed-card__icon home-feed-card__icon--journal" aria-hidden="true">${iconHtml}</div>
            <div class="home-feed-card__main min-w-0">
                <div class="home-feed-card__meta-row">
                    <div class="home-feed-card__meta">${metaHtml}</div>
                </div>
                <div class="home-feed-card__title">${titleHtml}</div>
                ${noteHtml}
            </div>
        </div>
    </div>`;
}

function refreshTimelineAfterSnackViewChange() {
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    container.querySelectorAll(':scope > [id^="date-"]').forEach((el) => el.remove());
    const lm = document.getElementById('loadMoreMealsBtn');
    if (lm) lm.remove();
    window.loadedDates = [];
    renderTimeline();
}

let timelineOpenModalDelegationBound = false;
/** 타임라인 식사·간식 카드/태그 탭 → 기록 모달 (일간 스와이프·CSP 등으로 인라인 onclick이 무반응일 때 대비) */
function ensureTimelineOpenModalDelegation() {
    if (timelineOpenModalDelegationBound) return;
    timelineOpenModalDelegationBound = true;
    document.addEventListener(
        'click',
        (e) => {
            const root = document.getElementById('timelineContainer');
            if (!root) return;
            if (e.target?.closest?.('.timeline-meal-photo-tap, .meal-sync-retry-btn')) return;
            const slotPickerBtn = e.target.closest('[data-mealog-slot-picker-date]');
            if (slotPickerBtn && root.contains(slotPickerBtn)) {
                const pickerDate = slotPickerBtn.getAttribute('data-mealog-slot-picker-date');
                if (pickerDate && typeof window.openEntrySlotPicker === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    void window.openEntrySlotPicker(pickerDate);
                    return;
                }
            }
            const dailyTarget = e.target.closest('.daily-journal-slot[data-mealog-open-daily]');
            if (dailyTarget && root.contains(dailyTarget)) {
                const dailyDate = dailyTarget.getAttribute('data-mealog-open-daily');
                if (dailyDate && typeof window.openDailyJournalModal === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    window.openDailyJournalModal(dailyDate);
                    return;
                }
            }
            const target = e.target.closest('[data-mealog-open-date][data-mealog-open-slot]');
            if (!target || !root.contains(target)) {
                const dailyFallback = e.target.closest('[data-mealog-open-daily]');
                if (!dailyFallback || !root.contains(dailyFallback)) return;
                const dailyDate = dailyFallback.getAttribute('data-mealog-open-daily');
                if (!dailyDate || typeof window.openDailyJournalModal !== 'function') return;
                e.preventDefault();
                e.stopPropagation();
                window.openDailyJournalModal(dailyDate);
                return;
            }
            if (target.classList.contains('pointer-events-none')) return;
            const date = target.getAttribute('data-mealog-open-date');
            const slotId = target.getAttribute('data-mealog-open-slot');
            const entryId = target.getAttribute('data-mealog-open-entry') || null;
            if (
                slotId === 'daily_journal' ||
                (entryId && String(entryId).startsWith('dailyJournal_'))
            ) {
                if (date && typeof window.openDailyJournalModal === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    window.openDailyJournalModal(date);
                }
                return;
            }
            if (!date || !slotId || typeof window.openModal !== 'function') return;
            e.preventDefault();
            e.stopPropagation();
            void window.openModal(date, slotId, entryId);
        },
        false
    );
}
ensureTimelineOpenModalDelegation();

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
                const valueEl = t.closest('.timeline-view-picker')?.querySelector('.timeline-view-picker__value');
                if (valueEl) valueEl.textContent = t.options[t.selectedIndex]?.textContent || '';
                refreshTimelineAfterSnackViewChange();
                return;
            }
            if (t.classList.contains('meal-timeline-view-select')) {
                try {
                    localStorage.setItem(MEAL_TIMELINE_VIEW_STORAGE_KEY, t.value);
                } catch (_) {}
                const valueEl = t.closest('.timeline-view-picker')?.querySelector('.timeline-view-picker__value');
                if (valueEl) valueEl.textContent = t.options[t.selectedIndex]?.textContent || '';
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
        let record = window.mealHistory?.find((m) => m.id === entryId);
        if (!record && entryId && entryId.startsWith('dailyJournal_')) {
            const dateStr = entryId.slice('dailyJournal_'.length);
            record = getDailyJournalFromSettings(window.userSettings, dateStr);
        }
        const arrow = el.querySelector('.timeline-share-arrow');
        if (arrow) {
            const shared = entryId?.startsWith('dailyJournal_')
                ? isDailyJournalShared(entryId.slice('dailyJournal_'.length), record)
                : isEntryShared(entryId, record);
            arrow.style.display = shared ? 'inline-flex' : 'none';
        }
    });
}

export function renderTimelineDateSections(dateStrs) {
    if (!Array.isArray(dateStrs) || !dateStrs.length) return;
    const valid = dateStrs.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!valid.length) return;
    renderTimeline({ onlyDates: valid });
}

/** 로컬 달력 YYYY-MM-DD */
export function localTodayYmd(baseDate = new Date()) {
    const d = baseDate instanceof Date ? new Date(baseDate) : new Date();
    d.setHours(0, 0, 0, 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function ymdByOffsetFromToday(todayStr, dayOffset) {
    const today = new Date(`${todayStr}T00:00:00`);
    today.setDate(today.getDate() - dayOffset);
    return localTodayYmd(today);
}

/**
 * 오늘 이전 달력에서 아직 그리지 않은 날짜를 최신→과거 순으로 최대 count개 수집.
 * loadedDates 개수 기반 점프 대신, 구멍을 메우며 연속 frontier를 따라간다.
 */
export function collectNextPastTimelineDates({
    todayStr = localTodayYmd(),
    count = 5,
    loadedDates = window.loadedDates,
    extraDates = [],
    maxScan = 730
} = {}) {
    const skip = new Set(
        [...(Array.isArray(loadedDates) ? loadedDates : []), ...(Array.isArray(extraDates) ? extraDates : [])]
            .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    );
    const out = [];
    let offset = 1;
    while (out.length < count && offset <= maxScan) {
        const dateStr = ymdByOffsetFromToday(todayStr, offset);
        offset += 1;
        if (dateStr >= todayStr) continue;
        if (skip.has(dateStr)) continue;
        out.push(dateStr);
        skip.add(dateStr);
    }
    return out;
}

/** 다음에 그릴 과거 날짜 묶음 중 가장 오래된 날 (fetch 필요 여부 판단) */
export function getOldestPendingPastTimelineDate(options = {}) {
    const dates = collectNextPastTimelineDates(options);
    if (!dates.length) return null;
    return dates[dates.length - 1];
}

/** @deprecated sparse 날짜 렌더는 누락을 유발함 — 호환용으로만 유지 */
export function mealDatesFromNewlyLoadedChunk(newMeals, prevRangeStart, newRangeStart) {
    const prev = typeof prevRangeStart === 'string' ? prevRangeStart : null;
    const next = typeof newRangeStart === 'string' ? newRangeStart : null;
    return [
        ...new Set(
            (Array.isArray(newMeals) ? newMeals : [])
                .map((m) => m?.date)
                .filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
                .filter((d) => (!next || d >= next) && (!prev || d < prev))
        )
    ].sort((a, b) => b.localeCompare(a));
}

/** @param {{ onlyDates?: string[] }} [options] onlyDates — 지정 날짜 섹션만 추가/갱신(전체 재렌더 생략) */
export function renderTimeline(options = {}) {
    const onlyDates = Array.isArray(options.onlyDates)
        ? options.onlyDates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
        : null;
    const incrementalDates = onlyDates && onlyDates.length > 0;
    const state = appState;
    if (!window.currentUser || state.currentTab !== 'timeline') return;
    /* 검색 모드일 때는 타임라인 렌더하지 않음 (검색 결과만 표시) */
    if (window.currentSearchQuery && window.currentSearchQuery.trim()) return;
    ensureMealSyncRetryClickDelegation();
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
    if (incrementalDates) {
        onlyDates.forEach((d) => {
            if (!targetDates.includes(d)) targetDates.push(d);
        });
    } else if (state.viewMode === 'list') {
        // 초기 로드 시 오늘 날짜를 무조건 첫 번째로 추가
        if (window.loadedDates.length === 0) {
            targetDates.push(todayStr);
        } else if (!window.loadedDates.includes(todayStr)) {
            // 오늘 날짜가 아직 로드되지 않았다면 추가
            targetDates.push(todayStr);
        }

        // 이미 그린 날짜(희소 삽입 포함)는 건너뛰고, 아직 안 그린 과거 달력 날짜를 최대 5일 확보
        collectNextPastTimelineDates({
            todayStr,
            count: 5,
            loadedDates: window.loadedDates,
            extraDates: targetDates
        }).forEach((dateStr) => targetDates.push(dateStr));
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
    } else if (
        !incrementalDates &&
        state.viewMode === 'list' &&
        !window.loadedDates.includes(todayStr) &&
        !sortedTargetDates.includes(todayStr)
    ) {
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

    sortedTargetDates.forEach((dateStr) => {
        const forceRebuild = pendingTimelineSectionRebuildDates.has(dateStr);
        let existingSection = document.getElementById(`date-${dateStr}`);
        // 일간보기: 기존 섹션이 있으면 건너뛰되, invalidate로 강제 재구성이 필요한 날짜는 DOM을 다시 그린다
        if (existingSection && state.viewMode === 'page' && !forceRebuild) {
            return;
        }
        if (forceRebuild && existingSection) {
            existingSection.remove();
            const idxLd = window.loadedDates.indexOf(dateStr);
            if (idxLd >= 0) window.loadedDates.splice(idxLd, 1);
            existingSection = null;
        }

        // 이미 로드된 날짜이거나 DOM에 이미 존재하는 경우 건너뛰기
        if (window.loadedDates.includes(dateStr) && !forceRebuild) return;
        if (existingSection) return;
        
        window.loadedDates.push(dateStr);
        const section = document.createElement('div');
        section.id = `date-${dateStr}`;
        section.className = 'animate-fade timeline-date-card';
        const leftHtml = buildDateHeaderLeftHtml(dateStr);
        const rightHtml = buildDateHeaderRightActionsHtml(dateStr);
        let html = `<div class="date-section-header flex items-center gap-2">
            ${leftHtml}
            ${rightHtml}
        </div>`;

        SLOTS.forEach(slot => {
            const recordsRaw = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
            const records = sortSnackSlotRecordsChronological(recordsRaw);
            // 빈 슬롯은 타임라인에 표시하지 않음 — 추가는 슬롯 피커로
            if (records.length === 0) return;
            const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
            if (slot.type === 'main') {
                html += `<div class="main-slot-card-group">`;
                records.forEach((r, idx) => {
                    html += buildMainMealTimelineCardHtml(
                        dateStr,
                        slot,
                        r,
                        specificStyle,
                        'mb-1.5',
                        idx + 1,
                        records.length
                    );
                });
                html += `</div>`;
            } else {
                html += `<div class="snack-slot-card-group">`;
                records.forEach((r, idx) => {
                    html += buildSnackTimelineCardHtml(
                        dateStr,
                        slot,
                        r,
                        specificStyle,
                        'mb-1.5',
                        idx + 1,
                        records.length
                    );
                });
                html += `</div>`;
            }
        });
        const dailyJournal = getDailyJournalForTimeline(dateStr);
        if (dailyJournalHasContent(dailyJournal)) {
            html += buildDailyJournalSlotHtml(dateStr);
        }

        const hasAnyMealOnDate = (window.mealHistory || []).some((m) => m?.date === dateStr);
        if (!hasAnyMealOnDate && !dailyJournalHasContent(dailyJournal)) {
            html += `<div class="timeline-day-empty px-4 py-6 text-center">
                <p class="text-sm text-slate-400 font-medium">이 날은 기록이 없어요,<br>지금 시작해 보세요.</p>
            </div>`;
        }

        section.innerHTML = html;
        insertTimelineDateSectionInChronologicalOrder(container, section, dateStr);
        pendingTimelineSectionRebuildDates.delete(dateStr);
    });

    // 최근 날짜(오늘)로 스크롤 (초기 로드·화면 상단에 있을 때만)
    cancelTimelineScrollToToday();
    if (
        !incrementalDates &&
        state.viewMode === 'list' &&
        sortedTargetDates.length > 0 &&
        !window.hasScrolledToToday &&
        window.scrollY < 80
    ) {
        const todaySection = document.getElementById(`date-${todayStr}`);
        if (todaySection) {
            window.__suppressChromeScrollHideUntil = Date.now() + 1600;
            timelineScrollToTodayTimer = setTimeout(() => {
                timelineScrollToTodayTimer = null;
                if (window.hasScrolledToToday || window.scrollY >= 80) return;
                const trackerSection = document.getElementById('trackerSection');
                const trackerHeight = trackerSection ? trackerSection.offsetHeight : 0;
                const headerHeight = 73;
                const totalOffset = headerHeight + trackerHeight;
                const elementTop = todaySection.getBoundingClientRect().top + window.pageYOffset;
                const offsetPosition = elementTop - totalOffset - 16;
                window.scrollTo({ top: Math.max(0, offsetPosition), behavior: 'smooth' });
                window.hasScrolledToToday = true;
                if (typeof window.__revealAppChromeAfterProgrammaticScroll === 'function') {
                    setTimeout(() => window.__revealAppChromeAfterProgrammaticScroll(), 480);
                }
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
                    <i data-lucide="chevron-down"></i>
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

    ensureTimelineOpenModalDelegation();
    ensureTimelineViewSelectDelegation();
    syncSnackViewDropdown(container);
    scheduleLucideIcons(container);

    if (typeof window.bindMealogDailyTimelineDelegation === 'function') {
        window.bindMealogDailyTimelineDelegation();
    }

    updateTimelineMealEntryPendingIndicators();
    updateTrackerStreakLabel();

    const reportCheckDates = (window.loadedDates || []).filter((d) => isAiDietReportDateVisible(d));
    if (reportCheckDates.length) {
        void refreshAiDietReportFlagsForDates(reportCheckDates);
    }
}

let miniCalendarPointerDragBound = false;
let miniCalendarScrollTitleBound = false;
let trackerMonthTitleRaf = null;
let trackerMonthCalendarModalBound = false;

/** 가로 트래커: 오늘 포함 초기 61일(과거 60+오늘). 왼쪽 끝에서 +30일 prepend, 최대 약 1년 */
const TRACKER_INITIAL_PAST_DAYS = 60;
const TRACKER_EXTEND_DAYS = 30;
const TRACKER_MAX_PAST_DAYS = 364;
const TRACKER_EXTEND_EDGE_PX = 48;
const TRACKER_EXTEND_COOLDOWN_MS = 400;

let trackerPastDays = TRACKER_INITIAL_PAST_DAYS;
let trackerExtendInFlight = false;
let trackerLastExtendAt = 0;

/** 로그아웃·계정 전환 시 트래커 과거 창 초기화 */
export function resetTrackerMiniCalendarRange() {
    trackerPastDays = TRACKER_INITIAL_PAST_DAYS;
    trackerExtendInFlight = false;
    trackerLastExtendAt = 0;
}

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
    const historyByDate = buildMealHistoryCountByDate();

    const parts = [];
    for (let i = 0; i < firstDow; i++) {
        parts.push('<div class="tracker-month-cell tracker-month-cell--empty" aria-hidden="true"></div>');
    }
    for (let d = 1; d <= dim; d++) {
        const iso = `${y}-${pad2(m)}-${pad2(d)}`;
        const c = getRecordCountForIso(iso, historyByDate);
        const st = dotStatusFromCount(c);
        const sel = iso === activeIso ? 'dot-selected' : '';
        const dow = new Date(y, m - 1, d).getDay();
        const weekend = dow === 0 || dow === 6 ? 'tracker-month-dot--weekend' : '';
        parts.push(
            `<button type="button" class="tracker-month-cell" data-tracker-popup-iso="${iso}" aria-label="${y}년 ${m}월 ${d}일">` +
                `<div class="calendar-dot tracker-month-dot ${st} ${sel} ${weekend}">${d}</div>` +
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
    scheduleLucideIcons(modal);
}

export function refreshTrackerMonthCalendarPopupIfOpen() {
    const modal = document.getElementById('trackerMonthCalendarModal');
    if (!modal || modal.classList.contains('hidden')) return;
    renderTrackerMonthCalendarPopup();
}

function setupTrackerMonthCalendarModal() {
    const backdrop = document.getElementById('trackerMonthCalendarBackdrop');
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

    if (!trackerMonthCalendarModalBound) {
        trackerMonthCalendarModalBound = true;
        if (backdrop) backdrop.addEventListener('click', closeTrackerMonthCalendar);
        if (prevBtn) prevBtn.addEventListener('click', goPrev);
        if (nextBtn) nextBtn.addEventListener('click', goNext);
    }
    if (openBtn && !openBtn.dataset.trackerMonthCalBound) {
        openBtn.dataset.trackerMonthCalBound = '1';
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
        if (!c) return;
        scheduleTrackerMonthTitleUpdate(c);
        maybeExtendTrackerPastOnScroll(c);
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
    /** pointerdown 직후 setPointerCapture 하면 클릭이 자식(날짜)까지 전달되지 않음 → 임계 초과 시에만 캡처 */
    let captureActive = false;

    container.addEventListener(
        'pointerdown',
        (e) => {
            if (e.pointerType === 'touch') return;
            if (e.button !== 0) return;
            active = true;
            activePointerId = e.pointerId;
            suppressClick = false;
            captureActive = false;
            startX = e.clientX;
            startScrollLeft = container.scrollLeft;
        },
        { passive: true }
    );

    container.addEventListener('pointermove', (e) => {
        if (!active || e.pointerId !== activePointerId) return;
        const dx = e.clientX - startX;
        if (!captureActive && Math.abs(dx) > DRAG_THRESHOLD) {
            captureActive = true;
            try {
                container.setPointerCapture(e.pointerId);
            } catch (_) {}
            container.classList.add('calendar-scroll-dragging');
        }
        if (captureActive) {
            container.scrollLeft = startScrollLeft - (e.clientX - startX);
        }
    });

    const end = (e) => {
        if (!active || e.pointerId !== activePointerId) return;
        const totalMove = Math.abs(e.clientX - startX);
        const scrollDelta = Math.abs(container.scrollLeft - startScrollLeft);
        suppressClick =
            totalMove > CLICK_CANCEL_MOVE_PX ||
            scrollDelta > CLICK_CANCEL_SCROLL_PX ||
            captureActive;
        if (captureActive) {
            container.classList.remove('calendar-scroll-dragging');
            try {
                container.releasePointerCapture(e.pointerId);
            } catch (_) {}
        }
        captureActive = false;
        active = false;
        activePointerId = null;
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

function dotStatusFromCount(count) {
    if (count <= 0) return 'dot-none';
    if (count === 1) return 'dot-low';
    if (count === 2) return 'dot-mid';
    return 'dot-full';
}

function activePageDateIso() {
    const d = appState.pageDate;
    if (!(d instanceof Date) || isNaN(+d)) return localTodayYmd();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** todayStr − iso 일수 (iso가 더 과거면 양수) */
function daysBeforeToday(iso, todayStr = localTodayYmd()) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 0;
    const a = new Date(`${iso}T00:00:00`);
    const b = new Date(`${todayStr}T00:00:00`);
    if (isNaN(+a) || isNaN(+b)) return 0;
    return Math.round((b - a) / 86400000);
}

/** 달력/스와이프로 선택일이 창 밖이면 트래커 span을 그 날짜까지 확장 */
function ensureTrackerSpanCoversIso(iso) {
    const today = localTodayYmd();
    if (!iso || iso > today) return;
    const diff = daysBeforeToday(iso, today);
    if (diff > trackerPastDays) {
        trackerPastDays = Math.min(TRACKER_MAX_PAST_DAYS, diff);
    }
}

function daySpecFromOffset(offsetFromToday, activeStr) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetFromToday);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const iso = `${year}-${month}-${day}`;
    return {
        iso,
        dayNum: d.getDate(),
        dayColorClass: d.getDay() === 0 || d.getDay() === 6 ? 'text-rose-400' : 'text-slate-400',
        weekdayLabel: d.toLocaleDateString('ko-KR', { weekday: 'narrow' }),
        isActive: iso === activeStr
    };
}

/** 오늘 포함 과거 trackerPastDays+1일 (오른쪽=오늘, 왼쪽=더 과거) */
function buildMiniCalendarDaySpecs(activeStr) {
    ensureTrackerSpanCoversIso(activeStr);
    const days = [];
    for (let i = trackerPastDays; i >= 0; i--) {
        days.push(daySpecFromOffset(i, activeStr));
    }
    return days;
}

function createMiniCalendarItemEl(day, count) {
    const status = dotStatusFromCount(count);
    const weekend = day.dayColorClass.includes('rose');
    const item = document.createElement('div');
    item.className = `calendar-item cal-day flex flex-col items-center flex-shrink-0${weekend ? ' weekend' : ''}${day.isActive ? ' selected' : ''}`;
    item.setAttribute('data-tracker-date', day.iso);
    item.innerHTML = `<span id="dot-${day.iso}" class="calendar-dot ${status}${day.isActive ? ' dot-selected' : ''}">${day.dayNum}<span class="calendar-density" aria-hidden="true"></span></span>
        <span class="calendar-dow ${day.dayColorClass}">${day.weekdayLabel}</span>`;
    item.onclick = () => window.jumpToDate(day.iso);
    return item;
}

/**
 * 왼쪽 끝에 가까우면 과거 +30일을 prepend (스크롤 위치 유지).
 * @returns {boolean} 확장했는지
 */
function tryExtendTrackerPast(container) {
    if (!container || trackerExtendInFlight) return false;
    if (trackerPastDays >= TRACKER_MAX_PAST_DAYS) return false;

    const prevSpan = trackerPastDays;
    const nextSpan = Math.min(TRACKER_MAX_PAST_DAYS, trackerPastDays + TRACKER_EXTEND_DAYS);
    if (nextSpan <= prevSpan) return false;

    trackerExtendInFlight = true;
    try {
        const activeStr = activePageDateIso();
        const historyByDate = buildMealHistoryCountByDate();
        const oldScrollLeft = container.scrollLeft;
        const oldScrollWidth = container.scrollWidth;

        const frag = document.createDocumentFragment();
        for (let i = nextSpan; i > prevSpan; i--) {
            const day = daySpecFromOffset(i, activeStr);
            const count = getRecordCountForIso(day.iso, historyByDate);
            frag.appendChild(createMiniCalendarItemEl(day, count));
        }
        container.insertBefore(frag, container.firstChild);
        trackerPastDays = nextSpan;

        const delta = container.scrollWidth - oldScrollWidth;
        container.scrollLeft = oldScrollLeft + delta;
        scheduleTrackerMonthTitleUpdate(container);
        return true;
    } finally {
        trackerExtendInFlight = false;
        trackerLastExtendAt = Date.now();
    }
}

function maybeExtendTrackerPastOnScroll(container) {
    if (!container || !window.currentUser) return;
    if (container.scrollLeft > TRACKER_EXTEND_EDGE_PX) return;
    if (Date.now() - trackerLastExtendAt < TRACKER_EXTEND_COOLDOWN_MS) return;
    tryExtendTrackerPast(container);
}

function canPatchMiniCalendarDom(container, days) {
    const items = container.querySelectorAll('.calendar-item');
    if (items.length !== days.length) return false;
    if (!items[0]?.querySelector('.calendar-dow') || !items[0]?.querySelector('.calendar-density')) {
        return false;
    }
    for (let i = 0; i < days.length; i++) {
        if (items[i].getAttribute('data-tracker-date') !== days[i].iso) return false;
    }
    return true;
}

function patchMiniCalendarItem(item, day, count) {
    item.setAttribute('data-tracker-date', day.iso);
    const status = dotStatusFromCount(count);
    const weekend = day.dayColorClass.includes('rose');
    item.className = `calendar-item cal-day flex flex-col items-center flex-shrink-0${weekend ? ' weekend' : ''}${day.isActive ? ' selected' : ''}`;
    item.innerHTML = `<span id="dot-${day.iso}" class="calendar-dot ${status}${day.isActive ? ' dot-selected' : ''}">${day.dayNum}<span class="calendar-density" aria-hidden="true"></span></span>
        <span class="calendar-dow ${day.dayColorClass}">${day.weekdayLabel}</span>`;
    item.onclick = () => window.jumpToDate(day.iso);
}

function finishMiniCalendarAfterRender(container, activeStr) {
    setupMiniCalendarPointerDrag(container);
    setupMiniCalendarScrollTitle(container);
    setupTrackerMonthCalendarModal();

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateTrackerMonthTitle(container);
        });
    });

    setTimeout(() => {
        const now = Date.now();
        const lastKey = window._miniCalLastAutoScrollKey || '';
        const lastAt = window._miniCalLastAutoScrollAt || 0;
        const key = String(activeStr);
        const shouldAutoScroll = !(lastKey === key && now - lastAt < 2000);
        if (shouldAutoScroll) {
            window._miniCalLastAutoScrollKey = key;
            window._miniCalLastAutoScrollAt = now;
            const activeDot = document.getElementById(`dot-${activeStr}`);
            if (activeDot) activeDot.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        }
        updateTrackerMonthTitle(container);
    }, 100);

    refreshTrackerMonthCalendarPopupIfOpen();
    updateTrackerStreakLabel();
}

/** 미니 캘린더 DOM 재구성 없이 점(dot)·연속일 라벨만 갱신 */
export function refreshMiniCalendarDots() {
    const state = appState;
    const container = document.getElementById('miniCalendar');
    if (!container || !window.currentUser) return;
    const pageYear = state.pageDate.getFullYear();
    const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
    const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
    const activeStr = `${pageYear}-${pageMonth}-${pageDay}`;
    ensureTrackerSpanCoversIso(activeStr);
    const historyByDate = buildMealHistoryCountByDate();
    const days = buildMiniCalendarDaySpecs(activeStr);

    // span이 DOM보다 길면(달력 점프 등) 전체 재구성
    if (container.querySelectorAll('.calendar-item').length !== days.length) {
        renderMiniCalendar();
        return;
    }

    days.forEach((day) => {
        const dotEl = document.getElementById(`dot-${day.iso}`);
        if (!dotEl) return;
        const count = getRecordCountForIso(day.iso, historyByDate);
        const status = dotStatusFromCount(count);
        dotEl.className = `calendar-dot ${status}${day.isActive ? ' dot-selected' : ''}`;
        if (!dotEl.querySelector('.calendar-density')) {
            dotEl.insertAdjacentHTML('beforeend', '<span class="calendar-density" aria-hidden="true"></span>');
        }
        const item = dotEl.closest('.calendar-item');
        if (item) {
            item.classList.toggle('selected', day.isActive);
        }
    });
    refreshTrackerMonthCalendarPopupIfOpen();
    updateTrackerStreakLabel();
}

export function renderMiniCalendar() {
    const state = appState;
    const container = document.getElementById('miniCalendar');
    if (!container || !window.currentUser) return;
    const pageYear = state.pageDate.getFullYear();
    const pageMonth = String(state.pageDate.getMonth() + 1).padStart(2, '0');
    const pageDay = String(state.pageDate.getDate()).padStart(2, '0');
    const activeStr = `${pageYear}-${pageMonth}-${pageDay}`;
    ensureTrackerSpanCoversIso(activeStr);
    const days = buildMiniCalendarDaySpecs(activeStr);
    const historyByDate = buildMealHistoryCountByDate();

    if (canPatchMiniCalendarDom(container, days)) {
        const items = container.querySelectorAll('.calendar-item');
        days.forEach((day, i) => {
            patchMiniCalendarItem(items[i], day, getRecordCountForIso(day.iso, historyByDate));
        });
        finishMiniCalendarAfterRender(container, activeStr);
        return;
    }

    container.innerHTML = '';
    days.forEach((day) => {
        const count = getRecordCountForIso(day.iso, historyByDate);
        container.appendChild(createMiniCalendarItemEl(day, count));
    });

    finishMiniCalendarAfterRender(container, activeStr);
}
