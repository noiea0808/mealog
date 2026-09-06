# B-7 계측 구현 — 로컬 세션용 프롬프트

아래 블록을 로컬 Claude Code 세션에 그대로 붙여넣는다.
배경은 [../04-improvement-backlog.md](../04-improvement-backlog.md) B-7 절.

---

AI 식단 리포트와 웰컴 팝업에 사용 계측을 추가해줘. 기존 `usageDaily` 계측 시스템에 항목만 얹는 작업이야.

## 왜 하는가

밀로그 운영비의 대부분이 AI 식단 리포트에서 나가는데(사용자 3,000명 기준 월 23만원 중 17만원),
**정작 사용자가 그 리포트를 읽는지를 재고 있지 않다.** 지금은 기록 2건 이상이면 무조건 생성한다.
열람률을 알면 "2주째 안 읽는 사람은 건너뛰기" 같은 낭비 제거가 가능해지고,
반대로 열람률이 높으면 리포트가 유지의 이유라는 뜻이라 비용을 아끼면 안 된다는 판단이 선다.

웰컴 팝업도 마찬가지다. 요일별로 첫 화면이 정해져 있는데(`js/welcome-weekday-config.js`
`DEFAULT_WELCOME_WEEKDAY_DEFAULTS`) 그 구성이 데이터가 아니라 감으로 정해져 있다.

## 먼저 읽을 것

- `js/usage-metrics.js` — 계측 함수. **`logUsageMetric(key)`는 인자가 key 하나뿐이다.**
  저장이 `usageDaily/{YYYY-MM-DD}` 문서에 필드별 `increment(1)`이라 파라미터를 못 받는다.
  그래서 **구분값은 키 이름에 넣는다** (예: `diet_report_open_welcome`).
- `functions/index.js` `USAGE_DAILY_METRIC_KEYS` (약 4141행) — 서버 허용 목록. 여기 없는 키는 거부된다.
- `js/admin/dashboard.js` `PAGE_VIEW_METRIC_DEFS` (약 85행) — 관리자 표의 행 정의.
  `{ field, section, label }` 형태이고, 여기 추가하면 기존 표에 자동으로 붙는다.
- `js/main/tabs.js:82-84` — 호출 예시 (`logUsageMetric('tab_mealog').catch(() => {})`).

## 추가할 키 11개

### 리포트 열람 (2개)

두 진입 경로가 모두 `js/modals/diet-report.js`의 `openDietReportModal(dateStr)`로 모인다.
경로를 구분해야 하므로 **함수에 두 번째 인자 `from`을 추가**하고, 그 값에 따라 키를 나눠 쏜다.

| 키 | 조건 |
|---|---|
| `diet_report_open_welcome` | 웰컴 팝업에서 열림 |
| `diet_report_open_timeline` | 밀로그 타임라인 버튼에서 열림 |

호출부는 두 곳이다:
- `js/ui.js:867` 부근 `bindWelcomeReportPanelOnce` → `from='welcome'`
- `js/modals/diet-report.js:891` 부근 타임라인 위임 핸들러 → `from='timeline'`

`window.openDietReportModal`로도 노출돼 있으니(`diet-report.js:858`) 인자 없이 호출되는 경우
기본값을 두고, 그때는 아무 키도 쏘지 않거나 timeline으로 보되 어느 쪽인지 코드에 주석으로 남겨줘.

### 웰컴 팝업 (9개)

| 키 | 언제 | 붙일 곳 |
|---|---|---|
| `welcome_shown_report` | 팝업이 뜨고 첫 화면이 리포트 | `js/ui.js` 팝업 렌더 지점 |
| `welcome_shown_meal` | 첫 화면이 식사 | 〃 |
| `welcome_shown_snack` | 첫 화면이 간식 | 〃 |
| `welcome_dwell_3s` | 팝업이 3초 이상 열려 있었다 | 팝업 열림 시 타이머, `closeAttendancePopup`에서 정리 |
| `welcome_kind_switch_report` | 리포트 탭으로 **전환**했다 | `js/ui.js` kind 전환 리스너 (`welcomeChartKind` 갱신 지점, 약 855행) |
| `welcome_kind_switch_meal` | 식사 탭으로 전환 | 〃 |
| `welcome_kind_switch_snack` | 간식 탭으로 전환 | 〃 |
| `welcome_slide_move` | 슬라이드를 넘겼다 | `attendanceWelcomeSlideIdx` 변경 지점 (약 781행) |
| `welcome_report_nav` | 리포트 날짜를 앞뒤로 넘겼다 | `bindWelcomeReportDateNavOnce` (약 873행) |

**요일은 키에 넣지 마라.** 저장 문서 ID가 이미 날짜(`YYYY-MM-DD`)라 요일은 나중에 계산된다.
`welcome_kind_switch_*`는 **전환한 결과 탭**을 센다(어디서 왔는지는 안 센다) — 키 수를 9개가 아니라 3개로 유지하려는 것이다.

## 지켜야 할 것

1. **`logUsageMetric`은 실패해도 앱이 멈추면 안 된다.** 기존 호출부처럼 `.catch(() => {})`를 반드시 붙인다.
   `await`하지 말고 fire-and-forget으로 둔다.
2. **중복 발사 금지.** 팝업이 리렌더될 때마다 `welcome_shown_*`이 다시 나가면 숫자가 부풀려진다.
   팝업 1회 열림당 1회만 나가도록 플래그를 둔다. `welcome_dwell_3s`도 같다.
   슬라이드·탭 전환은 사용자 행동이므로 매번 세는 게 맞다.
3. **`USAGE_DAILY_METRIC_KEYS`에 11개를 모두 추가**한다. 빠뜨리면 Callable이 조용히 거부한다
   (폴백인 직접 쓰기는 규칙상 통과하므로 **일부만 기록되는 상태**가 되어 더 헷갈린다).
4. **관리자 표에도 추가**한다. `PAGE_VIEW_METRIC_DEFS`에 `section`을 새로 하나 만들어라
   (예: `'웰컴'`, `'리포트'`). 기존 섹션에 섞으면 성격이 다른 숫자가 같은 축으로 읽힌다 —
   `RECORD_USAGE_METRIC_DEFS` 주석에 같은 취지가 적혀 있으니 참고해라.
5. **`firestore.rules`는 손댈 필요 없다.** `usageDaily` 규칙은 날짜 형식만 검사하고 필드는 검사하지 않는다.
6. 계측은 운영 환경·로그인 사용자만 기록된다(`logUsageMetric` 내부에서 이미 거른다). 그대로 둔다.

## 검증

- `npm run lint:errors` 통과
- `npm test` 통과 (기존 테스트가 깨지지 않는지)
- 순수 함수로 뺄 만한 로직이 생기면 `test/`에 테스트를 추가한다.
  다만 이번 작업은 대부분 DOM 이벤트 바인딩이라 억지로 테스트를 만들 필요는 없다.
- 로컬에서 `python3 -m http.server 8000`으로 띄워 팝업을 열고 콘솔에 오류가 없는지 확인.
  (계측은 운영 환경에서만 실제로 쏘므로 로컬에서는 조용히 무시되는 게 정상이다.)

## 작업 방식

- `docs/AGENTS.md`와 `.cursor/rules/local-git-workflow.mdc`를 따른다.
  `staging`에서 시작해 `feat/usage-metrics-report-welcome` 브랜치를 만든다.
- 커밋 메시지는 저장소 기존 스타일(한국어, `feat(scope): 설명`)을 따른다.
- push는 하지 말고 커밋까지만 해줘. 내가 확인하고 올린다.

## 다 끝나면 알려줄 것

- 추가한 키 11개가 클라이언트·서버 허용 목록·관리자 표 세 곳에 모두 들어갔는지
- `openDietReportModal` 시그니처를 바꿨으니 호출부를 빠짐없이 고쳤는지
  (`window.openDietReportModal` 경유 호출 포함)
- 2주 뒤 이 데이터로 답할 질문: (a) 만든 리포트 중 읽히는 비율, (b) 월·목(리포트가 첫 화면)과
  나머지 요일의 열람률 차이, (c) 팝업을 띄운 것 대비 뭔가라도 만진 비율
