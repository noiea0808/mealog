# '무엇을' 형태 축 — 운영 전환 완료 기록

작성: 2026-08-14 · **전환 완료: 2026-08-27** (파일럿 장치 제거)

설계는 [food-category-auto-classification.md](food-category-auto-classification.md) §6.2,
축 정의는 [entry-axes-and-tags-direction.md](entry-axes-and-tags-direction.md) §5에 있다.
이 문서는 전환이 **어떻게 끝났고 무엇이 남았는가**를 남긴다.

## 0. 왜 파일럿 장치가 필요했나

운영·staging·test가 **같은 Firebase 프로젝트**(`mealog-r0`)와 **같은 `appId`**를 쓴다
([.firebaserc](../.firebaserc), [js/firebase.js](../js/firebase.js)). 축을 실제로 정하는
관리자 태그 문서 `artifacts/mealog-r0/content/defaultTags` 도 **전역에 하나**다.

그래서 축은 브랜치로 갈리지 않았다 — 저장하면 전 사용자 칩이 그 순간 바뀌고, 저장하지
않으면 test 브랜치에서도 옛 축만 보였다. 그 사이를 메우려고 계정 단위 스위치
(`formAxisPilotUids`)를 2026-08-14 에 끼웠고, 2026-08-27 전환과 함께 걷어냈다.

## 1. 전환 순서 (실제로 밟은 것)

1. **`functions/` 배포** — `classifyUncategorizedMeals` · `adminClassifyLegacyMeals` 를
   형태 축으로 재배포 (2026-08-13, `ef1ee2c`).
2. **클라이언트 배포** — `2770d32` 가 `main`(웹)·`staging`(APK) 양쪽에 반영.
3. **관리자 화면 → 태그** (2026-08-27 14:26 UTC):
   '무엇을' 을 형태 축으로 저장하고 **파일럿 칸을 비웠다**.
   `category` 와 `snackType` 에 같은 값이 들어갔다.
4. **임시 코드 제거** — §3.

저장된 '무엇을' 목록은 코드의 `FORM_CATEGORIES` 15개에 **`영양제/약` 이 하나 더** 붙은
16개다. 이 값은 코드 어디에도 없다 — 사전([food-dictionary.js](../js/utils/food-dictionary.js))
에 없으므로 **자동 분류가 이 칩을 고르는 일은 없고**, 사용자가 직접 골랐을 때만 남는다.
차트 화이트리스트는 `userSettings.tags.category` 합집합이라 '미입력' 으로 접히지는 않는다.

## 2. 전환으로 달라진 것

- '무엇을' 칩이 형태 축 하나다 (끼니·간식 공통, 카드도 하나).
- 옛 요리 종류 축 값(한식·양식·일식·중식·분식·카페)은 **읽을 때 재분류**된다:
  `categoryAuto` → 없으면 `menuDetail` 재분류
  ([meal-analytics-tags.js](../js/analytics/meal-analytics-tags.js) `resolveFoodFormValue`).
  이 재분류는 파일럿 전용이었는데, 전환 후에는 **전 사용자에게 필요한 동작**이 됐다 —
  없으면 지난 기록이 통째로 차트에서 '미입력' 으로 접힌다.
- 상세 텍스트가 없는 옛 '한식' 기록은 재분류할 근거가 없어 '미입력' 으로 접힌다.
  원문은 어느 단계에서도 바뀌지 않는다 (읽기 정규화만 한다).
- 최근 서브태그는 `subTags.menu` 한 곳에만 쌓인다.

되돌리려면 관리자 태그에서 '무엇을' 목록을 옛 축으로 되돌려 저장한다. 저장된 기록 원문은
건드리지 않았으므로 데이터 롤백은 필요 없다.

## 3. 제거한 임시 코드 (2026-08-27)

- `js/utils/form-axis-pilot.js` — 파일 삭제
- `js/utils/food-axis-subtags.js` 와 `test/food-axis-subtags.test.mjs` — 파일 삭제
- [js/db/listeners.js](../js/db/listeners.js) `applyAdminTags` 의 파일럿 분기
- [js/analytics/meal-analytics-tags.js](../js/analytics/meal-analytics-tags.js)
  `resolveFoodFormValue` 의 게이트 (**재분류 자체는 남겼다**)
- [js/admin/tags.js](../js/admin/tags.js) 의 파일럿 블록과 [admin.html](../admin.html) 편집란,
  저장 데이터의 `formAxisPilotUids`
- [js/modals/entry-save-subtags.js](../js/modals/entry-save-subtags.js) — 통합 경로만 남기고
  `subTags.snack` 쓰기 제거

관리자 화면의 **'형태 축 불러오기'** 버튼은 남겼다 — '무엇을' 목록을 코드 기본값으로
되돌리는 용도로 계속 쓴다.

## 4. 남은 것

- **`subTags.snack` 잔여 값과 `favoriteSubTags`.** 이제 읽는 쪽도 쓰는 쪽도 없다.
  사용자 설정 문서에서 지우는 것은 데이터 마이그레이션이라 따로 다룬다.
- **서버 집계 동기화.** [functions/mealStats.js](../functions/mealStats.js) 는
  `category || categoryAuto` 를 그대로 세고 재분류를 하지 않는다. 클라이언트 차트는
  옛 요리 종류 값을 재분류하므로 **관리자 통계와 숫자가 갈릴 수 있다.**
- **'기타' 재분류 여부.** 지금은 옛 요리 종류 축 6개만 대상이고 `'기타'` 는 건드리지 않는다
  — 사용자가 직접 고른 값일 수 있어 "user가 최종" 원칙과 부딪힌다. 다만 개편 전 데이터의
  61%가 '기타'라 재분류 이득이 가장 큰 자리이기도 하다.
- **사전 데이터**: 떡볶이가 `면류` 에 있다(`튀김·분식` 이 따로 있는데도), 아이스크림 제품명
  계열이 얇다.
