@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title MEALOG 관리자 페이지

echo.
echo ========================================
echo   MEALOG 관리자 페이지 시작
echo ========================================
echo.
echo 웹 서버를 시작하고 관리자 페이지를 엽니다...
echo.

REM PowerShell로 서버 실행 (백그라운드)
start "MEALOG Web Server" powershell -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; cd '%~dp0'; & '%~dp0server.ps1'"

REM 서버 시작 대기 (2초)
timeout /t 2 /nobreak >nul

echo.
echo 관리자 페이지를 엽니다...
start http://localhost:8000/admin.html

echo.
echo 서버가 실행 중입니다.
echo 일반 앱: http://localhost:8000/index.html
echo 관리자: http://localhost:8000/admin.html
echo.
echo 서버를 종료하려면 PowerShell 창을 닫으세요.
echo.
pause
