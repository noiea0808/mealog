# '무엇을' 형태 축 — 파일럿과 운영 전환 절차

작성: 2026-08-14 · 브랜치 `test`

설계는 [food-category-auto-classification.md](food-category-auto-classification.md) §6.2,
축 정의는 [entry-axes-and-tags-direction.md](entry-axes-and-tags-direction.md) §5에 있다.
이 문서는 **"언제 무엇을 눌러야 운영에 반영되는가"** 하나만 다룬다.

## 0. 왜 이런 장치가 필요한가

운영·staging·test가 **같은 Firebase 프로젝트**(`mealog-r0`)와 **같은 `appId`**를 쓴다
([.firebaserc](../.firebaserc), [js/firebase.js](../js/firebase.js) `appId`). 축을 실제로
정하는 관리자 태그 문서 `artifacts/mealog-r0/content/defaultTags` 도 **전역에 하나**다.

그래서 축은 브랜치로 갈리지 않는다:

- 관리자 화면에서 형태 축을 저장하면 → **그 순간 전 사용자 칩이 바뀐다.**
- 저장하지 않으면 → **test 브랜치에서도 옛 축 칩만 보인다** (코드 기본값이 문서에 덮인다).

계정 단위 스위치를 하나 끼워 이 사이를 만든 것이 **형태 축 파일럿**이다.

## 1. 지금 상태

| 항목 | 상태 |
|---|---|
| 클라이언트 코드 (형태 축 통합, 사전, 분류기) | 완료 (`test` 브랜치) |
| `content/defaultTags` | **옛 축 그대로** — 운영 사용자에게 변화 없음 |
| `functions/` (classifyMoments 축 통일, mealStats `categoryAuto` 집계) | **미배포** |
| 파일럿 게이트 | 있음. `formAxisPilotUids` 가 비어 있으면 전원 옛 축 |

## 2. 파일럿 켜기 (내 계정만 새 축)

1. 관리자 화면 → **태그** → '무엇을' 카드 맨 아래 **형태 축 파일럿 계정**
2. **내 uid 추가** → **저장**
   - 이때 위쪽 '무엇을' 목록은 **옛 축 그대로 두는 것이 핵심이다.** 목록을 형태 축으로
     바꿔 저장하면 파일럿이 아니라 전체 전환이 된다.
3. 앱을 **완전히 새로 로드**한다. 관리자 태그는 세션당 1회만 읽으므로
   ([firestore-read-reduction.md](firestore-read-reduction.md)) 새로고침 전에는 반영되지 않는다.

파일럿 계정에서 달라지는 것:

- '무엇을' 칩이 코드의 형태 축 14개(밥류·국물요리…)로 뜬다.
- 분석에서 옛 요리 종류 값(한식·양식·일식·중식·분식·카페)을 **무시하고** 그 기록의
  `categoryAuto` → 없으면 `menuDetail` 재분류 결과로 대체한다.

파일럿이 아닌 사용자는 **모든 경로에서 이전과 완전히 동일**하다.

### 파일럿에서 예상되는 표시

- 상세 텍스트가 없는 옛 '한식' 기록은 재분류할 근거가 없어 원문이 남고, 형태 축
  화이트리스트 밖이라 차트에서 **'미입력'으로 접힌다.** 파일럿 계정에는 옛 축 칩 자체가
  없으므로 이게 일관된 표시다. (전체 전환 후에도 같다.)
- 서브태그는 `parent`가 옛 칩이어도 사라지지 않는다 — `renderSecondary`의 고아 폴백
  (food-category-auto-classification.md §6.2.1).

## 3. 운영 전환 (전원 새 축) — 순서를 지킬 것

**같은 날 한 번에** 처리해야 한다. 순서가 어긋나면 "칩은 새 축인데 통계는 옛 축"이나
그 반대가 며칠씩 남는다.

1. **`functions/` 배포** — `classifyMoments`(자동 분류 enum), `mealStats`(집계).
   서버가 옛 축으로 backfill 하는 동안 클라이언트가 새 축을 쓰면 한 필드에 두 축이 섞인다.
2. **호스팅 배포** — 이 브랜치의 클라이언트 코드.
3. **관리자 화면 → 태그**:
   - '무엇을' → **형태 축 불러오기**
   - **형태 축 파일럿 계정 칸을 비운다** (파일럿과 전체 전환이 겹치면 안 된다)
   - **저장** ← **이 순간부터 전 사용자에게 반영된다**
4. 다음 배포 때 임시 코드 제거 (§4).

되돌리려면: 관리자 태그에서 '무엇을' 목록을 옛 축으로 되돌려 저장한다. 저장된 기록 원문은
어느 단계에서도 바뀌지 않으므로(읽기 정규화만 한다) 데이터 롤백은 필요 없다.

## 4. 전환 후 지울 임시 코드

파일럿 장치는 전환 즉시 죽은 코드가 된다. 세 곳을 함께 지운다:

- [js/utils/form-axis-pilot.js](../js/utils/form-axis-pilot.js) — 파일 통째로
- [js/db/listeners.js](../js/db/listeners.js) `applyAdminTags` 의 `isFormAxisPilot()` 분기
  (관리자 값을 그대로 쓰는 쪽만 남긴다)
- [js/analytics/meal-analytics-tags.js](../js/analytics/meal-analytics-tags.js)
  `resolveFoodFormValue` 의 `isFormAxisPilot()` 조건
  → **재분류 자체는 남긴다.** 전환 후에는 전 사용자에게 필요한 동작이다
- [js/admin/tags.js](../js/admin/tags.js) 의 '형태 축 파일럿' 블록과
  [admin.html](../admin.html) 의 편집란, 저장 데이터의 `formAxisPilotUids`

## 5. 아직 정하지 않은 것

- **'기타'도 재분류할지.** 지금은 옛 요리 종류 축 6개만 대상이고 `'기타'`는 건드리지 않는다
  — 사용자가 직접 고른 값일 수 있어 "user가 최종" 원칙과 부딪힌다. 다만 개편 전 데이터의
  61%가 '기타'라 재분류 이득이 가장 큰 자리이기도 하다. 파일럿에서 체감해 보고 정한다.
- **서버 집계 동기화.** [functions/mealStats.js](../functions/mealStats.js)는 "클라이언트
  차트와 같은 규칙"이라고 적고 있지만 재분류가 없다. 파일럿 동안에는 차이가 한 계정에만
  생기고, 전체 전환 후에는 클라이언트 차트와 서버 집계 숫자가 갈릴 수 있다.
- **사전 데이터**: 떡볶이가 `면류`에 있다(`튀김·분식`이 따로 있는데도), 아이스크림 제품명
  계열이 얇다.
