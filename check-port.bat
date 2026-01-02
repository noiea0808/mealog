@echo off
echo ========================================
echo   mealog Port Check
echo ========================================
echo.
echo What port do you want to check?
echo (Default: 8080, enter to use default)
set /p PORTNUM=Port number: 
if "%PORTNUM%"=="" set PORTNUM=8080

echo.
echo Checking URL reservations for port %PORTNUM%...
netsh http show urlacl | findstr ":%PORTNUM%"

echo.
echo Checking if port %PORTNUM% is in use...
netstat -ano | findstr ":%PORTNUM%"

echo.
echo If you see results above, port %PORTNUM% is already reserved or in use.
echo.
echo To remove URL reservation, run remove-reservation.bat as Administrator
echo.
pause

