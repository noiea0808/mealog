/**
 * 정착(settle)을 보장하는 단일 관문.
 *
 * 이 프로젝트에서 반복된 교착의 형태는 항상 같았다 — 공유 in-flight 가드 안에서 상한 없는
 * await 를 하면 그 가드는 영구히 잠긴다. 실제로 `drainInFlight` 가 그렇게 죽어서, 세션이
 * 끝날 때까지 아웃박스 드레인이 통째로 멈췄다(재전송 버튼을 눌러도 아무 일도 일어나지 않는 상태).
 *
 * 개별 호출부에 타임아웃을 하나씩 박는 방식은 다음에 추가되는 await 를 못 막는다. 그래서
 * 네트워크성 호출은 **전부 이 관문을 통과**시키고, 관문 밖 직접 await 는 ESLint 로 금지한다.
 * 문서는 안 읽힐 수 있지만 린트는 돈다.
 *
 * 「얼마나 기다릴 것인가」를 호출부가 매번 새로 정하지 않도록 표준 값을 여기 모아 둔다.
 */

/** 표준 상한. 새 값을 만들기 전에 여기 있는 것으로 되는지 먼저 본다. */
export const DEADLINE = {
    /** 로컬 IndexedDB 등 — 네트워크가 아니므로 짧게 */
    LOCAL: 3000,
    /** 토큰·App Check 등 쓰기 앞단의 준비 단계. 실패해도 진행해야 하므로 짧게 */
    PREFLIGHT: 2000,
    /** 단일 문서 읽기·쓰기 */
    DOC: 8000,
    /** 사용자가 결과를 기다리는 저장 경로 */
    SAVE: 10000,
    /** 사진 N장 업로드 등 긴 작업 */
    UPLOAD: 30000
};

export class DeadlineError extends Error {
    constructor(label, ms) {
        super(`deadline-exceeded: ${label || 'unnamed'} (${ms}ms)`);
        this.name = 'DeadlineError';
        this.code = 'deadline-exceeded';
        this.__mealogDeadline = true;
        this.label = label || '';
        this.timeoutMs = ms;
    }
}

/**
 * 관문이 발화했을 때 알림을 받을 곳. 계측 모듈이 부팅 시 1회 등록한다.
 * 여기서 diagnostics 를 직접 import 하지 않는 이유는 순환 의존 때문이다 —
 * 계측 자신도 이 관문을 쓴다.
 * @type {((info: { label: string, timeoutMs: number }) => void) | null}
 */
let deadlineSink = null;

/** @param {(info: { label: string, timeoutMs: number }) => void} fn */
export function registerDeadlineSink(fn) {
    deadlineSink = typeof fn === 'function' ? fn : null;
}

function notifyDeadline(label, timeoutMs) {
    if (!deadlineSink) return;
    try {
        deadlineSink({ label, timeoutMs });
    } catch (_) {
        /* 계측이 본 작업을 방해하지 않는다 */
    }
}

/**
 * 원 프라미스가 관문보다 늦게 거절돼도 unhandledrejection 으로 새지 않게 관찰만 해 둔다.
 * @param {Promise<any>} p
 */
function observe(p) {
    try {
        p.catch(() => {});
    } catch (_) {
        /* ignore */
    }
    return p;
}

/**
 * 상한 안에 정착하지 않으면 DeadlineError 로 거절한다.
 *
 * 주의: 이 함수는 원 작업을 **취소하지 않는다**. Firestore SDK 는 AbortSignal 을 받지 않으므로
 * 취소할 방법이 없고, 백그라운드에서 계속 돌다가 나중에 성공할 수도 있다. 그건 정상이다 —
 * 이 관문이 보장하는 것은 「호출부가 영원히 멈춰 있지 않는다」 하나뿐이다.
 *
 * @template T
 * @param {Promise<T> | (() => Promise<T>)} work
 * @param {number} timeoutMs
 * @param {string} [label] 계측·로그용 이름
 * @returns {Promise<T>}
 */
export function withDeadline(work, timeoutMs, label = '') {
    const ms = Number(timeoutMs);
    const started = typeof work === 'function' ? Promise.resolve().then(work) : Promise.resolve(work);
    if (!ms || ms < 1) return started;
    observe(started);

    let timer = 0;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            notifyDeadline(label, ms);
            reject(new DeadlineError(label, ms));
        }, ms);
    });

    return Promise.race([started, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * 상한 안에 정착하지 않거나 실패하면 fallback 으로 **resolve** 한다. 절대 거절하지 않는다.
 *
 * 「실패해도 진행해야 하는」 단계에 쓴다 — 토큰 갱신, App Check, 정합 읽기 등.
 * 그런 단계에서 예외를 던지면 호출부가 그걸 다시 중단 조건으로 쓰게 되고, 그게 지금까지
 * 없애려던 구조 그 자체다.
 *
 * @template T
 * @param {Promise<T> | (() => Promise<T>)} work
 * @param {number} timeoutMs
 * @param {T} fallbackValue
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withDeadlineOr(work, timeoutMs, fallbackValue, label = '') {
    return withDeadline(work, timeoutMs, label).catch((e) => {
        if (!e?.__mealogDeadline) {
            console.warn(`[deadline] ${label || 'unnamed'} 실패:`, e?.message || e);
        }
        return fallbackValue;
    });
}

/**
 * 만료가 있는 실행 리스. 불린 in-flight 가드를 대체한다.
 *
 * 불린 가드는 「해제하는 코드에 도달해야만」 풀린다. 그 사이에 상한 없는 await 가 하나라도
 * 있으면 영구히 잠긴다. 리스는 시간으로 풀리므로 어디서 매달려도 스스로 회복한다.
 */
export class Lease {
    /**
     * @param {string} name 계측·로그용
     * @param {number} ttlMs 이 시간이 지나면 점유가 만료된 것으로 본다
     */
    constructor(name, ttlMs) {
        this.name = name;
        this.ttlMs = ttlMs;
        /** @type {number} 0 이면 비어 있음 */
        this._heldUntil = 0;
        this._acquiredAt = 0;
    }

    /** 지금 유효하게 점유돼 있는가 */
    get held() {
        return this._heldUntil > Date.now();
    }

    /**
     * 점유를 시도한다. 이미 유효한 점유가 있으면 false.
     * 만료된 점유는 빼앗으면서 계측에 남긴다 — 만료가 잦다면 그 자체가 버그 신호다.
     */
    acquire() {
        const now = Date.now();
        if (this._heldUntil > now) return false;
        if (this._heldUntil > 0) {
            notifyDeadline(`lease-expired:${this.name}`, now - this._acquiredAt);
        }
        this._acquiredAt = now;
        this._heldUntil = now + this.ttlMs;
        return true;
    }

    /** 정상 종료 시 즉시 반납 */
    release() {
        this._heldUntil = 0;
        this._acquiredAt = 0;
    }

    /**
     * 오래 걸리는 정상 작업이 리스를 뺏기지 않도록 연장한다.
     * 진행 중임을 **관측했을 때만** 부른다. 무조건 연장하면 불린 가드와 같아진다.
     */
    renew() {
        if (this._heldUntil === 0) return;
        this._heldUntil = Date.now() + this.ttlMs;
    }

    /**
     * acquire → 작업 → release 를 묶는다. 작업이 던져도 반드시 반납한다.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T | undefined>} 점유 실패 시 undefined
     */
    async run(fn) {
        if (!this.acquire()) return undefined;
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}
