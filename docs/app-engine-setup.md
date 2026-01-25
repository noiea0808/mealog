# App Engine 설정 및 Functions 배포 가이드

## 문제
Firebase Functions를 배포하려면 Google App Engine 앱이 필요합니다.

## 해결 방법

### 방법 1: Firebase Console에서 Functions 활성화 (권장)

1. Firebase Console 접속
   - https://console.firebase.google.com/project/mealog-r0/functions

2. Functions 페이지에서 "Get started" 또는 "시작하기" 클릭

3. 리전 선택 (예: `us-central1`)

4. App Engine 앱이 자동으로 생성됩니다

### 방법 2: Google Cloud Console에서 직접 생성

1. Google Cloud Console 접속
   - https://console.cloud.google.com/appengine?project=mealog-r0

2. "Create Application" 클릭

3. 리전 선택
   - **중요**: `us-central1` 또는 `asia-northeast3` (서울) 권장
   - Functions와 같은 리전을 사용하는 것이 좋습니다

4. "Create" 클릭

## App Engine 생성 후

App Engine 앱이 생성되면 다시 배포:

```powershell
firebase deploy --only functions
```

## 리전 확인

현재 Functions가 사용하는 리전 확인:
```powershell
firebase functions:config:get
```

또는 `firebase.json`에 리전 설정 추가:
```json
{
  "functions": {
    "source": "functions",
    "runtime": "nodejs20"
  }
}
```

## 문제 해결

### App Engine이 이미 있는 경우
- Google Cloud Console에서 App Engine 상태 확인
- https://console.cloud.google.com/appengine?project=mealog-r0

### 권한 오류가 계속되는 경우
1. Firebase Console > 프로젝트 설정 > 서비스 계정 확인
2. Google Cloud Console > IAM에서 서비스 계정 권한 확인

### 다른 리전 사용
Functions를 다른 리전에 배포하려면:
```powershell
firebase functions:config:set functions.region=asia-northeast3
```

또는 `functions/index.js`에서 각 함수에 리전 지정:
```javascript
exports.createBoardPost = onCall({
  region: 'asia-northeast3'
}, async (request) => {
  // ...
});
```
