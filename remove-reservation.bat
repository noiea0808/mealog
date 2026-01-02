@echo off
echo ========================================
echo   mealog URL Reservation Removal
echo ========================================
echo.
echo This will remove URL reservations.
echo You need to run this with administrator rights.
echo.
echo What port do you want to remove?
echo (Default: 8080, enter to use default)
set /p PORTNUM=Port number: 
if "%PORTNUM%"=="" set PORTNUM=8080

echo.
pause

echo.
echo Removing URL reservation for port %PORTNUM%...
netsh http delete urlacl url=http://+:%PORTNUM%/

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✓ URL reservation removed successfully!
) else (
    echo.
    echo No existing reservation found or access denied.
    echo Make sure you're running as Administrator.
)

echo.
echo Checking current reservations...
netsh http show urlacl | findstr ":%PORTNUM%"

echo.
pause

