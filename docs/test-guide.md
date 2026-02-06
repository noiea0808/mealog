# 테스트 진행 가이드

## 단계별 테스트 진행

### 1단계: 인덱스 생성 확인

**Firebase Console 접속:**
```
https://console.firebase.google.com/project/mealog-r0/firestore/indexes
```

**확인 사항:**
- 모든 인덱스가 "Enabled" 상태인지 확인
- "Building" 상태라면 완료될 때까지 대기 (몇 분 소요 가능)

---

### 2단계: 로컬 서버 시작 및 앱 실행

**서버 시작:**
1. 프로젝트 폴더에서 `start.bat` 더블클릭
2. 또는 PowerShell에서:
   ```powershell
   cd c:\100_Dev\mealog
   .\server.ps1
   ```

**앱 접속:**
- 브라우저에서 `http://localhost:8000` 접속
- 개발자 도구 열기 (F12)

---

### 3단계: 에러 리포팅 테스트

**방법 1: 테스트 스크립트 사용 (권장)**

1. 브라우저 콘솔에서 다음 파일 내용을 복사하여 실행:
   - `test-error-reporting.js` 파일 내용을 콘솔에 붙여넣기

2. 또는 직접 명령어 실행:
   ```javascript
   // JavaScript 에러 테스트
   throw new Error('테스트 에러');
   
   // Promise rejection 테스트
   Promise.reject(new Error('테스트 Promise rejection'));
   
   // 커스텀 에러 리포팅
   if (window.reportError) {
       window.reportError({
           message: '테스트: 커스텀 에러',
           type: 'test_error'
       });
   }
   ```

**방법 2: 실제 기능 사용 중 에러 발생**

1. 앱의 다양한 기능 사용 (게시판, 댓글, 좋아요 등)
2. 의도적으로 에러 발생시키기 (예: 네트워크 끊기, 잘못된 입력 등)

**확인:**
- 콘솔에 에러가 출력되는지 확인
- Firebase Console에서 에러 로그 확인:
  ```
  https://console.firebase.google.com/project/mealog-r0/firestore/data
  경로: artifacts/mealog-r0/errorLogs
  ```

---

### 4단계: 성능 확인

**게시판 목록 조회:**
1. 게시판 탭으로 이동
2. 각 카테고리 클릭 (전체, 무거운, 가벼운, 먹는, 치프에게)
3. 개발자 도구 > Network 탭에서 Firestore 쿼리 시간 확인
4. 빠르게 로드되는지 확인 (< 1초)

**댓글 조회:**
1. 게시글 상세 페이지로 이동
2. 댓글 목록이 빠르게 로드되는지 확인

**좋아요/북마크 조회:**
1. 타임라인에서 게시글 열기
2. 좋아요/북마크 상태가 즉시 표시되는지 확인

---

## 예상 결과

### ✅ 정상 작동 시:
- 인덱스: 모든 인덱스가 "Enabled" 상태
- 에러 리포팅: 에러가 Firestore에 저장됨
- 성능: 쿼리가 빠르게 실행됨 (< 1초)

### ⚠️ 문제 발생 시:
- 인덱스가 "Building" 상태: 완료될 때까지 대기
- 에러가 저장되지 않음: Firestore Rules 확인 필요
- 쿼리가 느림: 인덱스가 아직 활성화되지 않았을 수 있음

---

## 추가 확인 사항

### 에러 리포팅 중복 방지
- 같은 에러는 1시간에 1번만 저장되어야 함
- sessionStorage를 사용하여 중복 방지

### 로컬 환경 확인
- 로컬 환경(localhost)에서는 에러 리포팅이 비활성화되어야 함
- 프로덕션 환경에서만 Firestore에 저장됨
