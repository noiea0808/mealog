// 하루 소감(하루 기록) 전용 모달 — 사진 + Comment + 체중/혈당
import { appState } from '../state.js';
import { dbOps } from '../db.js';
import { showToast } from '../ui.js';
import { uploadBase64ToStorage } from '../utils.js';
import {
    getDailyJournalFromSettings,
    normalizeDailyJournalEntry,
    dailyJournalHasContent,
    getDailyJournalShareEntryId,
    isDailyJournalShared
} from '../utils/daily-journal-data.js';
import { formatMealogDateLabel } from '../utils/date-label.js';
import { invalidateTimelineDateSection, updateTimelineShareIndicators } from '../render/index.js';
import { isDemoUser } from '../demo-account.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import {
    mealClock24FromAmPmClock,
    mealClock24ToAmPmAndDisplay,
    formatMealClock12TextWhileTyping
} from '../meal-time-utils.js';
import { pickCameraImage, pickGalleryImages, setPhotoAddButtonsEnabled } from '../utils/image-source-picker.js';

const MAX_DAILY_JOURNAL_PHOTOS = 5;
const MAX_DAILY_JOURNAL_METRIC_RECORDS = 3;
const PHOTO_ASPECT_OPTIONS = ['1:1', '3:4', '4:3'];

const METRIC_CONFIG = {
    weight: {
        containerId: 'dailyJournalWeightRecords',
        toggleId: 'dailyJournalWeightToggle',
        offLayerId: 'dailyJournalWeightOffLayer',
        addBtnId: 'dailyJournalWeightAddBtn',
        unit: 'kg',
        placeholder: '',
        step: '0.1',
        inputMode: 'decimal'
    },
    bloodSugar: {
        containerId: 'dailyJournalBloodSugarRecords',
        toggleId: 'dailyJournalBloodSugarToggle',
        offLayerId: 'dailyJournalBloodSugarOffLayer',
        addBtnId: 'dailyJournalBloodSugarAddBtn',
        unit: 'mg/dL',
        placeholder: '',
        step: '1',
        inputMode: 'numeric'
    }
};

let dailyJournalMetricsDelegationBound = false;

function emptyMetricRow() {
    return { value: '', time: '' };
}

function getDailyJournalAspectCss() {
    const ratio = appState.dailyJournalPhotoAspectRatio || '1:1';
    if (ratio === '3:4') return '3/4';
    if (ratio === '4:3') return '4/3';
    return '1';
}

function syncDailyJournalAspectButtons() {
    const ratio = appState.dailyJournalPhotoAspectRatio || '1:1';
    document.querySelectorAll('.aspect-btn-daily-journal').forEach((btn) => {
        const ar = btn.getAttribute('data-aspect');
        const active = ar === ratio;
        btn.classList.toggle('bg-white', active);
        btn.classList.toggle('text-slate-900', active);
        btn.classList.toggle('border-slate-900', active);
        btn.classList.toggle('border-slate-200', !active);
        btn.classList.toggle('text-slate-600', !active);
        btn.classList.remove('bg-slate-800', 'text-white', 'border-slate-800');
    });
}

function metricStateKey(type) {
    return type === 'weight' ? 'dailyJournalWeightRecords' : 'dailyJournalBloodSugarRecords';
}

function metricEnabledKey(type) {
    return type === 'weight' ? 'dailyJournalWeightEnabled' : 'dailyJournalBloodSugarEnabled';
}

function ensureMetricState(type) {
    const key = metricStateKey(type);
    if (!Array.isArray(appState[key])) {
        appState[key] = [emptyMetricRow()];
    }
    if (appState[key].length === 0) {
        appState[key].push(emptyMetricRow());
    }
}

function syncMetricToggleUi(type) {
    const cfg = METRIC_CONFIG[type];
    const enabled = appState[metricEnabledKey(type)] === true;
    const toggle = document.getElementById(cfg.toggleId);
    const offLayer = document.getElementById(cfg.offLayerId);
    const addBtn = document.getElementById(cfg.addBtnId);
    const container = document.getElementById(cfg.containerId);
    if (toggle) toggle.checked = enabled;
    if (offLayer) {
        offLayer.classList.toggle('hidden', enabled);
        offLayer.setAttribute('aria-hidden', enabled ? 'true' : 'false');
    }
    const disabled = !enabled;
    const rowCount = (appState[metricStateKey(type)] || []).length;
    const atMax = rowCount >= MAX_DAILY_JOURNAL_METRIC_RECORDS;
    if (addBtn) {
        addBtn.disabled = disabled || atMax;
        addBtn.classList.toggle('opacity-50', disabled || atMax);
        addBtn.classList.toggle('pointer-events-none', disabled || atMax);
    }
    if (container) {
        container.querySelectorAll('input, select, button.daily-journal-metric-remove').forEach((el) => {
            el.disabled = disabled;
            el.classList.toggle('opacity-60', disabled);
        });
    }
}

function buildMetricRowHtml(type, idx, row) {
    const cfg = METRIC_CONFIG[type];
    const value = row?.value != null && row.value !== '' ? String(row.value) : '';
    const storedTime = row?.time || '';
    const { ampm, display } = mealClock24ToAmPmAndDisplay(storedTime);
    const rowCount = (appState[metricStateKey(type)] || []).length;
    const clearOnly = rowCount <= 1;
    return `<div class="daily-journal-metric-row flex items-center gap-0.5 rounded-md border border-slate-200/90 bg-white p-0.5" data-metric-type="${type}" data-metric-index="${idx}">
        <input type="number" min="0" step="${cfg.step}" inputmode="${cfg.inputMode}"
            value="${value.replace(/"/g, '&quot;')}"
            placeholder="—"
            class="daily-journal-metric-value daily-journal-metric-no-spin shrink-0 w-[34%] max-w-[3.75rem] min-w-[2.5rem] py-1 px-1 bg-slate-50 rounded border-0 text-sm font-bold text-slate-800 outline-none focus:ring-0 tabular-nums text-center"
            aria-label="${type === 'weight' ? '체중' : '혈당'}">
        <div class="daily-journal-metric-time-wrap flex min-w-0 flex-1 items-stretch overflow-hidden rounded bg-slate-100">
            <select class="daily-journal-metric-ampm shrink-0 max-w-[2.65rem] border-0 border-r border-slate-200/80 bg-slate-100 py-1 pl-0.5 pr-0 text-[10px] font-extrabold leading-tight text-slate-600 outline-none focus:ring-0"
                aria-label="${type === 'weight' ? '체중' : '혈당'} 오전 또는 오후">
                <option value="am"${ampm === 'am' ? ' selected' : ''}>오전</option>
                <option value="pm"${ampm === 'pm' ? ' selected' : ''}>오후</option>
            </select>
            <input type="text" inputmode="numeric" maxlength="5" autocomplete="off" spellcheck="false"
                value="${escapeHtml(display)}"
                placeholder="시:분"
                class="daily-journal-metric-time min-w-0 flex-1 py-1 px-0.5 bg-slate-100 border-0 text-sm font-bold text-slate-800 outline-none focus:ring-0 tabular-nums text-center"
                aria-label="${type === 'weight' ? '체중' : '혈당'} 기록 시간 (선택)">
        </div>
        <button type="button" class="daily-journal-metric-remove shrink-0 w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:bg-slate-200" data-metric-type="${type}" data-metric-index="${idx}" data-metric-clear-only="${clearOnly ? '1' : '0'}" aria-label="${clearOnly ? '입력 초기화' : '기록 삭제'}"><i class="fa-solid fa-xmark text-[10px]"></i></button>
    </div>`;
}

function readMetricTimeFromRowEl(rowEl) {
    const ampmEl = rowEl.querySelector('.daily-journal-metric-ampm');
    const timeEl = rowEl.querySelector('.daily-journal-metric-time');
    const display = timeEl ? timeEl.value.trim() : '';
    if (!display) return '';
    const ampm = ampmEl?.value === 'am' ? 'am' : 'pm';
    return mealClock24FromAmPmClock(ampm, display) || '';
}

function readMetricRowsFromDom(type) {
    const cfg = METRIC_CONFIG[type];
    const container = document.getElementById(cfg.containerId);
    if (!container) return appState[metricStateKey(type)] || [];
    const rows = [];
    container.querySelectorAll('.daily-journal-metric-row').forEach((rowEl) => {
        const valueEl = rowEl.querySelector('.daily-journal-metric-value');
        rows.push({
            value: valueEl ? valueEl.value : '',
            time: readMetricTimeFromRowEl(rowEl)
        });
    });
    return rows.length ? rows : [emptyMetricRow()];
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function syncMetricRowsFromDom(type) {
    appState[metricStateKey(type)] = readMetricRowsFromDom(type);
}

export function renderDailyJournalMetricRows(type, { skipDomSync = false } = {}) {
    if (!METRIC_CONFIG[type]) return;
    const cfg = METRIC_CONFIG[type];
    const container = document.getElementById(cfg.containerId);
    if (!skipDomSync && container?.querySelector('.daily-journal-metric-row')) {
        syncMetricRowsFromDom(type);
    }
    ensureMetricState(type);
    const rows = appState[metricStateKey(type)];
    if (rows.length > MAX_DAILY_JOURNAL_METRIC_RECORDS) {
        appState[metricStateKey(type)] = rows.slice(0, MAX_DAILY_JOURNAL_METRIC_RECORDS);
    }

    if (!container) return;
    const displayRows = appState[metricStateKey(type)];
    container.innerHTML = displayRows.map((row, idx) => buildMetricRowHtml(type, idx, row)).join('');
    syncMetricToggleUi(type);
}

export function renderDailyJournalAllMetrics() {
    renderDailyJournalMetricRows('weight');
    renderDailyJournalMetricRows('bloodSugar');
}

function setDailyJournalMetricEnabled(type, enabled) {
    appState[metricEnabledKey(type)] = enabled === true;
    if (enabled) {
        ensureMetricState(type);
        renderDailyJournalMetricRows(type);
    } else {
        syncMetricToggleUi(type);
    }
}

export function addDailyJournalMetricRecord(type) {
    if (!METRIC_CONFIG[type] || appState[metricEnabledKey(type)] !== true) return;
    syncMetricRowsFromDom(type);
    const rows = appState[metricStateKey(type)];
    if (rows.length >= MAX_DAILY_JOURNAL_METRIC_RECORDS) {
        showToast(`최대 ${MAX_DAILY_JOURNAL_METRIC_RECORDS}개까지 추가할 수 있습니다.`, 'info');
        return;
    }
    rows.push(emptyMetricRow());
    renderDailyJournalMetricRows(type, { skipDomSync: true });
}

export function removeDailyJournalMetricRecord(type, index) {
    if (!METRIC_CONFIG[type]) return;
    syncMetricRowsFromDom(type);
    const rows = appState[metricStateKey(type)];
    if (!Array.isArray(rows) || rows.length === 0) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= rows.length) return;
    if (rows.length <= 1) {
        rows[0] = emptyMetricRow();
        renderDailyJournalMetricRows(type, { skipDomSync: true });
        return;
    }
    rows.splice(i, 1);
    renderDailyJournalMetricRows(type, { skipDomSync: true });
}

function collectMetricRecordsFromDom(type) {
    if (appState[metricEnabledKey(type)] !== true) return [];
    const rows = readMetricRowsFromDom(type);
    const out = [];
    for (const row of rows) {
        const raw = row?.value;
        if (raw === '' || raw == null) continue;
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) continue;
        let time = typeof row.time === 'string' ? row.time.trim() : '';
        if (time && !/^\d{2}:\d{2}$/.test(time)) time = '';
        out.push({ value, time });
    }
    return out;
}

function ensureDailyJournalMetricsDelegation() {
    if (dailyJournalMetricsDelegationBound) return;
    dailyJournalMetricsDelegationBound = true;
    const modal = document.getElementById('dailyJournalModal');
    if (!modal) return;

    modal.addEventListener('change', (e) => {
        const t = e.target;
        if (t?.id === 'dailyJournalWeightToggle') {
            setDailyJournalMetricEnabled('weight', t.checked);
        } else if (t?.id === 'dailyJournalBloodSugarToggle') {
            setDailyJournalMetricEnabled('bloodSugar', t.checked);
        }
    });

    modal.addEventListener('input', (e) => {
        const t = e.target;
        if (t?.classList?.contains('daily-journal-metric-time')) {
            const formatted = formatMealClock12TextWhileTyping(t.value);
            if (t.value !== formatted) t.value = formatted;
        }
    });

    modal.addEventListener('click', (e) => {
        const addBtn = e.target.closest('#dailyJournalWeightAddBtn, #dailyJournalBloodSugarAddBtn');
        if (addBtn) {
            e.preventDefault();
            if (addBtn.id === 'dailyJournalWeightAddBtn') addDailyJournalMetricRecord('weight');
            else addDailyJournalMetricRecord('bloodSugar');
            return;
        }
        const removeBtn = e.target.closest('.daily-journal-metric-remove');
        if (removeBtn) {
            e.preventDefault();
            removeDailyJournalMetricRecord(
                removeBtn.getAttribute('data-metric-type'),
                removeBtn.getAttribute('data-metric-index')
            );
        }
    });
}

export function renderDailyJournalPhotoPreviews() {
    const container = document.getElementById('dailyJournalPhotoPreviewContainer');
    const countEl = document.getElementById('dailyJournalPhotoCount');
    const cameraBtn = document.getElementById('dailyJournalCameraBtn');
    const albumBtn = document.getElementById('dailyJournalAlbumBtn');
    if (!Array.isArray(appState.dailyJournalPhotos)) {
        appState.dailyJournalPhotos = [];
    }
    const photos = appState.dailyJournalPhotos;
    const currentCount = photos.length;
    const aspectCss = getDailyJournalAspectCss();

    if (container) {
        container.innerHTML = photos
            .map((src, idx) => {
                const disPrev = idx === 0 ? ' disabled' : '';
                const disNext = idx === photos.length - 1 ? ' disabled' : '';
                return `<div class="photo-preview-item relative rounded-xl overflow-hidden bg-slate-100 flex-shrink-0 border-2 border-slate-300 select-none" style="width: 7rem; aspect-ratio: ${aspectCss};-webkit-touch-callout:none;" data-index="${idx}">
                <img src="${src}" draggable="false" class="absolute inset-0 w-full h-full object-cover pointer-events-none select-none" style="-webkit-user-drag:none" alt="">
                <button type="button" onclick="window.removeDailyJournalPhoto(${idx})" class="photo-remove-btn" aria-label="사진 삭제">
                    <i class="fa-solid fa-xmark"></i>
                </button>
                <div class="photo-preview-bottom-bar absolute bottom-0 left-0 right-0 z-10 flex gap-0.5 px-0.5 pb-0.5 pt-2 bg-gradient-to-t from-black/65 via-black/30 to-transparent pointer-events-none">
                    <button type="button" onclick="window.moveDailyJournalPhotoOrder(${idx}, -1)" class="photo-order-btn pointer-events-auto"${disPrev} title="순서 앞으로" aria-label="순서 앞으로">
                        <i class="fa-solid fa-chevron-left text-[9px]"></i>
                    </button>
                    <button type="button" onclick="window.editDailyJournalPhoto(${idx})" class="photo-edit-btn photo-edit-btn--in-bar pointer-events-auto" title="편집" aria-label="사진 편집">
                        <i class="fa-solid fa-crop text-[9px]"></i>
                    </button>
                    <button type="button" onclick="window.moveDailyJournalPhotoOrder(${idx}, 1)" class="photo-order-btn pointer-events-auto"${disNext} title="순서 뒤로" aria-label="순서 뒤로">
                        <i class="fa-solid fa-chevron-right text-[9px]"></i>
                    </button>
                </div>
                <div class="photo-preview-order-badge absolute top-1 left-1 w-5 h-5 bg-black/60 text-white text-[10px] font-bold rounded-full flex items-center justify-center pointer-events-none z-10">${idx + 1}</div>
            </div>`;
            })
            .join('');
    }

    if (countEl) {
        countEl.innerText = `${currentCount}/${MAX_DAILY_JOURNAL_PHOTOS}`;
        countEl.classList.toggle('text-emerald-600', currentCount >= MAX_DAILY_JOURNAL_PHOTOS);
        countEl.classList.toggle('text-slate-400', currentCount < MAX_DAILY_JOURNAL_PHOTOS);
    }

    const full = currentCount >= MAX_DAILY_JOURNAL_PHOTOS;
    setPhotoAddButtonsEnabled([cameraBtn, albumBtn], !full, {
        disabledTitle: `사진은 최대 ${MAX_DAILY_JOURNAL_PHOTOS}개까지 추가할 수 있습니다`
    });

    syncDailyJournalAspectButtons();
    updateDailyJournalShareIndicator();
}

export function updateDailyJournalShareIndicator() {
    const shareIndicator = document.getElementById('dailyJournalShareIndicator');
    if (!shareIndicator) return;
    const photos = appState.dailyJournalPhotos || [];
    if (photos.length === 0) {
        shareIndicator.classList.add('hidden');
        return;
    }
    shareIndicator.classList.remove('hidden');
    if (appState.dailyJournalWantsToShare) {
        shareIndicator.classList.add('bg-emerald-100', 'text-emerald-600');
        shareIndicator.classList.remove('bg-slate-50', 'text-slate-400');
    } else {
        shareIndicator.classList.remove('bg-emerald-100', 'text-emerald-600');
        shareIndicator.classList.add('bg-slate-50', 'text-slate-400');
    }
}

export function toggleDailyJournalSharePhoto() {
    const photos = appState.dailyJournalPhotos || [];
    if (photos.length === 0) {
        showToast('공유할 사진이 없습니다.', 'error');
        return;
    }
    appState.dailyJournalWantsToShare = !appState.dailyJournalWantsToShare;
    updateDailyJournalShareIndicator();
}

function syncDailyJournalSharedPhotosCache(entryId, photoUrls) {
    const uid = window.currentUser?.uid;
    if (!entryId || !uid) return;
    if (!window.sharedPhotos || !Array.isArray(window.sharedPhotos)) {
        window.sharedPhotos = [];
    }
    if (photoUrls.length > 0) {
        const newEntries = photoUrls.map((url) => ({ entryId, photoUrl: url, userId: uid }));
        window.sharedPhotos = window.sharedPhotos
            .filter((p) => p.entryId !== entryId)
            .concat(newEntries);
    } else {
        window.sharedPhotos = window.sharedPhotos.filter((p) => p.entryId !== entryId);
    }
    updateTimelineShareIndicators();
}

async function applyDailyJournalMomentShare(dateStr, photos, entry, wantsToShare) {
    const shareEntryId = getDailyJournalShareEntryId(dateStr);
    if (!shareEntryId) return;
    const photosToShare = wantsToShare && photos.length > 0 ? [...photos] : [];
    const hadShare =
        (entry.sharedPhotos && entry.sharedPhotos.length > 0) ||
        isDailyJournalShared(dateStr, entry);
    if (photosToShare.length === 0 && !hadShare) return;

    const mealData = {
        id: shareEntryId,
        date: dateStr,
        comment: entry.comment || '',
        photoAspectRatio: entry.photoAspectRatio || '1:1',
        slotId: 'daily_journal'
    };
    await dbOps.sharePhotos(photosToShare, mealData);
    syncDailyJournalSharedPhotosCache(shareEntryId, photosToShare);
}

export function setDailyJournalPhotoAspectRatio(ratio) {
    if (!PHOTO_ASPECT_OPTIONS.includes(ratio)) return;
    appState.dailyJournalPhotoAspectRatio = ratio;
    renderDailyJournalPhotoPreviews();
}

export function processDailyJournalImagesFromFiles(files) {
    const list = Array.from(files || []).filter((f) => f?.type?.startsWith?.('image/'));
    if (!list.length) return;

    const remainingSlots = MAX_DAILY_JOURNAL_PHOTOS - appState.dailyJournalPhotos.length;
    if (remainingSlots <= 0) {
        showToast(`사진은 최대 ${MAX_DAILY_JOURNAL_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
        return;
    }

    const filesToProcess = list.slice(0, remainingSlots);
    if (list.length > remainingSlots) {
        showToast(`사진은 최대 ${MAX_DAILY_JOURNAL_PHOTOS}개까지 가능합니다. ${remainingSlots}개만 추가됩니다.`, 'info');
    }

    const filePromises = filesToProcess.map((f, index) =>
        new Promise((resolve) => {
            const r = new FileReader();
            r.onload = (ev) => resolve({ index, dataUrl: ev.target.result });
            r.onerror = () => resolve(null);
            r.readAsDataURL(f);
        })
    );

    Promise.all(filePromises)
        .then((results) => {
            results
                .filter((r) => r !== null)
                .sort((a, b) => a.index - b.index)
                .forEach(({ dataUrl }) => {
                    if (appState.dailyJournalPhotos.length < MAX_DAILY_JOURNAL_PHOTOS) {
                        appState.dailyJournalPhotos.push(dataUrl);
                    }
                });
            renderDailyJournalPhotoPreviews();
        })
        .catch(() => showToast('사진 처리 중 오류가 발생했습니다.', 'error'));
}

export function handleDailyJournalImages(e) {
    processDailyJournalImagesFromFiles(e.target?.files);
    if (e.target) e.target.value = '';
}

async function pickDailyJournalImages(source) {
    const remainingSlots = MAX_DAILY_JOURNAL_PHOTOS - appState.dailyJournalPhotos.length;
    if (remainingSlots <= 0) {
        showToast(`사진은 최대 ${MAX_DAILY_JOURNAL_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
        return;
    }
    const files =
        source === 'camera'
            ? await pickCameraImage({ facing: 'environment' })
            : await pickGalleryImages({ multiple: true });
    if (!files.length) return;
    processDailyJournalImagesFromFiles(files);
}

export function openDailyJournalCameraPicker() {
    return pickDailyJournalImages('camera');
}

export function openDailyJournalGalleryPicker() {
    return pickDailyJournalImages('gallery');
}

export function removeDailyJournalPhoto(idx) {
    appState.dailyJournalPhotos.splice(idx, 1);
    if (appState.dailyJournalPhotos.length === 0) {
        appState.dailyJournalWantsToShare = false;
    }
    renderDailyJournalPhotoPreviews();
}

export function moveDailyJournalPhotoOrder(idx, delta) {
    const photos = appState.dailyJournalPhotos;
    const j = idx + delta;
    if (!Array.isArray(photos) || j < 0 || j >= photos.length) return;
    [photos[idx], photos[j]] = [photos[j], photos[idx]];
    renderDailyJournalPhotoPreviews();
}

function loadDailyJournalMetricsFromEntry(entry) {
    appState.dailyJournalWeightEnabled = entry.weightEnabled === true;
    appState.dailyJournalBloodSugarEnabled = entry.bloodSugarEnabled === true;
    appState.dailyJournalWeightRecords =
        entry.weightRecords?.length > 0
            ? entry.weightRecords.slice(0, MAX_DAILY_JOURNAL_METRIC_RECORDS).map((r) => ({ value: r.value, time: r.time || '' }))
            : [emptyMetricRow()];
    appState.dailyJournalBloodSugarRecords =
        entry.bloodSugarRecords?.length > 0
            ? entry.bloodSugarRecords.slice(0, MAX_DAILY_JOURNAL_METRIC_RECORDS).map((r) => ({ value: r.value, time: r.time || '' }))
            : [emptyMetricRow()];
}

function resetDailyJournalMetricsState() {
    appState.dailyJournalWeightEnabled = false;
    appState.dailyJournalBloodSugarEnabled = false;
    appState.dailyJournalWeightRecords = [emptyMetricRow()];
    appState.dailyJournalBloodSugarRecords = [emptyMetricRow()];
}

function updateDailyJournalModalActions(hasExisting) {
    const btnDelete = document.getElementById('btnDailyJournalDelete');
    const btnSave = document.getElementById('btnDailyJournalSave');
    if (!btnSave) return;

    if (window.currentUser?.isAnonymous) {
        btnSave.disabled = true;
        btnSave.className =
            'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-300 text-slate-500 text-base font-bold transition-colors cursor-not-allowed';
        btnSave.innerHTML = '<span>로그인 후 사용할 수 있어요</span>';
        btnDelete?.classList.add('hidden');
        return;
    }

    btnSave.disabled = false;
    btnSave.className =
        'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-900 text-white text-base font-bold hover:bg-slate-800 active:bg-slate-800 transition-colors';

    if (hasExisting && !isDemoUser(window.currentUser)) {
        btnDelete?.classList.remove('hidden');
        btnSave.innerHTML = '<span>수정 완료</span>';
    } else {
        btnDelete?.classList.add('hidden');
        btnSave.innerHTML = '<span>기록 완료</span>';
    }
}

export function openDailyJournalModal(dateStr) {
    if (!dateStr) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }

    const modal = document.getElementById('dailyJournalModal');
    if (!modal) return;

    ensureDailyJournalMetricsDelegation();

    const entry = getDailyJournalFromSettings(window.userSettings, dateStr);
    appState.dailyJournalEditingDate = dateStr;
    appState.dailyJournalPhotos = Array.isArray(entry.photos) ? [...entry.photos] : [];
    appState.dailyJournalPhotoAspectRatio = entry.photoAspectRatio || '1:1';
    appState.dailyJournalWantsToShare =
        entry.sharedPhotos?.length > 0 || isDailyJournalShared(dateStr, entry);
    loadDailyJournalMetricsFromEntry(entry);

    const titleEl = document.getElementById('dailyJournalModalTitle');
    if (titleEl) titleEl.textContent = formatMealogDateLabel(dateStr);

    const commentInput = document.getElementById('dailyJournalCommentInput');
    if (commentInput) commentInput.value = entry.comment || '';

    renderDailyJournalPhotoPreviews();
    renderDailyJournalAllMetrics();
    updateDailyJournalShareIndicator();
    updateDailyJournalModalActions(dailyJournalHasContent(entry));
    modal.classList.remove('hidden');
    lockBodyScroll();
    document.body.classList.add('daily-journal-modal-open');
}

export function closeDailyJournalModal() {
    const modal = document.getElementById('dailyJournalModal');
    if (modal) modal.classList.add('hidden');
    unlockBodyScroll();
    document.body.classList.remove('daily-journal-modal-open');
    appState.dailyJournalEditingDate = '';
    appState.dailyJournalPhotos = [];
    appState.dailyJournalWantsToShare = false;
    resetDailyJournalMetricsState();
}

async function materializeDailyJournalPhotos(photos, dateStr) {
    const uid = window.currentUser?.uid;
    if (!uid) return [];
    const list = Array.isArray(photos) ? photos : [];
    const needsUpload = (p) =>
        typeof p === 'string' && (p.startsWith('data:image') || p.startsWith('blob:'));
    const out = [];
    for (const p of list) {
        if (needsUpload(p)) {
            const url = await uploadBase64ToStorage(p, uid, `daily_journal_${dateStr}`, 1024);
            out.push(url);
        } else if (typeof p === 'string' && p) {
            out.push(p);
        }
    }
    return out;
}

export async function deleteDailyJournal() {
    const dateStr = appState.dailyJournalEditingDate;
    if (!dateStr) {
        showToast('날짜 정보를 찾을 수 없습니다.', 'error');
        return;
    }
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 하루 기록을 삭제할 수 없습니다.', 'error');
        return;
    }
    if (!confirm('정말 이 하루 기록을 삭제하시겠습니까?')) return;

    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        const prev = getDailyJournalFromSettings(window.userSettings, dateStr);
        await dbOps.saveDailyJournal(dateStr, normalizeDailyJournalEntry(null));
        await applyDailyJournalMomentShare(dateStr, [], prev, false);
        closeDailyJournalModal();
        showToast('하루 기록이 삭제되었습니다.', 'success');
        invalidateTimelineDateSection(dateStr);
        if (typeof window.renderTimeline === 'function') window.renderTimeline();
    } catch (e) {
        console.error('Daily Journal Delete Error:', e);
        showToast(getUserFacingErrorMessage(e, 'settings'), 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

export async function saveDailyJournal() {
    const dateStr = appState.dailyJournalEditingDate;
    if (!dateStr) {
        showToast('날짜 정보를 찾을 수 없습니다.', 'error');
        return;
    }
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 하루 기록을 저장할 수 없습니다.', 'error');
        return;
    }

    const commentInput = document.getElementById('dailyJournalCommentInput');
    const comment = (commentInput?.value || '').trim();
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        const prev = getDailyJournalFromSettings(window.userSettings, dateStr);
        const photos = await materializeDailyJournalPhotos(appState.dailyJournalPhotos, dateStr);
        const wantsToShare = appState.dailyJournalWantsToShare === true;
        const photosToShare = wantsToShare && photos.length > 0 ? [...photos] : [];
        const weightEnabled = appState.dailyJournalWeightEnabled === true;
        const bloodSugarEnabled = appState.dailyJournalBloodSugarEnabled === true;
        const weightRecords = weightEnabled ? collectMetricRecordsFromDom('weight') : [];
        const bloodSugarRecords = bloodSugarEnabled ? collectMetricRecordsFromDom('bloodSugar') : [];
        const entry = normalizeDailyJournalEntry({
            comment,
            photos,
            sharedPhotos: photosToShare,
            photoAspectRatio: appState.dailyJournalPhotoAspectRatio || '1:1',
            weightEnabled: weightEnabled && weightRecords.length > 0,
            bloodSugarEnabled: bloodSugarEnabled && bloodSugarRecords.length > 0,
            weightRecords,
            bloodSugarRecords,
            recordedAt: prev.recordedAt || ''
        });
        await dbOps.saveDailyJournal(dateStr, entry);
        await applyDailyJournalMomentShare(dateStr, photos, entry, wantsToShare);
        closeDailyJournalModal();
        showToast(
            dailyJournalHasContent(entry) ? '하루 기록이 저장되었습니다.' : '하루 기록이 삭제되었습니다.',
            'success'
        );
        invalidateTimelineDateSection(dateStr);
        if (typeof window.renderTimeline === 'function') window.renderTimeline();
    } catch (e) {
        console.error('Daily Journal Save Error:', e);
        showToast(getUserFacingErrorMessage(e, 'settings'), 'error');
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

/** @deprecated openDailyJournalModal 사용 */
export function openDailyCommentModal(dateStr) {
    openDailyJournalModal(dateStr);
}

/** @deprecated closeDailyJournalModal 사용 */
export function closeDailyCommentModal() {
    closeDailyJournalModal();
}
