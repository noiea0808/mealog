/**
 * popup-shells-v2 interactive init
 * Works in standalone document OR Shadow DOM (root = shadowRoot / Document).
 */
(function (global) {
  var SPECS = {
    dialog: {
      title: 'Center Dialog · Mint Glow 채택',
      cap: 'C Mint Glow — 시안·앱 공통 CTA',
      items: [
        '채택: 135° mint 그라데이션 (#5FD4A8→#3CB889→#2D9F74)',
        'h52 · radius 16 · inset highlight · soft mint shadow',
        'danger도 동일 언어의 코랄 그라데이션',
        '앱: .mealog-btn-primary / entry 저장 / 공지 닫기 CTA',
        'A Soft Lift · B Bigger는 비교용 잔여'
      ]
    },
    sheet: {
      title: 'Bottom Sheet',
      cap: 'Bottom Sheet · 입력 / 피커',
      items: [
        '상단 radius 24 · grabber 40×4 (line 색)',
        '헤더는 흰 면 + 헤어라인 · 본문은 page(#fffcf9)',
        '칩(끼니)만 green-soft · 필드 박스는 흰 카드',
        '하단 sticky CTA 1개 · safe-area 패딩',
        'entry-sheet-v2와 동일 골격으로 모든 입력 시트 맞춤'
      ]
    },
    action: {
      title: 'Action Sheet',
      cap: 'Action Sheet · 옵션 메뉴',
      items: [
        '좌우·하단 12~16 inset · 카드 radius 18',
        '액션은 아이콘(muted) + ink 라벨',
        '위험 액션만 Danger(#EE5F70) · press는 --danger-deep',
        '취소는 별도 카드로 분리 (iOS 회색 뭉치 지양)',
        '점3개·롱프레스·신고 진입 모두 이 셸'
      ]
    },
    search: {
      title: 'Search / List',
      cap: 'Search / List · 검색 / 알림',
      items: [
        '풀스크린 page 배경 (모달 카드 중첩 금지)',
        '검색창: green-soft 면 + green-mute 보더',
        '리스트는 카드 없이 헤어라인 row',
        '썸네일 12 radius · 메타는 ink / muted',
        '알림·캘린더도 동일 헤더·리스트 리듬'
      ]
    },
    media: {
      title: 'Fullscreen Media',
      cap: 'Fullscreen Media · 라이트박스',
      items: [
        '배경 ink(#1c1917) · UI는 흰/반투명만',
        '닫기: 원형 glass 버튼 (우상단)',
        '사진은 살짝 radius 12 (화면 가장자리와 숨 쉬게)',
        '도트 활성만 초록 · 캡션은 하단 ink 위 흰 텍스트',
        '모먼트/피드/식사 휠 뷰어 동일 셸'
      ]
    },
    system: {
      title: 'Banner / Toast',
      cap: 'Banner / Toast · 시스템 피드백',
      items: [
        '배너: 흰 카드 + 좌측 초록 3px 악센트',
        '보조 CTA는 green-soft pill (면적 초록 금지)',
        '토스트: ink 필 + 짧은 문구 · 하단 nav 위',
        '전면 로딩은 별도(기존 loading) · 토스트로 대체 가능한 건 대체',
        '체류 짧게 · 스크롤/입력 방해 최소화'
      ]
    }
  };

  function qsa(root, sel) {
    return Array.prototype.slice.call(root.querySelectorAll(sel));
  }

  function refreshIcons(root) {
    if (!global.lucide || typeof global.lucide.createIcons !== 'function') return;
    try {
      global.lucide.createIcons({ root: root });
    } catch (_) {}
  }

  function initPopupShellsV2(root) {
    if (!root) root = document;
    var scope = root.querySelector ? root : document;
    // Prefer .embed-body when inside shadow
    var body = scope.querySelector && scope.querySelector('.embed-body');
    var ctx = body || scope;

    var shellNav = ctx.querySelector('#shellNav');
    var footerTabs = ctx.querySelector('#footerTabs');
    var specTitle = ctx.querySelector('#specTitle');
    var capText = ctx.querySelector('#capText');
    var specList = ctx.querySelector('#specList');

    function setShell(id) {
      qsa(ctx, '.shell-nav button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-shell') === id);
      });
      qsa(ctx, '.overlay').forEach(function (o) {
        o.classList.toggle('active', o.getAttribute('data-panel') === id);
      });
      var spec = SPECS[id];
      if (!spec) return;
      if (specTitle) specTitle.textContent = spec.title;
      if (capText) capText.textContent = spec.cap;
      if (specList) {
        specList.innerHTML = '';
        spec.items.forEach(function (t) {
          var li = document.createElement('li');
          li.textContent = t;
          specList.appendChild(li);
        });
      }
      refreshIcons(ctx);
    }

    function setDialogFooter(id) {
      qsa(ctx, '.dialog-footer-variant').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-footer') === id);
      });
      qsa(ctx, '#footerTabs [data-footer-tab]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-footer-tab') === id);
      });
      refreshIcons(ctx);
    }

    if (shellNav && !shellNav.dataset.shellsWired) {
      shellNav.dataset.shellsWired = '1';
      shellNav.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-shell]');
        if (!btn || !shellNav.contains(btn)) return;
        setShell(btn.getAttribute('data-shell'));
      });
    }

    if (footerTabs && !footerTabs.dataset.shellsWired) {
      footerTabs.dataset.shellsWired = '1';
      footerTabs.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-footer-tab]');
        if (!btn || !footerTabs.contains(btn)) return;
        e.preventDefault();
        setDialogFooter(btn.getAttribute('data-footer-tab'));
      });
    }

    setShell('dialog');
    setDialogFooter('glow');
    return { setShell: setShell, setDialogFooter: setDialogFooter };
  }

  global.initPopupShellsV2 = initPopupShellsV2;

  // Standalone page auto-init
  if (typeof document !== 'undefined' && document.getElementById('footerTabs')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        initPopupShellsV2(document);
      });
    } else {
      initPopupShellsV2(document);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
