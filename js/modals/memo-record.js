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
import { mealClock24ToAmPmAndDisplay } from '../meal-time-utils.js';
import { findSlotByKey, memoIconOrDefault, MEMO_SLOT_ID, MEMO_MEAL_ID_PREFIX, DEFAULT_MEMO_LABEL, DEFAULT_MEMO_ICON } from '../utils/slot-plan.js';
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

/** 'HH:mm' → '오전 7:20' 표시 문자열 */
function clockDisplay(hhmm24) {
    const { ampm, display } = mealClock24ToAmPmAndDisplay(hhmm24 || '12:00');
    const [h = '12', m = '00'] = String(display || '12:00').split(':');
    return `${ampm === 'pm' ? '오후' : '오전'} ${Number(h)}:${m}`;
}

function nowHHmm() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 그 메모 항목의 이름·아이콘 — 지운 항목이어도 retired 가 답한다 (§2.3) */
function memoItemView(slotKey) {
    const found = findSlotByKey(window.userSettings?.slotPlan || null, slotKey, localTodayIso());
    return {
        label: found?.label || DEFAULT_MEMO_LABEL,
        icon: memoIconOrDefault(found?.icon)
    };
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
    const timeBtn = document.getElementById('memoRecordTimeBtn');
    if (timeBtn) timeBtn.textContent = clockDisplay(state.clock);
    const delBtn = document.getElementById('memoRecordDeleteBtn');
    if (delBtn) delBtn.classList.toggle('hidden', !state.editingId);
    const text = document.getElementById('memoRecordText');
    if (text) text.value = state.comment;
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
    const [h, m] = state.clock.split(':').map(Number);
    const seed = new Date();
    seed.setHours(Number.isFinite(h) ? h : 12, Number.isFinite(m) ? m : 0, 0, 0);
    openMealClockWheelPanel({
        initialDate: seed,
        onApply: (date) => {
            if (!state) return;
            state.clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            renderHead();
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

    const comment = String(document.getElementById('memoRecordText')?.value || '').trim().slice(0, 300);
    const snapshot = { ...state, comment };
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
