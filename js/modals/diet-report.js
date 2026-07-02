/**
 * 밀로그 날짜별 AI 식단분석 리포트 팝업
 */
import { db, appId, callableFunctions } from '../firebase.js';
import { dbOps } from '../db.js';
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
import { toLocalDateString, captureWithGhostStrategy, uploadBase64ToStorage } from '../utils.js';
import { MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS } from '../constants.js';
import {
    findDietReportMomentShare,
    getDietReportShareDateRangeText,
    isDietReportInsightShare
} from '../utils/diet-report-share.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

let _currentDate = '';
let _loading = false;
let _sharing = false;
/** 현재 모달에 표시 중인 리포트(파싱 결과) — 모먼트 공유 캡처용 */
let _currentReport = null;
/** Firestore 원문(분석 사진 URL 등) — 모먼트 공유 캡처용 */
let _currentReportDoc = null;

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
        <i class="fa-solid fa-wand-magic-sparkles text-[10px]" aria-hidden="true"></i>AI 리포트
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
    if (!modal) return;
    modal.classList.toggle('hidden', !visible);
    document.body.classList.toggle('diet-report-modal-open', visible);
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

const DIET_REPORT_SHARE_BTN_BASE =
    'flex-1 flex flex-col items-center justify-center gap-0.5 px-2 py-2.5 border-l border-slate-200 transition-colors disabled:opacity-60 min-w-0';

/** 하단 3종세트형 버튼(다시 분석·모먼트 공유) 표시/상태 제어 */
function setFooterButtons({ regen = false, share = false, regenLabel = '다시 분석', shareMode = 'share' } = {}) {
    const regenBtn = document.getElementById('dietReportRegenerateBtn');
    if (regenBtn) {
        regenBtn.classList.toggle('hidden', !regen);
        regenBtn.disabled = false;
        const main = regenBtn.querySelector('.diet-report-btn-main');
        if (main) main.textContent = regenLabel;
    }
    const shareBtn = document.getElementById('dietReportShareBtn');
    if (shareBtn) {
        shareBtn.classList.toggle('hidden', !share);
        shareBtn.disabled = false;
        const main = shareBtn.querySelector('.diet-report-btn-main');
        const sub = shareBtn.querySelector('.diet-report-btn-sub');
        if (shareMode === 'unshare') {
            shareBtn.className = `${DIET_REPORT_SHARE_BTN_BASE} bg-rose-50 text-rose-700 hover:bg-rose-100/90 active:bg-rose-100`;
            if (main) main.textContent = '공유 취소';
            if (sub) {
                sub.textContent = '피드에서 내리기';
                sub.className = 'diet-report-btn-sub text-[11px] text-rose-600/90 font-medium';
            }
        } else {
            shareBtn.className = `${DIET_REPORT_SHARE_BTN_BASE} bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800`;
            if (main) main.textContent = '모먼트 공유';
            if (sub) {
                sub.textContent = '피드에 공유';
                sub.className = 'diet-report-btn-sub text-[11px] text-white/80 font-medium';
            }
        }
    }
}

function renderLoading(mode = 'fetch') {
    const body = document.getElementById('dietReportModalBody');
    if (!body) return;
    const label = mode === 'writing' ? '리포트 작성중' : '리포트 불러오는 중…';
    body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-10 text-slate-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-3" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-500">${label}</p>
        </div>`;
    _currentReport = null;
    _currentReportDoc = null;
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
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
        setModalSubtitle('');
        setFooterButtons({ regen: false, share: false });
        return;
    }
    body.innerHTML = `
        <div class="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center">
            <i class="fa-solid fa-wand-magic-sparkles text-2xl text-emerald-500 mb-3" aria-hidden="true"></i>
            <p class="text-sm font-bold text-slate-700">아직 AI 리포트가 없어요</p>
            <p class="text-xs text-slate-500 mt-2 leading-relaxed">아래 버튼으로 지금 바로 분석할 수 있어요.</p>
            <button type="button" id="dietReportAnalyzeNowBtn" class="mt-4 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-xl transition-colors">
                지금 분석하기
            </button>
        </div>`;
    document.getElementById('dietReportAnalyzeNowBtn')?.addEventListener('click', () => {
        void runRegenerate(dateStr);
    });
    _currentReport = null;
    _currentReportDoc = null;
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
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
    setModalSubtitle('');
    setFooterButtons({ regen: true, share: false });
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
        window.sharedPhotos
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
    if (!isAiDietReportDateVisible(dateStr)) return;

    _currentDate = dateStr;
    const title = document.getElementById('dietReportModalTitle');
    if (title) title.textContent = `AI 식단분석 · ${formatMealogDateLabel(dateStr)}`;

    setModalVisible(true);

    const mealCount = countAnalyzableMealsForDate(dateStr);
    if (mealCount < 2) {
        renderEmpty(dateStr, mealCount);
        setAiDietReportReady(dateStr, false);
        updateAiDietReportButtonsInTimeline();
        return;
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
    setModalSubtitle('');
    setFooterButtons({ regen: false, share: false });
    setModalVisible(false);
}

/** Firebase Storage URL → base64 (html2canvas CORS taint 방지, 인사이트 공유와 동일) */
async function hydrateCaptureImagesAsBase64(root) {
    if (!root) return;
    const imgs = root.querySelectorAll('img[src^="http"]');
    const loadPromises = [];
    for (const img of imgs) {
        try {
            if (img.src.includes('firebasestorage.googleapis.com')) {
                const result = await callableFunctions.getStorageImageAsBase64({ imageUrl: img.src });
                const dataUrl = result?.data?.dataUrl;
                if (!dataUrl) continue;
                loadPromises.push(
                    new Promise((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error('이미지 로드 실패'));
                        img.src = dataUrl;
                        if (img.complete && img.naturalWidth > 0) resolve();
                    })
                );
            } else {
                const res = await fetch(img.src, { mode: 'cors' });
                const blob = await res.blob();
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                loadPromises.push(
                    new Promise((resolve, reject) => {
                        img.onload = () => resolve();
                        img.onerror = () => reject(new Error('이미지 로드 실패'));
                        img.src = dataUrl;
                        if (img.complete && img.naturalWidth > 0) resolve();
                    })
                );
            }
        } catch (e) {
            console.warn('diet report share image base64 failed:', e);
        }
    }
    await Promise.all(loadPromises).catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
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

    const moodPill = mood
        ? `<span style="display:inline-block;padding:4px 10px;border-radius:9999px;background:#ede9fe;color:#5b21b6;font-size:12px;font-weight:700;border:1px solid #ddd6fe;">${e(mood)}</span>`
        : '';
    const topRow = hasScore
        ? `<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
                <span style="font-size:40px;font-weight:800;color:#059669;line-height:1;">${e(String(score))}<span style="font-size:20px;font-weight:700;color:rgba(16,185,129,0.65);">점</span></span>
                ${moodPill}
           </div>`
        : (moodPill ? `<div>${moodPill}</div>` : '');
    const titleHtml = title
        ? `<div style="font-size:17px;font-weight:800;color:#1e293b;line-height:1.35;">${e(title)}</div>`
        : '';
    const summaryHtml = summary
        ? `<div><div style="font-size:10px;font-weight:700;letter-spacing:0.04em;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">오늘의 식사 흐름</div><div style="font-size:13.5px;color:#334155;line-height:1.5;">${e(summary)}</div></div>`
        : '';
    const highlightHtml = highlight
        ? `<div style="border-radius:12px;background:#ecfdf5;border:1px solid #d1fae5;padding:10px 12px;"><div style="font-size:11px;font-weight:700;color:#047857;margin-bottom:3px;">좋았던 흐름</div><div style="font-size:13.5px;color:#1e293b;line-height:1.5;">${e(highlight)}</div></div>`
        : '';
    const nudgeHtml = nudge
        ? `<div style="border-radius:12px;background:#fffbeb;border:1px solid #fef3c7;padding:10px 12px;"><div style="font-size:11px;font-weight:700;color:#78350f;margin-bottom:3px;">내일의 힌트</div><div style="font-size:13.5px;color:#1e293b;line-height:1.5;">${e(nudge)}</div></div>`
        : '';

    const urls = (photoUrls || []).filter(Boolean).slice(0, 3);
    const photosHtml = urls.length
        ? `<div style="display:flex;gap:0;width:100%;background:#f1f5f9;">${urls
              .map(
                  (url) =>
                      `<div style="flex:1;min-width:0;aspect-ratio:1;overflow:hidden;">
                    <img src="${e(url)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">
                </div>`
              )
              .join('')}</div>`
        : '';

    return `
    <div style="width:420px;background:#ffffff;border:1px solid #cbd5e1;border-radius:20px;overflow:hidden;font-family:Pretendard,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;box-sizing:border-box;">
        <div style="background:#ffffff;padding:14px 18px 12px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span style="font-size:26px;font-weight:600;color:#059669;font-family:'Fredoka',sans-serif;letter-spacing:-0.5px;line-height:1.2;">mealog</span>
            <span style="font-size:12px;color:#64748b;line-height:1.35;">${e(dateLabel)}</span>
        </div>
        ${photosHtml}
        <div style="padding:16px 18px 18px;display:flex;flex-direction:column;gap:12px;background:#ffffff;">
            ${topRow}
            ${titleHtml}
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
    const prevShared = window.sharedPhotos ? [...window.sharedPhotos] : [];
    if (window.sharedPhotos && Array.isArray(window.sharedPhotos)) {
        window.sharedPhotos = window.sharedPhotos.filter(
            (p) =>
                !(
                    p &&
                    isDietReportInsightShare(p) &&
                    p.userId === window.currentUser?.uid &&
                    (p.dateRangeText === existingShare.dateRangeText || p.photoUrl === photoUrl)
                )
        );
    }
    try {
        await dbOps.unsharePhotos([photoUrl], null, false, false, true);
        showToast('모먼트 공유를 취소했어요.', 'success');
    } catch (e) {
        console.error('unshareDietReportFromMoment failed', e);
        if (window.sharedPhotos) window.sharedPhotos = prevShared;
    }
}

async function performDietReportMomentShare(dateStr, report, reportDoc) {
    if (_sharing) return;
    _sharing = true;

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
        await hydrateCaptureImagesAsBase64(target);
        await document.fonts.ready;
        let fontCSS = '';
        try {
            const fredokaRes = await fetch('https://fonts.googleapis.com/css2?family=Fredoka:wght@600&display=swap');
            fontCSS = (await fredokaRes.text()) + MEALOG_SHARE_CAPTURE_GARAM_FONT_FACE_CSS;
        } catch (_) {
            /* ignore */
        }

        const canvas = await captureWithGhostStrategy(target, {
            captureWidth: 420,
            onclone: (clonedDoc) => {
                if (fontCSS) {
                    const style = clonedDoc.createElement('style');
                    style.textContent = fontCSS;
                    clonedDoc.head.appendChild(style);
                }
            }
        });

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
            if (!Array.isArray(window.sharedPhotos)) window.sharedPhotos = [];
            window.sharedPhotos = window.sharedPhotos.filter(
                (p) =>
                    !(
                        p &&
                        isDietReportInsightShare(p) &&
                        p.userId === window.currentUser.uid &&
                        (p.dateRangeText === dateRangeText || p.date === dateStr)
                    )
            );
            window.sharedPhotos.push(res.data);
        }

        showToast('AI 리포트를 모먼트에 공유했어요.', 'success');
    } catch (e) {
        console.error('performDietReportMomentShare failed', e);
        showToast(e?.message || e?.details || '모먼트 공유에 실패했어요.', 'error');
    } finally {
        if (holder.parentNode) holder.parentNode.removeChild(holder);
        _sharing = false;
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
        window.sharedPhotos
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

document.getElementById('dietReportRegenerateBtn')?.addEventListener('click', () => {
    if (_currentDate) void runRegenerate(_currentDate);
});

document.getElementById('dietReportShareBtn')?.addEventListener('click', () => {
    void shareDietReportToMoment();
});

const _dietReportTimelineBound = new WeakMap();
function bindDietReportTimelineDelegation() {
    const root = document.getElementById('timelineContainer');
    if (!root || _dietReportTimelineBound.has(root)) return;
    _dietReportTimelineBound.set(root, true);
    root.addEventListener('click', (e) => {
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
