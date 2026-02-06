// 렌더링 공통 유틸리티 함수

// HTML 이스케이프 함수 (XSS 방지)
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/** 밀톡/공지용 포맷팅: b, strong, u, s, strike, br만 허용하여 XSS 방지 */
const ALLOWED_TAGS = ['b', 'strong', 'u', 's', 'strike', 'br'];
const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button'];

/** 위험 태그만 제거, 나머지는 유지 (서식 보존용) */
export function stripDangerousTagsOnly(html) {
    if (!html || typeof html !== 'string') return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName?.toLowerCase();
            const childNodes = [...node.childNodes];
            childNodes.forEach(walk);
            if (DANGEROUS_TAGS.includes(tag)) {
                const frag = document.createDocumentFragment();
                while (node.firstChild) frag.appendChild(node.firstChild);
                node.parentNode?.replaceChild(frag, node);
            } else {
                // 위험하지 않은 태그: 모든 속성 제거 (XSS 방지)
                while (node.attributes.length > 0) node.removeAttribute(node.attributes[0].name);
            }
        }
    };
    walk(tmp);
    return tmp.innerHTML;
}

export function sanitizeFormattedText(html) {
    if (!html || typeof html !== 'string') return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName?.toLowerCase();
            // 1) 먼저 자식들을 재귀 처리 (div/p 등 제거 후 남은 자식도 정리)
            const childNodes = [...node.childNodes];
            childNodes.forEach(walk);
            // 2) 허용 태그가 아니면 현재 노드를 자식으로 교체
            if (!ALLOWED_TAGS.includes(tag)) {
                const frag = document.createDocumentFragment();
                while (node.firstChild) frag.appendChild(node.firstChild);
                node.parentNode?.replaceChild(frag, node);
            }
        }
    };
    walk(tmp);
    return tmp.innerHTML;
}

/** 목록 미리보기용: HTML 제거 후 텍스트만 반환 (line-clamp-2와 호환) */
export function getPlainTextPreview(html) {
    if (!html || typeof html !== 'string') return '';
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.textContent || div.innerText || '').replace(/\n/g, ' ').trim();
}

/** 포맷된 콘텐츠를 안전하게 렌더링 (밀톡 본문, 공지 본문용) */
export function renderFormattedContent(html) {
    if (!html || typeof html !== 'string') return '';
    let sanitized = sanitizeFormattedText(html).trim();
    // sanitize가 내용을 비웠을 수 있음 - 위험 태그만 제거하고 서식 보존
    if (!sanitized && html.trim()) {
        sanitized = stripDangerousTagsOnly(html).trim();
    }
    if (!sanitized && html.trim()) {
        const div = document.createElement('div');
        div.innerHTML = html;
        const text = (div.textContent || div.innerText || '').trim();
        return text ? escapeHtml(text).replace(/\n/g, '<br>') : escapeHtml(html).replace(/\n/g, '<br>');
    }
    return sanitized.replace(/\n/g, '<br>');
}
