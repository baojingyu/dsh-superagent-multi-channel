@echo off
chcp 65001 >nul
setlocal
rem Optional: set WECHATAUTO_VENV to a venv that has wechatauto-replica installed.
if "%WECHATAUTO_VENV%"=="" (
  set "PY=python"
) else (
  set "PY=%WECHATAUTO_VENV%\Scripts\python.exe"
)
"%PY%" "%~dp0gate_guard.py" %*
endlocal
