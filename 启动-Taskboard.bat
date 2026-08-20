@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -File "%~dp0scripts\start-local.ps1" -EnableFeishu
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
  echo.
  echo Taskboard startup failed. Check .runtime\logs for details.
  pause
)

endlocal & exit /b %exitCode%
