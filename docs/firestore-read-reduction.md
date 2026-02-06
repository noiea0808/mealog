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
