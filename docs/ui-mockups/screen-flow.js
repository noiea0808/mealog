/**
 * Screen flow — mountable in admin UI Guide (no iframe)
 * Interactive flowchart of mealog screens + composition detail on select
 */
(function (global) {
  const KIND_LABEL = {
    entry: '진입',
    auth: '인증',
    main: '메인 탭',
    sub: '인앱 뷰',
    record: '기록',
    overlay: '오버레이',
    media: '미디어',
    celebrate: '축하/웰컴',
    system: '시스템',
    shell: '셸 유형'
  };

  /** @type {{ id: string, lane: string, kind: string, name: string, sub?: string, dom: string, purpose: string, from?: string, to?: string, parts: string[], wire: { label: string, tone?: string }[], mockup?: string, note?: string }[]} */
  const SCREENS = [
    // —— 1. 진입 ——
    {
      id: 'boot',
      lane: 'entry',
      kind: 'entry',
      name: '부트 스플래시',
      sub: '앱 기동',
      dom: '#bootSplashOverlay',
      purpose: '네이티브/웹 기동 직후 아이콘만 보여주는 브릿지 화면.',
      from: '앱 프로세스 시작',
      to: '랜딩 또는 메인(세션 복구)',
      parts: ['전체 오버레이', '아이콘 래퍼', '동기 로고 이미지'],
      wire: [
        { label: '풀뷰포트 딤/배경', tone: 'dim' },
        { label: '아이콘', tone: 'hero' }
      ]
    },
    {
      id: 'landing',
      lane: 'entry',
      kind: 'entry',
      name: '랜딩',
      sub: '비로그인 홈',
      dom: '#landingPage',
      purpose: '스플래시 타이틀 → 로그인 옵션(카카오·구글·애플·이메일·게스트).',
      from: '부트 / 로그아웃',
      to: '인증 모달 · 메인 앱',
      parts: ['세이프에리어 패딩', '아이콘/타이틀 스플래시', '로그인 버튼 스택', '하단 고정 영역', '배너(선택)'],
      wire: [
        { label: '브랜드 아이콘', tone: 'hero' },
        { label: '타이틀 · 태그라인' },
        { label: '소셜/이메일 로그인', tone: 'accent' },
        { label: '게스트 · 약관', tone: 'dim' }
      ],
      mockup: null
    },
    {
      id: 'signupWizard',
      lane: 'entry',
      kind: 'auth',
      name: '가입 마법사',
      sub: '풀페이지 플로우',
      dom: '#signupWizard',
      purpose: '다단계 가입(약관·프로필 등) 전체 화면 전환.',
      from: '랜딩 가입',
      to: '메인 앱',
      parts: ['단계 헤더', '스크롤 본문', '하단 진행 CTA'],
      wire: [
        { label: '단계 표시', tone: 'dim' },
        { label: '폼 본문', tone: 'hero' },
        { label: '다음 / 완료', tone: 'cta' }
      ]
    },

    // —— 2. 인증/온보딩 ——
    {
      id: 'emailAuth',
      lane: 'auth',
      kind: 'auth',
      name: '이메일 로그인',
      sub: 'Center Dialog',
      dom: '#emailAuthModal',
      purpose: '이메일·비밀번호 로그인. Soft Mint 다이얼로그 + grabber.',
      from: '랜딩',
      to: '메인 / 비번 재설정',
      parts: ['딤', 'grabber', '헤드', '이메일·비밀번호 필드', 'mealog-btn-primary 로그인'],
      wire: [
        { label: 'grabber', tone: 'dim' },
        { label: '이메일 로그인', tone: 'accent' },
        { label: '입력 필드' },
        { label: '로그인', tone: 'cta' }
      ]
    },
    {
      id: 'terms',
      lane: 'auth',
      kind: 'auth',
      name: '약관 동의',
      sub: '재동의',
      dom: '#termsModal',
      purpose: '약관 버전 변경 시 재동의. ESC로 닫히지 않음.',
      from: '로그인 직후',
      to: '프로필 설정 / 메인',
      parts: ['약관 본문 스크롤', '체크', '동의 CTA'],
      wire: [
        { label: '약관 본문', tone: 'hero' },
        { label: '동의 체크' },
        { label: '시작하기', tone: 'cta' }
      ]
    },
    {
      id: 'profileSetup',
      lane: 'auth',
      kind: 'auth',
      name: '프로필 초기 설정',
      sub: '닉네임 등',
      dom: '#profileSetupModal',
      purpose: '소셜 가입 후 닉네임·기본 프로필 입력.',
      from: '약관/가입',
      to: '메인 앱',
      parts: ['헤드', '닉네임 필드', 'mealog-btn-primary 시작하기'],
      wire: [
        { label: '프로필 설정', tone: 'accent' },
        { label: '닉네임 입력' },
        { label: '시작하기', tone: 'cta' }
      ]
    },
    {
      id: 'demoIntro',
      lane: 'auth',
      kind: 'auth',
      name: '데모 안내',
      sub: '체험 모드',
      dom: '#demoIntroModal',
      purpose: '데모 계정 진입 시 체험 안내 + 로그인/계속 CTA.',
      from: '데모 로그인',
      to: '메인(체험)',
      parts: ['grabber', '안내 카피', '보조·주요 CTA 페어'],
      wire: [
        { label: '체험 안내', tone: 'hero' },
        { label: '로그인하기 | 체험 계속', tone: 'cta' }
      ]
    },
    {
      id: 'welcome',
      lane: 'auth',
      kind: 'celebrate',
      name: '웰컴/출석',
      sub: '연속 기록',
      dom: '#attendancePopup',
      purpose: '일일 웰컴. 무기록=하트, 연속=따봉/새싹 + (기록 시) AI리포트·식사·간식 차트 카드.',
      from: '메인 진입(출석 게이트)',
      to: '닫기 → 메인 유지 / 분석 더보기',
      parts: [
        '아이콘(하트·따봉·새싹)',
        'Yeon Sung SVG 문구',
        '차트 셸(선택): Soft Mint 탭·도넛/리포트',
        '박스 안 Mint CTA 닫기'
      ],
      wire: [
        { label: '이모지 아이콘', tone: 'hero' },
        { label: '환영 문구' },
        { label: 'AI리포트 | 식사 | 간식', tone: 'accent' },
        { label: '차트 / 리포트' },
        { label: '닫기', tone: 'cta' }
      ],
      note: '관리자 > 콘텐츠 > 웰컴메시지로 문구·빈도 설정'
    },

    // —— 3. 메인 탭 ——
    {
      id: 'mealdang',
      lane: 'main',
      kind: 'main',
      name: '밀당',
      sub: '분석 · 참견',
      dom: '#dashboardView',
      purpose: '기간 KPI, 식사/간식/건강/Best 탭, 인사이트(참견), 캐릭터.',
      from: '하단 탭',
      to: '상세 모달 · 리포트 · 공유 · 캐릭터',
      parts: [
        '기간 네비',
        'KPI 카드 행',
        '분석 탭(식사·간식·건강·Best) Soft Mint',
        '차트·대표 패턴',
        '참견(인사이트) 카드'
      ],
      wire: [
        { label: '헤더 · 기간', tone: 'dim' },
        { label: 'KPI', tone: 'accent' },
        { label: '식사 | 간식 | 건강 | Best' },
        { label: '차트 영역', tone: 'hero' },
        { label: '참견 카드' },
        { label: '하단 탭바', tone: 'dim' }
      ],
      mockup: 'mealdang-v2.html'
    },
    {
      id: 'moment',
      lane: 'main',
      kind: 'main',
      name: '모먼트',
      sub: '공유 피드',
      dom: '#galleryView',
      purpose: '타인/내 공유 식사 피드. 좋아요·댓글·북마크·검색.',
      from: '하단 탭',
      to: '라이트박스 · 댓글 시트 · 옵션 · 검색',
      parts: ['필터/검색 진입', '카드 피드(v2)', '소셜 액션 행', '하단 탭'],
      wire: [
        { label: '필터 · 검색', tone: 'dim' },
        { label: '모먼트 카드', tone: 'hero' },
        { label: '♥ 댓글 북마크', tone: 'accent' },
        { label: '하단 탭바', tone: 'dim' }
      ],
      mockup: 'moment-feed-v2.html'
    },
    {
      id: 'mealog',
      lane: 'main',
      kind: 'main',
      name: '밀로그',
      sub: '홈 · 기록',
      dom: '#timelineView',
      purpose: '일간 타임라인. FAB로 기록 추가. empty 상태(첫/오늘/과거) Soft Mint.',
      from: '하단 탭(기본)',
      to: '슬롯 피커 · 기록 시트 · 사진 휠 · 검색 · 트래커',
      parts: [
        '날짜 헤더/스와이프',
        '타임라인 슬롯 카드',
        'empty(첫·오늘·과거)',
        'FAB(+)',
        '하단 탭'
      ],
      wire: [
        { label: '날짜 · 트래커', tone: 'dim' },
        { label: '식사 카드 / empty', tone: 'hero' },
        { label: 'FAB +', tone: 'cta' },
        { label: '하단 탭바', tone: 'dim' }
      ],
      mockup: 'home-feed-v2.html'
    },
    {
      id: 'lounge',
      lane: 'main',
      kind: 'main',
      name: '라운지',
      sub: '밀톡 · 게시판',
      dom: '#boardListView',
      purpose: '밀톡 채팅 + 게시판/공지 목록. 검색·알림과 연동.',
      from: '하단 탭',
      to: '게시 상세/작성 · 버블 액션 · 검색',
      parts: ['서브탭(밀톡/게시판)', '채팅 버블 또는 게시 리스트', '입력/작성 진입', '하단 탭'],
      wire: [
        { label: '밀톡 | 게시판', tone: 'accent' },
        { label: '피드 / 버블', tone: 'hero' },
        { label: '입력바', tone: 'dim' },
        { label: '하단 탭바', tone: 'dim' }
      ],
      mockup: 'lounge-v2.html'
    },
    {
      id: 'my',
      lane: 'main',
      kind: 'main',
      name: '마이',
      sub: '프로필 · 설정',
      dom: '#settingsView',
      purpose: '프로필, 알림, 계정, 앱 정보, 로그아웃/탈퇴.',
      from: '하단 탭',
      to: '필드 편집 · 아바타 · 확인 다이얼로그',
      parts: ['프로필 헤더', '설정 리스트 섹션', '위험 액션(로그아웃·탈퇴)'],
      wire: [
        { label: '아바타 · 닉네임', tone: 'hero' },
        { label: '설정 행들' },
        { label: '로그아웃 / 탈퇴', tone: 'dim' },
        { label: '하단 탭바', tone: 'dim' }
      ],
      mockup: 'profile-v2.html'
    },

    // —— 4. 인앱 서브뷰 ——
    {
      id: 'boardDetail',
      lane: 'sub',
      kind: 'sub',
      name: '게시글 상세',
      sub: '라운지 풀뷰',
      dom: '#boardDetailView',
      purpose: '게시글/공지 본문·댓글. 탭 뷰를 교체하는 인앱 풀뷰.',
      from: '라운지 목록',
      to: '목록 복귀 · 라이트박스 · 신고',
      parts: ['뒤로가기 헤드', '본문', '댓글 리스트', '댓글 입력'],
      wire: [
        { label: '← 상세', tone: 'dim' },
        { label: '본문', tone: 'hero' },
        { label: '댓글' },
        { label: '댓글 입력', tone: 'accent' }
      ]
    },
    {
      id: 'boardWrite',
      lane: 'sub',
      kind: 'sub',
      name: '게시글 작성',
      sub: '라운지 풀뷰',
      dom: '#boardWriteView',
      purpose: '제목·본문·이미지 작성/수정.',
      from: '라운지',
      to: '저장 → 목록/상세',
      parts: ['헤드(취소·등록)', '제목', '본문', '이미지 첨부'],
      wire: [
        { label: '취소 · 등록', tone: 'dim' },
        { label: '제목' },
        { label: '본문', tone: 'hero' },
        { label: '등록', tone: 'cta' }
      ]
    },

    // —— 5. 기록 플로우 ——
    {
      id: 'slotPicker',
      lane: 'record',
      kind: 'record',
      name: '기록 추가(슬롯)',
      sub: 'Center Dialog',
      dom: '#entrySlotPickerModal',
      purpose: '날짜별 식사·간식·하루 슬롯 선택.',
      from: '밀로그 FAB / 빈 슬롯',
      to: '식사 기록 · 하루 기록',
      parts: ['grabber', '날짜 헤드', '식사/간식/하루 슬롯 리스트'],
      wire: [
        { label: 'grabber', tone: 'dim' },
        { label: '기록 추가', tone: 'accent' },
        { label: '아침 · 점심 · 저녁…', tone: 'hero' }
      ],
      mockup: 'entry-sheet-v2.html'
    },
    {
      id: 'entry',
      lane: 'record',
      kind: 'record',
      name: '식사/간식 기록',
      sub: '입력 시트',
      dom: '#entryModal',
      purpose: '사진·메뉴·장소·만족도·메모 등 메인 기록 폼.',
      from: '슬롯 피커',
      to: '저장 → successPopup · 사진편집 · 장소검색',
      parts: [
        '날짜/슬롯/모드 헤드',
        '사진 영역',
        '무엇을·어디서·만족도·메모',
        '시간 소스',
        '저장 CTA'
      ],
      wire: [
        { label: '날짜 · 슬롯 · 식사|간식', tone: 'dim' },
        { label: '사진', tone: 'hero' },
        { label: '필드들' },
        { label: '저장하기', tone: 'cta' }
      ],
      mockup: 'entry-sheet-v2.html'
    },
    {
      id: 'dailyJournal',
      lane: 'record',
      kind: 'record',
      name: '하루 기록',
      sub: '바텀 시트',
      dom: '#dailyJournalModal',
      purpose: '수면·체중·컨디션·하루 메모·사진.',
      from: '슬롯 피커',
      to: '저장 → 타임라인',
      parts: ['grabber', '바이탈 필드', '메모', '사진', '저장'],
      wire: [
        { label: 'grabber', tone: 'dim' },
        { label: '바이탈', tone: 'accent' },
        { label: '메모 · 사진', tone: 'hero' },
        { label: '저장', tone: 'cta' }
      ]
    },
    {
      id: 'success',
      lane: 'record',
      kind: 'celebrate',
      name: '기록 완료',
      sub: '짧은 축하',
      dom: '#successPopup',
      purpose: '저장 직후 체크+「기록 완료!」 약 0.8초 표시.',
      from: '식사/하루 저장',
      to: '자동 닫힘 → 타임라인',
      parts: ['딤', '체크 SVG', 'Yeon Sung 문구', '컨페티'],
      wire: [
        { label: '✓', tone: 'hero' },
        { label: '기록 완료!', tone: 'accent' }
      ]
    },

    // —— 6. 검색·알림·캘린더 ——
    {
      id: 'timelineSearch',
      lane: 'overlay',
      kind: 'overlay',
      name: '타임라인 검색',
      sub: 'Search Dialog',
      dom: '#timelineSearchModal',
      purpose: '내 기록 기간·키워드 검색.',
      from: '밀로그 헤더',
      to: '결과 → 타임라인 점프',
      parts: ['grabber', '기간 칩', '키워드', '취소·검색 CTA'],
      wire: [
        { label: '기간 칩', tone: 'accent' },
        { label: '키워드' },
        { label: '취소 | 검색', tone: 'cta' }
      ]
    },
    {
      id: 'momentSearch',
      lane: 'overlay',
      kind: 'overlay',
      name: '모먼트 검색',
      sub: 'Search Dialog',
      dom: '#momentSearchModal',
      purpose: '기간·활동(좋아요/댓글/북마크)·키워드.',
      from: '모먼트',
      to: '필터된 피드',
      parts: ['기간 칩', '활동 칩', '키워드', '검색 CTA'],
      wire: [
        { label: '기간 · 활동', tone: 'accent' },
        { label: '검색어' },
        { label: '검색', tone: 'cta' }
      ]
    },
    {
      id: 'boardSearch',
      lane: 'overlay',
      kind: 'overlay',
      name: '게시판 검색',
      sub: 'Search Dialog',
      dom: '#boardSearchModal',
      purpose: '라운지 게시/공지 검색.',
      from: '라운지',
      to: '검색 결과 목록',
      parts: ['기간', '흔적 필터', '키워드', '검색 CTA'],
      wire: [
        { label: '기간 · 흔적', tone: 'accent' },
        { label: '검색어' },
        { label: '검색', tone: 'cta' }
      ]
    },
    {
      id: 'notification',
      lane: 'overlay',
      kind: 'overlay',
      name: '알림',
      sub: '목록 다이얼로그',
      dom: '#notificationModal',
      purpose: '푸시/소셜 알림 목록. Soft Mint 탭·행.',
      from: '헤더 종 아이콘',
      to: '해당 게시/모먼트',
      parts: ['헤드(모두 읽음·닫기)', '필터 탭', '알림 행 리스트', '하단 닫기'],
      wire: [
        { label: '알림 · 모두 읽음', tone: 'dim' },
        { label: '탭 칩', tone: 'accent' },
        { label: '알림 행들', tone: 'hero' },
        { label: '닫기', tone: 'cta' }
      ]
    },
    {
      id: 'calendar',
      lane: 'overlay',
      kind: 'overlay',
      name: '월 캘린더',
      sub: '트래커',
      dom: '#trackerMonthCalendarModal',
      purpose: '기록 있는 날을 점으로 표시하는 월간 달력.',
      from: '밀로그 트래커',
      to: '날짜 선택 → 타임라인',
      parts: ['월 네비', '요일 헤더', '날짜 그리드', '기록 도트'],
      wire: [
        { label: '〈 월 〉', tone: 'dim' },
        { label: '캘린더 그리드', tone: 'hero' }
      ],
      mockup: 'tracker-calendar-v2.html'
    },

    // —— 7. 미디어·공유 ——
    {
      id: 'mealPhotos',
      lane: 'media',
      kind: 'media',
      name: '식사 사진 휠',
      sub: 'Fullscreen',
      dom: '#timelineMealPhotosOverlay',
      purpose: '타임라인 사진 캐러셀·휠 네비.',
      from: '타임라인 사진',
      to: '닫기 / 상세',
      parts: ['풀블랙 딤', '이미지 캐러셀', '슬롯 휠', '닫기'],
      wire: [
        { label: '이미지', tone: 'hero' },
        { label: '슬롯 휠', tone: 'accent' },
        { label: '닫기', tone: 'dim' }
      ]
    },
    {
      id: 'momentLightbox',
      lane: 'media',
      kind: 'media',
      name: '모먼트 라이트박스',
      sub: 'Fullscreen',
      dom: '#momentImageLightbox',
      purpose: '모먼트 이미지 확대·스와이프.',
      from: '모먼트 카드',
      to: '닫기',
      parts: ['풀스크린 미디어', '닫기(glass)', '인디케이터'],
      wire: [
        { label: '미디어', tone: 'hero' },
        { label: '×', tone: 'dim' }
      ]
    },
    {
      id: 'dietReport',
      lane: 'media',
      kind: 'overlay',
      name: 'AI 식단분석',
      sub: '리포트 모달',
      dom: '#dietReportModal',
      purpose: 'AI 리포트 본문·공유. 웰컴 차트와도 연결.',
      from: '밀당 / 웰컴 / 카드',
      to: '공유 · 닫기',
      parts: ['grabber', '리포트 카드 본문', '공유·닫기 액션'],
      wire: [
        { label: '리포트 본문', tone: 'hero' },
        { label: '공유 | 닫기', tone: 'cta' }
      ]
    },
    {
      id: 'contentPopup',
      lane: 'media',
      kind: 'overlay',
      name: '콘텐츠 팝업',
      sub: '캠페인',
      dom: '#contentPopupModal',
      purpose: '관리자 등록 이미지·본문 프로모션. 푸터 세그먼트 CTA.',
      from: '메인 진입(빈도 규칙)',
      to: '닫기 / 오늘 그만 / 랜딩',
      parts: ['grabber', '이미지', '본문', '이전·다음', '오늘 그만·닫기'],
      wire: [
        { label: '이미지', tone: 'hero' },
        { label: '본문' },
        { label: '오늘 그만 | 닫기', tone: 'cta' }
      ]
    },

    // —— 8. 시스템 ——
    {
      id: 'loading',
      lane: 'system',
      kind: 'system',
      name: '로딩 오버레이',
      sub: '전면',
      dom: '#loadingOverlay',
      purpose: '저장·초기 로드 등 차단형 로딩. 음식 아이콘 스피너.',
      from: '비동기 작업',
      to: '완료 시 숨김',
      parts: ['반투명 딤', '카드 박스', '아이콘 애니메이션', '메시지'],
      wire: [
        { label: '🍴 스피너', tone: 'hero' },
        { label: '안내 문구', tone: 'accent' }
      ]
    },
    {
      id: 'toast',
      lane: 'system',
      kind: 'system',
      name: '토스트',
      sub: '배너',
      dom: '#toastContainer',
      purpose: '짧은 성공/정보/에러 피드백. 웰컴과 겹치면 success 생략.',
      from: '각종 액션',
      to: '자동 소멸',
      parts: ['상단 중앙 스택', '톤별 배너'],
      wire: [{ label: '토스트 메시지', tone: 'accent' }]
    },

    // —— 9. 셸 유형(요약) ——
    {
      id: 'shellDialog',
      lane: 'shell',
      kind: 'shell',
      name: 'Center Dialog',
      sub: '셸',
      dom: '.mealog-dialog / #*Modal',
      purpose: '중앙 카드+딤. grabber · 헤드 · 본문 · mealog-btn CTA.',
      from: '확인·폼·검색류',
      to: '닫기/CTA',
      parts: ['딤', '라운드 카드', 'grabber', '액션바(border)'],
      wire: [
        { label: '헤드', tone: 'dim' },
        { label: '본문', tone: 'hero' },
        { label: 'CTA', tone: 'cta' }
      ],
      mockup: 'popup-shells-v2.html',
      note: '개별 팝업 목록은 UI가이드 「팝업」 탭'
    },
    {
      id: 'shellSheet',
      lane: 'shell',
      kind: 'shell',
      name: 'Bottom Sheet',
      sub: '셸',
      dom: '시트형 #*Modal',
      purpose: '하단 상승 폼/피커. 핸들·세이프에리어·스크롤 본문.',
      from: '입력·피커',
      to: '저장/닫기',
      parts: ['딤', '시트 패널', 'grabber', '푸터 CTA'],
      wire: [
        { label: 'grabber', tone: 'dim' },
        { label: '폼', tone: 'hero' },
        { label: '저장', tone: 'cta' }
      ],
      mockup: 'popup-shells-v2.html'
    },
    {
      id: 'shellAction',
      lane: 'shell',
      kind: 'shell',
      name: 'Action Sheet',
      sub: '셸',
      dom: '#feedOptionsMenu 등',
      purpose: '수정·공유취소·신고 등 액션 리스트 + 닫기.',
      from: '점3개 · 롱프레스',
      to: '액션 실행',
      parts: ['액션 카드', '위험 항목 분리', '닫기'],
      wire: [
        { label: '수정 / 공유취소', tone: 'hero' },
        { label: '신고', tone: 'dim' },
        { label: '닫기', tone: 'accent' }
      ],
      mockup: 'popup-shells-v2.html'
    }
  ];

  const LANES = [
    { id: 'entry', num: '01', title: '진입', desc: '부트 → 랜딩 → 가입' },
    { id: 'auth', num: '02', title: '인증 · 온보딩', desc: '로그인 모달 · 약관 · 웰컴' },
    { id: 'main', num: '03', title: '메인 탭', desc: '밀당 · 모먼트 · 밀로그 · 라운지 · 마이' },
    { id: 'sub', num: '04', title: '인앱 서브뷰', desc: '탭을 가리는 풀뷰' },
    { id: 'record', num: '05', title: '기록 플로우', desc: '슬롯 → 입력 → 완료' },
    { id: 'overlay', num: '06', title: '검색 · 알림 · 캘린더', desc: '헤더에서 뜨는 오버레이' },
    { id: 'media', num: '07', title: '미디어 · 캠페인', desc: '라이트박스 · 리포트 · 콘텐츠 팝업' },
    { id: 'system', num: '08', title: '시스템', desc: '로딩 · 토스트' },
    { id: 'shell', num: '09', title: '팝업 셸 유형', desc: '디자인 시스템 단위 (상세는 팝업 탭)' }
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function wireHtml(wire) {
    if (!wire || !wire.length) return '';
    return (
      '<div class="sf-wire" aria-hidden="true">' +
      wire
        .map((row) => {
          const tone = row.tone ? ' sf-wire-row--' + row.tone : '';
          return (
            '<div class="sf-wire-row' +
            tone +
            '"><span class="sf-wire-mark"></span>' +
            esc(row.label) +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function detailHtml(screen, opts) {
    if (!screen) {
      return (
        '<div class="sf-detail-empty">왼쪽 플로우에서 화면을 선택하면<br>현재 구성(와이어·파트·진입/이탈)이 여기에 표시됩니다.</div>'
      );
    }
    const mockupLink = screen.mockup
      ? '<a class="sf-primary" href="' +
        esc((opts.base || '') + screen.mockup) +
        '" target="_blank" rel="noopener">시안 열기</a>'
      : '';
    const popupLink =
      screen.lane === 'shell' || screen.kind === 'overlay' || screen.kind === 'celebrate'
        ? opts.onPopupTab
          ? '<button type="button" data-sf-popup-tab>팝업 탭으로</button>'
          : '<a href="' +
            esc((opts.base || '') + 'popup-inventory.html') +
            '" target="_blank" rel="noopener">팝업 인벤토리</a>'
        : '';

    return (
      '<div class="sf-detail-body">' +
      '<div class="sf-detail-kicker">' +
      esc(KIND_LABEL[screen.kind] || screen.kind) +
      '</div>' +
      '<h3 class="sf-detail-name">' +
      esc(screen.name) +
      '</h3>' +
      '<p class="sf-detail-purpose">' +
      esc(screen.purpose) +
      '</p>' +
      '<div class="sf-meta">' +
      '<span class="sf-pill sf-pill--kind">' +
      esc(KIND_LABEL[screen.kind] || screen.kind) +
      '</span>' +
      '<span class="sf-pill"><code>' +
      esc(screen.dom) +
      '</code></span>' +
      (screen.sub ? '<span class="sf-pill">' + esc(screen.sub) + '</span>' : '') +
      '</div>' +
      wireHtml(screen.wire) +
      '<div class="sf-sec"><h4>구성 파트</h4><ul>' +
      (screen.parts || []).map((p) => '<li>' + esc(p) + '</li>').join('') +
      '</ul></div>' +
      '<div class="sf-sec"><h4>플로우</h4>' +
      '<p class="sf-flow-line"><em>진입</em> · ' +
      esc(screen.from || '—') +
      '</p>' +
      '<p class="sf-flow-line" style="margin-top:4px"><em>이탈</em> · ' +
      esc(screen.to || '—') +
      '</p></div>' +
      (screen.note ? '<p class="sf-note">' + esc(screen.note) + '</p>' : '') +
      '<div class="sf-detail-actions">' +
      mockupLink +
      popupLink +
      '</div>' +
      '</div>'
    );
  }

  function mountScreenFlow(root, options) {
    options = options || {};
    if (!root) return null;
    if (root.dataset.sfMounted === '1') return root.__sfApi || null;

    const standalone = !!options.standalone;
    const base = standalone ? './' : 'docs/ui-mockups/';
    root.classList.add('screen-flow');
    if (standalone) root.classList.add('screen-flow--standalone');

    const links = standalone
      ? '<div class="sf-links">' +
        '<a href="./index.html">시안 허브</a>' +
        '<a href="./popup-inventory.html">팝업</a>' +
        '<a href="./popup-shells-v2.html">셸 시안</a>' +
        '</div>'
      : '<div class="sf-links">' +
        '<a href="docs/ui-mockups/screen-flow.html" target="_blank" rel="noopener">새 창</a>' +
        '<a href="docs/ui-mockups/popup-inventory.html" target="_blank" rel="noopener">팝업 인벤토리</a>' +
        '</div>';

    root.innerHTML =
      '<div class="sf-wrap">' +
      '<div class="sf-top"><div>' +
      '<div class="sf-eyebrow">UI Guide · Screen Flow</div>' +
      '<h1 class="sf-title">화면 플로우차트</h1>' +
      '<p class="sf-lead">서비스에 등장하는 화면 종류를 여정 순으로 이어 두었습니다. 노드를 누르면 오른쪽에 현재 구성이 펼쳐집니다.</p>' +
      '</div>' +
      links +
      '</div>' +
      '<div class="sf-hint"><strong>사용법</strong> · 레인별 카드를 선택하세요. 메인 탭 ↔ 기록 ↔ 오버레이 관계를 한눈에 볼 수 있습니다.</div>' +
      '<div class="sf-filter" data-sf-filter role="tablist" aria-label="레인 필터"></div>' +
      '<div class="sf-layout">' +
      '<div class="sf-flow-panel" data-sf-flow></div>' +
      '<aside class="sf-detail-panel" data-sf-detail aria-live="polite"></aside>' +
      '</div>' +
      '</div>';

    const filterEl = root.querySelector('[data-sf-filter]');
    const flowEl = root.querySelector('[data-sf-flow]');
    const detailEl = root.querySelector('[data-sf-detail]');

    let activeId = 'mealog';
    let filterLane = 'all';

    function renderFilter() {
      const chips = [{ id: 'all', label: '전체' }].concat(
        LANES.map((l) => ({ id: l.id, label: l.title }))
      );
      filterEl.innerHTML = chips
        .map(
          (c) =>
            '<button type="button" class="sf-chip' +
            (filterLane === c.id ? ' is-active' : '') +
            '" data-sf-lane="' +
            esc(c.id) +
            '">' +
            esc(c.label) +
            '</button>'
        )
        .join('');
    }

    function renderFlow() {
      const lanes = filterLane === 'all' ? LANES : LANES.filter((l) => l.id === filterLane);
      flowEl.innerHTML = lanes
        .map((lane, idx) => {
          const nodes = SCREENS.filter((s) => s.lane === lane.id);
          if (!nodes.length) return '';
          const arrow =
            filterLane === 'all' && idx < lanes.length - 1
              ? '<div class="sf-arrow" aria-hidden="true">↓ · · ·</div>'
              : '';
          return (
            '<section class="sf-lane" data-lane="' +
            esc(lane.id) +
            '">' +
            '<div class="sf-lane-head">' +
            '<span class="sf-lane-num">' +
            esc(lane.num) +
            '</span>' +
            '<span class="sf-lane-title">' +
            esc(lane.title) +
            '</span>' +
            '<span class="sf-lane-desc">' +
            esc(lane.desc) +
            '</span>' +
            '</div>' +
            '<div class="sf-nodes">' +
            nodes
              .map(
                (n) =>
                  '<button type="button" class="sf-node' +
                  (n.id === activeId ? ' is-active' : '') +
                  '" data-sf-id="' +
                  esc(n.id) +
                  '">' +
                  '<span class="sf-node-kicker">' +
                  esc(KIND_LABEL[n.kind] || '') +
                  '</span>' +
                  '<strong>' +
                  esc(n.name) +
                  '</strong>' +
                  (n.sub ? '<span class="sf-node-sub">' + esc(n.sub) + '</span>' : '') +
                  '</button>'
              )
              .join('') +
            '</div>' +
            '</section>' +
            arrow
          );
        })
        .join('');
    }

    function renderDetail() {
      const screen = SCREENS.find((s) => s.id === activeId) || null;
      detailEl.innerHTML = detailHtml(screen, {
        base: base,
        onPopupTab: typeof options.onOpenPopupTab === 'function'
      });
      const btn = detailEl.querySelector('[data-sf-popup-tab]');
      if (btn && typeof options.onOpenPopupTab === 'function') {
        btn.addEventListener('click', () => options.onOpenPopupTab());
      }
    }

    function select(id) {
      if (!SCREENS.some((s) => s.id === id)) return;
      activeId = id;
      renderFlow();
      renderDetail();
    }

    filterEl.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-sf-lane]');
      if (!chip) return;
      filterLane = chip.getAttribute('data-sf-lane') || 'all';
      renderFilter();
      renderFlow();
    });

    flowEl.addEventListener('click', (e) => {
      const node = e.target.closest('[data-sf-id]');
      if (!node) return;
      select(node.getAttribute('data-sf-id'));
    });

    renderFilter();
    renderFlow();
    renderDetail();

    const api = {
      select,
      reload: () => {
        renderFilter();
        renderFlow();
        renderDetail();
      },
      screens: SCREENS
    };
    root.dataset.sfMounted = '1';
    root.__sfApi = api;
    return api;
  }

  global.mountScreenFlow = mountScreenFlow;
})(typeof window !== 'undefined' ? window : globalThis);
