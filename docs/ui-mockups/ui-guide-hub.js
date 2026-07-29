/**
 * Admin UI Guide · 시안 허브 (탭 전용, 미리보기는 Shadow DOM)
 * - phone 시안: 오른쪽 폰 프레임
 * - wide 시안: 미리보기 폭 확장
 * - modal 시안(팝업 셸 등): 큰 모달로 열어 잘림 방지
 */
(function (global) {
  function resolveBase() {
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src || '';
      if (/ui-guide-hub\.js(\?|$)/i.test(src)) {
        return src.replace(/ui-guide-hub\.js(\?.*)?$/i, '');
      }
    }
    return 'docs/ui-mockups/';
  }
  const BASE = resolveBase();
  const HUB_VER = '20260725a';

  const SCREENS = [
    { href: 'mealdang-v2.html', title: '밀당', desc: '분석 · 참견', phone: true },
    { href: 'moment-feed-v2.html', title: '모먼트', desc: '공유 피드', phone: true },
    { href: 'home-feed-v2.html', title: '밀로그', desc: '홈 피드 · 기록', phone: true },
    { href: 'lounge-v2.html', title: '라운지', desc: '밀톡 · 게시판', phone: true },
    { href: 'profile-v2.html', title: '마이', desc: '프로필 · 설정', phone: true },
    { href: 'entry-sheet-v2.html', title: '기록 입력', desc: '바텀시트', phone: false, wide: true },
    {
      href: 'popup-shells-v2.html',
      title: '팝업 셸',
      desc: 'Dialog · Sheet 등 6종',
      phone: false,
      wide: true,
      modal: true
    },
    { href: 'popup-inventory.html', title: '팝업 분류', desc: '인벤토리', phone: false, wide: true },
    { href: 'screen-flow.html', title: '화면 플로우', desc: '여정 · 구성 상세', phone: false, wide: true },
    { href: 'palette-guide.html', title: '컬러 팔레트', desc: 'Soft Mint Air', phone: false, wide: true }
  ];

  function pageUrl(href, phone) {
    const u = BASE + href;
    if (!phone) return u;
    return u + (u.includes('?') ? '&' : '?') + 'phone=1';
  }

  async function ensureEmbedHelper() {
    if (typeof global.embedHtmlPage === 'function') return;
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-ui-guide-embed-helper="1"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('embed helper failed')), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.src = BASE + 'embed-html-page.js?v=' + HUB_VER;
      s.async = true;
      s.dataset.uiGuideEmbedHelper = '1';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('embed-html-page.js load failed'));
      document.head.appendChild(s);
    });
  }

  function setPreviewStatus(previewEl, html) {
    previewEl.dataset.uiGuideEmbedded = '';
    previewEl.dataset.uiGuideEmbedMode = '';
    const shadow = previewEl.shadowRoot || previewEl.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>:host{display:block;height:100%;font-family:Pretendard,sans-serif;color:#7a7268}</style>' +
      html;
  }

  async function loadPreview(previewEl, href, phone) {
    setPreviewStatus(
      previewEl,
      '<div style="display:grid;place-items:center;height:100%;padding:24px;font-size:13px">시안 불러오는 중…</div>'
    );
    try {
      await ensureEmbedHelper();
      if (typeof global.clearUiGuideDocumentThemeLeak === 'function') {
        global.clearUiGuideDocumentThemeLeak();
      }
      await global.embedHtmlPage(previewEl, pageUrl(href, phone));
    } catch (err) {
      console.error(err);
      setPreviewStatus(
        previewEl,
        '<div style="display:grid;place-items:center;height:100%;padding:24px;color:#ee5f70;font-size:13px;text-align:center">' +
          '미리보기를 불러오지 못했습니다.<br><small>' +
          String(err && err.message ? err.message : err) +
          '</small></div>'
      );
    }
  }

  function mountUiGuideHub(root) {
    if (!root) return null;
    if (root.dataset.ughMounted === '1' && root.dataset.ughVer === HUB_VER) {
      return root.__ughApi || null;
    }

    root.classList.add('ui-guide-hub');
    root.dataset.ughVer = HUB_VER;
    root.innerHTML =
      '<div class="ugh-layout">' +
        '<aside class="ugh-aside">' +
          '<p class="ugh-eyebrow">UI Guide · Design Hub</p>' +
          '<h2 class="ugh-title">시안 허브</h2>' +
          '<p class="ugh-lead">왼쪽 목록을 누르면 오른쪽 미리보기에 시안이 열립니다. 와이드 시안은 폭을 넓히거나 모달로 엽니다.</p>' +
          '<ul class="ugh-screens" data-ugh-list></ul>' +
        '</aside>' +
        '<div class="ugh-preview-col">' +
          '<div class="ugh-preview-toolbar">' +
            '<a class="ugh-open-blank" data-ugh-blank href="#" target="_blank" rel="noopener">새 창에서 열기</a>' +
          '</div>' +
          '<div class="ugh-phone" data-ugh-preview tabindex="0" aria-label="시안 미리보기"></div>' +
          '<p class="ugh-cap" data-ugh-cap>미리보기 · 하단 탭/링크는 이 영역 안에서만 이동합니다</p>' +
        '</div>' +
      '</div>' +
      '<div class="ugh-modal" data-ugh-modal hidden>' +
        '<button type="button" class="ugh-modal-backdrop" data-ugh-modal-close aria-label="닫기"></button>' +
        '<div class="ugh-modal-panel" role="dialog" aria-modal="true" aria-labelledby="ughModalTitle">' +
          '<header class="ugh-modal-head">' +
            '<h3 id="ughModalTitle" data-ugh-modal-title>시안</h3>' +
            '<div class="ugh-modal-actions">' +
              '<a class="ugh-open-blank" data-ugh-modal-blank href="#" target="_blank" rel="noopener">새 창</a>' +
              '<button type="button" class="ugh-modal-x" data-ugh-modal-close aria-label="닫기">×</button>' +
            '</div>' +
          '</header>' +
          '<div class="ugh-modal-body ugh-phone ugh-modal-preview" data-ugh-modal-preview tabindex="0"></div>' +
        '</div>' +
      '</div>';

    const list = root.querySelector('[data-ugh-list]');
    const preview = root.querySelector('[data-ugh-preview]');
    const cap = root.querySelector('[data-ugh-cap]');
    const blankLink = root.querySelector('[data-ugh-blank]');
    const modal = root.querySelector('[data-ugh-modal]');
    const modalPreview = root.querySelector('[data-ugh-modal-preview]');
    const modalTitle = root.querySelector('[data-ugh-modal-title]');
    const modalBlank = root.querySelector('[data-ugh-modal-blank]');

    function closeModal() {
      if (!modal) return;
      modal.hidden = true;
      modal.classList.remove('is-open');
      document.body.classList.remove('ugh-modal-open');
      if (modalPreview) {
        modalPreview.dataset.uiGuideEmbedded = '';
        if (modalPreview.shadowRoot) modalPreview.shadowRoot.innerHTML = '';
      }
    }

    function applyPreviewMode(item) {
      const isWide = !!item.wide && !item.phone;
      root.classList.toggle('is-wide-preview', isWide);
      root.classList.toggle('is-phone-preview', !!item.phone);
      if (blankLink) {
        blankLink.href = pageUrl(item.href, item.phone);
        blankLink.hidden = false;
      }
      if (cap) {
        if (item.modal) {
          cap.textContent = '와이드 시안 · 모달에서 전체 레이아웃을 확인합니다';
        } else if (isWide) {
          cap.textContent = '와이드 미리보기 · 폭을 넓혀 문서형 시안을 표시합니다';
        } else {
          cap.textContent = '미리보기 · 하단 탭/링크는 이 영역 안에서만 이동합니다';
        }
      }
    }

    async function openModal(item) {
      if (!modal || !modalPreview) return;
      modal.hidden = false;
      modal.classList.add('is-open');
      document.body.classList.add('ugh-modal-open');
      if (modalTitle) modalTitle.textContent = item.title;
      if (modalBlank) modalBlank.href = pageUrl(item.href, false);
      await loadPreview(modalPreview, item.href, false);
    }

    async function selectScreen(item) {
      applyPreviewMode(item);
      closeModal();
      if (item.modal) {
        // 오른쪽에는 안내만 두고, 본문은 모달에서 본다
        setPreviewStatus(
          preview,
          '<div class="ugh-wide-hint">' +
            '<strong>' + item.title + '</strong>' +
            '<p>이 시안은 폭이 넓어 모달로 열립니다.</p>' +
            '<button type="button" data-ugh-reopen-modal>모달 다시 열기</button>' +
          '</div>'
        );
        const reopen = preview.shadowRoot && preview.shadowRoot.querySelector('[data-ugh-reopen-modal]');
        if (reopen) reopen.addEventListener('click', () => void openModal(item));
        await openModal(item);
        return;
      }
      await loadPreview(preview, item.href, item.phone);
    }

    modal?.querySelectorAll('[data-ugh-modal-close]').forEach((el) => {
      el.addEventListener('click', closeModal);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && !modal.hidden) closeModal();
    });

    SCREENS.forEach((item, idx) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ugh-screen' + (idx === 0 ? ' is-active' : '');
      const badge = item.modal ? '<span class="ugh-badge">모달</span>' : item.wide ? '<span class="ugh-badge ugh-badge--wide">와이드</span>' : '';
      btn.innerHTML =
        '<span class="ugh-screen-text"><strong>' + item.title + '</strong><span>' + item.desc + '</span></span>' +
        badge +
        '<span class="ugh-go">' + (item.modal ? '모달' : '열기') + '</span>';
      btn.addEventListener('click', () => {
        list.querySelectorAll('.ugh-screen').forEach((el) => el.classList.remove('is-active'));
        btn.classList.add('is-active');
        void selectScreen(item);
      });
      li.appendChild(btn);
      list.appendChild(li);
    });

    const api = {
      reload: () => selectScreen(SCREENS[0]),
      closeModal
    };
    root.dataset.ughMounted = '1';
    root.__ughApi = api;
    void selectScreen(SCREENS[0]);
    return api;
  }

  global.mountUiGuideHub = mountUiGuideHub;
})(typeof window !== 'undefined' ? window : globalThis);
