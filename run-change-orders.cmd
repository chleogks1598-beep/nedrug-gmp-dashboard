@echo off
REM Entry point for scheduled task NedrugChangeOrders -- launched by
REM run-hidden.vbs (see that file), so no console window is ever shown.
REM
REM Change orders (CCBAR01F012) only, hourly + at logon. It lives in its own task
REM instead of run-local-update.cmd because that one runs every 2 hours (its GMP
REM extraction step takes minutes) while this watch is wanted every hour.
REM MFDS publishes change orders during the day and the list must not sit stale.
REM
REM Moved off GitHub Actions on 2026-09-10: MFDS intermittently blocks cloud IPs
REM (UND_ERR_CONNECT_TIMEOUT killed 1 run in 3). The office network is not blocked.
REM Mail is still sent by GitHub (change-orders-notify.yml) on the pushed snapshot.
REM
REM ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage (CP949 here),
REM so non-ASCII comment lines get mis-parsed and executed as commands.
REM That is why the Korean failure text lives in scripts\log-fail.mjs instead.
cd /d "%~dp0"

node scripts\run-change-orders-update.mjs
set E=%ERRORLEVEL%
if "%E%"=="0" exit /b 0

REM Leave a marker in local-update.log. Without this a crashed or killed run
REM leaves no trace at all -- the log just stops, with no result line.
node scripts\log-fail.mjs change-orders %E%
exit /b 1
