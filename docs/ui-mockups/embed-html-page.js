/**
 * Embed a static HTML mockup into a host element (no iframe).
 * Always uses Shadow DOM so mockup CSS cannot leak into admin.
 */
(function (global) {
  const scriptCache = new Map();

  const SOFT_MINT = {
    '--green': '#3cb889',
    '--green-deep': '#2d9f74',
    '--green-soft': '#eaf8f2',
    '--green-mute': '#b4e2cd',
    '--coral': '#f2a8b4',
    '--coral-soft': '#fff0f3',
    '--danger': '#ee5f70',
    '--danger-deep': '#d9485a',
    '--shell-danger': '#ee5f70',
    '--ink': '#241f1c',
    '--ink-2': '#4f4841',
    '--muted': '#7a7268',
    '--line': '#d0c6ba',
    '--page': '#fffcfa',
    '--page-deep': '#faf6f2',
    '--page-mist': '#f8f7f5',
    '--card': '#ffffff',
    '--c1': '#3cb889',
    '--c2': '#f2a8b4',
    '--c3': '#f0c89a',
    '--c4': '#9ec4e0',
    '--c5': '#d4aee0',
    '--cta-mint-grad': 'linear-gradient(135deg, #5fd4a8 0%, #3cb889 55%, #2d9f74 100%)',
    '--cta-mint-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 8px 20px rgba(60, 184, 137, 0.36)',
    '--cta-danger-grad': 'linear-gradient(135deg, #f78a96 0%, #ee5f70 55%, #d9485a 100%)',
    '--cta-danger-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 20px rgba(238, 95, 112, 0.36)',
    '--cta-btn-h': '52px',
    '--cta-btn-r': '16px'
  };

  const THEME_KEYS = Object.keys(SOFT_MINT);

  function absUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl).href;
    } catch (_) {
      return href;
    }
  }

  function applyTokens(el, vars) {
    if (!el || !vars) return;
    Object.keys(vars).forEach((k) => {
      el.style.setProperty(k, vars[k]);
    });
  }

  /** Undo theme vars written onto <html> by themes.js (admin pollution). */
  function clearDocumentThemeLeak() {
    const root = document.documentElement;
    THEME_KEYS.forEach((k) => root.style.removeProperty(k));
    if (root.dataset) delete root.dataset.theme;
  }

  function rewriteAttrUrls(root, baseUrl, attrs) {
    root.querySelectorAll('*').forEach((el) => {
      attrs.forEach((attr) => {
        if (!el.hasAttribute(attr)) return;
        const v = el.getAttribute(attr);
        if (!v || /^(https?:|data:|mailto:|tel:|#|javascript:)/i.test(v)) return;
        el.setAttribute(attr, absUrl(v, baseUrl));
      });
    });
  }

  function adaptCss(cssText) {
    return String(cssText || '')
      .replace(/:root\b/g, ':host')
      .replace(/\bhtml\b/g, ':host')
      .replace(/\bbody\b/g, ':host');
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to load ' + url + ': ' + res.status);
    return res.text();
  }

  async function loadStyles(shadow, parsedDoc, pageUrl) {
    const jobs = [];

    parsedDoc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      // Skip font CDNs — already on admin page; avoid extra global loads
      if (/fonts\.googleapis|fonts\.gstatic|pretendard/i.test(href)) return;
      const url = absUrl(href, pageUrl);
      jobs.push(
        fetchText(url)
          .then((css) => {
            const style = document.createElement('style');
            style.setAttribute('data-href', url);
            style.textContent = adaptCss(css);
            shadow.appendChild(style);
          })
          .catch((err) => console.warn('stylesheet skip', url, err))
      );
    });

    parsedDoc.querySelectorAll('style').forEach((styleEl) => {
      const style = document.createElement('style');
      style.textContent = adaptCss(styleEl.textContent || '');
      shadow.appendChild(style);
    });

    await Promise.all(jobs);
  }

  function loadScriptOnce(src) {
    const key = absUrl(src, location.href);
    if (scriptCache.has(key)) return scriptCache.get(key);
    const p = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-ui-guide-src="' + key + '"]');
      if (existing) {
        if (existing.dataset.loaded === '1') resolve();
        else existing.addEventListener('load', () => resolve(), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = key;
      s.async = true;
      s.dataset.uiGuideSrc = key;
      s.onload = () => {
        s.dataset.loaded = '1';
        resolve();
      };
      s.onerror = () => reject(new Error('script load failed: ' + key));
      document.head.appendChild(s);
    });
    scriptCache.set(key, p);
    return p;
  }

  async function runPageScripts(parsedDoc, pageUrl, hostEl, shadow) {
    const scripts = [...parsedDoc.querySelectorAll('script')];
    for (const sc of scripts) {
      const src = sc.getAttribute('src');
      if (src) {
        const url = absUrl(src, pageUrl);
        // Never load themes.js into admin document (it mutates <html>).
        if (/themes\.js$/i.test(url)) continue;
        // lucide + local mockup interactivity (e.g. popup-shells-v2.js)
        if (/lucide/i.test(url) || /ui-mockups\/[^/?#]+\.js$/i.test(url)) {
          await loadScriptOnce(url).catch((e) => console.warn(e));
        }
        continue;
      }
    }

    if (global.lucide && typeof global.lucide.createIcons === 'function') {
      try {
        global.lucide.createIcons({ root: shadow });
      } catch (_) {
        try {
          global.lucide.createIcons({ root: hostEl });
        } catch (__) {}
      }
    }

    // Shadow DOM embeds: document.* handlers never run — init against shadow root.
    try {
      if (/popup-shells-v2\.html/i.test(pageUrl) && typeof global.initPopupShellsV2 === 'function') {
        global.initPopupShellsV2(shadow);
      }
    } catch (err) {
      console.warn('initPopupShellsV2 failed', err);
    }
  }

  function wireInternalNav(mountEl, scopeEl, pageUrl) {
    scopeEl.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || !scopeEl.contains(a)) return;
      const href = a.getAttribute('href');
      if (!href || /^(https?:|mailto:|tel:|javascript:)/i.test(href)) return;
      if (href.startsWith('#')) return;
      let next;
      try {
        next = new URL(href, pageUrl);
      } catch (_) {
        return;
      }
      if (next.origin !== location.origin) return;
      if (!/\.html($|\?)/i.test(next.pathname)) return;
      e.preventDefault();
      void embedHtmlPage(mountEl, next.href);
    });
  }

  /**
   * @param {HTMLElement} mountEl
   * @param {string} pageUrl
   */
  async function embedHtmlPage(mountEl, pageUrl) {
    if (!mountEl) throw new Error('mountEl required');
    clearDocumentThemeLeak();

    const resolved = absUrl(pageUrl, location.href);
    if (
      mountEl.dataset.uiGuideEmbedded === resolved &&
      mountEl.dataset.uiGuideEmbedMode === 'shadow' &&
      mountEl.shadowRoot &&
      mountEl.shadowRoot.childNodes.length
    ) {
      return mountEl;
    }

    const html = await fetchText(resolved);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    let phoneOnly = false;
    try {
      phoneOnly = new URL(resolved).searchParams.has('phone');
    } catch (_) {}

    // Remove any previous light-DOM leak (style tags in mount).
    mountEl.innerHTML = '';
    mountEl.classList.add('ui-guide-shadow-host');
    mountEl.classList.toggle('phone-only', phoneOnly);
    applyTokens(mountEl, SOFT_MINT);

    const shadow = mountEl.shadowRoot || mountEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = '';

    const base = document.createElement('style');
    base.textContent = `
      :host {
        display: block;
        height: auto;
        min-height: 0;
        overflow: visible;
        box-sizing: border-box;
        background: var(--page-deep, #faf6f2);
        color: var(--ink, #241f1c);
        font-family: Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      }
      /* 시안 허브 폰 프레임 — 호스트 크기에 맞춤 (100dvh 금지 → 이중 스크롤 방지) */
      :host(.ugh-phone) {
        height: 100%;
        max-height: inherit;
        overflow: hidden;
        overscroll-behavior: contain;
      }
      :host(.ugh-phone) .embed-body {
        min-height: 100%;
      }
      :host(.ugh-phone.phone-only) .embed-body {
        height: 100%;
        display: flex;
        flex-direction: column;
      }
      :host(.ugh-phone.phone-only) .stage {
        min-height: 100% !important;
        height: 100% !important;
        max-width: none !important;
        padding: 0 !important;
        align-items: stretch !important;
        justify-items: stretch !important;
        grid-template-columns: 1fr !important;
      }
      :host(.ugh-phone.phone-only) .brief { display: none !important; }
      :host(.ugh-phone.phone-only) .phone-wrap {
        position: static !important;
        width: 100% !important;
        height: 100% !important;
        min-height: 0 !important;
      }
      :host(.ugh-phone.phone-only) .phone {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
      }
      :host(.ugh-phone:not(.phone-only)) {
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }
      :host(.ugh-modal-preview) {
        height: 100%;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
        background: var(--page, #fffcfa);
      }
      :host(.ugh-modal-preview) .embed-body {
        min-height: 100%;
      }
      .ugh-wide-hint {
        display: grid;
        place-items: center;
        gap: 10px;
        height: 100%;
        padding: 32px 24px;
        text-align: center;
        color: #4f4841;
        font-size: 13px;
        line-height: 1.5;
      }
      .ugh-wide-hint strong { font-size: 16px; color: #241f1c; }
      .ugh-wide-hint button {
        margin-top: 6px;
        border: 0;
        border-radius: 16px;
        height: 44px;
        padding: 0 18px;
        background: linear-gradient(135deg, #5fd4a8 0%, #3cb889 55%, #2d9f74 100%);
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4), 0 8px 20px rgba(60, 184, 137, 0.36);
      }
      :host(.phone-only) {
        background: var(--page-deep, #faf6f2);
      }
      *, *::before, *::after { box-sizing: border-box; }
      .embed-body { margin: 0; }
    `;
    shadow.appendChild(base);

    await loadStyles(shadow, parsed, resolved);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'embed-body';
    if (phoneOnly) bodyWrap.classList.add('phone-only');
    bodyWrap.innerHTML = parsed.body.innerHTML;
    rewriteAttrUrls(bodyWrap, resolved, ['href', 'src', 'poster']);
    bodyWrap.querySelectorAll('script').forEach((s) => s.remove());
    bodyWrap.querySelectorAll('iframe').forEach((frame) => {
      const note = document.createElement('div');
      note.style.cssText =
        'display:grid;place-items:center;min-height:200px;padding:20px;text-align:center;' +
        'border:1px dashed #d0c6ba;border-radius:16px;color:#7a7268;font-size:13px;';
      note.textContent = '미리보기는 시안 허브 탭에서 열립니다.';
      frame.replaceWith(note);
    });
    // phone-only: hide brief if class was meant for body
    if (phoneOnly) {
      bodyWrap.querySelectorAll('.brief').forEach((el) => {
        el.style.display = 'none';
      });
    }
    shadow.appendChild(bodyWrap);

    await runPageScripts(parsed, resolved, mountEl, shadow);
    wireInternalNav(mountEl, bodyWrap, resolved);

    mountEl.dataset.uiGuideEmbedded = resolved;
    mountEl.dataset.uiGuideEmbedMode = 'shadow';
    clearDocumentThemeLeak();
    return mountEl;
  }

  global.embedHtmlPage = embedHtmlPage;
  global.clearUiGuideDocumentThemeLeak = clearDocumentThemeLeak;
})(typeof window !== 'undefined' ? window : globalThis);
