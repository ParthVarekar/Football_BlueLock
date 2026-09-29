@echo off
title BlueLock Football - LAN host
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  LAN play: this PC hosts the game + rooms for everyone on the same Wi-Fi.
rem  All traffic stays inside your router - no internet round-trips, no limits.
rem  Friends open the http://192.168.x.x:5757 address printed below.
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js is not installed. Get it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\.bin\next.exe" (
  where bun >nul 2>nul
  if errorlevel 1 (
    echo Installing dependencies ^(first run only^)...
    call npm install
  ) else (
    echo Installing dependencies ^(first run only^)...
    call bun install
  )
  if errorlevel 1 (
    echo [!] Install failed.
    pause
    exit /b 1
  )
)

rem build the game once (or when you pass "rebuild": lan.bat rebuild)
if /i "%1"=="rebuild" if exist "out" rmdir /s /q out
if not exist "out\index.html" (
  echo Building the game ^(takes about a minute, first time only^)...
  call "node_modules\.bin\next.exe" build
  if errorlevel 1 (
    echo [!] Build failed.
    pause
    exit /b 1
  )
)

rem free port 5757 if an old LAN server is still running
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5757 .*LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>nul
)

echo.
echo If Windows Firewall asks, click "Allow access" for PRIVATE networks
echo - otherwise friends' phones and laptops can't reach this PC.
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:5757"
set PORT=5757
set LAN=1
node server\index.mjs
pause
