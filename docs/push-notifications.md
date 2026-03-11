# 푸시 알림 설정

알림 항목(내 게시물에 달린 댓글) 발생 시 스마트폰으로 푸시 알림을 보내려면 아래 설정이 필요합니다.

## 1. Android

- **google-services.json**: Firebase Console에서 앱(Android)을 등록한 뒤 `google-services.json`을 다운로드하여 `android/app/` 폴더에 넣어주세요.  
  없으면 `android/app/build.gradle`에서 Google Services 플러그인이 적용되지 않아 푸시가 동작하지 않습니다.
- 빌드: `npm run cap:sync` 후 `npx cap open android`에서 앱을 빌드/실행하면, 로그인 시 FCM 토큰이 Firestore `users/{uid}/config/fcmTokens`에 저장됩니다.

## 2. Cloud Functions 배포

푸시 발송 로직이 포함된 Functions를 배포해야 합니다.

```bash
cd functions
npm install
firebase deploy --only functions
```

## 3. 동작 요약

- **클라이언트(앱)**: 로그인한 사용자가 네이티브 앱을 실행하면 `@capacitor/push-notifications`로 FCM 토큰을 받아 Firestore에 저장합니다.
- **서버**: `addPostComment`(피드 댓글), `addBoardComment`(게시판 댓글), `addBoardCommentAsAdmin` 호출 시, 글 작성자(본인 제외)의 FCM 토큰으로 푸시를 전송합니다.
- **알림 탭**: 푸시 알림을 탭하면 해당 글로 이동합니다(피드 댓글 → 해당 포스트, 게시판 댓글 → 게시판 해당 글).

## 4. 웹 브라우저

현재 푸시 등록/저장은 **Capacitor 네이티브 앱**에서만 동작합니다. 웹에서도 푸시를 쓰려면 Firebase Cloud Messaging 웹 설정(VAPID 키, Service Worker 등)을 추가해야 합니다.
