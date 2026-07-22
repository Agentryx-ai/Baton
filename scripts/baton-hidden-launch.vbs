' Launches the given command with no visible window.
'
' Task Scheduler can only start a console executable with a visible console
' when the task runs interactively; routing the launch through wscript with
' window style 0 keeps the supervisor completely hidden.
'
' bWaitOnReturn MUST stay False: the bootstrap/runner chain detaches from
' wscript, so waiting on it (True) leaves the supervisor tree unlaunched (the
' task shows wscript+bootstrap but no runner/worker). Task Scheduler tracks the
' whole process tree via the job object, so MultipleInstances=IgnoreNew still
' suppresses the self-heal trigger while the detached supervisor tree is alive.
Option Explicit
Dim shell, command, index
Set shell = CreateObject("WScript.Shell")
command = ""
For index = 0 To WScript.Arguments.Count - 1
  If index > 0 Then command = command & " "
  command = command & """" & WScript.Arguments(index) & """"
Next
shell.Run command, 0, False
