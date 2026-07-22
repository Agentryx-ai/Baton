' Launches the given command with no visible window.
'
' Task Scheduler can only start a console executable with a visible console
' when the task runs interactively; routing the launch through wscript with
' window style 0 keeps the supervisor completely hidden.
'
' bWaitOnReturn=True: wscript blocks for the supervisor's whole lifetime, so it
' stays the task's tracked action process. That is what makes
' MultipleInstances=IgnoreNew actually suppress the ~1-min self-heal trigger
' (a fire-and-forget launch exits immediately, the task returns to Ready, and
' the heal trigger then spawns an overlapping supervisor every minute -> herd),
' and it lets Stop-ScheduledTask terminate the whole worker tree.
Option Explicit
Dim shell, command, index
Set shell = CreateObject("WScript.Shell")
command = ""
For index = 0 To WScript.Arguments.Count - 1
  If index > 0 Then command = command & " "
  command = command & """" & WScript.Arguments(index) & """"
Next
shell.Run command, 0, True
