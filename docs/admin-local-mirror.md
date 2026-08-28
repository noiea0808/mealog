# 관리자 로컬 미러 — 관리자 화면이 읽는 데이터의 브라우저 사본 (1~4단계)

관리자 화면들이 방문할 때마다 Firestore 를 전량 스캔하던 비용
(`firestore-read-audit-2026-08.md` 의 12~25K 스파이크)을 없애기 위한 구조.
관리자는 1인·고정 환경이므로, **데이터 사본을 관리자 브라우저 IndexedDB 에 두고
변경분만 따라간다.**

## 구조

```
관리자 브라우저 (IndexedDB: mealog-admin-mirror, v3)
  meals 스토어         키 `${userId}/${mealId}` · date 인덱스
  users 스토어         키 userId · 「사용자 분석」이 쓰는 필드만
  sharedPhotos 스토어  ┐
  aiDietReports 스토어 │ 범용 컬렉션 미러 — 키 id · _sortMs 인덱스
  feedPosts 스토어     │
  boardPosts 스토어    ┘
  meta 스토어          스토어별 lastSyncedAt 북마크·bootstrapDone·docCount

Firestore (기존 그대로 + 1개 추가)
  adminMealTombstones/{userId}_{mealId}   ← onMealWritten 이 삭제 시 남기는 흔적
```

스키마 버전은 `admin-mirror-db.js` 한 곳에서만 올린다 — 두 모듈이 서로 다른
버전으로 `indexedDB.open` 하면 충돌한다.

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

### 범용 컬렉션 미러 (3단계)

`sharedPhotos` · `aiDietReports` · `feedPosts` · `boardPosts` 는 한 틀
(`collection-mirror.js`)로 담는다. meals·users 만큼 특수하지 않아서다.

**축이 「생성 시각」인 이유.** meals 는 앱이 모든 저장 경로에서 `updatedAt` 을 찍어
주지만, 이 컬렉션들은 클라이언트·Functions 십수 곳에서 제각각 쓰인다(좋아요·댓글·
신고·관리자 조치…). 공통 도장이 없으니 「수정」을 축으로 삼을 수 없다. 그래서
생성 축(`timestamp` / `generatedAt`)으로 **새 문서만** 따라가고 나머지는 이렇게 메운다:

- 관리자 조치(숨김·삭제)는 **본인이 하는 쓰기**라 그 자리에서 미러에 반영
  (`patchLocal` / `applyLocalDelete`) — 되읽지 않는다.
- 사용자 쪽 수정·삭제는 문서 수 감시(줄면 전체 재구축)와 7일 주기 재구축이 정리한다.
- `aiDietReports` 는 생성 뒤 바뀌지 않아 이 한계가 아예 없다(진짜 append-only).

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
| `js/admin/collection-mirror-model.js` | 범용 미러 순수 계산부 (Timestamp 눕히기·되살리기) |
| `js/admin/collection-mirror.js` | `createCollectionMirror` 와 네 개 인스턴스 |
| `js/admin/mirror-console.js` | 관리자 화면: 상태·재구축·백업 |
| `functions/index.js` `onMealWritten` | 삭제 시 툼스톤 기록 (early-return 앞) |
| `firestore.rules` | `adminMealTombstones` 읽기 admin 전용, 클라이언트 쓰기 금지 |
| `firestore.indexes.json` | meals `updatedAt` 컬렉션그룹 ASC fieldOverride |
| `test/*-mirror-model.test.mjs` (3개) | 모델 테스트 |

콘솔 수동 조작: `adminMealsMirrorStatus()` · `adminUsersMirrorStatus()` (상태),
`resetAdminMealsMirror()` · `resetAdminUsersMirror()` (재다운로드 예약).

## 소비자 (현재)

- **모먼트 분석** (`js/admin/moment-analytics.js`): 실행 시 미러 동기화 →
  IDB 에서 기간 절단. 미러 실패 시 예전 서버 전량 스캔으로 폴백.
  요약 카드의 「Firestore 읽기」= 이번 동기화가 실제로 산 문서 수.
- **사용자 분석** (`js/admin/user-analytics.js`): users 미러에서 집계.
  실패 시 예전 `fetchAllUsersForAdminAnalytics()` 로 폴백(배지가 「서버 전체 조회」로 바뀐다).
  패널 아래 「전체 새로 읽기」가 강제 재구축.
- **모먼트 관리** (`js/admin/feed-moderation.js`): sharedPhotos 를 훑던 **세 경로**만
  미러로 옮겼다 — 하루기록 고아 목록(최대 800) · 특수 공유 목록(최대 500 + 보강 1,200) ·
  특수 공유 건수. 나머지(개별 문서 조작·meals CG 페이지·신고 집계)는 그대로 Firestore 다.
  파일이 3천 줄이 넘고 폴백 체인이 얽혀 있어, 값이 큰 읽기만 골라 옮겼다.
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
- **범용 미러**: 사용자가 남의 화면에서 고친 값(좋아요·댓글 수 등)은 생성 축에 안 걸려
  최대 7일 묵을 수 있다. 관리·모더레이션 판단에 쓰는 값(본문·작성자·숨김)은 관리자
  조치가 곧바로 반영하므로 실무상 문제되지 않는다. 급하면 「재구축 예약」.

## 다음 단계 (예정)

- 대시보드 주간 전량 재집계를 미러 기반으로 → 12.6K 소멸 (config 미러가 더 필요)
- 사용자 **관리** 탭(목록)도 미러로: 지금은 여전히 페이지마다 서버를 읽는다.
  공유·게시글 수는 이제 sharedPhotos·boardPosts 미러로 셀 수 있고, 식사 수는 meals
  미러로 셀 수 있으니 재료는 갖춰졌다.
- 모먼트 관리의 meals 컬렉션그룹 페이지네이션도 meals 미러로 (지금은 서버 조회)
- 툼스톤 청소: 양이 미미해 방치. 거슬리면 Firestore TTL 정책(만료 필드) 추가
