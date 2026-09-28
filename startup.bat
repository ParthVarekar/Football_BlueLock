@echo off
title Gulmohar Ground - dev server
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo [!] bun is not installed or not on PATH. Install it from https://bun.sh
  pause
  exit /b 1
)

rem install when node_modules is missing or incomplete (e.g. an interrupted first install)
if not exist "node_modules\.bin\next.exe" (
  echo Installing dependencies ^(first run only, takes a few minutes^)...
  call bun install
  if errorlevel 1 (
    echo [!] bun install failed.
    pause
    exit /b 1
  )
)

rem free port 3000 if an old dev server is still holding it
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  echo Stopping old server on port 3000 ^(PID %%p^)...
  taskkill /PID %%p /T /F >nul 2>nul
)

rem free port 3001 too, then start the multiplayer relay in its own window
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3001 .*LISTENING"') do (
  taskkill /PID %%p /T /F >nul 2>nul
)
start "Gulmohar Ground - multiplayer relay" cmd /c "node server\index.mjs"

rem open the game in the browser once the server has had a moment to boot
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:3000"

echo Starting dev server on http://localhost:3000  (Ctrl+C to stop)
rem use the project's own Next.js (the package.json "dev" script pipes through
rem `tee`, which cmd doesn't have)
call "node_modules\.bin\next.exe" dev -p 3000

pause
