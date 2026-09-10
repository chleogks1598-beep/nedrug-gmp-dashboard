' Task Scheduler entry point. Runs a .cmd in this folder with NO console window.
'
' Usage:  wscript //nologo run-hidden.vbs [batch-file-name]
'   no argument -> run-local-update.cmd   (task NedrugGmpUpdate, every 2h + at logon)
'   argument    -> that .cmd in this folder (task NedrugChangeOrders passes
'                  run-change-orders.cmd, hourly + at logon)
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
Dim sh, fso, name, target, rc
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count > 0 Then
  name = WScript.Arguments(0)
Else
  name = "run-local-update.cmd"
End If
target = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), name)
' A typo in the task's argument must not look like a successful run.
If Not fso.FileExists(target) Then
  WScript.Quit 2
End If
' 0 = hidden window.  True = wait, so the batch exit code reaches Task Scheduler
' and "Last Result" stays meaningful.
rc = sh.Run("""" & target & """", 0, True)
WScript.Quit rc
