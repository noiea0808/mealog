# sharedPhotos 모먼트 미표시 진단 가이드

## 1. 인덱스(Index) 점검

### 현재 쿼리와 필요 인덱스

| 함수 | 쿼리 조건 | 필요 인덱스 |
|------|-----------|-------------|
| `loadSharedPhotosPage` | `orderBy('timestamp', 'desc')` | 단일 필드 (자동 생성) |
| `loadMyShares` | `where('userId','==',uid)` + `orderBy('timestamp','desc')` | **(userId ASC, timestamp DESC)** |
| `getSharedPhotosByUser` | 동일 | **(userId ASC, timestamp DESC)** |

### firestore.indexes.json 확인
- `sharedPhotos`에 `(userId ASC, timestamp DESC)` 복합 인덱스 **이미 정의됨** (10번째 항목)

### 인덱스 미배포 시
- 콘솔(F12)에 `failed-precondition` 또는 `The query requires an index` 에러가 뜨면
- 에러 메시지에 **인덱스 생성 링크**가 포함됨 → 클릭해서 Firebase Console에서 인덱스 생성
- 또는 `firebase deploy --only firestore:indexes` 실행

### isShared 필드
- **사용하지 않음**. sharedPhotos 컬렉션의 각 문서가 곧 "공유된 사진"임.

---

## 2. getDocsFromServer vs getDocsFromCache

### 현재 상태
- `loadSharedPhotosPage`, `loadMyShares`, `getSharedPhotosByUser` **모두 `getDocsFromServer` 사용**
- `getDocsFromCache`는 sharedPhotos 관련 코드에서 **사용하지 않음**
- 실시간 공유 피드는 항상 서버에서 조회함

---

## 3. 데이터 구조 (Flat)

### 컬렉션 경로
```
artifacts / {appId} / sharedPhotos / {docId}
```
- appId: `mealog-r0`
- 전체 경로: `artifacts/mealog-r0/sharedPhotos`

### 문서 구조 (Cloud Function sharePhotos가 작성)
```javascript
{
  photoUrl: "https://...",      // Storage URL (문자열)
  photoIndex: 0,
  userId: "xxx",
  userNickname: "닉네임",
  userIcon: "🐻",
  userPhotoUrl: null,
  mealType: "",
  place: "",
  menuDetail: "",
  snackType: "",
  date: "2025-02-25",
  slotId: "lunch",
  time: "12:30",
  timestamp: Timestamp,
  entryId: "b69XbeFQwsaR8J3MjLFD"  // meal 문서 ID
}
```

### 확인 사항
- **photoUrl**: 실제 이미지 URL (문서 ID 아님)
- **entryId**: meal 문서 ID (users/{uid}/meals/{entryId})
- 별도 `shared_pool` 등 다른 컬렉션 없음 — Flat 구조

---

## 4. 콘솔에서 진단 실행

메인 앱(index.html) 로그인 후 F12 콘솔에서:

```javascript
// 1. sharedPhotos 컬렉션 샘플 + 특정 entryId 확인 (권장)
Mealog.debugSharedPhotos();                           // 샘플 5건만
Mealog.debugSharedPhotos('b69XbeFQwsaR8J3MjLFD');    // 해당 entryId 포함 여부

// 2. 모먼트 동기화 (공유는 됐는데 모먼트에 안 보일 때)
Mealog.syncEntriesToMomentBatch(['b69XbeFQwsaR8J3MjLFD', 'xmkdo3Yk6Anfmb6y64VY', 'IWzPTGjyIcs3gzeTHHu3']);
```
