# Firebase 프로젝트 설정 및 배포 가이드

## 1단계: Firebase 프로젝트 설정

### 프로젝트 목록 확인
```bash
firebase projects:list
```

### 프로젝트 설정 (mealog-r0)
```bash
firebase use mealog-r0
```

또는 프로젝트가 목록에 없다면:
```bash
firebase use --add
```
그 다음 `mealog-r0` 프로젝트를 선택하세요.

## 2단계: Functions 의존성 설치
```bash
cd functions
npm install
cd ..
```

## 3단계: Functions 배포
```bash
firebase deploy --only functions
```

## 4단계: Firestore Rules 배포
```bash
firebase deploy --only firestore:rules
```

## 한 번에 실행하기

```bash
# 프로젝트 설정
firebase use mealog-r0

# Functions 의존성 설치
cd functions && npm install && cd ..

# 배포
firebase deploy --only functions,firestore:rules
```

## 프로젝트 확인

현재 설정된 프로젝트 확인:
```bash
firebase use
```

## 문제 해결

### 프로젝트를 찾을 수 없는 경우
1. Firebase Console에서 프로젝트 ID 확인
   - https://console.firebase.google.com/
   - 프로젝트 설정 > 일반 > 프로젝트 ID

2. 올바른 프로젝트 ID로 설정
   ```bash
   firebase use <프로젝트_ID>
   ```

### 권한 오류가 발생하는 경우
```bash
firebase login --reauth
```
