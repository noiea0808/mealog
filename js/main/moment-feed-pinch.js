/**
 * 모먼트 피드·갤러리 사진 래퍼(.moment-feed-pinch-host)에서
 * 브라우저 기본 핀치 줌(페이지 확대)만 억지 — 가로 스와이프(1손가락)는 유지
 */
let installed = false;

function isMomentFeedPinchHost(target) {
    return target && typeof target.closest === 'function' && target.closest('.moment-feed-pinch-host');
}

export function ensureMomentFeedPinchDelegate() {
    if (installed || typeof document === 'undefined') return;
    installed = true;

    const onTouchStart = (e) => {
        if (e.touches && e.touches.length >= 2 && isMomentFeedPinchHost(e.target)) {
            e.preventDefault();
        }
    };

    const onTouchMove = (e) => {
        if (e.touches && e.touches.length >= 2 && isMomentFeedPinchHost(e.target)) {
            e.preventDefault();
        }
    };

    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });

    try {
        document.addEventListener(
            'gesturestart',
            (e) => {
                if (isMomentFeedPinchHost(e.target)) e.preventDefault();
            },
            { capture: true, passive: false }
        );
    } catch (_) {
        /* gesture* 미지원 환경 무시 */
    }
}
