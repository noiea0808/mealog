# 관리자 로컬 미러 — 관리자 화면이 읽는 데이터의 브라우저 사본 (1~7단계)

관리자 화면들이 방문할 때마다 Firestore 를 전량 스캔하던 비용
(`firestore-read-audit-2026-08.md` 의 12~25K 스파이크)을 없애기 위한 구조.
관리자는 1인·고정 환경이므로, **데이터 사본을 관리자 브라우저 IndexedDB 에 두고
변경분만 따라간다.**

## 구조

```
관리자 브라우저 (IndexedDB: mealog-admin-mirror, v4)
  meals 스토어         키 `${userId}/${mealId}` · date 인덱스
  users 스토어         키 userId · 분석이 쓰는 필드 + 하루 소감 자국(journal)
  sharedPhotos 스토어  ┐
  aiDietReports 스토어 │ 범용 컬렉션 미러 — 키 id · _sortMs 인덱스
  feedPosts 스토어     │
  boardPosts 스토어    │
  usageDaily 스토어    ┘ (키 id = 날짜 YYYY-MM-DD)
  meta 스토어          스토어별 lastSyncedAt 북마크·bootstrapDone·docCount

Firestore (기존 그대로 + 1개 추가)
  adminMealTombstones/{userId}_{mealId}   ← onMealWritten 이 삭제 시 남기는 흔적
```

스키마 버전은 `admin-mirror-db.js` 한 곳에서만 올린다 — 두 모듈이 서로 다른
버전으로 `indexedDB.open` 하면 충돌한다. 버전을 올리는 업그레이드는 **다른 탭이 옛
버전으로 붙들고 있으면 막히고, 그때 `open` 은 성공도 실패도 하지 않는다.** `onblocked`
에서 사람이 읽을 수 있는 실패로 바꾼다 — 없으면 화면이 「상태를 읽는 중…」에서 굳는다.
스토어를 더하기만 하는 업그레이드는 기존 데이터를 건드리지 않는다(v3→v4 확인).

### meals (1단계)

- 부트스트랩(최초 1회): meals 컬렉션그룹 전체를 `__name__` 순으로 페이지
  다운로드 (~1.2만 읽기, 기기당 1회).
- 이후 동기화(분석 실행 시):
  - 신규·수정 `collectionGroup(meals).where(updatedAt > 북마크−48h)` — 변경분만
  - 삭제 `adminMealTombstones.where(deletedAt > 북마크−48h)`
- 분석·집계는 전부 IndexedDB 에서 — Firestore 읽기 0회.

### users (2단계)

「사용자 분석」이 실제로 쓰는 값은 **여섯 개**뿐이다 — 생년월일·성별·라이프스타일·
로그인수단·마지막로그인·가입간격. 그런데 예전에는 목록 화면과 같은 전체 조회를 돌려
userBans·deleteRequests·sharedPhotos·boardPosts·사용자별 meals 카운트까지 사 놓고
전부 버렸다. 그래서 미러는 **루트 users + config/settings 만** 읽는다.

- 전체 재구축: 루트 문서를 `__name__` 순으로 훑고(그래야 `lastLoginAt` 없는 문서도
  빠지지 않는다) 각자의 settings 를 병렬로 읽는다 — 사용자수 × 2 읽기.
- 델타: `users.where(lastLoginAt > 북마크−48h)` + 그 사용자들의 settings.
  신규 가입도 여기에 걸린다.
- 삭제 감지: 탈퇴하면 루트 문서째 사라져 델타에 걸리지 않는다. 그래서 매 동기화마다
  `getCountFromServer(users)` 를 **1회**(1읽기) 세어, 미러가 아는 수보다 **줄었으면**
  전체 재구축한다. 늘어난 건 신규 가입이라 델타가 이미 채웠다.
- 전체 재구축 주기는 7일. 「전체 새로 읽기」 버튼으로 언제든 강제할 수 있다.
- 파생 규칙(날짜 파싱·로그인수단·가입간격)은 `users-mirror-model.js` 하나만 쓴다 —
  `users.js` 목록도 여기서 import 한다. 두 곳에 두면 분석 값이 목록과 어긋난다.
- **settings 없는 고아 문서도 담는다** (`hasSettings: false`). 「사용자 분석」과 목록은
  예전처럼 건너뛰지만, 대시보드 신규 사용자는 루트 `createdAt` 만으로 세기 때문이다 —
  여기서 지우면 서버 전량 조회 시절보다 신규 사용자가 줄어 보인다.
  걸러내기는 `getAllUsersFromMirror()`(분석용) 와 `getAllUserMirrorRows()`(전부) 가 나눈다.
- **목록이 쓰는 표시 필드**(닉네임·아이콘·약관·프로필 완료·`mealCount`)도 담는다. 같은
  이유다 — settings 를 어차피 읽고 있어서 **읽기가 하나도 더 들지 않는다.**
  닉네임·아이콘 규칙(`deriveUserListDisplay`)은 서버 폴백 경로(`users.js` 의 `getUsers`)와
  **같은 함수**를 쓴다. 두 곳에 두면 미러로 본 목록과 서버로 본 목록의 닉네임이 갈린다.
- **하루 소감 자국**(`journal: [{d, r}]`) 을 함께 담는다 — settings 를 어차피 읽고 있으니
  **읽기를 하나도 더 쓰지 않는다.** 본문은 담지 않는다: 필요한 것은 「어느 날짜에 내용 있는
  소감이 있었나」와 시간대 행이 쓸 기록 시각뿐이다. 대시보드가 이걸 쓰면서
  `collectionGroup('config')` 전량 스캔이 없어졌다.
- 행 모양이 바뀌면 `USERS_MIRROR_ROW_SCHEMA` 를 올린다. 델타로는 옛 행을 고칠 수 없으므로
  `decideUsersSyncMode` 가 `schema-changed` 로 전체 재구축을 부른다.
- **전체 재구축은 서버에 없던 행을 지운다.** 탈퇴자는 루트 문서째 사라져 순회에 걸리지
  않으므로, 담기만 해서는 옛 행이 영원히 남는다 — 전체 재구축을 부르는 계기가 「문서 수가
  줄었다」인데 정작 그 재구축이 줄어든 몫을 지우지 못하고 있었다. meals 부트스트랩도 같다.

### 범용 컬렉션 미러 (3단계)

`sharedPhotos` · `aiDietReports` · `feedPosts` · `boardPosts` · `usageDaily` 는 한 틀
(`collection-mirror.js`)로 담는다. meals·users 만큼 특수하지 않아서다.

**축이 「생성 시각」인 이유.** meals 는 앱이 모든 저장 경로에서 `updatedAt` 을 찍어
주지만, 이 컬렉션들은 클라이언트·Functions 십수 곳에서 제각각 쓰인다(좋아요·댓글·
신고·관리자 조치…). 공통 도장이 없으니 「수정」을 축으로 삼을 수 없다. 그래서
생성 축(`timestamp` / `generatedAt`)으로 **새 문서만** 따라가고 나머지는 이렇게 메운다:

- 관리자 조치(숨김·삭제)는 **본인이 하는 쓰기**라 그 자리에서 미러에 반영
  (`patchLocal` / `applyLocalDelete`) — 되읽지 않는다.
- 사용자 쪽 수정·삭제는 문서 수 감시(줄면 전체 재구축)와 7일 주기 재구축이 정리한다.
- `aiDietReports` 는 생성 뒤 바뀌지 않아 이 한계가 아예 없다(진짜 append-only).

**`usageDaily` 만은 축이 「수정 시각」이다.** 쓰기 경로가 둘뿐이고(`js/usage-metrics.js`
직접 쓰기 · `logUsageMetric` Callable) 둘 다 예외 없이 `updatedAt: serverTimestamp()` 를
함께 찍는다 — 서버 시각이라 시계 뒤틀림도 없다. 그래서 생성 축의 한계가 없다.
오늘 문서는 하루 종일 값이 오르는데, 생성 축이었다면 첫날 이후로 영영 못 따라갔을 것이다.
삭제는 규칙에서 막혀 있다(`allow delete: if false`).

**Timestamp 는 눕혀서 담는다.** Firestore `Timestamp` 는 구조화 복제를 통과하며
프로토타입을 잃는다. `flattenForIdb` 가 `{__fsts: ms}` 로 바꿔 저장하고,
`rowToDocLike` 가 읽을 때 `.toDate()` 가 되는 물건으로 되살린다 — 덕분에 소비자
코드가 스냅숏을 다루던 모양(`d.id` · `d.data()`)을 그대로 쓴다.

### 미러 콘솔 (4단계)

관리자 > 모니터링 > **로컬 미러**. 상태(보유 건수·마지막 동기화·저장소 사용량),
미러별 「재구축 예약」, 백업 **내보내기/불러오기**.

백업은 다른 기기에서 부트스트랩을 되풀이하지 않으려고 있다.
**git 에는 절대 올리지 않는다** — 사용자 기록·프로필이 통째로 들어 있고, 저장소
히스토리에 한 번 들어가면 지우기 어렵다. 기기 사이에는 파일을 직접 건넨다.

### 사용자 관리 목록 (6단계)

목록 한 줄을 만들려고 사람마다 문서 세 건을 사 왔다 — 루트 `users` · `config/settings` ·
`meals` 건수 집계. 거기에 페이지마다 `sharedPhotos`·`boardPosts` `in` 쿼리와
`userBans`·`deleteUserRequests` 청크가 붙었다. **정렬·검색이 전체 목록을 요구하므로**
그 값이 전 사용자에 곱해졌다 — 사용자 N 명이면 3N 을 훌쩍 넘었다.

| 자리 | 예전 | 지금 |
|---|---|---|
| 프로필·약관·가입일 | `settings` × N `getDocFromServer` | users 미러 |
| 타임라인 건수 | **사용자마다 count 쿼리** | meals 미러의 uid 별 건수 |
| 공유 건수·아이콘 | `in` 쿼리 (30개씩) | sharedPhotos 미러 |
| 밀톡 건수 | `in` 쿼리 (30개씩) | boardPosts 미러 |
| 제재·탈퇴 요청 | 페이지마다 `in` 청크 | 컬렉션을 통째로 1회 |

`userBans` 와 `deleteUserRequests` 만 서버에 남는다. 둘 다 「해당되는 사람만 문서가
생기는」 작은 컬렉션이라, 통째로 한 번 읽는 편이 페이지마다 30개씩 쪼갠 `in` 쿼리보다
싸다. 못 읽어도 목록은 세운다 — 제재 표시가 빠질 뿐이고, 그 때문에 전체 목록을 못 보는
편이 더 나쁘다.

**폴백은 `users.js` 안에 그대로 남는다.** `fetchAllUsersFromServer()` 가 예전 페이지
파이프라인이고, 미러가 비었거나 실패하면 그리로 간다. 「사용자 분석」의 폴백
(`fetchAllUsersForAdminAnalytics`)은 **곧장 서버로 간다** — 이미 미러에 실패해서 온
참이라, 여기서 몰래 미러로 성공하면 화면의 「서버 전체 조회」 배지가 거짓말이 된다.

### 대시보드 (5단계)

전량 집계는 Firestore 읽기의 최대 소비자였다 — 1회 약 12.6K
(`firestore-read-audit-2026-08.md`). 값이 큰 순서로 갈아 끼웠다.

| 자리 | 예전 | 지금 |
|---|---|---|
| meals 전량 스캔 (식사 날짜 축) | 컬렉션그룹 getDocs ~12K | meals 미러 |
| meals 전량 스캔 (기록 시각 축) | 같은 크기로 한 번 더 | 같은 미러 행을 한 번 더 훑는다 |
| 슬롯별·전체 건수 | count 쿼리 × 슬롯수 | 미러에서 센다 |
| 「기록 있는 사람」 | **사용자 한 명당 count 쿼리 1회** | 미러의 uid 유니크 집합 |
| users 전량 조회 | getDocs(users) | users 미러 |
| 하루 소감 | `collectionGroup('config')` 전량 | users 미러의 `journal` 자국 |
| sharedPhotos 건수·기간 | count + 기간 getDocs | sharedPhotos 미러 |
| 제외 UID 차감 | UID 마다 count 쿼리 | 세는 자리에서 바로 거른다 |
| **페이지별** `usageDaily` | 전 구간(약 180) + 최근 7일 `getDocFromServer` 매번 | usageDaily 미러 |

남는 서버 읽기는 미러 **동기화 자체**와 캐시 문서 몇 건뿐이다.
새로고침 1회 기준 12.6K → 수십 건 수준.

**증분 병합이 필요 없어졌다.** 얼린 과거 주차·소급 delta 는 *서버 읽기가 비싸서* 만든
장치였고, 그 대가로 지난 주차의 수정·삭제와 제외 UID 변경을 놓쳤다. 로컬에서는 전량을
훑어도 비용이 없으므로 미러 모드는 **언제나 전량**이고, 그 구멍이 통째로 없어진다.
`dashboard-incremental.js` 는 미러를 못 쓸 때의 폴백 경로로만 남는다.

그래서 두 버튼의 뜻이 바뀌었다 — 이제 갈리는 것은 **미러를 얼마나 믿느냐**다.

| 버튼 | 하는 일 |
|---|---|
| 새로고침 | 미러 델타 동기화 → 전량 재계산 |
| 전체 재집계 | 미러를 통째로 다시 받고(`force`) → 전량 재계산 |

주간 정기 전량(`maybeStartWeeklyFullRefresh`)은 `forceMirror: false` 로 돈다. 사람이 누르지
않은 경로가 화면을 여는 순간 부트스트랩 1.2만 읽기를 부르면 미러로 없앤 비용이 그대로
돌아오기 때문이다. 미러 모드는 매번 전량이므로 어차피 도장(`lastFullAggregatedAt`)이
매번 찍혀 이 경로는 거의 돌지 않는다.

**폴백.** 미러 동기화가 실패하면(첫 실행 실패·인덱스 미배포·저장소 거부) 예전 서버
경로로 물러난다. 그때는 옛 규칙 그대로 — 기본이 증분, 「전체 재집계」가 전량이다.

### 모먼트 관리 목록 (7단계)

목록이 `collectionGroup(meals)` 를 120건씩 커서로 사 왔다. 페이지를 넘길수록 배치가
쌓이고, 첫 페이지마다 `getCountFromServer` 가 붙었다. 페이지 행의 공유 표시
(`ensureSharedKeysForFeedRows`)는 사용자별로 `entryId in [10개]` 쿼리를 돌려, 한 페이지에
여러 사용자가 섞이면 왕복이 그만큼 늘었다.

| 자리 | 예전 | 지금 |
|---|---|---|
| meals 스트림 | 커서 배치 120건씩 | meals 미러 전량 정렬 후 slice |
| meals 건수 | `getCountFromServer` | 미러 행 수 |
| 공유 표시 매칭 | 사용자별 `entryId in` 쿼리 | sharedPhotos 미러 인덱스 1회 |

**스트리밍 병합기가 미러 경로에는 없다.** `collectMergedModerationPageItems` 의 커서·버퍼·
조기 종료는 전부 「120건씩만 사 오려고」 있는 물건이다. 로컬에는 살 것이 없으니 전부
정렬해 잘라 내면 끝이다. 정렬 모드 강등 체인(`failed-precondition` → 1→2→3)도 마찬가지다 —
서버 인덱스가 없을 때의 이야기고, 로컬 정렬에는 인덱스가 없다.

덤으로 **더 정확하다.** 서버 경로는 배치마다 따로 정렬해 병합하므로 정렬 축이 쿼리의
`recordedAt`·`date` 인 반면, 목록이 실제로 쓰는 축은 `moderationRecordedAtMillis`
(하루소감을 따로 취급한다)다. 미러 경로는 그 축 하나로 줄을 세운다.

**관리자 조치를 미러에 즉시 반영해야 한다.** 이게 이 단계의 전제 조건이었다:

- 삭제(`adminDeleteFeedPostInternal`) → `applyLocalMealDelete`.
  평소 삭제는 툼스톤을 다음 동기화가 소비하는데, 그 사이에는 **방금 지운 기록이
  새로고침 직후 목록에 그대로 보인다.**
- 공유 취소·공유 금지·금지 해제(일괄) → `patchLocalMeal`.
  이쪽이 더 급하다. **관리자 쓰기는 `updatedAt` 을 찍지 않으므로 델타 쿼리에 영영
  걸리지 않고, meals 미러에는 주기적 전체 재구축도 없다.** 여기서 반영하지 않으면
  되살아나는 게 아니라 **처음부터 반영되지 않는다** — 배치는 성공했는데 목록은 그대로다.

## 왜 이렇게

- **Firestore 는 변경 로그를 주지 않는다.** oplog·이력 조회 API 가 없고,
  삭제된 문서는 흔적 없이 사라진다. 그래서 변경 피드를 자작한다:
  수정은 앱이 항상 찍는 `updatedAt`(`js/db/ops.js` §4.5), 삭제는 서버 트리거 툼스톤.
- **`updatedAt` 은 클라이언트 시계다.** 시계가 늦는 기기의 도장이 북마크보다
  과거일 수 있어, 항상 북마크에서 **48시간 겹쳐** 읽는다. 업서트는 멱등이라 무해.
  북마크 자체는 동기화 시작 시각으로 전진만 한다 (`nextBookmark`).
- **`updatedAt` 없는 옛 문서**는 델타에서 안 잡히지만, 부트스트랩이 이미 담았고
  이후 수정되는 순간 저장 경로가 도장을 찍으므로 새지 않는다.
- **date 없는 문서**는 미러에 안 담는다(date 인덱스 축) — `getMealDelta` 와 같은 취급.
- **미러 소실 = 재부트스트랩일 뿐.** 원본이 Firestore 라 유실이 없다.
  `navigator.storage.persist()` 로 자동 정리(eviction)만 막아 둔다.

## 파일

| 파일 | 역할 |
|---|---|
| `js/admin/admin-mirror-db.js` | IndexedDB 공용 핸들·스키마 버전·meta 입출력 |
| `js/admin/meals-mirror-model.js` | meals 순수 계산부 (node 테스트 대상) |
| `js/admin/meals-mirror.js` | `ensureMealsMirrorSynced` / `getMealsInRange` |
| `js/admin/users-mirror-model.js` | users 순수 계산부 — 파생 규칙의 **유일한** 출처 |
| `js/admin/users-mirror.js` | `ensureUsersMirrorSynced` / `getAllUsersFromMirror` |
| `js/admin/users-list-mirror.js` | 사용자 관리 목록을 네 미러에서 조립 |
| `js/admin/users-list-mirror-model.js` | 목록 조립의 셈법 (순수) |
| `js/admin/collection-mirror-model.js` | 범용 미러 순수 계산부 (Timestamp 눕히기·되살리기) |
| `js/admin/collection-mirror.js` | `createCollectionMirror` 와 네 개 인스턴스 |
| `js/admin/mirror-console.js` | 관리자 화면: 상태·즉시 구축·재구축·백업 |
| `js/admin/dashboard-mirror.js` | 대시보드가 쓸 재료를 세 미러에서 모아 온다 |
| `js/admin/dashboard-mirror-model.js` | 미러 행을 Firestore 스냅숏처럼 보이게 하는 어댑터 (순수) |
| `functions/index.js` `onMealWritten` | 삭제 시 툼스톤 기록 (early-return 앞) |
| `firestore.rules` | `adminMealTombstones` 읽기 admin 전용, 클라이언트 쓰기 금지 |
| `firestore.indexes.json` | meals `updatedAt` 컬렉션그룹 ASC fieldOverride |
| `test/*-mirror-model.test.mjs` (6개) | 모델 테스트 |

콘솔 수동 조작: `adminMealsMirrorStatus()` · `adminUsersMirrorStatus()` (상태),
`resetAdminMealsMirror()` · `resetAdminUsersMirror()` (재다운로드 예약).

## 소비자 (현재)

- **대시보드 트렌드·페이지별** (`js/admin/dashboard.js`): 새로고침·전체 재집계 모두 미러
  위에서 전량으로 센다. 미러 실패 시 예전 서버 경로(증분/전량)로 폴백.
- **모먼트 분석** (`js/admin/moment-analytics.js`): 실행 시 미러 동기화 →
  IDB 에서 기간 절단. 미러 실패 시 예전 서버 전량 스캔으로 폴백.
  요약 카드의 「Firestore 읽기」= 이번 동기화가 실제로 산 문서 수.
- **사용자 분석** (`js/admin/user-analytics.js`): users 미러에서 집계.
  실패 시 예전 `fetchAllUsersForAdminAnalytics()` 로 폴백(배지가 「서버 전체 조회」로 바뀐다).
  패널 아래 「전체 새로 읽기」가 강제 재구축.
- **모먼트 관리** (`js/admin/feed-moderation.js`): 목록 전체가 미러 위에서 돈다 —
  meals 스트림·건수·공유 표시 매칭에 더해, 예전에 옮긴 세 경로(하루기록 고아 목록 ·
  특수 공유 목록 · 특수 공유 건수)까지. 남은 서버 읽기는 개별 문서 조작과 신고 집계다.
  미러 실패 시 예전 커서 페이지네이션으로 폴백.
- **사용자 관리 목록** (`js/admin/users.js`): 전체 목록을 users·meals·sharedPhotos·
  boardPosts 미러에서 조립. 서버 읽기는 `userBans`·`deleteUserRequests` 뿐.
  미러가 비었거나 실패하면 예전 페이지 파이프라인으로 폴백.
- **AI 식단분석** (`js/admin/ai-diet-reports.js`): 목록·7일 사용량 모두 미러.
  미러 모드에서는 커서 대신 오프셋으로 페이지를 자른다.
- **밀톡 관리** (`lounge-chat-moderation.js`) · **게시판 관리** (`board-moderation.js`):
  목록·건수를 미러에서. 원래도 한 화면 50건 남짓이라 절감폭은 작다 — 같은 틀로
  묶어 두는 편이 나아서 함께 옮겼다. 반응 수(하위 컬렉션)와 신고 집계는 그대로 서버.

## 배포 체크리스트

```
firebase deploy --only firestore:indexes   # meals.updatedAt CG 인덱스 (빌드 수 분)
firebase deploy --only firestore:rules
firebase deploy --only functions:onMealWritten
```

인덱스 빌드가 끝나기 전에는 델타 쿼리가 `failed-precondition` 으로 떨어지고,
그동안은 서버 스캔 폴백으로 동작한다.

## 남은 구멍 (알고 두는 것)

- **users**: 로그인 없이 프로필만 고친 경우 `lastLoginAt` 이 안 움직여 델타에서 빠진다.
  48시간 겹침 창과 7일 전체 재구축이 흡수한다.
- **users**: 탈퇴와 신규 가입이 같은 주기에 같은 수만큼 일어나면 카운트가 같아 삭제를
  못 알아챈다. 역시 7일 재구축이 정리한다.
- **meals**: `updatedAt` 은 클라이언트 시계다 — 위와 같은 이유로 48시간 겹쳐 읽는다.
- **meals**: 미러에는 주기적 전체 재구축이 없다(부트스트랩 1회 + 델타·툼스톤). 그래서
  `updatedAt` 을 찍지 않는 쓰기는 영영 따라잡지 못한다 — 관리자 조치가 그렇다.
  그런 쓰기는 반드시 `patchLocalMeal` / `applyLocalMealDelete` 로 그 자리에서 반영한다.
  의심스러우면 미러 콘솔의 「재구축 예약」이 마지막 수단이다.
- **대시보드**: 「기록 · 전체」가 이제 미러 건수다. `date` 없는 meals 문서는 미러에 담기지
  않으므로(기간 축에 태울 수 없다) 서버 count 보다 그만큼 적을 수 있다. 대신 표 안의
  합계와 「전체」가 **같은 출처**라 서로 어긋나지 않는다 — 예전에는 서버 count 와 스캔 합계가
  다른 축이었다.
- **범용 미러**: 사용자가 남의 화면에서 고친 값(좋아요·댓글 수 등)은 생성 축에 안 걸려
  최대 7일 묵을 수 있다. 관리·모더레이션 판단에 쓰는 값(본문·작성자·숨김)은 관리자
  조치가 곧바로 반영하므로 실무상 문제되지 않는다. 급하면 「재구축 예약」.

## 다음 단계 (예정)

- 화면 로드 시 도는 페이지별 보정(`fetchPageUsageWeeklyRepairFromUsageDaily`)도 미러로.
  캐시가 성하면 안 도는 길이라 급하진 않다.
- **신고 집계**(`postReports`)는 최상위 컬렉션이고 서버 함수만 쓰며 `reportedAt`
  서버 시각을 찍는다 — `createCollectionMirror` 한 줄이면 붙는다. 다만 이미 TTL 캐시
  뒤에 있고 문서 수도 적어 절감액이 거의 없다. **쉽다는 이유만으로 코드를 늘릴 자리가
  아니라서** 보류.
- **반응 수**는 진짜 하위 컬렉션이다(`feedPosts/{id}/reactions`). 게시물 하나당
  `getDocs` 를 한 번씩 던지는데, 지금 범용 미러 틀은 컬렉션 **이름 하나로 경로가
  완성되는** 최상위 전용이라 담을 수 없다(그래서 meals 도 전용 파일로 따로 있다).
  게다가 관리자 전용이 아니다 — 사용자 밀톡 화면도 같은 함수를 쓴다. 손대려면 미러가
  아니라 서버에서 카운터 필드를 유지하는 쪽이 맞고, 그건 별개의 데이터 모델 변경이다.
- 툼스톤 청소: 양이 미미해 방치. 거슬리면 Firestore TTL 정책(만료 필드) 추가
