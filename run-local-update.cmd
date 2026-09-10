@echo off
REM Entry point for Windows Task Scheduler -- launched by run-hidden.vbs, so no
REM console window is ever shown. Do not point the task at this file directly:
REM the extraction step takes several minutes and a visible window invites
REM someone to close it, which kills the run mid-way (see run-hidden.vbs).
REM 1) GMP inspection results: extract deficiencies from new MFDS reports, update dashboard.
REM 2) Safety info: recall/disposal (CCBAI01) and administrative actions (CCBAO01).
REM Both run every time and are independent - a failure in one must not skip the other.
REM Change orders (CCBAR01F012) are NOT here: they run hourly in their own task
REM (NedrugChangeOrders -> run-change-orders.cmd) because this one runs every 2 hours.
REM ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage (CP949 here),
REM so non-ASCII comment lines get mis-parsed and executed as commands.
REM That is why the Korean failure text lives in scripts\log-fail.mjs instead.
cd /d "%~dp0"
set RC=0

node scripts\run-local-update.mjs
set E=%ERRORLEVEL%
if not "%E%"=="0" call :fail gmp %E%

node scripts\run-safety-update.mjs
set E=%ERRORLEVEL%
if not "%E%"=="0" call :fail safety %E%

exit /b %RC%

:fail
REM Leave a marker in local-update.log. Without this a crashed or killed stage
REM leaves no trace at all -- the log just stops, with no "=== end ===" line.
set RC=1
node scripts\log-fail.mjs %1 %2
goto :eof
