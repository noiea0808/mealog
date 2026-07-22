/**
 * Popup inventory — mountable in admin UI Guide (no iframe)
 */
(function (global) {
  function mountPopupInventory(root, options) {
    options = options || {};
    if (!root) return null;
    if (root.dataset.piMounted === '1') return root.__piApi || null;

    const standalone = !!options.standalone;
    root.classList.add('popup-inventory');
    if (standalone) root.classList.add('popup-inventory--standalone');

    const links = standalone
      ? '<div class="links"><a href="./popup-shells-v2.html">셸 시안 6종</a><a href="./palette-guide.html">팔레트</a><a href="./index.html">시안 허브</a></div>'
      : '<div class="links"><a href="docs/ui-mockups/popup-shells-v2.html" target="_blank" rel="noopener">셸 시안 6종</a><a href="docs/ui-mockups/palette-guide.html" target="_blank" rel="noopener">팔레트</a></div>';

    root.innerHTML =
      '<div class="wrap">' +
        '<div class="top-row"><div>' +
          '<div class="eyebrow">UI Guide · Popup Inventory</div>' +
          '<h1>팝업 분류 · 미리보기</h1>' +
          '<p class="lead">항목을 누르면 이 화면 위에 해당 팝업이 바로 뜹니다. 닫기 또는 Esc.</p>' +
        '</div>' + links + '</div>' +
        '<div class="hint"><strong>미리보기</strong>는 앱 실데이터 없이 레이아웃·구성만 재현합니다. 목록 화면 위에 실제 팝업처럼 오버레이됩니다.</div>' +
        '<div data-pi-catalog></div>' +
      '</div>' +
      '<div class="preview-root" data-pi-preview aria-hidden="true"></div>';

    const catalogEl = root.querySelector('[data-pi-catalog]');
    const previewRoot = root.querySelector('[data-pi-preview]');


    const SHELL_LABEL = {
      dialog: 'Center Dialog',
      sheet: 'Bottom Sheet',
      action: 'Action Sheet',
      search: 'Search / List',
      media: 'Fullscreen Media',
      toast: 'Banner / Toast'
    };
    const SHELL_BADGE = {
      dialog: 'badge-dialog',
      sheet: 'badge-sheet',
      action: 'badge-action',
      search: 'badge-search',
      media: 'badge-media',
      toast: 'badge-toast'
    };

    function xBtn() {
      return `<button type="button" class="pv-x" data-close aria-label="닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
    }

    const PREVIEWS = {
      contentPopupModal: {
        shell: 'dialog', name: '콘텐츠/공지 팝업', dom: 'contentPopupModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div style="height:120px;background:linear-gradient(135deg,var(--green-soft),var(--green-mute));display:grid;place-items:center;color:var(--green-deep);font-weight:800;font-size:13px">이벤트 이미지</div>
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;color:var(--ink);margin-bottom:6px">7일 연속 기록 챌린지</h3>
              <p>이번 주 식사만 기록해도 배지가 열려요. 오늘 한 끼부터 가볍게 시작해 보세요.</p>
            </div>
            <div class="pv-actions">
              <button type="button" class="pv-btn pv-btn-primary">자세히 보기</button>
              <button type="button" class="pv-btn pv-btn-ghost" data-close>오늘 하루 보지 않기</button>
            </div>
          </div>
        </div>`
      },
      entrySlotPickerModal: {
        shell: 'dialog', name: '기록 추가 (슬롯)', dom: 'entrySlotPickerModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>기록 추가</h3><p>3월 12일 (목)</p></div>${xBtn()}</div>
            <div class="pv-body">
              <p style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:.04em;margin:4px 0 6px">식사</p>
              <div class="pv-list-row pref"><div class="pv-ico">☀️</div><div><strong>아침</strong><span style="color:var(--green)">아직 없음</span></div></div>
              <div class="pv-list-row"><div class="pv-ico">🍽️</div><div><strong>점심</strong><span>1건 · 추가 가능</span></div></div>
              <div class="pv-list-row"><div class="pv-ico">🌙</div><div><strong>저녁</strong><span>아직 없음</span></div></div>
              <p style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:.04em;margin:12px 0 6px">간식</p>
              <div class="pv-list-row"><div class="pv-ico">☕</div><div><strong>오전 간식</strong><span>아직 없음</span></div></div>
              <p style="font-size:11px;font-weight:800;color:#94a3b8;letter-spacing:.04em;margin:12px 0 6px">하루</p>
              <div class="pv-list-row"><div class="pv-ico">📖</div><div><strong>하루 기록</strong><span>아직 없음</span></div></div>
            </div>
          </div>
        </div>`
      },
      entryModal: {
        shell: 'dialog', name: '식사/간식 기록', dom: 'entryModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--md" style="max-height:min(88vh,34rem)">
            <div class="pv-entry-head">
              <span class="pill">3/12</span>
              <span class="pill">점심 ▾</span>
              <div class="mode"><span class="on">식사</span><span>간식</span></div>
              ${xBtn()}
            </div>
            <div class="pv-body">
              <div class="pv-field">📷 음식 사진 · 0/5</div>
              <div class="pv-field">무엇을 · 메뉴 입력</div>
              <div class="pv-field">어디서 · 장소 검색</div>
              <div class="pv-field">★★★★☆ 만족도</div>
              <div class="pv-field">메모</div>
            </div>
            <div class="pv-actions" style="padding:0">
              <button type="button" class="pv-btn pv-btn-ink" style="border-radius:0">기록 완료</button>
            </div>
          </div>
        </div>`
      },
      logoutConfirmModal: {
        shell: 'dialog', name: '로그아웃 확인', dom: 'logoutConfirmModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--sm">
            <div class="pv-head" style="border:0;padding-bottom:0"><div><h3>로그아웃 하시겠어요?</h3><p>기록은 안전하게 저장됩니다.</p></div></div>
            <div class="pv-split">
              <button type="button" data-close><span class="lab">취소</span><span class="sub">이전 화면으로</span></button>
              <button type="button" class="rose" data-close><span class="lab">로그아웃</span><span class="sub">로그인 화면으로</span></button>
            </div>
          </div>
        </div>`
      },
      deleteAccountConfirmModal: {
        shell: 'dialog', name: '계정 삭제 확인', dom: 'deleteAccountConfirmModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;color:var(--ink);margin-bottom:6px">계정을 탈퇴하시겠어요?</h3>
              <p>탈퇴 시 모든 기록과 데이터가 영구적으로 삭제되며 복구할 수 없습니다.</p>
            </div>
            <div class="pv-actions row">
              <button type="button" class="pv-btn pv-btn-ghost" data-close style="flex:1">취소</button>
              <button type="button" class="pv-btn pv-btn-danger" data-close style="flex:1">탈퇴하기</button>
            </div>
          </div>
        </div>`
      },
      emailAuthModal: {
        shell: 'dialog', name: '이메일 인증', dom: 'emailAuthModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>이메일 인증</h3><p>인증 코드를 입력해 주세요.</p></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">email@example.com</div>
              <div class="pv-field">인증 코드 6자리</div>
            </div>
            <div class="pv-actions">
              <button type="button" class="pv-btn pv-btn-primary" data-close>확인</button>
            </div>
          </div>
        </div>`
      },
      passwordResetConfirmModal: {
        shell: 'dialog', name: '비밀번호 재설정 확인', dom: 'passwordResetConfirmModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;margin-bottom:6px">비밀번호 재설정</h3>
              <p>입력한 이메일로 재설정 링크를 보낼까요?</p>
            </div>
            <div class="pv-actions row">
              <button type="button" class="pv-btn pv-btn-ghost" data-close style="flex:1">취소</button>
              <button type="button" class="pv-btn pv-btn-primary" data-close style="flex:1">보내기</button>
            </div>
          </div>
        </div>`
      },
      passwordResetSuccessModal: {
        shell: 'dialog', name: '비밀번호 재설정 완료', dom: 'passwordResetSuccessModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;margin-bottom:6px">메일을 보냈어요</h3>
              <p>받은편지함에서 재설정 링크를 확인해 주세요.</p>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>확인</button></div>
          </div>
        </div>`
      },
      termsModal: {
        shell: 'dialog', name: '약관', dom: 'termsModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog" style="max-height:min(80vh,32rem)">
            <div class="pv-head"><div><h3>이용약관</h3></div>${xBtn()}</div>
            <div class="pv-body" style="font-size:13px">
              <p style="margin-bottom:10px">제1조 (목적) 본 약관은 mealog 서비스 이용과 관련하여…</p>
              <p style="margin-bottom:10px">제2조 (정의) “회원”이란 본 약관에 동의하고 서비스를 이용하는 자를 말합니다.</p>
              <p>제3조 (약관의 효력) …</p>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>동의하고 계속</button></div>
          </div>
        </div>`
      },
      profileSetupModal: {
        shell: 'dialog', name: '프로필 초기 설정', dom: 'profileSetupModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>프로필 설정</h3><p>시작하기 전에 닉네임을 정해 주세요.</p></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">닉네임</div>
              <div class="pv-field">한 줄 소개 (선택)</div>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>시작하기</button></div>
          </div>
        </div>`
      },
      domainErrorModal: {
        shell: 'dialog', name: '도메인 오류', dom: 'domainErrorModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;margin-bottom:6px">접속할 수 없어요</h3>
              <p>허용되지 않은 도메인입니다. 공식 주소로 다시 접속해 주세요.</p>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>확인</button></div>
          </div>
        </div>`
      },
      demoIntroModal: {
        shell: 'dialog', name: '데모 인트로', dom: 'demoIntroModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;margin-bottom:6px">데모 모드로 둘러보기</h3>
              <p>샘플 기록으로 mealog 화면을 미리 체험할 수 있어요.</p>
            </div>
            <div class="pv-actions">
              <button type="button" class="pv-btn pv-btn-primary" data-close>데모 시작</button>
              <button type="button" class="pv-btn pv-btn-ghost" data-close>로그인하기</button>
            </div>
          </div>
        </div>`
      },
      pwaInstallGuideModal: {
        shell: 'dialog', name: 'PWA 설치 안내', dom: 'pwaInstallGuideModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>홈 화면에 추가</h3><p>앱처럼 빠르게 실행할 수 있어요.</p></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">1. 공유 버튼 탭</div>
              <div class="pv-field">2. “홈 화면에 추가” 선택</div>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>알겠어요</button></div>
          </div>
        </div>`
      },
      desktopShortcutGuideModal: {
        shell: 'dialog', name: '바로가기 안내', dom: 'desktopShortcutGuideModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>바탕화면 바로가기</h3></div>${xBtn()}</div>
            <div class="pv-body"><p>브라우저 메뉴에서 “앱 설치” 또는 바로가기를 만들어 주세요.</p></div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>확인</button></div>
          </div>
        </div>`
      },
      characterSelectPopup: {
        shell: 'dialog', name: '밀당 캐릭터 선택', dom: 'characterSelectPopup',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>캐릭터 선택</h3><p>밀당 참견 목소리를 골라 주세요.</p></div>${xBtn()}</div>
            <div class="pv-body" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div class="pv-field" style="text-align:center;margin:0;padding:16px 8px">🙂 기본</div>
              <div class="pv-field" style="text-align:center;margin:0;padding:16px 8px;background:var(--green-soft);border-color:var(--green-mute)">🌿 선택됨</div>
              <div class="pv-field" style="text-align:center;margin:0;padding:16px 8px">🔥 열정</div>
              <div class="pv-field" style="text-align:center;margin:0;padding:16px 8px">🧊 쿨</div>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>적용</button></div>
          </div>
        </div>`
      },
      dietReportModal: {
        shell: 'dialog', name: '식단 리포트', dom: 'dietReportModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--md">
            <div class="pv-head"><div><h3>식단 리포트</h3><p>이번 주 요약</p></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-share-card">
                <div class="big">mealog</div>
                <div class="stat">12끼</div>
                <div style="font-size:12px;color:var(--muted)">기록 · 평균 ★ 4.2</div>
              </div>
              <p style="margin-top:12px;font-size:13px">점심 기록이 가장 많고, 저녁 만족도가 높았어요.</p>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>닫기</button></div>
          </div>
        </div>`
      },
      detailModal: {
        shell: 'dialog', name: '상세 통계', dom: 'detailModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--md">
            <div class="pv-head"><div><h3>상세 통계</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div style="height:120px;border-radius:12px;background:linear-gradient(180deg,var(--green-soft),var(--page));border:1px solid var(--line);margin-bottom:10px;display:grid;place-items:center;color:var(--green-deep);font-weight:700;font-size:13px">차트 영역</div>
              <div class="pv-field">아침 3 · 점심 5 · 저녁 4</div>
            </div>
          </div>
        </div>`
      },
      bestShareModal: {
        shell: 'dialog', name: '베스트 공유', dom: 'bestShareModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>베스트 공유</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-share-card">
                <div class="big">mealog best</div>
                <div class="stat">★ 4.8</div>
                <div style="font-size:12px;color:var(--muted)">이번 달 최고 만족 식사</div>
              </div>
            </div>
            <div class="pv-actions">
              <button type="button" class="pv-btn pv-btn-primary">이미지 저장</button>
              <button type="button" class="pv-btn pv-btn-ghost" data-close>닫기</button>
            </div>
          </div>
        </div>`
      },
      insightShareModal: {
        shell: 'dialog', name: '인사이트 공유', dom: 'insightShareModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>인사이트 공유</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-share-card">
                <div class="big">밀당 인사이트</div>
                <p style="margin-top:8px;font-size:13px;color:var(--ink-2)">이번 주는 점심 기록이 안정적이에요.</p>
              </div>
            </div>
            <div class="pv-actions">
              <button type="button" class="pv-btn pv-btn-primary">공유하기</button>
              <button type="button" class="pv-btn pv-btn-ghost" data-close>닫기</button>
            </div>
          </div>
        </div>`
      },
      bestSharePeriodNoticeModal: {
        shell: 'dialog', name: '공유 기간 안내', dom: 'bestSharePeriodNoticeModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-body">
              <h3 style="font-size:17px;font-weight:800;margin-bottom:6px">기간을 확인해 주세요</h3>
              <p>베스트 공유는 선택한 기간의 기록만 포함됩니다.</p>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>확인</button></div>
          </div>
        </div>`
      },
      successPopup: {
        shell: 'dialog', name: '기록 완료', dom: 'successPopup',
        html: () => `<div class="pv-overlay pv-overlay--center" style="background:rgba(15,23,42,0.25)">
          <div class="pv-celebrate">
            <div class="circle">✓</div>
            <div class="msg">기록 완료!</div>
            <button type="button" class="pv-btn pv-btn-ghost" data-close style="margin-top:8px">닫기</button>
          </div>
        </div>`
      },
      attendancePopup: {
        shell: 'dialog', name: '출석/연속 기록', dom: 'attendancePopup',
        html: () => `<div class="pv-overlay pv-overlay--center" style="background:rgba(15,23,42,0.25)">
          <div class="pv-celebrate">
            <div class="circle" style="color:#dc2626;font-size:36px">♥</div>
            <div class="msg">3일 연속!</div>
            <p style="font-size:13px;opacity:.9">오늘도 잘 기록했어요</p>
            <button type="button" class="pv-btn pv-btn-ghost" data-close style="margin-top:8px">닫기</button>
          </div>
        </div>`
      },

      dailyJournalModal: {
        shell: 'sheet', name: '하루 기록', dom: 'dailyJournalModal',
        html: () => `<div class="pv-overlay pv-overlay--end">
          <div class="pv-sheet">
            <div class="pv-grab"></div>
            <div class="pv-head"><div><h3>하루 기록</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">📷 사진 · 0/5</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div class="pv-field" style="margin:0">체중 kg</div>
                <div class="pv-field" style="margin:0">컨디션</div>
              </div>
              <div class="pv-field" style="margin-top:8px">메모</div>
            </div>
            <div class="pv-actions" style="padding:0"><button type="button" class="pv-btn pv-btn-ink" style="border-radius:0" data-close>저장</button></div>
          </div>
        </div>`
      },
      profileFieldEditModal: {
        shell: 'sheet', name: '프로필 필드 편집', dom: 'profileFieldEditModal',
        html: () => `<div class="pv-overlay pv-overlay--end">
          <div class="pv-sheet">
            <div class="pv-head"><div><h3>닉네임 수정</h3></div>${xBtn()}</div>
            <div class="pv-body"><div class="pv-field" style="color:var(--ink)">밀로그러</div></div>
            <div class="pv-actions row" style="padding:0;border-top:1px solid var(--line)">
              <button type="button" class="pv-btn pv-btn-ghost" data-close style="flex:1;border-radius:0">취소</button>
              <button type="button" class="pv-btn pv-btn-primary" data-close style="flex:1;border-radius:0">저장</button>
            </div>
          </div>
        </div>`
      },
      accountAvatarModal: {
        shell: 'sheet', name: '프로필 사진', dom: 'accountAvatarModal',
        html: () => `<div class="pv-overlay pv-overlay--end">
          <div class="pv-sheet">
            <div class="pv-head" style="border:0;justify-content:flex-end;padding-bottom:0">${xBtn()}</div>
            <div class="pv-body" style="padding-top:0">
              <div class="pv-avatar">👤</div>
            </div>
            <div class="pv-actions" style="padding:0"><button type="button" class="pv-btn pv-btn-primary" style="border-radius:0">사진 변경</button></div>
          </div>
        </div>`
      },
      photoEditModal: {
        shell: 'sheet', name: '사진 편집', dom: 'photoEditModal',
        html: () => `<div class="pv-overlay pv-overlay--end">
          <div class="pv-sheet">
            <div class="pv-head"><div><h3>사진 편집</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div style="aspect-ratio:1;border-radius:16px;background:linear-gradient(135deg,#cbd5e1,#94a3b8);margin-bottom:10px"></div>
              <div class="pv-chip-row">
                <span class="pv-chip">축소</span><span class="pv-chip">확대</span><span class="pv-chip">회전</span>
              </div>
            </div>
            <div class="pv-actions row" style="padding:0;border-top:1px solid var(--line)">
              <button type="button" class="pv-btn pv-btn-ghost" data-close style="flex:1;border-radius:0">취소</button>
              <button type="button" class="pv-btn pv-btn-primary" data-close style="flex:1;border-radius:0">편집적용</button>
            </div>
          </div>
        </div>`
      },
      characterSelectModal: {
        shell: 'sheet', name: '캐릭터 선택(시트)', dom: 'characterSelectModal',
        html: () => `<div class="pv-overlay pv-overlay--end">
          <div class="pv-sheet">
            <div class="pv-grab"></div>
            <div class="pv-head"><div><h3>캐릭터</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-list-row pref"><div class="pv-ico">🌿</div><div><strong>기본</strong><span>선택됨</span></div></div>
              <div class="pv-list-row"><div class="pv-ico">🔥</div><div><strong>열정</strong><span>참견 톤</span></div></div>
              <div class="pv-list-row"><div class="pv-ico">🧊</div><div><strong>쿨</strong><span>참견 톤</span></div></div>
            </div>
          </div>
        </div>`
      },

      feedOptionsMenu: {
        shell: 'action', name: '피드 옵션', dom: 'feedOptionsMenu (JS)',
        html: () => `<div class="pv-overlay" style="background:var(--shell-dim)">
          <div class="pv-action-wrap">
            <div class="pv-action-card">
              <button type="button">수정</button>
              <button type="button">외부 공유</button>
              <button type="button" class="danger">삭제</button>
              <button type="button" class="danger">신고</button>
            </div>
            <button type="button" class="pv-action-cancel" data-close>취소</button>
          </div>
        </div>`
      },
      boardPostOptionsMenu: {
        shell: 'action', name: '게시판 옵션', dom: 'boardPostOptionsMenu (JS)',
        html: () => `<div class="pv-overlay" style="background:var(--shell-dim)">
          <div class="pv-action-wrap">
            <div class="pv-action-card">
              <button type="button">수정</button>
              <button type="button" class="danger">삭제</button>
              <button type="button" class="danger">신고</button>
            </div>
            <button type="button" class="pv-action-cancel" data-close>취소</button>
          </div>
        </div>`
      },
      reportModal: {
        shell: 'action', name: '신고', dom: 'reportModal (JS)',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--sm">
            <div class="pv-head"><div><h3>신고하기</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-list-row"><div><strong>스팸</strong></div></div>
              <div class="pv-list-row"><div><strong>욕설/혐오</strong></div></div>
              <div class="pv-list-row"><div><strong>기타</strong></div></div>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-danger" data-close>제출</button></div>
          </div>
        </div>`
      },
      feedBubbleActionSheet: {
        shell: 'action', name: '밀톡 버블 메뉴', dom: 'feedBubbleActionSheet',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog" style="width:min(92vw,14rem)">
            <div class="pv-action-card" style="border:0;border-radius:0">
              <button type="button">복사</button>
              <button type="button" class="danger">삭제</button>
            </div>
            <div style="padding:8px"><button type="button" class="pv-action-cancel" data-close style="width:100%">닫기</button></div>
          </div>
        </div>`
      },
      timeSourcePicker: {
        shell: 'action', name: '시간/출처 피커', dom: 'time-source-picker (JS)',
        html: () => `<div class="pv-overlay" style="background:var(--shell-dim)">
          <div class="pv-action-wrap">
            <div class="pv-action-card">
              <button type="button">지금</button>
              <button type="button">사진 촬영 시각</button>
              <button type="button">직접 입력</button>
            </div>
            <button type="button" class="pv-action-cancel" data-close>취소</button>
          </div>
        </div>`
      },

      timelineSearchModal: {
        shell: 'search', name: '밀로그 검색', dom: 'timelineSearchModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>기록 검색</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <p style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:8px">검색 기간</p>
              <div class="pv-chip-row">
                <span class="pv-chip on">최근 1주</span><span class="pv-chip">2주</span><span class="pv-chip">한 달</span><span class="pv-chip">직접 입력</span>
              </div>
              <div class="pv-field">키워드 · 메뉴/장소/메모</div>
            </div>
            <div class="pv-actions"><button type="button" class="pv-btn pv-btn-primary" data-close>검색</button></div>
          </div>
        </div>`
      },
      momentSearchModal: {
        shell: 'search', name: '모먼트 검색', dom: 'momentSearchModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>모먼트 검색</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">검색어</div>
              <div class="pv-list-row"><div><strong>김치찌개</strong><span>3월 10일 · 점심</span></div></div>
              <div class="pv-list-row"><div><strong>카페 라떼</strong><span>3월 9일 · 간식</span></div></div>
            </div>
          </div>
        </div>`
      },
      boardSearchModal: {
        shell: 'search', name: '라운지 검색', dom: 'boardSearchModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>라운지 검색</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-field">게시글 · 작성자</div>
              <div class="pv-list-row"><div><strong>#먹는</strong><span>게시판 결과</span></div></div>
            </div>
          </div>
        </div>`
      },
      notificationModal: {
        shell: 'search', name: '알림', dom: 'notificationModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog" style="max-height:min(85vh,36rem)">
            <div class="pv-head">
              <div><h3>알림</h3></div>
              <div style="display:flex;align-items:center;gap:4px">
                <button type="button" style="border:0;background:transparent;color:var(--green);font:inherit;font-size:12px;font-weight:600;cursor:pointer">모두 읽음</button>
                ${xBtn()}
              </div>
            </div>
            <div class="pv-body" style="padding-top:10px">
              <div class="pv-chip-row"><span class="pv-chip on">새 알림</span><span class="pv-chip">읽은 알림</span></div>
              <div class="pv-list-row"><div><strong>좋아요</strong><span>회원님이 회원님의 기록을 좋아합니다</span></div></div>
              <div class="pv-list-row"><div><strong>댓글</strong><span>새 댓글이 달렸습니다</span></div></div>
            </div>
            <div class="pv-actions" style="padding:0"><button type="button" class="pv-btn pv-btn-ghost" style="border-radius:0" data-close>닫기</button></div>
          </div>
        </div>`
      },
      trackerMonthCalendarModal: {
        shell: 'search', name: '월 캘린더', dom: 'trackerMonthCalendarModal',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog">
            <div class="pv-head"><div><h3>2026년 3월</h3></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-cal">
                <div class="dow">일</div><div class="dow">월</div><div class="dow">화</div><div class="dow">수</div><div class="dow">목</div><div class="dow">금</div><div class="dow">토</div>
                <div class="d"></div><div class="d"></div><div class="d"></div><div class="d"></div><div class="d"></div><div class="d"></div><div class="d">1</div>
                <div class="d">2</div><div class="d">3</div><div class="d">4</div><div class="d">5</div><div class="d">6</div><div class="d">7</div><div class="d">8</div>
                <div class="d">9</div><div class="d">10</div><div class="d">11</div><div class="d on">12</div><div class="d">13</div><div class="d">14</div><div class="d">15</div>
              </div>
            </div>
          </div>
        </div>`
      },
      entryHeaderDatePicker: {
        shell: 'search', name: '기록 내 날짜 피커', dom: 'entryHeaderDatePicker',
        html: () => `<div class="pv-overlay pv-overlay--center">
          <div class="pv-dialog pv-dialog--sm">
            <div class="pv-head"><div><h3>날짜 선택</h3><p>entryModal 내부</p></div>${xBtn()}</div>
            <div class="pv-body">
              <div class="pv-cal">
                <div class="dow">일</div><div class="dow">월</div><div class="dow">화</div><div class="dow">수</div><div class="dow">목</div><div class="dow">금</div><div class="dow">토</div>
                <div class="d">9</div><div class="d">10</div><div class="d">11</div><div class="d on">12</div><div class="d">13</div><div class="d">14</div><div class="d">15</div>
              </div>
            </div>
          </div>
        </div>`
      },

      timelineMealPhotos: {
        shell: 'media', name: '식사 사진 휠/라이트박스', dom: 'timeline meal photos overlay',
        html: () => `<div class="pv-overlay pv-overlay--media">
          <button type="button" class="pv-x" data-close style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.15);color:#fff" aria-label="닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
          <div class="pv-media-frame"><div class="ph"></div><div class="cap">점심 · 김치찌개</div></div>
        </div>`
      },
      momentImageLightbox: {
        shell: 'media', name: '모먼트 이미지 라이트박스', dom: 'moment-image-lightbox',
        html: () => `<div class="pv-overlay pv-overlay--media">
          <button type="button" class="pv-x" data-close style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.15);color:#fff" aria-label="닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
          <div class="pv-media-frame" style="aspect-ratio:3/4"><div class="ph" style="background:linear-gradient(160deg,#f2a8b4,#3cb889)"></div><div class="cap">모먼트</div></div>
        </div>`
      },

      toastContainer: {
        shell: 'toast', name: '토스트', dom: 'toastContainer',
        html: () => `<div class="pv-overlay" style="background:transparent;pointer-events:none">
          <div class="pv-toast" style="pointer-events:auto">저장했어요</div>
          <button type="button" class="pv-btn pv-btn-ghost" data-close style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);pointer-events:auto">미리보기 닫기</button>
        </div>`
      }
    };

    const ORDER = [
      'dialog', 'sheet', 'action', 'search', 'media', 'toast'
    ];

    function buildCatalog() {
      const byShell = {};
      Object.keys(PREVIEWS).forEach((id) => {
        const p = PREVIEWS[id];
        (byShell[p.shell] || (byShell[p.shell] = [])).push({ id, ...p });
      });
      const root = catalogEl;
      root.innerHTML = ORDER.map((shell) => {
        const items = byShell[shell] || [];
        if (!items.length) return '';
        return `<section class="group">
          <div class="group-title"><span class="badge ${SHELL_BADGE[shell]}">${SHELL_LABEL[shell]}</span><span>${items.length}</span></div>
          <div class="list">
            ${items.map((it) => `<button type="button" class="item" data-open="${it.id}">
              <span><span class="name">${it.name}</span><div class="meta">${it.dom}</div></span>
              <span class="go">미리보기</span>
            </button>`).join('')}
          </div>
        </section>`;
      }).join('');
    }

    // previewRoot bound in mountPopupInventory

    function closePreview() {
      previewRoot.classList.remove('open');
      previewRoot.setAttribute('aria-hidden', 'true');
      previewRoot.innerHTML = '';
      document.body.style.overflow = '';
    }

    function openPreview(id) {
      const p = PREVIEWS[id];
      if (!p) return;
      previewRoot.innerHTML = p.html();
      /* icons: Font Awesome */
      // FA icons already available in admin; lucide optional for standalone
      previewRoot.classList.add('open');
      previewRoot.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    }

    catalogEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open]');
      if (!btn) return;
      openPreview(btn.getAttribute('data-open'));
    });
    previewRoot.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        closePreview();
        return;
      }
      /* 딤 영역 클릭 시 닫기 (패널 내부 클릭은 유지) */
      const overlay = e.target.closest('.pv-overlay');
      if (overlay && e.target === overlay) closePreview();
    });
    

    

    buildCatalog();

    const onKey = function (e) {
      if (e.key === 'Escape' && previewRoot.classList.contains('open')) closePreview();
    };
    document.addEventListener('keydown', onKey);

    const api = {
      open: openPreview,
      close: closePreview,
      destroy: function () {
        document.removeEventListener('keydown', onKey);
        closePreview();
        root.dataset.piMounted = '';
        root.__piApi = null;
        root.innerHTML = '';
      }
    };
    root.dataset.piMounted = '1';
    root.__piApi = api;
    return api;
  }

  global.mountPopupInventory = mountPopupInventory;
})(typeof window !== 'undefined' ? window : globalThis);
