/**
 * 메모 기록 시트 (docs/user-memo-items.md §4.4)
 *
 * 축이 셋뿐이다 — 시간·내용·사진. 식사 시트(9축)를 재사용하면 빈 칸이
 * 대부분이라 따로 두되, **부품은 전부 기존 것**을 쓴다: 시계 휠, 사진 고르기,
 * Storage 업로드, 그리고 저장은 `dbOps.save` 그대로.
 *
 * 저장기를 새로 파지 않는 것이 이 파일의 유일한 규칙이다 — 아웃박스 내구화가
 * 거기 있다(docs/sync-outbox-design.md §1). 여기서 두 번째 경로를 만들면
 * 그 불변식이 두 벌이 된다.
 */
import { dbOps, generateMealDocId } from '../db.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { scheduleLucideIcons } from '../icons.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { uploadBase64ToStorage } from '../utils.js';
import { isDemoUser } from '../demo-account.js';
import { pickCameraImage, pickGalleryImages } from '../utils/image-source-picker.js';
import { openMealClockWheelPanel } from '../meal-clock-wheel-picker.js';
import {
    mealClock24ToAmPmAndDisplay,
    mealClock24FromAmPmClock,
    normalizeMealClockInputValue,
    normalizeMealClock12InputValue,
    formatMealClock12TextWhileTyping
} from '../meal-time-utils.js';
import { findSlotByKey, defaultMemoItemByKey, memoIconOrDefault, MEMO_SLOT_ID, MEMO_MEAL_ID_PREFIX, DEFAULT_MEMO_LABEL, DEFAULT_MEMO_ICON } from '../utils/slot-plan.js';
import { RECORD_MAX_PHOTOS } from '../constants.js';

let bound = false;
/** 편집 중 상태 — 열려 있을 때만 유효 */
let state = null;

function localTodayIso() {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * 시각 칸을 24시 'HH:mm' 에서 다시 그린다 — 끜니 시트의
 * `applyMealClockRowFrom24` 와 같은 수다(오전/오후 select + 12시 표시).
 */
function syncClockRow() {
    const sel = document.getElementById('memoRecordAmpm');
    const txt = document.getElementById('memoRecordTimeInput');
    const { ampm, display } = mealClock24ToAmPmAndDisplay(state.clock || '12:00');
    if (sel) sel.value = ampm;
    if (txt) txt.value = display;
}

/** 입력칸·select 에서 읽은 24시 'HH:mm' — 못 읽으면 빈 문자열 */
function readClockFromRow() {
    const sel = document.getElementById('memoRecordAmpm');
    const txt = document.getElementById('memoRecordTimeInput');
    const raw = mealClock24FromAmPmClock(sel?.value === 'am' ? 'am' : 'pm', txt?.value || '');
    return normalizeMealClockInputValue(raw || '');
}

function nowHHmm() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 그 메모 항목의 이름·아이콘·단위 — 지운 항목이어도 retired 가 답한다 (§2.3) */
function memoItemView(slotKey) {
    /**
     * plan 에 없으면 **기본 정의**로 떨어진다(§2.6). 이게 없으면 개정판을
     * 한 번도 안 쓴 사용자가 체중을 누를 때 제목이 '메모'가 되고
     * 단위가 없어 **값 칸이 아예 안 나온다.**
     */
    const found =
        findSlotByKey(window.userSettings?.slotPlan || null, slotKey, localTodayIso()) ||
        defaultMemoItemByKey(slotKey);
    return {
        label: found?.label || DEFAULT_MEMO_LABEL,
        icon: memoIconOrDefault(found?.icon),
        // 단위가 있으면 숫자 메모다 (§2.7)
        unit: typeof found?.unit === 'string' ? found.unit : '',
        decimals: found?.decimals === 1 ? 1 : 0
    };
}

/** 숫자 메모의 표시 문자열 — 소수 자릿수만큼만 */
function formatMemoValue(value, decimals) {
    if (!Number.isFinite(value)) return '';
    return decimals === 1 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
}

/* ── 렌더 ─────────────────────────────────────────────────── */

function renderPhotos() {
    const wrap = document.getElementById('memoRecordPhotoPreviews');
    const countEl = document.getElementById('memoRecordPhotoCount');
    if (countEl) countEl.textContent = `${state.photos.length}/${RECORD_MAX_PHOTOS}`;
    if (!wrap) return;
    wrap.innerHTML = state.photos
        .map(
            (src, i) => `<span class="memo-record__thumb">
                <img src="${escapeHtml(src)}" alt="" />
                <button type="button" class="memo-record__thumb-del" data-photo-idx="${i}" aria-label="사진 빼기">
                    <i data-lucide="x" aria-hidden="true"></i>
                </button>
            </span>`
        )
        .join('');
    scheduleLucideIcons(wrap);
}

function renderHead() {
    const iconEl = document.getElementById('memoRecordIcon');
    const titleEl = document.getElementById('memoRecordTitle');
    if (titleEl) titleEl.textContent = state.label;
    if (iconEl) {
        iconEl.innerHTML = `<i data-lucide="${escapeHtml(state.icon || DEFAULT_MEMO_ICON)}" aria-hidden="true"></i>`;
        scheduleLucideIcons(iconEl);
    }
    syncClockRow();
    const delBtn = document.getElementById('memoRecordDeleteBtn');
    if (delBtn) delBtn.classList.toggle('hidden', !state.editingId);
    const text = document.getElementById('memoRecordText');
    if (text) text.value = state.comment;

    /**
     * 값 칸은 **숫자 메모에만** 나온다(§2.7). 내용 위에 두는 것은
     * 숫자가 그 기록의 본체기 때문이다.
     */
    const valueRow = document.getElementById('memoRecordValueRow');
    const valueInput = document.getElementById('memoRecordValue');
    const unitEl = document.getElementById('memoRecordUnit');
    const numeric = !!state.unit;
    if (valueRow) valueRow.classList.toggle('hidden', !numeric);
    if (unitEl) unitEl.textContent = state.unit || '';
    if (valueInput) {
        valueInput.value = state.value != null ? formatMemoValue(state.value, state.decimals) : '';
        // 직전 값을 흐릿하게 깔아 둔다 — 넣어 주지는 않는다(안 고치고 저장하면 거짓 기록)
        valueInput.placeholder = numeric ? lastValuePlaceholder() : '0';
    }
}

/** 그 항목의 가장 최근 값 — 대개 비슷한 값을 넣는다 */
function lastValuePlaceholder() {
    const key = state.slotKey;
    if (!key) return '0';
    let best = null;
    for (const m of window.mealHistory || []) {
        if (!m || m.slotId !== MEMO_SLOT_ID || m.slotKey !== key) continue;
        if (m.id === state.editingId) continue;
        if (!Number.isFinite(Number(m.value))) continue;
        const stamp = `${m.date || ''} ${m.time || ''}`;
        if (!best || stamp > best.stamp) best = { stamp, value: Number(m.value) };
    }
    return best ? formatMemoValue(best.value, state.decimals) : '0';
}

/* ── 열기/닫기 ────────────────────────────────────────────── */

/**
 * @param {string} dateIso YYYY-MM-DD
 * @param {string} slotKey 메모 항목 key
 * @param {string|null} [entryId] 있으면 그 건의 수정, 없으면 **늘 새 기록** (§4.4)
 */
export function openMemoRecordModal(dateIso, slotKey, entryId = null) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    const modal = document.getElementById('memoRecordModal');
    if (!modal) return;

    const existing = entryId
        ? (window.mealHistory || []).find((m) => m && String(m.id) === String(entryId))
        : null;
    const key = existing?.slotKey || slotKey || '';
    const view = memoItemView(key);

    state = {
        dateIso: /^\d{4}-\d{2}-\d{2}$/.test(dateIso) ? dateIso : localTodayIso(),
        slotKey: key,
        label: view.label,
        icon: view.icon,
        editingId: existing ? String(existing.id) : '',
        unit: view.unit,
        decimals: view.decimals,
        value: Number.isFinite(Number(existing?.value)) && existing?.value !== '' && existing?.value != null
            ? Number(existing.value)
            : null,
        comment: String(existing?.comment || ''),
        photos: Array.isArray(existing?.photos) ? existing.photos.filter(Boolean).slice(0, RECORD_MAX_PHOTOS) : [],
        photoAspectRatio: existing?.photoAspectRatio || '1:1',
        // 새 기록의 기본 시각은 **지금** — 시각이 늘 있어야 §3.3 이 성립한다
        clock: normalizeExistingClock(existing) || nowHHmm(),
        saving: false
    };

    renderHead();
    renderPhotos();
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    lockBodyScroll('memoRecord');
}

/** 저장된 기록의 시각 — time('HH:mm:ss') 우선, 없으면 빈 문자열 */
function normalizeExistingClock(record) {
    const raw = String(record?.time || '').trim();
    const m = /^(\d{1,2}):(\d{2})/.exec(raw);
    if (!m) return '';
    return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

export function closeMemoRecordModal() {
    const modal = document.getElementById('memoRecordModal');
    if (!modal) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal.contains(active)) active.blur();
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    state = null;
    unlockBodyScroll('memoRecord');
}

/* ── 편집 ─────────────────────────────────────────────────── */

function openTimePicker() {
    if (!state) return;
    // 입력칸을 고치다 휠을 열면 **방금 친 값**에서 시작해야 한다
    const fromRow = readClockFromRow();
    if (fromRow) state.clock = fromRow;
    const [h, m] = state.clock.split(':').map(Number);
    const seed = new Date();
    seed.setHours(Number.isFinite(h) ? h : 12, Number.isFinite(m) ? m : 0, 0, 0);
    openMealClockWheelPanel({
        initialDate: seed,
        onApply: (date) => {
            if (!state) return;
            state.clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            syncClockRow();
        }
    });
}

async function pickPhotos(source) {
    if (!state) return;
    const remaining = RECORD_MAX_PHOTOS - state.photos.length;
    if (remaining <= 0) {
        showToast(`사진은 최대 ${RECORD_MAX_PHOTOS}장까지 넣을 수 있어요.`, 'error');
        return;
    }
    const files =
        source === 'camera' ? await pickCameraImage({ facing: 'environment' }) : await pickGalleryImages({ multiple: true });
    const list = Array.from(files || []).filter((f) => f?.type?.startsWith?.('image/')).slice(0, remaining);
    if (!list.length) return;
    const read = await Promise.all(
        list.map(
            (f) =>
                new Promise((resolve) => {
                    const r = new FileReader();
                    r.onload = (ev) => resolve(ev.target?.result || null);
                    r.onerror = () => resolve(null);
                    r.readAsDataURL(f);
                })
        )
    );
    if (!state) return;
    read.filter(Boolean).forEach((src) => {
        if (state.photos.length < RECORD_MAX_PHOTOS) state.photos.push(src);
    });
    renderPhotos();
}

/** data:/blob: 사진만 Storage 로 올리고 URL 로 바꾼다 — 하루 소감과 같은 경로 */
async function materializePhotos(photos, dateStr) {
    const uid = window.currentUser?.uid;
    if (!uid) return [];
    const out = [];
    for (const p of photos) {
        if (typeof p === 'string' && (p.startsWith('data:image') || p.startsWith('blob:'))) {
            out.push(await uploadBase64ToStorage(p, uid, `memo_${dateStr}`, 1024));
        } else if (typeof p === 'string' && p) {
            out.push(p);
        }
    }
    return out;
}

/* ── 저장·삭제 ────────────────────────────────────────────── */

async function onSave() {
    if (!state || state.saving) return;
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 기록할 수 없습니다.', 'error');
        return;
    }
    state.saving = true;
    const saveBtn = document.getElementById('memoRecordSaveBtn');
    if (saveBtn) saveBtn.disabled = true;

    // blur 없이 저장을 누를 수 있다 — 입력칸을 한 번 더 집는다
    const typed = readClockFromRow();
    if (typed) state.clock = typed;
    const comment = String(document.getElementById('memoRecordText')?.value || '').trim().slice(0, 300);

    /**
     * 숫자 메모는 값이 없으면 저장하지 않는다. 텍스트 메모의 빈 저장은
     * "있었다"라는 뜻이지만(§4.6), 숫자 메모의 빈 값은 아무 뜻이 없다.
     */
    let value = null;
    if (state.unit) {
        const raw = String(document.getElementById('memoRecordValue')?.value || '').trim().replace(/,/g, '');
        const num = Number(raw);
        if (!raw || !Number.isFinite(num) || num < 0) {
            state.saving = false;
            if (saveBtn) saveBtn.disabled = false;
            showToast('값을 적어 주세요.', 'error');
            document.getElementById('memoRecordValue')?.focus();
            return;
        }
        value = state.decimals === 1 ? Math.round(num * 10) / 10 : Math.round(num);
    }

    const snapshot = { ...state, comment, value };
    closeMemoRecordModal();

    try {
        const photos = await materializePhotos(snapshot.photos, snapshot.dateIso);
        const isNew = !snapshot.editingId;
        /**
         * 문서 ID 에 'memo_' 를 붙인다 — 본문 없이 ID 만 아는 자리(삭제·아웃박스
         * 워커)에서 mealCount 를 깎을지 판정하는 유일한 근거다 (§6).
         */
        const id = isNew
            ? `${MEMO_MEAL_ID_PREFIX}${generateMealDocId(window.currentUser?.uid) || Date.now().toString(36)}`
            : snapshot.editingId;
        const record = {
            id,
            date: snapshot.dateIso,
            slotId: MEMO_SLOT_ID,
            slotKey: snapshot.slotKey || null,
            /**
             * 기록 당시의 항목 이름을 **문서에 함께 적는다** (user-memo-items §6.1).
             * 앱 화면은 key 로 이름을 풀지만(그래서 이름 수정이 소급된다), 관리자
             * 모니터링은 그 사용자의 slotPlan 을 손에 쥐고 있지 않다 — 미러가
             * 담는 것은 분석이 쓰는 몇 필드뿐이다. 행마다 설정을 읽어 오는 대신
             * 한 필드를 같이 적는다. 화면 표시에는 쓰지 않는다.
             */
            memoLabel: snapshot.label,
            comment,
            photos,
            photoAspectRatio: snapshot.photoAspectRatio,
            mealClock: snapshot.clock,
            time: `${snapshot.clock}:00`,
            updatedAt: new Date().toISOString()
        };
        // 숫자 메모만 value 를 갖는다 — 없는 필드는 없는 채로 둔다
        if (snapshot.value != null) record.value = snapshot.value;
        if (isNew) record.recordedAt = new Date().toISOString();

        await dbOps.save(record, false, { isNewRecord: isNew });

        // 낙관 반영 — 리스너가 따라오기 전에 타임라인이 이미 옳게 보인다
        const hist = (window.mealHistory || []).filter((m) => String(m?.id) !== String(id));
        window.mealHistory = [...hist, record].sort(
            (a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
        );
        refreshTimelineSoon();
    } catch (e) {
        console.error('[memo] 저장 실패:', e);
        showToast('메모를 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.', 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function onDelete() {
    if (!state || !state.editingId) return;
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 삭제할 수 없습니다.', 'error');
        return;
    }
    const id = state.editingId;
    closeMemoRecordModal();
    try {
        window.mealHistory = (window.mealHistory || []).filter((m) => String(m?.id) !== String(id));
        refreshTimelineSoon();
        await dbOps.delete(id);
        showToast('메모를 지웠어요.', 'success');
    } catch (e) {
        console.error('[memo] 삭제 실패:', e);
        showToast('메모를 지우지 못했어요.', 'error');
    }
}

/** 타임라인 전체 다시 그리기 — 탭 전환과 같은 패턴 */
function refreshTimelineSoon() {
    if (typeof window.renderTimeline !== 'function') return;
    try {
        window.loadedDates = [];
        const c = document.getElementById('timelineContainer');
        if (c) c.innerHTML = '';
        window.renderTimeline();
    } catch (_) {
        /* 렌더 실패는 다음 갱신에서 복구 */
    }
}

/* ── 바인딩 ───────────────────────────────────────────────── */

function bindOnce() {
    if (bound) return;
    bound = true;
    const modal = document.getElementById('memoRecordModal');
    if (!modal) return;
    modal.querySelector('#memoRecordBackdrop')?.addEventListener('click', closeMemoRecordModal);
    modal.querySelector('#memoRecordCloseBtn')?.addEventListener('click', closeMemoRecordModal);
    modal.querySelector('#memoRecordTimeBtn')?.addEventListener('click', openTimePicker);

    /**
     * 직접 입력 — 끜니 시트와 같은 규칙이다.
     * 치는 동안에는 '1230' → '12:30' 으로 모양만 잡아 주고(값 판정은 안 한다),
     * 떠날 때 한 번 정리한다 — '9' 만 적고 나가면 09:00 으로 읽는다.
     */
    const timeInput = modal.querySelector('#memoRecordTimeInput');
    timeInput?.addEventListener('focus', () => {
        requestAnimationFrame(() => {
            try {
                timeInput.select();
            } catch (_) {
                /* 일부 브라우저에서만 던진다 */
            }
        });
    });
    timeInput?.addEventListener('input', () => {
        const next = formatMealClock12TextWhileTyping(timeInput.value);
        if (timeInput.value !== next) timeInput.value = next;
    });
    timeInput?.addEventListener('blur', () => {
        if (!state) return;
        const d = timeInput.value.replace(/\D/g, '').slice(0, 4);
        if (!d.length) {
            // 비워 두면 직전 값으로 되돌린다 — 자리를 정하는 값이라 비울 수 없다(§3.3)
            syncClockRow();
            return;
        }
        const candidate = d.length <= 2 ? `${d.padStart(2, '0')}:00` : `${d.slice(0, 2)}:${d.slice(2).padEnd(2, '0').slice(0, 2)}`;
        const n12 = normalizeMealClock12InputValue(candidate);
        const sel = document.getElementById('memoRecordAmpm');
        const raw24 = n12 ? mealClock24FromAmPmClock(sel?.value === 'am' ? 'am' : 'pm', n12) : '';
        const n24 = normalizeMealClockInputValue(raw24 || '');
        if (n24) state.clock = n24;
        syncClockRow();
    });
    timeInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            timeInput.blur();
        }
    });
    modal.querySelector('#memoRecordAmpm')?.addEventListener('change', () => {
        if (!state) return;
        const n24 = readClockFromRow();
        if (n24) state.clock = n24;
        syncClockRow();
    });
    modal.querySelector('#memoRecordCameraBtn')?.addEventListener('click', () => void pickPhotos('camera'));
    modal.querySelector('#memoRecordAlbumBtn')?.addEventListener('click', () => void pickPhotos('gallery'));
    modal.querySelector('#memoRecordSaveBtn')?.addEventListener('click', () => void onSave());
    modal.querySelector('#memoRecordDeleteBtn')?.addEventListener('click', () => void onDelete());
    modal.querySelector('#memoRecordPhotoPreviews')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-photo-idx]');
        if (!btn || !state) return;
        const idx = Number(btn.getAttribute('data-photo-idx'));
        if (Number.isFinite(idx)) {
            state.photos.splice(idx, 1);
            renderPhotos();
        }
    });
}

export function initMemoRecordModal() {
    bindOnce();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMemoRecordModal, { once: true });
    } else {
        initMemoRecordModal();
    }
}

window.openMemoRecordModal = openMemoRecordModal;
window.closeMemoRecordModal = closeMemoRecordModal;
