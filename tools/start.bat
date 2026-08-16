@echo off
chcp 65001 >nul 2>&1
REM server.ps1 은 Get-Location 을 웹 루트로 쓴다 — tools\ 상위(프로젝트 루트)에서 실행해야 한다
cd /d "%~dp0.."
title MEALOG Web Server

echo.
echo ========================================
echo   MEALOG Web Server Starting...
echo ========================================
echo.

REM Run PowerShell server in separate window
set "PROJECT_ROOT=%CD%"
start "MEALOG Web Server" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '%PROJECT_ROOT%'; & '.\tools\server.ps1'"

REM Wait for server to start (2 seconds)
timeout /t 2 /nobreak >nul

echo.
echo Server is running.
echo.
echo Open pages (server starts automatically):
echo   Double-click ..\open-index.bat - Main App
echo   Double-click ..\open-admin.bat - Admin Page
echo.
echo To stop server, close the PowerShell window.
echo.
pause
