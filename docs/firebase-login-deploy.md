# Firebase 로그인 및 배포 가이드

## 1단계: Firebase 로그인

### PowerShell에서 로그인
```powershell
firebase login
```

브라우저가 열리면 Google 계정으로 로그인하세요.

### 로그인 확인
```powershell
firebase projects:list
```

프로젝트 목록이 보이면 로그인 성공입니다.

## 2단계: 프로젝트 설정 확인

```powershell
firebase use mealog-r0
```

또는
```powershell
firebase use
```

현재 프로젝트가 `mealog-r0`인지 확인하세요.

## 3단계: 배포 실행

### 단계별 배포 (권장)

```powershell
# Functions 배포
firebase deploy --only functions

# Firestore Rules 배포
firebase deploy --only firestore:rules
```

### 한 번에 배포

```powershell
firebase deploy --only "functions,firestore:rules"
```

## 배포 확인

배포가 성공하면:
```
✔  functions[createBoardPost] Deployed successfully
✔  functions[updateBoardPost] Deployed successfully
...
✔  firestore: rules deployed to firestore
```

## 문제 해결

### 로그인 실패 시
```powershell
firebase login --reauth
```

### 프로젝트를 찾을 수 없는 경우
```powershell
firebase use --add
```
그 다음 `mealog-r0` 선택

### 권한 오류 시
Firebase Console에서 프로젝트에 대한 권한이 있는지 확인:
- https://console.firebase.google.com/
