# 핸드폰 연결 시 바로 설치하기

APK를 수동으로 옮기지 않고, USB로 연결된 핸드폰에 바로 빌드·설치하는 방법입니다.

## 사전 준비

1. **USB 디버깅 활성화**
   - 설정 → 휴대전화 정보 → 소프트웨어 정보 → 빌드 번호 7번 탭
   - 설정 → 개발자 옵션 → USB 디버깅 켜기

2. **ADB 드라이버** (Windows)
   - [Google USB Driver](https://developer.android.com/studio/run/win-usb) 또는 제조사 드라이버 설치

3. **연결 확인**
   ```bash
   adb devices
   ```
   - 연결된 기기가 목록에 보이면 됨

## 방법 1: 한 번에 빌드 + 설치 (권장)

```bash
npm run cap:install:staging
```

이 명령은 `cap:sync:bundled` → `installStagingDebug`를 실행합니다.  
빌드 후 자동으로 연결된 기기에 설치됩니다.

## 방법 2: APK 빌드 후 adb로 설치

```bash
# 1. APK 빌드
npm run cap:build:staging

# 2. APK 경로로 설치 (staging flavor 기준)
adb install -r android/app/build/outputs/apk/staging/debug/app-staging-debug.apk
```

`-r` 옵션은 기존 앱이 있으면 덮어쓰기(재설치)입니다.

## 방법 3: Gradle 직접 실행

```bash
cd android
./gradlew installStagingDebug   # Windows: gradlew.bat installStagingDebug
```

## 문제 해결

- **기기가 안 보일 때**: USB 케이블 재연결, USB 디버깅 재확인, 다른 USB 포트 시도
- **권한 오류**: 핸드폰에 "USB 디버깅 허용" 팝업이 뜨면 확인
- **설치 실패**: `adb uninstall com.mealog.app.staging` 후 재시도
