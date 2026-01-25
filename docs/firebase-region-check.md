# Firebase 리전 설정 확인 및 정리

## 현재 리전 설정 현황

### ✅ Functions 리전
- **코드 설정**: `us-central1` ✅
  - `functions/index.js`: `const REGION = 'us-central1'`
  - 모든 Callable Functions: `onCall({ region: REGION }, ...)`
- **클라이언트 설정**: `us-central1` ✅
  - `js/firebase.js`: `getFunctions(app, 'us-central1')`
- **배포 상태**: `us-central1` (실제 배포된 리전)

**결론**: Functions 리전은 `us-central1`로 통일되어 있습니다. ✅

### Firestore 리전
- **설정**: 명시적 리전 설정 없음 (기본값 사용)
- **기본 동작**: 
  - Firestore는 기본적으로 **multi-region** (nam5) 또는 프로젝트 생성 시 설정한 리전 사용
  - 리전 설정이 없으면 자동으로 최적의 리전 선택
- **확인 필요**: Firebase Console에서 실제 리전 확인
  - https://console.firebase.google.com/project/mealog-r0/firestore/settings

**권장**: Firestore는 리전 설정이 없어도 문제없습니다. (기본 multi-region)

### Storage 리전
- **설정**: 명시적 리전 설정 없음 (기본값 사용)
- **기본 동작**: 
  - Storage는 프로젝트 생성 시 설정한 리전 사용
  - 보통 `us-central1` 또는 App Engine과 같은 리전
- **확인 필요**: Firebase Console에서 실제 리전 확인
  - https://console.firebase.google.com/project/mealog-r0/storage/settings

**권장**: Storage는 기본 리전을 사용하므로 문제없습니다.

### App Engine 리전
- **설정**: Functions 활성화 시 자동 생성
- **확인 필요**: Google Cloud Console에서 확인
  - https://console.cloud.google.com/appengine?project=mealog-r0

## 리전 통일 권장사항

### 현재 상태
- ✅ Functions: `us-central1` (통일됨)
- ⚠️ Firestore: 기본값 (확인 필요)
- ⚠️ Storage: 기본값 (확인 필요)
- ⚠️ App Engine: 확인 필요

### 권장 설정

**옵션 1: 모두 us-central1로 통일 (권장)**
- Functions: `us-central1` ✅ (이미 설정됨)
- Firestore: 기본값 유지 (multi-region이면 문제없음)
- Storage: 기본값 유지 (보통 us-central1)
- App Engine: `us-central1` (Functions와 같은 리전)

**옵션 2: 모두 asia-northeast3 (서울)로 변경**
- 장점: 한국 사용자에게 더 빠른 응답
- 단점: 기존 리소스 재배포 필요

## 확인 방법

### 1. Firebase Console에서 확인
1. **Functions 리전**
   - https://console.firebase.google.com/project/mealog-r0/functions
   - 각 함수의 리전 확인

2. **Firestore 리전**
   - https://console.firebase.google.com/project/mealog-r0/firestore/settings
   - "Database location" 확인

3. **Storage 리전**
   - https://console.firebase.google.com/project/mealog-r0/storage/settings
   - "Location" 확인

### 2. Google Cloud Console에서 확인
- https://console.cloud.google.com/appengine?project=mealog-r0
- App Engine 리전 확인

## 문제 해결

### 리전 불일치로 인한 문제
- **CORS 오류**: Functions 리전과 클라이언트 리전이 다를 때 발생
- **해결**: 클라이언트에서 `getFunctions(app, 'us-central1')` 명시 ✅ (이미 수정됨)

### 리전 변경이 필요한 경우

#### Functions를 다른 리전으로 변경
```javascript
// functions/index.js
const REGION = 'asia-northeast3'; // 변경

// js/firebase.js
export const functions = getFunctions(app, 'asia-northeast3'); // 변경
```

그 다음 재배포:
```powershell
firebase deploy --only functions
```

#### Firestore 리전 변경
- Firestore 리전은 생성 후 변경 불가
- 새 데이터베이스 생성 필요 (권장하지 않음)

## 현재 상태 요약

| 서비스 | 리전 설정 | 상태 |
|--------|---------|------|
| Functions | `us-central1` | ✅ 통일됨 |
| Functions (클라이언트) | `us-central1` | ✅ 통일됨 |
| Firestore | 기본값 | ⚠️ 확인 필요 |
| Storage | 기본값 | ⚠️ 확인 필요 |
| App Engine | 확인 필요 | ⚠️ 확인 필요 |

## 결론

**Functions 리전은 통일되어 있습니다.** ✅

다른 서비스(Firestore, Storage, App Engine)는 기본 리전을 사용하므로 대부분 문제없습니다. 
다만, 성능 최적화를 위해 모든 리전을 확인하고 필요시 통일하는 것을 권장합니다.

**다음 단계**: Firebase Console에서 실제 리전을 확인하고, 필요시 문서를 업데이트하세요.
