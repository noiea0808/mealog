# 프로덕션 릴리즈 체크리스트 (Play 스토어 / APK 배포)

앱 스토어 제출 전 확인 및 빌드 절차입니다.

---

## 0. 운영 웹/앱 공통: 구글 로그인 (Web Client ID)

운영 환경에서 **구글 로그인**이 동작하려면 `GOOGLE_WEB_CLIENT_ID`가 설정돼 있어야 합니다.

### GitHub Pages 배포 시

1. **GitHub 저장소** → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret** → 이름: `GOOGLE_WEB_CLIENT_ID`, 값: Firebase Console에서 복사한 Web client ID (형식: `xxxxx.apps.googleusercontent.com`)
3. 다음 배포부터 생성되는 `config.js`에 자동으로 포함됩니다.

### Vercel 배포 시

1. Vercel 프로젝트 → **Settings** → **Environment Variables**
2. `GOOGLE_WEB_CLIENT_ID` 추가 (Value: Web client ID)
3. 재배포 후 적용됩니다.

### Web Client ID 확인 방법

- [Firebase Console](https://console.firebase.google.com/) → 프로젝트 선택 → **Build** → **Authentication** → **Sign-in method** → **Google** → **Web SDK configuration**에서 **Web client ID** 복사

자세한 설정은 [네이티브 구글 로그인 설정](./google-signin-native-setup.md)을 참고하세요.

---

## 1. 버전 올리기 (매 릴리즈)

Play 스토어는 **versionCode**가 이전보다 커야 업로드됩니다.

`android/app/build.gradle`에서 수정:

```groovy
defaultConfig {
    versionCode 2        // 이전보다 큰 정수 (1, 2, 3, …)
    versionName "1.0.1"   // 사용자에게 보이는 버전 (예: 1.0.1)
}
```

- **versionCode**: 정수만 가능. 배포할 때마다 1씩 증가 권장.
- **versionName**: 원하는 표시 버전 (예: 1.0, 1.0.1, 2.0).

---

## 2. Keystore (최초 1회)

### Q. 서명 키(Keystore 파일, .jks 또는 .keystore)는 어디에 있나요?

- **파일 위치**: 개발자가 `keytool`로 생성한 뒤, 다음 중 한 곳에 둡니다.
  - **프로젝트 루트**: `mealog/mealog-release.keystore` → `keystore.properties`에는 `storeFile=../mealog-release.keystore`
  - **android 폴더**: `mealog/android/mealog-release.keystore` → `keystore.properties`에는 `storeFile=mealog-release.keystore`
- **Git**: Keystore 파일과 `android/keystore.properties`는 **커밋하지 않습니다** (`.gitignore`에 포함됨). 백업은 로컬/비공개 저장소로 별도 보관하세요.

### Q. 수동으로 서명해야 하나요, 아니면 자동으로 서명되게 설정되어 있나요?

- **자동 서명**으로 이미 설정되어 있습니다.
- `android/app/build.gradle`에 `signingConfigs.release`와 `buildTypes.release`가 연결되어 있어, **`android/keystore.properties`만 있으면** `npm run cap:build:production:release` 또는 `npm run cap:build:production:aab` 실행 시 **빌드 과정에서 자동으로 서명**됩니다.
- **Keystore가 아직 없을 때**: 빌드 전에 한 번만 환경 변수 `KEYSTORE_PASSWORD=영문숫자6자이상`을 설정한 뒤 같은 명령을 실행하면, `scripts/ensure-keystore.js`가 keystore와 `keystore.properties`를 자동 생성합니다. 이후에는 해당 환경 변수 없이 빌드해도 서명됩니다.
- 별도로 수동 서명(jarsigner 등)을 할 필요는 없습니다.

---

서명용 keystore가 없으면 아래 순서로 진행합니다.

### 2.1 Keystore 생성

비밀번호는 **영문+숫자만** 사용하세요.

```bash
cd android
keytool -genkey -v -keystore mealog-release.keystore -alias mealog -keyalg RSA -keysize 2048 -validity 10000 -storepass YOUR_PASSWORD -keypass YOUR_PASSWORD -dname "CN=MEALOG, OU=App, O=MEALOG, L=Seoul, ST=Seoul, C=KR"
```

`YOUR_PASSWORD`를 실제 비밀번호로 바꿉니다. **파일과 비밀번호는 안전하게 보관**하세요. 분실 시 동일 앱 업데이트가 불가능합니다.

### 2.2 keystore.properties

```bash
cd android
cp keystore.properties.example keystore.properties
```

`keystore.properties`를 열어 실제 값으로 수정:

```properties
storeFile=mealog-release.keystore
storePassword=실제_스토어_비밀번호
keyAlias=mealog
keyPassword=실제_키_비밀번호
```

- keystore 파일을 `android/` 폴더에 둔 경우: `storeFile=mealog-release.keystore`
- 프로젝트 루트에 둔 경우: `storeFile=../mealog-release.keystore`

---

## 3. 앱 아이콘

프로덕션 빌드 시에도 `assets/icon-only.png`(1024×1024)가 있으면 자동으로 아이콘이 생성·적용됩니다.  
없다면 [앱 아이콘 적용 가이드](./app-icon-setup.md)를 참고해 추가하세요.

---

## 4. 프로덕션 빌드

### APK (직접 배포 / 테스트용)

```bash
npm run cap:build:production:release
```

**결과물**: `android/app/build/outputs/apk/production/release/app-production-release.apk`

### AAB (Play 스토어 업로드 권장)

Google Play는 **Android App Bundle(.aab)** 업로드를 권장합니다.

```bash
npm run cap:build:production:aab
```

**결과물**: `android/app/build/outputs/bundle/productionRelease/app-production-release.aab`

이 파일을 Play Console에 업로드하면 됩니다.

---

## 5. 제출 전 체크

| 항목 | 확인 |
|------|------|
| `android/app/build.gradle` | versionCode / versionName 올림 |
| `android/keystore.properties` | 실제 비밀번호·경로 설정 (Git 제외됨) |
| `assets/icon-only.png` | 스토어용 아이콘 준비 (선택) |
| Firebase | Android 앱 `com.mealog.app` 등록, Release keystore SHA-1 추가 |
| Play Console | 앱 생성, 스토어 등록 정보·스크린샷 등 입력 후 AAB 업로드 |

---

## 6. 요약 명령어

| 목적 | 명령 |
|------|------|
| 프로덕션 Release APK | `npm run cap:build:production:release` |
| 프로덕션 AAB (Play 스토어) | `npm run cap:build:production:aab` |

Keystore가 없으면 release 빌드는 서명 없이 생성되며, Play 스토어에는 업로드할 수 없습니다. 반드시 keystore 설정 후 빌드하세요.
