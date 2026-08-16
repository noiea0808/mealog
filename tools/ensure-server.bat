@echo off
setlocal
REM server.ps1 은 Get-Location 을 웹 루트로 쓴다 — 이 파일은 tools\ 안에 있으므로 상위(프로젝트 루트)로 이동해야 한다
cd /d "%~dp0.."

netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 goto :ready

echo Starting MEALOG Web Server...
set "PROJECT_ROOT=%CD%"
start "MEALOG Web Server" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '%PROJECT_ROOT%'; & '.\tools\server.ps1'"

set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 goto :ready
set /a tries+=1
if %tries% lss 15 goto :wait_loop

echo Warning: Server may not be ready yet.

:ready
endlocal
