@echo off
echo ========================================
echo   mealog Server URL Reservation Setup
echo ========================================
echo.
echo This will allow the server to accept connections
echo from smartphones without administrator privileges.
echo.
echo You need to run this ONCE with administrator rights.
echo.
pause

echo.
echo Adding URL reservation...
echo.
echo What port do you want to use?
echo (Default: 8080, enter to use default)
set /p PORTNUM=Port number: 
if "%PORTNUM%"=="" set PORTNUM=8080

echo.
echo Adding URL reservation for port %PORTNUM%...
netsh http add urlacl url=http://+:%PORTNUM%/ user=%USERNAME%

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ✓ URL reservation added successfully!
    echo You can now run start.bat without administrator rights.
) else (
    echo.
    echo ✗ Failed to add URL reservation.
    echo Please make sure you're running as Administrator.
)

echo.
pause

