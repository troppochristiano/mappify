@echo off
REM Double-click this to start Mappify.
REM
REM A .bat rather than a shortcut so it works from wherever the folder is
REM unzipped, and so the window stays open on an error — the alternative is a
REM console that flashes and vanishes, leaving nothing to read.

cd /d "%~dp0"

REM A bundled runtime sits in .\runtime when this came from a release zip.
REM Otherwise fall back to whatever node is on PATH.
if exist "%~dp0runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   Mappify needs Node.js, which is a free download.
    echo.
    echo   Opening nodejs.org — install the LTS version, then run this again.
    echo.
    start https://nodejs.org
    pause
    exit /b 1
  )
  set "NODE=node"
)

echo.
echo   Starting Mappify. Leave this window open while you use it.
echo   Close it to stop.
echo.

"%NODE%" tools\start.js

REM Only reached if the server exited. Something went wrong, so let them read it.
echo.
echo   Mappify stopped.
pause
