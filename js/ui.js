// UI 관련 함수들

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

/**
 * 출석/연속 기록 팝업 닫기 (자동 닫기 없음 — 닫기 버튼 전용)
 */
export function closeAttendancePopup() {
    const popup = document.getElementById('attendancePopup');
    document.body.classList.remove('attendance-popup-anim');
    if (popup) popup.classList.add('hidden');
}

const ATTENDANCE_POPUP_SVG_NS = 'http://www.w3.org/2000/svg';
const ATTENDANCE_POPUP_MAX_LINES = 8;

/**
 * 출석/연속 기록 중앙 팝업 — 기록 완료와 동일 계열 SVG 텍스트(흰 윤곽 stroke) (컨페티 없음)
 * 줄바꿈(\n)으로 여러 줄. line2는 선택(구 호환).
 * @param {string} line1 첫 블록 또는 전체 멀티라인 문자열
 * @param {string} [line2] 추가 블록(멀티라인 가능)
 * @param {'noRecord'|'hasRecord'} [welcomeIcon] 기록 없음 웰컴은 하트, 그 외(연속 기록)는 박수 이모지
 */
export function showAttendancePopup(line1, line2 = '', welcomeIcon = 'hasRecord') {
    const lines = [];
    const pushBlock = (s) => {
        if (s == null || s === '') return;
        for (const seg of String(s).split(/\r?\n/)) {
            const t = seg.trim();
            if (t) lines.push(t);
        }
    };
    pushBlock(line1);
    pushBlock(line2);
    const trimmed = lines.slice(0, ATTENDANCE_POPUP_MAX_LINES);
    if (trimmed.length === 0) return;

    const popup = document.getElementById('attendancePopup');
    const textRoot = document.getElementById('attendancePopupTextRoot');
    const textSvg = document.getElementById('attendancePopupTextSvg');
    if (!popup || !textRoot || !textSvg) return;

    const iconHeart = document.getElementById('attendancePopupIconHeart');
    const iconClap = document.getElementById('attendancePopupIconClap');
    if (iconHeart && iconClap) {
        const showHeart = welcomeIcon === 'noRecord';
        iconHeart.classList.toggle('hidden', !showHeart);
        iconClap.classList.toggle('hidden', showHeart);
    }

    ensureAttendancePopupCloseBound();

    while (textRoot.firstChild) {
        textRoot.removeChild(textRoot.firstChild);
    }

    const maxLen = Math.max(...trimmed.map((l) => l.length), 1);
    /** 짧은 문구 최대 35px, 길면 단계적으로 축소(340px 뷰 안에 맞춤) */
    const fs =
        maxLen > 24 ? '22' : maxLen > 20 ? '26' : maxLen > 16 ? '31' : '35';
    const fsNum = Number(fs);
    const lineGap = Math.max(26, Math.round(fsNum * 1.38));
    const topPad = 6;
    const startY = topPad + Math.round(fsNum * 0.75);

    trimmed.forEach((text, i) => {
        const tsp = document.createElementNS(ATTENDANCE_POPUP_SVG_NS, 'tspan');
        tsp.setAttribute('x', '170');
        if (i === 0) tsp.setAttribute('y', String(startY));
        else tsp.setAttribute('dy', String(lineGap));
        tsp.textContent = text;
        textRoot.appendChild(tsp);
    });

    textRoot.setAttribute('font-size', fs);
    const n = trimmed.length;
    const vbH = Math.max(56, topPad + (n - 1) * lineGap + fsNum + 18);
    textSvg.setAttribute('viewBox', `0 0 340 ${vbH}`);
    textSvg.setAttribute('height', String(vbH));

    document.body.classList.remove('attendance-popup-anim');
    popup.classList.remove('hidden');
    void popup.offsetHeight;
    document.body.classList.add('attendance-popup-anim');
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

