// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_USER_SETTINGS, RECORD_MAX_PHOTOS } from '../constants.js';
import { appState } from '../state.js';
import { setVal, getInputIdFromContainer, normalizeUrl, addCompositionAwareInput, uploadBase64ToStorage, uploadMealPhotoVariants, normalizeBirthdateRaw } from '../utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager, clampRecordPhotoHeroIndex } from '../render/index.js';
import { dbOps, unwrapMealSaveResult, generateMealDocId } from '../db.js';
import { showToast, showSuccessPopup } from '../ui.js';
import { resolveRecordCompletePopupMessage, updateTrackerStreakLabel } from '../attendance-check.js';
import { invalidateMealHistoryCountCache } from '../meal-record-count.js';
import {
    renderTimeline,
    renderTimelineDateSections,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    updateTimelineMealEntryPendingIndicators,
    invalidateTimelineDateSection,
    renderGallery,
    renderFeed
} from '../render/index.js';
import { callableFunctions, db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { isDemoUser } from '../demo-account.js';
import { doc, getDoc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { applyDemoDateShiftToMealRecord } from '../demo-date-shift.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
import { getSharedPhotoUrlsForEntry, getSharedPhotos, setSharedPhotos } from '../utils/moment-share-state.js';
import { getUserFacingErrorMessage } from '../utils/user-facing-error.js';
import {
    isMealEntryPendingSync,
    isMealEntryDeleting,
    isMealEntrySaveFailed,
    markMealEntryServerWorkComplete,
    markMealEntryDeletePending,
    markMealEntryDeleteInFlight,
    markMealEntryDeleteFailed,
    clearMealEntryDeleteFailed,
    markMealEntrySaveFailedById,
    clearMealEntrySaveFailedById,
    markMealOptimisticSavePending,
    clearMealOptimisticSavePending,
    markMealEntrySaveInFlight,
    clearMealEntrySaveInFlight,
    clearMealEntryServerSynced,
    markMealEntrySyncAbandonedById,
    clearMealEntrySyncAbandonedById,
    clearMealSyncGraceTimer,
    isMealEntryRetryEligible,
    isMealEntryDeleteFailed,
    onMealDocFirestoreServerAcknowledged,
    scheduleMealServerAckAfterPendingWrites,
    MEAL_SYNC_GRACE_MS_NO_PHOTO,
    MEAL_SYNC_GRACE_MS_WITH_PHOTO,
    mealRecordHasBase64PendingPhotos,
    getMealRowSyncLeadKind
} from '../utils/meal-entry-pending.js';
import { getMealSyncManager } from '../utils/meal-sync-manager.js';
import { applyOptimisticMealDelete, rollbackOptimisticMealDelete } from '../utils/meal-delete-optimistic.js';
import {
    normalizeMealClockInputValue,
    formatMealClock12TextWhileTyping,
    normalizeMealClock12InputValue,
    mealClock24FromAmPmClock,
    mealClock24ToAmPmAndDisplay
} from '../meal-time-utils.js';
import {
    createPhotoMetaFromFile,
    normalizePhotoMetaFromRecord,
    resolveFirstPhotoTakenAt
} from '../photo-meta.js';
import {
    closeTimeSourceSheets,
    openTimeSourceSheet
} from '../time-source-picker.js';
import { openMealClockWheelPanel } from '../meal-clock-wheel-picker.js';
import { saveWithTimeout } from '../utils/save-with-timeout.js';
import { diag, getSavePhase } from '../utils/diagnostics.js';
import { withDeadline, Lease, DEADLINE } from '../utils/with-deadline.js';
import { prepareIntakeImage, dataUrlToBlob } from '../utils/image-downscale.js';
import { enqueueWithQuotaRelief, CLASS_CONTENT } from '../utils/outbox-store.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import {
    ensureFocusedInputVisible,
    getImeMetrics,
    getNativeImeHeight,
    captureImeBaseline,
    clearOverlayImePinStyles,
    isMobileWebTouchUi,
    pinElementToVisualViewport
} from '../utils/ime-viewport.js';
import { ENTRY_DOM, ENTRY_MODE_CONFIG, PHOTO_ASPECT_OPTIONS, getEntryModeConfig } from './entry-form-config.js';
import {
    mergeEntrySubChipsIntoInputs,
    readEntryFormFromDom,
    validateEntryForm,
    resolveEntrySaveFields,
} from './entry-form-state.js';
import { buildSettingsWithRememberedSubTags, scheduleEntrySettingsSave } from './entry-save-subtags.js';
import { buildEntrySaveRecord, buildEntryShareSnapshot, isLocalPendingPhoto } from './entry-save-record.js';
import { ensureDataUrlForStorage, uploadEntryPhotosAndResave } from './entry-save-photos.js';
import { syncMomentShareAfterSave } from './entry-save-share.js';
import {
    bindEntryModalHeaderOnce,
    refreshEntryModalHeader,
    inferEntryFormModeFromRecord,
    applyEntryFormModeToModalUI,
    closeEntryHeaderDatePicker,
} from './entry-modal-header.js';
import { closeEntrySlotPicker } from './entry-slot-picker.js';
import {
    bindEntryQuickInputOnce,
    applyEntryQuickInputUi,
    finalizeEntryModalQuickInput,
    syncEntryQuickInputToggle,
} from './entry-quick-input.js';
import { bindDialogGrabberPullClose } from '../utils/dialog-grabber.js';
import {
    bindEntryDetailRecordOnce,
    finalizeEntryModalDetailRecord,
    setEntryDetailRecordPanelHidden,
    applyEntryDetailRecordUi,
} from './entry-detail-record.js';
import {
    bindEntrySheetTabsOnce,
    resetEntrySheetTab,
    setEntrySheetTabsForSkip,
    resetEntrySheetBaseHeight,
    captureEntrySheetBaseHeight,
} from './entry-sheet-tabs.js';
// ⚠️ initPushNotifications import 제거 - 크래시 문제로 인해 비활성화
// 저장 직후 동기화 도트(waitForPendingWrites 등)는 meal-sync-manager.scheduleServerAckAfterPendingWrites (meal-entry-pending re-export)

// 설정 저장 디바운싱을 위한 타이머 (기록 저장 쪽 디바운스는 entry-save-subtags.js가 소유)
let entryGaugeSaveTimeout = null;

/** 입력란이 비어 있을 때만 활성 서브칩을 쉼표로 합쳐 넣음 (태그만 선택한 저장 대비) */
function mergeActiveSubChipsIntoInputs() {
    mergeEntrySubChipsIntoInputs();
}

/** 배달/포장일 때만 '어디서 가져오셨나요' 입력란 표시 (다른 유형으로 바꾸면 값 초기화) */
export function syncDeliveryVendorSectionVisibility() {
    const sec = document.getElementById('deliveryVendorSection');
    if (!sec) return;
    const optional = document.getElementById('optionalFields');
    const skipOptional = optional?.classList.contains('hidden');
    const entryWhereChips = document.getElementById(ENTRY_DOM.whereChips);
    let mealType = '';
    if (entryWhereChips) {
        const active = entryWhereChips.querySelector('button.chip.active');
        if (active) mealType = active.innerText.trim();
    }
    const show = !skipOptional && mealType === '배달/포장' && appState.entryFormMode !== 'snack';
    if (!show) {
        const dvi = document.getElementById('deliveryVendorInput');
        if (dvi) {
            dvi.value = '';
            dvi.removeAttribute('data-kakao-place-id');
            dvi.removeAttribute('data-kakao-place-address');
            dvi.removeAttribute('data-kakao-place-data');
            dvi.removeAttribute('data-kakao-place-name');
        }
    }
    sec.classList.toggle('hidden', !show);

    const dual = show;
    const area = document.getElementById('mealWhatInputArea');
    if (area) {
        area.classList.toggle('rounded-2xl', dual);
        area.classList.toggle('border', dual);
        area.classList.toggle('border-slate-200', dual);
        area.classList.toggle('bg-white', dual);
        area.classList.toggle('overflow-hidden', dual);
        area.classList.toggle('divide-y', dual);
        area.classList.toggle('divide-slate-200', dual);
    }

    const mdi = document.getElementById('entryWhatInput');
    if (mdi) {
        if (dual) {
            mdi.classList.remove('border', 'border-slate-200', 'focus:border-slate-400');
            mdi.classList.add('rounded-2xl', 'border-0', 'bg-slate-50', 'focus:ring-1', 'focus:ring-slate-200', 'focus:bg-white');
        } else {
            mdi.classList.remove('border-0', 'bg-slate-50', 'focus:ring-1', 'focus:ring-slate-200', 'focus:bg-white');
            mdi.classList.add('rounded-2xl', 'border', 'border-slate-200', 'bg-white', 'focus:border-slate-400');
        }
    }
    const dvi = document.getElementById('deliveryVendorInput');
    if (dvi) {
        if (dual) {
            dvi.classList.remove('rounded-xl', 'rounded-lg', 'border', 'border-slate-200', 'focus:border-slate-400', 'bg-white', 'bg-slate-50', 'focus:bg-white');
            dvi.classList.add('rounded-2xl', 'border-0', 'bg-transparent', 'focus:ring-1', 'focus:ring-slate-200', 'focus:ring-offset-0');
        } else {
            dvi.classList.remove('rounded-2xl', 'border-0', 'bg-transparent', 'focus:ring-1', 'focus:ring-slate-200', 'focus:ring-offset-0');
            dvi.classList.add('rounded-xl', 'border', 'border-slate-200', 'bg-white', 'focus:border-slate-400');
        }
    }
    autosizeEntryWhatInput();
}

function ensureEntryModalGaugesOnUserSettings() {
    if (!window.userSettings) return;
    const cur = window.userSettings.entryModalGauges;
    const off = { ratingEnabled: false, satietyEnabled: false, timeEnabled: false };
    if (!cur || typeof cur !== 'object') {
        window.userSettings.entryModalGauges = { main: { ...off }, snack: { ...off } };
        return;
    }
    if (cur.main && cur.snack && typeof cur.main === 'object' && typeof cur.snack === 'object') {
        window.userSettings.entryModalGauges = {
            main: {
                ratingEnabled: cur.main.ratingEnabled === true,
                satietyEnabled: cur.main.satietyEnabled === true,
                timeEnabled: cur.main.timeEnabled === true
            },
            snack: {
                ratingEnabled: cur.snack.ratingEnabled === true,
                satietyEnabled: cur.snack.satietyEnabled === true,
                timeEnabled: cur.snack.timeEnabled === true
            }
        };
        return;
    }
    const r = cur.ratingEnabled === true;
    const s = cur.satietyEnabled === true;
    window.userSettings.entryModalGauges = {
        main: { ratingEnabled: r, satietyEnabled: s, timeEnabled: false },
        snack: { ratingEnabled: r, satietyEnabled: s, timeEnabled: false }
    };
}

function applyEntryGaugeDialUi() {
    ['ratingGaugeDialWrap', 'snackRatingGaugeDialWrap', 'satietyGaugeDialWrap', 'snackSatietyGaugeDialWrap'].forEach(
        (wrapId) => {
            document.getElementById(wrapId)?.classList.remove('entry-gauge-dial-wrap--off');
        }
    );
}

function applyDefaultEmptyMealClockWhenTimeEnabled(isMain) {
    if (!getMealClock24FromModal(isMain)) {
        applyMealClockRowFrom24(isMain, '');
        setEntryMealClockSource(isMain, 'empty');
    }
}

/** 상세기록 칩 prefs → 만족도·포만감·시간 on/off (개별 토글 대체) */
function syncEntryGaugesFromDetailRecordPrefs(prefs, modeKey) {
    const isSnack = modeKey === 'snack';
    const wasTimeOn = isSnack ? appState.entryTimeOnSnack === true : appState.entryTimeOnMain === true;

    if (isSnack) {
        appState.entryGaugeRatingOnSnack = !!prefs.rating;
        appState.entryGaugeSatietyOnSnack = !!prefs.satiety;
        appState.entryTimeOnSnack = !!prefs.time;
    } else {
        appState.entryGaugeRatingOnMain = !!prefs.rating;
        appState.entryGaugeSatietyOnMain = !!prefs.satiety;
        appState.entryTimeOnMain = !!prefs.time;
    }

    applyEntryGaugeDialUi();
    setRating(appState.currentRating);
    renderSatietyButtons('satietyContainer', appState.currentSatiety);
    renderSatietyButtons('snackSatietyContainer', appState.currentSatiety);

    const mainSide = !isSnack;
    if (prefs.time && !wasTimeOn) {
        applyDefaultEmptyMealClockWhenTimeEnabled(mainSide);
    } else if (!prefs.time && wasTimeOn) {
        applyMealClockRowFrom24(mainSide, '');
        setEntryMealClockSource(mainSide, null);
    }
    applyEntryMealClockInputVisibility();

    ensureEntryModalGaugesOnUserSettings();
    const slot = isSnack ? 'snack' : 'main';
    window.userSettings.entryModalGauges[slot] = {
        ratingEnabled: !!prefs.rating,
        satietyEnabled: !!prefs.satiety,
        timeEnabled: !!prefs.time,
    };
    schedulePersistEntryModalGaugePrefs();
}

/** isMain:true = 본식 시간, false = 간식 시간 — 저장값은 24시 "HH:mm" */
const MEAL_CLOCK_SOURCE_LABELS = {
    now: '현재 시각',
    photo: '사진 시각',
    manual: '직접 입력',
    empty: '미입력',
};

function setEntryMealClockSource(isMain, source) {
    if (isMain) appState.entryMealClockSourceMain = source || null;
    else appState.entryMealClockSourceSnack = source || null;
    updateEntryMealClockSourceLabel(isMain);
}

function updateEntryMealClockSourceLabel(isMain) {
    const el = document.getElementById(isMain ? 'entryMealTimeSourceLabelMain' : 'entryMealTimeSourceLabelSnack');
    if (!el) return;
    const source = isMain ? appState.entryMealClockSourceMain : appState.entryMealClockSourceSnack;
    el.textContent = source ? (MEAL_CLOCK_SOURCE_LABELS[source] || '') : '';
}

function applyMealClockRowFrom24(isMain, hhmm24maybe) {
    const txt = document.getElementById(isMain ? 'entryMealTimeInputMain' : 'entryMealTimeInputSnack');
    const bridge = document.getElementById(isMain ? 'entryMealTimeBridgeMain' : 'entryMealTimeBridgeSnack');
    const sel = document.getElementById(isMain ? 'entryMealAmpmMain' : 'entryMealAmpmSnack');
    if (!txt || !bridge) return;
    const n24 = normalizeMealClockInputValue(hhmm24maybe);
    if (!n24) {
        txt.value = '';
        if (sel) sel.value = 'pm';
        bridge.value = '';
        const curSource = isMain ? appState.entryMealClockSourceMain : appState.entryMealClockSourceSnack;
        if (curSource !== 'empty') {
            setEntryMealClockSource(isMain, null);
        } else {
            updateEntryMealClockSourceLabel(isMain);
        }
        return;
    }
    bridge.value = n24;
    const { ampm, display } = mealClock24ToAmPmAndDisplay(n24);
    if (sel) sel.value = ampm;
    txt.value = display;
}

/** 모달에서 읽은 24시 "HH:mm"(빈 문자열 가능) */
function getMealClock24FromModal(isMain) {
    const txt = document.getElementById(isMain ? 'entryMealTimeInputMain' : 'entryMealTimeInputSnack');
    const sel = document.getElementById(isMain ? 'entryMealAmpmMain' : 'entryMealAmpmSnack');
    const a = sel?.value === 'am' ? 'am' : 'pm';
    const raw = mealClock24FromAmPmClock(a, txt?.value || '');
    return normalizeMealClockInputValue(raw || '');
}

function getMealClockInitialDate(isMain) {
    const n24 = getMealClock24FromModal(isMain);
    const d = new Date();
    if (n24) {
        const [h, m] = n24.split(':').map((v) => parseInt(v, 10));
        d.setHours(h, m, 0, 0);
    }
    return d;
}

function applyMealClockFromDate(isMain, date, source) {
    if (!date || Number.isNaN(date.getTime())) return;
    const hhmm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    applyMealClockRowFrom24(isMain, hhmm);
    if (source) setEntryMealClockSource(isMain, source);
}

function openEntryMealTimeSourceSheet(isMain) {
    const timeOn = isMain ? appState.entryTimeOnMain === true : appState.entryTimeOnSnack === true;
    if (!timeOn) return;

    openTimeSourceSheet({
        title: '시간 선택',
        zIndex: 350,
        showEmpty: true,
        onNow: () => applyMealClockFromDate(isMain, new Date(), 'now'),
        onPhoto: async () => {
            const date = await resolveFirstPhotoTakenAt({
                photoMeta: appState.currentPhotoMeta,
                photos: appState.currentPhotos
            });
            if (!date) {
                showToast('사진 촬영 시각 정보를 찾을 수 없습니다.', 'info');
                return;
            }
            closeTimeSourceSheets();
            applyMealClockFromDate(isMain, date, 'photo');
        },
        onManual: () => {
            openMealClockWheelPanel({
                zIndex: 350,
                initialDate: getMealClockInitialDate(isMain),
                onApply: (date) => applyMealClockFromDate(isMain, date, 'manual'),
            });
        },
        onEmpty: () => {
            applyMealClockRowFrom24(isMain, '');
            setEntryMealClockSource(isMain, 'empty');
        }
    });
}

function applyEntryMealClockInputVisibility() {
    const onM = appState.entryTimeOnMain === true;
    const onS = appState.entryTimeOnSnack === true;
    const inM = document.getElementById('entryMealTimeInputMain');
    const inS = document.getElementById('entryMealTimeInputSnack');
    const offM = document.getElementById('entryMealTimeOffDisplayMain');
    const offS = document.getElementById('entryMealTimeOffDisplaySnack');
    const pickM = document.getElementById('entryMealTimeSourceBtnMain');
    const pickS = document.getElementById('entryMealTimeSourceBtnSnack');
    const amM = document.getElementById('entryMealAmpmMain');
    const amS = document.getElementById('entryMealAmpmSnack');
    const compoundMain = document.getElementById('entryMealClockCompoundMain');
    const compoundSnack = document.getElementById('entryMealClockCompoundSnack');

    const applyOne = (on, inp, offEl, pickBtn, amSel, compound) => {
        if (!inp || !offEl) return;
        if (on) {
            offEl.classList.add('pointer-events-none', 'opacity-0');
            inp.classList.remove('pointer-events-none', 'opacity-0');
            inp.removeAttribute('tabindex');
            inp.removeAttribute('aria-hidden');
            pickBtn?.classList.remove('pointer-events-none', 'opacity-0');
            amSel?.classList.remove('pointer-events-none', 'opacity-0');
            if (compound) {
                compound.classList.remove('pointer-events-none', 'bg-slate-50', 'border-slate-100');
                compound.classList.add('bg-white', 'border-slate-200');
            }
        } else {
            offEl.classList.remove('pointer-events-none', 'opacity-0');
            inp.classList.add('pointer-events-none', 'opacity-0');
            inp.setAttribute('tabindex', '-1');
            inp.setAttribute('aria-hidden', 'true');
            pickBtn?.classList.add('pointer-events-none', 'opacity-0');
            amSel?.classList.add('pointer-events-none', 'opacity-0');
            if (compound) {
                compound.classList.add('pointer-events-none', 'bg-slate-50', 'border-slate-100');
                compound.classList.remove('bg-white', 'border-slate-200');
            }
        }
    };
    applyOne(onM, inM, offM, pickM, amM, compoundMain);
    applyOne(onS, inS, offS, pickS, amS, compoundSnack);
    updateEntryMealClockSourceLabel(true);
    updateEntryMealClockSourceLabel(false);
}

function finalizeEntryMealClock(savedRecord, isSnackMode) {
    const applySide = (mainSide) => {
        const r =
            savedRecord && typeof savedRecord === 'object'
                ? mainSide
                    ? isSnackMode
                        ? null
                        : savedRecord
                    : isSnackMode
                      ? savedRecord
                      : null
                : null;

        if (r) {
            const mc = r.mealClock;
            if (typeof mc === 'string' && mc.trim()) {
                applyMealClockRowFrom24(mainSide, mc);
            } else if (mc === null) {
                applyMealClockRowFrom24(mainSide, '');
            }
        }
    };

    applySide(true);
    applySide(false);
    applyEntryMealClockInputVisibility();
}

/** 신규 기록이면 플래그 초기화, 수정이면 자동 시간·EXIF 채우기 비활성 */
function resetEntryMealClockSessionFlagsForOpen(isNewEntry) {
    if (isNewEntry) {
        appState.entryMealClockDidSeedModalOpenMain = false;
        appState.entryMealClockDidSeedModalOpenSnack = false;
        appState.entryMealClockDidApplyPhotoExifMain = false;
        appState.entryMealClockDidApplyPhotoExifSnack = false;
        appState.entryMealClockPendingExifHhmmMain = null;
        appState.entryMealClockPendingExifHhmmSnack = null;
    } else {
        appState.entryMealClockDidSeedModalOpenMain = true;
        appState.entryMealClockDidSeedModalOpenSnack = true;
        appState.entryMealClockDidApplyPhotoExifMain = true;
        appState.entryMealClockDidApplyPhotoExifSnack = true;
        appState.entryMealClockPendingExifHhmmMain = null;
        appState.entryMealClockPendingExifHhmmSnack = null;
    }
}

/** 신규 + 해당 슬롯 시간 on: 기본은 미입력(라벨만 1회 세팅) */
function seedEntryMealClockOnModalOpenAfterFinalize(entryId, isSnackMode) {
    if (entryId) return;
    if (!isSnackMode && appState.entryTimeOnMain === true && !appState.entryMealClockDidSeedModalOpenMain) {
        applyMealClockRowFrom24(true, '');
        setEntryMealClockSource(true, 'empty');
        appState.entryMealClockDidSeedModalOpenMain = true;
    }
    if (isSnackMode && appState.entryTimeOnSnack === true && !appState.entryMealClockDidSeedModalOpenSnack) {
        applyMealClockRowFrom24(false, '');
        setEntryMealClockSource(false, 'empty');
        appState.entryMealClockDidSeedModalOpenSnack = true;
    }
}

function schedulePersistEntryModalGaugePrefs() {
    ensureEntryModalGaugesOnUserSettings();
    window.userSettings.entryModalGauges = {
        main: {
            ratingEnabled: appState.entryGaugeRatingOnMain === true,
            satietyEnabled: appState.entryGaugeSatietyOnMain === true,
            timeEnabled: appState.entryTimeOnMain === true
        },
        snack: {
            ratingEnabled: appState.entryGaugeRatingOnSnack === true,
            satietyEnabled: appState.entryGaugeSatietyOnSnack === true,
            timeEnabled: appState.entryTimeOnSnack === true
        }
    };
    if (window.currentUser && isDemoUser(window.currentUser)) return;
    clearTimeout(entryGaugeSaveTimeout);
    entryGaugeSaveTimeout = setTimeout(async () => {
        try {
            await dbOps.saveSettings(window.userSettings);
        } catch (_) { /* ignore */ }
    }, 500);
}

function finalizeEntryModalGauges() {
    applyEntryGaugeDialUi();
    setRating(appState.currentRating);
    renderSatietyButtons('satietyContainer', appState.currentSatiety);
    renderSatietyButtons('snackSatietyContainer', appState.currentSatiety);
}

function initEntryModalGaugeControlsOnce() {
    if (window.__entryGaugeTogglesInit) return;
    window.__entryGaugeTogglesInit = true;

    document.getElementById('entryModal')?.addEventListener('entrydetailprefs', (e) => {
        const { prefs, mode } = e.detail || {};
        if (!prefs || !mode) return;
        syncEntryGaugesFromDetailRecordPrefs(prefs, mode);
    });

    initMealTimeTextInputsOnce();
}

function initMealTimeTextInputsOnce() {
    if (window.__mealTimeTextInputsInit) return;
    window.__mealTimeTextInputsInit = true;

    const bindRow = (mainSide, textId, bridgeId, sourceBtnId, ampmId) => {
        const text = document.getElementById(textId);
        const bridge = document.getElementById(bridgeId);
        const sourceBtn = document.getElementById(sourceBtnId);
        const sel = document.getElementById(ampmId);
        if (!text || !bridge || !sourceBtn) return;

        const selectAllMealClockText = () => {
            try {
                text.setSelectionRange(0, text.value.length);
            } catch (_) {
                try {
                    text.select();
                } catch (_) {}
            }
        };
        text.addEventListener('focus', () => {
            requestAnimationFrame(selectAllMealClockText);
        });

        text.addEventListener('input', () => {
            const next = formatMealClock12TextWhileTyping(text.value);
            if (text.value !== next) text.value = next;
            const raw = mealClock24FromAmPmClock(sel?.value === 'am' ? 'am' : 'pm', text.value);
            const n = normalizeMealClockInputValue(raw || '');
            if (n) bridge.value = n;
        });
        text.addEventListener('blur', () => {
            const d = text.value.replace(/\D/g, '').slice(0, 4);
            if (!d.length) {
                applyMealClockRowFrom24(mainSide, '');
                return;
            }
            let candHourMin;
            if (d.length <= 2) {
                candHourMin = `${d.padStart(2, '0')}:00`;
            } else {
                candHourMin = `${d.slice(0, 2)}:${d.slice(2).padEnd(2, '0').slice(0, 2)}`;
            }
            const n12 = normalizeMealClock12InputValue(candHourMin);
            if (!n12) {
                applyMealClockRowFrom24(mainSide, '');
                return;
            }
            const raw24 = mealClock24FromAmPmClock(sel?.value === 'am' ? 'am' : 'pm', n12) || '';
            applyMealClockRowFrom24(mainSide, normalizeMealClockInputValue(raw24) || '');
            setEntryMealClockSource(mainSide, 'manual');
        });
        if (sel) {
            sel.addEventListener('change', () => {
                const n24 = getMealClock24FromModal(mainSide);
                applyMealClockRowFrom24(mainSide, n24 || '');
                if (n24) setEntryMealClockSource(mainSide, 'manual');
            });
        }
        sourceBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEntryMealTimeSourceSheet(mainSide);
        });
        bridge.addEventListener('change', () => {
            const n = normalizeMealClockInputValue(bridge.value);
            if (n) applyMealClockRowFrom24(mainSide, n);
        });
        bridge.addEventListener('cancel', () => {
            try {
                const n = normalizeMealClockInputValue(bridge.value);
                if (n) applyMealClockRowFrom24(mainSide, n);
            } catch (_) {}
        });
    };

    bindRow(true, 'entryMealTimeInputMain', 'entryMealTimeBridgeMain', 'entryMealTimeSourceBtnMain', 'entryMealAmpmMain');
    bindRow(false, 'entryMealTimeInputSnack', 'entryMealTimeBridgeSnack', 'entryMealTimeSourceBtnSnack', 'entryMealAmpmSnack');
}

function syncEntryModalBodyClass() {
    const el = document.getElementById('entryModal');
    if (el && !el.classList.contains('hidden')) {
        document.body.classList.add('entry-modal-open');
    } else {
        document.body.classList.remove('entry-modal-open');
    }
}

/** 기록 사진 비율 버튼 UI 동기화 + 카메라(등록) 버튼 비율 적용 */
function updatePhotoAspectButtons() {
    const ratio = appState.recordPhotoAspectRatio || '1:1';
    document.querySelectorAll('#entryModal .photo-aspect-btn').forEach((btn) => {
        const isActive = btn.getAttribute('data-aspect') === ratio;
        btn.classList.toggle('photo-aspect-btn--active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

/** 기록 시 모먼트 사진 비율 설정 (1:1 / 3:4 / 4:3) */
export function setRecordPhotoAspectRatio(value) {
    if (!PHOTO_ASPECT_OPTIONS.includes(value)) return;
    appState.recordPhotoAspectRatio = value;
    updatePhotoAspectButtons();
    renderPhotoPreviews(); // 등록 화면 다중 미리보기도 선택 비율로 갱신
}

/** 기록 모달 입력 포커스 해제(칩·태그 탭 시 키보드 닫기) */
function dismissEntryModalFocusedInput() {
    const entryModal = document.getElementById('entryModal');
    if (!entryModal || entryModal.classList.contains('hidden')) return;
    const active = document.activeElement;
    if (active && entryModal.contains(active) && active.matches?.('input, textarea')) {
        active.blur();
    }
}

/** 저장 중 모달 UI (입력·닫기 비활성, 저장 버튼 스피너) */
function setEntryModalSavingState(saving) {
    const entryModal = document.getElementById('entryModal');
    if (!entryModal) return;
    entryModal.classList.toggle('entry-modal-saving', saving);
    entryModal.setAttribute('aria-busy', saving ? 'true' : 'false');
    const btnSave = document.getElementById('btnSave');
    const btnDelete = document.getElementById('btnDelete');
    const grabber = entryModal.querySelector('.entry-modal-grabber');
    if (btnSave) {
        btnSave.disabled = saving;
        if (saving) {
            if (!btnSave.dataset.defaultHtml) btnSave.dataset.defaultHtml = btnSave.innerHTML;
            btnSave.innerHTML =
                '<span class="entry-action-btn__inner entry-action-btn__inner--loading"><i data-lucide="loader-circle" class="text-sm shrink-0 lucide-spin" aria-hidden="true"></i><span>저장 중…</span></span>';
        } else if (btnSave.dataset.defaultHtml) {
            btnSave.innerHTML = btnSave.dataset.defaultHtml;
        }
    }
    if (btnDelete) btnDelete.disabled = saving;
    if (grabber) {
        grabber.setAttribute('aria-disabled', saving ? 'true' : 'false');
        grabber.tabIndex = saving ? -1 : 0;
    }
}

/** 기록 모달: 상단 핸들 아래로 스와이프(드래그)해 닫기 */
function initEntryModalGrabberPullClose(entryModal) {
    if (!entryModal || entryModal._grabberPullCloseInit) return;
    const panel = entryModal.querySelector('.entry-modal-panel');
    const grabber = entryModal.querySelector('.mealog-dialog-grabber, .entry-modal-grabber');
    if (!panel || !grabber) return;
    entryModal._grabberPullCloseInit = true;
    bindDialogGrabberPullClose({
        root: entryModal,
        panel,
        grabber,
        onClose: () => {
            if (typeof window.closeModal === 'function') window.closeModal();
            else closeModal();
        },
        isDisabled: () =>
            entryModal.classList.contains('hidden') || entryModal.classList.contains('entry-modal-saving')
    });
}

/** 저장 성공 후 모달 닫기 (저장 중 사용자가 새 모달을 연 경우 stale 완료는 무시) */
function finishEntryModalAfterSuccessfulSave(saveStartedUnderModalGen) {
    const gen = window.__entryModalOpenGeneration || 0;
    if (saveStartedUnderModalGen != null && gen !== saveStartedUnderModalGen) return;
    setEntryModalSavingState(false);
    closeModal();
}

/** 포커스된 입력이 고정 모달 안에 있을 때, WebView가 텍스트 레이어를 안 그리는 경우 재페인트 유도 */
function nudgeEntryModalInputRepaint(entryModal) {
    const el = document.activeElement;
    if (!el || !entryModal.contains(el) || !el.matches?.('input, textarea')) return;
    requestAnimationFrame(() => {
        if (document.activeElement !== el) return;
        void el.getBoundingClientRect();
        if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
            const p = el.selectionEnd;
            el.setSelectionRange(p, p);
        }
    });
}

/** 끼니 등록 모달: 키보드 열림 시 팝업 높이를 viewport에 맞추고, 닫힘 시 복원 */
/**
 * 키보드 열림: nav·CTA를 #modalScrollArea 끝으로 옮겨 스크롤로 접근.
 * 닫힘: 스크롤 영역 바로 아래(패널 하단 chrome)로 복원.
 * @param {boolean} intoScroll
 */
function placeEntryModalChrome(intoScroll) {
    const scroll = document.getElementById('modalScrollArea');
    const nav = document.getElementById('entrySheetNavBar');
    const actions = document.getElementById('entryModalActions');
    if (!scroll || !nav || !actions) return;
    if (intoScroll) {
        if (nav.parentElement !== scroll) scroll.appendChild(nav);
        if (actions.parentElement !== scroll) scroll.appendChild(actions);
        return;
    }
    if (nav.parentElement === scroll || actions.parentElement === scroll) {
        scroll.after(nav);
        nav.after(actions);
    }
}

function initEntryModalKeyboardHandling(entryModal) {
    if (!entryModal || entryModal._keyboardHandlingInit) return;
    entryModal._keyboardHandlingInit = true;
    let baselineHeight = 0; // 모달 열릴 때 viewport 높이 (키보드 없음)
    let imeComposing = false; // 한글 등 IME 조합 중 여부 (조합 중 레이아웃 업데이트 시 텍스트 미표시 방지)
    let lastAppliedVh = NaN;
    let lastAppliedVtop = NaN;
    let viewportGeomRaf = null;
    let viewportCheckTimer = null;
    let geomSettleTimer = null;
    let chromePlaceRaf = null;
    /** 키보드 열리기 직전 시트 top — 닫을 때 --entry-sheet-top 즉시 복원용 */
    let sheetTopBeforeKeyboard = null;
    /** VV 애니 중 미세 높이 변화에 따른 연속 리레이아웃(깜박임) 억제 */
    const GEOM_SETTLE_MS = 120;
    const GEOM_MIN_DELTA_PX = 12;

    const getViewportThreshold = () => (baselineHeight || window.innerHeight) * 0.85;

    /** 네이티브: 키보드로 밀린 페이지 스크롤 원위치. 모바일 웹은 브라우저 팬을 되돌리면 입력이 키보드에 가림 */
    const pinLayoutViewport = () => {
        if (!window.Capacitor?.isNativePlatform?.()) return;
        if (window.scrollX || window.scrollY) {
            window.scrollTo(0, 0);
        }
        const de = document.documentElement;
        const body = document.body;
        if (de && de.scrollTop) de.scrollTop = 0;
        if (body && body.scrollTop) body.scrollTop = 0;
    };

    /**
     * 키보드 중 시트 top·가용 높이.
     * overlay: 모달을 VV에 직접 핀한 뒤 패널은 pad만 (루트 시프트 대기 없음)
     * resize: layoutH 기준
     */
    const getKeyboardSheetMetrics = () => {
        const m = getImeMetrics();
        const safeRaw = Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--safe-top')
        );
        const safeTop = Number.isFinite(safeRaw) ? Math.max(0, Math.round(safeRaw)) : 0;
        const pad = Math.max(12, Math.min(safeTop || 12, 28));
        if (m.mode === 'overlay') {
            const topPad = Math.min(pad, 10);
            const frameH = Math.max(
                0,
                entryModal.clientHeight ||
                    m.vvH ||
                    window.visualViewport?.height ||
                    window.innerHeight ||
                    0
            );
            return {
                topPx: topPad,
                availPx: Math.max(160, Math.floor(frameH - topPad - 8)),
                trackH: frameH,
                overlay: true
            };
        }
        const layoutH = Math.max(0, m.layoutH || window.innerHeight || 0);
        return {
            topPx: pad,
            availPx: Math.max(160, Math.floor(layoutH - pad - 8)),
            trackH: layoutH,
            overlay: false
        };
    };

    const scrollActiveEntryField = ({ force = false } = {}) => {
        const scroll = document.getElementById('modalScrollArea');
        // 사용자가 직접 스크롤 중이면 포커스 필드로 되감아 CTA 도달을 막지 않음
        if (!force && scroll?.dataset?.entryUserScrolling === '1') return;
        const active = document.activeElement;
        if (!active || !entryModal.contains(active) || !active.matches?.('input, textarea')) return;
        const isMemo = !!active.classList?.contains('entry-comment-textarea');
        scrollEntryFieldIntoView(active, {
            align: isMemo ? 'end' : 'nearest',
            afterMs: 0,
            once: true
        });
    };

    /**
     * @param {{ scroll?: boolean, force?: boolean }} [opts]
     */
    const applyViewportGeometry = (opts = {}) => {
        if (!entryModal.classList.contains('keyboard-open')) return;
        const m = getImeMetrics();
        if (m.mode === 'overlay') {
            // 기록시트: 모달을 VV에 직접 핀 (전역 루트 시프트에 의존하지 않음)
            pinElementToVisualViewport(entryModal, { force: true });
        } else {
            clearOverlayImePinStyles(entryModal);
            entryModal.style.top = '';
            entryModal.style.height = '';
            entryModal.style.left = '';
            entryModal.style.width = '';
            entryModal.style.right = '';
            entryModal.style.bottom = '';
            pinLayoutViewport();
        }

        const sheet = getKeyboardSheetMetrics();
        const topPx = sheet.topPx;
        const avail = sheet.availPx;
        const minDelta = opts.force ? 0.5 : GEOM_MIN_DELTA_PX;
        if (
            !Number.isNaN(lastAppliedVh) &&
            Math.abs(lastAppliedVh - avail) < minDelta &&
            !Number.isNaN(lastAppliedVtop) &&
            Math.abs(lastAppliedVtop - topPx) < 1
        ) {
            // settle 반복 시 스크롤 되감기 금지 — 사용자 스크롤로 CTA 도달 가능해야 함
            return;
        }
        lastAppliedVh = avail;
        lastAppliedVtop = topPx;

        const panel = entryModal.querySelector('.entry-modal-panel');
        if (!panel) return;
        // 세션 top(중앙 정렬값)은 entry-sheet-tabs가 보관. 여기는 CSS 변수만 임시 변경.
        entryModal.style.setProperty('--entry-sheet-top', `${topPx}px`);
        panel.style.top = `${topPx}px`;
        panel.style.maxHeight = `${avail}px`;
        panel.style.height = `${avail}px`;
        panel.style.minHeight = '0px';
        panel.style.setProperty('--entry-sheet-h', `${avail}px`);
        if (opts.scroll) scrollActiveEntryField({ force: !!opts.forceScroll });
    };

    /** VV 애니 중에는 settle 후 높이만 맞춤 — 스크롤은 포커스 시에만 */
    const scheduleViewportGeometryFromVv = ({ immediate = false } = {}) => {
        if (entryModal.classList.contains('hidden')) return;
        if (!entryModal.classList.contains('keyboard-open')) return;
        if (imeComposing) return;
        if (immediate && Number.isNaN(lastAppliedVh)) {
            applyViewportGeometry({ scroll: false, force: true });
        }
        if (geomSettleTimer != null) clearTimeout(geomSettleTimer);
        geomSettleTimer = setTimeout(() => {
            geomSettleTimer = null;
            if (entryModal.classList.contains('hidden')) return;
            if (!entryModal.classList.contains('keyboard-open')) return;
            if (imeComposing) return;
            applyViewportGeometry({ scroll: false, force: true });
        }, GEOM_SETTLE_MS);
    };

    entryModal.querySelectorAll('input, textarea').forEach(el => {
        el.addEventListener('compositionstart', () => { imeComposing = true; });
        el.addEventListener('compositionend', () => {
            imeComposing = false;
            // input마다 selection 리셋하면 깜박임 — 조합 종료 시에만 리페인트
            nudgeEntryModalInputRepaint(entryModal);
            scheduleViewportGeometryFromVv();
        });
    });
    const scheduleViewportCheck = () => {
        if (viewportCheckTimer != null) clearTimeout(viewportCheckTimer);
        requestAnimationFrame(() => {
            viewportCheckTimer = setTimeout(() => {
                viewportCheckTimer = null;
                checkViewport();
            }, 80);
        });
    };

    const setKeyboardOpen = (open) => {
        if (open) {
            if (!entryModal.classList.contains('keyboard-open')) {
                const panel = entryModal.querySelector('.entry-modal-panel');
                const prevTop = Number.parseFloat(panel?.style?.top)
                    || Number.parseFloat(panel ? getComputedStyle(panel).top : '')
                    || Number.parseFloat(
                        entryModal.style.getPropertyValue('--entry-sheet-top')
                    )
                    || 16;
                sheetTopBeforeKeyboard = Number.isFinite(prevTop) ? prevTop : 16;
                lastAppliedVh = NaN;
                lastAppliedVtop = NaN;
                entryModal.classList.add('keyboard-open');
                const active = document.activeElement;
                const isMemo = !!active?.classList?.contains('entry-comment-textarea');
                // 높이·top 맞춤 후 CTA를 스크롤 끝으로. 자동 스크롤은 메모만(중간 필드는 사용자 스크롤 방해 금지)
                applyViewportGeometry({ scroll: isMemo, force: true, forceScroll: isMemo });
                if (chromePlaceRaf != null) cancelAnimationFrame(chromePlaceRaf);
                chromePlaceRaf = requestAnimationFrame(() => {
                    chromePlaceRaf = null;
                    if (!entryModal.classList.contains('keyboard-open')) return;
                    placeEntryModalChrome(true);
                    scheduleViewportGeometryFromVv({ immediate: false });
                });
            } else {
                scheduleViewportGeometryFromVv();
            }
        } else if (entryModal.classList.contains('keyboard-open')) {
            entryModal.classList.remove('keyboard-open');
            placeEntryModalChrome(false);
            lastAppliedVh = NaN;
            lastAppliedVtop = NaN;
            if (viewportGeomRaf != null) {
                cancelAnimationFrame(viewportGeomRaf);
                viewportGeomRaf = null;
            }
            if (chromePlaceRaf != null) {
                cancelAnimationFrame(chromePlaceRaf);
                chromePlaceRaf = null;
            }
            if (geomSettleTimer != null) {
                clearTimeout(geomSettleTimer);
                geomSettleTimer = null;
            }
            if (viewportCheckTimer != null) {
                clearTimeout(viewportCheckTimer);
                viewportCheckTimer = null;
            }
            clearOverlayImePinStyles(entryModal);
            entryModal.style.height = '';
            entryModal.style.top = '';
            entryModal.style.left = '';
            entryModal.style.width = '';
            entryModal.style.right = '';
            entryModal.style.bottom = '';
            pinLayoutViewport();
            const panel = entryModal.querySelector('.entry-modal-panel');
            if (panel) {
                // 키보드 중 키운 인라인 높이를 비워 피크 잠금이 다시 먹게 함
                panel.style.maxHeight = '';
                panel.style.height = '';
                panel.style.minHeight = '';
                panel.style.removeProperty('--entry-sheet-h');
                // sync rAF 전에 중앙 top이 잠깐 키보드 top으로 남지 않도록 즉시 복원
                if (sheetTopBeforeKeyboard != null) {
                    const t = `${sheetTopBeforeKeyboard}px`;
                    entryModal.style.setProperty('--entry-sheet-top', t);
                    panel.style.top = t;
                }
            }
            sheetTopBeforeKeyboard = null;
            // 키보드로 일시 축소했던 패널 높이를 피크 잠금으로 복원
            if (typeof window.syncEntrySheetHeightLock === 'function') {
                window.syncEntrySheetHeightLock();
            }
        }
    };
    // 모달 열릴 때 baseline 저장 (openModal에서 호출)
    const saveBaseline = () => {
        baselineHeight = Math.max(window.visualViewport?.height ?? window.innerHeight, window.innerHeight * 0.5);
    };
    entryModal.setKeyboardBaseline = saveBaseline;
    const scrollAreaEl = document.getElementById('modalScrollArea');
    let entryUserScrollClearTimer = null;
    const markEntryUserScrolling = () => {
        if (!scrollAreaEl) return;
        scrollAreaEl.dataset.entryUserScrolling = '1';
        if (entryUserScrollClearTimer != null) clearTimeout(entryUserScrollClearTimer);
        entryUserScrollClearTimer = setTimeout(() => {
            entryUserScrollClearTimer = null;
            if (scrollAreaEl) delete scrollAreaEl.dataset.entryUserScrolling;
        }, 2000);
    };
    if (scrollAreaEl && !scrollAreaEl._entryUserScrollBound) {
        scrollAreaEl._entryUserScrollBound = true;
        scrollAreaEl.addEventListener('touchstart', markEntryUserScrolling, { passive: true });
        scrollAreaEl.addEventListener('wheel', markEntryUserScrolling, { passive: true });
    }

    entryModal.addEventListener('focusin', (e) => {
        if (!e.target.matches?.('input, textarea')) return;
        captureImeBaseline();
        const isMemo = !!e.target.classList?.contains('entry-comment-textarea');
        const overlay = getImeMetrics().mode === 'overlay' || isMobileWebTouchUi();
        // overlay: 포커스 직후 모달을 현재 VV에 바로 핀 (전역 ime-open 대기 없음)
        if (overlay) {
            pinElementToVisualViewport(entryModal, { force: true });
        }
        // 포커스 진입 시 한 번만 맞춤. 이후 VV settle/자동 스크롤로 되감지 않음 → CTA까지 수동 스크롤 가능
        if (entryModal.classList.contains('keyboard-open') || isMemo || overlay) {
            if (scrollAreaEl) delete scrollAreaEl.dataset.entryUserScrolling;
            scrollEntryFieldIntoView(e.target, {
                align: isMemo ? 'end' : 'nearest',
                afterMs: 0,
                once: true
            });
        }
        scheduleViewportCheck();
    });
    entryModal.addEventListener('focusout', (e) => {
        if (e.target.matches('input, textarea')) scheduleViewportCheck();
    });
    const checkViewport = () => {
        if (entryModal.classList.contains('hidden')) return;
        const m = getImeMetrics();
        const vh = m.mode === 'resize'
            ? (m.layoutH || window.innerHeight || 0)
            : (m.vvH || window.visualViewport?.height || window.innerHeight || 0);
        const threshold = getViewportThreshold();
        // ime-viewport open 신호 우선 (웹 포커스-only 제거와 정합). threshold는 보조.
        const open =
            m.open ||
            getNativeImeHeight() > 80 ||
            (vh > 0 && vh < threshold);
        if (!open) {
            setKeyboardOpen(false);
            return;
        }
        setKeyboardOpen(true);
        if (imeComposing) return;
        scheduleViewportGeometryFromVv();
    };
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleViewportCheck);
        window.visualViewport.addEventListener('scroll', scheduleViewportCheck);
    }
    window.addEventListener('resize', scheduleViewportCheck);
}

// 카카오 SDK 로드 함수
function loadKakaoSDK() {
    // 이미 로드 중이거나 로드 완료된 경우 스킵
    if (window.kakaoSDKLoading || window.kakaoSDKLoaded) {
        return Promise.resolve();
    }
    
    // 이미 스크립트 태그가 있는지 확인
    const existingScript = document.querySelector('script[src*="dapi.kakao.com"]');
    if (existingScript) {
        // 스크립트가 있으면 로드 완료를 기다림
        return new Promise((resolve) => {
            if (window.kakaoSDKLoaded) {
                resolve();
                return;
            }
            
            // 최대 5초 대기
            let attempts = 0;
            const maxAttempts = 50;
            const checkInterval = setInterval(() => {
                attempts++;
                if (window.kakaoSDKLoaded || typeof kakao !== 'undefined') {
                    clearInterval(checkInterval);
                    resolve();
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    resolve(); // 타임아웃이어도 계속 진행
                }
            }, 100);
        });
    }
    
    // 로드 중 플래그 설정
    window.kakaoSDKLoading = true;
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        // Mealog JavaScript 키: 42dce12f04991c35775f3ce1081a3c76
        // 중요: JavaScript SDK는 반드시 JavaScript 키를 사용해야 함 (REST API 키 아님)
        const appkey = '42dce12f04991c35775f3ce1081a3c76';
        
        // 페이지와 동일한 프로토콜 사용 (Mixed Content 방지: HTTPS 페이지에서 HTTP 스크립트 차단됨)
        const protocol = window.location.protocol || 'https:';
        const scriptUrl = protocol + '//dapi.kakao.com/v2/maps/sdk.js?appkey=' + appkey + '&libraries=services&autoload=false';
        script.src = scriptUrl;
        script.async = true;
        
        script.onload = function() {
            // autoload=false를 사용했으므로 kakao.maps.load()를 명시적으로 호출해야 함
            if (typeof kakao !== 'undefined' && kakao && kakao.maps && typeof kakao.maps.load === 'function') {
                kakao.maps.load(function() {
                    // kakao.maps.load() 콜백 내에서 services 라이브러리가 완전히 준비됨
                    try {
                        if (kakao.maps.services && typeof kakao.maps.services.Places !== 'undefined') {
                            window.kakaoSDKLoaded = true;
                            window.kakaoSDKLoading = false;
                            console.log('✅ 카카오 SDK 로드 완료 (services 라이브러리 준비됨)');
                            if (typeof window.onKakaoSDKLoaded === 'function') {
                                window.onKakaoSDKLoaded();
                            }
                            resolve();
                        } else {
                            window.kakaoSDKLoaded = false;
                            window.kakaoSDKLoading = false;
                            console.warn('⚠️ 카카오 SDK 로드 후 services 라이브러리가 준비되지 않았습니다.');
                            console.warn('   - kakao 객체 상태:', {
                                defined: typeof kakao !== 'undefined',
                                maps: typeof kakao?.maps,
                                services: typeof kakao?.maps?.services
                            });
                            reject(new Error('카카오 SDK services 라이브러리 초기화 실패'));
                        }
                    } catch (e) {
                        window.kakaoSDKLoaded = false;
                        window.kakaoSDKLoading = false;
                        console.error('❌ kakao.maps.load 콜백에서 에러:', e);
                        reject(e);
                    }
                });
            } else {
                window.kakaoSDKLoaded = false;
                window.kakaoSDKLoading = false;
                console.error('❌ 카카오 SDK 스크립트는 로드되었지만 kakao.maps.load 함수를 찾을 수 없습니다.');
                reject(new Error('카카오 SDK load 함수를 찾을 수 없음'));
            }
        };
        
        script.onerror = function(e) {
            window.kakaoSDKLoaded = false;
            window.kakaoSDKLoading = false;
            console.error('❌ 카카오 지도 SDK 스크립트 로드 실패');
            console.error('   - 스크립트 URL:', scriptUrl);
            console.error('   - 현재 프로토콜:', window.location.protocol);
            console.error('   - 현재 호스트:', window.location.host);
            console.error('   - 가능한 원인:');
            console.error('     1. 네트워크 연결 문제');
            console.error('     2. 카카오 디벨로퍼스 플랫폼 도메인 미등록');
            console.error('     3. JavaScript 키 오류 또는 카카오맵 사용 설정 OFF');
            console.error('   - 브라우저 개발자 도구(F12) > Network 탭에서 스크립트 로드 상태 확인');
            reject(new Error('카카오 SDK 스크립트 로드 실패: ' + scriptUrl));
        };
        
        document.head.appendChild(script);
    });
}

function resetEntryModalScrollTop() {
    const scrollArea = document.getElementById('modalScrollArea');
    if (!scrollArea) return;
    scrollArea.scrollTop = 0;
    if (typeof scrollArea.scrollTo === 'function') {
        scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
}

async function fetchMealRecordForEdit(entryId) {
    if (!entryId || !window.currentUser?.uid) return null;
    const cached = window.mealHistory?.find((m) => m.id === entryId);
    if (cached) return cached;

    const ref = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', entryId);
    let savedRecord = null;
    const mergeRec = (snap) => {
        if (!snap.exists()) return;
        let rec = { id: snap.id, ...snap.data() };
        const shift = isDemoUser(window.currentUser) ? Number(window.__demoDateShiftDays) || 0 : 0;
        if (shift) rec = applyDemoDateShiftToMealRecord(rec, shift);
        savedRecord = rec;
        const hist = window.mealHistory || [];
        if (!hist.some((m) => m.id === entryId)) {
            window.mealHistory = [...hist, rec].sort(
                (a, b) =>
                    (b.date || '').localeCompare(a.date || '') ||
                    (b.time || '').localeCompare(a.time || '')
            );
        }
    };
    try {
        // meals 단건 읽기 — App Check 미요구 경로라 preflight 없이 바로 조회한다
        // (모달 여는 속도에 그대로 얹히던 대기였다)
        mergeRec(await getDoc(ref));
    } catch (e) {
        const isPerm =
            e?.code === 'permission-denied' ||
            e?.code === 'PERMISSION_DENIED' ||
            /permission/i.test(String(e?.message || ''));
        if (isPerm) {
            try {
                await refreshAppCheckTokenBeforeFirestore();
                await new Promise((r) => setTimeout(r, 400));
                mergeRec(await getDoc(ref));
            } catch (e2) {
                console.warn('openModal: meal 단건 조회 실패', entryId, e2);
            }
        } else {
            console.warn('openModal: meal 단건 조회 실패', entryId, e);
        }
    }
    return savedRecord;
}

function resetEntryModalFormFields() {
    const entryModal = document.getElementById('entryModal');
    entryModal?.querySelectorAll('.chip, .sub-chip').forEach((el) => el.classList.remove('active'));

    document.getElementById('sharePhotoIndicator')?.classList.add('hidden');

    ['entryWhereInput', 'entryWhatInput', 'entryWithInput', 'deliveryVendorInput', 'generalCommentInput', 'snackCommentInput'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    autosizeEntryWhatInput();
    syncEntryCommentExpandedState(document.getElementById('generalCommentInput'));
    syncEntryCommentExpandedState(document.getElementById('snackCommentInput'));

    const entryWhereInput = document.getElementById('entryWhereInput');
    if (entryWhereInput) {
        entryWhereInput.placeholder = '돋보기 버튼으로 장소 검색 또는 직접 입력';
        entryWhereInput.removeAttribute('data-kakao-place-id');
        entryWhereInput.removeAttribute('data-kakao-place-address');
        entryWhereInput.removeAttribute('data-kakao-place-data');
        entryWhereInput.removeAttribute('data-kakao-place-name');
    }
    const deliveryVendorInput = document.getElementById('deliveryVendorInput');
    if (deliveryVendorInput) {
        deliveryVendorInput.placeholder = '어느 식당 음식인가요?';
        deliveryVendorInput.removeAttribute('data-kakao-place-id');
        deliveryVendorInput.removeAttribute('data-kakao-place-address');
        deliveryVendorInput.removeAttribute('data-kakao-place-data');
        deliveryVendorInput.removeAttribute('data-kakao-place-name');
    }
    document.getElementById('deliveryVendorSection')?.classList.add('hidden');

    const mainPhotoContainer = document.getElementById('photoPreviewContainer');
    const snackPhotoContainer = document.getElementById('snackPhotoPreviewContainer');
    if (mainPhotoContainer) mainPhotoContainer.innerHTML = '';
    if (snackPhotoContainer) snackPhotoContainer.innerHTML = '';

    resetEntryModalScrollTop();

    ['entryWhereSuggestions', 'entryWhatSuggestions', 'entryWithSuggestions'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.add('no-scrollbar');
            el.classList.remove('scrollbar-hide');
        }
    });
}

function applyEntryModalSaveButtonState(entryId, savedRecord) {
    const btnSave = document.getElementById('btnSave');
    if (!btnSave) return;
    if (window.currentUser && window.currentUser.isAnonymous) {
        btnSave.disabled = true;
        btnSave.className =
            'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-300 text-slate-500 text-base font-bold transition-colors cursor-not-allowed';
        btnSave.innerText = '로그인 후 사용할 수 있어요';
        btnSave.removeAttribute('title');
    } else if (entryId && savedRecord && isMealEntrySaveFailed(savedRecord)) {
        btnSave.disabled = true;
        btnSave.className =
            'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-400 text-white text-sm font-bold transition-colors cursor-not-allowed';
        btnSave.innerHTML = '<span class="leading-tight text-center">서버 등록 후 수정 가능</span>';
        btnSave.title = '서버 등록 후 수정이 가능합니다';
    } else {
        btnSave.disabled = false;
        btnSave.className = 'entry-action-btn entry-action-btn--save flex-[1.7] flex flex-col items-center justify-center px-3 py-3.5';
        btnSave.innerHTML =
            '<span class="entry-action-btn__inner"><span>' + (entryId ? '수정 완료' : '기록 완료') + '</span></span>';
        delete btnSave.dataset.defaultHtml;
        btnSave.removeAttribute('title');
    }
}

function populateSavedRecordIntoForm(r, isS, state) {
    state.currentPhotos = Array.isArray(r.photos) ? r.photos : r.photos ? [r.photos] : [];
    state.recordPhotoHeroIndex = 0;
    state.currentPhotoMeta = normalizePhotoMetaFromRecord(r.photoMeta, state.currentPhotos.length);
    const isShareBanned = r.shareBanned === true;
    const sharedUrls = r.id ? getSharedPhotoUrlsForEntry(r.id) : [];
    state.sharedPhotos = sharedUrls;
    state.originalSharedPhotos = [...sharedUrls];
    state.recordPhotoAspectRatio =
        r.photoAspectRatio && PHOTO_ASPECT_OPTIONS.includes(r.photoAspectRatio) ? r.photoAspectRatio : '1:1';
    state.originalPhotoAspectRatio = state.recordPhotoAspectRatio;

    state.wantsToShare = isShareBanned ? false : sharedUrls.length > 0;

    renderPhotoPreviews();
    updateShareIndicator();
    updatePhotoAspectButtons();

    setVal('entryWhereInput', r.place || '');
    const _pi = document.getElementById('entryWhereInput');
    if (_pi && (r.placeId || r.placeAddress || r.placeData)) {
        if (r.placeId) _pi.setAttribute('data-kakao-place-id', r.placeId);
        _pi.setAttribute(
            'data-kakao-place-address',
            r.placeAddress != null && r.placeAddress !== undefined ? String(r.placeAddress) : ''
        );
        if (r.placeData && typeof r.placeData === 'object') _pi.setAttribute('data-kakao-place-data', JSON.stringify(r.placeData));
        _pi.setAttribute('data-kakao-place-name', (r.placeData && r.placeData.name) || r.place || '');
    }
    setVal('entryWhatInput', r.menuDetail || '');
    autosizeEntryWhatInput();
    setVal('deliveryVendorInput', !isS ? r.deliveryVendor || '' : '');
    const _dvi = document.getElementById('deliveryVendorInput');
    if (!isS && _dvi && (r.deliveryPlaceId || r.deliveryPlaceAddress || r.deliveryPlaceData)) {
        if (r.deliveryPlaceId) _dvi.setAttribute('data-kakao-place-id', r.deliveryPlaceId);
        _dvi.setAttribute(
            'data-kakao-place-address',
            r.deliveryPlaceAddress != null && r.deliveryPlaceAddress !== undefined ? String(r.deliveryPlaceAddress) : ''
        );
        if (r.deliveryPlaceData && typeof r.deliveryPlaceData === 'object') {
            _dvi.setAttribute('data-kakao-place-data', JSON.stringify(r.deliveryPlaceData));
        }
        const dn = (r.deliveryPlaceData && r.deliveryPlaceData.name) || r.deliveryVendor || '';
        _dvi.setAttribute('data-kakao-place-name', dn);
    }
    setVal('entryWithInput', r.withWhomDetail || '');
    setVal('generalCommentInput', r.comment || '');
    setVal('snackCommentInput', r.comment || '');
    syncEntryCommentExpandedState(document.getElementById('generalCommentInput'));
    syncEntryCommentExpandedState(document.getElementById('snackCommentInput'));

    const rn = r.rating != null && r.rating !== '' ? Number(r.rating) : NaN;
    const sn = r.satiety != null && r.satiety !== '' ? Number(r.satiety) : NaN;
    window.setRating(Number.isFinite(rn) ? rn : null);
    window.setSatiety(Number.isFinite(sn) ? sn : null);
    updateShareIndicator();

}

function activateChipByText(containerId, text) {
    if (!text) return;
    const trimmed = String(text).trim();
    document.getElementById(containerId)?.querySelectorAll('button.chip').forEach((ch) => {
        if (ch.innerText.trim() === trimmed) ch.classList.add('active');
    });
}

function activateSubChipsByTexts(containerId, texts) {
    const values = (Array.isArray(texts) ? texts : [texts]).map((v) => String(v).trim()).filter(Boolean);
    if (!values.length) return [];
    const activeValues = [];
    document.getElementById(containerId)?.querySelectorAll('button.sub-chip').forEach((ch) => {
        const chipText = ch.innerText.trim().replace(/\s*★\s*$/, '');
        if (values.includes(chipText)) {
            ch.classList.add('active');
            activeValues.push(chipText);
        }
    });
    return activeValues;
}

/** 수정 모드: renderEntryChips 직후 1회 태그·서브태그 활성화 */
function activateSavedRecordTags(r, isS) {
    if (!r) return;

    const subTags = window.userSettings?.subTags || {};
    const cfg = getEntryModeConfig(isS ? 'snack' : 'meal');

    if (r.mealType) activateChipByText(ENTRY_DOM.whereChips, r.mealType);
    if (r.category) activateChipByText(ENTRY_DOM.whatChips, r.category);
    if (r.withWhom) activateChipByText(ENTRY_DOM.withChips, r.withWhom);
    if (r.snackType) activateChipByText(ENTRY_DOM.whatChips, r.snackType);

    let snackMainTag = '';
    if (!isS) {
        if (r.mealType) {
            window.renderSecondary(
                ENTRY_DOM.whereSuggestions,
                subTags.place || [],
                ENTRY_DOM.whereInput,
                r.mealType.trim(),
                cfg.axis1SubTagKey
            );
        }
        if (r.category) {
            window.renderSecondary(
                ENTRY_DOM.whatSuggestions,
                subTags[cfg.axis2SubTagsKey] || [],
                ENTRY_DOM.whatInput,
                r.category.trim(),
                cfg.axis2SubTagKey
            );
        }
        if (r.withWhom) {
            window.renderSecondary(
                ENTRY_DOM.withSuggestions,
                subTags.people || [],
                ENTRY_DOM.withInput,
                r.withWhom.trim(),
                ENTRY_MODE_CONFIG.withSubTagKey
            );
        }
        if (r.place) activateSubChipsByTexts(ENTRY_DOM.whereSuggestions, [r.place]);
    } else {
        const snackPlaceMainList = window.userSettings?.tags?.snackPlaceMain || ['집', '사무실', '카페'];
        snackMainTag =
            (r.snackPlaceMain || '').trim() ||
            (r.place && snackPlaceMainList.includes(r.place.trim()) ? r.place.trim() : '');
        if (snackMainTag) {
            appState.selectedSnackPlaceMainTag = snackMainTag;
            activateChipByText(ENTRY_DOM.whereChips, snackMainTag);
            window.renderSecondary(
                ENTRY_DOM.whereSuggestions,
                subTags.place || [],
                ENTRY_DOM.whereInput,
                snackMainTag,
                cfg.axis1SubTagKey
            );
        }
        if (r.snackType) {
            window.renderSecondary(
                ENTRY_DOM.whatSuggestions,
                subTags[cfg.axis2SubTagsKey] || [],
                ENTRY_DOM.whatInput,
                r.snackType,
                cfg.axis2SubTagKey
            );
        }
        const placeDetail = (r.place || '').trim();
        if (placeDetail && placeDetail !== snackMainTag) {
            activateSubChipsByTexts(ENTRY_DOM.whereSuggestions, [placeDetail]);
        }
    }

    if (r.menuDetail) {
        const detailValues = r.menuDetail.split(',').map((v) => v.trim()).filter(Boolean);
        activateSubChipsByTexts(ENTRY_DOM.whatSuggestions, detailValues);
        const entryWhatInput = document.getElementById(ENTRY_DOM.whatInput);
        if (entryWhatInput && detailValues.length > 0) {
            entryWhatInput.value = detailValues.join(', ');
            autosizeEntryWhatInput();
        }
    }
    if (r.withWhomDetail) {
        const detailValues = r.withWhomDetail.split(',').map((v) => v.trim()).filter(Boolean);
        activateSubChipsByTexts(ENTRY_DOM.withSuggestions, detailValues);
        const entryWithInput = document.getElementById(ENTRY_DOM.withInput);
        if (entryWithInput && detailValues.length > 0) {
            entryWithInput.value = detailValues.join(', ');
        }
    }

    if (r.mealType === 'Skip' || r.mealType === '건너뜀') {
        toggleFieldsForSkip(true);
    }

    syncDeliveryVendorSectionVisibility();
}

function ensureEntryWhatInputSnackCompositionInit() {
    const entryWhatInput = document.getElementById('entryWhatInput');
    if (!entryWhatInput || entryWhatInput._snackCompositionInit) return;
    // 입력(스페이스 포함)마다 스테이지를 main↔sub로 뒤집지 않고, 선택된 메인태그 아래 칩 active만 갱신
    const updateWhatSuggestionActives = () => {
        const parentFilter = document.querySelector('#entryWhatChips button.active')?.innerText;
        if (!parentFilter) return;
        const isSnack = appState.entryFormMode === 'snack';
        const subTagKey = isSnack ? 'snack' : 'menu';
        const list = window.userSettings?.subTags?.[subTagKey] || [];
        if (typeof window.renderSecondary === 'function') {
            window.renderSecondary(
                'entryWhatSuggestions',
                list,
                'entryWhatInput',
                parentFilter,
                subTagKey,
                { preserveStage: true }
            );
        }
    };
    addCompositionAwareInput(entryWhatInput, updateWhatSuggestionActives);
    entryWhatInput._snackCompositionInit = true;
}

function autosizeEntryWhatInput() {
    const el = document.getElementById('entryWhatInput');
    if (!el || el.tagName !== 'TEXTAREA') return;
    const minH = Number.parseFloat(getComputedStyle(el).minHeight) || 60;
    // 비어 있을 때(2줄 placeholder)는 min-height 유지
    if (!(el.value || '').length) {
        el.style.height = `${minH}px`;
        return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.max(minH, el.scrollHeight)}px`;
}

function bindEntryWhatInputAutosizeOnce() {
    const el = document.getElementById('entryWhatInput');
    if (!el || el._whatAutosizeBound || el.tagName !== 'TEXTAREA') return;
    el._whatAutosizeBound = true;
    const resize = () => autosizeEntryWhatInput();
    el.addEventListener('input', resize);
    el.addEventListener('change', resize);
}

/** 기록 시트 스크롤 영역 안에서 필드를 보이게 맞춤 (오버레이/센터 정렬은 건드리지 않음) */
function scrollEntryFieldIntoView(el, { align = 'nearest', afterMs = 0, once = false } = {}) {
    const scroll = document.getElementById('modalScrollArea');
    if (!scroll || !el || !scroll.contains(el)) return;
    // 사용자 스크롤 중에는 포커스 필드로 되감지 않음 (무엇을 포커스→CTA 도달 방해 방지)
    if (scroll.dataset?.entryUserScrolling === '1') return;
    // once: 키보드 settle 후 단일 보정 — 다중 딜레이 버스트는 시트 깜박임·스크롤 고착 유발
    const delays = once
        ? [0]
        : afterMs > 0
          ? [0, afterMs, afterMs + 150]
          : [0, 80, 200];
    ensureFocusedInputVisible(el, {
        align,
        scrollParent: scroll,
        pad: 12,
        delays,
        suppressDocumentScroll: true
    });
}

/** 메모 textarea: 내용/포커스 시 높이만큼 키우고, 시트(#modalScrollArea)가 스크롤되게 함 */
function autosizeEntryCommentTextarea(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    const keepOpen = el.classList.contains('entry-comment-textarea--expanded')
        || document.activeElement === el
        || !!(el.value || '').length;
    if (!keepOpen) {
        el.style.height = '';
        return;
    }
    el.style.height = 'auto';
    const minH = Number.parseFloat(getComputedStyle(el).minHeight) || 0;
    el.style.height = `${Math.max(minH, el.scrollHeight)}px`;
}

function syncEntryCommentExpandedState(el, { fromFocus = false } = {}) {
    if (!el) return;
    // 내용이 있거나 포커스 중이면 확장 — 빈 칸 blur 시에만 1줄로 접음
    const hasContent = !!(el.value || '').length;
    const focused = document.activeElement === el;
    const keepOpen = focused || hasContent;
    const prevHeight = el.offsetHeight || 0;
    const wasExpanded = el.classList.contains('entry-comment-textarea--expanded');
    el.classList.toggle('entry-comment-textarea--expanded', keepOpen);
    // 여유 줄(rows=3)을 미리 비워두지 않음 — 내용만큼만 키우고 시트 높이를 올린다
    el.rows = 1;
    if (!keepOpen) {
        el.style.height = '';
        return;
    }
    autosizeEntryCommentTextarea(el);
    const nextHeight = el.offsetHeight || 0;
    const grewBy = nextHeight - prevHeight;
    const grew = grewBy > 1;
    const modal = document.getElementById('entryModal');
    const keyboardOpen = !!modal?.classList.contains('keyboard-open');
    if (
        (grew || !wasExpanded || fromFocus) &&
        typeof window.syncEntrySheetHeightLock === 'function'
    ) {
        if (keyboardOpen && grew) {
            window.syncEntrySheetHeightLock({ growthPx: grewBy });
        } else {
            window.syncEntrySheetHeightLock();
        }
    }
    // 메모: 키보드 전이라도 시트 스크롤 영역 안으로. 열린 뒤에는 end 정렬 버스트.
    if (focused && (grew || fromFocus)) {
        const overlay = getImeMetrics().mode === 'overlay' || isMobileWebTouchUi();
        scrollEntryFieldIntoView(el, {
            align: 'end',
            afterMs: overlay || keyboardOpen ? 80 : 0,
            once: !(overlay || keyboardOpen)
        });
    }
}

function bindEntryCommentExpandOnce() {
    ['generalCommentInput', 'snackCommentInput'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el || el._commentExpandBound) return;
        el._commentExpandBound = true;
        el.addEventListener('focus', () => syncEntryCommentExpandedState(el, { fromFocus: true }));
        el.addEventListener('blur', () => syncEntryCommentExpandedState(el));
        el.addEventListener('input', () => syncEntryCommentExpandedState(el));
        syncEntryCommentExpandedState(el);
    });
}

function revealEntryModalShell() {
    const entryModal = document.getElementById('entryModal');
    if (!entryModal) {
        console.error('entryModal 요소를 찾을 수 없습니다.');
        return null;
    }
    setEntryModalSavingState(false);
    bindEntryModalHeaderOnce();
    refreshEntryModalHeader();
    lockBodyScroll('entryModal');
    const openGen = (window.__entryModalOpenGeneration || 0) + 1;
    window.__entryModalOpenGeneration = openGen;
    entryModal.classList.remove('hidden');
    entryModal.classList.remove('keyboard-open');
    placeEntryModalChrome(false);
    clearOverlayImePinStyles(entryModal);
    entryModal.style.height = '';
    entryModal.style.top = '';
    entryModal.style.left = '';
    entryModal.style.width = '';
    entryModal.style.right = '';
    entryModal.style.bottom = '';
    resetEntryModalScrollTop();
    requestAnimationFrame(resetEntryModalScrollTop);
    setTimeout(resetEntryModalScrollTop, 60);
    initEntryModalKeyboardHandling(entryModal);
    initEntryModalGrabberPullClose(entryModal);
    if (typeof entryModal.resetGrabberPullTransform === 'function') {
        entryModal.resetGrabberPullTransform();
    }
    if (typeof entryModal.setKeyboardBaseline === 'function') {
        entryModal.setKeyboardBaseline();
    }
    syncEntryModalBodyClass();
    return openGen;
}

export async function openModal(date, slotId, entryId = null) {
    try {
        const state = appState;
        if (!window.currentUser) return;
        
        if (!date || !slotId) {
            console.error('openModal: 필수 파라미터가 없습니다.', { date, slotId });
            return;
        }

        if (
            slotId === 'daily_journal' ||
            (entryId && String(entryId).startsWith('dailyJournal_')) ||
            isDailyJournalMealRecord({ date, slotId, id: entryId })
        ) {
            if (typeof window.openDailyJournalModal === 'function') {
                window.openDailyJournalModal(date);
            }
            return;
        }

        if (entryId) {
            const pendingRec = window.mealHistory?.find((m) => m.id === entryId);
            if (pendingRec && isMealEntryDeleting(pendingRec)) {
                showToast('삭제 중입니다. 잠시 후 다시 시도해 주세요.', 'info');
                return;
            }
            // 등록 대기(pending) 항목도 열기 허용 (ID 선발급 후 setDoc은 멱등이라 수정·삭제 안전).
            // 단 temp_ 폴백 행은 실제 문서 ID가 없어 수정 저장이 불가 — 기존대로 차단
            if (pendingRec && String(entryId).startsWith('temp_') && isMealEntryPendingSync(pendingRec)) {
                showToast('서버에 등록 중입니다. 잠시 후 다시 시도해 주세요.', 'info');
                return;
            }
        }
        
        // 카카오 SDK 로드 (비동기, 백그라운드에서 로드)
        loadKakaoSDK().catch(err => {
            console.warn('카카오 SDK 로드 실패 (무시):', err);
        });
        
        state.currentEditingId = entryId;
        state.currentEditingDate = date;
        state.currentEditingSlotId = slotId;
        resetEntryMealClockSessionFlagsForOpen(!entryId);
        state.currentPhotos = [];
        state.recordPhotoHeroIndex = 0;
        state.currentPhotoMeta = [];
        state.entryMealClockSourceMain = null;
        state.entryMealClockSourceSnack = null;
        state.sharedPhotos = []; // 이미 공유된 사진 목록
        state.originalSharedPhotos = []; // 원본 공유 사진 목록 (삭제 추적용)
        state.wantsToShare = false; // 공유를 원하는지 여부
        // 새 기록 시 비율은 전역 선택값 사용 (수정 시에는 아래에서 기존 기록값으로 덮어씀)
        state.recordPhotoAspectRatio = appState.recordPhotoAspectRatio || '1:1';
        state.originalPhotoAspectRatio = state.recordPhotoAspectRatio;
        
        const slot = SLOTS.find((s) => s.id === slotId);
        if (!slot) {
            console.error('슬롯을 찾을 수 없습니다:', slotId);
            return;
        }

        let savedRecord = entryId ? window.mealHistory?.find((m) => m.id === entryId) ?? null : null;

        resetEntryModalFormFields();

        appState.entryFormMode = inferEntryFormModeFromRecord(savedRecord, slot);
        const isS = appState.entryFormMode === 'snack';
        applyEntryFormModeToModalUI(appState.entryFormMode);
        document.getElementById('optionalFields')?.classList.remove('hidden');
        document.getElementById('btnDelete')?.classList.add('hidden');
        updatePhotoAspectButtons();
        ['entryWhatSuggestions', 'entryWhereSuggestions', 'entryWithSuggestions'].forEach((id) => {
            if (typeof window.setEntryTagStageView === 'function') {
                window.setEntryTagStageView(id, 'main');
            }
        });
        if (isS) appState.selectedSnackPlaceMainTag = null;
        if (!isS) toggleFieldsForSkip(false);

        initEntryModalGaugeControlsOnce();
        bindEntryQuickInputOnce();
        bindEntryDetailRecordOnce();
        bindEntrySheetTabsOnce();
        resetEntrySheetTab();
        resetEntrySheetBaseHeight();
        setEntrySheetTabsForSkip(false);
        finalizeEntryModalQuickInput();
        ensureEntryWhatInputSnackCompositionInit();
        bindEntryWhatInputAutosizeOnce();
        autosizeEntryWhatInput();
        bindEntryCommentExpandOnce();

        const openGen = revealEntryModalShell();
        if (!openGen) return;
        const isStaleOpen = () => (window.__entryModalOpenGeneration || 0) !== openGen;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (isStaleOpen()) return;
                autosizeEntryWhatInput();
                captureEntrySheetBaseHeight();
            });
        });

        const completeEntryModalOpen = async () => {
            if (isStaleOpen()) return;

            if (entryId && !savedRecord) {
                savedRecord = await fetchMealRecordForEdit(entryId);
                if (isStaleOpen()) return;
            }

            if (savedRecord) {
                const modeFromRec = inferEntryFormModeFromRecord(savedRecord, slot);
                if (modeFromRec !== appState.entryFormMode) {
                    appState.entryFormMode = modeFromRec;
                    applyEntryFormModeToModalUI(modeFromRec);
                    finalizeEntryModalQuickInput();
                }
            }
            const isSnack = appState.entryFormMode === 'snack';

            renderEntryChips();
            applyEntryModalSaveButtonState(entryId, savedRecord);

            if (entryId && savedRecord) {
                populateSavedRecordIntoForm(savedRecord, isSnack, state);
                activateSavedRecordTags(savedRecord, isSnack);
            } else {
                window.setRating(null);
                window.setSatiety(null);
            }

            if (entryId && window.currentUser && !window.currentUser.isAnonymous && !isDemoUser(window.currentUser)) {
                document.getElementById('btnDelete')?.classList.remove('hidden');
            }

            if (isSnack && !(entryId && savedRecord)) {
                const subTags = window.userSettings.subTags.snack || [];
                const snackType = document.querySelector('#entryWhatChips button.active')?.innerText;
                window.renderSecondary('entryWhatSuggestions', subTags, 'entryWhatInput', snackType || null, 'snack');
            } else if (!isSnack && !(entryId && savedRecord)) {
                syncDeliveryVendorSectionVisibility();
            }

            finalizeEntryModalDetailRecord(entryId && savedRecord ? savedRecord : null);
            finalizeEntryModalGauges();
            finalizeEntryMealClock(entryId && savedRecord ? savedRecord : null, isSnack);
            seedEntryMealClockOnModalOpenAfterFinalize(entryId, isSnack);

            requestAnimationFrame(() => {
                if (isStaleOpen()) return;
                try {
                    window.setRating?.(appState.currentRating);
                    window.setSatiety?.(appState.currentSatiety);
                    applyEntryGaugeDialUi();
                } catch (_) {}
                autosizeEntryWhatInput();
                // 칩·폼 반영 후 재측정(무엇을 태그·메모 3줄 가정)
                captureEntrySheetBaseHeight({ force: true });
            });
        };

        requestAnimationFrame(() => {
            void completeEntryModalOpen();
        });
    } catch (error) {
        console.error('openModal 오류:', error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

export function closeModal() {
    if (document.getElementById('entryModal')?.classList.contains('entry-modal-saving')) return;
    closeTimeSourceSheets();
    closeEntrySlotPicker();
    closeEntryHeaderDatePicker();
    const entryModal = document.getElementById('entryModal');
    if (entryModal) {
        setEntryModalSavingState(false);
        entryModal.classList.remove('keyboard-open');
        placeEntryModalChrome(false);
        clearOverlayImePinStyles(entryModal);
        entryModal.style.height = '';
        entryModal.style.top = '';
        entryModal.style.left = '';
        entryModal.style.width = '';
        entryModal.style.right = '';
        entryModal.style.bottom = '';
        if (typeof entryModal.resetGrabberPullTransform === 'function') {
            entryModal.resetGrabberPullTransform();
        }
        entryModal.classList.add('hidden');
        unlockBodyScroll('entryModal');
    }
    syncEntryModalBodyClass();
    // 모달을 닫을 때 로딩 오버레이도 숨김
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
    }
    // 상태 초기화
    const state = appState;
    if (state) {
        state.currentEditingId = null;
        state.currentPhotos = [];
        state.recordPhotoHeroIndex = 0;
        state.currentPhotoMeta = [];
        state.entryMealClockSourceMain = null;
        state.entryMealClockSourceSnack = null;
        state.sharedPhotos = [];
        state.originalSharedPhotos = [];
        state.originalPhotoAspectRatio = '1:1';
        state.wantsToShare = false;
    }
}

/** Firestore/Storage 저장 실패·타임아웃 시 mealHistory·플래그에 실패 표시(스피너 → 느낌표) */
function applyTimelineMealSaveFailureState(record, optimisticTempId, optimisticSlotKey) {
    if (optimisticTempId) clearMealOptimisticSavePending(optimisticTempId);
    let mi = -1;
    try {
        const idPrimary =
            record?.id != null && record.id !== ''
                ? String(record.id)
                : optimisticTempId != null
                  ? String(optimisticTempId)
                  : '';
        if (idPrimary && window.mealHistory && Array.isArray(window.mealHistory)) {
            mi = window.mealHistory.findIndex((m) => m && String(m.id) === idPrimary);
        }
        if (mi < 0 && optimisticTempId && window.mealHistory && Array.isArray(window.mealHistory)) {
            mi = window.mealHistory.findIndex((m) => m && String(m.id) === String(optimisticTempId));
        }
        /* 리스너·중복 제거 등으로 낙관 행이 사라진 경우에도 실패 표시를 붙일 수 있게 복구 */
        if (mi < 0 && optimisticTempId && record && window.mealHistory && Array.isArray(window.mealHistory)) {
            const fallback = {
                ...record,
                id: record.id || optimisticTempId,
                _localSaveFailed: true,
                is_sync_error: true
            };
            window.mealHistory.push(fallback);
            window.mealHistory.sort(
                (a, b) =>
                    (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || '')
            );
            mi = window.mealHistory.findIndex((m) => m && String(m.id) === String(optimisticTempId));
        }
        if (mi >= 0) {
            window.mealHistory[mi] = {
                ...window.mealHistory[mi],
                _localSaveFailed: true,
                is_sync_error: true
            };
        }
        if (idPrimary) markMealEntrySaveFailedById(idPrimary);
        if (optimisticTempId) markMealEntrySaveFailedById(optimisticTempId);
        if (record?.id != null && record.id !== '') markMealEntrySaveFailedById(String(record.id));
        getMealSyncManager().clearPendingPhotoFor(record?.id || null, optimisticTempId || null, optimisticSlotKey);
        if (idPrimary) clearMealEntrySaveInFlight(idPrimary);
        if (optimisticTempId) clearMealEntrySaveInFlight(String(optimisticTempId));
        if (record?.id) clearMealEntrySaveInFlight(String(record.id));
    } catch (_) {
        /* ignore */
    }
    let dateToInvalidate = record?.date;
    if (typeof dateToInvalidate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateToInvalidate)) {
        if (mi >= 0 && window.mealHistory?.[mi]?.date) {
            dateToInvalidate = window.mealHistory[mi].date;
        } else if (optimisticTempId && Array.isArray(window.mealHistory)) {
            const row = window.mealHistory.find((m) => m && String(m.id) === String(optimisticTempId));
            if (row?.date) dateToInvalidate = row.date;
        }
    }
    if (mi >= 0 && window.mealHistory?.[mi]?.date) {
        const dRow = String(window.mealHistory[mi].date);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dRow)) {
            invalidateTimelineDateSection(dRow);
            return;
        }
    }
    if (typeof dateToInvalidate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateToInvalidate)) {
        invalidateTimelineDateSection(dateToInvalidate);
    }
}

function refreshTimelineAfterMealSaveResult(dateStr) {
    try {
        if (appState.currentTab === 'timeline') {
            if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                renderTimelineDateSections([dateStr]);
            } else {
                renderTimeline();
            }
        } else {
            updateTimelineMealEntryPendingIndicators();
        }
    } catch (_) {
        /* ignore */
    }
}

/** Firestore 저장 실패 후: 실패 플래그 반영 + 해당 날짜로 스크롤 고정(전날로 밀리거나 느낌표 DOM이 안 맞는 현상 완화) */
async function focusTimelineAfterMealSaveFailure(record, editingDateStr, optimisticTempId, optimisticSlotKey) {
    window._timelineRerenderFreezeUntil = Date.now() + 2000;
    applyTimelineMealSaveFailureState(record, optimisticTempId, optimisticSlotKey);
    const focusIso =
        record && typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.date)
            ? record.date
            : typeof editingDateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(editingDateStr)
              ? editingDateStr
              : '';
    if (appState.currentTab === 'timeline' && focusIso && typeof window.jumpToDate === 'function') {
        // 실패 시에도 무한/연쇄 스크롤을 막기 위해 1회만 앵커링
        const key =
            record && record.id
                ? `save-fail:${String(record.id)}`
                : optimisticTempId
                  ? `save-fail-temp:${String(optimisticTempId)}`
                  : `save-fail-date:${String(focusIso)}`;
        await window.jumpToDate(focusIso, { scroll: true, behavior: 'smooth', onceKey: key, anchorAfterRenderMs: 1400 });
        updateTimelineShareIndicators();
        updateTimelineMealEntryPendingIndicators();
    } else {
        refreshTimelineAfterMealSaveResult(record?.date || focusIso || undefined);
    }
}

export async function saveEntry() {
    // 로딩 오버레이 참조를 함수 시작 부분에서 가져옴
    const loadingOverlay = document.getElementById('loadingOverlay');
    const entryModal = document.getElementById('entryModal');
    /** openModal이 열릴 때마다 증가. 저장 비동기 완료 시점에 사용자가 새 모달을 열었는지 구분 */
    let saveStartedUnderModalGen = null;

    if (entryModal?.classList.contains('entry-modal-saving')) return;

    // 모바일 IME(한글 등) 조합 중인 텍스트가 input.value에 반영되도록 blur 후 대기
    // 스페이스/선택 전에 '기록 완료'를 누르면 조합 중인 글자가 누락되는 문제 방지
    const active = document.activeElement;
    if (active && entryModal?.contains(active) && (active.matches('input, textarea') || active.isContentEditable)) {
        active.blur();
        await new Promise(r => setTimeout(r, 80));
    }
    
    try {
        const state = appState;
        
        // 게스트 모드에서는 저장 불가
        if (window.currentUser && window.currentUser.isAnonymous) {
            showToast("게스트 모드에서는 기록할 수 없습니다. 로그인 후 이용해주세요.", "error");
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        if (window.currentUser && isDemoUser(window.currentUser)) {
            showToast('샘플 계정에서는 기록을 저장할 수 없습니다. 로그인 후 이용해 주세요.', 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        
        // 필수 상태 확인
        if (!state.currentEditingSlotId || !state.currentEditingDate) {
            console.error('저장 실패: 필수 정보가 없습니다.', { 
                slotId: state.currentEditingSlotId, 
                date: state.currentEditingDate 
            });
            showToast("저장할 정보가 없습니다.", 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        
        const slot = SLOTS.find(s => s.id === state.currentEditingSlotId);
        if (!slot) {
            console.error('저장 실패: 슬롯을 찾을 수 없습니다.', state.currentEditingSlotId);
            showToast("저장할 정보가 없습니다.", 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        const entryMode = appState.entryFormMode === 'snack' ? 'snack' : 'meal';
        const isS = entryMode === 'snack';
        mergeActiveSubChipsIntoInputs();
        const form = readEntryFormFromDom(entryMode);
        const resolved = resolveEntrySaveFields(form, {
            selectedSnackPlaceMainTag: appState.selectedSnackPlaceMainTag,
        });
        const { isSkip: isSk } = resolved;

        const rateOn = isS
            ? appState.entryGaugeRatingOnSnack === true
            : appState.entryGaugeRatingOnMain === true;
        const satOn = isS
            ? appState.entryGaugeSatietyOnSnack === true
            : appState.entryGaugeSatietyOnMain === true;
        const timeOn = !isSk && (isS ? appState.entryTimeOnSnack === true : appState.entryTimeOnMain === true);
        const normalizedClock = timeOn ? getMealClock24FromModal(!isS) : '';

        if (
            !validateEntryForm(form, {
                isSkip: isSk,
                photos: state.currentPhotos,
                ratingOn: !isSk && rateOn,
                satietyOn: !isSk && satOn,
                timeOn,
                mealClock24: normalizedClock,
                selectedSnackPlaceMainTag: appState.selectedSnackPlaceMainTag,
            })
        ) {
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            showToast('기록할 내용을 하나 이상 입력해주세요.', 'error');
            return;
        }
        
        // 이번 입력을 다음 기록 시트의 서브칩 후보로 기억 (변경이 있을 때만 저장)
        const { settings: nextSettings, changed: tagsChanged } = buildSettingsWithRememberedSubTags(
            window.userSettings,
            form,
            resolved,
            entryMode
        );
        if (tagsChanged) {
            window.userSettings = nextSettings;
            scheduleEntrySettingsSave();
        }

        const { record, sourcePhotos, sourcePhotoMeta, existingPhotoUrls } = buildEntrySaveRecord({
            state,
            form,
            resolved,
            entryMode,
            gauges: { rateOn, satOn, timeOn, normalizedClock },
            mealHistory: window.mealHistory,
        });

        // 공유 비교 기준은 모달이 닫히기 전에 스냅샷으로 고정 (closeModal이 originalSharedPhotos를 비움)
        const shareSnapshot = buildEntryShareSnapshot({
            state,
            record,
            existingPhotoUrls,
            mealHistory: window.mealHistory,
        });
        const { isShareBanned, wantsToShare, originalShareList, hadSharedPhotos, photoAspectChanged } = shareSnapshot;
        // 사진 업로드 단계에서 Storage URL로 교체되므로 let
        let photosToShare = shareSnapshot.photosToShare;

        console.log('저장 시작:', record);

        // 진행 상태: 모달은 열린 채 저장 UI + 타임라인 슬롯 인라인 스피너
        saveStartedUnderModalGen =
            typeof window.__entryModalOpenGeneration === 'number' ? window.__entryModalOpenGeneration : 0;
        setEntryModalSavingState(true);

        // 현재 탭과 편집 날짜를 미리 저장 (상태 초기화 전에)
        const currentTab = state.currentTab;
        const editingDate = state.currentEditingDate;
        
        // 서버 저장 전 UI를 먼저 갱신하기 위한 낙관 반영
        const wasNewRecord = !record.id;
        // 신규 기록: 문서 ID 클라이언트 선발급 — 오프라인에서도 ID가 확정되어
        // 낙관 레코드·삭제·재시도(setDoc 멱등)가 같은 ID로 동작 (temp ID는 발급 실패 시 폴백)
        if (wasNewRecord) {
            record.id = generateMealDocId(window.currentUser?.uid) || null;
        }
        const optimisticTempId =
            wasNewRecord && !record.id ? `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
        const optimisticSlotKey = `${record.date || ''}__${record.slotId || ''}`;
        const hasPendingBase64Photos = sourcePhotos.some(isLocalPendingPhoto);
        if (hasPendingBase64Photos) {
            getMealSyncManager().setPendingPhotoEntry(record.id || optimisticTempId || null, optimisticSlotKey, true);
        }
        const optimisticRecord = {
            ...record,
            id: record.id || optimisticTempId,
            photos: [...sourcePhotos],
            photoMeta: sourcePhotoMeta.map((e) => ({ takenAt: e?.takenAt ?? null }))
        };
        /**
         * ── 불변식 (docs/sync-outbox-design.md §1) ─────────────────────────────────
         * 사용자가 저장을 누른 기록은, **어떤 fallible 한 단계도 시작하기 전에** 이미
         * 내구 저장돼 있다. 이 enqueue 가 그 지점이다 — 낙관 반영·모달 닫힘·성공 팝업·
         * dbOps.save 그 무엇보다 먼저다.
         *
         * 여기서 실패하면 저장했다고 말하면 안 된다(§4.2). 모달을 열어 둔 채 실패를
         * 알려, 사용자가 입력을 잃지 않게 한다. 「저장했다고 말했는데 안 됐다」가 이
         * 서브시스템의 원죄다.
         */
        if (record.id && !String(record.id).startsWith('temp_')) {
            const durable = await persistMealToOutbox(record, sourcePhotos, sourcePhotoMeta);
            if (!durable) {
                diag('save.durability.fail', { id: String(record.id) });
                setEntryModalSavingState(false);
                showToast(
                    '기기에 저장하지 못했습니다. 저장 공간을 확보한 뒤 다시 시도해 주세요.',
                    'error'
                );
                return; // 모달을 닫지 않는다 — 입력이 남아 있어야 한다
            }
        }

        if (optimisticTempId) markMealOptimisticSavePending(optimisticTempId);
        if (record.id) {
            clearMealEntryServerSynced(record.id);
            markMealEntrySaveInFlight(record.id);
        }
        const applyOptimisticMealRecord = () => {
            if (!window.mealHistory || !Array.isArray(window.mealHistory) || !optimisticRecord.id) return;
            const byId = window.mealHistory.findIndex(m => m.id === optimisticRecord.id);
            if (byId >= 0) {
                window.mealHistory[byId] = optimisticRecord;
            } else {
                window.mealHistory.push(optimisticRecord);
            }
            window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
        };
        applyOptimisticMealRecord();
        invalidateMealHistoryCountCache();
        // 공유 아이콘도 서버 반영 전에 즉시 낙관 반영
        if (optimisticRecord.id && !isShareBanned) {
            if (wantsToShare) {
                const optimisticShared = (sourcePhotos.length > 0 ? sourcePhotos : ['']).map(url => ({
                    entryId: optimisticRecord.id,
                    photoUrl: url || '',
                    userId: window.currentUser?.uid
                }));
                setSharedPhotos(getSharedPhotos().filter(p => p.entryId !== optimisticRecord.id).concat(optimisticShared));
            } else {
                setSharedPhotos(getSharedPhotos().filter(p => p.entryId !== optimisticRecord.id));
            }
            updateTimelineShareIndicators();
        }
        // 리스너 재렌더가 즉시 덮어쓰지 않도록 짧게 프리즈
        window._timelineRerenderFreezeUntil = Date.now() + 1200;
        if (currentTab === 'timeline' && editingDate) {
            try {
                // 저장 직후 낙관 반영 단계에서는 "스크롤은 하지 않고" 해당 날짜를 로드/선택만 맞춘다.
                // (스크롤은 아래 서버 저장 완료 후 1회만 중앙 정렬)
                if (window.jumpToDate) await window.jumpToDate(editingDate, { scroll: false, onceKey: `save-optimistic:${String(editingDate)}` });
                updateTimelineShareIndicators();
                invalidateTimelineDateSection(editingDate);
                renderTimelineDateSections([editingDate]);
            } catch (e) {
                console.warn('저장 직후 타임라인 낙관 반영 실패:', e);
            }
        } else if (currentTab === 'gallery') {
            try {
                renderGallery();
                const feedContent = document.getElementById('feedContent');
                if (feedContent) renderFeed();
            } catch (e) {
                console.warn('저장 직후 갤러리 낙관 반영 실패:', e);
            }
        } else if (currentTab === 'feed') {
            try {
                const feedContent = document.getElementById('feedContent');
                if (feedContent) renderFeed();
            } catch (e) {
                console.warn('저장 직후 피드 낙관 반영 실패:', e);
            }
        }
        
        // 로컬 낙관 반영 완료 → 시트는 즉시 닫는다 (오프라인 우선: 서버 동기화는 백그라운드 진행,
        // 진행 상태는 타임라인 도트·칩으로 표시). 서버 실패 시에도 입력 내용은 로컬에 남는다.
        finishEntryModalAfterSuccessfulSave(saveStartedUnderModalGen);
        if (wasNewRecord) {
            showSuccessPopup(resolveRecordCompletePopupMessage(wasNewRecord, record.date), 800);
        }
        // 저장 실행 (백그라운드, 타임라인에 인라인 스피너 표시)
        // 새 레코드인 경우 ID를 먼저 확보해야 공유 시 entryId를 올바르게 설정할 수 있음
        const SAVE_FIRESTORE_TIMEOUT_MS = 10000;
        /** 사진 N장 Storage + 재저장 상한 — grace 칩 전환(30초)과 동일 티밍 요청에 맞춤 */
        const MEAL_PHOTO_UPLOAD_PHASE_TIMEOUT_MS = 30000;
        /** 사진 Storage 업로드 실패·타임아웃 시에도 아래 '저장 완료' 병합이 성공으로 덮어쓰지 않도록 */
        let photoUploadPhaseFailed = false;
        try {
            const saveResult = unwrapMealSaveResult(
                await saveWithTimeout(() => dbOps.save(record, true, { isNewRecord: wasNewRecord }), {
                    timeoutMs: SAVE_FIRESTORE_TIMEOUT_MS,
                    onTimeout: () => {
                        const mid = record.id || optimisticTempId;
                        /**
                         * 계측(0단계) — 이 한 줄이 진단 A 를 판정한다.
                         *
                         * phase 가 'preflight' 에서 멈춰 있으면 토큰·App Check 왕복에 매달린 채
                         * 타임아웃이 터졌다는 뜻이고, 그러면 setDoc 이 호출되지 않아 **Firestore
                         * 로컬 큐에 아무것도 없다** — 앱이 죽는 순간 기록이 사라진다.
                         * 'setdoc-called' 이후면 큐에는 들어갔으므로 유실은 아니다.
                         */
                        const phase = getSavePhase(record.id ? String(record.id) : '(new)');
                        diag('save.timeout', {
                            id: mid ? String(mid) : null,
                            phase,
                            reachedSetDoc: phase === 'setdoc-called' || phase === 'setdoc-resolved',
                            hasPhotos: hasPendingBase64Photos,
                            isNew: wasNewRecord
                        });
                        if (!mid) return;
                        if (String(mid).startsWith('temp_')) {
                            // ID 선발급 실패 폴백(temp): 아웃박스 추적이 불가하므로 기존대로 실패 처리
                            getMealSyncManager().onSaveUiTimedOut(String(mid), optimisticTempId);
                        }
                        /**
                         * 그 외에는 아무것도 하지 않는다. 이 기록은 이미 아웃박스에 있고,
                         * 표시는 아웃박스 하나만 본다 — 타임아웃은 「아직 안 올라감」을 바꾸지
                         * 않으므로 따로 승격시킬 상태가 없다. 워커가 계속 밀어 올린다.
                         */
                    }
                })
            );
            const savedId = saveResult.mealId;
            const savedViaCallableFallback = saveResult.savedViaCallableFallback;
            if (optimisticTempId) clearMealEntrySaveFailedById(optimisticTempId);
            if (savedId) clearMealEntrySaveFailedById(savedId);
            // 새 레코드인 경우 생성된 ID를 record에 설정
            if (!record.id && savedId) {
                record.id = savedId;
                console.log('새 레코드 ID 확보:', savedId);
            }
            // 신규 등록 시 임시 ID를 실제 ID로 치환 (이후 URL 반영 merge가 정상 동작하도록)
            if (wasNewRecord && optimisticTempId && savedId && window.mealHistory && Array.isArray(window.mealHistory)) {
                const tempIdx = window.mealHistory.findIndex(m => m.id === optimisticTempId);
                if (tempIdx >= 0) {
                    const next = { ...window.mealHistory[tempIdx], id: savedId };
                    delete next._localSaveFailed;
                    window.mealHistory[tempIdx] = next;
                }
            }
            const effectiveMealId = savedId || (record && record.id);
            /* Firestore 직접 쓰기: 초록은 리스너 ack + waitForPendingWrites. Callable 폴백만 성공 시 로컬 큐가 없어 즉시 ack. */
            if (optimisticTempId) clearMealOptimisticSavePending(optimisticTempId);
            if (savedViaCallableFallback && effectiveMealId) {
                onMealDocFirestoreServerAcknowledged(String(effectiveMealId), optimisticTempId);
            } else if (effectiveMealId) {
                clearMealEntryServerSynced(String(effectiveMealId));
                markMealEntrySaveInFlight(String(effectiveMealId));
            }
            /* base64 업로드 후 재저장이 있으면 그때만 대기(1차만 기다리면 2차 쓰기와 순서가 어긋날 수 있음) */
            if (!savedViaCallableFallback && !hasPendingBase64Photos) {
                scheduleMealServerAckAfterPendingWrites(
                    effectiveMealId,
                    optimisticTempId,
                    record.date,
                    currentTab,
                    MEAL_SYNC_GRACE_MS_NO_PHOTO
                );
            }
            if (hasPendingBase64Photos && wasNewRecord && optimisticTempId && savedId) {
                getMealSyncManager().movePendingPhotoTempToReal(optimisticTempId, savedId);
            }
            if (wasNewRecord && optimisticTempId && savedId) {
                setSharedPhotos(getSharedPhotos().map(p => (
                    p.entryId === optimisticTempId ? { ...p, entryId: savedId } : p
                )));
                updateTimelineShareIndicators();
            }

            const base64Photos = sourcePhotos.filter(isLocalPendingPhoto);
            // 추가 업로드 없음 — 클라이언트 Firestore 쓰기까지 끝나면 스피너 해제(오프라인 큐 동기화는 백그라운드)
            if (base64Photos.length === 0) {
                markMealEntryServerWorkComplete(record?.id, optimisticTempId, optimisticSlotKey);
            }
            // 이미 그려진 날짜 섹션은 renderTimeline이 건너뛰어 temp_*·스피너 DOM이 남을 수 있음 → 해당 날짜만 무효화 후 재구성
            if (record.date) invalidateTimelineDateSection(record.date);
            if (currentTab === 'timeline') {
                try {
                    if (record.date) renderTimelineDateSections([record.date]);
                } catch (e) {
                    console.warn('저장 직후 타임라인 갱신:', e);
                }
            }
            // 새로 추가한 base64 사진은 문서 ID 확보 후 Storage 업로드 -> URL로 record.photos 치환
            // 오프라인 등으로 업로드·재저장이 끝없이 대기하면 스피너가 영구 유지되므로 1차 저장과 동일한 상한(ms)으로 감싼다.
            if (base64Photos.length > 0 && record.id && window.currentUser?.uid) {
                let photoPhaseSavedViaCallable = false;
                try {
                    const photoPhase = await saveWithTimeout(
                        () =>
                            uploadEntryPhotosAndResave({
                                record,
                                base64Photos,
                                sourcePhotos,
                                sourcePhotoMeta,
                                existingPhotoUrls,
                                isShareBanned,
                                wantsToShare,
                                photosToShare,
                                optimisticTempId,
                                uid: window.currentUser.uid,
                            }),
                        {
                            timeoutMs: MEAL_PHOTO_UPLOAD_PHASE_TIMEOUT_MS,
                            onTimeout: () => {
                                if (record?.id) getMealSyncManager().onSaveUiTimedOut(String(record.id), optimisticTempId);
                            }
                        }
                    );
                    photoUploadPhaseFailed = photoPhase.photoUploadPhaseFailed;
                    photoPhaseSavedViaCallable = photoPhase.photoPhaseSavedViaCallable;
                    photosToShare = photoPhase.photosToShare;
                    if (record.date) invalidateTimelineDateSection(record.date);
                    /* 업로드 실패 시에도 내부 catch가 throw하지 않아 여기까지 옴 — 성공 시에만 대기 해제·ack 스케줄 */
                    if (!photoUploadPhaseFailed) {
                        markMealEntryServerWorkComplete(record?.id, optimisticTempId, optimisticSlotKey);
                        if (record?.id && !photoPhaseSavedViaCallable) {
                            scheduleMealServerAckAfterPendingWrites(
                                record.id,
                                optimisticTempId,
                                record.date,
                                currentTab,
                                MEAL_SYNC_GRACE_MS_WITH_PHOTO
                            );
                        }
                    }
                    refreshTimelineAfterMealSaveResult(record?.date || editingDate || undefined);
                } catch (uploadPhaseError) {
                    photoUploadPhaseFailed = true;
                    if (record?.id) markMealEntrySaveFailedById(String(record.id));
                    console.error('사진 업로드/재저장 단계 오류:', uploadPhaseError);
                    markMealEntryServerWorkComplete(record?.id, optimisticTempId, optimisticSlotKey);
                    if (uploadPhaseError?.__mealogSaveTimeout) {
                        try {
                            showToast(getUserFacingErrorMessage(uploadPhaseError, 'save'), 'error');
                        } catch (_) {
                            /* ignore */
                        }
                    }
                    const preserveP = sourcePhotos.filter((p) => typeof p === 'string' && p);
                    if (preserveP.length && record?.id && window.mealHistory) {
                        const hi = window.mealHistory.findIndex((m) => m && m.id === record.id);
                        if (hi >= 0) {
                            record.photos = [...preserveP];
                            window.mealHistory[hi] = {
                                ...window.mealHistory[hi],
                                photos: [...preserveP],
                                _localSaveFailed: true
                            };
                        }
                    }
                    await focusTimelineAfterMealSaveFailure(record, editingDate, optimisticTempId, optimisticSlotKey);
                    return;
                }
            } else if (hasPendingBase64Photos && record?.id) {
                // 업로드 분기 미진입(예: uid 미준비) — 1차만 저장되고 사진은 서버에 없음 → 재시도 가능하도록 실패 표시
                photoUploadPhaseFailed = true;
                markMealEntrySaveFailedById(String(record.id));
                if (record.date) invalidateTimelineDateSection(record.date);
                markMealEntryServerWorkComplete(record.id, optimisticTempId, optimisticSlotKey);
                if (currentTab === 'timeline') {
                    try {
                        if (record.date) renderTimelineDateSections([record.date]);
                    } catch (_) {
                        /* ignore */
                    }
                }
            }

            /* 업로드 분기는 성공했으나 https URL 개수가 부족하면(이상 케이스) 실패로 취급 — 완료 팝업·초록 도트 오인 방지 */
            if (base64Photos.length > 0 && record.id && !photoUploadPhaseFailed) {
                const httpsN = (Array.isArray(record.photos) ? record.photos : []).filter(
                    (p) => typeof p === 'string' && /^https?:\/\//.test(p)
                ).length;
                if (httpsN < base64Photos.length) {
                    photoUploadPhaseFailed = true;
                    markMealEntrySaveFailedById(String(record.id));
                    const preserve = sourcePhotos.filter((p) => typeof p === 'string' && p);
                    record.photos = preserve.length ? preserve : existingPhotoUrls;
                    photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
                        ? [...existingPhotoUrls]
                        : [];
                    if (window.mealHistory) {
                        const hi = window.mealHistory.findIndex((m) => m && m.id === record.id);
                        if (hi >= 0) {
                            window.mealHistory[hi] = {
                                ...window.mealHistory[hi],
                                photos: [...record.photos],
                                _localSaveFailed: true,
                                is_sync_error: true
                            };
                        }
                    }
                }
            }

            console.log('저장 완료');
            // 모달은 낙관 반영 직후 이미 닫힘 — 여기서는 서버 결과 병합만
            // 낙관적 반영: 리스너 도착 전에 mealHistory에 즉시 반영해 스크롤·렌더가 최신 데이터 기준으로 동작
            if (record.id && window.mealHistory && Array.isArray(window.mealHistory)) {
                const idx = window.mealHistory.findIndex(m => m.id === record.id);
                const prevShared = idx >= 0 ? window.mealHistory[idx].sharedPhotos : undefined;
                const merged = { ...record };
                delete merged.sharedPhotos;
                if (prevShared !== undefined) merged.sharedPhotos = prevShared;
                if (photoUploadPhaseFailed) {
                    merged._localSaveFailed = true;
                    merged.is_sync_error = true;
                    markMealEntrySaveFailedById(String(record.id));
                } else {
                    delete merged._localSaveFailed;
                    delete merged.is_sync_error;
                }
                if (idx >= 0) {
                    window.mealHistory[idx] = merged;
                } else {
                    window.mealHistory.push(merged);
                }
                window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
            }
            // 기록 완료 팝업은 낙관 반영 직후(모달 닫을 때) 이미 표시함
            // 저장 직후 잠깐 타임라인 전체 재렌더를 막아, jumpToDate·스크롤이 리스너 재렌더에 덮이지 않게 함
            window._timelineRerenderFreezeUntil = Date.now() + 800;
            
            /** 모먼트 동기화 실패 시 공유 성공 토스트를 막기 위함 */
            const { shareSyncFailed } = await syncMomentShareAfterSave({
                record,
                photosToShare,
                originalShareList,
                hadSharedPhotos,
                photoAspectChanged,
            });

            if (!wasNewRecord) {
                const finalShare = !!(photosToShare && photosToShare.length > 0);
                const shareStateChanged =
                    (!hadSharedPhotos && finalShare) || (hadSharedPhotos && !finalShare);
                if (shareSyncFailed) {
                    /* 공유 동기화 오류 토스트만 (위에서 이미 표시). 저장 성공 토스트는 중복 방지 */
                } else if (shareStateChanged) {
                    if (!hadSharedPhotos && finalShare) {
                        showToast('기록을 공유했습니다.', 'success');
                    } else {
                        showToast('공유를 취소했습니다.', 'success');
                    }
                } else {
                    showToast('수정했습니다.', 'success');
                }
            }
        } catch (saveError) {
            const timedOutId = record.id ? String(record.id) : null;
            if (saveError?.__mealogSaveTimeout && timedOutId && !timedOutId.startsWith('temp_')) {
                // 타임아웃 = 대부분 오프라인 큐 대기. onTimeout에서 이미 '등록 예정' 칩으로 승격됨.
                // 실패로 표시하지 않고 큐 flush(재연결·재기동)를 기다린다.
                console.warn('dbOps.save 타임아웃 — Firestore 로컬 큐 대기(등록 예정):', timedOutId);
                // base64 사진이 남아 있으면 사진 대기 플래그 유지 (재시도 시 Storage 업로드 필요)
                if (!hasPendingBase64Photos) {
                    markMealEntryServerWorkComplete(timedOutId, optimisticTempId, optimisticSlotKey);
                }
                try {
                    showToast('연결되면 서버에 자동 등록돼요. 등록 예정으로 표시됩니다.', 'info');
                } catch (_) {
                    /* ignore */
                }
                void import('../main/meal-sync-resend-header.js').then((h) => {
                    try {
                        if (typeof h.refreshMealSyncResendNavButton === 'function') h.refreshMealSyncResendNavButton();
                    } catch (_) {
                        /* ignore */
                    }
                });
                try {
                    if (record.date) {
                        invalidateTimelineDateSection(record.date);
                        if (appState.currentTab === 'timeline') renderTimelineDateSections([record.date]);
                    }
                    updateTimelineMealEntryPendingIndicators();
                } catch (_) {
                    /* ignore */
                }
                return;
            }
            console.error('dbOps.save 오류:', saveError);
            try {
                showToast(getUserFacingErrorMessage(saveError, 'save'), 'error');
            } catch (_) {
                /* ignore */
            }
            try {
                await focusTimelineAfterMealSaveFailure(record, editingDate, optimisticTempId, optimisticSlotKey);
            } catch (_) {
                /* ignore */
            }
            return;
        }
        
        // 서버 저장 완료 후 Firestore 리스너가 떨어져 onDataUpdate가 재렌더·스크롤을 유발하지 않도록 프리즈 연장
        window._timelineRerenderFreezeUntil = Math.max(window._timelineRerenderFreezeUntil || 0, Date.now() + 3500);
        
        // 탭에 따라 적절한 뷰 업데이트 (setTimeout 0으로 지연 없이 다음 틱에서 실행)
        setTimeout(() => {
            const tabNow = appState.currentTab;
            if (tabNow === 'timeline' && editingDate) {
                // 낙관 반영 후에도 서버 병합으로 DOM 높이가 바뀌면 scrollY 복원만으로는 전날이 보일 수 있음 → 해당 날짜로 앵커
                void (async () => {
                    try {
                        if (typeof window.jumpToDate === 'function' && /^\d{4}-\d{2}-\d{2}$/.test(String(editingDate))) {
                            // 저장 플로우에서는 "해당 날짜 중앙 정렬"을 1회만 수행
                            const key = record && record.id ? `save-final:${String(record.id)}` : `save-final:${String(editingDate)}`;
                            await window.jumpToDate(String(editingDate), { scroll: true, behavior: 'smooth', onceKey: key, anchorAfterRenderMs: 1400 });
                        } else if (editingDate) {
                            invalidateTimelineDateSection(String(editingDate));
                            renderTimelineDateSections([String(editingDate)]);
                            renderMiniCalendar();
                        } else {
                            renderTimeline();
                            renderMiniCalendar();
                        }
                        updateTimelineShareIndicators();
                        updateTimelineMealEntryPendingIndicators();
                    } catch (e) {
                        console.warn('저장 후 타임라인 ID 동기화 실패:', e);
                    }
                })();
            } else if (tabNow === 'gallery') {
                // 갤러리 탭: 낙관 반영을 즉시 보여주고, 리스너 동기화를 위해 한 번 더 갱신
                const renderGalleryNow = () => {
                    try {
                        renderGallery();
                        const feedContent = document.getElementById('feedContent');
                        if (feedContent) renderFeed();
                    } catch (e) {
                        console.error('갤러리/피드 렌더링 오류:', e);
                    }
                };
                renderGalleryNow();
                setTimeout(() => {
                    if (appState.currentTab !== 'gallery') return; // 대기 중 탭 바뀌면 스킵
                    renderGalleryNow();
                }, 500);
            } else if (tabNow === 'dashboard') {
                // 분석 탭: 리스너가 타임라인/갤러리만 갱신하므로 여기서 추가 작업 없음. 탭 전환 시 최신 데이터 반영됨.
            } else if (tabNow === 'feed') {
                const feedContent = document.getElementById('feedContent');
                if (feedContent) {
                    try { renderFeed(); } catch (e) { console.error('피드 렌더링 오류:', e); }
                }
            } else {
                // 기타: 보이는 뷰만 갱신 (피드/갤러리 노출 시)
                const feedContent = document.getElementById('feedContent');
                if (feedContent) {
                    try { renderFeed(); } catch (e) { console.error('피드 렌더링 오류:', e); }
                }
                const galleryView = document.getElementById('galleryView');
                if (galleryView && !galleryView.classList.contains('hidden')) {
                    try { renderGallery(); } catch (e) { console.error('갤러리 렌더링 오류:', e); }
                }
            }
        }, 0);
    } catch (e) {
        console.error('saveEntry 오류:', e);
        console.error('오류 스택:', e.stack);
        showToast(getUserFacingErrorMessage(e, 'save'), 'error');
        // 오류 발생 시에도 로딩 오버레이 숨김
        if (loadingOverlay) {
            loadingOverlay.classList.add('hidden');
            console.log('오류 발생 후 로딩 오버레이 숨김');
        }
        setEntryModalSavingState(false);
    } finally {
        if (loadingOverlay && !loadingOverlay.classList.contains('hidden')) {
            loadingOverlay.classList.add('hidden');
        }
    }
}

function rerenderAfterMealDelete(mealDate) {
    window._timelineRerenderFreezeUntil = Date.now() + 2000;
    void (async () => {
        try {
            if (appState.currentTab === 'timeline' && mealDate && typeof window.jumpToDate === 'function') {
                // 삭제 직후 리스너/재렌더가 연속으로 들어와도 스크롤은 1회만
                await window.jumpToDate(mealDate, { scroll: true, behavior: 'smooth', onceKey: `delete:${String(mealDate)}`, anchorAfterRenderMs: 1400 });
            } else if (mealDate) {
                invalidateTimelineDateSection(mealDate);
                renderTimelineDateSections([mealDate]);
                renderMiniCalendar();
            } else {
                renderTimeline();
                renderMiniCalendar();
            }
            updateTimelineShareIndicators();
            if (appState.currentTab === 'gallery') renderGallery();
            if (document.getElementById('feedContent')) renderFeed();
        } catch (e) {
            console.warn('삭제 후 렌더:', e);
        }
        try {
            if (appState.currentTab === 'timeline') {
                renderMiniCalendar();
                updateTrackerStreakLabel();
            }
        } catch (e2) {
            console.warn('삭제 후 트래커·연속일 갱신:', e2);
        }
    })();
}

export async function deleteEntry() {
    const state = appState;
    if (!state.currentEditingId) {
        showToast("삭제할 항목이 없습니다.", 'error');
        return;
    }

    const delRecForPending = window.mealHistory?.find((m) => m.id === state.currentEditingId);
    if (delRecForPending && isMealEntryDeleting(delRecForPending)) {
        showToast('이미 삭제 처리 중입니다.', 'info');
        return;
    }
    // 등록 대기(pending) 항목도 삭제 허용: ID 선발급으로 deleteDoc을 같은 ID로 큐잉하면
    // Firestore가 생성→삭제 순서로 적용하므로 서버 정합이 유지된다.

    // 삭제 확인 다이얼로그
    if (!confirm("정말 이 기록을 삭제하시겠습니까?")) {
        return;
    }
    
    // 삭제할 ID를 미리 저장 (모달 닫기 전에)
    const entryIdToDelete = state.currentEditingId;

    // temp_ 폴백 레코드(구버전 낙관 행): 서버 문서·큐 추적이 없으므로 로컬에서만 제거
    if (String(entryIdToDelete).startsWith('temp_')) {
        const tempRec = window.mealHistory?.find((m) => m.id === entryIdToDelete) || null;
        window.closeModal();
        try {
            getMealSyncManager().removeTempRowSideEffects(tempRec || { id: entryIdToDelete });
        } catch (_) {
            /* ignore */
        }
        if (Array.isArray(window.mealHistory)) {
            window.mealHistory = window.mealHistory.filter((m) => m.id !== entryIdToDelete);
        }
        setSharedPhotos(getSharedPhotos().filter((p) => p.entryId !== entryIdToDelete));
        invalidateMealHistoryCountCache();
        rerenderAfterMealDelete(tempRec?.date);
        showToast('기록이 삭제되었습니다.', 'success');
        return;
    }

    /** closeModal 전에 캐시에서 확보 — 닫은 뒤에는 편집 id가 비워져 찾기 실패하는 경우 방지 */
    let mealForDelete = window.mealHistory?.find((m) => m.id === entryIdToDelete);
    if (!mealForDelete && entryIdToDelete && window.currentUser?.uid) {
        try {
            // meals 단건 읽기 — App Check 미요구 (위 openModal 경로와 같은 이유)
            const ref = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', entryIdToDelete);
            const snap = await getDoc(ref);
            if (snap.exists()) {
                let rec = { id: snap.id, ...snap.data() };
                const shift = isDemoUser(window.currentUser) ? Number(window.__demoDateShiftDays) || 0 : 0;
                if (shift) rec = applyDemoDateShiftToMealRecord(rec, shift);
                mealForDelete = rec;
                const hist = window.mealHistory || [];
                if (!hist.some((m) => m.id === entryIdToDelete)) {
                    window.mealHistory = [...hist, rec].sort(
                        (a, b) =>
                            (b.date || '').localeCompare(a.date || '') ||
                            (b.time || '').localeCompare(a.time || '')
                    );
                }
            }
        } catch (e) {
            console.warn('deleteEntry: 단건 조회 실패', entryIdToDelete, e);
        }
    }

    // 로그인 상태 확인
    if (!window.currentUser) {
        showToast("로그인이 필요합니다.", 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 삭제할 수 없습니다.', 'error');
        return;
    }

    // 모달을 먼저 닫기 (사용자 경험 개선)
    window.closeModal();

    if (!mealForDelete || !window.mealHistory?.some((m) => m.id === entryIdToDelete)) {
        showToast('삭제할 기록을 찾을 수 없습니다.', 'error');
        return;
    }

    const mealDate = mealForDelete.date;

    /**
     * 삭제도 아웃박스에 내구 저장한다 (§4.1 op:'delete').
     * 삭제 역시 「사용자가 누른 것」이므로, 앱이 죽어도 되살아나지 않아야 한다. 예전에는
     * _deletePending·_deleteInFlight·_deleteFailed 세 플래그가 RAM 에만 있어, 재시작하면
     * 삭제 의사가 사라지고 지운 기록이 되돌아왔다.
     *
     * 여기서 실패해도 삭제 자체는 진행한다 — 등록과 달리 「사라진 것이 되살아나는」 쪽이
     * 되돌리기 쉽고, 모달은 이미 닫혔다. 대신 계측에 남긴다.
     */
    void enqueueWithQuotaRelief({
        target: 'meal',
        id: String(entryIdToDelete),
        uid: window.currentUser.uid,
        op: 'delete',
        class: CLASS_CONTENT,
        payload: { date: mealDate, updatedAt: new Date().toISOString() }
    }).then((ok) => {
        if (!ok) diag('delete.durability.fail', { id: String(entryIdToDelete) });
    });

    markMealEntryDeletePending(entryIdToDelete);
    /** 스냅샷 `removed` 이전에 로컬 반영 — 연속 일수·트래커가 삭제 직후 갱신되도록 */
    let deleteOptCtx = null;
    try {
        deleteOptCtx = applyOptimisticMealDelete(entryIdToDelete, mealForDelete);
    } catch (e) {
        console.warn('applyOptimisticMealDelete', e);
    }
    rerenderAfterMealDelete(mealDate);

    /** 삭제예정 칩만 최대 10초 — 이후에도 진행 중이면 삭제 중(레드닷) */
    const DELETE_SCHEDULED_CHIP_MS = 10000;
    const DELETE_DOC_RACE_MS = 90000;
    let inflightMarked = false;
    let deleteSettled = false;
    const inflightTimer = window.setTimeout(() => {
        if (deleteSettled || inflightMarked) return;
        inflightMarked = true;
        markMealEntryDeleteInFlight(entryIdToDelete);
        try {
            updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
        rerenderAfterMealDelete(mealDate);
    }, DELETE_SCHEDULED_CHIP_MS);

    try {
        const deletePromise = dbOps.delete(entryIdToDelete);
        // 타임아웃 이후 늦게 거절돼도 unhandledrejection으로 새지 않게 관찰
        deletePromise.catch(() => {});
        await Promise.race([
            deletePromise,
            new Promise((_, reject) => {
                setTimeout(() => {
                    const e = new Error('deadline-exceeded');
                    e.code = 'deadline-exceeded';
                    e.__mealogDeleteTimeout = true;
                    reject(e);
                }, DELETE_DOC_RACE_MS);
            })
        ]);
        deleteSettled = true;
        window.clearTimeout(inflightTimer);
        clearMealEntryDeleteFailed(entryIdToDelete);
        // Firestore deleteDoc는 로컬 큐 반영만으로도 resolve될 수 있음. 목록·동기화 맵 정리는
        // meals-snapshot-apply에서 서버 ack된 removed일 때만 수행한다.
        if (deleteOptCtx) showToast('기록이 삭제되었습니다.', 'success');
        rerenderAfterMealDelete(mealDate);
    } catch (error) {
        deleteSettled = true;
        window.clearTimeout(inflightTimer);
        if (error?.__mealogDeleteTimeout) {
            // 타임아웃 = 대부분 오프라인 큐 대기. deleteDoc은 로컬 큐에 남아 재연결 시 서버에 반영된다.
            // 실패·롤백하지 않고 삭제 예약 상태 유지 (스냅샷 removed·reconcile이 완료 처리)
            console.warn('deleteEntry 타임아웃 — 삭제 큐 대기(삭제 예약):', entryIdToDelete);
            showToast('연결되면 서버에 삭제가 반영돼요.', 'info');
            try {
                updateTimelineMealEntryPendingIndicators();
            } catch (_) {
                /* ignore */
            }
            rerenderAfterMealDelete(mealDate);
            return;
        }
        if (deleteOptCtx) {
            try {
                rollbackOptimisticMealDelete(deleteOptCtx);
            } catch (_) {
                /* ignore */
            }
        }
        console.error('삭제 오류:', error);
        markMealEntryDeleteFailed(entryIdToDelete);
        try {
            updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
        try {
            const { loadSharedPhotosPage } = await import('../db.js');
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
            window.sharedPhotosFeed = docs;
            appState.sharedPhotosFeedLastDoc = lastDoc;
            appState.sharedPhotosFeedHasMore = hasMore;
        } catch (_) {
            /* ignore */
        }
        rerenderAfterMealDelete(mealDate);
        if (error.message && String(error.message).includes('로그인이 필요')) {
            showToast('로그인이 필요합니다.', 'error');
        } else {
            showToast(getUserFacingErrorMessage(error, 'delete'), 'error');
        }
    }
}

const MEAL_SYNC_RETRY_TIMEOUT_MS = 10000;

/**
 * 기록 하나를 아웃박스에 내구 저장한다 (설계 §4.1, §4.6).
 *
 * 사진은 Blob 으로 넣는다 — data URL 문자열보다 25% 작고 직렬화 비용도 없다.
 * 원본은 Storage 업로드가 끝나면 워커가 버린다(§4.6).
 *
 * @returns {Promise<boolean>} 실제로 커밋됐는지. false 면 호출부는 저장 성공이라 말하면 안 된다.
 */
async function persistMealToOutbox(record, sourcePhotos, sourcePhotoMeta) {
    try {
        const uid = window.currentUser?.uid;
        if (!uid) {
            diag('outbox.persist.skip', { reason: 'no-uid' });
            return false;
        }
        if (!record?.id) {
            diag('outbox.persist.skip', { reason: 'no-record-id' });
            return false;
        }
        const photos = [];
        for (const p of Array.isArray(sourcePhotos) ? sourcePhotos : []) {
            if (!isLocalPendingPhoto(p)) continue; // 이미 Storage URL 인 것은 다시 안 담는다
            const blob = await dataUrlToBlob(p);
            if (blob) photos.push(blob);
        }
        return await enqueueWithQuotaRelief({
            target: 'meal',
            id: String(record.id),
            uid,
            op: 'upsert',
            class: CLASS_CONTENT,
            payload: {
                ...record,
                // base64 는 payload 에 넣지 않는다 — 사진은 photos(Blob) 가 canonical
                photos: (Array.isArray(sourcePhotos) ? sourcePhotos : []).filter(
                    (p) => typeof p === 'string' && p && !isLocalPendingPhoto(p)
                ),
                photoMeta: sourcePhotoMeta
            },
            photos
        });
    } catch (e) {
        diag('outbox.persist.error', { message: String(e?.message || e).slice(0, 160) });
        console.error('[outbox] 식사 기록 내구 저장 실패:', e);
        return false;
    }
}

/**
 * 기록별 재시도 리스. 사진 업로드가 낀 재시도는 길어질 수 있어 넉넉하되 반드시 유한하다.
 * @type {Map<string, Lease>}
 */
const mealRetryLeases = new Map();

function getMealRetryLease(entryId) {
    const key = String(entryId);
    let l = mealRetryLeases.get(key);
    if (!l) {
        l = new Lease(`meal-retry:${key}`, 120000);
        mealRetryLeases.set(key, l);
        // 세션이 길어져도 무한히 쌓이지 않게 — 점유되지 않은 오래된 항목부터 정리
        if (mealRetryLeases.size > 200) {
            for (const [k, v] of mealRetryLeases) {
                if (!v.held) mealRetryLeases.delete(k);
                if (mealRetryLeases.size <= 100) break;
            }
        }
    }
    return l;
}

/** data:image 또는 blob: → Storage 업로드용 data URL */
/**
 * meal 레코드에 남아 있는 로컬(data:image·blob:) 사진을 Storage에 올린 뒤 photos/sharedPhotos를 https URL 기준으로 맞춘다.
 * dbOps.save는 data URL을 저장하지 않으므로 재시도 경로에서 반드시 선행해야 한다.
 */
async function materializeBase64PhotosOnRecord(record, mealId) {
    const uid = window.currentUser?.uid;
    if (!record || !mealId || !uid) return record;
    const photos = Array.isArray(record.photos) ? record.photos : [];
    const needsUpload = (p) =>
        typeof p === 'string' && (p.startsWith('data:image') || p.startsWith('blob:'));
    const pendingList = photos.filter(needsUpload);
    if (pendingList.length === 0) return record;
    const normalized = await Promise.all(pendingList.map((p) => ensureDataUrlForStorage(p)));
    const uploaded = await Promise.all(normalized.map((p) => uploadBase64ToStorage(p, uid, mealId)));
    let i = 0;
    const finalPhotos = photos
        .map((p) => (needsUpload(p) ? uploaded[i++] : p))
        .filter((p) => typeof p === 'string' && p);
    const next = { ...record, photos: finalPhotos };
    delete next.sharedPhotos;
    return next;
}

/**
 * 동기 실패(느낌표) 기록만 서버에 다시 저장합니다.
 */
export async function retryMealEntrySync(entryIdRaw) {
    const entryId = entryIdRaw != null ? String(entryIdRaw) : '';
    if (!entryId || !window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 사용할 수 없습니다.', 'error');
        return;
    }
    /**
     * 기록별 재시도 점유 — 불린 맵이 아니라 만료 있는 리스다.
     *
     * 예전에는 `window._mealEntryRetryInFlight[entryId] = true` 를 세우고 finally 에서 지웠는데,
     * 안쪽의 getDocFromServer·waitForPendingWrites 가 매달리면 finally 가 돌지 않아
     * **그 기록은 세션 내내 재시도 대상에서 빠졌다.** 사용자가 재전송을 눌러도 조용히 무시된다.
     */
    const lease = getMealRetryLease(entryId);
    if (lease.held) return;
    const record = window.mealHistory?.find((m) => m && String(m.id) === entryId);
    if (!record) {
        showToast('기록을 찾을 수 없습니다.', 'error');
        return;
    }
    if (!isMealEntryRetryEligible(record)) {
        return;
    }

    if (!lease.acquire()) return;
    try {
        /**
         * 등록예정인데 서버 문서가 이미 있으면 재저장·inFlight 없이 ack만 — reconcile 직후 재시도에서 초록→레드 깜빡임 방지.
         * 단 아직 Storage에 안 올라간 로컬 사진이 남아 있으면 건너뛴다: 오프라인 저장은 photos를 비운 채
         * 큐에 들어가므로, 문서 존재만 보고 완료 처리하면 사진이 영영 업로드되지 않는다.
         * (markServerWorkComplete가 pendingPhoto 표식을 지워 스냅샷 병합의 base64 보존도 함께 끊긴다)
         */
        const hasUnuploadedPhotos =
            mealRecordHasBase64PendingPhotos(record) ||
            getMealSyncManager().hasPendingPhotoEntry(entryId) ||
            getMealSyncManager().hasPendingPhotoSlot(`${record.date || ''}__${record.slotId || ''}`);
        if (
            getMealRowSyncLeadKind(record) === 'syncing' &&
            !entryId.startsWith('temp_') &&
            !hasUnuploadedPhotos
        ) {
            const uid = window.currentUser?.uid;
            if (uid) {
                try {
                    // 상한 필수 — 여기서 매달리면 _mealEntryRetryInFlight[entryId] 가 영구히 잠겨
                    // 이 기록은 세션 내내 재시도 대상에서 빠지고, 드레인도 함께 죽는다.
                    const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', entryId);
                    const snap = await withDeadline(getDocFromServer(ref), DEADLINE.DOC, 'retry-serverCheck');
                    if (snap.exists()) {
                        onMealDocFirestoreServerAcknowledged(entryId, null);
                        markMealEntryServerWorkComplete(entryId, null, `${record.date || ''}__${record.slotId || ''}`);
                        invalidateTimelineDateSection(record.date);
                        updateTimelineMealEntryPendingIndicators();
                        if (appState.currentTab === 'timeline' && record.date) renderTimelineDateSections([record.date]);
                        void import('../main/meal-sync-resend-header.js').then((m) => {
                            try {
                                if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
                            } catch (_) {
                                /* ignore */
                            }
                        });
                        return;
                    }
                } catch (chkErr) {
                    console.warn('retryMealEntrySync server check:', chkErr?.message || chkErr);
                }
            }
        }
        clearMealEntryServerSynced(entryId);
        clearMealEntrySyncAbandonedById(entryId);
        clearMealSyncGraceTimer(entryId);
        markMealEntrySaveInFlight(entryId);
        const isTemp = entryId.startsWith('temp_');
        const payload = { ...record };
        delete payload._localSaveFailed;
        delete payload.is_sync_error;

        if (isTemp) {
            const slotKeyMerge = `${record.date || ''}__${record.slotId || ''}`;
            const histMerge = window.mealHistory;
            const existingRealForSlot =
                Array.isArray(histMerge) &&
                histMerge.find(
                    (m) =>
                        m &&
                        String(m.id) !== entryId &&
                        !String(m.id).startsWith('temp_') &&
                        m.date === record.date &&
                        m.slotId === record.slotId
                );

            if (existingRealForSlot) {
                const realId = String(existingRealForSlot.id);
                getMealSyncManager().removeTempRowSideEffects(record);
                window.mealHistory = histMerge.filter((m) => m && String(m.id) !== entryId);
                if (getSharedPhotos()) {
                    setSharedPhotos(getSharedPhotos().map((p) =>
                        p.entryId === entryId ? { ...p, entryId: realId } : p
                    ));
                }
                clearMealEntrySaveFailedById(entryId);
                clearMealEntrySaveFailedById(realId);
                clearMealEntrySaveInFlight(entryId);
                clearMealOptimisticSavePending(entryId);
                onMealDocFirestoreServerAcknowledged(realId, entryId);
                markMealEntryServerWorkComplete(realId, entryId, slotKeyMerge);
            } else {
                delete payload.id;
                const retryTempSavePromise = dbOps.save(payload, true);
                retryTempSavePromise.catch(() => {});
                const retrySaveRes = unwrapMealSaveResult(
                    await Promise.race([
                        retryTempSavePromise,
                        new Promise((_, reject) => {
                            setTimeout(() => {
                                const e = new Error('deadline-exceeded');
                                e.code = 'deadline-exceeded';
                                e.__mealogSaveTimeout = true;
                                reject(e);
                            }, MEAL_SYNC_RETRY_TIMEOUT_MS);
                        })
                    ])
                );
                const savedId = retrySaveRes.mealId;
                const retryViaCallable = retrySaveRes.savedViaCallableFallback;
                if (savedId && window.mealHistory && Array.isArray(window.mealHistory)) {
                    const ix = window.mealHistory.findIndex((m) => m && String(m.id) === entryId);
                    if (ix >= 0) {
                        window.mealHistory[ix] = {
                            ...window.mealHistory[ix],
                            id: savedId
                        };
                        delete window.mealHistory[ix]._localSaveFailed;
                        delete window.mealHistory[ix].is_sync_error;
                    }
                }
                if (savedId) {
                    setSharedPhotos(getSharedPhotos().map((p) =>
                        p.entryId === entryId ? { ...p, entryId: savedId } : p
                    ));
                }
                clearMealEntrySaveFailedById(entryId);
                clearMealEntrySaveFailedById(savedId);
                if (savedId) {
                    clearMealEntrySaveInFlight(entryId);
                    clearMealOptimisticSavePending(entryId);
                    if (retryViaCallable) {
                        onMealDocFirestoreServerAcknowledged(String(savedId), entryId);
                    } else {
                        clearMealEntryServerSynced(String(savedId));
                        markMealEntrySaveInFlight(String(savedId));
                    }
                } else {
                    clearMealEntrySaveInFlight(entryId);
                }
                markMealEntryServerWorkComplete(savedId, entryId, `${record.date || ''}__${record.slotId || ''}`);
                if (savedId && !retryViaCallable) {
                    const retryGraceMs = mealRecordHasBase64PendingPhotos(record)
                        ? MEAL_SYNC_GRACE_MS_WITH_PHOTO
                        : MEAL_SYNC_GRACE_MS_NO_PHOTO;
                    await scheduleMealServerAckAfterPendingWrites(
                        savedId,
                        entryId,
                        record.date,
                        appState.currentTab,
                        retryGraceMs
                    );
                }
            }
        } else {
            let payloadOut = { ...payload };
            try {
                payloadOut = await materializeBase64PhotosOnRecord(payloadOut, entryId);
            } catch (upErr) {
                console.error('retryMealEntrySync: 사진 Storage 업로드 실패', upErr);
                throw upErr;
            }
            const retryRealSavePromise = dbOps.save(payloadOut, true);
            retryRealSavePromise.catch(() => {});
            const retryElseRes = unwrapMealSaveResult(
                await Promise.race([
                    retryRealSavePromise,
                    new Promise((_, reject) => {
                        setTimeout(() => {
                            const e = new Error('deadline-exceeded');
                            e.code = 'deadline-exceeded';
                            e.__mealogSaveTimeout = true;
                            reject(e);
                        }, MEAL_SYNC_RETRY_TIMEOUT_MS);
                    })
                ])
            );
            clearMealEntrySaveFailedById(entryId);
            if (window.mealHistory && Array.isArray(window.mealHistory)) {
                const ix = window.mealHistory.findIndex((m) => m && String(m.id) === entryId);
                if (ix >= 0) {
                    const next = { ...window.mealHistory[ix], ...payloadOut, id: entryId };
                    delete next._localSaveFailed;
                    delete next.is_sync_error;
                    window.mealHistory[ix] = next;
                }
            }
            markMealEntryServerWorkComplete(entryId, null, `${record.date || ''}__${record.slotId || ''}`);
            if (retryElseRes.savedViaCallableFallback && entryId) {
                onMealDocFirestoreServerAcknowledged(String(entryId), null);
            } else {
                const retryGraceMsElse = mealRecordHasBase64PendingPhotos(record)
                    ? MEAL_SYNC_GRACE_MS_WITH_PHOTO
                    : MEAL_SYNC_GRACE_MS_NO_PHOTO;
                await scheduleMealServerAckAfterPendingWrites(
                    entryId,
                    null,
                    record.date,
                    appState.currentTab,
                    retryGraceMsElse
                );
            }
        }
        showToast('서버에 등록했습니다.', 'success');
        invalidateTimelineDateSection(record.date);
        updateTimelineMealEntryPendingIndicators();
        if (appState.currentTab === 'timeline' && record.date) renderTimelineDateSections([record.date]);
    } catch (e) {
        if (e?.__mealogSaveTimeout && !entryId.startsWith('temp_')) {
            /**
             * 재시도 중 타임아웃 — 실패로 표시하지 않는다. 기록은 아웃박스에 그대로 있고
             * 워커가 계속 밀어 올린다. 여기서 상태를 따로 세울 필요가 없다.
             */
            console.warn('retryMealEntrySync 타임아웃 — 아웃박스 유지:', entryId);
            showToast('연결되면 서버에 자동 등록돼요.', 'info');
            invalidateTimelineDateSection(record.date);
            updateTimelineMealEntryPendingIndicators();
            return;
        }
        console.error('retryMealEntrySync:', e);
        showToast(getUserFacingErrorMessage(e, 'save'), 'error');
        clearMealEntrySaveInFlight(entryId);
        markMealEntrySaveFailedById(entryId);
        if (window.mealHistory && Array.isArray(window.mealHistory)) {
            const ix = window.mealHistory.findIndex((m) => m && String(m.id) === entryId);
            if (ix >= 0) {
                window.mealHistory[ix] = {
                    ...window.mealHistory[ix],
                    _localSaveFailed: true,
                    is_sync_error: true
                };
            }
        }
        invalidateTimelineDateSection(record.date);
        updateTimelineMealEntryPendingIndicators();
    } finally {
        lease.release();
    }
}

/** 삭제 실패(오프라인 삭제 시도 등) — 서버에 다시 삭제 요청 */
export async function retryMealEntryDeleteSync(entryIdRaw) {
    const entryId = entryIdRaw != null ? String(entryIdRaw) : '';
    if (!entryId || !window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (isDemoUser(window.currentUser)) {
        showToast('샘플 계정에서는 사용할 수 없습니다.', 'error');
        return;
    }
    if (!window._mealEntryDeleteRetryInFlight) window._mealEntryDeleteRetryInFlight = {};
    if (window._mealEntryDeleteRetryInFlight[entryId]) return;

    const record = window.mealHistory?.find((m) => m && String(m.id) === entryId);
    if (!record) {
        showToast('기록을 찾을 수 없습니다.', 'error');
        return;
    }
    if (!isMealEntryDeleteFailed(record)) return;

    const mealForDelete = record;
    const mealDate = mealForDelete.date;
    window._mealEntryDeleteRetryInFlight[entryId] = true;

    markMealEntryDeletePending(entryId);
    let deleteRetryOptCtx = null;
    try {
        deleteRetryOptCtx = applyOptimisticMealDelete(entryId, mealForDelete);
    } catch (e) {
        console.warn('applyOptimisticMealDelete (retry delete)', e);
    }
    rerenderAfterMealDelete(mealDate);

    const RETRY_DELETE_CHIP_MS = 10000;
    const RETRY_DELETE_DOC_RACE_MS = 90000;
    let inflightMarked = false;
    let deleteSettled = false;
    const inflightTimer = window.setTimeout(() => {
        if (deleteSettled || inflightMarked) return;
        inflightMarked = true;
        markMealEntryDeleteInFlight(entryId);
        try {
            updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
        rerenderAfterMealDelete(mealDate);
    }, RETRY_DELETE_CHIP_MS);

    try {
        const retryDeletePromise = dbOps.delete(entryId);
        retryDeletePromise.catch(() => {});
        await Promise.race([
            retryDeletePromise,
            new Promise((_, reject) => {
                setTimeout(() => {
                    const e = new Error('deadline-exceeded');
                    e.code = 'deadline-exceeded';
                    e.__mealogDeleteTimeout = true;
                    reject(e);
                }, RETRY_DELETE_DOC_RACE_MS);
            })
        ]);
        deleteSettled = true;
        window.clearTimeout(inflightTimer);
        clearMealEntryDeleteFailed(entryId);
        if (deleteRetryOptCtx) showToast('기록이 삭제되었습니다.', 'success');
        rerenderAfterMealDelete(mealDate);
    } catch (error) {
        deleteSettled = true;
        window.clearTimeout(inflightTimer);
        if (error?.__mealogDeleteTimeout) {
            console.warn('retryMealEntryDeleteSync 타임아웃 — 삭제 큐 대기(삭제 예약):', entryId);
            showToast('연결되면 서버에 삭제가 반영돼요.', 'info');
            try {
                updateTimelineMealEntryPendingIndicators();
            } catch (_) {
                /* ignore */
            }
            rerenderAfterMealDelete(mealDate);
            return;
        }
        if (deleteRetryOptCtx) {
            try {
                rollbackOptimisticMealDelete(deleteRetryOptCtx);
            } catch (_) {
                /* ignore */
            }
        }
        console.error('retryMealEntryDeleteSync:', error);
        markMealEntryDeleteFailed(entryId);
        try {
            updateTimelineMealEntryPendingIndicators();
        } catch (_) {
            /* ignore */
        }
        try {
            const { loadSharedPhotosPage } = await import('../db.js');
            const { docs, lastDoc, hasMore } = await loadSharedPhotosPage(10);
            window.sharedPhotosFeed = docs;
            appState.sharedPhotosFeedLastDoc = lastDoc;
            appState.sharedPhotosFeedHasMore = hasMore;
        } catch (_) {
            /* ignore */
        }
        rerenderAfterMealDelete(mealDate);
        if (error.message && String(error.message).includes('로그인이 필요')) {
            showToast('로그인이 필요합니다.', 'error');
        } else {
            showToast(getUserFacingErrorMessage(error, 'delete'), 'error');
        }
    } finally {
        delete window._mealEntryDeleteRetryInFlight[entryId];
    }
}

/** 앱 로드·재접속 시 서버 미등록(실패) 기록을 순차 재시도 */
export async function retryPendingMealEntriesOnAppReady() {
    if (!window.currentUser || window.currentUser.isAnonymous || isDemoUser(window.currentUser)) return;
    const hist = window.mealHistory;
    if (!Array.isArray(hist) || hist.length === 0) return;
    const seen = new Set();
    for (const m of hist) {
        if (!m?.id || seen.has(String(m.id))) continue;
        const deleteRedo = isMealEntryDeleteFailed(m);
        const saveRedo = !deleteRedo && isMealEntryRetryEligible(m);
        if (!deleteRedo && !saveRedo) continue;
        seen.add(String(m.id));
        try {
            if (deleteRedo) {
                await retryMealEntryDeleteSync(m.id);
            } else {
                await retryMealEntrySync(m.id);
            }
        } catch (_) {
            /* 내부 토스트 처리 */
        }
        await new Promise((r) => setTimeout(r, 350));
    }
    void import('../main/meal-sync-resend-header.js').then((m) => {
        try {
            m.refreshMealSyncResendNavButton();
        } catch (_) {
            /* ignore */
        }
    });
}

export function setRating(s) {
    const rating = s != null && Number(s) > 0 ? Number(s) : null;
    appState.currentRating = rating;
    const paintStarRow = (containerId) => {
        const el = document.getElementById(containerId);
        if (!el) return;
        const sts = el.children;
        const active = rating || 0;
        for (let i = 0; i < 5; i++) {
            sts[i].className = i < active ? 'star-btn text-2xl text-amber-500' : 'star-btn text-2xl text-slate-400';
        }
    };
    paintStarRow('starContainer');
    paintStarRow('snackStarContainer');
}

export function resetRating() {
    setRating(null);
}

export function resetSatiety() {
    appState.currentSatiety = null;
    renderSatietyButtons('satietyContainer', null);
    renderSatietyButtons('snackSatietyContainer', null);
}

function renderSatietyButtons(containerId, selected) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const sel = selected != null && Number(selected) > 0 ? Number(selected) : null;
    container.innerHTML = SATIETY_DATA.map(
        (d) =>
            `<button type="button" onclick="window.setSatiety(${d.val})" class="entry-gauge-satiety-btn flex shrink-0 flex-col items-center justify-center gap-1 px-0.5 py-1.5 rounded-xl transition-all ${d.val === sel ? 'entry-gauge-satiety-btn--selected opacity-100 grayscale-0' : 'opacity-40 grayscale hover:grayscale-0 hover:opacity-100'}">
                <i class="fa-solid ${d.icon} ${d.color}"></i>
                <span class="entry-gauge-satiety-btn__label font-bold leading-tight text-center ${d.val === sel ? 'text-slate-800' : 'text-slate-400'}">${d.label}</span>
            </button>`
    ).join('');
}

export function setSatiety(s) {
    const nextVal = s != null && Number(s) > 0 ? Number(s) : null;
    const toggled = appState.currentSatiety === nextVal ? null : nextVal;
    appState.currentSatiety = toggled;
    renderSatietyButtons('satietyContainer', toggled);
    renderSatietyButtons('snackSatietyContainer', toggled);
}

/** 서브 칩 오른쪽 × — data-chip-delete(JSON) 위임 (특수문자·따옴표 안전) */
function initEntryModalSubChipDeleteDelegation() {
    const root = document.getElementById('entryModal');
    if (!root || root._subChipDeleteDelegationBound) return;
    root._subChipDeleteDelegationBound = true;
    root.addEventListener('click', (e) => {
        const delBtn = e.target.closest('[data-chip-delete]');
        if (!delBtn || !root.contains(delBtn)) return;
        e.preventDefault();
        e.stopPropagation();
        let payload;
        try {
            payload = JSON.parse(decodeURIComponent(delBtn.getAttribute('data-chip-delete')));
        } catch (err) {
            console.warn('sub-chip delete: invalid payload', err);
            return;
        }
        if (payload.kind === 'recent' && typeof window.deleteSubTag === 'function') {
            window.deleteSubTag(
                payload.subTagKey,
                payload.text,
                payload.containerId,
                payload.inputId,
                payload.parentFilter,
                payload.fullSubTagText || null
            );
        }
    });
}
setTimeout(initEntryModalSubChipDeleteDelegation, 0);

function initEntryModalTagStageBackOnce() {
    const modal = document.getElementById('entryModal');
    if (!modal || modal._tagStageBackBound) return;
    modal._tagStageBackBound = true;
    modal.addEventListener('click', (e) => {
        const back = e.target.closest?.('[data-entry-tag-back]');
        if (!back || !modal.contains(back)) return;
        e.preventDefault();
        const suggestionsId = back.getAttribute('data-entry-tag-back');
        if (suggestionsId && typeof window.setEntryTagStageView === 'function') {
            window.setEntryTagStageView(suggestionsId, 'main');
        }
    });
}
setTimeout(initEntryModalTagStageBackOnce, 0);

const ENTRY_MODAL_HSCROLL_STRIP_SELECTOR = '.entry-subtag-chips, .entry-detail-record-chips';

/**
 * 기록 모달 가로 스크롤 줄(서브태그·상세보기 칩): 드래그로 좌우 스크롤 (탭/클릭과 구분).
 */
function initEntryModalSubtagDragScroll() {
    const root = document.getElementById('entryModal');
    if (!root || root._subtagDragScrollBound) return;
    root._subtagDragScrollBound = true;

    const DRAG_THRESHOLD_PX = 14;
    const VERTICAL_CANCEL_RATIO = 12;

    /** @type {{ el: HTMLElement, pointerId: number, startX: number, startY: number, startScrollLeft: number, dragging: boolean } | null} */
    let state = null;

    const markDragging = (el, on) => {
        el.classList.toggle('entry-hscroll-strip--dragging', on);
        el.classList.toggle('entry-subtag-suggestions--dragging', on && !!el.closest?.('.entry-subtag-suggestions'));
    };

    const release = () => {
        if (!state) return;
        const { el, pointerId } = state;
        markDragging(el, false);
        try {
            el.releasePointerCapture(pointerId);
        } catch (_) {}
        state = null;
    };

    root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const el = e.target.closest?.(ENTRY_MODAL_HSCROLL_STRIP_SELECTOR);
        if (!el || !root.contains(el)) return;
        if (el.classList.contains('entry-subtag-chips--empty')) return;
        if (el.scrollWidth <= el.clientWidth + 1) return;
        state = {
            el,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: el.scrollLeft,
            dragging: false
        };
        /* pointer capture는 드래그 확정 후에만 — 조기 capture 시 click 타깃이
           스트립으로 바뀌어 칩 토글이 동작하지 않음 */
    }, true);

    root.addEventListener('pointermove', (e) => {
        if (!state || e.pointerId !== state.pointerId) return;
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (!state.dragging) {
            if (Math.abs(dy) > VERTICAL_CANCEL_RATIO && Math.abs(dy) > Math.abs(dx)) {
                release();
                return;
            }
            if (Math.abs(dx) < DRAG_THRESHOLD_PX) return;
            state.dragging = true;
            markDragging(state.el, true);
            try {
                state.el.setPointerCapture(state.pointerId);
            } catch (_) {}
        }
        state.el.scrollLeft = state.startScrollLeft - dx;
        e.preventDefault();
    }, true);

    root.addEventListener('pointerup', (e) => {
        if (!state || e.pointerId !== state.pointerId) return;
        const wasDrag = state.dragging;
        release();
        if (wasDrag) {
            const killClick = (ev) => {
                const strip = ev.target.closest?.(ENTRY_MODAL_HSCROLL_STRIP_SELECTOR);
                if (!strip || !root.contains(strip)) return;
                ev.preventDefault();
                ev.stopPropagation();
                root.removeEventListener('click', killClick, true);
            };
            root.addEventListener('click', killClick, true);
        }
    }, true);

    root.addEventListener('pointercancel', (e) => {
        if (!state || e.pointerId !== state.pointerId) return;
        release();
    }, true);
}
setTimeout(initEntryModalSubtagDragScroll, 0);

export function selectTag(inputId, value, btn, isPrimary, subTagKey = null, subContainerId = null) {
    dismissEntryModalFocusedInput();
    const container = btn.parentElement.closest('.sub-chip-wrapper') ? btn.parentElement.parentElement : btn.parentElement;
    const isActive = btn.classList.contains('active');
    
    // 서브태그: 본식 무엇을·누구와, 간식 무엇을·누구와 — 다중 선택(쉼표 구분)
    const isMultiSelect =
        !isPrimary &&
        (subContainerId === 'entryWithSuggestions' ||
            subContainerId === 'entryWhatSuggestions' ||
            subContainerId === 'entryWithSuggestions' ||
            subContainerId === 'entryWhatSuggestions');
    
    if (!isMultiSelect) {
        // 단일 선택: 다른 태그 선택 해제
        container.querySelectorAll(isPrimary ? '.chip' : '.sub-chip').forEach(c => c.classList.remove('active'));
    }
    
    let selectedValue = value;
    
    if (isActive) {
        btn.classList.remove('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) {
                if (isMultiSelect) {
                    // 다중 선택: 현재 값에서 제거
                    const currentValues = input.value.split(',').map(v => v.trim()).filter(v => v);
                    const newValues = currentValues.filter(v => v !== value);
                    input.value = newValues.join(', ');
                } else {
                    input.value = '';
                }
            }
        }
        selectedValue = null;
    } else {
        btn.classList.add('active');
        if (inputId !== 'null') {
            const input = document.getElementById(inputId);
            if (input) {
                if (isMultiSelect) {
                    // 다중 선택: 현재 값에 추가
                    const currentValues = input.value.split(',').map(v => v.trim()).filter(v => v);
                    if (!currentValues.includes(value)) {
                        currentValues.push(value);
                    }
                    input.value = currentValues.join(', ');
                } else {
                    input.value = value;
                }
            }
        }
    }
    
    // Skip 선택 시 필드 숨기기 처리 (식사 모드·entryWhereChips에서만)
    if (isPrimary && inputId === 'null' && subTagKey === 'place' && appState.entryFormMode !== 'snack') {
        const isSkip = (selectedValue === 'Skip' || selectedValue === '건너뜀');
        toggleFieldsForSkip(isSkip);
    }
    
    if (isPrimary && subTagKey === 'place' && subContainerId === 'entryWhereSuggestions' && selectedValue && appState.entryFormMode === 'meal' && (selectedValue === '집밥' || selectedValue === '배달/포장')) {
        const pi = document.getElementById('entryWhereInput');
        if (pi) {
            pi.value = '우리집';
            pi.removeAttribute('data-kakao-place-id');
            pi.removeAttribute('data-kakao-place-address');
            pi.removeAttribute('data-kakao-place-data');
            pi.removeAttribute('data-kakao-place-name');
        }
    }

    if (isPrimary && subTagKey && subContainerId) {
        if (subContainerId === 'entryWhereSuggestions' && appState.entryFormMode === 'snack') {
            appState.selectedSnackPlaceMainTag = selectedValue;
        }
        const subTags = window.userSettings.subTags[subTagKey] || [];
        const inputIdForSecondary = (subTagKey === 'people') ? 'entryWithInput' : 
            (document.getElementById(subContainerId)?.getAttribute('data-input-id') || getInputIdFromContainer(subContainerId));
        window.renderSecondary(subContainerId, subTags, inputIdForSecondary, selectedValue, subTagKey);
        if (typeof window.setEntryTagStageView === 'function') {
            window.setEntryTagStageView(subContainerId, selectedValue ? 'sub' : 'main');
        }
    }
    syncDeliveryVendorSectionVisibility();
}

function toggleFieldsForSkip(isSkip) {
    // Skip: 무엇을(기본 탭) · 누구와(추가 탭) · 상세 메트릭 숨김
    const optionalFields = document.getElementById('optionalFields');
    if (optionalFields) {
        optionalFields.classList.toggle('hidden', !!isSkip);
    }
    document.getElementById('entryWithSection')?.classList.toggle('hidden', !!isSkip);

    setEntrySheetTabsForSkip(isSkip);
    setEntryDetailRecordPanelHidden(isSkip);

    if (!isSkip) {
        applyEntryDetailRecordUi();
    }
    syncDeliveryVendorSectionVisibility();
}

export function processRecordImagesFromFiles(files, { isSnack = false } = {}) {
    const state = appState;
    const list = Array.from(files || []).filter((f) => f?.type?.startsWith?.('image/'));
    if (!list.length) return;

    const currentCount = state.currentPhotos.length;
    const remainingSlots = RECORD_MAX_PHOTOS - currentCount;

    if (remainingSlots <= 0) {
        showToast(`사진은 최대 ${RECORD_MAX_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
        return;
    }

    const filesToProcess = list.slice(0, remainingSlots);

    if (list.length > remainingSlots) {
        showToast(`사진은 최대 ${RECORD_MAX_PHOTOS}개까지 가능합니다. ${remainingSlots}개만 추가됩니다.`, 'info');
    }

    /**
     * 인테이크에서 다운스케일한다 (설계 §4.6). 예전에는 원본을 그대로 readAsDataURL 해서
     * 기록 하나가 최대 ~80MB 문자열이 됐고, 그 무게가 백그라운드 저메모리 킬을 불러
     * RAM 에만 있던 기록이 사라지는 원인이 됐다.
     *
     * EXIF 촬영시각은 아래 createPhotoMetaFromFile 이 **원본 File** 에서 따로 읽으므로
     * 다운스케일과 무관하다. 회전은 image-downscale.js 가 디코드 단계에서 적용한다.
     */
    const filePromises = filesToProcess.map(async (f, index) => {
        const prepared = await prepareIntakeImage(f);
        if (!prepared) {
            console.error('파일 읽기 실패:', f.name);
            return null;
        }
        return { index, dataUrl: prepared.dataUrl, downscaled: prepared.downscaled, reason: prepared.reason };
    });

    Promise.all(filePromises)
        .then(async (results) => {
            const sortedResults = results.filter((r) => r !== null).sort((a, b) => a.index - b.index);

            const currentPhotosCount = state.currentPhotos.length;
            const availableSlots = RECORD_MAX_PHOTOS - currentPhotosCount;

            const exifMetaEntries = await Promise.all(filesToProcess.map((file) => createPhotoMetaFromFile(file)));

            let added = 0;
            sortedResults.slice(0, availableSlots).forEach(({ index, dataUrl }) => {
                if (state.currentPhotos.length < RECORD_MAX_PHOTOS) {
                    state.currentPhotos.push(dataUrl);
                    if (!Array.isArray(state.currentPhotoMeta)) state.currentPhotoMeta = [];
                    state.currentPhotoMeta.push(exifMetaEntries[index] || { takenAt: null });
                    added += 1;
                }
            });
            if (added > 0) {
                diag('photo.intake', {
                    n: added,
                    downscaled: sortedResults.filter((r) => r.downscaled).length,
                    reasons: [...new Set(sortedResults.map((r) => r.reason))]
                });
                state.recordPhotoHeroIndex = state.currentPhotos.length - 1;
            }

            renderPhotoPreviews();
            updateShareIndicator();
        })
        .catch((err) => {
            console.error('파일 처리 중 오류 발생:', err);
            showToast('사진 처리 중 오류가 발생했습니다.', 'error');
        });
}

export function handleMultipleImages(e) {
    const isSnack = e.target?.id === 'snackImageInput';
    processRecordImagesFromFiles(e.target?.files, { isSnack });
    if (e.target) e.target.value = '';
}

async function pickRecordImages(isSnack, source) {
    const remainingSlots = RECORD_MAX_PHOTOS - appState.currentPhotos.length;
    if (remainingSlots <= 0) {
        showToast(`사진은 최대 ${RECORD_MAX_PHOTOS}개까지 추가할 수 있습니다.`, 'error');
        return;
    }
    const { pickCameraImage, pickGalleryImages } = await import('../utils/image-source-picker.js');
    const files =
        source === 'camera'
            ? await pickCameraImage({ facing: 'environment' })
            : await pickGalleryImages({ multiple: true });
    if (!files.length) return;
    processRecordImagesFromFiles(files, { isSnack });
}

export function openRecordCameraPicker(isSnack = false) {
    return pickRecordImages(isSnack, 'camera');
}

export function openRecordGalleryPicker(isSnack = false) {
    return pickRecordImages(isSnack, 'gallery');
}

export function removePhoto(idx) {
    const state = appState;
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= state.currentPhotos.length) return;
    state.currentPhotos.splice(i, 1);
    if (Array.isArray(state.currentPhotoMeta)) {
        state.currentPhotoMeta.splice(i, 1);
    }
    if (state.recordPhotoHeroIndex > i) {
        state.recordPhotoHeroIndex -= 1;
    }
    clampRecordPhotoHeroIndex();
    renderPhotoPreviews();
    updateShareIndicator();
}

/** 히어로에 표시할 사진 선택 (썸네일 탭) */
export function selectRecordPhotoPreview(idx) {
    const photos = appState.currentPhotos;
    if (!Array.isArray(photos) || photos.length === 0) return;
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= photos.length) return;
    if (appState.recordPhotoHeroIndex === i) return;
    appState.recordPhotoHeroIndex = i;
    renderPhotoPreviews();
}

/** 히어로 사진 좌우 이동 */
export function navigateRecordPhotoPreview(delta) {
    const photos = appState.currentPhotos;
    if (!Array.isArray(photos) || photos.length < 2) return;
    const d = Number(delta);
    if (!Number.isInteger(d) || d === 0) return;
    const cur = clampRecordPhotoHeroIndex();
    const next = cur + d;
    if (next < 0 || next >= photos.length) return;
    appState.recordPhotoHeroIndex = next;
    renderPhotoPreviews();
}

/** 사진 순서: 인접 항목과 교환 (delta -1 = 앞쪽, +1 = 뒤쪽) */
export function movePhotoOrder(idx, delta) {
    const state = appState;
    const photos = state.currentPhotos;
    if (!Array.isArray(photos) || photos.length < 2) return;
    const i = Number(idx);
    const d = Number(delta);
    if (!Number.isInteger(i) || !Number.isInteger(d) || i < 0 || i >= photos.length) return;
    const j = i + d;
    if (j < 0 || j >= photos.length) return;
    const tmp = photos[i];
    photos[i] = photos[j];
    photos[j] = tmp;
    const meta = state.currentPhotoMeta;
    if (Array.isArray(meta) && meta.length === photos.length) {
        const tmpMeta = meta[i];
        meta[i] = meta[j];
        meta[j] = tmpMeta;
    }
    if (state.recordPhotoHeroIndex === i) state.recordPhotoHeroIndex = j;
    else if (state.recordPhotoHeroIndex === j) state.recordPhotoHeroIndex = i;
    renderPhotoPreviews();
}

export function updateShareIndicator() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;

    const isShareBanned = state.currentEditingId
        ? window.mealHistory.find((m) => m.id === state.currentEditingId)?.shareBanned === true
        : false;

    shareIndicator.classList.remove('entry-action-btn--share-on', 'entry-action-btn--share-banned');
    shareIndicator.disabled = false;
    shareIndicator.removeAttribute('aria-disabled');

    if (state.currentPhotos.length === 0) {
        shareIndicator.classList.add('hidden');
        shareIndicator.title = '';
        return;
    }

    shareIndicator.classList.remove('hidden');

    if (isShareBanned) {
        shareIndicator.classList.add('entry-action-btn--share-banned');
        shareIndicator.disabled = true;
        shareIndicator.setAttribute('aria-disabled', 'true');
        shareIndicator.title = '공유가 금지된 게시물입니다';
        return;
    }

    shareIndicator.title = state.wantsToShare ? '모먼트에 공유됩니다' : '모먼트에 공유하기';
    if (state.wantsToShare) {
        shareIndicator.classList.add('entry-action-btn--share-on');
    }
}

export function toggleSharePhoto() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator || shareIndicator.disabled || shareIndicator.classList.contains('hidden')) return;

    if (state.currentPhotos.length === 0) {
        showToast('공유할 사진이 없습니다.', 'error');
        return;
    }

    const isShareBanned = state.currentEditingId
        ? window.mealHistory.find((m) => m.id === state.currentEditingId)?.shareBanned === true
        : false;
    if (isShareBanned) {
        showToast('공유가 금지된 게시물입니다.', 'error');
        return;
    }

    state.wantsToShare = !state.wantsToShare;
    updateShareIndicator();
}

