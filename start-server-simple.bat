@echo off
cd /d "%~dp0"
echo Starting web server...
powershell -ExecutionPolicy Bypass -File "%~dp0start-server-simple.ps1"
pause

