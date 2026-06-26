@echo off
setlocal
cd /d "%~dp0"

netstat -ano | findstr ":8000" | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 goto :ready

echo Starting MEALOG Web Server...
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
start "MEALOG Web Server" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Set-Location -LiteralPath '%SCRIPT_DIR%'; & '.\server.ps1'"

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
