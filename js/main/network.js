/**
 * 메인 앱 네트워크 상태 (오프라인 오버레이)
 */
import { showNetworkErrorOverlay, hideNetworkErrorOverlay } from '../ui.js';

function mealogMainAppVisible() {
    try {
        const main = document.getElementById('mainApp');
        return !!(main && !main.classList.contains('hidden'));
    } catch (_) {
        return false;
    }
}

/** main.js 초기화 시 한 번 호출 */
export function registerMainNetworkListeners() {
    window.addEventListener('offline', () => {
        if (mealogMainAppVisible() && window.currentUser) {
            showNetworkErrorOverlay({
                message:
                    '인터넷 연결이 끊어졌습니다. Wi-Fi 또는 데이터 연결을 확인한 뒤 다시 불러오기를 눌러 주세요.'
            });
        }
    });
    window.addEventListener('online', () => {
        hideNetworkErrorOverlay();
    });
}
