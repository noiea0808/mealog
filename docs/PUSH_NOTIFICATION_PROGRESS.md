# 본인 게시물 알림(푸시) 진행 경과 및 보완 가이드

## 1. 현재 구현된 내용

### 1.1 백엔드 (Cloud Functions · `functions/index.js`)

- **`sendPushToUser(userId, payload)`**  
  - `artifacts/mealog-r0/users/{userId}/config/fcmTokens` 문서에서 FCM 토큰 목록을 읽어  
    Firebase Admin `getMessaging().send()` 로 푸시 전송.
- **푸시가 나가는 경우**
  - **게시판 댓글** (`addBoardComment`): 댓글 달린 글의 작성자(`postAuthorId`)에게 전송.  
    단, 댓글 작성자 본인(`auth.uid`)에게는 보내지 않음.
  - **게시판 댓글 (관리자)** (`addBoardCommentAsAdmin`): 동일하게 글 작성자에게만 전송.
  - **피드 댓글** (`addPostComment`): 댓글 달린 피드의 소유자(`postOwnerId`)에게 전송.  
    단, 댓글 작성자 본인에게는 보내지 않음.

즉, **"본인 게시물에 대한 알림"** 은 이미 로직 상 구현되어 있음 (내 글이 아닌 글에 댓글 단 사람에게는 푸시 안 감).

### 1.2 클라이언트

- **`www/js/push-notifications.js`**
  - Capacitor 네이티브 환경에서만 동작 (`isNative()`).
  - 알림 권한 요청 → `PushNotifications.register()` → `registration` 이벤트에서 FCM 토큰을  
    Firestore `artifacts/{appId}/users/{uid}/config/fcmTokens` 에 저장 (merge).
  - 푸시 수신/탭 리스너:
    - `pushNotificationActionPerformed`: `data.type` 이 `boardComment` 이면  
      `switchMainTab('board')` 후 `openBoardDetail(postId)`,  
      그 외면 `navigateToNotificationPost(postId)` 호출.
- **`www/js/main.js`**
  - `onAuthStateChanged` 에서 로그인 사용자(비익명)일 때  
    `initPushNotifications(user.uid)` 호출.

### 1.3 Firestore 규칙

- `artifacts/{appId}/users/{userId}/config/{configId}`  
  - 읽기/쓰기: `request.auth.uid == userId` 인 경우 허용.  
  → `fcmTokens` 문서는 해당 사용자만 읽기/쓰기 가능하므로 푸시 토큰 저장에 문제 없음.

### 1.4 Android

- `google-services.json` 적용, `com.google.gms.google-services` 플러그인 적용.
- Firebase Messaging / Capacitor Push Notifications 관련 의존성 및 매니페스트 설정 존재.

---

## 2. "멈췄다"고 느낄 수 있는 지점 (점검 포인트)

1. **실기기에서만 토큰이 저장됨**  
   - 푸시 초기화는 `Capacitor.isNativePlatform()` 일 때만 실행됨.  
   - **웹 브라우저나 에뮬레이터**에서는 FCM 토큰이 저장되지 않을 수 있음.  
   → **실기기 + 로그인** 상태에서 앱 실행 후 Firestore에 `fcmTokens` 문서가 생기는지 확인 필요.

2. **Functions 미배포**  
   - `sendPushToUser` 를 호출하는 코드가 배포된 Functions에 반영되어 있어야 함.  
   → `firebase deploy --only functions` 로 최신 코드가 배포되었는지 확인.

3. **토큰 미저장**  
   - 권한 거부, 네트워크 오류, `saveFcmToken` 실패 시 Firestore에 토큰이 없음.  
   → 콘솔 로그: `✅ FCM 토큰 저장 완료` / `⚠️ FCM 토큰 저장 실패` 확인.  
   → Firestore 콘솔에서 해당 사용자 경로  
     `artifacts/mealog-r0/users/{uid}/config/fcmTokens` 에 `tokens` 필드가 있는지 확인.

4. **프로젝트/앱 일치**  
   - Android 앱의 `google-services.json`(및 패키지명)과  
     Cloud Functions / Firestore를 사용하는 Firebase 프로젝트가 동일해야 FCM이 정상 동작.

5. **알림 클릭 시 화면 이동**  
   - 푸시 payload 의 `data` 에 `type`, `postId` 가 문자열로 들어가야 함.  
   - 현재 Functions 에서는 이미 `data: { type: '...', postId: String(postId) }` 로 전달 중.  
   → 알림을 눌렀는데 다른 화면으로 가거나 동작이 없으면,  
     수신 시 `ev.notification?.data` 구조를 한 번 로그로 확인하는 것이 좋음.

---

## 3. 보완 제안

### 3.1 디버깅용 로그 (Functions)

- `sendPushToUser` 내부에서:
  - 해당 사용자에게 등록된 토큰이 0개일 때 `logger.info` 로 로그 출력.
  - (선택) 푸시 전송 성공/실패 건수 로그.
- 이렇게 하면 "토큰이 없어서 안 간다" vs "전송은 했는데 단말에서 안 받는다" 구분이 쉬움.

### 3.2 클라이언트 에러 처리

- `saveFcmToken` 실패 시 사용자에게 "알림 등록에 실패했습니다" 같은 토스트를 띄우거나,  
  재시도(예: 토큰 갱신 후 다시 저장)를 한 번 넣어두면,  
  네트워크 불안정 시에도 나중에 토큰이 저장될 가능성이 높아짐.

### 3.3 토큰 갱신

- `registration` 만으로는 토큰 갱신(재발급) 시 누락될 수 있음.  
  - 앱 재시작 시 또는 주기적으로 "현재 FCM 토큰"을 한 번 조회해 Firestore에 다시 저장하는 로직을 두면 더 안정적.

### 3.4 (선택) 알림 설정 스위치

- 설정 화면에 "내 글에 달린 댓글 알림" on/off 를 두고,  
  해당 값을 Firestore 사용자 설정에 저장한 뒤,  
  Functions 에서 푸시를 보내기 전에 이 값을 읽어서 꺼져 있으면 `sendPushToUser` 를 호출하지 않도록 하면,  
  사용자 요청 대응이 쉬움.

---

## 4. 확인 체크리스트

- [ ] 실기기에서 앱 실행 후 로그인.
- [ ] 콘솔에 `푸시: 권한 허용됨, FCM 등록 중...` / `✅ FCM 토큰 저장 완료` 출력 여부 확인.
- [ ] Firestore에서 `artifacts/mealog-r0/users/{테스트계정 uid}/config/fcmTokens` 문서에 `tokens` 필드 존재 여부 확인.
- [ ] 다른 계정으로 해당 사용자의 게시물(게시판 또는 피드)에 댓글 작성.
- [ ] Cloud Functions 로그에서 `sendPushToUser` 관련 로그(에러/경고) 확인.
- [ ] 실기기에서 푸시 수신 및 알림 탭 시 해당 글로 이동하는지 확인.

위 항목을 순서대로 확인하면, "본인 게시물에 대한 알림이 푸시로 가는지" 여부와  
어디에서 막히는지(토큰 저장 / Functions 전송 / 수신·라우팅)를 좁혀갈 수 있습니다.
