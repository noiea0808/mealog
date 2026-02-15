# 프로덕션 Release APK 빌드 가이드

디버그가 아닌 **서명된 Release APK**를 빌드하는 방법입니다.

**전체 체크리스트(버전, Keystore, AAB, Play 스토어)**는 [프로덕션 릴리즈 체크리스트](./production-release-checklist.md)를 참고하세요.

## 1. Keystore 생성 (최초 1회)

아직 keystore가 없다면 생성합니다. **비밀번호는 반드시 영문+숫자만** 사용하세요.

```bash
cd android
keytool -genkey -v -keystore mealog-release.keystore -alias mealog -keyalg RSA -keysize 2048 -validity 10000 -storepass YOUR_PASSWORD -keypass YOUR_PASSWORD -dname "CN=MEALOG, OU=App, O=MEALOG, L=Seoul, ST=Seoul, C=KR"
```

`YOUR_PASSWORD`를 실제 비밀번호로 바꾸세요 (예: `Mealog2025`). 질문 없이 바로 생성됩니다.
**이 파일과 비밀번호는 안전하게 보관하세요.** 분실 시 앱 업데이트 불가능합니다.

## 2. keystore.properties 설정

```bash
cd android
cp keystore.properties.example keystore.properties
```

`keystore.properties`를 열어 실제 값으로 수정:

```properties
storeFile=../mealog-release.keystore
storePassword=실제_스토어_비밀번호
keyAlias=mealog
keyPassword=실제_키_비밀번호
```

- `storeFile`: keystore 파일 경로 (android 폴더 기준)
- `storePassword`, `keyPassword`: keytool 생성 시 입력한 비밀번호
- `keyAlias`: keytool 생성 시 입력한 alias (기본값: mealog)

## 3. Release APK 빌드

```bash
npm run cap:build:production:release
```

빌드된 APK 위치:
```
android/app/build/outputs/apk/production/release/app-production-release.apk
```

## 4. Firebase / Play Store

- **Firebase Android 앱**: `com.mealog.app` 패키지 등록, Release keystore의 SHA-1 등록
- **Play Store**: 이 keystore로 서명한 APK만 업로드 가능 (keystore 백업 필수)

## 5. keystore.properties 없을 때

`keystore.properties`가 없으면 `assembleProductionRelease`는 **서명 없이** 빌드됩니다.
(설치 시 "패키지가 잘못되어 설치되지 않았다" 등 오류 가능)

프로덕션 배포 전 반드시 keystore 설정을 완료하세요.
