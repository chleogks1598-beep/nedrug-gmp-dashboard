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
' ONE RUN AT A TIME (added 2026-09-16): the two tasks share one git working copy,
' and when they overlap their "git pull --rebase" calls fight:
'   error: cannot lock ref 'refs/remotes/origin/main' -> Cannot rebase onto multiple branches
' Both runs then die. That is exactly what happens when the PC comes back on:
' the logon triggers fire a minute apart (a GMP run takes longer than that), and
' every schedule missed while the PC was off is replayed at the same second by
' StartWhenAvailable. On 2026-09-16 that killed four runs in a row and the
' dashboard sat two days behind.
' So each run takes an exclusive file lock first and waits its turn.
' FileSystemObject.OpenTextFile(ForWriting) is an exclusive open - a second
' process gets error 70 - and Windows closes the handle if the process dies,
' so a crashed or killed run can never leave the lock stuck.
'
' ASCII only on purpose: .vbs is read in the OEM codepage (CP949 here), so
' non-ASCII bytes in this file would be mis-decoded. Korean log text therefore
' lives in scripts\log-skip.mjs - the same split used for scripts\log-fail.mjs.
Option Explicit
Dim sh, fso, folder, name, target, rc, lockPath, lock, waited, ok

Const WAIT_STEP_MS  = 15000   ' poll the lock every 15 s
Const WAIT_LIMIT_MS = 1200000 ' give up after 20 min (NedrugChangeOrders is capped at 30 min)

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count > 0 Then
  name = WScript.Arguments(0)
Else
  name = "run-local-update.cmd"
End If
target = fso.BuildPath(folder, name)
' A typo in the task's argument must not look like a successful run.
If Not fso.FileExists(target) Then
  WScript.Quit 2
End If

' --- take the lock, waiting for the other task to finish --------------------
lockPath = fso.BuildPath(folder, ".run-lock")
waited = 0
ok = False
Do
  On Error Resume Next
  Set lock = fso.OpenTextFile(lockPath, 2, True)
  If Err.Number = 0 Then ok = True
  Err.Clear
  On Error GoTo 0
  If ok Then Exit Do
  If waited >= WAIT_LIMIT_MS Then Exit Do
  WScript.Sleep WAIT_STEP_MS
  waited = waited + WAIT_STEP_MS
Loop

If Not ok Then
  ' Not a failure: the other task is still running. Say so in the log instead of
  ' exiting silently - a skip nobody can see is how an outage hides. Exit 0 so a
  ' benign wait does not paint the task red; the next schedule picks it up.
  sh.Run "node """ & fso.BuildPath(folder, "scripts\log-skip.mjs") & """ " & name & " " & (waited \ 60000), 0, True
  WScript.Quit 0
End If
lock.WriteLine name & " " & CStr(Now)

' 0 = hidden window.  True = wait, so the batch exit code reaches Task Scheduler
' and "Last Result" stays meaningful.
rc = sh.Run("""" & target & """", 0, True)
lock.Close
WScript.Quit rc
