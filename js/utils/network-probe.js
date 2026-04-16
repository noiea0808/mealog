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
