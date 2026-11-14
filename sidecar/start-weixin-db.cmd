@echo off
rem Start the WeChat 4.x local-database (pc-db) sidecar.
rem
rem Read-only: this backend reads the encrypted local DBs and never drives the
rem WeChat UI. POST /send stays 501 unless you add --allow-send, and POST /listen
rem only acknowledges chats - it does not AddListenChat/StartListening.
rem
rem Two facts before this works:
rem   1. WeChat 4.x is running and signed in in *this* interactive desktop session,
rem      and the process running this script may read its memory (same or higher
rem      privilege) so the DB keys can be extracted.
rem   2. `wechatauto-replica` (or its db/media modules + cryptography/colorama) is
rem      importable by the Python below. Point WECHATAUTO_PATH at the source tree
rem      if it is not pip-installed.
rem
rem The bearer token is read from WXBRIDGE_TOKEN or a token file; it is never
rem written on a command line and never logged. Everything printed goes to
rem weixin-db.log next to this file.
setlocal

rem --- set these for your machine -------------------------------------------
set "PY=python"
if not "%WECHATAUTO_VENV%"=="" set "PY=%WECHATAUTO_VENV%\Scripts\python.exe"
set "TOKEN_FILE=%~dp0..\secrets\weixin-db.token"
rem -------------------------------------------------------------------------

set "SERVER=%~dp0weixin-db-bridge\server.py"
set "LOG=%~dp0weixin-db.log"

if not exist "%SERVER%" (
  echo [weixin-db] server not found: %SERVER% >>"%LOG%"
  exit /b 1
)

if "%WXBRIDGE_TOKEN%"=="" (
  if not exist "%TOKEN_FILE%" (
    echo [weixin-db] token not found. Set WXBRIDGE_TOKEN, or write a random token to:
    echo [weixin-db]   "%TOKEN_FILE%"
    echo [weixin-db] then restrict it: icacls "%TOKEN_FILE%" /inheritance:r /grant:r "%%USERNAME%%:R"
    exit /b 1
  )
  set /p WXBRIDGE_TOKEN=<"%TOKEN_FILE%"
)
if "%WXBRIDGE_TOKEN%"=="" (
  echo [weixin-db] token is empty.
  exit /b 1
)

rem WechatautoDbBackend also reads WECHATAUTO_PATH from the environment, so it
rem needs no command-line flag here.
echo [weixin-db] %DATE% %TIME% starting pc-db on http://127.0.0.1:8788 >>"%LOG%"
"%PY%" "%SERVER%" --port 8788 %* >>"%LOG%" 2>&1
echo [weixin-db] %DATE% %TIME% stopped, exit=%ERRORLEVEL% >>"%LOG%"
