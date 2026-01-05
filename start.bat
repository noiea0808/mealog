@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title mealog Web Server

echo.
echo ========================================
echo   mealog Web Server Starting...
echo ========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; cd '%~dp0'; & '%~dp0server.ps1'"

pause
