// 모달 및 입력 처리 관련 함수들
import { SLOTS, SATIETY_DATA, DEFAULT_ICONS, DEFAULT_SUB_TAGS, DEFAULT_USER_SETTINGS } from '../constants.js';
import { appState } from '../state.js';
import { setVal, getInputIdFromContainer, normalizeUrl, addCompositionAwareInput, uploadBase64ToStorage, normalizeBirthdateRaw } from '../utils.js';
import { renderEntryChips, renderPhotoPreviews, renderTagManager } from '../render/index.js';
import { dbOps, unwrapMealSaveResult } from '../db.js';
import { showToast, showSuccessPopup } from '../ui.js';
import { resolveRecordCompletePopupMessage, updateTrackerStreakLabel } from '../attendance-check.js';
import {
    renderTimeline,
    renderMiniCalendar,
    updateTimelineShareIndicators,
    updateTimelineMealEntryPendingIndicators,
    invalidateTimelineDateSection,
    renderGallery,
    renderFeed
} from '../render/index.js';
import { getDashboardData } from '../analytics.js';
import { callableFunctions, db, appId, refreshAppCheckTokenBeforeFirestore } from '../firebase.js';
import { isDemoUser } from '../demo-account.js';
import { doc, getDoc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { applyDemoDateShiftToMealRecord } from '../demo-date-shift.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
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
    scheduleMealSyncGraceAbandon,
    isMealEntrySyncAbandoned,
    isMealEntryDeleteFailed,
    applyOfflineAfterLocalSaveUi,
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
    tryExifTimeHHmmFromImageFile,
    formatMealClock12TextWhileTyping,
    normalizeMealClock12InputValue,
    mealClock24FromAmPmClock,
    mealClock24ToAmPmAndDisplay
} from '../meal-time-utils.js';
import {
    createPhotoMetaFromFile,
    normalizePhotoMetaFromRecord,
    resolveFirstPhotoTakenAt,
    syncPhotoMetaLength
} from '../photo-meta.js';
import {
    closeTimeSourceSheets,
    openTimeManualPanel,
    openTimeSourceSheet
} from '../time-source-picker.js';
import { saveWithTimeout } from '../utils/save-with-timeout.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
// ⚠️ initPushNotifications import 제거 - 크래시 문제로 인해 비활성화
// 저장 직후 동기화 도트(waitForPendingWrites 등)는 meal-sync-manager.scheduleServerAckAfterPendingWrites (meal-entry-pending re-export)

function isMealActionEffectiveOffline() {
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    } catch (_) {}
    return !!appState.localNetworkForcedOffline;
}

// 설정 저장 디바운싱을 위한 타이머
let settingsSaveTimeout = null;
let entryGaugeSaveTimeout = null;

const PHOTO_ASPECT_OPTIONS = ['1:1', '3:4', '4:3'];

/** 활성 서브칩 라벨 (입력란 동기화·검증용) */
function collectActiveSubChipLabels(containerId) {
    const root = document.getElementById(containerId);
    if (!root) return [];
    return [...root.querySelectorAll('button.sub-chip.active')].map((el) =>
        el.textContent.replace(/\s*★\s*$/, '').trim()
    ).filter(Boolean);
}

/** 입력란이 비어 있을 때만 활성 서브칩을 쉼표로 합쳐 넣음 (태그만 선택한 저장 대비) */
function mergeActiveSubChipsIntoInputs() {
    const merge = (containerId, inputId) => {
        const input = document.getElementById(inputId);
        if (!input || input.value.trim()) return;
        const labels = collectActiveSubChipLabels(containerId);
        if (labels.length) input.value = labels.join(', ');
    };
    merge('menuSuggestions', 'menuDetailInput');
    merge('peopleSuggestions', 'withWhomInput');
    merge('snackSuggestions', 'snackDetailInput');
    merge('snackPeopleSuggestions', 'snackWithWhomInput');
    merge('restaurantSuggestions', 'placeInput');
    merge('snackPlaceSuggestions', 'snackPlaceInput');
}

/** 배달/포장일 때만 '어디서 가져오셨나요' 입력란 표시 (다른 유형으로 바꾸면 값 초기화) */
export function syncDeliveryVendorSectionVisibility() {
    const sec = document.getElementById('deliveryVendorSection');
    if (!sec) return;
    const optional = document.getElementById('optionalFields');
    const skipOptional = optional?.classList.contains('hidden');
    const typeChips = document.getElementById('typeChips');
    let mealType = '';
    if (typeChips) {
        const active = typeChips.querySelector('button.chip.active');
        if (active) mealType = active.innerText.trim();
    }
    const show = !skipOptional && mealType === '배달/포장';
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

    const mdi = document.getElementById('menuDetailInput');
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

function syncEntryGaugeToggleCheckboxes() {
    const rM = appState.entryGaugeRatingOnMain === true;
    const rS = appState.entryGaugeRatingOnSnack === true;
    const sM = appState.entryGaugeSatietyOnMain === true;
    const sS = appState.entryGaugeSatietyOnSnack === true;
    const elRM = document.getElementById('entryGaugeRatingToggleMain');
    if (elRM) elRM.checked = rM;
    const elRS = document.getElementById('entryGaugeRatingToggleSnack');
    if (elRS) elRS.checked = rS;
    const elSM = document.getElementById('entryGaugeSatietyToggleMain');
    if (elSM) elSM.checked = sM;
    const elSS = document.getElementById('entryGaugeSatietyToggleSnack');
    if (elSS) elSS.checked = sS;
}

function applyEntryGaugeDialUi() {
    const rM = appState.entryGaugeRatingOnMain === true;
    const rS = appState.entryGaugeRatingOnSnack === true;
    const sM = appState.entryGaugeSatietyOnMain === true;
    const sS = appState.entryGaugeSatietyOnSnack === true;
    const pairs = [
        ['ratingGaugeDialWrap', 'ratingGaugeOffLayerMain', rM],
        ['snackRatingGaugeDialWrap', 'ratingGaugeOffLayerSnack', rS],
        ['satietyGaugeDialWrap', 'satietyGaugeOffLayerMain', sM],
        ['snackSatietyGaugeDialWrap', 'satietyGaugeOffLayerSnack', sS]
    ];
    pairs.forEach(([wrapId, layerId, on]) => {
        const wrap = document.getElementById(wrapId);
        const layer = document.getElementById(layerId);
        if (wrap) wrap.classList.toggle('entry-gauge-dial-wrap--off', !on);
        if (layer) {
            layer.classList.toggle('hidden', on);
            layer.setAttribute('aria-hidden', on ? 'true' : 'false');
        }
    });
}

function syncEntryMealClockToggleCheckboxes() {
    const tM = appState.entryTimeOnMain === true;
    const tS = appState.entryTimeOnSnack === true;
    const elM = document.getElementById('entryMealClockToggleMain');
    const elS = document.getElementById('entryMealClockToggleSnack');
    if (elM) elM.checked = tM;
    if (elS) elS.checked = tS;
}

/** isMain:true = 본식 시간, false = 간식 시간 — 저장값은 24시 "HH:mm" */
const MEAL_CLOCK_SOURCE_LABELS = {
    now: '현재 시각',
    photo: '사진 시각',
    manual: '직접 입력'
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
        setEntryMealClockSource(isMain, null);
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
            openTimeManualPanel({
                mode: 'time',
                zIndex: 350,
                initialDate: getMealClockInitialDate(isMain),
                onApply: (date) => applyMealClockFromDate(isMain, date, 'manual'),
                onInvalid: () => showToast('올바른 시간을 입력해주세요.', 'error')
            });
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
    ensureEntryModalGaugesOnUserSettings();
    const prefs = window.userSettings.entryModalGauges;
    const ptM = prefs.main?.timeEnabled === true;
    const ptS = prefs.snack?.timeEnabled === true;

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
        const pt = mainSide ? ptM : ptS;
        const setOn = (v) => {
            if (mainSide) appState.entryTimeOnMain = v;
            else appState.entryTimeOnSnack = v;
        };

        if (r) {
            const mc = r.mealClock;
            if (typeof mc === 'string' && mc.trim()) {
                setOn(true);
                applyMealClockRowFrom24(mainSide, mc);
            } else if (mc === null) {
                setOn(false);
                applyMealClockRowFrom24(mainSide, '');
            } else {
                setOn(pt);
                applyMealClockRowFrom24(mainSide, '');
            }
        } else {
            setOn(pt);
            applyMealClockRowFrom24(mainSide, '');
        }
    };

    applySide(true);
    applySide(false);
    syncEntryMealClockToggleCheckboxes();
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

/** 신규 + 해당 슬롯 시간 on: 모달 오픈 시각으로 1회만 채움 */
function seedEntryMealClockOnModalOpenAfterFinalize(entryId, isSnackMode) {
    if (entryId) return;
    const d = new Date();
    const hhmmRaw = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const hhmm = normalizeMealClockInputValue(hhmmRaw) || hhmmRaw;
    if (!isSnackMode && appState.entryTimeOnMain === true && !appState.entryMealClockDidSeedModalOpenMain) {
        applyMealClockRowFrom24(true, hhmm);
        setEntryMealClockSource(true, 'now');
        appState.entryMealClockDidSeedModalOpenMain = true;
    }
    if (isSnackMode && appState.entryTimeOnSnack === true && !appState.entryMealClockDidSeedModalOpenSnack) {
        applyMealClockRowFrom24(false, hhmm);
        setEntryMealClockSource(false, 'now');
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

function finalizeEntryModalGauges(savedRecord, isSnackMode) {
    ensureEntryModalGaugesOnUserSettings();
    const prefs = window.userSettings.entryModalGauges;
    const prM = prefs.main?.ratingEnabled === true;
    const psM = prefs.main?.satietyEnabled === true;
    const prS = prefs.snack?.ratingEnabled === true;
    const psS = prefs.snack?.satietyEnabled === true;

    const applyRecord = (r, pr, ps, setR, setS) => {
        const rn = r.rating != null && r.rating !== '' ? Number(r.rating) : NaN;
        if (Number.isFinite(rn)) setR(true);
        else if (r.rating === null) setR(false);
        else setR(pr);
        const sn = r.satiety != null && r.satiety !== '' ? Number(r.satiety) : NaN;
        if (Number.isFinite(sn)) setS(true);
        else if (r.satiety === null) setS(false);
        else setS(ps);
    };

    if (savedRecord) {
        if (isSnackMode) {
            applyRecord(
                savedRecord,
                prS,
                psS,
                (v) => { appState.entryGaugeRatingOnSnack = v; },
                (v) => { appState.entryGaugeSatietyOnSnack = v; }
            );
            appState.entryGaugeRatingOnMain = prM;
            appState.entryGaugeSatietyOnMain = psM;
        } else {
            applyRecord(
                savedRecord,
                prM,
                psM,
                (v) => { appState.entryGaugeRatingOnMain = v; },
                (v) => { appState.entryGaugeSatietyOnMain = v; }
            );
            appState.entryGaugeRatingOnSnack = prS;
            appState.entryGaugeSatietyOnSnack = psS;
        }
    } else {
        appState.entryGaugeRatingOnMain = prM;
        appState.entryGaugeSatietyOnMain = psM;
        appState.entryGaugeRatingOnSnack = prS;
        appState.entryGaugeSatietyOnSnack = psS;
    }
    syncEntryGaugeToggleCheckboxes();
    applyEntryGaugeDialUi();
}

function initEntryModalGaugeControlsOnce() {
    if (window.__entryGaugeTogglesInit) return;
    window.__entryGaugeTogglesInit = true;
    const onRatingMain = (checked) => {
        appState.entryGaugeRatingOnMain = checked;
        syncEntryGaugeToggleCheckboxes();
        applyEntryGaugeDialUi();
        schedulePersistEntryModalGaugePrefs();
    };
    const onRatingSnack = (checked) => {
        appState.entryGaugeRatingOnSnack = checked;
        syncEntryGaugeToggleCheckboxes();
        applyEntryGaugeDialUi();
        schedulePersistEntryModalGaugePrefs();
    };
    const onSatietyMain = (checked) => {
        appState.entryGaugeSatietyOnMain = checked;
        syncEntryGaugeToggleCheckboxes();
        applyEntryGaugeDialUi();
        schedulePersistEntryModalGaugePrefs();
    };
    const onSatietySnack = (checked) => {
        appState.entryGaugeSatietyOnSnack = checked;
        syncEntryGaugeToggleCheckboxes();
        applyEntryGaugeDialUi();
        schedulePersistEntryModalGaugePrefs();
    };
    const bindToggle = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', () => handler(!!el.checked));
    };
    bindToggle('entryGaugeRatingToggleMain', onRatingMain);
    bindToggle('entryGaugeRatingToggleSnack', onRatingSnack);
    bindToggle('entryGaugeSatietyToggleMain', onSatietyMain);
    bindToggle('entryGaugeSatietyToggleSnack', onSatietySnack);

    const fillNowIfEmpty = (mainSide) => {
        const inp = document.getElementById(mainSide ? 'entryMealTimeInputMain' : 'entryMealTimeInputSnack');
        if (!inp || String(inp.value || '').trim()) return;
        const d = new Date();
        applyMealClockRowFrom24(mainSide, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
        setEntryMealClockSource(mainSide, 'now');
    };
    const applyPendingExifOrFillNowWhenToggleOn = (mainSide) => {
        if (appState.currentEditingId) {
            fillNowIfEmpty(mainSide);
            return;
        }
        const pending = mainSide ? appState.entryMealClockPendingExifHhmmMain : appState.entryMealClockPendingExifHhmmSnack;
        const applied = mainSide ? appState.entryMealClockDidApplyPhotoExifMain : appState.entryMealClockDidApplyPhotoExifSnack;
        if (pending != null && String(pending).trim() !== '' && !applied) {
            applyMealClockRowFrom24(mainSide, normalizeMealClockInputValue(pending) || pending);
            setEntryMealClockSource(mainSide, 'photo');
            if (mainSide) {
                appState.entryMealClockDidApplyPhotoExifMain = true;
                appState.entryMealClockPendingExifHhmmMain = null;
            } else {
                appState.entryMealClockDidApplyPhotoExifSnack = true;
                appState.entryMealClockPendingExifHhmmSnack = null;
            }
            return;
        }
        fillNowIfEmpty(mainSide);
    };
    const onTimeMain = (checked) => {
        appState.entryTimeOnMain = checked;
        syncEntryMealClockToggleCheckboxes();
        if (checked) {
            applyPendingExifOrFillNowWhenToggleOn(true);
        } else {
            applyMealClockRowFrom24(true, '');
            setEntryMealClockSource(true, null);
        }
        applyEntryMealClockInputVisibility();
        schedulePersistEntryModalGaugePrefs();
    };
    const onTimeSnack = (checked) => {
        appState.entryTimeOnSnack = checked;
        syncEntryMealClockToggleCheckboxes();
        if (checked) {
            applyPendingExifOrFillNowWhenToggleOn(false);
        } else {
            applyMealClockRowFrom24(false, '');
            setEntryMealClockSource(false, null);
        }
        applyEntryMealClockInputVisibility();
        schedulePersistEntryModalGaugePrefs();
    };
    bindToggle('entryMealClockToggleMain', onTimeMain);
    bindToggle('entryMealClockToggleSnack', onTimeSnack);

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
    document.querySelectorAll('.photo-aspect-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-aspect') === ratio;
        btn.classList.toggle('bg-emerald-100', isActive);
        btn.classList.toggle('border-emerald-300', isActive);
        btn.classList.toggle('text-emerald-700', isActive);
        btn.classList.toggle('border-slate-200', !isActive);
        btn.classList.toggle('text-slate-600', !isActive);
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
    const closeBtn = entryModal.querySelector('button[onclick*="closeModal"]');
    if (btnSave) {
        btnSave.disabled = saving;
        if (saving) {
            if (!btnSave.dataset.defaultHtml) btnSave.dataset.defaultHtml = btnSave.innerHTML;
            btnSave.innerHTML =
                '<i class="fa-solid fa-spinner fa-spin text-sm" aria-hidden="true"></i><span class="mt-0.5">저장 중…</span>';
        } else if (btnSave.dataset.defaultHtml) {
            btnSave.innerHTML = btnSave.dataset.defaultHtml;
        }
    }
    if (btnDelete) btnDelete.disabled = saving;
    if (closeBtn) closeBtn.disabled = saving;
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

/** 끼니 등록 모달: 키보드 열림 시 모달 높이를 viewport에 맞추고, 닫힘 시 네비바 영역 복원 */
function initEntryModalKeyboardHandling(entryModal) {
    if (!entryModal || entryModal._keyboardHandlingInit) return;
    entryModal._keyboardHandlingInit = true;
    let baselineHeight = 0; // 모달 열릴 때 viewport 높이 (키보드 없음)
    let imeComposing = false; // 한글 등 IME 조합 중 여부 (조합 중 레이아웃 업데이트 시 텍스트 미표시 방지)
    let lastAppliedVh = NaN;
    let lastAppliedVtop = NaN;
    let viewportGeomRaf = null;
    let viewportCheckTimer = null;

    const getViewportThreshold = () => (baselineHeight || window.innerHeight) * 0.85;

    const applyViewportGeometry = (vh, vtop) => {
        if (!entryModal.classList.contains('keyboard-open')) return;
        const hRaw = Number.isFinite(vh) ? vh : (window.innerHeight || 0);
        const tRaw = Number.isFinite(vtop) ? vtop : 0;
        // 키보드 애니 첫 프레임에 offsetTop이 음수·과대로 나와 시트가 위로 튀는 경우 방지
        const h = Math.max(0, Math.min(hRaw, window.innerHeight || hRaw));
        const top = Math.max(0, tRaw);
        if (
            !Number.isNaN(lastAppliedVh) &&
            Math.abs(lastAppliedVh - h) < 1 &&
            Math.abs(lastAppliedVtop - top) < 1
        ) {
            return;
        }
        lastAppliedVh = h;
        lastAppliedVtop = top;
        entryModal.style.height = h + 'px';
        entryModal.style.top = top + 'px';
    };

    const scheduleViewportGeometryFromVv = () => {
        if (viewportGeomRaf != null) return;
        viewportGeomRaf = requestAnimationFrame(() => {
            viewportGeomRaf = null;
            if (entryModal.classList.contains('hidden')) return;
            if (!entryModal.classList.contains('keyboard-open')) return;
            if (imeComposing) return;
            const vv = window.visualViewport;
            if (!vv) return;
            const vh = vv.height;
            const vtop = vv.offsetTop ?? 0;
            applyViewportGeometry(vh, vtop);
        });
    };

    entryModal.querySelectorAll('input, textarea').forEach(el => {
        el.addEventListener('compositionstart', () => { imeComposing = true; });
        el.addEventListener('compositionend', () => {
            imeComposing = false;
            nudgeEntryModalInputRepaint(entryModal);
            scheduleViewportGeometryFromVv();
        });
        el.addEventListener('input', () => {
            if (imeComposing) return;
            nudgeEntryModalInputRepaint(entryModal);
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
            entryModal.classList.add('keyboard-open');
            // focusin 직후 visualViewport가 아직 키보드 이전 값 → rAF+debounce로 geometry 맞춤
            lastAppliedVh = NaN;
            lastAppliedVtop = NaN;
            scheduleViewportGeometryFromVv();
            scheduleViewportCheck();
        } else {
            entryModal.classList.remove('keyboard-open');
            lastAppliedVh = NaN;
            lastAppliedVtop = NaN;
            if (viewportGeomRaf != null) {
                cancelAnimationFrame(viewportGeomRaf);
                viewportGeomRaf = null;
            }
            if (viewportCheckTimer != null) {
                clearTimeout(viewportCheckTimer);
                viewportCheckTimer = null;
            }
            entryModal.style.height = '';
            entryModal.style.top = '';
        }
    };
    // 모달 열릴 때 baseline 저장 (openModal에서 호출)
    const saveBaseline = () => {
        baselineHeight = Math.max(window.visualViewport?.height ?? window.innerHeight, window.innerHeight * 0.5);
    };
    entryModal.setKeyboardBaseline = saveBaseline;
    entryModal.addEventListener('focusin', (e) => {
        if (e.target.matches('input, textarea')) setKeyboardOpen(true);
    });
    entryModal.addEventListener('focusout', (e) => {
        if (e.target.matches('input, textarea')) scheduleViewportCheck();
    });
    const checkViewport = () => {
        if (entryModal.classList.contains('hidden')) return;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        const threshold = getViewportThreshold();
        if (vh >= threshold) {
            setKeyboardOpen(false);
            return;
        }
        // 키보드가 아직 올라와 있으면 포커스 유무와 관계없이 geometry 유지 (칩 탭 등 focusout 깜빡임 방지)
        if (!entryModal.classList.contains('keyboard-open')) {
            entryModal.classList.add('keyboard-open');
            lastAppliedVh = NaN;
            lastAppliedVtop = NaN;
        }
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
            if (pendingRec && isMealEntryPendingSync(pendingRec)) {
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
        state.currentPhotoMeta = [];
        state.entryMealClockSourceMain = null;
        state.entryMealClockSourceSnack = null;
        state.sharedPhotos = []; // 이미 공유된 사진 목록
        state.originalSharedPhotos = []; // 원본 공유 사진 목록 (삭제 추적용)
        state.wantsToShare = false; // 공유를 원하는지 여부
        // 새 기록 시 비율은 전역 선택값 사용 (수정 시에는 아래에서 기존 기록값으로 덮어씀)
        state.recordPhotoAspectRatio = appState.recordPhotoAspectRatio || '1:1';
        
        const modalTitle = document.getElementById('modalTitle');
        if (modalTitle) {
            const slot = SLOTS.find(s => s.id === slotId);
            if (slot) {
                modalTitle.innerText = slot.label;
            }
        }
        
        // entryId가 있으면 저장된 태그 정보를 미리 저장
        let savedRecord = null;
        if (entryId) {
            savedRecord = window.mealHistory.find(m => m.id === entryId);
        }
        // 타임라인 DOM은 loadedDates로 갱신이 스킵될 수 있어, 카드의 id와 mealHistory가 어긋나면 빈 모달이 됨 → 단건 조회
        // App Check 토큰 지연 시 permission-denied → 토큰 갱신 후 1회 재시도
        if (entryId && !savedRecord && window.currentUser?.uid) {
            const ref = doc(db, 'artifacts', appId, 'users', window.currentUser.uid, 'meals', entryId);
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
                await refreshAppCheckTokenBeforeFirestore();
                const snap = await getDoc(ref);
                mergeRec(snap);
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
        }
        
        // 모든 칩의 active 클래스 제거 (renderEntryChips 전에)
        document.querySelectorAll('.chip, .sub-chip').forEach(el => el.classList.remove('active'));
        
        // 공유 인디케이터 숨기기
        const shareIndicator = document.getElementById('sharePhotoIndicator');
        if (shareIndicator) shareIndicator.classList.add('hidden');
        
        ['placeInput', 'menuDetailInput', 'withWhomInput', 'snackDetailInput', 'snackPlaceInput', 'deliveryVendorInput', 'generalCommentInput', 'snackCommentInput'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        
        // 카카오 검색 버튼 및 placeholder 초기화
        const placeInput = document.getElementById('placeInput');
        const snackPlaceInput = document.getElementById('snackPlaceInput');
        if (placeInput) {
            placeInput.placeholder = '돋보기 버튼으로 장소 검색 또는 직접 입력';
            placeInput.removeAttribute('data-kakao-place-id');
            placeInput.removeAttribute('data-kakao-place-address');
            placeInput.removeAttribute('data-kakao-place-data');
            placeInput.removeAttribute('data-kakao-place-name');
        }
        if (snackPlaceInput) {
            snackPlaceInput.placeholder = '돋보기 버튼으로 장소 검색 또는 직접 입력';
            snackPlaceInput.removeAttribute('data-kakao-place-id');
            snackPlaceInput.removeAttribute('data-kakao-place-address');
            snackPlaceInput.removeAttribute('data-kakao-place-data');
            snackPlaceInput.removeAttribute('data-kakao-place-name');
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
        if (mainPhotoContainer) mainPhotoContainer.innerHTML = "";
        if (snackPhotoContainer) snackPhotoContainer.innerHTML = "";
        
        const resetModalScrollTop = () => {
            const scrollArea = document.getElementById('modalScrollArea');
            if (!scrollArea) return;
            scrollArea.scrollTop = 0;
            if (typeof scrollArea.scrollTo === 'function') {
                scrollArea.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            }
        };
        // 모달 내부 스크롤 복원 이슈 대응: 즉시 + 다음 프레임 + 짧은 지연에 걸쳐 상단 고정
        resetModalScrollTop();
        
        ['restaurantSuggestions', 'menuSuggestions', 'peopleSuggestions', 'snackSuggestions'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add('no-scrollbar');
                el.classList.remove('scrollbar-hide');
            }
        });
        
        const slot = SLOTS.find(s => s.id === slotId);
        if (!slot) {
            console.error('슬롯을 찾을 수 없습니다:', slotId);
            return;
        }
        const isS = slot.type === 'snack';
        document.getElementById('optionalFields')?.classList.toggle('hidden', isS);
        const reviewSection = document.getElementById('reviewSection');
        const snackReviewSection = document.getElementById('snackReviewSection');
        if (reviewSection) {
            reviewSection.classList.toggle('hidden', isS);
        }
        if (snackReviewSection) {
            snackReviewSection.classList.toggle('hidden', !isS);
        }
        const entryMealTimeSectionMain = document.getElementById('entryMealTimeSectionMain');
        const entryMealTimeSectionSnack = document.getElementById('entryMealTimeSectionSnack');
        if (entryMealTimeSectionMain) entryMealTimeSectionMain.classList.toggle('hidden', isS);
        if (entryMealTimeSectionSnack) entryMealTimeSectionSnack.classList.toggle('hidden', !isS);
        document.getElementById('btnDelete')?.classList.add('hidden');
        const satietySection = document.getElementById('satietySection');
        if (satietySection) {
            satietySection.classList.toggle('hidden', isS);
        }
        
        // 필드 표시/숨김 처리를 먼저 수행 (renderPhotoPreviews가 올바른 컨테이너를 찾을 수 있도록)
        document.getElementById('mainMealFields')?.classList.toggle('hidden', isS);
        document.getElementById('snackFields')?.classList.toggle('hidden', !isS);
        
        updatePhotoAspectButtons();
        
        if (isS) {
            appState.selectedSnackPlaceMainTag = null;
        }
        
        // 필드 활성화 상태 초기화 (Skip이 아닌 경우 활성화)
        if (!isS) {
            toggleFieldsForSkip(false);
        }
        
        // 버튼 상태 설정 (게스트 모드 체크 포함)
        const btnSave = document.getElementById('btnSave');
        if (btnSave) {
            if (window.currentUser && window.currentUser.isAnonymous) {
                // 게스트 모드: 버튼 비활성화
                btnSave.disabled = true;
                btnSave.className = 'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-300 text-slate-500 text-base font-bold transition-colors cursor-not-allowed';
                btnSave.innerText = '로그인 후 사용할 수 있어요';
                btnSave.removeAttribute('title');
            } else if (
                entryId &&
                savedRecord &&
                isMealEntrySaveFailed(savedRecord)
            ) {
                btnSave.disabled = true;
                btnSave.className =
                    'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-400 text-white text-sm font-bold transition-colors cursor-not-allowed';
                btnSave.innerHTML =
                    '<span class="leading-tight text-center">서버 등록 후 수정 가능</span>';
                btnSave.title = '서버 등록 후 수정이 가능합니다';
            } else {
                // 일반 모드: 버튼 활성화 및 텍스트 설정
                btnSave.disabled = false;
                btnSave.className = 'flex-[1.7] flex flex-col items-center justify-center px-3 py-4 bg-slate-900 text-white text-base font-bold hover:bg-slate-800 active:bg-slate-800 transition-colors';
                btnSave.innerHTML = '<span>' + (entryId ? '수정 완료' : '기록 완료') + '</span>';
                delete btnSave.dataset.defaultHtml;
                btnSave.removeAttribute('title');
            }
        }
        
        // 칩 렌더링 (필드 표시/숨김 처리 후)
        renderEntryChips();
        
        if (entryId && savedRecord) {
            const r = savedRecord;
            if (r) {
                // photos가 배열인지 확인하고, 배열이 아니면 배열로 변환
                state.currentPhotos = Array.isArray(r.photos) ? r.photos : (r.photos ? [r.photos] : []);
                state.currentPhotoMeta = normalizePhotoMetaFromRecord(r.photoMeta, state.currentPhotos.length);
                // sharedPhotos도 배열인지 확인
                state.sharedPhotos = Array.isArray(r.sharedPhotos) ? r.sharedPhotos : (r.sharedPhotos ? [r.sharedPhotos] : []);
                state.originalSharedPhotos = Array.isArray(r.sharedPhotos) ? [...r.sharedPhotos] : (r.sharedPhotos ? [r.sharedPhotos] : []); // 원본 복사 (삭제 추적용)
                state.recordPhotoAspectRatio = (r.photoAspectRatio && PHOTO_ASPECT_OPTIONS.includes(r.photoAspectRatio)) ? r.photoAspectRatio : '1:1';
                
                // 공유 금지 체크
                const isShareBanned = r.shareBanned === true;
                if (isShareBanned) {
                    // 공유 금지된 경우 공유 상태를 false로 설정
                    state.wantsToShare = false;
                } else {
                    state.wantsToShare = (state.sharedPhotos && state.sharedPhotos.length > 0); // 이미 공유된 사진이 있으면 공유 상태로
                }
                
                // 필드 표시/숨김 처리 후에 renderPhotoPreviews 호출
                renderPhotoPreviews();
                // 공유 인디케이터 업데이트
                updateShareIndicator();
                setVal('placeInput', r.place || "");
                // 수정 시 기존 기록에 카카오맵 정보가 있으면 placeInput에 복원 (저장 시 유지)
                const _pi = document.getElementById('placeInput');
                if (_pi && (r.placeId || r.placeAddress || r.placeData)) {
                    if (r.placeId) _pi.setAttribute('data-kakao-place-id', r.placeId);
                    _pi.setAttribute('data-kakao-place-address', (r.placeAddress != null && r.placeAddress !== undefined) ? String(r.placeAddress) : '');
                    if (r.placeData && typeof r.placeData === 'object') _pi.setAttribute('data-kakao-place-data', JSON.stringify(r.placeData));
                    _pi.setAttribute('data-kakao-place-name', (r.placeData && r.placeData.name) || r.place || '');
                }
                setVal('menuDetailInput', r.menuDetail || "");
                setVal('deliveryVendorInput', (!isS ? (r.deliveryVendor || '') : ''));
                const _dvi = document.getElementById('deliveryVendorInput');
                if (!isS && _dvi && (r.deliveryPlaceId || r.deliveryPlaceAddress || r.deliveryPlaceData)) {
                    if (r.deliveryPlaceId) _dvi.setAttribute('data-kakao-place-id', r.deliveryPlaceId);
                    _dvi.setAttribute('data-kakao-place-address', (r.deliveryPlaceAddress != null && r.deliveryPlaceAddress !== undefined) ? String(r.deliveryPlaceAddress) : '');
                    if (r.deliveryPlaceData && typeof r.deliveryPlaceData === 'object') {
                        _dvi.setAttribute('data-kakao-place-data', JSON.stringify(r.deliveryPlaceData));
                    }
                    const dn = (r.deliveryPlaceData && r.deliveryPlaceData.name) || r.deliveryVendor || '';
                    _dvi.setAttribute('data-kakao-place-name', dn);
                }
                setVal('withWhomInput', (!isS ? (r.withWhomDetail || "") : ""));
                setVal('snackWithWhomInput', (isS ? (r.withWhomDetail || "") : ""));
                setVal('snackDetailInput', r.menuDetail || "");
                setVal('snackPlaceInput', r.place || "");
                // 간식 수정 시 카카오맵 정보가 있으면 snackPlaceInput에 복원
                const _spi = document.getElementById('snackPlaceInput');
                if (isS && _spi && (r.placeId || r.placeAddress || r.placeData)) {
                    if (r.placeId) _spi.setAttribute('data-kakao-place-id', r.placeId);
                    _spi.setAttribute('data-kakao-place-address', (r.placeAddress != null && r.placeAddress !== undefined) ? String(r.placeAddress) : '');
                    if (r.placeData && typeof r.placeData === 'object') _spi.setAttribute('data-kakao-place-data', JSON.stringify(r.placeData));
                    _spi.setAttribute('data-kakao-place-name', (r.placeData && r.placeData.name) || r.place || '');
                }
                setVal('generalCommentInput', r.comment || "");
                setVal('snackCommentInput', r.comment || "");
                
                const rn = r.rating != null && r.rating !== '' ? Number(r.rating) : NaN;
                const sn = r.satiety != null && r.satiety !== '' ? Number(r.satiety) : NaN;
                window.setRating(Number.isFinite(rn) ? rn : 3);
                window.setSatiety(Number.isFinite(sn) ? sn : 3);
                
                // 공유 인디케이터 표시
                updateShareIndicator();

                // meal 문서에는 sharedPhotos가 있는데 sharedPhotos 컬렉션(모먼트)에 없으면 동기화 시도
                if (r.id && r.sharedPhotos && Array.isArray(r.sharedPhotos) && r.sharedPhotos.length > 0 && !r.shareBanned) {
                    const inSharedColl = window.sharedPhotos?.some?.(p => p.entryId === r.id);
                    if (!inSharedColl) {
                        dbOps.sharePhotos(r.sharedPhotos, r).then(() => {
                            if (!window.sharedPhotos) window.sharedPhotos = [];
                            const newEntries = r.sharedPhotos.map(url => ({ entryId: r.id, photoUrl: url, userId: window.currentUser?.uid }));
                            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== r.id).concat(newEntries);
                            updateTimelineShareIndicators();
                            if (appState.currentTab === 'gallery') renderGallery();
                            showToast('모먼트에 반영되었습니다.', 'success');
                        }).catch((e) => {
                            console.warn('모먼트 동기화 실패 (무시):', e);
                        });
                    }
                }

                // 태그 활성화 처리 함수
                const activateTags = () => {
                    // 식사 방식 (mealType)
                    if (r.mealType) {
                        const typeChips = document.getElementById('typeChips');
                        if (typeChips) {
                            typeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.mealType.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 메뉴 카테고리 (category)
                    if (r.category) {
                        const categoryChips = document.getElementById('categoryChips');
                        if (categoryChips) {
                            categoryChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.category.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 함께한 사람 (withWhom)
                    if (r.withWhom) {
                        const chipId = isS ? 'snackWithChips' : 'withChips';
                        const withChips = document.getElementById(chipId);
                        if (withChips) {
                            withChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.withWhom.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 간식 타입 (snackType)
                    if (r.snackType) {
                        const snackTypeChips = document.getElementById('snackTypeChips');
                        if (snackTypeChips) {
                            snackTypeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.snackType.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 간식 어디서 (snackPlace): 메인칩 선택 시 개별 추천 표시
                    if (isS && r.place) {
                        const snackPlaceMain = window.userSettings?.tags?.snackPlaceMain || ['집', '사무실', '카페'];
                        if (snackPlaceMain.includes(r.place.trim())) {
                            appState.selectedSnackPlaceMainTag = r.place.trim();
                            const subTags = window.userSettings?.subTags?.place || [];
                            window.renderSecondary('snackPlaceSuggestions', subTags, 'snackPlaceInput', r.place.trim(), 'place');
                        }
                        const snackPlaceTypeChips = document.getElementById('snackPlaceTypeChips');
                        if (snackPlaceTypeChips) {
                            snackPlaceTypeChips.querySelectorAll('button.chip').forEach(ch => {
                                if (ch.innerText.trim() === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                        const snackPlaceSuggestions = document.getElementById('snackPlaceSuggestions');
                        if (snackPlaceSuggestions) {
                            snackPlaceSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim().replace(/\s*★\s*$/, '') === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 장소 (place) - sub-chip (본식)
                    if (r.place) {
                        const restaurantSuggestions = document.getElementById('restaurantSuggestions');
                        if (restaurantSuggestions) {
                            restaurantSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                if (ch.innerText.trim() === r.place.trim()) {
                                    ch.classList.add('active');
                                }
                            });
                        }
                    }
                    
                    // 메뉴 상세 (본식 menuDetail) - sub-chip (다중 선택 가능, 쉼표로 구분)
                    if (!isS && r.menuDetail) {
                        const menuSuggestions = document.getElementById('menuSuggestions');
                        const menuDetailInput = document.getElementById('menuDetailInput');
                        if (menuSuggestions && menuDetailInput) {
                            // 쉼표로 구분된 여러 값 처리
                            const detailValues = r.menuDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            menuSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            // input에 선택된 값들 저장
                            if (activeValues.length > 0) {
                                menuDetailInput.value = activeValues.join(', ');
                            } else {
                                // 자주 사용한 태그에 없는 경우 입력값 그대로 표시
                                menuDetailInput.value = r.menuDetail;
                            }
                        }
                    }
                    // 간식 무엇을 (menuDetail → snackDetailInput / snackSuggestions)
                    if (isS && r.menuDetail) {
                        const snackSuggestions = document.getElementById('snackSuggestions');
                        const snackDetailInput = document.getElementById('snackDetailInput');
                        if (snackSuggestions && snackDetailInput) {
                            const detailValues = r.menuDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            snackSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            if (activeValues.length > 0) {
                                snackDetailInput.value = activeValues.join(', ');
                            } else {
                                snackDetailInput.value = r.menuDetail;
                            }
                        }
                    }
                    
                    // 함께한 사람 상세 (본식 withWhomDetail) - sub-chip (다중 선택 가능)
                    if (!isS && r.withWhomDetail) {
                        const peopleSuggestions = document.getElementById('peopleSuggestions');
                        const withWhomInput = document.getElementById('withWhomInput');
                        if (peopleSuggestions && withWhomInput) {
                            // 쉼표로 구분된 여러 값 처리
                            const detailValues = r.withWhomDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            peopleSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            // input에 선택된 값들 저장
                            if (activeValues.length > 0) {
                                withWhomInput.value = activeValues.join(', ');
                            }
                        }
                    }
                    // 간식 누구와 상세 (snackPeopleSuggestions)
                    if (isS && r.withWhomDetail) {
                        const snackPeopleSuggestions = document.getElementById('snackPeopleSuggestions');
                        const snackWithWhomInput = document.getElementById('snackWithWhomInput');
                        if (snackPeopleSuggestions && snackWithWhomInput) {
                            const detailValues = r.withWhomDetail.split(',').map(v => v.trim()).filter(v => v);
                            const activeValues = [];
                            snackPeopleSuggestions.querySelectorAll('button.sub-chip').forEach(ch => {
                                const chipText = ch.innerText.trim();
                                if (detailValues.includes(chipText)) {
                                    ch.classList.add('active');
                                    activeValues.push(chipText);
                                }
                            });
                            if (activeValues.length > 0) {
                                snackWithWhomInput.value = activeValues.join(', ');
                            }
                        }
                    }
                };
                
                // DOM 렌더링 완료 후 태그 활성화 (여러 번 시도)
                const tryActivateTags = (attempts = 0) => {
                    if (attempts > 20) {
                        console.warn('태그 활성화 실패: 최대 시도 횟수 초과');
                        return;
                    }
                    
                    requestAnimationFrame(() => {
                        const typeChips = document.getElementById('typeChips');
                        const hasChips = typeChips && typeChips.querySelectorAll('button.chip').length > 0;
                        
                        if (hasChips || attempts > 10) {
                            activateTags();
                            // sub-chip은 나중에 렌더링될 수 있으므로 여러 번 재시도
                            setTimeout(() => {
                                activateTags();
                                setTimeout(() => {
                                    activateTags();
                                    syncDeliveryVendorSectionVisibility();
                                }, 100);
                            }, 100);
                        } else {
                            setTimeout(() => tryActivateTags(attempts + 1), 50);
                        }
                    });
                };
                
                // 즉시 한 번 시도하고, 그 다음 재시도
                setTimeout(() => tryActivateTags(), 50);
                
                // Skip 선택 시 필드 숨기기 처리
                if (r.mealType === 'Skip' || r.mealType === '건너뜀') {
                    setTimeout(() => {
                        toggleFieldsForSkip(true);
                    }, 100);
                }
                
                // 간식 타입 선택 시 추천 태그 업데이트
                if (isS && r.snackType) {
                    const subTags = window.userSettings.subTags.snack || [];
                    window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', r.snackType, 'snack');
                }
                // 간식 어디서: place가 메인태그에 있으면 선택 상태로 추천 표시
                if (isS && r.place) {
                    const snackPlaceMain = window.userSettings?.tags?.snackPlaceMain || ['집', '사무실', '카페'];
                    if (snackPlaceMain.includes(r.place.trim())) {
                        appState.selectedSnackPlaceMainTag = r.place.trim();
                        const subTags = window.userSettings?.subTags?.place || [];
                        window.renderSecondary('snackPlaceSuggestions', subTags, 'snackPlaceInput', r.place.trim(), 'place');
                    }
                }
                
            }
        } else {
            window.setRating(3);
            window.setSatiety(3);
        }

        if (entryId && window.currentUser && !window.currentUser.isAnonymous && !isDemoUser(window.currentUser)) {
            document.getElementById('btnDelete')?.classList.remove('hidden');
        }
        
        // 간식 모드일 때 초기 추천 태그 표시
        if (isS) {
            // 필드가 보이는 상태로 만든 후 추천 태그 표시
            const snackFields = document.getElementById('snackFields');
            if (snackFields) snackFields.classList.remove('hidden');
            
            const subTags = window.userSettings.subTags.snack || [];
            const snackType = document.querySelector('#snackTypeChips button.active')?.innerText;
            window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', snackType || null, 'snack');
        } else {
            /** 신규 기록만 즉시 동기화. 수정 모드는 tryActivateTags 끝에서 sync(배달 식당 필드 복원 후)하므로,
             * 여기서 먼저 호출하면 칩이 아직 '배달/포장'이 아니어서 deliveryVendorInput 이 비워짐 */
            if (!(entryId && savedRecord)) {
                setTimeout(() => syncDeliveryVendorSectionVisibility(), 0);
            }
        }
        
        // 입력 필드에 이벤트 리스너 추가 (간식 입력 시 추천 태그 업데이트)
        // 조합(composition) 중에는 DOM 업데이트 지연 → 한글 IME 모바일 텍스트 미표시 이슈 방지
        const snackDetailInput = document.getElementById('snackDetailInput');
        if (snackDetailInput) {
            if (snackDetailInput._snackCompositionInit) {
                // 이미 초기화됨 (모달 재오픈 시 중복 방지)
            } else {
                const updateSnackSuggestions = () => {
                    const subTags = window.userSettings.subTags.snack || [];
                    const snackType = document.querySelector('#snackTypeChips button.active')?.innerText;
                    window.renderSecondary('snackSuggestions', subTags, 'snackDetailInput', snackType || null, 'snack');
                };
                addCompositionAwareInput(snackDetailInput, updateSnackSuggestions);
                snackDetailInput._snackCompositionInit = true;
            }
        }
        
        initEntryModalGaugeControlsOnce();
        finalizeEntryModalGauges(entryId && savedRecord ? savedRecord : null, isS);
        finalizeEntryMealClock(entryId && savedRecord ? savedRecord : null, isS);
        seedEntryMealClockOnModalOpenAfterFinalize(entryId, isS);

        const entryModal = document.getElementById('entryModal');
        if (entryModal) {
            setEntryModalSavingState(false);
            lockBodyScroll();
            entryModal.classList.remove('hidden');
            window.__entryModalOpenGeneration = (window.__entryModalOpenGeneration || 0) + 1;
            entryModal.classList.remove('keyboard-open');
            entryModal.style.height = '';
            entryModal.style.top = '';
            resetModalScrollTop();
            requestAnimationFrame(resetModalScrollTop);
            setTimeout(resetModalScrollTop, 60);
            initEntryModalKeyboardHandling(entryModal);
            if (typeof entryModal.setKeyboardBaseline === 'function') {
                entryModal.setKeyboardBaseline();
            }
            syncEntryModalBodyClass();
            // 휠 다이얼 초기 스냅(모달이 실제로 열린 뒤에 한 번 더 맞춤)
            setTimeout(() => {
                try {
                    window.setRating?.(appState.currentRating || 3);
                    window.setSatiety?.(appState.currentSatiety || 3);
                    applyEntryGaugeDialUi();
                } catch (_) {}
            }, 0);
        } else {
            console.error('entryModal 요소를 찾을 수 없습니다.');
        }
    } catch (error) {
        console.error('openModal 오류:', error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

export function closeModal() {
    if (document.getElementById('entryModal')?.classList.contains('entry-modal-saving')) return;
    closeTimeSourceSheets();
    const entryModal = document.getElementById('entryModal');
    if (entryModal) {
        setEntryModalSavingState(false);
        entryModal.classList.remove('keyboard-open');
        entryModal.style.height = '';
        entryModal.style.top = '';
        entryModal.classList.add('hidden');
        unlockBodyScroll();
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
        state.currentPhotoMeta = [];
        state.entryMealClockSourceMain = null;
        state.entryMealClockSourceSnack = null;
        state.sharedPhotos = [];
        state.originalSharedPhotos = [];
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

function refreshTimelineAfterMealSaveResult() {
    try {
        /* renderTimeline 끝에서 updateTimelineMealEntryPendingIndicators 호출 — 먼저 DOM 전체를 그린 뒤 패치 */
        if (appState.currentTab === 'timeline') {
            renderTimeline();
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
        refreshTimelineAfterMealSaveResult();
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
        
        const getT = (id) => document.getElementById(id)?.querySelector('.chip.active')?.innerText || '';
        const slot = SLOTS.find(s => s.id === state.currentEditingSlotId);
        if (!slot) {
            console.error('저장 실패: 슬롯을 찾을 수 없습니다.', state.currentEditingSlotId);
            showToast("저장할 정보가 없습니다.", 'error');
            if (loadingOverlay) loadingOverlay.classList.add('hidden');
            return;
        }
        const isS = slot.type === 'snack';
        const mealType = getT('typeChips');
        const isSk = mealType === 'Skip' || mealType === '건너뜀';
        mergeActiveSubChipsIntoInputs();
        const placeInputVal = document.getElementById('placeInput')?.value || '';
        const menuInputVal = document.getElementById('menuDetailInput')?.value || '';
        const withInputVal = document.getElementById('withWhomInput')?.value || '';
        const snackWithInputVal = document.getElementById('snackWithWhomInput')?.value || '';
        
        // 간식 입력값 가져오기 (hidden 상태여도 값을 가져올 수 있음)
        const snackDetailInput = document.getElementById('snackDetailInput');
        const snackInputVal = snackDetailInput ? snackDetailInput.value.trim() : '';
        const snackPlaceInputVal = document.getElementById('snackPlaceInput')?.value?.trim() || '';
        const deliveryVendorEl = document.getElementById('deliveryVendorInput');
        const deliveryVendorVal = (!isS && !isSk && mealType === '배달/포장' && deliveryVendorEl)
            ? deliveryVendorEl.value.trim()
            : '';

        // 입력 검증: 어떻게/무엇을/누구와 중 최소 1개는 필요 (무응답 시 저장하지 않음)
        // - 본식: 어떻게(typeChips) / 무엇을(categoryChips 또는 menuDetailInput) / 누구와(withChips 또는 withWhomInput)
        // - 간식: 무엇을(snackTypeChips 또는 snackDetailInput) / 누구와(snackWithChips 또는 snackWithWhomInput)
        if (!isSk) {
            const hasHow = !isS && Boolean((mealType || '').trim());
            const hasWhat = isS
                ? Boolean(
                      (getT('snackTypeChips') || '').trim() ||
                          (snackInputVal || '').trim() ||
                          collectActiveSubChipLabels('snackSuggestions').length
                  )
                : Boolean(
                      (getT('categoryChips') || '').trim() ||
                          (menuInputVal || '').trim() ||
                          collectActiveSubChipLabels('menuSuggestions').length
                  );
            const hasWith = isS
                ? Boolean(
                      (getT('snackWithChips') || '').trim() ||
                          (snackWithInputVal || '').trim() ||
                          collectActiveSubChipLabels('snackPeopleSuggestions').length
                  )
                : Boolean(
                      (getT('withChips') || '').trim() ||
                          (withInputVal || '').trim() ||
                          collectActiveSubChipLabels('peopleSuggestions').length
                  );
            if (!hasHow && !hasWhat && !hasWith) {
                if (loadingOverlay) loadingOverlay.classList.add('hidden');
                return;
            }
        }

        // 메인 칩 미선택 + (해당 축) 입력·서브칩만 있으면 → 분석·집계는「기타」
        const categoryChip = getT('categoryChips');
        const withChipBase = isS ? getT('snackWithChips') : getT('withChips');
        const snackTypeChip = getT('snackTypeChips');
        const hasMenuSub = collectActiveSubChipLabels('menuSuggestions').length > 0;
        const hasPeopleSubMain = collectActiveSubChipLabels(isS ? 'snackPeopleSuggestions' : 'peopleSuggestions').length > 0;
        const hasSnackSub = collectActiveSubChipLabels('snackSuggestions').length > 0;
        const hasRestaurantSub = !isS ? collectActiveSubChipLabels('restaurantSuggestions').length > 0 : 0;
        const hasSnackPlaceSub = isS ? collectActiveSubChipLabels('snackPlaceSuggestions').length > 0 : 0;

        let mealTypeResolved = mealType;
        if (!isS && !isSk && !(mealType || '').trim()) {
            const hasAnyHowAxis =
                (placeInputVal || '').trim() ||
                hasRestaurantSub ||
                (menuInputVal || '').trim() ||
                hasMenuSub ||
                (withInputVal || '').trim() ||
                hasPeopleSubMain;
            if (hasAnyHowAxis) mealTypeResolved = '기타';
        }
        let categoryResolved = categoryChip;
        if (!isS && !isSk && !(categoryChip || '').trim() && ((menuInputVal || '').trim() || hasMenuSub)) {
            categoryResolved = '기타';
        }
        let withWhomResolved = withChipBase;
        if (!isSk && !(withChipBase || '').trim() && (((isS ? snackWithInputVal : withInputVal) || '').trim() || hasPeopleSubMain)) {
            withWhomResolved = '기타';
        }
        let snackTypeResolved = snackTypeChip;
        if (isS && !(snackTypeChip || '').trim()) {
            const hasSnackAnyAxis =
                (snackInputVal || '').trim() ||
                hasSnackSub ||
                (snackWithInputVal || '').trim() ||
                hasPeopleSubMain ||
                (snackPlaceInputVal || '').trim() ||
                hasSnackPlaceSub;
            if (hasSnackAnyAxis) snackTypeResolved = '기타';
        }
        const selectedSnackPlaceMain = appState.selectedSnackPlaceMainTag || null;
        let snackPlaceMainResolved = '';
        if (isS && !isSk) {
            const hasPlaceBody = (snackPlaceInputVal || '').trim() || hasSnackPlaceSub;
            snackPlaceMainResolved = selectedSnackPlaceMain || (hasPlaceBody ? '기타' : '');
        }
        
        // 디버깅: 간식 입력값 확인
        if (isS) {
            console.log('간식 저장 시도:', {
                isS,
                snackInputVal,
                snackDetailInput: snackDetailInput ? 'found' : 'not found',
                snackInputElementValue: snackDetailInput?.value,
                snackFieldsVisible: !document.getElementById('snackFields')?.classList.contains('hidden')
            });
        }
        
        const newSettings = JSON.parse(JSON.stringify(window.userSettings));
        if (!newSettings.subTags) newSettings.subTags = JSON.parse(JSON.stringify(DEFAULT_SUB_TAGS));
        
        // subTags의 각 배열이 정의되어 있는지 확인
        if (!newSettings.subTags.place) newSettings.subTags.place = [];
        if (!newSettings.subTags.menu) newSettings.subTags.menu = [];
        if (!newSettings.subTags.people) newSettings.subTags.people = [];
        if (!newSettings.subTags.snack) newSettings.subTags.snack = [];
        
        let tagsChanged = false;
        if (placeInputVal && !newSettings.subTags.place.find(t => (t.text || t) === placeInputVal)) {
            newSettings.subTags.place.push({ text: placeInputVal, parent: mealTypeResolved });
            tagsChanged = true;
        }
        if (isS && snackPlaceInputVal && !newSettings.subTags.place.find(t => (t.text || t) === snackPlaceInputVal)) {
            newSettings.subTags.place.push({ text: snackPlaceInputVal, parent: snackPlaceMainResolved || snackPlaceInputVal });
            tagsChanged = true;
        }
        // 메뉴 상세 태그는 다중 선택 가능 (쉼표로 구분)
        if (menuInputVal) {
            const menuValues = menuInputVal.split(',').map(v => v.trim()).filter(v => v);
            menuValues.forEach(val => {
                if (!newSettings.subTags.menu.find(t => (t.text || t) === val)) {
                    newSettings.subTags.menu.push({ text: val, parent: categoryResolved });
                    tagsChanged = true;
                }
            });
        }
        // 함께한 사람 상세 태그는 다중 선택 가능 (쉼표로 구분)
        const withInputValToSave = isS ? snackWithInputVal : withInputVal;
        if (withInputValToSave) {
            const withValues = withInputValToSave.split(',').map(v => v.trim()).filter(v => v);
            withValues.forEach(val => {
                if (!newSettings.subTags.people.find(t => (t.text || t) === val)) {
                    newSettings.subTags.people.push({ text: val, parent: withWhomResolved });
                    tagsChanged = true;
                }
            });
        }
        if (isS && snackInputVal) {
            const snackVals = snackInputVal.split(',').map((v) => v.trim()).filter((v) => v);
            snackVals.forEach((val) => {
                if (!newSettings.subTags.snack.find((t) => (t.text || t) === val)) {
                    newSettings.subTags.snack.push({ text: val, parent: snackTypeResolved });
                    tagsChanged = true;
                }
            });
        }
        
        if (tagsChanged) {
            window.userSettings = newSettings;
            // 디바운싱: 1초 내 여러 태그 변경을 묶어서 한 번만 저장
            clearTimeout(settingsSaveTimeout);
            settingsSaveTimeout = setTimeout(async () => {
                try {
                    await dbOps.saveSettings(window.userSettings);
                    console.log('디바운싱된 설정 저장 완료');
                } catch (e) {
                    console.error('설정 저장 실패:', e);
                    // dbOps.saveSettings에서 이미 에러 토스트를 표시하므로 여기서는 로그만
                }
            }, 1000);
        }
        
        // main 끼니: 동일 (date, slotId)에 이미 기록이 있으면 수정 모드로 전환 (중복 방지)
        let idToUse = state.currentEditingId;
        if (!idToUse && !isS && state.currentEditingDate && state.currentEditingSlotId && window.mealHistory?.length > 0) {
            const existing = window.mealHistory.find(m =>
                m.date === state.currentEditingDate &&
                m.slotId === state.currentEditingSlotId &&
                ['morning', 'lunch', 'dinner'].includes(m.slotId)
            );
            if (existing) idToUse = existing.id;
        }
        // 기존 기록에서 shareBanned 필드 가져오기 (수정 시 유지)
        const existingRecord = idToUse ? window.mealHistory.find(m => m.id === idToUse) : null;
        const shareBanned = existingRecord?.shareBanned === true;
        
        // 카카오맵 API로 입력된 장소 정보 확인 (식사: placeInput, 간식: snackPlaceInput)
        const placeInput = document.getElementById('placeInput');
        const snackPlaceInput = document.getElementById('snackPlaceInput');
        const kakaoSourceInput = isS ? snackPlaceInput : placeInput;
        const kakaoPlaceId = kakaoSourceInput?.getAttribute('data-kakao-place-id');
        const kakaoPlaceAddress = kakaoSourceInput?.getAttribute('data-kakao-place-address');
        const kakaoPlaceData = kakaoSourceInput?.getAttribute('data-kakao-place-data');
        const kakaoPlaceName = kakaoSourceInput?.getAttribute('data-kakao-place-name') || '';
        const placeValForKakao = isS ? snackPlaceInputVal : placeInputVal;
        // 카카오에서 선택한 장소명을 수정한 경우: 주소·placeId를 저장하지 않음 (잘못된 주소 매칭 방지)
        const nameMatches = !kakaoPlaceName || (String(placeValForKakao || '').trim() === String(kakaoPlaceName).trim());
        const shouldUseKakaoFields = kakaoPlaceId && !isSk && nameMatches;

        let shouldUseDeliveryKakao = false;
        let deliveryKakaoPlaceId = '';
        let deliveryKakaoPlaceAddress = '';
        let deliveryKakaoPlaceDataStr = '';
        if (!isS && !isSk && mealType === '배달/포장' && deliveryVendorEl) {
            const dvId = deliveryVendorEl.getAttribute('data-kakao-place-id');
            const dvName = deliveryVendorEl.getAttribute('data-kakao-place-name') || '';
            const dvNameMatches = !dvName || (String(deliveryVendorVal || '').trim() === String(dvName).trim());
            if (dvId && dvNameMatches) {
                shouldUseDeliveryKakao = true;
                deliveryKakaoPlaceId = dvId;
                deliveryKakaoPlaceAddress = deliveryVendorEl.getAttribute('data-kakao-place-address') || '';
                deliveryKakaoPlaceDataStr = deliveryVendorEl.getAttribute('data-kakao-place-data') || '';
            }
        }

        const sourcePhotos = Array.isArray(state.currentPhotos) ? [...state.currentPhotos] : [];
        const sourcePhotoMeta = syncPhotoMetaLength(state.currentPhotoMeta, sourcePhotos.length);
        /** 아직 Storage에 없는 로컬 이미지(data URL 또는 일부 환경의 blob URL) */
        const isLocalPendingPhoto = (photo) =>
            typeof photo === 'string' &&
            photo &&
            (photo.startsWith('data:image') || photo.startsWith('blob:'));
        const existingPhotoUrls = sourcePhotos.filter(
            (photo) => typeof photo === 'string' && photo && !isLocalPendingPhoto(photo)
        );

        const rateOn = isS
            ? appState.entryGaugeRatingOnSnack === true
            : appState.entryGaugeRatingOnMain === true;
        const satOn = isS
            ? appState.entryGaugeSatietyOnSnack === true
            : appState.entryGaugeSatietyOnMain === true;
        const timeOn = !isSk && (isS ? appState.entryTimeOnSnack === true : appState.entryTimeOnMain === true);
        /** getMealClock24FromModal(isMain) — 간식이 아닐 때 본식 입력, 간식일 때 간식 입력을 읽음 */
        const normalizedClock = timeOn ? getMealClock24FromModal(!isS) : '';
        const mealClockVal = !isSk && timeOn ? (normalizedClock || null) : null;
        const nowLocaleTime = () =>
            new Date().toLocaleTimeString('ko-KR', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        let timeSortStr = nowLocaleTime();
        if (!isSk && timeOn && normalizedClock) {
            timeSortStr = `${normalizedClock}:00`;
        }
        const record = {
            id: idToUse,
            date: state.currentEditingDate,
            slotId: state.currentEditingSlotId,
            mealType: mealTypeResolved,
            withWhom: withWhomResolved,
            withWhomDetail: isSk ? '' : (isS ? snackWithInputVal : withInputVal),
            category: categoryResolved,
            placeType: '',
            snackType: snackTypeResolved,
            photoAspectRatio: state.recordPhotoAspectRatio || '1:1',
            // Firestore에는 URL만 저장하고, base64는 저장 직후 Storage로 업로드 후 치환한다.
            photos: existingPhotoUrls,
            photoMeta: sourcePhotoMeta,
            menuDetail: isSk ? '' : (isS ? snackInputVal : menuInputVal),
            place: isSk ? '' : (isS ? (snackPlaceInputVal || appState.selectedSnackPlaceMainTag || '') : placeInputVal),
            comment: isSk ? '' : (isS ? (document.getElementById('snackCommentInput')?.value || '') : (document.getElementById('generalCommentInput')?.value || '')),
            rating: isSk ? null : (rateOn ? state.currentRating : null),
            satiety: isSk ? null : (satOn ? state.currentSatiety : null),
            mealClock: mealClockVal,
            // 분 단위만 쓰면 같은 슬롯·같은 분 간식이 정렬·뒷번호(간식1,2…)에서 뒤섞일 수 있어 초 포함
            time: timeSortStr,
        };
        if (!idToUse) {
            record.recordedAt = new Date().toISOString();
        } else if (existingRecord?.recordedAt) {
            record.recordedAt = existingRecord.recordedAt;
        }
        if (isS && !isSk && snackPlaceMainResolved) {
            record.snackPlaceMain = snackPlaceMainResolved;
        }

        if (!isS && !isSk && mealType === '배달/포장') {
            record.deliveryVendor = deliveryVendorVal;
            if (shouldUseDeliveryKakao) {
                record.deliveryPlaceId = deliveryKakaoPlaceId;
                record.deliveryPlaceAddress = deliveryKakaoPlaceAddress || '';
                record.deliveryKakaoPlace = true;
                if (deliveryKakaoPlaceDataStr) {
                    try {
                        record.deliveryPlaceData = JSON.parse(deliveryKakaoPlaceDataStr);
                    } catch (_) {
                        record.deliveryPlaceData = null;
                    }
                } else {
                    record.deliveryPlaceData = null;
                }
            } else {
                record.deliveryPlaceId = '';
                record.deliveryPlaceAddress = '';
                record.deliveryPlaceData = null;
                record.deliveryKakaoPlace = false;
            }
        } else {
            record.deliveryVendor = '';
            record.deliveryPlaceId = '';
            record.deliveryPlaceAddress = '';
            record.deliveryPlaceData = null;
            record.deliveryKakaoPlace = false;
        }
        
        // 카카오맵 API로 입력된 식당인 경우 추가 정보 저장 (선택한 장소명을 수정한 경우는 제외 → 잘못된 주소 매칭 방지)
        if (shouldUseKakaoFields) {
            record.placeId = kakaoPlaceId;
            record.kakaoPlaceId = kakaoPlaceId;
            record.placeAddress = kakaoPlaceAddress || '';
            if (kakaoPlaceData) {
                try {
                    record.placeData = JSON.parse(kakaoPlaceData);
                } catch (e) {
                    console.warn('카카오 장소 데이터 파싱 실패:', e);
                }
            }
            record.kakaoPlace = true; // 카카오맵으로 입력된 식당임을 표시
        }
        
        // shareBanned 필드 추가 (기존 값 유지)
        if (shareBanned) {
            record.shareBanned = true;
        }
        
        // 디버깅: 저장될 record 확인
        if (isS) {
            console.log('저장될 간식 record:', record);
        }
        
        // 공유 금지 체크
        const isShareBanned = record.id ? (window.mealHistory.find(m => m.id === record.id)?.shareBanned === true) : false;
        
        // 상태 초기화 전에 공유 의사를 보존한다. (수정 저장 + 사진 업로드 시 필요)
        const wantsToShare = Boolean(state.wantsToShare);
        
        // 공유할 사진 목록 결정 (단순화: wantsToShare와 currentPhotos만 사용)
        let photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
            ? [...existingPhotoUrls]    // 공유 활성화: 현재 URL 사진 전체
            : [];                        // 공유 비활성화 또는 금지: 빈 배열
        
        // record에 sharedPhotos 필드 추가
        record.sharedPhotos = photosToShare;
        
        console.log('저장 시작:', record);

        // 진행 상태: 모달은 열린 채 저장 UI + 타임라인 슬롯 인라인 스피너
        saveStartedUnderModalGen =
            typeof window.__entryModalOpenGeneration === 'number' ? window.__entryModalOpenGeneration : 0;
        setEntryModalSavingState(true);

        // 현재 탭과 편집 날짜를 미리 저장 (상태 초기화 전에)
        const currentTab = state.currentTab;
        const editingDate = state.currentEditingDate;
        
        // 서버 저장 전 UI를 먼저 갱신하기 위한 낙관 반영용 임시 레코드
        const wasNewRecord = !record.id;
        const optimisticTempId = wasNewRecord ? `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : null;
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
        if (optimisticTempId) markMealOptimisticSavePending(optimisticTempId);
        if (record.id && !wasNewRecord) {
            clearMealEntryServerSynced(record.id);
            markMealEntrySaveInFlight(record.id);
        }
        const applyOptimisticMealRecord = () => {
            if (!window.mealHistory || !Array.isArray(window.mealHistory) || !optimisticRecord.id) return;
            const byId = window.mealHistory.findIndex(m => m.id === optimisticRecord.id);
            if (byId >= 0) {
                window.mealHistory[byId] = optimisticRecord;
            } else if (!record.id && !isS) {
                // main 끼니 신규 등록은 같은 날짜/슬롯 카드 교체
                const sameSlot = window.mealHistory.findIndex(m => m.date === optimisticRecord.date && m.slotId === optimisticRecord.slotId);
                if (sameSlot >= 0) window.mealHistory[sameSlot] = optimisticRecord;
                else window.mealHistory.push(optimisticRecord);
            } else {
                window.mealHistory.push(optimisticRecord);
            }
            window.mealHistory.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.time || '').localeCompare(a.time || ''));
        };
        applyOptimisticMealRecord();
        // 공유 아이콘도 서버 반영 전에 즉시 낙관 반영
        if (optimisticRecord.id && !isShareBanned) {
            if (!window.sharedPhotos || !Array.isArray(window.sharedPhotos)) window.sharedPhotos = [];
            if (wantsToShare) {
                const optimisticShared = (sourcePhotos.length > 0 ? sourcePhotos : ['']).map(url => ({
                    entryId: optimisticRecord.id,
                    photoUrl: url || '',
                    userId: window.currentUser?.uid
                }));
                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== optimisticRecord.id).concat(optimisticShared);
            } else {
                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== optimisticRecord.id);
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
                renderTimeline();
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
        
        // 공유 상태 변경 여부 추적 변수 (함수 스코프)
        // 상태 초기화 전에 originalSharedPhotos 확인
        const hadSharedPhotos = state.originalSharedPhotos && state.originalSharedPhotos.length > 0;
        let sharedPhotosUpdated = false;

        // 저장 실행 (모달 열린 채, 타임라인에 인라인 스피너 표시)
        // 새 레코드인 경우 ID를 먼저 확보해야 공유 시 entryId를 올바르게 설정할 수 있음
        const SAVE_FIRESTORE_TIMEOUT_MS = 10000;
        /** 사진 N장 Storage + 재저장 상한 — grace 칩 전환(30초)과 동일 티밍 요청에 맞춤 */
        const MEAL_PHOTO_UPLOAD_PHASE_TIMEOUT_MS = 30000;
        /** 사진 Storage 업로드 실패·타임아웃 시에도 아래 '저장 완료' 병합이 성공으로 덮어쓰지 않도록 */
        let photoUploadPhaseFailed = false;
        try {
            const saveResult = unwrapMealSaveResult(
                await saveWithTimeout(() => dbOps.save(record, true), {
                    timeoutMs: SAVE_FIRESTORE_TIMEOUT_MS,
                    onTimeout: () => {
                        const mid = record.id || optimisticTempId;
                        if (mid) getMealSyncManager().onSaveUiTimedOut(String(mid), optimisticTempId);
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
            if (wasNewRecord && optimisticTempId && savedId && window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                window.sharedPhotos = window.sharedPhotos.map(p => (
                    p.entryId === optimisticTempId ? { ...p, entryId: savedId } : p
                ));
                updateTimelineShareIndicators();
            }

            if (isMealActionEffectiveOffline() && effectiveMealId) {
                void import('../utils/mealog-offline-ui.js').then((m) => {
                    try {
                        if (typeof m.markMealOfflineDraftForRecord === 'function') {
                            m.markMealOfflineDraftForRecord(effectiveMealId);
                        }
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
                });
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
                    renderTimeline();
                } catch (e) {
                    console.warn('저장 직후 타임라인 갱신:', e);
                }
            }
            /* DevTools/웹뷰에서 onLine 갱신이 한 틱 늦는 경우 보정 — 실제 오프라인·강제 오프라인이면 inFlight 유지(등록예정 칩) */
            queueMicrotask(() => {
                if (isMealActionEffectiveOffline()) return;
                try {
                    applyOfflineAfterLocalSaveUi(effectiveMealId, optimisticTempId, record.date, currentTab);
                } catch (_) {
                    /* ignore */
                }
            });

            // 새로 추가한 base64 사진은 문서 ID 확보 후 Storage 업로드 -> URL로 record.photos 치환
            // 오프라인 등으로 업로드·재저장이 끝없이 대기하면 스피너가 영구 유지되므로 1차 저장과 동일한 상한(ms)으로 감싼다.
            if (base64Photos.length > 0 && record.id && window.currentUser?.uid) {
                const preloadImage = (url, timeoutMs = 1500) => new Promise((resolve) => {
                    if (!url || typeof url !== 'string') {
                        resolve(false);
                        return;
                    }
                    const img = new Image();
                    let done = false;
                    const finish = (ok) => {
                        if (done) return;
                        done = true;
                        resolve(ok);
                    };
                    const timer = setTimeout(() => finish(false), timeoutMs);
                    img.onload = () => { clearTimeout(timer); finish(true); };
                    img.onerror = () => { clearTimeout(timer); finish(false); };
                    img.src = url;
                });
                let photoPhaseSavedViaCallable = false;
                try {
                    await saveWithTimeout(
                        () =>
                            (async () => {
                                try {
                                    const dataUrlsForUpload = await Promise.all(
                                        base64Photos.map((photo) => ensureDataUrlForStorage(photo))
                                    );
                                    const uploadedUrls = await Promise.all(
                                        dataUrlsForUpload.map((photo) =>
                                            uploadBase64ToStorage(photo, window.currentUser.uid, record.id)
                                        )
                                    );
                                    let uploadedIndex = 0;
                                    let metaIndex = 0;
                                    const finalPhotoUrls = [];
                                    const finalPhotoMeta = [];
                                    sourcePhotos.forEach((photo) => {
                                        const meta = sourcePhotoMeta[metaIndex++] || { takenAt: null };
                                        if (isLocalPendingPhoto(photo)) {
                                            const uploaded = uploadedUrls[uploadedIndex++];
                                            if (uploaded) {
                                                finalPhotoUrls.push(uploaded);
                                                finalPhotoMeta.push(meta);
                                            }
                                            return;
                                        }
                                        if (typeof photo === 'string' && photo) {
                                            finalPhotoUrls.push(photo);
                                            finalPhotoMeta.push(meta);
                                        }
                                    });

                                    record.photos = finalPhotoUrls;
                                    record.photoMeta = finalPhotoMeta;
                                    photosToShare = (!isShareBanned && wantsToShare && finalPhotoUrls.length > 0)
                                        ? [...finalPhotoUrls]
                                        : [];
                                    record.sharedPhotos = photosToShare;

                                    const photoSaveRes = unwrapMealSaveResult(await dbOps.save(record, true));
                                    photoPhaseSavedViaCallable = photoSaveRes.savedViaCallableFallback;
                                    if (photoSaveRes.savedViaCallableFallback && record.id) {
                                        onMealDocFirestoreServerAcknowledged(String(record.id), optimisticTempId);
                                    }
                                    await preloadImage(finalPhotoUrls[0]);
                                    if (window.mealHistory && Array.isArray(window.mealHistory)) {
                                        const localIdx = window.mealHistory.findIndex(m => m.id === record.id);
                                        if (localIdx >= 0) {
                                            window.mealHistory[localIdx] = {
                                                ...window.mealHistory[localIdx],
                                                photos: [...finalPhotoUrls],
                                                photoMeta: record.photoMeta
                                            };
                                        }
                                    }
                                } catch (uploadError) {
                                    photoUploadPhaseFailed = true;
                                    if (record.id) markMealEntrySaveFailedById(String(record.id));
                                    console.error('사진 업로드 실패:', uploadError);
                                    showToast(getUserFacingErrorMessage(uploadError, 'save'), 'error');
                                    // 네트워크 복구 후 재전송할 수 있도록 base64 원본 유지(URL만 있던 수정 건은 기존 URL 유지)
                                    const preserve = sourcePhotos.filter((p) => typeof p === 'string' && p);
                                    record.photos = preserve.length ? preserve : existingPhotoUrls;
                                    photosToShare = (!isShareBanned && wantsToShare && existingPhotoUrls.length > 0)
                                        ? [...existingPhotoUrls]
                                        : [];
                                    record.sharedPhotos = photosToShare;
                                    if (window.mealHistory && record.id) {
                                        const hi = window.mealHistory.findIndex((m) => m && m.id === record.id);
                                        if (hi >= 0) {
                                            window.mealHistory[hi] = {
                                                ...window.mealHistory[hi],
                                                photos: [...record.photos],
                                                _localSaveFailed: true
                                            };
                                        }
                                    }
                                    try {
                                        const recoverRes = unwrapMealSaveResult(await dbOps.save(record, true));
                                        photoPhaseSavedViaCallable = recoverRes.savedViaCallableFallback;
                                        if (recoverRes.savedViaCallableFallback && record.id) {
                                            onMealDocFirestoreServerAcknowledged(String(record.id), optimisticTempId);
                                        }
                                    } catch (recoverErr) {
                                        console.warn('사진 유지 상태 재저장 실패(로컬 보존):', recoverErr?.message || recoverErr);
                                    }
                                }
                            })(),
                        {
                            timeoutMs: MEAL_PHOTO_UPLOAD_PHASE_TIMEOUT_MS,
                            onTimeout: () => {
                                if (record?.id) getMealSyncManager().onSaveUiTimedOut(String(record.id), optimisticTempId);
                            }
                        }
                    );
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
                        queueMicrotask(() => {
                            if (isMealActionEffectiveOffline()) {
                                void import('../utils/mealog-offline-ui.js').then((m) => {
                                    try {
                                        if (record?.id && typeof m.markMealOfflineDraftForRecord === 'function') {
                                            m.markMealOfflineDraftForRecord(record.id);
                                        }
                                    } catch (_) {
                                        /* ignore */
                                    }
                                    void import('../main/meal-sync-resend-header.js').then((h) => {
                                        try {
                                            if (typeof h.refreshMealSyncResendNavButton === 'function') {
                                                h.refreshMealSyncResendNavButton();
                                            }
                                        } catch (_) {
                                            /* ignore */
                                        }
                                    });
                                });
                                return;
                            }
                            try {
                                applyOfflineAfterLocalSaveUi(record.id, optimisticTempId, record.date, currentTab);
                            } catch (_) {
                                /* ignore */
                            }
                        });
                    }
                    refreshTimelineAfterMealSaveResult();
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
                        renderTimeline();
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
                    record.sharedPhotos = photosToShare;
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
            finishEntryModalAfterSuccessfulSave(saveStartedUnderModalGen);
            // 낙관적 반영: 리스너 도착 전에 mealHistory에 즉시 반영해 스크롤·렌더가 최신 데이터 기준으로 동작
            if (record.id && window.mealHistory && Array.isArray(window.mealHistory)) {
                const idx = window.mealHistory.findIndex(m => m.id === record.id);
                const merged = { ...record };
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
            // 기록 완료 중앙 팝업 — 신규 기록에만 (사진 업로드 실패 시에는 오해 소지가 있어 띄우지 않음)
            if (wasNewRecord && !photoUploadPhaseFailed) {
                showSuccessPopup(resolveRecordCompletePopupMessage(wasNewRecord, record.date), 800);
            }
            // 저장 직후 잠깐 타임라인 전체 재렌더를 막아, jumpToDate·스크롤이 리스너 재렌더에 덮이지 않게 함
            window._timelineRerenderFreezeUntil = Date.now() + 800;
            
            /** 모먼트(sharedPhotos 컬렉션) 동기화 실패 시 공유 성공 토스트를 막기 위함 */
            let shareSyncFailed = false;
            // 공유 처리 (ID 확보 후 실행, 비동기로 떼어 두어 체감 속도 개선)
            // sharePhotos 함수가 기존 문서 삭제 + 새 문서 추가 + record.sharedPhotos 필드 업데이트를 모두 처리
            // 공유 상태가 변경되었을 때만 호출 (공유 설정 또는 공유 해제)
            if (record.id) {
                // 현재 공유할 사진이 있는지 확인
                const hasPhotosToShare = photosToShare && photosToShare.length > 0;
                
                // 공유 상태가 변경된 경우에만 호출
                // 1. 공유할 사진이 있는 경우 (공유 설정)
                // 2. 기존에 공유된 사진이 있었는데 지금은 없는 경우 (공유 해제)
                if (hasPhotosToShare || hadSharedPhotos) {
                    sharedPhotosUpdated = true;
                    // 공유 화살표는 먼저 낙관 반영하고, sharePhotos는 백그라운드로 보내서 체감 지연 감소
                    if (record.id) {
                        if (hasPhotosToShare && photosToShare?.length) {
                            if (!window.sharedPhotos) window.sharedPhotos = [];
                            const newEntries = photosToShare.map(url => ({ entryId: record.id, photoUrl: url, userId: window.currentUser?.uid }));
                            window.sharedPhotos = (window.sharedPhotos || []).filter(p => p.entryId !== record.id).concat(newEntries);
                        } else if (hadSharedPhotos && !hasPhotosToShare) {
                            if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                                window.sharedPhotos = window.sharedPhotos.filter(p => p.entryId !== record.id);
                            }
                        }
                        updateTimelineShareIndicators();
                    }
                    try {
                        const { buildOptimisticMomentPostV2 } = await import('../utils/moment-post-v2.js');
                        const { mergeMomentPostIntoFeed, removeMomentPostFromFeed } = await import('../utils/moment-feed-cache.js');
                        const profile = window.userSettings?.profile || {};
                        const uid = window.currentUser?.uid;

                        await dbOps.sharePhotos(photosToShare, record);
                        console.log('공유 처리 완료:', { recordId: record.id, 공유설정: hasPhotosToShare });

                        if (hasPhotosToShare && photosToShare?.length) {
                            window.sharedPhotosFeed = mergeMomentPostIntoFeed(
                                window.sharedPhotosFeed,
                                buildOptimisticMomentPostV2(record, photosToShare, profile, uid)
                            );
                        } else if (record?.id) {
                            window.sharedPhotosFeed = removeMomentPostFromFeed(window.sharedPhotosFeed, record.id, uid);
                        }

                        if (appState.currentTab === 'gallery') renderGallery();
                        if (document.getElementById('feedContent')) renderFeed();

                        import('../db.js').then(({ loadSharedPhotosPage }) =>
                            loadSharedPhotosPage(10).then(({ docs, lastDoc, hasMore }) => {
                                if (typeof appState !== 'undefined') {
                                    appState.sharedPhotosFeedLastDoc = lastDoc;
                                    appState.sharedPhotosFeedHasMore = hasMore;
                                }
                                if (!hasPhotosToShare || !record?.id) return;
                                const serverPost = docs.find(
                                    (d) => d.schemaVersion === 2 && d.entryId === record.id
                                );
                                if (serverPost) {
                                    window.sharedPhotosFeed = mergeMomentPostIntoFeed(window.sharedPhotosFeed, serverPost);
                                    if (appState.currentTab === 'gallery') renderGallery();
                                    if (document.getElementById('feedContent')) renderFeed();
                                }
                            })
                        ).catch(() => {});
                    } catch (e) {
                        shareSyncFailed = true;
                        console.error("공유 처리 실패:", e);
                        showToast(getUserFacingErrorMessage(e, 'share'), 'error');
                    }
                }
            }

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
            console.error('dbOps.save 오류:', saveError);
            setEntryModalSavingState(false);
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
    if (delRecForPending && isMealEntryPendingSync(delRecForPending)) {
        showToast('서버에 등록 중에는 삭제할 수 없습니다.', 'info');
        return;
    }
    
    // 삭제 확인 다이얼로그
    if (!confirm("정말 이 기록을 삭제하시겠습니까?")) {
        return;
    }
    
    // 삭제할 ID를 미리 저장 (모달 닫기 전에)
    const entryIdToDelete = state.currentEditingId;

    /** closeModal 전에 캐시에서 확보 — 닫은 뒤에는 편집 id가 비워져 찾기 실패하는 경우 방지 */
    let mealForDelete = window.mealHistory?.find((m) => m.id === entryIdToDelete);
    if (!mealForDelete && entryIdToDelete && window.currentUser?.uid) {
        try {
            await refreshAppCheckTokenBeforeFirestore();
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

    if (isMealActionEffectiveOffline()) {
        showToast('연결되면 서버에 삭제가 반영돼요. 삭제 예약으로 표시됩니다.', 'info');
    }

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
        await Promise.race([
            dbOps.delete(entryIdToDelete),
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

/** data:image 또는 blob: → Storage 업로드용 data URL */
async function ensureDataUrlForStorage(photo) {
    if (typeof photo !== 'string' || !photo) return photo;
    if (photo.startsWith('data:image')) return photo;
    if (photo.startsWith('blob:')) {
        const blob = await (await fetch(photo)).blob();
        return await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('blob 이미지 읽기 실패'));
            r.readAsDataURL(blob);
        });
    }
    return photo;
}

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
    const httpsUrls = finalPhotos.filter((p) => typeof p === 'string' && /^https?:\/\//.test(p));
    const hadShared = Array.isArray(record.sharedPhotos) && record.sharedPhotos.length > 0;
    next.sharedPhotos = hadShared && httpsUrls.length > 0 ? httpsUrls : [];
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
    if (!window._mealEntryRetryInFlight) window._mealEntryRetryInFlight = {};
    if (window._mealEntryRetryInFlight[entryId]) return;
    const record = window.mealHistory?.find((m) => m && String(m.id) === entryId);
    if (!record) {
        showToast('기록을 찾을 수 없습니다.', 'error');
        return;
    }
    if (
        !isMealEntrySaveFailed(record) &&
        !isMealEntrySyncAbandoned(record) &&
        getMealRowSyncLeadKind(record) !== 'register_scheduled'
    ) {
        return;
    }

    window._mealEntryRetryInFlight[entryId] = true;
    try {
        /** 등록예정인데 서버 문서가 이미 있으면 재저장·inFlight 없이 ack만 — reconcile 직후 재시도에서 초록→레드 깜빡임 방지 */
        if (getMealRowSyncLeadKind(record) === 'register_scheduled' && !entryId.startsWith('temp_')) {
            const uid = window.currentUser?.uid;
            if (uid) {
                try {
                    const ref = doc(db, 'artifacts', appId, 'users', uid, 'meals', entryId);
                    const snap = await getDocFromServer(ref);
                    if (snap.exists()) {
                        onMealDocFirestoreServerAcknowledged(entryId, null);
                        markMealEntryServerWorkComplete(entryId, null, `${record.date || ''}__${record.slotId || ''}`);
                        invalidateTimelineDateSection(record.date);
                        updateTimelineMealEntryPendingIndicators();
                        if (appState.currentTab === 'timeline') renderTimeline();
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
                if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                    window.sharedPhotos = window.sharedPhotos.map((p) =>
                        p.entryId === entryId ? { ...p, entryId: realId } : p
                    );
                }
                clearMealEntrySaveFailedById(entryId);
                clearMealEntrySaveFailedById(realId);
                clearMealEntrySaveInFlight(entryId);
                clearMealOptimisticSavePending(entryId);
                onMealDocFirestoreServerAcknowledged(realId, entryId);
                markMealEntryServerWorkComplete(realId, entryId, slotKeyMerge);
            } else {
                delete payload.id;
                const retrySaveRes = unwrapMealSaveResult(
                    await Promise.race([
                        dbOps.save(payload, true),
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
                if (savedId && window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
                    window.sharedPhotos = window.sharedPhotos.map((p) =>
                        p.entryId === entryId ? { ...p, entryId: savedId } : p
                    );
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
            const retryElseRes = unwrapMealSaveResult(
                await Promise.race([
                    dbOps.save(payloadOut, true),
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
        if (appState.currentTab === 'timeline') renderTimeline();
    } catch (e) {
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
        delete window._mealEntryRetryInFlight[entryId];
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

    if (isMealActionEffectiveOffline()) {
        showToast('연결되면 서버에 삭제가 반영돼요. 삭제 예약으로 표시됩니다.', 'info');
    }

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
        await Promise.race([
            dbOps.delete(entryId),
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
        const saveRedo =
            isMealEntrySaveFailed(m) ||
            isMealEntrySyncAbandoned(m) ||
            getMealRowSyncLeadKind(m) === 'register_scheduled';
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
    appState.currentRating = s;
    // (표시 생략) ratingDialValue는 UI에서 hidden 처리

    // 휠 UI 동기화
    const syncWheel = (wheelId, axis = 'y') => {
        const wheel = document.getElementById(wheelId);
        if (!wheel) return;
        const ITEM_H = 44;
        const vNorm = Math.max(1, Math.min(5, Number(s) || 1));
        const target = (vNorm - 1) * ITEM_H;
        const pos = axis === 'x' ? (wheel.scrollLeft || 0) : (wheel.scrollTop || 0);
        if (!wheel._mealogSyncing && Math.abs(pos - target) > 2) {
            wheel._mealogSyncing = true;
            wheel.scrollTo(axis === 'x' ? { left: target, behavior: 'auto' } : { top: target, behavior: 'auto' });
            setTimeout(() => {
                wheel._mealogSyncing = false;
            }, 0);
        }
        wheel.querySelectorAll('.mealog-wheel__item[data-val]').forEach((el) => {
            const v = Number(el.getAttribute('data-val'));
            el.classList.toggle('mealog-wheel__item--active', v === vNorm);
            el.setAttribute('aria-selected', v === vNorm ? 'true' : 'false');
        });
    };
    syncWheel('ratingWheel', 'y');
    syncWheel('snackRatingWheel', 'y');

    const starContainer = document.getElementById('starContainer');
    if (starContainer) {
        const sts = starContainer.children;
        for (let i = 0; i < 5; i++) {
            sts[i].className = i < s ? 'star-btn text-2xl text-yellow-400' : 'star-btn text-2xl text-slate-200';
        }
    }
    const snackStarContainer = document.getElementById('snackStarContainer');
    if (snackStarContainer) {
        const sts = snackStarContainer.children;
        for (let i = 0; i < 5; i++) {
            sts[i].className = i < s ? 'star-btn text-2xl text-yellow-400' : 'star-btn text-2xl text-slate-200';
        }
    }
}

export function setSatiety(s) {
    const state = appState;
    state.currentSatiety = s;

    const syncSatietyWheel = (wheelId) => {
        const wheel = document.getElementById(wheelId);
        if (!wheel) return;
        const ITEM_H = 44;
        const vNorm = Math.max(1, Math.min(5, Number(s) || 1));
        const targetTop = (vNorm - 1) * ITEM_H;
        if (!wheel._mealogSyncing && Math.abs((wheel.scrollTop || 0) - targetTop) > 2) {
            wheel._mealogSyncing = true;
            wheel.scrollTo({ top: targetTop, behavior: 'auto' });
            setTimeout(() => { wheel._mealogSyncing = false; }, 0);
        }
        wheel.querySelectorAll('.mealog-wheel__item[data-val]').forEach((el) => {
            const v = Number(el.getAttribute('data-val'));
            const active = v === vNorm;
            el.classList.toggle('mealog-wheel__item--active', active);
            el.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) {
                const color = el.getAttribute('data-color') || '';
                const icon = el.querySelector('i');
                if (icon) icon.style.color = color || '';
            } else {
                const icon = el.querySelector('i');
                if (icon) icon.style.color = '';
            }
        });
    };
    syncSatietyWheel('satietyWheel');
    syncSatietyWheel('snackSatietyWheel');

    const container = document.getElementById('satietyContainer');
    if (container) {
        container.innerHTML = SATIETY_DATA.map(d => 
            `<button onclick="window.setSatiety(${d.val})" class="flex-1 flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${d.val === s ? 'bg-white shadow-sm ring-1 ring-slate-200 scale-105 opacity-100' : 'opacity-40 grayscale hover:grayscale-0 hover:opacity-100'}">
                <i class="fa-solid ${d.icon} text-2xl ${d.color}"></i>
                <span class="text-[10px] font-bold ${d.val === s ? 'text-slate-800' : 'text-slate-400'}">${d.label}</span>
            </button>`
        ).join('');
    }
}

// 휠 다이얼 스냅/동기화 (기록 모달 오픈 시 setRating/setSatiety로 초기화됨)
function initWheelDialsOnce() {
    if (window.__mealogWheelDialsInit) return;
    window.__mealogWheelDialsInit = true;

    const ITEM = 44;
    const bindWheel = (wheelId, onSelect, axis = 'y') => {
        const wheel = document.getElementById(wheelId);
        if (!wheel) return;
        // 마우스 드래그로도 휠 스크롤 가능하게
        let dragging = false;
        let startP = 0;
        let startScroll = 0;
        wheel.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === 'touch') {
                dragging = true;
                startP = axis === 'x' ? e.clientX : e.clientY;
                startScroll = axis === 'x' ? (wheel.scrollLeft || 0) : (wheel.scrollTop || 0);
                try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
            }
        });
        wheel.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const p = axis === 'x' ? e.clientX : e.clientY;
            const dp = p - startP;
            if (axis === 'x') wheel.scrollLeft = startScroll - dp;
            else wheel.scrollTop = startScroll - dp;
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            try { wheel.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        wheel.addEventListener('pointerup', endDrag);
        wheel.addEventListener('pointercancel', endDrag);

        let raf = null;
        let lastVal = null;
        const computeVal = () => {
            const items = [...wheel.querySelectorAll('.mealog-wheel__item[data-val]')];
            if (items.length === 0) return null;
            const pos = axis === 'x' ? (wheel.scrollLeft || 0) : (wheel.scrollTop || 0);
            const idx = Math.round(pos / ITEM);
            const item = items[Math.max(0, Math.min(items.length - 1, idx))];
            const v = Number(item.getAttribute('data-val'));
            return Number.isFinite(v) ? v : null;
        };
        const snapTo = (v) => {
            const items = [...wheel.querySelectorAll('.mealog-wheel__item[data-val]')];
            const i = items.findIndex(x => Number(x.getAttribute('data-val')) === v);
            if (i < 0) return;
            wheel.scrollTo(axis === 'x' ? { left: i * ITEM, behavior: 'smooth' } : { top: i * ITEM, behavior: 'smooth' });
        };
        wheel.addEventListener('scroll', () => {
            if (wheel._mealogSyncing) return;
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => {
                raf = null;
                const v = computeVal();
                if (v == null || v === lastVal) return;
                lastVal = v;
                onSelect(v);
            });
        }, { passive: true });

        wheel.addEventListener('click', (e) => {
            const item = e.target?.closest?.('.mealog-wheel__item[data-val]');
            if (!item) return;
            const v = Number(item.getAttribute('data-val'));
            if (!Number.isFinite(v)) return;
            snapTo(v);
            onSelect(v);
        });
    };

    bindWheel('ratingWheel', (v) => {
        if (appState.entryGaugeRatingOnMain === true) window.setRating?.(v);
    }, 'y');
    bindWheel('snackRatingWheel', (v) => {
        if (appState.entryGaugeRatingOnSnack === true) window.setRating?.(v);
    }, 'y');
    bindWheel('satietyWheel', (v) => {
        if (appState.entryGaugeSatietyOnMain === true) window.setSatiety?.(v);
    }, 'y');
    bindWheel('snackSatietyWheel', (v) => {
        if (appState.entryGaugeSatietyOnSnack === true) window.setSatiety?.(v);
    }, 'y');
}

// entry 모달이 열리고 나면 휠 이벤트를 1회 바인딩
setTimeout(initWheelDialsOnce, 0);

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

/**
 * 기록 모달 '나만의 태그 / 최근 태그' 줄: 마우스로 누른 채 좌우 드래그하면 가로 스크롤 (클릭과 구분).
 */
function initEntryModalSubtagDragScroll() {
    const root = document.getElementById('entryModal');
    if (!root || root._subtagDragScrollBound) return;
    root._subtagDragScrollBound = true;

    const DRAG_THRESHOLD_PX = 14;
    const VERTICAL_CANCEL_RATIO = 12;

    /** @type {{ el: HTMLElement, pointerId: number, startX: number, startY: number, startScrollLeft: number, dragging: boolean } | null} */
    let state = null;

    const release = () => {
        if (!state) return;
        const { el, pointerId } = state;
        el.classList.remove('entry-subtag-suggestions--dragging');
        try {
            el.releasePointerCapture(pointerId);
        } catch (_) {}
        state = null;
    };

    root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.pointerType !== 'mouse') return;
        /** 칩 버튼·삭제 버튼은 짧은 클릭으로 선택·삭제 — 가로 드래그 스크롤과 충돌 방지 */
        if (e.target.closest?.('button')) return;
        const el = e.target.closest?.('.entry-subtag-suggestions');
        if (!el || !root.contains(el)) return;
        if (el.scrollWidth <= el.clientWidth + 1) return;
        state = {
            el,
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: el.scrollLeft,
            dragging: false
        };
        try {
            el.setPointerCapture(e.pointerId);
        } catch (_) {}
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
            state.el.classList.add('entry-subtag-suggestions--dragging');
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
                const strip = ev.target.closest?.('.entry-subtag-suggestions');
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
        (subContainerId === 'peopleSuggestions' ||
            subContainerId === 'menuSuggestions' ||
            subContainerId === 'snackPeopleSuggestions' ||
            subContainerId === 'snackSuggestions');
    
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
    
    // Skip 선택 시 필드 숨기기 처리 (typeChips에서만)
    // typeChips는 subTagKey가 'place'이고 inputId가 'null'인 경우
    if (isPrimary && inputId === 'null' && subTagKey === 'place') {
        const isSkip = (selectedValue === 'Skip' || selectedValue === '건너뜀');
        toggleFieldsForSkip(isSkip);
        
    }
    
    if (isPrimary && subTagKey === 'place' && subContainerId === 'restaurantSuggestions' && selectedValue && (selectedValue === '집밥' || selectedValue === '배달/포장')) {
        const pi = document.getElementById('placeInput');
        if (pi) {
            pi.value = '우리집';
            pi.removeAttribute('data-kakao-place-id');
            pi.removeAttribute('data-kakao-place-address');
            pi.removeAttribute('data-kakao-place-data');
            pi.removeAttribute('data-kakao-place-name');
        }
    }

    if (isPrimary && subTagKey && subContainerId) {
        if (subContainerId === 'snackPlaceSuggestions') {
            appState.selectedSnackPlaceMainTag = selectedValue;
        }
        const subTags = window.userSettings.subTags[subTagKey] || [];
        const inputIdForSecondary = (subTagKey === 'people') ? 'withWhomInput' : 
            (document.getElementById(subContainerId)?.getAttribute('data-input-id') || getInputIdFromContainer(subContainerId));
        window.renderSecondary(subContainerId, subTags, inputIdForSecondary, selectedValue, subTagKey);
    }
    syncDeliveryVendorSectionVisibility();
}

function toggleFieldsForSkip(isSkip) {
    // 메뉴정보 섹션 (optionalFields) - 완전히 숨기기
    const optionalFields = document.getElementById('optionalFields');
    if (optionalFields) {
        if (isSkip) {
            optionalFields.classList.add('hidden');
        } else {
            optionalFields.classList.remove('hidden');
        }
    }
    
    // 만족도 섹션 (ratingSection) - 완전히 숨기기
    const ratingSection = document.getElementById('ratingSection');
    if (ratingSection) {
        if (isSkip) {
            ratingSection.classList.add('hidden');
        } else {
            ratingSection.classList.remove('hidden');
        }
    }

    const entryMealTimeSectionMain = document.getElementById('entryMealTimeSectionMain');
    if (entryMealTimeSectionMain) {
        if (isSkip) {
            entryMealTimeSectionMain.classList.add('hidden');
        } else {
            entryMealTimeSectionMain.classList.remove('hidden');
        }
    }
    syncDeliveryVendorSectionVisibility();
}

const RECORD_MAX_PHOTOS = 10;

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

    const filePromises = filesToProcess.map((f, index) => {
        return new Promise((resolve) => {
            const r = new FileReader();
            r.onload = (ev) => {
                resolve({ index, dataUrl: ev.target.result });
            };
            r.onerror = () => {
                console.error('파일 읽기 실패:', f.name);
                resolve(null);
            };
            r.readAsDataURL(f);
        });
    });

    Promise.all(filePromises)
        .then(async (results) => {
            const sortedResults = results.filter((r) => r !== null).sort((a, b) => a.index - b.index);

            const currentPhotosCount = state.currentPhotos.length;
            const availableSlots = RECORD_MAX_PHOTOS - currentPhotosCount;

            const exifMetaEntries = await Promise.all(filesToProcess.map((file) => createPhotoMetaFromFile(file)));

            sortedResults.slice(0, availableSlots).forEach(({ index, dataUrl }) => {
                if (state.currentPhotos.length < RECORD_MAX_PHOTOS) {
                    state.currentPhotos.push(dataUrl);
                    if (!Array.isArray(state.currentPhotoMeta)) state.currentPhotoMeta = [];
                    state.currentPhotoMeta.push(exifMetaEntries[index] || { takenAt: null });
                }
            });

            renderPhotoPreviews();
            updateShareIndicator();

            const mainSide = !isSnack;
            const timeOn = isSnack ? appState.entryTimeOnSnack === true : appState.entryTimeOnMain === true;

            const isNewEntry = !state.currentEditingId && filesToProcess.length > 0;
            if (isNewEntry) {
                const hhmmExif = await tryExifTimeHHmmFromImageFile(filesToProcess[0]);
                if (timeOn) {
                    const alreadyApplied = mainSide
                        ? appState.entryMealClockDidApplyPhotoExifMain
                        : appState.entryMealClockDidApplyPhotoExifSnack;
                    if (!alreadyApplied && hhmmExif) {
                        applyMealClockRowFrom24(mainSide, normalizeMealClockInputValue(hhmmExif) || hhmmExif);
                        if (mainSide) appState.entryMealClockDidApplyPhotoExifMain = true;
                        else appState.entryMealClockDidApplyPhotoExifSnack = true;
                    }
                } else if (hhmmExif) {
                    if (mainSide && appState.entryMealClockPendingExifHhmmMain == null) {
                        appState.entryMealClockPendingExifHhmmMain = hhmmExif;
                    }
                    if (!mainSide && appState.entryMealClockPendingExifHhmmSnack == null) {
                        appState.entryMealClockPendingExifHhmmSnack = hhmmExif;
                    }
                }
            }
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
    state.currentPhotos.splice(idx, 1);
    if (Array.isArray(state.currentPhotoMeta)) {
        state.currentPhotoMeta.splice(idx, 1);
    }
    renderPhotoPreviews();
    updateShareIndicator();
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
    renderPhotoPreviews();
}

export function updateShareIndicator() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;
    
    // 공유 금지 체크
    const isShareBanned = state.currentEditingId ? (window.mealHistory.find(m => m.id === state.currentEditingId)?.shareBanned === true) : false;
    
    // 사진이 있으면 항상 인디케이터 표시 (공유 가능 상태)
    if (state.currentPhotos.length > 0) {
        if (isShareBanned) {
            // 공유 금지된 경우: 비활성화 스타일로 표시
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-red-50', 'border-red-300', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'bg-slate-50', 'border-slate-200', 'text-emerald-600', 'text-slate-400');
            shareIndicator.title = '공유가 금지된 게시물입니다';
        } else if (state.wantsToShare) {
            // 공유를 원하는 경우 활성화 스타일
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
            shareIndicator.classList.remove('bg-slate-50', 'border-slate-200', 'bg-red-50', 'border-red-300', 'text-slate-400', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.title = '';
        } else {
            // 사진은 있지만 아직 공유하지 않은 경우도 표시 (비활성화 스타일)
            shareIndicator.classList.remove('hidden');
            shareIndicator.classList.add('bg-slate-50', 'border-slate-200', 'text-slate-400');
            shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'bg-red-50', 'border-red-300', 'text-emerald-600', 'text-red-400', 'cursor-not-allowed');
            shareIndicator.title = '';
        }
    } else {
        shareIndicator.classList.add('hidden');
    }
}

export function toggleSharePhoto() {
    const state = appState;
    const shareIndicator = document.getElementById('sharePhotoIndicator');
    if (!shareIndicator) return;
    
    if (state.currentPhotos.length === 0) {
        showToast("공유할 사진이 없습니다.", 'error');
        return;
    }
    
    // 공유 금지 체크
    const isShareBanned = state.currentEditingId ? (window.mealHistory.find(m => m.id === state.currentEditingId)?.shareBanned === true) : false;
    if (isShareBanned) {
        showToast("공유가 금지된 게시물입니다.", 'error');
        return;
    }
    
    const isCurrentlySharing = shareIndicator.classList.contains('bg-emerald-100');
    
    if (isCurrentlySharing) {
        // 공유 해제
        state.wantsToShare = false;
        shareIndicator.classList.remove('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
        shareIndicator.classList.add('bg-slate-50', 'border-slate-200', 'text-slate-400');
    } else {
        // 공유 설정
        state.wantsToShare = true;
        shareIndicator.classList.remove('bg-slate-50', 'border-slate-200', 'text-slate-400');
        shareIndicator.classList.add('bg-emerald-100', 'border-emerald-300', 'text-emerald-600');
    }
}

