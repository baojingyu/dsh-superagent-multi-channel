@echo off
rem Team profile launcher: starts the replica sidecar with the full team mode.
rem Use this as the panel's bridgeLauncher for profile=team; the plain
rem start-weixin-db.cmd stays read-only unless called with --profile team.
setlocal
call "%~dp0start-weixin-db.cmd" --profile team %*
endlocal
