# Firestore 읽기 절감 변경 사항

Firestore 대시보드에서 읽기 횟수가 높게 나오는 문제를 줄이기 위해 적용한 변경입니다.

## 1. Settings 리스너 (`js/db/listeners.js`)

- **users/{userId} 문서 확인**: 세션당 1회만 `getDoc(userDocRef)` 실행.  
  `userDocEnsureDoneForUid`로 동일 사용자에 대해 중복 호출 방지.
- **defaultTags (관리자 태그)**: 세션당 1회만 `getDoc(tagsDoc)` 실행.  
  `cachedDefaultTags`에 캐시하고, 사용자 전환 시(`lastListenersUserId !== userId`)만 캐시 초기화.

**효과**: 설정 스냅샷이 여러 번 와도(캐시/서버 등) user·tags 추가 읽기가 1회로 제한됨.

## 2. Meals 리스너 (`js/db/listeners.js`)

- **쿼리 기간**: 최근 **1개월** → **2주(14일)** 로 축소.
- 초기 로드 및 meals 변경 시 스냅샷에 포함되는 문서 수가 줄어듦.

**효과**: 한 번의 스냅샷당 읽기 수 감소. 2주 이전 데이터는 `loadMoreMeals()` / `loadMealsForDateRange()`로 필요 시 로드.

## 3. SharedPhotos 리스너 (`js/db/listeners.js`)

- **limit**: **100** → **50** 으로 축소.
- 공유 추가/삭제 시 스냅샷에 포함되는 문서 수가 절반으로 줄어듦.

**효과**: sharedPhotos 변경 시마다 과금되는 읽기 수 감소.

## 4. Board 리스너

- `setupBoardListener`는 현재 **사용되지 않음** (게시판은 `getPosts` 등 getDocs로 로드).  
  별도 변경 없음.

## 참고

- **onSnapshot**은 스냅샷이 올 때마다 **해당 쿼리 결과 문서 수만큼** 읽기로 과금됨.
- 데이터 변경이 잦을수록 리스너 기반 읽기가 늘어나므로, 기간·limit 축소와 콜백 내 추가 getDoc 최소화가 효과적임.

---

## 5. 읽기 비용의 주범은 사용자 쪽이 아니었다 (2026-08-29)

위 §1~§3 은 전부 **사용자 세션**을 깎은 것이다. 그런데 그렇게 깎고도 Firestore 대시보드
숫자가 기대만큼 떨어지지 않았고, 실제 원인은 **관리자 통계 조회**였다.

| | 한 번에 읽는 문서 |
|---|---|
| 사용자 세션 1회 | meals 14일치 + sharedPhotos 10~50건 → 수십 건 |
| 관리자 「새로고침」 1회 (증분 도입 전) | meals 전량(1만 건대) + users 전량 + config 상한 1만 + sharedPhotos 전량 → **2~3만 건** |

관리자가 대시보드를 몇 번 열고 새로고침을 몇 번 누르면 사용자 수백 명의 하루치를 그 자리에서
넘어선다. 사용자 쪽을 아무리 더 깎아도 이 비대칭은 줄지 않는다.

> **교훈**: 읽기 비용을 줄이려 할 때 사용자 수에 비례하는 경로부터 의심하는 것은 자연스럽지만,
> 이 앱에서는 **관리자 1명이 누르는 버튼 하나**가 더 컸다. 절감은 추측이 아니라 경로별 실제
> 문서 수로 판단한다.

### 적용

- **증분 집계** (`js/admin/dashboard-incremental.js`, `getUserStatistics`) — 다시 읽는 범위를
  「현재 주 + 최근 7일」로 좁히고, 과거 주차는 캐시 값을 쓴다. config 전수 스캔은 증분에서
  아예 건너뛰고, 전체 인원·슬롯별 합계는 문서를 읽지 않고 `getCountFromServer` 로 센다.
- **주간 정기 전체 재집계의 탭 간 빗장** (`claimWeeklyFullRefresh`) — 증분이 놓치는 과거 기록의
  수정·삭제를 청소하려면 주 1회 전량 집계가 필요한데, 빗장이 모듈 변수라 **탭마다 따로 판단**해
  전량 스캔이 탭 수만큼 돌았다. 캐시 문서에 표식을 두고 트랜잭션으로 잡는다. 표식은 시간으로
  풀리는 리스라(30분) 집계 도중 탭이 닫혀도 다음에 다시 잡힌다.
- **폴백 스캔 상한** (`ADMIN_DAILY_JOURNAL_FALLBACK_SCAN_CAP`) — 모니터링 > 피드의 하루기록
  목록은 `slotId+date` 복합 인덱스가 없으면 정렬 없이 조회하는 폴백을 타는데, 그 경로에만
  `limit` 이 없어 인덱스 배포가 밀리거나 재빌드 중일 때 조용히 전량 스캔이 됐다.

### 남은 것

- **모니터링 > 피드** (`getFeedPage`) — 작성자 필터가 없으면 `collectionGroup(db, 'meals')`.
  페이지네이션은 있지만 정렬·카운트가 collectionGroup 전역이라 페이지를 넘길수록 비싸다.
- **`js/admin/users.js:579` 의 `getDocsFromServer`** — 캐시를 의도적으로 우회하므로 호출될
  때마다 실전 읽기다. 우회가 정말 필요한 자리인지 확인이 필요하다.
