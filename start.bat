@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title MEALOG Web Server

echo.
echo ========================================
echo   MEALOG Web Server Starting...
echo ========================================
echo.

REM Run PowerShell server in separate window
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
start "MEALOG Web Server" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '%SCRIPT_DIR%'; & '.\server.ps1'"

REM Wait for server to start (2 seconds)
timeout /t 2 /nobreak >nul

echo.
echo Server is running.
echo.
echo Open pages:
echo   Double-click open-index.bat - Main App (Incognito)
echo   Double-click open-admin.bat - Admin Page
echo.
echo To stop server, close the PowerShell window.
echo.
pause
