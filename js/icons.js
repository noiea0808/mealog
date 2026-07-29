/**
 * Lucide SVG 아이콘 — FA 대체용 새로고침 유틸
 * 주의: 전역 MutationObserver는 탭/피드 DOM 갱신마다 createIcons를 돌려 네비를 멈추게 하므로 사용하지 않음.
 */
const LUCIDE_ATTRS = {
  'stroke-width': 1.25,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round'
};

let _raf = 0;
let _timer = 0;

/** 이미 SVG로 바뀐 아이콘은 재처리하지 않도록 data-lucide 제거 */
function markRenderedLucideSvgs(scope) {
  const root = scope?.querySelectorAll ? scope : document;
  root.querySelectorAll('svg[data-lucide]').forEach((svg) => {
    if (!svg.getAttribute('data-lucide-done')) {
      svg.setAttribute('data-lucide-done', svg.getAttribute('data-lucide') || '');
    }
    svg.removeAttribute('data-lucide');
  });
}

export function refreshLucideIcons(root = document) {
  if (typeof window.lucide?.createIcons !== 'function') return;
  const scope = root?.querySelectorAll ? root : document;
  if (!scope.querySelector('i[data-lucide]')) return;
  /* 이미 그려진 SVG에 data-lucide가 남아 있으면 createIcons가 전체 재생성 → 네비 멈춤 */
  markRenderedLucideSvgs(scope);
  const createRoot =
    scope.nodeType === 9
      ? scope.body || scope.documentElement
      : scope;
  window.lucide.createIcons({ attrs: LUCIDE_ATTRS, root: createRoot });
  markRenderedLucideSvgs(scope);
}

/** 좋아요/북마크 등 — Lucide SVG fill 토글 */
export function setLucideIconFilled(el, filled) {
  if (!el) return;
  const svg = el.tagName === 'svg' ? el : el.querySelector?.('svg');
  if (svg) {
    svg.style.fill = filled ? 'currentColor' : 'none';
  }
}

/** 짧은 디바운스 — 렌더 직후 1회만 */
export function scheduleLucideIcons(root = document) {
  if (_raf) cancelAnimationFrame(_raf);
  if (_timer) clearTimeout(_timer);
  _raf = requestAnimationFrame(() => {
    _raf = 0;
    _timer = setTimeout(() => {
      _timer = 0;
      refreshLucideIcons(root);
    }, 32);
  });
}

export function initLucideIcons() {
  refreshLucideIcons();
}

if (typeof window !== 'undefined') {
  window.refreshLucideIcons = refreshLucideIcons;
  window.scheduleLucideIcons = scheduleLucideIcons;
  window.setLucideIconFilled = setLucideIconFilled;
}
