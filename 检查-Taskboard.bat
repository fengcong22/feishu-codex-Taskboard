@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -File "%~dp0scripts\check-local.ps1" -RequireFeishu
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo.
  echo Local stack check failed.
)

echo.
pause

endlocal & exit /b %exitCode%
