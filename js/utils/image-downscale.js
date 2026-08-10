/**
 * 사진 인테이크 다운스케일.
 *
 * 왜 필요한가 (docs/sync-outbox-design.md §2.4):
 *   지금까지 사진은 리사이즈 없이 `readAsDataURL` 로 원본이 그대로 들어왔다. 요즘 폰 사진
 *   한 장이 3~12MB 이고 base64 는 +33% 이므로, **기록 하나가 최대 ~80MB 문자열**로
 *   `appState.currentPhotos` 와 `window.mealHistory` 에 동시에 얹혔다.
 *
 *   WebView 가 그만큼 부풀면 백그라운드 전환 시 안드로이드 저메모리 킬러의 1순위 표적이 된다.
 *   즉 「RAM 에만 있는 기록」과 「앱이 죽을 확률」이 곱해진다 — 이것이 사진 있는 기록에서
 *   유실이 더 잦았던 이유다. 다운스케일은 화질 정책이자 **유실 대책**이다.
 *
 * EXIF 회전이 이 파일의 핵심 위험이다:
 *   브라우저는 `<img>` 를 그릴 때 EXIF orientation 을 적용한다(image-orientation: from-image 가
 *   기본값). 그런데 canvas 로 순진하게 그리면 그 정보가 사라져 **사진이 눕는다.** 이 앱에는
 *   orientation 처리가 어디에도 없었으므로(전부 브라우저 기본값에 의존), 다운스케일을 넣는
 *   순간 세로 사진이 전부 돌아가는 회귀가 난다.
 *
 *   그래서 `createImageBitmap(blob, { imageOrientation: 'from-image' })` 로 디코드 단계에서
 *   회전을 적용시킨다. 지원하지 않는 환경은 원본을 그대로 돌려준다 — 용량을 줄이려다 사진을
 *   눕히는 것보다 낫다.
 */
import { withDeadline, DEADLINE } from './with-deadline.js';

/** 장변 상한. 3x DPI 폰도 논리 폭 ~1200px 이라 화면상 체감 차이는 사실상 없다. */
export const DOWNSCALE_MAX_EDGE = 2048;
/** JPEG 품질 */
export const DOWNSCALE_QUALITY = 0.85;
/** 이보다 작으면 재인코딩하지 않는다 — 손실 없는 쪽이 이득이다 */
const SKIP_IF_SMALLER_THAN_BYTES = 512 * 1024;

let bitmapOrientationSupport = null;

/**
 * `createImageBitmap` 이 imageOrientation 옵션을 실제로 지원하는지 1회 확인.
 * 옵션을 모르는 구현은 조용히 무시하므로(= 회전이 안 먹음), 존재만 보고 믿으면 안 된다.
 */
async function detectBitmapOrientationSupport() {
    if (bitmapOrientationSupport !== null) return bitmapOrientationSupport;
    bitmapOrientationSupport = false;
    try {
        if (typeof createImageBitmap !== 'function') return false;
        let sawOption = false;
        const probe = new Blob(
            [Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))],
            { type: 'image/gif' }
        );
        const opts = {};
        Object.defineProperty(opts, 'imageOrientation', {
            get() {
                sawOption = true;
                return 'from-image';
            }
        });
        const bmp = await createImageBitmap(probe, opts);
        try {
            bmp.close?.();
        } catch (_) {
            /* ignore */
        }
        bitmapOrientationSupport = sawOption;
    } catch (_) {
        bitmapOrientationSupport = false;
    }
    return bitmapOrientationSupport;
}

function targetSize(w, h, maxEdge) {
    const longest = Math.max(w, h);
    if (longest <= maxEdge) return null; // 이미 충분히 작다
    const scale = maxEdge / longest;
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/**
 * 이미지 하나를 다운스케일한다.
 *
 * **절대 던지지 않는다.** 실패하면 원본을 그대로 돌려준다 — 용량을 줄이려다 사진을 잃는 것이
 * 최악이다. 호출부는 `downscaled` 로 실제 축소 여부를 알 수 있다.
 *
 * @param {Blob|File} source
 * @param {{ maxEdge?: number, quality?: number }} [opts]
 * @returns {Promise<{ blob: Blob, downscaled: boolean, width: number|null, height: number|null, reason: string }>}
 */
export async function downscaleImage(source, opts = {}) {
    const maxEdge = opts.maxEdge || DOWNSCALE_MAX_EDGE;
    const quality = opts.quality || DOWNSCALE_QUALITY;
    const fallback = (reason) => ({ blob: source, downscaled: false, width: null, height: null, reason });

    if (!source || typeof source.size !== 'number') return fallback('not-a-blob');
    // GIF 는 애니메이션이 죽으므로 건드리지 않는다. SVG 도 래스터화 대상이 아니다.
    const type = String(source.type || '');
    if (type === 'image/gif' || type === 'image/svg+xml') return fallback('animated-or-vector');
    if (source.size < SKIP_IF_SMALLER_THAN_BYTES) return fallback('already-small');

    if (!(await detectBitmapOrientationSupport())) {
        // 회전을 보장할 수 없으면 손대지 않는다 (설계 판단: 눕는 사진 > 큰 용량)
        return fallback('no-orientation-support');
    }

    try {
        return await withDeadline(
            (async () => {
                const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
                try {
                    const size = targetSize(bitmap.width, bitmap.height, maxEdge);
                    if (!size) return fallback('already-within-max-edge');

                    const canvas =
                        typeof OffscreenCanvas === 'function'
                            ? new OffscreenCanvas(size.w, size.h)
                            : Object.assign(document.createElement('canvas'), { width: size.w, height: size.h });
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return fallback('no-2d-context');
                    ctx.drawImage(bitmap, 0, 0, size.w, size.h);

                    const blob =
                        typeof canvas.convertToBlob === 'function'
                            ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
                            : await new Promise((resolve) =>
                                  canvas.toBlob(resolve, 'image/jpeg', quality)
                              );
                    if (!blob) return fallback('encode-failed');
                    // 줄어들지 않았으면 원본을 쓴다 (이미 잘 압축된 사진 등)
                    if (blob.size >= source.size) return fallback('no-size-gain');
                    return { blob, downscaled: true, width: size.w, height: size.h, reason: 'ok' };
                } finally {
                    try {
                        bitmap.close?.();
                    } catch (_) {
                        /* ignore */
                    }
                }
            })(),
            DEADLINE.UPLOAD,
            'image-downscale'
        );
    } catch (e) {
        console.warn('[downscale] 실패, 원본 사용:', e?.message || e);
        return fallback('error');
    }
}

/** Blob → data URL. 기존 UI 가 data URL 문자열을 쓰므로 변환이 필요하다. */
export function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error || new Error('read-failed'));
        r.readAsDataURL(blob);
    });
}

/** data URL → Blob. 아웃박스에 Blob 으로 넣기 위해 (base64 문자열보다 25% 작다) */
export async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
    try {
        const res = await fetch(dataUrl);
        return await res.blob();
    } catch (e) {
        console.warn('[downscale] dataURL→Blob 실패:', e?.message || e);
        return null;
    }
}

/**
 * 파일 하나를 「다운스케일 → data URL」까지 한 번에.
 * 기존 인테이크가 `readAsDataURL` 결과를 그대로 쓰므로 형태를 맞춘다.
 * @returns {Promise<{ dataUrl: string, blob: Blob, downscaled: boolean, reason: string }|null>}
 */
export async function prepareIntakeImage(file) {
    try {
        const r = await downscaleImage(file);
        const dataUrl = await blobToDataUrl(r.blob);
        if (!dataUrl) return null;
        return { dataUrl, blob: r.blob, downscaled: r.downscaled, reason: r.reason };
    } catch (e) {
        console.warn('[downscale] 인테이크 준비 실패:', e?.message || e);
        return null;
    }
}
