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
import { invalidateTimelineDateSection, renderTimelineDateSections, updateTimelineShareIndicators } from '../render/index.js';
import { isDemoUser } from '../demo-account.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import { pickCameraImage, pickGalleryImages, setPhotoAddButtonsEnabled } from '../utils/image-source-picker.js';
import { scheduleLucideIcons } from '../icons.js';

import { getSharedPhotos, setSharedPhotos } from '../utils/moment-share-state.js';
const MAX_DAILY_JOURNAL_PHOTOS = 5;
const PHOTO_ASPECT_OPTIONS = ['1:1', '3:4', '4:3'];

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

/* 체중·혈당 입력기는 걷었다 — 기록 추가의 메모가 받는다 (docs/user-memo-items.md §7.1) */

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
                    <i data-lucide="x"></i>
                </button>
                <div class="photo-preview-bottom-bar absolute bottom-0 left-0 right-0 z-10 flex gap-0.5 px-0.5 pb-0.5 pt-2 bg-gradient-to-t from-black/65 via-black/30 to-transparent pointer-events-none">
                    <button type="button" onclick="window.moveDailyJournalPhotoOrder(${idx}, -1)" class="photo-order-btn pointer-events-auto"${disPrev} title="순서 앞으로" aria-label="순서 앞으로">
                        <i data-lucide="chevron-left" class="text-[9px]"></i>
                    </button>
                    <button type="button" onclick="window.editDailyJournalPhoto(${idx})" class="photo-edit-btn photo-edit-btn--in-bar pointer-events-auto" title="편집" aria-label="사진 편집">
                        <i data-lucide="square-pen" class="text-[9px]"></i>
                    </button>
                    <button type="button" onclick="window.moveDailyJournalPhotoOrder(${idx}, 1)" class="photo-order-btn pointer-events-auto"${disNext} title="순서 뒤로" aria-label="순서 뒤로">
                        <i data-lucide="chevron-right" class="text-[9px]"></i>
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

    document
        .querySelector('#dailyJournalModal .entry-photo-section')
        ?.classList.toggle('entry-photo-section--has-photos', currentCount > 0);

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
    shareIndicator.classList.toggle('entry-action-btn--share-on', !!appState.dailyJournalWantsToShare);
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
    if (photoUrls.length > 0) {
        const newEntries = photoUrls.map((url) => ({ entryId, photoUrl: url, userId: uid }));
        setSharedPhotos(getSharedPhotos()
            .filter((p) => p.entryId !== entryId)
            .concat(newEntries));
    } else {
        setSharedPhotos(getSharedPhotos().filter((p) => p.entryId !== entryId));
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

function updateDailyJournalModalActions(hasExisting) {
    const btnDelete = document.getElementById('btnDailyJournalDelete');
    const btnSave = document.getElementById('btnDailyJournalSave');
    if (!btnSave) return;

    if (window.currentUser?.isAnonymous) {
        btnSave.disabled = true;
        btnSave.className =
            'entry-action-btn entry-action-btn--save flex-[1.7] flex flex-col items-center justify-center px-3 py-3.5';
        btnSave.innerHTML = '<span class="entry-action-btn__inner"><span>로그인 후 사용할 수 있어요</span></span>';
        btnDelete?.classList.add('hidden');
        return;
    }

    btnSave.disabled = false;
    btnSave.className =
        'entry-action-btn entry-action-btn--save flex-[1.7] flex flex-col items-center justify-center px-3 py-3.5';

    if (hasExisting && !isDemoUser(window.currentUser)) {
        btnDelete?.classList.remove('hidden');
        btnSave.innerHTML = '<span class="entry-action-btn__inner"><span>수정 완료</span></span>';
    } else {
        btnDelete?.classList.add('hidden');
        btnSave.innerHTML = '<span class="entry-action-btn__inner"><span>기록 완료</span></span>';
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

    const entry = getDailyJournalFromSettings(window.userSettings, dateStr);
    appState.dailyJournalEditingDate = dateStr;
    appState.dailyJournalPhotos = Array.isArray(entry.photos) ? [...entry.photos] : [];
    appState.dailyJournalPhotoAspectRatio = entry.photoAspectRatio || '1:1';
    appState.dailyJournalWantsToShare =
        entry.sharedPhotos?.length > 0 || isDailyJournalShared(dateStr, entry);

    const titleEl = document.getElementById('dailyJournalModalTitle');
    if (titleEl) {
        // 식사 기록 헤더와 동일: YYYY.MM.DD (요일 없음)
        const [y, m, d] = String(dateStr).split('-');
        titleEl.textContent = y && m && d ? `${y}.${m}.${d}` : '날짜';
    }

    const commentInput = document.getElementById('dailyJournalCommentInput');
    if (commentInput) commentInput.value = entry.comment || '';

    renderDailyJournalPhotoPreviews();
    updateDailyJournalShareIndicator();
    updateDailyJournalModalActions(dailyJournalHasContent(entry));
    modal.classList.remove('hidden');
    lockBodyScroll('dailyJournal');
    document.body.classList.add('daily-journal-modal-open');
    scheduleLucideIcons(modal);
}

export function closeDailyJournalModal() {
    const modal = document.getElementById('dailyJournalModal');
    if (modal) modal.classList.add('hidden');
    unlockBodyScroll('dailyJournal');
    document.body.classList.remove('daily-journal-modal-open');
    appState.dailyJournalEditingDate = '';
    appState.dailyJournalPhotos = [];
    appState.dailyJournalWantsToShare = false;
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
        showToast('샘플 계정에서는 하루 소감을 삭제할 수 없습니다.', 'error');
        return;
    }
    if (!confirm('정말 이 하루 소감을 삭제하시겠습니까?')) return;

    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        const prev = getDailyJournalFromSettings(window.userSettings, dateStr);
        await dbOps.saveDailyJournal(dateStr, normalizeDailyJournalEntry(null));
        await applyDailyJournalMomentShare(dateStr, [], prev, false);
        closeDailyJournalModal();
        showToast('하루 소감이 삭제되었습니다.', 'success');
        invalidateTimelineDateSection(dateStr);
        renderTimelineDateSections([dateStr]);
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
        showToast('샘플 계정에서는 하루 소감을 저장할 수 없습니다.', 'error');
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
        const entry = normalizeDailyJournalEntry({
            comment,
            photos,
            sharedPhotos: photosToShare,
            photoAspectRatio: appState.dailyJournalPhotoAspectRatio || '1:1',
            /**
             * 체중·혈당 입력은 걷었지만 값은 **그대로 실어 낸다**
             * (docs/user-memo-items.md §7.1). 빼면 하루 소감을 고쳐 저장할 때마다
             * 옷 기록이 지워진다 — 분석 탭 차트와 타임라인이 아직 이걸 읽는다.
             */
            weightEnabled: prev.weightEnabled,
            bloodSugarEnabled: prev.bloodSugarEnabled,
            weightRecords: prev.weightRecords,
            bloodSugarRecords: prev.bloodSugarRecords,
            recordedAt: prev.recordedAt || ''
        });
        await dbOps.saveDailyJournal(dateStr, entry);
        await applyDailyJournalMomentShare(dateStr, photos, entry, wantsToShare);
        closeDailyJournalModal();
        showToast(
            dailyJournalHasContent(entry) ? '하루 소감이 저장되었습니다.' : '하루 소감이 삭제되었습니다.',
            'success'
        );
        invalidateTimelineDateSection(dateStr);
        renderTimelineDateSections([dateStr]);
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
