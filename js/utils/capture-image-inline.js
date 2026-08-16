/**
 * html2canvas 캡처용 — `<img>` 를 data URL 로 인라인한다.
 *
 * 캡처는 캔버스에 그리므로 이미지가 CORS 로 읽을 수 있어야 한다. 아니면 캔버스가 오염되어
 * `toBlob`/`toDataURL` 이 통째로 실패한다. 그래서 캡처 직전에 data URL 로 바꿔 둔다.
 *
 * ── 왜 직접 fetch 를 먼저 하는가 ────────────────────────────────────────────────
 * 예전에는 `firebasestorage.googleapis.com` URL 이면 **무조건** `getStorageImageAsBase64`
 * 콜러블로 우회했다("CORS 우회"라는 주석과 함께). 그런데 그 경로는 비싸다:
 *
 *   Storage → Function 다운로드 + base64 팽창(+33%) + Function → 클라이언트 전송
 *
 * 직접 fetch 대비 대역폭이 두 배를 넘고, 거기에 Function 실행 비용이 붙는다. 이미지가 여러
 * 장이면 그만큼 곱해진다.
 *
 * 그리고 그 우회는 **더 이상 필요하지 않다.** 버킷에 CORS 가 설정돼 있다
 * (`config/storage-cors.json`: origin `*`, method 에 GET/HEAD 포함. 2026-08-10 라이브 버킷에서
 * 적용 확인). 그러면 브라우저가 직접 받아올 수 있다.
 *
 * ── 그래도 콜러블을 지우지 않는 이유 ───────────────────────────────────────────
 * CORS 설정은 버킷 쪽 상태라 이 저장소가 통제하지 못한다. 되돌려지거나 특정 환경(WebView
 * 프록시 등)에서 막히면, 콜러블이 없을 때는 **공유 기능이 통째로 죽는다.** 느린 폴백이
 * 죽은 기능보다 낫다. 그래서 직접 fetch 를 기본으로 하고 실패했을 때만 콜러블로 내려간다.
 */
import { withDeadline, DEADLINE } from './with-deadline.js';

const STORAGE_HOST = 'firebasestorage.googleapis.com';

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('read-failed'));
        reader.readAsDataURL(blob);
    });
}

/**
 * 브라우저가 직접 받아온다 (CORS 가 열려 있을 때의 정상 경로).
 *
 * 상한을 거는 이유는 성능이 아니라 **정착 보장**이다(`docs/reliability-principles.md`).
 * 예전 코드는 firebasestorage URL 에 대해 fetch 를 아예 하지 않았으므로, 여기서 상한 없이
 * 매달리면 예전에 없던 교착을 새로 만드는 셈이 된다. 넉넉하게 잡되 무한은 아니게 둔다 —
 * 이 시간을 넘겼다면 회선이 느린 게 아니라 뭔가 잘못된 것이고, 그때는 폴백이 낫다.
 */
async function fetchAsDataUrl(url) {
    return withDeadline(
        (async () => {
            const res = await fetch(url, { mode: 'cors' });
            if (!res.ok) throw new Error(`http-${res.status}`);
            return blobToDataUrl(await res.blob());
        })(),
        DEADLINE.UPLOAD,
        'capture-image-fetch'
    );
}

/** 폴백 — Function 이 Storage 에서 받아 base64 로 돌려준다 (비싸다, 위 주석 참고) */
async function fetchViaCallable(url) {
    const { callableFunctions } = await import('../firebase.js');
    const result = await withDeadline(
        callableFunctions.getStorageImageAsBase64({ imageUrl: url }),
        DEADLINE.UPLOAD,
        'capture-image-callable'
    );
    return result?.data?.dataUrl || null;
}

/**
 * 이미지 URL 하나를 data URL 로.
 * @param {string} url
 * @returns {Promise<string|null>} 실패하면 null (호출부는 그 이미지를 건너뛴다)
 */
export async function resolveCaptureImageDataUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
        return await fetchAsDataUrl(url);
    } catch (e) {
        // Storage 이미지가 아니면 폴백할 수단이 없다 — 콜러블은 Storage 전용이다
        if (!url.includes(STORAGE_HOST)) {
            console.warn('[capture] 이미지 인라인 실패:', e?.message || e);
            return null;
        }
        console.warn('[capture] 직접 fetch 실패 — 콜러블로 폴백:', e?.message || e);
    }
    try {
        return await fetchViaCallable(url);
    } catch (e) {
        console.warn('[capture] 콜러블 폴백도 실패:', e?.message || e);
        return null;
    }
}

/** data URL 을 실제로 물린 뒤 디코드까지 기다린다 (캡처 시점에 그려져 있어야 한다) */
export function applyDataUrlToCaptureImage(img, dataUrl) {
    return new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('이미지 로드 실패'));
        img.src = dataUrl;
        if (img.complete && img.naturalWidth > 0) resolve();
    });
}

/**
 * 컨테이너 안의 원격 이미지를 전부 data URL 로 바꾼다. **병렬로 처리한다** —
 * 직렬로 돌리면 이미지 수만큼 왕복이 쌓여 공유 버튼이 그만큼 늦게 반응한다.
 *
 * 개별 이미지의 실패는 삼킨다. 사진 한 장 때문에 공유 전체가 실패하는 것보다,
 * 그 자리만 비거나 원본이 남는 편이 낫다.
 *
 * @param {ParentNode|null} root
 * @param {string} [label] 로그용
 */
export async function inlineImagesForCapture(root, label = '') {
    if (!root?.querySelectorAll) return;
    const imgs = [...root.querySelectorAll('img[src^="http"]')];
    if (imgs.length === 0) return;
    await Promise.all(
        imgs.map(async (img) => {
            try {
                const dataUrl = await resolveCaptureImageDataUrl(img.src);
                if (!dataUrl) return;
                await applyDataUrlToCaptureImage(img, dataUrl);
            } catch (e) {
                console.warn(`[capture] ${label || 'image'} 인라인 실패:`, e?.message || e);
            }
        })
    );
}
