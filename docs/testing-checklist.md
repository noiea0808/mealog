# 테스트 체크리스트

## 1. 인덱스 생성 확인

### Firebase Console에서 확인
1. 브라우저에서 다음 URL 접속:
   ```
   https://console.firebase.google.com/project/mealog-r0/firestore/indexes
   ```

2. 인덱스 상태 확인:
   - 각 인덱스의 상태가 "Building" → "Enabled"로 변경되었는지 확인
   - 인덱스 생성에는 몇 분이 소요될 수 있습니다
   - 다음 인덱스들이 모두 "Enabled" 상태여야 합니다:
     - `boardComments`: postId ASC, timestamp ASC
     - `boardPosts`: category ASC, timestamp DESC
     - `boardInteractions`: postId ASC, userId ASC
     - `postComments`: postId ASC, timestamp ASC
     - `postLikes`: postId ASC, userId ASC
     - `postBookmarks`: postId ASC, userId ASC
     - `noticeInteractions`: noticeId ASC, userId ASC

## 2. 에러 리포팅 테스트

### 로컬 서버 시작
1. 프로젝트 루트에서 다음 명령 실행:
   ```bash
   # Windows
   start.bat
   
   # 또는 PowerShell에서 직접
   .\server.ps1
   ```

2. 브라우저에서 앱 접속:
   ```
   http://localhost:8000
   ```

### 에러 발생 테스트
1. 개발자 도구 열기 (F12)
2. 콘솔 탭으로 이동
3. 다음 명령어로 테스트 에러 발생:
   ```javascript
   // JavaScript 에러 테스트
   throw new Error('테스트 에러: 에러 리포팅 시스템 테스트');
   
   // Promise rejection 테스트
   Promise.reject(new Error('테스트: Promise rejection'));
   
   // 커스텀 에러 리포팅 테스트
   if (window.reportError) {
       window.reportError({
           message: '테스트: 커스텀 에러',
           type: 'test_error',
           timestamp: new Date().toISOString()
       });
   }
   ```

4. 에러가 Firestore에 저장되었는지 확인:
   - Firebase Console 접속:
     ```
     https://console.firebase.google.com/project/mealog-r0/firestore/data
     ```
   - 경로: `artifacts/mealog-r0/errorLogs` (관리자 권한 필요)
   - 최근 에러 로그가 저장되었는지 확인

### 에러 리포팅 확인 사항
- ✅ 에러가 콘솔에 출력되는가?
- ✅ 에러가 Firestore의 `errorLogs` 컬렉션에 저장되는가?
- ✅ 에러 정보가 올바르게 저장되는가? (message, type, timestamp, userId 등)
- ✅ 중복 에러가 1시간 이내에 다시 저장되지 않는가? (sessionStorage 기반 중복 방지)

## 3. 성능 확인

### 인덱스 활성화 후 쿼리 성능 테스트

#### 게시판 목록 조회 성능
1. 게시판 탭으로 이동
2. 각 카테고리별로 게시글 목록 조회:
   - 전체
   - 무거운
   - 가벼운
   - 먹는
   - 치프에게
3. 개발자 도구 > Network 탭에서 쿼리 응답 시간 확인
4. 예상 개선 사항:
   - 인덱스 활성화 전: 느린 쿼리 경고 또는 타임아웃 가능
   - 인덱스 활성화 후: 빠른 응답 시간 (< 1초)

#### 댓글 목록 조회 성능
1. 게시글 상세 페이지로 이동
2. 댓글 목록이 로드되는 시간 확인
3. 예상 개선 사항:
   - 인덱스 활성화 전: 느린 쿼리
   - 인덱스 활성화 후: 빠른 로딩

#### 좋아요/북마크 조회 성능
1. 타임라인에서 게시글 열기
2. 좋아요/북마크 상태 확인 속도 확인
3. 예상 개선 사항:
   - 인덱스 활성화 전: 느린 조회
   - 인덱스 활성화 후: 즉시 조회

### 성능 측정 방법
1. 개발자 도구 > Performance 탭 사용
2. 또는 개발자 도구 > Network 탭에서 Firestore 쿼리 시간 확인
3. 콘솔에서 쿼리 시간 로깅 확인:
   ```javascript
   // 쿼리 성능 로깅이 있다면 확인
   ```

## 4. 추가 확인 사항

### Firestore Rules 확인
- 에러 로그 컬렉션에 대한 접근 권한 확인:
  ```
  artifacts/{appId}/errorLogs
  ```
- 관리자만 읽을 수 있도록 설정되어 있는지 확인

### 에러 리포팅 설정 확인
- 로컬 개발 환경에서는 에러 리포팅이 비활성화되어 있는지 확인
- 프로덕션 환경에서만 에러가 Firestore에 저장되는지 확인

## 테스트 완료 체크리스트

- [ ] 모든 인덱스가 "Enabled" 상태
- [ ] 에러 리포팅이 정상 작동 (Firestore에 저장됨)
- [ ] 게시판 목록 조회 성능 개선 확인
- [ ] 댓글 목록 조회 성능 개선 확인
- [ ] 좋아요/북마크 조회 성능 개선 확인
- [ ] 에러 로그가 중복 저장되지 않음 (1시간 내 동일 에러)
- [ ] 로컬 환경에서는 에러 리포팅이 비활성화됨
