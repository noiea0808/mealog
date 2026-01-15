@echo off
REM Open admin page in incognito/private mode

REM Try Chrome incognito mode
start chrome --incognito http://localhost:8000/admin.html 2>nul
if %errorlevel% neq 0 (
    REM If Chrome not found, try Edge InPrivate mode
    start msedge --inprivate http://localhost:8000/admin.html 2>nul
    if %errorlevel% neq 0 (
        REM If both not found, open in default browser (normal mode)
        start http://localhost:8000/admin.html
    )
)
