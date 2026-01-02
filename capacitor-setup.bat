@echo off
chcp 65001 >nul
echo ========================================
echo   mealog Capacitor 설정
echo ========================================
echo.
echo 이 스크립트는 APK 생성을 위한 환경을 설정합니다.
echo.
echo 필요 사항:
echo - Node.js 설치됨
echo - Android Studio 설치됨
echo.
pause

echo.
echo Node.js 확인 중...
node --version
if errorlevel 1 (
    echo Node.js가 설치되어 있지 않습니다!
    echo https://nodejs.org 에서 설치하세요.
    pause
    exit /b 1
)

echo.
echo npm 패키지 설치 중...
call npm install

echo.
echo Capacitor 설치 중...
call npm install -g @capacitor/cli @capacitor/core @capacitor/android

echo.
echo Capacitor 초기화 중...
call npx cap init mealog com.mealog.app --web-dir=.

echo.
echo Android 플랫폼 추가 중...
call npx cap add android

echo.
echo ========================================
echo   설정 완료!
echo ========================================
echo.
echo 다음 단계:
echo 1. Android Studio 실행
echo 2. 다음 명령어 실행: npx cap open android
echo 3. Android Studio에서 빌드 > Build Bundle(s) / APK(s)
echo.
pause

