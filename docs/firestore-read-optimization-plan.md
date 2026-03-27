# Firestore 읽기 최적화 방안

## ✅ 적용 완료: 공유 사진 페이지네이션 (2025-02)

- **loadSharedPhotosPage(10)**: 갤러리/피드 첫 페이지 10건만 로드
- **loadMyShares()**: 타임라인 공유 표시용 본인 공유만 조회
- **sharedPhotos onSnapshot 제거**: 로그인 시 50건 구독 → 탭 진입 시 getDocs로 전환
- **더보기 버튼**: 스크롤 시 10건씩 추가 로드
- **당겨서 새로고침**: 갤러리 상단에서 당기면 최신 데이터 로드
- **탭 진입 시 로드**: 갤러리 탭 전환 시마다 최신 데이터 로드 (과거/업데이트 반영)

**필요 인덱스**: `sharedPhotos` 컬렉션에 `(userId ASC, timestamp DESC)` 복합 인덱스 (getSharedPhotosByUser와 동일)

---

**현재 소스 기준:** `sharedPhotos`에 **onSnapshot 전역 구독은 없음** (`setupSharedPhotosListener` 삭제됨). 모먼트는 `loadSharedPhotosPage`, 타임라인 본인 공유는 `loadMyShares` 등 **필요 시 getDocs**. 아래 §1은 과거 설계 메모이며, **“지연 구독” 대신 구독 자체를 제거한 상태**에 가깝다.

---

## 1. sharedPhotos (과거 이슈 메모) — 지연 구독안 ⭐ 당시 최우선

### 과거 현황 (구독이 있던 시절)
- **로그인 시 즉시** `setupSharedPhotosListener` 호출 → 모든 탭에서 50 doc 구독
- 공유 1건 추가 시 → **활성 사용자 수 × 50 reads**
- 모먼트 탭을 거의 안 봐도 리스너는 항상 동작

### 방안: 탭 진입 시에만 구독, 이탈 시 해제

| 탭 | sharedPhotos 사용처 | 구독 시점 |
|----|---------------------|-----------|
| timeline | 공유 화살표 표시 | timeline 탭 진입 시 |
| gallery | 모먼트 피드 | gallery 탭 진입 시 |
| feed | 피드 콘텐츠 | feed 탭 진입 시 |

**당시 제안 구현 (참고용):**
- `switchMainTab`에서 특정 탭일 때만 `setupSharedPhotosListener` 시작
- 이탈 시 구독 해제
- timeline은 공유 화살표가 있어 항상 필요할 수 있음 → **gallery + feed만 지연 구독**으로 축소 가능
  - timeline: 공유 화살표는 `window.sharedPhotos` 사용. 초기에는 빈 배열, gallery/feed 진입 후 로드된 데이터 재사용
  - **최소안**: gallery, feed 탭 진입 시에만 구독. timeline 공유 화살표는 `getSharedPhotosByUser` 등 필요 시 1회 getDocs로 대체

**예상 효과:** 활성 100명 중 gallery/feed 보는 5명만 구독 시 → 50 × 5 = 250 reads (기존 5,000 대비 **95% 감소**)

---

## 2. sharedPhotos: 탭별 구독 범위 분리 (선택)

### 방안
- **timeline**: 공유 화살표용 → 본인 식사에 연결된 공유만 필요. `where('userId', '==', uid)` 또는 entryId 기반 쿼리
- **gallery/feed**: 전체 피드 → `orderBy('timestamp', 'desc'), limit(50)` 유지

timeline 공유 화살표는 `meals` 데이터의 `sharedPhotos` 필드나 별도 소량 쿼리로 충당 가능하면, sharedPhotos 전체 50 doc 구독 불필요.

---

## 3. meals 리스너: 기간·limit 조정

### 현황
- 최근 7일 `where('date', '>=', cutoffDateStr)` 쿼리
- 7일치 식사가 많으면(예: 50건) 스냅샷마다 50 reads

### 방안
- **limit(100)** 추가: 7일 내 문서가 100개 넘어도 100개만 반환. 나머지는 `loadMoreMeals`로 로드
- 또는 기간을 **5일**로 축소 (스크롤 시 loadMore로 확장)

**예상 효과:** 과다 기록 사용자에서 reads 20~30% 감소

---

## 4. board(밀톡): 캐시 + 탭 전환 시 1회 로드

### 현황
- `setupBoardListener` 미사용. `renderBoard` 시마다 `getPosts`(50) + likes + bookmarks + comments getDocs
- 밀톡 탭 열 때마다 매번 50+ reads

### 방안
- **탭 진입 시 1회만** getPosts. 이후 `window._boardPostsCache` 사용
- 캐시 TTL: 60초~5분. 만료 시 재요청
- 새 글 작성/삭제 시에만 캐시 무효화 후 재요청

**예상 효과:** 밀톡 탭 여러 번 열어도 reads 1회분으로 제한

---

## 5. loadMealsForDateRange / loadStatsForYears: 중복 요청 방지

### 현황
- `loadMealsForDateRange`에 이미 `window.loadedMealsDateRange` 체크로 중복 방지 있음
- `loadStatsForYears`는 연도별 1 doc이라 부담 적음

### 방안
- `loadStatsForYears` 결과를 `window.dailyStats`에 병합 후, 동일 연도 재요청 시 스킵

---

## 6. fetchUserProfiles: 프로필 캐시 강화

### 현황
- 피드/밀톡 렌더 시 작성자 프로필 조회
- `userProfileCache` 존재 여부 확인 필요

### 방안
- 프로필 캐시 TTL 연장 (예: 30분)
- 동일 세션 내 중복 fetch 방지

---

## 구현 우선순위

| 순위 | 항목 | 난이도 | 예상 효과 |
|------|------|--------|-----------|
| 1 | sharedPhotos 지연 구독 | 중 | **매우 큼** |
| 2 | board 캐시 | 하 | 중간 |
| 3 | meals limit 추가 | 하 | 소~중간 |
| 4 | timeline 공유 화살표 최적화 | 중 | 중간 |

---

## 1번(sharedPhotos 지연 구독) 구현 시 주의사항

- **timeline 공유 화살표**: `updateTimelineShareIndicators`가 `window.sharedPhotos` 사용
  - gallery/feed 진입 전에는 `window.sharedPhotos = []` → 화살표 미표시
  - timeline 먼저 보는 사용자: 공유 화살표가 나중에 채워질 수 있음
  - **대안**: timeline 진입 시 sharedPhotos 1회 getDocs (limit 50)로 초기 로드. 리스너는 gallery/feed에서만 사용
- **feed**: feed 탭이 gallery와 별도인지, 같은 데이터 소스인지 확인 필요
