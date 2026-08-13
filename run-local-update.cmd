@echo off
REM Entry point for Windows Task Scheduler.
REM 1) GMP inspection results: extract deficiencies from new MFDS reports, update dashboard.
REM 2) Safety info: recall/disposal (CCBAI01) and administrative actions (CCBAO01).
REM Both run every time and are independent - a failure in one must not skip the other.
REM ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage (CP949 here),
REM so non-ASCII comment lines get mis-parsed and executed as commands.
cd /d "%~dp0"
set RC=0
node scripts\run-local-update.mjs
if errorlevel 1 set RC=1
node scripts\run-safety-update.mjs
if errorlevel 1 set RC=1
exit /b %RC%
