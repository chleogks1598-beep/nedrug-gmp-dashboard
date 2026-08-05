@echo off
REM Entry point for Windows Task Scheduler.
REM Extracts deficiencies from new MFDS inspection reports and updates the dashboard.
REM ASCII only on purpose: cmd.exe reads .cmd in the OEM codepage (CP949 here),
REM so non-ASCII comment lines get mis-parsed and executed as commands.
cd /d "%~dp0"
node scripts\run-local-update.mjs
exit /b %ERRORLEVEL%
