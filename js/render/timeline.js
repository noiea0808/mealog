// 타임라인 및 미니 캘린더 렌더링
import {
    SLOTS,
    SLOT_STYLES,
    DAILY_JOURNAL_SLOT,
    DAILY_JOURNAL_SLOT_STYLE,
    SATIETY_DATA,
    SNACK_TIMELINE_VIEW_STORAGE_KEY,
    MEAL_TIMELINE_VIEW_STORAGE_KEY
} from '../constants.js';
import { appState } from '../state.js';
import { escapeHtml } from './utils.js';
import { formatMealMenuDisplayLine } from '../utils/meal-display-line.js';
import { getRecordCountForIso } from '../meal-record-count.js';
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
    formatMetricRecordChain,
    normalizeDailyJournalEntry
} from '../utils/daily-journal-data.js';
import { formatMealogDateLabel } from '../utils/date-label.js';

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
    return `<span class="inline-flex items-center gap-1 min-w-0 max-w-full">${mealEntrySyncLeadHtml(r)}<span class="min-w-0">${label}</span></span><span class="timeline-share-arrow" style="display:${shareDisp}"><i class="fa-solid fa-share text-slate-500 text-[8px] ml-1" title="게시됨"></i></span>${ratingHtml}`;
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
        if (v === 'cards' || v === 'tags' || v === 'list' || v === 'mixed') return v;
    } catch (_) {}
    return 'tags';
}

function getMealTimelineView() {
    try {
        const v = localStorage.getItem(MEAL_TIMELINE_VIEW_STORAGE_KEY);
        if (v === 'cards' || v === 'list' || v === 'mixed') return v;
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
        const ca = snackHasMealClockForSort(a);
        const cb = snackHasMealClockForSort(b);
        /** 시간 기록 있음 먼저(위), 없음은 나중(아래) — 화면 세로는 시간 오름차순 후 생성순 */
        if (ca !== cb) return ca ? -1 : 1;

        if (ca && cb) {
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
 * 사진 뷰어용: 해당 날짜·SLOTS 순서 — 기록이 있는 슬롯만(본식 1행, 간식은 기록마다 1행)
 * @returns {Array<{dateStr:string,slotId:string,recordId:string|null,slotTitle:string,urls:string[],menuLine:string,place:string,mealType:string|null,slotType:string,isEmptyRow:boolean,photoAspectRatio?:string}>}
 */
export function buildMealPhotoViewerRowsForDate(dateStr) {
    const rows = [];
    const history = window.mealHistory || [];
    SLOTS.forEach((slot) => {
        const recordsRaw = history.filter((m) => m.date === dateStr && m.slotId === slot.id);
        const records = slot.type === 'snack' ? sortSnackSlotRecordsChronological(recordsRaw) : recordsRaw;
        if (slot.type === 'main') {
            const r = records[0];
            if (r) rows.push(mealPhotoViewerRowFromRecord(dateStr, slot, r, 1, 1));
        } else {
            records.forEach((r, idx) => {
                rows.push(mealPhotoViewerRowFromRecord(dateStr, slot, r, idx + 1, records.length));
            });
        }
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
    return slot.type === 'snack' && totalInSlot > 1 ? `${slot.label}${ordinal1Based}` : slot.label;
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

/** 좌측 140×140 사진 칸: 첫 장 + 다중 등록 시 우상단 1/n — 탭 시 전역 사진 팝업(부모 카드 onclick 전파 차단) */
function buildTimelinePhotoCellInnerHtml(urls, imgClass = 'object-cover', viewCtx = null) {
    const first = urls[0];
    if (!first) return '';
    const n = urls.length;
    const enc = encodeURIComponent(JSON.stringify(urls));
    const badge =
        n > 1
            ? `<span class="absolute top-1 right-1 z-30 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] font-bold leading-none pointer-events-none shadow-sm">1/${n}</span>`
            : '';
    const ctxAttrs =
        viewCtx && viewCtx.dateStr && viewCtx.slotId
            ? ` data-meal-view-date="${escapeHtml(String(viewCtx.dateStr))}" data-meal-view-slot="${escapeHtml(String(viewCtx.slotId))}" data-meal-view-record="${escapeHtml(viewCtx.recordId != null ? String(viewCtx.recordId) : '')}"`
            : '';
    return `<div class="absolute inset-0 overflow-hidden">
        <img src="${escapeHtml(first)}" class="absolute inset-0 z-0 h-full w-full ${imgClass} select-none pointer-events-none" alt="" draggable="false">
        ${badge}
        <button type="button" class="timeline-meal-photo-tap absolute inset-0 z-20 h-full w-full cursor-zoom-in border-0 bg-transparent p-0 active:bg-white/5" style="-webkit-tap-highlight-color:transparent" aria-label="사진 ${n}장 보기"${ctxAttrs} data-photos="${enc}" onclick="event.stopPropagation();window.openTimelineMealPhotosPopup(this);"></button>
    </div>`;
}

function buildMealTimelineViewSelectHtml(current) {
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    const mixedSel = current === 'mixed' ? ' selected' : '';
    return `<div class="flex flex-col items-center gap-0.5 flex-shrink-0">
            <label for="mealTimelineViewSelect" class="text-[10px] font-bold text-slate-500 leading-tight whitespace-nowrap text-center">식사보기</label>
            <select id="mealTimelineViewSelect" class="meal-timeline-view-select text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 max-w-[min(100%,8rem)] shadow-sm" title="식사보기: 카드·목록·자동(사진 있으면 카드, 없으면 목록)">
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
                <option value="mixed"${mixedSel}>자동</option>
            </select>
        </div>`;
}

function buildSnackTimelineViewSelectHtml(current) {
    const tagsSel = current === 'tags' ? ' selected' : '';
    const cardsSel = current === 'cards' ? ' selected' : '';
    const listSel = current === 'list' ? ' selected' : '';
    const mixedSel = current === 'mixed' ? ' selected' : '';
    return `<div class="flex flex-col items-center gap-0.5 flex-shrink-0">
            <label for="snackTimelineViewSelect" class="text-[10px] font-bold text-slate-500 leading-tight whitespace-nowrap text-center">간식보기</label>
            <select id="snackTimelineViewSelect" class="snack-timeline-view-select text-[11px] font-bold text-slate-600 bg-white border border-slate-200 rounded-lg px-2 py-1 max-w-[min(100%,10rem)] shadow-sm" title="간식보기: 태그·카드·목록·자동(건별 사진 있으면 카드, 없으면 목록)">
                <option value="tags"${tagsSel}>태그</option>
                <option value="cards"${cardsSel}>카드</option>
                <option value="list"${listSel}>목록</option>
                <option value="mixed"${mixedSel}>자동</option>
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
        tagsHtml = `<div class="clear-both mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${t}</span>`)
            .join('')}</div>`;
    }
    let iconHtml = '';
    const snackPhotoUrls = getMealPhotoUrlsForTimeline(r);
    if (snackPhotoUrls.length > 0) {
        iconHtml = buildTimelinePhotoCellInnerHtml(snackPhotoUrls, 'object-cover', { dateStr, slotId: slot.id, recordId: r.id });
    } else if (r.mealType === 'Skip') {
        iconHtml = `<i class="fa-solid fa-ban text-2xl text-slate-600" aria-hidden="true"></i>`;
    } else {
        iconHtml = `<i class="fa-solid fa-mug-saucer text-2xl text-slate-400" aria-hidden="true"></i>`;
    }
    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const blockOpen = isMealEntryRowBlocked(r);
    const openClick = blockOpen
        ? ''
        : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
    return `<div ${openClick} class="card ${cardMbClass} border border-slate-200 ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${mealCardRelativeClass(r)}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex">
            <div class="relative w-[140px] h-[140px] flex-shrink-0 overflow-hidden border-r border-slate-200 bg-slate-100 ${specificStyle.iconText} flex items-center justify-center">
                ${iconHtml}
            </div>
            <div class="flex min-w-0 flex-1 flex-col justify-center p-4">
                <div class="min-w-0 overflow-hidden">
                    <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-2">
                        <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                        <span class="flex items-center gap-0.5 rounded-full border border-yellow-300 bg-yellow-50 px-1.5 py-0.5 text-xs font-bold text-yellow-600">
                            <span class="text-[13px]">⭐</span>
                            <span class="text-[12px] font-black">${ratingVal}</span>
                        </span>
                    </div>
                    <h4 class="mb-0 flex min-w-0 items-center gap-1.5 leading-tight">${mealEntrySyncLeadHtml(r)}<span class="min-w-0 flex-1 truncate">${titleLine1}</span></h4>
                    ${titleLine2 ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-sm font-bold text-slate-600">${titleLine2}</p>` : ''}
                </div>
                ${r.comment ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-xs text-slate-400">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>` : ''}
                ${tagsHtml}
            </div>
        </div>
    </div>`;
}

function buildSnackEmptySlotCardHtml(dateStr, slot, specificStyle) {
    const safeLabel = escapeHtml(slot.label);
    /** 행 높이만 본식 카드(140px)의 1/3 — 사진 열 너비는 식사 카드와 동일 140px */
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card mb-1.5 border border-slate-200 opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
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
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card mb-1.5 border border-slate-200 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
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
    return `<div ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="card mb-1.5 border border-slate-200 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
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

/** 본식 목록형: 기록 있음 — 좌 슬롯·@장소 / 우 메뉴·코멘트·태그(카드형과 동일 float 배지 + 코멘트 clear) */
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
        tagsHtml = `<div class="clear-both mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${escapeHtml(t)}</span>`)
            .join('')}</div>`;
    }

    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const blockMainList = isMealEntryRowBlocked(r);
    const openClickMainList = blockMainList
        ? ''
        : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
    return `<div ${openClickMainList} class="card ${cardMbClass} border border-slate-200 ${listLeft} ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${mealCardRelativeClass(r)}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeSlotTitle}</span>
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col py-2 pl-3 pr-2">
                <div class="min-w-0 overflow-hidden">
                    <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-1.5">
                        <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                        <span class="flex items-center gap-0.5 rounded-full border border-yellow-300 bg-yellow-50 px-1.5 py-0.5 text-xs font-bold text-yellow-600">
                            <span class="text-[13px]">⭐</span>
                            <span class="text-[12px] font-black">${ratingVal}</span>
                        </span>
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
    const showOrdinal = totalInSlot > 1;
    const slotTitle = showOrdinal ? `${slot.label}${ordinal1Based}` : slot.label;
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
        tagsHtml = `<div class="clear-both mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags
            .map((t) => `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${escapeHtml(t)}</span>`)
            .join('')}</div>`;
    }

    const ratingVal = r.rating != null && r.rating !== '' ? r.rating : '-';
    const safeMenu = escapeHtml(menuLine || '간식');
    const listLeft = specificStyle.listLeft || SLOT_STYLES.default.listLeft;
    const pendingSnackList = isMealEntryRowBlocked(r);
    const openClickSnackList = pendingSnackList
        ? ''
        : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);

    return `<div ${openClickSnackList} class="card ${cardMbClass} border border-slate-200 ${listLeft} ${mealEntryRowPointerClass(r)} transition-all !rounded-none ${mealCardRelativeClass(r)}" data-entry-id="${escapeHtml(String(r.id))}">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${specificStyle.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeSlotTitle}</span>
                <span class="text-xs font-bold text-slate-500 leading-snug">@ ${safePlaceLine}</span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col py-2 pl-3 pr-2">
                <div class="min-w-0 overflow-hidden">
                    <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-1.5">
                        <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                        <span class="flex items-center gap-0.5 rounded-full border border-yellow-300 bg-yellow-50 px-1.5 py-0.5 text-xs font-bold text-yellow-600">
                            <span class="text-[13px]">⭐</span>
                            <span class="text-[12px] font-black">${ratingVal}</span>
                        </span>
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
    return `<span class="text-xs text-slate-700 bg-slate-50 px-2 py-1 rounded whitespace-nowrap flex-shrink-0">#${escapeHtml(tagText)}</span>`;
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
    return `<div class="clear-both mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags.join('')}</div>`;
}

function buildDailyJournalSlotHtml(dateStr) {
    const journal = getDailyJournalForTimeline(dateStr);
    const photos = Array.isArray(journal.photos) ? journal.photos.filter(Boolean) : [];
    const mealView = getMealTimelineView();
    const useListLayout =
        mealView === 'list' || (mealView === 'mixed' && photos.length === 0);

    if (useListLayout) {
        return dailyJournalHasContent(journal)
            ? buildDailyJournalListFilledHtml(dateStr, journal)
            : buildDailyJournalListEmptyHtml(dateStr);
    }
    return buildDailyJournalCardHtml(dateStr, journal);
}

function buildDailyJournalListEmptyHtml(dateStr) {
    const style = DAILY_JOURNAL_SLOT_STYLE;
    const slot = DAILY_JOURNAL_SLOT;
    const safeLabel = escapeHtml(slot.label);
    const hThird = 'h-[calc(140px/3)] min-h-[calc(140px/3)]';
    const listLeft = style.listLeft || '';
    return `<div ${dailyJournalOpenDataAttrs(dateStr)} class="card daily-journal-slot mb-1.5 border border-slate-200 ${listLeft} opacity-80 cursor-pointer active:scale-[0.98] transition-all !rounded-none">
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

    return `<div ${dailyJournalOpenDataAttrs(dateStr)} class="card daily-journal-slot mb-1.5 border border-slate-200 ${listLeft} cursor-pointer active:scale-[0.98] transition-all !rounded-none">
        <div class="flex items-stretch">
            <div class="w-[140px] min-w-[140px] flex-shrink-0 border-slate-200 ${style.iconText} bg-slate-50 flex flex-col items-center justify-center gap-1 py-3 px-2 text-center border-r">
                <span class="text-sm font-bold leading-tight break-words">${safeLabel}</span>
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

    let iconHtml = '';
    if (photos.length > 0) {
        iconHtml = buildTimelinePhotoCellInnerHtml(photos, 'object-cover', null);
    } else if (hasContent) {
        iconHtml = `<i class="fa-solid fa-book-open text-2xl ${style.iconText}"></i>`;
    } else {
        iconHtml = `<div class="flex flex-col items-center justify-center text-center px-2">
            <span class="text-3xl font-bold text-slate-400 mb-1">+</span>
            <span class="text-[10px] text-slate-400 leading-tight">입력해주세요</span>
        </div>`;
    }

    const titleLine1 = dailyJournalHasPhotos(journal)
        ? `<h4 class="mb-0 flex min-w-0 items-center gap-1.5 leading-tight">${dailyJournalPhotoSyncLeadHtml(journal)}<span class="text-sm font-bold ${style.text} min-w-0">${safeLabel}</span></h4>`
        : `<span class="text-sm font-bold ${style.text}">${safeLabel}</span>`;
    const titleLine2 = hasContent
        ? ''
        : '<span class="text-xs text-slate-400"><span class="font-bold">+</span> 기록하기</span>';
    const metricsPreview = dailyJournalMetricsSlotPreviewHtml(journal);
    const commentPreview = dailyJournalCommentPreviewHtml(comment);
    const fallbackPreview =
        !comment && !metricsPreview && hasContent
            ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-xs text-slate-400">${escapeHtml(dailyJournalSlotFallbackLine(journal))}</p>`
            : '';

    const containerClass = hasContent ? 'border-slate-200' : 'border-slate-200 opacity-80';
    const iconBoxClass = `bg-slate-100 border-slate-200 ${style.iconText}`;

    return `<div ${dailyJournalOpenDataAttrs(dateStr)} class="card daily-journal-slot mb-1.5 border ${containerClass} cursor-pointer active:scale-[0.98] transition-all !rounded-none">
        <div class="flex">
            <div class="relative w-[140px] h-[140px] flex-shrink-0 overflow-hidden border-r ${iconBoxClass} flex items-center justify-center">
                ${iconHtml}
            </div>
            <div class="flex min-w-0 flex-1 flex-col justify-center p-4">
                <div class="min-w-0">
                    ${dailyJournalHasPhotos(journal) ? titleLine1 : `<h4 class="mb-0 leading-tight">${titleLine1}</h4>`}
                    ${titleLine2 ? `<p class="mt-1.5 mb-0">${titleLine2}</p>` : ''}
                    ${commentPreview}
                    ${metricsPreview || ''}
                    ${fallbackPreview}
                </div>
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
            const target = e.target.closest('[data-mealog-open-date][data-mealog-open-slot]');
            if (!target || !root.contains(target)) {
                const dailyTarget = e.target.closest('[data-mealog-open-daily]');
                if (!dailyTarget || !root.contains(dailyTarget)) return;
                const dailyDate = dailyTarget.getAttribute('data-mealog-open-daily');
                if (!dailyDate || typeof window.openDailyJournalModal !== 'function') return;
                e.preventDefault();
                e.stopPropagation();
                window.openDailyJournalModal(dailyDate);
                return;
            }
            if (target.classList.contains('pointer-events-none')) return;
            const date = target.getAttribute('data-mealog-open-date');
            const slotId = target.getAttribute('data-mealog-open-slot');
            if (!date || !slotId || typeof window.openModal !== 'function') return;
            const entryId = target.getAttribute('data-mealog-open-entry') || null;
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
            <h3>${escapeHtml(formatMealogDateLabel(dateStr))}</h3>
            ${shareButton}
        </div>`;

        SLOTS.forEach(slot => {
            const recordsRaw = window.mealHistory.filter(m => m.date === dateStr && m.slotId === slot.id);
            const records = slot.type === 'snack' ? sortSnackSlotRecordsChronological(recordsRaw) : recordsRaw;
            if (slot.type === 'main') {
                const r = records[0];
                const specificStyle = SLOT_STYLES[slot.id] || SLOT_STYLES['default'];
                const mealView = getMealTimelineView();
                const mainMealUseListLayout =
                    mealView === 'list' ||
                    (mealView === 'mixed' &&
                        (!r || getMealPhotoUrlsForTimeline(r).length === 0));
                if (mainMealUseListLayout) {
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
                        const clockTagMain = mealClockTagLabelFromRecord(r);
                        if (clockTagMain) tags.push(clockTagMain);
                        if (r.mealType && r.mealType !== 'Skip') tags.push(r.mealType);
                        if (r.withWhomDetail) tags.push(r.withWhomDetail);
                        else if (r.withWhom && r.withWhom !== '혼자') tags.push(r.withWhom);
                        if (r.satiety) {
                            const sData = SATIETY_DATA.find(d => d.val === r.satiety);
                            if (sData) tags.push(sData.label);
                        }
                        if (tags.length > 0) {
                            tagsHtml = `<div class="clear-both mt-1.5 flex flex-nowrap gap-1 overflow-x-auto scrollbar-hide">${tags.map(t => 
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
                        iconHtml = buildTimelinePhotoCellInnerHtml(mainPhotoUrls, 'object-cover', {
                            dateStr,
                            slotId: slot.id,
                            recordId: r.id
                        });
                    } else if (r.mealType === 'Skip') {
                        iconHtml = `<i class="fa-solid fa-ban text-2xl text-slate-600"></i>`;
                    } else {
                        iconHtml = `<i class="fa-solid fa-utensils text-2xl text-slate-400"></i>`;
                    }
                }
                const mainBlockOpen = r && isMealEntryRowBlocked(r);
                const mainOpenClick = mainBlockOpen
                    ? ''
                    : mealTimelineOpenDataAttrs(dateStr, slot.id, r ? r.id : null);
                const mainPointer = !r ? 'cursor-pointer active:scale-[0.98]' : mealEntryRowPointerClass(r);
                const mainRel = r ? mealCardRelativeClass(r) : '';
                html += `<div ${mainOpenClick} class="card mb-1.5 border ${containerClass} ${mainPointer} transition-all !rounded-none ${mainRel}" ${r ? `data-entry-id="${escapeHtml(String(r.id))}"` : ''}>
                    <div class="flex">
                        <div class="relative w-[140px] h-[140px] flex-shrink-0 overflow-hidden border-r ${iconBoxClass} flex items-center justify-center">
                            ${iconHtml}
                        </div>
                        <div class="flex min-w-0 flex-1 flex-col justify-center p-4">
                            ${r ? `<div class="min-w-0 overflow-hidden">
                                <div class="float-right mb-1 ml-2 flex shrink-0 items-center gap-2">
                                    <span class="timeline-share-arrow text-xs text-slate-500" title="게시됨" style="display:${isEntryShared(r.id, r) ? 'inline' : 'none'}"><i class="fa-solid fa-share"></i></span>
                                    <span class="flex items-center gap-0.5 rounded-full border border-yellow-300 bg-yellow-50 px-1.5 py-0.5 text-xs font-bold text-yellow-600">
                                        <span class="text-[13px]">⭐</span>
                                        <span class="text-[12px] font-black">${r.rating || '-'}</span>
                                    </span>
                                </div>
                                <h4 class="mb-0 flex min-w-0 items-center gap-1.5 leading-tight">${mealEntrySyncLeadHtml(r)}<span class="min-w-0 flex-1 truncate">${titleLine1}</span></h4>
                                ${titleLine2 ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-sm font-bold text-slate-600">${titleLine2}</p>` : ''}
                            </div>` : `<div class="min-w-0">
                                <h4 class="mb-0 leading-tight">${titleLine1}</h4>
                                ${titleLine2 ? `<p class="mt-1.5 mb-0">${titleLine2}</p>` : ''}
                            </div>`}
                            ${r && r.comment ? `<p class="clear-both mt-1.5 mb-0 min-w-0 truncate text-xs text-slate-400">"${escapeHtml(r.comment).replace(/\n/g, ' ')}"</p>` : ''}
                            ${tagsHtml}
                        </div>
                    </div>
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
                                <button type="button" ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="absolute bottom-2 right-2 z-10 text-xs font-bold text-slate-600 bg-white/95 backdrop-blur-sm px-2 py-0.5 rounded-lg border border-slate-200 active:scale-95 transition-transform" aria-label="${escapeHtml(slot.label)} 추가">+ 추가</button>
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
                                    <button type="button" ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="absolute bottom-2 right-2 z-10 text-xs font-bold text-slate-600 bg-white/95 backdrop-blur-sm px-2 py-0.5 rounded-lg border border-slate-200 active:scale-95 transition-transform" aria-label="${escapeHtml(slot.label)} 추가">+ 추가</button>
                                </div>`;
                            } else {
                                html += rowHtml;
                            }
                        });
                        html += `</div>`;
                    } else {
                        html += buildSnackListEmptyRowHtml(dateStr, slot, specificStyle);
                    }
                } else if (snackView === 'mixed') {
                    if (records.length > 0) {
                        html += `<div class="snack-slot-mixed-group">`;
                        records.forEach((r, idx) => {
                            const isLast = idx === records.length - 1;
                            const hasPhotos = getMealPhotoUrlsForTimeline(r).length > 0;
                            const mb = isLast ? 'mb-0' : 'mb-1.5';
                            let blockHtml;
                            if (hasPhotos) {
                                blockHtml = buildSnackTimelineCardHtml(
                                    dateStr,
                                    slot,
                                    r,
                                    specificStyle,
                                    mb,
                                    idx + 1,
                                    records.length
                                );
                            } else {
                                blockHtml = buildSnackListFilledRowHtml(
                                    dateStr,
                                    slot,
                                    r,
                                    specificStyle,
                                    mb,
                                    idx + 1,
                                    records.length
                                );
                            }
                            if (isLast) {
                                html += `<div class="relative mb-1.5">
                                    ${blockHtml}
                                    <button type="button" ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="absolute bottom-2 right-2 z-10 text-xs font-bold text-slate-600 bg-white/95 backdrop-blur-sm px-2 py-0.5 rounded-lg border border-slate-200 active:scale-95 transition-transform" aria-label="${escapeHtml(slot.label)} 추가">+ 추가</button>
                                </div>`;
                            } else {
                                html += blockHtml;
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
                            const tagDeleteFailed = isMealEntryDeleteFailed(r);
                            const tagPending = isMealEntryPendingSync(r);
                            const tagRedoable = isMealEntrySyncRedoable(r);
                            const tagBusy = tagDeleting || tagPending;
                            const tagClick = tagBusy
                                ? ''
                                : mealTimelineOpenDataAttrs(dateStr, slot.id, r.id);
                            const tagCls = tagDeleting
                                ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-wait pointer-events-none opacity-90'
                                : tagDeleteFailed
                                  ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-pointer active:bg-slate-50 ring-1 ring-amber-200/90'
                                : tagPending
                                  ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-wait pointer-events-none opacity-90'
                                  : tagRedoable
                                    ? 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-pointer active:bg-slate-50 ring-1 ring-red-200/90'
                                    : 'snack-tag relative inline-flex items-center gap-0.5 rounded-md cursor-pointer active:bg-slate-50';
                            return `<div ${tagClick} class="${tagCls}" data-entry-id="${escapeHtml(String(r.id))}">
                                ${buildSnackTagRowInnerHtml(r)}
                            </div>`;
                        }).join('') : `<span class="text-xs text-slate-400 italic">기록없음</span>`}
                        <button type="button" ${mealTimelineOpenDataAttrs(dateStr, slot.id)} class="text-xs font-bold text-slate-600 bg-slate-100 px-2.5 py-1.5 rounded-lg border border-slate-200 transition-colors">+ 추가</button>
                    </div>
                </div>`;
                }
            }
        });
        html += buildDailyJournalSlotHtml(dateStr);
        section.innerHTML = html;
        insertTimelineDateSectionInChronologicalOrder(container, section, dateStr);
        pendingTimelineSectionRebuildDates.delete(dateStr);
    });

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

    ensureTimelineOpenModalDelegation();
    ensureTimelineViewSelectDelegation();
    syncSnackViewDropdown(container);

    if (typeof window.bindMealogDailyTimelineDelegation === 'function') {
        window.bindMealogDailyTimelineDelegation();
    }

    updateTimelineMealEntryPendingIndicators();
    updateTrackerStreakLabel();
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
        // 데이터 리스너 재렌더마다 가로 스크롤이 계속 움직이지 않도록,
        // 같은 날짜(activeStr)로는 짧은 시간 내 자동 scrollIntoView를 1회로 제한
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
