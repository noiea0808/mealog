# Firebase App Check 및 보안 강화 설정 가이드

## 개요

이 문서는 Mealog 앱의 보안을 강화하기 위한 Firebase App Check 설정 및 Cloud Functions를 통한 레이트 리밋/스팸 필터 구현 가이드입니다.

## 구현된 보안 기능

### 1. Cloud Functions를 통한 쓰기 API

다음 컬렉션들은 클라이언트에서 직접 쓰기가 차단되었으며, Cloud Functions를 통해서만 쓰기가 가능합니다:

- **boardPosts** (게시글)
- **boardComments** (게시판 댓글)
- **postComments** (피드 댓글)
- **postReports** (신고)
- **sharedPhotos** (공유 사진)

### 2. 레이트 리밋 (Rate Limiting)

사용자별 액션 타입에 따른 제한:

| 액션 타입 | 분당 제한 | 시간당 제한 |
|---------|---------|-----------|
| 게시글 (post) | 3개 | 20개 |
| 댓글 (comment) | 10개 | 50개 |
| 공유 (share) | 5개 | 30개 |
| 신고 (report) | 2개 | 10개 |
| 좋아요 (like) | 30개 | 200개 |
| 상호작용 (interaction) | 20개 | 100개 |

레이트 리밋 데이터는 `artifacts/{appId}/rateLimits/{userId}` 컬렉션에 저장됩니다.

### 3. 스팸 필터링

다음 항목들을 자동으로 감지하여 차단합니다:

- **금칙어**: 광고, 홍보, 무료, 이벤트, 할인, 쿠폰, 추천인, 링크 등
- **과도한 링크**: 게시글/댓글에 링크가 2개 이상 포함된 경우
- **반복 문자**: 같은 문자가 10회 이상 반복된 경우

### 4. 중복 신고 방지

사용자가 동일한 게시물을 중복 신고하는 것을 방지합니다.

## Firebase App Check 설정

### 1. Firebase 콘솔에서 App Check 활성화

1. [Firebase Console](https://console.firebase.google.com/)에 접속
2. 프로젝트 선택 (`mealog-r0`)
3. 왼쪽 메뉴에서 **Build** > **App Check** 선택
4. **Get started** 클릭

### 2. 웹 앱에 App Check 설정

#### 옵션 A: reCAPTCHA v3 사용 (권장)

1. App Check 페이지에서 **Web** 플랫폼 추가
2. **reCAPTCHA v3** 선택
3. reCAPTCHA 사이트 키를 생성하거나 기존 키 사용
4. 사이트 키를 복사

#### 옵션 B: reCAPTCHA Enterprise 사용

1. **reCAPTCHA Enterprise** 선택
2. Google Cloud Console에서 reCAPTCHA Enterprise API 활성화 필요

### 3. 클라이언트 코드에 App Check 추가

`js/firebase.js` 파일에 App Check 초기화 코드 추가:

```javascript
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app-check.js";

// App Check 초기화 (reCAPTCHA v3 사용)
const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider('YOUR_RECAPTCHA_SITE_KEY'),
    isTokenAutoRefreshEnabled: true
});
```

**참고**: `YOUR_RECAPTCHA_SITE_KEY`를 Firebase Console에서 발급받은 사이트 키로 교체하세요.

### 4. Firestore Rules에서 App Check 강제

`firestore.rules` 파일의 각 컬렉션 규칙에 App Check 토큰 검증 추가:

```javascript
// App Check 토큰 확인 함수
function hasValidAppCheckToken() {
    return request.appCheck != null && request.appCheck.token != null;
}

// 사용 예시
match /artifacts/{appId}/boardPosts/{postId} {
    allow read: if isAuthenticated();
    allow create: if false; // Cloud Functions만 허용
    allow update: if hasValidAppCheckToken() && (isAdmin() || isAuthorOfResource());
    allow delete: if hasValidAppCheckToken() && (isAdmin() || isAuthorOfResource());
}
```

**주의**: 현재 구현에서는 Cloud Functions가 admin SDK를 사용하므로 Rules를 우회합니다. 따라서 클라이언트 직접 쓰기가 차단된 컬렉션(create)은 App Check가 필요 없지만, 향후 추가 보안을 위해 update/delete에도 App Check를 추가할 수 있습니다.

## Cloud Functions 배포

### 1. Firebase CLI 설치

```bash
npm install -g firebase-tools
```

### 2. Firebase 로그인

```bash
firebase login
```

### 3. 프로젝트 초기화 (이미 완료된 경우 생략)

```bash
firebase init functions
```

### 4. Functions 디렉토리로 이동 및 의존성 설치

```bash
cd functions
npm install
```

### 5. Functions 배포

```bash
# 루트 디렉토리에서
firebase deploy --only functions
```

또는 특정 함수만 배포:

```bash
firebase deploy --only functions:createBoardPost,functions:addBoardComment
```

## Firestore Rules 배포

```bash
firebase deploy --only firestore:rules
```

## 테스트

### 로컬 테스트

1. Firebase Emulator Suite 사용:

```bash
firebase emulators:start
```

2. 브라우저에서 `http://localhost:5000` 접속

### 프로덕션 테스트

1. Functions 배포 후 실제 앱에서 테스트
2. 레이트 리밋 테스트: 빠르게 여러 번 요청하여 제한 메시지 확인
3. 스팸 필터 테스트: 금칙어가 포함된 게시글/댓글 작성 시도

## 모니터링

### Cloud Functions 로그 확인

```bash
firebase functions:log
```

또는 Firebase Console에서:
1. **Functions** 메뉴 선택
2. 각 함수의 **Logs** 탭 확인

### 레이트 리밋 모니터링

`artifacts/{appId}/rateLimits/{userId}` 컬렉션을 모니터링하여 사용자별 액션 빈도를 확인할 수 있습니다.

## 문제 해결

### Functions 배포 실패

- Node.js 버전 확인 (18 이상 필요)
- `functions/package.json`의 의존성 확인
- Firebase CLI 버전 업데이트: `npm install -g firebase-tools@latest`

### App Check 토큰 오류

- reCAPTCHA 사이트 키가 올바른지 확인
- 도메인이 reCAPTCHA에 등록되어 있는지 확인
- 브라우저 콘솔에서 App Check 토큰 오류 확인

### 레이트 리밋이 작동하지 않음

- Functions 로그에서 레이트 리밋 체크 로직 확인
- `rateLimits` 컬렉션에 데이터가 저장되는지 확인

## 추가 보안 권장사항

1. **IP 기반 차단**: Cloud Functions에서 의심스러운 IP 패턴 감지 및 차단
2. **디바이스 핑거프린팅**: 동일 사용자의 다중 계정 사용 감지
3. **콘텐츠 모더레이션**: AI 기반 자동 모더레이션 (예: Google Cloud Natural Language API)
4. **사용자 신뢰도 점수**: 사용자별 신뢰도 점수를 계산하여 제한 조정

## 참고 자료

- [Firebase App Check 문서](https://firebase.google.com/docs/app-check)
- [Cloud Functions for Firebase 문서](https://firebase.google.com/docs/functions)
- [Firestore Security Rules 문서](https://firebase.google.com/docs/firestore/security/get-started)
