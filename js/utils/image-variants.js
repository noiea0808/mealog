/**
 * 이미지 파생본(display 800px / thumb 200px) 선택 + 로딩 실패 폴백 유틸.
 *
 * 설계 원칙(1차 도입):
 * - 기존 데이터(photoDisplayUrl/photoThumbUrl 없음)는 항상 원본(photoUrl)으로 안전 fallback.
 * - 어떤 경우에도 최종 fallback은 원본 URL이라 화면이 비지 않는다.
 * - 라이트박스/원본 확대/공유 캡처는 이 헬퍼를 쓰지 않고 기존 원본 URL을 그대로 사용한다.
 */

function firstNonEmpty(...vals) {
    for (const v of vals) {
        if (typeof v === 'string') {
            const s = v.trim();
            if (s) return s;
        }
    }
    return '';
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
 * <img>가 파생본 로딩에 실패했을 때 원본으로 1회 교체한다(무한 루프 방지).
 * 템플릿에서 `data-original-src="원본" onerror="window.__imgFallbackToOriginal&&window.__imgFallbackToOriginal(this)"` 로 연결.
 */
function fallbackToOriginal(img) {
    try {
        if (!img || img.dataset.imgFellBack === '1') return;
        const orig = img.getAttribute('data-original-src') || '';
        if (!orig || img.src === orig) return;
        img.dataset.imgFellBack = '1';
        img.src = orig;
    } catch {
        /* no-op: 이미지 폴백 실패는 조용히 무시(오류 토스트 과다 노출 방지) */
    }
}

if (typeof window !== 'undefined') {
    window.__imgFallbackToOriginal = fallbackToOriginal;
}

/**
 * 파생본 URL을 쓸 때 <img>에 붙일 폴백 속성 문자열을 만든다.
 * @param {string} originalUrl 원본 URL
 * @param {string} usedUrl 실제 src로 쓴 URL(원본과 같으면 폴백 불필요)
 * @param {(s:string)=>string} escapeAttr 속성값 이스케이프 함수(escapeHtml 등)
 * @returns {string} ` data-original-src="..." onerror="..."` 또는 빈 문자열
 */
export function imgFallbackAttrs(originalUrl, usedUrl, escapeAttr) {
    const orig = typeof originalUrl === 'string' ? originalUrl.trim() : '';
    if (!orig || orig === usedUrl) return '';
    const esc = typeof escapeAttr === 'function' ? escapeAttr : (s) => String(s == null ? '' : s);
    return ` data-original-src="${esc(orig)}" onerror="window.__imgFallbackToOriginal&&window.__imgFallbackToOriginal(this)"`;
}
