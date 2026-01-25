# Firebase Functions 배포 가이드

## 배포 전 확인사항

1. ✅ Node.js 설치 확인
   ```bash
   node --version
   ```

2. ✅ Firebase CLI 설치 확인
   ```bash
   firebase --version
   ```

3. ✅ Firebase 로그인 확인
   ```bash
   firebase login
   ```

4. ✅ 프로젝트 설정 확인
   ```bash
   firebase use mealog-r0
   ```

## 배포 단계별 실행

### 1단계: Functions 의존성 설치
```bash
cd functions
npm install
cd ..
```

### 2단계: Functions 배포
```bash
firebase deploy --only functions
```

### 3단계: Firestore Rules 배포
```bash
firebase deploy --only firestore:rules
```

## 한 번에 배포하기

```bash
# Functions와 Rules 동시 배포
firebase deploy --only functions,firestore:rules
```

## 배포 확인

배포가 완료되면 다음 메시지가 표시됩니다:
- ✅ `✔  functions[함수이름] Deployed successfully`
- ✅ `✔  firestore: rules deployed to firestore`

## 배포 후 확인

1. Firebase Console > Functions 메뉴에서 함수 목록 확인
   - https://console.firebase.google.com/project/mealog-r0/functions

2. Firebase Console > Firestore > Rules에서 규칙 확인
   - https://console.firebase.google.com/project/mealog-r0/firestore/rules

## 문제 해결

### 배포 실패 시
```bash
# 로그 확인
firebase functions:log

# 특정 함수만 배포
firebase deploy --only functions:createBoardPost
```

### 의존성 오류 시
```bash
cd functions
rm -rf node_modules package-lock.json
npm install
cd ..
```
