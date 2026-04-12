// UI 관련 함수들
import { getWelcomeWeekDonutSlides, getWelcomeWeekSlotRecordCount } from './analytics/charts.js';

// 로딩 오버레이 중앙 관리
let loadingOverlayTimeout = null;
let loadingHideTimeout = null; // hideLoading 지연용
let loadingShownAt = 0; // 메시지 표시 시 최소 표시 시간용

export function showLoading(message = '', options = {}) {
    const { dimBackground = true, skipOnLoginScreen = true } = options;
    const mainApp = document.getElementById('mainApp');
    const isOnLoginScreen = mainApp && mainApp.classList.contains('hidden');
    if (skipOnLoginScreen && isOnLoginScreen) return;
    const overlay = document.getElementById('loadingOverlay');
    const messageEl = document.getElementById('loadingOverlayMessage');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.toggle('bg-white/90', dimBackground);
        overlay.classList.toggle('bg-transparent', !dimBackground);
        overlay.classList.toggle('pointer-events-none', !dimBackground);
        if (messageEl) {
            messageEl.textContent = message || '';
            messageEl.style.display = message ? 'block' : 'none';
            messageEl.style.visibility = message ? 'visible' : 'hidden';
            messageEl.classList.toggle('hidden', !message);
        }
        if (message) loadingShownAt = Date.now();
        // 10초 타임아웃 (무한 대기 방지)
        if (loadingOverlayTimeout) clearTimeout(loadingOverlayTimeout);
        loadingOverlayTimeout = setTimeout(() => {
            hideLoading();
            console.warn('⏱️ 로딩 타임아웃: 10초 후 자동으로 숨김');
        }, 10000);
    }
}

export function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    const messageEl = document.getElementById('loadingOverlayMessage');
    if (!overlay) return;
    if (loadingHideTimeout) {
        clearTimeout(loadingHideTimeout);
        loadingHideTimeout = null;
    }
    const doHide = () => {
        overlay.classList.add('hidden');
        overlay.classList.add('bg-white/90');
        overlay.classList.remove('bg-transparent');
        overlay.classList.remove('pointer-events-none');
        if (messageEl) {
            messageEl.textContent = '';
            messageEl.style.display = 'none';
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
    // 메시지가 표시된 경우 최소 500ms 보여주기 (너무 빠른 로드 시 사용자가 못 봄)
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
 * 토스트 — 실패·에러(type === 'error')일 때만 표시. success / info 는 무시.
 */
export function showToast(message, type = 'info') {
    if (!message) return;
    if (type !== 'error') return;
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    toast.className =
        'animate-toast px-4 py-3 rounded-xl text-sm font-medium text-white shadow-lg max-w-full bg-red-500';
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

    successPopupTimer = setTimeout(() => {
        document.body.classList.remove('success-popup-anim');
        popup.classList.add('hidden');
        if (confetti) confetti.innerHTML = '';
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
}

function ensureAttendancePopupCloseBound() {
    const btn = document.getElementById('attendancePopupCloseBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', closeAttendancePopup);
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

/** @type {'meal'|'snack'} */
let welcomeChartKind = 'meal';

let attendanceWelcomeSlideIdx = 0;
let attendanceWelcomeDragStartX = null;

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
}

function updateWelcomeMealSnackSwitchUi() {
    const mealBtn = document.getElementById('attendanceWelcomeBtnMeal');
    const snackBtn = document.getElementById('attendanceWelcomeBtnSnack');
    const countEl = document.getElementById('attendanceWelcomeRecordCount');
    if (!mealBtn || !snackBtn) return;
    const onMeal = welcomeChartKind === 'meal';
    mealBtn.classList.toggle('attendance-welcome-kind--active', onMeal);
    mealBtn.setAttribute('aria-pressed', onMeal ? 'true' : 'false');
    snackBtn.classList.toggle('attendance-welcome-kind--active', !onMeal);
    snackBtn.setAttribute('aria-pressed', onMeal ? 'false' : 'true');
    if (countEl) {
        const n = getWelcomeWeekSlotRecordCount(7, welcomeChartKind);
        countEl.textContent = `기록 ${n}회`;
    }
}

function bindAttendanceWelcomeMealSnackSwitchOnce() {
    const sw = document.getElementById('attendanceWelcomeMealSnackSwitch');
    if (!sw || sw.dataset.bound === '1') return;
    sw.dataset.bound = '1';
    sw.addEventListener('click', (e) => {
        const mealHit = e.target.closest('#attendanceWelcomeBtnMeal');
        const snackHit = e.target.closest('#attendanceWelcomeBtnSnack');
        if (!mealHit && !snackHit) return;
        const next = mealHit ? 'meal' : 'snack';
        if (next === welcomeChartKind) return;
        welcomeChartKind = next;
        updateWelcomeMealSnackSwitchUi();
        renderAttendanceWelcomeChartsArea();
    });
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
    if (!wrap || !track || !dots || !vp) return;

    const slides = getWelcomeWeekDonutSlides(7, welcomeChartKind);
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

    wrap.classList.remove('hidden');
    track.style.transform = 'translateX(0)';
    updateWelcomeMealSnackSwitchUi();
    bindAttendanceWelcomeMealSnackSwitchOnce();
    bindAttendanceWelcomeAnalysisMoreOnce();
    bindAttendanceWelcomeChartsOnce();
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
    welcomeChartKind = 'meal';
    updateWelcomeMealSnackSwitchUi();
    document.body.classList.remove('attendance-popup-anim');
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
 * 출석/연속 기록 중앙 팝업 — 메인 문구는 SVG(Yeon Sung + 흰 stroke), 부가 문구는 본문 기본 폰트 박스.
 * line1의 첫 줄만 메인; 나머지 줄 + line2는 부가(박스).
 * @param {string} line1 메인(첫 줄) 또는 멀티라인(첫 줄=메인, 이후=부가)
 * @param {string} [line2] 부가 블록(멀티라인 가능)
 * @param {'noRecord'|'hasRecord'|'hasRecordRestart'} [welcomeIcon] 기록 없음=하트, 연속 있음=따봉, 어제 끊김=새싹
 * @returns {boolean} 실제로 팝업을 띄웠으면 true(빈 문구·DOM 없음 등으로 스킵이면 false)
 */
export function showAttendancePopup(line1, line2 = '', welcomeIcon = 'hasRecord') {
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

    const primary = from1.length > 0 ? from1[0] : from2[0];
    const auxParts = [];
    if (from1.length > 1) auxParts.push(...from1.slice(1));
    if (from1.length > 0) auxParts.push(...from2);
    else auxParts.push(...from2.slice(1));
    const secondary = auxParts
        .slice(0, ATTENDANCE_POPUP_MAX_AUX_LINES)
        .join('\n')
        .trim();

    const popup = document.getElementById('attendancePopup');
    const textRoot = document.getElementById('attendancePopupTextRoot');
    const textSvg = document.getElementById('attendancePopupTextSvg');
    const auxWrap = document.getElementById('attendancePopupAuxWrap');
    const auxBox = document.getElementById('attendancePopupAuxBox');
    if (!popup || !textRoot || !textSvg) return false;

    const showWelcomeCharts = welcomeIcon === 'hasRecord' || welcomeIcon === 'hasRecordRestart';
    const showAux = Boolean(secondary) && !showWelcomeCharts;

    if (auxWrap && auxBox) {
        auxBox.textContent = showAux ? secondary : '';
        auxWrap.classList.toggle('hidden', !showAux);
    }
    const attendanceContent = document.getElementById('attendancePopupContent');
    if (attendanceContent) {
        attendanceContent.classList.toggle('attendance-popup-has-aux', showAux);
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

    const maxLen = Math.max(String(primary).length, 1);
    /** 짧은 문구 최대 35px, 길면 단계적으로 축소(340px 뷰 안에 맞춤) */
    const fs =
        maxLen > 24 ? '22' : maxLen > 20 ? '26' : maxLen > 16 ? '31' : '35';
    const fsNum = Number(fs);
    const topPad = 6;
    const startY = topPad + Math.round(fsNum * 0.75);

    const tsp = document.createElementNS(ATTENDANCE_POPUP_SVG_NS, 'tspan');
    tsp.setAttribute('x', '170');
    tsp.setAttribute('y', String(startY));
    tsp.textContent = primary;
    textRoot.appendChild(tsp);

    textRoot.setAttribute('font-size', fs);
    /** 부가 문구 있을 때: 하단 여백·최소 높이를 줄여 메인 텍스트~박스 간격 확실히 축소 (overflow:visible로 획 여유) */
    const bottomPad = showAux ? 8 : 18;
    const minSvgH = showAux ? 44 : 56;
    const vbH = Math.max(minSvgH, topPad + fsNum + bottomPad);
    textSvg.setAttribute('viewBox', `0 0 340 ${vbH}`);
    textSvg.setAttribute('height', String(vbH));

    if (showWelcomeCharts) {
        attendanceWelcomeSlideIdx = 0;
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
    return true;
}

const LANDING_EXIT_MS = 280;

export function switchScreen(isLoggedIn) {
    const landing = document.getElementById('landingPage');
    const main = document.getElementById('mainApp');
    if (!landing || !main) return;
    
    if (isLoggedIn) {
        // 랜딩만 페이드 아웃, 메인은 즉시 표시 (스피너 끝난 뒤 추가 페이드 없음)
        landing.classList.add('screen-transition-exit');
        main.style.display = 'block';
        main.classList.remove('hidden');
        main.style.opacity = '1';
        
        setTimeout(() => {
            landing.style.display = 'none';
            landing.classList.remove('screen-transition-exit');
            window.dispatchEvent(new CustomEvent('mealog:mainScreenShown'));
            if (typeof window.__onMainScreenShown === 'function') window.__onMainScreenShown();
        }, LANDING_EXIT_MS);
    } else {
        landing.style.display = 'flex';
        landing.classList.remove('screen-transition-exit');
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
                    iconEl.className = 'w-8 h-8 rounded-full flex items-center justify-center bg-slate-300 flex-shrink-0 overflow-hidden border border-slate-400 text-slate-500';
                    iconEl.style.backgroundImage = '';
                    iconEl.style.backgroundSize = '';
                    iconEl.style.backgroundPosition = '';
                    iconEl.style.borderRadius = '';
                    iconEl.style.width = '';
                    iconEl.style.height = '';
                    iconEl.style.objectFit = '';
                    iconEl.style.position = '';
                    iconEl.innerHTML = '<i class="fa-solid fa-user text-slate-500 text-base"></i>';
                    
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
                
                // 게스트 모드이면 '게' 오버레이 추가
                if (isGuest) {
                    iconEl.innerHTML = '<span style="position: absolute; bottom: 0; right: 0; background: rgba(0,0,0,0.7); color: white; font-size: 10px; font-weight: bold; width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid white;">게</span>';
                }
            } else {
                // 사진이 없으면 회색 사람 아이콘 (게스트/일반 동일)
                iconEl.innerHTML = '<i class="fa-solid fa-user text-slate-500 text-base"></i>';
            }
        }
        
        lastHeaderUpdate = currentProfileKey;
    }, 100);
}

// 전역 함수로 노출 (기존 코드 호환성)
window.showLoading = showLoading;
window.hideLoading = hideLoading;

/** Firestore / fetch 등에서 네트워크성 오류로 추정되는지 (인덱스·권한 오류는 제외) */
export function isLikelyNetworkError(err) {
    if (!err) return false;
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    } catch (_) {}
    const code = String(err.code || '');
    const msg = String(err.message || (typeof err.toString === 'function' ? err.toString() : '') || '').toLowerCase();
    const networkCodes = ['unavailable', 'deadline-exceeded', 'resource-exhausted'];
    if (networkCodes.includes(code)) return true;
    if (code === 'failed-precondition') return false;
    if (code === 'permission-denied') return false;
    if (
        /failed to fetch|networkerror|network request failed|load failed|fetcherror/i.test(msg) ||
        /connection.*(refused|reset|aborted)|err_connection|net::err|quic|econnreset|enotfound|etimedout|timeout/i.test(
            msg
        ) ||
        /internet|offline|unreachable|host.*not.*found/i.test(msg)
    ) {
        return true;
    }
    return false;
}

const DEFAULT_NETWORK_ERROR_MESSAGE =
    '네트워크 연결을 확인할 수 없습니다. Wi-Fi 또는 데이터 연결을 확인한 뒤 다시 시도해 주세요.';

let networkErrorOverlayButtonsBound = false;

function bindNetworkErrorOverlayButtons() {
    if (networkErrorOverlayButtonsBound) return;
    const reloadBtn = document.getElementById('networkErrorReloadBtn');
    const dismissBtn = document.getElementById('networkErrorDismissBtn');
    if (!reloadBtn || !dismissBtn) return;
    networkErrorOverlayButtonsBound = true;
    reloadBtn.addEventListener('click', () => {
        try {
            window.location.reload();
        } catch (_) {}
    });
    dismissBtn.addEventListener('click', () => {
        hideNetworkErrorOverlay();
    });
}

/** 메인 콘텐츠(Firestore 등) 로드 실패 시 전체 화면 안내 */
export function showNetworkErrorOverlay(options = {}) {
    const overlay = document.getElementById('networkErrorOverlay');
    if (!overlay) return;
    bindNetworkErrorOverlayButtons();
    const msgEl = document.getElementById('networkErrorOverlayMessage');
    if (msgEl) {
        msgEl.textContent =
            typeof options.message === 'string' && options.message.trim()
                ? options.message.trim()
                : DEFAULT_NETWORK_ERROR_MESSAGE;
    }
    hideLoading();
    overlay.classList.remove('hidden');
}

export function hideNetworkErrorOverlay() {
    const overlay = document.getElementById('networkErrorOverlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
}

window.isLikelyNetworkError = isLikelyNetworkError;
window.showNetworkErrorOverlay = showNetworkErrorOverlay;
window.hideNetworkErrorOverlay = hideNetworkErrorOverlay;

