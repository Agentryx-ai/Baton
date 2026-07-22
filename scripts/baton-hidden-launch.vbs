' Launches the given command with no visible window.
'
' Task Scheduler can only start a console executable with a visible console
' when the task runs interactively; routing the launch through wscript with
' window style 0 keeps the supervisor completely hidden.
Option Explicit
Dim shell, command, index
Set shell = CreateObject("WScript.Shell")
command = ""
For index = 0 To WScript.Arguments.Count - 1
  If index > 0 Then command = command & " "
  command = command & """" & WScript.Arguments(index) & """"
Next
shell.Run command, 0, False
