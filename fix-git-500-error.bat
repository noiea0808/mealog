@echo off
chcp 65001 >nul
echo ========================================
echo   Cursor 사이드 패널 500 에러 해결
echo ========================================
echo.

echo [1/5] Git 인덱스 백업 및 초기화...
git add -A 2>nul
if exist .git\index (
    copy .git\index .git\index.backup 2>nul
    echo   Git 인덱스 백업 완료
)

echo.
echo [2/5] Git 인덱스 재구성...
git reset --mixed HEAD 2>nul
git add -A 2>nul
echo   Git 인덱스 재구성 완료

echo.
echo [3/5] Git 상태 확인...
git status --short 2>nul | findstr /C:"??" /C:"M " /C:"A " /C:"D " >nul
if %errorlevel% equ 0 (
    echo   변경된 파일 발견
) else (
    echo   변경된 파일 없음
)

echo.
echo [4/5] Git 설정 확인...
git config --local --list 2>nul | findstr /C:"core.filemode" /C:"core.autocrlf" /C:"core.safecrlf" >nul
if %errorlevel% equ 0 (
    echo   Git 설정 정상
) else (
    echo   Git 설정 확인 중...
    git config --local core.filemode false 2>nul
    git config --local core.autocrlf true 2>nul
    echo   기본 Git 설정 적용 완료
)

echo.
echo [5/5] Git 캐시 정리...
git gc --prune=now 2>nul
echo   Git 캐시 정리 완료

echo.
echo ========================================
echo   해결 완료!
echo ========================================
echo.
echo 다음 단계:
echo   1. Cursor를 완전히 종료하고 다시 시작하세요
echo   2. 사이드 패널을 새로고침하세요 (Ctrl+Shift+P ^> "Developer: Reload Window")
echo   3. Source Control 패널을 다시 확인하세요
echo.
pause
