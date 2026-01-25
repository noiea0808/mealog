@echo off
echo ========================================
echo Firebase Functions 및 Rules 배포 스크립트
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

REM Node.js 확인
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [오류] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 Node.js를 설치해주세요.
    echo.
    pause
    exit /b 1
)

echo [1/4] Firebase 로그인 확인...
firebase projects:list >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Firebase에 로그인하지 않았습니다. 로그인을 진행합니다...
    firebase login
    if %ERRORLEVEL% NEQ 0 (
        echo [오류] Firebase 로그인에 실패했습니다.
        pause
        exit /b 1
    )
)

echo [2/4] Functions 의존성 설치...
cd functions
if not exist "node_modules" (
    echo npm install 실행 중...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [오류] npm install에 실패했습니다.
        cd ..
        pause
        exit /b 1
    )
) else (
    echo node_modules가 이미 존재합니다. 건너뜁니다.
)
cd ..

echo [3/4] Cloud Functions 배포...
firebase deploy --only functions
if %ERRORLEVEL% NEQ 0 (
    echo [오류] Functions 배포에 실패했습니다.
    pause
    exit /b 1
)

echo [4/4] Firestore Rules 배포...
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
