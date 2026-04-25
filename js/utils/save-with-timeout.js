/**
 * Promise.race + 단일 타이머. Firestore가 AbortSignal을 받지 않아도 UI 타임아웃(onTimeout)은 보장한다.
 * @param {() => Promise<T>} run — 저장 등 비동기 작업
 * @param {{ timeoutMs: number, onTimeout?: () => void, signal?: AbortSignal }} opts
 * @returns {Promise<T>}
 */
export async function saveWithTimeout(run, opts) {
    const { timeoutMs, onTimeout, signal: outer } = opts || {};
    const ms = Number(timeoutMs);
    if (!ms || ms < 1) return run();

    const ac = new AbortController();
    const onAbort = () => {
        try {
            ac.abort();
        } catch (_) {
            /* ignore */
        }
    };
    if (outer) {
        if (outer.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            return Promise.reject(e);
        }
        outer.addEventListener('abort', onAbort, { once: true });
    }

    let timer;
    let done = false;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (done) return;
            try {
                onTimeout?.();
            } catch (_) {
                /* ignore */
            }
            const e = new Error('deadline-exceeded');
            e.code = 'deadline-exceeded';
            e.__mealogSaveTimeout = true;
            reject(e);
        }, ms);
    });

    try {
        const result = await Promise.race([run(), timeoutPromise]);
        done = true;
        return result;
    } finally {
        done = true;
        if (timer) clearTimeout(timer);
        if (outer) outer.removeEventListener('abort', onAbort);
    }
}
