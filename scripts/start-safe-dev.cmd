@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Safe dev start for Ischia Transfer (Windows CMD)
REM Usage:
REM   scripts\start-safe-dev.cmd
REM   scripts\start-safe-dev.cmd 3011

set "PORT=%~1"
if "%PORT%"=="" set "PORT=3011"

echo.
echo [Ischia Transfer] Safe dev start on port %PORT%
echo.

call :KillPort 3010
call :KillPort 3011
if not "%PORT%"=="3010" call :KillPort %PORT%

echo Starting Next.js dev server on port %PORT% and host 0.0.0.0...
pnpm exec next dev --hostname 0.0.0.0 --port %PORT%
exit /b %ERRORLEVEL%

:KillPort
set "TARGET_PORT=%~1"
if "%TARGET_PORT%"=="" exit /b 0

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
  if not "%%P"=="0" (
    echo - Killing PID %%P on port %TARGET_PORT%...
    taskkill /PID %%P /F >nul 2>&1
  )
)
exit /b 0
