# 배포 확인 체크리스트

## ✅ 코드 준비 상태 확인

### 1. Firebase 설정 ✅
- [x] `firebase.json` 설정 파일 존재
- [x] `functions/index.js`에 Callable Functions 구현됨
- [x] `functions/package.json` 존재

### 2. 클라이언트 코드 ✅
- [x] `js/firebase.js`에 Callable Functions 참조 설정됨
- [x] `js/db/board.js`에서 Callable Functions 사용
- [x] `js/db/social.js`에서 Callable Functions 사용
- [x] `js/db/ops.js`에서 Callable Functions 사용

### 3. Firestore Rules ✅
- [x] `firestore.rules`에 주요 컬렉션 create 차단 설정됨
  - boardPosts: create 차단 ✅
  - boardComments: create 차단 ✅
  - postComments: create 차단 ✅
  - postReports: create 차단 ✅
  - sharedPhotos: create 차단 ✅

### 4. App Check ✅
- [x] `js/firebase.js`에 App Check 초기화 코드 있음
- [x] reCAPTCHA 사이트 키 설정됨

## 🔍 배포 상태 확인 방법

### Firebase Console에서 확인

1. **Functions 확인**
   - https://console.firebase.google.com/project/mealog-r0/functions
   - 다음 함수들이 배포되어 있어야 합니다:
     - createBoardPost
     - updateBoardPost
     - deleteBoardPost
     - addBoardComment
     - deleteBoardComment
     - addPostComment
     - deletePostComment
     - submitPostReport
     - sharePhotos
     - unsharePhotos

2. **Firestore Rules 확인**
   - https://console.firebase.google.com/project/mealog-r0/firestore/rules
   - Rules가 배포되었는지 확인
   - 주요 컬렉션의 create가 `false`로 설정되어 있는지 확인

### 배포 로그 확인

배포 시 출력된 로그에서 다음을 확인:
- ✅ Functions 배포 성공 메시지
- ✅ Firestore Rules 배포 성공 메시지

## 🧪 테스트 방법

### 1. 게시글 작성 테스트
브라우저 콘솔에서:
```javascript
// 로그인 후 실행
await window.boardOperations.createPost({
    title: '테스트 게시글',
    content: '테스트 내용',
    category: 'serious'
});
```

**예상 결과:**
- ✅ 성공: 게시글이 생성됨
- ❌ 실패: "permission-denied" 또는 Functions 오류

### 2. 레이트 리밋 테스트
빠르게 여러 번 게시글 작성 시도:
```javascript
// 4번 연속 실행 (분당 3개 제한)
for(let i = 0; i < 4; i++) {
    await window.boardOperations.createPost({
        title: `테스트 ${i}`,
        content: '테스트',
        category: 'serious'
    });
}
```

**예상 결과:**
- ✅ 3번째까지 성공
- ❌ 4번째: "너무 빠르게 요청했습니다" 오류

### 3. 스팸 필터 테스트
금칙어가 포함된 게시글 작성:
```javascript
await window.boardOperations.createPost({
    title: '광고 게시글',
    content: '무료 이벤트 참여하세요!',
    category: 'serious'
});
```

**예상 결과:**
- ❌ "금칙어가 포함되어 있습니다" 오류

### 4. 직접 쓰기 차단 확인
Firestore 직접 쓰기 시도 (브라우저 콘솔):
```javascript
import { db, appId } from './js/firebase.js';
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// 직접 쓰기 시도 (실패해야 함)
try {
    await addDoc(collection(db, 'artifacts', appId, 'boardPosts'), {
        title: '직접 쓰기 테스트',
        content: '이건 실패해야 함',
        authorId: window.currentUser.uid
    });
} catch(e) {
    console.log('예상대로 차단됨:', e.message);
}
```

**예상 결과:**
- ❌ "permission-denied" 오류

## 📋 배포 완료 확인 사항

- [ ] Firebase Console에서 Functions 목록 확인
- [ ] Firebase Console에서 Firestore Rules 확인
- [ ] 게시글 작성 테스트 성공
- [ ] 레이트 리밋 작동 확인
- [ ] 스팸 필터 작동 확인
- [ ] 직접 쓰기 차단 확인

## 🚨 문제 발생 시

### Functions가 보이지 않는 경우
```bash
firebase deploy --only functions
```

### Rules가 업데이트되지 않은 경우
```bash
firebase deploy --only firestore:rules
```

### Functions 오류 확인
Firebase Console > Functions > Logs에서 오류 확인

### 클라이언트 오류 확인
브라우저 개발자 도구 > Console에서 오류 확인
