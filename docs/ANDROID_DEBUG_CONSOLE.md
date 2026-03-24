# Android 앱 콘솔(로그) 확인 방법

Capacitor 앱은 WebView에서 동작하므로 **Chrome 원격 디버깅**으로 콘솔을 볼 수 있습니다.

## 1. 준비

- **USB 디버깅**: 휴대폰 설정 → 개발자 옵션 → USB 디버깅 켜기
- **USB 연결**: 휴대폰을 PC에 USB로 연결
- **앱 실행**: MEALOG 앱을 실기기에서 실행한 상태로 둠

## 2. Chrome에서 콘솔 열기

1. PC에서 **Google Chrome** 실행
2. 주소창에 **`chrome://inspect`** 입력 후 엔터
3. **Devices** 목록에 휴대폰이 보이면, 아래 **Remote Target**에  
   `WebView in ...` 또는 `mealog` 같은 이름의 항목이 보입니다.
4. 해당 항목 오른쪽의 **inspect** 클릭
5. 열리는 개발자 도구에서 **Console** 탭 선택

이제 앱에서 나오는 `console.log`, `console.warn`, `console.error`가 여기에 찍힙니다.

## 3. 푸시 관련 로그 예시

정상이면 대략 다음 순서로 보입니다.

- `푸시: 알림 권한 요청 중...`
- `푸시: 권한 허용됨, FCM 등록 중...`
- `✅ FCM 토큰 저장 완료`

에러가 있으면 다음처럼 보일 수 있습니다.

- `푸시: PushNotifications 플러그인을 불러올 수 없음`
- `푸시 알림 권한이 허용되지 않음: denied`
- `⚠️ FCM 토큰 저장 실패: ...`
- `⚠️ 푸시 알림 초기화 실패: ...`

## 4. inspect에 기기가 안 보일 때

- USB 케이블/포트 바꿔 보기
- 휴대폰에서 "USB 디버깅 허용" 팝업이 떴다면 **허용**
- Chrome에서 `chrome://inspect` 페이지 **새로고침**
- 앱을 **한 번 종료했다가 다시 실행**한 뒤 다시 inspect 확인

## 5. 콘솔에서 푸시 상태 직접 확인

inspect로 연 개발자 도구 Console에서 아래를 입력하면 현재 푸시 디버그 정보를 볼 수 있습니다.

```javascript
window.getPushDebugInfo()
```

반환 객체 예: `{ inited: true, permission: "granted", tokenSaved: true, lastError: null }`

- **tokenSaved: true** 인데도 푸시가 안 오면: Cloud Functions 배포 여부, Firebase Console에서 FCM/앱 설정을 확인하세요.
- **다시 등록** 시도: 콘솔에서 `initPushNotifications(window.currentUser?.uid)` 실행 (로그인 상태여야 함).
