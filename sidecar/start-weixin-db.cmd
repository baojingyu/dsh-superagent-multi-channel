@echo off
rem Start the WeChat 4.x local-database (pc-db) sidecar.
rem
rem Two profiles (pass through as an extra argument, e.g.:
rem   start-weixin-db.cmd --profile team
rem or set WXBRIDGE_PROFILE=team below):
rem   readonly (default): reads the encrypted local DBs and never drives the
rem     WeChat UI. POST /send stays 501, and POST /listen only acknowledges
rem     chats - it does not AddListenChat/StartListening.
rem   team: DB-triggered full mode. allow_send turns on, POST /send uses
rem     wechatauto.Chat.SendMsg/SendFiles for text / files / @, and POST
rem     /listen still only records rooms for the Node /messages poller (it
rem     never AddListenChat/StartListening, so it does not steal the UI).
rem
rem Two facts before this works:
rem   1. WeChat 4.x is running and signed in in *this* interactive desktop session,
rem      and the process running this script may read its memory (same or higher
rem      privilege) so the DB keys can be extracted.
rem   2. `wechatauto-replica` (or its db/media modules + cryptography/colorama) is
rem      importable by the Python below. Point WECHATAUTO_PATH at the source tree
rem      if it is not pip-installed. team mode additionally needs the full UIA
rem      stack (wechatauto, not just its db/media submodules).
rem
rem The bearer token is read from WXBRIDGE_TOKEN or a token file; it is never
rem written on a command line and never logged. Everything printed goes to
rem weixin-db.log next to this file.
setlocal

rem --- set these for your machine -------------------------------------------
set "PY=python"
if not "%WECHATAUTO_VENV%"=="" set "PY=%WECHATAUTO_VENV%\Scripts\python.exe"
set "TOKEN_FILE=%~dp0..\secrets\weixin-db.token"
rem Optional: set WXBRIDGE_PROFILE=team (or readonly) to pick the profile without
rem editing the command line; an explicit --profile argument also passes through.
set "PROFILE_ARG="
if not "%WXBRIDGE_PROFILE%"=="" set "PROFILE_ARG=--profile %WXBRIDGE_PROFILE%"
rem Listening port: WXBRIDGE_PORT wins when set ("0" = let the OS pick a free
rem port); otherwise the default 8788. WXBRIDGE_PORT_FILE is inherited from the
rem environment by the child process, so it needs no handling here.
set "PORT=8788"
if not "%WXBRIDGE_PORT%"=="" set "PORT=%WXBRIDGE_PORT%"
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
rem needs no command-line flag here. Any extra args (including --profile team)
rem pass through via %*.
echo [weixin-db] %DATE% %TIME% starting pc-db on http://127.0.0.1:%PORT% profile=%WXBRIDGE_PROFILE% >>"%LOG%"
"%PY%" "%SERVER%" --port %PORT% %PROFILE_ARG% %* >>"%LOG%" 2>&1
echo [weixin-db] %DATE% %TIME% stopped, exit=%ERRORLEVEL% >>"%LOG%"
