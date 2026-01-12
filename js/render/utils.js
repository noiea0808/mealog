// 렌더링 공통 유틸리티 함수

// HTML 이스케이프 함수 (XSS 방지)
export function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
