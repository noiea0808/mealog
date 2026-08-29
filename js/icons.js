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
/** 이번 프레임에 처리할 root 들 — 취소가 아니라 누적이다 */
let _pendingRoots = new Set();

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

/**
 * 짧은 디바운스 — 렌더 직후 1회만.
 *
 * 예약된 root 를 **모아서** 처리한다. 예전엔 대기 슬롯이 하나뿐이라 나중 호출이
 * 앞 호출을 통째로 취소했다(마지막 root 만 살아남음). 서로 다른 영역이 같은
 * 프레임에 렌더되면 한쪽 아이콘이 조용히 안 그려진다 — 밀톡 라이트박스의 닫기 X 가
 * 피드 갱신에 밀려 빈 원으로 남던 원인이다.
 */
export function scheduleLucideIcons(root = document) {
  _pendingRoots.add(root && root.querySelectorAll ? root : document);
  if (_raf) cancelAnimationFrame(_raf);
  if (_timer) clearTimeout(_timer);
  _raf = requestAnimationFrame(() => {
    _raf = 0;
    _timer = setTimeout(() => {
      _timer = 0;
      const roots = _pendingRoots;
      _pendingRoots = new Set();
      /* document 가 끼어 있으면 그 한 번이 나머지를 모두 덮는다 */
      if (roots.has(document)) {
        refreshLucideIcons(document);
        return;
      }
      roots.forEach((r) => {
        /* 그 사이 떨어져 나간 노드는 건너뛴다 */
        if (r.isConnected === false) return;
        refreshLucideIcons(r);
      });
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
