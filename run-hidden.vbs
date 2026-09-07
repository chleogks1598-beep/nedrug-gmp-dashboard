' Task Scheduler entry point. Runs run-local-update.cmd with NO console window.
'
' Why this file exists: the task used to launch the .cmd directly, so a console
' window sat on screen for the several minutes the extraction step needs. On
' 2026-09-04 it was mistaken for a hang and closed, which killed the run
' (exit code 0xC000013A, STATUS_CONTROL_C_EXIT) and left two MFDS reports
' unpublished over the weekend. wscript.exe is a GUI host, so nothing is ever
' shown and there is no window to close.
'
' ASCII only on purpose: .vbs is read in the OEM codepage (CP949 here), so
' non-ASCII bytes in this file would be mis-decoded.
Option Explicit
Dim sh, fso, target, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
target = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "run-local-update.cmd")
' 0 = hidden window.  True = wait, so the batch exit code reaches Task Scheduler
' and "Last Result" stays meaningful.
rc = sh.Run("""" & target & """", 0, True)
WScript.Quit rc
