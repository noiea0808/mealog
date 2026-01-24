// UI 관련 함수들

// 로딩 오버레이 중앙 관리
let loadingOverlayTimeout = null;

export function showLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.remove('hidden');
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
    if (overlay) {
        overlay.classList.add('hidden');
        if (loadingOverlayTimeout) {
            clearTimeout(loadingOverlayTimeout);
            loadingOverlayTimeout = null;
        }
    }
}

export function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    let bgClass = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-red-500' : 'bg-slate-800');
    toast.className = `${bgClass} text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-bold animate-toast mb-2 w-full max-w-xs`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check' : (type === 'error' ? 'fa-circle-exclamation' : 'fa-info-circle')}"></i><span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

export function switchScreen(isLoggedIn) {
    const landing = document.getElementById('landingPage');
    const main = document.getElementById('mainApp');
    if (!landing || !main) return;
    
    if (isLoggedIn) {
        landing.style.display = 'none';
        main.style.display = 'block';
        main.classList.remove('hidden');
    } else {
        landing.style.display = 'flex';
        main.style.display = 'none';
        main.classList.add('hidden');
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
        if (!window.userSettings || !window.userSettings.profile) {
            return;
        }
        
        const p = window.userSettings.profile;
        const currentNickname = p.nickname || '게스트';
        const currentPhotoUrl = p.photoUrl || '';
        const currentIcon = p.icon || '';
        
        // 프로필 정보가 변경되었는지 확인 (닉네임, 사진, 아이콘 모두 포함)
        const currentProfileKey = `${currentNickname}|${currentPhotoUrl}|${currentIcon}`;
        if (lastHeaderUpdate === currentProfileKey) {
            return;
        }
        
        const iconEl = document.getElementById('headerIcon');
        
        if (iconEl) {
            // 모든 스타일 초기화
            iconEl.style.backgroundImage = '';
            iconEl.style.backgroundSize = '';
            iconEl.style.backgroundPosition = '';
            iconEl.style.borderRadius = '';
            iconEl.style.width = '';
            iconEl.style.height = '';
            iconEl.style.objectFit = '';
            iconEl.innerHTML = '';
            
            if (p.photoUrl) {
                // 사진이 있으면 원형으로 표시
                iconEl.style.backgroundImage = `url(${p.photoUrl})`;
                iconEl.style.backgroundSize = 'cover';
                iconEl.style.backgroundPosition = 'center';
                iconEl.style.borderRadius = '50%';
            } else if (p.icon) {
                // 이모지 표시
                iconEl.innerText = p.icon;
            } else {
                // 텍스트(닉네임 첫 글자)
                const nn = (p.nickname || '').trim();
                const initial = (Array.from(nn)[0] || '?');
                iconEl.innerText = initial;
            }
        }
        
        lastHeaderUpdate = currentProfileKey;
    }, 100);
}

// 전역 함수로 노출 (기존 코드 호환성)
window.showLoading = showLoading;
window.hideLoading = hideLoading;




