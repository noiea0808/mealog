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

/** 관리자 로그 붙여넣기용: 위험 태그 제거 + style/href 등 화이트리스트 (굵기·색 등 유지) */
const ADMIN_LOG_UNWRAP_TAGS = [
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'style',
    'link',
    'meta',
    'base'
];

const ADMIN_LOG_STYLE_PROPS = new Set([
    'font-weight',
    'font-style',
    'text-decoration',
    'text-decoration-line',
    'text-underline-offset',
    'color',
    'background-color',
    'font-size',
    'font-family',
    'text-align',
    'margin',
    'margin-left',
    'margin-right',
    'margin-top',
    'margin-bottom',
    'padding',
    'padding-left',
    'padding-right',
    'padding-top',
    'padding-bottom',
    'list-style-type',
    'vertical-align',
    'line-height',
    /* 표·레이아웃 (붙여넣기 유지) */
    'width',
    'height',
    'min-width',
    'max-width',
    'border',
    'border-top',
    'border-right',
    'border-bottom',
    'border-left',
    'border-width',
    'border-style',
    'border-color',
    'border-collapse',
    'border-spacing'
]);

const ADMIN_LOG_STYLE_PARSE_TAGS = new Set([
    'div',
    'span',
    'p',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col'
]);

function isUnsafeCssFragment(val) {
    return /url\s*\(|expression\s*\(|javascript:|@import|-moz-binding|behavior\s*:|\\0|<|>/i.test(val);
}

/**
 * 브라우저로 style 속성을 파싱해 긴 속성만 추출 (font: 단축·따옴표 안 세미콜론 대응).
 * @param {string} styleStr
 * @param {string} [contextTag] 표/셀 등 태그에 맞게 파싱(일부 속성은 span에서만 무시됨)
 */
function sanitizeAdminLogStyle(styleStr, contextTag = 'div') {
    if (!styleStr || typeof styleStr !== 'string' || !styleStr.trim()) return '';
    if (isUnsafeCssFragment(styleStr)) return '';
    const t = String(contextTag || 'div').toLowerCase();
    const parseTag = ADMIN_LOG_STYLE_PARSE_TAGS.has(t) ? t : 'div';
    const el = document.createElement(parseTag === 'tr' ? 'div' : parseTag);
    try {
        el.setAttribute('style', styleStr);
    } catch {
        return '';
    }
    const cs = el.style;
    const out = [];

    for (const prop of ADMIN_LOG_STYLE_PROPS) {
        let val = cs.getPropertyValue(prop);
        if (!val || !String(val).trim()) continue;
        val = String(val).trim();
        if (isUnsafeCssFragment(val)) continue;

        if (prop === 'font-weight') {
            const v = val.toLowerCase().trim();
            const named = /^(normal|bold|bolder|lighter|inherit|unset|initial|100|200|300|400|500|600|700|800|900)$/.test(
                v
            );
            const numeric =
                /^\d+$/.test(v) &&
                (() => {
                    const n = parseInt(v, 10);
                    return !Number.isNaN(n) && n >= 1 && n <= 1000;
                })();
            if (!named && !numeric) continue;
        }

        if (prop === 'font-style') {
            if (!/^(normal|italic|oblique)$/i.test(val)) continue;
        }

        if (prop === 'font-size' || prop === 'line-height') {
            const ok =
                /^[\d.]+\s*(px|em|rem|pt|%)$/i.test(val) ||
                /^[\d.]+$/.test(val) ||
                /^(normal|inherit|unset)$/i.test(val) ||
                (prop === 'font-size' &&
                    /^(xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i.test(val));
            if (!ok) continue;
        }

        if (prop === 'font-family' && val.length > 220) continue;

        if (prop === 'color' || prop === 'background-color') {
            const ok =
                /^#[0-9a-f]{3,8}$/i.test(val) ||
                /^rgba?\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/i.test(val) ||
                /^(transparent|currentcolor|black|white)$/i.test(val) ||
                (/^[a-z][a-z0-9]*$/i.test(val) && val.length <= 20);
            if (!ok) continue;
        }

        if (prop === 'width' || prop === 'height' || prop === 'min-width' || prop === 'max-width') {
            const v = val.trim();
            if (
                !/^(\d+\.?\d*(px|em|rem|%|pt)|\d{1,3}%|auto|none|min-content|max-content|fit-content)$/i.test(v) &&
                !/^\d+(\.\d+)?$/.test(v)
            ) {
                continue;
            }
        }

        if (prop === 'border-collapse') {
            if (!/^(collapse|separate)$/i.test(val.trim())) continue;
        }

        if (prop === 'border-spacing') {
            if (val.length > 40) continue;
            if (!/^[\d.\spxemrem%]+$/i.test(val)) continue;
        }

        if (prop === 'padding' || /^padding-(top|right|bottom|left)$/.test(prop)) {
            if (val.length > 80) continue;
            if (!/^[\d.\spxemrem%\-]+$/i.test(val)) continue;
        }

        if (
            prop === 'border' ||
            prop.startsWith('border-top') ||
            prop.startsWith('border-right') ||
            prop.startsWith('border-bottom') ||
            prop.startsWith('border-left') ||
            prop === 'border-width' ||
            prop === 'border-style' ||
            prop === 'border-color'
        ) {
            if (val.length > 200) continue;
        }

        out.push(`${prop}: ${val}`);
    }

    return out.join('; ');
}

function isSafeAdminLogHref(href) {
    if (!href || typeof href !== 'string') return false;
    const h = href.trim();
    if (/^https?:\/\//i.test(h)) return true;
    if (/^mailto:[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)) return true;
    return false;
}

/**
 * 관리 로그 본문용 (관리자 전용 저장). 태그 구조 + 안전한 style·링크 유지.
 */
export function sanitizeAdminLogHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    const unwrap = (el) => {
        const parent = el.parentNode;
        if (!parent) return;
        const frag = document.createDocumentFragment();
        while (el.firstChild) frag.appendChild(el.firstChild);
        parent.replaceChild(frag, el);
    };

    const walk = (node) => {
        if (node.nodeType === Node.COMMENT_NODE) {
            node.parentNode?.removeChild(node);
            return;
        }
        if (node.nodeType === Node.TEXT_NODE) return;
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName?.toLowerCase();
        const childNodes = [...node.childNodes];
        childNodes.forEach(walk);

        if (ADMIN_LOG_UNWRAP_TAGS.includes(tag)) {
            unwrap(node);
            return;
        }

        if (tag === 'font') {
            const span = document.createElement('span');
            const st = [];
            const c = node.getAttribute('color');
            if (c && (/^#[0-9a-f]{3,8}$/i.test(c) || /^[a-z]+$/i.test(c))) {
                st.push(`color: ${c}`);
            }
            const face = node.getAttribute('face');
            if (face && !isUnsafeCssFragment(face) && face.length < 120) {
                const first = face.split(',')[0].trim().replace(/^["']|["']$/g, '');
                if (first) st.push(`font-family: ${first}`);
            }
            const size = node.getAttribute('size');
            if (size && /^[1-7]$/.test(size)) {
                const pxMap = { '1': '10px', '2': '13px', '3': '16px', '4': '18px', '5': '24px', '6': '32px', '7': '48px' };
                st.push(`font-size: ${pxMap[size]}`);
            }
            const merged = sanitizeAdminLogStyle(st.join('; '), 'span');
            if (merged) span.setAttribute('style', merged);
            while (node.firstChild) span.appendChild(node.firstChild);
            node.parentNode?.replaceChild(span, node);
            return;
        }

        const rawStyle = node.getAttribute('style') || '';

        if (tag === 'a') {
            const href = node.getAttribute('href') || '';
            while (node.attributes.length > 0) node.removeAttribute(node.attributes[0].name);
            if (isSafeAdminLogHref(href)) {
                node.setAttribute('href', href.trim());
                node.setAttribute('rel', 'noopener noreferrer');
                node.setAttribute('target', '_blank');
            }
            const clean = sanitizeAdminLogStyle(rawStyle, 'div');
            if (clean) node.setAttribute('style', clean);
            return;
        }

        const ADMIN_LOG_TABLE_TAGS = new Set([
            'table',
            'thead',
            'tbody',
            'tfoot',
            'tr',
            'caption',
            'colgroup',
            'col',
            'th',
            'td'
        ]);
        if (ADMIN_LOG_TABLE_TAGS.has(tag)) {
            const colspan = node.getAttribute('colspan');
            const rowspan = node.getAttribute('rowspan');
            const scope = node.getAttribute('scope');
            const colSpan = node.getAttribute('span');
            const cellpadding = node.getAttribute('cellpadding');
            const cellspacing = node.getAttribute('cellspacing');
            const borderAttr = node.getAttribute('border');

            while (node.attributes.length > 0) node.removeAttribute(node.attributes[0].name);

            if (tag === 'td' || tag === 'th') {
                if (colspan && /^\d+$/.test(colspan)) {
                    const n = parseInt(colspan, 10);
                    if (n >= 1 && n <= 500) node.setAttribute('colspan', String(n));
                }
                if (rowspan && /^\d+$/.test(rowspan)) {
                    const n = parseInt(rowspan, 10);
                    if (n >= 1 && n <= 500) node.setAttribute('rowspan', String(n));
                }
                if (tag === 'th' && scope && /^(row|col|rowgroup|colgroup)$/i.test(scope.trim())) {
                    node.setAttribute('scope', scope.trim().toLowerCase());
                }
            }
            if (tag === 'col' && colSpan && /^\d+$/.test(colSpan)) {
                const n = parseInt(colSpan, 10);
                if (n >= 1 && n <= 500) node.setAttribute('span', String(n));
            }
            if (tag === 'table') {
                const cp = cellpadding != null ? String(cellpadding).trim() : '';
                const cs = cellspacing != null ? String(cellspacing).trim() : '';
                if (cp && /^\d{1,2}$/.test(cp)) node.setAttribute('cellpadding', cp);
                if (cs && /^\d{1,2}$/.test(cs)) node.setAttribute('cellspacing', cs);
                if (borderAttr != null && /^(0|1)$/.test(String(borderAttr).trim())) {
                    node.setAttribute('border', String(borderAttr).trim());
                }
            }

            const parseTag = tag === 'tr' ? 'td' : tag;
            const cleanStyle = sanitizeAdminLogStyle(rawStyle, parseTag);
            if (cleanStyle) node.setAttribute('style', cleanStyle);
            return;
        }

        while (node.attributes.length > 0) node.removeAttribute(node.attributes[0].name);
        const cleanStyle = sanitizeAdminLogStyle(rawStyle, 'div');
        if (cleanStyle) node.setAttribute('style', cleanStyle);
    };

    walk(tmp);
    return tmp.innerHTML;
}

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
