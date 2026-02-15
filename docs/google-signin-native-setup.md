# 네이티브 구글 로그인 설정 (Android)

앱에서 **네이티브** 구글 로그인을 사용하도록 구성했습니다.  
웹은 기존처럼 Firebase 팝업, Android는 `@capgo/capacitor-social-login`으로 기기 계정 선택 후 Firebase Auth와 연동됩니다.

## 1. Web Client ID 설정

1. [Firebase Console](https://console.firebase.google.com/) → 프로젝트 **mealog-r0** 선택  
2. **Build** → **Authentication** → **Sign-in method** → **Google**  
3. **Web SDK configuration**에서 **Web client ID** 복사 (형식: `xxxxx.apps.googleusercontent.com`)  
4. 프로젝트 루트에 `js/config.js`가 없다면 `js/config.example.js`를 복사해 `js/config.js` 생성  
5. `js/config.js`에 다음 추가 (실제 값으로 교체):

```js
export const GOOGLE_WEB_CLIENT_ID = '여기에_복사한_Web_client_ID';
```

- `config.js`는 Git에 올리지 마세요 (이미 .gitignore에 있을 수 있음).  
- `config.default.js`의 `GOOGLE_WEB_CLIENT_ID`는 빈 문자열로 두고, 실제 값은 `config.js`에만 넣는 것을 권장합니다.

## 2. Android 앱 / SHA-1 (이미 했다면 생략)

1. Firebase Console → **Project settings** → **Your apps**  
2. Android 앱이 없으면 **Add app** → **Android**  
   - 패키지명: `com.mealog.app.staging` (스테이징), `com.mealog.app` (프로덕션)  
3. **SHA-1** 추가  
   - 터미널에서 `android` 폴더로 이동 후:  
     `./gradlew signInReport` (Windows: `gradlew.bat signInReport`)  
   - 출력된 **SHA-1**을 Firebase Android 앱 설정에 **Add fingerprint**로 등록  

이미 같은 패키지로 Android 앱을 등록하고 SHA-1을 넣었다면 이 단계는 건너뛰어도 됩니다.

## 3. 동작 방식

- **웹**: 기존과 동일하게 `signInWithPopup(auth, GoogleAuthProvider)` 사용.  
- **Android (Capacitor)**:  
  1. `SocialLogin.initialize({ google: { webClientId, mode: 'online' } })`  
  2. `SocialLogin.login({ provider: 'google', options: { scopes: ['email', 'profile'] } })`  
  3. 받은 `idToken`으로 `GoogleAuthProvider.credential(idToken)` 생성 후 `signInWithCredential(auth, credential)` 호출  

Firebase Auth는 네이티브에서 **IndexedDB persistence**로 초기화되도록 `js/firebase.js`를 수정해 두었습니다 (Capacitor에서 `getAuth`만 쓰면 인증이 멈출 수 있는 이슈 대응).

## 4. 운영(프로덕션) 배포 시

운영 웹은 배포 시점에 `config.js`를 자동 생성하므로, **로컬 config.js가 배포에 포함되지 않습니다.**

- **GitHub Pages**: 저장소 **Settings** → **Secrets and variables** → **Actions**에서 `GOOGLE_WEB_CLIENT_ID` 시크릿을 추가하세요. 다음 배포부터 적용됩니다.
- **Vercel**: 프로젝트 **Environment Variables**에 `GOOGLE_WEB_CLIENT_ID`를 추가한 뒤 재배포하세요.

자세한 단계는 [프로덕션 릴리즈 체크리스트](./production-release-checklist.md#0-운영-웹앱-공통-구글-로그인-web-client-id)를 참고하세요.

## 5. 문제 해결

- **"구글 로그인 설정이 필요합니다"**  
  → 로컬/스테이징: `js/config.js`에 `GOOGLE_WEB_CLIENT_ID`가 설정돼 있는지 확인.  
  → 운영 웹: 위 "4. 운영(프로덕션) 배포 시"대로 GitHub Secrets 또는 Vercel 환경 변수에 `GOOGLE_WEB_CLIENT_ID`가 설정돼 있는지 확인.  
- **"account reauth is failed"** (프로덕션 앱에서 구글 로그인 시)  
  → **프로덕션(릴리즈) 빌드의 SHA-1**이 Firebase에 없을 때 자주 발생합니다.  
  → Firebase Console → **Project settings** → **Your apps** → Android 앱 **com.mealog.app**  
  → **Add fingerprint**로 **릴리즈 키스토어 SHA-1** 추가.  
  → Play 스토어에 올린 앱이라면: Play Console → **설정** → **앱 무결성** (또는 앱 서명)에서 **앱 서명 키 인증서** SHA-1을 복사해 Firebase에 등록.  
  → 로컬에서 서명한 APK/AAB라면: `cd android && ./gradlew signInReport` (또는 `gradlew.bat signInReport`) 실행 후 **release** 키스토어의 SHA-1을 등록.  
- **로그인 시 멈추거나 실패**  
  → Firebase Console에서 Google Sign-in method 활성화, Web client ID가 맞는지 확인.  
  → Android 앱에 **debug + release** SHA-1이 각각 등록돼 있는지 확인.  
- **idToken / audience 오류**  
  → 사용 중인 Web client ID가 Firebase 프로젝트의 **Web** 클라이언트와 동일한지 확인 (Google Cloud Console > APIs & Services > Credentials에서도 확인 가능).
