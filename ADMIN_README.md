# MEALOG 관리자 페이지 가이드

## 개요
MEALOG 관리자 페이지는 별도의 관리 사이트로, 사용자 통계와 공유 게시물을 모니터링할 수 있습니다.

## 접속 방법
1. 웹 브라우저에서 `admin.html` 파일을 열거나
2. 웹 서버를 통해 `http://localhost:포트/admin.html`로 접속

## 관리자 권한 설정

### Firestore에 ADMIN 컬렉션 생성 필요

Firebase 콘솔에서 다음 경로에 문서를 생성하세요:

**경로**: `artifacts/mealog-r0/admins/{사용자UID}`

**문서 데이터**:
```json
{
  "isAdmin": true,
  "email": "관리자이메일@example.com",
  "createdAt": "2024-01-01T00:00:00Z"
}
```

### 사용자 UID 확인 방법
1. 일반 앱(`index.html`)에서 로그인
2. 브라우저 개발자 도구(F12) 콘솔에서 다음 명령 실행:
   ```javascript
   console.log(window.currentUser.uid);
   ```
3. 출력된 UID를 복사하여 위 경로의 문서 ID로 사용

### 또는 코드로 ADMIN 설정
Firebase 콘솔의 Firestore Database에서 수동으로 생성하거나, 임시로 다음 코드를 콘솔에서 실행:

```javascript
// Firebase 콘솔의 웹 콘솔에서 실행
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { db, appId } from './firebase.js';

// 사용자 UID를 입력하세요
const adminUserId = '여기에_사용자_UID_입력';

await setDoc(doc(db, 'artifacts', appId, 'admins', adminUserId), {
  isAdmin: true,
  email: '관리자@example.com',
  createdAt: new Date().toISOString()
});
```

## 기능 설명

### 1. 사용자 통계
- **전체 사용자**: 등록된 모든 사용자 수
- **활성 사용자**: 최근 30일 내 기록이 있는 사용자 수
- **전체 기록**: 모든 사용자의 식사 기록 합계
- **공유 게시물**: 피드에 공유된 사진 개수
- **최근 활동**: 최근 7일/30일 활동 통계

### 2. 공유 게시물 모니터링
- 최신순으로 공유된 게시물 목록 표시
- 각 게시물의 작성자, 내용, 작성 시간 확인
- 부적절한 게시물 삭제 기능

## 보안 주의사항
- ADMIN 권한은 신중하게 부여하세요
- 관리자 계정의 비밀번호는 강력하게 설정하세요
- Firestore 보안 규칙에서 `admins` 컬렉션 접근을 제한하는 것을 권장합니다

## Firestore 보안 규칙 예시

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /artifacts/{appId}/admins/{userId} {
      // ADMIN 문서는 읽기 전용으로, 관리자만 확인 가능하도록 설정
      allow read: if request.auth != null && 
                     resource.data.isAdmin == true;
      allow write: if false; // 수동으로만 설정
    }
  }
}
```
