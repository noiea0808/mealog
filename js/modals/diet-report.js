/**
 * 밀로그 날짜별 AI 식단분석 리포트 팝업
 */
import { db, appId, callableFunctions } from '../firebase.js';
import { showToast } from '../ui.js';
import { escapeHtml } from '../render/utils.js';
import { formatMealogDateLabel } from '../utils/date-label.js';
import { isDailyJournalMealRecord } from '../utils/daily-journal-data.js';
import {
    parseAiMealReport,
    extractAiMealReportSource,
    renderAiMealReportCardHtml,
    extractAnalyzedPhotoUrlsForDisplay
} from '../utils/ai-meal-report.js';
import { toLocalDateString, captureWithGhostStrategy, uploadBase64ToStorage, shareBlobsToExternal } from '../utils.js';
import { MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS } from '../constants.js';
import {
    findDietReportMomentShare,
    getDietReportShareDateRangeText,
    isDietReportInsightShare
} from '../utils/diet-report-share.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { lockBodyScroll, unlockBodyScroll } from '../utils/scroll-lock.js';
import { scheduleLucideIcons } from '../icons.js';
import { unshareWithOptimisticUpdate, getSharedPhotos, setSharedPhotos } from '../utils/moment-share-state.js';

let _currentDate = '';
let _loading = false;
let _sharing = false;
/** 현재 모달에 표시 중인 리포트(파싱 결과) — 모먼트 공유 캡처용 */
let _currentReport = null;
/** Firestore 원문(분석 사진 URL 등) — 모먼트 공유 캡처용 */
let _currentReportDoc = null;
/** SNS 공유용 캡처 이미지(클릭 직후 공유 시트 열기 — 사용자 제스처 유지) */
let _snsShareBlob = null;
let _snsShareBlobKey = '';
/** @type {Promise<void> | null} */
let _snsShareCachePromise = null;
let _snsShareCachePromiseKey = '';
/** @type {Promise<string> | null} */
let _shareCaptureFontCssPromise = null;

const DIET_REPORT_SHARE_CAPTURE_SCALE = 2;
/** SNS 공유 캡처용 분석 사진 썸네일(px) — 420px 카드 기준 3열+간격 */
const DIET_REPORT_SHARE_PHOTO_THUMB_PX = 118;
const DIET_REPORT_SHARE_PHOTO_GAP_PX = 8;
/**
 * html2canvas는 flex/vertical-align 중앙 정렬을 LIVE DOM과 다르게 그림.
 * 인라인 style + 캡처 직전 DOM + onclone 삼중 보정(일간 공유 Ghost Hack과 동일 계열).
 */
const DIET_REPORT_CAPTURE_BADGE_OFFSET_Y_PX = 4;
const DIET_REPORT_CAPTURE_MOOD_OFFSET_Y_PX = 12;
const DIET_REPORT_CAPTURE_MOOD_GAP_PX = 8;

function dietReportCaptureYOffsetStyle(px) {
    return `position:relative;top:${px}px;`;
}

/** pill — 고정 height/inner-flex 금지(html2canvas에서 텍스트가 박스 밖으로 사라짐). 패딩+line-height:1만 사용 */
function buildDietReportCapturePillStyle(padding, colors) {
    return `display:inline-block;padding:${padding};border-radius:9999px;box-sizing:border-box;white-space:nowrap;line-height:1;${colors}`;
}

/** @type {Map<string, boolean>} */
const _aiDietReportReadyByDate = new Map();

export function isAiDietReportReady(dateStr) {
    return _aiDietReportReadyByDate.get(dateStr) === true;
}

export function setAiDietReportReady(dateStr, ready) {
    if (!dateStr) return;
    _aiDietReportReadyByDate.set(dateStr, ready === true);
}

export function clearAiDietReportReadyCache() {
    _aiDietReportReadyByDate.clear();
}

const AI_DIET_REPORT_BTN_BASE =
    'inline-flex items-center gap-1 text-[11px] font-bold px-3 py-1 rounded-full border active:opacity-70 transition-colors whitespace-nowrap';

function aiDietReportButtonStyleClasses(hasReport) {
    return hasReport
        ? 'text-emerald-700 bg-emerald-50 border border-emerald-200'
        : 'text-slate-400 bg-slate-50 border border-slate-200';
}

export function updateAiDietReportButtonsInTimeline() {
    const root = document.getElementById('timelineContainer');
    if (!root) return;
    root.querySelectorAll('button[data-mealog-diet-report]').forEach((btn) => {
        const dateStr = btn.getAttribute('data-mealog-date') || '';
        if (!dateStr) return;
        const hasReport = isAiDietReportReady(dateStr);
        const readyCls = aiDietReportButtonStyleClasses(true).split(/\s+/);
        const emptyCls = aiDietReportButtonStyleClasses(false).split(/\s+/);
        btn.classList.remove(...readyCls, ...emptyCls);
        btn.classList.add(...(hasReport ? readyCls : emptyCls));
    });
}

export async function refreshAiDietReportFlagsForDates(dateStrs) {
    const uid = window.currentUser?.uid;
    if (!uid || window.currentUser.isAnonymous) return;

    const dates = [...new Set((dateStrs || []).filter((d) => isAiDietReportDateVisible(d)))];
    if (!dates.length) return;

    let changed = false;
    await Promise.all(
        dates.map(async (dateStr) => {
            try {
                const snap = await getDoc(
                    doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr))
                );
                const ready = snap.exists() && snap.data()?.status === 'ready';
                const prev = _aiDietReportReadyByDate.get(dateStr);
                if (prev !== ready) {
                    _aiDietReportReadyByDate.set(dateStr, ready);
                    changed = true;
                }
            } catch (_) {
                /* ignore */
            }
        })
    );

    if (changed) updateAiDietReportButtonsInTimeline();
}

export function isAiDietReportDateVisible(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return false;
    }
    const todayStr = toLocalDateString(new Date());
    if (dateStr >= todayStr) return false;
    return true;
}

export function countAnalyzableMealsForDate(dateStr) {
    return (window.mealHistory || []).filter(
        (m) => m && m.date === dateStr && isDietAnalyzableMealRecord(m)
    ).length;
}

/** 백엔드 isDietAnalyzableMeal 과 동일 — 하루소감 미러 제외 */
export function isDietAnalyzableMealRecord(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.slotId === 'daily_journal') return false;
    if (String(m.id || '').startsWith('dailyJournal_')) return false;
    if (isDailyJournalMealRecord(m)) return false;
    return true;
}

export function getAiDietReportButtonHtml(dateStr) {
    if (!window.currentUser || window.currentUser.isAnonymous) return '';
    if (!isAiDietReportDateVisible(dateStr)) return '';
    const styleCls = aiDietReportButtonStyleClasses(isAiDietReportReady(dateStr));
    return `<button type="button" data-mealog-diet-report="1" data-mealog-date="${dateStr}" class="${AI_DIET_REPORT_BTN_BASE} ${styleCls}">
        <i data-lucide="sparkles" class="text-[10px]" aria-hidden="true"></i>AI 리포트
    </button>`;
}

function reportDocId(uid, dateStr) {
    return `${uid}_${dateStr}`;
}

function formatReportGeneratedAt(value) {
    if (!value) return '';
    try {
        const d = value.toDate ? value.toDate() : new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) {
        return '';
    }
}

function setModalVisible(visible) {
    const modal = document.getElementById('dietReportModal');
    if (!modal) {
        console.warn('[dietReport] #dietReportModal not found in DOM');
        return;
    }
    const wasVisible = !modal.classList.contains('hidden');
    modal.classList.toggle('hidden', !visible);
    document.body.classList.toggle('diet-report-modal-open', visible);
    if (visible && !wasVisible) lockBodyScroll('dietReport');
    else if (!visible && wasVisible) unlockBodyScroll('dietReport');
}

function setModalSubtitle(text) {
    const el = document.getElementById('dietReportModalSubtitle');
    if (!el) return;
    if (text) {
        el.textContent = text;
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

function clearSnsShareBlobCache() {
    _snsShareBlob = null;
    _snsShareBlobKey = '';
}

function getShareCaptureFontCss() {
    if (!_shareCaptureFontCssPromise) {
        _shareCaptureFontCssPromise = (async () => {
            try {
                const fredokaRes = await fetch(
                    'https://fonts.googleapis.com/css2?family=Fredoka:wght@600&display=swap'
                );
                return (await fredokaRes.text()) + MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS;
            } catch (_) {
                return MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS;
            }
        })();
    }
    return _shareCaptureFontCssPromise;
}

function setSnsShareButtonPreparing(preparing) {
    const btn = document.getElementById('dietReportSnsShareBtn');
    if (!btn || btn.classList.contains('hidden')) return;
    if (preparing) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i>';
        btn.setAttribute('aria-label', '공유 이미지 준비 중');
        btn.title = '공유 이미지 준비 중…';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="share-2" aria-hidden="true"></i>';
        btn.setAttribute('aria-label', '다른 SNS에 공유');
        btn.title = '다른 SNS에 공유';
    }
    scheduleLucideIcons(btn);
}

/** 백그라운드 캐시용 — 공유 아이콘은 유지하고 살짝 흐리게만 */
function setSnsShareButtonCacheBusy(busy) {
    const btn = document.getElementById('dietReportSnsShareBtn');
    if (!btn || btn.classList.contains('hidden')) return;
    btn.classList.toggle('opacity-60', !!busy);
    if (busy) {
        btn.setAttribute('aria-busy', 'true');
    } else {
        btn.removeAttribute('aria-busy');
    }
}

async function refreshSnsShareBlobCache(dateStr, report, reportDoc) {
    if (!dateStr || !report) {
        clearSnsShareBlobCache();
        return;
    }
    const cacheKey = `${dateStr}:${report.title || ''}:${report.score ?? ''}:${reportDoc ? extractAnalyzedPhotoUrlsForDisplay(reportDoc).join('|') : ''}`;
    if (_snsShareBlob && _snsShareBlobKey === cacheKey) return;

    if (_snsShareCachePromise && _snsShareCachePromiseKey === cacheKey) {
        await _snsShareCachePromise;
        return;
    }

    setSnsShareButtonCacheBusy(true);
    _snsShareCachePromiseKey = cacheKey;
    _snsShareCachePromise = (async () => {
        try {
            const canvas = await captureDietReportShareCanvas(dateStr, report, reportDoc);
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
            if (!blob) {
                clearSnsShareBlobCache();
                return;
            }
            _snsShareBlob = blob;
            _snsShareBlobKey = cacheKey;
        } catch (e) {
            console.warn('diet report SNS share cache failed', e);
            clearSnsShareBlobCache();
        }
    })();

    try {
        await _snsShareCachePromise;
    } finally {
        if (_snsShareCachePromiseKey === cacheKey) {
            setSnsShareButtonCacheBusy(false);
            _snsShareCachePromise = null;
            _snsShareCachePromiseKey = '';
        }
    }
}

function setSnsShareButton(visible) {
    const btn = document.getElementById('dietReportSnsShareBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', !visible);
    if (!visible) {
        setSnsShareButtonPreparing(false);
        setSnsShareButtonCacheBusy(false);
    } else {
        if (!_snsShareCachePromise) {
            btn.disabled = false;
            btn.classList.remove('opacity-60');
        }
        if (!btn.querySelector('[data-lucide], svg')) {
            btn.innerHTML = '<i data-lucide="share-2" aria-hidden="true"></i>';
        }
        scheduleLucideIcons(btn);
    }
}

/** 헤더(다시 분석) + 하단(모먼트 공유) 표시/상태 제어 */
function setFooterButtons({ regen = false, share = false, regenLabel = '다시 분석', shareMode = 'share' } = {}) {
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) {
        regenBtn.classList.toggle('hidden', !regen);
        regenBtn.disabled = false;
        regenBtn.setAttribute('aria-label', regenLabel);
        regenBtn.title = regenLabel;
        if (regen) {
            if (!regenBtn.querySelector('[data-lucide], svg')) {
                regenBtn.innerHTML = '<i data-lucide="refresh-cw" aria-hidden="true"></i>';
            }
            scheduleLucideIcons(regenBtn);
        }
    }
    const shareBtn = document.getElementById('dietReportShareBtn');
    if (shareBtn) {
        shareBtn.classList.toggle('hidden', !share);
        shareBtn.disabled = false;
        if (shareMode === 'unshare') {
            shareBtn.className = 'mealog-btn mealog-btn-danger';
            shareBtn.innerHTML =
                '<span class="diet-report-share-btn__inner"><i data-lucide="send" aria-hidden="true"></i><span>공유 취소</span></span>';
        } else {
            shareBtn.className = 'mealog-btn mealog-btn-primary';
            shareBtn.innerHTML =
                '<span class="diet-report-share-btn__inner"><i data-lucide="send" aria-hidden="true"></i><span>모먼트 공유</span></span>';
        }
        if (!share) shareBtn.classList.add('hidden');
        else scheduleLucideIcons(shareBtn);
    }
    const actions = document.getElementById('dietReportModalActions');
    if (actions) {
        actions.classList.toggle('mealog-dialog-actions--pair', !!share);
        actions.classList.toggle('mealog-dialog-actions--single', !share);
    }
}

function renderLoading(mode = 'fetch') {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    const label = mode === 'writing' ? '리포트 작성중' : '리포트 불러오는 중…';
    body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-10 text-slate-400">
            <i data-lucide="loader-circle" class="text-2xl mb-3 lucide-spin" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">${label}</p>
        </div>`;
    _currentReport = null;
    _currentReportDoc = null;
    clearSnsShareBlobCache();
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
    if (!isAiDietReportReady(_currentDate)) {
        setSnsShareButton(false);
    }
}

function renderEmpty(dateStr, mealCount) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    if (mealCount < 2) {
        body.innerHTML = `
            <div class="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
                <p class="text-sm font-bold text-slate-700">분석 조건 미충족</p>
                <p class="text-xs text-slate-500 mt-2 leading-relaxed">해당 날짜에 식사·간식 기록이 <strong class="text-slate-700">2건 이상</strong> 있어야 AI 분석을 받을 수 있어요.<br>현재 ${mealCount}건</p>
            </div>`;
        _currentReport = null;
        clearSnsShareBlobCache();
        setModalSubtitle('');
        setFooterButtons({ regen: false, share: false });
        setSnsShareButton(false);
        return;
    }
    body.innerHTML = `
        <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center">
            <i data-lucide="sparkles" class="text-2xl text-emerald-500 mb-3" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-700">아직 AI 리포트가 없어요</p>
            <p class="text-xs text-slate-500 mt-2 leading-relaxed">아래 버튼으로 지금 바로 분석할 수 있어요.</p>
            <button type="button" id="dietReportAnalyzeNowBtn" class="mealog-btn mealog-btn-primary mt-4 mx-auto min-w-[10rem]">
                지금 분석하기
            </button>
        </div>`;
    document.getElementById('dietReportAnalyzeNowBtn')?.addEventListener('click', () => {
        void runRegenerate(dateStr);
    });
    _currentReport = null;
    _currentReportDoc = null;
    clearSnsShareBlobCache();
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
    setSnsShareButton(false);
}

function renderError(message) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    body.innerHTML = `
        <div class="rounded-xl border border-red-200 bg-red-50 p-5 text-center">
            <p class="text-sm font-bold text-red-700">분석에 실패했어요</p>
            <p class="text-xs text-red-600/90 mt-2 leading-relaxed">${escapeHtml(message || '잠시 후 다시 시도해 주세요.')}</p>
        </div>`;
    _currentReport = null;
    _currentReportDoc = null;
    clearSnsShareBlobCache();
    setModalSubtitle('');
    setFooterButtons({ regen: true, share: false });
    setSnsShareButton(false);
}

function renderReport(data) {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;

    const source = extractAiMealReportSource(data);
    const report = parseAiMealReport(source);
    _currentReport = report;
    _currentReportDoc = data;
    const cardHtml = report
        ? renderAiMealReportCardHtml(report, escapeHtml, {
              photoUrls: extractAnalyzedPhotoUrlsForDisplay(data)
          })
        : renderAiMealReportCardHtml(null, escapeHtml);
    const generatedLabel = formatReportGeneratedAt(data?.generatedAt);
    const reportDate = data?.date || _currentDate;
    const momentShare = findDietReportMomentShare(
        reportDate,
        window.currentUser?.uid,
        getSharedPhotos()
    );

    body.innerHTML = `
        <div class="space-y-2">
            ${cardHtml}
        </div>`;

    setModalSubtitle(generatedLabel ? `생성 ${generatedLabel}` : '');
    setFooterButtons({
        regen: true,
        share: !!report,
        shareMode: momentShare ? 'unshare' : 'share'
    });
    setSnsShareButton(!!report);
    void refreshSnsShareBlobCache(reportDate, report, data);
}

async function fetchReportDoc(dateStr) {
    const uid = window.currentUser?.uid;
    if (!uid) return null;
    const snap = await getDoc(doc(db, 'artifacts', appId, 'aiDietReports', reportDocId(uid, dateStr)));
    return snap.exists() ? snap.data() : null;
}

async function runRegenerate(dateStr) {
    if (_loading || !dateStr) return;
    if (countAnalyzableMealsForDate(dateStr) < 2) {
        showToast('식사·간식 기록이 2건 이상 있어야 분석할 수 있어요.', 'info');
        renderEmpty(dateStr, countAnalyzableMealsForDate(dateStr));
        return;
    }
    _loading = true;
    renderLoading('writing');
    try {
        const res = await callableFunctions.regenerateDietReport({ date: dateStr });
        const report = res?.data?.report;
        if (report?.status === 'ready') {
            const saved = await fetchReportDoc(dateStr);
            renderReport(saved || report);
            setAiDietReportReady(dateStr, true);
            updateAiDietReportButtonsInTimeline();
            showToast('AI 식단 분석이 완료되었어요.', 'success');
        } else {
            const saved = await fetchReportDoc(dateStr);
            if (saved?.status === 'ready') {
                renderReport(saved);
                setAiDietReportReady(dateStr, true);
                updateAiDietReportButtonsInTimeline();
            } else if (saved?.status === 'error') renderError(saved.errorMessage);
            else renderError('분석 결과를 받지 못했습니다.');
        }
    } catch (e) {
        console.error('regenerateDietReport failed', e);
        const msg = e?.message || String(e);
        if (msg.includes('resource-exhausted')) {
            showToast('방금 분석했어요. 잠시 후 다시 시도해 주세요.', 'info');
        } else if (msg.includes('failed-precondition')) {
            showToast('분석 조건을 확인해 주세요.', 'info');
        } else {
            showToast('AI 분석에 실패했습니다.', 'error');
        }
        const saved = await fetchReportDoc(dateStr).catch(() => null);
        if (saved?.status === 'ready') {
            renderReport(saved);
            setAiDietReportReady(dateStr, true);
            updateAiDietReportButtonsInTimeline();
        } else renderError(msg);
    } finally {
        _loading = false;
    }
}

export async function openDietReportModal(dateStr) {
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (!isAiDietReportDateVisible(dateStr)) {
        console.warn('[dietReport] date not visible for report', { dateStr, today: toLocalDateString(new Date()) });
        showToast('이 날짜는 아직 리포트를 볼 수 없어요.', 'info');
        return;
    }

    _currentDate = dateStr;
    const title = document.getElementById('dietReportModalTitle');
    if (title) title.textContent = `AI 식단분석 · ${formatMealogDateLabel(dateStr)}`;

    setModalVisible(true);
    void getShareCaptureFontCss();

    const mealCount = countAnalyzableMealsForDate(dateStr);
    if (mealCount < 2) {
        renderEmpty(dateStr, mealCount);
        setAiDietReportReady(dateStr, false);
        updateAiDietReportButtonsInTimeline();
        return;
    }

    if (isAiDietReportReady(dateStr)) {
        setSnsShareButton(true);
    }

    renderLoading('fetch');
    try {
        const data = await fetchReportDoc(dateStr);
        if (data?.status === 'ready') {
            renderReport(data);
            setAiDietReportReady(dateStr, true);
            updateAiDietReportButtonsInTimeline();
        } else if (data?.status === 'error') {
            renderError(data.errorMessage);
            setAiDietReportReady(dateStr, false);
            updateAiDietReportButtonsInTimeline();
        } else {
            renderEmpty(dateStr, mealCount);
            setAiDietReportReady(dateStr, false);
            updateAiDietReportButtonsInTimeline();
        }
    } catch (e) {
        console.error('openDietReportModal load failed', e);
        renderError(e?.message || String(e));
    }
}

export function closeDietReportModal() {
    _currentDate = '';
    _loading = false;
    _currentReport = null;
    _currentReportDoc = null;
    clearSnsShareBlobCache();
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
    setSnsShareButton(false);
    setModalVisible(false);
}

async function resolveCaptureImageDataUrl(img) {
    if (img.src.includes('firebasestorage.googleapis.com')) {
        const result = await callableFunctions.getStorageImageAsBase64({ imageUrl: img.src });
        return result?.data?.dataUrl || null;
    }
    const res = await fetch(img.src, { mode: 'cors' });
    const blob = await res.blob();
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

function applyDataUrlToCaptureImage(img, dataUrl) {
    return new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('이미지 로드 실패'));
        img.src = dataUrl;
        if (img.complete && img.naturalWidth > 0) resolve();
    });
}

/** Firebase Storage URL → base64 (html2canvas CORS taint 방지) — 사진 병렬 변환 */
async function hydrateCaptureImagesAsBase64(root) {
    if (!root) return;
    const imgs = [...root.querySelectorAll('img[src^="http"]')];
    await Promise.all(
        imgs.map(async (img) => {
            try {
                const dataUrl = await resolveCaptureImageDataUrl(img);
                if (!dataUrl) return;
                await applyDataUrlToCaptureImage(img, dataUrl);
            } catch (e) {
                console.warn('diet report share image base64 failed:', e);
            }
        })
    );
}

/** html2canvas 캡처 대상 — mood 외부 위치만 보정 (pill 내부는 패딩으로 처리) */
function applyDietReportCaptureAlignFix(root) {
    if (!root?.querySelector) return;

    const badge = root.querySelector('[data-diet-report-capture-badge]');
    if (badge) {
        badge.style.display = 'inline-block';
        badge.style.lineHeight = '1';
        badge.style.padding = '4px 12px';
    }

    const mood = root.querySelector('[data-diet-report-capture-mood]');
    if (mood) {
        mood.style.position = 'relative';
        mood.style.top = `${DIET_REPORT_CAPTURE_MOOD_OFFSET_Y_PX}px`;
        mood.style.display = 'inline-block';
        mood.style.lineHeight = '1';
        mood.style.padding = '4px 10px';
    }
}

/** SNS 공유 캡처 헤더 — 타임라인 AI 리포트 버튼과 동일한 pill */
function buildDietReportShareCaptureBadgeHtml() {
    const colors =
        'font-size:11px;font-weight:700;color:#2d9f74;background:#ecfdf5;border:1px solid #bbf7d0;';
    return `<span data-diet-report-capture-badge="1" style="${buildDietReportCapturePillStyle('4px 12px', colors)}">✨AI식단분석</span>`;
}

/** 리포트 카드 → 캡처용 인라인 스타일 HTML */
function buildDietReportShareCaptureHtml(report, dateStr, esc, photoUrls = []) {
    const e = typeof esc === 'function' ? esc : (s) => s;
    const dateLabel = formatMealogDateLabel(dateStr);
    const score = report?.score;
    const hasScore = score != null && Number.isFinite(Number(score));
    const mood = (report?.mood || '').trim();
    const title = (report?.title || '').trim();
    const summary = (report?.summary || '').trim();
    const highlight = (report?.highlight || '').trim();
    const nudge = (report?.nudge || '').trim();

    const moodColors =
        'font-size:12px;font-weight:700;background:#ede9fe;color:#5b21b6;border:1px solid #ddd6fe;';
    const moodPill = mood
        ? `<span data-diet-report-capture-mood="1" style="${dietReportCaptureYOffsetStyle(DIET_REPORT_CAPTURE_MOOD_OFFSET_Y_PX)}margin-left:${DIET_REPORT_CAPTURE_MOOD_GAP_PX}px;${buildDietReportCapturePillStyle('4px 10px', moodColors)}">${e(mood)}</span>`
        : '';
    const scoreSpan = hasScore
        ? `<span style="display:inline-block;font-size:40px;font-weight:800;color:#3cb889;line-height:1;">${e(String(score))}<span style="font-size:20px;font-weight:700;color:rgba(16,185,129,0.65);">점</span></span>`
        : '';
    // 1행: 점수 + 타이틀(mood) — 인라인 배치(테이블은 html2canvas에서 전체 너비로 늘어남)
    const scoreRow =
        scoreSpan || moodPill
            ? `<div style="line-height:1;white-space:nowrap;">${scoreSpan}${moodPill}</div>`
            : '';
    // 2행: 제목(report.title)
    const subjectHtml = title
        ? `<div style="font-size:17px;font-weight:800;color:#1e293b;line-height:1.35;">${e(title)}</div>`
        : '';
    const summaryHtml = summary
        ? `<div><div style="font-size:10px;font-weight:700;letter-spacing:0.04em;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">오늘의 식사 흐름</div><div style="font-size:13.5px;color:#334155;line-height:1.5;">${e(summary)}</div></div>`
        : '';
    const highlightHtml = highlight
        ? `<div style="border-radius:12px;background:#ecfdf5;border:1px solid #d1fae5;padding:10px 12px;"><div style="font-size:11px;font-weight:700;color:#2d9f74;margin-bottom:3px;">좋았던 흐름</div><div style="font-size:13.5px;color:#1e293b;line-height:1.5;">${e(highlight)}</div></div>`
        : '';
    const nudgeHtml = nudge
        ? `<div style="border-radius:12px;background:#fffbeb;border:1px solid #fef3c7;padding:10px 12px;"><div style="font-size:11px;font-weight:700;color:#78350f;margin-bottom:3px;">내일의 힌트</div><div style="font-size:13.5px;color:#1e293b;line-height:1.5;">${e(nudge)}</div></div>`
        : '';

    const urls = (photoUrls || []).filter(Boolean).slice(0, 3);
    const thumb = DIET_REPORT_SHARE_PHOTO_THUMB_PX;
    const gap = DIET_REPORT_SHARE_PHOTO_GAP_PX;
    const photosHtml = urls.length
        ? `<div style="display:flex;justify-content:flex-start;gap:${gap}px;padding:6px 16px 2px;background:#f8fafc;">${urls
              .map(
                  (url) =>
                      `<div style="width:${thumb}px;height:${thumb}px;flex-shrink:0;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;background:#f1f5f9;">
                    <img src="${e(url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">
                </div>`
              )
              .join('')}</div>`
        : '';

    return `
    <div style="width:420px;background:#ffffff;border:1px solid #cbd5e1;border-radius:20px;overflow:hidden;font-family:Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;box-sizing:border-box;">
        <div style="background:#ffffff;padding:12px 16px 14px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:visible;">
            <div style="min-width:0;white-space:nowrap;line-height:1;overflow:visible;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-spacing:0;width:auto;display:inline-table;"><tr>
                    <td style="vertical-align:middle;padding:0;line-height:1;"><span style="display:inline-block;font-size:26px;font-weight:600;color:#3cb889;font-family:'Fredoka',sans-serif;letter-spacing:-0.5px;line-height:1.15;">mealog</span></td>
                    <td style="vertical-align:middle;padding:${DIET_REPORT_CAPTURE_BADGE_OFFSET_Y_PX}px 0 0 10px;line-height:1;">${buildDietReportShareCaptureBadgeHtml()}</td>
                </tr></table>
            </div>
            <span style="font-size:12px;color:#64748b;line-height:1.35;flex-shrink:0;text-align:right;">${e(dateLabel)}</span>
        </div>
        ${photosHtml}
        <div style="padding:10px 18px 18px;display:flex;flex-direction:column;gap:10px;background:#ffffff;">
            ${scoreRow}
            ${subjectHtml}
            ${summaryHtml}
            ${highlightHtml}
            ${nudgeHtml}
        </div>
    </div>`;
}

async function unshareDietReportFromMoment(dateStr, existingShare) {
    if (!existingShare?.photoUrl) return;
    closeDietReportModal();
    const photoUrl = existingShare.photoUrl;
    const ok = await unshareWithOptimisticUpdate({
        photos: [photoUrl],
        shareType: 'insight',
        matches: (p) =>
            !!p &&
            isDietReportInsightShare(p) &&
            p.userId === window.currentUser?.uid &&
            (p.dateRangeText === existingShare.dateRangeText || p.photoUrl === photoUrl)
    });
    if (ok) showToast('모먼트 공유를 취소했어요.', 'success');
}

async function captureDietReportShareCanvas(dateStr, report, reportDoc) {
    const photoUrls = reportDoc ? extractAnalyzedPhotoUrlsForDisplay(reportDoc) : [];
    const holder = document.createElement('div');
    holder.style.position = 'fixed';
    holder.style.left = '-10000px';
    holder.style.top = '0';
    holder.style.zIndex = '-1';
    holder.innerHTML = buildDietReportShareCaptureHtml(report, dateStr, escapeHtml, photoUrls);
    const target = holder.firstElementChild;
    document.body.appendChild(holder);

    try {
        const [fontCSS] = await Promise.all([
            getShareCaptureFontCss(),
            hydrateCaptureImagesAsBase64(target),
            document.fonts.ready
        ]);

        applyDietReportCaptureAlignFix(target);

        return await captureWithGhostStrategy(target, {
            captureWidth: 420,
            scale: DIET_REPORT_SHARE_CAPTURE_SCALE,
            onclone: (clonedDoc) => {
                if (fontCSS) {
                    const style = clonedDoc.createElement('style');
                    style.textContent = fontCSS;
                    clonedDoc.head.appendChild(style);
                }
                applyDietReportCaptureAlignFix(clonedDoc.body || clonedDoc.documentElement || clonedDoc);
            }
        });
    } finally {
        if (holder.parentNode) holder.parentNode.removeChild(holder);
    }
}

async function performDietReportMomentShare(dateStr, report, reportDoc) {
    if (_sharing) return;
    _sharing = true;

    try {
        const canvas = await captureDietReportShareCanvas(dateStr, report, reportDoc);
        const base64Image = canvas.toDataURL('image/png');
        const photoUrl = await uploadBase64ToStorage(
            base64Image,
            window.currentUser.uid,
            `dietreport_${dateStr}`,
            1024
        );

        const dateRangeText = getDietReportShareDateRangeText(dateStr);
        const res = await callableFunctions.createInsightShare({
            photoUrl,
            dateRangeText,
            comment: '',
            date: dateStr
        });

        if (res?.data) {
            setSharedPhotos(getSharedPhotos().filter(
                (p) =>
                    !(
                        p &&
                        isDietReportInsightShare(p) &&
                        p.userId === window.currentUser.uid &&
                        (p.dateRangeText === dateRangeText || p.date === dateStr)
                    )
            ));
            getSharedPhotos().push(res.data);
        }

        showToast('AI 리포트를 모먼트에 공유했어요.', 'success');
    } catch (e) {
        console.error('performDietReportMomentShare failed', e);
        showToast(e?.message || e?.details || '모먼트 공유에 실패했어요.', 'error');
    } finally {
        _sharing = false;
    }
}

async function shareDietReportToSns() {
    if (_sharing) return;
    if (!_currentReport || !_currentDate) {
        showToast('공유할 리포트가 없어요.', 'info');
        return;
    }

    const snsBtn = document.getElementById('dietReportSnsShareBtn');
    _sharing = true;

    try {
        if (!_snsShareBlob) {
            setSnsShareButtonPreparing(true);
            await refreshSnsShareBlobCache(_currentDate, _currentReport, _currentReportDoc);
            setSnsShareButtonPreparing(false);
        }
        if (!_snsShareBlob) {
            showToast('공유 이미지를 만들지 못했어요.', 'error');
            return;
        }

        if (snsBtn) snsBtn.disabled = true;
        await shareBlobsToExternal([_snsShareBlob], {
            appendLogo: false,
            resize: false,
            fileNamePrefix: `mealog_ai_diet_${_currentDate}`
        });
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.error('shareDietReportToSns failed', e);
            showToast(e?.message || 'SNS 공유에 실패했어요.', 'error');
        }
    } finally {
        _sharing = false;
        setSnsShareButtonPreparing(false);
        if (snsBtn && !_snsShareCachePromise) snsBtn.disabled = false;
    }
}

async function shareDietReportToMoment() {
    if (_sharing) return;
    if (!window.currentUser || window.currentUser.isAnonymous) {
        showToast('로그인이 필요합니다.', 'error');
        return;
    }
    if (!_currentReport || !_currentDate) {
        showToast('공유할 리포트가 없어요.', 'info');
        return;
    }

    const dateStr = _currentDate;
    const existingShare = findDietReportMomentShare(
        dateStr,
        window.currentUser.uid,
        getSharedPhotos()
    );

    if (existingShare) {
        void unshareDietReportFromMoment(dateStr, existingShare);
        return;
    }

    const report = _currentReport;
    const reportDoc = _currentReportDoc;
    closeDietReportModal();
    showToast('AI분석 리포트를 공유합니다', 'info');
    void performDietReportMomentShare(dateStr, report, reportDoc);
}

window.openDietReportModal = openDietReportModal;
window.closeDietReportModal = closeDietReportModal;

document.getElementById('dietReportBackdrop')?.addEventListener('click', () => {
    closeDietReportModal();
});
document.getElementById('dietReportCloseBtn')?.addEventListener('click', () => {
    closeDietReportModal();
});
document.getElementById('dietReportRegenerateBtn')?.addEventListener('click', () => {
    if (_currentDate) void runRegenerate(_currentDate);
});
document.getElementById('dietReportShareBtn')?.addEventListener('click', () => {
    void shareDietReportToMoment();
});
document.getElementById('dietReportSnsShareBtn')?.addEventListener('click', () => {
    void shareDietReportToSns();
});

let _dietReportTimelineBound = false;
/** #timelineContainer 자체가 아닌 document에 위임 — 일간 스와이프 등으로 컨테이너 리스너가 무반응이 되는 케이스 대비 (timeline.js의 ensureTimelineOpenModalDelegation과 동일 패턴) */
function bindDietReportTimelineDelegation() {
    if (_dietReportTimelineBound) return;
    _dietReportTimelineBound = true;
    document.addEventListener('click', (e) => {
        const root = document.getElementById('timelineContainer');
        if (!root) return;
        const btn = e.target.closest('button[data-mealog-diet-report]');
        if (!btn || !root.contains(btn)) return;
        const dateStr = btn.getAttribute('data-mealog-date') || '';
        if (!dateStr) return;
        e.preventDefault();
        e.stopPropagation();
        void openDietReportModal(dateStr);
    });
}

bindDietReportTimelineDelegation();
window.bindDietReportTimelineDelegation = bindDietReportTimelineDelegation;
