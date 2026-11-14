@echo off
chcp 65001 >nul 2>&1
rem Start the iLink Bot (WeChat "ClawBot") sidecar for dsh-superagent-channels.
rem
rem Two things must be true before this works:
rem   1. You have scanned the iLink login QR once and the credential file exists:
rem        node sidecar\weixin-ilink-bridge\server.mjs login --auth-file sidecar\weixin-ilink-bridge\data\weixin-ilink-auth.json
rem      (The credential is valid for ~24h as decided by Tencent; re-scan when it expires / errcode -14.)
rem   2. An HTTP bearer token file exists (independent of the iLink credential). Create it with a random string
rem      and restrict it, then point TOKEN_FILE at it below.
rem
rem Requires Node 18+ on PATH (this bridge is JS, not Python; the wxauto-bridge is the Python one).
rem Everything the sidecar prints goes to ilink-bridge.log next to this file.
setlocal

rem --- set these for your machine -------------------------------------------
set "NODE=node"
set "PORT=9300"
set "TOKEN_FILE=%~dp0..\secrets\ilinkbridge.token"
set "AUTH_FILE=%~dp0weixin-ilink-bridge\data\weixin-ilink-auth.json"
rem -------------------------------------------------------------------------

set "SERVER=%~dp0weixin-ilink-bridge\server.mjs"
set "LOG=%~dp0ilink-bridge.log"

if not exist "%SERVER%" (
  echo [ilink-bridge] server not found: %SERVER% >>"%LOG%"
  exit /b 1
)
if not exist "%TOKEN_FILE%" (
  echo [ilink-bridge] %DATE% %TIME% token file not found: %TOKEN_FILE% >>"%LOG%"
  echo [ilink-bridge] create it with a random string, then restrict it: icacls "%TOKEN_FILE%" /inheritance:r /grant:r "%%USERNAME%%:R"
  exit /b 1
)
if not exist "%AUTH_FILE%" (
  echo [ilink-bridge] %DATE% %TIME% credential file not found: %AUTH_FILE% >>"%LOG%"
  echo [ilink-bridge] run first: "%NODE%" "%SERVER%" login --auth-file "%AUTH_FILE%"
  exit /b 1
)

rem The HTTP token is read from the file: never written on a command line, never logged (only token=set).
set /p ILINK_BRIDGE_TOKEN=<"%TOKEN_FILE%"
echo [ilink-bridge] %DATE% %TIME% starting iLink backend on http://127.0.0.1:%PORT% >>"%LOG%"
"%NODE%" "%SERVER%" run --port %PORT% --host 127.0.0.1 --token-file "%TOKEN_FILE%" --auth-file "%AUTH_FILE%" >>"%LOG%" 2>&1
echo [ilink-bridge] %DATE% %TIME% stopped, exit=%ERRORLEVEL% >>"%LOG%"
