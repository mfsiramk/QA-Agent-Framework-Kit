@echo off
setlocal
chcp 65001 >nul
title QA Agent Framework - Setup
cd /d "%~dp0"

echo.
echo  QA Agent Framework - Setup
echo  ==========================
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 18 goto :oldnode

where git >nul 2>nul
if errorlevel 1 (
  echo  [note] Git was not found. You need it if you have an automation repository.
  echo         Download: https://git-scm.com/downloads
  echo.
)

echo  Starting the setup wizard...
node installer\server.js %*
if errorlevel 1 (
  echo.
  echo  The setup wizard stopped with an error - see the message above.
  pause
)
goto :eof

:nonode
echo  Node.js is not installed - it is required to run the setup wizard and the agents.
echo.
echo  1. Download the LTS version from https://nodejs.org/en/download  (opening it now)
echo  2. Run the installer with the default options.
echo  3. Close this window and double-click Start-Installer.cmd again.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1

:oldnode
echo  Node.js %NODEMAJOR% is too old - version 18 or newer is required.
echo  Download the LTS version from https://nodejs.org/en/download  (opening it now)
echo  then double-click Start-Installer.cmd again.
echo.
start "" "https://nodejs.org/en/download"
pause
exit /b 1
