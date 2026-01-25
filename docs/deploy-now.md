# Firebase 배포 실행 가이드

## 현재 상태 확인
- ✅ Functions 코드 준비됨 (`functions/index.js`)
- ✅ 의존성 설치됨 (`package-lock.json` 존재)
- ✅ 프로젝트 설정 파일 생성됨 (`.firebaserc`)

## 배포 실행

### 1. 프로젝트 설정 확인
```bash
firebase use
```
출력: `Now using project mealog-r0` 이어야 합니다.

### 2. Functions 배포
```bash
firebase deploy --only functions
```

### 3. Firestore Rules 배포
```bash
firebase deploy --only firestore:rules
```

## 한 번에 배포
```bash
firebase deploy --only functions,firestore:rules
```

## 배포 확인

배포가 성공하면 다음 메시지가 표시됩니다:
```
✔  functions[createBoardPost] Deployed successfully
✔  functions[updateBoardPost] Deployed successfully
✔  functions[deleteBoardPost] Deployed successfully
✔  functions[addBoardComment] Deployed successfully
✔  functions[deleteBoardComment] Deployed successfully
✔  functions[addPostComment] Deployed successfully
✔  functions[deletePostComment] Deployed successfully
✔  functions[submitPostReport] Deployed successfully
✔  functions[sharePhotos] Deployed successfully
✔  functions[unsharePhotos] Deployed successfully
✔  firestore: rules deployed to firestore
```

## 배포 후 확인

1. Firebase Console > Functions
   - https://console.firebase.google.com/project/mealog-r0/functions
   - 10개의 함수가 보여야 합니다

2. Firebase Console > Firestore > Rules
   - https://console.firebase.google.com/project/mealog-r0/firestore/rules
   - Rules가 업데이트되었는지 확인

## 문제 발생 시

### 배포 실패 시
```bash
# 로그 확인
firebase functions:log

# 특정 함수만 배포
firebase deploy --only functions:createBoardPost
```

### 의존성 문제 시
```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```
