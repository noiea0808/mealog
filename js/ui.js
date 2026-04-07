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
const TOAST_DURATION_INFO_MS = 5000;

/**
 * 토스트 — error / info / success
 * (과거에는 error만 표시해 info 호출이 무반응이었음; 카카오 앱 차단 안내 등에서 문제 발생)
 */
export function showToast(message, type = 'info') {
    if (!message) return;
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    let bg = 'bg-slate-800';
    if (type === 'error') bg = 'bg-red-500';
    else if (type === 'success') bg = 'bg-emerald-600';
    toast.className = `animate-toast px-4 py-3 rounded-xl text-sm font-medium text-white shadow-lg max-w-full ${bg}`;
    toast.textContent = message;
    container.appendChild(toast);
    const remove = () => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 200);
    };
    const dur = type === 'info' || type === 'success' ? TOAST_DURATION_INFO_MS : TOAST_DURATION_MS;
    setTimeout(remove, dur);
}

let successPopupTimer = null;

/**
 * 기록 완료 중앙 팝업 (0.5초)
 * - 여러 번 호출되면 이전 타이머를 정리하고 애니메이션을 재시작한다.
 */
export function showSuccessPopup(message = '기록 완료', durationMs = 800) {
    const popup = document.getElementById('successPopup');
    const textEl = document.getElementById('successPopupText');
    const confetti = document.getElementById('successPopupConfetti');
    if (!popup) return;

    if (successPopupTimer) {
        clearTimeout(successPopupTimer);
        successPopupTimer = null;
    }

    if (textEl) textEl.textContent = message || '기록 완료';

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

/**
 * 출석/연속 기록 중앙 팝업 — 기록 완료 팝업과 동일한 굵은 윤곽 SVG 텍스트 (컨페티 없음)
 * 입장 애니메이션은 끝까지 표시가 유지되며, 닫기 버튼으로만 닫힙니다.
 * @param {string} line1
 * @param {string} [line2]
 */
export function showAttendancePopup(line1, line2 = '') {
    const popup = document.getElementById('attendancePopup');
    const l1 = document.getElementById('attendancePopupLine1');
    const l2 = document.getElementById('attendancePopupLine2');
    const textRoot = document.getElementById('attendancePopupTextRoot');
    const textSvg = document.getElementById('attendancePopupTextSvg');
    if (!popup || !l1 || !l2) return;

    ensureAttendancePopupCloseBound();

    l1.textContent = line1 || '';
    l2.textContent = line2 || '';
    const two = Boolean(line2 && line2.trim());

    const maxLen = Math.max((line1 || '').length, (line2 || '').length);
    const fs = maxLen > 20 ? '15' : maxLen > 16 ? '17' : '19';
    const fsNum = Number(fs);
    /** 두 줄일 때 dy가 너무 작으면 글자가 겹침 — 글자 크기의 약 1.35배 이상 간격 */
    const lineGap = Math.max(26, Math.round(fsNum * 1.38));

    if (two) {
        l1.setAttribute('y', '28');
        l2.setAttribute('x', '170');
        l2.setAttribute('dy', String(lineGap));
    } else {
        l1.setAttribute('y', '36');
        l2.setAttribute('x', '170');
        l2.setAttribute('dy', '0');
        l2.textContent = '';
    }

    if (textRoot) textRoot.setAttribute('font-size', fs);

    if (textSvg) {
        if (two) {
            textSvg.setAttribute('viewBox', '0 0 340 80');
            textSvg.setAttribute('height', '80');
        } else {
            textSvg.setAttribute('viewBox', '0 0 340 60');
            textSvg.setAttribute('height', '60');
        }
    }

    document.body.classList.remove('attendance-popup-anim');
    popup.classList.remove('hidden');
    void popup.offsetHeight;
    document.body.classList.add('attendance-popup-anim');
}

const PERMISSION_HINT_TOAST_MS = 14000;

/**
 * 알림 권한 등 — 안내 + 설정 열기 버튼 (error 전용 showToast와 별도)
 * @param {string} message
 * @param {{ actionLabel?: string, onAction?: () => void }} options
 */
export function showPermissionHintToast(message, options = {}) {
    if (!message) return;
    const { actionLabel = '설정 열기', onAction } = options;
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    toast.className =
        'animate-toast px-4 py-3 rounded-xl text-sm font-medium text-white shadow-lg max-w-full bg-amber-600 flex flex-col gap-3';

    const text = document.createElement('p');
    text.className = 'm-0 leading-snug';
    text.textContent = message;
    toast.appendChild(text);

    let hideTimer = null;
    const remove = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = null;
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.2s ease';
        setTimeout(() => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 200);
    };

    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2 justify-end items-center';
    const laterBtn = document.createElement('button');
    laterBtn.type = 'button';
    laterBtn.className = 'px-3 py-1.5 rounded-lg text-amber-100 text-xs font-semibold hover:bg-white/10';
    laterBtn.textContent = '나중에';
    laterBtn.addEventListener('click', remove);
    row.appendChild(laterBtn);
    if (typeof onAction === 'function') {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className =
            'px-3 py-1.5 rounded-lg bg-white text-amber-800 text-xs font-black hover:bg-amber-50';
        openBtn.textContent = actionLabel;
        openBtn.addEventListener('click', () => {
            try {
                onAction();
            } catch (_) {}
            remove();
        });
        row.appendChild(openBtn);
    }
    toast.appendChild(row);

    container.appendChild(toast);
    hideTimer = setTimeout(remove, PERMISSION_HINT_TOAST_MS);
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

