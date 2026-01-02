// UI 관련 함수들
export function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    let bgClass = type === 'success' ? 'bg-emerald-600' : (type === 'error' ? 'bg-red-500' : 'bg-slate-800');
    toast.className = `${bgClass} text-white px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-bold animate-toast mb-2 max-w-xs`;
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
    const overlay = document.getElementById('loadingOverlay');
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
    if (overlay) overlay.classList.add('hidden');
}

export function updateHeaderUI() {
    const p = window.userSettings.profile;
    const iconEl = document.getElementById('headerIcon');
    const nameEl = document.getElementById('headerName');
    if (iconEl) iconEl.innerText = p.icon || '🐻';
    if (nameEl) nameEl.innerText = p.nickname || '게스트';
}



