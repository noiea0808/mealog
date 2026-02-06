# PowerShell 배포 명령어

## PowerShell에서 배포하기

PowerShell에서는 쉼표로 구분된 리스트를 따옴표로 감싸야 합니다.

### 한 번에 배포 (PowerShell)
```powershell
firebase deploy --only "functions,firestore:rules"
```

### 단계별 배포 (PowerShell)
```powershell
# Functions 배포
firebase deploy --only functions

# Firestore Rules 배포
firebase deploy --only firestore:rules
```

## CMD (명령 프롬프트)에서 배포하기

CMD에서는 따옴표 없이 사용 가능합니다.

### 한 번에 배포 (CMD)
```cmd
firebase deploy --only functions,firestore:rules
```

### 단계별 배포 (CMD)
```cmd
firebase deploy --only functions
firebase deploy --only firestore:rules
```

## 배포 확인

배포가 성공하면:
```
✔  functions[함수이름] Deployed successfully
✔  firestore: rules deployed to firestore
```

## 배포 후 확인

1. Firebase Console > Functions
   - https://console.firebase.google.com/project/mealog-r0/functions
   - 10개의 함수가 보여야 합니다

2. Firebase Console > Firestore > Rules
   - https://console.firebase.google.com/project/mealog-r0/firestore/rules
