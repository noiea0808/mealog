// UI 관련 함수들
import {
    getLoadingSpinnerConfig,
    applyLoadingFoodIconDurationSeconds,
    clearLoadingFoodIconInlineAnimation,
    getSpinnerMessageStepMs,
} from './loading-spinner-config.js';
import { isDemoUser } from './demo-account.js';
import { fetchLatestReadyDietReport, fetchReadyDietReportDates, fetchReadyDietReportByDate } from './utils/diet-report-latest.js';
import {
    parseAiMealReport,
    extractAiMealReportSource,
    renderAiMealReportCardHtml,
    extractAnalyzedPhotoUrlsForDisplay
} from './utils/ai-meal-report.js';
import { escapeHtml } from './render/utils.js';
import { formatMealogDateLabel } from './utils/date-label.js';
import { lockBodyScroll, unlockBodyScroll } from './utils/scroll-lock.js';
import { getProfileAvatarDisplay } from './utils.js';
import { scheduleLucideIcons } from './icons.js';

/** 출석 환영 차트만 charts 모듈을 지연 로드 (밀당 전체 그래프와 분리) */
let _welcomeChartsModPromise = null;
function loadWelcomeChartsMod() {
    if (!_welcomeChartsModPromise) {
        _welcomeChartsModPromise = import('./analytics/charts.js');
    }
    return _welcomeChartsModPromise;
}

// 로딩 오버레이 중앙 관리
let loadingOverlayTimeout = null;
let loadingHideTimeout = null; // hideLoading 지연용
let loadingShownAt = 0; // 메시지 표시 시 최소 표시 시간용
let loadingSpinnerMsgTimer = null;
let initialRecordsLoadFabClickBound = false;

function stopLoadingSpinnerMessageCycle() {
    if (loadingSpinnerMsgTimer) {
        clearInterval(loadingSpinnerMsgTimer);
        loadingSpinnerMsgTimer = null;
    }
}

function ensureInitialRecordsLoadFabClickHandler() {
    const fab = document.getElementById('initialRecordsLoadFab');
    if (!fab || initialRecordsLoadFabClickBound) return;
    initialRecordsLoadFabClickBound = true;
    fab.addEventListener('click', () => {
        if (fab.classList.contains('hidden')) return;
        const msg = fab.getAttribute('aria-label') || '기록을 불러오고 있어요';
        showToast(msg, 'info');
    });
}

export function showLoading(message = '', options = {}) {
    const { dimBackground = true, skipOnLoginScreen = true, recordsFab = false } = options;
    const mainApp = document.getElementById('mainApp');
    const isOnLoginScreen = mainApp && mainApp.classList.contains('hidden');
    if (skipOnLoginScreen && isOnLoginScreen) return;

    stopLoadingSpinnerMessageCycle();

    const fab = document.getElementById('initialRecordsLoadFab');
    const overlay = document.getElementById('loadingOverlay');
    const messageEl = document.getElementById('loadingOverlayMessage');
    const statusEl = document.getElementById('loadingOverlayStatus');

    /** 로그인 직후 기록(meals) 로딩 — 전면이 아니라 하단 FAB 크기·위치에서만 음식 아이콘 순환 */
    if (recordsFab && fab) {
        if (overlay) overlay.classList.add('hidden');
        fab.classList.remove('hidden');
        fab.removeAttribute('aria-hidden');
        fab.setAttribute('aria-busy', 'true');
        const label = (message && String(message).trim()) || '기록을 불러오고 있어요';
        fab.setAttribute('aria-label', label);
        fab.title = label;
        ensureInitialRecordsLoadFabClickHandler();
        loadingShownAt = Date.now();
        void getLoadingSpinnerConfig().then(() => {
            applyLoadingFoodIconDurationSeconds(undefined, overlay);
        });
        if (loadingOverlayTimeout) clearTimeout(loadingOverlayTimeout);
        loadingOverlayTimeout = setTimeout(() => {
            hideLoading();
            console.warn('⏱️ 로딩 타임아웃: 10초 후 자동으로 숨김');
        }, 10000);
        queueMicrotask(() => {
            import('./main/meal-sync-resend-header.js')
                .then((m) => {
                    if (typeof m.refreshMealSyncResendNavButton === 'function') m.refreshMealSyncResendNavButton();
                })
                .catch(() => {});
        });
        return;
    }

    if (fab) {
        fab.classList.add('hidden');
        fab.setAttribute('aria-hidden', 'true');
        fab.removeAttribute('aria-busy');
        fab.removeAttribute('title');
    }

    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.toggle('bg-white/55', dimBackground);
        overlay.classList.toggle('backdrop-blur-sm', dimBackground);
        overlay.classList.toggle('bg-transparent', !dimBackground);
        overlay.classList.toggle('pointer-events-none', !dimBackground);
        loadingShownAt = Date.now();
        if (messageEl) {
            messageEl.textContent = '';
            messageEl.style.display = 'block';
            messageEl.style.visibility = 'visible';
            messageEl.classList.remove('hidden');
        }
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.classList.add('hidden');
            statusEl.style.display = 'none';
        }
        void (async () => {
            const cfg = await getLoadingSpinnerConfig();
            /** 음식 아이콘 전환은 0.5초 고정. 순환 스크립트(문구)만 관리자 주기. */
            applyLoadingFoodIconDurationSeconds(undefined, overlay);
            if (!overlay || overlay.classList.contains('hidden') || !messageEl) return;
            const trimmed = message && String(message).trim() ? String(message).trim() : '';
            /** 위: 관리자 스피너 문구만 순환. 아래: showLoading()으로 넘긴 진행 상태(예: 카카오 로그인 처리 중). */
            const cmsRaw = Array.isArray(cfg.messages) ? cfg.messages : [];
            const merged = [];
            const pushUnique = (s) => {
                const t = typeof s === 'string' ? s.trim() : '';
                if (t && !merged.includes(t)) merged.push(t);
            };
            for (const m of cmsRaw) pushUnique(m);

            /** 관리자 > 스피너에 넣은 순환문구만 사용(보조·기본 문구 없음). */
            const lines = merged;
            /** 등록된 문구를 무작위 순서로 쓰되, 한 번 나온 문구는 남은 문구를 다 쓸 때까지 다시 나오지 않음(소진 후 풀을 다시 채움). */
            const makeNoRepeatRandomPicker = (all) => {
                let remaining = [];
                return () => {
                    if (remaining.length === 0) remaining = [...all];
                    const idx = Math.floor(Math.random() * remaining.length);
                    const [picked] = remaining.splice(idx, 1);
                    return picked;
                };
            };
            if (lines.length > 1) {
                const pickNext = makeNoRepeatRandomPicker(lines);
                messageEl.textContent = pickNext();
                messageEl.style.display = 'block';
                messageEl.style.visibility = 'visible';
                messageEl.classList.remove('hidden');
                const stepMs = getSpinnerMessageStepMs(cfg.messageCycleSeconds);
                loadingSpinnerMsgTimer = setInterval(() => {
                    messageEl.textContent = pickNext();
                }, stepMs);
            } else if (lines.length === 1) {
                messageEl.textContent = lines[0];
                messageEl.style.display = 'block';
                messageEl.style.visibility = 'visible';
                messageEl.classList.remove('hidden');
            } else {
                messageEl.textContent = '';
                messageEl.style.display = 'none';
                messageEl.classList.add('hidden');
            }
            if (statusEl) {
                if (trimmed) {
                    statusEl.textContent = trimmed;
                    statusEl.classList.remove('hidden');
                    statusEl.style.display = 'block';
                    statusEl.style.visibility = 'visible';
                } else {
                    statusEl.textContent = '';
                    statusEl.classList.add('hidden');
                    statusEl.style.display = 'none';
                }
            }
        })();
        if (loadingOverlayTimeout) clearTimeout(loadingOverlayTimeout);
        loadingOverlayTimeout = setTimeout(() => {
            hideLoading();
            console.warn('⏱️ 로딩 타임아웃: 10초 후 자동으로 숨김');
        }, 10000);
    }
}

export function hideLoading() {
    stopLoadingSpinnerMessageCycle();
    const overlay = document.getElementById('loadingOverlay');
    const messageEl = document.getElementById('loadingOverlayMessage');
    const statusEl = document.getElementById('loadingOverlayStatus');
    const fab = document.getElementById('initialRecordsLoadFab');
    if (!overlay && !fab) return;
    if (loadingHideTimeout) {
        clearTimeout(loadingHideTimeout);
        loadingHideTimeout = null;
    }
    const doHide = () => {
        clearLoadingFoodIconInlineAnimation();
        if (fab) {
            fab.classList.add('hidden');
            fab.setAttribute('aria-hidden', 'true');
            fab.removeAttribute('aria-busy');
            fab.removeAttribute('title');
        }
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.classList.add('bg-white/55');
            overlay.classList.add('backdrop-blur-sm');
            overlay.classList.remove('bg-transparent');
            overlay.classList.remove('pointer-events-none');
        }
        if (messageEl) {
            messageEl.textContent = '';
            messageEl.style.display = 'none';
        }
        if (statusEl) {
            statusEl.textContent = '';
            statusEl.classList.add('hidden');
            statusEl.style.display = 'none';
        }
        if (loadingOverlayTimeout) {
            clearTimeout(loadingOverlayTimeout);
            loadingOverlayTimeout = null;
        }
        loadingHideTimeout = null;
        try {
            if (typeof window.scheduleAttendanceCheckIfNeeded === 'function') {
                queueMicrotask(() => window.scheduleAttendanceCheckIfNeeded());
            }
        } catch (_) {
            /* ignore */
        }
    };
    const minShowMs = 500;
    const elapsed = Date.now() - loadingShownAt;
    const delay = loadingShownAt && elapsed < minShowMs ? minShowMs - elapsed : 0;
    if (delay > 0) {
        loadingHideTimeout = setTimeout(doHide, delay);
    } else {
        doHide();
    }
}

const TOAST_DURATION_MS = 3500;

/**
 * 기록 완료·웰컴(출석) 등 전면 중앙 팝업이 열려 있는지 — 이중 피드백 방지용
 */
function isFullScreenMealogOverlayVisible() {
    try {
        const sp = document.getElementById('successPopup');
        if (sp && !sp.classList.contains('hidden')) return true;
        const ap = document.getElementById('attendancePopup');
        if (ap && !ap.classList.contains('hidden')) return true;
    } catch (_) {
        /* ignore */
    }
    return false;
}

/**
 * 토스트 — type: error(빨강) | success(에메랄드) | info(슬레이트)
 * 전면 축하/웰컴 팝업과 겹치면 success·info 는 생략 (에러는 항상 표시)
 */
export function showToast(message, type = 'info') {
    if (!message) return;
    if (type !== 'error' && type !== 'success' && type !== 'info') return;
    if ((type === 'success' || type === 'info') && isFullScreenMealogOverlayVisible()) {
        return;
    }
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    const tone =
        type === 'error' ? 'mealog-toast--error' : type === 'success' ? 'mealog-toast--success' : 'mealog-toast--info';
    toast.className = `mealog-toast animate-toast ${tone}`;
    toast.textContent = message;
    container.appendChild(toast);
    const remove = () => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 200);
    };
    setTimeout(remove, TOAST_DURATION_MS);
}

let successPopupTimer = null;

function lockSuccessPopupScroll() {
    lockBodyScroll('successPopup');
}

function unlockSuccessPopupScroll() {
    unlockBodyScroll('successPopup');
}

function lockAttendancePopupScroll() {
    lockBodyScroll('attendancePopup');
}

function unlockAttendancePopupScroll() {
    unlockBodyScroll('attendancePopup');
}

/**
 * 기록 완료 중앙 팝업 (0.5초)
 * - 여러 번 호출되면 이전 타이머를 정리하고 애니메이션을 재시작한다.
 */
export function showSuccessPopup(message = '기록 완료', durationMs = 800) {
    const popup = document.getElementById('successPopup');
    const textEl = document.getElementById('successPopupText');
    const textSvg = document.getElementById('successPopupTextSvg');
    const confetti = document.getElementById('successPopupConfetti');
    if (!popup) return;

    if (successPopupTimer) {
        clearTimeout(successPopupTimer);
        successPopupTimer = null;
    }

    const line = String(message || '기록 완료!').trim() || '기록 완료!';
    if (textEl) textEl.textContent = line;

    /** 웰컴 팝업과 동일 단계별 최대 35px (260px 뷰 너비) */
    if (textEl && textSvg) {
        const maxLen = Math.max(line.length, 1);
        const fs =
            maxLen > 24 ? '22' : maxLen > 20 ? '26' : maxLen > 16 ? '31' : '35';
        const fsNum = Number(fs);
        const topPad = 6;
        const startY = topPad + Math.round(fsNum * 0.75);
        textEl.setAttribute('font-size', fs);
        textEl.setAttribute('y', String(startY));
        const vbH = Math.max(52, startY + Math.round(fsNum * 0.4) + 10);
        textSvg.setAttribute('viewBox', `0 0 260 ${vbH}`);
        textSvg.setAttribute('height', String(vbH));
    }

    // 애니메이션 재시작을 위해 클래스 토글 + reflow
    document.body.classList.remove('success-popup-anim');
    popup.classList.remove('hidden');
    void popup.offsetHeight;
    // 컨페티는 "보이는 상태"에서 좌표를 재서, 체크 아이콘 중심에서 사방으로 퍼지게 생성
    if (confetti) {
        confetti.innerHTML = '';
        const colors = ['#f97316', '#22c55e', '#3b82f6', '#f43f5e', '#a855f7', '#eab308', '#14b8a6'];
        const n = 22;
        const checkSvg = popup.querySelector?.('.success-check svg');
        const confettiRect = confetti.getBoundingClientRect?.();
        // 기준점: 체크 아이콘 중앙(컨페티 컨테이너 기준 좌표로 변환)
        let cx = (confettiRect?.width ?? window.innerWidth) / 2;
        let cy = (confettiRect?.height ?? window.innerHeight) / 2;
        try {
            const r = checkSvg?.getBoundingClientRect?.();
            if (r && confettiRect) {
                cx = (r.left + r.width / 2) - confettiRect.left;
                cy = (r.top + r.height / 2) - confettiRect.top;
            }
        } catch (_) {}
        for (let i = 0; i < n; i++) {
            const el = document.createElement('span');
            el.className = 'confetti-piece';
            const angle = Math.random() * Math.PI * 2;
            const dist = 70 + Math.random() * 160;
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist;
            const rot = (Math.random() * 2 - 1) * 360;
            const delay = Math.random() * 60;
            el.style.left = cx.toFixed(1) + 'px';
            el.style.top = cy.toFixed(1) + 'px';
            el.style.background = colors[i % colors.length];
            el.style.setProperty('--dx', dx.toFixed(1) + 'px');
            el.style.setProperty('--dy', dy.toFixed(1) + 'px');
            el.style.setProperty('--rot', rot.toFixed(1) + 'deg');
            el.style.animationDelay = delay.toFixed(0) + 'ms';
            confetti.appendChild(el);
        }
    }
    document.body.classList.add('success-popup-anim');
    lockSuccessPopupScroll();

    successPopupTimer = setTimeout(() => {
        document.body.classList.remove('success-popup-anim');
        popup.classList.add('hidden');
        if (confetti) confetti.innerHTML = '';
        unlockSuccessPopupScroll();
        successPopupTimer = null;
    }, Math.max(0, Number(durationMs) || 800));
}

/** 기록 완료 팝업을 즉시 닫음 (ESC 등) */
export function dismissSuccessPopup() {
    if (successPopupTimer) {
        clearTimeout(successPopupTimer);
        successPopupTimer = null;
    }
    const popup = document.getElementById('successPopup');
    const confetti = document.getElementById('successPopupConfetti');
    document.body.classList.remove('success-popup-anim');
    if (popup) popup.classList.add('hidden');
    if (confetti) confetti.innerHTML = '';
    unlockSuccessPopupScroll();
}

function ensureAttendancePopupCloseBound() {
    ['attendancePopupCloseBtn', 'attendancePopupCloseBtnBare'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn || btn.dataset.bound === '1') return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', closeAttendancePopup);
    });
}

const WELCOME_CHART_NS = 'http://www.w3.org/2000/svg';

function attendanceWelcomeEscapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function polarToCartesian(cx, cy, r, ang) {
    return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
}

function donutArcPath(cx, cy, rInner, rOuter, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0o, y0o] = polarToCartesian(cx, cy, rOuter, a0);
    const [x1o, y1o] = polarToCartesian(cx, cy, rOuter, a1);
    const [x0i, y0i] = polarToCartesian(cx, cy, rInner, a1);
    const [x1i, y1i] = polarToCartesian(cx, cy, rInner, a0);
    return `M ${x0o} ${y0o} A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o} ${y1o} L ${x0i} ${y0i} A ${rInner} ${rInner} 0 ${large} 0 ${x1i} ${y1i} Z`;
}

/** SVG 단일 호(360°)는 path 호가 비어 보일 수 있어 stroke 링으로 통일 */
function donutFullRingCircle(cx, cy, rInner, rOuter, fill) {
    const rStroke = (rInner + rOuter) / 2;
    const sw = rOuter - rInner;
    const safeFill = /^#[0-9A-Fa-f]{3,8}$/.test(String(fill || '')) ? String(fill) : '#94a3b8';
    return `<circle cx="${cx}" cy="${cy}" r="${rStroke}" fill="none" stroke="${safeFill}" stroke-width="${sw}" />`;
}

/** 도넛 링 위 라벨용 — 길면 말줄임(유니코드 안전) */
function truncateWelcomeRingLabel(str, maxChars) {
    const s = String(str ?? '').trim();
    if (!s) return '';
    const chars = [...s];
    if (chars.length <= maxChars) return s;
    return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

/**
 * 가운데 홀: (데이터 있음) 최근 7일 기록 + 어떻게·무엇을… / (없음) 안내. 링 위는 항목·%만.
 * @param {{ title: string, total: number, segments: { color: string, count: number, displayName: string, fraction: number }[] }} slide
 */
function buildAttendanceWelcomeDonutSvg(slide) {
    const { title: dimensionTitle, total, segments } = slide;
    const cx = 120;
    const cy = 120;
    const rOut = 114;
    const rIn = 44;
    const rMid = (rIn + rOut) / 2;

    const paths = [];
    if (!total || !segments.length) {
        paths.push(donutFullRingCircle(cx, cy, rIn, rOut, '#e2e8f0'));
    } else if (segments.length === 1 && segments[0].fraction >= 0.999) {
        const seg = segments[0];
        const fill = /^#[0-9A-Fa-f]{3,8}$/.test(String(seg.color || '')) ? String(seg.color) : '#94a3b8';
        paths.push(donutFullRingCircle(cx, cy, rIn, rOut, fill));
    } else {
        let a = -Math.PI / 2;
        for (const seg of segments) {
            const sweep = seg.fraction * Math.PI * 2;
            if (sweep <= 0.00001) {
                a += sweep;
                continue;
            }
            const a1 = a + sweep;
            const fill = /^#[0-9A-Fa-f]{3,8}$/.test(String(seg.color || '')) ? String(seg.color) : '#94a3b8';
            paths.push(`<path d="${donutArcPath(cx, cy, rIn, rOut, a, a1)}" fill="${fill}"/>`);
            a = a1;
        }
    }

    const dim = String(dimensionTitle || '').trim() || '—';
    let centerBlock = '';
    if (!total || !segments.length) {
        centerBlock = `<text x="${cx}" y="${cy - 10}" text-anchor="middle" font-size="13" font-weight="700" fill="#475569" style="font-family: inherit">${attendanceWelcomeEscapeXml('최근 7일')}</text>
<text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="14" font-weight="700" fill="#0f172a" style="font-family: inherit">${attendanceWelcomeEscapeXml(dim)}</text>
<text x="${cx}" y="${cy + 32}" text-anchor="middle" font-size="10" fill="#94a3b8" style="font-family: inherit">해당 기간 데이터가 없습니다</text>`;
    } else {
        centerBlock = `<text x="${cx}" y="${cy - 14}" text-anchor="middle" font-size="13" font-weight="700" fill="#64748b" style="font-family: inherit">${attendanceWelcomeEscapeXml('최근 7일')}</text>
<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="19" font-weight="700" fill="#0f172a" style="font-family: inherit">${attendanceWelcomeEscapeXml(dim)}</text>`;
    }

    const ringLabels = [];
    if (!total || !segments.length) {
        const mid = -Math.PI / 2;
        const x = cx + rMid * Math.cos(mid);
        const y = cy + rMid * Math.sin(mid);
        ringLabels.push(
            `<g transform="translate(${x.toFixed(2)},${y.toFixed(2)})"><text text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="12" font-weight="600" style="font-family: inherit">데이터 없음</text></g>`
        );
    } else if (total > 0 && segments.length) {
        let a = -Math.PI / 2;
        const maxLabel = segments.length > 5 ? 6 : 8;
        const singleFull = segments.length === 1 && segments[0].fraction >= 0.999;
        for (const seg of segments) {
            const sweep = seg.fraction * Math.PI * 2;
            if (sweep <= 0.00001) {
                a += sweep;
                continue;
            }
            const pct = Math.round((seg.count / total) * 100);
            const mid = a + sweep / 2;
            const x = cx + rMid * Math.cos(mid);
            const y = cy + rMid * Math.sin(mid);
            if (!singleFull && (pct < 6 || sweep < 0.12)) {
                a += sweep;
                continue;
            }
            const nameLine = attendanceWelcomeEscapeXml(truncateWelcomeRingLabel(seg.displayName, maxLabel));
            ringLabels.push(
                `<g transform="translate(${x.toFixed(2)},${y.toFixed(2)})"><text text-anchor="middle" dominant-baseline="middle" fill="#0f172a" stroke="#ffffff" stroke-width="3" paint-order="stroke fill" font-size="13" font-weight="700" style="font-family: inherit"><tspan x="0" dy="-8">${nameLine}</tspan><tspan x="0" dy="18">${pct}%</tspan></text></g>`
            );
            a += sweep;
        }
    }

    return `<svg viewBox="0 0 240 240" class="attendance-welcome-donut-svg w-[14.4rem] max-w-[min(14.4rem,92vw)] h-auto mx-auto block" xmlns="${WELCOME_CHART_NS}" aria-hidden="true">${paths.join('')}${centerBlock}${ringLabels.join('')}</svg>`;
}

/**
 * 슬라이드 한 장 — 도넛 SVG만 (외곽 박스·스위치·도트는 HTML 껍데기)
 * @param {{ title: string, total: number, segments: { color: string, count: number, displayName: string }[] }} slide
 */
function buildWelcomeChartSlideHtml(slide) {
    const svg = buildAttendanceWelcomeDonutSvg(slide);
    return `<div class="attendance-welcome-slide-inner flex w-full justify-center px-1">${svg}</div>`;
}

/** @type {'report'|'meal'|'snack'} */
let welcomeChartKind = 'report';

let attendanceWelcomeSlideIdx = 0;
let attendanceWelcomeDragStartX = null;
/** @type {string} */
let welcomeLatestReportDate = '';
/** @type {string[]} */
let welcomeReportDates = [];
let welcomeReportIndex = 0;
/** @type {Map<string, object>} */
const welcomeReportDataCache = new Map();

function resetWelcomeReportNavState() {
    welcomeLatestReportDate = '';
    welcomeReportDates = [];
    welcomeReportIndex = 0;
    welcomeReportDataCache.clear();
}

function getWelcomeCurrentReportDate() {
    return welcomeReportDates[welcomeReportIndex] || welcomeLatestReportDate || '';
}

function renderWelcomeReportCardHtml(data) {
    const source = extractAiMealReportSource(data);
    const report = parseAiMealReport(source);
    return report
        ? renderAiMealReportCardHtml(report, escapeHtml, {
              photoUrls: extractAnalyzedPhotoUrlsForDisplay(data)
          })
        : renderAiMealReportCardHtml(null, escapeHtml);
}

function updateWelcomeReportDateNavUi() {
    const countEl = document.getElementById('attendanceWelcomeRecordCount');
    const nav = document.getElementById('attendanceWelcomeReportDateNav');
    const label = document.getElementById('attendanceWelcomeReportDateLabel');
    const prevBtn = document.getElementById('attendanceWelcomeReportPrev');
    const nextBtn = document.getElementById('attendanceWelcomeReportNext');
    const onReport = welcomeChartKind === 'report';
    const dateStr = getWelcomeCurrentReportDate();
    const hasReports = onReport && dateStr && welcomeReportDates.length > 0;

    if (countEl) {
        countEl.classList.toggle('hidden', hasReports);
        if (!hasReports && onReport) {
            countEl.textContent = 'AI 식단분석';
        }
    }
    if (nav) {
        nav.classList.toggle('hidden', !hasReports);
    }
    if (!hasReports) return;

    if (label) {
        label.textContent = formatMealogDateLabel(dateStr);
    }
    const showArrows = welcomeReportDates.length > 1;
    const atLatest = welcomeReportIndex <= 0;
    const atOldest = welcomeReportIndex >= welcomeReportDates.length - 1;
    if (prevBtn) {
        prevBtn.classList.toggle('hidden', !showArrows);
        prevBtn.disabled = atOldest;
        prevBtn.classList.toggle('attendance-welcome-report-nav-btn--disabled', atOldest);
        prevBtn.setAttribute('aria-disabled', atOldest ? 'true' : 'false');
    }
    if (nextBtn) {
        nextBtn.classList.toggle('hidden', !showArrows);
        nextBtn.disabled = atLatest;
        nextBtn.classList.toggle('attendance-welcome-report-nav-btn--disabled', atLatest);
        nextBtn.setAttribute('aria-disabled', atLatest ? 'true' : 'false');
    }
}

function welcomeShowsReportTab() {
    return !!(window.currentUser && !window.currentUser.isAnonymous && !isDemoUser(window.currentUser));
}

function getWelcomeDefaultChartKind() {
    return welcomeShowsReportTab() ? 'report' : 'meal';
}

/**
 * 웰컴 차트 표시 전 리포트 날짜·본문을 미리 로드.
 * 리포트 없으면 식사 분석 탭, 있으면 전체 리포트를 캐시한 뒤 팝업에서 즉시 렌더.
 * @returns {Promise<{ chartKind: 'report'|'meal', dates: string[], dataCache: Map<string, object> }>}
 */
export async function prepareWelcomeReportState(uid) {
    const empty = { chartKind: /** @type {'meal'} */ ('meal'), dates: [], dataCache: new Map() };
    if (!uid || !welcomeShowsReportTab()) return empty;

    let dates = [];
    try {
        dates = await fetchReadyDietReportDates(uid);
    } catch (e) {
        console.warn('prepareWelcomeReportState dates failed', e);
        return empty;
    }

    if (!dates.length) return empty;

    const dataCache = new Map();
    await Promise.all(
        dates.map(async (dateStr) => {
            const result = await fetchReadyDietReportByDate(uid, dateStr);
            if (result?.data) dataCache.set(dateStr, result.data);
        })
    );

    const validDates = dates.filter((d) => dataCache.has(d));
    if (!validDates.length) return empty;

    return { chartKind: 'report', dates: validDates, dataCache };
}

function prefetchWelcomeLatestDietReport() {
    const uid = window.currentUser?.uid;
    if (!uid || !welcomeShowsReportTab()) return;
    void fetchLatestReadyDietReport(uid);
    void fetchReadyDietReportDates(uid);
}

function updateAttendanceWelcomeChartNavUi() {
    const prevBtn = document.getElementById('attendanceWelcomeChartPrev');
    const nextBtn = document.getElementById('attendanceWelcomeChartNext');
    const track = document.getElementById('attendanceWelcomeChartTrack');
    const n = Number(track?.dataset.slideCount || 0);
    const show = welcomeChartKind !== 'report' && n > 1;
    [prevBtn, nextBtn].forEach((btn) => {
        if (!btn) return;
        btn.classList.toggle('hidden', !show);
    });
    if (!show) return;
    const atStart = attendanceWelcomeSlideIdx <= 0;
    const atEnd = attendanceWelcomeSlideIdx >= n - 1;
    if (prevBtn) {
        prevBtn.disabled = atStart;
        prevBtn.classList.toggle('attendance-welcome-chart-nav--disabled', atStart);
        prevBtn.setAttribute('aria-disabled', atStart ? 'true' : 'false');
    }
    if (nextBtn) {
        nextBtn.disabled = atEnd;
        nextBtn.classList.toggle('attendance-welcome-chart-nav--disabled', atEnd);
        nextBtn.setAttribute('aria-disabled', atEnd ? 'true' : 'false');
    }
}

function applyAttendanceWelcomeSlideTransform() {
    const track = document.getElementById('attendanceWelcomeChartTrack');
    const dots = document.getElementById('attendanceWelcomeChartDots');
    const n = Number(track?.dataset.slideCount || 0);
    if (!track || n < 1) return;
    const pct = 100 / n;
    track.style.transform = `translateX(-${attendanceWelcomeSlideIdx * pct}%)`;
    if (dots) {
        dots.querySelectorAll('.attendance-welcome-dot').forEach((d, i) => {
            d.classList.toggle('attendance-welcome-dot--active', i === attendanceWelcomeSlideIdx);
        });
    }
    updateAttendanceWelcomeChartNavUi();
}

function bindAttendanceWelcomeChartNavOnce() {
    const prevBtn = document.getElementById('attendanceWelcomeChartPrev');
    const nextBtn = document.getElementById('attendanceWelcomeChartNext');
    if (!prevBtn || !nextBtn || prevBtn.dataset.bound === '1') return;
    prevBtn.dataset.bound = '1';
    nextBtn.dataset.bound = '1';

    const go = (delta) => {
        const track = document.getElementById('attendanceWelcomeChartTrack');
        const n = Number(track?.dataset.slideCount || 0);
        if (n < 2) return;
        const next = Math.max(0, Math.min(n - 1, attendanceWelcomeSlideIdx + delta));
        if (next === attendanceWelcomeSlideIdx) return;
        attendanceWelcomeSlideIdx = next;
        applyAttendanceWelcomeSlideTransform();
    };

    prevBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        go(-1);
    });
    nextBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        go(1);
    });
}

function updateWelcomeKindSwitchUi() {
    const reportBtn = document.getElementById('attendanceWelcomeBtnReport');
    const mealBtn = document.getElementById('attendanceWelcomeBtnMeal');
    const snackBtn = document.getElementById('attendanceWelcomeBtnSnack');
    const countEl = document.getElementById('attendanceWelcomeRecordCount');
    const showReport = welcomeShowsReportTab();

    if (reportBtn) {
        reportBtn.classList.toggle('hidden', !showReport);
        const onReport = welcomeChartKind === 'report';
        reportBtn.classList.toggle('attendance-welcome-kind--active', onReport);
        reportBtn.setAttribute('aria-pressed', onReport ? 'true' : 'false');
    }
    if (mealBtn) {
        const onMeal = welcomeChartKind === 'meal';
        mealBtn.classList.toggle('attendance-welcome-kind--active', onMeal);
        mealBtn.setAttribute('aria-pressed', onMeal ? 'true' : 'false');
    }
    if (snackBtn) {
        const onSnack = welcomeChartKind === 'snack';
        snackBtn.classList.toggle('attendance-welcome-kind--active', onSnack);
        snackBtn.setAttribute('aria-pressed', onSnack ? 'true' : 'false');
    }
    if (countEl && welcomeChartKind !== 'report') {
        countEl.classList.remove('hidden');
        document.getElementById('attendanceWelcomeReportDateNav')?.classList.add('hidden');
        void loadWelcomeChartsMod()
            .then(({ getWelcomeWeekSlotRecordCount }) => {
                if (welcomeChartKind === 'report') return;
                const n = getWelcomeWeekSlotRecordCount(7, welcomeChartKind);
                countEl.textContent = `기록 ${n}회`;
            })
            .catch(() => {
                countEl.textContent = '기록 —';
            });
    }
    if (welcomeChartKind === 'report') {
        updateWelcomeReportDateNavUi();
    }
}

function bindAttendanceWelcomeKindSwitchOnce() {
    const sw = document.getElementById('attendanceWelcomeMealSnackSwitch');
    if (!sw || sw.dataset.bound === '1') return;
    sw.dataset.bound = '1';
    sw.addEventListener('click', (e) => {
        const reportHit = e.target.closest('#attendanceWelcomeBtnReport');
        const mealHit = e.target.closest('#attendanceWelcomeBtnMeal');
        const snackHit = e.target.closest('#attendanceWelcomeBtnSnack');
        let next = null;
        if (reportHit && welcomeShowsReportTab()) next = 'report';
        else if (mealHit) next = 'meal';
        else if (snackHit) next = 'snack';
        if (!next || next === welcomeChartKind) return;
        welcomeChartKind = next;
        updateWelcomeKindSwitchUi();
        renderAttendanceWelcomeChartsArea();
    });
}

function bindWelcomeReportPanelOnce() {
    const panel = document.getElementById('attendanceWelcomeReportContent');
    if (!panel || panel.dataset.bound === '1') return;
    panel.dataset.bound = '1';
    panel.addEventListener('click', (e) => {
        if (e.target.closest('.attendance-welcome-report-nav-btn')) return;
        const dateStr = getWelcomeCurrentReportDate();
        if (!dateStr || typeof window.openDietReportModal !== 'function') return;
        closeAttendancePopup();
        void window.openDietReportModal(dateStr);
    });
}

function bindWelcomeReportDateNavOnce() {
    const prevBtn = document.getElementById('attendanceWelcomeReportPrev');
    const nextBtn = document.getElementById('attendanceWelcomeReportNext');
    if (!prevBtn || !nextBtn || prevBtn.dataset.bound === '1') return;
    prevBtn.dataset.bound = '1';
    nextBtn.dataset.bound = '1';

    const navigate = async (delta) => {
        if (welcomeChartKind !== 'report') return;
        const nextIdx = welcomeReportIndex + delta;
        if (nextIdx < 0 || nextIdx >= welcomeReportDates.length) return;

        const uid = window.currentUser?.uid;
        const dateStr = welcomeReportDates[nextIdx];
        if (!uid || !dateStr) return;

        welcomeReportIndex = nextIdx;
        welcomeLatestReportDate = dateStr;
        updateWelcomeReportDateNavUi();

        const content = document.getElementById('attendanceWelcomeReportContent');
        if (!content) return;

        let data = welcomeReportDataCache.get(dateStr);
        if (!data) {
            content.innerHTML = `<div class="attendance-welcome-report-loading" aria-busy="true"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span>리포트 불러오는 중…</span></div>`;
            const result = await fetchReadyDietReportByDate(uid, dateStr);
            if (welcomeChartKind !== 'report' || welcomeReportDates[welcomeReportIndex] !== dateStr) return;
            if (!result?.data) return;
            data = result.data;
            welcomeReportDataCache.set(dateStr, data);
        }

        content.innerHTML = renderWelcomeReportCardHtml(data);
    };

    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void navigate(1);
    });
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void navigate(-1);
    });
}

async function loadWelcomeReportAtIndex(uid, index) {
    const dateStr = welcomeReportDates[index];
    if (!uid || !dateStr) return false;

    welcomeReportIndex = index;
    welcomeLatestReportDate = dateStr;

    let data = welcomeReportDataCache.get(dateStr);
    if (!data) {
        const result = await fetchReadyDietReportByDate(uid, dateStr);
        if (!result?.data) return false;
        data = result.data;
        welcomeReportDataCache.set(dateStr, data);
    }
    return data;
}

async function renderWelcomeReportPanel() {
    const panel = document.getElementById('attendanceWelcomeReportPanel');
    const content = document.getElementById('attendanceWelcomeReportContent');
    const carousel = document.getElementById('attendanceWelcomeChartCarousel');
    const dots = document.getElementById('attendanceWelcomeChartDots');
    if (!panel || !content) return;

    panel.classList.remove('hidden');
    if (carousel) carousel.classList.add('hidden');
    if (dots) dots.classList.add('hidden');
    updateAttendanceWelcomeChartNavUi();

    const uid = window.currentUser?.uid;
    if (!uid) {
        resetWelcomeReportNavState();
        content.innerHTML = `<div class="attendance-welcome-report-empty"><p class="text-xs font-bold text-slate-600 m-0">로그인이 필요해요</p></div>`;
        updateWelcomeKindSwitchUi();
        return;
    }

    const preloadedDate = welcomeReportDates[welcomeReportIndex];
    if (preloadedDate && welcomeReportDataCache.has(preloadedDate)) {
        welcomeLatestReportDate = preloadedDate;
        content.innerHTML = renderWelcomeReportCardHtml(welcomeReportDataCache.get(preloadedDate));
        updateWelcomeKindSwitchUi();
        bindWelcomeReportPanelOnce();
        bindWelcomeReportDateNavOnce();
        return;
    }

    content.innerHTML = `<div class="attendance-welcome-report-loading" aria-busy="true"><i data-lucide="loader-circle" class="lucide-spin" aria-hidden="true"></i><span>리포트 불러오는 중…</span></div>`;
    updateWelcomeKindSwitchUi();

    let dates = [];
    try {
        dates = await fetchReadyDietReportDates(uid);
    } catch (e) {
        console.warn('welcome diet report dates failed', e);
    }

    if (welcomeChartKind !== 'report') return;

    welcomeReportDates = dates;
    welcomeReportIndex = 0;
    welcomeReportDataCache.clear();

    if (dates.length === 0) {
        resetWelcomeReportNavState();
        content.innerHTML = `<div class="attendance-welcome-report-empty">
            <p class="text-xs font-bold text-slate-700 m-0">아직 AI 리포트가 없어요</p>
            <p class="text-[11px] text-slate-500 mt-1.5 mb-0 leading-snug">식사·간식 기록이 2건 이상인 날부터 분석돼요.</p>
        </div>`;
        updateWelcomeKindSwitchUi();
        return;
    }

    const data = await loadWelcomeReportAtIndex(uid, 0);
    if (welcomeChartKind !== 'report') return;

    if (!data) {
        resetWelcomeReportNavState();
        content.innerHTML = `<div class="attendance-welcome-report-empty">
            <p class="text-xs font-bold text-slate-700 m-0">아직 AI 리포트가 없어요</p>
            <p class="text-[11px] text-slate-500 mt-1.5 mb-0 leading-snug">식사·간식 기록이 2건 이상인 날부터 분석돼요.</p>
        </div>`;
        updateWelcomeKindSwitchUi();
        return;
    }

    welcomeReportDataCache.set(welcomeLatestReportDate, data);
    content.innerHTML = renderWelcomeReportCardHtml(data);
    updateWelcomeKindSwitchUi();
    bindWelcomeReportPanelOnce();
    bindWelcomeReportDateNavOnce();
}

function bindAttendanceWelcomeAnalysisMoreOnce() {
    const btn = document.getElementById('attendanceWelcomeAnalysisMore');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
        closeAttendancePopup();
        if (typeof window.switchMainTab === 'function') {
            window.switchMainTab('dashboard');
        }
    });
}

function bindAttendanceWelcomeChartsOnce() {
    const vp = document.getElementById('attendanceWelcomeChartViewport');
    if (!vp || vp.dataset.bound === '1') return;
    vp.dataset.bound = '1';

    const clearDrag = () => {
        attendanceWelcomeDragStartX = null;
    };

    const onPointerDown = (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        attendanceWelcomeDragStartX = e.clientX;
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch (_) {
            /* ignore */
        }
    };

    const applySwipeFromDx = (dx) => {
        if (Math.abs(dx) < 36) return;
        const n = Number(vp.dataset.slideCount || 0);
        if (n < 2) return;
        if (dx < 0) {
            attendanceWelcomeSlideIdx = Math.min(attendanceWelcomeSlideIdx + 1, n - 1);
        } else {
            attendanceWelcomeSlideIdx = Math.max(attendanceWelcomeSlideIdx - 1, 0);
        }
        applyAttendanceWelcomeSlideTransform();
    };

    const onPointerUp = (e) => {
        if (attendanceWelcomeDragStartX == null) return;
        const dx = e.clientX - attendanceWelcomeDragStartX;
        attendanceWelcomeDragStartX = null;
        try {
            const el = e.currentTarget;
            if (
                typeof el.releasePointerCapture === 'function' &&
                typeof el.hasPointerCapture === 'function' &&
                el.hasPointerCapture(e.pointerId)
            ) {
                el.releasePointerCapture(e.pointerId);
            }
        } catch (_) {
            /* ignore */
        }
        applySwipeFromDx(dx);
    };

    /** 일부 WebView에서 touch의 pointerup이 누락되는 경우 대비 */
    const onTouchEnd = (e) => {
        if (attendanceWelcomeDragStartX == null) return;
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        const dx = t.clientX - attendanceWelcomeDragStartX;
        attendanceWelcomeDragStartX = null;
        applySwipeFromDx(dx);
    };

    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', clearDrag);
    vp.addEventListener('touchend', onTouchEnd, { passive: true });
}

function renderAttendanceWelcomeChartsArea() {
    const wrap = document.getElementById('attendancePopupWelcomeCharts');
    const track = document.getElementById('attendanceWelcomeChartTrack');
    const dots = document.getElementById('attendanceWelcomeChartDots');
    const vp = document.getElementById('attendanceWelcomeChartViewport');
    const reportPanel = document.getElementById('attendanceWelcomeReportPanel');
    if (!wrap || !track || !dots || !vp) return;

    updateWelcomeKindSwitchUi();
    bindAttendanceWelcomeKindSwitchOnce();
    bindAttendanceWelcomeAnalysisMoreOnce();

    if (welcomeChartKind === 'report' && welcomeShowsReportTab()) {
        wrap.classList.remove('hidden');
        void renderWelcomeReportPanel();
        return;
    }

    if (reportPanel) reportPanel.classList.add('hidden');
    const carousel = document.getElementById('attendanceWelcomeChartCarousel');
    if (carousel) carousel.classList.remove('hidden');
    vp.classList.remove('hidden');
    dots.classList.remove('hidden');
    wrap.classList.remove('hidden');

    const chartKind = welcomeChartKind === 'snack' ? 'snack' : 'meal';
    void loadWelcomeChartsMod()
        .then(({ getWelcomeWeekDonutSlides }) => {
            if (welcomeChartKind === 'report') return;
            const slides = getWelcomeWeekDonutSlides(7, chartKind);
            const n = slides.length;
            track.dataset.slideCount = String(n);
            vp.dataset.slideCount = String(n);
            attendanceWelcomeSlideIdx = 0;

            const wPct = 100 / n;
            track.style.width = `${n * 100}%`;
            track.innerHTML = slides
                .map((slide) => {
                    const inner = buildWelcomeChartSlideHtml(slide);
                    return `<div class="attendance-welcome-slide flex flex-col items-center justify-center py-0.5 box-border px-0.5" style="flex:0 0 ${wPct}%;width:${wPct}%">${inner}</div>`;
                })
                .join('');

            dots.innerHTML = slides
                .map(
                    (_, i) =>
                        `<span class="attendance-welcome-dot${i === 0 ? ' attendance-welcome-dot--active' : ''}" role="presentation"></span>`
                )
                .join('');

            track.style.transform = 'translateX(0)';
            updateWelcomeKindSwitchUi();
            bindAttendanceWelcomeChartsOnce();
            bindAttendanceWelcomeChartNavOnce();
            updateAttendanceWelcomeChartNavUi();
            const carouselEl = document.getElementById('attendanceWelcomeChartCarousel');
            if (carouselEl) scheduleLucideIcons(carouselEl);
        })
        .catch((e) => {
            console.warn('환영 차트 로드 실패:', e);
            track.innerHTML = '';
            dots.innerHTML = '';
            updateAttendanceWelcomeChartNavUi();
        });
}

/**
 * 출석/연속 기록 팝업 닫기 (자동 닫기 없음 — 닫기 버튼 전용)
 */
export function closeAttendancePopup() {
    const popup = document.getElementById('attendancePopup');
    const attendanceContent = document.getElementById('attendancePopupContent');
    if (attendanceContent) {
        attendanceContent.classList.remove('attendance-popup-has-aux', 'attendance-popup-welcome-charts');
    }
    const welcomeWrap = document.getElementById('attendancePopupWelcomeCharts');
    if (welcomeWrap) welcomeWrap.classList.add('hidden');
    const welcomeTrack = document.getElementById('attendanceWelcomeChartTrack');
    if (welcomeTrack) welcomeTrack.style.transform = '';
    attendanceWelcomeSlideIdx = 0;
    attendanceWelcomeDragStartX = null;
    welcomeChartKind = getWelcomeDefaultChartKind();
    resetWelcomeReportNavState();
    const reportPanel = document.getElementById('attendanceWelcomeReportPanel');
    const reportContent = document.getElementById('attendanceWelcomeReportContent');
    if (reportPanel) reportPanel.classList.add('hidden');
    if (reportContent) reportContent.innerHTML = '';
    const chartCarousel = document.getElementById('attendanceWelcomeChartCarousel');
    const chartVp = document.getElementById('attendanceWelcomeChartViewport');
    const chartDots = document.getElementById('attendanceWelcomeChartDots');
    if (chartCarousel) chartCarousel.classList.remove('hidden');
    if (chartVp) chartVp.classList.remove('hidden');
    if (chartDots) chartDots.classList.remove('hidden');
    updateAttendanceWelcomeChartNavUi();
    updateWelcomeKindSwitchUi();
    document.body.classList.remove('attendance-popup-anim');
    unlockAttendancePopupScroll();
    if (popup) popup.classList.add('hidden');
    try {
        if (typeof window.flushPendingContentPopup === 'function') window.flushPendingContentPopup();
    } catch (_) {
        /* ignore */
    }
}

const ATTENDANCE_POPUP_SVG_NS = 'http://www.w3.org/2000/svg';
const ATTENDANCE_POPUP_MAX_AUX_LINES = 12;

/**
 * 출석/연속 기록 중앙 팝업 — 문구는 모두 SVG(Yeon Sung + 흰 stroke). 멀티라인은 동일 스타일로 줄바꿈.
 * (차트가 있는 기록 있음 분기는 첫 줄만 표시·나머지는 생략.)
 * @param {string} line1 첫 블록(멀티라인 가능)
 * @param {string} [line2] 추가 블록(멀티라인 가능)
 * @param {'noRecord'|'hasRecord'|'hasRecordRestart'} [welcomeIcon] 기록 없음=하트, 연속 있음=따봉, 어제 끊김=새싹
 * @param {{ chartKind?: 'report'|'meal', dates?: string[], dataCache?: Map<string, object> }|null} [welcomePrepared] prepareWelcomeReportState 결과
 * @returns {boolean} 실제로 팝업을 띄웠으면 true(빈 문구·DOM 없음 등으로 스킵이면 false)
 */
export function showAttendancePopup(line1, line2 = '', welcomeIcon = 'hasRecord', welcomePrepared = null) {
    const splitLines = (s) => {
        const out = [];
        if (s == null || s === '') return out;
        for (const seg of String(s).split(/\r?\n/)) {
            const t = seg.trim();
            if (t) out.push(t);
        }
        return out;
    };
    const from1 = splitLines(line1);
    const from2 = splitLines(line2);
    if (from1.length === 0 && from2.length === 0) return false;

    const orderedLines = [];
    if (from1.length > 0) {
        orderedLines.push(...from1, ...from2);
    } else {
        orderedLines.push(...from2);
    }
    const displayLines = orderedLines
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, ATTENDANCE_POPUP_MAX_AUX_LINES);
    if (displayLines.length === 0) return false;

    const popup = document.getElementById('attendancePopup');
    const textRoot = document.getElementById('attendancePopupTextRoot');
    const textSvg = document.getElementById('attendancePopupTextSvg');
    const auxWrap = document.getElementById('attendancePopupAuxWrap');
    const auxBox = document.getElementById('attendancePopupAuxBox');
    if (!popup || !textRoot || !textSvg) return false;

    const showWelcomeCharts = welcomeIcon === 'hasRecord' || welcomeIcon === 'hasRecordRestart';
    const svgLines = showWelcomeCharts ? displayLines.slice(0, 1) : displayLines;

    if (auxWrap && auxBox) {
        auxBox.textContent = '';
        auxWrap.classList.add('hidden');
    }
    const attendanceContent = document.getElementById('attendancePopupContent');
    if (attendanceContent) {
        attendanceContent.classList.remove('attendance-popup-has-aux');
    }

    const iconHeart = document.getElementById('attendancePopupIconHeart');
    const iconClap = document.getElementById('attendancePopupIconClap');
    const emojiThumbs = document.getElementById('attendancePopupEmojiThumbs');
    const emojiRestart = document.getElementById('attendancePopupEmojiRestart');
    if (iconHeart && iconClap) {
        const showHeart = welcomeIcon === 'noRecord';
        iconHeart.classList.toggle('hidden', !showHeart);
        iconClap.classList.toggle('hidden', showHeart);
        if (emojiThumbs && emojiRestart) {
            const showRestart = welcomeIcon === 'hasRecordRestart';
            emojiThumbs.classList.toggle('hidden', showRestart);
            emojiRestart.classList.toggle('hidden', !showRestart);
        }
    }

    ensureAttendancePopupCloseBound();

    while (textRoot.firstChild) {
        textRoot.removeChild(textRoot.firstChild);
    }

    const maxLen = Math.max(1, ...svgLines.map((l) => String(l).length));
    /** 짧은 문구 최대 35px, 길면 단계적으로 축소(340px 뷰 안에 맞춤) */
    const fs =
        maxLen > 24 ? '22' : maxLen > 20 ? '26' : maxLen > 16 ? '31' : '35';
    const fsNum = Number(fs);
    const topPad = 6;
    const startY = topPad + Math.round(fsNum * 0.75);

    svgLines.forEach((lineText, i) => {
        const tsp = document.createElementNS(ATTENDANCE_POPUP_SVG_NS, 'tspan');
        tsp.setAttribute('x', '170');
        if (i === 0) {
            tsp.setAttribute('y', String(startY));
        } else {
            tsp.setAttribute('dy', '1.22em');
        }
        tsp.textContent = lineText;
        textRoot.appendChild(tsp);
    });

    textRoot.setAttribute('font-size', fs);
    const n = svgLines.length;
    const lineGap = (n - 1) * fsNum * 1.22;
    const bottomPad = 18;
    const minSvgH = n <= 1 ? 56 : 52;
    const vbH = Math.max(minSvgH, Math.ceil(topPad + fsNum + lineGap + bottomPad));
    textSvg.setAttribute('viewBox', `0 0 340 ${vbH}`);
    textSvg.setAttribute('height', String(vbH));

    if (showWelcomeCharts) {
        attendanceWelcomeSlideIdx = 0;
        if (welcomePrepared) {
            welcomeChartKind = welcomePrepared.chartKind === 'report' ? 'report' : 'meal';
            welcomeReportDates = welcomePrepared.dates ? welcomePrepared.dates.slice() : [];
            welcomeReportIndex = 0;
            welcomeLatestReportDate = welcomeReportDates[0] || '';
            welcomeReportDataCache.clear();
            if (welcomePrepared.dataCache) {
                for (const [k, v] of welcomePrepared.dataCache) {
                    welcomeReportDataCache.set(k, v);
                }
            }
        } else {
            welcomeChartKind = getWelcomeDefaultChartKind();
            resetWelcomeReportNavState();
            prefetchWelcomeLatestDietReport();
        }
        renderAttendanceWelcomeChartsArea();
        attendanceContent?.classList.add('attendance-popup-welcome-charts');
    } else {
        document.getElementById('attendancePopupWelcomeCharts')?.classList.add('hidden');
        attendanceContent?.classList.remove('attendance-popup-welcome-charts');
    }

    document.body.classList.remove('attendance-popup-anim');
    popup.classList.remove('hidden');
    void popup.offsetHeight;
    document.body.classList.add('attendance-popup-anim');
    lockAttendancePopupScroll();
    return true;
}

const LANDING_EXIT_MS = 280;

export function switchScreen(isLoggedIn) {
    const landing = document.getElementById('landingPage');
    const main = document.getElementById('mainApp');
    const landingBottom = document.getElementById('landingBottomFixed');
    if (!landing || !main) return;

    if (isLoggedIn) {
        if (typeof window.dismissMealogBootSplash === 'function') {
            window.dismissMealogBootSplash();
        }
        document.documentElement.classList.remove('mealog-landing-active');
        document.documentElement.classList.remove('mealog-landing-login');
        // 랜딩만 페이드 아웃, 메인은 즉시 표시 (스피너 끝난 뒤 추가 페이드 없음)
        landing.classList.add('screen-transition-exit');
        main.style.display = 'block';
        main.classList.remove('hidden');
        main.style.opacity = '1';
        
        setTimeout(() => {
            landing.style.display = 'none';
            landing.classList.remove('screen-transition-exit');
            if (landingBottom) landingBottom.style.display = 'none';
            window.dispatchEvent(new CustomEvent('mealog:mainScreenShown'));
            if (typeof window.__onMainScreenShown === 'function') window.__onMainScreenShown();
        }, LANDING_EXIT_MS);
    } else {
        document.documentElement.classList.add('mealog-landing-active');
        const hasLoginChrome = landing.classList.contains('landing-show-login')
            || landing.classList.contains('landing-buttons-visible');
        document.documentElement.classList.toggle('mealog-landing-login', hasLoginChrome);
        landing.style.display = 'flex';
        landing.classList.remove('screen-transition-exit');
        if (landingBottom) landingBottom.style.display = '';
        main.style.display = 'none';
        main.classList.add('hidden');
        main.classList.remove('screen-transition-enter', 'screen-transition-enter-active');
        main.style.opacity = '';
    }
    // 로딩 오버레이는 hideLoading()으로 관리 (중앙 관리)
}

// 헤더 UI 업데이트 디바운싱
let headerUpdateTimeout = null;
let lastHeaderUpdate = null;

export function updateHeaderUI() {
    // 디바운싱: 100ms 내 여러 번 호출되면 마지막 것만 실행
    if (headerUpdateTimeout) {
        clearTimeout(headerUpdateTimeout);
    }
    
    headerUpdateTimeout = setTimeout(() => {
        // 게스트 모드 확인 (먼저 확인)
        const isGuest = window.currentUser && window.currentUser.isAnonymous;
        
        // 게스트 모드이거나 userSettings가 없는 경우에도 처리
        if (!window.userSettings || !window.userSettings.profile) {
    // 게스트 모드일 때는 회색 사람 아이콘
            if (isGuest) {
                const iconEl = document.getElementById('navProfileIcon');
                if (iconEl) {
                    // 모든 스타일 및 클래스 초기화
                    iconEl.className = 'nav-item__avatar';
                    iconEl.style.backgroundImage = '';
                    iconEl.style.backgroundSize = '';
                    iconEl.style.backgroundPosition = '';
                    iconEl.style.borderRadius = '';
                    iconEl.style.width = '';
                    iconEl.style.height = '';
                    iconEl.style.objectFit = '';
                    iconEl.style.position = '';
                    iconEl.innerHTML = '<i data-lucide="user" class="text-slate-500 text-sm"></i>';
                    
                    const currentProfileKey = `게스트||${isGuest}`;
                    if (lastHeaderUpdate !== currentProfileKey) {
                        lastHeaderUpdate = currentProfileKey;
                    }
                }
            }
            return;
        }
        
        const p = window.userSettings.profile;
        const currentNickname = p.nickname || '게스트';
        const currentPhotoUrl = p.photoUrl || '';
        
        // 프로필 정보가 변경되었는지 확인 (닉네임, 사진, 게스트 상태 포함)
        const currentProfileKey = `${currentNickname}|${currentPhotoUrl}|${isGuest}`;
        if (lastHeaderUpdate === currentProfileKey) {
            return;
        }
        
        const iconEl = document.getElementById('navProfileIcon');
        
        if (iconEl) {
            // 모든 스타일 초기화
            iconEl.style.backgroundImage = '';
            iconEl.style.backgroundSize = '';
            iconEl.style.backgroundPosition = '';
            iconEl.style.borderRadius = '';
            iconEl.style.width = '';
            iconEl.style.height = '';
            iconEl.style.objectFit = '';
            iconEl.style.position = '';
            iconEl.innerHTML = '';
            
            if (p.photoUrl) {
                // 사진이 있으면 원형으로 표시
                iconEl.style.backgroundImage = `url(${p.photoUrl})`;
                iconEl.style.backgroundSize = 'cover';
                iconEl.style.backgroundPosition = 'center';
                iconEl.style.borderRadius = '50%';
                iconEl.style.position = 'relative';
                iconEl.className = 'nav-item__avatar';
                
                // 게스트 모드이면 '게' 오버레이 추가
                if (isGuest) {
                    iconEl.innerHTML = '<span style="position: absolute; bottom: 0; right: 0; background: rgba(0,0,0,0.7); color: white; font-size: 10px; font-weight: bold; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white;">게</span>';
                }
            } else {
                const av = getProfileAvatarDisplay({ nickname: currentNickname, icon: p.icon, photoUrl: p.photoUrl });
                const isInitial = av.type === 'initial' || (isGuest && av.type !== 'emoji' && av.type !== 'photo');
                iconEl.className = [
                    'nav-item__avatar',
                    av.type === 'emoji' ? '' : 'font-bold',
                    isInitial || isGuest ? 'nav-item__avatar--initial' : ''
                ].filter(Boolean).join(' ');
                iconEl.textContent = isGuest ? '게' : av.value;
            }
        }
        
        lastHeaderUpdate = currentProfileKey;
    }, 100);
}

// 전역 함수로 노출 (기존 코드 호환성)
window.showLoading = showLoading;
window.hideLoading = hideLoading;

/**
 * 전송 계층( fetch / Firestore / Auth HTTP ) 실패로 보이는지 — navigator.onLine 은 보지 않음.
 * 앱 로컬 오프라인 플래그 강제 시에 사용.
 */
export function isLikelyNetworkTransportFailure(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return false;
    const code = String(err.code || '');
    const rawMsg = String(err.message || (typeof err.toString === 'function' ? err.toString() : '') || '');
    const msg = rawMsg.toLowerCase();

    // Firestore/브라우저 내부 스트림 단언·버그 — 망 끊김과 무관, 오버레이 오탐 방지
    if (/internal assertion failed|watchchangeaggregator|unexpected state/i.test(msg)) return false;

    if (code === 'cancelled' || code === 'canceled') return false;
    if (code === 'failed-precondition') return false;
    if (code === 'permission-denied') return false;

    // unavailable / deadline: 실제 단절·지연에 흔함. resource-exhausted(할당량)은 제외 — Wi-Fi 문제와 무관
    const networkCodes = ['unavailable', 'deadline-exceeded'];
    if (networkCodes.includes(code)) return true;
    if (code === 'auth/network-request-failed') return true;
    if (
        /err_internet_disconnected|err_network_changed|err_name_not_resolved|err_connection_timed_out|err_connection_reset|err_network_io_suspended|net::err_/i.test(
            rawMsg
        )
    ) {
        return true;
    }
    if (
        /failed to fetch|networkerror|network request failed|load failed|fetcherror/i.test(msg) ||
        /connection.*(refused|reset)|err_connection|net::err|quic|econnreset|\betimedout\b|etimedout/i.test(msg) ||
        /\b(operation timed out|deadline exceeded)\b/i.test(msg)
    ) {
        return true;
    }
    // 'timeout' 단독 매칭 제거 — 메시지 안 다른 단어에 포함돼 오탐(예: 내부 타임아웃 문구)
    if (/client is offline|you are offline|the network.*unavailable|could not reach/i.test(msg)) return true;
    if (/unreachable|host.*not.*found|dns.*(error|fail)|enotfound/i.test(msg)) return true;
    return false;
}

/** Firestore / fetch 등에서 네트워크성 오류로 추정되는지 (인덱스·권한 오류는 제외) */
export function isLikelyNetworkError(err) {
    if (!err) return false;
    // navigator.onLine === false 만으로는 판단하지 않음 — 모바일/WKWebView·전환 순간에 false 오판이 잦고,
    // 그때 permission 등 다른 오류와 조합되면 '연결할 수 없습니다'가 오탐됨.
    return isLikelyNetworkTransportFailure(err);
}

/** @deprecated 전면 연결 오류 팝업 제거됨 — 오프라인 FAB·토스트만 사용 */
export function showNetworkErrorOverlay(options = {}) {
    void options;
    try {
        hideLoading();
    } catch (_) {
        /* ignore */
    }
    try {
        const overlay = document.getElementById('networkErrorOverlay');
        if (overlay) overlay.classList.add('hidden');
    } catch (_) {
        /* ignore */
    }
}

export function hideNetworkErrorOverlay() {
    try {
        const overlay = document.getElementById('networkErrorOverlay');
        if (overlay) overlay.classList.add('hidden');
    } catch (_) {
        /* ignore */
    }
}

window.isLikelyNetworkError = isLikelyNetworkError;
window.showNetworkErrorOverlay = showNetworkErrorOverlay;
window.hideNetworkErrorOverlay = hideNetworkErrorOverlay;

