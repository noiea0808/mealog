@echo off
echo ========================================
echo Firestore 인덱스 및 Rules 배포
echo ========================================
echo.

REM 현재 디렉토리 확인
cd /d "%~dp0"

REM Firebase CLI 확인
where firebase >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [오류] Firebase CLI가 설치되어 있지 않습니다.
    echo 다음 명령어로 설치해주세요:
    echo npm install -g firebase-tools
    echo.
    pause
    exit /b 1
)

echo [1/2] Firestore 인덱스 배포...
firebase deploy --only firestore:indexes
if %ERRORLEVEL% NEQ 0 (
    echo [오류] Firestore 인덱스 배포에 실패했습니다.
    pause
    exit /b 1
)

echo.
echo [2/2] Firestore Rules 배포...
firebase deploy --only firestore:rules
if %ERRORLEVEL% NEQ 0 (
    echo [오류] Firestore Rules 배포에 실패했습니다.
    pause
    exit /b 1
)

echo.
echo ========================================
echo 배포가 완료되었습니다!
echo ========================================
pause
