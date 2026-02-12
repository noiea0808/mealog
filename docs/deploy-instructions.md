# Firebase Functions 배포 가이드

## 배포 전 확인사항

### API 키 설정 (Gemini 인사이트, 카카오 장소 검색 등)

Firebase Functions params 방식을 사용합니다. **functions/.env** 파일에 API 키를 설정하세요.

```bash
cd functions
cp .env.example .env
# .env 파일을 편집하여 GEMINI_API_KEY, KAKAO_REST_API_KEY 값을 입력
```

또는 프로젝트별로 **.env.mealog-r0** 파일을 만들어 사용할 수 있습니다.

```bash
# functions/.env 또는 functions/.env.mealog-r0
GEMINI_API_KEY=AIzaSy...
KAKAO_REST_API_KEY=카카오_REST_API_키
```

설정 후 배포: `firebase deploy --only functions`  
(값이 없으면 배포 시 CLI가 입력을 요청합니다)

---

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

### 4단계: Storage Rules 배포 (밀톡 사진 등 업로드용)
```bash
firebase deploy --only storage
```

## 한 번에 배포하기

```bash
# Functions, Firestore Rules, Storage Rules 동시 배포
firebase deploy --only functions,firestore:rules,storage
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

3. Firebase Console > Storage > Rules에서 규칙 확인 (밀톡 사진 업로드용)
   - https://console.firebase.google.com/project/mealog-r0/storage/rules

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
