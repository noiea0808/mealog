# Firestore 읽기·Functions 호출 실측 감사 (2026-08-28)

「사용량이 평소의 두 배」로 보이던 현상을 Cloud Monitoring 실측으로 분해한 기록.
결론부터: **스케줄 최적화는 성공했고, 급증은 개발·검증 트래픽이었다.** 사용자 앱이 아니다.

## 1. 실측 방법 (재현용)

콘솔을 열지 않고 gcloud 토큰으로 Monitoring API 를 직접 조회한다.

```bash
TOKEN=$(gcloud auth print-access-token)
curl -s -G -H "Authorization: Bearer $TOKEN" \
 "https://monitoring.googleapis.com/v3/projects/mealog-r0/timeSeries" \
 --data-urlencode 'filter=metric.type="firestore.googleapis.com/document/read_count"' \
 --data-urlencode "interval.startTime=$(date -u -d '9 days ago' +%Y-%m-%dT%H:%M:%SZ)" \
 --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
 --data-urlencode 'aggregation.alignmentPeriod=86400s' \
 --data-urlencode 'aggregation.perSeriesAligner=ALIGN_SUM' \
 --data-urlencode 'aggregation.crossSeriesReducer=REDUCE_SUM'
```

- 메트릭: `firestore.googleapis.com/document/read_count` · `write_count`,
  `cloudfunctions.googleapis.com/function/execution_count` (v2 함수도 잡힌다)
- **함수별로 쪼개려면** `crossSeriesReducer` 를 빼고
  `aggregation.groupByFields=resource.label.function_name` 을 준다. 배포 전후 비교에 결정적.
- `alignmentPeriod=300s` 로 5분 단위를 보면 「한 번에 왕창」(전량 스캔)인지
  「고르게」(리스너 누적)인지 갈린다.

**함정:**
- 반환 포인트는 **최신순**이다. 시간순으로 읽으려면 뒤집어야 한다(증감을 거꾸로 읽기 쉽다).
- `endTime` 은 UTC. KST 는 +9시간.
- 마지막 버킷은 진행 중인 부분 구간이라 낮게 나온다 — 오늘 수치로 추세를 판단하지 말 것.
- **읽기는 컬렉션·출처별 분해가 안 된다.** 함수 실행분을 빼서 클라이언트 몫을 역산해야 한다.

## 2. 스케줄 최적화는 실제로 먹혔다

| 함수 | 8/25 이전 | 8/27 이후 |
|---|---|---|
| `processScheduledAdminPushes` | 1,440/일 (매분) | **144/일** |
| `scheduledDailyDietAnalysis` | 96/일 (15분마다) | **1/일** |

하루 **1,391회** 감소. `deliverScheduledAdminPush`(Cloud Tasks)가 8/26부터 실제로 실행되고
있어 **태스크 첫 실발송도 확인**됐다. 안전망 경고 로그 없이 태스크 경로로 나가는 중.

## 3. 아침 3만 읽기의 정체 = 관리자 전량 재집계

전량 재집계 1회 원가를 COUNT 집계로 실측: **약 12.6K 읽기**
(meals 11,237 + users 509 + config CG 894).

5분 단위로 쪼개니 모든 스파이크가 이 단위의 배수였다.

| 시각(KST) | 읽기 | 정체 |
|---|---|---|
| 8/24~25 아침 | 12~13K | 증분 배포(8/26) **전** — 새로고침이 매번 전량이던 시절 |
| 8/27 08:35 | 24.8K | 주간 자동 전량의 **첫 발화**(도장 없던 캐시, 정상 동작) |
| 8/27 23:46 | 46.9K | 자정의 dashboard 커밋 2건(d64422e 23:55, 061c324 00:04) 디버깅 |
| 8/28 08:35 | 24.7K | `fix(admin-trend)`(7658ce3, 08:39) 검증 — 수정 전후 비교 2회 |
| 8/26~27 | 읽기 283K / `onMealWritten` 1,873회 | `adminBackfillDailyJournalMirrors` 백필(일회성) |

**자동 주간 전량은 정상이다.** 운영 `adminSettings/dashboardStats` 의
`lastFullAggregatedAt = 2026-08-27T23:34Z`(= 8/28 08:34 KST) 확인.
다음 자동 발화는 일요일 1회뿐. 이번 주 내내 대시보드를 개발·검증하느라
「매일 도는 버그」처럼 보였을 뿐이다.

쓰기는 2,400/일로 내내 안정적이었다(8/27만 5,100 — 백필).

## 4. 결함 2개 — 하나는 수정 완료

### 4-1. `lastFullAggregatedAt` 도장 롤백 레이스 — ✅ 수정 (09a06b1)

`refreshDashboardStats` 의 증분 저장이 **merge 없는 `setDoc`** 으로 문서 전체를 쓰면서,
`lastFullAggregatedAt` 을 **집계 시작 시점의 `prevData`** 에서 물려받는다.
→ `js/admin/dashboard.js` (payload 구성부)

전량(수 분 소요)과 증분이 겹쳐 돌다 증분이 나중에 끝나면 도장이 옛값으로 되돌아가고,
다음 날 아침 12.6K 가 또 나간다.

**조치:** 저장을 `runTransaction` 으로 감싸고, 도장을 `prevData` 가 아니라
**저장 직전 서버 값**에서 가져온다. 전량이면 자기 시각을 찍고, 증분이면 그때의 최신
도장을 그대로 놓아둔다. 본문은 지금까지처럼 통째로 덮는다(옛 필드 제거 때문에
merge 없는 쓰기가 필요하다). 읽기 1회가 늘지만 헛도는 전량 한 번이 12.6K 다.

### 4-2. 주간 전량 빗장이 탭 단위 — 미수정

`weeklyFullRefreshStarted` 가 모듈 전역(탭 로컬)이라 **두 탭·두 기기면 전량이 2회** 돈다.
8/27 아침의 24.8K(=12.6K×2)가 그 흔적일 수 있다.

**수정 방향:** 시작 시점에 캐시 문서에 「집계 중」 표식을 남겨 다른 탭이 물러나게 한다.

## 5. 진짜 남은 숙제: 조용한 날 42K/일

개발 트래픽을 걷어낸 기준선이 **42K/일**, DAU **18명** 기준 약 **2,300 읽기/인**이다.
무료 티어(일 5만)에 붙어 있다.

클라이언트 리스너 자체는 이미 좁다 — meals 는 최근 7일 + `limit(50)`,
sharedPhotos 는 20~100 배치, 영구 캐시(`persistentLocalCache`)도 켜져 있다.
그럼에도 1인당 2,300이 나오는 건, **리스너가 30분 이상 끊겼다 재부착되면
쿼리가 재실행되어 요금이 새로 붙기 때문**으로 보인다. 모바일 재방문마다
창 전체(meals + sharedPhotos + board/feed)를 다시 사는 구조.

**여기부터는 정적 분석의 한계다.** 실기기에서 앱을 열고 네트워크를 계측해
재부착 1회당 실제 문서 수를 세야 한다.

관련 문서: `firestore-read-reduction.md`, `firestore-read-optimization-plan.md`
