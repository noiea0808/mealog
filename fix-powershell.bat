@echo off
chcp 65001 >nul
echo ========================================
echo   PowerShell 프로파일 오류 수정
echo ========================================
echo.
echo 이 스크립트는 PowerShell 프로파일 오류를 해결합니다.
echo 관리자 권한이 필요할 수 있습니다.
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-powershell.ps1"

pause
