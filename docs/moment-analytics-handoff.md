# 모먼트 분석 — 인수인계 (2026-08-28)

다른 기기에서 이어서 작업할 때 이 문서부터 읽으세요.
관련 설계는 [entry-sheet-rollout-metrics.md](entry-sheet-rollout-metrics.md),
[food-category-auto-classification.md](food-category-auto-classification.md),
[food-axis-rollout.md](food-axis-rollout.md)에 있습니다.

## 1. 지금 상태

- **브랜치 `staging`, 원격 push 완료.** 작업 트리 깨끗합니다.
- **배포 불필요** — `admin.html` 과 `js/admin/**` 만 건드렸습니다. 관리자 화면은
  스테이징에서만 보므로 `git push origin staging` 으로 끝입니다(hosting 배포 대상 아님).
- **Firestore 인덱스·규칙·Functions 변경 없음.**

| 커밋 | 내용 |
|---|---|
| `183d72c` | feat(admin-moment): 「모먼트 분석」 탭 — 항목별 입력률·기간 추이·완성도 분포 |
| `1529115` | feat(admin-moment): 「무엇을」 채워진 경로 분해 |

## 2. 무엇을 만들었나

관리자 → 모니터링 → **모먼트 분석** (「모먼트 관리」 바로 옆).

기간(최근 7/30/90일 또는 직접 지정) 안의 끼니·간식 기록에서 각 항목이 얼마나
채워지는지를 셉니다. 화면 구성은 넷:

1. **요약 카드** — 대상 기록 수, 참여 사용자, 평균 입력 완성도, 읽은 문서 수
2. **항목별 입력률** — 어떻게·어디서·무엇을·누구와·만족도·포만감·사진·코멘트(+상세 3종)
3. **「무엇을」이 채워진 경로** — 아래 §3
4. **기간 추이**(31일 이하 일별 / 초과 주별) + **기록당 채운 항목 수 분포**

| 파일 | 역할 |
|---|---|
| [`js/admin/moment-analytics-model.js`](../js/admin/moment-analytics-model.js) | 계산부. Firestore·DOM 모름 |
| [`js/admin/moment-analytics.js`](../js/admin/moment-analytics.js) | 조회·렌더 |
| [`test/moment-analytics-model.test.mjs`](../test/moment-analytics-model.test.mjs) | 12개 |

계산부를 가른 이유는 하나입니다 — **이 값들은 틀려도 표가 멀쩡해 보입니다.** 필드 판정이나
주 경계가 한 칸 어긋나도 그럴듯한 숫자가 그려져서, 화면으로는 잡을 수 없습니다.

## 3. 「무엇을」 경로 분해 — 왜 필요했나

시트 개편 뒤 이 축의 입력률이 뚝 떨어져 보이는데, 한 줄로는 **"사용자가 덜 고르게 됐다"와
"분류 자체가 안 된다"를 가를 수 없었습니다.** 손댈 곳이 전혀 다른 두 사실입니다.

이 축만 값이 들어오는 길이 넷입니다(`js/modals/entry-save-record.js`,
`functions/classifyMoments.js`):

| 경로 | 저장 형태 |
|---|---|
| 사용자 확정 | `category` / `snackType`, `categorySource='user'` |
| 로컬 분류기 | `categoryAuto`, `source='local'` |
| 서버 Gemini 배치 | `categoryAuto`, `source='ai'` |
| 제안 ✕ 거부 | 값 없음, `source='dismissed'` — **backfill도 건너뜀(영구 미분류)** |
| 아무도 안 집음 | 값·source 없음 — 서버 배치 대기(단 `menuDetail` 이 있어야 집힘) |

**자동 분류는 `category`·`snackType` 을 절대 건드리지 않습니다.** 그래서 「무엇을」 행은
처음부터 사용자 확정만 세고 있었습니다 — 값은 맞았지만 혼자서는 오해를 부릅니다.
지금은 배타적 8경로 표와 **「사용자가 고른 비율」 / 「최종 분류 도달률」** 두 카드,
추이의 `무엇을(최종)` 열로 갈라 봅니다.

### 읽을 때 조심할 곳

- **서버 AI는 배치로 나중에 돕니다.** 최근 며칠은 아직 안 돌았을 수 있어 「대기」가 부풀고
  「AI가 채움」이 낮게 나옵니다. **추이 맨 오른쪽 구간은 그만큼 감해서 보세요.**
- **「기타」는 직접 선택과 갈라 두었습니다** — 서버가 미분류로 보고 다시 집는 값입니다
  (`classificationKind`: `userValue !== '기타'`).
- **만족도·포만감**은 설정에서 끌 수 있어 미입력에 「꺼 둔 사용자」가 섞입니다. 걸러내려면
  사용자별 `config/settings` 를 읽어야 해서(읽기가 사용자 수만큼 늘어남) 각주로만 밝혔습니다.
- 분모에서 **하루기록 미러·캡처 공유를 뺐습니다** — 이 항목들을 애초에 갖지 않아, 넣으면
  입력률이 통째로 내려앉아 아무것도 못 읽는 숫자가 됩니다.

## 4. 읽기 비용

**모먼트 관리와 나눠 쓸 수 없습니다** — 저쪽은 페이지당 20건, 이쪽은 기간 전체를 읽습니다.
그래서:

- 탭 진입만으로는 조회하지 않음. 「분석 실행」에서만 읽습니다.
- 같은 기간은 **10분 캐시**(결과 위에 「n분 전 결과 · 읽기 없음」과 「새로 읽기」가 뜹니다).
- 상한 **2만 건**. 넘으면 최근 날짜부터 그만큼만 집계하고 그 사실을 알립니다.
- 읽은 문서 수를 요약 카드에 찍어 비용이 보이게 했습니다.

## 5. 남은 일

1. **실데이터 첫 실행 확인** — 슬롯 날짜(`date`) 축 collectionGroup 범위 쿼리가 인덱스 없이
   도는지. `failed-precondition` 이 뜨면 화면에 배포 명령이 안내됩니다
   (`firebase deploy --only firestore:indexes`).
2. **「무엇을」 하락의 해석을 끝낼 것.** 봐야 할 두 값:
   - **최종 분류 도달률**이 유지되는가 → 유지되면 입력 경로만 옮겨간 것
   - **「무엇을 상세」 입력률**이 그만큼 올랐는가 → 칩 대신 텍스트로 갔다면 받쳐줘야 함

   형태 칩을 접은 개편이라면 직접 선택 하락은 설계상 예상된 방향입니다
   ([project 메모: 음식 텍스트 재사용률 14% 근거](food-axis-rollout.md) 계열 참조).
3. **읽기량 실측 후 판단** — 부담되면 대시보드 증분 집계
   (`js/admin/dashboard-incremental.js`) 방식으로 서버에 미리 세어두는 쪽으로 옮깁니다.
   지금은 매 실행이 기간만큼 읽습니다.
4. **[entry-sheet-rollout-metrics.md](entry-sheet-rollout-metrics.md) §2 표와 이어붙이기** —
   교정률(`categorySource` 기반)·선택 입력 채움률은 이 화면이 이미 세고 있습니다.
   스크립트(`functions/scripts/entry-sheet-effect.js`)와 숫자가 맞는지 한 번 대조하면
   둘 중 하나를 접을 수 있습니다.
