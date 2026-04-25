/**
 * 전면 로딩(음식 아이콘 순환) — Firestore `config/loadingSpinner` (비로그인 읽기 가능).
 * 매 호출마다 서버 우선 조회(관리자 저장 직후 반영). App Check 준비 후 읽어 권한 실패를 줄임.
 *
 * 아이콘 한 칸 전환 주기는 앱에서 **0.5초 고정**. 관리자 숫자는 **순환 스크립트(문구) 전환 주기**만 제어.
 */
import { db, appId, refreshAppCheckTokenBeforeFirestore } from './firebase.js';
import { doc, getDoc, getDocFromServer } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';

/** 순환 스크립트(문구) 전환 주기 기본값(초) — 관리자 미설정 시 */
export const LOADING_SPINNER_DEFAULT_SECONDS = 1.8;

/** 전면 로딩 오버레이: 음식 아이콘 한 슬롯(초) — 고정 */
export const LOADING_SPINNER_OVERLAY_ICON_SECONDS = 0.5;
/** 하단 FAB(기록 로딩): 오버레이와 별도로 빠른 전환(초) */
export const LOADING_SPINNER_FAB_ICON_SECONDS = 0.2;

/** @deprecated `LOADING_SPINNER_OVERLAY_ICON_SECONDS` 사용 */
export const LOADING_SPINNER_ICON_SECONDS_FIXED = LOADING_SPINNER_OVERLAY_ICON_SECONDS;

/** @deprecated 호환용 — 예전 메모리 캐시 제거 후에는 동작 없음(관리자 저장 후에도 안전). */
export function invalidateLoadingSpinnerConfigCache() {}

/**
 * 스크립트(순환 문구) 전환 주기 — `messageCycleSeconds` 우선, 구데이터는 `iconCycleSeconds`.
 * @param {unknown} raw
 * @returns {number | undefined}
 */
function extractMessageCycleSecondsFromRaw(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const rawSec =
        raw.messageCycleSeconds ??
        raw.scriptCycleSeconds ??
        raw.iconCycleSeconds ??
        raw.iconCycleSec ??
        raw.cycleSeconds;
    if (rawSec === undefined || rawSec === null || rawSec === '') return undefined;
    const n = typeof rawSec === 'number' ? rawSec : parseFloat(String(rawSec).replace(',', '.'));
    if (Number.isFinite(n) && n >= 0.5 && n <= 10) return n;
    return undefined;
}

function normalizeMessagesOnly(raw) {
    const messages = [];
    if (raw && typeof raw === 'object') {
        let arr = raw.messages;
        if (!Array.isArray(arr) && Array.isArray(raw.spinnerMessages)) arr = raw.spinnerMessages;
        if (Array.isArray(arr)) {
            for (const m of arr) {
                if (m == null) continue;
                const s = String(m).trim();
                if (s) messages.push(s);
            }
        }
    }
    return messages;
}

/**
 * @param {unknown} raw
 * @returns {{ messageCycleSeconds: number, messages: string[] }}
 */
export function normalizeLoadingSpinner(raw) {
    const msgOpt = extractMessageCycleSecondsFromRaw(raw);
    const messageCycleSeconds = msgOpt !== undefined ? msgOpt : LOADING_SPINNER_DEFAULT_SECONDS;
    const messages = normalizeMessagesOnly(raw);
    return { messageCycleSeconds, messages };
}

/**
 * `config/loadingSpinner` 단독 문서는 Rules 미배포·App Check 등으로 비로그인 읽기가 막힐 수 있음.
 * `config/loginBanner`는 공개 읽기가 검증된 경로이므로, 관리자 저장 시 `loadingSpinner` 필드로 동일 내용을 복제한다.
 */
async function readRawBannerSpinner() {
    try {
        const bSnap = await getDoc(doc(db, 'artifacts', appId, 'config', 'loginBanner'));
        if (!bSnap.exists()) return null;
        const nested = bSnap.data()?.loadingSpinner;
        return nested && typeof nested === 'object' ? nested : null;
    } catch (e) {
        console.warn('loadingSpinner(loginBanner 복제):', e?.message || e);
        return null;
    }
}

async function readRawDedicatedSpinner() {
    const ref = doc(db, 'artifacts', appId, 'config', 'loadingSpinner');
    try {
        const serverSnap = await getDocFromServer(ref);
        if (serverSnap.exists()) return serverSnap.data();
    } catch (e1) {
        console.warn('loadingSpinner getDocFromServer:', e1?.code || '', e1?.message || e1);
    }
    try {
        const snap = await getDoc(ref);
        if (snap.exists()) return snap.data();
    } catch (e2) {
        console.warn('loadingSpinner getDoc:', e2?.message || e2);
    }
    return null;
}

export async function getLoadingSpinnerConfig() {
    try {
        await refreshAppCheckTokenBeforeFirestore({ force: true });
    } catch (_) {
        /* ignore */
    }
    const rawBanner = await readRawBannerSpinner();
    const rawDedicated = await readRawDedicatedSpinner();

    const msgBanner = rawBanner ? normalizeMessagesOnly(rawBanner) : [];
    const msgDedicated = rawDedicated ? normalizeMessagesOnly(rawDedicated) : [];
    const messages =
        (msgBanner.length ? msgBanner : null) || (msgDedicated.length ? msgDedicated : null) || [];

    /** 전용 문서에 주기 필드가 없으면(구데이터) loginBanner 복제본의 주기를 쓴다 */
    let messageCycleSeconds =
        extractMessageCycleSecondsFromRaw(rawDedicated) ??
        extractMessageCycleSecondsFromRaw(rawBanner) ??
        LOADING_SPINNER_DEFAULT_SECONDS;
    messageCycleSeconds = Number(messageCycleSeconds);
    if (!Number.isFinite(messageCycleSeconds)) messageCycleSeconds = LOADING_SPINNER_DEFAULT_SECONDS;

    return { messages, messageCycleSeconds };
}

/**
 * 관리자「스크립트(순환 문구) 전환 주기(초)」— Firestore 값 clamp
 * @param {unknown} seconds
 * @returns {number}
 */
export function resolveSpinnerMessageCycleSeconds(seconds) {
    const parsed = Number(seconds);
    return Math.min(10, Math.max(0.5, Number.isFinite(parsed) ? parsed : LOADING_SPINNER_DEFAULT_SECONDS));
}

/**
 * @deprecated `LOADING_SPINNER_OVERLAY_ICON_SECONDS` 고정. 호환용으로 0.5만 반환.
 */
export function resolveSpinnerIconCycleSeconds(_seconds) {
    return LOADING_SPINNER_OVERLAY_ICON_SECONDS;
}

/**
 * 순환 문구 전환 간격(ms) — 관리자「스크립트 전환 주기」와 동일.
 * @param {number} resolvedMessageCycleSec `resolveSpinnerMessageCycleSeconds` 결과(초)
 * @returns {number}
 */
export function getSpinnerMessageStepMs(resolvedMessageCycleSec) {
    const s = resolveSpinnerMessageCycleSeconds(resolvedMessageCycleSec);
    return s * 1000;
}

/**
 * 로딩 종료 후 인라인 애니메이션 제거 → stylesheet 기본값 복귀
 */
export function clearLoadingFoodIconInlineAnimation() {
    try {
        document.querySelectorAll('.loading-food-icon').forEach((el) => {
            el.style.removeProperty('animation');
        });
    } catch (_) {
        /* ignore */
    }
}

/**
 * 관리자 설정(초)을 각 아이콘 `animation` 인라인에 직접 넣음 — CSS 변수만으로는 적용이 묻히는 환경 대비
 * 전면 오버레이는 `LOADING_SPINNER_OVERLAY_ICON_SECONDS`, FAB는 `LOADING_SPINNER_FAB_ICON_SECONDS`.
 * 첫 인자는 호환용으로 무시.
 * @param {number} [_secondsIgnored]
 * @param {HTMLElement | null} [overlayEl]
 */
export function applyLoadingFoodIconDurationSeconds(_secondsIgnored, overlayEl = null) {
    const sOverlay = LOADING_SPINNER_OVERLAY_ICON_SECONDS;
    const vOverlay = `${sOverlay}s`;
    const sFab = LOADING_SPINNER_FAB_ICON_SECONDS;
    const vFab = `${sFab}s`;

    document.documentElement.style.setProperty('--loading-food-duration', vOverlay);
    if (overlayEl && overlayEl.style) {
        overlayEl.style.setProperty('--loading-food-duration', vOverlay);
    }
    const box = document.getElementById('loadingOverlayBox');
    if (box && box.style) box.style.setProperty('--loading-food-duration', vOverlay);
    try {
        if (overlayEl) {
            overlayEl.querySelectorAll('.loading-food-icons').forEach((el) => {
                el.style.setProperty('--loading-food-duration', vOverlay);
            });
        }
    } catch (_) {
        /* ignore */
    }

    const names = [
        'loadingFoodSlideRTL0',
        'loadingFoodSlideRTL1',
        'loadingFoodSlideRTL2',
        'loadingFoodSlideRTL3',
        'loadingFoodSlideRTL4',
    ];

    const applyIcons = (root, slotSec) => {
        const vTotal = `${5 * slotSec}s`;
        root.querySelectorAll('.loading-food-icon').forEach((el, i) => {
            const name = names[i] || names[0];
            el.style.animation = `${name} ${vTotal} linear 0s infinite`;
        });
    };

    const overlayRoot = overlayEl || document.getElementById('loadingOverlay');
    if (overlayRoot) {
        applyIcons(overlayRoot, sOverlay);
    }

    const fab = document.getElementById('initialRecordsLoadFab');
    if (fab && fab.style) {
        fab.style.setProperty('--loading-food-fab-slot', vFab);
        applyIcons(fab, sFab);
    }
    const galleryMomentsFab = document.getElementById('galleryMomentsRefreshFab');
    if (galleryMomentsFab && galleryMomentsFab.style) {
        galleryMomentsFab.style.setProperty('--loading-food-fab-slot', vFab);
        applyIcons(galleryMomentsFab, sFab);
    }
}
