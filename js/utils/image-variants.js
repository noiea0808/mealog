/**

 * 이미지 파생본(display 800px / thumb 200px) 선택 + 로딩 실패 폴백 유틸.

 *

 * 설계 원칙(1·2차):

 * - 기존 데이터(photoDisplayUrl/photoThumbUrl 없음)는 항상 원본(photoUrl)으로 안전 fallback.

 * - 어떤 경우에도 최종 fallback은 원본 URL이라 화면이 비지 않는다.

 * - 라이트박스/원본 확대/공유 캡처는 getOriginalImageUrl만 사용한다.

 */



import { logImagePick, logImageFallback } from './image-loading-debug.js';



function firstNonEmpty(...vals) {

    for (const v of vals) {

        if (typeof v === 'string') {

            const s = v.trim();

            if (s) return s;

        }

    }

    return '';

}



/** meals 문서(record) vs 모먼트 photo 객체 구분 */

function isMealRecord(src) {

    return !!(src && Array.isArray(src.photos));

}



function classifyDisplayKind(chosen, original, explicitDisplay) {

    if (!chosen || chosen === original) return 'original';

    if (explicitDisplay && chosen === explicitDisplay) return 'display';

    return 'display';

}



function classifyThumbKind(chosen, original, explicitThumb, explicitDisplay) {

    if (!chosen || chosen === original) return 'original';

    if (explicitThumb && chosen === explicitThumb) return 'thumb';

    if (explicitDisplay && chosen === explicitDisplay) return 'display';

    return 'thumb';

}



/** 피드/모먼트 photo 객체(momentPostV2ToPhotoGroup 결과)에서 표시용(800px) URL 우선 선택 */

export function pickDisplayUrl(src) {

    if (!src) return '';

    return firstNonEmpty(src.photoDisplayUrl, src.displayUrl, src.photoUrl, src.url);

}



/** 작은 썸네일/블러 배경용(200px) URL 우선 선택 (thumb → display → 원본) */

export function pickThumbUrl(src) {

    if (!src) return '';

    return firstNonEmpty(

        src.photoThumbUrl,

        src.thumbUrl,

        src.photoDisplayUrl,

        src.displayUrl,

        src.photoUrl,

        src.url

    );

}



/** 원본(라이트박스/확대/캡처)용 URL */

export function pickOriginalUrl(src) {

    if (!src) return '';

    return firstNonEmpty(src.photoUrl, src.url, src.photoDisplayUrl, src.displayUrl);

}



/** 식사 record(index 정렬 배열: photos / photoDisplayUrls / photoThumbUrls)에서 index별 표시용 URL */

export function pickMealDisplayUrl(record, i = 0) {

    if (!record) return '';

    const disp = Array.isArray(record.photoDisplayUrls) ? record.photoDisplayUrls[i] : '';

    const orig = Array.isArray(record.photos) ? record.photos[i] : '';

    return firstNonEmpty(disp, orig);

}



/** 식사 record에서 index별 썸네일용 URL (thumb → display → 원본) */

export function pickMealThumbUrl(record, i = 0) {

    if (!record) return '';

    const thumb = Array.isArray(record.photoThumbUrls) ? record.photoThumbUrls[i] : '';

    const disp = Array.isArray(record.photoDisplayUrls) ? record.photoDisplayUrls[i] : '';

    const orig = Array.isArray(record.photos) ? record.photos[i] : '';

    return firstNonEmpty(thumb, disp, orig);

}



/**

 * 표시용(800px) URL — meals record 또는 모먼트 photo 객체.

 * @param {object} src

 * @param {number} [index=0]

 * @param {string} [component=''] dev 로그용 소비처 이름

 */

export function getDisplayImageUrl(src, index = 0, component = '') {

    if (!src) return '';

    let chosen = '';

    let original = '';

    let explicitDisplay = '';

    if (isMealRecord(src)) {

        original = firstNonEmpty(Array.isArray(src.photos) ? src.photos[index] : '', src.photoUrl);

        explicitDisplay = Array.isArray(src.photoDisplayUrls) ? src.photoDisplayUrls[index] : '';

        chosen = pickMealDisplayUrl(src, index) || original;

    } else {

        original = pickOriginalUrl(src);

        explicitDisplay = firstNonEmpty(src.photoDisplayUrl, src.displayUrl);

        chosen = pickDisplayUrl(src) || original;

    }

    const kind = classifyDisplayKind(chosen, original, explicitDisplay);

    logImagePick(component, kind, chosen, original);

    return chosen;

}



/**

 * 썸네일(200px) URL — thumb → display → 원본.

 */

export function getThumbImageUrl(src, index = 0, component = '') {

    if (!src) return '';

    let chosen = '';

    let original = '';

    let explicitThumb = '';

    let explicitDisplay = '';

    if (isMealRecord(src)) {

        original = firstNonEmpty(Array.isArray(src.photos) ? src.photos[index] : '', src.photoUrl);

        explicitThumb = Array.isArray(src.photoThumbUrls) ? src.photoThumbUrls[index] : '';

        explicitDisplay = Array.isArray(src.photoDisplayUrls) ? src.photoDisplayUrls[index] : '';

        chosen = pickMealThumbUrl(src, index) || original;

    } else {

        original = pickOriginalUrl(src);

        explicitThumb = firstNonEmpty(src.photoThumbUrl, src.thumbUrl);

        explicitDisplay = firstNonEmpty(src.photoDisplayUrl, src.displayUrl);

        chosen = pickThumbUrl(src) || original;

    }

    const kind = classifyThumbKind(chosen, original, explicitThumb, explicitDisplay);

    logImagePick(component, kind, chosen, original);

    return chosen;

}



/** 원본 URL — 라이트박스·확대·공유 캡처 전용 */

export function getOriginalImageUrl(src, index = 0, component = '') {

    if (!src) return '';

    let url = '';

    if (isMealRecord(src)) {

        url = firstNonEmpty(Array.isArray(src.photos) ? src.photos[index] : '', src.photoUrl);

    } else {

        url = pickOriginalUrl(src);

    }

    logImagePick(component, 'original', url, url);

    return url;

}



/** 블러 배경 — thumb와 동일 우선순위(thumb → display → 원본) */
export function getBlurImageUrl(src, index = 0, component = '') {
    if (!src) return '';
    let chosen = '';
    let original = '';
    if (isMealRecord(src)) {
        original = firstNonEmpty(Array.isArray(src.photos) ? src.photos[index] : '', src.photoUrl);
        chosen = pickMealThumbUrl(src, index) || original;
    } else {
        original = pickOriginalUrl(src);
        chosen = pickThumbUrl(src) || original;
    }
    logImagePick(component || 'blur', 'blur', chosen, original);
    return chosen;
}



/**

 * <img>가 파생본 로딩에 실패했을 때 원본으로 1회 교체한다(무한 루프 방지).

 */

function fallbackToOriginal(img) {

    try {

        if (!img || img.dataset.imgFellBack === '1') return;

        const orig = img.getAttribute('data-original-src') || '';

        if (!orig || img.src === orig) return;

        const from = img.src || '';

        img.dataset.imgFellBack = '1';

        img.src = orig;

        logImageFallback(from, orig, img.dataset.imgDebugComponent || 'onerror');

    } catch {

        /* no-op */

    }

}



if (typeof window !== 'undefined') {

    window.__imgFallbackToOriginal = fallbackToOriginal;

}



/**

 * 파생본 URL을 쓸 때 <img>에 붙일 폴백 속성 문자열.

 * @param {string} originalUrl 원본 URL

 * @param {string} usedUrl 실제 src

 * @param {(s:string)=>string} escapeAttr

 * @param {string} [debugComponent=''] dev fallback 로그용

 */

export function imgFallbackAttrs(originalUrl, usedUrl, escapeAttr, debugComponent = '') {

    const orig = typeof originalUrl === 'string' ? originalUrl.trim() : '';

    if (!orig || orig === usedUrl) return '';

    const esc = typeof escapeAttr === 'function' ? escapeAttr : (s) => String(s == null ? '' : s);

    const comp = debugComponent ? ` data-img-debug-component="${esc(debugComponent)}"` : '';

    return ` data-original-src="${esc(orig)}"${comp} onerror="window.__imgFallbackToOriginal&&window.__imgFallbackToOriginal(this)"`;

}


