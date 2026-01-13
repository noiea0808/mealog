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
        // 메인 화면 표시 시 버전 정보 로드
        loadHeaderVersion();
    } else {
        landing.style.display = 'flex';
        main.style.display = 'none';
        main.classList.add('hidden');
    }
    if (overlay) overlay.classList.add('hidden');
}

// 개발용: 최종 수정 시간 표시 함수
async function loadHeaderVersion() {
    try {
        const versionEl = document.getElementById('devVersionInfo');
        if (!versionEl) {
            console.warn('devVersionInfo 요소를 찾을 수 없습니다.');
            return;
        }
        
        // index.html 파일의 최종 수정 시간 가져오기
        const response = await fetch('/index.html?t=' + Date.now());
        if (response.ok) {
            // Last-Modified 헤더에서 파일의 최근 수정 시간 가져오기
            const lastModified = response.headers.get('Last-Modified');
            if (lastModified) {
                const modifiedDate = new Date(lastModified);
                const dateText = modifiedDate.toLocaleString('ko-KR', { 
                    year: 'numeric',
                    month: '2-digit', 
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                versionEl.textContent = dateText;
            } else {
                // Last-Modified 헤더가 없으면 현재 시간 표시
                const now = new Date();
                const dateText = now.toLocaleString('ko-KR', { 
                    year: 'numeric',
                    month: '2-digit', 
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                versionEl.textContent = dateText;
            }
        } else {
            // 응답 실패 시 현재 시간 표시
            const now = new Date();
            const dateText = now.toLocaleString('ko-KR', { 
                year: 'numeric',
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            versionEl.textContent = dateText;
        }
    } catch (e) {
        console.debug('개발용 버전 정보 로드 실패:', e);
        // 에러 발생 시에도 현재 시간 표시
        const versionEl = document.getElementById('devVersionInfo');
        if (versionEl) {
            const now = new Date();
            const dateText = now.toLocaleString('ko-KR', { 
                year: 'numeric',
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
            versionEl.textContent = dateText;
        }
    }
}

export function updateHeaderUI() {
    const p = window.userSettings.profile;
    const iconEl = document.getElementById('headerIcon');
    const nameEl = document.getElementById('headerName');
    if (iconEl) iconEl.innerText = p.icon || '🐻';
    if (nameEl) nameEl.innerText = p.nickname || '게스트';
}




