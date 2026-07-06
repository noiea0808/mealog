/**
 * 네트워크 오버레이「다시 불러오기」용 — 실제 HTTP 왕복으로 연결 여부만 본다.
 * navigator.onLine 만으로는 오탐·미갱신이 잦아 별도 프로브를 둔다.
 */

/**
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function probeMealogNetworkReachable(timeoutMs = 8000) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const href =
            window.location && typeof window.location.href === 'string'
                ? window.location.href.split('#')[0]
                : '/';
        const res = await fetch(href, {
            method: 'GET',
            cache: 'no-store',
            signal: ctrl.signal,
            credentials: 'same-origin'
        });
        if (res.ok) return true;
        if (res.type === 'opaqueredirect') return true;
        return res.status > 0 && res.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(tid);
    }
}

/**
 * 실제 인터넷(원격 서버) 도달 여부.
 * Capacitor 네이티브 앱은 로컬(localhost)에서 자산을 서빙하므로 자기 href fetch는 오프라인에서도
 * 성공할 수 있다. 재연결 감지에는 외부 호스트로의 왕복이 필요하다.
 * no-cors 요청이라 응답 내용은 못 읽지만, 네트워크가 끊겨 있으면 reject 되므로 그것으로 판별한다.
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function probeMealogRemoteReachable(timeoutMs = 5000) {
    // navigator.onLine 은 Android WebView에서 재연결 후에도 false 로 남는 경우가 많아
    // 실제 원격 fetch 로만 판별한다.
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        // gstatic 204 — Firebase SDK도 이 도메인에서 로드하므로 이미 신뢰/허용된 호스트
        await fetch(`https://www.gstatic.com/generate_204?_=${Date.now()}`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            signal: ctrl.signal
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(tid);
    }
}
