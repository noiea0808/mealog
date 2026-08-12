@echo off
cd /d "%~dp0"
call "%~dp0tools\ensure-server.bat"

REM Open main app page in Naver Whale (fallback: default browser)
set "URL=http://localhost:8000/index.html"
set "WHALE=%LOCALAPPDATA%\Naver\Naver Whale\Application\whale.exe"
if not exist "%WHALE%" set "WHALE=C:\Program Files\Naver\Naver Whale\Application\whale.exe"
if not exist "%WHALE%" set "WHALE=C:\Program Files (x86)\Naver\Naver Whale\Application\whale.exe"

if exist "%WHALE%" (
    start "" "%WHALE%" "%URL%"
) else (
    echo Naver Whale not found. Opening with default browser...
    start "" "%URL%"
)
